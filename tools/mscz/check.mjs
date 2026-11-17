#!/usr/bin/env node
// Imports MuseScore files with app/js/io/mscz.js and reports problems.
//   node tools/mscz/check.mjs <file-or-dir>… [--limit n] [--verbose] [--by-version] [--json out.json] [--export]
//
//   --verbose      list every over-/under-full voice and the stack of every failure
//   --by-version   one summary line per file-format version
//   --export       also run exportMscx on every imported score and re-import it (self round trip)
//   --json f       write per-file results to f
// Files of MuseScore 1.x are counted as "rejected" (the importer refuses them on purpose).
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { importMscz, exportMscx, importMscx } = await import('../../app/js/io/mscz.js');
const { durTicks, measureCapacity, effectiveTimeSig, validateScore } = await import('../../app/js/model/score.js');
const { facts, compare } = await import('./compare.mjs');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const valued = new Set(['--limit', '--json']);
const targets = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
if (!targets.length) { console.error('usage: node tools/mscz/check.mjs <file-or-dir>… [--limit n] [--verbose] [--by-version] [--json out.json] [--export]'); process.exit(2); }
const limit = +(opt('--limit') || 0) || Infinity;
const verbose = args.includes('--verbose'), byVersion = args.includes('--by-version'), doExport = args.includes('--export');

const files = [];
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); } else if (/\.(mscz|mscx)$/i.test(p)) files.push(p);
};
targets.forEach(walk);

/** Counts of one score. */
export function scoreStats(score) {
  const s = { measures: score.measures.length, notes: 0, rests: 0, lyrics: 0, chords: 0, spanners: score.spanners.length, texts: 0, overfull: 0, underfull: 0, issues: [] };
  score.measures.forEach((m, mi) => {
    if (m.chords) s.chords += m.chords.length;
    if (m.texts) s.texts += m.texts.length;
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach((sm, si) => sm.voices.forEach((vv, vi) => {
      let t = 0;
      for (const ev of vv) { t += durTicks(ev); if (ev.kind === 'note') s.notes += ev.notes.length; else s.rests++; if (ev.lyrics) s.lyrics += ev.lyrics.length; if (ev.texts) s.texts += ev.texts.length; }
      if (!vv.length || (vv.length === 1 && vv[0].fullMeasureRest)) return;
      if (t > cap + 2) { s.overfull++; s.issues.push(`OVER m${mi + 1} s${si} v${vi} ${Math.round(t)} > ${cap}`); }
      else if (t < cap - 2 && !m.pickup) { s.underfull++; s.issues.push(`UNDER m${mi + 1} s${si} v${vi} ${Math.round(t)} < ${cap}`); }
    }));
  });
  return s;
}

