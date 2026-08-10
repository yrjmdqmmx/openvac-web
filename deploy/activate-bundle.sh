#!/bin/sh
set -eu

fail() {
  echo "deployment bundle activation refused: $*" >&2
  exit 64
}

if [ "$#" -ne 6 ]; then
  fail "expected DEPLOY_DIR RELEASE_ID BUNDLE_DIR WEB_IMAGE COMPOSE_PROJECT HEALTH_URL"
fi

deploy_dir="$1"
release_id="$2"
bundle_dir="$3"
release_image="$4"
compose_project="$5"
health_url="$6"

case "$deploy_dir:$compose_project" in
  /opt/openvac:openvac-production) ;;
  /opt/openvac-staging:openvac-staging) ;;
  *)
    if [ "${OPENVAC_ACTIVATION_TEST_ROOT:-}" != "$deploy_dir" ]; then
      fail "unexpected deployment directory/project pair"
    fi
    ;;
esac
activation_is_test=false
if [ "${OPENVAC_ACTIVATION_TEST_ROOT:-}" = "$deploy_dir" ]; then
  activation_is_test=true
fi

case "$release_id" in
  ""|*[!0-9a-f]*) fail "release ID must be lowercase hexadecimal" ;;
esac
[ "${#release_id}" -eq 40 ] || fail "release ID must be a 40-character commit SHA"
activation_nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')" ||
  fail "could not generate a deployment activation nonce"
case "$activation_nonce" in
  ""|*[!0-9a-f]*) fail "deployment activation nonce must be lowercase hexadecimal" ;;
esac
[ "${#activation_nonce}" -eq 32 ] ||
  fail "deployment activation nonce must contain 32 hexadecimal characters"
activation_id="$release_id-$activation_nonce"

validate_release_image() {
  image="$1"
  image_name="${image%@sha256:*}"
  image_digest="${image##*@sha256:}"
  case "$image_name" in
    ghcr.io/?*) ;;
    *) fail "web release image must be an immutable GHCR digest" ;;
  esac
  case "$image_name" in
    *[!a-z0-9._/-]*|*//*|*/) fail "web release image contains an invalid GHCR repository name" ;;
  esac
  case "$image_digest" in
    ""|*[!0-9a-f]*) fail "web release image must contain a lowercase SHA-256 digest" ;;
  esac
  [ "${#image_digest}" -eq 64 ] ||
    fail "web release image must contain a 64-character SHA-256 digest"
}

if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ]; then
  case "$OPENVAC_WEB_PRELOADED_ID" in
    sha256:*) web_image_digest="${OPENVAC_WEB_PRELOADED_ID#sha256:}" ;;
    *) fail "preloaded web image ID must use sha256" ;;
  esac
  case "$web_image_digest" in
    ""|*[!0-9a-f]*) fail "preloaded web image ID must be lowercase hexadecimal" ;;
  esac
  [ "${#web_image_digest}" -eq 64 ] ||
    fail "preloaded web image ID must contain 64 hexadecimal characters"
  [ "$release_image" = "openvac-web-release:$web_image_digest" ] ||
    fail "preloaded web reference must be content-addressed by its image ID"
else
  validate_release_image "$release_image"
fi

case "$health_url" in
  https://*|http://127.0.0.1:*) ;;
  *) fail "health URL must use HTTPS or loopback HTTP" ;;
esac

[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] ||
  fail "deployment directory must be a real directory, not a symlink"
[ -f "$deploy_dir/.env" ] && [ ! -L "$deploy_dir/.env" ] ||
  fail "host .env must be a regular file, not a symlink"
[ "$(find "$deploy_dir/.env" -prune -type f -perm 600 -print)" = "$deploy_dir/.env" ] ||
  fail "host .env must have mode 0600"

durable_sync() {
  sync -f "$1"
}

