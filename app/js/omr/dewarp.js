// JSE OMR — staff-guided rectification ("dewarping") of photographed pages.
//
// After a first staff detection on the deskewed working image, every system
// is resampled into a straight strip in which
//   * all staff lines are exactly horizontal, staff space = 12 px everywhere
//     (removes page curl, perspective scale changes and residual rotation);
//   * page verticals (stems, barlines) are vertical: the local direction of
//     thin vertical strokes is measured per system segment (projection
//     sharpness over a shear sweep) and sampled along that direction;
//   * the horizontal scale follows the local staff space (aspect preserved).
// The strips are stacked into a new working image; the returned context has
// the same contract as preprocess() (w, h, gray, bin, sp, t, toOrig, bboxToOrig
// ...), with toOrig composed through the strip maps, so every later stage
// (and the lyric stage) works unchanged on the rectified image.
import { clamp, runLengths, gaussBlurX, runStats } from './imgutil.js';

const SP = 12;
const rnd = Math.round;

/** Local tilt (dx/dy) of vertical strokes for one system, as a function of x. */
function verticalTilt(ctx, sysStaves) {
  const { w, h, sp, bin } = ctx;
  const top = sysStaves[0], bot = sysStaves[sysStaves.length - 1];
  const xa = Math.max(0, Math.min(...sysStaves.map(s => s.x0))), xb = Math.min(w - 1, Math.max(...sysStaves.map(s => s.x1)));
  if (xb - xa < 8 * sp) return { at: () => 0, samples: [] };
  // thin vertical ink: horizontal run ≤ 0.4 sp (excludes heads, beams, lines)
  const hr = runLengths(bin, w, h, false);
  const maxW = Math.max(3, rnd(0.4 * sp));
  const seg = 24 * sp, stepSeg = 12 * sp;
  const samples = [];
  const angles = [];
  for (let a = -9; a <= 9 + 1e-9; a += 0.5) angles.push(Math.tan(a * Math.PI / 180));
  for (let s0 = xa; s0 < xb; s0 += stepSeg) {
    const s1 = Math.min(xb, s0 + seg);
    if (s1 - s0 < 8 * sp) continue;
    const pts = [];
    for (let x = rnd(s0); x < s1; x++) {
      const y0 = Math.max(0, rnd(top.lines[0][x] - 0.5 * sp)), y1 = Math.min(h - 1, rnd(bot.lines[4][x] + 0.5 * sp));
      const ym = (y0 + y1) / 2;
      for (let y = y0; y <= y1; y++) { const i = y * w + x; if (bin[i] && hr[i] <= maxW) pts.push(x, y - ym); }
    }
    if (pts.length < 40 * sp) continue;
    const n = pts.length >> 1;
    const L = rnd(s1 - s0 + 4 * sp) + 1;
    const hist = new Float32Array(L + 2);
    let bestV = -1, bestK = 0;
    const scores = [];
    for (let k = 0; k < angles.length; k++) {
      hist.fill(0);
      const tg = angles[k];
      for (let i = 0; i < n; i++) { const u = pts[2 * i] - s0 + 2 * sp - pts[2 * i + 1] * tg; const ui = u | 0; if (ui >= 0 && ui <= L) hist[ui]++; }
      let v = 0; for (let i = 0; i <= L; i++) v += hist[i] * hist[i];
      scores.push(v);
      if (v > bestV) { bestV = v; bestK = k; }
    }
    // sub-step refinement (parabola) and a contrast check
    let kk = bestK;
    if (bestK > 0 && bestK < angles.length - 1) { const a = scores[bestK - 1], b = scores[bestK], c = scores[bestK + 1]; const d = a - 2 * b + c; if (d < 0) kk = bestK + clamp(0.5 * (a - c) / d, -0.5, 0.5); }
    const sorted = scores.slice().sort((p, q) => p - q);
    const contrast = bestV / Math.max(1, sorted[sorted.length >> 1]);
    if (contrast < 1.15) continue;
    const deg = -9 + kk * 0.5;
    samples.push({ x: (s0 + s1) / 2, tg: Math.tan(deg * Math.PI / 180), wgt: Math.min(4, contrast - 1) * Math.sqrt(n) });
  }
  if (!samples.length) return { at: () => 0, samples };
  // weighted linear fit tg(x) with one round of outlier rejection
  const fit = (arr) => {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const s of arr) { sw += s.wgt; sx += s.wgt * s.x; sy += s.wgt * s.tg; sxx += s.wgt * s.x * s.x; sxy += s.wgt * s.x * s.tg; }
    const den = sw * sxx - sx * sx;
    if (arr.length < 3 || Math.abs(den) < 1e-9) return { a: sy / sw, b: 0, xm: 0 };
    const b = (sw * sxy - sx * sy) / den, a = (sy - b * sx) / sw;
    return { a, b, xm: 0 };
  };
  let f = fit(samples);
  const res = samples.map(s => Math.abs(s.tg - (f.a + f.b * s.x)));
  const lim = Math.max(0.012, 2.5 * res.slice().sort((p, q) => p - q)[res.length >> 1]);
  const keep = samples.filter((s, i) => res[i] <= lim);
  if (keep.length >= 2) f = fit(keep);
  // the slope term may not run away beyond the measured range
  const xs = keep.map(s => s.x), xmin = Math.min(...xs), xmax = Math.max(...xs);
  return { at: (x) => clamp(f.a + f.b * clamp(x, xmin, xmax), -0.16, 0.16), samples };
}

