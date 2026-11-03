// JSE OMR — staff detection robust to perspective / page curl (photos).
//
// The original detector projects the thin-line mask of vertical bands onto
// the y axis, which only works where staves are horizontal after the global
// deskew.  In a photo the staves at the top and bottom of the page can differ
// by several degrees (perspective) and bend (curl).  Here every band is
// projected along several sheared directions (±7.5°), 5-line groups are
// clustered across bands with a slope-aware prediction, the best angle per
// staff wins, and each staff is then followed column by column (comb tracking
// with a slowly adapting spacing) so curvature is captured.
import { clamp, thinMask } from './imgutil.js';

const rnd = Math.round;

function linesInBand(thin, w, h, x0, x1, t, tg, frac = 0.36) {
  const proj = new Float32Array(h);
  const xc = (x0 + x1) / 2;
  for (let x = x0; x < x1; x++) {
    const dy = rnd((x - xc) * tg);
    for (let y = Math.max(0, -dy), ye = Math.min(h, h - dy); y < ye; y++) proj[y] += thin[(y + dy) * w + x];
  }
  const bw = x1 - x0, thr = frac * bw;
  const lines = [];
  let y = 0;
  while (y < h) {
    if (proj[y] < thr) { y++; continue; }
    let y2 = y, sw = 0, sy = 0;
    while (y2 < h && proj[y2] >= thr) { sw += proj[y2]; sy += proj[y2] * y2; y2++; }
    if (y2 - y <= 3 * t + 3) lines.push({ y: sy / sw, th: y2 - y });
    y = y2;
  }
  return lines;
}

function groupStaves(lines, sp) {
  const out = [];
  let i = 0;
  while (i + 4 < lines.length) {
    const ys = lines.slice(i, i + 5).map(l => l.y);
    const gaps = [1, 2, 3, 4].map(k => ys[k] - ys[k - 1]);
    const m = (ys[4] - ys[0]) / 4;
    const ok = m > 0.6 * sp && m < 1.6 * sp && gaps.every(g => g > 0.72 * m && g < 1.28 * m);
    if (ok) { out.push({ ys, spacing: m }); i += 5; } else i++;
  }
  return out;
}

/** Comb tracking (see omr.js trackStaff): the five lines move together, the
 * median deviation shifts the comb, the outer lines adapt the spacing slowly. */
function trackStaff(bin, w, h, t, startX, ys0, sp, slope) {
  const lines = ys0.map(() => new Float32Array(w));
  const hits = new Uint8Array(w);
  const thinMax = 2 * t + 2, r = Math.max(2, rnd(0.3 * sp));
  const measure = (x, py) => {
    const yc = rnd(py);
    for (let d = 0; d <= r; d++) for (let s = d ? -1 : 1; s <= 1; s += 2) {
      const y = yc + s * d;
      if (y < 0 || y >= h || !bin[y * w + x]) continue;
      let a = y, b = y;
      while (a > 0 && bin[(a - 1) * w + x]) a--;
      while (b < h - 1 && bin[(b + 1) * w + x]) b++;
      if (b - a + 1 <= thinMax) return (a + b) / 2;
      return null;
    }
    return null;
  };
  const run = (dir) => {
    let y0 = ys0[0], gap = (ys0[4] - ys0[0]) / 4, drift = slope;   // drift: expected dy per column
    let miss = 0;
    for (let x = startX; x >= 0 && x < w; x += dir) {
      if (x !== startX) y0 += drift * dir;
      const devs = [];
      let m0 = null, m4 = null;
      for (let i = 0; i < 5; i++) {
        const py = y0 + i * gap, m = measure(x, py);
        if (m != null) { devs.push(m - py); if (i === 0) m0 = m; if (i === 4) m4 = m; }
      }
      if (devs.length >= 2) {
        devs.sort((a, b) => a - b);
        const off = devs[devs.length >> 1];
        if (Math.abs(off) < 0.3 * sp) { y0 += off * 0.5; drift += 0.02 * (off * dir - 0) ; }
        if (m0 != null && m4 != null) { const g = (m4 - m0) / 4; if (Math.abs(g - gap) < 0.15 * sp) gap += 0.03 * (g - gap); }
        miss = 0;
      } else if (++miss > 6 * sp) drift *= 0.98;                      // long gap: relax towards horizontal drift memory
      drift = clamp(drift, -0.2, 0.2);
      hits[x] = devs.length;
      for (let i = 0; i < 5; i++) lines[i][x] = y0 + i * gap;
    }
  };
  run(1); run(-1);
  const win = Math.max(3, rnd(3 * sp));
  const sm = new Float32Array(w);
  let s = 0;
  for (let x = 0; x < w; x++) { s += hits[x]; if (x >= win) s -= hits[x - win]; sm[x] = s / Math.min(win, x + 1); }
  let bestL = -1, bestR = -1, curL = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && sm[Math.min(w - 1, x + (win >> 1))] >= 2.0;
    if (on && curL < 0) curL = x;
    if (!on && curL >= 0) {
      // bridge short dropouts (a dense chord cluster or a shadow edge)
      if (bestL >= 0 && curL - bestR < 4 * sp) { bestR = x; curL = -1; continue; }
      if (bestL < 0 || x - curL > bestR - bestL) { bestL = curL; bestR = x; }
      curL = -1;
    }
  }
  if (bestL < 0) return null;
  let x0 = bestL, x1 = bestR - 1;
  while (x0 < x1 && hits[x0] < 2) x0++;
  while (x1 > x0 && hits[x1] < 2) x1--;
  return { lines, hits, x0, x1 };
}

