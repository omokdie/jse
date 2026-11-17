// JSE — NoteWorthy Composer binary object stream (file versions 1.30 – 2.05) → NWC document.
//
// Before version 2.75 a .nwc file is a little-endian dump of NWC's objects: a header (song info,
// page setup, font table) followed by the staves, each with its properties, lyric blocks and a
// list of notation objects. Noteworthy never published the layout; it is known from the
// open-source converters (nwc2xml, nwc-viewer, nwc2ly …) and was re-checked here byte by byte
// against real files of every version. The object list is turned into the same structure the
// nwctxt reader produces (see nwc-text.js), so one converter serves every file version.
//
// Version numbers are major*100 + minor as stored in the file: 130, 150, 155, 170, 175 are
// NWC 1.3 – 1.75, 200/201/202 are NWC 2.0 and its betas, 205 is NWC 2.5.

import { decodeBytes } from './nwc-encoding.js';

export const NWC_MAGIC = '[NoteWorthy ArtWare]';
const HEADER = '[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0';

export const DUR_NAMES = ['Whole', 'Half', '4th', '8th', '16th', '32nd', '64th'];
export const CLEFS = ['Treble', 'Bass', 'Alto', 'Tenor', 'Percussion'];
export const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
export const BAR_STYLES = ['Single', 'Double', 'BrokenSingle', 'BrokenDouble', 'SectionOpen', 'SectionClose',
  'LocalRepeatOpen', 'LocalRepeatClose', 'MasterRepeatOpen', 'MasterRepeatClose', 'Transparent'];
// Files up to NWC 2.0 know eight bar lines; from NWC 2.5 (file version 2.05) on the numbering is
// the one nwctxt uses (BAR_STYLES, with the broken and transparent styles). The same split holds
// for tempo variances (2.5 added the caesura), text fonts and the visibility values. Checked on
// ~300 files: with these tables the frequencies per version match those of NWC 2.75 files
// (master repeats common, local repeats rare, fermata the most frequent tempo variance …).
const BAR_STYLES_OLD = ['Single', 'Double', 'SectionOpen', 'SectionClose', 'LocalRepeatOpen', 'LocalRepeatClose', 'MasterRepeatOpen', 'MasterRepeatClose'];
export const FLOW_STYLES = ['Coda', 'Segno', 'Fine', 'ToCoda', 'DaCapo', 'DCalCoda', 'DCalFine', 'DalSegno', 'DSalCoda', 'DSalFine'];
export const TEMPO_BASES = ['Eighth', 'Eighth Dotted', 'Quarter', 'Quarter Dotted', 'Half', 'Half Dotted'];
export const TEMPO_VARIANCES = ['Breath Mark', 'Caesura', 'Fermata', 'Accelerando', 'Allargando', 'Rallentando', 'Ritardando', 'Ritenuto', 'Rubato', 'Stringendo'];
const TEMPO_VARIANCES_OLD = ['Breath Mark', 'Fermata', 'Accelerando', 'Allargando', 'Rallentando', 'Ritardando', 'Ritenuto', 'Rubato', 'Stringendo'];
export const DYN_VARIANCES = ['Crescendo', 'Decrescendo', 'Diminuendo', 'Rinforzando', 'Sforzando'];
export const PERFORMANCE_STYLES = ['Ad Libitum', 'Animato', 'Cantabile', 'Con brio', 'Dolce', 'Espressivo', 'Grazioso', 'Legato', 'Maestoso',
  'Marcato', 'Meno mosso', 'Poco a poco', 'Più mosso', 'Semplice', 'Simile', 'Solo', 'Sostenuto', 'Sotto Voce', 'Staccato', 'Subito',
  'Tenuto', 'Tutti', 'Volta Subito'];
export const FONT_STYLES = ['StaffItalic', 'StaffBold', 'StaffLyric', 'PageTitleText', 'PageText', 'PageSmallText', 'User1', 'User2', 'User3', 'User4', 'User5', 'User6'];
export const TEXT_FONTS_275 = ['StaffSymbols', 'StaffCueSymbols', ...FONT_STYLES];
export const ENDING_BARS = ['Section Close', 'Master Repeat Close', 'Single', 'Double', 'Open (hidden)'];
export const MEASURE_NUMBERS = ['None', 'Plain', 'Circled', 'Boxed'];
export const STAFF_LABELS = ['None', 'First System', 'Top Systems', 'All Systems'];
const VISIBILITY_OLD = ['Default', 'Always', 'TopStaff', 'Never'];
const VISIBILITY = ['Default', 'Always', 'TopStaff', 'SingleStaff', 'MultiStaff', 'Never'];
const ACCIDENTALS = ['#', 'b', 'n', 'x', 'v', ''];
const BOUNDARY_STYLES = ['Reset', 'NewSize', 'Collapse', 'EndCollapse', 'Gap', 'NewSystem'];

