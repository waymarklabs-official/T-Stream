#!/bin/bash
# T-Stream status and help.
#   tstream          status + list of commands
#   tstream update   download the newest version and reinstall (keeps videos/config)
ROOT=${CANVAS_ROOT:-/srv/canvas-player}

if [ "${1:-}" = update ]; then
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
if [ -f "$ROOT/prep.log" ]; then echo "  last prep:     $(tail -n 1 "$ROOT/prep.log")"; fi
cat <<EOF

Commands:
  prep            convert new videos from $ROOT/source (one folder per category)
  hotspot-on      Pi becomes a Wi-Fi network for the toy (http://10.42.0.1/)
  hotspot-off     back to normal Wi-Fi
  read-diag       show the latest report from diag.html on the toy
  tstream         this screen
  tstream update  get the newest version and reinstall (keeps videos and settings)
EOF
