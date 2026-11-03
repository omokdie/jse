#!/usr/bin/env node
// OMR evaluation: runs recognize() over tools/omr/corpus/**/<name>.{png,jpg}
// with ground truth <name>.json, aligns event sequences per staff (edit
// distance) and reports staff recall, measure-count accuracy, pitch/duration
// accuracy and symbol error rate. Writes tools/omr/eval_report.md.
//
//   node tools/omr/run_eval.mjs [--dir tools/omr/corpus] [--filter substr] [--limit n] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { recognize } from '../../app/js/omr/omr.js';
import { decodePNG } from './png.mjs';
import { lyricMetrics, lyricReport, lyricSummary } from './lyric_eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dir = path.resolve(opt('--dir', path.join(here, 'corpus')));
const filter = opt('--filter', '');
const limit = parseInt(opt('--limit', '0'), 10);
const verbose = args.includes('--verbose');
const reportPath = path.resolve(opt('--report', path.join(here, 'eval_report.md')));

let sharp = null;
try { sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp'); } catch { try { sharp = createRequire(import.meta.url)('sharp'); } catch { /* png only */ } }

async function loadImage(file) {
  if (file.toLowerCase().endsWith('.png')) {
    try { return decodePNG(fs.readFileSync(file)); } catch (e) { if (!sharp) throw e; }
  }
  if (!sharp) throw new Error('sharp not available for ' + file);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

function listCases() {
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
  return limit ? out.slice(0, limit) : out;
}

// ---- sequences -----------------------------------------------------------------
const pitchStr = (n) => n.step + ({ '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[n.alter || 0]) + n.octave;
function gtSequences(gt) {
  const seqs = [];
  for (let si = 0; si < gt.staffCount; si++) {
    const s = [];
    for (const m of gt.measures) for (const ev of m.staves[si] || []) s.push({ kind: ev.kind, pitches: ev.kind === 'note' ? ev.pitches.slice().sort() : [], dur: ev.base + (ev.dots ? '.' : ''), base: ev.base });
    seqs.push(s);
  }
  return seqs;
}
function detSequences(score) {
  const n = score.parts.reduce((a, p) => a + p.staves.length, 0);
  const seqs = [];
  for (let si = 0; si < n; si++) {
    const s = [];
    for (const m of score.measures) for (const ev of (m.staves[si]?.voices[0] || [])) s.push({ kind: ev.kind, pitches: ev.kind === 'note' ? ev.notes.map(pitchStr).sort() : [], dur: ev.dur.base + (ev.dur.dots ? '.' : ''), base: ev.dur.base });
    seqs.push(s);
  }
  return seqs;
}
const samePitch = (a, b) => a.pitches.length === b.pitches.length && a.pitches.every((p, i) => p === b.pitches[i]);
function subCost(a, b) {
  if (a.kind !== b.kind) return 0.95;
  if (a.kind === 'rest') return a.dur === b.dur ? 0 : 0.4;
  const p = samePitch(a, b), d = a.dur === b.dur;
  return p && d ? 0 : p || d ? 0.4 : 0.75;
}
/** Needleman–Wunsch style alignment; returns pairs [i|null, j|null]. */
function align(A, B) {
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

function staffRecall(gt, res) {
  let matched = 0, total = 0;
  for (const sys of gt.systems) for (const st of sys.staves) {
    total++;
    const mid = st.lines[2][Math.floor(st.lines[2].length / 2)];
    const x0 = st.lines[2][0][0], x1 = st.lines[2][st.lines[2].length - 1][0];
    const ok = res.staves.some(d => {
      const ov = Math.min(x1, d.bbox[0] + d.bbox[2]) - Math.max(x0, d.bbox[0]);
      return ov > 0.5 * (x1 - x0) && Math.abs(d.lineYs[2] - mid[1]) < 0.7 * gt.staffSpace;
    });
    if (ok) matched++;
  }
  return { matched, total, extra: Math.max(0, res.staves.length - total) };
}

function evaluate(gt, res) {
  const G = gtSequences(gt), Dt = detSequences(res.score);
  const m = { gtNotes: 0, gtEvents: 0, alignedNotes: 0, pitchOk: 0, durOk: 0, durOkNotes: 0, subs: 0, ins: 0, dels: 0, restOk: 0, gtRests: 0, ties: 0 };
  for (let si = 0; si < G.length; si++) {
    const A = G[si], B = Dt[si] || [];
    const pairs = align(A, B);
    for (const [i, j] of pairs) {
      if (i != null) { m.gtEvents++; if (A[i].kind === 'note') m.gtNotes++; else m.gtRests++; }
      if (i == null) { m.ins++; continue; }
      if (j == null) { m.dels++; continue; }
      const a = A[i], b = B[j];
      const exact = subCost(a, b) === 0;
      if (!exact) m.subs++;
      if (a.kind === 'note' && b.kind === 'note') { m.alignedNotes++; if (samePitch(a, b)) m.pitchOk++; if (a.dur === b.dur) m.durOkNotes++; }
      if (a.kind === b.kind && a.dur === b.dur) m.durOk++;
      if (a.kind === 'rest' && b.kind === 'rest' && a.dur === b.dur) m.restOk++;
    }
  }
  const sr = staffRecall(gt, res);
  const detMeasures = res.score.measures.length;
  return { ...m, staffMatched: sr.matched, staffTotal: sr.total, staffExtra: sr.extra, gtMeasures: gt.measures.length, detMeasures,
    measureExact: detMeasures === gt.measures.length ? 1 : 0, measureAbsErr: Math.abs(detMeasures - gt.measures.length) };
}

const errorTally = {};
function tallyErrors(gt, res) {
  const G = gtSequences(gt), Dt = detSequences(res.score);
  const add = (k) => { errorTally[k] = (errorTally[k] || 0) + 1; };
  for (let si = 0; si < G.length; si++) {
    for (const [i, j] of align(G[si], Dt[si] || [])) {
      if (i == null) { add(Dt[si][j].kind === 'note' ? 'extra note' : 'extra rest'); continue; }
      if (j == null) { add(G[si][i].kind === 'note' ? 'missed note' : 'missed rest'); continue; }
      const a = G[si][i], b = Dt[si][j];
      if (a.kind !== b.kind) { add(a.kind === 'note' ? 'note→rest' : 'rest→note'); continue; }
      if (a.kind === 'note' && !samePitch(a, b)) {
        const strip = (p) => p.replace(/[#bx]/g, '');
        const sameNat = a.pitches.map(strip).join() === b.pitches.map(strip).join();
        add(sameNat ? 'pitch: accidental' : a.pitches.length !== b.pitches.length ? 'pitch: chord size' : 'pitch: position');
      }
      if (a.dur !== b.dur) {
        const dotOnly = a.base === b.base;
        add(dotOnly ? `dur: dot (${a.dur}→${b.dur})` : `dur: ${a.dur}→${b.dur}`);
      }
    }
  }
}
function printDiff(gt, res) {
  const G = gtSequences(gt), Dt = detSequences(res.score);
  const fmt = (e) => e.kind === 'rest' ? `R:${e.dur}` : `${e.pitches.join('/')}:${e.dur}`;
  for (let si = 0; si < G.length; si++) {
    console.log(`-- staff ${si}: GT ${G[si].length} events, detected ${(Dt[si] || []).length}`);
    const pairs = align(G[si], Dt[si] || []);
    let line = [];
    for (const [i, j] of pairs) {
      const a = i != null ? fmt(G[si][i]) : '∅', b = j != null ? fmt(Dt[si][j]) : '∅';
      line.push(a === b ? a : `[${a} → ${b}]`);
    }
    console.log(line.join(' '));
  }
  console.log('warnings:', res.warnings.join(' | '));
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
function summarize(rows) {
  const s = rows.reduce((acc, r) => { for (const k of Object.keys(r.m)) acc[k] = (acc[k] || 0) + r.m[k]; acc.n = (acc.n || 0) + 1; acc.time = (acc.time || 0) + r.time; return acc; }, {});
  return {
    n: s.n, staffRecall: pct(s.staffMatched, s.staffTotal), measureCount: pct(s.measureExact, s.n), measureErr: (s.measureAbsErr / s.n).toFixed(2),
    noteRecall: pct(s.alignedNotes, s.gtNotes), pitchAcc: pct(s.pitchOk, s.gtNotes), durAcc: pct(s.durOk, s.gtEvents), restAcc: pct(s.restOk, s.gtRests),
    ser: pct(s.subs + s.ins + s.dels, s.gtEvents), time: (s.time / s.n / 1000).toFixed(2) + 's',
  };
}

async function main() {
  const cases = listCases();
  if (!cases.length) { console.error('no cases under', dir, '(run gen_synthetic.py / augment.py first)'); process.exit(1); }
  const rows = [];
  for (const c of cases) {
    const img = await loadImage(c.image);
    const gt = JSON.parse(fs.readFileSync(c.gt, 'utf8'));
    const t0 = Date.now();
    let res;
    try { res = await recognize(img, {}, () => {}); } catch (e) { console.error('FAIL', c.image, e); rows.push({ name: path.basename(c.image), group: c.group, m: evaluate(gt, { score: { parts: [], measures: [] }, staves: [] }), time: Date.now() - t0, error: String(e) }); continue; }
    const time = Date.now() - t0;
    const m = evaluate(gt, res);
    if (args.includes('--diff')) printDiff(gt, res);
    tallyErrors(gt, res);
    rows.push({ name: path.basename(c.image), group: c.group, m, time, warnings: res.warnings, angle: res.deskewAngle, lm: lyricMetrics(gt, res), lyricMs: res.lyricStats ? res.lyricStats.ms : 0 });
    if (verbose) console.log(path.basename(c.image).padEnd(40), `staves ${m.staffMatched}/${m.staffTotal}+${m.staffExtra}`, `meas ${m.detMeasures}/${m.gtMeasures}`, `pitch ${pct(m.pitchOk, m.gtNotes)}`, `dur ${pct(m.durOk, m.gtEvents)}`, `SER ${pct(m.subs + m.ins + m.dels, m.gtEvents)}`, `${time}ms`, `skew ${res.deskewAngle.toFixed(2)}`);
  }
  const groups = [...new Set(rows.map(r => r.group))];
  const table = [['group', 'n', 'staff recall', 'measure count ok', 'avg |Δmeasures|', 'note recall', 'pitch acc', 'duration acc', 'rest acc', 'symbol error rate', 'time/img']];
  for (const g of [...groups, 'ALL']) {
    const s = summarize(g === 'ALL' ? rows : rows.filter(r => r.group === g));
    table.push([g, s.n, s.staffRecall, s.measureCount, s.measureErr, s.noteRecall, s.pitchAcc, s.durAcc, s.restAcc, s.ser, s.time]);
  }
  const md = ['# OMR evaluation report', '', `Date: ${new Date().toISOString()}  ·  corpus: \`${path.relative(process.cwd(), dir)}\`  ·  images: ${rows.length}`, '',
    '| ' + table[0].join(' | ') + ' |', '|' + table[0].map(() => '---').join('|') + '|',
    ...table.slice(1).map(r => '| ' + r.join(' | ') + ' |'), '',
    '## Per image', '', '| image | staves | measures | note recall | pitch | duration | SER | ms |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.name} | ${r.m.staffMatched}/${r.m.staffTotal}${r.m.staffExtra ? '+' + r.m.staffExtra : ''} | ${r.m.detMeasures}/${r.m.gtMeasures} | ${pct(r.m.alignedNotes, r.m.gtNotes)} | ${pct(r.m.pitchOk, r.m.gtNotes)} | ${pct(r.m.durOk, r.m.gtEvents)} | ${pct(r.m.subs + r.m.ins + r.m.dels, r.m.gtEvents)} | ${r.time} |`),
    '', 'Metrics: sequences are aligned per staff with edit distance (substitution cost 0.4 for a pitch-or-duration slip, 0.75 for both, 0.95 note↔rest).',
    'pitch acc = GT notes whose aligned note has the identical pitch set / all GT notes; duration acc = GT events whose aligned event has the same kind and duration;',
    'symbol error rate = (substitutions + insertions + deletions) / GT events.', '', ...lyricReport(rows, groups)].join('\n');
  fs.writeFileSync(reportPath, md);
  console.log(table.map(r => r.map(String).map((c, i) => c.padEnd(i ? 14 : 10)).join(' ')).join('\n'));
  if (rows.some(r => r.lm && r.lm.gtSyl)) { const ls = lyricSummary(rows); console.log(`lyrics: ${ls.gtSyl} GT syllables, detected ${ls.detRecall}, read ${ls.recogAcc}, line char acc ${ls.lineCharAcc}, char acc in score ${ls.charAcc}, on right note ${ls.assignAcc} (text+note ${ls.assignTextAcc}), errors flagged ${ls.flaggedErr}, ${ls.lyricMs}/page`); }
  console.log('report:', path.relative(process.cwd(), reportPath));
  if (args.includes('--errors')) console.log('error tally:', Object.entries(errorTally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
}
main();
