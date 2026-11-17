// JSE — MuseScore (.mscz / .mscx) import and export.
//
// A .mscz file is a ZIP archive holding one MuseScore XML document (`<name>.mscx`, root
// element <museScore version="…">) plus, since MuseScore 4, the style in `score_style.mss`.
// A .mscx file is that XML document on its own. This module converts both ways between
// the MuseScore document and a ScoreDoc (SPEC §2).
//
// Import: file formats 2.0x (MuseScore 2), 3.0x (MuseScore 3) and 4.x (MuseScore 4 / Studio);
// the development format 5.00 is read as well. MuseScore 1.x files are rejected with an
// explanation. Export: format 3.02 (MuseScore 3.6), which MuseScore 3 and 4 both open.
//
// The reader is driven by the structure it finds rather than by the version number, because
// the dialects overlap (early 3.0 files still use the 2.x layout):
//   * "voice" layout (3.x+): <Measure><voice>…</voice><voice>…</voice></Measure>, tuplets as
//     <Tuplet>…<endTuplet/>, spanners as <Spanner type=…> with relative <location>s
//   * "flat" layout (2.x): chords are direct children of <Measure>, other voices carry <track>
//     and are positioned with absolute <tick>s, tuplets/slurs/beams are referenced by id
//   * 5.00: spanners live in <SpannerMap> and point at elements by <eid>
//
// Everything that cannot be represented is skipped or approximated and listed (in Korean)
// in `score.importInfo.warnings`. Pure JS: runs in the browser, in workers and in Node.
//
// MuseScore is GPL software; this file is an independent implementation written from the
// file format as observed in MuseScore-written files. tools/mscz/README.md has the notes.

import { parseXML, normalizeImported } from './musicxml.js';
import {
  newId, DUR_TICKS, durTicks, voiceTicks, ticksToDurations, makeRest, validateScore, midiOf, createScore, createPart,
  INSTRUMENTS, DEFAULT_DRUM_MAP, noteAtStaffPosition, staffPosition, noteFromMidi, measureCapacity,
} from '../model/score.js';

export const MSCZ_EXTENSIONS = ['.mscz', '.mscx'];

const WHOLE = 3840;                                   // JSE ticks per whole note
const EPS = 0.5;                                      // tick tolerance when comparing positions

// =================================================================================
// 1. Small helpers
// =================================================================================
const kids = (n, tag) => (n ? n.children.filter(c => c.tag === tag) : []);
const kid = (n, tag) => (n ? n.children.find(c => c.tag === tag) : undefined);
const has = (n, tag) => !!kid(n, tag);
const txt = (n, tag) => { const c = tag == null ? n : kid(n, tag); return c ? c.text.trim() : undefined; };
const int = (n, tag, def = 0) => { const t = txt(n, tag); if (t == null || t === '') return def; const v = parseInt(t, 10); return Number.isFinite(v) ? v : def; };
const num = (n, tag, def = 0) => { const t = txt(n, tag); if (t == null || t === '') return def; const v = parseFloat(t); return Number.isFinite(v) ? v : def; };
/** <flag/>, <flag>1</flag>, <flag>true</flag> → true */
const flag = (n, tag) => { const c = kid(n, tag); if (!c) return false; const t = c.text.trim(); return t === '' || (t !== '0' && t !== 'false'); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;
const round4 = v => Math.round(v * 10000) / 10000;
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; }
function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  return new Uint8Array(data || 0);
}
/** "3/4" → ticks (whole = 3840); also accepts <duration z="3" n="4"/> nodes. */
function fracTicks(s) {
  if (s == null) return NaN;
  const m = /^\s*(-?\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (m) return +m[2] ? (+m[1] * WHOLE) / +m[2] : NaN;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v * WHOLE : NaN;
}
function durationNodeTicks(node) {
  if (!node) return NaN;
  if (node.attrs.z != null && node.attrs.n != null) return +node.attrs.n ? (+node.attrs.z * WHOLE) / +node.attrs.n : NaN;
  return fracTicks(node.text);
}

// ---------- text: inline markup ----------
// MuseScore texts carry inline markup (<b>, <i>, <font face=…/>, <sym>name</sym>, <br/>). The
// shared XML parser keeps child elements and text apart, which would lose their order, so the
// markup is turned into control characters (never valid in XML) before parsing.
const T_SYM = '\u0001', T_SYM_END = '\u0002', T_I = '\u0003', T_I_END = '\u0004', T_B = '\u0005', T_B_END = '\u0006';
const INLINE_RE = /<(\/?)(b|i|u|s|sub|sup)>|<font\b[^>]*>|<\/font>|<br\s*\/?>|<sym>([^<]*)<\/sym>/g;
function prepareSource(src) {
  if (typeof src !== 'string') src = new TextDecoder('utf-8').decode(toU8(src));
  return src.replace(INLINE_RE, (m, close, tag, sym) => {
    if (sym != null) return T_SYM + sym + T_SYM_END;
    if (tag === 'i') return close ? T_I_END : T_I;
    if (tag === 'b') return close ? T_B_END : T_B;
    if (m.startsWith('<br')) return '\n';
    return '';
  });
}
const NOTE_SYMS = {
  metNoteDoubleWhole: 'breve', metNoteWhole: 'whole', metNoteHalfUp: 'half', metNoteHalfDown: 'half', metNoteQuarterUp: 'quarter',
  metNoteQuarterDown: 'quarter', metNote8thUp: 'eighth', metNote8thDown: 'eighth', metNote16thUp: '16th', metNote16thDown: '16th',
  metNote32ndUp: '32nd', metNote32ndDown: '32nd',
  noteDoubleWhole: 'breve', noteWhole: 'whole', noteHalfUp: 'half', noteHalfDown: 'half', noteQuarterUp: 'quarter', noteQuarterDown: 'quarter',
  note8thUp: 'eighth', note8thDown: 'eighth', note16thUp: '16th', note16thDown: '16th', note32ndUp: '32nd',
  unicodeNoteDoubleWhole: 'breve', unicodeNoteWhole: 'whole', unicodeNoteHalfUp: 'half', unicodeNoteQuarterUp: 'quarter',
  unicodeNote8thUp: 'eighth', unicodeNote16thUp: '16th', unicodeNote32ndUp: '32nd',
};
const DOT_SYMS = new Set(['metAugmentationDot', 'augmentationDot', 'unicodeAugmentationDot']);
// characters that stand for a note value / augmentation dot in tempo texts
const NOTE_CHARS = { '♩': 'quarter', '♪': 'eighth', '\u{1D15C}': 'breve', '\u{1D15D}': 'whole', '\u{1D15E}': 'half', '\u{1D15F}': 'quarter',
  '\u{1D160}': 'eighth', '\u{1D161}': '16th', '\u{1D162}': '32nd', '': 'breve', '': 'whole', '': 'half', '': 'half',
  '': 'quarter', '': 'quarter', '': 'eighth', '': 'eighth', '': '16th', '': '16th', '': '32nd',
  '': 'breve', '': 'whole', '': 'half', '': 'half', '': 'quarter', '': 'quarter', '': 'eighth',
  '': 'eighth', '': '16th', '': '16th', '': '32nd' };
const DOT_CHARS = new Set(['\u{1D16D}', '', '']);
const NOTE_GLYPH = { breve: '\u{1D15C}', whole: '\u{1D15D}', half: '\u{1D15E}', quarter: '♩', eighth: '♪', '16th': '\u{1D161}', '32nd': '\u{1D162}' };
const SYM_TEXT = {
  segno: '\u{1D10B}', segnoSerpent1: '\u{1D10B}', segnoSerpent2: '\u{1D10B}', coda: '\u{1D10C}', codaSquare: '\u{1D10C}',
  dynamicPiano: 'p', dynamicMezzo: 'm', dynamicForte: 'f', dynamicRinforzando: 'r', dynamicSforzando: 's', dynamicZ: 'z', dynamicNiente: 'n',
  dynamicPPPPPP: 'pppppp', dynamicPPPPP: 'ppppp', dynamicPPPP: 'pppp', dynamicPPP: 'ppp', dynamicPP: 'pp', dynamicMP: 'mp', dynamicMF: 'mf',
  dynamicPF: 'pf', dynamicFF: 'ff', dynamicFFF: 'fff', dynamicFFFF: 'ffff', dynamicFFFFF: 'fffff', dynamicFFFFFF: 'ffffff',
  dynamicFortePiano: 'fp', dynamicForzando: 'fz', dynamicSforzando1: 'sf', dynamicSforzandoPiano: 'sfp', dynamicSforzandoPianissimo: 'sfpp',
  dynamicSforzato: 'sfz', dynamicSforzatoPiano: 'sfzp', dynamicSforzatoFF: 'sffz', dynamicRinforzando1: 'rf', dynamicRinforzando2: 'rfz',
  accidentalFlat: '♭', accidentalSharp: '♯', accidentalNatural: '♮', csymAccidentalFlat: '♭', csymAccidentalSharp: '♯',
  csymAccidentalNatural: '♮', accidentalDoubleSharp: '\u{1D12A}', accidentalDoubleFlat: '\u{1D12B}',
  keyboardPedalPed: 'Ped.', keyboardPedalUp: '*', lyricsElision: '‿', lyricsElisionNarrow: '‿', lyricsElisionWide: '‿',
  space: ' ',
};
// SMuFL code points that occur as plain characters in texts (music text fonts): dynamics, segno, coda, pedal
const PUA_TEXT = { 0xE520: 'p', 0xE521: 'm', 0xE522: 'f', 0xE523: 'r', 0xE524: 's', 0xE525: 'z', 0xE526: 'n', 0xE527: 'pppppp', 0xE528: 'ppppp', 0xE529: 'pppp',
  0xE52A: 'ppp', 0xE52B: 'pp', 0xE52C: 'mp', 0xE52D: 'mf', 0xE52E: 'pf', 0xE52F: 'ff', 0xE530: 'fff', 0xE531: 'ffff', 0xE532: 'fffff', 0xE533: 'ffffff', 0xE534: 'fp',
  0xE535: 'fz', 0xE536: 'sf', 0xE537: 'sfp', 0xE538: 'sfpp', 0xE539: 'sfz', 0xE53A: 'sfzp', 0xE53B: 'sffz', 0xE53C: 'rf', 0xE53D: 'rfz', 0xE047: '\u{1D10B}',
  0xE048: '\u{1D10C}', 0xE650: 'Ped.', 0xE655: '*', 0xE260: '\u266D', 0xE261: '\u266E', 0xE262: '\u266F',
  0xE550: '\u203F', 0xE551: '\u203F', 0xE552: '\u203F',                  // lyric elision (two syllables on one note) \u2192 undertie
  0xEA8F: '[', 0xEA90: ']', 0xEA91: '(', 0xEA92: ')' };                  // brackets around editorial dynamics
/** Raw element text (with markup tokens) → plain text. */
function plainOf(raw) {
  if (!raw) return '';
  if (raw.includes('<')) raw = prepareSource(raw);      // line texts (<beginText>) store their markup escaped
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === T_SYM) {
      const e = raw.indexOf(T_SYM_END, i);
      const name = raw.slice(i + 1, e < 0 ? raw.length : e);
      out += NOTE_SYMS[name] ? NOTE_GLYPH[NOTE_SYMS[name]] || '' : DOT_SYMS.has(name) ? '.' : SYM_TEXT[name] || '';
      i = e < 0 ? raw.length : e;
    } else if (ch >= T_I && ch <= T_B_END) { /* style marker */ } else {
      const cp = ch.charCodeAt(0);
      if (cp >= 0xE000 && cp <= 0xF8FF) out += PUA_TEXT[cp] || (NOTE_CHARS[ch] ? NOTE_GLYPH[NOTE_CHARS[ch]] : '');      // other glyphs of a music font: no text equivalent
      else out += ch;
    }
  }
  return out;
}
/** Plain single-line text of a child element (`tag` omitted = the node itself). */
function textOf(node, tag) {
  const c = tag == null ? node : kid(node, tag);
  if (!c) return '';
  let raw = c.text;
  const html = kid(c, 'html') || kid(c, 'html-data');
  if (html) raw = deepText(kid(html, 'body') || kid(kid(html, 'html'), 'body') || html);
  return plainOf(raw).replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
function deepText(node) { return node ? node.text + node.children.map(deepText).join(' ') : ''; }
const isItalic = raw => !!raw && raw.includes(T_I) && plainOf(raw.split(T_I)[0]).trim() === '';
const isBold = raw => !!raw && raw.includes(T_B) && plainOf(raw.split(T_B)[0]).trim() === '' && plainOf(raw.slice(raw.lastIndexOf(T_B_END) + 1)).trim() === '';

// =================================================================================
// 2. Vocabulary tables (MuseScore names ↔ ScoreDoc names)
// =================================================================================
const DUR_IN = { long: 'breve', breve: 'breve', whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', '16th': '16th',
  '32nd': '32nd', '64th': '64th', '128th': '128th', '256th': '128th', '512th': '128th', '1024th': '128th' };
const CLEF_IN = {
  G: 'treble', G1: 'treble', G8vbp: 'treble', C_19C: 'treble', G8vb: 'treble8vb', G8vbo: 'treble8vb', G15mb: 'treble8vb', G8va: 'treble8va',
  G15ma: 'treble8va', F: 'bass', F3: 'bass', F5: 'bass', F_F18C: 'bass', F_19C: 'bass', F8va: 'bass', F15ma: 'bass', F8vb: 'bass8vb',
  F15mb: 'bass8vb', C1: 'alto', C2: 'alto', C3: 'alto', C1_F18C: 'alto', C3_F18C: 'alto', C1_F20C: 'alto', C3_F20C: 'alto', C4: 'tenor',
  C5: 'tenor', C4_F18C: 'tenor', C4_F20C: 'tenor', C4_8VB: 'tenor', PERC: 'percussion', PERC2: 'percussion', TAB: 'tab', TAB4: 'tab',
  TAB2: 'tab', TAB_SERIF: 'tab', TAB4_SERIF: 'tab',
};
const CLEF_APPROX = new Set(['G1', 'C1', 'C2', 'C5', 'F3', 'F5', 'G15mb', 'G15ma', 'F8va', 'F15ma', 'F15mb', 'C1_F18C', 'C1_F20C', 'C4_8VB']);
const CLEF_OUT = { treble: 'G', treble8vb: 'G8vb', treble8va: 'G8va', bass: 'F', bass8vb: 'F8vb', alto: 'C3', tenor: 'C4', percussion: 'PERC', tab: 'TAB' };
// articulation / ornament names of every dialect → [field, value…]
const ARTIC_IN = {
  staccato: ['art', 'staccato'], sforzato: ['art', 'accent'], tenuto: ['art', 'tenuto'], marcato: ['art', 'marcato'], portato: ['art', 'tenuto-staccato'],
  staccatissimo: ['art', 'staccatissimo'], espressivo: ['art', 'accent'],
  articStaccato: ['art', 'staccato'], articAccent: ['art', 'accent'], articTenuto: ['art', 'tenuto'], articMarcato: ['art', 'marcato'],
  articStaccatissimo: ['art', 'staccatissimo'], articStaccatissimoWedge: ['art', 'staccatissimo'], articStaccatissimoStroke: ['art', 'staccatissimo'],
  articTenutoStaccato: ['art', 'tenuto-staccato'], articAccentStaccato: ['art', 'accent-staccato'], articMarcatoStaccato: ['art', 'marcato-staccato'],
  articMarcatoTenuto: ['art', 'marcato', 'tenuto'], articTenutoAccent: ['art', 'accent', 'tenuto'], articSoftAccent: ['art', 'accent'],
  articSoftAccentStaccato: ['art', 'accent-staccato'], articSoftAccentTenuto: ['art', 'accent', 'tenuto'],
  articSoftAccentTenutoStaccato: ['art', 'accent', 'tenuto-staccato'], articStress: ['art', 'accent'],
  fermata: ['fermata'], shortfermata: ['fermata'], longfermata: ['fermata'], verylongfermata: ['fermata'],
  fermataAbove: ['fermata', 'above'], fermataBelow: ['fermata', 'below'], fermataShortAbove: ['fermata', 'above'], fermataShortBelow: ['fermata', 'below'],
  fermataLongAbove: ['fermata', 'above'], fermataLongBelow: ['fermata', 'below'], fermataVeryLongAbove: ['fermata', 'above'],
  fermataVeryLongBelow: ['fermata', 'below'], fermataVeryShortAbove: ['fermata', 'above'], fermataVeryShortBelow: ['fermata', 'below'],
  fermataShortHenzeAbove: ['fermata', 'above'], fermataShortHenzeBelow: ['fermata', 'below'], fermataLongHenzeAbove: ['fermata', 'above'],
  fermataLongHenzeBelow: ['fermata', 'below'],
  trill: ['orn', 'trill'], turn: ['orn', 'turn'], reverseturn: ['orn', 'inverted-turn'], mordent: ['orn', 'mordent'], prall: ['orn', 'inverted-mordent'],
  prallprall: ['orn~', 'inverted-mordent'], upprall: ['orn~', 'inverted-mordent'], downprall: ['orn~', 'inverted-mordent'], prallmordent: ['orn~', 'mordent'],
  upmordent: ['orn~', 'mordent'], downmordent: ['orn~', 'mordent'], lineprall: ['orn~', 'inverted-mordent'], pralldown: ['orn~', 'inverted-mordent'],
  prallup: ['orn~', 'inverted-mordent'],
  ornamentTrill: ['orn', 'trill'], ornamentTurn: ['orn', 'turn'], ornamentTurnInverted: ['orn', 'inverted-turn'], ornamentTurnSlash: ['orn', 'inverted-turn'],
  ornamentMordent: ['orn', 'mordent'], ornamentMordentInverted: ['orn', 'inverted-mordent'], ornamentShortTrill: ['orn', 'inverted-mordent'],
  ornamentTremblement: ['orn~', 'inverted-mordent'], ornamentPrallMordent: ['orn~', 'mordent'], ornamentUpPrall: ['orn~', 'inverted-mordent'],
  ornamentDownPrall: ['orn~', 'inverted-mordent'], ornamentUpMordent: ['orn~', 'mordent'], ornamentDownMordent: ['orn~', 'mordent'],
  ornamentLinePrall: ['orn~', 'inverted-mordent'], ornamentPrallDown: ['orn~', 'inverted-mordent'], ornamentPrallUp: ['orn~', 'inverted-mordent'],
  ornamentPrecompMordentUpperPrefix: ['orn~', 'inverted-mordent'],
};
const DYN_IN = { ppp: 'ppp', pp: 'pp', p: 'p', mp: 'mp', mf: 'mf', f: 'f', ff: 'ff', fff: 'fff', sfz: 'sfz', sfp: 'sfp', fp: 'fp', fz: 'fz', rfz: 'rfz',
  pppp: 'ppp', ppppp: 'ppp', pppppp: 'ppp', ffff: 'fff', fffff: 'fff', ffffff: 'fff', sf: 'sfz', sff: 'sfz', sffz: 'sfz', sfpp: 'sfp', sfzp: 'sfp',
  rf: 'rfz', pf: 'fp' };
const DYN_VELOCITY = { ppp: 16, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 126, sfz: 112, sfp: 112, fp: 96, fz: 112, rfz: 112 };
const HEAD_NUM = ['normal', 'cross', 'diamond', 'triangle-down', 'mi', 'slash', 'xcircle', 'do', 're', 'fa', 'la', 'ti', 'sol', 'altbrevis'];
/** MuseScore notehead group → NoteheadStyle (hollow shapes for half notes and longer). */
function headFrom(group, base) {
  if (group == null || group === '') return null;
  if (/^\d+$/.test(group)) group = HEAD_NUM[+group] || 'normal';
  const open = base ? DUR_TICKS[base] >= DUR_TICKS.half : false;
  switch (group) {
    case 'cross': case 'heavy-cross': case 'heavy-cross-hat': return 'x';
    case 'xcircle': case 'withx': return 'circle-x';
    case 'plus': return 'plus';
    case 'diamond': case 'diamond-old': return open ? 'diamond' : 'diamond-black';
    case 'triangle-up': case 'triangle-down': case 'triangle': return open ? 'triangle' : 'triangle-black';
    case 'slash': case 'slashed1': case 'slashed2': return 'slash';
    default: return null;
  }
}
const HEAD_OUT = { x: 'cross', 'circle-x': 'xcircle', plus: 'plus', diamond: 'diamond', 'diamond-black': 'diamond', triangle: 'triangle-up',
  'triangle-black': 'triangle-up', slash: 'slash', square: 'la' };
const ACC_IN = { sharp: 'sharp', flat: 'flat', natural: 'natural', 'double sharp': 'double-sharp', 'double flat': 'double-flat',
  accidentalSharp: 'sharp', accidentalFlat: 'flat', accidentalNatural: 'natural', accidentalDoubleSharp: 'double-sharp',
  accidentalDoubleFlat: 'double-flat', accidentalNaturalSharp: 'sharp', accidentalNaturalFlat: 'flat' };
const ACC_OUT = { sharp: 'accidentalSharp', flat: 'accidentalFlat', natural: 'accidentalNatural', 'double-sharp': 'accidentalDoubleSharp',
  'double-flat': 'accidentalDoubleFlat' };
const SPANNER_TAGS = new Set(['Slur', 'HairPin', 'Ottava', 'Pedal', 'Trill', 'Volta', 'TextLine', 'Glissando', 'Tie', 'GradualTempoChange',
  'LetRing', 'PalmMute', 'Vibrato', 'GuitarBend', 'HammerOnPullOff', 'NoteLine', 'PartialLyricsLine', 'WhammyBar', 'Rasgueado', 'HarmonicMark', 'PickScrape']);
// default text faces / sizes of MuseScore itself — they do not count as a user choice
const DEFAULT_FACES = /^(freeserif|freesans|edwin|leland text|leland|musejazz text|musejazz|mscore text|mscore1|mscore|mscoretab|scoretext|bravura text|bravura|emmentaler text|emmentaler|gonville text|gonville|petaluma text|petaluma script|petaluma|finale maestro text|finale broadway text|campania|times new roman|arial)$/i;
// ScoreDoc text style key → [3.x/4.x style prefix, 2.x text style name, default sizes (pt)]
const TEXT_STYLE_MAP = {
  title: ['title', 'Title', [24, 22]], subtitle: ['subTitle', 'Subtitle', [14, 16]], composer: ['composer', 'Composer', [12, 10]],
  lyricist: ['lyricist', 'Lyricist', [12, 10]], lyrics: ['lyricsOdd', 'Lyrics Odd Lines', [11, 10]], chord: ['chordSymbolA', 'Chord Symbol', [12, 10, 15]],
  text: ['staffText', 'Staff', [10]], tempo: ['tempo', 'Tempo', [12]], rehearsal: ['rehearsalMark', 'Rehearsal Mark', [14]],
  partName: ['longInstrument', 'Instrument Name (Long)', [12, 10]], measureNumber: ['measureNumber', 'Measure Number', [8]],
};
const PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420], B5: [176, 250] };
const MM_PER_INCH = 25.4, MM_PER_PT = 0.3528;

