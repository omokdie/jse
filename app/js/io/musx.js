// JSE — Finale (.musx / .ftmx) importer.
//
// A Finale 2014+ notation file is a ZIP archive. Its `score.dat` entry holds the
// document as "EnigmaXML" (namespace http://www.makemusic.com/2012/finale),
// gzip-compressed and scrambled with a simple LCG XOR stream. This module
// unscrambles + inflates it and converts the EnigmaXML into a ScoreDoc (SPEC §2).
//
// Coverage: staves/parts (names, clefs, multi-staff instruments, percussion/TAB
// staves, transposition), measures (time & key signatures incl. pickups and
// composite meters, barlines, repeats, endings, D.S./D.C./Coda/Fine, system
// breaks, page size & staff size), notes (layers 1–4, chords, rests, dots,
// tuplets, grace notes, ties, forced accidentals, stems, beams), lyrics (verses
// and choruses, hyphenation, word extensions), chord symbols, expressions
// (dynamics, tempo marks, tempo alterations, rehearsal marks, text),
// articulations/ornaments/fermatas and smart shapes (slurs, hairpins, ottavas,
// trills, glissandi, pedal-ish lines). Unsupported details are skipped and
// summarised in `score.importInfo.warnings`.
//
// Pure JS: runs in the browser, in workers and in Node (tests).

import { parseXML, normalizeImported } from './musicxml.js';
import {
  createPart, createMeasure, newId, STEPS, keyAlter, DUR_TICKS, durTicks, voiceTicks,
  ticksToDurations, makeRest, validateScore, midiOf, INSTRUMENTS, DEFAULT_DRUM_MAP, staffPosition,
} from '../model/score.js';

export const MUSX_EXTENSIONS = ['.musx', '.ftmx', '.ftm'];
const EDU_PER_QUARTER = 1024;
const toTicks = (edu) => Math.round(edu * 960 / EDU_PER_QUARTER);

// ---------------------------------------------------------------------------
// 1. Container: unscramble + inflate
// ---------------------------------------------------------------------------
/** XOR stream used by Finale for score.dat (symmetric: encrypts and decrypts). */
export function musxCrypt(bytes) {
  const out = new Uint8Array(bytes.length);
  const INIT = 0x28006D45, RESET = 0x20000;
  let state = INIT;
  for (let i = 0; i < bytes.length; i++) {
    if (i % RESET === 0) state = INIT;
    state = (Math.imul(state, 0x41c64e6d) + 0x3039) >>> 0;
    const upper = state >>> 16;
    out[i] = bytes[i] ^ ((upper + Math.floor(upper / 255)) & 0xff);
  }
  return out;
}

async function gunzip(u8, Z) {
  if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { /* fall back below */ }
  }
  if (!Z) throw new Error('압축 해제를 지원하지 않는 환경입니다');
  // Fallback: wrap the raw DEFLATE payload in a one-entry ZIP and let JSZip inflate it.
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) throw new Error('score.dat 형식이 올바르지 않습니다');
  const flg = u8[3]; let p = 10;
  if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
  if (flg & 8) { while (u8[p]) p++; p++; }
  if (flg & 16) { while (u8[p]) p++; p++; }
  if (flg & 2) p += 2;
  const data = u8.subarray(p, u8.length - 8);
  const tail = u8.subarray(u8.length - 8);
  const crc = tail.subarray(0, 4), size = tail.subarray(4, 8);
  const name = [0x78]; // "x"
  const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const cs = le32(data.length);
  const local = [0x50, 0x4b, 3, 4, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, ...crc, ...cs, ...size, 1, 0, 0, 0, ...name];
  const central = [0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, ...crc, ...cs, ...size, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...name];
  const cdOff = local.length + data.length;
  const end = [0x50, 0x4b, 5, 6, 0, 0, 0, 0, 1, 0, 1, 0, ...le32(central.length), ...le32(cdOff), 0, 0];
  const zipBytes = new Uint8Array(cdOff + central.length + end.length);
  zipBytes.set(local, 0); zipBytes.set(data, local.length); zipBytes.set(central, cdOff); zipBytes.set(end, cdOff + central.length);
  const zip = await Z.loadAsync(zipBytes);
  return zip.file('x').async('uint8array');
}

/** True when the bytes look like a Finale 2014+ notation file (ZIP with score.dat). */
export function looksLikeMusx(bytes) {
  const head = new Uint8Array(bytes.slice ? bytes.slice(0, 4096) : bytes);
  if (head[0] !== 0x50 || head[1] !== 0x4b) return false;
  const text = new TextDecoder('latin1').decode(head);
  return text.includes('score.dat') || text.includes('NotationMetadata') || text.includes('makemusic');
}

/** Reads a .musx/.ftmx file and returns the decoded EnigmaXML text. */
export async function readEnigmaXml(data, { JSZip: Z = globalThis.JSZip } = {}) {
  if (!Z) throw new Error('JSZip가 필요합니다');
  let zip;
  try { zip = await Z.loadAsync(data); } catch (e) {
    const u8 = new Uint8Array(data.buffer ? data.buffer : data);
    if (u8[0] === 0x45 && u8[1] === 0x4e && u8[2] === 0x49 && u8[3] === 0x47) throw new Error('Finale 2012 이전 형식(.mus)은 열 수 없습니다. Finale에서 MusicXML로 내보낸 뒤 열어 주세요.');
    throw new Error('Finale 파일을 읽을 수 없습니다 (ZIP 형식이 아님)');
  }
  const dat = zip.file('score.dat');
  if (!dat) throw new Error('Finale 파일 안에 악보 데이터(score.dat)가 없습니다');
  const xml = await gunzip(musxCrypt(await dat.async('uint8array')), Z);
  let meta = null;
  const mf = zip.file('NotationMetadata.xml');
  if (mf) { try { meta = parseXML(await mf.async('string')); } catch (_) { meta = null; } }
  return { xml: new TextDecoder('utf-8').decode(xml), meta };
}

/** Public entry: .musx/.ftmx bytes → ScoreDoc. */
export async function importMusx(data, opts = {}) {
  const { xml, meta } = await readEnigmaXml(data, opts);
  return enigmaToScore(xml, { meta });
}

// ---------------------------------------------------------------------------
// 2. EnigmaXML access helpers
// ---------------------------------------------------------------------------
const kids = (n, tag) => (n ? n.children.filter(c => c.tag === tag) : []);
const kid = (n, tag) => (n ? n.children.find(c => c.tag === tag) : undefined);
const has = (n, tag) => !!kid(n, tag);
const txt = (n, tag) => { const c = tag == null ? n : kid(n, tag); return c ? c.text.trim() : undefined; };
const int = (n, tag, def = 0) => { const t = txt(n, tag); if (t == null || t === '') return def; const v = parseInt(t, 10); return Number.isFinite(v) ? v : def; };
const isScoreLevel = (n) => n.attrs.part == null || n.attrs.part === '0';

class Doc {
  constructor(root) {
    const fin = root.children.find(c => c.tag === 'finale') || root;
    const sec = (t) => fin.children.find(c => c.tag === t);
    this.options = sec('options');
    this.others = new Map(); this.details = new Map();
    for (const [name, map] of [['others', this.others], ['details', this.details]]) {
      const s = sec(name); if (!s) continue;
      for (const el of s.children) { if (!isScoreLevel(el)) continue; let a = map.get(el.tag); if (!a) map.set(el.tag, a = []); a.push(el); }
    }
    this.entries = new Map();
    const es = sec('entries');
    if (es) for (const e of es.children) if (e.tag === 'entry') this.entries.set(+e.attrs.entnum, e);
    this.texts = new Map();
    const ts = sec('texts');
    if (ts) for (const t of ts.children) this.texts.set(`${t.tag}:${t.attrs.number ?? t.attrs.type ?? ''}`, t.text || '');
  }
  other(tag) { return this.others.get(tag) || []; }
  detail(tag) { return this.details.get(tag) || []; }
  /** Map keyed by attribute (cmper by default) → element (first) */
  index(tag, key = 'cmper', fromDetails = false) {
    const m = new Map();
    for (const el of (fromDetails ? this.detail(tag) : this.other(tag))) { const k = el.attrs[key]; if (!m.has(k)) m.set(k, el); }
    return m;
  }
  /** Map keyed by attribute → array of elements (sorted by inci) */
  group(tag, key = 'cmper', fromDetails = false) {
    const m = new Map();
    for (const el of (fromDetails ? this.detail(tag) : this.other(tag))) { const k = el.attrs[key]; let a = m.get(k); if (!a) m.set(k, a = []); a.push(el); }
    for (const a of m.values()) a.sort((x, y) => (+x.attrs.inci || 0) - (+y.attrs.inci || 0));
    return m;
  }
  text(kind, number) { return this.texts.get(`${kind}:${number}`); }
}

