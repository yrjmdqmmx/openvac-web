import { relations, sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type {
  ModelDocument,
  ModelingPlanDraft,
  ModelOperation
} from "@/types/modeling";

import { user } from "./auth";

const modelingTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const modelingRevisionSource = pgEnum("modeling_revision_source", [
  "initial",
  "manual",
  "ai_plan",
  "import"
]);

export const modelingPlanStatus = pgEnum("modeling_plan_status", [
  "needs_input",
  "validated",
  "confirmed",
  "rejected",
  "stale"
]);

export const modelingJobKind = pgEnum("modeling_job_kind", [
  "ai_plan",
  "import",
  "build",
  "preview",
  "conversion",
  "export"
]);

export const modelingJobStatus = pgEnum("modeling_job_status", [
  "queued",
  "running",
  "validating",
  "meshing",
  "exporting",
  "succeeded",
  "failed",
  "cancelled"
]);

export const modelingArtifactKind = pgEnum("modeling_artifact_kind", [
  "source",
  "model",
  "preview",
  "export",
  "log"
]);

export const modelingValidationKind = pgEnum("modeling_validation_kind", [
  "project_create",
  "operation_batch"
]);

export const modelingValidationStatus = pgEnum("modeling_validation_status", [
  "reserved",
  "succeeded",
  "failed"
]);

export const modelingProject = pgTable(
  "modeling_project",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createIdempotencyKey: text("create_idempotency_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    currentRevisionId: uuid("current_revision_id").references(
      (): AnyPgColumn => modelingRevision.id,
      { onDelete: "no action" }
    ),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull(),
    updatedAt: modelingTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    index("modeling_project_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt
    ),
    uniqueIndex("modeling_project_owner_idempotency_unique").on(
      table.ownerId,
      table.createIdempotencyKey
    ),
    index("modeling_project_current_revision_idx").on(table.currentRevisionId),
    check(
      "modeling_project_name_not_blank",
      sql`length(btrim(${table.name})) > 0`
    ),
    check(
      "modeling_project_idempotency_not_blank",
      sql`length(btrim(${table.createIdempotencyKey})) > 0`
    )
  ]
);

/**
 * Revisions are append-only. There is intentionally no updated_at column: a
 * change creates a child revision and advances modeling_project.currentRevisionId.
 */
