import { randomUUID } from "node:crypto";

import {
  hashModelingPlanDraft,
  modelDocumentSchema,
  modelingPlanDraftSchema
} from "@/lib/modeling";
import { sqlClient } from "@/server/db";

import type {
  ActiveModelingJobStatus,
  CompleteAiPlanInput,
  CompleteAiPlanResult,
  CompleteImportInput,
  CompleteImportResult,
  CompleteJobResult,
  LeasedArtifactCleanup,
  LeasedModelingJob,
  LeaseRenewal,
  ModelingJobKind,
  ModelingRevisionSnapshot,
  ModelingSourceArtifact,
  ModelingWorkerRepository,
  PendingModelingArtifact,
  StoredAiPlanSnapshot
} from "./types";

const GLOBAL_MODELING_WORKER_LOCK = 739_197_423;
const ACTIVE_STATUSES = "'running', 'validating', 'meshing', 'exporting'";

export interface WorkerSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(handler: (transaction: WorkerSql) => Promise<T>): Promise<T>;
}

export class StaleModelingLeaseError extends Error {
  constructor(jobId: string) {
    super(`Modeling worker lease for ${jobId} is no longer current.`);
    this.name = "StaleModelingLeaseError";
  }
}

export class ModelingCancellationRequestedError extends Error {
  constructor(jobId: string) {
    super(`Modeling job ${jobId} was cancelled.`);
    this.name = "ModelingCancellationRequestedError";
  }
}

export class StaleArtifactCleanupLeaseError extends Error {
  constructor(artifactId: string) {
    super(`Artifact cleanup lease for ${artifactId} is no longer current.`);
    this.name = "StaleArtifactCleanupLeaseError";
  }
}

export class ModelingWorkerError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "ModelingWorkerError";
    this.code = code;
  }
}

/**
 * The transaction-scoped advisory lock serializes the global concurrency
 * decision. SKIP LOCKED then makes reclaiming an expired lease safe when a
 * previous worker died after claiming the row.
 */
export const CLAIM_NEXT_SQL = `
  WITH candidate AS MATERIALIZED (
    SELECT
      candidate_job.id,
      candidate_job.status AS previous_status
    FROM modeling_job candidate_job
    WHERE
      (
        candidate_job.status = 'queued'
        OR (
          candidate_job.status IN (${ACTIVE_STATUSES})
          AND (
            candidate_job.lease_expires_at IS NULL
            OR candidate_job.lease_expires_at <= NOW()
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM modeling_job active_job
        WHERE
          active_job.status IN (${ACTIVE_STATUSES})
          AND active_job.lease_expires_at > NOW()
      )
    ORDER BY
      CASE WHEN candidate_job.status = 'queued' THEN 1 ELSE 0 END,
      candidate_job.created_at,
      candidate_job.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE modeling_job claimed_job
  SET
    status = 'running',
    progress = GREATEST(claimed_job.progress, 1),
    lease_owner = $1,
    lease_token = $2,
    lease_expires_at = NOW() + make_interval(secs => $3),
    started_at = COALESCE(claimed_job.started_at, NOW()),
    completed_at = NULL,
    error_code = NULL,
    error_message = NULL,
    updated_at = NOW()
  FROM candidate
  WHERE claimed_job.id = candidate.id
  RETURNING
    claimed_job.*,
    candidate.previous_status,
    claimed_job.created_by_user_id AS owner_id
`;

export class PostgresModelingWorkerRepository implements ModelingWorkerRepository {
  private readonly sql: WorkerSql;

  constructor(client: WorkerSql = sqlClient as unknown as WorkerSql) {
    this.sql = client;
  }

  async claimExpiredArtifact(
    workerId: string,
    leaseMs: number
  ): Promise<LeasedArtifactCleanup | null> {
    const leaseToken = randomUUID();
    const [row] = await this.sql.unsafe(
      `
        WITH candidate AS MATERIALIZED (
          SELECT id
          FROM modeling_artifact
          WHERE kind IN ('preview', 'export')
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()
            AND (
              cleanup_next_attempt_at IS NULL
              OR cleanup_next_attempt_at <= NOW()
            )
            AND (
              cleanup_lease_token IS NULL
              OR cleanup_lease_expires_at IS NULL
              OR cleanup_lease_expires_at <= NOW()
            )
          ORDER BY expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE modeling_artifact artifact
        SET cleanup_lease_owner = $1,
            cleanup_lease_token = $2,
            cleanup_lease_expires_at =
              NOW() + ($3 * interval '1 millisecond'),
            cleanup_attempts = artifact.cleanup_attempts + 1,
            cleanup_last_error = NULL
        FROM candidate
        WHERE artifact.id = candidate.id
        RETURNING artifact.id,
                  artifact.project_id,
                  artifact.kind,
                  artifact.object_key,
                  artifact.cleanup_lease_owner,
                  artifact.cleanup_lease_token,
                  artifact.cleanup_lease_expires_at,
                  artifact.cleanup_attempts
      `,
      [workerId, leaseToken, positiveMilliseconds(leaseMs, "leaseMs")]
    );
    return row ? parseArtifactCleanupLease(row) : null;
  }

