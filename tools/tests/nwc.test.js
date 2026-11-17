// NoteWorthy Composer import / export (app/js/io/nwc*.js).
// Every fixture here is written by hand or built by the code under test — no third-party song files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NWC_EXTENSIONS, NWC_ENCODINGS, looksLikeNwc, importNwc, exportNwctxt, exportNwc, readNwcDocument,
} from '../../app/js/io/nwc.js';
import { splitNwcLyric, parseChordName } from '../../app/js/io/nwc-convert.js';
import { encodeText, decodeBytes, detectEncoding } from '../../app/js/io/nwc-encoding.js';
import { inflateZlibSync, deflateStoredSync } from '../../app/js/io/nwc-zlib.js';
import { createScore, createMeasure, makeNote, makeRest, newId, validateScore, midiOf, durTicks } from '../../app/js/model/score.js';
import { sampleScore } from '../fixtures.mjs';

const enc = (s) => new TextEncoder().encode(s);
const nwctxt = (lines) => lines.join('\r\n') + '\r\n';
const midis = (voice) => voice.map(ev => (ev.kind === 'rest' ? 'r' : ev.notes.map(midiOf).join('+')));
const words = (voice, verse = 1) => voice.map(ev => ((ev.lyrics || []).find(l => l.verse === verse) || {}).text || '');

// A song with most of what the importer has to understand, typed the way NWC 2.75 saves it.
const SONG = nwctxt([
  '!NoteWorthyComposer(2.75)',
  '|SongInfo|Title:"봄 노래"|Author:"JSE 시험"|Lyricist:"가사 시험"|Copyright1:"(c) JSE"|Copyright2:"All rights reserved"',
  '|PgSetup|StaffSize:16|Zoom:4|TitlePage:Y|JustifyVertically:Y|PrintSystemSepMark:N|ExtendLastSystem:N|DurationPadding:Y|PageNumbers:0|StaffLabels:First System|BarNumbers:Plain|StartingBar:1',
  '|Font|Style:StaffLyric|Typeface:"Malgun Gothic"|Size:9|Bold:N|Italic:N|CharSet:129',
  '|PgMargins|Left:1.5|Top:2|Right:1.5|Bottom:2|Mirror:N',
  '|AddStaff|Name:"노래"|Label:"노래"|Group:"Standard"',
  '|StaffProperties|EndingBar:Section Close|Visible:Y|BoundaryTop:12|BoundaryBottom:12|Lines:5|Color:Default',
  '|StaffProperties|Muted:N|Volume:127|StereoPan:64|Device:0|Channel:1',
  '|StaffInstrument|Name:"Flute"|Patch:73|Trans:0|DynVel:10,30,45,60,75,92,108,127',
  '|Lyrics|Placement:Bottom|Align:Standard Rules|Offset:0',
  '|Lyric1|Text:"봄 이 왔 네 봄-이 와 _ 꽃_잎 이\\n날 리 네"',
  '|Lyric2|Text:"새 가 우 네"',
  '|Clef|Type:Treble',
  '|Key|Signature:F#|Tonic:G',
  '|TimeSig|Signature:4/4',
  '|Tempo|Tempo:96|Text:"Andante"|Pos:10',
  '|Text|Text:"G"|Font:StaffBold|Pos:9',
  '|Dynamic|Style:mf|Pos:-8',
  '|Note|Dur:4th|Pos:-2',
  '|Note|Dur:4th|Pos:#-1',
  '|Note|Dur:4th|Pos:-1',
  '|Note|Dur:4th|Pos:6',
  '|Bar',
  '|Text|Text:"Am7"|Font:StaffBold|Pos:9',
  '|Note|Dur:4th|Pos:-1',
  '|Note|Dur:8th,Slur|Pos:1|Opts:Stem=Down,Beam=First',
  '|Note|Dur:8th|Pos:2|Opts:Stem=Down,Beam=End',
  '|Note|Dur:Half|Pos:-3^',
  '|Bar|Style:MasterRepeatOpen',
  '|Ending|Endings:1',
  '|Note|Dur:Half|Pos:-3',
  '|Note|Dur:4th,Triplet=First|Pos:0',
  '|Note|Dur:4th,Triplet|Pos:1',
  '|Note|Dur:4th,Triplet=End|Pos:2',
  '|Bar|Style:MasterRepeatClose',
  '|Ending|Endings:2',
  '|TempoVariance|Style:Fermata|Pause:3|Pos:9|Justify:Center|Placement:AtNextNote',
  '|Chord|Dur:Half|Pos:-2,0,2',
  '|Rest|Dur:4th',
  '|Note|Dur:8th,Grace|Pos:1',
  '|Note|Dur:4th|Pos:0',
  '|Bar|Style:Double',
  '|Flow|Style:Segno|Pos:8',
  '|Note|Dur:Whole|Pos:-2',
  '|Bar',
  '|RestMultiBar|NumBars:2',
  '|Bar',
  '|Rest|Dur:Whole',
  '|Flow|Style:DCalFine|Pos:8',
  '!NoteWorthyComposer-End',
]);

