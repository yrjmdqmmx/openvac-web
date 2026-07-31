import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { quotaBucket, quotaLedger } from "@/server/db/schema";

import {
  QuotaExceededError,
  QuotaReservationNotFoundError,
  type QuotaReservation,
  type QuotaReservationStatus,
  type QuotaScopePolicy,
  type QuotaScopeUsage,
  type QuotaWindow
} from "./types";

interface RepositoryReserveInput {
  actorUserId: string;
  clientRequestId: string;
  resource: "answer" | "web_search";
  units: number;
  window: QuotaWindow;
  scopes: QuotaScopePolicy[];
  metadata: Record<string, unknown>;
}

interface RepositoryTransitionInput {
  leaseId: string;
  actorUserId?: string;
  reason?: string;
}

interface RepositoryStatusInput {
  resource: "answer" | "web_search";
  window: QuotaWindow;
  scopes: QuotaScopePolicy[];
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LedgerRow = typeof quotaLedger.$inferSelect;
type BucketRow = typeof quotaBucket.$inferSelect;

export interface QuotaRepository {
  reserve(input: RepositoryReserveInput): Promise<QuotaReservation>;
  commit(input: RepositoryTransitionInput): Promise<QuotaReservation>;
  release(input: RepositoryTransitionInput): Promise<QuotaReservation>;
  status(input: RepositoryStatusInput): Promise<QuotaScopeUsage[]>;
}

function aggregateStatus(rows: LedgerRow[]): QuotaReservationStatus {
  if (rows.every((row) => row.status === "committed")) {
    return "committed";
  }
  if (rows.every((row) => row.status === "released")) {
    return "released";
  }
  return "reserved";
}

function scopeUsage(bucket: BucketRow): QuotaScopeUsage {
  return {
    scopeType: bucket.scopeType,
    scopeKey: bucket.scopeKey,
    limit: bucket.limitValue,
    reserved: bucket.reservedUnits,
    committed: bucket.committedUnits,
    remaining: Math.max(
      0,
      bucket.limitValue - bucket.reservedUnits - bucket.committedUnits
    ),
    resetAt: bucket.resetAt
  };
}

export function reconcileQuotaBucketLimit(input: {
  policyLimit: number;
  reservedUnits: number;
  committedUnits: number;
}) {
  return Math.max(
    input.policyLimit,
    input.reservedUnits + input.committedUnits
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function selectIdempotentRows(
  database: typeof db | Transaction,
  input: Pick<
    RepositoryReserveInput,
    "actorUserId" | "clientRequestId" | "resource"
  >
) {
  return database
    .select()
    .from(quotaLedger)
    .where(
      and(
        eq(quotaLedger.actorUserId, input.actorUserId),
        eq(quotaLedger.resource, input.resource),
        eq(quotaLedger.clientRequestId, input.clientRequestId)
      )
    )
    .orderBy(asc(quotaLedger.scopeType), asc(quotaLedger.scopeKey));
}

async function selectBuckets(
  database: typeof db | Transaction,
  bucketIds: string[]
) {
  const rows: BucketRow[] = [];

  for (const bucketId of bucketIds) {
    const [bucket] = await database
      .select()
      .from(quotaBucket)
      .where(eq(quotaBucket.id, bucketId));

    if (bucket) {
      rows.push(bucket);
    }
  }

  return rows;
}

async function reservationFromRows(
  database: typeof db | Transaction,
  rows: LedgerRow[],
  idempotent: boolean
): Promise<QuotaReservation> {
  const first = rows[0];

  if (!first) {
    throw new Error("Cannot build a quota reservation without ledger rows");
  }

  const buckets = await selectBuckets(
    database,
    rows.map((row) => row.bucketId)
  );

  return {
    leaseId: first.leaseId,
    actorUserId: first.actorUserId,
    clientRequestId: first.clientRequestId,
    resource: first.resource,
    units: first.units,
    status: aggregateStatus(rows),
    window: {
      key: first.windowKey,
      resetAt:
        buckets.reduce<Date | undefined>(
          (latest, bucket) =>
            !latest || bucket.resetAt > latest ? bucket.resetAt : latest,
          undefined
        ) ?? first.reservedAt
    },
    scopes: buckets.map(scopeUsage),
    idempotent
  };
}

export class PostgresQuotaRepository implements QuotaRepository {
  async reserve(input: RepositoryReserveInput): Promise<QuotaReservation> {
    const existing = await selectIdempotentRows(db, input);

    if (existing.length > 0) {
      return reservationFromRows(db, existing, true);
    }

    try {
      return await db.transaction(async (transaction) => {
        const rows = await selectIdempotentRows(transaction, input);

        if (rows.length > 0) {
          return reservationFromRows(transaction, rows, true);
        }

        const leaseId = randomUUID();
        const ledgerRows: LedgerRow[] = [];
        const sortedScopes = [...input.scopes].sort((left, right) =>
          `${left.scopeType}:${left.scopeKey}`.localeCompare(
            `${right.scopeType}:${right.scopeKey}`
          )
        );

        for (const scope of sortedScopes) {
          await transaction
            .insert(quotaBucket)
            .values({
              resource: input.resource,
              scopeType: scope.scopeType,
              scopeKey: scope.scopeKey,
              windowKey: input.window.key,
              limitValue: scope.limit,
              resetAt: input.window.resetAt
            })
            .onConflictDoNothing({
              target: [
                quotaBucket.resource,
                quotaBucket.scopeType,
                quotaBucket.scopeKey,
                quotaBucket.windowKey
              ]
            });

          const [existingBucket] = await transaction
            .select()
            .from(quotaBucket)
            .where(
              and(
                eq(quotaBucket.resource, input.resource),
                eq(quotaBucket.scopeType, scope.scopeType),
                eq(quotaBucket.scopeKey, scope.scopeKey),
                eq(quotaBucket.windowKey, input.window.key)
              )
            )
            .for("update");

          if (!existingBucket) {
            throw new Error("Unable to initialize quota bucket");
          }

          const reconciledLimit = reconcileQuotaBucketLimit({
            policyLimit: scope.limit,
            reservedUnits: existingBucket.reservedUnits,
            committedUnits: existingBucket.committedUnits
          });
          const bucket =
            reconciledLimit !== existingBucket.limitValue
              ? (
                  await transaction
                    .update(quotaBucket)
                    .set({
                      limitValue: reconciledLimit,
                      updatedAt: new Date()
                    })
                    .where(eq(quotaBucket.id, existingBucket.id))
                    .returning()
                )[0]
              : existingBucket;

          if (!bucket) {
            throw new Error("Unable to reconcile quota bucket allowance");
          }

          const [updatedBucket] = await transaction
            .update(quotaBucket)
            .set({
              reservedUnits: sql`${quotaBucket.reservedUnits} + ${input.units}`,
              updatedAt: new Date()
            })
            .where(
              and(
                eq(quotaBucket.id, bucket.id),
                sql`${quotaBucket.reservedUnits} + ${quotaBucket.committedUnits} + ${input.units} <= ${quotaBucket.limitValue}`
              )
            )
            .returning();

          if (!updatedBucket) {
            throw new QuotaExceededError({
              resource: input.resource,
              scopeType: scope.scopeType,
              limit: bucket.limitValue,
              resetAt: bucket.resetAt
            });
          }

          const [ledgerRow] = await transaction
            .insert(quotaLedger)
            .values({
              leaseId,
              bucketId: bucket.id,
              actorUserId: input.actorUserId,
              clientRequestId: input.clientRequestId,
              resource: input.resource,
              scopeType: scope.scopeType,
              scopeKey: scope.scopeKey,
              windowKey: input.window.key,
              units: input.units,
              metadata: input.metadata
            })
            .returning();

          if (!ledgerRow) {
            throw new Error("Unable to create quota ledger entry");
          }
          ledgerRows.push(ledgerRow);
        }

        return reservationFromRows(transaction, ledgerRows, false);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await selectIdempotentRows(db, input);
        if (winner.length > 0) {
          return reservationFromRows(db, winner, true);
        }
      }
      throw error;
    }
  }

  async commit(input: RepositoryTransitionInput): Promise<QuotaReservation> {
    return this.transition(input, "committed");
  }

  async release(input: RepositoryTransitionInput): Promise<QuotaReservation> {
    return this.transition(input, "released");
  }

  async status(input: RepositoryStatusInput): Promise<QuotaScopeUsage[]> {
    const usages: QuotaScopeUsage[] = [];

    for (const scope of input.scopes) {
      const [bucket] = await db
        .select()
        .from(quotaBucket)
        .where(
          and(
            eq(quotaBucket.resource, input.resource),
            eq(quotaBucket.scopeType, scope.scopeType),
            eq(quotaBucket.scopeKey, scope.scopeKey),
            eq(quotaBucket.windowKey, input.window.key)
          )
        );

      usages.push(
        bucket
          ? scopeUsage(bucket)
          : {
              scopeType: scope.scopeType,
              scopeKey: scope.scopeKey,
              limit: scope.limit,
              reserved: 0,
              committed: 0,
              remaining: scope.limit,
              resetAt: input.window.resetAt
            }
      );
    }

    return usages;
  }

  private async transition(
    input: RepositoryTransitionInput,
    target: Exclude<QuotaReservationStatus, "reserved">
  ): Promise<QuotaReservation> {
    return db.transaction(async (transaction) => {
      const predicates = [eq(quotaLedger.leaseId, input.leaseId)];

      if (input.actorUserId) {
        predicates.push(eq(quotaLedger.actorUserId, input.actorUserId));
      }

      const rows = await transaction
        .select()
        .from(quotaLedger)
        .where(and(...predicates))
        .orderBy(asc(quotaLedger.scopeType), asc(quotaLedger.scopeKey))
        .for("update");

      if (rows.length === 0) {
        throw new QuotaReservationNotFoundError(input.leaseId);
      }

      for (const row of rows) {
        if (row.status !== "reserved") {
          continue;
        }

        await transaction
          .update(quotaBucket)
          .set({
            reservedUnits: sql`${quotaBucket.reservedUnits} - ${row.units}`,
            ...(target === "committed"
              ? {
                  committedUnits: sql`${quotaBucket.committedUnits} + ${row.units}`
                }
              : {}),
            updatedAt: new Date()
          })
          .where(eq(quotaBucket.id, row.bucketId));

        await transaction
          .update(quotaLedger)
          .set({
            status: target,
            releaseReason:
              target === "released"
                ? (input.reason ?? "operation_failed")
                : null,
            committedAt: target === "committed" ? new Date() : null,
            releasedAt: target === "released" ? new Date() : null,
            updatedAt: new Date()
          })
          .where(eq(quotaLedger.id, row.id));
      }

      const finalRows = await transaction
        .select()
        .from(quotaLedger)
        .where(and(...predicates))
        .orderBy(asc(quotaLedger.scopeType), asc(quotaLedger.scopeKey));

      return reservationFromRows(transaction, finalRows, true);
    });
  }
}
