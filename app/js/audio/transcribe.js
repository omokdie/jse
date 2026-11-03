// Audio → score ("score-ification") on top of the Basic Pitch posteriorgrams. Pure functions (browser, Worker, Node).
//   posteriorgrams ─┬─ poly notes (Basic Pitch decoding, tuned thresholds)        ← piano / polyphonic mode
//                   └─ melody line (Viterbi over pitch salience with continuity)   ← melody / singing mode
//   notes → onset envelope → tempo (autocorrelation + prior) → beats (dynamic programming, follows rubato)
//         → meter & downbeat (accent pattern) → key (Krumhansl–Kessler) → grid quantisation (16ths, optional
//         triplets per beat) → staves (treble, or grand staff split near C4 with hand hysteresis) → ScoreDoc
//         (ties across barlines, rests, key-aware spelling, chord symbols from beat chroma).
// Parameters in TUNED were fitted on the synthetic dev corpus (tools/audio/README.md); everything is overridable.
import { outputToNotesPoly, frameTime, N_PITCH, MIDI_OFFSET } from './basicpitch.js';
import { createScore, createPart, createMeasure, newId, STEPS, midiOf, validateScore } from '../model/score.js';
import { alignedDurations } from '../model/commands.js';
import { KEY_MODEL } from './keymodel.js';

