import { describe, expect, it } from "vitest";

import type { QuotaRepository } from "./repository";
import { QuotaService } from "./service";
import type {
  QuotaReservation,
  QuotaScopePolicy,
  QuotaScopeUsage
} from "./types";

class RecordingRepository implements QuotaRepository {
  scopes: QuotaScopePolicy[] = [];
  transitions: Array<"commit" | "release"> = [];
  reservation?: QuotaReservation;

  async reserve(
    input: Parameters<QuotaRepository["reserve"]>[0]
  ): Promise<QuotaReservation> {
    this.scopes = input.scopes;
    this.reservation = {
      leaseId: "00000000-0000-4000-8000-000000000001",
      actorUserId: input.actorUserId,
      clientRequestId: input.clientRequestId,
      resource: input.resource,
      units: input.units,
      status: "reserved",
      window: input.window,
      scopes: input.scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        limit: scope.limit,
        reserved: input.units,
        committed: 0,
        remaining: scope.limit - input.units,
        resetAt: input.window.resetAt
      })),
      idempotent: false
    };
    return this.reservation;
  }

  commit(): Promise<QuotaReservation> {
    this.transitions.push("commit");
    return Promise.resolve({
      ...this.reservation!,
      status: "committed"
    });
  }

  release(): Promise<QuotaReservation> {
    this.transitions.push("release");
    return Promise.resolve({
      ...this.reservation!,
      status: "released"
    });
  }

  status(
    input: Parameters<QuotaRepository["status"]>[0]
  ): Promise<QuotaScopeUsage[]> {
    return Promise.resolve(
      input.scopes.map((scope) => ({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        limit: scope.limit,
        reserved: 0,
        committed: 0,
        remaining: scope.limit,
        resetAt: input.window.resetAt
      }))
    );
  }
}

describe("QuotaService", () => {
  it("applies the persisted bonus to the daily answer limit", async () => {
    const repository = new RecordingRepository();
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 3
    );

    await service.reserve({
      userId: "user-1",
      clientRequestId: "answer-1",
      resource: "answer",
      at: new Date("2026-07-31T08:00:00.000Z")
    });

    expect(repository.scopes).toEqual([
      { scopeType: "user", scopeKey: "user-1", limit: 23 }
    ]);
  });

  it("reserves user and global web-search scopes together", async () => {
    const repository = new RecordingRepository();
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 0
    );

    await service.reserve({
      userId: "user-1",
      clientRequestId: "search-1",
      resource: "web_search"
    });

    expect(repository.scopes).toEqual([
      { scopeType: "global", scopeKey: "all", limit: 500 },
      { scopeType: "user", scopeKey: "user-1", limit: 5 }
    ]);
  });

  it("reserves database-backed user and global model-attempt scopes together", async () => {
    const repository = new RecordingRepository();
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 0
    );

    await service.reserve({
      userId: "user-1",
      clientRequestId: "model-attempt-1",
      resource: "model_attempt"
    });

    expect(repository.scopes).toEqual([
      { scopeType: "global", scopeKey: "all", limit: 1000 },
      { scopeType: "user", scopeKey: "user-1", limit: 30 }
    ]);
  });

  it("commits only after a successful operation", async () => {
    const repository = new RecordingRepository();
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 0
    );

    const result = await service.withReservation(
      {
        userId: "user-1",
        clientRequestId: "answer-success",
        resource: "answer"
      },
      async () => "answer"
    );

    expect(result).toBe("answer");
    expect(repository.transitions).toEqual(["commit"]);
  });

  it("returns the reservation after a failed operation", async () => {
    const repository = new RecordingRepository();
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 0
    );

    await expect(
      service.withReservation(
        {
          userId: "user-1",
          clientRequestId: "answer-failure",
          resource: "answer"
        },
        async () => {
          throw new Error("provider failed");
        }
      )
    ).rejects.toThrow("provider failed");

    expect(repository.transitions).toEqual(["release"]);
  });

  it("does not execute or transition a shared idempotent reservation", async () => {
    const repository = new RecordingRepository();
    const originalReserve = repository.reserve.bind(repository);
    repository.reserve = async (input) => ({
      ...(await originalReserve(input)),
      idempotent: true
    });
    const service = new QuotaService(
      repository,
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1000
      },
      async () => 0
    );
    let operationCalls = 0;

    await expect(
      service.withReservation(
        {
          userId: "user-1",
          clientRequestId: "answer-in-progress",
          resource: "answer"
        },
        async () => {
          operationCalls += 1;
          return "answer";
        }
      )
    ).rejects.toMatchObject({ code: "QUOTA_REQUEST_IN_PROGRESS" });

    expect(operationCalls).toBe(0);
    expect(repository.transitions).toEqual([]);
  });
});
