#!/usr/bin/env node
// Real-music pages with exact ground truth for OMR training / evaluation.
//
// Pieces come from the Finale corpus (EnigmaXML, decoded and gzipped in
// /home/claude/enigma-cache): enigmaToScore → one single-staff part or one
// piano part (grand staff), excerpt from the first measure up to the first
// key / time / clef change, extra voices and grace notes dropped.  The app's
// engraver lays the excerpt out on an A4 page with random staff size, margins,
// gaps and line weights, in one of several music fonts (alternate glyph
// tables from tools/omr/smufl_glyphs.py swapped into the engraver's GLYPHS at
// run time — the shipped app is not touched).  Page 1 is rasterised (sharp /
// librsvg, 300 dpi) and the GT JSON is written in the gen_synthetic /
// gen_photo format (systems + staff-line polylines, measures with events,
// symbols parsed from the SVG <use> glyphs, barlines), so that
//   python3 tools/omr/gen_photo.py --pages <out> --split <split> ...
// turns the pages into photos.
//
// Pieces are split by folder (all parts of one piece land in the same split):
// FNV-1a(collection folder, ≤ 6 path components) % 5 === 0 → 'holdout', otherwise 'train'.
//
//   node tools/omr/gen_finale_pages.mjs --split holdout --count 60 --fonts leipzig,leland,bravura,freeserif --out /tmp/fin_holdout --seed 7
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { enigmaToScore } from '../../app/js/io/musx.js';
import { importMusicXML } from '../../app/js/io/musicxml.js';
import { engrave } from '../../app/js/engrave/render.js';
import { GLYPHS } from '../../app/js/engrave/glyphs.js';
import { SP } from '../../app/js/engrave/layout.js';
import { effectiveClef, effectiveKeySig, effectiveTimeSig, staffPosition } from '../../app/js/model/score.js';

const sharp = createRequire(import.meta.url)('/opt/npm-tools/node_modules/sharp');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SRC = opt('--src', '/home/claude/enigma-cache');
const OUT = opt('--out', '/tmp/fin_pages');
const SPLIT = opt('--split', 'train');
const COUNT = parseInt(opt('--count', '20'), 10);
const SEED = parseInt(opt('--seed', '1'), 10);
const FONTS = opt('--fonts', 'freeserif,bravura,petaluma,leland').split(',');
const FONT_DIR = opt('--font-dir', '/tmp/omr_fonts');
const DPI = parseFloat(opt('--dpi', '300'));
const PIANO_P = parseFloat(opt('--piano', '0.35'));
const PER_FOLDER = parseInt(opt('--per-folder', '3'), 10);   // pages per folder (parts of one piece / anthology)
// --glyph-mode: for classifier training only — random key / time signature and clef changes every few
// measures (many more header glyphs in every font); the music then no longer fits the meter, so these
// pages must not be used for end-to-end evaluation (gt.glyphMode = true).
const GLYPH_MODE = args.includes('--glyph-mode');
// --musicxml: --src is a folder of .musicxml files from an external corpus (round 4: When-in-Rome /
// OpenScore Lieder, never part of the Finale corpus), imported with the app's MusicXML reader;
// file names use '__' between path components like the Finale cache
const MUSICXML = args.includes('--musicxml');
// --keys FILE: only collections / files listed in FILE ({keys: [splitKey...], files: [name...]}, e.g. tools/omr/holdout3.json);
// --exclude FILE: never collections listed in FILE (training must exclude the frozen holdouts)
const keyList = (f, withRelated) => { if (!f) return null; const j = JSON.parse(fs.readFileSync(f, 'utf8')); return new Set([...(j.keys || []), ...(j.files || []), ...(withRelated ? j.related || [] : [])]); };
const ONLY_KEYS = keyList(opt('--keys', null), false), EXCLUDE_KEYS = keyList(opt('--exclude', null), true);
const listed = (set, f) => set.has(splitKey(f)) || set.has(f.replace(/\.musx\.xml\.gz$|\.xml\.gz$/, ''));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- utilities
let rs = SEED >>> 0 || 1;
const rand = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0; return rs / 4294967296; };
const U = (a, b) => a + (b - a) * rand();
const pick = (a) => a[Math.floor(rand() * a.length)];
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
const r2 = (v) => Math.round(v * 100) / 100;
const ALT = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' };
const pitchStr = (n) => n.step + ALT[n.alter || 0] + n.octave;

