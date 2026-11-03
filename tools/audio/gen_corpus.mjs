#!/usr/bin/env node
// Synthetic transcription corpus with exact ground truth, from the cached Finale pieces (EnigmaXML gzip).
//   node tools/audio/gen_corpus.mjs [--cache /home/claude/enigma-cache] [--out tools/audio/corpus] [--per 40] [--train 20] [--seed 7]
// For every piece (deterministic hash split 60/20/20 → train/dev/holdout) it emits up to one MELODY item (top line
// of the first single-staff pitched part) and one PIANO item (both staves of a grand-staff part): an excerpt of
// ≤ 16 measures / ≤ 30 s, a random tempo (optionally with rubato / ritardando), humanised timing and velocity, a
// timbre and augmentation settings. Output per item: <id>.json = { spec for synth.py, ground truth }.
// Ground truth keeps both the performance (seconds) and the written score (measure, tick, quarter position).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { enigmaToScore } from '../../app/js/io/musx.js';
import { durTicks, midiOf, measureCapacity, effectiveTimeSig, effectiveKeySig, voiceTicks } from '../../app/js/model/score.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] == null ? true : arr[i + 1]]] : a), []));
const CACHE = args.cache || '/home/claude/enigma-cache';
const OUT = args.out || path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus');
const PER = +(args.per || 40);
const SEED = +(args.seed || 7);
fs.mkdirSync(OUT, { recursive: true });

function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const splitOf = name => { const h = hash(name) % 100; return h < 60 ? 'train' : h < 80 ? 'dev' : 'holdout'; };

const MELODIC = new Set(['voice', 'melody', 'flute', 'violin', 'clarinet', 'trumpet', 'saxophone', 'recorder', 'viola', 'cello', 'keyboard']);

/** Written-score events of one staff over measures [0, nM): [{mi, tick, q, dTicks, pitches[], tieEnd[], tieStart[]}] */
function staffEvents(score, si, nM, { topOnly = false } = {}) {
  const part = score.parts.find((p, i) => si >= score.parts.slice(0, i).reduce((n, q) => n + q.staves.length, 0) && si < score.parts.slice(0, i + 1).reduce((n, q) => n + q.staves.length, 0));
  const tr = part?.transposeChromatic || 0;
  const out = []; let q0 = 0;
  for (let mi = 0; mi < nM; mi++) {
    const m = score.measures[mi];
    const cap = m.pickup ? Math.max(...m.staves.map(sm => voiceTicks(sm.voices[0] || []))) || measureCapacity(effectiveTimeSig(score, mi)) : measureCapacity(effectiveTimeSig(score, mi));
    const sm = m.staves[si];
    (topOnly ? [sm.voices[0] || []] : sm.voices).forEach(v => {
      let tick = 0;
      for (const ev of v) {
        const d = durTicks(ev);
        if (ev.kind === 'note' && !ev.grace && !ev.hidden && d > 0 && ev.notes?.length) {
          let ns = ev.notes.filter(n => !n.drum);
          if (topOnly) ns = [ns.reduce((a, b) => (midiOf(b) > midiOf(a) ? b : a), ns[0])];
          if (ns.length) out.push({ mi, tick, q: q0 + tick / 960, dq: d / 960, pitches: ns.map(n => midiOf(n) + tr), tieEnd: ns.map(n => !!n.tieEnd), tieStart: ns.map(n => !!n.tieStart) });
        }
        tick += d;
      }
    });
    q0 += cap / 960;
  }
  return { events: out.sort((a, b) => a.q - b.q), totalQ: q0 };
}
/** Merge ties → sounding notes [{q, dq, p}] (q in quarters from the excerpt start). */
function soundingNotes(events) {
  const open = new Map(), out = [];
  for (const e of events) e.pitches.forEach((p, k) => {
    if (e.tieEnd[k] && open.has(p)) { const n = open.get(p); n.dq = e.q + e.dq - n.q; if (!e.tieStart[k]) open.delete(p); return; }
    const n = { q: e.q, dq: e.dq, p }; out.push(n); if (e.tieStart[k]) open.set(p, n);
  });
  return out.sort((a, b) => a.q - b.q || a.p - b.p);
}
/** Tempo map: quarter position → seconds. Constant, rubato (slow sine + random walk) and optional final ritardando. */
function tempoMap(bpm, totalQ, R, style) {
  const step = 0.25, n = Math.ceil(totalQ / step) + 8, t = new Float64Array(n + 1);
  let walk = 0; const ph = R() * 6.28, per = 8 + R() * 12;
  for (let i = 0; i < n; i++) {
    const q = i * step;
    let f = 1;
    if (style !== 'constant') { walk = 0.97 * walk + (R() - 0.5) * 0.012; f *= 1 + 0.06 * Math.sin(6.283 * q / per + ph) + walk; }
    if (style === 'ritardando' && q > totalQ - 4) f *= 1 - 0.08 * (q - (totalQ - 4));
    t[i + 1] = t[i] + step * 60 / (bpm * Math.max(0.5, f));
  }
  return q => { const i = Math.floor(q / step), fr = q / step - i; return i >= n ? t[n] + (q - n * step) * 60 / bpm : t[i] + fr * (t[i + 1] - t[i]); };
}

