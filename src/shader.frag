#version 300 es
// =============================================================================
// 1-bit duotone with animated "boiling threshold" + Two Layer pause-and-catch-up
// + radiance intro. Single-pass.
//
// Pipeline:
//   videoA & videoB ──► (JS) per-rVFC write to ring buffer (A's frames only,
//                       since A is the layer that does catch-up trail sampling)
//                       │
//                       ▼
//   shader: sampleTwoLayer(uv) — composites layer A and B in luma space
//                       │       (A may be a trail-blend during catch-up phase)
//                       ▼
//                     luma
//                       │
//                       ▼
//   slow fbm field  →  warpedUV
//   fast blue noise →  threshold T
//   per-pixel introT (4 modes: develop, radiance, aperture, scanline)
//                       │
//                       ▼
//                  smoothstep mask  →  duotone mix
// =============================================================================

precision highp float;
precision highp sampler2DArray;

in vec2 v_uv;
out vec4 fragColor;

// ----- texture inputs -----------------------------------------------------------
uniform sampler2D       u_videoA;            // live frame from layer A
uniform sampler2D       u_videoB;            // live frame from layer B
uniform sampler2DArray  u_buffer;            // ring buffer of past A frames

// ----- frame state --------------------------------------------------------------
uniform vec2  u_resolution;
uniform float u_time;
uniform int   u_frame;

// ----- color --------------------------------------------------------------------
uniform vec3  u_spotColor;
uniform vec3  u_shadowColor;          // below-threshold color (classic: black)
uniform int   u_colorMode;            // 0=spot color, 1=original video colors

// ----- threshold ----------------------------------------------------------------
uniform float u_thresholdBase;
uniform float u_thresholdLFOAmp;
uniform float u_thresholdLFOFreq;

// ----- intro (4 modes) ----------------------------------------------------------
uniform int   u_introMode;            // 0=develop, 1=radiance, 2=aperture, 3=scanline
uniform float u_introDuration;
uniform int   u_introCurve;
uniform vec2  u_introOrigin;
uniform float u_introSpread;
uniform float u_introFalloff;
uniform float u_introDirectionality;
uniform float u_introAngle;
uniform float u_introTurbulence;

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

// ----- Two Layer compositing ----------------------------------------------------
// All phase / timing logic lives in JS; the shader just samples + composites.
uniform int   u_twoLayerEnabled;        // 1 = composite A+B, 0 = bypass (use A only)
uniform int   u_layerBlendMode;         // 0=luma 50/50, 1=screen, 2=multiply
uniform float u_layerBlendBalance;      // 0..1 (0 = full B, 1 = full A)
uniform int   u_isCatchupActive;        // 1 = render A as trail-blend over buffer
uniform int   u_trailSampleCount;       // 4..16
uniform int   u_trailStyle;             // 0=smear (weighted avg), 1=glitch (max)
uniform int   u_bufferSize;             // ring-buffer wrap modulus
uniform int   u_bufferWriteIndex;       // next-to-write slot

// ============================================================================
// helpers
// ============================================================================
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
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
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
int wrapLayer(int idx) {
    int s = max(u_bufferSize, 1);
    return ((idx % s) + s) % s;
}
float lumaOf(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }

// ============================================================================
// Two-Layer compositing — produces a single luma scalar that the threshold
// pass operates on. Logic by phase:
//
//   not-catchup (sync / hold / resync):
//     lumaA = luma(u_videoA)
//     lumaB = luma(u_videoB)
//     out   = blend(lumaA, lumaB) per layerBlendMode + balance
//
//   catchup:
//     lumaA = trail-blend of N past A frames from u_buffer (smear or glitch)
//     lumaB = luma(u_videoB)        (B is paused — its texture is its frozen frame)
//     out   = blend(lumaA, lumaB) per layerBlendMode + balance
//
//   twoLayerEnabled = 0:
//     out   = luma(u_videoA)        (full bypass — single layer pipeline)
// ============================================================================
// In spot mode (u_colorMode == 0) every sample collapses to vec3(luma) before
// blending, so the per-channel math below is bit-identical to the old
// luma-scalar path. In original mode (1) samples keep their RGB and the same
// blends run per channel — the mask luma is taken from the composite.
vec3 srcSample(sampler2D tex, vec2 uv) {
    vec3 rgb = texture(tex, uv).rgb;
    return (u_colorMode == 1) ? rgb : vec3(lumaOf(rgb));
}

