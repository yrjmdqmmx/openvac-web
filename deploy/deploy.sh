#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: deploy.sh /opt/openvac WEB_IMAGE@sha256:digest openvac-production RELEASE_SHA" >&2
  exit 64
fi

deploy_dir="$1"
release_image="$2"
compose_project="$3"
target_release_id="$4"
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

case "$target_release_id" in
  ""|*[!0-9a-f]*)
    echo "target release must be a lowercase hexadecimal commit SHA" >&2
    exit 64
    ;;
esac
[ "${#target_release_id}" -eq 40 ] || {
  echo "target release must be a 40-character commit SHA" >&2
  exit 64
}

activation_id="${OPENVAC_ACTIVATION_ID:-}"
case "$activation_id" in
  "$target_release_id"-*) activation_nonce="${activation_id#"$target_release_id"-}" ;;
  *)
    echo "OPENVAC_ACTIVATION_ID must be scoped to the target release SHA" >&2
    exit 64
    ;;
esac
case "$activation_nonce" in
  ""|*[!0-9a-f]*)
    echo "OPENVAC_ACTIVATION_ID must end in a lowercase hexadecimal nonce" >&2
    exit 64
    ;;
esac
[ "${#activation_nonce}" -eq 32 ] || {
  echo "OPENVAC_ACTIVATION_ID nonce must contain 32 hexadecimal characters" >&2
  exit 64
}

rollback_rehearsal_mode="${OPENVAC_R1_ROLLBACK_REHEARSAL:-auto}"
case "$rollback_rehearsal_mode" in
  auto|true) ;;
  false)
    case "$deploy_dir" in
      /opt/openvac|/opt/openvac-staging)
        echo "the R1 rollback rehearsal cannot be disabled on a managed deployment target" >&2
        exit 64
        ;;
      *)
        [ "${OPENVAC_DEPLOY_TEST_ROOT:-}" = "$deploy_dir" ] || {
          echo "the R1 rollback rehearsal can only be disabled in an isolated deployment test" >&2
          exit 64
        }
        ;;
    esac
    ;;
  *)
    echo "OPENVAC_R1_ROLLBACK_REHEARSAL must be auto, true, or false" >&2
    exit 64
    ;;
esac

validate_release_image() {
  image="$1"
  image_name="${image%@sha256:*}"
  image_digest="${image##*@sha256:}"
  case "$image_name" in
    ghcr.io/?*) ;;
    *)
      echo "web release image must be an immutable GHCR digest" >&2
      exit 64
      ;;
  esac
  case "$image_name" in
    *[!a-z0-9._/-]*|*//*|*/)
      echo "web release image contains an invalid GHCR repository name" >&2
      exit 64
      ;;
  esac
  case "$image_digest" in
    ""|*[!0-9a-f]*)
      echo "web release image must contain a lowercase SHA-256 digest" >&2
      exit 64
      ;;
  esac
  [ "${#image_digest}" -eq 64 ] || {
    echo "web release image must contain a 64-character SHA-256 digest" >&2
    exit 64
  }
}

if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ]; then
  case "$OPENVAC_WEB_PRELOADED_ID" in
    sha256:*) web_image_digest="${OPENVAC_WEB_PRELOADED_ID#sha256:}" ;;
    *)
      echo "preloaded web image ID must use sha256" >&2
      exit 64
      ;;
  esac
  case "$web_image_digest" in
    ""|*[!0-9a-f]*)
      echo "preloaded web image ID must be lowercase hexadecimal" >&2
      exit 64
      ;;
  esac
  [ "${#web_image_digest}" -eq 64 ] || {
    echo "preloaded web image ID must contain 64 hexadecimal characters" >&2
    exit 64
  }
  [ "$release_image" = "openvac-web-release:$web_image_digest" ] || {
    echo "preloaded web reference must be content-addressed by its image ID" >&2
    exit 64
  }
else
  validate_release_image "$release_image"
fi

