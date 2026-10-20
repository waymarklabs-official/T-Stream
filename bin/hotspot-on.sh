#!/bin/bash
# Turn the Pi into a Wi-Fi hotspot for the toy (no internet needed).
# The Pi is then always at http://10.42.0.1/ (ssh <user>@10.42.0.1). It stays
# on, also after a reboot, until you run hotspot-off.
#
#   hotspot-on                      start it with the saved name/password
#   hotspot-on MyName MyPassword    change name/password (saved once it works)
#   hotspot-on --if-offline         (at boot) start it only if the Pi has not
#                                   joined any Wi-Fi within ~3 minutes
#   hotspot-on --prepare            (install) create the hotspot settings, don't start
#
# Nothing working is removed before its replacement is up: if the hotspot
# cannot start, the Pi goes back to the network it was on.
set -euo pipefail
HERE=$(dirname "$(readlink -f "$0")")
# shellcheck source=wifi-common.sh
. "$HERE/wifi-common.sh"

[ "$(id -u)" -eq 0 ] || exec sudo CANVAS_ROOT="$ROOT" IFACE="$IFACE" SSH_CONNECTION="${SSH_CONNECTION:-}" "$0" "$@"
trap '' HUP   # a dropped SSH session must never stop a half-done switch
need_nmcli

MODE=normal
case "${1:-}" in
  --if-offline) MODE=fallback; shift ;;
  --prepare) MODE=prepare; shift ;;
esac
NEW_SSID=${1:-}
NEW_PASS=${2:-}
NEW=$CON-new

# Reads config.json (plus a new name/password, if given) into SSID, PASS,
# COUNTRY. Never writes anything. On a problem sets CFG_ERR and returns 1.
load_config() {
  local out
  out=$(python3 - "$CONF" "$NEW_SSID" "$NEW_PASS" <<'PYEOF'
import json, shlex, sys
path, new_ssid, new_pw = sys.argv[1:4]
err = ""
try:
    with open(path) as f:
        hs = (json.load(f) or {}).get("hotspot") or {}
    if not isinstance(hs, dict):
        raise ValueError('"hotspot" is not a {...} section')
except Exception as e:
    hs, err = {}, "config.json cannot be read (%s)" % e
ssid = new_ssid or str(hs.get("ssid") or "")
pw = new_pw or str(hs.get("password") or "")
if not err and not 1 <= len(ssid.encode()) <= 32:
    err = "the Wi-Fi name must be 1 to 32 bytes long"
if not err and not (8 <= len(pw) <= 63 and all(32 <= ord(c) < 127 for c in pw)):
    err = "the password must be 8 to 63 plain characters (letters, digits, - _ . and so on)"
for k, v in (("SSID", ssid), ("PASS", pw), ("COUNTRY", str(hs.get("country") or "")), ("CFG_ERR", err)):
    print("%s=%s" % (k, shlex.quote(v)))
PYEOF
  ) || out="CFG_ERR='could not run python3'"
  eval "$out"
  [ -z "$CFG_ERR" ]
}

# Saves a new name/password into config.json (only after the hotspot works).
save_config() {
  python3 - "$CONF" "$SSID" "$PASS" <<'PYEOF' || echo "(could not save the new name/password to config.json)"
import json, sys
path, ssid, pw = sys.argv[1:4]
with open(path) as f:
    cfg = json.load(f)
cfg.setdefault("hotspot", {}).update({"ssid": ssid, "password": pw})
with open(path + ".tmp", "w") as f:
    json.dump(cfg, f, indent=2)
import os
os.replace(path + ".tmp", path)
PYEOF
}

