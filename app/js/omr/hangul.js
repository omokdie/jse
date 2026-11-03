// JSE Hangul lyric recogniser — inference. Pure JS (typed arrays only): runs in
// the OMR Web Worker and in Node. Trained by tools/omr/hangul/train.py; the
// numerics below (em-box sampling, ink normalisation, features) are exact ports
// of tools/omr/hangul/core.py and are checked against Python fixtures by
// tools/tests/hangul.test.js.
//
// A token (one syllable block / symbol) is read from a square "em-box": side
// EM_BOX × the height of the text line's Hangul ink band, centred on the
// token's ink box horizontally and on the band vertically, resampled to
// 32 × 32 and normalised to an ink map. A small MLP on gradient-direction
// features predicts four heads — type (Hangul / symbol / noise), initial,
// medial and final jamo — so every one of the 11,172 syllables can be decoded;
// the 2,350 KS X 1001 syllables are preferred.
import { HANGUL_MODEL } from './hangul-weights.js';

export const CROP = 32;
export const EM_BOX = HANGUL_MODEL.emBox;
const N = CROP;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
// model (decoded lazily on first use)
// ---------------------------------------------------------------------------
let NET = null;

function b64bytes(s) {
  if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const f32 = (s) => new Float32Array(b64bytes(s).buffer);

function net() {
  if (NET) return NET;
  const M = HANGUL_MODEL;
  const layers = M.layers.map((L) => {
    const q = new Int8Array(b64bytes(L.w).buffer), scale = f32(L.scale), bias = f32(L.bias);
    const W = new Float32Array(L.in * L.out);              // transposed: W[i * out + o]
    for (let o = 0; o < L.out; o++) { const s = scale[o], off = o * L.in; for (let i = 0; i < L.in; i++) W[i * L.out + o] = q[off + i] * s; }
    return { nIn: L.in, nOut: L.out, W, bias };
  });
  const heads = []; let off = 0;
  for (const [name, n] of M.heads) { heads.push({ name, off, n }); off += n; }
  const ks = b64bytes(M.ks), ksList = [];
  for (let k = 0; k < 11172; k++) if (ks[k >> 3] & (1 << (k & 7))) ksList.push(k);
  const ksI = new Uint8Array(ksList.length), ksM = new Uint8Array(ksList.length), ksF = new Uint8Array(ksList.length);
  ksList.forEach((k, j) => { ksI[j] = (k / 588) | 0; ksM[j] = ((k % 588) / 28) | 0; ksF[j] = k % 28; });
  const types = M.types;
  NET = { layers, heads, types, hangulT: types.indexOf('HANGUL'), noiseT: types.indexOf('NOISE'), ksBits: ks, ksList, ksI, ksM, ksF,
    input: new Float32Array(layers[0].nIn), bufs: layers.map(L => new Float32Array(L.nOut)),
    lI: new Float64Array(19), lM: new Float64Array(21), lF: new Float64Array(28), prior: null, priorW: 0 };
  if (M.prior) {      // log unigram prior of the KS syllables (uint8 = -log p / step)
    const q = b64bytes(M.prior.q); NET.prior = new Float32Array(q.length);
    for (let j = 0; j < q.length; j++) NET.prior[j] = -q[j] * M.prior.step;
    NET.priorW = M.prior.weight; NET.priorUnseen = -255 * M.prior.step;
  }
  return NET;
}

/** Weight of the syllable prior in decoding (tuning / evaluation only). */
export function setPriorWeight(w) { net().priorW = w; }

export function modelInfo() { const M = HANGUL_MODEL; return { version: M.version, types: M.types.slice(), accuracy: M.accuracy }; }
export const isKsSyllable = (ch) => { const n = net(), k = ch.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172 && !!(n.ksBits[k >> 3] & (1 << (k & 7))); };

// ---------------------------------------------------------------------------
// em-box sampling + ink normalisation (ports of core.sample_embox / normalize_ink)
// ---------------------------------------------------------------------------
export function supersampleFactor(sOrig) { return Math.min(4, Math.max(1, Math.ceil(sOrig / CROP - 0.01))); }

/**
 * CROP×CROP grey crop of the square [cx-S/2, cx+S/2]² (working coordinates).
 * grey: { width, height, data } (8-bit grey, pixel centres at integers);
 * affine [a, b, c, d, e, f]: image x = a·x + b·y + c, y = d·x + e·y + f (null = identity);
 * k: supersampling factor; mask(x, y) → true for pixels of neighbouring tokens (they read as NaN).
 */
export function sampleEmBox(grey, cx, cy, S, affine = null, k = null, mask = null) {
  const { width: W, height: H, data } = grey;
  if (k == null) k = supersampleFactor(affine ? S * Math.hypot(affine[0], affine[3]) : S);
  const out = new Float64Array(N * N);
  const [a0, a1, a2, a3, a4, a5] = affine || [1, 0, 0, 0, 1, 0];
  const offs = new Float64Array(N * k);
  for (let u = 0; u < N; u++) for (let a = 0; a < k; a++) offs[u * k + a] = ((u + (a + 0.5) / k) / N - 0.5) * S;
  for (let v = 0; v < N; v++) for (let u = 0; u < N; u++) {
    if (mask && mask(cx + ((u + 0.5) / N - 0.5) * S, cy + ((v + 0.5) / N - 0.5) * S)) { out[v * N + u] = NaN; continue; }
    let acc = 0;
    for (let b = 0; b < k; b++) {
      const py = cy + offs[v * k + b];
      for (let a = 0; a < k; a++) {
        const px = cx + offs[u * k + a];
        const xs = a0 * px + a1 * py + a2, ys = a3 * px + a4 * py + a5;
        const x0 = Math.floor(xs), y0 = Math.floor(ys);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) { acc += 255; continue; }
        const fx = xs - x0, fy = ys - y0, o = y0 * W + x0;
        acc += (data[o] * (1 - fx) + data[o + 1] * fx) * (1 - fy) + (data[o + W] * (1 - fx) + data[o + W + 1] * fx) * fy;
      }
    }
    out[v * N + u] = acc / (k * k);
  }
  return out;
}

