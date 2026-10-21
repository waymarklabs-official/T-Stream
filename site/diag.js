/*
 * T-Stream Phase 0 diagnostics. Deliberately ES5 with no dependencies for
 * the static checks, so it reports something even on very old Chromium.
 * The playback tests reuse the real player backends from player.js.
 */
(function () {
  'use strict';

  var CODECS = ['avc1.42E01E', 'avc1.4D401E', 'avc1.4D401F', 'vp8', 'vp09.00.10.08', 'av01.0.04M.08'];
  var HW_PREFS = ['no-preference', 'prefer-hardware', 'prefer-software'];

  var R = {
    v: 1,
    id: Math.random().toString(36).slice(2, 8),
    when: new Date().toISOString(),
    page: location.href,
    env: {}, features: {}, codecs: {}, audio: {}, https: null, tests: {}, summary: []
  };

  function $(id) { return document.getElementById(id); }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function status(text) { $('status').innerHTML = text; }

  function row(tableId, label, value, cls) {
    var tr = document.createElement('tr');
    var a = document.createElement('td');
    var b = document.createElement('td');
    a.textContent = label;
    b.textContent = value === undefined ? '' : String(value);
    if (cls) b.className = cls;
    tr.appendChild(a);
    tr.appendChild(b);
    $(tableId).appendChild(tr);
  }

  function yesNo(v) { return v ? 'yes' : 'no'; }

  function safe(fn, dflt) {
    try { return fn(); } catch (e) { return dflt; }
  }

  function rawUpdate() {
    $('raw').value = JSON.stringify(R, null, 1);
  }

  // -------------------------------------------------- static checks ---

  function collectEnv() {
    var ua = navigator.userAgent;
    var m = /Chrom(?:e|ium)\/([\d.]+)/.exec(ua);
    var e = R.env;
    e.userAgent = ua;
    e.chromium = m ? m[1] : 'unknown';
    e.chromiumMajor = m ? parseInt(m[1], 10) : 0;
    e.androidWebView = /; wv\)/.test(ua);
    e.secureContext = !!window.isSecureContext;
    e.protocol = location.protocol;
    e.host = location.host;
    e.screen = screen.width + 'x' + screen.height;
    e.window = window.innerWidth + 'x' + window.innerHeight;
    e.devicePixelRatio = window.devicePixelRatio || 1;
    e.cores = navigator.hardwareConcurrency || 'unknown';
    e.memoryGB = navigator.deviceMemory || 'unknown';
    e.platform = navigator.platform;
    e.language = navigator.language;
    e.localStorage = safe(function () { localStorage.setItem('tstream.diag', '1'); localStorage.removeItem('tstream.diag'); return true; }, false);

    row('env', 'Browser', ua);
    row('env', 'Chromium version', e.chromium + (e.androidWebView ? ' (Android WebView)' : ''), e.chromiumMajor >= 94 ? 'ok' : 'warn');
    row('env', 'Secure context (needed for WebCodecs)', yesNo(e.secureContext) + '  (' + e.protocol + '//' + e.host + ')', e.secureContext ? 'ok' : 'warn');
    row('env', 'Screen / window / pixel ratio', e.screen + ' / ' + e.window + ' / ' + e.devicePixelRatio);
    row('env', 'CPU cores / memory', e.cores + ' / ' + e.memoryGB + ' GB');
    row('env', 'localStorage (resume positions)', yesNo(e.localStorage), e.localStorage ? 'ok' : 'warn');

    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']).then(function (v) {
        e.uaData = v;
        row('env', 'Device model', (v.model || '?') + ', ' + (v.platform || '') + ' ' + (v.platformVersion || ''));
        rawUpdate();
      }, function () {});
    }
  }

  function canvasCtx(type) {
    return safe(function () { return !!document.createElement('canvas').getContext(type); }, false);
  }

  function syntaxOk(src) {
    return safe(function () { new Function(src); return true; }, false); // eslint-disable-line no-new-func
  }

  function collectFeatures() {
    var f = R.features, w = window;
    var c = document.createElement('canvas');
    f.VideoDecoder = typeof w.VideoDecoder === 'function';
    f.EncodedVideoChunk = typeof w.EncodedVideoChunk === 'function';
    f.VideoFrame = typeof w.VideoFrame === 'function';
    f.OffscreenCanvas = typeof w.OffscreenCanvas === 'function';
    f.transferControlToOffscreen = typeof c.transferControlToOffscreen === 'function';
    f.Worker = typeof w.Worker === 'function';
    f.WebAssembly = typeof w.WebAssembly === 'object';
    f.WebGL = canvasCtx('webgl') || canvasCtx('experimental-webgl');
    f.WebGL2 = canvasCtx('webgl2');
    f.AudioContext = !!(w.AudioContext || w.webkitAudioContext);
    f.Fullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    f.WakeLock = !!(navigator.wakeLock && navigator.wakeLock.request);
    f.fetch = typeof w.fetch === 'function';
    f.Promise = typeof w.Promise === 'function';
    f.ES2015 = syntaxOk('let a = (b) => `${b}`; class C {}');
    f.ES2017 = syntaxOk('async function f() { await 1; }');
    f.ES2020 = syntaxOk('var a = b?.c ?? 1;');

    var important = { VideoDecoder: 1, EncodedVideoChunk: 1, WebAssembly: 1, WebGL: 1, Promise: 1 };
    var notes = {
      VideoDecoder: 'WebCodecs (fast path). Only exists on https:// or localhost',
      WebAssembly: 'fast MPEG-1 fallback decoder',
      WebGL: 'fast MPEG-1 picture drawing',
      WakeLock: 'keeps the screen on during videos (https only)',
      Fullscreen: 'player goes full screen on tap'
    };
    for (var k in f) {
      row('features', k + (notes[k] ? '  (' + notes[k] + ')' : ''), yesNo(f[k]), f[k] ? 'ok' : (important[k] ? 'bad' : 'warn'));
    }
  }

  function collectAudio() {
    var a = document.createElement('audio');
    var types = ['audio/ogg; codecs=opus', 'audio/webm; codecs=opus', 'audio/mpeg', 'audio/mp4; codecs=mp4a.40.2'];
    for (var i = 0; i < types.length; i++) {
      var r = safe(function () { return a.canPlayType(types[i]); }, 'error');
      R.audio[types[i]] = r;
      row('audio', types[i], r || '(no)', r === 'probably' ? 'ok' : r === 'maybe' ? 'warn' : 'bad');
    }
  }

  function sequence(items, fn) {
    // run fn(item) one after another; fn returns a Promise
    var p = Promise.resolve();
    items.forEach(function (it) {
      p = p.then(function () { return fn(it); });
    });
    return p;
  }

  function codecChecks(extraCodecs) {
    if (!R.features.VideoDecoder) {
      row('codecs', 'VideoDecoder', R.env.secureContext ? 'not available in this browser' :
        'not available because this page is not https://', 'bad');
      return Promise.resolve();
    }
    var list = CODECS.slice();
    for (var i = 0; i < extraCodecs.length; i++) if (list.indexOf(extraCodecs[i]) < 0) list.push(extraCodecs[i]);
    return sequence(list, function (codec) {
      var res = R.codecs[codec] = {};
      return sequence(HW_PREFS, function (pref) {
        var cfg = { codec: codec, codedWidth: 854, codedHeight: 480 };
        // the plain check leaves hardwareAcceleration out: its allowed values
        // changed between Chromium versions
        if (pref !== 'no-preference') cfg.hardwareAcceleration = pref;
        return safe(function () {
          return VideoDecoder.isConfigSupported(cfg).then(function (r) { res[pref] = !!r.supported; },
            function (e) { res[pref] = 'error: ' + e.message; });
        }, Promise.resolve()).then(function () {
          if (res[pref] === undefined) res[pref] = 'error';
        });
      }).then(function () {
        var any = res['no-preference'] === true;
        var txt = 'any: ' + yesNo(any) + ', hardware: ' + fmtPref(res['prefer-hardware']) + ', software: ' + fmtPref(res['prefer-software']);
        row('codecs', codec, txt, any ? 'ok' : 'bad');
      });
    });
  }

  function fmtPref(v) { return v === true ? 'yes' : v === false ? 'no' : String(v); }

  function httpsProbe() {
    if (location.protocol === 'https:') {
      R.https = { page: 'https', trusted: true };
      row('env', 'HTTPS certificate', 'trusted (this page is https)', 'ok');
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var img = new Image(), done = false;
      function finish(ok, why) {
        if (done) return;
        done = true;
        R.https = { page: 'http', trusted: ok, detail: why };
        row('env', 'HTTPS certificate (probe of https://' + location.hostname + '/)', ok ? 'trusted - https works' : 'NOT trusted / unreachable (' + why + ')', ok ? 'ok' : 'warn');
        var a = $('otherproto');
        a.href = 'https://' + location.hostname + location.pathname;
        a.textContent = 'Open this page over https';
        a.hidden = !ok;
        resolve();
      }
      img.onload = function () { finish(true, 'ok'); };
      img.onerror = function () { finish(false, 'certificate rejected or blocked'); };
      setTimeout(function () { finish(false, 'timeout'); }, 6000);
      img.src = 'https://' + location.hostname + '/diag/pixel.gif?' + Date.now();
    });
  }

  // ---------------------------------------------------------- report ---

  function sendReport(stage) {
    R.stage = stage;
    R.sent = new Date().toISOString();
    rawUpdate();
    var json = JSON.stringify(R);
    var b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'diag/report?d=' + b64, true);
    if (typeof Promise !== 'function') { xhr.send(); return null; } // very old browser: fire and forget
    return new Promise(function (resolve) {
      xhr.onload = function () { resolve(xhr.status < 400); };
      xhr.onerror = function () { resolve(false); };
      xhr.send();
    });
  }

  // ------------------------------------------------------ playback tests ---

  function getIndex() {
    return TStream.getJSON('diag/clips/index.json?t=' + Date.now()).then(function (j) { return j.clips; },
      function () { return []; });
  }

  // Download speed from the Pi, measured on the test-clip downloads. Over a
  // remote link (Tailscale Funnel) this is the number that matters most.
  var NET = { bytes: 0, ms: 0 };

  function loadClip(entry) {
    return TStream.getJSON('diag/clips/' + entry.manifest).then(function (m) {
      var track = null;
      for (var i = 0; i < m.tracks.length; i++) if (m.tracks[i].kind === entry.kind) track = m.tracks[i];
      var base = 'diag/clips/' + entry.clip + '/' + track.dir + '/';
      return sequence(track.segments, function (s) {
        return new Promise(function (resolve, reject) {
          var t0 = now();
          // ?t= skips the browser cache, so every test really downloads
          TStream.request(base + s.file + '?t=' + Date.now(), 'arraybuffer', function (err, buf) {
            if (err) return reject(err);
            NET.bytes += buf.byteLength;
            NET.ms += now() - t0;
            s.parsed = TStream.parseSegment(buf);
            resolve();
          });
        });
      }).then(function () {
        var frames = [];
        track.segments.forEach(function (s) {
          s.parsed.frames.forEach(function (f) { frames.push({ f: f, bytes: new Uint8Array(s.parsed.buf, f.off, f.size) }); });
        });
        return { track: track, frames: frames };
      });
    });
  }

  function showCanvas(c) {
    var st = $('stage');
    while (st.firstChild) st.removeChild(st.firstChild);
    c.style.visibility = 'visible';
    st.appendChild(c);
  }

  // Decode every frame as fast as possible and draw it: the result is the
  // device's maximum decode speed for this codec and size.
  function throughput(entry) {
    var res = { clip: entry.clip, kind: entry.kind, codec: entry.codec, profile: entry.profile,
                size: entry.width + 'x' + entry.height, kbps: entry.kbps };
    return loadClip(entry).then(function (clip) {
      var n = clip.frames.length, i = 0, out = 0, t0 = 0, first = 0, finished = false, b;
      return new Promise(function (resolve) {
        function finish(err) {
          if (finished) return;
          finished = true;
          var ms = now() - t0;
          res.frames = n;
          res.decoded = out;
          res.ms = Math.round(ms);
          res.fps = Math.round(out / ms * 10000) / 10;
          res.firstFrameMs = Math.round(first);
          if (err) res.error = String(err.message || err);
          if (b) { res.detail = b.queueInfo(); try { b.destroy(); } catch (e) { /* ignore */ } }
          resolve(res);
        }
        var sink = {
          onFrame: function (h) {
            h.draw();
            h.close();
            if (!out) first = now() - t0;
            out++;
          },
          onDecoderError: function (e) { finish(e); }
        };
        var canvas = TStream.canvasFor(entry.backend);
        showCanvas(canvas);
        setTimeout(function () { finish(new Error('timeout after 25 s')); }, 25000);
        if (entry.backend === 'webcodecs') {
          try {
            b = new TStream.WebCodecsBackend(clip.track, canvas, sink);
          } catch (e) { return finish(e); }
          t0 = now();
          var feed = function () {
            if (finished) return;
            try {
              while (i < n && b.canAccept()) { b.decode(clip.frames[i].f, clip.frames[i].bytes); i++; }
            } catch (e) { return finish(e); }
            if (i < n) { setTimeout(feed, 1); return; }
            b.decoder.flush().then(function () { finish(); }, function (e) { finish(e); });
          };
          feed();
        } else {
          TStream.loadJsmpeg('vendor/jsmpeg.min.js').then(function (wasm) {
            b = new TStream.Mpeg1Backend(clip.track, canvas, sink, wasm);
            res.decoder = wasm ? 'WASM' : 'JS';
            t0 = now();
            var step = function () {
              if (finished) return;
              try {
                var end = Math.min(n, i + 6);
                for (; i < end; i++) b.decode(clip.frames[i].f, clip.frames[i].bytes);
              } catch (e) { return finish(e); }
              if (i < n) setTimeout(step, 0); else finish();
            };
            step();
          }, function (e) { finish(e); });
        }
      });
    }).catch(function (e) {
      res.error = String(e.message || e);
      return res;
    });
  }

  // Watch how audio.currentTime advances: the player's clock depends on it.
  function audioClockTest(a) {
    return new Promise(function (resolve) {
      var res = { src: a.src.replace(/^.*\//, '') }, samples = [], started = 0, done = false;
      function finish(err) {
        if (done) return;
        done = true;
        a.pause();
        if (err) res.error = err;
        if (samples.length > 2) {
          var changes = 0, maxGap = 0, lastChange = samples[0][0];
          for (var i = 1; i < samples.length; i++) {
            if (samples[i][1] !== samples[i - 1][1]) {
              changes++;
              maxGap = Math.max(maxGap, samples[i][0] - lastChange);
              lastChange = samples[i][0];
            }
          }
          var s0 = samples[0], s1 = samples[samples.length - 1];
          res.seconds = Math.round((s1[0] - s0[0])) / 1000;
          res.updatesPerSec = Math.round(changes / ((s1[0] - s0[0]) / 1000));
          res.maxStepMs = Math.round(maxGap);
          res.rate = Math.round((s1[1] - s0[1]) / ((s1[0] - s0[0]) / 1000) * 1000) / 1000;
        }
        resolve(res);
      }
      a.addEventListener('playing', function () {
        if (started) return;
        started = now();
        res.startMs = Math.round(started - t0);
        var tick = function () {
          if (done) return;
          samples.push([now(), a.currentTime]);
          if (now() - started > 2500) finish(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      a.addEventListener('error', function () { finish('audio error ' + (a.error && a.error.code)); });
      setTimeout(function () { if (!started) finish('audio did not start'); }, 8000);
      var t0 = now();
      var p = safe(function () { return a.play(); }, null);
      if (p && p.catch) p.catch(function (e) { finish('play() refused: ' + e.name); });
    });
  }

  // Short real playback with the actual player engine (audio + video).
  function realtimeTest(a, backend) {
    var res = { backend: backend };
    return new Promise(function (resolve) {
      var player, timer, done = false;
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (player) {
          var s = player.stats();
          res.codec = s.codec;
          res.detail = s.detail;
          res.audio = s.audio;
          res.drawn = s.drawn;
          res.dropped = s.dropped;
          res.fps = Math.round(s.fps * 10) / 10;
          res.maxLateMs = Math.round(s.maxLateMs);
          res.autoResyncs = s.autoResyncs;
          res.lastError = s.lastError;
          player.destroy();
        }
        if (err) res.error = String(err.message || err);
        resolve(res);
      }
      player = new TStream.CanvasPlayer({
        stage: $('stage'), audio: a, backend: backend,
        config: { autoResyncMs: 500, bufferSegments: 3 },
        onError: function (e) { finish(e); },
        onEnded: function () { finish(); }
      });
      timer = setTimeout(function () { finish(); }, 9000);
      player.load('diag/clips/480/manifest.json', 0).then(function () {
        return player.play();
      }).then(function () {
        // stop just before the end so the stats cover steady playback
        setTimeout(function () { finish(); }, 2600);
      }, function (e) { finish(e); });
    });
  }

  function testRow(label, value, cls) { row('tests', label, value, cls); }

  function fpsClass(fps) { return fps >= 40 ? 'ok' : fps >= 30 ? 'warn' : 'bad'; }

  // Audio for the clock test, taken from the 480p clip's manifest. Loaded
  // before the tap, because the tap handler must start playback directly.
  var toneSrc = null;
  function loadToneSrc() {
    return TStream.getJSON('diag/clips/480/manifest.json').then(function (m) {
      var a = document.createElement('audio');
      for (var i = 0; i < m.audio.length && !toneSrc; i++) {
        if (a.canPlayType(m.audio[i].mime)) toneSrc = 'diag/clips/480/' + m.audio[i].src;
      }
    }, function () {});
  }

  function runTests() {
    $('run').disabled = true;
    $('tests').innerHTML = '';
    var T = R.tests = { audioClock: null, decode: [], realtime: [] };

    // Audio must start inside this tap, so create and play it right now.
    var a = document.createElement('audio');
    a.src = toneSrc || 'diag/clips/480/missing-audio';
    a.preload = 'auto';
    status('Testing audio clock...');

    return audioClockTest(a).then(function (r) {
      T.audioClock = r;
      testRow('Audio clock (' + r.src + ')', r.error ? r.error :
        'started in ' + r.startMs + ' ms, ' + r.updatesPerSec + ' updates/s, biggest step ' + r.maxStepMs + ' ms, rate ' + r.rate,
        r.error ? 'bad' : r.maxStepMs > 100 ? 'warn' : 'ok');
      return getIndex();
    }).then(function (clips) {
      var list = clips.filter(function (c) {
        if (c.backend !== 'webcodecs') return true;
        var s = R.codecs[c.codec];
        return R.features.VideoDecoder && s && s['no-preference'] === true;
      });
      if (!R.features.VideoDecoder) testRow('WebCodecs decode tests', 'skipped: no VideoDecoder on this page', 'warn');
      var k = 0;
      return sequence(list, function (c) {
        k++;
        status('Decode test ' + k + '/' + list.length + ': ' + c.kind + ' ' + c.height + 'p ...');
        return throughput(c).then(function (r) {
          T.decode.push(r);
          var label = 'Decode ' + r.kind + (c.profile ? ' ' + c.profile : '') + ' ' + r.size + ' (' + r.codec + ')';
          testRow(label, r.error ? 'FAILED: ' + r.error + (r.decoded ? ' after ' + r.decoded + ' frames' : '') :
            r.fps + ' fps max (needs 30), first frame ' + r.firstFrameMs + ' ms' + (r.decoder ? ', ' + r.decoder : '') +
            (r.detail ? ' [' + r.detail + ']' : ''), r.error ? 'bad' : fpsClass(r.fps));
        });
      });
    }).then(function () {
      var backends = [];
      if (R.features.VideoDecoder) backends.push('webcodecs');
      backends.push('mpeg1');
      return sequence(backends, function (b) {
        status('Real playback test: ' + b + ' ...');
        return realtimeTest(a, b).then(function (r) {
          T.realtime.push(r);
          testRow('Real playback ' + b + (r.codec ? ' (' + r.codec + ')' : ''), r.error ? 'FAILED: ' + r.error :
            r.fps + ' fps, ' + r.dropped + ' dropped, worst lateness ' + r.maxLateMs + ' ms, auto-resyncs ' + r.autoResyncs,
            r.error ? 'bad' : r.fps >= 27 && r.maxLateMs < 80 ? 'ok' : 'warn');
        });
      });
    }).then(function () {
      if (NET.ms > 0) {
        var mbps = Math.round(NET.bytes * 8 / NET.ms / 100) / 10; // bytes per ms -> Mbit/s
        T.download = { bytes: NET.bytes, ms: Math.round(NET.ms), mbps: mbps };
        testRow('Download speed from the Pi', mbps + ' Mbit/s (' + Math.round(NET.bytes / 1e5) / 10 + ' MB in ' +
          Math.round(NET.ms / 100) / 10 + ' s)', mbps >= 4 ? 'ok' : mbps >= 2 ? 'warn' : 'bad');
      }
      summarize();
      status('Sending report...');
      return sendReport('full');
    }).then(function (sent) {
      status(sent ? 'Done. Report sent to the Pi (id ' + R.id + ').' : 'Done, but the report could not be sent.');
      $('run').disabled = false;
    }).catch(function (e) {
      status('Test crashed: ' + e.message);
      R.crash = String(e && e.stack || e);
      sendReport('crash');
      $('run').disabled = false;
    });
  }

  // ---------------------------------------------------------- summary ---

  // H.264 profile from the codec string: avc1.42.. Baseline, avc1.4D.. Main, avc1.64.. High
  function profileOf(d) {
    if (d.profile) return d.profile;
    var p = /^avc1\.(..)/i.exec(d.codec || '');
    return p ? ({ '42': 'baseline', '4D': 'main', '64': 'high' })[p[1].toUpperCase()] : null;
  }

  function best(kind, height, profile) {
    var r = null;
    R.tests.decode && R.tests.decode.forEach(function (d) {
      if (d.kind === kind && +d.size.split('x')[1] === height && !d.error && (!profile || profileOf(d) === profile) &&
          (!r || d.fps > r.fps)) r = d;
    });
    return r;
  }

  function summarize() {
    var S = R.summary = [];
    var host = location.hostname;
    var e = R.env, f = R.features;
    // prep encodes H.264 Main by default; Baseline is only tested for comparison
    var main = best('h264', 480, 'main'), base = best('h264', 480, 'baseline');
    var vp9 = best('vp9', 480), mp1 = best('mpeg1', 480), mp1s = best('mpeg1', 360);
    var fast = function (d) { return d && d.fps >= 36; };

    if (!e.secureContext) {
      S.push(['warn', 'This page is http://, so WebCodecs cannot be used or tested here. ' +
        (R.https && R.https.trusted ? 'HTTPS works on this device: open https://' + host + '/diag.html and run the tests again.'
          : 'HTTPS is not trusted on this device. Either install http://' + host + '/ca.crt on it, or use the MPEG-1 mode (works over http).')]);
    }
    if (fast(main)) {
      S.push(['ok', 'Best: WebCodecs + H.264 at 480p (' + main.fps + ' fps max). The default config is right. Bookmark ' +
        location.protocol + '//' + host + '/']);
    } else if (fast(base)) {
      S.push(['ok', 'H.264 is only fast enough in the Baseline profile (' + base.fps + ' fps; Main ' +
        (main ? main.fps + ' fps' : 'not supported') + '). Set "h264": {"profile": "baseline"} in config.json, then run prep --force.']);
    } else if (fast(vp9)) {
      S.push(['ok', 'Best: WebCodecs + VP9 at 480p (' + vp9.fps + ' fps). Set "videoTracks": ["vp9", "mpeg1"] in config.json, then run prep --force.']);
    }
    var webcodecsWins = fast(main) || fast(base) || fast(vp9);
    if (fast(mp1)) {
      var txt = 'MPEG-1 fallback works at 480p (' + mp1.fps + ' fps max).';
      if (!webcodecsWins) {
        // The player takes the first track WebCodecs *can* decode, whatever its speed.
        txt += main ? ' But on this https page the player would pick H.264, which is too slow here (' + main.fps +
          ' fps): set "videoTracks": ["mpeg1"] in config.json, or use the http:// address.' : ' It will be used automatically.';
      }
      S.push(['ok', txt]);
    } else if (fast(mp1s)) {
      S.push(['warn', 'MPEG-1 is only fast enough at 360p (' + mp1s.fps + ' fps). Set "height": 360 in config.json, then run prep --force.']);
    } else if (mp1 || mp1s) {
      S.push(['bad', 'MPEG-1 decoding is too slow on this device (' + ((mp1 || mp1s).fps) + ' fps).']);
    }
    if (!webcodecsWins && !fast(mp1) && !fast(mp1s)) S.push(['bad', 'No mode reached 36 fps. Try "height": 360 and "maxFps": 25.']);

    var rt = R.tests.realtime || [];
    rt.forEach(function (r) {
      if (r.error) S.push(['bad', 'Real playback with ' + r.backend + ' failed: ' + r.error]);
    });
    var opus = R.audio['audio/ogg; codecs=opus'], mp3 = R.audio['audio/mpeg'];
    if (!opus && mp3) S.push(['warn', 'No Opus audio: set "audioFormats": ["mp3"] to save encoding time (MP3 is already made by default).']);
    if (!opus && !mp3) S.push(['bad', 'Neither Opus nor MP3 audio is supported.']);
    var ac = R.tests.audioClock;
    if (ac && ac.error) S.push(['bad', 'Audio did not play: ' + ac.error]);
    if (!f.WakeLock) S.push(['warn', 'Screen wake lock unavailable' + (e.secureContext ? '' : ' (needs https)') + ': set the toy\'s screen timeout to 30 minutes or more.']);
    if (!f.WebAssembly) S.push(['warn', 'No WebAssembly: MPEG-1 will use the slower JavaScript decoder.']);
    var dl = R.tests.download;
    if (dl && dl.mbps < 3) {
      S.push([dl.mbps < 2 ? 'bad' : 'warn', 'Download from the Pi is only ' + dl.mbps + ' Mbit/s; videos need about 1-2 ' +
        '(H.264) or 2-3 (MPEG-1) and may pause to buffer. If this is over the remote link, try at home; to make ' +
        'videos smaller set "h264": {"crf": 27} and/or "height": 360, then run prep --force.']);
    }
    if (e.androidWebView) S.push(['info', 'This browser is an Android WebView inside an app.']);

    var ul = $('summary');
    ul.innerHTML = '';
    S.forEach(function (s) {
      var li = document.createElement('li');
      li.className = s[0];
      li.textContent = s[1];
      ul.appendChild(li);
    });
    rawUpdate();
  }

  // ------------------------------------------------------------- start ---

  function start() {
    collectEnv();
    collectFeatures();
    collectAudio();
    rawUpdate();
    if (!window.TStream || typeof Promise !== 'function') {
      status('player.js did not load: this browser is too old for the player.');
      sendReport('static');
      return;
    }
    $('run').onclick = runTests;
    status('Checking codecs...');
    loadToneSrc();
    getIndex().then(function (clips) {
      var extra = clips.map(function (c) { return c.codec; }).filter(function (c) { return c !== 'mpeg1video'; });
      return codecChecks(extra);
    }).then(httpsProbe).then(function () {
      rawUpdate();
      return sendReport('static');
    }).then(function (sent) {
      status((sent ? 'Basic report sent to the Pi. ' : 'Could not send the report. ') +
        'Now tap <b>Run playback tests</b> (about a minute).');
    });
  }

  try {
    start();
  } catch (e) {
    status('Diagnostics crashed: ' + e.message);
    R.crash = String(e && e.stack || e);
    sendReport('crash');
  }
})();
