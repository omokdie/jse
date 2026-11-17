#!/usr/bin/env node
// Round trip through REAL MuseScore, in three steps (MuseScore itself is run by you in between):
//
//   1. node tools/mscz/roundtrip.mjs prepare <out-dir> <score files or dirs…> [--limit n] [--mscx]
//        imports every score (.mscz/.mscx/.mxl/.musicxml/.ssnap/.json), exports it with exportMscz()
//        to <out-dir>/NNN.mscz (or .mscx), keeps the ScoreDoc as NNN.json and writes <out-dir>/job.json
//   2. mscore -j <out-dir>/job.json         (MuseScore 3 or 4, converter mode: writes NNN.musicxml)
//   3. node tools/mscz/roundtrip.mjs verify <out-dir> [--verbose] [--json report.json]
//        compares each NNN.json with MuseScore's NNN.musicxml (pitches, rhythm, lyrics, chords, repeats …)
//        twice: through JSE's MusicXML importer (measure by measure), and by counting notes, lyrics and
//        lines in the MusicXML text itself (so a loss in that importer is not blamed on the export)
//
// See tools/mscz/README.md for the exact MuseScore command lines used.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { exportMscz, exportMscx } = await import('../../app/js/io/mscz.js');
const { load, facts, compare } = await import('./compare.mjs');

const RAW_KEYS = ['notes', 'grace', 'tuplets', 'lyrics', 'lyricsOffNotes', 'chordSymbols', 'dynamics', 'fermata', 'staccato', 'accent', 'tenuto', 'marcato', 'ornaments',
  'slur', 'hairpin', 'pedal', 'ottava', 'trill', 'glissando', 'volta'];
/** What the MusicXML text itself holds (counted without any importer in between). */
function rawCounts(xml) {
  const count = re => (xml.match(re) || []).length;
  let notes = 0, lyrics = 0;
  for (const m of xml.matchAll(/<note\b[\s\S]*?<\/note>/g)) {
    const t = m[0];
    if (!/<rest\b/.test(t) && /<pitch>|<unpitched>/.test(t)) notes++;
    lyrics += (t.match(/<lyric\b[\s\S]*?<\/lyric>/g) || []).filter(l => /<text\b/.test(l)).length;
  }
  const part1 = xml.slice(xml.indexOf('<part id='), xml.indexOf('</part>'));           // a volta is written once per part
  return {
    notes, lyrics, slur: count(/<slur\b[^>]*type="start"/g), hairpin: count(/<wedge\b[^>]*type="(crescendo|diminuendo)"/g),
    pedal: count(/<pedal\b[^>]*type="(start|change|resume|sostenuto)"/g),              // MuseScore 4 writes "resume" for a line without a start hook
    ottava: count(/<octave-shift\b[^>]*type="(up|down)"/g), trill: count(/<wavy-line\b[^>]*type="start"/g),
    glissando: count(/<(glissando|slide)\b[^>]*type="start"/g), volta: (part1.match(/<ending\b[^>]*type="start"/g) || []).length,
    lyricsOffNotes: 0, dynamics: count(/<dynamics\b/g), fermata: count(/<fermata\b/g), chordSymbols: count(/<harmony\b/g),
    // tenuto + staccato is one MusicXML sign (detached-legato); MuseScore 3 writes only the staccato of a marcato-staccato;
    // MuseScore repeats the fermata of a chord on its grace notes; a trill line comes with a trill sign of its own
    staccato: count(/<staccato\b/g) + count(/<detached-legato\b/g), accent: count(/<accent\b/g), tenuto: count(/<tenuto\b/g) + count(/<detached-legato\b/g),
    marcato: count(/<strong-accent\b/g),
    ornaments: count(/<(trill-mark|turn|inverted-turn|mordent|inverted-mordent)\b/g) - count(/<wavy-line\b[^>]*type="start"/g),
    grace: count(/<grace\b/g), tuplets: count(/<tuplet\b[^>]*type="start"/g),
  };
}
/** The same counts of the ScoreDoc that was exported. */
function ownCounts(score) {
  const c = Object.fromEntries(RAW_KEYS.map(k => [k, 0]));
  for (const m of score.measures) {
    c.chordSymbols += (m.chords || []).length;
    for (const sm of m.staves) for (const v of sm.voices) {
      const seen = new Set();
      for (const ev of v) {
        if (ev.kind === 'note') { c.notes += ev.notes.length; if (ev.grace) c.grace += ev.notes.length; }
        // MusicXML has lyrics on notes only: MuseScore leaves out those on rests and on grace notes when it writes MusicXML
        for (const l of ev.lyrics || []) if (l.text) { if (ev.kind === 'note' && !ev.grace) c.lyrics++; else c.lyricsOffNotes++; }
        if (ev.dynamic) c.dynamics++;
        if (ev.fermata) c.fermata++;
        for (const a of ev.articulations || []) { if (/staccato$/.test(a)) c.staccato++; if (/^accent/.test(a)) c.accent++; if (/^tenuto/.test(a)) c.tenuto++; if (/^marcato/.test(a)) c.marcato++; }
        if (ev.kind === 'note') c.ornaments += (ev.ornaments || []).length;
        if (ev.tuplet && !ev.grace && !seen.has(ev.tuplet.id)) { seen.add(ev.tuplet.id); c.tuplets++; }
      }
    }
  }
  for (const sp of score.spanners) { const k = sp.type === 'crescendo' || sp.type === 'diminuendo' ? 'hairpin' : sp.type; if (k in c) c[k]++; }
  return c;
}
const [cmd, outDir, ...rest] = process.argv.slice(2);
const args = rest;
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!cmd || !outDir || !['prepare', 'verify'].includes(cmd)) { console.error('usage: roundtrip.mjs prepare <out-dir> <files…> [--limit n] [--mscx]  |  roundtrip.mjs verify <out-dir> [--verbose] [--json f]'); process.exit(2); }