function leftConnector(bin, w, h, a, b, sp) {
  const xl = Math.max(0, rnd(Math.min(a.x0, b.x0) - 1.6 * sp)), xr = Math.min(w - 1, rnd(Math.max(a.x0, b.x0) + 1.6 * sp));
  let best = 0;
  for (let x = xl; x <= xr; x++) {
    const y0 = rnd(a.lines[4][x] + 2), y1 = rnd(b.lines[0][x] - 2);
    if (y1 - y0 < 2) return true;
    let c = 0;
    for (let y = y0; y <= y1; y++) if (bin[y * w + x] || (x > 0 && bin[y * w + x - 1]) || (x < w - 1 && bin[y * w + x + 1])) c++;
    best = Math.max(best, c / (y1 - y0 + 1));
    if (best >= 0.85) return true;
  }
  return false;
}

export function detectStavesV2(ctx, options = {}) {
  const { w, h, t, sp } = ctx;
  const bin = ctx.staffBin || ctx.bin;
  const thin = thinMask(bin, w, h, 2 * t + 1);
  ctx.thin = thin;
  const nb = clamp(Math.floor(w / (6 * sp)), 4, 48), bw = w / nb;
  const deg = Math.PI / 180;
  const angles = options.staffAngles || [0, -2.5, 2.5, -5, 5, -7.5, 7.5];
  const cands = [];
  for (const a of angles) {
    const tg = Math.tan(a * deg);
    const clusters = [];
    for (let b = 0; b < nb; b++) {
      const x0 = rnd(b * bw), x1 = rnd((b + 1) * bw), xc = (x0 + x1) / 2;
      // dense beams / chords cover most of a band's staff lines (the thin mask drops lines inside
      // thick ink): a second, more permissive projection threshold finds those bands' 5-line groups
      const groups = groupStaves(linesInBand(thin, w, h, x0, x1, t, tg), sp);
      for (const g of groups) g.strict = true;
      if (options.permissiveLines !== false) for (const c of groupStaves(linesInBand(thin, w, h, x0, x1, t, tg, 0.22), sp)) if (!groups.some(g => Math.abs(g.ys[0] - c.ys[0]) < 0.5 * sp)) groups.push(c);
      for (const c of groups) {
        const top = c.ys[0], bot = c.ys[4];
        let best = null, bd = 0.6 * sp;
        for (const cl of clusters) {
          const last = cl.members[cl.members.length - 1];
          if (b - last.b > 4) continue;
          const dx = xc - last.xc;
          const d = Math.max(Math.abs(last.top + dx * tg - top), Math.abs(last.bot + dx * tg - bot));
          if (d < bd) { bd = d; best = cl; }
        }
        const mem = { b, xc, top, bot, ys: c.ys, strict: !!c.strict };
        if (best) best.members.push(mem); else clusters.push({ members: [mem], angle: a, tg });
      }
    }
    for (const cl of clusters) cands.push(cl);
  }
  const minMembers = Math.max(2, Math.ceil(nb * 0.15));
  // clearly visible bands count double: a group shifted by one line (a permissive band taking a beam
  // or text edge for a staff line) must not outvote the true staff in the duplicate check below
  for (const cl of cands) cl.score = cl.members.reduce((a, m) => a + (m.strict ? 2 : 1), 0);
  cands.sort((p, q) => q.score - p.score);
  const accepted = [];
  for (const cl of cands) {
    if (cl.members.length < minMembers) continue;
    // a staff needs some bands with clearly visible lines (permissive bands alone: text, textures)
    const nStrict = cl.members.filter(m => m.strict).length;
    if (nStrict < Math.min(2, Math.ceil(0.1 * cl.members.length))) continue;
    const mid = cl.members[cl.members.length >> 1];
    const dup = accepted.some(o => {
      const om = o.members[o.members.length >> 1];
      const pred = om.top + (mid.xc - om.xc) * o.tg;
      return Math.abs(pred - mid.top) < 2.2 * sp;
    });
    if (!dup) accepted.push(cl);
  }
  const staves = [];
  for (const cl of accepted) {
    // tracking starts from a clearly visible band near the middle of the cluster
    const strictM = cl.members.filter(m => m.strict);
    const mid = strictM.length ? strictM[strictM.length >> 1] : cl.members[cl.members.length >> 1];
    // slope from the cluster members (least squares of top vs xc), fallback: sweep angle
    let slope = cl.tg;
    if (cl.members.length >= 3) {
      const n = cl.members.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const m of cl.members) { sx += m.xc; sy += m.top; sxx += m.xc * m.xc; sxy += m.xc * m.top; }
      const den = n * sxx - sx * sx;
      if (den > 1e-6) slope = clamp((n * sxy - sx * sy) / den, -0.2, 0.2);
    }
    const tr = trackStaff(bin, w, h, t, clamp(rnd(mid.xc), 0, w - 1), mid.ys, sp, slope);
    if (!tr || tr.x1 - tr.x0 < 6 * sp) continue;
    const xc = (tr.x0 + tr.x1) >> 1;
    const spacing = (tr.lines[4][xc] - tr.lines[0][xc]) / 4;
    const st = { lines: tr.lines, hits: tr.hits, x0: tr.x0, x1: tr.x1, spacing, top: tr.lines[0][xc], bottom: tr.lines[4][xc] };
    if (staves.some(o => {
      const x = clamp(xc, Math.max(o.x0, st.x0), Math.min(o.x1, st.x1));
      return Math.abs(o.lines[0][x] - st.lines[0][x]) < 0.7 * sp && Math.abs(o.lines[4][x] - st.lines[4][x]) < 0.7 * sp;
    })) continue;
    staves.push(st);
  }
  // order top → bottom by the position at the page centre column
  const xm = rnd(w / 2);
  const yAt = (st) => st.lines[0][clamp(xm, st.x0, st.x1)];
  staves.sort((a, b) => yAt(a) - yAt(b));
  // systems: consecutive staves joined by a connector at the left edge
  const sysOf = new Array(staves.length).fill(0);
  let sys = 0;
  for (let i = 1; i < staves.length; i++) {
    const a = staves[i - 1], b = staves[i];
    const x = clamp(rnd((Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2), 0, w - 1);
    let joined;
    if (options.parts === 1) joined = false;
    else if (options.parts === 2 || options.assumeGrandStaff) joined = (sysOf[i - 1] === sys && sysOf.filter(v => v === sys).length % 2 === 1);
    else joined = b.lines[0][x] - a.lines[4][x] < 14 * sp && Math.abs(a.x0 - b.x0) < 3 * sp && leftConnector(bin, w, h, a, b, sp);
    if (!joined) sys++;
    sysOf[i] = sys;
  }
  staves.forEach((s, i) => { s.systemIndex = sysOf[i]; s.index = i; });
  return staves;
}
