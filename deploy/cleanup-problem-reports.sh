#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "problem-report cleanup refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 1 ]]; then
  fail "usage: cleanup-problem-reports.sh production|staging"
fi

target="$1"
case "$target" in
  production)
    deploy_dir=/opt/openvac
    compose_project=openvac-production
    ;;
  staging)
    deploy_dir=/opt/openvac-staging
    compose_project=openvac-staging
    ;;
  *)
    fail "target must be production or staging"
    ;;
esac

env_file="$deploy_dir/.env"
releases_dir="$deploy_dir/releases"
current_release_file="$deploy_dir/current-release"

[[ -d "$deploy_dir" && ! -L "$deploy_dir" ]] ||
  fail "deployment directory must be a real directory"
[[ -f "$env_file" && ! -L "$env_file" ]] ||
  fail "environment file must be a regular file, not a symlink"
[[ "$(stat -c '%a' "$env_file")" == 600 ]] ||
  fail "environment file must have mode 0600"
[[ -d "$releases_dir" && ! -L "$releases_dir" ]] ||
  fail "releases directory must be a real directory"
[[ -f "$current_release_file" && ! -L "$current_release_file" ]] ||
  fail "current-release must be a regular file, not a symlink"
[[ "$(stat -c '%s' "$current_release_file")" -eq 41 ]] ||
  fail "current-release must contain one 40-character SHA and a newline"

IFS= read -r release_id <"$current_release_file"
case "$release_id" in
  "" | *[!0-9a-f]*) fail "current-release is not a lowercase commit SHA" ;;
esac
[[ "${#release_id}" -eq 40 ]] ||
  fail "current-release must contain a 40-character commit SHA"

release_dir="$releases_dir/$release_id"
compose_file="$release_dir/docker-compose.yml"
[[ -d "$release_dir" && ! -L "$release_dir" ]] ||
  fail "active release directory must be a real directory"
[[ -f "$compose_file" && ! -L "$compose_file" ]] ||
  fail "active Compose file must be a regular file, not a symlink"

compose() {
  docker compose \
    --project-name "$compose_project" \
    --env-file "$env_file" \
    -f "$compose_file" \
    "$@"
}

web_container="$(compose ps -q web)"
[[ -n "$web_container" ]] ||
  fail "the managed web container is not running"

# Execute inside the already-running release. The host never sources or prints
# the environment file, and no mutable image tag is needed for a one-off run.
compose exec -T web pnpm problem-reports:cleanup
