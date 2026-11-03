// MusicXML import/export for JSE (SPEC.md §5). Pure JS: no DOM — a small tolerant XML
// parser is included so the module behaves identically in the browser, in a Worker and in Node.
// Data model: SPEC.md §2 (helpers from model/score.js). All ticks use TPQ = 960.

import {
  TPQ, DUR_TICKS, DUR_BASES, newId, durTicks, baseTicks, measureCapacity, voiceTicks,
  midiOf, DEFAULT_DRUM_MAP, INSTRUMENTS, validateScore, createScore, createPart, createStaff,
  createMeasure, effectiveKeySig, effectiveClef, staffList, staffPosition, noteAtStaffPosition,
  ticksToDurations, makeRest,
} from '../model/score.js';

// =================================================================================
// 1. Minimal XML parser → { tag, attrs, children, text }
//    `children` holds element nodes only; `text` is the concatenated direct text content
//    (entities decoded). Tolerant of declarations, DOCTYPE (with internal subset),
//    comments, CDATA and mismatched closing tags.
// =================================================================================
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = /^#[xX]/.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] != null ? NAMED_ENTITIES[body] : m;
  });
}

function bytesToString(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8.buffer || u8);
  return new TextDecoder('utf-8').decode(u8);
}

export function parseXML(src) {
  if (typeof src !== 'string') src = bytesToString(src);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const doc = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const lt = src.indexOf('<', i);
    if (lt < 0) { top.text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) { i = skipDeclaration(src, lt); continue; }
    if (src[lt + 1] === '/') {                       // closing tag: pop to the matching element
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break; }
      i = e < 0 ? n : e + 1; continue;
    }
    const { node, end, selfClosing } = parseTag(src, lt);
    top.children.push(node);
    if (!selfClosing) stack.push(node);
    i = end;
  }
  return doc;
}

/** Skips `<!DOCTYPE … [ internal subset ] >` honouring brackets and quotes. */
function skipDeclaration(src, lt) {
  let j = lt + 2, depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return j + 1;
    else if (c === '"' || c === "'") { const e = src.indexOf(c, j + 1); j = e < 0 ? src.length : e; }
    j++;
  }
  return src.length;
}

function parseTag(src, lt) {
  const n = src.length;
  let j = lt + 1;
  while (j < n && !/[\s/>]/.test(src[j])) j++;
  const node = { tag: src.slice(lt + 1, j), attrs: {}, children: [], text: '' };
  let selfClosing = false;
  for (;;) {
    while (j < n && /\s/.test(src[j])) j++;
    if (j >= n) return { node, end: n, selfClosing: true };
    if (src[j] === '>') { j++; break; }
    if (src[j] === '/') { selfClosing = true; j++; continue; }
    let k = j;
    while (k < n && !/[\s=/>]/.test(src[k])) k++;
    const name = src.slice(j, k);
    j = k;
    while (j < n && /\s/.test(src[j])) j++;
    let value = '';
    if (src[j] === '=') {
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); value = src.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; }
      else { k = j; while (k < n && !/[\s>]/.test(src[k])) k++; value = src.slice(j, k); j = k; }
    }
    if (name) node.attrs[name] = decodeEntities(value);
  }
  return { node, end: j, selfClosing };
}

// Node query helpers
const kids = (node, tag) => (node ? node.children.filter(c => c.tag === tag) : []);
const kid = (node, tag) => (node ? node.children.find(c => c.tag === tag) : undefined);
const txt = (node, tag) => { const c = tag == null ? node : kid(node, tag); return c ? c.text.trim() : undefined; };
const num = (node, tag, def) => { const t = txt(node, tag); const v = t == null || t === '' ? NaN : parseFloat(t); return Number.isFinite(v) ? v : def; };
const attr = (node, name, def) => (node && node.attrs[name] != null ? node.attrs[name] : def);
const has = (node, tag) => !!kid(node, tag);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = v => Math.round(v * 100) / 100;
const round4 = v => Math.round(v * 10000) / 10000;

// =================================================================================
// 2. Format detection
// =================================================================================
export function detectFormat(input) {
  if (input == null) return 'unknown';
  if (typeof input !== 'string') {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4) return 'mxl';
    input = bytesToString(u8.subarray(0, 8192));
  }
  const head = input.slice(0, 8192);
  if (head.startsWith('PK\u0003\u0004')) return 'mxl';
  return /<score-(partwise|timewise)[\s>]/.test(head) || /<!DOCTYPE\s+score-(partwise|timewise)/.test(head) ? 'musicxml' : 'unknown';
}

// =================================================================================
// 3. Mapping tables (MusicXML vocabulary ↔ ScoreDoc vocabulary)
// =================================================================================
const XML_TYPE_TO_BASE = {
  maxima: 'breve', long: 'breve', breve: 'breve', whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth',
  '16th': '16th', '32nd': '32nd', '64th': '64th', '128th': '128th', '256th': '128th', '512th': '128th', '1024th': '128th',
};
// ClefType → [sign, line, octave-change]
const CLEF_TO_XML = {
  treble: ['G', 2, 0], treble8vb: ['G', 2, -1], treble8va: ['G', 2, 1], bass: ['F', 4, 0], bass8vb: ['F', 4, -1],
  alto: ['C', 3, 0], tenor: ['C', 4, 0], percussion: ['percussion', null, 0], tab: ['TAB', 5, 0],
};
function clefFromXML(sign, line, oct) {
  sign = (sign || 'G').toUpperCase();
  if (sign === 'PERCUSSION') return 'percussion';
  if (sign === 'TAB') return 'tab';
  if (sign === 'F') return oct < 0 ? 'bass8vb' : 'bass';
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto';
  if (oct < 0) return 'treble8vb';
  if (oct > 0) return 'treble8va';
  return 'treble';
}
const ART_IN = { staccato: 'staccato', staccatissimo: 'staccatissimo', spiccato: 'staccatissimo', accent: 'accent',
  'strong-accent': 'marcato', tenuto: 'tenuto', 'detached-legato': 'tenuto-staccato' };
const ART_OUT = { staccato: ['staccato'], staccatissimo: ['staccatissimo'], accent: ['accent'], marcato: ['strong-accent'],
  tenuto: ['tenuto'], 'tenuto-staccato': ['detached-legato'], 'accent-staccato': ['accent', 'staccato'],
  'marcato-staccato': ['strong-accent', 'staccato'] };
const ORN_IN = { 'trill-mark': 'trill', turn: 'turn', 'inverted-turn': 'inverted-turn', mordent: 'mordent', 'inverted-mordent': 'inverted-mordent' };
const ORN_OUT = { trill: 'trill-mark', turn: 'turn', 'inverted-turn': 'inverted-turn', mordent: 'mordent', 'inverted-mordent': 'inverted-mordent' };
const DYNAMICS = new Set(['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'sfp', 'fp', 'fz', 'rfz']);
const ACC_IN = { sharp: 'sharp', flat: 'flat', natural: 'natural', 'double-sharp': 'double-sharp', 'sharp-sharp': 'double-sharp',
  'flat-flat': 'double-flat', 'double-flat': 'double-flat', 'natural-sharp': 'sharp', 'natural-flat': 'flat' };
const ACC_OUT = { sharp: 'sharp', flat: 'flat', natural: 'natural', 'double-sharp': 'double-sharp', 'double-flat': 'flat-flat' };
const HEAD_IN = { normal: 'normal', x: 'x', 'circle-x': 'circle-x', diamond: 'diamond', triangle: 'triangle',
  'inverted triangle': 'triangle', square: 'square', slash: 'slash', cross: 'plus' };
const HEAD_OUT = { x: ['x'], 'circle-x': ['circle-x'], diamond: ['diamond', 'no'], 'diamond-black': ['diamond', 'yes'],
  triangle: ['triangle', 'no'], 'triangle-black': ['triangle', 'yes'], square: ['square'], slash: ['slash'], plus: ['cross'] };
// [MusicXML kind, short chord-symbol text]
const KINDS = [
  ['major', ''], ['minor', 'm'], ['augmented', 'aug'], ['diminished', 'dim'], ['dominant', '7'], ['major-seventh', 'maj7'],
  ['minor-seventh', 'm7'], ['diminished-seventh', 'dim7'], ['augmented-seventh', 'aug7'], ['half-diminished', 'm7b5'],
  ['major-minor', 'mMaj7'], ['major-sixth', '6'], ['minor-sixth', 'm6'], ['dominant-ninth', '9'], ['major-ninth', 'maj9'],
  ['minor-ninth', 'm9'], ['dominant-11th', '11'], ['major-11th', 'maj11'], ['minor-11th', 'm11'], ['dominant-13th', '13'],
  ['major-13th', 'maj13'], ['minor-13th', 'm13'], ['suspended-second', 'sus2'], ['suspended-fourth', 'sus4'], ['power', '5'],
];
const KIND_SHORT = Object.fromEntries(KINDS);
const KINDS_BY_LENGTH = [...KINDS].sort((a, b) => b[1].length - a[1].length);
const MARKER_WORDS = [
  [/^d\.?\s*s\.?\s*al\s*coda/i, 'dsAlCoda'], [/^d\.?\s*s\.?\s*al\s*fine/i, 'dsAlFine'],
  [/^d\.?\s*c\.?\s*al\s*coda/i, 'dcAlCoda'], [/^d\.?\s*c\.?\s*al\s*fine/i, 'dcAlFine'],
  [/^(d\.?\s*s\.?|dal\s*segno)$/i, 'ds'], [/^(d\.?\s*c\.?|da\s*capo)$/i, 'dc'], [/^to\s*coda/i, 'toCoda'], [/^fine$/i, 'fine'],
];
const MARKER_TEXT = { fine: 'Fine', toCoda: 'To Coda', dsAlCoda: 'D.S. al Coda', dsAlFine: 'D.S. al Fine',
  dcAlCoda: 'D.C. al Coda', dcAlFine: 'D.C. al Fine', ds: 'D.S.', dc: 'D.C.' };
const MARKER_SOUND = { dsAlCoda: { dalsegno: 'segno' }, dsAlFine: { dalsegno: 'segno' }, ds: { dalsegno: 'segno' },
  dcAlCoda: { dacapo: 'yes' }, dcAlFine: { dacapo: 'yes' }, dc: { dacapo: 'yes' }, fine: { fine: 'yes' }, toCoda: { tocoda: 'coda' } };
const INSTRUMENT_SOUND = { piano: 'keyboard.piano', keyboard: 'keyboard.piano.electric', voice: 'voice.vocals', guitar: 'pluck.guitar',
  'guitar-tab': 'pluck.guitar', bass: 'pluck.bass.electric', violin: 'strings.violin', viola: 'strings.viola', cello: 'strings.cello',
  flute: 'wind.flutes.flute', clarinet: 'wind.reed.clarinet', saxophone: 'wind.reed.saxophone', trumpet: 'brass.trumpet',
  recorder: 'wind.flutes.recorder', ukulele: 'pluck.ukulele', drumset: 'drum.group.set' };
const PAGE_SIZES = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420], B5: [176, 250] };
const DRUM_NAME_RULES = [
  [/kick|bass\s*drum/i, 'kick'], [/rim/i, 'rimshot'], [/snare/i, 'snare'], [/pedal|foot/i, 'hihat-pedal'],
  [/open/i, 'hihat-open'], [/hi-?\s*hat/i, 'hihat-closed'], [/crash/i, 'crash'], [/bell/i, 'ride-bell'], [/ride/i, 'ride'],
  [/china/i, 'china'], [/splash/i, 'splash'], [/cowbell/i, 'cowbell'], [/floor/i, 'floor-tom'],
  [/(high|hi)\b.*tom|tom.*\b(1|high|hi)\b/i, 'tom-high'], [/(low|lo)\b.*tom|tom.*\b(3|low|lo)\b/i, 'tom-low'], [/tom/i, 'tom-mid'],
];

