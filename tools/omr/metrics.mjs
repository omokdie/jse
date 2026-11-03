// Shared helpers for the OMR evaluation tools (stage_eval.mjs, train data
// extraction): image loading, corpus listing and the sequence metrics of
// run_eval.mjs (per-staff edit-distance alignment of note/rest events).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodePNG } from './png.mjs';

let sharp = null;
try { sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp'); } catch { try { sharp = createRequire(import.meta.url)('sharp'); } catch { /* png only */ } }

export async function loadImage(file) {
  if (file.toLowerCase().endsWith('.png') && !sharp) return decodePNG(fs.readFileSync(file));
  if (!sharp) throw new Error('sharp not available for ' + file);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

export function listCases(dir, filter = '') {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      const gt = p.replace(/\.(png|jpe?g)$/i, '.json');
      if (fs.existsSync(gt) && p.includes(filter)) out.push({ image: p, gt, group: path.basename(path.dirname(p)) });
    }
  };
  walk(dir);
  out.sort((a, b) => a.image.localeCompare(b.image));
  return out;
}

export const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

const pitchStr = (n) => n.step + ({ '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[n.alter || 0]) + n.octave;
export function gtSequences(gt) {
  const seqs = [];
  for (let si = 0; si < gt.staffCount; si++) {
    const s = [];
    for (const m of gt.measures) for (const ev of m.staves[si] || []) s.push({ kind: ev.kind, pitches: ev.kind === 'note' ? ev.pitches.slice().sort() : [], dur: ev.base + (ev.dots ? '.' : ''), base: ev.base });
    seqs.push(s);
  }
  return seqs;
}
export function detSequences(score) {
  const n = score.parts.reduce((a, p) => a + p.staves.length, 0);
  const seqs = [];
  for (let si = 0; si < n; si++) {
    const s = [];
    for (const m of score.measures) for (const ev of (m.staves[si]?.voices[0] || [])) s.push({ kind: ev.kind, pitches: ev.kind === 'note' ? ev.notes.map(pitchStr).sort() : [], dur: ev.dur.base + (ev.dur.dots ? '.' : ''), base: ev.dur.base });
    seqs.push(s);
  }
  return seqs;
}
export const samePitch = (a, b) => a.pitches.length === b.pitches.length && a.pitches.every((p, i) => p === b.pitches[i]);
export function subCost(a, b) {
  if (a.kind !== b.kind) return 0.95;
  if (a.kind === 'rest') return a.dur === b.dur ? 0 : 0.4;
  const p = samePitch(a, b), d = a.dur === b.dur;
  return p && d ? 0 : p || d ? 0.4 : 0.75;
}
export function align(A, B) {
  const n = A.length, m = B.length;
  const D = new Float64Array((n + 1) * (m + 1)), P = new Uint8Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) { D[at(i, 0)] = i; P[at(i, 0)] = 1; }
  for (let j = 1; j <= m; j++) { D[at(0, j)] = j; P[at(0, j)] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = D[at(i - 1, j - 1)] + subCost(A[i - 1], B[j - 1]), del = D[at(i - 1, j)] + 1, ins = D[at(i, j - 1)] + 1;
    if (s <= del && s <= ins) { D[at(i, j)] = s; P[at(i, j)] = 0; } else if (del <= ins) { D[at(i, j)] = del; P[at(i, j)] = 1; } else { D[at(i, j)] = ins; P[at(i, j)] = 2; }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const p = P[at(i, j)];
    if (i > 0 && j > 0 && p === 0) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && (p === 1 || j === 0)) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return pairs.reverse();
}

/** Same definitions as run_eval.mjs. */
export function sequenceMetrics(gt, res) {
  const G = gtSequences(gt), Dt = detSequences(res.score);
  const m = { gtNotes: 0, gtEvents: 0, alignedNotes: 0, pitchOk: 0, durOk: 0, subs: 0, ins: 0, dels: 0, restOk: 0, gtRests: 0 };
  for (let si = 0; si < G.length; si++) {
    const A = G[si], B = Dt[si] || [];
    for (const [i, j] of align(A, B)) {
      if (i != null) { m.gtEvents++; if (A[i].kind === 'note') m.gtNotes++; else m.gtRests++; }
      if (i == null) { m.ins++; continue; }
      if (j == null) { m.dels++; continue; }
      const a = A[i], b = B[j];
      if (subCost(a, b) !== 0) m.subs++;
      if (a.kind === 'note' && b.kind === 'note') { m.alignedNotes++; if (samePitch(a, b)) m.pitchOk++; }
      if (a.kind === b.kind && a.dur === b.dur) m.durOk++;
      if (a.kind === 'rest' && b.kind === 'rest' && a.dur === b.dur) m.restOk++;
    }
  }
  const detMeasures = res.score.measures.length;
  return { ...m, gtMeasures: gt.measures.length, detMeasures, measureExact: detMeasures === gt.measures.length ? 1 : 0, measureAbsErr: Math.abs(detMeasures - gt.measures.length) };
}
