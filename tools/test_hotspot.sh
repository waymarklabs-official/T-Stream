#!/bin/bash
# Scenario tests for bin/hotspot-on.sh and bin/hotspot-off.sh against a fake,
# stateful NetworkManager (nmcli) that enforces NetworkManager's own limits
# (SSID 1-32 bytes, passphrase 8-63) and models networks being in or out of
# range. Every path must end on a network the owner can reach, also when the
# SSH session drops mid-switch, or config.json is broken.
#
#   tools/test_hotspot.sh        (run as root, like the real scripts)
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/root" "$T/nm"
export CANVAS_ROOT="$T/root" HOTSPOT_LOG="$T/hotspot.log" SCAN_WAIT=0 OFFLINE_INTERVAL=0 OFFLINE_WAIT=0
GOOD_CONFIG='{"player": {"autoResyncMs": 500}, "hotspot": {"ssid": "TestSpot", "password": "abcd-efgh-jkmn", "country": "US"}}'
echo pi > "$T/root/.owner"

# ---- fake nmcli. Profiles: name|uuid|type|timestamp|autoconnect|mode|ssid|psk
cat > "$T/bin/nmcli" <<'STUB'
#!/bin/bash
S=$NM_STATE
echo "nmcli $*" >> "$S/calls"
[ "${1:-}" = --wait ] && shift 2
row() { awk -F'|' -v k="$1" -v c="${2:-1}" '$c==k' "$S/profiles"; }
field() { row "$1" "${3:-1}" | cut -d'|' -f"$2"; }
setf() { awk -F'|' -v OFS='|' -v n="$1" -v f="$2" -v v="$3" '$1==n{$f=v}1' "$S/profiles" > "$S/p.tmp" && mv "$S/p.tmp" "$S/profiles"; }
active() { cat "$S/active"; }
activate() {
  local n=$1
  [ -n "$(row "$n")" ] || { echo "Error: unknown connection '$n'." >&2; return 10; }
  sleep "${NM_UP_DELAY:-0}"
  local mode ssid; mode=$(field "$n" 6); ssid=$(field "$n" 7)
  if [ "$mode" = ap ]; then
    case " ${NM_AP_FAIL:-} " in *" $n "*|*" all "*) echo "" > "$S/active"; return 4 ;; esac
  else
    grep -qx "$ssid" "$S/inrange" || { echo "" > "$S/active"; return 4; }
  fi
  echo "$n" > "$S/active"; setf "$n" 4 "$(date +%s%N)"; return 0
}
case "$1 $2" in
  "-t -f")
    case "$*" in
      "-t -f TIMESTAMP,UUID,TYPE connection show") awk -F'|' '{print $4":"$2":"$3}' "$S/profiles" ;;
      "-t -f NAME connection show --active") active ;;
      *) exit 2 ;;
    esac ;;
  # nmcli -g FIELD connection show NAME   |   nmcli -g FIELD connection show uuid UUID
  "-g connection.id") if [ "$5" = uuid ]; then n=$(field "$6" 1 2); [ -n "$n" ] || exit 10; echo "$n"
                      else [ -n "$(row "$5")" ] || exit 10; echo "$5"; fi ;;
  "-g 802-11-wireless.mode") field "$6" 6 2 ;;
  "-g 802-11-wireless.ssid") [ -n "$(row "$5")" ] || exit 10; field "$5" 7 ;;
  "-s -g") [ -n "$(row "$6")" ] || exit 10; field "$6" 8 ;;   # -s -g FIELD connection show NAME
  "-g GENERAL.STATE") if [ -n "$(active)" ]; then echo "100 (connected)"; else cat "$S/state"; fi ;;
  "-g GENERAL.CONNECTION") active ;;
  "-g GENERAL.CON-UUID") a=$(active); [ -n "$a" ] && field "$a" 2 ;;
  "connection add")
    shift 2; name="" ssid="" psk="" ac="" mode=infrastructure
    while [ $# -gt 0 ]; do
      case "$1" in
        con-name) name=$2 ;; ssid) ssid=$2 ;; wifi-sec.psk) psk=$2 ;;
        connection.autoconnect) ac=$2 ;; 802-11-wireless.mode) mode=$2 ;;
      esac
      shift 2 || break
    done
    b=$(printf '%s' "$ssid" | wc -c); p=$(printf '%s' "$psk" | wc -c)
    if [ "$b" -lt 1 ] || [ "$b" -gt 32 ]; then echo "Error: '$ssid' is not valid" >&2; exit 2; fi
    if [ -n "$psk" ] && { [ "$p" -lt 8 ] || [ "$p" -gt 63 ]; }; then echo "Error: invalid psk" >&2; exit 2; fi
    echo "$name|uuid-$name-$RANDOM|802-11-wireless|0|${ac:-yes}|$mode|$ssid|$psk" >> "$S/profiles" ;;
  "connection delete") [ -n "$(row "$3")" ] || exit 10
    [ "$(active)" = "$3" ] && echo "" > "$S/active"
    awk -F'|' -v n="$3" '$1!=n' "$S/profiles" > "$S/p.tmp"; mv "$S/p.tmp" "$S/profiles" ;;
  "connection modify") n=$3; [ -n "$(row "$n")" ] || exit 10; shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        connection.autoconnect) setf "$n" 5 "$2" ;;
        802-11-wireless.ssid) setf "$n" 7 "$2" ;;
        wifi-sec.psk) setf "$n" 8 "$2" ;;
        connection.id) setf "$n" 1 "$2"; [ "$(active)" = "$n" ] && echo "$2" > "$S/active"; n=$2 ;;
      esac
      shift 2
    done ;;
  "connection up") if [ "$3" = uuid ]; then activate "$(field "$4" 1 2)"; else activate "$3"; fi ;;
  "connection down") [ "$(active)" = "$3" ] && echo "" > "$S/active"; true ;;
  "device wifi"|"device set") true ;;
  *) echo "fake nmcli: unhandled: $*" >&2; exit 2 ;;
