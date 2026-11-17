#!/usr/bin/env node
// Compares two score files measure by measure after importing both with JSE's own importers
// (.mscz/.mscx via io/mscz.js, .mxl/.musicxml/.xml via io/musicxml.js; .json / .ssnap = a ScoreDoc as it is).
//
//   node tools/mscz/compare.mjs <a> <b> [--verbose]
//   node tools/mscz/compare.mjs --pairs <dir> [--ext mxl] [--limit n] [--json out.json] [--verbose]
//
// --pairs walks <dir> and compares every MuseScore file with the file of the same base name and
// the other extension next to it (OpenScore keeps lc123.mscx / lc123.mscz / lc123.mxl side by side).
// Used to check the MuseScore importer against MusicXML written by MuseScore itself, and to check
// our exported .mscz after real MuseScore converted it back (see tools/mscz/README.md).
//
// What is compared (per measure): sounding pitches + onsets + lengths of all notes (per part and per
// staff), lyrics, chord symbols, time/key signatures, repeats/voltas/markers, clefs.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { importMscz } = await import('../../app/js/io/mscz.js');
const { importMusicXML, importMXL } = await import('../../app/js/io/musicxml.js');
const { durTicks, midiOf, effectiveTimeSig, effectiveKeySig, staffList } = await import('../../app/js/model/score.js');

export async function load(file) {
  const buf = fs.readFileSync(file);
  if (/\.(mscz|mscx)$/i.test(file)) return importMscz(buf, { JSZip, fileName: path.basename(file) });
  if (/\.mxl$/i.test(file)) return importMXL(buf, { JSZip });
  if (/\.json$/i.test(file)) return JSON.parse(buf.toString('utf8'));          // a ScoreDoc
  if (/\.ssnap$/i.test(file)) { const zip = await JSZip.loadAsync(buf); return JSON.parse(await zip.file('score.json').async('string')); }
  return importMusicXML(buf.toString('utf8'));
}

/**
 * Flattens a score into comparable facts.
 * `ottavaWritten`: notes under an ottava line are stored as written — every ScoreDoc does that (since v1.1.0 the
 * MusicXML import converts the sounding pitches of the file as well) → the shift is added, so the facts hold
 * sounding pitches. Pass false only for a score from an older MusicXML import.
 */
export function facts(score, { ottavaWritten = true } = {}) {
  const staves = staffList(score);
  const pos = new Map();                   // event id → { mi, si, tick, abs }
  const mStart = []; let abs = 0;
  score.measures.forEach((m, mi) => {
    mStart.push(abs);
    let longest = 0;
    m.staves.forEach((sm, si) => sm.voices.forEach((v) => { let t = 0; for (const ev of v) { pos.set(ev.id, { mi, si, tick: t, abs: abs + t, end: abs + t + durTicks(ev) }); t += durTicks(ev); } if (v.length !== 1 || !v[0].fullMeasureRest) longest = Math.max(longest, t); }));
    const ts = effectiveTimeSig(score, mi);
    abs += longest > 0 ? longest : (ts.num * 3840) / ts.den;
  });
  const shifts = staves.map(() => []);
  if (ottavaWritten) for (const sp of score.spanners) {
    if (sp.type !== 'ottava') continue;
    const a = pos.get(sp.from.eventId), b = pos.get(sp.to.eventId); if (!a || !b) continue;
    const semis = { 8: 12, '-8': -12, 15: 24, '-15': -24 }[sp.octaveShift] || 0;
    shifts[a.si].push({ from: a.abs, to: b.end, semis });
  }
  const shiftAt = (si, t) => { let s = 0; for (const r of shifts[si]) if (t >= r.from - 1 && t < r.to - 1) s += r.semis; return s; };
  const out = { measures: score.measures.length, notes: [], lyrics: [], chords: [], meter: [], keys: [], clefs: [], repeats: [], spanners: {}, parts: score.parts.length, staves: staves.length, uneven: new Set() };
  score.measures.forEach((m, mi) => {
    const ts = effectiveTimeSig(score, mi), ks = effectiveKeySig(score, mi);
    out.meter.push(`${ts.num}/${ts.den}`); out.keys.push(ks.fifths);
    const rep = [m.barlineLeft === 'repeat-start' ? '|:' : '', m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both' ? ':|' : '', m.barlineRight === 'repeat-both' ? '|:' : '', ...(m.markers || []).slice().sort()].filter(Boolean).join(' ');
    out.repeats.push(rep);
    for (const c of m.chords || []) out.chords.push({ mi, tick: Math.round(c.tick), text: normChord(c.text) });
    m.staves.forEach((sm, si) => {
      if (sm.clef) out.clefs.push({ mi, si, clef: sm.clef });
      const st = staves[si];
      sm.voices.forEach((v) => {
        let t = 0;
        // a voice that does not fill the measure exactly means this importer could not make sense of the rhythm here
        const total = v.reduce((x, ev) => x + durTicks(ev), 0), cap = (ts.num * 3840) / ts.den;
        if (v.length && !(v.length === 1 && v[0].fullMeasureRest) && Math.abs(total - cap) > 2 && !(m.pickup && total < cap)) out.uneven.add(`${mi}|${st.partIndex}`);
        if (v.some(ev => ev.tuplet && ev.tuplet.num === ev.tuplet.den)) out.uneven.add(`${mi}|${st.partIndex}`);
        for (const ev of v) {
          const d = durTicks(ev);
          if (ev.kind === 'note') for (const n of ev.notes) {
            let midi;
            if (st.staff.type === 'percussion') midi = 1000 + (st.staff.drumMap?.[n.drum]?.midi ?? 0);
            else if (st.staff.type === 'tab' && n.string) midi = 2000 + n.string * 100 + (n.fret || 0);
            else midi = midiOf(n) + shiftAt(si, mStart[mi] + t);
            out.notes.push({ mi, si, pi: st.partIndex, tick: Math.round(t), dur: ev.grace ? 0 : Math.round(d), midi, grace: !!ev.grace, tie: (n.tieStart ? 1 : 0) + (n.tieEnd ? 2 : 0), spell: st.staff.type === 'standard' ? n.step + (n.alter || 0) : '' });
          }
          // an elision is ‿ from the MuseScore importer and the music font's own character (U+E550…) from MuseScore's MusicXML
          for (const l of ev.lyrics || []) out.lyrics.push({ mi, pi: st.partIndex, tick: Math.round(t), verse: l.verse, text: String(l.text).replace(/[-]/g, '‿'), syllabic: l.syllabic || 'single' });
          t += d;
        }
      });
    });
  });
  for (const sp of score.spanners) out.spanners[sp.type] = (out.spanners[sp.type] || 0) + 1;
  return out;
}
const normChord = t => String(t || '').replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, '');

