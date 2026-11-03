// Minimal TensorFlow.js GraphModel interpreter (pure JS, typed arrays) — runs in the browser, a Worker and Node.
// Written for Spotify's Basic Pitch model (app/vendor/basic-pitch/model.json): it implements exactly the ops that
// graph uses (see OPS below) with TF semantics (NHWC convs, numpy broadcasting, StridedSlice masks, REFLECT pads).
// Conv2D is the hot path (≈95% of the work); it gets a padded-input, register-accumulator kernel, plus an optional
// WebAssembly SIMD kernel (audio/wasmconv.js) when the runtime supports it.

import { wasmAvailable, wasmConvKernel } from './wasmconv.js';

const DT = { DT_FLOAT: 'float32', DT_INT32: 'int32' };

export function tensor(shape, data, dtype = data instanceof Int32Array ? 'int32' : 'float32') { return { shape, data, dtype }; }
const size = shape => shape.reduce((a, b) => a * b, 1);
const stridesOf = shape => { const s = new Array(shape.length); let acc = 1; for (let i = shape.length - 1; i >= 0; i--) { s[i] = acc; acc *= shape[i]; } return s; };
const arrOf = (dtype, n) => (dtype === 'int32' ? new Int32Array(n) : new Float32Array(n));

function b64(s) { return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('latin1'); }
function attrOf(node, name, def) {
  const a = node.attr?.[name]; if (!a) return def;
  if ('i' in a) return +a.i;
  if ('f' in a) return +a.f;
  if ('b' in a) return !!a.b;
  if ('s' in a) return b64(a.s);
  if ('type' in a) return DT[a.type] || a.type;
  if ('list' in a) { const l = a.list; if (l.i) return l.i.map(Number); if (l.s) return l.s.map(b64); if (l.f) return l.f.map(Number); return []; }
  return def;
}

// ------------------------------------------------------------------ copy engines
/** Drop size-1 axes and merge axes that are contiguous in both layouts (keeps the inner copy loops long). */
function simplify(shape, sa, sb) {
  const S = [], A = [], B = [];
  for (let i = 0; i < shape.length; i++) {
    if (shape[i] === 1) continue;
    const k = S.length - 1;
    if (k >= 0 && A[k] === sa[i] * shape[i] && B[k] === sb[i] * shape[i]) { S[k] *= shape[i]; A[k] = sa[i]; B[k] = sb[i]; continue; }
    S.push(shape[i]); A.push(sa[i]); B.push(sb[i]);
  }
  return [S, A, B];
}
/** out[i] = src[base + Σ idx_k·inStrides_k] for idx over outShape (row-major). */
function gather(src, outShape0, inStrides0, base, dtype) {
  const total = size(outShape0), out = arrOf(dtype, total);
  const [outShape, inStrides] = simplify(outShape0, inStrides0, stridesOf(outShape0));
  const n = outShape.length;
  if (total === 0) return out;
  if (n === 0) { out[0] = src[base]; return out; }
  const L = outShape[n - 1], ls = inStrides[n - 1], idx = new Array(n).fill(0);
  let off = base, o = 0;
  for (;;) {
    let p = off;
    if (ls === 1) { out.set(src.subarray(p, p + L), o); o += L; }
    else for (let i = 0; i < L; i++, p += ls) out[o++] = src[p];
    let ax = n - 2;
    while (ax >= 0) { idx[ax]++; off += inStrides[ax]; if (idx[ax] < outShape[ax]) break; off -= inStrides[ax] * outShape[ax]; idx[ax] = 0; ax--; }
    if (ax < 0) break;
  }
  return out;
}
/** Write src (contiguous, shape) into dst at base with dst strides. */
function scatter(src, shape0, dst, dstStrides0, base) {
  if (!size(shape0)) return;
  const [shape, dstStrides] = simplify(shape0, dstStrides0, stridesOf(shape0));
  const n = shape.length;
  if (n === 0) { dst[base] = src[0]; return; }
  const L = shape[n - 1], ls = dstStrides[n - 1], idx = new Array(n).fill(0);
  let off = base, o = 0;
  for (;;) {
    let p = off;
    if (ls === 1) { dst.set(src.subarray(o, o + L), p); o += L; }
    else for (let i = 0; i < L; i++, p += ls) dst[p] = src[o++];
    let ax = n - 2;
    while (ax >= 0) { idx[ax]++; off += dstStrides[ax]; if (idx[ax] < shape[ax]) break; off -= dstStrides[ax] * shape[ax]; idx[ax] = 0; ax--; }
    if (ax < 0) break;
  }
}
function broadcastTo(t, outShape) {
  if (t.shape.length === outShape.length && t.shape.every((d, i) => d === outShape[i])) return t.data;
  const r = outShape.length, s = stridesOf(t.shape), st = new Array(r).fill(0);
  for (let i = 0; i < t.shape.length; i++) { const k = r - t.shape.length + i; st[k] = t.shape[i] === 1 ? 0 : s[i]; }
  return gather(t.data, outShape, st, 0, t.dtype);
}
function broadcastShape(a, b) {
  const r = Math.max(a.length, b.length), out = [];
  for (let i = 0; i < r; i++) {
    const x = a[a.length - r + i] ?? 1, y = b[b.length - r + i] ?? 1;
    if (x !== y && x !== 1 && y !== 1) throw new Error(`broadcast ${a} vs ${b}`);
    out.push(Math.max(x, y));
  }
  return out;
}

