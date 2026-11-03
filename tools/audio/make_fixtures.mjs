// Builds the compact Basic Pitch fixtures for tools/tests/audio-model.test.js from a basic-pitch-ts checkout:
//   git clone --depth 1 https://github.com/spotify/basic-pitch-ts /tmp/bpts
//   node tools/audio/make_fixtures.mjs /tmp/bpts
// (1) one 43844-sample model window of test_data/vocal-da-80bpm.22050.wav (int16, exact model input) + every 8th
//     reference output row of vocal-da-80bpm.json for that window (the 17 MB JSON itself is not committed);
// (2) the network posteriorgrams for test_data/C_major.resampled.mp3 (decoded with ffmpeg, 1680 samples of decoder
//     delay re-added so that frames line up with the reference decoder), sparse (cells near values ≥ 0.2) and uint16-quantised, plus the
//     reference notes poly.json / poly.nomelodia.json (pitch, onset, duration, amplitude).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { loadGraph } from '../../app/js/audio/tfgraph.js';
import { BasicPitch, windowAt, FRAMES_PER_WINDOW } from '../../app/js/audio/basicpitch.js';
import { parseWav } from '../../app/js/audio/decode.js';

const root = process.argv[2] || '/tmp/bpts';
const here = path.dirname(new URL(import.meta.url).pathname);
const model = path.join(here, '../../app/vendor/basic-pitch');
const g = loadGraph(JSON.parse(fs.readFileSync(path.join(model, 'model.json'), 'utf8')), fs.readFileSync(path.join(model, 'group1-shard1of1.bin')));
const bp = new BasicPitch(g);
const gz = buf => zlib.gzipSync(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), { level: 9 }).toString('base64');
const q16 = arr => Uint16Array.from(arr, v => Math.round(Math.min(1, Math.max(0, v)) * 65535));

// (1) vocal window
const W = 2;
const wav = parseWav(fs.readFileSync(path.join(root, 'test_data/vocal-da-80bpm.22050.wav')));
const pcm = wav.channels[0];
const win = windowAt(pcm, W);
const ref = JSON.parse(fs.readFileSync(path.join(root, 'test_data/vocal-da-80bpm.json'), 'utf8'));
const rows = [];
for (let i = 0; i < FRAMES_PER_WINDOW; i += 8) {
  const k = W * FRAMES_PER_WINDOW + i;
  rows.push(i, ...ref.unwrapped_output.note[k], ...ref.unwrapped_output.onset[k], ...ref.unwrapped_output.contour[k]);
}
// rows: [i, note×88, onset×88, contour×264] per sampled frame, uint16-quantised (the frame index is stored as i/65535)
const vocal = { window: W, audioInt16: gz(Int16Array.from(win, v => Math.round(v * 32768))), rowLen: 441, rows: gz(Uint16Array.from(rows.map((v, j) => (j % 441 === 0 ? v : Math.round(Math.min(1, Math.max(0, v)) * 65535))))) };

// (2) C major
const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(root, 'test_data/C_major.resampled.mp3'), '-ac', '1', '-ar', '22050', '-f', 'f32le', '-']);
const dec = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const audio = new Float32Array(dec.length + 1680); audio.set(dec, 1680);
const post = bp.evaluate(audio, { contours: false });
// Onsets: sparse but exact where it matters — every cell within ±3 frames of an onset/note value ≥ 0.2 (decoding
// thresholds are ≥ 0.25, peak picking looks ±1 frame). Notes: dense, 8-bit — onset inference rescales the small
// frame-to-frame differences of the note map by onsetMax/diffMax (≈5×), so even its ~0.1 baseline matters.
const FLOOR = 0.2, P = 88, nF = post.nFrames;
const mask = new Uint8Array(nF * P);
for (let r = 0; r < nF; r++) for (let c = 0; c < P; c++) if (post.note[r * P + c] >= FLOOR || post.onset[r * P + c] >= FLOOR) for (let d = -3; d <= 3; d++) if (r + d >= 0 && r + d < nF) mask[(r + d) * P + c] = 1;
const idx = [], ov = []; let last = -1;
for (let i = 0; i < mask.length; i++) if (mask[i]) { let d = i - last; while (d > 65535) { idx.push(65535); ov.push(0); d -= 65535; } idx.push(d); ov.push(Math.round(post.onset[i] * 65535)); last = i; }
const note8 = Uint8Array.from(post.note, v => Math.round(Math.min(1, Math.max(0, v)) * 255));
const keep = n => ({ p: n.pitchMidi, t: +n.startTimeSeconds.toFixed(4), d: +n.durationSeconds.toFixed(4), a: +n.amplitude.toFixed(4) });
const cmajor = {
  nFrames: post.nFrames, note8: gz(note8), onsetCells: gz(Uint16Array.from(idx)), onset16: gz(Uint16Array.from(ov)),
  poly: JSON.parse(fs.readFileSync(path.join(root, 'test_data/poly.json'), 'utf8')).map(keep),
  polyNoMelodia: JSON.parse(fs.readFileSync(path.join(root, 'test_data/poly.nomelodia.json'), 'utf8')).map(keep),
};
const outFile = path.join(here, '../tests/fixtures/basicpitch-fixtures.json');
fs.writeFileSync(outFile, JSON.stringify({ source: 'spotify/basic-pitch-ts test_data (Apache-2.0)', vocal, cmajor }));
console.log('wrote', outFile, (fs.statSync(outFile).size / 1024).toFixed(1), 'KB; frames', post.nFrames);