export const TUNED = {
  // fitted by coordinate descent on the dev split (tools/audio/eval.mjs --tune; grid in tools/audio/tune_grid.json)
  poly: { onsetThresh: 0.6, frameThresh: 0.4, minNoteLen: 14, melodiaTrick: false, energyTolerance: 16, minAmp: 0, maxPolyphony: 10, dropOvertones: 0 },
  melody: { lo: 36, hi: 96, voicing: 0.32, jump: 1.2, jumpPerSemi: 0.4, voiceCost: 3, onsetSplit: 0.6, minDur: 0.07, mergeGlitch: 0.08 },
  // tempo-octave weights fitted on ~1,800 symbolic excerpts (tools/audio/train_tempo.mjs), checked on train+dev audio;
  // tightness (beat-tracker tempo continuity) on dev
  tempo: { minBpm: 45, maxBpm: 220, priorBpm: 120, priorOct: 0.8, tightness: 2000, octIoi: 0.5, octIoiPiano: 0.4, octIoiW: 0.5, octIoiWPiano: 1, octPriorW: 2, halfFold: 0, chooserFolded: false },
  meter: { threeBias: 0.12, pickupBias: 0.1, compound: 0.4 },
  key: { nEff: 40, priorW: 0.3, kk: 0 },
  quant: { tripletGain: 0.55, legatoGap: 0.5 },
  split: { mid: 60, hysteresis: 4 },
  autoPolyphony: 1.6,   // fitted on the train split (overtone-cleaned polyphony: melodies ≤ 1.44, piano ≥ 1.76)
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ------------------------------------------------------------------ notes
/** Polyphonic notes in seconds: [{on, off, pitch, amp}] */
export function polyNotes(post, p = TUNED.poly) {
  const ev = outputToNotesPoly(post.note, post.onset, post.nFrames, p);
  let notes = ev.map(n => ({ on: frameTime(n.startFrame), off: frameTime(n.startFrame + n.durationFrames), pitch: n.pitchMidi, amp: n.amplitude }));
  if (p.minAmp) notes = notes.filter(n => n.amp >= p.minAmp);
  notes.sort((a, b) => a.on - b.on || a.pitch - b.pitch);
  if (p.maxPolyphony) notes = limitPolyphony(notes, p.maxPolyphony);
  if (p.dropOvertones) notes = withoutOvertones(notes, p.dropOvertones, OCTAVE_STEPS);
  return notes;
}
function limitPolyphony(notes, max) {
  // drop the weakest notes of onset clusters that exceed `max` simultaneous starts (ghost harmonics)
  const out = []; let i = 0;
  while (i < notes.length) {
    let j = i; while (j < notes.length && notes[j].on - notes[i].on < 0.03) j++;
    const grp = notes.slice(i, j); if (grp.length > max) grp.sort((a, b) => b.amp - a.amp).splice(max);
    out.push(...grp); i = j;
  }
  return out.sort((a, b) => a.on - b.on || a.pitch - b.pitch);
}

/**
 * Predominant melody: Viterbi over pitch states [lo..hi] + "silent", emission = log salience from the note
 * posteriorgram, transitions penalise jumps (a + b·|Δ|) and voicing changes. Runs of one pitch become notes;
 * repeated notes are split at onset peaks; sub-100 ms glitches between equal pitches (vibrato) are merged.
 */
export function melodyNotes(post, p = TUNED.melody) {
  const T = post.nFrames, lo = clamp(p.lo, MIDI_OFFSET, MIDI_OFFSET + N_PITCH - 1), hi = clamp(p.hi, lo, MIDI_OFFSET + N_PITCH - 1);
  const R = hi - lo + 1, U = R, S = R + 1;
  const emit = new Float32Array(S), score = new Float64Array(S), next = new Float64Array(S);
  const back = new Uint8Array(T * S);
  const logV = Math.log(p.voicing);
  const jumpCost = new Float64Array(R); for (let d = 0; d < R; d++) jumpCost[d] = d === 0 ? 0 : p.jump + p.jumpPerSemi * Math.min(d, 12);
  for (let t = 0; t < T; t++) {
    const row = t * N_PITCH;
    for (let i = 0; i < R; i++) emit[i] = Math.log(Math.max(post.note[row + lo - MIDI_OFFSET + i], 1e-4));
    emit[U] = logV;
    if (t === 0) { for (let i = 0; i < S; i++) score[i] = emit[i] - (i === U ? 0 : p.voiceCost); continue; }
    // best predecessor among voiced states, using the (capped-linear) jump cost
    for (let j = 0; j < R; j++) {
      let best = score[U] - p.voiceCost, arg = U;
      for (let i = 0; i < R; i++) { const v = score[i] - jumpCost[i > j ? i - j : j - i]; if (v > best) { best = v; arg = i; } }
      next[j] = best + emit[j]; back[t * S + j] = arg;
    }
    let bu = score[U], au = U; for (let i = 0; i < R; i++) { const v = score[i] - p.voiceCost; if (v > bu) { bu = v; au = i; } }
    next[U] = bu + emit[U]; back[t * S + U] = au;
    let m = -Infinity; for (let i = 0; i < S; i++) if (next[i] > m) m = next[i];
    for (let i = 0; i < S; i++) score[i] = next[i] - m;   // renormalise
  }
  const path = new Uint8Array(T); let s = 0, m = -Infinity; for (let i = 0; i < S; i++) if (score[i] > m) { m = score[i]; s = i; }
  for (let t = T - 1; t >= 0; t--) { path[t] = s; s = back[t * S + s]; }
  // runs → notes
  let notes = [];
  for (let t = 0; t < T;) {
    const st = path[t]; let e = t + 1; while (e < T && path[e] === st) e++;
    if (st !== U) {
      const pitch = lo + st, c = pitch - MIDI_OFFSET;
      // split repeated notes at onset peaks inside the run
      let a = t;
      for (let k = t + 3; k < e - 3; k++) {
        const o = Math.max(post.onset[k * N_PITCH + c], 0.8 * post.onset[k * N_PITCH + Math.max(0, c - 1)], 0.8 * post.onset[k * N_PITCH + Math.min(N_PITCH - 1, c + 1)]);
        if (o > p.onsetSplit && o >= post.onset[(k - 1) * N_PITCH + c] && o >= post.onset[(k + 1) * N_PITCH + c] && k - a >= 4) { notes.push(runNote(post, a, k, pitch)); a = k; }
      }
      notes.push(runNote(post, a, e, pitch));
    }
    t = e;
  }
  // merge vibrato glitches A-B-A (B short, ±1–2 semitones) and drop very short blips
  for (let i = 1; i < notes.length - 1; i++) {
    const a = notes[i - 1], b = notes[i], c = notes[i + 1];
    if (b.off - b.on < p.mergeGlitch && a.pitch === c.pitch && Math.abs(b.pitch - a.pitch) <= 2 && b.on - a.off < 0.03 && c.on - b.off < 0.03 && !c.split) {
      a.off = c.off; a.amp = Math.max(a.amp, c.amp); notes.splice(i, 2); i--;
    }
  }
  notes = notes.filter(n => n.off - n.on >= p.minDur);
  return notes;
}
function runNote(post, a, b, pitch) {
  const c = pitch - MIDI_OFFSET; let s = 0; for (let k = a; k < b; k++) s += post.note[k * N_PITCH + c];
  return { on: frameTime(a), off: frameTime(b), pitch, amp: s / Math.max(1, b - a) };
}

/** Drop notes an octave / twelfth / two octaves… above a louder overlapping note (overtones read as notes). */
export function withoutOvertones(notes, ratio = 0.8, steps = OVERTONE_STEPS) {
  const out = [];
  for (const n of notes) {
    const ghost = notes.some(m => m !== n && steps.has(n.pitch - m.pitch) && m.amp >= n.amp * ratio && Math.abs(m.on - n.on) < 0.06 && Math.min(n.off, m.off) - Math.max(n.on, m.on) > 0.6 * (n.off - n.on));
    if (!ghost) out.push(n);
  }
  return out;
}
const OVERTONE_STEPS = new Set([12, 19, 24, 28, 31]);
const OCTAVE_STEPS = new Set([12, 24]);
/** Average number of simultaneously sounding notes while anything sounds. */
export function polyphony(notes) {
  if (!notes.length) return 0;
  const ev = []; notes.forEach(n => { ev.push([n.on, 1]); ev.push([n.off, -1]); });
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, last = ev[0][0], area = 0, busy = 0;
  for (const [t, d] of ev) { if (cur > 0) { area += cur * (t - last); busy += t - last; } cur += d; last = t; }
  return busy ? area / busy : 0;
}

// ------------------------------------------------------------------ tempo & beats
const ENV_FPS = 100;
/** Onset-strength envelope (100 Hz) from note starts: amplitude × length weight, bass boost, Gaussian smoothed. */
export function onsetEnvelope(notes, duration) {
  const n = Math.ceil((duration + 1) * ENV_FPS), env = new Float32Array(n);
  for (const nt of notes) {
    const k = Math.round(nt.on * ENV_FPS); if (k < 0 || k >= n) continue;
    const len = Math.min(1.5, nt.off - nt.on);
    env[k] += (0.3 + nt.amp) * (0.4 + len) * (nt.pitch < 55 ? 1.4 : 1);
  }
  const sm = new Float32Array(n), K = [0.1, 0.25, 0.4, 0.25, 0.1];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -2; j <= 2; j++) { const v = env[i + j]; if (v) s += v * K[j + 2]; } sm[i] = s; }
  return sm;
}
/** Global tempo: autocorrelation of the envelope over 45–220 BPM, multiples folded in, log-normal tempo prior.
 *  candidates[].ac is the raw autocorrelation at that lag (used by chooseTempoOctave). */
