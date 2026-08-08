CREATE TYPE "public"."knowledge_section_decision_status" AS ENUM('approved', 'rejected', 'changes_requested');--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factor_failed_verification_count_non_negative" CHECK ("two_factor"."failed_verification_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_review_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"section_index" integer NOT NULL,
	"content_zh" text NOT NULL,
	"official_text" text DEFAULT '' NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"rights_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rights_snapshot_hash" text NOT NULL,
	"version_content_hash" text NOT NULL,
	"section_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_review_section_version_index_unique" UNIQUE("version_id","section_index"),
	CONSTRAINT "knowledge_review_section_index_valid" CHECK ("knowledge_review_section"."section_index" >= 0),
	CONSTRAINT "knowledge_review_section_pages_valid" CHECK (("knowledge_review_section"."page_start" is null or "knowledge_review_section"."page_start" > 0) and ("knowledge_review_section"."page_end" is null or "knowledge_review_section"."page_end" >= "knowledge_review_section"."page_start")),
	CONSTRAINT "knowledge_review_section_hash_valid" CHECK ("knowledge_review_section"."section_hash" ~ '^[0-9a-f]{64}$' and "knowledge_review_section"."rights_snapshot_hash" ~ '^[0-9a-f]{64}$' and "knowledge_review_section"."version_content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_section_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"section_hash" text NOT NULL,
	"decision" "knowledge_section_decision_status" NOT NULL,
	"note" text,
	"reviewer_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_section_decision_section_unique" UNIQUE("section_id"),
	CONSTRAINT "knowledge_section_decision_hash_valid" CHECK ("knowledge_section_decision"."section_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_section_decision_revision_valid" CHECK ("knowledge_section_decision"."revision" > 0),
	CONSTRAINT "knowledge_section_decision_note_required" CHECK ("knowledge_section_decision"."decision" = 'approved' or length(trim(coalesce("knowledge_section_decision"."note", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "avatar_object_key" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "avatar_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_review_section" ADD CONSTRAINT "knowledge_review_section_version_id_knowledge_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_section_decision" ADD CONSTRAINT "knowledge_section_decision_section_id_knowledge_review_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."knowledge_review_section"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_section_decision" ADD CONSTRAINT "knowledge_section_decision_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_id_unique" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "knowledge_review_section_version_idx" ON "knowledge_review_section" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "knowledge_section_decision_reviewer_idx" ON "knowledge_section_decision" USING btree ("reviewer_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_avatar_revision_non_negative" CHECK ("user"."avatar_revision" >= 0);