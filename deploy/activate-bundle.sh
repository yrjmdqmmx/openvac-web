#!/bin/sh
set -eu

fail() {
  echo "deployment bundle activation refused: $*" >&2
  exit 64
}

if [ "$#" -ne 7 ]; then
  fail "expected DEPLOY_DIR RELEASE_ID BUNDLE_DIR WEB_IMAGE MODELING_IMAGE COMPOSE_PROJECT HEALTH_URL"
fi

deploy_dir="$1"
release_id="$2"
bundle_dir="$3"
release_image="$4"
release_modeling_image="$5"
compose_project="$6"
health_url="$7"

case "$deploy_dir:$compose_project" in
  /opt/openvac:openvac-production) ;;
  /opt/openvac-staging:openvac-staging) ;;
  *)
    if [ "${OPENVAC_ACTIVATION_TEST_ROOT:-}" != "$deploy_dir" ]; then
      fail "unexpected deployment directory/project pair"
    fi
    ;;
esac

case "$release_id" in
  ""|*[!0-9a-f]*) fail "release ID must be lowercase hexadecimal" ;;
esac
[ "${#release_id}" -eq 40 ] || fail "release ID must be a 40-character commit SHA"

validate_release_image() {
  image="$1"
  label="$2"
  image_name="${image%@sha256:*}"
  image_digest="${image##*@sha256:}"
  case "$image_name" in
    ghcr.io/?*) ;;
    *) fail "$label must be an immutable GHCR digest" ;;
  esac
  case "$image_name" in
    *[!a-z0-9._/-]*|*//*|*/) fail "$label contains an invalid GHCR repository name" ;;
  esac
  case "$image_digest" in
    ""|*[!0-9a-f]*) fail "$label must contain a lowercase SHA-256 digest" ;;
  esac
  [ "${#image_digest}" -eq 64 ] ||
    fail "$label must contain a 64-character SHA-256 digest"
}

validate_release_image "$release_image" "web release image"
web_image_digest="${release_image##*@sha256:}"
if [ -n "${OPENVAC_MODELING_PRELOADED_ID:-}" ]; then
  case "$OPENVAC_MODELING_PRELOADED_ID" in
    sha256:*) modeling_image_digest="${OPENVAC_MODELING_PRELOADED_ID#sha256:}" ;;
    *) fail "preloaded modeling image ID must use sha256" ;;
  esac
  case "$modeling_image_digest" in
    ""|*[!0-9a-f]*) fail "preloaded modeling image ID must be lowercase hexadecimal" ;;
  esac
  [ "${#modeling_image_digest}" -eq 64 ] ||
    fail "preloaded modeling image ID must contain 64 hexadecimal characters"
  [ "$release_modeling_image" = "openvac-modeling-release:$modeling_image_digest" ] ||
    fail "preloaded modeling reference must be content-addressed by its image ID"
else
  validate_release_image "$release_modeling_image" "modeling release image"
  modeling_image_digest="${release_modeling_image##*@sha256:}"
fi
[ "$web_image_digest" != "$modeling_image_digest" ] ||
  fail "web and modeling release images must have distinct digests"

case "$health_url" in
  https://*|http://127.0.0.1:*) ;;
  *) fail "health URL must use HTTPS or loopback HTTP" ;;
esac

[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] ||
  fail "deployment directory must be a real directory, not a symlink"
[ -f "$deploy_dir/.env" ] && [ ! -L "$deploy_dir/.env" ] ||
  fail "host .env must be a regular file, not a symlink"
[ "$(find "$deploy_dir/.env" -prune -type f -perm 600 -print)" = "$deploy_dir/.env" ] ||
  fail "host .env must have mode 0600"
[ -d "$bundle_dir" ] && [ ! -L "$bundle_dir" ] ||
  fail "bundle directory must be a real directory, not a symlink"
[ -f "$bundle_dir/docker-compose.yml" ] && [ ! -L "$bundle_dir/docker-compose.yml" ] ||
  fail "bundle is missing a regular docker-compose.yml"
[ -f "$bundle_dir/deploy/deploy.sh" ] && [ ! -L "$bundle_dir/deploy/deploy.sh" ] ||
  fail "bundle is missing a regular deploy.sh"
[ -f "$bundle_dir/deploy/activate-bundle.sh" ] && [ ! -L "$bundle_dir/deploy/activate-bundle.sh" ] ||
  fail "bundle is missing a regular activate-bundle.sh"
[ -f "$bundle_dir/DEPLOY_BUNDLE.sha256" ] && [ ! -L "$bundle_dir/DEPLOY_BUNDLE.sha256" ] ||
  fail "bundle is missing a regular manifest"

if find "$bundle_dir" \( -name ".env" -o -name ".env.*" \) -print -quit |
  grep -q .; then
  fail "bundle must not contain environment files"
fi

if find "$bundle_dir" -type l -print -quit | grep -q .; then
  fail "bundle must not contain symbolic links"
fi

(
  cd "$bundle_dir"
  sha256sum --check DEPLOY_BUNDLE.sha256
)

releases_dir="$deploy_dir/releases"
release_dir="$releases_dir/$release_id"
if [ -e "$releases_dir" ] || [ -L "$releases_dir" ]; then
  [ -d "$releases_dir" ] && [ ! -L "$releases_dir" ] ||
    fail "releases path must be a real directory, not a symlink"
fi
install -d -m 700 "$releases_dir"

staged_dir=""
cleanup() {
  if [ -n "$staged_dir" ] && [ -d "$staged_dir" ]; then
    rm -rf -- "$staged_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -e "$release_dir" ] || [ -L "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] ||
    fail "existing release path is not an immutable directory"
  cmp -s \
    "$bundle_dir/DEPLOY_BUNDLE.sha256" \
    "$release_dir/DEPLOY_BUNDLE.sha256" ||
    fail "existing release does not match this bundle"
  (
    cd "$release_dir"
    sha256sum --check DEPLOY_BUNDLE.sha256
  )
else
  staged_dir="$releases_dir/.staging-$release_id-$$"
  install -d -m 700 "$staged_dir"
  cp -R "$bundle_dir/." "$staged_dir/"
  mv "$staged_dir" "$release_dir"
  staged_dir=""
  (
    cd "$release_dir"
    sha256sum --check DEPLOY_BUNDLE.sha256
  )
fi

if ! OPENVAC_HEALTH_URL="$health_url" \
  sh "$release_dir/deploy/deploy.sh" \
  "$deploy_dir" "$release_image" "$release_modeling_image" \
  "$compose_project"; then
  echo "deployment failed; current-release was not changed" >&2
  exit 1
fi

current_tmp="$deploy_dir/.current-release-$release_id-$$"
printf "%s\n" "$release_id" >"$current_tmp"
chmod 600 "$current_tmp"
mv -f "$current_tmp" "$deploy_dir/current-release"

trap - EXIT HUP INT TERM
echo "Activated deployment bundle $release_id"
