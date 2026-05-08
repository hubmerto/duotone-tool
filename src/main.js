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
import { MediaRecorderPath, CCapturePath } from './recorder.js';

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------
const params = { ...PRESETS[DEFAULT_PRESET] };
const exportSettings = {
  format: 'webm',          // 'webm' or 'png-sequence'
  durationSeconds: 6,
  fps: 60,
  engine: 'mediarecorder', // 'mediarecorder' | 'ccapture'
};
const sourceState = {
  preset: DEFAULT_PRESET,
  loop: true,
  playing: true,
};

// effect time is separate from wallclock — "Replay intro" resets this
let effectStart = performance.now();
let frameCount = 0;

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
const canvas      = document.getElementById('stage');
const video       = document.getElementById('source-video');
const dropOverlay = document.getElementById('dropzone-overlay');
const hint        = document.getElementById('hint');

// hidden file pickers (Tweakpane has no native file input)
const videoPicker  = makeHiddenInput('file', 'video/*');
const presetPicker = makeHiddenInput('file', 'application/json,.json');

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
  const vw = video.videoWidth  || 1920;
  const vh = video.videoHeight || 1080;

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
  video.src = URL.createObjectURL(file);
  video.loop = sourceState.loop;
  video.play().catch(() => {});
  effectStart = performance.now();
  frameCount = 0;
}

function loadVideoFromUrl(url) {
  video.src = url;
  video.loop = sourceState.loop;
  video.play().catch(() => {});
  effectStart = performance.now();
  frameCount = 0;
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
// recording instances
// -----------------------------------------------------------------------------
const mediaPath  = new MediaRecorderPath(canvas);
const ccapPath   = new CCapturePath(canvas);

// -----------------------------------------------------------------------------
// render loop
// -----------------------------------------------------------------------------
function frameTick() {
  // upload video frame to texture if ready
  if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  }

  // ensure backing-store size matches latest video dims
  if (video.videoWidth > 0 && (canvas.width === 1 || canvas.height === 1)) {
    resize();
  }

  gl.useProgram(program);
  gl.bindVertexArray(vao);

  const t = (performance.now() - effectStart) / 1000;
  const c = hexToRgb(params.spotColor);

  gl.uniform1i(U.u_video, 0);
  gl.uniform2f(U.u_resolution, canvas.width, canvas.height);
  gl.uniform1f(U.u_time, t);
  gl.uniform1i(U.u_frame, frameCount);
  gl.uniform3f(U.u_spotColor, c[0], c[1], c[2]);

  gl.uniform1f(U.u_thresholdBase,    params.thresholdBase);
  gl.uniform1f(U.u_thresholdLFOAmp,  params.thresholdLFOAmp);
  gl.uniform1f(U.u_thresholdLFOFreq, params.thresholdLFOFreq);

  gl.uniform1f(U.u_introDuration, params.introDuration);
  gl.uniform1i(U.u_introCurve,    params.introCurve | 0);

  gl.uniform1f(U.u_slowNoiseScale, params.slowNoiseScale);
  gl.uniform1f(U.u_slowNoiseSpeed, params.slowNoiseSpeed);
  gl.uniform1f(U.u_slowAmp,        params.slowAmp);
  gl.uniform1f(U.u_warpAmp,        params.warpAmp ?? 0.0);

  gl.uniform1f(U.u_ditherScale, params.ditherScale);
  gl.uniform1f(U.u_ditherSpeed, params.ditherSpeed);
  gl.uniform1f(U.u_ditherAmp,   params.ditherAmp);

  gl.uniform1f(U.u_softness, params.softness);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  if (ccapPath.recording) ccapPath.capture();
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
  f.addButton({ title: 'Pick video file…' }).on('click', () => videoPicker.click());
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

// --- Export ---
{
  const f = pane.addFolder({ title: 'Export', expanded: false });
  f.addBlade({
    view: 'list',
    label: 'engine',
    options: [
      { text: 'mediarecorder (fast)', value: 'mediarecorder' },
      { text: 'ccapture (frame-locked)', value: 'ccapture' },
    ],
    value: exportSettings.engine,
  }).on('change', (ev) => { exportSettings.engine = ev.value; });
  f.addBlade({
    view: 'list',
    label: 'format',
    options: [
      { text: 'webm', value: 'webm' },
      { text: 'png sequence (ccapture only)', value: 'png' },
    ],
    value: exportSettings.format,
  }).on('change', (ev) => { exportSettings.format = ev.value; });
  f.addBinding(exportSettings, 'durationSeconds', { label: 'seconds', min: 1, max: 120, step: 1 });
  f.addBinding(exportSettings, 'fps', { label: 'fps', min: 24, max: 60, step: 1 });

  const recBtn = f.addButton({ title: '● record' });
  let isRecording = false;
  recBtn.on('click', async () => {
    if (!isRecording) {
      if (exportSettings.engine === 'mediarecorder') {
        mediaPath.start({
          fps: exportSettings.fps,
          durationSeconds: exportSettings.durationSeconds,
        });
      } else {
        await ccapPath.start({
          fps: exportSettings.fps,
          durationSeconds: exportSettings.durationSeconds,
          format: exportSettings.format === 'png' ? 'png' : 'webm',
        });
      }
      isRecording = true;
      recBtn.title = '■ stop';
      // auto-flip back when duration elapses
      setTimeout(() => {
        isRecording = false;
        recBtn.title = '● record';
      }, exportSettings.durationSeconds * 1000 + 300);
    } else {
      mediaPath.stop();
      ccapPath.stop();
      isRecording = false;
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
videoPicker.addEventListener('change', () => {
  const f = videoPicker.files?.[0];
  if (f) loadVideoFromFile(f);
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