const ALTER_TEXT = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' };
const stepAlterText = (step, alter) => (step || 'C') + (ALTER_TEXT[Math.round(alter || 0)] || '');
function parseStepAlter(s) {
  const m = /^([A-G])(bb|b|#|x|##)?$/.exec(s || '');
  return m ? { step: m[1], alter: { bb: -2, b: -1, '#': 1, x: 2, '##': 2 }[m[2]] || 0 } : null;
}
/** Chord degree list → canonical suffix text ("add9", "b5", "no3"). */
function degreeSuffix(degrees) {
  return degrees.map(d => {
    const alt = d.alter > 0 ? '#'.repeat(d.alter) : d.alter < 0 ? 'b'.repeat(-d.alter) : '';
    if (d.type === 'add') return 'add' + alt + d.value;
    if (d.type === 'subtract') return 'no' + d.value;
    return alt + d.value;
  }).join('');
}
/** Inverse of degreeSuffix for the remainder of a kind string. */
function parseDegrees(s) {
  const out = [];
  const re = /(add|no|omit)?(#+|b+)?(\d+)/g;
  let m;
  while ((m = re.exec(s || ''))) {
    const alter = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
    out.push({ value: parseInt(m[3], 10), alter, type: m[1] === 'add' ? 'add' : m[1] ? 'subtract' : 'alter' });
  }
  return out;
}
/** Split a ScoreDoc chord.kind ("m7b5", "7add9") into [musicxml kind, degrees]. */
function splitKind(kind) {
  kind = kind || '';
  for (const [mx, short] of KINDS_BY_LENGTH) if (short && kind.startsWith(short)) return [mx, parseDegrees(kind.slice(short.length))];
  return ['major', parseDegrees(kind)];
}

function instrumentFromProgram(program, { percussion, tab, staves }) {
  if (percussion) return 'drumset';
  if (tab) return 'guitar-tab';
  if (staves > 1) return 'piano';
  const hit = Object.entries(INSTRUMENTS).find(([k, d]) => d.program === program && d.type === 'standard' && k !== 'guitar-tab');
  if (hit) return hit[0];
  if (program < 8) return 'piano';
  if (program < 24) return 'keyboard';
  if (program < 32) return 'guitar';
  if (program < 40) return 'bass';
  if (program < 56) return 'strings';
  if (program < 64) return 'brass';
  if (program < 80) return 'woodwind';
  return 'synth';
}

/** Best {base, dots} for a tick length (exact when possible, otherwise nearest). */
function inferDuration(ticks, ratio = 1) {
  let best = null;
  for (const base of DUR_BASES) for (const dots of [0, 1, 2]) {
    const diff = Math.abs(baseTicks(base, dots) * ratio - ticks);
    if (!best || diff < best.diff - 1e-6) best = { base, dots, diff };
  }
  return { base: best.base, dots: best.dots, exact: best.diff <= 1 };
}
/** Find a small tuplet ratio num:den such that typeTicks*den/num ≈ ticks. */
function inferTupletRatio(typeTicks, ticks) {
  for (let den = 1; den <= 16; den++) for (let n = 2; n <= 15; n++) {
    if (n === den) continue;
    if (Math.abs(typeTicks * den / n - ticks) <= 1) { const g = gcd(n, den); return { num: n / g, den: den / g }; }
  }
  return null;
}
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; }
function lcm(a, b) { return a / gcd(a, b) * b; }

// =================================================================================
// 4. Import
// =================================================================================
export function importMusicXML(xmlText) {
  const doc = parseXML(xmlText);
  const root = kid(doc, 'score-partwise') || kid(doc, 'score-timewise');
  if (!root) throw new Error('MusicXML 문서가 아닙니다 (score-partwise / score-timewise 요소가 없습니다)');
  const score = createScore({ title: '', instruments: [], measures: 0, tempo: 0 });
  score.parts = []; score.measures = []; score.spanners = [];
  const ctx = { score, staffBase: [], infos: [], voltas: new Map() };
  readHeader(root, score);
  const partInfos = readPartList(root);
  const partNodes = collectParts(root, partInfos);
  // Pass A: parts & staves must exist before measures can be created.
  partNodes.forEach((pn, pi) => {
    const info = partInfos.find(p => p.id === pn.id) || { id: pn.id, name: '', abbreviation: '', instruments: {}, midi: null };
    ctx.infos.push(info);
    ctx.staffBase.push(score.parts.reduce((n, p) => n + p.staves.length, 0));
    score.parts.push(buildPart(info, pn));
  });
  const count = Math.max(1, ...partNodes.map(p => p.measures.length));
  for (let i = 0; i < count; i++) score.measures.push(createMeasure(score));
  // Pass B: contents.
  partNodes.forEach((pn, pi) => parsePart(ctx, pi, pn));
  finalizeImport(ctx);
  return score;
}

/** Normalises partwise/timewise into [{id, measures:[measureNode]}] in part-list order. */
function collectParts(root, partInfos) {
  const byId = new Map();
  const order = partInfos.map(p => p.id);
  const get = id => { if (!byId.has(id)) { byId.set(id, { id, measures: [] }); if (!order.includes(id)) order.push(id); } return byId.get(id); };
  if (root.tag === 'score-partwise') {
    for (const p of kids(root, 'part')) get(attr(p, 'id', 'P1')).measures.push(...kids(p, 'measure'));
  } else {
    for (const m of kids(root, 'measure')) for (const p of kids(m, 'part')) {
      get(attr(p, 'id', 'P1')).measures.push({ tag: 'measure', attrs: m.attrs, children: p.children, text: '' });
    }
  }
  return order.filter(id => byId.has(id)).map(id => byId.get(id));
}

// ---------- header: meta, settings ----------
function readHeader(root, score) {
  const meta = score.meta, settings = score.settings;
  const workTitle = txt(kid(root, 'work'), 'work-title');
  const movementTitle = txt(root, 'movement-title');
  meta.title = workTitle || movementTitle || '';
  if (workTitle && movementTitle) meta.subtitle = movementTitle;
  const ident = kid(root, 'identification');
  for (const c of kids(ident, 'creator')) {
    const type = attr(c, 'type', 'composer');
    if (['composer', 'lyricist', 'arranger'].includes(type) && !meta[type]) meta[type] = c.text.trim();
  }
  const rights = kids(ident, 'rights').map(r => r.text.trim()).filter(Boolean).join(' ');
  if (rights) meta.copyright = rights;
  // <credit>: use credit-type when present, otherwise guess from position
  const typeField = { title: 'title', subtitle: 'subtitle', composer: 'composer', lyricist: 'lyricist', arranger: 'arranger', rights: 'copyright' };
  for (const cr of kids(root, 'credit')) {
    if (attr(cr, 'page', '1') !== '1') continue;
    const wordsEls = kids(cr, 'credit-words');
    const words = wordsEls.map(w => w.text.trim()).filter(Boolean).join(' ');
    if (!words) continue;
    let field = typeField[txt(cr, 'credit-type')];
    if (!field) {
      const j = attr(wordsEls[0], 'justify', 'center'), va = attr(wordsEls[0], 'valign', 'top');
      field = va === 'bottom' ? 'copyright' : j === 'right' ? 'composer' : j === 'left' ? 'lyricist' : meta.title ? 'subtitle' : 'title';
    }
    if (!meta[field]) meta[field] = words;
  }
  const defaults = kid(root, 'defaults');
  if (!defaults) return;
  const sc = kid(defaults, 'scaling');
  let mmPerTenth = 7.05556 / 40;
  if (sc && num(sc, 'millimeters', 0) > 0 && num(sc, 'tenths', 0) > 0) mmPerTenth = num(sc, 'millimeters') / num(sc, 'tenths');
  settings.staffSpaceMm = round4(mmPerTenth * 10);
  const pl = kid(defaults, 'page-layout');
  if (pl) {
    const w = num(pl, 'page-width', NaN), h = num(pl, 'page-height', NaN);
    if (w > 0 && h > 0) {
      settings.pageWidthMm = round2(w * mmPerTenth); settings.pageHeightMm = round2(h * mmPerTenth);
      settings.orientation = settings.pageWidthMm > settings.pageHeightMm ? 'landscape' : 'portrait';
      settings.pageSize = classifyPageSize(settings.pageWidthMm, settings.pageHeightMm);
    }
    const margins = kids(pl, 'page-margins');
    const pm = margins.find(m => attr(m, 'type') === 'both') || margins.find(m => attr(m, 'type') === 'odd') || margins[0];
    if (pm) {
      settings.marginsMm = {
        top: round2(num(pm, 'top-margin', 0) * mmPerTenth), bottom: round2(num(pm, 'bottom-margin', 0) * mmPerTenth),
        left: round2(num(pm, 'left-margin', 0) * mmPerTenth), right: round2(num(pm, 'right-margin', 0) * mmPerTenth),
      };
    }
  }
  const sd = num(kid(defaults, 'system-layout'), 'system-distance', NaN);
  if (sd >= 0) settings.systemGapSp = round2(sd / 10);
  const std = num(kid(defaults, 'staff-layout'), 'staff-distance', NaN);
  if (std >= 0) settings.staffGapSp = round2(std / 10);
  settings.concertPitch = has(defaults, 'concert-score');
  const wf = attr(kid(defaults, 'word-font'), 'font-family'), lf = attr(kid(defaults, 'lyric-font'), 'font-family');
  settings.fonts = { text: wf || '', lyrics: lf || '' };
}

function classifyPageSize(w, h) {
  const lo = Math.min(w, h), hi = Math.max(w, h);
  for (const [name, [a, b]] of Object.entries(PAGE_SIZES)) if (Math.abs(lo - a) < 1.5 && Math.abs(hi - b) < 1.5) return name;
  return 'custom';
}

// ---------- part-list ----------
function readPartList(root) {
  const out = [];
  for (const sp of kids(kid(root, 'part-list'), 'score-part')) {
    const info = { id: attr(sp, 'id', 'P' + (out.length + 1)), name: txt(sp, 'part-name') || '', abbreviation: txt(sp, 'part-abbreviation') || '',
      instruments: {}, midi: null, sound: null };
    for (const si of kids(sp, 'score-instrument')) {
      info.instruments[attr(si, 'id', '')] = { name: txt(si, 'instrument-name') || '', midiUnpitched: null };
      if (!info.sound) info.sound = txt(si, 'instrument-sound') || null;
    }
    for (const mi of kids(sp, 'midi-instrument')) {
      const id = attr(mi, 'id', '');
      const inst = info.instruments[id] || (info.instruments[id] = { name: '', midiUnpitched: null });
      if (has(mi, 'midi-unpitched')) inst.midiUnpitched = num(mi, 'midi-unpitched', 0);
      if (!info.midi) {
        info.midi = { program: has(mi, 'midi-program') ? clamp(num(mi, 'midi-program', 1) - 1, 0, 127) : null,
          channel: has(mi, 'midi-channel') ? clamp(num(mi, 'midi-channel', 1) - 1, 0, 15) : null,
          volume: has(mi, 'volume') ? clamp(num(mi, 'volume', 100) / 100, 0, 1) : null,
          pan: has(mi, 'pan') ? clamp(num(mi, 'pan', 0) / 90, -1, 1) : null };
      }
    }
    out.push(info);
  }
  return out;
}

// ---------- staff discovery (pass A) ----------
function buildPart(info, partNode) {
  const ms = partNode.measures;
  let staffCount = 1, hasUnpitched = false;
  const clefs = {}, details = {};
  for (const m of ms) {
    for (const a of kids(m, 'attributes')) {
      staffCount = Math.max(staffCount, num(a, 'staves', 1));
      for (const c of kids(a, 'clef')) {
        const n = parseInt(attr(c, 'number', '1'), 10) || 1;
        staffCount = Math.max(staffCount, n);
        if (!clefs[n]) clefs[n] = clefFromXML(txt(c, 'sign'), num(c, 'line', 0), num(c, 'clef-octave-change', 0));
      }
      for (const d of kids(a, 'staff-details')) {
        const n = parseInt(attr(d, 'number', '1'), 10) || 1;
        const det = details[n] || (details[n] = {});
        if (has(d, 'staff-lines')) det.lines = num(d, 'staff-lines', 5);
        const tun = kids(d, 'staff-tuning');
        if (tun.length) {
          det.tuning = tun.map(t => ({ line: num(t, 'line', 1), name: stepAlterText(txt(t, 'tuning-step'), num(t, 'tuning-alter', 0)) + num(t, 'tuning-octave', 2) }))
            .sort((x, y) => x.line - y.line).map(t => t.name);
        }
      }
    }
    for (const n of kids(m, 'note')) {
      if (has(n, 'staff')) staffCount = Math.max(staffCount, num(n, 'staff', 1));
      if (has(n, 'unpitched')) hasUnpitched = true;
    }
  }
  const staves = [];
  for (let s = 1; s <= staffCount; s++) {
    let clef = clefs[s] || (hasUnpitched && !clefs[s] ? 'percussion' : staffCount > 1 && s === staffCount ? 'bass' : 'treble');
    const type = clef === 'percussion' ? 'percussion' : clef === 'tab' ? 'tab' : 'standard';
    const st = createStaff(clef, type);
    const det = details[s];
    if (det && det.lines) st.lines = det.lines;
    if (det && det.tuning && type === 'tab') st.tuning = det.tuning;
    staves.push(st);
  }
  const percussion = staves.some(s => s.type === 'percussion'), tab = staves.some(s => s.type === 'tab');
  const program = info.midi && info.midi.program != null ? info.midi.program : 0;
  let instrument = Object.keys(INSTRUMENT_SOUND).find(k => INSTRUMENT_SOUND[k] === info.sound);
  if (instrument === 'guitar' && tab) instrument = 'guitar-tab';
  if (!instrument) instrument = info.sound && !info.sound.includes('.') ? info.sound : instrumentFromProgram(program, { percussion, tab, staves: staves.length });
  const part = createPart(instrument, { name: info.name, abbreviation: info.abbreviation, instrument, midiProgram: program, transposeChromatic: 0, staves });
  delete part.midiChannel;
  if (info.midi && info.midi.channel != null) part.midiChannel = info.midi.channel;
  else if (percussion) part.midiChannel = 9;
  if (info.midi && info.midi.volume != null) part.volume = info.midi.volume;
  if (info.midi && info.midi.pan != null) part.pan = info.midi.pan;
  return part;
}

// ---------- pass B: measures of one part ----------
function parsePart(ctx, pi, partNode) {
  const part = ctx.score.parts[pi];
  const st = {
    pi, part, base: ctx.staffBase[pi], divisions: 0,
    voiceMaps: part.staves.map(() => new Map()),       // xml voice string → compact index, per staff
    curClef: part.staves.map(s => s.clef), pendingClef: {},
    tuplets: new Map(), open: { slur: new Map(), wedge: new Map(), ottava: new Map(), pedal: new Map(), textLine: new Map(), gliss: new Map(), trill: new Map() },
    lastEvent: null, lastByStaff: part.staves.map(() => null),
    usesBeams: partNode.measures.some(m => kids(m, 'note').some(n => has(n, 'beam'))),
  };
  partNode.measures.forEach((mNode, mi) => parseMeasure(ctx, st, mi, mNode));
}

function parseMeasure(ctx, st, mi, mNode) {
  const score = ctx.score, measure = score.measures[mi];
  const placed = [];          // {ev, si, vi, tick}
  const pending = [];         // direction items resolved after all notes are known
  const voiceLen = new Map(); // "si:vi" → model ticks so far
  let cursor = 0;
  if (attr(mNode, 'implicit') === 'yes' && mi === 0) measure.pickup = true;
  for (const [sIdx, clef] of Object.entries(st.pendingClef)) { setMeasureClef(ctx, st, measure, +sIdx, clef); }
  st.pendingClef = {};
  for (const el of mNode.children) {
    const scale = st.divisions > 0 ? TPQ / st.divisions : TPQ;
    switch (el.tag) {
      case 'attributes': readAttributes(ctx, st, measure, mi, el, cursor); break;
      case 'note': cursor = readNote(ctx, st, measure, mi, el, cursor, placed, voiceLen); break;
      case 'backup': cursor = Math.max(0, cursor - num(el, 'duration', 0) * scale); break;
      case 'forward': cursor += num(el, 'duration', 0) * scale; break;
      case 'direction': readDirection(ctx, st, measure, el, cursor, scale, pending); break;
      case 'harmony': readHarmony(measure, el, cursor, scale); break;
      case 'barline': readBarline(ctx, measure, mi, el); break;
      case 'print': readPrint(ctx, measure, mi, el); break;
      case 'sound': applySound(measure, el, [], true); break;
      default: break;
    }
  }
  resolvePending(ctx, st, measure, placed, pending);
  for (const p of placed) if (!p.ev.grace) { const prev = st.lastByStaff[p.si]; if (!prev || prev.tick <= p.tick) st.lastByStaff[p.si] = p; }
}

function setMeasureClef(ctx, st, measure, si, clef) {
  if (st.curClef[si] === clef) return;
  st.curClef[si] = clef;
  measure.staves[st.base + si].clef = clef;
}

function readAttributes(ctx, st, measure, mi, el, cursor) {
  const d = num(el, 'divisions', 0);
  if (d > 0) st.divisions = d;
  const key = kid(el, 'key');
  if (key && (st.pi === 0 || !measure.keySig)) {
    measure.keySig = { fifths: clamp(Math.round(num(key, 'fifths', 0)), -7, 7), mode: txt(key, 'mode') === 'minor' ? 'minor' : 'major' };
  }
  const time = kid(el, 'time');
  if (time && has(time, 'beats') && (st.pi === 0 || !measure.timeSig)) {
    const beats = (txt(time, 'beats') || '4').split('+').reduce((s, b) => s + (parseInt(b, 10) || 0), 0) || 4;
    const sym = attr(time, 'symbol');
    measure.timeSig = { num: beats, den: parseInt(txt(time, 'beat-type') || '4', 10) || 4, display: sym === 'common' || sym === 'cut' ? sym : 'normal' };
  }
  for (const c of kids(el, 'clef')) {
    const si = clamp((parseInt(attr(c, 'number', '1'), 10) || 1) - 1, 0, st.part.staves.length - 1);
    const clef = clefFromXML(txt(c, 'sign'), num(c, 'line', 0), num(c, 'clef-octave-change', 0));
    if (cursor > 1) st.pendingClef[si] = clef;          // mid-measure clef → applies from the next measure
    else setMeasureClef(ctx, st, measure, si, clef);
  }
  const tr = kid(el, 'transpose');
  if (tr) st.part.transposeChromatic = Math.round(num(tr, 'chromatic', 0) + 12 * num(tr, 'octave-change', 0));
}

function voiceIndexFor(st, si, voiceKey) {
  const map = st.voiceMaps[si];
  if (!map.has(voiceKey)) map.set(voiceKey, Math.min(map.size, 3));
  return map.get(voiceKey);
}

function readNote(ctx, st, measure, mi, el, cursor, placed, voiceLen) {
  const scale = st.divisions > 0 ? TPQ / st.divisions : 0;
  const nStaves = st.part.staves.length;
  const si = clamp(Math.round(num(el, 'staff', 1)) - 1, 0, nStaves - 1);
  const staff = st.part.staves[si];
  const sm = measure.staves[st.base + si];
  const graceEl = kid(el, 'grace');
  const restEl = kid(el, 'rest');
  const tm = kid(el, 'time-modification');
  const ratio = tm ? num(tm, 'normal-notes', 2) / num(tm, 'actual-notes', 3) : 1;
  const typeTxt = txt(el, 'type');
  const dots = kids(el, 'dot').length;
  let ticks = graceEl ? 0 : num(el, 'duration', 0) * scale;
  // ---- duration → {base, dots, tuplet}: trust <type>, infer from <duration> when absent
  let base = XML_TYPE_TO_BASE[typeTxt], fullDots = dots;
  let tuplet = tm ? { num: Math.round(num(tm, 'actual-notes', 3)), den: Math.round(num(tm, 'normal-notes', 2)) } : null;
  if (!base) {
    const ds = restEl && attr(restEl, 'measure') === 'yes' ? ticksToDurations(measureCapacity(effTime(ctx.score, mi))) : [];
    const d = ds.length === 1 ? ds[0] : ds.length > 1 ? { base: 'whole', dots: 0 } : inferDuration(ticks || TPQ, ratio);
    base = d.base; fullDots = d.dots;
  } else if (ticks > 0 && !tm && Math.abs(baseTicks(base, dots) - ticks) > 1) {
    const r = inferTupletRatio(baseTicks(base, dots), ticks);   // e.g. 320 ticks typed "eighth" → 3:2
    if (r) tuplet = r;
  }
  if (!scale && !graceEl) ticks = baseTicks(base, fullDots) * (tuplet ? tuplet.den / tuplet.num : 1); // no <divisions>: trust <type>
  // ---- chord note: attach to the previous event
  const isChord = has(el, 'chord') && st.lastEvent && st.lastEvent.ev.kind === 'note' && !restEl;
  let ev, note = null;
  if (isChord) ev = st.lastEvent.ev;
  else {
    ev = { id: newId(), kind: restEl ? 'rest' : 'note', dur: { base, dots: fullDots } };
    if (!restEl) ev.notes = [];
  }
  if (!restEl) {
    note = { step: 'C', octave: 4, alter: 0 };
    const p = kid(el, 'pitch'), up = kid(el, 'unpitched');
    if (p) { note.step = (txt(p, 'step') || 'C').toUpperCase(); note.octave = Math.round(num(p, 'octave', 4)); note.alter = clamp(Math.round(num(p, 'alter', 0)), -2, 2); }
    else if (up) { note.step = (txt(up, 'display-step') || 'C').toUpperCase(); note.octave = Math.round(num(up, 'display-octave', 5)); }
    const nh = kid(el, 'notehead');
    if (nh) {
      let head = HEAD_IN[txt(nh)];
      if ((head === 'diamond' || head === 'triangle') && attr(nh, 'filled') === 'yes') head += '-black';
      if (head && head !== 'normal') note.head = head;
    }
    if (up || staff.type === 'percussion') { note.drum = resolveDrumKey(ctx, st, staff, el, note); const dm = staff.drumMap && staff.drumMap[note.drum]; if (dm && note.head && dm.head === note.head) delete note.head; }
    const acc = ACC_IN[txt(el, 'accidental')];
    if (acc) note.accidental = acc;
    for (const t of kids(el, 'tie')) { const ty = attr(t, 'type'); if (ty === 'start' || ty === 'continue') note.tieStart = true; if (ty === 'stop' || ty === 'continue') note.tieEnd = true; }
    const color = attr(el, 'color');
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) note.color = color.toLowerCase();
    ev.notes.push(note);
  }
  if (isChord) { readNotations(ctx, st, measure, el, ev, note, null); return cursor; }
  // ---- event-level properties
  if (graceEl) ev.grace = { slash: attr(graceEl, 'slash') === 'yes' };
  if (restEl && attr(restEl, 'measure') === 'yes') ev.fullMeasureRest = true;
  if (attr(el, 'print-object') === 'no') ev.hidden = true;
  const stem = txt(el, 'stem');
  if (stem === 'up' || stem === 'down') ev.stem = stem;
  const beam = kids(el, 'beam').find(b => attr(b, 'number', '1') === '1');
  const bv = beam && txt(beam);
  if (bv === 'begin' || bv === 'continue' || bv === 'end') ev.beam = bv;
  else if (st.usesBeams && DUR_TICKS[base] <= DUR_TICKS.eighth) ev.beam = 'none';
  const vi = voiceIndexFor(st, si, txt(el, 'voice') || '1');
  const voiceKey = `${si}:${vi}`;
  const tupInfo = readNotations(ctx, st, measure, el, ev, note, voiceKey);
  applyTuplet(st, ev, voiceKey, tuplet, tupInfo, tm, base, dots, ticks);
  readLyrics(el, ev);
  if (ev.kind === 'note' && !ev.notes.length) ev.kind = 'rest';
  // ---- place into the voice at the cursor (gaps become hidden rests)
  while (sm.voices.length <= vi) sm.voices.push([]);
  const voice = sm.voices[vi];
  const have = voiceLen.has(voiceKey) ? voiceLen.get(voiceKey) : voiceTicks(voice);
  if (cursor > have + 15) for (const d of ticksToDurations(cursor - have)) { const r = makeRest(d.base, d.dots); r.hidden = true; voice.push(r); }
  voice.push(ev);
  voiceLen.set(voiceKey, Math.max(have, cursor) + durTicks(ev));
  placed.push({ ev, si, vi, tick: cursor });
  st.lastEvent = { ev, si, vi, tick: cursor };
  return cursor + ticks;
}

