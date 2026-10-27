/*
 * T-Stream "Add videos" page. It runs on the parent's phone (not the toy),
 * so modern JavaScript is fine. Talks to add/addserver.py under api/.
 *
 * Uploads go in 8 MB pieces: when the phone locks or the Wi-Fi drops, the
 * upload continues from the last piece when the page is back; after a
 * reload, picking the same file again continues it too.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PIECE = 8 * 1024 * 1024;
  const NEW_CAT = '\u0001new';
  const ACTIVE = new Set(['uploading', 'queued', 'downloading', 'waiting', 'converting']);

  let state = null;
  let pollTimer = 0;
  let started = false;
  const uploadQueue = [];
  let uploading = null;
  let wakeLock = null;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tstream-add.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tstream-add.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || ('The Pi answered ' + status));
      this.status = status;
      this.body = body || {};
    }
  }

  async function api(method, path, body) {
    const headers = { 'X-TStream': '1' };
    let data;
    if (body instanceof Blob) {
      headers['Content-Type'] = 'application/octet-stream';
      data = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      data = JSON.stringify(body);
    }
    const r = await fetch('api/' + path, { method, headers, body: data, credentials: 'same-origin', cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch (e) { /* no body */ }
    if (r.status === 401 && path !== 'login') showLogin();
    if (!r.ok) throw new ApiError(r.status, j);
    return j;
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  function setMsg(id, text, kind) {
    const m = $(id);
    m.textContent = text || '';
    m.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function fmtTime(s) {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }

  function fmtGB(n) { return (n / 1e9).toFixed(n >= 10e9 ? 0 : 1) + ' GB'; }

  // ------------------------------------------------------------ login ---

  function showLogin() {
    started = false;
    clearTimeout(pollTimer);
    $('app').hidden = true;
    $('space').hidden = true;
    $('login').hidden = false;
    setTimeout(() => $('pin').focus(), 50);
  }

  $('loginform').addEventListener('submit', async (e) => {
    e.preventDefault();
    setMsg('loginmsg', 'Checking...');
    try {
      await api('POST', 'login', { pin: $('pin').value });
      $('pin').value = '';
      setMsg('loginmsg', '');
      start();
    } catch (err) {
      setMsg('loginmsg', err.message, 'bad');
    }
  });

  // ------------------------------------------------------------- main ---

  async function start() {
    try {
      state = await api('GET', 'state');
    } catch (err) {
      if (err.status !== 401) {
        $('login').hidden = true;
        setMsg('linkmsg', '');
        toast(err.message || 'Can\'t reach the Pi.');
        setTimeout(start, 5000);
      }
      return;
    }
    started = true;
    $('login').hidden = true;
    $('app').hidden = false;
    renderCategories(true);
    render();
    schedulePoll();
    const shared = new URLSearchParams(location.search).get('link') || sessionStorage.getItem('tstream-add.link');
    if (shared) {
      sessionStorage.removeItem('tstream-add.link');
      $('link').value = shared;
      onLinkInput();
      setMsg('linkmsg', 'Check the category, then tap Send to the toy.');
      $('send').scrollIntoView({ block: 'center' });
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!started || document.hidden) return;
    const busy = uploading || (state && state.jobs.some((j) => ACTIVE.has(j.state)));
    pollTimer = setTimeout(refresh, busy ? 2000 : 10000);
  }

  async function refresh() {
    try {
      state = await api('GET', 'state');
      render();
    } catch (err) {
      if (err.status === 401) return;
    }
    schedulePoll();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && started) refresh();
  });

  // ------------------------------------------------------- categories ---

  function renderCategories(first) {
    const sel = $('cat');
    const keep = first ? (store.get('category', null) || state.category) : sel.value;
    const names = state.categories.slice();
    if (keep && keep !== NEW_CAT && names.indexOf(keep) < 0) names.push(keep);
    if (!names.length) names.push('Videos');
    sel.innerHTML = '';
    names.forEach((n) => { const o = el('option', '', n); o.value = n; sel.appendChild(o); });
    const o = el('option', '', 'New category...');
    o.value = NEW_CAT;
    sel.appendChild(o);
    sel.value = keep && (names.indexOf(keep) >= 0 || keep === NEW_CAT) ? keep : names[0];
    $('newcat').hidden = sel.value !== NEW_CAT;
  }

  $('cat').addEventListener('change', () => {
    const v = $('cat').value;
    $('newcat').hidden = v !== NEW_CAT;
    if (v === NEW_CAT) $('newcat').focus();
    else store.set('category', v);
  });

  function category() {
    const v = $('cat').value;
    if (v !== NEW_CAT) return v;
    const n = $('newcat').value.trim();
    if (!n) {
      $('newcat').focus();
      throw new Error('Type a name for the new category first.');
    }
    store.set('category', n);
    return n;
  }

  // ------------------------------------------------------------ links ---

  function linkInfo(text) {
    const m = /https?:\/\/[^\s<>"']+/.exec(text || '');
    if (!m) return null;
    try {
      const u = new URL(m[0]);
      return { url: m[0], list: u.searchParams.get('list'), video: u.searchParams.get('v') || /youtu\.be\/|\/shorts\//.test(m[0]) };
    } catch (e) {
      return null;
    }
  }

  function onLinkInput() {
    const info = linkInfo($('link').value);
    $('playlistopt').hidden = !(info && info.list && !info.video);
  }
  $('link').addEventListener('input', onLinkInput);

  // A pasted video link is sent right away (the category is already set);
  // a playlist link waits, so the "keep watching" choice can be made.
  $('link').addEventListener('paste', () => {
    setTimeout(() => {
      const info = linkInfo($('link').value);
      if (info && !(info.list && !info.video)) send();
    }, 50);
  });

  $('linkform').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  async function send() {
    if ($('send').disabled) return;
    const info = linkInfo($('link').value);
    if (!info) {
      setMsg('linkmsg', 'Paste a link first: in YouTube tap Share, then Copy link.', 'bad');
      return;
    }
    let cat;
    try { cat = category(); } catch (err) { setMsg('linkmsg', err.message, 'bad'); return; }
    $('send').disabled = true;
    setMsg('linkmsg', 'Sending...');
    try {
      const r = await api('POST', 'link', {
        url: info.url, category: cat, title: $('title').value.trim(),
        watch: !$('playlistopt').hidden && $('watch').checked
      });
      setMsg('linkmsg', r.message || 'Added.', r.already ? '' : 'ok');
      $('link').value = '';
      $('title').value = '';
      $('titlebox').open = false;
      onLinkInput();
      if (location.search) history.replaceState(null, '', location.pathname);
      refresh();
    } catch (err) {
      setMsg('linkmsg', err.message, 'bad');
    } finally {
      $('send').disabled = false;
    }
  }

  // ---------------------------------------------------------- uploads ---

  $('pick').addEventListener('click', () => $('files').click());
  $('files').addEventListener('change', () => {
    const files = Array.from($('files').files || []);
    $('files').value = '';
    if (!files.length) return;
    let cat;
    try { cat = category(); } catch (err) { setMsg('upmsg', err.message, 'bad'); return; }
    files.forEach((f) => uploadQueue.push({ file: f, category: cat }));
    runUploads();
  });

  async function runUploads() {
    if (uploading) return;
    holdScreen(true);
    while (uploadQueue.length) {
      const u = uploadQueue[0];
      uploading = u;
      schedulePoll();
      try {
        await uploadOne(u);
      } catch (err) {
        setMsg('upmsg', u.file.name + ': ' + err.message, 'bad');
        uploadQueue.shift();
        continue;
      }
      uploadQueue.shift();
    }
    uploading = null;
    holdScreen(false);
    refresh();
  }

  function videoDuration(file) {
    // best effort, for the free-space check; some formats can't be read here
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      const done = (d) => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(isFinite(d) && d > 0 ? d : null); };
      const t = setTimeout(() => done(null), 4000);
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => { clearTimeout(t); done(v.duration); };
      v.onerror = () => { clearTimeout(t); done(null); };
      v.src = url;
    });
  }

  function whenUsable() {
    return new Promise((resolve) => {
      const ok = () => !document.hidden && navigator.onLine !== false;
      if (ok()) return resolve();
      const check = () => {
        if (!ok()) return;
        document.removeEventListener('visibilitychange', check);
        window.removeEventListener('online', check);
        resolve();
      };
      document.addEventListener('visibilitychange', check);
      window.addEventListener('online', check);
    });
  }

  async function readable(blob) {
    try { await blob.slice(0, 1).arrayBuffer(); return true; } catch (e) { return false; }
  }

  async function uploadOne(u) {
    const f = u.file;
    const left = uploadQueue.length > 1 ? ' (' + (uploadQueue.length - 1) + ' more after this)' : '';
    setMsg('upmsg', 'Preparing ' + f.name + '...');
    const duration = await videoDuration(f);
    const start = await api('POST', 'upload', {
      name: f.name, size: f.size, lastModified: f.lastModified, type: f.type,
      category: u.category, duration
    });
    if (start.already) {
      setMsg('upmsg', f.name + ' is already on the toy.', 'ok');
      return;
    }
    let offset = start.offset;
    let delay = 1000, failures = 0;
    while (offset < f.size) {
      await whenUsable();
      setMsg('upmsg', 'Sending ' + f.name + ': ' + Math.floor(offset * 100 / f.size) + '%' + left);
      const piece = f.slice(offset, Math.min(f.size, offset + PIECE));
      try {
        const r = await api('PUT', 'upload/' + start.id + '?offset=' + offset, piece);
        offset = r.offset;
        delay = 1000;
        failures = 0;
      } catch (err) {
        if (err.status === 409 && typeof err.body.offset === 'number') { offset = err.body.offset; continue; }
        if (err.status && err.status < 500) throw err; // refused: say why
        failures++;
        if (failures >= 4 && !(await readable(piece))) {
          throw new Error('The phone stopped letting the page read this file. Pick it again; it continues where it stopped.');
        }
        setMsg('upmsg', 'Connection lost; trying again...' + left);
        await sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
    setMsg('upmsg', f.name + ' sent. It is converted for the toy next.', 'ok');
  }

  async function holdScreen(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* only on https; the hint asks to keep the page open */ }
  }

  window.addEventListener('beforeunload', (e) => {
    if (uploading) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------- display ---

  function stateText(j) {
    switch (j.state) {
      case 'uploading': return ['Sending from the phone: ' + j.pct + '%', '', true];
      case 'queued': return [j.kind === 'playlist' ? 'Waiting to read the playlist' : 'Waiting to download', '', true];
      case 'downloading': return [j.kind === 'playlist' ? 'Reading the playlist...' : 'Downloading: ' + j.pct + '%', '', true];
      case 'waiting': return ['Waiting to be converted for the toy', '', true];
      case 'converting': return ['Converting for the toy: ' + j.pct + '%', '', true];
      case 'ready': return ['On the toy', 'ok'];
      case 'listed': return [j.added + ' new video' + (j.added === 1 ? '' : 's') + ' added' + (j.watch ? '; watching for more' : ''), 'ok'];
      case 'removed': return ['Removed from the toy', ''];
      case 'cancelled': return ['Cancelled', ''];
      case 'failed': return [j.error || 'Failed', 'bad'];
      default: return [j.state, ''];
    }
  }

  function render() {
    renderSpace();
    renderCategories(false);
    renderJobs();
    renderPlaylists();
    renderHelp();
  }

  function renderSpace() {
    const s = state.space;
    const p = $('space');
    p.hidden = false;
    const h = s.hoursLeft >= 10 ? Math.round(s.hoursLeft) : s.hoursLeft;
    p.textContent = fmtGB(s.free) + ' free on the Pi: room for about ' + h + ' more hour' + (h === 1 ? '' : 's') + ' of video';
    p.className = 'space' + (s.hoursLeft < 1 ? ' low' : '');
  }

  function renderJobs() {
    const ul = $('jobs');
    ul.innerHTML = '';
    $('nojobs').hidden = state.jobs.length > 0;
    state.jobs.forEach((j) => {
      const li = el('li');
      const main = el('div', 'job-main');
      const [text, cls, active] = stateText(j);
      main.appendChild(el('div', 'job-title', j.title || j.name || j.url || 'Video'));
      main.appendChild(el('div', 'job-state' + (cls ? ' ' + cls : ''), text + (j.category ? '  ·  ' + j.category : '')));
      if (active && j.state !== 'waiting' && j.state !== 'queued') {
        const bar = el('div', 'bar');
        const fill = el('span');
        fill.style.width = (j.pct || 0) + '%';
        bar.appendChild(fill);
        main.appendChild(bar);
      }
      li.appendChild(main);
      const acts = el('div', 'job-actions');
      if (j.state === 'failed' && (j.kind === 'link' || j.kind === 'playlist')) {
        acts.appendChild(button('Try again', () => api('POST', 'job/' + j.id + '/retry')));
      }
      if (j.state === 'queued' || j.state === 'downloading' || (j.state === 'uploading' && !isUploading(j))) {
        acts.appendChild(button('Cancel', () => api('POST', 'job/' + j.id + '/cancel')));
      } else if (!active) {
        acts.appendChild(button('Hide', () => api('POST', 'job/' + j.id + '/cancel')));
      }
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  function isUploading(j) {
    const u = uploading && uploading.file;
    return u && j.name === u.name && j.size === u.size;
  }

  function button(label, action, cls) {
    const b = el('button', 'small' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await action(); } catch (err) { toast(err.message); }
      b.disabled = false;
      refresh();
    });
    return b;
  }

  function renderPlaylists() {
    const ul = $('playlists');
    ul.innerHTML = '';
    $('watched').hidden = !state.playlists.length;
    state.playlists.forEach((p) => {
      const li = el('li');
      const main = el('div', 'job-main');
      main.appendChild(el('div', 'job-title', p.title || p.url));
      main.appendChild(el('div', 'job-state' + (p.error ? ' bad' : ''),
        (p.error ? 'Last check failed: ' + p.error : 'Checked every hour') + '  ·  ' + p.category));
      li.appendChild(main);
      const acts = el('div', 'job-actions');
      acts.appendChild(button('Stop', () => api('POST', 'playlist/' + encodeURIComponent(p.id) + '/stop')));
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  // ---------------------------------------------------------- library ---

  $('librarybox').addEventListener('toggle', () => { if ($('librarybox').open) loadLibrary(); });

  async function loadLibrary() {
    const ul = $('library');
    ul.innerHTML = '';
    let items;
    try { items = (await api('GET', 'library')).items; } catch (err) { toast(err.message); return; }
    if (!items.length) ul.appendChild(el('li', 'hint', 'The toy has no videos yet.'));
    items.forEach((it) => {
      const li = el('li');
      const img = el('img');
      img.src = it.thumb;
      img.alt = '';
      img.loading = 'lazy';
      li.appendChild(img);
      const main = el('div', 'job-main');
      main.appendChild(el('div', 'job-title', it.title));
      main.appendChild(el('div', 'job-state', it.category + '  ·  ' + fmtTime(it.duration)));
      li.appendChild(main);
      const acts = el('div', 'job-actions');
      const rm = el('button', 'small', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (!confirm('Remove "' + it.title + '" from the toy? Its file on the Pi is deleted too.')) return;
        rm.disabled = true;
        try {
          await api('POST', 'remove', { id: it.id });
          li.remove();
          toast('Removed. The space is freed within about 15 minutes.');
          refresh();
        } catch (err) {
          toast(err.message);
          rm.disabled = false;
        }
      });
      acts.appendChild(rm);
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------- help ---

  function renderHelp() {
    const a = $('httpslink');
    if (state.httpsUrl) {
      a.href = state.httpsUrl;
      a.textContent = state.httpsUrl;
      a.hidden = false;
      $('nohttps').hidden = true;
    } else {
      a.hidden = true;
      $('nohttps').hidden = false;
    }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const help = $('helpbox');
    if (ios) help.insertBefore($('iphonehelp'), $('androidhelp'));
  }

  $('sharehelp').addEventListener('click', () => { $('helpbox').open = true; });

  $('makekey').addEventListener('click', async () => {
    try {
      const r = await api('POST', 'key', { name: 'iPhone Shortcut' });
      const base = state.httpsUrl || (location.origin + location.pathname.replace(/[^/]*$/, ''));
      $('sc-url').textContent = base + 'api/link';
      $('sc-tailscale').hidden = !/\.ts\.net|\/\/100\./.test(base);
      $('sc-key').textContent = r.key;
      $('shortcutsteps').hidden = false;
      $('makekey').hidden = true;
    } catch (err) {
      toast(err.message);
    }
  });

  document.querySelectorAll('code.copy').forEach((c) => c.addEventListener('click', () => copyText(c.textContent)));

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      t.setSelectionRange(0, text.length);
      try { document.execCommand('copy'); } catch (err) { /* nothing more to try */ }
      t.remove();
    }
    toast('Copied');
  }

  $('logout').addEventListener('click', async () => {
    try { await api('POST', 'logout'); } catch (e) { /* logged out anyway */ }
    showLogin();
  });

  // a shared link survives the PIN screen
  const shared = new URLSearchParams(location.search).get('link');
  if (shared) sessionStorage.setItem('tstream-add.link', shared);
  start();
})();
