// Preset definitions. The three "reference" presets target the orange / green /
// blue webp clips — same recipe across all three, only spotColor differs. The
// "bare" presets (green / orange / blue) leave temporal mix off and run at
// normal speed for a cleaner threshold-only look.

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

  // -- Speed Staging (Module 2) --
  speedMode: 0,            // 0=static, 1=cycle (sin), 2=step (random hold)
  staticSpeed: 1.0,
  slowSpeed: 0.35,
  fastSpeed: 1.0,
  speedCycleFreq: 0.18,    // Hz, cycle mode only
  stepIntervalMin: 1.5,    // s
  stepIntervalMax: 4.0,    // s
  speedSmoothing: 0.85,    // 0=instant, 1=very slow ease
  speedSeed: 1,

  // -- Temporal Mix (Module 1) --
  temporalMode: 0,         // 0=off, 1=static, 2=pulsing
  temporalMixAmount: 0.0,
  temporalOffsetFrames: 22,
  temporalPulseFreq: 0.22, // Hz, pulsing mode only (overridden by phase lock)
  temporalPulseAmp: 0.85,
  phaseLockToSpeed: false, // ties pulse to speed phase (Module 3)
  temporalShowBufferOnly: false, // debug
};

// "Bare" preset values — clean threshold-only effect, no temporal mix
const BARE = { ...SHARED };

// "Reference" preset values — matches the spec's test protocol:
// cycle speed + pulsing temporal mix + phase lock = the morphism rhythm
const REFERENCE = {
  ...SHARED,

  // Threshold — softer LFO than bare since the source already moves slowly
  thresholdLFOAmp: 0.04,
  thresholdLFOFreq: 0.15,

  // Slow field — slightly bigger blobs, calmer drift
  slowNoiseScale: 4.0,
  slowAmp: 0.22,

  // Boil — finer + more amp
  ditherScale: 750.0,
  ditherAmp: 0.10,

  // Edge — sharper
  softness: 0.012,

  // Speed Staging — cycle mode oscillates between slow-mo and normal
  speedMode: 1,
  slowSpeed: 0.35,
  fastSpeed: 1.0,
  speedCycleFreq: 0.18,
  speedSmoothing: 0.85,

  // Temporal Mix — pulsing ghost, phase-locked to speed
  temporalMode: 2,
  temporalMixAmount: 0.55,
  temporalOffsetFrames: 22,
  temporalPulseAmp: 0.9,
  phaseLockToSpeed: true,
};

export const PRESETS = {
  // bare (threshold-only)
  green:  { name: 'green',  spotColor: '#9FFF00', ...BARE },
  orange: { name: 'orange', spotColor: '#FF4500', ...BARE },
  blue:   { name: 'blue',   spotColor: '#0066FF', ...BARE },

  // reference (full stack: speed cycle + pulsing temporal mix + phase lock)
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

// First-load default — orange-reference is the "what was actually wanted"
// look (spec section: "Make these the defaults").
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
