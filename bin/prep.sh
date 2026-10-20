#!/bin/bash
# Convert every new or changed video in /srv/canvas-player/source.
# Safe to run any time; unchanged videos are skipped.
#
#   prep              convert what is new
#   prep --force      rebuild everything (after changing config.json)
#   prep --prune      also remove videos whose source file was deleted
set -eo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}

# Run as the library owner, so files never end up owned by root.
if [ "$(id -u)" -eq 0 ] && [ -f "$ROOT/.owner" ]; then
  owner=$(cat "$ROOT/.owner")
  if [ -n "$owner" ] && [ "$owner" != root ]; then
    exec sudo -u "$owner" CANVAS_ROOT="$ROOT" "$0" "$@"
  fi
fi

nice -n 10 python3 -u "$ROOT/bin/prep.py" --root "$ROOT" "$@" 2>&1 | tee -a "$ROOT/prep.log"
