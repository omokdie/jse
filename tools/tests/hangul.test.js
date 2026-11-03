// Hangul recogniser: the JS port (app/js/omr/hangul.js) must reproduce the
// Python training numerics (tools/omr/hangul/core.py + the quantised model)
// on fixtures written by `python3 tools/omr/hangul/train.py --fixtures`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleEmBox, normalizeInk, inkFeatures, logitsOf, readInk, isKsSyllable, modelInfo } from '../../app/js/omr/hangul.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'hangul-fixtures.json'), 'utf8'));
const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

test('em-box sampling and ink normalisation match the Python port', () => {
  const img = { width: fx.image.w, height: fx.image.h, data: bytes(fx.image.data) };
  for (const c of fx.crops) {
    const aff = c.affine ? [c.affine[0][0], c.affine[0][1], c.affine[0][2], c.affine[1][0], c.affine[1][1], c.affine[1][2]] : null;
    const crop = sampleEmBox(img, c.cx, c.cy, c.S, aff);
    const sum = crop.reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(sum - c.sum) < 1e-6 * Math.max(1, Math.abs(c.sum)), `crop sum ${sum} vs ${c.sum}`);
    const ink = normalizeInk(crop), want = bytes(c.ink);
    let diff = 0; for (let i = 0; i < ink.length; i++) diff = Math.max(diff, Math.abs(Math.round(ink[i] * 255) - want[i]));
    assert.equal(diff, 0, 'ink map differs');
  }
});

test('features and logits match the Python model', () => {
  for (const s of fx.samples) {
    const ink = Float64Array.from(bytes(s.ink), v => v / 255);
    const f = inkFeatures(ink);
    s.feat.forEach((v, k) => assert.ok(Math.abs(f[k * s.featStride] - v) < 1e-4, `feature ${k * s.featStride}: ${f[k * s.featStride]} vs ${v}`));
    const lg = logitsOf(f);
    let md = 0; s.logits.forEach((v, k) => { md = Math.max(md, Math.abs(lg[k] - v)); });
    assert.ok(md < 2e-2, `max logit diff ${md}`);
    const r = readInk(ink);
    assert.equal(r.kind === 'noise' ? 'NOISE' : r.text, s.decoded);
  }
});

test('decoder basics', () => {
  assert.ok(isKsSyllable('가') && isKsSyllable('힝') && !isKsSyllable('똠'));
  const info = modelInfo();
  assert.ok(info.types.includes('HANGUL') && info.types.includes('NOISE'));
  // a blank crop must not read as a confident syllable
  const r = readInk(new Float64Array(1024));
  assert.ok(r.kind !== 'hangul' || r.conf < 0.5);
});
