#!/usr/bin/env python3
"""Generate synthetic source videos for testing prep.py and the player.

The main clip draws its frame number as a row of 12 black/white blocks
(bit k set = block k white) and beeps for 50 ms at the start of every
second, so automated tests can check exactly which frame is on screen and
that audio and video line up.

    tools/make_test_media.py OUT_DIR [--long-minutes N]
"""

import argparse
import os
import subprocess
import sys

BITS = 12


def pattern_filter(bits=BITS, step=60, size=50):
    """Block k sits at x = 20 + k*step, y = 20, size x size pixels."""
    parts = ["drawbox=x=10:y=10:w=%d:h=%d:color=black:t=fill" % (20 + bits * step, size + 20)]
    for k in range(bits):
        parts.append("drawbox=x=%d:y=20:w=%d:h=%d:color=white:t=fill:enable='mod(floor(n/pow(2\\,%d))\\,2)'"
                     % (20 + k * step, size, size, k))
    return ",".join(parts)


BEEPS = "aevalsrc='if(lt(mod(t\\,1)\\,0.05)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=%s"


def ff(args):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + args
    print(" ".join(a if " " not in a else repr(a) for a in cmd[:12]), "...")
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seconds", type=int, default=90)
    ap.add_argument("--long-minutes", type=int, default=0, help="also make a long clip (memory/drift test)")
    a = ap.parse_args()
    out = a.out
    for d in ("Animals", "Shapes", "Long"):
        os.makedirs(os.path.join(out, d), exist_ok=True)

    # 1. Frame-counter clip, 720p 29.97 fps H.264 + AAC (like a normal download)
    d = a.seconds
    ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30000/1001:duration=%d" % d,
        "-f", "lavfi", "-i", BEEPS % d,
        "-vf", pattern_filter(), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", os.path.join(out, "Animals", "01_Counting_Test.mp4")])

    # 2. Audio starts 0.5 s after the video: prep must pad it back into line.
    ff(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=20",
        "-f", "lavfi", "-i", BEEPS % 20,
        "-filter_complex", "[0:v]%s[v];[1:a]adelay=500|500,atrim=end=20[a]" % pattern_filter(9),
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac",
        os.path.join(out, "Animals", "02 Late Audio (1080p WEB-DL).mkv")])

    # 3. No audio at all
    ff(["-f", "lavfi", "-i", "smptebars=size=640x360:rate=24:duration=15",
        "-c:v", "libx264", "-preset", "veryfast", os.path.join(out, "Shapes", "Silent Bars.mp4")])

    # 4. Portrait 60 fps phone video -> 270x480 @ 30
    ff(["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=60:duration=10",
        "-f", "lavfi", "-i", "sine=f=330:duration=10",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest",
        os.path.join(out, "Shapes", "Portrait_Phone.mp4")])

    # 5. Anamorphic DVD-style 720x480 with 16:9 display aspect -> 854x480
    ff(["-f", "lavfi", "-i", "testsrc=size=720x480:rate=30000/1001:duration=10",
        "-f", "lavfi", "-i", "sine=f=550:duration=10",
        "-vf", "setsar=32/27", "-c:v", "mpeg2video", "-q:v", "4", "-c:a", "mp2", "-shortest",
        os.path.join(out, "Shapes", "Widescreen DVD.mpg")])

    # 6. A file directly in the root -> category "Videos"
    ff(["-f", "lavfi", "-i", "mandelbrot=size=640x360:rate=25", "-t", "8",
        "-f", "lavfi", "-i", "sine=f=220:duration=8",
        "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest",
        os.path.join(out, "Mandelbrot Zoom.mp4")])

    if a.long_minutes:
        d = a.long_minutes * 60
        ff(["-f", "lavfi", "-i", "testsrc2=size=854x480:rate=30:duration=%d" % d,
            "-f", "lavfi", "-i", BEEPS % d,
            "-vf", pattern_filter(16, 50, 40), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
            "-c:a", "aac", "-shortest", os.path.join(out, "Long", "Long Test.mp4")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