esac
STUB
cat > "$T/bin/ip" <<'STUB'
#!/bin/bash
echo "192.168.1.50 dev ${FAKE_SSH_DEV:-eth9} src 192.168.1.20 uid 0"
STUB
cat > "$T/bin/raspi-config" <<'STUB'
#!/bin/bash
echo "raspi-config $*" >> "$NM_STATE/calls"
[ "$2" = get_wifi_country ] && { [ -n "${FAKE_COUNTRY:-}" ] && echo "$FAKE_COUNTRY" && exit 0; exit 1; }
true
STUB
printf '#!/bin/bash\ntrue\n' > "$T/bin/rfkill"
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" NM_STATE="$T/nm"

HOME_ROW='HomeWiFi|uuid-home|802-11-wireless|1700000000|yes|infrastructure|HomeWiFi|homepass1'
WIRED_ROW='Wired|uuid-eth|802-3-ethernet|1800000000|yes||'
hotspot_row() { echo "TStream-Hotspot|uuid-hs|802-11-wireless|1900000000|${1:-yes}|ap|TestSpot|abcd-efgh-jkmn"; }

reset_nm() {  # $1 = active connection, $2 = with-hotspot [autoconnect]
  : > "$T/nm/calls"; : > "$HOTSPOT_LOG"
  printf '%s\n%s\n' "$HOME_ROW" "$WIRED_ROW" > "$T/nm/profiles"
  [ "${2:-}" = with-hotspot ] && hotspot_row "${3:-yes}" >> "$T/nm/profiles"
  echo "$1" > "$T/nm/active"
  echo "30 (disconnected)" > "$T/nm/state"
  echo HomeWiFi > "$T/nm/inrange"
  echo "$GOOD_CONFIG" > "$T/root/config.json"
  unset NM_AP_FAIL NM_UP_DELAY FAKE_SSH_DEV SSH_CONNECTION FAKE_COUNTRY
  export FAKE_COUNTRY=US
}
active() { cat "$T/nm/active"; }
prof() { grep "^$1|" "$T/nm/profiles" | cut -d'|' -f"$2"; }   # prof NAME FIELD (5 autoconnect, 7 ssid, 8 psk)
nprof() { grep -c "^$1|" "$T/nm/profiles"; }
cfg() { python3 -c "import json;print(json.load(open('$T/root/config.json'))['hotspot']['$1'])"; }

