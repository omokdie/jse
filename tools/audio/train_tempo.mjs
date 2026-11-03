#!/usr/bin/env node
// Fits the tempo-octave chooser (transcribe.js chooseTempoOctave) on symbolic excerpts of the non-holdout Finale
// corpus (/tmp/jse-symbolic.json from train_symbolic.mjs): each excerpt is played at a random written tempo
// (log-uniform 60–160 quarter BPM, simple metres), the onset envelope / autocorrelation is computed once, then a grid
// of chooser weights is scored by how often the chosen tempo is the written one (±4 %).
//   node tools/audio/train_tempo.mjs [--n 1200]
import fs from 'node:fs';
import { onsetEnvelope, estimateTempo, chooseTempoOctave, TUNED } from '../../app/js/audio/transcribe.js';

const argv = process.argv.slice(2), N = +(argv[argv.indexOf('--n') + 1] || 1200);
const ex = JSON.parse(fs.readFileSync('/tmp/jse-symbolic.json', 'utf8')).filter(e => e.ts[1] === 4 && e.ts[0] % 3 !== 0 || e.ts[0] === 3 && e.ts[1] === 4);
let s = 12345; const R = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const cases = { melody: [], piano: [] };
for (const e of ex.slice(0, N)) {
  const bpm = 60 * Math.pow(160 / 60, R()), spq = 60 / bpm;
  // melody: top note per onset of the first staff; piano: everything
  const first = Math.min(...e.ons.map(o => o[3]));
  const top = new Map(); for (const [q, dq, p, si] of e.ons) if (si === first) { const k = q; if (!top.has(k) || top.get(k)[2] < p) top.set(k, [q, dq, p]); }
  const mk = list => list.map(([q, dq, p]) => ({ on: 0.5 + q * spq, off: 0.5 + (q + dq) * spq * 0.95, pitch: p, amp: 0.6 }));
  const mel = mk([...top.values()].sort((a, b) => a[0] - b[0])), all = mk(e.ons);
  for (const [kind, notes] of [['melody', mel], ['piano', all]]) {
    if (notes.length < 8) continue;
    const dur = Math.max(...notes.map(n => n.off)) + 1;
    const te = estimateTempo(onsetEnvelope(notes, dur), TUNED.tempo);
    cases[kind].push({ te, notes, bpm });
  }
}
const acc = (kind, cfg) => { cfg = { ...cfg, octaveSet: [1, 2, 0.5] }; let ok = 0; for (const c of cases[kind]) { const r = chooseTempoOctave(c.te, c.notes, cfg); if (Math.abs(r.bpm / c.bpm - 1) <= 0.04) ok++; } return ok / cases[kind].length; };
const base = { ...TUNED.tempo };
console.log('cases', cases.melody.length, cases.piano.length, 'current', acc('melody', { ...base, octIoi: base.octIoi, octIoiW: base.octIoiW }).toFixed(3), acc('piano', { ...base, octIoi: base.octIoiPiano, octIoiW: base.octIoiWPiano }).toFixed(3));
let best = null;
for (const priorBpm of [100, 110, 120, 130]) for (const priorOct of [0.8, 1, 1.3]) for (const octPriorW of [0.5, 1, 2]) {
  const shared = { ...base, priorBpm, priorOct, octPriorW };
  const per = {};
  for (const kind of ['melody', 'piano']) {
    let b = null;
    for (const octIoi of [0.4, 0.5, 0.6, 0.75, 0.9]) for (const octIoiW of [0, 0.25, 0.5, 1, 2]) { const a = acc(kind, { ...shared, octIoi, octIoiW }); if (!b || a > b.a) b = { a, octIoi, octIoiW }; }
    per[kind] = b;
  }
  const score = (per.melody.a + per.piano.a) / 2;
  if (!best || score > best.score) { best = { score, priorBpm, priorOct, octPriorW, per }; console.log(JSON.stringify(best)); }
}
console.log('best', JSON.stringify(best));