// ---------------------------------------------------------------------------
// 3. Enigma text strings ("^fontid(9)^size(12)^nfx(0)Allegro")
// ---------------------------------------------------------------------------
const INSERTS = { sharp: '♯', flat: '♭', natural: '♮', dbsharp: '𝄪', dbflat: '𝄫' };
/** Splits an Enigma text into runs {text, music} (music = rendered with a music font). */
function enigmaRuns(raw, ctx, vars = {}) {
  const runs = []; let cur = { text: '', music: false };
  const push = () => { if (cur.text) runs.push(cur); cur = { text: '', music: cur.music }; };
  const s = raw || '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '^') { cur.text += ch; continue; }
    if (s[i + 1] === '^') { cur.text += '^'; i++; continue; }
    const m = /^([A-Za-z]+)(\(([^)]*)\))?/.exec(s.slice(i + 1));
    if (!m) { cur.text += ch; continue; }
    i += m[0].length;
    const tag = m[1], arg = m[3] || '';
    if (tag === 'fontMus') { push(); cur.music = true; }
    else if (tag === 'fontTxt' || tag === 'fontNum') { push(); cur.music = false; }
    else if (tag === 'font') { push(); cur.music = ctx.isMusicFontName(arg.split(',')[0]); }
    else if (tag === 'fontid') { push(); cur.music = ctx.isMusicFontId(parseInt(arg, 10)); }
    else if (INSERTS[tag]) { push(); runs.push({ text: INSERTS[tag], music: false }); }
    else if (tag in vars) { push(); runs.push({ text: String(vars[tag] ?? ''), music: false }); }
    // every other tag (size, nfx, baseline, tab, page, …) carries no text
  }
  push();
  return runs;
}

// SMuFL code points → plain-text meaning
const SMUFL_DYN = { 0xE520: 'p', 0xE521: 'm', 0xE522: 'f', 0xE523: 'r', 0xE524: 's', 0xE525: 'z', 0xE526: 'n',
  0xE527: 'pppppp', 0xE528: 'ppppp', 0xE529: 'pppp', 0xE52A: 'ppp', 0xE52B: 'pp', 0xE52C: 'mp', 0xE52D: 'mf', 0xE52E: 'pf',
  0xE52F: 'ff', 0xE530: 'fff', 0xE531: 'ffff', 0xE532: 'fffff', 0xE533: 'ffffff', 0xE534: 'fp', 0xE535: 'fz', 0xE536: 'sf',
  0xE537: 'sfp', 0xE538: 'sfpp', 0xE539: 'sfz', 0xE53A: 'sfzp', 0xE53B: 'sffz', 0xE53C: 'rf', 0xE53D: 'rfz' };
// Legacy Maestro-compatible (Maestro, Petrucci, Engraver, Jazz…) code points → SMuFL
const LEGACY_TO_SMUFL = { 33: 0xE220, 37: 0xE047, 38: 0xE050, 39: 0xE4A7, 42: 0xE655, 44: 0xE4CE, 45: 0xE4A4, 46: 0xE4A2,
  60: 0xE4B3, 62: 0xE4A0, 63: 0xE062, 64: 0xE221, 66: 0xE05C, 70: 0xE52D, 71: 0xE4B6, 77: 0xE56D, 80: 0xE52C, 83: 0xE536,
  84: 0xE567, 85: 0xE4C0, 86: 0xE052, 90: 0xE535, 94: 0xE4AC, 102: 0xE522, 109: 0xE56C, 112: 0xE520, 115: 0xE524,
  116: 0xE064, 117: 0xE4C1, 118: 0xE4AD, 122: 0xE525, 130: 0xE537, 137: 0xE4B5, 138: 0xE4B4, 139: 0xE069, 141: 0xE53B,
  142: 0xE523, 150: 0xE526, 159: 0xE04A, 160: 0xE053, 161: 0xE650, 167: 0xE539, 171: 0xE4A8, 172: 0xE4AE, 174: 0xE4A6,
  175: 0xE529, 178: 0xE612, 179: 0xE610, 181: 0xE56E, 182: 0xE538, 184: 0xE52A, 185: 0xE52B, 189: 0xE521, 190: 0xE222,
  196: 0xE52F, 214: 0xE06A, 216: 0xE4A9, 217: 0xE566, 222: 0xE048, 223: 0xE4B1, 230: 0xE065, 232: 0xE4AF, 234: 0xE534,
  235: 0xE531, 236: 0xE530, 246: 0xE5E5, 247: 0xE614, 248: 0xE4B2, 249: 0xE4B0,
  // text-font metronome glyphs in Maestro: q h e w (note values), k = augmentation dot
  113: 0xE1D5, 104: 0xE1D3, 101: 0xE1D7, 119: 0xE1D2, 107: 0xE1E7 };
const toSmufl = (cp) => (cp >= 0xE000 && cp <= 0xF8FF ? cp : LEGACY_TO_SMUFL[cp] || 0);
const METRONOME = { 0xE1D2: 'whole', 0xE1D3: 'half', 0xE1D4: 'half', 0xE1D5: 'quarter', 0xE1D6: 'quarter', 0xE1D7: 'eighth', 0xE1D8: 'eighth', 0xE1D9: '16th', 0xE1DA: '16th' };

