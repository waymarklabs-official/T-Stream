#!/bin/bash
# Convert every new or changed video in /srv/canvas-player/source.
# Safe to run any time; unchanged videos are skipped.
#
#   prep              convert what is new
#   prep --force      rebuild everything (after changing config.json; videos
#                     whose original file is gone keep their old version)
#   prep --prune      DELETES every video whose original file is gone from
#                     source/, including ones whose originals you removed to
#                     save space. Use it only to clean up on purpose.
set -eo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}

# Run as the library owner, so files never end up owned by root.
if [ "$(id -u)" -eq 0 ] && [ -f "$ROOT/.owner" ]; then
  owner=$(cat "$ROOT/.owner")
  if [ -n "$owner" ] && [ "$owner" != root ]; then
    exec sudo -u "$owner" CANVAS_ROOT="$ROOT" "$0" "$@"
  fi
fi

# keep the log small: when it passes 5 MB, keep its last 1 MB
log="$ROOT/prep.log"
if [ "$(stat -c %s "$log" 2>/dev/null || echo 0)" -gt 5000000 ]; then
  t=$(mktemp) && tail -c 1000000 "$log" > "$t" && cat "$t" > "$log"; rm -f "$t"
fi
nice -n 10 python3 -u "$ROOT/bin/prep.py" --root "$ROOT" "$@" 2>&1 | tee -a "$log"
