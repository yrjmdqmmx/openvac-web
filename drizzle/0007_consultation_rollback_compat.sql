-- Keep rollback compatibility without creating a second source of truth.
-- This migration intentionally fails if an unexpected relation already owns
-- either canonical name; it never drops or replaces user data.
DO $openvac_compat_guard$
DECLARE
  problem_report_kind "char";
  consultation_kind "char";
BEGIN
  SELECT relation.relkind
    INTO problem_report_kind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'problem_report';

  SELECT relation.relkind
    INTO consultation_kind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'consultation';

  IF problem_report_kind IS DISTINCT FROM 'r'::"char" THEN
    RAISE EXCEPTION 'problem_report must be the canonical base table';
  END IF;
  IF consultation_kind IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to replace existing public.consultation relation';
  END IF;
END;
$openvac_compat_guard$;--> statement-breakpoint

-- Preserve the legacy resolved/closed distinction in non-PII report context.
-- Direct writes from the current application normalize the marker, while the
-- compatibility trigger may explicitly preserve a valid legacy status.
CREATE FUNCTION "public"."openvac_sync_consultation_rollback_status"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $openvac_status_sync$
DECLARE
  marker_key CONSTANT text := '_openvacConsultationStatus';
  compatibility_status text;
  normalized_status text;
  marker_matches boolean;
  should_normalize boolean;
BEGIN
  NEW.context := coalesce(NEW.context, '{}'::jsonb);
  compatibility_status := NEW.context ->> marker_key;
  normalized_status := CASE NEW.status
    WHEN 'new' THEN 'submitted'
    WHEN 'reviewing' THEN 'contacting'
    WHEN 'closed' THEN 'closed'
    ELSE 'submitted'
  END;
  marker_matches := coalesce(
    (NEW.status = 'new' AND compatibility_status = 'submitted')
    OR (NEW.status = 'reviewing' AND compatibility_status = 'contacting')
    OR (
      NEW.status = 'closed'
      AND compatibility_status IN ('resolved', 'closed')
    ),
    false
  );

  IF TG_OP = 'INSERT' THEN
    should_normalize := NOT marker_matches;
  ELSE
    should_normalize :=
      NEW.context IS NOT DISTINCT FROM OLD.context
      OR NOT marker_matches;
  END IF;

  IF should_normalize THEN
    NEW.context := (NEW.context - marker_key)
      || jsonb_build_object(marker_key, normalized_status);
  END IF;
  RETURN NEW;
END;
$openvac_status_sync$;--> statement-breakpoint

CREATE TRIGGER "problem_report_consultation_rollback_status_sync"
BEFORE INSERT OR UPDATE OF "status" ON "public"."problem_report"
FOR EACH ROW
EXECUTE FUNCTION "public"."openvac_sync_consultation_rollback_status"();--> statement-breakpoint

-- Migration 0002 irreversibly collapsed historical resolved/closed rows into
-- closed, so unmarked pre-0007 rows truthfully fall back to closed. Only status
-- writes observed from this migration onward can retain that legacy distinction.
-- The current deployment uses one owner for migrations and runtime. If those
-- roles are separated later, grant the runtime role access to both this view and
-- problem_report; security_invoker deliberately does not bypass base-table ACLs.
CREATE VIEW "public"."consultation"
WITH (security_invoker = true)
AS
SELECT
  report."id",
  report."user_id",
  report."conversation_id",
  CASE report."status"
    WHEN 'new' THEN 'submitted'
    WHEN 'reviewing' THEN 'contacting'
    WHEN 'closed' THEN CASE
      WHEN report."context" ->> '_openvacConsultationStatus' = 'resolved'
        THEN 'resolved'
      ELSE 'closed'
    END
    ELSE 'submitted'
  END AS "status",
  ''::text AS "contact_name",
  ''::text AS "company_name",
  coalesce(report."contact_type", '') AS "contact_method",
  coalesce(report."contact_value", '') AS "contact_value",
  coalesce(
    nullif(report."context" ->> 'legacyDescription', ''),
    report."description"
  ) AS "problem",
  coalesce(report."context" ->> 'summary', '') AS "conversation_summary",
  report."context",
  report."created_at" AS "confirmed_at",
  NULL::text AS "assigned_to",
  report."admin_note",
  report."created_at",
  report."updated_at",
  report."closed_at" AS "resolved_at"
FROM "public"."problem_report" AS report;--> statement-breakpoint

CREATE FUNCTION "public"."openvac_write_consultation_rollback_compat"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $openvac_compat_write$
DECLARE
  marker_key CONSTANT text := '_openvacConsultationStatus';
  requested_status text;
  canonical_status text;
  compatibility_context jsonb;
  compatibility_contact_type text;
  compatibility_created_at timestamp with time zone;
  compatibility_closed_at timestamp with time zone;
  stored record;
