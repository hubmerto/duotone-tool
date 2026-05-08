// =============================================================================
// DUOTONE — entry. WebGL2 + <video> texture + Tweakpane UI + recording.
// All effect math is in shader.frag — this file is plumbing.
// =============================================================================

import { Pane } from 'tweakpane';
import vertSrc from './shader.vert?raw';
import fragSrc from './shader.frag?raw';
import {
  PRESETS, DEFAULT_PRESET, applyPreset, downloadPreset, readPresetFile,
} from './presets.js';
import { MediaRecorderPath, CCapturePath, WebCodecsMp4Path } from './recorder.js';
import { AudioModulator, CameraModulator } from './modulators.js';

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------
const params = { ...PRESETS[DEFAULT_PRESET] };
// Format is the single primary control; engine is derived from it.
//   mp4         -> WebCodecs H.264 (Chrome/Firefox/Edge; not Safari)
//   webm        -> MediaRecorder VP9 (real-time, all browsers)
//   webm-locked -> ccapture.js (frame-locked webm)
//   png         -> ccapture.js PNG sequence
const exportSettings = {
  format: WebCodecsMp4Path.isSupported() ? 'mp4' : 'webm',
  durationSeconds: 6,
  fps: 60,
  bitrateMbps: 12,         // mp4 only
};
const sourceState = {
  preset: DEFAULT_PRESET,
  loop: true,
  playing: true,
};

// Modulation: drives params automatically from audio/camera signals.
// All offsets are additive on top of the user's manual values; manual
// sliders still set the baseline. Modulation is allowed to push past
// the slider's upper bound so transients can hit values you wouldn't
// dial in manually (kicks should over-shoot).
const modulation = {
  mode: 'none',     // 'none' | 'audio' | 'camera'
  audio: {
    volume:      0.6,
    intensity:   1.0,     // master multiplier on every audio routing (0..3)
    // each value is the max effect at signal=1 with intensity=1
    bassToSlow:   0.45,   // bass kick -> slowAmp (ink blob swell)
    bassToWarp:   0.05,   // bass kick -> warpAmp (image punches sideways)
    bassToFlash:  0.22,   // bass kick -> threshold drops -> frame flashes color
    midToSpeed:   0.45,   // mids      -> slowNoiseSpeed (field accelerates)
    trebleToWarp: 0.04,   // hi-hat    -> warpAmp (ripple)
    rmsToBoil:    0.14,   // loudness  -> ditherAmp (grainier when loud)
  },
  camera: {
    warpDepth:   0.05,    // motion -> warpAmp           (+)
    lfoDepth:    0.08,    // motion -> thresholdLFOAmp   (+)
    flashDepth:  0.15,    // motion -> threshold flash   (-)
  },
};

// Live signal values (updated each frame). Bound to Tweakpane graph monitors
// so you can SEE what's driving things.
const monitor = { bass: 0, mid: 0, treble: 0, rms: 0, motion: 0 };

// effect time is separate from wallclock — "Replay intro" resets this
let effectStart = performance.now();
let frameCount = 0;

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const canvas      = document.getElementById('stage');
const video       = document.getElementById('source-video');
const imageEl     = document.getElementById('source-image');
const dropOverlay = document.getElementById('dropzone-overlay');
const hint        = document.getElementById('hint');

// Which source the texture is currently bound to. Video uploads each frame;
// image uploads once on load and the texture is reused.
let currentSource = 'none'; // 'none' | 'video' | 'image'

// hidden file pickers (Tweakpane has no native file input)
const mediaPicker  = makeHiddenInput('file', 'video/*,image/*');
const presetPicker = makeHiddenInput('file', 'application/json,.json');
const audioPicker  = makeHiddenInput('file', 'audio/*');

function makeHiddenInput(type, accept) {
  const i = document.createElement('input');
  i.type = type; i.accept = accept;
  i.style.display = 'none';
  document.body.appendChild(i);
  return i;
}

