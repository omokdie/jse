// Audio → score, end to end on synthesized audio with exact ground truth (network + score-ification), plus unit
// checks of the pure helpers (spelling, key, quantisation/ties, WAV I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../app/js/audio/tfgraph.js';
import { BasicPitch } from '../../app/js/audio/basicpitch.js';
import { transcribe, spell, estimateKey, quantize, buildScore, chordFromChroma } from '../../app/js/audio/transcribe.js';
import { parseWav, encodeWav, resample, wavToMono22050 } from '../../app/js/audio/decode.js';
import { validateScore, voiceTicks, measureCapacity, effectiveTimeSig, durTicks, midiOf } from '../../app/js/model/score.js';
import { engrave } from '../../app/js/engrave/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelDir = path.join(here, '../../app/vendor/basic-pitch');
const bp = new BasicPitch(loadGraph(JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8')), fs.readFileSync(path.join(modelDir, 'group1-shard1of1.bin'))));
const SR = 22050;

// G major melody, 4/4 (quarter = 1): [midi, quarters]
const MELODY = [[67, 1], [69, 1], [71, 1], [67, 1], [74, 2], [71, 0.5], [72, 0.5], [74, 1], [76, 1], [74, 1], [72, 1], [69, 1], [66, 1], [69, 1], [74, 2], [71, 1], [69, 0.5], [67, 0.5], [66, 1], [62, 1], [67, 4]];
// left hand: Alberti bass in eighths (G G C D G G harmonies), final whole note
const alb = (a, b, c) => [a, c, b, c, a, c, b, c].map(p => [p, 0.5]);
const BASS = [...alb(43, 47, 50), ...alb(43, 47, 50), ...alb(48, 52, 55), ...alb(50, 54, 57), ...alb(43, 47, 50), [43, 4]];
function render(lines, bpm, lead = 0.5) {
  const spq = 60 / bpm, end = lead + lines.reduce((m, l) => Math.max(m, l.reduce((s, [, q]) => s + q, 0)), 0) * spq + 1.5;
  const y = new Float32Array(Math.ceil(end * SR));
  for (const line of lines) {
    let q = 0;
    for (const [p, d] of line) {
      const f0 = 440 * 2 ** ((p - 69) / 12), t0 = lead + q * spq, dur = d * spq * 0.95, n = Math.ceil((dur + 0.3) * SR), i0 = Math.round(t0 * SR);
      for (let i = 0; i < n && i0 + i < y.length; i++) {
        const t = i / SR, env = Math.min(1, t / 0.005) * Math.exp(-t / 0.9) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.04));
        let s = 0; for (let k = 1; k <= 6; k++) if (k * f0 < SR / 2) s += Math.sin(2 * Math.PI * k * f0 * t) / k;
        y[i0 + i] += 0.12 * env * s;
      }
      q += d;
    }
  }
  return y;
}
const onsetsQ = line => { let q = 0; return line.map(([p, d]) => { const o = { q, p }; q += d; return o; }); };
/** Written onsets of a ScoreDoc relative to its first note: Set of "q·24:pitch". */
function written(score) {
  const out = []; let q0 = 0;
  score.measures.forEach((m, mi) => {
    const cap = m.pickup ? Math.max(...m.staves.map(sm => voiceTicks(sm.voices[0]))) : measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach((sm, si) => sm.voices.forEach(v => { let t = 0; for (const ev of v) { if (ev.kind === 'note') for (const n of ev.notes) if (!n.tieEnd) out.push({ q: q0 + t / 960, p: midiOf(n), si }); t += durTicks(ev); } }));
    q0 += cap / 960;
  });
  return out;
}
function assertWellFormed(score) {
  assert.ok(validateScore(score).ok, 'valid ScoreDoc');
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => {
    const cap = measureCapacity(effectiveTimeSig(score, mi)), have = voiceTicks(sm.voices[0]);
    if (m.pickup) assert.ok(have > 0 && have < cap, `pickup m${mi}`); else assert.equal(have, cap, `measure ${mi} staff ${si} fills its bar`);
  }));
  assert.ok(engrave(score).pages.length >= 1);
}

