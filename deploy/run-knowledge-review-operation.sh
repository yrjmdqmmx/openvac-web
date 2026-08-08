#!/bin/sh
set -eu

deploy_dir="${1:-}"
expected_release="${2:-}"
mode="${3:-preview}"
diagnostic_request_id="${4:-}"
retry_document_id="${5:-}"
retry_version_id="${6:-}"
retry_run_id="${7:-}"
retry_content_hash="${8:-}"

if [ "$diagnostic_request_id" = _ ]; then
  diagnostic_request_id=""
fi

case "$deploy_dir" in
  /opt/openvac) ;;
  *)
    if [ -z "${OPENVAC_OPERATION_TEST_ROOT:-}" ] ||
      [ "$deploy_dir" != "$OPENVAC_OPERATION_TEST_ROOT" ]; then
      echo "knowledge review operations are restricted to /opt/openvac" >&2
      exit 64
    fi
    ;;
esac

case "$expected_release" in
  ""|*[!0-9a-f]*)
    echo "expected release must be a lowercase hexadecimal commit SHA" >&2
    exit 64
    ;;
esac
[ "${#expected_release}" -eq 40 ] || {
  echo "expected release must contain exactly 40 characters" >&2
  exit 64
}

case "$mode" in
  preview|apply|diagnose-request|retry-verify-evidence) ;;
  *)
    echo "unsupported knowledge review operation mode" >&2
    exit 64
    ;;
esac

retry_values="$retry_document_id$retry_version_id$retry_run_id$retry_content_hash"
if [ "$mode" = diagnose-request ]; then
  printf '%s\n' "$diagnostic_request_id" |
    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || {
    echo "diagnose-request requires a lowercase UUID request id" >&2
    exit 64
  }
  [ -z "$retry_values" ] || {
    echo "retry target is only accepted in retry-verify-evidence mode" >&2
    exit 64
  }
elif [ "$mode" = retry-verify-evidence ]; then
  [ -z "$diagnostic_request_id" ] || {
    echo "diagnostic request id is only accepted in diagnose-request mode" >&2
    exit 64
  }
  for retry_uuid in "$retry_document_id" "$retry_version_id" "$retry_run_id"; do
    printf '%s\n' "$retry_uuid" |
      grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || {
      echo "retry target UUID is invalid" >&2
      exit 64
    }
  done
  printf '%s\n' "$retry_content_hash" | grep -Eq '^[0-9a-f]{64}$' || {
    echo "retry content hash is invalid" >&2
    exit 64
  }
elif [ -n "$diagnostic_request_id" ] || [ -n "$retry_values" ]; then
  echo "diagnostic request id is only accepted in diagnose-request mode" >&2
  exit 64
fi

[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] || {
  echo "deployment directory must be a real directory" >&2
  exit 64
}

current_release_file="$deploy_dir/current-release"
transaction_file="$deploy_dir/deployment-transaction"
environment_file="$deploy_dir/.env"
operation_lock="$deploy_dir/.knowledge-review-operation-lock"

[ -f "$current_release_file" ] && [ ! -L "$current_release_file" ] || {
  echo "current-release must be a regular file" >&2
  exit 64
}
[ "$(stat -c '%s' "$current_release_file")" -eq 41 ] || {
  echo "current-release must contain one SHA and a newline" >&2
  exit 64
}
IFS= read -r current_release <"$current_release_file"
[ "$current_release" = "$expected_release" ] || {
  echo "the deployed release does not match expected_release_sha" >&2
  exit 1
}

[ ! -e "$transaction_file" ] && [ ! -L "$transaction_file" ] || {
  echo "an unresolved deployment transaction exists" >&2
  exit 1
}
[ ! -e "$deploy_dir/.activation-lock" ] && [ ! -L "$deploy_dir/.activation-lock" ] || {
  echo "a deployment activation is still in progress" >&2
  exit 1
}
[ -f "$environment_file" ] && [ ! -L "$environment_file" ] || {
  echo "production environment file must be a regular file" >&2
  exit 64
}
[ "$(stat -c '%a' "$environment_file")" = 600 ] || {
  echo "production environment file must have mode 0600" >&2
  exit 64
}

compose_file="$deploy_dir/releases/$current_release/docker-compose.yml"
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] || {
  echo "current release Compose file must be a regular file" >&2
  exit 64
}

