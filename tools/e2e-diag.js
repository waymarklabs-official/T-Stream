#!/usr/bin/env node
/*
 * Runs site/diag.html in headless Chromium and prints the summary it shows.
 *   NODE_PATH=$(npm root -g) node tools/e2e-diag.js http://127.0.0.1/
 */
const { chromium } = require('playwright');

(async () => {
  const url = (process.argv[2] || 'http://127.0.0.1/').replace(/\/?$/, '/') + 'diag.html';
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // the https probe image is expected to fail when the local CA is not installed
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|ERR_TUNNEL|pixel\.gif/.test(m.text())) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => /Run playback tests|report/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  await page.click('#run');
  await page.waitForFunction(() => /^(Done|Test crashed)/.test(document.getElementById('status').textContent), null, { timeout: 180000 });
  const r = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    report: JSON.parse(document.getElementById('raw').value)
  }));
  await browser.close();
  const R = r.report;
  console.log(`${url}\nstatus: ${r.status}`);
  console.log(`chromium ${R.env.chromium} secure=${R.env.secureContext} https=${JSON.stringify(R.https)}`);
  console.log('audio clock:', JSON.stringify(R.tests.audioClock));
  for (const d of R.tests.decode) console.log(`decode ${d.kind.padEnd(5)} ${d.size.padEnd(8)} ${d.codec.padEnd(14)} ${d.error ? 'ERROR ' + d.error : d.fps + ' fps'} ${d.decoder || ''} ${d.detail || ''}`);
  for (const t of R.tests.realtime) console.log(`realtime ${t.backend}: ${JSON.stringify(t)}`);
  for (const s of R.summary) console.log(`summary [${s[0]}] ${s[1]}`);
  console.log('report bytes (json):', JSON.stringify(R).length, 'page errors:', errors.length ? errors : 'none');
  process.exit(errors.length || /crashed/.test(r.status) ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
