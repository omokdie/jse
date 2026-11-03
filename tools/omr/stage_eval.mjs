#!/usr/bin/env node
// Per-stage OMR diagnostics against symbol-level ground truth (gen_photo.py
// corpora): staff detection + line accuracy, system grouping, barlines, note
// heads (filled / hollow / whole), rests, accidentals, clef / key / time, and
// the end-to-end sequence metrics.  Uses recognize(img, { trace: true }).
//
//   node tools/omr/stage_eval.mjs --dir tools/omr/corpus/dev_photo [--limit n] [--filter s] [--verbose] [--overlay /tmp/ov]
import fs from 'node:fs';
import path from 'node:path';
import { recognize } from '../../app/js/omr/omr.js';
import { loadImage, listCases, sequenceMetrics, pct } from './metrics.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dirs = (opt('--dir', 'tools/omr/corpus/dev_photo')).split(',');
const filter = opt('--filter', '');
const limit = parseInt(opt('--limit', '0'), 10);
const verbose = args.includes('--verbose');
const overlayDir = opt('--overlay', null);
const jsonOut = opt('--json', null);

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function interpY(poly, x) {
  if (x <= poly[0][0]) return poly[0][1] + (poly.length > 1 ? (x - poly[0][0]) * (poly[1][1] - poly[0][1]) / Math.max(1e-6, poly[1][0] - poly[0][0]) : 0);
  for (let i = 1; i < poly.length; i++) if (x <= poly[i][0]) { const t = (x - poly[i - 1][0]) / Math.max(1e-6, poly[i][0] - poly[i - 1][0]); return poly[i - 1][1] + t * (poly[i][1] - poly[i - 1][1]); }
  const n = poly.length;
  return poly[n - 1][1] + (n > 1 ? (x - poly[n - 1][0]) * (poly[n - 1][1] - poly[n - 2][1]) / Math.max(1e-6, poly[n - 1][0] - poly[n - 2][0]) : 0);
}
const bboxC = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Greedy one-to-one matching of points within maxD. */
function matchPoints(A, B, maxD, getA = (a) => a.c, getB = (b) => b.c) {
  const pairs = [];
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) { const d = dist(getA(A[i]), getB(B[j])); if (d <= maxD) pairs.push([d, i, j]); }
  pairs.sort((a, b) => a[0] - b[0]);
  const ua = new Set(), ub = new Set(), out = [];
  for (const [d, i, j] of pairs) { if (ua.has(i) || ub.has(j)) continue; ua.add(i); ub.add(j); out.push([i, j, d]); }
  return out;
}

function gtStaves(gt) {
  const out = [];
  gt.systems.forEach((sys, si) => sys.staves.forEach((st, k) => out.push({ lines: st.lines, system: si, idx: k, clef: st.clef })));
  return out;
}

