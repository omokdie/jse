// MuseScore (.mscz / .mscx) import + export — app/js/io/mscz.js
//
// Fixtures (tools/tests/fixtures/mscz-*):
//   mscz-sample-ms3.mscz  the JSE sample score (tools/fixtures.mjs sampleScore) written by real MuseScore 3.6.2 (format 3.02)
//   mscz-sample-ms4.mscz  the same score written by real MuseScore Studio 4.5.2 (format 4.50, style in score_style.mss)
//   mscz-v2-flat.mscx     hand-written, MuseScore 2 layout (format 2.06)
//   mscz-v5-eid.mscx      hand-written, layout of the development format 5.00 (<SpannerMap>, eids)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { importMscz, importMscx, exportMscx, exportMscz, looksLikeMscx, MSCZ_EXTENSIONS } from '../../app/js/io/mscz.js';
import { exampleScore } from '../../app/js/model/examples.js';
import { sampleScore, drumTabScore } from '../fixtures.mjs';
import { createScore, createPart, createMeasure, makeNote, makeRest, newId, validateScore, durTicks, midiOf, measureCapacity, effectiveTimeSig } from '../../app/js/model/score.js';
import { facts, compare } from '../mscz/compare.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('../../app/vendor/jszip.min.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => fs.readFileSync(path.join(here, 'fixtures', name));

/** Asserts that two scores hold the same music (positions, pitches, spelling, ties, lyrics, chord symbols, meter, keys, repeats, lines). */
function sameMusic(a, b, label, { staff = true, spanners = true } = {}) {
  const r = compare(facts(a, { ottavaWritten: true }), facts(b, { ottavaWritten: true }));
  assert.equal(r.measuresB, r.measuresA, `${label}: measures`);
  for (const k of [staff ? 'staffPitch' : 'partPitch', 'spell', 'tie', 'lyrics', 'syllabic', 'chords', 'clefs']) {
    assert.deepEqual({ a: r[k].a, b: r[k].b, onlyA: r[k].onlyA, onlyB: r[k].onlyB }, { a: r[k].a, b: r[k].a, onlyA: [], onlyB: [] }, `${label}: ${k}`);
  }
  assert.deepEqual(r.meter, [], `${label}: meter`);
  assert.deepEqual(r.keys, [], `${label}: keys`);
  assert.deepEqual(r.repeats, [], `${label}: repeats`);
  if (spanners) assert.deepEqual(Object.entries(r.spanners.b).sort(), Object.entries(r.spanners.a).sort(), `${label}: lines`);
}
const noOverfull = (score) => {
  score.measures.forEach((m, mi) => {
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach(sm => sm.voices.forEach(v => {
      if (!v.length || (v.length === 1 && v[0].fullMeasureRest)) return;
      const t = v.reduce((s, e) => s + durTicks(e), 0);
      assert.ok(t <= cap + 1 && (t >= cap - 1 || m.pickup), `measure ${mi + 1}: voice has ${t} of ${cap} ticks`);
    }));
  });
};
/**
 * MuseScore has no measure-anchored text: a ScoreDoc measure text is written as a staff text on the first
 * note of the measure and comes back as a text of that event. Move them there for comparing.
 */
function textsOnEvents(score) {
  const s = JSON.parse(JSON.stringify(score));
  for (const m of s.measures) {
    const keep = [];
    for (const t of m.texts || []) {
      const ev = t.style === 'system' ? null : (m.staves[t.staffIndex || 0].voices[0] || []).find(e => !e.grace);
      if (!ev || ev.fullMeasureRest) { keep.push(t); continue; }
      (ev.texts || (ev.texts = [])).unshift({ text: t.text, placement: t.placement, style: t.style });
    }
    if (keep.length) m.texts = keep; else delete m.texts;
  }
  return s;
}
const eventsOf = (score) => { const out = []; score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => v.forEach(ev => out.push({ ev, mi, si, vi }))))); return out; };

test('mscz: detection', () => {
  assert.deepEqual(MSCZ_EXTENSIONS, ['.mscz', '.mscx']);
  assert.equal(looksLikeMscx('<?xml version="1.0"?>\n<museScore version="3.02">'), true);
  assert.equal(looksLikeMscx(new TextEncoder().encode('<?xml version="1.0"?><museScore version="4.20"><Score/></museScore>')), true);
  assert.equal(looksLikeMscx('<score-partwise version="4.0">'), false);
  assert.equal(looksLikeMscx(fixture('mscz-sample-ms3.mscz')), false);      // a zip is not XML text
  assert.equal(looksLikeMscx(null), false);
});

test('mscz: file written by MuseScore 3.6.2 gives the music of the score it was made from', async () => {
  const src = sampleScore();
  const score = await importMscz(fixture('mscz-sample-ms3.mscz'), { JSZip, fileName: 'sample.mscz' });
  assert.equal(validateScore(score).ok, true);
  assert.equal(score.importInfo.from, 'musescore');
  assert.equal(score.importInfo.version, '3.02');
  assert.equal(score.importInfo.program, '3.6.2');
  assert.ok(Array.isArray(score.importInfo.warnings));
  assert.equal(score.meta.title, src.meta.title);
  assert.equal(score.meta.composer, src.meta.composer);
  assert.equal(score.meta.lyricist, src.meta.lyricist);
  assert.deepEqual(score.parts.map(p => [p.name, p.staves.map(s => s.clef)]), src.parts.map(p => [p.name, p.staves.map(s => s.clef)]));
  sameMusic(src, score, 'ms3');
  noOverfull(score);
  assert.equal(score.measures[0].tempo.bpm, src.measures[0].tempo.bpm);
  assert.equal(score.measures[0].rehearsalMark, src.measures[0].rehearsalMark);
});

