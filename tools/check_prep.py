#!/usr/bin/env python3
"""Verify prep.py output for the synthetic clips from make_test_media.py.

For every item whose title matches --title (default: all items with the
frame-counter pattern) it:
  * decodes every CVS1 segment of every track with PyAV and reads the frame
    number drawn in the picture -> frame k must show source frame k*ratio
  * finds the 1 kHz beeps in each audio file -> must start on whole seconds
    (or +0.5 s for the "Late Audio" clip)

    tools/check_prep.py MEDIA_DIR
"""

import glob
import json
import os
import subprocess
import sys

import av
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "prep"))
import cvs  # noqa: E402

CODECS = {"h264": "h264", "mpeg1": "mpeg1video", "vp9": "vp9", "vp8": "vp8"}


def read_pattern(gray, scale, bits, step, size):
    n = 0
    y = int((20 + size / 2) * scale)
    for k in range(bits):
        x = int((20 + k * step + size / 2) * scale)
        if gray[y, x] > 128:
            n |= 1 << k
    return n


def decode_track(item_dir, track):
    ctx = av.CodecContext.create(CODECS[track["kind"]], "r")
    if track.get("description"):
        import base64
        ctx.extradata = base64.b64decode(track["description"])
    out = []
    for seg in track["segments"]:
        for f in cvs.read_segment(os.path.join(item_dir, track["dir"], seg["file"])):
            pkt = av.Packet(f["data"])
            pkt.pts = f["pts"]
            for frame in ctx.decode(pkt):
                out.append((f["pts"], frame.to_ndarray(format="gray")))
    for frame in ctx.decode(None):
        out.append((None, frame.to_ndarray(format="gray")))
    return out


def beep_onsets(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
                         stdout=subprocess.PIPE, check=True).stdout
    x = np.abs(np.frombuffer(raw, dtype=np.float32))
    on, last = [], -10**9
    for j in np.where(x > 0.05)[0]:
        if j - last > 24000:
            on.append(j / 48000.0)
        last = j
    return on


def main():
    media = sys.argv[1]
    ok = True
    for mf in sorted(glob.glob(os.path.join(media, "*", "manifest.json"))):
        m = json.load(open(mf))
        d = os.path.dirname(mf)
        if "Counting" in m["title"] or "Late Audio" in m["title"] or "Long Test" in m["title"]:
            long_clip = "Long Test" in m["title"]
            bits, step, size = (16, 50, 40) if long_clip else (9 if "Late" in m["title"] else 12, 60, 50)
            src_h = 480 if long_clip else (720 if "Counting" in m["title"] else 480)
            for t in m["tracks"]:
                frames = decode_track(d, t)
                scale = t["height"] / float(src_h)
                bad = [(i, read_pattern(g, scale, bits, step, size)) for i, (_, g) in enumerate(frames)
                       if read_pattern(g, scale, bits, step, size) != i % (1 << bits)]
                status = "OK" if not bad and len(frames) == t["frames"] else "FAIL"
                ok &= status == "OK"
                print("%-16s %-5s %4d frames decoded (%d expected), %d wrong frame numbers %s  %s"
                      % (m["title"][:16], t["kind"], len(frames), t["frames"], len(bad), bad[:3], status))
            expect = 0.5 if "Late Audio" in m["title"] else 0.0
            for a in m["audio"]:
                on = beep_onsets(os.path.join(d, a["src"]))
                err = max(abs((o - expect) - round(o - expect)) for o in on) * 1000
                status = "OK" if err < 2 else "FAIL"
                ok &= status == "OK"
                print("%-16s %-5s %d beeps, worst offset from expected %.1f ms  %s"
                      % (m["title"][:16], a["format"], len(on), err, status))
    print("ALL OK" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