function stageMetrics(gt, tr) {
  const sp = gt.staffSpace;
  const m = {};
  // ---- staves ------------------------------------------------------------
  const G = gtStaves(gt), D = tr.staves;
  const staffMatch = new Map();   // gt index -> det index
  G.forEach((g, gi) => {
    const mid = g.lines[2], gx0 = mid[0][0], gx1 = mid[mid.length - 1][0];
    let best = -1, bd = Infinity;
    D.forEach((d, di) => {
      const dm = d.lines[2], dx0 = dm[0][0], dx1 = dm[dm.length - 1][0];
      const ov = Math.min(gx1, dx1) - Math.max(gx0, dx0);
      if (ov < 0.5 * (gx1 - gx0)) return;
      const xc = (Math.max(gx0, dx0) + Math.min(gx1, dx1)) / 2;
      const e = Math.abs(interpY(dm, xc) - interpY(mid, xc));
      if (e < 0.7 * sp && e < bd) { bd = e; best = di; }
    });
    if (best >= 0) staffMatch.set(gi, best);
  });
  m.staffGt = G.length; m.staffOk = staffMatch.size; m.staffExtra = Math.max(0, D.length - staffMatch.size);
  // line position error (sp) along the overlapping extent; coverage of the GT extent
  let errSum = 0, errN = 0, errBig = 0, cov = 0;
  for (const [gi, di] of staffMatch) {
    const g = G[gi], d = D[di];
    const gx0 = g.lines[2][0][0], gx1 = g.lines[2][g.lines[2].length - 1][0];
    const dx0 = d.lines[2][0][0], dx1 = d.lines[2][d.lines[2].length - 1][0];
    cov += Math.max(0, Math.min(gx1, dx1) - Math.max(gx0, dx0)) / (gx1 - gx0);
    for (let k = 0; k < 5; k++) for (let s = 0; s <= 20; s++) {
      const x = Math.max(gx0, dx0) + (Math.min(gx1, dx1) - Math.max(gx0, dx0)) * s / 20;
      const e = Math.abs(interpY(d.lines[k], x) - interpY(g.lines[k], x)) / sp;
      errSum += e; errN++; if (e > 0.25) errBig++;
    }
  }
  m.lineErr = errN ? errSum / errN : 0; m.lineErrN = errN; m.lineBig = errBig; m.staffCov = cov;
  // ---- systems: every GT system's staves detected together, nothing else ----
  let sysOk = 0;
  gt.systems.forEach((sys, si) => {
    const idx = G.map((g, gi) => (g.system === si ? gi : -1)).filter(i => i >= 0);
    if (!idx.every(gi => staffMatch.has(gi))) return;
    const ds = new Set(idx.map(gi => D[staffMatch.get(gi)].systemIndex));
    if (ds.size !== 1) return;
    const dsys = [...ds][0];
    if (D.filter(d => d.systemIndex === dsys).length === idx.length) sysOk++;
  });
  m.sysGt = gt.systems.length; m.sysOk = sysOk;
  // ---- header: clef / key / time per matched staff ----------------------
  m.clefOk = 0; m.keyOk = 0; m.headerN = 0; m.timeOk = 0; m.timeN = 0;
  for (const [gi, di] of staffMatch) {
    const g = G[gi], d = D[di];
    m.headerN++;
    if (!d.clefMissing && d.clef === g.clef) m.clefOk++;
    if (d.keyFifths === gt.keyFifths) m.keyOk++;
    // (later pages of real music show no time signature: gt.timeSigShown === false)
    if (g.system === 0 && gt.timeSigShown !== false) { m.timeN++; if (d.timeSig && d.timeSig.num === gt.timeSig.num && d.timeSig.den === gt.timeSig.den) m.timeOk++; }
  }
  // ---- barlines ----------------------------------------------------------------
  const seg = (b) => (b.p0 ? [b.p0, b.p1] : [[b.x, b.y0], [b.x, b.y1]]);
  const gb = (gt.barlines || []).map(b => { const [p0, p1] = seg(b); return { c: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], type: b.type, p0, p1 }; });
  const db = tr.barlines.map(b => ({ c: [(b.p0[0] + b.p1[0]) / 2, (b.p0[1] + b.p1[1]) / 2], type: b.type }));
  const bm = matchPoints(gb, db, 1.2 * sp);
  m.barGt = gb.length; m.barDet = db.length; m.barTp = bm.length;
  // ---- note heads ----------------------------------------------------------------
  const sym = gt.symbols || [];
  const gh = sym.filter(s => s.name.startsWith('notehead')).map(s => ({ c: s.c, type: s.name }));
  const dh = tr.heads.filter(h => h.used);
  const hm = matchPoints(gh, dh, 0.55 * sp);
  m.headGt = gh.length; m.headDet = dh.length; m.headTp = hm.length;
  const byType = { noteheadBlack: [0, 0], noteheadHalf: [0, 0], noteheadWhole: [0, 0] };
  gh.forEach(h => byType[h.type][1]++);
  let hollowOk = 0;
  for (const [i, j] of hm) { byType[gh[i].type][0]++; if ((gh[i].type !== 'noteheadBlack') === dh[j].hollow) hollowOk++; }
  m.headBlackTp = byType.noteheadBlack[0]; m.headBlackGt = byType.noteheadBlack[1];
  m.headHalfTp = byType.noteheadHalf[0]; m.headHalfGt = byType.noteheadHalf[1];
  m.headWholeTp = byType.noteheadWhole[0]; m.headWholeGt = byType.noteheadWhole[1];
  m.headFillOk = hollowOk;
  // all candidates (incl. rejected) – recall of the candidate generator
  const cm = matchPoints(gh, tr.heads, 0.55 * sp);
  m.headCandTp = cm.length;
  // ---- rests -----------------------------------------------------------------------
  const restName = { restWhole: 'whole', restHalf: 'half', restQuarter: 'quarter', rest8th: 'eighth', rest16th: '16th', rest32nd: '32nd' };
  const gr = sym.filter(s => restName[s.name]).map(s => ({ c: bboxC(s.bbox), base: restName[s.name] }));
  const dr = tr.events.filter(e => e.kind === 'rest');
  const rm = matchPoints(gr, dr, 1.0 * sp);
  m.restGt = gr.length; m.restDet = dr.length; m.restTp = rm.length; m.restTypeOk = rm.filter(([i, j]) => gr[i].base === dr[j].base).length;
  // ---- accidentals (inside measures) -------------------------------------------
  const ga = sym.filter(s => ['sharp', 'flat', 'natural'].includes(s.name) && s.inMeasure !== false).map(s => ({ c: bboxC(s.bbox), name: s.name }));
  const da = tr.heads.filter(h => h.used && h.acc).map(h => ({ c: [h.c[0] - 1.6 * sp, h.c[1]], name: h.acc }));
  const am = matchPoints(ga, da, 1.2 * sp);
  m.accGt = ga.length; m.accDet = da.length; m.accTp = am.length; m.accTypeOk = am.filter(([i, j]) => ga[i].name === da[j].name).length;
  return { m, staffMatch, hm, gh, dh, bm, gb, db };
}

