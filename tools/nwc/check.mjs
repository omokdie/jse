#!/usr/bin/env node
// Imports NoteWorthy Composer files with app/js/io/nwc.js and reports problems.
//   node tools/nwc/check.mjs <file-or-dir…> [--limit n] [--verbose] [--encoding euc-kr] [--fallback euc-kr]
//                            [--list] [--lyrics] [--export] [--out dir]
//   --list     one line per file (version, encoding, staves, measures, notes, lyrics, chords, over/under-full)
//   --lyrics   print the first lyric syllables of every file (to eyeball the text encoding)
//   --export   also export every imported score (nwctxt, .nwc 2.75, .nwc 1.75), import the result
//              again and compare notes / lyrics / chords / bar lines / repeats with the first import
//   --out dir  with --export: keep the exported files there (to feed them to other NWC readers)
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const nwc = await import(path.join(here, '../../app/js/io/nwc.js'));
const { durTicks, measureCapacity, effectiveTimeSig, validateScore, midiOf } = await import(path.join(here, '../../app/js/model/score.js'));

const args = process.argv.slice(2);
const val = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flags = new Set(['--limit', '--encoding', '--fallback', '--out']);
const targets = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1]));
const limit = +val('--limit', 0) || Infinity;
const verbose = args.includes('--verbose');
const outDir = val('--out', '');
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const encoding = val('--encoding', 'auto'), fallbackEncoding = val('--fallback', 'windows-1252');
if (!targets.length) { console.log('usage: node tools/nwc/check.mjs <file-or-dir…> [--limit n] [--verbose] [--list] [--lyrics] [--export] [--out dir] [--encoding id] [--fallback id]'); process.exit(1); }

const files = [];
for (const t of targets) (function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) { if (['.git', 'node_modules'].includes(path.basename(p))) return; for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); }
  else if (/\.(nwc|nwctxt)$/i.test(p) || targets.includes(p)) files.push(p);
})(t);

/** Counts and a comparable fingerprint of a score. */
function summarize(score) {
  const s = { measures: score.measures.length, staves: score.measures[0] ? score.measures[0].staves.length : 0, notes: 0, rests: 0, lyrics: 0, chords: 0, spanners: score.spanners.length, overfull: 0, underfull: 0, hangul: 0, lyricText: '', bad: [] };
  const fp = [];
  score.measures.forEach((m, mi) => {
    if (m.chords) { s.chords += m.chords.length; fp.push(`m${mi} chords ${m.chords.map(c => c.tick + ':' + c.text).join(',')}`); }
    // structure: signatures, bar lines, repeats, flow signs, tempo
    if (m.timeSig) fp.push(`m${mi} time ${m.timeSig.num}/${m.timeSig.den}`);
    if (m.keySig) fp.push(`m${mi} key ${m.keySig.fifths}`);
    if (m.tempo) fp.push(`m${mi} tempo ${m.tempo.bpm}/${m.tempo.beatUnit}${m.tempo.dots || ''} ${m.tempo.text || ''}`);
    if (m.barlineRight && m.barlineRight !== 'single') fp.push(`m${mi} barR ${m.barlineRight}${m.repeatCount ? ' x' + m.repeatCount : ''}`);
    if (m.barlineLeft) fp.push(`m${mi} barL ${m.barlineLeft}`);
    if (m.markers && m.markers.length) fp.push(`m${mi} markers ${[...m.markers].sort().join(',')}`);
    if (m.rehearsalMark) fp.push(`m${mi} reh ${m.rehearsalMark}`);
    if (m.pickup) fp.push(`m${mi} pickup`);
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => {
      let t = 0;
      for (const ev of v) {
        t += durTicks(ev);
        if (ev.kind === 'note') { s.notes += ev.notes.length; if (!ev.hidden) fp.push(`m${mi}s${si} ${ev.notes.map(n => (n.drum ? n.drum : midiOf(n)) + (n.tieStart ? '~' : '')).join('+')}:${ev.dur.base}${'.'.repeat(ev.dur.dots || 0)}${ev.tuplet ? 't' : ''}${ev.grace ? 'g' : ''}`); }
        else { s.rests++; }
        for (const l of ev.lyrics || []) { s.lyrics++; if (s.lyricText.length < 60) s.lyricText += l.text + ' '; if (/[가-힣]/.test(l.text)) s.hangul++; fp.push(`m${mi}s${si} L${l.verse}:${l.text}`); }
      }
      if (!v.length || (v.length === 1 && v[0].fullMeasureRest)) return;
      if (t > cap + 2) { s.overfull++; s.bad.push(`OVER m${mi + 1} s${si} v${vi} ${t} > ${cap}`); }
      else if (t < cap - 2 && !m.pickup && vi === 0) { s.underfull++; s.bad.push(`UNDER m${mi + 1} s${si} v${vi} ${t} < ${cap}`); }
    }));
  });
  const mIndex = new Map(score.measures.map((m, i) => [m.id, i]));
  const types = {};
  for (const sp of score.spanners) {
    types[sp.type] = (types[sp.type] || 0) + 1;
    if (sp.type === 'volta') fp.push(`volta ${sp.number} m${mIndex.get(sp.from.measureId)}`);
  }
  for (const [k, n] of Object.entries(types)) fp.push(`spanners ${k} ${n}`);
  s.fingerprint = fp;
  return s;
}
function diffFingerprint(a, b) {
  const A = [...a].sort(), B = [...b].sort();
  let i = 0, j = 0, d = 0; const ex = [];
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; continue; }
    d++;
    if (j >= B.length || (i < A.length && A[i] < B[j])) { if (ex.length < 4) ex.push('- ' + A[i]); i++; } else { if (ex.length < 4) ex.push('+ ' + B[j]); j++; }
  }
  return { d, ex };
}

