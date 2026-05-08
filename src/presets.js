// Preset definitions. Same threshold/noise tuning across all three —
// the whole point is that swapping spotColor produces a different palette
// of the same effect. Tune the green by eye against reference, then the
// other two follow.
//
// JSON shape: a plain object of uniform values, matches the params object
// in main.js exactly (so save/load is just JSON.stringify / Object.assign).

const SHARED = {
  thresholdBase: 0.50,
  thresholdLFOAmp: 0.08,
  thresholdLFOFreq: 0.18,

  // intro — mode 0 = develop (existing), 1 = radiance, 2 = aperture, 3 = scanline
  introMode: 0,
  introDuration: 1.2,
  introCurve: 1, // easeOutCubic
  introOriginX: 0.5,
  introOriginY: 0.5,
  introSpread: 0.25,
  introFalloff: 0.5,
  introDirectionality: 0,
  introAngle: 0,
  introTurbulence: 0.30,

  // slow ink-blob field — main "morphism" driver
  slowNoiseScale: 3.5,
  slowNoiseSpeed: 0.10,
  slowAmp: 0.32,
  warpAmp: 0.018,

  // fast boil
  ditherScale: 600.0,
  ditherSpeed: 0.55,
  ditherAmp: 0.07,
  softness: 0.015,

  // temporal — mode 0 = off (no buffer overhead)
  temporalMode: 0,
  bufferSize: 64,
  stutterAmount: 0.30,
  stutterHoldFrames: 6,
  morphBlend: 0.50,
  morphSpread: 12,
  rewindChance: 0.05,
  rewindLength: 1.5,
  rewindSpeed: 1.5,
  speedRamp: 0.0,
  temporalSeed: 1,
};

export const PRESETS = {
  green:  { name: 'green',  spotColor: '#9FFF00', ...SHARED },
  orange: { name: 'orange', spotColor: '#FF4500', ...SHARED },
  blue:   { name: 'blue',   spotColor: '#0066FF', ...SHARED },

  // ---- showcase presets for the new modules ----
  'green-stutter': {
    name: 'green-stutter',
    spotColor: '#9FFF00',
    ...SHARED,
    temporalMode: 1,         // stutter
    bufferSize: 48,
    stutterAmount: 0.45,
    stutterHoldFrames: 5,
    morphBlend: 0.35,        // mild concurrent morph for textural depth
    morphSpread: 7,
    speedRamp: -0.15,        // slight slow-mo bias accentuates the holds
  },
  'orange-rewind': {
    name: 'orange-rewind',
    spotColor: '#FF4500',
    ...SHARED,
    temporalMode: 3,         // rewind
    bufferSize: 96,
    rewindChance: 0.18,
    rewindLength: 1.8,
    rewindSpeed: 1.8,
    speedRamp: 0.10,
  },
  'blue-radiance': {
    name: 'blue-radiance',
    spotColor: '#0066FF',
    ...SHARED,
    introMode: 1,            // radiance
    introOriginX: 0.5,
    introOriginY: 1.0,       // top-center (UV y=1 is top in our convention)
    introDuration: 2.4,      // slower so the wavefront is hypnotic
    introSpread: 0.45,
    introFalloff: 0.7,
    introTurbulence: 0.6,
    introAngle: -1.5708,     // -π/2 = downward, in case directionality > 0
  },
};

export const DEFAULT_PRESET = 'green';

// ---- helpers ---------------------------------------------------------------

export function applyPreset(params, preset) {
  // mutates params in place; returns it for convenience
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