/** Builds the per-system column model: anchors with control points. */
function systemModel(ctx, sysStaves, tilt, opts) {
  const { w, sp } = ctx;
  const J = sysStaves.length;
  const xs = Math.max(0, Math.min(...sysStaves.map(s => s.x0)) - opts.left * sp);
  const xe = Math.min(w - 1, Math.max(...sysStaves.map(s => s.x1)) + opts.right * sp);
  const step = 3;
  const anchors = [];
  for (let x = xs; x <= xe; x += step) {
    const xi = clamp(rnd(x), 0, w - 1);
    const yRef = (sysStaves[0].lines[0][xi] + sysStaves[J - 1].lines[4][xi]) / 2;
    const tg = tilt.at(x);
    const pts = [];
    for (let j = 0; j < J; j++) for (let k = 0; k < 5; k++) {
      const line = sysStaves[j].lines[k];
      let y = line[xi];
      for (let it = 0; it < 3; it++) { const xx = clamp(rnd(x + (y - yRef) * tg), 0, w - 1); y = line[xx]; }
      pts.push(x + (y - yRef) * tg, y);
    }
    anchors.push({ x, tg, pts });
  }
  // local staff space along the system (smoothed) and the horizontal arc length
  const n = anchors.length;
  const spLoc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = anchors[i].pts; let s = 0;
    for (let j = 0; j < J; j++) { const a = j * 10, b = j * 10 + 8; s += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]) / 4; }
    spLoc[i] = s / J;
  }
  const win = Math.max(1, rnd(4 * sp / step));
  const spS = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) { s += spLoc[k]; c++; } spS[i] = s / c; }
  const mid = Math.floor(J / 2) * 10 + 4;     // middle line of the middle staff
  const A = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const p = anchors[i].pts, q = anchors[i - 1].pts;
    A[i] = A[i - 1] + Math.hypot(p[mid] - q[mid], p[mid + 1] - q[mid + 1]) * SP / Math.max(1, 0.5 * (spS[i] + spS[i - 1]));
  }
  // rectified y of each line: staff j top at Y[j]; gaps between staves from the median distance
  const Y = new Float64Array(J * 5);
  let yTop = 0;
  for (let j = 0; j < J; j++) {
    if (j > 0) {
      const gaps = [];
      for (let i = 0; i < n; i += 2) { const p = anchors[i].pts; const a = (j - 1) * 10 + 8, b = j * 10; gaps.push(Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]) * SP / spS[i]); }
      gaps.sort((p, q) => p - q);
      yTop = Y[(j - 1) * 5 + 4] + Math.max(SP, rnd(gaps[gaps.length >> 1]));
    }
    for (let k = 0; k < 5; k++) Y[j * 5 + k] = yTop + k * SP;
  }
  return { anchors, A, spS, Y, J, width: Math.ceil(A[n - 1]) + 1 };
}

/** Rectified (a, b) of system model m → working (x, y). b is relative to the
 * system's first top line (Y[0] = 0). */
