#!/bin/bash
# Turn the Pi into a Wi-Fi hotspot for the toy (no internet needed).
# The Pi is then always at http://10.42.0.1/ (ssh <user>@10.42.0.1). It stays
# on, also after a reboot, until you run hotspot-off.
#
#   hotspot-on                      use the name/password from config.json
#   hotspot-on MyName MyPassword    use (and remember) a new name/password
#   hotspot-on --if-offline         (used at boot) start the hotspot only if the
#                                   Pi has not joined any Wi-Fi within 3 minutes
#
# If the hotspot cannot start, the Pi goes back to your home Wi-Fi by itself.
set -euo pipefail
HERE=$(dirname "$(readlink -f "$0")")
# shellcheck source=wifi-common.sh
. "$HERE/wifi-common.sh"
CONF="$ROOT/config.json"

# SSH_CONNECTION is passed on so we know whether this session is about to drop.
[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" IFACE="$IFACE" SSH_CONNECTION="${SSH_CONNECTION:-}" "$0" "$@"

if ! command -v nmcli >/dev/null; then
  echo "NetworkManager (nmcli) is not installed. Raspberry Pi OS Bookworm has it by default;"
  echo "on older Pi OS enable it with: sudo raspi-config  ->  Advanced  ->  Network Config  ->  NetworkManager"
  exit 1
fi

MODE=normal
if [ "${1:-}" = --if-offline ]; then
  MODE=fallback
  shift
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

make_profile() {  # (re)create the hotspot profile; it only autostarts once it has worked
  nmcli connection delete "$CON" >/dev/null 2>&1 || true
  nmcli connection add type wifi ifname "$IFACE" con-name "$CON" ssid "$SSID" \
    connection.autoconnect no connection.autoconnect-priority 100 \
    802-11-wireless.mode ap 802-11-wireless.band bg \
    ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method ignore \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
    wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.pmf disable >/dev/null
}

prepare_radio() {
  rfkill unblock wifi 2>/dev/null || true
  if command -v raspi-config >/dev/null; then
    raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true
  elif command -v iw >/dev/null; then
    iw reg set "$COUNTRY" 2>/dev/null || true
  fi
}

# --- boot fallback: no Wi-Fi joined after 3 minutes -> temporary hotspot ---
if [ "$MODE" = fallback ]; then
  for _ in $(seq 1 "${OFFLINE_CHECKS:-18}"); do
    if wifi_connected; then exit 0; fi
    sleep "${OFFLINE_INTERVAL:-10}"
  done
  echo "No Wi-Fi joined after boot: starting the hotspot \"$SSID\" until the next reboot."
  prepare_radio
  # keep an existing profile (and its autostart setting) if there is one
  nmcli -g connection.id connection show "$CON" >/dev/null 2>&1 || make_profile
  hotspot_up || { echo "The fallback hotspot did not start either."; exit 1; }
  exit 0
fi

# --- normal: switch to hotspot mode ---
cat <<EOF
Starting the hotspot:
  Wi-Fi name: $SSID
  Password:   $PASS
  Toy, phone or laptop: join that Wi-Fi, then open http://10.42.0.1/
  SSH to the Pi there:  ssh $(ssh_user)@10.42.0.1
If it cannot start, the Pi goes back to your home Wi-Fi by itself.
EOF
if ssh_over_wifi; then
  echo
  echo "This SSH session runs over $IFACE and will disconnect now. Write the details above down."
  echo "Starting in 10 seconds (Ctrl-C to cancel). Progress: $HOTSPOT_LOG"
  sleep 10
  detach_from_terminal "hotspot-on"
fi

prepare_radio
make_profile
if hotspot_up; then
  nmcli connection modify "$CON" connection.autoconnect yes >/dev/null
  echo
  echo "Hotspot is ON (\"$SSID\", http://10.42.0.1/). It stays on after reboots."
  echo "To go back to your home Wi-Fi: hotspot-off"
  exit 0
fi

echo "The hotspot did not start on $IFACE. Going back to your home Wi-Fi."
nmcli connection delete "$CON" >/dev/null 2>&1 || true
if ! join_home_wifi; then
  nmcli device set "$IFACE" autoconnect yes >/dev/null 2>&1 || true
  echo "No home Wi-Fi in range right now; the Pi will join one as soon as it can."
fi
exit 1
