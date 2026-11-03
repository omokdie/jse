#!/usr/bin/env node
// Checks that the lyric stage never changes the recognised music: runs
// recognize() with and without lyrics on every image of a corpus and
// compares the scores with lyrics stripped (ids ignored). Also counts the
// syllables the stage adds (pages without Korean text should get none).
//
//   node tools/omr/lyric_regression.mjs [--dir tools/omr/corpus/base] [--limit n]
import fs from 'node:fs';
import path from 'node:path';
import { recognize } from '../../app/js/omr/omr.js';
import { decodePNG } from './png.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dir = opt('--dir', 'tools/omr/corpus/base');
const limit = +opt('--limit', '0');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().slice(0, limit || undefined);
const strip = (score) => JSON.stringify(score.measures.map(m => m.staves.map(s => s.voices.map(v => v.map(e => ({ k: e.kind, d: e.dur, n: (e.notes || []).map(n => [n.step, n.octave, n.alter, !!n.tieStart, !!n.tieEnd]) }))))));
let same = 0, added = 0, tOff = 0, tOn = 0;
for (const f of files) {
  const img = decodePNG(fs.readFileSync(path.join(dir, f)));
  let t = Date.now();
  const off = await recognize(img, { lyrics: false }); tOff += Date.now() - t; t = Date.now();
  const on = await recognize(img, {}); tOn += Date.now() - t;
  const eq = strip(off.score) === strip(on.score);
  if (eq) same++;
  added += on.lyrics.length;
  if (!eq || on.lyrics.length) console.log(f, eq ? 'music identical' : 'MUSIC DIFFERS', 'syllables added:', on.lyrics.length, on.lyrics.slice(0, 12).map(l => l.text).join(' '));
}
console.log(`${same}/${files.length} pages with identical music; ${added} syllables added; mean time ${Math.round(tOff / files.length)} ms → ${Math.round(tOn / files.length)} ms with lyrics`);
