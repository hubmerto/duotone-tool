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
import { SPECIMENS, SECTION_DEFS } from './specimens.js';

// =============================================================================
// Specimen routing — detected from URL on boot.
//
//   /             → normal app
//   /specimens/01 → render specimen #01 as a 1920×1080 composite
//
// Vercel SPA fallback is configured in vercel.json so any /specimens/* path
// serves index.html.
// =============================================================================
const SPECIMEN_PATH_RE = /^\/specimens\/(\d+)\/?$/;
const _specimenMatch   = window.location.pathname.match(SPECIMEN_PATH_RE);
const SPECIMEN         = _specimenMatch
  ? SPECIMENS.find((s) => s.id === _specimenMatch[1])
  : null;
if (SPECIMEN) document.body.classList.add('specimen-mode');

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------
const params = { ...PRESETS[DEFAULT_PRESET] };
// Format is the single primary control; engine is derived from it.
//   mp4         -> WebCodecs H.264 (Chrome/Firefox/Edge; not Safari)
//   webm        -> MediaRecorder VP9 (real-time, all browsers)
//   webm-locked -> ccapture.js (frame-locked webm)
//   png         -> ccapture.js PNG sequence
// Quality presets bundle (resolution-cap, bitrate, encoder mode) into one
// choice. Picking a preset writes its values into exportSettings; the
// individual fps / bitrate sliders still let you override.
const QUALITY_PRESETS = {
  preview:  { maxResHeight:  720, mp4Mbps:  6,  webmMbps: 10, latencyMode: 'realtime', bitrateMode: 'variable' },
  standard: { maxResHeight: 1080, mp4Mbps: 14,  webmMbps: 20, latencyMode: 'quality',  bitrateMode: 'variable' },
  high:     { maxResHeight: 1080, mp4Mbps: 28,  webmMbps: 40, latencyMode: 'quality',  bitrateMode: 'variable' },
  archival: { maxResHeight: 2160, mp4Mbps: 60,  webmMbps: 80, latencyMode: 'quality',  bitrateMode: 'variable' },
};

const exportSettings = {
  format:              WebCodecsMp4Path.isSupported() ? 'mp4' : 'webm',
  quality:             'high',
  durationSeconds:     10,
  fps:                 60,
  bitrateMbps:         QUALITY_PRESETS.high.mp4Mbps,
  replayIntroOnRecord: true,
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
const videoB      = document.getElementById('source-video-b');
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

// video texture A (and image source — they share this slot)
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,    gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,    gl.CLAMP_TO_EDGE);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));

// video texture B — Two Layer's secondary playhead
const textureB = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, textureB);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,    gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,    gl.CLAMP_TO_EDGE);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));

// -----------------------------------------------------------------------------
// Temporal ring buffer — quarter-res past frames in a TEXTURE_2D_ARRAY. The
// shader reads from this when u_temporalMode != 0 to drive stutter/morph/rewind.
// 120 layers × 480 × 270 × RGBA8 ≈ 60 MB on GPU; only updated while mode != 0.
// -----------------------------------------------------------------------------
const TEMPORAL_W = 480;
const TEMPORAL_H = 270;
const TEMPORAL_SIZE_MAX = 120;

const tempCanvas = document.createElement('canvas');
tempCanvas.width  = TEMPORAL_W;
tempCanvas.height = TEMPORAL_H;
const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: false });

const bufferTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D_ARRAY, bufferTex);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TEMPORAL_W, TEMPORAL_H, TEMPORAL_SIZE_MAX);
gl.activeTexture(gl.TEXTURE0); // restore default unit

let bufferWriteIndex   = 0;
let imageBufferFilled  = false;  // for static images: write to all layers once

// rVFC fires once per real video frame (vs rAF which fires per display frame).
// Using rVFC means the offset slider counts in *video* frames, which is what
// the user thinks about. Older Firefox (<113) lacks it — fall back to rAF.
const HAS_RVFC = typeof HTMLVideoElement !== 'undefined'
              && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// Speed state machine — slow/fast staging with smoothed transitions
let _currentSpeed = 1.0;
let lastFrameMs   = performance.now();

// Two Layer pause-and-catch-up state.
// Phases cycle: sync → holding (one side) → catchup (the held side races to
// the other) → resync → loop. holdSide alternates each round.
const twoLayer = {
  phase:            'sync',
  nextPhaseAt:      0,
  holdSide:         'A',
  isCatchup:        false,
  catchupHoldPosA:  0,
  catchupTargetPos: 0,
  triggerNow:       false,
};