/** Plain readable text for runs (music glyphs → letters/symbols where possible). */
function runsToPlain(runs) {
  let out = '';
  for (const r of runs) {
    if (!r.music) { out += r.text; continue; }
    for (const ch of r.text) {
      const s = toSmufl(ch.codePointAt(0));
      if (SMUFL_DYN[s]) out += SMUFL_DYN[s];
      else if (METRONOME[s]) out += { whole: '𝅝', half: '𝅗𝅥', quarter: '♩', eighth: '♪', '16th': '𝅘𝅥𝅯' }[METRONOME[s]];
      else if (s === 0xE1E7) out += '.';
      else if (s === 0xE047) out += '𝄋';
      else if (s === 0xE048) out += '𝄌';
      else if (s === 0xE262) out += '♯'; else if (s === 0xE260) out += '♭'; else if (s === 0xE261) out += '♮';
      else if (/[\s=().,0-9a-zA-Z]/.test(ch) && ch.codePointAt(0) < 128) out += ch;
    }
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** Dynamic marking spelled by music-font glyphs, or null. */
function dynamicFromRuns(runs) {
  let letters = '', other = '';
  for (const r of runs) {
    for (const ch of r.text) {
      const cp = ch.codePointAt(0);
      const s = r.music ? toSmufl(cp) : 0;
      if (s && SMUFL_DYN[s]) letters += SMUFL_DYN[s];
      else if (!r.music && /[pmfszr]/.test(ch)) letters += ch;
      else if (!/\s/.test(ch)) other += ch;
    }
  }
  if (!letters || other.replace(/[()]/g, '').length) return null;
  const MAP = { pppppp: 'ppp', ppppp: 'ppp', pppp: 'ppp', ppp: 'ppp', pp: 'pp', p: 'p', mp: 'mp', mf: 'mf', f: 'f', ff: 'ff', fff: 'fff',
    ffff: 'fff', fffff: 'fff', ffffff: 'fff', sfz: 'sfz', sffz: 'sfz', sf: 'sfz', sfzp: 'sfp', sfp: 'sfp', sfpp: 'sfp', fp: 'fp',
    fz: 'fz', rfz: 'rfz', rf: 'rfz', pf: 'fp' };
  return MAP[letters] || null;
}

// ---------------------------------------------------------------------------
// 4. Musical helpers
// ---------------------------------------------------------------------------
/** Finale key value: bits 0-7 = signed sharps/flats, bits 8-15 = mode (0 major, 1 minor, ≥2 custom). */
function decodeKey(el) {
  const v = int(el, 'key', 0);
  let fifths = v & 0xff; if (fifths > 127) fifths -= 256;
  const mode = (v >> 8) & 0xff;
  const keyless = has(el, 'keyless');
  if (keyless || mode > 1 || fifths < -7 || fifths > 7) return { fifths: 0, mode: 'major', keyless: true };
  return { fifths, mode: mode === 1 ? 'minor' : 'major' };
}
/** Diatonic index (C=0 … B=6) of the key's tonic. */
function tonicIndex(key) {
  if (key.keyless) return 0;
  const major = (((key.fifths * 4) % 7) + 7) % 7;
  return key.mode === 'minor' ? (major + 5) % 7 : major;
}
/** harmLev/harmAlt (scale degree relative to the tonic in the middle-C octave) → {step, octave, alter}. */
function pitchFromHarm(harmLev, harmAlt, key) {
  const idx = tonicIndex(key) + harmLev;
  const step = STEPS[((idx % 7) + 7) % 7];
  const octave = 4 + Math.floor(idx / 7);
  const base = key.keyless ? 0 : keyAlter(step, key.fifths);
  return { step, octave, alter: Math.max(-3, Math.min(3, base + harmAlt)) };
}
/** Chord root from scale degree + alteration relative to the key. */
function chordRootName(scaleNum, alter, key, lower = false) {
  const p = pitchFromHarm(scaleNum, alter, key);
  const acc = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' }[p.alter] ?? '';
  return (lower ? p.step.toLowerCase() : p.step) + acc;
}
/** EDU duration → {base, dots} (exact) or null. */
function eduToDur(edu) {
  for (const [base, t] of Object.entries(DUR_TICKS)) {
    const e = t * EDU_PER_QUARTER / 960;
    if (edu === e) return { base, dots: 0 };
    if (edu === e * 1.5) return { base, dots: 1 };
    if (edu === e * 1.75) return { base, dots: 2 };
    if (edu === e * 1.875) return { base, dots: 3 };
  }
  return null;
}
function nearestDur(edu) {
  let best = { base: 'quarter', dots: 0 }, diff = Infinity;
  for (const [base, t] of Object.entries(DUR_TICKS)) for (const dots of [0, 1, 2]) {
    const e = t * EDU_PER_QUARTER / 960 * [1, 1.5, 1.75][dots];
    const d = Math.abs(e - edu); if (d < diff) { diff = d; best = { base, dots }; }
  }
  return best;
}
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; }

/** Time signature from beats/divbeat (EDU) — returns {num, den, capacityEdu}. */
function timeSigFrom(beats, divbeat, composite) {
  if (composite) beats = composite.reduce((a, b) => a + b, 0) || beats;
  const capacityEdu = beats * divbeat;
  if (divbeat <= 0 || beats <= 0) return { num: 4, den: 4, capacityEdu: 4096 };
  if (4096 % divbeat === 0) { const den = 4096 / divbeat; if ([1, 2, 4, 8, 16, 32, 64].includes(den)) return { num: beats, den, capacityEdu }; }
  if (divbeat % 3 === 0 && 4096 % (divbeat / 3 * 2) === 0) {        // dotted beat → compound meter
    const sub = divbeat / 3; const den = 4096 / sub;
    if ([2, 4, 8, 16, 32].includes(den)) return { num: beats * 3, den, capacityEdu };
  }
  // arbitrary: express in 16ths / 32nds
  for (const den of [4, 8, 16, 32, 64]) { const n = capacityEdu * den / 4096; if (Number.isInteger(n)) return { num: n, den, capacityEdu }; }
  return { num: 4, den: 4, capacityEdu };
}

// clef definitions: index → ClefType
const DEFAULT_CLEF_BY_INDEX = ['treble', 'alto', 'tenor', 'bass', 'percussion', 'treble8vb', 'bass8vb', 'bass', 'treble', 'bass',
  'treble', 'treble', 'percussion', 'treble8va', 'bass', 'treble', 'tab', 'tab', 'tab', 'tab'];
function clefFromDef(def, index) {
  if (!def) return DEFAULT_CLEF_BY_INDEX[index] || 'treble';
  const ch = toSmufl(int(def, 'clefChar', 0));
  const adjust = int(def, 'adjust', -10);
  if ([0xE069, 0xE06A, 0xE06B].includes(ch)) return 'percussion';
  if (ch === 0xE06D || ch === 0xE06E) return 'tab';
  if (!ch && (has(def, 'isShape') || has(def, 'shapeID'))) return DEFAULT_CLEF_BY_INDEX[index] || 'treble';
  if (ch === 0xE05C || ch === 0xE05D) return adjust === -2 ? 'tenor' : adjust === -4 ? 'alto' : adjust > -4 ? 'tenor' : 'alto';
  if (ch === 0xE062 || ch === 0xE064 || ch === 0xE065 || ch === 0xE063) {
    if (adjust >= 8) return 'bass8vb';
    return 'bass';
  }
  // G clefs (and anything unknown): decide by middle-C position
  if (adjust >= -4 && adjust <= -2) return 'treble8vb';
  if (adjust <= -16) return 'treble8va';
  if (adjust >= 1 && adjust <= 3) return 'bass';
  return 'treble';
}

// articulation glyphs (SMuFL) → model fields
const ARTIC_BY_SMUFL = {
  0xE4A0: ['art', 'accent'], 0xE4A1: ['art', 'accent'], 0xE4A2: ['art', 'staccato'], 0xE4A3: ['art', 'staccato'],
  0xE4A4: ['art', 'tenuto'], 0xE4A5: ['art', 'tenuto'], 0xE4A6: ['art', 'staccatissimo'], 0xE4A7: ['art', 'staccatissimo'],
  0xE4A8: ['art', 'staccatissimo'], 0xE4A9: ['art', 'staccatissimo'], 0xE4AA: ['art', 'staccatissimo'], 0xE4AB: ['art', 'staccatissimo'],
  0xE4AC: ['art', 'marcato'], 0xE4AD: ['art', 'marcato'], 0xE4AE: ['art', 'marcato-staccato'], 0xE4AF: ['art', 'marcato-staccato'],
  0xE4B0: ['art', 'accent-staccato'], 0xE4B1: ['art', 'accent-staccato'], 0xE4B2: ['art', 'tenuto-staccato'], 0xE4B3: ['art', 'tenuto-staccato'],
  0xE4B4: ['art2', 'accent', 'tenuto'], 0xE4B5: ['art2', 'accent', 'tenuto'],
  0xE4C0: ['fermata', 'above'], 0xE4C1: ['fermata', 'below'], 0xE4C2: ['fermata', 'above'], 0xE4C3: ['fermata', 'below'],
  0xE4C4: ['fermata', 'above'], 0xE4C5: ['fermata', 'below'], 0xE4C6: ['fermata', 'above'], 0xE4C7: ['fermata', 'below'],
  0xE4C8: ['fermata', 'above'], 0xE4C9: ['fermata', 'below'],
  0xE566: ['orn', 'trill'], 0xE567: ['orn', 'turn'], 0xE568: ['orn', 'inverted-turn'], 0xE569: ['orn', 'inverted-turn'],
  0xE56C: ['orn', 'inverted-mordent'], 0xE56D: ['orn', 'mordent'], 0xE56E: ['orn', 'inverted-mordent'],
  0xE220: ['trem', 1], 0xE221: ['trem', 2], 0xE222: ['trem', 3],
};

// ---------------------------------------------------------------------------
// 5. Conversion
// ---------------------------------------------------------------------------
export function enigmaToScore(xmlText, { meta = null } = {}) {
  const doc = new Doc(parseXML(xmlText));
  const warnings = new Set();
  const warn = (w) => warnings.add(w);

  // ---- fonts ------------------------------------------------------------------
  const fontNames = new Map();
  for (const f of doc.other('fontName')) fontNames.set(+f.attrs.cmper, txt(f, 'name') || '');
  const MUSIC_FONT_RE = /maestro|petrucci|engraver|jazz(?!text)|broadway copyist(?! text)|bravura|petaluma|leland|sebastian|opus|sonata|november|emmentaler|finale (ash|broadway|copyist|engraver|jazz|legacy|maestro|mallets|percussion|numerics|alphanotes)|kousaku|tamburo|rentaro|chaconne|anastasia/i;
  const MUSIC_TEXT_RE = /text|times|serif|sans|copyist text|jazztext/i;
  const ctx = {
    isMusicFontName: (name) => MUSIC_FONT_RE.test(name || '') && !MUSIC_TEXT_RE.test((name || '').replace(/^finale\s+/i, '')),
    isMusicFontId: (id) => ctx.isMusicFontName(fontNames.get(id) || (id === 0 ? 'Maestro' : '')),
  };
  const plainText = (raw, vars) => runsToPlain(enigmaRuns(raw, ctx, vars));

  // ---- file info ------------------------------------------------------------
  const info = (type) => { const t = doc.text('fileInfo', type); return t != null ? plainText(t) : ''; };
  const metaTitle = meta ? (() => { const fi = kid(kid(meta, 'metadata'), 'fileInfo'); return fi ? txt(fi, 'title') : ''; })() : '';

  // ---- staves & parts -------------------------------------------------------
  const staffSpecs = doc.index('staffSpec');
  let order = (doc.group('instUsed').get('0') || []).map(el => int(el, 'inst'));
  if (!order.length) {
    const systems = [...doc.group('instUsed').entries()].filter(([k]) => +k > 0 && +k < 65000).sort((a, b) => +a[0] - +b[0]);
    if (systems.length) order = systems[0][1].map(el => int(el, 'inst'));
  }
  if (!order.length) order = [...staffSpecs.keys()].map(Number).sort((a, b) => a - b);
  order = [...new Set(order)].filter(id => id > 0 && id < 32767 && staffSpecs.has(String(id)));
  if (!order.length) throw new Error('Finale 파일에 오선 정보가 없습니다');

  const clefDefs = new Map();
  const clefOpts = findDeep(doc.options, 'clefOptions');
  for (const cd of kids(clefOpts, 'clefDef')) clefDefs.set(+cd.attrs.index, cd);
  const clefOf = (index) => clefFromDef(clefDefs.get(index), index);

  const textBlocks = doc.index('textBlock');
  const blockText = (textBlockId) => {
    const tb = textBlocks.get(String(textBlockId));
    const raw = tb ? doc.text('blockText', int(tb, 'textID')) : null;
    return raw != null ? plainText(raw).replace(/\s*\n\s*/g, ' / ') : '';
  };

  // multi-staff instruments (piano, harp, organ …)
  const groupOfStaff = new Map();
  for (const g of doc.other('multiStaffInstGroup')) {
    const ids = g.children.filter(c => /^staffNum\d+$/.test(c.tag)).map(c => parseInt(c.text, 10)).filter(id => order.includes(id));
    if (ids.length > 1) for (const id of ids) groupOfStaff.set(id, ids);
  }
  const staffGroups = doc.detail('staffGroup').filter(g => g.attrs.cmper1 === '0');
  const groupNameFor = (ids) => {
    for (const g of staffGroups) {
      const a = int(g, 'startInst'), b = int(g, 'endInst');
      if (ids.includes(a) && ids.includes(b) && kid(g, 'fullID') && !has(g, 'hideName')) { const n = blockText(int(g, 'fullID')); if (n) return n; }
    }
    return '';
  };

  // first-measure clefs come from the gfhold records; fall back to the staff default
  const gfholds = new Map();
  for (const g of doc.detail('gfhold')) gfholds.set(`${g.attrs.cmper1}:${g.attrs.cmper2}`, g);

  const hasLyricsOnStaff = new Set();
  const parts = []; const staffIndex = new Map(); const staffInfo = new Map(); const used = new Set();
  let gIndex = 0;
  for (const id of order) {
    if (used.has(id)) continue;
    const ids = groupOfStaff.get(id) ? order.filter(x => groupOfStaff.get(id).includes(x)) : [id];
    ids.forEach(x => used.add(x));
    const specs = ids.map(x => staffSpecs.get(String(x)));
    const names = specs.map(sp => (kid(sp, 'fullName') ? blockText(int(sp, 'fullName')) : '')).filter(Boolean);
    const abbrs = specs.map(sp => (kid(sp, 'abbrvName') ? blockText(int(sp, 'abbrvName')) : '')).filter(Boolean);
    const staves = ids.map((x, k) => {
      const sp = specs[k];
      const style = txt(sp, 'notationStyle');
      const g1 = gfholds.get(`${x}:1`);
      let clef = clefOf(g1 && kid(g1, 'clefID') ? int(g1, 'clefID') : int(sp, 'defaultClef', 0));
      let type = style === 'percussion' || clef === 'percussion' ? 'percussion' : (style === 'tab' || clef === 'tab') ? 'tab' : 'standard';
      if (type === 'standard' && (clef === 'percussion' || clef === 'tab')) clef = 'treble';
      const custom = kid(sp, 'customStaff');
      const lines = custom ? kids(custom, 'staffLine').length : (kid(sp, 'staffLines') ? int(sp, 'staffLines', 5) : 5);
      return { id: x, clef, type, lines: lines || 5, spec: sp };
    });
    const name = groupNameFor(ids) || names[0] || '';
    const instrument = guessInstrument(name, staves);
    const part = createPart(instrument);
    part.name = name || part.name;
    if (abbrs[0]) part.abbreviation = abbrs[0];
    part.staves = staves.map(s => {
      const st = { id: newId(), type: s.type, lines: s.type === 'tab' ? Math.max(4, s.lines) : s.type === 'percussion' ? (s.lines === 1 ? 1 : 5) : 5, clef: s.type === 'percussion' ? 'percussion' : s.type === 'tab' ? 'tab' : s.clef };
      if (s.type === 'percussion') { st.drumMap = JSON.parse(JSON.stringify(DEFAULT_DRUM_MAP)); if (st.lines === 1) st.drumMap = { hit: { line: 4, head: 'normal', midi: 38, name: '타격' } }; }
      if (s.type === 'tab') st.tuning = st.lines === 4 ? ['E1', 'A1', 'D2', 'G2'] : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
      return st;
    });
    // transposition (Finale stores concert pitch; JSE stores written pitch)
    const tr = kid(staves[0].spec, 'transposition');
    const ks = tr && kid(tr, 'keysig');
    if (ks) {
      const interval = int(ks, 'interval', 0), adjust = int(ks, 'adjust', 0);
      if (interval || adjust) {
        let semis = (((adjust * 7) % 12) + 12) % 12; const target = interval * 12 / 7;
        while (semis - target > 6) semis -= 12; while (target - semis > 6) semis += 12;
        part.transposeChromatic = -semis;
        part._writtenShift = { diatonic: interval, semitones: semis };
      }
    } else if (tr && kid(tr, 'chromatic')) {
      const ch = kid(tr, 'chromatic'); const diatonic = int(ch, 'diatonic', 0), alteration = int(ch, 'alteration', 0);
      if (diatonic || alteration) warn('반음 단위 이조 악기는 근사치로 가져왔습니다');
    }
    staves.forEach((s, k) => { staffIndex.set(s.id, gIndex); staffInfo.set(s.id, { ...s, part, staff: part.staves[k], gIndex }); gIndex++; });
    parts.push(part);
  }
  const nStaves = gIndex;

  // ---- measures ---------------------------------------------------------------
  const measSpecs = doc.index('measSpec');
  const measCount = Math.max(1, ...[...measSpecs.keys()].map(Number).filter(n => n > 0 && n < 32767));
  const timeUpper = doc.group('timeUpper');
  const compositeOf = (cmper) => {
    const list = timeUpper.get(String(cmper)); if (!list) return null;
    const vals = []; for (const el of list) for (const d of kids(el, 'tudata')) vals.push(int(d, 'integer', 0));
    return vals.filter(v => v > 0);
  };
  const score = {
    format: 'scoresnap', version: 1,
    meta: { title: info('title') || metaTitle || '', subtitle: info('subtitle'), composer: info('composer'), lyricist: info('lyricist'), arranger: info('arranger'), copyright: info('copyright'), created: new Date().toISOString(), modified: new Date().toISOString(), appVersion: '1.0.0' },
    settings: {
      pageSize: 'A4', orientation: 'portrait', pageWidthMm: 210, pageHeightMm: 297,
      marginsMm: { top: 15, bottom: 15, left: 15, right: 15 },
      staffSpaceMm: 1.75, systemGapSp: 9, staffGapSp: 7, firstSystemIndentSp: 0,
      measureNumbers: 'system', concertPitch: true, fonts: { text: '', lyrics: '' },
    },
    parts, measures: [], spanners: [], sources: [],
  };
  applyPageSetup(doc, score);

  const keys = []; const caps = []; const tsList = [];
  let prevKey = null, prevTs = null;
  for (let m = 1; m <= measCount; m++) {
    const ms = measSpecs.get(String(m));
    const measure = createMeasure({ parts });
    measure.staves = Array.from({ length: nStaves }, () => ({ voices: [[]] }));
    const key = ms && kid(ms, 'keySig') ? decodeKey(kid(ms, 'keySig')) : (prevKey || { fifths: 0, mode: 'major' });
    const beats = ms ? int(ms, 'beats', 4) : (prevTs ? prevTs.beats : 4);
    const divbeat = ms ? int(ms, 'divbeat', 1024) : (prevTs ? prevTs.divbeat : 1024);
    const actual = timeSigFrom(beats, divbeat, ms && has(ms, 'compositeNumerator') ? compositeOf(beats) : null);
    let shown = actual;
    if (ms && has(ms, 'useDisplayTimesig')) {
      const db = int(ms, 'dispBeats', beats), dd = int(ms, 'dispDivbeat', divbeat);
      shown = timeSigFrom(db, dd, has(ms, 'displayCompositeNumerator') ? compositeOf(db) : null);
      if (actual.capacityEdu > shown.capacityEdu) shown = actual;   // unmetered / long measures: keep the real length
    }
    let display = 'normal';
    if (ms && has(ms, 'abbrvTime')) { if (shown.num === 4 && shown.den === 4) display = 'common'; else if (shown.num === 2 && shown.den === 2) display = 'cut'; }
    const tsKey = `${shown.num}/${shown.den}/${display}`;
    if (!prevTs || prevTs.key !== tsKey) measure.timeSig = { num: shown.num, den: shown.den, display };
    if (actual.capacityEdu < shown.capacityEdu) measure.pickup = true;
    if (!prevKey || prevKey.fifths !== key.fifths || prevKey.mode !== key.mode) measure.keySig = { fifths: key.fifths, mode: key.mode };
    if (ms) {
      const bl = txt(ms, 'barline');
      const BL = { double: 'double', final: 'final', dashed: 'dashed', none: 'none', thick: 'final', tick: 'single', normal: null, custom: null };
      if (bl && BL[bl]) measure.barlineRight = BL[bl];
      if (has(ms, 'forRepBar')) measure.barlineLeft = 'repeat-start';
      if (has(ms, 'bacRepBar')) measure.barlineRight = 'repeat-end';
    }
    keys.push(key); caps.push(actual.capacityEdu); tsList.push(shown);
    prevKey = key; prevTs = { beats, divbeat, key: tsKey };
    score.measures.push(measure);
  }
  if (!score.measures[0].timeSig) score.measures[0].timeSig = { num: 4, den: 4, display: 'normal' };
  if (!score.measures[0].keySig) score.measures[0].keySig = { fifths: 0, mode: 'major' };
  // a pickup only makes sense on the first measure; elsewhere keep the actual meter
  score.measures.forEach((m, mi) => {
    if (mi > 0 && m.pickup) {
      delete m.pickup;
      const a = timeSigFrom(1, caps[mi], null);
      m.timeSig = { num: a.num, den: a.den, display: 'normal' };
      const next = score.measures[mi + 1];
      if (next && !next.timeSig) { const s = tsList[mi + 1]; next.timeSig = { num: s.num, den: s.den, display: 'normal' }; }
    }
  });
  const last = score.measures[score.measures.length - 1];
  if (!last.barlineRight) last.barlineRight = 'final';

  // repeats: counts, endings, text repeats
  for (const rb of doc.other('repeatBack')) {
    const mi = +rb.attrs.cmper - 1; const m = score.measures[mi]; if (!m) continue;
    const act = int(rb, 'actuate', 2); if (act > 2) m.repeatCount = act;
  }
  const passLists = doc.group('repeatPassList');
  const endingTexts = doc.index('repeatEndingText');
  for (const es of doc.other('repeatEndingStart')) {
    const startMi = +es.attrs.cmper - 1; if (!score.measures[startMi]) continue;
    const passes = (passLists.get(es.attrs.cmper) || []).flatMap(el => kids(el, 'act').map(a => parseInt(a.text, 10))).filter(n => n > 0);
    let endMi = startMi;
    const nextEnd = int(es, 'nextEnd', 0) - 1;
    const isEnd = (k) => ['repeat-end', 'repeat-both', 'final'].includes(score.measures[k].barlineRight);
    if (nextEnd > startMi) {
      for (let k = startMi; k < Math.min(nextEnd, score.measures.length); k++) { endMi = k; if (isEnd(k)) break; }
    } else {
      // last ending: up to the next repeat barline within a few bars, otherwise one bar
      for (let k = startMi; k < Math.min(startMi + 4, score.measures.length); k++) if (isEnd(k)) { endMi = k; break; }
    }
    const et = endingTexts.get(es.attrs.cmper);
    const label = et ? plainText(txt(et, 'rptText') || '') : passes.length ? passes.join(', ') + '.' : '1.';
    const closed = ['repeat-end', 'repeat-both'].includes(score.measures[endMi].barlineRight);
    score.spanners.push({ id: newId(), type: 'volta', from: { measureId: score.measures[startMi].id }, to: { measureId: score.measures[endMi].id }, number: label, voltaType: closed ? 'closed' : 'open' });
  }
  const repeatTexts = new Map();
  for (const t of doc.other('textRepeatText')) repeatTexts.set(t.attrs.cmper, plainText(txt(t, 'rptText') || ''));
  for (const ta of doc.other('textRepeatAssign')) {
    const m = score.measures[+ta.attrs.cmper - 1]; if (!m) continue;
    const text = repeatTexts.get(String(int(ta, 'repnum'))) || '';
    const mk = markerFromText(text);
    if (mk) (m.markers || (m.markers = [])).includes(mk) || m.markers.push(mk);
    else if (text) (m.texts || (m.texts = [])).push({ text, placement: 'above', style: 'plain' });
  }
  // system breaks from Finale's page layout
  const systems = doc.other('staffSystemSpec').map(s => ({ start: int(s, 'startMeas', 1), end: int(s, 'endMeas', 1) })).filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  if (systems.length > 1) for (const s of systems.slice(0, -1)) { const m = score.measures[s.end - 2]; if (m && s.end - 1 < score.measures.length) m.breaks = { ...(m.breaks || {}), system: true }; }

  // ---- notes ------------------------------------------------------------------------
  const frames = doc.group('frameSpec');
  const tupletDefs = doc.group('tupletDef', 'entnum', true);
  const articAssigns = doc.group('articAssign', 'entnum', true);
  const articDefs = doc.index('articDef');
  const lyricData = { verse: doc.group('lyrDataVerse', 'entnum', true), chorus: doc.group('lyrDataChorus', 'entnum', true), section: doc.group('lyrDataSection', 'entnum', true) };
  const lyricTexts = { verse: new Map(), chorus: new Map(), section: new Map() };
  let maxVerse = 0;
  for (const kind of ['verse', 'chorus', 'section']) {
    for (const [k, v] of doc.texts) {
      const [tag, num] = k.split(':'); if (tag !== kind) continue;
      lyricTexts[kind].set(+num, splitLyrics(enigmaRuns(v, ctx).filter(r => !r.music).map(r => r.text).join('')));
      if (kind === 'verse') maxVerse = Math.max(maxVerse, +num);
    }
  }
  let lyricFontId = null;
  for (const [k, v] of doc.texts) if (k.startsWith('verse:')) { const fm = /\^fontid\((\d+)\)/.exec(v); if (fm) { lyricFontId = +fm[1]; break; } }
  const verseNumber = (kind, num) => kind === 'verse' ? num : kind === 'chorus' ? maxVerse + num : maxVerse + 10 + num;

  const entryToEvent = new Map();   // entnum → { ev, gIndex, mi, voice, tick }
  const clefNow = new Map();

  for (const [fid] of staffInfo) clefNow.set(fid, staffInfo.get(fid).staff.clef);
  for (let mi = 0; mi < measCount; mi++) {
    const measure = score.measures[mi]; const key = keys[mi]; const capEdu = caps[mi];
    for (const [fid, sInfo] of staffInfo) {
      const gh = gfholds.get(`${fid}:${mi + 1}`);
      const sm = measure.staves[sInfo.gIndex];
      // clef changes (only standard staves)
      if (gh && sInfo.staff.type === 'standard') {
        let cid = kid(gh, 'clefID') ? int(gh, 'clefID') : null;
        if (cid == null && kid(gh, 'clefListID')) {
          const list = doc.group('clefList').get(txt(gh, 'clefListID'));
          if (list && list.length) { cid = int(list[0], 'clefIndex', 0); if (list.length > 1) warn('마디 중간 음자리표 변경은 마디 처음으로 옮겼습니다'); }
        }
        if (cid != null) {
          let c = clefOf(cid); if (c === 'percussion' || c === 'tab') c = clefNow.get(fid);
          if (c !== clefNow.get(fid)) { if (mi === 0) sInfo.staff.clef = c; else sm.clef = c; clefNow.set(fid, c); }
        }
      }
      if (!gh) continue;
      const layerVoices = [];
      for (let layer = 1; layer <= 4; layer++) {
        const frId = kid(gh, `frame${layer}`) ? txt(gh, `frame${layer}`) : null;
        if (!frId) continue;
        const frList = frames.get(frId) || [];
        const chain = [];
        let startTimeEdu = 0;
        for (const fr of frList) {
          if (kid(fr, 'startTime')) startTimeEdu = int(fr, 'startTime', 0);
          const s = int(fr, 'startEntry', 0), e = int(fr, 'endEntry', 0);
          if (!s) continue;
          let cur = s, guard = 0;
          while (cur && guard++ < 4096) { const en = doc.entries.get(cur); if (!en) break; chain.push(en); if (cur === e) break; cur = +en.attrs.next || 0; }
        }
        if (!chain.length) continue;
        // voice-2 entries follow a "v2Launch" entry and start where that entry starts
        const main = [], v2 = [];
        let tMain = startTimeEdu, launchAt = 0, tV2 = 0;
        const tupMain = { left: 0, ratio: 1 }, tupV2 = { left: 0, ratio: 1 };
        const actual = (en, tup) => {      // real duration in EDU, honouring tuplets
          if (has(en, 'graceNote') || has(en, 'dummy')) return 0;
          const d = int(en, 'dura', 1024);
          const td = (tupletDefs.get(en.attrs.entnum) || [])[0];
          if (td) { const nom = int(td, 'symbolicNum', 3) * int(td, 'symbolicDur', 512), act = int(td, 'refNum', 2) * int(td, 'refDur', 512); if (nom > 0 && act > 0) { tup.left = nom; tup.ratio = act / nom; } }
          if (tup.left > 0) { tup.left -= d; return d * tup.ratio; }
          return d;
        };
        for (const en of chain) {
          if (has(en, 'voice2')) { v2.push({ en, start: tV2 }); tV2 += actual(en, tupV2); }
          else { if (has(en, 'v2Launch')) { launchAt = tMain; tV2 = launchAt; } main.push({ en, start: tMain }); tMain += actual(en, tupMain); }
        }
        layerVoices.push({ layer, items: main });
        if (v2.length) layerVoices.push({ layer, items: v2, v2: true });
      }
      layerVoices.forEach((lv, vi) => {
        if (vi > 3) { warn('한 오선에 4개를 넘는 성부는 생략했습니다'); return; }
        const voice = buildVoice(lv, { doc, key, sInfo, part: sInfo.part, tupletDefs, articAssigns, articDefs, lyricData, lyricTexts, verseNumber, warn, mi, entryToEvent, gIndex: sInfo.gIndex, voiceIndex: vi, hasLyricsOnStaff });
        sm.voices[vi] = voice;
      });
      // fill gaps so every voice reaches the measure length
      const capTicks = toTicks(capEdu);
      sm.voices.forEach((v, vi) => {
        if (!v.length) return;
        while (v.length > 1 && voiceTicks(v) > toTicks(capEdu) + 1 && v[v.length - 1].kind === 'rest' && !v[v.length - 1].lyrics) v.pop();   // overfull: drop trailing rests
        const total = voiceTicks(v);
        if (total < capTicks - 1) for (const d of ticksToDurations(capTicks - total)) { const r = makeRest(d.base, d.dots); if (vi > 0) r.hidden = true; v.push(r); }
        // whole-measure rest: a single rest filling the bar
        if (v.length === 1 && v[0].kind === 'rest' && Math.abs(durTicks(v[0]) - capTicks) <= 1 && !v[0].tuplet) { v[0].fullMeasureRest = true; v[0].dur = { base: 'whole', dots: 0 }; }
        else if (v.length === 1 && v[0].kind === 'rest' && durTicks(v[0]) > capTicks) { v[0].fullMeasureRest = true; v[0].dur = { base: 'whole', dots: 0 }; }
      });
      for (let k = sm.voices.length - 1; k > 0; k--) if (!sm.voices[k] || !sm.voices[k].length || sm.voices[k].every(e => e.kind === 'rest' && e.hidden)) sm.voices.splice(k, 1);
      if (!sm.voices.length) sm.voices = [[]];
    }
  }

  // percussion: map positions to drum keys; tab: assign string/fret
  for (const [, sInfo] of staffInfo) {
    if (sInfo.staff.type === 'percussion') {
      for (const m of score.measures) for (const v of m.staves[sInfo.gIndex].voices) for (const ev of v) for (const n of (ev.notes || [])) {
        const line = staffPosition(n, 'treble');
        const entries = Object.entries(sInfo.staff.drumMap);
        const hit = entries.find(([, d]) => d.line === line && d.head === 'normal') || entries.find(([, d]) => d.line === line) || entries.sort((a, b) => Math.abs(a[1].line - line) - Math.abs(b[1].line - line))[0];
        if (hit) n.drum = hit[0];
        n.alter = 0;
      }
    } else if (sInfo.staff.type === 'tab') {
      const tuning = sInfo.staff.tuning.map(t => midiOf({ step: t[0], octave: +t.slice(-1), alter: 0 }));
      for (const m of score.measures) for (const v of m.staves[sInfo.gIndex].voices) for (const ev of v) {
        const usedStrings = new Set();
        for (const n of [...(ev.notes || [])].sort((a, b) => midiOf(b) - midiOf(a))) {
          const midi = midiOf(n); let best = null;
          for (let s = tuning.length - 1; s >= 0; s--) { const fret = midi - tuning[s]; const stringNo = tuning.length - s; if (fret >= 0 && fret <= 24 && !usedStrings.has(stringNo)) { best = { string: stringNo, fret }; break; } }
          if (best) { n.string = best.string; n.fret = best.fret; usedStrings.add(best.string); }
        }
      }
    }
  }

  // written pitch for transposing instruments
  for (const part of parts) {
    const sh = part._writtenShift; delete part._writtenShift; if (!sh) continue;
    const gis = [...staffInfo.values()].filter(s => s.part === part).map(s => s.gIndex);
    for (const m of score.measures) for (const gi of gis) for (const v of m.staves[gi].voices) for (const ev of v) for (const n of (ev.notes || [])) Object.assign(n, shiftPitch(n, sh.diatonic, sh.semitones));
  }

  // ---- chords -----------------------------------------------------------------------
  const suffixes = doc.group('chordSuffix');
  const suffixText = (id) => {
    const list = suffixes.get(String(id)); if (!list) return '';
    let out = '';
    for (const el of list) {
      const code = int(el, 'suffix', 0); if (!code) continue;
      const pre = txt(el, 'prefix');
      if (pre === 'plus') out += '+'; else if (pre === 'minus') out += '-'; else if (pre === 'sharp') out += '#'; else if (pre === 'flat') out += 'b';
      if (has(el, 'isNumber')) { out += String(code); continue; }
      const music = kid(el, 'fontID') ? ctx.isMusicFontId(int(el, 'fontID')) : false;
      const s = music ? toSmufl(code) : 0;
      if (s === 0xE262 || (music && code === 35)) out += '#';
      else if (s === 0xE260 || (music && code === 98)) out += 'b';
      else if (s === 0xE870 || s === 0xE884) out += 'dim';
      else if (s === 0xE871) out += 'm7b5';
      else if (s === 0xE872) out += '+';
      else if (s === 0xE873) out += 'maj';
      else if (s === 0xE874) out += 'm';
      else if (s === 0xE875) out += 'maj';
      else if (!music) out += String.fromCodePoint(code);
    }
    return out.replace(/Δ/g, 'maj').replace(/ø/g, 'm7b5').replace(/°/g, 'dim').trim();
  };
  for (const ca of doc.detail('chordAssign')) {
    const fid = +ca.attrs.cmper1, mi = +ca.attrs.cmper2 - 1;
    const m = score.measures[mi]; if (!m || !staffInfo.has(fid)) continue;
    if (!has(ca, 'showRoot') && !has(ca, 'showSuffix')) continue;
    const key = keys[mi];
    const root = chordRootName(int(ca, 'rootScaleNum', 0), int(ca, 'rootAlter', 0), key, has(ca, 'rootLowerCase'));
    const kind = has(ca, 'showSuffix') && kid(ca, 'suffix') ? suffixText(int(ca, 'suffix')) : '';
    const bass = has(ca, 'showAltBass') ? chordRootName(int(ca, 'bassScaleNum', 0), int(ca, 'bassAlter', 0), key, has(ca, 'bassLowerCase')) : '';
    const tick = toTicks(int(ca, 'horzEdu', 0));
    const chord = { id: newId(), tick, text: root + kind + (bass ? '/' + bass : ''), root };
    if (kind) chord.kind = kind;
    if (bass) chord.bass = bass;
    const arr = m.chords || (m.chords = []);
    if (!arr.some(c => c.tick === tick)) arr.push(chord);
  }
  for (const m of score.measures) if (m.chords) m.chords.sort((a, b) => a.tick - b.tick);

  // ---- expressions -------------------------------------------------------------------
  const exprDefs = doc.index('textExprDef');
  const catTypes = new Map();
  for (const c of doc.other('markingsCategory')) catTypes.set(+c.attrs.cmper, txt(c, 'categoryType') || '');
  const catDefault = { 1: 'dynamics', 2: 'tempoMarks', 3: 'tempoAlts', 4: 'expressiveText', 5: 'techniqueText', 6: 'rehearsalMarks', 7: 'misc' };
  let rehearsalSeq = 0;
  for (const ea of doc.other('measExprAssign')) {
    if (has(ea, 'hidden') && !kid(ea, 'hidden').children.length) continue;
    const mi = +ea.attrs.cmper - 1; const m = score.measures[mi]; if (!m) continue;
    if (!kid(ea, 'textExprID')) continue;     // shape expressions are skipped
    const def = exprDefs.get(txt(ea, 'textExprID')); if (!def) continue;
    const raw = doc.text('expression', int(def, 'textIDKey')); if (raw == null) continue;
    const catId = int(def, 'categoryID', 0);
    const cat = catTypes.get(catId) || catDefault[catId] || 'misc';
    const value = int(def, 'value', 0);
    const runs = enigmaRuns(raw, ctx, { value: value || '' });
    const plain = runsToPlain(runs);
    const fid = int(ea, 'staffAssign', 0);
    const staffG = staffInfo.has(fid) ? staffInfo.get(fid).gIndex : 0;
    const tick = toTicks(int(ea, 'horzEduOff', 0));
    const layer = Math.max(1, int(ea, 'layer', 1));
    const vAlign = txt(def, 'vertMeasExprAlign') || '';
    const placement = /below/i.test(vAlign) ? 'below' : /above/i.test(vAlign) ? 'above' : (cat === 'dynamics' ? 'below' : 'above');
    if (cat === 'tempoMarks' || txt(def, 'playType') === 'time') {
      const tempo = tempoFromRuns(runs, value, int(def, 'auxdata1', 1024));
      if (tempo && !m.tempo) { m.tempo = tempo; continue; }
    }
    if (cat === 'rehearsalMarks') {
      rehearsalSeq++;
      const style = txt(def, 'rehearsalMarkStyle');
      m.rehearsalMark = plain || (style === 'numbers' ? String(rehearsalSeq) : style === 'measNum' ? String(mi + 1) : String.fromCharCode(64 + ((rehearsalSeq - 1) % 26) + 1));
      continue;
    }
    if (cat === 'dynamics') {
      const dyn = dynamicFromRuns(runs);
      const ev = eventAt(score, mi, staffG, tick, layer - 1);
      if (dyn && ev && !ev.dynamic) { ev.dynamic = dyn; continue; }
    }
    if (!plain) continue;
    const style = cat === 'techniqueText' ? 'technique' : (cat === 'expressiveText' || cat === 'tempoAlts' || cat === 'dynamics') ? 'expression' : 'plain';
    const ev = eventAt(score, mi, staffG, tick, layer - 1);
    if (ev && tick > 0) (ev.texts || (ev.texts = [])).push({ text: plain, placement, style });
    else {
      const arr = m.texts || (m.texts = []);
      const mk = markerFromText(plain);
      if (mk) (m.markers || (m.markers = [])).includes(mk) || m.markers.push(mk);
      else arr.push({ text: plain, placement, style: style === 'plain' ? 'plain' : style });
    }
  }

  // ---- smart shapes -------------------------------------------------------------------
  const endpointEvent = (seg) => {
    const ep = kid(seg, 'endPt'); if (!ep) return null;
    const entryNum = int(ep, 'entryNum', 0);
    if (entryNum && entryToEvent.has(entryNum)) return entryToEvent.get(entryNum);
    const fid = int(ep, 'inst', 0), mi = int(ep, 'meas', 1) - 1;
    if (!staffInfo.has(fid) || !score.measures[mi]) return null;
    const gi = staffInfo.get(fid).gIndex;
    const tick = toTicks(int(ep, 'edu', 0));
    const ev = eventAt(score, mi, gi, tick, 0, true);
    return ev ? { ev, gIndex: gi, mi } : null;
  };
  for (const ss of doc.other('smartShape')) {
    if (has(ss, 'hidden')) continue;
    const type = txt(ss, 'shapeType') || 'slurAuto';
    if (type === 'wordExt' || type === 'hyphen') continue;   // lyric decorations handled with lyrics
    const a = endpointEvent(kid(ss, 'startTermSeg')), b = endpointEvent(kid(ss, 'endTermSeg'));
    if (!a || !b) continue;
    if (a.ev === b.ev && /slur/i.test(type)) continue;
    const sp = { id: newId(), from: { eventId: a.ev.id }, to: { eventId: b.ev.id } };
    if (/slur/i.test(type)) { sp.type = 'slur'; if (/Up$/.test(type)) sp.placement = 'above'; else if (/Down$/.test(type)) sp.placement = 'below'; }
    else if (type === 'cresc') sp.type = 'crescendo';
    else if (type === 'decresc') sp.type = 'diminuendo';
    else if (type === 'octaveUp' || type === 'octaveDown' || type === 'twoOctaveUp' || type === 'twoOctaveDown') { sp.type = 'ottava'; sp.octaveShift = { octaveUp: 8, octaveDown: -8, twoOctaveUp: 15, twoOctaveDown: -15 }[type]; }
    else if (type === 'trill' || type === 'trillExt') sp.type = 'trill';
    else if (type === 'glissando' || type === 'tabSlide') sp.type = 'glissando';
    else if (/pedal/i.test(type)) sp.type = 'pedal';
    else if (/line|bracket/i.test(type)) { sp.type = 'textLine'; sp.text = ''; }
    else continue;
    score.spanners.push(sp);
  }

  // ---- finishing ----------------------------------------------------------------------
  if (lyricFontId != null) {
    const fname = fontNames.get(lyricFontId) || '';
    if (fname && !ctx.isMusicFontName(fname) && !/^(times|times new roman|helvetica|arial)$/i.test(fname)) score.settings.fonts.lyrics = fname;
  }
  for (const part of parts) {
    if (part.instrument === 'melody' && [...staffInfo.values()].some(s => s.part === part && hasLyricsOnStaff.has(s.gIndex))) { part.instrument = 'voice'; part.midiProgram = INSTRUMENTS.voice.program; if (!part.name || part.name === INSTRUMENTS.melody.name) part.name = INSTRUMENTS.voice.name; }
  }
  score.measures.forEach(m => { for (const sm of m.staves) for (const v of sm.voices) for (const ev of v) if (ev.notes && ev.notes.length > 1) ev.notes.sort((x, y) => midiOf(x) - midiOf(y)); });
  normalizeImported(score);
  validateScore(score, { repair: true });
  score.importInfo = { from: 'finale', warnings: [...warnings] };
  return score;
}

// ---------------------------------------------------------------------------
// 6. Pieces
// ---------------------------------------------------------------------------
function findDeep(node, tag) {
  if (!node) return null;
  for (const c of node.children) { if (c.tag === tag) return c; const d = findDeep(c, tag); if (d) return d; }
  return null;
}

function applyPageSetup(doc, score) {
  const ps = doc.index('pageSpec').get('1') || doc.other('pageSpec')[0];
  const EVPU_MM = 25.4 / 288;
  if (ps) {
    const w = int(ps, 'width', 2448) * EVPU_MM, h = int(ps, 'height', 3168) * EVPU_MM;
    if (w > 50 && h > 50) {
      const near = (a, b) => Math.abs(a - b) < 3;
      const portrait = h >= w; const W = portrait ? w : h, H = portrait ? h : w;
      score.settings.orientation = portrait ? 'portrait' : 'landscape';
      score.settings.pageSize = near(W, 210) && near(H, 297) ? 'A4' : near(W, 215.9) && near(H, 279.4) ? 'Letter' : near(W, 297) && near(H, 420) ? 'A3' : near(W, 176) && near(H, 250) ? 'B5' : 'custom';
      score.settings.pageWidthMm = Math.round(w * 10) / 10; score.settings.pageHeightMm = Math.round(h * 10) / 10;
      const mm = (v) => Math.max(5, Math.min(40, Math.round(Math.abs(v) * EVPU_MM)));
      score.settings.marginsMm = { top: mm(int(ps, 'margTop', -144)), bottom: mm(int(ps, 'margBottom', 144)), left: mm(int(ps, 'margLeft', 144)), right: mm(int(ps, 'margRight', -144)) };
    }
    const pct = int(ps, 'percent', 100) / 100;
    const sys = doc.other('staffSystemSpec')[0];
    if (sys) {
      const staffH = int(sys, 'staffHeight', 6144) / 64;   // EVPU for 4 spaces
      const sp = staffH / 4 * (int(sys, 'ssysPercent', 100) / 100) * pct * EVPU_MM;
      if (sp > 0.8 && sp < 4) score.settings.staffSpaceMm = Math.round(sp * 100) / 100;
    }
  }
}

function guessInstrument(name, staves) {
  const n = (name || '').toLowerCase();
  if (staves[0].type === 'percussion') return /drum|kit|드럼/.test(n) || staves[0].lines > 1 ? 'drumset' : 'rhythm';
  if (staves[0].type === 'tab') return 'guitar-tab';
  if (staves.length >= 2) return 'piano';
  const table = [
    [/piano|피아노|klavier/, 'piano'], [/organ|오르간|keyboard|키보드|synth|harpsichord|celesta/, 'keyboard'],
    [/sop|alto|tenor|bass(?!oon)|baritone|voice|vocal|choir|chorus|melody|lead|소프라노|알토|테너|베이스|바리톤|보컬|합창|노래|멜로디|성가/, 'voice'],
    [/violin|바이올린/, 'violin'], [/viola|비올라/, 'viola'], [/cello|첼로/, 'cello'], [/contrabass|double bass|콘트라베이스/, 'bass'],
    [/flute|플루트|piccolo/, 'flute'], [/clarinet|클라리넷/, 'clarinet'], [/sax|색소폰/, 'saxophone'], [/trumpet|트럼펫|cornet|flugel/, 'trumpet'],
    [/recorder|리코더/, 'recorder'], [/ukulele|우쿨렐레/, 'ukulele'], [/bass guitar|electric bass|베이스 기타/, 'bass'], [/guitar|기타/, 'guitar'],
  ];
  for (const [re, inst] of table) if (re.test(n)) {
    if (inst === 'voice' && /bass/.test(n) && staves[0].clef === 'treble') continue;
    return inst;
  }
  if (staves[0].clef === 'bass') return 'cello';
  if (staves[0].clef === 'alto') return 'viola';
  if (staves[0].clef === 'treble8vb') return 'guitar';
  return 'melody';
}

function shiftPitch(n, diatonic, semitones) {
  const idx = STEPS.indexOf(n.step) + diatonic;
  const step = STEPS[((idx % 7) + 7) % 7];
  const octave = n.octave + Math.floor(idx / 7);
  const target = midiOf(n) + semitones;
  const natural = midiOf({ step, octave, alter: 0 });
  const alter = target - natural;
  if (alter < -2 || alter > 2) return n;
  return { ...n, step, octave, alter };
}

/** Finale lyric text → [{text, hyphenAfter}] (syllables split at spaces and hyphens). */
function splitLyrics(text) {
  const out = []; let buf = '';
  const flush = (hy) => { if (buf.trim()) out.push({ text: buf.trim(), hyphenAfter: hy }); else if (hy && out.length) out[out.length - 1].hyphenAfter = true; buf = ''; };
  for (const ch of (text || '').replace(/\r/g, '\n')) {
    if (ch === ' ' || ch === '\n' || ch === '\t') flush(false);
    else if (ch === '-') flush(true);
    else buf += ch === '_' ? ' ' : ch;
  }
  flush(false);
  return out;
}

function markerFromText(text) {
  const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t === '𝄋' || t === 'segno') return 'segno';
  if (t === '𝄌' || t === 'coda') return 'coda';
  if (/^fine\.?$/.test(t)) return 'fine';
  if (/^(to coda|al coda|to 𝄌)/.test(t)) return 'toCoda';
  if (/^d\.? ?s\.? al coda/.test(t)) return 'dsAlCoda';
  if (/^d\.? ?s\.? al fine/.test(t)) return 'dsAlFine';
  if (/^d\.? ?c\.? al coda/.test(t)) return 'dcAlCoda';
  if (/^d\.? ?c\.? al fine/.test(t)) return 'dcAlFine';
  if (/^d\.? ?s\.?$/.test(t) || t === 'dal segno') return 'ds';
  if (/^d\.? ?c\.?$/.test(t) || t === 'da capo') return 'dc';
  return null;
}

