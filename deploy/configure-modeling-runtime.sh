#!/bin/sh
set -eu
umask 077

fail() {
  echo "modeling runtime configuration refused: $*" >&2
  exit 64
}

if [ "$#" -ne 2 ]; then
  fail "expected TARGET ENABLED; the service token must be supplied on standard input"
fi

target="$1"
enabled="$2"
case "$target" in
  production) deploy_dir=/opt/openvac ;;
  staging) deploy_dir=/opt/openvac-staging ;;
  *) fail "target must be production or staging" ;;
esac
case "$enabled" in
  true|false) ;;
  *) fail "ENABLED must be true or false" ;;
esac

if [ -n "${OPENVAC_MODELING_CONFIG_TEST_ROOT:-}" ]; then
  case "$OPENVAC_MODELING_CONFIG_TEST_ROOT" in
    /*) deploy_dir="$OPENVAC_MODELING_CONFIG_TEST_ROOT" ;;
    *) fail "test root must be an absolute path" ;;
  esac
fi

[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] ||
  fail "deployment directory must be a real directory, not a symlink"
env_file="$deploy_dir/.env"
[ -f "$env_file" ] && [ ! -L "$env_file" ] ||
  fail "environment file must be a regular file, not a symlink"
[ "$(stat -c '%a' "$env_file")" = 600 ] ||
  fail "environment file must have mode 0600"

service_token=""
IFS= read -r service_token ||
  fail "a newline-terminated service token is required on standard input"
if IFS= read -r unexpected_input; then
  unset service_token unexpected_input
  fail "standard input must contain exactly one service-token line"
fi
case "$service_token" in
  ""|*[!0-9a-f]*)
    unset service_token
    fail "service token must be exactly 64 lowercase hexadecimal characters"
    ;;
esac
[ "${#service_token}" -eq 64 ] || {
  unset service_token
  fail "service token must be exactly 64 lowercase hexadecimal characters"
}

token_count=0
enabled_count=0
existing_token=""
previous_enabled=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    MODELING_SERVICE_TOKEN=*)
      token_count=$((token_count + 1))
      existing_token="${line#MODELING_SERVICE_TOKEN=}"
      ;;
    MODELING_ENABLED=*)
      enabled_count=$((enabled_count + 1))
      previous_enabled="${line#MODELING_ENABLED=}"
      ;;
  esac
done <"$env_file"
[ "$token_count" -le 1 ] || {
  unset service_token existing_token
  fail "environment file contains duplicate MODELING_SERVICE_TOKEN entries"
}
[ "$enabled_count" -le 1 ] || {
  unset service_token existing_token
  fail "environment file contains duplicate MODELING_ENABLED entries"
}
case "$previous_enabled" in
  true|false) ;;
  *)
    unset service_token existing_token
    fail "existing MODELING_ENABLED value must be true or false"
    ;;
esac

case "$existing_token" in
  "") ;;
  *[!0-9a-f]*) ;;
  *)
    if [ "${#existing_token}" -eq 64 ] && [ "$existing_token" != "$service_token" ]; then
      unset service_token existing_token
      fail "service-token rotation requires a separate approved procedure"
    fi
    ;;
esac

temporary_env="$(mktemp "$deploy_dir/.env.modeling.XXXXXX")"
cleanup() {
  unset service_token existing_token
  if [ -n "${temporary_env:-}" ] && [ -f "$temporary_env" ]; then
    rm -f -- "$temporary_env"
  fi
}
trap cleanup EXIT HUP INT TERM

token_written=false
enabled_written=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    MODELING_SERVICE_TOKEN=*)
      printf "MODELING_SERVICE_TOKEN=%s\n" "$service_token"
      token_written=true
      ;;
    MODELING_ENABLED=*)
      printf "MODELING_ENABLED=%s\n" "$enabled"
      enabled_written=true
      ;;
    *) printf "%s\n" "$line" ;;
  esac
done <"$env_file" >"$temporary_env"
[ "$token_written" = true ] ||
  printf "MODELING_SERVICE_TOKEN=%s\n" "$service_token" >>"$temporary_env"
[ "$enabled_written" = true ] ||
  printf "MODELING_ENABLED=%s\n" "$enabled" >>"$temporary_env"
chmod 600 "$temporary_env"
[ "$(stat -c '%a' "$temporary_env")" = 600 ] ||
  fail "temporary environment file must have mode 0600"
mv -f -- "$temporary_env" "$env_file"
temporary_env=""
unset service_token existing_token
trap - EXIT HUP INT TERM

# This is deliberately the only stdout value. It is safe for the caller to
# capture and use to restore the feature flag if activation fails.
printf "%s\n" "$previous_enabled"