  async completeExpiredArtifactCleanup(
    artifact: LeasedArtifactCleanup
  ): Promise<void> {
    const [deleted] = await this.sql.unsafe(
      `
        DELETE FROM modeling_artifact
        WHERE id = $1::uuid
          AND object_key = $2
          AND cleanup_lease_owner = $3
          AND cleanup_lease_token = $4
        RETURNING id
      `,
      [
        artifact.id,
        artifact.objectKey,
        artifact.leaseOwner,
        artifact.leaseToken
      ]
    );
    if (deleted) return;
    const [existing] = await this.sql.unsafe(
      "SELECT cleanup_lease_token FROM modeling_artifact WHERE id = $1::uuid",
      [artifact.id]
    );
    if (!existing) return;
    throw new StaleArtifactCleanupLeaseError(artifact.id);
  }

  async failExpiredArtifactCleanup(
    artifact: LeasedArtifactCleanup,
    error: Error,
    retryDelayMs: number
  ): Promise<void> {
    const [released] = await this.sql.unsafe(
      `
        UPDATE modeling_artifact
        SET cleanup_lease_owner = NULL,
            cleanup_lease_token = NULL,
            cleanup_lease_expires_at = NULL,
            cleanup_next_attempt_at =
              NOW() + ($5 * interval '1 millisecond'),
            cleanup_last_error = $6
        WHERE id = $1::uuid
          AND object_key = $2
          AND cleanup_lease_owner = $3
          AND cleanup_lease_token = $4
        RETURNING id
      `,
      [
        artifact.id,
        artifact.objectKey,
        artifact.leaseOwner,
        artifact.leaseToken,
        positiveMilliseconds(retryDelayMs, "retryDelayMs"),
        safeErrorMessage(error)
      ]
    );
    if (released) return;
    const [existing] = await this.sql.unsafe(
      "SELECT cleanup_lease_token FROM modeling_artifact WHERE id = $1::uuid",
      [artifact.id]
    );
    if (!existing) return;
    // If the first release committed but its response was lost, replaying the
    // same failure is a no-op. A non-null token belongs to a current/reclaimed
    // lease and must remain fenced.
    if (existing.cleanup_lease_token === null) return;
    throw new StaleArtifactCleanupLeaseError(artifact.id);
  }

  async claimNext(
    workerId: string,
    leaseMs: number
  ): Promise<LeasedModelingJob | null> {
    const leaseSeconds = millisecondsToSeconds(leaseMs);
    const leaseToken = randomUUID();
    return this.sql.begin(async (transaction) => {
      const [lock] = await transaction.unsafe(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        [GLOBAL_MODELING_WORKER_LOCK]
      );
      if (lock?.acquired !== true) {
        return null;
      }

      const [row] = await transaction.unsafe(CLAIM_NEXT_SQL, [
        workerId,
        leaseToken,
        leaseSeconds
      ]);
      if (!row) {
        return null;
      }

      try {
        const job = parseLeasedJob(row);
        await appendEvent(
          transaction,
          job.id,
          job.recovered ? "lease_recovered" : "started",
          {
            kind: job.kind,
            progress: job.progress,
            recovered: job.recovered
          }
        );
        return job;
      } catch (cause) {
        const jobId = typeof row.id === "string" ? row.id : "";
        if (jobId) {
          const error = asError(cause);
          await transaction.unsafe(
            `
              UPDATE modeling_job
              SET
                status = 'failed',
                completed_at = NOW(),
                error_code = 'MALFORMED_JOB',
                error_message = $2,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
              WHERE id = $1
                AND lease_owner = $3
                AND lease_token = $4
            `,
            [jobId, safeErrorMessage(error), workerId, leaseToken]
          );
          await appendEvent(transaction, jobId, "failed", {
            code: "MALFORMED_JOB",
            message: safeErrorMessage(error)
          });
        }
        return null;
      }
    });
  }

