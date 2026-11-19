// JSE — Finale (.musx) writer.
//
// A .musx file is a ZIP: `mimetype` (stored), META-INF/container.xml, NotationMetadata.xml and `score.dat`, which
// holds the document as EnigmaXML, gzip-compressed and scrambled with musxCrypt() (see musx.js / SPEC §5b).
// This module builds that EnigmaXML from a ScoreDoc. It imitates what Finale itself writes (container layout,
// header, every global record Finale always writes, record order) and declares file format 26.1 — the format of
// 1,208 of the 1,373 files Finale 27 installs as its own samples — so Finale 26.1+ and 27 open it.
// Global document data (options, fonts, marking categories, articulation/expression library entries, baselines …)
// comes from Finale's factory default document, see musx-defaults.js and tools/musx/gen-defaults.mjs.
//
// What a ScoreDoc has that Finale cannot hold is written in the nearest form; a short Korean note is pushed onto
// `warnings` for each kind of change. Details, the verification method and its numbers: tools/musx/README.md.
//
// Pure JS (browser, WebView, Node).

import { musxCrypt, percTypeForGm } from './musx.js';
import { OPTIONS, STATIC_OTHERS, STATIC_DETAILS, STATIC_TEXTS, ARTICS, DYNAMICS, EXPRESSION_TEMPLATES } from './musx-defaults.js';
import { durTicks, DUR_TICKS, STEPS, keyAlter, midiOf, staffList, noteFromMidi, ticksToDurations } from '../model/score.js';

export const MUSX_VERSION = { major: 26, minor: 1 };
const NS = 'http://www.makemusic.com/2012/finale';
const EDU = 1024;                                        // EDU per quarter note
const toEdu = (ticks) => Math.round(ticks * EDU / 960);
const EVPU_PER_MM = 288 / 25.4;

