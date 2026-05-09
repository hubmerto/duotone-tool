// Preset definitions. The "default" / orange-reference preset is the boot
// state — what the user sees on a clean first load.
//
// orange / green / blue presets share the SAME recipe and differ ONLY in
// spotColor. Same Two Layer cadence, same speed staging, same boil.

const SHARED = {
  // Threshold
  thresholdBase:    0.50,
  thresholdLFOAmp:  0.06,
  thresholdLFOFreq: 0.18,

  // Intro
  introMode: 0,                       // 0=develop, 1=radiance, 2=aperture, 3=scanline
  introDuration: 1.2,
  introCurve: 1,                      // easeOut
  introOriginX: 0.5,
  introOriginY: 0.5,
  introSpread: 0.30,
  introFalloff: 0.5,
  introDirectionality: 0.0,
  introAngle: 0.0,
  introTurbulence: 0.30,

  // Slow field / warp
  slowNoiseScale: 3.5,
  slowNoiseSpeed: 0.12,
  slowAmp: 0.32,
  warpAmp: 0.0,                       // off in default

  // Boil
  ditherScale: 600.0,
  ditherSpeed: 0.7,
  ditherAmp: 0.18,

  // Edge
  softness: 0.018,

  // Speed staging
  speedMode: 1,                       // 1 = cycle (sin)
  staticSpeed: 0.45,
  slowSpeed: 0.35,
  fastSpeed: 1.0,
  speedCycleFreq: 0.18,
  speedSmoothing: 0.8,
  stepIntervalMin: 1.5,
  stepIntervalMax: 3.5,
  speedSeed: 1,

  // Two Layer (the morphism)
  twoLayerEnabled: true,
  syncDuration: 1.0,
  syncJitter: 0.4,
  holdDuration: 0.5,
  holdJitter: 0.2,
  catchUpDuration: 0.45,
  resyncDuration: 0.1,
  pauseBias: 0.5,
  trailSampleCount: 10,
  trailStyle: 0,                      // 0=smear, 1=glitch
  layerBlendMode: 0,                  // 0=luma 50/50
  layerBlendBalance: 0.5,
  twoLayerSeed: 42,
  phaseLockToSpeed: true,             // rebind: ties Two Layer playback to slow/fast
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