test('mscz: file written by MuseScore 4.5.2 (style in a separate file)', async () => {
  const src = sampleScore();
  const score = await importMscz(fixture('mscz-sample-ms4.mscz'), { JSZip });
  assert.equal(validateScore(score).ok, true);
  assert.equal(score.importInfo.version, '4.50');
  assert.equal(score.meta.title, src.meta.title);
  sameMusic(src, score, 'ms4');
  noOverfull(score);
  // page size and staff size come from score_style.mss inside the archive
  assert.equal(score.settings.pageSize, 'A4');
  assert.ok(Math.abs(score.settings.staffSpaceMm - 1.75) < 0.01, `staff space ${score.settings.staffSpaceMm}`);
  // ArrayBuffer input works too
  const u8 = fixture('mscz-sample-ms4.mscz');
  const again = await importMscz(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), { JSZip });
  assert.equal(again.measures.length, score.measures.length);
});

test('mscz: MuseScore 2 layout (flat measures, absolute ticks, ids)', async () => {
  const score = importMscx(fixture('mscz-v2-flat.mscx').toString('utf8'));
  assert.equal(score.importInfo.version, '2.06');
  assert.equal(score.meta.title, 'Fixture Two');
  assert.equal(score.meta.composer, 'JSE test');
  assert.equal(score.meta.copyright, 'public domain');
  assert.equal(score.parts.length, 1);
  assert.equal(score.parts[0].name, 'Flute');
  assert.equal(score.parts[0].instrument, 'flute');
  assert.equal(score.parts[0].midiProgram, 73);
  assert.equal(score.measures.length, 4);
  const [m1, m2, m3, m4] = score.measures;
  assert.deepEqual(m1.timeSig, { num: 3, den: 4, display: 'normal' });
  assert.deepEqual(m1.keySig, { fifths: 2, mode: 'major' });
  assert.equal(m1.pickup, true);
  assert.deepEqual(m1.tempo, { bpm: 120, beatUnit: 'quarter', dots: 0, text: 'Andante', showBpm: true });
  const first = m1.staves[0].voices[0][0];
  assert.equal(first.dynamic, 'mf');
  assert.deepEqual(first.lyrics, [{ verse: 1, text: 'Hel', syllabic: 'begin' }, { verse: 2, text: 'Good', syllabic: 'single' }]);
  // measure 2: two voices, the second one positioned by <tick> + <track>
  const [v0, v1] = m2.staves[0].voices;
  assert.deepEqual(v0.map(e => Math.round(durTicks(e))), [960, 320, 320, 320, 960]);
  assert.deepEqual(v0.slice(1, 4).map(e => [e.tuplet.num, e.tuplet.den]), [[3, 2], [3, 2], [3, 2]]);
  assert.equal(new Set(v0.slice(1, 4).map(e => e.tuplet.id)).size, 1);
  assert.deepEqual(v0[4].articulations, ['staccato']);
  assert.equal(v0[4].notes[0].tieStart, true);
  assert.deepEqual(v1.map(e => [e.kind, e.dur.base, !!e.hidden]), [['rest', 'quarter', true], ['note', 'half', false]]);
  assert.equal(v1[1].stem, 'down');
  assert.equal(m2.barlineLeft, 'repeat-start');
  assert.deepEqual(m2.chords.map(c => [c.tick, c.text, c.root, c.kind || '', c.bass || '']), [[0, 'D', 'D', '', ''], [960, 'A7/C#', 'A', '7', 'C#']]);
  assert.equal(m3.barlineRight, 'repeat-end');
  assert.equal(m3.staves[0].voices[0][0].notes[0].tieEnd, true);
  assert.equal(m3.staves[0].voices[0][1].notes[0].accidental, 'natural');           // user-added accidental
  assert.equal(m4.barlineRight, 'final');
  assert.equal(m4.staves[0].voices[0][2].fermata, 'above');
  const types = score.spanners.map(s => s.type).sort();
  assert.deepEqual(types, ['crescendo', 'slur', 'volta', 'volta']);
  const voltas = score.spanners.filter(s => s.type === 'volta');
  assert.deepEqual(voltas.map(v => [v.number, v.voltaType, v.from.measureId === v.to.measureId]), [['1.', 'closed', true], ['2.', 'open', true]]);
  assert.equal(voltas[0].from.measureId, m3.id);
  assert.equal(voltas[1].from.measureId, m4.id);
  const slur = score.spanners.find(s => s.type === 'slur');
  assert.equal(slur.from.eventId, v0[1].id); assert.equal(slur.to.eventId, v0[3].id);
  const hairpin = score.spanners.find(s => s.type === 'crescendo');
  assert.equal(hairpin.from.eventId, v0[1].id); assert.equal(hairpin.to.eventId, v0[4].id);
  // page: US Letter with 1/2 inch side margins, 1 inch at the bottom; staff space 1.6 mm
  assert.equal(score.settings.pageSize, 'Letter');
  assert.deepEqual(score.settings.marginsMm, { top: 12.7, bottom: 25.4, left: 12.7, right: 12.7 });
  assert.equal(score.settings.staffSpaceMm, 1.6);
  // text styles: only what differs from MuseScore's own defaults (FreeSerif 12 pt for the composer is a default)
  assert.deepEqual(Object.keys(score.settings.textStyles), ['title']);
  assert.equal(score.settings.textStyles.title.family, 'Nanum Myeongjo');
  assert.ok(Math.abs(score.settings.textStyles.title.size - 30 * 0.3528 / 1.6) < 0.01);
  assert.equal(score.settings.textStyles.title.bold, true);
  noOverfull(score);
});