cd "$deploy_dir"
[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] || {
  echo "deployment directory must be a real directory, not a symlink" >&2
  exit 64
}
activation_lock_dir="$deploy_dir/.activation-lock"
activation_lock_owner_file="$activation_lock_dir/owner"
[ -d "$activation_lock_dir" ] && [ ! -L "$activation_lock_dir" ] || {
  echo "deploy.sh requires the host activation lock" >&2
  exit 64
}
[ -f "$activation_lock_owner_file" ] && [ ! -L "$activation_lock_owner_file" ] || {
  echo "deploy.sh requires a regular activation lock owner" >&2
  exit 64
}
[ "$(stat -c '%a' "$activation_lock_owner_file")" = 600 ] || {
  echo "activation lock owner must have mode 0600" >&2
  exit 64
}
IFS= read -r activation_lock_owner <"$activation_lock_owner_file"
[ "$activation_lock_owner" = "$activation_id" ] || {
  echo "activation lock owner does not match OPENVAC_ACTIVATION_ID" >&2
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
desired_knowledge_review_token_hash="${KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256:-}"
unset KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256
if [ -n "$desired_knowledge_review_token_hash" ]; then
  case "$desired_knowledge_review_token_hash" in
    *[!0-9a-f]*)
      echo "knowledge review automation token hash must be lowercase hexadecimal" >&2
      exit 64
      ;;
  esac
  [ "${#desired_knowledge_review_token_hash}" -eq 64 ] || {
    echo "knowledge review automation token hash must contain 64 characters" >&2
    exit 64
  }
  [ -f "$script_dir/configure-knowledge-review-token-hash.sh" ] &&
    [ ! -L "$script_dir/configure-knowledge-review-token-hash.sh" ] || {
    echo "release bundle is missing the knowledge review token configurator" >&2
    exit 64
  }
fi
desired_dashscope_workspace_id="${DASHSCOPE_WORKSPACE_ID:-}"
unset DASHSCOPE_WORKSPACE_ID
if [ -n "$desired_dashscope_workspace_id" ]; then
  case "$desired_dashscope_workspace_id" in
    *[!A-Za-z0-9_-]*)
      echo "DashScope workspace identifier is invalid" >&2
      exit 64
      ;;
  esac
  [ "${#desired_dashscope_workspace_id}" -le 128 ] || {
    echo "DashScope workspace identifier is invalid" >&2
    exit 64
  }
  [ -f "$script_dir/configure-dashscope-workspace-id.sh" ] &&
    [ ! -L "$script_dir/configure-dashscope-workspace-id.sh" ] || {
    echo "release bundle is missing the DashScope workspace configurator" >&2
    exit 64
  }
fi
[ -f "$compose_file" ] && [ ! -L "$compose_file" ] || {
  echo "Compose file must be a regular file, not a symlink" >&2
  exit 64
}
[ -f "$preflight_script" ] && [ ! -L "$preflight_script" ] || {
  echo "host preflight script must be a regular file, not a symlink" >&2
  exit 64
}
sh "$preflight_script" "$deployment_target"

durable_sync() {
  sync -f "$1"
}

run_compose() {
  selected_compose_file="$1"
  shift
  docker compose     --project-name "$compose_project"     --env-file "$deploy_dir/.env"     -f "$selected_compose_file"     "$@"
}

run_legacy_compose() {
  selected_compose_file="$1"
  shift
  docker compose     --project-name "$compose_project"     --env-file "$deploy_dir/.env"     -f "$selected_compose_file"     --profile modeling     "$@"
}

release_compose() {
  run_compose "$compose_file" "$@"
}

service_container() {
  selected_compose_file="$1"
  service="$2"
  run_legacy_compose "$selected_compose_file" ps -q "$service" 2>/dev/null || true
}

service_container_any_state() {
  selected_compose_file="$1"
  service="$2"
  run_legacy_compose "$selected_compose_file" ps --all -q "$service" 2>/dev/null || true
}

container_image() {
  container="$1"
  if [ -n "$container" ]; then
    docker inspect --format '{{.Image}}' "$container"
  fi
}

current_release_file="$deploy_dir/current-release"
transaction_journal_file="$deploy_dir/deployment-transaction"
[ ! -e "$transaction_journal_file" ] && [ ! -L "$transaction_journal_file" ] || {
  echo "an unresolved deployment transaction exists; recover it before another activation" >&2
  exit 64
}
previous_compose_file="$compose_file"
previous_release_id=""
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
fi