/** Grey crop → ink map in [0,1], quantised to 1/255 (NaN = masked → paper). */
export function normalizeInk(crop) {
  const M = HANGUL_MODEL;
  let vals = new Float64Array(crop.length), nv = 0;
  for (let i = 0; i < crop.length; i++) if (!Number.isNaN(crop[i])) vals[nv++] = crop[i];
  if (nv < 16) { nv = crop.length; for (let i = 0; i < nv; i++) vals[i] = Number.isNaN(crop[i]) ? 255 : crop[i]; }
  vals = vals.subarray(0, nv).sort();
  const q = (p) => vals[Math.floor(p * (vals.length - 1))];
  const paper = q(M.paperPct), ink = q(M.inkPct);
  const contrast = Math.max(paper - ink, M.minContrast);
  const out = new Float64Array(crop.length);
  for (let i = 0; i < crop.length; i++) {
    const v = crop[i];
    if (Number.isNaN(v)) { out[i] = 0; continue; }
    let m = (paper - v) / contrast; m = m < 0 ? 0 : m > 1 ? 1 : m;
    out[i] = Math.floor(m * 255 + 0.5) / 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// features (port of core.features): 8 gradient directions pooled on an 8×8
// grid (smoothed, sqrt) + 16×16 ink averages → 768 values
// ---------------------------------------------------------------------------
const planes = new Float64Array(8 * N * N);
export function inkFeatures(ink, out = new Float64Array(768)) {
  planes.fill(0);
  const I = (y, x) => (y < 0 || x < 0 || y >= N || x >= N ? 0 : ink[y * N + x]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const gx = (I(y - 1, x + 1) + 2 * I(y, x + 1) + I(y + 1, x + 1)) - (I(y - 1, x - 1) + 2 * I(y, x - 1) + I(y + 1, x - 1));
    const gy = (I(y + 1, x - 1) + 2 * I(y + 1, x) + I(y + 1, x + 1)) - (I(y - 1, x - 1) + 2 * I(y - 1, x) + I(y - 1, x + 1));
    const mag = Math.sqrt(gx * gx + gy * gy);
    if (mag === 0) continue;
    const t = (((Math.atan2(gy, gx) % TWO_PI) + TWO_PI) % TWO_PI) / (Math.PI / 4);
    const kf = Math.floor(t), f = t - kf, k0 = kf % 8, k1 = (k0 + 1) % 8, p = y * N + x;
    planes[k0 * N * N + p] += (1 - f) * mag;
    planes[k1 * N * N + p] += f * mag;
  }
  const pooled = new Float64Array(8 * 64), tmp = new Float64Array(8 * 64);
  for (let d = 0; d < 8; d++) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    let s = 0;
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) s += planes[d * N * N + (i * 4 + yy) * N + j * 4 + xx];
    pooled[d * 64 + i * 8 + j] = s;
  }
  // [1,2,1] along rows (i), then along columns (j), / 16
  for (let d = 0; d < 8; d++) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const o = d * 64 + j;
    tmp[d * 64 + i * 8 + j] = (i > 0 ? pooled[o + (i - 1) * 8] : 0) + 2 * pooled[o + i * 8] + (i < 7 ? pooled[o + (i + 1) * 8] : 0);
  }
  for (let d = 0; d < 8; d++) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const o = d * 64 + i * 8;
    out[d * 64 + i * 8 + j] = Math.sqrt(((j > 0 ? tmp[o + j - 1] : 0) + 2 * tmp[o + j] + (j < 7 ? tmp[o + j + 1] : 0)) / 16);
  }
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    const p = i * 2 * N + j * 2;
    out[512 + i * 16 + j] = (ink[p] + ink[p + 1] + ink[p + N] + ink[p + N + 1]) / 4;
  }
  return out;
}

