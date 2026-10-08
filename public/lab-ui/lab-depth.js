/* lab-depth.js — our own monocular depth: Depth Anything 3 small, int8, run by ONNX Runtime Web in a worker.
   The weights are ours (lab-ui/models/), the preprocessing is ours, nothing is fetched from a model hub at runtime.

   const run = LabUI.Depth.start({ model: 'da3-small', device: 'webgpu' | 'wasm', size: 378, onMessage });
   run.post({ type: 'frame', id, bitmap }, [bitmap]);     // → { type: 'depth', id, w, h, data, luma, ms }
   run.post({ type: 'size', size });                        // long side of the next frames, rounded to a multiple of 14
   run.terminate();

   Messages out follow the shape the tools already consume from their transformers.js workers:
   progress { file, p }, ready { device, dtype, model }, depth { id, w, h, data: Float32Array (near is large, like
   Depth Anything V2's inverse depth), luma: Float32Array, ms }, error { id?, msg, fatal? }.
*/
(function (global) {
  'use strict';
  const LabUI = global.LabUI; if (!LabUI) return;

  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
  const MODELS = {
    'da3-small': { label: 'Depth Anything 3 small · int8', url: 'https://hubmerto.com/lab-ui/models/da3-small-q8.onnx', kind: 'depth', views: true, cache: 'da3-small-q8-v1' },
  };

  // worker body as text: a blob worker needs no file path, so every tool (vendored kits included) runs the same code
  const WORKER = String.raw`
    const ORT_CDN = ${JSON.stringify(ORT_CDN)};
    let ort = null, sess = null, cfg = null, size = 378, inputName = 'pixel_values', outputName = 'predicted_depth';
    const post = (m, t) => self.postMessage(m, t || []);
    async function fetchModel(url, cacheName) {
      let cache = null; try { cache = await caches.open('lab-depth'); const hit = await cache.match(url + '#' + cacheName); if (hit) return await hit.arrayBuffer(); } catch (_) { cache = null; }
      const res = await fetch(url); if (!res.ok) throw new Error('model ' + res.status);
      const total = +res.headers.get('content-length') || 0; const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      let buf;
      if (reader) { const chunks = []; let got = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; post({ type: 'progress', file: 'depth model', p: total ? got / total * 100 : 0 }); } buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; } buf = buf.buffer; }
      else buf = await res.arrayBuffer();
      try { if (cache) await cache.put(url + '#' + cacheName, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) {}
      return buf;
    }
    self.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'init') {
        try {
          cfg = m; size = m.size || 378;
          ort = await import(ORT_CDN + 'ort.min.mjs'); ort.env.wasm.wasmPaths = ORT_CDN;
          const buf = await fetchModel(m.model, m.cache || 'v1');
          const providers = m.device === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
          sess = await ort.InferenceSession.create(buf, { executionProviders: providers, graphOptimizationLevel: 'all' });
          inputName = sess.inputNames[0]; outputName = sess.outputNames.includes('predicted_depth') ? 'predicted_depth' : sess.outputNames[0];
          post({ type: 'ready', device: m.device, dtype: 'q8', model: m.name || 'da3-small' });
        } catch (err) { post({ type: 'error', msg: String(err && err.message || err), fatal: true }); }
      } else if (m.type === 'size') { size = m.size || size; }
      else if (m.type === 'frame') {
        const bmp = m.bitmap; const t0 = performance.now();
        try {
          if (!sess) throw new Error('not ready');
          // long side = size, both sides a multiple of 14 (the patch size); ImageNet normalisation
          const sc = size / Math.max(bmp.width, bmp.height); const W = Math.max(14, Math.round(bmp.width * sc / 14) * 14), H = Math.max(14, Math.round(bmp.height * sc / 14) * 14);
          const c = new OffscreenCanvas(W, H); const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, W, H); bmp.close();
          const px = ctx.getImageData(0, 0, W, H).data; const n = W * H; const data = new Float32Array(3 * n); const luma = new Float32Array(n);
          const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
          for (let i = 0; i < n; i++) { const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255; data[i] = (r - mean[0]) / std[0]; data[n + i] = (g - mean[1]) / std[1]; data[2 * n + i] = (b - mean[2]) / std[2]; luma[i] = 0.299 * r + 0.587 * g + 0.114 * b; }
          const shape = cfg.views ? [1, 1, 3, H, W] : [1, 3, H, W];
          const out = await sess.run({ [inputName]: new ort.Tensor('float32', data, shape) });
          const t = out[outputName]; const dims = t.dims; const h = dims[dims.length - 2], w = dims[dims.length - 1];
          const d = new Float32Array(t.data.length);
          if (cfg.kind === 'depth') { for (let i = 0; i < d.length; i++) d[i] = 1 / Math.max(1e-3, t.data[i]); }   // depth → inverse depth: near is large, like V2
          else d.set(t.data);
          post({ type: 'depth', id: m.id, w, h, data: d, luma, ms: performance.now() - t0 }, [d.buffer, luma.buffer]);
        } catch (err) { try { bmp.close(); } catch (_) {} post({ type: 'error', id: m.id, msg: String(err && err.message || err) }); }
      }
    };
  `;

  let blobUrl = null;
  const Depth = {
    MODELS, ORT_CDN,
    // the weights' URL: a tool may point elsewhere (a local copy, a test route) through LabUI.Depth.urls[id]
    urls: {},
    // absolute, because the blob worker has no base to resolve a relative path against
    modelUrl(id) { const u = this.urls[id] || (global.LAB_DEPTH_URLS && global.LAB_DEPTH_URLS[id]) || (MODELS[id] && MODELS[id].url) || null; try { return u ? new URL(u, global.location && global.location.href).href : null; } catch (_) { return u; } },
    workerUrl() { if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })); return blobUrl; },
    supported() { return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'; },
    // start({ model:'da3-small', device:'webgpu'|'wasm', size, onMessage }) → { worker, post(msg, transfer), terminate() }
    start(o) {
      o = o || {}; const id = o.model || 'da3-small'; const m = MODELS[id]; if (!m) throw new Error('unknown depth model ' + id);
      const worker = new Worker(this.workerUrl(), { type: 'module' });
      if (o.onMessage) worker.onmessage = (e) => o.onMessage(e.data);
      if (o.onError) worker.onerror = (e) => o.onError(e);
      worker.postMessage({ type: 'init', name: id, model: this.modelUrl(id), kind: m.kind, views: !!m.views, cache: m.cache, device: o.device || (('gpu' in navigator) ? 'webgpu' : 'wasm'), size: o.size || 378 });
      return { worker, post: (msg, transfer) => worker.postMessage(msg, transfer || []), terminate: () => worker.terminate() };
    },
  };
  LabUI.Depth = Depth;
})(typeof window !== 'undefined' ? window : globalThis);
