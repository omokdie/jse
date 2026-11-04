// JSE OMR — heuristic optical music recognition for printed scores.
// Pure JS (typed arrays only): runs in a Web Worker and in Node (see SPEC §4).
//
// Pipeline: preprocess (grey → illumination normalisation → threshold → deskew)
//   → detectStaves (run-length statistics, banded projections, line tracking)
//   → removeStaffLines → segmentSymbols (stems, note heads, components)
//   → classify (clef/key/time, durations, pitches, rests, accidentals, ties)
//   → assemble (barlines → measures → ScoreDoc with source boxes).
// All geometry inside the pipeline is in *working* pixels (staff space ≈ 12 px);
// `ctx.toOrig` maps back to original image coordinates for the result.

import {
  createScore, createPart, createMeasure, makeNote, makeRest, padVoiceWithRests,
  noteAtStaffPosition, measureCapacity, newId, validateScore, durTicks, keyAlter, DUR_TICKS,
} from '../model/score.js';
import { TEMPLATES } from './templates.js';
import { buildTrace } from './trace.js';
import { frontEnd } from './frontend.js';
import { detectBarlinesV2 } from './barlines.js';
import { learnedHeads, wholeNoteEvents, inkLevels } from './heads.js';
import { makeGlyphHook } from './glyphs.js';
import { learnedBeamCount, N_RFEAT } from './rhythm.js';
import { loadModel, predict as mlpPredict } from './classifiers.js';
import { runLyricStage } from './lyrics.js';

export const OMR_VERSION = '1.0.0';
const TARGET_SP = 12;                 // working staff space in px
const MAX_WORK_PIXELS = 6.5e6;

// ---------------------------------------------------------------------------
// small image helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rnd = Math.round;

function toGray(image) {
  const { width: w, height: h, data } = image;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    let v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    const a = data[j + 3];
    if (a < 255) v = (v * a + 255 * (255 - a)) / 255;   // transparent → paper
    g[i] = v;
  }
  return g;
}

function boxDown(src, w, h, f) {
  const dw = Math.max(1, Math.floor(w / f)), dh = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(dw * dh);
  const inv = 1 / (f * f);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0;
    for (let yy = 0; yy < f; yy++) { let o = (y * f + yy) * w + x * f; for (let xx = 0; xx < f; xx++) s += src[o++]; }
    out[y * dw + x] = s * inv;
  }
  return { data: out, w: dw, h: dh };
}

/** Separable sliding-window max (sign=1) or min (sign=-1) filter, radius r. */
function rankFilter(src, w, h, r, sign) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = sign > 0 ? 0 : 255;
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) { const v = src[row + k]; if (sign > 0 ? v > m : v < m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = sign > 0 ? 0 : 255;
    for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) { const v = tmp[k * w + x]; if (sign > 0 ? v > m : v < m) m = v; }
    out[y * w + x] = m;
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0, row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[row + x] = s / (2 * r + 1); s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / (2 * r + 1); s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
  }
  return out;
}

function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Vertical run-length statistics of a binary image: line thickness and
 * staff spacing (mode of the line-to-line period). Columns are subsampled. */
function runStats(bin, w, h, step = 2, maxRun = 160) {
  const black = new Float64Array(maxRun + 1), period = new Float64Array(maxRun + 1);
  const runs = [];
  for (let x = 0; x < w; x += step) {
    runs.length = 0;
    let y = 0;
    while (y < h) {
      const v = bin[y * w + x]; let y2 = y;
      while (y2 < h && bin[y2 * w + x] === v) y2++;
      runs.push(v ? (y2 - y) : -(y2 - y));
      y = y2;
    }
    for (let i = 0; i < runs.length; i++) if (runs[i] > 0 && runs[i] <= maxRun) black[runs[i]]++;
    runs.forEach((r, i) => { if (r > 0 && i + 2 < runs.length && runs[i + 2] > 0) { const p = r - runs[i + 1]; if (p <= maxRun) period[p] += 1; } });
  }
  let t = 1; for (let i = 1; i <= maxRun; i++) if (black[i] > black[t]) t = i;
  // period histogram restricted to thin black runs is computed again below with t known
  const period2 = new Float64Array(maxRun + 1);
  for (let x = 0; x < w; x += step) {
    runs.length = 0;
    let y = 0;
    while (y < h) {
      const v = bin[y * w + x]; let y2 = y;
      while (y2 < h && bin[y2 * w + x] === v) y2++;
      runs.push(v ? (y2 - y) : -(y2 - y));
      y = y2;
    }
    for (let i = 0; i + 2 < runs.length; i++) {
      const a = runs[i], g = runs[i + 1], b = runs[i + 2];
      if (a > 0 && a <= 2 * t + 1 && b > 0 && b <= 2 * t + 1 && g < 0) { const p = a - g; if (p >= 3 && p <= maxRun) period2[p] += 1; }
    }
  }
  let sp = 0, bestP = 0;
  for (let p = 3; p <= maxRun; p++) { const v = period2[p] + 0.5 * (period2[p - 1] || 0) + 0.5 * (period2[p + 1] || 0); if (v > bestP) { bestP = v; sp = p; } }
  // refine with the weighted mean around the peak
  if (sp) { let s = 0, c = 0; for (let p = sp - 1; p <= sp + 1; p++) if (p > 0 && p <= maxRun) { s += p * period2[p]; c += period2[p]; } if (c) sp = s / c; }
  return { thickness: t, spacing: sp || 0, evidence: bestP };
}

/** Mask of "thin horizontal" ink: pixels whose vertical black run ≤ maxRun. */
function thinMask(bin, w, h, maxRun) {
  const m = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!bin[y * w + x]) { y++; continue; }
      let y2 = y; while (y2 < h && bin[y2 * w + x]) y2++;
      if (y2 - y <= maxRun) for (let k = y; k < y2; k++) m[k * w + x] = 1;
      y = y2;
    }
  }
  return m;
}

/** Skew angle (radians) maximising the sharpness of the row projection of
 * thin-horizontal pixels; coarse-to-fine search within ±maxDeg. */
function estimateSkew(thin, w, h, maxDeg = 6) {
  const xs = [], ys = [];
  const stride = Math.max(1, Math.floor((w * h) / 2.5e6));
  for (let i = 0; i < w * h; i += stride) if (thin[i]) { xs.push(i % w - w / 2); ys.push(Math.floor(i / w) - h / 2); }
  if (xs.length < 200) return 0;
  const n = xs.length, diag = Math.hypot(w, h), hist = new Float64Array(Math.ceil(diag) + 2);
  const score = (a) => {
    hist.fill(0);
    const c = Math.cos(a), s = Math.sin(a), off = diag / 2;
    for (let i = 0; i < n; i++) hist[(ys[i] * c - xs[i] * s + off) | 0]++;
    let v = 0; for (let i = 0; i < hist.length; i++) v += hist[i] * hist[i];
    return v;
  };
  let best = 0, bestV = -1;
  const deg = Math.PI / 180;
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += 0.4) { const v = score(a * deg); if (v > bestV) { bestV = v; best = a; } }
  let fine = best;
  for (let a = best - 0.4; a <= best + 0.4 + 1e-9; a += 0.05) { const v = score(a * deg); if (v > bestV) { bestV = v; fine = a; } }
  return fine * deg;
}

// ---------------------------------------------------------------------------
// Stage 1: preprocess
// ---------------------------------------------------------------------------
/** @returns ctx: { W, H, w, h, gray, bin, scale, angle, sp, t, toOrig(x,y), bboxToOrig([x,y,w,h]) } */
export function preprocess(image, options = {}) {
  const W = image.width, H = image.height;
  const gray = toGray(image);
  // Illumination: paper estimate = closing (max→min) then blur at 1/4 resolution.
  const f = 4;
  const small = boxDown(gray, W, H, f);
  const r = Math.max(3, Math.round(W / f / 80));
  let bg = rankFilter(small.data, small.w, small.h, r, 1);
  bg = rankFilter(bg, small.w, small.h, r, -1);
  bg = boxBlur(bg, small.w, small.h, r);
  const norm = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(small.h - 1, y / f) | 0;
    for (let x = 0; x < W; x++) {
      const b = Math.max(16, bg[sy * small.w + Math.min(small.w - 1, (x / f) | 0)]);
      const v = Math.min(255, (gray[y * W + x] * 255) / b) | 0;
      norm[y * W + x] = v; hist[v]++;
    }
  }
  const thr0 = clamp(otsu(hist, W * H), 40, 210);
  // Coarse binarisation at reduced resolution to measure the staff space.
  const f1 = W * H > 3e6 ? 2 : 1;
  const coarse = f1 > 1 ? boxDown(norm, W, H, f1) : { data: norm, w: W, h: H };
  const cbin = new Uint8Array(coarse.w * coarse.h);
  for (let i = 0; i < cbin.length; i++) cbin[i] = coarse.data[i] < thr0 ? 1 : 0;
  const st0 = runStats(cbin, coarse.w, coarse.h, 2);
  let spFull = st0.spacing * f1;
  if (!(spFull >= 3)) spFull = Math.max(6, Math.min(W, H) / 80);   // fallback guess
  // Working scale: staff space ≈ TARGET_SP, capped by memory; never above 2×.
  let scale = clamp(TARGET_SP / spFull, 0.1, 2);
  if (W * H * scale * scale > MAX_WORK_PIXELS) scale = Math.sqrt(MAX_WORK_PIXELS / (W * H));
  // Skew estimate on the thin-line mask of the coarse image.
  const thin = thinMask(cbin, coarse.w, coarse.h, 2 * st0.thickness + 1);
  const angle = options.skipDeskew ? 0 : estimateSkew(thin, coarse.w, coarse.h, 6);
  // Resample (rotate + scale) the normalised grey into the working canvas.
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const w = Math.ceil((W * Math.abs(ca) + H * Math.abs(sa)) * scale), h = Math.ceil((W * Math.abs(sa) + H * Math.abs(ca)) * scale);
  const cx = W / 2, cy = H / 2, cwx = w / 2, cwy = h / 2;
  // pre-filter for downscaling to avoid dropping 1-px lines
  const pf = Math.max(1, Math.floor(1 / scale));
  const src = pf > 1 ? boxDown(norm, W, H, pf) : { data: norm, w: W, h: H };
  const s2 = scale * pf;
  const work = new Uint8Array(w * h);
  const whist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const v = y - cwy;
    for (let x = 0; x < w; x++) {
      const u = x - cwx;
      const xo = (cx + (u * ca - v * sa) / scale) / pf, yo = (cy + (u * sa + v * ca) / scale) / pf;
      let val = 255;
      if (xo >= 0 && yo >= 0 && xo < src.w - 1 && yo < src.h - 1) {
        const x0 = xo | 0, y0 = yo | 0, fx = xo - x0, fy = yo - y0, o = y0 * src.w + x0;
        val = (src.data[o] * (1 - fx) + src.data[o + 1] * fx) * (1 - fy) + (src.data[o + src.w] * (1 - fx) + src.data[o + src.w + 1] * fx) * fy;
      }
      work[y * w + x] = val; whist[val | 0]++;
    }
  }
  void s2;
  // Threshold biased towards paper (≥ 28 % ink coverage counts) so that thin
  // lines and accidental stems survive resampling; strokes get ~1 px fatter,
  // which the size thresholds below account for.
  const thrW = clamp(Math.max(otsu(whist, w * h), 184), 60, 215);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = work[i] < thrW ? 1 : 0;
  const st = runStats(bin, w, h, 1);
  const sp = st.spacing >= 3 ? st.spacing : spFull * scale;
  const toOrig = (x, y) => { const u = x - cwx, v = y - cwy; return [cx + (u * ca - v * sa) / scale, cy + (u * sa + v * ca) / scale]; };
  const bboxToOrig = (b) => {
    const pts = [toOrig(b[0], b[1]), toOrig(b[0] + b[2], b[1]), toOrig(b[0], b[1] + b[3]), toOrig(b[0] + b[2], b[1] + b[3])];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [rnd(x0), rnd(y0), rnd(Math.max(...xs) - x0), rnd(Math.max(...ys) - y0)];
  };
  return { W, H, w, h, gray: work, bin, scale, angle, sp, t: st.thickness, threshold: thrW, toOrig, bboxToOrig };
}

// ---------------------------------------------------------------------------
// Stage 2: staff detection
// ---------------------------------------------------------------------------
/** Finds 5-line groups in the row projection of a column band. */
function linesInBand(thin, w, h, x0, x1, t) {
  const proj = new Float32Array(h);
  for (let y = 0; y < h; y++) { let s = 0, o = y * w; for (let x = x0; x < x1; x++) s += thin[o + x]; proj[y] = s; }
  const bw = x1 - x0, thr = 0.38 * bw;
  const lines = [];
  let y = 0;
  while (y < h) {
    if (proj[y] < thr) { y++; continue; }
    let y2 = y, sw = 0, sy = 0;
    while (y2 < h && proj[y2] >= thr) { sw += proj[y2]; sy += proj[y2] * y2; y2++; }
    if (y2 - y <= 3 * t + 2) lines.push({ y: sy / sw, th: y2 - y, w: sw / (y2 - y) / bw });
    y = y2;
  }
  return lines;
}

function groupStaves(lines, sp) {
  const out = [];
  let i = 0;
  while (i + 4 < lines.length) {
    const ys = lines.slice(i, i + 5).map(l => l.y);
    const gaps = [1, 2, 3, 4].map(k => ys[k] - ys[k - 1]);
    const m = (ys[4] - ys[0]) / 4;
    const ok = m > 0.55 * sp && m < 1.8 * sp && gaps.every(g => g > 0.72 * m && g < 1.28 * m);
    if (ok) { out.push({ ys, spacing: m }); i += 5; } else i++;
  }
  return out;
}

/** Follows the five lines of a staff column by column. The staff is tracked
 * as a rigid comb (top y + spacing): every column measures the centre of the
 * thin ink run near each predicted line, the median deviation shifts the comb
 * and the outer lines adjust the spacing very slowly (perspective). Lines never
 * drift individually, so a tie/beam near one line cannot pull it away. */
function trackStaff(bin, w, h, t, startX, ys0, sp) {
  const lines = ys0.map(() => new Float32Array(w));
  const hits = new Uint8Array(w);
  const thinMax = 2 * t + 2, r = Math.max(2, Math.round(0.3 * sp));
  const measure = (x, py) => {
    const yc = rnd(py);
    for (let d = 0; d <= r; d++) for (const y of d ? [yc - d, yc + d] : [yc]) {
      if (y < 0 || y >= h || !bin[y * w + x]) continue;
      let a = y, b = y;
      while (a > 0 && bin[(a - 1) * w + x]) a--;
      while (b < h - 1 && bin[(b + 1) * w + x]) b++;
      if (b - a + 1 <= thinMax) return (a + b) / 2;
      return null;   // thick run: a symbol covers the line here
    }
    return null;
  };
  const run = (dir) => {
    let y0 = ys0[0], gap = (ys0[4] - ys0[0]) / 4;
    for (let x = startX; x >= 0 && x < w; x += dir) {
      const pred = [0, 1, 2, 3, 4].map(i => y0 + i * gap);
      const meas = pred.map(py => measure(x, py));
      const devs = meas.map((m, i) => m == null ? null : m - pred[i]).filter(v => v != null).sort((a, b) => a - b);
      if (devs.length >= 2) {
        const off = devs[devs.length >> 1];
        if (Math.abs(off) < 0.3 * sp) y0 += off * 0.5;
        if (meas[0] != null && meas[4] != null) { const g = (meas[4] - meas[0]) / 4; if (Math.abs(g - gap) < 0.15 * sp) gap += 0.03 * (g - gap); }
      }
      hits[x] = devs.length;
      for (let i = 0; i < 5; i++) lines[i][x] = y0 + i * gap;
    }
  };
  run(1); run(-1);
  // Horizontal extent: columns where a 3 sp window has on average ≥ 2 line hits.
  const win = Math.max(3, rnd(3 * sp));
  const sm = new Float32Array(w);
  let s = 0;
  for (let x = 0; x < w; x++) { s += hits[x]; if (x >= win) s -= hits[x - win]; sm[x] = s / Math.min(win, x + 1); }
  let bestL = -1, bestR = -1, curL = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && sm[Math.min(w - 1, x + (win >> 1))] >= 2.0;
    if (on && curL < 0) curL = x;
    if (!on && curL >= 0) { if (bestL < 0 || x - curL > bestR - bestL) { bestL = curL; bestR = x; } curL = -1; }
  }
  if (bestL < 0) return null;
  let x0 = bestL, x1 = bestR - 1;
  while (x0 < x1 && hits[x0] < 2) x0++;
  while (x1 > x0 && hits[x1] < 2) x1--;
  return { lines, hits, x0, x1 };
}

