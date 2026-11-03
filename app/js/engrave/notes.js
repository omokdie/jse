// Pass-1 engraving of one staff-measure: noteheads, stems, flags, beams, dots, accidentals,
// ledger lines, rests, articulations, tuplets, grace notes. Produces SVG fragments + geometry.
// Coordinates: x in system units, y staff-local (top line = 0, one staff space = 1).
import { durTicks, measureCapacity } from '../model/score.js';
import { GLYPHS } from './glyphs.js';
import { SP, headWidthFor, accidentalWidth, autoBeamGroups, beamCount, staffPosOf, stemUpGuess } from './layout.js';
import { escapeXml } from './text.js';

export const f3 = n => (Math.round(n * 1000) / 1000).toString();

export class Frag {
  constructor() { this.parts = []; this.minY = 0; this.maxY = 4; this.glyphs = new Set(); }
  add(s) { this.parts.push(s); }
  ext(y0, y1) { if (y0 < this.minY) this.minY = y0; if (y1 > this.maxY) this.maxY = y1; }
  use(name, x, y, scale = 1, cls = '', attrs = '') {
    const g = GLYPHS[name]; if (!g) return;
    this.glyphs.add(name);
    const tr = scale === 1 ? `translate(${f3(x)} ${f3(y)})` : `translate(${f3(x)} ${f3(y)}) scale(${f3(scale)})`;
    this.parts.push(`<use href="#g-${name}" transform="${tr}"${cls ? ` class="${cls}"` : ''}${attrs}/>`);
    this.ext(y + g.b[1] * scale, y + g.b[3] * scale);
    return { x0: x + g.b[0] * scale, y0: y + g.b[1] * scale, x1: x + g.b[2] * scale, y1: y + g.b[3] * scale };
  }
  line(x1, y1, x2, y2, w, cls = '') {
    this.parts.push(`<line x1="${f3(x1)}" y1="${f3(y1)}" x2="${f3(x2)}" y2="${f3(y2)}" stroke-width="${f3(w)}"${cls ? ` class="${cls}"` : ''}/>`);
    this.ext(Math.min(y1, y2) - w / 2, Math.max(y1, y2) + w / 2);
  }
  rect(x, y, w, h, cls = '', attrs = '') {
    this.parts.push(`<rect x="${f3(x)}" y="${f3(y)}" width="${f3(w)}" height="${f3(h)}"${cls ? ` class="${cls}"` : ''}${attrs}/>`);
    this.ext(y, y + h);
  }
  path(d, cls = '', attrs = '') { this.parts.push(`<path d="${d}"${cls ? ` class="${cls}"` : ''}${attrs}/>`); }
  text(x, y, str, { size = 2, anchor = 'start', bold = false, italic = false, cls = '', family = '' } = {}) {
    if (!str) return;
    this.parts.push(`<text x="${f3(x)}" y="${f3(y)}" font-size="${f3(size)}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${bold ? ' font-weight="700"' : ''}${italic ? ' font-style="italic"' : ''}${family ? ` font-family='${family}'` : ''}${cls ? ` class="${cls}"` : ''}>${escapeXml(str)}</text>`);
    this.ext(y - size * 0.95, y + size * 0.3);
  }
  toString() { return this.parts.join(''); }
}

