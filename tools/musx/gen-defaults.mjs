#!/usr/bin/env node
// Builds app/js/io/musx-defaults.js — the global Finale data the .musx writer needs — from one of Finale's own
// factory default documents ("Maestro Font Default.ftmx", shipped with Finale 25–27 under Music Files/Default Files).
//
//   node tools/musx/gen-defaults.mjs [<default .ftmx/.musx>] [--out app/js/io/musx-defaults.js]
//
// What is taken (as data, re-encoded in a compact notation — not the file):
//   * every document-options section (<options>, minus the Mac print record), as Finale 26.1 writes it;
//   * small global records Finale writes into every document: fonts, layer attributes, spacing allotments, marking
//     categories, playback defaults, the line styles and shapes the options refer to, lyric/chord/expression baselines;
//   * the library definitions JSE uses: the articulations and dynamics of the default library, and one template
//     expression per marking category.
// The record-type order (Finale writes record types in a fixed order) comes from the corpus survey and is listed below.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
globalThis.JSZip = require(path.join(here, '../../app/vendor/jszip.min.js'));
const { readEnigmaXml } = await import('../../app/js/io/musx.js');
const { parseXML } = await import('../../app/js/io/musicxml.js');
const { etnEncode, etnDecode } = await import('../../app/js/io/musx-write.js');

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--')) || '/home/claude/finale-corpus/common/Music Files/Default Files/Maestro Font Default.ftmx';
const outArg = args.indexOf('--out');
const out = outArg >= 0 ? args[outArg + 1] : path.join(here, '../../app/js/io/musx-defaults.js');

const { xml } = await readEnigmaXml(fs.readFileSync(src), { JSZip: globalThis.JSZip });
const root = parseXML(xml).children.find(c => c.tag === 'finale');
const sec = (t) => root.children.find(c => c.tag === t);
const scoreOnly = (n) => n.attrs.part == null;
const pick = (section, tag, cmpers) => sec(section).children.filter(c => c.tag === tag && scoreOnly(c) && (!cmpers || cmpers.includes(+(c.attrs.cmper ?? c.attrs.cmper1))));
const one = (section, tag, cmper) => pick(section, tag, [cmper])[0];

// ---- options -----------------------------------------------------------------------------------------------------
const options = sec('options').children.filter(c => c.tag !== 'printRecordCocoa').map(c => JSON.parse(JSON.stringify(c)));
// Finale 26.1 (the version the writer declares) writes the grid/guide units; 26.3+ leave the default out.
const grid = options.find(o => o.tag === 'gridGuideOptions');
const insertAfter = (node, afterTag, el) => { const i = node.children.findIndex(c => c.tag === afterTag); node.children.splice(i + 1, 0, el); };
if (!grid.children.some(c => c.tag === 'gridUnits')) insertAfter(grid, 'drawFreqY', { tag: 'gridUnits', attrs: {}, children: [], text: 'inches' });
if (!grid.children.some(c => c.tag === 'guideUnits')) insertAfter(grid, 'snapGuideTuplets', { tag: 'guideUnits', attrs: {}, children: [], text: 'inches' });

// ---- static others / details -------------------------------------------------------------------------------------
const staticOthers = [
  ...pick('others', 'durAllot'), ...pick('others', 'fontName'), ...pick('others', 'hpOptions'), ...pick('others', 'layerAtts'),
  ...pick('others', 'metaClef'), ...pick('others', 'playDefs'),
  ...pick('others', 'shapeData', [2, 3, 52]), ...pick('others', 'shapeDef', [2, 3, 35]), ...pick('others', 'shapeList', [2, 3, 52]),
  ...pick('others', 'measNumbRegion'), ...pick('others', 'ssLineStyle', [1, 2, 3, 5, 6]), ...pick('others', 'viSetup'), ...pick('others', 'moviePlayerState'),
  ...pick('others', 'markingsCategory'), ...pick('others', 'markingsCategoryName'),
  ...pick('others', 'categoryStaffListParts'), ...pick('others', 'categoryStaffListScore'),
];
// texts of the line styles taken above (Ped. / * of the pedal line, rit. of the dashed text line)
const staticTexts = sec('texts').children.filter(t => t.tag === 'smartShapeText' && [3, 4, 5].includes(+t.attrs.number));
const staticDetails = ['baselinesChords', 'baselinesExprAboveStaff', 'baselinesExprBelowStaff', 'baselinesLyricsChorus', 'baselinesLyricsSection', 'baselinesLyricsVerse'].flatMap(t => pick('details', t));

