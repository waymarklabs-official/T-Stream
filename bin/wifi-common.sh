# shellcheck shell=bash
# Shared by hotspot-on and hotspot-off (sourced, not run).
#
# The Pi may have only Wi-Fi, so every change of Wi-Fi mode can cut the SSH
# session that started it. These helpers make sure the change always
# finishes, and always ends on a network you can reach.

CON=TStream-Hotspot
IFACE=${IFACE:-wlan0}
HOTSPOT_LOG=${HOTSPOT_LOG:-/var/log/tstream-hotspot.log}
ROOT=${CANVAS_ROOT:-/srv/canvas-player}

# The login name to suggest for ssh.
ssh_user() {
  echo "${SUDO_USER:-$(cat "$ROOT/.owner" 2>/dev/null || echo pi)}"
}

# True if this SSH session runs over $IFACE (it drops when the Wi-Fi mode changes).
ssh_over_wifi() {
  [ -n "${SSH_CONNECTION:-}" ] || return 1
  local client dev
  client=${SSH_CONNECTION%% *}
  dev=$(ip route get "$client" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
  [ "$dev" = "$IFACE" ]
}

# The terminal is about to go away: ignore the hang-up and log to a file, so
# the switch (and its fallback) still completes.
detach_from_terminal() {
  trap '' HUP
  exec </dev/null >>"$HOTSPOT_LOG" 2>&1
  echo "--- $(date '+%F %T') $*"
}

wifi_connected() {
  nmcli -g GENERAL.STATE device show "$IFACE" 2>/dev/null | grep -q '^100'
}

hotspot_active() {
  nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$CON"
}

hotspot_up() {
  nmcli --wait 30 connection up "$CON" >/dev/null 2>&1
}

# Join a saved Wi-Fi network other than the hotspot, most recently used
# first. (`nmcli device connect` would let NetworkManager pick, and it picks
# the hotspot again because that was used last.)
join_home_wifi() {
  local hotspot_uuid uuid type try
  hotspot_uuid=$(nmcli -g connection.uuid connection show "$CON" 2>/dev/null || true)
  for try in 1 2; do
    nmcli device wifi rescan ifname "$IFACE" >/dev/null 2>&1 || true
    sleep "${SCAN_WAIT:-4}"
    while IFS=: read -r _ uuid type; do
      [ "$type" = 802-11-wireless ] && [ "$uuid" != "$hotspot_uuid" ] || continue
      if nmcli --wait 25 connection up uuid "$uuid" ifname "$IFACE" >/dev/null 2>&1; then
        echo "Joined Wi-Fi \"$(nmcli -g connection.id connection show "$uuid" 2>/dev/null)\" (try $try)."
        return 0
      fi
    done < <(nmcli -t -f TIMESTAMP,UUID,TYPE connection show | sort -t: -k1,1 -rn)
  done
  return 1
}