// ---------- pitch spelling ----------
// MuseScore spells with a "tonal pitch class": position on the line of fifths, F♭♭ = -1 … C = 14 … B♯♯ = 33.
const TPC_STEPS = 'FCGDAEB';
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const tpcStep = tpc => TPC_STEPS[(((tpc + 1) % 7) + 7) % 7];
const tpcAlter = tpc => Math.floor((tpc + 1) / 7) - 2;
const tpcOf = (step, alter) => TPC_STEPS.indexOf(step) - 1 + ((alter || 0) + 2) * 7;
/** Fifths moved by an interval of `diatonic` steps and `chromatic` semitones (M2 = +2, P5 = +1, m3 = -3). */
const intervalFifths = (diatonic, chromatic) => 7 * chromatic - 12 * diatonic;
function noteFromPitchTpc(pitch, tpc) {
  if (Number.isFinite(tpc) && tpc >= -1 && tpc <= 33) {
    const step = tpcStep(tpc), alter = tpcAlter(tpc);
    const natural = pitch - alter;
    if ((((natural % 12) + 12) % 12) === STEP_PC[step]) return { step, octave: Math.floor(natural / 12) - 1, alter };
  }
  return noteFromMidi(pitch, 0);          // inconsistent spelling in the file: fall back to the pitch
}
function wrapFifths(f) { while (f > 7) f -= 12; while (f < -7) f += 12; return f; }
/** Diatonic step count that belongs to a chromatic transposition when the file gives none. */
function diatonicFor(chromatic) {
  const oct = Math.trunc(chromatic / 12), rem = chromatic - oct * 12;
  const table = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6 };
  return oct * 7 + (rem < 0 ? -table[-rem] : table[rem]);
}
const midiName = m => { const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']; return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };
function nameMidi(s) {
  const m = /^([A-G])(#{1,2}|b{1,2}|x)?(-?\d)$/.exec(s || ''); if (!m) return 40;
  return (parseInt(m[3], 10) + 1) * 12 + STEP_PC[m[1]] + ({ '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[m[2]] || 0);
}

// =================================================================================
// 3. Container
// =================================================================================
/** True for MuseScore XML (text or bytes containing a <museScore> root). */
export function looksLikeMscx(input) {
  if (input == null) return false;
  let head;
  if (typeof input === 'string') head = input.slice(0, 4096);
  else { const u8 = toU8(input); if (u8[0] === 0x50 && u8[1] === 0x4b) return false; head = new TextDecoder('utf-8').decode(u8.subarray(0, 4096)); }
  return /<museScore[\s>]/.test(head);
}

/** .mscz (zip) or .mscx (plain XML) bytes → ScoreDoc. */
export async function importMscz(data, { JSZip: Z = globalThis.JSZip, fileName } = {}) {
  if (typeof data === 'string') return importMscx(data, { fileName });
  const u8 = toU8(data);
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) {
    const text = new TextDecoder('utf-8').decode(u8);
    if (!looksLikeMscx(text)) throw new Error('MuseScore 파일이 아닙니다 (.mscz 또는 .mscx 파일을 선택해 주세요)');
    return importMscx(text, { fileName });
  }
  if (!Z) throw new Error('JSZip가 필요합니다 (globalThis.JSZip 또는 옵션으로 주입)');
  let zip;
  try { zip = await Z.loadAsync(u8); } catch (_) { throw new Error('MuseScore 파일을 읽을 수 없습니다 (압축이 손상되었습니다)'); }
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  // the score is the top-level .mscx named by META-INF/container.xml; linked parts live under Excerpts/
  let path = null;
  const container = zip.file('META-INF/container.xml');
  if (container) {
    try {
      const c = parseXML(await container.async('string'));
      const rfs = kids(kid(kid(c, 'container'), 'rootfiles'), 'rootfile').map(r => r.attrs['full-path']).filter(Boolean);
      path = rfs.find(p => /\.mscx$/i.test(p) && !/^Excerpts\//i.test(p) && zip.file(p)) || null;
    } catch (_) { path = null; }
  }
  if (!path) path = names.find(n => /\.mscx$/i.test(n) && !n.includes('/')) || names.find(n => /\.mscx$/i.test(n) && !/^Excerpts\//i.test(n));
  if (!path) {
    if (names.some(n => /\.(xml|musicxml)$/i.test(n) && !/^META-INF\//.test(n))) throw new Error('MuseScore 파일이 아닙니다 (MusicXML 압축 파일로 보입니다 — 확장자를 .mxl로 바꿔 열어 주세요)');
    throw new Error('MuseScore 파일 안에 악보(.mscx)가 없습니다');
  }
  const xml = await zip.file(path).async('string');
  const styleFile = zip.file('score_style.mss') || zip.file(path.replace(/[^/]*$/, 'score_style.mss'));
  const styleXml = styleFile ? await styleFile.async('string') : null;
  return importMscx(xml, { fileName: fileName || path, styleXml });
}

// =================================================================================
// 4. Import
// =================================================================================
/** MuseScore XML text → ScoreDoc. `styleXml` = the separate style file of MuseScore 4 archives. */
export function importMscx(xmlText, { fileName, styleXml } = {}) {
  const doc = parseXML(prepareSource(xmlText));
  const ms = kid(doc, 'museScore');
  if (!ms) throw new Error('MuseScore 문서가 아닙니다 (museScore 요소가 없습니다)');
  const version = ms.attrs.version || '';
  const vnum = parseFloat(version) || 0;
  if (vnum && vnum < 2) throw new Error(`MuseScore 1.x 형식(${version})은 열 수 없습니다. MuseScore 2 이상에서 열어 다시 저장하거나 MusicXML로 내보낸 뒤 열어 주세요.`);
  const scoreEl = kid(ms, 'Score');
  if (!scoreEl) throw new Error('MuseScore 파일에 악보 내용(Score)이 없습니다');
  const imp = new Importer(ms, scoreEl, { version, vnum, fileName, styleXml });
  return imp.run();
}

class Importer {
  constructor(ms, scoreEl, opts) {
    this.ms = ms; this.root = scoreEl; this.version = opts.version; this.vnum = opts.vnum; this.fileName = opts.fileName || '';
    this.warnings = new Set();
    this.skipped = new Map();                         // unsupported element → count
    this.tupUnit = new Map();                         // tuplet id → the note value (ticks) its ratio counts
    this.styleEl = kid(scoreEl, 'Style');
    if (!this.styleEl && opts.styleXml) {
      try { const s = parseXML(prepareSource(opts.styleXml)); this.styleEl = kid(kid(s, 'museScore'), 'Style') || kid(s, 'Style'); } catch (_) { /* ignore a broken style file */ }
    }
    this.division = int(scoreEl, 'Division', 480) || 480;
    this.tickScale = 960 / this.division;             // file ticks → JSE ticks
    this.concertPitch = this.styleEl ? flag(this.styleEl, 'concertPitch') : false;
  }
  warn(w) { this.warnings.add(w); }
  skip(tag) { this.skipped.set(tag, (this.skipped.get(tag) || 0) + 1); }

  run() {
    const score = createScore({ title: '', instruments: [], measures: 0, tempo: 0 });
    this.score = score;
    score.parts = []; score.measures = []; score.spanners = [];
    if (this.vnum >= 5) this.warn(`개발 중인 MuseScore 형식(${this.version})입니다 — 일부 내용이 빠질 수 있습니다`);
    this.readSettings();
    this.readParts();
    this.collectMeasures();
    this.readMeta();
    this.readTimeline();
    for (let g = 0; g < this.staves.length; g++) this.readStaff(g);
    this.resolveSpanners();
    this.applyKeys();
    this.applyClefs();
    this.finishMeasures();
    this.finish();
    return score;
  }

  // ---------------------------------------------------------------------------
  // 4.1 settings (page, staff size, text styles)
  // ---------------------------------------------------------------------------
  readSettings() {
    const st = this.styleEl, s = this.score.settings;
    if (!st) return;
    const sp = num(st, 'Spatium', NaN);
    if (sp > 0.5 && sp < 5) s.staffSpaceMm = round4(sp);
    let w = NaN, h = NaN, margins = null;
    const pl = kid(st, 'page-layout');
    if (pl) {                                        // 2.x: units of 1/144 inch
      const U = MM_PER_INCH / 144;
      w = num(pl, 'page-width', NaN) * U; h = num(pl, 'page-height', NaN) * U;
      const pms = kids(pl, 'page-margins');
      const pm = pms.find(m => m.attrs.type === 'odd') || pms.find(m => m.attrs.type === 'both') || pms[0];
      if (pm) margins = { top: num(pm, 'top-margin', 0) * U, bottom: num(pm, 'bottom-margin', 0) * U, left: num(pm, 'left-margin', 0) * U, right: num(pm, 'right-margin', 0) * U };
    } else if (has(st, 'pageWidth') || has(st, 'pageHeight') || has(st, 'pagePrintableWidth') || has(st, 'pageOddLeftMargin')) {
      // 3.x+: inches; 3.x files only store what differs from the defaults (A4, 10 mm margins, 20 mm at the bottom; 15 mm since 3.6/4)
      const old = this.vnum < 3.02 || (this.vnum < 4 && !/^3\.6/.test(txt(this.ms, 'programVersion') || '3.6'));
      const dm = old ? 10 : 15;
      w = num(st, 'pageWidth', 210 / MM_PER_INCH) * MM_PER_INCH; h = num(st, 'pageHeight', 297 / MM_PER_INCH) * MM_PER_INCH;
      const left = num(st, 'pageOddLeftMargin', dm / MM_PER_INCH) * MM_PER_INCH;
      const printable = num(st, 'pagePrintableWidth', (w - 2 * dm) / MM_PER_INCH) * MM_PER_INCH;
      margins = { left, right: Math.max(0, w - printable - left), top: num(st, 'pageOddTopMargin', dm / MM_PER_INCH) * MM_PER_INCH,
        bottom: num(st, 'pageOddBottomMargin', (old ? 20 : dm) / MM_PER_INCH) * MM_PER_INCH };
    }
    if (w > 50 && h > 50) {
      s.pageWidthMm = round2(w); s.pageHeightMm = round2(h);
      s.orientation = w > h ? 'landscape' : 'portrait';
      const lo = Math.min(w, h), hi = Math.max(w, h);
      s.pageSize = (Object.entries(PAGE_SIZES).find(([, [a, b]]) => Math.abs(lo - a) < 1.5 && Math.abs(hi - b) < 1.5) || ['custom'])[0];
    }
    if (margins) s.marginsMm = { top: round2(clamp(margins.top, 0, 80)), bottom: round2(clamp(margins.bottom, 0, 80)), left: round2(clamp(margins.left, 0, 80)), right: round2(clamp(margins.right, 0, 80)) };
    if (has(st, 'staffDistance')) s.staffGapSp = round2(clamp(num(st, 'staffDistance', 7), 2, 30));
    if (has(st, 'minSystemDistance')) s.systemGapSp = round2(clamp(num(st, 'minSystemDistance', 9), 2, 40));
    if (has(st, 'showMeasureNumber') || has(st, 'measureNumberSystem') || has(st, 'measureNumberInterval')) {
      if (has(st, 'showMeasureNumber') && !flag(st, 'showMeasureNumber')) s.measureNumbers = 'none';
      else if (has(st, 'measureNumberSystem') && !flag(st, 'measureNumberSystem') && int(st, 'measureNumberInterval', 5) === 1) s.measureNumbers = 'all';
    }
    this.readTextStyles(st, s);
  }

  /** score.settings.textStyles — only what the file changes away from MuseScore's own defaults. */
  readTextStyles(st, s) {
    const out = {};
    const spMm = s.staffSpaceMm || 1.75;
    const old = new Map();                           // 2.x: <TextStyle><name>Title</name>…
    for (const ts of kids(st, 'TextStyle')) { const n = txt(ts, 'name'); if (n) old.set(n, ts); }
    for (const [key, [prefix, oldName, defSizes]] of Object.entries(TEXT_STYLE_MAP)) {
      let family, size, bold, italic;
      const o = old.get(oldName);
      if (o) { family = txt(o, 'family'); size = num(o, 'size', NaN); if (has(o, 'bold')) bold = flag(o, 'bold'); if (has(o, 'italic')) italic = flag(o, 'italic'); }
      if (has(st, prefix + 'FontFace')) family = txt(st, prefix + 'FontFace');
      if (has(st, prefix + 'FontSize')) size = num(st, prefix + 'FontSize', NaN);
      if (has(st, prefix + 'FontStyle')) { const bits = int(st, prefix + 'FontStyle', 0); bold = !!(bits & 1); italic = !!(bits & 2); }
      if (has(st, prefix + 'FontBold')) bold = flag(st, prefix + 'FontBold');
      if (has(st, prefix + 'FontItalic')) italic = flag(st, prefix + 'FontItalic');
      const entry = {};
      if (family && !DEFAULT_FACES.test(family.trim()) && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._+()\-]*$/u.test(family.trim()) && family.length <= 80) entry.family = family.trim();
      if (size > 0 && !defSizes.includes(Math.round(size * 10) / 10)) entry.size = round2(clamp(size * MM_PER_PT / spMm, 0.5, 30));
      // emphasis counts only together with a deliberate face/size change, or when it departs from plain text
      if (Object.keys(entry).length || (bold === true && !['title', 'chord', 'tempo', 'rehearsal'].includes(key)) || italic === true) {
        if (bold != null && (entry.family || entry.size || bold)) entry.bold = bold;
        if (italic != null && (entry.family || entry.size || italic)) entry.italic = italic;
      }
      if (Object.keys(entry).length) out[key] = entry;
    }
    if (Object.keys(out).length) s.textStyles = out;
  }

  // ---------------------------------------------------------------------------
  // 4.2 parts, staves, instruments
  // ---------------------------------------------------------------------------
  readParts() {
    const score = this.score;
    this.staves = [];                                 // global staff index → info
    for (const pEl of kids(this.root, 'Part')) {
      const inst = kid(pEl, 'Instrument');
      const staffEls = kids(pEl, 'Staff');
      if (!staffEls.length) continue;
      const longName = textOf(inst, 'longName') || this.labelName(inst, 'longName'), shortName = textOf(inst, 'shortName') || this.labelName(inst, 'shortName');
      const trackName = textOf(pEl, 'trackName') || textOf(inst, 'trackName');
      const usesDrumset = inst ? flag(inst, 'useDrumset') : false;
      const chromatic = int(inst, 'transposeChromatic', 0);
      const diatonic = inst && has(inst, 'transposeDiatonic') ? int(inst, 'transposeDiatonic', 0) : diatonicFor(chromatic);
      const strings = kids(kid(inst, 'StringData'), 'string').map(s => parseInt(s.text, 10)).filter(Number.isFinite);
      const instClefs = {};
      for (const tag of ['clef', 'concertClef', 'transposingClef']) for (const c of kids(inst, tag)) {
        const idx = (parseInt(c.attrs.staff || '1', 10) || 1) - 1;
        if (tag !== 'concertClef' || !instClefs[idx]) instClefs[idx] = c.text.trim();
      }
      const stInfos = staffEls.map((sEl, k) => {
        const stype = kid(sEl, 'StaffType');
        const group = (stype && stype.attrs.group) || 'pitched';
        const type = group === 'percussion' || (usesDrumset && group !== 'tablature') ? 'percussion' : group === 'tablature' ? 'tab' : 'standard';
        const lines = stype && has(stype, 'lines') ? int(stype, 'lines', 5) : type === 'tab' ? (strings.length || 6) : 5;
        const clefName = txt(sEl, 'defaultTransposingClef') || txt(sEl, 'defaultClef') || txt(sEl, 'defaultConcertClef') || instClefs[k] || '';
        return { el: sEl, type, lines, clefName };
      });
      const names = `${inst ? inst.attrs.id || '' : ''} ${txt(inst, 'instrumentId') || ''} ${longName} ${trackName}`;
      const program = (() => { const ch = kid(inst, 'Channel'); const p = ch && kid(ch, 'program'); const v = p ? parseInt(p.attrs.value, 10) : NaN; return Number.isFinite(v) ? clamp(v, 0, 127) : null; })();
      const instrument = guessInstrument(names, stInfos, program);
      const part = createPart(instrument, { instrument });
      const name = longName || trackName;
      if (name) part.name = name;
      if (shortName) part.abbreviation = shortName; else if (name) part.abbreviation = name.length > 5 ? name.slice(0, 4) + '.' : name;
      if (program != null) part.midiProgram = program;
      delete part.midiChannel;
      if (usesDrumset || stInfos.some(s => s.type === 'percussion')) part.midiChannel = 9;
      part.transposeChromatic = chromatic;
      const drums = kids(inst, 'Drum');
      part.staves = stInfos.map((si) => {
        const st = { id: newId(), type: si.type, lines: 5, clef: 'treble' };
        if (si.type === 'percussion') {
          st.clef = 'percussion'; st.lines = si.lines === 1 ? 1 : 5;
          st.drumMap = {};
        } else if (si.type === 'tab') {
          st.clef = 'tab'; st.lines = clamp(si.lines || strings.length || 6, 3, 8);
          const tun = strings.length ? strings : (st.lines === 4 ? [28, 33, 38, 43] : [40, 45, 50, 55, 59, 64]);
          st.tuning = tun.map(midiName);
        } else {
          const c = CLEF_IN[si.clefName];
          st.clef = c && c !== 'percussion' && c !== 'tab' ? c : 'treble';
        }
        return st;
      });
      const drumByPitch = new Map();
      if (part.staves.some(s => s.type === 'percussion')) {
        const map = {};
        for (const d of drums) {
          const pitch = parseInt(d.attrs.pitch, 10); if (!Number.isFinite(pitch)) continue;
          const def = Object.entries(DEFAULT_DRUM_MAP).find(([, v]) => v.midi === pitch);
          let key = def ? def[0] : (textOf(d, 'name').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') || 'drum' + pitch);
          if (map[key] && map[key].midi !== pitch) key = key + '-' + pitch;
          const head = headFrom(txt(d, 'head'), 'quarter') || 'normal';
          map[key] = { line: int(d, 'line', def ? def[1].line : 3), head, midi: pitch, name: def ? def[1].name : textOf(d, 'name') || key };
          drumByPitch.set(pitch, key);
        }
        for (const st of part.staves) if (st.type === 'percussion') {
          st.drumMap = st.lines === 1 ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { ...v, line: 4 }])) : map;
        }
      }
      score.parts.push(part);
      stInfos.forEach((si, k) => {
        this.staves.push({ g: this.staves.length, part, staff: part.staves[k], k, type: si.type, chromatic, diatonic,
          fifthsShift: intervalFifths(diatonic, chromatic), drumByPitch, drumMap: part.staves[k].drumMap, hasDrumDefs: drums.length > 0,
          initialClef: null, clefChanges: [], keys: [], events: [] });
      });
    }
    if (!this.staves.length) throw new Error('MuseScore 파일에 오선(Part/Staff)이 없습니다');
  }
  /** MuseScore 5 keeps instrument names in <InstrumentLabel>. */
  labelName(inst, which) {
    const lab = kid(inst, 'InstrumentLabel');
    return lab ? textOf(lab, which) || (which === 'longName' ? textOf(lab, 'customLongName') || textOf(lab, 'name') : textOf(lab, 'customShortName')) : '';
  }

  // ---------------------------------------------------------------------------
  // 4.3 measure skeleton, meta data, time line
  // ---------------------------------------------------------------------------
  collectMeasures() {
    this.staffMeasures = this.staves.map(() => []);    // per staff: [{ el, fileTick }]
    this.frames = [];
    const contentStaves = kids(this.root, 'Staff');
    contentStaves.forEach((sEl, idx) => {
      const g = (parseInt(sEl.attrs.id, 10) || idx + 1) - 1;
      if (g < 0 || g >= this.staves.length) return;
      let pendingTick = null;
      for (const c of sEl.children) {
        if (c.tag === 'Measure') {
          if (has(c, 'multiMeasureRest')) continue;     // generated multi-measure rest; the real measures follow/precede it
          this.staffMeasures[g].push({ el: c, tickHint: pendingTick });
          pendingTick = null;
        } else if (c.tag === 'tick') pendingTick = (parseInt(c.text, 10) || 0) * this.tickScale;
        else if (g === 0 && /^(VBox|HBox|TBox|FBox)$/.test(c.tag)) this.frames.push({ el: c, before: this.staffMeasures[0].length });
      }
    });
    const count = Math.max(1, ...this.staffMeasures.map(a => a.length));
    const score = this.score;
    for (let i = 0; i < count; i++) {
      const m = { id: newId(), staves: this.staves.map(() => ({ voices: [[]] })) };
      score.measures.push(m);
    }
    this.info = score.measures.map(() => ({ len: WHOLE, nominal: WHOLE }));
  }

  readMeta() {
    const meta = this.score.meta;
    const tags = {};
    for (const mt of kids(this.root, 'metaTag')) { const v = plainOf(mt.text).trim(); if (v) tags[mt.attrs.name] = v; }
    const frame = {};
    const userNames = {};
    if (this.styleEl) for (let i = 1; i <= 12; i++) { const n = txt(this.styleEl, `user${i}Name`); if (n) userNames[i] = n; }
    for (const f of this.frames) {
      if (f.before > 0) continue;                       // only frames in front of the music
      for (const t of kids(f.el, 'Text')) {
        const text = textOf(t, 'text'); if (!text) continue;
        let style = (txt(t, 'style') || '').trim();
        const um = /^user[-_ ]?(\d+)$/i.exec(style);
        if (um && userNames[+um[1]]) style = userNames[+um[1]];
        const key = style.toLowerCase().replace(/[^a-z]/g, '');
        const field = { title: 'title', subtitle: 'subtitle', composer: 'composer', lyricist: 'lyricist', poet: 'lyricist', movementtitle: 'movement', worktitle: 'work' }[key];
        if (field && !frame[field]) frame[field] = text;
      }
    }
    meta.title = frame.title || frame.movement || tags.workTitle || tags.movementTitle || '';
    meta.subtitle = frame.subtitle || (frame.title ? '' : frame.movement ? frame.work || '' : tags.workTitle && tags.movementTitle ? tags.movementTitle : '') || '';
    if (!meta.subtitle && tags.subtitle && tags.subtitle !== meta.title) meta.subtitle = tags.subtitle;
    meta.composer = frame.composer || tags.composer || '';
    meta.lyricist = frame.lyricist || tags.lyricist || tags.poet || '';
    meta.arranger = tags.arranger || '';
    meta.copyright = tags.copyright || '';
    if (!meta.title && this.fileName) meta.title = this.fileName.replace(/^.*[\\/]/, '').replace(/\.(mscz|mscx)$/i, '');
  }

  /** Time signatures and measure lengths (needed before any position can be computed). */
  readTimeline() {
    const score = this.score;
    let cur = { num: 4, den: 4, display: 'normal' }, curKey = '';
    let abs = 0;
    for (let mi = 0; mi < score.measures.length; mi++) {
      let ts = null, local = null, lenAttr = null;
      for (let g = 0; g < this.staves.length; g++) {
        const rec = this.staffMeasures[g][mi]; if (!rec) continue;
        if (lenAttr == null && rec.el.attrs.len) { const t = fracTicks(rec.el.attrs.len); if (t > 0) lenAttr = t; }
        if (ts) { if (lenAttr != null) break; continue; }
        const t = leadingTimeSig(rec.el);
        if (!t) continue;
        if (int(t, 'stretchN', 1) === int(t, 'stretchD', 1)) ts = t; else if (!local) local = t;   // a staff with a "local" meter does not define the score's meter
      }
      if (ts) {
        const n = int(ts, 'sigN', 4), d = int(ts, 'sigD', 4);
        if (n > 0 && [1, 2, 4, 8, 16, 32, 64].includes(d)) {
          const sub = int(ts, 'subtype', 0);
          cur = { num: n, den: d, display: sub === 1 && n === 4 && d === 4 ? 'common' : sub === 2 && n === 2 && d === 2 ? 'cut' : 'normal' };
        }
      } else if (local) {                                // every staff is local: the real length is the written one divided by the stretch
        const n = int(local, 'sigN', 4), d = int(local, 'sigD', 4), sn = int(local, 'stretchN', 1), sd = int(local, 'stretchD', 1);
        const g = n > 0 && d > 0 && sn > 0 ? timeSigForTicks((n * WHOLE / d) * sd / sn) : null;
        if (g) cur = { num: g.num, den: g.den, display: 'normal' };
      }
      const key = `${cur.num}/${cur.den}/${cur.display}`;
      const m = score.measures[mi];
      if (key !== curKey || mi === 0) { m.timeSig = { ...cur }; curKey = key; }
      const nominal = (cur.num * WHOLE) / cur.den;
      const len = lenAttr != null ? lenAttr : nominal;
      this.info[mi] = { len, nominal, abs };
      abs += len;
    }
    this.totalTicks = abs;
    // irregular measures: shorter ones are pickups (ScoreDoc `pickup`), longer ones need their own meter
    for (let mi = 0; mi < score.measures.length; mi++) {
      const inf = this.info[mi], m = score.measures[mi];
      if (inf.len < inf.nominal - EPS) m.pickup = true;
      else if (inf.len > inf.nominal + EPS) {
        const ts = timeSigForTicks(inf.len);
        if (ts) {
          const restore = effectiveTs(score, mi);
          m.timeSig = { ...ts, display: 'normal' };
          const next = score.measures[mi + 1];
          if (next && !next.timeSig) next.timeSig = { ...restore };
          this.warn('박자표보다 긴 마디는 그 길이의 박자표로 바꿔 가져왔습니다');
        }
      }
    }
  }
  // ---------------------------------------------------------------------------
  // 4.4 staff contents
  // ---------------------------------------------------------------------------
  readStaff(g) {
    const S = this.staves[g];
    const recs = this.staffMeasures[g];
    if (!this.spanTags) {
      this.spanTags = []; this.oldOpen = new Map(); this.oldDone = []; this.oldSlurStart = new Map(); this.oldSlurs = []; this.oldDefs = new Map();
      this.oldTies = new Set(); this.evByEid = new Map(); this.noteByEid = new Map(); this.measureByEid = new Map(); this.eidTies = []; this.eidGliss = [];
      this.beamInfo = new Map(); this.repeatCount = new Map(); this.repeatMarks = [];
    }
    S.voiceData = [];
    let fileTick = 0;
    for (let mi = 0; mi < recs.length; mi++) {
      const rec = recs[mi];
      if (rec.tickHint != null) fileTick = rec.tickHint;
      this.readMeasure(S, mi, rec.el, fileTick);
      fileTick += this.info[mi].len;
    }
  }

  readMeasure(S, mi, mEl, fileTick) {
    const m = this.score.measures[mi], inf = this.info[mi];
    const ctx = {
      S, g: S.g, mi, m, len: inf.len, abs: inf.abs, fileTick, cursor: 0, vi: 0, flat: false,
      voices: [0, 1, 2, 3].map(() => ({ events: [], pos: 0, before: [], after: [], tuplets: [], fermata: null, last: null })),
      annos: [], placed: [], tupDefs: S.tupDefs || (S.tupDefs = new Map()),
    };
    let voiceNo = 0;
    for (const c of mEl.children) {
      if (c.tag === 'voice') {
        ctx.vi = Math.min(voiceNo++, 3); ctx.cursor = 0; ctx.flat = false;
        for (const e of c.children) this.readItem(e, ctx);
      } else if (!this.readMeasureProp(c, ctx)) { ctx.flat = true; this.readItem(c, ctx); }
    }
    for (let vi = 0; vi < 4; vi++) this.endVoice(ctx, vi);
    this.resolveAnnotations(ctx);
    S.voiceData[mi] = ctx.voices.map(v => v.events);
  }

  /** Measure-level elements; returns false for music content (flat layout). */
  readMeasureProp(c, ctx) {
    const m = ctx.m;
    switch (c.tag) {
      case 'startRepeat': m.barlineLeft = 'repeat-start'; return true;
      case 'endRepeat': { m.barlineRight = 'repeat-end'; const n = parseInt(c.text, 10); if (n > 2) m.repeatCount = n; return true; }
      case 'LayoutBreak': {
        const t = txt(c, 'subtype');
        if (t === 'line' || t === 'section') m.breaks = Object.assign(m.breaks || {}, { system: true });
        else if (t === 'page') m.breaks = Object.assign(m.breaks || {}, { page: true });
        return true;
      }
      case 'Marker': this.readMarker(c, m); return true;
      case 'Jump': this.readJump(c, m); return true;
      case 'eid': this.measureByEid.set(c.text.trim(), ctx.mi); return true;
      case 'measureRepeatCount': this.repeatCount.set(`${ctx.g}:${ctx.mi}`, parseInt(c.text, 10) || 0); return true;
      case 'irregular': case 'stretch': case 'multiMeasureRest': case 'breakMultiMeasureRest': case 'noOffset': case 'visible': case 'vspacer':
      case 'vspacerUp': case 'vspacerDown': case 'vspacerFixed': case 'MeasureNumber': case 'MMRestRange': case 'measureNumberMode':
      case 'slashStyle': case 'stemless': case 'hideIfEmpty': case 'mmRestLast': case 'SystemDivider': case 'StaffTypeChange': case 'linked':
      case 'linkedMain': case 'linkedTo': case 'lid':
        if (c.tag === 'StaffTypeChange') this.skip('StaffTypeChange');
        return true;
      default: return false;
    }
  }

  voiceOf(el, ctx) {
    if (!ctx.flat) return ctx.vi;
    const t = kid(el, 'track');
    if (!t) return 0;
    const track = parseInt(t.text, 10) || 0;
    return ((track % 4) + 4) % 4;
  }

  readItem(el, ctx) {
    switch (el.tag) {
      case 'location': { const f = fracTicks(txt(el, 'fractions')); if (Number.isFinite(f)) ctx.cursor += f; break; }
      case 'tick': ctx.cursor = clamp((parseInt(el.text, 10) || 0) * this.tickScale - ctx.fileTick, 0, ctx.len); break;
      case 'move': { const f = fracTicks(el.text); if (Number.isFinite(f)) ctx.cursor = clamp(f, 0, ctx.len); break; }
      case 'Chord': this.readChord(el, ctx); break;
      case 'Rest': this.readRest(el, ctx); break;
      case 'RepeatMeasure': case 'MeasureRepeat': {
        const vi = this.voiceOf(el, ctx);
        let ticks = durationNodeTicks(kid(el, 'duration')); if (!(ticks > 0)) ticks = ctx.len;
        const ev = { id: newId(), kind: 'rest', dur: exactDur(ticks) || { base: 'whole', dots: 0 }, fullMeasureRest: true };
        this.addMain(ctx, vi, ev, ticks);
        this.repeatMarks.push({ g: ctx.g, mi: ctx.mi, n: clamp(int(el, 'subtype', 1), 1, 8) });
        break;
      }
      case 'Tuplet': {
        const num_ = int(el, 'actualNotes', 3), den = int(el, 'normalNotes', 2);
        const nt = int(el, 'numberType', 0), bt = int(el, 'bracketType', 0);
        const def = { id: newId(), num: num_ > 0 ? num_ : 3, den: den > 0 ? den : 2, show: nt === 2 ? 'none' : nt === 1 ? 'ratio' : 'number', bracket: bt === 1 ? true : bt === 2 ? false : undefined };
        const unit = DUR_TICKS[DUR_IN[txt(el, 'baseNote') || '']];
        if (unit) this.tupUnit.set(def.id, unit * DOT_FACTOR[clamp(int(el, 'baseDots', 0), 0, 3)]);          // see completeTuplets
        if (el.attrs.id != null) { def.parent = txt(el, 'Tuplet') || null; ctx.tupDefs.set(el.attrs.id, def); }   // flat layout: referenced by id
        else ctx.voices[ctx.vi].tuplets.push(def);
        break;
      }
      case 'endTuplet': ctx.voices[ctx.vi].tuplets.pop(); break;
      case 'Clef': {
        const name = txt(el, 'transposingClefType') || txt(el, 'concertClefType') || '';
        const clef = CLEF_IN[name];
        if (clef) { ctx.S.clefChanges.push({ mi: ctx.mi, tick: ctx.cursor, len: ctx.len, clef }); if (CLEF_APPROX.has(name)) this.warn('일부 음자리표는 가장 가까운 음자리표로 바꿨습니다'); }
        break;
      }
      case 'KeySig': this.readKeySig(el, ctx); break;
      case 'TimeSig': {                                                  // the meter itself is read in readTimeline
        if (ctx.cursor > EPS) break;
        const n = int(el, 'stretchN', 1), d = int(el, 'stretchD', 1);     // "local" time signature: this staff runs n/d times as fast
        ctx.S.stretch = n > 0 && d > 0 && n !== d ? [n / gcd(n, d), d / gcd(n, d)] : null;
        if (ctx.S.stretch) this.warn('보표마다 다른 박자(로컬 박자표)는 숨긴 잇단음표로 바꿔 가져왔습니다');
        break;
      }
      case 'BarLine': this.readBarLine(el, ctx); break;
      case 'Spanner': this.readSpannerTag(el, ctx, null); break;
      case 'endSpanner': this.endOldSpanner(el.attrs.id, ctx, null); break;
      case 'Fermata': {
        if (txt(el, 'visible') === '0') break;
        const sub = txt(el, 'subtype') || '';
        ctx.voices[this.voiceOf(el, ctx)].fermata = /Below$/.test(sub) || txt(el, 'placement') === 'below' ? 'below' : 'above';
        break;
      }
      case 'Dynamic': case 'StaffText': case 'SystemText': case 'Expression': case 'PlayTechAnnotation': case 'RehearsalMark': case 'Tempo':
      case 'Harmony': case 'FretDiagram': case 'InstrumentChange': case 'Text': case 'Sticking':
        ctx.annos.push({ tick: ctx.cursor, vi: this.voiceOf(el, ctx), el });
        break;
      case 'Marker': this.readMarker(el, ctx.m); break;
      case 'Jump': this.readJump(el, ctx.m); break;
      case 'Beam': case 'Segment': case 'eid': case 'track': case 'visible': case 'offset': case 'pos': case 'lid': case 'linked': case 'linkedMain':
      case 'linkedTo': case 'Ambitus': case 'Symbol': case 'Image': case 'StaffState': case 'TremoloBar': case 'BSymbol': case 'HBox': case 'VBox':
        break;
      default:
        if (SPANNER_TAGS.has(el.tag)) this.startOldSpanner(el, ctx, null);
        else this.skip(el.tag);
    }
  }

  // ---------- chords, rests, notes ----------
  tupletFor(el, ctx, vi) {
    let chain;
    if (ctx.flat || has(el, 'Tuplet')) {
      chain = [];
      let id = txt(el, 'Tuplet'), guard = 0;
      while (id != null && id !== '' && guard++ < 6) { const d = ctx.tupDefs.get(id); if (!d) break; chain.unshift(d); id = d.parent; }
    } else chain = ctx.voices[vi].tuplets;
    if (!chain.length) return null;
    const inner = chain[chain.length - 1];
    if (chain.length === 1) return inner;
    let n = 1, d = 1;
    for (const t of chain) { n *= t.num; d *= t.den; }
    const k = gcd(n, d);
    this.warn('중첩 잇단음표는 하나의 잇단음표로 풀어서 가져왔습니다');
    return { id: inner.id, num: n / k, den: d / k, show: inner.show, bracket: inner.bracket };
  }

  /** Combines a tuplet (or none) with the staff's local time signature into one tuplet ratio. */
  stretched(tup, ctx, vi) {
    const st = ctx.S.stretch;
    if (!st) return tup && tup.num === tup.den && tup.show === 'none' ? null : tup;      // an invisible 4:4 "tuplet" is only a beaming trick
    const n = (tup ? tup.num : 1) * st[0], d = (tup ? tup.den : 1) * st[1], k = gcd(n, d);
    if (n === d) return null;
    if (tup) return { id: tup.id, num: n / k, den: d / k, show: tup.show, bracket: tup.bracket };
    // one hidden tuplet per beat keeps the beaming of the local meter
    const ts = effectiveTs(this.score, ctx.mi);
    const beat = ts.den === 8 && ts.num % 3 === 0 ? 1440 : WHOLE / ts.den;
    const V = ctx.voices[vi];
    const key = `${vi}:${Math.floor((Math.max(V.pos, ctx.cursor) + EPS) / beat)}`;
    const ids = ctx.stretchIds || (ctx.stretchIds = new Map());
    if (!ids.has(key)) { ids.set(key, newId()); this.tupUnit.set(ids.get(key), beat / (d / k)); }      // one beat = den units
    return { id: ids.get(key), num: n / k, den: d / k, show: 'none', bracket: false };
  }

  durationOf(el) {
    const dt = txt(el, 'durationType') || 'quarter';
    let base = DUR_IN[dt];
    if (!base) base = 'quarter';
    if (dt === 'long' || /^(256|512|1024)th$/.test(dt)) this.warn('표현할 수 없는 음길이는 가장 가까운 값으로 바꿨습니다');
    let dots = int(el, 'dots', 0), extra = 0;
    if (dots > 3) { extra = DUR_TICKS[base] * (DOT_FACTOR_4 - DOT_FACTOR[3]); dots = 3; }      // a fourth dot becomes a rest of its own
    return { base, dots: Math.max(0, dots), extra };
  }
  /** Invisible rest for the part of a value the model cannot write (fourth dot). */
  addExtra(ctx, vi, extra, ratio) {
    if (!(extra > 0)) return;
    const V = ctx.voices[vi], t = extra * ratio;
    for (const r of this.gapRests(t)) V.events.push(r);
    V.pos += t; ctx.cursor += t;
  }

  readChord(el, ctx) {
    const vi = this.voiceOf(el, ctx), V = ctx.voices[vi], S = ctx.S;
    let { base, dots, extra } = this.durationOf(el);
    const graceKind = GRACE_TAGS.find(t => has(el, t));
    let nominal = DUR_TICKS[base] * DOT_FACTOR[dots];
    const durNode = kid(el, 'duration');
    if (durNode && !graceKind) {                        // written value ≠ sounding length: two-chord tremolo
      const d = durationNodeTicks(durNode);
      if (d > 0 && Math.abs(d - nominal - extra) > EPS) { const alt = exactDur(d); if (alt) { base = alt.base; dots = alt.dots; nominal = d; extra = 0; this.warn('두 음 트레몰로는 실제 길이의 음표로 가져왔습니다'); } }
    }
    const ev = { id: newId(), kind: 'note', dur: { base, dots }, notes: [] };
    const eid = txt(el, 'eid'); if (eid) this.evByEid.set(eid, { ev, g: ctx.g, mi: ctx.mi, vi });
    const tup = graceKind ? null : this.stretched(this.tupletFor(el, ctx, vi), ctx, vi);
    if (tup) { ev.tuplet = { id: tup.id, num: tup.num, den: tup.den, show: tup.show }; if (tup.bracket != null) ev.tuplet.bracket = tup.bracket; }
    const owner = { ev, vi, note: null };
    let invisibleNotes = 0;
    for (const c of el.children) {
      switch (c.tag) {
        case 'Note': { const n = this.readNote(c, ctx, owner); if (n) { ev.notes.push(n.note); if (n.invisible) invisibleNotes++; } break; }
        case 'Lyrics': this.readLyrics(c, ev); break;
        case 'Articulation': case 'Ornament': if (txt(c, 'visible') !== '0') this.applyArticulation(ev, txt(c, 'subtype') || '', c); break;
        case 'Arpeggio': if (int(c, 'subtype', 0) !== 3) ev.arpeggio = true; break;
        case 'Tremolo': case 'TremoloSingleChord': { const t = { r8: 1, r16: 2, r32: 3, r64: 3, buzzroll: 3 }[txt(c, 'subtype')]; if (t) ev.tremolo = t; break; }
        case 'TremoloTwoChord': break;
        case 'StemDirection': { const d = c.text.trim(); if (d === 'up' || d === 'down') ev.stem = d; break; }
        case 'BeamMode': this.beamInfoOf(ev).mode = c.text.trim(); break;
        case 'Beam': if (!c.children.length && c.text.trim()) this.beamInfoOf(ev).beamId = `${ctx.g}:${c.text.trim()}`; break;
        case 'visible': if (c.text.trim() === '0') ev.hidden = true; break;
        case 'Spanner': owner.note = null; this.readSpannerTag(c, ctx, owner); break;
        case 'Slur': this.readOldSlurRef(c, ctx, owner); break;
        case 'staffMove': case 'move': if ((parseInt(c.text, 10) || 0) !== 0) this.warn('다른 보표로 넘긴 음표(크로스 스태프)는 원래 보표에 표시합니다'); break;
        case 'ChordLine': this.skip('ChordLine'); break;
        default: break;
      }
    }
    if (!ev.notes.length) { ev.kind = 'rest'; delete ev.notes; } else if (invisibleNotes === ev.notes.length) ev.hidden = true;
    if (ev.lyrics) ev.lyrics.sort((a, b) => a.verse - b.verse);
    if (graceKind) {
      ev.grace = { slash: graceKind === 'acciaccatura' };
      if (/after$/.test(graceKind)) ev.grace.after = true;          // belongs to the note in front of it (Nachschlag, "let ring" tie)
      delete ev.tuplet;
      (/after$/.test(graceKind) ? V.after : V.before).push(ev);
      return;
    }
    this.addMain(ctx, vi, ev, nominal * (tup ? tup.den / tup.num : 1));
    if (extra) { this.addExtra(ctx, vi, extra, tup ? tup.den / tup.num : 1); this.warn('표현할 수 없는 음길이는 가장 가까운 값으로 바꿨습니다'); }
  }

  beamInfoOf(ev) { let b = this.beamInfo.get(ev); if (!b) this.beamInfo.set(ev, b = {}); return b; }

  readRest(el, ctx) {
    const vi = this.voiceOf(el, ctx), V = ctx.voices[vi];
    const dt = txt(el, 'durationType');
    let ev, ticks, extraTicks = 0;
    const st = ctx.S.stretch;
    if (!dt || dt === 'measure') {
      ticks = durationNodeTicks(kid(el, 'duration'));
      if (ticks > 0 && st) ticks = ticks * st[1] / st[0];
      if (!(ticks > 0)) ticks = ctx.len;
      ev = { id: newId(), kind: 'rest', dur: exactDur(ticks) || { base: 'whole', dots: 0 }, fullMeasureRest: true };
    } else {
      let { base, dots, extra } = this.durationOf(el);
      extraTicks = extra;
      let nominal = DUR_TICKS[base] * DOT_FACTOR[dots];
      const d = durationNodeTicks(kid(el, 'duration'));                  // rest that stands in for half of a two-chord tremolo
      if (d > 0 && Math.abs(d - nominal - extra) > EPS) { const alt = exactDur(d); if (alt) { base = alt.base; dots = alt.dots; nominal = d; extraTicks = 0; } }
      ev = { id: newId(), kind: 'rest', dur: { base, dots } };
      const tup = this.stretched(this.tupletFor(el, ctx, vi), ctx, vi);
      if (tup) { ev.tuplet = { id: tup.id, num: tup.num, den: tup.den, show: tup.show }; if (tup.bracket != null) ev.tuplet.bracket = tup.bracket; }
      ticks = nominal * (tup ? tup.den / tup.num : 1);
    }
    const eid = txt(el, 'eid'); if (eid) this.evByEid.set(eid, { ev, g: ctx.g, mi: ctx.mi, vi });
    if (txt(el, 'visible') === '0') ev.hidden = true;
    const owner = { ev, vi, note: null };
    for (const c of el.children) {
      if (c.tag === 'Articulation' && txt(c, 'visible') !== '0') this.applyArticulation(ev, txt(c, 'subtype') || '', c);
      else if (c.tag === 'Spanner') this.readSpannerTag(c, ctx, owner);
      else if (c.tag === 'Slur') this.readOldSlurRef(c, ctx, owner);
      else if (c.tag === 'Lyrics') this.readLyrics(c, ev);
      else if (c.tag === 'BeamMode') this.beamInfoOf(ev).mode = c.text.trim();
    }
    if (ev.articulations) delete ev.articulations;
    if (ev.ornaments) delete ev.ornaments;
    void V;
    this.addMain(ctx, vi, ev, ticks);
    if (extraTicks) this.addExtra(ctx, vi, extraTicks, ev.tuplet ? ev.tuplet.den / ev.tuplet.num : 1);
  }

  /** Appends a main (non-grace) event at the cursor; gaps before it become hidden rests. */
  addMain(ctx, vi, ev, ticks) {
    const V = ctx.voices[vi];
    const at = ctx.cursor;
    if (at > V.pos + EPS) { for (const r of this.gapRests(at - V.pos)) V.events.push(r); V.pos = at; }
    const tick = V.pos;
    for (const g of V.before) { V.events.push(g); ctx.placed.push({ ev: g, vi, tick, grace: true }); ctx.S.events.push({ ev: g, mi: ctx.mi, vi, abs: ctx.abs + tick, grace: true }); }
    V.before = [];
    if (V.fermata) { ev.fermata = V.fermata; V.fermata = null; }
    V.events.push(ev);
    ctx.placed.push({ ev, vi, tick, grace: false });
    ctx.S.events.push({ ev, mi: ctx.mi, vi, abs: ctx.abs + tick, grace: false });
    for (const g of V.after) { V.events.push(g); ctx.placed.push({ ev: g, vi, tick: tick + ticks, grace: true }); ctx.S.events.push({ ev: g, mi: ctx.mi, vi, abs: ctx.abs + tick, grace: true }); }
    V.after = [];
    V.last = ev;
    V.pos = tick + ticks;
    ctx.cursor = Math.max(at, tick) + ticks;
  }

  /** Hidden rests of exactly `gap` ticks (tuplet rests when the gap is not made of plain note values). */
  gapRests(gap) {
    const mk = (d, tuplet) => { const r = makeRest(d.base, d.dots); r.hidden = true; if (tuplet) r.tuplet = tuplet; return r; };
    if (!(gap > EPS)) return [];
    const plain = ticksToDurations(gap);
    const sum = ds => ds.reduce((s, d) => s + DUR_TICKS[d.base] * DOT_FACTOR[d.dots], 0);
    if (Math.abs(sum(plain) - gap) <= EPS) return plain.map(d => mk(d));
    for (const [n, d] of [[3, 2], [5, 4], [6, 4], [7, 4], [7, 8], [9, 8], [5, 2], [10, 8], [11, 8], [12, 8], [13, 8]]) {
      const nominal = gap * n / d;
      if (Math.abs(nominal - Math.round(nominal)) > 0.01) continue;
      const ds = ticksToDurations(Math.round(nominal));
      if (Math.abs(sum(ds) - nominal) <= EPS) { const id = newId(); return ds.map(x => mk(x, { id, num: n, den: d, show: 'none', bracket: false })); }
    }
    this.warn('일부 성부의 빈 박을 가장 가까운 쉼표로 채웠습니다');
    return plain.map(d => mk(d));
  }

  /**
   * MuseScore lets the rests of voices 2–4 be deleted, also inside a tuplet; the file then holds a tuplet with
   * fewer notes than its ratio asks for and a jump. Such a tuplet is made whole again from the hidden rests
   * that fill the jump (same tuplet, same lengths in ticks), so that every tuplet of the ScoreDoc is complete.
   */
  completeTuplets(v) {
    const nominalOf = e => (DUR_TICKS[e.dur.base] || 0) * DOT_FACTOR[Math.min(e.dur.dots || 0, 3)];
    const exactList = t => { if (t < EPS) return []; const ds = ticksToDurations(Math.round(t)); return Math.abs(ds.reduce((x, d) => x + DUR_TICKS[d.base] * DOT_FACTOR[d.dots], 0) - t) <= EPS ? ds : null; };
    for (let i = 0, guard = 0; i < v.length && guard < 400; i++) {
      const t = v[i].tuplet;
      if (!t || v[i].grace) continue;
      let j = i, nominal = 0, real = false;
      while (j < v.length && !v[j].grace && v[j].tuplet && v[j].tuplet.id === t.id) { nominal += nominalOf(v[j]); if (!isFiller(v[j])) real = true; j++; }
      if (!real || exactDur(nominal / t.num)) { i = j - 1; continue; }
      // hidden rests that may be used: not the end of a line, not part of a tuplet that holds notes
      const live = new Set(); for (const e of v) if (e.tuplet && !e.grace && !isFiller(e)) live.add(e.tuplet.id);
      const free = e => e && !e.grace && isFiller(e) && !this.anchored.has(e.id) && !(e.tuplet && live.has(e.tuplet.id));
      let a = j; while (free(v[a])) a++;                             // … after the group
      let b = i; while (b > 0 && free(v[b - 1])) b--;                // … and in front of it
      const after = v.slice(j, a).reduce((x, e) => x + durTicks(e), 0), before = v.slice(b, i).reduce((x, e) => x + durTicks(e), 0);
      const start = v.slice(0, i).reduce((x, e) => x + durTicks(e), 0);
      // the unit the file names for this tuplet first, then any note value that makes it whole
      const units = [this.tupUnit.get(t.id), ...Object.values(DUR_TICKS).sort((x, y) => x - y)].filter(u => u > 0);
      let done = false;
      for (const unit of units) {
        const need = t.num * unit - nominal, actual = need * t.den / t.num, span = t.den * unit;
        const rests = need > EPS ? exactList(need) : null;
        const okAfter = actual <= after + EPS, okBefore = actual <= before + EPS;
        if (!rests || (!okAfter && !okBefore)) continue;
        // a tuplet begins on a multiple of its own length: that tells whether its first or its last notes are missing
        const onGrid = x => Math.abs(x - Math.round(x / span) * span) <= EPS;
        const mk = d => { const r = makeRest(d.base, d.dots); r.hidden = true; r.tuplet = t; return r; };
        if (okBefore && (!okAfter || (onGrid(start - actual) && !onGrid(start)))) v.splice(b, i - b, ...this.gapRests(before - actual), ...rests.map(mk));
        else v.splice(j, a - j, ...rests.map(mk), ...this.gapRests(after - actual));
        done = true; break;
      }
      if (done) { guard++; i = Math.max(b - 1, -1); } else i = j - 1;  // look at the voice again from the changed place
    }
  }

  endVoice(ctx, vi) {
    const V = ctx.voices[vi];
    for (const g of [...V.before, ...V.after]) { V.events.push(g); ctx.placed.push({ ev: g, vi, tick: V.pos, grace: true }); }
    V.before = []; V.after = [];
    if (V.fermata && V.last) { V.last.fermata = V.fermata; V.fermata = null; }
  }

  readNote(nEl, ctx, owner) {
    const S = ctx.S, ev = owner.ev;
    const pitch = int(nEl, 'pitch', 60);
    let note, invisible = false;
    if (S.type === 'percussion') {
      let key = S.drumByPitch.get(pitch);
      if (!key) {
        const def = Object.entries(DEFAULT_DRUM_MAP).find(([, v]) => v.midi === pitch);
        key = def ? def[0] : 'drum' + pitch;
        if (!S.drumMap[key]) {
          const line = def ? def[1].line : clamp(staffPosition(noteFromMidi(pitch, 0), 'treble'), -4, 12);
          S.drumMap[key] = { line: S.staff.lines === 1 ? 4 : line, head: def ? def[1].head : 'normal', midi: pitch, name: def ? def[1].name : key };
        }
        S.drumByPitch.set(pitch, key);
      }
      const d = S.drumMap[key];
      const p = noteAtStaffPosition(d.line, 'treble');
      note = { step: p.step, octave: p.octave, alter: 0, drum: key };
      const head = headFrom(txt(nEl, 'head'), ev.dur.base);
      if (head && head !== d.head) note.head = head;
    } else {
      const tpc2 = has(nEl, 'tpc2') ? int(nEl, 'tpc2', NaN) : NaN, tpc1 = has(nEl, 'tpc') ? int(nEl, 'tpc', NaN) : NaN;
      const tpc = Number.isFinite(tpc2) ? tpc2 : Number.isFinite(tpc1) ? tpc1 - S.fifthsShift : NaN;
      const p = noteFromPitchTpc(pitch - S.chromatic, tpc);
      note = { step: p.step, octave: clamp(p.octave, 0, 9), alter: clamp(p.alter, -2, 2) };
      const head = headFrom(txt(nEl, 'head'), ev.dur.base);
      if (head) note.head = head;
      if (S.type === 'tab') {
        if (has(nEl, 'fret')) note.fret = clamp(int(nEl, 'fret', 0), 0, 36);
        if (has(nEl, 'string')) note.string = clamp(int(nEl, 'string', 0) + 1, 1, S.staff.tuning.length);
      }
    }
    owner.note = note;
    for (const c of nEl.children) {
      switch (c.tag) {
        case 'Accidental': {
          const kind = ACC_IN[txt(c, 'subtype')];
          if (kind && int(c, 'role', 0) === 1 && txt(c, 'visible') !== '0' && S.type === 'standard') note.accidental = kind;   // user-added (courtesy) accidental
          break;
        }
        case 'Spanner': this.readSpannerTag(c, ctx, owner); break;
        case 'Tie':
          if (has(c, 'startElement') || has(c, 'endElement')) this.eidTies.push({ start: txt(c, 'startElement'), end: txt(c, 'endElement') });
          else { note.tieStart = true; if (c.attrs.id != null) this.oldTies.add(c.attrs.id); }
          break;
        case 'Glissando':
          if (has(c, 'startElement') || has(c, 'endElement')) this.eidGliss.push({ start: txt(c, 'startElement'), end: txt(c, 'endElement'), el: c });
          else if (c.attrs.id != null) this.oldOpen.set(c.attrs.id, { type: 'Glissando', el: c, ev, g: ctx.g, vi: owner.vi, abs: ctx.abs + ctx.cursor, mi: ctx.mi });
          break;
        case 'endSpanner': this.endOldSpanner(c.attrs.id, ctx, owner); break;
        case 'Fingering': { const t = textOf(c, 'text'); if (t && !note.fingering && t.length <= 4) note.fingering = t; break; }
        case 'visible': if (c.text.trim() === '0') invisible = true; break;
        case 'color': { const r = +c.attrs.r, g = +c.attrs.g, b = +c.attrs.b; if ([r, g, b].every(Number.isFinite) && (r || g || b)) note.color = '#' + [r, g, b].map(v => clamp(v, 0, 255).toString(16).padStart(2, '0')).join(''); break; }
        case 'eid': this.noteByEid.set(c.text.trim(), { note, ev }); break;
        default: break;
      }
    }
    owner.note = null;
    return { note, invisible };
  }

  readLyrics(ly, ev) {
    if (txt(ly, 'visible') === '0') return;
    const text = textOf(ly, 'text');
    if (!text) return;
    const syl = txt(ly, 'syllabic');
    const l = { verse: clamp(int(ly, 'no', 0) + 1, 1, 99), text, syllabic: syl === 'begin' || syl === 'middle' || syl === 'end' ? syl : 'single' };
    const ticks = has(ly, 'ticks_f') ? fracTicks(txt(ly, 'ticks_f')) : int(ly, 'ticks', 0);
    if (ticks > 0) l.extend = true;
    const arr = ev.lyrics || (ev.lyrics = []);
    if (!arr.some(x => x.verse === l.verse)) arr.push(l);
  }

  applyArticulation(ev, name, el) {
    const hit = ARTIC_IN[name] || ARTIC_IN[name.replace(/(Above|Below)$/, '')];
    if (!hit) { if (name) this.skip('기호 ' + name.replace(/(Above|Below)$/, '')); return; }
    const add = (field, v) => { const arr = ev[field] || (ev[field] = []); if (!arr.includes(v)) arr.push(v); };
    if (hit[0] === 'art') for (const v of hit.slice(1)) add('articulations', v);
    else if (hit[0] === 'orn' || hit[0] === 'orn~') { add('ornaments', hit[1]); if (hit[0] === 'orn~') this.warn('일부 꾸밈음 기호는 비슷한 기호로 바꿨습니다'); }
    else if (hit[0] === 'fermata') ev.fermata = hit[1] || (/Below$/.test(name) || txt(el, 'direction') === 'down' ? 'below' : 'above');
  }

  // ---------- signatures, barlines, repeats ----------
  readKeySig(el, ctx) {
    const S = ctx.S;
    if (ctx.cursor >= ctx.len - EPS && ctx.cursor > EPS) return;         // courtesy key signature at the end of a measure
    let fifths;
    if (has(el, 'concertKey')) fifths = wrapFifths(int(el, 'concertKey', 0) - S.fifthsShift);
    else if (has(el, 'accidental')) { const v = int(el, 'accidental', 0); fifths = this.concertPitch ? wrapFifths(v - S.fifthsShift) : v; }
    else if (has(el, 'actualKey')) fifths = int(el, 'actualKey', 0);
    else fifths = 0;
    if (flag(el, 'custom') && !has(el, 'concertKey') && !has(el, 'accidental')) this.warn('사용자 정의 조표는 가져오지 못했습니다');
    const mode = txt(el, 'mode') === 'minor' ? 'minor' : 'major';
    const mi = ctx.cursor > EPS ? ctx.mi + 1 : ctx.mi;                    // a change inside a measure takes effect at the next barline
    S.keys.push({ mi, fifths: clamp(fifths, -7, 7), mode });
  }

  readBarLine(el, ctx) {
    const m = ctx.m;
    const sub = txt(el, 'subtype') || 'normal';
    const invisible = txt(el, 'visible') === '0';
    const t = ctx.cursor;
    if (t <= EPS) { if (sub === 'start-repeat') m.barlineLeft = 'repeat-start'; return; }
    if (t < ctx.len - EPS) return;                                         // barline inside a measure: no meaning for the model
    const map = { double: 'double', end: 'final', dashed: 'dashed', dotted: 'dashed', 'end-repeat': 'repeat-end', 'end-start-repeat': 'repeat-both',
      'reverse-end': 'double', heavy: 'final', 'double-heavy': 'final', broken: 'dashed' };
    let v = map[sub];
    if (!v && invisible) v = 'none';
    if (!v) return;
    if (m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both') { if (v === 'repeat-both') m.barlineRight = v; return; }
    if (!m.barlineRight || m.barlineRight === 'none') m.barlineRight = v;
  }

  readMarker(el, m) {
    // (an invisible marker still steers playback in MuseScore, so it is kept)
    const label = (txt(el, 'label') || '').toLowerCase();
    const raw = (kid(el, 'text') || { text: '' }).text;
    const plain = plainOf(raw).replace(/\s+/g, ' ').trim().toLowerCase();
    const words = plain.replace(/[\u{1D10B}\u{1D10C}]/gu, '').trim();
    const codaSym = plain.includes('\u{1D10C}'), segnoSym = plain.includes('\u{1D10B}');
    let kind = null;
    // MuseScore decides by the label: "coda" is the To Coda sign (whatever it shows), "codab" the coda itself
    if (label === 'coda') kind = 'toCoda';
    else if (/^(codab|varcoda|codetta)$/.test(label)) kind = 'coda';
    else if (/^(segno|varsegno)$/.test(label)) kind = 'segno';
    else if (label === 'fine') kind = 'fine';
    // labels made up by the user ("coda1", "toCoda2", "codaii" …) or none: go by the words and the sign
    else if (/to\s*coda|al\s*coda/.test(words) || /^to\s*coda/.test(label) || (codaSym && /^to\b/.test(words))) kind = 'toCoda';
    else if (/fine/.test(words) || /^fine/.test(label)) kind = 'fine';
    else if (segnoSym || /segno/.test(label)) kind = 'segno';
    else if (codaSym || /^coda/.test(label)) kind = 'coda';
    if (!kind) { const t = textOf(el, 'text'); if (t) (m.texts || (m.texts = [])).push({ text: t, placement: 'above', style: 'plain' }); return; }
    addMarker(m, kind);
  }

  readJump(el, m) {
    const to = (txt(el, 'jumpTo') || '').toLowerCase(), until = (txt(el, 'playUntil') || '').toLowerCase();
    const text = textOf(el, 'text').toLowerCase();
    const ds = /^segno|^varsegno/.test(to) || (!to && /d\.?\s*s\.?|dal segno/.test(text));
    const dc = to === 'start' || (!to && /d\.?\s*c\.?|da capo/.test(text));
    if (!ds && !dc) { const t = textOf(el, 'text'); if (t) (m.texts || (m.texts = [])).push({ text: t, placement: 'above', style: 'plain' }); return; }
    const tail = /coda/.test(until) || /al\s*coda/.test(text) ? 'AlCoda' : /fine/.test(until) || /al\s*fine/.test(text) ? 'AlFine' : '';
    addMarker(m, (ds ? 'ds' : 'dc') + tail);
  }

  // ---------- spanners ----------
  readLocation(loc) {
    return { measures: int(loc, 'measures', 0), ticks: has(loc, 'fractions') ? fracTicks(txt(loc, 'fractions')) || 0 : 0, staves: int(loc, 'staves', 0), voices: int(loc, 'voices', 0) };
  }

  /** <Spanner type="…"> (3.x / 4.x): a start (element + <next>) or an end (<prev>) of a spanner. */
  readSpannerTag(el, ctx, owner) {
    const type = el.attrs.type || '';
    const inner = kid(el, type);
    const next = kid(kid(el, 'next'), 'location'), prev = kid(kid(el, 'prev'), 'location');
    if (type === 'Tie') {
      if (owner && owner.note) { if (next || inner) owner.note.tieStart = true; if (prev) owner.note.tieEnd = true; }
      return;
    }
    if (inner && txt(inner, 'visible') === '0' && type !== 'Volta') { this.hiddenSpanners = (this.hiddenSpanners || 0) + 1; }
    const here = { mi: ctx.mi, tick: ctx.cursor, abs: ctx.abs + ctx.cursor, g: ctx.g, vi: owner ? owner.vi : ctx.vi };
    this.spanTags.push({ type, el: inner || null, here, ev: owner ? owner.ev : null, next: next ? this.readLocation(next) : null, prev: prev ? this.readLocation(prev) : null });
  }

  /** 2.x: <HairPin id="3">…</HairPin> at the start position, <endSpanner id="3"/> at the end. */
  startOldSpanner(el, ctx, owner) {
    const id = el.attrs.id;
    if (el.tag === 'Slur') { if (id != null) this.oldDefs.set(id, el); return; }      // slurs are opened/closed by the chords
    if (el.tag === 'Tie') return;
    if (id == null) { this.skip(el.tag); return; }
    const t = kid(el, 'track');
    const vi = t ? (((parseInt(t.text, 10) || 0) % 4) + 4) % 4 : (owner ? owner.vi : ctx.vi);
    this.oldOpen.set(id, { type: el.tag, el, ev: owner ? owner.ev : null, g: ctx.g, vi, abs: ctx.abs + ctx.cursor, mi: ctx.mi });
  }
  endOldSpanner(id, ctx, owner) {
    if (id == null) return;
    const open = this.oldOpen.get(id);
    if (!open) { if (owner && owner.note) owner.note.tieEnd = true; return; }       // inside a note with no open line: the end of a tie
    this.oldOpen.delete(id);
    this.oldDone.push({ ...open, endAbs: ctx.abs + ctx.cursor, endMi: ctx.mi, endEv: owner ? owner.ev : null, endG: ctx.g });
  }
  readOldSlurRef(c, ctx, owner) {
    const id = c.attrs.id, type = c.attrs.type;
    if (id == null) return;
    if (type === 'start') this.oldSlurStart.set(id, owner.ev);
    else if (type === 'stop') { const from = this.oldSlurStart.get(id); if (from) { this.oldSlurs.push({ id, from, to: owner.ev }); this.oldSlurStart.delete(id); } }
  }

  resolveSpanners() {
    const score = this.score, info = this.info;
    const absOf = (mi, tick) => (mi >= info.length ? this.totalTicks + tick : mi < 0 ? tick : info[mi].abs + tick);
    // voices made only of invisible rests are dropped later (finishMeasures) — a line must not hang on them
    const dropped = new Set();
    for (const S of this.staves) for (const data of S.voiceData) for (const v of data || []) if (v.length && v.every(isFiller)) for (const ev of v) dropped.add(ev);
    for (const S of this.staves) S.main = S.events.filter(e => !e.grace && !dropped.has(e.ev)).sort((a, b) => a.abs - b.abs || a.vi - b.vi);
    const lower = (arr, abs) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].abs < abs) lo = mid + 1; else hi = mid; } return lo; };
    const atOrAfter = (g, abs, vi) => {
      const arr = this.staves[g] ? this.staves[g].main : []; let i = lower(arr, abs - EPS);
      if (i >= arr.length) return arr.length ? arr[arr.length - 1] : null;
      const t = arr[i].abs; let best = arr[i];
      for (; i < arr.length && arr[i].abs <= t + EPS; i++) if (arr[i].vi === vi) { best = arr[i]; break; }
      return best;
    };
    const before = (g, abs, vi) => {
      const arr = this.staves[g] ? this.staves[g].main : []; let i = lower(arr, abs - EPS) - 1;
      if (i < 0) return null;
      // the last event that starts before `abs` (a line covers every voice of its staff); same onset → the preferred voice
      for (let k = i; k >= 0 && arr[k].abs >= arr[i].abs - EPS; k--) if (arr[k].vi === vi) return arr[k];
      return arr[i];
    };
    const measureAt = (abs) => { let lo = 0, hi = info.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (info[mid].abs <= abs + EPS) lo = mid; else hi = mid - 1; } return lo; };
    const add = (sp) => { if (sp) score.spanners.push(sp); };
    const line = (type, el, g, vi, startAbs, endAbs, startMi) => {
      if (type === 'Volta') {
        const a = startMi != null ? startMi : measureAt(startAbs), b = Math.max(a, measureAt(endAbs - 2 * EPS));
        return this.makeSpanner(type, el, null, null, score.measures[a], score.measures[b]);
      }
      const from = atOrAfter(g, startAbs, vi); if (!from) return null;
      let to = before(g, endAbs, from.vi);
      if (!to || to.abs < from.abs) to = from;
      return this.makeSpanner(type, el, from.ev, to.ev);
    };

    // --- 3.x / 4.x <Spanner> tags: pair every start with its end
    const ends = new Map();
    const keyOf = (type, sAbs, eAbs, sg, eg) => `${type}|${Math.round(sAbs)}|${Math.round(eAbs)}|${sg}|${eg}`;
    const tags = this.spanTags || [];
    for (const t of tags) {
      if (!t.prev || t.el) continue;
      const sAbs = absOf(t.here.mi + t.prev.measures, t.here.tick + t.prev.ticks);
      const k = keyOf(t.type, sAbs, t.here.abs, t.here.g + t.prev.staves, t.here.g);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(t);
    }
    for (const t of tags) {
      if (!t.el) continue;
      if (txt(t.el, 'visible') === '0' && t.type !== 'Volta') continue;        // hidden lines only affect playback
      const nx = t.next || { measures: 0, ticks: 0, staves: 0, voices: 0 };
      const eAbs = absOf(t.here.mi + nx.measures, t.here.tick + nx.ticks), eg = t.here.g + nx.staves;
      const list = ends.get(keyOf(t.type, t.here.abs, eAbs, t.here.g, eg));
      let end = null;
      if (list && list.length) { const idx = t.ev ? list.findIndex(e => e.ev && e.here.vi === t.here.vi + nx.voices) : -1; end = list.splice(idx >= 0 ? idx : 0, 1)[0]; }
      if (t.type === 'Slur' || t.type === 'Glissando' || t.type === 'GuitarBend' || t.type === 'HammerOnPullOff' || t.type === 'NoteLine') {
        const from = t.ev, to = end && end.ev ? end.ev : (() => { const p = atOrAfter(eg, eAbs, t.here.vi + nx.voices); return p ? p.ev : null; })();
        if (from && to && from !== to) add(this.makeSpanner(t.type, t.el, from, to));
      } else add(line(t.type, t.el, t.here.g, t.here.vi, t.here.abs, eAbs, t.here.mi));
    }
    // --- 2.x: id-based
    for (const s of this.oldSlurs || []) { if (s.from !== s.to) add(this.makeSpanner('Slur', this.oldDefs.get(s.id) || null, s.from, s.to)); }
    for (const d of this.oldDone || []) {
      if (d.el && txt(d.el, 'visible') === '0' && d.type !== 'Volta') continue;
      if (d.type === 'Glissando') { if (d.ev && d.endEv && d.ev !== d.endEv) add(this.makeSpanner('Glissando', d.el, d.ev, d.endEv)); } else add(line(d.type, d.el, d.g, d.vi, d.abs, d.endAbs, d.mi));
    }
    // --- 5.00: <SpannerMap>, elements referenced by eid
    for (const t of this.eidTies || []) {
      const a = this.noteByEid.get(t.start), b = this.noteByEid.get(t.end);
      if (a && b && a !== b) { a.note.tieStart = true; b.note.tieEnd = true; }
    }
    for (const t of this.eidGliss || []) {
      const a = this.noteByEid.get(t.start), b = this.noteByEid.get(t.end);
      if (a && b && a.ev !== b.ev) add(this.makeSpanner('Glissando', t.el, a.ev, b.ev));
    }
    for (const el of (kid(this.root, 'SpannerMap') || { children: [] }).children) {
      if (!SPANNER_TAGS.has(el.tag) || el.tag === 'Tie') continue;
      if (txt(el, 'visible') === '0' && el.tag !== 'Volta') continue;
      const se = txt(el, 'startElement'), ee = txt(el, 'endElement');
      if (el.tag === 'Volta' && se != null) {
        const a = this.measureByEid.get(se), b = this.measureByEid.get(ee);
        if (a != null) add(this.makeSpanner('Volta', el, null, null, score.measures[a], score.measures[Math.max(a, b != null ? b : a)]));
      } else if (se != null || ee != null) {
        const a = this.evByEid.get(se) || this.noteByEid.get(se), b = this.evByEid.get(ee) || this.noteByEid.get(ee);
        if (a && b && a.ev !== b.ev) add(this.makeSpanner(el.tag, el, a.ev, b.ev));
      } else if (has(el, 'startTick')) {
        const track = int(el, 'track', 0), sAbs = fracTicks(txt(el, 'startTick')) || 0, eAbs = sAbs + (fracTicks(txt(el, 'ticks')) || 0);
        add(line(el.tag, el, Math.floor(track / 4), track % 4, sAbs, eAbs, null));
      }
    }
    if (this.hiddenSpanners) this.warn('숨겨진 선(셈여림표·페달 등)은 가져오지 않았습니다');
  }

  makeSpanner(type, el, from, to, fromMeasure, toMeasure) {
    const sp = { id: newId() };
    if (type === 'Volta') {
      if (!fromMeasure || !toMeasure) return null;
      sp.type = 'volta'; sp.from = { measureId: fromMeasure.id }; sp.to = { measureId: toMeasure.id };
      const label = el ? textOf(el, 'beginText') : '';
      const endings = el ? (txt(el, 'endings') || '').split(/[\s,]+/).filter(Boolean) : [];
      sp.number = label || (endings.length ? endings.join('.') + '.' : '1.');
      const closed = el ? (has(el, 'endHookType') ? int(el, 'endHookType', 0) !== 0 : has(el, 'endHook') ? flag(el, 'endHook') : false) : true;
      sp.voltaType = closed ? 'closed' : 'open';
      return sp;
    }
    if (!from || !to) return null;
    sp.from = { eventId: from.id }; sp.to = { eventId: to.id };
    const placement = el ? txt(el, 'placement') : null;
    switch (type) {
      case 'Slur': { sp.type = 'slur'; const up = el ? txt(el, 'up') : null; if (up === 'up') sp.placement = 'above'; else if (up === 'down') sp.placement = 'below'; break; }
      case 'HairPin': {
        const sub = int(el, 'subtype', 0);
        if (sub === 0 || sub === 1) { sp.type = sub === 0 ? 'crescendo' : 'diminuendo'; if (placement === 'above') sp.placement = 'above'; } else { sp.type = 'textLine'; sp.text = textOf(el, 'beginText') || (sub === 2 ? 'cresc.' : 'dim.'); sp.placement = placement === 'above' ? 'above' : 'below'; }
        break;
      }
      case 'Ottava': {
        const sub = (txt(el, 'subtype') || '8va').toLowerCase();
        const shift = { '8va': 8, '8vb': -8, '15ma': 15, '15mb': -15, '22ma': 15, '22mb': -15, 0: 8, 1: 15, 2: -8, 3: -15 }[sub] || 8;
        sp.type = 'ottava'; sp.octaveShift = shift; if (shift < 0) sp.placement = 'below';
        break;
      }
      case 'Pedal': sp.type = 'pedal'; break;
      case 'Trill': sp.type = 'trill'; break;
      case 'Glissando': case 'GuitarBend': case 'NoteLine': sp.type = 'glissando'; break;
      case 'HammerOnPullOff': sp.type = 'slur'; break;
      case 'TextLine': case 'LetRing': case 'PalmMute': case 'GradualTempoChange': {
        sp.type = 'textLine';
        const text = el ? textOf(el, 'beginText') : '';
        const tempoWord = { ritardando: 'rit.', rallentando: 'rall.', accelerando: 'accel.', allargando: 'allarg.', calando: 'calando', lentando: 'lentando', morendo: 'morendo', precipitando: 'precipitando', smorzando: 'smorz.', sostenuto: 'sost.', stringendo: 'string.' }[el ? txt(el, 'tempoChangeType') : ''];
        sp.text = text || tempoWord || (type === 'LetRing' ? 'let ring' : type === 'PalmMute' ? 'P.M.' : type === 'GradualTempoChange' ? 'rit.' : '');
        if (placement === 'below') sp.placement = 'below';
        break;
      }
      default: this.skip(type); return null;
    }
    return sp;
  }

  // ---------- annotations (texts, dynamics, tempo, chord symbols) ----------
  resolveAnnotations(ctx) {
    const m = ctx.m, g = ctx.g;
    const evs = ctx.placed.filter(p => !p.grace);
    const pick = (cands, vi) => cands.find(p => p.vi === vi) || [...cands].sort((a, b) => a.vi - b.vi)[0] || null;
    const at = (tick, vi) => pick(evs.filter(p => Math.abs(p.tick - tick) <= EPS), vi);
    const atOrBefore = (tick, vi) => { const c = evs.filter(p => p.tick <= tick + EPS); if (!c.length) return null; const same = c.filter(p => p.vi === vi); const pool = same.length ? same : c; const t = Math.max(...pool.map(p => p.tick)); return pick(pool.filter(p => p.tick === t), vi); };
    const addText = (p, t) => { const arr = p.ev.texts || (p.ev.texts = []); if (!arr.some(x => x.text === t.text)) arr.push(t); };
    for (const a of ctx.annos) {
      const el = a.el, tag = el.tag;
      if (tag === 'Harmony') { this.addChord(m, a.tick, el); continue; }
      if (tag === 'FretDiagram') { const h = kid(el, 'Harmony'); if (h) this.addChord(m, a.tick, h); else this.skip('FretDiagram'); continue; }
      const invisible = txt(el, 'visible') === '0';
      if (tag === 'Tempo') {
        const t = parseTempo(el, invisible);
        if (t && (!m.tempo || (a.tick <= EPS && !m._tempoAtStart))) { m.tempo = t; if (a.tick <= EPS) m._tempoAtStart = true; }
        continue;
      }
      if (invisible) continue;
      const rawNode = kid(el, 'text');
      const text = rawNode ? textOf(el, 'text') : '';
      if (tag === 'RehearsalMark') { if (text) m.rehearsalMark = text; continue; }
      if (tag === 'Dynamic') {
        const sub = txt(el, 'subtype') || '';
        let dyn = DYN_IN[sub] || DYN_IN[text.replace(/\s+/g, '')], words = '';
        const mixed = !dyn && /^([pmfszr]{1,6})\s+(\S.*)$/.exec(text);              // "mf zögernd": a dynamic followed by words
        if (mixed && DYN_IN[mixed[1]]) { dyn = DYN_IN[mixed[1]]; words = mixed[2]; }
        const p = at(a.tick, a.vi) || atOrBefore(a.tick, a.vi) || evs[0];
        if (!p) continue;
        if (dyn && !p.ev.dynamic) { p.ev.dynamic = dyn; if (words) addText(p, { text: words, placement: txt(el, 'placement') === 'above' ? 'above' : 'below', style: 'expression' }); continue; }
        const label = text || (sub !== 'other-dynamics' ? sub : '');
        if (label) addText(p, { text: label, placement: txt(el, 'placement') === 'above' ? 'above' : 'below', style: 'expression' });
        continue;
      }
      if (!text) continue;
      const styleName = (txt(el, 'style') || '').toLowerCase();
      const italic = tag === 'Expression' || (rawNode && isItalic(rawNode.text)) || flag(el, 'italic') || /expression/.test(styleName);
      const style = tag === 'PlayTechAnnotation' || /technique/.test(styleName) ? 'technique' : italic ? 'expression' : rawNode && isBold(rawNode.text) ? 'technique' : 'plain';
      const placement = txt(el, 'placement') === 'below' ? 'below' : txt(el, 'placement') === 'above' ? 'above' : tag === 'Expression' ? 'below' : 'above';
      if (tag === 'SystemText' && a.tick <= EPS) { const arr = m.texts || (m.texts = []); if (!arr.some(x => x.text === text)) arr.push({ text, placement, style: 'system' }); continue; }
      const p = at(a.tick, a.vi) || (a.tick > EPS ? atOrBefore(a.tick, a.vi) : null);
      if (p && !(p.ev.fullMeasureRest && a.tick <= EPS && evs.length === 1)) addText(p, { text, placement, style });
      else { const arr = m.texts || (m.texts = []); if (!arr.some(x => x.text === text && (x.staffIndex || 0) === g)) arr.push(g ? { text, placement, style, staffIndex: g } : { text, placement, style }); }
    }
  }

  addChord(m, tick, el) {
    if (txt(el, 'visible') === '0') return;
    const info = kid(el, 'harmonyInfo') || el;
    const name = plainOf((kid(info, 'name') || { text: '' }).text).trim();
    const root = has(info, 'root') ? int(info, 'root', NaN) : NaN;
    const bassNode = kid(info, 'bass') || kid(info, 'base');
    const bassTpc = bassNode ? parseInt(bassNode.text, 10) : NaN;
    const spell = (tpc, lower) => { const s = tpcStep(tpc), a = tpcAlter(tpc); return (lower ? s.toLowerCase() : s) + ({ '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[a] || ''); };
    const chord = { id: newId(), tick: Math.max(0, Math.round(tick)), text: '' };
    if (Number.isFinite(root) && root >= -1 && root <= 33) {
      chord.root = spell(root, false);
      const lower = int(info, 'rootCase', 0) === 1;
      const bass = Number.isFinite(bassTpc) && bassTpc >= -1 && bassTpc <= 33 ? spell(bassTpc, false) : '';
      chord.text = (lower ? chord.root[0].toLowerCase() + chord.root.slice(1) : chord.root) + name + (bass ? '/' + bass : '');
      if (name) chord.kind = name;
      if (bass) chord.bass = bass;
      if (!name && has(info, 'extension') && int(info, 'extension', 0) > 1) this.warn('일부 코드 기호의 종류(확장)를 읽지 못했습니다');
    } else {
      if (!name) return;
      chord.text = name;
    }
    const arr = m.chords || (m.chords = []);
    if (!arr.some(c => c.tick === chord.tick && c.text === chord.text)) arr.push(chord);
  }

  // ---------------------------------------------------------------------------
  // 4.5 keys, clefs, voices, beams, finishing
  // ---------------------------------------------------------------------------
  applyKeys() {
    const score = this.score;
    const std = this.staves.filter(S => S.type === 'standard');
    const ref = std.find(S => S.fifthsShift === 0) || std[0] || this.staves[0];
    const perMeasure = (S) => { const out = new Map(); for (const k of S.keys) if (k.mi < score.measures.length) out.set(k.mi, k); return out; };
    const refKeys = perMeasure(ref);
    // staves may change key in different measures (a voice that rests changes later): the first staff of the same transposition that changes wins
    const others = std.filter(S => S !== ref && S.fifthsShift === ref.fifthsShift).map(perMeasure);
    let cur = null;
    for (let mi = 0; mi < score.measures.length; mi++) {
      const k = refKeys.get(mi) || (others.find(o => o.has(mi)) || new Map()).get(mi);
      if (k && (!cur || cur.fifths !== k.fifths || cur.mode !== k.mode)) { score.measures[mi].keySig = { fifths: k.fifths, mode: k.mode }; cur = k; }
    }
    if (!score.measures[0].keySig) score.measures[0].keySig = { fifths: 0, mode: 'major' };
    // other staves in another key = transposing instruments shown with their own key signature in MuseScore
    const keyAt = (map, mi) => { for (let i = mi; i >= 0; i--) if (map.has(i)) return map.get(i).fifths; return 0; };
    for (const S of std) {
      if (S === ref || S.fifthsShift === ref.fifthsShift) continue;
      const mine = perMeasure(S);
      if ([...mine.keys(), ...refKeys.keys()].some(mi => keyAt(mine, mi) !== keyAt(refKeys, mi))) { this.warn('이조 악기처럼 보표마다 조표가 다른 악보입니다 — 조표는 한 가지로 표시되고 음높이는 임시표로 맞춥니다'); break; }
    }
  }

  applyClefs() {
    const score = this.score;
    for (const S of this.staves) {
      if (S.type !== 'standard') continue;
      let cur = S.staff.clef, moved = false;
      const changes = S.clefChanges.filter(c => c.clef !== 'percussion' && c.clef !== 'tab');
      // target measure of every change (a clef inside a measure moves to the nearer barline)
      const byMeasure = new Map();
      for (const c of changes) {
        let mi = c.mi;
        if (c.tick > EPS) { if (c.tick < c.len - EPS) moved = true; if (c.tick >= c.len / 2) mi++; }
        if (mi < score.measures.length) byMeasure.set(mi, c.clef);
      }
      for (let mi = 0; mi < score.measures.length; mi++) {
        if (!byMeasure.has(mi)) continue;
        const clef = byMeasure.get(mi);
        if (mi === 0) { S.staff.clef = clef; cur = clef; continue; }
        if (clef !== cur) { score.measures[mi].staves[S.g].clef = clef; cur = clef; }
      }
      if (moved) this.warn('마디 중간의 음자리표 변경은 가까운 마디 경계로 옮겼습니다');
    }
  }

  finishMeasures() {
    const score = this.score;
    this.anchored = new Set();
    for (const sp of score.spanners) for (const end of [sp.from, sp.to]) if (end && end.eventId) this.anchored.add(end.eventId);
    // "play the previous measure again" signs: copy the notes they stand for
    for (const r of this.repeatMarks || []) {
      const S = this.staves[r.g];
      const k = this.repeatCount.get(`${r.g}:${r.mi}`) || 1;
      const start = r.mi - (clamp(k, 1, r.n) - 1);
      for (let j = 0; j < r.n; j++) {
        const dst = start + j, src = dst - r.n;
        if (src < 0 || dst >= score.measures.length || !S.voiceData[src]) continue;
        S.voiceData[dst] = S.voiceData[src].map(v => v.map(ev => cloneEvent(ev, this.beamInfo)));
      }
      this.warn('마디 반복 기호(%)는 앞 마디의 음표를 복사해 가져왔습니다');
    }
    for (const S of this.staves) {
      for (let mi = 0; mi < score.measures.length; mi++) {
        const data = S.voiceData[mi]; if (!data) continue;
        const len = this.info[mi].len, ts = effectiveTs(score, mi);
        const voices = data.map((v, vi) => {
          if (!v.length) return v;
          if (v.every(isFiller)) return [];
          const single = v.length === 1 && v[0].fullMeasureRest;
          if (!single) {
            const total = voiceTicks(v);
            if (total < len - EPS) for (const r of this.gapRests(len - total)) v.push(r);
            this.completeTuplets(v);
          }
          this.applyBeams(v, ts);
          for (const ev of v) if (ev.notes && ev.notes.length > 1 && S.type === 'standard') ev.notes.sort((a, b) => midiOf(a) - midiOf(b));
          void vi;
          return v;
        });
        while (voices.length > 1 && !voices[voices.length - 1].length) voices.pop();
        score.measures[mi].staves[S.g].voices = voices.length ? voices : [[]];
      }
    }
  }

  /** MuseScore beam modes / beam ids of one voice → explicit `beam` states (left undefined when everything is automatic). */
  applyBeams(voice, ts) {
    const infos = voice.map(ev => this.beamInfo.get(ev));
    if (!infos.some(Boolean)) return;
    const beamable = ev => ev.kind === 'note' && !ev.grace && DUR_TICKS[ev.dur.base] <= DUR_TICKS.eighth;
    const groups = [];
    if (infos.some(b => b && b.beamId)) {                              // 2.x: every beam is listed with its members
      let cur = null, curId = null;
      voice.forEach((ev, i) => {
        const b = infos[i];
        if (ev.grace) return;
        if (!beamable(ev)) { if (ev.kind !== 'rest' || !b || !b.beamId || b.beamId !== curId) { cur = null; curId = null; } return; }
        if (b && b.beamId && b.beamId === curId) cur.push(i);
        else if (b && b.beamId) { cur = [i]; curId = b.beamId; groups.push(cur); } else { cur = null; curId = null; }
      });
    } else {
      const beat = ts.den === 8 && ts.num % 3 === 0 ? 1440 : ts.den === 2 ? 1920 : ts.den >= 8 ? 480 : 960;
      let cur = null, tick = 0;
      voice.forEach((ev, i) => {
        if (ev.grace) return;
        const mode = (infos[i] && infos[i].mode) || 'auto';
        const t = tick; tick += durTicks(ev);
        if (!beamable(ev)) { if (!(ev.kind === 'rest' && cur && /^(mid|begin16|begin32|begin64)$/.test(mode))) cur = null; return; }
        if (mode === 'no') { cur = null; return; }
        if (mode === 'begin') { cur = { idx: [i], start: t, auto: false, tid: null }; groups.push(cur); return; }
        if (mode === 'mid' || mode === 'end' || /^begin(16|32|64)$/.test(mode)) {
          if (cur) { cur.idx.push(i); cur.auto = false; } else { cur = { idx: [i], start: t, auto: false, tid: null }; groups.push(cur); }
          if (mode === 'end') cur = null;
          return;
        }
        const tid = ev.tuplet ? ev.tuplet.id : null;                  // automatic: beam within the beat
        if (cur && Math.floor((cur.start + 1e-6) / beat) === Math.floor((t + 1e-6) / beat) && (cur.tid === tid || !cur.auto)) cur.idx.push(i);
        else { cur = { idx: [i], start: t, auto: true, tid }; groups.push(cur); }
      });
      // like the engraver: plain eighths of one half measure share a beam in 2/4, 4/4 …
      if (ts.den === 4 && ts.num % 2 === 0) {
        const plain8 = g => g.auto && g.idx.every(i => voice[i].dur.base === 'eighth' && !voice[i].dur.dots && !voice[i].tuplet);
        for (let k = groups.length - 1; k > 0; k--) {
          const a = groups[k - 1], b = groups[k];
          if (plain8(a) && plain8(b) && a.idx[a.idx.length - 1] + 1 === b.idx[0] && Math.floor(a.start / 1920) === Math.floor(b.start / 1920)) { a.idx.push(...b.idx); groups.splice(k, 1); }
        }
      }
      for (let k = 0; k < groups.length; k++) groups[k] = groups[k].idx;
    }
    voice.forEach(ev => { if (beamable(ev)) ev.beam = 'none'; });
    for (const g of groups) if (g.length > 1) g.forEach((i, k) => { voice[i].beam = k === 0 ? 'begin' : k === g.length - 1 ? 'end' : 'continue'; });
  }

  finish() {
    const score = this.score;
    const ids = new Set();
    score.measures.forEach((m, mi) => {
      delete m._tempoAtStart;
      const next = score.measures[mi + 1];
      if (m.barlineRight === 'repeat-end' && next && next.barlineLeft === 'repeat-start') { m.barlineRight = 'repeat-both'; delete next.barlineLeft; }
      else if (m.barlineRight === 'repeat-both' && next && next.barlineLeft === 'repeat-start') delete next.barlineLeft;
      if (m.chords) m.chords.sort((a, b) => a.tick - b.tick);
      for (const sm of m.staves) for (const v of sm.voices) for (const ev of v) ids.add(ev.id);
    });
    const mids = new Set(score.measures.map(m => m.id));
    const voltas = new Set();                              // MuseScore 4 repeats system lines on other staves
    score.spanners = score.spanners.filter(sp => {
      if (!sp || !sp.from || !sp.to) return false;
      if (sp.type !== 'volta') return ids.has(sp.from.eventId) && ids.has(sp.to.eventId);
      const k = `${sp.from.measureId}|${sp.to.measureId}`;
      if (!mids.has(sp.from.measureId) || !mids.has(sp.to.measureId) || voltas.has(k)) return false;
      voltas.add(k);
      return true;
    });
    for (const part of score.parts) for (const st of part.staves) if (st.type === 'percussion' && (!st.drumMap || !Object.keys(st.drumMap).length)) st.drumMap = JSON.parse(JSON.stringify(DEFAULT_DRUM_MAP));
    // normalizeImported() empties voices that hold nothing but a whole-measure rest; keep the rests a line starts or ends on
    const anchors = new Set();
    for (const sp of score.spanners) if (sp.type !== 'volta') { anchors.add(sp.from.eventId); anchors.add(sp.to.eventId); }
    const keep = [];
    for (const m of score.measures) for (const sm of m.staves) { const v = sm.voices[0]; if (v.length === 1 && v[0].fullMeasureRest && anchors.has(v[0].id)) keep.push([sm, v[0]]); }
    normalizeImported(score);
    for (const [sm, ev] of keep) if (!sm.voices[0].length) sm.voices[0] = [ev];
    validateScore(score, { repair: true });
    if (this.skipped.size) {
      const list = [...this.skipped.entries()].sort((a, b) => b[1] - a[1]);
      this.warn(`지원하지 않는 요소를 생략했습니다: ${list.slice(0, 6).map(([t, n]) => `${t} ×${n}`).join(', ')}${list.length > 6 ? ` 외 ${list.length - 6}종` : ''}`);
    }
    score.importInfo = { from: 'musescore', version: this.version, program: txt(this.ms, 'programVersion') || '', warnings: [...this.warnings] };
  }
}

const GRACE_TAGS = ['acciaccatura', 'appoggiatura', 'grace4', 'grace16', 'grace32', 'grace8after', 'grace16after', 'grace32after'];
const DOT_FACTOR = [1, 1.5, 1.75, 1.875], DOT_FACTOR_4 = 1.9375;
/** {base, dots} whose length is exactly `ticks`, or null. */
function exactDur(ticks) {
  for (const [base, t] of Object.entries(DUR_TICKS)) for (let dots = 0; dots < 4; dots++) if (Math.abs(t * DOT_FACTOR[dots] - ticks) <= EPS) return { base, dots };
  return null;
}
/** Invisible rest that carries nothing: only there to position other notes. */
const isFiller = e => e.kind === 'rest' && e.hidden && !e.lyrics && !e.texts && !e.dynamic && !e.fermata;
function addMarker(m, kind) { const arr = m.markers || (m.markers = []); if (!arr.includes(kind)) arr.push(kind); }
function cloneEvent(ev, beamInfo) {
  const c = JSON.parse(JSON.stringify(ev));
  c.id = newId();
  for (const n of c.notes || []) { delete n.tieStart; delete n.tieEnd; }
  delete c.lyrics; delete c.texts; delete c.dynamic;
  if (c.fullMeasureRest) delete c.hidden;
  const b = beamInfo.get(ev); if (b) beamInfo.set(c, b);
  return c;
}

/** <Tempo> → measure.tempo. MuseScore stores quarter notes per second plus the text shown. */
function parseTempo(el, invisible) {
  const qps = num(el, 'tempo', 2);
  const raw = (kid(el, 'text') || { text: '' }).text || '';
  let unit = null, dots = 0, words = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === T_SYM) {
      const e = raw.indexOf(T_SYM_END, i); const name = raw.slice(i + 1, e < 0 ? raw.length : e); i = e < 0 ? raw.length : e;
      if (NOTE_SYMS[name]) { if (!unit) unit = NOTE_SYMS[name]; } else if (DOT_SYMS.has(name)) { if (unit) dots++; } else if (name === 'space') words += ' ';
      continue;
    }
    if (ch >= T_I && ch <= T_B_END) continue;
    const cp = raw.codePointAt(i); const full = String.fromCodePoint(cp); if (cp > 0xffff) i++;
    if (NOTE_CHARS[full]) { if (!unit) unit = NOTE_CHARS[full]; } else if (DOT_CHARS.has(full)) { if (unit) dots++; } else words += full;
  }
  const hadGlyph = !!unit;
  const eq = /=\s*(?:ca\.?\s*|c\.\s*)?(\d+(?:[.,]\d+)?)/.exec(words) || (hadGlyph ? /(\d+(?:[.,]\d+)?)/.exec(words) : null);
  if (!unit) { unit = 'quarter'; dots = 0; }
  dots = Math.min(dots, 2);
  const unitQuarters = (DUR_TICKS[unit] * DOT_FACTOR[dots]) / 960;
  let bpm = eq ? parseFloat(eq[1].replace(',', '.')) : (qps * 60) / unitQuarters;
  if (!(bpm > 0)) bpm = 120;
  bpm = Math.round(bpm * 100) / 100;
  let text = words;
  if (eq) text = text.replace(eq[0], ' ');
  text = text.replace(/[()\[\]=]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[\s,–-]+|[\s,–-]+$/g, '');
  if (invisible) return { bpm, beatUnit: unit, dots, text: '', showBpm: false };
  return { bpm, beatUnit: unit, dots, text, showBpm: !!eq };
}

/** First <TimeSig> of a measure that stands before any note or rest (later ones are courtesy signs). */
function leadingTimeSig(mEl) {
  const scan = (list) => {
    for (const c of list) {
      if (c.tag === 'TimeSig') return c;
      if (c.tag === 'Chord' || c.tag === 'Rest' || c.tag === 'tick' || c.tag === 'location' || c.tag === 'RepeatMeasure' || c.tag === 'MeasureRepeat') return null;
    }
    return undefined;
  };
  const direct = scan(mEl.children.filter(c => c.tag !== 'voice'));
  if (direct) return direct;
  const v = kid(mEl, 'voice');
  return v ? scan(v.children) || null : null;
}
function timeSigForTicks(ticks) {
  for (const den of [4, 8, 16, 32, 64]) { const n = (ticks * den) / WHOLE; if (Number.isInteger(n) && n > 0 && n < 100) return { num: n, den }; }
  return null;
}
function effectiveTs(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i].timeSig) return score.measures[i].timeSig;
  return { num: 4, den: 4, display: 'normal' };
}