test('melody: synthesized G-major tune at 100 BPM → right tempo, key, metre and ≥ 90 % of written notes', () => {
  const post = bp.evaluate(render([MELODY], 100));
  const r = transcribe(post, { mode: 'melody', chords: true, title: 'test' });
  assert.equal(r.mode, 'melody');
  assert.ok(Math.abs(r.bpm / 100 - 1) < 0.04, `bpm ${r.bpm}`);
  assert.equal(r.key.fifths, 1, 'G major / E minor signature');
  assert.deepEqual([r.timeSig.num, r.timeSig.den], [4, 4]);
  assert.equal(r.pickupBeats, 0);
  assertWellFormed(r.score);
  const got = written(r.score), want = onsetsQ(MELODY);
  const q0 = got[0].q, set = new Set(got.map(n => `${Math.round((n.q - q0) * 24)}:${n.p}`));
  const hit = want.filter(w => set.has(`${Math.round(w.q * 24)}:${w.p}`)).length;
  assert.ok(hit / want.length >= 0.9, `written notes right: ${hit}/${want.length}`);
  // F♯ is spelled as F♯ (not G♭) in G major
  const fs = r.score.measures.flatMap(m => m.staves[0].voices[0]).flatMap(e => e.notes || []).filter(n => midiOf(n) % 12 === 6);
  assert.ok(fs.length && fs.every(n => n.step === 'F' && n.alter === 1));
  // re-quantising with a forced tempo (no network) keeps the notes but rescales the rhythm
  const r2 = transcribe(post, { mode: 'melody', bpm: 50, notes: r.cache });
  assert.ok(r2.score.measures.length < r.score.measures.length);
  assertWellFormed(r2.score);
});

test('piano: melody + bass → grand staff split around middle C, notes found', () => {
  const post = bp.evaluate(render([MELODY, BASS], 96));
  const r = transcribe(post, { mode: 'piano', chords: true });
  assert.equal(r.score.parts[0].staves.length, 2);
  assert.ok(Math.abs(r.bpm / 96 - 1) < 0.04, `bpm ${r.bpm}`);
  assertWellFormed(r.score);
  const got = written(r.score), q0 = got.reduce((m, n) => Math.min(m, n.q), Infinity);
  const at = new Map(got.map(n => [`${Math.round((n.q - q0) * 24)}:${n.p}`, n.si]));
  const found = (line, staff) => onsetsQ(line).filter(w => at.get(`${Math.round(w.q * 24)}:${w.p}`) === staff).length / line.length;
  // true notes recovered at the right written position AND on the right staff (overtone "ghost" notes are tolerated)
  assert.ok(found(BASS, 1) >= 0.85, `left hand on the lower staff: ${found(BASS, 1)}`);
  assert.ok(found(MELODY, 0) >= 0.85, `melody on the upper staff: ${found(MELODY, 0)}`);
  assert.ok(got.filter(n => n.p >= 64).every(n => n.si === 0) && got.filter(n => n.p < 52).every(n => n.si === 1), 'clear registers never cross staves');
  assert.ok(r.score.measures.some(m => m.chords?.length), 'chord symbols');
});

