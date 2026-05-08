# DUOTONE — boiling-threshold video tool

Browser-based 1-bit duotone video processor with an animated luma threshold —
the "boiling threshold" / risograph-in-motion look. Single-pass GLSL ES 300 fragment
shader on a `<canvas>` with a `<video>` source. Local-only, no backend.

## Run

```bash
npm install
npm run dev          # dev server with HMR (shader hot-reload included)
npm run build        # production bundle in dist/
npm run preview      # serve the production bundle
```

Drop a video file anywhere on the page, or use the **Source → Pick video file…** button.

## What it does

For every pixel of every frame:

1. Compute luma (Rec.709) from the video sample.
2. Compute a spatially-coherent, slowly-drifting **slow field** (domain-warped fbm).
3. Compute a per-frame **fast boil** (blue-noise dither offset by golden-ratio time).
4. Compute a sin-based **breathing LFO** on the threshold center.
5. `T = base + lfo + slowField·slowAmp + fastNoise·ditherAmp`
6. Apply an **intro ramp** that eases T from 1.0 (all-black) toward the live composite.
7. `mask = smoothstep(T - softness, T + softness, luma)`
8. Output: `mix(spotColor, black, 1 - mask)` — pixels above the threshold get the
   spot color; everything else is black.

Result: a flickering, breathing, animated 1-bit duotone whose "ink" appears to
boil and creep across the frame.

## Parameters

| Folder        | Param                | Effect                                                              |
| ------------- | -------------------- | ------------------------------------------------------------------- |
| Source        | Pick video / sample  | Load a video file (drag-drop also works anywhere)                   |
|               | play, loop           | Video playback controls                                             |
| Color         | spot                 | The duotone accent color                                            |
|               | preset               | Switch between bundled green / orange / blue                        |
| Threshold     | base                 | Center of the cutoff (0..1); 0.5 ≈ midtone                          |
|               | lfo amp              | Breathing depth                                                     |
|               | lfo hz               | Breathing speed (cycles/sec)                                        |
| Intro         | duration             | Seconds for the intro ramp                                          |
|               | curve                | linear / easeOut / easeInOut                                        |
|               | Replay intro         | Reset effect time → 0                                               |
| Slow Field    | scale                | Domain frequency of the slow ink-blob field (higher = smaller blobs) |
|               | speed                | Drift speed                                                         |
|               | amp                  | How strongly the slow field warps the threshold                     |
| Boil          | scale                | Domain frequency of the fast grain (higher = finer)                 |
|               | speed                | 0 = static, 1 = full per-frame reseed                               |
|               | amp                  | How strongly the boil warps the threshold                           |
| Edge          | softness             | Smoothstep half-width — keep tiny (0..0.05) for crisp edges         |
| Export        | engine               | mediarecorder (fast) / ccapture (frame-locked)                      |
|               | format               | webm / png-sequence (ccapture only)                                 |
|               | seconds              | Recording duration                                                  |
|               | fps                  | Frame rate                                                          |
|               | record / stop        | Start/stop recording                                                |
|               | save / load preset   | JSON download / upload                                              |

## Recording & post-processing

Recording outputs **.webm** in-browser. For mp4 (e.g. social platforms), do this in a terminal:

```bash
ffmpeg -i out.webm -c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4
```

For higher-quality export when MediaRecorder stutters, switch to **ccapture (frame-locked)** —
it lazy-loads ccapture.js from CDN on first use and writes frames at exact `fps`
regardless of render speed. Slower; produces no stutter.

## Presets

`presets/{green,orange,blue}.json` — drag any of them onto the page, or use
**Export → Load preset (json)**. Saved presets are downloaded to your default
download folder.

The three bundled presets share all tuning except `spotColor` — that's the point.
Tune one, get all three.

## Targets / non-targets

- 1080p video at 30fps real-time on M1/M2 Macs ✓
- 4K acceptable but may drop frames during recording (MediaRecorder still
  captures cleanly).
- Desktop only — no mobile UI.
- No multiple effects, no audio reactivity, no still-image input.

## Stack

- Vanilla JS + ES modules (no React, no Tailwind)
- WebGL2 + GLSL ES 300
- [Tweakpane](https://tweakpane.github.io/docs/) for parameter UI
- Vite for dev/build (only because shader `?raw` imports are clean and HMR
  for shader iteration is worth a lot)

## Credits

- Threshold recipe + research: see the build spec / `boiling-threshold-research.md`.
- Noise functions: [Inigo Quilez's value noise & fbm](https://iquilezles.org/articles/fbm/).
- Pseudo blue-noise dither: hash-based fallback for [lygia/color/dither/blueNoise](https://lygia.xyz).
- Golden-ratio time offset for low-discrepancy reseeding: [@XorDev](https://x.com/xordev).

## License

ISC