function effTime(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i].timeSig) return score.measures[i].timeSig;
  return { num: 4, den: 4 };
}

/** Tuplet grouping: explicit <tuplet> notations, else inferred from consecutive time-modified notes. */
function applyTuplet(st, ev, voiceKey, tuplet, info, tm, base, dots, ticks) {
  let state = st.tuplets.get(voiceKey);
  if (info.tupletStart) {
    state = { id: newId(), num: tuplet ? tuplet.num : 3, den: tuplet ? tuplet.den : 2, show: info.tupletStart.show, bracket: info.tupletStart.bracket, explicit: true, acc: 0 };
    st.tuplets.set(voiceKey, state);
  }
  if (!tuplet && !(state && !ev.grace)) return;
  if (!state) {
    const nt = XML_TYPE_TO_BASE[txt(tm, 'normal-type')] || base;
    const nd = tm && has(tm, 'normal-type') ? kids(tm, 'normal-dot').length : dots;
    state = { id: newId(), num: tuplet.num, den: tuplet.den, show: 'number', explicit: false, acc: 0, target: tuplet.den * baseTicks(nt, nd) };
    st.tuplets.set(voiceKey, state);
  }
  if (ev.grace) return;
  ev.tuplet = { id: state.id, num: tuplet ? tuplet.num : state.num, den: tuplet ? tuplet.den : state.den, show: state.show };
  if (state.bracket) ev.tuplet.bracket = true;
  state.acc += ticks;
  if (info.tupletStop || (!state.explicit && state.acc >= state.target - 1)) st.tuplets.delete(voiceKey);
}

