#!/usr/bin/env node
// Compares two scores fact by fact — used to check the Finale writer by round trip (ScoreDoc → .musx → ScoreDoc).
//
//   node tools/musx/compare.mjs <a> <b> [--verbose]          any two files JSE opens (.musx .mscz .mxl .nwc .json …)
//   node tools/musx/compare.mjs --roundtrip <file-or-dir>… [--limit n] [--every n] [--json out.json] [--verbose]
//        imports each file, exports it with app/js/io/musx-write.js, imports the result with app/js/io/musx.js
//        and compares the two ScoreDocs.
//
// Facts (one string each, compared as multisets per category):
//   notes      measure | staff | onset | written pitch (8va lines applied) | length          (tools/mscz/compare.mjs)
//   spelling, ties, accidentals (forced display), tuplets (ratio of each event), grace notes, rests,
//   lyrics (verse, text, syllabic), chords, clefs, meter, keys, barlines + repeats + endings + markers,
//   dynamics, articulations / ornaments / fermata / tremolo / arpeggio, stems, hidden events,
//   texts (measure and event texts, tempo marks, rehearsal marks) and lines (type + both ends).
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { exportMusx } = await import('../../app/js/io/musx-write.js');
const { importMusx } = await import('../../app/js/io/musx.js');
const { facts } = await import('../mscz/compare.mjs');
const { durTicks, staffList, measureCapacity, effectiveTimeSig } = await import('../../app/js/model/score.js');
const { autoBeamGroups } = await import('../../app/js/engrave/layout.js');

// (runs of spaces in a text are one space: the Finale reader tidies the padding of Finale's expressions)
const ws = (t) => String(t ?? '').replace(/[ \t]+/g, ' ').trim();