// ---------------------------------------------------------------------------
// network + decoding
// ---------------------------------------------------------------------------
/** y = act(xᵀW + b) with W stored input-major; zero inputs (ReLU outputs,
 * empty feature cells) are skipped. */
function dense(W, bias, x, y, nIn, nOut, relu) {
  y.set(bias);
  for (let i = 0; i < nIn; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const off = i * nOut;
    for (let o = 0; o < nOut; o++) y[o] += W[off + o] * xi;
  }
  if (relu) for (let o = 0; o < nOut; o++) if (y[o] < 0) y[o] = 0;
}

/** Raw logits (Float32Array, reused buffer) for a 768-d feature vector. */
export function logitsOf(feat) {
  const n = net();
  n.input.set(feat);
  let x = n.input;
  const last = n.layers.length - 1;
  for (let li = 0; li <= last; li++) {
    const L = n.layers[li];
    dense(L.W, L.bias, x, n.bufs[li], L.nIn, L.nOut, li < last);
    x = n.bufs[li];
  }
  return x;
}

function softmax(z, off, n) {
  let m = -Infinity; for (let i = 0; i < n; i++) if (z[off + i] > m) m = z[off + i];
  const p = new Float64Array(n); let s = 0;
  for (let i = 0; i < n; i++) { p[i] = Math.exp(z[off + i] - m); s += p[i]; }
  for (let i = 0; i < n; i++) p[i] /= s;
  return p;
}

const NON_KS_LOGP = Math.log(0.02);   // prior for syllables outside KS X 1001

function logs(p, out) { for (let i = 0; i < p.length; i++) out[i] = Math.log(p[i] + 1e-9); return out; }

/**
 * Reads one ink map (Float64Array(1024), from normalizeInk).
 * → { kind:'hangul'|'symbol'|'noise', text, conf, pHangul, pNoise, hangul:{text, conf}, symbol:{text, conf}, alts:[{text, conf}] }
 *   conf = P(type) × P(initial) × P(medial) × P(final) for syllables, P(type) otherwise
 *   (the syllable prior only ranks candidates; it never enters the confidence).
 */