export class NwcFormatError extends Error {}

class Reader {
  constructor(bytes, encoding) {
    this.b = bytes; this.p = 0; this.encoding = encoding;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.chunks = [];                          // raw bytes of every text string (for encoding detection)
  }
  need(n) { if (this.p + n > this.b.length) throw new NwcFormatError(`파일이 중간에 끝났습니다 (@${this.p.toString(16)})`); }
  u8() { this.need(1); return this.b[this.p++]; }
  i8() { this.need(1); const v = this.b[this.p++]; return v > 127 ? v - 256 : v; }
  u16() { this.need(2); const v = this.view.getUint16(this.p, true); this.p += 2; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.p, true); this.p += 2; return v; }
  skip(n) { this.need(n); this.p += n; }
  bytes(n) { this.need(n); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  /** NUL-terminated string (bytes). */
  rawz(limit = 65536) {
    const s = this.p; let e = s;
    const max = Math.min(this.b.length, s + limit);
    while (e < max && this.b[e] !== 0) e++;
    if (e >= this.b.length) throw new NwcFormatError(`문자열이 끝나지 않습니다 (@${s.toString(16)})`);
    this.p = e + 1;
    return this.b.subarray(s, e);
  }
  text(raw) { if (raw.length) this.chunks.push(raw); return decodeBytes(raw, this.encoding); }
  strz(limit) { return this.text(this.rawz(limit)); }
}

const isPrintable = (raw) => { for (let i = 0; i < raw.length; i++) if (raw[i] < 0x20 && raw[i] !== 9 && raw[i] !== 10 && raw[i] !== 13) return false; return true; };

/**
 * @param {Uint8Array} bytes  uncompressed file (starts with "[NoteWorthy ArtWare]")
 * @param {string} encoding   TextDecoder label for every text string
 * @returns NWC document: { version, versionNumber, info, page, fonts, staves, codePage, chunks }
 */
export function parseNwcBinary(bytes, encoding = 'windows-1252') {
  for (let i = 0; i < NWC_MAGIC.length; i++) if (bytes[i] !== NWC_MAGIC.charCodeAt(i)) throw new NwcFormatError('NoteWorthy Composer 파일이 아닙니다');
  const head = new Reader(bytes, encoding);
  head.p = HEADER.length;
  const minor = head.u8(), major = head.u8();
  const ver = major * 100 + minor;
  if (ver < 130 || ver > 275) throw new NwcFormatError(`지원하지 않는 NWC 파일 버전입니다 (${major}.${String(minor).padStart(2, '0')})`);
  // A few layout details of the 2.x header are not fixed (extra bytes before the staff count);
  // every plausible reading is tried and the one that parses the whole file wins.
  const attempts = ver >= 200 ? [0, 1, 14, 15, 2, 13, 16] : [0];
  let firstError = null;
  for (const extra of attempts) {
    for (const fontCount of ver === 170 ? [10, 12] : [ver <= 130 ? 0 : ver < 170 ? 10 : 12]) {
      try {
        const doc = parseWith(bytes, encoding, ver, { extra, fontCount });
        return doc;
      } catch (e) {
        if (!(e instanceof NwcFormatError) && !(e instanceof RangeError)) throw e;
        if (parseNwcBinary.trace) parseNwcBinary.trace({ extra, fontCount, error: e.message });
        if (!firstError) firstError = e;
      }
    }
  }
  throw firstError;
}