old_web_container="$(service_container "$previous_compose_file" web)"
old_worker_container="$(service_container "$previous_compose_file" worker)"
legacy_services="$(run_legacy_compose "$previous_compose_file" config --services)"
legacy_modeling_service_declared=false
legacy_modeling_worker_declared=false
printf '%s\n' "$legacy_services" | grep -Fxq modeling-service &&
  legacy_modeling_service_declared=true
printf '%s\n' "$legacy_services" | grep -Fxq modeling-worker &&
  legacy_modeling_worker_declared=true
if [ "$legacy_modeling_service_declared" != "$legacy_modeling_worker_declared" ]; then
  echo "previous release declares an incomplete legacy modeling service set" >&2
  exit 64
fi
legacy_modeling_declared="$legacy_modeling_service_declared"

old_modeling_container="$(service_container_any_state "$previous_compose_file" modeling-service)"
old_modeling_worker_container="$(service_container_any_state "$previous_compose_file" modeling-worker)"
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
      echo "running web container has an invalid or duplicate legacy MODELING_ENABLED value" >&2
      exit 64
      ;;
  esac
fi

if [ -n "$old_web_container" ]; then
  [ -n "$old_worker_container" ] && [ "$old_worker_image" = "$old_image" ] || {
    echo "running web and worker containers are not one managed application image" >&2
    exit 64
  }
elif [ -n "$old_worker_container$old_modeling_container$old_modeling_worker_container" ]; then
  echo "application containers exist without a running web container; refusing an unmanaged upgrade" >&2
  exit 64
fi

if [ "$legacy_modeling_declared" = true ]; then
  [ -n "$old_modeling_container" ] &&
    [ -n "$old_modeling_worker_container" ] &&
    [ "$old_modeling_worker_image" = "$old_image" ] || {
      echo "legacy modeling containers are missing or not one managed release set" >&2
      exit 64
    }
elif [ -n "$old_modeling_container$old_modeling_worker_container" ]; then
  echo "legacy modeling containers exist but are not declared by the previous release" >&2
  exit 64
fi

if [ -n "$previous_release_id" ] && [ -n "$old_image" ]; then
  previous_web_revision="$(
    docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$old_image"
  )"
  [ "$previous_web_revision" = "$previous_release_id" ] || {
    echo "running web image revision does not match current-release" >&2
    exit 64
  }
  if [ -n "$old_modeling_image" ]; then
    previous_modeling_revision="$(
      docker image inspect \
        --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$old_modeling_image"
    )"
    [ "$previous_modeling_revision" = "$previous_release_id" ] || {
      echo "legacy modeling image revision does not match current-release" >&2
      exit 64
    }
  fi
fi

if [ ! -e "$current_release_file" ] && [ -n "$old_web_container" ]; then
  echo "running web container has no current-release record; refusing an unmanaged upgrade" >&2
  exit 64
fi
if [ "$rollback_rehearsal_mode" = true ] && [ -z "$old_image" ]; then
  echo "the required previous-image rollback rehearsal has no managed web/worker release to restore" >&2
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
      [ "$status" = healthy ] && return 0
      case "$status" in exited|dead) return 1 ;; esac
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
    [ "$stable_checks" -ge 3 ] && return 0
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

cleanup_new_release_containers() {
  OPENVAC_IMAGE="$release_image"     release_compose rm --stop --force worker web >/dev/null 2>&1 || true
}

env_backup_file=""
env_mutated=false

backup_runtime_env() {
  [ -n "$desired_knowledge_review_token_hash" ] ||
    [ -n "$desired_dashscope_workspace_id" ] || return 0
  [ -z "$env_backup_file" ] || return 0
  env_backup_file="$deploy_dir/.env.rollback-$activation_id"
  if [ -e "$env_backup_file" ] || [ -L "$env_backup_file" ]; then
    echo "refusing an existing runtime environment rollback file" >&2
    return 1
  fi
  (
    set -C
    umask 077
    cat "$deploy_dir/.env" >"$env_backup_file"
  ) || return 1
  chmod 600 "$env_backup_file" || return 1
  durable_sync "$env_backup_file" || return 1
  durable_sync "$deploy_dir" || return 1
}