function showFatal(message) {
  const p = document.createElement('p');
  p.textContent = message;
  p.style.cssText = 'color:#0DFF00;font-family:monospace;padding:24px;letter-spacing:0.08em;';
  document.body.replaceChildren(p);
}

// -----------------------------------------------------------------------------
// WebGL2 setup
// -----------------------------------------------------------------------------
const gl = canvas.getContext('webgl2', {
  preserveDrawingBuffer: true,   // needed for canvas.captureStream + ccapture
  antialias: false,
  alpha: false,
  premultipliedAlpha: false,
});
if (!gl) {
  showFatal('WEBGL2 NOT SUPPORTED');
  throw new Error('WebGL2 not available');
}

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    console.error('shader compile error:\n', info, '\nsource:\n', src);
    throw new Error(info);
  }
  return sh;
}

function link(vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link error: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

const program = link(vertSrc, fragSrc);

// fullscreen quad (triangle strip)
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1,  1, -1, -1,  1,  1,  1]),
  gl.STATIC_DRAW,
);
const aPos = gl.getAttribLocation(program, 'a_position');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

// video texture
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,    gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,    gl.CLAMP_TO_EDGE);
// upload a 1x1 black placeholder so texture is "complete" before first frame
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));

// uniforms
const U = {};
for (const name of [
  'u_video','u_resolution','u_time','u_frame','u_spotColor',
  'u_thresholdBase','u_thresholdLFOAmp','u_thresholdLFOFreq',
  'u_introDuration','u_introCurve',
  'u_slowNoiseScale','u_slowNoiseSpeed','u_slowAmp','u_warpAmp',
  'u_ditherScale','u_ditherSpeed','u_ditherAmp',
  'u_softness',
]) U[name] = gl.getUniformLocation(program, name);

// -----------------------------------------------------------------------------
// resize: canvas backing store matches video resolution (capped at 1920x1080
// for export sanity); CSS letterboxes inside viewport.
// -----------------------------------------------------------------------------
function resize() {
  // unified source dims (image or video)
  let vw = 1920, vh = 1080;
  if (currentSource === 'image' && imageEl.naturalWidth > 0) {
    vw = imageEl.naturalWidth;
    vh = imageEl.naturalHeight;
  } else if (video.videoWidth > 0) {
    vw = video.videoWidth;
    vh = video.videoHeight;
  }

  // Cap backing store at 1920x1080 for export sanity / perf
  const MAX_W = 1920, MAX_H = 1080;
  const sc = Math.min(MAX_W / vw, MAX_H / vh, 1);
  const bw = Math.round(vw * sc);
  const bh = Math.round(vh * sc);

  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width  = bw;
    canvas.height = bh;
  }

  // CSS layout: letterbox inside viewport at native AR
  const winW = window.innerWidth, winH = window.innerHeight;
  const ar  = bw / bh;
  const winAR = winW / winH;
  let cw, ch;
  if (ar > winAR) { cw = winW; ch = winW / ar; }
  else            { ch = winH; cw = winH * ar; }
  canvas.style.width  = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.style.left   = `${(winW - cw) / 2}px`;
  canvas.style.top    = `${(winH - ch) / 2}px`;

  gl.viewport(0, 0, bw, bh);
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function loadVideoFromFile(file) {
  if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  if (imageEl.src && imageEl.src.startsWith('blob:')) URL.revokeObjectURL(imageEl.src);
  imageEl.removeAttribute('src');
  video.src = URL.createObjectURL(file);
  video.loop = sourceState.loop;
  video.play().catch(() => {});
  currentSource = 'video';
  effectStart = performance.now();
  frameCount = 0;
}

function loadVideoFromUrl(url) {
  video.src = url;
  video.loop = sourceState.loop;
  video.play().catch(() => {});
  currentSource = 'video';
  effectStart = performance.now();
  frameCount = 0;
}

