import { createScore, makeNote, makeRest, newId, createPart, createMeasure } from '../app/js/model/score.js';

export function sampleScore() {
  const s = createScore({ title: '나비야 (Sample)', composer: '독일 민요 / arr. JSE', instruments: ['voice', 'piano'], measures: 0, timeSig: { num: 4, den: 4 }, keyFifths: 1, tempo: 100 });
  s.meta.subtitle = '렌더링 테스트';
  s.meta.lyricist = '작사: 테스트';
  const M = (fill) => { const m = createMeasure(s); fill(m); s.measures.push(m); return m; };
  const n = (p, b = 'quarter', d = 0, extra = {}) => Object.assign(makeNote(p, b, d), extra);
  const lyr = (ev, text, syl = 'single') => { ev.lyrics = [{ verse: 1, text, syllabic: syl }]; return ev; };
  const chord = (ps, b = 'quarter', d = 0) => ({ id: newId(), kind: 'note', dur: { base: b, dots: d }, notes: ps.map(p => { const m = /^([A-G])(#|b)?(\d)$/.exec(p); return { step: m[1], octave: +m[3], alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 }; }) });
  let m;
  // measure 1
  m = M(mm => {
    mm.timeSig = { num: 4, den: 4, display: 'normal' }; mm.keySig = { fifths: 1, mode: 'major' }; mm.tempo = { bpm: 100, beatUnit: 'quarter', dots: 0, text: 'Allegretto', showBpm: true };
    mm.chords = [{ id: newId(), tick: 0, text: 'G' }, { id: newId(), tick: 1920, text: 'D7' }];
    mm.rehearsalMark = 'A';
    mm.staves[0].voices[0] = [lyr(n('G4', 'quarter'), '나'), lyr(n('E4', 'quarter'), '비'), lyr(n('E4', 'half'), '야')];
    mm.staves[1].voices[0] = [chord(['G4', 'B4', 'D5'], 'half'), chord(['F#4', 'A4', 'D5'], 'half')];
    mm.staves[2].voices[0] = [n('G2', 'quarter'), n('D3', 'quarter'), n('G2', 'quarter'), n('D3', 'quarter')];
  });
  m = M(mm => {
    mm.chords = [{ id: newId(), tick: 0, text: 'G' }];
    mm.staves[0].voices[0] = [lyr(n('F4', 'quarter', 0, { notes: [{ step: 'F', octave: 4, alter: 1 }] }), '나'), lyr(n('D4', 'quarter'), '비'), lyr(n('D4', 'half', 0, { fermata: 'above' }), '야')];
    mm.staves[1].voices[0] = [chord(['F#4', 'A4', 'C5'], 'half'), chord(['G4', 'B4'], 'quarter'), makeRest('quarter')];
    mm.staves[2].voices[0] = [n('D2', 'half'), n('G2', 'half')];
  });
  m = M(mm => {
    mm.staves[0].voices[0] = [lyr(n('C4', 'eighth'), '이', 'begin'), lyr(n('D4', 'eighth'), '리', 'end'), lyr(n('E4', 'eighth'), '날', 'single'), lyr(n('F4', 'eighth'), '아', 'begin'), lyr(n('G4', 'quarter'), '오', 'end'), lyr(n('A4', 'eighth', 0, { articulations: ['staccato'] }), '너', 'single'), lyr(n('B4', 'eighth', 0, { articulations: ['accent'] }), '라', 'single')];
    mm.staves[1].voices[0] = [chord(['C4', 'E4', 'G4'], 'quarter', 1), chord(['D4', 'F#4'], 'eighth'), chord(['E4', 'G4', 'C5'], 'half')];
    mm.staves[2].voices[0] = [n('C3', 'quarter'), n('D3', 'quarter'), n('E3', 'eighth'), n('F#3', 'eighth'), n('G3', 'quarter')];
  });
  // triplets & 16ths & ties & dynamics
  m = M(mm => {
    const tid = newId();
    mm.staves[0].voices[0] = [
      n('G4', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2, show: 'number' }, dynamic: 'mf' }), n('A4', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2 } }), n('B4', 'eighth', 0, { tuplet: { id: tid, num: 3, den: 2 } }),
      n('C5', '16th'), n('B4', '16th'), n('A4', '16th'), n('G4', '16th'),
      n('F#4', 'quarter', 0, { notes: [{ step: 'F', octave: 4, alter: 1, tieStart: true }] }), n('F#4', 'quarter', 0, { notes: [{ step: 'F', octave: 4, alter: 1, tieEnd: true }] }),
    ];
    mm.staves[0].voices[0][0].lyrics = [{ verse: 1, text: '셋잇단' }];
    mm.staves[1].voices[0] = [n('D5', 'quarter'), n('C5', 'eighth'), n('B4', 'eighth'), chord(['A4', 'C5'], 'half')];
    mm.staves[1].voices[1] = [n('G4', 'half'), n('F#4', 'half')];
    mm.staves[2].voices[0] = [n('G2', 'quarter', 0, { articulations: ['tenuto'] }), makeRest('quarter'), n('D3', 'quarter', 0, { articulations: ['marcato'] }), makeRest('eighth'), n('D2', 'eighth')];
  });
  // grace, dotted, accidentals with naturals, slur, crescendo, repeat end, 2nd verse
  m = M(mm => {
    mm.staves[0].voices[0] = [n('F4', 'eighth', 0, { grace: { slash: true } }), n('E4', 'quarter', 1), n('D4', 'eighth'), n('C4', 'quarter', 0, { notes: [{ step: 'C', octave: 4, alter: 1 }] }), n('C4', 'quarter', 0, { notes: [{ step: 'C', octave: 4, alter: 0 }] })];
    mm.staves[0].voices[0][1].lyrics = [{ verse: 1, text: 'Grace' }, { verse: 2, text: '2절' }];
    mm.staves[0].voices[0][3].lyrics = [{ verse: 1, text: '샵' }, { verse: 2, text: '내' }];
    mm.staves[0].voices[0][4].lyrics = [{ verse: 1, text: '제자리' }, { verse: 2, text: '림' }];
    mm.staves[1].voices[0] = [n('B5', 'quarter', 0, { tremolo: 2 }), n('A5', 'quarter', 0, { arpeggio: true, notes: [{ step: 'A', octave: 5, alter: 0 }, { step: 'C', octave: 5, alter: 0 }, { step: 'E', octave: 5, alter: 0 }] }), chord(['G3', 'B3', 'D4'], 'half')];
    mm.staves[2].voices[0] = [n('C2', 'whole')];
    mm.barlineRight = 'repeat-end';
    mm.texts = [{ text: 'rit.', placement: 'above', style: 'expression' }];
  });
  s.spanners.push({ id: newId(), type: 'slur', from: { eventId: m.staves[0].voices[0][1].id }, to: { eventId: m.staves[0].voices[0][3].id } });
  s.spanners.push({ id: newId(), type: 'crescendo', from: { eventId: s.measures[3].staves[0].voices[0][3].id }, to: { eventId: s.measures[3].staves[0].voices[0][6].id } });
  // more measures to force a second system/page
  for (let i = 0; i < 12; i++) {
    M(mm => {
      mm.staves[0].voices[0] = [n(['G4', 'A4', 'B4', 'C5'][i % 4], 'half'), n(['E4', 'F4', 'G4', 'A4'][i % 4], 'quarter'), n('D4', 'quarter')];
      mm.staves[1].voices[0] = [chord(['G4', 'B4'], 'whole')];
      mm.staves[2].voices[0] = [n('G2', 'half'), n('D3', 'half')];
      if (i === 3) mm.breaks = { system: true };
      if (i === 5) { mm.keySig = { fifths: -2, mode: 'major' }; mm.timeSig = { num: 3, den: 4, display: 'normal' }; mm.staves[0].voices[0] = [n('Bb4', 'half'), n('Eb4', 'quarter')]; mm.staves[1].voices[0] = [chord(['Bb3', 'D4'], 'half', 1)]; mm.staves[2].voices[0] = [n('Bb2', 'half', 1)]; }
      if (i > 5) { mm.staves[0].voices[0] = [n('F4', 'quarter'), n('G4', 'quarter'), n('A4', 'quarter')]; mm.staves[1].voices[0] = [chord(['F4', 'A4'], 'half', 1)]; mm.staves[2].voices[0] = [n('F2', 'half', 1)]; }
    });
  }
  s.measures[s.measures.length - 1].barlineRight = 'final';
  s.spanners.push({ id: newId(), type: 'volta', from: { measureId: s.measures[3].id }, to: { measureId: s.measures[4].id }, number: '1.' });
  return s;
}

export function drumTabScore() {
  const s = createScore({ title: 'Drums & TAB', instruments: ['guitar-tab', 'drumset'], measures: 0, timeSig: { num: 4, den: 4 }, keyFifths: 0, tempo: 120 });
  const M = (fill) => { const m = createMeasure(s); fill(m); s.measures.push(m); return m; };
  const d = (keys, b = 'eighth') => ({ id: newId(), kind: 'note', dur: { base: b, dots: 0 }, notes: keys.map(k => ({ step: 'C', octave: 5, alter: 0, drum: k })) });
  const t = (string, fret, b = 'eighth') => ({ id: newId(), kind: 'note', dur: { base: b, dots: 0 }, notes: [{ step: 'E', octave: 4, alter: 0, string, fret }] });
  for (let i = 0; i < 4; i++) M(mm => {
    if (i === 0) { mm.timeSig = { num: 4, den: 4, display: 'normal' }; mm.keySig = { fifths: 0, mode: 'major' }; }
    mm.staves[0].voices[0] = [t(6, 3), t(5, 2), t(4, 0), t(3, 0), t(2, 0, 'quarter'), t(1, 3, 'quarter')];
    mm.staves[1].voices[0] = [d(['hihat-closed', 'kick']), d(['hihat-closed']), d(['hihat-closed', 'snare']), d(['hihat-closed']), d(['hihat-closed', 'kick']), d(['hihat-closed', 'kick']), d(['hihat-closed', 'snare']), d(['hihat-open'])];
    mm.staves[1].voices[1] = [{ id: newId(), kind: 'note', dur: { base: 'quarter', dots: 0 }, notes: [{ step: 'F', octave: 4, alter: 0, drum: 'kick' }] }, makeRest('quarter'), { id: newId(), kind: 'note', dur: { base: 'quarter', dots: 0 }, notes: [{ step: 'F', octave: 4, alter: 0, drum: 'kick' }] }, makeRest('quarter')];
  });
  return s;
}