staged_dir=""
activation_lock_dir="$deploy_dir/.activation-lock"
activation_lock_owner_file="$activation_lock_dir/owner"
activation_lock_owned=false
activation_child_pid=""
activation_heartbeat_pid=""
activation_child_starting=false
activation_signal_pending=false
stop_activation_heartbeat() {
  if [ -n "$activation_heartbeat_pid" ]; then
    kill -TERM "$activation_heartbeat_pid" >/dev/null 2>&1 || true
    wait "$activation_heartbeat_pid" >/dev/null 2>&1 || true
    activation_heartbeat_pid=""
  fi
}
cleanup() {
  stop_activation_heartbeat
  if [ -n "$staged_dir" ] && [ -d "$staged_dir" ]; then
    rm -rf -- "$staged_dir"
  fi
  if [ "$activation_lock_owned" = true ]; then
    rm -f -- "$activation_lock_owner_file"
    rmdir "$activation_lock_dir" >/dev/null 2>&1 || true
  fi
}
handle_activation_signal() {
  if [ "$activation_child_starting" = true ]; then
    activation_signal_pending=true
    return
  fi
  trap - HUP INT TERM
  if [ -n "$activation_child_pid" ]; then
    kill -TERM "$activation_child_pid" >/dev/null 2>&1 || true
    wait "$activation_child_pid" >/dev/null 2>&1 || true
    activation_child_pid=""
  fi
  cleanup
  exit 1
}
trap cleanup EXIT
trap handle_activation_signal HUP INT TERM

recover_stale_staging_activation() {
  if [ "$deploy_dir" != /opt/openvac-staging ] && [ "$activation_is_test" != true ]; then
    return 1
  fi
  [ -d "$activation_lock_dir" ] && [ ! -L "$activation_lock_dir" ] || return 1
  [ -f "$activation_lock_owner_file" ] && [ ! -L "$activation_lock_owner_file" ] ||
    return 1
  [ "$(stat -c '%a' "$activation_lock_owner_file" 2>/dev/null)" = 600 ] ||
    return 1

  existing_activation_id=""
  IFS= read -r existing_activation_id <"$activation_lock_owner_file" || return 1
  existing_release_id="${existing_activation_id%%-*}"
  existing_nonce="${existing_activation_id#*-}"
  [ "$existing_activation_id" = "$existing_release_id-$existing_nonce" ] || return 1
  case "$existing_release_id" in
    ""|*[!0-9a-f]*) return 1 ;;
  esac
  case "$existing_nonce" in
    ""|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#existing_release_id}" -eq 40 ] || return 1
  [ "${#existing_nonce}" -eq 32 ] || return 1

  lock_mtime="$(stat -c '%Y' "$activation_lock_owner_file" 2>/dev/null)" || return 1
  now_epoch="$(date +%s)" || return 1
  case "$lock_mtime:$now_epoch" in
    *[!0-9:]*) return 1 ;;
  esac
  lock_age_seconds=$((now_epoch - lock_mtime))
  [ "$lock_age_seconds" -ge 1800 ] || return 1

  stale_child_pid=""
  for process_dir in /proc/[0-9]*; do
    [ -r "$process_dir/environ" ] && [ -r "$process_dir/cmdline" ] || continue
    if ! tr '\000' '\n' <"$process_dir/environ" 2>/dev/null |
      grep -Fqx "OPENVAC_ACTIVATION_ID=$existing_activation_id"; then
      continue
    fi
    if ! tr '\000' '\n' <"$process_dir/cmdline" 2>/dev/null |
      grep -Eq '/deploy/deploy\.sh$'; then
      continue
    fi
    if ! tr '\000' '\n' <"$process_dir/cmdline" 2>/dev/null |
      grep -Fqx "$deploy_dir"; then
      continue
    fi
    candidate_pid="${process_dir##*/}"
    case "$candidate_pid" in
      ""|*[!0-9]*) return 1 ;;
    esac
    [ -z "$stale_child_pid" ] || return 1
    stale_child_pid="$candidate_pid"
  done
  [ -n "$stale_child_pid" ] || return 1

  confirmed_activation_id=""
  IFS= read -r confirmed_activation_id <"$activation_lock_owner_file" || return 1
  [ "$confirmed_activation_id" = "$existing_activation_id" ] || return 1
  confirmed_mtime="$(stat -c '%Y' "$activation_lock_owner_file" 2>/dev/null)" ||
    return 1
  confirmed_now="$(date +%s)" || return 1
  case "$confirmed_mtime:$confirmed_now" in
    *[!0-9:]*) return 1 ;;
  esac
  confirmed_age_seconds=$((confirmed_now - confirmed_mtime))
  [ "$confirmed_age_seconds" -ge 1800 ] || return 1
  kill -0 "$stale_child_pid" >/dev/null 2>&1 || return 1

  echo "Recovering a stale staging deployment activation after its lease expired" >&2
  kill -TERM "$stale_child_pid" >/dev/null 2>&1 || return 1
  recovery_wait=0
  while [ "$recovery_wait" -lt 60 ]; do
    [ ! -d "$activation_lock_dir" ] && return 0
    if [ -f "$activation_lock_owner_file" ]; then
      current_activation_id=""
      IFS= read -r current_activation_id <"$activation_lock_owner_file" || return 1
      [ "$current_activation_id" = "$existing_activation_id" ] || return 1
    fi
    sleep 1
    recovery_wait=$((recovery_wait + 1))
  done
  return 1
}

