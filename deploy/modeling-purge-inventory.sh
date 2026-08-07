#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

fail() {
  echo "modeling purge inventory refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 6 ]]; then
  fail "usage: modeling-purge-inventory.sh production|staging PRIVATE_STATE_DIR pre-migration|post-migration R1_SHA R2_SHA DEPLOYMENT_IMAGE_DIGEST_OR_EMPTY"
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
  *) fail "target must be production or staging" ;;
esac
requested_state_dir="$2"
inventory_phase="$3"
r1_sha="$4"
r2_sha="$5"
deployment_image_digest="$6"
case "$inventory_phase" in
  pre-migration | post-migration) ;;
  *) fail "inventory phase must be pre-migration or post-migration" ;;
esac
[[ "$r1_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R1 commit SHA"
[[ "$r2_sha" =~ ^[0-9a-f]{40}$ ]] || fail "invalid R2 commit SHA"
[[ "$r1_sha" != "$r2_sha" ]] || fail "R1 and R2 commit SHAs must differ"
if [[ "$inventory_phase" == "pre-migration" ]]; then
  [[ -z "$deployment_image_digest" ]] || fail "pre-migration inventory must not claim an R2 image digest"
else
  [[ "$deployment_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "post-migration inventory requires the exact R2 image digest"
fi

cleanup_state=false
if [[ -n "$requested_state_dir" ]]; then
  [[ -d "$requested_state_dir" && ! -L "$requested_state_dir" ]] ||
    fail "private state directory must be a real directory"
  [[ "$(stat -c '%a' "$requested_state_dir")" == "700" ]] ||
    fail "private state directory must have mode 0700"
  state_dir="$requested_state_dir"
else
  state_dir="$(mktemp -d)"
  cleanup_state=true
fi
cleanup() {
  if [[ "$cleanup_state" == true ]]; then
    rm -rf -- "$state_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

for command_name in docker sha256sum sed grep awk sort wc stat find ossutil python3; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done

release_evidence_file="$state_dir/release-evidence.txt"
: >"$release_evidence_file"
verify_active_release() {
  local deploy_dir="$1"
  local expected_sha="$2"
  local expected_digest="$3"
  local current_release_file active_sha release_dir receipt_file digest_file
  current_release_file="$deploy_dir/current-release"
  [[ -f "$current_release_file" && ! -L "$current_release_file" ]] ||
    fail "current-release is unavailable for $deploy_dir"
  IFS= read -r active_sha <"$current_release_file"
  [[ "$active_sha" == "$expected_sha" ]] || fail "unexpected active release for $deploy_dir"
  release_dir="$deploy_dir/releases/$active_sha"
  [[ -d "$release_dir" && ! -L "$release_dir" ]] || fail "active release directory is unavailable"
  receipt_file="$release_dir/deployment-receipt"
  [[ -f "$receipt_file" && ! -L "$receipt_file" ]] || fail "active deployment receipt is unavailable"
  [[ "$(wc -l <"$receipt_file" | tr -d '[:space:]')" == "5" ]] || fail "active deployment receipt is malformed"
  [[ "$(sed -n '1p' "$receipt_file")" == "release=$active_sha" ]] || fail "deployment receipt SHA mismatch"
  [[ "$(sed -n '4p' "$receipt_file")" == "status=healthy" ]] || fail "active deployment receipt is not healthy"
  if [[ -n "$expected_digest" ]]; then
    digest_file="$release_dir/WEB_IMAGE_DIGEST"
    [[ -f "$digest_file" && ! -L "$digest_file" ]] || fail "active image digest file is unavailable"
    [[ "$(sed -n '1p' "$digest_file")" == "$expected_digest" ]] || fail "active image digest mismatch"
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "$deploy_dir" "$active_sha" "$(sed -n '3p' "$receipt_file")" \
    "$(sha256sum "$receipt_file" | awk '{print $1}')" >>"$release_evidence_file"
}

rollback_rehearsal=not-applicable
if [[ "$inventory_phase" == "pre-migration" ]]; then
  verify_active_release "$deploy_dir" "$r1_sha" ""
  receipt_rehearsal="$(awk -F '\t' -v path="$deploy_dir" '$1 == path { print $3 }' "$release_evidence_file")"
  case "$receipt_rehearsal" in
    rollback_rehearsal=passed) rollback_rehearsal=passed ;;
    rollback_rehearsal=not-required)
      [[ "$target" == "staging" ]] ||
        fail "production R1 deployment receipt does not prove the rollback rehearsal passed"
      rollback_rehearsal=not-required
      ;;
    *) fail "R1 deployment receipt has an invalid rollback rehearsal status" ;;
  esac
else
  verify_active_release "$deploy_dir" "$r2_sha" "$deployment_image_digest"
fi
sort -u -o "$release_evidence_file" "$release_evidence_file"

oss_bucket="openvac-modeling-hz-20260802"
modeling_prefix="modeling/"
backup_prefix="openvac/backups"
backup_env=/etc/openvac/backup.env
[[ -f "$backup_env" && ! -L "$backup_env" ]] ||
  fail "$backup_env must be a regular file"
[[ "$(stat -c '%a' "$backup_env")" == "600" ]] ||
  fail "$backup_env must have mode 0600"

set -a
# shellcheck disable=SC1090
source "$backup_env"
set +a
: "${OSS_BACKUP_BUCKET:?OSS_BACKUP_BUCKET is required}"
: "${OSS_BACKUP_PREFIX:?OSS_BACKUP_PREFIX is required}"
: "${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
: "${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"
[[ "$OSS_BACKUP_BUCKET" == "$oss_bucket" ]] ||
  fail "OSS backup bucket differs from the approved bucket"
[[ "${OSS_BACKUP_PREFIX%/}" == "$backup_prefix" ]] ||
  fail "OSS backup prefix differs from the approved prefix"

versioning_output="$(mktemp "$state_dir/oss-versioning.XXXXXX")"
bucket_versioning=""
if NO_COLOR=1 ossutil api get-bucket-versioning \
  --bucket "$oss_bucket" --output-format json >"$versioning_output" 2>/dev/null; then
  bucket_versioning="$(python3 - "$versioning_output" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

def find_status(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() == "status" and isinstance(child, str):
                return child
            found = find_status(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_status(child)
            if found:
                return found
    return ""

print(find_status(payload) or "Null")
PY
)"
else
  NO_COLOR=1 ossutil bucket-versioning --method get "oss://$oss_bucket" >"$versioning_output"
  bucket_versioning="$(sed -n 's/^bucket versioning status:\([A-Za-z]*\).*$/\1/p' "$versioning_output" | tail -n 1)"
fi
case "$bucket_versioning" in
  Null | Disabled | disabled) bucket_versioning=unversioned ;;
  Enabled | enabled | Suspended | suspended)
    fail "approved OSS bucket is versioned; all-version deletion requires a separate reviewed procedure"
    ;;
  *) fail "could not prove that the approved OSS bucket is unversioned" ;;
