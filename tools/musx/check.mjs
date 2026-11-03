#!/usr/bin/env node
// Imports Finale files with app/js/io/musx.js and reports problems.
//   node tools/musx/check.mjs <file-or-dir> [--limit n] [--verbose] [--json out.json]
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
globalThis.JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
const { importMusx } = await import('../../app/js/io/musx.js');
const { durTicks, measureCapacity, effectiveTimeSig, validateScore } = await import('../../app/js/model/score.js');
const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--')) || '/home/claude/finale-corpus';
const limit = +(args[args.indexOf('--limit') + 1] || 0) || Infinity;
const verbose = args.includes('--verbose');
const files = [];
(function walk(p) { const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); else if (/\.(musx|ftmx)$/i.test(p)) files.push(p); })(target);
let ok = 0, failed = 0, notes = 0, measures = 0, overfull = 0, underfull = 0, lyrics = 0, chords = 0, spanners = 0;
const warnCount = new Map(); const errs = []; const t0 = Date.now();
for (const f of files.slice(0, limit)) {
  try {
    const score = await importMusx(fs.readFileSync(f));
    const v = validateScore(score);
    if (!v.ok) throw new Error('invalid: ' + v.errors.slice(0, 3).join('; '));
    ok++; measures += score.measures.length; spanners += score.spanners.length;
    score.measures.forEach((m, mi) => {
      if (m.chords) chords += m.chords.length;
      const cap = measureCapacity(effectiveTimeSig(score, mi));
      m.staves.forEach((sm, si) => sm.voices.forEach((vv, vi) => {
        let t = 0; for (const ev of vv) { t += durTicks(ev); if (ev.kind === 'note') notes++; if (ev.lyrics) lyrics += ev.lyrics.length; }
        if (!vv.length || (vv.length === 1 && vv[0].fullMeasureRest)) return;
        if (t > cap + 2) { overfull++; if (verbose) console.log('OVER', JSON.stringify(path.relative(target, f)), 'm' + (mi + 1), 's' + si, 'v' + vi, t, '>', cap); }
        else if (t < cap - 2 && !(mi === 0 && m.pickup)) { underfull++; if (verbose) console.log('UNDER', JSON.stringify(path.relative(target, f)), 'm' + (mi + 1), 's' + si, 'v' + vi, t, '<', cap); }
      }));
    });
    for (const w of score.importInfo.warnings) warnCount.set(w, (warnCount.get(w) || 0) + 1);
  } catch (e) { failed++; errs.push(`${path.relative(target, f)}: ${e.message}${verbose ? '\n' + e.stack : ''}`); }
}
console.log(`files ${Math.min(files.length, limit)} ok ${ok} failed ${failed} · measures ${measures} notes ${notes} lyrics ${lyrics} chords ${chords} spanners ${spanners} · overfull voices ${overfull} underfull ${underfull} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [w, n] of warnCount) console.log(`  warn ×${n}: ${w}`);
for (const e of errs.slice(0, 20)) console.log('  ERR', e);