function multisetDiff(a, b) {
  const count = new Map();
  for (const k of a) count.set(k, (count.get(k) || 0) + 1);
  let common = 0; const onlyB = [];
  for (const k of b) { const c = count.get(k) || 0; if (c > 0) { count.set(k, c - 1); common++; } else onlyB.push(k); }
  const onlyA = []; for (const [k, c] of count) for (let i = 0; i < c; i++) onlyA.push(k);
  return { common, onlyA, onlyB };
}

/**
 * Like multisetDiff, but two notes also match when their onsets differ by at most `tol` ticks.
 * JSE's MusicXML import fills odd gaps (e.g. 320 ticks before a cross-staff triplet note) with the
 * nearest ordinary rests, which shifts later onsets of that measure by a few ticks.
 */
function fuzzyDiff(a, b, keyFn, tol) {
  const group = (list) => { const m = new Map(); for (const n of list) { const k = keyFn(n); if (!m.has(k)) m.set(k, []); m.get(k).push(n.tick); } for (const v of m.values()) v.sort((x, y) => x - y); return m; };
  const ga = group(a), gb = group(b);
  let common = 0; const onlyA = [], onlyB = [];
  for (const [k, ta] of ga) {
    const tb = gb.get(k) || []; const used = new Array(tb.length).fill(false);
    for (const t of ta) {
      let best = -1, bd = tol + 1;
      for (let j = 0; j < tb.length; j++) if (!used[j] && Math.abs(tb[j] - t) < bd) { bd = Math.abs(tb[j] - t); best = j; }
      if (best >= 0) { used[best] = true; common++; } else onlyA.push(`${k}@${t}`);
    }
    tb.forEach((t, j) => { if (!used[j]) onlyB.push(`${k}@${t}`); });
  }
  for (const [k, tb] of gb) if (!ga.has(k)) for (const t of tb) onlyB.push(`${k}@${t}`);
  return { common, onlyA, onlyB };
}