if ! mkdir -m 700 "$activation_lock_dir" 2>/dev/null; then
  if ! recover_stale_staging_activation ||
    ! mkdir -m 700 "$activation_lock_dir" 2>/dev/null; then
    fail "another deployment activation is already in progress"
  fi
fi
activation_lock_owned=true
(umask 077 && printf "%s\n" "$activation_id" >"$activation_lock_owner_file") ||
  fail "could not record the deployment activation lock owner"
chmod 600 "$activation_lock_owner_file"
durable_sync "$activation_lock_owner_file"
durable_sync "$activation_lock_dir"

current_release_file="$deploy_dir/current-release"

[ -d "$bundle_dir" ] && [ ! -L "$bundle_dir" ] ||
  fail "bundle directory must be a real directory, not a symlink"
[ -f "$bundle_dir/docker-compose.yml" ] && [ ! -L "$bundle_dir/docker-compose.yml" ] ||
  fail "bundle is missing a regular docker-compose.yml"
[ -f "$bundle_dir/deploy/deploy.sh" ] && [ ! -L "$bundle_dir/deploy/deploy.sh" ] ||
  fail "bundle is missing a regular deploy.sh"
[ -f "$bundle_dir/deploy/activate-bundle.sh" ] && [ ! -L "$bundle_dir/deploy/activate-bundle.sh" ] ||
  fail "bundle is missing a regular activate-bundle.sh"
[ -f "$bundle_dir/DEPLOY_BUNDLE.sha256" ] && [ ! -L "$bundle_dir/DEPLOY_BUNDLE.sha256" ] ||
  fail "bundle is missing a regular manifest"

if find "$bundle_dir" \( -name ".env" -o -name ".env.*" \) -print -quit |
  grep -q .; then
  fail "bundle must not contain environment files"
fi
if find "$bundle_dir" -type l -print -quit | grep -q .; then
  fail "bundle must not contain symbolic links"
fi
(
  cd "$bundle_dir"
  sha256sum --check DEPLOY_BUNDLE.sha256
)

releases_dir="$deploy_dir/releases"
release_dir="$releases_dir/$release_id"
if [ -e "$releases_dir" ] || [ -L "$releases_dir" ]; then
  [ -d "$releases_dir" ] && [ ! -L "$releases_dir" ] ||
    fail "releases path must be a real directory, not a symlink"
fi
install -d -m 700 "$releases_dir"

if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] ||
    fail "existing release path is not an immutable directory"
  cmp -s "$bundle_dir/DEPLOY_BUNDLE.sha256" "$release_dir/DEPLOY_BUNDLE.sha256" ||
    fail "existing release does not match this bundle"
  (cd "$release_dir" && sha256sum --check DEPLOY_BUNDLE.sha256)
