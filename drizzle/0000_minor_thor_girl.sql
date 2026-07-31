CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."citation_source_type" AS ENUM('knowledge', 'web', 'manual');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('feedback', 'report');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('helpful', 'not_helpful');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'streaming', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_kind" AS ENUM('upload', 'manual', 'manufacturer', 'standard', 'web');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_tier" AS ENUM('open_license', 'manufacturer_metadata', 'standard_metadata', 'internal');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('draft', 'processing', 'review', 'published', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."admin_role_name" AS ENUM('owner', 'admin', 'knowledge_editor', 'support', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."invocation_purpose" AS ENUM('answer', 'embedding', 'ocr', 'web_search', 'evaluation');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."quota_entry_status" AS ENUM('reserved', 'committed', 'released');--> statement-breakpoint
CREATE TYPE "public"."quota_resource" AS ENUM('answer', 'web_search');--> statement-breakpoint
CREATE TYPE "public"."quota_scope" AS ENUM('user', 'global');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_count_non_negative" CHECK ("rate_limit"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"daily_quota_bonus" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_daily_quota_bonus_non_negative" CHECK ("user"."daily_quota_bonus" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "citation_source_type" NOT NULL,
	"knowledge_chunk_id" uuid,
	"title" text NOT NULL,
	"url" text,
	"quote" text,
	"source_tier" text,
	"license" text,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" uuid,
	"status" text DEFAULT 'submitted' NOT NULL,
	"contact_name" text NOT NULL,
	"company_name" text NOT NULL,
	"contact_method" text NOT NULL,
	"contact_value" text NOT NULL,
	"problem" text NOT NULL,
	"conversation_summary" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"assigned_to" text,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "consultation_status_valid" CHECK ("consultation"."status" in ('submitted', 'contacting', 'resolved', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"rating" "feedback_rating",
	"reason" text,
	"comment" text,
	"category" text,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"admin_note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_status_valid" CHECK ("message_feedback"."status" in ('open', 'reviewing', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text,
	"sequence" integer NOT NULL,
	"role" "message_role" NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"client_request_id" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_citation" (
	"message_id" uuid NOT NULL,
	"citation_id" uuid NOT NULL,
	"ordinal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"page_start" integer,
	"page_end" integer,
	"section_path" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"external_key" text,
	"title" text NOT NULL,
	"description" text,
	"language" text DEFAULT 'zh-CN' NOT NULL,
	"mime_type" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_document_status_valid" CHECK ("knowledge_document"."status" in ('draft', 'processing', 'review', 'published', 'failed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "knowledge_source_kind" DEFAULT 'manual' NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"canonical_url" text,
	"publisher" text,
	"source_tier" "knowledge_source_tier" DEFAULT 'internal' NOT NULL,
	"license_policy" text,
	"notes" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"trust_level" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text,
	"content" text DEFAULT '' NOT NULL,
	"citation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "knowledge_status" DEFAULT 'draft' NOT NULL,
	"object_key" text,
	"parser_version" text,
	"source_updated_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_version_content_hash_valid" CHECK ("knowledge_version"."content_hash" is null or "knowledge_version"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "admin_role" (
	"user_id" text NOT NULL,
	"role" "admin_role_name" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_role_primary" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"request_id" text,
	"ip_address" text,
	"user_agent" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "operation_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_token" uuid,
	"last_error" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_task_attempts_non_negative" CHECK ("background_task"."attempts" >= 0),
	CONSTRAINT "background_task_max_attempts_positive" CHECK ("background_task"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_invocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"conversation_id" uuid,
	"message_id" uuid,
	"client_request_id" text,
	"purpose" "invocation_purpose" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"provider_request_id" text,
	"status" "operation_status" DEFAULT 'running' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cost_micros" bigint,
	"latency_ms" integer,
	"request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_eval_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_eval_case_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "prompt_eval_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" "operation_status" DEFAULT 'queued' NOT NULL,
	"score" double precision,
	"output" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_eval_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "operation_status" DEFAULT 'queued' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"initiated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_template_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "prompt_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_status_valid" CHECK ("prompt_versions"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by_user_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_primary" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "quota_bucket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" "quota_resource" NOT NULL,
	"scope_type" "quota_scope" NOT NULL,
	"scope_key" text NOT NULL,
	"window_key" date NOT NULL,
	"limit_value" integer NOT NULL,
	"reserved_units" integer DEFAULT 0 NOT NULL,
	"committed_units" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_bucket_limit_positive" CHECK ("quota_bucket"."limit_value" > 0),
	CONSTRAINT "quota_bucket_counts_non_negative" CHECK ("quota_bucket"."reserved_units" >= 0 and "quota_bucket"."committed_units" >= 0),
	CONSTRAINT "quota_bucket_within_limit" CHECK ("quota_bucket"."reserved_units" + "quota_bucket"."committed_units" <= "quota_bucket"."limit_value")
);
--> statement-breakpoint
CREATE TABLE "quota_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"bucket_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"resource" "quota_resource" NOT NULL,
	"scope_type" "quota_scope" NOT NULL,
	"scope_key" text NOT NULL,
	"window_key" date NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"status" "quota_entry_status" DEFAULT 'reserved' NOT NULL,
	"release_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_ledger_units_positive" CHECK ("quota_ledger"."units" > 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_knowledge_chunk_id_knowledge_chunk_id_fk" FOREIGN KEY ("knowledge_chunk_id") REFERENCES "public"."knowledge_chunk"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation" ADD CONSTRAINT "consultation_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citation" ADD CONSTRAINT "message_citation_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_citation" ADD CONSTRAINT "message_citation_citation_id_citation_id_fk" FOREIGN KEY ("citation_id") REFERENCES "public"."citation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_version_id_knowledge_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_current_version_id_knowledge_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document" ADD CONSTRAINT "knowledge_document_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source" ADD CONSTRAINT "knowledge_source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_version" ADD CONSTRAINT "knowledge_version_document_id_knowledge_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_version" ADD CONSTRAINT "knowledge_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role" ADD CONSTRAINT "admin_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role" ADD CONSTRAINT "admin_role_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_task" ADD CONSTRAINT "background_task_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD CONSTRAINT "model_invocation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD CONSTRAINT "model_invocation_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD CONSTRAINT "model_invocation_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_case" ADD CONSTRAINT "prompt_eval_case_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_result" ADD CONSTRAINT "prompt_eval_result_run_id_prompt_eval_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."prompt_eval_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_result" ADD CONSTRAINT "prompt_eval_result_case_id_prompt_eval_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."prompt_eval_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_run" ADD CONSTRAINT "prompt_eval_run_prompt_version_id_prompt_version_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_run" ADD CONSTRAINT "prompt_eval_run_initiated_by_user_id_user_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_assigned_by_user_id_user_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_bucket_id_quota_bucket_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."quota_bucket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_key_unique" ON "rate_limit" USING btree ("key");--> statement-breakpoint
CREATE INDEX "rate_limit_last_request_idx" ON "rate_limit" USING btree ("last_request");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "citation_chunk_idx" ON "citation" USING btree ("knowledge_chunk_id");--> statement-breakpoint
CREATE INDEX "consultation_user_created_idx" ON "consultation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "consultation_status_created_idx" ON "consultation" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "consultation_assignee_idx" ON "consultation" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "conversation_user_updated_idx" ON "conversation" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_status_idx" ON "conversation" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_user_message_kind_unique" ON "message_feedback" USING btree ("message_id","user_id","kind");--> statement-breakpoint
CREATE INDEX "feedback_rating_idx" ON "message_feedback" USING btree ("rating");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_sequence_unique" ON "message" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_client_request_unique" ON "message" USING btree ("conversation_id","client_request_id");--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_user_idx" ON "message" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "message_status_idx" ON "message" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "message_citation_message_ordinal_unique" ON "message_citation" USING btree ("message_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "message_citation_pair_unique" ON "message_citation" USING btree ("message_id","citation_id");--> statement-breakpoint
CREATE INDEX "message_citation_citation_idx" ON "message_citation" USING btree ("citation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunk_version_index_unique" ON "knowledge_chunk" USING btree ("version_id","chunk_index");--> statement-breakpoint
CREATE INDEX "knowledge_chunk_version_idx" ON "knowledge_chunk" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunk_embedding_hnsw_idx" ON "knowledge_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunk_content_fts_idx" ON "knowledge_chunk" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_document_source_external_unique" ON "knowledge_document" USING btree ("source_id","external_key");--> statement-breakpoint
CREATE INDEX "knowledge_document_status_idx" ON "knowledge_document" USING btree ("status");--> statement-breakpoint
CREATE INDEX "knowledge_document_created_by_idx" ON "knowledge_document" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "knowledge_source_kind_idx" ON "knowledge_source" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "knowledge_source_publisher_idx" ON "knowledge_source" USING btree ("publisher");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_version_document_version_unique" ON "knowledge_version" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_version_document_hash_idx" ON "knowledge_version" USING btree ("document_id","content_hash");--> statement-breakpoint
CREATE INDEX "knowledge_version_published_at_idx" ON "knowledge_version" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "admin_role_role_idx" ON "admin_role" USING btree ("role");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_created_idx" ON "audit_log" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_created_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "background_task_idempotency_unique" ON "background_task" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "background_task_queue_idx" ON "background_task" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_usage_date_provider_model_unique" ON "daily_usage" USING btree ("date","provider","model");--> statement-breakpoint
CREATE INDEX "daily_usage_date_idx" ON "daily_usage" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocation_provider_request_unique" ON "model_invocation" USING btree ("provider","provider_request_id");--> statement-breakpoint
CREATE INDEX "model_invocation_user_started_idx" ON "model_invocation" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "model_invocation_status_started_idx" ON "model_invocation" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "model_invocation_client_request_idx" ON "model_invocation" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "prompt_eval_case_enabled_idx" ON "prompt_eval_case" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_eval_result_run_case_unique" ON "prompt_eval_result" USING btree ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "prompt_eval_result_status_idx" ON "prompt_eval_result" USING btree ("status");--> statement-breakpoint
CREATE INDEX "prompt_eval_run_status_created_idx" ON "prompt_eval_run" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_version_template_version_unique" ON "prompt_version" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_version_single_active_unique" ON "prompt_version" USING btree ("template_id") WHERE "prompt_version"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_key_version_unique" ON "prompt_versions" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "prompt_versions_status_idx" ON "prompt_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_role_role_idx" ON "user_role" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_bucket_scope_window_unique" ON "quota_bucket" USING btree ("resource","scope_type","scope_key","window_key");--> statement-breakpoint
CREATE INDEX "quota_bucket_reset_at_idx" ON "quota_bucket" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_ledger_idempotency_unique" ON "quota_ledger" USING btree ("actor_user_id","resource","client_request_id","scope_type","scope_key");--> statement-breakpoint
CREATE INDEX "quota_ledger_lease_idx" ON "quota_ledger" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "quota_ledger_actor_window_idx" ON "quota_ledger" USING btree ("actor_user_id","resource","window_key");--> statement-breakpoint
CREATE INDEX "quota_ledger_status_idx" ON "quota_ledger" USING btree ("status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "openvac_release_reserved_quota_before_ledger_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'reserved' THEN
    UPDATE quota_bucket
    SET
      reserved_units = reserved_units - OLD.units,
      updated_at = NOW()
    WHERE id = OLD.bucket_id
      AND reserved_units >= OLD.units;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "quota_ledger_release_reserved_before_delete"
BEFORE DELETE ON "quota_ledger"
FOR EACH ROW
EXECUTE FUNCTION "openvac_release_reserved_quota_before_ledger_delete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "openvac_reject_admin_user_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1967086382);
  IF EXISTS (
    SELECT 1
    FROM admin_role
    WHERE user_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'administrator roles must be transferred and removed before deleting the user'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_reject_admin_delete"
BEFORE DELETE ON "user"
FOR EACH ROW
EXECUTE FUNCTION "openvac_reject_admin_user_delete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "openvac_require_owner_role"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1967086382);
  IF NOT EXISTS (
    SELECT 1
    FROM admin_role
    WHERE role = 'owner'
  ) THEN
    RAISE EXCEPTION 'at least one owner role must remain'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "admin_role_requires_owner"
AFTER INSERT OR UPDATE OR DELETE ON "admin_role"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "openvac_require_owner_role"();
