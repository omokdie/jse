// Test scores for the Finale writer (tools/tests/musx.test.js, tools/musx/denigma.mjs).
import { createScore, createMeasure, createPart, makeNote, makeRest, newId } from '../../app/js/model/score.js';

const note = (p, base = 'quarter', dots = 0, extra = {}) => Object.assign(makeNote(p, base, dots), extra);
const chord = (ps, base = 'quarter', dots = 0, extra = {}) => Object.assign({ id: newId(), kind: 'note', dur: { base, dots }, notes: ps.map(p => makeNote(p).notes[0]) }, extra);
const rest = (base = 'quarter', dots = 0, extra = {}) => Object.assign(makeRest(base, dots), extra);
const tup = (num, den) => { const id = newId(); return (ev) => Object.assign(ev, { tuplet: { id, num, den, bracket: true, show: 'number' } }); };

/**
 * Every feature the .musx writer handles, in 14 measures: voice + B♭ clarinet + piano (grand staff).
 * Notes, chords, rests, dots, ties, accidentals, tuplets (3:2, 5:4, 6:4), grace notes, explicit beams and stems,
 * two voices, clef/key/time changes, pickup, repeats + endings, D.S./Coda/Fine, lyrics (2 verses, hyphens, extender),
 * chord symbols (with bass), dynamics, tempo, rehearsal marks, texts, articulations, ornaments, fermata, tremolo,
 * arpeggio, slurs, hairpins, 8va, trill line, glissando, pedal, text line, hidden notes, titles and text styles.
 */
