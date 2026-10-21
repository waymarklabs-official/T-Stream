#!/bin/bash
# Watch from anywhere with internet, through Tailscale Funnel.
#
# Nothing is installed on the toy: it only needs internet (any Wi-Fi) and the
# secret link printed at the end. The Pi stays at home on your Wi-Fi.
# Bonus: the link is real https, so the toy can use its fast video decoder.
#
#   remote-on              turn on (the first time it installs Tailscale and
#                          shows a QR code to log the Pi into your account)
#   remote-on --new-link   make a new secret link; the old one stops working
#   remote-off             turn it off again
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
CONF="$ROOT/config.json"
PUBLIC_PORT=8443              # Funnel allows 443, 8443 or 10000; 443 is the Pi's own web server
LOCAL=http://127.0.0.1:8099   # Caddy's secret-link-only port (see the Caddyfile)
URL_FILE="$ROOT/remote-url.txt"

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" "$0" "$@"

if nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx TStream-Hotspot; then
  echo "The Pi is in hotspot mode, so it has no internet. Remote access needs the Pi"
  echo "on your home Wi-Fi: run hotspot-off first, then remote-on."
  exit 1
fi

read_key() {
  python3 -c 'import json, sys; print((json.load(open(sys.argv[1])).get("remote") or {}).get("key", ""))' "$CONF"
}

if [ "${1:-}" = --new-link ]; then
  python3 - "$CONF" <<'PYEOF'
import json, os, random, sys
p = sys.argv[1]
cfg = json.load(open(p))
abc = "abcdefghjkmnpqrstuvwxyz23456789"
cfg.setdefault("remote", {})["key"] = "".join(random.SystemRandom().choice(abc) for _ in range(14))
json.dump(cfg, open(p + ".tmp", "w"), indent=2)
os.replace(p + ".tmp", p)
PYEOF
  "$ROOT/bin/caddy-config.sh"
  echo "New secret link made; the old one no longer works."
fi
key=$(read_key)
case "$key" in
  ''|*[!a-z0-9]*) echo "No secret link in config.json yet. Run: tstream update"; exit 1 ;;
esac
grep -q "/k/$key/" "${CADDYFILE:-/etc/caddy/Caddyfile}" 2>/dev/null || "$ROOT/bin/caddy-config.sh"

# 1. Tailscale itself
if ! command -v tailscale >/dev/null; then
  echo "Installing Tailscale (from tailscale.com)..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

backend_state() {
  tailscale status --json 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin).get("BackendState", ""))' 2>/dev/null || true
}

# 2. Log the Pi into your Tailscale account (only the first time)
state=$(backend_state)
if [ "$state" != Running ]; then
  if [ "$state" = NeedsLogin ] || [ -z "$state" ]; then
    echo
    echo "Log this Pi into your Tailscale account (free; create one at tailscale.com if needed):"
    echo "scan the QR code below with your phone, or open the link on any device, and sign in."
    echo
  fi
  tailscale up --qr
  state=$(backend_state)
  if [ "$state" = NeedsMachineAuth ]; then
    echo "Approve this Pi in the Tailscale admin console (Machines), then run remote-on again."
    exit 1
  fi
fi

# 3. Funnel: https://<pi>.<tailnet>.ts.net:8443 -> Caddy's secret-link port
echo
echo "Turning on Tailscale Funnel. The first time, Tailscale shows a link: open it"
echo "and approve Funnel (it also turns on HTTPS certificates for your tailnet)."
tailscale funnel --bg --https="$PUBLIC_PORT" "$LOCAL"

dns=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
url="https://$dns:$PUBLIC_PORT/k/$key/"
owner=$(cat "$ROOT/.owner" 2>/dev/null || echo root)
printf '%s\n' "$url" > "$URL_FILE"
chown "$owner": "$URL_FILE" 2>/dev/null || true
chmod 0600 "$URL_FILE"

# 4. Check it from here (the first https request can take a few seconds while
#    the certificate is issued)
ok=""
for _ in 1 2 3 4 5 6; do
  if curl -fsS -m 20 -o /dev/null "${url}media/catalog.json" 2>/dev/null; then ok=1; break; fi
  sleep 5
done

cat <<EOF

Remote access is ON.
  Secret link (bookmark it in the toy's browser and add it to its allowed sites):

    $url

  Anyone who has this link can watch the library, so keep it private.
  New link: remote-on --new-link     Turn off: remote-off
  Diagnostics over this link: ${url}diag.html
EOF
[ -n "$ok" ] || echo "(The link did not answer from the Pi itself yet; give it a minute, then try it on the toy.)"