// ------------------------------------------------------------------ ops
function binary(a, b, op) {
  const shape = broadcastShape(a.shape, b.shape);
  const x = broadcastTo(a, shape), y = broadcastTo(b, shape), n = size(shape);
  const out = arrOf(a.dtype, n);
  switch (op) {
    case 'add': for (let i = 0; i < n; i++) out[i] = x[i] + y[i]; break;
    case 'sub': for (let i = 0; i < n; i++) out[i] = x[i] - y[i]; break;
    case 'mul': for (let i = 0; i < n; i++) out[i] = x[i] * y[i]; break;
    case 'divnonan': for (let i = 0; i < n; i++) out[i] = y[i] === 0 ? 0 : x[i] / y[i]; break;
    default: throw new Error(op);
  }
  return tensor(shape, out, a.dtype);
}
function unary(a, f) { const out = arrOf(a.dtype, a.data.length); const d = a.data; for (let i = 0; i < d.length; i++) out[i] = f(d[i]); return tensor(a.shape.slice(), out, a.dtype); }
function reduce(a, axesT, keep, op) {
  const r = a.shape.length;
  let axes = Array.from(axesT.data).map(x => (x < 0 ? x + r : x));
  axes = [...new Set(axes)].sort();
  // move reduced axes last via transpose, then reduce contiguous blocks
  const keepAx = [...Array(r).keys()].filter(i => !axes.includes(i));
  const perm = [...keepAx, ...axes];
  const tp = transpose(a, perm);
  const outer = size(keepAx.map(i => a.shape[i])), inner = size(axes.map(i => a.shape[i]));
  const out = arrOf(a.dtype, outer), d = tp.data;
  for (let o = 0; o < outer; o++) {
    let acc = op === 'sum' ? 0 : op === 'min' ? Infinity : -Infinity;
    const b0 = o * inner;
    if (op === 'sum') for (let i = 0; i < inner; i++) acc += d[b0 + i];
    else if (op === 'min') for (let i = 0; i < inner; i++) { const v = d[b0 + i]; if (v < acc) acc = v; }
    else for (let i = 0; i < inner; i++) { const v = d[b0 + i]; if (v > acc) acc = v; }
    out[o] = acc;
  }
  const shape = keep ? a.shape.map((s, i) => (axes.includes(i) ? 1 : s)) : keepAx.map(i => a.shape[i]);
  return tensor(shape, out, a.dtype);
}
function transpose(a, perm) {
  const s = stridesOf(a.shape);
  const outShape = perm.map(p => a.shape[p]), st = perm.map(p => s[p]);
  return tensor(outShape, gather(a.data, outShape, st, 0, a.dtype), a.dtype);
}
function reshape(a, shapeT) {
  const want = Array.from(shapeT.data); const n = a.data.length;
  const k = want.indexOf(-1);
  if (k >= 0) want[k] = n / size(want.filter((_, i) => i !== k));
  if (size(want) !== n) throw new Error(`reshape ${a.shape} → ${want}`);
  return tensor(want, a.data, a.dtype);
}
function pad(a, padsT) {
  const p = padsT.data, r = a.shape.length;
  const outShape = a.shape.map((d, i) => d + p[2 * i] + p[2 * i + 1]);
  const out = arrOf(a.dtype, size(outShape)), os = stridesOf(outShape);
  let base = 0; for (let i = 0; i < r; i++) base += p[2 * i] * os[i];
  scatter(a.data, a.shape, out, os, base);
  return tensor(outShape, out, a.dtype);
}
function mirrorPad(a, padsT, mode) {
  const sym = mode === 'SYMMETRIC';
  let cur = a; const p = padsT.data;
  for (let ax = 0; ax < a.shape.length; ax++) {
    const before = p[2 * ax], after = p[2 * ax + 1]; if (!before && !after) continue;
    const d = cur.shape[ax];
    const map = []; for (let i = -before; i < d + after; i++) { let j = i; if (j < 0) j = sym ? -j - 1 : -j; else if (j >= d) j = sym ? 2 * d - j - 1 : 2 * (d - 1) - j; map.push(j); }
    const outShape = cur.shape.slice(); outShape[ax] = map.length;
    const outer = size(cur.shape.slice(0, ax)), inner = size(cur.shape.slice(ax + 1));
    const out = arrOf(cur.dtype, size(outShape)), src = cur.data;
    for (let o = 0; o < outer; o++) for (let i = 0; i < map.length; i++) {
      const s0 = (o * d + map[i]) * inner, d0 = (o * map.length + i) * inner;
      if (inner === 1) out[d0] = src[s0]; else out.set(src.subarray(s0, s0 + inner), d0);
    }
    cur = tensor(outShape, out, cur.dtype);
  }
  return cur;
}
function concat(ts, axis) {
  const r = ts[0].shape.length; if (axis < 0) axis += r;
  const outShape = ts[0].shape.slice(); outShape[axis] = ts.reduce((s, t) => s + t.shape[axis], 0);
  const out = arrOf(ts[0].dtype, size(outShape)), os = stridesOf(outShape);
  let off = 0;
  for (const t of ts) { scatter(t.data, t.shape, out, os, off * os[axis]); off += t.shape[axis]; }
  return tensor(outShape, out, ts[0].dtype);
}
function pack(ts, axis) {
  const r = ts[0].shape.length + 1; if (axis < 0) axis += r;
  const ex = ts.map(t => { const s = t.shape.slice(); s.splice(axis, 0, 1); return tensor(s, t.data, t.dtype); });
  return concat(ex, axis);
}
function stridedSlice(x, beginT, endT, stridesT, m) {
  const begin = Array.from(beginT.data), end = Array.from(endT.data), st = Array.from(stridesT.data), n = begin.length;
  const inShape = x.shape, specs = [];
  let axis = 0;
  for (let i = 0; i < n; i++) {
    const bit = 1 << i;
    if (m.ellipsis & bit) {
      let rest = 0; for (let j = i + 1; j < n; j++) if (!(m.newAxis & (1 << j))) rest++;
      const cover = inShape.length - axis - rest;
      for (let k = 0; k < cover; k++) specs.push({ axis: axis++, full: true });
      continue;
    }
    if (m.newAxis & bit) { specs.push({ newAxis: true }); continue; }
    specs.push({ axis: axis++, b: begin[i], e: end[i], s: st[i], bm: !!(m.begin & bit), em: !!(m.end & bit), shrink: !!(m.shrink & bit) });
  }
  while (axis < inShape.length) specs.push({ axis: axis++, full: true });
  const inStr = stridesOf(inShape), outShape = [], outStr = [];
  let base = 0;
  for (const sp of specs) {
    if (sp.newAxis) { outShape.push(1); outStr.push(0); continue; }
    const d = inShape[sp.axis];
    if (sp.full) { outShape.push(d); outStr.push(inStr[sp.axis]); continue; }
    if (sp.shrink) { const b = sp.b < 0 ? sp.b + d : sp.b; base += b * inStr[sp.axis]; continue; }
    const s = sp.s || 1; let start, stop;
    if (s > 0) { start = sp.bm ? 0 : (sp.b < 0 ? sp.b + d : sp.b); stop = sp.em ? d : (sp.e < 0 ? sp.e + d : sp.e); start = Math.min(Math.max(start, 0), d); stop = Math.min(Math.max(stop, 0), d); }
    else { start = sp.bm ? d - 1 : (sp.b < 0 ? sp.b + d : sp.b); stop = sp.em ? -1 : (sp.e < 0 ? sp.e + d : sp.e); start = Math.min(Math.max(start, -1), d - 1); stop = Math.min(Math.max(stop, -1), d - 1); }
    const len = Math.max(0, Math.ceil((stop - start) / s));
    base += start * inStr[sp.axis]; outShape.push(len); outStr.push(s * inStr[sp.axis]);
  }
  return tensor(outShape, gather(x.data, outShape, outStr, base, x.dtype), x.dtype);
}

