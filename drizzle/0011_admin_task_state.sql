CREATE TABLE "admin_task_state" (
	"task_key" text PRIMARY KEY NOT NULL,
	"assignee_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"note" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_task_state_status_valid" CHECK ("admin_task_state"."status" in ('open', 'in_progress', 'done')),
	CONSTRAINT "admin_task_state_revision_non_negative" CHECK ("admin_task_state"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_task_state" ADD CONSTRAINT "admin_task_state_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_task_state" ADD CONSTRAINT "admin_task_state_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_task_state_assignee_status_idx" ON "admin_task_state" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "admin_task_state_due_idx" ON "admin_task_state" USING btree ("due_at");