export function estimateTempo(env, p = TUNED.tempo) {
  const minL = Math.floor(ENV_FPS * 60 / p.maxBpm), maxL = Math.ceil(ENV_FPS * 60 / p.minBpm);
  const ac = new Float64Array(maxL * 4 + 2);
  let mean = 0; for (let i = 0; i < env.length; i++) mean += env[i]; mean /= env.length || 1;
  for (let L = 1; L < ac.length; L++) { let s = 0; for (let i = L; i < env.length; i++) s += (env[i] - mean) * (env[i - L] - mean); ac[L] = s; }
  let best = -Infinity, bestL = Math.round(ENV_FPS * 60 / p.priorBpm);
  const cands = [];
  for (let L = minL; L <= maxL; L++) {
    // fold in the 2nd/3rd multiples (a beat also repeats at 2 and 3 beats); no L/2 term — that credits the half tempo
    const v = ac[L] + 0.5 * ac[2 * L] + 0.25 * (ac[3 * L] || 0) + (p.halfFold || 0) * Math.max(0, ac[Math.round(L / 2)] || 0);
    const bpm = 60 * ENV_FPS / L;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / p.priorBpm) / p.priorOct, 2));
    const sc = v * prior;
    cands.push({ L, bpm, sc, ac: p.chooserFolded ? v : ac[L] });
    if (sc > best) { best = sc; bestL = L; }
  }
  // parabolic refinement of the lag
  const a = ac[bestL - 1] || 0, b = ac[bestL], c = ac[bestL + 1] || 0;
  const off = (a - 2 * b + c) !== 0 ? clamp(0.5 * (a - c) / (a - 2 * b + c), -0.5, 0.5) : 0;
  return { bpm: 60 * ENV_FPS / (bestL + off), period: (bestL + off) / ENV_FPS, candidates: cands };
}
/**
 * Resolve the tempo octave: candidates T·{½, 1, 2} scored by autocorrelation strength, the tempo prior and
 * how plausible the resulting note values are (median inter-onset interval near `octIoi` beats — written melodies
 * move mostly in eighths and quarters, so whole-note-only or 16th-only readings are unlikely).
 */
export function chooseTempoOctave(te, notes, p = TUNED.tempo) {
  const on = [...new Set(notes.map(n => Math.round(n.on * 50) / 50))].sort((a, b) => a - b);
  const ioi = []; for (let i = 1; i < on.length; i++) if (on[i] - on[i - 1] > 0.06) ioi.push(on[i] - on[i - 1]);
  const mIoi = ioi.length ? median(ioi) : null;
  const acAt = bpm => { let best = -Infinity; for (const c of te.candidates) if (Math.abs(Math.log(c.bpm / bpm)) < 0.03) best = Math.max(best, c.ac); return best; };
  const acMax = Math.max(...te.candidates.map(c => c.ac), 1e-9);
  let best = null;
  for (const k of p.octaveSet || [1, 2, 0.5]) {      // ×1.5 / ×⅔ (simple ↔ compound) is left to the metre detector
    const bpm = te.bpm * k; if (bpm < p.minBpm || bpm > p.maxBpm) continue;
    const ac = acAt(bpm); if (!Number.isFinite(ac)) continue;
    const sAc = Math.log(Math.max(1e-3, ac / acMax));
    const sPrior = -0.5 * Math.pow(Math.log2(bpm / p.priorBpm) / p.priorOct, 2) * p.octPriorW;
    const sIoi = mIoi ? -p.octIoiW * Math.pow(Math.log2((mIoi * bpm / 60) / p.octIoi), 2) : 0;
    const sc = sAc + sPrior + sIoi - (k === 1 ? 0 : 0.05);
    if (!best || sc > best.sc) best = { bpm, period: 60 / bpm, sc, k };
  }
  return best || { bpm: te.bpm, period: te.period, k: 1 };
}
/** Share of note onsets on ternary (⅓, ⅔) vs binary (¼, ½, ¾) beat subdivisions → evidence for compound metre. */
export function ternaryEvidence(notes, beats) {
  let tern = 0, bin = 0;
  for (const n of notes) {
    const b = beatPos(beats, n.on), f = b - Math.floor(b);
    if (Math.abs(f - 1 / 3) < 0.07 || Math.abs(f - 2 / 3) < 0.07) tern++;
    else if (Math.abs(f - 0.5) < 0.07 || Math.abs(f - 0.25) < 0.05 || Math.abs(f - 0.75) < 0.05) bin++;
  }
  return { tern, bin, ratio: (tern + 1) / (bin + 1), share: notes.length ? tern / notes.length : 0 };
}
/**
 * Beat tracking by dynamic programming (Ellis 2007): beats lie on strong onsets and successive intervals stay
 * close to the tempo period (log-interval penalty, `tightness`). Returns beat times in seconds covering
 * [0, duration] (extrapolated with the local period before the first / after the last tracked beat).
 */
export function trackBeats(env, period, duration, { tightness = TUNED.tempo.tightness, fixed = false } = {}) {
  const P = period * ENV_FPS, n = env.length;
  const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let envMax = 0; for (let i = 0; i < n; i++) envMax = Math.max(envMax, env[i]);
  const local = Float64Array.from(env, v => v / (envMax || 1));
  const tight = fixed ? tightness * 4 : tightness;
  for (let t = 0; t < n; t++) {
    let best = -Infinity, arg = -1;
    const a = Math.max(0, Math.floor(t - 2 * P)), b = Math.floor(t - P / 2);
    for (let u = a; u <= b; u++) { const r = Math.log((t - u) / P); const v = cum[u] - tight * r * r * 0.01; if (v > best) { best = v; arg = u; } }
    cum[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0); back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // last beat: best cumulative score within the final period
  let end = n - 1, bestEnd = -Infinity;
  for (let t = Math.max(0, Math.floor(n - P * 1.5)); t < n; t++) if (cum[t] > bestEnd) { bestEnd = cum[t]; end = t; }
  const beats = []; for (let t = end; t >= 0; t = back[t]) { beats.push(t / ENV_FPS); if (back[t] < 0) break; }
  beats.reverse();
  if (beats.length < 2) { const out = []; for (let t = 0; t <= duration + period; t += period) out.push(t); return out; }
  const per0 = beats[1] - beats[0], perN = beats[beats.length - 1] - beats[beats.length - 2];
  while (beats[0] - per0 > -per0 * 0.5) beats.unshift(beats[0] - per0);
  while (beats[beats.length - 1] < duration + perN) beats.push(beats[beats.length - 1] + perN);
  return beats;
}
/** Fractional beat index of time t (piecewise linear over beat times). */
function beatPos(beats, t) {
  let lo = 0, hi = beats.length - 1;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[hi]) return hi + (t - beats[hi]) / (beats[hi] - beats[hi - 1]);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
  return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
}

