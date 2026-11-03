// JSE OMR — runtime for the small learned classifiers (pure JS, typed arrays).
// Models are MLPs exported by tools/omr/mlp.py (int8 weights with one scale
// per output unit, float32 biases and input normalisation, base64) into
// app/js/omr/models/<name>.js and loaded lazily with dynamic import(), so the
// weights are only fetched when recognition actually runs.

const cache = new Map();

function decode(b64, Type) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer, 0, bytes.length / Type.BYTES_PER_ELEMENT);
}

function prepare(M) {
  const layers = M.layers.map(l => ({ nIn: l.in, nOut: l.out, w: decode(l.w, Int8Array), s: decode(l.s, Float32Array), b: decode(l.b, Float32Array) }));
  const mean = decode(M.mean, Float32Array), std = decode(M.std, Float32Array);
  const maxW = Math.max(...layers.map(l => Math.max(l.nIn, l.nOut)));
  return { name: M.name, meta: M.meta || {}, layers, mean, std, bufA: new Float32Array(maxW), bufB: new Float32Array(maxW), nIn: layers[0].nIn, nOut: layers[layers.length - 1].nOut };
}

/** Loads (once) app/js/omr/models/<name>.js; resolves to null if missing. */
export async function loadModel(name) {
  if (cache.has(name)) return cache.get(name);
  let model = null;
  try {
    const mod = await import(`./models/${name}.js`);
    model = prepare(mod.MODEL);
  } catch (e) { model = null; }
  cache.set(name, model);
  return model;
}

/** Synchronous variant for callers that already hold the module object. */
export function modelFrom(M) { return prepare(M); }

/** Forward pass; returns class probabilities in `out` (Float32Array(nOut)). */
export function predict(model, x, out = new Float32Array(model.nOut)) {
  let a = model.bufA, b = model.bufB;
  const n0 = model.nIn, mean = model.mean, std = model.std;
  for (let i = 0; i < n0; i++) a[i] = (x[i] - mean[i]) / std[i];
  const L = model.layers;
  for (let li = 0; li < L.length; li++) {
    const { nIn, nOut, w, s, b: bias } = L[li];
    const last = li === L.length - 1;
    for (let o = 0; o < nOut; o++) {
      let acc = 0;
      const off = o * nIn;
      for (let i = 0; i < nIn; i++) acc += w[off + i] * a[i];
      let v = acc * s[o] + bias[o];
      if (!last && v < 0) v = 0;
      b[o] = v;
    }
    const t = a; a = b; b = t;
  }
  const n = model.nOut;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) if (a[i] > mx) mx = a[i];
  let sum = 0;
  for (let i = 0; i < n; i++) { out[i] = Math.exp(a[i] - mx); sum += out[i]; }
  for (let i = 0; i < n; i++) out[i] /= sum;
  return out;
}
