"""CVS1 segment format: a tiny container for already-encoded video frames.

Layout (little-endian):

    magic        4 bytes  "CVS1"
    version      u8       1
    reserved     u8 x3
    frameCount   u32
    index        frameCount x { pts_us: u64, dur_us: u32, flags: u8 (bit0 = key), size: u32 }
    payload      concatenated frame bytes, in index order

Every segment starts on a keyframe and frames are stored in presentation
order (the encoders are configured without B-frames, so decode order equals
presentation order).

`Segmenter` accepts frames one at a time and cuts a new segment at the first
keyframe at or after each segment boundary. It works the same for a finished
file (prep.py) and for a growing live stream (a future live.py).
"""

import base64
import os
import struct
from fractions import Fraction

MAGIC = b"CVS1"
VERSION = 1
HEADER = struct.Struct("<4sB3xI")   # 12 bytes
ENTRY = struct.Struct("<QIBI")      # 17 bytes, no padding

MPEG1_SEQ_HEADER = b"\x00\x00\x01\xb3"


def write_segment(path, frames):
    """frames: list of (pts_us, dur_us, key, data). Returns bytes written."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(HEADER.pack(MAGIC, VERSION, len(frames)))
        for pts, dur, key, data in frames:
            f.write(ENTRY.pack(pts, dur, 1 if key else 0, len(data)))
        for _pts, _dur, _key, data in frames:
            f.write(data)
        size = f.tell()
    os.replace(tmp, path)
    return size


def read_segment(path):
    """Returns a list of dicts {pts, dur, key, data}. Used by tests and tools."""
    with open(path, "rb") as f:
        buf = f.read()
    magic, version, count = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or version != VERSION:
        raise ValueError("%s: not a CVS1 segment" % path)
    out = []
    off = HEADER.size + count * ENTRY.size
    for i in range(count):
        pts, dur, flags, size = ENTRY.unpack_from(buf, HEADER.size + i * ENTRY.size)
        out.append({"pts": pts, "dur": dur, "key": bool(flags & 1), "data": buf[off:off + size]})
        off += size
    if off != len(buf):
        raise ValueError("%s: payload size mismatch" % path)
    return out


def seg_name(i):
    return "seg_%05d.bin" % i


class Segmenter:
    """Groups frames into keyframe-aligned segments of ~seg_seconds each."""

    def __init__(self, out_dir, seg_seconds, on_segment=None):
        self.out_dir = out_dir
        self.seg_us = int(seg_seconds * 1_000_000)
        self.on_segment = on_segment
        self.pending = []
        self.segments = []

    def add(self, pts_us, dur_us, key, data):
        if not self.pending and not key:
            raise ValueError("segment must start with a keyframe (pts %d)" % pts_us)
        boundary = (len(self.segments) + 1) * self.seg_us
        if key and self.pending and pts_us >= boundary - 1000:
            self._flush()
        self.pending.append((pts_us, dur_us, key, data))

    def finish(self):
        if self.pending:
            self._flush()
        return self.segments

    def _flush(self):
        i = len(self.segments)
        name = seg_name(i)
        size = write_segment(os.path.join(self.out_dir, name), self.pending)
        first, last = self.pending[0], self.pending[-1]
        seg = {
            "i": i,
            "start": round(first[0] / 1e6, 6),
            "dur": round((last[0] + last[1] - first[0]) / 1e6, 6),
            "file": name,
            "bytes": size,
            "frames": len(self.pending),
        }
        self.segments.append(seg)
        self.pending = []
        if self.on_segment:
            self.on_segment(seg)


def h264_codec_string(avcc):
    if not avcc or avcc[0] != 1 or len(avcc) < 4:
        raise ValueError("H.264 extradata is not avcC")
    return "avc1.%02X%02X%02X" % (avcc[1], avcc[2], avcc[3])


def vp9_codec_string(width, height, fps):
    # Pick the lowest VP9 level that fits the picture size and sample rate.
    levels = [(10, 36864, 829440), (11, 73728, 2764800), (20, 122880, 4608000),
              (21, 245760, 9216000), (30, 552960, 20736000), (31, 983040, 36864000),
              (40, 2228224, 83558400), (41, 2228224, 160432128)]
    pic = width * height
    rate = pic * float(fps)
    for lvl, max_pic, max_rate in levels:
        if pic <= max_pic and rate <= max_rate:
            return "vp09.00.%02d.08" % lvl
    return "vp09.00.41.08"


def _packet_bytes(pkt):
    return pkt.to_bytes() if hasattr(pkt, "to_bytes") else bytes(pkt)


def packetize(src_path, out_dir, kind, fps, seg_seconds, log=print):
    """Reads one encoded video stream from src_path (Matroska) and writes CVS1
    segments into out_dir. Returns the track dict for manifest.json.

    kind: "h264" | "vp9" | "vp8" | "mpeg1"
    fps:  Fraction, the constant output frame rate the encoder was given.
    """
    import av  # imported lazily so `--help` works without PyAV

    fps = Fraction(fps)
    os.makedirs(out_dir, exist_ok=True)
    seg = Segmenter(out_dir, seg_seconds)

    with av.open(src_path) as container:
        stream = container.streams.video[0]
        cc = stream.codec_context
        width, height = cc.width, cc.height
        extradata = bytes(cc.extradata) if cc.extradata else b""
        tb = stream.time_base

        n = 0
        worst_skew = 0.0
        for pkt in container.demux(stream):
            if pkt.size == 0:
                continue
            data = _packet_bytes(pkt)
            key = bool(pkt.is_keyframe)
            if kind == "mpeg1" and key and not data.startswith(MPEG1_SEQ_HEADER):
                # Every MPEG-1 keyframe must carry the sequence header so the
                # decoder can start (or restart after a seek) from it.
                if not extradata.startswith(MPEG1_SEQ_HEADER):
                    raise ValueError("MPEG-1 keyframe without sequence header")
                data = extradata + data
            # Constant frame rate and no B-frames: frame n is shown at n/fps.
            # Computing it from n avoids the 1 ms rounding of Matroska times.
            pts_us = int(round(n * 1_000_000 / fps))
            next_us = int(round((n + 1) * 1_000_000 / fps))
            if pkt.pts is not None and tb is not None:
                worst_skew = max(worst_skew, abs(float(pkt.pts * tb) - pts_us / 1e6))
            seg.add(pts_us, next_us - pts_us, key, data)
            n += 1
        segments = seg.finish()

    if n == 0:
        raise ValueError("no video frames in %s" % src_path)
    if worst_skew > 0.05:
        log("  warning: container timestamps drift %.3fs from constant %s fps" % (worst_skew, fps))

    if kind == "h264":
        codec = h264_codec_string(extradata)
        description = base64.b64encode(extradata).decode("ascii")
        backend = "webcodecs"
    elif kind == "vp9":
        codec, description, backend = vp9_codec_string(width, height, fps), None, "webcodecs"
    elif kind == "vp8":
        codec, description, backend = "vp8", None, "webcodecs"
    elif kind == "mpeg1":
        codec, description, backend = "mpeg1video", None, "mpeg1"
    else:
        raise ValueError("unknown track kind %r" % kind)

    return {
        "kind": kind,
        "backend": backend,
        "codec": codec,
        "description": description,
        "width": width,
        "height": height,
        "fps": float(fps),
        "fpsFraction": "%d/%d" % (fps.numerator, fps.denominator),
        "frames": n,
        "duration": round(n / float(fps), 6),
        "segmentDuration": seg_seconds,
        "segments": segments,
    }
