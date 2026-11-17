// JSE — NoteWorthy Composer files (.nwc, .nwctxt): import and export.
//
// File forms
//   "[NWZ]\0" + zlib stream     compressed .nwc — what NWC normally saves; inside is one of:
//   "[NoteWorthy ArtWare]…"     plain .nwc. Versions 1.x / 2.0 / 2.5 are a binary object dump
//                               (nwc-binary.js). Version 2.75 is a short binary header followed
//                               by the song as nwctxt text.
//   "!NoteWorthyComposer(2.75)" .nwctxt — the text form (nwc-text.js).
// Text is UTF-8 in 2.75 files and in the Windows ANSI code page of the author before that —
// CP949 for nearly every Korean hymn or choir file (nwc-encoding.js).
//
// Pipeline:  bytes → container → NWC document → ScoreDoc (nwc-convert.js)
//            ScoreDoc → NWC document (nwc-export.js) → nwctxt / .nwc 2.75 / binary .nwc 1.75
// Pure JS: runs in browsers, WebViews, Electron and Node.

import { NWC_ENCODINGS, detectEncoding, decodeBytes, isValidUtf8, normalizeEncoding, encodingFromCodePage, encodingFromCharSet } from './nwc-encoding.js';
import { parseNwcBinary, NWC_MAGIC } from './nwc-binary.js';
import { parseNwctxt } from './nwc-text.js';
import { nwcToScore } from './nwc-convert.js';
import { inflateZlib } from './nwc-zlib.js';
import { scoreToNwctxt, scoreToNwcFile } from './nwc-export.js';

export { NWC_ENCODINGS };
export const NWC_EXTENSIONS = ['.nwc', '.nwctxt'];

