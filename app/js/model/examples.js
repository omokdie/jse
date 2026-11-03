// Built-in example score (public-domain melody "Ah! vous dirai-je, maman", original Korean lyrics).
import { createScore, createMeasure, makeNote, makeRest, newId, parsePitchName } from './score.js';

export function exampleScore() {
  const s = createScore({ title: '봄바람 (예제)', composer: '프랑스 민요', instruments: ['voice', 'piano'], measures: 0, timeSig: { num: 4, den: 4 }, keyFifths: 0, tempo: 96 });
  s.meta.subtitle = 'JSE 예제 — 음표를 클릭해 바꿔 보세요';
  s.settings.staffSpaceMm = 1.6;
  s.meta.lyricist = '작사: JSE';
  const mel = [['C4', 'C4', 'G4', 'G4'], ['A4', 'A4', 'G4:h'], ['F4', 'F4', 'E4', 'E4'], ['D4', 'D4', 'C4:h'], ['G4', 'G4', 'F4', 'F4'], ['E4', 'E4', 'D4:h'], ['G4', 'G4', 'F4', 'F4'], ['E4', 'E4', 'D4:h'], ['C4', 'C4', 'G4', 'G4'], ['A4', 'A4', 'G4:h'], ['F4', 'F4', 'E4', 'E4'], ['D4', 'D4', 'C4:h']];
  const lyr = ['봄바람이', '불어와', '꽃잎들이', '춤을춰', '새들노래', '들려와', '우리함께', '걸어요', '봄바람이', '불어와', '꽃잎들이', '춤을춰'];
  const chords = [['C'], ['F', 'C'], ['F', 'C'], ['G7', 'C'], ['C', 'F'], ['C', 'G'], ['C', 'F'], ['C', 'G'], ['C'], ['F', 'C'], ['F', 'C'], ['G7', 'C']];
  const rh = { C: ['E4', 'G4'], F: ['F4', 'A4'], G: ['D4', 'B4'], G7: ['F4', 'B4'] };
  const lh = { C: 'C3', F: 'F2', G: 'G2', G7: 'G2' };
  const chordEv = (names, base) => ({ id: newId(), kind: 'note', dur: { base, dots: 0 }, notes: names.map(p => ({ ...parsePitchName(p) })) });
  mel.forEach((bar, mi) => {
    const m = createMeasure(s);
    if (mi === 0) { m.timeSig = { num: 4, den: 4, display: 'normal' }; m.keySig = { fifths: 0, mode: 'major' }; m.tempo = { bpm: 96, beatUnit: 'quarter', dots: 0, text: 'Moderato', showBpm: true }; m.rehearsalMark = 'A'; }
    if (mi === 4) m.rehearsalMark = 'B';
    if (mi === 8) m.rehearsalMark = 'A′';
    const syl = [...lyr[mi]];
    m.staves[0].voices[0] = bar.map((tok, i) => { const [p, d] = tok.split(':'); const ev = makeNote(p, d === 'h' ? 'half' : 'quarter'); ev.lyrics = [{ verse: 1, text: syl[i] || '', syllabic: 'single' }]; return ev; });
    const ch = chords[mi];
    m.chords = ch.map((c, i) => ({ id: newId(), tick: ch.length === 1 ? 0 : i * 1920, text: c }));
    m.staves[1].voices[0] = ch.length === 1 ? [chordEv(rh[ch[0]], 'half'), chordEv(rh[ch[0]], 'half')] : ch.map(c => chordEv(rh[c], 'half'));
    m.staves[2].voices[0] = ch.length === 1 ? [makeNote(lh[ch[0]], 'whole')] : ch.map(c => makeNote(lh[c], 'half'));
    if (mi === 0) m.staves[1].voices[0][0].dynamic = 'mp';
    if (mi === 8) m.staves[1].voices[0][0].dynamic = 'mf';
    if (mi === 3 || mi === 7) m.breaks = { system: true };
    s.measures.push(m);
  });
  s.measures[11].barlineRight = 'final';
  s.measures[11].staves[0].voices[0][2].fermata = 'above';
  const v = i => s.measures[i].staves[0].voices[0];
  s.spanners.push({ id: newId(), type: 'slur', from: { eventId: v(4)[0].id }, to: { eventId: v(5)[2].id } });
  s.spanners.push({ id: newId(), type: 'crescendo', from: { eventId: s.measures[6].staves[1].voices[0][0].id }, to: { eventId: s.measures[7].staves[1].voices[0][1].id } });
  void makeRest;
  return s;
}
