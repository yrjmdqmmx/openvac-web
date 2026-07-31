#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir="${OPENVAC_BACKUP_DIR:-/opt/openvac/backups}"
case "$backup_dir" in
  /opt/openvac/backups|/opt/openvac-staging/backups) ;;
  *)
    echo "refusing unexpected backup directory: $backup_dir" >&2
    exit 64
    ;;
esac

install -d -m 700 "$backup_dir"
chmod 700 "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_archive="$(mktemp "$backup_dir/.openvac-$timestamp.XXXXXX")"
archive="$backup_dir/openvac-$timestamp-${temporary_archive##*.}.sql.gz"

cleanup() {
  if [[ -n "${temporary_archive:-}" ]]; then
    rm -f -- "$temporary_archive"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-openvac}" \
  --dbname "${POSTGRES_DB:-openvac}" \
  --format=plain \
  --no-owner \
  --no-privileges | gzip -9 >"$temporary_archive"

gzip -t "$temporary_archive"
chmod 600 "$temporary_archive"
mv -- "$temporary_archive" "$archive"
temporary_archive=""
trap - EXIT

echo "$archive"
