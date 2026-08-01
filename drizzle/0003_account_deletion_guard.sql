ALTER TABLE "user" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."openvac_guard_audit_user_references"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  guarded_user_id text;
  deletion_requested_at timestamp with time zone;
BEGIN
  FOR guarded_user_id IN
    SELECT DISTINCT reference.user_id
    FROM (
      VALUES
        (NEW.actor_user_id),
        (CASE WHEN NEW.target_type = 'user' THEN NEW.target_id ELSE NULL END),
        (CASE
          WHEN NEW.target_type = 'admin_role'
            THEN NEW.metadata ->> 'targetUserId'
          ELSE NULL
        END),
        (CASE
          WHEN NEW.target_type = 'admin_role'
            THEN split_part(NEW.target_id, ':', 1)
          ELSE NULL
        END)
    ) AS reference(user_id)
    WHERE reference.user_id IS NOT NULL
    ORDER BY reference.user_id
  LOOP
    deletion_requested_at := NULL;
    SELECT account.deletion_requested_at
      INTO deletion_requested_at
      FROM "public"."user" AS account
      WHERE account.id = guarded_user_id
      FOR KEY SHARE;

    IF NOT FOUND OR deletion_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'audit log references an unavailable user'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_log_user_deletion_guard"
BEFORE INSERT ON "public"."audit_log"
FOR EACH ROW
EXECUTE FUNCTION "public"."openvac_guard_audit_user_references"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."openvac_anonymize_audit_before_user_delete"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE "public"."audit_log"
  SET
    actor_user_id = CASE
      WHEN actor_user_id = OLD.id THEN NULL
      ELSE actor_user_id
    END,
    target_id = CASE
      WHEN actor_user_id = OLD.id
        OR (target_type = 'user' AND target_id = OLD.id)
        OR (
          target_type = 'admin_role'
          AND (
            split_part(coalesce(target_id, ''), ':', 1) = OLD.id
            OR metadata ->> 'targetUserId' = OLD.id
          )
        )
        THEN NULL
      ELSE target_id
    END,
    request_id = NULL,
    ip_address = NULL,
    user_agent = NULL,
    before = NULL,
    after = NULL,
    metadata = '{}'::jsonb
  WHERE actor_user_id = OLD.id
    OR (target_type = 'user' AND target_id = OLD.id)
    OR (
      target_type = 'admin_role'
      AND (
        split_part(coalesce(target_id, ''), ':', 1) = OLD.id
        OR metadata ->> 'targetUserId' = OLD.id
      )
    );

  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "user_delete_audit_anonymizer"
BEFORE DELETE ON "public"."user"
FOR EACH ROW
EXECUTE FUNCTION "public"."openvac_anonymize_audit_before_user_delete"();