// ---- library: articulations (articDef cmper in the default library → JSE name) -------------------------------------
const ARTIC = { staccato: 1, staccatissimo: 2, tenuto: 3, 'tenuto-staccato': 4, accent: 5, 'accent-staccato': 6, 'accent-tenuto': 7,
  marcato: 8, 'marcato-staccato': 9, 'inverted-mordent': 10, mordent: 11, turn: 12, trill: 18, fermata: 26, trem1: 27, trem2: 28, trem3: 29, arpeggio: 38 };
const artics = {};
for (const [name, cmper] of Object.entries(ARTIC)) { const d = one('others', 'articDef', cmper); if (!d) throw new Error('articDef ' + cmper); artics[name] = d.children; }

// ---- library: expressions (textExprDef + its text) ----------------------------------------------------------------
const textBlocks = new Map(pick('others', 'textBlock').map(t => [t.attrs.cmper, t]));
const exprTexts = new Map(sec('texts').children.filter(t => t.tag === 'expression').map(t => [t.attrs.number, t.text]));
const kid = (n, t) => n.children.find(c => c.tag === t);
function expression(cmper) {
  const def = one('others', 'textExprDef', cmper);
  const tb = textBlocks.get(kid(def, 'textIDKey').text);
  return { def: def.children.filter(c => c.tag !== 'textIDKey'), block: tb.children.filter(c => c.tag !== 'textID'), text: exprTexts.get(kid(tb, 'textID').text) };
}
const DYN = { ffff: 1, fff: 2, ff: 3, f: 4, mf: 5, mp: 6, p: 7, pp: 8, ppp: 9, pppp: 10, fp: 11, fz: 12, sf: 13, sfz: 14, sffz: 15, sfp: 16, sfpp: 17, sfzp: 18, rfz: 19, rf: 20 };
const dynamics = {};
for (const [name, cmper] of Object.entries(DYN)) dynamics[name] = expression(cmper);
// one template per marking category: dynamics (mf), tempo mark (Allegro), tempo alteration (a tempo),
// expressive text (agitato), technique text (solo), rehearsal letters (with its enclosure)
const templates = { dynamics: expression(5), tempo: expression(36), tempoAlt: expression(59), expressive: expression(76), technique: expression(114), rehearsal: expression(143) };
templates.rehearsal.enclosure = one('others', 'textExpressionEnclosure', 143).children;

// ---- emit ----------------------------------------------------------------------------------------------------------
const enc = (nodes) => etnEncode(nodes);
const check = (nodes, label) => {
  const back = etnDecode(enc(nodes));
  const norm = (ns) => JSON.stringify(ns.map(function n(x) { return { t: x.tag, a: x.attrs, c: x.children.map(n), v: x.children.length ? '' : (x.text || '').trim() }; }));
  if (norm(back) !== norm(nodes)) throw new Error('ETN round trip failed: ' + label);
  return enc(nodes);
};
const js = (s) => JSON.stringify(s);
const lines = [];
lines.push('// GENERATED by tools/musx/gen-defaults.mjs from Finale\'s factory default document "' + path.basename(src) + '"');
lines.push('// (Finale 25–27 Default Files). Global data for the .musx writer (musx-write.js), in the compact notation of');
lines.push('// etnDecode(): name[attr=v]=value | name{children} | name*(v v v) for repeated leaves. Do not edit by hand.');
lines.push('');
lines.push('export const OPTIONS = ' + js(check(options, 'options')) + ';');
lines.push('export const STATIC_OTHERS = ' + js(check(staticOthers, 'others')) + ';');
lines.push('export const STATIC_DETAILS = ' + js(check(staticDetails, 'details')) + ';');
lines.push('export const STATIC_TEXTS = ' + js(check(staticTexts, 'texts')) + ';');
lines.push('export const ARTICS = {');
for (const [k, v] of Object.entries(artics)) lines.push(`  ${js(k)}: ${js(check(v, k))},`);
lines.push('};');
const exprOut = (e) => `{ def: ${js(check(e.def, 'def'))}, block: ${js(check(e.block, 'block'))}, text: ${js(e.text)}${e.enclosure ? `, enclosure: ${js(check(e.enclosure, 'encl'))}` : ''} }`;
lines.push('export const DYNAMICS = {');
for (const [k, v] of Object.entries(dynamics)) lines.push(`  ${js(k)}: ${exprOut(v)},`);
lines.push('};');
lines.push('export const EXPRESSION_TEMPLATES = {');
for (const [k, v] of Object.entries(templates)) lines.push(`  ${k}: ${exprOut(v)},`);
lines.push('};');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)} (${fs.statSync(out).size} bytes)`);
