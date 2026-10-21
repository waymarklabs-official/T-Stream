#!/bin/bash
# T-Stream installer for Raspberry Pi OS (Bookworm or Bullseye).
#
#     bash install.sh
#
# Safe to run again at any time (after `git pull`, to update): it keeps your
# videos, library and config.json, and only replaces the program files.
#
# Installs: Caddy (web server, http :80 + https :443), FFmpeg, Python PyAV.
# Creates:  /srv/canvas-player/{source,site,bin,config.json}
# Commands: prep, hotspot-on, hotspot-off, read-diag, tstream
# Leaves Kodi and everything else alone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/srv/canvas-player
LOG=/var/log/caddy/canvas-player.log
CA_SRC=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

OWNER=${SUDO_USER:-}
if [ -z "$OWNER" ] || [ "$OWNER" = root ]; then
  OWNER=$(getent passwd 1000 | cut -d: -f1 || true)
fi
OWNER=${OWNER:-root}

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m!!  %s\033[0m\n' "$*"; }

# ------------------------------------------------------------- packages ---
step "Installing packages (this can take a few minutes the first time)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q || warn "apt-get update had problems; continuing with what is cached"
apt-get install -y -q --no-install-recommends ffmpeg python3 ca-certificates curl rsync iproute2 gnupg

if ! python3 -c 'import av' 2>/dev/null; then
  apt-get install -y -q python3-av || true
fi
if ! python3 -c 'import av' 2>/dev/null; then
  echo "python3-av not available from apt; building PyAV with pip (slow)..."
  apt-get install -y -q python3-pip python3-dev pkg-config \
    libavformat-dev libavcodec-dev libavdevice-dev libavutil-dev libswscale-dev libswresample-dev libavfilter-dev
  pip3 install --break-system-packages av 2>/dev/null || pip3 install av
fi
python3 -c 'import av' || { warn "PyAV could not be installed"; exit 1; }

if ! command -v caddy >/dev/null; then
  if [ -n "$(apt-cache policy caddy 2>/dev/null | sed -n 's/ *Candidate: //p' | grep -v none)" ]; then
    apt-get install -y -q caddy
  else
    echo "Caddy is not in this OS's package list; adding Caddy's official repository..."
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
fi
echo "ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3), PyAV $(python3 -c 'import av; print(av.__version__)'), $(caddy version | cut -d' ' -f1)"

# ---------------------------------------------------------------- files ---
step "Installing T-Stream into $ROOT"
mkdir -p "$ROOT/source" "$ROOT/site/media" "$ROOT/bin" "$ROOT/diag-reports"
rsync -a --delete --exclude /media/ --exclude /ca.crt --exclude /diag/last-report.json "$REPO/site/" "$ROOT/site/"
install -m 0644 "$REPO/prep/prep.py" "$REPO/prep/cvs.py" "$ROOT/bin/"
for s in prep hotspot-on hotspot-off read-diag tstream remote-on remote-off; do
  install -m 0755 "$REPO/bin/$s.sh" "$ROOT/bin/$s.sh"
  ln -sf "$ROOT/bin/$s.sh" "/usr/local/bin/$s"
done
install -m 0644 "$REPO/bin/wifi-common.sh" "$ROOT/bin/wifi-common.sh"
install -m 0755 "$REPO/bin/caddy-config.sh" "$ROOT/bin/caddy-config.sh"
install -m 0644 "$REPO/server/Caddyfile.template" "$ROOT/bin/Caddyfile.template"
touch /var/log/tstream-hotspot.log

if [ ! -f "$ROOT/config.json" ]; then
  cp "$REPO/config.json" "$ROOT/config.json"
fi
# Random, easy-to-type secrets: the hotspot password (replacing the
# placeholder) and the secret part of the remote link (remote-on).
python3 - "$ROOT/config.json" <<'PYEOF'
import json, random, re, sys
p = sys.argv[1]
cfg = json.load(open(p))
abc = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alikes (l/1, o/0, i)
rnd = random.SystemRandom()
changed = False
hs = cfg.setdefault("hotspot", {})
pw = hs.get("password", "change-me-please")
# placeholder, or the weak 4-digit style of earlier versions
if pw == "change-me-please" or re.match(r"^play-\d{4}-tv$", pw):
    hs["password"] = "-".join("".join(rnd.choice(abc) for _ in range(4)) for _ in range(3))  # ~59 bits
    changed = True
rm = cfg.setdefault("remote", {})
if not re.match(r"^[a-z0-9]{12,}$", str(rm.get("key", ""))):
    rm["key"] = "".join(rnd.choice(abc) for _ in range(14))  # ~69 bits
    changed = True
if changed:
    json.dump(cfg, open(p, "w"), indent=2)
PYEOF

echo "$OWNER" > "$ROOT/.owner"
echo "$REPO" > "$ROOT/.repo"   # for `tstream update`
chmod 755 /srv "$ROOT" "$ROOT/bin" "$ROOT/site"
chown -R "$OWNER": "$ROOT/source" "$ROOT/site/media" "$ROOT/diag-reports" "$ROOT/config.json"
touch "$ROOT/prep.log" && chown "$OWNER": "$ROOT/prep.log"
mkdir -p "$ROOT/site/diag" && touch "$ROOT/site/diag/last-report.json"
# Rebuild the catalog so the player settings from config.json take effect.
sudo -u "$OWNER" python3 "$ROOT/bin/prep.py" --root "$ROOT" --catalog-only --no-wait || true

# ---------------------------------------------------------- web server ---
step "Configuring the Caddy web server"
for port in 80 443; do
  other=$(ss -Hltnp "sport = :$port" 2>/dev/null | grep -v caddy || true)
  if [ -n "$other" ]; then
    warn "Port $port is already used by another program:"
    echo "$other"
    warn "Caddy cannot start until that program stops using port $port (Kodi's web interface uses 8080, which is fine)."
  fi
done
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true
systemctl enable caddy >/dev/null 2>&1 || true
CANVAS_ROOT="$ROOT" CANVAS_LOG="$LOG" "$ROOT/bin/caddy-config.sh" || { warn "Could not configure Caddy"; exit 1; }

# Ask for one https page so Caddy creates its local certificate authority,
# then publish the (public) root certificate for the toy at /ca.crt.
for _ in $(seq 1 20); do
  curl -sk --noproxy '*' -o /dev/null https://127.0.0.1/ 2>/dev/null || true
  [ -f "$CA_SRC" ] && break
  sleep 1
done
if [ -f "$CA_SRC" ]; then
  install -m 0644 "$CA_SRC" "$ROOT/site/ca.crt"
else
  warn "Caddy's local certificate was not created yet; https may not work. Re-run install.sh later."
fi

# ---------------------------------------------------- auto-convert timer ---
step "Auto-convert: new videos in $ROOT/source are converted every 15 minutes"
cat > /etc/systemd/system/canvas-prep.service <<EOF
[Unit]
Description=T-Stream: convert new videos in $ROOT/source
ConditionPathIsDirectory=$ROOT/source

[Service]
Type=oneshot
User=$OWNER
Nice=19
IOSchedulingClass=idle
Environment=CANVAS_ROOT=$ROOT
ExecStart=$ROOT/bin/prep.sh
EOF
cat > /etc/systemd/system/canvas-prep.timer <<EOF
[Unit]
Description=T-Stream: look for new videos every 15 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now canvas-prep.timer >/dev/null 2>&1 || warn "could not enable the auto-convert timer"

# -------------------------------------------------------- Wi-Fi safety net ---
if command -v nmcli >/dev/null; then
  step "Wi-Fi safety net: if the Pi joins no Wi-Fi within 3 minutes of booting, it starts its hotspot"
  # Saved hotspot settings (not started), so the safety net never depends on config.json.
  "$ROOT/bin/hotspot-on.sh" --prepare || warn "could not prepare the hotspot settings"
  cat > /etc/systemd/system/tstream-wifi-fallback.service <<UNIT
[Unit]
Description=T-Stream: start the hotspot if no Wi-Fi is joined after boot
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
# simple, not oneshot: it waits in the background and never delays booting
Type=simple
Environment=CANVAS_ROOT=$ROOT
ExecStart=$ROOT/bin/hotspot-on.sh --if-offline

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable tstream-wifi-fallback.service >/dev/null 2>&1 || warn "could not enable the Wi-Fi safety net"
else
  warn "NetworkManager is not installed: the hotspot commands will not work on this system."
fi

# ----------------------------------------------------------------- done ---
step "Done"
ip4=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | grep -v '^$' | head -1 || true)
ssid=$(python3 -c "import json;print(json.load(open('$ROOT/config.json'))['hotspot']['ssid'])")
pass=$(python3 -c "import json;print(json.load(open('$ROOT/config.json'))['hotspot']['password'])")
cat <<EOF
Player:       http://${ip4:-<pi-address>}/      (and http://$(hostname).local/)
Diagnostics:  http://${ip4:-<pi-address>}/diag.html   <- open this on the toy first (Phase 0)
Videos go in: $ROOT/source/<Category>/    then run: prep   (or wait for auto-convert)
Hotspot:      hotspot-on   -> Wi-Fi "$ssid", password "$pass", player at http://10.42.0.1/
Status/help:  tstream
EOF