export function featureScore() {
  const s = createScore({ title: '기능 시험 (Feature test)', composer: 'JSE', instruments: ['voice', 'clarinet', 'piano'], measures: 0, timeSig: { num: 3, den: 4 }, keyFifths: -1, tempo: 0 });
  s.meta.subtitle = 'musx writer'; s.meta.lyricist = '작사: 테스트'; s.meta.arranger = 'arr. JSE'; s.meta.copyright = '© 2026 JSE';
  s.parts[1].transposeChromatic = -2; s.parts[1].name = 'Clarinet in B♭'; s.parts[1].abbreviation = 'Cl.';
  s.settings.textStyles = { lyrics: { family: 'Nanum Myeongjo', size: 2 }, title: { size: 4.5, bold: true } };
  const M = (fill) => { const m = createMeasure(s); fill(m); s.measures.push(m); return m; };
  const V = 0, CL = 1, RH = 2, LH = 3;
  const ly = (ev, text, syllabic = 'single', verse = 1, extend) => { (ev.lyrics || (ev.lyrics = [])).push({ verse, text, syllabic, ...(extend ? { extend: true } : {}) }); return ev; };
  // m1: pickup (one beat) with tempo and dynamics
  const m1 = M(m => {
    m.timeSig = { num: 3, den: 4, display: 'normal' }; m.keySig = { fifths: -1, mode: 'major' }; m.pickup = true;
    m.tempo = { bpm: 92, beatUnit: 'quarter', dots: 0, text: 'Andante', showBpm: true };
    m.staves[V].voices[0] = [ly(note('C5', 'quarter', 0, { dynamic: 'mp' }), '봄', 'single')];
    m.staves[CL].voices[0] = [note('D5', 'quarter')];
    m.staves[RH].voices[0] = [rest('quarter')];
    m.staves[LH].voices[0] = [rest('quarter')];
  });
  // m2: triplet, lyrics with hyphens, chord symbols, slur, hairpin, articulations
  const t3 = tup(3, 2);
  let slurA, slurB, cresA, cresB;
  M(m => {
    m.rehearsalMark = 'A';
    m.chords = [{ id: newId(), tick: 0, text: 'F' }, { id: newId(), tick: 1920, text: 'C7/E' }];
    m.staves[V].voices[0] = [ly(slurA = note('A4', 'eighth'), 'na', 'begin'), ly(note('B4', 'eighth', 0, { notes: [{ step: 'B', octave: 4, alter: -1 }] }), 'bi', 'middle'), ly(note('C5', 'quarter', 0, { articulations: ['accent'] }), 'ya', 'end'),
      ...[note('D5', 'eighth'), note('C5', 'eighth'), slurB = note('A4', 'eighth')].map(t3)];
    ly(m.staves[V].voices[0][0], 'one', 'begin', 2); ly(m.staves[V].voices[0][1], 'two', 'end', 2);
    m.staves[CL].voices[0] = [cresA = note('G4', 'half'), cresB = note('A4', 'quarter', 0, { articulations: ['staccato', 'tenuto'] })];
    m.staves[RH].voices[0] = [chord(['F4', 'A4', 'C5'], 'half', 0, { arpeggio: true }), chord(['E4', 'G4', 'B4'], 'quarter')];
    m.staves[RH].voices[0][1].notes[2].alter = -1;
    m.staves[LH].voices[0] = [note('F2', 'half', 0, { stem: 'up' }), note('E2', 'quarter')];
  });
  s.spanners.push({ id: newId(), type: 'slur', from: { eventId: slurA.id }, to: { eventId: slurB.id } });
  s.spanners.push({ id: newId(), type: 'crescendo', from: { eventId: cresA.id }, to: { eventId: cresB.id } });
  // m3: two voices, tie across the barline, grace note, 16ths with explicit beams, forward repeat
  let tieStart;
  M(m => {
    m.barlineLeft = 'repeat-start';
    m.staves[V].voices[0] = [ly(note('F5', 'eighth', 0, { grace: { slash: true } }), ''), ly(note('E5', 'quarter', 1), '꽃', 'single', 1, true), note('D5', 'eighth'), tieStart = note('C5', 'quarter', 0, { notes: [{ step: 'C', octave: 5, alter: 0, tieStart: true }] })];
    m.staves[V].voices[0][0].lyrics = undefined;
    m.staves[CL].voices[0] = [note('A4', '16th', 0, { beam: 'begin' }), note('B4', '16th', 0, { beam: 'continue' }), note('C5', '16th', 0, { beam: 'continue' }), note('D5', '16th', 0, { beam: 'end' }), note('E5', 'half', 0, { fermata: 'above' })];
    m.staves[RH].voices[0] = [note('C5', 'half'), note('D5', 'quarter', 0, { stem: 'up' })];
    m.staves[RH].voices[1] = [note('F4', 'quarter'), note('G4', 'quarter'), note('A4', 'quarter', 0, { stem: 'down' })];
    m.staves[LH].voices[0] = [note('F2', 'half', 1, { tremolo: 2 })];
  });
  // m4: first ending, back repeat ×2; quintuplet
  const t5 = tup(5, 4);
  M(m => {
    m.barlineRight = 'repeat-end'; m.repeatCount = 2;
    m.staves[V].voices[0] = [note('C5', 'quarter', 0, { notes: [{ step: 'C', octave: 5, alter: 0, tieEnd: true }] }), note('A4', 'half', 0, { ornaments: ['trill'] })];
    m.staves[CL].voices[0] = [...['C5', 'D5', 'E5', 'F5', 'G5'].map(p => t5(note(p, '16th'))), note('A5', 'quarter'), rest('quarter')];
    m.staves[RH].voices[0] = [chord(['A4', 'C5'], 'half', 1)];
    m.staves[LH].voices[0] = [note('F2', 'half', 1)];
  });
  // m5: second ending, key change to G major (from here), text, clef change in the left hand
  M(m => {
    m.keySig = { fifths: 1, mode: 'major' };
    m.texts = [{ text: 'dolce', placement: 'below', style: 'expression' }];
    m.staves[V].voices[0] = [note('B4', 'half'), note('G4', 'quarter', 0, { ornaments: ['mordent'] })];
    m.staves[CL].voices[0] = [note('A4', 'half', 1, { dynamic: 'f' })];
    m.staves[RH].voices[0] = [chord(['G4', 'B4', 'D5'], 'half', 1)];
    m.staves[LH].clef = 'treble';
    m.staves[LH].voices[0] = [note('G3', 'half', 1)];
    m.barlineRight = 'double';
  });
  s.spanners.push({ id: newId(), type: 'volta', from: { measureId: s.measures[3].id }, to: { measureId: s.measures[3].id }, number: '1.', voltaType: 'closed' });
  s.spanners.push({ id: newId(), type: 'volta', from: { measureId: s.measures[4].id }, to: { measureId: s.measures[4].id }, number: '2.', voltaType: 'open' });
  // m6: time change 6/8, segno, 8va over two measures, hidden note, sextuplet in 6/8
  let ottA, ottB, trA, trB;
  M(m => {
    m.timeSig = { num: 6, den: 8, display: 'normal' }; m.markers = ['segno'];
    m.staves[V].voices[0] = [ottA = note('D5', 'quarter', 1), note('E5', 'eighth'), note('F#5', 'eighth'), note('G5', 'eighth', 0, { hidden: true })];
    m.staves[V].voices[0][2].notes[0].accidental = 'sharp';
    m.staves[CL].voices[0] = [trA = note('E5', 'quarter', 1, { dynamic: 'sfz' }), trB = note('D5', 'quarter', 1)];
    const t6 = tup(6, 4);
    m.staves[RH].voices[0] = ['G4', 'A4', 'B4', 'C5', 'D5', 'E5'].map(p => t6(note(p, '16th'))).concat([note('F#5', 'eighth'), note('D5', 'quarter', 1)]);
    m.staves[LH].voices[0] = [note('G3', 'quarter', 1), note('D4', 'quarter', 1)];
  });
  M(m => {
    m.rehearsalMark = 'B';
    m.staves[V].voices[0] = [ottB = note('G5', 'quarter', 1), note('F#5', 'quarter', 1)];
    m.staves[CL].voices[0] = [note('A5', 'quarter', 1, { articulations: ['marcato'] }), note('G5', 'quarter', 1, { articulations: ['staccatissimo'] })];
    m.staves[RH].voices[0] = [chord(['B4', 'D5'], 'quarter', 1), chord(['A4', 'C5'], 'quarter', 1)];
    m.staves[LH].voices[0] = [note('G3', 'half', 1)];
    m.markers = ['toCoda'];
  });
  s.spanners.push({ id: newId(), type: 'ottava', octaveShift: 8, from: { eventId: ottA.id }, to: { eventId: ottB.id } });
  s.spanners.push({ id: newId(), type: 'trill', from: { eventId: trA.id }, to: { eventId: trB.id } });
  // m8: back to 4/4 (common), glissando, pedal, text line, fine
  let glA, glB, pedA, pedB, lnA, lnB;
  M(m => {
    m.timeSig = { num: 4, den: 4, display: 'common' };
    m.staves[V].voices[0] = [lnA = note('G4', 'half'), lnB = note('A4', 'half')];
    m.staves[CL].voices[0] = [glA = note('C5', 'half'), glB = note('G5', 'half')];
    m.staves[RH].voices[0] = [pedA = chord(['G4', 'B4', 'D5'], 'whole')];
    m.staves[LH].voices[0] = [pedB = note('G3', 'whole')];
    m.markers = ['fine'];
  });
  s.spanners.push({ id: newId(), type: 'glissando', from: { eventId: glA.id }, to: { eventId: glB.id } });
  s.spanners.push({ id: newId(), type: 'pedal', from: { eventId: pedA.id }, to: { eventId: pedA.id } });
  s.spanners.push({ id: newId(), type: 'textLine', text: 'rit.', from: { eventId: lnA.id }, to: { eventId: lnB.id } });
  void pedB;
  // m9: coda, minor key, diminuendo, 32nds and double-dotted notes
  let dimA, dimB;
  M(m => {
    m.keySig = { fifths: 1, mode: 'minor' }; m.markers = ['coda'];
    m.staves[V].voices[0] = [dimA = note('E5', 'half', 2), note('D5', '32nd'), note('C5', '32nd'), dimB = note('B4', '16th')];
    m.staves[CL].voices[0] = [rest('whole', 0, { fullMeasureRest: true })];
    m.staves[RH].voices[0] = [chord(['E4', 'G4', 'B4'], 'whole')];
    m.staves[LH].voices[0] = [note('E3', 'whole')];
    m.barlineRight = 'final';
    m.texts = [{ text: 'D.S. al Coda', placement: 'above', style: 'plain' }];
  });
  s.spanners.push({ id: newId(), type: 'diminuendo', from: { eventId: dimA.id }, to: { eventId: dimB.id } });
  s.measures[3].breaks = { system: true };
  void m1;
  return s;
}