// ---------------------------------------------------------------- fonts
const BASE_GLYPHS = JSON.parse(JSON.stringify(GLYPHS));
const BASE_SP = { ...SP };
const fontTables = {};
for (const f of FONTS) fontTables[f] = f === 'freeserif' ? {} : JSON.parse(fs.readFileSync(path.join(FONT_DIR, f + '.json'), 'utf8'));
function useFont(name) {
  for (const k of Object.keys(GLYPHS)) GLYPHS[k] = BASE_GLYPHS[k];
  Object.assign(GLYPHS, fontTables[name]);
  Object.assign(SP, BASE_SP, { headBlack: GLYPHS.noteheadBlack.w, headHalf: GLYPHS.noteheadHalf.w, headWhole: GLYPHS.noteheadWhole.w, headBreve: GLYPHS.noteheadDoubleWhole.w });
}

// ---------------------------------------------------------------- selection
const OK_CLEFS = new Set(['treble', 'bass', 'alto']);
const comps = (f) => f.replace(/\.musx\.xml\.gz$|\.xml\.gz$|\.musicxml$/, '').split('__');
const pieceKey = (f) => comps(f).slice(0, -1).join('__') || f;                                   // folder (parts of one piece)
const splitKey = (f) => { const c = comps(f); return c.slice(0, Math.min(6, c.length - 1)).join('__'); };   // collection / piece
const splitOf = (f) => (fnv(splitKey(f)) % 5 === 0 ? 'holdout' : 'train');

function excerpt(score, rng) {
  const staffStart = []; let k = 0;
  for (const p of score.parts) { staffStart.push(k); k += p.staves.length; }
  const cands = [];
  score.parts.forEach((p, pi) => {
    if (p.staves.length > 2) return;
    if (!p.staves.every(s => (s.type || 'standard') === 'standard' && (s.lines || 5) === 5)) return;
    const s0 = staffStart[pi], n = p.staves.length;
    // segments between key / time / clef changes; the excerpt is the segment with most notes
    const cuts = [0];
    for (let mi = 1; mi < score.measures.length; mi++) {
      const m = score.measures[mi];
      if (m.timeSig || m.keySig || m.staves.slice(s0, s0 + n).some(sm => sm.clef)) cuts.push(mi);
    }
    cuts.push(score.measures.length);
    let best = null;
    for (let c = 0; c + 1 < cuts.length; c++) {
      const start = cuts[c], end = Math.min(cuts[c + 1], start + 120);
      if (end - start < 4) continue;
      const ts = effectiveTimeSig(score, start);
      if (!ts || ts.num > 12 || ![2, 4, 8].includes(ts.den)) continue;
      if (![...Array(n).keys()].every(i => OK_CLEFS.has(effectiveClef(score, start, s0 + i)))) continue;
      let notes = 0, extraVoices = 0, far = 0;
      for (let mi = start; mi < end; mi++) for (let si = s0; si < s0 + n; si++) {
        const sm = score.measures[mi].staves[si];
        if (!sm) continue;
        const clef = effectiveClef(score, mi, si);
        for (const ev of sm.voices[0] || []) if (ev.kind === 'note' && !ev.grace) {
          notes++;
          // more than 4 ledger lines: usually a part imported in the wrong clef / transposition
          if (ev.notes.some(nt => { const q = staffPosition(nt, clef); return q < -8 || q > 16; })) far++;
        }
        if (sm.voices.slice(1).some(v => v && v.length)) extraVoices++;
      }
      const len = end - start;
      if (notes < 24 || notes / (len * n) < 1.2 || extraVoices > 0.4 * len * n || far > 0.1 * notes) continue;
      if (!best || notes > best.notes) best = { pi, s0, n, start, end, notes };
    }
    if (best) cands.push(best);
  });
  if (!cands.length) return null;
  const piano = cands.filter(c => c.n === 2), single = cands.filter(c => c.n === 1);
  const pool = piano.length && (rng() < PIANO_P || !single.length) ? piano : single.length ? single : piano;
  pool.sort((a, b) => b.notes - a.notes);
  return pool[Math.floor(rng() * Math.min(3, pool.length))];
}