apply_runtime_env() {
  [ -n "$desired_knowledge_review_token_hash" ] ||
    [ -n "$desired_dashscope_workspace_id" ] || return 0
  backup_runtime_env || return 1
  # From this point onward every exit path must restore from the backup,
  # including failures before or during the atomic configurator rename.
  env_mutated=true
  if [ -n "$desired_knowledge_review_token_hash" ]; then
    if ! printf '%s\n' "$desired_knowledge_review_token_hash" |
      OPENVAC_CONFIG_ROOT="$(dirname "$deploy_dir")" \
        sh "$script_dir/configure-knowledge-review-token-hash.sh" "$deployment_target"; then
      return 1
    fi
  fi
  if [ -n "$desired_dashscope_workspace_id" ]; then
    if ! printf '%s\n' "$desired_dashscope_workspace_id" |
      OPENVAC_CONFIG_ROOT="$(dirname "$deploy_dir")" \
        sh "$script_dir/configure-dashscope-workspace-id.sh" "$deployment_target"; then
      return 1
    fi
  fi
  durable_sync "$deploy_dir/.env" || return 1
  durable_sync "$deploy_dir" || return 1
}

restore_runtime_env() {
  if [ -z "$env_backup_file" ]; then
    env_mutated=false
    return 0
  fi
  [ -f "$env_backup_file" ] && [ ! -L "$env_backup_file" ] || return 1
  env_restore_tmp="$(mktemp "$deploy_dir/.env.restore.XXXXXX")" || return 1
  if ! cat "$env_backup_file" >"$env_restore_tmp" ||
    ! chmod 600 "$env_restore_tmp" ||
    ! mv "$env_restore_tmp" "$deploy_dir/.env"; then
    rm -f -- "$env_restore_tmp"
    return 1
  fi
  durable_sync "$deploy_dir/.env" || return 1
  rm -f -- "$env_backup_file" || return 1
  env_backup_file=""
  env_mutated=false
  durable_sync "$deploy_dir" || return 1
}

commit_runtime_env() {
  if [ -z "$env_backup_file" ]; then
    env_mutated=false
    return 0
  fi
  [ -f "$env_backup_file" ] && [ ! -L "$env_backup_file" ] || return 1
  rm -f -- "$env_backup_file" || return 1
  env_backup_file=""
  env_mutated=false
  durable_sync "$deploy_dir" || return 1
}

rollback() {
  reason="$1"
  echo "$reason; rolling back the previous application release set" >&2
  if ! restore_runtime_env; then
    echo "Failed to restore the previous runtime environment" >&2
    return 1
  fi
  if [ -z "$old_image" ]; then
    cleanup_new_release_containers
    echo "No previous image was available; new web containers were removed" >&2
    return 1
  fi

  rollback_failed=0
  if [ -n "$old_modeling_image" ]; then
    if ! MODELING_ENABLED="$old_modeling_enabled"       OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="$old_modeling_image"       run_legacy_compose "$previous_compose_file" up -d --no-deps modeling-service; then
      echo "Failed to restart the previous modeling service" >&2
      rollback_failed=1
    elif ! wait_for_service_health "$previous_compose_file" modeling-service; then
      echo "Previous modeling service restarted but did not become healthy" >&2
      rollback_failed=1
    fi
  fi

  if ! MODELING_ENABLED="$old_modeling_enabled"     OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="$old_modeling_image"     run_legacy_compose "$previous_compose_file" up -d --no-deps web worker; then
    echo "Failed to restart the previous web/worker image $old_image" >&2
    rollback_failed=1
  fi

  if [ -n "$old_modeling_image" ] && [ "$rollback_failed" -eq 0 ]; then
    if ! MODELING_ENABLED="$old_modeling_enabled"       OPENVAC_IMAGE="$old_image" OPENVAC_MODELING_IMAGE="$old_modeling_image"       run_legacy_compose "$previous_compose_file" up -d --no-deps modeling-worker; then
      echo "Failed to restart the previous modeling worker" >&2
      rollback_failed=1
    elif ! wait_for_service_running "$previous_compose_file" modeling-worker; then
      echo "Previous modeling worker restarted but did not remain running" >&2
      rollback_failed=1
    fi
  fi

  wait_for_service_running "$previous_compose_file" worker || rollback_failed=1
  wait_for_web_health || rollback_failed=1
  [ "$rollback_failed" -eq 0 ] || return 1
  echo "Rollback healthy on previous application image $old_image" >&2
}

