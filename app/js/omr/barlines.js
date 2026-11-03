// JSE OMR — barline detection for (rectified) working images.
//
// A barline is a straight vertical stroke that covers every staff of the
// system from the top line to the bottom line (and usually the gaps between
// the staves of a grand staff), ends at the outer lines, and has clean
// flanks: nothing is attached to it.  A stem that happens to span a staff has
// a note head or a beam touching it at one end, or continues beyond the
// staff.  Evidence is measured on the line-free binary with a 3-column
// tolerance, so slightly blurred or slightly tilted barlines survive.
//
// detectBarlinesV2(ctx, sys, prims, nolines) sets sys.barlines = groups
// [{ x, x0, x1, type: single|double|final|repeat-start|repeat-end|repeat-both,
//    members: [{x, x0, x1, y0, y1, width}] }] like omr.js detectBarlines, and
// marks coinciding stems with isBarline.
import { clamp } from './imgutil.js';
import { inkLevels } from './heads.js';

const rnd = Math.round;

// learned verification (models/bars.js, tools/omr/train_rhythm.py --kind bars): a grey patch of the
// candidate on each staff (2.4 sp wide, staff ± 1.5 sp) + the rule measurements below
export const BW = 16, BH = 35, N_BFEAT = BW * BH + 10;
export function barFeatures(ctx, st, xc, g, out = new Float32Array(N_BFEAT)) {
  const { gray, w, h, sp } = ctx;
  const lv = inkLevels(ctx);
  const xi = clamp(rnd(xc), 0, w - 1);
  const top = st.lines[0][xi], bot = st.lines[4][xi];
  const y0 = top - 1.5 * sp, ch = (bot - top + 3 * sp) / BH, cw = 2.4 * sp / BW, x0 = xc - 1.2 * sp;
  const scale = 1 / Math.max(20, lv.paper - lv.ink);
  for (let gy = 0; gy < BH; gy++) for (let gx = 0; gx < BW; gx++) {
    let v = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const x = rnd(x0 + (gx + 0.25 + 0.5 * sx) * cw), y = rnd(y0 + (gy + 0.25 + 0.5 * sy) * ch);
      v += x < 0 || y < 0 || x >= w || y >= h ? 0 : (lv.paper - gray[y * w + x]) * scale;
    }
    out[gy * BW + gx] = clamp(v / 4, -0.2, 1.3);
  }
  const k = BW * BH;
  out[k] = g.width / sp; out[k + 1] = g.cov; out[k + 2] = g.eUp; out[k + 3] = g.eDn; out[k + 4] = g.attached;
  out[k + 5] = g.head ? 1 : 0; out[k + 6] = g.nStaves; out[k + 7] = clamp((st.x1 - xc) / sp, -2, 10) / 10;
  out[k + 8] = clamp((xc - (st.headerEnd != null ? st.headerEnd : st.x0)) / sp, -2, 10) / 10; out[k + 9] = g.wide ? 1 : 0;
  return out;
}
const barBuf = new Float32Array(N_BFEAT);

