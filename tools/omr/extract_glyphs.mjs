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
import { removeStaffLines, segmentSymbols, classify } from '../../app/js/omr/omr.js';
import { stemFeatures, RW, RH, N_RFEAT } from '../../app/js/omr/rhythm.js';
import { BW, BH, N_BFEAT } from '../../app/js/omr/barlines.js';
import { loadModel } from '../../app/js/omr/classifiers.js';
import { glyphFeatures, GLYPH_CLASSES, GW, GH, N_GFEAT } from '../../app/js/omr/glyphs.js';
import { headCandidates, patchAt, candFeatures, inkLevels, PATCH } from '../../app/js/omr/heads.js';
import { loadImage, listCases } from './metrics.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dirs = opt('--dir', '/tmp/omr_train/train_photo').split(',');
const outBase = opt('--out', '/tmp/glyphs_train');
const limit = parseInt(opt('--limit', '0'), 10);
const negKeep = parseFloat(opt('--neg-keep', '0.3'));
const shard = opt('--shard', '0/1').split('/').map(Number);      // k/n: every n-th image starting at k
const gtBoxes = !args.includes('--no-gt-boxes');                  // also sample the GT symbol boxes themselves (merged / touching glyphs)
const GTBOX_SKIP = new Set(['none', 'dot']);
// --heads-out <base>: also write note-head classifier samples (extract_heads.mjs format) from the same front-end run
const headsOut = opt('--heads-out', null);
const HREC = 1 + 16 + PATCH * PATCH, HTYPES = { noteheadBlack: 1, noteheadHalf: 2, noteheadWhole: 3 };
const hfd = headsOut ? fs.openSync(headsOut + '.bin', 'w') : null;
// --rhythm-out <base>: beam / flag count samples of detected stems (runtime-like: learned heads), labelled
// by the GT duration of the matched event: 0 none, 1 eighth, 2 16th, 3 32nd+; records [label u8][geom 8×f32][patch RW×RH u8]
const rhythmOut = opt('--rhythm-out', null);
const rfd = rhythmOut ? fs.openSync(rhythmOut + '.bin', 'w') : null;
const RNP = RW * RH, RNG = N_RFEAT - RNP, RREC = 1 + 4 * RNG + RNP;
const rstats = { images: 0, samples: 0, perClass: [0, 0, 0, 0], unmatched: 0, perImage: [] };
// --bars-out <base>: barline-candidate samples (one per candidate and staff), label 1 = a GT barline within 1.1 sp
const barsOut = opt('--bars-out', null);
const bfd = barsOut ? fs.openSync(barsOut + '.bin', 'w') : null;
const BNP = BW * BH, BNG = N_BFEAT - BNP, BREC = 1 + 4 * BNG + BNP;
const bstats = { images: 0, samples: 0, perClass: [0, 0], gtBars: 0, gtFound: 0, perImage: [] };
const models = (rfd || bfd) ? { heads: await loadModel('heads'), glyphs: await loadModel('glyphs'), rhythm: null, bars: null } : null;
const BEAMS = { whole: 0, half: 0, quarter: 0, eighth: 1, '16th': 2, '32nd': 3, '64th': 3, '128th': 3, breve: 0 };
const hstats = { images: 0, samples: 0, pos: [0, 0, 0, 0], gt: [0, 0, 0, 0], gtFound: [0, 0, 0, 0], perImage: [] };
const NP = GW * GH, NG = N_GFEAT - NP;
const REC = 1 + 4 * NG + NP;
const CLS = new Map(GLYPH_CLASSES.map((c, i) => [c, i]));

