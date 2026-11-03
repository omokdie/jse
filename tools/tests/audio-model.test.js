// Basic Pitch in pure JS (app/js/audio/tfgraph.js + basicpitch.js) against the reference outputs of
// spotify/basic-pitch-ts (compact fixtures written by tools/audio/make_fixtures.mjs from its test_data).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadGraph, setConvBackend, convBackend } from '../../app/js/audio/tfgraph.js';
import { BasicPitch, outputToNotesPoly, notesToTime, WINDOW_SAMPLES, FRAMES_PER_WINDOW, frameTime, modelFrameToTime, numWindows, windowAt } from '../../app/js/audio/basicpitch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelDir = path.join(here, '../../app/vendor/basic-pitch');
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'basicpitch-fixtures.json'), 'utf8'));
const unz = (b64, T) => { const b = zlib.gunzipSync(Buffer.from(b64, 'base64')); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const graph = loadGraph(JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8')), fs.readFileSync(path.join(modelDir, 'group1-shard1of1.bin')));

function checkWindow(bp) {
  const pcm = unz(fx.vocal.audioInt16, Int16Array);
  assert.equal(pcm.length, WINDOW_SAMPLES);
  const out = bp.runWindow(Float32Array.from(pcm, v => v / 32768));
  const rows = unz(fx.vocal.rows, Uint16Array), L = fx.vocal.rowLen;
  let worst = 0;
  for (let r = 0; r < rows.length / L; r++) {
    const i = rows[r * L] + 15;     // unwrapped row i ↔ window frame i + 15
    const ref = k => rows[r * L + 1 + k] / 65535;
    for (let c = 0; c < 88; c++) { worst = Math.max(worst, Math.abs(out.note[i * 88 + c] - ref(c)), Math.abs(out.onset[i * 88 + c] - ref(88 + c))); }
    for (let c = 0; c < 264; c++) worst = Math.max(worst, Math.abs(out.contour[i * 264 + c] - ref(176 + c)));
  }
  return worst;
}

test('graph interpreter reproduces the reference posteriorgrams (vocal-da-80bpm window, all three heads)', () => {
  const bp = new BasicPitch(graph);
  const worst = checkWindow(bp);
  // reference test tolerance is 5e-3 (the fixture audio is the int16 WAV, the reference ran on float audio)
  assert.ok(worst < 5e-3, `max abs diff ${worst}`);
});

test('plain-JS and WebAssembly conv kernels agree', () => {
  const was = convBackend();
  try {
    setConvBackend('js');
    const a = checkWindow(new BasicPitch(graph));
    setConvBackend('wasm');
    const b = checkWindow(new BasicPitch(graph));
    assert.ok(a < 5e-3 && b < 5e-3, `${a} ${b}`);
  } finally { setConvBackend(was); }
});

test('windowing matches basic-pitch-ts (3840 leading zeros, 36164-sample hop, padded end)', () => {
  assert.equal(numWindows(264821), 8);                 // vocal-da-80bpm: 8 windows
  const x = Float32Array.from({ length: 50000 }, (_, i) => i + 1);
  const w0 = windowAt(x, 0), w1 = windowAt(x, 1);
  assert.equal(w0[3839], 0); assert.equal(w0[3840], 1);
  assert.equal(w1[0], 36164 - 3840 + 1);
  const end = 50000 - (36164 - 3840);                 // window 1 runs past the signal → zero padded
  assert.equal(w1[end - 1], 50000); assert.equal(w1[end], 0);
  assert.equal(numWindows(50000), 2);
  assert.ok(Math.abs(modelFrameToTime(1) - 0.0116) < 1e-4);
  assert.equal(frameTime(FRAMES_PER_WINDOW), 36164 / 22050);
});

test('note decoding reproduces poly.json / poly.nomelodia.json (C major scale)', () => {
  const c = fx.cmajor, n = c.nFrames * 88;
  const note = Float32Array.from(unz(c.note8, Uint8Array), v => v / 255);
  const idx = unz(c.onsetCells, Uint16Array), ov = unz(c.onset16, Uint16Array), onset = new Float32Array(n);
  let p = -1; for (let i = 0; i < idx.length; i++) { p += idx[i]; onset[p] = ov[i] / 65535; }
  for (const [ref, opts] of [[c.poly, { onsetThresh: 0.25, frameThresh: 0.25, minNoteLen: 5 }], [c.polyNoMelodia, { onsetThresh: 0.5, frameThresh: 0.3, minNoteLen: 5, melodiaTrick: false }]]) {
    const got = notesToTime(outputToNotesPoly(note, onset, c.nFrames, opts), { exact: false });
    assert.equal(got.length, ref.length);
    got.forEach((g, i) => {
      assert.equal(g.pitchMidi, ref[i].p, `note ${i} pitch`);
      // different MP3 decoders → ≤ 2 frames (23 ms) of timing difference
      assert.ok(Math.abs(g.startTimeSeconds - ref[i].t) < 0.025, `note ${i} onset ${g.startTimeSeconds} vs ${ref[i].t}`);
      assert.ok(Math.abs(g.durationSeconds - ref[i].d) < 0.03, `note ${i} duration`);
      assert.ok(Math.abs(g.amplitude - ref[i].a) < 0.02, `note ${i} amplitude`);
    });
  }
});