if (cmd === 'prepare') {
  const limit = +(opt('--limit') || 0) || Infinity, asMscx = args.includes('--mscx');
  const files = [];
  // inside a directory only score files count (an unpacked .mscz also holds container.xml, *.json …);
  // a file named on the command line may be any format load() reads, including a ScoreDoc .json
  const walk = (p, named) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e), false); }
    else if ((named ? /\.(mscz|mscx|mxl|musicxml|xml|ssnap|json)$/i : /\.(mscz|mscx|mxl|musicxml|ssnap)$/i).test(p)) files.push(p);
  };
  args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit').forEach(p => walk(p, true));
  fs.mkdirSync(outDir, { recursive: true });
  const job = [], index = [];
  let n = 0;
  for (const f of files) {
    if (n >= limit) break;
    const id = String(++n).padStart(3, '0');
    try {
      const score = await load(f);
      const warnings = [];
      const out = path.join(outDir, id + (asMscx ? '.mscx' : '.mscz'));
      if (asMscx) fs.writeFileSync(out, exportMscx(score, { warnings })); else fs.writeFileSync(out, await exportMscz(score, { JSZip, warnings }));
      fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify(score));
      job.push({ in: path.resolve(out), out: path.resolve(path.join(outDir, id + '.musicxml')) });
      index.push({ id, source: f, warnings });
    } catch (e) { index.push({ id, source: f, error: e.message }); console.log('ERR', f, e.message); }
  }
  fs.writeFileSync(path.join(outDir, 'job.json'), JSON.stringify(job, null, 1));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`prepared ${job.length} scores in ${outDir} — now run MuseScore:  mscore -j ${path.join(outDir, 'job.json')}`);
} else {
  const verbose = args.includes('--verbose');
  const index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  const keys = ['partPitch', 'partNear', 'partEven', 'staffNear', 'spell', 'tie', 'lyrics', 'syllabic', 'words', 'chords'];
  const sum = {}; let opened = 0, missing = 0, identical = 0; const rows = [];
  const rawSum = { own: Object.fromEntries(RAW_KEYS.map(k => [k, 0])), ms: Object.fromEntries(RAW_KEYS.map(k => [k, 0])), files: 0 };
  for (const it of index) {
    if (it.error) continue;
    const xml = path.join(outDir, it.id + '.musicxml');
    if (!fs.existsSync(xml)) { missing++; console.log('NOT OPENED by MuseScore:', it.id, it.source); continue; }
    opened++;
    const a = JSON.parse(fs.readFileSync(path.join(outDir, it.id + '.json'), 'utf8')), b = await load(xml);
    const own = ownCounts(a), raw = rawCounts(fs.readFileSync(xml, 'utf8'));
    for (const k of RAW_KEYS) { rawSum.own[k] += own[k]; rawSum.ms[k] += raw[k]; }
    const rawDiff = RAW_KEYS.filter(k => own[k] !== raw[k]).map(k => `${k} ${own[k]}→${raw[k]}`);
    if (rawDiff.length) { rawSum.files++; if (verbose) console.log(it.id, path.basename(it.source), 'in MuseScore\'s MusicXML:', rawDiff.join(' · ')); }
    const r = compare(facts(a), facts(b));
    for (const k of keys) { const s = sum[k] || (sum[k] = { a: 0, b: 0, common: 0 }); s.a += r[k].a; s.b += r[k].b; s.common += r[k].common; }
    for (const k of ['meter', 'keys', 'repeats']) sum[k] = (sum[k] || 0) + r[k].length;
    const same = r.measuresA === r.measuresB && ['partEven', 'lyrics', 'chords'].every(k => r[k].a === r[k].common && r[k].b === r[k].common) && !r.meter.length && !r.keys.length && !r.repeats.length;
    if (same) identical++;
    rows.push({ id: it.id, source: it.source, measures: [r.measuresA, r.measuresB], ...Object.fromEntries(keys.map(k => [k, [r[k].a, r[k].b, r[k].common]])), meter: r.meter.length, keys: r.keys.length, repeats: r.repeats.length, spanners: r.spanners, own, raw, same });
    if (verbose && !same) {
      console.log(it.id, path.basename(it.source), `measures ${r.measuresA}/${r.measuresB}`, keys.map(k => `${k} ${r[k].common}/${r[k].a}/${r[k].b}`).join(' · '), `meter ${r.meter.length} keys ${r.keys.length} repeats ${r.repeats.length}`);
      for (const k of ['partEven', 'lyrics', 'chords']) if (r[k].onlyA.length || r[k].onlyB.length) console.log('   ', k, 'ours:', r[k].onlyA.slice(0, 6).join(' '), '| MuseScore:', r[k].onlyB.slice(0, 6).join(' '));
      for (const k of ['meter', 'keys', 'repeats']) if (r[k].length) console.log('   ', k, r[k].slice(0, 4).join('; '));
    }
  }
  const pct = (x) => (x && x.a + x.b ? (200 * x.common / (x.a + x.b)).toFixed(2) + '%' : '–');
  const failed = index.filter(it => it.error).length;
  console.log(`scores exported ${index.length - failed}${failed ? ` (${failed} could not be read or exported — see index.json)` : ''} · opened by MuseScore ${opened} · not opened ${missing} · identical (notes where both rhythms are complete, lyrics, chords, meter, keys, repeats) ${identical}`);
  for (const k of keys) console.log(`  ${k.padEnd(10)} ours ${sum[k]?.a ?? 0} MuseScore ${sum[k]?.b ?? 0} common ${sum[k]?.common ?? 0} (${pct(sum[k])})`);
  console.log(`  differing measures: meter ${sum.meter || 0} keys ${sum.keys || 0} repeats ${sum.repeats || 0}`);
  console.log(`  counted in MuseScore's MusicXML text itself (exported → found), ${rawSum.files} scores with a different count:`);
  console.log('    ' + RAW_KEYS.map(k => `${k} ${rawSum.own[k]} → ${rawSum.ms[k]}`).join(' · '));
  const out = opt('--json'); if (out) fs.writeFileSync(out, JSON.stringify({ sum, raw: rawSum, rows }, null, 1));
}