  async renewLease(
    job: LeasedModelingJob,
    leaseMs: number
  ): Promise<LeaseRenewal> {
    const [row] = await this.sql.unsafe(
      `
        UPDATE modeling_job
        SET
          lease_expires_at = NOW() + make_interval(secs => $4),
          updated_at = NOW()
        WHERE id = $1
          AND lease_owner = $2
          AND lease_token = $3
          AND status IN (${ACTIVE_STATUSES})
        RETURNING cancel_requested_at
      `,
      [job.id, job.workerId, job.leaseToken, millisecondsToSeconds(leaseMs)]
    );
    if (!row) {
      throw new StaleModelingLeaseError(job.id);
    }
    return row.cancel_requested_at ? "cancel_requested" : "active";
  }

  async transition(
    job: LeasedModelingJob,
    status: ActiveModelingJobStatus,
    progress: number,
    eventType: string,
    eventData: Record<string, unknown> = {}
  ): Promise<void> {
    const boundedProgress = boundedPercentage(progress);
    await this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        throw new ModelingCancellationRequestedError(job.id);
      }
      const [updated] = await transaction.unsafe(
        `
          UPDATE modeling_job
          SET
            status = $4::modeling_job_status,
            progress = GREATEST(progress, $5),
            updated_at = NOW()
          WHERE id = $1
            AND lease_owner = $2
            AND lease_token = $3
          RETURNING progress
        `,
        [job.id, job.workerId, job.leaseToken, status, boundedProgress]
      );
      if (!updated) {
        throw new StaleModelingLeaseError(job.id);
      }
      await appendEvent(transaction, job.id, eventType, {
        ...eventData,
        status,
        progress: Number(updated.progress)
      });
    });
  }

  async loadRevision(
    job: LeasedModelingJob
  ): Promise<ModelingRevisionSnapshot> {
    if (!job.revisionId) {
      throw new ModelingWorkerError(
        "REVISION_REQUIRED",
        "建模任务缺少基础版本。"
      );
    }
    const [row] = await this.sql.unsafe(
      `
        SELECT
          revision.id,
          revision.project_id,
          revision.content_hash,
          revision.document
        FROM modeling_revision revision
        JOIN modeling_job job
          ON job.id = $1
          AND job.project_id = revision.project_id
          AND job.revision_id = revision.id
        WHERE
          revision.id = $2
          AND job.lease_owner = $3
          AND job.lease_token = $4
          AND job.status IN (${ACTIVE_STATUSES})
        LIMIT 1
      `,
      [job.id, job.revisionId, job.workerId, job.leaseToken]
    );
    if (!row) {
      throw new StaleModelingLeaseError(job.id);
    }
    return {
      id: requiredString(row.id, "revision.id"),
      projectId: requiredString(row.project_id, "revision.project_id"),
      contentHash: requiredHash(row.content_hash, "revision.content_hash"),
      document: modelDocumentSchema.parse(parseJsonObject(row.document))
    };
  }

  async loadSourceArtifact(
    job: LeasedModelingJob,
    artifactId: string
  ): Promise<ModelingSourceArtifact> {
    const [row] = await this.sql.unsafe(
      `
        SELECT
          artifact.id,
          artifact.project_id,
          artifact.revision_id,
          artifact.filename,
          artifact.mime_type,
          artifact.object_key,
          artifact.checksum_sha256,
          artifact.size_bytes
        FROM modeling_artifact artifact
        JOIN modeling_project project
          ON project.id = artifact.project_id
          AND project.owner_id = $5
        JOIN modeling_job job
          ON job.id = $1
          AND job.project_id = artifact.project_id
        WHERE
          artifact.id = $2::uuid
          AND artifact.kind = 'source'
          AND artifact.expires_at IS NULL
          AND job.lease_owner = $3
          AND job.lease_token = $4
          AND job.status IN (${ACTIVE_STATUSES})
        LIMIT 1
      `,
      [job.id, artifactId, job.workerId, job.leaseToken, job.ownerId]
    );
    if (!row) {
      throw new ModelingWorkerError(
        "IMPORT_SOURCE_NOT_FOUND",
        "未找到当前用户可访问的 STEP 私有源制品。"
      );
    }
    const sizeBytes = Number(row.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_SOURCE",
        "STEP 私有源制品大小无效。"
      );
    }
    return {
      id: requiredString(row.id, "artifact.id"),
      projectId: requiredString(row.project_id, "artifact.project_id"),
      revisionId: optionalString(row.revision_id),
      filename: requiredString(row.filename, "artifact.filename"),
      mimeType: requiredString(row.mime_type, "artifact.mime_type"),
      objectKey: requiredString(row.object_key, "artifact.object_key"),
      checksumSha256: requiredHash(
        row.checksum_sha256,
        "artifact.checksum_sha256"
      ),
      sizeBytes
    };
  }

  async loadExistingAiPlan(
    job: LeasedModelingJob
  ): Promise<StoredAiPlanSnapshot | null> {
    if (job.kind !== "ai_plan") {
      throw new ModelingWorkerError(
        "INVALID_AI_PLAN_JOB",
        "只有 AI 计划任务可以恢复已生成的计划。"
      );
    }
    return this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        throw new ModelingCancellationRequestedError(job.id);
      }
      const [row] = await transaction.unsafe(
        `
          SELECT plan.id,
                 plan.project_id,
                 plan.base_revision_id,
                 plan.base_revision_hash,
                 plan.plan_hash,
                 plan.prompt,
                 plan.draft,
                 plan.status,
                 plan.missing_inputs
          FROM modeling_plan plan
          JOIN modeling_project project
            ON project.id = plan.project_id
           AND project.owner_id = $3
          WHERE plan.project_id = $1::uuid
            AND plan.idempotency_key = $2
          LIMIT 1
        `,
        [job.projectId, job.idempotencyKey, job.ownerId]
      );
      return row ? parseStoredAiPlan(row) : null;
    });
  }

  async completeAiPlan(
    job: LeasedModelingJob,
    input: CompleteAiPlanInput
  ): Promise<CompleteAiPlanResult> {
    if (job.kind !== "ai_plan" || !job.revisionId) {
      throw new ModelingWorkerError(
        "INVALID_AI_PLAN_JOB",
        "AI 计划任务缺少合法基础版本。"
      );
    }
    const draft = modelingPlanDraftSchema.parse(input.draft);
    if (
      !/^[a-f0-9]{64}$/u.test(input.baseRevisionHash) ||
      !["needs_input", "validated"].includes(draft.status) ||
      draft.baseRevisionId !== job.revisionId ||
      hashModelingPlanDraft(draft) !== draft.planHash ||
      input.artifacts.some(
        (artifact) => artifact.kind !== "preview" || artifact.expiresAt === null
      )
    ) {
      throw new ModelingWorkerError(
        "INVALID_GENERATED_PLAN",
        "AI 计划、基础版本或预览制品未通过原子提交校验。"
      );
    }

    return this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        await writeCancelled(transaction, job, "用户已请求取消任务。");
        return { status: "cancelled", artifactIds: [] };
      }
      const [project] = await transaction.unsafe(
        `
          SELECT current_revision_id
          FROM modeling_project
          WHERE id = $1::uuid AND owner_id = $2
          FOR UPDATE
        `,
        [job.projectId, job.ownerId]
      );
      if (!project) {
        throw new ModelingWorkerError(
          "PROJECT_NOT_FOUND",
          "AI 计划对应的建模项目已经不存在。"
        );
      }
      const [base] = await transaction.unsafe(
        `
          SELECT content_hash, document
          FROM modeling_revision
          WHERE id = $1::uuid AND project_id = $2::uuid
          FOR KEY SHARE
        `,
        [job.revisionId, job.projectId]
      );
      if (
        !base ||
        base.content_hash !== input.baseRevisionHash ||
        modelDocumentSchema.parse(parseJsonObject(base.document)).id !==
          draft.documentId
      ) {
        throw new ModelingWorkerError(
          "STALE_PLAN_BASE",
          "AI 计划的不可变基础版本校验失败。"
        );
      }

      const [existingRow] = await transaction.unsafe(
        `
          SELECT id, project_id, base_revision_id, base_revision_hash,
                 plan_hash, prompt, draft, status, missing_inputs
          FROM modeling_plan
          WHERE project_id = $1::uuid AND idempotency_key = $2
          FOR UPDATE
        `,
        [job.projectId, job.idempotencyKey]
      );
      let plan: StoredAiPlanSnapshot;
      let replayed = false;
      if (existingRow) {
        plan = parseStoredAiPlan(existingRow);
        if (
          plan.baseRevisionId !== job.revisionId ||
          plan.baseRevisionHash !== input.baseRevisionHash ||
          plan.prompt !== input.prompt ||
          plan.planHash !== draft.planHash
        ) {
          throw new ModelingWorkerError(
            "AI_PLAN_REPLAY_CONFLICT",
            "已持久化的 AI 计划与恢复任务不一致。"
          );
        }
        replayed = true;
      } else {
        const stale = project.current_revision_id !== job.revisionId;
        const [inserted] = await transaction.unsafe(
          `
            INSERT INTO modeling_plan (
              project_id, base_revision_id, base_revision_hash, plan_hash,
              prompt, draft, operations, missing_inputs, status,
              idempotency_key, created_by_user_id, decided_at
            )
            VALUES (
              $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb,
              $8::jsonb, $9::modeling_plan_status, $10, $11,
              CASE WHEN $9 = 'stale' THEN NOW() ELSE NULL END
            )
            RETURNING id, project_id, base_revision_id, base_revision_hash,
                      plan_hash, prompt, draft, status, missing_inputs
          `,
          [
            job.projectId,
            job.revisionId,
            input.baseRevisionHash,
            draft.planHash,
            input.prompt,
            JSON.stringify(draft),
            JSON.stringify(draft.operationBatch?.operations ?? []),
            JSON.stringify(stale ? [] : draft.missingInputs),
            stale ? "stale" : draft.status,
            job.idempotencyKey,
            job.ownerId
          ]
        );
        if (!inserted) {
          throw new ModelingWorkerError(
            "AI_PLAN_STORE_FAILED",
            "无法原子保存 AI 建模计划。"
          );
        }
        plan = parseStoredAiPlan(inserted);
      }

      const artifactIds = await insertArtifacts(
        transaction,
        job,
        job.revisionId,
        input.artifacts
      );
      const completedOutput = {
        planId: plan.id,
        planHash: plan.planHash,
        planStatus: plan.status,
        missingInputs: plan.missingInputs,
        replayed,
        dryRun: input.dryRun,
        artifactIds
      };
      const [updated] = await transaction.unsafe(
        `
          UPDATE modeling_job
          SET status = 'succeeded',
              progress = 100,
              plan_id = $4::uuid,
              output = $5::jsonb,
              completed_at = NOW(),
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
            AND lease_owner = $2
            AND lease_token = $3
          RETURNING id
        `,
        [
          job.id,
          job.workerId,
          job.leaseToken,
          plan.id,
          JSON.stringify(completedOutput)
        ]
      );
      if (!updated) {
        throw new StaleModelingLeaseError(job.id);
      }
      await appendEvent(transaction, job.id, "succeeded", {
        progress: 100,
        planId: plan.id,
        artifactIds,
        replayed
      });
      return {
        status: "succeeded",
        artifactIds,
        planId: plan.id,
        replayed
      };
    });
  }

  async complete(
    job: LeasedModelingJob,
    output: Record<string, unknown>,
    artifacts: PendingModelingArtifact[] = []
  ): Promise<CompleteJobResult> {
    return this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        await writeCancelled(transaction, job, "用户已请求取消任务。");
        return { status: "cancelled", artifactIds: [] };
      }

      const artifactIds = await insertArtifacts(
        transaction,
        job,
        job.revisionId,
        artifacts
      );

      const completedOutput = { ...output, artifactIds };
      const [updated] = await transaction.unsafe(
        `
          UPDATE modeling_job
          SET
            status = 'succeeded',
            progress = 100,
            output = $4::jsonb,
            completed_at = NOW(),
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND lease_owner = $2
            AND lease_token = $3
          RETURNING id
        `,
        [job.id, job.workerId, job.leaseToken, JSON.stringify(completedOutput)]
      );
      if (!updated) {
        throw new StaleModelingLeaseError(job.id);
      }
      await appendEvent(transaction, job.id, "succeeded", {
        progress: 100,
        artifactIds
      });
      return { status: "succeeded", artifactIds };
    });
  }

  async completeImport(
    job: LeasedModelingJob,
    input: CompleteImportInput
  ): Promise<CompleteImportResult> {
    if (job.kind !== "import" || !job.revisionId) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_JOB",
        "STEP 导入任务缺少合法基础版本。"
      );
    }
    const document = modelDocumentSchema.parse(input.document);
    if (!/^[a-f0-9]{64}$/u.test(input.contentHash)) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_HASH",
        "STEP 导入版本哈希无效。"
      );
    }
    if (
      input.sourceArtifact.kind !== "source" ||
      input.sourceArtifact.expiresAt !== null ||
      input.previewArtifacts.some((artifact) => artifact.kind !== "preview")
    ) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_ARTIFACT",
        "STEP 导入制品保留策略无效。"
      );
    }

    return this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        await writeCancelled(transaction, job, "用户已请求取消任务。");
        return { status: "cancelled", artifactIds: [] };
      }
      const [project] = await transaction.unsafe(
        `
          SELECT current_revision_id
          FROM modeling_project
          WHERE id = $1::uuid AND owner_id = $2
          FOR UPDATE
        `,
        [job.projectId, job.ownerId]
      );
      if (!project) {
        throw new ModelingWorkerError(
          "PROJECT_NOT_FOUND",
          "STEP 导入对应的建模项目已经不存在。"
        );
      }
      if (project.current_revision_id !== job.revisionId) {
        throw new ModelingWorkerError(
          "STALE_IMPORT_BASE",
          "STEP 导入期间项目版本已变化，未覆盖当前版本。"
        );
      }
      const [base] = await transaction.unsafe(
        `
          SELECT revision_number, document
          FROM modeling_revision
          WHERE id = $1::uuid AND project_id = $2::uuid
          FOR UPDATE
        `,
        [job.revisionId, job.projectId]
      );
      if (!base) {
        throw new ModelingWorkerError(
          "IMPORT_BASE_NOT_FOUND",
          "STEP 导入基础版本已经不存在。"
        );
      }
      const baseDocument = modelDocumentSchema.parse(
        parseJsonObject(base.document)
      );
      const revisionNumber = Number(base.revision_number);
      if (
        document.id !== baseDocument.id ||
        document.revisionId === job.revisionId ||
        document.revision !== revisionNumber
      ) {
        throw new ModelingWorkerError(
          "INVALID_IMPORT_REVISION",
          "STEP 导入生成的版本链无效。"
        );
      }

      const [revision] = await transaction.unsafe(
        `
          INSERT INTO modeling_revision (
            id,
            project_id,
            parent_revision_id,
            revision_number,
            source,
            idempotency_key,
            document,
            operations,
            content_hash,
            created_by_user_id
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            'import',
            $5,
            $6::jsonb,
            $7::jsonb,
            $8,
            $9
          )
          RETURNING id
        `,
        [
          document.revisionId,
          job.projectId,
          job.revisionId,
          revisionNumber + 1,
          `import-job:${job.id}`,
          JSON.stringify(document),
          JSON.stringify(input.operations),
          input.contentHash,
          job.ownerId
        ]
      );
      if (!revision) {
        throw new ModelingWorkerError(
          "IMPORT_REVISION_FAILED",
          "无法保存 STEP 基础实体版本。"
        );
      }

      const artifacts = [input.sourceArtifact, ...input.previewArtifacts];
      const artifactIds = await insertArtifacts(
        transaction,
        job,
        document.revisionId,
        artifacts
      );
      const [advanced] = await transaction.unsafe(
        `
          UPDATE modeling_project
          SET current_revision_id = $3::uuid, updated_at = NOW()
          WHERE id = $1::uuid
            AND owner_id = $2
            AND current_revision_id = $4::uuid
          RETURNING id
        `,
        [job.projectId, job.ownerId, document.revisionId, job.revisionId]
      );
      if (!advanced) {
        throw new ModelingWorkerError(
          "STALE_IMPORT_BASE",
          "STEP 导入提交时项目版本已变化，未覆盖当前版本。"
        );
      }

      const completedOutput = {
        ...input.output,
        revisionId: document.revisionId,
        artifactIds
      };
      const [updated] = await transaction.unsafe(
        `
          UPDATE modeling_job
          SET
            status = 'succeeded',
            progress = 100,
            output = $4::jsonb,
            completed_at = NOW(),
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND lease_owner = $2
            AND lease_token = $3
          RETURNING id
        `,
        [job.id, job.workerId, job.leaseToken, JSON.stringify(completedOutput)]
      );
      if (!updated) {
        throw new StaleModelingLeaseError(job.id);
      }
      await appendEvent(transaction, job.id, "succeeded", {
        progress: 100,
        revisionId: document.revisionId,
        artifactIds
      });
      return {
        status: "succeeded",
        artifactIds,
        revisionId: document.revisionId
      };
    });
  }

  async markCancelled(job: LeasedModelingJob, reason: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await assertCurrentLease(transaction, job);
      await writeCancelled(transaction, job, reason);
    });
  }

  async markFailed(
    job: LeasedModelingJob,
    error: Error
  ): Promise<"failed" | "cancelled"> {
    return this.sql.begin(async (transaction) => {
      const current = await assertCurrentLease(transaction, job);
      if (current.cancelRequestedAt) {
        await writeCancelled(transaction, job, "用户已请求取消任务。");
        return "cancelled";
      }

      const code = errorCode(error);
      const message = safeErrorMessage(error);
      const [updated] = await transaction.unsafe(
        `
          UPDATE modeling_job
          SET
            status = 'failed',
            completed_at = NOW(),
            error_code = $4,
            error_message = $5,
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND lease_owner = $2
            AND lease_token = $3
          RETURNING id
        `,
        [job.id, job.workerId, job.leaseToken, code, message]
      );
      if (!updated) {
        throw new StaleModelingLeaseError(job.id);
      }
      await appendEvent(transaction, job.id, "failed", { code, message });
      return "failed";
    });
  }
}