export function detectStaves(ctx, options = {}) {
  const { w, h, t, sp } = ctx;
  const bin = ctx.staffBin || ctx.bin;   // horizontally smoothed binary when available (preprocess.js)
  const thin = thinMask(bin, w, h, 2 * t + 1);
  ctx.thin = thin;
  const nb = clamp(Math.floor(w / (8 * sp)), 3, 16), bw = w / nb;
  const perBand = [];
  for (let b = 0; b < nb; b++) perBand.push(groupStaves(linesInBand(thin, w, h, rnd(b * bw), rnd((b + 1) * bw), t), sp));
  // Cluster staff candidates across bands by their top/bottom line positions.
  const clusters = [];
  perBand.forEach((cands, b) => cands.forEach(c => {
    const top = c.ys[0], bot = c.ys[4];
    let best = null, bd = 0.6 * sp;
    for (const cl of clusters) {
      const last = cl.members[cl.members.length - 1];
      if (b - last.b > 3) continue;
      const d = Math.max(Math.abs(last.top - top), Math.abs(last.bot - bot));
      if (d < bd) { bd = d; best = cl; }
    }
    if (best) best.members.push({ b, top, bot, ys: c.ys }); else clusters.push({ members: [{ b, top, bot, ys: c.ys }] });
  }));
  const minMembers = Math.max(2, Math.ceil(nb * 0.2));
  const staves = [];
  for (const cl of clusters) {
    if (cl.members.length < minMembers) continue;
    const mid = cl.members[cl.members.length >> 1];
    const tr = trackStaff(bin, w, h, t, rnd((mid.b + 0.5) * bw), mid.ys, sp);
    if (!tr || tr.x1 - tr.x0 < 6 * sp) continue;
    const xc = (tr.x0 + tr.x1) >> 1;
    const spacing = (tr.lines[4][xc] - tr.lines[0][xc]) / 4;
    const st = { lines: tr.lines, hits: tr.hits, x0: tr.x0, x1: tr.x1, spacing, top: tr.lines[0][xc], bottom: tr.lines[4][xc] };
    // merge duplicates (same staff found from two clusters)
    if (staves.some(o => Math.abs(o.top - st.top) < 0.7 * sp && Math.abs(o.bottom - st.bottom) < 0.7 * sp)) continue;
    staves.push(st);
  }
  staves.sort((a, b) => a.top - b.top);
  // Systems: consecutive staves joined by a vertical ink run (system barline /
  // brace) at the left edge, or forced by options.
  const sysOf = new Array(staves.length).fill(0);
  let sys = 0;
  for (let i = 1; i < staves.length; i++) {
    const a = staves[i - 1], b = staves[i];
    let joined;
    if (options.parts === 1) joined = false;
    else if (options.parts === 2 || options.assumeGrandStaff) joined = (sysOf[i - 1] === sys && countStavesIn(sysOf, sys) % 2 === 1);
    else joined = b.top - a.bottom < 14 * sp && Math.abs(a.x0 - b.x0) < 3 * sp && leftConnector(bin, w, h, a, b, sp);
    if (!joined) sys++;
    sysOf[i] = sys;
  }
  staves.forEach((s, i) => { s.systemIndex = sysOf[i]; s.index = i; });
  return staves;
}
function countStavesIn(sysOf, s) { let n = 0; for (const v of sysOf) if (v === s) n++; return n; }

function leftConnector(bin, w, h, a, b, sp) {
  const xl = Math.max(0, rnd(Math.min(a.x0, b.x0) - 1.6 * sp)), xr = Math.min(w - 1, rnd(Math.max(a.x0, b.x0) + 1.6 * sp));
  const y0 = rnd(a.bottom + 2), y1 = rnd(b.top - 2);
  if (y1 - y0 < 2) return true;
  for (let x = xl; x <= xr; x++) {
    let c = 0;
    for (let y = y0; y <= y1; y++) if (bin[y * w + x] || (x > 0 && bin[y * w + x - 1]) || (x < w - 1 && bin[y * w + x + 1])) c++;
    if (c >= 0.85 * (y1 - y0 + 1)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 3: staff line removal
// ---------------------------------------------------------------------------
/** Two passes per line: erase vertical runs that are just the line (≤ t+2),
 * then erase long thin remnants (where the line was slightly thicker) so
 * symbols are not glued together horizontally. Symbols crossing a line keep
 * their pixels because the run there is much longer than the line. */
export function removeStaffLines(ctx, staves) {
  const { bin, w, h, t, sp } = ctx;
  const out = new Uint8Array(bin);
  // pass 1 erases runs that can only be the line itself; slightly thicker runs
  // (line + tangent arc of a hollow head, or a locally thick line) are erased
  // only when they persist horizontally for ≥ 1 sp. Beams (≥ 0.45 sp) are
  // always above remMax so a beam lying on a line survives.
  const thinMax = t + 1, remMax = Math.min(2 * t + 1, Math.max(thinMax + 1, Math.round(0.33 * sp)));
  const runAt = (x, y) => {
    let yc = -1;
    for (const d of [0, -1, 1, -2, 2]) { const yy = y + d; if (yy >= 0 && yy < h && bin[yy * w + x]) { yc = yy; break; } }
    if (yc < 0) return null;
    let a = yc, b = yc;
    while (a > 0 && bin[(a - 1) * w + x]) a--;
    while (b < h - 1 && bin[(b + 1) * w + x]) b++;
    return [a, b];
  };
  for (const st of staves) {
    const xa = Math.max(0, rnd(st.x0 - 2 * sp)), xb = Math.min(w - 1, rnd(st.x1 + 2 * sp));
    for (let i = 0; i < 5; i++) {
      const ly = st.lines[i];
      const thinRun = new Int8Array(w);   // 1 = thin-ish remnant still present after pass 1
      for (let x = xa; x <= xb; x++) {
        const r = runAt(x, rnd(ly[x]));
        if (!r) continue;
        const len = r[1] - r[0] + 1;
        if (len <= thinMax) { for (let y = r[0]; y <= r[1]; y++) out[y * w + x] = 0; }
        else if (len <= remMax) thinRun[x] = 1;
      }
      // pass 2: long horizontal stretches of slightly-thick runs are line remnants
      const minLen = rnd(1.0 * sp);
      let x = xa;
      while (x <= xb) {
        if (!thinRun[x]) { x++; continue; }
        let x2 = x; while (x2 <= xb && thinRun[x2]) x2++;
        if (x2 - x >= minLen) for (let xx = x; xx < x2; xx++) { const r = runAt(xx, rnd(ly[xx])); if (r) for (let y = r[0]; y <= r[1]; y++) out[y * w + xx] = 0; }
        x = x2;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// connected components, morphology, templates
// ---------------------------------------------------------------------------
function labelComponents(img, w, h) {
  const labels = new Int32Array(w * h);
  let parent = new Int32Array(1024); let n = 0;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const newLabel = () => { n++; if (n >= parent.length) { const p = new Int32Array(parent.length * 2); p.set(parent); parent = p; } parent[n] = n; return n; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!img[i]) continue;
    let l = 0;
    const cand = [];
    if (x > 0 && labels[i - 1]) cand.push(labels[i - 1]);
    if (y > 0) { if (labels[i - w]) cand.push(labels[i - w]); if (x > 0 && labels[i - w - 1]) cand.push(labels[i - w - 1]); if (x < w - 1 && labels[i - w + 1]) cand.push(labels[i - w + 1]); }
    if (!cand.length) l = newLabel(); else { l = cand[0]; for (let k = 1; k < cand.length; k++) union(l, cand[k]); }
    labels[i] = l;
  }
  const map = new Int32Array(n + 1); let m = 0;
  for (let i = 1; i <= n; i++) if (find(i) === i) map[i] = ++m;
  const comps = [];
  for (let i = 0; i <= m; i++) comps.push(null);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!labels[i]) continue;
    const l = map[find(labels[i])]; labels[i] = l;
    let c = comps[l];
    if (!c) c = comps[l] = { id: l, x0: x, y0: y, x1: x, y1: y, area: 0, sx: 0, sy: 0 };
    if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y > c.y1) c.y1 = y;
    c.area++; c.sx += x; c.sy += y;
  }
  for (const c of comps) if (c) { c.cx = c.sx / c.area; c.cy = c.sy / c.area; c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; }
  return { labels, comps };
}

/** Binary opening with a wE×hE box (erode then dilate), returns a new image. */
function openBox(img, w, h, wE, hE) {
  const rx = wE >> 1, ry = hE >> 1;
  const er = new Uint8Array(w * h), tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  // erosion (separable AND)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ok = x - rx >= 0 && x + rx < w;
    for (let k = -rx; ok && k <= rx; k++) if (!img[y * w + x + k]) ok = false;
    tmp[y * w + x] = ok ? 1 : 0;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let ok = y - ry >= 0 && y + ry < h;
    for (let k = -ry; ok && k <= ry; k++) if (!tmp[(y + k) * w + x]) ok = false;
    er[y * w + x] = ok ? 1 : 0;
  }
  // dilation
  tmp.fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (er[y * w + x]) for (let k = -rx; k <= rx; k++) { const xx = x + k; if (xx >= 0 && xx < w) tmp[y * w + xx] = 1; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (tmp[y * w + x]) for (let k = -ry; k <= ry; k++) { const yy = y + k; if (yy >= 0 && yy < h) out[yy * w + x] = 1; }
  return out;
}

const tplCache = new Map();
function template(name) {
  let t = tplCache.get(name);
  if (t) return t;
  const d = TEMPLATES[name];
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(d.bits), c => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(d.bits, 'base64'));
  const rowBytes = Math.ceil(d.w / 8);
  const mask = new Uint8Array(d.w * d.h);
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) mask[y * d.w + x] = (bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  t = { w: d.w, h: d.h, wsp: d.wsp, hsp: d.hsp, mask };
  tplCache.set(name, t);
  return t;
}

/** IoU between a component's mask (bbox-normalised) and a template. */
function matchTemplate(labels, w, comp, tpl) {
  let inter = 0, uni = 0;
  const sx = comp.w / tpl.w, sy = comp.h / tpl.h;
  for (let ty = 0; ty < tpl.h; ty++) for (let tx = 0; tx < tpl.w; tx++) {
    // area-sample the component over the template cell
    const xa = comp.x0 + Math.floor(tx * sx), xb = comp.x0 + Math.max(Math.floor(tx * sx) + 1, Math.floor((tx + 1) * sx));
    const ya = comp.y0 + Math.floor(ty * sy), yb = comp.y0 + Math.max(Math.floor(ty * sy) + 1, Math.floor((ty + 1) * sy));
    let c = 0, n = 0;
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { n++; if (labels[y * w + x] === comp.id) c++; }
    const a = c * 2 >= n ? 1 : 0, b = tpl.mask[ty * tpl.w + tx];
    if (a && b) inter++; if (a || b) uni++;
  }
  return uni ? inter / uni : 0;
}

// learned component classifier (glyphs.js), active during classify() when its model is loaded
let glyphHook = null;
function bestTemplate(labels, w, comp, names, sp, sizeTol = 0.3) {
  if (glyphHook) return glyphHook(comp, names);
  let best = null;
  for (const name of names) {
    const tpl = template(name);
    const hr = comp.h / (tpl.hsp * sp), wr = comp.w / (tpl.wsp * sp);
    if (hr < 1 - sizeTol || hr > 1 + sizeTol) continue;
    let s = matchTemplate(labels, w, comp, tpl);
    s *= 1 - 0.5 * Math.min(1, Math.abs(Math.log(wr / 1)) + Math.abs(Math.log(hr)));
    if (!best || s > best.score) best = { name, score: s };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stage 4: symbol segmentation (primitives)
// ---------------------------------------------------------------------------
/** Vertical ink runs ≥ minLen grouped into thin vertical objects (stems/barlines). */
function findVerticalObjects(img, w, h, minLen, maxWidth) {
  const runs = [];
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!img[y * w + x]) { y++; continue; }
      let y2 = y; while (y2 < h && img[y2 * w + x]) y2++;
      if (y2 - y >= minLen) runs.push({ x, y0: y, y1: y2 - 1 });
      y = y2;
    }
  }
  const objs = [];
  let open = [];
  for (const r of runs) {
    let hit = null;
    for (const o of open) {
      if (o.xLast !== r.x - 1 && o.xLast !== r.x) continue;
      // neighbouring columns belong to the same object only when their runs
      // have nearly the same extent (a stacked chord's flank next to a stem
      // is much shorter than the stem and must stay separate)
      const ov = Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0);
      if (ov > 0.8 * Math.max(o.y1 - o.y0, r.y1 - r.y0)) { hit = o; break; }
    }
    if (hit) { hit.xLast = r.x; hit.x1 = r.x; hit.y0 = Math.min(hit.y0, r.y0); hit.y1 = Math.max(hit.y1, r.y1); hit.n++; }
    else { const o = { x0: r.x, x1: r.x, xLast: r.x, y0: r.y0, y1: r.y1, n: 1 }; open.push(o); objs.push(o); }
    open = open.filter(o => o.xLast >= r.x - 1);
  }
  return objs.filter(o => o.x1 - o.x0 + 1 <= maxWidth).map(o => ({ x: (o.x0 + o.x1) / 2, x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y1, width: o.x1 - o.x0 + 1 }));
}

function staffOf(staves, y, sp) {
  let best = null, bd = Infinity;
  for (const st of staves) {
    const d = y < st.top ? st.top - y : y > st.bottom ? y - st.bottom : 0;
    if (d < bd) { bd = d; best = st; }
  }
  return bd <= 7 * sp ? best : null;
}

function ellipseInk(img, w, h, cx, cy, ax, ay, eMin, eMax, skipX = null, skipR = 0, skipRow = null) {
  let n = 0, c = 0;
  const x0 = Math.max(0, Math.floor(cx - ax * eMax)), x1 = Math.min(w - 1, Math.ceil(cx + ax * eMax));
  const y0 = Math.max(0, Math.floor(cy - ay * eMax)), y1 = Math.min(h - 1, Math.ceil(cy + ay * eMax));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (skipX != null && Math.abs(x - skipX) <= skipR) continue;
    if (skipRow && skipRow(y)) continue;
    const dx = (x - cx) / ax, dy = (y - cy) / ay, e = Math.sqrt(dx * dx + dy * dy);
    if (e < eMin || e > eMax) continue;
    n++; if (img[y * w + x]) c++;
  }
  return n ? c / n : 0;
}

/** Hollow (half/whole) head evidence: ink ring around a white core. */
function hollowScore(ctx, nolines, cx, cy, ax, stemX = null, staff = null) {
  const { bin, w, h, sp, t } = ctx;
  const ay = 0.53 * sp;
  const ring = ellipseInk(bin, w, h, cx, cy, ax, ay, 0.62, 1.0);
  // the core is judged outside the staff-line bands: where a line is tangent
  // to the hole, line + arc remnants would otherwise fill the tiny hole
  let skipRow = null;
  if (staff) {
    const xi = clamp(rnd(cx), 0, w - 1), ys = staff.lines.map(l => l[xi]);
    skipRow = (y) => ys.some(ly => Math.abs(y - ly) <= t + 0.5);
  }
  const core = ellipseInk(nolines, w, h, cx, cy, ax, ay, 0, 0.34, null, 0, skipRow);
  const outside = ellipseInk(nolines, w, h, cx, cy, ax, ay, 1.2, 1.55, stemX, 0.2 * sp);
  return { score: ring - core - outside, ring, core, outside };
}

export function segmentSymbols(ctx, staves, nolines) {
  const { w, h, sp, t } = ctx;
  const cc = labelComponents(nolines, w, h);
  // --- filled note heads: box opening keeps only blobs ≥ 0.4×0.6 sp -------
  const opened = openBox(nolines, w, h, Math.max(3, rnd(0.4 * sp)), Math.max(3, rnd(0.6 * sp)));
  const oc = labelComponents(opened, w, h);
  const heads = [];
  for (const c of oc.comps) {
    if (!c) continue;
    const wsp = c.w / sp, hsp = c.h / sp;
    if (wsp < 0.8 || hsp < 0.7 || hsp > 4.5 || wsp > 4.2) continue;
    if (hsp < 1.45 && wsp > 1.9) continue;                 // flat and long: a beam fragment
    const fill = c.area / (c.w * c.h);
    if (fill < 0.45) continue;
    const st = staffOf(staves, c.cy, sp);
    if (!st) continue;
    // split clusters (chords in seconds / stacked heads) on a grid of centres
    const nRows = Math.max(1, Math.min(4, Math.round((hsp - 0.1) / 1.0 + 0.001)));
    const nCols = wsp > 1.9 ? 2 : 1;
    if (nRows === 1 && nCols === 1) {
      if (!isolatedBlob(nolines, w, h, c, sp)) continue;      // part of a beam / thick structure
      heads.push({ cx: c.cx, cy: c.cy, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, staff: st, area: c.area, hollow: false }); continue;
    }
    for (const hd of splitCluster(oc.labels, w, c, nRows, nCols, sp)) heads.push({ ...hd, staff: st, hollow: false });
  }
  // --- thin vertical objects: stems and barlines ----------------------------
  const vobjs = findVerticalObjects(nolines, w, h, rnd(1.8 * sp), Math.max(3, rnd(1.0 * sp)));
  // stem width limit adapts to the measured stroke width (blurred photos binarise stems 4–5 px wide)
  const ws = vobjs.filter(o => o.y1 - o.y0 >= 2.5 * sp && o.width <= 0.5 * sp).map(o => o.width).sort((a, b) => a - b);
  const stemMax = Math.max(2, 0.32 * sp, ws.length >= 8 ? ws[ws.length >> 1] + 1.5 : 0);
  const stems = vobjs.filter(o => o.width <= Math.min(stemMax, 0.5 * sp));
  for (const s of stems) s.staff = staffOf(staves, (s.y0 + s.y1) / 2, sp);
  // learned note heads (heads.js) replace the morphological candidates when a model is loaded
  if (ctx.models && ctx.models.heads) {
    const lh = learnedHeads(ctx, staves, nolines, ctx.models.heads, mlpPredict, { minProb: ctx.headMinProb ?? 0.5 });
    return { cc, heads: lh.heads, stems, vobjs, learned: true, wholeHeads: lh.wholes };
  }
  return { cc, heads, stems, vobjs };
}

/** A note head is a compact blob: the ink rows through it must not continue
 * far beyond its box on both sides (beam) nor far on one side (beam end),
 * and the ink columns must not be much taller than a head (clef, brace). */