let cases = [];
for (const d of dirs) cases.push(...listCases(path.resolve(d)));
cases = cases.filter((c, i) => i % shard[1] === shard[0]);
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
  if (models) ctx.models = models;
  const nolines = removeStaffLines(ctx, staves);
  if (hfd) headSamples(ctx, staves, nolines, gt, c);
  const prims = segmentSymbols(ctx, staves, nolines);
  if (rfd || bfd) { ctx.cc = prims.cc; if (bfd) ctx.barCollect = []; rhythmSamples(ctx, staves, nolines, prims, gt, c); if (bfd) barSamples(ctx, gt, c); }
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
  // GT-box samples: the symbol's own box mapped into the working image, with
  // jitter — teaches the classifier glyphs whose component is merged with a
  // neighbour (key signatures, digits touching ...), as cropped at run time
  let nb = 0;
  if (gtBoxes && ctx.fromOrig) {
    const extra = [];
    for (const g of gs) {
      if (GTBOX_SKIP.has(g.name)) continue;
      const pts = [[g.bbox[0], g.bbox[1]], [g.bbox[0] + g.bbox[2], g.bbox[1]], [g.bbox[0], g.bbox[1] + g.bbox[3]], [g.bbox[0] + g.bbox[2], g.bbox[1] + g.bbox[3]]].map(([x, y]) => ctx.fromOrig(x, y));
      if (pts.some(p => !p)) continue;
      const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
      const bw = x1 - x0, bh = y1 - y0;
      if (bw < 2 || bh < 2 || bw > 6 * sp || bh > 10 * sp) continue;
      const st = staffNear((y0 + y1) / 2, (x0 + x1) / 2);
      if (!st) continue;
      for (let r = 0; r < 2; r++) {
        const j = () => (rand() - 0.5) * 0.16;
        const b = { x0: Math.round(x0 + j() * bw), x1: Math.round(x1 + j() * bw), y0: Math.round(y0 + j() * bh), y1: Math.round(y1 + j() * bh) };
        if (b.x1 <= b.x0 + 1 || b.y1 <= b.y0 + 1) continue;
        let area = 0;
        for (let y = Math.max(0, b.y0); y <= Math.min(ctx.h - 1, b.y1); y++) for (let x = Math.max(0, b.x0); x <= Math.min(ctx.w - 1, b.x1); x++) area += nolines[y * ctx.w + x];
        if (area < 4) continue;
        extra.push({ b, st, area, cls: g.cls });
      }
    }
    const buf2 = Buffer.alloc(REC * extra.length);
    for (const e of extra) {
      glyphFeatures(ctx, e.b, e.st, feat, e.area);
      const o = nb * REC;
      buf2[o] = e.cls;
      for (let q = 0; q < NG; q++) buf2.writeFloatLE(feat[NP + q], o + 1 + 4 * q);
      for (let q = 0; q < NP; q++) buf2[o + 1 + 4 * NG + q] = Math.max(0, Math.min(255, Math.round(feat[q] * 180 + 20)));
      stats.perClass[e.cls]++;
      nb++;
    }
    fs.writeSync(fd, buf, 0, n * REC);
    fs.writeSync(fd, buf2, 0, nb * REC);
  } else fs.writeSync(fd, buf, 0, n * REC);
  n += nb;
  stats.images++; stats.samples += n;
  stats.perImage.push({ name: path.basename(c.image), kept: n });
  console.log(path.basename(c.image).padEnd(28), `comps ${comps.length} kept ${n} (gt boxes ${nb}) gt ${gs.length} matched ${taken.size} ${Date.now() - t0}ms`);
}
fs.closeSync(fd);
fs.writeFileSync(outBase + '.json', JSON.stringify(stats, null, 1));
if (hfd) { fs.closeSync(hfd); fs.writeFileSync(headsOut + '.json', JSON.stringify(hstats, null, 1)); console.log('head samples', hstats.samples, 'labels', hstats.pos.join('/')); }
if (rfd) { fs.closeSync(rfd); fs.writeFileSync(rhythmOut + '.json', JSON.stringify(rstats, null, 1)); console.log('rhythm samples', rstats.samples, 'per class', rstats.perClass.join('/'), 'unmatched', rstats.unmatched); }
if (bfd) { fs.closeSync(bfd); fs.writeFileSync(barsOut + '.json', JSON.stringify(bstats, null, 1)); console.log('bar samples', bstats.samples, 'per class', bstats.perClass.join('/'), 'GT barlines with a candidate', bstats.gtFound, '/', bstats.gtBars); }

/** Detected stems (classify(), as at run time) matched to GT note events by their heads. */
function barSamples(ctx, gt, c) {
  const spO = gt.staffSpace;
  const segs = (gt.barlines || []).map(b => (b.p0 ? [b.p0, b.p1] : [[b.x, b.y0], [b.x, b.y1]]));
  const found = new Set();
  const buf = Buffer.alloc(BREC * ctx.barCollect.reduce((a, q) => a + q.feats.length, 0));
  let n = 0;
  for (const cand of ctx.barCollect) cand.sys.staves.forEach((st, k) => {
    const xi = Math.max(0, Math.min(ctx.w - 1, Math.round(cand.x)));
    const ym = (st.lines[0][xi] + st.lines[4][xi]) / 2;
    const [X, Y] = ctx.toOrig(cand.x, ym);
    let label = 0;
    segs.forEach(([p0, p1], i) => {
      if (Y < Math.min(p0[1], p1[1]) - spO || Y > Math.max(p0[1], p1[1]) + spO) return;
      const t = Math.abs(p1[1] - p0[1]) > 1e-6 ? (Y - p0[1]) / (p1[1] - p0[1]) : 0;
      const xs = p0[0] + t * (p1[0] - p0[0]);
      if (Math.abs(xs - X) < 1.1 * spO) { label = 1; found.add(i); }
    });
    const f = cand.feats[k], o = n * BREC;
    buf[o] = label;
    for (let q = 0; q < BNG; q++) buf.writeFloatLE(f[BNP + q], o + 1 + 4 * q);
    for (let q = 0; q < BNP; q++) buf[o + 1 + 4 * BNG + q] = Math.max(0, Math.min(255, Math.round(f[q] * 180 + 20)));
    bstats.perClass[label]++;
    n++;
  });
  fs.writeSync(bfd, buf, 0, n * BREC);
  bstats.images++; bstats.samples += n; bstats.gtBars += segs.length; bstats.gtFound += found.size;
  bstats.perImage.push({ name: path.basename(c.image), kept: n });
  ctx.barCollect = null;
}

