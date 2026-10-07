#version 300 es
// =============================================================================
// 1-bit duotone with animated "boiling threshold" + Two Layer pause-and-catch-up
// + intro. Single pass.
//
// Pipeline:
//   videoA & videoB ──► (JS) per-rVFC write to ring buffer (A's frames only,
//                       since A is the layer that does catch-up trail sampling)
//                       │
//                       ▼
//   shader: sampleTwoLayer(uv) — composites layer A and B
//           (A may be a box-exposure trail during catch-up)
//                       │
//                       ▼
//                 threshold luma L  (Y' legacy, or CIE L* from linear Y)
//                       │
//                       ▼
//   slow field  (value-noise fbm legacy, or simplex3 with vector / curl warp)
//   boil        (white-noise legacy, or blue-noise tile / halftone / Bayer / IGN,
//                held per drawing on 2s or 3s)
//   per-pixel intro progress (develop / radiance / aperture / scanline)
//                       │
//                       ▼
//   edge (luma smoothstep legacy, or pixel-distance edge with bleed, halo,
//         roughness) → colour model (replace / ink over paper / duotone / riso)
//
// Every new path sits behind an int mode uniform whose default 0 runs the
// legacy code, so presets keep their look until a mode is switched.
// =============================================================================

precision highp float;
precision highp sampler2DArray;

in vec2 v_uv;
out vec4 fragColor;

// ----- texture inputs -----------------------------------------------------------
uniform sampler2D       u_videoA;            // live frame from layer A
uniform sampler2D       u_videoB;            // live frame from layer B
uniform sampler2DArray  u_buffer;            // ring buffer of past A frames
uniform sampler2D       u_blueNoise;         // 64x64 R8 void-and-cluster tile

// ----- frame state --------------------------------------------------------------
uniform vec2  u_resolution;
uniform vec4  u_fit;                  // uv scale.xy + offset.zw of the picture inside the canvas
uniform float u_time;
uniform int   u_frame;

// ----- color --------------------------------------------------------------------
uniform vec3  u_spotColor;
uniform vec3  u_shadowColor;          // below-threshold color (classic: black); the paper in the ink models
uniform int   u_colorMode;            // 0=spot color, 1=original video colors
uniform int   u_colorModel;           // 0 legacy replace, 1 ink over paper, 2 duotone (two screens), 3 riso two-ink
uniform vec3  u_inkB;                 // second ink (duotone / riso)
uniform float u_inkOpacity;           // 1 = opaque ink (legacy look), 0 = pure multiply
uniform int   u_alphaMode;            // 0 opaque, 1 key paper (keep ink), 2 key ink (keep paper)
uniform float u_misregPx;             // riso: rigid per-ink shift per drawing, px
uniform float u_lpi, u_printHeightIn, u_screenAngle;

// ----- threshold ----------------------------------------------------------------
uniform int   u_lumaMode;             // 0 legacy Y' on encoded RGB, 1 CIE L* from linear Y
uniform float u_thresholdBase;
uniform float u_thresholdLFOAmp;
uniform float u_thresholdLFOFreq;

// ----- depth (Depth Anything map of the picture, 0 far .. 1 near) ---------------
uniform sampler2D u_depth;
uniform int   u_depthOn;
uniform float u_depthAmt;             // threshold swing between far and near (positive: near ink, far paper)
uniform float u_depthMid;             // the depth that leaves the threshold untouched
uniform int   u_depthView;            // 1: show the depth map instead of the picture

// ----- intro (4 modes) ----------------------------------------------------------
uniform int   u_introMode;            // 0=develop, 1=radiance, 2=aperture, 3=scanline
uniform int   u_introModel;           // 0 legacy, 1 physical (develop curve, round iris in px, scanner lamp)
uniform float u_introDuration;
uniform int   u_introCurve;
uniform vec2  u_introOrigin;
uniform float u_introSpread;
uniform float u_introFalloff;
uniform float u_introDirectionality;
uniform float u_introAngle;
uniform float u_introTurbulence;
uniform float u_introInduction;       // develop: fraction of the duration before anything appears
uniform float u_introFrom;            // threshold the intro ramps from (1 = shadow first, 0 = ink first)
uniform float u_scanLampGain, u_scanLampPx, u_scanLinesPerFrame;

