/* lab-render.js — clock, placements, render queue and offline encoding for the lab tools.
   Loads after lab-ui.js and extends window.LabUI with Clock, Render.

   Clock: one time axis per tool. Live mode follows the media element (or free-runs for images);
   offline mode is driven frame by frame by Render.run, t = in + i / fps, so a render is the same twice.

   Renderer contract (implemented by each tool):
     canvas                       the canvas that is encoded
     media()      → {blob|url}    the file behind the current source, or null (images, webcam, test card)
     audio(job)   → {buffer, offset} | null   optional: a song to mux (Boiler); file sources mux their own track
     prepare(job)                 resize to job.w × job.h, open job.src.cursor() heads, reset per-run state, seed
     frame(i, t, job)             set source frame(s) for t, advance the simulation by 1 / fps, render; render LAST
     finish(job)                  restore the live state
     preview(p)                   optional: show a placement's ratio / fit / alpha in the live view

   Video decode and encode go through mediabunny (lazy-loaded from a pinned CDN build). PNG sequences are
   packed into a tar; a still is one PNG. */
(function (global) {
  'use strict';
  const LabUI = global.LabUI; if (!LabUI) return;
  const doc = global.document;
  const el = LabUI.el, keys = LabUI.keys, flash = LabUI.flash;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n, w) => String(n).padStart(w, '0');
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return () => this.off(ev, fn); }
    off(ev, fn) { if (this._h[ev]) this._h[ev] = this._h[ev].filter((f) => f !== fn); }
    emit(ev, a) { (this._h[ev] || []).slice().forEach((f) => { try { f(a); } catch (e) { console.error(e); } }); }
  }

  // ================================================================ Clock
  // media = { duration, getTime(), seek(t), play(), pause(), paused() }  (null → free-running)
  class Clock extends Emitter {
    constructor(o) {
      super(); o = o || {};
      this.fps = o.fps || 30; this.length = o.length || 10;
      this.in = 0; this.out = this.length; this.loop = true; this.rangeSet = false;
      this.t = 0; this.playing = o.playing !== false; this.media = null; this.offline = false; this._last = 0;
    }
    get duration() { return (this.media && this.media.duration > 0 && isFinite(this.media.duration)) ? this.media.duration : this.length; }
    get hasRange() { return this.rangeSet; }
    setMedia(m) {
      this.media = m || null; const d = this.duration;
      if (!this.rangeSet) { this.in = 0; this.out = d; }
      else { this.in = clamp(this.in, 0, d); this.out = clamp(this.out, Math.min(d, this.in + 1 / this.fps), d); }
      this.t = this.media && this.media.getTime ? clamp(this.media.getTime(), 0, d) : clamp(this.t, 0, d);
      this.emit('range'); this.emit('time');
    }
    setLength(s) { this.length = Math.max(0.1, +s || 0.1); if (!this.media) { if (!this.rangeSet) this.out = this.length; this.out = Math.min(this.out, this.length); this.in = Math.min(this.in, this.out); } this.emit('range'); }
    setFps(f) { this.fps = clamp(Math.round(+f || 30), 1, 240); this.emit('range'); }
    // called once per live frame
    tick(nowMs) {
      if (this.offline) return;
      const dt = this._last ? clamp((nowMs - this._last) / 1000, 0, 0.25) : 0; this._last = nowMs;
      const m = this.media;
      if (m && m.getTime) {
        this.playing = !m.paused();
        let t = m.getTime();
        if (this.rangeSet && this.playing && (t >= this.out - 0.02 || t < this.in - 0.5)) {
          if (this.loop) { m.seek(this.in); t = this.in; } else { m.pause(); this.playing = false; this.emit('play'); }
        }
        this.t = t;
      } else if (this.playing) {
        let t = this.t + dt;
        if (this.rangeSet && t >= this.out) {
          if (this.loop) t = this.in + ((t - this.in) % Math.max(1e-6, this.out - this.in));
          else { t = this.out; this.playing = false; this.emit('play'); }
        } else if (!this.rangeSet && !this.loop && t >= this.length) { t = this.length; this.playing = false; this.emit('play'); }   // free-running + loop: no wrap, no seam
        this.t = t;
      }
      this.emit('time');
    }
    seek(t) { t = clamp(+t || 0, 0, this.duration); this.t = t; if (this.media && this.media.seek) this.media.seek(t); this.emit('seek', { t }); this.emit('time'); }
    play() { if (this.playing) return; if (this.media && this.media.play) this.media.play(); else if (this.t >= this.out - 1e-6) this.t = this.in; this.playing = true; this._last = 0; this.emit('play'); }
    pause() { if (!this.playing) return; if (this.media && this.media.pause) this.media.pause(); this.playing = false; this.emit('play'); }
    toggle() { if (this.playing) this.pause(); else this.play(); }
    step(n) { this.pause(); this.seek(this.t + n / this.fps); }
    setIn(t) { const d = this.duration; this.in = clamp(t, 0, d); if (this.out <= this.in) this.out = Math.min(d, this.in + 1 / this.fps); this.rangeSet = true; this.emit('range'); }
    setOut(t) { const d = this.duration; this.out = clamp(t, 0, d); if (this.in >= this.out) this.in = Math.max(0, this.out - 1 / this.fps); this.rangeSet = true; this.emit('range'); }
    setRange(a, b) { const d = this.duration; this.in = clamp(Math.min(a, b), 0, d); this.out = clamp(Math.max(a, b), this.in + 1 / this.fps, d); this.rangeSet = true; this.emit('range'); }
    clearRange() { this.in = 0; this.out = this.duration; this.rangeSet = false; this.emit('range'); }
    frames() { return Math.max(1, Math.round((this.out - this.in) * this.fps)); }
    timecode(t) { const fps = this.fps; const f = Math.max(0, Math.round((+t || 0) * fps)); const s = Math.floor(f / fps); return pad(Math.floor(s / 60), 2) + ':' + pad(s % 60, 2) + ':' + pad(f % fps, 2); }
    parse(tc) { const m = String(tc).trim().match(/^(?:(\d+):)?(\d+)(?::(\d+))?(?:\.(\d+))?$/); if (!m) return NaN; const mm = +(m[1] || 0), ss = +m[2], ff = +(m[3] || 0), ms = m[4] ? +('0.' + m[4]) : 0; return mm * 60 + ss + ff / this.fps + ms; }
    getState() { return { in: this.in, out: this.out, loop: this.loop, fps: this.fps, length: this.length, rangeSet: this.rangeSet, t: this.t }; }
    setState(s) { if (!s) return; if (s.fps) this.fps = s.fps; if (s.length) this.length = s.length; this.loop = s.loop !== false; this.rangeSet = !!s.rangeSet; if (this.rangeSet) { this.in = +s.in || 0; this.out = +s.out || this.duration; } else { this.in = 0; this.out = this.duration; } this.emit('range'); }

    // transport strip: in/step/play/step/out, timecode, range bar, loop, fps
    transport(host, o) {
      o = o || {}; const self = this;
      const root = el('div', 'lab-transport');
      const btn = (cls, svg, tip, kbd) => { const b = el('button', 'lab-tool ' + cls); b.type = 'button'; b.innerHTML = '<svg viewBox="0 0 24 24">' + svg + '</svg>'; if (tip) LabUI.bindTip(b, tip, kbd); return b; };
      const grp = el('div', 'lab-tgroup');
      const bIn = btn('lab-tp-in', '<path d="M6 5v14M18 6l-9 6 9 6z"/>', 'Go to in', 'Home');
      const bBack = btn('lab-tp-back', '<path d="M15 6l-7 6 7 6zM8 6v12"/>', 'Previous frame', ',');
      const bPlay = btn('lab-tp-play', '', 'Play / pause', 'Space');
      const bFwd = btn('lab-tp-fwd', '<path d="M9 6l7 6-7 6zM16 6v12"/>', 'Next frame', '.');
      const bOut = btn('lab-tp-out', '<path d="M18 5v14M6 6l9 6-9 6z"/>', 'Go to out', 'End');
      grp.append(bIn, bBack, bPlay, bFwd, bOut);
      const tc = el('input', 'lab-tp-tc'); tc.type = 'text'; tc.spellcheck = false; tc.title = 'timecode  mm:ss:ff';
      const dur = el('span', 'lab-tp-dur');
      const bar = el('div', 'lab-range'); const sel = el('div', 'lab-range-sel'), hIn = el('div', 'lab-range-in'), hOut = el('div', 'lab-range-out'), head = el('div', 'lab-range-head');
      bar.append(sel, hIn, hOut, head); bar.title = 'click: seek · drag handles: in / out · I / O: set at playhead · shift+I / shift+O: clear';
      const bLoop = btn('lab-tp-loop', '<path d="M17 4l3 3-3 3M7 20l-3-3 3-3M20 7H9a4 4 0 0 0-4 4v1M4 17h11a4 4 0 0 0 4-4v-1"/>', 'Loop the range', 'L');
      const bMark = el('div', 'lab-tgroup'); const bI = el('button', 'lab-tool lab-tp-txt', 'I'), bO = el('button', 'lab-tool lab-tp-txt', 'O'); bI.type = bO.type = 'button'; LabUI.bindTip(bI, 'Set in at playhead', 'I'); LabUI.bindTip(bO, 'Set out at playhead', 'O'); bMark.append(bI, bO);
      const fpsW = el('div', 'lab-widget lab-select lab-tp-fps'); const fpsS = el('select'); [24, 25, 30, 50, 60].forEach((f) => { const op = el('option', null, f + ' fps'); op.value = String(f); fpsS.appendChild(op); }); fpsW.appendChild(fpsS); fpsW.title = 'frame rate of the clock and of renders';
      root.append(grp, tc, dur, bar, bMark, bLoop, fpsW);
      host = host || doc.body;
      const spacer = host.querySelector && host.querySelector(':scope > .lab-spacer');
      if (spacer) host.insertBefore(root, spacer); else host.appendChild(root);
      const playSvg = () => { bPlay.innerHTML = '<svg viewBox="0 0 24 24">' + (self.playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M7 4l12 8-12 8z"/>') + '</svg>'; bPlay.classList.toggle('on', self.playing); };
      const drawRange = () => {
        const d = Math.max(1e-6, self.duration); const a = self.rangeSet ? self.in / d : 0, b = self.rangeSet ? self.out / d : 1;
        sel.style.left = (a * 100) + '%'; sel.style.width = ((b - a) * 100) + '%';
        hIn.style.left = (a * 100) + '%'; hOut.style.left = (b * 100) + '%';
        bar.classList.toggle('lab-range-set', self.rangeSet);
        bLoop.classList.toggle('on', self.loop);
        dur.textContent = '/ ' + self.timecode(self.rangeSet ? self.out - self.in : d) + (self.rangeSet ? ' · ' + self.frames() + ' f' : '');
        if (String(self.fps) !== fpsS.value) { fpsS.value = String(self.fps); if (fpsS.value !== String(self.fps)) { const op = el('option', null, self.fps + ' fps'); op.value = String(self.fps); fpsS.appendChild(op); fpsS.value = String(self.fps); } }
      };
      const drawTime = () => {
        const d = Math.max(1e-6, self.duration); const t = (!self.media && !self.rangeSet) ? (self.t % self.length) : self.t;
        head.style.left = (clamp(t / d, 0, 1) * 100) + '%';
        if (doc.activeElement !== tc) tc.value = self.timecode(self.t);
      };
      this.on('range', drawRange); this.on('time', drawTime); this.on('play', playSvg);
      bIn.addEventListener('click', () => self.seek(self.in)); bOut.addEventListener('click', () => self.seek(self.out));
      bBack.addEventListener('click', (e) => self.step(e.shiftKey ? -10 : -1)); bFwd.addEventListener('click', (e) => self.step(e.shiftKey ? 10 : 1));
      bPlay.addEventListener('click', () => self.toggle());
      bLoop.addEventListener('click', () => { self.loop = !self.loop; drawRange(); self.emit('range'); });
      bI.addEventListener('click', () => self.setIn(self.t)); bO.addEventListener('click', () => self.setOut(self.t));
      fpsS.addEventListener('change', () => self.setFps(+fpsS.value));
      tc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = self.parse(tc.value); if (!isNaN(v)) self.seek(v); tc.blur(); } if (e.key === 'Escape') tc.blur(); e.stopPropagation(); });
      tc.addEventListener('blur', drawTime);
      // range bar: scrub, drag the handles
      let drag = null;
      const frac = (e) => { const r = bar.getBoundingClientRect(); return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1); };
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; bar.setPointerCapture(e.pointerId); e.preventDefault();
        drag = e.target === hIn ? 'in' : e.target === hOut ? 'out' : 'seek'; if (drag === 'seek') { if (!e.altKey) self._wasPlaying = self.playing; self.seek(frac(e) * self.duration); } else self[drag === 'in' ? 'setIn' : 'setOut'](frac(e) * self.duration);
      });
      bar.addEventListener('pointermove', (e) => { if (!drag) return; const t = frac(e) * self.duration; if (drag === 'seek') self.seek(t); else if (drag === 'in') self.setIn(t); else self.setOut(t); });
      const up = () => { drag = null; };
      bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
      bar.addEventListener('dblclick', () => self.clearRange());
      if (o.keys !== false) {
        keys.bind('Space', '', () => self.toggle(), { label: 'Play / pause' });
        keys.bind('Comma', '', () => self.step(-1), { label: 'Previous frame' }); keys.bind('Period', '', () => self.step(1), { label: 'Next frame' });
        keys.bind('Comma', 'shift', () => self.step(-10), { label: 'Back 10 frames' }); keys.bind('Period', 'shift', () => self.step(10), { label: 'Forward 10 frames' });
        keys.bind('KeyI', '', () => { self.setIn(self.t); flash('in ' + self.timecode(self.in)); }, { label: 'Set in point' });
        keys.bind('KeyO', '', () => { self.setOut(self.t); flash('out ' + self.timecode(self.out)); }, { label: 'Set out point' });
        keys.bind('KeyI', 'shift', () => { self.clearRange(); flash('range cleared'); }, { label: 'Clear range' });
        keys.bind('KeyO', 'shift', () => { self.clearRange(); flash('range cleared'); }, { label: 'Clear range' });
        keys.bind('KeyL', '', () => { self.loop = !self.loop; self.emit('range'); flash(self.loop ? 'loop on' : 'loop off'); }, { label: 'Toggle loop' });
        keys.bind('Home', '', () => self.seek(self.in), { label: 'Go to in' }); keys.bind('End', '', () => self.seek(self.out), { label: 'Go to out' });
      }
      drawRange(); drawTime(); playSvg();
      this.transportEl = root;
      return root;
    }
  }

  // ================================================================ Render: decode, encode, queue, placements
  const Render = {
    CDN: 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs',
    _lib: null,
    load() { if (!this._lib) this._lib = import(/* webpackIgnore: true */ this.CDN).catch((e) => { this._lib = null; throw new Error('mediabunny failed to load: ' + (e && e.message || e)); }); return this._lib; },
    RATIOS: { source: null, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '21:9': 21 / 9, custom: null },
    RATIO_OPTIONS: [['source', 'source'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'], ['4:5', '4:5'], ['4:3', '4:3'], ['21:9', '21:9'], ['custom', 'custom']],
    SIZE_OPTIONS: [[540, '540 (short side)'], [720, '720'], [1080, '1080'], [1440, '1440'], [2160, '2160']],
    FORMAT_OPTIONS: [['mp4', 'MP4 · H.264'], ['webm', 'WebM · VP9'], ['png', 'PNG sequence (.tar)'], ['still', 'PNG still']],
    FPS_OPTIONS: [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']],
    DEFAULT_NAME: '{tool}_{name}_{w}x{h}_{date}',
    newPlacement(name, over) {
      return Object.assign({ id: uid(), name: name || 'Master', ratio: 'source', size: 1080, w: 1920, h: 1080, fit: 'cover', range: 'range', format: 'mp4', fps: 0, mbps: 20, alpha: false, audio: true, on: true }, over || {});
    },
    // output size of a placement: short side = size, ratio from the list, the source, or custom w × h; always even
    size(p, srcAspect) {
      let w, h;
      if (p.ratio === 'custom') { w = p.w; h = p.h; }
      else {
        const a = (p.ratio === 'source' || !this.RATIOS[p.ratio]) ? (srcAspect || 16 / 9) : this.RATIOS[p.ratio];
        if (a >= 1) { h = p.size; w = Math.round(h * a); } else { w = p.size; h = Math.round(w / a); }
      }
      w = Math.max(2, Math.round(w) & ~1); h = Math.max(2, Math.round(h) & ~1);
      return { w, h };
    },
    aspect(p, srcAspect) { const s = this.size(p, srcAspect); return s.w / s.h; },
    // a job is a placement resolved against the clock and the source
    job(p, clock, srcAspect, o) {
      o = o || {};
      const { w, h } = this.size(p, srcAspect);
      const fps = p.fps > 0 ? p.fps : clock.fps;
      let tIn, tOut;
      if (p.format === 'still') { tIn = tOut = clock.t; }
      else if (p.range === 'clip' || !clock.rangeSet) { tIn = 0; tOut = clock.duration; }
      else { tIn = clock.in; tOut = clock.out; }
      const n = p.format === 'still' ? 1 : Math.max(1, Math.round((tOut - tIn) * fps));
      return Object.assign({}, p, { w, h, fps, in: tIn, out: tOut, n, id: uid(), placement: p.id, tool: o.tool || 'lab', label: p.name });
    },
    fileName(tpl, job) {
      const d = new Date(); const date = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2), time = pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
      const map = { tool: job.tool, name: job.name, w: job.w, h: job.h, fps: job.fps, date, time, in: job.in.toFixed(2), out: job.out.toFixed(2), format: job.format, frames: job.n };
      const s = String(tpl || this.DEFAULT_NAME).replace(/\{(\w+)\}/g, (m, k) => (k in map ? String(map[k]) : m));
      return s.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'render';
    },
    download(blob, name) { const a = doc.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; doc.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); },
    toBlob(canvas) { return new Promise((res, rej) => { if (canvas.convertToBlob) canvas.convertToBlob({ type: 'image/png' }).then(res, rej); else canvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'); }); },
    // the given seconds of an AudioBuffer from offset, looping a shorter song, as a new AudioBuffer
    sliceAudio(buf, offset, seconds, loop) {
      const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels), n = Math.max(1, Math.round(seconds * sr)), start = Math.max(0, Math.floor(offset * sr));
      const out = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: ch });
      for (let c = 0; c < ch; c++) { const src = buf.getChannelData(c), dst = out.getChannelData(c); for (let i = 0; i < n; i++) { const k = start + i; dst[i] = loop ? src[k % src.length] : (k < src.length ? src[k] : 0); } }
      return out;
    },
  };

  // ---------------------------------------------------------------- decoded source: forward cursors with a one-frame lookahead
  class FrameSource {
    static async open(input) {
      const mb = await Render.load();
      const source = (typeof Blob !== 'undefined' && input instanceof Blob) ? new mb.BlobSource(input) : new mb.UrlSource(String(input));
      const inp = new mb.Input({ source, formats: mb.ALL_FORMATS });
      const vt = await inp.getPrimaryVideoTrack(); if (!vt) { inp.dispose && inp.dispose(); throw new Error('no video track in the source'); }
      if (!(await vt.canDecode())) { inp.dispose && inp.dispose(); throw new Error('the browser cannot decode this source (' + vt.codec + ') for offline rendering'); }
      const at = await inp.getPrimaryAudioTrack(); let audioOk = false; try { audioOk = !!(at && await at.canDecode()); } catch (_) { audioOk = false; }
      const fs = new FrameSource(); fs.mb = mb; fs.input = inp; fs.track = vt; fs.audioTrack = audioOk ? at : null; fs.cursors = [];
      fs.duration = await vt.computeDuration(); fs.first = await vt.getFirstTimestamp(); fs.w = vt.displayWidth; fs.h = vt.displayHeight;
      return fs;
    }
    cursor(o) { const c = new Cursor(this, o); this.cursors.push(c); return c; }
    // PCM of [tIn, tIn + seconds) as one AudioBuffer (silence where the track has none)
    async audio(tIn, seconds) {
      if (!this.audioTrack) return null;
      const mb = this.mb; const sink = new mb.AudioBufferSink(this.audioTrack);
      let out = null;
      for await (const wb of sink.buffers(tIn, tIn + seconds)) {
        const b = wb.buffer; if (!out) out = new AudioBuffer({ length: Math.max(1, Math.round(seconds * b.sampleRate)), sampleRate: b.sampleRate, numberOfChannels: Math.min(2, b.numberOfChannels) });
        const off = Math.round((wb.timestamp - tIn) * out.sampleRate);
        for (let c = 0; c < out.numberOfChannels; c++) { const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1)), dst = out.getChannelData(c); const s0 = Math.max(0, -off), d0 = Math.max(0, off), n = Math.min(src.length - s0, dst.length - d0); if (n > 0) dst.set(src.subarray(s0, s0 + n), d0); }
      }
      return out;
    }
    close() { this.cursors.forEach((c) => c.close()); this.cursors = []; try { this.input.dispose && this.input.dispose(); } catch (_) {} }
  }
  class Cursor {
    constructor(fs, o) { this.fs = fs; this.o = o || {}; this.sink = new fs.mb.CanvasSink(fs.track, { poolSize: 0, alpha: !!this.o.alpha }); this.gen = null; this.cur = null; this.nxt = null; this.canvas = null; this.t = -1; }
    async _restart(t) { if (this.gen) { try { await this.gen.return(); } catch (_) {} } this.gen = this.sink.canvases(t); this.cur = null; this.nxt = null; const r = await this.gen.next(); this.cur = r.done ? null : r.value; }
    // the frame on screen at media time t; sequential calls decode forward, a backwards call restarts the decoder
    async at(t) {
      const fs = this.fs; t = clamp(+t || 0, fs.first, Math.max(fs.first, fs.duration - 1e-4));
      if (!this.gen || !this.cur || t < this.cur.timestamp - 1e-4) await this._restart(t);
      for (;;) {
        if (!this.nxt) { const r = await this.gen.next(); this.nxt = r.done ? null : r.value; if (!this.nxt) break; }
        if (this.nxt.timestamp <= t + 1e-4) { this.cur = this.nxt; this.nxt = null; } else break;
      }
      if (this.cur) { this.canvas = this.cur.canvas; this.t = this.cur.timestamp; }
      return this.canvas;
    }
    close() { if (this.gen) { try { this.gen.return(); } catch (_) {} this.gen = null; } }
  }
  Render.FrameSource = FrameSource; Render.Cursor = Cursor;

  // ---------------------------------------------------------------- tar writer (PNG sequences)
  class Tar {
    constructor() { this.parts = []; }
    _header(name, size) {
      const h = new Uint8Array(512); const put = (s, off, len) => { for (let i = 0; i < len && i < s.length; i++) h[off + i] = s.charCodeAt(i) & 0xff; };
      put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
      put(size.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12);   // fixed mtime: the same render gives the same bytes
      put('        ', 148, 8); h[156] = 48; put('ustar\0', 257, 6); put('00', 263, 2);
      let sum = 0; for (let i = 0; i < 512; i++) sum += h[i]; put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      return h;
    }
    add(name, blob) { this.parts.push(this._header(name, blob.size), blob); const r = blob.size % 512; if (r) this.parts.push(new Uint8Array(512 - r)); }
    blob() { this.parts.push(new Uint8Array(1024)); return new Blob(this.parts, { type: 'application/x-tar' }); }
  }
  Render.Tar = Tar;

  // ---------------------------------------------------------------- encoder: mp4 / webm through mediabunny, png / still as files
  class Encoder {
    async start(job, canvas, audio) {
      this.job = job; this.canvas = canvas; this.n = 0;
      if (job.format === 'png') { this.tar = new Tar(); return; }
      if (job.format === 'still') { this.parts = []; return; }
      const mb = await Render.load(); this.mb = mb;
      const isMp4 = job.format === 'mp4';
      const alpha = (job.alpha && !isMp4) ? 'keep' : 'discard';
      const cands = isMp4 ? ['avc', 'hevc'] : ['vp9', 'vp8', 'av1'];
      let codec = null;
      for (const c of cands) { try { if (await mb.canEncodeVideo(c, { width: job.w, height: job.h, bitrate: Math.round(job.mbps * 1e6), alpha })) { codec = c; break; } } catch (_) {} }
      if (!codec && alpha === 'keep') { for (const c of cands) { try { if (await mb.canEncodeVideo(c, { width: job.w, height: job.h, bitrate: Math.round(job.mbps * 1e6) })) { codec = c; break; } } catch (_) {} } }
      if (!codec) throw new Error('no ' + job.format + ' encoder at ' + job.w + '×' + job.h + ' in this browser');
      const target = new mb.BufferTarget();
      this.out = new mb.Output({ format: isMp4 ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(), target });
      this.vsrc = new mb.CanvasSource(canvas, { codec, bitrate: Math.round(job.mbps * 1e6), keyFrameInterval: 2, latencyMode: 'quality', alpha });
      this.out.addVideoTrack(this.vsrc, { frameRate: job.fps });
      if (audio) {
        const ac = isMp4 ? 'aac' : 'opus';
        let ok = false; try { ok = await mb.canEncodeAudio(ac, { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate }); } catch (_) {}
        if (ok) { this.asrc = new mb.AudioBufferSource({ codec: ac, bitrate: 192e3 }); this.out.addAudioTrack(this.asrc); this.audio = audio; }
        else console.warn('lab-render: no ' + ac + ' encoder, exporting without sound');
      }
      await this.out.start();
      if (this.asrc) { await this.asrc.add(this.audio); this.asrc.close(); }
      this.target = target; this.type = isMp4 ? 'video/mp4' : 'video/webm'; this.ext = isMp4 ? 'mp4' : 'webm'; this.codec = codec;
    }
    async add(i) {
      const job = this.job;
      if (this.vsrc) await this.vsrc.add(i / job.fps, 1 / job.fps);
      else { const b = await Render.toBlob(this.canvas); if (this.tar) this.tar.add(pad(i, 5) + '.png', b); else this.parts.push(b); }
      this.n = i + 1;
    }
    async finish() {
      if (this.vsrc) { this.vsrc.close(); await this.out.finalize(); return { blob: new Blob([this.target.buffer], { type: this.type }), ext: this.ext, codec: this.codec }; }
      if (this.tar) return { blob: this.tar.blob(), ext: 'tar' };
      return { blob: this.parts[0], ext: 'png' };
    }
    async cancel() { try { if (this.vsrc) this.vsrc.close(); if (this.out) await this.out.cancel(); } catch (_) {} }
  }
  Render.Encoder = Encoder;

  // ---------------------------------------------------------------- run one job through a renderer
  Render.run = async function (job, r, o) {
    o = o || {}; const signal = o.signal, prog = o.onProgress || (() => {});
    let fs = null, enc = null, result = null;
    const media = r.media ? r.media() : null;
    try {
      if (media && (media.blob || media.url)) {
        try { fs = await FrameSource.open(media.blob || media.url); }
        catch (e) { if (!r.fallback) throw e; console.warn('lab-render: ' + e.message + ' — falling back to element seeking'); fs = null; }
      }
      job.src = fs; if (!job.n) job.n = job.format === 'still' ? 1 : Math.max(1, Math.round((job.out - job.in) * job.fps));
      let audio = null;
      if (job.audio && job.format !== 'png' && job.format !== 'still') {
        const a = r.audio ? await r.audio(job) : null;   // a tool-supplied song wins; otherwise the file's own track
        if (a && a.buffer) audio = Render.sliceAudio(a.buffer, a.offset || 0, job.n / job.fps, a.loop !== false);
        else if (fs && fs.audioTrack) audio = await fs.audio(job.in, job.n / job.fps);
      }
      if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
      await r.prepare(job);
      enc = new Encoder(); await enc.start(job, r.canvas, audio);
      for (let i = 0; i < job.n; i++) {
        if (signal && signal.aborted) throw new DOMException('cancelled', 'AbortError');
        const t = job.format === 'still' ? job.in : job.in + i / job.fps;
        await r.frame(i, t, job);
        await enc.add(i);
        prog(i + 1, job.n);
      }
      result = await enc.finish();
    } catch (e) { if (enc) await enc.cancel(); throw e; }
    finally { try { await r.finish(job); } catch (e) { console.warn('lab-render finish:', e); } if (fs) fs.close(); }
    return result;
  };

  // ---------------------------------------------------------------- queue: sequential jobs with rows
  class Queue extends Emitter {
    constructor(host, o) {
      super(); this.o = o || {}; this.jobs = []; this.running = null;
      this.list = el('div', 'lab-queue'); this.empty = el('div', 'lab-queue-empty', 'nothing queued'); this.list.appendChild(this.empty);
      (host.body || host).appendChild(this.list);
    }
    get busy() { return !!this.running; }
    add(job, renderer) {
      const row = el('div', 'lab-qrow'); const name = el('span', 'lab-qname', job.name), meta = el('span', 'lab-qmeta', job.w + '×' + job.h + ' · ' + job.format + (job.format === 'still' ? '' : ' · ' + job.n + ' f @ ' + job.fps)), bar = el('div', 'lab-qbar'), fill = el('i'), stat = el('span', 'lab-qstat', 'queued'), x = el('button', 'lab-qx', '×');
      bar.appendChild(fill); x.type = 'button'; x.title = 'cancel / remove';
      row.append(name, meta, bar, stat, x); this.list.appendChild(row); this.empty.hidden = true;
      const item = { job, renderer, row, fill, stat, ctrl: new AbortController(), state: 'queued', result: null };
      x.addEventListener('click', () => this.cancel(item));
      this.jobs.push(item); this.emit('change'); this._next(); return item;
    }
    cancel(item) {
      if (item.state === 'running') { item.ctrl.abort(); return; }
      this.jobs = this.jobs.filter((j) => j !== item); item.row.remove(); if (!this.jobs.length) this.empty.hidden = false; this.emit('change');
    }
    clearDone() { this.jobs.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled').forEach((j) => this.cancel(j)); }
    async _next() {
      if (this.running) return;
      const item = this.jobs.find((j) => j.state === 'queued'); if (!item) { this.emit('idle'); return; }
      this.running = item; item.state = 'running'; item.row.classList.add('running'); item.stat.textContent = 'starting';
      const t0 = performance.now();
      try {
        const res = await Render.run(item.job, item.renderer, { signal: item.ctrl.signal, onProgress: (i, n) => { item.fill.style.width = (i / n * 100).toFixed(1) + '%'; if (i === n || (i & 3) === 0) item.stat.textContent = i + ' / ' + n; } });
        item.result = res; item.state = 'done'; item.row.classList.add('done');
        const name = Render.fileName(item.job.nameTpl, item.job) + '.' + res.ext;
        item.stat.textContent = 'done · ' + (res.blob.size / 1e6).toFixed(1) + ' MB · ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s';
        item.fill.style.width = '100%';
        if (this.o.download !== false) Render.download(res.blob, name);
        this.emit('done', { item, name });
      } catch (e) {
        if (e && e.name === 'AbortError') { item.state = 'cancelled'; item.stat.textContent = 'cancelled'; }
        else { item.state = 'failed'; item.stat.textContent = 'failed · ' + (e && e.message || e); console.error('lab-render:', e); }
        item.row.classList.add(item.state);
        this.emit('fail', { item, error: e });
      }
      item.row.classList.remove('running'); this.running = null; this.emit('change');
      this._next();
    }
  }
  Render.Queue = Queue;

  // ---------------------------------------------------------------- placements editor + queue folder
  // Render.folder(pane, { tool, folder?, renderer, clock, project?, srcAspect:()=>a, placements?: [] })
  Render.folder = function (pane, o) {
    o = o || {}; const tool = o.tool || 'lab';
    const f = o.folder || pane.addFolder({ title: 'Export', expanded: false });
    const state = { placements: Array.isArray(o.placements) && o.placements.length ? o.placements : [Render.newPlacement('Master')], current: null, nameTpl: Render.DEFAULT_NAME };
    state.current = state.placements[0].id;
    const cur = Object.assign({}, state.placements[0]);
    const find = (id) => state.placements.find((p) => p.id === id);
    const touch = () => { if (o.project) o.project.touch(); api.emit('change'); };
    // placement picker row
    const row = el('div', 'lab-row'); row.appendChild(el('label', null, 'placement'));
    const w = el('div', 'lab-widget lab-select'); const sel = el('select'); w.appendChild(sel); row.appendChild(w); f.body.appendChild(row);
    const btns = f.addButtons([{ title: '+ add', key: 'add' }, { title: 'duplicate', key: 'dup' }, { title: 'remove', key: 'del' }], { cols: 3 });
    const fillSel = () => { sel.textContent = ''; state.placements.forEach((p) => { const op = el('option', null, p.name + (p.on ? '' : ' (off)')); op.value = p.id; sel.appendChild(op); }); sel.value = state.current; };
    const select = (id) => { const p = find(id) || state.placements[0]; state.current = p.id; Object.assign(cur, p); fillSel(); f.refresh(); sync(); if (o.renderer && o.renderer.preview) o.renderer.preview(p); };
    sel.addEventListener('change', () => select(sel.value));
    btns.buttons.add.addEventListener('click', () => { const p = Render.newPlacement('Placement ' + (state.placements.length + 1), { ratio: '9:16', size: 1080 }); state.placements.push(p); select(p.id); touch(); });
    btns.buttons.dup.addEventListener('click', () => { const p = Object.assign({}, find(state.current), { id: uid(), name: cur.name + ' copy' }); state.placements.push(p); select(p.id); touch(); });
    btns.buttons.del.addEventListener('click', () => { if (state.placements.length <= 1) { flash('keep at least one placement'); return; } state.placements = state.placements.filter((p) => p.id !== state.current); select(state.placements[0].id); touch(); });
    // the editor binds to `cur`; every change is copied back into the placement
    const bName = f.addBinding(cur, 'name', { label: 'name', view: 'text' });
    const bRatio = f.addBinding(cur, 'ratio', { label: 'ratio', options: Render.RATIO_OPTIONS, view: 'list' });
    const bSize = f.addBinding(cur, 'size', { label: 'size', options: Render.SIZE_OPTIONS, view: 'list' });
    const bW = f.addBinding(cur, 'w', { label: 'width', min: 16, max: 8192, step: 2 });
    const bH = f.addBinding(cur, 'h', { label: 'height', min: 16, max: 8192, step: 2 });
    const bFit = f.addBinding(cur, 'fit', { label: 'fit', options: [['cover', 'cover (fill, crop)'], ['contain', 'contain (letterbox)']], view: 'list' });
    const bRange = f.addBinding(cur, 'range', { label: 'range', options: [['range', 'in → out'], ['clip', 'whole clip']], view: 'list' });
    const bFormat = f.addBinding(cur, 'format', { label: 'format', options: Render.FORMAT_OPTIONS, view: 'list' });
    const bFps = f.addBinding(cur, 'fps', { label: 'fps', options: [[0, 'clock']].concat(Render.FPS_OPTIONS), view: 'list' });
    const bMbps = f.addBinding(cur, 'mbps', { label: 'Mbps', min: 2, max: 120, step: 1 });
    const bAlpha = f.addBinding(cur, 'alpha', { label: 'transparent' });
    const bAudio = f.addBinding(cur, 'audio', { label: 'audio' });
    const bOn = f.addBinding(cur, 'on', { label: 'in render all' });
    const nameHolder = { v: state.nameTpl }; const bTpl = f.addBinding(nameHolder, 'v', { label: 'file name', view: 'text' });
    bTpl.on('change', () => { state.nameTpl = nameHolder.v || Render.DEFAULT_NAME; touch(); });
    const info = f.addStatus('');
    const sync = () => {
      const custom = cur.ratio === 'custom'; bW.element.hidden = bH.element.hidden = !custom; bSize.element.hidden = custom;
      const vid = cur.format === 'mp4' || cur.format === 'webm'; bMbps.element.hidden = !vid; bAudio.element.hidden = !vid; bFps.element.hidden = cur.format === 'still'; bRange.element.hidden = cur.format === 'still';
      bAlpha.element.hidden = cur.format === 'mp4';
      const a = o.srcAspect ? o.srcAspect() : 16 / 9; const s = Render.size(cur, a); const clock = o.clock;
      let txt = s.w + ' × ' + s.h;
      if (clock && cur.format !== 'still') { const fps = cur.fps > 0 ? cur.fps : clock.fps; const span = (cur.range === 'clip' || !clock.rangeSet) ? clock.duration : (clock.out - clock.in); txt += ' · ' + Math.max(1, Math.round(span * fps)) + ' frames · ' + span.toFixed(2) + ' s @ ' + fps; }
      info.set ? info.set(txt) : (info.element.textContent = txt);
    };
    [bName, bRatio, bSize, bW, bH, bFit, bRange, bFormat, bFps, bMbps, bAlpha, bAudio, bOn].forEach((b) => b.on('change', (ev) => {
      if (ev && ev.last === false) return;
      const p = find(state.current); if (!p) return; Object.assign(p, cur, { id: p.id }); fillSel(); sync(); touch();
      if (o.renderer && o.renderer.preview && b !== bName && b !== bOn) o.renderer.preview(p);
    }));
    if (o.clock) o.clock.on('range', sync);
    const act = f.addButtons([{ title: 'Render this', key: 'one', accent: true }, { title: 'Render all', key: 'all' }, { title: 'Still now', key: 'still' }], { cols: 3 });
    const qf = f.addFolder({ title: 'Queue', expanded: true });
    const queue = new Queue(qf, { download: o.download });
    const qb = qf.addButtons([{ title: 'clear finished', key: 'clear' }], { cols: 1 }); qb.buttons.clear.addEventListener('click', () => queue.clearDone());
    const enqueue = (p, over) => {
      if (!o.renderer) return null;
      const a = o.srcAspect ? o.srcAspect() : 16 / 9;
      const job = Render.job(Object.assign({}, p, over || {}), o.clock, a, { tool }); job.nameTpl = state.nameTpl;
      qf.expanded = true;
      return queue.add(job, o.renderer);
    };
    act.buttons.one.addEventListener('click', () => enqueue(find(state.current)));
    act.buttons.all.addEventListener('click', () => { const on = state.placements.filter((p) => p.on); if (!on.length) flash('no placement is in render all'); on.forEach((p) => enqueue(p)); });
    act.buttons.still.addEventListener('click', () => enqueue(find(state.current), { format: 'still', name: cur.name + '_still' }));
    const api = Object.assign(new Emitter(), {
      folder: f, queue, state, select, enqueue, sync,
      get placements() { return state.placements; },
      getState() { return { placements: state.placements.map((p) => Object.assign({}, p)), current: state.current, nameTpl: state.nameTpl }; },
      setState(s) { if (!s || !Array.isArray(s.placements) || !s.placements.length) return; state.placements = s.placements.map((p) => Object.assign(Render.newPlacement(), p)); state.nameTpl = s.nameTpl || Render.DEFAULT_NAME; nameHolder.v = state.nameTpl; select(s.current && find(s.current) ? s.current : state.placements[0].id); },
    });
    select(state.current);
    if (o.project && o.project.register) o.project.register('render', { get: () => api.getState(), set: (s) => api.setState(s) });
    return api;
  };

  LabUI.Clock = Clock; LabUI.Render = Render;
})(typeof window !== 'undefined' ? window : globalThis);