function tempoFromRuns(runs, value, beatEdu) {
  let unit = null, dots = 0, words = '';
  for (const r of runs) {
    if (!r.music) { words += r.text; continue; }
    for (const ch of r.text) {
      const s = toSmufl(ch.codePointAt(0));
      if (METRONOME[s] && !unit) unit = METRONOME[s];
      else if (s === 0xE1E7 && unit) dots++;
      else if (/[0-9=]/.test(ch)) words += ch;
    }
  }
  const numMatch = /(\d{2,3})/.exec(words);
  const shownNumber = !!numMatch;
  const bpm = numMatch ? +numMatch[1] : value > 0 ? value : 0;
  const text = words.replace(/[=()\[\]]/g, ' ').replace(/\b\d{2,3}\b/g, '').replace(/[♩♪]/g, '').replace(/\s+/g, ' ').trim().replace(/[\s,–-]+$/, '').replace(/^[\s,–-]+/, '');
  const hadGlyph = !!unit;
  if (!unit) { const d = eduToDur(beatEdu) || { base: 'quarter', dots: 0 }; unit = d.base; dots = d.dots; }
  if (!bpm && !text) return null;
  return { bpm: bpm || 120, beatUnit: unit, dots, text, showBpm: shownNumber || (hadGlyph && bpm > 0) };
}