esac
rm -f -- "$versioning_output"

containers_file="$state_dir/containers.tsv"
images_file="$state_dir/images.txt"
env_keys_file="$state_dir/env-keys.tsv"
paths_file="$state_dir/paths.tsv"
oss_modeling_file="$state_dir/oss-modeling.txt"
local_backups_file="$state_dir/local-backups.txt"
oss_backups_file="$state_dir/oss-backups.txt"
: >"$containers_file"
: >"$images_file"
: >"$env_keys_file"
: >"$paths_file"
: >"$oss_modeling_file"
: >"$local_backups_file"
: >"$oss_backups_file"

while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  service_name="$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")"
  case "$service_name" in
    modeling-service | modeling-worker) ;;
    *) continue ;;
  esac
  project_name="$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")"
  case "$target:$project_name" in
    production:openvac | production:openvac-production | staging:openvac-staging) ;;
    *) continue ;;
  esac
  container_name="$(docker container inspect --format '{{.Name}}' "$container_id")"
  container_name="${container_name#/}"
  image_id="$(docker container inspect --format '{{.Image}}' "$container_id")"
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || fail "invalid container ID"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid container image ID"
  [[ "$container_name" != *$'\t'* && "$container_name" != *$'\n'* ]] ||
    fail "invalid container name"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$container_id" "$container_name" "$project_name" "$service_name" "$image_id" \
    >>"$containers_file"
  printf '%s\n' "$image_id" >>"$images_file"
done < <(docker container ls --all --quiet --no-trunc)