else
  staged_dir="$releases_dir/.staging-$release_id-$$"
  install -d -m 700 "$staged_dir"
  cp -R "$bundle_dir/." "$staged_dir/"
  mv "$staged_dir" "$release_dir"
  staged_dir=""
  durable_sync "$release_dir"
  durable_sync "$releases_dir"
  (cd "$release_dir" && sha256sum --check DEPLOY_BUNDLE.sha256)
fi

deployment_postcondition_failed() {
  fail "$1; activation remains fail-closed for explicit recovery"
}

activation_child_starting=true
OPENVAC_ACTIVATION_ID="$activation_id" \
  OPENVAC_HEALTH_URL="$health_url" \
  sh "$release_dir/deploy/deploy.sh" \
  "$deploy_dir" "$release_image" "$compose_project" "$release_id" &
activation_child_pid="$!"
activation_child_starting=false
if [ "$activation_signal_pending" = true ]; then
  handle_activation_signal
fi
if [ "$activation_is_test" != true ] ||
  [ "${OPENVAC_ACTIVATION_TEST_DISABLE_HEARTBEAT:-}" != true ]; then
  (
    heartbeat_sleep_pid=""
    stop_heartbeat_sleep() {
      if [ -n "$heartbeat_sleep_pid" ]; then
        kill -TERM "$heartbeat_sleep_pid" >/dev/null 2>&1 || true
        wait "$heartbeat_sleep_pid" >/dev/null 2>&1 || true
      fi
      exit 0
    }
    trap stop_heartbeat_sleep HUP INT TERM
    while kill -0 "$activation_child_pid" >/dev/null 2>&1; do
      touch "$activation_lock_owner_file" || exit 0
      sleep 30 &
      heartbeat_sleep_pid="$!"
      wait "$heartbeat_sleep_pid" || exit 0
      heartbeat_sleep_pid=""
    done
  ) &
  activation_heartbeat_pid="$!"
fi
if wait "$activation_child_pid"; then
  deployment_status=0
else
  deployment_status="$?"
fi
activation_child_pid=""
stop_activation_heartbeat

if [ "$deployment_status" -ne 0 ] &&
  { [ "$deployment_status" -lt 128 ] || [ "$deployment_status" -gt 255 ]; }; then
  deployment_postcondition_failed "deploy.sh failed without a recoverable termination signal"
fi

web_image_id_file="$release_dir/web-image-id"
[ -f "$web_image_id_file" ] && [ ! -L "$web_image_id_file" ] ||
  deployment_postcondition_failed "deploy.sh did not publish a regular web image identity"
web_image_id_size="$(wc -c <"$web_image_id_file" | tr -d '[:space:]')"
[ "$web_image_id_size" = 72 ] ||
  deployment_postcondition_failed "deploy.sh published an invalid web image identity"
IFS= read -r active_web_image_id <"$web_image_id_file"
case "$active_web_image_id" in
  sha256:*) active_web_image_hex="${active_web_image_id#sha256:}" ;;
  *) deployment_postcondition_failed "deploy.sh published a web image identity without sha256" ;;
esac
case "$active_web_image_hex" in
  ""|*[!0-9a-f]*)
    deployment_postcondition_failed "deploy.sh published a malformed web image identity"
    ;;
esac
[ "${#active_web_image_hex}" -eq 64 ] ||
  deployment_postcondition_failed "deploy.sh published a truncated web image identity"
if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ] &&
  [ "$active_web_image_id" != "$OPENVAC_WEB_PRELOADED_ID" ]; then
  deployment_postcondition_failed "deploy.sh published the wrong preloaded web image identity"
fi

deployment_receipt_file="$release_dir/deployment-receipt"
[ -f "$deployment_receipt_file" ] && [ ! -L "$deployment_receipt_file" ] ||
  deployment_postcondition_failed "deploy.sh did not publish a regular deployment receipt"
[ "$(wc -l <"$deployment_receipt_file" | tr -d '[:space:]')" = 7 ] ||
  deployment_postcondition_failed "deploy.sh published an invalid deployment receipt"
