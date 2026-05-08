// Preset definitions. The three "reference" presets target the orange / green /
// blue webp clips — same recipe across all three, only spotColor differs. The
// "bare" presets (green / orange / blue) leave temporal mix off for a cleaner
// boiling-threshold-only look.
//
// JSON shape: a plain object of param values, mirrors the `params` object in
// main.js exactly. applyPreset() copies whichever keys are present.

const SHARED = {
  thresholdBase: 0.50,
  thresholdLFOAmp: 0.08,
  thresholdLFOFreq: 0.18,

  // intro — mode 0 = develop (existing), 1 = radiance, 2 = aperture, 3 = scanline
  introMode: 0,
  introDuration: 1.2,
  introCurve: 1, // easeOut
  introOriginX: 0.5,
  introOriginY: 0.5,
  introSpread: 0.25,
  introFalloff: 0.5,
  introDirectionality: 0,
  introAngle: 0,
  introTurbulence: 0.30,

  // slow ink-blob field
  slowNoiseScale: 3.5,
  slowNoiseSpeed: 0.10,
  slowAmp: 0.32,
  warpAmp: 0.018,

  // fast boil
  ditherScale: 600.0,
  ditherSpeed: 0.55,
  ditherAmp: 0.07,
  softness: 0.015,

  // playback
  playbackSpeed: 1.0,

  // temporal mix — off by default
  temporalMixAmount:    0.0,
  temporalOffsetFrames: 18,
  temporalMode:         0,    // 0=static, 1=pulsing, 2=ramped
  temporalPulseFreq:    0.22, // Hz
  temporalPulseAmp:     0.85,
};

// --------- "bare" presets (no temporal mix, tuned threshold-only) ---------
const BARE = {
  ...SHARED,
};

// --------- reference presets (mid-cycle pulsing temporal mix, slow-mo) -----
// Tuned by ear/eye against the orange webp clip. Same recipe across green /
// orange / blue — only spotColor swaps.
const REFERENCE = {
  ...SHARED,
  // Source — slow-mo, this is the largest perceptual lever
  playbackSpeed: 0.45,
  // Threshold — softer LFO than the bare preset (the source already moves slowly)
  thresholdBase: 0.50,
  thresholdLFOAmp: 0.04,
  thresholdLFOFreq: 0.15,
  // Intro — develop-in
  introMode: 0,
  introDuration: 1.2,
  introCurve: 1,
  // Slow field — slightly bigger blobs, calmer drift
  slowNoiseScale: 4.0,
  slowNoiseSpeed: 0.10,
  slowAmp: 0.22,
  // Boil — finer + a touch more amp than bare
  ditherScale: 750.0,
  ditherSpeed: 0.55,
  ditherAmp: 0.10,
  // Edge — slightly sharper
  softness: 0.012,
  // Temporal Mix — pulsing ghost trail; this is the "morphing humans" piece
  temporalMode:         1,     // pulsing
  temporalMixAmount:    0.45,
  temporalOffsetFrames: 18,
  temporalPulseFreq:    0.22,  // ~1 cycle per 4.5s
  temporalPulseAmp:     0.85,
};

export const PRESETS = {
  // bare (threshold-only)
  green:  { name: 'green',  spotColor: '#9FFF00', ...BARE },
  orange: { name: 'orange', spotColor: '#FF4500', ...BARE },
  blue:   { name: 'blue',   spotColor: '#0066FF', ...BARE },

  // reference (full stack: slow-mo + temporal mix + threshold)
  'orange-reference': { name: 'orange-reference', spotColor: '#E84510', ...REFERENCE },
  'green-reference':  { name: 'green-reference',  spotColor: '#9FFF00', ...REFERENCE },
  'blue-reference':   { name: 'blue-reference',   spotColor: '#0066FF', ...REFERENCE },

  // showcase: spatial intro
  'blue-radiance': {
    name: 'blue-radiance',
    spotColor: '#0066FF',
    ...SHARED,
    introMode: 1,
    introOriginX: 0.5,
    introOriginY: 1.0,
    introDuration: 2.4,
    introSpread: 0.45,
    introFalloff: 0.7,
    introTurbulence: 0.6,
    introAngle: -1.5708,
  },
};

// First-load default — the orange reference preset is what the spec wants
// users to see immediately when they land on the tool with no saved state.
export const DEFAULT_PRESET = 'orange-reference';

// ---- helpers ---------------------------------------------------------------

export function applyPreset(params, preset) {
  for (const k of Object.keys(preset)) {
    if (k === 'name') continue;
    params[k] = preset[k];
  }
  return params;
}

export function paramsToPresetJSON(params, name = 'custom') {
  return JSON.stringify({ name, ...params }, null, 2);
}

export function downloadPreset(params, name = 'custom') {
  const blob = new Blob([paramsToPresetJSON(params, name)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duotone-preset-${name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function readPresetFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try { resolve(JSON.parse(r.result)); }
      catch (e) { reject(e); }
    };
    r.onerror = reject;
    r.readAsText(file);
  });
}