const NWZ = '[NWZ]';
const TXT = '!NoteWorthyComposer';
const startsWith = (b, s, at = 0) => { if (b.length < at + s.length) return false; for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false; return true; };
function indexOfAscii(b, s, from = 0, to = b.length) {
  const c0 = s.charCodeAt(0);
  outer: for (let i = from; i <= Math.min(to, b.length) - s.length; i++) {
    if (b[i] !== c0) continue;
    for (let j = 1; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('NWC 파일 데이터를 읽을 수 없습니다');
}
/** Start of nwctxt in a text file (after a BOM / blank lines), or -1. */
function textStart(b) {
  let p = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) p = 3;
  while (p < b.length && p < 64 && (b[p] === 0x20 || b[p] === 0x09 || b[p] === 0x0d || b[p] === 0x0a)) p++;
  return startsWith(b, TXT, p) ? p : -1;
}

/** True for .nwc (compressed or not) and .nwctxt data. */
export function looksLikeNwc(data) {
  let b;
  try { b = toBytes(data); } catch (_) { return false; }
  return startsWith(b, NWZ) || startsWith(b, NWC_MAGIC) || textStart(b.subarray(0, 128)) >= 0;
}

/** Decodes nwctxt bytes. NWC 2.75 text is UTF-8, but single lines written through the ANSI API
 *  (font names, built-in strings) can still be in the code page — so lines are judged one by one. */
function decodeNwctxt(bytes, { encoding, fallbackEncoding, codePage }) {
  if (encoding !== 'auto') return { text: decodeBytes(bytes, encoding), encoding, guessed: false };
  let high = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) { high = true; break; }
  const head = decodeBytes(bytes.subarray(0, 64), 'windows-1252');
  const ver = parseFloat((/\(([0-9.]+)/.exec(head) || [])[1]) || 2.75;
  if (!high) return { text: decodeBytes(bytes, 'utf-8'), encoding: ver >= 2.7 ? 'utf-8' : fallbackEncoding, guessed: false };
  if (isValidUtf8(bytes)) return { text: decodeBytes(bytes, 'utf-8'), encoding: 'utf-8', guessed: ver < 2.7 };
  // split into lines; collect the ones that are not UTF-8
  const lines = []; let s = 0;
  for (let i = 0; i <= bytes.length; i++) if (i === bytes.length || bytes[i] === 0x0a) { lines.push(bytes.subarray(s, i + 1)); s = i + 1; }
  const ansi = lines.filter(l => !isValidUtf8(l));
  const latin = decodeBytes(bytes, 'windows-1252');
  const acp = parseInt((/^\|Locale\|ACP:(\d+)/m.exec(latin) || [])[1], 10) || codePage || 0;
  const charSets = [...latin.matchAll(/^\|Font\|[^\r\n]*\|CharSet:(\d+)/gm)].map(m => +m[1]);
  const det = detectEncoding(ver >= 2.7 ? ansi : lines.filter(l => l.some(c => c > 127)), { codePage: acp, charSets, fallbackEncoding });
  if (ver >= 2.7) {
    const text = lines.map(l => (isValidUtf8(l) ? decodeBytes(l, 'utf-8') : decodeBytes(l, det.encoding === 'utf-8' ? fallbackEncoding : det.encoding))).join('');
    return { text, encoding: 'utf-8', guessed: false };
  }
  return { text: decodeBytes(bytes, det.encoding), encoding: det.encoding, guessed: det.guessed };
}

/**
 * Reads the container and returns the NWC document plus what was found out about the text encoding.
 * (Exported for tools/nwc; applications use importNwc.)
 */
export async function readNwcDocument(data, { encoding = 'auto', fallbackEncoding = 'windows-1252' } = {}) {
  let bytes = toBytes(data);
  const enc = normalizeEncoding(encoding) || 'auto';
  const fallback = normalizeEncoding(fallbackEncoding) || 'windows-1252';
  let container = 'nwc';
  if (startsWith(bytes, NWZ)) {
    container = 'nwz';
    let p = NWZ.length;
    while (p < bytes.length && p < 16 && bytes[p] !== 0x78) p++;                // "[NWZ]\0", then the zlib header byte
    try { bytes = await inflateZlib(bytes.subarray(p)); } catch (e) { throw new Error('NWC 파일의 압축을 풀 수 없습니다 (파일이 손상되었을 수 있습니다)'); }
  }
  if (startsWith(bytes, NWC_MAGIC)) {
    const version = bytes[46] * 100 + bytes[45];
    const t = indexOfAscii(bytes, TXT + '(', 40, 4096);
    if (version >= 270 || (t > 0 && version >= 205)) {
      if (t < 0) throw new Error('NWC 2.75 파일에서 악보 데이터를 찾을 수 없습니다');
      let end = indexOfAscii(bytes, TXT + '-End', t);
      end = end < 0 ? bytes.length : end + (TXT + '-End').length;
      // header: … user\0 id\0 date(2) codepage(2) 0(4) 0x24(2) text
      const codePage = t >= 10 ? bytes[t - 8] | (bytes[t - 7] << 8) : 0;
      const d = decodeNwctxt(bytes.subarray(t, end), { encoding: enc, fallbackEncoding: fallback, codePage });
      const doc = parseNwctxt(d.text);
      doc.container = container; doc.codePage = doc.codePage || codePage;
      return { doc, encoding: d.encoding, encodingGuessed: d.guessed };
    }
    // binary object stream: read once to collect the text bytes, detect, read again
    let doc = parseNwcBinary(bytes, enc === 'auto' ? 'windows-1252' : enc);
    let used = enc, guessed = false;
    if (enc === 'auto') {
      const det = detectEncoding(doc.chunks, { codePage: doc.codePage, charSets: doc.fonts.map(f => f.charSet), fallbackEncoding: fallback });
      used = det.encoding; guessed = det.guessed;
      if (used !== 'windows-1252') doc = parseNwcBinary(bytes, used);
    }
    doc.container = container;
    delete doc.chunks;
    return { doc, encoding: used, encodingGuessed: guessed };
  }
  const t = textStart(bytes);
  if (t >= 0) {
    let end = indexOfAscii(bytes, TXT + '-End', t);
    end = end < 0 ? indexOfAscii(bytes, TXT + 'Clip-End', t) : end;
    const d = decodeNwctxt(bytes.subarray(t), { encoding: enc, fallbackEncoding: fallback, codePage: 0 });
    const doc = parseNwctxt(d.text);
    doc.container = 'nwctxt';
    return { doc, encoding: d.encoding, encodingGuessed: d.guessed };
  }
  throw new Error('NoteWorthy Composer 파일(.nwc, .nwctxt)이 아닙니다');
}

/**
 * .nwc / .nwctxt → ScoreDoc.
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{encoding?:string, fallbackEncoding?:string, fileName?:string}} [opts]
 *   encoding          'auto' (default) or an id of NWC_ENCODINGS — honoured exactly when given
 *   fallbackEncoding  used in 'auto' mode when neither the file nor its bytes decide (default 'windows-1252')
 *   fileName          becomes the title when the file has none
 * score.importInfo = { from:'nwc', version:'1.75', container, encoding, encodingGuessed, warnings:[…] }
 */
export async function importNwc(data, { encoding = 'auto', fallbackEncoding = 'windows-1252', fileName } = {}) {
  const { doc, encoding: used, encodingGuessed } = await readNwcDocument(data, { encoding, fallbackEncoding });
  const warnings = new Set();
  const score = nwcToScore(doc, warnings);
  if (!score.meta.title && fileName) score.meta.title = String(fileName).replace(/^.*[\\/]/, '').replace(/\.(nwc|nwctxt|txt)$/i, '');
  const version = doc.container === 'nwctxt' && doc.version ? doc.version : (doc.version || '').replace(/^(\d+\.\d\d)\d+$/, '$1');
  score.importInfo = { from: 'nwc', version, container: doc.container, encoding: used, encodingGuessed: !!encodingGuessed, warnings: [...warnings] };
  return score;
}

/**
 * ScoreDoc → nwctxt text for NoteWorthy Composer 2.75 (UTF-8 when written to a file).
 * @param {object} [opts]
 *   warnings  string[] that receives Korean notes about what could not be written as it is
 *   chords    'text' (default): chord symbols as text objects; 'plugin': objects of NWC 2.75's ChordPlay.nw
 */
export function exportNwctxt(score, opts = {}) {
  return scoreToNwctxt(score, opts);
}

/**
 * ScoreDoc → .nwc file bytes.
 * @param {object} [opts]
 *   version   '2.75' (default): the container NWC 2.75 writes — binary header + nwctxt (UTF-8)
 *             '1.75': the old binary object stream, text in opts.encoding. Experimental: other NWC
 *                     readers read it, NoteWorthy Composer itself was not available to try it
 *   compress  true (default): "[NWZ]" + zlib, as NWC saves; false: plain
 *   encoding  code page for version '1.75' text: 'euc-kr' (CP949; default when the score has Hangul)
 *             or 'windows-1252'
 *   warnings  string[] that receives Korean notes
 *   chords    as for exportNwctxt (2.75 only)
 */
export async function exportNwc(score, opts = {}) {
  return scoreToNwcFile(score, opts);
}

export { encodingFromCodePage, encodingFromCharSet };
