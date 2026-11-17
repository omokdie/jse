// JSE — text encodings of NoteWorthy Composer files.
//
// NWC 2.75 writes its notation text as UTF-8. Everything older (binary 1.x / 2.0 / 2.5 files and
// the "nwctxt" exports of NWC 2.0 / 2.5) holds text in the Windows ANSI code page of the machine
// it was written on: CP949 for Korean hymn and choir files, CP1252 for Western ones, …
// Nothing in a 1.x file names that code page, so it has to be detected:
//   1. hints stored in the file — the code page number NWC 2.x puts in the header or in a
//      "|Locale|ACP:949" line, and the Windows CharSet of the font table (129 = Hangul …);
//   2. the bytes themselves — valid UTF-8 multi-byte sequences, CP949 lead/trail validity and how
//      many pairs are everyday Hangul, the same for Shift-JIS / GBK / Big5, isolated high bytes
//      for Western text;
//   3. the caller's `fallbackEncoding` when the bytes do not decide (default windows-1252).
// Pure JS (TextDecoder only): runs in browsers, workers and Node.

/** Encodings offered by the "open with another encoding" UI. `id` is a TextDecoder label. */
export const NWC_ENCODINGS = [
  { id: 'auto', label: '자동' },
  { id: 'euc-kr', label: '한국어 (CP949)' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'windows-1252', label: '서유럽' },
  { id: 'shift_jis', label: '일본어' },
  { id: 'gbk', label: '중국어 간체 (GBK)' },
  { id: 'big5', label: '중국어 번체 (Big5)' },
  { id: 'windows-1251', label: '키릴 문자' },
  { id: 'windows-1250', label: '중앙 유럽' },
  { id: 'windows-1253', label: '그리스어' },
  { id: 'windows-1254', label: '터키어' },
  { id: 'windows-1257', label: '발트어' },
  { id: 'windows-1258', label: '베트남어' },
  { id: 'windows-874', label: '태국어' },
  { id: 'windows-1255', label: '히브리어' },
  { id: 'windows-1256', label: '아랍어' },
];
const KNOWN = new Set(NWC_ENCODINGS.map(e => e.id));

// Windows code page number → encoding id
const CODE_PAGES = { 949: 'euc-kr', 1361: 'euc-kr', 932: 'shift_jis', 936: 'gbk', 950: 'big5', 65001: 'utf-8',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874' };
const CODE_PAGE_OF = { 'euc-kr': 949, shift_jis: 932, gbk: 936, big5: 950, 'utf-8': 65001, 'windows-1250': 1250, 'windows-1251': 1251,
  'windows-1252': 1252, 'windows-1253': 1253, 'windows-1254': 1254, 'windows-1255': 1255, 'windows-1256': 1256,
  'windows-1257': 1257, 'windows-1258': 1258, 'windows-874': 874 };
// LOGFONT.lfCharSet → encoding id. 0 (ANSI) and 1 (DEFAULT) say nothing: Korean users type Hangul
// into "Times New Roman, CharSet 0" all the time, Windows font linking displays it anyway.
const CHARSETS = { 129: 'euc-kr', 130: 'euc-kr', 128: 'shift_jis', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254',
  163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874',
  238: 'windows-1250' };
const CHARSET_OF = { 'euc-kr': 129, shift_jis: 128, gbk: 134, big5: 136, 'windows-1253': 161, 'windows-1254': 162, 'windows-1258': 163,
  'windows-1255': 177, 'windows-1256': 178, 'windows-1257': 186, 'windows-1251': 204, 'windows-874': 222, 'windows-1250': 238 };

export const encodingFromCodePage = (cp) => CODE_PAGES[cp] || null;
export const codePageOfEncoding = (id) => CODE_PAGE_OF[id] || 1252;
export const encodingFromCharSet = (cs) => CHARSETS[cs] || null;
export const charSetOfEncoding = (id) => CHARSET_OF[id] || 0;

/** Canonical id for a user supplied encoding name ('cp949', 'EUC-KR', 'sjis', 'latin1' …) or null. */
export function normalizeEncoding(name) {
  const n = String(name || '').trim().toLowerCase().replace(/_/g, '-');
  if (!n) return null;
  if (n === 'auto') return 'auto';
  const alias = { cp949: 'euc-kr', 'windows-949': 'euc-kr', uhc: 'euc-kr', 'ks-c-5601-1987': 'euc-kr', korean: 'euc-kr', utf8: 'utf-8',
    'shift-jis': 'shift_jis', sjis: 'shift_jis', cp932: 'shift_jis', 'windows-31j': 'shift_jis', cp936: 'gbk', gb2312: 'gbk', gb18030: 'gbk',
    cp950: 'big5', latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', cp1252: 'windows-1252', ansi: 'windows-1252', ascii: 'windows-1252',
    cp1251: 'windows-1251', cp1250: 'windows-1250' };
  const id = alias[n] || n;
  if (KNOWN.has(id)) return id;
  try { new TextDecoder(id); return id; } catch (_) { return null; }
}

const decoders = new Map();
function decoder(id, fatal = false) {
  const key = id + (fatal ? '!' : '');
  let d = decoders.get(key);
  if (!d) { d = new TextDecoder(id, { fatal }); decoders.set(key, d); }
  return d;
}
/** Bytes → string. Never throws: undecodable bytes become U+FFFD. */
export function decodeBytes(bytes, encoding) {
  if (!bytes || !bytes.length) return '';
  let high = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) { high = true; break; }
  if (!high) { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; }
  if (encoding === 'euc-kr' && !platformHasUhc()) return decodeCp949(bytes);
  try { return decoder(encoding).decode(bytes); } catch (_) { return decoder('windows-1252').decode(bytes); }
}