runtime_mutated=false
deployment_committed=false
pointer_sync_failed=false
current_tmp=""
identity_tmp=""
receipt_tmp=""
journal_tmp=""

abort_uncommitted_deployment() {
  trap - HUP INT TERM
  if { [ "$runtime_mutated" = true ] || [ "$env_mutated" = true ] ||
    [ -n "$env_backup_file" ]; } &&
    [ "$deployment_committed" = false ]; then
    if rollback "Deployment interrupted before release pointer publication"; then
      clear_transaction_journal || true
    fi
  fi
  if [ -n "$current_tmp" ] && [ -f "$current_tmp" ]; then
    rm -f -- "$current_tmp"
  fi
  if [ -n "$identity_tmp" ] && [ -f "$identity_tmp" ]; then
    rm -f -- "$identity_tmp"
  fi
  if [ -n "$receipt_tmp" ] && [ -f "$receipt_tmp" ]; then
    rm -f -- "$receipt_tmp"
  fi
  if [ -n "$journal_tmp" ] && [ -f "$journal_tmp" ]; then
    rm -f -- "$journal_tmp"
  fi
  exit 1
}

trap abort_uncommitted_deployment HUP INT TERM

begin_transaction_journal() {
  journal_tmp="$deploy_dir/.deployment-transaction-$target_release_id-$$"
  (
    umask 077
    printf '%s\n' \
      "target_release=$target_release_id" \
      "activation=$activation_id" \
      "previous_release=${previous_release_id:-none}" \
      "previous_web_image=${old_image:-none}" \
      "previous_modeling_image=${old_modeling_image:-none}" \
      "status=in-progress" >"$journal_tmp"
  ) || return 1
  chmod 600 "$journal_tmp" || return 1
  mv "$journal_tmp" "$transaction_journal_file" || return 1
  journal_tmp=""
  durable_sync "$transaction_journal_file" || return 1
  durable_sync "$deploy_dir" || return 1
}

clear_transaction_journal() {
  if [ -e "$transaction_journal_file" ] || [ -L "$transaction_journal_file" ]; then
    [ -f "$transaction_journal_file" ] && [ ! -L "$transaction_journal_file" ] || return 1
    rm -f -- "$transaction_journal_file"
    durable_sync "$deploy_dir" || return 1
  fi
}

rollback_failed_deployment() {
  reason="$1"
  if rollback "$reason"; then
    clear_transaction_journal || {
      echo "Rollback succeeded but the deployment transaction journal could not be cleared" >&2
      return 1
    }
    return 0
  fi
  return 1
}

drain_previous_release_for_agent_v3_migration() {
  [ -n "$old_image" ] || {
    echo "Agent V3 migration drain requires a previous managed web/worker release" >&2
    return 1
  }
  echo "Stopping previous web/worker before the Agent V3 migration drain"
  runtime_mutated=true
  MODELING_ENABLED="$old_modeling_enabled" \
    OPENVAC_IMAGE="$old_image" \
    OPENVAC_MODELING_IMAGE="$old_modeling_image" \
    run_legacy_compose "$previous_compose_file" stop -t 30 worker web || return 1
  [ -z "$(service_container "$previous_compose_file" web)" ] || {
    echo "Previous web container is still running after the migration drain stop" >&2
    return 1
  }
  [ -z "$(service_container "$previous_compose_file" worker)" ] || {
    echo "Previous worker container is still running after the migration drain stop" >&2
    return 1
  }

  drain_query="
    select
      (select count(*) from agent_run where status in ('pending', 'running')),
      (select count(*) from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and xact_start is not null
          and now() - xact_start > interval '5 seconds'),
      (select count(*) from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock');
  "
  drain_state="$({
    release_compose exec -T postgres sh -eu -c \
      'exec psql -X --no-align --tuples-only --set ON_ERROR_STOP=on --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "$1"' \
      sh "$drain_query"
  } | tr -d '[:space:]')" || return 1
  case "$drain_state" in
    0\|0\|0) ;;
    *\|*\|*)
      echo "Agent V3 migration drain is not empty (active runs | long transactions | lock waiters: $drain_state)" >&2
      return 1
      ;;
    *)
      echo "Agent V3 migration drain returned malformed database state" >&2
      return 1
      ;;
  esac
  echo "Agent V3 migration drain passed: no active runs, long transactions, or lock waiters"
}