// ------------------------------------------------------------------ Conv2D (NHWC)
let wasmConv = wasmAvailable() ? wasmConvKernel : null;   // accelerated kernel (or null → JS)
/** Select the conv kernel: 'wasm' (default when supported) or 'js'. Returns the kernel actually in use. */
export function setConvBackend(kind) { wasmConv = kind === 'wasm' && wasmAvailable() ? wasmConvKernel : null; return wasmConv ? 'wasm' : 'js'; }
export function convBackend() { return wasmConv ? 'wasm' : 'js'; }

function padInput(x, H, W, Ci, pt, pl, Hp, Wp) {
  if (pt === 0 && pl === 0 && Hp === H && Wp === W) return x;
  const xp = new Float32Array(Hp * Wp * Ci);
  const rowLen = Math.min(W, Wp - pl) * Ci;
  for (let h = 0; h < H && h + pt < Hp; h++) xp.set(x.subarray(h * W * Ci, h * W * Ci + rowLen), ((h + pt) * Wp + pl) * Ci);
  return xp;
}
/** Plain JS kernel; out has no bias. Inner product over the contiguous (kw, ci) run of each kernel row. */
function convJS(xp, Hp, Wp, Ci, w, KH, KW, Co, OH, OW, sh, sw) {
  const out = new Float32Array(OH * OW * Co), KWC = KW * Ci, rowStride = Wp * Ci;
  if (Co === 1) {
    for (let oh = 0; oh < OH; oh++) for (let ow = 0; ow < OW; ow++) {
      let acc = 0;
      for (let kh = 0; kh < KH; kh++) {
        const xo = (oh * sh + kh) * rowStride + ow * sw * Ci, wo = kh * KWC;
        for (let j = 0; j < KWC; j++) acc += xp[xo + j] * w[wo + j];
      }
      out[oh * OW + ow] = acc;
    }
    return out;
  }
  if (Co === 8) {
    for (let oh = 0; oh < OH; oh++) for (let ow = 0; ow < OW; ow++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0;
      for (let kh = 0; kh < KH; kh++) {
        const xo = (oh * sh + kh) * rowStride + ow * sw * Ci; let wo = kh * KWC * 8;
        for (let j = 0; j < KWC; j++, wo += 8) {
          const v = xp[xo + j]; if (v === 0) continue;
          a0 += v * w[wo]; a1 += v * w[wo + 1]; a2 += v * w[wo + 2]; a3 += v * w[wo + 3];
          a4 += v * w[wo + 4]; a5 += v * w[wo + 5]; a6 += v * w[wo + 6]; a7 += v * w[wo + 7];
        }
      }
      const o = (oh * OW + ow) * 8;
      out[o] = a0; out[o + 1] = a1; out[o + 2] = a2; out[o + 3] = a3; out[o + 4] = a4; out[o + 5] = a5; out[o + 6] = a6; out[o + 7] = a7;
    }
    return out;
  }
  const acc = new Float64Array(Co);
  for (let oh = 0; oh < OH; oh++) for (let ow = 0; ow < OW; ow++) {
    acc.fill(0);
    for (let kh = 0; kh < KH; kh++) {
      const xo = (oh * sh + kh) * rowStride + ow * sw * Ci; let wo = kh * KWC * Co;
      for (let j = 0; j < KWC; j++, wo += Co) {
        const v = xp[xo + j]; if (v === 0) continue;
        for (let c = 0; c < Co; c++) acc[c] += v * w[wo + c];
      }
    }
    const o = (oh * OW + ow) * Co; for (let c = 0; c < Co; c++) out[o + c] = acc[c];
  }
  return out;
}
export function conv2d(x, f, strides, padding, dil, bias = null, relu = false) {
  if (dil && dil.some(d => d !== 1)) throw new Error('dilated conv not supported');
  const [N, H, W, Ci] = x.shape, [KH, KW, Ci2, Co] = f.shape;
  if (Ci !== Ci2) throw new Error(`conv channels ${Ci} vs ${Ci2}`);
  const sh = strides[1], sw = strides[2];
  let OH, OW, padH = 0, padW = 0;
  if (padding === 'SAME') {
    OH = Math.ceil(H / sh); OW = Math.ceil(W / sw);
    padH = Math.max((OH - 1) * sh + KH - H, 0); padW = Math.max((OW - 1) * sw + KW - W, 0);
  } else { OH = Math.floor((H - KH) / sh) + 1; OW = Math.floor((W - KW) / sw) + 1; }
  const pt = padH >> 1, pl = padW >> 1, Hp = H + padH, Wp = W + padW;   // TF puts the odd extra pixel at the end
  const out = new Float32Array(N * OH * OW * Co);
  for (let n = 0; n < N; n++) {
    const xn = x.data.subarray(n * H * W * Ci, (n + 1) * H * W * Ci);
    const xp = padInput(xn, H, W, Ci, pt, pl, Hp, Wp);
    const r = (wasmConv && wasmConv(xp, Hp, Wp, Ci, f.data, KH, KW, Co, OH, OW, sh, sw)) || convJS(xp, Hp, Wp, Ci, f.data, KH, KW, Co, OH, OW, sh, sw);
    out.set(r, n * OH * OW * Co);
  }
  if (bias || relu) {
    const b = bias?.data;
    for (let i = 0; i < out.length; i++) { let v = out[i] + (b ? b[i % Co] : 0); if (relu && v < 0) v = 0; out[i] = v; }
  }
  return tensor([N, OH, OW, Co], out);
}