const total = { files: 0, ok: 0, failed: 0, rejected: 0, measures: 0, notes: 0, lyrics: 0, chords: 0, spanners: 0, texts: 0, overfull: 0, underfull: 0, exportFailed: 0, exportDiff: 0 };
const perVersion = new Map();
const warnCount = new Map(); const errs = []; const results = [];
const t0 = Date.now();
const versionOf = (buf) => { const m = /<museScore version="([0-9.]+)"/.exec(buf.subarray(0, 600).toString('latin1')); return m ? m[1] : null; };
for (const f of files.slice(0, limit)) {
  total.files++;
  const rel = targets.length === 1 && fs.statSync(targets[0]).isDirectory() ? path.relative(targets[0], f) : f;
  let version = '?';
  const bump = (key, n = 1) => { total[key] += n; const v = perVersion.get(version) || perVersion.set(version, { files: 0, ok: 0, failed: 0, rejected: 0, measures: 0, notes: 0, lyrics: 0, chords: 0, spanners: 0, overfull: 0, underfull: 0 }).get(version); if (key in v) v[key] += n; };
  try {
    const buf = fs.readFileSync(f);
    version = versionOf(buf) || '?';
    const score = await importMscz(buf, { JSZip, fileName: path.basename(f) });
    version = score.importInfo.version || version;
    const v = validateScore(score);
    if (!v.ok) throw new Error('invalid: ' + v.errors.slice(0, 3).join('; '));
    const s = scoreStats(score);
    bump('files', 0); perVersion.get(version).files++;
    bump('ok');
    for (const k of ['measures', 'notes', 'lyrics', 'chords', 'spanners', 'overfull', 'underfull']) bump(k, s[k]);
    total.texts += s.texts;
    if (verbose) for (const i of s.issues) console.log(i, JSON.stringify(rel));
    for (const w of score.importInfo.warnings) warnCount.set(w.replace(/: .*$/, ''), (warnCount.get(w.replace(/: .*$/, '')) || 0) + 1);
    const res = { file: rel, version, ok: true, ...s, issues: s.issues.length, warnings: score.importInfo.warnings };
    if (doExport) {
      try {
        // export → import again must give the same music (positions, pitches, spelling, ties, lyrics, chords, clefs, meter, keys, repeats, lines)
        const back = importMscx(exportMscx(score));
        const r = compare(facts(score, { ottavaWritten: true }), facts(back, { ottavaWritten: true }));
        const diff = {};
        for (const k of ['staffPitch', 'spell', 'tie', 'lyrics', 'syllabic', 'chords', 'clefs']) if (r[k].a !== r[k].common || r[k].b !== r[k].common) diff[k] = [r[k].a, r[k].b, r[k].common];
        for (const k of ['meter', 'keys', 'repeats']) if (r[k].length) diff[k] = r[k].length;
        if (r.measuresA !== r.measuresB) diff.measures = [r.measuresA, r.measuresB];
        const spanKey = x => JSON.stringify(Object.entries(x).sort());
        if (spanKey(r.spanners.a) !== spanKey(r.spanners.b)) diff.spanners = [r.spanners.a, r.spanners.b];
        if (Object.keys(diff).length) { total.exportDiff++; res.exportDiff = diff; if (verbose) console.log('EXPORT-DIFF', JSON.stringify(rel), JSON.stringify(diff)); }
      } catch (e) { total.exportFailed++; res.exportError = e.message; errs.push(`${rel}: export: ${e.message}${verbose ? '\n' + e.stack : ''}`); }
    }
    results.push(res);
  } catch (e) {
    if (/1\.x/.test(e.message)) { bump('files', 0); perVersion.get(version).files++; bump('rejected'); results.push({ file: rel, version, rejected: true }); continue; }
    bump('files', 0); perVersion.get(version).files++;
    bump('failed');
    errs.push(`${rel}: ${e.message}${verbose ? '\n' + e.stack : ''}`);
    results.push({ file: rel, version, ok: false, error: e.message });
  }
}
console.log(`files ${total.files} ok ${total.ok} failed ${total.failed} rejected(1.x) ${total.rejected} · measures ${total.measures} notes ${total.notes} lyrics ${total.lyrics} chords ${total.chords} spanners ${total.spanners} texts ${total.texts} · overfull voices ${total.overfull} underfull ${total.underfull}${doExport ? ` · export failed ${total.exportFailed} differing ${total.exportDiff}` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (byVersion) for (const [v, s] of [...perVersion.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) console.log(`  v${v}: files ${s.files} ok ${s.ok} failed ${s.failed}${s.rejected ? ` rejected ${s.rejected}` : ''} · measures ${s.measures} notes ${s.notes} lyrics ${s.lyrics} chords ${s.chords} spanners ${s.spanners} · over ${s.overfull} under ${s.underfull}`);
for (const [w, n] of [...warnCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  warn ×${n}: ${w}`);
for (const e of errs.slice(0, verbose ? 200 : 20)) console.log('  ERR', e);
if (errs.length > 20 && !verbose) console.log(`  … ${errs.length - 20} more errors (use --verbose)`);
const jsonOut = opt('--json');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ total, perVersion: Object.fromEntries(perVersion), results }, null, 1));
