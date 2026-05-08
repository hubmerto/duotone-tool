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
  introDuration: 1.2,
  introCurve: 1, // easeOutCubic
  // slow ink-blob field — main "morphism" driver
  slowNoiseScale: 3.5,
  slowNoiseSpeed: 0.10,
  slowAmp: 0.32,    // bumped from 0.25 — bigger threshold push = bigger blobs
  warpAmp: 0.018,   // NEW: UV displacement; tiny values morph the image content
  // fast boil — kept lighter so it doesn't drown the morphism
  ditherScale: 600.0,
  ditherSpeed: 0.55,
  ditherAmp: 0.07,  // was 0.10 — let the morph breathe
  softness: 0.015,
};

export const PRESETS = {
  green:  { name: 'green',  spotColor: '#9FFF00', ...SHARED },
  orange: { name: 'orange', spotColor: '#FF4500', ...SHARED },
  blue:   { name: 'blue',   spotColor: '#0066FF', ...SHARED },
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