export const modelingRevision = pgTable(
  "modeling_revision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => modelingProject.id, { onDelete: "cascade" }),
    parentRevisionId: uuid("parent_revision_id").references(
      (): AnyPgColumn => modelingRevision.id,
      { onDelete: "no action" }
    ),
    revisionNumber: integer("revision_number").notNull(),
    source: modelingRevisionSource("source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    document: jsonb("document").$type<ModelDocument>().notNull(),
    operations: jsonb("operations")
      .$type<ModelOperation[]>()
      .default([])
      .notNull(),
    contentHash: text("content_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("modeling_revision_project_number_unique").on(
      table.projectId,
      table.revisionNumber
    ),
    uniqueIndex("modeling_revision_project_idempotency_unique").on(
      table.projectId,
      table.idempotencyKey
    ),
    index("modeling_revision_project_created_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("modeling_revision_parent_idx").on(table.parentRevisionId),
    index("modeling_revision_project_hash_idx").on(
      table.projectId,
      table.contentHash
    ),
    check(
      "modeling_revision_number_positive",
      sql`${table.revisionNumber} > 0`
    ),
    check(
      "modeling_revision_hash_valid",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_revision_idempotency_not_blank",
      sql`length(btrim(${table.idempotencyKey})) > 0`
    ),
    check(
      "modeling_revision_initial_parent_valid",
      sql`(${table.revisionNumber} = 1 and ${table.parentRevisionId} is null) or (${table.revisionNumber} > 1 and ${table.parentRevisionId} is not null)`
    )
  ]
);

/**
 * A durable, account-scoped ledger for synchronous CAD validations. A row is
 * inserted before the kernel is called, so failed validations consume the
 * manual-operation rate limit and an idempotency replay never calls CAD twice.
 */
export const modelingValidationAttempt = pgTable(
  "modeling_validation_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => modelingProject.id, {
      onDelete: "set null"
    }),
    scopeKey: text("scope_key").notNull(),
    kind: modelingValidationKind("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: modelingValidationStatus("status").default("reserved").notNull(),
    reservedComputeMs: integer("reserved_compute_ms").notNull(),
    consumedComputeMs: integer("consumed_compute_ms").default(0).notNull(),
    actualDurationMs: integer("actual_duration_ms"),
    leaseToken: text("lease_token").notNull(),
    reservationExpiresAt: modelingTimestamp("reservation_expires_at"),
    kernelVersion: text("kernel_version"),
    errorStatus: integer("error_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorDetails: jsonb("error_details").$type<Record<string, unknown>>(),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull(),
    completedAt: modelingTimestamp("completed_at")
  },
  (table) => [
    uniqueIndex("modeling_validation_attempt_scope_idempotency_unique").on(
      table.ownerId,
      table.scopeKey,
      table.kind,
      table.idempotencyKey
    ),
    index("modeling_validation_attempt_owner_created_idx").on(
      table.ownerId,
      table.createdAt
    ),
    index("modeling_validation_attempt_project_idx").on(table.projectId),
    check(
      "modeling_validation_attempt_scope_valid",
      sql`(${table.kind} = 'project_create' and ${table.projectId} is null and ${table.scopeKey} = 'account') or (${table.kind} = 'operation_batch' and ${table.scopeKey} <> 'account')`
    ),
    check(
      "modeling_validation_attempt_idempotency_not_blank",
      sql`length(btrim(${table.idempotencyKey})) > 0`
    ),
    check(
      "modeling_validation_attempt_lease_token_not_blank",
      sql`length(btrim(${table.leaseToken})) > 0`
    ),
    check(
      "modeling_validation_attempt_request_hash_valid",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_validation_attempt_reserved_compute_positive",
      sql`${table.reservedComputeMs} > 0`
    ),
    check(
      "modeling_validation_attempt_actual_duration_valid",
      sql`${table.actualDurationMs} is null or ${table.actualDurationMs} >= 0`
    ),
    check(
      "modeling_validation_attempt_consumed_compute_valid",
      sql`${table.consumedComputeMs} >= 0`
    ),
    check(
      "modeling_validation_attempt_error_status_valid",
      sql`${table.errorStatus} is null or ${table.errorStatus} between 400 and 599`
    ),
    check(
      "modeling_validation_attempt_completion_shape_valid",
      sql`(${table.status} = 'reserved' and ${table.completedAt} is null and ${table.actualDurationMs} is null and ${table.reservationExpiresAt} is not null and ${table.errorStatus} is null and ${table.errorCode} is null and ${table.errorMessage} is null) or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.actualDurationMs} is not null and ${table.reservationExpiresAt} is null and ${table.errorStatus} is null and ${table.errorCode} is null and ${table.errorMessage} is null) or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.actualDurationMs} is not null and ${table.reservationExpiresAt} is null and ${table.errorStatus} is not null and ${table.errorCode} is not null and ${table.errorMessage} is not null)`
    )
  ]
);

