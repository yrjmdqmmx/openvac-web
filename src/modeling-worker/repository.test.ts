import { describe, expect, it } from "vitest";

import { hashModelingPlanDraft } from "@/lib/modeling";
import type { ModelDocument, ModelingPlanDraft } from "@/types/modeling";

import {
  CLAIM_NEXT_SQL,
  PostgresModelingWorkerRepository,
  StaleArtifactCleanupLeaseError,
  type WorkerSql
} from "./repository";
import type { LeasedArtifactCleanup, LeasedModelingJob } from "./types";

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const PLAN_ID = "77777777-7777-4777-8777-777777777777";

describe("PostgresModelingWorkerRepository", () => {
  it("claims only expired preview/export artifacts with a fenced lease", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query, parameters = []) {
        calls.push({ query, parameters });
        return [
          {
            ...artifactCleanupRow(),
            cleanup_lease_token: parameters[1]
          }
        ];
      }
    };

    const artifact = await new PostgresModelingWorkerRepository(
      client
    ).claimExpiredArtifact("cleanup-worker-1", 45_000);

    expect(artifact).toMatchObject({
      id: "10000000-0000-4000-8000-000000000010",
      kind: "preview",
      leaseOwner: "cleanup-worker-1",
      attempts: 2
    });
    expect(artifact?.leaseToken).toMatch(/^[a-f0-9-]{36}$/u);
    expect(calls[0]?.query).toMatch(/kind IN \('preview', 'export'\)/u);
    expect(calls[0]?.query).toContain("expires_at <= NOW()");
    expect(calls[0]?.query).toContain("cleanup_next_attempt_at <= NOW()");
    expect(calls[0]?.query).toContain("cleanup_lease_expires_at <= NOW()");
    expect(calls[0]?.query).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]?.parameters).toEqual([
      "cleanup-worker-1",
      artifact?.leaseToken,
      45_000
    ]);
  });

  it("deletes the artifact row only for the current object and cleanup lease", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query, parameters = []) {
        calls.push({ query, parameters });
        return query.includes("DELETE FROM modeling_artifact")
          ? [{ id: ARTIFACT_CLEANUP.id }]
          : [];
      }
    };

    await new PostgresModelingWorkerRepository(
      client
    ).completeExpiredArtifactCleanup(ARTIFACT_CLEANUP);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("object_key = $2");
    expect(calls[0]?.query).toContain("cleanup_lease_owner = $3");
    expect(calls[0]?.query).toContain("cleanup_lease_token = $4");
    expect(calls[0]?.parameters).toEqual([
      ARTIFACT_CLEANUP.id,
      ARTIFACT_CLEANUP.objectKey,
      ARTIFACT_CLEANUP.leaseOwner,
      ARTIFACT_CLEANUP.leaseToken
    ]);
  });

  it("keeps a failed cleanup row and makes release retries idempotent", async () => {
    let released = false;
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query) {
        if (query.includes("UPDATE modeling_artifact")) {
          if (released) return [];
          released = true;
          return [{ id: ARTIFACT_CLEANUP.id }];
        }
        if (query.includes("SELECT cleanup_lease_token")) {
          return [{ cleanup_lease_token: null }];
        }
        return [];
      }
    };
    const repository = new PostgresModelingWorkerRepository(client);

    await expect(
      repository.failExpiredArtifactCleanup(
        ARTIFACT_CLEANUP,
        new Error("OSS unavailable"),
        12_000
      )
    ).resolves.toBeUndefined();
    await expect(
      repository.failExpiredArtifactCleanup(
        ARTIFACT_CLEANUP,
        new Error("OSS unavailable"),
        12_000
      )
    ).resolves.toBeUndefined();
  });

  it("rejects cleanup completion after another worker reclaimed the lease", async () => {
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query) {
        if (query.includes("DELETE FROM modeling_artifact")) return [];
        return [{ cleanup_lease_token: "newer-lease" }];
      }
    };

    await expect(
      new PostgresModelingWorkerRepository(
        client
      ).completeExpiredArtifactCleanup(ARTIFACT_CLEANUP)
    ).rejects.toBeInstanceOf(StaleArtifactCleanupLeaseError);
  });

  it("uses a serialized SKIP LOCKED claim and appends the next event sequence", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query, parameters = []) {
        calls.push({ query, parameters });
        if (query.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: true }];
        }
        if (query.includes("RETURNING\n    claimed_job.*")) {
          return [leasedRow()];
        }
        if (query.includes("MAX(sequence)")) {
          return [{ sequence: 7 }];
        }
        return [];
      }
    };
    const repository = new PostgresModelingWorkerRepository(client);

    const job = await repository.claimNext("worker-1", 60_000);

    expect(job).toMatchObject({
      id: JOB_ID,
      workerId: "worker-1",
      recovered: true,
      kind: "build"
    });
    expect(CLAIM_NEXT_SQL).toMatch(/FOR UPDATE SKIP LOCKED/u);
    expect(CLAIM_NEXT_SQL).toMatch(/NOT EXISTS/u);
    expect(CLAIM_NEXT_SQL).toMatch(/lease_expires_at <= NOW\(\)/u);
    const insertedEvent = calls.find((call) =>
      call.query.includes("INSERT INTO modeling_job_event")
    );
    expect(insertedEvent?.parameters[1]).toBe(8);
    expect(insertedEvent?.parameters[2]).toBe("lease_recovered");
  });

  it("does not claim when another transaction owns the global claim gate", async () => {
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query) {
        if (query.includes("pg_try_advisory_xact_lock")) {
          return [{ acquired: false }];
        }
        throw new Error("claim query must not execute without advisory lock");
      }
    };

    await expect(
      new PostgresModelingWorkerRepository(client).claimNext("worker-2", 60_000)
    ).resolves.toBeNull();
  });

  it("refuses a stale STEP import before inserting or advancing a revision", async () => {
    const calls: string[] = [];
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query) {
        calls.push(query);
        if (query.includes("SELECT cancel_requested_at")) {
          return [{ cancel_requested_at: null }];
        }
        if (query.includes("FROM modeling_project")) {
          return [
            {
              current_revision_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            }
          ];
        }
        throw new Error(`unexpected SQL: ${query}`);
      }
    };
    const repository = new PostgresModelingWorkerRepository(client);

    await expect(
      repository.completeImport(importJob(), {
        document: {
          version: "openvac.modeling.v1",
          id: "11111111-1111-4111-8111-111111111111",
          revision: 1,
          revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Imported model",
          unitSystem: "mm-deg",
          parameters: [],
          sketches: [],
          features: [],
          components: [],
          assemblyConstraints: []
        },
        contentHash: "a".repeat(64),
        operations: [],
        output: {},
        sourceArtifact: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          kind: "source",
          filename: "housing.step",
          mimeType: "model/step",
          objectKey: "modeling/user/project/import.step",
          checksumSha256: "d".repeat(64),
          sizeBytes: 100,
          expiresAt: null,
          metadata: {}
        },
        previewArtifacts: []
      })
    ).rejects.toMatchObject({ code: "STALE_IMPORT_BASE" });
    expect(
      calls.some((query) => query.includes("INSERT INTO modeling_revision"))
    ).toBe(false);
    expect(
      calls.some((query) => query.includes("UPDATE modeling_project"))
    ).toBe(false);
  });

  it("atomically stores an AI plan, preview, job plan_id and terminal event", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const draft = aiPlanDraft();
    const preview = {
      id: "88888888-8888-4888-8888-888888888888",
      kind: "preview" as const,
      filename: "plan.glb",
      mimeType: "model/gltf-binary",
      objectKey: "modeling/project/revision/execution/plan.glb",
      checksumSha256: "b".repeat(64),
      sizeBytes: 4,
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
      metadata: { planHash: draft.planHash }
    };
    const client: WorkerSql = {
      async begin<T>(handler: (transaction: WorkerSql) => Promise<T>) {
        return handler(this);
      },
      async unsafe(query, parameters = []) {
        calls.push({ query, parameters });
        if (query.includes("SELECT cancel_requested_at")) {
          return [{ cancel_requested_at: null }];
        }
        if (query.includes("SELECT current_revision_id")) {
          return [{ current_revision_id: REVISION_ID }];
        }
        if (query.includes("SELECT content_hash, document")) {
          return [{ content_hash: "a".repeat(64), document: aiDocument() }];
        }
        if (
          query.includes("FROM modeling_plan") &&
          query.includes("FOR UPDATE")
        ) {
          return [];
        }
        if (query.includes("INSERT INTO modeling_plan")) {
          return [aiPlanSqlRow(draft)];
        }
        if (query.includes("INSERT INTO modeling_artifact")) {
          return [
            {
              id: preview.id,
              job_id: JOB_ID,
              checksum_sha256: preview.checksumSha256,
              size_bytes: preview.sizeBytes
            }
          ];
        }
        if (query.includes("UPDATE modeling_job")) {
          return [{ id: JOB_ID }];
        }
        if (query.includes("MAX(sequence)")) return [{ sequence: 3 }];
        return [];
      }
    };
    const repository = new PostgresModelingWorkerRepository(client);

    await expect(
      repository.completeAiPlan(aiPlanJob(), {
        baseRevisionHash: "a".repeat(64),
        prompt: "需要转子直径",
        draft,
        dryRun: null,
        artifacts: [preview]
      })
    ).resolves.toEqual({
      status: "succeeded",
      artifactIds: [preview.id],
      planId: PLAN_ID,
      replayed: false
    });

    const planInsertIndex = calls.findIndex((call) =>
      call.query.includes("INSERT INTO modeling_plan")
    );
    const artifactInsertIndex = calls.findIndex((call) =>
      call.query.includes("INSERT INTO modeling_artifact")
    );
    const jobUpdateIndex = calls.findIndex((call) =>
      call.query.includes("UPDATE modeling_job")
    );
    expect(planInsertIndex).toBeGreaterThan(-1);
    expect(artifactInsertIndex).toBeGreaterThan(planInsertIndex);
    expect(jobUpdateIndex).toBeGreaterThan(artifactInsertIndex);
    const artifactInsert = calls[artifactInsertIndex]!;
    expect(artifactInsert.query).toContain("$11::timestamptz");
    expect(artifactInsert.parameters[10]).toBe("2026-08-31T00:00:00.000Z");
    const jobUpdate = calls[jobUpdateIndex]!;
    expect(jobUpdate.query).toContain("plan_id = $4::uuid");
    expect(jobUpdate.parameters[3]).toBe(PLAN_ID);
    expect(JSON.parse(String(jobUpdate.parameters[4]))).toMatchObject({
      planId: PLAN_ID,
      planHash: draft.planHash,
      planStatus: "needs_input",
      artifactIds: [preview.id]
    });
    expect(
      calls.some(
        (call) =>
          call.query.includes("INSERT INTO modeling_job_event") &&
          call.parameters[2] === "succeeded"
      )
    ).toBe(true);
  });
});

