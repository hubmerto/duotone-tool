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

// ----- dual-playhead temporal effect --------------------------------------------
// Two virtual playheads (A and B) read from the same ring buffer. JS runs the
// IDLE / FROZEN / MORPHING state machine and sends back the resolved layer
// indices + morph progress. The shader is purely a sampler.
uniform int   u_bufferSize;           // active wrap modulus (auto-sized from params)
uniform int   u_bufferWriteIndex;     // next-to-write slot (live = idx-1, mod size)
uniform int   u_layerVis;             // visible head's layer (frozen frame, or live)
uniform int   u_layerOther;           // other head's layer (always live during freeze)
uniform float u_morphT;               // 0 (no blend) .. 1 (fully transitioned to other)
uniform float u_dpIntensity;          // 0 = bypass (sample u_video directly), 1 = full DP

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

// ============================================================================
// dual-playhead temporal sampling
// ============================================================================
//
// Output is mix(layerVis, layerOther, morphT) in luma space.
//   - IDLE:      both heads at live layer → layerVis == layerOther, morphT = 0
//                (output = current frame, identical to bypass visually)
//   - FROZEN:    visible head holds at frozenAtLayer, other at live, morphT = 0
//                (output = visible head's frozen frame)
//   - MORPHING:  same layer indices, morphT animates 0 → 1 (eased in JS)
//                (output crossfades from frozen frame to live frame)
//   - intensity = 0 short-circuits to u_video for true zero-overhead bypass.
//
// luma-space blend: extract dot(rgb, rec709) from each layer, mix the scalar,
// emit grey. Downstream threshold uses luma anyway, so this is mathematically
// equivalent to a per-channel RGB blend in this pipeline — but staying in luma
// keeps the contract obvious and lets the comment match the spec.
//
vec3 sampleDP(vec2 uv) {
    if (u_dpIntensity < 0.001) {
        return texture(u_video, uv).rgb;
    }

    vec3 visC = texture(u_buffer, vec3(uv, float(u_layerVis))).rgb;
    vec3 othC = texture(u_buffer, vec3(uv, float(u_layerOther))).rgb;

    float lumaV = dot(visC, vec3(0.2126, 0.7152, 0.0722));
    float lumaO = dot(othC, vec3(0.2126, 0.7152, 0.0722));
    float L = mix(lumaV, lumaO, clamp(u_morphT, 0.0, 1.0));
    vec3 dp = vec3(L);

    // Partial intensity → blend with full-res bypass.
    if (u_dpIntensity < 1.0) {
        return mix(texture(u_video, uv).rgb, dp, u_dpIntensity);
    }
    return dp;
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

    // luma — sampled through dual-playhead pass at warpedUV
    vec3 src  = sampleDP(warpedUV);
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