function parseWith(bytes, encoding, ver, opt) {
  const r = new Reader(bytes, encoding);
  r.p = HEADER.length + 2;
  const doc = { version: `${Math.floor(ver / 100)}.${String(ver % 100).padStart(2, '0')}`, versionNumber: ver, container: 'nwc', codePage: 0,
    info: {}, page: {}, fonts: [], staves: [], chunks: r.chunks };
  const flags = r.bytes(4);
  doc.unregistered = flags[2] === 5;
  r.rawz(256); r.rawz(256);                          // user name, registration id
  const stamp = r.bytes(8);
  if (ver >= 200) doc.codePage = stamp[2] | (stamp[3] << 8);
  r.u16();                                           // size of the song-info block that follows
  const info = doc.info;
  info.title = r.strz(); info.author = r.strz();
  if (ver >= 200) info.lyricist = r.strz();
  info.copyright1 = r.strz(); info.copyright2 = r.strz(); info.comments = r.strz();

  const page = doc.page;
  page.extendLastSystem = r.u8() === 0x59;
  page.durationPadding = r.u8() === 0x59;
  r.skip(5);
  page.barNumbers = MEASURE_NUMBERS[r.u8() & 3];
  r.skip(1);
  page.startingBar = r.i16();
  if (ver >= 130) {
    const raw = r.rawz(128);
    const m = decodeBytes(raw, 'windows-1252').trim().split(/\s+/).map(parseFloat);
    if (m.length !== 4 || m.some(v => !Number.isFinite(v) || v < 0 || v > 100)) throw new NwcFormatError(`페이지 여백을 읽을 수 없습니다 (@${r.p.toString(16)})`);
    // stored in inches as top, inside (left), outside (right), bottom; nwctxt (and this document) uses centimetres
    page.margins = { top: m[0] * 2.54, left: m[1] * 2.54, right: m[2] * 2.54, bottom: m[3] * 2.54 };
    page.marginUnit = 'cm';
  }
  page.mirrorMargins = !!r.u8();
  page.zoom = r.u8(); r.skip(1);
  let visibility = null;
  if (ver > 130) { visibility = r.bytes(32); page.allowLayering = !!r.u8(); }
  // NWC 2: name of the notation typeface (usually empty). Early 2.0 files do not have the field —
  // there the staff size (a small number followed by a zero byte) comes straight away.
  if (ver >= 200 && !(r.b[r.p] !== 0 && r.b[r.p + 1] === 0)) {
    const face = r.rawz(64);
    if (!isPrintable(face)) throw new NwcFormatError('글꼴 정보를 읽을 수 없습니다');
    page.notationTypeface = decodeBytes(face, 'windows-1252');
  }
  page.staffSize = r.i16();
  if (page.staffSize < 4 || page.staffSize > 100) throw new NwcFormatError(`보표 크기를 읽을 수 없습니다 (@${r.p.toString(16)})`);
  for (let i = 0; i < opt.fontCount; i++) {
    const face = r.rawz(64);
    if (!isPrintable(face)) throw new NwcFormatError('글꼴 정보를 읽을 수 없습니다');
    const style = r.u8(), size = r.u8(); r.skip(1); const charSet = r.u8();
    if (size < 1 || size > 127 || style > 3) throw new NwcFormatError('글꼴 정보를 읽을 수 없습니다');
    doc.fonts.push({ style: FONT_STYLES[i], typeface: r.text(face), size, bold: !!(style & 1), italic: !!(style & 2), charSet });
  }
  page.titlePage = !!r.u8();
  page.staffLabels = STAFF_LABELS[r.u8() & 3];
  page.pageNumbers = r.i16();
  r.skip(opt.extra);
  const staffCount = r.i16();
  if (staffCount < 1 || staffCount > 256) throw new NwcFormatError(`보표 수를 읽을 수 없습니다 (@${r.p.toString(16)})`);
  for (let i = 0; i < staffCount; i++) {
    const staff = readStaff(r, ver);
    if (visibility) staff.visible = !!(visibility[i >> 3] & (1 << (i & 7)));
    doc.staves.push(staff);
  }
  // Anything but padding after the last staff means the layout guess was wrong.
  let rest = 0;
  for (let i = r.p; i < bytes.length; i++) if (bytes[i] !== 0) rest++;
  if (rest > 8) throw new NwcFormatError(`마지막 보표 뒤에 해석하지 못한 데이터가 있습니다 (@${r.p.toString(16)})`);
  return doc;
}

