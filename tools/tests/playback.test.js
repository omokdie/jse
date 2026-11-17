// Playback / MIDI timing and the pitch conventions shared by the importers (run: node --test tools/tests/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayback, writeMidi, measurePlayTicks } from '../../app/js/io/midi.js';
import { importMusicXML, exportMusicXML } from '../../app/js/io/musicxml.js';
import { createScore, makeNote, makeRest, newId, ottavaShifts } from '../../app/js/model/score.js';
import { printableSvg } from '../../app/js/io/export.js';
import { engrave } from '../../app/js/engrave/render.js';

function melody(measures, { pickup = false, bpm = 120 } = {}) {
  const s = createScore({ title: 't', instrument: 'voice', measures: measures.length, timeSig: { num: 4, den: 4 } });
  s.measures[0].tempo = { bpm, beatUnit: 'quarter' };
  measures.forEach((names, mi) => { s.measures[mi].staves[0].voices[0] = names.map(n => (n === 'r' ? makeRest('quarter') : makeNote(n, 'quarter'))); });
  if (pickup) s.measures[0].pickup = true;
  return s;
}

test('an upbeat measure is played as long as its notes, not as a full bar', () => {
  const s = melody([['G4'], ['C5', 'D5', 'E5', 'F5'], ['G5', 'r', 'r', 'r']], { pickup: true });
  assert.equal(measurePlayTicks(s.measures[0], 3840), 960);
  const pb = buildPlayback(s);
  assert.deepEqual(pb.measureTimes.map(m => +m.dur.toFixed(3)), [0.5, 2, 2]);
  assert.deepEqual(pb.measureTimes.map(m => +m.time.toFixed(3)), [0, 0.5, 2.5]);
  const c5 = pb.notes.find(n => n.midi === 72);
  assert.equal(+c5.time.toFixed(3), 0.5, 'the first full bar starts right after the upbeat');
  assert.equal(+pb.duration.toFixed(3), 4.5);
  // the metronome counts the upbeat back from the bar line and accents every downbeat after it
  assert.deepEqual(pb.clicks.slice(0, 3).map(c => [+c.time.toFixed(3), c.accent]), [[0, false], [0.5, true], [1, false]]);
  // without the flag the same measure is a full bar
  delete s.measures[0].pickup;
  assert.equal(+buildPlayback(s).measureTimes[1].time.toFixed(3), 2);
});

test('an eighth-note upbeat keeps the clicks on the beats of the bars that follow', () => {
  const s = melody([['G4'], ['C5', 'D5', 'E5', 'F5']], { pickup: true });
  s.measures[0].staves[0].voices[0] = [makeNote('G4', 'eighth')];
  const pb = buildPlayback(s);
  assert.equal(+pb.measureTimes[1].time.toFixed(3), 0.25);
  assert.deepEqual(pb.clicks.slice(0, 3).map(c => +c.time.toFixed(3)), [0.25, 0.75, 1.25], 'no click inside a half-beat upbeat; the grid starts at the bar line');
});

test('MIDI export gives the upbeat a meter of its own length', () => {
  const s = melody([['G4'], ['C5', 'D5', 'E5', 'F5']], { pickup: true });
  const bytes = writeMidi(s);
  const sigs = [];
  for (let i = 0; i + 6 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0x58 && bytes[i + 2] === 4) sigs.push(`${bytes[i + 3]}/${2 ** bytes[i + 4]}`);
  assert.deepEqual(sigs, ['1/4', '4/4']);
});

test('transposing parts always sound at written pitch + transposition', () => {
  for (const concertPitch of [true, false, undefined]) {
    const s = melody([['C5', 'D5', 'E5', 'F5']]);
    s.parts[0].transposeChromatic = -2;                    // B♭ instrument
    if (concertPitch === undefined) delete s.settings.concertPitch; else s.settings.concertPitch = concertPitch;
    assert.equal(buildPlayback(s).notes[0].midi, 70, `concertPitch ${concertPitch}`);
  }
});

const OTTAVA_XML = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
<direction placement="above"><direction-type><octave-shift type="down" size="8" number="1"/></direction-type></direction>
<note><pitch><step>C</step><octave>6</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
<note><pitch><step>D</step><octave>6</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
<direction placement="above"><direction-type><octave-shift type="stop" size="8" number="1"/></direction-type></direction>
<note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;

test('notes under an 8va line: written on the staff, sounding in MusicXML and in playback', () => {
  const s = importMusicXML(OTTAVA_XML);
  const v = s.measures[0].staves[0].voices[0];
  assert.deepEqual(v.map(e => e.notes[0].step + e.notes[0].octave), ['C5', 'C5', 'D5', 'E5'], 'stored as written (an octave below the sound)');
  const line = s.spanners.find(sp => sp.type === 'ottava');
  assert.ok(line && line.octaveShift === 8);
  assert.deepEqual([...ottavaShifts(s).values()], [12, 12]);
  assert.deepEqual(buildPlayback(s).notes.map(n => n.midi), [72, 84, 86, 76], 'played an octave higher under the line');
  const xml = exportMusicXML(s);
  const octs = [...xml.matchAll(/<step>(\w)<\/step>\s*(?:<alter>[^<]*<\/alter>\s*)?<octave>(\d)<\/octave>/g)].map(m => m[1] + m[2]);
  assert.deepEqual(octs, ['C5', 'C6', 'D6', 'E5'], 'the file holds sounding pitches again');
  const back = importMusicXML(xml);
  assert.deepEqual(back.measures[0].staves[0].voices[0].map(e => e.notes[0].step + e.notes[0].octave), ['C5', 'C5', 'D5', 'E5']);
});

test('MusicXML dynamics spelled with p m f s z r, and chord degrees after a kind text', () => {
  const dyn = d => `<direction placement="below"><direction-type><dynamics><${d}/></dynamics></direction-type></direction>`;
  const note = s => `<note><pitch><step>${s}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<harmony><root><root-step>A</root-step></root><kind text="7">dominant</kind><degree><degree-value>5</degree-value><degree-alter>-1</degree-alter><degree-type>alter</degree-type></degree></harmony>
${dyn('sf')}${note('C')}${dyn('sffz')}${note('D')}
<harmony><root><root-step>C</root-step></root><kind text="7b5">dominant</kind><degree><degree-value>5</degree-value><degree-alter>-1</degree-alter><degree-type>alter</degree-type></degree></harmony>
${dyn('rf')}${note('E')}${dyn('pppp')}${note('F')}</measure></part></score-partwise>`;
  const s = importMusicXML(xml);
  assert.deepEqual(s.measures[0].staves[0].voices[0].map(e => e.dynamic), ['sf', 'sffz', 'rf', 'pppp']);
  assert.deepEqual(s.measures[0].chords.map(c => c.text), ['A7b5', 'C7b5'], 'the degree is added once, not twice');
  assert.match(exportMusicXML(s), /<dynamics>\s*<sffz\/>\s*<\/dynamics>/);
});

test('hidden events are left out of printed and exported pages', () => {
  const s = melody([['C5', 'r', 'E5', 'F5']]);
  s.measures[0].staves[0].voices[0][1].hidden = true;
  const svg = engrave(s).pages[0].svg;
  assert.match(svg, /class="ev rest hidden"/);
  assert.match(svg, /\.score-page \.hidden\{opacity:0\.25\}/, 'faint on screen');
  const out = printableSvg(svg);
  assert.match(out, /\.score-page \.hidden\{display:none\}/);
  assert.doesNotMatch(out, /opacity:0\.25/);
});
