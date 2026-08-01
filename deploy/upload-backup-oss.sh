#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  echo "OSS backup upload refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 2 ]]; then
  fail "usage: upload-backup-oss.sh production|staging /opt/openvac*/backups/openvac-TIMESTAMP.sql.gz"
fi

target="$1"
archive="$2"
case "$target" in
  production) backup_dir=/opt/openvac/backups ;;
  staging) backup_dir=/opt/openvac-staging/backups ;;
  *) fail "target must be production or staging" ;;
esac

[[ -d "$backup_dir" && ! -L "$backup_dir" ]] ||
  fail "backup directory must be a real directory, not a symlink"
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

: "${OSS_BACKUP_BUCKET:?OSS_BACKUP_BUCKET is required}"
: "${OSS_BACKUP_PREFIX:?OSS_BACKUP_PREFIX is required}"
: "${OSS_REGION:?OSS_REGION is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
: "${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"

[[ "$OSS_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] ||
  fail "OSS_BACKUP_BUCKET is invalid"
[[ "$OSS_BACKUP_PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
  fail "OSS_BACKUP_PREFIX is invalid"
case "/$OSS_BACKUP_PREFIX/" in
  *//* | */../* | */./*) fail "OSS_BACKUP_PREFIX contains an unsafe segment" ;;
esac
[[ "$OSS_REGION" =~ ^[a-z0-9-]+$ ]] || fail "OSS_REGION is invalid"
[[ "$OSS_ENDPOINT" =~ ^https://[A-Za-z0-9.-]+\.aliyuncs\.com$ ]] ||
  fail "OSS_ENDPOINT must be an Alibaba Cloud HTTPS endpoint"
[[ -z "${OSSUTIL_CONFIG_FILE:-}" && -z "${OSSUTIL_PROFILE:-}" ]] ||
  fail "ossutil config files/profiles are disabled; credentials must come from environment variables"
command -v ossutil >/dev/null 2>&1 || fail "ossutil is not installed"

prefix="${OSS_BACKUP_PREFIX%/}/$target"
archive_object="oss://$OSS_BACKUP_BUCKET/$prefix/$archive_name"
checksum_object="$archive_object.sha256"

# ossutil consumes OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, and the optional
# OSS_SESSION_TOKEN from the environment. Never add credential command flags.
ossutil cp "$checksum" "$checksum_object" \
  --acl private \
  --disable-all-symlink \
  --force
ossutil cp "$archive" "$archive_object" \
  --acl private \
  --disable-all-symlink \
  --force

echo "$archive_object"
