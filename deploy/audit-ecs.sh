#!/bin/sh
set -eu

echo "OpenVac ECS read-only preflight"
echo
uname -a
echo
getconf _NPROCESSORS_ONLN
echo
awk '/MemTotal|MemAvailable/ { print }' /proc/meminfo
echo
df -h /
echo
docker version --format 'Docker client={{.Client.Version}} server={{.Server.Version}}'
echo
docker compose version
echo
ss -lntp
echo
if command -v nginx >/dev/null 2>&1; then
  nginx -T 2>&1 | sed -n '1,240p'
else
  echo "nginx not installed"
fi

echo
echo "Minimum free target: 2 vCPU, 4 GB available memory budget, 30 GB disk."
echo "This script makes no changes."
