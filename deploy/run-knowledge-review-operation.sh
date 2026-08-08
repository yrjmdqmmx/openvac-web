#!/bin/sh
set -eu

deploy_dir="${1:-}"
expected_release="${2:-}"
mode="${3:-preview}"
diagnostic_request_id="${4:-}"

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
  preview|apply|diagnose-request) ;;
  *)
    echo "mode must be preview or apply" >&2
    exit 64
    ;;
esac

if [ "$mode" = diagnose-request ]; then
  printf '%s\n' "$diagnostic_request_id" |
    grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || {
    echo "diagnose-request requires a lowercase UUID request id" >&2
    exit 64
  }
elif [ -n "$diagnostic_request_id" ]; then
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

operation_args=""
if [ "$mode" = apply ]; then
  operation_args="--apply"
fi

# operation_args is restricted above to either empty or the single literal --apply.
# shellcheck disable=SC2086
OPENVAC_IMAGE="$web_image" compose run --rm --no-deps -T web \
  pnpm knowledge:requeue-pending $operation_args