function readStaff(r, ver) {
  const st = { name: '', label: '', labelAbbr: '', group: '', visible: true, items: [], lyricLines: [], instrument: {} };
  const names = [];
  for (let i = 0; i < (ver >= 205 ? 5 : ver >= 200 ? 4 : 2); i++) {
    const raw = r.rawz(512);
    if (!isPrintable(raw)) throw new NwcFormatError(`보표 이름을 읽을 수 없습니다 (@${r.p.toString(16)})`);
    names.push(r.text(raw));
  }
  st.name = names[0]; st.group = names[names.length - 1];
  if (ver >= 205) { st.label = names[1]; st.labelAbbr = names[2]; st.instrument.name = names[3]; }
  else if (ver >= 200) { st.label = names[1]; st.instrument.name = names[2]; }

  st.endingBar = ENDING_BARS[r.u8()] || 'Section Close';
  st.muted = !!(r.u8() & 1);
  r.skip(1);
  const channel = r.u8();
  if (channel > 15) throw new NwcFormatError(`보표 정보를 읽을 수 없습니다 (@${r.p.toString(16)})`);
  st.channel = channel + 1;
  r.skip(1);
  st.device = r.u8();
  r.skip(1);
  const selectBank = r.u8();
  const bank = r.bytes(3);
  const patch = r.u8();
  // NWC 2 stores "no patch" as 0 and patch n as n + 1
  if (ver >= 200) { if (patch > 0) st.instrument.patch = patch - 1; } else st.instrument.patch = patch & 127;
  if (selectBank & 1) st.instrument.bank = [bank[0], bank[1]];
  if (ver >= 155) r.skip(1);
  if (ver >= 200) st.instrument.dynVel = [...r.bytes(8)];
  const style = r.i16();
  st.boundaryTop = Math.abs(r.i16()); st.boundaryBottom = Math.abs(r.i16());
  st.lines = ver >= 175 ? r.u8() : 5;
  const layer = r.i16();
  // 1.x: style is Standard / Upper Grand Staff / Lower Grand Staff / Orchestral.
  // 2.x: a bit set — 1 bracket, 2 brace, 4 connect bar lines — each "with the next staff".
  st.withNext = ver >= 200
    ? { bracket: !!(style & 1), brace: !!(style & 2), connectBars: !!(style & 4), layer: !!(layer & 1) }
    : { bracket: style === 3, brace: style === 1, connectBars: style === 1 || style === 3, layer: !!(layer & 1) };
  if (ver < 200) st.style = ['Standard', 'Upper Grand Staff', 'Lower Grand Staff', 'Orchestral'][style] || 'Standard';
  st.instrument.trans = ver >= 150 ? r.i16() : 0;
  st.volume = r.i16(); st.pan = r.i16();
  if (st.volume < -1 || st.volume > 127 || st.pan < -1 || st.pan > 127 || st.lines > 32) throw new NwcFormatError(`보표 정보를 읽을 수 없습니다 (@${r.p.toString(16)})`);
  if (st.volume < 0) st.volume = 127;
  if (st.pan < 0) st.pan = 64;
  let alignSyllable = 1;
  if (ver <= 155) { r.skip(1); st.color = r.u8() & 7; }
  else { st.color = r.u8() & 7; alignSyllable = r.i16(); }
  const numLyric = r.i16();
  if (numLyric < 0 || numLyric > 8) throw new NwcFormatError(`가사 줄 수가 올바르지 않습니다 (@${r.p.toString(16)})`);
  st.lyrics = { placement: 'Bottom', align: alignSyllable === 0 ? 'Start of Accidental/Note' : 'Standard Rules', offset: 0 };
  if (numLyric > 0 && ver >= 150) {
    const placement = r.i16(); const offset = r.i16();
    st.lyrics.placement = placement === 1 ? 'Top' : 'Bottom';
    st.lyrics.offset = offset;
    if (parseNwcBinary.trace) parseNwcBinary.trace({ lyricWord: placement, numLyric, offset, ver });
  }
  for (let i = 0; i < numLyric; i++) {
    const blockSize = r.u16();
    if (!blockSize) { st.lyricLines.push({ text: '', syllables: [] }); continue; }
    const used = r.u16();
    const start = r.p;
    r.need(blockSize);
    if (parseNwcBinary.trace) parseNwcBinary.trace({ lyricBlock: [r.b[start], r.b[start + 1]], blockSize, used, ver });
    st.lyricLines.push(readLyricBlock(r, start, Math.min(used, blockSize)));
    r.p = start + blockSize;
  }
  if (numLyric > 0) { const w = r.u16(); if (parseNwcBinary.trace) parseNwcBinary.trace({ afterLyrics: w, ver }); }
  { const w = r.u16(); if (parseNwcBinary.trace) parseNwcBinary.trace({ beforeCount: w, ver }); }
  let count = r.u16();
  if (ver > 150) count -= 2;
  if (count < 0 || count > 65000) throw new NwcFormatError(`개체 수가 올바르지 않습니다 (@${r.p.toString(16)})`);
  for (let i = 0; i < count; i++) st.items.push(readObject(r, ver, 0));
  return st;
}

