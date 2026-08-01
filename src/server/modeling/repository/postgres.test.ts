import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  IdempotencyConflictError,
  ModelingLimitError,
  ValidationAttemptInProgressError
} from "./errors";
import {
  assertQueueLimits,
  assertStepUploadIntentReplay,
  PostgresModelingRepository,
  type ValidationAttemptSql
} from "./postgres";
import type {
  BeginValidationAttemptInput,
  ModelingImportIntentRow,
  ReserveStepUploadIntentInput
} from "./types";

const USER_ID = "user-1";
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000002";

describe("STEP upload intent replay contract", () => {
  const request: ReserveStepUploadIntentInput = {
    ownerId: USER_ID,
    projectId: PROJECT_ID,
    idempotencyKey: "step-presign-0001",
    requestHash: "a".repeat(64),
    objectKey: `modeling/${USER_ID}/${PROJECT_ID}/imports/${"b".repeat(40)}.step`,
    sourceName: "housing.step",
    mimeType: "model/step",
    sizeBytes: 4_096,
    checksumSha256: "c".repeat(64),
    expiresAt: new Date("2026-08-01T00:15:00.000Z")
  };
  const intent: ModelingImportIntentRow = {
    id: "10000000-0000-4000-8000-000000000003",
    ...request,
    completionIdempotencyKey: null,
    importJobId: null,
    completedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z")
  };

  it("accepts the same canonical payload while allowing expiry renewal", () => {
    expect(() =>
      assertStepUploadIntentReplay(intent, {
        ...request,
        expiresAt: new Date("2026-08-01T01:15:00.000Z")
      })
    ).not.toThrow();
  });

  it("rejects reusing the owner/project key for a different payload", () => {
    expect(() =>
      assertStepUploadIntentReplay(intent, {
        ...request,
        sizeBytes: request.sizeBytes + 1,
        requestHash: "d".repeat(64)
      })
    ).toThrow(IdempotencyConflictError);
  });
});

