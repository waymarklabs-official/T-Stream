/*
 * T-Stream canvas player engine.
 *
 * Video frames are decoded in JavaScript and drawn on a <canvas>; sound plays
 * from a normal <audio> element, which is also the master clock. No <video>,
 * no Media Source Extensions, no video MIME types.
 *
 * Two interchangeable video backends share one engine (fetching, clock,
 * seeking, resync):
 *   - "webcodecs": VideoDecoder (H.264/VP9/VP8), needs a secure context
 *   - "mpeg1":     jsmpeg's MPEG-1 decoder (WebAssembly, or plain JS) + WebGL
 *
 * Written in ES5 on purpose so it runs on old Chromium builds.
 */
(function (global) {
  'use strict';

  var SEG_MAGIC = 0x31535643; // "CVS1" read as a little-endian u32
  var SEG_HEADER = 12;
  var SEG_ENTRY = 17;
  // Appended after every MPEG-1 picture so the decoder sees where it ends.
  var MPEG1_END = new Uint8Array([0, 0, 1, 0xb7]);
  var DRAW_LEAD_US = 8000;   // draw a frame up to 8 ms early (it shows at the next vsync)

  function noop() {}
  function nowMs() { return global.performance && performance.now ? performance.now() : Date.now(); }
  var raf = global.requestAnimationFrame || function (cb) { return setTimeout(function () { cb(nowMs()); }, 16); };
  var caf = global.cancelAnimationFrame || clearTimeout;

  // ------------------------------------------------------------ helpers ---

  function parseSegment(buf) {
    var dv = new DataView(buf);
    if (buf.byteLength < SEG_HEADER || dv.getUint32(0, true) !== SEG_MAGIC) throw new Error('bad segment');
    var count = dv.getUint32(8, true);
    var p = SEG_HEADER;
    var off = SEG_HEADER + count * SEG_ENTRY;
    var frames = new Array(count);
    for (var i = 0; i < count; i++) {
      var size = dv.getUint32(p + 13, true);
      frames[i] = {
        ts: dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296,
        dur: dv.getUint32(p + 8, true),
        key: (dv.getUint8(p + 12) & 1) === 1,
        off: off,
        size: size
      };
      off += size;
      p += SEG_ENTRY;
    }
    if (off > buf.byteLength) throw new Error('truncated segment');
    return { buf: buf, frames: frames };
  }

  function request(url, type, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = type;
    xhr.timeout = 20000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) cb(null, xhr.response);
      else cb(new Error('HTTP ' + xhr.status + ' for ' + url));
    };
    xhr.onerror = function () { cb(new Error('network error for ' + url)); };
    xhr.ontimeout = function () { cb(new Error('timeout for ' + url)); };
    xhr.send();
    return xhr;
  }

  function getJSON(url) {
    return new Promise(function (resolve, reject) {
      request(url, 'text', function (err, text) {
        if (err) return reject(err);
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
  }

  function b64ToBytes(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------- WebCodecs backend ---

  function wcConfig(track, hw) {
    var c = { codec: track.codec, codedWidth: track.width, codedHeight: track.height, optimizeForLatency: true };
    if (track.description) c.description = b64ToBytes(track.description);
    if (hw) c.hardwareAcceleration = hw;
    return c;
  }

  function WebCodecsBackend(track, canvas, sink) {
    this.kind = 'webcodecs';
    this.track = track;
    this.canvas = canvas;
    this.sink = sink;
    this.sync = false;
    this.maxQueue = 6;          // decoded frames we may hold before drawing
    this.config = wcConfig(track);
    this.frameDur = Math.round(1e6 / track.fps);
    canvas.width = track.width;
    canvas.height = track.height;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.inFlight = 0;
    this._create();
  }

  WebCodecsBackend.available = function () {
    return typeof global.VideoDecoder === 'function' && typeof global.EncodedVideoChunk === 'function';
  };

  // Resolves to true if this device can decode the track.
  WebCodecsBackend.supports = function (track) {
    if (!WebCodecsBackend.available()) return Promise.resolve(false);
    try {
      return VideoDecoder.isConfigSupported(wcConfig(track)).then(function (r) { return !!r.supported; },
        function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  };

  WebCodecsBackend.prototype._create = function () {
    var self = this;
    var dec = new VideoDecoder({
      output: function (frame) { self._output(frame, dec); },
      error: function (e) { if (dec === self.decoder) self.sink.onDecoderError(e); }
    });
    dec.configure(this.config);
    this.decoder = dec;
    this.inFlight = 0;
  };

  WebCodecsBackend.prototype._output = function (frame, dec) {
    if (dec !== this.decoder || this.destroyed) { frame.close(); return; }
    if (this.inFlight > 0) this.inFlight--;
    var ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    this.sink.onFrame({
      ts: frame.timestamp,
      dur: frame.duration || this.frameDur,
      draw: function () { ctx.drawImage(frame, 0, 0, w, h); },
      close: function () { frame.close(); }
    });
  };

  WebCodecsBackend.prototype.canAccept = function () {
    var d = this.decoder;
    return d.state === 'configured' && d.decodeQueueSize < 3 && this.inFlight < 16;
  };

  WebCodecsBackend.prototype.decode = function (f, bytes) {
    this.decoder.decode(new EncodedVideoChunk({
      type: f.key ? 'key' : 'delta', timestamp: f.ts, duration: f.dur, data: bytes
    }));
    this.inFlight++;
  };

  WebCodecsBackend.prototype.flush = function () {
    if (this.decoder.state === 'configured') this.decoder.flush().catch(noop);
  };

  WebCodecsBackend.prototype.reset = function () {
    if (this.decoder.state === 'closed') {
      this._create();
    } else {
      this.decoder.reset();
      this.decoder.configure(this.config);
      this.inFlight = 0;
    }
  };

  WebCodecsBackend.prototype.queueInfo = function () {
    return 'decodeQueue ' + this.decoder.decodeQueueSize + ', inFlight ' + this.inFlight;
  };

  WebCodecsBackend.prototype.destroy = function () {
    this.destroyed = true;
    try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch (e) { /* already closed */ }
  };

  // ---------------------------------------------------- MPEG-1 backend ---
  // jsmpeg is used purely as a decoder + YUV->RGB renderer. Its demuxer,
  // player and WebAudio output are never touched.

  var jsmpegReady = null;
  function loadJsmpeg(vendorUrl) {
    if (!jsmpegReady) {
      jsmpegReady = (global.JSMpeg ? Promise.resolve() : loadScript(vendorUrl)).then(function () {
        var J = global.JSMpeg;
        if (!J || !J.Decoder || !J.Decoder.MPEG1Video) throw new Error('jsmpeg missing');
        if (!global.WebAssembly || !J.WASM_BINARY_INLINED || !J.Decoder.MPEG1VideoWASM) return null;
        return new Promise(function (resolve) {
          var mod = J.WASMModule.GetModule();
          if (mod.ready) return resolve(mod);
          var timer = setTimeout(function () { resolve(null); }, 8000);
          try {
            mod.loadFromBuffer(J.Base64ToArrayBuffer(J.WASM_BINARY_INLINED), function (m) {
              clearTimeout(timer);
              resolve(m && m.ready ? mod : null);
            });
          } catch (e) {
            clearTimeout(timer);
            resolve(null); // fall back to the plain JS decoder
          }
        });
      });
      jsmpegReady.catch(function () { jsmpegReady = null; });
    }
    return jsmpegReady;
  }

  var glRenderers = []; // one renderer per canvas, reused across videos

  function rendererFor(canvas) {
    for (var i = 0; i < glRenderers.length; i++) if (glRenderers[i].canvas === canvas) return glRenderers[i].r;
    var J = global.JSMpeg, r = null;
    try {
      if (J.Renderer.WebGL.IsSupported()) r = new J.Renderer.WebGL({ canvas: canvas });
    } catch (e) { r = null; }
    if (!r) r = new J.Renderer.Canvas2D({ canvas: canvas });
    glRenderers.push({ canvas: canvas, r: r });
    return r;
  }

  function Mpeg1Backend(track, canvas, sink, wasm) {
    var self = this;
    this.kind = 'mpeg1';
    this.track = track;
    this.canvas = canvas;
    this.sink = sink;
    this.wasm = wasm;
    this.sync = true;     // decode() renders synchronously
    this.maxQueue = 1;    // jsmpeg keeps only the current picture: draw it before decoding the next
    this.renderer = rendererFor(canvas);
    this.rendererName = this.renderer instanceof global.JSMpeg.Renderer.WebGL ? 'WebGL' : 'Canvas2D';
    this.planes = null;
    this.gen = 0;
    this.failures = 0;
    this.capture = {
      resize: function (w, h) {
        // resizing clears the canvas; skip it when the size is unchanged
        if (self.renderer.width !== w || self.renderer.height !== h) self.renderer.resize(w, h);
      },
      render: function (y, cb, cr, clamped) { self.planes = [y, cb, cr, clamped]; }
    };
    this._create();
  }

  Mpeg1Backend.prototype._create = function () {
    var J = global.JSMpeg;
    if (this.dec && this.dec.destroy) this.dec.destroy();
    var opts = { streaming: true, decodeFirstFrame: false, videoBufferSize: 1024 * 1024 };
    if (this.wasm) opts.wasmModule = this.wasm;
    this.dec = this.wasm ? new J.Decoder.MPEG1VideoWASM(opts) : new J.Decoder.MPEG1Video(opts);
    this.dec.connect(this.capture);
    this.gen++;
  };

  Mpeg1Backend.prototype.canAccept = function () { return true; };

  Mpeg1Backend.prototype.decode = function (f, bytes) {
    this.planes = null;
    this.dec.write(f.ts / 1e6, [bytes, MPEG1_END]);
    if (!this.dec.decode() || !this.planes) {
      if (++this.failures > 30) this.sink.onDecoderError(new Error('MPEG-1 decoder stopped producing pictures'));
      return;
    }
    this.failures = 0;
    var planes = this.planes, r = this.renderer, self = this, gen = this.gen;
    this.sink.onFrame({
      ts: f.ts,
      dur: f.dur,
      draw: function () { if (gen === self.gen) r.render(planes[0], planes[1], planes[2], planes[3]); },
      close: noop
    });
  };

  Mpeg1Backend.prototype.flush = noop;
  Mpeg1Backend.prototype.reset = function () { this._create(); };
  Mpeg1Backend.prototype.queueInfo = function () {
    return (this.wasm ? 'WASM' : 'JS') + ' decoder, ' + this.rendererName;
  };
  Mpeg1Backend.prototype.destroy = function () {
    this.gen++;
    if (this.dec && this.dec.destroy) this.dec.destroy();
    this.dec = null;
  };

  // --------------------------------------------------------- canvases ---

  // Backends that failed on this device during this page visit are skipped.
  var brokenBackends = {};

  var canvases = {};
  function canvasFor(kind) {
    if (!canvases[kind]) {
      var c = document.createElement('canvas');
      c.className = 'video-canvas';
      canvases[kind] = c;
    }
    return canvases[kind];
  }

  // ----------------------------------------------------------- engine ---

  /*
   * opts: {
   *   stage:   element the canvas is placed in
   *   audio:   the <audio> element to use (master clock)
   *   config:  { autoResyncMs, avOffsetMs, bufferSegments }
   *   backend: force 'webcodecs' or 'mpeg1' (optional)
   *   vendorUrl: path to jsmpeg.min.js (default 'vendor/jsmpeg.min.js')
   *   onState(state), onError(err), onEnded()
   * }
   * Public API: load(url, startAt) -> Promise, play(), pause(), seek(t),
   * resync(), currentTime, duration, paused, stats(), destroy()
   */
  function CanvasPlayer(opts) {
    var cfg = opts.config || {};
    this.opts = opts;
    this.stage = opts.stage;
    this.audio = opts.audio;
    this.autoResyncUs = (cfg.autoResyncMs === undefined ? 500 : cfg.autoResyncMs) * 1000;
    this.avOffsetUs = (cfg.avOffsetMs || 0) * 1000;
    this.bufferSegments = Math.max(1, cfg.bufferSegments || 3);
    this.state = 'idle';
    this.duration = 0;
    this.queue = [];
    this.segCache = {};
    this.feedSeg = -1;
    this.feedIdx = 0;
    this.feedDone = false;
    this.minTs = 0;
    this.epoch = 0;
    this.seekToken = 0;
    this.seeking = false;
    this.pendingSeek = null;
    this.lastDrawnTs = -1;
    this.lastDrawnEnd = -1;
    this.lastAudioT = NaN;
    this.lastClock = 0;
    this.lastAutoResync = 0;
    this.lateRun = 0;
    this._resumeAfterSeek = false;
    this.errorRetried = false;
    this.cleanSince = nowMs();
    this.badSegments = 0;
    this.progressUs = 0;
    this.st = { drawn: 0, dropped: 0, preroll: 0, resyncs: 0, autoResyncs: 0, errors: 0, stalls: 0, maxLateMs: 0,
                fps: 0, fpsCount: 0, fpsStart: nowMs(), lastError: '', switchedFrom: '' };
    this._listeners = [];
    this._tick = this._tick.bind(this);
    this.rafId = raf(this._tick);
  }

  var P = CanvasPlayer.prototype;

  P._on = function (target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push([target, type, fn]);
  };

  P._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    if (this.opts.onState) this.opts.onState(s);
  };

  P._fail = function (err) {
    if (this.state === 'error' || this.destroyed) return;
    this.st.lastError = String(err && err.message || err);
    this._setState('error');
    try { this.audio.pause(); } catch (e) { /* ignore */ }
    if (this.opts.onError) this.opts.onError(err);
  };

  // Picks the first track this device can play, in manifest order.
  P._pickTrack = function (tracks) {
    var force = this.opts.backend;
    var i = 0;
    function next() {
      if (i >= tracks.length) return Promise.resolve(null);
      var t = tracks[i++];
      if (force && t.backend !== force) return next();
      if (!force && brokenBackends[t.backend]) return next();
      if (t.backend === 'mpeg1') return Promise.resolve(t);
      if (t.backend === 'webcodecs') {
        return WebCodecsBackend.supports(t).then(function (ok) { return ok ? t : next(); });
      }
      return next();
    }
    return next().then(function (t) {
      if (t) return t;
      var hint = '';
      if (!global.isSecureContext && tracks.some(function (x) { return x.backend === 'webcodecs'; }))
        hint = ' (WebCodecs needs https://)';
      throw new Error('No playable video track on this device' + hint);
    });
  };

  P._pickAudio = function (list) {
    var best = null, bestScore = 0;
    for (var i = 0; i < list.length; i++) {
      var r = this.audio.canPlayType(list[i].mime);
      var score = r === 'probably' ? 2 : r === 'maybe' ? 1 : 0;
      if (score > bestScore) { best = list[i]; bestScore = score; }
    }
    return best;
  };

  P.load = function (manifestUrl, startAt) {
    var self = this;
    this._setState('loading');
    this.base = manifestUrl.split('?')[0].replace(/[^\/]*$/, '');
    return getJSON(manifestUrl).then(function (m) {
      self.manifest = m;
      self.v = m.v ? '?v=' + encodeURIComponent(m.v) : '';
      self.duration = m.duration;
      var a = self._pickAudio(m.audio || []);
      if (!a) throw new Error('This device cannot play any of the audio formats');
      self.audioInfo = a;
      return self._pickTrack(m.tracks || []);
    }).then(function (track) {
      self.track = track;
      return self._makeBackend(track);
    }).then(function (backend) {
      if (self.destroyed) { backend.destroy(); throw new Error('closed'); }
      self._useBackend(backend);
      self._attachAudio();
      return self._waitAudioMetadata();
    }).then(function () {
      if (self.audio.duration && isFinite(self.audio.duration)) self.duration = Math.min(self.duration, self.audio.duration) || self.duration;
      return self._seekInternal(startAt || 0, false);
    }).then(function () {
      self._setState('paused');
      return self;
    }).catch(function (err) {
      if (!self.destroyed) self._fail(err);
      throw err;
    });
  };

  P._makeBackend = function (track) {
    var self = this;
    if (track.backend === 'mpeg1') {
      return loadJsmpeg(this.opts.vendorUrl || 'vendor/jsmpeg.min.js').then(function (wasm) {
        return new Mpeg1Backend(track, canvasFor('mpeg1'), self, wasm);
      });
    }
    return Promise.resolve(new WebCodecsBackend(track, canvasFor('webcodecs'), this));
  };

  P._useBackend = function (backend) {
    this.backend = backend;
    var c = backend.canvas;
    c.style.visibility = 'hidden'; // until the first frame of this video is drawn
    while (this.stage.firstChild) this.stage.removeChild(this.stage.firstChild);
    this.stage.appendChild(c);
  };

  // WebCodecs failed twice: carry on with the MPEG-1 track (sound keeps playing).
  P._fallbackTrack = function () {
    if (this.opts.backend) return null;
    var ts = (this.manifest && this.manifest.tracks) || [];
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].backend !== this.track.backend && !brokenBackends[ts[i].backend] && ts[i].backend === 'mpeg1') return ts[i];
    }
    return null;
  };

  P._switchTrack = function (track) {
    var self = this, old = this.backend;
    brokenBackends[old.kind] = true;
    this.st.switchedFrom = old.kind + ' (' + this.st.lastError + ')';
    this.switching = true;
    this.epoch++;
    this._clearQueue();
    this.backend = null;
    try { old.destroy(); } catch (e) { /* ignore */ }
    this._dropSegments();
    this.track = track;
    this.feedSeg = -1;
    return this._makeBackend(track).then(function (b) {
      if (self.destroyed) { b.destroy(); return; }
      self._useBackend(b);
      self.switching = false;
      self.errorRetried = false;
      self.cleanSince = nowMs();
      return self._videoSeek(Math.min(self.clockUs() / 1e6 + 0.3, self.duration), 'exact');
    }).catch(function (e) {
      self.switching = false;
      self._fail(e);
    });
  };

  P._dropSegments = function () {
    for (var k in this.segCache) {
      var e = this.segCache[k];
      if (e.xhr && !e.data) try { e.xhr.abort(); } catch (x) { /* ignore */ }
    }
    this.segCache = {};
  };

  P._attachAudio = function () {
    var self = this, a = this.audio;
    this._on(a, 'playing', function () { if (!self.seeking) self._setState('playing'); });
    this._on(a, 'pause', function () { if (!self.seeking && self.state !== 'ended' && self.state !== 'error') self._setState('paused'); });
    this._on(a, 'waiting', function () { if (!self.seeking && !a.paused) self._setState('buffering'); });
    this._on(a, 'ended', function () {
      self._setState('ended');
      if (self.opts.onEnded) self.opts.onEnded();
    });
    this._on(a, 'error', function () {
      var e = a.error;
      self._fail(new Error('Audio failed to load (code ' + (e && e.code) + ')'));
    });
    a.preload = 'auto';
    a.src = this.base + this.audioInfo.src + this.v;
    a.load();
  };

  P._waitAudioMetadata = function () {
    var a = this.audio;
    if (a.readyState >= 1) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { done(new Error('Audio did not load (timeout)')); }, 20000);
      function done(err) {
        clearTimeout(timer);
        a.removeEventListener('loadedmetadata', ok);
        a.removeEventListener('error', bad);
        if (err) reject(err); else resolve();
      }
      function ok() { done(); }
      function bad() { done(new Error('Audio failed to load')); }
      a.addEventListener('loadedmetadata', ok);
      a.addEventListener('error', bad);
    });
  };

  // ------------------------------------------------------------ clock ---

  // Current presentation time in microseconds. audio.currentTime can move in
  // coarse steps on some devices, so it is extrapolated between updates.
  P.clockUs = function () {
    var a = this.audio, t = a.currentTime;
    if (a.paused || a.seeking || this.seeking || this.state === 'buffering') {
      this.lastAudioT = NaN;
      this.lastClock = t;
      return (t * 1e6) - this.avOffsetUs;
    }
    var n = nowMs();
    if (t !== this.lastAudioT) {
      this.lastAudioT = t;
      this.anchorT = t;
      this.anchorNow = n;
    }
    var est = this.anchorT + Math.min((n - this.anchorNow) / 1000 * (a.playbackRate || 1), 0.25);
    if (est < this.lastClock && this.lastClock - est < 0.15) est = this.lastClock; // no small steps back
    this.lastClock = est;
    return (est * 1e6) - this.avOffsetUs;
  };

  // --------------------------------------------------------- segments ---

  P._segUrl = function (i) {
    return this.base + this.track.dir + '/' + this.track.segments[i].file + this.v;
  };

  P._getSegment = function (i) {
    var self = this, e = this.segCache[i];
    if (e) return e.promise;
    e = { data: null, xhr: null };
    e.promise = new Promise(function (resolve, reject) {
      var tries = 0;
      function attempt() {
        e.xhr = request(self._segUrl(i), 'arraybuffer', function (err, buf) {
          if (self.segCache[i] !== e) return reject(new Error('evicted'));
          if (!err) {
            try { e.data = parseSegment(buf); } catch (pe) { err = pe; }
          }
          if (!err) { self.badSegments = 0; return resolve(e.data); }
          if (++tries < 4) { setTimeout(attempt, 400 * tries); return; }
          delete self.segCache[i];
          reject(err);
        });
      }
      attempt();
    });
    e.promise.catch(noop);
    this.segCache[i] = e;
    return e.promise;
  };

  P._prefetch = function () {
    if (this.feedSeg < 0) return;
    var n = this.track.segments.length, self = this;
    var last = Math.min(n - 1, this.feedSeg + this.bufferSegments);
    for (var i = this.feedSeg; i <= last; i++) {
      if (!this.segCache[i]) this._getSegment(i).then(function () { self.pump(); }, noop);
    }
    for (var k in this.segCache) {
      var j = +k;
      if (j < this.feedSeg || j > last + 1) {
        var e = this.segCache[k];
        delete this.segCache[k];
        if (e.xhr && !e.data) try { e.xhr.abort(); } catch (x) { /* ignore */ }
      }
    }
  };

  P._segmentFor = function (t) {
    var segs = this.track.segments, i = 0;
    while (i + 1 < segs.length && segs[i + 1].start <= t + 1e-6) i++;
    return i;
  };

  P.bufferedAhead = function () {
    if (!this.track || this.feedSeg < 0) return 0;
    var segs = this.track.segments, i = this.feedSeg;
    while (i < segs.length && this.segCache[i] && this.segCache[i].data) i++;
    var end = i < segs.length ? segs[i].start : this.duration;
    return Math.max(0, end - this.clockUs() / 1e6);
  };

  // ---------------------------------------------------------- decoding ---

  P.pump = function () {
    var b = this.backend;
    if (!b || this.pumping || this.feedSeg < 0 || this.destroyed || this.state === 'error') return;
    this.pumping = true;
    var t0 = nowMs(), self = this;
    try {
      while (!this.feedDone) {
        // Hardware decoders have a small pool of output pictures, so cap
        // queued + in-flight frames. While nothing is queued, keep feeding
        // (up to canAccept's limit) for decoders that buffer a few frames
        // before their first output.
        var q = this.queue.length;
        if (q >= b.maxQueue || (q > 0 && q + (b.inFlight || 0) >= b.maxQueue + 2) || !b.canAccept()) break;
        var e = this.segCache[this.feedSeg];
        if (!e || !e.data) {
          var want = this.feedSeg, epoch = this.epoch;
          this._getSegment(want).then(function () { self.pump(); }, function (err) {
            // Skip a segment that will not load: the picture freezes for a few
            // seconds but sound keeps going, then video picks up again.
            if (epoch !== self.epoch || self.feedSeg !== want) return;
            self.st.lastError = 'segment ' + want + ': ' + err.message;
            if (++self.badSegments >= 3) return self._fail(new Error('Video data is not loading. Is the Wi-Fi OK?'));
            self._advanceSegment();
            self.pump();
          });
          break;
        }
        var f = e.data.frames[this.feedIdx];
        b.decode(f, new Uint8Array(e.data.buf, f.off, f.size));
        if (++this.feedIdx >= e.data.frames.length) this._advanceSegment();
        if (b.sync && nowMs() - t0 > 20) break; // keep the page responsive
      }
    } catch (err) {
      this.pumping = false;
      this.onDecoderError(err);
      return;
    }
    this.pumping = false;
    this._prefetch();
  };

  P._advanceSegment = function () {
    this.feedIdx = 0;
    this.feedSeg++;
    if (this.feedSeg >= this.track.segments.length) {
      this.feedSeg = this.track.segments.length - 1;
      this.feedIdx = this.segCache[this.feedSeg] && this.segCache[this.feedSeg].data
        ? this.segCache[this.feedSeg].data.frames.length : 0;
      this.feedDone = true;
      this.backend.flush();
    }
  };

  // Called by the backend for every decoded picture.
  P.onFrame = function (h) {
    if (this.destroyed) { h.close(); return; }
    if (h.ts < this.minTs) { h.close(); this.st.preroll++; return; }
    if (this.backend.sync && !this.seeking && !this.audio.paused) {
      // The MPEG-1 decoder can only hold one picture, so drop late ones right
      // away and decode the next (but show one now and then if far behind).
      if (h.ts + h.dur <= this.clockUs() && this.lateRun < 4) {
        this.lateRun++;
        this.st.dropped++;
        h.close();
        return;
      }
      this.lateRun = 0;
    }
    this.queue.push(h);
  };

  P.onDecoderError = function (err) {
    this.st.errors++;
    this.st.lastError = String(err && err.message || err);
    if (this.destroyed || this.state === 'error' || this.switching || !this.backend) return;
    if (this.errorRetried && nowMs() - this.cleanSince < 20000) {
      var fb = this._fallbackTrack();
      if (fb) { this._switchTrack(fb); return; }
      return this._fail(new Error('The video decoder failed: ' + this.st.lastError));
    }
    this.errorRetried = true;
    this.cleanSince = nowMs();
    var t = this.clockUs() / 1e6 + 0.2;
    this._videoSeekOrFail(Math.min(t, this.duration), 'exact');
  };

  P._videoSeekOrFail = function (t, mode) {
    var self = this;
    this._videoSeek(t, mode).catch(function (err) { self._fail(err); });
  };

  P._clearQueue = function () {
    while (this.queue.length) this.queue.shift().close();
  };

  // Restart video decoding at time t (seconds).
  //   'exact':   decode from the keyframe before t, hide frames before t
  //   'nextKey': jump to the first keyframe at/after t (fast catch-up)
  P._videoSeek = function (t, mode) {
    var self = this, epoch = ++this.epoch;
    this._clearQueue();
    try { this.backend.reset(); } catch (e) { return Promise.reject(e); }
    this.feedSeg = -1;
    this.feedDone = false;
    this.lateRun = 0;
    this.lastDrawnTs = -1;
    this.lastDrawnEnd = -1;
    this.progressUs = t * 1e6;
    var si = this._segmentFor(t);
    return this._getSegment(si).then(function (seg) {
      if (epoch !== self.epoch || self.destroyed) return;
      var tus = t * 1e6, frames = seg.frames, key = 0, target = 0, i;
      for (i = 0; i < frames.length && frames[i].ts <= tus + 500; i++) {
        target = i;
        if (frames[i].key) key = i;
      }
      self.feedSeg = si;
      if (mode === 'nextKey') {
        for (i = target + 1; i < frames.length && !frames[i].key; i++) { /* find next keyframe */ }
        if (i < frames.length) {
          self.feedIdx = i;
        } else if (si + 1 < self.track.segments.length) {
          self.feedSeg = si + 1;
          self.feedIdx = 0;
        } else {
          self.feedIdx = key; // no keyframe left: fall back to exact
          mode = 'exact';
        }
        self.minTs = 0;
      }
      if (mode === 'exact') {
        self.feedIdx = key;
        self.minTs = frames[target].ts;
      }
      self.pump();
    });
  };

  // Seek both audio and video. Audio waits (paused) until the video frame
  // for the new position is on screen, then playback continues.
  P._seekInternal = function (t, resume) {
    var self = this, a = this.audio, token = ++this.seekToken;
    t = Math.max(0, Math.min(t, Math.max(0, this.duration - 0.2)));
    this._resumeAfterSeek = resume;
    this.seeking = true;
    this._setState('seeking');
    if (!a.paused) a.pause();
    try { a.currentTime = t; } catch (e) { /* metadata not ready; handled by load() */ }
    return this._videoSeek(t, 'exact').then(function () {
      return new Promise(function (resolve) {
        self.pendingSeek = { token: token, minTs: self.minTs, resolve: resolve };
        setTimeout(resolve, 6000); // never hang the UI
      });
    }).then(function () {
      if (token !== self.seekToken || self.destroyed) return;
      self.pendingSeek = null;
      self.seeking = false;
      self.lastAudioT = NaN;
      if (self._resumeAfterSeek) self.play();
      else self._setState('paused');
    }, function (err) {
      if (token !== self.seekToken) return;
      self.pendingSeek = null;
      self.seeking = false;
      self._fail(err);
      throw err;
    });
  };

  // ----------------------------------------------------------- render ---

  P._tick = function () {
    if (this.destroyed) return;
    this.rafId = raf(this._tick);
    var b = this.backend;
    if (!b || this.state === 'error') return;
    var c = this.clockUs(), q = this.queue, playing = !this.audio.paused && !this.seeking;

    while (q.length > 1 && q[1].ts <= c + DRAW_LEAD_US) {
      q.shift().close();
      this.st.dropped++;
    }
    if (q.length && q[0].ts <= c + DRAW_LEAD_US) {
      var h = q.shift();
      h.draw();
      h.close();
      if (this.lastDrawnTs < 0 || b.canvas.style.visibility === 'hidden') b.canvas.style.visibility = 'visible';
      this.lastDrawnTs = h.ts;
      this.lastDrawnEnd = h.ts + h.dur;
      this.progressUs = c;
      this.st.drawn++;
      this.st.fpsCount++;
      if (playing) {
        var late = (c - h.ts) / 1000;
        this.lastLateMs = late;
        if (late > this.st.maxLateMs) this.st.maxLateMs = late;
      }
    }

    var ps = this.pendingSeek;
    if (ps && this.lastDrawnTs >= ps.minTs && !this.audio.seeking) {
      this.pendingSeek = null;
      ps.resolve();
    }

    // Video fell too far behind the audio (slow decoder, app was in the
    // background...): skip ahead to the next keyframe instead of crawling.
    if (playing && this.autoResyncUs > 0 && this.lastDrawnEnd >= 0 && !this.feedDone &&
        c - this.lastDrawnEnd > this.autoResyncUs && nowMs() - this.lastAutoResync > 2000) {
      this.lastAutoResync = nowMs();
      this.st.autoResyncs++;
      this._videoSeekOrFail(c / 1e6, 'nextKey');
    }

    // Watchdog: 4 s of media time without a picture while the data is there
    // means the decoder hung without reporting an error (seen on some
    // hardware decoders). Media time stands still while audio buffers, so a
    // slow network never counts as a stall.
    if (playing && !this.feedDone && this.feedSeg >= 0 && c - this.progressUs > 4e6) {
      var cur = this.segCache[this.feedSeg];
      if (cur && cur.data) {
        this.progressUs = c;
        this.st.stalls++;
        this.onDecoderError(new Error('video decoder stalled'));
      }
    }

    if (playing && nowMs() - this.cleanSince > 20000) this.errorRetried = false;

    var n = nowMs();
    if (n - this.st.fpsStart >= 1000) {
      this.st.fps = this.st.fpsCount * 1000 / (n - this.st.fpsStart);
      this.st.fpsCount = 0;
      this.st.fpsStart = n;
    }
    this.pump();
  };

  // ----------------------------------------------------------- public ---

  P.play = function () {
    var self = this;
    if (!this.backend || this.state === 'error') return Promise.resolve();
    if (this.state === 'ended' || this.audio.ended) return this._seekInternal(0, true);
    if (this.seeking) {
      this._resumeAfterSeek = true; // play as soon as the seek lands
      return Promise.resolve();
    }
    var p;
    try { p = this.audio.play(); } catch (e) { p = Promise.reject(e); }
    if (!p || !p.then) return Promise.resolve();
    return p.then(noop, function (err) {
      if (err && err.name === 'NotAllowedError') self._setState('blocked');
      else if (err && err.name !== 'AbortError') self.st.lastError = 'play: ' + err.message;
    });
  };

  P.pause = function () {
    this._resumeAfterSeek = false;
    if (this.audio && !this.audio.paused) this.audio.pause();
  };

  P.seek = function (t) {
    if (!this.backend || this.state === 'error') return Promise.resolve();
    var resume = this.seeking ? this._resumeAfterSeek : !this.audio.paused || this.state === 'playing';
    return this._seekInternal(t, resume).catch(noop);
  };

  // Re-align the picture with the sound without stopping the sound.
  P.resync = function () {
    if (!this.backend || this.seeking || this.state === 'error') return;
    this.st.resyncs++;
    var t = this.clockUs() / 1e6 + (this.audio.paused ? 0 : 0.15);
    this._videoSeekOrFail(Math.min(t, this.duration), 'exact');
  };

  P.setAvOffsetMs = function (ms) { this.avOffsetUs = ms * 1000; };

  P.stats = function () {
    var c = this.clockUs();
    return {
      backend: this.backend ? this.backend.kind : '-',
      codec: this.track ? this.track.codec + ' ' + this.track.width + 'x' + this.track.height + ' @' + (+this.track.fps).toFixed(2) : '-',
      detail: this.backend ? this.backend.queueInfo() : '',
      audio: this.audioInfo ? this.audioInfo.mime : '-',
      state: this.state,
      clock: c / 1e6,
      audioTime: this.audio.currentTime,
      driftMs: this.lastDrawnTs >= 0 ? (c - this.lastDrawnTs) / 1000 : 0,
      behindMs: this.lastDrawnEnd >= 0 ? Math.max(0, (c - this.lastDrawnEnd) / 1000) : 0,
      lastLateMs: this.lastLateMs || 0,
      maxLateMs: this.st.maxLateMs,
      fps: this.st.fps,
      drawn: this.st.drawn,
      dropped: this.st.dropped,
      preroll: this.st.preroll,
      queued: this.queue.length,
      bufferedSec: this.bufferedAhead(),
      segmentsCached: Object.keys(this.segCache).length,
      resyncs: this.st.resyncs,
      autoResyncs: this.st.autoResyncs,
      errors: this.st.errors,
      stalls: this.st.stalls,
      switchedFrom: this.st.switchedFrom,
      lastError: this.st.lastError,
      avOffsetMs: this.avOffsetUs / 1000,
      lastDrawnTs: this.lastDrawnTs
    };
  };

  P.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    caf(this.rafId);
    this.epoch++;
    this._clearQueue();
    this._dropSegments();
    if (this.backend) this.backend.destroy();
    for (var i = 0; i < this._listeners.length; i++) {
      var l = this._listeners[i];
      l[0].removeEventListener(l[1], l[2]);
    }
    try {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch (e2) { /* ignore */ }
    if (this.backend && this.backend.canvas.parentNode) this.backend.canvas.parentNode.removeChild(this.backend.canvas);
  };

  Object.defineProperty(P, 'currentTime', { get: function () { return this.audio ? this.audio.currentTime : 0; } });
  Object.defineProperty(P, 'paused', { get: function () { return !this.audio || this.audio.paused; } });

  global.TStream = {
    CanvasPlayer: CanvasPlayer,
    WebCodecsBackend: WebCodecsBackend,
    Mpeg1Backend: Mpeg1Backend,
    loadJsmpeg: loadJsmpeg,
    canvasFor: canvasFor,
    parseSegment: parseSegment,
    request: request,
    getJSON: getJSON,
    wcConfig: wcConfig
  };
})(this);