async function insertArtifacts(
  transaction: WorkerSql,
  job: LeasedModelingJob,
  revisionId: string | null,
  artifacts: PendingModelingArtifact[]
): Promise<string[]> {
  const artifactIds: string[] = [];
  for (const artifact of artifacts) {
    const [inserted] = await transaction.unsafe(
      `
        INSERT INTO modeling_artifact (
          id,
          project_id,
          job_id,
          revision_id,
          kind,
          filename,
          mime_type,
          object_key,
          checksum_sha256,
          size_bytes,
          expires_at,
          metadata,
          created_by_user_id
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,
          $5::modeling_artifact_kind,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          $13
        )
        ON CONFLICT (object_key) DO NOTHING
        RETURNING id, job_id, checksum_sha256, size_bytes
      `,
      [
        artifact.id,
        job.projectId,
        job.id,
        revisionId,
        artifact.kind,
        artifact.filename,
        artifact.mimeType,
        artifact.objectKey,
        artifact.checksumSha256,
        artifact.sizeBytes,
        artifact.expiresAt,
        JSON.stringify(artifact.metadata),
        job.ownerId
      ]
    );
    const stored =
      inserted ??
      (
        await transaction.unsafe(
          `
            SELECT id, job_id, checksum_sha256, size_bytes
            FROM modeling_artifact
            WHERE object_key = $1
            LIMIT 1
          `,
          [artifact.objectKey]
        )
      )[0];
    if (
      !stored ||
      stored.job_id !== job.id ||
      stored.checksum_sha256 !== artifact.checksumSha256 ||
      Number(stored.size_bytes) !== artifact.sizeBytes
    ) {
      throw new ModelingWorkerError(
        "ARTIFACT_CONFLICT",
        "建模制品对象键与已有记录冲突。"
      );
    }
    artifactIds.push(requiredString(stored.id, "artifact.id"));
  }
  return artifactIds;
}