async function loadImageFromFile(file) {
  if (imageEl.src && imageEl.src.startsWith('blob:')) URL.revokeObjectURL(imageEl.src);
  imageEl.src = URL.createObjectURL(file);
  try { await imageEl.decode(); } catch { /* fall through; onload will fire eventually */ }

  // upload once — texture stays in GPU memory, render loop reuses it
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, imageEl);

  // pause & detach video so we don't keep blitting black frames over the image
  video.pause();
  if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.load();

  currentSource = 'image';
  effectStart = performance.now();
  frameCount = 0;
  resize();
}

// -----------------------------------------------------------------------------
// localStorage — last preset + UI state (no video data)
// -----------------------------------------------------------------------------
// bumped to v2 when warpAmp was added — invalidates v1 saves so the new
// default tuning (with warp + lower boil) is picked up on first reload.
const LS_KEY = 'duotone:lastState:v2';

function saveStateToLocalStorage() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ params, sourceState })); }
  catch {}
}

function loadStateFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.params) Object.assign(params, saved.params);
    if (saved?.sourceState) Object.assign(sourceState, saved.sourceState);
  } catch {}
}

// -----------------------------------------------------------------------------
// recording + modulation instances
// -----------------------------------------------------------------------------
const mediaPath  = new MediaRecorderPath(canvas);
const ccapPath   = new CCapturePath(canvas);
const mp4Path    = new WebCodecsMp4Path(canvas);
const audioMod   = new AudioModulator();
const cameraMod  = new CameraModulator();

// Compute "live" params: base params + modulation offsets. main.js never
// mutates `params` itself, so the UI sliders keep their meaning.
//
// Upper clamps here are *higher than the slider maxes* on purpose —
// modulation peaks should be allowed to overshoot the values you'd
// reasonably dial in manually. That's where the drama comes from.
function computeLiveParams() {
  const lp = { ...params };
  if (modulation.mode === 'audio') {
    const m = audioMod.update();
    monitor.bass = m.bass; monitor.mid = m.mid;
    monitor.treble = m.treble; monitor.rms = m.rms;
    const A = modulation.audio;
    const k = A.intensity;
    // bass: fattest routing — swell + punch + flash
    lp.slowAmp        = clamp(lp.slowAmp        + m.bass   * A.bassToSlow   * k, 0, 1.20);
    lp.warpAmp        = clamp((lp.warpAmp ?? 0)
                              + m.bass   * A.bassToWarp   * k
                              + m.treble * A.trebleToWarp * k,                  0, 0.15);
    lp.thresholdBase  = clamp(lp.thresholdBase  - m.bass   * A.bassToFlash  * k, 0, 1.0 );
    // mid: blob field accelerates
    lp.slowNoiseSpeed = clamp(lp.slowNoiseSpeed + m.mid    * A.midToSpeed   * k, 0, 2.0 );
    // rms: grainier when loud
    lp.ditherAmp      = clamp(lp.ditherAmp      + m.rms    * A.rmsToBoil    * k, 0, 0.50);
  } else if (modulation.mode === 'camera') {
    const m = cameraMod.update();
    monitor.motion = m.motion;
    const C = modulation.camera;
    lp.warpAmp         = clamp((lp.warpAmp ?? 0) + m.motion * C.warpDepth,   0, 0.15);
    lp.thresholdLFOAmp = clamp(lp.thresholdLFOAmp + m.motion * C.lfoDepth,   0, 0.30);
    lp.thresholdBase   = clamp(lp.thresholdBase   - m.motion * C.flashDepth, 0, 1.0 );
  } else {
    monitor.bass = monitor.mid = monitor.treble = monitor.rms = monitor.motion = 0;
  }
  return lp;
}

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

async function setModulationMode(next) {
  // teardown current
  if (modulation.mode === 'audio')  audioMod.pause();
  if (modulation.mode === 'camera') cameraMod.stop();
  modulation.mode = next;
  if (next === 'audio')  audioMod.resume();
  if (next === 'camera') {
    try { await cameraMod.start(); }
    catch (e) {
      console.warn('Camera permission denied or unavailable:', e);
      modulation.mode = 'none';
      pane.refresh();
    }
  }
}