create_profile() {  # $1 = profile name; created switched off and not autostarting
  nmcli connection add type wifi ifname "$IFACE" con-name "$1" \
    ssid "$SSID" connection.autoconnect no connection.autoconnect-priority 100 \
    802-11-wireless.mode ap 802-11-wireless.band bg \
    ipv4.method shared ipv4.addresses 10.42.0.1/24 ipv6.method ignore \
    wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
    wifi-sec.proto rsn wifi-sec.pairwise ccmp wifi-sec.group ccmp wifi-sec.pmf disable >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Boot safety net. Uses the saved hotspot profile and does not depend on
# config.json, so a typo there can never disable it.
if [ "$MODE" = fallback ]; then
  set +e
  exec >>"$HOTSPOT_LOG" 2>&1
  deadline=$((SECONDS + ${OFFLINE_WAIT:-180}))
  while :; do
    st=$(wifi_state)
    [ "$st" = 100 ] && exit 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      # still connecting (40-90)? give it up to one more minute
      if [ "$st" -ge 40 ] && [ "$SECONDS" -lt $((deadline + 60)) ]; then sleep 5; continue; fi
      break
    fi
    sleep "${OFFLINE_INTERVAL:-10}"
  done
  echo "--- $(date '+%F %T') boot: no Wi-Fi joined, starting the hotspot until the next reboot"
  if ! profile_exists "$CON"; then
    if ! load_config; then echo "no hotspot settings yet and $CFG_ERR"; exit 1; fi
    create_profile "$CON" || { echo "could not create the hotspot settings"; exit 1; }
  fi
  prepare_radio
  if hotspot_up; then echo "hotspot started"; exit 0; fi
  echo "the hotspot did not start"
  nmcli device set "$IFACE" autoconnect yes >/dev/null 2>&1
  exit 1
fi

# ---------------------------------------------------------------------------
# Install: make sure the saved hotspot exists and matches config.json, so the
# boot safety net always has something to start. Never switches networks.
if [ "$MODE" = prepare ]; then
  if ! load_config; then echo "hotspot settings not prepared: $CFG_ERR"; exit 1; fi
  if profile_exists "$CON"; then
    nmcli connection modify "$CON" 802-11-wireless.ssid "$SSID" wifi-sec.psk "$PASS" >/dev/null 2>&1 || true
  else
    create_profile "$CON" || { echo "could not create the hotspot settings"; exit 1; }
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Normal: switch to hotspot mode.
use_saved=""
if ! load_config; then
  if [ -z "$NEW_SSID$NEW_PASS" ] && profile_exists "$CON"; then
    echo "Note: $CFG_ERR. Using the hotspot settings saved earlier."
    SSID=$(nmcli -g 802-11-wireless.ssid connection show "$CON" 2>/dev/null)
    PASS=$(nmcli -s -g 802-11-wireless-security.psk connection show "$CON" 2>/dev/null)
    use_saved=1
  else
    echo "Nothing was changed: $CFG_ERR."
    exit 1
  fi
fi

if hotspot_active && [ -z "$NEW_SSID$NEW_PASS" ] &&
   [ "$(nmcli -g 802-11-wireless.ssid connection show "$CON" 2>/dev/null)" = "$SSID" ] &&
   [ "$(nmcli -s -g 802-11-wireless-security.psk connection show "$CON" 2>/dev/null)" = "$PASS" ]; then
  echo "The hotspot is already on: Wi-Fi \"$SSID\", password $PASS, http://10.42.0.1/"
  exit 0
fi

cat <<EOF
Starting the hotspot:
  Wi-Fi name: $SSID
  Password:   $PASS
  Toy, phone or laptop: join that Wi-Fi, then open http://10.42.0.1/
  SSH to the Pi there:  ssh $(ssh_user)@10.42.0.1
If it cannot start, the Pi goes back to the network it is on now.
EOF
if ssh_over_wifi; then
  echo
  echo "This SSH session runs over $IFACE and will disconnect now. Write the details above down."
  echo "Starting in 10 seconds (Ctrl-C to cancel). Progress: $HOTSPOT_LOG"
  sleep 10
  detach_from_terminal "hotspot-on"
fi

# From here on no error may stop the script half-way between networks.
set +e
prev_uuid=$(nmcli -g GENERAL.CON-UUID device show "$IFACE" 2>/dev/null)
prepare_radio

started=""
if [ -n "$use_saved" ]; then
  hotspot_up && started=1
else
  # Build the new hotspot next to the old one; the old one goes only after
  # the new one is up.
  nmcli connection delete "$NEW" >/dev/null 2>&1
  if ! create_profile "$NEW"; then
    echo "Could not create the hotspot settings. Nothing was changed."
    exit 1
  fi
  if nmcli --wait 30 connection up "$NEW" >/dev/null 2>&1; then
    nmcli connection delete "$CON" >/dev/null 2>&1
    nmcli connection modify "$NEW" connection.id "$CON" >/dev/null 2>&1
    started=1
    [ -z "$NEW_SSID$NEW_PASS" ] || save_config
  else
    nmcli connection delete "$NEW" >/dev/null 2>&1
  fi
fi

if [ -n "$started" ]; then
  nmcli connection modify "$CON" connection.autoconnect yes >/dev/null 2>&1
  echo
  echo "Hotspot is ON (\"$SSID\", http://10.42.0.1/). It stays on after reboots."
  echo "To go back to your home Wi-Fi: hotspot-off"
  exit 0
fi

echo "The hotspot did not start on $IFACE. Going back to the previous network."
if [ -n "$prev_uuid" ] && nmcli --wait 45 connection up uuid "$prev_uuid" >/dev/null 2>&1; then
  echo "Back on \"$(nmcli -g connection.id connection show uuid "$prev_uuid" 2>/dev/null)\"."
elif join_home_wifi; then
  :
elif profile_exists "$CON" && hotspot_up; then
  echo "Back on the previous hotspot."
else
  nmcli device set "$IFACE" autoconnect yes >/dev/null 2>&1
  echo "No network could be started; the Pi will join a known Wi-Fi when one is in range."
fi
exit 1
