// Finale (.musx) export — app/js/io/musx-write.js (+ the import fixes in app/js/io/musx.js it relies on)
//
// The writer is checked by round trip (ScoreDoc → .musx → importMusx) with the fact comparison of
// tools/musx/compare.mjs, and by looking at the EnigmaXML records themselves. Fixtures: JSE's example score,
// tools/fixtures.mjs (sample, drums + TAB) and tools/musx/fixtures.mjs (every feature the writer handles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { exportMusx, buildEnigmaXml, etnEncode, etnDecode, gzipFinale, chordIntervals, MUSX_VERSION } from '../../app/js/io/musx-write.js';
import { importMusx, readEnigmaXml, enigmaToScore, musxCrypt } from '../../app/js/io/musx.js';
import { parseXML } from '../../app/js/io/musicxml.js';
import { exampleScore } from '../../app/js/model/examples.js';
import { sampleScore, drumTabScore } from '../fixtures.mjs';
import { featureScore, staffKindsScore } from '../musx/fixtures.mjs';
import { scoreFacts, compareFacts } from '../musx/compare.mjs';
import { createScore, createMeasure, makeNote, makeRest, newId, validateScore, DEFAULT_DRUM_MAP } from '../../app/js/model/score.js';

const require = createRequire(import.meta.url);
const JSZip = require('../../app/vendor/jszip.min.js');

/** Every fact category equal (Finale's layout may add system breaks). */
function assertSameMusic(a, b, label) {
  const r = compareFacts(scoreFacts(a), scoreFacts(b));
  for (const [k, x] of Object.entries(r)) {
    if (k === 'breaks') { assert.deepEqual(x.onlyA, [], `${label}: breaks`); continue; }
    assert.deepEqual({ onlyA: x.onlyA.slice(0, 8), onlyB: x.onlyB.slice(0, 8) }, { onlyA: [], onlyB: [] }, `${label}: ${k}`);
    assert.equal(x.a, x.b, `${label}: ${k} count`);
  }
}
async function roundTrip(score) {
  const warnings = [];
  const bytes = await exportMusx(score, { JSZip, warnings });
  const back = await importMusx(bytes, { JSZip });
  return { bytes, back, warnings };
}
/** EnigmaXML of a score as an element tree: { others, details, texts, entries, options } → arrays of elements. */
function records(score) {
  const root = parseXML(buildEnigmaXml(score, {}).xml).children.find(c => c.tag === 'finale');
  const sec = (t) => root.children.find(c => c.tag === t)?.children || [];
  return { root, others: sec('others'), details: sec('details'), texts: sec('texts'), entries: sec('entries'), options: sec('options') };
}
const kid = (n, t) => n.children.find(c => c.tag === t);
const val = (n, t) => kid(n, t)?.text;

test('musx: container is laid out like Finale\'s own files', async () => {
  const bytes = await exportMusx(exampleScore(), { JSZip });
  const zip = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files), ['mimetype', 'META-INF/container.xml', 'NotationMetadata.xml', 'score.dat']);
  assert.equal(await zip.file('mimetype').async('string'), 'application/vnd.makemusic.notation');
  // mimetype is stored (not deflated) and comes first, like an EPUB
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint16(8, true), 0, 'mimetype stored');
  assert.match(await zip.file('META-INF/container.xml').async('string'), new RegExp(`<container version="${MUSX_VERSION.major}"`));
  const meta = await zip.file('NotationMetadata.xml').async('string');
  assert.match(meta, /<metadata version="26\.1"/);
  assert.match(meta, /<keySignature>C<\/keySignature>/);
  assert.match(meta, /<initialTempo>96<\/initialTempo>/);
  // score.dat = scrambled gzip with the header of Finale's (Windows) files
  const dat = musxCrypt(await zip.file('score.dat').async('uint8array'));
  assert.deepEqual([...dat.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0x0b]);
  const { xml } = await readEnigmaXml(bytes, { JSZip });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<finale version="26\.1" xmlns="http:\/\/www\.makemusic\.com\/2012\/finale">\n  <mappings>/);
  assert.match(xml, /<application>FIN<\/application>/);
});