pass=0 fail=0
check() {  # name, then a test expression
  local name=$1; shift
  if "$@"; then pass=$((pass + 1)); echo "PASS  $name"
  else fail=$((fail + 1)); echo "FAIL  $name"
    echo "      active=$(active) profiles: $(tr '\n' ';' < "$T/nm/profiles")"
    echo "      calls: $(tail -n 12 "$T/nm/calls" | tr '\n' ';')"
    echo "      log: $(tr '\n' ';' < "$HOTSPOT_LOG" | cut -c1-400)"
  fi
}
ON="$REPO/bin/hotspot-on.sh"; OFF="$REPO/bin/hotspot-off.sh"

# --------------------------------------------------------------- hotspot-on
reset_nm HomeWiFi
bash "$ON" >/dev/null; rc=$?
check "on: hotspot starts and autostarts at boot" test "$rc" = 0 -a "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 5)" = yes -a "$(nprof TStream-Hotspot-new)" = 0

reset_nm HomeWiFi; export NM_AP_FAIL=all
bash "$ON" >/dev/null; rc=$?
check "on: AP fails -> back on home Wi-Fi, nothing left behind" test "$rc" = 1 -a "$(active)" = HomeWiFi -a "$(nprof TStream-Hotspot)" = 0 -a "$(nprof TStream-Hotspot-new)" = 0

reset_nm HomeWiFi; export NM_AP_FAIL=all; : > "$T/nm/inrange"
bash "$ON" >/dev/null; rc=$?
check "on: AP fails and home gone -> NetworkManager left to autoconnect" grep -q 'device set wlan0 autoconnect yes' "$T/nm/calls"

reset_nm TStream-Hotspot with-hotspot; : > "$T/nm/inrange"
out=$(bash "$ON" "Grandmas House Kids Toy Network 2" 2>&1); rc=$?
check "on: 33-byte name refused before anything changes (hotspot stays, config kept)" \
  test "$rc" = 1 -a "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 7)" = TestSpot -a "$(cfg ssid)" = TestSpot
check "on: ...with a message saying why" test -n "$(echo "$out" | grep '1 to 32 bytes')" -a -z "$(grep 'connection add' "$T/nm/calls")"

reset_nm TStream-Hotspot with-hotspot
bash "$ON" TestSpot "kurz" >/dev/null 2>&1; rc1=$?
bash "$ON" TestSpot "pässwörd-123" >/dev/null 2>&1; rc2=$?
check "on: short or non-ASCII password refused, config kept" test "$rc1" = 1 -a "$rc2" = 1 -a "$(cfg password)" = abcd-efgh-jkmn -a "$(active)" = TStream-Hotspot

reset_nm TStream-Hotspot with-hotspot; : > "$T/nm/inrange"; export NM_AP_FAIL=TStream-Hotspot-new
bash "$ON" TestSpot "new-pass-9999" >/dev/null; rc=$?
check "on: change while away from home, new AP fails -> old hotspot back, config kept" \
  test "$rc" = 1 -a "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 8)" = abcd-efgh-jkmn -a "$(cfg password)" = abcd-efgh-jkmn -a "$(nprof TStream-Hotspot-new)" = 0

