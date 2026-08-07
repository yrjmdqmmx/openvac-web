#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

fail() {
  echo "modeling permanent purge refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 6 ]]; then
  fail "usage: modeling-purge-execute.sh production|staging EXPECTED_POST_INVENTORY_SHA256 PRE_MIGRATION_INVENTORY_JSON R1_SHA R2_SHA sha256:IMAGE_DIGEST"
fi
target="$1"
case "$target" in
  production)
    deploy_dir=/opt/openvac
    compose_project=openvac-production
    health_url=https://openvac.cn/api/health
    product_url=https://openvac.cn/semacad
    ;;
  staging)
    deploy_dir=/opt/openvac-staging
    compose_project=openvac-staging
    health_url=https://staging-openvac.openvac.cn/api/health
    product_url=https://staging-openvac.openvac.cn/semacad
    ;;
  *) fail "target must be production or staging" ;;
esac
expected_inventory_sha256="$2"
pre_migration_inventory_json="$3"
r1_sha="$4"
r2_sha="$5"
deployment_image_digest="$6"
[[ "$expected_inventory_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "invalid inventory SHA-256"
[[ "$r1_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R1 commit SHA"
[[ "$r2_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R2 commit SHA"
[[ "$r1_sha" != "$r2_sha" ]] || fail "R1 and R2 commit SHAs must differ"
[[ "$deployment_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid deployment image digest"
[[ -f "$pre_migration_inventory_json" && ! -L "$pre_migration_inventory_json" ]] ||
  fail "pre-migration inventory artifact must be a regular file"

pre_json_string="$(cat "$pre_migration_inventory_json")"
pre_json_text() {
  local key="$1"
  printf '%s\n' "$pre_json_string" | sed -n "s/^.*\"$key\":\"\([^\"]*\)\".*$/\1/p"
}
pre_json_number() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$pre_json_string" | sed -n "s/^.*\"$key\":\([0-9][0-9]*\).*$/\1/p")"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "pre-migration inventory is missing numeric field: $key"
  printf '%s\n' "$value"
}
[[ "$(pre_json_text phase)" == "pre-migration" ]] || fail "artifact is not a pre-migration inventory"
[[ "$(pre_json_text target)" == "$target" ]] || fail "pre-migration inventory target mismatch"
pre_migration_inventory_sha256="$(pre_json_text inventory_sha256)"
[[ "$pre_migration_inventory_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "pre-migration inventory SHA-256 is invalid"
[[ "$(pre_json_text r1_sha)" == "$r1_sha" ]] || fail "pre-migration inventory R1 SHA mismatch"
[[ "$(pre_json_text r2_sha)" == "$r2_sha" ]] || fail "pre-migration inventory R2 SHA mismatch"
pre_rollback_rehearsal="$(pre_json_text rollback_rehearsal)"
if [[ "$target" == production ]]; then
  [[ "$pre_rollback_rehearsal" == "passed" ]] ||
    fail "pre-migration inventory does not prove the R1 rollback rehearsal"
else
  case "$pre_rollback_rehearsal" in passed | not-required) ;; *) fail "invalid staging rollback evidence" ;; esac
fi
[[ "$(pre_json_text oss_bucket_versioning)" == "unversioned" ]] ||
  fail "pre-migration inventory does not prove the OSS bucket is unversioned"
pre_migration_database_tables="$(pre_json_number modeling_tables)"
pre_migration_database_enums="$(pre_json_number modeling_enums)"
pre_migration_database_cards="$(pre_json_number modeling_cards)"
pre_migration_artifact_sha256="$(sha256sum "$pre_migration_inventory_json" | awk '{print $1}')"

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

state_dir=""
post_resource_state_dir=""
pre_backup_delete_state_dir=""
final_state_dir=""
owned_activation_locks=()
cleanup() {
  for cleanup_dir in "$state_dir" "$post_resource_state_dir" "$pre_backup_delete_state_dir" "$final_state_dir"; do
    [[ -z "$cleanup_dir" || ! -d "$cleanup_dir" ]] || rm -rf -- "$cleanup_dir"
  done
  for ((lock_index = ${#owned_activation_locks[@]} - 1; lock_index >= 0; lock_index -= 1)); do
    lock_dir="${owned_activation_locks[$lock_index]}"
    rm -f -- "$lock_dir/owner"
    rmdir "$lock_dir" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT HUP INT TERM

[[ -d "$deploy_dir" && ! -L "$deploy_dir" ]] ||
  fail "deployment directory is unavailable: $deploy_dir"
activation_lock="$deploy_dir/.activation-lock"
if ! mkdir -m 700 -- "$activation_lock"; then
  fail "a deployment activation or another purge is already running for $target"
fi
printf 'modeling-purge:%s:%s\n' "$r2_sha" "$$" >"$activation_lock/owner"
chmod 600 "$activation_lock/owner"
owned_activation_locks+=("$activation_lock")

current_release_file="$deploy_dir/current-release"
[[ -f "$current_release_file" && ! -L "$current_release_file" ]] ||
  fail "current-release is unavailable for $target"
IFS= read -r active_release_sha <"$current_release_file"
[[ "$active_release_sha" == "$r2_sha" ]] || fail "R2 is not the active $target release"
digest_file="$deploy_dir/releases/$active_release_sha/WEB_IMAGE_DIGEST"
[[ -f "$digest_file" && ! -L "$digest_file" ]] ||
  fail "the active release is missing its immutable image digest"
IFS= read -r active_registry_digest <"$digest_file"
[[ "$active_registry_digest" == "$deployment_image_digest" ]] ||
  fail "the active release image digest differs from the approved R2 digest"

state_dir="$(mktemp -d)"
post_resource_state_dir="$(mktemp -d)"
pre_backup_delete_state_dir="$(mktemp -d)"
final_state_dir="$(mktemp -d)"
chmod 700 "$state_dir" "$post_resource_state_dir" "$pre_backup_delete_state_dir" "$final_state_dir"

inventory_json="$(bash "$script_dir/modeling-purge-inventory.sh" "$target" "$state_dir" \
  post-migration "$r1_sha" "$r2_sha" "$deployment_image_digest")"
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
  case "$target:$project_name:$service_name" in
    production:openvac:modeling-service|production:openvac:modeling-worker|production:openvac-production:modeling-service|production:openvac-production:modeling-worker|staging:openvac-staging:modeling-service|staging:openvac-staging:modeling-worker) ;;
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
  local temporary_env current_keys owner group mode
  case "$env_file" in
    /opt/openvac/.env | /opt/openvac-staging/.env) ;;
    *) fail "unapproved environment file" ;;
  esac
  [[ -f "$env_file" && ! -L "$env_file" ]] || fail "$env_file must be a regular file"
  owner="$(stat -c '%u' "$env_file")"
  group="$(stat -c '%g' "$env_file")"
  mode="$(stat -c '%a' "$env_file")"
  [[ "$mode" == "600" ]] || fail "$env_file must have mode 0600"
  current_keys="$(mktemp "$state_dir/current-env-keys.XXXXXX")"
  awk -F= -v file="$env_file" \
    '$1 ~ /^MODELING_[A-Z0-9_]*$/ { print file "\t" $1 }' "$env_file" | sort -u >"$current_keys"
  awk -F '\t' -v file="$env_file" '$1 == file' "$state_dir/env-keys.tsv" >"$current_keys.approved"
  cmp -s "$current_keys" "$current_keys.approved" ||
    fail "modeling environment keys changed after inventory for $env_file"
  temporary_env="$(mktemp "${env_file}.modeling-purge.XXXXXX")"
  awk '!/^MODELING_[A-Z0-9_]*=/' "$env_file" >"$temporary_env"
  chown "$owner:$group" "$temporary_env"
  chmod "$mode" "$temporary_env"
  mv -- "$temporary_env" "$env_file"
}
remove_modeling_env_keys "$deploy_dir/.env"

while IFS=$'\t' read -r approved_path path_type path_size; do
  [[ -n "$approved_path" ]] || continue
  case "$target:$approved_path" in
    production:/opt/openvac-modeling|production:/opt/openvac/modeling|production:/opt/openvac/modeling-service|production:/opt/openvac/modeling-worker|production:/var/lib/openvac-modeling|production:/var/cache/openvac-modeling|production:/var/log/openvac-modeling|production:/tmp/openvac-modeling|staging:/opt/openvac-staging-modeling|staging:/opt/openvac-staging/modeling|staging:/opt/openvac-staging/modeling-service|staging:/opt/openvac-staging/modeling-worker|staging:/var/lib/openvac-staging-modeling|staging:/var/cache/openvac-staging-modeling|staging:/var/log/openvac-staging-modeling|staging:/tmp/openvac-staging-modeling) ;;
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
while IFS= read -r modeling_object; do
  [[ -n "$modeling_object" ]] || continue
  case "$modeling_object" in
    "oss://$oss_bucket/$modeling_prefix"*) ;;
    *) fail "private inventory contains an unapproved OSS modeling target" ;;
  esac
  ossutil rm "$modeling_object" -f >/dev/null
done <"$state_dir/oss-modeling.txt"

post_resource_json="$(bash "$script_dir/modeling-purge-inventory.sh" "$target" "$post_resource_state_dir" \
  post-migration "$r1_sha" "$r2_sha" "$deployment_image_digest")"
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

clean_archive="$(bash "$script_dir/backup.sh" "$target")"
clean_uri="$(bash "$script_dir/upload-backup-oss.sh" "$target" "$clean_archive" | tail -n 1)"
[[ "$clean_uri" == "oss://$oss_bucket/openvac/backups/$target/${clean_archive##*/}" ]] ||
  fail "$target clean backup upload returned an unexpected object URI"
bash "$script_dir/verify-clean-restore.sh" "$target" "$clean_archive" >/dev/null

health_body="$(curl --fail --silent --show-error --max-time 20 "$health_url")"
[[ -n "$health_body" ]] || fail "$target health endpoint returned an empty response"
curl --fail --silent --show-error --max-time 20 "$product_url" >/dev/null

preserved_archive="$clean_archive"
preserved_checksum="$clean_archive.sha256"
preserved_uri="$clean_uri"
preserved_checksum_uri="$clean_uri.sha256"

bash "$script_dir/modeling-purge-inventory.sh" "$target" "$pre_backup_delete_state_dir" \
  post-migration "$r1_sha" "$r2_sha" "$deployment_image_digest" >/dev/null
expected_local="$pre_backup_delete_state_dir/expected-local-backups.txt"
expected_oss="$pre_backup_delete_state_dir/expected-oss-backups.txt"
{
  cat "$state_dir/local-backups.txt"
  printf '%s\n' "$preserved_archive" "$preserved_checksum"
} | sort -u >"$expected_local"
{
  cat "$state_dir/oss-backups.txt"
  printf '%s\n' "$preserved_uri" "$preserved_checksum_uri"
} | sort -u >"$expected_oss"
cmp -s "$expected_local" "$pre_backup_delete_state_dir/local-backups.txt" ||
  fail "local backup set changed while the purge was running"
cmp -s "$expected_oss" "$pre_backup_delete_state_dir/oss-backups.txt" ||
  fail "OSS backup set changed while the purge was running"

delete_old_backups() {
  local old_local old_object
  while IFS= read -r old_local; do
    [[ -n "$old_local" ]] || continue
    case "$target:$old_local" in
      production:/opt/openvac/backups/openvac-*.sql.gz|production:/opt/openvac/backups/openvac-*.sql.gz.sha256|staging:/opt/openvac-staging/backups/openvac-*.sql.gz|staging:/opt/openvac-staging/backups/openvac-*.sql.gz.sha256) ;;
      *) fail "unapproved local backup target" ;;
    esac
    [[ "$old_local" != "$preserved_archive" && "$old_local" != "$preserved_checksum" ]] ||
      fail "clean backup was present in the pre-clean inventory"
    [[ -f "$old_local" && ! -L "$old_local" ]] || fail "old local backup changed before deletion"
    rm -f -- "$old_local"
  done <"$state_dir/local-backups.txt"

  while IFS= read -r old_object; do
    [[ -n "$old_object" ]] || continue
    case "$target:$old_object" in
      production:"oss://$oss_bucket/openvac/backups/production/"*|staging:"oss://$oss_bucket/openvac/backups/staging/"*) ;;
      *) fail "unapproved OSS backup target" ;;
    esac
    [[ "$old_object" != "$preserved_uri" && "$old_object" != "$preserved_checksum_uri" ]] ||
      fail "clean OSS backup was present in the pre-clean inventory"
    ossutil rm "$old_object" -f >/dev/null
  done <"$state_dir/oss-backups.txt"
}
delete_old_backups

