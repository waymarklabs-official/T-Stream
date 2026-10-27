#!/usr/bin/env python3
"""Turn a folder of normal video files into the T-Stream canvas-player format.

    source/<Category>/<video files>   ->   site/media/<id>/...  +  site/media/catalog.json

Each top-level folder in source/ becomes a category. Each video becomes one
item with:

    manifest.json        everything the player needs
    thumb.jpg            320 px wide poster frame
    audio.opus / .mp3    the audio track (the player's master clock)
    h264/seg_*.bin       WebCodecs video track (CVS1 segments)
    mpeg1/seg_*.bin      MPEG-1 fallback video track (decoded by jsmpeg's WASM)

Safe to re-run at any time: unchanged items are skipped, a second copy of the
script waits for the first, and items are swapped in atomically so a video
that is playing is never half-written.

Usage:
    prep.py                      # use /srv/canvas-player (or the repo) defaults
    prep.py --source DIR --media DIR
    prep.py --force              # rebuild everything
    prep.py --only "Animals/*"   # rebuild only matching items (glob on relative path)
    prep.py --prune              # also delete media whose source file is gone
    prep.py --catalog-only       # just rebuild catalog.json from existing media

Newest files are converted first, and files that arrive during a run are
picked up by the same run. What prep is doing goes to ROOT/state/prep-status.json
(read by the add-videos page); files that failed are remembered there and only
retried when they change (or with --force).
"""

import argparse
import copy
import datetime
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cvs  # noqa: E402

PREP_VERSION = 1  # bump to force a rebuild of everything after format changes

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ROOT = "/srv/canvas-player"

VIDEO_EXTS = {".mp4", ".m4v", ".mkv", ".mov", ".avi", ".webm", ".mpg", ".mpeg", ".ts",
              ".m2ts", ".mts", ".wmv", ".flv", ".3gp", ".ogv", ".vob", ".divx", ".dv"}

TRACK_KINDS = ("h264", "vp9", "vp8", "mpeg1")

# MPEG-1 only allows these frame rates; using them for every track keeps all
# tracks of an item on the same timeline.
ALLOWED_FPS = [Fraction(24000, 1001), Fraction(24), Fraction(25), Fraction(30000, 1001), Fraction(30)]

DEFAULT_CONFIG = {
    "videoTracks": ["h264", "mpeg1"],
    "height": 480,
    "maxFps": 30,
    "keyframeSeconds": 1,
    "segmentSeconds": 4,
    "h264": {"profile": "main", "preset": "veryfast", "crf": 23},
    "vp9": {"crf": 34, "cpuUsed": 4},
    "vp8": {"crf": 10, "maxBitrate": "2M", "cpuUsed": 4},
    "mpeg1": {"quality": 5},
    "audioFormats": ["opus", "mp3"],
    "opusBitrate": "64k",
    "mp3Bitrate": "96k",
    "normalizeAudio": True,
    "thumbWidth": 320,
    "player": {"autoResyncMs": 500, "avOffsetMs": 0, "bufferSegments": 3},
    "hotspot": {"ssid": "CanvasPlayer", "password": "change-me-please", "country": "US"},
}

# Disk space one hour of video can take while it converts (the encoded
# intermediates plus the finished segments), per track at 480p. Measured
# worst cases are about half of this; the rest is margin.
CONVERT_BYTES_PER_HOUR = {"h264": 1.8e9, "vp9": 1.8e9, "vp8": 3.0e9, "mpeg1": 4.6e9}
AUDIO_BYTES_PER_HOUR = 0.15e9
SPACE_RESERVE = 300 * 1000 * 1000  # never fill the card completely

KEEP_PREVIOUS_BUILD_HOURS = 6  # a toy may still be playing the build before a rebuild
REMOVED_GRACE_MINUTES = 10     # a removed video's files stay this long (it may be playing)

AUDIO_FORMATS = {
    "opus": {"file": "audio.opus", "mime": "audio/ogg; codecs=opus"},
    "mp3": {"file": "audio.mp3", "mime": "audio/mpeg"},
}


def log(msg=""):
    print(msg, flush=True)


# ---------------------------------------------------------------- config ---