reset_nm TStream-Hotspot with-hotspot
bash "$ON" NewName "new-pass-9999" >/dev/null; rc=$?
check "on: change while on -> one profile with the new settings, config saved" \
  test "$rc" = 0 -a "$(active)" = TStream-Hotspot -a "$(nprof TStream-Hotspot)" = 1 -a "$(prof TStream-Hotspot 7)" = NewName -a "$(cfg password)" = new-pass-9999 -a "$(prof TStream-Hotspot 5)" = yes

reset_nm TStream-Hotspot with-hotspot
out=$(bash "$ON"); rc=$?
check "on: already on with the same settings -> nothing touched" test "$rc" = 0 -a -z "$(grep 'connection up\|connection add\|connection delete' "$T/nm/calls")" -a -n "$(echo "$out" | grep 'already on')"

reset_nm HomeWiFi with-hotspot no; echo '{"hotspot": {"ssid": "TestSpot",}' > "$T/root/config.json"
bash "$ON" >/dev/null; rc=$?
check "on: broken config.json -> uses the saved hotspot instead" test "$rc" = 0 -a "$(active)" = TStream-Hotspot

reset_nm HomeWiFi; export FAKE_COUNTRY=DE
bash "$ON" >/dev/null
check "on: Wi-Fi country already set (DE) -> left alone" test -z "$(grep do_wifi_country "$T/nm/calls")"
reset_nm HomeWiFi; export FAKE_COUNTRY=""
bash "$ON" >/dev/null
check "on: no Wi-Fi country yet -> set from config" grep -q 'do_wifi_country US' "$T/nm/calls"

# -------------------------------------------------------------- hotspot-off
reset_nm TStream-Hotspot with-hotspot
bash "$OFF" >/dev/null; rc=$?
check "off: back on home Wi-Fi (not Wired, not the hotspot), no autostart" test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(prof TStream-Hotspot 5)" = no

reset_nm TStream-Hotspot with-hotspot; : > "$T/nm/inrange"
bash "$OFF" >/dev/null; rc=$?
check "off: home out of range -> hotspot comes back (reachable at 10.42.0.1)" test "$rc" = 1 -a "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 5)" = yes

reset_nm TStream-Hotspot with-hotspot; : > "$T/nm/inrange"
echo 'Hotspot|uuid-other|802-11-wireless|1950000000|no|ap|SomeOtherAP|xxxxxxxx' >> "$T/nm/profiles"
bash "$OFF" >/dev/null; rc=$?
check "off: another access-point profile is not mistaken for home Wi-Fi" test "$rc" = 1 -a "$(active)" = TStream-Hotspot

reset_nm HomeWiFi with-hotspot no
bash "$OFF" >/dev/null; rc=$?
check "off: hotspot not running -> nothing changes" test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(prof TStream-Hotspot 5)" = no

# ---------------------------------------------------- SSH session drops mid-switch
reset_nm HomeWiFi; export FAKE_SSH_DEV=wlan0 SSH_CONNECTION="192.168.1.50 50000 192.168.1.20 22" NM_UP_DELAY=2
( setsid bash "$ON" > "$T/tty.out" 2>&1 & echo $! > "$T/pid"; wait ) &
sleep 11.5   # the 10 s warning, then the switch starts
kill -HUP -- -"$(cat "$T/pid")" 2>/dev/null; sleep 4
check "on over SSH: survives the hang-up, hotspot on, progress logged" \
  test "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 5)" = yes -a -n "$(grep 'Hotspot is ON' "$HOTSPOT_LOG")"
check "on over SSH: details shown before the session drops" grep -q 'Password:   abcd-efgh-jkmn' "$T/tty.out"

