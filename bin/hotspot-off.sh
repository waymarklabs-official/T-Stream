#!/bin/bash
# Stop the T-Stream hotspot and let the Pi rejoin its normal Wi-Fi.
set -euo pipefail
CON=TStream-Hotspot
IFACE=${IFACE:-wlan0}
[ "$(id -u)" -eq 0 ] || exec sudo IFACE="$IFACE" "$0" "$@"

nmcli connection modify "$CON" connection.autoconnect no >/dev/null 2>&1 || true
nmcli connection down "$CON" >/dev/null 2>&1 || true

# Bring back a saved home Wi-Fi network explicitly, newest first. (Letting
# NetworkManager choose with `nmcli device connect` picks the hotspot again,
# because it was the most recently used profile.)
hotspot_uuid=$(nmcli -g connection.uuid connection show "$CON" 2>/dev/null || true)
nmcli device wifi rescan ifname "$IFACE" >/dev/null 2>&1 || true
sleep 3
joined=""
while IFS=: read -r _ uuid type; do
  [ "$type" = 802-11-wireless ] && [ "$uuid" != "$hotspot_uuid" ] || continue
  if nmcli --wait 20 connection up uuid "$uuid" ifname "$IFACE" >/dev/null 2>&1; then
    joined=$uuid
    break
  fi
done < <(nmcli -t -f TIMESTAMP,UUID,TYPE connection show | sort -t: -k1,1 -rn)
if [ -z "$joined" ]; then
  # none in range right now: let NetworkManager join one when it appears
  nmcli device set "$IFACE" autoconnect yes >/dev/null 2>&1 || true
fi

echo "Hotspot is OFF. Current connection on $IFACE:"
nmcli -g GENERAL.CONNECTION device show "$IFACE" 2>/dev/null || true
echo "Run hotspot-on to start it again."
