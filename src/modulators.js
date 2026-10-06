// =============================================================================
// Modulation sources — turn live signals into 0..1 values per frame.
//   AudioModulator  — Web Audio: biquad-filtered bands measured as time-domain
//                     RMS (exact edges, no FFT bin limit), followers with attack
//                     and release in milliseconds (frame-rate independent),
//                     BS.1770-style loudness gate for a normalising gain, a
//                     spectral-flux onset detector against a running median,
//                     and a beat clock folded from onset intervals.
//   CameraModulator — getUserMedia, Lucas-Kanade flow magnitude at 64x36
//                     (frame difference measured brightness change, not motion).
//
// Both expose `update(dtMs)` returning a plain object of normalized signals.
// main.js applies them to params each frame.
// =============================================================================

// one-pole envelope follower, α = 1 − exp(−Δt/τ) per update
export function makeFollower(attackMs, releaseMs) {
  let y = 0;
  return (x, dtMs) => {
    const tau = x > y ? attackMs : releaseMs;
    y += (1 - Math.exp(-Math.max(dtMs, 0.01) / Math.max(tau, 0.01))) * (x - y);
    return y;
  };
}

// -----------------------------------------------------------------------------
// BeatClock — median inter-onset interval folded into 80..160 BPM
// -----------------------------------------------------------------------------
export class BeatClock {
  constructor() { this.onsets = []; this.bpm = 0; this.t0 = 0; this.spread = 1; }
  add(t) {
    this.onsets = this.onsets.filter((x) => t - x < 8).concat(t);
    const ioi = this.onsets.slice(1).map((x, i) => x - this.onsets[i]).filter((d) => d > 0.25 && d < 1.5).sort((a, b) => a - b);
    if (ioi.length >= 6) {
      let p = ioi[ioi.length >> 1];
      while (60 / p < 80) p /= 2;
      while (60 / p > 160) p *= 2;
      this.bpm = 60 / p; this.t0 = t;
      this.spread = (ioi[(ioi.length * 0.75) | 0] - ioi[(ioi.length * 0.25) | 0]) / p;
    }
  }
  confident() { return this.bpm > 0 && this.spread < 0.25 && this.onsets.length >= 8; }
  nextDownbeat(t) { const bar = 240 / this.bpm; return this.t0 + Math.ceil((t - this.t0) / bar) * bar; }
  nextBeat(t) { const b = 60 / this.bpm; return this.t0 + Math.ceil((t - this.t0) / b) * b; }
}