// ------------------------------------------------------------------ graph
const sigmoid = v => 1 / (1 + Math.exp(-v));
const OPS = {
  Identity: (n, [a]) => a,
  Shape: (n, [a]) => tensor([a.shape.length], Int32Array.from(a.shape), 'int32'),
  Reshape: (n, [a, s]) => reshape(a, s),
  Transpose: (n, [a, p]) => transpose(a, Array.from(p.data)),
  ExpandDims: (n, [a, d]) => { let ax = d.data[0]; if (ax < 0) ax += a.shape.length + 1; const s = a.shape.slice(); s.splice(ax, 0, 1); return tensor(s, a.data, a.dtype); },
  Squeeze: (n, [a]) => {
    const dims = (attrOf(n, 'squeeze_dims', []) || []).map(d => (d < 0 ? d + a.shape.length : d));
    const s = a.shape.filter((d, i) => (dims.length ? !dims.includes(i) : d !== 1));
    return tensor(s, a.data, a.dtype);
  },
  StridedSlice: (n, [x, b, e, s]) => stridedSlice(x, b, e, s, { begin: attrOf(n, 'begin_mask', 0), end: attrOf(n, 'end_mask', 0), ellipsis: attrOf(n, 'ellipsis_mask', 0), newAxis: attrOf(n, 'new_axis_mask', 0), shrink: attrOf(n, 'shrink_axis_mask', 0) }),
  Pack: (n, ins) => pack(ins, attrOf(n, 'axis', 0)),
  ConcatV2: (n, ins) => concat(ins.slice(0, -1), ins[ins.length - 1].data[0]),
  Pad: (n, [a, p]) => pad(a, p),
  MirrorPad: (n, [a, p]) => mirrorPad(a, p, attrOf(n, 'mode', 'REFLECT')),
  Neg: (n, [a]) => unary(a, v => -v),
  Square: (n, [a]) => unary(a, v => v * v),
  Sqrt: (n, [a]) => unary(a, Math.sqrt),
  Log: (n, [a]) => unary(a, Math.log),
  Sigmoid: (n, [a]) => unary(a, sigmoid),
  Add: (n, [a, b]) => binary(a, b, 'add'),
  AddV2: (n, [a, b]) => binary(a, b, 'add'),
  Sub: (n, [a, b]) => binary(a, b, 'sub'),
  Mul: (n, [a, b]) => binary(a, b, 'mul'),
  DivNoNan: (n, [a, b]) => binary(a, b, 'divnonan'),
  Sum: (n, [a, ax]) => reduce(a, ax, attrOf(n, 'keep_dims', false), 'sum'),
  Min: (n, [a, ax]) => reduce(a, ax, attrOf(n, 'keep_dims', false), 'min'),
  Max: (n, [a, ax]) => reduce(a, ax, attrOf(n, 'keep_dims', false), 'max'),
  Conv2D: (n, [x, f]) => { if (attrOf(n, 'data_format', 'NHWC') !== 'NHWC') throw new Error('NCHW'); return conv2d(x, f, attrOf(n, 'strides'), attrOf(n, 'padding'), attrOf(n, 'dilations')); },
  _FusedConv2D: (n, [x, f, b]) => {
    const fused = attrOf(n, 'fused_ops', []);
    if (fused.some(o => o !== 'BiasAdd' && o !== 'Relu')) throw new Error('fused op ' + fused);
    return conv2d(x, f, attrOf(n, 'strides'), attrOf(n, 'padding'), attrOf(n, 'dilations'), fused.includes('BiasAdd') ? b : null, fused.includes('Relu'));
  },
};
export const SUPPORTED_OPS = Object.keys(OPS);