function mapPoint(m, a, b, hint) {
  const { anchors, A, Y } = m;
  const n = anchors.length;
  let i = hint && hint.i != null ? hint.i : 0;
  if (a <= A[0]) i = 0; else if (a >= A[n - 1]) i = n - 2;
  else { while (i < n - 2 && A[i + 1] < a) i++; while (i > 0 && A[i] > a) i--; }
  if (hint) hint.i = i;
  if (n < 2) return pointOnAnchor(anchors[0], m, b);
  const t = clamp((a - A[i]) / Math.max(1e-6, A[i + 1] - A[i]), -2, 3);
  const p = pointOnAnchor(anchors[i], m, b), q = pointOnAnchor(anchors[i + 1], m, b);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

function pointOnAnchor(an, m, b) {
  const { Y } = m, P = an.pts, L = Y.length;
  if (b <= Y[0]) {
    // above the system: extend along the top line's local direction using the first staff's spacing
    const sx = (P[2] - P[0]) / SP, sy = (P[3] - P[1]) / SP;
    return [P[0] + sx * (b - Y[0]), P[1] + sy * (b - Y[0])];
  }
  if (b >= Y[L - 1]) {
    const k = (L - 1) * 2, sx = (P[k] - P[k - 2]) / SP, sy = (P[k + 1] - P[k - 1]) / SP;
    return [P[k] + sx * (b - Y[L - 1]), P[k + 1] + sy * (b - Y[L - 1])];
  }
  let s = 0; while (s < L - 2 && Y[s + 1] < b) s++;
  const t = (b - Y[s]) / (Y[s + 1] - Y[s]);
  return [P[2 * s] + (P[2 * s + 2] - P[2 * s]) * t, P[2 * s + 1] + (P[2 * s + 3] - P[2 * s + 1]) * t];
}

/**
 * rectify(ctx, staves) → rectified context or null.
 * options.dewarp === false disables it.
 */
export function rectify(ctx, staves, options = {}) {
  if (!staves.length) return null;
  const { w, h, sp } = ctx;
  const systems = [];
  for (const st of staves) (systems[st.systemIndex] ||= []).push(st);
  const sysList = systems.filter(Boolean);
  const models = [];
  for (const ss of sysList) {
    const tilt = verticalTilt(ctx, ss);
    const m = systemModel(ctx, ss, tilt, { left: 3, right: 1.5 });
    m.tilt = tilt; m.staves = ss;
    models.push(m);
  }
  // vertical extent of every strip: half the gap to the neighbours (≥ 4 sp, ≤ 12 sp)
  const yMid = (ss) => { const x = clamp(rnd((ss[0].x0 + ss[0].x1) / 2), 0, w - 1); return [ss[0].lines[0][x], ss[ss.length - 1].lines[4][x]]; };
  const strips = [];
  let yOff = 0, maxW = 0;
  for (let k = 0; k < models.length; k++) {
    const m = models[k];
    const [t0, b0] = yMid(m.staves);
    const sysH = m.Y[m.Y.length - 1];
    const prevGap = k > 0 ? (t0 - yMid(models[k - 1].staves)[1]) * SP / sp : Infinity;
    const nextGap = k < models.length - 1 ? (yMid(models[k + 1].staves)[0] - b0) * SP / sp : Infinity;
    const above = rnd(clamp(prevGap / 2, 4 * SP, 12 * SP)), below = rnd(clamp(nextGap / 2, 4 * SP, 12 * SP));
    // never sample outside the working image (first / last system)
    const strip = { model: m, y0: yOff, bTop: -above, height: above + sysH + below + 1, width: m.width };
    strips.push(strip);
    yOff += strip.height;
    maxW = Math.max(maxW, m.width);
  }
  const W2 = maxW + 2, H2 = yOff;
  if (W2 * H2 > 12e6) return null;
  const gray2 = new Uint8Array(W2 * H2).fill(255);
  const src = ctx.gray;
  for (const s of strips) {
    const m = s.model, hint = { i: 0 };
    for (let a = 0; a < s.width; a++) {
      // per column: the two anchors bracketing a, then every row
      hint.i = hint.i || 0;
      const n = m.anchors.length;
      let i = hint.i;
      while (i < n - 2 && m.A[i + 1] < a) i++;
      hint.i = i;
      const t = clamp((a - m.A[i]) / Math.max(1e-6, m.A[i + 1] - m.A[i]), 0, 1);
      const an = m.anchors[i], bn = m.anchors[Math.min(n - 1, i + 1)];
      for (let r = 0; r < s.height; r++) {
        const b = s.bTop + r;
        const p = pointOnAnchor(an, m, b), q = pointOnAnchor(bn, m, b);
        const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
        let v = 255;
        if (x >= 0 && y >= 0 && x < w - 1 && y < h - 1) {
          const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, o = y0 * w + x0;
          v = (src[o] * (1 - fx) + src[o + 1] * fx) * (1 - fy) + (src[o + w] * (1 - fx) + src[o + w + 1] * fx) * fy;
        }
        gray2[(s.y0 + r) * W2 + a] = v;
      }
    }
  }
  // rectified → working → original
  const stripAt = (yy) => { let lo = 0, hi = strips.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (strips[mid].y0 <= yy) lo = mid; else hi = mid - 1; } return strips[lo]; };
  const toWork = (a, yy) => { const s = stripAt(yy); return mapPoint(s.model, a, yy - s.y0 + s.bTop, { i: 0 }); };
  const toOrig = (a, yy) => { const p = toWork(a, yy); return ctx.toOrig(p[0], p[1]); };
  const bboxToOrig = (b) => {
    const pts = [toOrig(b[0], b[1]), toOrig(b[0] + b[2], b[1]), toOrig(b[0], b[1] + b[3]), toOrig(b[0] + b[2], b[1] + b[3])];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [rnd(x0), rnd(y0), rnd(Math.max(...xs) - x0), rnd(Math.max(...ys) - y0)];
  };
  const sgray = gaussBlurX(gray2, W2, H2, 2.0);
  const fromOrig = makeInverse(strips, toOrig, ctx);
  const r = {
    ...ctx, w: W2, h: H2, gray: gray2, sgray, sp: SP, toOrig, toWork, fromOrig, bboxToOrig, rectified: true,
    strips: strips.map(s => ({ y0: s.y0, height: s.height, bTop: s.bTop, width: s.width, staffTops: Array.from({ length: s.model.J }, (_, j) => s.y0 - s.bTop + s.model.Y[j * 5]), tiltSamples: s.model.tilt.samples.length, tiltDeg: s.model.tilt.samples.map(q => +(Math.atan(q.tg) * 180 / Math.PI).toFixed(2)) })),
    parent: ctx,
  };
  // binarise with the parent's threshold (re-derived from the line darkness later)
  const bin = new Uint8Array(W2 * H2), staffBin = new Uint8Array(W2 * H2);
  for (let i = 0; i < bin.length; i++) { bin[i] = gray2[i] < ctx.threshold ? 1 : 0; staffBin[i] = sgray[i] < ctx.threshold ? 1 : 0; }
  r.bin = bin; r.staffBin = staffBin;
  const st = runStats(staffBin, W2, H2, 1);
  r.t = st.thickness;
  delete r.thin; delete r.cc;
  return r;
}

