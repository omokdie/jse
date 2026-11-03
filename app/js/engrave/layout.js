// Horizontal layout: measure metrics → systems. Vertical stacking is done in render.js
// after each system is engraved (its real extents are only known then).
// All distances are in staff spaces (sp).
import { durTicks, measureCapacity, effectiveTimeSig, effectiveKeySig, effectiveClef, staffList, totalStaffCount, DUR_TICKS } from '../model/score.js';
import { GLYPHS } from './glyphs.js';
import { textWidth } from './text.js';

export const SP = {
  headBlack: GLYPHS.noteheadBlack.w, headHalf: GLYPHS.noteheadHalf.w, headWhole: GLYPHS.noteheadWhole.w,
  headBreve: GLYPHS.noteheadDoubleWhole.w,
  stemWidth: 0.13, staffLine: 0.13, ledgerLine: 0.16, barThin: 0.16, barThick: 0.5, beam: 0.5, beamGap: 0.25,
  stemLen: 3.5, dotGap: 0.55, dotRadius: 0.22, accGap: 0.3, accPad: 0.15,
  measureLeftPad: 1.0, measureRightPad: 1.0,
  clefWidth: { treble: 2.9, treble8vb: 2.9, treble8va: 2.9, bass: 3.2, bass8vb: 3.2, alto: 3.0, tenor: 3.0, percussion: 1.9, tab: 2.4 },
  smallClefScale: 0.75,
  lyricSize: 2.1, chordSize: 2.3, textSize: 2.2, titleSize: 5.2, subtitleSize: 3.0, composerSize: 2.4, measureNumberSize: 1.6,
  tempoSize: 2.4, rehearsalSize: 2.3, tabFretSize: 1.7, tabLineGap: 1.5,
};

export function headWidthFor(base) {
  if (base === 'whole') return SP.headWhole;
  if (base === 'breve') return SP.headBreve;
  if (base === 'half') return SP.headHalf;
  return SP.headBlack;
}
export function accidentalWidth(acc) {
  const g = { sharp: 'accidentalSharp', flat: 'accidentalFlat', natural: 'accidentalNatural', 'double-sharp': 'accidentalDoubleSharp', 'double-flat': 'accidentalDoubleFlat' }[acc];
  return g ? GLYPHS[g].w : 0;
}

/** Ideal horizontal room (sp) after a note lasting `ticks`. Logarithmic, like most engravers. */
export function spaceFor(ticks) {
  if (ticks <= 0) return 1.0;
  const w = 1.75 + 0.85 * Math.log2(Math.max(ticks, 30) / 240);
  return Math.max(1.3, Math.min(w, 7.5));
}

// Key signature accidental staff positions (0 = top line, +1 per step downward)
const KEY_POS = {
  treble: { sharps: [0, 3, -1, 2, 5, 1, 4], flats: [4, 1, 5, 2, 6, 3, 7] },
  bass: { sharps: [2, 5, 1, 4, 7, 3, 6], flats: [6, 3, 7, 4, 8, 5, 9] },
  alto: { sharps: [1, 4, 0, 3, 6, 2, 5], flats: [5, 2, 6, 3, 7, 4, 8] },
  tenor: { sharps: [6, 2, 5, 1, 4, 0, 3], flats: [3, 0, 4, 1, 5, 2, 6] },
};
export function keySigPositions(fifths, clef) {
  const base = clef.startsWith('treble') ? 'treble' : clef.startsWith('bass') ? 'bass' : (KEY_POS[clef] ? clef : null);
  if (!base || !fifths) return [];
  const k = KEY_POS[base];
  if (fifths > 0) return k.sharps.slice(0, fifths).map(p => ({ pos: p, acc: 'sharp' }));
  return k.flats.slice(0, -fifths).map(p => ({ pos: p, acc: 'flat' }));
}
export function keySigWidth(fifths, clef, prevFifths) {
  const n = Math.abs(fifths);
  let w = n ? n * 1.0 + 0.4 : 0;
  if (!n && prevFifths) w = Math.abs(prevFifths) * 0.95 + 0.4;   // cancellation naturals
  return w;
}
export function timeSigWidth(ts) {
  if (!ts) return 0;
  if (ts.display === 'common' || ts.display === 'cut') return GLYPHS.timeSigCommon.w + 0.6;
  const dw = s => String(s).split('').reduce((a, c) => a + GLYPHS['tsDigit' + c].w, 0);
  return Math.max(dw(ts.num), dw(ts.den)) + 0.6;
}

