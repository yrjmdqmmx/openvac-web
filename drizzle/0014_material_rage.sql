CREATE TYPE "public"."chat_artifact_format" AS ENUM('md', 'docx', 'pdf', 'csv');--> statement-breakpoint
CREATE TYPE "public"."chat_artifact_kind" AS ENUM('diagnosis_report', 'selection_report', 'inspection_checklist', 'parameter_table');--> statement-breakpoint
CREATE TYPE "public"."chat_artifact_status" AS ENUM('generating', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."chat_attachment_kind" AS ENUM('document', 'image');--> statement-breakpoint
CREATE TYPE "public"."chat_attachment_parse_status" AS ENUM('not_required', 'queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_attachment_status" AS ENUM('initiated', 'uploading', 'scanning', 'processing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."chat_storage_deletion_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_storage_deletion_status" AS ENUM('active', 'queued', 'deleting', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_storage_object_type" AS ENUM('attachment', 'artifact');--> statement-breakpoint
CREATE TYPE "public"."chat_storage_quota_state" AS ENUM('reserved', 'committed', 'released');--> statement-breakpoint
CREATE TABLE "chat_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"source_turn_id" uuid NOT NULL,
	"kind" "chat_artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"status" "chat_artifact_status" DEFAULT 'generating' NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chat_artifact_title_valid" CHECK (char_length("chat_artifact"."title") between 1 and 240)
);
--> statement-breakpoint
CREATE TABLE "chat_artifact_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"format" "chat_artifact_format" NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"quota_state" "chat_storage_quota_state" DEFAULT 'committed' NOT NULL,
	"deletion_status" "chat_storage_deletion_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chat_artifact_file_size_valid" CHECK ("chat_artifact_file"."size_bytes" > 0 and "chat_artifact_file"."size_bytes" <= 524288000),
	CONSTRAINT "chat_artifact_file_sha256_valid" CHECK ("chat_artifact_file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chat_artifact_file_object_key_valid" CHECK ("chat_artifact_file"."object_key" ~ '^private/chat-artifacts/[A-Za-z0-9][A-Za-z0-9._/-]*$' and "chat_artifact_file"."object_key" !~ '(^|/)\.\.(/|$)' and "chat_artifact_file"."object_key" !~ '//')
);
--> statement-breakpoint
CREATE TABLE "chat_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" "chat_attachment_kind" NOT NULL,
	"status" "chat_attachment_status" DEFAULT 'initiated' NOT NULL,
	"parse_status" "chat_attachment_parse_status" DEFAULT 'queued' NOT NULL,
	"quota_state" "chat_storage_quota_state" DEFAULT 'reserved' NOT NULL,
	"deletion_status" "chat_storage_deletion_status" DEFAULT 'active' NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"size_bytes" bigint,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"object_etag" text,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"orphan_expires_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"parse_provider" text,
	"parse_job_id" text,
	"parse_attempts" integer DEFAULT 0 NOT NULL,
	"parse_max_attempts" integer DEFAULT 3 NOT NULL,
	"parse_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_locked_at" timestamp with time zone,
	"parse_locked_by" text,
	"parse_lease_token" uuid,
	"failure_code" text,
	"failure_message" text,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_attachment_mime_type_valid" CHECK ("chat_attachment"."mime_type" in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png')),
	CONSTRAINT "chat_attachment_size_valid" CHECK ("chat_attachment"."declared_size_bytes" > 0 and "chat_attachment"."declared_size_bytes" <= 26214400 and ("chat_attachment"."size_bytes" is null or ("chat_attachment"."size_bytes" > 0 and "chat_attachment"."size_bytes" <= 26214400))),
	CONSTRAINT "chat_attachment_sha256_valid" CHECK ("chat_attachment"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "chat_attachment_object_key_valid" CHECK ("chat_attachment"."object_key" ~ '^private/chat-attachments/[A-Za-z0-9][A-Za-z0-9._/-]*$' and "chat_attachment"."object_key" !~ '(^|/)\.\.(/|$)' and "chat_attachment"."object_key" !~ '//'),
	CONSTRAINT "chat_attachment_kind_mime_valid" CHECK (("chat_attachment"."kind" = 'image' and "chat_attachment"."mime_type" in ('image/jpeg', 'image/png')) or ("chat_attachment"."kind" = 'document' and "chat_attachment"."mime_type" not in ('image/jpeg', 'image/png'))),
	CONSTRAINT "chat_attachment_quota_state_valid" CHECK (("chat_attachment"."quota_state" = 'reserved' and "chat_attachment"."size_bytes" is null) or ("chat_attachment"."quota_state" = 'committed' and "chat_attachment"."size_bytes" is not null) or "chat_attachment"."quota_state" = 'released'),
	CONSTRAINT "chat_attachment_parse_attempts_valid" CHECK ("chat_attachment"."parse_attempts" >= 0 and "chat_attachment"."parse_max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "chat_attachment_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_attachment_chunk_content_valid" CHECK ("chat_attachment_chunk"."ordinal" >= 0 and char_length("chat_attachment_chunk"."content") > 0 and "chat_attachment_chunk"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "chat_storage_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"limit_bytes" bigint DEFAULT 524288000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_storage_account_bytes_valid" CHECK ("chat_storage_account"."used_bytes" >= 0 and "chat_storage_account"."reserved_bytes" >= 0 and "chat_storage_account"."limit_bytes" > 0 and "chat_storage_account"."used_bytes" + "chat_storage_account"."reserved_bytes" <= "chat_storage_account"."limit_bytes")
);
--> statement-breakpoint
CREATE TABLE "chat_storage_deletion_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"object_type" "chat_storage_object_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"status" "chat_storage_deletion_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_token" uuid,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_storage_deletion_job_attempts_valid" CHECK ("chat_storage_deletion_job"."attempts" >= 0 and "chat_storage_deletion_job"."max_attempts" > 0),
	CONSTRAINT "chat_storage_deletion_job_key_valid" CHECK ("chat_storage_deletion_job"."object_key" ~ '^private/chat-(attachments|artifacts)/[A-Za-z0-9][A-Za-z0-9._/-]*$' and "chat_storage_deletion_job"."object_key" !~ '(^|/)\.\.(/|$)' and "chat_storage_deletion_job"."object_key" !~ '//')
);
--> statement-breakpoint
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_artifact_file" ADD CONSTRAINT "chat_artifact_file_artifact_id_chat_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."chat_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment" ADD CONSTRAINT "chat_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachment_chunk" ADD CONSTRAINT "chat_attachment_chunk_attachment_id_chat_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."chat_attachment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_storage_account" ADD CONSTRAINT "chat_storage_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_storage_deletion_job" ADD CONSTRAINT "chat_storage_deletion_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_artifact_user_created_idx" ON "chat_artifact" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_artifact_conversation_created_idx" ON "chat_artifact" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_artifact_message_idx" ON "chat_artifact" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_artifact_source_turn_idx" ON "chat_artifact" USING btree ("source_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_artifact_file_format_unique" ON "chat_artifact_file" USING btree ("artifact_id","format");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_artifact_file_object_key_unique" ON "chat_artifact_file" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_attachment_object_key_unique" ON "chat_attachment" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "chat_attachment_user_status_idx" ON "chat_attachment" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "chat_attachment_conversation_created_idx" ON "chat_attachment" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_attachment_message_idx" ON "chat_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_attachment_parse_queue_idx" ON "chat_attachment" USING btree ("parse_status","parse_run_at") WHERE "chat_attachment"."deletion_status" = 'active';--> statement-breakpoint
CREATE INDEX "chat_attachment_orphan_expiry_idx" ON "chat_attachment" USING btree ("orphan_expires_at") WHERE "chat_attachment"."message_id" is null and "chat_attachment"."deletion_status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_attachment_chunk_ordinal_unique" ON "chat_attachment_chunk" USING btree ("attachment_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_storage_deletion_job_object_key_unique" ON "chat_storage_deletion_job" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "chat_storage_deletion_job_queue_idx" ON "chat_storage_deletion_job" USING btree ("status","run_at","created_at");--> statement-breakpoint
CREATE INDEX "chat_storage_deletion_job_user_idx" ON "chat_storage_deletion_job" USING btree ("user_id");
