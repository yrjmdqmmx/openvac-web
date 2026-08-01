ALTER TABLE "problem_report" ADD COLUMN "client_request_id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
UPDATE "problem_report"
SET "client_request_id" = gen_random_uuid()
WHERE "client_request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "problem_report"
  ALTER COLUMN "client_request_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "problem_report_user_client_request_unique"
  ON "problem_report" USING btree ("user_id", "client_request_id");
