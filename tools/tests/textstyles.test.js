// Text styles (font family / size / bold / italic per kind of text): model, engraver, font catalogue, MusicXML, packaging.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEXT_STYLE_KEYS, TEXT_STYLE_DEFAULTS, resolveTextStyle, resolveTextStyles, resolveTextObjectStyle, autoEmphasis,
  normalizeTextStyles, applyTextStyles, textStylesEqual, ptToSp, spToPt, sanitizeFontFamily, cssFontFamily, cssFontStack, fontNeeds, MM_PER_PT,
} from '../../app/js/model/textstyles.js';
import { SP } from '../../app/js/engrave/layout.js';
import { engrave } from '../../app/js/engrave/render.js';
import { TEXT_FONT } from '../../app/js/engrave/text.js';
import { JSE_FONTS, WEB_FONTS_DIR, jseFont, jseFontFile, fontSourceUrls, jseFamiliesIn, embedFontsInSvg, fontFaceCss, fontDisplayName, detectDeviceFonts } from '../../app/js/fonts.js';
import { PAGES_BASE_URL } from '../../app/js/config.js';
import { importMusicXML, exportMusicXML } from '../../app/js/io/musicxml.js';
import { validateScore } from '../../app/js/model/score.js';
import { exampleScore } from '../../app/js/model/examples.js';
import { sampleScore, drumTabScore } from '../fixtures.mjs';
import { syncWww } from '../../mobile/scripts/sync-www.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const clone = o => JSON.parse(JSON.stringify(o));
const svgOf = (score, opts) => engrave(score, opts).pages.map(p => p.svg).join('\n');
/** every <text> element of a class: [{ tag, text }] */
const texts = (svg, cls) => [...svg.matchAll(new RegExp(`<text[^>]*class="${cls}"[^>]*>([^<]*)</text>`, 'g'))].map(m => ({ tag: m[0], text: m[1] }));

// ----------------------------------------------------------------------------- model
test('text styles: keys and built-in defaults match the engraver constants', () => {
  assert.deepEqual(TEXT_STYLE_KEYS, ['title', 'subtitle', 'composer', 'lyricist', 'lyrics', 'chord', 'text', 'tempo', 'rehearsal', 'partName', 'measureNumber']);
  const same = { title: SP.titleSize, subtitle: SP.subtitleSize, composer: SP.composerSize, lyricist: SP.composerSize, lyrics: SP.lyricSize, chord: SP.chordSize, text: SP.textSize, tempo: SP.tempoSize, rehearsal: SP.rehearsalSize, measureNumber: SP.measureNumberSize, partName: 2.2 };
  for (const key of TEXT_STYLE_KEYS) {
    assert.equal(TEXT_STYLE_DEFAULTS[key].size, same[key], key);
    assert.equal(TEXT_STYLE_DEFAULTS[key].family, '', key);
  }
  // what is bold today stays bold by default
  assert.deepEqual(TEXT_STYLE_KEYS.filter(k => TEXT_STYLE_DEFAULTS[k].bold), ['title', 'chord', 'tempo', 'rehearsal']);
  assert.ok(TEXT_STYLE_KEYS.every(k => TEXT_STYLE_DEFAULTS[k].italic === false));
});

