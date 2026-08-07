#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

fail() {
  echo "ossutil bootstrap refused: $*" >&2
  exit 64
}

if [[ "$#" -ne 1 ]]; then
  fail "usage: install-pinned-ossutil.sh production|staging"
fi
target="$1"
case "$target" in production | staging) ;; *) fail "target must be production or staging" ;; esac
[[ "$(id -u)" -eq 0 ]] || fail "ossutil bootstrap must run as root"

version=2.3.0
if command -v ossutil >/dev/null 2>&1; then
  installed_version="$(ossutil version 2>&1)"
  [[ "$installed_version" == *"$version"* ]] ||
    fail "an unapproved ossutil version is already installed"
  printf '{"schema":"openvac-ossutil-bootstrap-v1","target":"%s","version":"%s","status":"already-present"}\n' \
    "$target" "$version"
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64)
    package_arch=amd64
    expected_sha256=3ae4d9fc85a7a6e9f5654d1599766f1a3a42a3692870887b5ae9338d582ef65a
    ;;
  aarch64 | arm64)
    package_arch=arm64
    expected_sha256=f6c95ba0c2d2ef30290af686ce4d706c701f4734ce8090bee4288a77e3f1d764
    ;;
  *) fail "unsupported Linux architecture" ;;
esac

for command_name in curl sha256sum python3 install uname; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required bootstrap command is unavailable: $command_name"
done

temporary_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

package_name="ossutil-$version-linux-$package_arch.zip"
archive="$temporary_dir/$package_name"
checksum_file="$temporary_dir/$package_name.sha256"
extract_dir="$temporary_dir/extracted"
download_url="https://gosspublic.alicdn.com/ossutil/v2/$version/$package_name"

curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  --output "$archive" "$download_url"
printf '%s  %s\n' "$expected_sha256" "$package_name" >"$checksum_file"
(
  cd "$temporary_dir"
  sha256sum --check "$checksum_file"
)

install -d -m 0700 "$extract_dir"
python3 -m zipfile -e "$archive" "$extract_dir"
binary="$extract_dir/ossutil-$version-linux-$package_arch/ossutil"
[[ -f "$binary" && ! -L "$binary" ]] || fail "verified archive has an unexpected layout"
"$binary" version 2>&1 | grep -F "$version" >/dev/null ||
  fail "verified binary did not report the pinned version"

install -m 0755 -- "$binary" /usr/local/bin/ossutil
[[ -f /usr/local/bin/ossutil && ! -L /usr/local/bin/ossutil ]] ||
  fail "installed ossutil path is not a regular file"
[[ "$(stat -c '%a' /usr/local/bin/ossutil)" == 755 ]] ||
  fail "installed ossutil mode is not 0755"
/usr/local/bin/ossutil version 2>&1 | grep -F "$version" >/dev/null ||
  fail "installed ossutil version verification failed"

printf '{"schema":"openvac-ossutil-bootstrap-v1","target":"%s","version":"%s","status":"installed"}\n' \
  "$target" "$version"
trap - EXIT HUP INT TERM
cleanup