test('musx: pure-JS gzip (JSZip deflate, no CompressionStream) gives the same document', async () => {
  const data = new TextEncoder().encode('<finale>' + 'x'.repeat(5000) + 'äöü 한글</finale>');
  const saved = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const gz = await gzipFinale(data, JSZip);
    assert.equal(gz[9], 0x0b);
    const zip = new JSZip(); zip.file('score.dat', musxCrypt(gz));
    const back = await readEnigmaXml(await zip.generateAsync({ type: 'uint8array' }), { JSZip });
    assert.equal(back.xml, new TextDecoder().decode(data));
  } finally { globalThis.CompressionStream = saved; }
});

test('musx: compact notation of the embedded Finale data round trips', () => {
  const nodes = etnDecode('a[x=1,y="b c"]{b=2 c d*(1 2 3) e="x y\\"z" f{g}} h');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].attrs.y, 'b c');
  assert.deepEqual(nodes[0].children.filter(n => n.tag === 'd').map(n => n.text), ['1', '2', '3']);
  assert.equal(nodes[0].children.find(n => n.tag === 'e').text, 'x y"z');
  assert.deepEqual(etnDecode(etnEncode(nodes)), nodes);
});

test('musx: the record types Finale writes into every document are there, in Finale\'s order', () => {
  const r = records(exampleScore());
  const tags = (list) => [...new Set(list.map(n => n.tag))];
  const others = tags(r.others), details = tags(r.details);
  for (const t of ['durAllot', 'fontName', 'frameSpec', 'hpOptions', 'instUsed', 'layerAtts', 'metaClef', 'measSpec', 'textBlock', 'playbackRoute', 'playbackRouteName',
    'pageSpec', 'playDefs', 'playDumpText', 'shapeData', 'shapeDef', 'shapeList', 'ssLineStyle', 'staffSystemSpec', 'staffPlayData', 'staffSpec', 'textExprDef',
    'partDef', 'partGlobals', 'moviePlayerState', 'markingsCategory', 'markingsCategoryName', 'categoryStaffListParts', 'categoryStaffListScore', 'pageTextAssign', 'viSetup']) {
    assert.ok(others.includes(t), `others:${t}`);
  }
  for (const t of ['baselinesChords', 'baselinesExprAboveStaff', 'baselinesExprBelowStaff', 'baselinesLyricsChorus', 'baselinesLyricsSection', 'baselinesLyricsVerse', 'gfhold']) assert.ok(details.includes(t), `details:${t}`);
  assert.equal(r.options.length, 34);
  // record types appear in one block each and in the observed order
  assert.ok(others.indexOf('fontName') < others.indexOf('measSpec') && others.indexOf('measSpec') < others.indexOf('staffSpec') && others.indexOf('staffSpec') < others.indexOf('partDef'));
  assert.equal(r.others.filter((n, i, a) => i > 0 && a[i - 1].tag !== n.tag).length, others.length - 1, 'one run per record type');
  // layer attributes 0..3 (musxdom checks this)
  assert.deepEqual(r.others.filter(n => n.tag === 'layerAtts').map(n => n.attrs.cmper), ['0', '1', '2', '3']);
  // entries are linked per staff and layer: prev/next form chains that start and end with 0
  const ents = new Map(r.entries.map(e => [e.attrs.entnum, e]));
  for (const e of r.entries) {
    if (e.attrs.next !== '0') assert.equal(ents.get(e.attrs.next).attrs.prev, e.attrs.entnum);
    if (e.attrs.prev !== '0') assert.equal(ents.get(e.attrs.prev).attrs.next, e.attrs.entnum);
  }
});

test('musx: example score — every fact survives the round trip', async () => {
  const s = exampleScore();
  const { back, warnings } = await roundTrip(s);
  assert.equal(validateScore(back).ok, true);
  assert.deepEqual(warnings, []);
  assert.equal(back.meta.title, s.meta.title);
  assert.equal(back.meta.composer, s.meta.composer);
  assert.equal(back.meta.subtitle, s.meta.subtitle);
  assert.equal(back.parts.length, 2);
  assert.equal(back.parts[1].staves.length, 2, 'piano grand staff');
  assert.equal(back.parts[1].name, s.parts[1].name);
  assertSameMusic(s, back, 'example');
});

