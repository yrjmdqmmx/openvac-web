UPDATE "message"
SET "metadata" = "metadata" - 'modelingCards'
WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'modelingCards';
--> statement-breakpoint
UPDATE "modeling_project"
SET "current_revision_id" = NULL;
--> statement-breakpoint
ALTER TABLE "modeling_project" DROP CONSTRAINT "modeling_project_current_revision_id_modeling_revision_id_fk";
--> statement-breakpoint
DROP TABLE "modeling_artifact";
--> statement-breakpoint
DROP TABLE "modeling_import_intent";
--> statement-breakpoint
DROP TABLE "modeling_job_event";
--> statement-breakpoint
DROP TABLE "modeling_validation_attempt";
--> statement-breakpoint
DROP TABLE "modeling_job";
--> statement-breakpoint
DROP TABLE "modeling_plan";
--> statement-breakpoint
DROP TABLE "modeling_revision";
--> statement-breakpoint
DROP TABLE "modeling_project";
--> statement-breakpoint
DROP TYPE "public"."modeling_artifact_kind";
--> statement-breakpoint
DROP TYPE "public"."modeling_job_kind";
--> statement-breakpoint
DROP TYPE "public"."modeling_job_status";
--> statement-breakpoint
DROP TYPE "public"."modeling_plan_status";
--> statement-breakpoint
DROP TYPE "public"."modeling_revision_source";
--> statement-breakpoint
DROP TYPE "public"."modeling_validation_kind";
--> statement-breakpoint
DROP TYPE "public"."modeling_validation_status";
