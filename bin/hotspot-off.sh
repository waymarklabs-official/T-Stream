#!/bin/bash
# Stop the T-Stream hotspot and let the Pi rejoin its normal Wi-Fi.
set -euo pipefail
CON=TStream-Hotspot
IFACE=${IFACE:-wlan0}
[ "$(id -u)" -eq 0 ] || exec sudo IFACE="$IFACE" "$0" "$@"

nmcli connection modify "$CON" connection.autoconnect no >/dev/null 2>&1 || true
nmcli connection down "$CON" >/dev/null 2>&1 || true
# reconnect to whichever saved Wi-Fi network is in range
nmcli device connect "$IFACE" >/dev/null 2>&1 || true
echo "Hotspot is OFF. Current connection on $IFACE:"
nmcli -t -f GENERAL.CONNECTION device show "$IFACE" 2>/dev/null | cut -d: -f2 || true
echo "Run hotspot-on to start it again."