test('helpers: spelling, key, chords, quantisation with ties, WAV I/O', () => {
  assert.deepEqual(spell(66, 1), { step: 'F', octave: 4, alter: 1 });       // F♯ in G
  assert.deepEqual(spell(70, -1), { step: 'B', octave: 4, alter: -1 });     // B♭ in F
  assert.deepEqual(spell(68, 0, 'minor'), { step: 'G', octave: 4, alter: 1 });   // G♯ leading tone in A minor
  assert.deepEqual(spell(77, 6), { step: 'E', octave: 5, alter: 1 });       // E♯ in F♯ major
  assert.deepEqual(spell(71, -6), { step: 'C', octave: 5, alter: -1 });     // C♭ in G♭ major
  const notes = (ps) => ps.map((p, i) => ({ on: i * 0.5, off: i * 0.5 + 0.45, pitch: p, amp: 0.6 }));
  assert.equal(estimateKey(notes([62, 64, 66, 67, 69, 71, 73, 74, 69, 66, 62])).fifths, 2);   // D major
  assert.equal(estimateKey(notes([65, 67, 69, 70, 72, 74, 76, 77, 72, 65])).fifths, -1);     // F major
  const ch = new Array(12).fill(0); ch[7] = 1; ch[11] = 0.8; ch[2] = 0.7; ch[5] = 0.5;
  assert.equal(chordFromChroma(ch, 7, 0).text, 'G7');
  // a note across the barline is tied; rests fill the gaps
  const beats = Array.from({ length: 20 }, (_, i) => i * 0.5);
  const { notes: q } = quantize([{ on: 1.5, off: 2.5, pitch: 60, amp: 0.5 }, { on: 2.5, off: 3.0, pitch: 62, amp: 0.5 }], beats, {});
  assert.deepEqual(q.map(n => [n.t0, n.t1]), [[2880, 4800], [4800, 5760]]);
  const s = buildScore(q, { ts: { num: 4, den: 4 } });
  const m0 = s.measures[0].staves[0].voices[0], m1 = s.measures[1].staves[0].voices[0];
  assert.ok(m0[m0.length - 1].notes[0].tieStart && m1[0].notes[0].tieEnd);
  assert.equal(voiceTicks(m0), 3840); assert.equal(voiceTicks(m1), 3840);
  // WAV round trip + resampling length
  const x = Float32Array.from({ length: 2205 }, (_, i) => Math.sin(i / 10) * 0.5);
  const w = parseWav(encodeWav(x, 22050));
  assert.equal(w.sampleRate, 22050); assert.ok(Math.abs(w.channels[0][100] - x[100]) < 1e-4);
  assert.equal(resample(x, 44100, 22050).length, 1102);
  assert.equal(wavToMono22050(encodeWav(x, 44100)).length, 1102);
});

test('triplet beats and 6/8 bars are written correctly', () => {
  const beats = Array.from({ length: 24 }, (_, i) => i * 0.6);
  const mk = (on, off, p) => ({ on, off, pitch: p, amp: 0.6 });
  // beat 0: three eighth-triplets, beat 1: quarter, beats 2–3: half
  const notes = [mk(0, 0.19, 60), mk(0.2, 0.39, 62), mk(0.4, 0.59, 64), mk(0.6, 1.15, 65), mk(1.2, 2.35, 67)];
  const { notes: q, grid } = quantize(notes, beats, { triplets: true, legato: true });
  assert.equal(grid[0], 3); assert.equal(grid[1], 4);
  assert.deepEqual(q.map(n => n.t0), [0, 320, 640, 960, 1920]);
  const s = buildScore(q, { ts: { num: 4, den: 4 }, tripletBeats: [0] });
  const v = s.measures[0].staves[0].voices[0];
  assert.equal(voiceTicks(v), 3840);
  const trip = v.filter(e => e.tuplet);
  assert.equal(trip.length, 3); assert.ok(trip.every(e => e.dur.base === 'eighth' && e.tuplet.num === 3 && e.tuplet.id === trip[0].tuplet.id));
  assert.ok(validateScore(s).ok); assert.ok(engrave(s).pages.length);
  // 6/8: dotted-quarter beats split in three eighths
  const b68 = Array.from({ length: 12 }, (_, i) => i * 0.9);
  const n68 = [mk(0, 0.28, 67), mk(0.3, 0.58, 69), mk(0.6, 0.88, 71), mk(0.9, 1.78, 72), mk(1.8, 3.5, 74)];
  const { notes: q68 } = quantize(n68, b68, { beatTicks: 1440, sub: 6, legato: true });
  assert.deepEqual(q68.map(n => n.t0), [0, 480, 960, 1440, 2880]);
  const s68 = buildScore(q68, { ts: { num: 6, den: 8 }, beatTicks: 1440 });
  assert.equal(voiceTicks(s68.measures[0].staves[0].voices[0]), 2880);
  assert.equal(voiceTicks(s68.measures[1].staves[0].voices[0]), 2880);
  assert.equal(s68.measures[0].tempo.dots, 1);
  assert.ok(validateScore(s68).ok); assert.ok(engrave(s68).pages.length);
});
