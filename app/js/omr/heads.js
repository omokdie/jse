// JSE OMR — note-head candidates on the staff-position grid + learned
// classification (none / filled / half / whole) of grey patches.
//
// On the rectified working image (staff space 12 px, horizontal lines) a
// note head can only be centred on a staff position p (line or space,
// y = top + p·sp/2).  For every staff and every p in [-7, 15] the ink
// fraction of a head-sized box is computed along x (integral image of the
// line-free binary); local maxima are candidates.  A small MLP
// (classifiers.js, weights trained by tools/omr/train_heads.py on synthetic
// photos) labels each candidate from a 24×24 grey patch; overlapping
// detections are suppressed.
import { clamp } from './imgutil.js';

const rnd = Math.round;
export const PATCH = 24;          // patch side (px) at staff space 12
export const P_MIN = -7, P_MAX = 15;

function integral(bin, w, h) {
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    const r = y * w, o = (y + 1) * (w + 1), o0 = y * (w + 1);
    for (let x = 0; x < w; x++) { s += bin[r + x]; I[o + x + 1] = I[o0 + x + 1] + s; }
  }
  return I;
}
const boxSum = (I, w, x0, y0, x1, y1) => I[(y1 + 1) * (w + 1) + x1 + 1] - I[y0 * (w + 1) + x1 + 1] - I[(y1 + 1) * (w + 1) + x0] + I[y0 * (w + 1) + x0];

/** Candidate centres: local maxima of the head-box ink fraction along x for
 * every staff position.  Returns [{ x, y, p, staff, R }]. */
export function headCandidates(ctx, staves, nolines, opts = {}) {
  const { w, h, sp } = ctx;
  const I = integral(nolines, w, h);
  const hw = Math.max(3, rnd(0.55 * sp)), hh = Math.max(2, rnd(0.36 * sp));   // half box: 1.1 × 0.72 sp
  const minR = opts.minR ?? 0.22;
  const area = (2 * hw + 1) * (2 * hh + 1);
  const out = [];
  for (const st of staves) {
    const xa = Math.max(hw + 1, rnd(st.x0 - 1.5 * sp)), xb = Math.min(w - hw - 2, rnd(st.x1 + 1.0 * sp));
    if (xb <= xa) continue;
    const n = xb - xa + 1;
    const R = new Float32Array(n);
    for (let p = P_MIN; p <= P_MAX; p++) {
      for (let i = 0; i < n; i++) {
        const x = xa + i;
        const l0 = st.lines[0][x], l4 = st.lines[4][x];
        const y = rnd(l0 + p * (l4 - l0) / 8);
        if (y - hh < 0 || y + hh >= h) { R[i] = 0; continue; }
        R[i] = boxSum(I, w, x - hw, y - hh, x + hw, y + hh) / area;
      }
      // local maxima along x (plateaus: keep the centre of the plateau)
      const rad = Math.max(2, rnd(0.45 * sp));
      for (let i = 0; i < n; i++) {
        const v = R[i];
        if (v < minR) continue;
        let isMax = true, j0 = i, j1 = i;
        for (let d = 1; d <= rad && isMax; d++) {
          if (i - d >= 0 && R[i - d] > v) isMax = false;
          if (i + d < n && R[i + d] > v) isMax = false;
        }
        if (!isMax) continue;
        while (j1 + 1 < n && R[j1 + 1] === v) j1++;
        if (j0 > 0 && R[j0 - 1] === v) continue;                 // only the first column of a plateau
        const x = xa + ((j0 + j1) >> 1);
        const l0 = st.lines[0][x], l4 = st.lines[4][x];
        out.push({ x, y: l0 + p * (l4 - l0) / 8, p, staff: st, R: v });
        i = j1 + rad - 1;                                         // skip the plateau / neighbourhood
      }
    }
  }
  return out;
}

/** Normalised ink patch (PATCH×PATCH, 0 = paper, 1 = solid ink) centred on (cx, cy). */
export function patchAt(ctx, cx, cy, out = new Float32Array(PATCH * PATCH), lv = inkLevels(ctx)) {
  const { gray, w, h } = ctx;
  const x0 = rnd(cx) - PATCH / 2, y0 = rnd(cy) - PATCH / 2;
  const scale = 1 / Math.max(20, lv.paper - lv.ink);
  for (let yy = 0; yy < PATCH; yy++) {
    const y = y0 + yy;
    for (let xx = 0; xx < PATCH; xx++) {
      const x = x0 + xx;
      const g = x >= 0 && y >= 0 && x < w && y < h ? gray[y * w + x] : lv.paper;
      out[yy * PATCH + xx] = clamp((lv.paper - g) * scale, -0.2, 1.3);
    }
  }
  return out;
}

