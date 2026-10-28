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
#
# It also puts the add-videos page on https://<pi>.<tailnet>.ts.net/add/ for
# your own Tailscale devices only (never the internet): Android needs https to
# list "Add videos" in YouTube's Share menu. (remote-on --add-page does only
# that part; install.sh runs it when Tailscale is up.)
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
CONF="$ROOT/config.json"
PUBLIC_PORT=8443              # Funnel allows 443, 8443 or 10000; 443 is the Pi's own web server
LOCAL=http://127.0.0.1:8099   # Caddy's secret-link-only port (see the Caddyfile)
URL_FILE="$ROOT/remote-url.txt"

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" "$0" "$@"

# https://<pi>.<tailnet>.ts.net/ -> Caddy's plain-http site, for tailnet
# devices only (tailscale serve, not funnel; the toy's Funnel stays on 8443).
add_page_https() {
  local dns conflict
  dns=$(tailscale status --json 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null) || return 1
  [ -n "$dns" ] || return 1
  conflict=$(tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
try:
    cfg = json.load(sys.stdin) or {}
except ValueError:
    cfg = {}
for hp, web in (cfg.get("Web") or {}).items():
    if hp.endswith(":443"):
        for path, h in (web.get("Handlers") or {}).items():
            if h.get("Proxy") != "http://127.0.0.1:80":
                print(path)
' 2>/dev/null || true)
  if [ -n "$conflict" ]; then
    echo "(Tailscale already serves something else on https port 443; the add-videos page stays on http.)"
    return 1
  fi
  local owner url_file="$ROOT/state/add-https-url.txt"
  owner=$(cat "$ROOT/.owner" 2>/dev/null || echo root)
  # 0 can also mean "HTTPS is not on for your tailnet" (it prints a link to
  # turn it on), so check that the setting is really there
  out=$(timeout 30 tailscale serve --bg --https=443 http://127.0.0.1:80 2>&1) || true
  if ! tailscale serve status --json 2>/dev/null | python3 -c '
import json, sys
cfg = json.load(sys.stdin) or {}
h = ((cfg.get("Web") or {}).get(sys.argv[1] + ":443") or {}).get("Handlers") or {}
sys.exit(0 if (h.get("/") or {}).get("Proxy") == "http://127.0.0.1:80" else 1)
' "$dns" 2>/dev/null; then
    runuser -u "$owner" -- rm -f "$url_file"
    [ -z "$out" ] || echo "$out" | grep -i "https\|enable\|visit" | head -3
    return 1
  fi
  # written as the owner (state/ is the owner's folder)
  runuser -u "$owner" -- sh -c 'printf "https://%s/add/\n" "$1" > "$2"' sh "$dns" "$url_file"
}

if [ "${1:-}" = --add-page ]; then
  if add_page_https; then
    echo "Add videos over Tailscale: $(cat "$ROOT/state/add-https-url.txt")"
  else
    echo "(The https add-videos address is not set up: Tailscale is not ready, or HTTPS is off for your tailnet. remote-on sets it up.)"
  fi
  exit 0
fi

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
if add_page_https; then
  echo "  Add videos from your phone (with Tailscale on): $(cat "$ROOT/state/add-https-url.txt")"
fi
[ -n "$ok" ] || echo "(The link did not answer from the Pi itself yet; give it a minute, then try it on the toy.)"
