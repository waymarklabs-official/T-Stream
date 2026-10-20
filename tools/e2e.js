#!/usr/bin/env node
/*
 * End-to-end player test in headless Chromium (Playwright).
 *
 * Needs the synthetic library from tools/make_test_media.py built with prep
 * and served (Caddy or any static server). For every frame the player draws,
 * the test reads the frame number back off the canvas and compares it with
 * the frame's timestamp (decode correctness) and with audio.currentTime at
 * that moment (A/V sync).
 *
 *   NODE_PATH=$(npm root -g) node tools/e2e.js http://127.0.0.1/ [--backend=mpeg1] [--seconds=15] [--long=MIN]
 */
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || 'http://127.0.0.1/').replace(/\/?$/, '/');
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const PLAY_SECONDS = +(opt.seconds || 15);

function summarize(xs) {
  if (!xs.length) return { n: 0 };
  const s = xs.slice().sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: +s[0].toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

// Installed in the page: records the frame number visible on the canvas
// right after every draw.
function installRecorder(layout) {
  const p = window.TStreamApp.player;
  window.__rec = [];
  window.__wrong = 0;
  const orig = p.onFrame.bind(p);
  p.onFrame = function (h) {
    const draw = h.draw;
    h.draw = function () {
      draw();
      const c = p.backend.canvas;
      const scale = c.height / layout.srcH;
      const y = Math.round((20 + layout.size / 2) * scale);
      let row;
      const gl = p.backend.kind === 'mpeg1' && p.backend.rendererName === 'WebGL' ? c.getContext('webgl') : null;
      if (gl) {
        row = new Uint8Array(c.width * 4);
        gl.readPixels(0, c.height - 1 - y, c.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      } else {
        row = c.getContext('2d').getImageData(0, y, c.width, 1).data;
      }
      let n = 0;
      for (let k = 0; k < layout.bits; k++) {
        const x = Math.round((20 + k * layout.step + layout.size / 2) * scale);
        if (row[x * 4 + 1] > 128) n |= 1 << k;
      }
      const fps = p.track.fps;
      const expect = Math.round(h.ts * fps / 1e6) % (1 << layout.bits);
      if (n !== expect) window.__wrong++;
      window.__rec.push({ ts: h.ts, n, expect, audio: p.audio.currentTime * 1e6, paused: p.audio.paused, at: performance.now() });
    };
    orig(h);
  };
}

async function waitFor(page, fn, arg, timeout = 15000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 50 });
}

