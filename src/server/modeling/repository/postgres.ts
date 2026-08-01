import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import {
  hashCanonicalSpec,
  hashModelingPlanDraft
} from "@/lib/modeling/protocol";
import { db, sqlClient } from "@/server/db";
import {
  modelingArtifact,
  modelingImportIntent,
  modelingJob,
  modelingJobEvent,
  modelingPlan,
  modelingProject,
  modelingRevision,
  modelingValidationAttempt
} from "@/server/db/schema";

import {
  IdempotencyConflictError,
  ModelingLimitError,
  PlanConflictError,
  StalePlanError,
  StaleRevisionError,
  ValidationAttemptInProgressError,
  ValidationAttemptStateError
} from "./errors";
import type {
  BeginValidationAttemptInput,
  BeginValidationAttemptResult,
  CancelJobResult,
  CommitOperationInput,
  CompleteValidationAttemptInput,
  ConfirmPlanInput,
  CompleteStepUploadIntentInput,
  CreateAiPlanJobInput,
  CreateModelingJobInput,
  CreateProjectInput,
  ModelingArtifactRow,
  ModelingImportIntentRow,
  ModelingJobEventRow,
  ModelingJobRow,
  ModelingPlanRow,
  ModelingProjectRow,
  ModelingRepository,
  ModelingRevisionRow,
  PageResult,
  ProjectDetail,
  ReplayResult,
  ReserveStepUploadIntentInput,
  StoreGeneratedPlanInput,
  UpdateProjectInput
} from "./types";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Transaction;
const MODELING_QUEUE_ADVISORY_LOCK = 739_197_422;

type ValidationAttemptSqlRow = Record<string, unknown>;

export interface ValidationAttemptSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<ValidationAttemptSqlRow[]>;
  begin<T>(
    handler: (transaction: ValidationAttemptSql) => Promise<T>
  ): Promise<T>;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return hashCanonicalSpec(left) === hashCanonicalSpec(right);
}

