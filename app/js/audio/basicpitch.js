// Basic Pitch in pure JS: windowing + output stitching (port of basic-pitch-ts src/inference.ts) and posteriorgram →
// note-event decoding (port of src/toMidi.ts: outputToNotesPoly with onset inference and the "melodia trick").
// Portions Copyright 2022 Spotify AB, licensed under the Apache License 2.0 (app/vendor/basic-pitch/LICENSE, NOTICE).
// The network itself runs in audio/tfgraph.js. Arrays are flat Float32Arrays, row-major [frame][bin].
import { loadGraph, runGraph, tensor } from './tfgraph.js';

export const SAMPLE_RATE = 22050;
export const FFT_HOP = 256;
export const N_PITCH = 88;                    // piano keys A0..C8
export const N_CONTOUR = 264;                 // 3 bins per semitone
export const MIDI_OFFSET = 21;
const ANNOTATIONS_FPS = Math.floor(SAMPLE_RATE / FFT_HOP);                 // 86
const ANNOT_N_FRAMES = ANNOTATIONS_FPS * 2;                                // 172 frames per window
export const WINDOW_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP;                   // 43844
const N_OVERLAP = 30, HALF_OVERLAP = 15;
const OVERLAP_SAMPLES = N_OVERLAP * FFT_HOP;                               // 7680
export const HOP_SAMPLES = WINDOW_SAMPLES - OVERLAP_SAMPLES;               // 36164
export const FRAMES_PER_WINDOW = ANNOT_N_FRAMES - N_OVERLAP;               // 142 kept frames per window
const WINDOW_OFFSET = (FFT_HOP / SAMPLE_RATE) * (ANNOT_N_FRAMES - WINDOW_SAMPLES / FFT_HOP) + 0.0018;
const OUT = { contour: 'Identity', note: 'Identity_1', onset: 'Identity_2' };

/** Exact time (s) of an unwrapped output frame: window w covers samples w·HOP… and keeps frames 15…156. */
export function frameTime(k) { return (Math.floor(k / FRAMES_PER_WINDOW) * HOP_SAMPLES + (k % FRAMES_PER_WINDOW) * FFT_HOP) / SAMPLE_RATE; }
/** basic-pitch-ts' approximation (kept for fixture compatibility). */
export function modelFrameToTime(k) { return (k * FFT_HOP) / SAMPLE_RATE - WINDOW_OFFSET * Math.floor(k / ANNOT_N_FRAMES); }
export function numWindows(nSamples) { return Math.ceil((nSamples + OVERLAP_SAMPLES / 2) / HOP_SAMPLES); }
export function numOutputFrames(nSamples) { return Math.floor(nSamples * (ANNOTATIONS_FPS / SAMPLE_RATE)); }

/** The w-th model input window: 3840 leading zeros, then the audio, zero-padded at the end (tf.signal.frame padEnd). */
export function windowAt(audio, w) {
  const out = new Float32Array(WINDOW_SAMPLES);
  const start = w * HOP_SAMPLES - OVERLAP_SAMPLES / 2;     // in audio sample coordinates
  const a = Math.max(0, start), b = Math.min(audio.length, start + WINDOW_SAMPLES);
  if (b > a) out.set(audio.subarray(a, b), a - start);
  return out;
}