test('NWC: file sniffing and the public constants', () => {
  assert.deepEqual(NWC_EXTENSIONS, ['.nwc', '.nwctxt']);
  assert.equal(NWC_ENCODINGS[0].id, 'auto');
  for (const id of ['euc-kr', 'utf-8', 'windows-1252', 'shift_jis']) assert.ok(NWC_ENCODINGS.some(e => e.id === id && e.label), id);
  assert.equal(looksLikeNwc(enc(SONG)), true);
  assert.equal(looksLikeNwc(enc('[NWZ]\0x')), true);
  assert.equal(looksLikeNwc(enc('[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0')), true);
  assert.equal(looksLikeNwc(enc('<?xml version="1.0"?><score-partwise/>')), false);
  assert.equal(looksLikeNwc(new Uint8Array([0x50, 0x4b, 3, 4])), false);
});

test('NWC: nwctxt import — pitches, accidentals, rhythm, lyrics, chords, repeats', async () => {
  const s = await importNwc(enc(SONG), { fileName: 'spring.nwctxt' });
  assert.equal(validateScore(s).ok, true);
  assert.deepEqual(s.importInfo, { from: 'nwc', version: '2.75', container: 'nwctxt', encoding: 'utf-8', encodingGuessed: false, warnings: s.importInfo.warnings });
  assert.equal(s.meta.title, '봄 노래');
  assert.equal(s.meta.composer, 'JSE 시험');
  assert.equal(s.meta.lyricist, '가사 시험');
  assert.equal(s.meta.copyright, '(c) JSE All rights reserved');
  assert.deepEqual(s.settings.marginsMm, { top: 20, bottom: 20, left: 15, right: 15 });
  assert.equal(s.settings.staffSpaceMm, 1.41);                       // 16 pt staff ÷ 4 spaces
  assert.equal(s.settings.fonts.lyrics, 'Malgun Gothic');
  assert.equal(s.settings.textStyles.lyrics.family, 'Malgun Gothic');
  assert.ok(Math.abs(s.settings.textStyles.lyrics.size - 9 * 0.3528 / 1.41) < 0.01, 'lyric size in staff spaces');
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].name, '노래');
  assert.equal(s.parts[0].instrument, 'voice');
  assert.equal(s.parts[0].midiProgram, 73);
  assert.equal(s.measures.length, 8);
  const v = (mi) => s.measures[mi].staves[0].voices[0];

  // bar 1: the sharp on A holds for the rest of the bar — in every octave, as NWC plays it
  assert.deepEqual(midis(v(0)), ['67', '70', '70', '82']);
  assert.deepEqual(s.measures[0].keySig, { fifths: 1, mode: 'major' });
  assert.deepEqual(s.measures[0].timeSig, { num: 4, den: 4, display: 'normal' });
  assert.deepEqual(s.measures[0].tempo, { bpm: 96, beatUnit: 'quarter', dots: 0, text: 'Andante', showBpm: true });
  assert.equal(v(0)[0].dynamic, 'mf');
  // bar 2: the bar line cancels it; the key signature's F sharp applies; the last note is tied over
  assert.deepEqual(midis(v(1)), ['69', '72', '74', '66']);
  assert.equal(v(1)[3].notes[0].tieStart, true);
  assert.deepEqual(v(1).map(ev => ev.dur.base), ['quarter', 'eighth', 'eighth', 'half']);
  // bar 3: tie received, then a quarter-note triplet
  assert.deepEqual(midis(v(2)), ['66', '71', '72', '74']);
  assert.equal(v(2)[0].notes[0].tieEnd, true);
  assert.deepEqual(v(2).map(durTicks), [1920, 640, 640, 640]);
  assert.equal(new Set(v(2).slice(1).map(ev => ev.tuplet.id)).size, 1);
  // bar 4: chord with a fermata, rest, grace note
  assert.deepEqual(midis(v(3)), ['67+71+74', 'r', '72', '71']);
  assert.equal(v(3)[0].fermata, 'above');
  assert.ok(v(3)[2].grace);
  // bars 6–8: multi-bar rest written out, a bar of rest
  for (const mi of [5, 6, 7]) assert.deepEqual(v(mi), [], `measure ${mi + 1} is a whole-bar rest`);

  // lyrics: NWC's rules — a slurred-to note and a tied-to note get nothing, "_" skips a note,
  // "꽃_잎" is one syllable with a space, "봄-이" two syllables of one word
  assert.deepEqual(words(v(0)), ['봄', '이', '왔', '네']);
  assert.deepEqual(words(v(1)), ['봄', '이', '', '와']);
  assert.deepEqual(v(1).slice(0, 2).map(ev => ev.lyrics[0].syllabic), ['begin', 'end']);
  assert.deepEqual(words(v(2)), ['', '', '꽃 잎', '이']);
  assert.deepEqual(words(v(3)), ['날', '', '', '리']);
  assert.deepEqual(words(v(4)), ['네']);
  assert.deepEqual(words(v(0), 2), ['새', '가', '우', '네']);

  // chord names typed as text
  assert.deepEqual(s.measures[0].chords.map(c => [c.tick, c.text]), [[0, 'G']]);
  assert.deepEqual(s.measures[1].chords.map(c => [c.tick, c.text, c.root, c.kind]), [[0, 'Am7', 'A', 'm7']]);

  // repeats, endings, flow signs, bar lines
  assert.equal(s.measures[2].barlineLeft, 'repeat-start');
  assert.equal(s.measures[2].barlineRight, 'repeat-end');
  assert.equal(s.measures[3].barlineRight, 'double');
  assert.equal(s.measures[7].barlineRight, 'final');
  assert.deepEqual(s.measures[4].markers, ['segno']);
  assert.deepEqual(s.measures[7].markers, ['dcAlFine']);
  const voltas = s.spanners.filter(sp => sp.type === 'volta').map(sp => [sp.number, s.measures.findIndex(m => m.id === sp.from.measureId), s.measures.findIndex(m => m.id === sp.to.measureId)]);
  assert.deepEqual(voltas, [['1.', 2, 2], ['2.', 3, 3]]);
  const slur = s.spanners.find(sp => sp.type === 'slur');
  assert.deepEqual([slur.from.eventId, slur.to.eventId], [v(1)[1].id, v(1)[2].id]);
});