while IFS=$'\t' read -r repository image_id; do
  case "$repository" in
    openvac-modeling-service | */openvac-modeling-service)
      [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid modeling image ID"
      printf '%s\n' "$image_id" >>"$images_file"
      ;;
  esac
done < <(docker image ls --no-trunc --format '{{.Repository}}\t{{.ID}}')

sort -u -o "$containers_file" "$containers_file"
sort -u -o "$images_file" "$images_file"

# A web image once used by modeling-worker may also be referenced by a retained
# web/worker container. Such a shared image is deliberately not a purge target.
safe_images_file="$state_dir/images.safe.txt"
: >"$safe_images_file"
while IFS= read -r image_id; do
  [[ -n "$image_id" ]] || continue
  shared=false
  while IFS= read -r referencing_container; do
    [[ -n "$referencing_container" ]] || continue
    if ! awk -F '\t' -v id="$referencing_container" '$1 == id { found = 1 } END { exit !found }' \
      "$containers_file"; then
      shared=true
      break
    fi
  done < <(
    docker container ls --all --quiet --no-trunc | while IFS= read -r candidate_container; do
      [[ -n "$candidate_container" ]] || continue
      candidate_image="$(docker container inspect --format '{{.Image}}' "$candidate_container")"
      [[ "$candidate_image" == "$image_id" ]] && printf '%s\n' "$candidate_container"
    done
  )
  if [[ "$shared" == false ]]; then
    printf '%s\n' "$image_id" >>"$safe_images_file"
  fi
done <"$images_file"
mv -- "$safe_images_file" "$images_file"

env_file="$deploy_dir/.env"
[[ -f "$env_file" && ! -L "$env_file" ]] || fail "$env_file must be a regular file"
[[ "$(stat -c '%a' "$env_file")" == "600" ]] || fail "$env_file must have mode 0600"
awk -F= -v file="$env_file" \
  '$1 ~ /^MODELING_[A-Z0-9_]*$/ { print file "\t" $1 }' "$env_file" \
  >>"$env_keys_file"
sort -u -o "$env_keys_file" "$env_keys_file"

if [[ "$target" == production ]]; then
  approved_paths=(
    /opt/openvac-modeling
    /opt/openvac/modeling
    /opt/openvac/modeling-service
    /opt/openvac/modeling-worker
    /var/lib/openvac-modeling
    /var/cache/openvac-modeling
    /var/log/openvac-modeling
    /tmp/openvac-modeling
  )
else
  approved_paths=(
    /opt/openvac-staging-modeling
    /opt/openvac-staging/modeling
    /opt/openvac-staging/modeling-service
    /opt/openvac-staging/modeling-worker
    /var/lib/openvac-staging-modeling
    /var/cache/openvac-staging-modeling
    /var/log/openvac-staging-modeling
    /tmp/openvac-staging-modeling
  )
fi
for approved_path in "${approved_paths[@]}"; do
  if [[ -L "$approved_path" ]]; then
    fail "approved purge path must not be a symbolic link: $approved_path"
  elif [[ -e "$approved_path" ]]; then
    path_type="$(stat -c '%F' "$approved_path")"
    path_size="$(du -sb -- "$approved_path" | awk '{print $1}')"
    [[ "$path_size" =~ ^[0-9]+$ ]] || fail "invalid path size"
    printf '%s\t%s\t%s\n' "$approved_path" "$path_type" "$path_size" >>"$paths_file"
  fi
done
sort -u -o "$paths_file" "$paths_file"

list_oss_prefix() {
  local prefix="$1"
  local destination="$2"
  local listing summary_count extracted_count uri_prefix
  listing="$(mktemp "$state_dir/oss-listing.XXXXXX")"
  uri_prefix="oss://$oss_bucket/$prefix"
  NO_COLOR=1 ossutil ls "$uri_prefix" -r >"$listing"
  sed -n "s#^.*\($uri_prefix.*\)$#\1#p" "$listing" | sort -u >"$destination"
  if grep -F "$uri_prefix" "$listing" >/dev/null 2>&1 && [[ ! -s "$destination" ]]; then
    fail "ossutil output contained the prefix but could not be parsed safely"
  fi
  summary_count="$(sed -n 's/^.*Object Number is:[[:space:]]*\([0-9][0-9]*\).*$/\1/p' "$listing" | tail -n 1)"
  extracted_count="$(wc -l <"$destination" | tr -d '[:space:]')"
  [[ "$extracted_count" =~ ^[0-9]+$ ]] || fail "invalid OSS object count"
  [[ "$summary_count" =~ ^[0-9]+$ ]] ||
    fail "ossutil output did not contain the required object-count summary"
  if [[ "$summary_count" != "$extracted_count" ]]; then
    fail "ossutil summary count does not match the safely parsed object list"
  fi
  rm -f -- "$listing"
}

if [[ "$target" == production ]]; then
  list_oss_prefix "$modeling_prefix" "$oss_modeling_file"
fi
list_oss_prefix "$backup_prefix/$target/" "$oss_backups_file"

backup_dir="$deploy_dir/backups"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] || fail "$backup_dir must be a real directory"
if find "$backup_dir" -mindepth 1 -maxdepth 1 -type l -print -quit | grep -q .; then
  fail "$backup_dir contains a symbolic link"
fi
find "$backup_dir" -mindepth 1 -maxdepth 1 -type f \
  \( -name 'openvac-*.sql.gz' -o -name 'openvac-*.sql.gz.sha256' \) \
  -print >>"$local_backups_file"
sort -u -o "$local_backups_file" "$local_backups_file"