mkdir "$operation_lock" || {
  echo "another knowledge review operation is already running" >&2
  exit 1
}
cleanup_lock() {
  rmdir "$operation_lock" >/dev/null 2>&1 || true
}
trap cleanup_lock EXIT HUP INT TERM

compose() {
  docker compose \
    --project-name openvac-production \
    --env-file "$environment_file" \
    -f "$compose_file" \
    "$@"
}

web_container="$(compose ps -q web)"
[ -n "$web_container" ] || {
  echo "the production web container is not running" >&2
  exit 1
}
case "$web_container" in
  *[!0-9a-f]*)
    echo "the production web container id is invalid or ambiguous" >&2
    exit 1
    ;;
esac

web_image="$(docker inspect --format '{{.Config.Image}}' "$web_container")"
case "$web_image" in
  openvac-web-release:*) ;;
  *)
    echo "the production web container is not using a managed release image" >&2
    exit 1
    ;;
esac
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$web_image")"
[ "$image_revision" = "$expected_release" ] || {
  echo "the running image revision does not match expected_release_sha" >&2
  exit 1
}

if [ "$mode" = diagnose-request ]; then
  diagnostic_lines="$(
    docker logs --since 30m "$web_container" 2>&1 |
      awk -v request_id="$diagnostic_request_id" '
        index($0, request_id) { capture = 1; remaining = 30 }
        capture && remaining > 0 { print; remaining -= 1 }
      '
  )"
  [ -n "$diagnostic_lines" ] || {
    echo "no recent log entry matched the supplied request id" >&2
    exit 1
  }
  printf '%s\n' "$diagnostic_lines" |
    sed -n -E '/requestId|PostgresError|severity|code:|constraint|table:|column:|routine:|automation-review-(repository|service)|errors\.ts/p' |
    sed -E 's/(detail|query|parameters|where):.*/\1: [DETAIL_REDACTED]/I' |
    head -n 40
  exit 0
fi

if [ "$mode" = retry-verify-evidence ]; then
  retry_result="$(
    compose exec -T postgres sh -lc \
      'exec psql -X -v ON_ERROR_STOP=1 -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
      sh \
      "--set=retry_document_id=$retry_document_id" \
      "--set=retry_version_id=$retry_version_id" \
      "--set=retry_run_id=$retry_run_id" \
      "--set=retry_content_hash=$retry_content_hash" <<'SQL'
