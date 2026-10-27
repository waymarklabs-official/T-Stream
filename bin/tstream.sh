#!/bin/bash
# T-Stream status and help.
#   tstream          status + list of commands
#   tstream update   download the newest version and reinstall (keeps videos/config)
#   tstream new-pin  new PIN for the add-videos page (logs out every phone)
ROOT=${CANVAS_ROOT:-/srv/canvas-player}

if [ "${1:-}" = new-pin ]; then
  owner=$(cat "$ROOT/.owner" 2>/dev/null || echo root)
  if [ "$(id -un)" != "$owner" ] && [ "$(id -u)" -ne 0 ]; then
    exec sudo CANVAS_ROOT="$ROOT" "$0" "$@"
  fi
  pin=$(python3 -c 'import secrets; print("%06d" % secrets.randbelow(10**6))')
  (umask 077; echo "$pin" > "$ROOT/state/add-pin.txt"; echo '{}' > "$ROOT/state/add-sessions.json")
  [ "$(id -u)" -ne 0 ] || chown "$owner": "$ROOT/state/add-pin.txt" "$ROOT/state/add-sessions.json"
  echo "New PIN for the add-videos page: $pin"
  echo "Every phone and iPhone Shortcut has to log in again (Shortcuts: make a new key on the page)."
  exit 0
fi

if [ "${1:-}" = update ]; then
  if nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx TStream-Hotspot; then
    echo "The Pi is in hotspot mode, so it has no internet to download the update."
    echo "1. hotspot-off      (then reconnect: ssh $(whoami)@$(hostname).local from your home Wi-Fi)"
    echo "2. tstream update"
    echo "3. hotspot-on       (if you want the hotspot again)"
    exit 1
  fi
  repo=$(cat "$ROOT/.repo" 2>/dev/null || true)
  if [ -z "$repo" ] || [ ! -d "$repo/.git" ]; then
    echo "Don't know where the T-Stream code is. Run: cd <your T-Stream folder> && git pull && bash install.sh"
    exit 1
  fi
  owner=$(stat -c %U "$repo")
  if [ "$(id -u)" -eq 0 ] && [ "$owner" != root ]; then
    sudo -u "$owner" git -C "$repo" pull --ff-only
  else
    git -C "$repo" pull --ff-only
  fi
  exec bash "$repo/install.sh"
fi

ok() { printf '  \033[32m%-14s\033[0m %s\n' "$1" "$2"; }
bad() { printf '  \033[31m%-14s\033[0m %s\n' "$1" "$2"; }

echo "T-Stream canvas player"
if systemctl is-active --quiet caddy; then ok "web server" "running"; else bad "web server" "NOT running (sudo systemctl restart caddy)"; fi
if nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | grep -q '^TStream-Hotspot:'; then
  ok "hotspot" "ON  -> toy uses http://10.42.0.1/"
else
  ok "hotspot" "off (start with: hotspot-on)"
fi
for ip in $(hostname -I 2>/dev/null); do
  case "$ip" in *:*) continue ;; esac
  ok "address" "http://$ip/   diagnostics: http://$ip/diag.html"
done
ok "name" "http://$(hostname).local/"
python3 - "$ROOT" <<'PYEOF'
import json, os, sys
root = sys.argv[1]
try:
    c = json.load(open(os.path.join(root, "site", "media", "catalog.json")))
    n = sum(len(x["items"]) for x in c["categories"])
    print("  \033[32m%-14s\033[0m %d videos in %d categories (updated %s)" % ("library", n, len(c["categories"]), c["generated"]))
except (OSError, ValueError, KeyError):
    print("  \033[31m%-14s\033[0m empty - put videos in %s/source and run: prep" % ("library", root))
PYEOF
if systemctl is-active --quiet canvas-prep.timer; then ok "auto-convert" "every 15 min (new files in $ROOT/source)"; fi
if systemctl is-active --quiet tstream-add.service; then
  pin=$(cat "$ROOT/state/add-pin.txt" 2>/dev/null || echo "see: sudo tstream")
  ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | grep -v '^$' | head -1)
  ok "add videos" "http://${ip:-<pi-address>}/add/   PIN $pin"
  if [ -s "$ROOT/state/add-https-url.txt" ]; then
    ok "" "$(cat "$ROOT/state/add-https-url.txt")   (phone with Tailscale on; Android: install it to share from YouTube)"
  fi
else
  bad "add videos" "NOT running (sudo systemctl restart tstream-add; log: journalctl -u tstream-add)"
fi
python3 - "$ROOT" <<'PYEOF2'
import json, os, shutil, sys
root = sys.argv[1]
try:
    free = shutil.disk_usage(os.path.join(root, "site", "media")).free
except OSError:
    sys.exit(0)
st = {}
try:
    st = json.load(open(os.path.join(root, "state", "prep-status.json")))
except (OSError, ValueError):
    pass
line = "%.1f GB free" % (free / 1e9)
if st.get("running") and st.get("current"):
    c = st["current"]
    line += "; converting %s (%d%%), %d waiting" % (c.get("path"), c.get("pct", 0), len(st.get("pending") or []))
failed = [k for k, v in (st.get("failed") or {}).items() if not v.get("retry")]
if failed:
    line += "; %d file(s) could not be converted (see prep.log)" % len(failed)
print("  \033[32m%-14s\033[0m %s" % ("space", line))
PYEOF2
if [ -r "$ROOT/remote-url.txt" ]; then
  ok "remote" "ON  -> $(cat "$ROOT/remote-url.txt")"
elif [ -e "$ROOT/remote-url.txt" ]; then
  ok "remote" "ON  (link: sudo cat $ROOT/remote-url.txt)"
else
  ok "remote" "off (watch from anywhere: remote-on)"
fi
if systemctl is-enabled --quiet tstream-wifi-fallback.service 2>/dev/null; then
  ok "safety net" "no Wi-Fi 3 min after boot -> hotspot starts (log: /var/log/tstream-hotspot.log)"
fi
if [ -f "$ROOT/prep.log" ]; then echo "  last prep:     $(tail -n 1 "$ROOT/prep.log")"; fi
cat <<EOF

Commands:
  prep            convert new videos from $ROOT/source (one folder per category)
  hotspot-on      Pi becomes a Wi-Fi network for the toy (http://10.42.0.1/)
  hotspot-off     back to normal Wi-Fi
  read-diag       show the latest report from diag.html on the toy
  tstream         this screen
  remote-on       watch from anywhere with internet (Tailscale, secret link; nothing on the toy)
  remote-off      stop remote access
  tstream new-pin new PIN for the add-videos page (logs every phone out)
  tstream update  get the newest version and reinstall (keeps videos and settings)
EOF