/**
 * Compute per-measure horizontal metrics.
 * Returns { slots, prefix, minWidth, flexWidth } where slots are time slices shared by all staves.
 */
export function measureMetrics(score, mi, ctx) {
  const m = score.measures[mi];
  const ts = effectiveTimeSig(score, mi);
  const capacity = measureCapacity(ts);
  const staves = staffList(score);
  // 1. gather onsets
  const slotMap = new Map();  // key → slot
  const keyOf = (tick, graceIdx, graceCount) => (graceCount ? tick - (graceCount - graceIdx) * 0.01 : tick);
  m.staves.forEach((sm, si) => sm.voices.forEach((voice, vi) => {
    let tick = 0;
    // grace groups: count consecutive graces before a main event
    let graceRun = 0;
    voice.forEach((ev, ei) => {
      const isGrace = !!ev.grace;
      let key;
      if (isGrace) {
        // look ahead to count grace run length
        if (graceRun === 0) { let j = ei; while (j < voice.length && voice[j].grace) j++; ev._graceCount = j - ei; }
        const count = voice[ei - graceRun]?._graceCount || 1;
        key = keyOf(tick, graceRun, count); graceRun++;
      } else { key = tick; graceRun = 0; }
      let slot = slotMap.get(key);
      if (!slot) { slot = { key, tick, grace: isGrace, left: 0, core: 0, right: 0, gap: 0, events: [] }; slotMap.set(key, slot); }
      slot.events.push({ ev, si, vi, ei });
      const dur = ev.dur.base;
      const staffType = staves[si]?.staff.type;
      let core = staffType === 'tab' ? 1.6 : headWidthFor(dur);
      if (ev.kind === 'rest') core = restWidth(dur);
      if (isGrace) core *= 0.65;
      let left = 0, right = 0;
      if (ev.kind === 'note' && staffType !== 'tab') {
        // accidentals
        const accs = ev.notes.filter(n => n._showAcc).map(n => accidentalWidth(n._showAcc));
        if (accs.length) left = Math.max(left, Math.max(...accs) + SP.accGap + (accs.length > 1 ? 0.6 * (accs.length - 1) : 0));
        if (ev._displaceLeft) left = Math.max(left, core);
        if (ev._displaceRight) right = Math.max(right, core);
        if (ev.arpeggio) left += 1.2;
      }
      if (ev.dur.dots) right = Math.max(right, SP.dotGap + ev.dur.dots * (SP.dotRadius * 2 + 0.35));
      // lyrics need room centred on the head
      if (ev.lyrics?.length) {
        const lw = Math.max(...ev.lyrics.map(l => textWidth(l.text || '', SP.lyricSize) + (l.syllabic === 'begin' || l.syllabic === 'middle' ? 0.6 : 0)));
        const half = lw / 2 - core / 2 + 0.25;
        if (half > 0) { left = Math.max(left, half); right = Math.max(right, half); }
      }
      slot.left = Math.max(slot.left, left); slot.core = Math.max(slot.core, core); slot.right = Math.max(slot.right, right);
      if (!isGrace) tick += durTicks(ev);
    });
  }));
  // chord symbols that fall on ticks without an event still need a slot
  (m.chords || []).forEach(ch => {
    if (!slotMap.has(ch.tick)) slotMap.set(ch.tick, { key: ch.tick, tick: ch.tick, grace: false, left: 0, core: 0, right: 0, gap: 0, events: [], virtual: true });
    const slot = slotMap.get(ch.tick);
    const cw = textWidth(ch.text || '', SP.chordSize, true) + 0.8;
    slot.right = Math.max(slot.right, cw - slot.core);
  });
  const slots = [...slotMap.values()].sort((a, b) => a.key - b.key);
  if (!slots.length) {
    slots.push({ key: 0, tick: 0, grace: false, left: 0, core: SP.headWhole, right: 0, gap: 0, events: [], empty: true });
  }
  // 2. gaps from duration to next slot
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.grace) { s.gap = 0.5; continue; }
    const next = slots.slice(i + 1).find(x => !x.grace);
    const until = (next ? next.tick : capacity) - s.tick;
    s.gap = s.empty ? 0 : spaceFor(Math.max(until, 0));
    if (s.virtual) s.gap = Math.max(1.0, spaceFor(until) * 0.6);
  }
  // 3. prefix (clef / key / time) per staff → take max widths
  const prefix = { clef: 0, key: 0, time: 0, clefs: [], keys: [], times: [] };
  const prevKey = mi > 0 ? effectiveKeySig(score, mi - 1).fifths : 0;
  const key = effectiveKeySig(score, mi);
  staves.forEach((s, si) => {
    const clef = effectiveClef(score, mi, si);
    const clefChange = !!m.staves[si]?.clef && mi > 0;
    const showClef = ctx.systemStart || clefChange;
    const cw = showClef ? (SP.clefWidth[clef] || 2.9) * (clefChange && !ctx.systemStart ? SP.smallClefScale : 1) : 0;
    prefix.clefs.push({ show: showClef, clef, small: clefChange && !ctx.systemStart, width: cw });
    prefix.clef = Math.max(prefix.clef, cw);
    const keyed = s.staff.type === 'standard';
    const showKey = keyed && (ctx.systemStart ? key.fifths !== 0 : (!!m.keySig && mi > 0));
    const kw = showKey ? keySigWidth(key.fifths, clef, m.keySig && mi > 0 ? prevKey : 0) : 0;
    prefix.keys.push({ show: showKey, fifths: key.fifths, prevFifths: m.keySig && mi > 0 ? prevKey : 0, clef, width: kw });
    prefix.key = Math.max(prefix.key, kw);
    const showTime = !!m.timeSig && (mi === 0 || !ctx.systemStart || true) && !!m.timeSig;
    const tw = showTime ? timeSigWidth(m.timeSig) : 0;
    prefix.times.push({ show: showTime, ts: m.timeSig, width: tw });
    prefix.time = Math.max(prefix.time, tw);
  });
  prefix.width = prefix.clef + prefix.key + prefix.time + (prefix.clef || prefix.key || prefix.time ? 0.6 : 0);
  const fixed = SP.measureLeftPad + prefix.width + slots.reduce((a, s) => a + s.left + s.core + s.right, 0) + SP.measureRightPad
    + (m.barlineLeft === 'repeat-start' ? 1.6 : 0) + (m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both' ? 1.2 : (m.barlineRight === 'final' || m.barlineRight === 'double') ? 0.6 : 0);
  const flex = slots.reduce((a, s) => a + s.gap, 0);
  return { slots, prefix, fixed, flex, minWidth: fixed + flex * 0.75, idealWidth: fixed + flex, capacity, timeSig: ts };
}

