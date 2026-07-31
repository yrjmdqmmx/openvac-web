#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: restore-drill.sh /opt/openvac/backups/openvac-TIMESTAMP.sql.gz" >&2
  exit 64
fi

archive="$1"
case "$archive" in
  /opt/openvac/backups/openvac-*.sql.gz|/opt/openvac-staging/backups/openvac-*.sql.gz) ;;
  *)
    echo "refusing unexpected backup path" >&2
    exit 64
    ;;
esac

test -f "$archive"
gzip -t "$archive"
drill_db="openvac_restore_drill"

docker compose exec -T postgres dropdb \
  --username "${POSTGRES_USER:-openvac}" \
  --if-exists "$drill_db"
docker compose exec -T postgres createdb \
  --username "${POSTGRES_USER:-openvac}" "$drill_db"
gzip -cd "$archive" | docker compose exec -T postgres psql \
  --username "${POSTGRES_USER:-openvac}" \
  --dbname "$drill_db" \
  --set ON_ERROR_STOP=on
docker compose exec -T postgres psql \
  --username "${POSTGRES_USER:-openvac}" \
  --dbname "$drill_db" \
  --tuples-only \
  --command "select count(*) from information_schema.tables where table_schema='public';"

echo "Restore drill succeeded. The isolated drill database was retained for inspection."
