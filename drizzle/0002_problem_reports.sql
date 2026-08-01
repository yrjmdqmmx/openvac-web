-- Drizzle applies this migration in one PostgreSQL transaction.

ALTER TABLE "consultation" RENAME TO "problem_report";
ALTER TABLE "problem_report" RENAME COLUMN "problem" TO "description";
ALTER TABLE "problem_report" RENAME COLUMN "contact_method" TO "contact_type";
ALTER TABLE "problem_report" RENAME COLUMN "resolved_at" TO "closed_at";

ALTER TABLE "problem_report" DROP CONSTRAINT "consultation_status_valid";
ALTER TABLE "problem_report" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "problem_report" ALTER COLUMN "contact_type" DROP NOT NULL;
ALTER TABLE "problem_report" ALTER COLUMN "contact_value" DROP NOT NULL;

ALTER TABLE "problem_report" ADD COLUMN "message_id" uuid;
ALTER TABLE "problem_report" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;
ALTER TABLE "problem_report" ADD COLUMN "include_context" boolean DEFAULT true NOT NULL;
ALTER TABLE "problem_report" ADD COLUMN "consent_to_contact" boolean DEFAULT false NOT NULL;
ALTER TABLE "problem_report" ADD COLUMN "retention_until" timestamp with time zone;
ALTER TABLE "problem_report" ADD COLUMN "contact_purge_at" timestamp with time zone;

UPDATE "problem_report"
SET
  "context" = coalesce("context", '{}'::jsonb)
    || jsonb_build_object('summary', "conversation_summary")
    || CASE
      WHEN char_length("description") > 3000
        THEN jsonb_build_object('legacyDescription', "description")
      ELSE '{}'::jsonb
    END,
  "description" = left("description", 3000),
  "contact_value" = CASE
    WHEN "contact_type" IN ('email', 'phone', 'wechat') THEN "contact_value"
    ELSE NULL
  END,
  "contact_type" = CASE
    WHEN "contact_type" IN ('email', 'phone', 'wechat') THEN "contact_type"
    ELSE NULL
  END,
  "consent_to_contact" = "confirmed_at" IS NOT NULL,
  "status" = CASE
    WHEN "status" IN ('pending', 'submitted') THEN 'new'
    WHEN "status" IN ('in_progress', 'contacting') THEN 'reviewing'
    WHEN "status" IN ('resolved', 'closed') THEN 'closed'
    ELSE 'new'
  END,
  "retention_until" = "created_at" + interval '4320 hours',
  "contact_purge_at" = CASE
    WHEN "status" IN ('resolved', 'closed') AND "closed_at" IS NOT NULL
      THEN "closed_at" + interval '720 hours'
    ELSE NULL
  END;

ALTER TABLE "problem_report" ALTER COLUMN "retention_until" SET NOT NULL;
ALTER TABLE "problem_report" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "problem_report" ALTER COLUMN "include_context" SET DEFAULT false;
ALTER TABLE "problem_report" ALTER COLUMN "status" SET DEFAULT 'new';

ALTER TABLE "problem_report" DROP COLUMN "contact_name";
ALTER TABLE "problem_report" DROP COLUMN "company_name";
ALTER TABLE "problem_report" DROP COLUMN "conversation_summary";
ALTER TABLE "problem_report" DROP COLUMN "confirmed_at";
ALTER TABLE "problem_report" DROP COLUMN "assigned_to";

ALTER TABLE "problem_report"
  RENAME CONSTRAINT "consultation_pkey"
  TO "problem_report_pkey";
ALTER TABLE "problem_report"
  RENAME CONSTRAINT "consultation_user_id_user_id_fk"
  TO "problem_report_user_id_user_id_fk";
ALTER TABLE "problem_report"
  RENAME CONSTRAINT "consultation_conversation_id_conversation_id_fk"
  TO "problem_report_conversation_id_conversation_id_fk";
ALTER TABLE "problem_report"
  ADD CONSTRAINT "problem_report_message_id_message_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "public"."message"("id")
  ON DELETE set null ON UPDATE no action;

ALTER INDEX "consultation_user_created_idx"
  RENAME TO "problem_report_user_created_idx";
ALTER INDEX "consultation_status_created_idx"
  RENAME TO "problem_report_status_created_idx";

CREATE INDEX "problem_report_retention_idx"
  ON "problem_report" USING btree ("retention_until");
CREATE INDEX "problem_report_contact_purge_idx"
  ON "problem_report" USING btree ("contact_purge_at");

ALTER TABLE "problem_report" ADD CONSTRAINT "problem_report_status_valid"
  CHECK ("problem_report"."status" in ('new', 'reviewing', 'closed'));
ALTER TABLE "problem_report" ADD CONSTRAINT "problem_report_category_valid"
  CHECK ("problem_report"."category" in ('answer_incorrect', 'citation_problem', 'unsafe_answer', 'system_error', 'product_suggestion', 'other'));
ALTER TABLE "problem_report" ADD CONSTRAINT "problem_report_description_length_valid"
  CHECK (char_length("problem_report"."description") between 1 and 3000);
ALTER TABLE "problem_report" ADD CONSTRAINT "problem_report_contact_type_valid"
  CHECK ("problem_report"."contact_type" is null or "problem_report"."contact_type" in ('email', 'phone', 'wechat'));
ALTER TABLE "problem_report" ADD CONSTRAINT "problem_report_contact_pair_valid"
  CHECK (("problem_report"."contact_type" is null and "problem_report"."contact_value" is null) or ("problem_report"."contact_type" is not null and "problem_report"."contact_value" is not null and "problem_report"."consent_to_contact" = true));
