#!/bin/sh
set -eu

fail() {
  echo "deployment host preflight failed: $*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  echo "usage: preflight-host.sh production|staging" >&2
  exit 64
fi

target="$1"
case "$target" in
  production) deploy_dir=/opt/openvac ;;
  staging) deploy_dir=/opt/openvac-staging ;;
  *)
    echo "deployment host preflight refused: target must be production or staging" >&2
    exit 64
    ;;
esac

if [ -n "${OPENVAC_DEPLOY_TEST_ROOT:-}" ]; then
  case "$OPENVAC_DEPLOY_TEST_ROOT" in
    /*) deploy_dir="$OPENVAC_DEPLOY_TEST_ROOT" ;;
    *)
      echo "deployment host preflight refused: test root must be absolute" >&2
      exit 64
      ;;
  esac
fi

[ -d "$deploy_dir" ] && [ ! -L "$deploy_dir" ] ||
  fail "deployment directory must be a real directory, not a symlink"

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
case "$cpu_count" in
  ""|*[!0-9]*) fail "could not determine the target host CPU count" ;;
esac
if [ "$cpu_count" -lt 2 ]; then
  fail "deployment requires at least 2 logical CPUs; only $cpu_count is available"
fi

meminfo_path=/proc/meminfo
if [ -n "${OPENVAC_DEPLOY_TEST_MEMINFO:-}" ]; then
  if [ "${OPENVAC_DEPLOY_TEST_ROOT:-}" != "$deploy_dir" ]; then
    echo "deployment host preflight refused: custom meminfo is test-only" >&2
    exit 64
  fi
  case "$OPENVAC_DEPLOY_TEST_MEMINFO" in
    /*) meminfo_path="$OPENVAC_DEPLOY_TEST_MEMINFO" ;;
    *)
      echo "deployment host preflight refused: custom meminfo must be absolute" >&2
      exit 64
      ;;
  esac
fi
[ -f "$meminfo_path" ] && [ ! -L "$meminfo_path" ] ||
  fail "could not read a regular target host meminfo file"
memtotal_record="$(
  awk '$1 == "MemTotal:" { print $2 " " $3 }' "$meminfo_path"
)"
case "$memtotal_record" in
  *" "kB) memtotal_kb="${memtotal_record% kB}" ;;
  *) fail "could not determine total target host memory" ;;
esac
case "$memtotal_kb" in
  ""|*[!0-9]*) fail "could not determine total target host memory" ;;
esac
minimum_memory_kb=3800000
if [ "$memtotal_kb" -lt "$minimum_memory_kb" ]; then
  fail "deployment requires a nominal 4 GB host (at least ${minimum_memory_kb} KiB visible); only ${memtotal_kb} KiB is available"
fi

minimum_available_kb=31457280
available_kb="$(LC_ALL=C df -Pk "$deploy_dir" | awk 'END { print $4 }')"
case "$available_kb" in
  ""|*[!0-9]*) fail "could not determine free disk space for $deploy_dir" ;;
esac
if [ "$available_kb" -lt "$minimum_available_kb" ]; then
  fail "deployment requires at least 30 GiB free; only ${available_kb} KiB is available"
fi

echo "Host preflight passed: ${cpu_count} CPUs, ${memtotal_kb} KiB memory, ${available_kb} KiB free"
