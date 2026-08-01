#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: deploy.sh /opt/openvac WEB_IMAGE@sha256:digest MODELING_IMAGE@sha256:digest openvac-production" >&2
  exit 64
fi

deploy_dir="$1"
release_image="$2"
release_modeling_image="$3"
compose_project="$4"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bundle_dir="$(dirname "$script_dir")"
compose_file="$bundle_dir/docker-compose.yml"
preflight_script="$script_dir/preflight-host.sh"

case "$deploy_dir:$compose_project" in
  /opt/openvac:openvac-production) deployment_target=production ;;
  /opt/openvac-staging:openvac-staging) deployment_target=staging ;;
  *)
    if [ "${OPENVAC_DEPLOY_TEST_ROOT:-}" = "$deploy_dir" ]; then
      deployment_target=staging
    else
      echo "refusing mismatched deployment directory and Compose project: $deploy_dir / $compose_project" >&2
      exit 64
    fi
    ;;
esac

validate_release_image() {
  image="$1"
  label="$2"
  image_name="${image%@sha256:*}"
  image_digest="${image##*@sha256:}"
  case "$image_name" in
    ghcr.io/?*) ;;
    *)
      echo "$label must be an immutable GHCR digest" >&2
      exit 64
      ;;
  esac
  case "$image_name" in
    *[!a-z0-9._/-]*|*//*|*/)
      echo "$label contains an invalid GHCR repository name" >&2
      exit 64
      ;;
  esac
  case "$image_digest" in
    ""|*[!0-9a-f]*)
      echo "$label must contain a lowercase SHA-256 digest" >&2
      exit 64
      ;;
  esac
  [ "${#image_digest}" -eq 64 ] || {
    echo "$label must contain a 64-character SHA-256 digest" >&2
    exit 64
  }
}

validate_release_image "$release_image" "web release image"
web_image_digest="${release_image##*@sha256:}"
validate_release_image "$release_modeling_image" "modeling release image"
modeling_image_digest="${release_modeling_image##*@sha256:}"
[ "$web_image_digest" != "$modeling_image_digest" ] || {
  echo "web and modeling release images must have distinct digests" >&2
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
[ -f "$preflight_script" ] && [ ! -L "$preflight_script" ] || {
  echo "host preflight script must be a regular file, not a symlink" >&2
  exit 64
}
sh "$preflight_script" "$deployment_target"

run_compose() {
  selected_compose_file="$1"
  shift
  docker compose \
    --project-name "$compose_project" \
    --env-file "$deploy_dir/.env" \
    -f "$selected_compose_file" \
    --profile modeling \
    "$@"
}

release_compose() {
  run_compose "$compose_file" "$@"
}

service_container() {
  selected_compose_file="$1"
  service="$2"
  run_compose "$selected_compose_file" ps -q "$service" 2>/dev/null || true
}

container_image() {
  container="$1"
  if [ -n "$container" ]; then
    docker inspect --format '{{.Image}}' "$container"
  fi
}

old_web_container="$(service_container "$compose_file" web)"
old_worker_container="$(service_container "$compose_file" worker)"
old_modeling_container="$(service_container "$compose_file" modeling-service)"
old_modeling_worker_container="$(service_container "$compose_file" modeling-worker)"
old_image="$(container_image "$old_web_container")"
old_worker_image="$(container_image "$old_worker_container")"
old_modeling_image="$(container_image "$old_modeling_container")"
old_modeling_worker_image="$(container_image "$old_modeling_worker_container")"
old_modeling_enabled=false
if [ -n "$old_web_container" ]; then
  old_modeling_enabled_lines="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$old_web_container" |
      sed -n 's/^MODELING_ENABLED=//p'
  )"
  case "$old_modeling_enabled_lines" in
    "") old_modeling_enabled=false ;;
    true|false) old_modeling_enabled="$old_modeling_enabled_lines" ;;
    *)
      echo "running web container has an invalid or duplicate MODELING_ENABLED value" >&2
      exit 64
      ;;
  esac
fi

if [ -n "$old_web_container" ]; then
  [ -n "$old_worker_container" ] && [ "$old_worker_image" = "$old_image" ] || {
    echo "running web and worker containers are not one managed application image" >&2
    exit 64
  }
else
  [ -z "$old_worker_container$old_modeling_container$old_modeling_worker_container" ] || {
    echo "application containers exist without a running web container; refusing an unmanaged upgrade" >&2
    exit 64
  }
fi