test('text styles: resolve merges the stored style over the defaults and ignores junk', () => {
  for (const settings of [undefined, null, {}, { textStyles: null }, { textStyles: {} }]) {
    for (const key of TEXT_STYLE_KEYS) assert.deepEqual(resolveTextStyle(settings, key), { ...TEXT_STYLE_DEFAULTS[key] }, key);
  }
  const settings = { textStyles: { title: { family: 'Nanum Myeongjo', size: 7, bold: false }, lyrics: { italic: true }, chord: { size: 'big', family: 42, bold: 'yes' }, tempo: { size: 1e9 }, text: 'nope' } };
  assert.deepEqual(resolveTextStyle(settings, 'title'), { family: 'Nanum Myeongjo', size: 7, bold: false, italic: false });
  assert.deepEqual(resolveTextStyle(settings, 'lyrics'), { family: '', size: 2.1, bold: false, italic: true });
  assert.deepEqual(resolveTextStyle(settings, 'chord'), { ...TEXT_STYLE_DEFAULTS.chord });       // nothing valid in it
  assert.deepEqual(resolveTextStyle(settings, 'tempo'), { ...TEXT_STYLE_DEFAULTS.tempo });       // absurd size
  assert.deepEqual(resolveTextStyle(settings, 'text'), { ...TEXT_STYLE_DEFAULTS.text });
  assert.deepEqual(Object.keys(resolveTextStyles(settings)), TEXT_STYLE_KEYS);
  // resolving never hands out the frozen default objects
  resolveTextStyle({}, 'title').size = 99;
  assert.equal(TEXT_STYLE_DEFAULTS.title.size, 5.2);
});

test('text styles: points ↔ staff spaces (pt = sp × staffSpaceMm ÷ 0.3528)', () => {
  assert.equal(MM_PER_PT, 0.3528);
  assert.ok(Math.abs(spToPt(2.1, 1.75) - 2.1 * 1.75 / 0.3528) < 1e-3);
  assert.ok(Math.abs(spToPt(5.2, 1.75) - 25.7937) < 1e-3);
  assert.equal(ptToSp(12, 1.75), 2.4192);
  assert.equal(ptToSp(12, 2), 2.1168);                    // a bigger staff needs fewer staff spaces for the same pt
  for (const mm of [1.2, 1.6, 1.75, 2.6]) for (const pt of [6, 8, 10.5, 12, 14, 24, 36, 72]) assert.ok(Math.abs(spToPt(ptToSp(pt, mm), mm) - pt) < 0.01, `${pt}pt @ ${mm}mm`);
  assert.equal(ptToSp(12), ptToSp(12, 1.75));             // default staff space
  assert.equal(ptToSp(12, 0), ptToSp(12, 1.75));          // nonsense staff space → default
});

test('text styles: font family names are validated, never repaired', () => {
  for (const ok of ['Nanum Myeongjo', '맑은 고딕', 'Noto Sans CJK KR', 'HY견고딕', 'Arial', 'D2Coding', 'Segoe UI', 'Times New Roman', 'Source Han Sans K', '1훈떡볶이 R', 'A-OTF Ryumin Pro', 'Font (Std) 2.0']) assert.equal(sanitizeFontFamily(ok), ok, ok);
  assert.equal(sanitizeFontFamily('  Nanum   Gothic '), 'Nanum Gothic');
  assert.equal(sanitizeFontFamily('Nanum\n\tGothic'), 'Nanum Gothic');      // line breaks cannot survive
  for (const bad of ["x'}</style><script>alert(1)</script>", 'a"b', 'a\\b', 'a<b', 'a>b', 'a&b', 'a;b', 'a{b}', 'a\u0000b', 'a,b', '@Malgun Gothic', '.SF NS', '', '   ', 'x'.repeat(81), null, undefined, 42, {}]) assert.equal(sanitizeFontFamily(bad), '', String(bad));
  assert.equal(cssFontFamily('Nanum Myeongjo'), "'Nanum Myeongjo'");
  assert.equal(cssFontFamily('Serif'), 'serif');           // generic keywords stay bare
  assert.equal(cssFontFamily("bad'name"), '');
  assert.equal(cssFontStack('Gowun Batang', 'sans-serif'), "'Gowun Batang',sans-serif");
  assert.equal(cssFontStack('', 'sans-serif'), 'sans-serif');
});