// ---------------------------------------------------------------------------------------------
// CP949
// ---------------------------------------------------------------------------------------------
// CP949 (Windows Korean) = KS X 1001, which every "euc-kr" decoder knows, + the 8,822 Hangul
// syllables KS X 1001 leaves out. Microsoft laid those out in Unicode order over the lead and
// trail bytes KS X 1001 does not use (0x8141 갂 … 0xC652 힣). The decoders of browsers include
// that extension (the Encoding Standard says so), Node's does not — so the table is rebuilt here
// from the platform's KS X 1001 table and that rule; it serves reading where the platform falls
// short, and writing everywhere.
let uhcOk = null;
function platformHasUhc() {
  if (uhcOk == null) { try { uhcOk = decoder('euc-kr').decode(Uint8Array.of(0x81, 0x41, 0xc6, 0x52)) === '\uac02\ud7a3'; } catch (_) { uhcOk = false; } }
  return uhcOk;
}
let cp949 = null;
function cp949Tables() {
  if (cp949) return cp949;
  const toChar = new Map(), toCode = new Map();
  const d = decoder('euc-kr');
  const buf = new Uint8Array(2);
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      buf[0] = lead; buf[1] = trail;
      const ch = d.decode(buf);
      if (ch.length !== 1) continue;                     // not a character of the table
      const c = ch.charCodeAt(0);
      if (c === 0xfffd || c < 0x80) continue;
      const code = (lead << 8) | trail;
      toChar.set(code, ch);
      if (!toCode.has(c)) toCode.set(c, code);
    }
  }
  const codes = [];
  const trails = (last) => { const t = []; for (let x = 0x41; x <= 0x5a; x++) t.push(x); for (let x = 0x61; x <= 0x7a; x++) t.push(x); for (let x = 0x81; x <= last; x++) t.push(x); return t; };
  for (let lead = 0x81; lead <= 0xa0; lead++) for (const t of trails(0xfe)) codes.push((lead << 8) | t);
  for (let lead = 0xa1; lead <= 0xc6; lead++) for (const t of trails(0xa0)) codes.push((lead << 8) | t);
  let k = 0;
  for (let c = 0xac00; c <= 0xd7a3 && k < codes.length; c++) {
    if (toCode.has(c)) continue;                         // one of the 2,350 syllables of KS X 1001
    toChar.set(codes[k], String.fromCharCode(c)); toCode.set(c, codes[k]); k++;
  }
  cp949 = { toChar, toCode };
  return cp949;
}
function decodeCp949(bytes) {
  const { toChar } = cp949Tables();
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); continue; }
    const ch = i + 1 < bytes.length ? toChar.get((b << 8) | bytes[i + 1]) : undefined;
    if (ch) { out += ch; i++; } else out += '\ufffd';
  }
  return out;
}
export function isValidUtf8(bytes) {
  try { decoder('utf-8', true).decode(bytes); return true; } catch (_) { return false; }
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------
/** How well a run of bytes reads as CP949 (Windows Korean, a superset of EUC-KR). */
function scoreCp949(chunks) {
  let pairs = 0, hangul = 0, rare = 0, bad = 0;
  for (const b of chunks) {
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c < 0x80) continue;
      const t = i + 1 < b.length ? b[i + 1] : 0;
      const letter = (t >= 0x41 && t <= 0x5a) || (t >= 0x61 && t <= 0x7a);
      let ok = false;
      if (c >= 0x81 && c <= 0xa0) ok = letter || (t >= 0x81 && t <= 0xfe);
      else if (c >= 0xa1 && c <= 0xc6) ok = letter || (t >= 0x81 && t <= 0xfe);
      else if (c >= 0xc7 && c <= 0xfe) ok = t >= 0xa1 && t <= 0xfe;
      if (!ok) { bad++; continue; }
      pairs++; i++;
      // KS X 1001 rows 0xB0–0xC8 hold the 2,350 syllables of everyday Korean; the UHC extension
      // (letter trails, lead < 0xB0 …) only has syllables that almost never occur in real text,
      // which is exactly what Western "Ärger" / "Às" bytes turn into.
      if (c >= 0xb0 && c <= 0xc8 && t >= 0xa1) hangul++;
      else if (letter || t < 0xa1 || c < 0xa1) rare++;
    }
  }
  return { pairs, hangul, rare, bad };
}
/** Generic check with the platform decoder: replacement characters and script counts. */
function scoreDecoded(chunks, encoding) {
  const d = decoder(encoding);
  let bad = 0, kana = 0, han = 0, hangul = 0, cyr = 0, other = 0;
  for (const b of chunks) {
    let s; try { s = d.decode(b); } catch (_) { bad += 1; continue; }
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) continue;
      if (c === 0xfffd) bad++;
      else if (c >= 0x3040 && c <= 0x30ff) kana++;
      else if (c >= 0xff61 && c <= 0xff9f) other += 2;     // half-width katakana: what Western bytes look like in Shift-JIS
      else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) han++;
      else if (c >= 0xac00 && c <= 0xd7a3) hangul++;
      else if (c >= 0x400 && c <= 0x4ff) cyr++;
      else if (c >= 0xe000 && c <= 0xf8ff) bad++;          // private use = unassigned code point
      else other++;
    }
  }
  return { bad, kana, han, hangul, cyr, other };
}
/** High bytes standing alone between ASCII characters: the signature of Western accented text. */
function scoreWestern(chunks) {
  let high = 0, isolated = 0, upperRun = 0;
  for (const b of chunks) {
    for (let i = 0; i < b.length; i++) {
      if (b[i] < 0x80) continue;
      high++;
      const prevHigh = i > 0 && b[i - 1] >= 0x80, nextHigh = i + 1 < b.length && b[i + 1] >= 0x80;
      if (!prevHigh && !nextHigh) isolated++;
      if (b[i] >= 0xc0 && (prevHigh || nextHigh)) upperRun++;
    }
  }
  return { high, isolated, upperRun };
}