if [ -n "$old_modeling_container$old_modeling_worker_container" ]; then
  [ -n "$old_modeling_container" ] &&
    [ -n "$old_modeling_worker_container" ] &&
    [ "$old_modeling_worker_image" = "$old_image" ] || {
      echo "running modeling containers are not one managed release set" >&2
      exit 64
    }
fi

previous_compose_file="$compose_file"
current_release_file="$deploy_dir/current-release"
if [ -e "$current_release_file" ] || [ -L "$current_release_file" ]; then
  [ -f "$current_release_file" ] && [ ! -L "$current_release_file" ] || {
    echo "current-release must be a regular file, not a symlink" >&2
    exit 64
  }
  [ "$(stat -c '%s' "$current_release_file")" -eq 41 ] || {
    echo "current-release must contain one 40-character SHA and a newline" >&2
    exit 64
  }
  IFS= read -r previous_release_id <"$current_release_file"
  case "$previous_release_id" in
    ""|*[!0-9a-f]*)
      echo "current-release is not a lowercase commit SHA" >&2
      exit 64
      ;;
  esac
  [ "${#previous_release_id}" -eq 40 ] || {
    echo "current-release must contain a 40-character commit SHA" >&2
    exit 64
  }
  previous_compose_file="$deploy_dir/releases/$previous_release_id/docker-compose.yml"
  [ -f "$previous_compose_file" ] && [ ! -L "$previous_compose_file" ] || {
    echo "previous release Compose file must be a regular file, not a symlink" >&2
    exit 64
  }
elif [ -n "$old_web_container" ]; then
  echo "running web container has no current-release record; refusing an unmanaged upgrade" >&2
  exit 64
fi

health_url="${OPENVAC_HEALTH_URL:-http://127.0.0.1:3010/api/health}"

wait_for_web_health() {
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

wait_for_service_health() {
  selected_compose_file="$1"
  service="$2"
  attempt=1
  while [ "$attempt" -le 60 ]; do
    container="$(service_container "$selected_compose_file" "$service")"
    if [ -n "$container" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
      if [ "$status" = healthy ]; then
        return 0
      fi
      if [ "$status" = exited ] || [ "$status" = dead ]; then
        return 1
      fi
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

wait_for_service_running() {
  selected_compose_file="$1"
  service="$2"
  attempt=1
  stable_checks=0
  previous_state=""
  while [ "$attempt" -le 30 ]; do
    container="$(service_container "$selected_compose_file" "$service")"
    state_description=""
    if [ -n "$container" ]; then
      state_description="$(docker inspect --format '{{.State.Status}} {{.State.Restarting}} {{.RestartCount}}' "$container" 2>/dev/null || true)"
    fi
    case "$state_description" in
      "running false "*)
        if [ "$state_description" = "$previous_state" ]; then
          stable_checks=$((stable_checks + 1))
        else
          stable_checks=1
        fi
        ;;
      *) stable_checks=0 ;;
    esac
    previous_state="$state_description"
    if [ "$stable_checks" -ge 3 ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

cleanup_new_release_containers() {
  OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
    release_compose rm --stop --force \
    modeling-worker modeling-service worker web >/dev/null 2>&1 || true
}

rollback() {
  reason="$1"
  echo "$reason; rolling back the application release set" >&2
  if [ -z "$old_image" ]; then
    cleanup_new_release_containers
    echo "No previous image was available; new application containers were removed" >&2
    return 1
  fi

  rollback_failed=0
  if [ -n "$old_modeling_image" ]; then
    if ! MODELING_ENABLED="$old_modeling_enabled" \
      OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="$old_modeling_image" \
      run_compose "$previous_compose_file" up -d --no-deps modeling-service; then
      echo "Failed to restart the previous modeling image $old_modeling_image" >&2
      rollback_failed=1
    elif ! wait_for_service_health "$previous_compose_file" modeling-service; then
      echo "Previous modeling service restarted but did not become healthy" >&2
      rollback_failed=1
    fi
  else
    OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
      release_compose rm --stop --force modeling-worker modeling-service >/dev/null 2>&1 || true
  fi

  if ! MODELING_ENABLED="$old_modeling_enabled" \
    OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="${old_modeling_image:-$release_modeling_image}" \
    run_compose "$previous_compose_file" up -d --no-deps web worker; then
    echo "Failed to restart the previous web/worker image $old_image" >&2
    rollback_failed=1
  fi

  if [ -n "$old_modeling_image" ] && [ "$rollback_failed" -eq 0 ]; then
    if ! MODELING_ENABLED="$old_modeling_enabled" \
      OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="$old_modeling_image" \
      run_compose "$previous_compose_file" up -d --no-deps modeling-worker; then
      echo "Failed to restart the previous modeling worker" >&2
      rollback_failed=1
    elif ! wait_for_service_running "$previous_compose_file" modeling-worker; then
      echo "Previous modeling worker restarted but did not remain running" >&2
      rollback_failed=1
    fi
  fi

  if ! wait_for_service_running "$previous_compose_file" worker; then
    echo "Previous worker restarted but did not remain running" >&2
    rollback_failed=1
  fi
  if ! wait_for_web_health; then
    echo "Previous web image restarted but did not become healthy" >&2
    rollback_failed=1
  fi
  if [ "$rollback_failed" -ne 0 ]; then
    return 1
  fi
  echo "Rollback healthy on previous application image $old_image" >&2
}

if [ -e "$current_release_file" ] || [ -L "$current_release_file" ]; then
  [ -f "$script_dir/backup.sh" ] && [ ! -L "$script_dir/backup.sh" ] || {
    echo "upgrade deployment requires the bundled backup script" >&2
    exit 64
  }
  echo "Creating required pre-migration backup"
  pre_migration_backup="$(bash "$script_dir/backup.sh" "$deployment_target")"
  echo "Pre-migration backup ready: $pre_migration_backup"
else
  echo "No current release is recorded; treating this as a first deployment"
fi

echo "Pulling immutable web release $release_image"
echo "Pulling immutable modeling release $release_modeling_image"
if [ -n "${OPENVAC_MODELING_PRELOADED_ID:-}" ]; then
  case "$OPENVAC_MODELING_PRELOADED_ID" in
    sha256:*) ;;
    *)
      echo "preloaded modeling image ID must use sha256" >&2
      exit 64
      ;;
  esac
  preloaded_digest="${OPENVAC_MODELING_PRELOADED_ID#sha256:}"
  case "$preloaded_digest" in
    ""|*[!0-9a-f]*)
      echo "preloaded modeling image ID must be lowercase hexadecimal" >&2
      exit 64
      ;;
  esac
  [ "${#preloaded_digest}" -eq 64 ] || {
    echo "preloaded modeling image ID must contain 64 hexadecimal characters" >&2
    exit 64
  }
  actual_modeling_id="$(docker image inspect --format '{{.Id}}' "$release_modeling_image")"
  [ "$actual_modeling_id" = "$OPENVAC_MODELING_PRELOADED_ID" ] || {
    echo "preloaded modeling image does not match its verified archive identity" >&2
    exit 1
  }
  echo "Using checksum-verified preloaded modeling release $actual_modeling_id"
  OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
    release_compose pull web worker modeling-worker
