#!/bin/bash
# Writes /etc/caddy/Caddyfile from the T-Stream template (paths and the secret
# remote link filled in), checks it with Caddy, then reloads Caddy. The old
# file stays in place if the new one is not valid.
#
#   caddy-config.sh [TEMPLATE]     (run by install.sh and remote-on)
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
LOG=${CANVAS_LOG:-/var/log/caddy/canvas-player.log}
TEMPLATE=${1:-$ROOT/bin/Caddyfile.template}
OUT=${CADDYFILE:-/etc/caddy/Caddyfile}

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" CANVAS_LOG="$LOG" CADDYFILE="$OUT" "$0" "$@"

key=$(python3 -c 'import json, sys; print((json.load(open(sys.argv[1])).get("remote") or {}).get("key", ""))' \
  "$ROOT/config.json")
case "$key" in
  ''|*[!a-z0-9]*) echo "config.json has no valid remote key (run install.sh)"; exit 1 ;;
esac

new="$OUT.new"
sed -e "s#@ROOT@#$ROOT#g" -e "s#@LOG@#$LOG#g" -e "s#@REMOTE_KEY@#$key#g" "$TEMPLATE" > "$new"
if ! out=$(caddy validate --config "$new" --adapter caddyfile 2>&1); then
  echo "$out" | tail -5
  echo "The new web server configuration is not valid; keeping the old one."
  rm -f "$new"
  exit 1
fi
if [ -f "$OUT" ] && ! grep -q "T-Stream" "$OUT"; then
  cp "$OUT" "$OUT.before-tstream.$(date +%Y%m%d%H%M%S)"
  echo "Saved your previous Caddyfile next to it."
fi
mv "$new" "$OUT"
chmod 0644 "$OUT"
systemctl reload-or-restart caddy
