#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
# Runbuoy's publisher already holds this same lock. Independent callers acquire it.
if [[ ${ACORNARY_INGRESS_LOCK_HELD:-0} != 1 ]]; then
  exec 9>/run/lock/runbuoy-deploy.lock
  flock -w 60 9
fi
readonly live=/etc/acornary/ingress
mode=${1:?Usage: ingress check|prepare|reload|route [Runbuoy Caddyfile or environment]}
if [[ $mode == route ]]; then
  environment=${2:?Choose preacceptance or production}
  [[ $environment == preacceptance || $environment == production ]] || exit 2
  site="$live/acornary.caddy"
  [[ $(grep -Ec 'reverse_proxy acornary-(preacceptance|production)-app:3210' "$site") == 1 ]] || exit 3
  cp "$site" "$site.previous"
  sed -E "s/acornary-(preacceptance|production)-app:3210/acornary-$environment-app:3210/" "$site" > "$site.next"
  mv "$site.next" "$site"
  if ! docker exec runbuoy-caddy-1 caddy validate --config "$live/Caddyfile" --adapter caddyfile ||
     ! docker exec runbuoy-caddy-1 caddy reload --config "$live/Caddyfile" --adapter caddyfile; then
    cp "$site.previous" "$site"
    docker exec runbuoy-caddy-1 caddy reload --config "$live/Caddyfile" --adapter caddyfile
    exit 1
  fi
  exit
fi
if [[ $mode == reload ]]; then
  docker exec runbuoy-caddy-1 caddy validate --config "$live/Caddyfile" --adapter caddyfile
  docker exec runbuoy-caddy-1 caddy reload --config "$live/Caddyfile" --adapter caddyfile
  exit
fi
[[ $mode == check || $mode == prepare ]] || exit 2
source_file=${2:?Runbuoy Caddyfile required}
[[ -f $source_file && -f $live/acornary.caddy ]] || exit 3
candidate=$(mktemp -d /etc/acornary/ingress-candidate.XXXXXX)
trap 'rm -rf "$candidate"' EXIT
cp "$source_file" "$candidate/runbuoy.caddy"
cp "$live/acornary.caddy" "$candidate/acornary.caddy"
printf 'import /etc/acornary/ingress/runbuoy.caddy\nimport /etc/acornary/ingress/acornary.caddy\n' > "$candidate/Caddyfile"
docker run --rm --env-file /etc/runbuoy/runbuoy.env \
  -v "$candidate:$live:ro" caddy:2-alpine caddy validate --config "$live/Caddyfile" --adapter caddyfile
if [[ $mode == prepare ]]; then
  [[ ! -f $live/runbuoy.caddy ]] || cp "$live/runbuoy.caddy" "$live/runbuoy.caddy.previous"
  cp "$candidate/runbuoy.caddy" "$live/runbuoy.caddy.next"
  mv "$live/runbuoy.caddy.next" "$live/runbuoy.caddy"
  cp "$candidate/Caddyfile" "$live/Caddyfile.next"
  mv "$live/Caddyfile.next" "$live/Caddyfile"
fi