/** Compares the facts of two scores; returns counts and (optionally) the first differences. */
export function compare(fa, fb) {
  const r = { measuresA: fa.measures, measuresB: fb.measures };
  const key = {
    partPitch: n => `${n.mi}|${n.pi}|${n.tick}|${n.midi}|${n.dur}`,
    staffPitch: n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.dur}`,
    onset: n => `${n.mi}|${n.pi}|${n.tick}|${n.midi}`,
    spell: n => `${n.mi}|${n.pi}|${n.tick}|${n.midi}|${n.spell}`,
    tie: n => `${n.mi}|${n.pi}|${n.tick}|${n.midi}|${n.tie}`,
  };
  for (const [name, fn] of Object.entries(key)) {
    const d = multisetDiff(fa.notes.map(fn), fb.notes.map(fn));
    r[name] = { a: fa.notes.length, b: fb.notes.length, common: d.common, onlyA: d.onlyA.slice(0, 12), onlyB: d.onlyB.slice(0, 12) };
  }
  // the same with a tolerance on the onset (see fuzzyDiff): [part | staff] pitch + length
  for (const [name, fn] of [['partNear', n => `${n.mi}|${n.pi}|${n.midi}|${n.dur}`], ['staffNear', n => `${n.mi}|${n.si}|${n.midi}|${n.dur}`]]) {
    const d = fuzzyDiff(fa.notes, fb.notes, fn, 130);
    r[name] = { a: fa.notes.length, b: fb.notes.length, common: d.common, onlyA: d.onlyA.slice(0, 12), onlyB: d.onlyB.slice(0, 12) };
  }
  // … and only where both imports found a rhythm that fills the measure (differences elsewhere are an importer giving up, not a disagreement)
  {
    const even = n => !fa.uneven.has(`${n.mi}|${n.pi}`) && !fb.uneven.has(`${n.mi}|${n.pi}`);
    const na = fa.notes.filter(even), nb = fb.notes.filter(even);
    const d = fuzzyDiff(na, nb, n => `${n.mi}|${n.pi}|${n.midi}|${n.dur}`, 130);
    r.partEven = { a: na.length, b: nb.length, common: d.common, onlyA: d.onlyA.slice(0, 12), onlyB: d.onlyB.slice(0, 12) };
    r.unevenA = fa.uneven.size; r.unevenB = fb.uneven.size;
  }
  const ly = multisetDiff(fa.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${l.text}`), fb.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${l.text}`));
  r.lyrics = { a: fa.lyrics.length, b: fb.lyrics.length, common: ly.common, onlyA: ly.onlyA.slice(0, 12), onlyB: ly.onlyB.slice(0, 12) };
  const sy = multisetDiff(fa.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${l.text}|${l.syllabic}`), fb.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${l.text}|${l.syllabic}`));
  r.syllabic = { a: fa.lyrics.length, b: fb.lyrics.length, common: sy.common, onlyA: sy.onlyA.slice(0, 8), onlyB: sy.onlyB.slice(0, 8) };
  // the words alone: same measure, part and verse, wherever in the measure their note starts
  const wd = multisetDiff(fa.lyrics.map(l => `${l.mi}|${l.pi}|${l.verse}|${l.text}`), fb.lyrics.map(l => `${l.mi}|${l.pi}|${l.verse}|${l.text}`));
  r.words = { a: fa.lyrics.length, b: fb.lyrics.length, common: wd.common, onlyA: wd.onlyA.slice(0, 12), onlyB: wd.onlyB.slice(0, 12) };
  const ch = multisetDiff(fa.chords.map(c => `${c.mi}|${c.tick}|${c.text}`), fb.chords.map(c => `${c.mi}|${c.tick}|${c.text}`));
  r.chords = { a: fa.chords.length, b: fb.chords.length, common: ch.common, onlyA: ch.onlyA.slice(0, 12), onlyB: ch.onlyB.slice(0, 12) };
  const n = Math.min(fa.measures, fb.measures);
  const diffIdx = (xa, xb) => { const out = []; for (let i = 0; i < n; i++) if (xa[i] !== xb[i]) out.push(`m${i + 1}: ${xa[i]} ≠ ${xb[i]}`); return out; };
  r.meter = diffIdx(fa.meter, fb.meter); r.keys = diffIdx(fa.keys, fb.keys); r.repeats = diffIdx(fa.repeats, fb.repeats);
  const cl = multisetDiff(fa.clefs.map(c => `${c.mi}|${c.si}|${c.clef}`), fb.clefs.map(c => `${c.mi}|${c.si}|${c.clef}`));
  r.clefs = { a: fa.clefs.length, b: fb.clefs.length, common: cl.common, onlyA: cl.onlyA.slice(0, 8), onlyB: cl.onlyB.slice(0, 8) };
  r.spanners = { a: fa.spanners, b: fb.spanners };
  return r;
}

const isMs = f => /\.(mscz|mscx|json|ssnap)$/i.test(f);            // the MuseScore side of a pair (--pairs)
export async function compareFiles(a, b) {
  const sa = await load(a), sb = await load(b);
  return { result: compare(facts(sa), facts(sb)), a: sa, b: sb };
}

const pct = (x) => (x.a + x.b ? (200 * x.common / (x.a + x.b)).toFixed(2) + '%' : '–');
function printResult(r, verbose) {
  console.log(`measures ${r.measuresA} / ${r.measuresB}`);
  for (const k of ['partPitch', 'partNear', 'partEven', 'staffPitch', 'staffNear', 'onset', 'spell', 'tie', 'lyrics', 'syllabic', 'words', 'chords', 'clefs']) {
    const x = r[k];
    console.log(`${k.padEnd(10)} a ${x.a} b ${x.b} common ${x.common} (${pct(x)})`);
    if (verbose && (x.onlyA.length || x.onlyB.length)) { console.log('   only in a:', x.onlyA.join('  ')); console.log('   only in b:', x.onlyB.join('  ')); }
  }
  for (const k of ['meter', 'keys', 'repeats']) console.log(`${k.padEnd(10)} differing measures ${r[k].length}${verbose && r[k].length ? ': ' + r[k].slice(0, 8).join('; ') : ''}`);
  console.log('spanners   a', JSON.stringify(r.spanners.a), 'b', JSON.stringify(r.spanners.b));
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const verbose = args.includes('--verbose');
  const pairsDir = opt('--pairs');
  if (!pairsDir) {
    const [a, b] = args.filter(x => !x.startsWith('--'));
    if (!a || !b) { console.error('usage: node tools/mscz/compare.mjs <a> <b> [--verbose]   |   --pairs <dir> [--ext mxl] [--limit n] [--json out.json]'); process.exit(2); }
    const { result } = await compareFiles(a, b);
    printResult(result, verbose);
  } else {
    const ext = (opt('--ext') || 'mxl').replace(/^\./, '');
    const limit = +(opt('--limit') || 0) || Infinity;
    const files = [];
    const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); } else if (isMs(p)) files.push(p); };
    walk(pairsDir);
    const sum = {}; const rows = []; let n = 0, failed = 0, measureMismatch = 0;
    const keys = ['partPitch', 'partNear', 'partEven', 'staffPitch', 'staffNear', 'onset', 'spell', 'tie', 'lyrics', 'syllabic', 'words', 'chords', 'clefs'];
    for (const f of files) {
      const other = f.replace(/\.(mscz|mscx)$/i, '.' + ext);
      if (!fs.existsSync(other)) continue;
      if (n >= limit) break;
      n++;
      try {
        const { result: r } = await compareFiles(f, other);
        if (r.measuresA !== r.measuresB) measureMismatch++;
        for (const k of keys) { const s = sum[k] || (sum[k] = { a: 0, b: 0, common: 0 }); s.a += r[k].a; s.b += r[k].b; s.common += r[k].common; }
        for (const k of ['meter', 'keys', 'repeats']) sum[k] = (sum[k] || 0) + r[k].length;
        sum.unevenA = (sum.unevenA || 0) + r.unevenA; sum.unevenB = (sum.unevenB || 0) + r.unevenB;
        rows.push({ file: path.relative(pairsDir, f), unevenA: r.unevenA, unevenB: r.unevenB, measures: [r.measuresA, r.measuresB], ...Object.fromEntries(keys.map(k => [k, [r[k].a, r[k].b, r[k].common]])), meter: r.meter.length, keys: r.keys.length, repeats: r.repeats.length, spanners: r.spanners });
        if (verbose) console.log(path.relative(pairsDir, f), keys.map(k => `${k} ${pct(r[k])}`).join(' · '), `meter ${r.meter.length} keys ${r.keys.length} rep ${r.repeats.length}`);
      } catch (e) { failed++; console.log('ERR', path.relative(pairsDir, f), e.message); }
    }
    console.log(`pairs ${n} failed ${failed} · measure-count mismatches ${measureMismatch}`);
    for (const k of keys) console.log(`  ${k.padEnd(10)} a ${sum[k]?.a ?? 0} b ${sum[k]?.b ?? 0} common ${sum[k]?.common ?? 0} (${sum[k] ? pct(sum[k]) : '–'})`);
    // MusicXML cannot express MuseScore's per-staff ("local") meters, so those pairs are not comparable
    const same = rows.filter(x => x.meter === 0);
    console.log(`  pairs with the same meter on both sides: ${same.length}`);
    for (const k of keys) { const t = same.reduce((acc, x) => { acc.a += x[k][0]; acc.b += x[k][1]; acc.common += x[k][2]; return acc; }, { a: 0, b: 0, common: 0 }); console.log(`    ${k.padEnd(10)} ${pct(t)}  (${t.a + t.b - 2 * t.common} unmatched, ${same.filter(x => x[k][0] + x[k][1] - 2 * x[k][2] === 0).length} files identical)`); }
    console.log(`  differing measures: meter ${sum.meter || 0} keys ${sum.keys || 0} repeats ${sum.repeats || 0}`);
    console.log(`  measure×part cells whose voices do not fill the measure: a ${sum.unevenA || 0} · b ${sum.unevenB || 0}`);
    const out = opt('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ sum, rows }, null, 1));
  }
}