/** All facts of a score, by category (arrays of strings). */
export function scoreFacts(score) {
  const base = facts(score, { ottavaWritten: true });
  const F = {};
  F.notes = base.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.dur}`);
  F.spelling = base.notes.filter(n => n.spell).map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.spell}`);
  F.ties = base.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.tie}`);
  // (a no-break space or hyphen inside a syllable is how Finale keeps a space or hyphen there: compared as one)
  F.lyrics = base.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${String(l.text).replace(/\u00a0/g, ' ').replace(/\u2011/g, '-')}|${l.syllabic}`);
  F.chords = base.chords.map(c => `${c.mi}|${c.tick}|${c.text}`);
  // clef and key changes: a restatement of the clef or key in force changes nothing in Finale (it shows none) — not compared
  const clefNow = new Map(staffList(score).map(s => [s.globalIndex, s.staff.clef || 'treble']));
  F.clefs = base.clefs.slice().sort((a, b) => a.mi - b.mi).filter(c => { const same = clefNow.get(c.si) === c.clef; clefNow.set(c.si, c.clef); return !same || c.mi === 0; }).map(c => `${c.mi}|${c.si}|${c.clef}`);
  F.meter = score.measures.map((m, mi) => { const t = effectiveTimeSig(score, mi); return `${mi}|${t.num}/${t.den}${t.display && t.display !== 'normal' ? t.display : ''}${m.pickup ? '|pickup' : ''}`; });
  let keyNow = null;
  F.keys = score.measures.map((m, mi) => { const k = m.keySig ? `${m.keySig.fifths}${m.keySig.mode === 'minor' ? 'm' : ''}` : '-'; if (k === keyNow && mi > 0) return `${mi}|-`; if (k !== '-') keyNow = k; return `${mi}|${k}`; }).filter((k, mi) => mi === 0 || !k.endsWith('|-'));
  const kinds = new Map(staffList(score).map(s => [s.globalIndex, s.staff.type || 'standard']));
  const ev = { accidentals: [], heads: [], tuplets: [], grace: [], rests: [], dynamics: [], marks: [], stems: [], hidden: [], texts: [], beams: [] };
  const staffOf = new Map(staffList(score).map(s => [s.globalIndex, s.staff]));
  const pos = new Map();
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => {
    let t = 0;
    // beams as drawn: explicit beams and the automatic beaming of the engraver
    const ts = effectiveTimeSig(score, mi);
    autoBeamGroups(v, ts).forEach((g) => ev.beams.push(`${mi}|${si}|${g.map(i => { let x = 0; for (let k = 0; k < i; k++) if (!v[k].grace) x += durTicks(v[k]); return x; }).join(',')}`));
    for (const e of v) {
      const at = `${mi}|${si}|${t}`;
      // (a drum note is its drum: its MIDI key; JSE draws it on the drum's line whatever its step and octave)
      const dm = kinds.get(si) === 'percussion' ? staffOf.get(si)?.drumMap || {} : null;
      // (a TAB note is its string and fret)
      const tab = kinds.get(si) === 'tab';
      const key = `${at}|${e.kind === 'note' ? e.notes.map(n => dm && dm[n.drum] ? 'd' + dm[n.drum].midi : tab && n.string ? `t${n.string}/${n.fret || 0}` : n.step + (n.alter || 0) + n.octave).sort().join('+') : 'r'}`;
      pos.set(e.id, key);
      if (e.kind === 'note' && kinds.get(si) === 'standard') for (const n of e.notes) if (n.accidental && n.accidental !== 'none') ev.accidentals.push(`${at}|${n.step}${n.octave}|${n.accidental}`);
      // noteheads as drawn (a drum's comes from its drum map; JSE draws a short 'diamond' black)
      if (e.kind === 'note' && kinds.get(si) !== 'tab') for (const n of e.notes) {
        if (kinds.get(si) === 'percussion' && n.drum && staffOf.get(si)?.drumMap?.[n.drum]) continue;
        let h = n.head || 'normal';
        if (h === 'diamond' && !['half', 'whole', 'breve', 'longa', 'maxima'].includes(e.dur.base)) h = 'diamond-black';
        if (h !== 'normal') ev.heads.push(`${at}|${n.step}${n.octave}|${h}`);
      }
      if (e.tuplet) ev.tuplets.push(`${key}|${e.tuplet.num}:${e.tuplet.den}`);
      if (e.grace) ev.grace.push(`${key}|${e.dur.base}${e.grace.slash ? '/' : ''}`);
      const fills = v.length === 1 && (e.fullMeasureRest || Math.abs(durTicks(e) - measureCapacity(effectiveTimeSig(score, mi))) <= 1 || m.pickup);
      // (hidden rests that only pad a lower voice to the end of the measure are not compared: Finale leaves a layer open)
      if (e.kind === 'rest' && !fills && !(vi > 0 && e.hidden && v.slice(v.indexOf(e)).every(x => x.kind === 'rest' && x.hidden))) ev.rests.push(`${at}|${e.dur.base}.${e.dur.dots || 0}${e.hidden ? 'H' : ''}`);
      if (e.dynamic) ev.dynamics.push(`${at}|${e.dynamic}`);
      for (const a of e.articulations || []) ev.marks.push(`${key}|${a}`);
      for (const o of e.ornaments || []) ev.marks.push(`${key}|${o}`);
      if (e.fermata) ev.marks.push(`${key}|fermata-${e.fermata}`);
      if (e.tremolo) ev.marks.push(`${key}|trem${e.tremolo}`);
      if (e.arpeggio) ev.marks.push(`${key}|arpeggio`);
      if (e.stem && e.kind === 'note') ev.stems.push(`${key}|${e.stem}`);
      if (e.hidden && e.kind === 'note') ev.hidden.push(key);
      for (const x of e.texts || []) ev.texts.push(`${mi}|${si}|${t}|${ws(x.text)}|${x.placement || ''}|${x.style || ''}`);
      if (!e.grace) t += durTicks(e);
    }
  })));
  Object.assign(F, ev);
  F.barlines = []; F.measureTexts = []; F.breaks = [];
  score.measures.forEach((m, mi) => {
    // an end repeat followed by a start repeat is one "repeat both ways" barline, however it is written
    const next = score.measures[mi + 1], prev = score.measures[mi - 1];
    const right = m.barlineRight === 'repeat-end' && next?.barlineLeft === 'repeat-start' ? 'repeat-both' : m.barlineRight;
    const leftDone = m.barlineLeft === 'repeat-start' && prev?.barlineRight === 'repeat-end';
    if (m.barlineLeft && m.barlineLeft !== 'none' && !leftDone) F.barlines.push(`${mi}|L|${m.barlineLeft}`);
    if (right && right !== 'single' && !(mi === score.measures.length - 1 && right === 'final')) F.barlines.push(`${mi}|R|${right}${m.repeatCount > 2 ? '×' + m.repeatCount : ''}`);
    for (const mk of m.markers || []) F.barlines.push(`${mi}|marker|${mk}`);
    if (m.rehearsalMark) F.measureTexts.push(`${mi}|rehearsal|${m.rehearsalMark}`);
    if (m.tempo) F.measureTexts.push(`${mi}|tempo|${m.tempo.bpm}|${m.tempo.beatUnit}${'.'.repeat(m.tempo.dots || 0)}|${m.tempo.text || ''}|${m.tempo.showBpm ? 'bpm' : ''}`);
    for (const x of m.texts || []) ev.texts.push(`${mi}|${x.staffIndex || 0}|0|${ws(x.text)}|${x.placement || ''}|${x.style || ''}`);
    // a break after the last measure changes nothing (and Finale has no system to break to)
    const last = mi === score.measures.length - 1;
    if (m.breaks?.system && !last) F.breaks.push(`${mi}|system`);
    if (m.breaks?.page && !last) F.breaks.push(`${mi}|page`);
  });
  const mIdx = new Map(score.measures.map((m, mi) => [m.id, mi]));
  F.lines = (score.spanners || []).map(sp => {
    const end = (x) => (x?.eventId ? pos.get(x.eventId) : x?.measureId != null ? 'm' + mIdx.get(x.measureId) : '?') || '?';
    const voltaType = sp.voltaType || (['repeat-end', 'repeat-both'].includes(score.measures[mIdx.get(sp.to?.measureId)]?.barlineRight) ? 'closed' : 'open');
    const extra = sp.type === 'ottava' ? sp.octaveShift : sp.type === 'volta' ? `${sp.number}|${voltaType}` : sp.type === 'textLine' ? ws(sp.text) : sp.type === 'slur' ? sp.placement || '' : '';
    return `${sp.type}|${end(sp.from)}|${end(sp.to)}|${extra}`;
  });
  return F;
}

