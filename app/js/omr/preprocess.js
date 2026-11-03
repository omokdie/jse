// JSE OMR — robust front end for photos and scans (replaces omr.js preprocess
// in recognize()).  Produces the same ctx contract:
//   { W, H, w, h, gray, bin, scale, angle, sp, t, threshold, toOrig, bboxToOrig }
// plus what later stages need: the illumination-normalised original (`norm`),
// paper / ink levels and the relative threshold `q` that was used.
//
// Differences from the original preprocess:
//  * staff space is estimated on several binarisations (from shape-faithful to
//    very permissive) and the one with the strongest 5-line periodicity wins —
//    blurred / low-contrast photos keep their faint staff lines;
//  * deskew searches ±15° (coarse → fine) instead of ±6°;
//  * proper anti-alias prefiltering when downscaling;
//  * the working threshold is relative to the measured paper / ink contrast,
//    and can be re-derived from the measured staff-line darkness
//    (rebinarize()) once staves are known.
import { clamp, toGray, boxDown, rankFilter, boxBlur, gaussBlur, gaussBlurX, histogram, percentile, otsu, runStats, thinMask, estimateSkew, estimateNoise } from './imgutil.js';

const TARGET_SP = 12;
const MAX_WORK_PIXELS = 7.5e6;
const rnd = Math.round;

/** Illumination normalisation: paper estimate = closing (max → min) + blur at
 * 1/4 resolution; returns grey scaled so that paper ≈ 255. */
export function normalizeIllumination(gray, W, H, radiusPx) {
  const f = 4;
  const small = boxDown(gray, W, H, f);
  const r = Math.max(2, Math.round(radiusPx / f));
  let bg = rankFilter(small.data, small.w, small.h, r, 1);
  bg = rankFilter(bg, small.w, small.h, r, -1);
  bg = boxBlur(bg, small.w, small.h, r);
  const norm = new Uint8Array(W * H);
  const sw = small.w, sh = small.h;
  for (let y = 0; y < H; y++) {
    // bilinear interpolation of the background between quarter-res samples
    const fy = clamp((y + 0.5) / f - 0.5, 0, sh - 1), y0 = Math.min(sh - 2, fy | 0), ty = fy - y0;
    const r0 = Math.max(0, y0) * sw, r1 = Math.min(sh - 1, y0 + 1) * sw;
    for (let x = 0; x < W; x++) {
      const fx = clamp((x + 0.5) / f - 0.5, 0, sw - 1), x0 = Math.min(sw - 2, fx | 0), tx = fx - x0;
      const xa = Math.max(0, x0), xb = Math.min(sw - 1, x0 + 1);
      const b = (bg[r0 + xa] * (1 - tx) + bg[r0 + xb] * tx) * (1 - ty) + (bg[r1 + xa] * (1 - tx) + bg[r1 + xb] * tx) * ty;
      const v = (gray[y * W + x] * 255) / Math.max(16, b);
      norm[y * W + x] = v > 255 ? 255 : v;
    }
  }
  return norm;
}

/** Paper (bright mode) and solid-ink (dark tail) levels of a normalised grey image. */
function levels(img, step) {
  const hist = histogram(img, step);
  const paper = percentile(hist, 0.6);              // most pixels are paper
  const ink = percentile(hist, 0.004);               // darkest 0.4 %: heads, beams, clefs
  return { paper: Math.max(paper, 120), ink: Math.min(ink, paper - 40), otsu: otsu(hist) };
}

/** Staff space + thickness from a set of relative thresholds q (fraction of
 * the paper→ink contrast below paper).  The spacing most thresholds agree on
 * wins (noise floods of over-permissive thresholds produce a different,
 * spurious period); among those, the cleanest periodicity (evidence × share²)
 * is chosen.  Returns all agreeing candidates, best first. */
function rankBinarisations(img, w, h, lv, qs) {
  const cands = [];
  for (const q of qs) {
    const thr = lv.paper - q * (lv.paper - lv.ink);
    const bin = new Uint8Array(w * h);
    let ink = 0;
    for (let i = 0; i < bin.length; i++) if (img[i] < thr) { bin[i] = 1; ink++; }
    if (ink > 0.7 * w * h) continue;                  // flooded
    const st = runStats(bin, w, h, 2);
    if (!(st.spacing >= 3)) continue;
    const evc = st.evidence / Math.max(1, st.columns);
    // noise floods of over-permissive thresholds raise the ink coverage and
    // can produce a period close to the staff space: penalise coverage growth
    const fr = ink / (w * h);
    cands.push({ q, thr, bin, st, score: evc * st.peakShare * st.peakShare / (1 + (fr / 0.12) ** 2), ink: fr });
  }
  if (!cands.length) return [];
  // consensus spacing: the candidate whose spacing has the largest share-weighted support
  let bestSup = -1, ref = null;
  for (const c of cands) {
    let sup = 0;
    for (const d of cands) if (Math.abs(d.st.spacing - c.st.spacing) <= 0.12 * c.st.spacing) sup += d.st.peakShare;
    if (sup > bestSup + 1e-9) { bestSup = sup; ref = c; }
  }
  const agree = cands.filter(d => Math.abs(d.st.spacing - ref.st.spacing) <= 0.12 * ref.st.spacing);
  agree.sort((a, b) => b.score - a.score);
  const rest = cands.filter(d => !agree.includes(d)).sort((a, b) => b.score - a.score);
  return [...agree, ...rest];
}