/** Paper and solid-ink levels of the working grey image (cached on ctx). */
export function inkLevels(ctx) {
  if (ctx._inkLevels) return ctx._inkLevels;
  const { gray } = ctx;
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]]++;
  let tot = 0; for (let i = 0; i < 256; i++) tot += hist[i];
  const pct = (q) => { let a = 0; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= q * tot) return i; } return 255; };
  const paper = ctx.paperLevel || pct(0.6);
  const ink = Math.min(pct(0.01), paper - 40);
  ctx._inkLevels = { paper, ink };
  return ctx._inkLevels;
}

/** Extra scalar features for a candidate (appended to the patch). */
export function candFeatures(c) {
  const p = c.p;
  return [p % 2 === 0 ? 1 : 0, p < -1 ? 1 : 0, p > 9 ? 1 : 0, c.R];
}
export const N_FEAT = PATCH * PATCH + 4;

/**
 * Learned note heads: candidates → MLP → NMS.
 * Returns { heads: [{cx, cy, x0, x1, y0, y1, staff, hollow, prob, p, cls}], wholes: [...] }
 * where heads are filled / half heads (to be attached to stems) and wholes
 * are stemless whole notes.
 */
export function learnedHeads(ctx, staves, nolines, model, predictFn, opts = {}) {
  const { sp } = ctx;
  const cands = headCandidates(ctx, staves, nolines);
  const lv = inkLevels(ctx);
  const x = new Float32Array(N_FEAT), probs = new Float32Array(4);
  const dets = [];
  const minProb = opts.minProb ?? 0.5;
  for (const c of cands) {
    patchAt(ctx, c.x, c.y, x, lv);
    const f = candFeatures(c);
    for (let k = 0; k < f.length; k++) x[PATCH * PATCH + k] = f[k];
    predictFn(model, x, probs);
    // a head unless "none" dominates: the class is the most likely of filled / half / whole
    let cls = 1;
    for (let k = 2; k < 4; k++) if (probs[k] > probs[cls]) cls = k;
    if (1 - probs[0] < minProb) continue;
    dets.push({ cx: c.x, cy: c.y, p: c.p, staff: c.staff, cls, prob: 1 - probs[0], probs: Array.from(probs) });
  }
  // non-maximum suppression: same or adjacent staff position and overlapping in x
  dets.sort((a, b) => b.prob - a.prob);
  const kept = [];
  for (const d of dets) {
    if (kept.some(k => k.staff === d.staff && ((Math.abs(k.p - d.p) <= 1 && Math.abs(k.cx - d.cx) < 0.7 * sp) || (k.p === d.p && Math.abs(k.cx - d.cx) < 0.95 * sp)))) continue;
    kept.push(d);
  }
  const box = (d) => ({ x0: d.cx - 0.6 * sp, x1: d.cx + 0.6 * sp, y0: d.cy - 0.5 * sp, y1: d.cy + 0.5 * sp });
  const heads = [], wholes = [];
  for (const d of kept) {
    const hd = { cx: d.cx, cy: d.cy, ...box(d), staff: d.staff, hollow: d.cls !== 1, prob: d.prob, p: d.p, cls: d.cls, area: 0, learned: true };
    if (d.cls === 3) wholes.push(hd); else heads.push(hd);
  }
  return { heads, wholes, candidates: cands.length };
}

/** Stemless whole-note events (same shape as omr.js findWholeNotes output). */
export function wholeNoteEvents(wholes, staffPosAt) {
  return wholes.map(hd => {
    hd.pos = Math.round(staffPosAt(hd.staff, hd.cx, hd.cy));
    return { kind: 'note', staff: hd.staff, x: hd.cx, stem: null, base: 'whole', dots: 0, beam: false, nb: 0, conf: Math.min(0.95, hd.prob),
      heads: [hd], bbox: { x0: hd.x0, y0: hd.y0, x1: hd.x1, y1: hd.y1 } };
  });
}