export class BasicPitch {
  /** @param model {modelJson, weights} or a graph from loadGraph */
  constructor(model) { this.g = model.nodes ? model : loadGraph(model.modelJson, model.weights); }
  /** Run one 43844-sample window → { note, onset (172×88), contour (172×264) } */
  runWindow(win) {
    const inName = this.g.inputs.input_2 || 'input_2';
    const [c, n, o] = runGraph(this.g, { [inName]: tensor([1, WINDOW_SAMPLES, 1], win) }, [OUT.contour, OUT.note, OUT.onset]);
    return { contour: c.data, note: n.data, onset: o.data };
  }
  /**
   * Whole signal (mono 22050 Hz Float32Array) → stitched posteriorgrams.
   * windows: optional [from, to) range (for splitting work across workers); onWindow(i, n) progress.
   */
  evaluate(audio, { onWindow = null, from = 0, to = null, contours = true } = {}) {
    const nWin = numWindows(audio.length), last = to == null ? nWin : Math.min(to, nWin);
    const nOut = numOutputFrames(audio.length);
    const total = Math.max(0, Math.min(nOut, last * FRAMES_PER_WINDOW) - from * FRAMES_PER_WINDOW);
    const note = new Float32Array(total * N_PITCH), onset = new Float32Array(total * N_PITCH), contour = contours ? new Float32Array(total * N_CONTOUR) : null;
    for (let w = from; w < last; w++) {
      const r = this.runWindow(windowAt(audio, w));
      const k0 = (w - from) * FRAMES_PER_WINDOW, keep = Math.min(FRAMES_PER_WINDOW, total - k0);
      if (keep > 0) {
        note.set(r.note.subarray(HALF_OVERLAP * N_PITCH, (HALF_OVERLAP + keep) * N_PITCH), k0 * N_PITCH);
        onset.set(r.onset.subarray(HALF_OVERLAP * N_PITCH, (HALF_OVERLAP + keep) * N_PITCH), k0 * N_PITCH);
        if (contour) contour.set(r.contour.subarray(HALF_OVERLAP * N_CONTOUR, (HALF_OVERLAP + keep) * N_CONTOUR), k0 * N_CONTOUR);
      }
      onWindow?.(w - from + 1, last - from);
    }
    return { nFrames: total, note, onset, contour };
  }
}

// ------------------------------------------------------------------ note decoding (toMidi.ts)
const hzToMidi = hz => 12 * (Math.log2(hz) - Math.log2(440.0)) + 69;

function inferredOnsets(onsets, frames, nF, nDiff = 2) {
  const P = N_PITCH, diff = new Float32Array(nF * P);
  for (let r = 0; r < nF; r++) for (let c = 0; c < P; c++) {
    let m = Infinity;
    for (let n = 1; n <= nDiff; n++) { const prev = r - n >= 0 ? frames[(r - n) * P + c] : 0; const d = frames[r * P + c] - prev; if (d < m) m = d; }
    diff[r * P + c] = r < nDiff ? 0 : Math.max(0, m);
  }
  let oMax = 0, dMax = 0;
  for (let i = 0; i < onsets.length; i++) { if (onsets[i] > oMax) oMax = onsets[i]; if (diff[i] > dMax) dMax = diff[i]; }
  const out = new Float32Array(nF * P);
  for (let i = 0; i < out.length; i++) { const d = dMax > 0 ? (oMax * diff[i]) / dMax : 0; out[i] = Math.max(onsets[i], d); }
  return out;
}

/**
 * Posteriorgrams → note events {startFrame, durationFrames, pitchMidi, amplitude}. Same defaults/semantics as
 * basic-pitch-ts outputToNotesPoly (inputs are not modified).
 */
