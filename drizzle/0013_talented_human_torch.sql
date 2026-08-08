CREATE TYPE "public"."knowledge_review_decision" AS ENUM('approved', 'rejected', 'needs_human');--> statement-breakpoint
CREATE TYPE "public"."knowledge_review_phase" AS ENUM('initial', 'verify');--> statement-breakpoint
CREATE TYPE "public"."knowledge_review_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."knowledge_review_run_status" AS ENUM('queued', 'leased', 'completed', 'needs_human', 'failed');--> statement-breakpoint
CREATE TABLE "knowledge_original" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"retention_policy" text DEFAULT 'retain_indefinitely' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_original_mime_type_valid" CHECK ("knowledge_original"."mime_type" in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png')),
	CONSTRAINT "knowledge_original_size_valid" CHECK ("knowledge_original"."size_bytes" > 0 and "knowledge_original"."size_bytes" <= 52428800),
	CONSTRAINT "knowledge_original_sha256_valid" CHECK ("knowledge_original"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_original_object_key_valid" CHECK ("knowledge_original"."object_key" ~ '^private/knowledge-originals/[A-Za-z0-9][A-Za-z0-9._/-]*$' and "knowledge_original"."object_key" !~ '(^|/)\.\.(/|$)' and "knowledge_original"."object_key" !~ '//'),
	CONSTRAINT "knowledge_original_retention_policy_valid" CHECK ("knowledge_original"."retention_policy" = 'retain_indefinitely')
);
--> statement-breakpoint
CREATE TABLE "knowledge_review_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase" "knowledge_review_phase" NOT NULL,
	"status" "knowledge_review_run_status" DEFAULT 'queued' NOT NULL,
	"input_version_id" uuid NOT NULL,
	"input_content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"risk" "knowledge_review_risk",
	"structured_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" "knowledge_review_decision",
	"lease_token_hash" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"revised_version_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_review_run_hashes_valid" CHECK ("knowledge_review_run"."input_content_hash" ~ '^[0-9a-f]{64}$' and ("knowledge_review_run"."lease_token_hash" is null or "knowledge_review_run"."lease_token_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "knowledge_review_run_attempts_valid" CHECK ("knowledge_review_run"."attempts" >= 0),
	CONSTRAINT "knowledge_review_run_lease_valid" CHECK (("knowledge_review_run"."status" = 'leased' and "knowledge_review_run"."lease_token_hash" is not null and "knowledge_review_run"."lease_expires_at" is not null) or ("knowledge_review_run"."status" <> 'leased' and "knowledge_review_run"."lease_token_hash" is null and "knowledge_review_run"."lease_expires_at" is null)),
	CONSTRAINT "knowledge_review_run_completion_valid" CHECK ("knowledge_review_run"."status" <> 'completed' or ("knowledge_review_run"."risk" is not null and "knowledge_review_run"."decision" is not null and "knowledge_review_run"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "knowledge_original" ADD CONSTRAINT "knowledge_original_version_id_knowledge_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_original" ADD CONSTRAINT "knowledge_original_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_review_run" ADD CONSTRAINT "knowledge_review_run_input_version_id_knowledge_version_id_fk" FOREIGN KEY ("input_version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_review_run" ADD CONSTRAINT "knowledge_review_run_revised_version_id_knowledge_version_id_fk" FOREIGN KEY ("revised_version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_original_version_unique" ON "knowledge_original" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_original_object_key_unique" ON "knowledge_original" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "knowledge_original_uploaded_by_idx" ON "knowledge_original" USING btree ("uploaded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_review_run_version_hash_prompt_phase_unique" ON "knowledge_review_run" USING btree ("input_version_id","input_content_hash","prompt_version","phase");--> statement-breakpoint
CREATE INDEX "knowledge_review_run_lease_idx" ON "knowledge_review_run" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_review_run_revised_version_idx" ON "knowledge_review_run" USING btree ("revised_version_id");