final_json="$(bash "$script_dir/modeling-purge-inventory.sh" "$target" "$final_state_dir" \
  post-migration "$r1_sha" "$r2_sha" "$deployment_image_digest")"
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
[[ "$(final_number local_backup_files)" == "2" ]] || fail "only the clean local archive and checksum must remain"
[[ "$(final_number oss_backup_objects)" == "2" ]] || fail "only the clean OSS archive and checksum must remain"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
receipt="$deploy_dir/modeling-purge-receipt.json"
temporary_receipt="$(mktemp "$deploy_dir/.modeling-purge-receipt.XXXXXX")"
if [[ "$target" == production ]]; then
  target_categories_json='["database","containers","images","environment_keys","filesystem_paths","oss_modeling_prefix","legacy_backups"]'
  oss_modeling_scope="verified-and-purged"
  before_oss_modeling_json="$before_oss_modeling"
  after_oss_modeling_json=0
else
  target_categories_json='["database","containers","images","environment_keys","filesystem_paths","legacy_backups"]'
  oss_modeling_scope="not-applicable"
  before_oss_modeling_json=null
  after_oss_modeling_json=null
fi
printf '{"schema":"modeling-permanent-purge-receipt-v1",' >"$temporary_receipt"
printf '"target":"%s",' "$target" >>"$temporary_receipt"
printf '"target_categories":%s,"oss_modeling_scope":"%s",' \
  "$target_categories_json" "$oss_modeling_scope" >>"$temporary_receipt"
