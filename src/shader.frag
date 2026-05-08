#version 300 es
// =============================================================================
// 1-bit duotone with animated "boiling threshold" + temporal effects + radiance
// intro. Single-pass.
//
// Pipeline:
//   video frame ──► (JS) write quarter-res to ring-buffer layer
//                       │
//                       ▼
//   shader: sampleTemporal(uv)  ─── stutter / morph / rewind / mix-all
//                       │
//                       ▼
//                     luma
//                       │
//                       ▼
//   slow fbm field  →  warpedUV (re-sampled if mode==0; else passed in)
//   fast blue noise →  threshold T
//   per-pixel introT (4 modes: develop, radiance, aperture, scanline)
//                       │
//                       ▼
//                  smoothstep mask  →  duotone mix
//
// All randomness is seeded by u_frame / u_time / u_temporalSeed so recordings
// are reproducible.
// =============================================================================

precision highp float;
precision highp sampler2DArray;

in vec2 v_uv;
out vec4 fragColor;

// ----- texture inputs -----------------------------------------------------------
uniform sampler2D       u_video;             // used when u_temporalMode == 0
uniform sampler2DArray  u_buffer;            // ring buffer of past quarter-res frames

// ----- frame state --------------------------------------------------------------
uniform vec2  u_resolution;
uniform float u_time;
uniform int   u_frame;

// ----- color --------------------------------------------------------------------
uniform vec3  u_spotColor;

// ----- threshold ----------------------------------------------------------------
uniform float u_thresholdBase;
uniform float u_thresholdLFOAmp;
uniform float u_thresholdLFOFreq;

// ----- intro (4 modes) ----------------------------------------------------------
uniform int   u_introMode;            // 0=develop, 1=radiance, 2=aperture, 3=scanline
uniform float u_introDuration;
uniform int   u_introCurve;           // 0=linear, 1=easeOut, 2=easeInOut
uniform vec2  u_introOrigin;          // 0..1 in UV space
uniform float u_introSpread;          // wavefront thickness
uniform float u_introFalloff;         // 0=hard edge, 1=soft halo
uniform float u_introDirectionality;  // 0=radial, 1=directional (radiance mode only)
uniform float u_introAngle;           // radians
uniform float u_introTurbulence;      // 0..1 fbm warp on the wavefront

// ----- slow ink-blob field ------------------------------------------------------
uniform float u_slowNoiseScale;
uniform float u_slowNoiseSpeed;
uniform float u_slowAmp;
uniform float u_warpAmp;

// ----- fast boil ----------------------------------------------------------------
uniform float u_ditherScale;
uniform float u_ditherSpeed;
uniform float u_ditherAmp;

// ----- edge ---------------------------------------------------------------------
uniform float u_softness;

// ----- temporal effects ---------------------------------------------------------
uniform int   u_temporalMode;         // 0=off, 1=stutter, 2=morph, 3=rewind, 4=mix-all
uniform int   u_bufferSize;           // active depth (16..120)
uniform int   u_bufferWriteIndex;     // next-to-write slot (live = idx-1, mod size)
uniform float u_stutterAmount;        // 0..1 prob of holding a frame
uniform float u_stutterHoldFrames;    // chunk length for the stutter
uniform float u_morphBlend;           // 0..1
uniform float u_morphSpread;          // frames apart for morph
uniform float u_rewindOffset;         // JS-driven offset (frames-back) during rewind
uniform float u_temporalSeed;         // for reproducibility

// ============================================================================
// helpers
// ============================================================================

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
    return -1.0 + 2.0 * fract(p.x * p.y * (p.x + p.y));
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * vnoise(p);
        p *= 2.02;
        a *= 0.5;
    }
    return v;
}