function makeItem(file, score, kind, split, R) {
  const staffIdx = [];
  let g = 0, chosen = null;
  for (const p of score.parts) {
    if (kind === 'piano' && !chosen && p.staves.length === 2 && p.staves.every(s => s.type === 'standard')) { chosen = p; staffIdx.push(g, g + 1); }
    if (kind === 'melody' && !chosen && p.staves.length === 1 && p.staves[0].type === 'standard' && MELODIC.has(p.instrument)) { chosen = p; staffIdx.push(g); }
    g += p.staves.length;
  }
  if (!chosen) return null;
  // excerpt: ≤ 16 measures and ≤ ~64 quarters, at least 6 notes
  const ts = effectiveTimeSig(score, 0);
  const nM = Math.min(score.measures.length, 16, Math.max(2, Math.floor(64 / (measureCapacity(ts) / 960))));
  if (score.measures.slice(0, nM).some((m, i) => i > 0 && (m.timeSig || m.keySig))) return null;   // keep one meter/key per excerpt
  const evs = staffIdx.map(si => staffEvents(score, si, nM, { topOnly: kind === 'melody' }));
  const events = evs.flatMap((e, s) => e.events.map(ev => ({ ...ev, staff: s })));
  const sound = soundingNotes(evs.flatMap(e => e.events));
  if (sound.length < 6) return null;
  const pitches = sound.map(n => n.p); const lo = Math.min(...pitches), hi = Math.max(...pitches);
  if (lo < 24 || hi > 105) return null;
  const totalQ = evs[0].totalQ;
  const beatQ = ts.den === 8 && ts.num % 3 === 0 ? 1.5 : 4 / ts.den;
  const bpmQ = (kind === 'melody' ? 66 + R() * 80 : 56 + R() * 74);           // quarter-note tempo
  const style = R() < 0.55 ? 'constant' : R() < 0.7 ? 'rubato' : 'ritardando';
  const tm = tempoMap(bpmQ, totalQ, R, style);
  const lead = 0.4 + R() * 0.6;
  const human = kind === 'piano' ? 0.008 : 0.012;
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += R(); return (s - 3) / Math.sqrt(0.5); };
  const notes = sound.map(n => {
    const on = lead + tm(n.q) + gauss() * human * 0.5, off = lead + tm(n.q + n.dq) - 0.02;
    return { t: +on.toFixed(4), d: +Math.max(0.05, off - on).toFixed(4), p: n.p, v: Math.round(Math.max(30, Math.min(120, 84 + gauss() * 9))) };
  });
  const inst = kind === 'piano' ? (R() < 0.75 ? 'piano' : R() < 0.5 ? 'epiano' : 'organ')
    : ['voice', 'voice', 'voice', 'flute', 'strings', 'clarinet', 'organ', 'piano'][Math.floor(R() * 8)];
  const aug = { reverb: R() < 0.7 ? +(0.25 + R() * 1.1).toFixed(2) : 0, wet: +(0.08 + R() * 0.25).toFixed(2), snr: R() < 0.5 ? +(22 + R() * 20).toFixed(1) : null, mp3: R() < 0.6 ? [64, 96, 128, 192][Math.floor(R() * 4)] : null, gain: +(0.3 + R() * 0.6).toFixed(2) };
  const ks = effectiveKeySig(score, 0);
  const beatsQ = []; for (let q = 0; q <= totalQ + 1e-9; q += beatQ) beatsQ.push(+(lead + tm(q)).toFixed(4));
  return {
    id: `${kind}-${(hash(file) % 1e8).toString(36)}`, split, kind, source: file, instrument: inst, sr: 22050, aug,
    notes,
    gt: {
      bpmQ: +bpmQ.toFixed(2), style, ts: { num: ts.num, den: ts.den }, fifths: ks.fifths, mode: ks.mode || 'major',
      pickup: !!score.measures[0].pickup, measures: nM, totalQ, beatQ, beats: beatsQ, lead,
      written: events.map(e => ({ mi: e.mi, tick: e.tick, q: e.q, dq: e.dq, p: e.pitches, tieEnd: e.tieEnd, staff: e.staff })),
      sounding: sound,
    },
  };
}

const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.xml.gz')).sort((a, b) => hash(a + SEED) - hash(b + SEED));
const quota = { train: { melody: 0, piano: 0 }, dev: { melody: 0, piano: 0 }, holdout: { melody: 0, piano: 0 } };
const want = { train: +(args.train ?? PER), dev: PER, holdout: PER };
const R = rng(SEED * 7919);
let parsed = 0, failed = 0;
const index = [];
for (const f of files) {
  const split = splitOf(f);
  if (quota[split].melody >= want[split] && quota[split].piano >= want[split]) { if (Object.keys(quota).every(s => quota[s].melody >= want[s] && quota[s].piano >= want[s])) break; continue; }
  let score;
  try { score = enigmaToScore(zlib.gunzipSync(fs.readFileSync(path.join(CACHE, f))).toString('utf8'), { meta: null }); parsed++; }
  catch { failed++; continue; }
  for (const kind of ['melody', 'piano']) {
    if (quota[split][kind] >= want[split]) continue;
    const it = makeItem(f, score, kind, split, R);
    if (!it) continue;
    fs.writeFileSync(path.join(OUT, it.id + '.json'), JSON.stringify(it));
    quota[split][kind]++; index.push({ id: it.id, split, kind, source: f, instrument: it.instrument });
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log('parsed', parsed, 'failed', failed, JSON.stringify(quota));
