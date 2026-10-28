# Checklists for the toy

I can't test on the toy itself, so these are the things to check by hand
after each phase. The debug overlay (tap the top-right corner of the player
5 times) and `read-diag` are the main sources of feedback. A photo of the
overlay, or the text of `read-diag`, is the most useful thing to send back
when something is off.

## Phase 0: diagnostics

- [ ] `bash install.sh` finished and printed "Done" with addresses
- [ ] `tstream` shows **web server running**
- [ ] On the toy, `http://<pi>/diag.html` opens and shows the tables (browser version, features)
- [ ] The status line says **"Basic report sent to the Pi"**
- [ ] Tapping **Run playback tests** plays a short tone, shows moving test pictures, and ends with **"Done. Report sent"**
- [ ] On the Pi, `read-diag` prints the report, including the **Summary** lines
- [ ] If the summary suggests https: open it over https and run the tests again (expect a certificate warning unless `ca.crt` is installed)
- [ ] Send me the report: the `read-diag` text, or the contents of `http://<pi>/diag/last-report.json`

Pass: the full report shows on the toy *and* arrives on the Pi.

## Phase 1: converting videos

- [ ] Put 2–3 videos in two folders: `/srv/canvas-player/source/Animals/`, `/srv/canvas-player/source/Songs/`
- [ ] `prep` shows progress and ends with `built N, unchanged 0, failed 0`
- [ ] Running `prep` again immediately says `built 0, unchanged N` (nothing re-encoded)
- [ ] Touch or replace one file and run `prep`: only that one is rebuilt
- [ ] `http://<pi>/media/catalog.json` lists both categories

## Phase 2: the player

On the toy, open `http://<pi>/` (and `https://` too if diag said it works).

- [ ] Tap a video: the picture moves and the sound plays, lips/beats line up
- [ ] Debug overlay: **backend** is what diag recommended; **fps** close to the video's (24/25/30); **dropped** stays low; **drift** stays below ~40 ms
- [ ] Play a ~20 minute video start to finish. At the end:
  - [ ] still in sync (no visible lag), **auto** resync count low
  - [ ] the toy didn't get slow or hot, and the page didn't reload (memory OK)
- [ ] Drag the scrub bar to several places: the picture appears within about a second and continues in sync
- [ ] −10 s / +10 s work, also tapped quickly several times
- [ ] Pause: the picture holds still and the sound stops; Play continues in sync
- [ ] **Resync** while playing: the picture may freeze for a moment, then continues in sync; the sound never stops
- [ ] Press the toy's Home button during a video and come back: it is paused, and Play continues correctly

Pass: 20 minutes plays through, drift stays under ~80 ms, seeking works anywhere, Resync works, nothing slows down.

## Phase 3: library

- [ ] The dropdown lists the folders; picking one shows its videos
- [ ] Leave and re-open the page: the same category is selected
- [ ] Watch a video for a minute, go Back: its card shows a progress bar; tapping it resumes there
- [ ] A video watched to the end goes back to the grid and starts from the beginning next time
- [ ] Long-pressing a picture does nothing (no menu); pinching doesn't zoom
- [ ] A new video copied into `source/` appears on the grid within ~15 minutes without touching the Pi

## Phase 4: fallback (MPEG-1)

Built in from the start: it is what the toy uses on plain `http://`, or if WebCodecs fails.

- [ ] Open `http://<pi>/?backend=mpeg1&debug=1` and play a video: the overlay says **backend mpeg1 (WASM decoder, WebGL)**; fps and drift are as in Phase 2
- [ ] Repeat the Phase 2 seek/pause/resync checks once in this mode

## Phase 5: offline with the hotspot

- [ ] Over SSH from home Wi-Fi, `hotspot-on` prints the Wi-Fi name, password and the `ssh ...@10.42.0.1` line, warns, then your session drops
- [ ] Join the hotspot from your laptop/phone and `ssh <user>@10.42.0.1` works; `tstream` shows **hotspot ON**
- [ ] The toy joins that Wi-Fi (accept "no internet" / "stay connected" if asked)
- [ ] `http://10.42.0.1/` shows the library and videos play
- [ ] Reboot the Pi: after ~1 minute the hotspot is back and the toy reconnects
- [ ] `hotspot-off` (over SSH via the hotspot) drops the session; a minute later `ssh <user>@<pi-name>.local` works from home Wi-Fi
- [ ] Safety net: with the hotspot off, switch the router off and reboot the Pi; ~3-4 minutes later the hotspot appears. Switch the router back on and run `hotspot-off`

## Adding videos from the phone

On your phone, on the same Wi-Fi as the Pi (then once more with only Tailscale on, away from home):

- [ ] `http://<pi>/add/` asks for the PIN from `tstream`; after it, reloading the page doesn't ask again
- [ ] YouTube app: **Share → Copy link**, long-press the box, **Paste**: "Added to the queue" right away; Activity shows Downloading → Converting → **On the toy**
- [ ] The toy, left on its home screen, shows the new video within about a minute of "On the toy" (no reload)
- [ ] A made-for-kids cartoon and a Short both download (the Short plays upright, not tiny)
- [ ] The same link again says **Already on the toy**
- [ ] **Choose videos** with a 1-2 GB phone video; lock the phone halfway for a minute, unlock: it continues and finishes. Audio is there on the toy
- [ ] iPhone: also try a video picked under **Photo Library** (it may arrive compressed; check that it has sound)
- [ ] A video from Google Drive / iCloud through **Choose videos → Browse/Drive**
- [ ] Android: open the https address from **Help and settings** in Chrome, **Install app**; YouTube **Share** lists **Add videos**, and tapping it opens the page with the link; **Send to the toy** works
- [ ] iPhone: build the **Send to toy** Shortcut from **Help and settings**; YouTube **Share → Send to toy** shows a notification "Added to the queue"
- [ ] **On the toy → Remove** on one video: it disappears from the toy's grid within a minute; `tstream` shows more free space ~15 minutes later
- [ ] On the hotspot: `http://10.42.0.1/add/` works for phone uploads while the toy plays a video without stuttering
- [ ] Time one conversion: a 10-minute YouTube cartoon from "Converting" to "On the toy" (note it in the report)
- [ ] `tstream new-pin`: the phone asks for the PIN again