async function assertCurrentLease(
  transaction: WorkerSql,
  job: LeasedModelingJob
): Promise<{ cancelRequestedAt: Date | null }> {
  const [row] = await transaction.unsafe(
    `
      SELECT cancel_requested_at
      FROM modeling_job
      WHERE id = $1
        AND lease_owner = $2
        AND lease_token = $3
        AND status IN (${ACTIVE_STATUSES})
      FOR UPDATE
    `,
    [job.id, job.workerId, job.leaseToken]
  );
  if (!row) {
    throw new StaleModelingLeaseError(job.id);
  }
  return { cancelRequestedAt: optionalDate(row.cancel_requested_at) };
}

async function appendEvent(
  transaction: WorkerSql,
  jobId: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const [counter] = await transaction.unsafe(
    `
      SELECT COALESCE(MAX(sequence), 0)::bigint AS sequence
      FROM modeling_job_event
      WHERE job_id = $1
    `,
    [jobId]
  );
  const sequence = Number(counter?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new ModelingWorkerError(
      "EVENT_SEQUENCE_EXHAUSTED",
      "建模任务事件序号超出安全范围。"
    );
  }
  await transaction.unsafe(
    `
      INSERT INTO modeling_job_event (job_id, sequence, type, data)
      VALUES ($1::uuid, $2, $3, $4::jsonb)
    `,
    [jobId, sequence, type, JSON.stringify(data)]
  );
}

