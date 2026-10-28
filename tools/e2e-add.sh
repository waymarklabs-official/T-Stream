#!/bin/bash
# End-to-end test of the add-videos page through the real Caddy config:
# scratch root + fake yt-dlp (tools/test_add.py --setup), add/addserver.py,
# Caddy running server/Caddyfile.template on spare ports, and the page driven
# in headless Chromium at phone size (tools/e2e-add.js).
#
#   tools/e2e-add.sh [--keep]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT=$(mktemp -d /tmp/tstream-e2e-add.XXXXXX)
P_HTTP=18080 P_HTTPS=18443 P_FUNNEL=18099 P_ASK=18081 P_ADD=18098 P_ADMIN=18019
KEY=e2etestkey1234
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ "${1:-}" != keep ]; then rm -rf "$ROOT"; else echo "kept $ROOT"; fi
}
trap 'cleanup' EXIT

python3 "$REPO/tools/test_add.py" --setup "$ROOT"
rsync -a --exclude /media/ "$REPO/site/" "$ROOT/site/"

# config with a known secret link, and the Caddyfile on spare ports
python3 - "$REPO/server/Caddyfile.template" "$ROOT" "$KEY" $P_HTTP $P_HTTPS $P_FUNNEL $P_ASK $P_ADD $P_ADMIN <<'PYEOF'
import json, sys
tpl, root, key, http, https, funnel, ask, add, admin = sys.argv[1:]
cfg = json.load(open(root + "/config.json"))
cfg["remote"] = {"key": key}
json.dump(cfg, open(root + "/config.json", "w"))
s = open(tpl).read()
s = s.replace("@ROOT@", root).replace("@LOG@", root + "/caddy-access.log").replace("@REMOTE_KEY@", key)
for old, new in (("\nhttp:// {", "\nhttp://:%s {" % http), ("\nhttps:// {", "\nhttps://:%s {" % https),
                 ("\nhttp://:8099 {", "\nhttp://:%s {" % funnel), ("127.0.0.1:2080", "127.0.0.1:" + ask),
                 ("reverse_proxy 127.0.0.1:8098", "reverse_proxy 127.0.0.1:" + add)):
    assert old in s, old
    s = s.replace(old, new)
s = s.replace("{\n", "{\n\tadmin localhost:%s\n\tstorage file_system {\n\t\troot %s/caddy-data\n\t}\n" % (admin, root), 1)
open(root + "/Caddyfile", "w").write(s)
PYEOF
caddy validate --config "$ROOT/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || {
  caddy validate --config "$ROOT/Caddyfile" --adapter caddyfile; exit 1; }
caddy run --config "$ROOT/Caddyfile" --adapter caddyfile > "$ROOT/caddy.log" 2>&1 &
pids+=($!)
FAKE_ROOT="$ROOT" python3 -u "$REPO/add/addserver.py" --root "$ROOT" --port "$P_ADD" \
  --prep-dir "$REPO/prep" > "$ROOT/addserver.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do
  curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$P_HTTP/add/" && break
  sleep 0.2
done

status=0
NODE_PATH=$(npm root -g) node "$REPO/tools/e2e-add.js" "http://127.0.0.1:$P_HTTP/" "$(cat "$ROOT/state/add-pin.txt")" \
  "$ROOT" "http://127.0.0.1:$P_FUNNEL/" "$KEY" || status=$?
if [ $status -ne 0 ]; then
  echo "--- addserver.log"; tail -30 "$ROOT/addserver.log"
  echo "--- caddy.log"; tail -10 "$ROOT/caddy.log"
fi
trap - EXIT
cleanup "$([ "${1:-}" = --keep ] && echo keep)"
exit $status