export function preprocessV2(image, options = {}) {
  const W = image.width, H = image.height;
  const grey0 = toGray(image);
  // --- first look: rough normalisation and staff space at coarse resolution -----
  let norm = normalizeIllumination(grey0, W, H, Math.max(W, H) / 70);
  const f1 = W * H > 2.5e6 ? (W * H > 10e6 ? 3 : 2) : 1;
  // staff analysis image: horizontally smoothed (staff lines are long and
  // horizontal; averaging along x suppresses noise but keeps their profile)
  const coarseOf = (img) => { const c = f1 > 1 ? boxDown(img, W, H, f1) : { data: img, w: W, h: H }; return { data: gaussBlurX(c.data, c.w, c.h, 1.5), w: c.w, h: c.h }; };
  let coarse = coarseOf(norm);
  let lv = levels(coarse.data, 3);
  const QS = [0.5, 0.35, 0.25, 0.17, 0.11, 0.07];
  let ranked = rankBinarisations(coarse.data, coarse.w, coarse.h, lv, QS);
  let bb = ranked[0] || null;
  let spFull = bb ? bb.st.spacing * f1 : Math.max(6, Math.min(W, H) / 80);
  // --- refine the normalisation radius from the staff space (≈ 2.5 sp) --------
  const radius = clamp(2.6 * spFull, 12, Math.max(W, H) / 20);
  norm = normalizeIllumination(grey0, W, H, radius);
  coarse = coarseOf(norm);
  lv = levels(coarse.data, 3);
  const ranked2 = rankBinarisations(coarse.data, coarse.w, coarse.h, lv, QS);
  if (ranked2.length) { ranked = ranked2; bb = ranked[0]; }
  if (bb) spFull = bb.st.spacing * f1;
  if (!(spFull >= 3)) spFull = Math.max(6, Math.min(W, H) / 80);
  const q = bb ? bb.q : 0.35;
  // --- working scale + skew ------------------------------------------------------------
  let scale = clamp(TARGET_SP / spFull, 0.1, 2.5);
  if (W * H * scale * scale > MAX_WORK_PIXELS) scale = Math.sqrt(MAX_WORK_PIXELS / (W * H));
  let angle = 0;
  if (!options.skipDeskew && bb) {
    const thin = thinMask(bb.bin, coarse.w, coarse.h, 2 * bb.st.thickness + 1);
    angle = estimateSkew(thin, coarse.w, coarse.h, 15);
  }
  // --- resample (rotate + scale) into the working canvas ---------------------------
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const w = Math.ceil((W * Math.abs(ca) + H * Math.abs(sa)) * scale), h = Math.ceil((W * Math.abs(sa) + H * Math.abs(ca)) * scale);
  const cx = W / 2, cy = H / 2, cwx = w / 2, cwy = h / 2;
  // anti-alias prefilter: integer box reduction, then a Gaussian for the rest
  const pf = Math.max(1, Math.floor(0.85 / scale));
  let src = pf > 1 ? boxDown(norm, W, H, pf) : { data: norm, w: W, h: H };
  const rem = scale * pf;                              // remaining scale factor (≤ ~1.2)
  if (rem < 0.8) src = { data: gaussBlur(src.data, src.w, src.h, 0.45 * Math.sqrt(1 / (rem * rem) - 1)), w: src.w, h: src.h };
  const work = new Uint8Array(w * h);
  const sd = src.data, sw = src.w, sh = src.h, po = (pf - 1) / 2;   // box-reduced pixel j is centred on pf·j + po
  for (let y = 0; y < h; y++) {
    const v = y - cwy;
    for (let x = 0; x < w; x++) {
      const u = x - cwx;
      const xo = (cx + (u * ca - v * sa) / scale - po) / pf, yo = (cy + (u * sa + v * ca) / scale - po) / pf;
      let val = 255;
      if (xo >= 0 && yo >= 0 && xo < sw - 1 && yo < sh - 1) {
        const x0 = xo | 0, y0 = yo | 0, fx = xo - x0, fy = yo - y0, o = y0 * sw + x0;
        val = (sd[o] * (1 - fx) + sd[o + 1] * fx) * (1 - fy) + (sd[o + sw] * (1 - fx) + sd[o + sw + 1] * fx) * fy;
      }
      work[y * w + x] = val;
    }
  }
  const wlv = levels(work, 2);
  const noise = estimateNoise(work, w, h, wlv.paper);
  // symbol image: mild isotropic denoising scaled to the measured noise
  const sigmaD = noise < 2.5 ? 0 : noise < 5 ? 0.7 : noise < 9 ? 0.95 : 1.2;
  const gray = sigmaD ? gaussBlur(work, w, h, sigmaD) : work;
  const thrW = rnd(wlv.paper - q * (wlv.paper - wlv.ink));
  // staff image: horizontal smoothing, used by detectStaves (ctx.staffBin)
  const sgray = gaussBlurX(gray, w, h, 2.0);
  const { bin, staffBin, st } = thresholdBoth(gray, sgray, w, h, thrW);
  const sp = st.spacing >= 3 && Math.abs(st.spacing - spFull * scale) < 0.25 * spFull * scale ? st.spacing : spFull * scale;
  const toOrig = (x, y) => { const u = x - cwx, v = y - cwy; return [cx + (u * ca - v * sa) / scale, cy + (u * sa + v * ca) / scale]; };
  const fromOrig = (X, Y) => { const u = (X - cx) * scale, v = (Y - cy) * scale; return [cwx + u * ca + v * sa, cwy - u * sa + v * ca]; };
  const bboxToOrig = (b) => {
    const pts = [toOrig(b[0], b[1]), toOrig(b[0] + b[2], b[1]), toOrig(b[0], b[1] + b[3]), toOrig(b[0] + b[2], b[1] + b[3])];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [rnd(x0), rnd(y0), rnd(Math.max(...xs) - x0), rnd(Math.max(...ys) - y0)];
  };
  return { W, H, w, h, gray, sgray, bin, staffBin, scale, angle, sp, t: st.thickness, threshold: thrW, q, paper: wlv.paper, ink: wlv.ink, noise,
    qAlternatives: ranked.slice(1).map(c => c.q).filter(v => v !== q), toOrig, fromOrig, bboxToOrig, norm };
}