test('mscz: development format 5.00 (SpannerMap, elements referenced by eid)', () => {
  const score = importMscx(fixture('mscz-v5-eid.mscx').toString('utf8'));
  assert.equal(score.importInfo.version, '5.00');
  assert.ok(score.importInfo.warnings.some(w => /5\.00/.test(w)));
  assert.equal(score.parts[0].name, 'Violin');
  assert.equal(score.parts[0].abbreviation, 'Vn.');
  assert.deepEqual(score.measures[0].keySig, { fifths: -1, mode: 'major' });
  const ev = eventsOf(score).map(x => x.ev);
  assert.equal(ev[1].notes[0].tieStart, true);
  assert.equal(ev[2].notes[0].tieEnd, true);
  const by = Object.fromEntries(score.spanners.map(s => [s.type, s]));
  assert.deepEqual([by.slur.from.eventId, by.slur.to.eventId], [ev[0].id, ev[1].id]);
  assert.deepEqual([by.diminuendo.from.eventId, by.diminuendo.to.eventId], [ev[2].id, ev[3].id]);
  assert.deepEqual([by.volta.from.measureId, by.volta.to.measureId, by.volta.number], [score.measures[1].id, score.measures[1].id, '1.']);
});

test('mscz: MuseScore 1.x and foreign input are refused with a Korean explanation', async () => {
  assert.throws(() => importMscx('<?xml version="1.0"?><museScore version="1.14"><Staff id="1"><Measure number="1"/></Staff></museScore>'), /MuseScore 1\.x 형식\(1\.14\)/);
  assert.throws(() => importMscx('<score-partwise version="4.0"/>'), /MuseScore 문서가 아닙니다/);
  assert.throws(() => importMscx('<museScore version="3.02"></museScore>'), /악보 내용/);
  await assert.rejects(() => importMscz(new TextEncoder().encode('hello'), { JSZip }), /MuseScore 파일이 아닙니다/);
  const zip = new JSZip(); zip.file('score.musicxml', '<score-partwise/>');
  await assert.rejects(async () => importMscz(await zip.generateAsync({ type: 'uint8array' }), { JSZip }), /MusicXML/);
});

for (const [name, make] of Object.entries({ example: exampleScore, sample: sampleScore, drumtab: drumTabScore })) {
  test(`mscz: export → import round trip: ${name}`, () => {
    const src = make();
    validateScore(src, { repair: true });
    const warnings = [];
    const xml = exportMscx(src, { warnings });
    assert.equal(looksLikeMscx(xml), true);
    assert.match(xml, /<museScore version="3\.02">/);
    assert.deepEqual(warnings, []);
    const back = importMscx(xml);
    assert.equal(validateScore(back).ok, true);
    sameMusic(src, back, name);
    for (const k of ['title', 'subtitle', 'composer', 'lyricist', 'arranger', 'copyright']) assert.equal(back.meta[k] || '', src.meta[k] || '', `meta.${k}`);
    assert.deepEqual(back.parts.map(p => [p.name, p.abbreviation, p.transposeChromatic || 0, p.staves.map(s => [s.type, s.clef, s.lines])]),
      src.parts.map(p => [p.name, p.abbreviation, p.transposeChromatic || 0, p.staves.map(s => [s.type, s.clef, s.lines])]));
    const pick = s => s.measures.map(m => [m.tempo ? [m.tempo.bpm, m.tempo.beatUnit, m.tempo.text || ''] : null, m.rehearsalMark || '', (m.markers || []).join(), m.barlineRight || '', m.barlineLeft || '', m.repeatCount || 0, m.breaks || null]);
    const a = pick(src), b = pick(back);
    a[a.length - 1][3] = a[a.length - 1][3] || 'final';          // the last barline is written out
    assert.deepEqual(b, a, 'measure attributes');
    const per = s => eventsOf(s).filter(x => !(x.ev.kind === 'rest' && x.ev.hidden)).map(x => [x.mi, x.si, x.ev.kind, x.ev.dur.base, x.ev.dur.dots || 0, x.ev.tuplet ? `${x.ev.tuplet.num}:${x.ev.tuplet.den}` : '', !!x.ev.grace,
      (x.ev.articulations || []).join(), (x.ev.ornaments || []).join(), x.ev.fermata || '', x.ev.dynamic || '', (x.ev.texts || []).map(t => t.text).join('|'), !!x.ev.arpeggio, x.ev.tremolo || 0,
      (x.ev.notes || []).map(n => [n.drum || '', n.string || 0, n.fret ?? '', n.head || '', n.fingering || '', n.accidental || ''].join('/')).join(' ')]);
    assert.deepEqual(per(back), per(textsOnEvents(src)), 'events');
    if (name === 'drumtab') {
      assert.deepEqual(back.parts.map(p => p.staves[0].tuning || null), src.parts.map(p => p.staves[0].tuning || null));
      const drums = s => Object.values(s.parts.find(p => p.staves[0].type === 'percussion').staves[0].drumMap).map(d => [d.midi, d.line, d.head]).sort((x, y) => x[0] - y[0]);
      assert.deepEqual(drums(back), drums(src));
    }
  });
}

