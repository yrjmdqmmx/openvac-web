#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "restore drill refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 2 ]]; then
  echo "usage: restore-drill.sh production|staging /opt/openvac*/backups/openvac-TIMESTAMP.sql.gz" >&2
  exit 64
fi

target="$1"
archive="$2"
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
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] ||
  fail "backup directory must be a real directory, not a symlink"

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

[[ "${archive%/*}" == "$backup_dir" ]] ||
  fail "backup must be directly inside $backup_dir"
archive_name="${archive##*/}"
[[ "$archive_name" =~ ^openvac-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]+\.sql\.gz$ ]] ||
  fail "backup filename is invalid"
[[ -f "$archive" && ! -L "$archive" ]] ||
  fail "backup must be a regular file, not a symlink"
checksum="$archive.sha256"
[[ -f "$checksum" && ! -L "$checksum" ]] ||
  fail "backup checksum must be a regular file, not a symlink"
[[ "$(wc -l <"$checksum")" -eq 1 ]] || fail "backup checksum is malformed"
read -r checksum_hash checksum_name <"$checksum"
[[ "$checksum_hash" =~ ^[0-9a-f]{64}$ && "$checksum_name" == "$archive_name" ]] ||
  fail "backup checksum does not name the selected archive"

(
  cd "$backup_dir"
  sha256sum --check "${checksum##*/}"
)
gzip -t "$archive"

cleanup_on_failure=true
cleanup() {
  status="$?"
  trap - EXIT
  if [[ "$cleanup_on_failure" == true ]]; then
    docker compose \
      --project-name "$compose_project" \
      --env-file "$env_file" \
      -f "$compose_file" \
      exec -T postgres sh -eu -c \
      'exec dropdb --username "$POSTGRES_USER" --if-exists openvac_restore_drill' || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker compose \
  --project-name "$compose_project" \
  --env-file "$env_file" \
  -f "$compose_file" \
  exec -T postgres sh -eu -c \
  'exec dropdb --username "$POSTGRES_USER" --if-exists openvac_restore_drill'
docker compose \
  --project-name "$compose_project" \
  --env-file "$env_file" \
  -f "$compose_file" \
  exec -T postgres sh -eu -c \
  'exec createdb --username "$POSTGRES_USER" openvac_restore_drill'
gzip -cd "$archive" |
  docker compose \
    --project-name "$compose_project" \
    --env-file "$env_file" \
    -f "$compose_file" \
    exec -T postgres sh -eu -c \
    'exec psql --username "$POSTGRES_USER" --dbname openvac_restore_drill --set ON_ERROR_STOP=on'
restored_table_count="$(docker compose \
  --project-name "$compose_project" \
  --env-file "$env_file" \
  -f "$compose_file" \
  exec -T postgres sh -eu -c \
  'exec psql --username "$POSTGRES_USER" --dbname openvac_restore_drill --no-align --tuples-only --set ON_ERROR_STOP=on --command "select count(*) from information_schema.tables where table_schema='"'"'public'"'"';"')"
restored_table_count="${restored_table_count//[[:space:]]/}"
[[ "$restored_table_count" =~ ^[0-9]+$ ]] ||
  fail "restore drill returned a non-numeric public table count"
((restored_table_count > 0)) ||
  fail "restore drill produced an empty public schema"

cleanup_on_failure=false
echo "Restore drill succeeded with $restored_table_count public table(s). The isolated drill database was retained for inspection."