// -----------------------------------------------------------------------------
// render loop
// -----------------------------------------------------------------------------
function frameTick() {
  // upload current video frame to texture (only when source is a video —
  // images are uploaded once on load and reused)
  if (currentSource === 'video'
      && video.readyState >= video.HAVE_CURRENT_DATA
      && video.videoWidth > 0) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  }

  // ensure backing-store size matches latest source dims
  const srcW = currentSource === 'image' ? (imageEl.naturalWidth || 0) : (video.videoWidth || 0);
  if (srcW > 0 && (canvas.width === 1 || canvas.height === 1)) {
    resize();
  }

  gl.useProgram(program);
  gl.bindVertexArray(vao);

  const t = (performance.now() - effectStart) / 1000;
  const c = hexToRgb(params.spotColor);
  const lp = computeLiveParams();   // base params + modulation offsets

  gl.uniform1i(U.u_video, 0);
  gl.uniform2f(U.u_resolution, canvas.width, canvas.height);
  gl.uniform1f(U.u_time, t);
  gl.uniform1i(U.u_frame, frameCount);
  gl.uniform3f(U.u_spotColor, c[0], c[1], c[2]);

  gl.uniform1f(U.u_thresholdBase,    lp.thresholdBase);
  gl.uniform1f(U.u_thresholdLFOAmp,  lp.thresholdLFOAmp);
  gl.uniform1f(U.u_thresholdLFOFreq, lp.thresholdLFOFreq);

  gl.uniform1f(U.u_introDuration, lp.introDuration);
  gl.uniform1i(U.u_introCurve,    lp.introCurve | 0);

  gl.uniform1f(U.u_slowNoiseScale, lp.slowNoiseScale);
  gl.uniform1f(U.u_slowNoiseSpeed, lp.slowNoiseSpeed);
  gl.uniform1f(U.u_slowAmp,        lp.slowAmp);
  gl.uniform1f(U.u_warpAmp,        lp.warpAmp ?? 0.0);

  gl.uniform1f(U.u_ditherScale, lp.ditherScale);
  gl.uniform1f(U.u_ditherSpeed, lp.ditherSpeed);
  gl.uniform1f(U.u_ditherAmp,   lp.ditherAmp);

  gl.uniform1f(U.u_softness, lp.softness);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (ccapPath.recording) ccapPath.capture();
  if (mp4Path.recording)  mp4Path.capture();
  frameCount++;
  requestAnimationFrame(frameTick);
}

// -----------------------------------------------------------------------------
// Tweakpane UI
// -----------------------------------------------------------------------------
const pane = new Pane({ title: 'DUOTONE', expanded: true });

// --- Source ---
{
  const f = pane.addFolder({ title: 'Source', expanded: true });
  f.addButton({ title: 'Pick file… (video / image)' }).on('click', () => mediaPicker.click());
  f.addButton({ title: 'Use sample' }).on('click', () => loadVideoFromUrl('/samples/sample.mp4'));
  f.addBinding(sourceState, 'playing', { label: 'play' }).on('change', (ev) => {
    if (ev.value) video.play(); else video.pause();
  });
  f.addBinding(sourceState, 'loop').on('change', (ev) => { video.loop = ev.value; });
}

// --- Color ---
{
  const f = pane.addFolder({ title: 'Color', expanded: true });
  f.addBinding(params, 'spotColor', { label: 'spot' });
  f.addBlade({
    view: 'list',
    label: 'preset',
    options: [
      { text: 'green',  value: 'green' },
      { text: 'orange', value: 'orange' },
      { text: 'blue',   value: 'blue' },
      { text: 'custom', value: 'custom' },
    ],
    value: sourceState.preset,
  }).on('change', (ev) => {
    sourceState.preset = ev.value;
    if (ev.value !== 'custom') {
      applyPreset(params, PRESETS[ev.value]);
      pane.refresh();
      saveStateToLocalStorage();
    }
  });
}

