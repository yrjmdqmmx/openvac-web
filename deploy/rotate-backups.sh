#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "backup rotation refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 1 ]]; then
  fail "usage: rotate-backups.sh production|staging"
fi

target="$1"
case "$target" in
  production) backup_dir=/opt/openvac/backups ;;
  staging) backup_dir=/opt/openvac-staging/backups ;;
  *) fail "target must be production or staging" ;;
esac

retention_days="${BACKUP_RETENTION_DAYS:-30}"
case "$retention_days" in
  "" | *[!0-9]*) fail "BACKUP_RETENTION_DAYS must be an integer" ;;
esac
((retention_days >= 1 && retention_days <= 3650)) ||
  fail "BACKUP_RETENTION_DAYS must be between 1 and 3650"

[[ -d "$backup_dir" && ! -L "$backup_dir" ]] ||
  fail "backup directory must be a real directory, not a symlink"
if find "$backup_dir" -mindepth 1 -maxdepth 1 -type l -name 'openvac-*' -print -quit |
  grep -q .; then
  fail "backup directory contains a symbolic link"
fi

retention_minutes=$((retention_days * 24 * 60))
deleted=0
while IFS= read -r -d '' archive; do
  [[ -f "$archive" && ! -L "$archive" ]] || fail "unsafe rotation candidate"
  checksum="$archive.sha256"
  [[ ! -L "$checksum" ]] || fail "checksum is a symbolic link"
  rm -f -- "$archive" "$checksum"
  deleted=$((deleted + 1))
done < <(
  find "$backup_dir" \
    -mindepth 1 \
    -maxdepth 1 \
    -type f \
    -name 'openvac-*.sql.gz' \
    -mmin "+$retention_minutes" \
    -print0
)

echo "Deleted $deleted local backup archive(s) older than $retention_days days."