function readLyrics(el, ev) {
  kids(el, 'lyric').forEach((ly, i) => {
    const text = kids(ly, 'text').map(t => t.text.trim()).join('');
    if (!text) return;                                   // extend-only continuation lyric
    const verse = parseInt(attr(ly, 'number', ''), 10) || i + 1;
    const syl = txt(ly, 'syllabic');
    const l = { verse, text, syllabic: ['single', 'begin', 'middle', 'end'].includes(syl) ? syl : 'single' };
    const ext = kid(ly, 'extend');
    if (ext && ['start', undefined].includes(attr(ext, 'type'))) l.extend = true;
    (ev.lyrics || (ev.lyrics = [])).push(l);
  });
}

/** Maps <unpitched>/<instrument> onto a Staff.drumMap key (by MIDI, by name, then by staff line). */
function resolveDrumKey(ctx, st, staff, el, note) {
  if (!staff.drumMap) staff.drumMap = JSON.parse(JSON.stringify(DEFAULT_DRUM_MAP));
  const map = staff.drumMap;
  const instId = attr(kid(el, 'instrument'), 'id');
  const info = instId ? ctx.infos[st.pi].instruments[instId] : null;
  const midi = info && info.midiUnpitched != null ? info.midiUnpitched - 1 : -1;
  if (midi >= 0) { const k = Object.keys(map).find(k => map[k].midi === midi); if (k) return k; }
  if (info && info.name) { const rule = DRUM_NAME_RULES.find(([re]) => re.test(info.name)); if (rule && map[rule[1]] && midi < 0) return rule[1]; }
  const line = staffPosition(note, 'percussion');
  if (!info) {
    const k = Object.keys(map).find(k => map[k].line === line && (!note.head || map[k].head === note.head)) || Object.keys(map).find(k => map[k].line === line);
    if (k) return k;
  }
  const key = (info && info.name ? info.name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') : '') || (midi >= 0 ? 'drum' + midi : 'drum-line' + line);
  if (!map[key]) map[key] = { line, head: note.head || 'normal', midi: midi >= 0 ? midi : 0, name: (info && info.name) || key };
  return key;
}

/** Opens/closes an event-anchored spanner keyed by MusicXML number; returns the spanner on close. */
function spanEdge(ctx, st, kind, type, number, ev, props) {
  const open = st.open[kind];
  const key = number || '1';
  if (type === 'start' || type === 'up' || type === 'down' || type === 'resume' || type === 'crescendo' || type === 'diminuendo') {
    const sp = Object.assign({ id: newId(), type: kind, from: { eventId: ev.id }, to: null }, props);
    open.set(key, sp);
    return sp;
  }
  if (type === 'stop' || type === 'discontinue') {
    const sp = open.get(key) || open.values().next().value;
    if (!sp) return null;
    open.delete([...open.entries()].find(([, v]) => v === sp)[0]);
    sp.to = { eventId: ev.id };
    ctx.score.spanners.push(sp);
    return sp;
  }
  return null;
}

function readNotations(ctx, st, measure, el, ev, note, voiceKey) {
  const info = {};
  for (const nt of kids(el, 'notations')) for (const c of nt.children) {
    switch (c.tag) {
      case 'tied': if (note) { const t = attr(c, 'type'); if (t === 'start' || t === 'continue' || t === 'let-ring') note.tieStart = true; if (t === 'stop' || t === 'continue') note.tieEnd = true; } break;
      case 'slur': { const pl = attr(c, 'placement'); spanEdge(ctx, st, 'slur', attr(c, 'type'), attr(c, 'number'), ev, pl ? { placement: pl } : {}); break; }
      case 'glissando': case 'slide': spanEdge(ctx, st, 'gliss', attr(c, 'type'), attr(c, 'number'), ev, { type: 'glissando' }); break;
      case 'tuplet':
        if (!voiceKey) break;
        if (attr(c, 'type') === 'start') {
          const sn = attr(c, 'show-number', 'actual');
          info.tupletStart = { bracket: attr(c, 'bracket') === 'yes', show: sn === 'none' ? 'none' : sn === 'both' ? 'ratio' : 'number' };
        } else if (attr(c, 'type') === 'stop') info.tupletStop = true;
        break;
      case 'articulations':
        for (const a of c.children) { const v = ART_IN[a.tag]; if (v) addUnique(ev, 'articulations', v); }
        break;
      case 'ornaments': {
        const wavy = kids(c, 'wavy-line');
        for (const o of c.children) {
          if (o.tag === 'tremolo') { const t = attr(o, 'type', 'single'); if (t !== 'stop') ev.tremolo = clamp(parseInt(o.text, 10) || 1, 1, 3); }
          else if (o.tag === 'wavy-line') spanEdge(ctx, st, 'trill', attr(o, 'type'), attr(o, 'number'), ev, { type: 'trill' });
          else if (o.tag === 'trill-mark' && wavy.some(w => attr(w, 'type') === 'start')) { /* rendered by the trill spanner */ }
          else if (ORN_IN[o.tag]) addUnique(ev, 'ornaments', ORN_IN[o.tag]);
        }
        break;
      }
      case 'technical':
        if (note) {
          if (has(c, 'string')) note.string = Math.round(num(c, 'string', 1));
          if (has(c, 'fret')) note.fret = Math.round(num(c, 'fret', 0));
          if (has(c, 'fingering')) note.fingering = txt(c, 'fingering');
        }
        break;
      case 'dynamics': { const d = dynamicOf(c); if (d) ev.dynamic = d; break; }
      case 'fermata': ev.fermata = attr(c, 'type') === 'inverted' ? 'below' : 'above'; break;
      case 'arpeggiate': ev.arpeggio = true; break;
      default: break;
    }
  }
  return info;
}
function addUnique(ev, field, v) { const arr = ev[field] || (ev[field] = []); if (!arr.includes(v)) arr.push(v); }
function dynamicOf(dynEl) {
  for (const c of dynEl.children) {
    if (DYNAMICS.has(c.tag)) return c.tag;
    if (c.tag === 'other-dynamics' && DYNAMICS.has(c.text.trim())) return c.text.trim();
  }
  return null;
}

// ---------- directions ----------
function readDirection(ctx, st, measure, el, cursor, scale, pending) {
  const placement = attr(el, 'placement');
  const si = clamp(Math.round(num(el, 'staff', 1)) - 1, 0, st.part.staves.length - 1);
  const voiceTxt = txt(el, 'voice');
  const vi = voiceTxt ? voiceIndexFor(st, si, voiceTxt) : null;
  const tick = Math.max(0, cursor + num(el, 'offset', 0) * scale);
  const words = [];
  let metronome = null;
  for (const dt of kids(el, 'direction-type')) for (const c of dt.children) {
    switch (c.tag) {
      case 'words': if (c.text.trim()) words.push(c); break;
      case 'metronome': metronome = c; break;
      case 'rehearsal': if (c.text.trim()) measure.rehearsalMark = c.text.trim(); break;
      case 'segno': addMarker(measure, 'segno'); break;
      case 'coda': addMarker(measure, 'coda'); break;
      case 'dynamics': { const d = dynamicOf(c); if (d) pending.push({ kind: 'dynamic', si, vi, tick, value: d }); break; }
      case 'wedge': pending.push({ kind: 'wedge', si, vi, tick, type: attr(c, 'type'), number: attr(c, 'number'), placement }); break;
      case 'octave-shift': pending.push({ kind: 'ottava', si, vi, tick, type: attr(c, 'type'), number: attr(c, 'number'), size: parseInt(attr(c, 'size', '8'), 10) || 8 }); break;
      case 'pedal': pending.push({ kind: 'pedal', si, vi, tick, type: attr(c, 'type'), number: attr(c, 'number'), placement }); break;
      case 'bracket': case 'dashes': pending.push({ kind: 'textLine', si, vi, tick, type: attr(c, 'type'), number: attr(c, 'number'), placement, words }); break;
      default: break;
    }
  }
  const wordsText = () => words.map(w => w.text.trim()).join(' ');
  const sound = kid(el, 'sound');
  if (metronome) {
    if (!measure.tempo || tick <= 1) {
      measure.tempo = { bpm: parseFloat(txt(metronome, 'per-minute')) || 120, beatUnit: XML_TYPE_TO_BASE[txt(metronome, 'beat-unit')] || 'quarter',
        dots: kids(metronome, 'beat-unit-dot').length, text: wordsText(), showBpm: attr(metronome, 'print-object') !== 'no' };
    }
    return;
  }
  if (sound && attr(sound, 'tempo') != null && !pending.some(p => p.words === words)) {
    if (!measure.tempo || tick <= 1) measure.tempo = { bpm: parseFloat(attr(sound, 'tempo')) || 120, beatUnit: 'quarter', dots: 0, text: wordsText(), showBpm: false };
    return;
  }
  let markerSet = false;
  if (!pending.some(p => p.words === words)) {
    for (const w of words) {
      const t = w.text.trim();
      const rule = MARKER_WORDS.find(([re]) => re.test(t));
      if (rule) { addMarker(measure, rule[1]); markerSet = true; continue; }
      const style = attr(el, 'system') ? 'system' : attr(w, 'font-style') === 'italic' ? 'expression' : attr(w, 'font-weight') === 'bold' ? 'technique' : 'plain';
      pending.push({ kind: 'text', si, vi, tick, text: t, placement: placement === 'below' ? 'below' : 'above', style });
    }
  }
  if (sound) applySound(measure, sound, measure.markers || [], !markerSet);
}
function addMarker(measure, m) { const arr = measure.markers || (measure.markers = []); if (!arr.includes(m)) arr.push(m); }
/** <sound> attributes → jump markers (only when no words already produced one). */
function applySound(measure, sound, existing, allowMarkers) {
  if (!allowMarkers) return;
  const hasJump = existing.some(m => /^d[cs]/.test(m));
  if (attr(sound, 'dacapo') === 'yes' && !hasJump) addMarker(measure, 'dc');
  if (attr(sound, 'dalsegno') != null && !hasJump) addMarker(measure, 'ds');
  if (attr(sound, 'fine') === 'yes') addMarker(measure, 'fine');
  if (attr(sound, 'tocoda') != null) addMarker(measure, 'toCoda');
}

/** Resolves pending direction items against the events of the measure. */
function resolvePending(ctx, st, measure, placed, pending) {
  const inStaff = si => placed.filter(p => p.si === si && !p.ev.grace);
  const pick = (cands, vi) => {
    if (!cands.length) return null;
    const pref = vi != null ? cands.filter(c => c.vi === vi) : [];
    return (pref.length ? pref : cands).sort((a, b) => a.vi - b.vi)[0];
  };
  const at = (si, tick, vi) => pick(inStaff(si).filter(p => Math.abs(p.tick - tick) <= 1), vi);
  const atOrAfter = (si, tick, vi) => { const c = inStaff(si).filter(p => p.tick >= tick - 1); if (!c.length) return null; const t = Math.min(...c.map(p => p.tick)); return pick(c.filter(p => p.tick === t), vi); };
  const before = (si, tick, vi) => { const c = inStaff(si).filter(p => p.tick < tick - 1); if (!c.length) return st.lastByStaff[si]; const t = Math.max(...c.map(p => p.tick)); return pick(c.filter(p => p.tick === t), vi); };
  for (const it of pending) {
    if (it.kind === 'dynamic') { const p = atOrAfter(it.si, it.tick, it.vi) || before(it.si, it.tick, it.vi); if (p) p.ev.dynamic = it.value; continue; }
    if (it.kind === 'text') {
      const p = it.vi != null ? at(it.si, it.tick, it.vi) : it.tick > 1 ? (at(it.si, it.tick) || before(it.si, it.tick)) : null;
      const t = { text: it.text, placement: it.placement, style: it.style };
      if (p) { if (t.style === 'system') t.style = 'plain'; (p.ev.texts || (p.ev.texts = [])).push(t); }
      else (measure.texts || (measure.texts = [])).push(st.base + it.si ? { ...t, staffIndex: st.base + it.si } : t);
      continue;
    }
    // spanners anchored by directions: start → event at/after the tick, stop → last event strictly before it
    const open = st.open[it.kind], key = it.number || '1';
    const isStop = it.type === 'stop' || it.type === 'discontinue';
    if (!isStop && it.type !== 'change' && it.type !== 'continue') {
      const p = atOrAfter(it.si, it.tick, it.vi) || before(it.si, it.tick, it.vi);
      if (!p) continue;
      const sp = { id: newId(), type: it.kind, from: { eventId: p.ev.id }, to: null, vi: p.vi };
      if (it.kind === 'wedge') sp.type = it.type === 'diminuendo' ? 'diminuendo' : 'crescendo';
      if (it.kind === 'ottava') { sp.octaveShift = it.type === 'up' ? -it.size : it.size; sp.placement = it.type === 'up' ? 'below' : 'above'; }
      if (it.kind === 'textLine') { const t = it.words.map(w => w.text.trim()).join(' '); if (t) sp.text = t; }
      const defPlacement = it.kind === 'textLine' ? 'above' : 'below';
      if (it.placement && it.placement !== defPlacement && (it.kind === 'wedge' || it.kind === 'pedal' || it.kind === 'textLine')) sp.placement = it.placement;
      open.set(key, sp);
    } else if (isStop) {
      const sp = open.get(key) || open.values().next().value;
      if (!sp) continue;
      open.delete([...open.entries()].find(([, v]) => v === sp)[0]);
      const p = before(it.si, it.tick, it.vi != null ? it.vi : sp.vi) || at(it.si, it.tick, sp.vi);
      if (!p) continue;
      delete sp.vi;
      sp.to = { eventId: p.ev.id };
      ctx.score.spanners.push(sp);
    }
  }
}

// ---------- harmony ----------
function readHarmony(measure, el, cursor, scale) {
  const tick = Math.max(0, Math.round(cursor + num(el, 'offset', 0) * scale));
  const kindEl = kid(el, 'kind');
  const mxKind = (kindEl && txt(kindEl)) || 'major';
  const kindText = attr(kindEl, 'text');
  const rootEl = kid(el, 'root');
  const chord = { id: newId(), tick, text: '' };
  if (!rootEl || mxKind === 'none') chord.text = kindText != null && kindText !== '' ? kindText : 'N.C.';
  else {
    const root = stepAlterText(txt(rootEl, 'root-step'), num(rootEl, 'root-alter', 0));
    const degrees = kids(el, 'degree').map(d => ({ value: Math.round(num(d, 'degree-value', 0)), alter: Math.round(num(d, 'degree-alter', 0)), type: txt(d, 'degree-type') || 'alter' }));
    const kind = (KIND_SHORT[mxKind] != null ? KIND_SHORT[mxKind] : '') + degreeSuffix(degrees);
    const bassEl = kid(el, 'bass');
    const bass = bassEl ? stepAlterText(txt(bassEl, 'bass-step'), num(bassEl, 'bass-alter', 0)) : '';
    chord.text = root + (kindText != null ? kindText : kind) + (bass ? '/' + bass : '');
    chord.root = root;
    const shown = kindText != null ? kindText : kind;
    if (shown) chord.kind = shown;
    if (bass) chord.bass = bass;
  }
  const fr = kid(el, 'frame');
  if (fr) {
    const nStr = Math.round(num(fr, 'frame-strings', 6));
    const frets = new Array(nStr).fill(-1), barres = [], pendingBarre = {};
    for (const fn of kids(fr, 'frame-note')) {
      const s = Math.round(num(fn, 'string', 1)), f = Math.round(num(fn, 'fret', 0)), idx = nStr - s;
      if (idx >= 0 && idx < nStr) frets[idx] = f;
      const b = kid(fn, 'barre');
      if (b) { const t = attr(b, 'type'); if (t === 'start') pendingBarre[f] = idx; else if (t === 'stop' && pendingBarre[f] != null) { barres.push({ fret: f, from: pendingBarre[f], to: idx }); delete pendingBarre[f]; } }
    }
    chord.diagram = { frets, baseFret: Math.round(num(kid(fr, 'first-fret'), null, 1)), barres };
  }
  const chords = measure.chords || (measure.chords = []);
  if (!chords.some(c => c.tick === tick && c.text === chord.text)) chords.push(chord);
}

// ---------- barlines, endings, print ----------
function readBarline(ctx, measure, mi, el) {
  const loc = attr(el, 'location', 'right'), style = txt(el, 'bar-style'), rep = kid(el, 'repeat');
  if (loc === 'left') {
    if (rep && attr(rep, 'direction') === 'forward') measure.barlineLeft = 'repeat-start';
    else if (style === 'light-light' || style === 'heavy-light' || style === 'heavy-heavy') measure.barlineLeft = 'double';
    else if (style === 'none') measure.barlineLeft = 'none';
  } else {
    if (rep && attr(rep, 'direction') === 'backward') {
      measure.barlineRight = 'repeat-end';
      const times = parseInt(attr(rep, 'times', ''), 10);
      if (times > 0) measure.repeatCount = times;
    } else if (style) {
      const map = { 'light-light': 'double', 'light-heavy': 'final', 'heavy-light': 'double', 'heavy-heavy': 'double', none: 'none', dashed: 'dashed', dotted: 'dashed', regular: 'single' };
      if (map[style]) measure.barlineRight = map[style];
    }
  }
  const ending = kid(el, 'ending');
  if (ending) {
    const type = attr(ending, 'type');
    if (type === 'start') {
      if (!ctx.voltas.has(measure.id)) {
        const sp = { id: newId(), type: 'volta', from: { measureId: measure.id }, to: { measureId: measure.id }, number: txt(ending) || endingLabel(attr(ending, 'number', '1')), voltaType: 'closed' };
        ctx.voltas.set(measure.id, sp); ctx.score.spanners.push(sp); ctx.openVolta = sp;
      } else ctx.openVolta = ctx.voltas.get(measure.id);
    } else if ((type === 'stop' || type === 'discontinue') && ctx.openVolta) {
      ctx.openVolta.to = { measureId: measure.id };
      ctx.openVolta.voltaType = type === 'stop' ? 'closed' : 'open';
      ctx.openVolta = null;
    }
  }
}
/** "1, 2" → "1.-2.", "1" → "1.", "1, 3" → "1., 3." */
function endingLabel(numbers) {
  const ns = numbers.split(/[\s,]+/).map(n => parseInt(n, 10)).filter(n => n > 0);
  if (!ns.length) return '1.';
  const consecutive = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
  return ns.length > 1 && consecutive ? `${ns[0]}.-${ns[ns.length - 1]}.` : ns.map(n => n + '.').join(', ');
}
function readPrint(ctx, measure, mi, el) {
  const score = ctx.score;
  if (mi > 0) {
    const prev = score.measures[mi - 1];
    if (attr(el, 'new-system') === 'yes') prev.breaks = Object.assign(prev.breaks || {}, { system: true });
    if (attr(el, 'new-page') === 'yes') prev.breaks = Object.assign(prev.breaks || {}, { page: true });
  }
  const mn = txt(el, 'measure-numbering');
  if (mn) score.settings.measureNumbers = mn === 'measure' ? 'all' : mn === 'none' ? 'none' : 'system';
  if (mi === 0) {
    const lm = num(kid(kid(el, 'system-layout'), 'system-margins'), 'left-margin', NaN);
    if (lm >= 0) score.settings.firstSystemIndentSp = round2(lm / 10);
  }
}

// ---------- finalize ----------
function finalizeImport(ctx) {
  const score = ctx.score;
  const m0 = score.measures[0];
  if (!m0.timeSig) m0.timeSig = { num: 4, den: 4, display: 'normal' };
  if (!m0.keySig) m0.keySig = { fifths: 0, mode: 'major' };
  const v0 = m0.staves[0] && m0.staves[0].voices[0];
  if (v0 && v0.length && voiceTicks(v0) < measureCapacity(m0.timeSig) - 1) m0.pickup = true;
  score.measures.forEach((m, mi) => {
    // repeat-end followed by repeat-start → canonical "repeat-both"
    const next = score.measures[mi + 1];
    if (m.barlineRight === 'repeat-end' && next && next.barlineLeft === 'repeat-start') { m.barlineRight = 'repeat-both'; delete next.barlineLeft; }
    if (m.chords) m.chords.sort((a, b) => a.tick - b.tick);
    for (const sm of m.staves) for (const v of sm.voices) for (const ev of v) if (ev.notes && ev.notes.length > 1) ev.notes.sort((a, b) => midiOf(a) - midiOf(b));
  });
  score.spanners = score.spanners.filter(sp => sp.from && sp.to);
  normalizeImported(score);
  validateScore(score, { repair: true });
}

/** Drop information that equals JSE's automatic behaviour so imported scores stay editable:
 *  beams identical to auto-beaming, and lone whole-measure rests in voice 1. */
export function normalizeImported(score) {
  score.measures.forEach((m, mi) => {
    const ts = effTime(score, mi);
    m.staves.forEach(sm => sm.voices.forEach((v, vi) => {
      v.forEach(ev => { if (ev.grace) delete ev.beam; });
      if (v.some(ev => ev.beam)) {
        const stripped = v.map(ev => { const c = { ...ev }; delete c.beam; return c; });
        const auto = autoBeamStates(stripped, ts);
        const same = v.every((ev, i) => (ev.beam || 'none') === (auto[i] || 'none') || (!auto[i] && ev.beam === 'none'));
        if (same) v.forEach(ev => { delete ev.beam; });
      }
      if (vi === 0 && v.length === 1) {
        const r = v[0];
        if (r.kind === 'rest' && r.fullMeasureRest && !r.lyrics && !r.texts && !r.fermata && !r.dynamic && !r.hidden) sm.voices[0] = [];
      }
    }));
  });
}
function autoBeamStates(voice, ts) {
  const groups = autoBeamGroupsLite(voice, ts);
  const out = new Array(voice.length).fill(null);
  for (const g of groups) g.forEach((idx, k) => { out[idx] = k === 0 ? 'begin' : k === g.length - 1 ? 'end' : 'continue'; });
  return out;
}
// Same grouping rules as engrave/layout.js autoBeamGroups (kept local so this module stays DOM-free).
function autoBeamGroupsLite(voice, ts) {
  const beat = ts.den === 8 && ts.num % 3 === 0 ? 1440 : ts.den === 2 ? 1920 : ts.den >= 8 ? 480 : 960;
  const beamable = ev => ev.kind === 'note' && !ev.grace && DUR_TICKS[ev.dur.base] <= DUR_TICKS.eighth;
  const groups = []; let cur = null, tick = 0;
  const flush = () => { if (cur && cur.idx.length > 1) groups.push(cur.idx); cur = null; };
  voice.forEach((ev, i) => {
    if (!beamable(ev)) flush();
    else {
      const bi = Math.floor((tick + 1e-6) / beat);
      if (cur && Math.floor((cur.start + 1e-6) / beat) === bi && cur.tid === (ev.tuplet ? ev.tuplet.id : null)) cur.idx.push(i);
      else { flush(); cur = { start: tick, idx: [i], tid: ev.tuplet ? ev.tuplet.id : null }; }
    }
    if (!ev.grace) tick += durTicks(ev);
  });
  flush();
  if (ts.den === 4 && ts.num % 2 === 0) {
    const merged = [];
    const tickOf = idx => { let t = 0; for (let k = 0; k < idx; k++) if (!voice[k].grace) t += durTicks(voice[k]); return t; };
    const plain8 = g => g.every(i => voice[i].dur.base === 'eighth' && !voice[i].dur.dots && !voice[i].tuplet);
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      if (prev && plain8(prev) && plain8(g) && prev[prev.length - 1] + 1 === g[0] && Math.floor(tickOf(prev[0]) / 1920) === Math.floor(tickOf(g[0]) / 1920)) { prev.push(...g); continue; }
      merged.push(g);
    }
    return merged;
  }
  return groups;
}