test('NWC: staves — grand staff, layered staves, split-stem chords, rest chords, percussion, hidden staves', async () => {
  const txt = nwctxt([
    '!NoteWorthyComposer(2.75)',
    '|AddStaff|Name:"RH"|Label:"Piano"',
    '|StaffProperties|WithNextStaff:Brace,ConnectBars',
    '|Clef|Type:Treble', '|TimeSig|Signature:3/4',
    '|Chord|Dur:4th|Pos:-5|Opts:Stem=Down|Dur2:Half|Pos2:2',          // quarter D4 below a half-note D5
    '|Note|Dur:4th|Pos:-4|Opts:Stem=Down',
    '|RestChord|Dur:4th|Opts:Stem=Up|Dur2:4th|Pos2:0',
    '|Bar', '|Rest|Dur:Whole',
    '|AddStaff|Name:"LH"',
    '|Clef|Type:Bass', '|TimeSig|Signature:3/4',
    '|Note|Dur:Half,Dotted|Pos:0',                                    // D3
    '|Bar', '|Rest|Dur:Whole',
    '|AddStaff|Name:"Sop"|Label:"Choir"',
    '|StaffProperties|WithNextStaff:Layer',
    '|Clef|Type:Treble|OctaveShift:Octave Down', '|TimeSig|Signature:3/4',
    '|Note|Dur:Half,Dotted|Pos:0|Opts:Stem=Up',                        // B3 (treble clef an octave down)
    '|Bar', '|Rest|Dur:Whole',
    '|AddStaff|Name:"Alto"',
    '|Clef|Type:Treble|OctaveShift:Octave Down', '|TimeSig|Signature:3/4',
    '|Note|Dur:4th|Pos:-2|Opts:Stem=Down', '|Note|Dur:Half|Pos:-3|Opts:Stem=Down',
    '|Bar', '|Rest|Dur:Whole|Visibility:Never',
    '|AddStaff|Name:"Guide"',
    '|StaffProperties|Visible:N',
    '|Clef|Type:Treble', '|Note|Dur:Half,Dotted|Pos:0', '|Bar', '|Rest|Dur:Whole',
    '|AddStaff|Name:"Drums"',
    '|StaffProperties|Channel:10',
    '|Clef|Type:Percussion', '|TimeSig|Signature:3/4',
    '|Note|Dur:4th|Pos:-8', '|Note|Dur:4th|Pos:#-5x', '|Note|Dur:4th|Pos:-7',   // C2 kick, F#2 closed hi-hat, D2 snare
    '|Bar', '|Rest|Dur:Whole',
    '!NoteWorthyComposer-End',
  ]);
  const s = await importNwc(enc(txt));
  assert.equal(validateScore(s).ok, true);
  assert.deepEqual(s.parts.map(p => [p.name, p.instrument, p.staves.length]), [['Piano', 'piano', 2], ['Choir', 'voice', 1], ['Drums', 'drumset', 1]]);
  assert.ok(s.importInfo.warnings.some(w => /숨겨진 보표 1개/.test(w)), 'the hidden staff is reported');
  const m = s.measures[0];
  // right hand: the half note of the split chord (and the rest of the rest chord) is the upper
  // voice, the notes the staff moves on with are the lower one
  assert.deepEqual(m.staves[0].voices.map(midis), [['74', 'r'], ['62', '64', '71']]);
  assert.deepEqual(m.staves[0].voices.map(v => v.map(durTicks)), [[1920, 960], [960, 960, 960]]);
  assert.deepEqual(midis(m.staves[1].voices[0]), ['50']);
  assert.equal(s.parts[0].staves[1].clef, 'bass');
  // two layered staves are two voices of one staff
  assert.equal(s.parts[1].staves[0].clef, 'treble8vb');
  assert.deepEqual(m.staves[2].voices.map(midis), [['59'], ['55', '53']]);
  assert.deepEqual(s.measures[1].staves[2].voices, [[]], 'filler rests of a layered staff are dropped');
  // percussion: the bass-clef pitch names the instrument, the staff position the line
  const drums = s.parts[2].staves[0];
  assert.equal(drums.type, 'percussion');
  assert.equal(s.parts[2].midiChannel, 9);
  const keys = m.staves[3].voices[0].map(ev => ev.notes[0].drum);
  assert.deepEqual(keys.map(k => drums.drumMap[k].midi), [36, 42, 38]);
  assert.deepEqual(keys.map(k => drums.drumMap[k].line), [12, 9, 11]);
  assert.equal(drums.drumMap[keys[1]].head, 'x');
  assert.deepEqual(s.measures[0].timeSig, { num: 3, den: 4, display: 'normal' });
});

