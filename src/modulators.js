// =============================================================================
// Modulation sources — turn live signals into 0..1 values per frame.
// Two implementations:
//   AudioModulator  — Web Audio API, 1024-bin FFT, 3 bands + rms
//   CameraModulator — getUserMedia, frame-diff at 64x36 -> motion magnitude
//
// Both expose a unified `update()` returning a plain object of normalized
// signals. main.js applies them additively to params each frame.
// =============================================================================

// -----------------------------------------------------------------------------
// AudioModulator
// -----------------------------------------------------------------------------
export class AudioModulator {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.dataArray = null;
    this.bandIndices = null;
    this.audioEl = null;
    this.lastBands = { bass: 0, mid: 0, treble: 0, rms: 0 };
    // Asymmetric envelope follower: fast attack so kicks punch, slow release
    // so they bleed out naturally instead of averaging into mush.
    this.attackAlpha  = 0.85;
    this.releaseAlpha = 0.10;
    // gamma > 1 expands dynamics — silent stays silent, peaks pop. (gamma < 1
    // would compress, which was the bug in the previous version.)
    this.gamma = 1.4;
  }

  // Lazy-create the AudioContext on first user gesture (file pick).
  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.7;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.audioEl = new Audio();
    this.audioEl.crossOrigin = 'anonymous';
    this.audioEl.loop = true;
    const src = this.ctx.createMediaElementSource(this.audioEl);
    src.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._computeBandIndices();
  }

  _computeBandIndices() {
    const sr = this.ctx.sampleRate;            // typically 44100 or 48000
    const binsPerHz = this.analyser.frequencyBinCount / (sr / 2);
    const idx = (hz) => Math.max(0, Math.min(this.analyser.frequencyBinCount - 1, Math.floor(hz * binsPerHz)));
    this.bandIndices = {
      bass:   [idx(40),    idx(160)],
      mid:    [idx(500),   idx(2000)],
      treble: [idx(4000),  idx(10000)],
    };
  }

  async loadFile(file) {
    this._ensureCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.audioEl.src && this.audioEl.src.startsWith('blob:')) URL.revokeObjectURL(this.audioEl.src);
    this.audioEl.src = URL.createObjectURL(file);
    try { await this.audioEl.play(); } catch {}
  }

  pause() { try { this.audioEl?.pause(); } catch {} }
  resume() { try { this.audioEl?.play(); } catch {} }

  setVolume(v) { if (this.audioEl) this.audioEl.volume = Math.max(0, Math.min(1, v)); }

  update() {
    if (!this.analyser) return this.lastBands;
    this.analyser.getByteFrequencyData(this.dataArray);
    const avg = (lo, hi) => {
      let s = 0, n = 0;
      for (let i = lo; i <= hi; i++) { s += this.dataArray[i]; n++; }
      return n > 0 ? (s / n) / 255 : 0;
    };
    const curve = (x) => Math.pow(x, this.gamma);
    const rawBass   = curve(avg(...this.bandIndices.bass));
    const rawMid    = curve(avg(...this.bandIndices.mid));
    const rawTreble = curve(avg(...this.bandIndices.treble));
    const rawRms    = curve((rawBass + rawMid + rawTreble) / 3);
    // asymmetric envelope follower
    const env = (prev, raw) => {
      const a = raw > prev ? this.attackAlpha : this.releaseAlpha;
      return (1 - a) * prev + a * raw;
    };
    this.lastBands.bass   = env(this.lastBands.bass,   rawBass);
    this.lastBands.mid    = env(this.lastBands.mid,    rawMid);
    this.lastBands.treble = env(this.lastBands.treble, rawTreble);
    this.lastBands.rms    = env(this.lastBands.rms,    rawRms);
    return this.lastBands;
  }
}

// -----------------------------------------------------------------------------
// CameraModulator — frame-difference motion detection
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
    this.smoothed = 0;
    this.stream = null;
    this.lastSignal = { motion: 0 };
    this.alpha = 0.18;
    this.gain  = 1.0 / 25.0; // empirical scale; ~25 avg-diff -> 1.0
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 180, facingMode: 'user' },
      audio: false,
    });
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
    this.smoothed = 0;
  }

  isActive() { return !!this.stream; }

  update() {
    if (!this.stream || this.video.readyState < 2 || this.video.videoWidth === 0) {
      this.lastSignal.motion = this.smoothed;
      return this.lastSignal;
    }
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const cur = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    let diffSum = 0;
    if (this.prev && this.prev.length === cur.length) {
      const len = cur.length;
      for (let i = 0; i < len; i += 4) {
        const dr = Math.abs(cur[i]     - this.prev[i]);
        const dg = Math.abs(cur[i + 1] - this.prev[i + 1]);
        const db = Math.abs(cur[i + 2] - this.prev[i + 2]);
        diffSum += (dr + dg + db);
      }
      // average per pixel (3 channels averaged inline)
      diffSum /= (this.canvas.width * this.canvas.height * 3);
    }
    this.prev = new Uint8ClampedArray(cur);
    const raw = Math.min(1, diffSum * this.gain);
    this.smoothed = (1 - this.alpha) * this.smoothed + this.alpha * raw;
    this.lastSignal.motion = this.smoothed;
    return this.lastSignal;
  }
}
