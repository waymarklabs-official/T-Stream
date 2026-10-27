#!/usr/bin/env node
/*
 * The add-videos page on a phone-sized screen, through Caddy (run by
 * tools/e2e-add.sh, which starts everything):
 *   PIN, paste a YouTube link (sent on paste), upload a 3-piece file,
 *   the toy's home screen picking both up by itself, removal, the Android
 *   share target, the Funnel port not reaching /add/, no outside requests.
 *
 *   node tools/e2e-add.js BASE PIN ROOT FUNNEL_BASE KEY
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [base, pin, root, funnel, key] = process.argv.slice(2);
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok    ' + name); } else { failed++; console.log('  FAIL  ' + name + '   ' + (detail || '')); }
}

async function jobText(page, title) {
  return page.evaluate((t) => {
    const li = [...document.querySelectorAll('#jobs li')].find((l) => l.querySelector('.job-title').textContent.includes(t));
    return li ? li.querySelector('.job-state').textContent : null;
  }, title);
}

async function waitJob(page, title, re, ms) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await jobText(page, title);
    if (last && re.test(last)) return last;
    await page.waitForTimeout(500);
  }
  return 'timeout, last: ' + last;
}

(async () => {
  const outside = [];
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 2 });
  ctx.on('request', (r) => { if (!/^(blob:)?http:\/\/127\.0\.0\.1[:/]|^data:/.test(r.url())) outside.push(r.url()); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());

  // the toy, open on its home screen the whole time
  const toy = await ctx.newPage();
  await toy.goto(base);

  console.log('login');
  await page.goto(base + 'add/');
  await page.waitForSelector('#login:not([hidden])');
  check('PIN screen first', await page.isVisible('#pin'));
  await page.fill('#pin', '000000' === pin ? '111111' : '000000');
  await page.click('#loginform button');
  await page.waitForFunction(() => /Wrong PIN/.test(document.getElementById('loginmsg').textContent));
  check('wrong PIN explained', true);
  await page.fill('#pin', pin);
  await page.click('#loginform button');
  await page.waitForSelector('#app:not([hidden])');
  check('PIN opens the page', await page.isVisible('#link'));
  check('space shown', /GB free/.test(await page.textContent('#space')));
  check('Paste box, no extra button (works on http too)', await page.$('#paste') === null);
  check('playlist choice hidden while the box is empty', !(await page.isVisible('#playlistopt')));
  await page.fill('#link', 'https://www.youtube.com/playlist?list=PLtest123');
  check('playlist choice shown for a playlist link', await page.isVisible('#playlistopt'));
  await page.fill('#link', '');
  check('and hidden again', !(await page.isVisible('#playlistopt')));
  await page.screenshot({ path: path.join(root, 'shot-add.png'), fullPage: true });

  console.log('YouTube link');
  await page.selectOption('#cat', '\u0001new');
  await page.fill('#newcat', 'Cartoons');
  await page.focus('#link');
  // what a long-press Paste does: the text arrives with a paste event
  await page.evaluate(() => {
    const i = document.getElementById('link');
    i.value = 'https://youtu.be/abcdefghijk?si=zzz';
    i.dispatchEvent(new Event('paste'));
  });
  await page.waitForFunction(() => /queue/.test(document.getElementById('linkmsg').textContent), null, { timeout: 10000 });
  check('pasted link is sent at once', true);
  check('link box emptied', (await page.inputValue('#link')) === '');
  const st = await waitJob(page, 'Mr. Fake', /On the toy/, 120000);
  check('activity: downloaded, converted, on the toy', /On the toy/.test(st) && /Cartoons/.test(st), st);

  console.log('upload (3 pieces)');
  const vid = path.join(root, 'IMG_2024 holiday.mp4');
  // noise does not compress: about 20 MB, so 3 pieces of 8 MB
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4,noise=alls=60:allf=t',
    '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-c:a', 'aac',
    '-shortest', vid]);
  const size = fs.statSync(vid).size;
  check('test file needs 3 pieces', size > 16 * 1024 * 1024, size);
  await page.selectOption('#cat', 'Cartoons').catch(() => {});
  await page.setInputFiles('#files', vid);
  const up = await waitJob(page, 'IMG_2024 holiday', /On the toy/, 120000);
  check('upload: sent, converted, on the toy', /On the toy/.test(up), up);
  check('upload message', /sent/.test(await page.textContent('#upmsg')), await page.textContent('#upmsg'));
  const placed = path.join(root, 'source', 'Cartoons', 'IMG_2024 holiday.mp4');
  check('file arrived whole', fs.existsSync(placed) && fs.statSync(placed).size === size);
  await page.screenshot({ path: path.join(root, 'shot-add-jobs.png'), fullPage: true });

  console.log('toy picks them up by itself');
  const seen = await toy.waitForFunction(() => {
    const names = [...document.querySelectorAll('.card .name')].map((n) => n.textContent);
    return names.includes('IMG_2024 holiday') && names.some((n) => n.startsWith('Mr. Fake')) && names;
  }, null, { timeout: 80000, polling: 1000 }).then((h) => h.jsonValue(), (e) => String(e));
  check('new videos on the toy without a reload', Array.isArray(seen), seen);

  console.log('remove');
  await page.click('#librarybox summary');
  await page.waitForSelector('#library li .job-title');
  const before = await page.$$eval('#library .job-title', (n) => n.map((x) => x.textContent));
  check('library lists both', before.length === 2, before);
  const thumbOk = await page.$eval('#library img', (i) => i.complete && i.naturalWidth > 0);
  check('thumbnails load', thumbOk);
  const li = page.locator('#library li', { hasText: 'IMG_2024 holiday' });
  await li.locator('button').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('#library .job-title')].some((n) => n.textContent === 'IMG_2024 holiday'));
  const cat = JSON.parse(fs.readFileSync(path.join(root, 'site', 'media', 'catalog.json')));
  const titles = cat.categories.flatMap((c) => c.items.map((i) => i.title));
  check('removed from the toy', !titles.includes('IMG_2024 holiday') && !fs.existsSync(placed), titles);

  console.log('Android share target');
  const share = await ctx.newPage();
  await share.goto(base + 'add/share?title=Bluey&text=' + encodeURIComponent('Watch this https://youtu.be/sharedvid01?si=abc'));
  await share.waitForSelector('#app:not([hidden])');
  check('share opens the page with the link', (await share.inputValue('#link')).includes('youtu.be/sharedvid01'));
  check('and asks to tap Send', /tap Send/.test(await share.textContent('#linkmsg')));
  await share.click('#send');
  await share.waitForFunction(() => /queue/.test(document.getElementById('linkmsg').textContent));
  check('sent from the share target', true);
  check('address bar cleaned (no resend on reload)', !share.url().includes('link='), share.url());

  console.log('safety');
  const r1 = await ctx.request.get(funnel + 'add/', { failOnStatusCode: false });
  const r2 = await ctx.request.get(funnel + 'k/' + key + '/add/', { failOnStatusCode: false });
  const r3 = await ctx.request.get(funnel + 'k/' + key + '/add/api/state', { failOnStatusCode: false, headers: { 'X-TStream': '1' } });
  check('Funnel port: /add/ is 404', r1.status() === 404, r1.status());
  check('Funnel port: /k/<key>/add/ is 404', r2.status() === 404 && r3.status() === 404, r2.status() + ' ' + r3.status());
  const r4 = await ctx.request.get(funnel + 'k/' + key + '/media/catalog.json', { failOnStatusCode: false });
  check('Funnel port still serves the toy', r4.status() === 200, r4.status());
  const r5 = await ctx.request.get(base + 'add/api/state', { failOnStatusCode: false });
  check('API needs its header even with the cookie', r5.status() === 403, r5.status());
  check('no requests outside the Pi', outside.length === 0, outside.join(' '));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