test('musx: sample score and every-feature score round trip', async () => {
  for (const [name, s] of [['sample', sampleScore()], ['feature', featureScore()]]) {
    const { back } = await roundTrip(s);
    assertSameMusic(s, back, name);
  }
});

test('musx: tuplets are tupletDefs on the first entry (3:2, 5:4, 6:4)', async () => {
  const s = featureScore();
  const r = records(s);
  const defs = r.details.filter(n => n.tag === 'tupletDef').map(n => `${val(n, 'symbolicNum')}x${val(n, 'symbolicDur')}:${val(n, 'refNum')}x${val(n, 'refDur')}`);
  assert.deepEqual(defs.sort(), ['3x512:2x512', '5x256:4x256', '6x256:4x256']);
  const first = r.details.find(n => n.tag === 'tupletDef');
  const ent = r.entries.find(e => e.attrs.entnum === first.attrs.entnum);
  assert.ok(kid(ent, 'tupletStart'));
  const { back } = await roundTrip(s);
  const t6 = back.measures[5].staves[2].voices[0].filter(e => e.tuplet);
  assert.equal(t6.length, 6);
  assert.deepEqual([t6[0].tuplet.num, t6[0].tuplet.den], [6, 4]);
});

test('musx: ties, accidentals, grace notes, stems and hidden notes', async () => {
  const s = featureScore();
  const { back } = await roundTrip(s);
  const v = (m, st) => back.measures[m].staves[st].voices[0];
  assert.equal(v(2, 0)[3].notes[0].tieStart, true);
  assert.equal(v(3, 0)[0].notes[0].tieEnd, true);
  assert.deepEqual(v(2, 0)[0].grace, { slash: true });
  assert.equal(v(5, 0)[2].notes[0].accidental, 'sharp');
  assert.equal(v(5, 0)[3].hidden, true);
  assert.equal(v(1, 3)[0].stem, 'up');
  const r = records(s);
  assert.ok(r.entries.some(e => kid(e, 'graceNote') && kid(e, 'slashGrace')));
  assert.ok(r.entries.some(e => kid(e, 'ignore')));
});

test('musx: lyrics — one text per verse, syllables separated by spaces and hyphens', async () => {
  const s = featureScore();
  const r = records(s);
  const verse1 = r.texts.find(t => t.tag === 'verse' && t.attrs.number === '1').text;
  assert.match(verse1, /\^nfx\(0\)봄 na-bi-ya 꽃 $|\^nfx\(0\)봄 na-bi-ya 꽃$/);
  const lds = r.details.filter(n => n.tag === 'lyrDataVerse');
  assert.ok(lds.some(n => val(n, 'lyricNumber') === '2' && val(n, 'syll') === '2'));
  assert.ok(lds.some(n => val(n, 'wext') === '1'), 'word extension');
  // the lyric font of the text styles
  assert.ok(r.others.some(n => n.tag === 'fontName' && val(n, 'name') === 'Nanum Myeongjo'));
  const { back } = await roundTrip(s);
  const ly = back.measures[1].staves[0].voices[0].slice(0, 3).map(e => e.lyrics.map(l => `${l.verse}:${l.text}:${l.syllabic}`).join(' '));
  assert.deepEqual(ly, ['1:na:begin 2:one:begin', '1:bi:middle 2:two:end', '1:ya:end']);
});

test('musx: lyric syllables never split differently in Finale (spaces, hyphens, underscores inside a syllable)', async () => {
  const s = createScore({ instruments: ['voice'], measures: 1 });
  const ev = ['C5', 'D5', 'E5', 'F5'].map(p => makeNote(p, 'quarter'));
  ev[0].lyrics = [{ verse: 1, text: 'Ah', syllabic: 'single' }];
  ev[1].lyrics = [{ verse: 1, text: '____', syllabic: 'single' }];          // a melisma placeholder (MusicXML)
  ev[2].lyrics = [{ verse: 1, text: 'a_b c-d', syllabic: 'single' }];
  ev[3].lyrics = [{ verse: 1, text: 'end', syllabic: 'single' }];
  s.measures[0].staves[0].voices[0] = ev;
  const r = records(s);
  const verse = r.texts.find(t => t.tag === 'verse').text.replace(/^(\^[a-z]+\([^)]*\))+/, '');
  assert.equal(verse, 'Ah a\uff3fb\u00a0c\u2011d end');
  // the syllable numbers of the entries are what Finale counts in that text
  assert.deepEqual(r.details.filter(n => n.tag === 'lyrDataVerse').map(n => +val(n, 'syll')), [1, 2, 3]);
  assert.ok(kid(r.details.find(n => n.tag === 'lyrDataVerse'), 'wext'), 'the underscores became a word extension');
  const { back, warnings } = await roundTrip(s);
  assert.ok(warnings.some(w => /밑줄/.test(w)));
  assert.deepEqual(back.measures[0].staves[0].voices[0].map(e => (e.lyrics || []).map(l => l.text).join()), ['Ah', '', 'a_b c-d', 'end']);
  assert.equal(back.measures[0].staves[0].voices[0][0].lyrics[0].extend, true);
});