function buildScore(score, c) {
  const part = JSON.parse(JSON.stringify(score.parts[c.pi]));
  part.transposeChromatic = 0;
  const start = c.start || 0;
  part.staves.forEach((st, i) => { st.clef = effectiveClef(score, start, c.s0 + i); });
  const measures = score.measures.slice(start, c.end).map((m, k) => {
    const mi = start + k;
    const mm = JSON.parse(JSON.stringify({ ...m, staves: m.staves.slice(c.s0, c.s0 + c.n) }));
    delete mm.breaks;
    if (k === 0) { mm.timeSig = effectiveTimeSig(score, start); mm.keySig = effectiveKeySig(score, start); mm.staves.forEach(sm => { delete sm.clef; }); if (start > 0) { delete mm.pickup; delete mm.barlineLeft; } }
    if (mi === c.end - 1 && mm.barlineRight && mm.barlineRight !== 'single' && mm.barlineRight !== 'final' && mm.barlineRight !== 'double') delete mm.barlineRight;
    if (mm.barlineRight === 'dashed' || mm.barlineRight === 'none') delete mm.barlineRight;
    for (const sm of mm.staves) {
      sm.voices = [(sm.voices[0] || []).filter(ev => !ev.grace)];
      for (const ev of sm.voices[0]) { delete ev.hidden; if (ev.notes) for (const n of ev.notes) { delete n.color; delete n.head; } }
    }
    return mm;
  });
  const ids = new Set(), mids = new Set(measures.map(m => m.id));
  for (const m of measures) for (const sm of m.staves) for (const ev of sm.voices[0]) ids.add(ev.id);
  const ok = (e) => !e || (e.eventId ? ids.has(e.eventId) : e.measureId ? mids.has(e.measureId) : false);
  const spanners = (score.spanners || []).filter(s => ok(s.from) && ok(s.to));
  const out = { ...score, parts: [part], measures, spanners, sources: [] };
  delete out.importInfo;
  return out;
}

function randomSettings(score) {
  const s = score.settings;
  Object.assign(s, {
    pageSize: 'A4', orientation: 'portrait', pageWidthMm: 210, pageHeightMm: 297,
    staffSpaceMm: U(1.45, 2.05),
    marginsMm: { top: U(10, 22), bottom: U(10, 20), left: U(9, 20), right: U(9, 20) },
    systemGapSp: U(5.5, 11), staffGapSp: U(5, 8), firstSystemIndentSp: rand() < 0.5 ? 0 : U(2, 6),
    measureNumbers: pick(['system', 'system', 'none', 'all']), showPageNumbers: false,
  });
  if (rand() < 0.3) score.meta = { ...score.meta, title: '', subtitle: '', composer: '', lyricist: '', arranger: '' };
  // line weights vary between engravers / editions
  Object.assign(SP, { staffLine: U(0.08, 0.15), stemWidth: U(0.09, 0.14), ledgerLine: U(0.13, 0.2), barThin: U(0.11, 0.19), barThick: U(0.4, 0.55), beam: U(0.42, 0.52) });
}

function glyphMode(sc) {
  const NUMS = [2, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11, 12, 12, 1, 13, 15, 16];
  const clefs = ['treble', 'bass', 'alto', 'tenor', 'treble', 'bass'];
  for (let mi = 2; mi < sc.measures.length; mi += 1 + Math.floor(rand() * 3)) {
    const m = sc.measures[mi];
    if (rand() < 0.7) m.timeSig = rand() < 0.12 ? (rand() < 0.5 ? { num: 4, den: 4, display: 'common' } : { num: 2, den: 2, display: 'cut' }) : { num: pick(NUMS), den: pick([2, 4, 4, 8, 8, 16]), display: 'normal' };
    if (rand() < 0.6) m.keySig = { fifths: Math.floor(rand() * 15) - 7, mode: 'major' };
    if (rand() < 0.25) for (const sm of m.staves) sm.clef = pick(clefs);
  }
}

