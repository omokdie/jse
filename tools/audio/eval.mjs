#!/usr/bin/env node
// Evaluate (and tune) the audio → score pipeline on the cached corpus posteriorgrams.
//   node tools/audio/eval.mjs [--dir tools/audio/corpus] [--split dev|holdout|train] [--kind melody|piano]
//        [--set '{"poly":{"onsetThresh":0.4}}'] [--report out.md] [--tune] [--json out.json]
// Metrics per item, averaged per kind (melody material is transcribed in melody mode, piano in piano mode):
//   note P/R/F1   — performance notes vs sounding ground truth, onset within ±50 ms and exact MIDI pitch
//   tempo         — |bpm/true − 1| ≤ 4 % (quarter-note bpm; "×2" also accepts double/half/triple/third)
//   key           — key signature (fifths) equals the written one
//   meter         — beats-per-bar class equals the written one (4/4·2/4·2/2 · 3/4 · compound x/8)
//   score notes   — written onset position (quarters, after the best global shift) AND pitch both right
//   score rhythm  — written onset positions present (any pitch);  pitch|pos — pitch right where the position is right
//   measures      — mean per-measure F1 of (position, pitch); "exact" = measures transcribed completely right
import fs from 'node:fs';
import path from 'node:path';
import { transcribe, TUNED } from '../../app/js/audio/transcribe.js';
import { N_PITCH } from '../../app/js/audio/basicpitch.js';
import { durTicks, midiOf, voiceTicks, measureCapacity, effectiveTimeSig } from '../../app/js/model/score.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] == null || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const DIR = arg('dir', path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus'));

export function loadPost(file) {
  const b = fs.readFileSync(file), nF = b.readUInt32LE(0);
  const q = new Uint16Array(b.buffer.slice(b.byteOffset + 4, b.byteOffset + 4 + nF * N_PITCH * 4));
  const note = new Float32Array(nF * N_PITCH), onset = new Float32Array(nF * N_PITCH);
  for (let i = 0; i < note.length; i++) { note[i] = q[i] / 65535; onset[i] = q[note.length + i] / 65535; }
  return { nFrames: nF, note, onset };
}
export function loadItems(dir, split, kind) {
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return idx.filter(e => (!split || e.split === split) && (!kind || e.kind === kind) && fs.existsSync(path.join(dir, e.id + '.post')))
    .map(e => ({ ...JSON.parse(fs.readFileSync(path.join(dir, e.id + '.json'), 'utf8')), post: loadPost(path.join(dir, e.id + '.post')) }));
}

function noteF1(est, ref, tol = 0.05) {
  // greedy matching by onset distance per pitch (equivalent to bipartite for well-separated same-pitch notes)
  const used = new Uint8Array(est.length); let tp = 0;
  const byP = new Map(); est.forEach((n, i) => { if (!byP.has(n.pitch)) byP.set(n.pitch, []); byP.get(n.pitch).push(i); });
  for (const r of [...ref].sort((a, b) => a.t - b.t)) {
    const c = byP.get(r.p) || []; let best = -1, bd = tol + 1e-9;
    for (const i of c) { if (used[i]) continue; const d = Math.abs(est[i].on - r.t); if (d <= bd) { bd = d; best = i; } }
    if (best >= 0) { used[best] = 1; tp++; }
  }
  const P = est.length ? tp / est.length : 0, R = ref.length ? tp / ref.length : 0;
  return { P, R, F: P + R ? 2 * P * R / (P + R) : 0 };
}
const meterClass = ts => (ts.den === 8 && ts.num % 3 === 0 && ts.num >= 6) ? 'compound' : ts.num % 3 === 0 ? 'triple' : 'duple';