test('NWC: lyric splitting rules', () => {
  const t = (text, uas) => splitNwcLyric(text, uas).map(x => x.text + ':' + x.syllabic[0] + (x.extend ? '_' : ''));
  assert.deepEqual(t('one two\nthree'), ['one:s', 'two:s', 'three:s']);
  assert.deepEqual(t('jun-gle bells'), ['jun:b', 'gle:e', 'bells:s']);
  assert.deepEqual(t('al-le-lu-ia'), ['al:b', 'le:m', 'lu:m', 'ia:e']);
  assert.deepEqual(t('wi - - wi'), ['wi:s', '-:s', '-:s', 'wi:s'], 'a hyphen on its own is a syllable');
  assert.deepEqual(t('우- 야--'), ['우-:s', '야--:s'], 'hyphens at the end of a word stay');
  assert.deepEqual(t('1._오 늘'), ['1. 오:s', '늘:s'], 'underscore = space inside a syllable');
  assert.deepEqual(t('a _ b'), ['a:s', ':s', 'b:s'], 'underscore alone skips a note');
  assert.deepEqual(t('Ah___ b', false), ['Ah:s_', 'b:s'], 'UnderscoreAsSpace:N — extender line');
  assert.deepEqual(t(''), []);
});

test('NWC: chord names', () => {
  assert.deepEqual(parseChordName('F#m7b5/A'), { text: 'F#m7b5/A', root: 'F#', kind: 'm7b5', bass: 'A', weak: false });
  assert.equal(parseChordName('C').weak, true);
  assert.equal(parseChordName('Bb').weak, false);
  assert.equal(parseChordName('N.C.').text, 'N.C.');
  for (const no of ['Coda', 'Fine', 'rit.', 'Hello', '[A]', '1.']) assert.equal(parseChordName(no), null, no);
});

test('NWC: a rehearsal letter is not a chord, three different letters are', async () => {
  const make = (texts) => nwctxt(['!NoteWorthyComposer(2.75)', '|AddStaff|Name:"S"', '|Clef|Type:Treble', '|TimeSig|Signature:4/4',
    ...texts.flatMap(t => [`|Text|Text:"${t}"|Font:StaffBold|Pos:9`, '|Note|Dur:Whole|Pos:0', '|Bar']), '|Rest|Dur:Whole', '!NoteWorthyComposer-End']);
  const count = async (texts) => (await importNwc(enc(make(texts)))).measures.reduce((n, m) => n + (m.chords ? m.chords.length : 0), 0);
  assert.equal(await count(['A', 'B', 'C']), 0, 'A B C in order: rehearsal letters');
  assert.equal(await count(['C', 'F', 'G', 'C']), 4);
  assert.equal(await count(['C', 'Am', 'F', 'G']), 4);
  assert.equal(await count(['G', 'G']), 0, 'too little to tell');
  const s = await importNwc(enc(make(['[A]', 'C', 'G7'])));
  assert.equal(s.measures[0].rehearsalMark, 'A');
  assert.deepEqual(s.measures[1].chords.map(c => c.text), ['C']);
});