function rhythmSamples(ctx, staves, nolines, prims, gt, c) {
  let cls;
  try { cls = classify(ctx, staves, nolines, prims, {}); } catch (e) { console.error('classify failed', c.image, e.message); return; }
  const spO = gt.staffSpace;
  const gev = [];
  for (const m of gt.measures) for (const evs of m.staves) for (const e of evs) if (e.kind === 'note' && (e.heads || e.bbox) && BEAMS[e.base] != null) gev.push(e);
  const feat = new Float32Array(N_RFEAT);
  const notes = cls.events.filter(e => e.kind === 'note' && e.stem && e.stem.dir);
  const buf = Buffer.alloc(RREC * notes.length);
  let n = 0;
  for (const ev of notes) {
    const ho = ev.heads.map(hd => ctx.toOrig(hd.cx, hd.cy));
    let best = null, bd = 0.45 * spO;
    for (const g of gev) {
      if (g.heads) { for (const gh of g.heads) for (const p of ho) { const d = Math.hypot(p[0] - gh[0], p[1] - gh[1]); if (d < bd) { bd = d; best = g; } } continue; }
      // synthetic GT (gen_synthetic) has no head list: head centre inside the event box, nearest event x
      const [bx, by, bw, bh] = g.bbox, m = 0.2 * spO;
      for (const p of ho) if (p[0] > bx - m && p[0] < bx + bw + m && p[1] > by - m && p[1] < by + bh + m) { const d = 0.3 * Math.abs(p[0] - g.x) / 3; if (d < bd) { bd = d; best = g; } }
    }
    if (!best) { rstats.unmatched++; continue; }
    const label = BEAMS[best.base];
    stemFeatures(ctx, ev.stem, ev.heads, ev.rule, feat);
    const o = n * RREC;
    buf[o] = label;
    for (let q = 0; q < RNG; q++) buf.writeFloatLE(feat[RNP + q], o + 1 + 4 * q);
    for (let q = 0; q < RNP; q++) buf[o + 1 + 4 * RNG + q] = Math.max(0, Math.min(255, Math.round(feat[q] * 180 + 20)));
    rstats.perClass[label]++;
    n++;
  }
  fs.writeSync(rfd, buf, 0, n * RREC);
  rstats.images++; rstats.samples += n;
  rstats.perImage.push({ name: path.basename(c.image), kept: n });
}

/** Note-head candidates labelled by GT head centres (same as extract_heads.mjs). */
function headSamples(ctx, staves, nolines, gt, c) {
  const cands = headCandidates(ctx, staves, nolines);
  const lv = inkLevels(ctx);
  const spO = gt.staffSpace;
  const gh = (gt.symbols || []).filter(s => HTYPES[s.name]).map(s => ({ c: s.c, type: HTYPES[s.name] }));
  const co = cands.map(cd => ctx.toOrig(cd.x, cd.y));
  const pairs = [];
  for (let i = 0; i < gh.length; i++) for (let j = 0; j < cands.length; j++) {
    const d = Math.hypot(co[j][0] - gh[i].c[0], co[j][1] - gh[i].c[1]);
    if (d < 0.4 * spO) pairs.push([d, i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const label = new Uint8Array(cands.length), near = new Uint8Array(cands.length), usedG = new Set();
  for (const [, i, j] of pairs) { if (usedG.has(i) || label[j]) continue; usedG.add(i); label[j] = gh[i].type; }
  for (const g of gh) hstats.gt[g.type]++;
  for (const i of usedG) hstats.gtFound[gh[i].type]++;
  for (let j = 0; j < cands.length; j++) if (!label[j]) for (const g of gh) if (Math.hypot(co[j][0] - g.c[0], co[j][1] - g.c[1]) < 1.6 * spO) { near[j] = 1; break; }
  const buf = Buffer.alloc(HREC * cands.length);
  let n = 0;
  const patch = new Float32Array(PATCH * PATCH);
  for (let j = 0; j < cands.length; j++) {
    if (!label[j] && !near[j] && cands[j].R < 0.45 && rand() > 0.35) continue;
    const o = n * HREC;
    buf[o] = label[j];
    const f = candFeatures(cands[j]);
    for (let k = 0; k < 4; k++) buf.writeFloatLE(f[k], o + 1 + 4 * k);
    patchAt(ctx, cands[j].x, cands[j].y, patch, lv);
    for (let k = 0; k < PATCH * PATCH; k++) buf[o + 17 + k] = Math.max(0, Math.min(255, Math.round(patch[k] * 180 + 20)));
    hstats.pos[label[j]]++;
    n++;
  }
  fs.writeSync(hfd, buf, 0, n * HREC);
  hstats.images++; hstats.samples += n;
  hstats.perImage.push({ name: path.basename(c.image), cands: cands.length, kept: n, gt: gh.length, found: usedG.size });
}
console.log('samples', stats.samples, 'per class', GLYPH_CLASSES.map((c, i) => `${c}:${stats.perClass[i]}`).join(' '));
console.log('GT matched:', Object.keys(stats.gt).map(k => `${k} ${stats.gtFound[k] || 0}/${stats.gt[k]}`).join('  '));