/** Event in staff gi of measure mi at (or nearest to) tick. */
function eventAt(score, mi, gi, tick, voice = 0, nearestBefore = false) {
  const sm = score.measures[mi]?.staves[gi]; if (!sm) return null;
  const v = sm.voices[voice] && sm.voices[voice].length ? sm.voices[voice] : sm.voices[0];
  if (!v || !v.length) return null;
  let t = 0, best = null, bestD = Infinity;
  for (const ev of v) {
    if (ev.grace) continue;
    const d = Math.abs(t - tick);
    if (nearestBefore ? (t <= tick + 1 && d < bestD) : d < bestD) { best = ev; bestD = d; }
    t += durTicks(ev);
  }
  return best || v[0];
}

function buildVoice(lv, c) {
  const { key, sInfo, tupletDefs, articAssigns, articDefs, lyricData, lyricTexts, verseNumber, warn, mi, entryToEvent, gIndex, voiceIndex, hasLyricsOnStaff } = c;
  const voice = [];
  let tuplet = null;          // { id, num, den, remainingEdu }
  const beamState = [];       // per event: true when Finale's "beam" flag (start new beam) is set
  for (const { en, start } of lv.items) {
    if (has(en, 'dummy')) continue;          // Finale placeholder (e.g. hidden whole rest), takes no time
    // gaps (frame start time, voice-2 launch points) become rests (hidden outside voice 1)
    const at = toTicks(start), have = voiceTicks(voice);
    if (at > have + 1) for (const d of ticksToDurations(at - have)) { const r = makeRest(d.base, d.dots); if (voiceIndex > 0) r.hidden = true; voice.push(r); beamState.push(true); }
    const flags = new Set(en.children.filter(ch => !ch.children.length && !ch.text.trim()).map(ch => ch.tag));
    const edu = int(en, 'dura', 1024);
    const isNote = flags.has('isNote');
    const notes = kids(en, 'note');
    let dur = eduToDur(edu);
    if (!dur) { dur = nearestDur(edu); warn('일부 음표 길이를 가장 가까운 값으로 맞췄습니다'); }
    const ev = isNote && notes.length
      ? { id: newId(), kind: 'note', dur, notes: notes.map(n => {
        const p = pitchFromHarm(int(n, 'harmLev', 0), int(n, 'harmAlt', 0), key);
        const note = { step: p.step, octave: p.octave, alter: p.alter };
        if (has(n, 'tieStart')) note.tieStart = true;
        if (has(n, 'tieEnd')) note.tieEnd = true;
        if (has(n, 'showAcci') && has(n, 'freezeAcci')) note.accidental = { '-2': 'double-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }[p.alter] || undefined;
        if (!note.accidental) delete note.accidental;
        return note;
      }) }
      : { id: newId(), kind: 'rest', dur };
    if (flags.has('graceNote')) { ev.grace = { slash: flags.has('slashGrace') }; }
    if (flags.has('freezeStem') && ev.kind === 'note') ev.stem = flags.has('upStem') ? 'up' : 'down';
    if (flags.has('ignore')) ev.hidden = true;
    // tuplets (the definition is attached to the first entry)
    const tds = tupletDefs.get(en.attrs.entnum);
    if (tds && tds.length && !ev.grace) {
      const td = tds[0];
      const sNum = int(td, 'symbolicNum', 3), sDur = int(td, 'symbolicDur', 512), rNum = int(td, 'refNum', 2), rDur = int(td, 'refDur', 512);
      const nominal = sNum * sDur, actual = rNum * rDur;
      if (nominal > 0 && actual > 0 && nominal !== actual) {
        const g = gcd(nominal, actual);
        tuplet = { id: newId(), num: nominal / g, den: actual / g, remainingEdu: nominal };
        if (tuplet.num > 32 || tuplet.den > 32) { const g2 = gcd(sNum, rNum); tuplet.num = sNum / g2; tuplet.den = rNum / g2; }
      }
      if (tds.length > 1) warn('중첩 잇단음표는 바깥쪽만 가져왔습니다');
    }
    if (tuplet && !ev.grace) {
      ev.tuplet = { id: tuplet.id, num: tuplet.num, den: tuplet.den, bracket: true, show: 'number' };
      tuplet.remainingEdu -= edu;
      if (tuplet.remainingEdu <= 0) tuplet = null;
    }
    // articulations
    for (const aa of (articAssigns.get(en.attrs.entnum) || [])) {
      const def = articDefs.get(txt(aa, 'articDef')); if (!def) continue;
      const s = toSmufl(int(def, 'charMain', 0));
      const hit = ARTIC_BY_SMUFL[s]; if (!hit) continue;
      if (hit[0] === 'art') add(ev, 'articulations', hit[1]);
      else if (hit[0] === 'art2') { add(ev, 'articulations', hit[1]); add(ev, 'articulations', hit[2]); }
      else if (hit[0] === 'orn') add(ev, 'ornaments', hit[1]);
      else if (hit[0] === 'fermata') ev.fermata = hit[1];
      else if (hit[0] === 'trem') ev.tremolo = hit[1];
    }
    // lyrics
    for (const kind of ['verse', 'chorus', 'section']) {
      for (const ld of (lyricData[kind].get(en.attrs.entnum) || [])) {
        const num = int(ld, 'lyricNumber', 1), syll = int(ld, 'syll', 0);
        const list = lyricTexts[kind].get(num); if (!list || syll < 1 || syll > list.length) continue;
        const cur = list[syll - 1], prev = list[syll - 2];
        const begin = prev && prev.hyphenAfter, cont = cur.hyphenAfter;
        const syllabic = begin ? (cont ? 'middle' : 'end') : (cont ? 'begin' : 'single');
        const ly = { verse: verseNumber(kind, num), text: cur.text, syllabic };
        if (has(ld, 'wext')) ly.extend = true;
        (ev.lyrics || (ev.lyrics = [])).push(ly);
        hasLyricsOnStaff.add(gIndex);
      }
    }
    if (ev.lyrics) ev.lyrics.sort((a, b) => a.verse - b.verse);
    beamState.push(flags.has('beam'));
    voice.push(ev);
    entryToEvent.set(+en.attrs.entnum, { ev, gIndex, mi, voiceIndex });
  }
  // Finale beaming: an entry continues the previous beam unless it has the "beam" (break) flag.
  const beamable = (ev) => ev.kind === 'note' && !ev.grace && DUR_TICKS[ev.dur.base] <= DUR_TICKS.eighth;
  let group = [];
  const flushBeam = () => {
    if (group.length > 1) group.forEach((ev, k) => { ev.beam = k === 0 ? 'begin' : k === group.length - 1 ? 'end' : 'continue'; });
    else if (group.length === 1) group[0].beam = 'none';
    group = [];
  };
  voice.forEach((ev, i) => {
    if (ev.grace) return;
    if (!beamable(ev)) { flushBeam(); return; }
    if (beamState[i] || !group.length) flushBeam();
    group.push(ev);
  });
  flushBeam();
  void sInfo; void mi;
  return voice;
}
function add(ev, field, v) { const a = ev[field] || (ev[field] = []); if (!a.includes(v)) a.push(v); }