export const modelingPlan = pgTable(
  "modeling_plan",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => modelingProject.id, { onDelete: "cascade" }),
    baseRevisionId: uuid("base_revision_id")
      .notNull()
      .references(() => modelingRevision.id, { onDelete: "no action" }),
    baseRevisionHash: text("base_revision_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    prompt: text("prompt").notNull(),
    draft: jsonb("draft").$type<ModelingPlanDraft>().notNull(),
    operations: jsonb("operations")
      .$type<ModelOperation[]>()
      .default([])
      .notNull(),
    missingInputs: jsonb("missing_inputs")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: modelingPlanStatus("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    confirmedRevisionId: uuid("confirmed_revision_id").references(
      () => modelingRevision.id,
      { onDelete: "no action" }
    ),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    decidedAt: modelingTimestamp("decided_at"),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("modeling_plan_project_idempotency_unique").on(
      table.projectId,
      table.idempotencyKey
    ),
    index("modeling_plan_project_created_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("modeling_plan_project_status_idx").on(table.projectId, table.status),
    index("modeling_plan_base_revision_idx").on(table.baseRevisionId),
    index("modeling_plan_confirmed_revision_idx").on(table.confirmedRevisionId),
    check(
      "modeling_plan_base_hash_valid",
      sql`${table.baseRevisionHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_plan_hash_valid",
      sql`${table.planHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_plan_idempotency_not_blank",
      sql`length(btrim(${table.idempotencyKey})) > 0`
    ),
    check(
      "modeling_plan_decision_shape_valid",
      sql`(${table.status} in ('needs_input', 'validated') and ${table.decidedAt} is null and ${table.confirmedRevisionId} is null) or (${table.status} = 'confirmed' and ${table.decidedAt} is not null and ${table.confirmedRevisionId} is not null) or (${table.status} in ('rejected', 'stale') and ${table.decidedAt} is not null and ${table.confirmedRevisionId} is null)`
    ),
    check(
      "modeling_plan_missing_inputs_shape_valid",
      sql`(${table.status} = 'needs_input' and jsonb_array_length(${table.missingInputs}) > 0) or (${table.status} <> 'needs_input' and jsonb_array_length(${table.missingInputs}) = 0)`
    )
  ]
);

export const modelingJob = pgTable(
  "modeling_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => modelingProject.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => modelingPlan.id, {
      onDelete: "no action"
    }),
    revisionId: uuid("revision_id").references(() => modelingRevision.id, {
      onDelete: "no action"
    }),
    kind: modelingJobKind("kind").notNull(),
    status: modelingJobStatus("status").default("queued").notNull(),
    progress: integer("progress").default(0).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    input: jsonb("input")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    output: jsonb("output")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: modelingTimestamp("lease_expires_at"),
    cancelRequestedAt: modelingTimestamp("cancel_requested_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull(),
    startedAt: modelingTimestamp("started_at"),
    completedAt: modelingTimestamp("completed_at"),
    updatedAt: modelingTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("modeling_job_project_kind_idempotency_unique").on(
      table.projectId,
      table.kind,
      table.idempotencyKey
    ),
    index("modeling_job_project_created_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("modeling_job_status_lease_idx").on(
      table.status,
      table.leaseExpiresAt
    ),
    index("modeling_job_plan_idx").on(table.planId),
    index("modeling_job_revision_idx").on(table.revisionId),
    check(
      "modeling_job_progress_valid",
      sql`${table.progress} between 0 and 100`
    ),
    check(
      "modeling_job_idempotency_not_blank",
      sql`length(btrim(${table.idempotencyKey})) > 0`
    ),
    check(
      "modeling_job_lease_shape_valid",
      sql`(${table.leaseToken} is null and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null) or (${table.leaseToken} is not null and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)`
    ),
    check(
      "modeling_job_completion_shape_valid",
      sql`(${table.status} in ('queued', 'running', 'validating', 'meshing', 'exporting') and ${table.completedAt} is null) or (${table.status} in ('succeeded', 'failed', 'cancelled') and ${table.completedAt} is not null)`
    ),
    check(
      "modeling_job_terminal_lease_cleared",
      sql`${table.status} not in ('succeeded', 'failed', 'cancelled') or (${table.leaseToken} is null and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`
    )
  ]
);

/**
 * Durable authorization for one direct-to-OSS STEP upload. The intent is
 * created before a URL is signed, so a provider failure can be retried with
 * the same idempotency key without changing the private object key. Completion
 * is fenced by the exact canonical request and bound to one import job.
 */