async function scenario(browser, label, url, title, layout) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
  const problems = [];
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' || /garbage collected|VideoFrame/.test(t)) problems.push('console: ' + t);
  });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));

  await page.goto(url);
  await page.waitForSelector('.card');
  // pick the category that holds the clip, then tap its card
  await page.evaluate(t => {
    const sel = document.getElementById('category');
    const cat = [...sel.options].findIndex(o => o.value === t.cat);
    if (cat >= 0) { sel.selectedIndex = cat; sel.dispatchEvent(new Event('change')); }
  }, { cat: layout.cat });
  await page.locator('.card', { hasText: title }).first().click();
  await waitFor(page, () => window.TStreamApp.player && window.TStreamApp.player.state === 'playing');
  await page.evaluate(installRecorder, layout);
  const info = await page.evaluate(() => {
    const s = window.TStreamApp.player.stats();
    return { backend: s.backend, codec: s.codec, detail: s.detail, audio: s.audio, secure: isSecureContext };
  });
  const results = { label, ...info, checks: [] };
  const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, detail });

  // 1. steady playback
  const memStart = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : 0);
  await page.waitForTimeout(PLAY_SECONDS * 1000);
  let r = await page.evaluate(() => ({ rec: window.__rec.splice(0), wrong: window.__wrong, stats: window.TStreamApp.player.stats() }));
  const sync = r.rec.filter(x => !x.paused).map(x => (x.audio - x.ts) / 1000);
  const fps = r.rec.length / PLAY_SECONDS;
  check('frames correct (pixel frame number == timestamp)', r.wrong === 0 && r.rec.length > 0, `${r.rec.length} frames, ${r.wrong} wrong`);
  check('smooth fps', fps > layout.fps * 0.9, `${fps.toFixed(1)} fps drawn, ${r.stats.dropped} dropped`);
  const ss = summarize(sync);
  check('A/V sync: audio time - frame time at draw within [-10, 80] ms', ss.min > -10 && ss.max < 80, JSON.stringify(ss));
  results.syncMs = ss;

  // 2. seek forward (like the scrub bar)
  await page.evaluate(() => { window.__rec.length = 0; window.TStreamApp.player.seek(60); });
  await waitFor(page, () => { const p = window.TStreamApp.player; return p.state === 'playing' && p.lastDrawnTs >= 59.9e6; });
  await page.waitForTimeout(1500);
  r = await page.evaluate(() => ({ rec: window.__rec.splice(0), wrong: window.__wrong }));
  const first = r.rec.find(x => x.ts > 55e6); // frames drawn before the seek took effect are skipped
  check('seek to 60 s shows the right frame', first && Math.abs(first.ts / 1e6 - 60) < 0.05 && r.wrong === 0,
    first && `first frame after seek ts=${(first.ts / 1e6).toFixed(3)} n=${first.n} expect=${first.expect}`);

  // 3. seek backwards via the -10 s button
  await page.mouse.click(500, 300); // show controls
  await page.click('#back10');
  await waitFor(page, () => { const p = window.TStreamApp.player; return p.state === 'playing' && p.lastDrawnTs < 55e6 && p.lastDrawnTs > 48e6; });
  await page.waitForTimeout(1500);
  r = await page.evaluate(() => ({ rec: window.__rec.splice(0), wrong: window.__wrong, t: window.TStreamApp.player.currentTime }));
  const back = r.rec.find(x => x.ts < 55e6);
  check('-10 s button seeks back', back && back.ts / 1e6 > 49 && back.ts / 1e6 < 53 && r.wrong === 0,
    `first frame ${(back ? back.ts / 1e6 : -1).toFixed(2)} s, now ${r.t.toFixed(2)} s`);

  // 4. pause holds the picture, play resumes
  await page.evaluate(() => window.TStreamApp.player.pause());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__rec.splice(0));
  await page.waitForTimeout(1200);
  const pausedDraws = await page.evaluate(() => window.__rec.splice(0).length);
  check('no frames drawn while paused', pausedDraws === 0, `${pausedDraws} draws`);
  await page.evaluate(() => window.TStreamApp.player.play());
  await waitFor(page, () => window.TStreamApp.player.state === 'playing');
  await page.waitForTimeout(1500);

  // 5. resync while playing
  await page.evaluate(() => window.__rec.splice(0));
  await page.evaluate(() => window.TStreamApp.player.resync());
  await page.waitForTimeout(3000);
  r = await page.evaluate(() => ({ rec: window.__rec.splice(0), wrong: window.__wrong, stats: window.TStreamApp.player.stats() }));
  const after = r.rec.filter(x => x.at > r.rec[0].at + 1000).map(x => (x.audio - x.ts) / 1000);
  const sa = summarize(after);
  check('resync keeps playing in sync', r.wrong === 0 && sa.n > layout.fps && sa.max < 80, JSON.stringify(sa));

  // 6. long-ish run: memory and caches stay bounded
  if (opt.long) {
    const mins = +opt.long;
    const samples = [];
    for (let i = 0; i < mins * 6; i++) {
      await page.waitForTimeout(10000);
      samples.push(await page.evaluate(() => {
        const s = window.TStreamApp.player.stats();
        window.__rec.splice(0);
        return { heap: performance.memory ? performance.memory.usedJSHeapSize : 0, seg: s.segmentsCached, q: s.queued, wrong: window.__wrong, t: s.audioTime, drift: s.driftMs, state: s.state };
      }));
    }
    const heaps = samples.map(s => s.heap / 1e6);
    check('long run: frames correct', samples[samples.length - 1].wrong === 0, `wrong=${samples[samples.length - 1].wrong}`);
    // pipeline cap: maxQueue (6) + 2 frames in flight for WebCodecs, 1 for MPEG-1
    check('long run: caches bounded', Math.max(...samples.map(s => s.seg)) <= 6 && Math.max(...samples.map(s => s.q)) <= 8,
      `max segments ${Math.max(...samples.map(s => s.seg))}, max queued ${Math.max(...samples.map(s => s.q))}`);
    results.heapMB = heaps.map(h => +h.toFixed(1));
    results.longEnd = samples[samples.length - 1];
  }
  const memEnd = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : 0);
  results.heapStartMB = +(memStart / 1e6).toFixed(1);
  results.heapEndMB = +(memEnd / 1e6).toFixed(1);

  // 7. back to the grid, resume position remembered
  await page.mouse.click(500, 300);
  await page.click('#back');
  await page.waitForSelector('#home:not([hidden])');
  const resume = await page.evaluate(t => {
    const s = window.TStreamApp.store;
    return Object.keys(localStorage).filter(k => k.indexOf('tstream.pos.') === 0).map(k => +localStorage[k]);
  }, title);
  check('resume position saved', resume.some(v => v > 10), JSON.stringify(resume));

  check('no console errors', problems.length === 0, problems.slice(0, 5).join(' | '));
  await page.close();
  return results;
}