function isolatedBlob(img, w, h, c, sp) {
  const runH = (y) => {
    y = rnd(y); if (y < 0 || y >= h) return [c.x0, c.x1];
    let a = rnd(c.cx), b = a; if (!img[y * w + a]) return [c.x0, c.x1];
    while (a > 0 && img[y * w + a - 1]) a--;
    while (b < w - 1 && img[y * w + b + 1]) b++;
    return [a, b];
  };
  for (const dy of [-0.25 * sp, 0, 0.25 * sp]) {
    const [a, b] = runH(c.cy + dy);
    const extL = c.x0 - a, extR = b - c.x1;
    if ((extL > 0.45 * sp && extR > 0.45 * sp) || extL > 1.1 * sp || extR > 1.1 * sp) return false;
  }
  for (const dx of [-0.15 * sp, 0.15 * sp]) {
    const x = rnd(c.cx + dx); let a = rnd(c.cy), b = a;
    if (!img[a * w + x]) continue;
    while (a > 0 && img[(a - 1) * w + x]) a--;
    while (b < h - 1 && img[(b + 1) * w + x]) b++;
    if (b - a > 2.0 * sp) return false;
  }
  return true;
}

function splitCluster(labels, w, c, nRows, nCols, sp) {
  // Lloyd iterations from a regular grid of seeds inside the blob's bbox.
  const seeds = [];
  for (let r = 0; r < nRows; r++) for (let q = 0; q < nCols; q++)
    seeds.push({ cx: c.x0 + (q + 0.5) * c.w / nCols, cy: c.y0 + (r + 0.5) * c.h / nRows });
  const pts = [];
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (labels[y * w + x] === c.id) pts.push(x, y);
  for (let it = 0; it < 4; it++) {
    const acc = seeds.map(() => ({ sx: 0, sy: 0, n: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1 }));
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      let k = 0, bd = Infinity;
      seeds.forEach((s, j) => { const d = (x - s.cx) ** 2 + ((y - s.cy) * 1.3) ** 2; if (d < bd) { bd = d; k = j; } });
      const a = acc[k]; a.sx += x; a.sy += y; a.n++; if (x < a.x0) a.x0 = x; if (x > a.x1) a.x1 = x; if (y < a.y0) a.y0 = y; if (y > a.y1) a.y1 = y;
    }
    acc.forEach((a, j) => { if (a.n) { seeds[j].cx = a.sx / a.n; seeds[j].cy = a.sy / a.n; Object.assign(seeds[j], { x0: a.x0, x1: a.x1, y0: a.y0, y1: a.y1, area: a.n }); } });
  }
  return seeds.filter(s => s.area > 0.3 * sp * sp && (s.x1 - s.x0) > 0.6 * sp && (s.y1 - s.y0) > 0.5 * sp);
}

// ---------------------------------------------------------------------------
// Stage 5: classification
// ---------------------------------------------------------------------------
const NUM_BEAMS_TO_DUR = ['quarter', 'eighth', '16th', '32nd', '64th'];
const rhythmBuf = new Float32Array(N_RFEAT);

/** Staff position (0 = top line, +1 per half space downward) of a point. */
function staffPosAt(st, x, y) {
  const xi = clamp(rnd(x), 0, st.lines[0].length - 1);
  const l0 = st.lines[0][xi], l4 = st.lines[4][xi];
  const half = (l4 - l0) / 8;
  return (y - l0) / half;
}

function vRunLen(img, w, h, x, y) {
  x = rnd(x); y = rnd(y);
  if (x < 0 || x >= w || y < 0 || y >= h || !img[y * w + x]) return 0;
  let a = y, b = y;
  while (a > 0 && img[(a - 1) * w + x]) a--;
  while (b < h - 1 && img[(b + 1) * w + x]) b++;
  return b - a + 1;
}
function inkAt(img, w, h, x, y) { x = rnd(x); y = rnd(y); return x >= 0 && y >= 0 && x < w && y < h && img[y * w + x] ? 1 : 0; }

/** Counts beams/flags attached to a stem on one side within the free-end zone. */
function countBars(ctx, nolines, stem, side, yA, yB, off = 0.55) {
  const { w, h, sp } = ctx;
  const x2 = rnd(stem.x + side * off * sp), x1 = rnd(stem.x + side * 0.25 * sp), x3 = rnd(stem.x + side * Math.max(0.9, off + 0.3) * sp);
  if (x2 < 0 || x2 >= w) return { n: 0, beam: false };
  let n = 0, beam = false;
  let y = Math.max(0, rnd(yA));
  const yEnd = Math.min(h - 1, rnd(yB));
  while (y <= yEnd) {
    if (!nolines[y * w + x2]) { y++; continue; }
    let y2 = y; while (y2 <= yEnd && nolines[y2 * w + x2]) y2++;
    const len = y2 - y;
    if (len >= 0.22 * sp) {
      // connected to the stem? (flags curve away from the stem, so look in a
      // slightly larger row range next to the stem)
      let conn = 0;
      for (let yy = y - 0.4 * sp; yy < y2 + 0.4 * sp; yy++) conn += inkAt(nolines, w, h, x1, yy);
      if (conn >= Math.min(0.5 * len, 0.3 * sp)) {
        let far = 0; for (let yy = y; yy < y2; yy++) far += inkAt(nolines, w, h, x3, yy);
        if (far >= 0.4 * len) beam = true;
        n += len >= 1.0 * sp && len < 1.6 * sp ? 2 : len >= 1.6 * sp ? 3 : 1;
      }
    }
    y = y2;
  }
  return { n, beam };
}

export function classify(ctx, staves, nolines, prims, options = {}) {
  const { w, h, sp, bin } = ctx;
  const { cc, heads, stems } = prims;
  const warnings = [];
  const symbols = [];
  ctx.nolines = nolines;
  ctx.photoPipe = !options.legacyPreprocess; ctx.dbgKW = options.dbgKW || null;
  glyphHook = ctx.models && ctx.models.glyphs ? makeGlyphHook(ctx, staves, ctx.models.glyphs, mlpPredict, nolines) : null;
  try { return classifyInner(ctx, staves, nolines, prims, options, warnings, symbols); } finally { glyphHook = null; }
}

function classifyInner(ctx, staves, nolines, prims, options, warnings, symbols) {
  const { w, h, sp, bin } = ctx;
  const { cc, heads, stems } = prims;
  // ---- headers (clef, key, time) per staff; defines where music starts -----
  for (const st of staves) detectHeader(ctx, st, cc, options, warnings);
  // key signatures read from windows that the page vote does not confirm are undone: their x range
  // holds the first notes then
  if (staves.some(st => st.kwUndo)) {
    const pk = voteKey(staves, ctx.sp / (ctx.scale || 1) <= 11)[0][0];
    for (const st of staves) if (st.kwUndo && st.keyFifths !== pk) {
      st.headerLabels.length = st.kwUndo.labels;
      if (!st.timeSig) st.headerEnd = st.kwUndo.x + 0.4 * ctx.sp;
      st.keyFifths = 0; st.keyConf = 0; st.keyWindows = false; st.kwUndo = null;
    }
  }
  // ---- barlines ------------------------------------------------------------
  const systems = [];
  for (const st of staves) { (systems[st.systemIndex] ||= { staves: [] }).staves.push(st); }
  for (const sys of systems) if (sys) { if (options.legacyPreprocess) detectBarlines(ctx, sys, prims, nolines); else detectBarlinesV2(ctx, sys, prims, nolines, mlpPredict); }
  // ---- stem/head association ------------------------------------------------
  const usable = stems.filter(s => s.staff && !s.isBarline && s.x > s.staff.headerEnd - 0.3 * sp);
  const headsOk = heads.filter(hd => hd.cx > hd.staff.headerEnd - 0.2 * sp && hd.cx < hd.staff.x1 + sp);
  for (const hd of heads) hd._drop = headsOk.includes(hd) ? null : 'header';      // diagnostics (trace)
  associateHeads(ctx, usable, headsOk);
  if (prims.learned && !options.legacyPreprocess && options.virtualStems !== false) virtualStems(ctx, nolines, usable, headsOk, systems);
  for (const hd of headsOk) if (!hd.stem) hd._drop = 'nostem';
  // hollow heads on stems that have no filled head, and stemless whole notes
  // (learned heads already carry filled / half / whole)
  if (!prims.learned) findHollowHeads(ctx, nolines, usable, headsOk);
  const wholes = prims.learned
    ? wholeNoteEvents(prims.wholeHeads.filter(hd => hd.cx > hd.staff.headerEnd - 0.2 * sp && hd.cx < hd.staff.x1 + sp), staffPosAt)
    : findWholeNotes(ctx, nolines, cc, staves, usable, headsOk);
  // ---- notes: durations from beams/flags, pitches from staff position -------
  const notes = [];
  for (const s of usable) {
    if (!s.heads.length) continue;
    // a quarter rest's blob + slanted body can mimic a head + short stem:
    // short, isolated components that match the rest template are rests
    const comp = cc.comps[labelAt(cc.labels, w, s.x, (s.y0 + s.y1) / 2)];
    if (comp && comp.h < 3.6 * sp && comp.w < 1.7 * sp) {
      const m = bestTemplate(cc.labels, w, comp, ['restQuarter', 'rest8th'], sp, 0.3);
      if (m && m.score >= 0.45) { for (const hd of s.heads) hd._drop = 'rest'; s.heads = []; continue; }
      if (s.y1 - s.y0 < 2.4 * sp) { for (const hd of s.heads) hd._drop = 'short'; s.heads = []; continue; }      // too short for an unbeamed stem
    }
    const dir = s.dir;
    const endHeads = s.heads.map(hd => hd.cy);
    const nearest = dir === 'up' ? Math.min(...endHeads) : Math.max(...endHeads);   // head closest to the free end
    const zoneA = dir === 'up' ? s.y0 : Math.max(s.y1 - 3.2 * sp, nearest + 0.9 * sp);
    const zoneB = dir === 'up' ? Math.min(s.y0 + 3.2 * sp, nearest - 0.9 * sp) : s.y1;
    let nb = 0, beam = false, conf = 0.9, rule = { L: 0, R: 0 };
    if (zoneB - zoneA > 0.3 * sp) {
      let L = countBars(ctx, nolines, s, -1, zoneA, zoneB), R = countBars(ctx, nolines, s, +1, zoneA, zoneB);
      // photo pipeline: a curved flag can cross the probe column twice — the count must hold at a second offset
      if (!options.legacyPreprocess) {
        const L2 = countBars(ctx, nolines, s, -1, zoneA, zoneB, 0.8), R2 = countBars(ctx, nolines, s, +1, zoneA, zoneB, 0.8);
        if (L2.n && L2.n < L.n) L = { ...L, n: L2.n };
        if (R2.n && R2.n < R.n) R = { ...R, n: R2.n };
      }
      nb = Math.max(L.n, R.n); beam = L.beam || R.beam;
      if (L.n && R.n && L.n !== R.n) conf = 0.7;
      rule = { L: L.n, R: R.n };
    } else conf = 0.6;
    const hollow = s.heads.every(hd => hd.hollow);
    // learned beam / flag count (rhythm.js, models/rhythm.js) replaces the rule when confident
    let rprobs = null;
    if (ctx.models && ctx.models.rhythm && !hollow) {
      const lb = learnedBeamCount(ctx, ctx.models.rhythm, mlpPredict, s, s.heads, rule, rhythmBuf);
      if (lb && lb.prob >= 0.5) { nb = lb.n; conf = Math.max(0.5, Math.min(0.95, lb.prob)); }
      if (lb) rprobs = lb.probs;
    }
    let base = hollow ? 'half' : NUM_BEAMS_TO_DUR[Math.min(nb, 4)];
    if (hollow && nb) conf = 0.5;
    const ev = { kind: 'note', staff: s.staff, x: s.heads.reduce((a, b) => a + b.cx, 0) / s.heads.length, stem: s, base, dots: 0, beam, nb, conf, rule, rprobs, hollow,
      heads: s.heads.sort((a, b) => b.cy - a.cy), bbox: unionBox([...s.heads.map(headBox), { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 }]) };
    for (const hd of ev.heads) hd.pos = Math.round(staffPosAt(s.staff, hd.cx, hd.cy));
    notes.push(ev);
  }
  for (const wn of wholes) notes.push(wn);
  // reject heads outside the staff lacking the mandatory ledger line
  const kept = notes.filter(ev => {
    ev.heads = ev.heads.filter(hd => { const ok = ledgerOk(ctx, ev.staff, hd); if (!ok) hd._drop = 'ledger'; return ok; });
    return ev.heads.length > 0;
  });
  // ---- dots, accidentals, rests, ties from the remaining components ----------
  const used = new Set();
  for (const ev of kept) { if (ev.stem) used.add(labelAt(cc.labels, w, ev.stem.x, (ev.stem.y0 + ev.stem.y1) / 2)); for (const hd of ev.heads) used.add(labelAt(cc.labels, w, hd.cx, hd.cy)); }
  for (const st of staves) for (const id of st.headerLabels || []) used.add(id);
  for (const s of stems) if (s.isBarline) used.add(labelAt(cc.labels, w, s.x, (s.y0 + s.y1) / 2));
  const free = cc.comps.filter(c => c && !used.has(c.id));
  const rests = [];
  for (const c of free) {
    const st = staffOf(staves, c.cy, sp);
    if (!st || c.cx < st.headerEnd - 0.2 * sp) continue;
    const wsp = c.w / sp, hsp = c.h / sp;
    const mid = (st.lines[0][clamp(rnd(c.cx), 0, w - 1)] + st.lines[4][clamp(rnd(c.cx), 0, w - 1)]) / 2;
    if (glyphHook) {
      // rests sit near the staff middle and have bounded size (text, slurs, dynamics are classified otherwise)
      if (Math.abs(c.cy - mid) > 2.6 * sp || hsp > 4.6 || hsp < 0.25 || wsp > 2.8 || wsp < 0.3) continue;
      const REST = { restWhole: 'whole', restHalf: 'half', restQuarter: 'quarter', rest8th: 'eighth', rest16th: '16th', rest32nd: '32nd' };
      const m = glyphHook(c, Object.keys(REST));
      if (m && m.score >= 0.55) { rests.push({ kind: 'rest', staff: st, x: c.cx, base: REST[m.name], dots: 0, conf: Math.min(0.95, m.score), comp: c, bbox: c }); used.add(c.id); }
      continue;
    }
    // whole / half rest: small filled rectangle hanging from line 2 / sitting on line 3
    if (wsp >= 0.9 && wsp <= 2.2 && hsp >= 0.3 && hsp <= 0.8 && c.area / (c.w * c.h) > 0.8 && Math.abs(c.cy - mid) < 0.9 * sp) {
      const ratio = Math.abs(c.cy - (mid - 0.75 * sp)) < Math.abs(c.cy - (mid - 0.25 * sp)) ? 'whole' : 'half';
      rests.push({ kind: 'rest', staff: st, x: c.cx, base: ratio, dots: 0, conf: 0.8, comp: c, bbox: c });
      continue;
    }
    if (hsp >= 1.4 && hsp <= 4.4 && wsp >= 0.6 && wsp <= 2.0 && Math.abs(c.cy - mid) < 1.6 * sp) {
      const m = bestTemplate(cc.labels, w, c, ['restQuarter', 'rest8th', 'rest16th', 'rest32nd'], sp, 0.28);
      if (m && m.score >= 0.42) {
        rests.push({ kind: 'rest', staff: st, x: c.cx, base: { restQuarter: 'quarter', rest8th: 'eighth', rest16th: '16th', rest32nd: '32nd' }[m.name], dots: 0, conf: Math.min(0.95, m.score + 0.3), comp: c, bbox: c });
        used.add(c.id);
      }
    }
  }
  const events = [...kept, ...rests].sort((a, b) => a.x - b.x);
  attachDotsAndAccidentals(ctx, events, free.filter(c => !used.has(c.id)), used);
  detectTies(ctx, kept, free.filter(c => !used.has(c.id)));
  for (const ev of events) symbols.push(ev);
  return { events, systems, warnings, symbols };
}

function labelAt(labels, w, x, y) { return labels[rnd(y) * w + rnd(x)] || 0; }
function headBox(hd) { return { x0: hd.x0, y0: hd.y0, x1: hd.x1, y1: hd.y1 }; }
function unionBox(bs) { return { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) }; }

/** A head more than one position outside the staff must sit on/next to a
 * ledger line that protrudes on both sides — this rejects lyrics and text. */
function ledgerOk(ctx, st, hd) {
  const { bin, w, h, sp } = ctx;
  const pos = hd.pos;
  if (pos >= -1 && pos <= 9) return true;
  if (pos < -6 || pos > 14) return false;
  const lp = pos < 0 ? (pos % 2 === 0 ? pos : pos + 1) : (pos % 2 === 0 ? pos : pos - 1);   // nearest ledger position towards the staff
  const xi = clamp(rnd(hd.cx), 0, w - 1);
  const l0 = st.lines[0][xi], half = (st.lines[4][xi] - l0) / 8;
  const y = l0 + lp * half;
  // ledger lines protrude ~0.25–0.4 sp beyond the head on each side
  const dx = (hd.x1 - hd.x0) / 2 + 0.12 * sp;
  const probe = (x) => { for (let d = -2; d <= 2; d++) if (inkAt(bin, w, h, x, y + d)) return 1; return 0; };
  return probe(hd.cx - dx) + probe(hd.cx + dx) >= 1;
}

/** Assigns heads to stems (normal side first, then flipped "second" heads)
 * and derives the stem direction from which end carries heads. */
/** Photos: a confident filled / half head without a stem usually has one that the binarisation broke
 * into short pieces (blurred low-resolution photos lose ~17 % of their heads this way).  The column
 * at the head's stem side is followed with small gaps allowed; a run of ≥ 2.3 sp becomes a stem
 * (chord heads on the same column share it). */
