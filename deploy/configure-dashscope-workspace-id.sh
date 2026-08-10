#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: configure-dashscope-workspace-id.sh production|staging" >&2
  exit 64
fi

config_root="${OPENVAC_CONFIG_ROOT:-/opt}"
case "$config_root" in
  /*) ;;
  *) echo "OPENVAC_CONFIG_ROOT must be absolute" >&2; exit 64 ;;
esac
case "$config_root" in /|"") echo "unsafe configuration root" >&2; exit 64 ;; esac

case "$1" in
  production) env_file="$config_root/openvac/.env" ;;
  staging) env_file="$config_root/openvac-staging/.env" ;;
  *) echo "target must be production or staging" >&2; exit 64 ;;
esac

IFS= read -r workspace_id
case "$workspace_id" in
  ""|*[!A-Za-z0-9_-]*) echo "invalid workspace identifier" >&2; exit 64 ;;
esac
[ "${#workspace_id}" -le 128 ] || {
  echo "invalid workspace identifier" >&2
  exit 64
}

[ -f "$env_file" ] && [ ! -L "$env_file" ] || {
  echo "protected environment file is missing or unsafe" >&2
  exit 1
}
mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")"
[ "$mode" = 600 ] || {
  echo "protected environment file must use mode 600" >&2
  exit 1
}

entry_count="$(grep -c '^DASHSCOPE_WORKSPACE_ID=' "$env_file" || true)"
[ "$entry_count" -le 1 ] || {
  echo "duplicate DashScope workspace entries" >&2
  exit 1
}

env_dir="$(dirname "$env_file")"
umask 077
env_tmp="$(mktemp "$env_dir/.env.dashscope-workspace.XXXXXX")"
cleanup() {
  rm -f -- "$env_tmp"
  unset workspace_id
}
trap cleanup EXIT HUP INT TERM

replaced=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    DASHSCOPE_WORKSPACE_ID=*)
      printf 'DASHSCOPE_WORKSPACE_ID=%s\n' "$workspace_id"
      replaced=true
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$env_file" >"$env_tmp"
if [ "$replaced" = false ]; then
  printf 'DASHSCOPE_WORKSPACE_ID=%s\n' "$workspace_id" >>"$env_tmp"
fi
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"
trap - EXIT HUP INT TERM
unset workspace_id