// WebCodecs breaks mid-video (crash or silent hang): the player must switch
// to the MPEG-1 track and keep playing in sync.
async function fallbackScenario(browser, mode, url, layout) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.waitForSelector('.card');
  await page.locator('.card', { hasText: 'Counting Test' }).first().click();
  await waitFor(page, () => window.TStreamApp.player && window.TStreamApp.player.state === 'playing');
  await page.evaluate(installRecorder, layout);
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.TStreamApp.player.stats().backend);
  const t0 = Date.now();
  await page.evaluate(m => {
    const b = window.TStreamApp.player.backend;
    if (m === 'crash') b.decode = function () { throw new Error('simulated decoder crash'); };
    else b.decode = function () { this.inFlight++; }; // swallow input, never output
  }, mode);
  await waitFor(page, () => { const p = window.TStreamApp.player; return p.backend && p.backend.kind === 'mpeg1' && p.lastDrawnTs > 0; }, null, 30000);
  const switchMs = Date.now() - t0;
  await page.evaluate(() => window.__rec.splice(0));
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({ rec: window.__rec.splice(0), wrong: window.__wrong, stats: window.TStreamApp.player.stats() }));
  const sync = summarize(r.rec.map(x => (x.audio - x.ts) / 1000));
  const checks = [
    { name: `${mode}: switched ${before} -> ${r.stats.backend}`, ok: before === 'webcodecs' && r.stats.backend === 'mpeg1', detail: `after ${switchMs} ms; ${r.stats.switchedFrom}` },
    { name: `${mode}: frames correct and in sync after switch`, ok: r.wrong === 0 && r.rec.length > 100 && sync.max < 80, detail: `${r.rec.length} frames, ${r.wrong} wrong, sync ${JSON.stringify(sync)}` },
    { name: `${mode}: audio never stopped`, ok: r.stats.state === 'playing', detail: r.stats.state },
    { name: `${mode}: no page errors`, ok: problems.length === 0, detail: problems.join(' | ') }
  ];
  await page.close();
  return { label: 'fallback-' + mode, backend: r.stats.backend, detail: r.stats.detail, codec: r.stats.codec, audio: r.stats.audio, checks };
}

// Touch screen: a tap on hidden controls must only reveal them, never press
// the button or move the scrub bar that appears under the finger.
async function touchScenario(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(url);
  await page.waitForSelector('.card');
  await page.locator('.card', { hasText: 'Counting Test' }).first().tap();
  await waitFor(page, () => window.TStreamApp.player && window.TStreamApp.player.state === 'playing');
  const center = async sel => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const hidden = () => page.evaluate(() => document.getElementById('controls').classList.contains('hide'));
  const checks = [];
  for (const [sel, label] of [['#playpause', 'pause button'], ['#back', 'Back button'], ['#scrub', 'scrub bar']]) {
    await page.waitForFunction(() => document.getElementById('controls').classList.contains('hide'), null, { timeout: 8000 });
    let [x, y] = await center(sel);
    if (sel === '#scrub') x = x + 250; // far from the current position
    const before = await page.evaluate(() => ({ t: window.TStreamApp.player.currentTime, s: window.TStreamApp.player.state }));
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ p: !!window.TStreamApp.player, t: window.TStreamApp.player && window.TStreamApp.player.currentTime, s: window.TStreamApp.player && window.TStreamApp.player.state }));
    const ok = after.p && after.s === 'playing' && Math.abs(after.t - before.t) < 2 && !(await hidden());
    checks.push({ name: `tap on hidden ${label} only shows the controls`, ok, detail: `before ${JSON.stringify(before)} after ${JSON.stringify(after)}` });
  }
  // a second tap, with controls visible, does press the button
  const [bx, by] = await center('#fwd10');
  const t0 = await page.evaluate(() => window.TStreamApp.player.currentTime);
  await page.touchscreen.tap(bx, by);
  await waitFor(page, t => window.TStreamApp.player.currentTime > t + 8, t0, 8000).catch(() => {});
  const t1 = await page.evaluate(() => window.TStreamApp.player.currentTime);
  checks.push({ name: 'tap on visible +10s works', ok: t1 > t0 + 8, detail: `${t0.toFixed(1)} -> ${t1.toFixed(1)}` });
  checks.push({ name: 'touch: no page errors', ok: problems.length === 0, detail: problems.join(' | ') });
  await ctx.close();
  return { label: 'touch', backend: '-', detail: '', codec: '', audio: '', checks };
}

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info']
  });
  const layout = { cat: 'Animals', srcH: 720, bits: 12, step: 60, size: 50, fps: 29.97 };
  const longLayout = { cat: 'Long', srcH: 480, bits: 16, step: 50, size: 40, fps: 30 };
  const runs = [];
  const which = opt.only ? opt.only.split(',') : ['auto', 'mpeg1'];
  for (const w of which) {
    if (w === 'crash' || w === 'stall') { runs.push(await fallbackScenario(browser, w, base, layout)); continue; }
    if (w === 'touch') { runs.push(await touchScenario(browser, base)); continue; }
    const q = w === 'auto' ? '' : '?backend=' + w;
    const isLong = !!opt.long;
    runs.push(await scenario(browser, w, base + q, isLong ? 'Long Test' : 'Counting Test', isLong ? longLayout : layout));
  }
  await browser.close();
  let ok = true;
  for (const r of runs) {
    console.log(`\n== ${r.label}: backend=${r.backend} (${r.detail}) codec=${r.codec} audio=${r.audio} secure=${r.secure}`);
    for (const c of r.checks) {
      ok = ok && c.ok;
      console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  -- ${c.detail}`);
    }
    console.log(`  heap ${r.heapStartMB} -> ${r.heapEndMB} MB` + (r.heapMB ? `  samples ${JSON.stringify(r.heapMB)}` : ''));
  }
  console.log(ok ? '\nALL PASS' : '\nFAILURES');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