// ---------------------------------------------------------------- SVG → symbols
const SYM = {
  noteheadBlack: 'noteheadBlack', noteheadHalf: 'noteheadHalf', noteheadWhole: 'noteheadWhole',
  accidentalSharp: 'sharp', accidentalFlat: 'flat', accidentalNatural: 'natural', accidentalDoubleSharp: 'doubleSharp', accidentalDoubleFlat: 'doubleFlat',
  restWhole: 'restWhole', restHalf: 'restHalf', restQuarter: 'restQuarter', rest8th: 'rest8th', rest16th: 'rest16th', rest32nd: 'rest32nd',
  gClef: 'gClef', fClef: 'fClef', cClef: 'cClef', timeSigCommon: 'common', timeSigCutCommon: 'cut',
  flag8thUp: 'flag8th', flag8thDown: 'flag8th', flag16thUp: 'flag16th', flag16thDown: 'flag16th', flag32ndUp: 'flag32nd', flag32ndDown: 'flag32nd',
};
for (let d = 0; d < 10; d++) SYM['tsDigit' + d] = 'digit' + d;

function svgSymbols(svg) {
  const out = [];
  const stack = [[0, 0]];
  const re = /<(\/?)(g|use|circle)\b([^>]*?)(\/?)>/g;
  let mt;
  while ((mt = re.exec(svg))) {
    const [, close, tag, attrs, self] = mt;
    if (tag === 'g') {
      if (close) { stack.pop(); continue; }
      const t = /transform="translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)"/.exec(attrs);
      const top = stack[stack.length - 1];
      stack.push(t ? [top[0] + +t[1], top[1] + +t[2]] : top);
      if (self) stack.pop();
      continue;
    }
    const [ox, oy] = stack[stack.length - 1];
    if (tag === 'circle') {
      if (!/class="dot"/.test(attrs)) continue;
      const cx = +/cx="([-\d.e]+)"/.exec(attrs)[1] + ox, cy = +/cy="([-\d.e]+)"/.exec(attrs)[1] + oy, r = +/ r="([-\d.e]+)"/.exec(attrs)[1];
      out.push({ name: 'dot', bb: [cx - r, cy - r, cx + r, cy + r], c: [cx, cy] });
      continue;
    }
    const h = /href="#g-([\w]+)"/.exec(attrs);
    if (!h || !SYM[h[1]]) continue;
    const g = GLYPHS[h[1]];
    const t = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)(?:\s*scale\(([-\d.e]+)(?:[ ,]+([-\d.e]+))?\))?/.exec(attrs);
    if (!t) continue;
    const x = +t[1] + ox, y = +t[2] + oy, sx = t[3] != null ? +t[3] : 1, sy = t[4] != null ? +t[4] : sx;
    const xs = [x + sx * g.b[0], x + sx * g.b[2]], ys = [y + sy * g.b[1], y + sy * g.b[3]];
    const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const name = SYM[h[1]];
    out.push({ name, bb, c: name.startsWith('notehead') ? [(bb[0] + bb[2]) / 2, y] : [x, y] });
  }
  return out;
}

// grand staff: barlines run through the gap between the staves (like printed piano music)
function connectGrandStaff(svg, geo, n) {
  if (n < 2) return svg;
  const lines = [];
  for (const m of geo.measures) {
    const a = m.staves[0], b = m.staves[1];
    if (!a || !b) continue;
    const x = m.x + m.width, y0 = a.y + 4, y1 = b.y;
    const bl = m.barRight || 'single';
    if (bl === 'final') { lines.push([x - 0.9, y0, y1, SP.barThin]); lines.push([x - SP.barThick / 2, y0, y1, SP.barThick]); }
    else if (bl === 'double') { lines.push([x - 0.6, y0, y1, SP.barThin]); lines.push([x, y0, y1, SP.barThin]); }
    else lines.push([x, y0, y1, SP.barThin]);
  }
  const s = lines.map(([x, y0, y1, w]) => `<line x1="${x.toFixed(3)}" y1="${y0.toFixed(3)}" x2="${x.toFixed(3)}" y2="${y1.toFixed(3)}" stroke-width="${w.toFixed(3)}"/>`).join('');
  return svg.replace(/<\/svg>\s*$/, `<g class="gs-bars">${s}</g></svg>`);
}

