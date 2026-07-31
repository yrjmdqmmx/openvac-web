#!/bin/sh
set -eu

fail() {
  echo "deployment bundle activation refused: $*" >&2
  exit 64
}

if [ "$#" -ne 6 ]; then
  fail "expected DEPLOY_DIR RELEASE_ID BUNDLE_DIR IMAGE COMPOSE_PROJECT HEALTH_URL"
fi

deploy_dir="$1"
release_id="$2"
bundle_dir="$3"
release_image="$4"
compose_project="$5"
health_url="$6"

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

case "$release_image" in
  ghcr.io/*@sha256:*) ;;
  *) fail "release image must be an immutable GHCR digest" ;;
esac

case "$health_url" in
  https://*|http://127.0.0.1:*) ;;
  *) fail "health URL must use HTTPS or loopback HTTP" ;;
esac

[ -d "$deploy_dir" ] || fail "deployment directory does not exist"
[ -f "$deploy_dir/.env" ] || fail "host .env is required"
[ -d "$bundle_dir" ] || fail "bundle directory does not exist"
[ -f "$bundle_dir/docker-compose.yml" ] || fail "bundle is missing docker-compose.yml"
[ -f "$bundle_dir/deploy/deploy.sh" ] || fail "bundle is missing deploy.sh"
[ -f "$bundle_dir/deploy/activate-bundle.sh" ] || fail "bundle is missing activate-bundle.sh"
[ -f "$bundle_dir/DEPLOY_BUNDLE.sha256" ] || fail "bundle is missing its manifest"

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
fi

if ! OPENVAC_HEALTH_URL="$health_url" \
  sh "$release_dir/deploy/deploy.sh" \
  "$deploy_dir" "$release_image" "$compose_project"; then
  echo "deployment failed; current-release was not changed" >&2
  exit 1
fi

current_tmp="$deploy_dir/.current-release-$release_id-$$"
printf "%s\n" "$release_id" >"$current_tmp"
chmod 600 "$current_tmp"
mv -f "$current_tmp" "$deploy_dir/current-release"

trap - EXIT HUP INT TERM
echo "Activated deployment bundle $release_id"
