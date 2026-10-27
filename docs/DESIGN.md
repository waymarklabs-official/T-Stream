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
| `skip if output newer than source` | skip if **source size+mtime and encoding settings** are unchanged; atomic swap of finished items; each build in its **own `<stamp>/` folder**, previous build kept; lock against parallel runs; skips files still being copied | Changing `config.json` rebuilds affected items; a half-copied file is never published; a toy that is watching a video while it is re-encoded keeps reading its own build. |
| WebP thumbnails | **JPEG** | No dependency on FFmpeg having libwebp; works on every browser. |
| config.json served with the site | config stays in `/srv/canvas-player/`; only the `player` section is copied into `catalog.json` | The hotspot password isn't published on the web server. |
| `prep.sh` wrapper | `prep` command **plus an auto-convert timer** (every 15 min, low priority) | Drop files in `source/` and they appear; no shell needed. |
| — | Loudness normalization (`normalizeAudio`) | Kids' videos vary wildly in volume. |
| `tls internal` (12 h certificates) | one-year certificates signed directly by Caddy's local root | The Pi has no battery clock; after a night unplugged in hotspot mode its time lags and short certificates would look expired to the toy. |
| — | A/V **alignment fix** in prep: t=0 is put on the first video frame for both streams | FFmpeg otherwise shifts everything by the earliest stream's start (e.g. AAC priming at −21 ms), then the fps filter rounds video by up to a frame. Measured 19 ms error before, <1 ms after. |

## Playback engine (`site/player.js`)

- **Clock:** `audio.currentTime` minus `avOffsetMs`. Between changes of
  `currentTime` the clock is extrapolated with `performance.now()` (capped at
  250 ms, so a stalled audio track also stalls the picture), and kept
  monotonic. Extrapolation starts only once `currentTime` has moved after a
  play/seek: Chrome holds it still while the sound output starts, which would
  otherwise show the first frames ~45 ms early.
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
  frame is on screen and audio has seeked → resume. A newer seek supersedes
  an older one (token); a segment that will not load is skipped, as in
  normal playback.
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
  "audio": [ { "format": "opus", "src": "e7440b18/audio.opus", "mime": "audio/ogg; codecs=opus" }, { "format": "mp3", … } ],
  "tracks": [
    { "kind": "h264", "backend": "webcodecs", "codec": "avc1.4D401F", "description": "<base64 avcC>",
      "width": 852, "height": 480, "fps": 29.97, "fpsFraction": "30000/1001", "frames": 2697, "duration": 89.99,
      "dir": "e7440b18/h264", "segmentDuration": 4,
      "segments": [ { "i": 0, "start": 0, "dur": 4.004, "file": "seg_00000.bin", "bytes": 402067, "frames": 120 } ] },
    { "kind": "mpeg1", "backend": "mpeg1", "codec": "mpeg1video", "description": null, … } ],
  "thumb": "e7440b18/thumb.jpg", "live": false, "source": { "path": "Animals/x.mp4", "mtime": 0, "size": 0 }, "prepKey": "…" }
