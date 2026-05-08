// Canvas recording.
//
// Two paths:
//   1. MediaRecorder (default) — fast, in-browser, webm/vp9. Records the
//      canvas in real-time at whatever framerate the renderer hits.
//   2. ccapture.js — frame-locked export for high quality. Lazy-loaded
//      from CDN on first use so we don't bloat the bundle.
//
// For mp4: don't try to do mp4 in-browser. Output webm and post-process:
//   ffmpeg -i out.webm -c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4

export class MediaRecorderPath {
  constructor(canvas) {
    this.canvas = canvas;
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
  }

  start({ fps = 60, durationSeconds = 0, bitrate = 20_000_000 } = {}) {
    if (this.recording) return;
    const stream = this.canvas.captureStream(fps);

    // pick the best codec the browser supports
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
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
