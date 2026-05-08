#version 300 es
// =============================================================================
// 1-bit duotone with animated "boiling threshold". Single-pass.
//
// Recipe (matches build spec + UV-morph extension):
//   0. warp  = same fbm field, sampled twice at decorrelated offsets, used as
//              a 2D displacement on the UV before sampling. This is what makes
//              the *image content* ripple/morph coherently with the ink, not
//              just the threshold edge. The "morphism" of the boiling-threshold
//              look comes mostly from this step.
//   1. luma  = Rec.709 on video sample at warped UV
//   2. slow  = domain-warped fbm — the "ink-blob" field that drifts slowly
//   3. fast  = blue-noise dither + golden-ratio time offset — the "boil"
//   4. lfo   = sin breathing on the threshold center
//   5. T     = thresholdBase + lfo + slowField*slowAmp + fastNoise*ditherAmp
//   6. intro = ease(time / introDuration) ramps T from 1.0 (all-black) -> T
//   7. mask  = smoothstep(T - softness, T + softness, luma)
//   8. out   = mix(spotColor, black, 1 - mask) — luma > T -> spotColor
//
// Noise functions are inlined (iq's value-noise fbm + hash pseudo-blue-noise)
// per spec fallback; swap to lygia by including its files later if desired.
// =============================================================================

precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_video;
uniform vec2  u_resolution;
uniform float u_time;
uniform int   u_frame;

// color
uniform vec3  u_spotColor;

// threshold
uniform float u_thresholdBase;
uniform float u_thresholdLFOAmp;
uniform float u_thresholdLFOFreq;

// intro
uniform float u_introDuration;
uniform int   u_introCurve;       // 0=linear, 1=easeOut, 2=easeInOut

// slow ink-blob field
uniform float u_slowNoiseScale;
uniform float u_slowNoiseSpeed;
uniform float u_slowAmp;
uniform float u_warpAmp;          // UV displacement — the morphism knob

// fast grain / boil
uniform float u_ditherScale;
uniform float u_ditherSpeed;
uniform float u_ditherAmp;

// edge softness
uniform float u_softness;

// -----------------------------------------------------------------------------
// noise — inigo quilez value noise + fbm
// https://iquilezles.org/articles/fbm/
// -----------------------------------------------------------------------------
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
    return v; // approximately -0.5..0.5
}

// -----------------------------------------------------------------------------
// pseudo-blue-noise hash — dependency-free fallback for lygia/blueNoise
// -----------------------------------------------------------------------------
float pseudoBlue(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// -----------------------------------------------------------------------------
// easing
// -----------------------------------------------------------------------------
float ease(float t, int curve) {
    if (curve == 0) return t; // linear
    if (curve == 1) return 1.0 - pow(1.0 - t, 3.0); // easeOutCubic
    // easeInOutCubic
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5;
}

// =============================================================================
void main() {
    vec2 uv = v_uv;

    // 2. slow ink-blob field — iq-style domain warping (computed first so we
    //    can also use it for UV displacement)
    vec2 p = uv * u_slowNoiseScale + u_time * u_slowNoiseSpeed;
    float slowField = fbm(p + fbm(p + fbm(p))); // already roughly centered

    // 0. UV warp — sample the same field twice at decorrelated offsets to get
    //    a 2D displacement vector. The image content morphs along with the
    //    ink-blob field; this is what gives the "morphism" feel.
    vec2 warpVec = vec2(
        fbm(p + vec2(0.00, 0.00)),
        fbm(p + vec2(5.20, 1.30))
    ) * u_warpAmp;
    vec2 warpedUV = uv + warpVec;

    // 1. luma — Rec.709, sampled from the warped UV
    vec3 src = texture(u_video, warpedUV).rgb;
    float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));

    // 3. fast boil — golden-ratio time offset reseeds dither without strobing
    //    (Xor's trick: phi-spaced offsets are maximally low-discrepancy)
    float ditherTime = float(u_frame) * 0.61803398875 * u_ditherSpeed;
    float fastNoise  = fract(pseudoBlue(uv * u_ditherScale) + ditherTime) - 0.5;

    // 4. LFO — slow breathing on threshold center
    float lfo = u_thresholdLFOAmp * sin(6.28318530718 * u_thresholdLFOFreq * u_time);

    // 5. composite threshold
    float T = u_thresholdBase
            + lfo
            + slowField * u_slowAmp
            + fastNoise * u_ditherAmp;

    // 6. intro ramp — at t=0, T_final=1.0 forces mask=0 (all black);
    //    as introT->1, T_final approaches the live composite T
    float introT  = ease(clamp(u_time / max(u_introDuration, 1e-4), 0.0, 1.0), u_introCurve);
    float T_final = mix(1.0, T, introT);

    // 7. soft edge — smoothstep gives sub-pixel softness without filtering luma
    float mask = smoothstep(T_final - u_softness, T_final + u_softness, luma);

    // 8. duotone — luma below T -> black, above -> spot color
    fragColor = vec4(mix(u_spotColor, vec3(0.0), 1.0 - mask), 1.0);
}