function sumRows(rows) { const s = {}; for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') s[k] = (s[k] || 0) + v; s.n = rows.length; return s; }
function fmtSummary(s) {
  const f1 = (tp, gtN, det) => { const p = det ? tp / det : 0, r = gtN ? tp / gtN : 0; return p + r ? (2 * p * r / (p + r) * 100).toFixed(1) : '-'; };
  return {
    n: s.n,
    'staff R': pct(s.staffOk, s.staffGt), 'staff +': s.staffExtra, 'line err sp': (s.lineErr / Math.max(1, s.n)).toFixed(3), 'line >¼sp': pct(s.lineBig, s.lineErrN), 'cov': pct(s.staffCov, s.staffOk),
    'sys ok': pct(s.sysOk, s.sysGt), 'clef': pct(s.clefOk, s.headerN), 'key': pct(s.keyOk, s.headerN), 'time': pct(s.timeOk, s.timeN),
    'bar R': pct(s.barTp, s.barGt), 'bar P': pct(s.barTp, s.barDet),
    'head R': pct(s.headTp, s.headGt), 'head P': pct(s.headTp, s.headDet), 'cand R': pct(s.headCandTp, s.headGt), 'blk R': pct(s.headBlackTp, s.headBlackGt), 'half R': pct(s.headHalfTp, s.headHalfGt), 'whole R': pct(s.headWholeTp, s.headWholeGt), 'fill ok': pct(s.headFillOk, s.headTp),
    'rest R': pct(s.restTp, s.restGt), 'rest P': pct(s.restTp, s.restDet), 'rest type': pct(s.restTypeOk, s.restTp),
    'acc R': pct(s.accTp, s.accGt), 'acc P': pct(s.accTp, s.accDet), 'acc type': pct(s.accTypeOk, s.accTp),
    'meas ok': pct(s.measureExact, s.n), 'pitch': pct(s.pitchOk, s.gtNotes), 'dur': pct(s.durOk, s.gtEvents), 'SER': pct(s.subs + s.ins + s.dels, s.gtEvents),
    't/img': (s.time / s.n / 1000).toFixed(2) + 's', 'photo pipe': pct(s.photoPipe || 0, s.n),
  };
}

async function main() {
  let cases = [];
  for (const d of dirs) cases.push(...listCases(path.resolve(d), filter));
  if (limit) cases = cases.slice(0, limit);
  if (overlayDir) fs.mkdirSync(overlayDir, { recursive: true });
  const groups = {};
  const perImage = [];
  for (const c of cases) {
    const img = await loadImage(c.image);
    const gt = JSON.parse(fs.readFileSync(c.gt, 'utf8'));
    const t0 = Date.now();
    let res;
    try { res = await recognize(img, { trace: true, lyrics: false, ...(process.env.OMR_OPTS ? JSON.parse(process.env.OMR_OPTS) : {}) }); } catch (e) { console.error('FAIL', c.image, e); continue; }
    const time = Date.now() - t0;
    const sm = res.trace ? stageMetrics(gt, res.trace) : { m: {} };
    const seq = sequenceMetrics(gt, res);
    const row = { ...sm.m, ...seq, time, photoPipe: res.pipeline === 'photo' ? 1 : 0 };
    const kind = (gt.photo && gt.photo.kind) || c.group;
    (groups[c.group] ||= []).push(row);
    if (gt.photo) (groups[`${c.group}:${kind}`] ||= []).push(row);
    perImage.push({ name: path.basename(c.image), group: c.group, kind, ...row });
    if (verbose) {
      const r = row;
      console.log(path.basename(c.image).padEnd(28), `st ${r.staffOk}/${r.staffGt}+${r.staffExtra} lerr ${(r.lineErr).toFixed(2)} sys ${r.sysOk}/${r.sysGt} bar ${r.barTp}/${r.barGt}/${r.barDet} head ${r.headTp}/${r.headGt}/${r.headDet} rest ${r.restTp}/${r.restGt}/${r.restDet} acc ${r.accTp}/${r.accGt}/${r.accDet} | meas ${r.detMeasures}/${r.gtMeasures} pitch ${pct(r.pitchOk, r.gtNotes)} dur ${pct(r.durOk, r.gtEvents)} ${time}ms`);
    }
    if (overlayDir && res.trace) await drawOverlay(c.image, gt, res.trace, sm, path.join(overlayDir, path.basename(c.image).replace(/\.\w+$/, '.png')));
  }
  const keys = Object.keys(groups).sort();
  const rows = keys.map(k => ({ group: k, ...fmtSummary(sumRows(groups[k])) }));
  const cols = Object.keys(rows[0] || {});
  console.log('| ' + cols.join(' | ') + ' |');
  console.log('|' + cols.map(() => '---').join('|') + '|');
  for (const r of rows) console.log('| ' + cols.map(c => r[c]).join(' | ') + ' |');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary: rows, perImage }, null, 1));
}

