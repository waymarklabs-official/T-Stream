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

if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
  echo "Python $(python3 -V 2>&1 | cut -d' ' -f2) is too old for the current yt-dlp: YouTube downloads may fail."
  echo "Raspberry Pi OS Bookworm (or newer) has a recent enough Python."
fi
extra=default
case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
  arm64|amd64|aarch64|x86_64) extra="default,deno" ;;
esac
export PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1   # no cache: it would grow on the SD card

# one update at a time (install.sh and the page may both start one)
mkdir -p "$ROOT/state"
exec 9>>"$ROOT/state/yt-dlp-update.lock"
flock 9
# a venv broken by a Python upgrade or a power cut is made again
if ! "$VENV/bin/python" -c 'import pip' 2>/dev/null; then
  python3 -m venv --clear "$VENV"
fi
# the nightly yt-dlp (a pre-release on PyPI), but only released versions of what it needs
"$VENV/bin/pip" install -q -U --prefer-binary "yt-dlp[$extra]>=2025.1.1.dev0"
echo "yt-dlp $("$VENV/bin/yt-dlp" --version)$([ -x "$VENV/bin/deno" ] && echo ", deno $("$VENV/bin/deno" --version | head -1 | cut -d' ' -f2)")"