/** A small score that uses most of what the format carries. */
function richScore() {
  const score = createScore({ title: '왕복 시험', composer: '작곡가', instruments: [], measures: 0, tempo: 0 });
  score.meta.subtitle = '부제'; score.meta.lyricist = '작사가'; score.meta.arranger = '편곡자'; score.meta.copyright = '© JSE';
  const cl = createPart('clarinet', { name: 'B♭ 클라리넷', abbreviation: 'Cl.', transposeChromatic: -2 });
  const pf = createPart('piano', { name: '피아노', abbreviation: 'Pno.' });
  score.parts = [cl, pf];
  const N = (p, base = 'quarter', dots = 0, extra = {}) => Object.assign(makeNote(p, base, dots), extra);
  const R = (base = 'quarter', dots = 0, extra = {}) => Object.assign(makeRest(base, dots), extra);
  const add = (opts, staves) => { const m = createMeasure(score, opts); staves.forEach((voices, i) => { m.staves[i].voices = voices; }); score.measures.push(m); return m; };
  const tid = newId();
  // 1: pickup
  const pick = N('D5', 'quarter', 0, { lyrics: [{ verse: 1, text: '나', syllabic: 'single' }, { verse: 2, text: 'la', syllabic: 'single' }], dynamic: 'mp' });
  add({ timeSig: { num: 3, den: 4, display: 'normal' }, keySig: { fifths: 2, mode: 'major' }, pickup: true, tempo: { bpm: 96, beatUnit: 'quarter', dots: 0, text: 'Andante', showBpm: true } },
    [[[pick]], [[R('quarter')]], [[N('D3', 'quarter')]]]);
  // 2: repeat start, triplet, grace, chord with tie, second voice with a gap, chord symbols
  const g = N('F#5', 'eighth', 0, { grace: { slash: true } });
  const t1 = N('E5', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2, show: 'number' }, lyrics: [{ verse: 1, text: '비', syllabic: 'begin' }] });
  const t2 = N('F#5', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2, show: 'number' } });
  const t3 = N('G5', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2, show: 'number' }, articulations: ['staccato', 'accent'] });
  const a5 = N('A5', 'half', 0, { lyrics: [{ verse: 1, text: '야', syllabic: 'end', extend: true }], fermata: 'above', ornaments: ['trill'] });
  const ch1 = { id: newId(), kind: 'note', dur: { base: 'half', dots: 1 }, notes: [{ step: 'D', octave: 4, alter: 0, tieStart: true }, { step: 'F', octave: 4, alter: 1, tieStart: true }, { step: 'A', octave: 4, alter: 0 }], arpeggio: true };
  const lh = N('D2', 'half', 1, { texts: [{ text: 'legato', placement: 'below', style: 'expression' }] });
  const v2 = [R('quarter', 0, { hidden: true }), N('B3', 'half', 0, { stem: 'down' })];
  const m2 = add({ barlineLeft: 'repeat-start', rehearsalMark: 'A', chords: [{ id: newId(), tick: 0, text: 'D', root: 'D' }, { id: newId(), tick: 1920, text: 'A7/C#', root: 'A', kind: '7', bass: 'C#' }] },
    [[[g, t1, t2, t3, a5]], [[ch1], v2], [[lh]]]);
  // 3: first ending
  const ch2 = { id: newId(), kind: 'note', dur: { base: 'half', dots: 0 }, notes: [{ step: 'D', octave: 4, alter: 0, tieEnd: true }, { step: 'F', octave: 4, alter: 1, tieEnd: true }] };
  const x1 = N('B4', 'quarter', 0, { notes: [{ step: 'B', octave: 4, alter: -1, accidental: 'flat', fingering: '2' }] });
  const m3 = add({ barlineRight: 'repeat-end', repeatCount: 3, markers: ['segno'] },
    [[[N('G5', 'half', 0, { tremolo: 2 }), x1]], [[ch2, R('quarter')]], [[N('G2', 'half'), N('A2', 'quarter')]]]);
  // 4: second ending, clef change in the left hand, lines
  const o1 = N('D6', 'quarter'), o2 = N('E6', 'quarter'), o3 = N('F#6', 'quarter');
  const p1 = N('D4', 'quarter'), p2 = N('E4', 'quarter'), p3 = N('F#4', 'quarter', 0, { hidden: true });
  const m4 = add({ breaks: { system: true }, texts: [{ text: 'dolce', placement: 'above', style: 'plain' }] }, [[[o1, o2, o3]], [[N('F#4', 'half'), R('quarter')]], [[p1, p2, p3]]]);
  m4.staves[2].clef = 'treble';
  // 5: back to bass clef, 16ths with manual beams, final
  const s = ['D5', 'E5', 'F#5', 'G5'].map((p, i) => N(p, '16th', 0, { beam: ['begin', 'continue', 'end', 'none'][i] }));
  const gl1 = N('A5', 'quarter'), gl2 = N('D5', 'quarter');
  const m5 = add({ barlineRight: 'final', markers: ['fine'] }, [[[...s, gl1, gl2]], [[R('half', 1)]], [[N('D3', 'half', 1)]]]);
  m5.staves[2].clef = 'bass';
  score.spanners = [
    { id: newId(), type: 'slur', from: { eventId: t1.id }, to: { eventId: t3.id }, placement: 'above' },
    { id: newId(), type: 'slur', from: { eventId: g.id }, to: { eventId: t1.id } },
    { id: newId(), type: 'crescendo', from: { eventId: t1.id }, to: { eventId: a5.id } },
    { id: newId(), type: 'diminuendo', from: { eventId: o1.id }, to: { eventId: o3.id }, placement: 'above' },
    { id: newId(), type: 'ottava', from: { eventId: o1.id }, to: { eventId: o3.id }, octaveShift: 8 },
    { id: newId(), type: 'pedal', from: { eventId: p1.id }, to: { eventId: p2.id } },
    { id: newId(), type: 'trill', from: { eventId: gl1.id }, to: { eventId: gl1.id } },
    { id: newId(), type: 'glissando', from: { eventId: gl1.id }, to: { eventId: gl2.id } },
    { id: newId(), type: 'textLine', from: { eventId: s[0].id }, to: { eventId: gl2.id }, text: 'rit.' },
    { id: newId(), type: 'textLine', from: { eventId: lh.id }, to: { eventId: lh.id }, text: 'cresc.', placement: 'below' },
    { id: newId(), type: 'volta', from: { measureId: m3.id }, to: { measureId: m3.id }, number: '1.', voltaType: 'closed' },
    { id: newId(), type: 'volta', from: { measureId: m4.id }, to: { measureId: m5.id }, number: '2.', voltaType: 'open' },
  ];
  void m2;
  validateScore(score, { repair: true });
  return score;
}