/**
 * A lyric block holds the syllables as NWC split them: NUL-terminated strings that begin with
 * the separator typed before the syllable (space, hyphen, line break). Joining them gives the
 * text of the lyric editor; the syllable list is kept so the splitting rules can be checked.
 */
function readLyricBlock(r, start, used) {
  const b = r.b; const end = start + used;
  let p = start + 2;                                  // two leading bytes: flags
  const parts = [];
  while (p < end) {
    let e = p;
    while (e < end && b[e] !== 0) e++;
    if (e > p) parts.push(b.subarray(p, e));
    p = e + 1;
  }
  const total = parts.reduce((n, x) => n + x.length, 0);
  const joined = new Uint8Array(total); let o = 0;
  for (const x of parts) { joined.set(x, o); o += x.length; }
  if (total) r.chunks.push(joined);
  const syllables = parts.map(x => decodeBytes(x, r.encoding));
  // Text as the lyric editor (and nwctxt) shows it: a space inside a syllable was typed as "_".
  let text = '';
  syllables.forEach((s, i) => {
    const m = /^(\r\n|[ \r\n])?([\s\S]*)$/.exec(s);
    const sep = i === 0 && !m[1] ? '' : m[1] === '\n' || m[1] === '\r\n' ? '\n\n' : m[1] === '\r' ? '\n' : (m[1] || '');
    text += sep + m[2].replace(/ /g, '_').replace(/[\r\n]+/g, '\n');
  });
  return { text, syllables };
}

function expression(r, ver) {
  // staff position (stored downward-positive) + placement byte: bit 0 preserve width,
  // bits 1–2 justification, bits 3–4 alignment
  const pos = -r.i8(); const pl = r.u8();
  const o = { pos };
  if (pl & 1) o.wide = true;
  const j = (pl >> 1) & 3; if (j) o.justify = ['Left', 'Center', 'Right'][j] || 'Left';
  const a = (pl >> 3) & 3; if (a) o.placement = ['BestFit', 'BestFitForward', 'AsStaffSignature', 'AtNextNote'][a];
  return o;
}

/** Duration and articulation flags shared by notes, rests and both chord kinds (8 bytes). */
function timed(d, ver, isRest) {
  const dur = { base: Math.min(6, d[0] & 0x0f), dots: 0 };
  const w = d[2];                                     // beam, triplet, stem, slur direction, lyric syllable
  const a0 = d[4], a1 = d[5];
  if (a0 & 0x04) dur.dots = 1; else if (a0 & 0x01) dur.dots = 2;
  const trip = (w >> 2) & 3; if (trip) dur.triplet = ['', 'First', 'Mid', 'End'][trip];
  if (a1 & 0x20) dur.grace = true;
  if (a1 & 0x01) dur.slur = true;
  if (a0 & 0x02) dur.staccato = true;
  if (a0 & 0x20) dur.accent = true;
  if (a1 & 0x04) dur.tenuto = true;
  const opts = {};
  const beam = w & 3; if (beam) opts.beam = ['', 'First', 'Mid', 'End'][beam];
  const stem = (w >> 4) & 3; if (stem === 1) opts.stem = 'Up'; else if (stem === 2) opts.stem = 'Down';
  if (w & 0x80) opts.lyric = 'Always'; else if (d[3] & 0x01) opts.lyric = 'Never';
  if (a1 & 0x80) opts.slurDir = (w & 0x40) ? 'Downward' : 'Upward';
  if (!isRest) { if (a0 & 0x10) opts.tieOut = true; if (a0 & 0x08) opts.tieIn = true; }
  if (ver >= 200) { if (d[3] & 0x04) opts.crescendo = true; if (d[3] & 0x08) opts.diminuendo = true; if (d[3] & 0x10) dur.staccatissimo = true; if (a1 & 0x08) dur.marcato = true; }
  return { dur, opts };
}

