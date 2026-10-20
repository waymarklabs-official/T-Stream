#!/bin/bash
# Show the diagnostics reports that diag.html (on the toy) sent to the Pi.
#
#   read-diag        newest report
#   read-diag 3      the 3 newest reports
#
# Each report is also saved to /srv/canvas-player/diag-reports/ and the newest
# one is published at http://<pi>/diag/last-report.json so you can open it
# from a phone or laptop and copy it.
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
LOG=${CANVAS_LOG:-/var/log/caddy/canvas-player.log}
N=${1:-1}

# Always as root: it writes the saved reports and site/diag/last-report.json.
if [ "$(id -u)" -ne 0 ]; then
  exec sudo CANVAS_ROOT="$ROOT" CANVAS_LOG="$LOG" "$0" "$@"
fi

shopt -s nullglob
files=( "${LOG%.log}"*.log "${LOG%.log}"*.log.gz "$LOG" )
if [ ! -e "$LOG" ]; then
  echo "No web server log at $LOG yet. Open http://<pi>/diag.html on the toy first."
  exit 1
fi

python3 - "$N" "$ROOT" "${files[@]}" <<'PYEOF'
import base64, gzip, json, os, re, sys

n, root, files = int(sys.argv[1]), sys.argv[2], sys.argv[3:]
seen = {}
for fn in sorted(set(files), key=lambda f: os.path.getmtime(f)):
    opener = gzip.open if fn.endswith(".gz") else open
    with opener(fn, "rt", errors="replace") as f:
        for line in f:
            if "/diag/report?d=" not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            req = entry.get("request", {})
            m = re.search(r"[?&]d=([A-Za-z0-9_-]+)", req.get("uri", ""))
            if not m:
                continue
            b = m.group(1) + "=" * (-len(m.group(1)) % 4)
            try:
                rep = json.loads(base64.urlsafe_b64decode(b).decode("utf-8"))
            except Exception:
                continue
            rep["_from"] = req.get("remote_ip") or req.get("client_ip")
            seen[rep.get("id", str(len(seen)))] = rep   # later stages replace earlier ones

reports = sorted(seen.values(), key=lambda r: r.get("sent", ""))
if not reports:
    print("No reports yet. Open http://<pi>/diag.html on the toy and wait for 'report sent'.")
    sys.exit(1)

outdir = os.path.join(root, "diag-reports")
os.makedirs(outdir, exist_ok=True)
for r in reports:
    name = "%s-%s.json" % (r.get("sent", "unknown").replace(":", "").replace(".", "")[:17], r.get("id", "x"))
    with open(os.path.join(outdir, name), "w") as f:
        json.dump(r, f, indent=1)
latest = reports[-1]
try:
    with open(os.path.join(root, "site", "diag", "last-report.json"), "w") as f:
        json.dump(latest, f, indent=1)
except OSError:
    pass


def show(r):
    e, ft = r.get("env", {}), r.get("features", {})
    print("=" * 72)
    print("Report %s  stage=%s  sent %s  from %s" % (r.get("id"), r.get("stage"), r.get("sent"), r.get("_from")))
    print("Page:      %s" % r.get("page"))
    print("Browser:   Chromium %s%s" % (e.get("chromium"), "  (Android WebView)" if e.get("androidWebView") else ""))
    print("UA:        %s" % e.get("userAgent"))
    print("Secure:    %s   HTTPS cert: %s" % (e.get("secureContext"), (r.get("https") or {}).get("trusted")))
    print("Screen:    %s window %s dpr %s, %s cores, %s GB" % (e.get("screen"), e.get("window"), e.get("devicePixelRatio"),
                                                          e.get("cores"), e.get("memoryGB")))
    print("Features:  " + ", ".join("%s=%s" % (k, "y" if v else "n") for k, v in ft.items()))
    for c, v in (r.get("codecs") or {}).items():
        print("Codec      %-16s any=%s hw=%s sw=%s" % (c, v.get("no-preference"), v.get("prefer-hardware"), v.get("prefer-software")))
    print("Audio:     " + ", ".join("%s=%s" % (k, v or "no") for k, v in (r.get("audio") or {}).items()))
    t = r.get("tests") or {}
    if t.get("audioClock"):
        print("Clock:     %s" % json.dumps(t["audioClock"]))
    for d in t.get("decode") or []:
        print("Decode     %-5s %-8s %-14s %s" % (d.get("kind"), d.get("size"), d.get("codec"),
              ("ERROR " + d["error"]) if d.get("error") else "%s fps %s" % (d.get("fps"), d.get("decoder") or "")))
    for d in t.get("realtime") or []:
        print("Playback   %-9s %s" % (d.get("backend"), ("ERROR " + d["error"]) if d.get("error") else
              "%s fps, %s dropped, worst late %s ms (%s)" % (d.get("fps"), d.get("dropped"), d.get("maxLateMs"), d.get("codec"))))
    for level, text in r.get("summary") or []:
        print("Summary    [%s] %s" % (level, text))
    if r.get("crash"):
        print("CRASH:     %s" % r["crash"][:500])


for r in reports[-n:]:
    show(r)
print("=" * 72)
print("Saved to %s/ - newest also at http://<pi>/diag/last-report.json" % outdir)
PYEOF