// -----------------------------------------------------------------------------
// AudioModulator
// -----------------------------------------------------------------------------
export class AudioModulator {
  constructor() {
    this.ctx = null;
    this.audioEl = null;
    this.srcNode = null;
    this.file = null;
    this._decoded = null;
    this._decodedFile = null;
    this.captureDest = null;
    this.bands = null;          // RMS readers per band
    this.follow = null;         // followers per band (ms)
    this.onset = null;          // onset detector
    this.loud = null;           // loudness meter
    this.clock = new BeatClock();
    this.gainDb = 0;            // loudness-normalising gain, dB
    this.peak = { sub: 1e-3, kick: 1e-3, snare: 1e-3, hats: 1e-3, rms: 1e-3 };
    this.lastBands = { bass: 0, mid: 0, treble: 0, rms: 0, sub: 0, kick: 0, snare: 0, hats: 0, onset: false, kickOnset: false, lufs: -Infinity, bpm: 0 };
    this.lastOnsetTime = -1e9;
    this.lastKickTime = -1e9;
    this._t = 0;
  }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioEl = new Audio();
    this.audioEl.crossOrigin = 'anonymous';
    this.audioEl.loop = true;
    this.srcNode = this.ctx.createMediaElementSource(this.audioEl);
    this.srcNode.connect(this.ctx.destination);
    const ctx = this.ctx, src = this.srcNode;
    // bands: sub 20..60, kick 60..120, snare body 150..250, hats > 5 kHz (RMS after biquads)
    this.bands = {
      sub:   this._bandReader(ctx, src, 20, 60),
      kick:  this._bandReader(ctx, src, 60, 120),
      snare: this._bandReader(ctx, src, 150, 250),
      hats:  this._bandReader(ctx, src, 5000, 0),
      rms:   this._bandReader(ctx, src, 0, 0),
    };
    this.follow = {
      sub:   makeFollower(30, 400),
      kick:  makeFollower(5, 150),
      snare: makeFollower(5, 150),
      hats:  makeFollower(2, 80),
      rms:   makeFollower(20, 300),
    };
    this.onset = this._makeOnsetDetector(ctx, src);
    this.kickOnset = this._makeOnsetDetector(ctx, this._bandNode(ctx, src, 50, 140), { medianSec: 0.6, minGapMs: 120, delta: 1.8 });
    this.loud = this._makeLoudness(ctx, src);
  }

  _bandNode(ctx, src, lo, hi) {
    let node = src;
    if (lo) node = node.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: lo, Q: 0.707 }));
    if (hi) node = node.connect(new BiquadFilterNode(ctx, { type: 'lowpass',  frequency: hi, Q: 0.707 }));
    return node;
  }
  _bandReader(ctx, src, lo, hi) {
    const node = this._bandNode(ctx, src, lo, hi);
    const an = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0 });
    node.connect(an);
    const buf = new Float32Array(an.fftSize);
    return () => { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
  }

  // half-wave rectified spectral flux, peak-picked against a running median (Bello et al. 2005, Dixon 2006)
  _makeOnsetDetector(ctx, src, { delta = 1.5, lambda = 1e-3, medianSec = 0.5, minGapMs = 100 } = {}) {
    const an = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    src.connect(an);
    const db = new Float32Array(an.frequencyBinCount), prev = new Float32Array(an.frequencyBinCount);
    const hist = []; let last = -1e9, f1 = 0, f2 = 0;
    return (tMs) => {
      an.getFloatFrequencyData(db); let flux = 0;
      for (let k = 1; k < db.length; k++) { const m = Math.log1p(100 * Math.pow(10, db[k] / 20)); const d = m - prev[k]; if (d > 0) flux += d; prev[k] = m; }
      hist.push({ t: tMs, f: flux }); while (hist.length && tMs - hist[0].t > medianSec * 1000) hist.shift();
      const s = hist.map((h) => h.f).sort((a, b) => a - b), thr = delta * (s[s.length >> 1] || 0) + lambda;
      const peak = f1 > thr && f1 >= f2 && f1 > flux && tMs - last > minGapMs;
      const out = peak ? { onset: true, strength: f1 / (thr + 1e-9) } : { onset: false, strength: 0 };
      if (peak) last = tMs; f2 = f1; f1 = flux; return out;   // one-frame latency
    };
  }

  // BS.1770-style gated loudness over a sliding history (mono approximation, 100 ms hop)
  _makeLoudness(ctx, src, historySec = 20) {
    const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1681.97, gain: 4.0 });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 38.13, Q: 0.5 });
    const an = new AnalyserNode(ctx, { fftSize: 16384 });
    src.connect(shelf).connect(hp).connect(an);
    const buf = new Float32Array(an.fftSize), blocks = []; let lastT = -1;
    const Lms = (ms) => -0.691 + 10 * Math.log10(ms + 1e-12);
    return (tSec) => {
      if (tSec - lastT < 0.1) return null; lastT = tSec;
      an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      blocks.push({ t: tSec, ms: s / buf.length }); while (blocks.length && tSec - blocks[0].t > historySec) blocks.shift();
      const abs = blocks.filter((b) => Lms(b.ms) > -70); if (!abs.length) return -Infinity;
      const Labs = Lms(abs.reduce((a, b) => a + b.ms, 0) / abs.length);
      const rel = abs.filter((b) => Lms(b.ms) > Labs - 10);
      return Lms(rel.reduce((a, b) => a + b.ms, 0) / Math.max(1, rel.length));
    };
  }

  async loadFile(file) {
    this._ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.audioEl.src && this.audioEl.src.startsWith('blob:')) URL.revokeObjectURL(this.audioEl.src);
    this.file = file;
    this._decoded = null;
    this.audioEl.src = URL.createObjectURL(file);
    try { await this.audioEl.play(); } catch {}
  }

  pause() { try { this.audioEl?.pause(); } catch {} }
  resume() { try { this.audioEl?.play(); } catch {} }
  hasAudio() { return !!this.file; }

  seekTo(seconds) {
    if (!this.audioEl) return;
    try {
      const dur = this.audioEl.duration;
      this.audioEl.currentTime = (isFinite(dur) && dur > 0) ? ((seconds % dur) + dur) % dur : Math.max(0, seconds);
      this.audioEl.play().catch(() => {});
    } catch {}
  }

  getCaptureStream() {
    this._ensureCtx();
    if (!this.captureDest) {
      this.captureDest = this.ctx.createMediaStreamDestination();
      this.srcNode.connect(this.captureDest);
    }
    return this.captureDest.stream;
  }

  async getDecodedBuffer() {
    if (!this.file) return null;
    this._ensureCtx();
    if (this._decoded && this._decodedFile === this.file) return this._decoded;
    const ab = await this.file.arrayBuffer();
    this._decoded = await this.ctx.decodeAudioData(ab);
    this._decodedFile = this.file;
    return this._decoded;
  }

  setVolume(v) { if (this.audioEl) this.audioEl.volume = Math.max(0, Math.min(1, v)); }

  // dtMs: frame delta. Returns followed, loudness-normalised bands in 0..1 plus events.
  update(dtMs = 16.7) {
    if (!this.bands) return this.lastBands;
    this._t += dtMs;
    const tMs = this._t, tSec = tMs / 1000;
    // loudness → gain so a quiet track and a loud one land in the same slider range (target −14 LUFS)
    const L = this.loud(tSec);
    if (L !== null && isFinite(L)) { this.gainDb += (Math.max(-20, Math.min(30, -14 - L)) - this.gainDb) * 0.2; this.lastBands.lufs = L; }
    const g = Math.pow(10, this.gainDb / 20);
    const out = this.lastBands;
    for (const k of ['sub', 'kick', 'snare', 'hats', 'rms']) {
      const raw = this.bands[k]() * g;
      // running peak with a 5 s release normalises each band to 0..1
      this.peak[k] = Math.max(raw, this.peak[k] * Math.exp(-dtMs / 5000), 1e-3);
      out[k] = this.follow[k](Math.min(1, raw / this.peak[k]), dtMs);
    }
    // legacy names, kept for the routing table
    out.bass = Math.max(out.sub, out.kick);
    out.mid = out.snare;
    out.treble = out.hats;
    const on = this.onset(tMs), ko = this.kickOnset(tMs);
    out.onset = on.onset; out.kickOnset = ko.onset;
    if (on.onset) { this.lastOnsetTime = tSec; this.clock.add(tSec); }
    if (ko.onset) this.lastKickTime = tSec;
    out.bpm = this.clock.confident() ? this.clock.bpm : 0;
    return out;
  }
}

