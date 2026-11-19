#!/usr/bin/env node
// Checks exported .musx files with an independent Finale reader: denigma (github.com/rpatters1/denigma, built on
// the musxdom library). Every score is imported with JSE, exported with app/js/io/musx-write.js, read by denigma
// (export to MNX) and the MNX is compared with the ScoreDoc it came from. Any message denigma / musxdom prints
// (unknown XML, integrity errors, validation errors) counts as a problem.
//
//   node tools/musx/denigma.mjs <file-or-dir>… --out <dir> [--denigma <path>] [--limit n] [--every n]
//                                [--json report.json] [--verbose] [--keep]
//
// Inputs: .musx/.ftmx (Finale), .mscz/.mscx, .mxl/.musicxml/.xml, .nwc/.nwctxt, .json (a ScoreDoc).
// denigma: --denigma, else $DENIGMA, else `denigma` on the PATH. Build notes: tools/musx/README.md.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url'; import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { exportMusx } = await import('../../app/js/io/musx-write.js');
const { importMusx } = await import('../../app/js/io/musx.js');
const { importNwc } = await import('../../app/js/io/nwc.js');
const { load, facts } = await import('../mscz/compare.mjs');
const { mnxFacts } = await import('./mnx-facts.mjs');
const { staffList, durTicks, midiOf } = await import('../../app/js/model/score.js');

export async function loadAny(file) {
  const buf = fs.readFileSync(file);
  if (/\.(musx|ftmx)$/i.test(file)) return importMusx(buf, { JSZip });
  if (/\.(nwc|nwctxt)$/i.test(file)) return importNwc(buf, { fileName: path.basename(file) });
  return load(file);
}

const BENIGN = [/^=+$/, /^Processing File:/, /^Output:/, /^Overwriting /, /^Schema validation succeeded\.?$/, /^Semantic validation complete/, /^$/];
// messages denigma also prints for Finale's own files (measured on 138 original corpus files, see README):
// musxdom's Info-level note about stems of whole rests, and the MNX exporter's missing clef on TAB staves
export const KNOWN = [/Stem direction unavailable for entry \d+; using stored entry direction\./,
  // the MNX exporter cannot express a hidden grace note (informational)
  /Skipping hidden entry \d+ in an MNX grace-note run\./];
const TAB_CLEF = /Missing clef at the beginning of staff \d+ in part P(\d+) \(first measure\)/;
export function runDenigma(bin, musxPath) {
  const r = spawnSync(bin, ['export', musxPath, '--mnx', '--force'], { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 30 });
  const raw = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map(s => s.trim());
  // a part name with a line break in it splits a "[part m1 s1layer1] …" message over several lines: join them
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    if (/^\[[^\]]*$/.test(l)) while (i + 1 < raw.length && !l.includes(']')) l += ' ' + raw[++i];
    lines.push(l);
  }
  // a semantic-validation report quotes the MNX it complains about: keep only the messages themselves
  const msgs = [];
  let quoting = false;   // inside "At /path of { …quoted MNX… } - message"
  for (const l of lines) {
    if (BENIGN.some(re => re.test(l))) continue;
    if (/^Semantic validation errors:?$/.test(l)) continue;
    if (/^At \//.test(l)) { quoting = true; continue; }
    const m = /^\}\s*-\s*(.*)$/.exec(l);
    if (m) { msgs.push(m[1]); quoting = false; continue; }
    if (quoting) continue;
    if (/^[\s{}[\]",:0-9a-zA-Z_.-]*$/.test(l) && /^[{}\[\]"]/.test(l)) continue;   // quoted JSON
    msgs.push(l);
  }
  const info = msgs.filter(l => KNOWN.some(re => re.test(l)));
  const tabClef = msgs.filter(l => TAB_CLEF.test(l));
  const problems = msgs.filter(l => !KNOWN.some(re => re.test(l)) && !TAB_CLEF.test(l));
  const mnxPath = musxPath.replace(/\.musx$/i, '.mnx');
  let mnx = null;
  try { mnx = JSON.parse(fs.readFileSync(mnxPath, 'utf8')); } catch (e) { problems.push('no MNX output: ' + e.message); }
  return { status: r.status, problems, info, tabClef, mnx, mnxPath };
}