// --- Threshold ---
{
  const f = pane.addFolder({ title: 'Threshold', expanded: false });
  f.addBinding(params, 'thresholdBase',    { label: 'base',    min: 0,    max: 1,   step: 0.005 });
  f.addBinding(params, 'thresholdLFOAmp',  { label: 'lfo amp', min: 0,    max: 0.3, step: 0.005 });
  f.addBinding(params, 'thresholdLFOFreq', { label: 'lfo hz',  min: 0.01, max: 1.0, step: 0.01  });
}

// --- Intro ---
{
  const f = pane.addFolder({ title: 'Intro', expanded: false });
  f.addBinding(params, 'introDuration', { label: 'duration', min: 0, max: 6, step: 0.05 });
  f.addBlade({
    view: 'list',
    label: 'curve',
    options: [
      { text: 'linear',     value: 0 },
      { text: 'easeOut',    value: 1 },
      { text: 'easeInOut',  value: 2 },
    ],
    value: params.introCurve,
  }).on('change', (ev) => { params.introCurve = ev.value | 0; });
  f.addButton({ title: 'Replay intro' }).on('click', () => {
    effectStart = performance.now();
    frameCount = 0;
  });
}

// --- Slow Field ---
{
  const f = pane.addFolder({ title: 'Slow Field', expanded: false });
  f.addBinding(params, 'slowNoiseScale', { label: 'scale',  min: 0.5, max: 12,   step: 0.1   });
  f.addBinding(params, 'slowNoiseSpeed', { label: 'speed',  min: 0,   max: 1,    step: 0.005 });
  f.addBinding(params, 'slowAmp',        { label: 'amp',    min: 0,   max: 0.6,  step: 0.005 });
  // morphism knob — UV warp by the same field; tiny values go a long way
  f.addBinding(params, 'warpAmp',        { label: 'warp',   min: 0,   max: 0.06, step: 0.001 });
}

// --- Boil ---
{
  const f = pane.addFolder({ title: 'Boil', expanded: false });
  f.addBinding(params, 'ditherScale', { label: 'scale', min: 50,  max: 1500, step: 5    });
  f.addBinding(params, 'ditherSpeed', { label: 'speed', min: 0,   max: 1,    step: 0.01 });
  f.addBinding(params, 'ditherAmp',   { label: 'amp',   min: 0,   max: 0.3,  step: 0.005 });
}

// --- Edge ---
{
  const f = pane.addFolder({ title: 'Edge', expanded: false });
  f.addBinding(params, 'softness', { label: 'softness', min: 0, max: 0.05, step: 0.001 });
}