// uniforms
const U = {};
for (const name of [
  'u_videoA','u_videoB','u_buffer','u_resolution','u_time','u_frame','u_spotColor',
  'u_thresholdBase','u_thresholdLFOAmp','u_thresholdLFOFreq',
  'u_introMode','u_introDuration','u_introCurve',
  'u_introOrigin','u_introSpread','u_introFalloff',
  'u_introDirectionality','u_introAngle','u_introTurbulence',
  'u_slowNoiseScale','u_slowNoiseSpeed','u_slowAmp','u_warpAmp',
  'u_ditherScale','u_ditherSpeed','u_ditherAmp',
  'u_softness',
  'u_bufferSize','u_bufferWriteIndex',
  'u_twoLayerEnabled','u_layerBlendMode','u_layerBlendBalance',
  'u_isCatchupActive','u_trailSampleCount','u_trailStyle',
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

  // Cap backing-store HEIGHT to the active quality preset (preview=720,
  // standard/high=1080, archival=2160). Width follows source AR. This is
  // both the rendered viewport AND the export resolution — bumping
  // quality means more pixels everywhere.
  const MAX_H = QUALITY_PRESETS[exportSettings.quality]?.maxResHeight ?? 1080;
  const MAX_W = Math.round(MAX_H * 16 / 9 + 0.5); // generous ceiling for ultrawide; AR-respect below
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

function _loadBothVideos(srcURL, isBlob) {
  // Revoke old blob URL only if the new src isn't the same one (Two Layer
  // shares one blob URL across both elements)
  if (video.src && video.src.startsWith('blob:') && video.src !== srcURL) {
    URL.revokeObjectURL(video.src);
  }
  if (imageEl.src && imageEl.src.startsWith('blob:')) URL.revokeObjectURL(imageEl.src);
  imageEl.removeAttribute('src');

  video.src  = srcURL;
  videoB.src = srcURL;
  video.loop  = sourceState.loop;
  videoB.loop = sourceState.loop;
  video.play().catch(() => {});
  videoB.play().catch(() => {});

  currentSource     = 'video';
  effectStart       = performance.now();
  frameCount        = 0;
  bufferWriteIndex  = 0;
  imageBufferFilled = false;
  // Reset Two Layer state machine for the new clip
  twoLayer.phase            = 'sync';
  twoLayer.nextPhaseAt      = performance.now() + 1500;
  twoLayer.holdSide         = 'A';
  twoLayer.isCatchup        = false;
  twoLayer.catchupHoldPosA  = 0;
  twoLayer.catchupTargetPos = 0;
}

function loadVideoFromFile(file) {
  _loadBothVideos(URL.createObjectURL(file), true);
}

function loadVideoFromUrl(url) {
  _loadBothVideos(url, false);
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
  imageBufferFilled = false;          // re-fill ring buffer on next tick
  effectStart = performance.now();
  frameCount = 0;
  resize();
}

// -----------------------------------------------------------------------------
// localStorage — last preset + UI state (no video data)
// -----------------------------------------------------------------------------
// v7: adopted user's hand-tuned default — low threshold, multiply blend,
// snappier speed cycling, slow field + boil disabled. Bumped so existing
// v6 saved state doesn't override the new defaults.
const LS_KEY = 'duotone:lastState:v7';

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
    // Specimen 06: synthetic peak signals instead of real audio analyzer.
    // Lets a still capture show what the effect looks like at audio peak.
    const m = (SPECIMEN && SPECIMEN.forceModulationPeak)
      ? { bass: 1.0, mid: 1.0, treble: 1.0, rms: 1.0 }
      : audioMod.update();
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

  // ----- Two Layer: ring buffer write of A's frames + videoB texture upload ----
  // Buffer holds N most recent A frames. During catch-up, the shader samples
  // the most recent N to build the trail. Auto-sized from trailSampleCount.
  const bufferDepth = Math.min(
    TEMPORAL_SIZE_MAX,
    Math.max(32, (params.trailSampleCount ?? 10) + 22)
  );
  // Image source — fill all buffer layers once with the static image
  if (currentSource === 'image' && imageEl.naturalWidth > 0 && !imageBufferFilled
      && !!params.twoLayerEnabled) {
    tempCtx.drawImage(imageEl, 0, 0, TEMPORAL_W, TEMPORAL_H);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, bufferTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (let i = 0; i < TEMPORAL_SIZE_MAX; i++) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i,
                       TEMPORAL_W, TEMPORAL_H, 1,
                       gl.RGBA, gl.UNSIGNED_BYTE, tempCanvas);
    }
    imageBufferFilled = true;
  }
  // rAF fallback when rVFC is unavailable
  if (!HAS_RVFC && currentSource === 'video') onVideoFrameWrite();

  // Upload videoB to its own texture each render frame (when source is video
  // and Two Layer is enabled — otherwise we don't need it)
  if (currentSource === 'video' && !!params.twoLayerEnabled
      && videoB.readyState >= 2 && videoB.videoWidth > 0) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, textureB);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, videoB);
  }

  // ----- effect time + delta --------------------------------------------------
  const t  = (performance.now() - effectStart) / 1000;
  const dt = Math.min(0.1, Math.max(0.001, (performance.now() - lastFrameMs) / 1000));
  lastFrameMs = performance.now();

  // ----- speed state machine -> video.playbackRate ----------------------------
  const currentSpeed = updateSpeed(t, dt);

  // ----- Two Layer phase advancement (mutates twoLayer + sets video.playbackRate)
  twoLayerAdvance(performance.now(), currentSpeed);

  // ----- draw -----------------------------------------------------------------
  gl.useProgram(program);
  gl.bindVertexArray(vao);

  const c = hexToRgb(params.spotColor);
  const lp = computeLiveParams();   // base params + modulation offsets

  // bind texture units: 0 = videoA / image, 1 = ring buffer, 2 = videoB
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, bufferTex);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textureB);
  gl.uniform1i(U.u_videoA, 0);
  gl.uniform1i(U.u_buffer, 1);
  gl.uniform1i(U.u_videoB, 2);

  gl.uniform2f(U.u_resolution, canvas.width, canvas.height);
  gl.uniform1f(U.u_time, t);
  gl.uniform1i(U.u_frame, frameCount);
  gl.uniform3f(U.u_spotColor, c[0], c[1], c[2]);

  gl.uniform1f(U.u_thresholdBase,    lp.thresholdBase);
  gl.uniform1f(U.u_thresholdLFOAmp,  lp.thresholdLFOAmp);
  gl.uniform1f(U.u_thresholdLFOFreq, lp.thresholdLFOFreq);

  // intro
  gl.uniform1i(U.u_introMode,           lp.introMode | 0);
  gl.uniform1f(U.u_introDuration,       lp.introDuration);
  gl.uniform1i(U.u_introCurve,          lp.introCurve | 0);
  gl.uniform2f(U.u_introOrigin,         lp.introOriginX ?? 0.5, lp.introOriginY ?? 0.5);
  gl.uniform1f(U.u_introSpread,         lp.introSpread        ?? 0.25);
  gl.uniform1f(U.u_introFalloff,        lp.introFalloff       ?? 0.5);
  gl.uniform1f(U.u_introDirectionality, lp.introDirectionality?? 0.0);
  gl.uniform1f(U.u_introAngle,          lp.introAngle         ?? 0.0);
  gl.uniform1f(U.u_introTurbulence,     lp.introTurbulence    ?? 0.3);

  // slow + warp
  gl.uniform1f(U.u_slowNoiseScale, lp.slowNoiseScale);
  gl.uniform1f(U.u_slowNoiseSpeed, lp.slowNoiseSpeed);
  gl.uniform1f(U.u_slowAmp,        lp.slowAmp);
  gl.uniform1f(U.u_warpAmp,        lp.warpAmp ?? 0.0);

  // boil
  gl.uniform1f(U.u_ditherScale, lp.ditherScale);
  gl.uniform1f(U.u_ditherSpeed, lp.ditherSpeed);
  gl.uniform1f(U.u_ditherAmp,   lp.ditherAmp);

  gl.uniform1f(U.u_softness, lp.softness);

  // Two Layer
  gl.uniform1i(U.u_bufferSize,         bufferDepth);
  gl.uniform1i(U.u_bufferWriteIndex,   bufferWriteIndex);
  gl.uniform1i(U.u_twoLayerEnabled,    params.twoLayerEnabled ? 1 : 0);
  gl.uniform1i(U.u_layerBlendMode,     lp.layerBlendMode | 0);
  gl.uniform1f(U.u_layerBlendBalance,  lp.layerBlendBalance ?? 0.5);
  gl.uniform1i(U.u_isCatchupActive,    twoLayer.phase === 'catchup' ? 1 : 0);
  gl.uniform1i(U.u_trailSampleCount,   Math.max(1, Math.min(16, lp.trailSampleCount | 0 || 10)));
  gl.uniform1i(U.u_trailStyle,         lp.trailStyle | 0);

  // Specimen 05 split-render: draw left half with leftConfig, right with right.
  // Scissor clips the writes; uniforms differ per draw. Single-pass shader,
  // two draws — same canvas.
  if (SPECIMEN && SPECIMEN.splitConfig) {
    const halfW = canvas.width >> 1;
    gl.enable(gl.SCISSOR_TEST);

    // left half
    for (const [k, v] of Object.entries(SPECIMEN.splitConfig.left)) {
      const u = U['u_' + k];
      if (u !== undefined && u !== null) {
        if (typeof v === 'number' && Number.isInteger(v) && k.endsWith('Mode')) gl.uniform1i(u, v);
        else gl.uniform1f(u, v);
      }
    }
    gl.scissor(0, 0, halfW, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // right half
    for (const [k, v] of Object.entries(SPECIMEN.splitConfig.right)) {
      const u = U['u_' + k];
      if (u !== undefined && u !== null) {
        if (typeof v === 'number' && Number.isInteger(v) && k.endsWith('Mode')) gl.uniform1i(u, v);
        else gl.uniform1f(u, v);
      }
    }
    gl.scissor(halfW, 0, canvas.width - halfW, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.disable(gl.SCISSOR_TEST);
  } else {
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  if (ccapPath.recording) ccapPath.capture();
  if (mp4Path.recording)  mp4Path.capture();
  frameCount++;
  requestAnimationFrame(frameTick);
}

// =============================================================================
// Two Layer helpers
// =============================================================================

// Per-rVFC video-frame buffer write. Captures A's frames into the ring buffer.
// The buffer fills fastest during catch-up (when A's playbackRate is high),
// which is exactly when the shader needs the recent-frame trail.
function onVideoFrameWrite() {
  if (currentSource !== 'video') return;
  if (!(video.readyState >= 2 && video.videoWidth > 0)) return;
  if (!params.twoLayerEnabled) return;

  tempCtx.drawImage(video, 0, 0, TEMPORAL_W, TEMPORAL_H);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, bufferTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, bufferWriteIndex,
                   TEMPORAL_W, TEMPORAL_H, 1,
                   gl.RGBA, gl.UNSIGNED_BYTE, tempCanvas);
  const depth = Math.min(
    TEMPORAL_SIZE_MAX,
    Math.max(32, (params.trailSampleCount ?? 10) + 22)
  );
  bufferWriteIndex = (bufferWriteIndex + 1) % depth;
}

function videoFrameCallback() {
  onVideoFrameWrite();
  if (HAS_RVFC) video.requestVideoFrameCallback(videoFrameCallback);
}

// Speed Staging — three modes. Returns the smoothed currentSpeed.
function updateSpeed(t, dt) {
  const mode = params.speedMode | 0;
  let target;

  if (mode === 0) {
    target = params.staticSpeed ?? 1.0;
  } else if (mode === 1) {
    // cycle (sin) between slow ↔ fast at speedCycleFreq Hz
    const phase = 0.5 + 0.5 * Math.sin(2 * Math.PI * (params.speedCycleFreq ?? 0.18) * t);
    target = (params.slowSpeed ?? 0.35) + ((params.fastSpeed ?? 1.0) - (params.slowSpeed ?? 0.35)) * phase;
  } else {
    // step (random hold) — deterministic by hashed bucket, alternates slow/fast
    const minIv = Math.max(0.1, params.stepIntervalMin ?? 1.5);
    const maxIv = Math.max(minIv, params.stepIntervalMax ?? 4.0);
    const stepBucket = Math.floor(t / minIv);
    const r = hash01(stepBucket + (params.speedSeed ?? 1));
    const intervalLen = minIv + (maxIv - minIv) * r;
    const stepIdx = Math.floor(t / Math.max(0.01, intervalLen));
    target = (stepIdx % 2 === 0) ? (params.slowSpeed ?? 0.35) : (params.fastSpeed ?? 1.0);
  }

  // Smoothing — params.speedSmoothing ∈ [0..1], 1 = very slow ease, 0 = instant
  const sm = Math.min(0.999, Math.max(0, params.speedSmoothing ?? 0.85));
  const k  = 1 - Math.pow(sm, dt * 60);
  _currentSpeed += (target - _currentSpeed) * k;

  // Two Layer owns playback rate when enabled — don't fight it.
  if (currentSource === 'video' && video.duration > 0 && !params.twoLayerEnabled) {
    const clamped = Math.max(0.1, Math.min(2.0, _currentSpeed));
    if (Math.abs(video.playbackRate - clamped) > 0.005) video.playbackRate = clamped;
  }
  return _currentSpeed;
}

// Hash for step-mode pseudo-random hold lengths
function hash01(x) {
  const s = Math.sin(x * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// =============================================================================
// Two Layer state machine — sync → holding → catchup → resync → loop
// =============================================================================
// Drives twoLayer.phase + per-phase video.playbackRate. When Two Layer is
// disabled (or source is image), it does nothing and updateSpeed() owns
// playback rate as before.
function twoLayerAdvance(nowMs) {
  if (currentSource !== 'video' || !params.twoLayerEnabled) {
    twoLayer.phase = 'sync';
    twoLayer.isCatchup = false;
    return;
  }

  // Initialize first phase boundary
  if (twoLayer.nextPhaseAt === 0) {
    twoLayer.nextPhaseAt = nowMs + _sampleSyncMs();
  }

  if (twoLayer.triggerNow) {
    _twoLayerNextPhase(nowMs);
    twoLayer.triggerNow = false;
  } else if (nowMs >= twoLayer.nextPhaseAt) {
    _twoLayerNextPhase(nowMs);
  }

  // Per-phase playback rate assignment
  const phaseLocked = !!params.phaseLockToSpeed;
  const slowS = params.slowSpeed   ?? 0.35;
  const fastS = params.fastSpeed   ?? 1.0;
  const stat  = params.staticSpeed ?? 1.0;
  const baseRate = phaseLocked ? slowS : stat;

  if (twoLayer.phase === 'sync' || twoLayer.phase === 'resync') {
    _setRate(video,  baseRate);
    _setRate(videoB, baseRate);
  } else if (twoLayer.phase === 'holding') {
    if (twoLayer.holdSide === 'A') { _setRate(video, 0); _setRate(videoB, baseRate); }
    else                            { _setRate(videoB, 0); _setRate(video, baseRate); }
  } else { // catchup — held side races, other side stops
    const dt = Math.max(0.05, params.catchUpDuration ?? 0.45);
    const distance = Math.max(0.05, twoLayer.catchupTargetPos - twoLayer.catchupHoldPosA);
    const rate = Math.max(0.1, Math.min(16, distance / dt));
    if (twoLayer.holdSide === 'A') { _setRate(videoB, 0); _setRate(video,  rate); }
    else                            { _setRate(video,  0); _setRate(videoB, rate); }
  }
}

function _twoLayerNextPhase(nowMs) {
  if (twoLayer.phase === 'sync') {
    // Pick who pauses next (with bias). Alternate by default, biased by pauseBias.
    const r = hash01(nowMs * 0.0011 + (params.twoLayerSeed ?? 1));
    const bias = Math.max(0, Math.min(1, params.pauseBias ?? 0.5));
    twoLayer.holdSide = (r < (1 - bias)) ? 'A' : 'B';
    twoLayer.phase = 'holding';
    twoLayer.isCatchup = false;
    twoLayer.nextPhaseAt = nowMs + _sampleHoldMs();
  } else if (twoLayer.phase === 'holding') {
    // Save catchup positions: held side at hold pos, other (moving) at its current
    const heldVid  = twoLayer.holdSide === 'A' ? video  : videoB;
    const otherVid = twoLayer.holdSide === 'A' ? videoB : video;
    twoLayer.catchupHoldPosA  = heldVid.currentTime;
    twoLayer.catchupTargetPos = otherVid.currentTime;
    twoLayer.phase = 'catchup';
    twoLayer.isCatchup = true;
    twoLayer.nextPhaseAt = nowMs + (params.catchUpDuration ?? 0.45) * 1000;
  } else if (twoLayer.phase === 'catchup') {
    // Resync: force B to A (don't trust drift)
    if (twoLayer.holdSide === 'A') {
      videoB.currentTime = video.currentTime;
    } else {
      video.currentTime  = videoB.currentTime;
    }
    twoLayer.phase = 'resync';
    twoLayer.isCatchup = false;
    twoLayer.nextPhaseAt = nowMs + (params.resyncDuration ?? 0.1) * 1000;
  } else { // resync → sync
    twoLayer.phase = 'sync';
    twoLayer.nextPhaseAt = nowMs + _sampleSyncMs();
  }
}

function _setRate(vid, rate) {
  if (!vid || vid.duration <= 0) return;
  const r = Math.max(0, Math.min(16, rate));
  if (r === 0) {
    if (!vid.paused) vid.pause();
  } else {
    if (vid.paused) vid.play().catch(() => {});
    if (Math.abs(vid.playbackRate - r) > 0.01) vid.playbackRate = r;
  }
}

function _sampleSyncMs() {
  const base = (params.syncDuration ?? 1.0) * 1000;
  const jit  = (params.syncJitter   ?? 0.4) * 1000;
  return base + (hash01(performance.now() * 0.0007 + (params.twoLayerSeed ?? 1)) * 2 - 1) * jit;
}
function _sampleHoldMs() {
  const base = (params.holdDuration ?? 0.5) * 1000;
  const jit  = (params.holdJitter   ?? 0.2) * 1000;
  return base + (hash01(performance.now() * 0.0009 + 0.371 + (params.twoLayerSeed ?? 1)) * 2 - 1) * jit;
}

// -----------------------------------------------------------------------------
// Tweakpane UI
// -----------------------------------------------------------------------------
const pane = new Pane({ title: 'DUOTONE', expanded: true });

// Hoisted visibility updaters — assigned inside their folder blocks so
// preset-switch / preset-load can re-evaluate which params are visible.
let updateIntroVis = () => {};
let updateTempVis  = () => {};

// --- Source ---
let updateSpeedVis = () => {};
{
  const f = pane.addFolder({ title: 'Source', expanded: true });
  f.addButton({ title: 'Pick file… (video / image)' }).on('click', () => mediaPicker.click());
  f.addButton({ title: 'Use sample' }).on('click', () => loadVideoFromUrl('/samples/sample.mp4'));
  f.addBinding(sourceState, 'playing', { label: 'play' }).on('change', (ev) => {
    if (ev.value) video.play(); else video.pause();
  });
  f.addBinding(sourceState, 'loop').on('change', (ev) => { video.loop = ev.value; });

  // Speed Staging — three modes (static / cycle / step). updateSpeed() in the
  // render loop turns these into video.playbackRate with smoothing.
  f.addBlade({
    view: 'list',
    label: 'speed mode',
    options: [
      { text: 'static',          value: 0 },
      { text: 'cycle (sin)',     value: 1 },
      { text: 'step (random)',   value: 2 },
    ],
    value: params.speedMode | 0,
  }).on('change', (ev) => { params.speedMode = ev.value | 0; updateSpeedVis(); });

  const bStat   = f.addBinding(params, 'staticSpeed',     { label: 'static speed', min: 0.1, max: 2.0, step: 0.05 });
  const bSlow   = f.addBinding(params, 'slowSpeed',       { label: 'slow value',   min: 0.1, max: 1.0, step: 0.05 });
  const bFast   = f.addBinding(params, 'fastSpeed',       { label: 'fast value',   min: 0.5, max: 2.0, step: 0.05 });
  const bCycle  = f.addBinding(params, 'speedCycleFreq',  { label: 'cycle freq',   min: 0.05, max: 0.5, step: 0.01 });
  const bStMin  = f.addBinding(params, 'stepIntervalMin', { label: 'step min (s)', min: 0.5,  max: 5.0, step: 0.1 });
  const bStMax  = f.addBinding(params, 'stepIntervalMax', { label: 'step max (s)', min: 0.5,  max: 8.0, step: 0.1 });
  const bSm     = f.addBinding(params, 'speedSmoothing',  { label: 'smoothing',    min: 0,    max: 0.99, step: 0.01 });

  updateSpeedVis = function () {
    const m = params.speedMode | 0;
    bStat.hidden  = m !== 0;
    bSlow.hidden  = m === 0;
    bFast.hidden  = m === 0;
    bCycle.hidden = m !== 1;
    bStMin.hidden = m !== 2;
    bStMax.hidden = m !== 2;
    bSm.hidden    = false;  // smoothing useful in all modes
  };
  updateSpeedVis();
}

// --- Color ---
{
  const f = pane.addFolder({ title: 'Color', expanded: true });
  f.addBinding(params, 'spotColor', { label: 'spot' });
  f.addBlade({
    view: 'list',
    label: 'preset',
    options: [
      { text: 'default (orange ref)', value: 'default' },
      { text: 'orange',               value: 'orange'  },
      { text: 'green',                value: 'green'   },
      { text: 'blue',                 value: 'blue'    },
      { text: 'custom',               value: 'custom'  },
    ],
    value: sourceState.preset,
  }).on('change', (ev) => {
    sourceState.preset = ev.value;
    if (ev.value !== 'custom' && PRESETS[ev.value]) {
      applyPreset(params, PRESETS[ev.value]);
      pane.refresh();
      updateIntroVis();
      updateSpeedVis();
      updateTempVis();
      // restart intro on preset change so spatial wavefronts re-play
      effectStart = performance.now();
      frameCount = 0;
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

  f.addBlade({
    view: 'list',
    label: 'mode',
    options: [
      { text: 'develop  (global ramp)',  value: 0 },
      { text: 'radiance (outward)',      value: 1 },
      { text: 'aperture (inward iris)',  value: 2 },
      { text: 'scanline (linear sweep)', value: 3 },
    ],
    value: params.introMode | 0,
  }).on('change', (ev) => { params.introMode = ev.value | 0; updateIntroVis(); });

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

  // spatial params — visible only for modes 1-3
  const bOriginX = f.addBinding(params, 'introOriginX',        { label: 'origin x',   min: 0, max: 1, step: 0.005 });
  const bOriginY = f.addBinding(params, 'introOriginY',        { label: 'origin y',   min: 0, max: 1, step: 0.005 });
  const bSpread  = f.addBinding(params, 'introSpread',         { label: 'spread',     min: 0.05, max: 1.0, step: 0.005 });
  const bFalloff = f.addBinding(params, 'introFalloff',        { label: 'falloff',    min: 0, max: 1, step: 0.01 });
  const bDir     = f.addBinding(params, 'introDirectionality', { label: 'direction',  min: 0, max: 1, step: 0.01 });
  const bAngle   = f.addBinding(params, 'introAngle',          { label: 'angle (rad)', min: -3.14159, max: 3.14159, step: 0.01 });
  const bTurb    = f.addBinding(params, 'introTurbulence',     { label: 'turbulence', min: 0, max: 1, step: 0.01 });

  updateIntroVis = function () {
    const m = params.introMode | 0;
    const spatial = m !== 0;
    bOriginX.hidden = !spatial;
    bOriginY.hidden = !spatial;
    bSpread.hidden  = !spatial;
    bFalloff.hidden = !spatial;
    bDir.hidden     = m !== 1;                 // directionality only meaningful in radiance
    bAngle.hidden   = (m === 0 || m === 2);    // not used in develop or aperture
    bTurb.hidden    = !spatial;
  };
  updateIntroVis();
      updateSpeedVis();

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

// --- TWO LAYER ---
// Two video playheads on the same source. Cycles through 4 phases:
// sync (both play) → holding (one pauses) → catchup (held side races to the
// other, leaving a luma trail) → resync (snap, brief breath) → loop. The
// alternation of which side holds gives the "morphing humans" rhythm.
{
  const f = pane.addFolder({ title: 'TWO LAYER', expanded: false });

  f.addBinding(params, 'twoLayerEnabled',  { label: 'enabled' })
    .on('change', () => updateTempVis());

  const bSync   = f.addBinding(params, 'syncDuration',    { label: 'sync (s)',     min: 0.5, max: 6.0, step: 0.05 });
  const bSyncJ  = f.addBinding(params, 'syncJitter',      { label: 'sync jitter',  min: 0,   max: 1.0, step: 0.05 });
  const bHold   = f.addBinding(params, 'holdDuration',    { label: 'hold (s)',     min: 0.2, max: 2.0, step: 0.05 });
  const bHoldJ  = f.addBinding(params, 'holdJitter',      { label: 'hold jitter',  min: 0,   max: 0.5, step: 0.02 });
  const bCatch  = f.addBinding(params, 'catchUpDuration', { label: 'catch-up (s)', min: 0.2, max: 1.5, step: 0.05 });
  const bResy   = f.addBinding(params, 'resyncDuration',  { label: 'resync (s)',   min: 0,   max: 1.0, step: 0.05 });
  const bBias   = f.addBinding(params, 'pauseBias',       { label: 'pause bias',   min: 0,   max: 1,   step: 0.01 });
  const bTSamp  = f.addBinding(params, 'trailSampleCount',{ label: 'trail samples',min: 4,   max: 16,  step: 1    });
  const bTStyle = f.addBlade({
    view: 'list', label: 'trail style',
    options: [{ text: 'smear',  value: 0 }, { text: 'glitch', value: 1 }],
    value: params.trailStyle | 0,
  });
  bTStyle.on('change', (ev) => { params.trailStyle = ev.value | 0; });
  const bMode   = f.addBlade({
    view: 'list', label: 'blend mode',
    options: [
      { text: 'luma 50/50', value: 0 },
      { text: 'screen',     value: 1 },
      { text: 'multiply',   value: 2 },
    ],
    value: params.layerBlendMode | 0,
  });
  bMode.on('change', (ev) => { params.layerBlendMode = ev.value | 0; });
  const bBal    = f.addBinding(params, 'layerBlendBalance', { label: 'blend balance', min: 0, max: 1, step: 0.01 });
  const bPhase  = f.addBinding(params, 'phaseLockToSpeed',  { label: 'phase lock to speed' });
  const bSeed   = f.addBinding(params, 'twoLayerSeed',      { label: 'seed', min: 0, max: 9999, step: 1 });
  f.addButton({ title: 'Trigger now' }).on('click', () => { twoLayer.triggerNow = true; });

  updateTempVis = function () {
    const enabled = !!params.twoLayerEnabled;
    [bSync, bSyncJ, bHold, bHoldJ, bCatch, bResy, bBias,
     bTSamp, bTStyle, bMode, bBal, bPhase, bSeed].forEach((b) => { b.hidden = !enabled; });
  };
  updateTempVis();
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

  f.addBlade({
    view: 'list',
    label: 'quality',
    options: [
      { text: 'preview  (720p, fast)',          value: 'preview'  },
      { text: 'standard (1080p)',               value: 'standard' },
      { text: 'high     (1080p, max bitrate)',  value: 'high'     },
      { text: 'archival (4K, max bitrate)',     value: 'archival' },
    ],
    value: exportSettings.quality,
  }).on('change', (ev) => {
    exportSettings.quality = ev.value;
    const p = QUALITY_PRESETS[ev.value];
    exportSettings.bitrateMbps = p.mp4Mbps; // sync slider to preset
    pane.refresh();
    resize();                                // re-cap backing store
  });

  f.addBinding(exportSettings, 'durationSeconds',     { label: 'seconds',  min: 1, max: 120, step: 1 });
  f.addBinding(exportSettings, 'fps',                 { label: 'fps',      min: 24, max: 60, step: 1 });
  f.addBinding(exportSettings, 'bitrateMbps',         { label: 'mp4 mbps', min: 2,  max: 80, step: 1 });
  f.addBinding(exportSettings, 'replayIntroOnRecord', { label: 'replay intro' });

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

      // reset effect time so the intro ramp is captured at the start of the file
      if (exportSettings.replayIntroOnRecord) {
        effectStart = performance.now();
        frameCount = 0;
      }

      const q = QUALITY_PRESETS[exportSettings.quality];

      try {
        if (fmt === 'mp4') {
          if (!WebCodecsMp4Path.isSupported()) {
            console.warn('WebCodecs unsupported in this browser. Falling back to webm.');
            mediaPath.start({ ...opts, bitrate: q.webmMbps * 1_000_000 });
            recordingPath = mediaPath;
          } else {
            await mp4Path.start({
              ...opts,
              bitrate: exportSettings.bitrateMbps * 1_000_000,
              latencyMode: q.latencyMode,
              bitrateMode: q.bitrateMode,
            });
            recordingPath = mp4Path;
          }
        } else if (fmt === 'webm') {
          mediaPath.start({ ...opts, bitrate: q.webmMbps * 1_000_000 });
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

  f.addButton({ title: 'Reset to default' }).on('click', () => {
    applyPreset(params, PRESETS[DEFAULT_PRESET]);
    sourceState.preset = DEFAULT_PRESET;
    pane.refresh();
    updateIntroVis();
    updateTempVis();
    updateSpeedVis();
    effectStart = performance.now();
    frameCount = 0;
    saveStateToLocalStorage();
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
    updateIntroVis();
      updateSpeedVis();
    updateTempVis();
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
      updateIntroVis();
      updateSpeedVis();
      updateTempVis();
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
updateIntroVis();
      updateSpeedVis();
updateTempVis();

// Expose handles for automation / debugging / capture scripts.
// This is a creative tool, not security-critical — making the state reachable
// from the console is broadly useful.
if (typeof window !== 'undefined') {
  window.boiler = {
    params, sourceState, modulation, exportSettings, monitor,
    pane, mediaPicker, audioPicker, presetPicker,
    PRESETS,
    loadVideoFromFile, loadImageFromFile, loadVideoFromUrl,
    setPreset(name) {
      if (!PRESETS[name]) return false;
      applyPreset(params, PRESETS[name]);
      sourceState.preset = name;
      pane.refresh();
      updateIntroVis();
      updateSpeedVis();
      updateTempVis();
      effectStart = performance.now();
      frameCount = 0;
      return true;
    },
    replayIntro() {
      effectStart = performance.now();
      frameCount = 0;
    },
    refresh() {
      pane.refresh();
      updateIntroVis();
      updateSpeedVis();
      updateTempVis();
    },
  };
}

window.addEventListener('resize', resize);
resize();
video.addEventListener('loadedmetadata', resize);

// rVFC chain — registers a callback that fires once per real video frame.
// Chain re-registers itself inside the callback. The chain stays alive across
// src changes since it's bound to the video element, not the URL.
if (HAS_RVFC) {
  video.requestVideoFrameCallback(videoFrameCallback);
}

requestAnimationFrame(frameTick);

// =============================================================================
// Specimen mode activation — runs after Tweakpane + render loop are wired.
// Applies preset + param overrides, auto-loads sample, builds the panel
// fragment + hairline line + caption.
// =============================================================================
if (SPECIMEN) activateSpecimen(SPECIMEN);

function activateSpecimen(spec) {
  // Apply preset baseline, then specimen-specific param overrides
  if (spec.preset && PRESETS[spec.preset]) {
    applyPreset(params, PRESETS[spec.preset]);
  }
  for (const [k, v] of Object.entries(spec.params || {})) {
    params[k] = v;
  }
  pane.refresh();
  updateIntroVis();
  updateTempVis();
  updateSpeedVis();

  // Specimen 06: switch on audio modulation so the forced-peak path engages
  if (spec.forceModulationPeak) {
    modulation.mode = 'audio';
  }

  // Specimen 05: tag body so the split-rule CSS shows
  if (spec.splitConfig) {
    document.body.classList.add('specimen-split');
  }

  // Auto-load default sample video
  loadVideoFromUrl('/samples/sample.mp4');

  // Replay the intro so the captured frame is past the develop ramp
  effectStart = performance.now();
  frameCount = 0;

  // Build the panel fragment + caption + line
  buildSpecimenPanel(spec);
  buildSpecimenCaption(spec);
  // line is drawn after a tick so panel layout has computed
  requestAnimationFrame(() => requestAnimationFrame(() => drawSpecimenLine(spec)));
}

function buildSpecimenPanel(spec) {
  const root = document.getElementById('specimen-panel');
  root.replaceChildren();
  for (const sectionName of (spec.panelSections || [])) {
    const def = SECTION_DEFS[sectionName];
    if (!def) continue;
    const mod = document.createElement('div');
    mod.className = 'spec-mod';
    const title = document.createElement('div');
    title.className = 'spec-mod-title';
    title.textContent = def.title;
    mod.appendChild(title);

    for (const row of def.rows) {
      const obj = row.fromObj
        ? row.fromObj.split('.').reduce((o, k) => o?.[k], window) || modulation.audio
        : params;
      const v = obj[row.key];
      if (v === undefined || v === null) continue;
      const pct = Math.max(0, Math.min(1, (v - row.min) / Math.max(1e-6, row.max - row.min)));
      const r = document.createElement('div');
      r.className = 'spec-mod-row';
      if (spec.primary === row.key) r.setAttribute('data-primary', 'true');
      r.innerHTML = ''; // safe — we'll append children
      const lbl = document.createElement('span');
      lbl.className = 'spec-mod-label';
      lbl.textContent = row.label;
      const trk = document.createElement('div');
      trk.className = 'spec-mod-track';
      const fill = document.createElement('div');
      fill.className = 'spec-mod-fill';
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      trk.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'spec-mod-value';
      val.textContent = row.fmt(v);
      const mkr = document.createElement('div');
      mkr.className = 'spec-mod-marker';
      r.appendChild(lbl); r.appendChild(trk); r.appendChild(val); r.appendChild(mkr);
      mod.appendChild(r);
    }
    root.appendChild(mod);
  }
}

function buildSpecimenCaption(spec) {
  const cap = document.getElementById('specimen-caption');
  const parts = [`FIG ${spec.id} · ${spec.label}`];
  if (spec.captionParts && spec.captionParts.length) {
    parts.push(spec.captionParts.join(' · '));
  }
  cap.textContent = parts.join('   ');
}

function drawSpecimenLine(spec) {
  const svg = document.getElementById('specimen-line');
  svg.replaceChildren();
  if (!spec.primary || !spec.panelSections?.length) return;

  // Find the marker element in the panel — look up by data-primary row
  const primaryRow = document.querySelector('#specimen-panel .spec-mod-row[data-primary="true"] .spec-mod-marker');
  if (!primaryRow) return;

  const compRect   = document.getElementById('specimen-composite').getBoundingClientRect();
  const markerRect = primaryRow.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  // Coordinates within the 1920×1080 composite (composite has position fixed,
  // so its rect is in viewport space — we subtract its top-left offset).
  const x1 = markerRect.left + markerRect.width / 2 - compRect.left;
  const y1 = markerRect.top  + markerRect.height / 2 - compRect.top;
  // Canvas upper-left corner — for split, use midline top
  let x2 = canvasRect.left - compRect.left;
  let y2 = canvasRect.top  - compRect.top;
  if (spec.splitConfig) x2 = canvasRect.left + canvasRect.width / 2 - compRect.left;

  svg.setAttribute('viewBox', '0 0 1920 1080');

  // Single bend if needed: route via a midpoint to the right of the marker
  const midX = Math.max(x1 + 60, (x1 + x2) / 2);
  const path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('stroke', '#9FFF00');
  p.setAttribute('stroke-width', '1');
  p.setAttribute('fill', 'none');
  svg.appendChild(p);

  // Endpoint markers (4px filled circles)
  for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r',  '2');
    c.setAttribute('fill', '#9FFF00');
    svg.appendChild(c);
  }
}