test('mscz: round trip of a feature-rich score', () => {
  const src = richScore();
  const warnings = [];
  const xml = exportMscx(src, { warnings });
  assert.deepEqual(warnings, []);
  const back = importMscx(xml);
  assert.equal(validateScore(back).ok, true);
  // the clarinet staff is written with its own key signature (E major for D major); the ScoreDoc has one key for all staves
  assert.equal(back.importInfo.warnings.length, 1);
  assert.match(back.importInfo.warnings[0], /조표/);
  assert.match(xml, /<KeySig>\s*<accidental>4<\/accidental>/);
  sameMusic(src, back, 'rich');
  noOverfull(back);
  // transposing part: written pitch and transposition survive; MuseScore stores the sounding pitch
  assert.equal(back.parts[0].transposeChromatic, -2);
  assert.match(xml, /<transposeChromatic>-2<\/transposeChromatic>/);
  assert.match(xml, /<pitch>72<\/pitch>\s*<tpc>14<\/tpc>\s*<tpc2>16<\/tpc2>/);            // written D5 on a B♭ instrument sounds C5
  assert.equal(midiOf(back.measures[0].staves[0].voices[0][0].notes[0]), 74);
  // measure attributes
  const pick = s => s.measures.map(m => [m.pickup || false, m.barlineLeft || '', m.barlineRight || '', m.repeatCount || 0, (m.markers || []).join(), m.rehearsalMark || '', m.breaks || null,
    m.tempo ? [m.tempo.bpm, m.tempo.beatUnit, m.tempo.text, m.tempo.showBpm] : null, (m.texts || []).map(t => [t.text, t.style])]);
  assert.deepEqual(pick(back), pick(textsOnEvents(src)));
  // event details
  const per = s => eventsOf(s).filter(x => !(x.ev.kind === 'rest' && x.ev.hidden)).map(x => [x.mi, x.si, x.vi, x.ev.kind, x.ev.dur.base, x.ev.dur.dots || 0, x.ev.tuplet ? `${x.ev.tuplet.num}:${x.ev.tuplet.den}` : '', x.ev.grace ? `g${x.ev.grace.slash}` : '',
    !!x.ev.hidden, x.ev.stem || '', x.ev.beam || '', (x.ev.articulations || []).join(), (x.ev.ornaments || []).join(), x.ev.fermata || '', x.ev.dynamic || '', !!x.ev.arpeggio, x.ev.tremolo || 0,
    (x.ev.texts || []).map(t => `${t.text}/${t.placement}/${t.style}`).join('|'), (x.ev.lyrics || []).map(l => `${l.verse}:${l.text}:${l.syllabic}:${!!l.extend}`).join('|'),
    (x.ev.notes || []).map(n => `${n.step}${n.alter || 0}${n.octave}${n.accidental || ''}${n.fingering || ''}`).join(' ')]);
  assert.deepEqual(per(back), per(textsOnEvents(src)));
  // the hidden rest of the second voice is a gap in MuseScore and comes back as one
  const v2 = back.measures[1].staves[1].voices[1];
  assert.deepEqual(v2.map(e => [e.kind, !!e.hidden, Math.round(durTicks(e))]), [['rest', true, 960], ['note', false, 1920]]);
  // lines: same ends
  const pos = s => { const p = new Map(); eventsOf(s).forEach((x, i) => p.set(x.ev.id, i)); s.measures.forEach((m, i) => p.set(m.id, 'm' + i)); return p; };
  const lines = s => { const p = pos(s); return s.spanners.map(sp => [sp.type, p.get(sp.from.eventId || sp.from.measureId), p.get(sp.to.eventId || sp.to.measureId), sp.placement || '', sp.text || '', sp.octaveShift || 0, sp.number || '', sp.voltaType || ''].join(',')).sort(); };
  // indexes shift where hidden rests are split differently, so compare per measure-relative keys instead
  const rel = s => { const p = new Map(); s.measures.forEach((m, mi) => { p.set(m.id, 'm' + mi); m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => { let t = 0; v.forEach(e => { p.set(e.id, `${mi}:${si}:${vi}:${Math.round(t)}${e.grace ? 'g' : ''}`); t += durTicks(e); }); })); });
    return s.spanners.map(sp => [sp.type, p.get(sp.from.eventId || sp.from.measureId), p.get(sp.to.eventId || sp.to.measureId), sp.placement || '', sp.text || '', sp.octaveShift || 0, sp.number || '', sp.voltaType || ''].join(',')).sort(); };
  void lines;
  assert.deepEqual(rel(back), rel(src));
  // settings
  for (const k of ['pageSize', 'orientation', 'pageWidthMm', 'pageHeightMm', 'staffSpaceMm', 'staffGapSp', 'systemGapSp']) assert.equal(back.settings[k], src.settings[k], `settings.${k}`);
  assert.deepEqual(back.settings.marginsMm, src.settings.marginsMm);
});