/**
 * Chooses the ANSI code page of old NWC text.
 * @param {Uint8Array[]} chunks  every text string of the file (raw bytes)
 * @param {{codePage?:number, charSets?:number[], fallbackEncoding?:string}} hints
 * @returns {{encoding:string, guessed:boolean, reason:string}}
 */
export function detectEncoding(chunks, hints = {}) {
  const fallback = normalizeEncoding(hints.fallbackEncoding) || 'windows-1252';
  let high = 0, total = 0;
  for (const b of chunks) { total += b.length; for (let i = 0; i < b.length; i++) if (b[i] > 127) high++; }
  const fromCp = encodingFromCodePage(hints.codePage);
  let fromCs = null;
  for (const cs of hints.charSets || []) { const e = encodingFromCharSet(cs); if (e) { fromCs = e; break; } }
  if (!high) return { encoding: fromCs || (fromCp && fromCp !== 'windows-1252' ? fromCp : fallback), guessed: false, reason: 'ascii' };

  // UTF-8 with real multi-byte sequences is practically never an accident.
  let utf8 = true;
  for (const b of chunks) if (!isValidUtf8(b)) { utf8 = false; break; }
  if (utf8) return { encoding: 'utf-8', guessed: fromCp !== 'utf-8', reason: 'utf-8 sequences' };   // NWC 2.75 writing a 2.5 file stores code page 65001

  // 1. hints stored in the file
  if (fromCs) return { encoding: fromCs, guessed: false, reason: 'font charset' };
  if (fromCp && fromCp !== 'windows-1252') return { encoding: fromCp, guessed: false, reason: 'code page' };

  // 2. the bytes
  const ko = scoreCp949(chunks), west = scoreWestern(chunks);
  const koValid = ko.bad === 0 && ko.pairs > 0;
  // Everyday Hangul must be there and outnumber the rare extension syllables; KS symbols (↓ ♪ ※ ~),
  // which Korean lyrics are full of, and Hanja count neither for nor against.
  const koStrong = ko.hangul >= 2 && ko.bad <= Math.max(1, ko.pairs * 0.03) && ko.hangul >= ko.rare;
  const candidates = [];
  if (koStrong) candidates.push({ encoding: 'euc-kr', score: ko.hangul * 2 - ko.rare * 3 - ko.bad * 6 });
  const tryCjk = (encoding, good) => {
    const s = scoreDecoded(chunks, encoding);
    const n = s.kana + s.han + s.hangul + s.other;
    if (!n || s.bad > Math.max(0, n * 0.02)) return null;
    const g = good(s);
    if (g < 2 || g < n * 0.5) return null;
    return { encoding, score: g * 2 - s.other * 2 - s.bad * 6, s };
  };
  const ja = tryCjk('shift_jis', s => (s.kana ? s.kana * 2 + s.han : 0));
  const zh = tryCjk('gbk', s => s.han);
  const tw = tryCjk('big5', s => s.han);
  if (ja) candidates.push(ja);
  // Hangul rows B0–C8 of KS X 1001 are common hanzi in GB2312 and Big5 too, so Chinese is only
  // believable when the text leaves the Hangul rows or the Korean reading is poor.
  if (zh && !koStrong) candidates.push(zh);
  if (tw && !koStrong && !zh) candidates.push(tw);
  const westStrong = west.isolated >= west.high * 0.8 && !(koValid && ko.hangul >= 2);
  if (westStrong) candidates.push({ encoding: 'windows-1252', score: west.isolated * 2 });
  const cy = scoreDecoded(chunks, 'windows-1251');
  if (!koStrong && !westStrong && cy.cyr >= 4 && cy.cyr >= (cy.other + cy.cyr) * 0.85 && west.isolated < west.high * 0.3) candidates.push({ encoding: 'windows-1251', score: cy.cyr });
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 1 || (candidates.length > 1 && candidates[0].score >= candidates[1].score * 1.5 + 2)) {
    return { encoding: candidates[0].encoding, guessed: true, reason: 'byte pattern' };
  }
  // 3. inconclusive: the caller's preference when it reads the bytes without errors
  if (fallback === 'euc-kr' ? koValid || ko.bad <= ko.pairs * 0.03 && ko.pairs > 0 : fallback === 'windows-1252' || scoreDecoded(chunks, fallback).bad === 0) {
    return { encoding: fallback, guessed: true, reason: 'fallback' };
  }
  if (candidates.length) return { encoding: candidates[0].encoding, guessed: true, reason: 'byte pattern' };
  if (fromCp) return { encoding: fromCp, guessed: true, reason: 'code page' };
  return { encoding: 'windows-1252', guessed: true, reason: 'default' };
}