test('NWC: text encoding — CP949 detected, explicit choice honoured, fallback for the undecidable', async () => {
  // an old-style nwctxt in the ANSI code page of a Korean Windows
  const old = nwctxt(['!NoteWorthyComposer(2.0)', '|SongInfo|Title:"고향의 봄"|Author:"홍난파"', '|AddStaff|Name:"노래"',
    '|Lyric1|Text:"나의 살던 고향은 꽃피는 산골"', '|Clef|Type:Treble', '|TimeSig|Signature:4/4',
    '|Note|Dur:4th|Pos:0', '|Note|Dur:4th|Pos:0', '|Note|Dur:4th|Pos:0', '|Note|Dur:4th|Pos:0', '|Bar', '|Note|Dur:Whole|Pos:0', '!NoteWorthyComposer-End']);
  const cp949 = encodeText(old, 'euc-kr');
  assert.equal(cp949.lost, 0);
  assert.ok(cp949.bytes.length < enc(old).length, 'two bytes per syllable');
  const auto = await importNwc(cp949.bytes);
  assert.equal(auto.meta.title, '고향의 봄');
  assert.equal(auto.meta.composer, '홍난파');
  assert.deepEqual(words(auto.measures[0].staves[0].voices[0]), ['나의', '살던', '고향은', '꽃피는']);
  assert.equal(auto.importInfo.encoding, 'euc-kr');
  assert.equal(auto.importInfo.encodingGuessed, true);
  // the caller's choice is used as it is, right or wrong
  const forced = await importNwc(cp949.bytes, { encoding: 'windows-1252' });
  assert.equal(forced.importInfo.encoding, 'windows-1252');
  assert.equal(forced.importInfo.encodingGuessed, false);
  assert.notEqual(forced.meta.title, '고향의 봄');
  const right = await importNwc(cp949.bytes, { encoding: 'euc-kr' });
  assert.equal(right.meta.title, '고향의 봄');
  assert.equal(right.importInfo.encodingGuessed, false);
  // a Locale line names the code page: no guessing
  const withLocale = encodeText(old.replace('\r\n', '\r\n|Locale|ACP:949\r\n'), 'euc-kr').bytes;
  const hinted = await importNwc(withLocale);
  assert.deepEqual([hinted.importInfo.encoding, hinted.importInfo.encodingGuessed, hinted.meta.title], ['euc-kr', false, '고향의 봄']);
  // one pair of high bytes can be Korean or Western: the fallback decides
  const tiny = nwctxt(['!NoteWorthyComposer(2.0)', '|SongInfo|Title:"X"', '|AddStaff|Name:"S"', '|Lyric1|Text:"@"', '|Clef|Type:Treble', '|Note|Dur:Whole|Pos:0', '!NoteWorthyComposer-End']);
  const at = enc(tiny).indexOf(0x40);
  const bytes = new Uint8Array([...enc(tiny).slice(0, at), 0xc0, 0xcc, ...enc(tiny).slice(at + 1)]);     // "이" in CP949, "ÀÌ" in CP1252
  const ko = await importNwc(bytes, { fallbackEncoding: 'euc-kr' });
  assert.deepEqual([words(ko.measures[0].staves[0].voices[0])[0], ko.importInfo.encoding, ko.importInfo.encodingGuessed], ['이', 'euc-kr', true]);
  const west = await importNwc(bytes);
  assert.deepEqual([words(west.measures[0].staves[0].voices[0])[0], west.importInfo.encoding, west.importInfo.encodingGuessed], ['ÀÌ', 'windows-1252', true]);
  // plain ASCII needs no decision
  assert.equal((await importNwc(enc(tiny))).importInfo.encodingGuessed, false);
  assert.equal(detectEncoding([Uint8Array.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9])], {}).encoding, 'euc-kr');
});