async function writeCancelled(
  transaction: WorkerSql,
  job: LeasedModelingJob,
  reason: string
): Promise<void> {
  const [updated] = await transaction.unsafe(
    `
      UPDATE modeling_job
      SET
        status = 'cancelled',
        completed_at = NOW(),
        error_code = NULL,
        error_message = NULL,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND lease_owner = $2
        AND lease_token = $3
      RETURNING id
    `,
    [job.id, job.workerId, job.leaseToken]
  );
  if (!updated) {
    throw new StaleModelingLeaseError(job.id);
  }
  await appendEvent(transaction, job.id, "cancelled", {
    progress: job.progress,
    reason: reason.slice(0, 500)
  });
}

function parseLeasedJob(row: Record<string, unknown>): LeasedModelingJob {
  const previousStatus = requiredString(row.previous_status, "previous_status");
  const kind = requiredString(row.kind, "kind");
  if (!isModelingJobKind(kind)) {
    throw new TypeError(`Unsupported modeling job kind: ${kind}`);
  }
  const progress = Number(row.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new TypeError("Modeling job progress is invalid.");
  }
  return {
    id: requiredString(row.id, "job.id"),
    projectId: requiredString(row.project_id, "job.project_id"),
    revisionId: optionalString(row.revision_id),
    planId: optionalString(row.plan_id),
    ownerId: requiredString(row.owner_id, "job.owner_id"),
    kind,
    input: parseJsonObject(row.input),
    idempotencyKey: requiredString(row.idempotency_key, "job.idempotency_key"),
    progress,
    workerId: requiredString(row.lease_owner, "job.lease_owner"),
    leaseToken: requiredString(row.lease_token, "job.lease_token"),
    leaseExpiresAt: requiredDate(row.lease_expires_at, "job.lease_expires_at"),
    cancelRequestedAt: optionalDate(row.cancel_requested_at),
    recovered: previousStatus !== "queued"
  };
}