export const modelingImportIntent = pgTable(
  "modeling_import_intent",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => modelingProject.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    objectKey: text("object_key").notNull(),
    sourceName: text("source_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    expiresAt: modelingTimestamp("expires_at").notNull(),
    completionIdempotencyKey: text("completion_idempotency_key"),
    importJobId: uuid("import_job_id").references(() => modelingJob.id, {
      onDelete: "no action"
    }),
    completedAt: modelingTimestamp("completed_at"),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull(),
    updatedAt: modelingTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("modeling_import_intent_owner_project_idempotency_unique").on(
      table.ownerId,
      table.projectId,
      table.idempotencyKey
    ),
    uniqueIndex("modeling_import_intent_object_key_unique").on(table.objectKey),
    uniqueIndex("modeling_import_intent_import_job_unique").on(
      table.importJobId
    ),
    index("modeling_import_intent_project_created_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("modeling_import_intent_owner_expires_idx").on(
      table.ownerId,
      table.expiresAt
    ),
    check(
      "modeling_import_intent_idempotency_not_blank",
      sql`length(btrim(${table.idempotencyKey})) > 0`
    ),
    check(
      "modeling_import_intent_request_hash_valid",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_import_intent_checksum_valid",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "modeling_import_intent_size_valid",
      sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 52428800`
    ),
    check(
      "modeling_import_intent_source_name_valid",
      sql`length(btrim(${table.sourceName})) > 0`
    ),
    check(
      "modeling_import_intent_mime_type_valid",
      sql`length(btrim(${table.mimeType})) > 0`
    ),
    check(
      "modeling_import_intent_object_key_private_valid",
      sql`length(${table.objectKey}) > 0 and left(${table.objectKey}, 1) <> '/' and ${table.objectKey} !~ '(^|/)\.\.(/|$)'`
    ),
    check(
      "modeling_import_intent_completion_shape_valid",
      sql`(${table.completedAt} is null and ${table.importJobId} is null and ${table.completionIdempotencyKey} is null) or (${table.completedAt} is not null and ${table.importJobId} is not null and ${table.completionIdempotencyKey} is not null)`
    )
  ]
);

export const modelingJobEvent = pgTable(
  "modeling_job_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => modelingJob.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("modeling_job_event_job_sequence_unique").on(
      table.jobId,
      table.sequence
    ),
    index("modeling_job_event_job_created_idx").on(
      table.jobId,
      table.createdAt
    ),
    check("modeling_job_event_sequence_positive", sql`${table.sequence} > 0`),
    check(
      "modeling_job_event_type_not_blank",
      sql`length(btrim(${table.type})) > 0`
    )
  ]
);

export const modelingArtifact = pgTable(
  "modeling_artifact",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => modelingProject.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => modelingJob.id, {
      onDelete: "no action"
    }),
    revisionId: uuid("revision_id").references(() => modelingRevision.id, {
      onDelete: "no action"
    }),
    kind: modelingArtifactKind("kind").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    objectKey: text("object_key").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    expiresAt: modelingTimestamp("expires_at"),
    cleanupLeaseOwner: text("cleanup_lease_owner"),
    cleanupLeaseToken: text("cleanup_lease_token"),
    cleanupLeaseExpiresAt: modelingTimestamp("cleanup_lease_expires_at"),
    cleanupAttempts: integer("cleanup_attempts").default(0).notNull(),
    cleanupNextAttemptAt: modelingTimestamp("cleanup_next_attempt_at"),
    cleanupLastError: text("cleanup_last_error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: modelingTimestamp("created_at").defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("modeling_artifact_object_key_unique").on(table.objectKey),
    index("modeling_artifact_project_created_idx").on(
      table.projectId,
      table.createdAt
    ),
    index("modeling_artifact_job_idx").on(table.jobId),
    index("modeling_artifact_revision_idx").on(table.revisionId),
    index("modeling_artifact_expires_idx").on(table.expiresAt),
    index("modeling_artifact_cleanup_claim_idx").on(
      table.expiresAt,
      table.cleanupNextAttemptAt,
      table.cleanupLeaseExpiresAt
    ),
    check(
      "modeling_artifact_checksum_valid",
      sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`
    ),
    check("modeling_artifact_size_valid", sql`${table.sizeBytes} >= 0`),
    check(
      "modeling_artifact_retention_shape_valid",
      sql`(${table.kind} in ('source', 'model') and ${table.expiresAt} is null) or (${table.kind} in ('preview', 'export') and ${table.expiresAt} is not null) or ${table.kind} = 'log'`
    ),
    check(
      "modeling_artifact_cleanup_attempts_valid",
      sql`${table.cleanupAttempts} >= 0`
    ),
    check(
      "modeling_artifact_cleanup_lease_shape_valid",
      sql`(${table.cleanupLeaseOwner} is null and ${table.cleanupLeaseToken} is null and ${table.cleanupLeaseExpiresAt} is null) or (${table.cleanupLeaseOwner} is not null and ${table.cleanupLeaseToken} is not null and ${table.cleanupLeaseExpiresAt} is not null and ${table.kind} in ('preview', 'export') and ${table.expiresAt} is not null)`
    ),
    check(
      "modeling_artifact_key_private_valid",
      sql`length(${table.objectKey}) > 0 and left(${table.objectKey}, 1) <> '/' and ${table.objectKey} !~ '(^|/)\.\.(/|$)'`
    )
  ]
);

export const modelingProjectRelations = relations(
  modelingProject,
  ({ one, many }) => ({
    owner: one(user, {
      fields: [modelingProject.ownerId],
      references: [user.id]
    }),
    currentRevision: one(modelingRevision, {
      fields: [modelingProject.currentRevisionId],
      references: [modelingRevision.id],
      relationName: "modeling_project_current_revision"
    }),
    revisions: many(modelingRevision, {
      relationName: "modeling_project_revisions"
    }),
    plans: many(modelingPlan),
    jobs: many(modelingJob),
    artifacts: many(modelingArtifact),
    importIntents: many(modelingImportIntent),
    validationAttempts: many(modelingValidationAttempt)
  })
);