test('NWC: CP949 covers every Hangul syllable, also where the platform decoder only knows KS X 1001', () => {
  // the classic test word: 똠 is outside KS X 1001 (0x8C63 in the Windows extension)
  assert.deepEqual([...encodeText('똠방각하', 'euc-kr').bytes], [0x8c, 0x63, 0xb9, 0xe6, 0xb0, 0xa2, 0xc7, 0xcf]);
  assert.equal(decodeBytes(Uint8Array.from([0x8c, 0x63, 0xb9, 0xe6, 0xb0, 0xa2, 0xc7, 0xcf]), 'euc-kr'), '똠방각하');
  assert.deepEqual([...encodeText('갂힣', 'euc-kr').bytes], [0x81, 0x41, 0xc6, 0x52]);
  let all = '';
  for (let c = 0xac00; c <= 0xd7a3; c++) all += String.fromCharCode(c);
  const e = encodeText(all, 'euc-kr');
  assert.equal(e.lost, 0);
  assert.equal(e.bytes.length, all.length * 2);
  assert.equal(decodeBytes(e.bytes, 'euc-kr'), all);
  // what the code page does not have is counted, not silently dropped
  assert.deepEqual([encodeText('a😀b', 'euc-kr').lost, encodeText('é', 'windows-1252').lost, encodeText('한', 'windows-1252').lost], [1, 0, 1]);
});

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------
/** A lead sheet + piano with everything the exporter writes. */
function songScore() {
  const s = createScore({ title: '아리랑 변주', composer: '전래 민요', instruments: ['voice', 'piano'], measures: 0, keyFifths: -1, tempo: 0 });
  s.meta.lyricist = '작사 미상'; s.meta.copyright = '© 2026 JSE';
  const note = (p, base = 'quarter', dots = 0, extra = {}) => Object.assign(makeNote(p, base, dots), extra);
  const lyr = (ev, text, syllabic = 'single', verse = 1) => { (ev.lyrics || (ev.lyrics = [])).push({ verse, text, syllabic }); return ev; };
  const chord = (text, tick) => ({ id: newId(), tick, text });
  const add = (fill) => { const m = createMeasure(s); fill(m); s.measures.push(m); return m; };
  const ev = {};
  // 0: upbeat
  add((m) => {
    m.timeSig = { num: 3, den: 4, display: 'normal' }; m.keySig = { fifths: -1, mode: 'major' }; m.pickup = true;
    m.tempo = { bpm: 84, beatUnit: 'quarter', dots: 0, text: 'Moderato', showBpm: true };
    m.staves[0].voices[0] = [lyr(lyr(note('C4'), '아'), '청', 'single', 2)];
    m.staves[1].voices[0] = [makeRest('quarter')];
    m.staves[2].voices[0] = [makeRest('quarter')];
  });
  // 1
  add((m) => {
    m.barlineLeft = 'repeat-start'; m.rehearsalMark = 'A';
    m.chords = [chord('F', 0), chord('C7/E', 1920)];
    ev.a = lyr(lyr(note('F4', 'quarter', 1), '리', 'begin'), '천', 'single', 2);
    ev.b = lyr(note('G4', 'eighth'), '랑', 'end');
    ev.c = lyr(lyr(note('A4', 'quarter', 0, { dynamic: 'mf' }), '아'), '하', 'single', 2);
    m.staves[0].voices[0] = [ev.a, ev.b, ev.c];
    m.staves[1].voices[0] = [{ id: newId(), kind: 'note', dur: { base: 'half', dots: 1 }, notes: [{ step: 'A', octave: 4, alter: 0 }, { step: 'C', octave: 5, alter: 0 }] }];
    m.staves[1].voices[1] = [note('F4'), note('E4'), note('F4')];
    m.staves[2].voices[0] = [note('F2', 'half'), note('E2')];
  });
  // 2: first ending
  add((m) => {
    m.barlineRight = 'repeat-end';
    m.chords = [chord('Bb', 0)];
    ev.d = lyr(note('B4', 'quarter', 0, { notes: [{ step: 'B', octave: 4, alter: -1, tieStart: true }] }), '리');
    ev.e = note('B4', 'eighth', 0, { notes: [{ step: 'B', octave: 4, alter: -1, tieEnd: true }] });
    ev.f = lyr(note('B4', 'eighth', 0, { notes: [{ step: 'B', octave: 4, alter: 0 }] }), '요');           // B natural against the key
    ev.g = note('C5', 'quarter', 0, { fermata: 'above' });
    m.staves[0].voices[0] = [ev.d, ev.e, ev.f, ev.g];
    m.staves[1].voices[0] = [makeRest('half', 1)];
    m.staves[2].voices[0] = [note('B2', 'half', 1, { notes: [{ step: 'B', octave: 2, alter: -1 }] })];
  });
  // 3: second ending, triplet, key and time change follow
  add((m) => {
    m.barlineRight = 'double'; m.markers = ['fine'];
    const tid = newId();
    const t = (p, text) => lyr(Object.assign(note(p, 'eighth'), { tuplet: { id: tid, num: 3, den: 2, show: 'number' } }), text);
    m.staves[0].voices[0] = [t('A4', '고'), t('G4', '개'), t('F4', '로'), lyr(note('F4', 'half'), '넘')];
    m.staves[1].voices[0] = [];
    m.staves[2].voices[0] = [note('F2', 'half', 1)];
  });
  // 4
  add((m) => {
    m.timeSig = { num: 4, den: 4, display: 'normal' }; m.keySig = { fifths: 2, mode: 'minor' }; m.markers = ['segno'];
    m.chords = [chord('Bm', 0), chord('F#7', 1920)];
    ev.h = note('B4', 'whole');
    m.staves[0].voices[0] = [ev.h];
    m.staves[1].voices[0] = [note('D4', 'half'), note('C4', 'half', 0, { notes: [{ step: 'C', octave: 4, alter: 1 }] })];
    m.staves[2].voices[0] = [note('B2', 'whole')];
  });
  // 5
  add((m) => {
    m.barlineRight = 'final'; m.markers = ['dsAlFine'];
    ev.i = lyr(note('F4', 'whole', 0, { notes: [{ step: 'F', octave: 4, alter: 1 }] }), '간 다');
    m.staves[0].voices[0] = [ev.i];
    m.staves[1].voices[0] = [];
    m.staves[2].voices[0] = [note('B2', 'whole')];
  });
  s.spanners.push({ id: newId(), type: 'volta', from: { measureId: s.measures[2].id }, to: { measureId: s.measures[2].id }, number: '1.', voltaType: 'closed' });
  s.spanners.push({ id: newId(), type: 'volta', from: { measureId: s.measures[3].id }, to: { measureId: s.measures[3].id }, number: '2.', voltaType: 'open' });
  s.spanners.push({ id: newId(), type: 'slur', from: { eventId: ev.a.id }, to: { eventId: ev.b.id } });
  s.spanners.push({ id: newId(), type: 'crescendo', from: { eventId: ev.h.id }, to: { eventId: ev.i.id } });
  validateScore(s, { repair: true });
  return s;
}

