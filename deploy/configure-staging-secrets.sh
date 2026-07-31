#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: configure-staging-secrets.sh user@host" >&2
  exit 64
fi

ssh_target="$1"
case "$ssh_target" in
  -* | *[!A-Za-z0-9@._:-]*)
    echo "invalid SSH target" >&2
    exit 64
    ;;
esac

if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
  echo "an interactive terminal is required" >&2
  exit 64
fi

echo_disabled=false
cleanup() {
  if [ "$echo_disabled" = true ]; then
    stty echo </dev/tty 2>/dev/null || true
    printf "\n" >/dev/tty
  fi
  unset deepseek_key directmail_id directmail_secret
}
trap cleanup EXIT HUP INT TERM

printf "DeepSeek API Key: " >/dev/tty
stty -echo </dev/tty
echo_disabled=true
IFS= read -r deepseek_key </dev/tty
stty echo </dev/tty
echo_disabled=false
printf "\n" >/dev/tty

printf "DirectMail AccessKey ID: " >/dev/tty
stty -echo </dev/tty
echo_disabled=true
IFS= read -r directmail_id </dev/tty
stty echo </dev/tty
echo_disabled=false
printf "\n" >/dev/tty

printf "DirectMail AccessKey Secret: " >/dev/tty
stty -echo </dev/tty
echo_disabled=true
IFS= read -r directmail_secret </dev/tty
stty echo </dev/tty
echo_disabled=false
printf "\n" >/dev/tty

for value in "$deepseek_key" "$directmail_id" "$directmail_secret"; do
  if [ -z "$value" ]; then
    echo "secret values cannot be empty" >&2
    exit 64
  fi
done

printf "%s\n%s\n%s\n" \
  "$deepseek_key" \
  "$directmail_id" \
  "$directmail_secret" |
  ssh "$ssh_target" 'set -eu
    env_file=/opt/openvac-staging/.env
    [ -f "$env_file" ]
    [ ! -L "$env_file" ]
    [ "$(stat -c "%a" "$env_file")" = 600 ]

    IFS= read -r deepseek_key
    IFS= read -r directmail_id
    IFS= read -r directmail_secret
    [ -n "$deepseek_key" ]
    [ -n "$directmail_id" ]
    [ -n "$directmail_secret" ]

    [ "$(grep -c "^DEEPSEEK_API_KEY=" "$env_file")" -eq 1 ]
    [ "$(grep -c "^ALIBABA_DIRECTMAIL_ACCESS_KEY_ID=" "$env_file")" -eq 1 ]
    [ "$(grep -c "^ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET=" "$env_file")" -eq 1 ]

    umask 077
    env_tmp=$(mktemp /opt/openvac-staging/.env.XXXXXX)
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        DEEPSEEK_API_KEY=*)
          printf "DEEPSEEK_API_KEY=%s\n" "$deepseek_key"
          ;;
        ALIBABA_DIRECTMAIL_ACCESS_KEY_ID=*)
          printf "ALIBABA_DIRECTMAIL_ACCESS_KEY_ID=%s\n" "$directmail_id"
          ;;
        ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET=*)
          printf "ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET=%s\n" "$directmail_secret"
          ;;
        *)
          printf "%s\n" "$line"
          ;;
      esac
    done <"$env_file" >"$env_tmp"
    chmod 600 "$env_tmp"
    mv "$env_tmp" "$env_file"
    unset deepseek_key directmail_id directmail_secret
    echo "OpenVac staging secrets installed."
  '