function thresholdBoth(gray, sgray, w, h, thr) {
  const bin = new Uint8Array(w * h), staffBin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) { bin[i] = gray[i] < thr ? 1 : 0; staffBin[i] = sgray[i] < thr ? 1 : 0; }
  return { bin, staffBin, st: runStats(staffBin, w, h, 1) };
}

/** Re-threshold the working image with another relative level q (used when
 * no staff was found with the first choice). */
export function rethreshold(ctx, q) {
  const thr = rnd(ctx.paper - q * (ctx.paper - ctx.ink));
  const { bin, staffBin, st } = thresholdBoth(ctx.gray, ctx.sgray, ctx.w, ctx.h, thr);
  ctx.bin = bin; ctx.staffBin = staffBin; ctx.threshold = thr; ctx.q = q; ctx.t = st.thickness;
  if (st.spacing >= 3 && Math.abs(st.spacing - ctx.sp) < 0.25 * ctx.sp) ctx.sp = st.spacing;
}

/** Re-binarise the working image with a threshold derived from the measured
 * staff-line darkness: lines are captured at their half-maximum (FWHM), which
 * is shape-faithful for sharp images and line-preserving for blurred ones. */
export function measureLineContrast(ctx, staves) {
  const { gray, w, h } = ctx;
  const lineVals = [], paperVals = [];
  for (const st of staves) {
    const step = Math.max(2, rnd(ctx.sp / 3));
    for (let x = st.x0; x <= st.x1; x += step) {
      for (let k = 0; k < 5; k++) {
        const y = rnd(st.lines[k][x]);
        let m = 255;
        for (let d = -1; d <= 1; d++) { const yy = y + d; if (yy >= 0 && yy < h) m = Math.min(m, gray[yy * w + x]); }
        lineVals.push(m);
        if (k < 4) { const ym = rnd((st.lines[k][x] + st.lines[k + 1][x]) / 2); if (ym >= 0 && ym < h) paperVals.push(gray[ym * w + x]); }
      }
    }
  }
  if (lineVals.length < 20) return null;
  lineVals.sort((a, b) => a - b); paperVals.sort((a, b) => a - b);
  // lines crossed by symbols are darker: use the 65th percentile (bare line);
  // paper between lines: the 75th percentile (spaces often hold heads)
  return { line: lineVals[Math.floor(lineVals.length * 0.65)], paper: paperVals[Math.floor(paperVals.length * 0.75)] };
}

export function rebinarize(ctx, staves, frac = 0.5) {
  const lc = measureLineContrast(ctx, staves);
  if (!lc) return false;
  const thr = rnd(lc.paper - frac * (lc.paper - lc.line));
  const { gray, w, h } = ctx;
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < thr ? 1 : 0;
  if (ctx.sgray) { const sb = new Uint8Array(w * h); for (let i = 0; i < sb.length; i++) sb[i] = ctx.sgray[i] < thr ? 1 : 0; ctx.staffBin = sb; }
  const st = runStats(ctx.staffBin || bin, w, h, 1);
  ctx.bin = bin; ctx.threshold = thr; ctx.t = st.thickness; ctx.lineLevel = lc.line; ctx.paperLevel = lc.paper;
  if (st.spacing >= 3 && Math.abs(st.spacing - ctx.sp) < 0.2 * ctx.sp) ctx.sp = st.spacing;
  return true;
}