/** What a round trip has to keep: notes, rhythm, ties, lyrics, chords, signatures, repeats, flow signs. */
function essence(score) {
  const mIndex = new Map(score.measures.map((m, i) => [m.id, i]));
  const where = new Map();
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => v.forEach((ev, ei) => where.set(ev.id, `${mi}:${si}:${vi}:${ei}`)))));
  return {
    title: score.meta.title, composer: score.meta.composer, lyricist: score.meta.lyricist,
    parts: score.parts.map(p => [p.name, p.staves.map(st => st.clef).join(',')]),
    measures: score.measures.map((m) => ({
      time: m.timeSig ? `${m.timeSig.num}/${m.timeSig.den}` : '', key: m.keySig ? `${m.keySig.fifths}${m.keySig.mode[1]}` : '',
      tempo: m.tempo ? `${m.tempo.bpm} ${m.tempo.text}` : '', pickup: !!m.pickup,
      bars: `${m.barlineLeft || ''}|${m.barlineRight && m.barlineRight !== 'single' ? m.barlineRight : ''}`,
      markers: (m.markers || []).join(','), reh: m.rehearsalMark || '',
      chords: (m.chords || []).map(c => `${c.tick}:${c.text}`).join(' '),
      staves: m.staves.map(sm => sm.voices.map(v => v.filter(ev => !ev.hidden).map(ev => [
        ev.kind === 'rest' ? 'r' : [...ev.notes].sort((a, b) => midiOf(a) - midiOf(b)).map(n => `${n.step}${n.alter || 0}/${n.octave}${n.tieStart ? '~' : ''}${n.tieEnd ? '(' : ''}`).join('+'),
        ev.grace ? 'g' : durTicks(ev), ev.tuplet ? 't' : '', ev.fermata || '', ev.dynamic || '',
        (ev.lyrics || []).map(l => `${l.verse}${(l.syllabic || 'single')[0]}${l.text}`).join('|'),
      ].join(' ')))),
    })),
    spanners: score.spanners.map(sp => (sp.type === 'volta' ? `volta ${sp.number} ${mIndex.get(sp.from.measureId)}-${mIndex.get(sp.to.measureId)}` : `${sp.type} ${where.get(sp.from.eventId)}→${where.get(sp.to.eventId)}`)).sort(),
  };
}