// ---------------------------------------------------------------- GT
function buildGT(score, page, S, n, name, font, tx, pi = 0) {
  const geo = page.geometry;
  const P = (v) => r2(v * S);
  const ms = geo.measures.filter(m => m.page === pi).sort((a, b) => a.mi - b.mi);
  const evGeo = new Map();
  for (const e of geo.events) if (e.page === pi) evGeo.set(e.id, e);
  const implicit = geo.events.filter(e => e.page === pi && e.implicit);
  const last = score.measures.length - 1;
  const gtMeasures = [], barlines = [];
  for (const g of ms) {
    const m = score.measures[g.mi];
    const top = g.staves[0].y, bot = g.staves[n - 1].y + 4;
    const x0 = Math.max(g.x, g.staves[0].prefixEnd + tx - 0.4), x1 = g.x + g.width;   // prefixEnd is in system coordinates
    const staves = [];
    for (let si = 0; si < n; si++) {
      const evs = [];
      const voice = m.staves[si].voices[0];
      if (!voice.length) {
        const e = implicit.find(q => q.measureId === m.id && q.si === si);
        if (e) evs.push({ kind: 'rest', base: 'whole', dots: 0, pitches: [], tieStart: false, tieEnd: false, x: P((e.x + e.x1) / 2), bbox: [P(e.x), P(e.y0), P(e.x1 - e.x), P(e.y1 - e.y0)] });
      }
      for (const ev of voice) {
        const e = evGeo.get(ev.id);
        if (!e) continue;
        const o = { kind: ev.kind, base: ev.fullMeasureRest ? 'whole' : ev.dur.base, dots: ev.fullMeasureRest ? 0 : (ev.dur.dots || 0), pitches: ev.kind === 'note' ? ev.notes.map(pitchStr) : [],
          tieStart: !!(ev.notes || []).some(q => q.tieStart), tieEnd: !!(ev.notes || []).some(q => q.tieEnd),
          x: P((e.x + e.x1) / 2), bbox: [P(e.x), P(e.y0), P(e.x1 - e.x), P(e.y1 - e.y0)] };
        if (ev.tuplet) o.tuplet = `${ev.tuplet.num}:${ev.tuplet.den}`;
        if (e.heads && e.heads.length) o.heads = e.heads.map(h => [P((h.x0 + h.x1) / 2), P(h.y)]);
        evs.push(o);
      }
      staves.push(evs);
    }
    let bl = m.barlineRight || 'single';
    if (g.mi === last && bl === 'single') bl = 'final';
    g.barRight = bl;
    gtMeasures.push({ bbox: [P(x0), P(top), P(x1 - x0), P(bot - top)], staves, barlineRight: bl, index: g.mi });
    barlines.push({ x: P(x1), y0: P(top), y1: P(bot), type: bl });
  }
  const systems = [];
  for (const sys of geo.systems) {
    const mm = ms.filter(g => g.systemIndex === sys.index);
    if (!mm.length) continue;
    const xa = mm[0].x, xb = mm[mm.length - 1].x + mm[mm.length - 1].width;
    const staves = [];
    for (let si = 0; si < n; si++) {
      const y = mm[0].staves[si].y;
      staves.push({ clef: effectiveClef(score, mm[0].mi, si), lines: [0, 1, 2, 3, 4].map(k => [[P(xa), P(y + k)], [P(xb), P(y + k)]]), bbox: [P(xa), P(y), P(xb - xa), P(4)] });
    }
    systems.push({ staves, measureIndices: mm.map(g => ms.indexOf(g)) });
  }
  const ts = effectiveTimeSig(score, 0), ks = effectiveKeySig(score, 0);
  const symbols = svgSymbols(page.svg).map(s => {
    const cx = (s.bb[0] + s.bb[2]) / 2, cy = (s.bb[1] + s.bb[3]) / 2;
    const inMeasure = gtMeasures.some(m => cx >= m.bbox[0] / S && cx <= (m.bbox[0] + m.bbox[2]) / S && cy >= m.bbox[1] / S - 8 && cy <= (m.bbox[1] + m.bbox[3]) / S + 8);
    return { name: s.name, bbox: [P(s.bb[0]), P(s.bb[1]), P(s.bb[2] - s.bb[0]), P(s.bb[3] - s.bb[1])], c: [P(s.c[0]), P(s.c[1])], inMeasure };
  });
  return {
    image: name + '.png', width: Math.round(page.width * S), height: Math.round(page.height * S), staffSpace: r2(S), lineThickness: r2(SP.staffLine * S),
    keyFifths: ks.fifths, timeSig: { num: ts.num, den: ts.den }, staffCount: n, clefs: score.parts[0].staves.map(s => s.clef),
    systems, measures: gtMeasures, symbols, barlines, source: 'finale', font, page: pi,
    timeSigShown: symbols.some(q => !q.inMeasure && (q.name.startsWith('digit') || q.name === 'common' || q.name === 'cut')), glyphMode: GLYPH_MODE,
  };
}