vec3 sampleTwoLayer(vec2 uv) {
    if (u_twoLayerEnabled == 0) {
        return srcSample(u_videoA, uv);
    }

    // --- Layer A: live frame, OR trail-blend during catch-up ---
    vec3 colA;
    if (u_isCatchupActive == 1 && u_trailSampleCount > 0) {
        int liveLayer = wrapLayer(u_bufferWriteIndex - 1);
        // Walk back through the most recent N buffer slots — these are A's
        // frames captured during the active catch-up race. Newest = highest
        // weight in smear; max() in glitch.
        vec3  accum  = vec3(0.0);
        float wsum   = 0.0;
        for (int i = 0; i < 16; i++) {
            if (i >= u_trailSampleCount) break;
            int layer = wrapLayer(liveLayer - i);
            vec3 s = texture(u_buffer, vec3(uv, float(layer))).rgb;
            if (u_colorMode != 1) s = vec3(lumaOf(s));
            if (u_trailStyle == 1) {
                // glitch — max per channel (max in luma for spot mode)
                accum = max(accum, s);
            } else {
                // smear — weighted avg, oldest 0.4, newest 1.0
                float t  = 1.0 - float(i) / max(1.0, float(u_trailSampleCount - 1));
                float w  = 0.4 + 0.6 * t;
                accum   += s * w;
                wsum    += w;
            }
        }
        colA = (u_trailStyle == 1) ? accum : (accum / max(1e-4, wsum));
    } else {
        colA = srcSample(u_videoA, uv);
    }

    // --- Layer B: always live frame from videoB ---
    vec3 colB = srcSample(u_videoB, uv);

    // --- Composite ---
    float bal = clamp(u_layerBlendBalance, 0.0, 1.0);
    vec3 out_;
    if (u_layerBlendMode == 1) {
        // screen blend
        out_ = 1.0 - (1.0 - colA) * (1.0 - colB);
        // bias toward A or B per balance — (1-bal)*B-leaning vs bal*A-leaning
        out_ = mix(colB, mix(colA, out_, 0.6), bal);
    } else if (u_layerBlendMode == 2) {
        // multiply
        out_ = colA * colB;
        out_ = mix(colB, mix(colA, out_, 0.6), bal);
    } else {
        // 50/50 with balance — simple linear mix
        out_ = mix(colB, colA, bal);
    }
    return clamp(out_, 0.0, 1.0);
}

// ============================================================================
// per-pixel intro progress (unchanged)
// ============================================================================
float computeIntroT(vec2 uv) {
    float t        = clamp(u_time / max(u_introDuration, 1e-4), 0.0, 1.0);
    float t_eased  = ease(t, u_introCurve);
    if (u_introMode == 0) return t_eased;

    float dist;
    if (u_introMode == 1) {
        float radial = length(uv - u_introOrigin);
        vec2  dir    = vec2(cos(u_introAngle), sin(u_introAngle));
        float direct = dot(uv - u_introOrigin, dir) + 0.7;
        dist = mix(radial, direct, clamp(u_introDirectionality, 0.0, 1.0));
    } else if (u_introMode == 2) {
        dist = 1.0 - length(uv - u_introOrigin);
    } else {
        vec2 dir = vec2(cos(u_introAngle), sin(u_introAngle));
        dist = dot(uv - u_introOrigin, dir) + 0.7;
    }
    dist += (fbm(uv * 3.0 + u_time * 0.15) - 0.5) * u_introTurbulence;

    float wavefront = t_eased * (1.0 + u_introSpread);
    float p = smoothstep(wavefront - u_introSpread, wavefront, dist);
    p = pow(max(p, 0.0), mix(1.0, 0.3, clamp(u_introFalloff, 0.0, 1.0)));
    return 1.0 - p;
}

// ============================================================================
// main
// ============================================================================
void main() {
    vec2 uv = v_uv;

    // Slow field + warp are pure ALU cost when their amps are 0 (the default
    // preset ships both off) — skip the fbm stacks entirely in that case.
    vec2 p = uv * u_slowNoiseScale + u_time * u_slowNoiseSpeed;
    float slowField = 0.0;
    if (u_slowAmp > 0.0001) {
        slowField = fbm(p + fbm(p + fbm(p)));
    }

    vec2 warpedUV = uv;
    if (u_warpAmp > 0.0001) {
        warpedUV = uv + vec2(
            fbm(p + vec2(0.00, 0.00)),
            fbm(p + vec2(5.20, 1.30))
        ) * u_warpAmp;
    }

    // composite from two video layers (with optional trail during catchup)
    vec3  comp = sampleTwoLayer(warpedUV);
    float luma = lumaOf(comp);

    float ditherTime = float(u_frame) * 0.61803398875 * u_ditherSpeed;
    float fastNoise  = fract(pseudoBlue(uv * u_ditherScale) + ditherTime) - 0.5;

    float lfo = u_thresholdLFOAmp * sin(6.28318530718 * u_thresholdLFOFreq * u_time);

    float T = u_thresholdBase
            + lfo
            + slowField * u_slowAmp
            + fastNoise * u_ditherAmp;

    float introT  = computeIntroT(uv);
    float T_final = mix(1.0, T, introT);

    float mask = smoothstep(T_final - u_softness, T_final + u_softness, luma);
    // spot mode: flat spot color as the ink. original mode: the video's own
    // colors as the ink — same threshold cut. Shadow is the below-threshold
    // color (classic look: black).
    vec3 ink   = (u_colorMode == 1) ? comp : u_spotColor;
    fragColor  = vec4(mix(ink, u_shadowColor, 1.0 - mask), 1.0);
}