// ---------------------------------------------------------------------------------------------
// Encoding (for writing old binary files)
// ---------------------------------------------------------------------------------------------
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
// Characters with no code in the target code page become the closest ASCII, or '?'.
const ASCII_FALLBACK = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '♯': '#', '♭': 'b', '♮': '', ' ': ' ' };

/**
 * String → bytes in an ANSI code page ('euc-kr' = CP949, 'windows-1252'; anything else is written as UTF-8).
 * @returns {{bytes:Uint8Array, lost:number}}  lost = characters that had no code and were replaced
 */
export function encodeText(text, encoding = 'euc-kr') {
  const s = String(text == null ? '' : text);
  if (encoding !== 'euc-kr' && encoding !== 'windows-1252') return { bytes: new TextEncoder().encode(s), lost: 0 };
  const out = []; let lost = 0;
  const map = encoding === 'euc-kr' ? cp949Tables().toCode : null;
  const put = (ch) => {
    const c = ch.codePointAt(0);
    if (c < 0x80) { out.push(c); return true; }
    if (map) { const v = map.get(c); if (v != null) { out.push(v >> 8, v & 0xff); return true; } return false; }
    if (c >= 0xa0 && c <= 0xff) { out.push(c); return true; }
    const i = CP1252_HIGH.indexOf(ch);
    if (i >= 0 && c > 0x9f) { out.push(0x80 + i); return true; }
    return false;
  };
  for (const ch of s) {
    if (put(ch)) continue;
    const alt = ASCII_FALLBACK[ch];
    if (alt != null) { for (const a of alt) put(a); continue; }
    // decomposed fallback: é → e
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base && base !== ch && [...base].every(b => b.codePointAt(0) < 0x80)) { for (const a of base) put(a); continue; }
    out.push(0x3f); lost++;
  }
  return { bytes: Uint8Array.from(out), lost };
}
