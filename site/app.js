/*
 * T-Stream library UI: category dropdown + thumbnail grid, and the player
 * screen (controls, resume, debug overlay). ES5 like player.js.
 */
(function () {
  'use strict';
  if (window.TSTREAM_TOO_OLD) return;

  function $(id) { return document.getElementById(id); }
  function noop() {}

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('tstream.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('tstream.' + k, JSON.stringify(v)); } catch (e) { /* no storage */ } },
    del: function (k) { try { localStorage.removeItem('tstream.' + k); } catch (e) { /* no storage */ } }
  };

  var params = {};
  location.search.replace(/[?&]([^=&]+)=?([^&]*)/g, function (_, k, v) { params[k] = decodeURIComponent(v); });

  var catalog = null;
  var itemsById = {};
  var player = null;
  var current = null;
  var audio = $('audio');
  var timers = { hide: 0, ui: 0, save: 0, toast: 0, catalog: 0 };
  var wakeLock = null;
  var openedFromHome = false;
  var dragging = false;
  var homeScroll = 0;
  var audioUnlocked = false;
  var lastTouch = 0;

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ------------------------------------------------------------- home ---

  function showMessage(html) {
    var m = $('message');
    m.innerHTML = html;
    m.hidden = false;
  }

  // Keep trying while there is nothing to show: the Pi or its hotspot may
  // still be starting, or the first videos may still be converting. A toy's
  // kid browser often has no reload button.
  function retryCatalog(ms) {
    clearTimeout(timers.catalog);
    timers.catalog = setTimeout(function () { loadCatalog().then(route); }, ms);
  }

  function hasItems(c) {
    var cats = (c && c.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].items.length) return true;
    return false;
  }

  function loadCatalog() {
    return TStream.getJSON('media/catalog.json?t=' + Date.now()).then(function (c) {
      var changed = !catalog || catalog.generated !== c.generated;
      catalog = c;
      if (changed) buildHome();
      if (!hasItems(c)) retryCatalog(10000);
    }, function (err) {
      if (catalog) return; // keep showing the library we already have
      showMessage(/HTTP 404/.test(err && err.message)
        ? 'No video library found yet.<br>Put videos in the <b>source</b> folder on the Pi and run <b>prep</b>.'
        : 'Can\'t reach the video box right now.<br>Trying again...');
      retryCatalog(5000);
    });
  }

  function buildHome() {
    var sel = $('category');
    itemsById = {};
    sel.innerHTML = '';
    var cats = catalog.categories || [];
    if (!cats.length) {
      sel.hidden = true;
      $('grid').innerHTML = '';
      showMessage('No videos yet.<br>Put videos in the <b>source</b> folder on the Pi and run <b>prep</b>.');
      return;
    }
    $('message').hidden = true;
    sel.hidden = cats.length < 2;
    for (var i = 0; i < cats.length; i++) {
      var o = el('option', '', cats[i].name);
      o.value = cats[i].name;
      sel.appendChild(o);
      for (var j = 0; j < cats[i].items.length; j++) itemsById[cats[i].items[j].id] = cats[i].items[j];
    }
    var saved = store.get('cat', null);
    for (var k = 0; k < cats.length; k++) if (cats[k].name === saved) sel.selectedIndex = k;
    renderGrid();
  }

  function renderGrid() {
    var sel = $('category'), grid = $('grid');
    var cats = catalog ? catalog.categories : [];
    var cat = cats[sel.selectedIndex] || cats[0];
    grid.innerHTML = '';
    if (!cat) return;
    cat.items.forEach(function (item) {
      var card = el('button', 'card');
      card.type = 'button';
      var th = el('div', 'thumb');
      var img = el('img');
      img.src = item.thumb;
      img.alt = '';
      img.draggable = false;
      img.setAttribute('loading', 'lazy');
      img.onerror = function () { img.style.visibility = 'hidden'; };
      th.appendChild(img);
      th.appendChild(el('span', 'dur', fmt(item.duration)));
      var pos = store.get('pos.' + item.id, 0);
      if (pos > 10 && item.duration) {
        var bar = el('span', 'bar');
        bar.style.width = Math.min(100, pos / item.duration * 100) + '%';
        th.appendChild(bar);
      }
      card.appendChild(th);
      card.appendChild(el('span', 'name', item.title));
      card.addEventListener('click', function () { openItem(item.id); });
      grid.appendChild(card);
    });
  }

  $('category').addEventListener('change', function () {
    store.set('cat', $('category').value);
    renderGrid();
    window.scrollTo(0, 0);
  });

  // ------------------------------------------------- start from a tap ---

  function silentWav() {
    var n = 800, b = [];
    function str(s) { for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); }
    function u32(v) { b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }
    function u16(v) { b.push(v & 255, (v >> 8) & 255); }
    str('RIFF'); u32(36 + n); str('WAVE'); str('fmt '); u32(16); u16(1); u16(1);
    u32(8000); u32(8000); u16(1); u16(8); str('data'); u32(n);
    for (var i = 0; i < n; i++) b.push(128);
    return 'data:audio/wav;base64,' + btoa(String.fromCharCode.apply(null, b));
  }

  // Older Chromium only lets an element play sound after it was started by
  // a tap, so "touch" the shared <audio> element during the first tap.
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      audio.src = silentWav();
      var p = audio.play();
      audio.pause();
      if (p && p.catch) p.catch(noop);
    } catch (e) { /* ignore */ }
  }

  function goFullscreen() {
    var d = document, e = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) return;
    var fn = e.requestFullscreen || e.webkitRequestFullscreen;
    if (!fn) return;
    try {
      var p = fn.call(e);
      if (p && p.catch) p.catch(noop);
    } catch (err) { /* blocked: fine */ }
  }

  function openItem(id) {
    unlockAudio();
    goFullscreen();
    openedFromHome = true;
    location.hash = '#/play/' + id;
  }

  function goHome() {
    if (openedFromHome && /^#\/play\//.test(location.hash)) history.back();
    else location.replace('#/');
  }

  function route() {
    if (!catalog) return;
    var m = /^#\/play\/([\w-]+)/.exec(location.hash);
    var item = m && itemsById[m[1]];
    if (item) {
      if (!current || current.id !== item.id) startPlayer(item);
    } else if (current) {
      stopPlayer();
    }
  }

  window.addEventListener('hashchange', route);

  // ----------------------------------------------------------- player ---

  function setPlayingClass(on) {
    var p = $('player');
    if (on) p.classList.add('is-playing'); else p.classList.remove('is-playing');
  }

  function showControls() {
    $('controls').classList.remove('hide');
    clearTimeout(timers.hide);
    if (player && player.state === 'playing' && !dragging) {
      timers.hide = setTimeout(function () { $('controls').classList.add('hide'); }, 3000);
    }
  }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(timers.toast);
    timers.toast = setTimeout(function () { t.hidden = true; }, 1600);
  }

  function savePos() {
    if (!player || !current || player.state === 'error' || player.state === 'loading') return;
    var t = player.currentTime;
    if (t > 0) store.set('pos.' + current.id, Math.round(t));
  }

  function acquireWakeLock() {
    if (!navigator.wakeLock || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }, noop);
  }

  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } }
    wakeLock = null;
  }

  function onState(s) {
    $('spinner').hidden = !(s === 'loading' || s === 'buffering' || s === 'seeking');
    if (s === 'playing') {
      setPlayingClass(true);
      acquireWakeLock();
      showControls();
    } else if (s === 'paused' || s === 'blocked' || s === 'ended') {
      setPlayingClass(false);
      releaseWakeLock();
      savePos();
      showControls();
    }
  }

  function onError(err) {
    $('spinner').hidden = true;
    $('errordetail').textContent = err && err.message ? err.message : String(err);
    $('errorcard').hidden = false;
    $('controls').classList.add('hide');
  }

  function onEnded() {
    if (current) store.del('pos.' + current.id);
    goHome();
  }

  function startPlayer(item) {
    if (player) stopPlayer();
    homeScroll = window.pageYOffset || 0;
    current = item;
    $('home').hidden = true;
    $('player').hidden = false;
    $('poster').src = item.thumb;
    $('poster').hidden = false;
    $('title').textContent = item.title;
    $('errorcard').hidden = true;
    setPlayingClass(false);
    showControls();

    var cfg = {};
    var base = (catalog && catalog.player) || {};
    for (var k in base) cfg[k] = base[k];
    var off = store.get('avOffsetMs', null);
    if (off !== null) cfg.avOffsetMs = off;

    var p = new TStream.CanvasPlayer({
      stage: $('stage'),
      audio: audio,
      config: cfg,
      backend: params.backend || null,
      onState: onState,
      onError: onError,
      onEnded: onEnded
    });
    player = p;
    var pos = store.get('pos.' + item.id, 0);
    var start = pos > 10 && pos < item.duration - 30 ? pos : 0;
    p.load(item.manifest, start).then(function () {
      // not if the screen went off or Home was pressed while loading
      if (player === p && !document.hidden) p.play();
    }, noop);

    timers.ui = setInterval(updateUI, 250);
    timers.save = setInterval(function () { if (player && player.state === 'playing') savePos(); }, 5000);
    if (params.debug === '1') $('debug').hidden = false;
    updateUI();
  }

  function stopPlayer() {
    savePos();
    clearInterval(timers.ui);
    clearInterval(timers.save);
    clearTimeout(timers.hide);
    releaseWakeLock();
    if (player) player.destroy();
    player = null;
    current = null;
    dragging = false;
    $('player').hidden = true;
    $('home').hidden = false;
    renderGrid();
    window.scrollTo(0, homeScroll);
    loadCatalog(); // pick up videos that finished converting meanwhile
  }

  function updateUI() {
    if (!player) return;
    var t = player.currentTime, d = player.duration || (current && current.duration) || 0;
    var scrub = $('scrub');
    if (!dragging) {
      if (+scrub.max !== d && d > 0) scrub.max = d;
      scrub.value = t;
      $('elapsed').textContent = fmt(t);
    }
    $('total').textContent = fmt(d);
    var s = player.stats();
    if (s.drawn > 0) $('poster').hidden = true;
    if (!$('debug').hidden) renderDebug(s);
  }

  function renderDebug(s) {
    var lines = [
      'backend  ' + s.backend + '  (' + s.detail + ')',
      'codec    ' + s.codec,
      'audio    ' + s.audio,
      'state    ' + s.state + '   clock ' + s.clock.toFixed(3) + '   audio ' + s.audioTime.toFixed(3),
      'drift    ' + s.driftMs.toFixed(0) + ' ms   behind ' + s.behindMs.toFixed(0) + ' ms   draw late ' +
        s.lastLateMs.toFixed(0) + ' ms (max ' + s.maxLateMs.toFixed(0) + ')',
      'fps      ' + s.fps.toFixed(1) + '   drawn ' + s.drawn + '   dropped ' + s.dropped + '   preroll ' + s.preroll,
      'buffer   ' + s.bufferedSec.toFixed(1) + ' s ahead, ' + s.segmentsCached + ' segments, ' + s.queued + ' frames queued',
      'resync   manual ' + s.resyncs + '   auto ' + s.autoResyncs + '   decoder errors ' + s.errors + '   stalls ' + s.stalls,
      'offset   video ' + (s.avOffsetMs >= 0 ? '+' : '') + s.avOffsetMs + ' ms',
      'page     ' + location.protocol + ' secure=' + !!window.isSecureContext + '  ' + window.innerWidth + 'x' +
        window.innerHeight + ' @' + (window.devicePixelRatio || 1)
    ];
    if (s.switchedFrom) lines.push('fallback switched from ' + s.switchedFrom);
    if (s.lastError) lines.push('error    ' + s.lastError);
    $('debugtext').textContent = lines.join('\n');
  }

  function togglePlay() {
    if (!player) return;
    if (player.state === 'playing' || player.state === 'buffering') player.pause();
    else player.play();
  }

  function seekBy(dt) {
    if (!player) return;
    var d = player.duration || 0;
    player.seek(Math.max(0, Math.min(d, player.currentTime + dt)));
    showControls();
  }

  // A tap on hidden controls only reveals them. Without this, the button
  // that appears under the finger (Back, pause, the scrub bar...) would get
  // the same tap, because Chrome hit-tests the click after the reveal.
  var revealing = false;
  function onPress(e) {
    if (e.type === 'pointerdown' || !revealing) revealing = $('controls').classList.contains('hide');
    if (e.type === 'touchstart' && revealing && e.cancelable) e.preventDefault(); // no click, no slider jump
    showControls();
  }
  $('player').addEventListener('pointerdown', onPress, true);
  $('player').addEventListener('touchstart', onPress, { capture: true, passive: false });
  $('player').addEventListener('click', function (e) {
    if (!revealing) return;
    revealing = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  $('back').addEventListener('click', goHome);
  $('errorback').addEventListener('click', goHome);
  $('bigplay').addEventListener('click', togglePlay);
  $('playpause').addEventListener('click', togglePlay);
  $('back10').addEventListener('click', function () { seekBy(-10); });
  $('fwd10').addEventListener('click', function () { seekBy(10); });
  $('resync').addEventListener('click', function () {
    if (!player) return;
    player.resync();
    toast('Picture re-synced to sound');
  });

  var scrub = $('scrub');
  scrub.addEventListener('input', function () {
    dragging = true;
    clearTimeout(timers.hide);
    $('elapsed').textContent = fmt(+scrub.value);
  });
  // 'change' does not come if the thumb ends where it started or the touch
  // is cancelled, so end the drag on any of these.
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (player && Math.abs(+scrub.value - player.currentTime) > 0.3) player.seek(+scrub.value);
    showControls();
  }
  ['change', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'].forEach(function (t) {
    scrub.addEventListener(t, endDrag);
  });

  // Debug overlay: tap the top-right corner 5 times.
  var cornerTaps = [];
  $('corner').addEventListener('click', function () {
    var n = Date.now();
    cornerTaps.push(n);
    cornerTaps = cornerTaps.filter(function (t) { return n - t < 3000; });
    if (cornerTaps.length >= 5) {
      cornerTaps = [];
      $('debug').hidden = !$('debug').hidden;
      if (player) renderDebug(player.stats());
    }
  });
  $('debugclose').addEventListener('click', function () { $('debug').hidden = true; });
  function nudge(ms) {
    if (!player) return;
    var v = player.stats().avOffsetMs + ms;
    player.setAvOffsetMs(v);
    store.set('avOffsetMs', v);
  }
  $('avminus').addEventListener('click', function () { nudge(-20); });
  $('avplus').addEventListener('click', function () { nudge(20); });

  document.addEventListener('visibilitychange', function () {
    if (!player) return;
    if (document.hidden) {
      savePos();
      player.pause();
    } else if (player.state === 'playing') {
      acquireWakeLock();
    }
  });
  window.addEventListener('pagehide', savePos);

  document.addEventListener('keydown', function (e) {
    if (!player) return;
    if (e.key === ' ' || e.key === 'k') { togglePlay(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') seekBy(-10);
    else if (e.key === 'ArrowRight') seekBy(10);
    else if (e.key === 'Escape') goHome();
  });

  // Block the long-press menu and pinch zoom that toddlers trigger.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  // Videos added from the phone appear on the home screen by themselves,
  // but never while a finger is on the grid (cards would move under it).
  document.addEventListener('touchstart', function () { lastTouch = Date.now(); }, true);
  document.addEventListener('pointerdown', function () { lastTouch = Date.now(); }, true);
  setInterval(function () {
    if (!current && catalog && !document.hidden && Date.now() - lastTouch > 30000) loadCatalog();
  }, 60000);

  loadCatalog().then(route);

  window.TStreamApp = { get player() { return player; }, store: store };
})();
