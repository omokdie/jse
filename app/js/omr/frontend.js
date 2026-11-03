// JSE OMR — front end for photos and scans: preprocessing, staff detection,
// threshold refinement and staff-guided rectification.
//   frontEnd(image, options, progress) → { ctx, staves }
// ctx is the (possibly rectified) working context used by every later stage.
import { preprocessV2, rebinarize, rethreshold } from './preprocess.js';
import { detectStavesV2 } from './staves.js';
import { rectify, assignStripSystems } from './dewarp.js';

export function frontEnd(image, options = {}, progress = () => {}) {
  const ctx = preprocessV2(image, options);
  progress('preprocess', 20, `기울기 보정 ${(ctx.angle * 180 / Math.PI).toFixed(1)}°`);
  let staves = detectStavesV2(ctx, options);
  // nothing found: try the other candidate thresholds
  for (const q of (staves.length ? [] : ctx.qAlternatives || [])) { rethreshold(ctx, q); staves = detectStavesV2(ctx, options); if (staves.length) break; }
  // threshold from the measured staff-line darkness, then find the staves again
  if (staves.length && rebinarize(ctx, staves)) {
    const again = detectStavesV2(ctx, options);
    if (again.length >= staves.length) staves = again;
  }
  if (!staves.length || options.dewarp === false) return { ctx, staves };
  progress('staves', 30, '페이지 왜곡 보정 중…');
  const r = rectify(ctx, staves, options);
  if (!r) return { ctx, staves };
  // (rectified strips: lines are straight and horizontal — the permissive line threshold of the first
  // detection is not needed there and only adds false groups)
  const opts2 = { ...options, staffAngles: [0, -1.5, 1.5], permissiveLines: false };
  let s2 = assignStripSystems(r, detectStavesV2(r, opts2));
  if (s2.length && rebinarize(r, s2)) {
    const again = assignStripSystems(r, detectStavesV2(r, opts2));
    if (again.length >= s2.length) s2 = again;
  }
  // keep the rectified page only if it did not lose staves
  if (s2.length < staves.length) return { ctx, staves };
  return { ctx: r, staves: s2 };
}