test('musx: chord symbols are scale degrees of the key with generated suffixes', async () => {
  const s = featureScore();
  const r = records(s);
  const ch = r.details.filter(n => n.tag === 'chordAssign');
  assert.equal(ch.length, 2);
  // in F major: F = degree 0, C = degree 4, bass E = degree 6
  assert.equal(val(ch[0], 'rootScaleNum'), undefined);
  assert.equal(val(ch[1], 'rootScaleNum'), '4');
  assert.equal(val(ch[1], 'bassScaleNum'), '6');
  assert.equal(val(ch[1], 'horzEdu'), '2048');
  const suffix = r.others.filter(n => n.tag === 'chordSuffix' && n.attrs.cmper === val(ch[1], 'suffix'));
  assert.deepEqual(suffix.map(n => val(n, 'suffix')), ['55']);   // "7"
  assert.deepEqual(chordIntervals('m7b5'), [3, 6, 10]);
  const { back } = await roundTrip(s);
  assert.deepEqual(back.measures[1].chords.map(c => c.text), ['F', 'C7/E']);
});

test('musx: a tuplet split into groups (nested tuplets from MusicXML) is one Finale tuplet, not tuplets inside tuplets', async () => {
  const s = createScore({ instruments: ['melody'], measures: 1, timeSig: { num: 2, den: 4 } });
  const v = [];
  for (let g = 0; g < 3; g++) { const id = newId(); for (let k = 0; k < 3; k++) { const n = makeNote('C5', '16th'); n.tuplet = { id, num: 9, den: 4, bracket: true, show: 'number' }; v.push(n); } }
  s.measures[0].staves[0].voices[0] = [...v, makeNote('D5', 'quarter')];
  const r = records(s);
  const defs = r.details.filter(n => n.tag === 'tupletDef');
  assert.deepEqual(defs.map(n => `${val(n, 'symbolicNum')}x${val(n, 'symbolicDur')}:${val(n, 'refNum')}x${val(n, 'refDur')}`), ['9x256:4x256']);
  const { back } = await roundTrip(s);
  assertSameMusic(s, back, 'split tuplet');
});

test('musx: two voices become Finale layers 1 and 2', async () => {
  const s = featureScore();
  const r = records(s);
  const gf = r.details.find(n => n.tag === 'gfhold' && n.attrs.cmper1 === '3' && n.attrs.cmper2 === '3');
  assert.ok(kid(gf, 'frame1') && kid(gf, 'frame2'));
  const { back } = await roundTrip(s);
  assert.equal(back.measures[2].staves[2].voices.length, 2);
  assert.deepEqual(back.measures[2].staves[2].voices[1].map(e => e.notes[0].step + e.notes[0].octave), ['F4', 'G4', 'A4']);
});

