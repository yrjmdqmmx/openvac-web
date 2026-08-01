#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "backup refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 1 ]]; then
  fail "usage: backup.sh production|staging"
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
backup_dir="$deploy_dir/backups"

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

if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
  [[ -d "$backup_dir" && ! -L "$backup_dir" ]] ||
    fail "backup directory must be a real directory, not a symlink"
fi
install -d -m 700 "$backup_dir"
chmod 700 "$backup_dir"
[[ "$(stat -c '%a' "$backup_dir")" == 700 ]] ||
  fail "backup directory must have mode 0700"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_archive="$(mktemp "$backup_dir/.openvac-$timestamp.XXXXXX")"
archive="$backup_dir/openvac-$timestamp-${temporary_archive##*.}.sql.gz"
temporary_checksum="$(mktemp "$backup_dir/.openvac-$timestamp.sha256.XXXXXX")"
checksum="$archive.sha256"

cleanup() {
  [[ -z "${temporary_archive:-}" ]] || rm -f -- "$temporary_archive"
  [[ -z "${temporary_checksum:-}" ]] || rm -f -- "$temporary_checksum"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker compose \
  --project-name "$compose_project" \
  --env-file "$env_file" \
  -f "$compose_file" \
  exec -T postgres sh -eu -c \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=plain --no-owner --no-privileges' |
  gzip -9 >"$temporary_archive"

[[ -s "$temporary_archive" ]] || fail "database dump was empty"
gzip -t "$temporary_archive"
chmod 600 "$temporary_archive"
mv -- "$temporary_archive" "$archive"
temporary_archive=""

(
  cd "$backup_dir"
  sha256sum "${archive##*/}" >"$temporary_checksum"
)
chmod 600 "$temporary_checksum"
mv -- "$temporary_checksum" "$checksum"
temporary_checksum=""
trap - EXIT

echo "$archive"