if [ -e "$current_release_file" ] || [ -L "$current_release_file" ]; then
  [ -f "$script_dir/backup.sh" ] && [ ! -L "$script_dir/backup.sh" ] || {
    echo "upgrade deployment requires the bundled backup script" >&2
    exit 64
  }
  managed_upgrade=true
else
  managed_upgrade=false
  echo "No current release is recorded; treating this as a first deployment"
fi

echo "Preparing immutable web release $release_image"
if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ]; then
  echo "Using the checksum-verified preloaded web archive"
else
  OPENVAC_IMAGE="$release_image" release_compose pull web worker
fi

verified_web_id="$(docker image inspect --format '{{.Id}}' "$release_image")"
case "$verified_web_id" in
  sha256:*) verified_web_id_hex="${verified_web_id#sha256:}" ;;
  *)
    echo "web release image ID must use sha256" >&2
    exit 1
    ;;
esac
case "$verified_web_id_hex" in
  ""|*[!0-9a-f]*)
    echo "web release image ID must contain lowercase hexadecimal only" >&2
    exit 1
    ;;
esac
[ "${#verified_web_id_hex}" -eq 64 ] || {
  echo "web release image ID must contain 64 hexadecimal characters" >&2
  exit 1
}
if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ] &&
  [ "$verified_web_id" != "$OPENVAC_WEB_PRELOADED_ID" ]; then
  echo "preloaded web image does not match its verified archive identity" >&2
  exit 1
fi
verified_revision="$(
  docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
    "$release_image"
)"
[ "$verified_revision" = "$target_release_id" ] || {
  echo "web release image revision does not match the target release SHA" >&2
  exit 1
}

release_identity_file="$bundle_dir/web-image-id"
identity_tmp="$bundle_dir/.web-image-id-$target_release_id-$$"
(umask 077 && printf "%s\n" "$verified_web_id" >"$identity_tmp")
chmod 600 "$identity_tmp"
if [ -e "$release_identity_file" ] || [ -L "$release_identity_file" ]; then
  [ -f "$release_identity_file" ] && [ ! -L "$release_identity_file" ] || {
    echo "existing release web image ID must be a regular file" >&2
    exit 64
  }
  cmp -s "$identity_tmp" "$release_identity_file" || {
    echo "release SHA is already bound to a different web image ID" >&2
    exit 64
  }
elif ! ln "$identity_tmp" "$release_identity_file" 2>/dev/null; then
  [ -f "$release_identity_file" ] && [ ! -L "$release_identity_file" ] &&
    cmp -s "$identity_tmp" "$release_identity_file" || {
      echo "release SHA is already bound to a different web image ID" >&2
      exit 64
    }
fi
  rm -f -- "$identity_tmp"
  identity_tmp=""
  durable_sync "$release_identity_file"
  durable_sync "$bundle_dir"
  echo "Verified web release $verified_web_id at revision $verified_revision"

echo "Verifying the configured model against /models"
if ! OPENVAC_IMAGE="$release_image"   release_compose run --rm --no-deps web pnpm model:verify; then
  echo "Configured model is not available; deployment stopped before migration" >&2
  exit 1
fi

echo "Verifying the configured DeepSeek Responses contract"
if ! OPENVAC_IMAGE="$release_image"   release_compose run --rm --no-deps web pnpm smoke:deepseek; then
  echo "Configured Responses contract is not usable; deployment stopped before migration" >&2
  exit 1
fi

echo "Verifying the configured Qwen-VL contract"
if [ -n "$desired_dashscope_workspace_id" ]; then
  if ! DASHSCOPE_WORKSPACE_ID="$desired_dashscope_workspace_id" \
    OPENVAC_IMAGE="$release_image" \
    release_compose run --rm --no-deps -e DASHSCOPE_WORKSPACE_ID \
      web pnpm smoke:qwen-vl; then
    echo "Configured Qwen-VL contract is not usable; deployment stopped before migration" >&2
    exit 1
  fi
else
  if ! OPENVAC_IMAGE="$release_image" \
    release_compose run --rm --no-deps web pnpm smoke:qwen-vl; then
    echo "Configured Qwen-VL contract is not usable; deployment stopped before migration" >&2
    exit 1
  fi