// -----------------------------------------------------------------------------
// CameraModulator — Lucas-Kanade flow magnitude (median, px per frame at 64 wide)
// -----------------------------------------------------------------------------
export class CameraModulator {
  constructor() {
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 64;
    this.canvas.height = 36;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.cur = new Float32Array(64 * 36);
    this.stream = null;
    this.follow = makeFollower(50, 500);
    this.lastSignal = { motion: 0, flowPx: 0 };
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 180, facingMode: 'user' }, audio: false });
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch {}
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
    this.prev = null;
  }

  isActive() { return !!this.stream; }

  // single-level LK over 5x5 windows on a 2 px lattice; valid to about 1 px at 64 wide
  _lkMagnitude(prev, cur, W, H, r = 2) {
    const mags = [];
    for (let y = r + 1; y < H - r - 1; y += 2) for (let x = r + 1; x < W - r - 1; x += 2) {
      let a = 0, b = 0, c = 0, d = 0, e = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const k = (y + j) * W + x + i, Ix = (cur[k + 1] - cur[k - 1]) / 2, Iy = (cur[k + W] - cur[k - W]) / 2, It = cur[k] - prev[k];
        a += Ix * Ix; b += Ix * Iy; c += Iy * Iy; d += Ix * It; e += Iy * It;
      }
      const det = a * c - b * b; if (det < 1e-6) continue;
      mags.push(Math.hypot((-c * d + b * e) / det, (b * d - a * e) / det));
    }
    mags.sort((p, q) => p - q); return mags.length ? mags[mags.length >> 1] : 0;
  }

  update(dtMs = 16.7) {
    if (!this.stream || this.video.readyState < 2 || this.video.videoWidth === 0) {
      return this.lastSignal;
    }
    const W = this.canvas.width, H = this.canvas.height;
    this.ctx.drawImage(this.video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const cur = this.cur;
    for (let i = 0, k = 0; i < px.length; i += 4, k++) cur[k] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    let flow = 0;
    if (this.prev) flow = this._lkMagnitude(this.prev, cur, W, H);
    if (!this.prev) this.prev = new Float32Array(W * H);
    this.prev.set(cur);
    this.lastSignal.flowPx = flow;
    this.lastSignal.motion = this.follow(Math.min(1, flow / 1.0), dtMs);   // 1 px/frame at 64 wide ≈ 30 px at 1920
    return this.lastSignal;
  }
}
