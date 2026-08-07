#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

fail() {
  echo "modeling permanent purge refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 9 ]]; then
  fail "usage: modeling-purge-execute.sh production EXPECTED_INVENTORY_SHA256 PRE_MIGRATION_INVENTORY_SHA256 PRE_TABLES PRE_ENUMS PRE_CARDS R1_SHA R2_SHA sha256:IMAGE_DIGEST"
fi
[[ "$1" == "production" ]] || fail "only the production purge scope is supported"
expected_inventory_sha256="$2"
pre_migration_inventory_sha256="$3"
pre_migration_database_tables="$4"
pre_migration_database_enums="$5"
pre_migration_database_cards="$6"
r1_sha="$7"
r2_sha="$8"
deployment_image_digest="$9"
[[ "$expected_inventory_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid inventory SHA-256"
[[ "$pre_migration_inventory_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid pre-migration inventory SHA-256"
[[ "$pre_migration_database_tables" =~ ^[0-9]+$ ]] || fail "invalid pre-migration table count"
[[ "$pre_migration_database_enums" =~ ^[0-9]+$ ]] || fail "invalid pre-migration enum count"
[[ "$pre_migration_database_cards" =~ ^[0-9]+$ ]] || fail "invalid pre-migration message-card count"
[[ "$r1_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R1 commit SHA"
[[ "$r2_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R2 commit SHA"
[[ "$r1_sha" != "$r2_sha" ]] || fail "R1 and R2 commit SHAs must differ"
[[ "$deployment_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid deployment image digest"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for helper in \
  modeling-purge-inventory.sh \
  backup.sh \
  upload-backup-oss.sh \
  restore-drill.sh \
  verify-clean-restore.sh; do
  [[ -f "$script_dir/$helper" && ! -L "$script_dir/$helper" ]] ||
    fail "required helper is missing or is a symbolic link: $helper"
done
for command_name in docker ossutil curl awk sed sort sha256sum stat find cmp mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done

for release_target in /opt/openvac /opt/openvac-staging; do
  current_release_file="$release_target/current-release"
  [[ -f "$current_release_file" && ! -L "$current_release_file" ]] ||
    fail "current-release is unavailable for $release_target"
  IFS= read -r active_release_sha <"$current_release_file"
  [[ "$active_release_sha" == "$r2_sha" ]] ||
    fail "R2 is not the active release for $release_target"
  digest_file="$release_target/releases/$active_release_sha/WEB_IMAGE_DIGEST"
  [[ -f "$digest_file" && ! -L "$digest_file" ]] ||
    fail "the active release is missing its immutable image digest"
  IFS= read -r active_registry_digest <"$digest_file"
  [[ "$active_registry_digest" == "$deployment_image_digest" ]] ||
    fail "the active release image digest differs from the approved R2 digest"
done

state_dir="$(mktemp -d)"
post_resource_state_dir="$(mktemp -d)"
pre_backup_delete_state_dir="$(mktemp -d)"
final_state_dir="$(mktemp -d)"
chmod 700 "$state_dir" "$post_resource_state_dir" "$pre_backup_delete_state_dir" "$final_state_dir"
cleanup() {
  rm -rf -- "$state_dir" "$post_resource_state_dir" "$pre_backup_delete_state_dir" "$final_state_dir"
}
trap cleanup EXIT HUP INT TERM

inventory_json="$(bash "$script_dir/modeling-purge-inventory.sh" production "$state_dir")"
json_number() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$inventory_json" | sed -n "s/^.*\"$key\":\([0-9][0-9]*\).*$/\1/p")"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "inventory JSON is missing numeric field: $key"
  printf '%s\n' "$value"
}
actual_inventory_sha256="$(printf '%s\n' "$inventory_json" | sed -n 's/^.*"inventory_sha256":"\([0-9a-f]\{64\}\)".*$/\1/p')"
[[ "$actual_inventory_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "inventory JSON is malformed"
if [[ "$actual_inventory_sha256" != "$expected_inventory_sha256" ]]; then
  fail "inventory changed after approval; run a new read-only inventory and review it"
fi

database_modeling_tables="$(json_number modeling_tables)"
database_modeling_enums="$(json_number modeling_enums)"
database_modeling_cards="$(json_number modeling_cards)"
[[ "$database_modeling_tables" == "0" ]] || fail "R2 migration has not removed every modeling table"
[[ "$database_modeling_enums" == "0" ]] || fail "R2 migration has not removed every modeling enum"
[[ "$database_modeling_cards" == "0" ]] || fail "R2 migration has not removed every modeling message card"

before_containers="$(json_number containers)"
before_images="$(json_number images)"
before_env_keys="$(json_number env_keys)"
before_paths="$(json_number paths)"
before_oss_modeling="$(json_number oss_modeling_objects)"
before_local_backup_files="$(json_number local_backup_files)"
before_oss_backup_objects="$(json_number oss_backup_objects)"

while IFS=$'\t' read -r container_id container_name project_name service_name image_id; do
  [[ -n "$container_id" ]] || continue
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || fail "private inventory contains an invalid container ID"
  case "$project_name:$service_name" in
    openvac:modeling-service | openvac:modeling-worker |
    openvac-production:modeling-service | openvac-production:modeling-worker |
    openvac-staging:modeling-service | openvac-staging:modeling-worker) ;;
    *) fail "private inventory contains an unapproved container target" ;;
  esac
  current_name="$(docker container inspect --format '{{.Name}}' "$container_id")"
  current_name="${current_name#/}"
  current_image="$(docker container inspect --format '{{.Image}}' "$container_id")"
  [[ "$current_name" == "$container_name" && "$current_image" == "$image_id" ]] ||
    fail "a legacy container changed after inventory"
  docker container rm --force -- "$container_id" >/dev/null
done <"$state_dir/containers.tsv"

while IFS= read -r image_id; do
  [[ -n "$image_id" ]] || continue
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "private inventory contains an invalid image ID"
  while IFS= read -r remaining_container; do
    [[ -n "$remaining_container" ]] || continue
    remaining_image="$(docker container inspect --format '{{.Image}}' "$remaining_container")"
    [[ "$remaining_image" != "$image_id" ]] ||
      fail "refusing to remove an image still referenced by a retained container"
  done < <(docker container ls --all --quiet --no-trunc)
  docker image rm --force -- "$image_id" >/dev/null
done <"$state_dir/images.txt"

remove_modeling_env_keys() {
  local env_file="$1"
  local temporary_env owner group mode
  case "$env_file" in
    /opt/openvac/.env | /opt/openvac-staging/.env) ;;
    *) fail "unapproved environment file" ;;
  esac
  [[ -f "$env_file" && ! -L "$env_file" ]] || fail "$env_file must be a regular file"
  owner="$(stat -c '%u' "$env_file")"
  group="$(stat -c '%g' "$env_file")"
  mode="$(stat -c '%a' "$env_file")"
  [[ "$mode" == "600" ]] || fail "$env_file must have mode 0600"
  temporary_env="$(mktemp "${env_file}.modeling-purge.XXXXXX")"
  awk '!/^MODELING_[A-Z0-9_]*=/' "$env_file" >"$temporary_env"
  chown "$owner:$group" "$temporary_env"
  chmod "$mode" "$temporary_env"
  mv -- "$temporary_env" "$env_file"
}
remove_modeling_env_keys /opt/openvac/.env
remove_modeling_env_keys /opt/openvac-staging/.env

while IFS=$'\t' read -r approved_path path_type path_size; do
  [[ -n "$approved_path" ]] || continue
  case "$approved_path" in
    /opt/openvac-modeling | /opt/openvac-staging-modeling |
    /opt/openvac/modeling | /opt/openvac/modeling-service | /opt/openvac/modeling-worker |
    /opt/openvac-staging/modeling | /opt/openvac-staging/modeling-service | /opt/openvac-staging/modeling-worker |
    /var/lib/openvac-modeling | /var/cache/openvac-modeling | /var/log/openvac-modeling |
    /tmp/openvac-modeling) ;;
    *) fail "private inventory contains an unapproved filesystem target" ;;
  esac
  [[ -e "$approved_path" && ! -L "$approved_path" ]] ||
    fail "an inventoried filesystem target changed before deletion"
  current_type="$(stat -c '%F' "$approved_path")"
  current_size="$(du -sb -- "$approved_path" | awk '{print $1}')"
  [[ "$current_type" == "$path_type" && "$current_size" == "$path_size" ]] ||
    fail "an inventoried filesystem target changed before deletion"
  rm -rf -- "$approved_path"
done <"$state_dir/paths.tsv"

oss_bucket="openvac-modeling-hz-20260802"
modeling_prefix="modeling/"
backup_env=/etc/openvac/backup.env
set -a
# shellcheck disable=SC1090
source "$backup_env"
set +a
[[ "$OSS_BACKUP_BUCKET" == "$oss_bucket" ]] || fail "backup bucket changed after inventory"
ossutil rm "oss://$oss_bucket/$modeling_prefix" -r -f >/dev/null

post_resource_json="$(bash "$script_dir/modeling-purge-inventory.sh" production "$post_resource_state_dir")"
post_number() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$post_resource_json" | sed -n "s/^.*\"$key\":\([0-9][0-9]*\).*$/\1/p")"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "post-clean inventory is malformed"
  printf '%s\n' "$value"
}
for zero_key in containers images env_keys paths oss_modeling_objects modeling_tables modeling_enums modeling_cards; do
  [[ "$(post_number "$zero_key")" == "0" ]] || fail "post-clean verification failed for $zero_key"
done

clean_production_archive="$(bash "$script_dir/backup.sh" production)"
clean_production_uri="$(bash "$script_dir/upload-backup-oss.sh" production "$clean_production_archive")"
bash "$script_dir/verify-clean-restore.sh" production "$clean_production_archive" >/dev/null

clean_staging_archive="$(bash "$script_dir/backup.sh" staging)"
clean_staging_uri="$(bash "$script_dir/upload-backup-oss.sh" staging "$clean_staging_archive")"
bash "$script_dir/verify-clean-restore.sh" staging "$clean_staging_archive" >/dev/null

for health_url in https://openvac.cn/api/health https://staging-openvac.openvac.cn/api/health; do
  health_body="$(curl --fail --silent --show-error --max-time 20 "$health_url")"
  [[ -n "$health_body" ]] || fail "health endpoint returned an empty response"
done
curl --fail --silent --show-error --max-time 20 https://openvac.cn/semacad >/dev/null

preserved_archive="$clean_production_archive"
preserved_checksum="$clean_production_archive.sha256"
preserved_staging_archive="$clean_staging_archive"
preserved_staging_checksum="$clean_staging_archive.sha256"
preserved_production_uri="$clean_production_uri"
preserved_production_checksum_uri="$clean_production_uri.sha256"
preserved_staging_uri="$clean_staging_uri"
preserved_staging_checksum_uri="$clean_staging_uri.sha256"

bash "$script_dir/modeling-purge-inventory.sh" production "$pre_backup_delete_state_dir" >/dev/null
expected_local="$pre_backup_delete_state_dir/expected-local-backups.txt"
expected_oss="$pre_backup_delete_state_dir/expected-oss-backups.txt"
{
  cat "$state_dir/local-backups.txt"
  printf '%s\n' "$preserved_archive" "$preserved_checksum" \
    "$preserved_staging_archive" "$preserved_staging_checksum"
} | sort -u >"$expected_local"
{
  cat "$state_dir/oss-backups.txt"
  printf '%s\n' "$preserved_production_uri" "$preserved_production_checksum_uri" \
    "$preserved_staging_uri" "$preserved_staging_checksum_uri"
} | sort -u >"$expected_oss"
cmp -s "$expected_local" "$pre_backup_delete_state_dir/local-backups.txt" ||
  fail "local backup set changed while the purge was running"
cmp -s "$expected_oss" "$pre_backup_delete_state_dir/oss-backups.txt" ||
  fail "OSS backup set changed while the purge was running"

delete_old_backups() {
  local old_local old_object
  while IFS= read -r old_local; do
    [[ -n "$old_local" ]] || continue
    case "$old_local" in
      /opt/openvac/backups/openvac-*.sql.gz | /opt/openvac/backups/openvac-*.sql.gz.sha256 |
      /opt/openvac-staging/backups/openvac-*.sql.gz | /opt/openvac-staging/backups/openvac-*.sql.gz.sha256) ;;
      *) fail "unapproved local backup target" ;;
    esac
    [[ "$old_local" != "$preserved_archive" && "$old_local" != "$preserved_checksum" &&
      "$old_local" != "$preserved_staging_archive" && "$old_local" != "$preserved_staging_checksum" ]] ||
      fail "clean backup was present in the pre-clean inventory"
    [[ -f "$old_local" && ! -L "$old_local" ]] || fail "old local backup changed before deletion"
    rm -f -- "$old_local"
  done <"$state_dir/local-backups.txt"

  while IFS= read -r old_object; do
    [[ -n "$old_object" ]] || continue
    case "$old_object" in
      "oss://$oss_bucket/openvac/backups/production/"* |
      "oss://$oss_bucket/openvac/backups/staging/"*) ;;
      *) fail "unapproved OSS backup target" ;;
    esac
    [[ "$old_object" != "$preserved_production_uri" &&
      "$old_object" != "$preserved_production_checksum_uri" &&
      "$old_object" != "$preserved_staging_uri" &&
      "$old_object" != "$preserved_staging_checksum_uri" ]] ||
      fail "clean OSS backup was present in the pre-clean inventory"
    ossutil rm "$old_object" -f >/dev/null
  done <"$state_dir/oss-backups.txt"
}
delete_old_backups