```

`v` is the build stamp: every rebuild writes into a new `media/<id>/<v>/`
folder (the previous one is kept for players that still use it), so file
URLs never change content and the server marks them cacheable forever. **catalog.json** lists categories → items (`id`,
`title`, `duration`, `thumb`, `manifest`) plus the `player` settings.

**Live (Phase 6, not built):** `cvs.Segmenter` already accepts frames one at
a time and emits segments as they complete, so a `live.py` can append to a
manifest with `"live": true`. The player would poll the manifest; nothing in
the format blocks this.

## Adding videos from a phone (`add/addserver.py`)

A small Python service (standard library only) on `127.0.0.1:8098`, run as
the library owner by `tstream-add.service`. Caddy forwards `/add/*` to it from
the `http://` and `https://` sites only, after checking that the client is on
a private, hotspot, Tailscale or loopback address. The `:8099` site that
Tailscale Funnel puts on the internet does not import that route, and
`e2e-add` checks that `/add/` and `/k/<key>/add/` are 404 there. The page's
files live in `$ROOT/add/`, not in `site/`, so the Funnel link can't serve
them either.

- **Access:** a 6-digit PIN (`state/add-pin.txt`), 5 tries per address per
  5 minutes and 50 per hour overall. A correct PIN gives the phone a one-year
  HttpOnly cookie. API calls must carry an `X-TStream` header, so other web
  sites can't use the cookie. iPhone Shortcuts send a key (`X-TStream-Key`)
  made on the page. `tstream new-pin` empties `state/add-sessions.json`,
  which ends every cookie and key.
- **Uploads** go in 8 MB pieces (`PUT .../upload/<id>?offset=N`) into
  `source/.incoming/<id>.part`. prep never looks in dot folders. Each piece is
  fsynced, and one that is cut off is truncated back, so the file is always
  whole up to its offset. A wrong offset gets 409 with the right one. The id
  comes from category + name + size + lastModified, so picking the same file
  after a reload resumes it.
- **Finished files** are hard-linked to `source/<Category>/<Title>.<ext>`.
  Linking never overwrites; ` (2)` is added when the name is taken. If the
  drive can't hard-link, the name is claimed with `O_EXCL` and the file
  renamed. The file time is set to 61 s ago, so prep doesn't wait for "still
  copying". Then the service starts prep if none is running.
- **YouTube** goes through yt-dlp in `$ROOT/yt-dlp`, a venv owned by the
  library owner, with Deno from the `[deno]` extra on 64-bit.
  - The page updates it to the nightly build once a day before downloading,
    and once more when a download fails in a way that usually means it is out
    of date.
  - Command line: `-f bv*+ba/b -S res:480,vcodec:h264,acodec:aac`, which is
    480 on the short side so Shorts aren't tiny, and H.264 when available
    because the Pi decodes it fastest. Plus `--no-playlist`, `--ignore-config`,
    `--match-filters !is_live`, and machine-readable `--print` and
    `--progress-template` lines.
  - Downloads run one at a time, with a short pause in between: YouTube
    allows a guest a few hundred videos an hour.
  - A ledger (`state/add-ledger.json`) of video ids answers "already on the
    toy". It also stops a watched playlist from bringing back a video that
    was removed on purpose.
- **Removing** a video deletes its source file and drops a `.removed` marker
  in its media folder. `build_catalog` skips marked items at once, under a
  lock shared with prep. prep deletes the files 10 minutes later, after any
  toy still playing it is done.
- **Conversion progress** comes from `state/prep-status.json`, which prep
  writes atomically at most every 2 s.

prep changes that came with it:
- It rescans `source/` after every video and converts the newest file first,
  so a video added while a long batch runs doesn't wait for the batch.
- It checks free space before starting ffmpeg (worst-case bytes per hour per
  track, plus 300 MB).
- It remembers failed files (by mtime, size and settings) and only retries
  them when they change or with `--force`. "Not enough space" is always
  retried.
- It deletes a rebuilt video's previous version 6 h after the rebuild.
- It discards a build whose source was removed meanwhile.

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
node tools/e2e.js http://127.0.0.1/ --only=auto,mpeg1,crash,stall,touch [--long=18]
node tools/e2e-robust.js http://127.0.0.1/     # size change, missing segment, decoder dying while loading,
                                               # lip-sync offset, Back while loading, racing seeks
node tools/e2e-diag.js http://127.0.0.1/
tools/make_diag_clips.py                            # regenerates site/diag/clips
tools/test_add.py       # add-videos service + real prep, fake yt-dlp: PIN, uploads (resume, cut-off
                        # pieces, chunked), links, errors, yt-dlp update+retry, playlists, removal, keys
tools/e2e-add.sh        # the page at phone size through Caddy (spare ports): paste, 3-piece upload,
                        # toy picks it up by itself, removal, share target, Funnel port can't reach /add/
tools/test_hotspot.sh   # hotspot scripts against a fake NetworkManager
```

`e2e.js` reads the frame number back off the canvas after every draw, and
compares it with the frame's timestamp (decode correctness) and with
`audio.currentTime` (sync). It covers playback, seek, ±10 s, pause, resync,
resume, injected decoder crash/hang (→ MPEG-1 fallback), and an optional long
run for memory. Note: Playwright's open-source Chromium has no H.264, so there
the WebCodecs path runs on a VP9 track (`tools/test-config.json`).