WITH eligible AS (
  SELECT r.id, kd.id AS document_id, kv.id AS version_id, kv.content_hash
  FROM knowledge_review_run r
  JOIN knowledge_version kv ON kv.id = r.input_version_id
  JOIN knowledge_document kd ON kd.id = kv.document_id
  WHERE r.id = :'retry_run_id'::uuid
    AND r.phase = 'verify'
    AND r.status = 'needs_human'
    AND r.decision = 'needs_human'
    AND r.prompt_version = 'codex_automation_v1'
    AND r.input_version_id = :'retry_version_id'::uuid
    AND r.input_content_hash = :'retry_content_hash'
    AND kd.id = :'retry_document_id'::uuid
    AND kd.current_version_id = kv.id
    AND kd.status = 'review'
    AND kv.content_hash = :'retry_content_hash'
    AND kv.metadata -> 'automationReasons' ? 'AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING'
    AND EXISTS (
      SELECT 1
      FROM knowledge_review_run initial
      WHERE initial.phase = 'initial'
        AND initial.status = 'completed'
        AND initial.decision = 'approved'
        AND initial.risk = 'low'
        AND initial.prompt_version = r.prompt_version
        AND (
          (initial.input_version_id = kv.id AND initial.input_content_hash = kv.content_hash)
          OR initial.revised_version_id = kv.id
        )
    )
  FOR UPDATE OF r, kd, kv
), reset_run AS (
  UPDATE knowledge_review_run r
  SET status = 'queued', risk = NULL, decision = NULL,
      structured_report = '{}'::jsonb, revised_version_id = NULL,
      completed_at = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
      updated_at = NOW()
  FROM eligible e
  WHERE r.id = e.id
  RETURNING r.id, e.document_id, e.version_id, e.content_hash
), reset_version AS (
  UPDATE knowledge_version kv
  SET metadata = (kv.metadata - 'automationReasons') ||
        '{"reviewStatus":"required","automationStatus":"queued"}'::jsonb,
      updated_at = NOW()
  FROM reset_run r
  WHERE kv.id = r.version_id AND kv.content_hash = r.content_hash
  RETURNING kv.id
), audit AS (
  INSERT INTO audit_log (
    actor_user_id, actor_role, action, target_type, target_id, metadata, created_at
  )
  SELECT NULL, 'system', 'knowledge.automation_review.retry_verify_evidence',
         'knowledge_review_run', r.id::text,
         jsonb_build_object(
           'documentId', r.document_id,
           'versionId', r.version_id,
           'contentHash', r.content_hash,
           'previousReason', 'AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING'
         ), NOW()
  FROM reset_run r
  JOIN reset_version v ON v.id = r.version_id
  RETURNING target_id
)
SELECT json_build_object(
  'runId', r.id,
  'status', 'queued',
  'versionId', r.version_id,
  'contentHash', r.content_hash,
  'audited', TRUE
)::text
FROM reset_run r
JOIN audit a ON a.target_id = r.id::text;
SQL
  )"
  [ -n "$retry_result" ] || {
    retry_diagnostics="$(
      compose exec -T postgres sh -lc \
        'exec psql -X -v ON_ERROR_STOP=1 -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' \
        sh \
        "--set=retry_document_id=$retry_document_id" \
        "--set=retry_version_id=$retry_version_id" \
        "--set=retry_run_id=$retry_run_id" \
        "--set=retry_content_hash=$retry_content_hash" <<'SQL'
SELECT json_build_object(
  'retryEligibility', json_build_object(
    'runExists', EXISTS (
      SELECT 1 FROM knowledge_review_run r
      WHERE r.id = :'retry_run_id'::uuid
    ),
    'runStateMatches', EXISTS (
      SELECT 1 FROM knowledge_review_run r
      WHERE r.id = :'retry_run_id'::uuid
        AND r.phase = 'verify'
        AND r.status = 'needs_human'
        AND r.decision = 'needs_human'
        AND r.prompt_version = 'codex_automation_v1'
    ),
    'runInputMatches', EXISTS (
      SELECT 1 FROM knowledge_review_run r
      WHERE r.id = :'retry_run_id'::uuid
        AND r.input_version_id = :'retry_version_id'::uuid
        AND r.input_content_hash = :'retry_content_hash'
    ),
    'currentDocumentMatches', EXISTS (
      SELECT 1
      FROM knowledge_document kd
      JOIN knowledge_version kv ON kv.id = kd.current_version_id
      WHERE kd.id = :'retry_document_id'::uuid
        AND kd.current_version_id = :'retry_version_id'::uuid
        AND kd.status = 'review'
        AND kv.content_hash = :'retry_content_hash'
    ),
    'metadataReasonMatches', EXISTS (
      SELECT 1 FROM knowledge_version kv
      WHERE kv.id = :'retry_version_id'::uuid
        AND kv.content_hash = :'retry_content_hash'
        AND kv.metadata -> 'automationReasons' ?
          'AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING'
    ),
    'initialRunMatches', EXISTS (
      SELECT 1
      FROM knowledge_review_run initial
      WHERE initial.phase = 'initial'
        AND initial.status = 'completed'
        AND initial.decision = 'approved'
        AND initial.risk = 'low'
        AND initial.prompt_version = 'codex_automation_v1'
        AND (
          (
            initial.input_version_id = :'retry_version_id'::uuid
            AND initial.input_content_hash = :'retry_content_hash'
          )
          OR initial.revised_version_id = :'retry_version_id'::uuid
        )
    )
  )
)::text;
SQL
    )"
    printf '%s\n' "$retry_diagnostics" >&2
    echo "the exact verify run is not eligible for evidence-only retry" >&2
    exit 1
  }
  printf '%s\n' "$retry_result"
  exit 0
fi

operation_args=""
if [ "$mode" = apply ]; then
  operation_args="--apply"
fi

# operation_args is restricted above to either empty or the single literal --apply.
# shellcheck disable=SC2086
OPENVAC_IMAGE="$web_image" compose run --rm --no-deps -T web \
  pnpm knowledge:requeue-pending $operation_args
