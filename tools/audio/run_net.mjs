#!/usr/bin/env node
// Runs Basic Pitch over every rendered corpus item once and caches the posteriorgrams, so post-processing can be
// tuned without the network:  nice -n 10 node tools/audio/run_net.mjs tools/audio/corpus [--only dev,holdout]
// <id>.post = Uint32 nFrames | Uint16 note[nFrames·88] | Uint16 onset[nFrames·88]   (values ×65535)
import fs from 'node:fs';
import path from 'node:path';
import { loadGraph, convBackend } from '../../app/js/audio/tfgraph.js';
import { BasicPitch, N_PITCH } from '../../app/js/audio/basicpitch.js';
import { wavToMono22050 } from '../../app/js/audio/decode.js';

const dir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'corpus');
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const model = path.join(path.dirname(new URL(import.meta.url).pathname), '../../app/vendor/basic-pitch');
const bp = new BasicPitch(loadGraph(JSON.parse(fs.readFileSync(path.join(model, 'model.json'), 'utf8')), fs.readFileSync(path.join(model, 'group1-shard1of1.bin'))));
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
let n = 0, secs = 0, ms = 0;
for (const e of idx) {
  if (only && !only.has(e.split)) continue;
  const wav = path.join(dir, e.id + '.wav'), out = path.join(dir, e.id + '.post');
  if (!fs.existsSync(wav) || fs.existsSync(out)) continue;
  const audio = wavToMono22050(fs.readFileSync(wav));
  const t0 = performance.now();
  const post = bp.evaluate(audio, { contours: false });
  const dt = performance.now() - t0;
  const buf = Buffer.alloc(4 + post.nFrames * N_PITCH * 4);
  buf.writeUInt32LE(post.nFrames, 0);
  const q = new Uint16Array(buf.buffer, buf.byteOffset + 4, post.nFrames * N_PITCH * 2);
  for (let i = 0; i < post.note.length; i++) { q[i] = Math.round(post.note[i] * 65535); q[post.note.length + i] = Math.round(post.onset[i] * 65535); }
  fs.writeFileSync(out, buf);
  n++; secs += audio.length / 22050; ms += dt;
  console.log(`${e.id} ${(audio.length / 22050).toFixed(1)}s audio → ${(dt / 1000).toFixed(1)}s (${convBackend()})`);
}
console.log(`done ${n} items, ${secs.toFixed(0)} s audio in ${(ms / 1000).toFixed(0)} s → ${(ms / 1000 / Math.max(1, secs) * 60).toFixed(1)} s per minute of audio`);