// ------------------------------------------------------------------ meter, key, chords
/** Downbeat phase and beats-per-bar (3 or 4; `force` fixes the count): accents from long/bass/loud note starts. */
export function estimateMeter(notes, beats, { force = null } = {}) {
  const nb = beats.length, acc = new Float64Array(nb), chroma = Array.from({ length: nb }, () => new Float64Array(12));
  for (const n of notes) {
    const bp = beatPos(beats, n.on), k = Math.round(bp);
    if (k < 0 || k >= nb || Math.abs(bp - k) > 0.2) continue;
    acc[k] += (0.4 + n.amp) * (0.5 + Math.min(2, n.off - n.on)) * (n.pitch < 55 ? 1.6 : 1);
    chroma[k][n.pitch % 12] += n.off - n.on;
  }
  // harmonic change between consecutive beats also marks downbeats
  const change = new Float64Array(nb);
  for (let k = 1; k < nb; k++) { let d = 0, s = 0; for (let c = 0; c < 12; c++) { d += Math.abs(chroma[k][c] - chroma[k - 1][c]); s += chroma[k][c] + chroma[k - 1][c]; } change[k] = s ? d / s : 0; }
  const feat = Float64Array.from(acc, (v, k) => v + 0.5 * change[k] * (acc[k] > 0 ? 1 : 0));
  const res = [];
  for (const m of force ? [force] : [4, 3]) for (let ph = 0; ph < m; ph++) {
    let on = 0, off = 0, cn = 0, co = 0;
    for (let k = 0; k < nb; k++) { if ((k - ph) % m === 0) { on += feat[k]; cn++; } else { off += feat[k]; co++; } }
    let sc = (on / Math.max(1, cn)) / ((off / Math.max(1, co)) + 1e-6);
    if (m === 3) sc *= 1 - TUNED.meter.threeBias;
    if (ph !== firstPhase(notes, beats, m)) sc *= 1 - TUNED.meter.pickupBias;   // music usually starts on a downbeat
    res.push({ m, ph, sc });
  }
  res.sort((a, b) => b.sc - a.sc);
  return { beatsPerBar: res[0].m, phase: res[0].ph, scores: res };
}
function firstPhase(notes, beats, m) { if (!notes.length) return 0; const k = Math.max(0, Math.floor(beatPos(beats, notes[0].on) + 0.15)); return k % m; }
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b) { const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); }
/**
 * Key signature by naive Bayes: notes are drawn from a pitch-class profile relative to the signature's major tonic,
 * learned from 1,874 excerpts of the (non-holdout) Finale corpus (audio/keymodel.js, tools/audio/train_symbolic.mjs),
 * with a softened signature prior. Mode (major/minor, for the name only) from Krumhansl–Kessler correlation.
 * → {fifths, mode, tonic, score}
 */
export function estimateKey(notes, p = TUNED.key) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.pitch % 12] += Math.min(2, n.off - n.on) * (0.5 + n.amp);
  const tot = h.reduce((a, b) => a + b, 0) || 1, nEff = Math.min(p.nEff, notes.length);
  let best = null;
  for (let f = -6; f <= 6; f++) {
    const majT = ((f * 7) % 12 + 12) % 12, minT = (majT + 9) % 12;
    let ll = 0; for (let c = 0; c < 12; c++) ll += (h[c] / tot) * KEY_MODEL.logProfile[(c - majT + 12) % 12];
    const kMaj = corr(h, KK_MAJ.map((_, i) => KK_MAJ[(i - majT + 12) % 12]));
    const kMin = corr(h, KK_MIN.map((_, i) => KK_MIN[(i - minT + 12) % 12]));
    const sc = nEff * ll + p.priorW * KEY_MODEL.logPrior[f + 6] + p.kk * Math.max(kMaj, kMin);
    if (!best || sc > best.score) best = { score: sc, fifths: f, mode: kMin > kMaj + 0.05 ? 'minor' : 'major', tonic: kMin > kMaj + 0.05 ? minT : majT };
  }
  return best;
}
const LOF = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Key-aware spelling: the candidate (step, alter) closest to the key's centre on the line of fifths. */
export function spell(midi, fifths = 0, mode = 'major') {
  const pc = ((midi % 12) + 12) % 12, centre = fifths + (mode === 'minor' ? 3 : 2);
  let best = null;
  for (const step of STEPS) for (let alter = -2; alter <= 2; alter++) {
    if ((STEP_PC[step] + alter + 12) % 12 !== pc) continue;
    const d = Math.abs(LOF[step] + 7 * alter - centre) + (Math.abs(alter) === 2 ? 3 : 0) + (fifths >= 0 ? (alter < 0 ? 0.01 : 0) : (alter > 0 ? 0.01 : 0));
    if (!best || d < best.d) best = { step, alter, d };
  }
  const octave = Math.floor((midi - best.alter - STEP_PC[best.step]) / 12) - 1;
  return { step: best.step, octave, alter: best.alter };
}
const CHORD_KINDS = [
  { kind: '', iv: [0, 4, 7], pen: 0 }, { kind: 'm', iv: [0, 3, 7], pen: 0 },
  { kind: '7', iv: [0, 4, 7, 10], pen: 0.08 }, { kind: 'maj7', iv: [0, 4, 7, 11], pen: 0.1 }, { kind: 'm7', iv: [0, 3, 7, 10], pen: 0.08 },
  { kind: 'dim', iv: [0, 3, 6], pen: 0.12 }, { kind: 'sus4', iv: [0, 5, 7], pen: 0.12 },
];
function chordName(root, kind, fifths, mode) { const s = spell(60 + root, fifths, mode); return s.step + (s.alter > 0 ? '#'.repeat(s.alter) : 'b'.repeat(-s.alter)) + kind; }
/** Best chord for a weighted chroma (+ bass pitch class) or null when too little is sounding. */
export function chordFromChroma(ch, bassPc, fifths = 0, mode = 'major') {
  const tot = ch.reduce((s, v) => s + v, 0); if (tot < 1e-3) return null;
  const norm = ch.map(v => v / tot);
  const keyPcs = new Set([0, 2, 4, 5, 7, 9, 11].map(i => ((((fifths * 7) % 12) + 12) % 12 + i) % 12));
  let best = null;
  for (let r = 0; r < 12; r++) for (const k of CHORD_KINDS) {
    const tpl = new Set(k.iv.map(i => (r + i) % 12));
    let inS = 0, outS = 0; for (let c = 0; c < 12; c++) (tpl.has(c) ? (inS += norm[c]) : (outS += norm[c]));
    let sc = inS - 0.7 * outS - k.pen + (bassPc === r ? 0.15 : 0) + (keyPcs.has(r) ? 0.05 : 0);
    // a chord needs its root, its third (or 4th) and its fifth or seventh actually sounding
    const has = i => norm[(r + i) % 12] >= 0.05;
    if (!has(0) || !has(k.iv[1]) || !(has(k.iv[2]) || (k.iv[3] != null && has(k.iv[3])))) continue;
    if (!best || sc > best.sc) best = { sc, root: r, kind: k.kind };
  }
  if (!best || best.sc < 0.25) return null;
  return { text: chordName(best.root, best.kind, fifths, mode), rootPc: best.root, kind: best.kind, score: best.sc };
}