test('text styles: normalize keeps only what differs from the built-in look', () => {
  assert.equal(normalizeTextStyles(undefined), undefined);
  assert.equal(normalizeTextStyles({}), undefined);
  assert.equal(normalizeTextStyles({ title: { family: '', size: 5.2, bold: true, italic: false }, lyrics: {}, bogus: { size: 3 } }), undefined);
  assert.deepEqual(normalizeTextStyles({ title: { family: 'Gowun Batang', size: 5.2, bold: false }, chord: { bold: true, italic: true }, lyrics: { size: 2.41921 }, x: 1 }), { title: { family: 'Gowun Batang', bold: false }, lyrics: { size: 2.4192 }, chord: { italic: true } });
  // free texts: false = automatic (expression stays italic …), the same as leaving it out
  assert.equal(normalizeTextStyles({ text: { bold: false, italic: false } }), undefined);
  assert.deepEqual(normalizeTextStyles({ text: { bold: true, italic: false } }), { text: { bold: true } });
  const score = { settings: { textStyles: { title: { size: 9 } } } };
  assert.equal(applyTextStyles(score, { title: { size: 5.2 } }), undefined);
  assert.equal('textStyles' in score.settings, false);
  assert.deepEqual(applyTextStyles(score, { lyrics: { family: 'Nanum Gothic' } }), { lyrics: { family: 'Nanum Gothic' } });
  assert.ok(textStylesEqual({ title: { bold: true } }, undefined));
  assert.ok(!textStylesEqual({ title: { bold: false } }, undefined));
});

test('text styles: one text object — own font over the score style over what its style implies', () => {
  const expr = { text: 'dolce', style: 'expression' }, tech = { text: 'pizz.', style: 'technique' }, sys = { text: 'Verse 1', style: 'system' };
  assert.deepEqual(autoEmphasis(expr), { italic: true, bold: false });
  assert.deepEqual(autoEmphasis(tech), { italic: false, bold: true });
  assert.deepEqual(autoEmphasis(sys), { italic: false, bold: false });
  assert.deepEqual(autoEmphasis(sys, { measureLevel: true }), { italic: false, bold: true });
  assert.deepEqual(resolveTextObjectStyle({}, expr, autoEmphasis(expr)), { family: '', size: 2.2, bold: false, italic: true, own: false });
  const settings = { textStyles: { text: { family: 'Gowun Batang', size: 3, italic: false } } };
  assert.deepEqual(resolveTextObjectStyle(settings, expr, autoEmphasis(expr)), { family: 'Gowun Batang', size: 3, bold: false, italic: true, own: false });   // false = automatic
  assert.deepEqual(resolveTextObjectStyle({ textStyles: { text: { bold: true } } }, expr, autoEmphasis(expr)), { family: '', size: 2.2, bold: true, italic: true, own: false });
  assert.deepEqual(resolveTextObjectStyle({}, { ...expr, font: { italic: false } }, autoEmphasis(expr)), { family: '', size: 2.2, bold: false, italic: false, own: true });   // one text forced upright
  assert.deepEqual(resolveTextObjectStyle(settings, { ...tech, font: { family: 'Nanum Pen Script', size: 4, bold: false, italic: true } }, autoEmphasis(tech)), { family: 'Nanum Pen Script', size: 4, bold: false, italic: true, own: true });
  assert.deepEqual(resolveTextObjectStyle(settings, { ...tech, font: { size: 4 } }, autoEmphasis(tech)), { family: 'Gowun Batang', size: 4, bold: true, italic: false, own: true });
});

test('text styles: fontNeeds lists the families and weights a score uses', () => {
  const s = sampleScore();
  assert.equal(fontNeeds(s).size, 0);
  s.settings.textStyles = { title: { family: 'Nanum Myeongjo' }, lyrics: { family: 'Nanum Myeongjo' }, chord: { family: 'Old Standard TT', bold: false }, tempo: { family: 'Gowun Dodum' }, text: { family: 'Gowun Batang' } };
  s.measures[0].staves[0].voices[0][0].texts = [{ text: 'pizz.', style: 'technique', font: { family: 'Nanum Pen Script' } }];
  const needs = fontNeeds(s);
  assert.deepEqual([...needs.get('Nanum Myeongjo')].sort(), [400, 700]);      // lyrics regular + title bold
  assert.deepEqual([...needs.get('Old Standard TT')], [400]);
  assert.deepEqual([...needs.get('Gowun Dodum')].sort(), [400, 700]);         // tempo words bold, "= 100" regular
  assert.deepEqual([...needs.get('Gowun Batang')], [400]);                    // the "rit." expression text of the fixture
  assert.deepEqual([...needs.get('Nanum Pen Script')], [700]);                // technique text = bold
});

