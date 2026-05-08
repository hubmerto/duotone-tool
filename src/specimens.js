// Specimens: cropped panel module + result canvas pairings for the project
// portfolio page. Each entry produces a 1920×1080 composite via the
// /specimens/<id> route. The capture script (boiler-eggs-capture/
// capture-specimens.mjs) takes screenshots at dpr=2 → 3840×2160 output.

// Real param names come from main.js / shader.frag:
//   THRESHOLD section:   thresholdBase, thresholdLFOAmp, thresholdLFOFreq
//   BOIL section:        ditherScale, ditherSpeed, ditherAmp
//   SLOW FIELD section:  slowNoiseScale, slowNoiseSpeed, slowAmp, warpAmp
//   EDGE section:        softness
//   MODULATION section:  modulation.mode + audio depth sliders

export const SPECIMENS = [
  {
    id: '01',
    label: 'REFERENCE',
    preset: 'green',
    params: {},                    // all defaults
    panelSections: [],             // empty = no panel modules drawn
    primary: null,
    captionParts: [],
  },
  {
    id: '02',
    label: 'HIGH THRESHOLD',
    preset: 'green',
    params: { thresholdBase: 0.75 },
    panelSections: ['THRESHOLD'],
    primary: 'thresholdBase',
    captionParts: ['THRESHOLD @ 0.75'],
  },
  {
    id: '03',
    label: 'MAX BOIL',
    preset: 'green',
    params: { ditherSpeed: 1.0, ditherAmp: 0.25 },
    panelSections: ['BOIL'],
    primary: 'ditherSpeed',
    captionParts: ['BOIL SPEED @ 1.0', 'BOIL AMP @ 0.25'],
  },
  {
    id: '04',
    label: 'MAX SLOW FIELD',
    preset: 'orange',
    params: { slowAmp: 0.55, slowNoiseScale: 1.8, warpAmp: 0.06 },
    panelSections: ['SLOW FIELD'],
    primary: 'slowAmp',
    captionParts: ['SLOW AMP @ 0.55', 'WARP @ 0.06'],
  },
  {
    id: '05',
    label: 'EDGE COMPARISON',
    preset: 'green',
    params: {},
    panelSections: ['EDGE'],
    primary: 'softness',
    captionParts: ['EDGE @ 0.000 / 0.040'],
    splitConfig: {
      left:  { softness: 0.000 },
      right: { softness: 0.040 },
    },
  },
  {
    id: '06',
    label: 'MODULATION PEAK',
    preset: 'blue',
    params: {},
    panelSections: ['MODULATION'],
    primary: 'bassToSlow',
    captionParts: ['MODULATION @ AUDIO PEAK'],
    forceModulationPeak: true,     // synthetic max signals at capture time
  },
];

// Section descriptors — drives the panel-fragment renderer.
// Each section lists (key, label, min, max, format) for the rows it shows.
export const SECTION_DEFS = {
  THRESHOLD: {
    title: 'THRESHOLD',
    rows: [
      { key: 'thresholdBase',    label: 'BASE',    min: 0,    max: 1,    fmt: (v) => v.toFixed(2) },
      { key: 'thresholdLFOAmp',  label: 'LFO AMP', min: 0,    max: 0.3,  fmt: (v) => v.toFixed(2) },
      { key: 'thresholdLFOFreq', label: 'LFO HZ',  min: 0.01, max: 1.0,  fmt: (v) => v.toFixed(2) },
    ],
  },
  BOIL: {
    title: 'BOIL',
    rows: [
      { key: 'ditherScale', label: 'SCALE', min: 50, max: 1500, fmt: (v) => v.toFixed(0) },
      { key: 'ditherSpeed', label: 'SPEED', min: 0,  max: 1,    fmt: (v) => v.toFixed(2) },
      { key: 'ditherAmp',   label: 'AMP',   min: 0,  max: 0.3,  fmt: (v) => v.toFixed(2) },
    ],
  },
  'SLOW FIELD': {
    title: 'SLOW FIELD',
    rows: [
      { key: 'slowNoiseScale', label: 'SCALE', min: 0.5, max: 12,   fmt: (v) => v.toFixed(1) },
      { key: 'slowNoiseSpeed', label: 'SPEED', min: 0,   max: 1,    fmt: (v) => v.toFixed(2) },
      { key: 'slowAmp',        label: 'AMP',   min: 0,   max: 0.6,  fmt: (v) => v.toFixed(2) },
      { key: 'warpAmp',        label: 'WARP',  min: 0,   max: 0.06, fmt: (v) => v.toFixed(3) },
    ],
  },
  EDGE: {
    title: 'EDGE',
    rows: [
      { key: 'softness', label: 'SOFTNESS', min: 0, max: 0.05, fmt: (v) => v.toFixed(3) },
    ],
  },
  MODULATION: {
    title: 'MODULATION',
    rows: [
      // For specimen 06 we show the audio routing depths since those are what's "active".
      { key: 'bassToSlow',   label: 'BASS → SLOW',  min: 0, max: 1,    fmt: (v) => v.toFixed(2),  fromObj: 'modulation.audio' },
      { key: 'bassToWarp',   label: 'BASS → WARP',  min: 0, max: 0.12, fmt: (v) => v.toFixed(3), fromObj: 'modulation.audio' },
      { key: 'bassToFlash',  label: 'BASS → FLASH', min: 0, max: 0.5,  fmt: (v) => v.toFixed(2), fromObj: 'modulation.audio' },
      { key: 'rmsToBoil',    label: 'RMS → BOIL',   min: 0, max: 0.4,  fmt: (v) => v.toFixed(2), fromObj: 'modulation.audio' },
    ],
  },
};
