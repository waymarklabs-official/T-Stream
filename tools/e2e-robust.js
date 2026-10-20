#!/usr/bin/env node
/*
 * Robustness scenarios for the player engine (needs the synthetic library
 * from tools/make_test_media.py, built with tools/test-config.json):
 *   resize      MPEG-1: a 640x360 video, then an 852x480 one -> correct picture
 *   badseg      one segment answers 404 -> skipped, no error card
 *   failload    WebCodecs decoder errors right after configure -> MPEG-1, plays
 *   offset      lip-sync offset +40 ms -> opening and seeking stay fast
 *   quickback   open A, Back while it loads, open B -> B unaffected by A
 *   seekrace    two quick seeks, the first one slower -> second lands quickly
 *
 *   NODE_PATH=$(npm root -g) node tools/e2e-robust.js http://127.0.0.1/ [--only=a,b]
 */
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || 'http://127.0.0.1/').replace(/\/?$/, '/');
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));

const COUNTING = { cat: 'Animals', title: 'Counting Test', srcH: 720, bits: 12, step: 60, size: 50 };

async function open(page, cat, title) {
  await page.evaluate(c => {
    const sel = document.getElementById('category');
    const i = [...sel.options].findIndex(o => o.value === c);
    if (i >= 0 && sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change')); }
  }, cat);
  await page.locator('.card', { hasText: title }).first().click();
}

const playing = (page, timeout = 15000) =>
  page.waitForFunction(() => window.TStreamApp.player && window.TStreamApp.player.state === 'playing', null, { timeout, polling: 50 });

// frame number visible on the canvas right now (WebGL read happens right after a draw)
function installRecorder(layout) {
  const p = window.TStreamApp.player;
  window.__rec = [];
  const orig = p.onFrame.bind(p);
  p.onFrame = function (h) {
    const draw = h.draw;
    h.draw = function () {
      draw();
      const c = p.backend.canvas, scale = c.height / layout.srcH;
      const y = Math.round((20 + layout.size / 2) * scale);
      let row;
      if (p.backend.kind === 'mpeg1' && p.backend.rendererName === 'WebGL') {
        const gl = c.getContext('webgl');
        row = new Uint8Array(c.width * 4);
        gl.readPixels(0, c.height - 1 - y, c.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        window.__glErr = (window.__glErr || 0) + (gl.getError() ? 1 : 0);
      } else {
        row = c.getContext('2d').getImageData(0, y, c.width, 1).data;
      }
      let n = 0;
      for (let k = 0; k < layout.bits; k++) {
        const x = Math.round((20 + k * layout.step + layout.size / 2) * scale);
        if (row[x * 4 + 1] > 128) n |= 1 << k;
      }
      window.__rec.push({ ts: h.ts, n, expect: Math.round(h.ts * p.track.fps / 1e6) % (1 << layout.bits) });
    };
    orig(h);
  };
}

const SCENARIOS = {
  async resize(browser) {
    const page = await browser.newPage();
    await page.goto(base + '?backend=mpeg1');
    await page.waitForSelector('.card');
    await open(page, 'Shapes', 'Silent Bars');
    await playing(page);
    await page.waitForTimeout(1500);
    await page.evaluate(() => history.back());
    await page.waitForSelector('#home:not([hidden])');
    await open(page, 'Animals', 'Counting Test');
    await playing(page);
    await page.evaluate(installRecorder, COUNTING);
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({ rec: window.__rec, gl: window.__glErr || 0 }));
    const wrong = r.rec.filter(x => x.n !== x.expect).length;
    await page.close();
    return { ok: r.rec.length > 50 && wrong === 0 && r.gl === 0, detail: `${r.rec.length} frames, ${wrong} wrong, ${r.gl} GL errors` };
  },

  async badseg(browser) {
    const page = await browser.newPage();
    await page.route(/6435819bbe\/.*seg_00003\.bin/, route => route.fulfill({ status: 404, body: 'gone' }));
    await page.goto(base);
    await page.waitForSelector('.card');
    await open(page, 'Animals', 'Counting Test');
    await playing(page);
    await page.evaluate(() => window.TStreamApp.player.seek(10));
    await page.waitForTimeout(11000); // plays through the missing 12-16 s segment
    const s = await page.evaluate(() => ({ st: window.TStreamApp.player.state, t: window.TStreamApp.player.currentTime,
      card: !document.getElementById('errorcard').hidden, last: window.TStreamApp.player.lastDrawnTs / 1e6 }));
    await page.evaluate(() => window.TStreamApp.player.seek(13)); // seek straight into the missing segment
    await page.waitForTimeout(4000);
    const s2 = await page.evaluate(() => ({ st: window.TStreamApp.player.state, card: !document.getElementById('errorcard').hidden,
      last: window.TStreamApp.player.lastDrawnTs / 1e6 }));
    await page.close();
    return { ok: s.st === 'playing' && !s.card && s.last > 16 && s2.st === 'playing' && !s2.card && s2.last > 16,
      detail: `after play-through ${JSON.stringify(s)}; after seek into it ${JSON.stringify(s2)}` };
  },

  async failload(browser) {
    const out = [];
    for (const delay of [3, 20, 60]) {
      const ctx = await browser.newContext();
      await ctx.addInitScript(d => {
        const VD = window.VideoDecoder;
        if (!VD) return;
        window.VideoDecoder = function (init) {
          const dec = new VD(init);
          const cfg = dec.configure.bind(dec);
          dec.configure = function (c) { cfg(c); setTimeout(() => init.error(new Error('simulated hardware failure')), d); };
          return dec;
        };
        window.VideoDecoder.isConfigSupported = VD.isConfigSupported.bind(VD);
      }, delay);
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForSelector('.card');
      await open(page, 'Animals', 'Counting Test');
      let st = 'timeout';
      try { await playing(page, 15000); st = 'playing'; } catch (e) { /* reported below */ }
      await page.waitForTimeout(1500);
      const s = await page.evaluate(() => { const p = window.TStreamApp.player; return p && { state: p.state, backend: p.backend && p.backend.kind, drawn: p.stats().drawn, card: !document.getElementById('errorcard').hidden }; });
      out.push({ delay, st, ...s });
      await ctx.close();
    }
    return { ok: out.every(o => o.state === 'playing' && o.backend === 'mpeg1' && o.drawn > 10 && !o.card), detail: JSON.stringify(out) };
  },

  async offset(browser) {
    const page = await browser.newPage();
    await page.goto(base);
    await page.evaluate(() => localStorage.setItem('tstream.avOffsetMs', '40'));
    await page.reload();
    await page.waitForSelector('.card');
    const t0 = Date.now();
    await open(page, 'Animals', 'Counting Test');
    await playing(page);
    const openMs = Date.now() - t0;
    const seeks = [];
    for (const to of [30, 50, 20]) {
      const t1 = Date.now();
      await page.evaluate(x => window.TStreamApp.player.seek(x), to);
      await page.waitForFunction(x => { const p = window.TStreamApp.player; return p.state === 'playing' && Math.abs(p.currentTime - x) < 2; }, to, { timeout: 15000, polling: 20 });
      seeks.push(Date.now() - t1);
    }
    await page.evaluate(() => localStorage.removeItem('tstream.avOffsetMs'));
    await page.close();
    return { ok: openMs < 2500 && seeks.every(x => x < 2500), detail: `open ${openMs} ms, seeks ${JSON.stringify(seeks)} ms` };
  },

  async quickback(browser) {
    const page = await browser.newPage();
    // the first video's audio arrives late, so Back happens while it loads
    await page.route(/6435819bbe\/.*audio\.(opus|mp3)/, async route => { await new Promise(r => setTimeout(r, 2500)); route.continue(); });
    await page.goto(base);
    await page.waitForSelector('.card');
    await page.evaluate(() => {
      window.__states = [];
      const C = window.TStream.CanvasPlayer.prototype, orig = C._setState;
      C._setState = function (s) { if (this.destroyed) window.__states.push('DESTROYED:' + s); return orig.call(this, s); };
    });
    await open(page, 'Animals', 'Counting Test');
    await page.waitForTimeout(400);
    await page.evaluate(() => history.back());
    await page.waitForSelector('#home:not([hidden])');
    await open(page, 'Animals', 'Late Audio');
    await playing(page);
    await page.waitForTimeout(8000);
    const s = await page.evaluate(() => ({ state: window.TStreamApp.player.state, cls: document.getElementById('player').classList.contains('is-playing'),
      stale: window.__states }));
    await page.close();
    return { ok: s.state === 'playing' && s.cls && s.stale.length === 0, detail: JSON.stringify(s) };
  },

  async seekrace(browser) {
    const page = await browser.newPage();
    await page.goto(base + '?backend=mpeg1');
    await page.waitForSelector('.card');
    await open(page, 'Animals', 'Counting Test');
    await playing(page);
    // a slow toy: 25 ms per decoded picture; the far seek's segment arrives late
    await page.evaluate(() => {
      const P = window.TStream.Mpeg1Backend.prototype, dec = P.decode;
      P.decode = function (f, b) { const t = performance.now(); while (performance.now() - t < 25) { /* busy */ } return dec.call(this, f, b); };
    });
    await page.route(/seg_00004\.bin/, async route => { await new Promise(r => setTimeout(r, 400)); route.continue(); });
    const t0 = Date.now();
    await page.evaluate(() => { const p = window.TStreamApp.player; p.seek(17); setTimeout(() => p.seek(6.5), 30); });
    await page.waitForFunction(() => { const p = window.TStreamApp.player; return p.state === 'playing' && p.currentTime > 6 && p.currentTime < 9; }, null, { timeout: 15000, polling: 20 });
    const ms = Date.now() - t0;
    await page.close();
    return { ok: ms < 3000, detail: `playing again after ${ms} ms` };
  }
};

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const names = opt.only ? opt.only.split(',') : Object.keys(SCENARIOS);
  let ok = true;
  for (const n of names) {
    let r;
    try { r = await SCENARIOS[n](browser); } catch (e) { r = { ok: false, detail: 'threw: ' + e.message.split('\n')[0] }; }
    ok = ok && r.ok;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${n.padEnd(10)} ${r.detail}`);
  }
  await browser.close();
  console.log(ok ? 'ALL PASS' : 'FAILURES');
  process.exit(ok ? 0 : 1);
})();