/**
 * Build an executable graph from a tf.js model.json object and its weights (ArrayBuffer/Uint8Array of all shards
 * concatenated in manifest order).
 */
export function loadGraph(modelJson, weightBytes) {
  const buf = weightBytes instanceof ArrayBuffer ? weightBytes : weightBytes.buffer.slice(weightBytes.byteOffset, weightBytes.byteOffset + weightBytes.byteLength);
  const consts = new Map(); let off = 0;
  for (const group of modelJson.weightsManifest) for (const w of group.weights) {
    const n = size(w.shape);
    if (w.quantization) throw new Error('quantized weights not supported');
    const data = w.dtype === 'int32' ? new Int32Array(buf.slice(off, off + 4 * n)) : new Float32Array(buf.slice(off, off + 4 * n));
    consts.set(w.name, tensor(w.shape, data, w.dtype === 'int32' ? 'int32' : 'float32')); off += 4 * n;
  }
  const nodes = new Map();
  for (const nd of modelJson.modelTopology.node) {
    if (nd.op !== 'Const' && nd.op !== 'Placeholder' && !OPS[nd.op]) throw new Error('unsupported op ' + nd.op);
    nodes.set(nd.name, { ...nd, inputs: (nd.input || []).filter(i => !i.startsWith('^')).map(i => i.split(':')[0]) });
  }
  const sig = modelJson.signature || {};
  const outputs = Object.fromEntries(Object.entries(sig.outputs || {}).map(([k, v]) => [k, v.name.split(':')[0]]));
  const inputs = Object.fromEntries(Object.entries(sig.inputs || {}).map(([k, v]) => [k, v.name.split(':')[0]]));
  return { nodes, consts, outputs, inputs };
}

