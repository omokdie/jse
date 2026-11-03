import test from 'node:test';
import assert from 'node:assert/strict';
import { createScore, voiceTicks, durTicks, validateScore, measureCapacity } from '../../app/js/model/score.js';
import * as C from '../../app/js/model/commands.js';

const v0 = (s, mi = 0, si = 0, vi = 0) => s.measures[mi].staves[si].voices[vi];
const desc = v => v.map(e => (e.kind === 'rest' ? 'r' : e.notes.map(n => n.step + n.octave + (n.tieStart ? '~' : '')).join('+')) + ':' + e.dur.base + (e.dur.dots ? '.' : '')).join(' ');

test('input note overwrites rests and keeps measure full', () => {
  const s = createScore({ instruments: ['voice'], measures: 2 });
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 0, dur: { base: 'quarter' }, pitch: { step: 'C', octave: 5, alter: 0 } });
  assert.equal(voiceTicks(v0(s)), 3840);
  assert.equal(desc(v0(s)), 'C5:quarter r:half.');
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 960, dur: { base: 'eighth' }, pitch: { step: 'D', octave: 5, alter: 0 } });
  assert.equal(desc(v0(s)), 'C5:quarter D5:eighth r:eighth r:half');
  // overwrite with a longer note consuming following events
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 960, dur: { base: 'half' }, pitch: { step: 'E', octave: 5, alter: 0 } });
  assert.equal(desc(v0(s)), 'C5:quarter E5:half r:quarter');
  assert.ok(validateScore(s).ok);
});

test('note longer than remaining measure ties into the next measure', () => {
  const s = createScore({ instruments: ['voice'], measures: 2 });
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 2880, dur: { base: 'half' }, pitch: { step: 'G', octave: 4, alter: 0 } });
  assert.equal(desc(v0(s, 0)), 'r:half. G4~:quarter');
  assert.equal(desc(v0(s, 1)), 'G4:quarter r:half.');
  assert.ok(v0(s, 1)[0].notes[0].tieEnd);
});

test('delete turns notes into rests and merges', () => {
  const s = createScore({ instruments: ['voice'], measures: 1 });
  const id = C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 0, dur: { base: 'quarter' }, pitch: { step: 'C', octave: 5, alter: 0 } });
  C.deleteEvents(s, [id]);
  assert.equal(voiceTicks(v0(s)), 3840);
  assert.ok(v0(s).every(e => e.kind === 'rest'));
});

test('tuplet creation and removal keep duration', () => {
  const s = createScore({ instruments: ['voice'], measures: 1 });
  const id = C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 0, dur: { base: 'quarter' }, pitch: { step: 'C', octave: 5, alter: 0 } });
  C.makeTuplet(s, id, 3, 2);
  assert.equal(v0(s).filter(e => e.tuplet).length, 3);
  assert.equal(Math.round(voiceTicks(v0(s))), 3840);
  C.removeTuplet(s, v0(s)[0].id);
  assert.equal(v0(s).filter(e => e.tuplet).length, 0);
  assert.equal(Math.round(voiceTicks(v0(s))), 3840);
});

test('copy / paste range across measures', () => {
  const s = createScore({ instruments: ['voice'], measures: 3 });
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 0, dur: { base: 'half' }, pitch: { step: 'A', octave: 4, alter: 0 } });
  C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 1920, dur: { base: 'half' }, pitch: { step: 'B', octave: 4, alter: 0 } });
  const clip = C.copyRange(s, { fromMi: 0, toMi: 0, s0: 0, s1: 0 });
  C.paste(s, clip, { mi: 2, si: 0, vi: 0, tick: 0 });
  assert.equal(desc(v0(s, 2)), 'A4:half B4:half');
  const clip2 = C.copyEvents(s, [v0(s, 0)[1].id]);
  C.paste(s, clip2, { mi: 1, si: 0, vi: 0, tick: 2880 });   // half note at last beat → spills into measure 2? (no: paste clips to measure)
  assert.equal(voiceTicks(v0(s, 1)), 3840);
  assert.ok(validateScore(s).ok);
});

test('transpose and accidentals', () => {
  const s = createScore({ instruments: ['voice'], measures: 1, keyFifths: 0 });
  const id = C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: 0, dur: { base: 'quarter' }, pitch: { step: 'E', octave: 4, alter: 0 } });
  C.transposeEvents(s, [id], { semitones: 1 });
  assert.equal(v0(s)[0].notes[0].step, 'F');
  C.transposeEvents(s, [id], { diatonic: 1 });
  assert.equal(v0(s)[0].notes[0].step, 'G');
  C.setAccidental(s, [id], 'sharp');
  assert.equal(v0(s)[0].notes[0].alter, 1);
  C.setAccidental(s, [id], 'sharp');
  assert.equal(v0(s)[0].notes[0].alter, 0);
});

test('time signature change renormalizes', () => {
  const s = createScore({ instruments: ['voice'], measures: 2 });
  C.inputEvent(s, { mi: 1, si: 0, vi: 0, tick: 0, dur: { base: 'whole' }, pitch: { step: 'C', octave: 5, alter: 0 } });
  C.setTimeSig(s, 0, { num: 3, den: 4 });
  assert.equal(voiceTicks(v0(s, 1)), measureCapacity({ num: 3, den: 4 }));
});

test('lyrics distribution handles Hangul and hyphens', () => {
  const s = createScore({ instruments: ['voice'], measures: 1 });
  const ids = [0, 960, 1920, 2880].map(t => C.inputEvent(s, { mi: 0, si: 0, vi: 0, tick: t, dur: { base: 'quarter' }, pitch: { step: 'C', octave: 5, alter: 0 } }));
  const n = C.distributeLyrics(s, ids[0], '나비 hap-py');
  assert.equal(n, 4);
  assert.equal(v0(s)[2].lyrics[0].text, 'hap');
  assert.equal(v0(s)[2].lyrics[0].syllabic, 'begin');
});

test('parts add/remove keep staves aligned', () => {
  const s = createScore({ instruments: ['voice'], measures: 2 });
  const pid = C.addPart(s, 'piano');
  assert.equal(s.measures[0].staves.length, 3);
  C.removePart(s, pid);
  assert.equal(s.measures[0].staves.length, 1);
  assert.ok(validateScore(s).ok);
});