test('musx: a transposing instrument is stored in concert pitch with its transposition', async () => {
  const s = featureScore();   // B♭ clarinet, written D5 in F major (concert C5, E♭ major written key G)
  const r = records(s);
  const spec = r.others.find(n => n.tag === 'staffSpec' && n.attrs.cmper === '2');
  const ks = kid(kid(spec, 'transposition'), 'keysig');
  assert.deepEqual([val(ks, 'interval'), val(ks, 'adjust')], ['1', '2']);
  assert.equal(val(spec, 'instUuid'), 'a16af0c1-8df8-476d-8d74-0d6e1972846b');
  // measure 1 is in F major (concert, the voice part does not transpose): written D5 → concert C5 = harmLev 4 above F4
  const gf = r.details.find(n => n.tag === 'gfhold' && n.attrs.cmper1 === '2' && n.attrs.cmper2 === '1');
  const frame = r.others.find(n => n.tag === 'frameSpec' && n.attrs.cmper === val(gf, 'frame1'));
  const ent = r.entries.find(e => e.attrs.entnum === val(frame, 'startEntry'));
  assert.equal(val(kid(ent, 'note'), 'harmLev'), '4');
  const { back } = await roundTrip(s);
  assert.equal(back.parts[1].transposeChromatic, -2);
  assert.deepEqual(back.measures[0].staves[1].voices[0][0].notes[0], { step: 'D', octave: 5, alter: 0 });
  // a score of transposing instruments only keeps the key of its first staff
  const t = createScore({ instruments: ['trumpet'], measures: 2, keyFifths: 2 });
  t.parts[0].transposeChromatic = -2;
  t.measures[0].staves[0].voices[0] = [makeNote('F#4', 'whole')];
  t.measures[1].keySig = { fifths: 0, mode: 'major' };
  t.measures[1].staves[0].voices[0] = [makeNote('C5', 'whole')];
  const tb = (await roundTrip(t)).back;
  assert.equal(tb.measures[0].keySig.fifths, 2);
  assert.equal(tb.measures[1].keySig.fifths, 0, 'key change to C (no <keySig> in Finale) is read back');
  assert.deepEqual(tb.measures[0].staves[0].voices[0][0].notes[0], { step: 'F', octave: 4, alter: 1 });
});

test('musx: 8va lines — notes stay as written, the line covers its first to its last note', async () => {
  const s = featureScore();
  const r = records(s);
  const sh = r.others.find(n => n.tag === 'smartShape' && val(n, 'shapeType') === 'octaveUp');
  const ep = (seg) => kid(kid(sh, seg), 'endPt');
  assert.deepEqual([val(ep('startTermSeg'), 'meas'), val(ep('startTermSeg'), 'edu') ?? '0'], ['6', '0']);
  assert.deepEqual([val(ep('endTermSeg'), 'meas'), val(ep('endTermSeg'), 'edu') ?? '0'], ['7', '0']);
  // measure marks for every measure the line passes, and the measure flag
  assert.equal(r.others.filter(n => n.tag === 'smartShapeMeasMark' && val(n, 'shapeNum') === sh.attrs.cmper).length, 2);
  assert.ok(kid(r.others.find(n => n.tag === 'measSpec' && n.attrs.cmper === '6'), 'hasSmartShape'));
  const { back } = await roundTrip(s);
  const o = back.spanners.find(sp => sp.type === 'ottava');
  assert.equal(o.octaveShift, 8);
  assert.deepEqual(back.measures[5].staves[0].voices[0][0].notes[0], { step: 'D', octave: 5, alter: 0 });
});

test('musx: expressions, articulations, repeats and text repeats', async () => {
  const s = featureScore();
  const { back } = await roundTrip(s);
  assert.equal(back.measures[0].staves[0].voices[0][0].dynamic, 'mp');
  assert.equal(back.measures[5].staves[1].voices[0][0].dynamic, 'sfz');
  assert.deepEqual(back.measures[0].tempo, { bpm: 92, beatUnit: 'quarter', dots: 0, text: 'Andante', showBpm: true });
  assert.equal(back.measures[1].rehearsalMark, 'A');
  assert.deepEqual(back.measures[1].staves[1].voices[0][1].articulations, ['staccato', 'tenuto']);
  assert.equal(back.measures[2].staves[1].voices[0][4].fermata, 'above');
  assert.equal(back.measures[1].staves[2].voices[0][0].arpeggio, true);
  assert.equal(back.measures[2].staves[3].voices[0][0].tremolo, 2);
  assert.equal(back.measures[2].barlineLeft, 'repeat-start');
  assert.equal(back.measures[3].barlineRight, 'repeat-end');
  assert.deepEqual(back.measures[5].markers, ['segno']);
  assert.deepEqual(back.measures[8].markers, ['coda']);
  assert.deepEqual(back.measures[7].markers, ['fine']);
  const voltas = back.spanners.filter(sp => sp.type === 'volta').map(sp => `${sp.number}:${sp.voltaType}`);
  assert.deepEqual(voltas, ['1.:closed', '2.:open']);
  assert.equal(back.measures[7].timeSig.display, 'common');
  assert.equal(back.measures[0].pickup, true);
  for (const t of ['crescendo', 'diminuendo', 'trill', 'glissando', 'pedal', 'textLine']) assert.ok(back.spanners.some(sp => sp.type === t), t);
  assert.equal(back.spanners.find(sp => sp.type === 'textLine').text, 'rit.');
});