function guessInstrument(names, stInfos, program) {
  const n = (names || '').toLowerCase();
  if (stInfos[0].type === 'percussion') return stInfos[0].lines === 1 && !/drumset|drum kit|drum set|drum\.group\.set|드럼/.test(n) ? 'rhythm' : 'drumset';
  if (stInfos.every(s => s.type === 'tab')) return 'guitar-tab';
  const table = [
    [/keyboard\.piano|grand-piano|\bpiano|피아노|klavier|pianoforte/, 'piano'],
    [/organ|오르간|harpsichord|celesta|keyboard|키보드|synth|accordion/, 'keyboard'],
    [/voice|vocal|soprano|mezzo|\balto\b|tenor(?! sax| horn| drum| tromb)|baritone(?! sax| horn)|\bbass\b(?! guitar| drum| clar| tromb| flute| sax)|choir|chorus|gesang|canto|chant|soprano|보컬|소프라노|알토|테너|바리톤|합창|노래/, 'voice'],
    [/violoncello|cello|첼로/, 'cello'], [/violin|violine|바이올린/, 'violin'], [/viola(?! da)|비올라|bratsche/, 'viola'],
    [/contrabass|double bass|kontrabass|콘트라베이스/, 'bass'], [/bass guitar|electric bass|pluck\.bass|베이스 기타/, 'bass'],
    [/ukulele|우쿨렐레/, 'ukulele'], [/guitar|gitarre|기타/, 'guitar'],
    [/recorder|리코더|blockfl/, 'recorder'], [/flute|flöte|플루트|piccolo/, 'flute'], [/clarinet|klarinette|클라리넷/, 'clarinet'],
    [/sax|색소폰/, 'saxophone'], [/trumpet|trompete|cornet|flugel|트럼펫/, 'trumpet'],
  ];
  for (const [re, inst] of table) if (re.test(n)) return inst === 'piano' || stInfos.length < 2 || inst === 'keyboard' ? inst : 'piano';
  if (stInfos.length >= 2) return 'piano';
  if (program != null) {
    const hit = Object.entries(INSTRUMENTS).find(([k, d]) => d.program === program && d.type === 'standard' && k !== 'guitar-tab' && k !== 'melody');
    if (hit && program !== 0) return hit[0];
    if (program >= 40 && program < 56) return 'strings';
    if (program >= 56 && program < 64) return 'brass';
    if (program >= 64 && program < 80) return 'woodwind';
  }
  const c = CLEF_IN[stInfos[0].clefName];
  return c === 'bass' ? 'cello' : c === 'alto' ? 'viola' : 'melody';
}


