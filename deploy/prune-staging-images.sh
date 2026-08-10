#!/bin/sh
set -eu

fail() {
  echo "staging image cleanup refused: $*" >&2
  exit 64
}

[ "$#" -eq 1 ] || fail "expected one content-addressed staging image"
target_image="$1"
case "$target_image" in
  openvac-web-release:*) target_hex="${target_image#openvac-web-release:}" ;;
  *) fail "target image must use the private staging release namespace" ;;
esac
case "$target_hex" in
  ""|*[!0-9a-f]*) fail "target image tag must be lowercase hexadecimal" ;;
esac
[ "${#target_hex}" -eq 64 ] ||
  fail "target image tag must contain 64 hexadecimal characters"

target_id="$(docker image inspect --format '{{.Id}}' "$target_image")" ||
  fail "target staging image is unavailable"
case "$target_id" in
  sha256:*) target_id_hex="${target_id#sha256:}" ;;
  *) fail "target staging image ID must use sha256" ;;
esac
case "$target_id_hex" in
  ""|*[!0-9a-f]*) fail "target staging image ID is malformed" ;;
esac
[ "${#target_id_hex}" -eq 64 ] ||
  fail "target staging image ID is truncated"

work_dir="$(umask 077 && mktemp -d /tmp/openvac-staging-image-prune.XXXXXX)" ||
  fail "could not create a private cleanup workspace"
used_ids="$work_dir/used-image-ids"
raw_candidate_ids="$work_dir/raw-candidate-image-ids"
candidate_ids="$work_dir/candidate-image-ids"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

container_ids="$(docker ps -aq)" || fail "could not enumerate containers"
if [ -n "$container_ids" ]; then
  # Docker container identifiers contain hexadecimal characters only. Word
  # splitting here intentionally supplies each identifier as one inspect arg.
  # shellcheck disable=SC2086
  docker inspect --format '{{.Image}}' $container_ids >"$used_ids" ||
    fail "could not inspect container image ownership"
else
  : >"$used_ids"
fi
docker image ls --no-trunc \
  --filter 'reference=openvac-web-release:*' \
  --format '{{.ID}}' >"$raw_candidate_ids" ||
  fail "could not enumerate staging release images"
LC_ALL=C sort -u "$raw_candidate_ids" >"$candidate_ids" ||
  fail "could not normalize staging release image IDs"

pruned=0
while IFS= read -r candidate_id; do
  [ -n "$candidate_id" ] || continue
  case "$candidate_id" in
    sha256:*) candidate_hex="${candidate_id#sha256:}" ;;
    *) fail "candidate staging image ID must use sha256" ;;
  esac
  case "$candidate_hex" in
    ""|*[!0-9a-f]*) fail "candidate staging image ID is malformed" ;;
  esac
  [ "${#candidate_hex}" -eq 64 ] ||
    fail "candidate staging image ID is truncated"
  [ "$candidate_id" != "$target_id" ] || continue
  grep -Fqx "$candidate_id" "$used_ids" && continue
  docker image rm --force "$candidate_id" >/dev/null 2>&1 ||
    fail "an unused staging release image could not be removed"
  pruned=$((pruned + 1))
done <"$candidate_ids"

echo "Pruned $pruned unused staging release image(s); preserved target and container-owned images"
