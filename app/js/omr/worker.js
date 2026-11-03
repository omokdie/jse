// Module worker wrapper around omr.js (SPEC §4).
// in:  { id, image: {width, height, data(ArrayBuffer RGBA)}, options }
// out: { id, type:'progress', stage, percent, message } | { id, type:'result', result } | { id, type:'error', message }
import { recognize } from './omr.js';

self.onmessage = async (e) => {
  const { id, image, options } = e.data || {};
  try {
    const img = { width: image.width, height: image.height, data: image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data) };
    const result = await recognize(img, options || {}, p => self.postMessage({ id, type: 'progress', ...p }));
    const transfer = [];
    if (result.binarizedPreview?.data?.buffer) transfer.push(result.binarizedPreview.data.buffer);
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