function restWidth(base) {
  const g = { breve: 'restDoubleWhole', whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', '128th': 'rest128th' }[base];
  return g ? GLYPHS[g].w : 1;
}

/**
 * Decide which accidentals are displayed (sets note._showAcc) and chord head displacement
 * (ev._displaceLeft/_displaceRight, note._displaced) for the whole score. Must run before metrics.
 */
export function annotateScore(score) {
  const staves = staffList(score);
  score.measures.forEach((m, mi) => {
    const key = effectiveKeySig(score, mi);
    m.staves.forEach((sm, si) => {
      const staff = staves[si]?.staff;
      const clef = effectiveClef(score, mi, si);
      // accidental state per step+octave within this measure (shared by voices on the staff)
      const state = new Map();
      // process events in tick order across voices
      const timeline = [];
      sm.voices.forEach((v, vi) => { let t = 0; v.forEach((ev, ei) => { timeline.push({ t, vi, ei, ev }); if (!ev.grace) t += durTicks(ev); }); });
      timeline.sort((a, b) => a.t - b.t || a.vi - b.vi);
      for (const { ev } of timeline) {
        if (ev.kind !== 'note') continue;
        ev.notes.sort((a, b) => (staffPosOf(a, clef, staff) - staffPosOf(b, clef, staff)) * -1); // low → high (larger pos = lower)
        for (const n of ev.notes) {
          n._showAcc = null;
          if (staff?.type !== 'standard') continue;
          const k = n.step + n.octave;
          const current = state.has(k) ? state.get(k) : keyAlterFor(n.step, key.fifths);
          const alter = n.alter || 0;
          if (n.accidental && n.accidental !== 'none') { n._showAcc = n.accidental; }
          else if (n.accidental === 'none') { n._showAcc = null; }
          else if (alter !== current) n._showAcc = alterToAcc(alter);
          else if (n.tieEnd) n._showAcc = null;
          state.set(k, alter);
        }
        // chord second-interval displacement
        ev._displaceLeft = false; ev._displaceRight = false;
        const poss = ev.notes.map(n => staffPosOf(n, clef, staff));
        for (let i = 1; i < ev.notes.length; i++) {
          ev.notes[i]._displaced = false;
          if (Math.abs(poss[i] - poss[i - 1]) === 1 && !ev.notes[i - 1]._displaced) {
            ev.notes[i]._displaced = true;
            const up = stemUpGuess(ev, poss);
            if (up) ev._displaceRight = true; else ev._displaceLeft = true;
          }
        }
        if (ev.notes[0]) ev.notes[0]._displaced = false;
      }
    });
  });
}
function keyAlterFor(step, fifths) {
  const SH = ['F', 'C', 'G', 'D', 'A', 'E', 'B'], FL = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return SH.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FL.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}
function alterToAcc(a) { return { '-2': 'double-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }[a] || 'natural'; }
export { keyAlterFor, alterToAcc };

export function staffPosOf(note, clef, staff) {
  if (staff?.type === 'percussion') {
    const dm = staff.drumMap || {};
    if (note.drum && dm[note.drum]) return dm[note.drum].line;
    if (staff.lines === 1) return 0;
  }
  if (staff?.type === 'tab') return ((note.string || 1) - 1) * 2;
  const CLEF_TOP = { treble: ['F', 5], treble8vb: ['F', 4], treble8va: ['F', 6], bass: ['A', 3], bass8vb: ['A', 2], alto: ['G', 4], tenor: ['E', 4], percussion: ['F', 5], tab: ['F', 5] };
  const [ts, to] = CLEF_TOP[clef] || CLEF_TOP.treble;
  const STEPS = 'CDEFGAB';
  return (to * 7 + STEPS.indexOf(ts)) - (note.octave * 7 + STEPS.indexOf(note.step));
}
export function stemUpGuess(ev, poss) {
  if (ev.stem) return ev.stem === 'up';
  if (!poss.length) return true;
  const avg = (Math.min(...poss) + Math.max(...poss)) / 2;
  return avg > 4;   // below middle line → stem up
}

/**
 * Break measures into systems for a given available width.
 * Returns [{ measures: [{ mi, metrics, x, width, stretch }], width, start, end }]
 */
export function breakSystems(score, availWidth, { firstIndent = 0, indent = 0 } = {}) {
  const systems = [];
  let cur = null;
  const flush = () => { if (cur && cur.measures.length) { justify(cur); systems.push(cur); } cur = null; };
  for (let mi = 0; mi < score.measures.length; mi++) {
    const m = score.measures[mi];
    if (!cur) { const ind = systems.length === 0 ? firstIndent : indent; cur = { measures: [], width: availWidth - ind, indent: ind }; }
    const metrics = measureMetrics(score, mi, { systemStart: cur.measures.length === 0 });
    const used = cur.measures.reduce((a, x) => a + x.metrics.minWidth, 0);
    if (cur.measures.length && used + metrics.minWidth > cur.width) {
      flush();
      cur = { measures: [], width: availWidth - indent, indent };
      mi--; continue;   // re-measure as system start
    }
    cur.measures.push({ mi, metrics });
    if (m.breaks?.system || m.breaks?.page) { cur.pageBreakAfter = !!m.breaks?.page; flush(); }
  }
  flush();
  return systems;
}

function justify(sys) {
  const fixed = sys.measures.reduce((a, x) => a + x.metrics.fixed, 0);
  const flex = sys.measures.reduce((a, x) => a + x.metrics.flex, 0);
  let stretch = flex > 0 ? (sys.width - fixed) / flex : 1;
  // Last system of a piece is left ragged if it is very empty — caller decides; here cap stretch
  sys.rawStretch = stretch;
  stretch = Math.max(0.75, Math.min(stretch, 2.4));
  let x = sys.indent || 0;
  for (const mm of sys.measures) {
    mm.x = x;
    mm.stretch = stretch;
    mm.width = mm.metrics.fixed + mm.metrics.flex * stretch;
    x += mm.width;
  }
  sys.usedWidth = x;
  // if the system under-fills (stretch capped), distribute leftover equally so right edge aligns
  const leftover = sys.width + (sys.indent || 0) - x;
  if (leftover > 0.01 && sys.measures.length) {
    const add = leftover / sys.measures.length; let acc = 0;
    for (const mm of sys.measures) { mm.x += acc; mm.width += add; acc += add; }
    sys.usedWidth = sys.width + (sys.indent || 0);
  }
}

/** x positions of slots inside a laid-out measure (relative to measure x). */
export function slotPositions(mm, m) {
  const { metrics, stretch } = mm;
  let x = SP.measureLeftPad + (m.barlineLeft === 'repeat-start' ? 1.6 : 0) + metrics.prefix.width;
  const out = [];
  for (const s of metrics.slots) {
    const xHead = x + s.left;
    out.push({ slot: s, x: xHead, left: x, right: xHead + s.core + s.right, tick: s.tick, grace: s.grace });
    x = xHead + s.core + s.right + s.gap * stretch;
  }
  return out;
}

// Beam grouping ---------------------------------------------------------------
export function beamCount(base) { return { eighth: 1, '16th': 2, '32nd': 3, '64th': 4, '128th': 5 }[base] || 0; }

/** Returns array of groups; each group is an array of event indices within the voice. */
export function autoBeamGroups(voice, timeSig) {
  const beat = beatTicks(timeSig);
  const groups = [];
  let cur = null; let tick = 0;
  const flush = () => { if (cur && cur.idx.length > 1) groups.push(cur.idx); cur = null; };
  voice.forEach((ev, i) => {
    const bc = beamCount(ev.dur.base);
    const beamable = bc > 0 && !ev.grace && ev.kind === 'note';
    const manual = ev.beam;
    if (manual === 'begin') { flush(); cur = { start: tick, idx: [i], manual: true }; }
    else if (manual === 'continue' || manual === 'end') { if (cur) cur.idx.push(i); else cur = { start: tick, idx: [i], manual: true }; if (manual === 'end') flush(); }
    else if (manual === 'none' || !beamable) { flush(); }
    else {
      const beatIdx = Math.floor((tick + 1e-6) / beat);
      if (cur && !cur.manual && Math.floor((cur.start + 1e-6) / beat) === beatIdx && cur.tupletId === (ev.tuplet?.id || null)) cur.idx.push(i);
      else { flush(); cur = { start: tick, idx: [i], tupletId: ev.tuplet?.id || null }; }
    }
    if (!ev.grace) tick += durTicks(ev);
  });
  flush();
  // merge adjacent all-eighth groups into half-bar groups in simple duple/quadruple time
  if (timeSig.den === 4 && timeSig.num % 2 === 0) {
    const merged = [];
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      const allEighth = idx => idx.every(i => voice[i].dur.base === 'eighth' && !voice[i].dur.dots && !voice[i].tuplet);
      if (prev && allEighth(prev) && allEighth(g) && prev[prev.length - 1] + 1 === g[0]) {
        const startTick = tickOf(voice, prev[0]);
        if (Math.floor(startTick / 1920) === Math.floor(tickOf(voice, g[0]) / 1920)) { prev.push(...g); continue; }
      }
      merged.push(g);
    }
    return merged;
  }
  return groups;
}
function tickOf(voice, idx) { let t = 0; for (let i = 0; i < idx; i++) if (!voice[i].grace) t += durTicks(voice[i]); return t; }
export function beatTicks(ts) {
  if (ts.den === 8 && ts.num % 3 === 0 && ts.num > 3) return 1440;
  if (ts.den === 8 && ts.num === 3) return 1440;
  if (ts.den === 2) return 1920;
  if (ts.den === 16) return 480;
  if (ts.den === 8) return 480;
  return 960;
}