function readObject(r, ver, inChord) {
  const at = r.p;
  const type = r.u16();
  if (parseNwcBinary.objLog) parseNwcBinary.objLog.push(at.toString(16) + ':' + type);
  if (type > 23) throw new NwcFormatError(`알 수 없는 개체 형식 ${type} (@${at.toString(16)})`);
  const o = {};
  if (ver >= 170) {
    const v = r.u8();
    const vis = ver >= 205 ? VISIBILITY[v & 7] || 'Default' : VISIBILITY_OLD[v & 3];
    if (vis !== 'Default') o.visibility = vis;
    if (v >> 3) o.color = v >> 3;
  }
  switch (type) {
    case 0: {
      o.type = 'Clef';
      const c = r.u16(), oct = r.u16();
      if (c > 15 || oct > 3) throw new NwcFormatError(`음자리표가 올바르지 않습니다 (@${at.toString(16)})`);
      o.clef = CLEFS[c & 7] || 'Treble'; o.octave = oct === 1 ? 1 : oct === 2 ? -1 : 0;
      break;
    }
    case 1: {
      o.type = 'Key';
      const flat = r.u8(); r.skip(1); const sharp = r.u8(); r.skip(7);
      if (ver >= 205) r.skip(2);
      o.alters = {};
      for (let i = 0; i < 7; i++) { const n = 'ABCDEFG'[i]; if (sharp & (1 << i)) o.alters[n] = 1; else if (flat & (1 << i)) o.alters[n] = -1; }
      break;
    }
    case 2: {
      o.type = 'Bar';
      const s = r.u8(); const rep = r.u8();
      const table = ver >= 205 ? BAR_STYLES : BAR_STYLES_OLD;
      o.style = table[s & 0x3f];
      if (!o.style) throw new NwcFormatError(`세로줄 형식이 올바르지 않습니다 (@${at.toString(16)})`);
      if (s & 0x80) o.sysBreak = true;
      if (s & 0x40) o.xBarCnt = true;                 // excluded from the bar count
      if (/LocalRepeatClose/.test(o.style)) o.repeat = rep || 2;
      break;
    }
    case 3: {
      o.type = 'Ending';
      const s = r.u8(); r.skip(1);
      o.endings = []; for (let i = 0; i < 7; i++) if (s & (1 << i)) o.endings.push(i + 1);
      if (s & 0x80) o.default = true;
      if (ver >= 205) { const x = r.bytes(3); if (x[0] & 1) o.closed = true; }
      break;
    }
    case 4: {
      o.type = 'Instrument';
      if (ver < 170) { const d = r.bytes(6); o.patch = d[4] & 127; }
      else {
        const d = r.bytes(8);
        o.pos = -(d[0] > 127 ? d[0] - 256 : d[0]);
        if (ver >= 200) { o.patch = Math.max(0, (d[6] | (d[7] << 8)) - 1) & 127; o.name = r.strz(256); const t = r.i8(); o.trans = t; o.dynVel = [...r.bytes(8)]; }
        else o.patch = d[6] & 127;
      }
      break;
    }
    case 5: {
      o.type = 'TimeSig';
      const beats = r.i16(), bits = r.i16(), style = r.i16();
      if (beats < 1 || beats > 255 || bits < 0 || bits > 6) throw new NwcFormatError(`박자표가 올바르지 않습니다 (@${at.toString(16)})`);
      o.num = beats; o.den = 1 << bits; o.style = ['Standard', 'Common', 'AllaBreve'][style] || 'Standard';
      break;
    }
    case 6: {
      o.type = 'Tempo';
      Object.assign(o, expression(r, ver));
      o.bpm = r.i16(); o.base = TEMPO_BASES[r.u8()] || 'Quarter';
      if (ver < 170) r.skip(2);
      o.text = r.strz(1024);
      break;
    }
    case 7: {
      o.type = 'Dynamic';
      if (ver >= 170) { Object.assign(o, expression(r, ver)); const s = r.u8(); o.style = DYNAMICS[s & 7]; const vel = r.i16(); r.i16(); if (s & 0x20) o.velocity = vel; }
      else { const s = r.u8(); o.pos = -r.i8(); o.style = DYNAMICS[s & 7]; r.skip(4); }
      break;
    }
    case 8: case 10: {
      let d = r.bytes(8);
      let headStyle = 0;
      if (ver >= 205 && (d[3] & 0x80)) {
        // NWC 2.5: one more byte — the notehead style — sits in front of the staff position
        const more = r.u8();
        headStyle = d[6];
        d = Uint8Array.from([d[0], d[1], d[2], d[3], d[4], d[5], d[7], more]);
      }
      if (ver <= 170) r.skip(type === 8 ? 2 : 4);
      const t = timed(d, ver, false);
      if (ver >= 200 && (d[7] & 0x40)) t.opts.stemLength = r.u8();
      if (d[7] & 0x10) t.opts.muted = true;
      if (type === 8) {
        o.type = 'Note'; o.dur = t.dur; o.opts = t.opts;
        const pos = d[6] > 127 ? d[6] - 256 : d[6];
        const head = { pos: -pos, acc: ACCIDENTALS[d[7] & 7] || '' };
        if (headStyle > 0 && headStyle < 6) head.head = 'oxXzyY'[headStyle];
        if (t.opts.tieOut) head.tie = true;
        if (t.opts.tieIn) head.tieIn = true;
        o.notes = [head];
      } else {
        if (inChord > 1) throw new NwcFormatError(`화음 안에 화음이 있습니다 (@${at.toString(16)})`);
        o.type = 'Chord'; o.dur = t.dur; o.opts = t.opts;
        readMembers(r, ver, o, at, inChord + 1);
        if (!inChord) finishChord(o);
      }
      delete o.opts.tieOut; delete o.opts.tieIn;
      break;
    }
    case 9: case 18: {
      let d = r.bytes(ver <= 150 ? 6 : 8);
      let off;
      if (ver <= 150) { off = d[5] > 127 ? d[5] - 256 : d[5]; d = Uint8Array.from([d[0], d[1], d[2], d[3], d[4], 0, 0, 0]); }   // 1.5: last byte is the offset
      else off = (d[6] | (d[7] << 8)) << 16 >> 16;
      const t = timed(d, ver, true);
      if (off) t.opts.vertOffset = -off;
      o.dur = t.dur; o.opts = t.opts;
      if (type === 9) o.type = 'Rest';
      else {
        if (inChord) throw new NwcFormatError(`화음 안에 화음이 있습니다 (@${at.toString(16)})`);
        o.type = 'RestChord';
        readMembers(r, ver, o, at, 1);
        finishChord(o);
      }
      break;
    }
    case 11: {
      o.type = 'SustainPedal';
      if (ver >= 170) { Object.assign(o, expression(r, ver)); o.released = r.u8() === 0; }
      else { o.pos = -r.i8(); r.skip(2); o.released = r.u8() === 0; }
      break;
    }
    case 12: {
      o.type = 'Flow';
      if (ver >= 170) Object.assign(o, expression(r, ver)); else o.pos = 8;
      o.style = FLOW_STYLES[r.u16()];
      if (!o.style) throw new NwcFormatError(`진행 기호가 올바르지 않습니다 (@${at.toString(16)})`);
      break;
    }
    case 13: {
      o.type = 'MPC';
      Object.assign(o, expression(r, ver));
      r.skip(ver <= 155 ? 30 : 32);
      break;
    }
    case 14: {
      o.type = 'TempoVariance';
      let s;
      if (ver >= 170) { Object.assign(o, expression(r, ver)); s = r.u8(); o.pause = r.u8(); }
      else { s = r.u8() & 0x0f; o.pos = -r.i8(); r.skip(1); o.pause = r.u8(); }
      o.style = (ver >= 205 ? TEMPO_VARIANCES : TEMPO_VARIANCES_OLD)[s & 0x0f];
      if (!o.style) throw new NwcFormatError(`빠르기 변화 기호가 올바르지 않습니다 (@${at.toString(16)})`);
      break;
    }
    case 15: {
      o.type = 'DynamicVariance';
      if (ver >= 170) { Object.assign(o, expression(r, ver)); o.style = DYN_VARIANCES[r.u8() & 7]; }
      else { o.style = DYN_VARIANCES[r.u8() & 7]; o.pos = -r.i8(); }      // 1.5x: style first, like performance styles
      if (!o.style) throw new NwcFormatError(`셈여림 변화 기호가 올바르지 않습니다 (@${at.toString(16)})`);
      break;
    }
    case 16: {
      o.type = 'PerformanceStyle';
      if (ver >= 170) { Object.assign(o, expression(r, ver)); o.style = PERFORMANCE_STYLES[r.u8() & 0x1f]; }
      else { o.style = PERFORMANCE_STYLES[r.u8() & 0x1f]; o.pos = -r.i8(); }
      if (!o.style) throw new NwcFormatError(`연주 표현이 올바르지 않습니다 (@${at.toString(16)})`);
      break;
    }
    case 17: {
      o.type = 'Text';
      let font;
      if (ver >= 170) { Object.assign(o, expression(r, ver)); font = r.u8(); }
      else { font = r.u8() & 0x0f; o.pos = -r.i8(); }
      o.font = (ver >= 205 ? TEXT_FONTS_275 : FONT_STYLES)[font] || 'StaffItalic';
      o.text = r.strz(4096);
      break;
    }
    case 20: {
      o.type = 'Spacer';
      o.width = ver >= 205 ? r.u16() : r.u8();
      r.skip(2);
      break;
    }
    case 21: {
      o.type = 'RestMultiBar';
      o.numBars = r.u16();
      r.skip(1);
      if (o.numBars < 1 || o.numBars > 1000) throw new NwcFormatError(`여러 마디 쉼표가 올바르지 않습니다 (@${at.toString(16)})`);
      break;
    }
    case 22: {
      o.type = 'Boundary';
      const s = r.u8() & 0x0f;
      o.style = BOUNDARY_STYLES[s] || 'Reset';
      if (s === 5) { if (r.u8() & 1) o.newPage = true; } else r.skip(2);
      break;
    }
    default:
      throw new NwcFormatError(`지원하지 않는 개체 형식 ${type} (@${at.toString(16)})`);
  }
  if (inChord && o.type !== 'Note' && o.type !== 'Rest' && o.type !== 'Chord') throw new NwcFormatError(`화음 구성음이 올바르지 않습니다 (@${at.toString(16)})`);
  return o;
}

