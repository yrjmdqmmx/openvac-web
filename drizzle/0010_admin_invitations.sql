CREATE TABLE "admin_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "admin_role_name" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_invitation_email_normalized" CHECK ("admin_invitation"."email" = lower("admin_invitation"."email")),
	CONSTRAINT "admin_invitation_token_hash_sha256" CHECK ("admin_invitation"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "admin_invitation_state_shape_valid" CHECK ((
        "admin_invitation"."accepted_at" is null and "admin_invitation"."accepted_by" is null and "admin_invitation"."revoked_at" is null
      ) or (
        "admin_invitation"."accepted_at" is not null and "admin_invitation"."accepted_by" is not null and "admin_invitation"."revoked_at" is null
      ) or (
        "admin_invitation"."revoked_at" is not null and "admin_invitation"."accepted_at" is null and "admin_invitation"."accepted_by" is null
      )),
	CONSTRAINT "admin_invitation_expires_after_created" CHECK ("admin_invitation"."expires_at" > "admin_invitation"."created_at")
);
--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_invitation" ADD CONSTRAINT "admin_invitation_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_invitation_token_hash_unique" ON "admin_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_invitation_email_idx" ON "admin_invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "admin_invitation_role_idx" ON "admin_invitation" USING btree ("role");--> statement-breakpoint
CREATE INDEX "admin_invitation_created_by_idx" ON "admin_invitation" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "admin_invitation_pending_idx" ON "admin_invitation" USING btree ("revoked_at","accepted_at","expires_at");--> statement-breakpoint
DO $openvac$
DECLARE
  conflict_count integer;
BEGIN
  SELECT count(*) INTO conflict_count
  FROM (
    SELECT user_id
    FROM admin_role
    GROUP BY user_id
    HAVING count(*) > 1
  ) AS conflicting_users;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'admin_role contains % users with multiple roles; run pnpm admin:report-role-conflicts before retrying', conflict_count
      USING ERRCODE = '23514';
  END IF;
END
$openvac$;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_user_id_unique" ON "admin_role" USING btree ("user_id");
