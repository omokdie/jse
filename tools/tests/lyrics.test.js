// Lyric stage of the OMR (app/js/omr/lyrics.js) on a synthetic page with two
// verses of Korean lyrics (tools/tests/fixtures/lyrics-page.*, written by
// `python3 tools/omr/gen_lyrics_corpus.py --fixture tools/tests/fixtures/lyrics-page.png`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognize } from '../../app/js/omr/omr.js';
import { decodePNG } from '../omr/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const img = decodePNG(fs.readFileSync(path.join(here, 'fixtures', 'lyrics-page.png')));
const gt = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'lyrics-page.json'), 'utf8'));
const gtSyl = [];
for (const m of gt.measures) for (const e of m.staves[0]) for (const l of e.lyrics || []) gtSyl.push(l);
const iou = (a, b) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x1 <= x0 || y1 <= y0) return 0; const i = (x1 - x0) * (y1 - y0); return i / (a[2] * a[3] + b[2] * b[3] - i);
};

let res;
test('reads both verses and stores one syllable per note', async () => {
  res = await recognize(img, {});
  assert.ok(Array.isArray(res.lyrics) && Array.isArray(res.lyricLines));
  // recognition: GT syllable boxes matched by result boxes with the same text
  let ok = 0;
  for (const g of gtSyl) { const d = res.lyrics.find(l => l.verse === g.verse && iou(l.bbox, g.bbox) > 0.3); if (d && d.text === g.text) ok++; }
  assert.ok(ok >= 0.9 * gtSyl.length, `read ${ok}/${gtSyl.length}`);
  assert.deepEqual([...new Set(res.lyrics.map(l => l.verse))].sort(), [1, 2], 'verse numbers "1." "2." → verses 1 and 2');
  assert.ok(!res.lyrics.some(l => /^[0-9]/.test(l.text)), 'verse numbers are not syllables');
  // score format: like the editor's Korean input
  let n = 0;
  for (const m of res.score.measures) for (const e of m.staves[0].voices[0]) for (const l of e.lyrics || []) {
    n++;
    assert.equal(l.syllabic, 'single');
    assert.ok([1, 2].includes(l.verse));
    assert.ok(/^[가-힣][,.!?~]*$/.test(l.text), `one syllable per note: ${l.text}`);
    assert.ok(e.kind === 'note');
  }
  assert.ok(n >= 0.85 * gtSyl.length, `${n} lyrics stored`);
  // every result entry has a source box and a confidence; assigned ones point at score events
  for (const l of res.lyrics) {
    assert.equal(l.bbox.length, 4);
    assert.ok(l.confidence >= 0 && l.confidence <= 1);
    assert.equal(typeof l.lowConfidence, 'boolean');
  }
});

test('lyrics can be switched off and absent text changes nothing', async () => {
  const off = await recognize(img, { lyrics: false });
  assert.equal(off.lyrics.length, 0);
  let n = 0; for (const m of off.score.measures) for (const sm of m.staves) for (const v of sm.voices) for (const e of v) if (e.lyrics) n++;
  assert.equal(n, 0);
  // blank out the lyric band: no lyrics, same notes
  const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (const g of gt.measures.flatMap(m => m.staves[0]).flatMap(e => e.lyrics || [])) {
    const [x, y, w, h] = g.bbox.map(Math.round);
    for (let yy = y - 2; yy < y + h + 2; yy++) for (let xx = x - 2; xx < x + w + 2; xx++) { const o = (yy * img.width + xx) * 4; copy.data[o] = copy.data[o + 1] = copy.data[o + 2] = 255; }
  }
  // also the verse numbers left of the first syllables
  for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < 230; xx++) if (yy > 140 && yy < 210) { const o = (yy * img.width + xx) * 4; copy.data[o] = copy.data[o + 1] = copy.data[o + 2] = 255; }
  const blank = await recognize(copy, {});
  assert.equal(blank.lyrics.length, 0, blank.lyrics.map(l => l.text).join(' '));
});