export function readInk(ink) {
  const n = net();
  const z = logitsOf(inkFeatures(ink));
  const [hT, hI, hM, hF] = n.heads;
  const pT = softmax(z, hT.off, hT.n), pI = softmax(z, hI.off, hI.n), pM = softmax(z, hM.off, hM.n), pF = softmax(z, hF.off, hF.n);
  const lI = logs(pI, n.lI), lM = logs(pM, n.lM), lF = logs(pF, n.lF);
  // best KS X 1001 syllables (top 3, insertion without allocation)
  let s0 = -Infinity, s1 = -Infinity, s2 = -Infinity, k0 = -1, k1 = -1, k2 = -1;
  const { ksI, ksM, ksF, ksList } = n;
  for (let j = 0; j < ksI.length; j++) {
    const sc = lI[ksI[j]] + lM[ksM[j]] + lF[ksF[j]] + (n.prior ? n.priorW * n.prior[j] : 0);
    if (sc <= s2) continue;
    if (sc > s0) { s2 = s1; k2 = k1; s1 = s0; k1 = k0; s0 = sc; k0 = ksList[j]; }
    else if (sc > s1) { s2 = s1; k2 = k1; s1 = sc; k1 = ksList[j]; }
    else { s2 = sc; k2 = ksList[j]; }
  }
  const top = [{ s: s0, k: k0 }, { s: s1, k: k1 }, { s: s2, k: k2 }];
  // unconstrained best (may be outside KS X 1001)
  let bi = 0, bm = 0, bf = 0;
  for (let i = 1; i < pI.length; i++) if (pI[i] > pI[bi]) bi = i;
  for (let i = 1; i < pM.length; i++) if (pM[i] > pM[bm]) bm = i;
  for (let i = 1; i < pF.length; i++) if (pF[i] > pF[bf]) bf = i;
  const kFree = (bi * 21 + bm) * 28 + bf;
  const sFree = lI[bi] + lM[bm] + lF[bf];
  // confidence uses the visual evidence only (the prior just ranks the candidates)
  const vis = (k) => lI[(k / 588) | 0] + lM[((k % 588) / 28) | 0] + lF[k % 28];
  const cands = top.filter(c => c.k >= 0).map(c => ({ text: String.fromCharCode(0xac00 + c.k), s: vis(c.k), rank: c.s }));
  const rankFree = sFree + NON_KS_LOGP + (n.prior ? n.priorW * n.priorUnseen : 0);
  if (!(n.ksBits[kFree >> 3] & (1 << (kFree & 7))) && rankFree > cands[0].rank) cands.unshift({ text: String.fromCharCode(0xac00 + kFree), s: sFree, rank: rankFree });
  const pH = pT[n.hangulT], pNoise = pT[n.noiseT];
  const hangulAlts = cands.map(c => ({ text: c.text, conf: pH * Math.exp(c.s) }));
  let bs = -1;
  for (let t = 0; t < pT.length; t++) if (t !== n.hangulT && t !== n.noiseT && (bs < 0 || pT[t] > pT[bs])) bs = t;
  const sym = { text: n.types[bs], conf: pT[bs] };
  let tBest = 0; for (let t = 1; t < pT.length; t++) if (pT[t] > pT[tBest]) tBest = t;
  const kind = tBest === n.hangulT ? 'hangul' : tBest === n.noiseT ? 'noise' : 'symbol';
  const main = kind === 'hangul' ? hangulAlts[0] : kind === 'symbol' ? sym : { text: '', conf: pNoise };
  const alts = [...hangulAlts, sym].filter(a => a.text !== main.text).sort((a, b) => b.conf - a.conf).slice(0, 3);
  return { kind, text: main.text, conf: main.conf, pHangul: pH, pNoise, hangul: hangulAlts[0], symbol: sym, alts };
}