test('musx: TAB staves keep string and fret; drums get a percussion layout', async () => {
  for (const s of [staffKindsScore(), drumTabScore()]) {
    const r = records(s);
    assert.ok(r.others.some(n => n.tag === 'fretInst' && val(n, 'numStrings') === '6'));
    assert.ok(r.details.some(n => n.tag === 'tabAlter'));
    const { back, warnings } = await roundTrip(s);
    assertSameMusic(s, back, 'kinds');
    assert.equal(back.parts[0].staves[0].type, 'tab');
    assert.deepEqual(warnings, []);
  }
  // the drum staff names its layout; the layout has Finale's note type, line and noteheads of every drum of the drum map
  const r = records(drumTabScore());
  const ds = r.others.find(n => n.tag === 'drumStaff' && n.attrs.cmper === '2');
  const layout = r.others.filter(n => n.tag === 'percussionNoteInfo' && n.attrs.cmper === val(ds, 'whichDrumLib'));
  const info = (type) => layout.find(n => val(n, 'percNoteType') === String(type));
  assert.deepEqual([val(info(1), 'harmLev'), val(info(1), 'closedNotehead')], ['7', '207'], 'snare: 3rd space, normal head');
  assert.deepEqual([val(info(15), 'harmLev'), val(info(15), 'closedNotehead')], ['11', '120'], 'closed hi-hat: above the staff, x head');
  assert.equal(val(info(2), 'harmLev'), '3', 'kick: 1st space');
  // every drum note carries its note type; its pitch is the drum's MIDI key (snare: D2)
  const codes = r.details.filter(n => n.tag === 'percussionNoteCode');
  assert.equal(codes.length, 4 * 15);
  const snare = codes.find(n => val(n, 'noteCode') === '1');
  const ent = r.entries.find(e => e.attrs.entnum === snare.attrs.entnum);
  assert.ok(kid(ent, 'noteDetail'));
  const note = ent.children.find(c => c.tag === 'note' && c.attrs.id === val(snare, 'noteID'));
  assert.deepEqual([val(note, 'harmLev'), val(note, 'harmAlt')], ['-13', '0']);   // Finale writes harmAlt 0 too
  // a one-line staff is Finale's middle line
  const k = records(staffKindsScore()).others.find(n => n.tag === 'staffSpec' && n.attrs.cmper === '3');
  assert.equal(val(kid(k, 'customStaff'), 'staffLine'), '13');
});

test('musx: a Finale percussion layout becomes the drum map (instrument, line, notehead)', async () => {
  // a layout as Finale's Drum Set has it: closed hi-hat on the space above the staff with a circled x, an electric snare (type 23)
  const s = drumTabScore();
  const xml = buildEnigmaXml(s, {}).xml
    .replace(/(<percussionNoteInfo cmper="1" inci="\d+">\s*<percNoteType>15<\/percNoteType>\s*<harmLev>)11(<\/harmLev>\s*<closedNotehead>)120/, '$112$288')
    .replace(/(<percussionNoteInfo cmper="1" inci="\d+">\s*<percNoteType>)1(<\/percNoteType>)/, '$123$2')
    .replace(/(<noteCode>)1(<\/noteCode>)/g, '$123$2');
  const back = enigmaToScore(xml);
  const dm = back.parts[1].staves[0].drumMap;
  assert.deepEqual(dm['hihat-closed'], { line: -2, head: 'circle-x', midi: 42, name: DEFAULT_DRUM_MAP['hihat-closed'].name });
  assert.deepEqual(dm['finale-23'], { line: 3, head: 'normal', midi: 40, name: '일렉트릭 스네어' });
  assert.equal(dm.snare, undefined);
  // notes are the layout's instruments whatever their pitch, placed on the instrument's line
  const ev = back.measures[0].staves[1].voices[0][2];
  assert.deepEqual(ev.notes.map(n => `${n.drum}:${n.step}${n.octave}`).sort(), ['finale-23:C5', 'hihat-closed:A5']);
  // and they go back out as the same note types
  const again = records(back);
  assert.ok(again.details.some(n => n.tag === 'percussionNoteCode' && val(n, 'noteCode') === '23'));
  const info = again.others.find(n => n.tag === 'percussionNoteInfo' && val(n, 'percNoteType') === '15');
  assert.deepEqual([val(info, 'harmLev'), val(info, 'closedNotehead')], ['12', '88']);
});