test('mscz: .mscz container', async () => {
  const src = exampleScore();
  const bytes = await exportMscz(src, { JSZip });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const zip = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files).sort(), ['META-INF/', 'META-INF/container.xml', 'score.mscx']);
  assert.match(await zip.file('META-INF/container.xml').async('string'), /<rootfile full-path="score\.mscx">/);
  const back = await importMscz(bytes, { JSZip, fileName: 'x.mscz' });
  sameMusic(src, back, 'container');
  // plain .mscx bytes through the same entry point
  const viaXml = await importMscz(new TextEncoder().encode(exportMscx(src)), { JSZip });
  sameMusic(src, viaXml, 'mscx bytes');
  // linked parts of MuseScore 4 live under Excerpts/ and must not be taken for the score
  const z2 = new JSZip();
  z2.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score_style.mss"/><rootfile full-path="Excerpts/Part/Part.mscx"/><rootfile full-path="main.mscx"/></rootfiles></container>');
  z2.file('Excerpts/Part/Part.mscx', '<museScore version="4.20"><Score/></museScore>');
  z2.file('main.mscx', exportMscx(src));
  const picked = await importMscz(await z2.generateAsync({ type: 'uint8array' }), { JSZip });
  assert.equal(picked.measures.length, src.measures.length);
});

test('mscz: export keeps irregular measures loadable and reports what it had to change', () => {
  const score = createScore({ title: 't', instruments: ['voice'], measures: 3, timeSig: { num: 4, den: 4 } });
  score.measures[0].staves[0].voices[0] = [makeNote('C4', 'quarter'), makeNote('D4', 'quarter')];                        // too short, not a pickup
  score.measures[1].staves[0].voices[0] = ['C4', 'D4', 'E4', 'F4', 'G4'].map(p => makeNote(p, 'quarter'));                // too long
  const tied = makeNote('C5', 'whole'); tied.notes[0].tieStart = true;
  score.measures[2].staves[0].voices[0] = [tied];                                                                        // tie into nothing
  const warnings = [];
  const xml = exportMscx(score, { warnings });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(w => typeof w === 'string' && /[가-힣]/.test(w)));
  assert.match(xml, /<Measure len="5\/4">/);
  const back = importMscx(xml);
  assert.deepEqual(back.measures.map(m => m.staves[0].voices[0].filter(e => e.kind === 'note').length), [2, 5, 1]);
  assert.deepEqual(back.measures.map((m, i) => measureCapacity(effectiveTimeSig(back, i))), [3840, 4800, 3840]);
  // MuseScore requires the first voice to fill the measure: the short one is completed with invisible rests
  assert.equal(back.measures[0].staves[0].voices[0].reduce((s, e) => s + durTicks(e), 0), 3840);
  assert.equal(exportMscx(score), xml.replace(/x^/, ''), 'export does not change the score');
  assert.throws(() => exportMscx({ parts: [], measures: [] }), /비어/);
});

test('mscz: text styles in both directions', () => {
  const src = exampleScore();
  src.settings.textStyles = { title: { family: 'Nanum Myeongjo', size: 6, bold: true }, lyrics: { family: 'Noto Sans KR', size: 2.4, italic: true }, chord: { size: 3 } };
  const xml = exportMscx(src);
  assert.match(xml, /<titleFontFace>Nanum Myeongjo<\/titleFontFace>/);
  assert.match(xml, /<lyricsOddFontFace>Noto Sans KR<\/lyricsOddFontFace>/);
  assert.match(xml, /<lyricsEvenFontFace>Noto Sans KR<\/lyricsEvenFontFace>/);
  const back = importMscx(xml);
  const ts = back.settings.textStyles;
  assert.deepEqual(Object.keys(ts).sort(), ['chord', 'lyrics', 'title']);
  assert.equal(ts.title.family, 'Nanum Myeongjo'); assert.equal(ts.title.bold, true);
  assert.ok(Math.abs(ts.title.size - 6) < 0.02, `title size ${ts.title.size}`);
  assert.equal(ts.lyrics.family, 'Noto Sans KR'); assert.equal(ts.lyrics.italic, true);
  assert.ok(Math.abs(ts.lyrics.size - 2.4) < 0.02);
  assert.ok(Math.abs(ts.chord.size - 3) < 0.02); assert.equal(ts.chord.family, undefined);
  // MuseScore's own faces and sizes are not a user choice
  const plain = importMscx(exportMscx(exampleScore()).replace('<Spatium>', '<titleFontFace>Edwin</titleFontFace><titleFontSize>22</titleFontSize><lyricsOddFontFace>FreeSerif</lyricsOddFontFace><Spatium>'));
  assert.equal(plain.settings.textStyles, undefined);
});

