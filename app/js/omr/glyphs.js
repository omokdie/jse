// JSE OMR — learned classification of connected components (rests,
// accidentals, clefs, time-signature digits ...) on the rectified image.
//
// A component's bounding box (+ a small margin) is resampled from the grey
// working image into a fixed GW×GH patch (shape, scale-normalised) and
// complemented with explicit geometry (width / height in staff spaces,
// vertical position relative to the staff, ink density).  The MLP is trained
// by tools/omr/train_glyphs.py from components of synthetic photos labelled by
// symbol-level ground truth.
import { clamp } from './imgutil.js';
import { inkLevels } from './heads.js';

export const GW = 16, GH = 24;
export const GLYPH_CLASSES = ['none', 'sharp', 'flat', 'natural', 'restWhole', 'restHalf', 'restQuarter', 'rest8th', 'rest16th', 'rest32nd',
  'gClef', 'fClef', 'cClef', 'digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9', 'common', 'cut', 'dot'];
export const N_GFEAT = GW * GH + 8;

/** Feature vector of a component box {x0, y0, x1, y1} (working px, inclusive). */
export function glyphFeatures(ctx, comp, staff, out = new Float32Array(N_GFEAT), area = null) {
  const { gray, w, h, sp } = ctx;
  const lv = inkLevels(ctx);
  const bw = comp.x1 - comp.x0 + 1, bh = comp.y1 - comp.y0 + 1;
  // margin: 15 % of the box + 1 px, square-ish aspect is NOT enforced (shape)
  const mx = 0.15 * bw + 1, my = 0.15 * bh + 1;
  const X0 = comp.x0 - mx, Y0 = comp.y0 - my, SX = (bw + 2 * mx) / GW, SY = (bh + 2 * my) / GH;
  const scale = 1 / Math.max(20, lv.paper - lv.ink);
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    // area-average over the source cell (2×2 samples)
    let s = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const x = X0 + (gx + 0.25 + 0.5 * sx) * SX, y = Y0 + (gy + 0.25 + 0.5 * sy) * SY;
      const xi = clamp(Math.round(x), 0, w - 1), yi = clamp(Math.round(y), 0, h - 1);
      s += (x < 0 || y < 0 || x >= w || y >= h) ? 0 : (lv.paper - gray[yi * w + xi]) * scale;
    }
    out[gy * GW + gx] = clamp(s / 4, -0.2, 1.3);
  }
  const k = GW * GH;
  const xm = clamp(Math.round((comp.x0 + comp.x1) / 2), 0, w - 1);
  const top = staff ? staff.lines[0][xm] : (comp.y0 + comp.y1) / 2 - 2 * sp, bot = staff ? staff.lines[4][xm] : top + 4 * sp;
  const half = (bot - top) / 8;
  out[k] = bw / sp; out[k + 1] = bh / sp; out[k + 2] = bw / bh;
  out[k + 3] = ((comp.y0 + comp.y1) / 2 - top) / half / 8;      // centre position (0 = top line, 1 = bottom line)
  out[k + 4] = (comp.y0 - top) / half / 8; out[k + 5] = (comp.y1 - top) / half / 8;
  out[k + 6] = area != null ? area / (bw * bh) : 0.5;
  out[k + 7] = Math.log(Math.max(1, bw * bh) / (sp * sp));
  return out;
}

const TEMPLATE_TO_CLASS = { d0: 'digit0', d1: 'digit1', d2: 'digit2', d3: 'digit3', d4: 'digit4', d5: 'digit5', d6: 'digit6', d7: 'digit7', d8: 'digit8', d9: 'digit9' };

/** Returns hook(comp, names) → { name, score, top } for omr.js bestTemplate():
 * name ∈ names (template names), score = class probability; `top` is the
 * overall most likely class. Results are cached per component. */
export function makeGlyphHook(ctx, staves, model, predictFn, nolines = null) {
  const cache = new Map();
  const feat = new Float32Array(N_GFEAT);
  const idx = new Map(GLYPH_CLASSES.map((c, i) => [c, i]));
  const staffFor = (comp) => {
    let best = null, bd = Infinity;
    const x = Math.max(0, Math.min(ctx.w - 1, Math.round((comp.x0 + comp.x1) / 2)));
    const cy = (comp.y0 + comp.y1) / 2;
    for (const st of staves) { const t = st.lines[0][x], b = st.lines[4][x]; const d = cy < t ? t - cy : cy > b ? cy - b : 0; if (d < bd) { bd = d; best = st; } }
    return best;
  };
  const probsOf = (comp) => {
    const key = `${comp.id}:${comp.x0},${comp.y0},${comp.x1},${comp.y1}`;   // split parts share the id
    let probs = cache.get(key);
    if (!probs) {
      let area = comp.area;
      if (area == null && nolines) {      // a window (not a component): ink inside the box
        area = 0;
        for (let y = Math.max(0, comp.y0); y <= Math.min(ctx.h - 1, comp.y1); y++) for (let x = Math.max(0, comp.x0); x <= Math.min(ctx.w - 1, comp.x1); x++) area += nolines[y * ctx.w + x];
      }
      glyphFeatures(ctx, comp, staffFor(comp), feat, area);
      probs = Float32Array.from(predictFn(model, feat));
      cache.set(key, probs);
    }
    return probs;
  };
  const hook = (comp, names) => {
    const probs = probsOf(comp);
    let best = null;
    for (const n of names) {
      const c = idx.get(TEMPLATE_TO_CLASS[n] || n);
      if (c == null) continue;
      if (!best || probs[c] > best.score) best = { name: n, score: probs[c] };
    }
    let top = 0; for (let i = 1; i < probs.length; i++) if (probs[i] > probs[top]) top = i;
    if (best) { best.top = GLYPH_CLASSES[top]; best.topScore = probs[top]; }
    return best;
  };
  /** class → probability map of a component or window {x0, y0, x1, y1[, id, area]} */
  hook.probs = (comp) => { const p = probsOf(comp); const o = {}; GLYPH_CLASSES.forEach((c, i) => { o[c] = p[i]; }); return o; };
  hook.top = (comp) => { const p = probsOf(comp); let t = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[t]) t = i; return { name: GLYPH_CLASSES[t], score: p[t] }; };
  return hook;
}