/** Multiset comparison per category. */
export function compareFacts(fa, fb, keys = Object.keys(fa)) {
  const out = {};
  for (const k of keys) {
    const a = fa[k] || [], b = fb[k] || [];
    const count = new Map(); for (const x of a) count.set(x, (count.get(x) || 0) + 1);
    let common = 0; const onlyB = [];
    for (const x of b) { const c = count.get(x) || 0; if (c > 0) { count.set(x, c - 1); common++; } else onlyB.push(x); }
    const onlyA = []; for (const [x, c] of count) for (let i = 0; i < c; i++) onlyA.push(x);
    out[k] = { a: a.length, b: b.length, common, onlyA, onlyB };
  }
  return out;
}
export const same = (r) => Object.entries(r).every(([k, x]) => x.common === x.a && (x.a === x.b || k === 'breaks'));

/** ScoreDoc → .musx → ScoreDoc. */
export async function roundTrip(score) {
  const warnings = [];
  const bytes = await exportMusx(score, { JSZip, warnings });
  const back = await importMusx(bytes, { JSZip });
  return { back, bytes, warnings };
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadAny } = await import('./denigma.mjs');
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const verbose = args.includes('--verbose');
  const pct = (x) => (x.a + x.b ? (200 * x.common / (x.a + x.b)).toFixed(3) + '%' : '–');
  if (!args.includes('--roundtrip')) {
    const [a, b] = args.filter(x => !x.startsWith('--'));
    if (!a || !b) { console.error('usage: node tools/musx/compare.mjs <a> <b> [--verbose] | --roundtrip <file-or-dir>…'); process.exit(2); }
    const r = compareFacts(scoreFacts(await loadAny(a)), scoreFacts(await loadAny(b)));
    for (const [k, x] of Object.entries(r)) { console.log(`${k.padEnd(13)} a ${x.a} b ${x.b} same ${x.common} (${pct(x)})`); if (verbose && (x.onlyA.length || x.onlyB.length)) console.log('   only a:', x.onlyA.slice(0, 10).join('  '), '\n   only b:', x.onlyB.slice(0, 10).join('  ')); }
  } else {
    const limit = +(opt('--limit') || 0) || Infinity, every = +(opt('--every') || 1) || 1;
    const skip = new Set([opt('--limit'), opt('--every'), opt('--json')].filter(Boolean));
    const files = [];
    const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); else if (/\.(musx|ftmx|mscz|mscx|mxl|musicxml|xml|nwc|nwctxt|json)$/i.test(p)) files.push(p); };
    args.filter(a => !a.startsWith('--') && !skip.has(a)).forEach(walk);
    const tot = {}; let n = 0, ok = 0, identical = 0, failed = 0, unreadable = 0; const warnCount = new Map(); const report = [];
    const t0 = Date.now();
    for (const f of files.filter((_, i) => i % every === 0).slice(0, limit)) {
      n++;
      // a source file JSE itself cannot open is not an export failure: count it apart
      let score;
      try { score = await loadAny(f); if (!score?.parts?.length || !score.measures?.length) throw new Error('not a score'); } catch (e) { unreadable++; report.push({ file: f, unreadable: e.message }); if (verbose) console.log('UNREADABLE', f, e.message); continue; }
      try {
        const { back, warnings } = await roundTrip(score);
        ok++;
        for (const w of warnings) warnCount.set(w, (warnCount.get(w) || 0) + 1);
        const r = compareFacts(scoreFacts(score), scoreFacts(back));
        for (const [k, x] of Object.entries(r)) { const t = tot[k] || (tot[k] = { a: 0, b: 0, common: 0 }); t.a += x.a; t.b += x.b; t.common += x.common; }
        if (same(r)) identical++;
        else {
          const diffs = Object.fromEntries(Object.entries(r).filter(([, x]) => x.onlyA.length || x.onlyB.length).map(([k, x]) => [k, { onlyA: x.onlyA.slice(0, 6), onlyB: x.onlyB.slice(0, 6) }]));
          report.push({ file: f, diffs });
          if (verbose) console.log(path.relative(process.cwd(), f), JSON.stringify(diffs).slice(0, 1500));
        }
      } catch (e) { failed++; report.push({ file: f, error: e.message }); console.log('ERR', f, e.message); if (verbose) console.log(e.stack); }
    }
    console.log(`files ${n} · JSE cannot open ${unreadable} · exported + re-imported ${ok} · failed ${failed} · identical in every category ${identical} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const [k, x] of Object.entries(tot)) console.log(`  ${k.padEnd(13)} ${String(x.a).padStart(8)} → ${String(x.b).padStart(8)}  same ${String(x.common).padStart(8)} (${pct(x)})`);
    for (const [w, c] of [...warnCount].sort((a, b) => b[1] - a[1])) console.log(`  export warning ×${c}: ${w}`);
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ totals: tot, files: n, unreadable, identical, failed, report }, null, 1));
  }
}
