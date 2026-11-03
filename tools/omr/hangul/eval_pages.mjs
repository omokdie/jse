#!/usr/bin/env node
// Page-level lyric evaluation of one or more Hangul models on a corpus written by
// gen_lyrics_corpus.py (+ augment.py). The music is recognised once per page; the
// lyric stage then runs once per model on that same result (lyrics.js
// `onLyricStage` hook + hangul.js `setModel`), so the models are compared on
// identical notes.
//
//   node tools/omr/hangul/eval_pages.mjs --dir tools/omr/corpus_ko \
//        --models v1=/tmp/old/hangul-weights.js,v2=app/js/omr/hangul-weights.js [--report out.md] [--limit n] [--filter s]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { recognize } from '../../../app/js/omr/omr.js';
import { recognizeLyrics } from '../../../app/js/omr/lyrics.js';
import { setModel } from '../../../app/js/omr/hangul.js';
import { decodePNG } from '../png.mjs';
import { lyricMetrics } from '../lyric_eval.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(opt('--dir', 'tools/omr/corpus_ko'));
const limit = +opt('--limit', '0');
const filter = opt('--filter', '');
const report = opt('--report', null);
const models = [];
for (const item of opt('--models', 'current=app/js/omr/hangul-weights.js').split(',')) {
  const [name, p] = item.includes('=') ? item.split('=') : [path.basename(item), item];
  models.push({ name, model: (await import(pathToFileURL(path.resolve(p)).href)).HANGUL_MODEL });
}

let sharp = null;
try { sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp'); } catch { try { sharp = createRequire(import.meta.url)('sharp'); } catch { /* png only */ } }
async function loadImage(f) {
  if (f.toLowerCase().endsWith('.png')) return decodePNG(fs.readFileSync(f));
  if (!sharp) throw new Error('sharp not available for ' + f);
  const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}
const cases = [];
for (const g of fs.readdirSync(dir).sort()) {
  const gd = path.join(dir, g);
  if (!fs.statSync(gd).isDirectory()) continue;
  for (const f of fs.readdirSync(gd).sort()) if (/\.(png|jpe?g)$/i.test(f) && f.includes(filter)) cases.push({ group: g, file: path.join(gd, f) });
}
const todo = limit ? cases.slice(0, limit) : cases;

const acc = {};   // model -> group -> sums
const add = (mn, g, m, ms) => { const a = ((acc[mn] ||= {})[g] ||= { pages: 0, ms: 0 }); a.pages++; a.ms += ms; for (const [k, v] of Object.entries(m)) a[k] = (a[k] || 0) + v; };
for (const c of todo) {
  const img = await loadImage(c.file);
  const gt = JSON.parse(fs.readFileSync(c.file.replace(/\.(png|jpe?g)$/i, '.json'), 'utf8'));
  let stage = null;
  await recognize(img, { lyrics: false, onLyricStage: (s) => { stage = s; } });
  if (!stage) continue;
  const line = [];
  for (const { name, model } of models) {
    setModel(model);
    const score = structuredClone(stage.score);
    const t0 = Date.now();
    const r = recognizeLyrics({ ...stage, score });
    const ms = Date.now() - t0;
    const m = lyricMetrics(gt, { score, lyrics: r.lyrics });
    add(name, c.group, m, ms);
    add(name, 'ALL', m, ms);
    line.push(`${name} read ${m.boxTextOk}/${m.boxMatched} ${ms}ms`);
  }
  setModel(null);
  console.log(path.basename(c.file).padEnd(52), line.join('  |  '));
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
const charAcc = (e, n) => (n ? (100 * (1 - e / n)).toFixed(1) + '%' : '-');
const head = ['model', 'group', 'pages', 'GT syllables', 'detected', 'read correctly', 'lyric char acc', 'char acc in score', 'on right note', 'text on right note', 'errors flagged', 'lyric stage'];
const rows = [];
for (const { name } of models) for (const [g, a] of Object.entries(acc[name] || {})) {
  rows.push([name, g, a.pages, a.gtSyl, pct(a.boxMatched, a.gtSyl), pct(a.boxTextOk, a.boxMatched), charAcc(a.lineEdits, a.lineChars), charAcc(a.charEdits, a.chars),
    pct(a.assignOk, a.assignTotal), pct(a.assignTextOk, a.assignTotal), pct(a.lowConfWrong, a.wrong), Math.round(a.ms / a.pages) + ' ms']);
}
const md = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
console.log('\n' + md);
if (report) fs.writeFileSync(report, `# Lyric evaluation — ${path.relative(process.cwd(), dir)}\n\nDate: ${new Date().toISOString()}\n\n${md}\n\nSame music recognition for every model (one recognize() per page); metrics as in tools/omr/lyric_eval.mjs.\n`);
