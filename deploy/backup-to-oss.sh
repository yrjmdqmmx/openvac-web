#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$#" -ne 1 ]]; then
  echo "usage: backup-to-oss.sh production|staging" >&2
  exit 64
fi

target="$1"
case "$target" in
  production | staging) ;;
  *)
    echo "target must be production or staging" >&2
    exit 64
    ;;
esac

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for script in backup.sh upload-backup-oss.sh rotate-backups.sh; do
  [[ -f "$script_dir/$script" && ! -L "$script_dir/$script" ]] || {
    echo "required script is missing or is a symlink: $script" >&2
    exit 64
  }
done

archive="$(bash "$script_dir/backup.sh" "$target")"
object_uri="$(bash "$script_dir/upload-backup-oss.sh" "$target" "$archive")"
bash "$script_dir/rotate-backups.sh" "$target"

echo "Backup uploaded privately: $object_uri"