export async function importMXL(data, { JSZip: Z = globalThis.JSZip } = {}) {
  if (!Z) throw new Error('JSZip가 필요합니다 (globalThis.JSZip 또는 옵션으로 주입)');
  const zip = await Z.loadAsync(data);
  let path = null;
  const container = zip.file('META-INF/container.xml');
  if (container) {
    const c = parseXML(await container.async('string'));
    const rfs = kids(kid(kid(c, 'container'), 'rootfiles'), 'rootfile');
    const pick = rfs.find(r => /musicxml/.test(attr(r, 'media-type', ''))) || rfs[0];
    if (pick) path = attr(pick, 'full-path');
  }
  if (!path || !zip.file(path)) path = Object.keys(zip.files).find(n => !zip.files[n].dir && !/^META-INF\//.test(n) && /\.(xml|musicxml)$/i.test(n));
  if (!path) throw new Error('MXL 안에 MusicXML 파일이 없습니다');
  return importMusicXML(await zip.file(path).async('string'));
}

// =================================================================================
// 5. Export (partwise 4.0)
// =================================================================================
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}
function fmt(n) { return String(Math.round(n * 10000) / 10000); }
function attrStr(attrs) {
  if (!attrs) return '';
  return Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
}
class XmlWriter {
  constructor() { this.lines = []; this.stack = []; }
  get pad() { return '  '.repeat(this.stack.length); }
  raw(s) { this.lines.push(s); }
  open(tag, attrs) { this.lines.push(`${this.pad}<${tag}${attrStr(attrs)}>`); this.stack.push(tag); }
  close() { const tag = this.stack.pop(); this.lines.push(`${this.pad}</${tag}>`); }
  leaf(tag, text, attrs) {
    if (text === undefined || text === null || text === '') this.lines.push(`${this.pad}<${tag}${attrStr(attrs)}/>`);
    else this.lines.push(`${this.pad}<${tag}${attrStr(attrs)}>${esc(text)}</${tag}>`);
  }
  toString() { return this.lines.join('\n') + '\n'; }
}
/** Opens `tag` on first use only; `end()` closes it if it was opened. */
function lazy(w, tag, attrs) {
  let opened = false;
  return { ensure() { if (!opened) { w.open(tag, attrs); opened = true; } }, end() { if (opened) w.close(); } };
}

