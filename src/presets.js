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

  // dual-playhead temporal — off by default. Two virtual heads in the ring
  // buffer; one freezes while the other advances, then they reconverge via
  // a luma morph. See dpAdvance() in main.js.
  dpIntensity:        0,
  dpHoldIntervalMin:  0.6,    // s — lower bound of time between freezes
  dpHoldIntervalMax:  1.8,    // s — upper bound
  dpHoldDurationMin:  6,      // frames the moving head drifts before morph
  dpHoldDurationMax:  28,
  dpMorphDurationMin: 4,      // morph length lower bound
  dpMorphDurationMax: 14,
  dpMorphCurve:       1,      // 0=linear, 1=easeInOut, 2=easeOut
  dpSwapBias:         0.5,    // 0=always A freezes, 1=always B
  dpSeed:             1,      // change for a different "performance"
};

export const PRESETS = {
  green:  { name: 'green',  spotColor: '#9FFF00', ...SHARED },
  orange: { name: 'orange', spotColor: '#FF4500', ...SHARED },
  blue:   { name: 'blue',   spotColor: '#0066FF', ...SHARED },

  // Showcase: spatial intro (kept from previous module)
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

  // Showcase: dual-playhead at moderate intensity, calm timing
  'green-catchup': {
    name: 'green-catchup',
    spotColor: '#9FFF00',
    ...SHARED,
    dpIntensity: 1.0,
    dpHoldIntervalMin: 0.5,
    dpHoldIntervalMax: 1.4,
    dpHoldDurationMin: 6,
    dpHoldDurationMax: 22,
    dpMorphDurationMin: 4,
    dpMorphDurationMax: 12,
    dpMorphCurve: 1,
    dpSwapBias: 0.5,
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
