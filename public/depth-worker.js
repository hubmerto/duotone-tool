// Depth Anything V2 small through transformers.js, in a module worker (same code path as Cuntfetti).
// messages in:  { type:'init', model, device, dtype, size } · { type:'size', size } · { type:'frame', id, bitmap }
// messages out: { type:'progress', file, p } · { type:'ready', device, dtype } · { type:'depth', id, w, h, data, ms } · { type:'error', id?, msg, fatal? }
import { AutoModelForDepthEstimation, AutoProcessor, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
env.allowLocalModels = false;
let model = null, processor = null;
function setSize(s) { if (!processor) return; const ip = processor.image_processor || processor; ip.size = { width: s, height: s }; }
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      processor = await AutoProcessor.from_pretrained(m.model);
      model = await AutoModelForDepthEstimation.from_pretrained(m.model, { device: m.device, dtype: m.dtype,
        progress_callback: (p) => { if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, p: p.progress || 0 }); } });
      setSize(m.size);
      self.postMessage({ type: 'ready', device: m.device, dtype: m.dtype });
    } catch (err) { self.postMessage({ type: 'error', msg: String(err && err.message || err), fatal: true }); }
  } else if (m.type === 'size') { setSize(m.size); }
  else if (m.type === 'frame') {
    const bmp = m.bitmap; const t0 = performance.now();
    try {
      const c = new OffscreenCanvas(bmp.width, bmp.height); const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0); bmp.close();
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const img = new RawImage(id.data, c.width, c.height, 4);
      const inputs = await processor(img);
      const out = await model(inputs);
      const t = out.predicted_depth; const dims = t.dims; const H = dims[dims.length - 2], W = dims[dims.length - 1];
      const data = new Float32Array(t.data);
      self.postMessage({ type: 'depth', id: m.id, w: W, h: H, data, ms: performance.now() - t0 }, [data.buffer]);
    } catch (err) { try { bmp.close(); } catch (_) {} self.postMessage({ type: 'error', id: m.id, msg: String(err && err.message || err) }); }
  }
};