// ---------------------------------------------------------------- main
const files = MUSICXML
  ? fs.readdirSync(SRC).filter(f => f.endsWith('.musicxml') && (!ONLY_KEYS || ONLY_KEYS.has(f.replace(/\.musicxml$/, ''))) && !(EXCLUDE_KEYS && EXCLUDE_KEYS.has(f.replace(/\.musicxml$/, '')))).sort()
  : fs.readdirSync(SRC).filter(f => f.endsWith('.gz') && (ONLY_KEYS ? listed(ONLY_KEYS, f) : splitOf(f) === SPLIT) && !(EXCLUDE_KEYS && listed(EXCLUDE_KEYS, f))).sort();
// deterministic shuffle
for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [files[i], files[j]] = [files[j], files[i]]; }
console.log(`${files.length} ${SPLIT} files`);
let made = 0, tried = 0;
const usedPieces = new Map();
const index = [];
for (const f of files) {
  if (made >= COUNT) break;
  const key = pieceKey(f);
  if ((usedPieces.get(key) || 0) >= PER_FOLDER) continue;     // at most PER_FOLDER parts of one piece / folder
  tried++;
  let score;
  try { score = MUSICXML ? importMusicXML(fs.readFileSync(path.join(SRC, f), 'utf8')) : enigmaToScore(zlib.gunzipSync(fs.readFileSync(path.join(SRC, f))).toString('utf8')); } catch (e) { continue; }
  const c = excerpt(score, rand);
  if (!c) continue;
  const font = FONTS[made % FONTS.length];
  useFont(font);
  let sc = buildScore(score, c);
  randomSettings(sc);
  if (GLYPH_MODE) glyphMode(sc);
  let res;
  try { res = engrave(sc); } catch (e) { console.error('engrave failed', f, e.message); useFont('freeserif'); continue; }
  // a later page (no time signature, like most pages of real music) 30 % of the time
  const pi = res.pages.length > 1 && rand() < 0.3 ? 1 : 0;
  const page = res.pages[pi];
  const nm = page.geometry.measures.filter(m => m.page === pi).length;
  if (nm < 4) { useFont('freeserif'); continue; }
  const S = res.spMm * DPI / 25.4;
  const name = `${String(made).padStart(3, '0')}_${c.n === 2 ? 'piano' : 'single'}_${font}`;
  const gt = buildGT(sc, page, S, c.n, name, font, res.margin.left, pi);
  const nNotes = gt.measures.reduce((a, m) => a + m.staves.flat().filter(e => e.kind === 'note').length, 0);
  if (nNotes < 20) { useFont('freeserif'); continue; }
  gt.piece = f.replace(/\.musx\.xml\.gz$|\.musicxml$/, '');
  if (MUSICXML) gt.source = 'musicxml';
  const svg = connectGrandStaff(page.svg, page.geometry, c.n).replace('<svg ', `<svg width="${gt.width}" height="${gt.height}" `);
  await sharp(Buffer.from(svg), { density: 72 }).flatten({ background: '#ffffff' }).greyscale().png().toFile(path.join(OUT, name + '.png'));
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(gt));
  usedPieces.set(key, (usedPieces.get(key) || 0) + 1);
  index.push({ name, piece: gt.piece, font, staves: c.n, measures: gt.measures.length, notes: nNotes, key: gt.keyFifths, time: `${gt.timeSig.num}/${gt.timeSig.den}` });
  console.log(name, gt.piece.slice(-60), `m=${gt.measures.length} notes=${nNotes} key=${gt.keyFifths} ${gt.timeSig.num}/${gt.timeSig.den} sp=${S.toFixed(1)}`);
  made++;
  useFont('freeserif');
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`made ${made} pages from ${tried} tried files`);