function leasedRow(): Record<string, unknown> {
  return {
    id: JOB_ID,
    project_id: "44444444-4444-4444-8444-444444444444",
    revision_id: "22222222-2222-4222-8222-222222222222",
    plan_id: null,
    owner_id: "user-1",
    kind: "build",
    input: { formats: ["glb"] },
    idempotency_key: "job-build-1",
    progress: 20,
    lease_owner: "worker-1",
    lease_token: "55555555-5555-4555-8555-555555555555",
    lease_expires_at: new Date("2026-08-01T08:01:00.000Z"),
    cancel_requested_at: null,
    previous_status: "meshing"
  };
}

function importJob(): LeasedModelingJob {
  return {
    id: JOB_ID,
    projectId: "44444444-4444-4444-8444-444444444444",
    revisionId: "22222222-2222-4222-8222-222222222222",
    planId: null,
    ownerId: "user-1",
    kind: "import",
    input: {},
    idempotencyKey: "import-job-1",
    progress: 75,
    workerId: "worker-1",
    leaseToken: "55555555-5555-4555-8555-555555555555",
    leaseExpiresAt: new Date("2026-08-01T08:01:00.000Z"),
    cancelRequestedAt: null,
    recovered: false
  };
}

function aiPlanJob(): LeasedModelingJob {
  return {
    ...importJob(),
    projectId: PROJECT_ID,
    revisionId: REVISION_ID,
    kind: "ai_plan",
    input: {
      baseRevisionId: REVISION_ID,
      baseRevisionHash: "a".repeat(64),
      prompt: "需要转子直径"
    },
    idempotencyKey: "ai-plan-job-1"
  };
}