export function detectBarlinesV2(ctx, sys, prims, nolines, predictFn = null) {
  const { w, h, sp, t } = ctx;
  const model = ctx.models && ctx.models.bars && predictFn ? ctx.models.bars : null;
  const learned = !!(model || ctx.barCollect);
  const candMin = learned ? (ctx.barCandMin ?? 0.75) : 0.9;   // the verifier also sees weaker candidates
  const st0 = sys.staves[0], stN = sys.staves[sys.staves.length - 1];
  const xa = Math.max(1, rnd(Math.min(...sys.staves.map(s => s.x0)) - 0.5 * sp));
  const xb = Math.min(w - 2, rnd(Math.max(...sys.staves.map(s => s.x1)) + 0.5 * sp));
  const ink = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && nolines[y * w + x]) ? 1 : 0;
  const ink3 = (x, y) => ink(x - 1, y) | ink(x, y) | ink(x + 1, y);
  // staff-line rows are erased in `nolines`; a barline pixel there may be lost
  // too, so rows within ±(t/2+1) of a line count as covered when either
  // neighbouring row is covered.
  const lineRow = (st, x, y) => { for (let k = 0; k < 5; k++) if (Math.abs(y - st.lines[k][x]) <= t / 2 + 1) return true; return false; };
  const coverage = (x, ya, yb, st) => {
    let c = 0, n = 0;
    for (let y = ya; y <= yb; y++) {
      n++;
      if (ink3(x, y) || (st && lineRow(st, x, y) && (ink3(x, y - 2) || ink3(x, y + 2)))) c++;
    }
    return n ? c / n : 0;
  };
  // --- 1. column evidence ---------------------------------------------------------
  // cand: every staff covered ≥ 90 %; dense: ≥ 60 % (part of a vertical stroke)
  const cand = new Uint8Array(w), dense = new Uint8Array(w), covAt = new Float32Array(w);
  for (let x = xa; x <= xb; x++) {
    let mn = 1;
    for (const st of sys.staves) {
      const y0 = rnd(st.lines[0][x]), y1 = rnd(st.lines[4][x]);
      mn = Math.min(mn, coverage(x, y0, y1, st));
      if (mn < 0.6) break;
    }
    covAt[x] = mn;
    cand[x] = mn >= candMin ? 1 : 0;
    dense[x] = mn >= 0.6 ? 1 : 0;
  }
  // --- 2. runs of candidate columns → bars ---------------------------------------
  const bars = [];
  for (let x = xa; x <= xb; x++) {
    if (!cand[x]) continue;
    let x2 = x; while (x2 + 1 <= xb && cand[x2 + 1]) x2++;
    bars.push({ x0: x, x1: x2 });
    x = x2;
  }
  const out = [];
  for (const b of bars) {
    // the 3-column tolerance widens every bar by ~2 px; measure the real ink width at mid-staff rows
    let wsum = 0, wn = 0;
    for (const st of sys.staves) for (const k of [0.5, 1.5, 2.5, 3.5]) {
      const xm = rnd((b.x0 + b.x1) / 2), y = rnd(st.lines[0][xm] + k * (st.lines[4][xm] - st.lines[0][xm]) / 4);
      let a = xm, c = xm;
      if (!ink(xm, y)) continue;
      while (a > b.x0 - 3 && ink(a - 1, y)) a--;
      while (c < b.x1 + 3 && ink(c + 1, y)) c++;
      wsum += c - a + 1; wn++;
    }
    const width = wn ? wsum / wn : b.x1 - b.x0 - 1;
    const x = (b.x0 + b.x1) / 2, xi = clamp(rnd(x), 0, w - 1);
    const why = (r) => { if (ctx.barDebug) ctx.barDebug.push({ x, sys: st0.systemIndex, r }); };
    let cov = 0; for (let xx = b.x0; xx <= b.x1; xx++) cov = Math.max(cov, covAt[xx]);
    if (learned) {
      // measurements for the verifier (no early rejection)
      const top = st0.lines[0][xi], bot = stN.lines[4][xi];
      const ext = (y0, dir) => { let c = 0; for (let k = rnd(0.45 * sp); k <= rnd(1.6 * sp); k++) { const y = rnd(y0 + dir * k); for (let xx = b.x0; xx <= b.x1; xx++) if (ink(xx, y)) { c++; break; } } return c / (rnd(1.6 * sp) - rnd(0.45 * sp) + 1); };
      const flank = (yc, side) => {
        let c = 0, n = 0;
        const xs = side < 0 ? b.x0 - 1 : b.x1 + 1;
        for (let d = 1; d <= rnd(0.5 * sp); d++) {
          const xx = xs + side * d;
          if (xx >= 0 && xx < w && (dense[xx] || (xx > 0 && dense[xx - 1]) || (xx < w - 1 && dense[xx + 1]))) continue;
          for (let dy = -0.55 * sp; dy <= 0.55 * sp; dy += 1) { n++; if (ink(xx, rnd(yc + dy))) c++; }
        }
        return n ? c / n : 0;
      };
      let attached = 0;
      for (const st of sys.staves) { const ya = st.lines[0][xi] + 0.35 * sp, yb = st.lines[4][xi] - 0.35 * sp; for (const yc of [ya, yb]) for (const side of [-1, 1]) attached = Math.max(attached, flank(yc, side)); }
      const head = !!(prims.heads && prims.heads.some(hd => Math.abs(hd.cx - x) > 0.3 * sp && Math.abs(hd.cx - x) < 0.75 * sp && (hd.x1 < b.x0 || hd.x0 > b.x1) && (Math.abs(hd.cy - top) < 0.8 * sp || Math.abs(hd.cy - bot) < 0.8 * sp)));
      const g = { width, cov, eUp: ext(top, -1), eDn: ext(bot, 1), attached, head, nStaves: sys.staves.length, wide: width > 1.1 * sp };
      const feats = sys.staves.map(st => Float32Array.from(barFeatures(ctx, st, x, g, barBuf)));
      if (ctx.barCollect) ctx.barCollect.push({ x, sys, feats, g });
      let accept;
      // (a stem right next to a barline shares its patch: a note head attached at an end still vetoes)
      // a note head 0.3–0.85 sp beside the stroke (anywhere in the system) makes it a stem: engraved
      // music keeps heads ≥ 1 sp away from barlines (a down-stem right after a barline was read as a
      // second barline stroke → false double / final barline and a lost note)
      const headBeside = !!(prims.heads && prims.heads.some(hd => sys.staves.includes(hd.staff) && Math.abs(hd.cx - x) >= 0.3 * sp && Math.abs(hd.cx - x) <= 0.85 * sp && hd.cy > top - 1.0 * sp && hd.cy < bot + 1.0 * sp));
      if (model) { let p = 1; for (const f of feats) p = Math.min(p, predictFn(model, f)[1]); accept = p >= 0.5 && !head && !headBeside && attached <= 0.6 && g.eUp <= 0.6 && g.eDn <= 0.6; }
      else accept = cov >= 0.9 && !g.wide && g.eUp <= 0.6 && g.eDn <= 0.6 && attached <= 0.45 && !head;   // = the rules below
      // the weaker-candidate runs are wider than the stroke: keep the measured ink width around the
      // centre, or stems right next to the barline would be marked as barlines too
      const xc = Math.round(x), hw = Math.max(0, Math.round((width - 1) / 2));
      if (accept) out.push({ x, x0: Math.max(b.x0, xc - hw), x1: Math.min(b.x1, xc + hw), y0: top, y1: bot, width });
      continue;
    }
    if (width > 1.1 * sp) { why('wide'); continue; }                         // a wide block (clef, cluster, text)
    const top = st0.lines[0][xi], bot = stN.lines[4][xi];
    // --- 3. ends: must not continue beyond the outer lines (stems do) ---------
    const ext = (y0, dir) => { let c = 0; for (let k = rnd(0.45 * sp); k <= rnd(1.6 * sp); k++) { const y = rnd(y0 + dir * k); for (let xx = b.x0; xx <= b.x1; xx++) if (ink(xx, y)) { c++; break; } } return c / (rnd(1.6 * sp) - rnd(0.45 * sp) + 1); };
    const eUp = ext(top, -1), eDn = ext(bot, 1);
    if (eUp > 0.6 || eDn > 0.6) { why(`ext ${eUp.toFixed(2)}/${eDn.toFixed(2)}`); continue; }
    // --- 4. flanks: ink touching the bar near its ends = head / beam / flag -----
    // (columns of other bar candidates — the second stroke of a double /
    // final / repeat barline — do not count as attached ink)
    const flank = (yc, side) => {
      let c = 0, n = 0;
      const xs = side < 0 ? b.x0 - 1 : b.x1 + 1;
      for (let d = 1; d <= rnd(0.5 * sp); d++) {
        const xx = xs + side * d;
        if (xx >= 0 && xx < w && (dense[xx] || (xx > 0 && dense[xx - 1]) || (xx < w - 1 && dense[xx + 1]))) continue;
        for (let dy = -0.55 * sp; dy <= 0.55 * sp; dy += 1) { n++; if (ink(xx, rnd(yc + dy))) c++; }
      }
      return n ? c / n : 0;
    };
    let attached = 0;
    for (const st of sys.staves) {
      const ya = st.lines[0][xi] + 0.35 * sp, yb = st.lines[4][xi] - 0.35 * sp;
      for (const yc of [ya, yb]) for (const side of [-1, 1]) attached = Math.max(attached, flank(yc, side));
    }
    // heads and beams fill ≥ ~0.5 of the window; ties / slurs / accidentals much less
    if (attached > 0.45) { why(`att ${attached.toFixed(2)}`); continue; }
    // a detected note head right at an end of the bar → stem
    // a detected head beside an end (not on the bar itself: thick bars are often split into fake heads)
    if (prims.heads && prims.heads.some(hd => Math.abs(hd.cx - x) > 0.3 * sp && Math.abs(hd.cx - x) < 0.75 * sp && (hd.x1 < b.x0 || hd.x0 > b.x1) && (Math.abs(hd.cy - top) < 0.8 * sp || Math.abs(hd.cy - bot) < 0.8 * sp))) { why('head'); continue; }
    out.push({ x, x0: b.x0 + 1, x1: b.x1 - 1, y0: top, y1: bot, width });
  }
  // --- 5. groups: double / final / repeat ---------------------------------------------
  out.sort((a, b) => a.x - b.x);
  const groups = [];
  for (const c of out) {
    const g = groups[groups.length - 1];
    if (g && c.x0 - g.x1 < 1.0 * sp) { g.members.push(c); g.x1 = Math.max(g.x1, c.x1); } else groups.push({ members: [c], x0: c.x0, x1: c.x1 });
  }
  const thin = Math.max(2, 0.22 * sp);
  for (const g of groups) {
    g.x = (g.x0 + g.x1) / 2;
    const thick = g.members.some(m => m.width >= Math.max(thin + 1.5, 0.33 * sp));
    g.type = g.members.length === 1 ? (thick ? 'final' : 'single') : thick ? 'final' : 'double';
    const xi = clamp(rnd(g.x), 0, w - 1);
    // repeat dots: blobs in spaces 2 and 3 next to the group, in every staff
    const dots = (side) => {
      let n = 0;
      for (const st of sys.staves) {
        const l0 = st.lines[0][xi], half = (st.lines[4][xi] - l0) / 8;
        for (const p of [3, 5]) {
          const yy = rnd(l0 + p * half);
          for (let dx = rnd(0.4 * sp); dx <= rnd(1.6 * sp); dx++) {
            const xx = side < 0 ? g.x0 - dx : g.x1 + dx;
            if (ink(xx, yy) && ink(xx, yy - 1) && ink(xx, yy + 1) && !ink(xx, yy - rnd(0.6 * sp)) && !ink(xx, yy + rnd(0.6 * sp))) { n++; break; }
          }
        }
      }
      return n >= 2 * sys.staves.length;
    };
    if (thick || g.members.length > 1) {
      const dl = dots(-1), dr = dots(1);
      if (dl && dr) g.type = 'repeat-both'; else if (dl) g.type = 'repeat-end'; else if (dr) g.type = 'repeat-start';
    }
    for (const m of g.members) m.isBarline = true;
  }
  // stems / vertical objects that coincide with a barline — of THIS system only (an object is
  // inside the system's vertical span): stems of other systems at the same x are not barlines
  const inSystem = (o) => {
    const xi = clamp(rnd(o.x), 0, w - 1);
    return o.y0 >= st0.lines[0][xi] - 1.0 * sp && o.y1 <= stN.lines[4][xi] + 1.0 * sp;
  };
  for (const s of prims.stems || []) {
    if (!s.staff || !sys.staves.includes(s.staff)) continue;
    if (s.y1 - s.y0 > 2.5 * sp && inSystem(s) && groups.some(g => s.x >= g.x0 - 2 && s.x <= g.x1 + 2)) s.isBarline = true;
  }
  for (const o of prims.vobjs || []) if (o.y1 - o.y0 > 3 * sp && inSystem(o) && groups.some(g => o.x >= g.x0 - 2 && o.x <= g.x1 + 2)) o.isBarline = true;
  sys.barlines = groups;
  return groups;
}