printf '"before_counts":{"database_tables":%s,"database_enums":%s,"message_cards":%s,"containers":%s,"images":%s,"environment_keys":%s,"filesystem_paths":%s,"oss_modeling_objects":%s,"local_backup_files":%s,"oss_backup_objects":%s},' \
  "$pre_migration_database_tables" "$pre_migration_database_enums" "$pre_migration_database_cards" \
  "$before_containers" "$before_images" "$before_env_keys" "$before_paths" \
  "$before_oss_modeling_json" "$before_local_backup_files" "$before_oss_backup_objects" >>"$temporary_receipt"
printf '"after_counts":{"database_tables":0,"database_enums":0,"message_cards":0,"containers":0,"images":0,"environment_keys":0,"filesystem_paths":0,"oss_modeling_objects":%s,"legacy_local_backup_files":0,"legacy_oss_backup_objects":0},' \
  "$after_oss_modeling_json" >>"$temporary_receipt"
printf '"r1_sha":"%s","r2_sha":"%s","deployment_image_digest":"%s","pre_migration_inventory_sha256":"%s","pre_migration_artifact_sha256":"%s","inventory_sha256":"%s","completed_at":"%s","status":"success"}\n' \
  "$r1_sha" "$r2_sha" "$deployment_image_digest" "$pre_migration_inventory_sha256" \
  "$pre_migration_artifact_sha256" "$expected_inventory_sha256" "$completed_at" >>"$temporary_receipt"
chmod 600 "$temporary_receipt"
mv -- "$temporary_receipt" "$receipt"

cat "$receipt"
trap - EXIT HUP INT TERM
cleanup
