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
  /opt/openvac:openvac-production) ;;
  /opt/openvac-staging:openvac-staging) ;;
  *)
    echo "refusing mismatched deployment directory and Compose project: $deploy_dir / $compose_project" >&2
    exit 64
    ;;
esac

case "$release_image" in
  ghcr.io/*@sha256:*) ;;
  *)
    echo "release image must be an immutable GHCR digest" >&2
    exit 64
    ;;
esac

cd "$deploy_dir"
test -f .env
test -f "$compose_file"

old_container="$(
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" ps -q web || true
)"
old_image=""
if [ -n "$old_container" ]; then
  old_image="$(docker inspect --format '{{.Image}}' "$old_container")"
fi

echo "Pulling immutable release $release_image"
OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" pull web worker

echo "Running database migration"
OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" run --rm migrate

echo "Starting web and worker"
OPENVAC_IMAGE="$release_image" \
  docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" up -d --no-deps web worker

health_url="${OPENVAC_HEALTH_URL:-http://127.0.0.1:3010/api/health}"
attempt=1
while [ "$attempt" -le 30 ]; do
  if curl --fail --silent --show-error "$health_url" >/dev/null; then
    echo "Release healthy"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "Health check failed; rolling back containers" >&2
if [ -n "$old_image" ]; then
  OPENVAC_IMAGE="$old_image" \
    docker compose --project-name "$compose_project" --env-file "$deploy_dir/.env" -f "$compose_file" up -d --no-deps web worker
  echo "Rollback started with previous image $old_image" >&2
else
  echo "No previous image was available for automatic rollback" >&2
fi
exit 1