/**
 * Turns the member list of a binary chord into the nwctxt shape: `notes` with the chord's stem and
 * duration, and — for split-stem chords — `notes2` / `dur2` with the opposite stem. The header of
 * a split chord names the stem of its main group; every member carries its own stem, duration,
 * beam and triplet state.
 */
function finishChord(o) {
  const ms = o.members.flatMap(m => (m.type === 'Chord' ? m.members : [m])).filter(m => m.type === 'Note');
  delete o.members;
  const second = (group) => {
    o.notes2 = group.map(m => m.notes[0]);
    o.dur2 = { ...group[0].dur };
    if (group.some(m => m.dur.slur)) o.dur2.slur = true;
    if (group[0].opts.stem) o.opts.stem2 = group[0].opts.stem;
    if (group[0].opts.beam) o.opts.beam2 = group[0].opts.beam;
  };
  if (o.type === 'RestChord') {
    if (!ms.length) { o.type = 'Rest'; return; }
    second(ms);
    return;
  }
  if (!ms.length) { o.type = 'Rest'; return; }
  const stemOf = (m) => m.opts.stem || '';
  const durOf = (m) => m.dur.base * 4 + m.dur.dots;
  let g1 = ms, g2 = [];
  if (new Set(ms.map(stemOf)).size > 1) {
    const main = ms.some(m => stemOf(m) === (o.opts.stem || '')) ? (o.opts.stem || '') : stemOf(ms[0]);
    g1 = ms.filter(m => stemOf(m) === main); g2 = ms.filter(m => stemOf(m) !== main);
  } else if (new Set(ms.map(durOf)).size > 1) {
    const main = ms.some(m => durOf(m) === durOf(o)) ? durOf(o) : durOf(ms[0]);
    g1 = ms.filter(m => durOf(m) === main); g2 = ms.filter(m => durOf(m) !== main);
  }
  o.notes = g1.map(m => m.notes[0]);
  o.dur = { ...o.dur, base: g1[0].dur.base, dots: g1[0].dur.dots };
  if (g1[0].dur.triplet) o.dur.triplet = g1[0].dur.triplet; else delete o.dur.triplet;
  if (g1.some(m => m.dur.slur)) o.dur.slur = true;
  if (g1[0].opts.stem) o.opts.stem = g1[0].opts.stem;
  if (g1[0].opts.beam) o.opts.beam = g1[0].opts.beam; else delete o.opts.beam;
  if (g2.length) second(g2);
}

/**
 * Members of a chord / rest chord: complete Note objects with their own duration and stem.
 * A rest chord may hold a whole Chord object as its member.
 */
function readMembers(r, ver, o, at, depth) {
  const n = r.u16();
  if (n < 1 || n > 64) throw new NwcFormatError(`화음 구성음 수가 올바르지 않습니다 (@${at.toString(16)})`);
  o.members = [];
  for (let i = 0; i < n; i++) o.members.push(readObject(r, ver, depth));
}