// ------------------------------------------------------------------ quantisation
/**
 * Snap note on/off times to the beat grid. Each beat is divided into `sub` steps (4 = 16ths; 6 for 6/8 beats);
 * with triplets a beat may use 3 steps instead when its onsets fit that clearly better.
 * Returns notes with tick positions {t0, t1} (TPQ 960 per quarter; beatTicks per beat).
 */
export function quantize(notes, beats, { beatTicks = 960, sub = 4, triplets = false, legato = false, q = TUNED.quant } = {}) {
  const nb = beats.length;
  const pos = notes.map(n => ({ n, b0: beatPos(beats, n.on), b1: beatPos(beats, n.off) }));
  // per-beat grid choice
  const grid = new Int8Array(nb + 2).fill(sub);
  if (triplets && sub === 4) {
    const err = Array.from({ length: nb + 2 }, () => [0, 0, 0]);
    for (const p of pos) {
      const k = Math.floor(p.b0 + 1e-6); if (k < 0 || k >= nb) continue;
      const f = p.b0 - k;
      const e4 = Math.abs(f * 4 - Math.round(f * 4)) / 4, e3 = Math.abs(f * 3 - Math.round(f * 3)) / 3;
      err[k][0] += e4; err[k][1] += e3;
      if (Math.round(f * 3) % 3 !== 0 && Math.abs(f * 3 - Math.round(f * 3)) < 0.15) err[k][2]++;
    }
    for (let k = 0; k < nb; k++) if (err[k][2] >= 1 && err[k][1] < err[k][0] * q.tripletGain) grid[k] = 3;
  }
  const snap = b => {
    const k = Math.floor(b + 1e-9), g = grid[clamp(k, 0, nb)] || sub;
    let s = Math.round((b - k) * g);
    if (s >= g) return (k + 1) * beatTicks;
    return k * beatTicks + Math.round(s * beatTicks / g);
  };
  const minT = Math.round(beatTicks / sub);
  const out = pos.map(p => {
    const t0 = snap(p.b0); let t1 = snap(p.b1);
    if (t1 <= t0) t1 = t0 + Math.round(beatTicks / (grid[clamp(Math.floor(p.b0), 0, nb)] || sub));
    return { ...p.n, t0, t1: Math.max(t1, t0 + Math.min(minT, beatTicks / 3)) };
  });
  out.sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
  if (legato) {
    // monophonic line: a short gap before the next note is articulation, not a rest
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      if (b.t0 <= a.t0) continue;
      const gap = b.t0 - a.t1;
      if (gap > 0 && gap <= beatTicks * q.legatoGap) a.t1 = b.t0;
      if (a.t1 > b.t0) a.t1 = b.t0;
    }
  }
  return { notes: out, grid };
}

