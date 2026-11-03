#!/usr/bin/env node
// Debug: run the OMR stages on one image and write an overlay PNG of the
// working binary with detected primitives (heads, stems, barlines, rests...).
//   node tools/omr/debug_overlay.mjs image.png [out.png] [--crop x,y,w,h]
import fs from 'node:fs';
import { preprocess, detectStaves, removeStaffLines, segmentSymbols, classify } from '../../app/js/omr/omr.js';
import { encodePNG } from './png.mjs';
import { loadImage } from './metrics.mjs';

const [file, outArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const img = await loadImage(file);
const ctx = preprocess(img, {});
const staves = detectStaves(ctx, {});
const nolines = removeStaffLines(ctx, staves);
const prims = segmentSymbols(ctx, staves, nolines);
ctx.cc = prims.cc;
const cls = classify(ctx, staves, nolines, prims, {});
const { w, h } = ctx;
const out = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) { const v = nolines[i] ? 0 : ctx.bin[i] ? 190 : 255; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
const px = (x, y, r, g, b) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; };
const rect = (x0, y0, x1, y1, c) => { for (let x = x0; x <= x1; x++) { px(x, y0, ...c); px(x, y1, ...c); } for (let y = y0; y <= y1; y++) { px(x0, y, ...c); px(x1, y, ...c); } };
for (const st of staves) { for (let i = 0; i < 5; i++) for (let x = st.x0; x <= st.x1; x += 3) px(x, st.lines[i][x], 0, 200, 255); rect(st.x0, st.lines[0][st.x0] - 1, st.headerEnd, st.lines[4][st.x0] + 1, [255, 0, 255]); }
for (const s of prims.stems) rect(s.x0 - 1, s.y0, s.x1 + 1, s.y1, s.isBarline ? [255, 128, 0] : s.heads && s.heads.length ? [0, 160, 0] : [160, 160, 0]);
for (const sys of cls.systems) if (sys) for (const g of sys.barlines || []) for (const m of g.members) rect(m.x0 - 2, m.y0 - 2, m.x1 + 2, m.y1 + 2, [255, 0, 0]);
for (const hd of prims.heads) rect(hd.x0, hd.y0, hd.x1, hd.y1, hd.stem ? [0, 0, 255] : [255, 0, 0]);
for (const ev of cls.events) {
  if (ev.kind === 'rest') rect(ev.comp.x0 - 1, ev.comp.y0 - 1, ev.comp.x1 + 1, ev.comp.y1 + 1, [0, 128, 0]);
  else for (const hd of ev.heads) { if (hd.hollow) rect(hd.x0, hd.y0, hd.x1, hd.y1, [0, 200, 200]); if (hd.accidental) rect(hd.x0 - 12, hd.y0 - 4, hd.x0 - 2, hd.y1 + 4, [200, 0, 200]); }
  if (ev.dots) px(ev.bbox.x1 + 3, (ev.bbox.y0 + ev.bbox.y1) / 2, 255, 0, 0);
}
console.log(`working ${w}x${h} sp=${ctx.sp.toFixed(2)} t=${ctx.t} scale=${ctx.scale.toFixed(3)} staves=${staves.length} stems=${prims.stems.length} heads=${prims.heads.length} events=${cls.events.length}`);
for (const st of staves) console.log(` staff sys${st.systemIndex} top=${st.top.toFixed(1)} x=[${st.x0},${st.x1}] clef=${st.clef} key=${st.keyFifths} ts=${st.timeSig ? st.timeSig.num + '/' + st.timeSig.den : '-'} headerEnd=${st.headerEnd.toFixed(0)}`);
for (const sys of cls.systems) if (sys) console.log(' barlines:', (sys.barlines || []).map(g => `${g.x.toFixed(0)}${g.type[0]}`).join(' '));
const evs = cls.events.slice().sort((a, b) => (a.staff.index - b.staff.index) || (a.x - b.x));
console.log(evs.map(ev => ev.kind === 'rest' ? `R${ev.base}@${ev.x | 0}` : `${ev.base}${ev.dots ? '.' : ''}[${ev.heads.map(h => h.pos + (h.accidental ? h.accidental[0] : '')).join(',')}]${ev.nb ? 'b' + ev.nb : ''}@${ev.x | 0}`).join(' '));
const cropArg = process.argv.find(a => a.startsWith('--crop='));
let final = { width: w, height: h, data: out };
if (cropArg) {
  const [cx, cy, cw, ch] = cropArg.slice(7).split(',').map(Number);
  const S = 3, data = new Uint8ClampedArray(cw * S * ch * S * 4);
  for (let y = 0; y < ch * S; y++) for (let x = 0; x < cw * S; x++) { const sx = cx + (x / S | 0), sy = cy + (y / S | 0); const o = (y * cw * S + x) * 4; if (sx < w && sy < h) { const i = (sy * w + sx) * 4; data[o] = out[i]; data[o + 1] = out[i + 1]; data[o + 2] = out[i + 2]; } data[o + 3] = 255; }
  final = { width: cw * S, height: ch * S, data };
}
fs.writeFileSync(outArg || '/tmp/overlay.png', encodePNG(final));