BEGIN
  requested_status := CASE
    WHEN NEW.status IN ('submitted', 'contacting', 'resolved', 'closed')
      THEN NEW.status
    ELSE 'submitted'
  END;
  canonical_status := CASE requested_status
    WHEN 'submitted' THEN 'new'
    WHEN 'contacting' THEN 'reviewing'
    ELSE 'closed'
  END;

  IF TG_OP = 'INSERT' THEN
    compatibility_created_at := coalesce(NEW.created_at, statement_timestamp());
    compatibility_closed_at := CASE
      WHEN requested_status IN ('resolved', 'closed')
        THEN coalesce(
          NEW.resolved_at,
          NEW.updated_at,
          compatibility_created_at
        )
      ELSE NULL
    END;
    compatibility_contact_type := CASE
      WHEN NEW.contact_method IN ('email', 'phone', 'wechat')
        AND nullif(btrim(NEW.contact_value), '') IS NOT NULL
        THEN NEW.contact_method
      ELSE NULL
    END;
    compatibility_context :=
      (coalesce(NEW.context, '{}'::jsonb)
        - marker_key
        - 'legacyDescription')
      || jsonb_build_object(
        'summary',
        coalesce(NEW.conversation_summary, '')
      )
      || CASE
        WHEN char_length(NEW.problem) > 3000
          THEN jsonb_build_object('legacyDescription', NEW.problem)
        ELSE '{}'::jsonb
      END
      || jsonb_build_object(marker_key, requested_status);

    INSERT INTO "public"."problem_report" (
      "id",
      "user_id",
      "conversation_id",
      "category",
      "description",
      "include_context",
      "context",
      "contact_type",
      "contact_value",
      "consent_to_contact",
      "status",
      "admin_note",
      "created_at",
      "updated_at",
      "closed_at",
      "retention_until",
      "contact_purge_at"
    ) VALUES (
      coalesce(NEW.id, gen_random_uuid()),
      NEW.user_id,
      NEW.conversation_id,
      'other',
      left(NEW.problem, 3000),
      true,
      compatibility_context,
      compatibility_contact_type,
      CASE
        WHEN compatibility_contact_type IS NOT NULL THEN NEW.contact_value
        ELSE NULL
      END,
      compatibility_contact_type IS NOT NULL,
      canonical_status,
      NEW.admin_note,
      compatibility_created_at,
      coalesce(NEW.updated_at, compatibility_created_at),
      compatibility_closed_at,
      compatibility_created_at + interval '4320 hours',
      CASE
        WHEN compatibility_closed_at IS NOT NULL
          THEN compatibility_closed_at + interval '720 hours'
        ELSE NULL
      END
    )
    RETURNING * INTO stored;
  ELSIF TG_OP = 'UPDATE' THEN
    compatibility_closed_at := CASE
      WHEN requested_status IN ('resolved', 'closed')
        AND OLD.status IN ('resolved', 'closed')
        THEN coalesce(OLD.resolved_at, statement_timestamp())
      WHEN requested_status IN ('resolved', 'closed')
        THEN coalesce(NEW.resolved_at, OLD.resolved_at, statement_timestamp())
      ELSE NULL
    END;
    compatibility_context :=
      (coalesce(NEW.context, '{}'::jsonb) - marker_key)
      || jsonb_build_object(marker_key, requested_status);

    UPDATE "public"."problem_report"
    SET
      "status" = canonical_status,
      "context" = compatibility_context,
      "admin_note" = NEW.admin_note,
      "closed_at" = compatibility_closed_at,
      "contact_purge_at" = CASE
        WHEN requested_status IN ('resolved', 'closed')
          AND OLD.status IN ('resolved', 'closed')
          AND "contact_purge_at" IS NOT NULL
          THEN "contact_purge_at"
        WHEN compatibility_closed_at IS NOT NULL
          THEN compatibility_closed_at + interval '720 hours'
        ELSE NULL
      END,
      "updated_at" = coalesce(NEW.updated_at, statement_timestamp())
    WHERE "id" = OLD.id
    RETURNING * INTO stored;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported consultation compatibility operation';
  END IF;

  NEW.id := stored.id;
  NEW.user_id := stored.user_id;
  NEW.conversation_id := stored.conversation_id;
  NEW.status := CASE stored.status
    WHEN 'new' THEN 'submitted'
    WHEN 'reviewing' THEN 'contacting'
    WHEN 'closed' THEN CASE
      WHEN stored.context ->> marker_key = 'resolved' THEN 'resolved'
      ELSE 'closed'
    END
    ELSE 'submitted'
  END;
  NEW.contact_name := '';
  NEW.company_name := '';
  NEW.contact_method := coalesce(stored.contact_type, '');
  NEW.contact_value := coalesce(stored.contact_value, '');
  NEW.problem := coalesce(
    nullif(stored.context ->> 'legacyDescription', ''),
    stored.description
  );
  NEW.conversation_summary := coalesce(stored.context ->> 'summary', '');
  NEW.context := stored.context;
  NEW.confirmed_at := stored.created_at;
  NEW.assigned_to := NULL;
  NEW.admin_note := stored.admin_note;
  NEW.created_at := stored.created_at;
  NEW.updated_at := stored.updated_at;
  NEW.resolved_at := stored.closed_at;
  RETURN NEW;
END;
$openvac_compat_write$;--> statement-breakpoint

CREATE TRIGGER "consultation_rollback_compat_write"
INSTEAD OF INSERT OR UPDATE ON "public"."consultation"
FOR EACH ROW
EXECUTE FUNCTION "public"."openvac_write_consultation_rollback_compat"();