// ---------------------------------------------------------------------------------------------------------------
// 1. Compact notation for embedded Finale data ("ETN"):  name[attr=v,…]=value | name[…]{children} | name*(v v v)
// ---------------------------------------------------------------------------------------------------------------
const PLAIN = /^[^\s{}()[\]"=,*]+$/;
const tok = (s) => (s !== '' && PLAIN.test(s) ? s : JSON.stringify(s));
/** Encodes element nodes ({tag, attrs, children, text}) in the compact notation. */
export function etnEncode(nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const attrs = Object.entries(n.attrs || {});
    const head = n.tag + (attrs.length ? '[' + attrs.map(([k, v]) => `${k}=${tok(String(v))}`).join(',') + ']' : '');
    if (n.children && n.children.length) { out.push(head + '{' + etnEncode(n.children) + '}'); continue; }
    const text = (n.text || '').trim() === '' ? '' : n.text;
    // runs of attribute-less leaves with text and the same name → name*(v v …)
    if (!attrs.length && text !== '') {
      let j = i; const vals = [];
      while (j < nodes.length && nodes[j].tag === n.tag && !Object.keys(nodes[j].attrs || {}).length && !(nodes[j].children || []).length && (nodes[j].text || '').trim() !== '') vals.push(nodes[j++].text);
      if (vals.length > 2) { out.push(n.tag + '*(' + vals.map(tok).join(' ') + ')'); i = j - 1; continue; }
    }
    out.push(text === '' ? head : head + '=' + tok(text));
  }
  return out.join(' ');
}
/** Decodes the compact notation into element nodes {tag, attrs, children, text}. */
export function etnDecode(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const value = () => {
    if (s[i] === '"') { let j = i + 1; while (s[j] !== '"') { if (s[j] === '\\') j++; j++; } const v = JSON.parse(s.slice(i, j + 1)); i = j + 1; return v; }
    const m = /^[^\s{}()[\]"=,*]+/.exec(s.slice(i, i + 4096)); i += m[0].length; return m[0];
  };
  const list = (end) => {
    const nodes = [];
    for (;;) {
      ws();
      if (i >= s.length || s[i] === end) { i++; return nodes; }
      const name = /^[A-Za-z_][\w.-]*/.exec(s.slice(i, i + 200))[0]; i += name.length;
      const attrs = {};
      if (s[i] === '[') { i++; while (s[i] !== ']') { const k = /^[\w-]+/.exec(s.slice(i, i + 100))[0]; i += k.length + 1; attrs[k] = value(); if (s[i] === ',') i++; } i++; }
      if (s[i] === '*' && s[i + 1] === '(') { i += 2; for (;;) { ws(); if (s[i] === ')') { i++; break; } nodes.push({ tag: name, attrs: {}, children: [], text: value() }); } continue; }
      if (s[i] === '=') { i++; nodes.push({ tag: name, attrs, children: [], text: value() }); continue; }
      if (s[i] === '{') { i++; nodes.push({ tag: name, attrs, children: list('}'), text: '' }); continue; }
      nodes.push({ tag: name, attrs, children: [], text: '' });
    }
  };
  return list(undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. XML output in Finale's layout (2-space indent, one element per line, <empty/>)
// ---------------------------------------------------------------------------------------------------------------
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
/** Element node helper: E(tag, value, attrs) — value: true → <tag/>, number|string → text, array → children; null/false/undefined → no element. */
export function E(tag, v, attrs) {
  if (v == null || v === false) return null;
  if (Array.isArray(v)) return { tag, attrs: attrs || {}, children: v.filter(Boolean), text: '' };
  return { tag, attrs: attrs || {}, children: [], text: v === true ? '' : String(v) };
}
function writeNode(out, n, depth) {
  const pad = '  '.repeat(depth);
  const at = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (n.children && n.children.length) {
    out.push(`${pad}<${n.tag}${at}>`);
    for (const c of n.children) writeNode(out, c, depth + 1);
    out.push(`${pad}</${n.tag}>`);
  } else if (n.text !== '' && n.text != null) out.push(`${pad}<${n.tag}${at}>${escText(n.text)}</${n.tag}>`);
  else out.push(`${pad}<${n.tag}${at}/>`);
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Compression and container
// ---------------------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** gzip with the header Finale's own (zlib, Windows) files carry: 1f 8b 08 00 00000000 00 0b. */
export async function gzipFinale(u8, Z) {
  let deflated = null;
  if (typeof CompressionStream === 'function' && typeof Response === 'function') {
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      deflated = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { deflated = null; }
  }
  if (!deflated && Z) {
    // JSZip (pako) deflate: take the raw DEFLATE data out of a one-entry ZIP
    const zip = new Z(); zip.file('x', u8, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const z = await zip.generateAsync({ type: 'uint8array' });
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const csize = dv.getUint32(18, true), nlen = dv.getUint16(26, true), xlen = dv.getUint16(28, true);
    deflated = z.subarray(30 + nlen + xlen, 30 + nlen + xlen + csize);
  }
  if (!deflated) {                                          // stored DEFLATE blocks (always valid)
    const blocks = Math.max(1, Math.ceil(u8.length / 65535)); deflated = new Uint8Array(u8.length + blocks * 5); let o = 0;
    for (let b = 0; b < blocks; b++) {
      const part = u8.subarray(b * 65535, Math.min(u8.length, (b + 1) * 65535));
      deflated[o++] = b === blocks - 1 ? 1 : 0; deflated[o++] = part.length & 255; deflated[o++] = part.length >>> 8; deflated[o++] = ~part.length & 255; deflated[o++] = (~part.length >>> 8) & 255;
      deflated.set(part, o); o += part.length;
    }
  }
  const out = new Uint8Array(10 + deflated.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0x0b], 0);
  out.set(deflated, 10);
  const crc = crc32(u8), size = u8.length >>> 0, t = 10 + deflated.length;
  out[t] = crc & 255; out[t + 1] = (crc >>> 8) & 255; out[t + 2] = (crc >>> 16) & 255; out[t + 3] = crc >>> 24;
  out[t + 4] = size & 255; out[t + 5] = (size >>> 8) & 255; out[t + 6] = (size >>> 16) & 255; out[t + 7] = size >>> 24;
  return out;
}

/** Public entry: ScoreDoc → .musx bytes. */
export async function exportMusx(score, { JSZip: Z = globalThis.JSZip, warnings = [], now = new Date() } = {}) {
  if (!Z) throw new Error('JSZip가 필요합니다');
  if (!score || !Array.isArray(score.parts) || !score.parts.length || !Array.isArray(score.measures) || !score.measures.length) throw new Error('내보낼 악보가 비어 있습니다');
  const { xml, metadata } = buildEnigmaXml(score, { warnings, now });
  const dat = musxCrypt(await gzipFinale(new TextEncoder().encode(xml), Z));
  const ver = `${MUSX_VERSION.major}.${MUSX_VERSION.minor}`;
  const zip = new Z();
  const date = now;
  zip.file('mimetype', 'application/vnd.makemusic.notation', { compression: 'STORE', date });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<container version="${MUSX_VERSION.major}" xmlns="http://www.makemusic.com/2012/container">\n  <rootfiles>\n    <rootfile full-path="score.dat" media-type="application/vnd.makemusic.notation.dat.1"/>\n  </rootfiles>\n</container>\n`, { compression: 'DEFLATE', date, createFolders: false });   // no META-INF/ folder entry, like Finale's
  zip.file('NotationMetadata.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<metadata version="${ver}" xmlns="http://www.makemusic.com/2012/NotationMetadata">\n  <fileInfo>\n    <keySignature>${escText(metadata.keySignature)}</keySignature>\n    <initialTempo>${metadata.initialTempo}</initialTempo>\n    <scoreDuration>${metadata.scoreDuration.toFixed(1)}</scoreDuration>\n    <creatorString>${escText(metadata.creatorString)}</creatorString>\n  </fileInfo>\n</metadata>\n`, { compression: 'DEFLATE', date });
  zip.file('score.dat', dat, { compression: 'DEFLATE', date, binary: true });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Musical helpers
// ---------------------------------------------------------------------------------------------------------------
const DIATONIC_FOR = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6 };
function diatonicFor(chromatic) { const oct = Math.trunc(chromatic / 12), rem = chromatic - oct * 12; return oct * 7 + (rem < 0 ? -DIATONIC_FOR[-rem] : DIATONIC_FOR[rem]); }
const intervalFifths = (diatonic, chromatic) => 7 * chromatic - 12 * diatonic;
const wrapFifths = (f) => { while (f > 7) f -= 12; while (f < -7) f += 12; return f; };
/** Moves a note by a diatonic + chromatic interval, keeping the spelling (C♯ + M2 = D♯). */
function shiftPitch(n, diatonic, semitones) {
  if (!diatonic && !semitones) return { step: n.step, octave: n.octave, alter: n.alter || 0 };
  const idx = STEPS.indexOf(n.step) + diatonic;
  const step = STEPS[((idx % 7) + 7) % 7];
  const octave = n.octave + Math.floor(idx / 7);
  const alter = midiOf(n) + semitones - midiOf({ step, octave, alter: 0 });
  return { step, octave, alter };
}
/** Diatonic index (C=0 … B=6) of the key's tonic (Finale: harmLev 0 = tonic in the middle-C octave). */
function tonicIndex(fifths, minor) { const major = (((fifths * 4) % 7) + 7) % 7; return minor ? (major + 5) % 7 : major; }
/** Concert pitch → Finale harmLev / harmAlt in a key. */
function harmOf(p, key) {
  const t = tonicIndex(key.fifths, key.mode === 'minor');
  const harmLev = (p.octave - 4) * 7 + STEPS.indexOf(p.step) - t;
  const harmAlt = (p.alter || 0) - keyAlter(p.step, key.fifths);
  return { harmLev, harmAlt };
}
/** Finale key value: low byte = signed fifths, high byte = mode (0 major, 1 minor). */
const keyValue = (k) => ((k.mode === 'minor' ? 1 : 0) << 8) | (k.fifths & 0xff);
const KEY_NAMES = { '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' };
const KEY_NAMES_MINOR = { '-7': 'Abm', '-6': 'Ebm', '-5': 'Bbm', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm', 0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m', 7: 'A#m' };
/** {num, den} → Finale beats / divbeat (EDU per beat). Compound meters (6/8, 9/8, 12/8, 6/4 …) count dotted beats. */
function finaleMeter(ts) {
  const num = Math.max(1, ts.num | 0), den = Math.max(1, ts.den | 0);
  const unit = 4096 / den;
  if (num % 3 === 0 && num > 3 && den >= 4 && Number.isInteger(unit * 3)) return { beats: num / 3, divbeat: unit * 3 };
  if (Number.isInteger(unit)) return { beats: num, divbeat: unit };
  return { beats: num * 4096 / den / 32, divbeat: 32 };   // exotic denominators: count 128ths
}
// noteheads of Finale's percussion layouts in the Maestro Percussion font (closed, half, whole, double whole), as Finale's
// Drum Set layout has them (x heads circled from the half note on); character meanings checked against smufl-mapping
const PERC_HEADS = {
  normal: [207, 250, 119, 87], x: [120, 88, 89, 89], 'circle-x': [88, 88, 89, 89], triangle: [33, 33, 33, 33], 'triangle-black': [49, 33, 33, 33],
  diamond: [35, 35, 35, 35], 'diamond-black': [51, 35, 35, 35], square: [41, 41, 41, 41], plus: [43, 43, 43, 43], slash: [47, 47, 47, 47],
};
// a note's own notehead (Maestro character), as JSE draws it: [quarter and shorter, half and longer]
const NOTEHEAD_CHARS = { x: [192, 192], diamond: [226, 225], 'diamond-black': [226, 226], triangle: [121, 121], 'triangle-black': [209, 209],
  square: [173, 173], slash: [243, 243], plus: [132, 132] };
const CLEF_INDEX = { treble: 0, alto: 1, tenor: 2, bass: 3, percussion: 4, treble8vb: 5, bass8vb: 6, treble8va: 13, tab: 16 };
const nominalEdu = (ev) => { let t = DUR_TICKS[ev.dur.base] || 960; const d = ev.dur.dots || 0; if (d === 1) t *= 1.5; else if (d === 2) t *= 1.75; else if (d === 3) t *= 1.875; return toEdu(t); };

// Finale universal instrument UUIDs (as written in staffSpec <instUuid>)
const UUID = {
  blank: '54422b22-4627-4100-abbf-064eedc15fe3', piano: '776a2734-3f38-4cac-8fa2-90e62b368ec1', organ: '723972d2-a005-492a-b92c-2cb1a6b3f21d',
  epiano: '4b54f9c4-35e3-41f8-9a17-a8797df0f057', voice: '3a3622cc-fc9a-42e0-a743-6b200dd8ce88', soprano: 'b35a14d8-c981-4b8a-a7e4-9a2f8f6be99a',
  alto: 'ab3fc62c-9de9-4018-adf7-58a9d4441a1a', tenor: '03844f81-9f10-431d-813c-659d7533b794', baritone: '6637f6a3-8f69-4dbf-9654-2287933ee7d3',
  bassVoice: 'e9a8eb68-25a0-4c9b-81a1-6e0517ca15be', violin: '29d81c10-dfed-42e4-8d93-64af7d6d5689', viola: '992dcb2b-64a2-454b-b043-2a530d24fc18',
  cello: '33894688-c326-4f8f-b4e2-7a08745e7bcc', doubleBass: '4924f736-97a2-443d-b386-03de2ae6a848', flute: '2575136d-9927-47bd-a727-f554c169257e',
  clarinetBb: 'a16af0c1-8df8-476d-8d74-0d6e1972846b', clarinetA: '9d3e28eb-0640-41f7-9144-0fdef3046d7c', trumpetBb: '69e76d62-3913-4e4a-bb6f-6c05be22abf8',
  trumpetC: 'f0458710-e401-4a33-a9a7-bff5b24006df', guitar: '5e1996eb-40ab-4a92-9a0b-888b93a84c2c', bassGuitar: '0f44376d-e91d-4282-b983-445491635503',
  sopranoRecorder: '0057fd7f-aba1-4149-97b5-98fe8ca28993', sopranoSax: 'ef0f2594-d57b-4cac-b351-f2f906538424',
};

// ---------------------------------------------------------------------------------------------------------------
// 5. Document builder
// ---------------------------------------------------------------------------------------------------------------
// Finale writes record types in a fixed order (observed on 1,373 Finale files, no exceptions).
const ORDER_OTHERS = 'articDef beatChart channelPlayData chordSuffix chordSuffixPlay clefEnum drumLibName drumStaff durAllot execShape fileDesc filePath fretboardSymbol fontName frameSpec lockMeas fretGroup fretInst fretStyle hpOptions instUsed keysAttrib layerAtts measNumbRegion metaArtic metaChord metaClef metaDynam metaKeySig metaRepeat metaShape metaStaffStyle metaTimeSig metaTuplet mmRest measSpec measExprAssign namePosAbbrv namePosAbbrvStyle namePosFull namePosFullStyle textBlock playbackRoute playbackRouteName pageSpec playDefs playDumpShape playDumpText pageTextAssign repeatBack repeatEndingStart repeatEndingText repeatPassList separatesRepeatBack separatesRepeatEndingLine separatesRepeatEndingText separatesTextRepeat shapeData shapeDef shapeList shapeGraphicAssign smartShape smartShapeMeasMark ssLineStyle staffSystemSpec repeatStaffListName repeatStaffListParts repeatStaffListPartsOverride repeatStaffListScore repeatStaffListScoreOverride staffPlayData staffSpec staffStyle staffStyleAssign shapeExprDef timeUpper tempoDef textExprDef textExpressionEnclosure textRepeatAssign textRepeatDef textRepeatText viSetup audioUnitInfo vstInfo partDef partGlobals voicingDef moviePlayerState markingsDialogList markingsCategory markingsCategoryName categoryStaffListName categoryStaffListParts categoryStaffListScore staffAssignStaffListName staffAssignStaffListScore percussionNoteInfo percMapRef volumeValue bypassFxValue finnamFileDesc finnamFilePath drumLayoutPmmRef multiStaffInstGroup multiStaffGroupID stylePlayData hpPrefData hpPrefName'.split(' ');
const ORDER_DETAILS = 'acciAlter entrySize articAssign baselinesChords baselinesExprAboveStaff baselinesExprBelowStaff baselinesFingerboards baselinesLyricsChorus baselinesLyricsSection baselinesLyricsVerse beamExtendDownStem beamExtendUpStem beamStemAdjust beamAltPrimDownStem beamAltPrimUpStem beamAltSecDownStem beamAltSecUpStem centerShape crossChord crossStaff dotOffset floats staffSize fretboard gfhold learnedChordDef lyricEntryInfo midiExprs measNumbIndivPos measTextAssign staffGroup noteAlter perfData secBeamBreak shapeNote shapeNoteStyle smartShapeEntryMark baselinesSysExprBelowStaff stemAdjust baselinesSysLyricsChorus stemDefDown stemDefUp tabAlter tieAlterEnd tieAlterStart tupletDef baselinesSysChords baselinesSysFingerboards baselinesSysLyricsVerse chordAssign lyrDataChorus percussionNoteCode lyrDataVerse activeLyric entryPartFieldDetail hpTechniqueData hpTechniqueName hpTechniqueFilter'.split(' ');
const ORDER_TEXTS = ['fileInfo', 'verse', 'chorus', 'section', 'blockText', 'smartShapeText', 'expression'];
const MAPPINGS = '<mappings>\n    <mapGroup minInclusive="17.0" maxExclusive="18.0">\n' + ['floats', 'measSpec', 'metaKeySig', 'ossiaHeader'].map(p => `      <move>\n        <parent>${p}</parent>\n        <child>\n          <new>keySig</new>\n        </child>\n      </move>\n`).join('') + '    </mapGroup>\n  </mappings>';

class Records {
  constructor(order) { this.order = order; this.map = new Map(); }
  add(tag, attrs, children) { const n = { tag, attrs, children: (children || []).filter(Boolean), text: '' }; let a = this.map.get(tag); if (!a) this.map.set(tag, a = []); a.push(n); return n; }
  addNode(n) { let a = this.map.get(n.tag); if (!a) this.map.set(n.tag, a = []); a.push(n); return n; }
  get(tag) { return this.map.get(tag) || []; }
  sorted() {
    const tags = [...this.map.keys()].sort((a, b) => { const ia = this.order.indexOf(a), ib = this.order.indexOf(b); return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || (a < b ? -1 : 1); });
    const key = (n) => ['cmper1', 'cmper', 'cmper2', 'entnum', 'inci', 'number'].map(k => (n.attrs[k] != null ? +n.attrs[k] : -1));
    const cmp = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]; return 0; };
    return tags.flatMap(t => this.map.get(t).slice().sort(cmp));
  }
}

/** ScoreDoc → { xml (EnigmaXML text), metadata (for NotationMetadata.xml) }. */
export function buildEnigmaXml(score, { warnings = [], now = new Date() } = {}) {
  return new Builder(score, warnings, now).build();
}

class Builder {
  constructor(score, warnings, now) {
    this.score = score; this.now = now;
    this.warnOut = warnings; this.seenWarn = new Set();
    this.others = new Records(ORDER_OTHERS); this.details = new Records(ORDER_DETAILS);
    this.entries = []; this.texts = new Records(ORDER_TEXTS);
    this.nextEntry = 1; this.nextFrame = 1; this.nextTextBlock = 1; this.nextBlockText = 1;
    this.nextExprText = 1; this.nextExprDef = 1; this.nextArtic = 1; this.nextSuffix = 1; this.nextShape = 1;
    this.exprDefs = new Map(); this.articDefs = new Map(); this.suffixes = new Map();
  }
  warn(msg) { if (!this.seenWarn.has(msg)) { this.seenWarn.add(msg); this.warnOut.push(msg); } }

  build() {
    this.analyze();
    this.fonts();
    this.staticRecords();
    this.staves();
    this.music();
    this.lyrics();
    this.articulations();
    this.expressions();
    this.chords();
    this.spanners();
    this.repeats();
    this.layout();
    this.titles();
    this.partsAndPlayback();
    // the order of the expressions in Finale's Expression Selection dialog; key attributes of major and minor
    const defs = this.others.get('textExprDef');
    if (defs.length) this.others.add('markingsDialogList', { cmper: 1 }, [E('numElements', defs.length), ...defs.map(d => E('item', [E('cmper', d.attrs.cmper), E('tag', 'textExprDef')]))]);
    this.others.add('keysAttrib', { cmper: 0 }, []); this.others.add('keysAttrib', { cmper: 1 }, []);
    return { xml: this.serialize(), metadata: this.metadata() };
  }

  // ---- analysis ---------------------------------------------------------------------------------------------
  analyze() {
    const score = this.score;
    this.staffs = staffList(score).map((s) => {
      const chromatic = Math.round(s.part.transposeChromatic || 0), diatonic = diatonicFor(chromatic);
      return { ...s, id: s.globalIndex + 1, chromatic, diatonic, fifthsShift: intervalFifths(diatonic, chromatic), type: s.staff.type || 'standard' };
    });
    const std = this.staffs.filter(S => S.type === 'standard');
    this.refShift = (std.find(S => S.fifthsShift === 0) || std[0] || { fifthsShift: 0 }).fifthsShift;
    let ts = { num: 4, den: 4, display: 'normal' }, key = { fifths: 0, mode: 'major' };
    this.M = score.measures.map((m, mi) => {
      if (m.timeSig && m.timeSig.num > 0 && m.timeSig.den > 0) ts = m.timeSig;
      if (m.keySig) key = { fifths: m.keySig.fifths || 0, mode: m.keySig.mode === 'minor' ? 'minor' : 'major' };
      const concert = { fifths: wrapFifths(key.fifths + this.refShift), mode: key.mode };
      const cap = Math.round(ts.num * 3840 / ts.den);
      let longest = 0;
      for (const sm of m.staves) for (const v of sm.voices) { let t = 0; for (const ev of v) t += durTicks(ev); if (!(v.length === 1 && v[0].fullMeasureRest)) longest = Math.max(longest, t); }
      const len = m.pickup && longest > 0 && longest < cap ? longest : cap;
      if (longest > cap + 1) this.warn('박자표보다 긴 성부가 있는 마디가 있습니다 — Finale에서 마디 길이를 확인해 주세요');
      return { m, mi, ts, key: concert, cap, len, longest, flags: {} };
    });
    // where every event sits (for lines and texts)
    this.pos = new Map();
    score.measures.forEach((m, mi) => m.staves.forEach((sm, gi) => (sm.voices || []).forEach((v, vi) => { let t = 0; for (const ev of v) { this.pos.set(ev.id, { ev, mi, gi, vi, tick: t }); t += durTicks(ev); } })));
  }

  // ---- fonts ------------------------------------------------------------------------------------------------
  fonts() {
    this.staticOthers = etnDecode(STATIC_OTHERS);
    this.fontIds = new Map();
    for (const f of this.staticOthers.filter(n => n.tag === 'fontName')) { const name = f.children.find(c => c.tag === 'name').text; if (!this.fontIds.has(name)) this.fontIds.set(name, +f.attrs.cmper); }
    this.maxFont = Math.max(...this.fontIds.values());
    // Hangul/CJK text needs a font that has the glyphs (Finale's own text fonts have none)
    const meta = this.score.meta || {};
    const cjk = (s) => /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/.test(s || '');
    let any = Object.values(meta).some(v => typeof v === 'string' && cjk(v)) || this.score.parts.some(p => cjk(p.name) || cjk(p.abbreviation));
    let lyr = false;
    for (const m of this.score.measures) {
      if ((m.texts || []).some(t => cjk(t.text)) || cjk(m.rehearsalMark) || cjk(m.tempo?.text)) any = true;
      for (const sm of m.staves) for (const v of sm.voices) for (const ev of v) {
        if ((ev.lyrics || []).some(l => cjk(l.text))) lyr = true;
        if ((ev.texts || []).some(t => cjk(t.text))) any = true;
      }
    }
    this.cjkText = any; this.cjkLyrics = lyr;
  }
  fontId(name) {
    if (!name) return 9;
    if (this.fontIds.has(name)) return this.fontIds.get(name);
    const id = ++this.maxFont; this.fontIds.set(name, id);
    this.others.add('fontName', { cmper: id }, [E('charsetBank', 'Win'), E('charsetVal', 0), E('pitch', 0), E('family', 0), E('name', name)]);
    return id;
  }
  /** Font family, size (pt) and style of a JSE text style key. */
  textFont(styleKey, defaultPt, { italic = false, bold = false } = {}, override = null) {
    const ts = { ...((this.score.settings?.textStyles || {})[styleKey] || {}), ...(override || {}) };
    let fam = ts.family || (styleKey === 'lyrics' ? this.score.settings?.fonts?.lyrics : styleKey !== 'chord' && styleKey !== 'tempo' ? this.score.settings?.fonts?.text : '') || '';
    if (!fam && (styleKey === 'lyrics' ? this.cjkLyrics : this.cjkText)) fam = 'Malgun Gothic';
    const pt = ts.size > 0 ? Math.max(4, Math.round(ts.size * (this.score.settings?.staffSpaceMm || 1.75) / 0.3528)) : defaultPt;
    return { family: fam || 'Times New Roman', id: fam ? this.fontId(fam) : 9, pt, bold: ts.bold ?? bold, italic: ts.italic ?? italic };
  }
  /** Enigma text in the font of a JSE text style. */
  styled(text, styleKey, defaultPt, extra = '', emphasis = {}) {
    const f = this.textFont(styleKey, defaultPt, emphasis);
    return `^fontid(${f.id})^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})${extra}${enigmaEscape(text)}`;
  }

  staticRecords() {
    for (const n of this.staticOthers) this.others.addNode(n);
    for (const n of etnDecode(STATIC_DETAILS)) this.details.addNode(n);
    for (const n of etnDecode(STATIC_TEXTS)) this.texts.addNode(n);
    this.options = etnDecode(OPTIONS);
    this.patchOptions();
  }
  opt(path) {   // finds (and creates) an options node by a path like 'pageFormatOptions/pageFormatScore/pageWidth'
    let list = this.options, node = null;
    for (const part of path.split('/')) {
      const m = /^(\w+)(?:\[(\w+)=([^\]]+)\])?$/.exec(part);
      node = list.find(c => c.tag === m[1] && (!m[2] || c.attrs[m[2]] === m[3]));
      if (!node) { node = { tag: m[1], attrs: m[2] ? { [m[2]]: m[3] } : {}, children: [], text: '' }; list.push(node); }
      list = node.children;
    }
    return node;
  }
  setOpt(path, v) { const n = this.opt(path); n.children = []; n.text = String(v); }
  setFontOpt(type, f) {
    const n = this.opt(`fontOptions/font[type=${type}]`);
    n.children = [E('fontID', f.id), E('fontSize', f.pt), (f.bold || f.italic) ? E('efx', [E('bold', f.bold || null), E('italic', f.italic || null)]) : null].filter(Boolean);
  }

  patchOptions() {
    const s = this.score.settings || {};
    const ev = (mm) => Math.round(mm * EVPU_PER_MM);
    const w = ev(s.pageWidthMm || 210), h = ev(s.pageHeightMm || 297);
    const mg = s.marginsMm || {};
    this.page = { width: w, height: h, top: -ev(mg.top ?? 15), left: ev(mg.left ?? 15), bottom: ev(mg.bottom ?? 15), right: -ev(mg.right ?? 15) };
    // staff height: Finale's rawStaffHeight is the 4-space height of a staff in 1/16 EVPU (1312 → 82 EVPU = 7.2 mm)
    const spaceMm = s.staffSpaceMm > 0 ? s.staffSpaceMm : 1.75;
    this.staffEvpu = Math.max(40, Math.min(160, Math.round(spaceMm * 4 * EVPU_PER_MM)));
    for (const fmt of ['pageFormatScore', 'pageFormatParts']) {
      const p = `pageFormatOptions/${fmt}/`;
      this.setOpt(p + 'pageHeight', h); this.setOpt(p + 'pageWidth', w);
      this.setOpt(p + 'rawStaffHeight', this.staffEvpu * 16);
      for (const side of ['leftPage', 'rightPage']) {
        this.setOpt(`${p}${side}MarginTop`, this.page.top); this.setOpt(`${p}${side}MarginBottom`, this.page.bottom);
        this.setOpt(`${p}${side}MarginLeft`, this.page.left); this.setOpt(`${p}${side}MarginRight`, this.page.right);
      }
    }
    // playback tempo
    const t0 = this.score.measures[0]?.tempo;
    if (t0 && t0.bpm > 0) this.setOpt('playbackOptions/beatsPerMinute', Math.round(t0.bpm * beatEdu(t0) / EDU));
    // fonts of lyrics, chord symbols, staff names, measure numbers from the score's text styles
    const lyr = this.textFont('lyrics', 12);
    if (lyr.family !== 'Times New Roman' || this.score.settings?.textStyles?.lyrics) for (const t of ['lyricVerse', 'lyricChorus', 'lyricSection']) this.setFontOpt(t, lyr);
    else for (const t of ['lyricVerse', 'lyricChorus', 'lyricSection']) this.setFontOpt(t, { id: 10, pt: 12 });
    this.lyricFont = this.score.settings?.textStyles?.lyrics || lyr.family !== 'Times New Roman' ? lyr : { id: 10, pt: 12, bold: false, italic: false };
    if (this.score.settings?.textStyles?.chord) { const c = this.textFont('chord', 12); this.setFontOpt('chord', c); this.chordFont = c; }
    if (this.score.settings?.textStyles?.partName || this.cjkText) for (const t of ['staffNames', 'abbrvStaffNames', 'groupNames', 'abbrvGroupNames']) this.setFontOpt(t, this.textFont('partName', 14));
    // measure numbers
    const region = this.staticOthers.find(n => n.tag === 'measNumbRegion');
    if (region) {
      const mode = s.measureNumbers || 'system';
      const mf = this.score.settings?.textStyles?.measureNumber ? this.textFont('measureNumber', 10, { italic: true }) : null;
      for (const data of region.children.filter(c => c.tag === 'scoreData' || c.tag === 'partData')) {
        const kids = data.children;
        const idx = (t) => kids.findIndex(c => c.tag === t);
        if (mode === 'none' && idx('startOfLine') >= 0) kids.splice(idx('startOfLine'), 1);
        if (mode === 'all' && idx('multipleOf') < 0) kids.splice(Math.max(0, idx('exceptFirstMeas')), 0, E('multipleOf', true));
        if (mf) for (const t of ['startFont', 'multipleFont', 'mmRestFont']) { const n = kids.find(c => c.tag === t); if (n) n.children = [E('fontID', mf.id), E('fontSize', mf.pt), (mf.bold || mf.italic) ? E('efx', [E('bold', mf.bold || null), E('italic', mf.italic || null)]) : null].filter(Boolean); }
      }
    }
  }

  // ---- staves -------------------------------------------------------------------------------------------------
  staves() {
    const score = this.score;
    for (const S of this.staffs) {
      const { part, staff } = S;
      const multi = part.staves.length > 1;
      const kids = [];
      const perc = staff.type === 'percussion';
      if (perc) {
        kids.push(E('notationStyle', 'percussion'));
        // a percussion layout of the staff's drum map: instrument (note type), line and noteheads of every drum
        S.perc = this.percLayout(S, staff);
        this.others.add('drumStaff', { cmper: S.id }, [E('whichDrumLib', S.perc.lib)]);
      }
      const tab = staff.type === 'tab';
      if (tab) {
        // a TAB staff: one line per string, fret numbers from Finale's fret instrument (the tuning), string of each note in <tabAlter>
        S.tuning = (staff.tuning && staff.tuning.length >= 3 ? staff.tuning : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']).map(t => { const m = /^([A-G])(#|b)?(-?\d+)$/.exec(t) || ['', 'E', '', '2']; return midiOf({ step: m[1], octave: +m[3], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 }); });
        S.fretInst = this.fretInst(S.tuning);
        kids.push(E('staffLines', S.tuning.length), E('lineSpace', 36), E('instUuid', this.uuidFor(part, staff)),
          E('noteFont', [E('fontID', 20), E('fontSize', 11), E('efx', [E('bold', true)])]), E('notationStyle', 'tab'), E('blankMeasure', true));
      } else {
        // Finale numbers custom staff lines so that a five-line staff is 11…15: one line is the middle one
        if (perc && staff.lines === 1) kids.push(E('customStaff', [E('staffLine', 13)]), E('botBarlineOffset', -48), E('topBarlineOffset', 48));
        else kids.push(E('staffLines', 5));
        kids.push(E('lineSpace', 24));
        kids.push(E('instUuid', this.uuidFor(part, staff)));
      }
      S.clef0 = perc ? 'percussion' : tab ? 'tab' : (staff.clef || 'treble');
      const clef = CLEF_INDEX[S.clef0] ?? 0;
      if (clef) { kids.push(E('transposedClef', clef)); kids.push(E('defaultClef', clef)); }
      if (S.chromatic && staff.type === 'standard') kids.push(E('transposition', [E('keysig', [E('interval', -S.diatonic), E('adjust', -S.fifthsShift)])]));
      if (multi && S.staffIndex > 0) { kids.push(E('hideMeasNums', true)); kids.push(E('hideRepeats', true)); }
      kids.push(E('dwRestOffset', -4), E('wRestOffset', -4), E('hRestOffset', -4), E('otherRestOffset', -4), E('stemReversal', -4));
      if (!multi) {
        if (part.name) kids.push(E('fullName', this.blockText(this.styled(part.name, 'partName', 14))));
        if (part.abbreviation) kids.push(E('abbrvName', this.blockText(this.styled(part.abbreviation, 'partName', 14))));
      }
      if (tab) kids.push(E('botRepeatDotOff', -7), E('topRepeatDotOff', -3), E('vertTabNumOff', -896), E('stemDir', 'alwaysUp'), E('breakTabLinesAtNotes', true), E('fretInstID', S.fretInst));
      else kids.push(E('botRepeatDotOff', -5), E('topRepeatDotOff', -3), E('vertTabNumOff', -1024));
      this.others.add('staffSpec', { cmper: S.id }, sortByOrder(kids, STAFF_ORDER));
    }
    // the Studio View staff Finale always keeps (tempo / click track)
    this.others.add('staffSpec', { cmper: 32767 }, [E('customStaff', [E('staffLine', 13)]), E('lineSpace', 24), E('instUuid', 'a925648a-abc9-4dc7-a619-a6ce355ad33c'),
      E('botBarlineOffset', -48), E('topBarlineOffset', 48), E('hideMeasNums', true), E('hideRepeats', true), E('hideRptBars', true), E('hideKeySigs', true),
      E('hideClefs', true), E('noKey', true), E('dwRestOffset', -5), E('wRestOffset', -6), E('hRestOffset', -4), E('otherRestOffset', -4), E('stemReversal', -4),
      E('botRepeatDotOff', -5), E('topRepeatDotOff', -3), E('vertTabNumOff', -1024), E('stemDir', 'alwaysUp')]);
    // grand staves: one multi-staff instrument with a brace and the instrument name
    let groupId = 0, multiId = 0;
    for (const [pi, part] of score.parts.entries()) {
      if (part.staves.length < 2) continue;
      const ids = this.staffs.filter(S => S.partIndex === pi).map(S => S.id);
      multiId++; groupId++;
      if (ids.length > 3) this.warn('보표가 4개 이상인 악기는 앞의 3개만 한 악기로 묶었습니다');
      this.others.add('multiStaffInstGroup', { cmper: multiId }, ids.slice(0, 3).map((id, k) => E(`staffNum${k + 1}`, id)));
      this.others.add('multiStaffGroupID', { cmper: multiId }, [E('staffGroupID', groupId)]);
      const full = part.name ? this.blockText(this.styled(part.name, 'partName', 14)) : null;
      const abbr = part.abbreviation ? this.blockText(this.styled(part.abbreviation, 'partName', 14)) : null;
      this.details.add('staffGroup', { cmper1: 0, cmper2: groupId }, [E('startInst', ids[0]), E('endInst', ids[ids.length - 1]), E('startMeas', 1), E('endMeas', 32767),
        E('fullID', full), E('fullXadj', -48), E('bracket', [E('id', 3), E('bracPos', -12)]), E('groupBarlineStyle', 'group'), E('abbrvID', abbr), E('optimize', 'asGroup')]);
    }
    this.staffs.forEach((S, k) => this.instUsed(0, k, S.id, 0));                 // Scroll View
    this.instUsed(65400, 0, 32767, 0);                                             // Studio View
    this.staffs.forEach((S, k) => this.instUsed(65400, k + 1, S.id, -316 - k * 316));
  }
  /**
   * A percussion layout ("drum library") for a drum staff: one <percussionNoteInfo> per drum of the staff's drum map —
   * Finale's note type of its General MIDI key (else a "Custom n" type), its line, noteheads of the Maestro Percussion font.
   * Returns { lib, codes: drum key → note type }.
   */
  percLayout(S, staff) {
    const lib = this.nextDrumLib = (this.nextDrumLib || 0) + 1;
    const codes = new Map(), used = new Set();
    Object.entries(staff.drumMap || {}).forEach(([key, d], inci) => {
      const midi = Math.max(0, Math.min(127, d.midi | 0));
      // a drum read from a Finale layout keeps its note type (finale-<type>); else the type of its MIDI key, else "Custom n" (plays key n-1)
      const fixed = /^finale-(\d+)$/.exec(key);
      let type = fixed && +fixed[1] > 0 && +fixed[1] < 0x10000 ? +fixed[1] : (percTypeForGm(midi) || (midi <= 118 ? 3968 + midi : 4087));
      while (used.has(type) && type < 0xf000) type += 0x1000;   // another copy of the same instrument (order bits)
      used.add(type);
      codes.set(key, type);
      if (d.head && !PERC_HEADS[d.head]) this.warn('타악기 음표 머리 일부는 보통 음표 머리로 저장했습니다');
      const h = PERC_HEADS[d.head] || PERC_HEADS.normal;
      const line = Number.isFinite(d.line) ? Math.round(d.line) : 3;
      this.others.add('percussionNoteInfo', { cmper: lib, inci }, [E('percNoteType', type), E('harmLev', 10 - line || null),
        E('closedNotehead', h[0]), E('halfNotehead', h[1]), E('wholeNotehead', h[2]), E('dwholeNotehead', h[3])]);
    });
    this.others.add('drumLibName', { cmper: lib }, [E('name', `${S.part.name || 'Drums'} (JSE)`)]);
    return { lib, codes };
  }
  /** One <fretInst> per tuning (strings listed from the highest, as MIDI pitches); returns its cmper. */
  fretInst(tuning) {
    this.fretInsts = this.fretInsts || new Map();
    const key = tuning.join(',');
    if (this.fretInsts.has(key)) return this.fretInsts.get(key);
    const cmper = 100 + this.fretInsts.size;
    this.others.add('fretInst', { cmper }, [E('numFrets', 24), E('numStrings', tuning.length), E('name', `JSE ${tuning.length}-string`),
      ...tuning.slice().reverse().map(p => E('string', [E('pitch', p)])), E('speedyClef', tuning.length <= 4 ? 6 : 5)]);
    this.fretInsts.set(key, cmper);
    return cmper;
  }
  instUsed(cmper, inci, inst, distFromTop) {
    this.others.add('instUsed', { cmper, inci }, [E('inst', inst), E('trackType', 'staff'), E('distFromTop', distFromTop),
      E('range', [E('startMeas', 1), E('startEdu', 0), E('endMeas', 32767), E('endEdu', 2147483647)])]);
  }
  uuidFor(part, staff) {
    const inst = part.instrument || '', name = (part.name || '').toLowerCase(), ch = Math.round(part.transposeChromatic || 0);
    if (staff.type === 'percussion') return 'fd54e2db-ca6c-437f-9dd0-f78185897fbd';
    const voices = [[/sopran|소프라노/, 'soprano'], [/\balto\b|알토/, 'alto'], [/tenor|테너/, 'tenor'], [/bariton|바리톤/, 'baritone'], [/\bbass\b|베이스/, 'bassVoice']];
    switch (inst) {
      case 'piano': return UUID.piano;
      case 'keyboard': return /organ|오르간/.test(name) ? UUID.organ : UUID.epiano;
      case 'voice': for (const [re, k] of voices) if (re.test(name)) return UUID[k]; return UUID.voice;
      case 'violin': return UUID.violin; case 'viola': return UUID.viola; case 'cello': return UUID.cello;
      case 'flute': return UUID.flute;
      case 'clarinet': return ch === -3 ? UUID.clarinetA : UUID.clarinetBb;
      case 'trumpet': return ch === 0 ? UUID.trumpetC : UUID.trumpetBb;
      case 'saxophone': return UUID.sopranoSax;
      case 'recorder': return UUID.sopranoRecorder;
      case 'guitar': case 'guitar-tab': case 'ukulele': return UUID.guitar;
      case 'bass': return /contra|double|콘트라/.test(name) ? UUID.doubleBass : UUID.bassGuitar;
      default: return UUID.blank;
    }
  }

  // ---- text blocks ------------------------------------------------------------------------------------------
  /** A textBlock + texts/blockText; returns the textBlock cmper. */
  blockText(raw, justify = null) {
    const textId = this.nextBlockText++;
    this.texts.add('blockText', { number: textId }, []).text = raw;
    const cmper = this.nextTextBlock++;
    this.others.add('textBlock', { cmper }, [E('textID', textId), E('lineSpacingPercent', 100), E('justify', justify), E('newPos36', true), E('showShape', true), E('wordWrap', true), E('textTag', 'block')]);
    return cmper;
  }

  // ---- notes ------------------------------------------------------------------------------------------------------
  music() {
    this.entryOf = new Map();       // JSE event id → { entnum, rec, S, M, layer, tick }
    this.chainTail = new Map();     // `${staffId}:${layer}` → last entry (Finale keeps one linked list per staff and layer)
    for (const S of this.staffs) {
      let clefNow = S.clef0;
      for (const M of this.M) {
        const sm = M.m.staves[S.globalIndex] || { voices: [[]] };
        const frames = [];
        (sm.voices || []).forEach((voice, vi) => {
          if (vi > 3) { this.warn('한 보표에 4개를 넘는 성부는 생략했습니다'); return; }
          if (!voice || !voice.length) return;
          // a lone whole-measure rest: Finale draws the rest of an empty measure itself
          if (voice.length === 1 && voice[0].kind === 'rest' && voice[0].fullMeasureRest && !voice[0].hidden && !voice[0].lyrics && !(voice[0].texts || []).length && !voice[0].dynamic && !voice[0].fermata && !this.spanned(voice[0].id)) return;
          // a lower voice of hidden rests only is left out — unless a line starts or ends on one of them
          if (vi > 0 && voice.every(ev => ev.kind === 'rest' && ev.hidden) && !voice.some(ev => this.spanned(ev.id))) return;
          frames[vi] = this.layerFrame(S, M, voice, vi + 1);
        });
        let clefId = null;
        if (sm.clef && S.type === 'standard' && sm.clef !== clefNow) { clefId = CLEF_INDEX[sm.clef] ?? 0; clefNow = sm.clef; }
        if (!frames.some(Boolean) && clefId == null) continue;
        const kids = [E('clefID', clefId != null ? clefId : (CLEF_INDEX[clefNow] ?? 0)), E('clefPercent', 75)];
        frames.forEach((f, k) => { if (f) kids.push(E(`frame${k + 1}`, f)); });
        this.details.add('gfhold', { cmper1: S.id, cmper2: M.mi + 1 }, kids);
      }
    }
  }
  spanned(id) { return (this.score.spanners || []).some(sp => sp.from?.eventId === id || sp.to?.eventId === id); }

  /** Writes one voice as a Finale layer; returns the frame cmper. */
  layerFrame(S, M, voiceIn, layer) {
    const key = M.key;
    // a whole-measure rest lasts the measure in Finale: rests of the measure's real length (one entry carries its markings)
    const voice = [];
    for (const ev of voiceIn) {
      if (ev.kind === 'rest' && ev.fullMeasureRest && !ev.tuplet && !ev.grace && Math.abs(durTicks(ev) - M.len) > 1) {
        ticksToDurations(M.len).forEach((d, k) => voice.push(k === 0 ? { ...ev, dur: d, fullMeasureRest: undefined, src: ev } : { id: null, kind: 'rest', dur: d, hidden: ev.hidden }));
      } else voice.push(ev);
    }
    const groups = beamFlags(voice, M.ts);
    const recs = [];
    let tick = 0, tuplet = null;
    const tabTuning = S.type === 'tab' ? S.tuning : null;
    voice.forEach((ev, idx) => {
      const entnum = this.nextEntry++;
      const isNote = ev.kind === 'note' && ev.notes && ev.notes.length > 0;
      const kids = [E('dura', nominalEdu(ev))];
      let notes = isNote ? ev.notes.map(n => this.concertPitch(S, n, tabTuning)) : [];
      notes.sort((a, b) => midiOf(a.p) - midiOf(b.p));
      kids.push(E('numNotes', notes.length), E('isValid', true));
      if (isNote) kids.push(E('isNote', true));
      if (ev.grace) kids.push(E('graceNote', true));
      if (ev.tuplet && !ev.grace) {
        const num = Math.max(1, ev.tuplet.num | 0), den = Math.max(1, ev.tuplet.den | 0);
        // a group that only fills part of its ratio (e.g. three 16ths of a 9:4 — how nested tuplets come in from MusicXML)
        // is continued by the next group of the same ratio: one Finale tuplet, not one started inside another
        const continues = tuplet && tuplet.left > 0 && tuplet.id !== ev.tuplet.id && tuplet.num === num && tuplet.den === den;
        if (continues) tuplet.id = ev.tuplet.id;
        if (!tuplet || tuplet.id !== ev.tuplet.id || tuplet.left <= 0) {
          const members = []; for (let j = idx; j < voice.length && voice[j].tuplet && voice[j].tuplet.id === ev.tuplet.id; j++) if (!voice[j].grace) members.push(voice[j]);
          const nominal = members.reduce((s, e) => s + nominalEdu(e), 0);
          let unit = nominal / num;
          if (!Number.isInteger(unit) || unit < 16) unit = nominalEdu(ev);
          tuplet = { id: ev.tuplet.id, num, den, left: num * unit };
          this.details.add('tupletDef', { entnum, inci: 0 }, [E('symbolicNum', num), E('symbolicDur', unit), E('refNum', den), E('refDur', unit),
            E('avoidStaff', true), E('autoBracketStyle', 'neverBeamSide'), E('tupOffY', 24), E('numStyle', ev.tuplet.show === 'none' ? null : ev.tuplet.show === 'ratio' ? 'useRatio' : 'number'),
            E('posStyle', 'beamSide'), E('breakBracket', true), E('matchHooks', true), E('brackStyle', ev.tuplet.bracket === false ? null : 'bracket'), E('smartTuplet', true),
            E('leftHookLen', -12), E('rightHookLen', -12)]);
          kids.push(E('tupletStart', true));
        }
        tuplet.left -= nominalEdu(ev);
      } else if (!ev.grace) tuplet = null;
      if (!isNote) kids.push(E('floatRest', true));
      if (ev.hidden) kids.push(E('ignore', true));
      if (groups[idx]) kids.push(E('beam', true));
      if (ev.stem && isNote) kids.push(E('freezeStem', true));
      if (ev.stem === 'up' && isNote) kids.push(E('upStem', true));
      kids.push(E('sorted', true));
      if (ev.grace && ev.grace.slash) kids.push(E('slashGrace', true));
      const long = ['half', 'whole', 'breve', 'longa', 'maxima'].includes(ev.dur.base);
      let codeInci = 0, tabInci = 0, altInci = 0;
      notes.forEach(({ p, n, code }, k) => {
        const { harmLev, harmAlt } = harmOf(p, key);
        const nk = [E('harmLev', harmLev), E('harmAlt', harmAlt), E('isValid', true)];
        if (n.tieStart) nk.push(E('tieStart', true));
        if (n.tieEnd) nk.push(E('tieEnd', true));
        if (n.accidental && n.accidental !== 'none' && S.type === 'standard') nk.push(E('showAcci', true), E('freezeAcci', true));
        kids.push(E('note', nk, { id: k + 1 }));
        // a note's own notehead (a drum's comes from the percussion layout)
        if (n.head && n.head !== 'normal' && code == null && S.type !== 'tab') {
          const ch = NOTEHEAD_CHARS[n.head];
          if (ch) {
            this.details.add('noteAlter', { entnum, inci: altInci++ }, [E('noteID', k + 1), E('percent', 100), E('altNhead', ch[long ? 1 : 0])]);
            if (!kids.some(c => c.tag === 'noteDetail')) kids.push(E('noteDetail', true));
          } else this.warn('일부 음표 머리 모양(원 안의 x 등)은 보통 음표 머리로 저장했습니다');
        }
        if (code != null) {
          this.details.add('percussionNoteCode', { entnum, inci: codeInci++ }, [E('noteID', k + 1), E('noteCode', code)]);
          if (!kids.some(c => c.tag === 'noteDetail')) kids.push(E('noteDetail', true));
        }
        if (tabTuning && n.string >= 1 && n.string <= tabTuning.length) {
          this.details.add('tabAlter', { entnum, inci: tabInci++ }, [E('noteID', k + 1), E('stringNumber', n.string)]);
          if (!kids.some(c => c.tag === 'noteDetail')) kids.push(E('noteDetail', true));
        }
      });
      const rec = { tag: 'entry', attrs: { entnum, prev: 0, next: 0 }, children: kids, text: '' };
      this.entries.push(rec); recs.push(rec);
      if (ev.id) this.entryOf.set(ev.id, { entnum, rec, S, M, layer, tick, ev: ev.src || ev });
      tick += durTicks(ev);
    });
    const chainKey = `${S.id}:${layer}`;
    const tail = this.chainTail.get(chainKey);
    if (tail) { tail.attrs.next = recs[0].attrs.entnum; recs[0].attrs.prev = tail.attrs.entnum; }
    for (let k = 1; k < recs.length; k++) { recs[k].attrs.prev = recs[k - 1].attrs.entnum; recs[k - 1].attrs.next = recs[k].attrs.entnum; }
    this.chainTail.set(chainKey, recs[recs.length - 1]);
    const frame = this.nextFrame++;
    this.others.add('frameSpec', { cmper: frame, inci: 0 }, [E('startEntry', recs[0].attrs.entnum), E('endEntry', recs[recs.length - 1].attrs.entnum)]);
    return frame;
  }
  /** Written JSE note → concert pitch Finale stores ({p, n}). TAB: pitch of string + fret; drums: the display line. */
  concertPitch(S, n, tabTuning) {
    if (S.type === 'tab' && tabTuning && n.string >= 1 && n.string <= tabTuning.length && n.fret >= 0) {
      const midi = tabTuning[tabTuning.length - n.string] + n.fret;
      return { p: noteFromMidi(midi, 1), n };
    }
    if (S.type === 'tab') return { p: { step: n.step, octave: n.octave, alter: n.alter || 0 }, n };
    if (S.type === 'percussion' && S.perc && n.drum && S.perc.codes.has(n.drum)) {
      // Finale keeps the drum's MIDI key as the note's pitch (spelled with flats) and takes the line from the layout
      return { p: noteFromMidi(Math.max(0, Math.min(127, S.staff.drumMap[n.drum].midi | 0)), -1), n, code: S.perc.codes.get(n.drum) };
    }
    if (S.type !== 'standard') return { p: { step: n.step, octave: n.octave, alter: 0 }, n };
    // notes under an 8va line are stored as written in JSE and in Finale alike: only the instrument transposition moves them
    return { p: shiftPitch(n, S.diatonic, S.chromatic), n };
  }
  flagEntry(id, flag) {
    const e = this.entryOf.get(id); if (!e) return null;
    if (!e.rec.children.some(c => c.tag === flag)) e.rec.children.push(E(flag, true));
    return e;
  }

  // ---- lyrics --------------------------------------------------------------------------------------------------
  lyrics() {
    const verses = new Map();      // verse number → [{ text, sep }]
    const lastData = new Map();    // `${staff}:${verse}` → the lyrDataVerse record of the syllable before
    for (const S of this.staffs) for (const M of this.M) {
      const sm = M.m.staves[S.globalIndex]; if (!sm) continue;
      const evs = [];
      (sm.voices || []).forEach((v, vi) => { let t = 0; v.forEach((ev, k) => { if (ev.lyrics && ev.lyrics.length) evs.push({ ev, t, vi, k }); t += durTicks(ev); }); });
      evs.sort((a, b) => a.t - b.t || a.vi - b.vi || a.k - b.k);
      evs.forEach(({ ev }) => {
        const e = this.entryOf.get(ev.id);
        if (!e) { this.warn('쉼표나 빈 마디에 붙은 가사 일부는 저장하지 않았습니다'); return; }
        let inci = 0;
        for (const ly of [...ev.lyrics].sort((a, b) => (a.verse || 1) - (b.verse || 1))) {
          const num = Math.max(1, Math.min(99, ly.verse | 0 || 1));
          const text = String(ly.text ?? '').trim();
          if (!text) continue;
          // a syllable of underscores only marks a melisma: Finale's word extension on the syllable before (with smart
          // word extensions Finale reads "_" as one, not as text: written as text it would shift every later syllable)
          if (/^_+$/.test(text)) {
            const prev = lastData.get(`${S.id}:${num}`);
            if (prev && !prev.children.some(c => c.tag === 'wext')) prev.children.push(E('wext', 1));
            this.warn('밑줄(_)만 있는 가사 음절은 앞 음절의 낱말 연장선으로 저장했습니다');
            continue;
          }
          let list = verses.get(num); if (!list) verses.set(num, list = []);
          const cont = ly.syllabic === 'begin' || ly.syllabic === 'middle';
          // inside one syllable: a space stays a no-break space, a hyphen a no-break hyphen, an underscore a fullwidth low
          // line (Finale ends a syllable at each of the three)
          list.push({ text: text.replace(/[ \t\n\v\f\r]+/g, '\u00a0').replace(/-/g, '\u2011').replace(/_/g, '\uff3f'), sep: cont ? '-' : ' ' });
          const rec = this.details.add('lyrDataVerse', { entnum: e.entnum, inci: inci++ }, [E('lyricNumber', num), E('syll', list.length), E('wext', ly.extend ? 1 : null)]);
          lastData.set(`${S.id}:${num}`, rec);
          this.flagEntry(ev.id, 'lyricDetail');
        }
      });
    }
    for (const [num, list] of verses) {
      let s = '';
      list.forEach((sy, k) => { s += sy.text; if (k < list.length - 1) s += sy.sep; });
      const f = this.lyricFont;
      this.texts.add('verse', { number: num }, []).text = `^fontid(${f.id})^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})` + enigmaEscape(s);
    }
  }

  // ---- articulations --------------------------------------------------------------------------------------------
  articDef(name) {
    if (this.articDefs.has(name)) return this.articDefs.get(name);
    const src = ARTICS[name]; if (!src) return null;
    const cmper = this.nextArtic++;
    this.others.add('articDef', { cmper }, etnDecode(src));
    this.articDefs.set(name, cmper);
    return cmper;
  }
  articulations() {
    for (const [id, e] of this.entryOf) {
      const ev = e.ev;
      const list = [];
      for (const a of ev.articulations || []) {
        if (ARTICS[a]) list.push({ name: a });
        else this.warn('일부 아티큘레이션은 저장하지 않았습니다');
      }
      for (const o of ev.ornaments || []) {
        if (o === 'inverted-turn') { list.push({ name: 'turn' }); this.warn('역턴(inverted turn)은 턴으로 저장했습니다'); }
        else if (ARTICS[o]) list.push({ name: o });
      }
      if (ev.fermata) list.push({ name: 'fermata', below: ev.fermata === 'below' });
      if (ev.tremolo >= 1 && ev.tremolo <= 3) list.push({ name: `trem${ev.tremolo}` });
      if (ev.arpeggio) list.push({ name: 'arpeggio' });
      if (!list.length) continue;
      list.forEach((a, inci) => {
        const def = this.articDef(a.name);
        this.details.add('articAssign', { entnum: e.entnum, inci }, [E('articDef', def), E('overridePlacement', a.below ? true : null), E('numSlursAvoided', -1)]);
      });
      this.flagEntry(id, 'articDetail');
    }
  }

  // ---- expressions (dynamics, tempo, texts, rehearsal marks) -------------------------------------------------------
  /** One textExprDef (+ its textBlock, text and playback record) per distinct marking. */
  exprDef(key, make) {
    if (this.exprDefs.has(key)) return this.exprDefs.get(key);
    const { template, text, defPatch = {}, enclosure = null } = make();
    const cmper = this.nextExprDef++;
    const textId = this.nextExprText++;
    this.texts.add('expression', { number: textId }, []).text = text;
    const block = this.nextTextBlock++;
    this.others.add('textBlock', { cmper: block }, [E('textID', textId), ...etnDecode(template.block)]);
    let kids = etnDecode(template.def);
    for (const [tag, v] of Object.entries(defPatch)) {
      const i = kids.findIndex(c => c.tag === tag);
      const node = E(tag, v);
      if (i >= 0) { if (node) kids[i] = node; else kids.splice(i, 1); } else if (node) kids.push(node);
    }
    kids = sortByOrder([E('textIDKey', block), ...kids], EXPR_ORDER);
    this.others.add('textExprDef', { cmper }, kids);
    this.others.add('playDumpText', { cmper }, []);
    if (enclosure) this.others.add('textExpressionEnclosure', { cmper }, etnDecode(enclosure));
    this.exprDefs.set(key, cmper);
    return cmper;
  }
  assignExpr(M, def, staffId, layer, tick) {
    const list = this.others.get('measExprAssign').filter(n => +n.attrs.cmper === M.mi + 1);
    this.others.add('measExprAssign', { cmper: M.mi + 1, inci: list.length }, [E('textExprID', def), E('horzEduOff', tick > 0 ? toEdu(tick) : null), E('staffAssign', staffId), E('layer', layer || null), E('playbackStart', 'attach')]);
    M.flags.hasExpr = true;
  }
  dynamicDef(d) {
    const name = String(d).trim();
    return this.exprDef('dyn:' + name, () => {
      // Finale's library names these two the other way round from what their glyphs show (SMuFL: sfp = U+E537 = Maestro 130)
      const lib = DYNAMICS[{ sfp: 'sfzp', sfzp: 'sfp' }[name] || name];
      if (lib) return { template: lib, text: lib.text };
      const glyphs = { p: 112, m: 189, f: 102, r: 142, s: 115, z: 122, n: 150 };
      const chars = [...name].map(c => glyphs[c]);
      if (!chars.length || chars.some(c => !c)) { this.warn('일부 셈여림표는 글자로 저장했습니다'); return { template: EXPRESSION_TEMPLATES.expressive, text: `^fontTxt(Times New Roman,4096)^size(12)^nfx(2)${enigmaEscape(name)}`, defPatch: { descStr: name } }; }
      return { template: EXPRESSION_TEMPLATES.dynamics, text: '^fontMus(Font0,0)^size(24)^nfx(0)' + String.fromCharCode(...chars), defPatch: { value: null, playType: null, descStr: name } };
    });
  }
  textDef(t, category) {
    const style = t.style || 'plain';
    const placement = t.placement === 'below' ? 'below' : 'above';
    const font = t.font ? this.textFont(style === 'expression' ? 'text' : 'text', 12, { italic: style === 'expression' }, t.font) : null;
    const cat = category || (style === 'expression' ? 'expressive' : style === 'technique' ? 'technique' : 'misc');
    const key = `txt:${cat}:${placement}:${t.text}:${font ? JSON.stringify(font) : ''}`;
    return this.exprDef(key, () => {
      const template = cat === 'expressive' ? EXPRESSION_TEMPLATES.expressive : cat === 'technique' ? EXPRESSION_TEMPLATES.technique : cat === 'tempoAlt' ? EXPRESSION_TEMPLATES.tempoAlt : EXPRESSION_TEMPLATES.technique;
      const f = font || this.textFont('text', 12, { italic: cat === 'expressive' || cat === 'tempoAlt' });
      const text = `^fontTxt(${f.family},4096)^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})${enigmaEscape(t.text)}`;
      const above = { vertMeasExprAlign: 'aboveStaffOrEntry', yAdjustEntry: 36, yAdjustBaseline: -16 };
      const below = { vertMeasExprAlign: 'belowStaffOrEntry', yAdjustEntry: -36, yAdjustBaseline: 16 };
      const patch = { ...(placement === 'above' ? above : below), descStr: t.text.slice(0, 60) };
      if (cat === 'misc') Object.assign(patch, { categoryID: 7, useCategoryFonts: null, useCategoryPos: null, horzExprAlign: null });
      if (font) patch.useCategoryFonts = null;
      const native = cat === 'expressive' ? 'below' : 'above';
      if (placement !== native || cat === 'misc') patch.useCategoryPos = null;
      return { template, text, defPatch: patch };
    });
  }
  tempoDef(tp) {
    const unitChar = { whole: 'w', half: 'h', quarter: 'q', eighth: 'e', '16th': 'x' }[tp.beatUnit] || 'q';
    const f = this.textFont('tempo', 14, { bold: true });
    const key = `tempo:${tp.text || ''}:${tp.bpm}:${tp.showBpm !== false}:${tp.beatUnit}:${tp.dots || 0}:${f.id}:${f.pt}`;
    return this.exprDef(key, () => {
      const txt = (s) => `^fontTxt(${f.family},4096)^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})${enigmaEscape(s)}`;
      let text = tp.text ? txt(tp.text) : '';
      if (tp.showBpm !== false && tp.bpm > 0) {
        const note = `^fontMus(EngraverTextT,8191)^size(12)^nfx(0)${unitChar}${'d'.repeat(Math.min(2, tp.dots || 0))}`;
        text += tp.text ? txt(' (') + note + txt(` = ${Math.round(tp.bpm)})`) : note + txt(` = ${Math.round(tp.bpm)}`);
      }
      if (!text) text = txt('');
      const bpmQuarter = Math.round(tp.bpm || 120);
      return { template: EXPRESSION_TEMPLATES.tempo, text, defPatch: { value: bpmQuarter, auxdata1: beatEdu(tp), descStr: `${tp.text || 'Tempo'} (playback Tempo = ${bpmQuarter})` } };
    });
  }
  rehearsalDef(mark) {
    return this.exprDef('reh:' + mark, () => {
      const f = this.textFont('rehearsal', 14, { bold: true });
      const t = EXPRESSION_TEMPLATES.rehearsal;
      return { template: t, text: `^fontTxt(${f.family},4096)^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})${enigmaEscape(mark)}`, defPatch: { rehearsalMarkStyle: null, descStr: mark }, enclosure: t.enclosure };
    });
  }
  expressions() {
    const top = this.staffs[0];
    for (const M of this.M) {
      const m = M.m;
      if (m.tempo && (m.tempo.bpm > 0 || m.tempo.text)) this.assignExpr(M, this.tempoDef(m.tempo), top.id, 0, 0);
      if (m.rehearsalMark) this.assignExpr(M, this.rehearsalDef(String(m.rehearsalMark)), top.id, 0, 0);
      for (const t of m.texts || []) {
        if (!t.text) continue;
        const S = this.staffs[Math.min(this.staffs.length - 1, Math.max(0, t.staffIndex | 0))] || top;
        this.assignExpr(M, this.textDef(t), S.id, 0, 0);
      }
    }
    for (const [, e] of this.entryOf) {
      const ev = e.ev;
      if (ev.dynamic) this.assignExpr(e.M, this.dynamicDef(ev.dynamic), e.S.id, e.layer, e.tick);
      for (const t of ev.texts || []) if (t.text) this.assignExpr(e.M, this.textDef(t), e.S.id, e.layer, e.tick);
    }
    // texts on events that have no entry (whole-measure rests Finale draws itself)
    for (const [id, p] of this.pos) {
      if (this.entryOf.has(id)) continue;
      const ev = p.ev, M = this.M[p.mi], S = this.staffs[p.gi];
      if (ev.dynamic) this.assignExpr(M, this.dynamicDef(ev.dynamic), S.id, p.vi + 1, p.tick);
      for (const t of ev.texts || []) if (t.text) this.assignExpr(M, this.textDef(t), S.id, p.vi + 1, p.tick);
    }
  }

  // ---- chord symbols ---------------------------------------------------------------------------------------------
  suffixFor(kind) {
    if (!kind) return 0;
    if (this.suffixes.has(kind)) return this.suffixes.get(kind);
    const cmper = this.nextSuffix++;
    const f = this.chordFont || { id: 9, pt: 11 };
    let x = 2, inci = 0;
    for (const ch of kind.replace(/♭/g, 'b').replace(/♯/g, '#')) {
      const acci = ch === '#' || (ch === 'b' && inci > 0 && /\d/.test(kind[kind.indexOf(ch) + 1] || ''));
      const code = ch.codePointAt(0);
      if (acci) {
        this.others.add('chordSuffix', { cmper, inci: inci++ }, [E('suffix', ch === '#' ? 35 : 98), E('fontID', 12), E('fontSize', 14), E('xdisp', Math.round(x)), E('ydisp', ch === '#' ? 15 : 8)]);
        x += 14;
      } else {
        this.others.add('chordSuffix', { cmper, inci: inci++ }, [E('suffix', code), E('fontID', f.id), E('fontSize', f.pt === 12 ? 11 : f.pt), E('xdisp', Math.round(x)), E('ydisp', '()'.includes(ch) ? 3 : null)]);
        x += (/[mwMW]/.test(ch) ? 0.85 : /[il1()]/.test(ch) ? 0.35 : 0.52) * (f.pt === 12 ? 11 : f.pt) * 4;
      }
    }
    // what Finale plays for the suffix: up to six intervals above the root (semitones)
    const iv = chordIntervals(kind).slice(0, 6);
    while (iv.length < 6) iv.push(0);
    this.others.add('chordSuffixPlay', { cmper }, iv.map(v => E('data', v)));
    this.suffixes.set(kind, cmper);
    return cmper;
  }
  chords() {
    // chord symbols go on the staff whose key the score shows (JSE's reference staff); Finale keeps a chord as a scale
    // degree of the key, which keeps it right in Finale's concert and transposed views alike
    const std = this.staffs.filter(S => S.type === 'standard');
    const target = std.find(S => S.fifthsShift === 0) || std[0] || this.staffs[0];
    for (const M of this.M) {
      const list = (M.m.chords || []).filter(c => c && (c.text || c.root));
      let inci = 0;
      for (const c of list.slice().sort((a, b) => (a.tick || 0) - (b.tick || 0))) {
        const parsed = parseChord(c);
        if (!parsed) {
          // no root Finale could hold ("N.C.", Roman numerals …): the text, above the staff
          const tick = Math.max(0, Math.min(M.len - 1, Math.round(c.tick || 0)));
          if (String(c.text || '').trim()) { this.assignExpr(M, this.textDef({ text: String(c.text).trim(), placement: 'above', style: 'plain' }), target.id, 0, tick); this.warn('코드로 읽을 수 없는 코드 기호는 글자로 저장했습니다'); }
          continue;
        }
        // the chord is named in the written key of that staff; the measure's key here is concert, so the degree is taken in concert
        const shift = (p) => shiftPitch(p, target.diatonic, target.chromatic);
        const root = shift(parsed.root), bass = parsed.bass ? shift(parsed.bass) : null;
        const t = tonicIndex(M.key.fifths, M.key.mode === 'minor');
        const scale = (p) => ({ num: ((STEPS.indexOf(p.step) - t) % 7 + 7) % 7, alt: (p.alter || 0) - keyAlter(p.step, M.key.fifths) });
        const r = scale(root), b = bass ? scale(bass) : null;
        const suffix = this.suffixFor(parsed.kind);
        if (c.diagram) this.warn('코드 다이어그램(프렛보드)은 저장하지 않았습니다');
        const tick = Math.max(0, Math.min(M.len - 1, Math.round(c.tick || 0)));
        this.details.add('chordAssign', { cmper1: target.id, cmper2: M.mi + 1, inci: inci++ }, sortByOrder([E('suffix', suffix || null), E('fbStyleID', 2), E('rootScaleNum', r.num || null), E('rootAlter', r.alt || null),
          E('rootLowerCase', parsed.lowerRoot || null), E('playSuffix', suffix ? true : null), E('showRoot', true), E('playRoot', true), E('showFretboard', true), E('showSuffix', suffix ? true : null),
          E('bassScaleNum', b && b.num ? b.num : null), E('bassAlter', b && b.alt ? b.alt : null), E('showAltBass', b ? true : null), E('playAltBass', b ? true : null),
          E('horzOff', 12), E('horzEdu', tick > 0 ? toEdu(tick) : null), E('chPercent', 100), E('fbPercent', 100)], CHORD_ORDER));
        M.flags.hasChord = true;
      }
    }
  }

  // ---- smart shapes: slurs, hairpins, 8va, trills, glissandi, pedal and text lines ---------------------------------
  spanners() {
    for (const sp of this.score.spanners || []) {
      if (sp.type === 'volta') continue;
      const a = sp.from && this.pos.get(sp.from.eventId), b = sp.to && this.pos.get(sp.to.eventId);
      if (!a || !b) { this.warn('이어지는 음표를 찾을 수 없는 선은 저장하지 않았습니다'); continue; }
      if (b.mi < a.mi || (b.mi === a.mi && b.tick < a.tick)) { this.warn('끝이 시작보다 앞선 선은 저장하지 않았습니다'); continue; }
      const Sa = this.staffs[a.gi], Sb = this.staffs[b.gi];
      const ea = this.entryOf.get(sp.from.eventId), eb = this.entryOf.get(sp.to.eventId);
      const noteLine = sp.type === 'slur' || sp.type === 'glissando';
      if (noteLine && (!ea || !eb)) { this.warn('쉼표만 있는 마디에 걸친 이음줄은 저장하지 않았습니다'); continue; }
      // a line is attached to its notes ("Attach to Notes") when it must be: slurs and glissandi, and lines on a lower
      // voice — a line attached to measure positions would be read back as belonging to voice 1
      const entryBased = noteLine || !!(ea && eb && (ea.layer > 1 || eb.layer > 1));
      const cmper = this.nextShape++;
      const endPt = (p, e, end) => {
        if (entryBased) return E('endPt', [E('inst', this.staffs[p.gi].id), E('meas', p.mi + 1), E('entryNum', e.entnum)]);
        // an 8va line covers the entries from its first to its last event (Finale includes an entry sitting on the end point);
        // other lines end three quarters into their last note, so that they end before the next one
        let tick = p.tick;
        if (end && sp.type !== 'ottava') tick = Math.min(this.M[p.mi].len, p.tick + Math.round((p.ev.grace ? 0 : durTicks(p.ev)) * 0.75));
        return E('endPt', [E('inst', this.staffs[p.gi].id), E('meas', p.mi + 1), E('edu', tick > 0 ? toEdu(tick) : null)]);
      };
      const adj = (y) => (y ? E('endPtAdj', [E('y', y), E('on', true)]) : null);
      let type, yA = 0, yB = 0, extra = [];
      switch (sp.type) {
        case 'slur': type = sp.placement === 'above' ? 'slurUp' : sp.placement === 'below' ? 'slurDown' : 'slurAuto'; break;
        case 'crescendo': type = 'cresc'; yA = yB = -168; break;
        case 'diminuendo': type = 'decresc'; yA = yB = -168; break;
        case 'ottava': { const o = sp.octaveShift || 8; type = { 8: 'octaveUp', '-8': 'octaveDown', 15: 'twoOctaveUp', '-15': 'twoOctaveDown' }[o] || 'octaveUp'; yA = yB = o > 0 ? 144 : -200; break; }
        case 'trill': type = 'trill'; yA = yB = 96; break;
        case 'glissando': type = 'glissando'; extra = [E('startNoteID', 1), E('endNoteID', 1), E('lineStyleID', 1)]; break;
        case 'pedal': type = 'smartLine'; yA = yB = -192; extra = [E('lineStyleID', 5)]; break;
        case 'textLine': if (sp.text) { type = 'smartLine'; extra = [E('lineStyleID', this.textLineStyle(sp.text))]; } else type = 'dashLine'; yA = yB = 96; break;
        default: this.warn('일부 선(스패너)은 Finale 형식으로 옮기지 못했습니다'); this.nextShape--; continue;
      }
      if (Sa.id !== Sb.id && !entryBased) this.warn('다른 보표로 이어지는 선은 시작 보표에만 그렸습니다');
      const kids = [E('shapeType', type)];
      if (entryBased) kids.push(E('entryBased', true));
      if (type.startsWith('slur')) kids.push(E('rotate', true));
      if (!noteLine) kids.push(E('makeHorz', true));
      if (entryBased) kids.push(E('yBreakType', 'opposite'));
      const bEnd = entryBased ? b : (Sa.id !== Sb.id ? { ...b, gi: a.gi } : b);
      kids.push(E('startTermSeg', [endPt(a, ea, false), adj(yA)]));
      kids.push(E('endTermSeg', [endPt(bEnd, eb, true), adj(yB)]));
      kids.push(...extra);
      this.others.add('smartShape', { cmper }, kids);
      for (let mi = a.mi; mi <= b.mi; mi++) {
        const n = this.others.get('smartShapeMeasMark').filter(r => +r.attrs.cmper === mi + 1).length;
        this.others.add('smartShapeMeasMark', { cmper: mi + 1, inci: n }, [E('shapeNum', cmper)]);
        this.M[mi].flags.hasSmartShape = true;
      }
      if (entryBased) for (const e of [ea, eb]) {
        const n = this.details.get('smartShapeEntryMark').filter(r => +r.attrs.entnum === e.entnum).length;
        this.details.add('smartShapeEntryMark', { entnum: e.entnum, inci: n }, [E('shapeNum', cmper)]);
        this.flagEntry(e.ev.id, 'smartShapeDetail');
      }
    }
  }
  /** A dashed line with a text at its start (like Finale's "rit." line), one per distinct text. */
  textLineStyle(text) {
    if (!text) return 6;
    this.lineStyles = this.lineStyles || new Map();
    if (this.lineStyles.has(text)) return this.lineStyles.get(text);
    const id = 40 + this.lineStyles.size, tid = 100 + this.lineStyles.size;
    const f = this.textFont('text', 12, { italic: true });
    this.texts.add('smartShapeText', { number: tid }, []).text = `^fontid(${f.id})^size(${f.pt})^nfx(${(f.bold ? 1 : 0) | (f.italic ? 2 : 0)})${enigmaEscape(text)}`;
    this.others.add('ssLineStyle', { cmper: id }, [E('lineStyle', 'dashed'), E('dashedParams', [E('lineWidth', 141), E('dashOn', 1152), E('dashOff', 1152)]), E('makeHorz', true),
      E('lineAfterLeftStartText', true), E('leftStartRawTextID', tid), E('leftStartY', -4), E('lineStartX', 6)]);
    this.lineStyles.set(text, id);
    return id;
  }

  // ---- repeats, endings, D.S./D.C./Coda/Fine ------------------------------------------------------------------------
  repeats() {
    const mIndex = new Map(this.M.map((M, mi) => [M.m.id, mi]));
    // backward repeats: how many times
    this.M.forEach((M, mi) => {
      const r = M.m.barlineRight;
      if (r === 'repeat-end' || r === 'repeat-both') this.others.add('repeatBack', { cmper: mi + 1 }, [E('actuate', Math.max(2, M.m.repeatCount | 0 || 2)), E('pos1', -9), E('line1', 2), E('topStaffOnly', true)]);
    });
    // endings
    const voltas = (this.score.spanners || []).filter(sp => sp.type === 'volta' && sp.from && mIndex.has(sp.from.measureId))
      .map(sp => ({ sp, a: mIndex.get(sp.from.measureId), b: mIndex.has(sp.to?.measureId) ? Math.max(mIndex.get(sp.from.measureId), mIndex.get(sp.to.measureId)) : mIndex.get(sp.from.measureId) }))
      .sort((x, y) => x.a - y.a);
    voltas.forEach((v, k) => {
      if (this.others.get('repeatEndingStart').some(r => +r.attrs.cmper === v.a + 1)) { this.warn('같은 마디에서 시작하는 반복 괄호는 하나만 저장했습니다'); return; }
      const passes = String(v.sp.number || '').match(/\d+/g)?.map(Number).filter(n => n > 0 && n < 100) || [];
      if (/\d+\s*[-–]\s*\d+/.test(v.sp.number || '')) { const m = /(\d+)\s*[-–]\s*(\d+)/.exec(v.sp.number); for (let n = +m[1]; n <= +m[2] && n < 100; n++) if (!passes.includes(n)) passes.push(n); }
      if (!passes.length) passes.push(k + 1);
      const next = voltas[k + 1];
      const followed = next && next.a === v.b + 1;
      const kids = [];
      if (followed) kids.push(E('nextEnd', next.a + 1));
      else if (v.b > v.a) kids.push(E('nextEnd', v.b + 2));
      kids.push(E('textPos', 6), E('topStaffOnly', true));
      if (!followed) kids.push(E('action', v.b > v.a ? 'jumpAbsolute' : 'noJump'));
      kids.push(E('trigger', 'onPass'));
      const open = v.sp.voltaType === 'open' || (!v.sp.voltaType && !['repeat-end', 'repeat-both'].includes(this.M[v.b].m.barlineRight));
      if (!open && !followed && !['repeat-end', 'repeat-both'].includes(this.M[v.b].m.barlineRight)) kids.push(E('endLine', -36));
      kids.push(E('textLine', 24));
      this.others.add('repeatEndingStart', { cmper: v.a + 1 }, sortByOrder(kids, ENDING_ORDER));
      this.others.add('repeatPassList', { cmper: v.a + 1 }, passes.map(n => E('act', n)));
      const auto = passes.join(', ') + '.';   // the text Finale draws from the pass list
      const label = String(v.sp.number || '').trim();
      if (label && label.replace(/\s/g, '') !== auto.replace(/\s/g, '')) this.others.add('repeatEndingText', { cmper: v.a + 1 }, [E('rptText', label)]);
      this.M[v.a].flags.barEnding = true;
    });
    // text repeats (markers)
    const MARK = {
      segno: { text: '%', music: true }, coda: { text: 'Þ', music: true }, fine: { text: 'Fine' }, toCoda: { text: 'To Coda' },
      dc: { text: 'D.C.' }, ds: { text: 'D.S.' }, dcAlFine: { text: 'D.C. al Fine' }, dcAlCoda: { text: 'D.C. al Coda' }, dsAlFine: { text: 'D.S. al Fine' }, dsAlCoda: { text: 'D.S. al Coda' },
    };
    const defs = new Map();
    this.M.forEach((M, mi) => {
      let inci = 0;
      for (const mk of M.m.markers || []) {
        const d = MARK[mk]; if (!d) continue;
        if (!defs.has(mk)) {
          const id = defs.size + 1; defs.set(mk, id);
          this.others.add('textRepeatDef', { cmper: id }, d.music ? [E('fontSize', 24)] : [E('fontID', 9), E('fontSize', 14), E('efx', [E('bold', true)]), E('justify', 'right')]);
          this.others.add('textRepeatText', { cmper: id }, [E('rptText', d.text)]);
        }
        const leftSide = mk === 'segno' || mk === 'coda';
        this.others.add('textRepeatAssign', { cmper: mi + 1, inci: inci++ }, [E('horzPos', leftSide ? 0 : M.width || 0), E('repnum', defs.get(mk)), E('vertPos', 14), E('action', 'noJump')]);
        M.flags.txtRepeats = true;
        M.rightRepeatText = M.rightRepeatText || !leftSide;
      }
    });
  }

  // ---- layout: measure widths, systems, pages ----------------------------------------------------------------
  layout() {
    // measure width from durations (Finale's spacing: 84 EVPU per quarter, ×1.6179 per doubling of the duration)
    const allot = (edu) => 84 * Math.pow(1.6179, Math.log2(Math.max(16, edu) / 1024));
    for (const M of this.M) {
      const onsets = new Set([0]);
      for (const sm of M.m.staves) for (const v of sm.voices) { let t = 0; for (const ev of v) if (!ev.grace) { onsets.add(t); t += durTicks(ev); } }
      const pts = [...onsets].sort((a, b) => a - b); pts.push(Math.max(M.len, pts[pts.length - 1] + 1));
      let w = 32;
      for (let k = 0; k + 1 < pts.length; k++) w += Math.max(12, allot(toEdu(pts[k + 1] - pts[k])));
      const lyr = M.m.staves.some(sm => sm.voices.some(v => v.some(ev => ev.lyrics && ev.lyrics.length)));
      M.width = Math.round(Math.max(lyr ? 120 : 80, w * (lyr ? 1.15 : 1)));
    }
    // fix text-repeat positions now that widths are known
    for (const r of this.others.get('textRepeatAssign')) { const M = this.M[+r.attrs.cmper - 1]; const hp = r.children.find(c => c.tag === 'horzPos'); if (hp && hp.text !== '0') hp.text = String(M.width); }
    const sysWidth = this.page.width - this.page.left + this.page.right;   // right margin is negative
    const startStuff = (mi) => 96 + Math.abs(this.M[mi].key.fifths) * 18 + (mi === 0 ? 60 : 0);
    const systems = []; let cur = null;
    this.M.forEach((M, mi) => {
      const prev = this.M[mi - 1];
      const forced = prev && (prev.m.breaks?.system || prev.m.breaks?.page);
      if (!cur || forced || (cur.used + M.width > cur.avail && cur.count > 0)) {
        cur = { start: mi, count: 0, used: 0, avail: sysWidth - startStuff(mi), pageBreak: !!(prev && prev.m.breaks?.page) };
        systems.push(cur);
      }
      if (forced) M.lineBreak = true;
      if (prev && prev.m.breaks?.page) M.pageBreak = true;
      cur.count++; cur.used += M.width;
    });
    // pages: stack systems by height
    const nStaves = this.staffs.length, staffH = this.staffEvpu;
    const gapStaff = Math.round((this.score.settings?.staffGapSp ?? 7) * staffH / 4);
    const gapSys = Math.round((this.score.settings?.systemGapSp ?? 9) * staffH / 4);
    const lyricRoom = this.texts.get('verse').length * 40;
    const sysH = nStaves * staffH + (nStaves - 1) * gapStaff + lyricRoom;
    const pageH = this.page.height + this.page.top - this.page.bottom;   // top margin is negative
    const titleRoom = 240;
    const pages = []; let page = null;
    systems.forEach((sy, k) => {
      if (!page || sy.pageBreak || (page.used + sysH + gapSys > pageH && page.systems.length)) { page = { systems: [], used: k === 0 ? titleRoom : 0 }; pages.push(page); }
      page.systems.push(k + 1); page.used += sysH + gapSys;
      sy.page = pages.length;
    });
    this.systems = systems; this.pages = pages;
    systems.forEach((sy, k) => {
      const cmper = k + 1;
      const pct = sy.used > 0 ? Math.round(10000 * Math.max(1, sy.avail / sy.used)) : 10000;
      const firstOnPage = pages[sy.page - 1].systems[0] === cmper;
      this.others.add('staffSystemSpec', { cmper }, [E('startMeas', sy.start + 1), E('endMeas', sy.start + sy.count + 1), E('horzPercent', pct), E('ssysPercent', 100),
        E('staffHeight', staffH * 64), E('top', k === 0 ? -titleRoom : firstOnPage ? -68 : -68), E('left', k === 0 ? Math.round((this.score.settings?.firstSystemIndentSp || 0) * staffH / 4) || null : null), E('bottom', -200 - lyricRoom), E('scaleVert', true), E('scaleContentOnly', true),
        E('distanceToPrev', k === 0 || firstOnPage ? null : -Math.max(0, gapSys - 96))]);
      this.staffs.forEach((S, i) => this.instUsed(cmper, i, S.id, -i * (staffH + gapStaff)));
    });
    pages.forEach((p, k) => {
      this.others.add('pageSpec', { cmper: k + 1 }, [E('height', this.page.height), E('width', this.page.width), E('percent', 100), E('firstSystem', p.systems[0]), E('scaleContentOnly', true),
        E('margTop', this.page.top), E('margLeft', this.page.left), E('margBottom', this.page.bottom), E('margRight', this.page.right)]);
    });
    for (const M of this.M) this.measSpec(M);
  }
  measSpec(M) {
    const { m, mi, ts } = M;
    const meter = finaleMeter(ts);
    const short = M.len < M.cap - 1;
    const kids = [E('width', M.width || 300)];
    if (M.key.fifths || M.key.mode === 'minor') kids.push(E('keySig', [E('key', keyValue(M.key))]));
    if (short) {
      // a short measure (upbeat, irregular bar): its real length in beats, the time signature shown as written
      const lenEdu = toEdu(M.len);
      const unit = lenEdu % meter.divbeat === 0 ? meter.divbeat : [1024, 512, 256, 128, 64, 32].find(u => lenEdu % u === 0) || 32;
      kids.push(E('beats', lenEdu / unit), E('divbeat', unit), E('dispBeats', meter.beats), E('dispDivbeat', meter.divbeat));
    } else kids.push(E('beats', meter.beats), E('divbeat', meter.divbeat), E('dispBeats', meter.beats), E('dispDivbeat', meter.divbeat));
    if (short) kids.push(E('hideCaution', true));
    if (M.flags.hasSmartShape) kids.push(E('hasSmartShape', true));
    kids.push(E('posMode', 'timesigPlusPos'));
    if (M.lineBreak) kids.push(E('lineBreak', true));
    if (M.flags.hasExpr) kids.push(E('hasExpr', true));
    const right = m.barlineRight;
    const BAR = { single: 'normal', double: 'double', final: 'final', dashed: 'dash', none: 'none', 'repeat-end': 'normal', 'repeat-both': 'normal' };
    let bar = right && BAR[right] ? BAR[right] : 'normal';
    // an invisible barline is a measure without <barline> (Finale's "none", the value it never writes out)
    if (bar !== 'none') kids.push(E('barline', bar));
    if (m.barlineLeft === 'repeat-start' || this.M[mi - 1]?.m.barlineRight === 'repeat-both') kids.push(E('forRepBar', true));
    if (right === 'repeat-end' || right === 'repeat-both') kids.push(E('bacRepBar', true));
    if (M.flags.barEnding) kids.push(E('barEnding', true));
    if (M.flags.txtRepeats) kids.push(E('txtRepeats', true));
    if ((ts.display === 'common' && ts.num === 4 && ts.den === 4) || (ts.display === 'cut' && ts.num === 2 && ts.den === 2)) kids.push(E('abbrvTime', true));
    if (short) kids.push(E('useDisplayTimesig', true));
    if (M.flags.hasChord) kids.push(E('hasChord', true));
    kids.push(E('leftBarline', m.barlineLeft === 'double' ? 'double' : 'default'));
    if (M.pageBreak) kids.push(E('pageBreak', true));
    this.others.add('measSpec', { cmper: mi + 1 }, sortByOrder(kids, MEAS_ORDER));
  }

  // ---- title, composer … (page texts) -------------------------------------------------------------------------
  titles() {
    const meta = this.score.meta || {};
    const add = (type, v) => { if (v) this.texts.add('fileInfo', { type }, []).text = v; };
    add('title', meta.title); add('composer', meta.composer); add('copyright', meta.copyright);
    add('lyricist', meta.lyricist); add('arranger', meta.arranger); add('subtitle', meta.subtitle);
    let inci = 0;
    const page1 = (raw, justify, ydisp, hpos, vpos) => {
      const block = this.blockText(raw, justify === 'left' ? null : justify);
      this.others.add('pageTextAssign', { cmper: 1, inci: inci++ }, [E('block', block), E('ydisp', ydisp), E('startPage', 1), E('endPage', 1),
        E('hposLp', hpos === 'left' ? null : hpos), E('hposRp', hpos === 'left' ? null : hpos), E('vpos', vpos)]);
    };
    if (meta.title) page1(this.styled('', 'title', 24, '^title()'), 'center', -36, 'center');
    if (meta.subtitle) page1(this.styled('', 'subtitle', 18, '^subtitle()'), 'center', -110, 'center');
    if (meta.composer) page1(this.styled('', 'composer', 12, '^composer()'), 'right', -196, 'right');
    if (meta.arranger) page1(this.styled('', 'composer', 12, '^arranger()'), 'right', meta.composer ? -222 : -196, 'right');
    if (meta.lyricist) page1(this.styled('', 'lyricist', 12, '^lyricist()'), 'left', -196, 'left');
    if (meta.copyright) page1(this.styled('', 'text', 10, '^copyright()'), 'center', -36, 'center', 'bottom');
    if (this.pages.length > 1) {   // pages 2+: page number and title, like Finale's default document
      const pn = this.blockText('^fontid(9)^size(12)^nfx(0)^page(0)');
      this.others.add('pageTextAssign', { cmper: 0, inci: 0 }, [E('block', pn), E('ydisp', 48), E('startPage', 2), E('hposRp', 'right'), E('indRpPos', true), E('rightPgYdisp', 48)]);
      if (meta.title) {
        const t = this.blockText(this.styled('', 'title', 12, '^title()'), 'center');
        this.others.add('pageTextAssign', { cmper: 0, inci: 1 }, [E('block', t), E('ydisp', 48), E('startPage', 2), E('hposLp', 'center'), E('hposRp', 'center')]);
      }
    }
  }

  // ---- parts, playback --------------------------------------------------------------------------------------------
  partsAndPlayback() {
    const scoreName = this.blockText('^fontid(9)^size(12)^nfx(0)Score');
    this.others.add('partDef', { cmper: 0 }, [E('nameID', scoreName), E('partOrder', 0), E('copies', 1), E('printPart', true)]);
    this.others.add('partGlobals', { cmper: 65534 }, [E('showTransposed', true), E('studioViewIUlist', 65400)]);
    // one General MIDI route (SmartMusic SoftSynth) per part
    let channel = 0;
    this.score.parts.forEach((part, pi) => {
      const drums = part.staves.some(st => st.type === 'percussion') || part.midiChannel === 9;
      const ch = drums ? 9 : (channel === 9 ? ++channel : channel) % 16; if (!drums) channel++;
      const prog = drums ? 0 : (part.midiProgram || 0) & 127;
      this.others.add('playbackRoute', { cmper: pi + 1 }, [E('virtChannel', ch || null), E('patchType', 'C0_C32_PC'), E('patch', prog || null), E('msb', drums ? 120 : 121)]);
      this.others.add('playbackRouteName', { cmper: pi + 1 }, [E('name', `SmartMusic SoftSynth ${pi + 1}`)]);
    });
    const stream = (route) => [E('playbackRouteNum', route || null), E('velControlLevel', 101), E('velControlSaveFlags', [E('controlOn', true), E('function', 'relative')]), E('play', true)];
    for (const S of this.staffs) this.others.add('staffPlayData', { cmper: S.id }, ['chords', 'midiExpressions', 'layer1', 'layer2', 'layer3', 'layer4'].map(t => E(t, stream(S.partIndex))));
  }

  // ---- output -------------------------------------------------------------------------------------------------------
  header() {
    const d = this.now;
    const ver = (extra = []) => [E('major', MUSX_VERSION.major), E('minor', MUSX_VERSION.minor), E('devStatus', 'dev'), ...extra];
    const stamp = (tag) => E(tag, [E('year', d.getFullYear()), E('month', d.getMonth() + 1), E('day', d.getDate()), E('modifiedBy', true),
      E('enigmaVersion', ver()), E('application', 'FIN'), E('platform', 'WIN'), E('appVersion', ver([E('build', 388)])), E('fileVersion', ver()), E('appRegion', 'US')]);
    return E('header', [E('headerData', [E('wordOrder', 'lo-endian'), E('textEncoding', 'Mac'), stamp('created'), stamp('modified')])]);
  }
  serialize() {
    for (const n of this.chainTail.values()) n.attrs.next = n.attrs.next || 0;
    for (const e of this.entries) {
      e.children = sortByOrder(e.children, ENTRY_ORDER);
      for (const c of e.children) if (c.tag === 'note') c.children = sortByOrder(c.children, NOTE_ORDER);
    }
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<finale version="${MUSX_VERSION.major}.${MUSX_VERSION.minor}" xmlns="${NS}">`, '  ' + MAPPINGS];
    writeNode(out, this.header(), 1);
    writeNode(out, { tag: 'options', attrs: {}, children: this.options, text: '' }, 1);
    writeNode(out, { tag: 'others', attrs: {}, children: this.others.sorted(), text: '' }, 1);
    writeNode(out, { tag: 'details', attrs: {}, children: this.details.sorted(), text: '' }, 1);
    if (this.entries.length) writeNode(out, { tag: 'entries', attrs: {}, children: this.entries, text: '' }, 1);
    else out.push('  <entries/>');
    writeNode(out, { tag: 'texts', attrs: {}, children: this.texts.sorted(), text: '' }, 1);
    out.push('</finale>');
    return out.join('\n') + '\n';
  }
  metadata() {
    const k = this.M[0].key;
    let secs = 0, bpm = 120, beat = 960;
    for (const M of this.M) {
      if (M.m.tempo && M.m.tempo.bpm > 0) { bpm = M.m.tempo.bpm; beat = (DUR_TICKS[M.m.tempo.beatUnit] || 960) * [1, 1.5, 1.75][M.m.tempo.dots || 0]; }
      secs += M.len / beat * 60 / bpm;
    }
    const t0 = this.score.measures[0]?.tempo;
    return { keySignature: (k.mode === 'minor' ? KEY_NAMES_MINOR : KEY_NAMES)[k.fifths] || 'C', initialTempo: Math.round(t0?.bpm || 120), scoreDuration: secs, creatorString: 'JSE' };
  }
}

const EXPR_ORDER = ['textIDKey', 'categoryID', 'value', 'execShape', 'rehearsalMarkStyle', 'auxdata1', 'hideMeasureNum', 'matchPlayback', 'playPass', 'useAuxData', 'createdByHp', 'newEnclosure', 'breakMmRest', 'playType', 'horzMeasExprAlign', 'horzExprAlign', 'measXAdjust', 'vertMeasExprAlign', 'yAdjustBaseline', 'yAdjustEntry', 'useCategoryFonts', 'useCategoryPos', 'descStr'];
/** Beat of a tempo marking in EDU (dotted values included). */
function beatEdu(tp) { return toEdu((DUR_TICKS[tp.beatUnit] || 960) * [1, 1.5, 1.75][tp.dots || 0]); }
/** Intervals (semitones above the root, root excluded) a chord suffix stands for: "m7" → [3, 7, 10]. */
export function chordIntervals(kind) {
  const k = String(kind || '').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/Δ/g, 'maj').replace(/°/g, 'dim').replace(/ø/g, 'm7b5').replace(/[()\s,]/g, '');
  let third = 4, fifth = 7; const ext = new Set();
  let rest = k;
  if (/^(maj|ma|M)(?=\d|$)/.test(rest)) { ext.add('maj'); rest = rest.replace(/^(maj|ma|M)/, ''); }
  else if (/^(min|mi|m|-)(?!aj)/.test(rest)) { third = 3; rest = rest.replace(/^(min|mi|m|-)/, ''); }
  else if (/^dim/.test(rest)) { third = 3; fifth = 6; rest = rest.slice(3); if (/^7/.test(rest)) { ext.add('dim7'); rest = rest.slice(1); } }
  else if (/^(aug|\+)/.test(rest)) { fifth = 8; rest = rest.replace(/^(aug|\+)/, ''); }
  if (/^5$/.test(rest)) return [7];
  if (/^(maj|Maj|ma|M)7/.test(rest)) { ext.add('maj'); rest = rest.replace(/^(maj|Maj|ma|M)/, ''); }
  const out = new Set([third, fifth]);
  const seventh = () => out.add(ext.has('maj') ? 11 : ext.has('dim7') ? 9 : 10);
  if (ext.has('dim7')) out.add(9);
  const num = /^(6|7|9|11|13)/.exec(rest);
  if (num) {
    rest = rest.slice(num[1].length);
    if (num[1] === '6') out.add(9);
    else { seventh(); if (+num[1] >= 9) out.add(14); if (+num[1] === 11) out.add(17); if (+num[1] === 13) out.add(21); }
  } else if (ext.has('maj')) seventh();
  for (const m of rest.matchAll(/(sus2|sus4|sus|add9|add11|add13|add2|add4|b5|#5|b9|#9|#11|b13|omit3|omit5|no3|no5|alt|6|9)/g)) {
    switch (m[1]) {
      case 'sus2': case 'add2': if (m[1] === 'sus2') out.delete(third); out.add(2); break;
      case 'sus4': case 'sus': out.delete(third); out.add(5); break;
      case 'add4': out.add(5); break;
      case 'add9': case '9': out.add(14); break;
      case 'add11': out.add(17); break;
      case 'add13': out.add(21); break;
      case '6': out.add(9); break;
      case 'b5': out.delete(7); out.add(6); break;
      case '#5': out.delete(7); out.add(8); break;
      case 'b9': out.add(13); break;
      case '#9': out.add(15); break;
      case '#11': out.add(18); break;
      case 'b13': out.add(20); break;
      case 'omit3': case 'no3': out.delete(third); break;
      case 'omit5': case 'no5': out.delete(fifth); break;
      case 'alt': out.add(10); out.add(13); out.add(15); out.add(8); break;
    }
  }
  return [...out].filter(v => v > 0).sort((a, b) => a - b);
}
/** Chord symbol → { root:{step,alter}, kind, bass, lowerRoot } (root/bass at octave 4). */
function parseChord(c) {
  const text = String(c.text || '').replace(/♯/g, '#').replace(/♭/g, 'b').trim();
  const m = /^([A-Ga-g])(#{1,2}|b{1,2})?(.*?)(?:\/([A-Ga-g])(#{1,2}|b{1,2})?)?$/.exec(text) || (c.root ? /^([A-Ga-g])(#{1,2}|b{1,2})?()$/.exec(String(c.root).replace(/♯/g, '#').replace(/♭/g, 'b')) : null);
  if (!m) return null;
  const alt = (s) => (!s ? 0 : s[0] === '#' ? s.length : -s.length);
  return { root: { step: m[1].toUpperCase(), octave: 4, alter: alt(m[2]) }, lowerRoot: m[1] !== m[1].toUpperCase(), kind: (m[3] || '').trim(), bass: m[4] ? { step: m[4].toUpperCase(), octave: 3, alter: alt(m[5]) } : null };
}

// field orders (as Finale writes them; from musxdom's populators, which follow EnigmaXML order)
const ENTRY_ORDER = ['dura', 'numNotes', 'posi', 'isValid', 'isNote', 'controller', 'v2', 'createdByHP', 'playDisabledByHP', 'graceNote', 'floatRest', 'noteDetail', 'ignore', 'articDetail', 'tupletStart', 'lyricDetail', 'splitRest', 'performanceData', 'beamExt', 'dotTieAlt', 'flipTie', 'beam', 'secBeam', 'freezeStem', 'stemDetail', 'crossStaff', 'upStem', 'reverseUpStem', 'reverseDownStem', 'doubleStem', 'splitStem', 'checkAccis', 'noLeger', 'dummy', 'smartShapeDetail', 'sorted', 'slashGrace', 'noPlayback', 'noSpacing', 'freezeBeam', 'flatBeam', 'note'];
const STAFF_ORDER = ['staffLines', 'customStaff', 'lineSpace', 'instUuid', 'botBarlineOffset', 'altNotation', 'altLayer', 'altSlashDots', 'altHideArtics', 'altHideLyrics', 'altHideSmartShapes', 'noteFont', 'notationStyle', 'showNoteColors', 'hasStyles', 'blankMeasure', 'useNoteShapes', 'useNoteFont', 'transposedClef', 'defaultClef', 'transposition', 'topBarlineOffset', 'floatKeys', 'floatTime', 'hideMeasNums', 'hideRepeats', 'hideBarlines', 'hideStfNameInScore', 'hideRptBars', 'hideKeySigs', 'hideTimeSigs', 'hideClefs', 'hideStaffLines', 'hideChords', 'noKey', 'dwRestOffset', 'wRestOffset', 'hRestOffset', 'otherRestOffset', 'stemReversal', 'fullName', 'abbrvName', 'botRepeatDotOff', 'topRepeatDotOff', 'vertTabNumOff', 'stemDir', 'hideRests', 'hideTies', 'hideMode', 'breakTabLinesAtNotes', 'autoNum', 'redisplayLayerAccis', 'stemStartFromStaff', 'hideDots', 'stemsFixedEnd', 'hideStems', 'useTabLetters', 'stemsFixedStart', 'fretInstID', 'hideTimeSigsInParts', 'useAutoNum', 'vertStemStartOffUp', 'vertStemStartOffDown', 'vertStemEndOffUp', 'vertStemEndOffDown'];
const CHORD_ORDER = ['suffix', 'fbStyleID', 'rootScaleNum', 'rootLowerCase', 'rootAlter', 'playSuffix', 'showRoot', 'playRoot', 'showFretboard', 'showSuffix', 'bassScaleNum', 'bassAlter', 'bassLowerCase', 'bassPosition', 'showAltBass', 'playAltBass', 'horzOff', 'vertOff', 'fbHorzOff', 'fbVertOff', 'horzEdu', 'chPercent', 'fbPercent'];
const ENDING_ORDER = ['staffList', 'nextEnd', 'textPos', 'pos1', 'line1', 'topStaffOnly', 'indivPlac', 'action', 'hidden', 'trigger', 'jmpIgnore', 'endLine', 'textLine', 'pos2', 'line2'];
const NOTE_ORDER = ['harmLev', 'harmAlt', 'isValid', 'tieStart', 'crossStaff', 'tieEnd', 'upStemSecond', 'downStemSecond', 'upSplitStem', 'showAcci', 'parenAcci', 'noPlayback', 'noSpacing', 'freezeAcci', 'playDisabledByHP'];
const MEAS_ORDER = ['width', 'keySig', 'beats', 'divbeat', 'dispBeats', 'dispDivbeat', 'frontSpaceExtra', 'customBarShape', 'customLeftBarShape', 'breakWordExt', 'backSpaceExtra', 'hideCaution', 'hasSmartShape', 'groupBarlineOverride', 'showFullNames', 'showKey', 'mnSepPlace', 'posSplit', 'altNumTsig', 'altDenTsig', 'showTime', 'indivPosDef', 'posMode', 'lineBreak', 'hasExpr', 'breakRest', 'hasTextBlock', 'noMeasNum', 'arbitMusic', 'barline', 'abbrvTime', 'txtRepeats', 'forRepBar', 'bacRepBar', 'useDisplayTimesig', 'barEnding', 'hasChord', 'leftBarline', 'displayAltNumTsig', 'displayAltDenTsig', 'pageBreak'];
function sortByOrder(kids, order) {
  const list = kids.filter(Boolean);
  return list.map((k, i) => ({ k, i, o: order.indexOf(k.tag) })).sort((a, b) => (a.o < 0 ? 1e6 : a.o) - (b.o < 0 ? 1e6 : b.o) || a.i - b.i).map(x => x.k);
}
function gcdInt(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; }

/** Text inside an Enigma string: '^' must be doubled. */
function enigmaEscape(s) { return String(s || '').replace(/\^/g, '^^'); }

/**
 * Finale's beam flags: an entry carries <beam/> when a beam group starts on it (or it cannot be beamed: quarter
 * and longer notes); entries without it continue the beam of the entry before. Rests inside a group carry no flag.
 * Explicit JSE beams (begin/continue/end/none) win; otherwise groups follow the beat like JSE's own engraver.
 */
/**
 * Finale's beam flag of each entry: set on an entry that starts a beam group or stands alone, unset on one that continues
 * the beam of the entry before it. The groups are the ones JSE draws (explicit beam modes, else the automatic grouping).
 */
function beamFlags(voice, ts) {
  const flags = voice.map(() => true);
  for (const g of autoBeamGroups(voice, ts)) for (let k = 1; k < g.length; k++) flags[g[k]] = false;
  // grace notes are beamed among themselves
  voice.forEach((ev, i) => { if (ev.grace) flags[i] = i === 0 || !voice[i - 1].grace || (DUR_TICKS[ev.dur.base] || 960) > 480; });
  return flags;
}
// Same grouping rules as engrave/layout.js autoBeamGroups (kept local, like io/musicxml.js and io/nwc-export.js, so that
// this module stays independent of the engraver): what JSE draws.
function autoBeamGroups(voice, ts) {
  const beat = (ts.den === 8 && ts.num % 3 === 0) ? 1440 : ts.den === 2 ? 1920 : ts.den === 16 || ts.den === 8 ? 480 : 960;
  const beams = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4, '128th': 5 };
  const groups = []; let cur = null, tick = 0;
  const flush = () => { if (cur && cur.idx.length > 1) groups.push(cur.idx); cur = null; };
  voice.forEach((ev, i) => {
    const beamable = beams[ev.dur.base] > 0 && !ev.grace && ev.kind === 'note';
    const manual = ev.beam;
    if (manual === 'begin') { flush(); cur = { start: tick, idx: [i], manual: true }; }
    else if (manual === 'continue' || manual === 'end') { if (cur) cur.idx.push(i); else cur = { start: tick, idx: [i], manual: true }; if (manual === 'end') flush(); }
    else if (manual === 'none' || !beamable) flush();
    else {
      const bi = Math.floor((tick + 1e-6) / beat);
      if (cur && !cur.manual && Math.floor((cur.start + 1e-6) / beat) === bi && cur.tid === (ev.tuplet?.id || null)) cur.idx.push(i);
      else { flush(); cur = { start: tick, idx: [i], tid: ev.tuplet?.id || null }; }
    }
    if (!ev.grace) tick += durTicks(ev);
  });
  flush();
  if (ts.den === 4 && ts.num % 2 === 0) {
    // adjacent groups of plain eighths in one half bar are one group
    const merged = [];
    const tickOf = (idx) => { let t = 0; for (let k = 0; k < idx; k++) if (!voice[k].grace) t += durTicks(voice[k]); return t; };
    const plain8 = (g) => g.every(i => voice[i].dur.base === 'eighth' && !voice[i].dur.dots && !voice[i].tuplet);
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      if (prev && plain8(prev) && plain8(g) && prev[prev.length - 1] + 1 === g[0] && Math.floor(tickOf(prev[0]) / 1920) === Math.floor(tickOf(g[0]) / 1920)) { prev.push(...g); continue; }
      merged.push(g);
    }
    return merged;
  }
  return groups;
}
