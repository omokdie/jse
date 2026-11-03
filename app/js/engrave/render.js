// Engraver: ScoreDoc → pages of SVG (+ geometry for hit testing).
import { staffList, effectiveTimeSig, effectiveKeySig, effectiveClef, durTicks, measureCapacity, findEvent } from '../model/score.js';
import { GLYPHS } from './glyphs.js';
import { SP, annotateScore, breakSystems, slotPositions, keySigPositions, headWidthFor } from './layout.js';
import { Frag, f3, renderStaffMeasure } from './notes.js';
import { textWidth, escapeXml, prettyChord, TEXT_FONT } from './text.js';

const CLEF_GLYPH = { treble: 'gClef', treble8vb: 'gClef8vb', treble8va: 'gClef8va', bass: 'fClef', bass8vb: 'fClef8vb', alto: 'cClef', tenor: 'cClef', percussion: 'percClef' };
const CLEF_Y = { treble: 3, treble8vb: 3, treble8va: 3, bass: 1, bass8vb: 1, alto: 2, tenor: 1, percussion: 2 };
const DYN_GLYPH = { p: 'dynamicPiano', m: 'dynamicMezzo', f: 'dynamicForte', r: 'dynamicRinforzando', s: 'dynamicSforzando', z: 'dynamicZ' };

export const PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420], B5: [176, 250], A5: [148, 210], Legal: [215.9, 355.6] };

export function pageDimsMm(settings) {
  let [w, h] = PAGE_SIZES[settings.pageSize] || [settings.pageWidthMm || 210, settings.pageHeightMm || 297];
  if (settings.pageSize === 'custom') { w = settings.pageWidthMm || 210; h = settings.pageHeightMm || 297; }
  if (settings.orientation === 'landscape') [w, h] = [h, w];
  return { w, h };
}

/**
 * Engrave the whole score.
 * @returns {{ pages: Page[], sp: number (mm per sp), pageW, pageH }}
 * Page: { width, height, svg, geometry: { events: [], measures: [], staves: [], slots: [] } }
 */
export function engrave(score, options = {}) {
  annotateScore(score);
  const s = score.settings;
  const spMm = s.staffSpaceMm || 1.75;
  const { w: pwMm, h: phMm } = pageDimsMm(s);
  const pageW = pwMm / spMm, pageH = phMm / spMm;
  const mg = s.marginsMm || { top: 15, bottom: 15, left: 15, right: 15 };
  const margin = { top: mg.top / spMm, bottom: mg.bottom / spMm, left: mg.left / spMm, right: mg.right / spMm };
  const contentW = pageW - margin.left - margin.right;
  const staves = staffList(score);
  let firstIndent = s.firstSystemIndentSp || 0, indent = 0;
  if (score.parts.length > 1 && s.showPartNames !== false) {
    firstIndent = Math.max(firstIndent, ...score.parts.map(p => textWidth(p.name || '', 2.2) + 2.6));
    indent = Math.max(0, ...score.parts.map(p => textWidth(p.abbreviation || '', 2.0) + 2.6));
  }
  const systems = breakSystems(score, contentW, { firstIndent, indent });
  // last system: don't over-stretch a short final system
  const lastSys = systems[systems.length - 1];
  if (lastSys && lastSys.rawStretch > 1.6 && systems.length > 1) {
    const natural = lastSys.measures.reduce((a, m) => a + m.metrics.idealWidth, 0) * 1.15;
    if (natural < lastSys.width) {
      let x = lastSys.indent || 0;
      for (const mm of lastSys.measures) { mm.x = x; mm.stretch = 1.15; mm.width = mm.metrics.fixed + mm.metrics.flex * 1.15; x += mm.width; }
      lastSys.usedWidth = x; lastSys.ragged = true;
    }
  }
  const rendered = systems.map((sys, i) => renderSystem(score, sys, i, staves, options));
  // --- pagination ---
  const pages = [];
  const titleH = titleBlockHeight(score);
  let page = null, y = 0;
  const newPage = () => { page = { systems: [], width: pageW, height: pageH }; pages.push(page); y = margin.top + (pages.length === 1 ? titleH : 0); };
  newPage();
  rendered.forEach((rs, i) => {
    const h = rs.bottom - rs.top;
    if (page.systems.length && (y + h > pageH - margin.bottom || rendered[i - 1]?.sys.pageBreakAfter)) newPage();
    rs.pageY = y - rs.top;   // translate so that rs.top lands on y
    page.systems.push(rs);
    y += h + (s.systemGapSp || 9);
  });
  // vertical justification: spread systems on full pages (not the last page)
  pages.forEach((pg, pi) => {
    if (pi === pages.length - 1 || pg.systems.length < 2) return;
    const last = pg.systems[pg.systems.length - 1];
    const usedBottom = last.pageY + last.bottom;
    const extra = pageH - margin.bottom - usedBottom;
    if (extra > 0 && extra < pageH * 0.35) {
      const add = Math.min(extra / (pg.systems.length - 1), (score.settings.systemGapSp || 9) * 0.8);
      pg.systems.forEach((rs, k) => { rs.pageY += add * k; });
    }
  });
  if (options.trimHeight) pages.forEach(pg => { const last = pg.systems[pg.systems.length - 1]; if (last) pg.height = Math.min(pg.height, last.pageY + last.bottom + margin.bottom); });
  // --- assemble SVG per page ---
  const out = pages.map((pg, pi) => assemblePage(score, pg, pi, pages.length, margin, titleH, options));
  return { pages: out, spMm, pageW, pageH, margin, systems: rendered.length };
}

function titleBlockHeight(score) {
  const m = score.meta;
  if (!m.title && !m.composer && !m.subtitle && !m.lyricist) return 0;
  let h = 0;
  if (m.title) h += SP.titleSize * 1.4;
  if (m.subtitle) h += SP.subtitleSize * 1.4;
  if (m.composer || m.lyricist || m.arranger) h += SP.composerSize * 1.6;
  return h + 3;
}

