// Canvas recording.
//
// Three paths:
//   1. MediaRecorder      — fast, real-time, webm/vp9. Works everywhere.
//   2. WebCodecsMp4Path   — VideoEncoder + mp4-muxer, H.264 mp4 in-browser,
//                           no ffmpeg. Chrome/Edge/Firefox 113+. Not Safari yet.
//   3. CCapturePath       — frame-locked, slower, webm or PNG sequence.
//                           Lazy-loaded from CDN.
//
// If you need mp4 and WebCodecs isn't available (Safari), record webm and
// post-process: ffmpeg -i out.webm -c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4

export class MediaRecorderPath {
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
  }

  start({ fps = 60, durationSeconds = 0, bitrate = 40_000_000, audioStream = null } = {}) {
    if (this.recording) return;
    const stream = this.canvas.captureStream(fps);
    if (audioStream) {
      for (const t of audioStream.getAudioTracks()) stream.addTrack(t);
    }

    // pick the best codec the browser supports (opus variants when we carry audio)
    const candidates = audioStream
      ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm',
      ]
      : [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    this.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 192_000,
    });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.onstop = () => this._finalize(mimeType);
    this.recorder.start();
    this.recording = true;

    if (durationSeconds > 0) {
      this._timer = setTimeout(() => this.stop(), durationSeconds * 1000);
    }
  }

  stop() {
    if (!this.recording) return;
    clearTimeout(this._timer);
    this.recorder.stop();
    this.recording = false;
  }

  _finalize(mimeType) {
    const blob = new Blob(this.chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duotone-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    this.chunks = [];
  }
}