// ------------------------------------------------------------------ staves
/** Split notes into treble/bass by pitch around C4, with hand-position hysteresis for the middle register. */
export function splitHands(notes, { mid = TUNED.split.mid, hysteresis = TUNED.split.hysteresis } = {}) {
  let rh = 67, lh = 48;
  const groups = new Map();
  for (const n of notes) { const k = n.t0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  for (const [, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    g.sort((a, b) => a.pitch - b.pitch);
    for (const n of g) {
      if (n.pitch >= mid + hysteresis) n.staff = 0;
      else if (n.pitch < mid - hysteresis) n.staff = 1;
      else n.staff = Math.abs(n.pitch - rh) <= Math.abs(n.pitch - lh) + 2 ? 0 : 1;
    }
    // a chord spanning both hands splits at its widest gap
    const t = g.filter(n => n.staff === 0), b = g.filter(n => n.staff === 1);
    if (t.length) rh = 0.7 * rh + 0.3 * median(t.map(n => n.pitch));
    if (b.length) lh = 0.7 * lh + 0.3 * median(b.map(n => n.pitch));
    rh = Math.max(rh, mid + 2); lh = Math.min(lh, mid - 2);
  }
  return notes;
}

// ------------------------------------------------------------------ ScoreDoc
/** One voice per staff: chords of equal onset; durations end at the next onset (or earlier → rest). */
function staffEvents(notes) {
  const by = new Map();
  for (const n of notes) { if (!by.has(n.t0)) by.set(n.t0, []); by.get(n.t0).push(n); }
  const starts = [...by.keys()].sort((a, b) => a - b);
  return starts.map((t0, i) => {
    const g = by.get(t0); const pitches = [...new Set(g.map(n => n.pitch))].sort((a, b) => a - b);
    const end = Math.max(...g.map(n => n.t1));
    return { t0, t1: i + 1 < starts.length ? Math.min(end, starts[i + 1]) : end, pitches, amp: Math.max(...g.map(n => n.amp)) };
  });
}
function noteObjs(pitches, fifths, mode) { return pitches.map(p => spell(p, fifths, mode)); }
/** Lay timed chord events (absolute ticks) into measures of `cap` ticks (first measure `firstCap` for a pickup). */
function fillMeasures(score, si, events, { cap, firstCap, nMeasures, fifths, mode, tripletBeats, beatTicks }) {
  const starts = [], caps = [];
  let acc = 0; for (let m = 0; m < nMeasures; m++) { const c = m === 0 ? firstCap : cap; starts.push(acc); caps.push(c); acc += c; }
  const perMeasure = Array.from({ length: nMeasures }, () => []);
  for (const ev of events) {
    let a = ev.t0; const b = ev.t1;
    let first = true;
    while (a < b) {
      let mi = starts.findIndex((s, i) => a >= s && a < s + caps[i]); if (mi < 0) break;
      const mEnd = starts[mi] + caps[mi], e = Math.min(b, mEnd);
      perMeasure[mi].push({ a: a - starts[mi], b: e - starts[mi], pitches: ev.pitches, tieFrom: !first, tieTo: e < b });
      first = false; a = e;
    }
  }
  for (let mi = 0; mi < nMeasures; mi++) {
    const voice = []; let t = 0;
    const tb = tripletBeats[mi] || new Set();
    const segs = perMeasure[mi].sort((x, y) => x.a - y.a);
    const emit = (a, b, seg) => {   // [a,b) within the measure, may need splitting at triplet beat edges
      let x = a;
      while (x < b) {
        const beat = Math.floor(x / beatTicks), bEnd = (beat + 1) * beatTicks;
        if (tb.has(beat)) {
          const y = Math.min(b, bEnd);
          pushTriplet(voice, beat, Math.round((y - x) / (beatTicks / 3)), seg, beatTicks);
          x = y;
        } else {
          let y = b; for (const k of tb) { const s = k * beatTicks; if (s > x && s < y) y = s; }
          for (const d of alignedDurations(x, y - x)) { voice.push(makeEv(d, seg, voice)); }
          x = y;
        }
      }
    };
    for (const s of segs) {
      if (s.a < t) { if (s.b <= t) continue; s.a = t; }
      if (s.a > t) emit(t, s.a, null);
      emit(s.a, s.b, s);
      t = s.b;
    }
    if (t < caps[mi]) emit(t, caps[mi], null);
    // ties: within a split note every piece but the last starts a tie; pieces after the first end one
    linkTies(voice, fifths, mode);
    // tuplet ids per triplet beat
    const ids = new Map(); for (const ev of voice) if (ev._tb != null) { if (!ids.has(ev._tb)) ids.set(ev._tb, newId()); ev.tuplet = { id: ids.get(ev._tb), num: 3, den: 2, bracket: true, show: 'number' }; delete ev._tb; }
    score.measures[mi].staves[si].voices[0] = voice;
  }
}
function makeEv(d, seg, voice) {
  if (!seg) return { id: newId(), kind: 'rest', dur: { base: d.base, dots: d.dots } };
  return { id: newId(), kind: 'note', dur: { base: d.base, dots: d.dots }, _seg: seg, _pitches: seg.pitches };
}
function pushTriplet(voice, beat, slots, seg, beatTicks) {
  // in a triplet beat (positions are multiples of ⅓ beat): a run of 1 slot → eighth-triplet, 2 → quarter-triplet,
  // 3 (the whole beat) → plain quarter without a bracket
  if (slots <= 0) return;
  if (slots >= 3) { voice.push(makeEv({ base: beatTicks === 960 ? 'quarter' : 'eighth', dots: 0 }, seg, voice)); return; }
  const ev = makeEv({ base: slots === 2 ? 'quarter' : 'eighth', dots: 0 }, seg, voice);
  ev._tb = beat; voice.push(ev);
}
function linkTies(voice, fifths, mode) {
  for (let i = 0; i < voice.length; i++) {
    const ev = voice[i]; if (ev.kind !== 'note') continue;
    const seg = ev._seg, prev = voice[i - 1], next = voice[i + 1];
    const contFromPrev = prev && prev._seg === seg;
    const contToNext = next && next._seg === seg;
    ev.notes = noteObjs(ev._pitches, fifths, mode);
    ev.notes.forEach(n => { if (contToNext || (!contToNext && seg.tieTo)) n.tieStart = true; if (contFromPrev || (!contFromPrev && seg.tieFrom)) n.tieEnd = true; });
  }
  for (const ev of voice) { delete ev._seg; delete ev._pitches; }
}

/** Notes (with t0/t1 ticks) → ScoreDoc. */
export function buildScore(qnotes, { title = '', bpm = 120, ts = { num: 4, den: 4 }, key = { fifths: 0, mode: 'major' }, beatTicks = 960, pickupTicks = 0, grand = false, clef = 'treble', instrument = 'voice', chords = null, tripletBeats = null } = {}) {
  const cap = ts.num * 3840 / ts.den;
  const endTick = qnotes.reduce((m, n) => Math.max(m, n.t1), 0);
  const firstCap = pickupTicks || cap;
  const nMeasures = Math.max(1, pickupTicks ? 1 + Math.ceil(Math.max(0, endTick - pickupTicks) / cap) : Math.ceil(endTick / cap));
  const score = createScore({ title: title || '음원에서 만든 악보', instruments: [grand ? 'piano' : instrument], measures: nMeasures, timeSig: ts, keyFifths: key.fifths, tempo: Math.round(bpm) });
  score.measures[0].keySig = { fifths: key.fifths, mode: key.mode };
  score.measures[0].tempo = { bpm: Math.round(bpm), beatUnit: 'quarter', dots: beatTicks === 1440 ? 1 : 0, text: '', showBpm: true };   // 6/8: dotted quarter
  if (pickupTicks) score.measures[0].pickup = true;
  if (!grand && clef !== 'treble') score.parts[0].staves[0].clef = clef;
  const staves = grand ? [qnotes.filter(n => n.staff !== 1), qnotes.filter(n => n.staff === 1)] : [qnotes];
  // triplet beats per measure (beat index within the measure)
  const tbm = Array.from({ length: nMeasures }, () => new Set());
  if (tripletBeats) for (const absBeat of tripletBeats) {
    const t = absBeat * beatTicks; let mi, rel;
    if (pickupTicks) { if (t < pickupTicks) { mi = 0; rel = t; } else { mi = 1 + Math.floor((t - pickupTicks) / cap); rel = (t - pickupTicks) % cap; } }
    else { mi = Math.floor(t / cap); rel = t % cap; }
    if (mi < nMeasures && beatTicks === 960) tbm[mi].add(Math.floor(rel / beatTicks));
  }
  staves.forEach((ns, si) => fillMeasures(score, si, staffEvents(ns), { cap, firstCap, nMeasures, fifths: key.fifths, mode: key.mode, tripletBeats: tbm, beatTicks }));
  if (chords) for (const c of chords) {
    let mi, rel; if (pickupTicks) { if (c.tick < pickupTicks) { mi = 0; rel = c.tick; } else { mi = 1 + Math.floor((c.tick - pickupTicks) / cap); rel = (c.tick - pickupTicks) % cap; } } else { mi = Math.floor(c.tick / cap); rel = c.tick % cap; }
    if (mi >= nMeasures) continue;
    const m = score.measures[mi]; m.chords = m.chords || [];
    const p = /^([A-G][#b]*)(.*)$/.exec(c.text);
    m.chords.push({ id: newId(), tick: rel, text: c.text, root: p?.[1], kind: p?.[2] || '' });
  }
  validateScore(score, { repair: true });
  return score;
}

// ------------------------------------------------------------------ chords over the quantised notes
function chordTrack(qnotes, { cap, pickupTicks, beatTicks, fifths, mode, total }) {
  const out = []; let last = null;
  const seg = beatTicks * (cap / beatTicks >= 4 ? 2 : cap / beatTicks);   // half bars in 4/4, whole bars otherwise
  const barStart = pickupTicks || 0;
  for (let s = barStart - (pickupTicks ? pickupTicks : 0); s < total; s += (s < barStart ? pickupTicks : seg)) {
    const e = s < barStart ? barStart : s + seg;
    const ch = new Array(12).fill(0); let bass = null, bassP = 999;
    for (const n of qnotes) {
      const ov = Math.min(e, n.t1) - Math.max(s, n.t0); if (ov <= 0) continue;
      ch[n.pitch % 12] += ov * (0.5 + n.amp) * (n.pitch < 60 ? 1.3 : 1);
      if (n.pitch < bassP && n.t0 < s + beatTicks) { bassP = n.pitch; bass = n.pitch % 12; }
    }
    const c = chordFromChroma(ch, bass, fifths, mode);
    if (c && c.text !== last) { out.push({ tick: s, text: c.text }); last = c.text; }
    if (seg <= 0) break;
  }
  return out;
}

// ------------------------------------------------------------------ top level
/**
 * posteriorgrams → { score, notes, qnotes, beats, bpm, key, timeSig, mode, stats, warnings }
 * opts: { mode: 'auto'|'melody'|'piano', timeSig: 'auto'|'4/4'|'3/4'|'6/8', bpm: null|number, triplets, chords,
 *         grid: 16|8 (shortest written value), keyFifths (force key), title,
 *         notes (precomputed {melody, poly} to skip extraction), tuned (override TUNED parts) }
 */
export function transcribe(post, opts = {}) {
  const t0 = Date.now();
  const P = { ...TUNED, ...(opts.tuned || {}) };
  const duration = post.nFrames ? frameTime(post.nFrames) : 0;
  const warnings = [];
  const cache = opts.notes || {};
  const poly = cache.poly || polyNotes(post, P.poly);
  let mode = opts.mode || 'auto';
  // auto mode: polyphony after removing overtone "ghost" notes (organ/brass melodies have strong octave partials);
  // fitted on the train split: melodies ≤ 1.44, piano ≥ 1.76
  const polyDeg = polyphony(poly.length > 4000 ? poly : withoutOvertones(poly));
  if (mode === 'auto') mode = polyDeg < P.autoPolyphony ? 'melody' : 'piano';
  const melody = mode === 'melody' ? (cache.melody || melodyNotes(post, P.melody)) : null;
  const notes = mode === 'melody' ? melody : poly;
  if (!notes.length) warnings.push('음표를 찾지 못했습니다 — 소리가 너무 작거나 음높이가 없는 소리(드럼 등)일 수 있습니다.');
  // tempo / beats
  const env = onsetEnvelope(notes.length ? notes : poly, duration);
  const tsOpt = opts.timeSig && opts.timeSig !== 'auto' ? opts.timeSig : null;
  let compound = tsOpt === '6/8';
  let period, bpmEst;
  if (opts.bpm) { period = 60 / opts.bpm; bpmEst = opts.bpm; }
  else {
    const te = estimateTempo(env, P.tempo);
    const oc = chooseTempoOctave(te, notes.length ? notes : poly, { ...P.tempo, octIoi: mode === 'piano' ? P.tempo.octIoiPiano : P.tempo.octIoi, octIoiW: mode === 'piano' ? P.tempo.octIoiWPiano : P.tempo.octIoiW }); period = oc.period; bpmEst = oc.bpm;
    if (compound) { // dotted-quarter pulse ≈ 40–90 BPM
      const opts2 = [period / 2, period, period * 1.5, period * 2, period * 3].filter(x => x >= 60 / 100 && x <= 60 / 38);
      if (opts2.length) period = opts2.reduce((a, b) => (Math.abs(Math.log(a / 0.85)) < Math.abs(Math.log(b / 0.85)) ? a : b));
      bpmEst = 60 / period;
    }
  }
  let beats = trackBeats(env, period, duration, { tightness: P.tempo.tightness, fixed: !!opts.bpm });
  // automatic compound metre: onsets that subdivide the beat in three → 6/8 with a dotted-quarter beat
  let autoCompound = false;
  if (!tsOpt && !opts.bpm) {
    const te3 = ternaryEvidence(notes, beats);
    if (te3.share > P.meter.compound && te3.ratio > 2) autoCompound = true;
  }
  const ibi = median(beats.slice(1).map((b, i) => b - beats[i]).filter(x => x > 0));
  const bpm = opts.bpm || (ibi ? 60 / ibi : bpmEst);
  if (autoCompound) compound = true;
  // meter
  let ts, beatsPerBar, beatTicks, sub;
  if (compound) { ts = { num: 6, den: 8 }; beatsPerBar = 2; beatTicks = 1440; sub = 6; }
  else if (tsOpt === '3/4') { ts = { num: 3, den: 4 }; beatsPerBar = 3; beatTicks = 960; sub = 4; }
  else if (tsOpt === '4/4') { ts = { num: 4, den: 4 }; beatsPerBar = 4; beatTicks = 960; sub = 4; }
  else if (tsOpt === '2/4') { ts = { num: 2, den: 4 }; beatsPerBar = 2; beatTicks = 960; sub = 4; }
  else { const me = estimateMeter(notes, beats); beatsPerBar = me.beatsPerBar; ts = { num: beatsPerBar, den: 4 }; beatTicks = 960; sub = 4; }
  const me = estimateMeter(notes, beats, { force: beatsPerBar });
  // first beat that carries a note → start of the written music; downbeat phase relative to it
  const firstBeat = notes.length ? Math.floor(beatPos(beats, notes[0].on) + 0.15) : 0;
  const b0 = Math.max(0, firstBeat);
  const phaseRel = ((me.phase - b0) % beatsPerBar + beatsPerBar) % beatsPerBar;   // beats before the first downbeat
  const pickupBeats = phaseRel;
  // shift beats so that index 0 = first written beat
  const bts = beats.slice(b0);
  if (bts.length < 2) bts.push(...[1, 2].map(i => (bts[0] || 0) + i * period));
  if (opts.grid === 8) sub = compound ? 3 : 2;      // coarser grid: shortest value an eighth
  const { notes: qn, grid } = quantize(notes, bts, { beatTicks, sub, triplets: !!opts.triplets && !compound && sub === 4, legato: mode === 'melody', q: P.quant });
  const qnotes = qn.filter(n => n.t0 >= 0);
  const tripletBeats = []; grid.forEach((g, k) => { if (g === 3) tripletBeats.push(k); });
  const key = opts.keyFifths != null ? { fifths: opts.keyFifths, mode: 'major' } : estimateKey(notes);
  // staves
  let grand = false, clef = 'treble';
  if (mode === 'piano') { grand = true; splitHands(qnotes, P.split); }
  else { const md = median(qnotes.map(n => n.pitch)); clef = md < 50 ? 'bass' : md < 59 ? 'treble8vb' : 'treble'; }
  const cap = ts.num * 3840 / ts.den, pickupTicks = pickupBeats * beatTicks;
  const total = qnotes.reduce((m, n) => Math.max(m, n.t1), 0);
  const chords = opts.chords ? chordTrack(mode === 'melody' && cache.poly ? quantize(poly, bts, { beatTicks, sub }).notes.filter(n => n.t0 >= 0) : qnotes, { cap, pickupTicks, beatTicks, fifths: key.fifths, mode: key.mode, total }) : null;
  const score = buildScore(qnotes, { title: opts.title, bpm, ts, key, beatTicks, pickupTicks, grand, clef, instrument: mode === 'melody' ? 'voice' : 'piano', chords, tripletBeats });
  if (mode === 'melody' && polyDeg > 1.8) warnings.push('여러 악기가 함께 연주되는 음원으로 보입니다 — 가장 두드러진 선율만 대략 받아 적었습니다.');
  return {
    score, notes, qnotes, beats: bts, allBeats: beats, bpm, key, timeSig: ts, mode, pickupBeats,
    stats: { notes: notes.length, polyphony: +polyDeg.toFixed(2), ms: Date.now() - t0, measures: score.measures.length, duration },
    warnings, cache: { poly, melody },
  };
}
