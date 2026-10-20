# Design notes

## Changes from the original spec, and why

| Spec | Built | Why |
|---|---|---|
| Phase 0 picks *one* backend + codec; prep encodes only that | prep makes an **H.264 track and an MPEG-1 track** for every video; the player picks per device at runtime (`videoTracks` in config) | No round trip between diag results and re-encoding. http vs https on the same toy needs different backends anyway. You can drop a track later to save time and space. |
| jsmpeg fallback = separate MPEG-TS file, jsmpeg's own player, WebAudio sound | MPEG-1 frames go in the **same CVS1 segments**; jsmpeg is used only as a decoder + WebGL renderer; sound stays on `<audio>` | One engine (fetching, clock, seek, resync, overlay) for both backends. No `.ts` file, which servers label `video/mp2t`. No dependence on WebAudio. |
| Worker owns decoder + OffscreenCanvas; main thread sends clock every 250 ms | Engine runs on the main thread, reading `audio.currentTime` every frame (with extrapolation if it updates coarsely) | `VideoDecoder` already decodes off-thread; the page does almost nothing else during playback. Reading the clock directly is more accurate than messages, and avoids OffscreenCanvas/VideoFrame-transfer differences between Chromium versions. jsmpeg can't run in a worker without patching. |
| ES modern syntax "if supported" | Player, UI and diag are **ES5** (Promises only) | Runs on any Chromium the toy might have; no build step. |
| `autoResyncMs` default 0 (off) | default **500** | Audio is the master, so video can only fall *behind*. If the decoder can't keep up, jumping to the next keyframe is the only fix, and nobody presses Resync during a cartoon. |
| Decoder error → reset once → error card | reset once → **switch to the MPEG-1 track** mid-video → error card only if that fails too. Plus a **stall watchdog** (decoder with data but no pictures for 4 s of media time) | Unknown toy hardware decoders sometimes hang without an error. |
| Seek decodes from the segment's first keyframe | decodes from the **last keyframe before the target** (keyframe every 1 s) | At most 1 s of hidden pre-roll instead of up to 4 s. |
| `skip if output newer than source` | skip if **source size+mtime and encoding settings** are unchanged; atomic swap of finished items; lock against parallel runs; skips files still being copied | Changing `config.json` rebuilds affected items; a half-copied file is never published; a playing video is never half-replaced. |
| WebP thumbnails | **JPEG** | No dependency on FFmpeg having libwebp; works on every browser. |
| config.json served with the site | config stays in `/srv/canvas-player/`; only the `player` section is copied into `catalog.json` | The hotspot password isn't published on the web server. |
| `prep.sh` wrapper | `prep` command **plus an auto-convert timer** (every 15 min, low priority) | Drop files in `source/` and they appear; no shell needed. |
| — | Loudness normalization (`normalizeAudio`) | Kids' videos vary wildly in volume. |
| — | A/V **alignment fix** in prep: t=0 is put on the first video frame for both streams | FFmpeg otherwise shifts everything by the earliest stream's start (e.g. AAC priming at −21 ms), then the fps filter rounds video by up to a frame. Measured 19 ms error before, <1 ms after. |

## Playback engine (`site/player.js`)

- **Clock:** `audio.currentTime` minus `avOffsetMs`. Between changes of
  `currentTime` the clock is extrapolated with `performance.now()` (capped at
  250 ms, so a stalled audio track also stalls the picture), and kept
  monotonic.
- **Render loop** (`requestAnimationFrame`): drop queued frames that a newer
  frame has replaced, draw the newest frame whose time ≤ clock + 8 ms, close
  everything. At most 6 decoded frames are held (WebCodecs) or 1 (MPEG-1,
  where jsmpeg owns the picture buffers).
- **Feeding:** chunks go to the decoder while `decodeQueueSize < 3`, fewer
  than 16 are in flight, and the frame queue has room. Segments are fetched
  3 ahead (~12 s) and evicted behind; failed fetches retry 3 times, then that
  segment is skipped (the picture freezes, the sound continues).
- **Seek:** pause audio → set `audio.currentTime` → reset decoder → decode from
  the keyframe before the target, hiding earlier frames → once the target
  frame is on screen and audio has seeked → resume.