test('NWC: export → import keeps notes, rhythm, Hangul lyrics, chords, repeats (nwctxt, .nwc 2.75, .nwc 1.75)', async () => {
  const score = songScore();
  const want = essence(score);
  // JSE draws an empty bar as a bar of rest; NWC needs the rest written
  const warnings = [];
  const text = exportNwctxt(score, { warnings });
  assert.ok(text.startsWith('!NoteWorthyComposer(2.75)\r\n'));
  assert.ok(text.endsWith('!NoteWorthyComposer-End\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'CRLF line ends');
  assert.match(text, /\|SongInfo\|Title:"아리랑 변주"\|Author:"전래 민요"\|Lyricist:"작사 미상"/);
  assert.match(text, /\|Lyric1\|Text:"아 리-랑 아 리 요 고 개 로 넘\\n간_다"/, 'one text per verse, a new line every four bars');
  assert.match(text, /\|Lyric2\|Text:"청 천 _ 하"/, 'a note that sings in verse 1 only is skipped in verse 2');
  assert.match(text, /\|Note\|Dur:8th\|Pos:-2\|Opts:[^|]*Lyric=Always/, 'a syllable under the end of a slur');
  assert.match(text, /\|Note\|Dur:4th\|Pos:1\|Opts:Lyric=Never/, 'a note without a syllable in the middle of the text');
  assert.match(text, /\|Key\|Signature:Bb\|Tonic:F/);
  assert.match(text, /\|Key\|Signature:F#,C#\|Tonic:B/);
  assert.match(text, /\|Bar\|Style:MasterRepeatOpen/);
  assert.match(text, /\|Ending\|Endings:1\r\n/);
  assert.match(text, /\|Ending\|Endings:2,D\r\n/, 'the last ending is also the one played after D.S.');
  assert.match(text, /\|Flow\|Style:DSalFine/);
  assert.match(text, /\|Text\|Text:"C7\/E"\|Font:StaffBold/);
  assert.match(text, /\|Text\|Text:"\[A\]"/);
  assert.match(text, /WithNextStaff:Brace,ConnectBars,Layer/, 'the second voice of the right hand is a layered staff');
  for (const line of text.split('\r\n')) if (/Beam/.test(line)) assert.match(line, /Stem=(Up|Down)/, 'NWC wants a stem direction on beamed notes');
  assert.deepEqual(warnings, ['둘째 성부부터는 NWC의 겹침 보표(Layer)로 저장했습니다']);

  const fromText = await importNwc(enc(text));
  assert.equal(validateScore(fromText).ok, true);
  assert.deepEqual(essence(fromText), want);

  // the .nwc file of NWC 2.75: compressed container around the same text
  const nwc = await exportNwc(score);
  assert.deepEqual([...nwc.slice(0, 6)], [...enc('[NWZ]\0')]);
  const plain = inflateZlibSync(nwc.slice(6));
  const head = new TextDecoder('latin1').decode(plain.slice(0, 96));
  assert.ok(head.startsWith('[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0\x4b\x02\x02\0\0\0N/A\0'));
  assert.match(head.slice(55, 78), /^[0-3][.0-9A-Z_a-z]{21}\0$/, 'document id');
  assert.deepEqual([...plain.slice(80, 88)], [0xb5, 0x03, 0, 0, 0, 0, 0x24, 0], 'code page 949 for a Korean score');
  assert.equal(new TextDecoder().decode(plain.slice(88, 115)), '!NoteWorthyComposer(2.75)\r\n');
  const from275 = await importNwc(nwc);
  assert.deepEqual(from275.importInfo.version, '2.75');
  assert.equal(from275.importInfo.container, 'nwz');
  assert.deepEqual(essence(from275), want);
  const raw = await exportNwc(score, { compress: false, id: '0'.repeat(22), date: null });
  assert.equal(raw[0], 0x5b);
  assert.deepEqual(essence(await importNwc(raw)), want);
  // also when the browser has no CompressionStream: zlib "stored" blocks
  const stored = new Uint8Array([...enc('[NWZ]\0'), ...deflateStoredSync(raw)]);
  assert.deepEqual(essence(await importNwc(stored)), want);

  // the old binary format, text in CP949
  const w175 = [];
  const old = await exportNwc(score, { version: '1.75', warnings: w175 });
  const bin = inflateZlibSync(old.slice(6));
  assert.deepEqual([...bin.slice(45, 47)], [75, 1], 'version 1.75');
  const doc = await readNwcDocument(old, {});
  assert.equal(doc.doc.version, '1.75');
  assert.equal(doc.encoding, 'euc-kr');
  assert.equal(doc.encodingGuessed, false, 'the font tables name the Korean character set');
  const from175 = await importNwc(old);
  const e175 = essence(from175);
  // what 1.75 does not have: a lyricist field, hairpins (written as "cresc."), labels on staves,
  // the tonic of a key signature (so minor keys come back as their relative major)
  const noMode = (e) => ({ ...e, spanners: [], parts: [], measures: e.measures.map(m => ({ ...m, key: m.key.replace(/[ai]$/, '') })) });
  assert.deepEqual(noMode({ ...e175, lyricist: want.lyricist }), noMode(want));
  assert.deepEqual(e175.spanners, want.spanners.filter(x => !/^crescendo/.test(x)));
  assert.ok(w175.some(w => /1\.75에 없는 기호/.test(w)));
});

test('NWC: chord symbols as ChordPlay.nw objects (NWC 2.75 plugin) on request', async () => {
  const score = songScore();
  const text = exportNwctxt(score, { chords: 'plugin' });
  assert.match(text, /\|User\|ChordPlay\.nw\|Pos:8\|Name:C7\/E\r\n/);
  assert.ok(!/\|Text\|Text:"C7\/E"/.test(text));
  const back = await importNwc(enc(text));
  assert.deepEqual(back.measures.slice(1, 3).map(m => m.chords.map(c => `${c.tick}:${c.text}`)), [['0:F', '1920:C7/E'], ['0:Bb']]);
});

test('NWC: the JSE sample score survives a round trip', async () => {
  const score = sampleScore();
  validateScore(score, { repair: true });
  const back = await importNwc(enc(exportNwctxt(score)));
  const a = essence(score), b = essence(back);
  assert.equal(b.title, a.title);
  assert.deepEqual(b.measures.map(m => m.staves), a.measures.map(m => m.staves));
  assert.deepEqual(b.measures.map(m => m.chords), a.measures.map(m => m.chords));
  assert.deepEqual(b.measures.map(m => [m.time, m.key, m.bars, m.markers, m.reh]), a.measures.map(m => [m.time, m.key, m.bars, m.markers, m.reh]));
  // exporting what was imported gives the same text again
  assert.equal(exportNwctxt(back), exportNwctxt(await importNwc(enc(exportNwctxt(back)))));
});

test('NWC: what NWC cannot write is approximated and reported', async () => {
  const s = createScore({ title: 'Quintuplet', instruments: ['melody'], measures: 0 });
  const m = createMeasure(s);
  m.timeSig = { num: 2, den: 4, display: 'normal' }; m.keySig = { fifths: 0, mode: 'major' };
  const tid = newId();
  m.staves[0].voices[0] = ['C5', 'D5', 'E5', 'F5', 'G5'].map(p => Object.assign(makeNote(p, '16th'), { tuplet: { id: tid, num: 5, den: 4, show: 'number' } }));
  m.staves[0].voices[0].push(makeNote('A4', 'quarter'));
  s.measures.push(m);
  const warnings = [];
  const back = await importNwc(enc(exportNwctxt(s, { warnings })));
  assert.ok(warnings.some(w => /잇단음표/.test(w)), 'tuplet warning');
  const v = back.measures[0].staves[0].voices[0];
  assert.deepEqual(midis(v), ['72', '74', '76', '77', '79', '69']);
  assert.equal(v.reduce((n, ev) => n + durTicks(ev), 0), 1920, 'the bar keeps its length');
  assert.ok(!back.measures[0].pickup);
});
