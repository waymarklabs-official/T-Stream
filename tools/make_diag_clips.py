#!/usr/bin/env python3
"""Build the short test clips used by site/diag.html.

Each clip is a normal prep.py item (manifest + CVS1 segments + audio), so the
diagnostics page exercises exactly the code paths the player uses.

    tools/make_diag_clips.py [OUT_DIR]   (default: site/diag/clips)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "prep"))
import prep  # noqa: E402

SECONDS = 3

# name -> (height, tracks, h264 profile)
CLIPS = {
    "480": (480, ["h264", "vp9", "vp8", "mpeg1"], "main"),
    "480-baseline": (480, ["h264"], "baseline"),
    "360": (360, ["h264", "vp9", "vp8", "mpeg1"], "main"),
    "360-baseline": (360, ["h264"], "baseline"),
}


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "site", "diag", "clips"))
    tmp = tempfile.mkdtemp(prefix="diagclips-")
    try:
        # Busy, detailed picture with motion and a little noise, so decode
        # cost is close to real cartoons at the same resolution (~1 Mbit/s).
        src = os.path.join(tmp, "source.mp4")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=%d" % SECONDS,
            "-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=30",
            "-f", "lavfi", "-i", "sine=f=440:duration=%d" % SECONDS,
            "-filter_complex", "[1:v]scale=1280:720[m];[0:v][m]blend=all_mode=average,noise=alls=4:allf=t[v]",
            "-map", "[v]", "-map", "2:a", "-t", str(SECONDS),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", src], check=True)
        os.utime(src, (0, 0))

        if os.path.isdir(out):
            shutil.rmtree(out)
        os.makedirs(out)
        index = []
        for name, (height, tracks, profile) in CLIPS.items():
            cfg = prep.deep_merge(prep.DEFAULT_CONFIG, {
                "videoTracks": tracks, "height": height, "normalizeAudio": False,
                "h264": {"profile": profile, "preset": "medium", "crf": 23},
                "segmentSeconds": 10, "thumbWidth": 160,
            })
            m = prep.build_item(src, "diag/%s.mp4" % name, "diag", os.path.join(out, name), cfg,
                                prep.prep_key(cfg), 0, 0)
            for t in m["tracks"]:
                kbps = sum(s["bytes"] for s in t["segments"]) * 8 / 1000.0 / t["duration"]
                index.append({"clip": name, "manifest": "%s/manifest.json" % name, "kind": t["kind"],
                              "backend": t["backend"], "codec": t["codec"], "profile": profile if t["kind"] == "h264" else None,
                              "width": t["width"], "height": t["height"], "frames": t["frames"],
                              "kbps": round(kbps)})
                print("%-13s %-6s %-14s %dx%d %5d kbit/s" % (name, t["kind"], t["codec"], t["width"], t["height"], kbps))
        with open(os.path.join(out, "index.json"), "w") as f:
            json.dump({"clips": index}, f, indent=1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