export function outputToNotesPoly(framesIn, onsetsIn, nF, {
  onsetThresh = 0.5, frameThresh = 0.3, minNoteLen = 5, inferOnsets = true,
  maxFreq = null, minFreq = null, melodiaTrick = true, energyTolerance = 11,
} = {}) {
  const P = N_PITCH;
  const frames = Float32Array.from(framesIn), onsetsC = Float32Array.from(onsetsIn);
  if (maxFreq) { const k = Math.trunc(hzToMidi(maxFreq) - MIDI_OFFSET); for (let r = 0; r < nF; r++) for (let c = Math.max(0, k); c < P; c++) { frames[r * P + c] = 0; onsetsC[r * P + c] = 0; } }
  if (minFreq) { const k = Math.trunc(hzToMidi(minFreq) - MIDI_OFFSET); for (let r = 0; r < nF; r++) for (let c = 0; c < Math.min(P, k); c++) { frames[r * P + c] = 0; onsetsC[r * P + c] = 0; } }
  const onsets = inferOnsets ? inferredOnsets(onsetsC, frames, nF) : onsetsC;
  // peaks along time (argrelmax, order 1, clipped edges) above the onset threshold, processed last → first
  const starts = [];
  for (let r = 0; r < nF; r++) for (let c = 0; c < P; c++) {
    const v = onsets[r * P + c];
    if (!(v > onsetThresh)) continue;
    if (r > 0 && !(v > onsets[(r - 1) * P + c])) continue;
    if (r < nF - 1 && !(v > onsets[(r + 1) * P + c])) continue;
    starts.push(r * P + c);
  }
  starts.reverse();
  const energy = Float32Array.from(frames);
  const notes = [];
  const meanAmp = (a, b, c) => { let s = 0; for (let j = a; j < b; j++) s += frames[j * P + c]; return s / (b - a); };
  for (const idx of starts) {
    const s = Math.floor(idx / P), c = idx % P;
    if (s >= nF - 1) continue;
    let i = s + 1, k = 0;
    while (i < nF - 1 && k < energyTolerance) { if (energy[i * P + c] < frameThresh) k++; else k = 0; i++; }
    i -= k;
    if (i - s <= minNoteLen) continue;
    for (let j = s; j < i; j++) { energy[j * P + c] = 0; if (c < P - 1) energy[j * P + c + 1] = 0; if (c > 0) energy[j * P + c - 1] = 0; }
    notes.push({ startFrame: s, durationFrames: i - s, pitchMidi: c + MIDI_OFFSET, amplitude: meanAmp(s, i, c) });
  }
  if (melodiaTrick) {
    // repeatedly take the global maximum of the remaining energy; energies only ever drop to 0, so visiting the
    // cells in descending order of their (unchanged) value and skipping zeroed ones is equivalent and O(n log n).
    const cand = [];
    for (let i = 0; i < energy.length; i++) if (energy[i] > frameThresh) cand.push(i);
    cand.sort((a, b) => energy[b] - energy[a] || (Math.floor(a / P) - Math.floor(b / P)) || (b % P) - (a % P));
    const orig = Float32Array.from(energy);
    for (const idx of cand) {
      if (energy[idx] !== orig[idx] || energy[idx] <= frameThresh) continue;
      const iMid = Math.floor(idx / P), c = idx % P;
      energy[idx] = 0;
      let i = iMid + 1, k = 0;
      while (i < nF - 1 && k < energyTolerance) {
        if (energy[i * P + c] < frameThresh) k++; else k = 0;
        energy[i * P + c] = 0; if (c < P - 1) energy[i * P + c + 1] = 0; if (c > 0) energy[i * P + c - 1] = 0;
        i++;
      }
      const iEnd = i - 1 - k;
      i = iMid - 1; k = 0;
      while (i > 0 && k < energyTolerance) {
        if (energy[i * P + c] < frameThresh) k++; else k = 0;
        energy[i * P + c] = 0; if (c < P - 1) energy[i * P + c + 1] = 0; if (c > 0) energy[i * P + c - 1] = 0;
        i--;
      }
      const iStart = i + 1 + k;
      if (iEnd - iStart <= minNoteLen) continue;
      notes.push({ startFrame: iStart, durationFrames: iEnd - iStart, pitchMidi: c + MIDI_OFFSET, amplitude: meanAmp(iStart, iEnd, c) });
    }
  }
  return notes;
}

/** Note events → seconds. exact=false reproduces basic-pitch-ts noteFramesToTime. */
export function notesToTime(notes, { exact = true } = {}) {
  const f = exact ? frameTime : modelFrameToTime;
  return notes.map(n => ({ pitchMidi: n.pitchMidi, amplitude: n.amplitude, startTimeSeconds: f(n.startFrame), durationSeconds: f(n.startFrame + n.durationFrames) - f(n.startFrame), startFrame: n.startFrame, durationFrames: n.durationFrames }));
}