// ----------------------------------------------------------------------------
// WebCodecsMp4Path — H.264 mp4 in-browser via VideoEncoder + mp4-muxer.
// Frame-paced (called from render loop), so output is always smooth even if
// the renderer isn't hitting the target fps. ~12 Mbps default at 1080p.
// ----------------------------------------------------------------------------
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export class WebCodecsMp4Path {
  constructor(canvas) {
    this.canvas = canvas;
    this.recording = false;
    this.encoder = null;
    this.muxer = null;
    this.frameIdx = 0;
    this.fps = 60;
    this._endAt = Infinity;
    this._inFlight = 0; // unflushed frames the encoder is processing
  }

  static isSupported() {
    return typeof window !== 'undefined'
      && typeof window.VideoEncoder !== 'undefined'
      && typeof window.VideoFrame !== 'undefined';
  }

  async start({
    fps = 60,
    durationSeconds = 0,
    bitrate = 25_000_000,
    latencyMode = 'quality',     // 'quality' (better) | 'realtime' (faster)
    bitrateMode = 'variable',    // 'variable' (VBR, better q@same kbps) | 'constant'
    audio = null,                // { buffer: AudioBuffer, offset: seconds } — muxed in at stop()
  } = {}) {
    if (this.recording) return;
    if (!WebCodecsMp4Path.isSupported()) {
      throw new Error('WebCodecs not supported in this browser — use webm or run on Chrome/Firefox/Edge.');
    }
    this.fps = fps;
    // H.264 requires even dimensions
    const w = this.canvas.width  & ~1;
    const h = this.canvas.height & ~1;

    // Audio track: pick a supported encoder config up front (the muxer needs
    // the track declared at construction). AAC is the universal choice;
    // opus-in-mp4 is the fallback. No support → video-only, never a failure.
    this._audio = null;
    if (audio && audio.buffer && typeof window.AudioEncoder !== 'undefined') {
      const sr = audio.buffer.sampleRate;
      const ch = Math.min(2, audio.buffer.numberOfChannels);
      for (const codec of ['mp4a.40.2', 'opus']) {
        const cfg = { codec, sampleRate: sr, numberOfChannels: ch, bitrate: 192_000 };
        // eslint-disable-next-line no-await-in-loop
        const support = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
        if (support && support.supported) {
          this._audio = { buffer: audio.buffer, offset: audio.offset || 0, cfg };
          break;
        }
      }
      if (!this._audio) console.warn('No supported audio encoder (AAC/opus) — exporting without sound.');
    }

    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      ...(this._audio ? {
        audio: {
          codec: this._audio.cfg.codec === 'opus' ? 'opus' : 'aac',
          numberOfChannels: this._audio.cfg.numberOfChannels,
          sampleRate: this._audio.cfg.sampleRate,
        },
      } : {}),
      fastStart: 'in-memory', // small enough; metadata at start = playable on social platforms
      firstTimestampBehavior: 'offset', // wall-clock stamps don't start at exactly 0
    });

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.muxer.addVideoChunk(chunk, meta);
        this._inFlight = Math.max(0, this._inFlight - 1);
      },
      error: (e) => console.error('VideoEncoder error:', e),
    });

    // Order: prefer high-level/high-profile (better quality, supports 4K) and
    // fall back to lower levels for browsers / hardware that reject the better
    // configs.
    const candidates = [
      'avc1.640034', // High @ 5.2 — up to 4K60+ in spec
      'avc1.640033', // High @ 5.1 — up to 4K30
      'avc1.640028', // High @ 4.0 — 1080p60
      'avc1.42E033', // Baseline @ 5.1
      'avc1.42E01F', // Baseline @ 3.1
      'avc1.42E01E', // Baseline @ 3.0
    ];
    let configured = false;
    for (const codec of candidates) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode, bitrateMode };
      // eslint-disable-next-line no-await-in-loop
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) { this.encoder.configure(cfg); configured = true; break; }
    }
    // Some Chrome builds reject `bitrateMode: 'variable'` for certain configs;
    // retry once with CBR before giving up.
    if (!configured && bitrateMode !== 'constant') {
      for (const codec of candidates) {
        const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode, bitrateMode: 'constant' };
        // eslint-disable-next-line no-await-in-loop
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (support.supported) { this.encoder.configure(cfg); configured = true; break; }
      }
    }
    if (!configured) {
      this.encoder.close();
      throw new Error(`No supported H.264 config at ${w}×${h}. Try lower resolution.`);
    }

    this.frameIdx = 0;
    this._inFlight = 0;
    this._startedAt = performance.now();
    this._endAt = durationSeconds > 0 ? this._startedAt + durationSeconds * 1000 : Infinity;
    this._lastTsUs = 0;
    this._lastKeyUs = -Infinity;
    this.recording = true;
  }

  // Called from render loop AFTER the canvas is drawn for this frame.
  // Paced by WALL CLOCK, not by render frames: rAF fires per display frame
  // (120Hz on ProMotion), so counting frames at 1/fps timestamps produced
  // 2× slow-motion files on 120Hz screens — and audio could never stay in
  // sync. Frames are stamped with real elapsed time; ticks that arrive ahead
  // of the fps schedule are skipped.
  capture() {
    if (!this.recording) return;
    const nowMs = performance.now();
    if (nowMs >= this._endAt) { this.stop(); return; }

    const elapsedUs = Math.round((nowMs - this._startedAt) * 1000);
    if (elapsedUs < this.frameIdx * (1_000_000 / this.fps)) return; // ahead of schedule

    const frame = new VideoFrame(this.canvas, {
      timestamp: elapsedUs,
      duration: 1_000_000 / this.fps,
    });
    const keyFrame = elapsedUs - this._lastKeyUs >= 2_000_000 || this.frameIdx === 0; // key every 2s
    try {
      this.encoder.encode(frame, { keyFrame });
      this._inFlight++;
      if (keyFrame) this._lastKeyUs = elapsedUs;
      this._lastTsUs = elapsedUs;
    } catch (e) {
      console.warn('encode failed:', e);
    } finally {
      frame.close();
    }
    this.frameIdx++;
  }

  async stop() {
    if (!this.recording) return;
    this.recording = false;
    try {
      await this.encoder.flush();
      this.encoder.close();
      if (this._audio && this.frameIdx > 0) {
        try { await this._muxAudio(); }
        catch (e) { console.warn('audio mux failed — exporting video only:', e); }
      }
      this.muxer.finalize();
      const buffer = this.muxer.target.buffer;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duotone-${Date.now()}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('mp4 finalize failed:', e);
    }
    this.encoder = null;
    this.muxer = null;
  }

  // Encode the song into the mp4's audio track. Runs offline at stop() from
  // the decoded AudioBuffer: slice from `offset` for exactly the recorded
  // video duration, looping if the song is shorter than the export.
  async _muxAudio() {
    const { buffer, offset, cfg } = this._audio;
    const durSec = this._lastTsUs / 1_000_000 + 1 / this.fps;
    const sr = cfg.sampleRate;
    const ch = cfg.numberOfChannels;

    const encoder = new AudioEncoder({
      output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error('AudioEncoder error:', e),
    });
    encoder.configure(cfg);

    const startFrame = Math.floor(offset * sr);
    const totalFrames = Math.ceil(durSec * sr);
    const srcLen = buffer.length;
    const CHUNK = 4096;
    let written = 0;
    while (written < totalFrames) {
      const n = Math.min(CHUNK, totalFrames - written);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) {
        const chan = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        for (let i = 0; i < n; i++) {
          data[c * n + i] = chan[(startFrame + written + i) % srcLen]; // loop past end
        }
      }
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate: sr,
        numberOfFrames: n,
        numberOfChannels: ch,
        timestamp: Math.round((written / sr) * 1_000_000),
        data,
      });
      encoder.encode(ad);
      ad.close();
      written += n;
    }
    await encoder.flush();
    encoder.close();
  }
}

// ----------------------------------------------------------------------------
// ccapture.js path — lazy-load from CDN. Useful for frame-locked offline
// exports when MediaRecorder real-time sampling produces stutters.
// ----------------------------------------------------------------------------
let CCaptureGlobal = null;

async function loadCCapture() {
  if (CCaptureGlobal) return CCaptureGlobal;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/ccapture.js@1.1.0/build/CCapture.all.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ccapture.js from CDN'));
    document.head.appendChild(s);
  });
  CCaptureGlobal = window.CCapture;
  return CCaptureGlobal;
}

export class CCapturePath {
  constructor(canvas) {
    this.canvas = canvas;
    this.capturer = null;
    this.recording = false;
  }

  async start({ fps = 60, durationSeconds = 0, format = 'webm' } = {}) {
    if (this.recording) return;
    const CCap = await loadCCapture();
    this.capturer = new CCap({
      format,                    // 'webm' or 'png'
      framerate: fps,
      verbose: false,
      display: false,
      quality: 95,
      name: `duotone-${Date.now()}`,
    });
    this.capturer.start();
    this.recording = true;
    this._endAt = durationSeconds > 0 ? performance.now() + durationSeconds * 1000 : Infinity;
  }

  // call from the main render loop AFTER a frame has been drawn
  capture() {
    if (!this.recording) return;
    this.capturer.capture(this.canvas);
    if (performance.now() >= this._endAt) this.stop();
  }

  stop() {
    if (!this.recording) return;
    this.capturer.stop();
    this.capturer.save();
    this.capturer = null;
    this.recording = false;
  }
}