// ----- slow ink-blob field ------------------------------------------------------
uniform int   u_fieldMode;            // 0 legacy value fbm, 1 simplex3 + vector warp, 2 + curl warp
uniform float u_slowNoiseScale;
uniform float u_slowNoiseSpeed;
uniform float u_slowAmp;
uniform float u_warpAmp;

// ----- boil ---------------------------------------------------------------------
uniform int   u_ditherMode;           // 0 legacy white noise, 1 blue tile, 2 halftone screen, 3 Bayer 8x8, 4 IGN
uniform int   u_boilHold;             // 0 legacy per-frame; else hold each drawing N frames of the 24 fps drawing clock
uniform float u_boilCycle;            // distinct drawings in the loop (3 = classic three-tracing boil)
uniform float u_boilKick;             // time of the last kick onset (<0 = none): forces a new drawing
uniform float u_ditherScale;
uniform float u_ditherSpeed;
uniform float u_ditherAmp;

// ----- edge ---------------------------------------------------------------------
uniform int   u_edgeMode;             // 0 legacy luma smoothstep, 1 pixel-distance edge
uniform float u_softness;
uniform float u_bleedPx, u_haloPx, u_haloStrength, u_edgeRoughPx, u_edgeTemporal;

// ----- Two Layer compositing ----------------------------------------------------
uniform int   u_twoLayerEnabled;        // 1 = composite A+B, 0 = bypass (use A only)
uniform int   u_layerBlendMode;         // 0=luma 50/50, 1=screen, 2=multiply
uniform float u_layerBlendBalance;      // 0..1 (0 = full B, 1 = full A)
uniform int   u_isCatchupActive;        // 1 = render A as trail-blend over buffer
uniform int   u_trailSampleCount;       // 4..16
uniform int   u_trailStyle;             // 0=smear, 1=glitch (max)
uniform int   u_trailMode;              // 0 legacy newest-heavy, 1 box exposure over the catch-up window
uniform float u_trailFrames;            // ring writes since the catch-up started (box window)
uniform int   u_bufferSize;             // ring-buffer wrap modulus
uniform int   u_bufferWriteIndex;       // next-to-write slot