/** Exact rational tick length of an event: [numerator, denominator]. */
function durRational(ev) {
  let p = DUR_TICKS[ev.dur.base] || 0, q = 1;
  const dots = ev.dur.dots || 0;
  if (dots) { p *= [1, 3, 7, 15][dots]; q *= [1, 2, 4, 8][dots]; }
  if (ev.tuplet) { p *= ev.tuplet.den; q *= ev.tuplet.num; }
  const g = gcd(p, q);
  return [p / g, q / g];
}
/** Smallest divisions (per quarter) expressing every duration of a part as an integer. */
function chooseDivisions(score, pi) {
  let d = 1;
  const base = score.parts.slice(0, pi).reduce((n, p) => n + p.staves.length, 0), n = score.parts[pi].staves.length;
  for (const m of score.measures) {
    for (let s = base; s < base + n; s++) for (const v of m.staves[s].voices) for (const ev of v) {
      if (ev.grace) continue;
      const [p, q] = durRational(ev);
      const need = (q * TPQ) / gcd(p, q * TPQ);     // p/q * d/960 must be an integer
      d = lcm(d, need);
    }
    const cap = measureCapacity(effTime(score, score.measures.indexOf(m)));
    d = lcm(d, TPQ / gcd(cap, TPQ));
  }
  return d;
}

