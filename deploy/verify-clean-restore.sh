#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "clean restore verification refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 2 ]]; then
  fail "usage: verify-clean-restore.sh production|staging /opt/openvac*/backups/openvac-TIMESTAMP.sql.gz"
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
  *) fail "target must be production or staging" ;;
esac

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
restore_script="$script_dir/restore-drill.sh"
[[ -f "$restore_script" && ! -L "$restore_script" ]] ||
  fail "restore-drill.sh must be a regular file"

env_file="$deploy_dir/.env"
current_release_file="$deploy_dir/current-release"
[[ -f "$env_file" && ! -L "$env_file" ]] || fail "environment file is unavailable"
[[ -f "$current_release_file" && ! -L "$current_release_file" ]] ||
  fail "current-release is unavailable"
IFS= read -r release_id <"$current_release_file"
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || fail "current release ID is invalid"
compose_file="$deploy_dir/releases/$release_id/docker-compose.yml"
[[ -f "$compose_file" && ! -L "$compose_file" ]] || fail "active Compose file is unavailable"

drop_drill_database() {
  docker compose --project-name "$compose_project" --env-file "$env_file" \
    -f "$compose_file" exec -T postgres sh -eu -c \
    'exec dropdb --username "$POSTGRES_USER" --if-exists openvac_restore_drill' \
    >/dev/null
}
cleanup() {
  status="$?"
  trap - EXIT
  drop_drill_database || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

bash "$restore_script" "$target" "$archive" >/dev/null

query_scalar() {
  local sql="$1"
  local result
  result="$(docker compose --project-name "$compose_project" --env-file "$env_file" \
    -f "$compose_file" exec -T postgres sh -eu -c \
    'exec psql --username "$POSTGRES_USER" --dbname openvac_restore_drill --no-align --tuples-only --set ON_ERROR_STOP=on --command "$1"' \
    sh "$sql")"
  result="${result//[[:space:]]/}"
  [[ "$result" =~ ^[0-9]+$ ]] || fail "restore verification returned a non-numeric count"
  printf '%s\n' "$result"
}

core_table_count="$(query_scalar \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user', 'account', 'conversation', 'message', 'knowledge_document');")"
modeling_table_count="$(query_scalar \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'modeling\\_%' ESCAPE '\\';")"
modeling_enum_count="$(query_scalar \
  "SELECT count(*) FROM pg_type JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace WHERE pg_namespace.nspname = 'public' AND pg_type.typtype = 'e' AND pg_type.typname LIKE 'modeling\\_%' ESCAPE '\\';")"
modeling_card_count="$(query_scalar \
  "SELECT count(*) FROM message WHERE jsonb_typeof(metadata) = 'object' AND metadata ? 'modelingCards';")"

[[ "$core_table_count" == "5" ]] || fail "the restored database is missing a core business table"
[[ "$modeling_table_count" == "0" ]] || fail "the restored database still contains modeling tables"
[[ "$modeling_enum_count" == "0" ]] || fail "the restored database still contains modeling enums"
[[ "$modeling_card_count" == "0" ]] || fail "the restored database still contains modeling message cards"

drop_drill_database
trap - EXIT HUP INT TERM
printf '{"target":"%s","core_table_count":%s,"modeling_table_count":0,"modeling_enum_count":0,"modeling_card_count":0,"status":"success"}\n' \
  "$target" "$core_table_count"