function parseArtifactCleanupLease(
  row: Record<string, unknown>
): LeasedArtifactCleanup {
  const kind = requiredString(row.kind, "artifact.kind");
  if (kind !== "preview" && kind !== "export") {
    throw new TypeError(`Unsupported expiring artifact kind: ${kind}`);
  }
  const attempts = Number(row.cleanup_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("artifact.cleanup_attempts must be positive.");
  }
  return {
    id: requiredString(row.id, "artifact.id"),
    projectId: requiredString(row.project_id, "artifact.project_id"),
    kind,
    objectKey: requiredString(row.object_key, "artifact.object_key"),
    leaseOwner: requiredString(
      row.cleanup_lease_owner,
      "artifact.cleanup_lease_owner"
    ),
    leaseToken: requiredString(
      row.cleanup_lease_token,
      "artifact.cleanup_lease_token"
    ),
    leaseExpiresAt: requiredDate(
      row.cleanup_lease_expires_at,
      "artifact.cleanup_lease_expires_at"
    ),
    attempts
  };
}

function parseStoredAiPlan(row: Record<string, unknown>): StoredAiPlanSnapshot {
  const status = requiredString(row.status, "plan.status");
  if (
    !["needs_input", "validated", "confirmed", "rejected", "stale"].includes(
      status
    )
  ) {
    throw new TypeError(`Unsupported AI plan status: ${status}`);
  }
  const draft = modelingPlanDraftSchema.parse(parseJsonObject(row.draft));
  const planHash = requiredHash(row.plan_hash, "plan.plan_hash");
  if (draft.planHash !== planHash) {
    throw new TypeError("Persisted AI plan draft hash does not match its row.");
  }
  return {
    id: requiredString(row.id, "plan.id"),
    projectId: requiredString(row.project_id, "plan.project_id"),
    baseRevisionId: requiredString(
      row.base_revision_id,
      "plan.base_revision_id"
    ),
    baseRevisionHash: requiredHash(
      row.base_revision_hash,
      "plan.base_revision_hash"
    ),
    planHash,
    prompt: requiredString(row.prompt, "plan.prompt"),
    draft,
    status: status as StoredAiPlanSnapshot["status"],
    missingInputs: parseStringArray(row.missing_inputs, "plan.missing_inputs")
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new TypeError(`${label} must be a string array.`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requiredHash(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new TypeError(`${label} must be a SHA-256 hash.`);
  }
  return result;
}

function requiredDate(value: unknown, label: string): Date {
  const result = optionalDate(value);
  if (!result) {
    throw new TypeError(`${label} must be a date.`);
  }
  return result;
}

function optionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(result.getTime()) ? null : result;
}

function isModelingJobKind(value: string): value is ModelingJobKind {
  return [
    "ai_plan",
    "import",
    "build",
    "preview",
    "conversion",
    "export"
  ].includes(value);
}

function millisecondsToSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000) {
    throw new TypeError("leaseMs must be at least 1000 milliseconds.");
  }
  return Math.ceil(value / 1_000);
}

function positiveMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function boundedPercentage(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new TypeError("Active job progress must be an integer from 0 to 99.");
  }
  return value;
}

function errorCode(error: Error): string {
  return error instanceof ModelingWorkerError ? error.code : "WORKER_FAILURE";
}

function safeErrorMessage(error: Error): string {
  const message = error.message.trim() || "建模任务执行失败。";
  return message.slice(0, 1_000);
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown modeling worker failure", { cause: value });
}