fi

if ! begin_transaction_journal; then
  echo "Could not create the persistent deployment transaction journal" >&2
  exit 1
fi

if ! apply_runtime_env; then
  if restore_runtime_env; then
    clear_transaction_journal || true
  else
    echo "Runtime environment recovery failed; retaining the deployment transaction journal" >&2
  fi
  echo "Could not transactionally configure the protected runtime environment" >&2
  exit 1
fi

if [ "$managed_upgrade" = true ]; then
  if ! drain_previous_release_for_agent_v3_migration; then
    rollback_failed_deployment "Agent V3 migration drain failed" || true
    exit 1
  fi
  echo "Creating final drained pre-migration recovery backup"
  pre_migration_backup=""
  if ! pre_migration_backup="$(
    bash "$script_dir/backup.sh" "$deployment_target"
  )" || [ -z "$pre_migration_backup" ]; then
    rollback_failed_deployment "Drained pre-migration recovery backup failed" || true
    exit 1
  fi
  echo "Drained pre-migration recovery backup ready: $pre_migration_backup"
fi

echo "Running database migration"
if ! OPENVAC_IMAGE="$release_image" release_compose run --rm migrate; then
  rollback_failed_deployment "Database migration failed" || true
  exit 1
fi

start_new_release() {
  phase="$1"
  echo "Starting web and worker ($phase)"
  runtime_mutated=true
  OPENVAC_IMAGE="$release_image" release_compose up -d --no-deps web worker || return 1
  wait_for_service_running "$compose_file" worker || return 1
  wait_for_web_health || return 1
}

stop_legacy_modeling() {
  if [ -z "$old_modeling_container$old_modeling_worker_container" ]; then
    return 0
  fi
  echo "Stopping legacy modeling containers while preserving their images and data for the R1 rollback rehearsal"
  run_legacy_compose "$previous_compose_file" stop -t 30 modeling-worker modeling-service
}

if ! start_new_release "initial activation"; then
  rollback_failed_deployment "Web/worker startup or readiness failed" || true
  exit 1
fi
if ! stop_legacy_modeling; then
  rollback_failed_deployment "Legacy modeling services could not be stopped cleanly" || true
  exit 1
fi

should_rehearse=false
rehearsal_status=not-required
case "$rollback_rehearsal_mode" in
  true)
    should_rehearse=true
    ;;
  auto)
    if [ "$legacy_modeling_declared" = true ]; then
      should_rehearse=true
    fi
    ;;
esac

if [ "$should_rehearse" = true ]; then
  echo "Running transactional R1 -> R0 -> R1 rollback rehearsal"
  if ! rollback "R1 rollback rehearsal"; then
    echo "R1 rollback rehearsal could not restore the previous release" >&2
    exit 1
  fi
  runtime_mutated=false
  if ! apply_runtime_env; then
    if restore_runtime_env; then
      clear_transaction_journal || true
    else
      echo "Runtime environment recovery failed; retaining the deployment transaction journal" >&2
    fi
    echo "Could not restore the target runtime environment after rollback rehearsal" >&2
    exit 1
  fi
  if ! start_new_release "post-rehearsal reactivation"; then
    rollback_failed_deployment "R1 reactivation after rollback rehearsal failed" || true
    exit 1
  fi
  if ! stop_legacy_modeling; then
    rollback_failed_deployment "Legacy modeling services could not be stopped after rehearsal" || true
    exit 1
  fi
  rehearsal_status=passed
  echo "R1 rollback rehearsal passed"
fi