test('musx: noteheads of single notes are Maestro characters (noteAlter)', async () => {
  const s = createScore({ instruments: ['melody'], measures: 2 });
  const heads = ['x', 'diamond', 'triangle-black', 'slash', 'square', 'plus', 'triangle', 'diamond-black'];
  heads.forEach((h, i) => {
    const m = s.measures[i >> 2];
    const ev = makeNote(['C5', 'D5', 'E5', 'F5'][i & 3], 'quarter'); ev.notes[0].head = h;
    if (!(i & 3)) m.staves[0].voices[0] = [];
    m.staves[0].voices[0].push(ev);
  });
  const half = makeNote('G4', 'half'); half.notes[0].head = 'diamond';
  s.measures[1].staves[0].voices[0].splice(2, 2, half);
  const r = records(s);
  const alters = r.details.filter(n => n.tag === 'noteAlter').map(n => +val(n, 'altNhead'));
  assert.deepEqual(alters, [192, 226, 209, 243, 173, 132, 225]);   // a short diamond is drawn black, a half one white
  const { back, warnings } = await roundTrip(s);
  assert.deepEqual(warnings, []);
  assertSameMusic(s, back, 'heads');
  assert.deepEqual(back.measures[0].staves[0].voices[0].map(e => e.notes[0].head), ['x', 'diamond-black', 'triangle-black', 'slash']);
  assert.equal(back.measures[1].staves[0].voices[0][2].notes[0].head, 'diamond');
});