test('mscz: local time signature, measure repeat, nested tuplet, multi-measure rest', () => {
  const chord = (dur, pitch, extra = '') => `<Chord>${extra}<durationType>${dur}</durationType><Note><pitch>${pitch}</pitch><tpc>${[14, 21, 16, 11, 18, 13, 20, 15, 10, 17, 12, 19][pitch % 12]}</tpc></Note></Chord>`;
  const part = `<Part><Staff id="1"><StaffType group="pitched"><name>stdNormal</name></StaffType></Staff><Staff id="2"><StaffType group="pitched"><name>stdNormal</name></StaffType><defaultClef>F</defaultClef></Staff><trackName>Piano</trackName><Instrument><longName>Piano</longName><Channel><program value="0"/></Channel></Instrument></Part>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><museScore version="3.02"><programVersion>3.6.2</programVersion><Score><Division>480</Division>${part}
    <Staff id="1">
      <Measure><voice><TimeSig><sigN>2</sigN><sigD>4</sigD></TimeSig>${chord('quarter', 72)}${chord('quarter', 74)}</voice></Measure>
      <Measure><voice><RepeatMeasure><duration>2/4</duration></RepeatMeasure></voice></Measure>
      <Measure><voice><Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>quarter</baseNote></Tuplet>${chord('quarter', 72)}${chord('quarter', 74)}
        <Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>eighth</baseNote></Tuplet>${chord('eighth', 76)}${chord('eighth', 77)}${chord('eighth', 79)}<endTuplet/><endTuplet/></voice></Measure>
      <Measure><multiMeasureRest>2</multiMeasureRest><voice><Rest><durationType>measure</durationType><duration>4/4</duration></Rest></voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>2/4</duration></Rest></voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>2/4</duration></Rest><BarLine><subtype>end</subtype></BarLine></voice></Measure>
    </Staff>
    <Staff id="2">
      <Measure><voice><TimeSig><sigN>6</sigN><sigD>8</sigD><stretchN>3</stretchN><stretchD>2</stretchD></TimeSig>${[48, 55, 52, 48, 55, 52].map(p => chord('eighth', p)).join('')}</voice></Measure>
      <Measure><voice>${chord('quarter', 48, '<dots>1</dots>')}${chord('quarter', 43, '<dots>1</dots>')}</voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>6/8</duration></Rest></voice></Measure>
      <Measure><multiMeasureRest>2</multiMeasureRest><voice><Rest><durationType>measure</durationType><duration>12/8</duration></Rest></voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>6/8</duration></Rest></voice></Measure>
      <Measure><voice><Rest><durationType>measure</durationType><duration>6/8</duration></Rest></voice></Measure>
    </Staff></Score></museScore>`;
  const score = importMscx(xml);
  assert.equal(score.measures.length, 5, 'the generated multi-measure rest is not a measure of its own');
  assert.deepEqual(score.measures[0].timeSig, { num: 2, den: 4, display: 'normal' });
  noOverfull(score);
  // 6/8 against 2/4: eighths of the lower staff last a triplet eighth, without a visible tuplet
  const low = score.measures[0].staves[1].voices[0];
  assert.deepEqual(low.map(e => Math.round(durTicks(e))), [320, 320, 320, 320, 320, 320]);
  assert.ok(low.every(e => e.tuplet.show === 'none' && e.tuplet.bracket === false));
  assert.equal(new Set(low.map(e => e.tuplet.id)).size, 2, 'one hidden group per beat');
  assert.deepEqual(score.measures[1].staves[1].voices[0].map(e => Math.round(durTicks(e))), [960, 960]);
  // % repeats the previous measure
  assert.deepEqual(score.measures[1].staves[0].voices[0].map(e => midiOf(e.notes[0])), [72, 74]);
  // nested tuplet: 3:2 inside 3:2 → 9:4
  const nest = score.measures[2].staves[0].voices[0];
  assert.deepEqual(nest.map(e => `${e.tuplet.num}:${e.tuplet.den}`), ['3:2', '3:2', '9:4', '9:4', '9:4']);
  assert.equal(Math.round(nest.reduce((s, e) => s + durTicks(e), 0)), 1920);
  assert.equal(score.measures[4].barlineRight, 'final');
  for (const w of ['로컬 박자표', '마디 반복 기호', '중첩 잇단음표']) assert.ok(score.importInfo.warnings.some(x => x.includes(w)), `warning about ${w}`);
});

