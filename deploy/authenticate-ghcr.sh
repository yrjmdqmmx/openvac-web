#!/bin/sh
set -eu
umask 077

fail() {
  echo "temporary GHCR authentication refused: $*" >&2
  exit 64
}

if [ "$#" -ne 2 ]; then
  fail "expected REMOTE_STAGE GHCR_USERNAME; the token must be in the fixed stage file"
fi

remote_stage="$1"
ghcr_username="$2"

if [ -n "${OPENVAC_GHCR_AUTH_TEST_ROOT:-}" ]; then
  case "$OPENVAC_GHCR_AUTH_TEST_ROOT" in
    /*) ;;
    *) fail "test root must be an absolute path" ;;
  esac
  [ "$remote_stage" = "$OPENVAC_GHCR_AUTH_TEST_ROOT" ] ||
    fail "stage does not match the exact deployment test root"
else
  case "$remote_stage" in
    /tmp/openvac-deploy-?*) ;;
    *) fail "stage must be an OpenVac deployment directory under /tmp" ;;
  esac
fi

[ -d "$remote_stage" ] && [ ! -L "$remote_stage" ] ||
  fail "stage must be a real directory, not a symlink"
[ "$(stat -c '%a' "$remote_stage")" = 700 ] ||
  fail "stage must have mode 0700"
case "$ghcr_username" in
  ""|-*|*[!A-Za-z0-9-]*) fail "GitHub actor is not a safe GHCR username" ;;
esac

token_file="$remote_stage/openvac-ghcr-token"
[ -f "$token_file" ] && [ ! -L "$token_file" ] ||
  fail "token file must be a regular file, not a symlink"
[ "$(stat -c '%a' "$token_file")" = 600 ] ||
  fail "token file must have mode 0600"
[ -s "$token_file" ] || fail "token file must not be empty"

docker_config="$remote_stage/docker-config"
if [ -e "$docker_config" ] || [ -L "$docker_config" ]; then
  fail "Docker configuration path must not already exist"
fi
install -d -m 700 "$docker_config"
[ -d "$docker_config" ] && [ ! -L "$docker_config" ] ||
  fail "Docker configuration path must be a real directory"
[ "$(stat -c '%a' "$docker_config")" = 700 ] ||
  fail "Docker configuration directory must have mode 0700"

cleanup_token() {
  rm -f -- "$token_file"
}
trap cleanup_token EXIT HUP INT TERM

DOCKER_CONFIG="$docker_config" docker login ghcr.io \
  --username "$ghcr_username" --password-stdin <"$token_file"

rm -f -- "$token_file"
trap - EXIT HUP INT TERM
