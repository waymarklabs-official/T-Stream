#!/bin/bash
# Installs or updates yt-dlp, the YouTube downloader behind the add-videos
# page, in $ROOT/yt-dlp (a Python venv owned by the library owner, so the
# page can update it by itself; it does so once a day before downloading).
#
# Nightly builds: YouTube changes often and the fixes land there first (in
# 2026 made-for-kids videos only worked with nightly for two months). Deno is
# the JavaScript runtime yt-dlp needs for YouTube; it only exists for 64-bit.
set -euo pipefail
ROOT=${CANVAS_ROOT:-/srv/canvas-player}
VENV="$ROOT/yt-dlp"

if [ "$(id -u)" -eq 0 ] && [ -f "$ROOT/.owner" ] && [ "$(cat "$ROOT/.owner")" != root ]; then
  exec sudo -u "$(cat "$ROOT/.owner")" CANVAS_ROOT="$ROOT" "$0" "$@"
fi

extra=default
case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  arm64|amd64|aarch64|x86_64) extra="default,deno" ;;
esac
export PIP_CACHE_DIR="$ROOT/state/cache/pip" PIP_DISABLE_PIP_VERSION_CHECK=1
if [ ! -x "$VENV/bin/pip" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q -U --pre "yt-dlp[$extra]"
echo "yt-dlp $("$VENV/bin/yt-dlp" --version)$([ -x "$VENV/bin/deno" ] && echo ", deno $("$VENV/bin/deno" --version | head -1 | cut -d' ' -f2)")"
