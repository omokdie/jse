#!/usr/bin/env node
// Structural comparison: real Finale files against JSE's export of the same music.
// For every file: original EnigmaXML vs buildEnigmaXml(importMusx(file)). Reports
//   * record types (options / others / details / texts / entries) Finale wrote but the export lacks, and how often;
//   * per record type, the child elements Finale writes in (nearly) every record but the export never writes;
//   * record types the export writes that the original did not have.
//
//   node tools/musx/structure.mjs <file-or-dir>… [--every n] [--limit n] [--json out.json]
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
globalThis.JSZip = JSZip;
const { readEnigmaXml, enigmaToScore } = await import('../../app/js/io/musx.js');
const { buildEnigmaXml } = await import('../../app/js/io/musx-write.js');
const { parseXML } = await import('../../app/js/io/musicxml.js');

/** { 'others:measSpec': { count, kids: Map(tag → records having it) } … } of score-level records. */
export function structure(xml) {
  const root = parseXML(xml).children.find(c => c.tag === 'finale');
  const out = new Map();
  const note = (key, el) => {
    let r = out.get(key); if (!r) out.set(key, r = { count: 0, kids: new Map() });
    r.count++;
    for (const c of new Set(el.children.map(c => c.tag))) r.kids.set(c, (r.kids.get(c) || 0) + 1);
  };
  for (const sec of root.children) {
    if (sec.tag === 'options') { for (const o of sec.children) note(`options:${o.tag}`, o); continue; }
    if (!['others', 'details', 'texts', 'entries'].includes(sec.tag)) continue;
    for (const el of sec.children) if (el.attrs.part == null) note(`${sec.tag}:${el.tag}`, el);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const every = +(opt('--every') || 1) || 1, limit = +(opt('--limit') || 0) || Infinity;
  const skip = new Set([opt('--every'), opt('--limit'), opt('--json')].filter(Boolean));
  const files = [];
  const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); else if (/\.(musx|ftmx)$/i.test(p)) files.push(p); };
  args.filter(a => !a.startsWith('--') && !skip.has(a)).forEach(walk);
  const typeMissing = new Map(), typeExtra = new Map(), kidStats = new Map();   // kidStats: key → { fin: Map(tag→[recs]), ours: Map(tag→recs), finRecs, ourRecs }
  let n = 0;
  for (const f of files.filter((_, i) => i % every === 0).slice(0, limit)) {
    const { xml, meta } = await readEnigmaXml(fs.readFileSync(f), { JSZip });
    const ours = buildEnigmaXml(enigmaToScore(xml, { meta }), {}).xml;
    const A = structure(xml), B = structure(ours);
    n++;
    for (const [k, r] of A) {
      if (!B.has(k)) typeMissing.set(k, (typeMissing.get(k) || 0) + 1);
      let s = kidStats.get(k); if (!s) kidStats.set(k, s = { fin: new Map(), ours: new Map(), finRecs: 0, ourRecs: 0, files: 0 });
      s.finRecs += r.count; s.files++;
      for (const [t, c] of r.kids) s.fin.set(t, (s.fin.get(t) || 0) + c);
    }
    for (const [k, r] of B) {
      if (!A.has(k)) typeExtra.set(k, (typeExtra.get(k) || 0) + 1);
      let s = kidStats.get(k); if (!s) kidStats.set(k, s = { fin: new Map(), ours: new Map(), finRecs: 0, ourRecs: 0, files: 0 });
      s.ourRecs += r.count;
      for (const [t, c] of r.kids) s.ours.set(t, (s.ours.get(t) || 0) + c);
    }
  }
  console.log(`files ${n}`);
  console.log('\nrecord types Finale wrote that the export lacks (files):');
  for (const [k, c] of [...typeMissing].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${k}`);
  console.log('\nrecord types only in the export (files):');
  for (const [k, c] of [...typeExtra].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${k}`);
  console.log('\nchild elements in ≥ 90 % of Finale\'s records of a type that the export writes, but never in ours:');
  for (const [k, s] of [...kidStats].sort()) {
    if (!s.ourRecs || !s.finRecs) continue;
    const miss = [...s.fin].filter(([t, c]) => c >= 0.9 * s.finRecs && !s.ours.has(t)).map(([t, c]) => `${t} (${(100 * c / s.finRecs).toFixed(0)}%)`);
    if (miss.length) console.log(`  ${k}: ${miss.join(', ')}`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ files: n, typeMissing: [...typeMissing], typeExtra: [...typeExtra] }, null, 1));
}
