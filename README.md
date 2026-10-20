# T-Stream: canvas player for a toddler tablet

A small offline video library served from a Raspberry Pi to a children's
tablet whose browser blocks video. Video is decoded in JavaScript and drawn on
a `<canvas>`; sound plays from a normal `<audio>` element. The page never uses
`<video>`, Media Source Extensions, or any video file type. To the browser
it looks like a page that plays audio and draws pictures.

```
 source/<Category>/*.mp4 ──prep──▶ site/media/<id>/ manifest.json, thumb.jpg, audio.opus|mp3,
                                                   h264/seg_*.bin, mpeg1/seg_*.bin
 Pi: Caddy serves site/ on http://:80 and https://:443 ──Wi-Fi──▶ toy browser:
     <audio> = clock, decoder → <canvas> (WebCodecs, or MPEG-1 via WebAssembly)
```

## How you use it

### 1. Install on the Pi (one command)

```bash
git clone https://github.com/waymarklabs-official/T-Stream && bash T-Stream/install.sh
```

It installs everything, prints the addresses, and is safe to run again.
Later updates are one word: `tstream update`.

### 2. Phase 0: run the diagnostics on the toy (do this first)

1. With the Pi and toy on the same Wi-Fi, open `http://<pi-address>/diag.html`
   on the toy. The installer printed the address, or run `tstream`.
2. Wait for **"Basic report sent to the Pi"**, then tap **Run playback tests**
   and wait about a minute for **"Done. Report sent"**.
3. On the Pi, run `read-diag`. To send the report on, open
   `http://<pi-address>/diag/last-report.json` from a phone or laptop and copy it.
4. If the summary says *"HTTPS works on this device"*, tap **Open this page
   over https** and run the tests again.

The summary tells you if anything in `config.json` should change. Usually
nothing does, because the player picks the best working mode by itself.

### 3. Add videos