// =================================================================================
// 5. Export — MuseScore 3 format (file version 3.02), read by MuseScore 3.x and 4.x
// =================================================================================
// Exact positions: fractions of a whole note as reduced [numerator, denominator] pairs.
const F0 = [0, 1];
const fr = (n, d) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d); return [n / g, d / g]; };
const frAdd = (a, b) => fr(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const frSub = (a, b) => fr(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const frCmp = (a, b) => a[0] * b[1] - b[0] * a[1];
const frStr = a => `${a[0]}/${a[1]}`;
const frTicks = a => (a[0] * WHOLE) / a[1];
/** Length of an event as a fraction (grace notes: 0). */
function evFrac(ev) {
  if (ev.grace) return F0;
  const dots = Math.min(ev.dur.dots || 0, 3);
  let n = (DUR_TICKS[ev.dur.base] || 960) * ((1 << (dots + 1)) - 1), d = WHOLE * (1 << dots);
  if (ev.tuplet && ev.tuplet.num > 0 && ev.tuplet.den > 0) { n *= ev.tuplet.den; d *= ev.tuplet.num; }
  return fr(n, d);
}
const xmlEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const PITCH_TPC = [14, 21, 16, 11, 18, 13, 20, 15, 10, 17, 12, 19];      // default spelling of a pitch class
const ARTIC_OUT = { staccato: ['articStaccatoAbove'], staccatissimo: ['articStaccatissimoAbove'], accent: ['articAccentAbove'], marcato: ['articMarcatoAbove'],
  tenuto: ['articTenutoAbove'], 'tenuto-staccato': ['articTenutoStaccatoAbove'], 'accent-staccato': ['articAccentStaccatoAbove'], 'marcato-staccato': ['articMarcatoStaccatoAbove'] };
const ORN_OUT = { trill: 'ornamentTrill', turn: 'ornamentTurn', 'inverted-turn': 'ornamentTurnInverted', mordent: 'ornamentMordent', 'inverted-mordent': 'ornamentShortTrill' };
// ScoreDoc instrument → [MuseScore instrument id, MusicXML sound id]
const INSTR_OUT = { piano: ['piano', 'keyboard.piano'], keyboard: ['electric-piano', 'keyboard.piano.electric'], voice: ['voice', 'voice.vocals'],
  melody: ['flute', 'wind.flutes.flute'], guitar: ['guitar-nylon', 'pluck.guitar.nylon-string'], 'guitar-tab': ['guitar-nylon', 'pluck.guitar.nylon-string'],
  bass: ['electric-bass', 'pluck.bass.electric'], violin: ['violin', 'strings.violin'], viola: ['viola', 'strings.viola'], cello: ['violoncello', 'strings.cello'],
  flute: ['flute', 'wind.flutes.flute'], clarinet: ['bb-clarinet', 'wind.reed.clarinet.bflat'], saxophone: ['alto-saxophone', 'wind.reed.saxophone.alto'],
  trumpet: ['bb-trumpet', 'brass.trumpet.bflat'], recorder: ['recorder', 'wind.flutes.recorder'], ukulele: ['ukulele', 'pluck.ukulele'],
  drumset: ['drumset', 'drum.group.set'], rhythm: ['snare-drum', 'drum.snare-drum'], strings: ['strings', 'strings.group'], brass: ['brass', 'brass.group'],
  woodwind: ['winds', 'wind.group'], synth: ['saw-synth', 'synth.tone.sawtooth'] };
const MARKER_OUT = {
  segno: ['Marker', 'Repeat Text Left', '<sym>segno</sym>', { label: 'segno' }], coda: ['Marker', 'Repeat Text Left', '<sym>coda</sym>', { label: 'codab' }],
  fine: ['Marker', 'Repeat Text Right', 'Fine', { label: 'fine' }], toCoda: ['Marker', 'Repeat Text Right', 'To Coda', { label: 'coda' }],
  dc: ['Jump', 'Repeat Text Right', 'D.C.', { jumpTo: 'start', playUntil: 'end', continueAt: '' }],
  dcAlFine: ['Jump', 'Repeat Text Right', 'D.C. al Fine', { jumpTo: 'start', playUntil: 'fine', continueAt: '' }],
  dcAlCoda: ['Jump', 'Repeat Text Right', 'D.C. al Coda', { jumpTo: 'start', playUntil: 'coda', continueAt: 'codab' }],
  ds: ['Jump', 'Repeat Text Right', 'D.S.', { jumpTo: 'segno', playUntil: 'end', continueAt: '' }],
  dsAlFine: ['Jump', 'Repeat Text Right', 'D.S. al Fine', { jumpTo: 'segno', playUntil: 'fine', continueAt: '' }],
  dsAlCoda: ['Jump', 'Repeat Text Right', 'D.S. al Coda', { jumpTo: 'segno', playUntil: 'coda', continueAt: 'codab' }],
};
const GRACE_OUT = { quarter: 'grace4', '16th': 'grace16', '32nd': 'grace32' };

class MsWriter {
  constructor() { this.lines = []; this.depth = 0; }
  get pad() { return '  '.repeat(this.depth); }
  open(tag, attrs = '') { this.lines.push(`${this.pad}<${tag}${attrs}>`); this.depth++; }
  close(tag) { this.depth--; this.lines.push(`${this.pad}</${tag}>`); }
  tag(tag, value, attrs = '') { this.lines.push(`${this.pad}<${tag}${attrs}>${xmlEsc(value)}</${tag}>`); }
  /** element whose content is MuseScore text markup (already escaped where needed) */
  markup(tag, content) { this.lines.push(`${this.pad}<${tag}>${content}</${tag}>`); }
  empty(tag, attrs = '') { this.lines.push(`${this.pad}<${tag}${attrs}/>`); }
  toString() { return this.lines.join('\n') + '\n'; }
}

/**
 * ScoreDoc → MuseScore XML (.mscx) text.
 * `target`: 3 or 4 — both get file format 3.02, which MuseScore 3.6 reads natively and MuseScore 4 converts on opening.
 * `warnings`: optional array; short Korean notes about anything left out or approximated are pushed onto it.
 */
export function exportMscx(score, { target = 3, warnings } = {}) {
  void target;
  const ex = new Exporter(score, Array.isArray(warnings) ? warnings : null);
  return ex.run();
}

/** ScoreDoc → .mscz bytes (zip with META-INF/container.xml and the .mscx). */
export async function exportMscz(score, { JSZip: Z = globalThis.JSZip, target = 3, warnings } = {}) {
  if (!Z) throw new Error('JSZip가 필요합니다 (globalThis.JSZip 또는 옵션으로 주입)');
  const xml = exportMscx(score, { target, warnings });
  const zip = new Z();
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container>\n  <rootfiles>\n    <rootfile full-path="score.mscx">\n      </rootfile>\n    </rootfiles>\n  </container>\n');
  zip.file('score.mscx', xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

class Exporter {
  constructor(score, warnings) {
    this.score = score; this.out = warnings; this.seen = new Set();
    this.w = new MsWriter();
  }
  warn(msg) { if (this.out && !this.seen.has(msg)) { this.seen.add(msg); this.out.push(msg); } }

  run() {
    const score = this.score, w = this.w;
    if (!score || !Array.isArray(score.parts) || !score.parts.length || !Array.isArray(score.measures) || !score.measures.length) throw new Error('내보낼 악보가 비어 있습니다');
    this.prepare();
    w.lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    w.open('museScore', ' version="3.02"');
    w.tag('programVersion', '3.6.2');
    w.tag('programRevision', '3224f34');
    w.open('Score');
    w.lines.push(`${w.pad}<LayerTag id="0" tag="default"></LayerTag>`);
    w.tag('currentLayer', 0);
    w.tag('Division', 480);
    this.writeStyle();
    w.tag('showInvisible', 1); w.tag('showUnprintable', 1); w.tag('showFrames', 1); w.tag('showMargins', 0);
    const meta = score.meta || {};
    const tags = { arranger: meta.arranger, composer: meta.composer, copyright: meta.copyright, creationDate: String(meta.created || new Date().toISOString()).slice(0, 10),
      lyricist: meta.lyricist, movementNumber: '', movementTitle: '', platform: 'JSE', poet: '', source: '', translator: '', workNumber: '', workTitle: meta.title };
    for (const [k, v] of Object.entries(tags)) w.tag('metaTag', v || '', ` name="${k}"`);
    this.staves.forEach(S => { if (S.k === 0) this.writePart(S); });
    for (const S of this.staves) this.writeStaff(S);
    w.close('Score');
    w.close('museScore');
    return w.toString();
  }

  // ---------- analysis ----------
  prepare() {
    const score = this.score;
    // staves
    this.staves = [];
    score.parts.forEach((part, pi) => {
      const chromatic = Math.round(part.transposeChromatic || 0), diatonic = diatonicFor(chromatic);
      (part.staves || []).forEach((staff, k) => this.staves.push({ g: this.staves.length, part, pi, staff, k, type: staff.type || 'standard', chromatic, diatonic, fifthsShift: intervalFifths(diatonic, chromatic) }));
    });
    const nStaves = this.staves.length;
    const std = this.staves.filter(S => S.type === 'standard');
    this.refShift = (std.find(S => S.fifthsShift === 0) || std[0] || { fifthsShift: 0 }).fifthsShift;   // the staff whose key signature the ScoreDoc shows
    // measures: meter, exact length, event positions
    this.M = [];
    this.pos = new Map();                               // event id → { ev, mi, g, vi, idx, tick, dur, grace, notes }
    let ts = { num: 4, den: 4 }, key = { fifths: 0, mode: 'major' };
    const clefNow = this.staves.map(S => S.staff.clef || 'treble');
    score.measures.forEach((m, mi) => {
      if (m.timeSig && m.timeSig.num > 0 && m.timeSig.den > 0) ts = m.timeSig;
      if (m.keySig) key = m.keySig;
      const cap = fr(ts.num, ts.den);
      let content = F0;
      const voices = [];
      for (let g = 0; g < nStaves; g++) {
        const sm = (m.staves && m.staves[g]) || { voices: [[]] };
        const vs = [];
        (sm.voices || [[]]).slice(0, 4).forEach((v, vi) => {
          let t = F0; const list = [];
          const lone = v.length === 1 && v[0].fullMeasureRest;
          let graceRun = 0;
          v.forEach((ev, idx) => {
            const dur = lone ? F0 : evFrac(ev);
            const rec = { ev, mi, g, vi, idx, tick: t, dur, grace: !!ev.grace, graceIndex: ev.grace ? graceRun : -1 };
            graceRun = ev.grace ? graceRun + 1 : 0;
            this.pos.set(ev.id, rec); list.push(rec);
            t = frAdd(t, dur);
          });
          // In MuseScore a grace note belongs to a chord. Grace notes marked as following their note, and those in
          // front of a rest or at the end of the voice, go with the note before them ("grace after"); with no note
          // on either side they cannot be written (a grace chord without its chord, and above all a slur on one,
          // makes MuseScore 3 crash).
          for (let i = 0; i < list.length; i++) {
            if (!list[i].grace) continue;
            let j = i; while (j < list.length && list[j].grace) j++;
            const run = list.slice(i, j), next = list[j], prev = i > 0 ? list[i - 1] : null;
            const prevNote = !!prev && prev.ev.kind === 'note', nextNote = !!next && next.ev.kind === 'note';
            let k = 0;                                               // how many of the run follow the note before them
            if (prevNote) { if (nextNote) { while (k < run.length && run[k].ev.grace.after) k++; } else k = run.length; }
            if (k) {
              let before = 0; for (let q = i - 2; q >= 0 && list[q].grace && !list[q].after && !list[q].dropped; q--) before++;
              prev.afterGraces = run.slice(0, k);
              prev.afterGraces.forEach((r, x) => { r.after = true; r.tick = prev.tick; r.graceIndex = before + x; });
            }
            const lead = run.slice(k);
            if (nextNote) lead.forEach((r, x) => { r.graceIndex = x; });
            else if (lead.length) { for (const r of lead) r.dropped = true; this.warn('기댈 음표가 없는 꾸밈음은 저장하지 않았습니다'); }
            i = j - 1;
          }
          if (!lone && frCmp(t, content) > 0) content = t;
          this.groupTuplets(list);
          vs.push({ list, total: t, lone });
        });
        while (vs.length < 1) vs.push({ list: [], total: F0, lone: false });
        voices.push(vs);
        const c = mi === 0 ? null : sm.clef;
        if (c && c !== clefNow[g]) { clefNow[g] = c; (this.clefChange || (this.clefChange = new Map())).set(`${mi}:${g}`, c); }
      }
      let len = cap;
      if (frCmp(content, cap) > 0) { len = content; this.warn('박자표보다 긴 마디는 길이가 다른 마디(불규칙 마디)로 저장했습니다'); }
      else if (m.pickup && frCmp(content, F0) > 0 && frCmp(content, cap) < 0) len = content;
      this.M.push({ m, mi, ts, key, cap, len, voices, tags: voices.map(() => [[], [], [], []]), newTs: !!m.timeSig || mi === 0, newKey: !!m.keySig || mi === 0 });
    });
    this.chordTags = new Map(); this.noteTags = new Map();
    this.needed = new Set();                            // hidden rests a line or slur starts or ends on: they must be written
    this.prepareSpanners();
    this.prepareTies();
  }

  /** (measure, tick) of an absolute end position: the start of the following measure when it falls on a barline. */
  endPosition(rec) {
    let mi = rec.mi, tick = frAdd(rec.tick, rec.dur);
    const M = this.M[mi];
    if (rec.dur === F0 || frCmp(tick, M.len) >= 0 || (M.voices[rec.g][rec.vi] && M.voices[rec.g][rec.vi].lone)) { if (mi + 1 < this.M.length) { mi++; tick = F0; } else tick = M.len; }
    return { mi, tick };
  }
  location(from, to) {
    const out = [];
    if (to.g !== from.g) out.push(`<staves>${to.g - from.g}</staves>`);
    if (to.vi !== from.vi) out.push(`<voices>${to.vi - from.vi}</voices>`);
    if (to.mi !== from.mi) out.push(`<measures>${to.mi - from.mi}</measures>`);
    const f = frSub(to.tick, from.tick);
    if (f[0] !== 0) out.push(`<fractions>${frStr(f)}</fractions>`);
    if (to.graceIndex != null && to.graceIndex >= 0) out.push(`<grace>${to.graceIndex}</grace>`);
    if ((to.note || 0) !== (from.note || 0)) out.push(`<notes>${(to.note || 0) - (from.note || 0)}</notes>`);
    return out;
  }
  spannerXml(type, inner, dir, loc) {
    const lines = [`<Spanner type="${type}">`];
    if (inner) lines.push(...inner);
    lines.push(`<${dir}>`, '<location>', ...loc, '</location>', `</${dir}>`, '</Spanner>');
    return lines;
  }

  prepareSpanners() {
    const score = this.score;
    const mIndex = new Map(score.measures.map((m, i) => [m.id, i]));
    for (const sp of score.spanners || []) {
      if (!sp || !sp.from || !sp.to) continue;
      if (sp.type === 'volta') {
        const a = mIndex.get(sp.from.measureId), b0 = mIndex.get(sp.to.measureId);
        if (a == null) continue;
        const b = Math.max(a, b0 == null ? a : b0);
        const nums = (String(sp.number || '1.').match(/\d+/g) || ['1']).map(Number);
        let endings = nums;
        if (/-/.test(sp.number || '') && nums.length === 2 && nums[1] > nums[0]) { endings = []; for (let i = nums[0]; i <= nums[1]; i++) endings.push(i); }
        const inner = ['<Volta>', ...(sp.voltaType === 'open' ? [] : ['<endHookType>1</endHookType>']), `<beginText>${xmlEsc(sp.number || '1.')}</beginText>`, `<endings>${endings.join(', ')}</endings>`, '</Volta>'];
        const start = { mi: a, tick: F0, g: 0, vi: 0 };
        const end = b + 1 < this.M.length ? { mi: b + 1, tick: F0, g: 0, vi: 0 } : { mi: b, tick: this.M[b].len, g: 0, vi: 0 };
        this.M[start.mi].tags[0][0].push({ tick: start.tick, pri: 2, lines: this.spannerXml('Volta', inner, 'next', this.location(start, end)) });
        this.M[end.mi].tags[0][0].push({ tick: end.tick, pri: 0, lines: this.spannerXml('Volta', null, 'prev', this.location(end, start)) });
        continue;
      }
      const A = this.pos.get(sp.from.eventId), B = this.pos.get(sp.to.eventId);
      if (!A || !B || A.dropped || B.dropped) continue;
      const add = (map, id, lines) => { if (!map.has(id)) map.set(id, []); map.get(id).push(lines); };
      if (sp.type === 'slur') {
        if (A === B) continue;
        const inner = ['<Slur>', ...(sp.placement === 'above' ? ['<up>up</up>'] : sp.placement === 'below' ? ['<up>down</up>'] : []), '</Slur>'];
        add(this.chordTags, A.ev.id, this.spannerXml('Slur', inner, 'next', this.location(A, B)));
        add(this.chordTags, B.ev.id, this.spannerXml('Slur', null, 'prev', this.location(B, A)));
        this.needed.add(A.ev.id); this.needed.add(B.ev.id);
        continue;
      }
      if (sp.type === 'glissando') {
        if (A === B || A.ev.kind !== 'note' || B.ev.kind !== 'note') continue;
        const na = A.ev.notes.length - 1, nb = B.ev.notes.length - 1;      // between the top notes
        const from = { ...A, note: A.ev.notes.length > 1 ? na : 0 }, to = { ...B, note: B.ev.notes.length > 1 ? nb : 0 };
        const key = (rec, n) => `${rec.ev.id}:${n}`;
        add(this.noteTags, key(A, na), this.spannerXml('Glissando', ['<Glissando>', '<diagonal>1</diagonal>', '<anchor>3</anchor>', '</Glissando>'], 'next', this.location(from, to)));
        add(this.noteTags, key(B, nb), this.spannerXml('Glissando', null, 'prev', this.location(to, from)));
        continue;
      }
      // lines above / below the staff: they start at the first event and end where the last one ends
      let type, inner;
      const place = sp.placement === 'above' || sp.placement === 'below' ? [`<placement>${sp.placement}</placement>`] : [];
      if (sp.type === 'crescendo' || sp.type === 'diminuendo') { type = 'HairPin'; inner = ['<HairPin>', `<subtype>${sp.type === 'crescendo' ? 0 : 1}</subtype>`, ...(sp.placement === 'above' ? place : []), '</HairPin>']; }
      else if (sp.type === 'ottava') { const sh = sp.octaveShift || 8; type = 'Ottava'; inner = ['<Ottava>', `<subtype>${sh === 15 ? '15ma' : sh === -15 ? '15mb' : sh < 0 ? '8vb' : '8va'}</subtype>`, '</Ottava>']; }
      else if (sp.type === 'pedal') { type = 'Pedal'; inner = ['<Pedal>', '<endHookType>1</endHookType>', '<beginText>&lt;sym&gt;keyboardPedalPed&lt;/sym&gt;</beginText>', '<continueText>(&lt;sym&gt;keyboardPedalPed&lt;/sym&gt;)</continueText>', '</Pedal>']; }
      else if (sp.type === 'trill') { type = 'Trill'; inner = ['<Trill>', '<subtype>trill</subtype>', '</Trill>']; }
      else if (sp.type === 'textLine') {
        const text = sp.text || '';
        if (/^cresc/i.test(text) || /^(dim|decresc)/i.test(text)) { type = 'HairPin'; inner = ['<HairPin>', `<subtype>${/^cresc/i.test(text) ? 2 : 3}</subtype>`, ...(sp.placement === 'above' ? place : []), `<beginText>${xmlEsc(xmlEsc(text))}</beginText>`, '</HairPin>']; }
        else { type = 'TextLine'; inner = ['<TextLine>', ...(sp.placement === 'below' ? place : []), ...(text ? [`<beginText>${xmlEsc(xmlEsc(text))}</beginText>`] : []), '</TextLine>']; }
      } else { this.warn('일부 선(스패너)은 MuseScore 형식으로 옮기지 못했습니다'); continue; }
      const first = frCmp([A.mi, 1], [B.mi, 1]) < 0 || (A.mi === B.mi && frCmp(A.tick, B.tick) <= 0) ? A : B, last = first === A ? B : A;
      const start = { mi: first.mi, tick: first.tick, g: first.g, vi: first.vi };
      this.needed.add(first.ev.id);                     // MuseScore drops a line that begins where no note or rest begins
      const e = this.endPosition(last);
      const end = { mi: e.mi, tick: e.tick, g: first.g, vi: first.vi };
      this.M[start.mi].tags[start.g][start.vi].push({ tick: start.tick, pri: 2, lines: this.spannerXml(type, inner, 'next', this.location(start, end)) });
      this.M[end.mi].tags[end.g][end.vi].push({ tick: end.tick, pri: 0, lines: this.spannerXml(type, null, 'prev', this.location(end, start)) });
    }
  }

  /** tieStart → the next note of the same pitch in the voice (ties are spanners between two notes in MuseScore). */
  prepareTies() {
    const key = (rec, n) => `${rec.ev.id}:${n}`;
    const add = (k, lines) => { if (!this.noteTags.has(k)) this.noteTags.set(k, []); this.noteTags.get(k).push(lines); };
    const samePitch = (S, a, b) => (S.type === 'percussion' ? a.drum === b.drum : S.type === 'tab' && a.string ? a.string === b.string && a.fret === b.fret : midiOf(a) === midiOf(b));
    let dangling = 0;
    // notes that begin at a given moment, per part (a tie may lead into another voice or the other staff of a piano part)
    const starts = new Map();
    for (const M of this.M) M.voices.forEach((vs, g) => vs.forEach((v) => { for (const rec of v.list) if (!rec.grace && rec.ev.kind === 'note') { const k = `${this.staves[g].pi}|${M.mi}|${frStr(rec.tick)}`; if (!starts.has(k)) starts.set(k, []); starts.get(k).push(rec); } }));
    const used = new Set();
    // all notes of a part in time order — for ties that skip over other notes (held notes of a broken chord)
    const inOrder = new Map();
    for (const M of this.M) M.voices.forEach((vs, g) => vs.forEach((v) => { for (const rec of v.list) if (!rec.grace && rec.ev.kind === 'note') { const pi = this.staves[g].pi; if (!inOrder.has(pi)) inOrder.set(pi, []); inOrder.get(pi).push(rec); } }));
    for (const list of inOrder.values()) { list.sort((a, b) => a.mi - b.mi || frCmp(a.tick, b.tick)); list.forEach((r, i) => { r.order = i; }); }
    for (const S of this.staves) for (const M of this.M) for (const v of M.voices[S.g]) for (const rec of v.list) {
      if (rec.dropped || rec.ev.kind !== 'note' || !rec.ev.notes.some(n => n.tieStart)) continue;
      let cands;
      if (rec.grace) { const nx = v.list[rec.idx + 1]; cands = nx && nx.ev.kind === 'note' ? [nx] : []; }       // grace note tied to its main note
      else {
        const e = this.endPosition(rec); cands = (starts.get(`${S.pi}|${e.mi}|${frStr(e.tick)}`) || []).slice().sort((a, b) => (a.g === rec.g ? 0 : 1) - (b.g === rec.g ? 0 : 1) || (a.vi === rec.vi ? 0 : 1) - (b.vi === rec.vi ? 0 : 1));
        // a tie that rings on into an (invisible) grace note after the chord — the usual way to write "laissez vibrer"
        if (rec.afterGraces && rec.afterGraces.length && rec.afterGraces[0].ev.kind === 'note' && rec.afterGraces[0].ev.notes.some(x => x.tieEnd)) cands = [rec.afterGraces[0], ...cands];
      }
      rec.ev.notes.forEach((n, i) => {
        if (!n.tieStart) return;
        let hit = null, j = -1;
        for (const c of cands) { const T = this.staves[c.g]; j = c.ev.notes.findIndex((x, xi) => T.type === S.type && samePitch(S, n, x) && !used.has(key(c, xi))); if (j >= 0) { hit = c; break; } }
        if (!hit && !rec.grace && rec.order != null) {
          const list = inOrder.get(S.pi);
          for (let k = rec.order + 1; k < list.length && list[k].mi <= rec.mi + 2 && !hit; k++) {
            const c = list[k]; if (c.mi === rec.mi && frCmp(c.tick, rec.tick) <= 0) continue;
            j = c.ev.notes.findIndex((x, xi) => this.staves[c.g].type === S.type && x.tieEnd && samePitch(S, n, x) && !used.has(key(c, xi)));
            if (j >= 0) hit = c;
          }
        }
        if (!hit) { dangling++; return; }
        used.add(key(hit, j));
        const from = { ...rec, note: rec.ev.notes.length > 1 ? i : 0, graceIndex: -1 }, to = { ...hit, note: hit.ev.notes.length > 1 ? j : 0, graceIndex: hit.after && !rec.grace ? hit.graceIndex : -1 };
        add(key(rec, i), this.spannerXml('Tie', ['<Tie>', '</Tie>'], 'next', this.location(from, to)));
        add(key(hit, j), this.spannerXml('Tie', null, 'prev', this.location(to, { ...from, graceIndex: rec.graceIndex })));
      });
    }
    if (dangling) this.warn('이어질 음이 없는 붙임줄은 저장하지 않았습니다');
  }

  // ---------- header ----------
  writeStyle() {
    const w = this.w, s = this.score.settings || {};
    const inch = mm => round4(mm / MM_PER_INCH);
    const W = s.pageWidthMm || 210, H = s.pageHeightMm || 297, mg = s.marginsMm || { top: 15, bottom: 15, left: 15, right: 15 };
    const sp = s.staffSpaceMm > 0 ? s.staffSpaceMm : 1.75;
    w.open('Style');
    w.tag('pageWidth', inch(W)); w.tag('pageHeight', inch(H));
    w.tag('pagePrintableWidth', inch(Math.max(20, W - (mg.left || 0) - (mg.right || 0))));
    w.tag('pageEvenLeftMargin', inch(mg.left || 0)); w.tag('pageOddLeftMargin', inch(mg.left || 0));
    w.tag('pageEvenTopMargin', inch(mg.top || 0)); w.tag('pageEvenBottomMargin', inch(mg.bottom || 0));
    w.tag('pageOddTopMargin', inch(mg.top || 0)); w.tag('pageOddBottomMargin', inch(mg.bottom || 0));
    w.tag('pageTwosided', 0);
    if (s.staffGapSp > 0) { w.tag('staffDistance', round2(s.staffGapSp)); w.tag('akkoladeDistance', round2(s.staffGapSp)); }
    if (s.systemGapSp > 0) w.tag('minSystemDistance', round2(s.systemGapSp));
    if (s.measureNumbers === 'none') w.tag('showMeasureNumber', 0);
    else if (s.measureNumbers === 'all') { w.tag('measureNumberInterval', 1); w.tag('measureNumberSystem', 0); }
    // text styles (score.settings.textStyles: family, size in staff spaces, bold, italic); legacy settings.fonts as a fallback for the face
    const styles = { ...(s.textStyles || {}) };
    if (s.fonts && s.fonts.text && !(styles.text && styles.text.family)) styles.text = { ...(styles.text || {}), family: s.fonts.text };
    if (s.fonts && s.fonts.lyrics && !(styles.lyrics && styles.lyrics.family)) styles.lyrics = { ...(styles.lyrics || {}), family: s.fonts.lyrics };
    const defaultBold = { title: false, chord: false, tempo: true, rehearsal: true };
    for (const [key, [prefix]] of Object.entries(TEXT_STYLE_MAP)) {
      const st = styles[key]; if (!st || typeof st !== 'object') continue;
      const prefixes = key === 'lyrics' ? ['lyricsOdd', 'lyricsEven'] : key === 'chord' ? ['chordSymbolA', 'chordSymbolB'] : key === 'partName' ? ['longInstrument', 'shortInstrument'] : [prefix];
      for (const p of prefixes) {
        if (typeof st.family === 'string' && st.family.trim() && !/[<>&"]/.test(st.family)) w.tag(p + 'FontFace', st.family.trim());
        if (typeof st.size === 'number' && st.size > 0) w.tag(p + 'FontSize', round2(clamp(st.size * sp / MM_PER_PT, 3, 120)));
        if (typeof st.bold === 'boolean' || typeof st.italic === 'boolean') w.tag(p + 'FontStyle', ((typeof st.bold === 'boolean' ? st.bold : !!defaultBold[key]) ? 1 : 0) + (st.italic ? 2 : 0));
      }
    }
    w.tag('Spatium', round4(sp));
    w.close('Style');
  }

  writePart(S0) {
    const w = this.w, part = S0.part;
    const group = this.staves.filter(S => S.pi === S0.pi);
    const isDrum = group.some(S => S.type === 'percussion');
    const key = String(part.instrument || '');
    let [msId, soundId] = INSTR_OUT[key] || [null, /\./.test(key) ? key : null];
    if (isDrum) { msId = 'drumset'; soundId = 'drum.group.set'; }
    if (key === 'clarinet' && !S0.chromatic) { msId = 'c-clarinet'; soundId = 'wind.reed.clarinet'; }
    if (key === 'trumpet' && !S0.chromatic) { msId = 'c-trumpet'; soundId = 'brass.trumpet'; }
    w.open('Part');
    group.forEach((S, k) => {
      const st = S.staff;
      w.open('Staff', ` id="${S.g + 1}"`);
      if (S.type === 'percussion') {
        w.open('StaffType', ' group="percussion"'); w.tag('name', st.lines === 1 ? 'perc1Line' : 'perc5Line'); if (st.lines === 1) w.tag('lines', 1); w.tag('keysig', 0); w.close('StaffType');
      } else if (S.type === 'tab') {
        const n = (st.tuning && st.tuning.length) || st.lines || 6;
        w.open('StaffType', ' group="tablature"');
        w.tag('name', n === 4 ? 'tab4StrCommon' : n === 5 ? 'tab5StrCommon' : 'tab6StrCommon'); w.tag('lines', n); w.tag('lineDistance', 1.5); w.tag('timesig', 0); w.tag('durations', 0);
        w.tag('durationFontName', 'MuseScore Tab Modern'); w.tag('durationFontSize', 15); w.tag('durationFontY', 0); w.tag('fretFontName', 'MuseScore Tab Serif'); w.tag('fretFontSize', 9);
        w.tag('fretFontY', 0); w.tag('linesThrough', 0); w.tag('minimStyle', 1); w.tag('onLines', 1); w.tag('showRests', 0); w.tag('stemsDown', 1); w.tag('stemsThrough', 0);
        w.tag('upsideDown', 0); w.tag('useNumbers', 1);
        w.close('StaffType');
      } else { w.open('StaffType', ' group="pitched"'); w.tag('name', 'stdNormal'); w.close('StaffType'); }
      const clef = S.type === 'percussion' ? 'PERC' : S.type === 'tab' ? 'TAB' : CLEF_OUT[st.clef] || 'G';
      if (clef !== 'G') w.tag('defaultClef', clef);
      if (k === 0 && group.length > 1) { w.empty('bracket', ` type="1" span="${group.length}" col="0"`); w.tag('barLineSpan', 1); } else if (k < group.length - 1) w.tag('barLineSpan', 1);
      w.close('Staff');
    });
    const name = part.name || '';
    w.tag('trackName', name);
    w.open('Instrument', msId ? ` id="${xmlEsc(msId)}"` : '');
    w.tag('longName', name); w.tag('shortName', part.abbreviation || '');
    w.tag('trackName', name);
    if (S0.chromatic) { w.tag('transposeDiatonic', S0.diatonic); w.tag('transposeChromatic', S0.chromatic); }
    if (soundId) w.tag('instrumentId', soundId);
    if (isDrum) {
      w.tag('useDrumset', 1);
      const map = Object.assign({}, ...group.filter(S => S.type === 'percussion').map(S => S.staff.drumMap || DEFAULT_DRUM_MAP));
      const byPitch = new Map();
      for (const d of Object.values(map)) if (d && Number.isFinite(d.midi) && !byPitch.has(d.midi)) byPitch.set(d.midi, d);
      for (const [pitch, d] of [...byPitch.entries()].sort((a, b) => a[0] - b[0])) {
        w.open('Drum', ` pitch="${pitch}"`);
        w.tag('head', HEAD_OUT[d.head] || 'normal'); w.tag('line', Math.round(d.line || 0)); w.tag('voice', 0); w.tag('name', d.name || ''); w.tag('stem', (d.line || 0) >= 6 ? 2 : 1);
        w.close('Drum');
      }
    }
    group.forEach((S, k) => { const c = CLEF_OUT[S.staff.clef]; if (k > 0 && S.type === 'standard' && c && c !== 'G') w.tag('clef', c, ` staff="${k + 1}"`); });
    const tab = group.find(S => S.type === 'tab');
    if (tab) {
      w.open('StringData'); w.tag('frets', 24);
      for (const t of tab.staff.tuning || ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']) w.tag('string', nameMidi(t));
      w.close('StringData');
    }
    w.open('Channel');
    if (isDrum) w.empty('controller', ' ctrl="0" value="1"');
    w.empty('program', ` value="${isDrum ? 0 : clamp(Math.round(part.midiProgram || 0), 0, 127)}"`);
    if (typeof part.volume === 'number') w.empty('controller', ` ctrl="7" value="${clamp(Math.round(part.volume * 127), 0, 127)}"`);
    if (typeof part.pan === 'number') w.empty('controller', ` ctrl="10" value="${clamp(Math.round(64 + part.pan * 63), 0, 127)}"`);
    w.tag('synti', 'Fluid');
    w.close('Channel');
    w.close('Instrument');
    w.close('Part');
  }

  // ---------- music ----------
  writeStaff(S) {
    const w = this.w, score = this.score;
    w.open('Staff', ` id="${S.g + 1}"`);
    if (S.g === 0) {
      const meta = score.meta || {};
      const texts = [['Title', meta.title], ['Subtitle', meta.subtitle], ['Composer', meta.composer], ['Lyricist', meta.lyricist]].filter(([, t]) => t && String(t).trim());
      if (texts.length) {
        w.open('VBox'); w.tag('height', 10);
        for (const [style, t] of texts) { w.open('Text'); w.tag('style', style); w.tag('text', t); w.close('Text'); }
        w.close('VBox');
      }
    }
    for (const M of this.M) this.writeMeasure(S, M);
    w.close('Staff');
  }

  writeMeasure(S, M) {
    const w = this.w, m = M.m, g = S.g, mi = M.mi, score = this.score;
    const irregular = frCmp(M.len, M.cap) !== 0;
    w.open('Measure', irregular ? ` len="${frStr(M.len)}"` : '');
    const prev = mi > 0 ? this.M[mi - 1].m : null, next = mi + 1 < this.M.length ? this.M[mi + 1].m : null;
    if (g === 0) {
      if (m.barlineLeft === 'repeat-start' || (prev && prev.barlineRight === 'repeat-both')) w.empty('startRepeat');
      if (m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both') w.tag('endRepeat', m.repeatCount > 1 ? Math.round(m.repeatCount) : 2);
      if (irregular && mi === 0 && frCmp(M.len, M.cap) < 0) w.tag('irregular', 1);
      if (m.breaks && (m.breaks.page || m.breaks.system)) { w.open('LayoutBreak'); w.tag('subtype', m.breaks.page ? 'page' : 'line'); w.close('LayoutBreak'); }
      for (const mk of m.markers || []) {
        const def = MARKER_OUT[mk]; if (!def) continue;
        const [el, style, text, props] = def;
        w.open(el); w.tag('style', style); w.markup('text', text);
        for (const [k, v] of Object.entries(props)) w.tag(k, v);
        w.close(el);
      }
    }
    const vs = M.voices[g];
    let nVoices = 1;
    const gap = (rec, vi) => vi > 0 && isFiller(rec.ev) && !(rec.tg && rec.tg.live) && !this.needed.has(rec.ev.id);   // left out, like MuseScore's own gaps
    for (let vi = 0; vi < 4; vi++) if ((vs[vi] && vs[vi].list.some(r => !gap(r, vi))) || M.tags[g][vi].length) nVoices = vi + 1;
    for (let vi = 0; vi < nVoices; vi++) {
      const v = vs[vi] || { list: [], total: F0, lone: false };
      const tags = M.tags[g][vi];
      if (vi > 0 && !tags.length && !v.list.some(r => !gap(r, vi))) { w.empty('voice'); continue; }
      w.open('voice');
      const items = [];                                   // { tick, pri, lines | rec }
      if (vi === 0) this.measureStartItems(S, M, items);
      for (const t of tags) items.push(t);
      if (v.lone || (!v.list.length && vi === 0)) {
        const ev = v.list[0] ? v.list[0].ev : null;
        const lines = ['<Rest>', ...(ev && ev.hidden ? ['<visible>0</visible>'] : []), '<durationType>measure</durationType>', `<duration>${irregular ? frStr(M.len) : `${M.ts.num}/${M.ts.den}`}</duration>`, '</Rest>'];
        if (ev) this.eventAnnotations(S, ev, F0, items);
        if (ev && ev.fermata) items.push({ tick: F0, pri: 3, lines: ['<Fermata>', `<subtype>${ev.fermata === 'below' ? 'fermataBelow' : 'fermataAbove'}</subtype>`, '</Fermata>'] });
        items.push({ tick: F0, pri: 4, lines, advance: M.len });
      } else {
        // a gap in voices 2–4 needs no rest (MuseScore leaves such gaps itself: skipped with <location>),
        // but a tuplet that also holds notes must stay whole and a line needs a rest to begin on — those hidden
        // rests are written as invisible rests
        for (const rec of v.list) {
          if (gap(rec, vi)) continue;
          if (rec.after || rec.dropped) continue;                           // written together with the note they follow
          items.push({ tick: rec.tick, pri: 4, rec, order: rec.idx });
        }
        if (vi === 0 && frCmp(v.total, M.len) < 0) for (const p of this.padding(v.total, M.len)) items.push(p);
      }
      items.sort((a, b) => frCmp(a.tick, b.tick) || a.pri - b.pri || (a.order || 0) - (b.order || 0));
      let cursor = F0, openTuplet = null;
      const closeTuplet = () => { if (openTuplet) { w.empty('endTuplet'); openTuplet = null; } };
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const tg = !it.rec ? null : it.rec.grace ? openTuplet : it.rec.tg || null;      // grace notes stay inside the tuplet of their note
        if (openTuplet && (!it.rec || tg !== openTuplet) && frCmp(it.tick, cursor) !== 0) closeTuplet();
        if (frCmp(it.tick, cursor) !== 0) { closeTuplet(); w.open('location'); w.tag('fractions', frStr(frSub(it.tick, cursor))); w.close('location'); cursor = it.tick; }
        if (it.lines) {
          if (openTuplet && it.pri >= 4) closeTuplet();
          for (const l of it.lines) this.rawLine(l);
          if (it.advance) cursor = frAdd(cursor, it.advance);
          continue;
        }
        const rec = it.rec, ev = rec.ev;
        if (openTuplet && tg !== openTuplet) closeTuplet();
        // things MuseScore writes in front of the chord they belong to
        const pre = []; this.eventAnnotations(S, ev, rec.tick, pre);
        for (const p of pre) for (const l of p.lines) this.rawLine(l);
        if (tg && !rec.grace && !openTuplet) { this.writeTupletStart(tg, rec); openTuplet = tg; }
        if (ev.fermata) { w.open('Fermata'); w.tag('subtype', ev.fermata === 'below' ? 'fermataBelow' : 'fermataAbove'); w.close('Fermata'); }
        for (const g of rec.afterGraces || []) this.writeEvent(S, g);
        this.writeEvent(S, rec);
        cursor = frAdd(cursor, rec.dur);
      }
      closeTuplet();
      if (vi === 0) {
        if (frCmp(cursor, M.len) !== 0) { w.open('location'); w.tag('fractions', frStr(frSub(M.len, cursor))); w.close('location'); }
        const change = this.clefChange && this.clefChange.get(`${mi + 1}:${g}`);
        if (change && S.type === 'standard') { const c = CLEF_OUT[change] || 'G'; w.open('Clef'); w.tag('concertClefType', c); w.tag('transposingClefType', c); w.close('Clef'); }
        let bar = m.barlineRight;
        if (!bar && next && next.barlineLeft === 'double') bar = 'double';
        if ((!bar || bar === 'single') && !next) bar = 'final';
        const sub = { double: 'double', final: 'end', dashed: 'dashed' }[bar];
        if (sub) { w.open('BarLine'); w.tag('subtype', sub); w.close('BarLine'); } else if (bar === 'none') { w.open('BarLine'); w.tag('visible', 0); w.close('BarLine'); }
      }
      w.close('voice');
    }
    w.close('Measure');
    void score;
  }
  rawLine(l) {
    const w = this.w;
    if (/^<\//.test(l)) { w.depth--; w.lines.push(w.pad + l); } else { w.lines.push(w.pad + l); if (/^<[^/!?][^>]*[^/]>$/.test(l) || /^<[A-Za-z]>$/.test(l)) w.depth++; }
  }

  /** Clef, key, meter, tempo, rehearsal mark, chord symbols and measure texts of one staff. */
  measureStartItems(S, M, items) {
    const m = M.m, g = S.g, mi = M.mi;
    const head = [];
    if (mi === 0) { const c = S.type === 'percussion' ? 'PERC' : S.type === 'tab' ? 'TAB' : CLEF_OUT[S.staff.clef] || 'G'; head.push('<Clef>', `<concertClefType>${c}</concertClefType>`, `<transposingClefType>${c}</transposingClefType>`, '</Clef>'); }
    if (M.newKey && S.type === 'standard') {
      // the ScoreDoc shows one key signature; a transposing part gets the key that belongs to its transposition
      const fifths = clamp(wrapFifths((M.key.fifths || 0) + this.refShift - S.fifthsShift), -7, 7);
      if (fifths !== 0 || mi > 0 || M.key.mode === 'minor') head.push('<KeySig>', `<accidental>${fifths}</accidental>`, ...(M.key.mode === 'minor' ? ['<mode>minor</mode>'] : []), '</KeySig>');
    }
    if (M.newTs) head.push('<TimeSig>', ...(M.ts.display === 'common' && M.ts.num === 4 && M.ts.den === 4 ? ['<subtype>1</subtype>'] : M.ts.display === 'cut' && M.ts.num === 2 && M.ts.den === 2 ? ['<subtype>2</subtype>'] : []), `<sigN>${M.ts.num}</sigN>`, `<sigD>${M.ts.den}</sigD>`, '</TimeSig>');
    if (head.length) items.push({ tick: F0, pri: -1, lines: head });
    if (g === 0) {
      if (m.rehearsalMark) items.push({ tick: F0, pri: 1, lines: ['<RehearsalMark>', `<text>${xmlEsc(m.rehearsalMark)}</text>`, '</RehearsalMark>'] });
      if (m.tempo && m.tempo.bpm > 0) {
        const t = m.tempo, unit = DUR_TICKS[t.beatUnit] ? t.beatUnit : 'quarter', dots = Math.min(t.dots || 0, 2);
        const qps = (t.bpm * (DUR_TICKS[unit] * DOT_FACTOR[dots]) / 960) / 60;
        const sym = { breve: 'metNoteDoubleWhole', whole: 'metNoteWhole', half: 'metNoteHalfUp', quarter: 'metNoteQuarterUp', eighth: 'metNote8thUp', '16th': 'metNote16thUp', '32nd': 'metNote32ndUp' }[unit] || 'metNoteQuarterUp';
        const mark = `<sym>${sym}</sym>${'<sym>metAugmentationDot</sym>'.repeat(dots)} = ${xmlEsc(String(Math.round(t.bpm * 100) / 100))}`;
        const shown = t.showBpm !== false;
        const text = (t.text ? xmlEsc(t.text) + (shown ? ' ' : '') : '') + (shown || !t.text ? mark : '');
        items.push({ tick: F0, pri: 1, lines: ['<Tempo>', `<tempo>${Math.round(qps * 1e6) / 1e6}</tempo>`, '<followText>1</followText>', ...(!shown && !t.text ? ['<visible>0</visible>'] : []), `<text>${text}</text>`, '</Tempo>'] });
      }
      for (const ch of m.chords || []) {
        const tick = fr(Math.max(0, Math.round(ch.tick || 0)), WHOLE);
        if (frCmp(tick, M.len) >= 0 && (ch.tick || 0) > 0) { this.warn('마디 밖에 놓인 코드 기호는 저장하지 않았습니다'); continue; }
        items.push({ tick, pri: 1, lines: this.harmonyLines(ch) });
      }
    }
    for (const t of m.texts || []) {
      if ((t.staffIndex || 0) !== g || !t.text) continue;
      items.push({ tick: F0, pri: 1, lines: this.textLines(t, t.style === 'system' ? 'SystemText' : 'StaffText') });
    }
  }
  textLines(t, tag) {
    const body = xmlEsc(t.text);
    const lines = [`<${tag}>`];
    if (t.style === 'expression') lines.push('<style>Expression</style>');
    if (t.placement === 'below') lines.push('<placement>below</placement>');
    lines.push(`<text>${t.style === 'expression' ? `<i>${body}</i>` : t.style === 'technique' ? `<b>${body}</b>` : body}</text>`, `</${tag}>`);
    return lines;
  }
  harmonyLines(ch) {
    const parse = (s) => { const m = /^([A-Ga-g])(bb|b|#|x|##|♯|♭)?$/.exec(s || ''); return m ? tpcOf(m[1].toUpperCase(), { bb: -2, b: -1, '#': 1, x: 2, '##': 2, '♯': 1, '♭': -1 }[m[2]] || 0) : null; };
    let root = ch.root, kind = ch.kind || '', bass = ch.bass || '';
    if (!root) { const m = /^([A-G](?:bb|b|#|x|♯|♭)?)([^/]*)(?:\/([A-G](?:bb|b|#|x|♯|♭)?))?$/.exec((ch.text || '').trim()); if (m) { root = m[1]; kind = m[2] || ''; bass = m[3] || ''; } }
    const rt = parse(root);
    if (rt == null) return ['<Harmony>', `<name>${xmlEsc(ch.text || '')}</name>`, '</Harmony>'];
    const bt = parse(bass);
    return ['<Harmony>', `<root>${rt}</root>`, ...(kind ? [`<name>${xmlEsc(kind)}</name>`] : []), ...(bt != null ? [`<base>${bt}</base>`] : []), '</Harmony>'];
  }
  /** Dynamic and texts of an event (written in front of it). */
  eventAnnotations(S, ev, tick, items) {
    if (ev.dynamic) items.push({ tick, pri: 1, lines: ['<Dynamic>', `<subtype>${xmlEsc(ev.dynamic)}</subtype>`, `<velocity>${DYN_VELOCITY[ev.dynamic] || 80}</velocity>`, '</Dynamic>'] });
    for (const t of ev.texts || []) if (t && t.text) items.push({ tick, pri: 1, lines: this.textLines(t, 'StaffText') });
  }
  /** Invisible rests that complete voice 1 (MuseScore refuses measures whose first voice is too short). */
  padding(from, to) {
    const out = [];
    const gap = frTicks(frSub(to, from));
    let t = from;
    const plain = ticksToDurations(gap);
    const sum = plain.reduce((s, d) => s + DUR_TICKS[d.base] * DOT_FACTOR[d.dots], 0);
    let list = null, tup = null;
    if (Math.abs(sum - gap) < 0.01) list = plain;
    else for (const [n, d] of [[3, 2], [5, 4], [6, 4], [7, 4], [7, 8], [9, 8]]) {
      const nominal = gap * n / d; if (Math.abs(nominal - Math.round(nominal)) > 0.01) continue;
      const ds = ticksToDurations(Math.round(nominal));
      if (Math.abs(ds.reduce((s, x) => s + DUR_TICKS[x.base] * DOT_FACTOR[x.dots], 0) - nominal) < 0.01) { list = ds; tup = [n, d]; break; }
    }
    if (!list) {
      // A length no rest can have (a score with a broken rhythm, e.g. from a scan or a careless MusicXML file).
      // MuseScore calls a file corrupted when the first voice of a measure is not exactly as long as the measure,
      // so the odd part becomes one invisible 128th rest in a tuplet of just the right ratio, the remainder plain rests.
      const g = frSub(to, from), q = Math.floor((g[0] * 128) / g[1]), odd = frSub(g, fr(q, 128));
      if (odd[0] > 0) {
        const ratio = fr(odd[0] * 128, odd[1]);         // length of the rest ÷ a 128th = normal ÷ actual
        out.push({ tick: t, pri: 4, order: 9999, advance: odd, lines: ['<Tuplet>', `<normalNotes>${ratio[0]}</normalNotes>`, `<actualNotes>${ratio[1]}</actualNotes>`, '<baseNote>128th</baseNote>', '<numberType>2</numberType>', '<bracketType>2</bracketType>', '</Tuplet>', '<Rest>', '<visible>0</visible>', '<durationType>128th</durationType>', '</Rest>', '<endTuplet/>'] });
        t = frAdd(t, odd);
      }
      list = q > 0 ? ticksToDurations(q * (WHOLE / 128)) : [];
    }
    for (const d of list) {
      const ev = { id: '', kind: 'rest', dur: { base: d.base, dots: d.dots }, hidden: true };
      const lines = [];
      if (tup) lines.push('<Tuplet>', `<normalNotes>${tup[1]}</normalNotes>`, `<actualNotes>${tup[0]}</actualNotes>`, `<baseNote>${d.base}</baseNote>`, '<numberType>2</numberType>', '<bracketType>2</bracketType>', '</Tuplet>');
      lines.push('<Rest>', '<visible>0</visible>', ...(d.dots ? [`<dots>${d.dots}</dots>`] : []), `<durationType>${d.base}</durationType>`, '</Rest>');
      if (tup) lines.push('<endTuplet/>');
      const dur = evFrac(tup ? { ...ev, tuplet: { num: tup[0], den: tup[1] } } : ev);
      out.push({ tick: t, pri: 4, lines, advance: dur, order: 9999 });
      t = frAdd(t, dur);
    }
    return out;
  }

  /**
   * Decides which events of a voice are written as one <Tuplet>. Normally that is the group the ScoreDoc has
   * (same tuplet id). A group that is not a whole tuplet by itself — a note whose neighbours in the tuplet are
   * invisible rests that came as a group of their own — is joined with the groups of the same ratio after it
   * until the tuplet is whole: MuseScore takes the length of a tuplet from its ratio and base note, and a
   * tuplet that holds less than that loses notes when MuseScore exports the score.
   */
  groupTuplets(list) {
    const main = list.filter(r => !r.grace);
    const nominalOf = r => (DUR_TICKS[r.ev.dur.base] || DUR_TICKS.quarter) * DOT_FACTOR[Math.min(r.ev.dur.dots || 0, 3)];
    let i = 0;
    while (i < main.length) {
      const t = main[i].ev.tuplet;
      if (!t || !(t.num > 0) || !(t.den > 0)) { i++; continue; }
      let j = i, nominal = 0;
      const takeGroup = () => { const id = main[j].ev.tuplet.id; while (j < main.length && main[j].ev.tuplet && main[j].ev.tuplet.id === id) { nominal += nominalOf(main[j]); j++; } };
      takeGroup();
      while (!exactDur(nominal / t.num) && j < main.length && main[j].ev.tuplet && main[j].ev.tuplet.num === t.num && main[j].ev.tuplet.den === t.den) takeGroup();
      const members = main.slice(i, j);
      const lead = members.find(r => !isFiller(r.ev));
      const tg = { t: (lead || members[0]).ev.tuplet, unit: exactDur(nominal / t.num), live: !!lead };
      for (const r of members) r.tg = tg;
      i = j;
    }
  }

  writeTupletStart(tg, rec) {
    const w = this.w, t = tg.t;
    const unit = tg.unit || { base: rec.ev.dur.base, dots: 0 };
    w.open('Tuplet');
    w.tag('normalNotes', t.den); w.tag('actualNotes', t.num); w.tag('baseNote', unit.base);
    if (unit.dots) w.tag('baseDots', unit.dots);
    if (t.show === 'none') w.tag('numberType', 2); else if (t.show === 'ratio') w.tag('numberType', 1);
    if (t.bracket === true) w.tag('bracketType', 1); else if (t.bracket === false) w.tag('bracketType', 2);
    if (t.show !== 'none') { w.open('Number'); w.tag('style', 'Tuplet'); w.tag('text', t.show === 'ratio' ? `${t.num}:${t.den}` : String(t.num)); w.close('Number'); }
    w.close('Tuplet');
  }

  writeEvent(S, rec) {
    const w = this.w, ev = rec.ev;
    const isRest = ev.kind !== 'note' || !ev.notes || !ev.notes.length;
    const base = DUR_TICKS[ev.dur.base] ? ev.dur.base : 'quarter', dots = Math.min(ev.dur.dots || 0, 3);
    const chordTags = this.chordTags.get(ev.id) || [];
    const writeLyrics = () => {
      for (const l of [...(ev.lyrics || [])].sort((a, b) => (a.verse || 1) - (b.verse || 1))) {
        if (!l || l.text == null || l.text === '') continue;
        w.open('Lyrics');
        if ((l.verse || 1) > 1) w.tag('no', l.verse - 1);
        if (l.syllabic === 'begin' || l.syllabic === 'middle' || l.syllabic === 'end') w.tag('syllabic', l.syllabic);
        if (l.extend) { const f = this.melismaLength(rec, l.verse || 1); if (f && f[0] > 0) w.tag('ticks_f', frStr(f)); }
        w.markup('text', xmlEsc(l.text).replace(/‿/g, '<sym>lyricsElision</sym>'));     // ‿ = two syllables on one note
        w.close('Lyrics');
      }
    };
    if (isRest) {
      w.open('Rest');
      if (ev.hidden) w.tag('visible', 0);
      if (dots) w.tag('dots', dots);
      w.tag('durationType', base);
      writeLyrics();
      for (const lines of chordTags) for (const l of lines) this.rawLine(l);
      w.close('Rest');
      return;
    }
    w.open('Chord');
    if (ev.beam && !ev.grace) w.tag('BeamMode', ev.beam === 'begin' ? 'begin' : ev.beam === 'none' ? 'no' : 'mid');
    if (dots && !ev.grace) w.tag('dots', dots);
    if (ev.grace) {
      const tag = rec.after ? { eighth: 'grace8after', '16th': 'grace16after', '32nd': 'grace32after' }[base]
        : base === 'eighth' ? (ev.grace.slash ? 'acciaccatura' : 'appoggiatura') : GRACE_OUT[base];
      w.tag('durationType', tag ? base : 'eighth');
      w.empty(tag || (rec.after ? 'grace8after' : ev.grace.slash ? 'acciaccatura' : 'appoggiatura'));
    } else w.tag('durationType', base);
    writeLyrics();
    for (const lines of chordTags) for (const l of lines) this.rawLine(l);
    for (const a of ev.articulations || []) for (const sub of ARTIC_OUT[a] || []) { w.open('Articulation'); w.tag('subtype', sub); w.close('Articulation'); }
    for (const o of ev.ornaments || []) if (ORN_OUT[o]) { w.open('Articulation'); w.tag('subtype', ORN_OUT[o]); w.close('Articulation'); }
    if (ev.hidden) { w.open('Stem'); w.tag('visible', 0); w.close('Stem'); }
    if (ev.stem === 'up' || ev.stem === 'down') w.tag('StemDirection', ev.stem);
    ev.notes.forEach((n, ni) => this.writeNote(S, rec, n, ni));
    if (ev.arpeggio) { w.open('Arpeggio'); w.tag('subtype', 0); w.close('Arpeggio'); }
    if (ev.tremolo && !ev.grace) { w.open('Tremolo'); w.tag('subtype', ['r8', 'r16', 'r32'][clamp(ev.tremolo, 1, 3) - 1]); w.close('Tremolo'); }
    w.close('Chord');
  }

  writeNote(S, rec, n, ni) {
    const w = this.w, ev = rec.ev, st = S.staff;
    w.open('Note');
    if (ev.hidden) w.tag('visible', 0);
    if (n.color && /^#[0-9a-fA-F]{6}$/.test(n.color)) w.empty('color', ` r="${parseInt(n.color.slice(1, 3), 16)}" g="${parseInt(n.color.slice(3, 5), 16)}" b="${parseInt(n.color.slice(5, 7), 16)}" a="255"`);
    if (n.accidental && ACC_OUT[n.accidental] && S.type === 'standard') { w.open('Accidental'); w.tag('role', 1); w.tag('subtype', ACC_OUT[n.accidental]); w.close('Accidental'); }
    if (n.fingering) { w.open('Fingering'); w.tag('text', n.fingering); w.close('Fingering'); }
    for (const lines of this.noteTags.get(`${ev.id}:${ni}`) || []) for (const l of lines) this.rawLine(l);
    let pitch, tpc, tpc2 = null, head = n.head && HEAD_OUT[n.head];
    if (S.type === 'percussion') {
      const d = (st.drumMap || DEFAULT_DRUM_MAP)[n.drum];
      pitch = d && Number.isFinite(d.midi) ? d.midi : 38;
      tpc = PITCH_TPC[pitch % 12];
      if (d && (!n.head || n.head === d.head)) head = null;
    } else if (S.type === 'tab' && n.string) {
      const tun = st.tuning || ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
      pitch = nameMidi(tun[clamp(tun.length - n.string, 0, tun.length - 1)]) + (n.fret || 0);
      tpc = PITCH_TPC[pitch % 12];
    } else {
      const written = midiOf(n);
      pitch = written + S.chromatic;
      const wt = tpcOf(n.step, n.alter || 0);
      tpc = wt + S.fifthsShift;
      if (tpc < -1 || tpc > 33) tpc = PITCH_TPC[((pitch % 12) + 12) % 12];
      if (S.fifthsShift) tpc2 = wt;
    }
    w.tag('pitch', clamp(Math.round(pitch), 0, 127)); w.tag('tpc', tpc);
    if (tpc2 != null) w.tag('tpc2', tpc2);
    if (S.type === 'tab' && n.string) { w.tag('fret', n.fret || 0); w.tag('string', n.string - 1); }
    if (head) w.tag('head', head);
    w.close('Note');
  }

  /** Length of a lyric extender: from this note to the last note before the next syllable (or rest) of the voice. */
  melismaLength(rec, verse) {
    let lastMi = rec.mi, lastTick = rec.tick, first = true;
    for (let mi = rec.mi; mi < this.M.length && mi < rec.mi + 16; mi++) {
      const v = this.M[mi].voices[rec.g][rec.vi]; if (!v) break;
      for (const r of v.list) {
        if (mi === rec.mi && r.idx <= rec.idx) continue;
        if (r.grace) continue;
        first = false;
        if (r.ev.kind !== 'note' || (r.ev.lyrics || []).some(l => (l.verse || 1) === verse)) return this.span(rec, lastMi, lastTick);
        lastMi = mi; lastTick = r.tick;
      }
      if (v.lone || !v.list.length) break;
    }
    void first;
    return this.span(rec, lastMi, lastTick);
  }
  span(rec, mi, tick) {
    let f = frSub(tick, rec.tick);
    for (let k = rec.mi; k < mi; k++) f = frAdd(f, this.M[k].len);
    return f;
  }
}