/** The facts of the score in the terms MNX can be compared in. */
function scoreFacts(score) {
  const f = facts(score, { ottavaWritten: true });
  const staves = staffList(score);
  const skip = new Set(staves.filter(s => s.staff.type !== 'standard').map(s => s.globalIndex));
  const hidden = new Set();
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach(v => { let t = 0; for (const ev of v) { if (ev.hidden && ev.kind === 'note') for (const n of ev.notes) hidden.add(`${mi}|${si}|${t}`); t += durTicks(ev); } })));
  f.notes = f.notes.filter(n => !skip.has(n.si) && !hidden.has(`${n.mi}|${n.si}|${n.tick}`));
  // drums (General MIDI key and line of the drum map) and TAB (pitch of string and fret)
  f.drums = []; f.tab = [];
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => {
    const st = staves[si].staff;
    if (st.type !== 'percussion' && st.type !== 'tab') return;
    const tuning = st.type === 'tab' ? (st.tuning || []).map(x => { const p = /^([A-G])(#|b)?(-?\d+)$/.exec(x); return p ? midiOf({ step: p[1], octave: +p[3], alter: p[2] === '#' ? 1 : p[2] === 'b' ? -1 : 0 }) : 0; }) : [];
    sm.voices.forEach(v => { let t = 0; for (const ev of v) {
      if (ev.kind === 'note' && !ev.hidden) for (const n of ev.notes) {
        if (st.type === 'percussion') { const d = st.drumMap?.[n.drum]; if (d) f.drums.push({ mi, si, tick: Math.round(t), midi: d.midi, pos: 4 - d.line }); }
        else if (n.string >= 1 && n.string <= tuning.length) f.tab.push({ mi, si, tick: Math.round(t), midi: tuning[tuning.length - n.string] + (n.fret || 0) });
      }
      t += durTicks(ev);
    } });
  }));
  // dynamics, refShift-free concert key as Finale stores it
  f.dynamics = [];
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach(v => { let t = 0; for (const ev of v) { if (ev.dynamic) f.dynamics.push({ mi, si, tick: t, value: ev.dynamic }); t += durTicks(ev); } })));
  return f;
}
const ms = (list) => { const m = new Map(); for (const k of list) m.set(k, (m.get(k) || 0) + 1); return m; };
function diff(a, b, { tickTolerance = false } = {}) {
  const ma = ms(a); let common = 0; let onlyB = [];
  for (const k of b) { const c = ma.get(k) || 0; if (c > 0) { ma.set(k, c - 1); common++; } else onlyB.push(k); }
  let onlyA = []; for (const [k, c] of ma) for (let i = 0; i < c; i++) onlyA.push(k);
  if (tickTolerance && onlyA.length && onlyB.length) {
    // onsets inside tuplets: MNX gives exact fractions, JSE whole ticks — one tick apart is the same onset
    const rest = new Map(); const keyOf = (k, d) => { const p = k.split('|'); p[2] = String(+p[2] + d); return p.join('|'); };
    for (const k of onlyB) rest.set(k, (rest.get(k) || 0) + 1);
    const leftA = [];
    for (const k of onlyA) {
      const hit = [-1, 1].map(d => keyOf(k, d)).find(x => rest.get(x) > 0);
      if (hit) { rest.set(hit, rest.get(hit) - 1); common++; } else leftA.push(k);
    }
    onlyA = leftA; onlyB = []; for (const [k, c] of rest) for (let i = 0; i < c; i++) onlyB.push(k);
  }
  return { a: a.length, b: b.length, common, onlyA: onlyA.slice(0, 10), onlyB: onlyB.slice(0, 10) };
}
export function compareMnx(score, mnx) {
  const A = scoreFacts(score), B = mnxFacts(mnx, score);
  const r = { problems: B.problems, measures: [A.measures, B.measures] };
  r.notes = diff(A.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.dur}`), B.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.dur}`), { tickTolerance: true });
  r.ties = diff(A.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.tie}`), B.notes.map(n => `${n.mi}|${n.si}|${n.tick}|${n.midi}|${n.tie}`), { tickTolerance: true });
  r.lyrics = diff(A.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${l.text}|${l.syllabic}`), B.lyrics.map(l => `${l.mi}|${l.pi}|${l.tick}|${l.verse}|${String(l.text).replace(/ /g, ' ').replace(/‑/g, '-')}|${l.syllabic}`), { tickTolerance: true });
  r.dynamics = diff(A.dynamics.map(d => `${d.mi}|${d.si}|${d.tick}|${d.value}`), B.dynamics.map(d => `${d.mi}|${d.si}|${d.tick}|${d.value}`), { tickTolerance: true });
  // drums: where and on which line; and, where denigma names a General MIDI sound (a note type with one of its own —
  // musxdom does not follow a type to its parent, e.g. "Snare Rim Shot"), that it is the drum's sound
  const at = (d) => `${d.mi}|${d.si}|${d.tick}|${d.pos}`;
  r.drums = diff(A.drums.map(at), B.drums.map(at));
  const withSound = new Set(B.drums.filter(d => d.midi >= 0).map(at));
  r.drumSounds = diff(A.drums.filter(d => withSound.has(at(d))).map(d => `${at(d)}|${d.midi}`), B.drums.filter(d => d.midi >= 0).map(d => `${at(d)}|${d.midi}`));
  r.tab = diff(A.tab.map(d => `${d.mi}|${d.si}|${d.tick}|${d.midi}`), B.tab.map(d => `${d.mi}|${d.si}|${d.tick}|${d.midi}`));
  const n = Math.min(A.measures, B.measures);
  const idx = (xa, xb) => { const o = []; for (let i = 0; i < n; i++) if (String(xa[i]) !== String(xb[i])) o.push(`m${i + 1}: ${xa[i]} ≠ ${xb[i]}`); return o; };
  r.meter = idx(A.meter, B.meter).filter(d => { const mi = +/^m(\d+)/.exec(d)[1] - 1; return !score.measures[mi]?.pickup; });
  // MNX gives the concert key; a ScoreDoc keeps the key of its reference staff (the first staff that does not transpose)
  const std = staffList(score).filter(s => (s.staff.type || 'standard') === 'standard');
  const shiftOf = (p) => { const c = Math.round(p.transposeChromatic || 0); const o = Math.trunc(c / 12), r = c - o * 12; const T = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4, 8: 5, 9: 5, 10: 6, 11: 6 }; const d = o * 7 + (r < 0 ? -T[-r] : T[r]); return 7 * c - 12 * d; };
  const ref = (std.find(s => shiftOf(s.part) === 0) || std[0]);
  const refShift = ref ? shiftOf(ref.part) : 0;
  const wrap = (f) => { while (f > 7) f -= 12; while (f < -7) f += 12; return f; };
  const refKeys = score.measures.reduce((acc, m, mi) => { acc.push(m.keySig ? wrap(m.keySig.fifths + refShift) : (acc[mi - 1] ?? wrap(refShift))); return acc; }, []);
  r.keys = idx(refKeys, B.keys);
  // repeat barlines per measure as MNX has them: a start repeat (also after a "repeat both ways" barline of the
  // measure before) and an end repeat
  const rep = score.measures.map((m, i) => {
    const start = m.barlineLeft === 'repeat-start' || score.measures[i - 1]?.barlineRight === 'repeat-both';
    const end = m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both';
    return [start ? '|:' : '', end ? ':|' : ''].filter(Boolean).join(' ');
  });
  r.repeats = idx(rep, B.repeats);
  const cnt = (t) => score.spanners.filter(s => s.type === t).length;
  r.lines = { slur: [cnt('slur'), B.slurs], wedge: [cnt('crescendo') + cnt('diminuendo'), B.wedges.length], ottava: [cnt('ottava'), B.ottavas], volta: [cnt('volta'), B.endings.length] };
  return r;
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const outDir = opt('--out') || '/tmp/musx-denigma';
  const bin = opt('--denigma') || process.env.DENIGMA || 'denigma';
  const limit = +(opt('--limit') || 0) || Infinity, every = +(opt('--every') || 1) || 1;
  const verbose = args.includes('--verbose');
  const skipVals = new Set(['--out', '--denigma', '--limit', '--every', '--json'].map(k => opt(k)).filter(Boolean));
  const inputs = args.filter(a => !a.startsWith('--') && !skipVals.has(a));
  const files = [];
  const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); else if (/\.(musx|ftmx|mscz|mscx|mxl|musicxml|xml|nwc|nwctxt|json)$/i.test(p)) files.push(p); };
  inputs.forEach(walk);
  fs.mkdirSync(outDir, { recursive: true });
  const tot = { files: 0, exported: 0, exportFailed: 0, denigmaProblems: 0, mnxFailed: 0, notes: [0, 0, 0], ties: [0, 0, 0], lyrics: [0, 0, 0], dynamics: [0, 0, 0], drums: [0, 0, 0], drumSounds: [0, 0, 0], tab: [0, 0, 0], meterDiff: 0, keyDiff: 0, repeatDiff: 0, lines: {}, identical: 0 };
  const report = [];
  const add = (k, x) => { tot[k][0] += x.a; tot[k][1] += x.b; tot[k][2] += x.common; };
  const t0 = Date.now();
  for (const [i, f] of files.filter((_, i) => i % every === 0).slice(0, limit).entries()) {
    tot.files++;
    const name = String(i).padStart(4, '0') + '-' + path.basename(f).replace(/[^\w.-]+/g, '_').replace(/\.\w+$/, '');
    const rec = { file: f, name };
    let score;
    try { score = await loadAny(f); if (!score?.parts?.length || !score.measures?.length) throw new Error('not a score'); } catch (e) { tot.unreadable = (tot.unreadable || 0) + 1; rec.unreadable = e.message; report.push(rec); continue; }
    try {
      const warnings = [];
      const bytes = await exportMusx(score, { JSZip, warnings });
      const mp = path.join(outDir, name + '.musx');
      fs.writeFileSync(mp, bytes);
      tot.exported++;
      rec.warnings = warnings;
      const d = runDenigma(bin, mp);
      const tabParts = new Set(score.parts.map((p, pi) => p.staves.some(st => st.type === 'tab') ? String(pi + 1) : null).filter(Boolean));
      for (const l of d.tabClef) if (!tabParts.has(/part P(\d+)/.exec(l)[1])) d.problems.push(l);
      rec.denigma = d.problems; rec.info = d.info;
      if (d.problems.length) tot.denigmaProblems++;
      if (d.info.length) tot.denigmaInfo = (tot.denigmaInfo || 0) + 1;
      if (!d.mnx) { tot.mnxFailed++; report.push(rec); continue; }
      const r = compareMnx(score, d.mnx);
      rec.compare = r;
      for (const k of ['notes', 'ties', 'lyrics', 'dynamics', 'drums', 'drumSounds', 'tab']) add(k, r[k]);
      if (r.meter.length) tot.meterDiff++; if (r.keys.length) tot.keyDiff++; if (r.repeats.length) tot.repeatDiff++;
      for (const [k, [a, b]] of Object.entries(r.lines)) { const t = tot.lines[k] || (tot.lines[k] = [0, 0]); t[0] += a; t[1] += b; }
      const same = ['notes', 'ties', 'lyrics', 'drums', 'drumSounds', 'tab'].every(k => r[k].common === r[k].a && r[k].a === r[k].b) && !r.meter.length && !r.keys.length;
      if (same) tot.identical++;
      if (verbose && (!same || d.problems.length)) console.log(name, JSON.stringify({ problems: d.problems.slice(0, 5), notes: r.notes, ties: r.ties.onlyA.length, lyrics: r.lyrics, drums: r.drums, tab: r.tab, meter: r.meter.slice(0, 3), keys: r.keys.slice(0, 3), repeats: r.repeats.slice(0, 3) }));
      if (!args.includes('--keep')) { try { fs.unlinkSync(d.mnxPath); } catch (_) { /* */ } }
    } catch (e) { tot.exportFailed++; rec.error = e.message; if (verbose) console.log('ERR', f, e.stack); }
    report.push(rec);
  }
  const pct = ([a, b, c]) => (a + b ? (200 * c / (a + b)).toFixed(3) + '%' : '–');
  console.log(`files ${tot.files} · JSE cannot open ${tot.unreadable || 0} · exported ${tot.exported} (failed ${tot.exportFailed}) · denigma problems in ${tot.denigmaProblems} · known informational notes in ${tot.denigmaInfo || 0} · no MNX ${tot.mnxFailed} · identical ${tot.identical} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const k of ['notes', 'ties', 'lyrics', 'dynamics', 'drums', 'drumSounds', 'tab']) console.log(`  ${k.padEnd(9)} JSE ${tot[k][0]} denigma ${tot[k][1]} same ${tot[k][2]} (${pct(tot[k])})`);
  console.log(`  measures with other meter in ${tot.meterDiff} files, other key in ${tot.keyDiff}, other repeat barlines in ${tot.repeatDiff}`);
  console.log('  lines (JSE / denigma):', JSON.stringify(tot.lines));
  const probs = new Map(); for (const r of report) for (const p of r.denigma || []) probs.set(p, (probs.get(p) || 0) + 1);
  for (const [p, n] of [...probs].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  denigma ×${n}: ${p}`);
  for (const r of report.filter(r => r.error).slice(0, 10)) console.log('  ERROR', r.file, r.error);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ totals: tot, report }, null, 1));
}