Put files in `/srv/canvas-player/source/<Category>/`. Each folder becomes a
category in the dropdown. Then run `prep`, or just wait: new files are
converted automatically every 15 minutes. Any common format works (mp4, mkv,
avi, mov, mpg, ...). To encode on a faster computer instead, see
[docs/DESIGN.md](docs/DESIGN.md#encoding-on-another-computer).

### 4. Play

Open `http://<pi-address>/` on the toy, pick a category, tap a picture.
Add that address to the toy's allowed sites in its parental settings.

### 5. Offline (no internet, no router)

Run `hotspot-on` on the Pi. The Pi becomes a Wi-Fi network, with the name and
password printed and stored in `/srv/canvas-player/config.json`. Join it on the
toy and open **`http://10.42.0.1/`**. The hotspot stays on across reboots
until `hotspot-off`.

**If the Pi has only Wi-Fi** (no ethernet cable), it is either on your home
Wi-Fi or running its hotspot, never both:

| Pi is... | Reach it by SSH | Internet on the Pi |
|---|---|---|
| on home Wi-Fi | `ssh <user>@<pi-name>.local` from your home network | yes |
| running the hotspot | join the hotspot Wi-Fi, then `ssh <user>@10.42.0.1` | no |

- Switching cuts your SSH session; both commands print what you need to
  reconnect *before* switching, finish on their own, and log to
  `/var/log/tstream-hotspot.log`.
- **You can't get locked out:** if the hotspot can't start, the Pi goes back
  to your home Wi-Fi. If `hotspot-off` can't join your home Wi-Fi, the hotspot
  comes back. If the Pi joins no Wi-Fi within 3 minutes of booting (router off,
  or you're away from home), it starts the hotspot by itself until the next
  reboot, so the toy keeps working on trips too.
- Updates need internet: `hotspot-off`, reconnect over home Wi-Fi,
  `tstream update`, then `hotspot-on` again.

## Commands (on the Pi)

| Command | What it does |
|---|---|
| `tstream` | Status (web server, hotspot, addresses, library) and help |
| `prep` | Convert new or changed videos. `prep --force` rebuilds all (needed after changing encoding settings); `prep --prune` removes videos whose source file was deleted |
| `hotspot-on` / `hotspot-off` | Pi Wi-Fi hotspot for the toy on / back to your home Wi-Fi (with automatic fallback either way). `hotspot-on "Name" "password"` sets new ones |
| `read-diag` | Show the latest report from `diag.html` (`read-diag 3` for three) |
| `tstream update` | Download the newest version and reinstall; keeps videos and settings (needs internet: not in hotspot mode) |

## The player

- Tap a picture to start. The video goes full screen if the browser allows it,
  and resumes where it was left off (if more than 10 s in and more than 30 s
  from the end). When a video ends it returns to the grid.
- The controls hide after 3 s; tap anywhere to bring them back. They are
  Back, Play/Pause, −10 s, +10 s, the scrub bar, and **Resync**, which
  re-aligns the picture with the sound without stopping it.
- **Debug overlay:** tap the top-right corner 5 times quickly. It shows the
  backend, codec, fps, dropped frames, drift, buffer, and errors, plus
  **Video −20 ms / +20 ms** buttons to fine-tune lip sync. The offset is
  remembered on the toy.
- Add `?debug=1` to the address to open the overlay at start, or
  `?backend=mpeg1` / `?backend=webcodecs` to force a backend.

### Two ways to decode, chosen automatically

| | **WebCodecs** (fast path) | **MPEG-1** (fallback) |
|---|---|---|
| How | Browser's own decoder (often hardware), H.264 | jsmpeg's WebAssembly decoder + WebGL |
| Needs | Chromium 94+ **and https://** (a "secure context") | Almost any Chromium, works on plain http:// |
| Picture | Better per MB | Fine on local Wi-Fi (more MB, same look) |

`prep` makes both tracks for every video. The player uses WebCodecs when the
page is https and the codec works, and otherwise MPEG-1. If WebCodecs errors
or freezes mid-video, it switches to MPEG-1 on the spot and keeps the sound
playing.

**About https:** WebCodecs only exists on https pages. The Pi serves https with
its own certificate, which the toy will not trust unless you install
`http://<pi>/ca.crt` on it. On Android that's Settings → Security → Encryption
& credentials → Install a certificate → CA certificate. Many kid browsers are
app WebViews that ignore user certificates; then just use http:// and MPEG-1.
`diag.html` checks all of this for you.

## Settings (`/srv/canvas-player/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `videoTracks` | `["h264","mpeg1"]` | Tracks to make, in order of preference. Also `vp9`, `vp8`. Drop one to save encoding time and space once diag shows what works |
| `height` | `480` | Picture height (never upscales). `360` for weak devices |
| `maxFps` | `30` | Frame-rate cap (`25` or `24` for weak devices) |
| `keyframeSeconds` / `segmentSeconds` | `1` / `4` | Seek granularity / file size per request |
| `h264` | main, veryfast, crf 23 | x264 settings. `"profile": "baseline"` is cheaper to decode in software |
| `mpeg1.quality` | `5` | 2 (best, bigger) … 10 (smaller) |
| `audioFormats` | `["opus","mp3"]` | The player uses the first format the toy can play |
| `normalizeAudio` | `true` | Even out loudness between videos (no sudden loud ones) |
| `player.autoResyncMs` | `500` | If the picture falls this far behind the sound, jump to the next keyframe. `0` = off |
| `player.avOffsetMs` | `0` | Positive = show the picture later (lip-sync fine-tuning for all devices) |
| `player.bufferSegments` | `3` | Segments fetched ahead (~12 s) |
| `hotspot` | name, random password, country | Used by `hotspot-on` |

Run `prep --force` after changing anything above `player`. Player and hotspot
settings take effect on the next `prep` or `hotspot-on`.

## Troubleshooting

- **The toy shows "Couldn't play this one":** open the debug overlay on a video
  that plays, or run `diag.html`, then run `read-diag` and look at the summary.
- **Picture lags the sound a bit:** tap Resync. If it keeps happening, the
  device is too slow for the current settings: set `"height": 360` or
  `"maxFps": 25`, then run `prep --force`.
- **Lip sync is consistently early or late:** use the ±20 ms buttons in the
  debug overlay.
- **The screen turns off during videos:** the wake lock only works on https.
  Set the toy's screen timeout to 30 minutes or more.
- **The toy leaves the hotspot ("no internet"):** on the toy, choose "stay
  connected" for that network, or forget your home Wi-Fi there.
- **Nothing on port 80:** run `tstream`. The installer warns if another program
  (for example a Kodi web interface set to port 80) is using it.
- Logs: `/srv/canvas-player/prep.log`, `/var/log/caddy/canvas-player.log`,
  `journalctl -u caddy -u canvas-prep`.

## More

- [docs/CHECKLISTS.md](docs/CHECKLISTS.md): what to check on the toy, phase by phase
- [docs/DESIGN.md](docs/DESIGN.md): how it works, what changed from the original spec and why, file formats, developer tests
