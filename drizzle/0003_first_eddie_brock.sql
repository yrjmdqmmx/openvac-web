CREATE TYPE "public"."modeling_artifact_kind" AS ENUM('source', 'model', 'preview', 'export', 'log');--> statement-breakpoint
CREATE TYPE "public"."modeling_job_kind" AS ENUM('ai_plan', 'import', 'build', 'preview', 'conversion', 'export');--> statement-breakpoint
CREATE TYPE "public"."modeling_job_status" AS ENUM('queued', 'running', 'validating', 'meshing', 'exporting', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."modeling_plan_status" AS ENUM('needs_input', 'validated', 'confirmed', 'rejected', 'stale');--> statement-breakpoint
CREATE TYPE "public"."modeling_revision_source" AS ENUM('initial', 'manual', 'ai_plan', 'import');--> statement-breakpoint
CREATE TYPE "public"."modeling_validation_kind" AS ENUM('project_create', 'operation_batch');--> statement-breakpoint
CREATE TYPE "public"."modeling_validation_status" AS ENUM('reserved', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "modeling_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid,
	"revision_id" uuid,
	"kind" "modeling_artifact_kind" NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"object_key" text NOT NULL,
	"checksum_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"cleanup_lease_owner" text,
	"cleanup_lease_token" text,
	"cleanup_lease_expires_at" timestamp with time zone,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"cleanup_next_attempt_at" timestamp with time zone,
	"cleanup_last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_artifact_checksum_valid" CHECK ("modeling_artifact"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_artifact_size_valid" CHECK ("modeling_artifact"."size_bytes" >= 0),
	CONSTRAINT "modeling_artifact_retention_shape_valid" CHECK (("modeling_artifact"."kind" in ('source', 'model') and "modeling_artifact"."expires_at" is null) or ("modeling_artifact"."kind" in ('preview', 'export') and "modeling_artifact"."expires_at" is not null) or "modeling_artifact"."kind" = 'log'),
	CONSTRAINT "modeling_artifact_cleanup_attempts_valid" CHECK ("modeling_artifact"."cleanup_attempts" >= 0),
	CONSTRAINT "modeling_artifact_cleanup_lease_shape_valid" CHECK (("modeling_artifact"."cleanup_lease_owner" is null and "modeling_artifact"."cleanup_lease_token" is null and "modeling_artifact"."cleanup_lease_expires_at" is null) or ("modeling_artifact"."cleanup_lease_owner" is not null and "modeling_artifact"."cleanup_lease_token" is not null and "modeling_artifact"."cleanup_lease_expires_at" is not null and "modeling_artifact"."kind" in ('preview', 'export') and "modeling_artifact"."expires_at" is not null)),
	CONSTRAINT "modeling_artifact_key_private_valid" CHECK (length("modeling_artifact"."object_key") > 0 and left("modeling_artifact"."object_key", 1) <> '/' and "modeling_artifact"."object_key" !~ '(^|/)\.\.(/|$)')
);
--> statement-breakpoint
CREATE TABLE "modeling_import_intent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"object_key" text NOT NULL,
	"source_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completion_idempotency_key" text,
	"import_job_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_import_intent_idempotency_not_blank" CHECK (length(btrim("modeling_import_intent"."idempotency_key")) > 0),
	CONSTRAINT "modeling_import_intent_request_hash_valid" CHECK ("modeling_import_intent"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_import_intent_checksum_valid" CHECK ("modeling_import_intent"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_import_intent_size_valid" CHECK ("modeling_import_intent"."size_bytes" > 0 and "modeling_import_intent"."size_bytes" <= 52428800),
	CONSTRAINT "modeling_import_intent_source_name_valid" CHECK (length(btrim("modeling_import_intent"."source_name")) > 0),
	CONSTRAINT "modeling_import_intent_mime_type_valid" CHECK (length(btrim("modeling_import_intent"."mime_type")) > 0),
	CONSTRAINT "modeling_import_intent_object_key_private_valid" CHECK (length("modeling_import_intent"."object_key") > 0 and left("modeling_import_intent"."object_key", 1) <> '/' and "modeling_import_intent"."object_key" !~ '(^|/)\.\.(/|$)'),
	CONSTRAINT "modeling_import_intent_completion_shape_valid" CHECK (("modeling_import_intent"."completed_at" is null and "modeling_import_intent"."import_job_id" is null and "modeling_import_intent"."completion_idempotency_key" is null) or ("modeling_import_intent"."completed_at" is not null and "modeling_import_intent"."import_job_id" is not null and "modeling_import_intent"."completion_idempotency_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "modeling_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_id" uuid,
	"revision_id" uuid,
	"kind" "modeling_job_kind" NOT NULL,
	"status" "modeling_job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_job_progress_valid" CHECK ("modeling_job"."progress" between 0 and 100),
	CONSTRAINT "modeling_job_idempotency_not_blank" CHECK (length(btrim("modeling_job"."idempotency_key")) > 0),
	CONSTRAINT "modeling_job_lease_shape_valid" CHECK (("modeling_job"."lease_token" is null and "modeling_job"."lease_owner" is null and "modeling_job"."lease_expires_at" is null) or ("modeling_job"."lease_token" is not null and "modeling_job"."lease_owner" is not null and "modeling_job"."lease_expires_at" is not null)),
	CONSTRAINT "modeling_job_completion_shape_valid" CHECK (("modeling_job"."status" in ('queued', 'running', 'validating', 'meshing', 'exporting') and "modeling_job"."completed_at" is null) or ("modeling_job"."status" in ('succeeded', 'failed', 'cancelled') and "modeling_job"."completed_at" is not null)),
	CONSTRAINT "modeling_job_terminal_lease_cleared" CHECK ("modeling_job"."status" not in ('succeeded', 'failed', 'cancelled') or ("modeling_job"."lease_token" is null and "modeling_job"."lease_owner" is null and "modeling_job"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "modeling_job_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_job_event_sequence_positive" CHECK ("modeling_job_event"."sequence" > 0),
	CONSTRAINT "modeling_job_event_type_not_blank" CHECK (length(btrim("modeling_job_event"."type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modeling_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"base_revision_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"prompt" text NOT NULL,
	"draft" jsonb NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "modeling_plan_status" NOT NULL,
	"idempotency_key" text NOT NULL,
	"confirmed_revision_id" uuid,
	"created_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_plan_base_hash_valid" CHECK ("modeling_plan"."base_revision_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_plan_hash_valid" CHECK ("modeling_plan"."plan_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_plan_idempotency_not_blank" CHECK (length(btrim("modeling_plan"."idempotency_key")) > 0),
	CONSTRAINT "modeling_plan_decision_shape_valid" CHECK (("modeling_plan"."status" in ('needs_input', 'validated') and "modeling_plan"."decided_at" is null and "modeling_plan"."confirmed_revision_id" is null) or ("modeling_plan"."status" = 'confirmed' and "modeling_plan"."decided_at" is not null and "modeling_plan"."confirmed_revision_id" is not null) or ("modeling_plan"."status" in ('rejected', 'stale') and "modeling_plan"."decided_at" is not null and "modeling_plan"."confirmed_revision_id" is null)),
	CONSTRAINT "modeling_plan_missing_inputs_shape_valid" CHECK (("modeling_plan"."status" = 'needs_input' and jsonb_array_length("modeling_plan"."missing_inputs") > 0) or ("modeling_plan"."status" <> 'needs_input' and jsonb_array_length("modeling_plan"."missing_inputs") = 0))
);
--> statement-breakpoint
CREATE TABLE "modeling_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"create_idempotency_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_project_name_not_blank" CHECK (length(btrim("modeling_project"."name")) > 0),
	CONSTRAINT "modeling_project_idempotency_not_blank" CHECK (length(btrim("modeling_project"."create_idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modeling_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"revision_number" integer NOT NULL,
	"source" "modeling_revision_source" NOT NULL,
	"idempotency_key" text NOT NULL,
	"document" jsonb NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modeling_revision_number_positive" CHECK ("modeling_revision"."revision_number" > 0),
	CONSTRAINT "modeling_revision_hash_valid" CHECK ("modeling_revision"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_revision_idempotency_not_blank" CHECK (length(btrim("modeling_revision"."idempotency_key")) > 0),
	CONSTRAINT "modeling_revision_initial_parent_valid" CHECK (("modeling_revision"."revision_number" = 1 and "modeling_revision"."parent_revision_id" is null) or ("modeling_revision"."revision_number" > 1 and "modeling_revision"."parent_revision_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "modeling_validation_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid,
	"scope_key" text NOT NULL,
	"kind" "modeling_validation_kind" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "modeling_validation_status" DEFAULT 'reserved' NOT NULL,
	"reserved_compute_ms" integer NOT NULL,
	"consumed_compute_ms" integer DEFAULT 0 NOT NULL,
	"actual_duration_ms" integer,
	"lease_token" text NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"kernel_version" text,
	"error_status" integer,
	"error_code" text,
	"error_message" text,
	"error_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "modeling_validation_attempt_scope_valid" CHECK (("modeling_validation_attempt"."kind" = 'project_create' and "modeling_validation_attempt"."project_id" is null and "modeling_validation_attempt"."scope_key" = 'account') or ("modeling_validation_attempt"."kind" = 'operation_batch' and "modeling_validation_attempt"."scope_key" <> 'account')),
	CONSTRAINT "modeling_validation_attempt_idempotency_not_blank" CHECK (length(btrim("modeling_validation_attempt"."idempotency_key")) > 0),
	CONSTRAINT "modeling_validation_attempt_lease_token_not_blank" CHECK (length(btrim("modeling_validation_attempt"."lease_token")) > 0),
	CONSTRAINT "modeling_validation_attempt_request_hash_valid" CHECK ("modeling_validation_attempt"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "modeling_validation_attempt_reserved_compute_positive" CHECK ("modeling_validation_attempt"."reserved_compute_ms" > 0),
	CONSTRAINT "modeling_validation_attempt_actual_duration_valid" CHECK ("modeling_validation_attempt"."actual_duration_ms" is null or "modeling_validation_attempt"."actual_duration_ms" >= 0),
	CONSTRAINT "modeling_validation_attempt_consumed_compute_valid" CHECK ("modeling_validation_attempt"."consumed_compute_ms" >= 0),
	CONSTRAINT "modeling_validation_attempt_error_status_valid" CHECK ("modeling_validation_attempt"."error_status" is null or "modeling_validation_attempt"."error_status" between 400 and 599),
	CONSTRAINT "modeling_validation_attempt_completion_shape_valid" CHECK (("modeling_validation_attempt"."status" = 'reserved' and "modeling_validation_attempt"."completed_at" is null and "modeling_validation_attempt"."actual_duration_ms" is null and "modeling_validation_attempt"."reservation_expires_at" is not null and "modeling_validation_attempt"."error_status" is null and "modeling_validation_attempt"."error_code" is null and "modeling_validation_attempt"."error_message" is null) or ("modeling_validation_attempt"."status" = 'succeeded' and "modeling_validation_attempt"."completed_at" is not null and "modeling_validation_attempt"."actual_duration_ms" is not null and "modeling_validation_attempt"."reservation_expires_at" is null and "modeling_validation_attempt"."error_status" is null and "modeling_validation_attempt"."error_code" is null and "modeling_validation_attempt"."error_message" is null) or ("modeling_validation_attempt"."status" = 'failed' and "modeling_validation_attempt"."completed_at" is not null and "modeling_validation_attempt"."actual_duration_ms" is not null and "modeling_validation_attempt"."reservation_expires_at" is null and "modeling_validation_attempt"."error_status" is not null and "modeling_validation_attempt"."error_code" is not null and "modeling_validation_attempt"."error_message" is not null))
);
--> statement-breakpoint
ALTER TABLE "modeling_artifact" ADD CONSTRAINT "modeling_artifact_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_artifact" ADD CONSTRAINT "modeling_artifact_job_id_modeling_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."modeling_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_artifact" ADD CONSTRAINT "modeling_artifact_revision_id_modeling_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_artifact" ADD CONSTRAINT "modeling_artifact_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_import_intent" ADD CONSTRAINT "modeling_import_intent_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_import_intent" ADD CONSTRAINT "modeling_import_intent_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_import_intent" ADD CONSTRAINT "modeling_import_intent_import_job_id_modeling_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."modeling_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_job" ADD CONSTRAINT "modeling_job_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_job" ADD CONSTRAINT "modeling_job_plan_id_modeling_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."modeling_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_job" ADD CONSTRAINT "modeling_job_revision_id_modeling_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_job" ADD CONSTRAINT "modeling_job_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_job_event" ADD CONSTRAINT "modeling_job_event_job_id_modeling_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."modeling_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_plan" ADD CONSTRAINT "modeling_plan_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_plan" ADD CONSTRAINT "modeling_plan_base_revision_id_modeling_revision_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_plan" ADD CONSTRAINT "modeling_plan_confirmed_revision_id_modeling_revision_id_fk" FOREIGN KEY ("confirmed_revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_plan" ADD CONSTRAINT "modeling_plan_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_project" ADD CONSTRAINT "modeling_project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_project" ADD CONSTRAINT "modeling_project_current_revision_id_modeling_revision_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_revision" ADD CONSTRAINT "modeling_revision_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_revision" ADD CONSTRAINT "modeling_revision_parent_revision_id_modeling_revision_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."modeling_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_revision" ADD CONSTRAINT "modeling_revision_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_validation_attempt" ADD CONSTRAINT "modeling_validation_attempt_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modeling_validation_attempt" ADD CONSTRAINT "modeling_validation_attempt_project_id_modeling_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."modeling_project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_artifact_object_key_unique" ON "modeling_artifact" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "modeling_artifact_project_created_idx" ON "modeling_artifact" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_artifact_job_idx" ON "modeling_artifact" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "modeling_artifact_revision_idx" ON "modeling_artifact" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "modeling_artifact_expires_idx" ON "modeling_artifact" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "modeling_artifact_cleanup_claim_idx" ON "modeling_artifact" USING btree ("expires_at","cleanup_next_attempt_at","cleanup_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_import_intent_owner_project_idempotency_unique" ON "modeling_import_intent" USING btree ("owner_id","project_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_import_intent_object_key_unique" ON "modeling_import_intent" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_import_intent_import_job_unique" ON "modeling_import_intent" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX "modeling_import_intent_project_created_idx" ON "modeling_import_intent" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_import_intent_owner_expires_idx" ON "modeling_import_intent" USING btree ("owner_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_job_project_kind_idempotency_unique" ON "modeling_job" USING btree ("project_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "modeling_job_project_created_idx" ON "modeling_job" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_job_status_lease_idx" ON "modeling_job" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "modeling_job_plan_idx" ON "modeling_job" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "modeling_job_revision_idx" ON "modeling_job" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_job_event_job_sequence_unique" ON "modeling_job_event" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "modeling_job_event_job_created_idx" ON "modeling_job_event" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_plan_project_idempotency_unique" ON "modeling_plan" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "modeling_plan_project_created_idx" ON "modeling_plan" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_plan_project_status_idx" ON "modeling_plan" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "modeling_plan_base_revision_idx" ON "modeling_plan" USING btree ("base_revision_id");--> statement-breakpoint
CREATE INDEX "modeling_plan_confirmed_revision_idx" ON "modeling_plan" USING btree ("confirmed_revision_id");--> statement-breakpoint
CREATE INDEX "modeling_project_owner_updated_idx" ON "modeling_project" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_project_owner_idempotency_unique" ON "modeling_project" USING btree ("owner_id","create_idempotency_key");--> statement-breakpoint
CREATE INDEX "modeling_project_current_revision_idx" ON "modeling_project" USING btree ("current_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_revision_project_number_unique" ON "modeling_revision" USING btree ("project_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_revision_project_idempotency_unique" ON "modeling_revision" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "modeling_revision_project_created_idx" ON "modeling_revision" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_revision_parent_idx" ON "modeling_revision" USING btree ("parent_revision_id");--> statement-breakpoint
CREATE INDEX "modeling_revision_project_hash_idx" ON "modeling_revision" USING btree ("project_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "modeling_validation_attempt_scope_idempotency_unique" ON "modeling_validation_attempt" USING btree ("owner_id","scope_key","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "modeling_validation_attempt_owner_created_idx" ON "modeling_validation_attempt" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "modeling_validation_attempt_project_idx" ON "modeling_validation_attempt" USING btree ("project_id");