const tot = { ok: 0, failed: 0, measures: 0, notes: 0, lyrics: 0, chords: 0, spanners: 0, overfull: 0, underfull: 0, hangul: 0 };
const perVersion = new Map(), perEncoding = new Map(), warnCount = new Map(), errs = [];
const exp = { tried: 0, same: { nwctxt: 0, nwc275: 0, nwc175: 0 }, diff: { nwctxt: 0, nwc275: 0, nwc175: 0 }, failed: { nwctxt: 0, nwc275: 0, nwc175: 0 } };
const t0 = Date.now();
for (const f of files.slice(0, limit)) {
  const rel = targets.length === 1 && fs.statSync(targets[0]).isDirectory() ? path.relative(targets[0], f) : f;
  try {
    const score = await nwc.importNwc(fs.readFileSync(f), { encoding, fallbackEncoding, fileName: path.basename(f) });
    const v = validateScore(score);
    if (!v.ok) throw new Error('invalid: ' + v.errors.slice(0, 3).join('; '));
    const s = summarize(score); const info = score.importInfo;
    tot.ok++; for (const k of ['measures', 'notes', 'lyrics', 'chords', 'spanners', 'overfull', 'underfull', 'hangul']) tot[k] += s[k];
    const vk = `${info.version}${info.container === 'nwctxt' ? ' (nwctxt)' : ''}`;
    const pv = perVersion.get(vk) || { files: 0, notes: 0, lyrics: 0, overfull: 0, underfull: 0 }; perVersion.set(vk, pv);
    pv.files++; pv.notes += s.notes; pv.lyrics += s.lyrics; pv.overfull += s.overfull; pv.underfull += s.underfull;
    const ek = info.encoding + (info.encodingGuessed ? ' (guessed)' : '');
    perEncoding.set(ek, (perEncoding.get(ek) || 0) + 1);
    for (const w of info.warnings) warnCount.set(w, (warnCount.get(w) || 0) + 1);
    if (args.includes('--list')) console.log(`${vk.padEnd(14)} ${ek.padEnd(22)} st ${String(s.staves).padStart(2)} m ${String(s.measures).padStart(4)} n ${String(s.notes).padStart(5)} ly ${String(s.lyrics).padStart(4)} ch ${String(s.chords).padStart(3)} over ${s.overfull} under ${s.underfull}  ${rel}`);
    if (args.includes('--lyrics') && s.lyrics) console.log(`   ${JSON.stringify(score.meta.title)} ${s.lyricText}`);
    if (verbose) for (const b of s.bad.slice(0, 6)) console.log('  ', b, JSON.stringify(rel));
    if (args.includes('--export')) {
      exp.tried++;
      const makers = {
        nwctxt: async () => new TextEncoder().encode(nwc.exportNwctxt(score)),
        nwc275: () => nwc.exportNwc(score),
        nwc175: () => nwc.exportNwc(score, { version: '1.75' }),
      };
      let base = null;
      for (const [kind, make] of Object.entries(makers)) {
        try {
          const bytes = await make();
          const back = summarize(await nwc.importNwc(bytes));
          if (kind === 'nwctxt') base = back.fingerprint;
          // nwctxt is compared with the imported original; the two .nwc files with the nwctxt result
          const { d, ex } = diffFingerprint(kind === 'nwctxt' ? s.fingerprint : (base || s.fingerprint), back.fingerprint);
          if (d) { exp.diff[kind]++; if (verbose) console.log(`  EXPORT ${kind} differs (${d})`, JSON.stringify(rel), ex.join(' | ')); } else exp.same[kind]++;
          if (outDir) fs.writeFileSync(path.join(outDir, path.basename(f).replace(/\.(nwc|nwctxt)$/i, '') + (kind === 'nwctxt' ? '.nwctxt' : kind === 'nwc275' ? '.v275.nwc' : '.v175.nwc')), bytes);
        } catch (e) { exp.failed[kind]++; if (verbose) console.log(`  EXPORT ${kind} FAILED`, JSON.stringify(rel), e.message, (e.stack || '').split('\n')[1]); }
      }
    }
  } catch (e) { tot.failed++; errs.push(`${rel}: ${e.message}${verbose ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : ''}`); }
}
console.log(`files ${Math.min(files.length, limit)} ok ${tot.ok} failed ${tot.failed} · measures ${tot.measures} notes ${tot.notes} lyrics ${tot.lyrics} (hangul ${tot.hangul}) chords ${tot.chords} spanners ${tot.spanners} · overfull voices ${tot.overfull} underfull ${tot.underfull} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, v] of [...perVersion].sort()) console.log(`  version ${k.padEnd(14)} files ${String(v.files).padStart(4)}  notes ${String(v.notes).padStart(7)}  lyrics ${String(v.lyrics).padStart(6)}  overfull ${v.overfull}  underfull ${v.underfull}`);
for (const [k, n] of [...perEncoding].sort()) console.log(`  encoding ${k}: ${n}`);
if (args.includes('--export')) for (const k of ['nwctxt', 'nwc275', 'nwc175']) console.log(`  export ${k.padEnd(7)} ${exp.tried} scores · same ${exp.same[k]} · differ ${exp.diff[k]} · failed ${exp.failed[k]}`);
for (const [w, n] of [...warnCount].sort((a, b) => b[1] - a[1])) console.log(`  warn ×${n}: ${w}`);
for (const e of errs.slice(0, verbose ? 200 : 20)) console.log('  ERR', e);
