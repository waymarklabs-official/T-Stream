#!/bin/bash
# Turn remote access (Tailscale Funnel) off. The toy can still play at home
# on the same Wi-Fi, or through the Pi's hotspot. remote-on turns it back on
# with the same secret link.
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
PUBLIC_PORT=8443
[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" "$0" "$@"

if ! command -v tailscale >/dev/null; then
  echo "Tailscale is not installed, so remote access is already off."
  exit 0
fi
tailscale funnel --https="$PUBLIC_PORT" off >/dev/null 2>&1 || true
rm -f "$ROOT/remote-url.txt"
echo "Remote access is OFF. (Tailscale itself stays installed; remote-on turns it back on.)"
