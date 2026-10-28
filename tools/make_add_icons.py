#!/usr/bin/env python3
"""Draws the add-videos page icons (a white "+" on a blue rounded square,
inside the maskable safe zone) as PNG, with no image library.

    tools/make_add_icons.py add/
"""
import os
import struct
import sys
import zlib


def png(size):
    bg, fg = (37, 99, 235), (255, 255, 255)
    r = size * 0.18          # corner radius (the maskable crop is a circle anyway)
    arm, half = size * 0.36, size * 0.075
    c = size / 2
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            px, py = x + 0.5, y + 0.5
            dx, dy = max(r - px, 0, px - (size - r)), max(r - py, 0, py - (size - r))
            inside = dx * dx + dy * dy <= r * r
            plus = (abs(px - c) <= half and abs(py - c) <= arm) or (abs(py - c) <= half and abs(px - c) <= arm)
            col = fg if inside and plus else bg
            row += bytes(col) + (b"\xff" if inside else b"\x00")
        rows.append(bytes(row))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + \
        chunk(b"IEND", b"")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "add"
    for s in (192, 512):
        with open(os.path.join(out, "icon-%d.png" % s), "wb") as f:
            f.write(png(s))
