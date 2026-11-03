// JSE OMR — learned rhythm: number of beams / flags at a stem's free end.
//
// The rule-based count (omr.js countBars: vertical ink runs next to the stem)
// confuses a blurred or slanted single beam with two, and a curved flag that
// crosses the probe column twice with a 16th flag.  Here a grey patch around
// the free end of the stem (3 × 4.2 staff spaces, the stem's tip always on
// top: down-stems are flipped vertically, flags stay on the right) plus a few
// geometric features are classified by a small MLP (models/rhythm.js, trained
// by tools/omr/train_rhythm.py from detected stems matched to the exact
// durations of generated pages):  0 = none (quarter / half), 1 = 8th,
// 2 = 16th, 3 = 32nd or shorter.
import { clamp } from './imgutil.js';
import { inkLevels } from './heads.js';

export const RW = 20, RH = 28;              // patch cells (0.15 sp each)
export const R_SPAN_X = 3.0, R_SPAN_Y = 4.2, R_OVER = 0.6;   // patch size (sp); R_OVER sp beyond the tip
export const N_RFEAT = RW * RH + 8;
export const RHYTHM_CLASSES = ['none', 'eighth', '16th', '32nd'];

/** Feature vector of a stem (omr.js stem object with x, y0, y1, dir) and its heads. */
export function stemFeatures(ctx, stem, heads, rule, out = new Float32Array(N_RFEAT)) {
  const { gray, w, h, sp } = ctx;
  const lv = inkLevels(ctx);
  const up = stem.dir !== 'down';
  const tip = up ? stem.y0 : stem.y1;
  const scale = 1 / Math.max(20, lv.paper - lv.ink);
  const cw = R_SPAN_X * sp / RW, ch = R_SPAN_Y * sp / RH;
  const x0 = stem.x - R_SPAN_X * sp / 2;
  for (let gy = 0; gy < RH; gy++) {
    // row 0 is R_OVER sp beyond the tip, rows advance towards the note heads
    const d = -R_OVER * sp + (gy + 0.5) * ch;
    for (let gx = 0; gx < RW; gx++) {
      let s = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const x = x0 + (gx + 0.25 + 0.5 * sx) * cw;
        const y = up ? tip + d + (sy - 0.5) * 0.5 * ch : tip - d - (sy - 0.5) * 0.5 * ch;
        const xi = Math.round(x), yi = Math.round(y);
        s += xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : (lv.paper - gray[yi * w + xi]) * scale;
      }
      out[gy * RW + gx] = clamp(s / 4, -0.2, 1.3);
    }
  }
  const k = RW * RH;
  const hy = heads.map(hd => hd.cy);
  const nearest = up ? Math.min(...hy) : Math.max(...hy);
  out[k] = (stem.y1 - stem.y0) / sp;                       // stem length
  out[k + 1] = Math.abs(nearest - tip) / sp;                // free stem length (tip → nearest head)
  out[k + 2] = heads.length;
  out[k + 3] = heads.every(hd => hd.hollow) ? 1 : 0;
  out[k + 4] = up ? 1 : 0;
  out[k + 5] = rule ? rule.L : 0;                           // rule-based counts left / right of the stem
  out[k + 6] = rule ? rule.R : 0;
  out[k + 7] = stem.width != null ? stem.width / sp : 0.15;
  return out;
}

/** Learned beam / flag count of one stem → { n, prob } (null without a model). */
export function learnedBeamCount(ctx, model, predictFn, stem, heads, rule, buf = new Float32Array(N_RFEAT)) {
  if (!model) return null;
  stemFeatures(ctx, stem, heads, rule, buf);
  const p = predictFn(model, buf);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return { n: best, prob: p[best], probs: Array.from(p) };
}