const REST_GLYPH = { breve: 'restDoubleWhole', whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', '128th': 'rest128th' };
const HEAD_GLYPH = {
  normal: null, x: 'noteheadX', 'circle-x': 'noteheadCircleX', diamond: 'noteheadDiamondWhite', 'diamond-black': 'noteheadDiamondBlack',
  triangle: 'noteheadTriangleUpWhite', 'triangle-black': 'noteheadTriangleUpBlack', square: 'noteheadSquareWhite', slash: 'noteheadSlash', plus: 'noteheadPlus',
};
const ACC_GLYPH = { sharp: 'accidentalSharp', flat: 'accidentalFlat', natural: 'accidentalNatural', 'double-sharp': 'accidentalDoubleSharp', 'double-flat': 'accidentalDoubleFlat' };
const ARTIC_GLYPH = { staccato: 'articStaccato', staccatissimo: 'articStaccatissimo', accent: 'articAccent', marcato: 'articMarcato', tenuto: 'articTenuto', 'tenuto-staccato': 'articTenutoStaccato', 'accent-staccato': 'articAccentStaccato', 'marcato-staccato': 'articMarcatoStaccato' };

export function headGlyphName(ev, note, staff) {
  let style = note.head || 'normal';
  if (staff?.type === 'percussion' && note.drum && staff.drumMap?.[note.drum]) style = staff.drumMap[note.drum].head || style;
  if (style !== 'normal' && HEAD_GLYPH[style]) {
    if (style === 'diamond' && (ev.dur.base === 'quarter' || beamCount(ev.dur.base))) return 'noteheadDiamondBlack';
    return HEAD_GLYPH[style];
  }
  const b = ev.dur.base;
  if (b === 'breve') return 'noteheadDoubleWhole';
  if (b === 'whole') return 'noteheadWhole';
  if (b === 'half') return 'noteheadHalf';
  return 'noteheadBlack';
}

/**
 * ctx: { score, m, mi, si, staff, clef, ts, positions, mx, mwidth, prefixEnd, frag, geom, voiceCount, keySig, tabStaff }
 * positions: slotPositions() result; mx: measure x in system coords.
 */
export function renderStaffMeasure(ctx) {
  const { m, si, staff, frag, positions } = ctx;
  const sm = m.staves[si];
  const voices = sm.voices;
  const nonEmpty = voices.filter(v => v.length).length;
  const isTab = staff.type === 'tab';
  const lines = staff.lines || 5;
  const staffBottom = isTab ? (lines - 1) * SP.tabLineGap : lines === 1 ? 2 : lines - 1;
  const capacity = measureCapacity(ctx.ts);
  const posByKey = new Map(positions.map(p => [p.slot.key, p]));
  const slotFor = (tick, graceKey) => posByKey.get(graceKey != null ? graceKey : tick) || nearestSlot(positions, tick);

  // whole-measure rest when voice 0 is empty (and no other voice)
  if (nonEmpty === 0) {
    drawWholeMeasureRest(ctx, staffBottom, lines);
    return;
  }
  voices.forEach((voice, vi) => {
    if (!voice.length) return;
    if (voice.length === 1 && voice[0].kind === 'rest' && (voice[0].fullMeasureRest || (voice[0].dur.base === 'whole' && !voice[0].dur.dots && ctx.ts.num / ctx.ts.den !== 1))) {
      drawWholeMeasureRest(ctx, staffBottom, lines, voice[0], vi, nonEmpty);
      return;
    }
    const forcedDir = nonEmpty > 1 ? (vi % 2 === 0 ? 'up' : 'down') : null;
    const groups = autoBeamGroups(voice, ctx.ts);
    const groupOf = new Map(); groups.forEach((g, gi) => g.forEach(i => groupOf.set(i, gi)));
    const placed = [];  // per event drawing info
    let tick = 0, graceRun = 0;
    voice.forEach((ev, ei) => {
      const isGrace = !!ev.grace;
      let key;
      if (isGrace) { const count = voice[ei - graceRun]?._graceCount || 1; key = tick - (count - graceRun) * 0.01; graceRun++; } else { key = tick; graceRun = 0; }
      const p = slotFor(tick, key);
      const info = placeEvent(ctx, ev, ei, vi, p, forcedDir, groupOf.has(ei), isTab, staffBottom, tick, nonEmpty);
      placed.push(info);
      if (!isGrace) tick += durTicks(ev);
    });
    // beams: decide group stem direction then draw
    groups.forEach(g => {
      const infos = g.map(i => placed[i]).filter(Boolean);
      if (infos.length < 2) { infos.forEach(i => finishUnbeamed(ctx, i)); return; }
      drawBeamGroup(ctx, infos, forcedDir, isTab, staffBottom);
    });
    placed.forEach((info, i) => { if (!groupOf.has(i) || groups[groupOf.get(i)].length < 2) finishUnbeamed(ctx, info); });
    drawTuplets(ctx, placed);
  });
}

function nearestSlot(positions, tick) {
  let best = positions[0];
  for (const p of positions) if (Math.abs(p.tick - tick) < Math.abs(best.tick - tick)) best = p;
  return best;
}

function drawWholeMeasureRest(ctx, staffBottom, lines, ev = null, vi = 0, nonEmpty = 1) {
  const { frag, mx, mwidth, prefixEnd, geom, m, mi, si } = ctx;
  const g = GLYPHS.restWhole;
  const cx = mx + prefixEnd + (mwidth - prefixEnd - SP.measureRightPad - (m.barlineRight === 'repeat-end' ? 1.2 : 0)) / 2;
  const x = cx - g.w / 2;
  let y = lines === 1 ? 2 : lines === 5 ? 2 : (lines - 1) / 2;
  if (ctx.staff.type === 'tab') y = staffBottom / 2;
  if (nonEmpty > 1) y += vi % 2 === 0 ? -1 : 1;
  const id = ev ? ev.id : `mrest-${m.id}-${si}`;
  frag.add(`<g class="ev rest${ev ? '' : ' implicit'}" data-id="${id}" data-mid="${m.id}" data-si="${si}" data-vi="${vi}">`);
  const bb = frag.use('restWhole', x, y);
  frag.add('</g>');
  geom.events.push({ id, mi, si, vi, ei: 0, tick: 0, x: bb.x0, y0: bb.y0 - 0.4, x1: bb.x1, y1: bb.y1 + 0.4, xCenter: cx, heads: [], implicit: !ev, measureId: m.id });
}

/** Places heads/accidentals/dots/ledgers/rest for one event. Returns info used by beams/stems. */
function placeEvent(ctx, ev, ei, vi, p, forcedDir, inBeam, isTab, staffBottom, tick, nonEmpty) {
  const { frag, staff, clef, geom, m, mi, si } = ctx;
  const scale = ev.grace ? 0.65 : 1;
  const x = p.x;
  const info = { ev, ei, vi, x, scale, heads: [], tick, inBeam, isTab, stemDir: null, stemX: 0, topY: 0, bottomY: 0, headW: headWidthFor(ev.dur.base) * scale, bc: beamCount(ev.dur.base), rest: ev.kind === 'rest' };
  const hidden = ev.hidden ? ' hidden' : '';
  frag.add(`<g class="ev ${ev.kind}${ev.grace ? ' grace' : ''}${hidden}" data-id="${ev.id}" data-mid="${m.id}" data-si="${si}" data-vi="${vi}">`);
  if (ev.kind === 'rest') {
    const gname = REST_GLYPH[ev.dur.base] || 'restQuarter';
    let y = staff.lines === 1 ? 2 : isTab ? staffBottom / 2 : 2;
    if (nonEmpty > 1) y += vi % 2 === 0 ? -1 : 1;
    if (ev.dur.base === 'whole' && staff.lines === 5 && nonEmpty > 1 && vi % 2 === 1) y += 0; // keep
    const bb = frag.use(gname, x, y, scale);
    info.topY = bb.y0; info.bottomY = bb.y1; info.xCenter = (bb.x0 + bb.x1) / 2;
    if (ev.dur.dots) drawDots(frag, bb.x1, [y % 1 === 0 ? y - 0.5 : y], ev.dur.dots, scale);
    drawFermata(ctx, ev, info, bb.x0, bb.x1, bb.y0, bb.y1);
    frag.add('</g>');
    geom.events.push({ id: ev.id, mi, si, vi, ei, tick, x: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1, xCenter: info.xCenter, heads: [], measureId: m.id, rest: true });
    info.geo = geom.events[geom.events.length - 1];
    return info;
  }
  // ---- note / chord ----
  const notes = ev.notes;
  const poss = notes.map(n => staffPosOf(n, clef, staff));
  let up;
  if (forcedDir) up = forcedDir === 'up'; else if (ev.stem) up = ev.stem === 'up'; else up = stemUpGuess(ev, poss);
  if (staff.lines === 1) up = ev.stem ? ev.stem === 'up' : true;
  if (isTab) up = false;
  info.stemDir = up ? 1 : -1;
  const headW = info.headW;
  const stemW = SP.stemWidth * scale;
  // head positions (y) and displacement
  const headYs = notes.map((n, i) => isTab ? ((n.string || 1) - 1) * SP.tabLineGap : poss[i] / 2);
  // determine displaced heads relative to final stem direction (seconds)
  const displaced = notes.map(() => false);
  if (!isTab) {
    const order = notes.map((_, i) => i).sort((a, b) => up ? (poss[b] - poss[a]) : (poss[a] - poss[b])); // start from the note the stem touches first: up→lowest first
    for (let k = 1; k < order.length; k++) {
      const i = order[k], j = order[k - 1];
      if (Math.abs(poss[i] - poss[j]) === 1 && !displaced[j]) displaced[i] = true;
    }
  }
  const stemX = up ? x + headW - stemW / 2 : x + stemW / 2;
  info.stemX = stemX;
  const headX = i => displaced[i] ? (up ? x + headW - stemW : x - headW + stemW) : x;
  // ledger lines
  if (!isTab && staff.lines === 5) {
    const minPos = Math.min(...poss), maxPos = Math.max(...poss);
    const lx0 = Math.min(...notes.map((_, i) => headX(i))) - 0.35 * scale, lx1 = Math.max(...notes.map((_, i) => headX(i))) + headW + 0.35 * scale;
    for (let pp = -2; pp >= minPos; pp -= 2) frag.line(lx0, pp / 2, lx1, pp / 2, SP.ledgerLine, 'ledger');
    for (let pp = 10; pp <= maxPos; pp += 2) frag.line(lx0, pp / 2, lx1, pp / 2, SP.ledgerLine, 'ledger');
  }
  // heads
  notes.forEach((n, i) => {
    const hx = headX(i), hy = headYs[i];
    if (isTab) {
      const label = n.fret != null ? String(n.fret) : '?';
      const w = Math.max(1.2, label.length * 0.95);
      frag.rect(hx + headW / 2 - w / 2, hy - 0.8, w, 1.6, 'tab-bg');
      frag.text(hx + headW / 2, hy + 0.6, label, { size: SP.tabFretSize, anchor: 'middle', cls: 'tab-fret' });
      info.heads.push({ x: hx, y: hy, w: headW, noteIndex: i, x0: hx, x1: hx + headW, y0: hy - 0.8, y1: hy + 0.8 });
      return;
    }
    const gname = headGlyphName(ev, n, staff);
    const bb = frag.use(gname, hx, hy, scale, 'nh', ` data-n="${i}"`);
    info.heads.push({ x: hx, y: hy, w: headW, noteIndex: i, x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1, pos: poss[i] });
    if (n.color) frag.parts[frag.parts.length - 1] = frag.parts[frag.parts.length - 1].replace('<use ', `<use fill="${n.color}" `);
  });
  info.topY = Math.min(...headYs); info.bottomY = Math.max(...headYs);
  info.xCenter = x + headW / 2;
  info.leftMost = Math.min(...info.heads.map(h => h.x)); info.rightMost = Math.max(...info.heads.map(h => h.x + h.w));
  // accidentals (zig-zag stacking from the top note)
  if (!isTab) {
    const accs = notes.map((n, i) => n._showAcc ? { i, name: ACC_GLYPH[n._showAcc], y: headYs[i], w: accidentalWidth(n._showAcc) * scale } : null).filter(Boolean).sort((a, b) => a.y - b.y);
    const cols = []; // each col: {xRight, items:[{y0,y1}]}
    for (const a of accs) {
      const g = GLYPHS[a.name]; const ay0 = a.y + g.b[1] * scale, ay1 = a.y + g.b[3] * scale;
      let col = cols.find(c => !c.items.some(it => !(ay1 < it.y0 - 0.1 || ay0 > it.y1 + 0.1)));
      if (!col) { col = { items: [], w: 0 }; cols.push(col); }
      col.items.push({ y0: ay0, y1: ay1, a }); col.w = Math.max(col.w, a.w);
    }
    let right = info.leftMost - SP.accGap * scale;
    for (const col of cols) {
      const ax = right - col.w;
      for (const it of col.items) frag.use(it.a.name, ax, it.a.y, scale, 'acc');
      right = ax - SP.accPad;
    }
    info.accLeft = right;
  }
  // arpeggio
  if (ev.arpeggio && !isTab) {
    const ax = (info.accLeft != null ? info.accLeft : info.leftMost) - 1.1;
    const y0 = info.topY - 0.5, y1 = info.bottomY + 0.5;
    const segs = Math.max(2, Math.round((y1 - y0) / 1.0));
    let d = `M${f3(ax)} ${f3(y0)}`;
    for (let k = 0; k < segs; k++) { const yy = y0 + (k + 0.5) * (y1 - y0) / segs; d += ` Q${f3(ax + (k % 2 ? -0.45 : 0.45))} ${f3(yy)} ${f3(ax)} ${f3(y0 + (k + 1) * (y1 - y0) / segs)}`; }
    frag.path(d, 'arpeggio', ' fill="none" stroke-width="0.18"');
  }
  // dots
  if (ev.dur.dots) {
    const dx = info.rightMost;
    const rows = [...new Set(poss.map(pp => (pp % 2 === 0 ? pp - 1 : pp)))].map(pp => pp / 2);
    drawDots(frag, dx, isTab ? [staffBottom + 1] : rows, ev.dur.dots, scale);
  }
  frag.add('</g>');
  geom.events.push({ id: ev.id, mi, si, vi, ei, tick, x: info.leftMost, x1: info.rightMost, y0: info.topY - 0.5, y1: info.bottomY + 0.5, xCenter: info.xCenter, heads: info.heads, measureId: m.id, stemUp: up });
  info.geo = geom.events[geom.events.length - 1];
  return info;
}

function drawDots(frag, xRight, rows, count, scale) {
  for (const y of rows) for (let k = 0; k < count; k++) {
    const cx = xRight + SP.dotGap * scale + k * (SP.dotRadius * 2 + 0.35) * scale + SP.dotRadius * scale;
    frag.parts.push(`<circle cx="${f3(cx)}" cy="${f3(y)}" r="${f3(SP.dotRadius * scale)}" class="dot"/>`);
  }
}

/** Stem + flag for an unbeamed note; articulations; fermata; tremolo. */
function finishUnbeamed(ctx, info) {
  if (!info || info.rest) return;
  const { frag } = ctx;
  const { ev, scale } = info;
  const up = info.stemDir > 0;
  const hasStem = info.isTab ? (ev.dur.base !== 'whole' && ev.dur.base !== 'breve') : (ev.dur.base !== 'whole' && ev.dur.base !== 'breve');
  if (hasStem) {
    const flags = info.bc;
    let len = (SP.stemLen + (flags > 1 ? (flags - 1) * 0.6 : 0)) * scale;
    if (ev.grace) len = 2.6 * scale;
    let tipY;
    if (info.isTab) {
      const sb = (ctx.staff.lines - 1) * SP.tabLineGap;
      const base = sb + 0.6; tipY = base + 2.6; info.stemBaseY = base; info.stemX = info.x + info.headW / 2; info.stemDir = -1;
      stemLine(ctx, info, base, tipY);
    } else if (up) {
      tipY = info.topY - len;
      if (!ev.grace && info.topY > 6.5) tipY = Math.min(tipY, 2);   // reach the middle line
      stemLine(ctx, info, info.bottomY, tipY);
    } else {
      tipY = info.bottomY + len;
      if (!ev.grace && info.bottomY < -2.5) tipY = Math.max(tipY, 2);
      stemLine(ctx, info, info.topY, tipY);
    }
    info.tipY = tipY;
    if (flags > 0 && !info.inBeam) {
      const name = ['flag8th', 'flag16th', 'flag32nd', 'flag64th', 'flag128th'][Math.min(flags, 5) - 1] + (info.stemDir > 0 ? 'Up' : 'Down');
      frag.use(name, info.stemX - SP.stemWidth * scale / 2, tipY, scale, 'flag');
    }
    if (ev.grace?.slash !== false && ev.grace) {
      // slash through the stem
      const sy = up ? tipY + 1.0 : tipY - 1.0;
      frag.line(info.stemX - 0.6, sy + (up ? 0.5 : -0.5), info.stemX + 0.6, sy - (up ? 0.5 : -0.5), 0.12, 'grace-slash');
    }
    if (ev.tremolo && !info.isTab) drawTremolo(ctx, info, tipY);
  } else {
    info.tipY = up ? info.topY : info.bottomY;
  }
  drawArticulations(ctx, info);
  drawFermata(ctx, ev, info, info.leftMost, info.rightMost, Math.min(info.topY, info.tipY ?? info.topY), Math.max(info.bottomY, info.tipY ?? info.bottomY));
}

function stemLine(ctx, info, fromY, toY) {
  const w = SP.stemWidth * info.scale;
  ctx.frag.add(`<g class="stem-g" data-id="${info.ev.id}">`);
  ctx.frag.line(info.stemX, fromY, info.stemX, toY, w, 'stem');
  ctx.frag.add('</g>');
  if (info.geo) { info.geo.y0 = Math.min(info.geo.y0, toY); info.geo.y1 = Math.max(info.geo.y1, toY); }
}

function drawTremolo(ctx, info, tipY) {
  const n = Math.min(3, info.ev.tremolo);
  const up = info.stemDir > 0;
  const span = n * 0.7;
  let yc = up ? (tipY + info.topY) / 2 : (tipY + info.bottomY) / 2;
  if (info.ev.dur.base === 'whole') yc = up ? info.topY - 2 : info.bottomY + 2;
  for (let k = 0; k < n; k++) {
    const y = yc - span / 2 + k * 0.7 + 0.35;
    const x = info.stemX;
    ctx.frag.path(`M${f3(x - 0.8)} ${f3(y + 0.25)} L${f3(x + 0.8)} ${f3(y - 0.25)} L${f3(x + 0.8)} ${f3(y + 0.2)} L${f3(x - 0.8)} ${f3(y + 0.7)} Z`, 'tremolo');
  }
}

function drawArticulations(ctx, info) {
  const { ev, scale } = info; if (!ev.articulations?.length || info.isTab) return;
  const { frag } = ctx;
  const up = info.stemDir > 0;
  // articulations go on the notehead side opposite the stem
  let below = up;
  let y = below ? info.bottomY + 0.9 : info.topY - 0.9;
  const cx = info.xCenter;
  const order = [...ev.articulations].sort((a, b) => (a.includes('staccato') || a === 'tenuto' ? 0 : 1) - (b.includes('staccato') || b === 'tenuto' ? 0 : 1));
  for (const art of order) {
    const name = ARTIC_GLYPH[art]; if (!name) continue;
    const near = art === 'staccato' || art === 'tenuto' || art === 'staccatissimo' || art === 'tenuto-staccato';
    let yy = y;
    if (near) {
      // keep inside a space when within the staff
      if (yy > -0.5 && yy < 4.5 && Math.abs(yy * 2 - Math.round(yy * 2)) < 0.01 && Math.round(yy * 2) % 2 === 0) yy += below ? 0.5 : -0.5;
    } else {
      yy = below ? Math.max(yy, 5.3) : Math.min(yy, -1.3);
      if (art === 'marcato' && !ev.stem) { yy = Math.min(info.topY - 1.2, -1.3); below = false; }
    }
    const g = GLYPHS[name];
    const flip = below && (art === 'marcato' || art === 'staccatissimo' || art === 'marcato-staccato');
    if (flip) {
      frag.glyphs.add(name);
      frag.parts.push(`<use href="#g-${name}" transform="translate(${f3(cx)} ${f3(yy)}) scale(${f3(scale)} ${f3(-scale)})" class="artic"/>`);
      frag.ext(yy - g.b[3] * scale, yy - g.b[1] * scale);
    } else frag.use(name, cx, yy, scale, 'artic');
    y = below ? yy + (g.b[3] - g.b[1]) * scale + 0.7 : yy - (g.b[3] - g.b[1]) * scale - 0.7;
  }
  info.articY = y;
}

function drawFermata(ctx, ev, info, x0, x1, top, bottom) {
  if (!ev.fermata) return;
  const cx = (x0 + x1) / 2;
  if (ev.fermata === 'below') ctx.frag.use('fermataBelow', cx, Math.max(bottom + 0.8, 5.2), 1, 'fermata');
  else ctx.frag.use('fermataAbove', cx, Math.min(top - 0.8, -1.2), 1, 'fermata');
}

/** Beam group: compute slope line, draw stems to beam, primary + secondary beams. */
function drawBeamGroup(ctx, infos, forcedDir, isTab, staffBottom) {
  const { frag } = ctx;
  const notes = infos.filter(i => !i.rest);
  if (notes.length < 2) { infos.forEach(i => finishUnbeamed(ctx, i)); return; }
  let up;
  if (isTab) up = false;
  else if (forcedDir) up = forcedDir === 'up';
  else if (notes.some(i => i.ev.stem)) up = (notes.find(i => i.ev.stem).ev.stem === 'up');
  else {
    const extremes = notes.map(i => up ? 0 : 0); // placeholder
    const farthest = Math.max(...notes.map(i => Math.max(Math.abs(i.topY - 2), Math.abs(i.bottomY - 2))));
    const avg = notes.reduce((a, i) => a + (i.topY + i.bottomY) / 2, 0) / notes.length;
    up = avg > 2;
    // farthest note from middle decides when close
    const far = notes.reduce((best, i) => { const d = Math.max(2 - i.topY, i.bottomY - 2); return d > best.d ? { d, i } : best; }, { d: -1, i: null });
    if (far.i && Math.abs(avg - 2) < 0.75) up = (far.i.bottomY - 2) > (2 - far.i.topY);
    void extremes; void farthest;
  }
  const scale = notes[0].scale;
  const stemW = SP.stemWidth * scale;
  // recompute stem x / displacement for the group direction
  for (const i of notes) {
    i.stemDir = up ? 1 : -1;
    if (isTab) { i.stemX = i.x + i.headW / 2; continue; }
    i.stemX = up ? i.x + i.headW - stemW / 2 : i.x + stemW / 2;
  }
  // ideal tips
  const len = (SP.stemLen - 0.25) * scale;
  const first = notes[0], last = notes[notes.length - 1];
  let y0, y1;
  if (isTab) { y0 = y1 = staffBottom + 3.0; }
  else if (up) { y0 = first.topY - len; y1 = last.topY - len; }
  else { y0 = first.bottomY + len; y1 = last.bottomY + len; }
  let slope = (y1 - y0) / Math.max(0.01, last.stemX - first.stemX);
  const maxSlope = 0.22; const maxRise = 1.75;
  slope = Math.max(-maxSlope, Math.min(maxSlope, slope));
  if (Math.abs(slope * (last.stemX - first.stemX)) > maxRise) slope = Math.sign(slope) * maxRise / (last.stemX - first.stemX);
  // flat beam when the inner notes contradict the direction (keep simple: if all same pitch)
  if (notes.every(n => Math.abs(n.topY - first.topY) < 0.01)) slope = 0;
  const beamAt = x => y0 + slope * (x - first.stemX);
  // enforce minimum stem length for every note
  let shift = 0;
  const minLen = 2.6 * scale;
  for (const i of notes) {
    const by = beamAt(i.stemX);
    if (isTab) continue;
    if (up) { const need = i.topY - minLen; if (by > need) shift = Math.min(shift, need - by); }
    else { const need = i.bottomY + minLen; if (by < need) shift = Math.max(shift, need - by); }
  }
  // beams must not sit inside the staff at awkward places: keep primary beam at least at the staff edge for notes outside
  const beamY = x => beamAt(x) + shift;
  const th = SP.beam * scale;
  const levelCount = Math.max(...notes.map(i => i.bc));
  // stems
  for (const i of notes) {
    const tip = beamY(i.stemX);
    if (isTab) stemLine(ctx, i, staffBottom + 0.6, tip);
    else if (up) stemLine(ctx, i, i.bottomY, tip - th / 2 * 0 ); else stemLine(ctx, i, i.topY, tip);
    i.tipY = tip; i.beamed = true;
  }
  // beams per level
  const dir = up ? 1 : -1;                // beams stack toward the heads: for up stems, lower levels go downward (+y)
  const outer = (x, lvl) => beamY(x) + dir * lvl * (th + SP.beamGap * scale);   // top edge y of beam at level lvl (0 = primary) for up stems
  const beamPoly = (xa, xb, lvl) => {
    const ya = outer(xa, lvl), yb = outer(xb, lvl);
    const tA = up ? ya : ya - th, tB = up ? yb : yb - th;
    frag.path(`M${f3(xa - stemW / 2)} ${f3(tA)} L${f3(xb + stemW / 2)} ${f3(tB)} L${f3(xb + stemW / 2)} ${f3(tB + th)} L${f3(xa - stemW / 2)} ${f3(tA + th)} Z`, 'beam');
    frag.ext(Math.min(tA, tB), Math.max(tA, tB) + th);
  };
  frag.add(`<g class="beams">`);
  beamPoly(first.stemX, last.stemX, 0);
  for (let lvl = 1; lvl < levelCount; lvl++) {
    // runs of consecutive notes having bc > lvl
    let k = 0;
    while (k < notes.length) {
      if (notes[k].bc <= lvl) { k++; continue; }
      let e = k; while (e + 1 < notes.length && notes[e + 1].bc > lvl && sameSubBeat(notes[e], notes[e + 1], lvl, ctx)) e++;
      if (e > k) beamPoly(notes[k].stemX, notes[e].stemX, lvl);
      else {
        // fractional beam: point toward the neighbour inside the same beat
        const n = notes[k]; const fl = 1.1 * scale;
        const toLeft = k > 0 && (k === notes.length - 1 || !(notes[k + 1] && notes[k + 1].bc > lvl) || tickSubBeat(n, lvl, ctx) === tickSubBeat(notes[k - 1], lvl, ctx));
        if (toLeft) beamPoly(n.stemX - fl, n.stemX, lvl); else beamPoly(n.stemX, n.stemX + fl, lvl);
      }
      k = e + 1;
    }
  }
  frag.add('</g>');
  for (const i of notes) { drawArticulations(ctx, i); drawFermata(ctx, i.ev, i, i.leftMost, i.rightMost, Math.min(i.topY, i.tipY), Math.max(i.bottomY, i.tipY)); if (i.ev.tremolo && !isTab) drawTremolo(ctx, i, i.tipY); }
  infos.filter(i => i.rest).forEach(() => {});
}
function tickSubBeat(info, lvl, ctx) {
  // sub-beat unit for secondary beam breaks: 16ths break per quarter in simple meters, per eighth in /8 meters
  const unit = ctx.ts.den === 8 ? 480 : 960;
  return Math.floor((info.tick + 1e-6) / unit);
}
function sameSubBeat(a, b, lvl, ctx) { return lvl < 2 || tickSubBeat(a, lvl, ctx) === tickSubBeat(b, lvl, ctx); }

/** Tuplet brackets / numbers for a voice's placed events. */
function drawTuplets(ctx, placed) {
  const { frag } = ctx;
  const groups = new Map();
  placed.forEach(info => { if (info?.ev.tuplet) { const id = info.ev.tuplet.id; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(info); } });
  for (const [, infos] of groups) {
    const t = infos[0].ev.tuplet;
    if (t.show === 'none') continue;
    const notes = infos.filter(i => !i.rest);
    const up = notes.length ? notes.every(i => i.stemDir > 0) : true;
    const allBeamed = notes.length === infos.length && notes.every(i => i.beamed) && notes.length > 1 && isOneBeam(notes);
    const x0 = infos[0].x - 0.3, x1 = (infos[infos.length - 1].rightMost ?? infos[infos.length - 1].x1 ?? infos[infos.length - 1].x + 1.3) + 0.3;
    const edge = i => up ? Math.min(i.tipY ?? i.topY, i.topY) : Math.max(i.tipY ?? i.bottomY, i.bottomY);
    let y = up ? Math.min(...infos.map(edge)) - 1.0 : Math.max(...infos.map(edge)) + 1.0;
    if (up) y = Math.min(y, -0.8); else y = Math.max(y, 4.8);
    const label = t.show === 'ratio' ? `${t.num}:${t.den}` : String(t.num);
    const lw = label.length * 1.0 * 0.72 + 0.3;
    const cx = (x0 + x1) / 2;
    frag.add('<g class="tuplet">');
    if (!allBeamed && t.bracket !== false) {
      const hook = up ? 0.8 : -0.8;
      frag.line(x0, y + hook, x0, y, 0.14); frag.line(x0, y, cx - lw / 2 - 0.3, y, 0.14);
      frag.line(cx + lw / 2 + 0.3, y, x1, y, 0.14); frag.line(x1, y, x1, y + hook, 0.14);
    }
    // number: use tsDigit glyphs scaled to 1.2 sp height
    let lx = cx - lw / 2 + 0.15;
    for (const ch of label) {
      const name = ch === ':' ? null : 'tsDigit' + ch;
      if (!name) { lx += 0.5; continue; }
      frag.use(name, lx, y + 0.7, 0.72, 'tuplet-num');
      lx += GLYPHS[name].w * 0.72;
    }
    frag.add('</g>');
  }
}
function isOneBeam(notes) { const t0 = notes[0].tipY; return notes.every(n => Math.abs((n.tipY ?? 0) - t0) < 3); }