receipt_release="$(sed -n '1p' "$deployment_receipt_file")"
receipt_image="$(sed -n '2p' "$deployment_receipt_file")"
receipt_migration="$(sed -n '3p' "$deployment_receipt_file")"
receipt_health="$(sed -n '4p' "$deployment_receipt_file")"
receipt_rehearsal="$(sed -n '5p' "$deployment_receipt_file")"
receipt_status="$(sed -n '6p' "$deployment_receipt_file")"
receipt_activation="$(sed -n '7p' "$deployment_receipt_file")"
[ "$receipt_release" = "release=$release_id" ] ||
  deployment_postcondition_failed "deployment receipt release does not match"
[ "$receipt_image" = "web_image=$active_web_image_id" ] ||
  deployment_postcondition_failed "deployment receipt image does not match"
[ "$receipt_migration" = migration=passed ] ||
  deployment_postcondition_failed "deployment receipt migration status is invalid"
[ "$receipt_health" = health=passed ] ||
  deployment_postcondition_failed "deployment receipt health gate is invalid"
case "$receipt_rehearsal" in
  rollback_rehearsal=passed|rollback_rehearsal=not-required) ;;
  *) deployment_postcondition_failed "deployment receipt rollback status is invalid" ;;
esac
if [ "${OPENVAC_R1_ROLLBACK_REHEARSAL:-auto}" = true ] &&
  [ "$receipt_rehearsal" != rollback_rehearsal=passed ]; then
  deployment_postcondition_failed "deployment receipt does not prove the required rollback rehearsal"
fi
[ "$receipt_status" = status=healthy ] ||
  deployment_postcondition_failed "deployment receipt health status is invalid"
[ "$receipt_activation" = "activation=$activation_id" ] ||
  deployment_postcondition_failed "deployment receipt does not belong to this activation"

publish_recovered_release_pointer() {
  recovered_pointer_tmp="$deploy_dir/.current-release-recovered-$release_id-$$"
  (umask 077 && printf "%s\n" "$release_id" >"$recovered_pointer_tmp") || return 1
  chmod 600 "$recovered_pointer_tmp" || {
    rm -f -- "$recovered_pointer_tmp"
    return 1
  }
  mv -f "$recovered_pointer_tmp" "$current_release_file" || {
    rm -f -- "$recovered_pointer_tmp"
    return 1
  }
  durable_sync "$current_release_file" || return 1
  durable_sync "$deploy_dir"
}

active_release_id=""
if [ -e "$current_release_file" ] || [ -L "$current_release_file" ]; then
  [ -f "$current_release_file" ] && [ ! -L "$current_release_file" ] ||
    deployment_postcondition_failed "deploy.sh published a non-regular current-release pointer"
  if [ "$(wc -c <"$current_release_file" | tr -d '[:space:]')" = 41 ]; then
    IFS= read -r active_release_id <"$current_release_file"
  fi
fi
if [ "$active_release_id" != "$release_id" ]; then
  publish_recovered_release_pointer ||
    deployment_postcondition_failed "the verified deployment pointer could not be committed"
  echo "Completed the release pointer from the verified deployment receipt" >&2
fi
durable_sync "$current_release_file" ||
  deployment_postcondition_failed "the verified deployment pointer could not be durably synced"
durable_sync "$deploy_dir" ||
  deployment_postcondition_failed "the verified deployment directory could not be durably synced"

transaction_journal_file="$deploy_dir/deployment-transaction"
if [ -e "$transaction_journal_file" ] || [ -L "$transaction_journal_file" ]; then
  [ -f "$transaction_journal_file" ] && [ ! -L "$transaction_journal_file" ] ||
    deployment_postcondition_failed "deployment transaction journal is not a regular file"
  rm -f -- "$transaction_journal_file" ||
    deployment_postcondition_failed "verified deployment transaction journal could not be cleared"
  durable_sync "$deploy_dir" ||
    deployment_postcondition_failed "deployment transaction journal removal could not be synced"
fi

if [ "$deployment_status" -ne 0 ]; then
  echo "Recovered a committed release after the deployment child exited unexpectedly" >&2
fi

echo "Activated deployment bundle $release_id"