def deep_merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path):
    cfg = DEFAULT_CONFIG
    if path and os.path.exists(path):
        with open(path) as f:
            cfg = deep_merge(DEFAULT_CONFIG, json.load(f))
    bad = [t for t in cfg["videoTracks"] if t not in TRACK_KINDS]
    if bad or not cfg["videoTracks"]:
        raise SystemExit("config: videoTracks must be a non-empty list of %s" % (TRACK_KINDS,))
    bad = [a for a in cfg["audioFormats"] if a not in AUDIO_FORMATS]
    if bad or not cfg["audioFormats"]:
        raise SystemExit("config: audioFormats must be a non-empty list of %s" % (tuple(AUDIO_FORMATS),))
    return cfg


def prep_key(cfg):
    """Hash of every setting that changes the encoded output."""
    relevant = {k: v for k, v in cfg.items() if k not in ("player", "hotspot", "remote", "add")}
    relevant["_v"] = PREP_VERSION
    return hashlib.sha1(json.dumps(relevant, sort_keys=True).encode()).hexdigest()[:12]


# --------------------------------------------------------------- helpers ---

def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def clean_title(stem):
    # "Peppa_Pig.S01E01" style names use dots/underscores as spaces; a name
    # that already has spaces keeps them ("Mr. Men", added from YouTube)
    words = re.sub(r"[\[\(\{][^\]\)\}]*[\]\)\}]", "", stem).strip()
    t = stem if " " in words else re.sub(r"[._]+", " ", stem)
    # drop release-style tags like [1080p], (x264), {WEB-DL}
    t = re.sub(r"[\[\(\{][^\]\)\}]*\b(\d{3,4}p|x26[45]|h\.?26[45]|hevc|web|dl|rip|bluray|aac|ac3|uhd|hdr)\b[^\]\)\}]*[\]\)\}]",
               "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -")
    return t or stem


def item_id(rel_path):
    # surrogateescape: names that are not valid UTF-8 (old zips, USB sticks)
    return hashlib.sha1(rel_path.replace(os.sep, "/").encode("utf-8", "surrogateescape")).hexdigest()[:10]


def readable(name):
    """A file name made safe for titles and logs (invalid bytes become U+FFFD)."""
    return name.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def parse_rate(s):
    try:
        num, den = s.split("/")
        r = Fraction(int(num), int(den))
        return r if r > 0 else None
    except (ValueError, ZeroDivisionError, AttributeError):
        return None


def choose_fps(src, max_fps):
    allowed = [a for a in ALLOWED_FPS if a <= Fraction(max_fps) * Fraction(1001, 1000)] or [ALLOWED_FPS[0]]
    top = max(allowed)

    def match(x):
        # 30 and 29.97 are only 0.1% apart, so take the closest, not the first
        a = min(allowed, key=lambda a: abs(a - x))
        return a if abs(a - x) / a < Fraction(5, 10000) else None

    if src is None:
        return top
    if src > top * Fraction(1002, 1000):
        for d in (2, 3, 4, 5):  # 50->25, 59.94->29.97, 60->30, 120->30 ...
            if match(src / d):
                return match(src / d)
        return top
    if match(src):
        return match(src)
    for k in (2, 3, 4, 5):  # 15->30, 12.5->25, 10->30: duplicate frames evenly
        if match(src * k):
            return match(src * k)
    return min(allowed, key=lambda a: abs(a - src))


def run(cmd, **kw):
    # ffmpeg/ffprobe print UTF-8 whatever the OS code page is (Windows)
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace", **kw)


def probe(path):
    p = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
    if p.returncode != 0:
        raise RuntimeError("ffprobe failed: %s" % p.stderr.strip()[-500:])
    return json.loads(p.stdout)


def source_duration(info, path):
    """Duration in seconds, also for files without a duration header
    (streamed WebM, some TS recordings)."""
    def pos(x):
        try:
            v = float(x)
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    d = pos(info.get("format", {}).get("duration"))
    if d:
        return d
    found = []
    for st in info.get("streams", []):
        found.append(pos(st.get("duration")))
        tags = st.get("tags") or {}
        m = re.match(r"(\d+):(\d+):([\d.]+)", tags.get("DURATION") or tags.get("duration") or "")
        if m:
            found.append(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)))
    found = [x for x in found if x]
    if found:
        return max(found)
    try:  # last resort: read packet timestamps (no decoding)
        import av
        end = 0.0
        with av.open(path) as c:
            for pkt in c.demux():
                if pkt.pts is not None and pkt.time_base is not None:
                    end = max(end, float((pkt.pts + (pkt.duration or 0)) * pkt.time_base))
        return (end - (pos(info.get("format", {}).get("start_time")) or 0.0)) or None
    except Exception:
        return None


