#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: deploy.sh /opt/openvac ghcr.io/owner/image@sha256:digest openvac-production" >&2
  exit 64
fi

deploy_dir="$1"
release_image="$2"
compose_project="$3"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bundle_dir="$(dirname "$script_dir")"
compose_file="$bundle_dir/docker-compose.yml"

case "$deploy_dir:$compose_project" in
  /opt/openvac:openvac-production) deployment_target=production ;;
  /opt/openvac-staging:openvac-staging) deployment_target=staging ;;
  *)
    echo "refusing mismatched deployment directory and Compose project: $deploy_dir / $compose_project" >&2
    exit 64
    ;;
esac

image_name="${release_image%@sha256:*}"
image_digest="${release_image##*@sha256:}"
case "$image_name" in
  ghcr.io/?*) ;;
  *)
    echo "release image must be an immutable GHCR digest" >&2
    exit 64
    ;;
esac
case "$image_name" in
  *[!A-Za-z0-9._/-]*|*//*|*/)
    echo "release image contains an invalid GHCR repository name" >&2
    exit 64
    ;;
esac
case "$image_digest" in
  ""|*[!0-9a-f]*)
    echo "release image must contain a lowercase SHA-256 digest" >&2
    exit 64
    ;;
esac
[ "${#image_digest}" -eq 64 ] || {
  echo "release image must contain a 64-character SHA-256 digest" >&2
  exit 64
}

cd "$deploy_dir"
[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] || {
  echo "deployment directory must be a real directory, not a symlink" >&2
  exit 64
}
[ -f "$deploy_dir/.env" ] && [ ! -L "$deploy_dir/.env" ] || {
  echo "deployment environment file must be a regular file, not a symlink" >&2
  exit 64
}
[ "$(stat -c '%a' "$deploy_dir/.env")" = 600 ] || {
  echo "deployment environment file must have mode 0600" >&2
  exit 64
}
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] || {
  echo "Compose file must be a regular file, not a symlink" >&2
  exit 64
}

minimum_available_kb=31457280
available_kb="$(LC_ALL=C df -Pk "$deploy_dir" | awk 'END { print $4 }')"
case "$available_kb" in
  ""|*[!0-9]*)
    echo "could not determine free disk space for $deploy_dir" >&2
    exit 1
    ;;
esac
if [ "$available_kb" -lt "$minimum_available_kb" ]; then
  echo "deployment requires at least 30 GiB free; only ${available_kb} KiB is available" >&2
  exit 1
fi
echo "Disk preflight passed: ${available_kb} KiB available"

old_container="$(
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" ps -q web || true
)"
old_image=""
if [ -n "$old_container" ]; then
  old_image="$(docker inspect --format '{{.Image}}' "$old_container")"
fi

health_url="${OPENVAC_HEALTH_URL:-http://127.0.0.1:3010/api/health}"

wait_for_health() {
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if curl --fail --silent --show-error "$health_url" >/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

rollback() {
  reason="$1"
  echo "$reason; rolling back containers" >&2
  if [ -z "$old_image" ]; then
    echo "No previous image was available for automatic rollback" >&2
    return 1
  fi

  if ! OPENVAC_IMAGE="$old_image" \
    docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" up -d --no-deps web worker; then
    echo "Failed to restart the previous image $old_image" >&2
    return 1
  fi
  if ! wait_for_health; then
    echo "Previous image restarted but did not become healthy" >&2
    return 1
  fi
  echo "Rollback healthy on previous image $old_image" >&2
}

if [ -e "$deploy_dir/current-release" ] || [ -L "$deploy_dir/current-release" ]; then
  [ -f "$script_dir/backup.sh" ] && [ ! -L "$script_dir/backup.sh" ] || {
    echo "upgrade deployment requires the bundled backup script" >&2
    exit 64
  }
  echo "Creating required pre-migration backup"
  pre_migration_backup="$(bash "$script_dir/backup.sh" "$deployment_target")"
  echo "Pre-migration backup ready: $pre_migration_backup"
else
  if [ -n "$old_container" ]; then
    echo "running web container has no current-release record; refusing an unmanaged upgrade" >&2
    exit 64
  fi
  echo "No current release is recorded; treating this as a first deployment"
fi

echo "Pulling immutable release $release_image"
OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" pull web worker

echo "Verifying the configured DeepSeek model against /models"
if ! OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" run --rm --no-deps web pnpm model:verify; then
  echo "Configured DeepSeek model is not available; deployment stopped before migration" >&2
  exit 1
fi

echo "Running database migration"
if ! OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" run --rm migrate; then
  rollback "Database migration failed" || true
  exit 1
fi

echo "Starting web and worker"
if ! OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" up -d --no-deps web worker; then
  rollback "Container startup failed" || true
  exit 1
fi

if wait_for_health; then
  echo "Release healthy"
  exit 0
fi

rollback "Health check failed" || true
exit 1
