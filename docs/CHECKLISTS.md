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

- [ ] `hotspot-on` prints the Wi-Fi name and password
- [ ] The toy joins that Wi-Fi (accept "no internet" / "stay connected" if asked)
- [ ] `http://10.42.0.1/` shows the library and videos play
- [ ] Reboot the Pi: after ~1 minute the hotspot is back and the toy reconnects
- [ ] `hotspot-off` puts the Pi back on the home Wi-Fi
