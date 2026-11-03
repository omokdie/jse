// JSE OMR — stage trace for diagnostics (tools/omr/stage_eval.mjs).
// Converts the pipeline's internal state (working coordinates) into original
// image coordinates so each stage can be scored against ground truth.
// Only used when recognize() is called with options.trace.

const r1 = (v) => Math.round(v * 10) / 10;

export function buildTrace(ctx, staves, prims, cls) {
  const { sp, w } = ctx;
  const P = (x, y) => ctx.toOrig(x, y).map(r1);
  const xi = (x) => Math.max(0, Math.min(w - 1, Math.round(x)));
  const step = Math.max(1, Math.round(2 * sp));
  const stavesOut = staves.map(st => {
    const lines = [];
    for (let k = 0; k < 5; k++) {
      const pts = [];
      for (let x = st.x0; x <= st.x1; x += step) pts.push(P(x, st.lines[k][x]));
      pts.push(P(st.x1, st.lines[k][st.x1]));
      lines.push(pts);
    }
    return { lines, systemIndex: st.systemIndex, clef: st.clef, clefMissing: !!st.clefMissing, keyFifths: st.keyFifths, keyConf: st.keyConf || 0,
      timeSig: st.timeSig || null, clefConf: st.clefConf ?? null, clefCands: st.clefCands || null, headerEnd: P(st.headerEnd ?? st.x0, st.lines[2][xi(st.headerEnd ?? st.x0)]) };
  });
  const barlines = [];
  for (const sys of cls.systems || []) {
    if (!sys) continue;
    const top = sys.staves[0], bot = sys.staves[sys.staves.length - 1];
    for (const g of sys.barlines || []) barlines.push({ type: g.type, p0: P(g.x, top.lines[0][xi(g.x)]), p1: P(g.x, bot.lines[4][xi(g.x)]), systemIndex: top.systemIndex });
  }
  const heads = [];
  const seen = new Set();
  for (const ev of cls.events || []) {
    if (ev.kind !== 'note') continue;
    for (const hd of ev.heads) { seen.add(hd); heads.push({ c: P(hd.cx, hd.cy), hollow: !!hd.hollow, used: true, pos: hd.pos, acc: hd.accidental || null, base: ev.base }); }
  }
  for (const hd of prims.heads || []) if (!seen.has(hd)) heads.push({ c: P(hd.cx, hd.cy), hollow: !!hd.hollow, used: false, drop: hd._drop || 'later', cls: hd.cls });
  const events = (cls.events || []).map(ev => {
    const b = ev.bbox;
    return { kind: ev.kind, base: ev.base, dots: ev.dots, staff: ev.staff ? ev.staff.index : -1, c: P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), nb: ev.nb ?? null,
      stemDir: ev.stem ? ev.stem.dir : null };
  });
  const stems = (prims.stems || []).map(s => ({ p0: P(s.x, s.y0), p1: P(s.x, s.y1), barline: !!s.isBarline, heads: s.heads ? s.heads.length : 0 }));
  return { staves: stavesOut, barlines, heads, events, stems, sp: ctx.sp / ctx.scale, scale: ctx.scale, angle: ctx.angle, extra: ctx.traceExtra || null };
}
