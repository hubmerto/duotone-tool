// Preset definitions. The "default" / orange-reference preset is the boot
// state — what the user sees on a clean first load.
//
// orange / green / blue presets share the SAME recipe and differ ONLY in
// spotColor. Same Two Layer cadence, same speed staging, same boil.

// Recipe authored by hand against a reference clip — exported via
// "Save preset (json)" then re-imported here as the boot state.
// Aesthetic: low threshold + multiply blend + heavy speed cycling + the
// Two Layer pause-and-catch-up morph. Slow field and boil grain are
// effectively off in this preset (the threshold cut + two layers do all
// the work).
const SHARED = {
  // Threshold
  thresholdBase:    0.15,
  thresholdLFOAmp:  0.04,
  thresholdLFOFreq: 0.81,

  // Intro
  introMode: 0,
  introDuration: 1.2,
  introCurve: 1,
  introOriginX: 0.5,
  introOriginY: 0.5,
  introSpread: 0.30,
  introFalloff: 0.5,
  introDirectionality: 0.0,
  introAngle: 0.0,
  introTurbulence: 0.30,

  // Slow field / warp — disabled in this recipe
  slowNoiseScale: 0.5,
  slowNoiseSpeed: 0.0,
  slowAmp: 0.0,
  warpAmp: 0.0,

  // Boil — also essentially off; the threshold edge does the cut alone
  ditherScale: 50,
  ditherSpeed: 0.02,
  ditherAmp: 0.0,

  // Edge
  softness: 0.018,

  // Speed staging — cycle 0.9x ↔ 2.0x at 0.5 Hz, snappy
  speedMode: 1,
  staticSpeed: 0.45,
  slowSpeed: 0.9,
  fastSpeed: 2.0,
  speedCycleFreq: 0.5,
  speedSmoothing: 0.28,
  stepIntervalMin: 1.5,
  stepIntervalMax: 3.5,
  speedSeed: 1,

  // Two Layer — the morphism
  twoLayerEnabled: true,
  syncDuration: 2.0,
  syncJitter: 0.4,
  holdDuration: 0.5,
  holdJitter: 0.2,
  catchUpDuration: 0.45,
  resyncDuration: 0.1,
  pauseBias: 0.5,
  trailSampleCount: 10,
  trailStyle: 0,
  layerBlendMode: 2,                  // multiply
  layerBlendBalance: 0.5,
  twoLayerSeed: 42,
  phaseLockToSpeed: true,
};

// orange/green/blue all inherit the same recipe; only spotColor differs.
export const PRESETS = {
  default: { name: 'default', spotColor: '#E84510', ...SHARED },
  orange:  { name: 'orange',  spotColor: '#E84510', ...SHARED },
  green:   { name: 'green',   spotColor: '#9FFF00', ...SHARED },
  blue:    { name: 'blue',    spotColor: '#0066FF', ...SHARED },
};

// Boot state when no localStorage exists.
export const DEFAULT_PRESET = 'default';

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