// --- Modulation ---
{
  const f = pane.addFolder({ title: 'Modulation', expanded: false });

  f.addBlade({
    view: 'list',
    label: 'mode',
    options: [
      { text: 'none (manual)', value: 'none'   },
      { text: 'audio file',    value: 'audio'  },
      { text: 'webcam motion', value: 'camera' },
    ],
    value: modulation.mode,
  }).on('change', (ev) => { setModulationMode(ev.value); });

  // ---- audio sub-section
  f.addButton({ title: 'Pick audio file…' }).on('click', () => audioPicker.click());
  f.addBinding(modulation.audio, 'volume',       { label: 'audio vol',   min: 0, max: 1,    step: 0.01  })
    .on('change', (ev) => audioMod.setVolume(ev.value));
  // master intensity — turn this up to make EVERYTHING crazier at once
  f.addBinding(modulation.audio, 'intensity',    { label: 'INTENSITY',   min: 0, max: 3,    step: 0.05  });
  f.addBinding(modulation.audio, 'bassToSlow',   { label: 'bass→swell',  min: 0, max: 1.0,  step: 0.01  });
  f.addBinding(modulation.audio, 'bassToWarp',   { label: 'bass→warp',   min: 0, max: 0.12, step: 0.002 });
  f.addBinding(modulation.audio, 'bassToFlash',  { label: 'bass→flash',  min: 0, max: 0.50, step: 0.01  });
  f.addBinding(modulation.audio, 'midToSpeed',   { label: 'mid→speed',   min: 0, max: 1.0,  step: 0.01  });
  f.addBinding(modulation.audio, 'trebleToWarp', { label: 'tre→warp',    min: 0, max: 0.10, step: 0.001 });
  f.addBinding(modulation.audio, 'rmsToBoil',    { label: 'rms→boil',    min: 0, max: 0.40, step: 0.005 });

  // ---- camera sub-section
  f.addButton({ title: 'Start / stop webcam' }).on('click', async () => {
    if (cameraMod.isActive()) {
      cameraMod.stop();
      if (modulation.mode === 'camera') setModulationMode('none');
    } else {
      try { await cameraMod.start(); modulation.mode = 'camera'; pane.refresh(); }
      catch (e) { console.warn('camera failed', e); }
    }
  });
  f.addBinding(modulation.camera, 'warpDepth',  { label: 'mot→warp',  min: 0, max: 0.15, step: 0.001 });
  f.addBinding(modulation.camera, 'lfoDepth',   { label: 'mot→lfo',   min: 0, max: 0.30, step: 0.005 });
  f.addBinding(modulation.camera, 'flashDepth', { label: 'mot→flash', min: 0, max: 0.40, step: 0.005 });

  // ---- live monitors (graphs)
  const gOpts = { view: 'graph', readonly: true, min: 0, max: 1, interval: 30 };
  f.addBinding(monitor, 'bass',   { ...gOpts, label: 'bass'   });
  f.addBinding(monitor, 'mid',    { ...gOpts, label: 'mid'    });
  f.addBinding(monitor, 'treble', { ...gOpts, label: 'treble' });
  f.addBinding(monitor, 'motion', { ...gOpts, label: 'motion' });
}

// --- Export ---
{
  const f = pane.addFolder({ title: 'Export', expanded: false });

  const formatOptions = [
    { text: 'mp4 (h.264, in-browser)' + (WebCodecsMp4Path.isSupported() ? '' : ' — UNSUPPORTED'),
      value: 'mp4' },
    { text: 'webm (vp9, real-time)',   value: 'webm' },
    { text: 'webm (frame-locked)',     value: 'webm-locked' },
    { text: 'png sequence',            value: 'png' },
  ];

  f.addBlade({
    view: 'list',
    label: 'format',
    options: formatOptions,
    value: exportSettings.format,
  }).on('change', (ev) => { exportSettings.format = ev.value; });

  f.addBinding(exportSettings, 'durationSeconds', { label: 'seconds', min: 1, max: 120, step: 1 });
  f.addBinding(exportSettings, 'fps',             { label: 'fps',     min: 24, max: 60, step: 1 });
  f.addBinding(exportSettings, 'bitrateMbps',     { label: 'mp4 mbps', min: 2, max: 40, step: 1 });

  const recBtn = f.addButton({ title: '● record' });
  let isRecording = false;
  let recordingPath = null;

  recBtn.on('click', async () => {
    if (!isRecording) {
      const fmt = exportSettings.format;
      const opts = {
        fps: exportSettings.fps,
        durationSeconds: exportSettings.durationSeconds,
      };

      try {
        if (fmt === 'mp4') {
          if (!WebCodecsMp4Path.isSupported()) {
            console.warn('WebCodecs unsupported in this browser. Falling back to webm.');
            mediaPath.start(opts);
            recordingPath = mediaPath;
          } else {
            await mp4Path.start({ ...opts, bitrate: exportSettings.bitrateMbps * 1_000_000 });
            recordingPath = mp4Path;
          }
        } else if (fmt === 'webm') {
          mediaPath.start(opts);
          recordingPath = mediaPath;
        } else if (fmt === 'webm-locked') {
          await ccapPath.start({ ...opts, format: 'webm' });
          recordingPath = ccapPath;
        } else if (fmt === 'png') {
          await ccapPath.start({ ...opts, format: 'png' });
          recordingPath = ccapPath;
        }
        isRecording = true;
        recBtn.title = '■ stop';
        // auto-flip back when duration elapses (path stops itself)
        setTimeout(() => {
          isRecording = false;
          recordingPath = null;
          recBtn.title = '● record';
        }, exportSettings.durationSeconds * 1000 + 400);
      } catch (e) {
        console.error('Recording failed:', e);
        isRecording = false;
        recordingPath = null;
        recBtn.title = '● record';
      }
    } else {
      // manual stop
      if (recordingPath) await recordingPath.stop();
      mediaPath.stop(); ccapPath.stop(); mp4Path.stop();
      isRecording = false;
      recordingPath = null;
      recBtn.title = '● record';
    }
  });

  f.addButton({ title: 'Save preset (json)' }).on('click', () => {
    downloadPreset(params, sourceState.preset || 'custom');
  });
  f.addButton({ title: 'Load preset (json)' }).on('click', () => presetPicker.click());
}