function virtualStems(ctx, nolines, usable, heads, systems) {
  const { w, h, sp } = ctx;
  const gapMax = Math.max(2, Math.round(0.35 * sp)), minLen = 2.3 * sp, maxLen = 6 * sp;
  const ink = (x, y) => x >= 0 && y >= 0 && x < w && y < h && nolines[y * w + x] === 1;
  // a faint stem the binarisation lost: the column is clearly darker than both columns 2 px away
  const g = ctx.gray, lv = inkLevels(ctx), dth = Math.max(8, 0.12 * (lv.paper - lv.ink));
  const faint = (x, y) => x >= 2 && y >= 0 && x < w - 2 && y < h && g[y * w + x] + dth < Math.min(g[y * w + x - 2], g[y * w + x + 2]);
  // run from y0 in direction d (±1) at column x: [length, end y] with gaps ≤ gapMax
  const follow = (x, y0, d) => {
    let y = y0, last = y0, gap = 0;
    for (let k = 0; k < maxLen; k++, y += d) {
      const on = ink(x, y) || ink(x - 1, y) || ink(x + 1, y) || faint(x, y) || faint(x - 1, y) || faint(x + 1, y);
      if (on) { last = y; gap = 0; } else if (++gap > gapMax) break;
    }
    return [Math.abs(last - y0), last];
  };
  const bars = [];
  for (const sys of systems) if (sys) for (const b of sys.barlines || []) bars.push(b.x);
  const made = [];
  for (const hd of heads) {
    if (hd.stem || !hd.learned || hd.cls === 3 || (hd.prob ?? 0) < 0.8) continue;
    let best = null;
    // up-stem: right edge of the head, going up; down-stem: left edge, going down
    for (const [dir, xa, xb, d] of [['up', hd.x1 - 0.3 * sp, hd.x1 + 0.15 * sp, -1], ['down', hd.x0 - 0.15 * sp, hd.x0 + 0.3 * sp, 1]]) {
      for (let x = Math.round(xa); x <= Math.round(xb); x++) {
        const [len, end] = follow(x, Math.round(hd.cy), d);
        if (len >= minLen && (!best || len > best.len)) best = { dir, x, len, end };
      }
    }
    if (!best || bars.some(bx => Math.abs(bx - best.x) < 0.6 * sp)) continue;
    // the run must be a thin line somewhere along it (not a beam or a blob; the middle of a chord's
    // stem runs through its other heads): the narrowest of several sample rows ≤ 0.5 sp
    let thin = false;
    for (const f of [0.35, 0.55, 0.75, 0.9]) {
      const ym = Math.round(hd.cy + f * (best.end - hd.cy));
      let wl = 0, wr = 0;
      while (wl < sp && ink(best.x - wl - 1, ym)) wl++;
      while (wr < sp && ink(best.x + wr + 1, ym)) wr++;
      if (wl + wr + 1 <= 0.5 * sp) { thin = true; break; }
    }
    if (!thin) continue;
    const y0 = best.dir === 'up' ? best.end : Math.round(hd.cy), y1 = best.dir === 'up' ? Math.round(hd.cy) : best.end;
    let st = made.find(o => o.dir === best.dir && Math.abs(o.x - best.x) <= 0.3 * sp && o.staff === hd.staff && Math.min(o.y1, y1) - Math.max(o.y0, y0) > -1.2 * sp);
    if (!st) { st = { x: best.x, x0: best.x, x1: best.x, y0, y1, width: 1, staff: hd.staff, heads: [], dir: best.dir, virtual: true }; made.push(st); usable.push(st); }
    else { st.y0 = Math.min(st.y0, y0); st.y1 = Math.max(st.y1, y1); }
    st.heads.push(hd); hd.stem = st;
  }
}

function associateHeads(ctx, stems, heads) {
  const { sp } = ctx;
  const off = 0.57 * sp, tol = 0.4 * sp;
  for (const s of stems) { s.heads = []; s.dir = null; }
  for (const hd of heads) hd.stem = null;
  const near = (hd, s) => Math.abs(hd.cx - s.x) < 1.1 * sp && hd.cy > s.y0 - 0.7 * sp && hd.cy < s.y1 + 0.7 * sp;
  // phase 1: end heads on the normal side decide the direction
  for (const s of stems) {
    let best = null;
    for (const hd of heads) {
      if (!near(hd, s)) continue;
      const upErr = Math.abs(hd.cx - (s.x - off)) + Math.abs(hd.cy - s.y1) * 0.5;   // up-stem: head at the bottom, left
      const dnErr = Math.abs(hd.cx - (s.x + off)) + Math.abs(hd.cy - s.y0) * 0.5;   // down-stem: head at the top, right
      const okUp = Math.abs(hd.cx - (s.x - off)) < tol && Math.abs(hd.cy - s.y1) < 0.9 * sp;
      const okDn = Math.abs(hd.cx - (s.x + off)) < tol && Math.abs(hd.cy - s.y0) < 0.9 * sp;
      if (okUp && (!best || upErr < best.err)) best = { hd, dir: 'up', err: upErr };
      if (okDn && (!best || dnErr < best.err)) best = { hd, dir: 'down', err: dnErr };
    }
    if (best) s.dir = best.dir;
  }
  // phase 2: every head picks the best stem on its normal side, else flipped
  for (const hd of heads) {
    let best = null;
    for (const s of stems) {
      if (!s.dir || !near(hd, s)) continue;
      const normalX = s.dir === 'up' ? s.x - off : s.x + off;
      const flippedX = s.dir === 'up' ? s.x + off : s.x - off;
      const e1 = Math.abs(hd.cx - normalX), e2 = Math.abs(hd.cx - flippedX) + 0.3 * sp;
      const e = Math.min(e1, e2);
      if (e < tol + (e === e2 ? 0.3 * sp : 0) && (!best || e < best.e)) best = { s, e };
    }
    if (best) { hd.stem = best.s; best.s.heads.push(hd); }
  }
}

function findHollowHeads(ctx, nolines, stems, heads) {
  const { sp } = ctx;
  const ax = 0.63 * sp;
  for (const s of stems) {
    // accidentals' vertical strokes are ≤ 2.8 sp: only real stems qualify
    if (s.heads.length || s.y1 - s.y0 < 2.9 * sp) continue;
    let found = [];
    for (const side of [-1, 1]) {
      const cx = s.x + side * 0.6 * sp;
      for (let y = s.y0 - 0.3 * sp; y <= s.y1 + 0.3 * sp; y += Math.max(1, sp / 6)) {
        const r = hollowScore(ctx, nolines, cx, y, ax, s.x, s.staff);
        if (r.score > 0.4 && r.ring > 0.55 && r.core < 0.4 && r.outside < 0.3) found.push({ cx, cy: y, score: r.score, side });
      }
    }
    // non-maximum suppression: heads on one side are ≥ 1 sp apart
    found.sort((a, b) => b.score - a.score);
    found = found.filter((f, i) => !found.slice(0, i).some(g => g.side === f.side && Math.abs(g.cy - f.cy) < 0.95 * sp));
    if (!found.length) continue;
    // direction: the end head (lowest for up-stems on the left, highest for down-stems on the right)
    const bottom = found.reduce((a, b) => (b.cy > a.cy ? b : a)), top = found.reduce((a, b) => (b.cy < a.cy ? b : a));
    const upOk = bottom.side === -1 && Math.abs(bottom.cy - s.y1) < 1.0 * sp, dnOk = top.side === 1 && Math.abs(top.cy - s.y0) < 1.0 * sp;
    if (!upOk && !dnOk) continue;
    s.dir = upOk ? 'up' : 'down';
    for (const f of found) {
      const hd = { cx: f.cx, cy: f.cy, x0: f.cx - ax, x1: f.cx + ax, y0: f.cy - 0.53 * sp, y1: f.cy + 0.53 * sp, staff: s.staff, hollow: true, stem: s, area: 0 };
      s.heads.push(hd); heads.push(hd);
    }
  }
}

function findWholeNotes(ctx, nolines, cc, staves, stems, heads) {
  const { w, sp } = ctx;
  const out = [];
  for (const c of cc.comps) {
    if (!c) continue;
    const wsp = c.w / sp, hsp = c.h / sp;
    if (wsp < 1.25 || wsp > 2.2 || hsp < 0.75 || hsp > 1.4) continue;
    const st = staffOf(staves, c.cy, sp);
    if (!st || c.cx < st.headerEnd) continue;
    if (heads.some(hd => Math.abs(hd.cx - c.cx) < sp && Math.abs(hd.cy - c.cy) < sp)) continue;
    if (stems.some(s => Math.abs(s.x - c.cx) < 1.2 * sp && c.cy > s.y0 - sp && c.cy < s.y1 + sp)) continue;
    const r = hollowScore(ctx, nolines, c.cx, c.cy, c.w / 2, null, st);
    if (r.score < 0.35 || r.core > 0.4 || r.ring < 0.5 || r.outside > 0.3) continue;
    const hd = { cx: c.cx, cy: c.cy, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, staff: st, hollow: true, stem: null, area: c.area };
    hd.pos = Math.round(staffPosAt(st, hd.cx, hd.cy));
    out.push({ kind: 'note', staff: st, x: c.cx, stem: null, base: 'whole', dots: 0, beam: false, nb: 0, conf: 0.85, heads: [hd], bbox: headBox(hd) });
  }
  return out;
}

function attachDotsAndAccidentals(ctx, events, comps, used) {
  const { sp, w } = ctx;
  // (photos: a blurred dot can bridge to the staff line above or below it — the line pixels next to a
  // symbol are kept by the line removal — and the component is then up to ~1.4 sp tall)
  const crossesLine = (c, st) => {
    if (!st) return false;
    const xi = clamp(rnd(c.cx), 0, w - 1);
    return st.lines.some(L => L[xi] >= c.y0 - 0.1 * sp && L[xi] <= c.y1 + 0.1 * sp);
  };
  for (const c of comps) {
    const wsp = c.w / sp, hsp = c.h / sp;
    const fill = c.area / (c.w * c.h);
    if (wsp >= 0.22 && wsp <= (ctx.photoPipe ? 0.8 : 0.7) && hsp >= 0.22 && hsp <= (ctx.photoPipe ? 1.55 : 0.7) && fill > 0.55) {
      // augmentation dot: right of a head (or rest), roughly at its height
      let best = null;
      for (const ev of events) {
        const ref = ev.kind === 'note' ? ev.heads : [{ cx: ev.x, cy: ev.comp.cy, x1: ev.comp.x1 }];
        for (const hd of ref) {
          const dx = c.cx - hd.x1, dy = c.cy - hd.cy;
          if (dx > 0.1 * sp && dx < 1.4 * sp && Math.abs(dy) < 0.8 * sp && (!best || dx < best.dx)) best = { ev, dx };
        }
      }
      const tallOk = (hsp <= 0.7 && wsp <= 0.7) || (wsp >= 0.4 && best && crossesLine(c, best.ev.staff));
      if (best && tallOk) { best.ev.dots = 1; used.add(c.id); continue; }
      if (hsp <= 0.7 && wsp <= 0.7) continue;
    }
    // (the learned classifier knows several music fonts: wider size window)
    if (glyphHook ? (hsp >= 1.5 && hsp <= 3.8 && wsp >= 0.35 && wsp <= 1.9) : (hsp >= 1.8 && hsp <= 3.4 && wsp >= 0.45 && wsp <= 1.4)) {
      // accidental: immediately left of a head, vertically centred near it
      let best = null;
      for (const ev of events) {
        if (ev.kind !== 'note') continue;
        for (const hd of ev.heads) {
          const gap = hd.x0 - c.x1;
          // (chords: accidentals are staggered in columns, the second column ~2 sp left of the heads)
          if (gap < -0.1 * sp || gap > (ev.heads.length > 1 ? 2.6 : 1.4) * sp) continue;
          const dy = Math.abs(c.cy - hd.cy);
          if (dy < 1.1 * sp && (!best || gap + dy * 0.5 < best.cost)) best = { hd, cost: gap + dy * 0.5, gap };
        }
      }
      if (!best || (best.hd.accidental && best.hd.accGap != null && best.hd.accGap <= best.gap)) continue;
      const m = bestTemplate(ctx.cc.labels, w, c, ['sharp', 'flat', 'natural'], sp, 0.32);
      if (m && m.score >= 0.35 && (!glyphHook || m.name === m.top)) {
        // the flat's loop (lower part) marks the pitch; its bbox centre is ~0.45 sp higher
        best.hd.accidental = m.name; best.hd.accConf = m.score; best.hd.accGap = best.gap; used.add(c.id);
      }
    }
  }
  if (glyphHook && glyphHook.probs && ctx.nolines) accidentalWindows(ctx, events);
}

/** Accidentals that touch their note head (blurred photos) are part of the
 * head's component and never seen above: classify the ink box of the window
 * left of every head that has no accidental yet (photo pipeline). */