async function drawOverlay(file, gt, tr, sm, out) {
  const { createRequire } = await import('node:module');
  const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
  const meta = await sharp(file).metadata();
  const W = meta.width, H = meta.height;
  const svg = [];
  const pl = (pts, col, wd = 1) => svg.push(`<polyline fill="none" stroke="${col}" stroke-width="${wd}" points="${pts.map(p => p.join(',')).join(' ')}"/>`);
  for (const st of tr.staves) for (const l of st.lines) pl(l, 'rgba(0,160,255,0.8)');
  for (const b of tr.barlines) pl([b.p0, b.p1], 'rgba(255,120,0,0.9)', 3);
  for (const b of sm.gb) pl([b.p0, b.p1], 'rgba(0,200,0,0.5)', 1);
  const matchedGt = new Set(sm.hm.map(([i]) => i)), matchedDet = new Set(sm.hm.map(([, j]) => j));
  sm.gh.forEach((h, i) => { if (!matchedGt.has(i)) svg.push(`<circle cx="${h.c[0]}" cy="${h.c[1]}" r="${gt.staffSpace * 0.7}" fill="none" stroke="red" stroke-width="2"/>`); });
  sm.dh.forEach((h, j) => { if (!matchedDet.has(j)) svg.push(`<rect x="${h.c[0] - gt.staffSpace * 0.6}" y="${h.c[1] - gt.staffSpace * 0.6}" width="${gt.staffSpace * 1.2}" height="${gt.staffSpace * 1.2}" fill="none" stroke="magenta" stroke-width="2"/>`); });
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg.join('')}</svg>`);
  await sharp(file).composite([{ input: over, top: 0, left: 0 }]).png().toFile(out);
}

main();