- **Resync:** the same video-only seek to (clock + 150 ms) while the sound keeps
  playing. **Auto-resync** jumps to the next keyframe when video is
  `autoResyncMs` behind.
- **Backends** share one interface (`decode`, `canAccept`, `reset`, `flush`,
  `destroy`; frames delivered as `{ts, dur, draw(), close()}`).

## File formats

**Segment** (`seg_NNNNN.bin`, little-endian), served as `application/octet-stream`:

```
magic "CVS1" | version u8 = 1 | reserved u8 x3 | frameCount u32
index: frameCount x { pts_us u64, dur_us u32, flags u8 (bit0 = key), size u32 }
payload: frame bytes in index order (H.264: AVCC length-prefixed; MPEG-1: one picture,
         sequence header included on keyframes)
```

**manifest.json** (per video):

```json
{ "format": 1, "id": "6435819bbe", "title": "…", "category": "Animals", "duration": 89.99, "v": "e7440b18",
  "audio": [ { "format": "opus", "src": "audio.opus", "mime": "audio/ogg; codecs=opus" }, { "format": "mp3", … } ],
  "tracks": [
    { "kind": "h264", "backend": "webcodecs", "codec": "avc1.4D401F", "description": "<base64 avcC>",
      "width": 852, "height": 480, "fps": 29.97, "fpsFraction": "30000/1001", "frames": 2697, "duration": 89.99,
      "dir": "h264", "segmentDuration": 4,
      "segments": [ { "i": 0, "start": 0, "dur": 4.004, "file": "seg_00000.bin", "bytes": 402067, "frames": 120 } ] },
    { "kind": "mpeg1", "backend": "mpeg1", "codec": "mpeg1video", "description": null, … } ],
  "thumb": "thumb.jpg", "live": false, "source": { "path": "Animals/x.mp4", "mtime": 0, "size": 0 }, "prepKey": "…" }
```

`v` changes on every rebuild. All media URLs carry `?v=`, so the server can
mark them cacheable forever. **catalog.json** lists categories → items (`id`,
`title`, `duration`, `thumb`, `manifest`) plus the `player` settings.

**Live (Phase 6, not built):** `cvs.Segmenter` already accepts frames one at
a time and emits segments as they complete, so a `live.py` can append to a
manifest with `"live": true`. The player would poll the manifest; nothing in
the format blocks this.

## Encoding on another computer

Encoding is faster on a desktop (needs Python 3, FFmpeg, `pip install av`):

```bash
python3 prep/prep.py --source ~/Videos/kids --media ./media-out --config config.json
```

Copy everything inside `media-out/` (the item folders and `catalog.json`) to
`/srv/canvas-player/site/media/` on the Pi. Items made this way have no source
on the Pi; the Pi's own `prep` leaves them alone. Don't use `--prune` there.

## Developer tests

Everything below runs headless on a Linux machine with FFmpeg, PyAV, Caddy and
Playwright.

```bash
tools/make_test_media.py /tmp/lib/source            # synthetic videos: frame counter drawn as bits, beep every second
python3 prep/prep.py --source /tmp/lib/source --media /tmp/lib/media --config tools/test-config.json
tools/check_prep.py /tmp/lib/media                  # decodes every segment, checks frame numbers + beep timing
ln -s /tmp/lib/media site/media                     # then serve site/ with server/Caddyfile.template
node tools/e2e.js http://127.0.0.1/ --only=auto,mpeg1,crash,stall [--long=20]
node tools/e2e-diag.js http://127.0.0.1/
tools/make_diag_clips.py                            # regenerates site/diag/clips
```

`e2e.js` reads the frame number back off the canvas after every draw, and
compares it with the frame's timestamp (decode correctness) and with
`audio.currentTime` (sync). It covers playback, seek, ±10 s, pause, resync,
resume, injected decoder crash/hang (→ MPEG-1 fallback), and an optional long
run for memory. Note: Playwright's open-source Chromium has no H.264, so there
the WebCodecs path runs on a VP9 track (`tools/test-config.json`).