test('musx: edge cases met in the MuseScore / NWC corpora round trip exactly', async () => {
  const s = createScore({ instruments: ['piano'], measures: 4, timeSig: { num: 4, den: 4 } });
  const [m0, m1, m2, m3] = s.measures;
  // a short measure later in the score (before a repeat): a pickup measure, the time signature unchanged
  m1.pickup = true;
  m1.staves[0].voices[0] = [makeNote('C5', 'half')];
  m1.staves[1].voices[0] = [makeRest('half')];
  // a hairpin on the lower voice, a lyric that is a hyphen, a syllable with a space and a hyphen inside
  const up = [makeNote('E5', 'half'), makeNote('D5', 'half')], low = [makeNote('G4', 'quarter'), makeNote('A4', 'quarter'), makeNote('B4', 'half')];
  m0.staves[0].voices = [up, low];
  s.spanners.push({ id: newId(), type: 'crescendo', from: { eventId: low[0].id }, to: { eventId: low[2].id } });
  up[0].lyrics = [{ verse: 1, text: '-', syllabic: 'single' }];
  up[1].lyrics = [{ verse: 1, text: 'a b-c', syllabic: 'single' }];
  // two chord symbols at one position; a text on the lower staff of an empty measure
  m0.chords = [{ id: newId(), tick: 0, text: 'C', root: 'C' }, { id: newId(), tick: 0, text: 'Am', root: 'A', kind: 'm' }];
  m2.texts = [{ text: 'L.H.', placement: 'below', style: 'technique', staffIndex: 1 }];
  // a diminuendo that starts on a whole-measure rest
  const rest = { ...makeRest('whole'), fullMeasureRest: true };
  m2.staves[0].voices[0] = [rest];
  m3.staves[0].voices[0] = [makeNote('C5', 'whole')];
  s.spanners.push({ id: newId(), type: 'diminuendo', from: { eventId: rest.id }, to: { eventId: m3.staves[0].voices[0][0].id } });
  const r = records(s);
  const shapes = r.others.filter(n => n.tag === 'smartShape');
  assert.ok(kid(shapes.find(n => val(n, 'shapeType') === 'cresc'), 'entryBased'), 'the lower voice\'s hairpin is attached to its notes');
  assert.equal(kid(shapes.find(n => val(n, 'shapeType') === 'decresc'), 'entryBased'), undefined);
  const { back, warnings } = await roundTrip(s);
  assert.deepEqual(warnings, []);
  assertSameMusic(s, back, 'edge cases');
  assert.equal(back.measures[1].pickup, true);
  assert.equal(back.measures[1].timeSig, undefined);
  assert.deepEqual(back.measures[0].staves[0].voices[0].map(e => e.lyrics[0].text), ['-', 'a b-c']);
  assert.deepEqual(back.measures[0].chords.map(c => c.text), ['C', 'Am']);
  assert.deepEqual(back.measures[2].texts, [{ text: 'L.H.', placement: 'below', style: 'technique', staffIndex: 1 }]);
  const dim = back.spanners.find(sp => sp.type === 'diminuendo');
  assert.equal(back.measures[2].staves[0].voices[0][0].id, dim.from.eventId, 'the rest a line starts on is kept');
  // a text line on a hidden rest of a voice that has nothing else (as MusicXML files often have it): voice and line stay
  const t = createScore({ instruments: ['melody'], measures: 1 });
  const hid = [makeRest('half'), makeRest('half')].map(r => ({ ...r, hidden: true }));
  t.measures[0].staves[0].voices = [[makeNote('C5', 'whole')], hid];
  t.spanners.push({ id: newId(), type: 'textLine', text: 'rit.', from: { eventId: hid[1].id }, to: { eventId: hid[1].id } });
  const tb = (await roundTrip(t)).back;
  assertSameMusic(t, tb, 'hidden-rest line');
  assert.equal(tb.measures[0].staves[0].voices[1][1].id, tb.spanners[0].from.eventId);
});

test('musx: what Finale cannot hold is approximated with a Korean warning', async () => {
  const s = createScore({ instruments: ['melody'], measures: 1 });
  const n = makeNote('C5', 'whole'); n.notes[0].head = 'circle-x'; n.ornaments = ['inverted-turn'];
  s.measures[0].staves[0].voices[0] = [n];
  s.spanners.push({ id: newId(), type: 'slur', from: { eventId: n.id }, to: { eventId: 'missing' } });
  const { warnings, back } = await roundTrip(s);
  assert.ok(warnings.some(w => /음표 머리/.test(w)));
  assert.ok(warnings.some(w => /역턴/.test(w)));
  assert.ok(warnings.some(w => /선은 저장하지 않았습니다/.test(w)));
  assert.ok(warnings.every(w => /[가-힣]/.test(w)));
  assert.deepEqual(back.measures[0].staves[0].voices[0][0].ornaments, ['turn']);
});

test('musx: page size, margins and staff size follow the score settings', () => {
  const s = exampleScore();
  s.settings.pageWidthMm = 215.9; s.settings.pageHeightMm = 279.4; s.settings.marginsMm = { top: 20, bottom: 20, left: 12, right: 12 }; s.settings.staffSpaceMm = 2;
  const r = records(s);
  const fmt = kid(r.options.find(n => n.tag === 'pageFormatOptions'), 'pageFormatScore');
  assert.deepEqual([val(fmt, 'pageWidth'), val(fmt, 'pageHeight'), val(fmt, 'leftPageMarginTop'), val(fmt, 'leftPageMarginLeft')], ['2448', '3168', '-227', '136']);
  assert.equal(val(fmt, 'rawStaffHeight'), String(Math.round(8 * 288 / 25.4) * 16));
  const page = r.others.find(n => n.tag === 'pageSpec');
  assert.deepEqual([val(page, 'width'), val(page, 'height')], ['2448', '3168']);
  const back = enigmaToScore(buildEnigmaXml(s, {}).xml);
  assert.equal(back.settings.pageSize, 'Letter');
  assert.ok(Math.abs(back.settings.staffSpaceMm - 2) < 0.05);
});
