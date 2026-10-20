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
# shellcheck disable=SC2034  # used by hotspot-on.sh
CONF="$ROOT/config.json"

need_nmcli() {
  if ! command -v nmcli >/dev/null; then
    echo "NetworkManager (nmcli) is not installed. Raspberry Pi OS Bookworm has it by default;"
    echo "on older Pi OS enable it with: sudo raspi-config  ->  Advanced  ->  Network Config  ->  NetworkManager"
    exit 1
  fi
}

# The login name to suggest for ssh.
ssh_user() {
  echo "${SUDO_USER:-$(cat "$ROOT/.owner" 2>/dev/null || echo pi)}"
}

# SSH_CONNECTION of the session that started us, also when `sudo` removed it
# from our environment (it is still in a parent process's environment).
ssh_connection() {
  if [ -n "${SSH_CONNECTION:-}" ]; then
    echo "$SSH_CONNECTION"
    return
  fi
  local pid=$PPID v
  while [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
    v=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^SSH_CONNECTION=//p' | head -1)
    if [ -n "$v" ]; then
      echo "$v"
      return
    fi
    pid=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f2)
  done
}

# True if the SSH session runs over $IFACE (it drops when the Wi-Fi mode changes).
ssh_over_wifi() {
  local conn client dev
  conn=$(ssh_connection)
  [ -n "$conn" ] || return 1
  client=${conn%% *}
  dev=$(ip route get "$client" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
  [ "$dev" = "$IFACE" ]
}

# The terminal is about to go away: log to a file from now on, so nothing is
# written to a dead terminal. (Both scripts already ignore the hang-up.)
detach_from_terminal() {
  exec </dev/null >>"$HOTSPOT_LOG" 2>&1
  echo "--- $(date '+%F %T') $*"
}

wifi_state() {  # NetworkManager device state number: 100 connected, 40-90 connecting, 30 disconnected
  local s
  s=$(nmcli -g GENERAL.STATE device show "$IFACE" 2>/dev/null | cut -d' ' -f1)
  case "$s" in ''|*[!0-9]*) echo 0 ;; *) echo "$s" ;; esac
}

wifi_connected() {
  [ "$(wifi_state)" = 100 ]
}

profile_exists() {
  nmcli -g connection.id connection show "$1" >/dev/null 2>&1
}

hotspot_active() {
  nmcli -t -f NAME connection show --active 2>/dev/null | grep -qx "$CON"
}

hotspot_up() {
  nmcli --wait 30 connection up "$CON" >/dev/null 2>&1
}

# Join a saved Wi-Fi network other than a hotspot, most recently used first.
# (`nmcli device connect` would let NetworkManager pick, and it picks the
# hotspot again because that was used last.) --wait is longer than
# NetworkManager's own 25 s association timeout, so a network that is not in
# range fails cleanly before the next one is tried.
join_home_wifi() {
  local uuid type mode name try
  for try in 1 2; do
    nmcli device wifi rescan ifname "$IFACE" >/dev/null 2>&1 || true
    sleep "${SCAN_WAIT:-4}"
    while IFS=: read -r _ uuid type; do
      [ "$type" = 802-11-wireless ] || continue
      name=$(nmcli -g connection.id connection show uuid "$uuid" 2>/dev/null)
      case "$name" in "$CON"*) continue ;; esac
      # only client ("infrastructure") profiles: an access-point profile
      # always "connects", and would not be the hotspot the toy knows
      mode=$(nmcli -g 802-11-wireless.mode connection show uuid "$uuid" 2>/dev/null)
      case "$mode" in ''|infrastructure) ;; *) continue ;; esac
      if nmcli --wait 45 connection up uuid "$uuid" ifname "$IFACE" >/dev/null 2>&1; then
        echo "Joined Wi-Fi \"$name\" (try $try)."
        return 0
      fi
    done < <(nmcli -t -f TIMESTAMP,UUID,TYPE connection show | sort -t: -k1,1 -rn)
  done
  return 1
}

# Never override a Wi-Fi country the Pi already has (changing it can hide the
# home network's channel); only set one when none is set.
prepare_radio() {
  rfkill unblock wifi 2>/dev/null || true
  local cur=""
  if command -v raspi-config >/dev/null; then
    cur=$(raspi-config nonint get_wifi_country 2>/dev/null || true)
  elif command -v iw >/dev/null; then
    cur=$(iw reg get 2>/dev/null | sed -n 's/^country \([A-Z0-9]*\):.*/\1/p' | head -1)
  fi
  case "$cur" in ''|00) ;; *) return 0 ;; esac
  [ -n "${COUNTRY:-}" ] || return 0
  if command -v raspi-config >/dev/null; then
    raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true
  elif command -v iw >/dev/null; then
    iw reg set "$COUNTRY" 2>/dev/null || true
  fi
}