describe("PostgresModelingRepository validation attempt ledger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serializes ownership, rate, budget and reservation in one transaction", async () => {
    const sql = ledgerSql({
      usage: { recentAttempts: 2, dailyComputeMs: 1_000 }
    });
    const repository = new PostgresModelingRepository(sql);

    const result = await repository.beginValidationAttempt(operationInput());

    expect(result).toEqual({
      state: "reserved",
      attemptId: ATTEMPT_ID,
      leaseToken: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      reservedComputeMs: 30_000
    });
    expect(sql.beginCalls).toBe(1);
    expect(sql.calls.map((call) => call.query)).toEqual([
      expect.stringContaining("from modeling_project"),
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("from modeling_validation_attempt"),
      expect.stringContaining('as "recentAttempts"'),
      expect.stringContaining("insert into modeling_validation_attempt")
    ]);
    expect(sql.calls[0]?.parameters).toEqual([PROJECT_ID, USER_ID]);
    expect(sql.calls[1]?.parameters).toEqual([739_197_422]);
    expect(sql.calls[4]?.parameters).toEqual([
      USER_ID,
      PROJECT_ID,
      PROJECT_ID,
      "operation_batch",
      "manual-batch-0001",
      "a".repeat(64),
      30_000,
      expect.stringMatching(/^[a-f0-9-]{36}$/u)
    ]);

    const rateClause = sql.calls[3]!.query.slice(
      sql.calls[3]!.query.indexOf("count(*)::int"),
      sql.calls[3]!.query.indexOf('as "recentAttempts"')
    );
    expect(rateClause).not.toContain("status =");
    expect(sql.calls[3]!.query).toContain("from modeling_job j");
    expect(sql.calls[3]!.query).toContain(
      "j.status in ('queued', 'running', 'validating', 'meshing', 'exporting')"
    );
    expect(sql.calls[3]!.query).toContain("reservation_expires_at > now()");
    expect(sql.calls[3]!.parameters).toEqual([USER_ID, 180_000]);
  });

  it("returns a completed replay without checking quota or inserting again", async () => {
    const sql = ledgerSql({
      existing: {
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        requestHash: "a".repeat(64),
        status: "succeeded",
        kernelVersion: "OCCT-7.9"
      }
    });
    const repository = new PostgresModelingRepository(sql);

    await expect(
      repository.beginValidationAttempt(operationInput())
    ).resolves.toEqual({
      state: "succeeded",
      attemptId: ATTEMPT_ID,
      kernelVersion: "OCCT-7.9"
    });
    expect(
      sql.calls.some((call) => call.query.includes("recentAttempts"))
    ).toBe(false);
    expect(
      sql.calls.some((call) =>
        call.query.includes("insert into modeling_validation_attempt")
      )
    ).toBe(false);
  });

  it("replays terminal failures and never re-reserves their idempotency key", async () => {
    const sql = ledgerSql({
      existing: {
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        requestHash: "a".repeat(64),
        status: "failed",
        errorStatus: 422,
        errorCode: "CAD_VALIDATION_FAILED",
        errorMessage: "零厚度实体",
        errorDetails: { diagnostics: [{ code: "BREP_INVALID" }] }
      }
    });
    const repository = new PostgresModelingRepository(sql);

    await expect(
      repository.beginValidationAttempt(operationInput())
    ).resolves.toEqual({
      state: "failed",
      attemptId: ATTEMPT_ID,
      failure: {
        status: 422,
        code: "CAD_VALIDATION_FAILED",
        message: "零厚度实体",
        details: { diagnostics: [{ code: "BREP_INVALID" }] }
      }
    });
    expect(sql.calls).toHaveLength(3);
  });

  it("rejects in-flight and payload-conflicting idempotency replays", async () => {
    const reserved = ledgerSql({
      existing: {
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        requestHash: "a".repeat(64),
        status: "reserved",
        reservationExpired: false
      }
    });
    await expect(
      new PostgresModelingRepository(reserved).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toBeInstanceOf(ValidationAttemptInProgressError);

    const conflict = ledgerSql({
      existing: {
        attemptId: ATTEMPT_ID,
        projectId: PROJECT_ID,
        requestHash: "b".repeat(64),
        status: "succeeded"
      }
    });
    await expect(
      new PostgresModelingRepository(conflict).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("counts failed rows toward 30/min and refuses a 31st reservation", async () => {
    const sql = ledgerSql({
      usage: { recentAttempts: 30, dailyComputeMs: 0 }
    });

    await expect(
      new PostgresModelingRepository(sql).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toMatchObject({
      code: "MODELING_OPERATION_RATE_LIMIT"
    } satisfies Partial<ModelingLimitError>);
    expect(
      sql.calls.some((call) =>
        call.query.includes("insert into modeling_validation_attempt")
      )
    ).toBe(false);
  });

  it("checks outstanding reservations against the daily 20 minute budget", async () => {
    const sql = ledgerSql({
      usage: { recentAttempts: 1, dailyComputeMs: 1_175_000 }
    });

    await expect(
      new PostgresModelingRepository(sql).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toMatchObject({
      code: "MODELING_DAILY_COMPUTE_LIMIT",
      details: {
        limitSeconds: 1_200,
        usedMilliseconds: 1_175_000,
        reservedMilliseconds: 30_000
      }
    } satisfies Partial<ModelingLimitError>);
  });

  it("rejects the 22nd global and fourth per-user direct validation admission", async () => {
    const globallyFull = ledgerSql({
      usage: {
        recentAttempts: 0,
        dailyComputeMs: 0,
        globalActive: 21,
        userActive: 0
      }
    });
    await expect(
      new PostgresModelingRepository(globallyFull).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toMatchObject({
      code: "MODELING_QUEUE_FULL",
      details: { limit: 21, runningLimit: 1, queueLimit: 20 }
    } satisfies Partial<ModelingLimitError>);

    const userFull = ledgerSql({
      usage: {
        recentAttempts: 0,
        dailyComputeMs: 0,
        globalActive: 3,
        userActive: 3
      }
    });
    await expect(
      new PostgresModelingRepository(userFull).beginValidationAttempt(
        operationInput()
      )
    ).rejects.toMatchObject({
      code: "MODELING_USER_QUEUE_LIMIT",
      details: { limit: 3, runningLimit: 1, queueLimit: 2 }
    } satisfies Partial<ModelingLimitError>);

    for (const candidate of [globallyFull, userFull]) {
      expect(
        candidate.calls.some((call) =>
          call.query.includes("insert into modeling_validation_attempt")
        )
      ).toBe(false);
    }
  });

  it("allows the 21st global and third per-user direct validation admission", async () => {
    const sql = ledgerSql({
      usage: {
        recentAttempts: 0,
        dailyComputeMs: 0,
        globalActive: 20,
        userActive: 2
      }
    });

    await expect(
      new PostgresModelingRepository(sql).beginValidationAttempt(
        operationInput()
      )
    ).resolves.toMatchObject({ state: "reserved", attemptId: ATTEMPT_ID });
  });

  it("releases a reservation to actual duration for success and failure", async () => {
    const successSql = new RecordingValidationSql((query) =>
      query.startsWith("update modeling_validation_attempt")
        ? [{ attemptId: ATTEMPT_ID }]
        : []
    );
    await new PostgresModelingRepository(successSql).completeValidationAttempt({
      ownerId: USER_ID,
      attemptId: ATTEMPT_ID,
      leaseToken: "lease-success",
      actualDurationMs: 12.2,
      outcome: { status: "succeeded", kernelVersion: "OCCT-7.9" }
    });
    expect(successSql.calls[0]?.parameters).toEqual([
      "succeeded",
      13,
      "OCCT-7.9",
      null,
      null,
      null,
      null,
      ATTEMPT_ID,
      USER_ID,
      "lease-success"
    ]);

    const failureSql = new RecordingValidationSql((query) =>
      query.startsWith("update modeling_validation_attempt")
        ? [{ attemptId: ATTEMPT_ID }]
        : []
    );
    await new PostgresModelingRepository(failureSql).completeValidationAttempt({
      ownerId: USER_ID,
      attemptId: ATTEMPT_ID,
      leaseToken: "lease-failure",
      actualDurationMs: 17,
      outcome: {
        status: "failed",
        errorStatus: 422,
        errorCode: "CAD_VALIDATION_FAILED",
        errorMessage: "零厚度实体",
        errorDetails: { diagnostics: [{ code: "BREP_INVALID" }] }
      }
    });
    expect(failureSql.calls[0]?.parameters).toEqual([
      "failed",
      17,
      null,
      422,
      "CAD_VALIDATION_FAILED",
      "零厚度实体",
      JSON.stringify({ diagnostics: [{ code: "BREP_INVALID" }] }),
      ATTEMPT_ID,
      USER_ID,
      "lease-failure"
    ]);
  });

  it("does not query or create a ledger row for an unowned project", async () => {
    const sql = ledgerSql({ owned: false });

    await expect(
      new PostgresModelingRepository(sql).beginValidationAttempt(
        operationInput()
      )
    ).resolves.toBeNull();
    expect(sql.calls).toHaveLength(1);
  });

  it("reclaims an expired reservation after a service restart with a fenced lease", async () => {
    const calls: SqlCall[] = [];
    const sql = new RecordingValidationSql((query, parameters) => {
      calls.push({ query, parameters });
      if (query.includes("pg_advisory_xact_lock")) return [];
      if (query.includes("from modeling_project")) return [{ id: PROJECT_ID }];
      if (
        query.includes("and idempotency_key") &&
        query.includes("for update")
      ) {
        return [
          {
            attemptId: ATTEMPT_ID,
            projectId: PROJECT_ID,
            requestHash: "a".repeat(64),
            status: "reserved",
            reservedComputeMs: 30_000,
            consumedComputeMs: 0,
            reservationExpired: true
          }
        ];
      }
      if (query.includes('as "recentAttempts"')) {
        return [{ recentAttempts: 1, dailyComputeMs: 30_000 }];
      }
      if (query.startsWith("update modeling_validation_attempt")) {
        return [{ attemptId: ATTEMPT_ID }];
      }
      return [];
    });

    const result = await new PostgresModelingRepository(
      sql
    ).beginValidationAttempt(operationInput());

    expect(result).toMatchObject({
      state: "reserved",
      attemptId: ATTEMPT_ID,
      reservedComputeMs: 30_000
    });
    if (result?.state !== "reserved") throw new Error("expected reservation");
    const reclaim = calls.find((call) =>
      call.query.startsWith("update modeling_validation_attempt")
    );
    expect(reclaim?.query).toContain(
      "consumed_compute_ms = consumed_compute_ms + reserved_compute_ms"
    );
    expect(reclaim?.parameters).toEqual([
      ATTEMPT_ID,
      result.leaseToken,
      30_000
    ]);
  });

  it("rejects a late completion from the old lease after recovery", async () => {
    const sql = new RecordingValidationSql((query) => {
      if (query.startsWith("update modeling_validation_attempt")) return [];
      if (query.startsWith("select status")) {
        return [{ status: "reserved", leaseToken: "new-lease" }];
      }
      return [];
    });

    await expect(
      new PostgresModelingRepository(sql).completeValidationAttempt({
        ownerId: USER_ID,
        attemptId: ATTEMPT_ID,
        leaseToken: "old-lease",
        actualDurationMs: 30_000,
        outcome: { status: "succeeded", kernelVersion: "OCCT-7.9" }
      })
    ).rejects.toMatchObject({
      code: "MODELING_VALIDATION_STATE_CONFLICT"
    });
  });
});

describe("PostgresModelingRepository asynchronous admission", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("durably reserves the job timeout and permits an exact 20 minute fill", async () => {
    const overBudget = new RecordingQueueTransaction(
      { dailyComputeMs: 1_020_001 },
      {}
    );
    await expect(
      assertQueueLimits(overBudget as never, USER_ID, "build")
    ).rejects.toMatchObject({
      code: "MODELING_DAILY_COMPUTE_LIMIT",
      details: {
        limitSeconds: 1_200,
        usedMilliseconds: 1_020_001,
        reservedMilliseconds: 180_000
      }
    } satisfies Partial<ModelingLimitError>);

    const exactBudget = new RecordingQueueTransaction(
      { dailyComputeMs: 1_020_000 },
      {}
    );
    await expect(
      assertQueueLimits(exactBudget as never, USER_ID, "build")
    ).resolves.toBeUndefined();

    const selection = overBudget.selections[0];
    const charge = new PgDialect().sqlToQuery(selection?.dailyComputeMs as SQL);
    expect(charge.sql).toContain(
      `"modeling_job"."status" in ('queued', 'running', 'validating', 'meshing', 'exporting')`
    );
    expect(charge.sql).toContain("::double precision");
    expect(charge.params).toContain(180_000);
  });

  it("counts unexpired direct validations against async global and user capacity", async () => {
    const globallyFull = new RecordingQueueTransaction(
      { globalActive: 18, userActive: 0 },
      { globalActive: 3, userActive: 0 }
    );
    await expect(
      assertQueueLimits(globallyFull as never, USER_ID, "preview")
    ).rejects.toMatchObject({ code: "MODELING_QUEUE_FULL" });

    const userFull = new RecordingQueueTransaction(
      { globalActive: 3, userActive: 1 },
      { globalActive: 0, userActive: 2 }
    );
    await expect(
      assertQueueLimits(userFull as never, USER_ID, "preview")
    ).rejects.toMatchObject({ code: "MODELING_USER_QUEUE_LIMIT" });

    const validationSelection = userFull.selections[1];
    const activeReservation = new PgDialect().sqlToQuery(
      validationSelection?.globalActive as SQL
    );
    expect(activeReservation.sql).toContain("reservation_expires_at");
    expect(activeReservation.sql).toContain("> now()");
  });
});

type SqlCall = { query: string; parameters?: unknown[] };

class RecordingValidationSql implements ValidationAttemptSql {
  readonly calls: SqlCall[] = [];
  beginCalls = 0;

  constructor(
    private readonly respond: (
      query: string,
      parameters?: unknown[]
    ) => Array<Record<string, unknown>>
  ) {}

  async unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>> {
    const normalized = query.trim();
    this.calls.push({ query: normalized, parameters });
    return this.respond(normalized, parameters);
  }

  async begin<T>(
    handler: (transaction: ValidationAttemptSql) => Promise<T>
  ): Promise<T> {
    this.beginCalls += 1;
    return handler(this);
  }
}

function ledgerSql(
  options: {
    owned?: boolean;
    existing?: Record<string, unknown>;
    usage?: {
      recentAttempts: number;
      dailyComputeMs: number;
      globalActive?: number;
      userActive?: number;
    };
  } = {}
): RecordingValidationSql {
  return new RecordingValidationSql((query) => {
    if (query.includes("pg_advisory_xact_lock")) {
      return [];
    }
    if (query.includes("from modeling_project")) {
      return options.owned === false ? [] : [{ id: PROJECT_ID }];
    }
    if (
      query.includes("from modeling_validation_attempt") &&
      query.includes("for update")
    ) {
      return options.existing ? [options.existing] : [];
    }
    if (query.includes('as "recentAttempts"')) {
      return [
        {
          globalActive: 0,
          userActive: 0,
          ...(options.usage ?? { recentAttempts: 0, dailyComputeMs: 0 })
        }
      ];
    }
    if (query.startsWith("insert into modeling_validation_attempt")) {
      return [{ attemptId: ATTEMPT_ID }];
    }
    return [];
  });
}

class RecordingQueueTransaction {
  readonly selections: Array<Record<string, SQL>> = [];
  private selectCount = 0;

  constructor(
    private readonly jobUsage: Record<string, number>,
    private readonly validationUsage: Record<string, number>
  ) {}

  async execute(): Promise<void> {}

  select(selection: Record<string, SQL>) {
    this.selections.push(selection);
    const rows = [
      {
        globalQueued: 0,
        userQueued: 0,
        userRunning: 0,
        globalActive: 0,
        userActive: 0,
        dailyExports: 0,
        dailyComputeMs: 0,
        ...(this.selectCount++ === 0 ? this.jobUsage : this.validationUsage)
      }
    ];
    const promise = Promise.resolve(rows);
    return {
      from: () => ({
        innerJoin: () => promise,
        then: promise.then.bind(promise)
      })
    };
  }
}

function operationInput(): BeginValidationAttemptInput {
  return {
    ownerId: USER_ID,
    projectId: PROJECT_ID,
    kind: "operation_batch",
    idempotencyKey: "manual-batch-0001",
    requestHash: "a".repeat(64)
  };
}
