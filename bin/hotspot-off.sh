#!/bin/bash
# Stop the T-Stream hotspot and put the Pi back on your home Wi-Fi.
# If no home Wi-Fi network can be joined, the hotspot comes back on, so the
# Pi never ends up unreachable.
set -euo pipefail
HERE=$(dirname "$(readlink -f "$0")")
# shellcheck source=wifi-common.sh
. "$HERE/wifi-common.sh"

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" IFACE="$IFACE" SSH_CONNECTION="${SSH_CONNECTION:-}" "$0" "$@"

if ! hotspot_active; then
  # not running (e.g. a fallback hotspot was never started): just make sure
  # it does not start at the next boot
  nmcli connection modify "$CON" connection.autoconnect no >/dev/null 2>&1 || true
  echo "The hotspot is not on. Current connection on $IFACE: $(nmcli -g GENERAL.CONNECTION device show "$IFACE" 2>/dev/null || echo none)"
  exit 0
fi

ssid=$(nmcli -g 802-11-wireless.ssid connection show "$CON" 2>/dev/null || echo "$CON")
cat <<EOF
Switching the Pi back to your home Wi-Fi.
  Reconnect from your home network:  ssh $(ssh_user)@$(hostname).local
  If no home Wi-Fi can be joined, the hotspot "$ssid" comes back on
  and the Pi stays reachable at 10.42.0.1.
EOF
if ssh_over_wifi; then
  echo "This SSH session runs over the hotspot and will disconnect now. Progress: $HOTSPOT_LOG"
  sleep 3
  detach_from_terminal "hotspot-off"
fi

nmcli connection modify "$CON" connection.autoconnect no >/dev/null 2>&1 || true
nmcli connection down "$CON" >/dev/null 2>&1 || true

if join_home_wifi; then
  echo "Hotspot is OFF. Addresses: $(hostname -I 2>/dev/null)"
  echo "Run hotspot-on to start it again."
  exit 0
fi

echo "Could not join a home Wi-Fi network. Turning the hotspot back on so the Pi stays reachable."
nmcli connection modify "$CON" connection.autoconnect yes >/dev/null 2>&1 || true
if ! hotspot_up; then
  # last resort: let NetworkManager join anything it knows when it appears
  nmcli device set "$IFACE" autoconnect yes >/dev/null 2>&1 || true
  echo "The hotspot did not come back either; the Pi will join a known Wi-Fi when one is in range."
fi
exit 1