final_json="$(bash "$script_dir/modeling-purge-inventory.sh" production "$final_state_dir")"
final_number() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$final_json" | sed -n "s/^.*\"$key\":\([0-9][0-9]*\).*$/\1/p")"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "final inventory is malformed"
  printf '%s\n' "$value"
}
for zero_key in containers images env_keys paths oss_modeling_objects modeling_tables modeling_enums modeling_cards; do
  [[ "$(final_number "$zero_key")" == "0" ]] || fail "final zero-count verification failed for $zero_key"
done
[[ "$(final_number local_backup_files)" == "4" ]] || fail "only two clean local archives and checksums must remain"
[[ "$(final_number oss_backup_objects)" == "4" ]] || fail "only two clean OSS archives and checksums must remain"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
receipt=/opt/openvac/modeling-purge-receipt.json
temporary_receipt="$(mktemp /opt/openvac/.modeling-purge-receipt.XXXXXX)"
printf '{"schema":"modeling-permanent-purge-receipt-v1",' >"$temporary_receipt"
printf '"target_categories":["database","containers","images","environment_keys","filesystem_paths","oss_modeling_prefix","legacy_backups"],' >>"$temporary_receipt"
printf '"before_counts":{"database_tables":%s,"database_enums":%s,"message_cards":%s,"containers":%s,"images":%s,"environment_keys":%s,"filesystem_paths":%s,"oss_modeling_objects":%s,"local_backup_files":%s,"oss_backup_objects":%s},' \
  "$pre_migration_database_tables" "$pre_migration_database_enums" "$pre_migration_database_cards" \
  "$before_containers" "$before_images" "$before_env_keys" "$before_paths" \
  "$before_oss_modeling" "$before_local_backup_files" "$before_oss_backup_objects" >>"$temporary_receipt"
printf '"after_counts":{"database_tables":0,"database_enums":0,"message_cards":0,"containers":0,"images":0,"environment_keys":0,"filesystem_paths":0,"oss_modeling_objects":0,"legacy_local_backup_files":0,"legacy_oss_backup_objects":0},' >>"$temporary_receipt"
printf '"r1_sha":"%s","r2_sha":"%s","deployment_image_digest":"%s","pre_migration_inventory_sha256":"%s","inventory_sha256":"%s","completed_at":"%s","status":"success"}\n' \
  "$r1_sha" "$r2_sha" "$deployment_image_digest" "$pre_migration_inventory_sha256" \
  "$expected_inventory_sha256" "$completed_at" >>"$temporary_receipt"
chmod 600 "$temporary_receipt"
mv -- "$temporary_receipt" "$receipt"

cat "$receipt"
trap - EXIT HUP INT TERM
cleanup