// ----------------------------------------------------------------------------- engraver
const fixtures = { sample: sampleScore, drumtab: drumTabScore, example: exampleScore };
for (const [name, make] of Object.entries(fixtures)) {
  test(`engraver: output without text styles is unchanged — ${name}`, () => {
    const base = make();
    const plain = svgOf(clone(base));
    assert.ok(!plain.includes('ts-'), 'no style-set class');
    assert.ok(!/style="font-family/.test(plain), 'no inline families');
    assert.equal((plain.match(/font-family:/g) || []).length, engrave(clone(base)).pages.length, 'one font-family rule per page (the base sheet)');
    // an empty object, explicit defaults and junk must all engrave to exactly the same bytes
    const variants = {
      empty: {},
      explicitDefaults: Object.fromEntries(TEXT_STYLE_KEYS.map(k => [k, { ...TEXT_STYLE_DEFAULTS[k] }])),
      junk: { title: { size: 'x', family: "a'b" }, nope: { size: 3 }, lyrics: null },
    };
    for (const [vn, textStyles] of Object.entries(variants)) {
      const s = clone(base); s.settings.textStyles = textStyles;
      assert.equal(svgOf(s), plain, vn);
      assert.equal(svgOf(s, { trimHeight: true }), svgOf(clone(base), { trimHeight: true }), `${vn} (trimHeight)`);
    }
    // the legacy settings.fonts (set by importers) never changes the drawing
    const legacy = clone(base); legacy.settings.fonts = { text: 'Times New Roman', lyrics: 'Arial' };
    assert.equal(svgOf(legacy), plain);
  });
}

test('engraver: the chosen family, size and emphasis reach the SVG', () => {
  const s = sampleScore();
  s.settings.textStyles = {
    title: { family: 'Nanum Myeongjo', size: 7, bold: false, italic: true }, subtitle: { family: 'Gowun Batang', bold: true }, composer: { size: 3.3 }, lyricist: { italic: true },
    lyrics: { family: 'Nanum Pen Script', size: 3.1 }, chord: { family: 'Old Standard TT', size: 2.9, bold: false }, text: { family: 'Gowun Dodum', size: 2.6 },
    tempo: { size: 3.2 }, rehearsal: { size: 3.5, italic: true }, partName: { size: 2.8, italic: true }, measureNumber: { size: 2.2, bold: true },
  };
  const r = engrave(s), svg = r.pages[0].svg;
  const cls = svg.match(/<svg[^>]*class="score-page (ts-[a-z0-9]+)"/)?.[1];
  assert.ok(cls, 'the page carries the class that scopes its font rules');
  const stack = fam => `font-family:'${fam}',${TEXT_FONT.replace(/"/g, "'")}`;
  for (const [fam, c] of [['Nanum Myeongjo', 'title'], ['Gowun Batang', 'subtitle'], ['Nanum Pen Script', 'lyric'], ['Old Standard TT', 'chord'], ['Gowun Dodum', 'mtext']]) {
    assert.ok(svg.includes(`.score-page.${cls} text.${c}`), `rule for .${c}`);
    assert.ok(svg.includes(stack(fam)), `${fam} + fallback stack`);
  }
  assert.ok(svg.includes(`text.chord{${stack('Old Standard TT')};font-weight:400}`), 'chords un-bolded against the base sheet');
  const one = c => texts(svg, c)[0].tag;
  assert.match(one('title'), /font-size="7" font-style="italic" data-field="title"/);                 // not bold any more
  assert.match(one('subtitle'), /font-size="3" font-weight="700" data-field="subtitle"/);
  assert.match(one('composer'), /font-size="3\.3" data-field="composer"/);
  assert.match(one('lyricist'), /font-size="2\.4" font-style="italic"/);
  assert.ok(texts(svg, 'lyric').length > 5 && texts(svg, 'lyric').every(t => / font-size="3\.1"/.test(t.tag)));
  assert.ok(texts(svg, 'chord').every(t => / font-size="2\.9"/.test(t.tag) && !/font-weight/.test(t.tag)));
  assert.match(one('tempo-text'), / font-size="3\.2" font-weight="700"/);
  assert.match(one('tempo-bpm'), / font-size="2\.72"/);                                              // 0.85 × the tempo size
  assert.match(one('rehearsal'), / font-size="3\.5".* font-weight="700" font-style="italic"/);
  assert.match(one('part-name'), /font-size="2\.8" font-style="italic"/);
  assert.match(one('measure-number'), / font-size="2\.2" font-weight="700"/);
  const all = r.pages.map(p => p.svg).join('');
  assert.match(texts(all, 'mtext').find(t => t.text === 'rit.').tag, / font-size="2\.6" font-style="italic"/);   // expression text keeps its italics
  // hit boxes follow the style
  const g = r.pages[0].geometry.texts;
  assert.equal(g.find(t => t.kind === 'lyric').h, 3.1 * 1.2);
  assert.equal(g.find(t => t.kind === 'chord').h, 2.9 * 1.2);
  assert.equal(g.find(t => t.field === 'title').h, 7 * 1.2);
  for (const field of ['subtitle', 'composer', 'lyricist']) assert.ok(g.find(t => t.field === field), `${field} can be clicked`);
});

test('engraver: bigger text takes more room', () => {
  const base = sampleScore();
  const big = clone(base); big.settings.textStyles = { lyrics: { size: 4.2 }, title: { size: 10 } };
  const a = engrave(clone(base)), b = engrave(big);
  const top = r => Math.min(...r.pages[0].geometry.systems.map(s => s.y));
  assert.ok(top(b) > top(a) + 5, 'a taller title block pushes the first system down');
  const width = r => r.pages[0].geometry.measures.find(m => m.mi === 0).width;
  assert.ok(width(b) > width(a) + 0.5, 'wider syllables widen the measure');
  // a very long title still shrinks to fit between the margins in the chosen style
  const long = clone(base); long.meta.title = '아주 긴 제목 '.repeat(14); long.settings.textStyles = { title: { size: 9, family: 'Nanum Myeongjo' } };
  const fs9 = +texts(engrave(long).pages[0].svg, 'title')[0].tag.match(/font-size="([\d.]+)"/)[1];
  assert.ok(fs9 < 9 && fs9 >= 9 * 0.45);
});

test('engraver: a text object with its own font', () => {
  const s = sampleScore();
  s.settings.textStyles = { text: { family: 'Gowun Batang' } };
  const mt = s.measures[4].texts[0];                              // "rit." (expression)
  mt.font = { family: 'Libertinus Serif', size: 3.4, italic: false, bold: true };
  const ev = s.measures[0].staves[0].voices[0][1];
  ev.texts = [{ text: 'same family', style: 'plain', font: { family: 'Gowun Batang', size: 2.9 } }, { text: 'evil', style: 'plain', font: { family: "x'><script>" } }];
  const all = engrave(s).pages.map(p => p.svg).join('');
  const rit = texts(all, 'mtext').find(t => t.text === 'rit.').tag;
  assert.match(rit, / font-size="3\.4" font-weight="700" style="font-family:'Libertinus Serif','Noto Sans KR',/);
  assert.ok(!/font-style/.test(rit), 'own italic:false beats the expression default');
  const same = texts(all, 'etext').find(t => t.text === 'same family').tag;
  assert.ok(/ font-size="2\.9"/.test(same) && !/style=/.test(same), 'the class rule already gives that family');
  assert.ok(!all.includes('<script>') && !/style="[^"]*x'/.test(all), 'a hostile family never reaches the markup');
  const g = engrave(s).pages.flatMap(p => p.geometry.texts);
  assert.deepEqual(g.filter(t => t.kind === 'text').map(t => t.index), [0, 1]);
  assert.equal(g.find(t => t.kind === 'mtext').index, 0);
});

test('engraver: two differently styled scores do not share a rule scope', () => {
  const a = sampleScore(), b = sampleScore();
  a.settings.textStyles = { lyrics: { family: 'Nanum Pen Script' } };
  b.settings.textStyles = { lyrics: { family: 'Gowun Batang' } };
  const ca = svgOf(a).match(/score-page (ts-[a-z0-9]+)/)[1], cb = svgOf(b).match(/score-page (ts-[a-z0-9]+)/)[1];
  assert.notEqual(ca, cb);
  const a2 = sampleScore(); a2.settings.textStyles = { lyrics: { family: 'Nanum Pen Script', size: 3 } };
  assert.equal(svgOf(a2).match(/score-page (ts-[a-z0-9]+)/)[1], ca, 'same rules → same scope (sizes are attributes)');
  const sized = sampleScore(); sized.settings.textStyles = { lyrics: { size: 3 } };
  assert.ok(!svgOf(sized).includes('ts-'), 'sizes alone need no rule');
});

// ----------------------------------------------------------------------------- font catalogue (JSE 글꼴)
test('fonts: the catalogue in fonts.js equals app/fonts/web/manifest.json and the files are there', () => {
  const dir = path.join(root, 'app', WEB_FONTS_DIR);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fonts.length, JSE_FONTS.length);
  assert.ok(JSE_FONTS.length >= 6 && JSE_FONTS.length <= 8);
  let total = 0;
  manifest.fonts.forEach((m, i) => {
    const c = JSE_FONTS[i];
    assert.deepEqual({ family: c.family, ko: c.ko, category: c.category, license: c.license }, { family: m.family, ko: m.ko, category: m.category, license: m.license });
    assert.equal(m.license, 'OFL-1.1');
    assert.equal(sanitizeFontFamily(c.family), c.family);
    assert.deepEqual(Object.keys(c.files), Object.keys(m.files));
    assert.ok(c.files[400], `${c.family} has a regular weight`);
    for (const [w, f] of Object.entries(m.files)) {
      assert.deepEqual(c.files[w], { file: f.file, bytes: f.bytes }, `${c.family} ${w}`);
      const buf = fs.readFileSync(path.join(dir, f.file));
      assert.equal(buf.length, f.bytes, f.file);
      assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOFF', f.file);
      assert.equal(buf.readUInt32BE(8), buf.length, 'WOFF length field');
      assert.equal(buf.readUInt32BE(24) + buf.readUInt32BE(28) + buf.readUInt32BE(36) + buf.readUInt32BE(40), 0, 'no metadata / private block — nothing but the original tables');
      assert.ok(f.sourceBytes > f.bytes && /^[0-9a-f]{64}$/.test(f.sourceSha256));
      total += buf.length;
    }
    const license = fs.readFileSync(path.join(dir, m.licenseFile), 'utf8');
    assert.match(license, /SIL Open Font License, Version 1\.1/, `${m.family}: OFL text shipped`);
    assert.match(license, /PERMISSION & CONDITIONS/, `${m.family}: the whole licence, not a pointer`);
  });
  assert.equal(total, manifest.totalBytes);
  assert.ok(total < 25 * 1024 * 1024, 'budget: 25 MB');
  // Korean serif, Korean sans, a handwriting face and a Latin text face are all there
  for (const cat of ['serif-ko', 'sans-ko', 'hand-ko', 'serif-latin']) assert.ok(JSE_FONTS.some(f => f.category === cat), cat);
});

test('fonts: lookup helpers', () => {
  assert.equal(jseFont('nanum myeongjo').ko, '나눔명조');
  assert.equal(jseFont('Arial'), null);
  assert.equal(jseFontFile(jseFont('Nanum Gothic'), 700).file, 'nanumgothic/NanumGothic-Bold.woff');
  assert.equal(jseFontFile(jseFont('Gowun Dodum'), 700).weight, 400, 'no bold file → the regular one (the browser emboldens it)');
  assert.equal(fontDisplayName(''), '기본');
  assert.equal(fontDisplayName('Gowun Batang'), '고운바탕');
  assert.equal(fontDisplayName('Malgun Gothic'), '맑은 고딕');
  assert.equal(fontDisplayName('Some Font'), 'Some Font');
  assert.deepEqual(detectDeviceFonts(), [], 'no DOM → nothing detected, no crash');
  assert.deepEqual(jseFamiliesIn("text.lyric{font-family:'Nanum Pen Script','Noto Sans KR'} 'Gowun Batang'"), ['Gowun Batang', 'Nanum Pen Script']);
  // nothing is loaded in Node: embedding leaves the SVG alone
  const s = sampleScore(); s.settings.textStyles = { lyrics: { family: 'Nanum Pen Script' } };
  const svg = engrave(s).pages[0].svg;
  assert.deepEqual(jseFamiliesIn(svg), ['Nanum Pen Script']);
  assert.equal(fontFaceCss(['Nanum Pen Script']), '');
  assert.equal(embedFontsInSvg(svg), svg);
});

test('fonts: where a font file is fetched from', () => {
  const file = 'nanumgothic/NanumGothic-Regular.woff';
  assert.match(PAGES_BASE_URL, /^https:\/\/[a-z0-9-]+\.github\.io\/[^/]+\/$/i);
  const remote = `${PAGES_BASE_URL}fonts/web/${file}`;
  // web / PWA: own origin first, the project site as fallback
  assert.deepEqual(fontSourceUrls(file, { href: 'https://example.org/app/index.html?action=new', native: false }), [`https://example.org/app/fonts/web/${file}`, remote]);
  assert.deepEqual(fontSourceUrls(file, { href: 'http://localhost:8765/', native: false }), [`http://localhost:8765/fonts/web/${file}`, remote]);
  // the project site itself: one URL, not two
  assert.deepEqual(fontSourceUrls(file, { href: `${PAGES_BASE_URL}index.html`, native: false }), [remote]);
  // Windows (app://) and Android (https://localhost inside the shell): the package has no fonts → straight to the site
  assert.deepEqual(fontSourceUrls(file, { href: 'app://scoresnap/index.html', native: true }), [remote]);
  assert.deepEqual(fontSourceUrls(file, { href: 'https://localhost/', native: true }), [remote]);
  assert.deepEqual(fontSourceUrls(file, { href: 'file:///C:/jse/index.html', native: false }), [remote]);
  assert.deepEqual(fontSourceUrls(file, { href: '', native: false }), [remote]);
  assert.deepEqual(fontSourceUrls(file, { href: 'https://example.org/', native: false, pagesBase: 'https://someone.github.io/other/' })[1], `https://someone.github.io/other/fonts/web/${file}`);
});

// ----------------------------------------------------------------------------- MusicXML
test('MusicXML: text styles survive a JSE round trip; a default score writes nothing new', () => {
  const plain = sampleScore(); validateScore(plain, { repair: true });
  const x0 = exportMusicXML(plain);
  assert.ok(!x0.includes('miscellaneous') && !x0.includes('lyric-font') && !x0.includes('word-font'));
  assert.match(x0, /<credit-words[^>]*valign="top" font-size="24">/);
  assert.equal(importMusicXML(x0).settings.textStyles, undefined);
  const s = sampleScore(); validateScore(s, { repair: true });
  const styles = { title: { family: 'Nanum Myeongjo', size: 6, bold: false }, composer: { italic: true }, lyrics: { family: 'Nanum Pen Script', size: 3 }, chord: { family: 'Old Standard TT', italic: true }, text: { size: 2.5, bold: true }, measureNumber: { size: 2 } };
  s.settings.textStyles = clone(styles);
  const x1 = exportMusicXML(s);
  assert.match(x1, /<lyric-font font-family="Nanum Pen Script" font-size="14\.9"\/>/);
  assert.match(x1, /<word-font font-size="12\.4" font-weight="bold"\/>/);
  assert.match(x1, /<credit-words[^>]*font-family="Nanum Myeongjo" font-size="29\.8" font-weight="normal" font-style="normal">/);
  assert.deepEqual(importMusicXML(x1).settings.textStyles, normalizeTextStyles(styles));
});

test('MusicXML: fonts of files from other programs', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>Song</work-title></work>
<identification><creator type="composer">Someone</creator><encoding><software>MuseScore 4.4.2</software></encoding></identification>
<defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>
<word-font font-family="Edwin, serif" font-size="10"/><lyric-font font-family="Times New Roman" font-size="11.5" font-style="italic"/></defaults>
<credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" font-family="x'}&lt;/style&gt;" font-size="22">Song</credit-words></credit>
<credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="bottom" font-size="900" font-weight="bold">Someone</credit-words></credit>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>`;
  const ts = importMusicXML(xml).settings.textStyles;
  assert.deepEqual(ts.lyrics, { family: 'Times New Roman', size: ptToSp(11.5, 1.75), italic: true });
  assert.deepEqual(ts.text, { family: 'Edwin', size: ptToSp(10, 1.75) });                 // first name of the list
  assert.deepEqual(ts.title, { size: ptToSp(22, 1.75) });                                 // unusable family dropped
  assert.deepEqual(ts.composer, { bold: true });                                           // absurd size dropped, the stated weight kept
});

// ----------------------------------------------------------------------------- packaging: the fonts are downloaded, not bundled
test('packaging: app/fonts/web stays out of the Windows / Android bundles and the precache list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.find(r => r.to === 'web').filter.includes('!fonts/web/**'), 'electron-builder filter');
  assert.match(fs.readFileSync(path.join(root, 'tools', 'build-demo.mjs'), 'utf8'), /fonts\$\{path\.sep\}web/, 'demo build filter');
  assert.match(fs.readFileSync(path.join(root, '.github', 'workflows', 'build-web.yml'), 'utf8'), /zip -r[^\n]*-x[^\n]*'fonts\/web\/\*'/, 'OTA zip excludes the fonts');
  assert.match(fs.readFileSync(path.join(root, 'app', 'sw.js'), 'utf8'), /fonts\/web\//, 'service worker leaves them alone');
  assert.match(fs.readFileSync(path.join(root, 'tools', 'set-github-owner.mjs'), 'utf8'), /PAGES_BASE_URL/, 'owner helper rewrites the config');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-www-'));
  try {
    const shim = path.join(root, 'mobile', 'www-shim', 'native-android.js');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    // Android bundle
    syncWww({ src: path.join(root, 'app'), out: path.join(tmp, 'www'), shim, pages: false });
    assert.ok(!fs.existsSync(path.join(tmp, 'www', 'fonts', 'web')), 'not in the Android web bundle');
    assert.ok(fs.existsSync(path.join(tmp, 'www', 'fonts', 'LICENSE-FreeFont.txt')), 'the rest of fonts/ is still there');
    assert.ok(fs.existsSync(path.join(tmp, 'www', 'js', 'fonts.js')) && fs.existsSync(path.join(tmp, 'www', 'css', 'textstyle.css')));
    assert.ok(walk(path.join(tmp, 'www')).reduce((a, f) => a + fs.statSync(f).size, 0) < 12 * 1024 * 1024, 'bundle did not grow by the fonts');
    // web site: served from there, but never precached
    syncWww({ src: path.join(root, 'app'), out: path.join(tmp, 'site'), shim, pages: true });
    assert.ok(fs.existsSync(path.join(tmp, 'site', 'fonts', 'web', 'manifest.json')), 'published on the web site');
    const list = JSON.parse(fs.readFileSync(path.join(tmp, 'site', 'asset-list.json'), 'utf8'));
    assert.ok(!list.some(f => f.startsWith('fonts/web/')), 'not in the precache list');
    assert.ok(list.includes('js/fonts.js') && list.includes('css/textstyle.css') && list.includes('js/model/textstyles.js') && list.includes('js/ui/textstyle.js'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
