SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
CREATE TYPE "public"."agent_run_settlement_status" AS ENUM('pending', 'completed');--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "answer_quota_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "answer_quota_status" "quota_entry_status";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "settlement_status" "agent_run_settlement_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "quota_ledger"
		WHERE "resource" = 'answer'
		GROUP BY "actor_user_id", "client_request_id"
		HAVING COUNT(DISTINCT "lease_id") <> 1
			OR COUNT(DISTINCT "status") <> 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'agent answer quota backfill requires one lease and one status per request';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "quota_ledger"
		WHERE "resource" = 'answer'
		GROUP BY "lease_id"
		HAVING COUNT(DISTINCT ("actor_user_id", "client_request_id")) <> 1
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'agent answer quota backfill requires each lease to map to one request';
	END IF;
END $$;--> statement-breakpoint
WITH answer_lease AS MATERIALIZED (
	SELECT DISTINCT
		"actor_user_id", "client_request_id", "lease_id", "status"
	FROM "quota_ledger"
	WHERE "resource" = 'answer'
)
UPDATE "agent_run" run
SET "answer_quota_lease_id" = answer_lease."lease_id",
	"answer_quota_status" = answer_lease."status"
FROM answer_lease
WHERE answer_lease."actor_user_id" = run."user_id"
	AND answer_lease."client_request_id" = run."client_request_id";--> statement-breakpoint
UPDATE "agent_run"
SET "settlement_status" = 'completed'
WHERE (
	"status" = 'completed'
	AND ("answer_quota_status" = 'committed' OR "answer_quota_lease_id" IS NULL)
) OR (
	"status" IN ('incomplete', 'failed', 'cancelled')
	AND ("answer_quota_status" = 'released' OR "answer_quota_lease_id" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_answer_quota_lease_unique" ON "agent_run" USING btree ("answer_quota_lease_id") WHERE "agent_run"."answer_quota_lease_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_run_settlement_recovery_idx" ON "agent_run" USING btree ("settlement_status","status","updated_at") WHERE "agent_run"."settlement_status" = 'pending';--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_answer_quota_shape_valid" CHECK (("agent_run"."answer_quota_lease_id" is null and "agent_run"."answer_quota_status" is null) or ("agent_run"."answer_quota_lease_id" is not null and "agent_run"."answer_quota_status" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_run" VALIDATE CONSTRAINT "agent_run_answer_quota_shape_valid";
