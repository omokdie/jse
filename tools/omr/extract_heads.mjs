#!/usr/bin/env node
// Training data for the note-head classifier: runs the real front end
// (preprocess → staves → rectification) on photos with symbol-level ground
// truth (gen_photo.py), generates head candidates (heads.js) and labels them
// by matching the GT note-head centres in original image coordinates:
//   0 none · 1 filled (noteheadBlack) · 2 half (noteheadHalf) · 3 whole
// Output: <out>.bin  records of [label u8][feat 4×f32][patch 24×24 u8]
//         <out>.json stats (candidate recall per class etc.)
//   node tools/omr/extract_heads.mjs --dir /tmp/omr_train/train_photo --out /tmp/heads_train [--limit n]
import fs from 'node:fs';
import path from 'node:path';
import { frontEnd } from '../../app/js/omr/frontend.js';
import { removeStaffLines } from '../../app/js/omr/omr.js';
import { headCandidates, patchAt, candFeatures, inkLevels, PATCH } from '../../app/js/omr/heads.js';
import { loadImage, listCases } from './metrics.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dirs = opt('--dir', '/tmp/omr_train/train_photo').split(',');
const outBase = opt('--out', '/tmp/heads_train');
const limit = parseInt(opt('--limit', '0'), 10);
const negKeep = parseFloat(opt('--neg-keep', '0.35'));
const REC = 1 + 16 + PATCH * PATCH;
const TYPES = { noteheadBlack: 1, noteheadHalf: 2, noteheadWhole: 3 };

let cases = [];
for (const d of dirs) cases.push(...listCases(path.resolve(d)));
if (limit) cases = cases.slice(0, limit);
const fd = fs.openSync(outBase + '.bin', 'w');
const stats = { images: 0, samples: 0, pos: [0, 0, 0, 0], gt: [0, 0, 0, 0], gtFound: [0, 0, 0, 0], perImage: [] };
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (const c of cases) {
  const t0 = Date.now();
  const img = await loadImage(c.image);
  const gt = JSON.parse(fs.readFileSync(c.gt, 'utf8'));
  let fe;
  try { fe = frontEnd(img, {}); } catch (e) { console.error('front end failed', c.image, e.message); continue; }
  const { ctx, staves } = fe;
  if (!staves.length) { console.error('no staves', c.image); continue; }
  const nolines = removeStaffLines(ctx, staves);
  const cands = headCandidates(ctx, staves, nolines);
  const lv = inkLevels(ctx);
  const spO = gt.staffSpace;
  const gh = (gt.symbols || []).filter(s => TYPES[s.name]).map(s => ({ c: s.c, type: TYPES[s.name] }));
  // candidate → original coordinates
  const co = cands.map(cd => ctx.toOrig(cd.x, cd.y));
  // greedy one-to-one matching within 0.4 sp
  const pairs = [];
  for (let i = 0; i < gh.length; i++) for (let j = 0; j < cands.length; j++) {
    const d = Math.hypot(co[j][0] - gh[i].c[0], co[j][1] - gh[i].c[1]);
    if (d < 0.4 * spO) pairs.push([d, i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const label = new Uint8Array(cands.length), near = new Uint8Array(cands.length), usedG = new Set();
  for (const [, i, j] of pairs) { if (usedG.has(i) || label[j]) continue; usedG.add(i); label[j] = gh[i].type; }
  for (const g of gh) stats.gt[g.type]++;
  for (const i of usedG) stats.gtFound[gh[i].type]++;
  // negatives close to a real head are the informative ones
  for (let j = 0; j < cands.length; j++) if (!label[j]) for (const g of gh) if (Math.hypot(co[j][0] - g.c[0], co[j][1] - g.c[1]) < 1.6 * spO) { near[j] = 1; break; }
  const buf = Buffer.alloc(REC * cands.length);
  let n = 0;
  const patch = new Float32Array(PATCH * PATCH);
  for (let j = 0; j < cands.length; j++) {
    if (!label[j] && !near[j] && cands[j].R < 0.45 && rand() > negKeep) continue;
    const o = n * REC;
    buf[o] = label[j];
    const f = candFeatures(cands[j]);
    for (let k = 0; k < 4; k++) buf.writeFloatLE(f[k], o + 1 + 4 * k);
    patchAt(ctx, cands[j].x, cands[j].y, patch, lv);
    for (let k = 0; k < PATCH * PATCH; k++) buf[o + 17 + k] = Math.max(0, Math.min(255, Math.round(patch[k] * 180 + 20)));
    stats.pos[label[j]]++;
    n++;
  }
  fs.writeSync(fd, buf, 0, n * REC);
  stats.images++; stats.samples += n;
  stats.perImage.push({ name: path.basename(c.image), cands: cands.length, kept: n, gt: gh.length, found: usedG.size });
  console.log(path.basename(c.image).padEnd(28), `cands ${cands.length} kept ${n} gt ${gh.length} found ${usedG.size} (${(100 * usedG.size / Math.max(1, gh.length)).toFixed(1)}%) ${Date.now() - t0}ms`);
}
fs.closeSync(fd);
const rec = [1, 2, 3].map(k => `${['', 'black', 'half', 'whole'][k]} ${stats.gtFound[k]}/${stats.gt[k]} (${(100 * stats.gtFound[k] / Math.max(1, stats.gt[k])).toFixed(1)}%)`);
console.log('candidate recall:', rec.join('  '), ' samples', stats.samples, 'labels', stats.pos.join('/'));
fs.writeFileSync(outBase + '.json', JSON.stringify(stats, null, 1));