reset_nm TStream-Hotspot with-hotspot; : > "$T/nm/inrange"
export FAKE_SSH_DEV=wlan0 SSH_CONNECTION="10.42.0.20 50000 10.42.0.1 22" NM_UP_DELAY=2
( setsid bash "$OFF" > "$T/tty.out" 2>&1 & echo $! > "$T/pid"; wait ) &
sleep 4.5; kill -HUP -- -"$(cat "$T/pid")" 2>/dev/null; sleep 8
check "off over SSH, home fails: survives the hang-up and restores the hotspot" \
  test "$(active)" = TStream-Hotspot -a -n "$(grep 'Turning the hotspot back on' "$HOTSPOT_LOG")"

# `sudo hotspot-off` strips SSH_CONNECTION; it must be found in a parent process
reset_nm TStream-Hotspot with-hotspot; export FAKE_SSH_DEV=wlan0
# like ssh -> login shell (started with SSH_CONNECTION) -> sudo (resets the environment) -> script
SSH_CONNECTION="10.42.0.20 50000 10.42.0.1 22" bash -c "env -u SSH_CONNECTION bash '$OFF'; true" > "$T/tty.out" 2>&1
check "off via sudo (SSH_CONNECTION stripped): session still detected, output to the log" \
  test -n "$(grep 'will disconnect now' "$T/tty.out")" -a -n "$(grep 'Hotspot is OFF' "$HOTSPOT_LOG")"

# SSH through Tailscale (remote-on) also rides on the Wi-Fi
reset_nm TStream-Hotspot with-hotspot; export FAKE_SSH_DEV=tailscale0 SSH_CONNECTION="100.64.0.7 50000 100.64.0.9 22"
bash "$OFF" > "$T/tty.out" 2>&1
check "off over a Tailscale SSH session: treated as a session that will drop" \
  test -n "$(grep 'will disconnect now' "$T/tty.out")" -a -n "$(grep 'Hotspot is OFF' "$HOTSPOT_LOG")"

# ------------------------------------------------------------ boot safety net
reset_nm HomeWiFi
bash "$ON" --if-offline; rc=$?
check "boot: Wi-Fi joined -> no hotspot" test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(nprof TStream-Hotspot)" = 0

reset_nm ""
bash "$ON" --if-offline; rc=$?
check "boot: no Wi-Fi, no profile yet -> temporary hotspot (no autostart next boot)" test "$rc" = 0 -a "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 5)" = no

reset_nm "" with-hotspot yes
bash "$ON" --if-offline
check "boot: existing hotspot profile keeps its autostart setting" test "$(active)" = TStream-Hotspot -a "$(prof TStream-Hotspot 5)" = yes

reset_nm "" with-hotspot no; echo '{"hotspot": {"ssid": "TestSpot", "password": "abc"},}' > "$T/root/config.json"
bash "$ON" --if-offline; rc=$?
check "boot: broken config.json does not stop the safety net" test "$rc" = 0 -a "$(active)" = TStream-Hotspot

reset_nm ""; echo "50 (connecting (configuring))" > "$T/nm/state"
( sleep 2; echo HomeWiFi > "$T/nm/active" ) &
bash "$ON" --if-offline; rc=$?; wait
check "boot: Wi-Fi still connecting at the deadline -> waits, no hotspot" test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(nprof TStream-Hotspot)" = 0

# --------------------------------------------------------------- install step
reset_nm HomeWiFi
bash "$ON" --prepare; rc=$?
check "prepare: profile created, not started, no autostart" test "$rc" = 0 -a "$(active)" = HomeWiFi -a "$(prof TStream-Hotspot 5)" = no -a "$(prof TStream-Hotspot 8)" = abcd-efgh-jkmn

reset_nm HomeWiFi with-hotspot no; python3 -c "
import json; p='$T/root/config.json'; c=json.load(open(p)); c['hotspot']['password']='brand-new-pass'; json.dump(c, open(p,'w'))"
bash "$ON" --prepare
check "prepare: existing profile updated to match config, still not started" test "$(prof TStream-Hotspot 8)" = brand-new-pass -a "$(active)" = HomeWiFi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