function aiDocument(): ModelDocument {
  return {
    version: "openvac.modeling.v1",
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    revisionId: REVISION_ID,
    name: "AI plan base",
    unitSystem: "mm-deg",
    parameters: [],
    sketches: [],
    features: [],
    components: [],
    assemblyConstraints: []
  };
}

function aiPlanDraft(): ModelingPlanDraft {
  const incomplete: ModelingPlanDraft = {
    version: "openvac.modeling.v1",
    id: "99999999-9999-4999-8999-999999999999",
    documentId: aiDocument().id,
    baseRevisionId: REVISION_ID,
    title: "需要尺寸",
    summary: "需要用户输入转子直径。",
    status: "needs_input",
    assumptions: [],
    warnings: [],
    missingInputs: ["请输入转子直径（mm）。"],
    expectedChecks: [],
    planHash: "0".repeat(64)
  };
  return { ...incomplete, planHash: hashModelingPlanDraft(incomplete) };
}

function aiPlanSqlRow(draft: ModelingPlanDraft): Record<string, unknown> {
  return {
    id: PLAN_ID,
    project_id: PROJECT_ID,
    base_revision_id: REVISION_ID,
    base_revision_hash: "a".repeat(64),
    plan_hash: draft.planHash,
    prompt: "需要转子直径",
    draft,
    status: "needs_input",
    missing_inputs: draft.missingInputs
  };
}

const ARTIFACT_CLEANUP: LeasedArtifactCleanup = {
  id: "10000000-0000-4000-8000-000000000010",
  projectId: "44444444-4444-4444-8444-444444444444",
  kind: "preview",
  objectKey: "modeling/project/revision/job/model.glb",
  leaseToken: "10000000-0000-4000-8000-000000000011",
  leaseOwner: "cleanup-worker-1",
  leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
  attempts: 2
};

function artifactCleanupRow(): Record<string, unknown> {
  return {
    id: ARTIFACT_CLEANUP.id,
    project_id: ARTIFACT_CLEANUP.projectId,
    kind: ARTIFACT_CLEANUP.kind,
    object_key: ARTIFACT_CLEANUP.objectKey,
    cleanup_lease_owner: ARTIFACT_CLEANUP.leaseOwner,
    cleanup_lease_token: ARTIFACT_CLEANUP.leaseToken,
    cleanup_lease_expires_at: ARTIFACT_CLEANUP.leaseExpiresAt,
    cleanup_attempts: ARTIFACT_CLEANUP.attempts
  };
}
