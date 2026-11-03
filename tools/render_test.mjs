// Renders sample scores to SVG + PNG for visual inspection.
// usage: node tools/render_test.mjs [outdir]
import fs from 'node:fs';
import path from 'node:path';
import { createScore, makeNote, makeRest, newId, createPart, createMeasure } from '../app/js/model/score.js';
import { engrave } from '../app/js/engrave/render.js';
import { sampleScore, drumTabScore } from './fixtures.mjs';

const out = process.argv[2] || '/home/claude/scoresnap/tools/out';
fs.mkdirSync(out, { recursive: true });

const scores = { sample: sampleScore(), drumtab: drumTabScore() };
for (const [name, score] of Object.entries(scores)) {
  const t0 = Date.now();
  const res = engrave(score);
  console.log(name, 'pages', res.pages.length, 'ms', Date.now() - t0);
  res.pages.forEach((p, i) => fs.writeFileSync(path.join(out, `${name}-p${i + 1}.svg`), p.svg));
  fs.writeFileSync(path.join(out, `${name}-geometry.json`), JSON.stringify(res.pages[0].geometry.events.slice(0, 5), null, 1));
}
