#!/bin/bash
# Scenario tests for bin/hotspot-on.sh and bin/hotspot-off.sh against a fake,
# stateful NetworkManager (nmcli). Checks that every path ends on a network
# the Pi can be reached on, also when the SSH session drops mid-switch.
#
#   tools/test_hotspot.sh        (run as root, like the real scripts)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/root" "$T/nm"
export CANVAS_ROOT="$T/root" HOTSPOT_LOG="$T/hotspot.log" SCAN_WAIT=0 OFFLINE_INTERVAL=0 OFFLINE_CHECKS=3
echo '{"hotspot": {"ssid": "TestSpot", "password": "abcd-efgh-jkmn", "country": "US"}}' > "$T/root/config.json"
echo pi > "$T/root/.owner"

# ---- fake nmcli: state in $T/nm ---------------------------------------------
cat > "$T/bin/nmcli" <<'STUB'
#!/bin/bash
S=$NM_STATE
echo "nmcli $*" >> "$S/calls"
[ "${1:-}" = --wait ] && shift 2
prof() { grep -s "^$1|" "$S/profiles"; }                 # name|uuid|type|ts|autoconnect
set_field() { awk -F'|' -v OFS='|' -v n="$1" -v f="$2" -v v="$3" '$1==n{$f=v}1' "$S/profiles" > "$S/p.tmp" && mv "$S/p.tmp" "$S/profiles"; }
name_of() { awk -F'|' -v u="$1" '$2==u{print $1}' "$S/profiles"; }
activate() {
  local n=$1
  [ -n "$(prof "$n")" ] || return 10
  sleep "${NM_UP_DELAY:-0}"
  if [ "$n" = TStream-Hotspot ] && [ -n "${NM_AP_FAILS:-}" ]; then echo "" > "$S/active"; return 4; fi
  if [ "$n" != TStream-Hotspot ] && [ -n "${NM_HOME_FAILS:-}" ]; then echo "" > "$S/active"; return 4; fi
  echo "$n" > "$S/active"; set_field "$n" 4 "$(date +%s%N)"; return 0
}
case "$*" in
  "-t -f TIMESTAMP,UUID,TYPE connection show") awk -F'|' '{print $4":"$2":"$3}' "$S/profiles" ;;
  "-t -f NAME connection show --active") cat "$S/active" ;;
  "-g connection.uuid connection show "*) p=$(prof "$5") || exit 10; echo "$p" | cut -d'|' -f2 ;;
  "-g connection.id connection show "*) n=$(name_of "$5"); [ -n "$n" ] && echo "$n" || prof "$5" | cut -d'|' -f1 | grep . ;;
  "-g 802-11-wireless.ssid connection show "*) prof "$5" >/dev/null && echo TestSpot ;;
  "-g GENERAL.STATE device show wlan0") [ -s "$S/active" ] && [ -n "$(cat "$S/active")" ] && echo "100 (connected)" || echo "30 (disconnected)" ;;
  "-g GENERAL.CONNECTION device show wlan0") cat "$S/active" ;;
  "connection add "*)
    n=$(echo "$*" | sed -n 's/.*con-name \([^ ]*\).*/\1/p'); ac=$(echo "$*" | sed -n 's/.*connection.autoconnect \([a-z]*\).*/\1/p')
    echo "$n|uuid-$n|802-11-wireless|0|$ac" >> "$S/profiles" ;;
  "connection delete "*) [ -n "$(prof "$3")" ] || exit 10; grep -v "^$3|" "$S/profiles" > "$S/p.tmp"; mv "$S/p.tmp" "$S/profiles"
    [ "$(cat "$S/active")" = "$3" ] && echo "" > "$S/active"; true ;;
  "connection modify "*) [ -n "$(prof "$3")" ] || exit 10; set_field "$3" 5 "$5" ;;
  "connection up uuid "*) activate "$(name_of "$4")" ;;
  "connection up "*) activate "$3" ;;
  "connection down "*) [ "$(cat "$S/active")" = "$3" ] && echo "" > "$S/active"; true ;;
  "device wifi rescan"*|"device set "*) true ;;
  *) echo "fake nmcli: unhandled: $*" >&2; exit 2 ;;
esac
STUB
cat > "$T/bin/ip" <<'STUB'
#!/bin/bash
echo "192.168.1.50 dev ${FAKE_SSH_DEV:-eth9} src 192.168.1.20 uid 0"
STUB
printf '#!/bin/bash\ntrue\n' > "$T/bin/rfkill"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

reset_nm() {  # $1 = active connection; home profiles exist
  export NM_STATE="$T/nm"
  : > "$T/nm/calls"; : > "$HOTSPOT_LOG"
  printf 'HomeWiFi|uuid-home|802-11-wireless|1700000000|yes\nWired|uuid-eth|802-3-ethernet|1800000000|yes\n' > "$T/nm/profiles"
  if [ "${2:-}" = with-hotspot ]; then echo "TStream-Hotspot|uuid-TStream-Hotspot|802-11-wireless|1900000000|${3:-yes}" >> "$T/nm/profiles"; fi
  echo "$1" > "$T/nm/active"
  unset NM_AP_FAILS NM_HOME_FAILS NM_UP_DELAY FAKE_SSH_DEV SSH_CONNECTION
}
active() { cat "$T/nm/active"; }
autoconn() { grep "^TStream-Hotspot|" "$T/nm/profiles" | cut -d'|' -f5; }