export const modelingValidationAttemptRelations = relations(
  modelingValidationAttempt,
  ({ one }) => ({
    owner: one(user, {
      fields: [modelingValidationAttempt.ownerId],
      references: [user.id]
    }),
    project: one(modelingProject, {
      fields: [modelingValidationAttempt.projectId],
      references: [modelingProject.id]
    })
  })
);

export const modelingRevisionRelations = relations(
  modelingRevision,
  ({ one, many }) => ({
    project: one(modelingProject, {
      fields: [modelingRevision.projectId],
      references: [modelingProject.id],
      relationName: "modeling_project_revisions"
    }),
    parent: one(modelingRevision, {
      fields: [modelingRevision.parentRevisionId],
      references: [modelingRevision.id],
      relationName: "modeling_revision_parent"
    }),
    children: many(modelingRevision, {
      relationName: "modeling_revision_parent"
    }),
    currentForProjects: many(modelingProject, {
      relationName: "modeling_project_current_revision"
    }),
    basedPlans: many(modelingPlan, { relationName: "modeling_plan_base" }),
    confirmedPlans: many(modelingPlan, {
      relationName: "modeling_plan_confirmed_revision"
    }),
    jobs: many(modelingJob),
    artifacts: many(modelingArtifact)
  })
);

export const modelingPlanRelations = relations(
  modelingPlan,
  ({ one, many }) => ({
    project: one(modelingProject, {
      fields: [modelingPlan.projectId],
      references: [modelingProject.id]
    }),
    baseRevision: one(modelingRevision, {
      fields: [modelingPlan.baseRevisionId],
      references: [modelingRevision.id],
      relationName: "modeling_plan_base"
    }),
    confirmedRevision: one(modelingRevision, {
      fields: [modelingPlan.confirmedRevisionId],
      references: [modelingRevision.id],
      relationName: "modeling_plan_confirmed_revision"
    }),
    jobs: many(modelingJob)
  })
);

export const modelingJobRelations = relations(modelingJob, ({ one, many }) => ({
  project: one(modelingProject, {
    fields: [modelingJob.projectId],
    references: [modelingProject.id]
  }),
  plan: one(modelingPlan, {
    fields: [modelingJob.planId],
    references: [modelingPlan.id]
  }),
  revision: one(modelingRevision, {
    fields: [modelingJob.revisionId],
    references: [modelingRevision.id]
  }),
  events: many(modelingJobEvent),
  artifacts: many(modelingArtifact),
  importIntents: many(modelingImportIntent)
}));

export const modelingImportIntentRelations = relations(
  modelingImportIntent,
  ({ one }) => ({
    owner: one(user, {
      fields: [modelingImportIntent.ownerId],
      references: [user.id]
    }),
    project: one(modelingProject, {
      fields: [modelingImportIntent.projectId],
      references: [modelingProject.id]
    }),
    importJob: one(modelingJob, {
      fields: [modelingImportIntent.importJobId],
      references: [modelingJob.id]
    })
  })
);

export const modelingJobEventRelations = relations(
  modelingJobEvent,
  ({ one }) => ({
    job: one(modelingJob, {
      fields: [modelingJobEvent.jobId],
      references: [modelingJob.id]
    })
  })
);

export const modelingArtifactRelations = relations(
  modelingArtifact,
  ({ one }) => ({
    project: one(modelingProject, {
      fields: [modelingArtifact.projectId],
      references: [modelingProject.id]
    }),
    job: one(modelingJob, {
      fields: [modelingArtifact.jobId],
      references: [modelingJob.id]
    }),
    revision: one(modelingRevision, {
      fields: [modelingArtifact.revisionId],
      references: [modelingRevision.id]
    })
  })
);

export const modelingProjects = modelingProject;
export const modelingRevisions = modelingRevision;
export const modelingPlans = modelingPlan;
export const modelingJobs = modelingJob;
export const modelingJobEvents = modelingJobEvent;
export const modelingArtifacts = modelingArtifact;
export const modelingImportIntents = modelingImportIntent;
export const modelingValidationAttempts = modelingValidationAttempt;
