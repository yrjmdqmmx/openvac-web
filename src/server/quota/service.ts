import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { user } from "@/server/db/schema";

import { PostgresQuotaRepository, type QuotaRepository } from "./repository";
import {
  QuotaRequestAlreadyUsedError,
  QuotaRequestInProgressError,
  type QuotaReservation,
  type QuotaScopePolicy,
  type QuotaStatus,
  type QuotaStatusInput,
  type ReserveQuotaInput,
  type TransitionQuotaInput
} from "./types";
import { shanghaiDailyWindow } from "./window";

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: number | undefined) {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 0;
}

export interface QuotaLimits {
  answerDaily: number;
  webSearchUserDaily: number;
  webSearchGlobalDaily: number;
}

export function quotaLimitsFromEnvironment(): QuotaLimits {
  return {
    answerDaily: positiveInteger(process.env.ANSWER_DAILY_LIMIT, 20),
    webSearchUserDaily: positiveInteger(
      process.env.ALIBABA_WEB_SEARCH_PER_USER_DAILY_LIMIT,
      5
    ),
    webSearchGlobalDaily: positiveInteger(
      process.env.ALIBABA_WEB_SEARCH_GLOBAL_DAILY_LIMIT,
      500
    )
  };
}

async function persistedAnswerBonus(userId: string) {
  const [record] = await db
    .select({ dailyQuotaBonus: user.dailyQuotaBonus })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return nonNegativeInteger(record?.dailyQuotaBonus);
}

export class QuotaService {
  constructor(
    private readonly repository: QuotaRepository = new PostgresQuotaRepository(),
    private readonly limits: QuotaLimits = quotaLimitsFromEnvironment(),
    private readonly readAnswerBonus: (
      userId: string
    ) => Promise<number> = persistedAnswerBonus
  ) {}

  async reserve(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const units = input.units ?? 1;

    if (!input.userId.trim()) {
      throw new TypeError("Quota userId is required");
    }
    if (!input.clientRequestId.trim()) {
      throw new TypeError("Quota clientRequestId is required");
    }
    if (!Number.isSafeInteger(units) || units <= 0) {
      throw new TypeError("Quota units must be a positive integer");
    }

    const window = shanghaiDailyWindow(input.at);
    const answerBonus =
      input.resource === "answer"
        ? await this.readAnswerBonus(input.userId)
        : 0;
    const scopes = this.scopes(input.userId, input.resource, answerBonus);

    return this.repository.reserve({
      actorUserId: input.userId,
      clientRequestId: input.clientRequestId,
      resource: input.resource,
      units,
      window,
      scopes,
      metadata: input.metadata ?? {}
    });
  }

  commit(input: TransitionQuotaInput): Promise<QuotaReservation> {
    return this.repository.commit({
      leaseId: input.leaseId,
      actorUserId: input.userId
    });
  }

  release(input: TransitionQuotaInput): Promise<QuotaReservation> {
    return this.repository.release({
      leaseId: input.leaseId,
      actorUserId: input.userId,
      reason: input.reason
    });
  }

  async withReservation<T>(
    input: ReserveQuotaInput,
    operation: (reservation: QuotaReservation) => Promise<T>
  ): Promise<T> {
    const reservation = await this.reserve(input);

    if (reservation.idempotent) {
      if (reservation.status === "reserved") {
        throw new QuotaRequestInProgressError(input.clientRequestId);
      }
      throw new QuotaRequestAlreadyUsedError(
        input.clientRequestId,
        reservation.status
      );
    }

    if (reservation.status !== "reserved") {
      throw new QuotaRequestAlreadyUsedError(
        input.clientRequestId,
        reservation.status
      );
    }

    try {
      const result = await operation(reservation);
      await this.commit({
        leaseId: reservation.leaseId,
        userId: input.userId
      });
      return result;
    } catch (operationError) {
      try {
        await this.release({
          leaseId: reservation.leaseId,
          userId: input.userId,
          reason: "operation_failed"
        });
      } catch (releaseError) {
        throw new AggregateError(
          [operationError, releaseError],
          "The operation failed and its quota reservation could not be released"
        );
      }
      throw operationError;
    }
  }

  async status(input: QuotaStatusInput): Promise<QuotaStatus> {
    if (!input.userId.trim()) {
      throw new TypeError("Quota userId is required");
    }

    const window = shanghaiDailyWindow(input.at);
    const answerBonus =
      input.resource === "answer"
        ? await this.readAnswerBonus(input.userId)
        : 0;
    const scopes = this.scopes(input.userId, input.resource, answerBonus);
    const usages = await this.repository.status({
      resource: input.resource,
      window,
      scopes
    });

    return {
      resource: input.resource,
      window,
      scopes: usages,
      remaining: Math.min(...usages.map((usage) => usage.remaining))
    };
  }

  private scopes(
    userId: string,
    resource: "answer" | "web_search",
    answerBonus: number
  ): QuotaScopePolicy[] {
    if (resource === "answer") {
      return [
        {
          scopeType: "user",
          scopeKey: userId,
          limit: this.limits.answerDaily + answerBonus
        }
      ];
    }

    return [
      {
        scopeType: "global",
        scopeKey: "all",
        limit: this.limits.webSearchGlobalDaily
      },
      {
        scopeType: "user",
        scopeKey: userId,
        limit: this.limits.webSearchUserDaily
      }
    ];
  }
}