def media_duration(path):
    try:
        return float(probe(path)["format"]["duration"])
    except (KeyError, ValueError, RuntimeError):
        return None


def check_tools():
    missing = [t for t in ("ffmpeg", "ffprobe") if not shutil.which(t)]
    if missing:
        raise SystemExit("missing %s - install FFmpeg first" % ", ".join(missing))
    try:
        import av  # noqa: F401
    except ImportError:
        raise SystemExit("missing PyAV - install python3-av (apt) or `pip install av`")


# -------------------------------------------------------------- encoding ---

def video_codec_args(kind, cfg, gop):
    g = ["-g", str(gop), "-keyint_min", str(gop)]
    if kind == "h264":
        c = cfg["h264"]
        return ["-c:v", "libx264", "-profile:v", str(c["profile"]), "-preset", str(c["preset"]),
                "-crf", str(c["crf"]), "-bf", "0", "-sc_threshold", "0"] + g
    if kind == "vp9":
        c = cfg["vp9"]
        return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(c["crf"]), "-auto-alt-ref", "0",
                "-lag-in-frames", "0", "-row-mt", "1", "-deadline", "good",
                "-cpu-used", str(c["cpuUsed"])] + g
    if kind == "vp8":
        c = cfg["vp8"]
        return ["-c:v", "libvpx", "-b:v", str(c["maxBitrate"]), "-crf", str(c["crf"]),
                "-auto-alt-ref", "0", "-lag-in-frames", "0", "-deadline", "good",
                "-cpu-used", str(c["cpuUsed"])] + g
    if kind == "mpeg1":
        return ["-c:v", "mpeg1video", "-q:v", str(cfg["mpeg1"]["quality"]), "-bf", "0"] + g
    raise ValueError(kind)