else
  OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
    release_compose pull web worker modeling-service modeling-worker
fi

echo "Verifying the configured DeepSeek model against /models"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose run --rm --no-deps web pnpm model:verify; then
  echo "Configured DeepSeek model is not available; deployment stopped before migration" >&2
  exit 1
fi

echo "Running database migration"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose run --rm migrate; then
  rollback "Database migration failed" || true
  exit 1
fi

if [ -n "$old_modeling_worker_container" ]; then
  echo "Stopping the previous modeling worker before replacing its kernel service"
  release_compose stop -t 30 modeling-worker
fi

echo "Starting modeling service"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose up -d --no-deps modeling-service; then
  rollback "Modeling service startup failed" || true
  exit 1
fi
if ! wait_for_service_health "$compose_file" modeling-service; then
  rollback "Modeling service readiness check failed" || true
  exit 1
fi

echo "Verifying authenticated CAD readiness and private modeling storage"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose run --rm --no-deps modeling-worker pnpm modeling:verify-runtime; then
  rollback "Modeling runtime verification failed" || true
  exit 1
fi

echo "Starting web and worker"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose up -d --no-deps web worker; then
  rollback "Web/worker startup failed" || true
  exit 1
fi
if ! wait_for_service_running "$compose_file" worker; then
  rollback "Worker readiness check failed" || true
  exit 1
fi

echo "Starting modeling worker"
if ! OPENVAC_IMAGE="$release_image" OPENVAC_MODELING_IMAGE="$release_modeling_image" \
  release_compose up -d --no-deps modeling-worker; then
  rollback "Modeling worker startup failed" || true
  exit 1
fi
if ! wait_for_service_running "$compose_file" modeling-worker; then
  rollback "Modeling worker readiness check failed" || true
  exit 1
fi

if wait_for_web_health; then
  echo "Release healthy"
  exit 0
fi

rollback "Web health check failed" || true
exit 1