test('mscz: To Coda by its label, lyric elision, a tuplet with an invisible rest in the second voice', () => {
  const chord = (dur, pitch, extra = '') => `<Chord><durationType>${dur}</durationType>${extra}<Note><pitch>${pitch}</pitch><tpc>${[14, 21, 16, 11, 18, 13, 20, 15, 10, 17, 12, 19][pitch % 12]}</tpc></Note></Chord>`;
  const lyric = t => `<Lyrics><text>${t}</text></Lyrics>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><museScore version="3.02"><programVersion>3.6.2</programVersion><Score><Division>480</Division>
    <Part><Staff id="1"><StaffType group="pitched"><name>stdNormal</name></StaffType></Staff><trackName>Voice</trackName><Instrument><longName>Voice</longName><Channel><program value="52"/></Channel></Instrument></Part>
    <Staff id="1">
      <Measure><Marker><style>Repeat Text Right</style><text><sym>coda</sym></text><label>coda</label></Marker>
        <voice><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>${chord('quarter', 72, lyric('le<sym>lyricsElision</sym>aux'))}${chord('quarter', 74, lyric('tua'))}${chord('half', 76)}</voice>
        <voice><location><fractions>1/4</fractions></location>
          <Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>eighth</baseNote></Tuplet><Rest><visible>0</visible><durationType>eighth</durationType></Rest>${chord('quarter', 60)}<endTuplet/></voice></Measure>
      <Measure><Marker><style>Repeat Text Left</style><text><sym>coda</sym></text><label>codab</label></Marker>
        <voice><Rest><durationType>measure</durationType><duration>4/4</duration></Rest><BarLine><subtype>end</subtype></BarLine></voice>
        <voice><location><fractions>1/2</fractions></location>
          <Tuplet><normalNotes>2</normalNotes><actualNotes>3</actualNotes><baseNote>eighth</baseNote></Tuplet>${chord('eighth', 62)}<endTuplet/></voice></Measure>
    </Staff></Score></museScore>`;
  const score = importMscx(xml);
  noOverfull(score);
  // the label decides (MuseScore: "coda" = the To Coda sign, "codab" = the coda), not what the sign shows
  assert.deepEqual(score.measures.map(m => m.markers || []), [['toCoda'], ['coda']]);
  const v1 = score.measures[0].staves[0].voices[0], v2 = score.measures[0].staves[0].voices[1];
  assert.deepEqual(v1.filter(e => e.lyrics).map(e => e.lyrics[0].text), ['le‿aux', 'tu‿a']);
  const group = v2.filter(e => e.tuplet);
  assert.deepEqual(group.map(e => `${e.kind}${e.hidden ? '-hidden' : ''}:${Math.round(durTicks(e))}`), ['rest-hidden:320', 'note:640']);
  // export: the tuplet stays complete (an incomplete one loses notes in MuseScore), other gaps of voice 2 are skipped
  const out = exportMscx(score);
  const voice2 = out.split('<voice>')[2].split('</voice>')[0];
  assert.match(voice2, /<location>\s*<fractions>1\/4<\/fractions>\s*<\/location>\s*<Tuplet>/);
  assert.match(voice2, /<Rest>\s*<visible>0<\/visible>\s*<durationType>eighth<\/durationType>\s*<\/Rest>\s*<Chord>[\s\S]*<endTuplet\/>/);
  assert.equal(voice2.match(/<Rest>/g).length, 1);
  // a triplet note whose neighbours were deleted in MuseScore (the file has a tuplet with one note and a jump):
  // the triplet is made whole with a hidden rest of the same tuplet, the remainder of the gap is a plain hidden rest
  const gap = score.measures[1].staves[0].voices[1];
  assert.deepEqual(gap.map(e => `${e.kind}${e.hidden ? '-hidden' : ''}:${Math.round(durTicks(e))}`), ['rest-hidden:1920', 'note:320', 'rest-hidden:640', 'rest-hidden:960']);
  assert.equal(gap[2].tuplet.id, gap[1].tuplet.id);
  assert.equal(gap[3].tuplet, undefined);
  const voice4 = out.split('<voice>')[4].split('</voice>')[0];
  assert.match(voice4, /<location>\s*<fractions>1\/2<\/fractions>\s*<\/location>\s*<Tuplet>\s*<normalNotes>2<\/normalNotes>\s*<actualNotes>3<\/actualNotes>\s*<baseNote>eighth<\/baseNote>/);
  assert.match(voice4, /<\/Chord>\s*<Rest>\s*<visible>0<\/visible>\s*<durationType>quarter<\/durationType>\s*<\/Rest>\s*<endTuplet\/>\s*$/);
  assert.equal(out.match(/<sym>lyricsElision<\/sym>/g).length, 2);
  assert.match(out, /<text>To Coda<\/text>\s*<label>coda<\/label>/);
  sameMusic(score, importMscx(out), 'elision / tuplet / coda');
  // a ScoreDoc in which the rests that complete a tuplet are a tuplet group of their own: written as one whole tuplet
  const doc = createScore({ title: 't', instruments: ['voice'], measures: 1, timeSig: { num: 4, den: 4 } });
  const hidden = (base, tuplet) => { const r = makeRest(base); r.hidden = true; if (tuplet) r.tuplet = tuplet; return r; };
  const note = makeNote('D4', 'eighth'); note.tuplet = { id: 'A', num: 3, den: 2, show: 'number' };
  doc.measures[0].staves[0].voices[0] = [makeNote('C5', 'whole')];
  doc.measures[0].staves[0].voices[1] = [hidden('half'), note, hidden('quarter', { id: 'B', num: 3, den: 2, show: 'none' }), hidden('quarter')];
  const joined = exportMscx(doc).split('<voice>')[2].split('</voice>')[0];
  assert.equal(joined.match(/<Tuplet>/g).length, 1);
  assert.match(joined, /<baseNote>eighth<\/baseNote>[\s\S]*<\/Chord>\s*<Rest>\s*<visible>0<\/visible>\s*<durationType>quarter<\/durationType>\s*<\/Rest>\s*<endTuplet\/>\s*$/);
});

test('mscz: grace notes that have no chord to belong to do not reach MuseScore', () => {
  // MuseScore 3 crashes on a grace chord without its chord when a slur hangs on it (seen with scores from MusicXML)
  const doc = createScore({ title: 't', instruments: ['voice'], measures: 1, timeSig: { num: 4, den: 4 } });
  const grace = p => { const g = makeNote(p, 'eighth'); g.grace = { slash: true }; return g; };
  const hidden = base => { const r = makeRest(base); r.hidden = true; return r; };
  const a = makeNote('C5', 'half'), g1 = grace('E5'), g2 = grace('F5'), g3 = grace('G5');
  doc.measures[0].staves[0].voices[0] = [a, g3, makeRest('half')];                       // in front of a rest: follows the note before it
  doc.measures[0].staves[0].voices[1] = [g1, hidden('half'), g2, hidden('half')];        // no note on either side
  doc.spanners.push({ id: newId(), type: 'slur', from: { eventId: g1.id }, to: { eventId: a.id } });
  g2.notes[0].tieStart = true;
  const warnings = [];
  const out = exportMscx(doc, { warnings });
  assert.ok(warnings.some(w => w.includes('꾸밈음')), warnings.join(' | '));
  assert.equal((out.match(/<Spanner type="(Slur|Tie)">/g) || []).length, 0);
  assert.equal((out.match(/<grace8after\/>/g) || []).length, 1);
  assert.equal((out.match(/<(acciaccatura|appoggiatura|grace4|grace16|grace32)\/>/g) || []).length, 0);
  const back = importMscx(out);
  noOverfull(back);
  assert.deepEqual(back.measures[0].staves[0].voices[0].map(e => `${e.kind}${e.grace ? '-grace' : ''}`), ['note', 'note-grace', 'rest']);
  assert.equal(back.measures[0].staves[0].voices.length, 1);
});