export function exportMusicXML(score) {
  const w = new XmlWriter();
  const ctx = buildExportContext(score);
  w.raw('<?xml version="1.0" encoding="UTF-8"?>');
  w.raw('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  w.open('score-partwise', { version: '4.0' });
  writeHeader(w, score);
  writePartList(w, score, ctx);
  score.parts.forEach((part, pi) => writePart(w, score, part, pi, ctx));
  w.close();
  return w.toString();
}

function buildExportContext(score) {
  const ctx = { startsAt: new Map(), endsAt: new Map(), voltaStart: new Map(), voltaEnd: new Map(), numbers: new Map(), used: {}, staffBase: [] };
  const push = (map, key, sp) => { if (!map.has(key)) map.set(key, []); map.get(key).push(sp); };
  for (const sp of score.spanners || []) {
    if (!sp.from || !sp.to) continue;
    if (sp.type === 'volta') { push(ctx.voltaStart, sp.from.measureId, sp); push(ctx.voltaEnd, sp.to.measureId, sp); }
    else if (sp.from.eventId && sp.to.eventId) { push(ctx.startsAt, sp.from.eventId, sp); push(ctx.endsAt, sp.to.eventId, sp); }
  }
  let g = 0;
  score.parts.forEach(p => { ctx.staffBase.push(g); g += p.staves.length; });
  return ctx;
}
/** Allocates MusicXML number-levels so concurrently open spanners of a type differ. */
function spanNumber(ctx, sp, release) {
  const kind = sp.type === 'diminuendo' ? 'crescendo' : sp.type;
  const used = ctx.used[kind] || (ctx.used[kind] = new Set());
  if (release) { const n = ctx.numbers.get(sp.id) || 1; used.delete(n); ctx.numbers.delete(sp.id); return n; }
  let n = 1;
  while (used.has(n) && n < 16) n++;
  used.add(n); ctx.numbers.set(sp.id, n);
  return n;
}

// ---------- header ----------
function writeHeader(w, score) {
  const meta = score.meta || {}, s = score.settings || createScore().settings;
  if (meta.title) { w.open('work'); w.leaf('work-title', meta.title); w.close(); }
  if (meta.subtitle) w.leaf('movement-title', meta.subtitle);
  w.open('identification');
  for (const t of ['composer', 'lyricist', 'arranger']) if (meta[t]) w.leaf('creator', meta[t], { type: t });
  if (meta.copyright) w.leaf('rights', meta.copyright);
  w.open('encoding');
  w.leaf('software', 'JSE ' + (meta.appVersion || '1.0.0'));
  w.leaf('encoding-date', new Date().toISOString().slice(0, 10));
  w.leaf('supports', null, { element: 'accidental', type: 'yes' });
  w.leaf('supports', null, { element: 'beam', type: 'yes' });
  w.leaf('supports', null, { element: 'print', attribute: 'new-system', type: 'yes', value: 'yes' });
  w.leaf('supports', null, { element: 'print', attribute: 'new-page', type: 'yes', value: 'yes' });
  w.close();
  w.close();
  // <defaults>: tenths ↔ mm via scaling (10 tenths = one staff space)
  const sp = s.staffSpaceMm || 1.75, T = mm => mm * 10 / sp;
  w.open('defaults');
  w.open('scaling'); w.leaf('millimeters', fmt(sp * 4)); w.leaf('tenths', 40); w.close();
  if (s.concertPitch) w.leaf('concert-score');
  w.open('page-layout');
  w.leaf('page-height', fmt(T(s.pageHeightMm))); w.leaf('page-width', fmt(T(s.pageWidthMm)));
  const m = s.marginsMm || { top: 15, bottom: 15, left: 15, right: 15 };
  w.open('page-margins', { type: 'both' });
  w.leaf('left-margin', fmt(T(m.left))); w.leaf('right-margin', fmt(T(m.right))); w.leaf('top-margin', fmt(T(m.top))); w.leaf('bottom-margin', fmt(T(m.bottom)));
  w.close(); w.close();
  w.open('system-layout');
  w.open('system-margins'); w.leaf('left-margin', 0); w.leaf('right-margin', 0); w.close();
  w.leaf('system-distance', fmt((s.systemGapSp == null ? 9 : s.systemGapSp) * 10));
  w.close();
  w.open('staff-layout'); w.leaf('staff-distance', fmt((s.staffGapSp == null ? 7 : s.staffGapSp) * 10)); w.close();
  if (s.fonts && s.fonts.text) w.leaf('word-font', null, { 'font-family': s.fonts.text, 'font-size': 10 });
  if (s.fonts && s.fonts.lyrics) w.leaf('lyric-font', null, { 'font-family': s.fonts.lyrics, 'font-size': 11 });
  w.close();
  // <credit> blocks for the title page
  const W = T(s.pageWidthMm), H = T(s.pageHeightMm), top = H - T(m.top);
  const credit = (type, text, x, y, justify, valign, size) => {
    if (!text) return;
    w.open('credit', { page: 1 }); w.leaf('credit-type', type);
    w.leaf('credit-words', text, { 'default-x': fmt(x), 'default-y': fmt(y), justify, valign, 'font-size': size });
    w.close();
  };
  credit('title', meta.title, W / 2, top, 'center', 'top', 24);
  credit('subtitle', meta.subtitle, W / 2, top - T(10), 'center', 'top', 14);
  credit('composer', meta.composer, W - T(m.right), top - T(20), 'right', 'bottom', 12);
  credit('lyricist', meta.lyricist, T(m.left), top - T(20), 'left', 'bottom', 12);
  credit('arranger', meta.arranger, W - T(m.right), top - T(26), 'right', 'bottom', 12);
  credit('rights', meta.copyright, W / 2, T(m.bottom), 'center', 'bottom', 8);
}

// ---------- part-list ----------
function drumMapOf(part) {
  const merged = {};
  for (const st of part.staves) if (st.type === 'percussion') Object.assign(merged, st.drumMap || DEFAULT_DRUM_MAP);
  return merged;
}
const partId = pi => 'P' + (pi + 1);
const drumInstrumentId = (pi, key, map) => `${partId(pi)}-I${(map[key].midi | 0) + 1}`;

function writePartList(w, score, ctx) {
  w.open('part-list');
  score.parts.forEach((part, pi) => {
    const id = partId(pi);
    w.open('score-part', { id });
    w.leaf('part-name', part.name || '');
    w.leaf('part-abbreviation', part.abbreviation || '');
    const drums = drumMapOf(part), drumKeys = Object.keys(drums);
    const isPerc = drumKeys.length > 0;
    if (isPerc) {
      for (const k of drumKeys) { w.open('score-instrument', { id: drumInstrumentId(pi, k, drums) }); w.leaf('instrument-name', drums[k].name || k); w.close(); }
    } else {
      w.open('score-instrument', { id: id + '-I1' });
      w.leaf('instrument-name', part.name || part.instrument || 'Instrument');
      w.leaf('instrument-sound', INSTRUMENT_SOUND[part.instrument] || part.instrument || 'keyboard.piano');
      w.close();
    }
    const midi = (instId, unpitched) => {
      w.open('midi-instrument', { id: instId });
      if (part.midiChannel != null) w.leaf('midi-channel', part.midiChannel + 1);
      w.leaf('midi-program', (part.midiProgram | 0) + 1);
      if (unpitched != null) w.leaf('midi-unpitched', unpitched + 1);
      if (part.volume != null) w.leaf('volume', fmt(part.volume * 100));
      if (part.pan != null) w.leaf('pan', fmt(part.pan * 90));
      w.close();
    };
    if (isPerc) for (const k of drumKeys) midi(drumInstrumentId(pi, k, drums), drums[k].midi | 0);
    else midi(id + '-I1', null);
    w.close();
  });
  w.close();
}

// ---------- parts & measures ----------
const NOTE_TYPE = { breve: 'breve', whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', '16th': '16th', '32nd': '32nd', '64th': '64th', '128th': '128th' };
const BAR_STYLE_OUT = { double: 'light-light', final: 'light-heavy', dashed: 'dashed', none: 'none', single: 'regular' };
const TUNING_RE = /^([A-G])(#{1,2}|b{1,2}|x)?(-?\d)$/;
function nameToMidi(s) { const m = TUNING_RE.exec(s || ''); if (!m) return 40; const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]; const alt = { '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[m[2]] || 0; return (parseInt(m[3], 10) + 1) * 12 + base + alt; }
function midiToPitch(midi) { const names = [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]; const pc = ((midi % 12) + 12) % 12; const [step, alter] = names[pc]; return { step, alter, octave: Math.floor(midi / 12) - 1 }; }
function chordParts(ch) {
  if (ch.root) return { root: ch.root, kind: ch.kind || '', bass: ch.bass || '' };
  const m = /^([A-G])([#b♯♭]{0,2})([^/]*)(?:\/([A-G][#b♯♭]{0,2}))?$/.exec((ch.text || '').trim());
  if (!m) return null;
  const n = x => (x || '').replace(/♯/g, '#').replace(/♭/g, 'b');
  return { root: m[1] + n(m[2]), kind: m[3] || '', bass: m[4] ? n(m[4]) : '' };
}
function endingNumber(label) {
  const nums = (String(label || '1').match(/\d+/g) || ['1']).map(Number);
  if (/-/.test(label) && nums.length === 2) { const out = []; for (let i = nums[0]; i <= nums[1]; i++) out.push(i); return out.join(', '); }
  return nums.join(', ');
}

function writePart(w, score, part, pi, ctx) {
  const divisions = chooseDivisions(score, pi);
  const toDiv = ticks => Math.round(ticks * divisions / TPQ);
  const base = ctx.staffBase[pi], nStaves = part.staves.length;
  const drums = drumMapOf(part);
  const tupletOpen = new Map();        // voiceKey → tuplet id currently open
  w.open('part', { id: partId(pi) });
  score.measures.forEach((m, mi) => {
    const ts = effTime(score, mi), cap = measureCapacity(ts);
    w.open('measure', { number: String(mi + 1), implicit: m.pickup ? 'yes' : undefined });
    // <print>
    const prev = score.measures[mi - 1];
    const printAttrs = {};
    if (prev && prev.breaks && prev.breaks.system) printAttrs['new-system'] = 'yes';
    if (prev && prev.breaks && prev.breaks.page) printAttrs['new-page'] = 'yes';
    const numbering = mi === 0 && score.settings && score.settings.measureNumbers && score.settings.measureNumbers !== 'system' ? (score.settings.measureNumbers === 'all' ? 'measure' : 'none') : null;
    const indent = mi === 0 && score.settings && score.settings.firstSystemIndentSp ? score.settings.firstSystemIndentSp : 0;
    if (Object.keys(printAttrs).length || numbering || indent) {
      w.open('print', Object.keys(printAttrs).length ? printAttrs : undefined);
      if (indent) { w.open('system-layout'); w.open('system-margins'); w.leaf('left-margin', fmt(indent * 10)); w.leaf('right-margin', 0); w.close(); w.close(); }
      if (numbering) w.leaf('measure-numbering', numbering);
      w.close();
    }
    // left barline / volta start
    const voltaStarts = ctx.voltaStart.get(m.id) || [];
    const fwd = m._fwdRepeat && !m.barlineLeft;
    if (fwd) m.barlineLeft = 'repeat-start';
    if (m.barlineLeft || voltaStarts.length) {
      w.open('barline', { location: 'left' });
      if (m.barlineLeft === 'repeat-start') w.leaf('bar-style', 'heavy-light');
      else if (m.barlineLeft === 'double') w.leaf('bar-style', 'light-light');
      else if (m.barlineLeft === 'none') w.leaf('bar-style', 'none');
      for (const v of voltaStarts) w.leaf('ending', v.number || '1.', { number: endingNumber(v.number), type: 'start' });
      if (m.barlineLeft === 'repeat-start') w.leaf('repeat', null, { direction: 'forward' });
      w.close();
    }
    if (fwd) delete m.barlineLeft;
    // <attributes>
    const attrs = lazy(w, 'attributes');
    if (mi === 0) { attrs.ensure(); w.leaf('divisions', divisions); }
    if (m.keySig || mi === 0) { attrs.ensure(); const k = m.keySig || { fifths: 0, mode: 'major' }; w.open('key'); w.leaf('fifths', k.fifths | 0); w.leaf('mode', k.mode || 'major'); w.close(); }
    if (m.timeSig || mi === 0) {
      attrs.ensure(); const t = m.timeSig || { num: 4, den: 4 };
      w.open('time', t.display === 'common' || t.display === 'cut' ? { symbol: t.display } : undefined); w.leaf('beats', t.num); w.leaf('beat-type', t.den); w.close();
    }
    if (mi === 0 && nStaves > 1) { attrs.ensure(); w.leaf('staves', nStaves); }
    for (let s = 0; s < nStaves; s++) {
      const clef = mi === 0 ? (m.staves[base + s].clef || part.staves[s].clef) : m.staves[base + s].clef;
      if (!clef) continue;
      attrs.ensure();
      const [sign, line, oct] = CLEF_TO_XML[clef] || CLEF_TO_XML.treble;
      w.open('clef', nStaves > 1 ? { number: s + 1 } : undefined);
      w.leaf('sign', sign); if (line != null) w.leaf('line', line); if (oct) w.leaf('clef-octave-change', oct);
      w.close();
    }
    if (mi === 0) {
      part.staves.forEach((st, s) => {
        const needLines = st.type === 'tab' || (st.lines && st.lines !== 5);
        if (!needLines) return;
        attrs.ensure();
        w.open('staff-details', nStaves > 1 ? { number: s + 1 } : undefined);
        w.leaf('staff-lines', st.lines || (st.type === 'tab' ? 6 : 5));
        if (st.type === 'tab') (st.tuning || ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']).forEach((name, i) => {
          const mm = TUNING_RE.exec(name); if (!mm) return;
          w.open('staff-tuning', { line: i + 1 }); w.leaf('tuning-step', mm[1]);
          const alt = { '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[mm[2]]; if (alt) w.leaf('tuning-alter', alt);
          w.leaf('tuning-octave', mm[3]); w.close();
        });
        w.close();
      });
      if (part.transposeChromatic) { attrs.ensure(); w.open('transpose'); w.leaf('chromatic', part.transposeChromatic); w.close(); }
    }
    attrs.end();
    // measure-start directions (part 0 carries tempo / rehearsal / segno / coda)
    if (pi === 0) {
      if (m.rehearsalMark) { w.open('direction', { placement: 'above' }); w.open('direction-type'); w.leaf('rehearsal', m.rehearsalMark); w.close(); w.close(); }
      for (const mk of m.markers || []) if (mk === 'segno' || mk === 'coda') { w.open('direction', { placement: 'above' }); w.open('direction-type'); w.leaf(mk); w.close(); w.close(); }
      if (m.tempo) {
        const t = m.tempo;
        w.open('direction', { placement: 'above' });
        if (t.text) { w.open('direction-type'); w.leaf('words', t.text, { 'font-weight': 'bold' }); w.close(); }
        w.open('direction-type'); w.open('metronome', t.showBpm === false ? { 'print-object': 'no' } : { parentheses: 'no' });
        w.leaf('beat-unit', NOTE_TYPE[t.beatUnit] || 'quarter'); for (let d = 0; d < (t.dots || 0); d++) w.leaf('beat-unit-dot');
        w.leaf('per-minute', fmt(t.bpm || 120)); w.close(); w.close();
        w.leaf('sound', null, { tempo: fmt((t.bpm || 120) * baseTicks(t.beatUnit || 'quarter', t.dots || 0) / TPQ) });
        w.close();
      }
    }
    for (const t of m.texts || []) {
      const gs = t.staffIndex || 0;
      if (gs < base || gs >= base + nStaves) continue;
      w.open('direction', { placement: t.placement === 'below' ? 'below' : 'above', system: t.style === 'system' ? 'only-top' : undefined });
      w.open('direction-type'); w.leaf('words', t.text, t.style === 'expression' ? { 'font-style': 'italic' } : t.style === 'technique' ? { 'font-weight': 'bold' } : undefined); w.close();
      if (nStaves > 1) w.leaf('staff', gs - base + 1);
      w.close();
    }
    // notes, voice by voice
    const chords = pi === 0 ? [...(m.chords || [])].sort((a, b) => a.tick - b.tick) : [];
    const writes = [];
    for (let s = 0; s < nStaves; s++) {
      const sm = m.staves[base + s];
      sm.voices.forEach((v, vi) => { if (v.length || vi === 0) writes.push({ s, vi, v }); });
    }
    let chordIdx = 0;
    writes.forEach((wr, wi) => {
      const { s, vi, v } = wr;
      const xmlVoice = s * 4 + vi + 1;
      const staffEl = nStaves > 1 ? s + 1 : null;
      const staff = part.staves[s];
      const voiceKey = `${s}:${vi}`;
      let pos = 0;
      const emitHarmonies = (upTo, isLast) => {
        if (s !== 0 || vi !== 0) return;
        while (chordIdx < chords.length && (chords[chordIdx].tick <= upTo + 0.5 || isLast)) { writeHarmony(w, chords[chordIdx], toDiv(chords[chordIdx].tick - pos)); chordIdx++; }
      };
      if (!v.length) {
        emitHarmonies(cap, true);
        w.open('note'); w.leaf('rest', null, { measure: 'yes' }); w.leaf('duration', toDiv(cap)); w.leaf('voice', xmlVoice); if (staffEl) w.leaf('staff', staffEl); w.close();
        pos = cap;
      }
      v.forEach((ev, ei) => {
        const isGrace = !!ev.grace;
        if (!isGrace) emitHarmonies(pos, false);
        writeEventDirections(w, score, ctx, ev, xmlVoice, staffEl, 'before');
        writeNote(w, score, ctx, part, staff, drums, ev, { xmlVoice, staffEl, toDiv, voiceKey, tupletOpen, pi });
        if (!isGrace) pos += durTicks(ev);
        writeEventDirections(w, score, ctx, ev, xmlVoice, staffEl, 'after');
      });
      if (s === 0 && vi === 0) emitHarmonies(pos, true);
      if (wi < writes.length - 1 && pos > 0) { w.open('backup'); w.leaf('duration', toDiv(pos)); w.close(); }
      else if (wi === writes.length - 1 && pos < cap - 1 && pos > 0 && !m.pickup) { w.open('forward'); w.leaf('duration', toDiv(cap - pos)); w.close(); }
    });
    // measure-end markers (Fine, D.S. …) in part 0
    if (pi === 0) for (const mk of m.markers || []) {
      if (mk === 'segno' || mk === 'coda') continue;
      w.open('direction', { placement: 'above' }); w.open('direction-type'); w.leaf('words', MARKER_TEXT[mk] || mk, { 'font-style': 'italic', 'font-weight': 'bold' }); w.close();
      if (MARKER_SOUND[mk]) w.leaf('sound', null, MARKER_SOUND[mk]);
      w.close();
    }
    // right barline / volta end
    const voltaEnds = (ctx.voltaEnd.get(m.id) || []);
    const br = m.barlineRight;
    const isLast = mi === score.measures.length - 1;
    if (br || voltaEnds.length) {
      w.open('barline', { location: 'right' });
      if (br === 'repeat-end' || br === 'repeat-both') w.leaf('bar-style', 'light-heavy');
      else if (br && BAR_STYLE_OUT[br]) w.leaf('bar-style', BAR_STYLE_OUT[br]);
      for (const v of voltaEnds) w.leaf('ending', null, { number: endingNumber(v.number), type: v.voltaType === 'open' ? 'discontinue' : 'stop' });
      if (br === 'repeat-end' || br === 'repeat-both') w.leaf('repeat', null, m.repeatCount ? { direction: 'backward', times: m.repeatCount } : { direction: 'backward' });
      w.close();
    }
    if (br === 'repeat-both' && score.measures[mi + 1] && !score.measures[mi + 1].barlineLeft) score.measures[mi + 1]._fwdRepeat = true;
    void isLast;
    w.close();
  });
  score.measures.forEach(m => { delete m._fwdRepeat; });
  w.close();
}

function writeHarmony(w, ch, offsetDiv) {
  const p = chordParts(ch);
  w.open('harmony', { 'print-frame': ch.diagram ? 'yes' : 'no' });
  if (!p) {
    w.leaf('kind', 'none', { text: ch.text || 'N.C.' });
  } else {
    const r = parseStepAlter(p.root) || { step: 'C', alter: 0 };
    w.open('root'); w.leaf('root-step', r.step); if (r.alter) w.leaf('root-alter', r.alter); w.close();
    const [mxKind, degrees] = splitKind(p.kind);
    w.leaf('kind', mxKind, { text: p.kind });
    if (p.bass) { const b = parseStepAlter(p.bass) || { step: 'C', alter: 0 }; w.open('bass'); w.leaf('bass-step', b.step); if (b.alter) w.leaf('bass-alter', b.alter); w.close(); }
    for (const d of degrees) { w.open('degree'); w.leaf('degree-value', d.value); w.leaf('degree-alter', d.alter || 0); w.leaf('degree-type', d.type); w.close(); }
  }
  if (offsetDiv) w.leaf('offset', offsetDiv);
  if (ch.diagram) {
    const d = ch.diagram, frets = d.frets || [], n = frets.length || 6;
    w.open('frame');
    w.leaf('frame-strings', n); w.leaf('frame-frets', 4);
    w.leaf('first-fret', d.baseFret || 1);
    const barreAt = {};
    for (const b of d.barres || []) { barreAt[`${b.from}`] = { fret: b.fret, type: 'start' }; barreAt[`${b.to}`] = { fret: b.fret, type: 'stop' }; }
    frets.forEach((f, idx) => {
      if (f < 0) return;
      w.open('frame-note'); w.leaf('string', n - idx); w.leaf('fret', f);
      const b = barreAt[idx]; if (b && b.fret === f) w.leaf('barre', null, { type: b.type });
      w.close();
    });
    w.close();
  }
  w.close();
}

/** Directions anchored to an event: dynamics, event texts, wedge / ottava / pedal / text-line spanners. */
function writeEventDirections(w, score, ctx, ev, xmlVoice, staffEl, phase) {
  const dirs = [];
  if (phase === 'before') {
    if (ev.dynamic) dirs.push({ placement: 'below', body: () => { w.open('direction-type'); w.open('dynamics'); if (DYNAMICS.has(ev.dynamic)) w.leaf(ev.dynamic); else w.leaf('other-dynamics', ev.dynamic); w.close(); w.close(); } });
    for (const t of ev.texts || []) dirs.push({ placement: t.placement === 'below' ? 'below' : 'above', body: () => { w.open('direction-type'); w.leaf('words', t.text, t.style === 'expression' ? { 'font-style': 'italic' } : t.style === 'technique' ? { 'font-weight': 'bold' } : undefined); w.close(); } });
    for (const sp of ctx.startsAt.get(ev.id) || []) {
      const n = () => spanNumber(ctx, sp, false);
      if (sp.type === 'crescendo' || sp.type === 'diminuendo') dirs.push({ placement: sp.placement || 'below', body: () => { w.open('direction-type'); w.leaf('wedge', null, { type: sp.type, number: n() }); w.close(); } });
      else if (sp.type === 'ottava') { const sh = sp.octaveShift || 8; dirs.push({ placement: sh > 0 ? 'above' : 'below', body: () => { w.open('direction-type'); w.leaf('octave-shift', null, { type: sh > 0 ? 'down' : 'up', size: Math.abs(sh), number: n() }); w.close(); } }); }
      else if (sp.type === 'pedal') dirs.push({ placement: sp.placement || 'below', body: () => { w.open('direction-type'); w.leaf('pedal', null, { type: 'start', line: 'yes', number: n() }); w.close(); } });
      else if (sp.type === 'textLine') dirs.push({ placement: sp.placement || 'above', body: () => { if (sp.text) { w.open('direction-type'); w.leaf('words', sp.text); w.close(); } w.open('direction-type'); w.leaf('dashes', null, { type: 'start', number: n() }); w.close(); } });
    }
  } else {
    for (const sp of ctx.endsAt.get(ev.id) || []) {
      if (!['crescendo', 'diminuendo', 'ottava', 'pedal', 'textLine'].includes(sp.type)) continue;
      const n = () => spanNumber(ctx, sp, true);
      if (sp.type === 'crescendo' || sp.type === 'diminuendo') dirs.push({ placement: sp.placement || 'below', body: () => { w.open('direction-type'); w.leaf('wedge', null, { type: 'stop', number: n() }); w.close(); } });
      else if (sp.type === 'ottava') dirs.push({ placement: (sp.octaveShift || 8) > 0 ? 'above' : 'below', body: () => { w.open('direction-type'); w.leaf('octave-shift', null, { type: 'stop', size: Math.abs(sp.octaveShift || 8), number: n() }); w.close(); } });
      else if (sp.type === 'pedal') dirs.push({ placement: sp.placement || 'below', body: () => { w.open('direction-type'); w.leaf('pedal', null, { type: 'stop', line: 'yes', number: n() }); w.close(); } });
      else if (sp.type === 'textLine') dirs.push({ placement: sp.placement || 'above', body: () => { w.open('direction-type'); w.leaf('dashes', null, { type: 'stop', number: n() }); w.close(); } });
    }
  }
  for (const d of dirs) {
    w.open('direction', { placement: d.placement });
    d.body();
    w.leaf('voice', xmlVoice);
    if (staffEl) w.leaf('staff', staffEl);
    w.close();
  }
}

function writeNote(w, score, ctx, part, staff, drums, ev, o) {
  const { xmlVoice, staffEl, toDiv, voiceKey, tupletOpen } = o;
  const notes = ev.kind === 'note' && ev.notes && ev.notes.length ? ev.notes : [null];
  const ticks = durTicks(ev);
  // tuplet boundaries within the voice
  let tupStart = false, tupStop = false;
  if (ev.tuplet) {
    if (tupletOpen.get(voiceKey) !== ev.tuplet.id) { tupStart = true; tupletOpen.set(voiceKey, ev.tuplet.id); }
    const f = findEventFast(score, ev.id);
    const next = f && f.voice[f.index + 1];
    if (!next || !next.tuplet || next.tuplet.id !== ev.tuplet.id) { tupStop = true; tupletOpen.delete(voiceKey); }
  }
  const starts = ctx.startsAt.get(ev.id) || [], ends = ctx.endsAt.get(ev.id) || [];
  notes.forEach((n, ni) => {
    w.open('note', ev.hidden ? { 'print-object': 'no' } : (n && n.color ? { color: n.color } : undefined));
    if (ev.grace) w.leaf('grace', null, ev.grace.slash ? { slash: 'yes' } : undefined);
    if (ni > 0) w.leaf('chord');
    if (!n) w.leaf('rest', null, ev.fullMeasureRest ? { measure: 'yes' } : undefined);
    else if (staff.type === 'percussion') { w.open('unpitched'); w.leaf('display-step', n.step); w.leaf('display-octave', n.octave); w.close(); }
    else {
      let pitch = n;
      if (staff.type === 'tab' && n.string) { const tun = staff.tuning || ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']; pitch = midiToPitch(nameToMidi(tun[tun.length - n.string]) + (n.fret || 0)); }
      w.open('pitch'); w.leaf('step', pitch.step); if (pitch.alter) w.leaf('alter', pitch.alter); w.leaf('octave', pitch.octave); w.close();
    }
    if (!ev.grace) w.leaf('duration', toDiv(ticks));
    if (n && n.tieEnd) w.leaf('tie', null, { type: 'stop' });
    if (n && n.tieStart) w.leaf('tie', null, { type: 'start' });
    if (n && staff.type === 'percussion' && n.drum && drums[n.drum]) w.leaf('instrument', null, { id: drumInstrumentId(o.pi, n.drum, drums) });
    w.leaf('voice', xmlVoice);
    if (!ev.fullMeasureRest || n) w.leaf('type', NOTE_TYPE[ev.dur.base] || 'quarter');
    for (let d = 0; d < (ev.dur.dots || 0); d++) w.leaf('dot');
    if (n && n.accidental && ACC_OUT[n.accidental]) w.leaf('accidental', ACC_OUT[n.accidental]);
    if (ev.tuplet) { w.open('time-modification'); w.leaf('actual-notes', ev.tuplet.num); w.leaf('normal-notes', ev.tuplet.den); w.close(); }
    if (n && ni === 0 && ev.stem) w.leaf('stem', ev.stem);
    else if (n && ev.stem) w.leaf('stem', ev.stem);
    let head = n && n.head;
    if (n && !head && staff.type === 'percussion' && n.drum && drums[n.drum] && drums[n.drum].head && drums[n.drum].head !== 'normal') head = drums[n.drum].head;
    if (head && HEAD_OUT[head]) { const [h, filled] = HEAD_OUT[head]; w.leaf('notehead', h, filled ? { filled } : undefined); }
    if (staffEl) w.leaf('staff', staffEl);
    if (ni === 0 && ev.beam && ev.beam !== 'none') w.leaf('beam', ev.beam, { number: 1 });
    else if (ni === 0 && ev._autoBeam) w.leaf('beam', ev._autoBeam, { number: 1 });
    // notations
    const nt = lazy(w, 'notations');
    if (n && n.tieEnd) { nt.ensure(); w.leaf('tied', null, { type: 'stop' }); }
    if (n && n.tieStart) { nt.ensure(); w.leaf('tied', null, { type: 'start' }); }
    if (ni === 0) {
      for (const sp of ends) if (sp.type === 'slur') { nt.ensure(); w.leaf('slur', null, { type: 'stop', number: spanNumber(ctx, sp, true) }); }
      for (const sp of starts) if (sp.type === 'slur') { nt.ensure(); w.leaf('slur', null, { type: 'start', number: spanNumber(ctx, sp, false), placement: sp.placement }); }
      for (const sp of ends) if (sp.type === 'glissando') { nt.ensure(); w.leaf('glissando', null, { type: 'stop', number: spanNumber(ctx, sp, true) }); }
      for (const sp of starts) if (sp.type === 'glissando') { nt.ensure(); w.leaf('glissando', null, { type: 'start', number: spanNumber(ctx, sp, false) }); }
      if (tupStart) { nt.ensure(); w.leaf('tuplet', null, { type: 'start', bracket: ev.tuplet.bracket ? 'yes' : 'no', 'show-number': ev.tuplet.show === 'none' ? 'none' : ev.tuplet.show === 'ratio' ? 'both' : 'actual' }); }
      if (tupStop) { nt.ensure(); w.leaf('tuplet', null, { type: 'stop' }); }
      if (ev.articulations && ev.articulations.length) { nt.ensure(); w.open('articulations'); for (const a of ev.articulations) for (const tag of ART_OUT[a] || []) w.leaf(tag); w.close(); }
      const trillStarts = starts.filter(sp => sp.type === 'trill'), trillEnds = ends.filter(sp => sp.type === 'trill');
      if ((ev.ornaments && ev.ornaments.length) || ev.tremolo || trillStarts.length || trillEnds.length) {
        nt.ensure(); w.open('ornaments');
        for (const orn of ev.ornaments || []) if (ORN_OUT[orn]) w.leaf(ORN_OUT[orn]);
        for (const sp of trillStarts) { if (!(ev.ornaments || []).includes('trill')) w.leaf('trill-mark'); w.leaf('wavy-line', null, { type: 'start', number: spanNumber(ctx, sp, false) }); }
        for (const sp of trillEnds) w.leaf('wavy-line', null, { type: 'stop', number: spanNumber(ctx, sp, true) });
        if (ev.tremolo) w.leaf('tremolo', ev.tremolo, { type: 'single' });
        w.close();
      }
      if (ev.fermata) { nt.ensure(); w.leaf('fermata', null, { type: ev.fermata === 'below' ? 'inverted' : 'upright' }); }
      if (ev.arpeggio) { nt.ensure(); w.leaf('arpeggiate'); }
    }
    if (n && (n.string || n.fret != null && staff.type === 'tab' || n.fingering)) {
      nt.ensure(); w.open('technical');
      if (n.fingering) w.leaf('fingering', n.fingering);
      if (staff.type === 'tab' || n.string) { if (n.string) w.leaf('string', n.string); if (n.fret != null) w.leaf('fret', n.fret); }
      w.close();
    }
    nt.end();
    if (ni === 0) for (const l of ev.lyrics || []) {
      w.open('lyric', { number: l.verse || 1 });
      w.leaf('syllabic', l.syllabic || 'single'); w.leaf('text', l.text || '');
      if (l.extend) w.leaf('extend', null, { type: 'start' });
      w.close();
    }
    w.close();
  });
}

let fastIndex = null;
function findEventFast(score, id) {
  if (!fastIndex || fastIndex.score !== score) {
    const map = new Map();
    score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => v.forEach((ev, index) => map.set(ev.id, { voice: v, index, mi, si, vi })))));
    fastIndex = { score, map };
  }
  return fastIndex.map.get(id);
}

/** Compressed MusicXML (.mxl). Returns a Blob in browsers, a Uint8Array in Node. */
export async function exportMXL(score, { JSZip: Z = globalThis.JSZip } = {}) {
  if (!Z) throw new Error('JSZip가 필요합니다');
  const zip = new Z();
  zip.file('mimetype', 'application/vnd.recordare.musicxml', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container>\n  <rootfiles>\n    <rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>\n  </rootfiles>\n</container>\n');
  zip.file('score.musicxml', exportMusicXML(score));
  const type = typeof Blob !== 'undefined' && typeof window !== 'undefined' ? 'blob' : 'uint8array';
  return zip.generateAsync({ type, mimeType: 'application/vnd.recordare.musicxml', compression: 'DEFLATE' });
}