function accidentalWindows(ctx, events) {
  const { sp, w, h } = ctx;
  const nol = ctx.nolines;
  for (const ev of events) {
    if (ev.kind !== 'note' || ev.heads.length > 3) continue;
    for (const hd of ev.heads) {
      if (hd.accidental) continue;
      // a displaced chord head (second) to the left would be read as an accidental
      if (ev.heads.some(o => o !== hd && o.cx < hd.cx - 0.5 * sp && Math.abs(o.cy - hd.cy) < 2 * sp)) continue;
      const hEnd = ev.staff && ev.staff.headerEnd != null ? ev.staff.headerEnd : 0;
      const xa = Math.max(0, Math.round(Math.max(hd.x0 - 1.9 * sp, hEnd))), xb = Math.min(w - 1, Math.round(hd.x0 - 0.12 * sp));
      if (xb - xa < 0.5 * sp) continue;
      // (a flat reaches ~2.2 sp above its head: tall flats always touched a ±1.9 sp window)
      const ya = Math.max(0, Math.round(hd.cy - 2.6 * sp)), yb = Math.min(h - 1, Math.round(hd.cy + 2.1 * sp));
      // columns next to the head: the accidental's ink starts within ~0.5 sp of the head
      let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1, n = 0;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) if (nol[y * w + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      // the accidental touches (or almost touches) the head and does not run out of the window
      if (!n || x1 < hd.x0 - 0.35 * sp || x0 <= xa + 1 || y0 <= ya + 1 || y1 >= yb - 1) continue;
      const bw = (x1 - x0 + 1) / sp, bh = (y1 - y0 + 1) / sp;
      if (bh < 1.6 || bh > 3.9 || bw < 0.4 || bw > 1.8 || n / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.75) continue;
      // the head must lie inside the accidental's vertical span (sharp / natural centred, flat: lower half)
      if (hd.cy < y0 + 0.2 * sp || hd.cy > y1 - 0.1 * sp) continue;
      const box = { x0, x1, y0, y1 };
      const p = glyphHook.probs(box);
      const top = glyphHook.top(box);
      if (!['sharp', 'flat', 'natural'].includes(top.name) || top.score < 0.92) continue;
      hd.accidental = top.name; hd.accConf = top.score * 0.9; hd.accWindow = true;
      void p;
    }
  }
}

/** Ties: thin wide arcs joining two consecutive notes of the same position. */
function detectTies(ctx, notes, comps) {
  const { sp } = ctx;
  const arcs = comps.filter(c => c.w > 1.0 * sp && c.h < 1.8 * sp && c.area / (c.w * c.h) < 0.45 && c.h > 2);
  for (const a of arcs) {
    const st = staffOf(notes.length ? [a.staffHint || notes[0].staff] : [], a.cy, sp) || null;
    void st;
    const left = notes.filter(n => n.x < a.x0 + 0.3 * sp && n.x > a.x0 - 1.8 * sp && Math.abs(n.heads[0].staff.top - (a.cy)) < 10 * sp);
    const right = notes.filter(n => n.x > a.x1 - 0.3 * sp && n.x < a.x1 + 1.8 * sp && Math.abs(n.heads[0].staff.top - (a.cy)) < 10 * sp);
    if (!left.length || !right.length) continue;
    const L = left.reduce((p, q) => (q.x > p.x ? q : p)), R = right.reduce((p, q) => (q.x < p.x ? q : p));
    if (L.staff !== R.staff) continue;
    const match = L.heads.find(h1 => R.heads.some(h2 => h2.pos === h1.pos && Math.abs(h1.cy - a.cy) < 2.2 * sp));
    if (match) { L.tieStart = true; R.tieEnd = true; }
  }
}

/** Clef / key signature / time signature at the staff start. */
function detectHeader(ctx, st, cc, options, warnings) {
  const { w, sp } = ctx;
  const xi = clamp(rnd(st.x0 + 2 * sp), 0, w - 1);
  const top = st.lines[0][xi], bottom = st.lines[4][xi];
  st.headerLabels = [];
  st.clef = null; st.keyFifths = null; st.timeSig = null;
  const inHeader = cc.comps.filter(c => c && c.x0 >= st.x0 - 0.5 * sp && c.x0 < st.x0 + 14 * sp && c.y1 > top - 4 * sp && c.y0 < bottom + 3 * sp && c.h >= 0.25 * sp)
    .sort((a, b) => a.x0 - b.x0);
  let x = st.x0;
  // clef: the tall components of the staff start are scored by the glyph classifier — the first one
  // is not always the clef (a rehearsal-mark box, a bracket piece or text at the staff start was read
  // as a bass clef by its size, and the real clef after it was never looked at).  A clef overlaps its
  // own staff (the treble clef of the staff above reaches into this header zone in piano music).
  const onStaff = (c, min) => Math.min(c.y1, bottom) - Math.max(c.y0, top) >= min * sp;
  const isTall = (c, xMax) => c.h >= 2.4 * sp && c.w >= 1.2 * sp && c.x0 < st.x0 + xMax * sp && onStaff(c, 1.5);
  const tall = inHeader.filter(c => isTall(c, 5));
  let clefComp = tall[0] || null, clefPick = null, clefIds = null, skipTo = -Infinity, weakClef = false;
  if (glyphHook && glyphHook.probs) {
    const cands = [];
    const nol = ctx.nolines, H = ctx.h;
    const inkBox = (x0, x1, y0, y1) => {
      let a = Infinity, b = -1, c = Infinity, d = -1;
      for (let yy = Math.max(0, y0); yy <= Math.min(H - 1, y1); yy++) for (let xx = Math.max(0, x0); xx <= Math.min(w - 1, x1); xx++) if (nol[yy * w + xx]) { if (xx < a) a = xx; if (xx > b) b = xx; if (yy < c) c = yy; if (yy > d) d = yy; }
      return b < 0 ? null : { x0: a, x1: b, y0: c, y1: d };
    };
    const clefOf = (p) => ['gClef', 'fClef', 'cClef'].reduce((a, k) => (p[k] > p[a] ? k : a), 'gClef');
    for (const c of inHeader) {
      if (!isTall(c, 8)) continue;
      const p = glyphHook.probs(c);
      let name = clefOf(p), pb = p[name], none = p.none;
      if (pb < 0.5 && c.w > 3.3 * sp && nol && ctx.photoPipe) {
        // photos: a clef blurred into the key signature (or a brace) forms one wide component — its left part
        for (const W of [2.3, 2.6, 2.9, 3.2]) for (const band of [false, true]) {
          // (band: only the staff ± 0.6 sp — a slur or text above merged into the component)
          const b = inkBox(c.x0, Math.round(c.x0 + W * sp), band ? Math.max(c.y0, Math.round(top - 0.6 * sp)) : c.y0, band ? Math.min(c.y1, Math.round(bottom + 0.6 * sp)) : c.y1);
          if (!b || b.y1 - b.y0 + 1 < 2.4 * sp) continue;
          const q = glyphHook.probs(b);
          const nm = clefOf(q);
          if (q[nm] > pb) { name = nm; pb = q[nm]; none = q.none; }
        }
      }
      cands.push({ c, name, p: pb, none });
      if (cands.length >= 4) break;
    }
    // the first candidate the classifier accepts as a clef; leading shapes it firmly rejects are skipped
    clefPick = cands.find(q => q.p >= 0.5 && q.c.x0 < st.x0 + (q === cands[0] ? 5 : 8) * sp) || null;
    if (clefPick) clefComp = clefPick.c;
    else if (cands.length && (cands[0].none >= 0.9 || 1 - cands[0].none - cands[0].p >= 0.5)) {
      // no clef shape among the tall components: rather "missing" (→ the clef of the same staff in the
      // other systems) than a size-rule guess on a box or a word
      // (the size rule only for shapes the classifier does not know — never for an accidental, a digit…)
      clefComp = tall.find(c => { const p = glyphHook.probs(c); return p.none < 0.9 && 1 - p.none - p.gClef - p.fClef - p.cClef < 0.5; }) || null;
      for (const q of cands) if (q.none >= 0.9 && q.c.x0 < st.x0 + 5 * sp) skipTo = Math.max(skipTo, q.c.x1); else break;
    }
    if (!clefPick) {
      // a clef broken into pieces by staff-line removal (thin clef strokes, faint photos): unions of the
      // first pieces on the staff, left to right, are classified as one window
      const pieces = inHeader.filter(c => c.x0 > skipTo && c.x0 < st.x0 + 5 * sp && onStaff(c, -0.3));
      let u = null, best = null;
      const ids = [];
      for (const c of pieces.slice(0, 7)) {
        const v = u ? { x0: Math.min(u.x0, c.x0), x1: Math.max(u.x1, c.x1), y0: Math.min(u.y0, c.y0), y1: Math.max(u.y1, c.y1), area: u.area + c.area } : { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area };
        if ((v.x1 - v.x0 + 1) > 3.4 * sp) break;
        u = v; ids.push(c.id);
        const uw = (u.x1 - u.x0 + 1) / sp, uh = (u.y1 - u.y0 + 1) / sp;
        if (uh < 2.4 || uw < 0.9 || ids.length < 2) continue;
        const p = glyphHook.probs({ x0: u.x0, x1: u.x1, y0: u.y0, y1: u.y1, area: u.area });
        const name = ['gClef', 'fClef', 'cClef'].reduce((a, k) => (p[k] > p[a] ? k : a), 'gClef');
        if (p[name] >= 0.6 && (!best || p[name] > best.p)) best = { u: { ...u }, name, p: p[name], ids: ids.slice() };
      }
      if (best) {
        const u = best.u;
        clefComp = { id: best.ids[0], x0: u.x0, x1: u.x1, y0: u.y0, y1: u.y1, w: u.x1 - u.x0 + 1, h: u.y1 - u.y0 + 1, area: u.area };
        clefIds = best.ids;
      }
      // photos: windows at the staff start (all pieces of a broken clef together; or a clef left of a
      // staff start that was detected too far right) — classified as one shape
      if (!clefComp && nol && ctx.photoPipe) {
        let bw = null;
        for (const [a, b] of [[-0.3, 3.0], [-3.2, 0.3], [-0.3, 2.4]]) {
          const box = inkBox(Math.round(st.x0 + a * sp), Math.round(st.x0 + b * sp), Math.round(top - 2.5 * sp), Math.round(bottom + 2.5 * sp));
          if (!box || box.y1 - box.y0 + 1 < 2.4 * sp || box.x1 - box.x0 + 1 < 1.0 * sp || box.x1 - box.x0 + 1 > 3.6 * sp) continue;
          if (Math.min(box.y1, bottom) - Math.max(box.y0, top) < 1.5 * sp) continue;
          const q = glyphHook.probs(box);
          const nm = clefOf(q);
          if (q[nm] >= 0.65 && (!bw || q[nm] > bw.p)) bw = { box, name: nm, p: q[nm] };
        }
        if (bw) {
          const b = bw.box;
          clefComp = { id: -1, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
          clefPick = { c: clefComp, name: bw.name, p: bw.p * 0.9 };
          // (the pieces inside the window belong to the clef)
          clefIds = inHeader.filter(c => c.x0 >= b.x0 && c.x1 <= b.x1 && c.y0 >= b.y0 && c.y1 <= b.y1).map(c => c.id);
        }
      }
      // nothing better: the size rule on the first tall shape the classifier does not read as another
      // glyph, as a weak vote (a clef that falls apart into pieces — e.g. thin alto clefs — leaves only
      // its curved half; a rehearsal box before a real clef is outvoted by the other staves)
      // (not for a shape read as accidentals — merged key-signature sharps are as tall as an alto clef;
      // the curved half of a broken alto clef reads as a digit)
      if (!clefComp && tall.length) {
        const p = glyphHook.probs(tall[0]);
        if (p.sharp + p.flat + p.natural < 0.5) { clefComp = tall[0]; weakClef = true; }
      }
    }
    st.clefCands = cands.map(q => ({ x: q.c.x0, w: q.c.w / sp, h: q.c.h / sp, name: q.name, p: q.p, none: q.none }));
  }
  if (clefComp) {
    const hsp = clefComp.h / sp;
    if (hsp >= 5.0) st.clef = 'treble';
    else if (hsp >= 3.7 && hsp <= 4.7) st.clef = 'alto';
    else if (hsp >= 2.5 && hsp <= 3.7) st.clef = 'bass';
    st.clefConf = st.clef ? (weakClef ? 0.35 : 0.6) : 0;
    if (glyphHook) { const m = glyphHook(clefComp, ['gClef', 'fClef', 'cClef']); if (m && m.score >= 0.5) { st.clef = { gClef: 'treble', fClef: 'bass', cClef: 'alto' }[m.name]; st.clefConf = m.score; } }
    if (clefPick && clefPick.c === clefComp && clefPick.p >= 0.5) { st.clef = { gClef: 'treble', fClef: 'bass', cClef: 'alto' }[clefPick.name]; st.clefConf = clefPick.p; }
    if (st.clef && weakClef) {
      // a weak size-rule guess sets the clef type (a weak vote) but does not move the header end: the
      // shape may be a chord or a merged figure at the staff start, whose notes must stay in the music
      st.clefBox = null;
    } else if (st.clef) {
      // the bass-clef dots are separate small components right of the curl
      st.headerLabels.push(...(clefIds || [clefComp.id]));
      x = clefComp.x1 + 0.2 * sp;
      st.clefBox = clefComp;
      if (st.clef === 'bass') for (const c of inHeader) if (c.x0 > clefComp.x1 - sp && c.x0 < clefComp.x1 + 1.2 * sp && c.w < 0.7 * sp && c.h < 0.7 * sp) { st.headerLabels.push(c.id); x = Math.max(x, c.x1 + 0.2 * sp); }
      // photos: a clef broken into pieces — the other pieces lie within the clef's width
      if (glyphHook) for (const c of inHeader) if (c !== clefComp && c.x0 >= clefComp.x0 - 0.5 * sp && c.x1 <= clefComp.x0 + 2.75 * sp && c.x1 > x - 0.2 * sp && c.y1 > top - 3 * sp && c.y0 < bottom + 3 * sp) { st.headerLabels.push(c.id); x = Math.max(x, c.x1 + 0.2 * sp); }
    }
  }
  if (!st.clef) { st.clef = 'treble'; st.clefMissing = true; }
  // key signature: run of accidental-sized components
  let sharps = 0, flats = 0, lastX = x;
  if (glyphHook && glyphHook.probs) {
    ({ sharps, flats, x } = readKeyLearned(ctx, st, inHeader, x));
    if (!sharps && !flats && ctx.photoPipe && ctx.nolines && options.keyWindows !== false) {
      const undo = { x, labels: st.headerLabels.length };
      const kw = readKeyWindows(ctx, st, inHeader, x);
      if (kw) { ({ sharps, flats, x } = kw); st.kwUndo = undo; }
    }
  } else for (const c of inHeader) {
    if (c.x0 < lastX - 0.3 * sp) continue;
    if (c.x0 > lastX + 1.6 * sp) break;
    const hsp = c.h / sp, wsp = c.w / sp;
    if (hsp < 2.0 || hsp > 3.4 || wsp < 0.45 || wsp > 1.3) break;
    const m = bestTemplate(cc.labels, w, c, ['sharp', 'flat', 'natural'], sp, 0.32);
    if (!m || m.score < 0.3 || m.name === 'natural') break;
    if (m.name === 'sharp') sharps++; else flats++;
    st.headerLabels.push(c.id); lastX = c.x1; x = c.x1 + 0.2 * sp;
  }
  st.keyFifths = sharps ? sharps : flats ? -flats : 0;
  if (sharps && flats) st.keyFifths = sharps >= flats ? sharps : -flats;
  // time signature: two stacked digit groups, or a common/cut glyph
  const digitsTop = [], digitsBot = [];
  let single = null;
  for (const c0 of inHeader) {
    if (c0.x0 < x - 0.3 * sp || c0.x0 > x + 4.5 * sp) continue;
    let parts = [c0];
    // numerator and denominator often touch through the middle line: split there
    if (c0.h / sp >= 3.4 && c0.h / sp <= 4.8 && Math.abs(c0.y0 - top) < 0.6 * sp) {
      const ym = rnd(top + 2 * sp);
      parts = [{ ...c0, y1: ym - 1, h: ym - c0.y0 }, { ...c0, y0: ym + 1, h: c0.y1 - ym }];
    }
    for (const c of parts) {
    const hsp = c.h / sp;
    if (hsp < 1.4 || hsp > 3.4) continue;
    const cy = (c.y0 + c.y1) / 2;
    if (hsp <= 2.6 && Math.abs(cy - (top + sp)) < 0.7 * sp) digitsTop.push(c);
    else if (hsp <= 2.6 && Math.abs(cy - (top + 3 * sp)) < 0.7 * sp) digitsBot.push(c);
    else if (Math.abs(cy - (top + 2 * sp)) < 0.7 * sp && !single) single = c;
    }
  }
  const readDigits = (list) => {
    let s = '';
    for (const c of list.sort((a, b) => a.x0 - b.x0)) {
      const m = bestTemplate(cc.labels, w, c, ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'], sp, 0.3);
      if (!m || m.score < 0.35) return null;
      s += m.name[1];
    }
    return s ? parseInt(s, 10) : null;
  };
  if (digitsTop.length && digitsBot.length) {
    const num = readDigits(digitsTop), den = readDigits(digitsBot);
    if (num && den && [1, 2, 4, 8, 16].includes(den) && num >= 1 && num <= 32) {
      st.timeSig = { num, den, display: 'normal' };
      for (const c of [...digitsTop, ...digitsBot]) { st.headerLabels.push(c.id); x = Math.max(x, c.x1 + 0.2 * sp); }
    }
  } else if (single) {
    const m = bestTemplate(cc.labels, w, single, ['common', 'cut'], sp, 0.3);
    if (m && m.score >= 0.4) { st.timeSig = m.name === 'common' ? { num: 4, den: 4, display: 'common' } : { num: 2, den: 2, display: 'cut' }; st.headerLabels.push(single.id); x = Math.max(x, single.x1 + 0.2 * sp); }
  }
  st.headerEnd = x + 0.4 * sp;
  void warnings;
}

// staff positions (half spaces below the top line) of the key-signature accidentals in the treble clef;
// bass clef +2, alto clef +1
const KEY_POS = { sharp: [0, 3, -1, 2, 5, 1, 4], flat: [4, 1, 5, 2, 6, 3, 7] };
const KEY_CLEF_SHIFT = { treble: 0, bass: 2, alto: 1 };

/** Photos: no key-signature accidental was found as a component — on blurred / low-resolution photos
 * the accidentals merge with the clef or fall apart into pieces between the staff lines.  Windows at
 * the places a key signature occupies (the clef's pitch pattern, evenly spaced after the clef) are
 * classified from the grey image; the run of sharps or flats (first x, step) whose windows all read
 * clearly as that accidental is taken. */
function readKeyWindows(ctx, st, inHeader, x) {
  const { sp, w } = ctx;
  const shift = KEY_CLEF_SHIFT[st.clef];
  if (shift == null || !glyphHook || !glyphHook.probs) return null;
  // (a clef component much wider than any clef glyph holds the first accidentals: the scan starts
  // inside it; no clef component: x is still the staff start, the clef glyph lies right of it)
  const cb = st.clefBox, maxW = { treble: 3.15, bass: 3.35, alto: 3.4 }[st.clef] || 3.3;
  const wide = cb && cb.w > maxW * sp;
  const start = cb ? (wide ? cb.x0 + 2.0 * sp : x - 0.25 * sp) : x + 2.2 * sp;
  const G = 0.2 * sp, nx = wide ? 14 : 9;        // first accidental within 1.6 sp (2.6 sp in a wide clef) of the start
  const steps = [0.85, 0.95, 1.05, 1.15, 1.3, 1.45].map(v => v * sp);
  const yAt = (xx, pos) => { const xi = clamp(rnd(xx), 0, w - 1); const t = st.lines[0][xi], b = st.lines[4][xi]; return t + pos * (b - t) / 8; };
  const cache = new Map();
  const prob = (type, i, xa) => {
    const key = type + i + ':' + rnd(xa);
    let p = cache.get(key);
    if (p == null) {
      const wt = (type === 'sharp' ? 1.0 : 0.85) * sp;
      const xm = xa + wt / 2, yc = yAt(xm, KEY_POS[type][i] + shift);
      // the tight ink box (line-free image) inside the window: the classifier sees the real extent
      const wx0 = rnd(xa), wx1 = rnd(xa + wt);
      const wy0 = rnd(yc - (type === 'sharp' ? 1.9 : 2.3) * sp), wy1 = rnd(yc + (type === 'sharp' ? 1.9 : 1.0) * sp);
      let bx0 = Infinity, bx1 = -1, by0 = Infinity, by1 = -1;
      if (wx0 >= 0 && wx1 < w && wy0 >= 0 && wy1 < ctx.h) for (let yy = wy0; yy <= wy1; yy++) for (let xx = wx0; xx <= wx1; xx++) if (ctx.nolines[yy * w + xx]) { if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy; }
      if (bx1 < 0 || by1 - by0 + 1 < 1.4 * sp || bx1 - bx0 + 1 < 0.35 * sp) p = 0;
      else {
        const box = { x0: bx0, x1: bx1, y0: by0, y1: by1 };
        // (the accidental's own extent must match its position: sharp centred, flat above)
        const cy = (by0 + by1) / 2;
        const ok = type === 'sharp' ? Math.abs(cy - yc) <= 0.6 * sp : (cy < yc + 0.1 * sp && cy > yc - 1.4 * sp);
        const q = glyphHook.probs(box); p = ok && q[type] >= q.none ? q[type] : 0;
      }
      cache.set(key, p);
    }
    return p;
  };
  let best = null, bestAlt = null;
  for (const type of ['sharp', 'flat']) {
    for (let j = 0; j < nx; j++) {
      const xs = start + j * G;
      if (prob(type, 0, xs) < 0.6) continue;
      for (const step of steps) {
        let k = 0, sum = 0, min = 1;
        for (let i = 0; i < 7; i++) {
          // (window positions snapped to the 0.2 sp grid: shared by the hypotheses)
          const xa = start + Math.round((xs - start + i * step) / G) * G;
          const p = prob(type, i, xa);
          if (p < 0.6) break;
          k++; sum += p; min = Math.min(min, p);
        }
        if (!k) continue;
        const mean = sum / k;
        // (a single accidental after the clef is as often the first note's: a run of ≥ 2 is needed; a
        // note head with an up-stem in a flat's window looks much like a flat: flats need a longer,
        // very clear run)
        // (inside a wide clef component the clef's own curl and dots can look like two sharps)
        if (type === 'sharp' && !wide ? k < 2 || mean < 0.9 : k < 3 || mean < 0.97) continue;
        const score = sum - 0.15 * k;
        if (!best || score > best.score) { if (best && best.type !== type) bestAlt = best; best = { type, k, xs, step, mean, score }; }
        else if (best.type !== type && (!bestAlt || score > bestAlt.score)) bestAlt = { type, k, xs, step, mean, score };
      }
    }
  }
  if (ctx.dbgKW) ctx.dbgKW.push({ st: st.index, clef: st.clef, best: best && { type: best.type, k: best.k, mean: +best.mean.toFixed(2), score: +best.score.toFixed(2), xs: +((best.xs - start) / sp).toFixed(1), step: +(best.step / sp).toFixed(2) }, alt: bestAlt && { type: bestAlt.type, k: bestAlt.k, mean: +bestAlt.mean.toFixed(2), score: +bestAlt.score.toFixed(2) } });
  if (!best) return null;
  const xEnd = best.xs + (best.k - 1) * best.step + (best.type === 'sharp' ? 1.0 : 0.85) * sp;
  for (const c of inHeader) if (c.x0 >= start - 0.3 * sp && c.x1 <= xEnd + 0.3 * sp) st.headerLabels.push(c.id);
  st.keyConf = best.mean * 0.9;
  st.keyWindows = true;
  return { sharps: best.type === 'sharp' ? best.k : 0, flats: best.type === 'flat' ? best.k : 0, x: xEnd + 0.2 * sp };
}

/** Key signature with the learned glyph classifier: a run of sharps or flats
 * after the clef.  Touching accidentals (frequent in photos: they are ~1 sp
 * wide and ~1 sp apart) form one wide component, which is cut into k equal
 * pieces (k from its width) and each piece's ink box is classified. */
function readKeyLearned(ctx, st, inHeader, x) {
  const { sp, w, h } = ctx;
  const nol = ctx.nolines;
  let sharps = 0, flats = 0, lastX = x, type = null, confSum = 0, accW = 0;   // (accW: summed width of the counted units)
  const xs = [];                                                                  // left edges of single counted accidentals
  let tailCounted = false;
  const inkBox = (x0, x1, y0, y1) => {
    // tight ink box of the line-free image inside a window
    let a = Infinity, b = -1, c = Infinity, d = -1;
    for (let yy = Math.max(0, y0); yy <= Math.min(h - 1, y1); yy++) for (let xx = Math.max(0, x0); xx <= Math.min(w - 1, x1); xx++) if (nol[yy * w + xx]) { if (xx < a) a = xx; if (xx > b) b = xx; if (yy < c) c = yy; if (yy > d) d = yy; }
    return b < 0 ? null : { x0: a, x1: b, y0: c, y1: d };
  };
  const accOf = (p) => (p.sharp >= p.flat ? ['sharp', p.sharp] : ['flat', p.flat]);
  /** number / kind / confidence of the accidentals in one unit (0 if it is none) */
  const classifyUnit = (c) => {
    const wsp = c.w / sp;
    const p = glyphHook.probs(c);
    let [acc, pa] = accOf(p);
    let n = 0;
    // (one accidental can be up to ~2.2 sp wide: Petaluma's sharp is 1.65 sp, blurred photos add more)
    if (wsp <= 2.3 && pa >= 0.45 && pa >= p.natural) n = 1;
    let pn = pa;
    // two touching accidentals are ≥ ~1.8 sp wide (≈ 1 sp apart): a narrower unit that is clearly one
    // accidental is not cut (the halves of a wide sharp look like sharps too: Petaluma read as 2 sharps)
    if (wsp > (n && pa >= 0.9 ? 1.75 : 1.25) && nol) {
      // possibly k touching accidentals: try equal cuts, keep the most convincing
      let best = n ? { k: 1, score: pa * (wsp <= 1.45 ? 1 : wsp <= 1.8 ? 0.85 : 0.7), acc } : null;
      for (let k = 2; k <= 7; k++) {
        const pw = c.w / k;
        if (pw < 0.55 * sp || pw > 1.75 * sp) continue;      // (handwritten-style fonts: sharps up to ~1.7 sp wide)
        let tot = 0, kind = null, ok = true;
        for (let i = 0; i < k && ok; i++) {
          // vertical extent from the piece's central columns (the neighbours overlap its edges)
          const xa = Math.round(c.x0 + i * pw), xb = Math.round(c.x0 + (i + 1) * pw) - 1;
          const core = inkBox(Math.round(xa + 0.25 * pw), Math.round(xb - 0.25 * pw), c.y0, c.y1);
          if (!core || (core.y1 - core.y0) < 1.3 * sp) { ok = false; break; }
          const bx = { x0: xa, x1: xb, y0: core.y0, y1: core.y1 };
          const q = glyphHook.probs(bx);
          const [ak, pk] = accOf(q);
          if (kind && ak !== kind) { ok = false; break; }
          kind = ak; tot += pk;
        }
        if (!ok) continue;
        const score = tot / k;
        if (score >= 0.45 && (!best || score > best.score)) best = { k, score, acc: kind };
      }
      if (best) { n = best.k; acc = best.acc; pn = best.score; }
    }
    return { n, acc, pn };
  };
  const count = (r) => { type = r.acc; if (r.acc === 'sharp') sharps += r.n; else flats += r.n; confSum += r.pn * r.n; };
  // photos: the first accidental often blurs into the clef — a clef component much wider than any
  // clef glyph is cut at its thinnest column after the clef body, and the tail is classified
  const cb = st.clefBox;
  if (cb && nol && ctx.photoPipe) {
    const maxW = { treble: 3.15, bass: 3.35, alto: 3.4 }[st.clef] || 3.3;
    if (cb.w > maxW * sp) {
      let cut = -1, best = Infinity;
      for (let xx = Math.round(cb.x0 + 2.1 * sp); xx <= Math.round(cb.x1 - 0.6 * sp); xx++) {
        let n = 0; for (let yy = cb.y0; yy <= cb.y1; yy++) n += nol[yy * w + xx];
        if (n < best) { best = n; cut = xx; }
      }
      const tail = cut > 0 ? inkBox(cut + 1, cb.x1, cb.y0, cb.y1) : null;
      if (tail && tail.y1 - tail.y0 >= 1.5 * sp && tail.y1 - tail.y0 <= 4.0 * sp) {
        const u = { ...tail, w: tail.x1 - tail.x0 + 1, h: tail.y1 - tail.y0 + 1 };
        const r = classifyUnit(u);
        if (r.n && r.pn >= 0.6) { count(r); tailCounted = true; }
      }
    }
  }
  // staff-line removal can cut an accidental into pieces (a flat's stem and bowl, a
  // natural's strokes): a narrow piece absorbs the component right of it first
  const units = [];
  for (const c of inHeader) {
    const u = units[units.length - 1];
    const narrow = (q) => q.x1 - q.x0 + 1 < 0.45 * sp;
    // (or a piece stacked on it: a thin sharp cut in two by a staff line — same columns, small gap)
    const ovx = u ? Math.min(u.x1, c.x1) - Math.max(u.x0, c.x0) + 1 : 0;
    const stacked = u && ovx >= 0.6 * Math.min(u.w, c.w) && c.y0 - u.y1 <= 0.5 * sp && u.y0 - c.y1 <= 0.5 * sp && u.h < 1.5 * sp && c.h < 1.5 * sp && Math.max(u.y1, c.y1) - Math.min(u.y0, c.y0) + 1 <= 3.6 * sp;
    if (u && ((c.x0 >= u.x0 && c.x0 <= u.x1 + 0.34 * sp && narrow(u) && Math.max(u.x1, c.x1) - u.x0 + 1 <= 1.35 * sp) || stacked)) {
      u.x0 = Math.min(u.x0, c.x0); u.x1 = Math.max(u.x1, c.x1); u.y0 = Math.min(u.y0, c.y0); u.y1 = Math.max(u.y1, c.y1);
      u.w = u.x1 - u.x0 + 1; u.h = u.y1 - u.y0 + 1; u.area += c.area; u.ids.push(c.id);
      continue;
    }
    units.push({ id: c.id, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, w: c.w, h: c.h, area: c.area, ids: [c.id] });
  }
  for (const c of units) {
    // (a unit that starts before the clef's end but lies mostly after it is the first accidental:
    // wide sharps reach under the bass clef's dots)
    if (c.x0 < lastX - 0.3 * sp && (c.ids.some(id => st.headerLabels.includes(id)) || (c.x0 + c.x1) / 2 < lastX + 0.2 * sp)) continue;
    if (c.x0 > lastX + 1.6 * sp) break;
    const hsp = c.h / sp, wsp = c.w / sp;
    // small blobs right after the clef (big bass-clef dots, clef debris) do not end the key signature
    if (!type && hsp < 1.45 && wsp < 1.2 && c.x0 < x + 1.2 * sp) { lastX = Math.max(lastX, c.x1); x = Math.max(x, c.x1 + 0.2 * sp); st.headerLabels.push(...c.ids); continue; }
    // (merged runs of accidentals at different heights are up to ~6 sp tall)
    if (hsp < 1.5 || hsp > (wsp > 1.25 ? 6.3 : 4.6) || wsp < 0.35 || wsp > 7.5) break;
    const r = classifyUnit(c);
    if (!r.n) {
      // the last accidentals blurred together (or into the time signature / the first note): after a
      // run of accidentals of one kind the unit is cut at the run's own step (key-signature accidentals
      // are evenly spaced) and each piece is classified on its own
      const nRun = sharps + flats;
      if (type && nol && nRun && c.x0 <= lastX + 0.8 * sp) {
        const step = xs.length >= 2 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : accW / nRun;
        const wa = Math.min(accW / nRun, step + 0.15 * sp);
        if (step >= 0.6 * sp && c.w > 1.3 * wa) {
          for (let j = 0; j < 7 && sharps + flats < 7; j++) {
            const xa = Math.round(c.x0 + j * step), xb = Math.round(xa + wa);
            if (xa > c.x1 - 0.5 * sp) break;
            const core = inkBox(Math.round(xa + 0.2 * wa), Math.round(xb - 0.2 * wa), c.y0, c.y1);
            if (!core || core.y1 - core.y0 + 1 < 1.5 * sp) break;
            const u = { x0: xa, x1: Math.min(xb, c.x1), y0: core.y0, y1: core.y1 };
            u.w = u.x1 - u.x0 + 1; u.h = u.y1 - u.y0 + 1;
            const q = glyphHook.probs(u);
            if (!(q[type] >= 0.7 && q[type] >= q.none)) break;
            count({ n: 1, acc: type, pn: q[type] * 0.9 }); lastX = u.x1; x = u.x1 + 0.2 * sp;
          }
        }
      }
      break;
    }
    if (type && r.acc !== type) break;
    count(r);
    accW += c.w; if (r.n === 1) xs.push(c.x0);
    st.headerLabels.push(...c.ids); lastX = c.x1; x = c.x1 + 0.2 * sp;
    if (sharps + flats >= 7) break;
  }
  // the first accidental blurred into a too-wide clef and the tail cut failed: one step before the
  // first counted accidental (the run's own spacing) lies inside the clef component
  if (cb && nol && ctx.photoPipe && !tailCounted && type && xs.length >= 2 && sharps + flats < 7) {
    const maxW = { treble: 3.15, bass: 3.35, alto: 3.4 }[st.clef] || 3.3;
    const step = (xs[xs.length - 1] - xs[0]) / (xs.length - 1), wa = Math.min(accW / (sharps + flats), step + 0.15 * sp);
    const xa = Math.round(xs[0] - step), xb = Math.round(xa + wa);
    if (cb.w > maxW * sp && xa > cb.x0 + 2.1 * sp && xb <= cb.x1 + 0.3 * sp) {
      const core = inkBox(Math.round(xa + 0.2 * wa), Math.round(xb - 0.2 * wa), cb.y0, cb.y1);
      if (core && core.y1 - core.y0 + 1 >= 1.5 * sp && core.y1 - core.y0 + 1 <= 3.6 * sp) {
        const u = { x0: xa, x1: xb, y0: core.y0, y1: core.y1, w: xb - xa + 1, h: core.y1 - core.y0 + 1 };
        const q = glyphHook.probs(u);
        if (q[type] >= 0.7 && q[type] >= q.none) count({ n: 1, acc: type, pn: q[type] * 0.9 });
      }
    }
  }
  const nAcc = Math.min(7, sharps + flats);
  st.keyConf = nAcc ? confSum / (sharps + flats) : 0;
  return { sharps: Math.min(7, sharps), flats: Math.min(7, flats), x };
}

/** System-level barlines: thin vertical objects spanning a staff (or the whole
 * system) exactly, with nothing attached at their ends. */
function detectBarlines(ctx, sys, prims, nolines) {
  const { w, h, sp } = ctx;
  const { vobjs, heads } = prims;
  const top = sys.staves[0], bot = sys.staves[sys.staves.length - 1];
  const cands = [];
  for (const o of vobjs) {
    const xi = clamp(rnd(o.x), 0, w - 1);
    const sysTop = top.lines[0][xi], sysBot = bot.lines[4][xi];
    const tolerance = 0.5 * sp;
    let span = null;
    if (Math.abs(o.y0 - sysTop) < tolerance && Math.abs(o.y1 - sysBot) < tolerance) span = 'system';
    else for (const st of sys.staves) if (Math.abs(o.y0 - st.lines[0][xi]) < tolerance && Math.abs(o.y1 - st.lines[4][xi]) < tolerance) span = 'staff';
    if (!span) continue;
    if (o.x < top.x0 - sp || o.x > top.x1 + sp) continue;
    // nothing attached at the ends (stems carry heads / beams / flags there)
    // "attached" = ink touching the object's flanks near an end (a head, beam
    // or flag is connected to its stem there; a barline has clean flanks).
    // The rows of the staff line itself are skipped (remnants at the junction).
    let attached = 0;
    for (const [yy, dy] of [[o.y0, 1], [o.y1, -1]]) for (const xx of [o.x0 - 2, o.x0 - 1, o.x1 + 1, o.x1 + 2]) {
      for (let k = ctx.t + 2; k < 0.9 * sp; k += 1) if (inkAt(nolines, w, h, xx, yy + dy * k) && vRunLen(nolines, w, h, xx, yy + dy * k) < 1.6 * sp) attached++;
    }
    if (attached > 3) continue;
    if (heads.some(hd => Math.abs(hd.cx - o.x) < 1.1 * sp && (Math.abs(hd.cy - o.y0) < 0.8 * sp || Math.abs(hd.cy - o.y1) < 0.8 * sp))) continue;
    if (span === 'staff' && sys.staves.length > 1) {
      // a per-staff candidate must have a partner in the other staff at the same x
      const partners = vobjs.filter(p => p !== o && Math.abs(p.x - o.x) < 0.6 * sp);
      if (!partners.some(p => sys.staves.some(st => st !== staffOf(sys.staves, (o.y0 + o.y1) / 2, sp) && Math.abs(p.y0 - st.lines[0][xi]) < tolerance && Math.abs(p.y1 - st.lines[4][xi]) < tolerance))) continue;
    }
    cands.push(o);
  }
  cands.sort((a, b) => a.x - b.x);
  // group close candidates: double / final / repeat
  const groups = [];
  for (const c of cands) {
    const g = groups[groups.length - 1];
    if (g && c.x - g.x1 < 1.3 * sp) { g.members.push(c); g.x1 = c.x1; } else groups.push({ members: [c], x0: c.x0, x1: c.x1 });
  }
  for (const g of groups) {
    g.x = (g.x0 + g.x1) / 2;
    const thick = g.members.some(m => m.width >= 0.35 * sp);
    g.type = g.members.length === 1 ? 'single' : thick ? 'final' : 'double';
    // repeat dots: two small blobs in spaces 2 and 3 next to the group
    const xi = clamp(rnd(g.x), 0, w - 1);
    const dots = (side) => {
      let n = 0;
      for (const st of sys.staves) {
        const l0 = st.lines[0][xi], half = (st.lines[4][xi] - l0) / 8;
        for (const p of [3, 5]) { const yy = l0 + p * half; for (let dx = 0.5 * sp; dx <= 1.8 * sp; dx += 1) if (inkAt(nolines, w, h, side < 0 ? g.x0 - dx : g.x1 + dx, yy)) { n++; break; } }
      }
      return n >= 2 * sys.staves.length;
    };
    const dl = dots(-1), dr = dots(1);
    if (thick || g.members.length > 1) {
      if (dl && dr) g.type = 'repeat-both'; else if (dl) g.type = 'repeat-end'; else if (dr) g.type = 'repeat-start';
    }
    for (const m of g.members) m.isBarline = true;
  }
  for (const s of prims.stems) if (cands.includes(s)) s.isBarline = true;
  sys.barlines = groups;
}

// ---------------------------------------------------------------------------
// Stage 6: assemble ScoreDoc
// ---------------------------------------------------------------------------
const ACC_ALTER = { sharp: 1, flat: -1, natural: 0 };

export function assemble(ctx, staves, cls, image, options = {}) {
  const { sp } = ctx;
  const { events, systems } = cls;
  const warnings = [...cls.warnings];
  const systemList = systems.filter(Boolean);
  // --- parts / staff layout ---------------------------------------------------
  const perSystem = systemList.map(s => s.staves.length);
  const staffCount = perSystem.length ? Math.max(...perSystem) : 1;
  const clefVote = (si) => {
    // (confidence-weighted: a size-rule guess counts less than a classified clef; the usual clef of the
    // staff — the lower staff of a grand staff is bass — is a prior that weak size-rule guesses alone
    // (0.35 each) only outvote on several systems)
    const def = staffCount === 2 && si === 1 ? 'bass' : 'treble';
    const votes = { [def]: staffCount === 2 ? 0.75 : 0.1 };
    for (const sys of systemList) { const st = sys.staves[si]; if (st && !st.clefMissing) votes[st.clef] = (votes[st.clef] || 0) + (st.clefConf ?? 0.6); }
    return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  };
  const clefs = []; for (let i = 0; i < staffCount; i++) clefs.push(clefVote(i));
  let instruments;
  if (staffCount === 2) instruments = ['piano'];
  else instruments = clefs.map(c => (c === 'bass' ? 'cello' : c === 'alto' ? 'viola' : 'keyboard'));
  // key / time signature by majority over all staves
  const keyVotes = {}, tsVotes = {};
  // (time signature: the first system's counts more, a meter no real piece uses (a measure number or
  // stray marks at a later staff start read as "1/4") counts little)
  const firstSys = Math.min(...staves.map(st => st.systemIndex ?? 0));
  for (const st of staves) {
    keyVotes[st.keyFifths] = (keyVotes[st.keyFifths] || 0) + 1;
    if (st.timeSig) {
      const k = `${st.timeSig.num}/${st.timeSig.den}/${st.timeSig.display}`;
      const wt = ((st.systemIndex ?? 0) === firstSys ? 1.5 : 1) * (PLAUSIBLE_METERS.has(`${st.timeSig.num}/${st.timeSig.den}`) ? 1 : 0.25);
      tsVotes[k] = (tsVotes[k] || 0) + wt;
    }
  }
  let keyFifths = options.keyFifths != null ? options.keyFifths : parseInt((Object.entries(keyVotes).sort((a, b) => b[1] - a[1])[0] || ['0'])[0], 10);
  // a misread key signature is mostly "nothing found" (0); the same non-zero key on
  // several staves is strong evidence (photo pipeline: broken clefs, faint headers)
  if (options.keyFifths == null && !options.legacyPreprocess) {
    // the key signature is repeated on every staff: confidence-weighted vote over the page ("nothing
    // found" is a weak vote), explicit accidentals in the music break near ties
    const ranked = voteKey(staves, ctx.sp / (ctx.scale || 1) <= 11);
    keyFifths = ranked[0][0];
    if (ranked.length > 1 && ranked[1][1] >= 0.7 * ranked[0][1]) {
      const score = (k) => accidentalEvidence(events, k);
      if (score(ranked[1][0]) > score(ranked[0][0]) + 1) keyFifths = ranked[1][0];
    }
  }
  let timeSig = null;
  if (options.timeSig) timeSig = { ...options.timeSig, display: 'normal' };
  else { const best = Object.entries(tsVotes).sort((a, b) => b[1] - a[1])[0]; if (best) { const [num, den, display] = best[0].split('/'); timeSig = { num: +num, den: +den, display }; } }
  const score = createScore({ title: '', instruments, measures: 0, timeSig: timeSig || { num: 4, den: 4 }, keyFifths, tempo: 0 });
  score.parts.forEach((p, pi) => p.staves.forEach((s, si) => { const idx = staffCount === 2 ? si : pi; s.clef = clefs[idx] || s.clef; }));
  score.sources = [{ id: 'src1', name: 'photo', mime: 'image/png', width: image.width, height: image.height, file: 'sources/src1.png', staves: [] }];
  // --- measures per system --------------------------------------------------
  const rawMeasures = [];   // { sys, x0, x1, staves: [events per staff] }
  for (const sys of systemList) {
    const top = sys.staves[0];
    const bars = (sys.barlines || []).filter(b => b.x > top.headerEnd - 0.5 * sp).sort((a, b) => a.x - b.x);
    const sysEvents = events.filter(ev => sys.staves.includes(ev.staff));
    let x = Math.max(top.headerEnd, ...sys.staves.map(s => s.headerEnd)) - 0.6 * sp;
    const bounds = [];
    for (const b of bars) { bounds.push({ x0: x, x1: b.x0, bar: b }); x = b.x1; }
    const lastX = Math.max(...sys.staves.map(s => s.x1));
    if (lastX - x > 2 * sp && sysEvents.some(ev => ev.x > x)) bounds.push({ x0: x, x1: lastX, bar: null });
    for (const bd of bounds) {
      if (bd.x1 - bd.x0 < 1.5 * sp) continue;
      const inside = sysEvents.filter(ev => ev.x >= bd.x0 - 0.3 * sp && ev.x < bd.x1 + 0.3 * sp);
      if (!inside.length && bd.x1 - bd.x0 < 3 * sp) continue;
      rawMeasures.push({ sys, x0: bd.x0, x1: bd.x1, bar: bd.bar, staves: sys.staves.map(st => inside.filter(ev => ev.staff === st).sort((a, b) => a.x - b.x)) });
    }
  }
  if (!timeSig) {
    timeSig = inferTimeSig(rawMeasures, options) || { num: 4, den: 4, display: 'normal' };
    warnings.push(`박자표를 인식하지 못해 ${timeSig.num}/${timeSig.den}로 가정했습니다.`);
  } else if (!options.timeSig && !options.legacyPreprocess && rawMeasures.length >= 6) {
    // photo pipeline: a misread time signature disagrees with the measures' contents — if
    // almost no measure fits it but most share another common length, trust the contents
    const ticksOf = (ev) => durTicks({ dur: { base: ev.base, dots: ev.dots } });
    const tot = rawMeasures.slice(1, -1).map(rm => rm.staves[0].reduce((a, ev) => a + ticksOf(ev), 0)).filter(T => T > 0);
    const cap = measureCapacity(timeSig);
    const fit = tot.filter(T => Math.abs(T - cap) < 1).length;
    const alt = inferTimeSig(rawMeasures.slice(1, -1), options);
    if (alt && tot.length >= 5 && fit <= 0.2 * tot.length) {
      const capAlt = measureCapacity(alt);
      if (capAlt !== cap && tot.filter(T => Math.abs(T - capAlt) < 1).length >= 0.6 * tot.length) timeSig = { ...alt, display: 'normal' };
    }
  }
  if (staves.some(s => s.clefMissing)) warnings.push('일부 오선의 음자리표를 인식하지 못해 다른 줄과 같은 음자리표로 가정했습니다.');
  const capacity = measureCapacity(timeSig);
  const resultMeasures = [], resultSymbols = [];
  const tieCarry = [];
  let measureConfSum = 0;
  DECODE_T = options.decodeT ?? DECODE_T_DEFAULT;
  DOT_ADD_COST = options.dotAddCost ?? 2.5;
  splitOverfullMeasures(rawMeasures, capacity);
  if (!options.legacyPreprocess) mergeUnderfullMeasures(rawMeasures, capacity);
  rawMeasures.forEach((rm, mi) => {
    const m = createMeasure(score);
    if (mi === 0) { m.timeSig = timeSig; m.keySig = { fifths: keyFifths, mode: 'major' }; }
    if (rm.bar) { if (['double', 'final', 'repeat-end', 'repeat-both'].includes(rm.bar.type)) m.barlineRight = rm.bar.type === 'repeat-both' ? 'repeat-both' : rm.bar.type; }
    const prev = rawMeasures[mi - 1];
    if (prev && prev.bar && (prev.bar.type === 'repeat-start' || prev.bar.type === 'repeat-both')) m.barlineLeft = 'repeat-start';
    let conf = 1, yTop = Infinity, yBot = -Infinity;
    rm.staves.forEach((evs, si) => {
      const st = rm.sys.staves[si];
      const globalIdx = staffCount === 2 ? si : Math.min(si, m.staves.length - 1);
      if (globalIdx >= m.staves.length) return;
      const voice = m.staves[globalIdx].voices[0];
      // a clef that was not found is the clef of the same staff in the other systems (not treble);
      // an uncertain clef that disagrees with the page majority follows it too
      const clef = st.clefMissing || (st.clef !== clefs[globalIdx] && (st.clefConf ?? 1) < 0.8) ? clefs[globalIdx] : st.clef;
      if (clef !== clefs[globalIdx] && rm.sys.staves[si] && rawMeasures.findIndex(r => r.sys === rm.sys) === mi) m.staves[globalIdx].clef = clef;
      const accState = {};
      const carry = tieCarry[globalIdx] || (tieCarry[globalIdx] = {});
      for (const ev of evs) {
        let e;
        if (ev.kind === 'rest') e = makeRest(ev.base, ev.dots);
        else {
          e = { id: newId(), kind: 'note', dur: { base: ev.base, dots: ev.dots }, notes: [] };
          for (const hd of ev.heads) {
            const n = noteAtStaffPosition(hd.pos, clef);
            const key = n.step + n.octave;
            if (hd.accidental) { n.alter = ACC_ALTER[hd.accidental]; accState[key] = n.alter; n.accidental = hd.accidental; }
            else if (ev.tieEnd && carry[key] != null) n.alter = carry[key];    // a tied note keeps its accidental
            else n.alter = accState[key] != null ? accState[key] : keyAlter(n.step, keyFifths);
            if (ev.tieStart) n.tieStart = true;
            if (ev.tieEnd) n.tieEnd = true;
            e.notes.push(n);
          }
          for (const k of Object.keys(carry)) delete carry[k];
          if (ev.tieStart) for (const n of e.notes) carry[n.step + n.octave] = n.alter;
          e.notes.sort((a, b) => (a.octave * 7 + 'CDEFGAB'.indexOf(a.step)) - (b.octave * 7 + 'CDEFGAB'.indexOf(b.step)));
          if (ev.stem) e.stem = ev.stem.dir;
        }
        const bb = ev.bbox;
        e.source = { bbox: ctx.bboxToOrig([bb.x0, bb.y0, bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1]), confidence: ev.conf };
        e._conf = ev.conf;
        Object.defineProperty(e, '_det', { value: ev, enumerable: false, configurable: true });
        voice.push(e);
        ev.eventId = e.id;
      }
      if (!options.legacyPreprocess) Object.defineProperty(voice, '_keepNotes', { value: true, enumerable: false, configurable: true });
      const first = mi === 0 && rm === rawMeasures[0];
      const fit = options.noFit ? { conf: 1 } : (!options.legacyPreprocess && options.decode !== false && decodeVoice(voice, capacity, first)) || fitVoice(voice, capacity, first);   // noFit: diagnostics only
      // a measure holding only a rest that fills it is a full-measure rest: a whole rest in any meter
      // (the app's convention, like the Finale / MusicXML importers; the decoder made it e.g. a dotted half in 3/4)
      if (voice.length === 1 && voice[0].kind === 'rest' && !fit.pickup && !voice[0].tuplet && Math.abs(durTicks(voice[0]) - capacity) < 1) { voice[0].dur = { base: 'whole', dots: 0 }; voice[0].fullMeasureRest = true; }
      conf = Math.min(conf, fit.conf);
      if (fit.pickup) m.pickup = true;
      if (fit.conf < 0.6) warnings.push(`${mi + 1}번째 마디의 박자가 맞지 않습니다.`);
      const xi = clamp(rnd((rm.x0 + rm.x1) / 2), 0, ctx.w - 1);
      yTop = Math.min(yTop, st.lines[0][xi]); yBot = Math.max(yBot, st.lines[4][xi]);
    });
    for (const sm of m.staves) for (const v of sm.voices) for (const e of v) delete e._conf;
    const bbox = ctx.bboxToOrig([rm.x0, yTop - 2 * sp, rm.x1 - rm.x0, yBot - yTop + 4 * sp]);
    m.source = { sourceId: 'src1', bbox, confidence: conf };
    score.measures.push(m);
    resultMeasures.push({ measureId: m.id, bbox, confidence: conf });
    measureConfSum += conf;
    for (const evs of rm.staves) for (const ev of evs) resultSymbols.push(ev);
  });
  if (!score.measures.length) {
    const m = createMeasure(score); m.timeSig = timeSig; m.keySig = { fifths: keyFifths, mode: 'major' }; score.measures.push(m);
    warnings.push('악보에서 마디를 찾지 못했습니다.');
  }
  // --- staves of the result ----------------------------------------------------
  const resStaves = staves.map(st => {
    const xi = clamp(rnd((st.x0 + st.x1) / 2), 0, ctx.w - 1);
    const lineYs = [0, 1, 2, 3, 4].map(i => ctx.toOrig(xi, st.lines[i][xi])[1]);
    const bbox = ctx.bboxToOrig([st.x0, st.lines[0][xi], st.x1 - st.x0, st.lines[4][xi] - st.lines[0][xi]]);
    const si = systemList[st.systemIndex] ? systemList[st.systemIndex].staves.indexOf(st) : 0;
    return { bbox, lineYs, spacing: st.spacing / ctx.scale, partIndex: staffCount === 2 ? 0 : si, staffIndex: staffCount === 2 ? si : 0, systemIndex: st.systemIndex };
  });
  score.sources[0].staves = resStaves.map((s, i) => ({ bbox: s.bbox, measureIds: score.measures.filter((m, mi) => rawMeasures[mi] && rawMeasures[mi].sys.staves.includes(staves[i])).map(m => m.id) }));
  validateScore(score, { repair: true });
  const confidence = rawMeasures.length ? measureConfSum / rawMeasures.length * (staves.length ? 1 : 0) : 0;
  return { score, confidence, warnings, staves: resStaves, measures: resultMeasures, symbols: resultSymbols };
}

/** A measure whose staves all hold ≈ k whole measures of music most likely
 * lost k-1 barlines; split it where every staff's running total crosses a
 * multiple of the capacity between two events. */
function splitOverfullMeasures(rawMeasures, capacity) {
  const ticksOf = (ev) => durTicks({ dur: { base: ev.base, dots: ev.dots } });
  for (let i = 0; i < rawMeasures.length; i++) {
    const rm = rawMeasures[i];
    const totals = rm.staves.map(evs => evs.reduce((a, ev) => a + ticksOf(ev), 0));
    const k = Math.round(Math.max(...totals) / capacity);
    if (k < 2 || !totals.every(T => Math.abs(T - k * capacity) <= capacity * 0.13)) continue;
    const pieces = rm.staves.map(() => []);
    let ok = true;
    for (let si = 0; si < rm.staves.length && ok; si++) {
      let acc = 0, cur = [];
      for (const ev of rm.staves[si]) {
        cur.push(ev); acc += ticksOf(ev);
        if (acc >= capacity - 1) { pieces[si].push(cur); cur = []; acc = 0; }
      }
      if (cur.length) pieces[si].push(cur);
      if (pieces[si].length !== k) ok = false;
    }
    if (!ok) continue;
    const out = [];
    for (let j = 0; j < k; j++) {
      const evs = pieces.map(p => p[j]);
      const xs = evs.flat().map(ev => ev.x);
      const x0 = j === 0 ? rm.x0 : Math.min(...xs) - 1, x1 = j === k - 1 ? rm.x1 : Math.max(...pieces.map(p => p[j]).flat().map(ev => ev.x)) + 1;
      out.push({ ...rm, x0, x1, bar: j === k - 1 ? rm.bar : null, staves: evs, split: true });
    }
    rawMeasures.splice(i, 1, ...out);
    i += k - 1;
  }
}

/** How well the explicit accidentals of the music agree with key `k`: a natural
 * implies the step is altered by the key signature, a sharp / flat that the key
 * already gives is redundant (rare). */
function accidentalEvidence(events, k) {
  let sc = 0;
  for (const ev of events) {
    if (ev.kind !== 'note' || !ev.staff) continue;
    const clef = ev.staff.clef || 'treble';
    for (const hd of ev.heads) {
      if (!hd.accidental) continue;
      const step = noteAtStaffPosition(hd.pos, clef).step, inKey = keyAlter(step, k);
      if (hd.accidental === 'natural') sc += inKey ? 1 : -1;
      else if (hd.accidental === 'sharp') sc += inKey === 1 ? -0.5 : 0.5;
      else if (hd.accidental === 'flat') sc += inKey === -1 ? -0.5 : 0.5;
    }
  }
  return sc;
}

/** Page key vote (photo pipeline): confidence-weighted over all staves, "nothing found" (0) is a weak
 * vote.  On low-resolution photos (≤ 11 px staff space) the key signature is often not seen at all on
 * most staves, so "nothing found" counts little there — but a key read on a single staff must be clear
 * (≥ 3 confident accidentals: one or two accidentals after the clef are often the first notes'). */
function voteKey(staves, lowRes) {
  const nk = {}, ck = {};
  for (const st of staves) { const k = st.keyFifths || 0; nk[k] = (nk[k] || 0) + 1; ck[k] = Math.max(ck[k] || 0, st.keyConf || 0); }
  const vote = (zeroW, ok) => {
    const w = {};
    for (const st of staves) { const k = st.keyFifths || 0; if (ok(k)) w[k] = (w[k] || 0) + (k === 0 ? zeroW : 0.4 + 0.6 * (st.keyConf || 0.5)); }
    return Object.entries(w).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1]);
  };
  let ranked = vote(0.35, () => true);
  if (lowRes && ranked.length && ranked[0][0] === 0) {
    const r2 = vote(0.12, (k) => k === 0 || nk[k] >= 2 || (Math.abs(k) >= 3 && ck[k] >= 0.8));
    if (r2.length && r2[0][0] !== 0) ranked = r2;
  }
  return ranked.length ? ranked : [[0, 0]];
}

/** The converse: two neighbouring measures of one system that are both clearly
 * short but add up to exactly one measure were most likely split by a false
 * barline (a stem or a thick stroke).  Only single barlines are removed, and
 * never the first measure (pickup). */
function mergeUnderfullMeasures(rawMeasures, capacity) {
  const ticksOf = (ev) => durTicks({ dur: { base: ev.base, dots: ev.dots } });
  const tot = (rm) => rm.staves.map(evs => evs.reduce((a, ev) => a + ticksOf(ev), 0));
  for (let i = 1; i + 1 < rawMeasures.length; i++) {
    const a = rawMeasures[i], b = rawMeasures[i + 1];
    if (a.sys !== b.sys || a.split || b.split) continue;
    if (a.bar && a.bar.type && a.bar.type !== 'single') continue;
    const ta = tot(a), tb = tot(b);
    let used = 0, ok = true;
    for (let si = 0; si < ta.length && ok; si++) {
      if (!ta[si] && !tb[si]) continue;
      used++;
      ok = ta[si] > 0 && tb[si] > 0 && ta[si] <= 0.76 * capacity && tb[si] <= 0.76 * capacity && Math.abs(ta[si] + tb[si] - capacity) <= 0.04 * capacity;
    }
    if (!ok || !used) continue;
    rawMeasures.splice(i, 2, { ...a, x1: b.x1, bar: b.bar, staves: a.staves.map((evs, si) => [...evs, ...b.staves[si]]), merged: true });
  }
}

/** Photo pipeline: the most likely durations that fill the measure.  Every
 * event gets a few duration options with a cost (−log probability of the
 * beam / flag classifier, head fill, dots, rest type); a dynamic program over
 * the running tick total picks the cheapest combination that sums to the
 * capacity exactly (or, at a price, stays short and is padded with rests —
 * a pickup in the first measure is cheap).  Returns {conf[, pickup]} or null
 * (then fitVoice() decides). */
const DEC_BASES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
const TRIPLET_COST = 1.2;          // per group of three: chosen only when the measure needs it
const DECODE_T_DEFAULT = 0.6;     // (classifier is over-confident when wrong; 0.5–0.7 equal on dev)
let DECODE_T = 1;                  // temperature of the beam / flag classifier's costs (options.decodeT)
let DOT_ADD_COST = 2.5;            // cost of adding an undetected augmentation dot (options.dotAddCost)
function decodeVoice(voice, capacity, first) {
  if (!voice.length || voice.length > 48) return null;
  const U = 10;                                   // tick unit (triplet 16ths are 160 ticks)
  const cap = Math.round(capacity / U);
  if (cap * U !== capacity) return null;
  const T0 = voice.reduce((a, e) => a + durTicks(e), 0);
  if (Math.abs(T0 - capacity) < 1) return { conf: 1 };
  const nl = (p) => -DECODE_T * Math.log(Math.max(1e-3, p));
  const baseCost = voice.map(e => {
    const d = e._det || {};
    const base = e.dur.base;
    const cand = new Map();     // base → cost
    if (e.kind === 'note' && d.stem && !d.hollow) {
      const p = d.rprobs;
      ['quarter', 'eighth', '16th', '32nd'].forEach((b, i) => cand.set(b, p ? nl(p[i]) : (b === base ? 0 : Math.abs(DEC_BASES.indexOf(b) - DEC_BASES.indexOf(base)) * 2.5)));
      cand.set('half', (cand.get('quarter') || 0) + 3);                       // a filled head misread
    } else if (e.kind === 'note' && d.stem) {
      cand.set('half', 0); cand.set('quarter', 2.5); cand.set('whole', 4);
    } else if (e.kind === 'note') {
      cand.set('whole', 0); cand.set('half', 3);
    } else {
      const i = DEC_BASES.indexOf(base);
      DEC_BASES.forEach((b, j) => { if (Math.abs(i - j) <= 1) cand.set(b, Math.abs(i - j) * 2.5); });
    }
    return cand;
  });
  const opts = voice.map((e, k) => {
    const dots = e.dur.dots || 0, o = [];
    for (const [b, c] of baseCost[k]) for (const dt of [dots, dots ? 0 : 1]) {
      const t = durTicks({ dur: { base: b, dots: dt } });
      if (t % U === 0) o.push({ base: b, dots: dt, u: t / U, cost: c + (dt === dots ? 0 : dots ? 2.0 : DOT_ADD_COST) });
    }
    return o;
  });
  // DP over events; state = running total in units.  Moves: one event with one of its options,
  // or three events as a triplet (three equal values in the time of two)
  const INF = 1e9, n = voice.length;
  const best = Array.from({ length: n + 1 }, () => new Float64Array(cap + 1).fill(INF));
  const from = Array.from({ length: n + 1 }, () => new Array(cap + 1).fill(null));
  best[0][0] = 0;
  for (let k = 0; k < n; k++) for (let t = 0; t <= cap; t++) {
    const c0 = best[k][t];
    if (c0 >= INF) continue;
    opts[k].forEach((o, j) => { const t2 = t + o.u; if (t2 <= cap && c0 + o.cost < best[k + 1][t2]) { best[k + 1][t2] = c0 + o.cost; from[k + 1][t2] = { t, j }; } });
    if (k + 2 < n) for (const b of ['quarter', 'eighth', '16th']) {
      let c = c0 + TRIPLET_COST;
      for (let q = k; q <= k + 2 && c < INF; q++) { const bc = baseCost[q].get(b); c = bc == null || voice[q].dur.dots ? INF : c + bc; }
      if (c >= INF) continue;
      const t2 = t + 2 * durTicks({ dur: { base: b, dots: 0 } }) / U;
      if (t2 <= cap && c < best[k + 3][t2]) { best[k + 3][t2] = c; from[k + 3][t2] = { t, triplet: b }; }
    }
  }
  // exact fill, or short (padded with rests): price grows with the gap; a pickup is cheap
  const raw = T0 / capacity;
  let bestT = -1, bestC = INF;
  for (let t = 0; t <= cap; t++) {
    if (best[n][t] >= INF) continue;
    const gap = (cap - t) / cap;
    const c = best[n][t] + (t === cap ? 0 : first && raw <= 0.75 ? 0.5 + gap : 3 + 6 * gap);
    if (c < bestC) { bestC = c; bestT = t; }
  }
  if (bestT < 0 || bestC > 9) return null;
  for (let k = n, t = bestT; k > 0;) {
    const f = from[k][t];
    if (f.triplet) {
      const tup = { id: newId(), num: 3, den: 2, show: 'number' };
      for (let q = k - 3; q < k; q++) { voice[q].dur = { base: f.triplet, dots: 0 }; voice[q].tuplet = { ...tup }; }
      k -= 3;
    } else {
      const o = opts[k - 1][f.j];
      voice[k - 1].dur = { base: o.base, dots: o.dots };
      delete voice[k - 1].tuplet;
      k -= 1;
    }
    t = f.t;
  }
  if (bestT < cap) padVoiceWithRests(voice, capacity);
  const pickup = first && bestT < cap && raw <= 0.75;
  const conf = bestC < 0.7 ? 0.95 : bestC < 2 ? 0.8 : bestC < 4 ? 0.6 : 0.45;
  return pickup ? { conf: Math.min(conf, 0.75), pickup: true } : { conf };
}

/** Make a voice sum to the measure capacity: re-label the least confident
 * durations first, then pad / trim with rests. Returns {conf, pickup}. */
function fitVoice(voice, capacity, first) {
  const total = () => voice.reduce((s, e) => s + durTicks(e), 0);
  let T = total();
  if (Math.abs(T - capacity) < 1) return { conf: 1 };
  if (!voice.length) return { conf: 0.4 };
  const halve = { whole: 'half', half: 'quarter', quarter: 'eighth', eighth: '16th', '16th': '32nd' };
  const dbl = { half: 'whole', quarter: 'half', eighth: 'quarter', '16th': 'eighth', '32nd': '16th' };
  let conf = 0.7;
  // one-step repairs: a dot that was missed / spurious, or one beam miscount
  const tryFix = (fn) => { for (const e of voice.slice().sort((a, b) => (a._conf || 1) - (b._conf || 1))) { const saved = JSON.stringify(e.dur); fn(e); if (Math.abs(total() - capacity) < 1) return true; e.dur = JSON.parse(saved); } return false; };
  if (T < capacity) {
    if (tryFix(e => { if (!e.dur.dots) e.dur.dots = 1; })) return { conf };
    if (tryFix(e => { if (dbl[e.dur.base]) e.dur.base = dbl[e.dur.base]; })) return { conf };
  } else {
    if (tryFix(e => { if (e.dur.dots) e.dur.dots = 0; })) return { conf };
    if (tryFix(e => { if (halve[e.dur.base]) e.dur.base = halve[e.dur.base]; })) return { conf };
  }
  T = total();
  if (T > capacity) {
    // halve the least confident events once each (never below a 16th); if
    // the measure is still too long, trim the tail — those were probably
    // misread anyway and the user will see the low confidence mark
    const cands = voice.filter(e => halve[e.dur.base] && e.dur.base !== '16th').sort((a, b) => (a._conf || 1) - (b._conf || 1));
    for (const c of cands) { if (total() <= capacity + 1) break; c.dur.base = halve[c.dur.base]; }
    // photo pipeline (voice._keepNotes): keep the notes — their pitches are usually right — and shorten
    // durations further (dots first, then halving down to 32nds) before dropping anything
    if (voice._keepNotes) {
      for (let round = 0; round < 3 && total() > capacity + 1; round++) {
        for (const c of voice.slice().sort((a, b) => (a._conf || 1) - (b._conf || 1))) {
          if (total() <= capacity + 1) break;
          if (c.dur.dots) c.dur.dots = 0; else if (halve[c.dur.base]) c.dur.base = halve[c.dur.base];
        }
      }
    }
    while (voice.length && total() > capacity + 1) voice.pop();
    conf = 0.4;
  } else if (first && T >= capacity * 0.2 && T <= capacity * 0.6) {
    return { conf: 0.75, pickup: true };
  } else conf = 0.5;
  padVoiceWithRests(voice, capacity);
  return { conf };
}

/** When no time signature was read, use the most common measure length. */
function inferTimeSig(rawMeasures, options) {
  const counts = {};
  for (const rm of rawMeasures) for (const evs of rm.staves) {
    const T = evs.reduce((s, ev) => s + durTicks({ dur: { base: ev.base, dots: ev.dots } }), 0);
    if (T > 0) counts[T] = (counts[T] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const T = +best[0];
  const table = { 3840: [4, 4], 2880: [3, 4], 1920: [2, 4], 960: [1, 4], 4800: [5, 4], 1440: [3, 8], 5760: [6, 4], 7680: [8, 4] };
  if (table[T]) return { num: table[T][0], den: table[T][1], display: 'normal' };
  if (T % 480 === 0) return { num: T / 480, den: 8, display: 'normal' };
  void options;
  return null;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
const yieldNow = () => new Promise(r => setTimeout(r, 0));

/**
 * recognize(image, options, onProgress) → RecognitionResult (SPEC §4).
 * image: { width, height, data: Uint8ClampedArray RGBA }
 */
export async function recognize(image, options = {}, onProgress = () => {}) {
  // pipeline: 'legacy' (original), 'photo' (robust front end + rectification +
  // learned heads), or 'auto' (default): the fast original pipeline first; if
  // its result is not confident (typically a photo), the photo pipeline runs
  // too and the more confident result is returned.
  const mode = options.legacyPreprocess ? 'legacy' : (options.pipeline || 'auto');
  if (mode === 'legacy') return recognizeOnce(image, { ...options, legacyPreprocess: true }, onProgress);
  if (mode === 'photo') return recognizeOnce(image, { ...options, legacyPreprocess: false }, onProgress);
  const scaled = (a, b) => (p) => onProgress({ ...p, percent: a + (b - a) * (p.percent || 0) / 100 });
  const first = await recognizeOnce(image, { ...options, legacyPreprocess: true }, scaled(0, 40));
  // a confident result is kept unless it is implausible: a meter guessed from the measures (no time
  // signature read) that no real piece uses, or a single short staff — the original front end found
  // one staff of a low-resolution photo, whose few "measures" then fit a made-up meter (1/4, 14/8)
  const ts0 = first.score && first.score.measures[0] && first.score.measures[0].timeSig;
  const guessed = first.warnings.some(w => w.startsWith('박자표를 인식하지 못해'));
  const oddMeter = guessed && ts0 && !PLAUSIBLE_METERS.has(`${ts0.num}/${ts0.den}`);
  const tiny = first.staves.length === 1 && first.score.measures.length <= 3;
  // (staves without a readable clef: the original front end's header reading failed — on photos
  // the photo pipeline reads clefs and key signatures far better, so compare both)
  const clefLost = first.warnings.some(w => w.startsWith('일부 오선의 음자리표를 인식하지 못해'));
  if (first.staves.length && first.confidence >= AUTO_KEEP_CONFIDENCE && !oddMeter && !tiny && !clefLost) { onProgress({ stage: 'assemble', percent: 100, message: '완료' }); return { ...first, pipeline: 'legacy' }; }
  const second = await recognizeOnce(image, { ...options, legacyPreprocess: false }, scaled(40, 100));
  // measure-fit confidence alone favours a result that lost most notes (short
  // measures padded with rests still "fit"): weigh it by the share of notes found
  const nNotes = (r) => r.score.measures.reduce((a, m) => a + m.staves.reduce((b, s) => b + s.voices[0].filter(e => e.kind === 'note').length, 0), 0);
  // and by the share of staves found (a pipeline that lost whole systems is worse); below the
  // keep threshold the image is most likely a photo, which the photo pipeline is built for, so
  // the original result must win by a margin
  const n1 = first.staves.length ? nNotes(first) : 0, n2 = second.staves.length ? nNotes(second) : 0, nMax = Math.max(1, n1, n2);
  const sMax = Math.max(1, first.staves.length, second.staves.length);
  // (only a lopsided note count counts: one pipeline may also over-detect)
  const q1 = first.confidence * Math.min(1, n1 / nMax / 0.6) * (first.staves.length / sMax);
  const q2 = second.confidence * Math.min(1, n2 / nMax / 0.6) * (second.staves.length / sMax);
  return second.staves.length && q2 > q1 - AUTO_PHOTO_MARGIN ? { ...second, pipeline: 'photo' } : { ...first, pipeline: 'legacy' };
}
const AUTO_KEEP_CONFIDENCE = 0.9;
const AUTO_PHOTO_MARGIN = 0.05;
const PLAUSIBLE_METERS = new Set(['2/4', '3/4', '4/4', '5/4', '6/4', '2/2', '3/2', '4/2', '3/8', '6/8', '9/8', '12/8', '5/8', '7/8', '2/8', '4/8']);

async function recognizeOnce(image, options = {}, onProgress = () => {}) {
  const progress = (stage, percent, message) => { try { onProgress({ stage, percent, message }); } catch (_) { /* ignore */ } };
  progress('preprocess', 2, '이미지 전처리 중…');
  await yieldNow();
  // front end (frontend.js): robust binarisation, multi-angle staff detection
  // and staff-guided rectification; options.legacyPreprocess = original path
  let ctx, staves;
  if (options.legacyPreprocess) { ctx = preprocess(image, options); staves = detectStaves(ctx, options); }
  else ({ ctx, staves } = frontEnd(image, options, progress));
  progress('staves', 40, `오선 ${staves.length}개 검출`);
  await yieldNow();
  const result = { deskewAngle: ctx.angle * 180 / Math.PI };
  if (!staves.length) {
    const score = createScore({ title: '', instruments: ['keyboard'], measures: 1, timeSig: options.timeSig || { num: 4, den: 4 }, keyFifths: options.keyFifths || 0, tempo: 0 });
    score.sources = [{ id: 'src1', name: 'photo', mime: 'image/png', width: image.width, height: image.height, file: 'sources/src1.png', staves: [] }];
    progress('assemble', 100, '완료');
    return { ...result, score, confidence: 0, warnings: ['오선을 찾지 못했습니다. 악보가 선명하게 보이도록 다시 촬영해 주세요.'], staves: [], measures: [] };
  }
  // learned classifiers (classifiers.js, lazily imported weights; options.learned === false disables)
  if (!options.legacyPreprocess && options.learned !== false) ctx.models = { heads: await loadModel('heads'), glyphs: await loadModel('glyphs'), rhythm: options.learnedRhythm === false ? null : await loadModel('rhythm'), bars: options.learnedBars === false ? null : await loadModel('bars') };
  // the original pipeline keeps its morphological note heads but reads clefs, key / time signatures,
  // rests and accidentals with the learned glyph classifier too (it knows several music fonts)
  else if (options.legacyPreprocess && options.learned !== false && options.learnedLegacy !== false) ctx.models = { heads: null, glyphs: await loadModel('glyphs') };
  if (options.headMinProb != null) ctx.headMinProb = options.headMinProb;
  if (options.barCandMin != null) ctx.barCandMin = options.barCandMin;
  const nolines = removeStaffLines(ctx, staves);
  progress('symbols', 50, '오선 제거 완료');
  await yieldNow();
  const prims = segmentSymbols(ctx, staves, nolines);
  ctx.cc = prims.cc;
  progress('symbols', 70, `음표 후보 ${prims.heads.length}개`);
  await yieldNow();
  const cls = classify(ctx, staves, nolines, prims, options);
  progress('assemble', 88, '마디 구성 중…');
  await yieldNow();
  const out = assemble(ctx, staves, cls, image, options);
  runLyricStage(out, { ctx, staves, events: cls.events, image, nolines, options, progress });   // lyrics.js (Korean lyrics)
  progress('assemble', 100, '완료');
  const res = { ...result, score: out.score, confidence: out.confidence, warnings: out.warnings, staves: out.staves, measures: out.measures };
  if (out.lyrics) { res.lyrics = out.lyrics; res.lyricLines = out.lyricLines; res.lyricStats = out.lyricStats; }
  if (options.trace) res.trace = buildTrace(ctx, staves, prims, cls);
  if (options.debug) {
    res.symbols = out.symbols.map(ev => ({ kind: ev.kind === 'note' ? `note-${ev.base}` : `rest-${ev.base}`, bbox: ctx.bboxToOrig([ev.bbox.x0, ev.bbox.y0, ev.bbox.x1 - ev.bbox.x0 + 1, ev.bbox.y1 - ev.bbox.y0 + 1]), confidence: ev.conf, eventId: ev.eventId }));
    const prev = new Uint8ClampedArray(ctx.w * ctx.h * 4);
    for (let i = 0; i < ctx.w * ctx.h; i++) { const v = nolines[i] ? 0 : ctx.bin[i] ? 160 : 255; prev[i * 4] = prev[i * 4 + 1] = prev[i * 4 + 2] = v; prev[i * 4 + 3] = 255; }
    res.binarizedPreview = { width: ctx.w, height: ctx.h, data: prev };
    res.debug = { workingSize: [ctx.w, ctx.h], spacing: ctx.sp, thickness: ctx.t, scale: ctx.scale, threshold: ctx.threshold };
  }
  return res;
}
