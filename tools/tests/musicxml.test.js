import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { importMusicXML, exportMusicXML, exportMXL, importMXL, detectFormat } from '../../app/js/io/musicxml.js';
import { exampleScore } from '../../app/js/model/examples.js';
import { sampleScore, drumTabScore } from '../fixtures.mjs';
import { validateScore, midiOf } from '../../app/js/model/score.js';
const require = createRequire(import.meta.url);
const JSZip = require('../../app/vendor/jszip.min.js');

/** Canonical form: ids replaced by positions, volatile fields removed, render annotations dropped. */
function canon(score) {
  const s = JSON.parse(JSON.stringify(score, (k, v) => (k.startsWith('_') ? undefined : v)));
  const pos = new Map();
  s.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => v.forEach((ev, ei) => pos.set(ev.id, `${mi}:${si}:${vi}:${ei}`)))));
  const mpos = new Map(s.measures.map((m, i) => [m.id, i]));
  const tmap = new Map();
  s.measures.forEach(m => {
    delete m.id;
    (m.chords || []).forEach(c => { delete c.id; delete c.root; delete c.kind; delete c.bass; });
    m.staves.forEach(sm => sm.voices.forEach(v => v.forEach(ev => {
      delete ev.id;
      if (ev.tuplet) { if (!tmap.has(ev.tuplet.id)) tmap.set(ev.tuplet.id, tmap.size); ev.tuplet = { ...ev.tuplet, id: tmap.get(ev.tuplet.id) }; if (!ev.tuplet.bracket) delete ev.tuplet.bracket; if (!ev.tuplet.show) ev.tuplet.show = 'number'; }
      (ev.notes || []).forEach(n => { if (n.alter === 0) delete n.alter; if (n.fret != null) { delete n.step; delete n.octave; delete n.alter; } });
      (ev.lyrics || []).forEach(l => { if (!l.syllabic) l.syllabic = 'single'; });
      if (ev.notes && ev.notes[0]?.step) ev.notes.sort((x, y) => midiOf(x) - midiOf(y));
    })));
    while (m.staves.some(sm => sm.voices.length > 1 && !sm.voices[sm.voices.length - 1].length)) m.staves.forEach(sm => { if (sm.voices.length > 1 && !sm.voices[sm.voices.length - 1].length) sm.voices.pop(); });
  });
  s.parts.forEach(p => { delete p.id; p.staves.forEach(st => { delete st.id; }); });
  s.spanners = (s.spanners || []).map(sp => ({ ...sp, ...(sp.type === 'volta' ? { voltaType: sp.voltaType || 'closed' } : {}), id: undefined, from: sp.from.eventId ? pos.get(sp.from.eventId) : 'm' + mpos.get(sp.from.measureId), to: sp.to.eventId ? pos.get(sp.to.eventId) : 'm' + mpos.get(sp.to.measureId) })).map(sp => JSON.parse(JSON.stringify(sp))).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  delete s.meta.created; delete s.meta.modified; delete s.meta.appVersion;
  s.sources = [];
  return s;
}
function roundTrip(score) {
  validateScore(score, { repair: true });
  const xml = exportMusicXML(score);
  const back = importMusicXML(xml);
  return { xml, back };
}
const cases = { example: exampleScore, sample: sampleScore, drumtab: drumTabScore };
for (const [name, make] of Object.entries(cases)) {
  test(`round trip: ${name}`, () => {
    const src = make();
    const { xml, back } = roundTrip(src);
    assert.equal(detectFormat(xml), 'musicxml');
    const a = canon(src), b = canon(back);
    // compare section by section for readable failures
    assert.deepEqual(b.meta, a.meta, 'meta');
    assert.deepEqual(b.parts, a.parts, 'parts');
    a.measures.forEach((m, i) => assert.deepEqual(b.measures[i], m, `measure ${i + 1}`));
    assert.equal(b.measures.length, a.measures.length);
    assert.deepEqual(b.spanners, a.spanners, 'spanners');
  });
}
test('mxl round trip', async () => {
  const src = exampleScore();
  const bytes = await exportMXL(src, { JSZip });
  assert.equal(detectFormat(bytes), 'mxl');
  const back = await importMXL(bytes, { JSZip });
  assert.equal(back.measures.length, src.measures.length);
  assert.equal(back.meta.title, src.meta.title);
});
test('imports a hand-written MuseScore-style file', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>Test &amp; Song</work-title></work>
<part-list><score-part id="P1"><part-name>Flute</part-name><midi-instrument id="P1-I1"><midi-program>74</midi-program></midi-instrument></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><key><fifths>-1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>
<note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><lyric number="1"><syllabic>begin</syllabic><text>Hel</text></lyric></note>
<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><beam number="1">begin</beam><lyric number="1"><syllabic>end</syllabic><text>lo</text></lyric></note>
<note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><beam number="1">end</beam></note>
<note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
<barline location="right"><bar-style>light-heavy</bar-style></barline></measure></part></score-partwise>`;
  const s = importMusicXML(xml);
  assert.equal(s.meta.title, 'Test & Song');
  assert.equal(s.measures[0].keySig.fifths, -1);
  assert.equal(s.measures[0].timeSig.num, 3);
  const v = s.measures[0].staves[0].voices[0];
  assert.equal(v.length, 4);
  assert.equal(v[0].lyrics[0].text, 'Hel');
  assert.equal(v[2].notes[0].alter, -1);
  assert.equal(v[1].beam, undefined, 'auto beams are normalised away');
  assert.equal(s.measures[0].chords[0].text, 'F');
  assert.equal(s.measures[0].barlineRight, 'final');
});

// ---- cross-staff tuplets, tuplets left open, more than four voices on a staff
const durTicksOf = ev => { const B = { whole: 3840, half: 1920, quarter: 960, eighth: 480, '16th': 240, '32nd': 120, '64th': 60, '128th': 30 }; let t = B[ev.dur.base] * [1, 1.5, 1.75][ev.dur.dots || 0]; if (ev.tuplet) t = t * ev.tuplet.den / ev.tuplet.num; return ev.grace ? 0 : t; };
const lengthOf = v => v.reduce((s, e) => s + durTicksOf(e), 0);
const pianoHead = (beats, beatType, body) => `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>12</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>${body}</measure></part></score-partwise>`;
const xnote = (step, oct, dur, type, voice, staff, extra = '') => `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><type>${type}</type>${extra.includes('<time-modification') ? extra.match(/<time-modification>.*?<\/time-modification>/)[0] : ''}<staff>${staff}</staff>${extra.replace(/<time-modification>.*?<\/time-modification>/, '')}</note>`;
const TM6 = '<time-modification><actual-notes>6</actual-notes><normal-notes>4</normal-notes></time-modification>';

test('a sextuplet that wanders between the staves keeps every voice exact', () => {
  // voice 1: six sextuplet 16ths — E4 B3 on the upper staff, G3 E3 on the lower, E4 B3 on the upper — then a quarter
  const body = [
    xnote('E', 4, 2, '16th', 1, 1, TM6 + '<notations><tuplet type="start" bracket="no"/></notations>'),
    xnote('B', 3, 2, '16th', 1, 1, TM6),
    xnote('G', 3, 2, '16th', 1, 2, TM6),
    xnote('E', 3, 2, '16th', 1, 2, TM6),
    xnote('E', 4, 2, '16th', 1, 1, TM6),
    xnote('B', 3, 2, '16th', 1, 1, TM6 + '<notations><tuplet type="stop"/></notations>'),
    xnote('C', 5, 12, 'quarter', 1, 1),
    '<backup><duration>24</duration></backup>',
    xnote('C', 3, 24, 'half', 5, 2),
  ].join('');
  const s = importMusicXML(pianoHead(2, 4, body));
  const [up, low] = s.measures[0].staves;
  const u = up.voices[0];
  assert.deepEqual(u.map(e => (e.kind === 'note' ? e.notes[0].step + e.notes[0].octave : 'r') + (e.hidden ? 'h' : '') + (e.tuplet ? 't' : '')), ['E4t', 'B3t', 'rht', 'E4t', 'B3t', 'C5']);
  assert.equal(lengthOf(u), 1920, 'upper voice fills the 2/4 measure exactly');
  assert.equal(new Set(u.filter(e => e.tuplet).map(e => e.tuplet.id)).size, 1, 'one tuplet group on the upper staff');
  assert.equal(u[5].tuplet, undefined, 'the quarter after the tuplet is plain');
  // the two notes on the lower staff: hidden tuplet rests before and after them complete the tuplet there
  const borrowed = low.voices.find(v => v.some(e => e.kind === 'note' && e.notes[0].step === 'G'));
  assert.deepEqual(borrowed.map(e => (e.kind === 'note' ? e.notes[0].step : 'r') + (e.hidden ? 'h' : '') + (e.tuplet ? 't' : '')), ['rht', 'Gt', 'Et', 'rht']);
  assert.equal(lengthOf(borrowed), 960, 'its share of the tuplet is one quarter long');
  const bass = low.voices.find(v => v.some(e => e.kind === 'note' && e.notes[0].step === 'C'));
  assert.equal(lengthOf(bass), 1920);
});

test('a plain note never inherits a tuplet that was left open', () => {
  // the <tuplet type="stop"> sits on a note of the other staff, then plain eighths follow on the first staff
  const TM3 = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  const body = [
    xnote('C', 5, 4, 'eighth', 1, 1, TM3 + '<notations><tuplet type="start"/></notations>'),
    xnote('E', 5, 4, 'eighth', 1, 1, TM3),
    xnote('G', 3, 4, 'eighth', 1, 2, TM3 + '<notations><tuplet type="stop"/></notations>'),
    xnote('D', 5, 6, 'eighth', 1, 1), xnote('F', 5, 6, 'eighth', 1, 1),
  ].join('');
  const s = importMusicXML(pianoHead(2, 4, body));
  const u = s.measures[0].staves[0].voices[0];
  assert.deepEqual(u.map(e => (e.kind === 'note' ? e.notes[0].step : 'r') + (e.hidden ? 'h' : '') + (e.tuplet ? 't' : '')), ['Ct', 'Et', 'rht', 'D', 'F']);
  assert.equal(lengthOf(u), 1920);
  assert.equal(u[2].dur.base, 'eighth', 'the place of the third triplet note is a hidden triplet eighth');
});

test('a fifth voice on a staff borrows a free voice instead of piling onto the fourth', () => {
  const one = (voice, step) => xnote(step, 4, 48, 'whole', voice, 1);
  const back = '<backup><duration>48</duration></backup>';
  const m1 = [one(1, 'C'), back, one(2, 'D'), back, one(3, 'E'), back, one(4, 'F')].join('');
  const m2 = [one(5, 'G'), back, one(6, 'A')].join('');           // two more XML voices, alone in their measure
  const xml = pianoHead(4, 4, m1).replace('</measure></part>', `</measure><measure number="2">${m2}</measure></part>`);
  const s = importMusicXML(xml);
  const v2 = s.measures[1].staves[0].voices.filter(v => v.length);
  assert.equal(v2.length, 2, 'the two voices stay apart');
  for (const v of v2) assert.equal(lengthOf(v), 3840, 'neither is over-full');
});