async function ownedProject(
  database: Database,
  ownerId: string,
  projectId: string,
  lock = false
): Promise<ModelingProjectRow | null> {
  const query = database
    .select()
    .from(modelingProject)
    .where(
      and(
        eq(modelingProject.id, projectId),
        eq(modelingProject.ownerId, ownerId)
      )
    );
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function projectDetail(
  database: Database,
  project: ModelingProjectRow
): Promise<ProjectDetail> {
  const currentRevision = project.currentRevisionId
    ? ((
        await database
          .select()
          .from(modelingRevision)
          .where(
            and(
              eq(modelingRevision.id, project.currentRevisionId),
              eq(modelingRevision.projectId, project.id)
            )
          )
      )[0] ?? null)
    : null;
  return { ...project, currentRevision };
}

async function revisionByIdempotency(
  database: Database,
  ownerId: string,
  projectId: string,
  idempotencyKey: string
): Promise<ModelingRevisionRow | null> {
  const [result] = await database
    .select({ revision: modelingRevision })
    .from(modelingRevision)
    .innerJoin(
      modelingProject,
      and(
        eq(modelingProject.id, modelingRevision.projectId),
        eq(modelingProject.ownerId, ownerId)
      )
    )
    .where(
      and(
        eq(modelingRevision.projectId, projectId),
        eq(modelingRevision.idempotencyKey, idempotencyKey)
      )
    );
  return result?.revision ?? null;
}

async function ownedPlan(
  database: Database,
  ownerId: string,
  planId: string
): Promise<ModelingPlanRow | null> {
  const [result] = await database
    .select({ plan: modelingPlan })
    .from(modelingPlan)
    .innerJoin(
      modelingProject,
      and(
        eq(modelingProject.id, modelingPlan.projectId),
        eq(modelingProject.ownerId, ownerId)
      )
    )
    .where(eq(modelingPlan.id, planId));
  return result?.plan ?? null;
}

async function ownedJob(
  database: Database,
  ownerId: string,
  jobId: string,
  lock = false
): Promise<ModelingJobRow | null> {
  const query = database
    .select({ job: modelingJob })
    .from(modelingJob)
    .innerJoin(
      modelingProject,
      and(
        eq(modelingProject.id, modelingJob.projectId),
        eq(modelingProject.ownerId, ownerId)
      )
    )
    .where(eq(modelingJob.id, jobId));
  const rows = lock ? await query.for("update") : await query;
  return rows[0]?.job ?? null;
}

async function appendJobEvent(
  transaction: Transaction,
  jobId: string,
  type: string,
  data: Record<string, unknown>
): Promise<ModelingJobEventRow> {
  // Callers lock the job first. That lock serializes sequence allocation for a
  // job, while the unique index remains the final monotonicity guard.
  const [counter] = await transaction
    .select({
      sequence: sql<number>`coalesce(max(${modelingJobEvent.sequence}), 0)::bigint`
    })
    .from(modelingJobEvent)
    .where(eq(modelingJobEvent.jobId, jobId));
  const nextSequence = Number(counter?.sequence ?? 0) + 1;
  const [event] = await transaction
    .insert(modelingJobEvent)
    .values({ jobId, sequence: nextSequence, type, data })
    .returning();
  if (!event) {
    throw new Error("Unable to append modeling job event");
  }
  return event;
}

function positiveIntegerSetting(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function assertQueueLimits(
  transaction: Transaction,
  ownerId: string,
  kind: ModelingJobRow["kind"]
): Promise<void> {
  const jobReservationMs = positiveIntegerSetting(
    "MODELING_JOB_TIMEOUT_MS",
    180_000
  );
  await transaction.execute(
    sql`select pg_advisory_xact_lock(${MODELING_QUEUE_ADVISORY_LOCK})`
  );
  const [counts] = await transaction
    .select({
      globalQueued: sql<number>`count(*) filter (where ${modelingJob.status} = 'queued')::int`,
      userQueued: sql<number>`count(*) filter (where ${modelingProject.ownerId} = ${ownerId} and ${modelingJob.status} = 'queued')::int`,
      userRunning: sql<number>`count(*) filter (where ${modelingProject.ownerId} = ${ownerId} and ${modelingJob.status} in ('running', 'validating', 'meshing', 'exporting'))::int`,
      globalActive: sql<number>`count(*) filter (where ${modelingJob.status} in ('queued', 'running', 'validating', 'meshing', 'exporting'))::int`,
      userActive: sql<number>`count(*) filter (where ${modelingProject.ownerId} = ${ownerId} and ${modelingJob.status} in ('queued', 'running', 'validating', 'meshing', 'exporting'))::int`,
      dailyExports: sql<number>`count(*) filter (where ${modelingProject.ownerId} = ${ownerId} and ${modelingJob.kind} = 'export' and ${modelingJob.createdAt} >= date_trunc('day', now()))::int`,
      dailyComputeMs: sql<number>`coalesce(sum(case when ${modelingProject.ownerId} = ${ownerId} and ${modelingJob.createdAt} >= date_trunc('day', now()) then case when ${modelingJob.status} in ('queued', 'running', 'validating', 'meshing', 'exporting') then ${jobReservationMs}::double precision when (${modelingJob.output}->>'durationMs') ~ '^[0-9]+(\\.[0-9]+)?$' then (${modelingJob.output}->>'durationMs')::double precision when (${modelingJob.output}#>>'{dryRun,durationMs}') ~ '^[0-9]+(\\.[0-9]+)?$' then (${modelingJob.output}#>>'{dryRun,durationMs}')::double precision when ${modelingJob.startedAt} is not null and ${modelingJob.completedAt} is not null then greatest(0, extract(epoch from (${modelingJob.completedAt} - ${modelingJob.startedAt})) * 1000) else 0 end else 0 end), 0)::double precision`
    })
    .from(modelingJob)
    .innerJoin(modelingProject, eq(modelingProject.id, modelingJob.projectId));
  const [validationUsage] = await transaction
    .select({
      globalActive: sql<number>`count(*) filter (where ${modelingValidationAttempt.status} = 'reserved' and ${modelingValidationAttempt.reservationExpiresAt} > now())::int`,
      userActive: sql<number>`count(*) filter (where ${modelingValidationAttempt.ownerId} = ${ownerId} and ${modelingValidationAttempt.status} = 'reserved' and ${modelingValidationAttempt.reservationExpiresAt} > now())::int`,
      dailyComputeMs: sql<number>`coalesce(sum(case when ${modelingValidationAttempt.ownerId} = ${ownerId} and ${modelingValidationAttempt.createdAt} >= date_trunc('day', now()) then case when ${modelingValidationAttempt.status} = 'reserved' then ${modelingValidationAttempt.consumedComputeMs} + ${modelingValidationAttempt.reservedComputeMs} else coalesce(${modelingValidationAttempt.actualDurationMs}, 0) end else 0 end), 0)::bigint`
    })
    .from(modelingValidationAttempt);

  const globalRunningLimit = positiveIntegerSetting(
    "MODELING_GLOBAL_CONCURRENCY",
    1
  );
  const globalCapacity = positiveIntegerSetting("MODELING_QUEUE_CAPACITY", 20);
  const userQueueLimit = positiveIntegerSetting("MODELING_MAX_USER_QUEUED", 2);
  const userRunningLimit = positiveIntegerSetting(
    "MODELING_MAX_USER_RUNNING",
    1
  );
  const dailyExportLimit = positiveIntegerSetting(
    "MODELING_DAILY_EXPORT_LIMIT",
    10
  );
  const dailyComputeSeconds = positiveIntegerSetting(
    "MODELING_DAILY_COMPUTE_SECONDS",
    1_200
  );
  const globalActive =
    Number(counts?.globalActive ?? 0) +
    Number(validationUsage?.globalActive ?? 0);
  const userActive =
    Number(counts?.userActive ?? 0) + Number(validationUsage?.userActive ?? 0);
  if (globalActive >= globalRunningLimit + globalCapacity) {
    throw new ModelingLimitError(
      "MODELING_QUEUE_FULL",
      "建模队列已满，请稍后重试。",
      {
        limit: globalRunningLimit + globalCapacity,
        runningLimit: globalRunningLimit,
        queueLimit: globalCapacity
      }
    );
  }
  if (userActive >= userRunningLimit + userQueueLimit) {
    throw new ModelingLimitError(
      "MODELING_USER_QUEUE_LIMIT",
      "当前账号已有过多等待或运行中的建模任务。",
      {
        limit: userRunningLimit + userQueueLimit,
        runningLimit: userRunningLimit,
        queueLimit: userQueueLimit
      }
    );
  }
  if (Number(counts?.globalQueued ?? 0) >= globalCapacity) {
    throw new ModelingLimitError(
      "MODELING_QUEUE_FULL",
      "建模队列已满，请稍后重试。",
      { limit: globalCapacity }
    );
  }
  if (Number(counts?.userQueued ?? 0) >= userQueueLimit) {
    throw new ModelingLimitError(
      "MODELING_USER_QUEUE_LIMIT",
      "当前账号已有过多排队中的建模任务。",
      { limit: userQueueLimit }
    );
  }
  if (Number(counts?.userRunning ?? 0) > userRunningLimit) {
    throw new ModelingLimitError(
      "MODELING_USER_RUNNING_LIMIT",
      "当前账号的建模任务并发已达到上限。",
      { limit: userRunningLimit }
    );
  }
  if (
    kind === "export" &&
    Number(counts?.dailyExports ?? 0) >= dailyExportLimit
  ) {
    throw new ModelingLimitError(
      "MODELING_DAILY_EXPORT_LIMIT",
      "今天的重型导出次数已用完。",
      { limit: dailyExportLimit }
    );
  }
  if (
    Number(counts?.dailyComputeMs ?? 0) +
      Number(validationUsage?.dailyComputeMs ?? 0) +
      jobReservationMs >
    dailyComputeSeconds * 1_000
  ) {
    throw new ModelingLimitError(
      "MODELING_DAILY_COMPUTE_LIMIT",
      "今天的建模内核计算预算已用完。",
      {
        limitSeconds: dailyComputeSeconds,
        usedMilliseconds:
          Number(counts?.dailyComputeMs ?? 0) +
          Number(validationUsage?.dailyComputeMs ?? 0),
        reservedMilliseconds: jobReservationMs
      }
    );
  }
}

function assertProjectReplay(
  project: ProjectDetail,
  input: CreateProjectInput
): void {
  if (
    project.name !== input.name ||
    (project.description ?? null) !== (input.description ?? null) ||
    !project.currentRevision ||
    project.currentRevision.contentHash !== hashCanonicalSpec(input.document) ||
    !sameJson(project.currentRevision.document, input.document)
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
}

function assertRevisionReplay(
  revision: ModelingRevisionRow,
  input: CommitOperationInput
): void {
  if (
    revision.parentRevisionId !== input.baseRevisionId ||
    revision.contentHash !== input.contentHash ||
    !sameJson(revision.operations, input.operations) ||
    !sameJson(revision.document, input.document)
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
}

function assertJobReplay(
  job: ModelingJobRow,
  input: CreateAiPlanJobInput
): void {
  if (
    job.kind !== "ai_plan" ||
    job.input.baseRevisionId !== input.baseRevisionId ||
    job.input.prompt !== input.prompt ||
    !sameJson(
      job.input.selectedSemanticRefs ?? [],
      input.selectedSemanticRefs ?? []
    )
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
}

function assertGenericJobReplay(
  job: ModelingJobRow,
  input: CreateModelingJobInput
): void {
  if (
    job.kind !== input.kind ||
    job.revisionId !== input.revisionId ||
    !sameJson(job.input, input.input ?? {})
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
}

/** @internal Exported for contract-level tests. */
export function assertStepUploadIntentReplay(
  intent: ModelingImportIntentRow,
  input: ReserveStepUploadIntentInput
): void {
  if (
    intent.ownerId !== input.ownerId ||
    intent.projectId !== input.projectId ||
    intent.requestHash !== input.requestHash ||
    intent.objectKey !== input.objectKey ||
    intent.sourceName !== input.sourceName ||
    intent.mimeType !== input.mimeType ||
    intent.sizeBytes !== input.sizeBytes ||
    intent.checksumSha256 !== input.checksumSha256
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
}

function importJobInput(input: CompleteStepUploadIntentInput) {
  return {
    objectKey: input.objectKey,
    sourceName: input.sourceName,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    contentType: input.mimeType
  };
}

function assertStepUploadCompletion(
  intent: ModelingImportIntentRow,
  input: CompleteStepUploadIntentInput
): void {
  if (
    intent.ownerId !== input.ownerId ||
    intent.projectId !== input.projectId ||
    intent.objectKey !== input.objectKey ||
    intent.sourceName !== input.sourceName ||
    intent.mimeType !== input.mimeType ||
    intent.sizeBytes !== input.sizeBytes ||
    intent.checksumSha256 !== input.checksumSha256
  ) {
    throw new IdempotencyConflictError(input.completionIdempotencyKey);
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validationScope(input: BeginValidationAttemptInput): string {
  if (input.kind === "project_create") {
    if (input.projectId) {
      throw new Error("Project creation validation cannot have a project id");
    }
    return "account";
  }
  if (!input.projectId) {
    throw new Error("Operation validation requires a project id");
  }
  return input.projectId;
}

function replayedValidationAttempt(
  row: ValidationAttemptSqlRow
): BeginValidationAttemptResult {
  const attemptId = String(row.attemptId);
  const status = String(row.status);
  if (status === "reserved") {
    throw new ValidationAttemptInProgressError(attemptId);
  }
  if (status === "succeeded") {
    return {
      state: "succeeded",
      attemptId,
      kernelVersion:
        typeof row.kernelVersion === "string" ? row.kernelVersion : null
    };
  }
  if (status === "failed") {
    const details = optionalRecord(row.errorDetails);
    return {
      state: "failed",
      attemptId,
      failure: {
        status: Number(row.errorStatus ?? 503),
        code: String(row.errorCode ?? "CAD_KERNEL_UNAVAILABLE"),
        message: String(
          row.errorMessage ?? "确定性 CAD 内核校验未完成，请稍后重试。"
        ),
        ...(details ? { details } : {})
      }
    };
  }
  throw new ValidationAttemptStateError(attemptId);
}

export class PostgresModelingRepository implements ModelingRepository {
  constructor(
    private readonly validationSql: ValidationAttemptSql = sqlClient as unknown as ValidationAttemptSql
  ) {}

  async beginValidationAttempt(
    input: BeginValidationAttemptInput
  ): Promise<BeginValidationAttemptResult | null> {
    if (!/^[a-f0-9]{64}$/u.test(input.requestHash)) {
      throw new Error("Validation attempt request hash must be SHA-256");
    }
    const scopeKey = validationScope(input);
    const reservationMs = positiveIntegerSetting(
      "MODELING_INTERACTIVE_TIMEOUT_MS",
      30_000
    );
    const jobReservationMs = positiveIntegerSetting(
      "MODELING_JOB_TIMEOUT_MS",
      180_000
    );
    const globalRunningLimit = positiveIntegerSetting(
      "MODELING_GLOBAL_CONCURRENCY",
      1
    );
    const globalQueueLimit = positiveIntegerSetting(
      "MODELING_QUEUE_CAPACITY",
      20
    );
    const userRunningLimit = positiveIntegerSetting(
      "MODELING_MAX_USER_RUNNING",
      1
    );
    const userQueueLimit = positiveIntegerSetting(
      "MODELING_MAX_USER_QUEUED",
      2
    );
    const rateLimit = positiveIntegerSetting(
      "MODELING_OPERATION_RATE_PER_MINUTE",
      30
    );
    const dailyComputeMs =
      positiveIntegerSetting("MODELING_DAILY_COMPUTE_SECONDS", 1_200) * 1_000;
    const leaseToken = randomUUID();

    return this.validationSql.begin(async (transaction) => {
      if (input.projectId) {
        const owned = await transaction.unsafe(
          `select id
             from modeling_project
            where id = $1 and owner_id = $2
            for key share`,
          [input.projectId, input.ownerId]
        );
        if (!owned[0]) {
          return null;
        }
      }

      // Async job admission locks the project row before taking this global
      // lock. Keep the same ordering here so a validation and an enqueue for
      // the same project cannot form a row-lock/advisory-lock deadlock.
      await transaction.unsafe("select pg_advisory_xact_lock($1::bigint)", [
        MODELING_QUEUE_ADVISORY_LOCK
      ]);

      const existing = await transaction.unsafe(
        `select id as "attemptId",
                project_id as "projectId",
                request_hash as "requestHash",
                status,
                reserved_compute_ms as "reservedComputeMs",
                consumed_compute_ms as "consumedComputeMs",
                (reservation_expires_at <= now()) as "reservationExpired",
                kernel_version as "kernelVersion",
                error_status as "errorStatus",
                error_code as "errorCode",
                error_message as "errorMessage",
                error_details as "errorDetails"
           from modeling_validation_attempt
          where owner_id = $1
            and scope_key = $2
            and kind = $3
            and idempotency_key = $4
          for update`,
        [input.ownerId, scopeKey, input.kind, input.idempotencyKey]
      );
      let expiredReservation: ValidationAttemptSqlRow | undefined;
      if (existing[0]) {
        if (
          existing[0].requestHash !== input.requestHash ||
          (existing[0].projectId ?? null) !== (input.projectId ?? null)
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        if (existing[0].status !== "reserved") {
          return replayedValidationAttempt(existing[0]);
        }
        if (existing[0].reservationExpired !== true) {
          throw new ValidationAttemptInProgressError(
            String(existing[0].attemptId)
          );
        }
        expiredReservation = existing[0];
      }

      const [usage] = await transaction.unsafe(
        `select
           (select count(*)::int
              from modeling_validation_attempt
             where owner_id = $1
               and created_at >= now() - interval '1 minute') as "recentAttempts",
           ((select count(*)::int
               from modeling_job
              where status in ('queued', 'running', 'validating', 'meshing', 'exporting'))
            +
            (select count(*)::int
               from modeling_validation_attempt
              where status = 'reserved'
                and reservation_expires_at > now())) as "globalActive",
           ((select count(*)::int
               from modeling_job j
               join modeling_project p on p.id = j.project_id
              where p.owner_id = $1
                and j.status in ('queued', 'running', 'validating', 'meshing', 'exporting'))
            +
            (select count(*)::int
               from modeling_validation_attempt
              where owner_id = $1
                and status = 'reserved'
                and reservation_expires_at > now())) as "userActive",
           ((select coalesce(sum(
                     case when status = 'reserved'
                          then consumed_compute_ms + reserved_compute_ms
                          else coalesce(actual_duration_ms, 0)
                     end
                   ), 0)
               from modeling_validation_attempt
              where owner_id = $1
                and created_at >= date_trunc('day', now()))
            +
            (select coalesce(sum(
                     case
                       when j.status in ('queued', 'running', 'validating', 'meshing', 'exporting')
                         then $2::double precision
                       when (j.output->>'durationMs') ~ '^[0-9]+(\\.[0-9]+)?$'
                         then (j.output->>'durationMs')::double precision
                       when (j.output#>>'{dryRun,durationMs}') ~ '^[0-9]+(\\.[0-9]+)?$'
                         then (j.output#>>'{dryRun,durationMs}')::double precision
                       when j.started_at is not null and j.completed_at is not null
                         then greatest(0, extract(epoch from (j.completed_at - j.started_at)) * 1000)
                       else 0
                     end
                   ), 0)
               from modeling_job j
               join modeling_project p on p.id = j.project_id
              where p.owner_id = $1
                and j.created_at >= date_trunc('day', now()))) as "dailyComputeMs"`,
        [input.ownerId, jobReservationMs]
      );
      const recentAttempts = Number(usage?.recentAttempts ?? 0);
      const globalActive = Number(usage?.globalActive ?? 0);
      const userActive = Number(usage?.userActive ?? 0);
      const usedComputeMs = Number(usage?.dailyComputeMs ?? 0);
      if (globalActive >= globalRunningLimit + globalQueueLimit) {
        throw new ModelingLimitError(
          "MODELING_QUEUE_FULL",
          "建模队列已满，请稍后重试。",
          {
            limit: globalRunningLimit + globalQueueLimit,
            runningLimit: globalRunningLimit,
            queueLimit: globalQueueLimit
          }
        );
      }
      if (userActive >= userRunningLimit + userQueueLimit) {
        throw new ModelingLimitError(
          "MODELING_USER_QUEUE_LIMIT",
          "当前账号已有过多等待或运行中的建模任务。",
          {
            limit: userRunningLimit + userQueueLimit,
            runningLimit: userRunningLimit,
            queueLimit: userQueueLimit
          }
        );
      }
      if (!expiredReservation && recentAttempts >= rateLimit) {
        throw new ModelingLimitError(
          "MODELING_OPERATION_RATE_LIMIT",
          "手工建模操作过于频繁，请稍后继续。",
          { limitPerMinute: rateLimit }
        );
      }
      if (usedComputeMs + reservationMs > dailyComputeMs) {
        throw new ModelingLimitError(
          "MODELING_DAILY_COMPUTE_LIMIT",
          "今天的建模内核计算预算不足以开始本次校验。",
          {
            limitSeconds: dailyComputeMs / 1_000,
            usedMilliseconds: usedComputeMs,
            reservedMilliseconds: reservationMs
          }
        );
      }

      if (expiredReservation) {
        const reclaimed = await transaction.unsafe(
          `update modeling_validation_attempt
              set lease_token = $2,
                  consumed_compute_ms = consumed_compute_ms + reserved_compute_ms,
                  reserved_compute_ms = $3::integer,
                  reservation_expires_at = now() + ($3::integer * interval '1 millisecond')
            where id = $1
              and status = 'reserved'
              and reservation_expires_at <= now()
          returning id as "attemptId"`,
          [expiredReservation.attemptId, leaseToken, reservationMs]
        );
        if (reclaimed[0]) {
          return {
            state: "reserved",
            attemptId: String(reclaimed[0].attemptId),
            leaseToken,
            reservedComputeMs: reservationMs
          };
        }
        const [winner] = await transaction.unsafe(
          `select id as "attemptId", status,
                  kernel_version as "kernelVersion",
                  error_status as "errorStatus",
                  error_code as "errorCode",
                  error_message as "errorMessage",
                  error_details as "errorDetails"
             from modeling_validation_attempt
            where id = $1
            for update`,
          [expiredReservation.attemptId]
        );
        if (winner) {
          return replayedValidationAttempt(winner);
        }
        throw new ValidationAttemptStateError(
          String(expiredReservation.attemptId)
        );
      }

      const inserted = await transaction.unsafe(
        `insert into modeling_validation_attempt
           (owner_id, project_id, scope_key, kind, idempotency_key,
            request_hash, status, reserved_compute_ms, lease_token,
            reservation_expires_at)
         values ($1, $2, $3, $4, $5, $6, 'reserved', $7::integer, $8,
                 now() + ($7::integer * interval '1 millisecond'))
         returning id as "attemptId"`,
        [
          input.ownerId,
          input.projectId ?? null,
          scopeKey,
          input.kind,
          input.idempotencyKey,
          input.requestHash,
          reservationMs,
          leaseToken
        ]
      );
      const attemptId = inserted[0]?.attemptId;
      if (typeof attemptId !== "string") {
        throw new Error("Unable to reserve deterministic validation attempt");
      }
      return {
        state: "reserved",
        attemptId,
        leaseToken,
        reservedComputeMs: reservationMs
      };
    });
  }

  async completeValidationAttempt(
    input: CompleteValidationAttemptInput
  ): Promise<void> {
    if (
      !Number.isFinite(input.actualDurationMs) ||
      input.actualDurationMs < 0
    ) {
      throw new Error("Validation duration must be a non-negative number");
    }
    const actualDurationMs = Math.ceil(input.actualDurationMs);
    const failureOutcome =
      input.outcome.status === "failed" ? input.outcome : null;
    if (
      failureOutcome &&
      (!Number.isSafeInteger(failureOutcome.errorStatus) ||
        failureOutcome.errorStatus < 400 ||
        failureOutcome.errorStatus > 599)
    ) {
      throw new Error("Validation failure status must be an HTTP error status");
    }
    const rows = await this.validationSql.unsafe(
      `update modeling_validation_attempt
          set status = $1,
              actual_duration_ms = consumed_compute_ms + $2,
              kernel_version = $3,
              error_status = $4,
              error_code = $5,
              error_message = $6,
              error_details = $7::jsonb,
              completed_at = now(),
              reservation_expires_at = null
        where id = $8 and owner_id = $9 and lease_token = $10
          and status = 'reserved'
      returning id as "attemptId"`,
      [
        input.outcome.status,
        actualDurationMs,
        input.outcome.kernelVersion ?? null,
        failureOutcome?.errorStatus ?? null,
        failureOutcome?.errorCode ?? null,
        failureOutcome?.errorMessage ?? null,
        failureOutcome
          ? JSON.stringify(failureOutcome.errorDetails ?? null)
          : null,
        input.attemptId,
        input.ownerId,
        input.leaseToken
      ]
    );
    if (rows[0]) {
      return;
    }
    const [existing] = await this.validationSql.unsafe(
      `select status, lease_token as "leaseToken"
         from modeling_validation_attempt
        where id = $1 and owner_id = $2`,
      [input.attemptId, input.ownerId]
    );
    if (
      existing?.status === input.outcome.status &&
      existing.leaseToken === input.leaseToken
    ) {
      return;
    }
    throw new ValidationAttemptStateError(input.attemptId);
  }

  async listProjects(
    ownerId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ProjectDetail>> {
    const offset = (page - 1) * pageSize;
    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(modelingProject)
      .where(eq(modelingProject.ownerId, ownerId));
    const projects = await db
      .select()
      .from(modelingProject)
      .where(eq(modelingProject.ownerId, ownerId))
      .orderBy(desc(modelingProject.updatedAt), desc(modelingProject.id))
      .limit(pageSize)
      .offset(offset);
    return {
      items: await Promise.all(
        projects.map((project) => projectDetail(db, project))
      ),
      page,
      pageSize,
      total: Number(countRow?.total ?? 0)
    };
  }

  async getProject(
    ownerId: string,
    projectId: string
  ): Promise<ProjectDetail | null> {
    const project = await ownedProject(db, ownerId, projectId);
    return project ? projectDetail(db, project) : null;
  }

  async createProject(
    input: CreateProjectInput
  ): Promise<ReplayResult<ProjectDetail>> {
    const [existing] = await db
      .select()
      .from(modelingProject)
      .where(
        and(
          eq(modelingProject.ownerId, input.ownerId),
          eq(modelingProject.createIdempotencyKey, input.idempotencyKey)
        )
      );
    if (existing) {
      const detail = await projectDetail(db, existing);
      assertProjectReplay(detail, input);
      return { value: detail, replayed: true };
    }

    try {
      return await db.transaction(async (transaction) => {
        const [winner] = await transaction
          .select()
          .from(modelingProject)
          .where(
            and(
              eq(modelingProject.ownerId, input.ownerId),
              eq(modelingProject.createIdempotencyKey, input.idempotencyKey)
            )
          );
        if (winner) {
          const detail = await projectDetail(transaction, winner);
          assertProjectReplay(detail, input);
          return {
            value: detail,
            replayed: true
          };
        }

        const [project] = await transaction
          .insert(modelingProject)
          .values({
            ownerId: input.ownerId,
            createIdempotencyKey: input.idempotencyKey,
            name: input.name,
            description: input.description ?? null
          })
          .returning();
        if (!project) {
          throw new Error("Unable to create modeling project");
        }

        const [revision] = await transaction
          .insert(modelingRevision)
          .values({
            id: input.document.revisionId,
            projectId: project.id,
            parentRevisionId: null,
            revisionNumber: 1,
            source: "initial",
            idempotencyKey: `project:${input.idempotencyKey}`,
            document: input.document,
            operations: [],
            contentHash: hashCanonicalSpec(input.document),
            createdByUserId: input.ownerId
          })
          .returning();
        if (!revision) {
          throw new Error("Unable to create initial modeling revision");
        }

        const [updatedProject] = await transaction
          .update(modelingProject)
          .set({ currentRevisionId: revision.id, updatedAt: new Date() })
          .where(eq(modelingProject.id, project.id))
          .returning();
        if (!updatedProject) {
          throw new Error("Unable to advance initial modeling revision");
        }
        return {
          value: { ...updatedProject, currentRevision: revision },
          replayed: false
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [winner] = await db
          .select()
          .from(modelingProject)
          .where(
            and(
              eq(modelingProject.ownerId, input.ownerId),
              eq(modelingProject.createIdempotencyKey, input.idempotencyKey)
            )
          );
        if (winner) {
          const detail = await projectDetail(db, winner);
          assertProjectReplay(detail, input);
          return { value: detail, replayed: true };
        }
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      throw error;
    }
  }

  async updateProject(
    ownerId: string,
    projectId: string,
    input: UpdateProjectInput
  ): Promise<ProjectDetail | null> {
    const [project] = await db
      .update(modelingProject)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(modelingProject.id, projectId),
          eq(modelingProject.ownerId, ownerId)
        )
      )
      .returning();
    return project ? projectDetail(db, project) : null;
  }

  async listProjectArtifactKeys(
    ownerId: string,
    projectId: string
  ): Promise<string[] | null> {
    if (!(await ownedProject(db, ownerId, projectId))) return null;
    const artifacts = await db
      .select({ objectKey: modelingArtifact.objectKey })
      .from(modelingArtifact)
      .innerJoin(
        modelingProject,
        and(
          eq(modelingProject.id, modelingArtifact.projectId),
          eq(modelingProject.ownerId, ownerId)
        )
      )
      .where(eq(modelingArtifact.projectId, projectId));
    return artifacts.map((artifact) => artifact.objectKey);
  }

  async deleteProject(
    ownerId: string,
    projectId: string,
    deletedObjectKeys: string[]
  ): Promise<"deleted" | "not_found" | "artifacts_changed"> {
    const deletedKeys = new Set(deletedObjectKeys);
    return db.transaction(async (transaction) => {
      const project = await ownedProject(transaction, ownerId, projectId, true);
      if (!project) return "not_found";
      const currentArtifacts = await transaction
        .select({ objectKey: modelingArtifact.objectKey })
        .from(modelingArtifact)
        .where(eq(modelingArtifact.projectId, projectId));
      if (
        currentArtifacts.some(
          (artifact) => !deletedKeys.has(artifact.objectKey)
        )
      ) {
        return "artifacts_changed";
      }
      const rows = await transaction
        .delete(modelingProject)
        .where(
          and(
            eq(modelingProject.id, projectId),
            eq(modelingProject.ownerId, ownerId)
          )
        )
        .returning({ id: modelingProject.id });
      return rows.length > 0 ? "deleted" : "not_found";
    });
  }

  async listRevisions(
    ownerId: string,
    projectId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ModelingRevisionRow> | null> {
    if (!(await ownedProject(db, ownerId, projectId))) {
      return null;
    }
    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(modelingRevision)
      .where(eq(modelingRevision.projectId, projectId));
    const items = await db
      .select()
      .from(modelingRevision)
      .where(eq(modelingRevision.projectId, projectId))
      .orderBy(desc(modelingRevision.revisionNumber))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items,
      page,
      pageSize,
      total: Number(countRow?.total ?? 0)
    };
  }

  async getRevision(
    ownerId: string,
    projectId: string,
    revisionId: string
  ): Promise<ModelingRevisionRow | null> {
    const [result] = await db
      .select({ revision: modelingRevision })
      .from(modelingRevision)
      .innerJoin(
        modelingProject,
        and(
          eq(modelingProject.id, modelingRevision.projectId),
          eq(modelingProject.ownerId, ownerId)
        )
      )
      .where(
        and(
          eq(modelingRevision.id, revisionId),
          eq(modelingRevision.projectId, projectId)
        )
      );
    return result?.revision ?? null;
  }

  async commitOperationBatch(
    input: CommitOperationInput
  ): Promise<ReplayResult<ModelingRevisionRow> | null> {
    const replay = await revisionByIdempotency(
      db,
      input.ownerId,
      input.projectId,
      input.idempotencyKey
    );
    if (replay) {
      assertRevisionReplay(replay, input);
      return { value: replay, replayed: true };
    }

    const result = await db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const winner = await revisionByIdempotency(
        transaction,
        input.ownerId,
        input.projectId,
        input.idempotencyKey
      );
      if (winner) {
        assertRevisionReplay(winner, input);
        return { kind: "ok" as const, value: winner, replayed: true };
      }
      if (project.currentRevisionId !== input.baseRevisionId) {
        return {
          kind: "stale" as const,
          currentRevisionId: project.currentRevisionId
        };
      }
      const [base] = await transaction
        .select()
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, input.baseRevisionId),
            eq(modelingRevision.projectId, input.projectId)
          )
        );
      if (!base) {
        return {
          kind: "stale" as const,
          currentRevisionId: project.currentRevisionId
        };
      }
      const [revision] = await transaction
        .insert(modelingRevision)
        .values({
          id: input.document.revisionId,
          projectId: input.projectId,
          parentRevisionId: base.id,
          revisionNumber: base.revisionNumber + 1,
          source: "manual",
          idempotencyKey: input.idempotencyKey,
          document: input.document,
          operations: input.operations,
          contentHash: input.contentHash,
          createdByUserId: input.ownerId
        })
        .returning();
      if (!revision) {
        throw new Error("Unable to create modeling revision");
      }
      const [advanced] = await transaction
        .update(modelingProject)
        .set({ currentRevisionId: revision.id, updatedAt: new Date() })
        .where(
          and(
            eq(modelingProject.id, input.projectId),
            eq(modelingProject.ownerId, input.ownerId),
            eq(modelingProject.currentRevisionId, base.id)
          )
        )
        .returning({ id: modelingProject.id });
      if (!advanced) {
        throw new Error("Modeling project revision lock was lost");
      }
      return { kind: "ok" as const, value: revision, replayed: false };
    });

    if (!result) {
      return null;
    }
    if (result.kind === "stale") {
      throw new StaleRevisionError({
        projectId: input.projectId,
        expectedRevisionId: input.baseRevisionId,
        currentRevisionId: result.currentRevisionId
      });
    }
    return { value: result.value, replayed: result.replayed };
  }

  async createAiPlanJob(
    input: CreateAiPlanJobInput
  ): Promise<ReplayResult<ModelingJobRow> | null> {
    return db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const [existing] = await transaction
        .select()
        .from(modelingJob)
        .where(
          and(
            eq(modelingJob.projectId, input.projectId),
            eq(modelingJob.kind, "ai_plan"),
            eq(modelingJob.idempotencyKey, input.idempotencyKey)
          )
        );
      if (existing) {
        assertJobReplay(existing, input);
        return { value: existing, replayed: true };
      }
      if (project.currentRevisionId !== input.baseRevisionId) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.baseRevisionId,
          currentRevisionId: project.currentRevisionId
        });
      }
      const [base] = await transaction
        .select({ id: modelingRevision.id, hash: modelingRevision.contentHash })
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, input.baseRevisionId),
            eq(modelingRevision.projectId, input.projectId)
          )
        );
      if (!base) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.baseRevisionId,
          currentRevisionId: project.currentRevisionId
        });
      }
      await assertQueueLimits(transaction, input.ownerId, "ai_plan");
      const [job] = await transaction
        .insert(modelingJob)
        .values({
          projectId: input.projectId,
          revisionId: base.id,
          kind: "ai_plan",
          status: "queued",
          progress: 0,
          idempotencyKey: input.idempotencyKey,
          input: {
            baseRevisionId: base.id,
            baseRevisionHash: base.hash,
            prompt: input.prompt,
            selectedSemanticRefs: input.selectedSemanticRefs ?? []
          },
          createdByUserId: input.ownerId
        })
        .returning();
      if (!job) {
        throw new Error("Unable to create AI planning job");
      }
      await appendJobEvent(transaction, job.id, "queued", {
        kind: "ai_plan",
        progress: 0
      });
      return { value: job, replayed: false };
    });
  }

  async createJob(
    input: CreateModelingJobInput
  ): Promise<ReplayResult<ModelingJobRow> | null> {
    return db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const [existing] = await transaction
        .select()
        .from(modelingJob)
        .where(
          and(
            eq(modelingJob.projectId, input.projectId),
            eq(modelingJob.kind, input.kind),
            eq(modelingJob.idempotencyKey, input.idempotencyKey)
          )
        );
      if (existing) {
        assertGenericJobReplay(existing, input);
        return { value: existing, replayed: true };
      }
      const [revision] = await transaction
        .select({ id: modelingRevision.id })
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, input.revisionId),
            eq(modelingRevision.projectId, input.projectId)
          )
        );
      if (!revision) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.revisionId,
          currentRevisionId: project.currentRevisionId
        });
      }
      await assertQueueLimits(transaction, input.ownerId, input.kind);
      const [job] = await transaction
        .insert(modelingJob)
        .values({
          projectId: input.projectId,
          revisionId: revision.id,
          kind: input.kind,
          status: "queued",
          progress: 0,
          idempotencyKey: input.idempotencyKey,
          input: input.input ?? {},
          createdByUserId: input.ownerId
        })
        .returning();
      if (!job) {
        throw new Error("Unable to create modeling job");
      }
      await appendJobEvent(transaction, job.id, "queued", {
        kind: input.kind,
        progress: 0,
        revisionId: revision.id
      });
      return { value: job, replayed: false };
    });
  }

  async reserveStepUploadIntent(
    input: ReserveStepUploadIntentInput
  ): Promise<ReplayResult<ModelingImportIntentRow> | null> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.requestHash) ||
      !/^[a-f0-9]{64}$/u.test(input.checksumSha256)
    ) {
      throw new Error("STEP upload intent hashes must be SHA-256");
    }

    return db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }

      const [existing] = await transaction
        .select()
        .from(modelingImportIntent)
        .where(
          and(
            eq(modelingImportIntent.ownerId, input.ownerId),
            eq(modelingImportIntent.projectId, input.projectId),
            eq(modelingImportIntent.idempotencyKey, input.idempotencyKey)
          )
        )
        .for("update");
      if (existing) {
        assertStepUploadIntentReplay(existing, input);
        if (existing.completedAt) {
          return { value: existing, replayed: true };
        }
        const [renewed] = await transaction
          .update(modelingImportIntent)
          .set({ expiresAt: input.expiresAt })
          .where(eq(modelingImportIntent.id, existing.id))
          .returning();
        if (!renewed) {
          throw new Error("Unable to renew STEP upload intent");
        }
        return { value: renewed, replayed: true };
      }

      const [intent] = await transaction
        .insert(modelingImportIntent)
        .values({
          ownerId: input.ownerId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          objectKey: input.objectKey,
          sourceName: input.sourceName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          expiresAt: input.expiresAt
        })
        .returning();
      if (!intent) {
        throw new Error("Unable to reserve STEP upload intent");
      }
      return { value: intent, replayed: false };
    });
  }

  async getStepUploadIntent(
    ownerId: string,
    projectId: string,
    objectKey: string
  ): Promise<ModelingImportIntentRow | null> {
    const [result] = await db
      .select({ intent: modelingImportIntent })
      .from(modelingImportIntent)
      .innerJoin(
        modelingProject,
        and(
          eq(modelingProject.id, modelingImportIntent.projectId),
          eq(modelingProject.ownerId, ownerId)
        )
      )
      .where(
        and(
          eq(modelingImportIntent.ownerId, ownerId),
          eq(modelingImportIntent.projectId, projectId),
          eq(modelingImportIntent.objectKey, objectKey)
        )
      );
    return result?.intent ?? null;
  }

  async completeStepUploadIntent(
    input: CompleteStepUploadIntentInput
  ): Promise<ReplayResult<ModelingJobRow> | null> {
    return db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }

      const [intent] = await transaction
        .select()
        .from(modelingImportIntent)
        .where(
          and(
            eq(modelingImportIntent.ownerId, input.ownerId),
            eq(modelingImportIntent.projectId, input.projectId),
            eq(modelingImportIntent.objectKey, input.objectKey)
          )
        )
        .for("update");
      if (!intent) {
        return null;
      }
      assertStepUploadCompletion(intent, input);

      const jobPayload = importJobInput(input);
      if (intent.completedAt) {
        if (
          intent.completionIdempotencyKey !== input.completionIdempotencyKey ||
          !intent.importJobId
        ) {
          throw new IdempotencyConflictError(input.completionIdempotencyKey);
        }
        const [job] = await transaction
          .select()
          .from(modelingJob)
          .where(
            and(
              eq(modelingJob.id, intent.importJobId),
              eq(modelingJob.projectId, input.projectId)
            )
          );
        if (!job) {
          throw new Error("Completed STEP upload intent has no import job");
        }
        if (
          job.kind !== "import" ||
          job.idempotencyKey !== input.completionIdempotencyKey ||
          !sameJson(job.input, jobPayload)
        ) {
          throw new IdempotencyConflictError(input.completionIdempotencyKey);
        }
        return { value: job, replayed: true };
      }

      if (project.currentRevisionId !== input.revisionId) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.revisionId,
          currentRevisionId: project.currentRevisionId
        });
      }
      const [revision] = await transaction
        .select({ id: modelingRevision.id })
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, input.revisionId),
            eq(modelingRevision.projectId, input.projectId)
          )
        );
      if (!revision) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.revisionId,
          currentRevisionId: project.currentRevisionId
        });
      }

      const [existingJob] = await transaction
        .select()
        .from(modelingJob)
        .where(
          and(
            eq(modelingJob.projectId, input.projectId),
            eq(modelingJob.kind, "import"),
            eq(modelingJob.idempotencyKey, input.completionIdempotencyKey)
          )
        );
      let job = existingJob;
      let replayed = Boolean(existingJob);
      if (job) {
        assertGenericJobReplay(job, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          revisionId: revision.id,
          kind: "import",
          idempotencyKey: input.completionIdempotencyKey,
          input: jobPayload
        });
      } else {
        await assertQueueLimits(transaction, input.ownerId, "import");
        [job] = await transaction
          .insert(modelingJob)
          .values({
            projectId: input.projectId,
            revisionId: revision.id,
            kind: "import",
            status: "queued",
            progress: 0,
            idempotencyKey: input.completionIdempotencyKey,
            input: jobPayload,
            createdByUserId: input.ownerId
          })
          .returning();
        replayed = false;
        if (!job) {
          throw new Error("Unable to create STEP import job");
        }
        await appendJobEvent(transaction, job.id, "queued", {
          kind: "import",
          progress: 0,
          revisionId: revision.id
        });
      }

      const [completedIntent] = await transaction
        .update(modelingImportIntent)
        .set({
          completionIdempotencyKey: input.completionIdempotencyKey,
          importJobId: job.id,
          completedAt: new Date()
        })
        .where(
          and(
            eq(modelingImportIntent.id, intent.id),
            sql`${modelingImportIntent.completedAt} is null`
          )
        )
        .returning({ id: modelingImportIntent.id });
      if (!completedIntent) {
        throw new Error("Unable to complete STEP upload intent");
      }
      return { value: job, replayed };
    });
  }

  async storeGeneratedPlan(
    input: StoreGeneratedPlanInput
  ): Promise<ReplayResult<ModelingPlanRow> | null> {
    return db.transaction(async (transaction) => {
      const project = await ownedProject(
        transaction,
        input.ownerId,
        input.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const [existing] = await transaction
        .select()
        .from(modelingPlan)
        .where(
          and(
            eq(modelingPlan.projectId, input.projectId),
            eq(modelingPlan.idempotencyKey, input.idempotencyKey)
          )
        );
      if (existing) {
        if (
          existing.baseRevisionId !== input.baseRevisionId ||
          existing.baseRevisionHash !== input.baseRevisionHash ||
          existing.planHash !== input.draft.planHash ||
          !sameJson(existing.draft, input.draft)
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { value: existing, replayed: true };
      }
      const [base] = await transaction
        .select()
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, input.baseRevisionId),
            eq(modelingRevision.projectId, input.projectId)
          )
        );
      if (!base || base.contentHash !== input.baseRevisionHash) {
        throw new StaleRevisionError({
          projectId: input.projectId,
          expectedRevisionId: input.baseRevisionId,
          currentRevisionId: project.currentRevisionId
        });
      }
      if (
        !["needs_input", "validated"].includes(input.draft.status) ||
        input.draft.baseRevisionId !== input.baseRevisionId ||
        input.draft.documentId !== base.document.id ||
        hashModelingPlanDraft(input.draft) !== input.draft.planHash
      ) {
        throw new PlanConflictError(
          "INVALID_GENERATED_PLAN",
          "AI 方案未通过服务端协议与哈希校验。",
          input.draft.id
        );
      }
      const stale = project.currentRevisionId !== input.baseRevisionId;
      const now = new Date();
      const [plan] = await transaction
        .insert(modelingPlan)
        .values({
          projectId: input.projectId,
          baseRevisionId: input.baseRevisionId,
          baseRevisionHash: input.baseRevisionHash,
          planHash: input.draft.planHash,
          prompt: input.prompt,
          draft: input.draft,
          operations: input.draft.operationBatch?.operations ?? [],
          missingInputs: stale ? [] : input.draft.missingInputs,
          status: stale ? "stale" : input.draft.status,
          idempotencyKey: input.idempotencyKey,
          createdByUserId: input.ownerId,
          decidedAt: stale ? now : null
        })
        .returning();
      if (!plan) {
        throw new Error("Unable to store AI modeling plan");
      }
      return { value: plan, replayed: false };
    });
  }

  async listPlans(
    ownerId: string,
    projectId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ModelingPlanRow> | null> {
    if (!(await ownedProject(db, ownerId, projectId))) {
      return null;
    }
    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(modelingPlan)
      .where(eq(modelingPlan.projectId, projectId));
    const items = await db
      .select()
      .from(modelingPlan)
      .where(eq(modelingPlan.projectId, projectId))
      .orderBy(desc(modelingPlan.createdAt), desc(modelingPlan.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items,
      page,
      pageSize,
      total: Number(countRow?.total ?? 0)
    };
  }

  async getPlan(
    ownerId: string,
    planId: string
  ): Promise<ModelingPlanRow | null> {
    return ownedPlan(db, ownerId, planId);
  }

  async confirmPlan(
    input: ConfirmPlanInput
  ): Promise<ReplayResult<ModelingRevisionRow> | null> {
    const result = await db.transaction(async (transaction) => {
      const initial = await ownedPlan(transaction, input.ownerId, input.planId);
      if (!initial) {
        return null;
      }
      const project = await ownedProject(
        transaction,
        input.ownerId,
        initial.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const [plan] = await transaction
        .select()
        .from(modelingPlan)
        .where(eq(modelingPlan.id, input.planId))
        .for("update");
      if (!plan || plan.projectId !== project.id) {
        return null;
      }
      if (
        plan.baseRevisionId !== input.expectedBaseRevisionId ||
        plan.planHash !== input.expectedPlanHash
      ) {
        throw new PlanConflictError(
          "PLAN_VERSION_MISMATCH",
          "确认参数与服务端 AI 方案版本不一致。",
          input.planId
        );
      }
      if (plan.status === "confirmed") {
        if (!plan.confirmedRevisionId) {
          throw new Error("Confirmed plan is missing its revision pointer");
        }
        const [revision] = await transaction
          .select()
          .from(modelingRevision)
          .where(
            and(
              eq(modelingRevision.id, plan.confirmedRevisionId),
              eq(modelingRevision.projectId, project.id)
            )
          );
        if (!revision) {
          throw new Error("Confirmed plan revision is unavailable");
        }
        return { kind: "ok" as const, value: revision, replayed: true };
      }
      if (plan.status !== "validated") {
        throw new PlanConflictError(
          "PLAN_NOT_CONFIRMABLE",
          "当前 AI 方案尚未通过校验或已经结束。",
          input.planId
        );
      }
      const [base] = await transaction
        .select()
        .from(modelingRevision)
        .where(
          and(
            eq(modelingRevision.id, plan.baseRevisionId),
            eq(modelingRevision.projectId, project.id)
          )
        );
      if (
        !base ||
        base.contentHash !== plan.baseRevisionHash ||
        project.currentRevisionId !== plan.baseRevisionId
      ) {
        await transaction
          .update(modelingPlan)
          .set({ status: "stale", decidedAt: new Date() })
          .where(eq(modelingPlan.id, plan.id));
        return {
          kind: "stale" as const,
          baseRevisionId: plan.baseRevisionId,
          currentRevisionId: project.currentRevisionId
        };
      }
      const replay = await revisionByIdempotency(
        transaction,
        input.ownerId,
        project.id,
        input.idempotencyKey
      );
      if (replay) {
        if (
          replay.parentRevisionId !== base.id ||
          replay.contentHash !== input.contentHash ||
          !sameJson(replay.document, input.document)
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        throw new PlanConflictError(
          "PLAN_CONFIRMATION_INCOMPLETE",
          "幂等提交记录存在，但 AI 方案尚未完成确认。",
          input.planId
        );
      }
      const [revision] = await transaction
        .insert(modelingRevision)
        .values({
          id: input.document.revisionId,
          projectId: project.id,
          parentRevisionId: base.id,
          revisionNumber: base.revisionNumber + 1,
          source: "ai_plan",
          idempotencyKey: input.idempotencyKey,
          document: input.document,
          operations: plan.operations,
          contentHash: input.contentHash,
          createdByUserId: input.ownerId
        })
        .returning();
      if (!revision) {
        throw new Error("Unable to commit AI modeling plan");
      }
      const now = new Date();
      await transaction
        .update(modelingProject)
        .set({ currentRevisionId: revision.id, updatedAt: now })
        .where(eq(modelingProject.id, project.id));
      await transaction
        .update(modelingPlan)
        .set({
          status: "confirmed",
          confirmedRevisionId: revision.id,
          decidedAt: now
        })
        .where(eq(modelingPlan.id, plan.id));
      return { kind: "ok" as const, value: revision, replayed: false };
    });

    if (!result) {
      return null;
    }
    if (result.kind === "stale") {
      throw new StalePlanError({
        planId: input.planId,
        baseRevisionId: result.baseRevisionId,
        currentRevisionId: result.currentRevisionId
      });
    }
    return { value: result.value, replayed: result.replayed };
  }

  async rejectPlan(
    ownerId: string,
    planId: string
  ): Promise<ReplayResult<ModelingPlanRow> | null> {
    return db.transaction(async (transaction) => {
      const initial = await ownedPlan(transaction, ownerId, planId);
      if (!initial) {
        return null;
      }
      const project = await ownedProject(
        transaction,
        ownerId,
        initial.projectId,
        true
      );
      if (!project) {
        return null;
      }
      const [plan] = await transaction
        .select()
        .from(modelingPlan)
        .where(eq(modelingPlan.id, planId))
        .for("update");
      if (!plan || plan.projectId !== project.id) {
        return null;
      }
      if (plan.status === "rejected") {
        return { value: plan, replayed: true };
      }
      if (plan.status === "confirmed" || plan.status === "stale") {
        throw new PlanConflictError(
          "PLAN_NOT_REJECTABLE",
          "已确认或已过期的 AI 方案不能拒绝。",
          planId
        );
      }
      const [updated] = await transaction
        .update(modelingPlan)
        .set({ status: "rejected", decidedAt: new Date(), missingInputs: [] })
        .where(eq(modelingPlan.id, planId))
        .returning();
      if (!updated) {
        throw new Error("Unable to reject AI modeling plan");
      }
      return { value: updated, replayed: false };
    });
  }

  async getJob(ownerId: string, jobId: string): Promise<ModelingJobRow | null> {
    return ownedJob(db, ownerId, jobId);
  }

  async cancelJob(
    ownerId: string,
    jobId: string
  ): Promise<CancelJobResult | null> {
    return db.transaction(async (transaction) => {
      const job = await ownedJob(transaction, ownerId, jobId, true);
      if (!job) {
        return null;
      }
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        return {
          job,
          replayed: true,
          cancellationRequested: job.status === "cancelled"
        };
      }
      const now = new Date();
      if (job.status === "queued") {
        const [cancelled] = await transaction
          .update(modelingJob)
          .set({
            status: "cancelled",
            cancelRequestedAt: now,
            completedAt: now,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now
          })
          .where(eq(modelingJob.id, job.id))
          .returning();
        if (!cancelled) {
          throw new Error("Unable to cancel modeling job");
        }
        await appendJobEvent(transaction, job.id, "cancelled", {
          progress: cancelled.progress
        });
        return { job: cancelled, replayed: false, cancellationRequested: true };
      }
      if (job.cancelRequestedAt) {
        return { job, replayed: true, cancellationRequested: true };
      }
      const [requested] = await transaction
        .update(modelingJob)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(eq(modelingJob.id, job.id))
        .returning();
      if (!requested) {
        throw new Error("Unable to request modeling job cancellation");
      }
      await appendJobEvent(transaction, job.id, "cancel_requested", {
        progress: requested.progress
      });
      return { job: requested, replayed: false, cancellationRequested: true };
    });
  }

  async listJobEvents(
    ownerId: string,
    jobId: string,
    afterSequence: number,
    limit: number
  ): Promise<ModelingJobEventRow[] | null> {
    if (!(await ownedJob(db, ownerId, jobId))) {
      return null;
    }
    return db
      .select()
      .from(modelingJobEvent)
      .where(
        and(
          eq(modelingJobEvent.jobId, jobId),
          gt(modelingJobEvent.sequence, afterSequence)
        )
      )
      .orderBy(asc(modelingJobEvent.sequence))
      .limit(limit);
  }

  async getArtifact(
    ownerId: string,
    artifactId: string
  ): Promise<ModelingArtifactRow | null> {
    const [result] = await db
      .select({ artifact: modelingArtifact })
      .from(modelingArtifact)
      .innerJoin(
        modelingProject,
        and(
          eq(modelingProject.id, modelingArtifact.projectId),
          eq(modelingProject.ownerId, ownerId)
        )
      )
      .where(eq(modelingArtifact.id, artifactId));
    return result?.artifact ?? null;
  }
}

export const modelingRepository: ModelingRepository =
  new PostgresModelingRepository();