psql_scalar() {
  local deploy_dir="$1"
  local compose_project="$2"
  local sql="$3"
  local env_file="$deploy_dir/.env"
  local current_release_file="$deploy_dir/current-release"
  local release_id compose_file result
  IFS= read -r release_id <"$current_release_file"
  [[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || fail "invalid active release ID in $deploy_dir"
  compose_file="$deploy_dir/releases/$release_id/docker-compose.yml"
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || fail "active Compose file is unavailable"
  result="$(docker compose --project-name "$compose_project" --env-file "$env_file" \
    -f "$compose_file" exec -T postgres sh -eu -c \
    'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-align --tuples-only --set ON_ERROR_STOP=on --command "$1"' \
    sh "$sql")"
  result="${result//[[:space:]]/}"
  [[ "$result" =~ ^[0-9]+$ ]] || fail "database inventory returned a non-numeric count"
  printf '%s\n' "$result"
}

database_modeling_tables="$(psql_scalar "$deploy_dir" "$compose_project" \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'modeling\\_%' ESCAPE '\\';")"
database_modeling_enums="$(psql_scalar "$deploy_dir" "$compose_project" \
  "SELECT count(*) FROM pg_type JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace WHERE pg_namespace.nspname = 'public' AND pg_type.typtype = 'e' AND pg_type.typname LIKE 'modeling\\_%' ESCAPE '\\';")"
database_modeling_cards="$(psql_scalar "$deploy_dir" "$compose_project" \
  "SELECT count(*) FROM message WHERE jsonb_typeof(metadata) = 'object' AND metadata ? 'modelingCards';")"

count_lines() {
  wc -l <"$1" | tr -d '[:space:]'
}
hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

container_count="$(count_lines "$containers_file")"
image_count="$(count_lines "$images_file")"
env_key_count="$(count_lines "$env_keys_file")"
path_count="$(count_lines "$paths_file")"
oss_modeling_count="$(count_lines "$oss_modeling_file")"
local_backup_file_count="$(count_lines "$local_backups_file")"
oss_backup_object_count="$(count_lines "$oss_backups_file")"

canonical="$state_dir/canonical-inventory.txt"
{
  echo 'schema=modeling-purge-inventory-v1'
  printf 'target=%s\n' "$target"
  printf 'phase=%s\n' "$inventory_phase"
  printf 'r1_sha=%s\n' "$r1_sha"
  printf 'r2_sha=%s\n' "$r2_sha"
  printf 'deployment_image_digest=%s\n' "$deployment_image_digest"
  printf 'rollback_rehearsal=%s\n' "$rollback_rehearsal"
  printf 'bucket_versioning=%s\n' "$bucket_versioning"
  printf 'release_evidence=%s\n' "$(hash_file "$release_evidence_file")"
  printf 'database_modeling_tables=%s\n' "$database_modeling_tables"
  printf 'database_modeling_enums=%s\n' "$database_modeling_enums"
  printf 'database_modeling_cards=%s\n' "$database_modeling_cards"
  printf 'containers=%s:%s\n' "$container_count" "$(hash_file "$containers_file")"
  printf 'images=%s:%s\n' "$image_count" "$(hash_file "$images_file")"
  printf 'env_keys=%s:%s\n' "$env_key_count" "$(hash_file "$env_keys_file")"
  printf 'paths=%s:%s\n' "$path_count" "$(hash_file "$paths_file")"
  printf 'oss_modeling=%s:%s\n' "$oss_modeling_count" "$(hash_file "$oss_modeling_file")"
  printf 'local_backups=%s:%s\n' "$local_backup_file_count" "$(hash_file "$local_backups_file")"
  printf 'oss_backups=%s:%s\n' "$oss_backup_object_count" "$(hash_file "$oss_backups_file")"
} >"$canonical"
inventory_sha256="$(hash_file "$canonical")"

printf '{"schema":"modeling-purge-inventory-v1","target":"%s","phase":"%s","inventory_sha256":"%s",' \
  "$target" "$inventory_phase" "$inventory_sha256"
printf '"release_evidence":{"r1_sha":"%s","r2_sha":"%s","deployment_image_digest":"%s","rollback_rehearsal":"%s"},' \
  "$r1_sha" "$r2_sha" "$deployment_image_digest" "$rollback_rehearsal"
printf '"oss_bucket_versioning":"%s",' "$bucket_versioning"
printf '"database":{"modeling_tables":%s,"modeling_enums":%s,"modeling_cards":%s},' \
  "$database_modeling_tables" "$database_modeling_enums" "$database_modeling_cards"
printf '"counts":{"containers":%s,"images":%s,"env_keys":%s,"paths":%s,' \
  "$container_count" "$image_count" "$env_key_count" "$path_count"
printf '"oss_modeling_objects":%s,"local_backup_files":%s,"oss_backup_objects":%s}}\n' \
  "$oss_modeling_count" "$local_backup_file_count" "$oss_backup_object_count"