const float PHI = 0.61803398875;
const float TAU = 6.28318530718;

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
vec3 lin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 enc(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float Lstar01(float Y){ return Y > 0.008856 ? 1.16 * pow(Y, 1.0 / 3.0) - 0.16 : 9.033 * Y; }
float lumaOf(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }
// threshold-space lightness: legacy Y' on encoded values, or L* (perceptual) from linear luminance
float thresholdLuma(vec3 rgb) {
    if (u_lumaMode == 0) return lumaOf(rgb);
    return Lstar01(dot(lin(rgb), vec3(0.2126, 0.7152, 0.0722)));
}

// ----- simplex noise 3D (Ashima Arts / Stefan Gustavson, MIT) -------------------
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm3(vec3 p) {                               // 3 octaves, 0..1
    float a = 0.5, s = 0.0;
    for (int o = 0; o < 3; o++) { s += a * snoise(p); p = p * 2.02 + vec3(17.1, 3.7, 0.0); a *= 0.5; }
    return 0.5 + 0.5 * s / 0.875;
}

// ============================================================================
// slow field: legacy value-noise fbm with scalar warp, or simplex3 evolving in
// place (time as z) with Quilez's vector warp; mode 2 warps the video with the
// curl of a noise potential, which is divergence-free (no pinch points)
// ============================================================================
float slowFieldAt(vec2 uv, out vec2 warpUV) {
    warpUV = vec2(0.0);
    if (u_fieldMode == 0) {
        vec2 p = uv * u_slowNoiseScale + u_time * u_slowNoiseSpeed;
        float f = 0.0;
        if (u_slowAmp > 0.0001) f = fbm(p + fbm(p + fbm(p)));
        if (u_warpAmp > 0.0001) warpUV = vec2(fbm(p + vec2(0.00, 0.00)), fbm(p + vec2(5.20, 1.30))) * u_warpAmp;
        return f;
    }
    float aspect = u_resolution.x / u_resolution.y;
    float z = mod(u_time * u_slowNoiseSpeed, 289.0);
    vec3 p = vec3(uv * vec2(aspect, 1.0) * u_slowNoiseScale, z);
    float f = 0.0;
    vec2 q = vec2(0.0);
    if (u_slowAmp > 0.0001 || (u_warpAmp > 0.0001 && u_fieldMode == 1)) {
        q = vec2(fbm3(p), fbm3(p + vec3(5.2, 1.3, 0.0))) - 0.5;      // Quilez level 1, vector
    }
    if (u_slowAmp > 0.0001) f = fbm3(p + vec3(4.0 * q, 0.0));
    if (u_warpAmp > 0.0001) {
        if (u_fieldMode == 2) {                                        // curl of a 1-octave potential
            const float e = 0.05; vec3 pp = p * 0.5;
            float dy = snoise(pp + vec3(0.0, e, 0.0)) - snoise(pp - vec3(0.0, e, 0.0));
            float dx = snoise(pp + vec3(e, 0.0, 0.0)) - snoise(pp - vec3(e, 0.0, 0.0));
            warpUV = vec2(dy, -dx) / (2.0 * e) * (u_warpAmp / 3.0);
        } else {
            warpUV = q * 2.0 * u_warpAmp;
        }
    }
    return f;
}

// ============================================================================
// boil: the drawing clock, and the dither value per cell
// ============================================================================
float drawingIndex(float t) {
    float N = float(max(u_boilHold, 1));
    float k = floor(t * 24.0 / N);
    if (u_boilKick >= 0.0) k += 1.0 + floor(u_boilKick * 24.0 / N);  // a kick forces a fresh drawing
    return mod(k, max(u_boilCycle, 1.0));
}
float bayer8(ivec2 p) {
    int x = p.x & 7, xy = x ^ (p.y & 7);
    int v = ((xy & 1) << 5) | ((x & 1) << 4) | ((xy & 2) << 2) | ((x & 2) << 1) | ((xy & 4) >> 1) | ((x & 4) >> 2);
    return (float(v) + 0.5) / 64.0;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float halftoneScreen(vec2 px, float cellPx, float angDeg) {
    float a = radians(angDeg);
    vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * px / max(cellPx, 0.5);
    return 0.5 + 0.25 * (cos(TAU * q.x) + cos(TAU * q.y));
}
float halftoneCellPx() { return u_resolution.y / max(u_lpi * u_printHeightIn, 1.0); }
// 0..1 dither value for this pixel; cells are square and sized in screen pixels
float ditherValue(vec2 fragPx, float t, float cellMul) {
    float cellPx = max(1.0, floor(u_resolution.y / u_ditherScale + 0.5)) * cellMul;
    float k = drawingIndex(t);
    ivec2 c = ivec2(floor(fragPx / cellPx));
    if (u_ditherMode == 1) return fract(texelFetch(u_blueNoise, c & 63, 0).r + k * PHI);
    if (u_ditherMode == 2) return halftoneScreen(fragPx, halftoneCellPx(), u_screenAngle);
    if (u_ditherMode == 3) return fract(bayer8(c) + k * PHI);
    return fract(ign(vec2(c) + k * 5.588238));
}

// ============================================================================
// Two-Layer compositing
// ============================================================================
vec3 srcSample(sampler2D tex, vec2 uv) {
    vec3 rgb = texture(tex, uv).rgb;
    return (u_colorMode == 1) ? rgb : vec3(lumaOf(rgb));
}
vec3 ringSample(vec2 uv, int layer) {
    vec3 s = texture(u_buffer, vec3(uv, float(layer))).rgb;
    return (u_colorMode == 1) ? s : vec3(lumaOf(s));
}

vec3 sampleTwoLayer(vec2 uv) {
    if (u_twoLayerEnabled == 0) {
        return srcSample(u_videoA, uv);
    }

    // --- Layer A: live frame, OR trail during catch-up ---
    vec3 colA;
    if (u_isCatchupActive == 1 && u_trailSampleCount > 0) {
        int liveLayer = wrapLayer(u_bufferWriteIndex - 1);
        vec3  accum  = vec3(0.0);
        float wsum   = 0.0;
        int N = max(1, min(16, u_trailSampleCount));
        if (u_trailMode == 1) {
            // box exposure: equal-weight integration over the frames written since the catch-up began,
            // which is what a step-printed long exposure is; glitch keeps the per-channel max
            float span = max(1.0, min(u_trailFrames, float(u_bufferSize - 1)));
            for (int i = 0; i < 16; i++) {
                if (i >= N) break;
                float k = floor((float(i) + 0.5) / float(N) * span);
                vec3 s = ringSample(uv, wrapLayer(liveLayer - int(k)));
                if (u_trailStyle == 1) accum = max(accum, s); else { accum += s; wsum += 1.0; }
            }
        } else {
            for (int i = 0; i < 16; i++) {
                if (i >= N) break;
                vec3 s = ringSample(uv, wrapLayer(liveLayer - i));
                if (u_trailStyle == 1) {
                    accum = max(accum, s);
                } else {
                    float t  = 1.0 - float(i) / max(1.0, float(N - 1));
                    float w  = 0.4 + 0.6 * t;
                    accum   += s * w;
                    wsum    += w;
                }
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
        out_ = 1.0 - (1.0 - colA) * (1.0 - colB);
        out_ = mix(colB, mix(colA, out_, 0.6), bal);
    } else if (u_layerBlendMode == 2) {
        out_ = colA * colB;
        out_ = mix(colB, mix(colA, out_, 0.6), bal);
    } else {
        out_ = mix(colB, colA, bal);
    }
    return clamp(out_, 0.0, 1.0);
}

// ============================================================================
// per-pixel intro progress
// ============================================================================
float devCurve(float x) {                           // induction delay, then a saturating rise (98% at x = 1)
    float ti = clamp(u_introInduction, 0.0, 0.9), k = (1.0 - ti) / 3.9;
    return x < ti ? 0.0 : 1.0 - exp(-(x - ti) / k);
}
float computeIntroT(vec2 uv, out float lamp) {
    lamp = 0.0;
    float t        = clamp(u_time / max(u_introDuration, 1e-4), 0.0, 1.0);
    float t_eased  = ease(t, u_introCurve);
    if (u_introModel == 0) {
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
    // physical model: develop curve; iris and scanner measured in pixels so they are round / straight on 16:9
    if (u_introMode == 0) {
        return (u_introCurve == 0) ? devCurve(t) : t_eased;
    }
    vec2 px = (uv - u_introOrigin) * u_resolution;
    vec2 c0 = -u_introOrigin * u_resolution, c1 = (vec2(1.0) - u_introOrigin) * u_resolution;
    float rmax = length(max(abs(c0), abs(c1)));
    vec2 d = vec2(cos(u_introAngle), sin(u_introAngle));
    float dist;
    if (u_introMode == 1) {
        float radial = length(px) / rmax;
        float direct = dot(px, d) / (abs(d.x) * u_resolution.x + abs(d.y) * u_resolution.y) + 0.5;
        dist = mix(radial, direct, clamp(u_introDirectionality, 0.0, 1.0));
        dist += (fbm(uv * 3.0 + u_time * 0.15) - 0.5) * u_introTurbulence;   // ink bloom
    } else if (u_introMode == 2) {
        dist = 1.0 - length(px) / rmax;                                        // mechanical: clean
    } else {
        dist = dot(px, d) / (abs(d.x) * u_resolution.x + abs(d.y) * u_resolution.y) + 0.5;
        if (u_scanLinesPerFrame > 0.0) dist = floor(dist * u_scanLinesPerFrame) / u_scanLinesPerFrame;
    }
    float spread = max(u_introSpread, 1.0 / rmax);
    float wf = t_eased * (1.0 + spread);
    float p = pow(max(smoothstep(wf - spread, wf, dist), 0.0), mix(1.0, 0.3, clamp(u_introFalloff, 0.0, 1.0)));
    if (u_introMode == 3) {                                                    // the lamp leads the reveal
        float dpx = (dist - (wf - spread)) * (abs(d.x) > 0.5 ? u_resolution.x : u_resolution.y);
        lamp = u_scanLampGain * exp(-(dpx * dpx) / max(u_scanLampPx * u_scanLampPx, 1.0)) * step(t, 0.999);
    }
    return 1.0 - p;
}

// ============================================================================
// edge: legacy luma-width smoothstep, or a first-order signed distance to the
// cut in screen pixels (Green 2007), so the edge is 1 px wide at any contrast.
// The gradient is of L - T_smooth only; the per-cell dither never enters it.
// Returns x = ink mask, y = density (toner halo inside solids)
// ============================================================================
vec2 edgeMask(float L, float Tsmooth, float Tfull, float roughN, bool halftone) {
    if (u_edgeMode == 0) {
        return vec2(smoothstep(Tfull - u_softness, Tfull + u_softness, L), 1.0);
    }
    float g = halftone ? length(vec2(dFdx(L - Tfull), dFdy(L - Tfull)))
                       : length(vec2(dFdx(L - Tsmooth), dFdy(L - Tsmooth)));
    g = clamp(g, 1e-4, 0.25);
    float dpx = (L - Tfull) / g + u_bleedPx + u_edgeRoughPx * (2.0 * roughN - 1.0);
    float halfW = 0.5 + u_softness * 200.0;
    float m = clamp(0.5 + dpx / (2.0 * halfW), 0.0, 1.0);
    float density = 1.0 - u_haloStrength * exp(-max(dpx, 0.0) / max(u_haloPx, 1e-3)) * step(1e-3, u_haloPx);
    return vec2(m, density);
}

// ============================================================================
// colour models
// ============================================================================
vec3 inkOverPaper(float mask, float density, vec3 inkRGB) {
    vec3 paper = lin(u_shadowColor);
    vec3 inkT  = clamp(lin(inkRGB) / max(paper, vec3(1e-4)), 0.0, 1.0);
    vec3 mult  = paper * mix(vec3(1.0), inkT, mask * density);
    vec3 opaque = mix(paper, lin(inkRGB), mask);
    return enc(mix(mult, opaque, u_inkOpacity));
}
vec2 misregOffset(float drawing, float inkId) {   // rigid per-ink shift per drawing, in uv
    vec2 h = fract(sin(vec2(drawing * 12.9898 + inkId * 4.1, drawing * 78.233 + inkId * 1.7)) * 43758.5453);
    return (h - 0.5) * 2.0 * u_misregPx / u_resolution;
}

// ============================================================================
// main
// ============================================================================
void main() {
    vec2 uv = v_uv * u_fit.xy + u_fit.zw;                       // placement fit: cover crops, contain letterboxes
    bool outside = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)));
    vec2 fragPx = gl_FragCoord.xy;

    vec2 warp;
    float slowField = slowFieldAt(uv, warp);
    vec2 warpedUV = uv + warp;

    // composite from two video layers (with optional trail during catchup)
    vec3  comp = sampleTwoLayer(warpedUV);
    float L = thresholdLuma(comp);

    // temporal prefilter against the previous ring frame (sensor noise shimmer at the cut), motion-gated
    if (u_edgeMode == 1 && u_edgeTemporal > 0.0 && u_twoLayerEnabled == 1) {
        float Lprev = thresholdLuma(texture(u_buffer, vec3(warpedUV, float(wrapLayer(u_bufferWriteIndex - 1)))).rgb);
        float w = u_edgeTemporal * (1.0 - smoothstep(0.02, 0.08, abs(L - Lprev)));
        L = mix(L, Lprev, w);
    }

    // threshold
    float tq = (u_boilHold > 0) ? floor(u_time * 24.0 / float(u_boilHold)) * float(u_boilHold) / 24.0 : u_time;
    float lfo = u_thresholdLFOAmp * sin(TAU * u_thresholdLFOFreq * tq);
    float Tslow = u_thresholdBase + lfo + slowField * u_slowAmp;
    if (u_depthOn == 1) {                                   // threshold as a field: the cut follows the scene's depth
        float depthV = texture(u_depth, warpedUV).r;
        if (u_depthView == 1) { fragColor = vec4(vec3(depthV), 1.0); return; }
        Tslow -= (depthV - u_depthMid) * u_depthAmt;      // ink lives above the threshold, so near lowers it
    }
    float Tfull;
    if (u_ditherMode == 0 && u_boilHold == 0) {
        float ditherTime = float(u_frame) * PHI * u_ditherSpeed;
        float fastNoise  = fract(pseudoBlue(uv * u_ditherScale) + ditherTime) - 0.5;
        Tfull = Tslow + fastNoise * u_ditherAmp;
    } else {
        // blue noise / halftone / Bayer / IGN cover 0..1: amp blends from a hard cut to a tone-reproducing dither
        Tfull = mix(Tslow, ditherValue(fragPx, u_time, 1.0), clamp(u_ditherAmp / 0.3, 0.0, 1.0));
    }

    float lamp;
    float introT  = computeIntroT(uv, lamp);
    float from    = (u_introModel == 0) ? 1.0 : u_introFrom;
    float Tsmooth = mix(from, Tslow, introT);
    float T_final = mix(from, Tfull, introT);

    float roughN = (u_edgeRoughPx > 0.0) ? ditherValue(fragPx, u_time, 4.0) : 0.5;
    vec2 em = edgeMask(L, Tsmooth, T_final, roughN, u_ditherMode == 2);
    float mask = em.x, density = em.y;

    vec3 ink = (u_colorMode == 1) ? comp : u_spotColor;
    vec3 rgb;
    float cov = mask;                                  // ink coverage, drives the alpha key
    if (u_colorModel == 0) {
        rgb = mix(ink, u_shadowColor, 1.0 - mask);
    } else if (u_colorModel == 1) {
        rgb = inkOverPaper(mask, density, ink);
        cov = mask * mix(density, 1.0, u_inkOpacity);
    } else if (u_colorModel == 2) {
        // true duotone: two continuous curves, each screened on its own angle (spot 75°, black 45°)
        float cell = halftoneCellPx();
        float Lw = mix(from, L, introT);                                   // intro reveals the plate
        float cS = 1.0 - pow(Lw, 0.8);                                     // spot carries the whole range, midtone-weighted
        float cK = pow(smoothstep(0.55, 0.0, Lw), 1.2);                    // black only below 45% lightness
        float sS = halftoneScreen(fragPx, cell, 75.0), sK = halftoneScreen(fragPx, cell, 45.0);
        float gS = clamp(length(vec2(dFdx(cS - sS), dFdy(cS - sS))), 1e-3, 0.5);
        float gK = clamp(length(vec2(dFdx(cK - sK), dFdy(cK - sK))), 1e-3, 0.5);
        float mS = clamp(0.5 + (cS - sS) / gS, 0.0, 1.0);
        float mK = clamp(0.5 + (cK - sK) / gK, 0.0, 1.0);
        vec3 c = lin(u_shadowColor) * mix(vec3(1.0), lin(ink), mS) * mix(vec3(1.0), lin(u_inkB), mK);
        rgb = enc(c);
        cov = 1.0 - (1.0 - mS) * (1.0 - mK);
    } else {
        // riso: two semi-translucent inks, each pass misregistered per drawing, multiplied over the paper
        float dr = drawingIndex(u_time);
        vec2 o1 = misregOffset(dr, 1.0), o2 = misregOffset(dr, 2.0);
        float L1 = thresholdLuma(sampleTwoLayer(warpedUV + o1));
        float L2 = thresholdLuma(sampleTwoLayer(warpedUV + o2));
        float m1 = edgeMask(L1, Tsmooth, T_final, roughN, u_ditherMode == 2).x;
        float m2 = edgeMask(L2, Tsmooth + 0.25, T_final + 0.25, roughN, u_ditherMode == 2).x;   // second ink sits a stop up
        vec3 paper = lin(u_shadowColor);
        vec3 t1 = clamp(lin(ink) / max(paper, vec3(1e-4)), 0.0, 1.0), t2 = clamp(lin(u_inkB) / max(paper, vec3(1e-4)), 0.0, 1.0);
        vec3 mult = paper * mix(vec3(1.0), t1, m1 * density) * mix(vec3(1.0), t2, m2 * 0.85);
        vec3 opaque = mix(mix(paper, lin(u_inkB), m2 * 0.85), lin(ink), m1);
        rgb = enc(mix(mult, opaque, u_inkOpacity));
        cov = 1.0 - (1.0 - m1 * mix(density, 1.0, u_inkOpacity)) * (1.0 - m2 * 0.85);
    }
    rgb += lamp;
    // alpha key: straight alpha (context is premultipliedAlpha:false); un-mix the keyed colour out of edge pixels
    float a = 1.0;
    if (u_alphaMode == 1) { a = cov;       rgb = clamp((rgb - u_shadowColor * (1.0 - a)) / max(a, 1e-3), 0.0, 1.0); }
    else if (u_alphaMode == 2) { a = 1.0 - cov; rgb = clamp((rgb - ink * (1.0 - a)) / max(a, 1e-3), 0.0, 1.0); }
    if (outside) { rgb = u_shadowColor; a = (u_alphaMode == 1) ? 0.0 : 1.0; }   // letterbox is paper
    fragColor = vec4(rgb, a);
}
