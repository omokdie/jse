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