float pseudoBlue(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float ease(float t, int curve) {
    if (curve == 0) return t;
    if (curve == 1) return 1.0 - pow(1.0 - t, 3.0);
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5;
}

// wrap an int into [0, u_bufferSize) — handles negatives
int wrapLayer(int idx) {
    int s = max(u_bufferSize, 1);
    return ((idx % s) + s) % s;
}

// ============================================================================
// temporal sampling — module 1
// ============================================================================
//
// Mode 0 is a true bypass: directly sample u_video at full resolution. Modes
// 1-4 sample from the ring buffer (quarter-res) at a manipulated layer index.
//
vec3 sampleTemporal(vec2 uv) {
    if (u_temporalMode == 0) {
        return texture(u_video, uv).rgb;
    }

    int liveLayer = wrapLayer(u_bufferWriteIndex - 1);

    // Mix-all: pick one mode for ~1.4s at a time, seeded random
    int mode = u_temporalMode;
    if (mode == 4) {
        float bucket = floor(u_time * 0.7);
        float r = hash11(bucket + u_temporalSeed);
        if      (r < 0.40) mode = 1;
        else if (r < 0.75) mode = 2;
        else               mode = 3;
    }

    // Stutter: divide frames into chunks, with prob stutterAmount per chunk
    // freeze on the chunk's first frame for the whole chunk.
    if (mode == 1) {
        float chunk = max(u_stutterHoldFrames, 1.0);
        float bucket = floor(float(u_frame) / chunk);
        if (hash11(bucket + u_temporalSeed) < u_stutterAmount) {
            int freezeOff = int(mod(float(u_frame), chunk));
            int layer = wrapLayer(liveLayer - freezeOff);
            return texture(u_buffer, vec3(uv, float(layer))).rgb;
        }
        return texture(u_buffer, vec3(uv, float(liveLayer))).rgb;
    }

    // Morph: blend live with frame N back. luma is linear in dot product so
    // RGB blend == luma blend in this pipeline (we only use luma downstream).
    if (mode == 2) {
        int spread = int(max(u_morphSpread, 1.0));
        int layerB = wrapLayer(liveLayer - spread);
        vec3 a = texture(u_buffer, vec3(uv, float(liveLayer))).rgb;
        vec3 b = texture(u_buffer, vec3(uv, float(layerB))).rgb;
        return mix(a, b, u_morphBlend);
    }

    // Rewind: JS-driven offset into the past (eased back toward 0).
    if (mode == 3) {
        int layer = wrapLayer(liveLayer - int(u_rewindOffset));
        return texture(u_buffer, vec3(uv, float(layer))).rgb;
    }

    return texture(u_buffer, vec3(uv, float(liveLayer))).rgb;
}

// ============================================================================
// per-pixel intro progress — module 2
// ============================================================================
//
// Returns 0 (unaffected → black-out at intro start) ramping to 1 (live effect).
// Mode 0: global scalar (existing develop intro).
// Modes 1-3: spatial wavefront, fbm-perturbed for an organic boundary.
//
float computeIntroT(vec2 uv) {
    float t        = clamp(u_time / max(u_introDuration, 1e-4), 0.0, 1.0);
    float t_eased  = ease(t, u_introCurve);

    if (u_introMode == 0) {
        return t_eased;
    }

    // distance-from-front depending on mode
    float dist;
    if (u_introMode == 1) {
        // radiance: outward from origin (optionally biased toward an angle)
        float radial = length(uv - u_introOrigin);
        vec2  dir    = vec2(cos(u_introAngle), sin(u_introAngle));
        float direct = dot(uv - u_introOrigin, dir) + 0.7;
        dist = mix(radial, direct, clamp(u_introDirectionality, 0.0, 1.0));
    } else if (u_introMode == 2) {
        // aperture: contracts inward — far points "exposed" first, center last
        dist = 1.0 - length(uv - u_introOrigin);
    } else {
        // scanline: linear wavefront along u_introAngle
        vec2 dir = vec2(cos(u_introAngle), sin(u_introAngle));
        dist = dot(uv - u_introOrigin, dir) + 0.7;
    }

    // fbm perturbation — organic instead of mechanical
    dist += (fbm(uv * 3.0 + u_time * 0.15) - 0.5) * u_introTurbulence;

    float wavefront = t_eased * (1.0 + u_introSpread);
    float p = smoothstep(wavefront - u_introSpread, wavefront, dist);
    p = pow(max(p, 0.0), mix(1.0, 0.3, clamp(u_introFalloff, 0.0, 1.0)));

    // p == 1 → not yet reached; p == 0 → fully exposed
    // existing convention: introT == 0 means "intro start" (black-out)
    return 1.0 - p;
}

// ============================================================================
// main
// ============================================================================
void main() {
    vec2 uv = v_uv;

    // slow ink-blob field
    vec2 p = uv * u_slowNoiseScale + u_time * u_slowNoiseSpeed;
    float slowField = fbm(p + fbm(p + fbm(p)));

    // UV warp (morphism)
    vec2 warpVec = vec2(
        fbm(p + vec2(0.00, 0.00)),
        fbm(p + vec2(5.20, 1.30))
    ) * u_warpAmp;
    vec2 warpedUV = uv + warpVec;

    // luma — sampled through temporal pass at warpedUV
    vec3 src  = sampleTemporal(warpedUV);
    float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));

    // fast boil
    float ditherTime = float(u_frame) * 0.61803398875 * u_ditherSpeed;
    float fastNoise  = fract(pseudoBlue(uv * u_ditherScale) + ditherTime) - 0.5;

    // LFO
    float lfo = u_thresholdLFOAmp * sin(6.28318530718 * u_thresholdLFOFreq * u_time);

    // composite threshold
    float T = u_thresholdBase
            + lfo
            + slowField * u_slowAmp
            + fastNoise * u_ditherAmp;

    // per-pixel intro
    float introT  = computeIntroT(uv);
    float T_final = mix(1.0, T, introT);

    // soft edge
    float mask = smoothstep(T_final - u_softness, T_final + u_softness, luma);

    // duotone
    fragColor = vec4(mix(u_spotColor, vec3(0.0), 1.0 - mask), 1.0);
}
