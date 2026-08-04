CREATE TYPE "public"."agent_requested_mode" AS ENUM('auto', 'deep');--> statement-breakpoint
CREATE TYPE "public"."agent_resolved_mode" AS ENUM('fast', 'deep');--> statement-breakpoint
CREATE TYPE "public"."agent_run_action" AS ENUM('initial', 'retry', 'regenerate', 'continue');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('pending', 'running', 'completed', 'incomplete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_tool_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_web_mode" AS ENUM('auto', 'always');--> statement-breakpoint
CREATE TYPE "public"."memory_kind" AS ENUM('equipment', 'operating_context', 'unit_preference');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."web_trust_tier" AS ENUM('tier_a', 'tier_b', 'tier_c', 'blocked');--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'incomplete' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"client_request_id" text NOT NULL,
	"version" integer NOT NULL,
	"action" "agent_run_action" DEFAULT 'initial' NOT NULL,
	"protocol" text DEFAULT 'responses' NOT NULL,
	"model" text NOT NULL,
	"requested_mode" "agent_requested_mode" DEFAULT 'auto' NOT NULL,
	"resolved_mode" "agent_resolved_mode" DEFAULT 'fast' NOT NULL,
	"web_mode" "agent_web_mode" DEFAULT 'auto' NOT NULL,
	"status" "agent_run_status" DEFAULT 'pending' NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"answer_payload" jsonb,
	"context_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_round_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"model_request_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"repair_count" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_version_positive" CHECK ("agent_run"."version" > 0),
	CONSTRAINT "agent_run_tool_round_count_non_negative" CHECK ("agent_run"."tool_round_count" >= 0),
	CONSTRAINT "agent_run_tool_call_count_non_negative" CHECK ("agent_run"."tool_call_count" >= 0),
	CONSTRAINT "agent_run_model_request_count_non_negative" CHECK ("agent_run"."model_request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"sequence" integer NOT NULL,
	"provider_call_id" text,
	"tool_name" text NOT NULL,
	"arguments_digest" text NOT NULL,
	"result_digest" text,
	"sanitized_preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"citation_ids" text[] DEFAULT '{}' NOT NULL,
	"status" "agent_tool_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_call_round_positive" CHECK ("agent_tool_call"."round" > 0),
	CONSTRAINT "agent_tool_call_sequence_positive" CHECK ("agent_tool_call"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_memory" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"confirmed_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unresolved_questions" text[] DEFAULT '{}' NOT NULL,
	"through_sequence" integer DEFAULT 0 NOT NULL,
	"source_message_ids" uuid[] DEFAULT '{}' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"selected_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"label" text NOT NULL,
	"facts" jsonb NOT NULL,
	"source_message_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_memory_label_length" CHECK (char_length("user_memory"."label") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "web_domain_policy" (
	"domain" text PRIMARY KEY NOT NULL,
	"trust_tier" "web_trust_tier" DEFAULT 'tier_c' NOT NULL,
	"license_class" text DEFAULT 'unknown' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citation" ADD COLUMN "trust_tier" text;--> statement-breakpoint
ALTER TABLE "citation" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "answer_schema_version" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "answer_payload" jsonb;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "protocol" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "phase" text DEFAULT 'answer' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "retry_of_id" uuid;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "cache_hit_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "cache_miss_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "first_event_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "provider_http_status" integer;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "provider_error_code" text;--> statement-breakpoint
ALTER TABLE "model_invocation" ADD COLUMN "price_version" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_turn_id_conversation_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_assistant_message_id_message_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_call" ADD CONSTRAINT "agent_tool_call_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_memory" ADD CONSTRAINT "conversation_memory_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_user_message_id_message_id_fk" FOREIGN KEY ("user_message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_domain_policy" ADD CONSTRAINT "web_domain_policy_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_user_client_request_unique" ON "agent_run" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_turn_version_unique" ON "agent_run" USING btree ("turn_id","version");--> statement-breakpoint
CREATE INDEX "agent_run_turn_status_idx" ON "agent_run" USING btree ("turn_id","status");--> statement-breakpoint
CREATE INDEX "agent_run_user_created_idx" ON "agent_run" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_call_run_sequence_unique" ON "agent_tool_call" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_call_idempotency_unique" ON "agent_tool_call" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_tool_call_expiry_idx" ON "agent_tool_call" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turn_conversation_ordinal_unique" ON "conversation_turn" USING btree ("conversation_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turn_user_message_unique" ON "conversation_turn" USING btree ("user_message_id");--> statement-breakpoint
CREATE INDEX "conversation_turn_selected_run_idx" ON "conversation_turn" USING btree ("selected_run_id");--> statement-breakpoint
CREATE INDEX "user_memory_user_status_idx" ON "user_memory" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "model_invocation_agent_run_idx" ON "model_invocation" USING btree ("agent_run_id");--> statement-breakpoint
INSERT INTO "web_domain_policy" ("domain", "trust_tier", "license_class", "enabled", "metadata") VALUES
	('nist.gov', 'tier_a', 'public_domain', true, '{"seed":"agent_v2"}'::jsonb),
	('hse.gov.uk', 'tier_a', 'public_domain', true, '{"seed":"agent_v2"}'::jsonb),
	('iso.org', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('cern.ch', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('leybold.com', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('leybold.cn', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('pfeiffer-vacuum.com', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('edwardsvacuum.com', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('buschvacuum.com', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb),
	('atlascopco.com', 'tier_a', 'metadata_only', true, '{"seed":"agent_v2"}'::jsonb)
ON CONFLICT ("domain") DO NOTHING;