/** Forces the system grouping of staves found on the rectified image: one
 * system per strip (the strips were built from the first-pass systems). */
export function assignStripSystems(rctx, staves) {
  const out = [];
  for (const st of staves) {
    const xm = clamp(rnd((st.x0 + st.x1) / 2), 0, rctx.w - 1);
    const y = st.lines[2][xm];
    let k = rctx.strips.findIndex(s => y >= s.y0 && y < s.y0 + s.height);
    if (k < 0) continue;
    st.systemIndex = k;
    out.push(st);
  }
  out.sort((a, b) => a.systemIndex - b.systemIndex || a.top - b.top);
  out.forEach((s, i) => { s.index = i; });
  return out;
}

/** Numeric inverse of toOrig: original image point → rectified (a, y), or
 * null when the point is not inside any strip.  A coarse grid of forward
 * samples is hashed by original position; the nearest sample seeds a few
 * Newton steps.  Built lazily on first use (diagnostics / training only). */
function makeInverse(strips, toOrig, ctx) {
  let grid = null;
  const STEP = 6, CELL = 16;
  const build = () => {
    const pts = [];
    for (const s of strips) for (let yy = s.y0; yy < s.y0 + s.height; yy += STEP) for (let a = 0; a < s.width; a += STEP) { const p = toOrig(a, yy); pts.push(a, yy, p[0], p[1]); }
    const map = new Map();
    for (let i = 0; i < pts.length; i += 4) {
      const key = Math.floor(pts[i + 2] / CELL) * 100003 + Math.floor(pts[i + 3] / CELL);
      let arr = map.get(key); if (!arr) map.set(key, arr = []);
      arr.push(i);
    }
    grid = { pts, map };
  };
  return (X, Y) => {
    if (!grid) build();
    const { pts, map } = grid;
    const cx = Math.floor(X / CELL), cy = Math.floor(Y / CELL);
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = map.get((cx + dx) * 100003 + cy + dy);
      if (!arr) continue;
      for (const i of arr) { const d = (pts[i + 2] - X) ** 2 + (pts[i + 3] - Y) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    if (best < 0) return null;
    let a = pts[best], y = pts[best + 1];
    for (let it = 0; it < 4; it++) {
      const p = toOrig(a, y), pa = toOrig(a + 1, y), py = toOrig(a, y + 1);
      const j11 = pa[0] - p[0], j12 = py[0] - p[0], j21 = pa[1] - p[1], j22 = py[1] - p[1];
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-9) break;
      const ex = X - p[0], ey = Y - p[1];
      a += (j22 * ex - j12 * ey) / det; y += (-j21 * ex + j11 * ey) / det;
    }
    const p = toOrig(a, y);
    if (Math.hypot(p[0] - X, p[1] - Y) > 2) return null;
    return [a, y];
  };
}