pass=0 fail=0
check() {  # name, condition result (0 ok)
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "PASS  $1"; else fail=$((fail + 1)); echo "FAIL  $1"; echo "      calls: $(tr '\n' ';' < "$T/nm/calls")"; echo "      log: $(tr '\n' ';' < "$HOTSPOT_LOG")"; fi
}
ok() { "$@" && echo 0 || echo 1; }

ON="$REPO/bin/hotspot-on.sh"; OFF="$REPO/bin/hotspot-off.sh"

reset_nm HomeWiFi
bash "$ON" >/dev/null; rc=$?
check "on: hotspot starts, autostarts at boot" "$(ok test "$rc" = 0 -a "$(active)" = TStream-Hotspot -a "$(autoconn)" = yes)"

reset_nm HomeWiFi; export NM_AP_FAILS=1
bash "$ON" >/dev/null; rc=$?
check "on: AP fails -> back on home Wi-Fi, broken profile removed" "$(ok test "$rc" = 1 -a "$(active)" = HomeWiFi -a -z "$(autoconn)")"

reset_nm HomeWiFi; export NM_AP_FAILS=1 NM_HOME_FAILS=1
bash "$ON" >/dev/null; rc=$?
check "on: AP and home fail -> NetworkManager left to autoconnect" "$(ok grep -q 'device set wlan0 autoconnect yes' "$T/nm/calls")"

reset_nm TStream-Hotspot with-hotspot
bash "$OFF" >/dev/null; rc=$?
check "off: back on home Wi-Fi (not Wired, not the hotspot), no autostart" "$(ok test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(autoconn)" = no)"

reset_nm TStream-Hotspot with-hotspot; export NM_HOME_FAILS=1
bash "$OFF" >/dev/null; rc=$?
check "off: home Wi-Fi fails -> hotspot comes back (reachable at 10.42.0.1)" "$(ok test "$rc" = 1 -a "$(active)" = TStream-Hotspot -a "$(autoconn)" = yes)"

reset_nm HomeWiFi with-hotspot no
bash "$OFF" >/dev/null; rc=$?
check "off: hotspot not running -> nothing changes" "$(ok test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(autoconn)" = no)"

# SSH over Wi-Fi: the session drops (SIGHUP, dead terminal) during the switch
reset_nm HomeWiFi; export FAKE_SSH_DEV=wlan0 SSH_CONNECTION="192.168.1.50 50000 192.168.1.20 22" NM_UP_DELAY=2
( setsid bash "$ON" > "$T/tty.out" 2>&1 & echo $! > "$T/pid"; wait ) &
sleep 11.5   # the 10 s warning, then the switch starts
pgid=$(cat "$T/pid"); kill -HUP -- -"$pgid" 2>/dev/null
exec 3>&-; sleep 4
check "on over SSH: survives the hang-up, hotspot on, progress logged" \
  "$(ok test "$(active)" = TStream-Hotspot -a "$(autoconn)" = yes -a -n "$(grep 'Hotspot is ON' "$HOTSPOT_LOG")")"
check "on over SSH: details shown before the session drops" "$(ok grep -q 'Password:   abcd-efgh-jkmn' "$T/tty.out")"

reset_nm TStream-Hotspot with-hotspot; export FAKE_SSH_DEV=wlan0 SSH_CONNECTION="10.42.0.20 50000 10.42.0.1 22" NM_UP_DELAY=2 NM_HOME_FAILS=1
( setsid bash "$OFF" > "$T/tty.out" 2>&1 & echo $! > "$T/pid"; wait ) &
sleep 4.5
kill -HUP -- -"$(cat "$T/pid")" 2>/dev/null
sleep 8
check "off over SSH, home fails: survives the hang-up and restores the hotspot" \
  "$(ok test "$(active)" = TStream-Hotspot -a -n "$(grep 'Turning the hotspot back on' "$HOTSPOT_LOG")")"

# boot safety net
reset_nm HomeWiFi
bash "$ON" --if-offline >/dev/null; rc=$?
check "boot: Wi-Fi joined -> no hotspot" "$(ok test "$rc" = 0 -a "$(active)" = HomeWiFi -a -z "$(autoconn)")"

reset_nm ""
bash "$ON" --if-offline >/dev/null; rc=$?
check "boot: no Wi-Fi -> temporary hotspot (does not autostart next boot)" "$(ok test "$rc" = 0 -a "$(active)" = TStream-Hotspot -a "$(autoconn)" = no)"

reset_nm "" with-hotspot yes
bash "$ON" --if-offline >/dev/null; rc=$?
check "boot: existing hotspot profile keeps its autostart setting" "$(ok test "$(active)" = TStream-Hotspot -a "$(autoconn)" = yes)"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