def build_ffmpeg_cmd(src, info, cfg, fps, tmp, duration):
    """One ffmpeg run decodes the source once and writes every video track
    plus every audio format, all aligned to start at t=0."""
    streams = info.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"
                and not s.get("disposition", {}).get("attached_pic")]
    astreams = [s for s in streams if s.get("codec_type") == "audio"]
    if not vstreams:
        raise RuntimeError("no video stream")
    vi = vstreams[0]["index"]

    # ffmpeg shifts every stream by the file's earliest start time, which can
    # be an audio stream starting early (AAC priming shows up as -21 ms). The
    # fps filter would then round the video by up to a frame. Instead put t=0
    # exactly on the first video frame, for video and audio alike.
    def start(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return 0.0
    offset = start(vstreams[0].get("start_time")) - start(info.get("format", {}).get("start_time"))
    shift = "PTS-%.6f/TB" % offset

    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats", "-i", src]
    if astreams:
        amap = "0:%d" % astreams[0]["index"]
    else:
        # Silent track: the audio element is the player's clock, so every
        # item needs one.
        if not duration:
            raise RuntimeError("cannot tell how long this video is")
        cmd += ["-f", "lavfi", "-t", "%.3f" % duration, "-i", "anullsrc=r=48000:cl=stereo"]
        amap = "1:a"

    h = int(cfg["height"])
    tracks = cfg["videoTracks"]
    fps_s = "%d/%d" % (fps.numerator, fps.denominator)
    chain = ("[0:%d]setpts=%s,yadif=deint=interlaced,"
             "scale=w='trunc(min(ih\\,%d)*dar/2)*2':h='trunc(min(ih\\,%d)/2)*2':flags=bicubic,"
             "setsar=1,fps=fps=%s:start_time=0,format=yuv420p" % (vi, shift, h, h, fps_s))
    labels = ["v%d" % i for i in range(len(tracks))]
    if len(tracks) > 1:
        chain += ",split=%d%s" % (len(tracks), "".join("[%s]" % l for l in labels))
    else:
        chain += "[%s]" % labels[0]
    cmd += ["-filter_complex", chain]

    gop = max(1, int(round(float(fps) * float(cfg["keyframeSeconds"]))))
    outputs = {}
    for kind, label in zip(tracks, labels):
        path = os.path.join(tmp, "%s.mkv" % kind)
        cmd += ["-map", "[%s]" % label, "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]
        cmd += video_codec_args(kind, cfg, gop)
        cmd += ["-max_muxing_queue_size", "4096", "-f", "matroska", path]
        outputs[kind] = path

    for fmt in cfg["audioFormats"]:
        rate = 48000 if fmt == "opus" else 44100
        af = ["asetpts=%s" % shift if astreams else "anull", "aresample=async=1:first_pts=0"]
        if cfg["normalizeAudio"] and astreams:
            if duration:
                # loudnorm needs 3 s of input (shorter silence turns into NaN,
                # which crashes the MP3 encoder): pad first, trim back after.
                af += ["apad=whole_dur=%.3f" % max(duration, 3.5), "loudnorm=I=-18:TP=-2:LRA=11",
                       "atrim=end=%.3f" % duration]
            else:
                af.append("loudnorm=I=-18:TP=-2:LRA=11")
        elif duration:
            af.append("apad=whole_dur=%.3f" % duration)
        af.append("aresample=%d" % rate)
        path = os.path.join(tmp, AUDIO_FORMATS[fmt]["file"])
        cmd += ["-map", amap, "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
                "-af", ",".join(af), "-ac", "2"]
        if fmt == "opus":
            cmd += ["-c:a", "libopus", "-b:a", cfg["opusBitrate"], "-f", "ogg"]
        else:
            cmd += ["-c:a", "libmp3lame", "-b:a", cfg["mp3Bitrate"], "-f", "mp3"]
        cmd += ["-max_muxing_queue_size", "4096", path]
        outputs[fmt] = path
    return cmd, outputs


STALL_SECONDS = 900


def run_ffmpeg_with_progress(cmd, duration, label, progress=None):
    # stderr goes to a file: a damaged source can print megabytes of decode
    # errors, which would fill a pipe nobody reads and hang ffmpeg forever.
    errf = tempfile.TemporaryFile()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, encoding="utf-8", errors="replace")
    last = -1
    start = time.time()
    alive = [time.time(), False]

    def watchdog():  # kill ffmpeg if it stops making progress (stuck input)
        while p.poll() is None:
            if time.time() - alive[0] > STALL_SECONDS:
                alive[1] = True
                p.kill()
                return
            time.sleep(5)
    threading.Thread(target=watchdog, daemon=True).start()

    for line in p.stdout:
        alive[0] = time.time()
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                t = int(line.split("=", 1)[1]) / 1e6
            except ValueError:
                continue
            if duration:
                pct = int(min(99, t * 100 / duration))
                if progress:
                    progress(pct)
                if pct >= last + 10:
                    last = pct
                    speed = t / max(0.001, time.time() - start)
                    log("    %s: %3d%%  (%.1fx realtime)" % (label, pct, speed))
    p.wait()
    errf.seek(0)
    err = errf.read().decode("utf-8", "replace")
    errf.close()
    if alive[1]:
        raise RuntimeError("ffmpeg made no progress for %d minutes and was stopped" % (STALL_SECONDS // 60))
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed:\n%s" % err.strip()[-2000:])


def make_thumb(video_path, duration, width, out_path):
    t = max(0.0, (duration or 0) * 0.10)
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", "%.3f" % t,
           "-i", video_path, "-frames:v", "1", "-vf", "scale=%d:-2" % width, "-q:v", "4", out_path]
    p = run(cmd)
    if p.returncode != 0 or not os.path.exists(out_path):
        # very short clips: fall back to the first frame
        p = run(cmd[:7] + ["0"] + cmd[8:])
        if p.returncode != 0:
            raise RuntimeError("thumbnail failed: %s" % p.stderr.strip()[-500:])


class NoSpace(Exception):
    """Not enough free space to convert this video now (retried every run)."""


class Gone(Exception):
    """The source file was removed while it was converting."""


def space_needed(cfg, duration, size):
    """Bytes a conversion may need while it runs, with a margin."""
    if not duration:  # unknown length: guess from the file size
        return 2 * size + SPACE_RESERVE
    scale = max(0.25, (float(cfg["height"]) / 480) ** 2)
    per_hour = AUDIO_BYTES_PER_HOUR + scale * sum(CONVERT_BYTES_PER_HOUR.get(k, 4e9) for k in cfg["videoTracks"])
    return int(per_hour * duration / 3600) + SPACE_RESERVE


def gb(n):
    return "%.1f GB" % (n / 1e9)


def build_item(src, rel, category, out_dir, cfg, key, mtime, size, progress=None):
    """Encodes one video into out_dir/<stamp>/... plus out_dir/manifest.json.

    Every build gets its own <stamp> folder, so a toy that is still playing
    the previous build keeps reading the previous files (same URLs would
    otherwise mix old and new encodings). The previous build is kept next to
    the new one for a few hours (see remove_old_builds); older ones go now.
    """
    iid = os.path.basename(out_dir)
    media_dir = os.path.dirname(out_dir)
    tmp = os.path.join(media_dir, ".tmp-" + iid)
    stamp = hashlib.sha1(("%s|%s|%s|%s" % (key, mtime, size, time.time())).encode()).hexdigest()[:8]
    vdir = os.path.join(tmp, stamp)
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(vdir)
    try:
        info = probe(src)
        vstreams = [s for s in info.get("streams", []) if s.get("codec_type") == "video"
                    and not s.get("disposition", {}).get("attached_pic")]
        if not vstreams:
            raise RuntimeError("no video stream (audio-only files are not supported)")
        src_fps = parse_rate(vstreams[0].get("avg_frame_rate")) or parse_rate(vstreams[0].get("r_frame_rate"))
        fps = choose_fps(src_fps, cfg["maxFps"])
        duration = source_duration(info, src)
        need, free = space_needed(cfg, duration, size), shutil.disk_usage(media_dir).free
        if free < need:
            raise NoSpace("not enough free space on the Pi: converting this video needs about %s, %s is free"
                          % (gb(need), gb(free)))

        cmd, outputs = build_ffmpeg_cmd(src, info, cfg, fps, vdir, duration)
        log("    encoding %s @ %s fps -> %s + %s" % (
            "x".join(str(x) for x in (vstreams[0].get("width"), vstreams[0].get("height"))),
            "%.3f" % float(fps), "+".join(cfg["videoTracks"]), "+".join(cfg["audioFormats"])))
        run_ffmpeg_with_progress(cmd, duration, "encode", progress)

        tracks = []
        for kind in cfg["videoTracks"]:
            track = cvs.packetize(outputs[kind], os.path.join(vdir, kind), kind, fps,
                                  float(cfg["segmentSeconds"]), log=log)
            track["dir"] = "%s/%s" % (stamp, kind)
            tracks.append(track)

        audio = []
        for fmt in cfg["audioFormats"]:
            a = AUDIO_FORMATS[fmt]
            audio.append({"format": fmt, "src": "%s/%s" % (stamp, a["file"]), "mime": a["mime"],
                          "duration": media_duration(outputs[fmt])})

        vdur = tracks[0]["duration"]
        make_thumb(outputs[cfg["videoTracks"][0]], vdur, int(cfg["thumbWidth"]), os.path.join(vdir, "thumb.jpg"))
        for kind in cfg["videoTracks"]:
            os.remove(outputs[kind])

        manifest = {
            "format": 1,
            "id": iid,
            "title": clean_title(readable(os.path.splitext(os.path.basename(rel))[0])),
            "category": readable(category),
            "sort": readable(rel.replace(os.sep, "/")),
            "duration": vdur,
            "v": stamp,
            "audio": audio,
            "tracks": tracks,
            "thumb": "%s/thumb.jpg" % stamp,
            "live": False,
            "source": {"path": readable(rel.replace(os.sep, "/")), "mtime": mtime, "size": size},
            "prepKey": key,
            "built": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        with open(os.path.join(tmp, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=1)

        if not os.path.exists(src):  # removed on the add-videos page meanwhile
            raise Gone()
        # Keep the build a toy may be playing right now, then swap.
        if os.path.isdir(out_dir):
            prev = read_manifest(os.path.join(out_dir, "manifest.json"))
            pv = prev and prev.get("v")
            if pv and pv != stamp and os.path.isdir(os.path.join(out_dir, pv)):
                os.rename(os.path.join(out_dir, pv), os.path.join(tmp, pv))
        old = os.path.join(media_dir, ".old-" + iid)
        shutil.rmtree(old, ignore_errors=True)
        if os.path.exists(out_dir):
            os.rename(out_dir, old)
        os.rename(tmp, out_dir)
        shutil.rmtree(old, ignore_errors=True)
        return manifest
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


# -------------------------------------------------------------- library ----

def scan_sources(source_dir):
    """Yields (abs_path, rel_path, category)."""
    found = []
    for dirpath, dirnames, filenames in os.walk(source_dir, followlinks=True):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        rel_dir = os.path.relpath(dirpath, source_dir)
        category = "Videos" if rel_dir == "." else rel_dir.split(os.sep)[0]
        for fn in filenames:
            if fn.startswith(".") or os.path.splitext(fn)[1].lower() not in VIDEO_EXTS:
                continue
            path = os.path.join(dirpath, fn)
            found.append((path, os.path.relpath(path, source_dir), category))
    found.sort(key=lambda x: natural_key(x[1]))
    return found


def read_manifest(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, data):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def remove_old_builds(media_dir, now):
    """Delete the previous build of rebuilt videos once no toy can still be
    playing it, and the files of videos removed on the add-videos page."""
    for d in os.listdir(media_dir):
        item = os.path.join(media_dir, d)
        if d.startswith(".") or not os.path.isdir(item):
            continue
        marker = os.path.join(item, REMOVED)
        try:
            if now - os.stat(marker).st_mtime > REMOVED_GRACE_MINUTES * 60:
                log("removing %s (removed on the add-videos page)" % d)
                shutil.rmtree(item, ignore_errors=True)
            continue
        except OSError:
            pass
        mpath = os.path.join(item, "manifest.json")
        m = read_manifest(mpath)
        try:
            # a clock that jumped back makes the age negative: keep
            if not m or now - os.stat(mpath).st_mtime < KEEP_PREVIOUS_BUILD_HOURS * 3600:
                continue
        except OSError:
            continue
        for sub in os.listdir(item):
            if sub != m.get("v") and re.match(r"^[0-9a-f]{8}$", sub) and os.path.isdir(os.path.join(item, sub)):
                shutil.rmtree(os.path.join(item, sub), ignore_errors=True)


class Status:
    """STATE/prep-status.json: what prep is doing, for the add-videos page.

    It also remembers which files failed, so a broken file is not converted
    again every 15 minutes: it is tried again when it changes, or with --force.
    """

    def __init__(self, state_dir, key):
        self.path = os.path.join(state_dir, "prep-status.json") if state_dir else None
        self.key = key
        self.last = 0.0
        old = (read_manifest(self.path) if self.path else None) or {}
        self.data = {"running": True, "pid": os.getpid(), "current": None, "pending": [],
                     "failed": old.get("failed") if isinstance(old.get("failed"), dict) else {}}

    def known_failure(self, rel, mtime, size):
        f = self.data["failed"].get(rel)
        return bool(f and not f.get("retry") and f.get("key") == self.key
                    and f.get("mtime") == mtime and f.get("size") == size)

    def fail(self, rel, mtime, size, error, retry=False):
        self.data["failed"][rel] = {"mtime": mtime, "size": size, "key": self.key, "retry": retry,
                                    "error": str(error).strip()[-600:],
                                    "at": datetime.datetime.now().isoformat(timespec="seconds")}

    def forget(self, keep=None, rel=None):
        if rel is not None:
            self.data["failed"].pop(rel, None)
        if keep is not None:  # files that no longer exist
            for r in [r for r in self.data["failed"] if r not in keep]:
                del self.data["failed"][r]

    def set(self, force=True, **kw):
        self.data.update(kw)
        if self.path and (force or time.time() - self.last >= 2):
            self.last = time.time()
            self.data["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
            try:
                write_json(self.path, self.data)
            except OSError as e:
                log("could not write %s: %s" % (self.path, e))


REMOVED = ".removed"  # marker file in an item folder: removed on the add-videos page


def build_catalog(media_dir, cfg):
    # The add-videos page rebuilds the catalog too (after a removal), so one
    # writer at a time; whoever writes last saw the newest state.
    with Lock(os.path.join(media_dir, ".catalog.lock")):
        return _build_catalog(media_dir, cfg)


def _build_catalog(media_dir, cfg):
    cats = {}
    for d in os.listdir(media_dir):
        if d.startswith(".") or os.path.exists(os.path.join(media_dir, d, REMOVED)):
            continue
        m = read_manifest(os.path.join(media_dir, d, "manifest.json"))
        if not m:
            continue
        v = m.get("v", "")
        item = {
            "id": m["id"],
            "title": m["title"],
            "duration": m["duration"],
            "thumb": "media/%s/%s?v=%s" % (m["id"], m["thumb"], v),
            "manifest": "media/%s/manifest.json?v=%s" % (m["id"], v),
        }
        cats.setdefault(m["category"], []).append((natural_key(m.get("sort", m["title"])), item))
    catalog = {
        "format": 1,
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "player": cfg["player"],
        "categories": [{"name": name, "items": [i for _, i in sorted(cats[name], key=lambda x: x[0])]}
                       for name in sorted(cats, key=natural_key)],
    }
    tmp = os.path.join(media_dir, ".catalog.json.%d.tmp" % os.getpid())
    with open(tmp, "w") as f:
        json.dump(catalog, f, indent=1)
    os.replace(tmp, os.path.join(media_dir, "catalog.json"))
    return catalog


class Busy(Exception):
    pass


class Lock:
    def __init__(self, path, wait=True, say=None):
        self.path = path
        self.wait = wait
        self.say = say
        self.f = None

    def __enter__(self):
        try:
            import fcntl
        except ImportError:  # Windows: no locking
            return self
        self.f = open(self.path, "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if not self.wait:
                self.f.close()
                raise Busy()
            if self.say:
                log(self.say)
            fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        if self.f:
            self.f.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", help="install root (default %s if it exists, else the repo)" % DEFAULT_ROOT)
    ap.add_argument("--source", help="folder of source videos (default ROOT/source)")
    ap.add_argument("--media", help="output folder (default ROOT/site/media)")
    ap.add_argument("--config", help="config.json (default ROOT/config.json, else the repo's)")
    ap.add_argument("--force", action="store_true", help="rebuild everything")
    ap.add_argument("--only", help="only (re)build items whose relative path matches this glob")
    ap.add_argument("--prune", action="store_true", help="delete media whose source file no longer exists")
    ap.add_argument("--catalog-only", action="store_true", help="only rebuild catalog.json")
    ap.add_argument("--no-wait", action="store_true", help="exit instead of waiting when another prep is running")
    ap.add_argument("--settle", type=int, default=60,
                    help="skip files modified in the last N seconds (still copying). Default 60")
    ap.add_argument("--state", help="folder for prep-status.json (default ROOT/state when ROOT is an install)")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # never crash on printing an odd file name
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")

    root = args.root or (DEFAULT_ROOT if os.path.isdir(DEFAULT_ROOT) else REPO_DIR)
    source_dir = os.path.abspath(args.source or os.path.join(root, "source"))
    media_dir = os.path.abspath(args.media or os.path.join(root, "site", "media"))
    config_path = args.config or os.path.join(root, "config.json")
    if not os.path.exists(config_path):
        config_path = os.path.join(REPO_DIR, "config.json")
    cfg = load_config(config_path)
    key = prep_key(cfg)
    os.makedirs(media_dir, exist_ok=True)
    state_dir = args.state
    if state_dir is None and (args.root or root == DEFAULT_ROOT):
        state_dir = os.path.join(root, "state")
    if state_dir:
        os.makedirs(state_dir, exist_ok=True)

    try:
        with Lock(os.path.join(media_dir, ".prep.lock"), wait=not args.no_wait,
                  say="another prep is running; waiting for it to finish..."):
            return run_prep(args, cfg, key, source_dir, media_dir, config_path, state_dir)
    except Busy:
        log("a conversion is running right now; the library list updates when it finishes")
        return 0


def run_prep(args, cfg, key, source_dir, media_dir, config_path, state_dir=None):
    if args.catalog_only:
        cat = build_catalog(media_dir, cfg)
        log("catalog: %d categories, %d items" % (len(cat["categories"]),
                                                  sum(len(c["items"]) for c in cat["categories"])))
        return 0

    check_tools()
    log("source: %s\nmedia:  %s\nconfig: %s (key %s)" % (source_dir, media_dir, config_path, key))
    if not os.path.isdir(source_dir):
        raise SystemExit("source folder %s does not exist" % source_dir)
    for d in os.listdir(media_dir):  # leftovers from an interrupted run
        if d.startswith(".tmp-") or d.startswith(".old-"):
            shutil.rmtree(os.path.join(media_dir, d), ignore_errors=True)
    remove_old_builds(media_dir, time.time())

    status = Status(state_dir, key)
    status.set()
    try:
        return prep_loop(args, cfg, key, source_dir, media_dir, status)
    finally:
        status.set(running=False, current=None, pending=[])


def prep_loop(args, cfg, key, source_dir, media_dir, status):
    built = skipped = failed = waiting = earlier = 0
    failures = []
    decided = {}   # rel -> (mtime, size): skipped, built or failed in this run
    pending = {}   # rel -> (mtime, size, path, category, iid)
    settling = set()
    redo = args.force or args.only
    while True:
        # Scan again after every video: files that arrive meanwhile (from the
        # add-videos page) join this run, and the newest file goes first.
        sources = scan_sources(source_dir)
        present = set()
        now = time.time()
        for path, rel, category in sources:
            if args.only and not fnmatch.fnmatch(rel.replace(os.sep, "/"), args.only):
                continue
            name = readable(rel.replace(os.sep, "/"))
            present.add(rel)
            try:
                st = os.stat(path)  # can vanish mid-run, or be a dangling link
                iid = item_id(rel)
            except (OSError, ValueError) as e:
                if decided.get(rel) != "error":
                    decided[rel] = "error"
                    failed += 1
                    failures.append(name)
                    log("%s: FAILED: %s" % (name, e))
                continue
            mtime, size = int(st.st_mtime), st.st_size
            if decided.get(rel) == (mtime, size) or pending.get(rel, ())[:2] == (mtime, size):
                continue
            out_dir = os.path.join(media_dir, iid)
            m = read_manifest(os.path.join(out_dir, "manifest.json"))
            fresh = (m and m.get("prepKey") == key and m.get("source", {}).get("mtime") == mtime
                     and m.get("source", {}).get("size") == size
                     and not os.path.exists(os.path.join(out_dir, REMOVED)))
            if fresh and not redo:
                decided[rel] = (mtime, size)
                skipped += 1
                continue
            if now - st.st_mtime < args.settle:
                if rel not in settling:
                    settling.add(rel)
                    waiting += 1
                    log("%s: modified %ds ago, maybe still copying - will pick it up next run"
                        % (name, now - st.st_mtime))
                continue
            if status.known_failure(name, mtime, size) and not redo:
                decided[rel] = (mtime, size)
                earlier += 1
                continue
            pending[rel] = (mtime, size, path, category, iid)
        for rel in [r for r in pending if r not in present]:
            del pending[rel]  # removed before its turn
        if not pending:
            break

        rel = max(pending, key=lambda r: (pending[r][0], r))
        mtime, size, path, category, iid = pending.pop(rel)
        decided[rel] = (mtime, size)
        settling.discard(rel)
        name = readable(rel.replace(os.sep, "/"))
        n = built + failed + 1
        log("[%d/%d] %s  (%s, id %s)" % (n, n + len(pending), name, readable(category), iid))
        status.set(current={"path": name, "id": iid, "pct": 0},
                   pending=[readable(r.replace(os.sep, "/"))
                            for r in sorted(pending, key=lambda r: -pending[r][0])])

        def progress(pct, name=name, iid=iid):
            status.set(force=False, current={"path": name, "id": iid, "pct": pct})

        t0 = time.time()
        try:
            build_item(path, rel, category, os.path.join(media_dir, iid), cfg, key, mtime, size, progress)
            built += 1
            status.forget(rel=name)
            log("    done in %.0fs" % (time.time() - t0))
            build_catalog(media_dir, cfg)  # new items appear as soon as they are ready
        except KeyboardInterrupt:
            log("interrupted")
            build_catalog(media_dir, cfg)
            return 130
        except Gone:
            log("    removed while converting; discarded")
        except NoSpace as e:  # tried again next run, maybe after videos were removed
            failed += 1
            failures.append(name)
            status.fail(name, mtime, size, e, retry=True)
            log("    FAILED: %s" % e)
        except Exception as e:  # keep going with the rest of the library
            failed += 1
            failures.append(name)
            status.fail(name, mtime, size, e)
            log("    FAILED: %s" % e)
        status.set(current=None)

    if not args.only:
        status.forget(keep={readable(r.replace(os.sep, "/")) for _, r, _ in sources})
    if args.prune:
        if not sources:
            log("prune: source folder is empty - refusing to prune everything")
        else:
            wanted = {item_id(rel) for _, rel, _ in sources}
            for d in sorted(os.listdir(media_dir)):
                if d.startswith(".") or d in wanted or not os.path.isdir(os.path.join(media_dir, d)):
                    continue
                m = read_manifest(os.path.join(media_dir, d, "manifest.json"))
                if m is not None:
                    log("prune: removing %s (%s)" % (d, m.get("source", {}).get("path")))
                    shutil.rmtree(os.path.join(media_dir, d))

    cat = build_catalog(media_dir, cfg)
    total = sum(len(c["items"]) for c in cat["categories"])
    log("built %d, unchanged %d, failed %d, waiting %d. Library: %d items in %d categories."
        % (built, skipped, failed, waiting, total, len(cat["categories"])))
    for f in failures:
        log("  failed: %s" % f)
    if earlier:
        log("  %d file(s) failed in an earlier run and did not change since (prep --force tries again)" % earlier)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