// -----------------------------------------------------------------------------
// File pickers
// -----------------------------------------------------------------------------
mediaPicker.addEventListener('change', () => {
  const f = mediaPicker.files?.[0];
  if (!f) return;
  if (f.type.startsWith('video/'))      loadVideoFromFile(f);
  else if (f.type.startsWith('image/')) loadImageFromFile(f);
});
audioPicker.addEventListener('change', async () => {
  const f = audioPicker.files?.[0];
  if (!f) return;
  try {
    await audioMod.loadFile(f);
    audioMod.setVolume(modulation.audio.volume);
    if (modulation.mode !== 'audio') {
      modulation.mode = 'audio';
      pane.refresh();
    }
  } catch (e) {
    console.warn('Audio load failed', e);
  }
});
presetPicker.addEventListener('change', async () => {
  const f = presetPicker.files?.[0];
  if (!f) return;
  try {
    const obj = await readPresetFile(f);
    applyPreset(params, obj);
    sourceState.preset = obj.name || 'custom';
    pane.refresh();
    saveStateToLocalStorage();
  } catch (e) {
    console.error('Preset load failed:', e);
  }
});

// -----------------------------------------------------------------------------
// Drag and drop (anywhere on page)
// -----------------------------------------------------------------------------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('active');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('active');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.type.startsWith('video/')) {
    loadVideoFromFile(file);
  } else if (file.type.startsWith('image/')) {
    loadImageFromFile(file);
  } else if (file.type.startsWith('audio/')) {
    audioMod.loadFile(file).then(() => {
      audioMod.setVolume(modulation.audio.volume);
      modulation.mode = 'audio';
      pane.refresh();
    });
  } else if (file.name.endsWith('.json')) {
    readPresetFile(file).then((obj) => {
      applyPreset(params, obj);
      sourceState.preset = obj.name || 'custom';
      pane.refresh();
      saveStateToLocalStorage();
    });
  }
});

// fade out hint after 3s
setTimeout(() => {
  hint.classList.remove('visible');
  hint.classList.add('hidden');
}, 3000);

// dismiss hint on first interaction
window.addEventListener('pointerdown', () => {
  hint.classList.remove('visible');
  hint.classList.add('hidden');
}, { once: true });

// persist UI state on any change
pane.on('change', saveStateToLocalStorage);

// -----------------------------------------------------------------------------
// boot
// -----------------------------------------------------------------------------
loadStateFromLocalStorage();
pane.refresh();
window.addEventListener('resize', resize);
resize();
video.addEventListener('loadedmetadata', resize);
requestAnimationFrame(frameTick);
