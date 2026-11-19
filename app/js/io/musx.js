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
  ticksToDurations, makeRest, validateScore, midiOf, INSTRUMENTS, DEFAULT_DRUM_MAP, staffPosition, noteAtStaffPosition,
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
  235: 0xE531, 236: 0xE530, 246: 0xE5E5, 247: 0xE614, 248: 0xE4B2, 249: 0xE4B0, 103: 0xEAA9,
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
  // the dynamics JSE knows (as the MusicXML importer): kept as they are
  const KNOWN = ['pppppp', 'ppppp', 'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'fffff', 'ffffff', 'sf', 'sfz', 'sffz', 'sfp', 'sfpp', 'sfzp', 'fp', 'pf', 'fz', 'rf', 'rfz'];
  return KNOWN.includes(letters) ? letters : null;
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

// Finale's percussion note types (its PercNoteTypes.txt, as tabulated by musxdom): `type:gm` gives a type's General
// MIDI key, `type>parent` a type that sounds like its parent type (e.g. "Snare Rim Shot" → "Snare Drum").
const PERC_TYPES =
  '1:38 2:36 3:37 4:49 5:57 6:56 7:54 8:80 9:81 10:76 11:77 12:58 13:35 14:46 15:42 16:44 17:52 18:51 19:59 20:53 21:55 22:39 23:40 24:50 25:48 26:47 ' +
  '27:45 28:43 29:41 30:67 31:68 32:60 33:61 34:69 35:75 36:63 37:62 38:64 39:78 40:79 41:74 42:73 43:70 44:65 45:66 46:72 47:71 48>6 49>6 50>6 51>6 ' +
  '52>48 53>49 54>50 55>6 56>48 57>49 58>50 59:82 62>59 63>59 65>63 66>7 67>7 68>10 69>11 70:84 71>41 72>43 73>251 74:83 75>30 76:28 77>13 78>3 79>3 ' +
  '80>13 81>13 82>13 83>77 84>78 85>79 86>80 87>81 88>4 89>88 90>4 91>90 92>90 93>88 94>88 95>88 96>93 97>94 98>95 99>93 100>94 101>95 102>4 103>4 ' +
  '104>103 105>4 106>105 107>105 108>106 109>18 110>4 111>18 112>14 113>14 114>15 115>14 116>15 117>15 118>90 119>105 120>106 121>18 122>18 123>88 124>88 ' +
  '125>18 126>17 127>93 128>95 129>96 130>98 131>99 132>101 133>107 134>108 135>136 136>17 137>136 138>136 139>127 140>128 141>127 142>136 143>136 ' +
  '144>136 145>136 146>136 147>136 148>136 149>136 150>18 151>18 152>149 153>103 154>103 155>104 156>129 157>131 158>130 159>132 160>149 161>149 162>149 ' +
  '163>149 164>4 165>88 166>164 167>106 168>106 169>106 170>164 171>164 172>164 173>88 174>164 175>164 176>164 177>164 178>164 179>106 180>164 181>88 ' +
  '182>164 183>164 184>164 185>165 186>166 187>167 188>168 189>169 190>170 191>171 192>172 193>173 194>15 195>174 196>175 197>176 198>177 199>121 200>178 ' +
  '201>179 202>180 203>181 204>182 205>183 206>18 207>206 208>206 209>206 210>206 211>137 212>24 213>25 214>26 215>27 216>18 218>2 219>13 220>4 222>59 ' +
  '223>27 224>46 225>47 226>46 227>88 229>96 230>3 231>88 234>22 236>1 237:93 238>1 239>277 240>1 241>1 242>1 243>1 244>1 245>1 246>3 247>259 248>1 249>3 ' +
  '250>3 251>1 252>1 253>1 254:91 255>1 256:31 257>1 258>1 259>277 260>240 261>3 262>241 263>242 264>243 265>244 266>247 267>248 268>249 269>250 270>268 ' +
  '271>252 272>253 273>254 274>255 275>256 276>14 277>1 278>277 279>1 280>236 281>1 282>1 283>24 284>289 285>24 286>24 287>24 288>24 289>24 290>284 ' +
  '291>25 292>297 293>25 294>25 295>25 296>25 297>25 298>292 299>26 300>305 301>26 302>26 303>26 304>26 305>26 306>300 307>27 308>313 309>27 310>27 ' +
  '311>27 312>27 313>27 314>308 317>275 318>26 319>27 320>24 321>25 322>26 323>25 324>25 325>330 326>25 327>25 328>25 329>25 330>289 331>325 332>30 ' +
  '333>31 334>24 335>287 336>24 337>25 338>295 339>25 340>27 341>311 342>27 343>37 344>36 345>12 346>30 347>30 348>31 349>31 350>32 351>32 352>33 353>33 ' +
  '355>34 356>34 357>34 358>34 359>2 360>359 361>359 362:85 363>362 364>362 365>362 366>6 367>48 368>36 369>36 370>36 371>370 372>370 373>370 374>36 ' +
  '375>374 376>374 377>374 378>38 379>38 380>38 381>38 385>39 386>27 387>389 388>311 389>27 390>389 391>311 392>24 393>24 394>25 395>26 396>287 397>34 ' +
  '398>41 399>41 400>41 401>41 402>36 403>38 404>43 405>43 406>392 407>394 408>396 409>43 410>34 411>34 412>34 413>34 414>34 415:87 416:86 417>36 418>37 ' +
  '419>36 420>38 421>369 422>24 423>287 424>25 425>295 426>26 427>303 428>27 429>311 430>28 431>311 432>39 433>40 434>7 435>7 436>7 437>7 438>7 439>7 ' +
  '440>36 441>38 442>44 443>44 444>44 445>30 446>30 447>37 448>36 449>38 450>37 451>46 452>7 454>22 455>59 456>30 457>31 458>277 459>11 460>7 461:32 ' +
  '462:34 463:29 464:30 465>44 466>45 467>44 468>44 469>45 470>366 471>41 472>41 473>41 474>81 475>78 476>44 477>468 478>467 479>442 480>444 481>7 482>7 ' +
  '483>7 484>7 489>66 490>44 491>468 492>467 493>442 494>44 495>468 496>44 497>468 498>389 499>390 500>359 501>359 502>359 503>32 504>30 505>31 506>333 ' +
  '507>332 508>34 509>34 510>34 511>7 512>1 513>1 514>1 516>231 517>231 518>459 519>459 520>459 521>459 3968:0 3969:1 3970:2 3971:3 3972:4 3973:5 3974:6 ' +
  '3975:7 3976:8 3977:9 3978:10 3979:11 3980:12 3981:13 3982:14 3983:15 3984:16 3985:17 3986:18 3987:19 3988:20 3989:21 3990:22 3991:23 3992:24 3993:25 ' +
  '3994:26 3995:27 3996>76 3997>463 3998>464 3999>256 4000>461 4001:33 4002>462 4003>59 4004>74 4005>70 4006>362 4007>416 4008>415 4009:88 4010:89 ' +
  '4011:90 4012>254 4013:92 4014>237 4015:94 4016:95 4017:96 4018:97 4019:98 4020:99 4021:100 4022:101 4023:102 4024:103 4025:104 4026:105 4027:106 ' +
  '4028:107 4029:108 4030:109 4031:110 4032:111 4033:112 4034:113 4035:114 4036:115 4037:116 4038:117 4039:118 4040:119 4041:120 4042:121 4043:122 ' +
  '4044:123 4045:124 4046:125 4047:126 4048:127 ';
let percTables = null;
function percTables_() {
  if (percTables) return percTables;
  const own = new Map(), parent = new Map();
  for (const w of PERC_TYPES.trim().split(/\s+/)) {
    const m = /^(\d+)([:>])(\d+)$/.exec(w); if (!m) continue;
    (m[2] === ':' ? own : parent).set(+m[1], +m[3]);
  }
  const byGm = new Map();
  for (const [t, gm] of own) if (t < 3968 && !byGm.has(gm)) byGm.set(gm, t);   // 3968… are Finale's "Custom n" types
  return (percTables = { own, parent, byGm });
}
/** General MIDI key of a Finale percussion note type (the order bits above 0xfff are ignored); -1 when it has none. */
export function percTypeGm(type) {
  const { own, parent } = percTables_();
  let t = type & 0xfff;
  for (let i = 0; i < 8; i++) { if (own.has(t)) return own.get(t); if (!parent.has(t)) break; t = parent.get(t); }
  return -1;
}
/** Finale's percussion note type for a General MIDI key (0 when there is none). */
export function percTypeForGm(gm) { return percTables_().byGm.get(gm) || 0; }
// noteheads of percussion layouts (closed notehead: Maestro Percussion or SMuFL) → JSE notehead
const PERC_HEAD_OF = { 207: 'normal', 120: 'x', 121: 'x', 88: 'circle-x', 89: 'circle-x', 49: 'triangle-black', 33: 'triangle', 51: 'diamond-black', 35: 'diamond',
  41: 'square', 48: 'square', 54: 'square', 43: 'plus', 47: 'slash', 63: 'slash',
  0xE0A4: 'normal', 0xE0A9: 'x', 0xE0B3: 'circle-x', 0xE0BE: 'triangle-black', 0xE0BD: 'triangle', 0xE0DB: 'diamond-black', 0xE0DD: 'diamond',
  0xE0B8: 'square', 0xE0B9: 'square', 0xE0AF: 'plus', 0xE100: 'slash', 0xE101: 'slash' };
// notehead characters of a note (Maestro, or SMuFL in SMuFL fonts) → JSE notehead
const NOTEHEAD_OF = { 192: 'x', 0xE0A9: 'x', 0xE0A8: 'x', 0xE0B3: 'circle-x', 225: 'diamond', 0xE0DD: 'diamond', 226: 'diamond-black', 0xE0DB: 'diamond-black',
  121: 'triangle', 0xE0BD: 'triangle', 209: 'triangle-black', 0xE0BE: 'triangle-black', 173: 'square', 194: 'square', 208: 'square', 0xE0B8: 'square', 0xE0B9: 'square',
  243: 'slash', 203: 'slash', 218: 'slash', 0xE100: 'slash', 0xE101: 'slash', 0xE102: 'slash', 132: 'plus', 0xE0AF: 'plus' };
// General MIDI percussion, keys 35…81
const GM_DRUM_NAMES = ('어쿠스틱 베이스 드럼,베이스 드럼,사이드 스틱,스네어,핸드 클랩,일렉트릭 스네어,로우 플로어 탐,클로즈드 하이햇,하이 플로어 탐,' +
  '페달 하이햇,로우 탐,오픈 하이햇,로우미드 탐,하이미드 탐,크래시 심벌,하이 탐,라이드 심벌,차이나 심벌,라이드 벨,탬버린,스플래시 심벌,카우벨,' +
  '크래시 심벌 2,비브라슬랩,라이드 심벌 2,하이 봉고,로우 봉고,뮤트 하이 콩가,오픈 하이 콩가,로우 콩가,하이 팀발레스,로우 팀발레스,하이 아고고,' +
  '로우 아고고,카바사,마라카스,짧은 휘슬,긴 휘슬,짧은 귀로,긴 귀로,클라베스,하이 우드블록,로우 우드블록,뮤트 쿠이카,오픈 쿠이카,뮤트 트라이앵글,' +
  '오픈 트라이앵글').split(',');

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
  0xE220: ['trem', 1], 0xE221: ['trem', 2], 0xE222: ['trem', 3], 0xEAA9: ['arpeggio'],
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
  const fretInsts = doc.index('fretInst');
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
      if (s.type === 'tab') {
        st.tuning = st.lines === 4 ? ['E1', 'A1', 'D2', 'G2'] : ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
        const fi = kid(s.spec, 'fretInstID') ? fretInsts.get(txt(s.spec, 'fretInstID')) : null;
        const pitches = fi ? kids(fi, 'string').map(x => int(x, 'pitch', 0)).filter(x => x > 0) : [];
        if (pitches.length >= 3 && pitches.length <= 12) {
          const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
          st.tuning = pitches.slice().reverse().map(m => NAMES[m % 12] + (Math.floor(m / 12) - 1));
          st.lines = pitches.length;
        }
      }
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
        part._keyAdjust = adjust;
      }
    } else if (tr && kid(tr, 'chromatic')) {
      const ch = kid(tr, 'chromatic'); const diatonic = int(ch, 'diatonic', 0), alteration = int(ch, 'alteration', 0);
      if (diatonic || alteration) warn('반음 단위 이조 악기는 근사치로 가져왔습니다');
    }
    staves.forEach((s, k) => { staffIndex.set(s.id, gIndex); staffInfo.set(s.id, { ...s, part, staff: part.staves[k], gIndex }); gIndex++; });
    parts.push(part);
  }
  const nStaves = gIndex;
  const stdParts = [...staffInfo.values()].filter(s => s.staff.type === 'standard').map(s => s.part);
  const refPart = stdParts.find(p => !p._keyAdjust) || stdParts[0];
  const refAdjust = refPart ? refPart._keyAdjust || 0 : 0;
  for (const p of parts) delete p._keyAdjust;
  const shownKey = (k) => { if (!refAdjust || k.keyless) return k; let f = k.fifths + refAdjust; while (f > 7) f -= 12; while (f < -7) f += 12; return { ...k, fifths: f }; };

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

  const keys = []; const caps = [];
  let prevKey = null, prevTs = null;
  for (let m = 1; m <= measCount; m++) {
    const ms = measSpecs.get(String(m));
    const measure = createMeasure({ parts });
    measure.staves = Array.from({ length: nStaves }, () => ({ voices: [[]] }));
    const key = ms ? (kid(ms, 'keySig') ? decodeKey(kid(ms, 'keySig')) : { fifths: 0, mode: 'major' }) : (prevKey || { fifths: 0, mode: 'major' });
    const beats = ms ? int(ms, 'beats', 4) : (prevTs ? prevTs.beats : 4);
    const divbeat = ms ? int(ms, 'divbeat', 1024) : (prevTs ? prevTs.divbeat : 1024);
    const actual = timeSigFrom(beats, divbeat, ms && (has(ms, 'altNumTsig') || has(ms, 'compositeNumerator')) ? compositeOf(beats) : null);
    let shown = actual;
    if (ms && has(ms, 'useDisplayTimesig')) {
      const db = int(ms, 'dispBeats', beats), dd = int(ms, 'dispDivbeat', divbeat);
      shown = timeSigFrom(db, dd, has(ms, 'displayAltNumTsig') || has(ms, 'displayCompositeNumerator') ? compositeOf(db) : null);
      if (actual.capacityEdu > shown.capacityEdu) shown = actual;   // unmetered / long measures: keep the real length
    }
    let display = 'normal';
    if (ms && has(ms, 'abbrvTime')) { if (shown.num === 4 && shown.den === 4) display = 'common'; else if (shown.num === 2 && shown.den === 2) display = 'cut'; }
    const tsKey = `${shown.num}/${shown.den}/${display}`;
    if (!prevTs || prevTs.key !== tsKey) measure.timeSig = { num: shown.num, den: shown.den, display };
    if (actual.capacityEdu < shown.capacityEdu) measure.pickup = true;
    if (!prevKey || prevKey.fifths !== key.fifths || prevKey.mode !== key.mode) measure.keySig = { fifths: shownKey(key).fifths, mode: key.mode };
    if (ms) {
      const bl = txt(ms, 'barline');
      const BL = { double: 'double', final: 'final', dash: 'dashed', dashed: 'dashed', none: 'none', thick: 'final', tick: 'single', normal: null, custom: null };
      if (bl && BL[bl]) measure.barlineRight = BL[bl];
      // no <barline> at all is Finale's "none": no barline (worksheets); Finale writes "normal" for a normal one
      else if (bl == null && isScoreLevel(ms)) measure.barlineRight = 'none';
      if (has(ms, 'forRepBar')) measure.barlineLeft = 'repeat-start';
      if (has(ms, 'bacRepBar')) measure.barlineRight = 'repeat-end';
    }
    keys.push(key); caps.push(actual.capacityEdu);
    prevKey = key; prevTs = { beats, divbeat, key: tsKey };
    // "begin a new page" on this measure: a page break after the one before
    if (ms && has(ms, 'pageBreak') && score.measures.length) { const pm = score.measures[score.measures.length - 1]; pm.breaks = { ...(pm.breaks || {}), page: true }; }
    score.measures.push(measure);
  }
  if (!score.measures[0].timeSig) score.measures[0].timeSig = { num: 4, den: 4, display: 'normal' };
  if (!score.measures[0].keySig) score.measures[0].keySig = { fifths: 0, mode: 'major' };
  // a measure shorter than the time signature it shows (an upbeat, or an irregular bar later on, e.g. before a
  // repeat) is a pickup measure in JSE too: it keeps the time signature and shows no change of meter
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
  const repeatDefs = doc.index('textRepeatDef');
  for (const t of doc.other('textRepeatText')) {
    const def = repeatDefs.get(t.attrs.cmper);
    const raw = txt(t, 'rptText') || '';
    // a text repeat drawn in the music font (Finale's own Segno "%" and Coda "Þ") is a symbol, not letters
    repeatTexts.set(t.attrs.cmper, def && ctx.isMusicFontId(int(def, 'fontID', 0)) && !/\^/.test(raw) ? runsToPlain([{ text: raw, music: true }]) : plainText(raw));
  }
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
  const tabAlters = doc.group('tabAlter', 'entnum', true);
  // entries a smart shape is attached to (kept even when they are hidden rests of an otherwise empty voice)
  const anchoredEntries = new Set();
  for (const ss of doc.other('smartShape')) for (const seg of ['startTermSeg', 'endTermSeg']) { const ep = kid(kid(ss, seg), 'endPt'); const en = ep ? int(ep, 'entryNum', 0) : 0; if (en) anchoredEntries.add(en); }
  const anchoredEvents = { has: (ev) => { for (const en of anchoredEntries) if (entryToEvent.get(en)?.ev === ev) return true; return false; } };
  // percussion: the staff's percussion layout ("drum library") gives each note's instrument (note type) and its line
  const percCodes = doc.group('percussionNoteCode', 'entnum', true);
  const noteAlters = doc.group('noteAlter', 'entnum', true);   // per-note notehead characters
  const drumLibOf = new Map(doc.other('drumStaff').filter(isScoreLevel).map(d => [d.attrs.cmper, int(d, 'whichDrumLib', 0)]));
  const percLayouts = doc.group('percussionNoteInfo');
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
          if (has(en, 'v2') || has(en, 'voice2')) { v2.push({ en, start: tV2 }); tV2 += actual(en, tupV2); }
          else { if (has(en, 'controller') || has(en, 'v2Launch')) { launchAt = tMain; tV2 = launchAt; } main.push({ en, start: tMain }); tMain += actual(en, tupMain); }
        }
        layerVoices.push({ layer, items: main });
        if (v2.length) layerVoices.push({ layer, items: v2, v2: true });
      }
      layerVoices.forEach((lv, vi) => {
        if (vi > 3) { warn('한 오선에 4개를 넘는 성부는 생략했습니다'); return; }
        const voice = buildVoice(lv, { doc, key, sInfo, part: sInfo.part, tupletDefs, articAssigns, articDefs, lyricData, lyricTexts, verseNumber, warn, mi, entryToEvent, gIndex: sInfo.gIndex, voiceIndex: vi, hasLyricsOnStaff, tabAlters: sInfo.staff.type === 'tab' ? tabAlters : null, percCodes: sInfo.staff.type === 'percussion' ? percCodes : null, noteAlters: sInfo.staff.type === 'tab' ? null : noteAlters });
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
      // a lower voice of hidden rests only goes — unless a line is attached to one of them
      for (let k = sm.voices.length - 1; k > 0; k--) if (!sm.voices[k] || !sm.voices[k].length || (sm.voices[k].every(e => e.kind === 'rest' && e.hidden) && !sm.voices[k].some(e => anchoredEvents.has(e)))) sm.voices.splice(k, 1);
      if (!sm.voices.length) sm.voices = [[]];
    }
  }

  // percussion: map positions to drum keys; tab: assign string/fret
  for (const [, sInfo] of staffInfo) {
    if (sInfo.staff.type === 'percussion') {
      // The staff's percussion layout ("drum library") says what each note is: its note type gives the instrument and
      // sound (General MIDI key), its line (Finale counts from middle C's position on a treble staff, JSE from the top
      // line) and noteheads. The layout becomes the staff's drum map; a drum of JSE's default kit keeps its key.
      const libId = drumLibOf.get(String(sInfo.id));
      const layout = new Map();
      if (libId != null) for (const pi of percLayouts.get(String(libId)) || []) {
        if (!isScoreLevel(pi)) continue;
        const type = int(pi, 'percNoteType', 0);
        if (type && !layout.has(type)) layout.set(type, { line: 10 - int(pi, 'harmLev', 0), head: PERC_HEAD_OF[int(pi, 'closedNotehead', 0)] || 'normal', gm: percTypeGm(type) });
      }
      const keyOf = new Map();
      if (layout.size) {
        const dm = {}, names = new Map();
        for (const [type, L] of layout) {
          const def = L.gm >= 0 && percTypeForGm(L.gm) === type ? Object.entries(sInfo.staff.drumMap).find(([k, d]) => d.midi === L.gm && !dm[k]) : null;
          const key = def ? def[0] : `finale-${type}`;
          let name = def ? def[1].name : (GM_DRUM_NAMES[L.gm - 35] || `타악기 ${type & 0xfff}`);
          const seen = names.get(name) || 0; names.set(name, seen + 1); if (seen) name += ` ${seen + 1}`;
          dm[key] = { line: sInfo.staff.lines === 1 ? 4 : L.line, head: L.head, midi: L.gm >= 0 ? L.gm : 38, name };
          keyOf.set(type, key);
        }
        sInfo.staff.drumMap = dm;
      }
      for (const m of score.measures) for (const v of m.staves[sInfo.gIndex].voices) for (const ev of v) for (const n of (ev.notes || [])) {
        const code = n._percCode; delete n._percCode;
        n.alter = 0;
        if (code != null && keyOf.has(code)) { n.drum = keyOf.get(code); Object.assign(n, noteAtStaffPosition(sInfo.staff.drumMap[n.drum].line, 'treble')); continue; }
        // with a layout, a note without a note type is none of its instruments (Finale draws it at its pitch): no drum
        if (layout.size) continue;
        // no layout: the drum of JSE's kit on the note's line
        const line = staffPosition(n, 'treble');
        const entries = Object.entries(sInfo.staff.drumMap);
        const hit = entries.find(([, d]) => d.line === line && d.head === 'normal') || entries.find(([, d]) => d.line === line) || entries.sort((a, b) => Math.abs(a[1].line - line) - Math.abs(b[1].line - line))[0];
        if (hit) n.drum = hit[0];
      }
    } else if (sInfo.staff.type === 'tab') {
      const tuning = sInfo.staff.tuning.map(t => { const m = /^([A-G])(#|b)?(-?\d+)$/.exec(t) || ['', 'E', '', '2']; return midiOf({ step: m[1], octave: +m[3], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 }); });
      for (const m of score.measures) for (const v of m.staves[sInfo.gIndex].voices) for (const ev of v) {
        const usedStrings = new Set();
        for (const n of [...(ev.notes || [])].sort((a, b) => midiOf(b) - midiOf(a))) {
          const midi = midiOf(n); let best = null;
          // the string Finale's TAB data names (tabAlter), when it fits
          if (n._tabString >= 1 && n._tabString <= tuning.length) { const fret = midi - tuning[tuning.length - n._tabString]; if (fret >= 0 && fret <= 24 && !usedStrings.has(n._tabString)) best = { string: n._tabString, fret }; }
          delete n._tabString;
          if (!best) for (let s = tuning.length - 1; s >= 0; s--) { const fret = midi - tuning[s]; const stringNo = tuning.length - s; if (fret >= 0 && fret <= 24 && !usedStrings.has(stringNo)) { best = { string: stringNo, fret }; break; } }
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
  const chordStaff = new Map();
  for (const ca of doc.detail('chordAssign')) {
    const fid = +ca.attrs.cmper1, mi = +ca.attrs.cmper2 - 1;
    const m = score.measures[mi]; if (!m || !staffInfo.has(fid)) continue;
    if (!has(ca, 'showRoot') && !has(ca, 'showSuffix')) continue;
    // a chord is a scale degree of the key: named in the key the score shows (the written key of a transposing-only score)
    const key = shownKey(keys[mi]);
    const root = chordRootName(int(ca, 'rootScaleNum', 0), int(ca, 'rootAlter', 0), key, has(ca, 'rootLowerCase'));
    const kind = has(ca, 'showSuffix') && kid(ca, 'suffix') ? suffixText(int(ca, 'suffix')) : '';
    const bass = has(ca, 'showAltBass') ? chordRootName(int(ca, 'bassScaleNum', 0), int(ca, 'bassAlter', 0), key, has(ca, 'bassLowerCase')) : '';
    const tick = toTicks(int(ca, 'horzEdu', 0));
    const chord = { id: newId(), tick, text: root + kind + (bass ? '/' + bass : ''), root };
    if (kind) chord.kind = kind;
    if (bass) chord.bass = bass;
    const arr = m.chords || (m.chords = []);
    // the same chord on several staves is one chord symbol; on one staff, chords at one position all stay
    if (!arr.some(c => c.tick === tick && (c.text === chord.text || chordStaff.get(c) !== fid))) { arr.push(chord); chordStaff.set(chord, fid); }
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
    // textIDKey names a textBlock whose textID is the expression text (often, but not always, the same number)
    const key = int(def, 'textIDKey');
    const tblk = textBlocks.get(String(key));
    const tid = tblk && (txt(tblk, 'textTag') || 'expression') === 'expression' ? int(tblk, 'textID', key) : key;
    const raw = doc.text('expression', tid) ?? doc.text('expression', key); if (raw == null) continue;
    const catId = int(def, 'categoryID', 0);
    const cat = catTypes.get(catId) || catDefault[catId] || 'misc';
    const value = int(def, 'value', 0);
    const runs = enigmaRuns(raw, ctx, { value: value || '' });
    const plain = runsToPlain(runs).replace(/\s*\n\s*/g, ' ').trim();
    const fid = int(ea, 'staffAssign', 0);
    const staffG = staffInfo.has(fid) ? staffInfo.get(fid).gIndex : 0;
    const tick = toTicks(int(ea, 'horzEduOff', 0));
    const layer = Math.max(1, int(ea, 'layer', 1));
    const vAlign = txt(def, 'vertMeasExprAlign') || '';
    const placement = /below/i.test(vAlign) ? 'below' : /above/i.test(vAlign) ? 'above' : (cat === 'dynamics' ? 'below' : 'above');
    // tempo words / metronome marks filed under another category still set the tempo
    const looksTempo = /[\u2669\u266A]\s*=|^\s*(Grave|Largo|Larghetto|Lento|Adagio|Adagietto|Andante|Andantino|Moderato|Allegretto|Allegro|Vivace|Vivo|Presto|Prestissimo|Tempo di|Tempo I)\b/i.test(plain);
    if (cat === 'tempoMarks' || txt(def, 'playType') === 'time' || (looksTempo && cat !== 'tempoAlts')) {
      const tempo = tempoFromRuns(runs, value, int(def, 'auxdata1', 1024));
      if (tempo && !m.tempo) { m.tempo = tempo; continue; }
      if (tempo && m.tempo) {
        // the same tempo mark is often assigned to several staves (band/orchestra scores) — show it once
        if ((m.tempo.text || '') === (tempo.text || '') && (!tempo.showBpm || m.tempo.bpm === tempo.bpm)) continue;
        // "Allegro" + a separate "♩ = 132" → one marking
        if (!m.tempo.showBpm && tempo.showBpm && !tempo.text) { Object.assign(m.tempo, { bpm: tempo.bpm, beatUnit: tempo.beatUnit, dots: tempo.dots, showBpm: true }); continue; }
        if (m.tempo.showBpm && !m.tempo.text && tempo.text && !tempo.showBpm) { m.tempo.text = tempo.text; continue; }
      }
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
    // expressions assigned to one staff stay with that staff (e.g. "S.D." on the percussion staff, "div." on a wind part)
    const staffSpecific = fid > 0 && staffInfo.has(fid) && !looksTempo && cat !== 'rehearsalMarks';
    if (ev && (tick > 0 || staffSpecific)) { const et = ev.texts || (ev.texts = []); if (!et.some(t => t.text === plain)) et.push({ text: plain, placement, style }); }
    else {
      const arr = m.texts || (m.texts = []);
      const mk = markerFromText(plain);
      if (mk) (m.markers || (m.markers = [])).includes(mk) || m.markers.push(mk);
      // one expression assigned to many staves appears once; one assigned to a lower staff only stays with that staff
      else {
        const si = staffSpecific ? staffG : 0;
        if (!arr.some(t => t.text === plain && (!si || (t.staffIndex || 0) === si)) && (m.tempo?.text || '') !== plain) arr.push({ text: plain, placement, style: style === 'plain' ? 'plain' : style, ...(si ? { staffIndex: si } : {}) });
      }
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
  const lineStyles = doc.index('ssLineStyle');
  const lineStyleText = (id) => {
    const ls = lineStyles.get(String(id)); if (!ls) return { text: '', pedal: false };
    const raw = kid(ls, 'leftStartRawTextID') ? doc.text('smartShapeText', int(ls, 'leftStartRawTextID')) : null;
    if (raw == null) return { text: '', pedal: false };
    const runs = enigmaRuns(raw, ctx);
    const pedal = runs.some(r => r.music && [...r.text].some(ch => toSmufl(ch.codePointAt(0)) === 0xE650)) || /^\s*ped\.?\s*$/i.test(runsToPlain(runs));
    return { text: pedal ? '' : runsToPlain(runs), pedal };
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
    else if (type === 'smartLine' && lineStyleText(int(ss, 'lineStyleID', 0)).pedal) sp.type = 'pedal';
    else if (/line|bracket/i.test(type)) { sp.type = 'textLine'; sp.text = type === 'smartLine' ? lineStyleText(int(ss, 'lineStyleID', 0)).text : ''; }
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
  // normalizeImported() empties voices that hold nothing but a whole-measure rest: keep the rests a line starts or ends on
  // (as the MuseScore importer does), else the line would point at a rest that is gone
  const anchors = new Set();
  for (const sp of score.spanners) if (sp.type !== 'volta') { anchors.add(sp.from?.eventId); anchors.add(sp.to?.eventId); }
  const keep = [];
  for (const m of score.measures) for (const sm of m.staves) { const v = sm.voices[0]; if (v && v.length === 1 && v[0].fullMeasureRest && anchors.has(v[0].id)) keep.push([sm, v[0]]); }
  normalizeImported(score);
  for (const [sm, ev] of keep) if (!sm.voices[0].length) sm.voices[0] = [ev];
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
    // inside a syllable: '_' and a no-break space are spaces, a no-break hyphen is a hyphen, a fullwidth low line '_'
    else buf += ch === '_' || ch === '\u00a0' ? ' ' : ch === '\u2011' ? '-' : ch === '\uff3f' ? '_' : ch;
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
      else if ((s === 0xE1E7 || (ch === 'd' && !s)) && unit) dots++;
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
        const ta = (c.tabAlters?.get(en.attrs.entnum) || []).find(t => int(t, 'noteID', 0) === +(n.attrs.id || 0));
        if (ta) note._tabString = int(ta, 'stringNumber', 0);
        const pc = (c.percCodes?.get(en.attrs.entnum) || []).find(t => int(t, 'noteID', 0) === +(n.attrs.id || 0));
        if (pc) note._percCode = int(pc, 'noteCode', 0);
        const na = (c.noteAlters?.get(en.attrs.entnum) || []).find(t => isScoreLevel(t) && int(t, 'noteID', 0) === +(n.attrs.id || 0));
        const head = na && NOTEHEAD_OF[int(na, 'altNhead', 0)];
        if (head) note.head = head;
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
        if (sDur === rDur && sNum > 0 && rNum > 0 && sNum <= 32 && rNum <= 32) { tuplet.num = sNum; tuplet.den = rNum; }
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
      // (a fermata placed by hand: above or below the entry, whatever the glyph)
      else if (hit[0] === 'fermata') ev.fermata = has(aa, 'overridePlacement') ? (has(aa, 'aboveEntry') ? 'above' : 'below') : hit[1];
      else if (hit[0] === 'trem') ev.tremolo = hit[1];
      else if (hit[0] === 'arpeggio') ev.arpeggio = true;
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
  // Finale beaming: an entry continues the previous beam unless it has the "beam" (break) flag. A short rest without
  // the flag sits inside the beam when there are notes of the group on both sides of it (as musxdom reads it).
  const short = (ev) => !ev.grace && DUR_TICKS[ev.dur.base] <= DUR_TICKS.eighth;
  let group = [];
  const flushBeam = () => {
    while (group.length && group[0].kind === 'rest') group.shift();
    while (group.length && group[group.length - 1].kind === 'rest') group.pop();
    if (group.length > 1) group.forEach((ev, k) => { ev.beam = k === 0 ? 'begin' : k === group.length - 1 ? 'end' : 'continue'; });
    else if (group.length === 1) group[0].beam = 'none';
    group = [];
  };
  voice.forEach((ev, i) => {
    if (ev.grace) return;
    if (!short(ev) || (ev.kind !== 'note' && ev.kind !== 'rest')) { flushBeam(); return; }
    if (beamState[i] || !group.length) flushBeam();
    group.push(ev);
  });
  flushBeam();
  void sInfo; void mi;
  return voice;
}
function add(ev, field, v) { const a = ev[field] || (ev[field] = []); if (!a.includes(v)) a.push(v); }