publish_current_release() {
  current_tmp="$deploy_dir/.current-release-$target_release_id-$$"
  (umask 077 && printf "%s\n" "$target_release_id" >"$current_tmp") || return 1
  chmod 600 "$current_tmp" || return 1
  release_receipt_file="$bundle_dir/deployment-receipt"
  receipt_tmp="$bundle_dir/.deployment-receipt-$target_release_id-$$"
  (
    umask 077
    printf '%s\n' \
      "release=$target_release_id" \
      "web_image=$verified_web_id" \
      "migration=passed" \
      "health=passed" \
      "rollback_rehearsal=$rehearsal_status" \
      "status=healthy" \
      "activation=$activation_id" >"$receipt_tmp"
  ) || return 1
  chmod 600 "$receipt_tmp" || return 1
  if [ -e "$release_receipt_file" ] || [ -L "$release_receipt_file" ]; then
    [ -f "$release_receipt_file" ] && [ ! -L "$release_receipt_file" ] || {
      echo "deployment receipt must be a regular file" >&2
      return 1
    }
    existing_receipt_release="$(sed -n '1p' "$release_receipt_file")"
    existing_receipt_image="$(sed -n '2p' "$release_receipt_file")"
    existing_receipt_migration="$(sed -n '3p' "$release_receipt_file")"
    existing_receipt_health="$(sed -n '4p' "$release_receipt_file")"
    existing_receipt_rehearsal="$(sed -n '5p' "$release_receipt_file")"
    existing_receipt_status="$(sed -n '6p' "$release_receipt_file")"
    existing_receipt_activation="$(sed -n '7p' "$release_receipt_file")"
    [ "$(wc -l <"$release_receipt_file" | tr -d '[:space:]')" = 7 ] &&
      [ "$existing_receipt_release" = "release=$target_release_id" ] &&
      [ "$existing_receipt_image" = "web_image=$verified_web_id" ] &&
      [ "$existing_receipt_migration" = migration=passed ] &&
      [ "$existing_receipt_health" = health=passed ] &&
      [ "$existing_receipt_status" = status=healthy ] &&
      case "$existing_receipt_activation" in activation="$target_release_id"-*) true ;; *) false ;; esac || {
      echo "existing deployment receipt does not match this release" >&2
      return 1
    }
    case "$existing_receipt_rehearsal" in
      rollback_rehearsal=passed) ;;
      rollback_rehearsal=not-required)
        [ "$rehearsal_status" = not-required ] || {
          echo "existing deployment receipt does not prove the required rollback rehearsal" >&2
          return 1
        }
        ;;
      *)
        echo "existing deployment receipt has an invalid rollback status" >&2
        return 1
        ;;
    esac
  fi
  if [ "${OPENVAC_FORCE_POINTER_FAILURE:-false}" = true ]; then
    echo "Forced release pointer failure for deployment testing" >&2
    return 1
  fi
  # Do not allow a termination signal to split the atomic pointer rename from
  # the in-process commit marker. A signal before this block rolls R1 back; a
  # signal after it observes the deployment as committed.
  trap '' HUP INT TERM
  if ! mv -f "$receipt_tmp" "$release_receipt_file"; then
    trap abort_uncommitted_deployment HUP INT TERM
    return 1
  fi
  receipt_tmp=""
  if ! durable_sync "$release_receipt_file" || ! durable_sync "$bundle_dir"; then
    rm -f -- "$release_receipt_file"
    trap abort_uncommitted_deployment HUP INT TERM
    return 1
  fi
  if ! mv -f "$current_tmp" "$current_release_file"; then
    rm -f -- "$release_receipt_file"
    trap abort_uncommitted_deployment HUP INT TERM
    return 1
  fi
  current_tmp=""
  if ! durable_sync "$current_release_file" || ! durable_sync "$deploy_dir"; then
    pointer_sync_failed=true
    runtime_mutated=false
    trap - HUP INT TERM
    echo "current-release was written but could not be durably synced; the transaction journal was retained" >&2
    return 1
  fi
  deployment_committed=true
  runtime_mutated=false
  if ! clear_transaction_journal; then
    echo "Release committed, but its transaction journal remains and will block the next activation" >&2
  fi
  trap - HUP INT TERM
}

if ! publish_current_release; then
  if [ "$pointer_sync_failed" = true ]; then
    [ -n "$current_tmp" ] && rm -f -- "$current_tmp"
    [ -n "$receipt_tmp" ] && rm -f -- "$receipt_tmp"
    exit 1
  fi
  rollback_failed_deployment "Release pointer publication failed" || true
  [ -n "$current_tmp" ] && rm -f -- "$current_tmp"
  [ -n "$receipt_tmp" ] && rm -f -- "$receipt_tmp"
  exit 1
fi

commit_runtime_env ||
  echo "Release committed; warning: runtime environment rollback-copy cleanup was incomplete" >&2

echo "Release healthy; web-only runtime active at $target_release_id"