/** Written onsets of a ScoreDoc: [{q (quarters from start), p, mi}] (tie continuations are not onsets). */
function writtenOnsets(score) {
  const out = []; let q0 = 0;
  score.measures.forEach((m, mi) => {
    const cap = m.pickup ? Math.max(...m.staves.map(sm => voiceTicks(sm.voices[0]))) : measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach(sm => sm.voices.forEach(v => { let t = 0; for (const ev of v) { if (ev.kind === 'note') for (const n of ev.notes) if (!n.tieEnd) out.push({ q: q0 + t / 960, p: midiOf(n), mi }); t += durTicks(ev); } }));
    q0 += cap / 960;
  });
  return out;
}
const key = (q, p) => `${Math.round(q * 24)}:${p}`;
function scoreMetrics(trScore, it) {
  const gt = [];
  for (const e of it.gt.written) e.p.forEach((p, k) => { if (!e.tieEnd[k]) gt.push({ q: e.q, p, mi: e.mi }); });
  const tr = writtenOnsets(trScore);
  if (!gt.length) return null;
  if (!tr.length) return { notes: 0, rhythm: 0, pitchGivenPos: 0, measF1: 0, exact: 0 };
  // best global shift: candidates from same-pitch pairs among the first notes, then count matches
  const cands = new Set();
  for (const a of gt.slice(0, 12)) for (const b of tr.slice(0, 16)) if (a.p === b.p) cands.add(Math.round((b.q - a.q) * 24) / 24);
  cands.add(Math.round((tr[0].q - gt[0].q) * 24) / 24);
  const trSet = new Set(tr.map(n => key(n.q, n.p))), trPos = new Set(tr.map(n => Math.round(n.q * 24)));
  let best = { m: -1, s: 0 };
  for (const s of cands) { let m = 0; for (const g of gt) if (trSet.has(key(g.q + s, g.p))) m++; if (m > best.m) best = { m, s }; }
  const s = best.s;
  let notes = 0, posOk = 0, pitchAtPos = 0;
  for (const g of gt) { if (trSet.has(key(g.q + s, g.p))) notes++; if (trPos.has(Math.round((g.q + s) * 24))) { posOk++; if (trSet.has(key(g.q + s, g.p))) pitchAtPos++; } }
  // per GT measure
  const ms = new Map(); for (const g of gt) { if (!ms.has(g.mi)) ms.set(g.mi, []); ms.get(g.mi).push(g); }
  const span = []; { let q0 = 0; for (let mi = 0; mi < it.gt.measures; mi++) { const len = it.gt.written.filter(e => e.mi === mi).reduce((m, e) => Math.max(m, e.q + e.dq), q0) - q0; const cap = it.gt.ts.num * 4 / it.gt.ts.den; const L = mi === 0 && it.gt.pickup ? Math.max(len, 0) : cap; span.push([q0, q0 + L]); q0 += L; } }
  let f1sum = 0, exact = 0, nm = 0;
  for (const [mi, gs] of ms) {
    const [a, b] = span[mi] || [0, 0];
    const trIn = tr.filter(n => n.q - s >= a - 1e-6 && n.q - s < b - 1e-6);
    let tp = 0; const gk = new Set(gs.map(g => key(g.q + s, g.p)));
    for (const n of trIn) if (gk.has(key(n.q, n.p))) tp++;
    const P = trIn.length ? tp / trIn.length : 0, R = tp / gs.length, F = P + R ? 2 * P * R / (P + R) : 0;
    f1sum += F; nm++; if (tp === gs.length && trIn.length === gs.length) exact++;
  }
  return { notes: notes / gt.length, rhythm: posOk / gt.length, pitchGivenPos: posOk ? pitchAtPos / posOk : 0, measF1: f1sum / nm, exact: exact / nm };
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
export function evaluateItem(it, opts = {}) {
  const t0 = performance.now();
  const r = transcribe(it.post, { mode: it.kind === 'melody' ? 'melody' : 'piano', title: it.id, ...opts });
  const ms = performance.now() - t0;
  const ref = it.notes.map(n => ({ t: n.t, p: n.p }));
  const nf = noteF1(r.notes, ref);
  const ibi = median(it.gt.beats.slice(1).map((b, i) => b - it.gt.beats[i]));
  const trueBpmQ = 60 / ibi * it.gt.beatQ;
  const estBpmQ = r.bpm * (r.timeSig.den === 8 && r.timeSig.num % 3 === 0 ? 1.5 : 4 / r.timeSig.den);
  const ratio = estBpmQ / trueBpmQ;
  const tempo = Math.abs(ratio - 1) <= 0.04;
  const tempo2 = [1, 2, 0.5, 3, 1 / 3, 1.5, 2 / 3].some(k => Math.abs(ratio / k - 1) <= 0.04);
  const keyOk = r.key.fifths === it.gt.fifths;
  const meterOk = meterClass(r.timeSig) === meterClass(it.gt.ts);
  const sm = scoreMetrics(r.score, it);
  return { id: it.id, kind: it.kind, inst: it.instrument, style: it.gt.style, mp3: !!it.aug.mp3, noteP: nf.P, noteR: nf.R, noteF: nf.F, tempo, tempo2, ratio, keyOk, meterOk, ...sm, ms, bpm: r.bpm, trueBpmQ, ts: `${r.timeSig.num}/${r.timeSig.den}`, gtTs: `${it.gt.ts.num}/${it.gt.ts.den}` };
}
export function summarize(rows) {
  const avg = k => rows.reduce((s, r) => s + (+r[k] || 0), 0) / Math.max(1, rows.length);
  return { n: rows.length, noteP: avg('noteP'), noteR: avg('noteR'), noteF: avg('noteF'), tempo: avg('tempo'), tempo2: avg('tempo2'), key: avg('keyOk'), meter: avg('meterOk'), scoreNotes: avg('notes'), rhythm: avg('rhythm'), pitchGivenPos: avg('pitchGivenPos'), measF1: avg('measF1'), exact: avg('exact'), ms: avg('ms') };
}
const pct = v => (100 * v).toFixed(1);
export function table(sums) {
  const head = '| material | items | note P | note R | note F1 | tempo ±4% | tempo (×2 ok) | key | meter | score notes (pitch+pos) | rhythm (pos) | pitch given pos | measure F1 | exact measures |';
  const sep = '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|';
  return [head, sep, ...Object.entries(sums).map(([k, s]) => `| ${k} | ${s.n} | ${pct(s.noteP)} | ${pct(s.noteR)} | ${pct(s.noteF)} | ${pct(s.tempo)} | ${pct(s.tempo2)} | ${pct(s.key)} | ${pct(s.meter)} | ${pct(s.scoreNotes)} | ${pct(s.rhythm)} | ${pct(s.pitchGivenPos)} | ${pct(s.measF1)} | ${pct(s.exact)} |`)].join('\n');
}

// ---------------------------------------------------------------------------------------------- CLI
const isMain = path.basename(process.argv[1] || '') === 'eval.mjs';
if (isMain) {
  const split = arg('split', 'dev'), kind = arg('kind', null);
  const set = arg('set', null); const tuned = set && set !== true ? JSON.parse(set) : null;
  const merge = (a, b) => { const o = JSON.parse(JSON.stringify(a)); for (const [k, v] of Object.entries(b || {})) o[k] = typeof v === 'object' && !Array.isArray(v) ? { ...o[k], ...v } : v; return o; };
  const items = loadItems(DIR, split, kind);
  const run = (P) => items.map(it => evaluateItem(it, { tuned: P }));
  if (arg('tune', false)) {
    // coordinate descent over the post-processing parameters (objective: note F1 + score-level accuracy)
    let P = merge(TUNED, tuned);
    const obj = rows => { const by = k => rows.filter(r => r.kind === k); const f = rs => { const s = summarize(rs); return s.noteF + s.scoreNotes + 0.5 * s.measF1 + 0.3 * s.tempo + 0.2 * s.key + 0.2 * s.meter; }; return (f(by('melody')) + f(by('piano'))) / 2; };
    let bestRows = run(P), best = obj(bestRows);
    console.log('start', best.toFixed(4));
    const grid = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'tune_grid.json'), 'utf8'));
    for (let pass = 0; pass < (+arg('passes', 1)); pass++) for (const [grp, params] of Object.entries(grid)) for (const [k, vals] of Object.entries(params)) {
      for (const v of vals) {
        if (P[grp][k] === v) continue;
        const Q = merge(P, { [grp]: { [k]: v } });
        const rows = run(Q), o = obj(rows);
        if (o > best + 1e-4) { best = o; P = Q; bestRows = rows; console.log(`  ${grp}.${k} = ${JSON.stringify(v)} → ${o.toFixed(4)}`); }
      }
    }
    fs.writeFileSync(arg('json', '/tmp/tuned.json'), JSON.stringify(P, null, 1));
    console.log('best', best.toFixed(4), JSON.stringify(P));
    const sums = { melody: summarize(bestRows.filter(r => r.kind === 'melody')), piano: summarize(bestRows.filter(r => r.kind === 'piano')) };
    console.log(table(sums));
  } else {
    const rows = run(tuned ? merge(TUNED, tuned) : TUNED);
    const sums = {};
    for (const k of ['melody', 'piano']) { const rs = rows.filter(r => r.kind === k); if (rs.length) sums[k] = summarize(rs); }
    const by = (k, f) => { const g = {}; rows.filter(r => r.kind === k).forEach(r => { const v = f(r); (g[v] = g[v] || []).push(r); }); return Object.fromEntries(Object.entries(g).map(([v, rs]) => [`${k} · ${v}`, summarize(rs)])); };
    const detail = { ...by('melody', r => r.inst), ...by('piano', r => r.inst), ...by('melody', r => r.style), ...by('piano', r => r.style), ...by('melody', r => (r.mp3 ? 'mp3' : 'wav')), ...by('piano', r => (r.mp3 ? 'mp3' : 'wav')) };
    console.log(`split=${split}\n` + table(sums) + '\n\n' + table(detail));
    if (arg('rows', false)) for (const r of rows) console.log(r.id, r.inst, r.style, 'F', pct(r.noteF), 'bpm', r.bpm.toFixed(1), '/', r.trueBpmQ.toFixed(1), r.ts, r.gtTs, 'score', pct(r.notes || 0), 'rh', pct(r.rhythm || 0), 'key', r.keyOk);
    if (arg('report', null)) fs.writeFileSync(arg('report'), `split=${split}\n\n${table(sums)}\n\n${table(detail)}\n`);
    if (arg('json', null)) fs.writeFileSync(arg('json'), JSON.stringify({ sums, rows }, null, 1));
  }
}
