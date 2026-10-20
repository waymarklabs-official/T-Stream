#!/bin/bash
# Turn the Pi into a Wi-Fi hotspot for the toy (no internet needed).
# The Pi is then always at http://10.42.0.1/ . It stays on, also after a
# reboot, until you run hotspot-off.
#
#   hotspot-on                      use the name/password from config.json
#   hotspot-on MyName MyPassword    use (and remember) a new name/password
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
CONF="$ROOT/config.json"
CON=TStream-Hotspot
IFACE=${IFACE:-wlan0}

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" IFACE="$IFACE" "$0" "$@"

if ! command -v nmcli >/dev/null; then
  echo "NetworkManager (nmcli) is not installed. Raspberry Pi OS Bookworm has it by default;"
  echo "on older Pi OS enable it with: sudo raspi-config  ->  Advanced  ->  Network Config  ->  NetworkManager"
  exit 1
fi

# Read (and optionally update) the hotspot settings in config.json.
eval "$(python3 - "$CONF" "${1:-}" "${2:-}" <<'PYEOF'
import json, shlex, sys
path, ssid, pw = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(path))
except (OSError, ValueError):
    cfg = {}
hs = cfg.setdefault("hotspot", {})
if ssid:
    hs["ssid"] = ssid
if pw:
    hs["password"] = pw
if ssid or pw:
    json.dump(cfg, open(path, "w"), indent=2)
print("SSID=%s" % shlex.quote(hs.get("ssid", "CanvasPlayer")))
print("PASS=%s" % shlex.quote(hs.get("password", "")))
print("COUNTRY=%s" % shlex.quote(hs.get("country", "US")))
PYEOF
)"

if [ ${#PASS} -lt 8 ] || [ ${#PASS} -gt 63 ]; then
  echo "The hotspot password must be 8 to 63 characters. Run: hotspot-on \"$SSID\" <new-password>"
  exit 1
fi

# Warn if this very session would be cut off.
if [ -n "${SSH_CONNECTION:-}" ]; then
  client=${SSH_CONNECTION%% *}
  dev=$(ip route get "$client" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
  if [ "$dev" = "$IFACE" ]; then
    echo "WARNING: you are connected over $IFACE. Starting the hotspot will disconnect this SSH session."
    echo "Reconnect afterwards by joining the '$SSID' Wi-Fi and running: ssh $(logname 2>/dev/null || echo pi)@10.42.0.1"
    echo "Starting in 10 seconds (Ctrl-C to cancel)..."
    sleep 10
  fi
fi

rfkill unblock wifi 2>/dev/null || true
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true
elif command -v iw >/dev/null; then
  iw reg set "$COUNTRY" 2>/dev/null || true
fi

nmcli connection delete "$CON" >/dev/null 2>&1 || true
nmcli connection add type wifi ifname "$IFACE" con-name "$CON" ssid "$SSID" \
  connection.autoconnect yes connection.autoconnect-priority 100 \
  802-11-wireless.mode ap 802-11-wireless.band bg \
  ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method ignore \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
  wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.pmf disable >/dev/null
nmcli connection up "$CON" >/dev/null

echo
echo "Hotspot is ON."
echo "  Wi-Fi name: $SSID"
echo "  Password:   $PASS"
echo "  On the toy: join that Wi-Fi, then open http://10.42.0.1/"
echo "  (diagnostics: http://10.42.0.1/diag.html)"
echo "It stays on after reboots. To go back to your home Wi-Fi: hotspot-off"