/** Execute: feeds {nodeName: tensor}, fetch [nodeName] → tensors. Intermediates are dropped once consumed. */
export function runGraph(g, feeds, fetch) {
  const order = [], seen = new Set();
  const visit = name => {
    if (seen.has(name)) return; seen.add(name);
    const nd = g.nodes.get(name); if (!nd) throw new Error('no node ' + name);
    for (const i of nd.inputs) visit(i);
    order.push(name);
  };
  fetch.forEach(visit);
  const uses = new Map();
  for (const name of order) for (const i of g.nodes.get(name).inputs) uses.set(i, (uses.get(i) || 0) + 1);
  const vals = new Map();
  for (const name of order) {
    const nd = g.nodes.get(name);
    let v;
    if (nd.op === 'Const') v = g.consts.get(name);
    else if (nd.op === 'Placeholder') { v = feeds[name]; if (!v) throw new Error('missing feed ' + name); }
    else v = OPS[nd.op](nd, nd.inputs.map(i => vals.get(i)));
    vals.set(name, v);
    for (const i of nd.inputs) { const u = uses.get(i) - 1; uses.set(i, u); if (u === 0 && !fetch.includes(i) && g.nodes.get(i).op !== 'Const') vals.delete(i); }
  }
  return fetch.map(f => vals.get(f));
}