/** A score with a part of each kind of staff: TAB, drums, rhythm staff. */
export function staffKindsScore() {
  const s = createScore({ title: 'Staff kinds', instruments: ['guitar-tab', 'drumset', 'rhythm'], measures: 0, timeSig: { num: 4, den: 4 }, keyFifths: 0, tempo: 120 });
  const t = (string, fret, b = 'quarter') => ({ id: newId(), kind: 'note', dur: { base: b, dots: 0 }, notes: [{ step: 'E', octave: 4, alter: 0, string, fret }] });
  const d = (keys, b = 'eighth') => ({ id: newId(), kind: 'note', dur: { base: b, dots: 0 }, notes: keys.map(k => ({ step: k === 'kick' ? 'F' : 'C', octave: k === 'kick' ? 4 : 5, alter: 0, drum: k })) });
  for (let i = 0; i < 2; i++) {
    const m = createMeasure(s);
    if (i === 0) { m.timeSig = { num: 4, den: 4, display: 'normal' }; m.keySig = { fifths: 0, mode: 'major' }; }
    m.staves[0].voices[0] = [t(6, 3), t(5, 2), t(1, 0), t(2, 1)];
    m.staves[1].voices[0] = [d(['kick']), d(['snare']), d(['kick']), d(['snare']), d(['kick']), d(['snare']), d(['kick']), d(['snare'])];
    m.staves[2].voices[0] = [{ id: newId(), kind: 'note', dur: { base: 'half', dots: 0 }, notes: [{ step: 'C', octave: 5, alter: 0, drum: 'hit' }] }, rest('half')];
    s.measures.push(m);
  }
  return s;
}
void createPart;
