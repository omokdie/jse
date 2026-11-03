#!/usr/bin/env node
// Training data for the component (glyph) classifier: runs the front end on
// photos with symbol-level ground truth, takes the connected components of
// the line-free rectified binary near staves, and labels each by the GT
// symbol whose box matches it in original-image coordinates (IoU ≥ 0.35 and
// centre within 0.6 sp); everything else is 'none'.
// Output: <out>.bin records [label u8][geom 8×f32][patch 16×24 u8], <out>.json
//   node tools/omr/extract_glyphs.mjs --dir /tmp/omr_train/train_photo --out /tmp/glyphs_train
import fs from 'node:fs';
import path from 'node:path';
import { frontEnd } from '../../app/js/omr/frontend.js';
import { removeStaffLines, segmentSymbols } from '../../app/js/omr/omr.js';
import { glyphFeatures, GLYPH_CLASSES, GW, GH, N_GFEAT } from '../../app/js/omr/glyphs.js';
import { loadImage, listCases } from './metrics.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dirs = opt('--dir', '/tmp/omr_train/train_photo').split(',');
const outBase = opt('--out', '/tmp/glyphs_train');
const limit = parseInt(opt('--limit', '0'), 10);
const negKeep = parseFloat(opt('--neg-keep', '0.3'));
const NP = GW * GH, NG = N_GFEAT - NP;
const REC = 1 + 4 * NG + NP;
const CLS = new Map(GLYPH_CLASSES.map((c, i) => [c, i]));

let cases = [];
for (const d of dirs) cases.push(...listCases(path.resolve(d)));
if (limit) cases = cases.slice(0, limit);
const fd = fs.openSync(outBase + '.bin', 'w');
const stats = { images: 0, samples: 0, perClass: new Array(GLYPH_CLASSES.length).fill(0), gt: {}, gtFound: {}, perImage: [] };
let seed = 777;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const I = ix * iy; return I / (a[2] * a[3] + b[2] * b[3] - I + 1e-9);
};
for (const c of cases) {
  const t0 = Date.now();
  const img = await loadImage(c.image);
  const gt = JSON.parse(fs.readFileSync(c.gt, 'utf8'));
  let fe;
  try { fe = frontEnd(img, {}); } catch (e) { console.error('front end failed', c.image, e.message); continue; }
  const { ctx, staves } = fe;
  if (!staves.length) continue;
  const nolines = removeStaffLines(ctx, staves);
  const prims = segmentSymbols(ctx, staves, nolines);
  const { sp } = ctx;
  const spO = gt.staffSpace;
  const gs = (gt.symbols || []).filter(s => CLS.has(s.name)).map(s => ({ ...s, cls: CLS.get(s.name), cc: [s.bbox[0] + s.bbox[2] / 2, s.bbox[1] + s.bbox[3] / 2] }));
  for (const s of gs) stats.gt[s.name] = (stats.gt[s.name] || 0) + 1;
  const staffNear = (cy, cx) => {
    let best = null, bd = Infinity;
    for (const st of staves) {
      const x = Math.max(0, Math.min(ctx.w - 1, Math.round(cx)));
      const t = st.lines[0][x], b = st.lines[4][x];
      const d = cy < t ? t - cy : cy > b ? cy - b : 0;
      if (d < bd) { bd = d; best = st; }
    }
    return bd <= 4 * sp ? best : null;
  };
  const comps = prims.cc.comps.filter(k => k && k.area >= 4 && k.w <= 4.5 * sp && k.h <= 9 * sp);
  const buf = Buffer.alloc(REC * comps.length);
  const feat = new Float32Array(N_GFEAT);
  const taken = new Set();
  let n = 0;
  // candidate GT match for each component
  const cand = [];
  for (let j = 0; j < comps.length; j++) {
    const k = comps[j];
    const st = staffNear(k.cy, k.cx);
    if (!st) continue;
    const bo = ctx.bboxToOrig([k.x0, k.y0, k.w, k.h]);
    const co = [bo[0] + bo[2] / 2, bo[1] + bo[3] / 2];
    let best = -1, bs = 0;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (Math.abs(g.cc[0] - co[0]) > 0.6 * spO + 0.5 * g.bbox[2] || Math.abs(g.cc[1] - co[1]) > 0.6 * spO + 0.5 * g.bbox[3]) continue;
      const v = iou(bo, g.bbox);
      if (v > bs) { bs = v; best = i; }
    }
    cand.push({ j, st, best: bs >= 0.35 ? best : -1, score: bs });
  }
  cand.sort((a, b) => b.score - a.score);
  for (const cd of cand) {
    let label = 0;
    if (cd.best >= 0 && !taken.has(cd.best)) { taken.add(cd.best); label = gs[cd.best].cls; stats.gtFound[gs[cd.best].name] = (stats.gtFound[gs[cd.best].name] || 0) + 1; }
    if (!label && rand() > negKeep) continue;
    const k = comps[cd.j];
    glyphFeatures(ctx, k, cd.st, feat, k.area);
    const o = n * REC;
    buf[o] = label;
    for (let q = 0; q < NG; q++) buf.writeFloatLE(feat[NP + q], o + 1 + 4 * q);
    for (let q = 0; q < NP; q++) buf[o + 1 + 4 * NG + q] = Math.max(0, Math.min(255, Math.round(feat[q] * 180 + 20)));
    stats.perClass[label]++;
    n++;
  }
  fs.writeSync(fd, buf, 0, n * REC);
  stats.images++; stats.samples += n;
  stats.perImage.push({ name: path.basename(c.image), kept: n });
  console.log(path.basename(c.image).padEnd(28), `comps ${comps.length} kept ${n} gt ${gs.length} matched ${taken.size} ${Date.now() - t0}ms`);
}
fs.closeSync(fd);
fs.writeFileSync(outBase + '.json', JSON.stringify(stats, null, 1));
console.log('samples', stats.samples, 'per class', GLYPH_CLASSES.map((c, i) => `${c}:${stats.perClass[i]}`).join(' '));
console.log('GT matched:', Object.keys(stats.gt).map(k => `${k} ${stats.gtFound[k] || 0}/${stats.gt[k]}`).join('  '));
