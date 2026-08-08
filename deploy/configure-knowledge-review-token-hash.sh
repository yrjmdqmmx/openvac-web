#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: configure-knowledge-review-token-hash.sh production|staging" >&2
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

IFS= read -r token_hash
case "$token_hash" in ""|*[!0-9a-f]*) echo "invalid token hash" >&2; exit 64 ;; esac
[ "${#token_hash}" -eq 64 ] || {
  echo "invalid token hash" >&2
  exit 64
}

[ -f "$env_file" ] && [ ! -L "$env_file" ] || {
  echo "protected environment file is missing or unsafe" >&2
  exit 1
}
mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")"
[ "$mode" = 600 ] || {
  echo "protected environment file must use mode 600" >&2
  exit 1
}

entry_count="$(grep -c '^KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=' "$env_file" || true)"
[ "$entry_count" -le 1 ] || {
  echo "duplicate knowledge review token hash entries" >&2
  exit 1
}

env_dir="$(dirname "$env_file")"
umask 077
env_tmp="$(mktemp "$env_dir/.env.knowledge-review.XXXXXX")"
cleanup() {
  rm -f -- "$env_tmp"
  unset token_hash
}
trap cleanup EXIT HUP INT TERM

replaced=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=*)
      printf 'KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=%s\n' "$token_hash"
      replaced=true
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done <"$env_file" >"$env_tmp"
if [ "$replaced" = false ]; then
  printf 'KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=%s\n' "$token_hash" >>"$env_tmp"
fi
chmod 600 "$env_tmp"
mv "$env_tmp" "$env_file"
trap - EXIT HUP INT TERM
unset token_hash