function assemblePage(score, pg, pi, pageCount, margin, titleH, options) {
  const parts = [];
  const glyphs = new Set();
  const geometry = { events: [], measures: [], staves: [], slots: [], systems: [], texts: [], spanners: [] };
  const W = pg.width, H = pg.height;
  parts.push(`<rect class="page-bg" x="0" y="0" width="${f3(W)}" height="${f3(H)}" fill="#fff"/>`);
  if (pi === 0 && titleH) {
    const m = score.meta; let y = margin.top + SP.titleSize;
    const cx = W / 2;
    // long titles (e.g. a photo's file name) shrink to fit between the margins instead of running off the page
    const avail = W - margin.left - margin.right;
    const fit = (text, size, bold = false) => { const w = textWidth(text, size, bold) * 1.05; return w > avail ? Math.max(size * 0.45, size * avail / w) : size; };
    if (m.title) { const fs = fit(m.title, SP.titleSize, true), tw = Math.min(avail, textWidth(m.title, fs, true) * 1.05); parts.push(`<text class="title" x="${f3(cx)}" y="${f3(y)}" text-anchor="middle" font-size="${f3(fs)}" font-weight="700" data-field="title">${escapeXml(m.title)}</text>`); geometry.texts.push({ field: 'title', x: cx - Math.max(20, tw / 2), y: y - SP.titleSize, w: Math.max(40, tw), h: SP.titleSize * 1.2 }); y += SP.subtitleSize * 1.4; }
    if (m.subtitle) { parts.push(`<text class="subtitle" x="${f3(cx)}" y="${f3(y)}" text-anchor="middle" font-size="${f3(fit(m.subtitle, SP.subtitleSize))}" data-field="subtitle">${escapeXml(m.subtitle)}</text>`); y += SP.subtitleSize * 1.4; }
    const ry = margin.top + titleH - 3;
    if (m.composer) parts.push(`<text class="composer" x="${f3(W - margin.right)}" y="${f3(ry)}" text-anchor="end" font-size="${SP.composerSize}" data-field="composer">${escapeXml(m.composer)}</text>`);
    if (m.arranger) parts.push(`<text class="composer" x="${f3(W - margin.right)}" y="${f3(ry - SP.composerSize * 1.3)}" text-anchor="end" font-size="${SP.composerSize}" data-field="arranger">${escapeXml(m.arranger)}</text>`);
    if (m.lyricist) parts.push(`<text class="lyricist" x="${f3(margin.left)}" y="${f3(ry)}" font-size="${SP.composerSize}" data-field="lyricist">${escapeXml(m.lyricist)}</text>`);
  }
  for (const rs of pg.systems) {
    const tx = margin.left, ty = rs.pageY;
    parts.push(`<g class="system" data-sys="${rs.index}" transform="translate(${f3(tx)} ${f3(ty)})">${rs.svg}</g>`);
    rs.glyphs.forEach(g => glyphs.add(g));
    // transform geometry into page coordinates
    const sh = (o, staffY) => ({ ...o, page: pi, x: o.x + tx, x1: o.x1 != null ? o.x1 + tx : undefined, xCenter: o.xCenter != null ? o.xCenter + tx : undefined, y0: o.y0 + staffY + ty, y1: o.y1 + staffY + ty, heads: (o.heads || []).map(h => ({ ...h, x: h.x + tx, x0: h.x0 + tx, x1: h.x1 + tx, y: h.y + staffY + ty, y0: h.y0 + staffY + ty, y1: h.y1 + staffY + ty })) });
    rs.geom.events.forEach(e => geometry.events.push(sh(e, rs.staffY[e.si])));
    rs.geom.measures.forEach(mr => geometry.measures.push({ ...mr, page: pi, x: mr.x + tx, y: mr.y + ty, systemIndex: rs.index, staves: mr.staves.map(st => ({ ...st, x: st.x + tx, y: st.y + ty })) }));
    rs.geom.slots.forEach(sl => geometry.slots.push({ ...sl, page: pi, x: sl.x + tx, xLeft: sl.xLeft + tx, xRight: sl.xRight + tx, y: sl.y + ty }));
    rs.geom.texts.forEach(t => geometry.texts.push({ ...t, page: pi, x: t.x + tx, y: t.y + rs.staffY[t.si || 0] + ty }));
    (rs.geom.spanners || []).forEach(sp => geometry.spanners.push({ ...sp, page: pi, pts: sp.pts.map(([x, y]) => [x + tx, y + rs.staffY[sp.si] + ty]) }));
    geometry.systems.push({ index: rs.index, x: tx, y: ty + rs.top, w: rs.sys.usedWidth || rs.sys.width, h: rs.bottom - rs.top, firstMeasure: rs.sys.measures[0].mi, lastMeasure: rs.sys.measures[rs.sys.measures.length - 1].mi });
  }
  if (score.settings.showPageNumbers !== false && pageCount > 1 && !options.trimHeight) {
    parts.push(`<text class="page-number" x="${f3(pi % 2 === 0 ? W - margin.right : margin.left)}" y="${f3(H - margin.bottom / 2)}" text-anchor="${pi % 2 === 0 ? 'end' : 'start'}" font-size="2">${pi + 1}</text>`);
  }
  if (pi > 0 && score.meta.title && score.settings.headerOnPages !== false && !options.trimHeight) {
    parts.push(`<text class="running-title" x="${f3(W / 2)}" y="${f3(margin.top / 2 + 1)}" text-anchor="middle" font-size="1.8" fill="#666">${escapeXml(score.meta.title)}</text>`);
  }
  const defs = `<defs>${[...glyphs].map(n => `<path id="g-${n}" d="${GLYPHS[n].p}"/>`).join('')}</defs>`;
  const F = TEXT_FONT.replace(/"/g, "'");
  const style = `<style>.score-page text{font-family:${F};fill:#111}.score-page .tab-bg{fill:#fff}.score-page .chord{font-weight:700}.score-page .page-bg{fill:#fff}.score-page line{stroke:#111;stroke-linecap:butt}.score-page path{fill:#111;stroke:none}.score-page path.hairpin,.score-page path.arpeggio,.score-page path.trill-line{fill:none;stroke:#111}.score-page use{fill:#111}.score-page .hidden{opacity:0.25}</style>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${f3(W)} ${f3(H)}" class="score-page" data-page="${pi}">${style}${defs}${parts.join('')}</svg>`;
  return { width: W, height: H, svg, geometry, index: pi };
}

// -----------------------------------------------------------------------------
// System rendering
// -----------------------------------------------------------------------------
function renderSystem(score, sys, index, staves, options) {
  const n = staves.length;
  const frags = staves.map(() => new Frag());
  const geom = { events: [], measures: [], slots: [], texts: [], spanners: [] };
  const sysMeasures = [];
  const firstMi = sys.measures[0].mi;
  const keyAtSystem = effectiveKeySig(score, firstMi);
  // staff heights
  const staffHeight = st => st.type === 'tab' ? (st.lines - 1) * SP.tabLineGap : st.lines === 1 ? 4 : st.lines - 1;
  // ---- pass 1: per measure, per staff ----
  for (const mm of sys.measures) {
    const m = score.measures[mm.mi];
    const ts = effectiveTimeSig(score, mm.mi);
    const keySig = effectiveKeySig(score, mm.mi);
    const positions = slotPositions(mm, m);
    const measureRec = { measureId: m.id, mi: mm.mi, x: mm.x, width: mm.width, y: 0, staves: [], slots: positions.map(p => ({ tick: p.tick, x: p.x + mm.x, xLeft: p.left + mm.x, xRight: p.right + mm.x, grace: p.grace })) };
    positions.forEach(p => geom.slots.push({ mi: mm.mi, measureId: m.id, tick: p.tick, x: p.x + mm.x + (p.slot.core || SP.headBlack) / 2, xLeft: p.left + mm.x, xRight: p.right + mm.x, y: 0, grace: p.grace }));
    const prefixEnd = SP.measureLeftPad + (m.barlineLeft === 'repeat-start' ? 1.6 : 0) + mm.metrics.prefix.width;
    staves.forEach((s, si) => {
      const frag = frags[si];
      const staff = s.staff;
      const clef = effectiveClef(score, mm.mi, si);
      const sh = staffHeight(staff);
      // staff lines for this measure span (drawn per measure so measures can be hit-tested)
      frag.add(`<g class="measure" data-mid="${m.id}" data-si="${si}">`);
      drawStaffLines(frag, staff, mm.x, mm.x + mm.width, sh);
      // prefix
      let px = mm.x + SP.measureLeftPad;
      if (m.barlineLeft === 'repeat-start') { drawBarline(frag, mm.x + 0.3, 'repeat-start', sh, staff); px += 1.6; }
      const pre = mm.metrics.prefix;
      const pc = pre.clefs[si];
      if (pc.show) { drawClef(frag, clef, px, pc.small, staff); }
      px += pre.clef;
      const pk = pre.keys[si];
      if (pk.show) drawKeySig(frag, pk.fifths, clef, px, pk.prevFifths);
      px += pre.key;
      const pt = pre.times[si];
      if (pt.show && staff.type !== 'tab') drawTimeSig(frag, pt.ts, px + 0.3, sh);
      // events
      const ctx = { score, m, mi: mm.mi, si, staff, clef, ts, keySig, positions: positions.map(p => ({ ...p, x: p.x + mm.x, left: p.left + mm.x, right: p.right + mm.x })), mx: mm.x, mwidth: mm.width, prefixEnd, frag, geom, voiceCount: m.staves[si].voices.length, system: sys };
      renderStaffMeasure(ctx);
      // right barline
      const isLastOfSystem = mm === sys.measures[sys.measures.length - 1];
      const isLast = mm.mi === score.measures.length - 1;
      let bl = m.barlineRight || 'single';
      if (isLast && bl === 'single') bl = 'final';
      drawBarline(frag, mm.x + mm.width, bl, sh, staff, isLastOfSystem);
      frag.add('</g>');
      measureRec.staves.push({ si, x: mm.x, y: 0, w: mm.width, h: sh, clef, prefixEnd: mm.x + prefixEnd });
    });
    geom.measures.push(measureRec);
    sysMeasures.push({ mm, m, ts, keySig, positions, prefixEnd });
  }
  // ---- pass 2: per staff decorations needing system-wide alignment ----
  const evGeo = new Map(geom.events.map(e => [e.id, e]));
  staves.forEach((s, si) => {
    const frag = frags[si];
    const sh = staffHeight(s.staff);
    const notesMin = Math.min(0, frag.minY), notesMax = Math.max(sh, frag.maxY);
    const events = geom.events.filter(e => e.si === si);
    // ties
    drawTies(score, sys, si, events, evGeo, frag, index);
    // slurs & other event spanners
    drawEventSpanners(score, sys, si, evGeo, frag, index, sh, notesMax, geom);
    // lyrics
    const lyricEvents = events.map(e => ({ e, ev: findEventIn(score, e) })).filter(x => x.ev?.lyrics?.length);
    const hasLyrics = lyricEvents.length > 0;
    // dynamics baseline
    const dynEvents = events.map(e => ({ e, ev: findEventIn(score, e) })).filter(x => x.ev?.dynamic);
    const dynAbove = hasLyrics && s.part.staves.length === 1 && s.staff.type === 'standard';
    let dynY = dynAbove ? Math.min(notesMin - 1.2, -2.2) : Math.max(notesMax + 2.6, sh + 3.0);
    const hairpins = (score.spanners || []).filter(sp => (sp.type === 'crescendo' || sp.type === 'diminuendo') && evGeo.has(sp.from.eventId) && geomStaffOf(score, sp.from.eventId) === si);
    if (dynEvents.length || hairpins.length) {
      for (const { e, ev } of dynEvents) drawDynamic(frag, ev.dynamic, e.xCenter ?? e.x, dynY);
      for (const hp of hairpins) drawHairpin(score, sys, hp, evGeo, frag, dynY - 0.9, index, geom, si);
    }
    // lyrics rows
    if (hasLyrics) {
      const base = Math.max(dynAbove ? notesMax + 1.2 : (dynEvents.length || hairpins.length ? dynY + 1.0 : notesMax + 1.0), sh + 2.4) + SP.lyricSize * 0.9;
      const verses = Math.max(...lyricEvents.flatMap(x => x.ev.lyrics.map(l => l.verse || 1)));
      for (let v = 1; v <= verses; v++) {
        const y = base + (v - 1) * SP.lyricSize * 1.15;
        const row = lyricEvents.map(x => ({ x, l: x.ev.lyrics.find(l => (l.verse || 1) === v) })).filter(x => x.l);
        row.forEach(({ x, l }, i) => {
          const cx = x.e.xCenter ?? x.e.x;
          frag.text(cx, y, l.text, { size: SP.lyricSize, anchor: 'middle', cls: 'lyric' });
          geom.texts.push({ kind: 'lyric', eventId: x.ev.id, verse: v, si, x: cx - textWidth(l.text, SP.lyricSize) / 2, y: y - SP.lyricSize, w: textWidth(l.text, SP.lyricSize), h: SP.lyricSize * 1.2, measureId: x.e.measureId });
          const next = row[i + 1];
          if ((l.syllabic === 'begin' || l.syllabic === 'middle')) {
            const x0 = cx + textWidth(l.text, SP.lyricSize) / 2, x1 = next ? (next.x.e.xCenter ?? next.x.e.x) - textWidth(next.l.text, SP.lyricSize) / 2 : (sys.usedWidth || sys.width);
            if (x1 - x0 > 0.8) frag.text((x0 + x1) / 2, y, '-', { size: SP.lyricSize, anchor: 'middle', cls: 'lyric' });
          }
          if (l.extend) {
            const x0 = cx + textWidth(l.text, SP.lyricSize) / 2 + 0.3;
            const endEv = nextEventAfterTieChain(score, x.ev, evGeo);
            const x1 = endEv ? Math.max(x0 + 1, (endEv.x1 ?? endEv.x) ) : Math.min(x0 + 4, sys.usedWidth || sys.width);
            frag.line(x0, y, x1, y, 0.14, 'lyric-extend');
          }
        });
      }
    }
    // chord symbols above the top staff of the system (lead-sheet convention)
    if (si === 0) {
      const chords = sysMeasures.flatMap(({ mm, m }) => (m.chords || []).map(ch => ({ ch, mm, m })));
      if (chords.length) {
        const cy = Math.min(notesMin - 1.4, -2.6);
        for (const { ch, mm, m } of chords) {
          const slot = geom.slots.find(sl => sl.measureId === m.id && Math.abs(sl.tick - ch.tick) < 1) || geom.slots.find(sl => sl.measureId === m.id);
          const x = slot ? slot.xLeft : mm.x + 2;
          frag.text(x, cy, prettyChord(ch.text), { size: SP.chordSize, bold: true, cls: 'chord' });
          geom.texts.push({ kind: 'chord', chordId: ch.id, measureId: m.id, si, x, y: cy - SP.chordSize, w: textWidth(prettyChord(ch.text), SP.chordSize, true), h: SP.chordSize * 1.2 });
          if (ch.diagram) drawChordDiagram(frag, ch.diagram, x, cy - SP.chordSize - 0.6);
        }
      }
    }
    // measure-level and event-level texts
    for (const { mm, m } of sysMeasures) {
      for (const t of (m.texts || [])) {
        const above = t.placement !== 'below';
        const y = above ? Math.min(frag.minY, notesMin) - 0.8 : Math.max(frag.maxY, notesMax) + SP.textSize;
        if (si !== (t.staffIndex ?? 0)) continue;
        frag.text(mm.x + 1.0, y, t.text, { size: SP.textSize, italic: t.style === 'expression', bold: t.style === 'system' || t.style === 'technique', cls: 'mtext' });
        geom.texts.push({ kind: 'mtext', measureId: m.id, si, x: mm.x + 1.0, y: y - SP.textSize, w: textWidth(t.text, SP.textSize), h: SP.textSize * 1.2 });
      }
    }
    for (const e of events) {
      const ev = findEventIn(score, e); if (!ev?.texts?.length) continue;
      for (const t of ev.texts) {
        const above = t.placement !== 'below';
        const y = above ? Math.min(e.y0, notesMin) - 0.8 : Math.max(e.y1, notesMax) + SP.textSize;
        frag.text(e.x, y, t.text, { size: SP.textSize, italic: t.style === 'expression', bold: t.style === 'technique', cls: 'etext' });
        geom.texts.push({ kind: 'text', eventId: ev.id, si, x: e.x, y: y - SP.textSize, w: textWidth(t.text, SP.textSize), h: SP.textSize * 1.2, measureId: e.measureId });
      }
      if (ev.ornaments?.length) {
        let oy = Math.min(e.y0, 0) - 1.0;
        for (const o of ev.ornaments) {
          const name = { trill: 'ornamentTrill', turn: 'ornamentTurn', 'inverted-turn': 'ornamentTurnInverted', mordent: 'ornamentMordent', 'inverted-mordent': 'ornamentShortTrill' }[o];
          if (!name) continue;
          if (o === 'trill') frag.use(name, e.x, oy, 1, 'ornament'); else frag.use(name, (e.xCenter ?? e.x), oy - 0.5, 1, 'ornament');
          oy -= 1.8;
        }
      }
    }
    // top-staff items: tempo, rehearsal, markers, measure numbers, voltas
    if (si === 0) {
      for (const { mm, m } of sysMeasures) {
        const topY = Math.min(frag.minY, notesMin);
        let y = Math.min(topY - 1.0, -3.0);
        if (m.volta || hasVolta(score, m.id)) y -= 0; // handled below
        if (m.tempo && (m.tempo.text || m.tempo.showBpm !== false)) {
          drawTempo(frag, m.tempo, mm.x + (mm === sys.measures[0] ? mm.metrics.prefix.width + SP.measureLeftPad : 0.6), y - 0.4);
          geom.texts.push({ kind: 'tempo', measureId: m.id, si: 0, x: mm.x, y: y - 3.2, w: 12, h: 3.4 });
        }
        if (m.rehearsalMark) {
          const w = Math.max(2.6, textWidth(m.rehearsalMark, SP.rehearsalSize, true) + 1.2);
          const rx = mm.x + (mm === sys.measures[0] ? 0 : -w / 2 + 0.2);
          const ry = (m.tempo ? y - 3.4 : y) - 0.2;
          frag.rect(rx, ry - 2.7, w, 2.9, 'rehearsal-box', ' fill="none" stroke="#111" stroke-width="0.16"');
          frag.text(rx + w / 2, ry - 0.5, m.rehearsalMark, { size: SP.rehearsalSize, bold: true, anchor: 'middle', cls: 'rehearsal' });
          geom.texts.push({ kind: 'rehearsal', measureId: m.id, si: 0, x: rx, y: ry - 2.7, w, h: 2.9 });
        }
        for (const mk of (m.markers || [])) drawMarker(frag, mk, mm, y, sys);
        if (score.settings.measureNumbers === 'all' || (score.settings.measureNumbers !== 'none' && mm === sys.measures[0] && mm.mi > 0)) {
          frag.text(mm.x + (mm === sys.measures[0] ? 0 : 0.3), -1.3 + Math.min(0, Math.min(frag.minY, notesMin) + 1.3 > -1.3 ? 0 : 0), String(mm.mi + 1), { size: SP.measureNumberSize, cls: 'measure-number' });
        }
      }
      drawVoltas(score, sys, frag, sysMeasures, Math.min(frag.minY, notesMin));
    }
    // ottava / pedal / trill lines / glissando are event spanners (drawn above)
  });
  // ---- stack staves ----
  const staffY = [];
  let y = 0;
  staves.forEach((s, si) => {
    const sh = staffHeight(s.staff);
    if (si === 0) { staffY.push(0); y = 0; return; }
    const prev = frags[si - 1], prevSh = staffHeight(staves[si - 1].staff);
    const samePart = staves[si - 1].part === s.part;
    const gap = samePart ? (score.settings.staffGapSp || 7) : (score.settings.staffGapSp || 7) + 2;
    const need = (prev.maxY - prevSh) + (-frags[si].minY) + 1.2;
    y = staffY[si - 1] + prevSh + Math.max(gap, need);
    staffY.push(y);
  });
  // ---- assemble system ----
  const out = [];
  const glyphs = new Set();
  const totalW = sys.usedWidth || sys.width;
  // brace / bracket / system barline
  if (staves.length > 1) {
    const lastSh = staffHeight(staves[staves.length - 1].staff);
    out.push(`<line class="sys-bar" x1="${f3(sys.indent || 0)}" y1="0" x2="${f3(sys.indent || 0)}" y2="${f3(staffY[staves.length - 1] + lastSh)}" stroke-width="${SP.barThin}"/>`);
  }
  staves.forEach((s, si) => {
    if (s.part.staves.length > 1 && s.staffIndex === 0) {
      const lastIdx = si + s.part.staves.length - 1;
      const top = staffY[si], bottom = staffY[lastIdx] + staffHeight(staves[lastIdx].staff);
      const g = GLYPHS.brace; glyphs.add('brace');
      const scaleY = (bottom - top) / (g.b[3] - g.b[1]);
      out.push(`<use href="#g-brace" transform="translate(${f3((sys.indent || 0) - 0.5)} ${f3((top + bottom) / 2)}) scale(1.3 ${f3(scaleY)})"/>`);
    }
    if (s.staffIndex === 0 && index === 0 && score.parts.length > 1 && (score.settings.showPartNames !== false)) {
      // part name left of the system
      const cy = staffY[si] + staffHeight(s.staff) / 2 + 0.6;
      out.push(`<text class="part-name" x="${f3((sys.indent || 0) - 1.5)}" y="${f3(cy)}" text-anchor="end" font-size="2.2">${escapeXml(s.part.name || '')}</text>`);
    } else if (s.staffIndex === 0 && index > 0 && score.parts.length > 1 && score.settings.showPartNames !== false && s.part.abbreviation) {
      const cy = staffY[si] + staffHeight(s.staff) / 2 + 0.6;
      out.push(`<text class="part-name" x="${f3((sys.indent || 0) - 1.5)}" y="${f3(cy)}" text-anchor="end" font-size="2.0">${escapeXml(s.part.abbreviation)}</text>`);
    }
  });
  staves.forEach((s, si) => {
    out.push(`<g class="staff" data-si="${si}" transform="translate(0 ${f3(staffY[si])})">${frags[si].toString()}</g>`);
    frags[si].glyphs.forEach(g => glyphs.add(g));
  });
  const top = Math.min(...staves.map((s, si) => staffY[si] + frags[si].minY)) - 0.5;
  const bottom = Math.max(...staves.map((s, si) => staffY[si] + frags[si].maxY)) + 0.5;
  // geometry: measure/staff rects in system coords
  geom.measures.forEach(mr => mr.staves.forEach(st => { st.y = staffY[st.si]; }));
  geom.slots.forEach(sl => { sl.y = 0; });
  return { index, sys, svg: out.join(''), top, bottom, staffY, geom, glyphs, width: totalW };
}

function findEventIn(score, e) {
  const m = score.measures[e.mi]; const v = m?.staves[e.si]?.voices[e.vi]; return v ? v[e.ei] : null;
}
function geomStaffOf(score, eventId) { const f = findEvent(score, eventId); return f ? f.staffIndex : -1; }
function hasVolta(score, measureId) { return (score.spanners || []).some(sp => sp.type === 'volta' && (sp.from.measureId === measureId)); }

function drawStaffLines(frag, staff, x0, x1, sh) {
  const n = staff.lines || 5;
  if (staff.type === 'tab') { for (let i = 0; i < n; i++) frag.line(x0, i * SP.tabLineGap, x1, i * SP.tabLineGap, SP.staffLine, 'staff-line'); return; }
  if (n === 1) { frag.line(x0, 2, x1, 2, SP.staffLine, 'staff-line'); return; }
  for (let i = 0; i < n; i++) frag.line(x0, i, x1, i, SP.staffLine, 'staff-line');
}
function drawClef(frag, clef, x, small, staff) {
  if (staff.type === 'tab') {
    frag.text(x + 0.2, 2.5, 'T', { size: 2.6, bold: true, cls: 'tab-clef' }); frag.text(x + 0.2, 5.0, 'A', { size: 2.6, bold: true, cls: 'tab-clef' }); frag.text(x + 0.2, 7.5, 'B', { size: 2.6, bold: true, cls: 'tab-clef' });
    return;
  }
  const name = CLEF_GLYPH[clef] || 'gClef';
  let y = CLEF_Y[clef] ?? 3;
  if (staff.lines === 1) y = 2;
  frag.use(name, x + 0.2, y, small ? SP.smallClefScale : 1, 'clef');
}
function drawKeySig(frag, fifths, clef, x, prevFifths) {
  let cx = x + 0.2;
  if (!fifths && prevFifths) {
    for (const p of keySigPositions(prevFifths, clef)) { frag.use('accidentalNatural', cx, p.pos / 2, 1, 'keysig'); cx += 0.95; }
    return;
  }
  for (const p of keySigPositions(fifths, clef)) { frag.use(p.acc === 'sharp' ? 'accidentalSharp' : 'accidentalFlat', cx, p.pos / 2, 1, 'keysig'); cx += 1.0; }
}
function drawTimeSig(frag, ts, x, sh) {
  if (ts.display === 'common') { frag.use('timeSigCommon', x, sh / 2, 1, 'timesig'); return; }
  if (ts.display === 'cut') { frag.use('timeSigCutCommon', x, sh / 2, 1, 'timesig'); return; }
  const dw = s => String(s).split('').reduce((a, c) => a + GLYPHS['tsDigit' + c].w, 0);
  const wn = dw(ts.num), wd = dw(ts.den), w = Math.max(wn, wd);
  const draw = (s, y, ww) => { let cx = x + (w - ww) / 2; for (const c of String(s)) { frag.use('tsDigit' + c, cx, y, 1, 'timesig'); cx += GLYPHS['tsDigit' + c].w; } };
  const mid = sh / 2;
  draw(ts.num, mid, wn); draw(ts.den, mid + 2, wd);
}
export function drawBarline(frag, x, type, sh, staff, systemEnd = false) {
  const y0 = staff.lines === 1 && staff.type !== 'tab' ? 1 : 0, y1 = staff.lines === 1 && staff.type !== 'tab' ? 3 : sh;
  const thin = SP.barThin, thick = SP.barThick;
  const dotsY = staff.type === 'tab' ? [sh / 2 - 0.75, sh / 2 + 0.75] : [1.5, 2.5];
  switch (type) {
    case 'none': return;
    case 'dashed': frag.parts.push(`<line x1="${f3(x)}" y1="${f3(y0)}" x2="${f3(x)}" y2="${f3(y1)}" stroke-width="${thin}" stroke-dasharray="0.6 0.5" class="barline"/>`); return;
    case 'double': frag.line(x - 0.6, y0, x - 0.6, y1, thin, 'barline'); frag.line(x, y0, x, y1, thin, 'barline'); return;
    case 'final': frag.line(x - 0.9, y0, x - 0.9, y1, thin, 'barline'); frag.line(x - thick / 2, y0, x - thick / 2, y1, thick, 'barline'); return;
    case 'repeat-end':
      frag.line(x - 0.9, y0, x - 0.9, y1, thin, 'barline'); frag.line(x - thick / 2, y0, x - thick / 2, y1, thick, 'barline');
      dotsY.forEach(dy => frag.parts.push(`<circle cx="${f3(x - 1.7)}" cy="${f3(dy)}" r="0.22" class="barline"/>`)); return;
    case 'repeat-both':
      frag.line(x - 0.9, y0, x - 0.9, y1, thin, 'barline'); frag.line(x - thick / 2, y0, x - thick / 2, y1, thick, 'barline');
      dotsY.forEach(dy => frag.parts.push(`<circle cx="${f3(x - 1.7)}" cy="${f3(dy)}" r="0.22" class="barline"/>`));
      frag.line(x + 0.7, y0, x + 0.7, y1, thin, 'barline'); dotsY.forEach(dy => frag.parts.push(`<circle cx="${f3(x + 1.5)}" cy="${f3(dy)}" r="0.22" class="barline"/>`)); return;
    case 'repeat-start':
      frag.line(x + thick / 2, y0, x + thick / 2, y1, thick, 'barline'); frag.line(x + 0.9, y0, x + 0.9, y1, thin, 'barline');
      dotsY.forEach(dy => frag.parts.push(`<circle cx="${f3(x + 1.7)}" cy="${f3(dy)}" r="0.22" class="barline"/>`)); return;
    default: frag.line(x, y0, x, y1, thin, 'barline');
  }
}

function drawDynamic(frag, dyn, x, y) {
  let cx = x - 0.6;
  frag.add(`<g class="dynamic" data-dyn="${dyn}">`);
  for (const ch of dyn) {
    const name = DYN_GLYPH[ch]; if (!name) continue;
    const bb = frag.use(name, cx, y, 1, 'dyn');
    cx += GLYPHS[name].adv ?? (bb.x1 - bb.x0 + 0.1);
  }
  frag.add('</g>');
}
function drawHairpin(score, sys, hp, evGeo, frag, y, sysIndex, geom = null, si = 0) {
  const a = evGeo.get(hp.from.eventId), b = evGeo.get(hp.to.eventId);
  const x0 = a ? a.x : (sys.indent || 0) + 2, x1 = b ? (b.x1 ?? b.x + 1.3) : (sys.usedWidth || sys.width) - 1;
  if (!a && !b) return;
  const open = 1.0;
  const attrs = ` stroke-width="0.14" data-sp="${hp.id}"`;
  if (hp.type === 'crescendo') frag.path(`M${f3(x1)} ${f3(y - open / 2)} L${f3(x0)} ${f3(y)} L${f3(x1)} ${f3(y + open / 2)}`, 'hairpin', attrs);
  else frag.path(`M${f3(x0)} ${f3(y - open / 2)} L${f3(x1)} ${f3(y)} L${f3(x0)} ${f3(y + open / 2)}`, 'hairpin', attrs);
  frag.ext(y - 1, y + 1);
  if (geom) geom.spanners.push({ id: hp.id, type: hp.type, si, pts: [[x0, y], [x1, y - open / 2], [x1, y + open / 2]], start: [x0, y], end: [x1, y], hasStart: !!a, hasEnd: !!b });
}

function drawTempo(frag, tempo, x, y) {
  let cx = x;
  frag.add('<g class="tempo">');
  if (tempo.text) { frag.text(cx, y, tempo.text, { size: SP.tempoSize, bold: true, cls: 'tempo-text' }); cx += textWidth(tempo.text, SP.tempoSize, true) + 1.0; }
  if (tempo.showBpm !== false && tempo.bpm) {
    // small note glyph + "= bpm"
    const base = tempo.beatUnit || 'quarter';
    const hw = headWidthFor(base) * 0.7;
    const hy = y - 0.8;
    frag.use(base === 'whole' ? 'noteheadWhole' : base === 'half' ? 'noteheadHalf' : 'noteheadBlack', cx, hy, 0.7, 'tempo-note');
    if (base !== 'whole') frag.line(cx + hw - 0.05, hy, cx + hw - 0.05, hy - 2.3, 0.1);
    if (base === 'eighth') frag.use('flag8thUp', cx + hw - 0.1, hy - 2.3, 0.7);
    if (tempo.dots) frag.parts.push(`<circle cx="${f3(cx + hw + 0.45)}" cy="${f3(hy - 0.3)}" r="0.18"/>`);
    cx += hw + (tempo.dots ? 0.9 : 0.5);
    frag.text(cx + 0.2, y, `= ${tempo.bpm}`, { size: SP.tempoSize * 0.85, cls: 'tempo-bpm' });
  }
  frag.add('</g>');
}
function drawMarker(frag, mk, mm, y, sys) {
  const right = mm.x + mm.width;
  switch (mk) {
    case 'segno': frag.use('segno', mm.x + 1.2, y - 0.2, 1, 'marker'); break;
    case 'coda': frag.use('coda', mm.x + 1.2, y - 0.2, 1, 'marker'); break;
    case 'fine': frag.text(right - 0.5, y - 0.4, 'Fine', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'toCoda': frag.text(right - 2.6, y - 0.4, 'To', { size: 2.0, bold: true, italic: true, anchor: 'end' }); frag.use('coda', right - 2.2, y - 0.2, 0.9, 'marker'); break;
    case 'dsAlCoda': frag.text(right - 0.5, y - 0.4, 'D.S. al Coda', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'dsAlFine': frag.text(right - 0.5, y - 0.4, 'D.S. al Fine', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'dcAlCoda': frag.text(right - 0.5, y - 0.4, 'D.C. al Coda', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'dcAlFine': frag.text(right - 0.5, y - 0.4, 'D.C. al Fine', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'dc': frag.text(right - 0.5, y - 0.4, 'D.C.', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
    case 'ds': frag.text(right - 0.5, y - 0.4, 'D.S.', { size: 2.2, bold: true, italic: true, anchor: 'end' }); break;
  }
  void sys;
}
function drawVoltas(score, sys, frag, sysMeasures, topY) {
  const voltas = (score.spanners || []).filter(sp => sp.type === 'volta');
  if (!voltas.length) return;
  const y = Math.min(topY - 1.2, -2.8);
  for (const v of voltas) {
    const fromIdx = score.measures.findIndex(m => m.id === v.from.measureId);
    const toIdx = score.measures.findIndex(m => m.id === (v.to?.measureId || v.from.measureId));
    if (fromIdx < 0) continue;
    const first = sysMeasures.find(sm => sm.mm.mi >= fromIdx && sm.mm.mi <= toIdx);
    if (!first) continue;
    const last = [...sysMeasures].reverse().find(sm => sm.mm.mi >= fromIdx && sm.mm.mi <= toIdx);
    const x0 = first.mm.x + (first.mm.mi === fromIdx ? 0.2 : 0);
    const x1 = last.mm.x + last.mm.width - 0.3;
    const closed = last.mm.mi === toIdx && v.voltaType !== 'open';
    frag.line(x0, y, x1, y, 0.16); frag.line(x0, y, x0, y + 2, 0.16); if (closed) frag.line(x1, y, x1, y + 2, 0.16);
    frag.text(x0 + 0.7, y + 1.9, v.number || '1.', { size: 2.0, cls: 'volta' });
  }
}

function drawChordDiagram(frag, d, x, yBottom) {
  // 4 frets × 6 strings mini grid
  const w = 3.0, h = 3.4, sx = w / 5, fy = h / 4;
  const x0 = x, y0 = yBottom - h;
  frag.add('<g class="chord-diagram">');
  for (let s = 0; s < 6; s++) frag.line(x0 + s * sx, y0, x0 + s * sx, y0 + h, 0.08);
  for (let f = 0; f <= 4; f++) frag.line(x0, y0 + f * fy, x0 + w, y0 + f * fy, f === 0 && (d.baseFret || 1) === 1 ? 0.3 : 0.08);
  (d.frets || []).forEach((fr, i) => {
    const cx = x0 + i * sx;
    if (fr < 0) { frag.text(cx, y0 - 0.3, '×', { size: 1.1, anchor: 'middle' }); }
    else if (fr === 0) { frag.parts.push(`<circle cx="${f3(cx)}" cy="${f3(y0 - 0.6)}" r="0.28" fill="none" stroke="#111" stroke-width="0.08"/>`); }
    else { const rel = fr - (d.baseFret || 1) + 1; if (rel >= 1 && rel <= 4) frag.parts.push(`<circle cx="${f3(cx)}" cy="${f3(y0 + (rel - 0.5) * fy)}" r="0.3"/>`); }
  });
  if ((d.baseFret || 1) > 1) frag.text(x0 + w + 0.3, y0 + fy * 0.8, `${d.baseFret}fr`, { size: 1.0 });
  frag.ext(y0 - 1.2, y0 + h);
  frag.add('</g>');
}

// ---- ties & slurs ----
function drawTies(score, sys, si, events, evGeo, frag, sysIndex) {
  const firstMi = sys.measures[0].mi, lastMi = sys.measures[sys.measures.length - 1].mi;
  for (const e of events) {
    const ev = findEventIn(score, e); if (!ev || ev.kind !== 'note') continue;
    ev.notes.forEach((n, ni) => {
      if (!n.tieStart) return;
      const head = e.heads[ni]; if (!head) return;
      const nxt = nextEventInVoice(score, e.mi, e.si, e.vi, e.ei);
      let target = null, targetHead = null;
      if (nxt) { const g = evGeo.get(nxt.ev.id); if (g) { target = g; const k = nxt.ev.notes?.findIndex(x => x.step === n.step && x.octave === n.octave); targetHead = k >= 0 ? g.heads[k] : null; } }
      const up = !(e.stemUp) || ev.notes.length > 1 && ni === ev.notes.length - 1 && e.stemUp; // tie opposite to stem
      const dir = ev.notes.length > 1 ? (ni >= ev.notes.length / 2 ? -1 : 1) : (e.stemUp ? 1 : -1);  // 1 = below
      const y = head.y + dir * 0.75;
      const x0 = head.x + head.w * 0.85;
      const x1 = targetHead ? targetHead.x + targetHead.w * 0.15 : (nxt && nxt.mi > lastMi ? (sys.usedWidth || sys.width) : x0 + 2.5);
      drawCurve(frag, x0, y, x1, y, dir, 'tie');
      void up;
    });
  }
  // ties coming from the previous system
  const firstEvents = events.filter(e => e.mi === firstMi);
  for (const e of firstEvents) {
    const ev = findEventIn(score, e); if (!ev || ev.kind !== 'note') continue;
    ev.notes.forEach((n, ni) => {
      if (!n.tieEnd) return;
      const head = e.heads[ni]; if (!head) return;
      // was the start in a previous system?  (previous event in voice before this system)
      const prev = prevEventInVoice(score, e.mi, e.si, e.vi, e.ei);
      if (!prev || prev.mi >= firstMi) return;
      const dir = e.stemUp ? 1 : -1;
      drawCurve(frag, (sys.indent || 0) + 0.5, head.y + dir * 0.75, head.x + head.w * 0.15, head.y + dir * 0.75, dir, 'tie');
    });
  }
}
export function nextEventInVoice(score, mi, si, vi, ei) {
  const v = score.measures[mi].staves[si].voices[vi];
  if (ei + 1 < v.length) return { ev: v[ei + 1], mi, ei: ei + 1 };
  for (let k = mi + 1; k < score.measures.length; k++) { const vv = score.measures[k].staves[si]?.voices[vi]; if (vv && vv.length) return { ev: vv[0], mi: k, ei: 0 }; if (vv && !vv.length && vi > 0) return null; }
  return null;
}
export function prevEventInVoice(score, mi, si, vi, ei) {
  const v = score.measures[mi].staves[si].voices[vi];
  if (ei > 0) return { ev: v[ei - 1], mi, ei: ei - 1 };
  for (let k = mi - 1; k >= 0; k--) { const vv = score.measures[k].staves[si]?.voices[vi]; if (vv && vv.length) return { ev: vv[vv.length - 1], mi: k, ei: vv.length - 1 }; }
  return null;
}
function nextEventAfterTieChain(score, ev, evGeo) {
  const f = findEvent(score, ev.id); if (!f) return null;
  let cur = { mi: f.mi, ei: f.index, ev };
  for (let guard = 0; guard < 16; guard++) {
    const nxt = nextEventInVoice(score, cur.mi, f.staffIndex, f.voiceIndex, cur.ei);
    if (!nxt) return null;
    const g = evGeo.get(nxt.ev.id);
    if (nxt.ev.lyrics?.length || nxt.ev.kind === 'rest') return g ? evGeo.get(cur.ev.id) : null;
    cur = nxt;
    if (!g) return null;
  }
  return null;
}
function drawCurve(frag, x0, y0, x1, y1, dir, cls) {
  const len = Math.max(0.5, x1 - x0);
  const h = Math.min(2.2, 0.55 + len * 0.12) * dir;
  const th = 0.22;
  const c1x = x0 + len * 0.25, c2x = x0 + len * 0.75;
  const d = `M${f3(x0)} ${f3(y0)} C${f3(c1x)} ${f3(y0 + h)} ${f3(c2x)} ${f3(y1 + h)} ${f3(x1)} ${f3(y1)} C${f3(c2x)} ${f3(y1 + h + th * dir)} ${f3(c1x)} ${f3(y0 + h + th * dir)} ${f3(x0)} ${f3(y0)} Z`;
  frag.path(d, cls);
  frag.ext(Math.min(y0, y0 + h * 0.9), Math.max(y0, y0 + h * 0.9));
}
function drawEventSpanners(score, sys, si, evGeo, frag, sysIndex, sh, notesMax, geom = null) {
  const rec = (sp, pts, extra = {}) => { if (geom && pts.length) geom.spanners.push({ id: sp.id, type: sp.type, si, pts, start: pts[0], end: pts[pts.length - 1], ...extra }); };
  const firstMi = sys.measures[0].mi, lastMi = sys.measures[sys.measures.length - 1].mi;
  for (const sp of (score.spanners || [])) {
    if (!sp.from?.eventId) continue;
    const fa = findEvent(score, sp.from.eventId), fb = findEvent(score, sp.to?.eventId || sp.from.eventId);
    if (!fa || fa.staffIndex !== si) continue;
    const inSys = (f) => f && f.mi >= firstMi && f.mi <= lastMi;
    if (!inSys(fa) && !inSys(fb) && !(fa.mi < firstMi && fb && fb.mi > lastMi)) continue;
    const a = evGeo.get(sp.from.eventId), b = fb ? evGeo.get(fb.ev.id) : null;
    const xStart = a ? a.x : (sys.indent || 0) + 1, xEnd = b ? (b.x1 ?? b.x + 1.3) : (sys.usedWidth || sys.width) - 0.5;
    switch (sp.type) {
      case 'slur': {
        const dir = sp.placement === 'above' ? -1 : sp.placement === 'below' ? 1 : (a ? (a.stemUp ? 1 : -1) : -1);
        const ya = a ? (dir > 0 ? a.y1 + 0.3 : a.y0 - 0.3) : 2, yb = b ? (dir > 0 ? b.y1 + 0.3 : b.y0 - 0.3) : ya;
        const x0 = a ? a.xCenter ?? a.x : xStart, x1 = b ? (b.xCenter ?? b.x) : xEnd;
        const len = Math.max(1, x1 - x0); const h = Math.min(3.5, 0.8 + len * 0.15) * dir;
        const c1x = x0 + len * 0.3, c2x = x0 + len * 0.7;
        const d = `M${f3(x0)} ${f3(ya)} C${f3(c1x)} ${f3(ya + h)} ${f3(c2x)} ${f3(yb + h)} ${f3(x1)} ${f3(yb)} C${f3(c2x)} ${f3(yb + h + 0.25 * dir)} ${f3(c1x)} ${f3(ya + h + 0.25 * dir)} ${f3(x0)} ${f3(ya)} Z`;
        frag.path(d, 'slur', ` data-sp="${sp.id}"`);
        frag.ext(Math.min(ya, ya + h), Math.max(ya, ya + h));
        { const pts = []; for (let k = 0; k <= 12; k++) { const t = k / 12, mt = 1 - t; pts.push([mt * mt * mt * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * x1, mt * mt * mt * ya + 3 * mt * mt * t * (ya + h) + 3 * mt * t * t * (yb + h) + t * t * t * yb]); } rec(sp, pts, { hasStart: !!a, hasEnd: !!b, dir }); }
        break;
      }
      case 'ottava': {
        const above = (sp.octaveShift || 8) > 0;
        const y = above ? Math.min(a ? a.y0 : 0, 0) - 1.6 : Math.max(b ? b.y1 : sh, sh) + 2.2;
        const name = Math.abs(sp.octaveShift || 8) === 15 ? (above ? 'quindicesimaAlta' : 'quindicesimaBassa') : (above ? 'ottavaAlta' : 'ottavaBassa');
        frag.add(`<g class="sp" data-sp="${sp.id}">`);
        const bb = frag.use(name, xStart, y, 0.8, 'ottava');
        frag.parts.push(`<line x1="${f3(bb.x1 + 0.4)}" y1="${f3(y - 0.6)}" x2="${f3(xEnd)}" y2="${f3(y - 0.6)}" stroke-width="0.14" stroke-dasharray="0.8 0.5"/>`);
        frag.line(xEnd, y - 0.6, xEnd, y - 0.6 + (above ? 1.0 : -1.0), 0.14);
        frag.add('</g>');
        rec(sp, [[xStart, y - 0.6], [(xStart + xEnd) / 2, y - 0.6], [xEnd, y - 0.6]]);
        break;
      }
      case 'pedal': {
        const y = Math.max(notesMax, sh) + 3.2;
        frag.add(`<g class="sp" data-sp="${sp.id}">`);
        frag.use('keyboardPedalPed', xStart, y, 0.9, 'pedal');
        if (b) frag.use('keyboardPedalUp', xEnd - 0.4, y - 0.6, 0.9, 'pedal');
        frag.add('</g>');
        rec(sp, [[xStart, y - 0.6], [(xStart + xEnd) / 2, y - 0.6], [xEnd, y - 0.6]]);
        break;
      }
      case 'trill': {
        const y = Math.min(a ? a.y0 : 0, 0) - 1.2;
        frag.add(`<g class="sp" data-sp="${sp.id}">`);
        const bb = frag.use('ornamentTrill', xStart, y, 0.85, 'ornament');
        let d = `M${f3(bb.x1 + 0.2)} ${f3(y - 0.6)}`; for (let x = bb.x1 + 0.2; x < xEnd; x += 1.0) d += ` q0.25 -0.5 0.5 0 t0.5 0`;
        frag.path(d, 'trill-line', ' fill="none" stroke-width="0.16"');
        frag.add('</g>');
        rec(sp, [[xStart, y - 0.6], [(xStart + xEnd) / 2, y - 0.6], [xEnd, y - 0.6]]);
        break;
      }
      case 'glissando': {
        if (a && b) { const y0 = a.heads[0]?.y ?? 2, y1 = b.heads[0]?.y ?? 2; frag.add(`<g class="sp" data-sp="${sp.id}">`); frag.line(a.x1 + 0.3, y0, b.x - 0.3, y1, 0.16, 'gliss'); frag.add('</g>'); rec(sp, [[a.x1 + 0.3, y0], [(a.x1 + b.x) / 2, (y0 + y1) / 2], [b.x - 0.3, y1]]); }
        break;
      }
      case 'textLine': {
        const y = Math.min(a ? a.y0 : 0, 0) - 1.4;
        frag.add(`<g class="sp" data-sp="${sp.id}">`);
        if (sp.text) frag.text(xStart, y, sp.text, { size: 2.0, italic: true });
        frag.parts.push(`<line x1="${f3(xStart + textWidth(sp.text || '', 2.0, false, true) + 0.4)}" y1="${f3(y - 0.6)}" x2="${f3(xEnd)}" y2="${f3(y - 0.6)}" stroke-width="0.14" stroke-dasharray="0.8 0.5"/>`);
        frag.add('</g>');
        rec(sp, [[xStart, y - 0.6], [(xStart + xEnd) / 2, y - 0.6], [xEnd, y - 0.6]]);
        break;
      }
    }
  }
}
export { findEventIn };
