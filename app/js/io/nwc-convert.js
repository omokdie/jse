// JSE — NWC document (see nwc-text.js / nwc-binary.js) → ScoreDoc (SPEC §2).
//
// An NWC staff is one stream of objects: signatures, bar lines, notes, expressions. This module
// plays that stream the way NoteWorthy Composer does and writes down what it means:
//   * pitch: staff position + clef (+ octave shift), key signature, accidentals that hold for the
//     rest of the bar — for the note NAME in every octave, as NWC plays them — and across ties;
//   * time: every object advances by its shortest duration; the longer half of a "split stem"
//     chord (and the rest of a rest chord) goes to a second voice;
//   * lyrics: NWC keeps one text per verse and hands syllables to notes by its own rules
//     (splitNwcLyric / the "takes a syllable" test below);
//   * layered staves become the voices of one staff, a grand-staff pair one piano part.
// Rules come from NoteWorthy's help file and user-tool library; where those are silent the
// behaviour was derived from files written by NWC itself (binary lyric blocks keep NWC's own
// syllable split, 2.75 files show which objects people actually write).

import {
  newId, DUR_TICKS, durTicks, ticksToDurations, makeRest, measureCapacity, validateScore, createScore, createPart,
  INSTRUMENTS, DEFAULT_DRUM_MAP, midiOf, noteAtStaffPosition, keyAlter,
} from '../model/score.js';
import { normalizeImported } from './musicxml.js';

const BASES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];
const STEP_NAMES = 'CDEFGAB';
// diatonic index (C0 = 0) of the middle staff line
const CLEF_CENTER = { Treble: 34, Bass: 22, Alto: 28, Tenor: 26, Percussion: 22 };
const ACC_ALTER = { '#': 1, b: -1, n: 0, x: 2, v: -2 };
const ACC_NAME = { 2: 'double-sharp', 1: 'sharp', 0: 'natural', '-1': 'flat', '-2': 'double-flat' };
const TEMPO_UNIT = { Eighth: ['eighth', 0], 'Eighth Dotted': ['eighth', 1], Quarter: ['quarter', 0], 'Quarter Dotted': ['quarter', 1], Half: ['half', 0], 'Half Dotted': ['half', 1] };
const FLOW_MARKER = { Coda: 'coda', Segno: 'segno', Fine: 'fine', ToCoda: 'toCoda', DaCapo: 'dc', DCalCoda: 'dcAlCoda', DCalFine: 'dcAlFine', DalSegno: 'ds', DSalCoda: 'dsAlCoda', DSalFine: 'dsAlFine' };
const TEMPO_VAR_TEXT = { Accelerando: 'accel.', Allargando: 'allarg.', Rallentando: 'rall.', Ritardando: 'rit.', Ritenuto: 'riten.', Rubato: 'rubato', Stringendo: 'string.' };
const DYN_VAR_TEXT = { Crescendo: 'cresc.', Decrescendo: 'decresc.', Diminuendo: 'dim.' };
const OPEN_BARS = new Set(['SectionOpen', 'MasterRepeatOpen', 'LocalRepeatOpen']);
// text in these typefaces is glyph codes of a music/symbol font, not words
const SYMBOL_FONT_RE = /^(nwc|noteworthy)|boxmark|maestro|swingdings|wingdings|webdings|symbol|music|opus|petrucci|sonata|inkpen|fughetta|toccata/i;

const ticksOf = (dur) => {
  if (dur.grace) return 0;
  let t = DUR_TICKS[BASES[dur.base]] || 960;
  if (dur.dots === 1) t *= 1.5; else if (dur.dots === 2) t *= 1.75;
  if (dur.triplet) t = t * 2 / 3;
  return t;
};

// ---------------------------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------------------------
/**
 * Splits the text of one NWC lyric line into the syllables NWC hands to notes.
 * Blanks and line breaks separate syllables; a hyphen inside a word starts the next syllable of
 * that word ("jun-gle" → jun, -gle); a hyphen on its own, or at the end of a word, is just a
 * character ("wi - - wi", "우-"); "_" is a space that does not separate ("1._O" is one syllable)
 * and a syllable made of underscores only skips a note.
 * @returns {{text:string, syllabic:'single'|'begin'|'middle'|'end', extend?:boolean}[]}  text '' = note skipped
 */
export function splitNwcLyric(text, underscoreAsSpace = true) {
  const pieces = [];
  for (const tok of String(text || '').split(/\s+/)) {
    if (!tok) continue;
    let start = 0;
    for (let i = 1; i < tok.length - 1; i++) {
      if (tok[i] === '-' && tok[i + 1] !== '-') { pieces.push(tok.slice(start, i)); start = i; }
    }
    pieces.push(tok.slice(start));
  }
  const joins = pieces.map(p => p.length > 1 && p[0] === '-' && p[1] !== '-');
  return pieces.map((p, i) => {
    let body = joins[i] ? p.slice(1) : p;
    let extend = false;
    if (underscoreAsSpace) body = body.replace(/_/g, ' ');
    else if (/[^_]_+$/.test(body)) { body = body.replace(/_+$/, ''); extend = true; }   // "Ah____": underscores drawn as an extender line
    const shown = body.trim() ? body.replace(/^ +/, '') : '';
    const next = joins[i + 1] === true;
    const out = { text: shown, syllabic: joins[i] ? (next ? 'middle' : 'end') : (next ? 'begin' : 'single') };
    if (extend) out.extend = true;
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Chord names written as text
// ---------------------------------------------------------------------------------------------
const CHORD_RE = /^([A-G])([#b♯♭]?)((?:maj|Maj|MAJ|ma|M|min|mi|m|dim|aug|sus|add|omit|no|alt|\+|-|°|º|ø|Δ|△|[0-9]|[#b♯♭])*)(\([^()]{1,12}\))?(?:\/([A-G][#b♯♭]?))?$/;
const plainAcc = (s) => (s || '').replace(/♯/g, '#').replace(/♭/g, 'b');
/** "F#m7b5/A" → {text, root, kind, bass}; null when the text is not a chord name. */
export function parseChordName(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 16) return null;
  if (/^N\.?C\.?$/.test(t)) return { text: 'N.C.' };
  const slash = /^\/([A-G][#b♯♭]?)$/.exec(t);
  if (slash) return { text: t, bass: plainAcc(slash[1]), weak: false, slashOnly: true };
  const m = CHORD_RE.exec(t);
  if (!m) return null;
  const root = m[1] + plainAcc(m[2]);
  const kind = plainAcc(m[3] || '') + (m[4] || '');
  const out = { text: t, root };
  if (kind) out.kind = kind;
  if (m[5]) out.bass = plainAcc(m[5]);
  out.weak = !kind && !m[5] && !m[2];              // a bare capital letter could be a rehearsal mark too
  return out;
}
/** Several chord names in one text object ("Ab       Bb") → list, or null. */
function parseChordText(text) {
  const parts = String(text || '').trim().split(/\s{2,}|\s+(?=[A-G\/])/).filter(Boolean);
  if (!parts.length || parts.length > 6) return null;
  const out = parts.map(parseChordName);
  return out.every(Boolean) ? out : null;
}

// ---------------------------------------------------------------------------------------------
// One NWC staff → measures of events
// ---------------------------------------------------------------------------------------------
function newMeasure() {
  return { main: [], extra: [], tick: 0, timed: 0, bar: 'Single', markers: [], chords: [], texts: [], lone: null };
}

function interpretStaff(st, ctx) {
  const { warn, fonts } = ctx;
  const S = {
    clef: 'Treble', octave: 0, key: {}, run: {}, ties: new Map(), slurState: false,
    slur: null, hairpin: null, tup: null, tup2: null, lastEv: null, lastNote: null,
    pendingDynamic: null, pendingTexts: [], pendingFermata: false, pedalPending: false, pedalFrom: null,
  };
  const out = { measures: [], spanners: [], endings: [], initialClef: null, patch: null, trans: null, lyricVerses: 0, percussion: false, drumKeys: new Map() };
  let cur = newMeasure();
  const prevMeasure = () => out.measures[out.measures.length - 1];
  let sawTimed = false;

  // lyrics: verse k+1 = k-th non-empty lyric line
  const uas = !(st.lyrics && st.lyrics.underscoreAsSpace === false);
  const verses = (st.lyricLines || []).map(l => splitNwcLyric(l && l.text, uas)).filter(v => v.length);
  const next = verses.map(() => 0);
  out.lyricVerses = verses.length;

  const clefName = () => {
    const c = S.clef, o = S.octave;
    if (c === 'Percussion') return 'percussion';
    if (c === 'Treble') return o < 0 ? 'treble8vb' : o > 0 ? 'treble8va' : 'treble';
    if (c === 'Bass') { if (o > 0) warn('옥타브 올림 낮은음자리표는 일반 낮은음자리표로 바꿨습니다(음높이는 그대로)'); return o < 0 ? 'bass8vb' : 'bass'; }
    if (o) warn('옥타브 이동 가온음자리표는 일반 음자리표로 바꿨습니다(음높이는 그대로)');
    return c === 'Alto' ? 'alto' : 'tenor';
  };

  const closeMeasure = (bar) => {
    cur.bar = bar || 'Single';
    out.measures.push(cur);
    const done = cur;
    cur = newMeasure();
    // a chord name typed after the last note of a bar stands over the bar line: it belongs to the next bar
    const late = done.tick > 0 ? done.chords.filter(c => c.tick >= done.tick - 1) : [];
    if (late.length) { done.chords = done.chords.filter(c => !late.includes(c)); for (const c of late) cur.chords.push({ ...c, tick: 0 }); }
    S.run = { ...S.key };
  };

  /** One component (notes of one stem, or a rest) → Event. */
  const makeEvent = (comp, it, tupKey) => {
    const dur = comp.dur;
    const ev = { id: newId(), kind: comp.heads ? 'note' : 'rest', dur: { base: BASES[dur.base] || 'quarter', dots: dur.dots || 0 } };
    if (dur.grace) ev.grace = { slash: dur.base === 3 && !comp.beam };
    else if (dur.triplet) {
      if (dur.triplet === 'First' || !S[tupKey]) S[tupKey] = { id: newId() };
      ev.tuplet = { id: S[tupKey].id, num: 3, den: 2, show: 'number' };
      if (dur.triplet === 'End') S[tupKey] = null;
    } else S[tupKey] = null;
    if (comp.hidden || it.visibility === 'Never') ev.hidden = true;
    if (comp.heads) {
      if (comp.stem === 'Up') ev.stem = 'up'; else if (comp.stem === 'Down') ev.stem = 'down';
      if (!dur.grace && dur.base >= 3) ev.beam = comp.beam === 'First' ? 'begin' : comp.beam === 'Mid' ? 'continue' : comp.beam === 'End' ? 'end' : 'none';
      const arts = [];
      if (dur.staccato) arts.push('staccato');
      if (dur.staccatissimo) arts.push('staccatissimo');
      if (dur.tenuto) arts.push('tenuto');
      if (dur.accent) arts.push('accent');
      if (dur.marcato) arts.push('marcato');
      if (arts.length) ev.articulations = arts;
    }
    return ev;
  };

  const addTimed = (it) => {
    const o = it.opts || {};
    const opposite = o.stem === 'Up' ? 'Down' : o.stem === 'Down' ? 'Up' : undefined;
    let comps;
    if (it.type === 'Note') comps = [{ dur: it.dur, heads: it.notes, stem: o.stem, beam: o.beam }];
    else if (it.type === 'Rest') comps = [{ dur: it.dur, heads: null }];
    else if (it.type === 'Chord') {
      comps = [{ dur: it.dur, heads: it.notes, stem: o.stem, beam: o.beam }];
      if (it.notes2 && it.notes2.length) comps.push({ dur: { ...it.dur2, grace: it.dur.grace }, heads: it.notes2, stem: o.stem2 || opposite, beam: o.beam2 });
    } else {
      comps = [{ dur: { ...it.dur2, grace: it.dur.grace }, heads: it.notes2, stem: o.stem2 || opposite, beam: o.beam2 },
        { dur: it.dur, heads: null, hidden: !!o.hideRest }];
    }
    const grace = !!it.dur.grace;
    // the shorter component is the one the staff moves on with
    if (comps.length > 1 && ticksOf(comps[1].dur) < ticksOf(comps[0].dur)) comps.reverse();
    if (comps.length > 1 && ticksOf(comps[1].dur) === ticksOf(comps[0].dur) && !comps[0].heads) comps.reverse();

    // ---- pitches: every head of the object sees the accidentals in force before it
    const changes = {};
    let tiedIn = false;
    const allHeads = [];
    for (const c of comps) {
      if (!c.heads) continue;
      c.notes = c.heads.map((h) => {
        const d = (CLEF_CENTER[S.clef] || 34) + h.pos + 7 * S.octave;
        const step = STEP_NAMES[((d % 7) + 7) % 7];
        const octave = Math.floor(d / 7);
        const running = S.ties.get(h.pos);
        const alter = h.acc ? ACC_ALTER[h.acc] : (running != null ? running : (S.run[step] || 0));
        const note = { step, octave, alter };
        const receives = running != null && running === alter;
        if (receives) { note.tieEnd = true; tiedIn = true; if (!h.tie) S.ties.delete(h.pos); }
        else { if (running != null) S.ties.delete(h.pos); if (h.tie) S.ties.set(h.pos, alter); }
        if (h.tie) note.tieStart = true;
        if (h.acc) { changes[step] = alter; note._acc = true; }
        if (h.head === 'x' || h.head === 'X') note.head = 'x';
        if (S.clef === 'Percussion') note._pos = h.pos;
        return note;
      });
      allHeads.push(...c.notes);
    }
    Object.assign(S.run, changes);

    // ---- events
    const startTick = cur.tick;
    const mainEv = makeEvent(comps[0], it, 'tup');
    if (comps[0].notes) mainEv.notes = comps[0].notes;
    let extraEv = null;
    if (comps[1]) {
      extraEv = makeEvent(comps[1], it, 'tup2');
      if (comps[1].notes) extraEv.notes = comps[1].notes;
      cur.extra.push({ tick: startTick, ev: extraEv, ticks: ticksOf(comps[1].dur), upper: comps[1].stem === 'Up' || (comps[1].stem == null && comps[0].stem === 'Down') });
    }
    cur.main.push(mainEv);
    const noteEv = mainEv.kind === 'note' ? mainEv : (extraEv && extraEv.kind === 'note' ? extraEv : null);
    if (!grace) { cur.tick += ticksOf(comps[0].dur); cur.timed++; sawTimed = true; }
    cur.lone = cur.main.length === 1 && !comps[1] && it.type === 'Rest' && it.dur.base === 0 && !it.dur.dots && !it.dur.triplet ? mainEv : null;

    // ---- lyrics (NWC: notes that are not grace notes and do not receive a tie or slur)
    const slurFlag = !!(it.dur.slur || (it.dur2 && it.dur2.slur));
    let takes;
    if (o.lyric === 'Never') takes = false;
    else if (o.lyric === 'Always') takes = true;
    else takes = !!noteEv && !grace && !tiedIn && !S.slurState;
    if (takes && verses.length) {
      const target = noteEv || mainEv;
      verses.forEach((v, vi) => {
        if (next[vi] >= v.length) return;
        const syl = v[next[vi]++];
        if (!syl.text) return;
        const ly = { verse: vi + 1, text: syl.text, syllabic: syl.syllabic };
        if (syl.extend) ly.extend = true;
        (target.lyrics || (target.lyrics = [])).push(ly);
      });
    }

    // ---- slurs: the flag means "slurred to the next note"
    if (noteEv) {
      if (slurFlag && !S.slur) S.slur = { from: noteEv, dir: o.slurDir };
      else if (!slurFlag && S.slur && !grace) {
        if (S.slur.from !== noteEv) out.spanners.push(Object.assign({ id: newId(), type: 'slur', from: { eventId: S.slur.from.id }, to: { eventId: noteEv.id } }, S.slur.dir ? { placement: S.slur.dir === 'Upward' ? 'above' : 'below' } : {}));
        S.slur = null;
      }
    } else if (!slurFlag && S.slur && S.lastNote && !grace) {
      // slur running into a rest: it ends on the last note
      if (S.slur.from !== S.lastNote) out.spanners.push({ id: newId(), type: 'slur', from: { eventId: S.slur.from.id }, to: { eventId: S.lastNote.id } });
      S.slur = null;
    }
    if (!grace) S.slurState = slurFlag;

    // ---- hairpins from the crescendo / diminuendo note flags
    const hp = o.crescendo ? 'crescendo' : o.diminuendo ? 'diminuendo' : null;
    const target = noteEv || mainEv;
    if (S.hairpin && S.hairpin.type !== hp) {
      const to = hp || noteEv ? target : S.hairpin.last;
      if (to !== S.hairpin.from) out.spanners.push({ id: newId(), type: S.hairpin.type, from: { eventId: S.hairpin.from.id }, to: { eventId: to.id } });
      S.hairpin = null;
    }
    if (hp) { if (!S.hairpin) S.hairpin = { type: hp, from: target, last: target }; else S.hairpin.last = target; }

    // ---- things waiting for the next note
    if (S.pedalPending) { S.pedalFrom = target; S.pedalPending = false; }
    if (noteEv) {
      if (S.pendingDynamic) { noteEv.dynamic = S.pendingDynamic; S.pendingDynamic = null; }
      if (S.pendingTexts.length) { noteEv.texts = (noteEv.texts || []).concat(S.pendingTexts); S.pendingTexts = []; }
    }
    if (S.pendingFermata && !grace) { target.fermata = 'above'; S.pendingFermata = false; }
    if (!grace) { S.lastEv = target; if (noteEv) S.lastNote = noteEv; }
  };

  const textStyle = (font) => (font === 'StaffItalic' ? 'expression' : font === 'StaffBold' ? 'technique' : 'plain');
  const pushText = (text, pos, style) => {
    if (!text) return;
    S.pendingTexts.push({ text, placement: pos != null && pos < 0 ? 'below' : 'above', style, _tick: cur.tick });
  };
  /** Texts still waiting when a bar line comes belong to the measure, not to a note. */
  const flushTexts = (m) => {
    for (const t of S.pendingTexts) { const { _tick, ...rest } = t; m.texts.push(rest); }
    S.pendingTexts = [];
  };

  for (const it of st.items || []) {
    switch (it.type) {
      case 'Clef': {
        S.clef = it.clef; S.octave = it.octave || 0;
        if (it.clef === 'Percussion') out.percussion = true;
        const name = clefName();
        if (!sawTimed && !out.measures.length) out.initialClef = name;
        else if (!cur.timed) cur.clef = name;
        else { cur.clefAfter = name; warn('마디 중간의 음자리표 변경은 다음 마디 처음으로 옮겼습니다'); }
        break;
      }
      case 'Key': {
        S.key = { ...it.alters }; S.run = { ...S.key };
        const names = Object.keys(it.alters);
        const sharps = names.filter(n => it.alters[n] > 0), flats = names.filter(n => it.alters[n] < 0);
        let fifths = sharps.length - flats.length;
        if (sharps.length && flats.length) warn('올림표와 내림표가 섞인 조표는 가장 가까운 조표로 바꿨습니다');
        fifths = Math.max(-7, Math.min(7, fifths));
        const mode = it.tonic && it.tonic === minorTonic(fifths) && it.tonic !== majorTonic(fifths) ? 'minor' : 'major';
        (cur.timed ? (cur.after || (cur.after = {})) : cur).keySig = { fifths, mode };
        break;
      }
      case 'TimeSig': {
        const ts = { num: it.num, den: it.den, display: it.style === 'Common' ? 'common' : it.style === 'AllaBreve' ? 'cut' : 'normal' };
        (cur.timed ? (cur.after || (cur.after = {})) : cur).timeSig = ts;
        break;
      }
      case 'Bar': {
        flushTexts(cur);
        if (S.pendingFermata && cur.timed && S.lastEv) { S.lastEv.fermata = 'above'; S.pendingFermata = false; }
        if (it.sysBreak) cur.sysBreak = true;
        if (!cur.timed) {
          // two bar lines in a row: NWC draws both, a measure it is not
          const prev = prevMeasure();
          if (OPEN_BARS.has(it.style)) cur.leftBar = it.style;
          else if (prev) { if (prev.bar === 'Single' || it.style !== 'Single') prev.bar = it.style; if (it.repeat) prev.repeat = it.repeat; if (it.sysBreak) prev.sysBreak = true; cur.sysBreak = false; }
          break;
        }
        const repeat = it.repeat;
        if (OPEN_BARS.has(it.style)) { closeMeasure('Single'); cur.leftBar = it.style; }
        else { const m = cur; closeMeasure(it.style); if (repeat) m.repeat = repeat; }
        break;
      }
      case 'RestMultiBar': {
        for (let k = 0; k < it.numBars; k++) {
          if (k > 0 || cur.timed) closeMeasure('Single');
          const r = makeRest('whole', 0); r.fullMeasureRest = true;
          cur.main.push(r); cur.timed++; cur.full = true; sawTimed = true;
        }
        if (it.numBars > 1) warn('여러 마디 쉼표는 마디마다 온쉼표로 풀었습니다');
        break;
      }
      case 'Ending':
        out.endings.push({ atEnd: cur.timed > 0, mi: out.measures.length, endings: it.endings || [], default: !!it.default, closed: !!it.closed });
        break;
      case 'Flow': {
        const mk = FLOW_MARKER[it.style]; if (!mk) break;
        const target = mk === 'segno' || mk === 'coda';
        // "D.S. al Coda" typed after the bar line still belongs to the bar that just ended;
        // a segno or coda sign typed before the bar line marks the bar that follows.
        if (target) { if (cur.timed) (cur.after || (cur.after = {})).markers = [...((cur.after && cur.after.markers) || []), mk]; else cur.markers.push(mk); }
        else if (!cur.timed && prevMeasure()) prevMeasure().markers.push(mk);
        else cur.markers.push(mk);
        break;
      }
      case 'Tempo': {
        const [unit, dots] = TEMPO_UNIT[it.base] || TEMPO_UNIT.Quarter;
        const tempo = { bpm: it.bpm > 0 ? it.bpm : 120, beatUnit: unit, dots, text: it.text || '', showBpm: it.visibility !== 'Never' };
        if (!cur.tempo) cur.tempo = tempo;
        else if (cur.timed) (cur.after || (cur.after = {})).tempoLater = tempo;
        else cur.tempo = tempo;
        break;
      }
      case 'Dynamic': if (it.visibility !== 'Never') S.pendingDynamic = it.style; break;
      case 'DynamicVariance':
        if (it.visibility === 'Never') break;
        if (it.style === 'Sforzando') S.pendingDynamic = 'sfz';
        else if (it.style === 'Rinforzando') S.pendingDynamic = 'rfz';
        else pushText(DYN_VAR_TEXT[it.style], it.pos != null ? it.pos : -8, 'expression');
        break;
      case 'TempoVariance':
        if (it.style === 'Fermata') {
          // NWC users put the sign in front of the note it belongs to (placement "at next note");
          // at the end of a bar it can only mean the note before it.
          S.pendingFermata = true;
        } else if (it.style === 'Breath Mark') { if (S.lastNote) (S.lastNote.texts || (S.lastNote.texts = [])).push({ text: ',', placement: 'above', style: 'plain' }); }
        else if (it.style === 'Caesura') { if (S.lastNote) (S.lastNote.texts || (S.lastNote.texts = [])).push({ text: '//', placement: 'above', style: 'plain' }); }
        else if (it.visibility !== 'Never') pushText(TEMPO_VAR_TEXT[it.style], it.pos != null ? it.pos : 8, 'expression');
        break;
      case 'PerformanceStyle':
        if (it.visibility !== 'Never' && it.style) pushText(it.style.toLowerCase(), it.pos != null ? it.pos : 8, 'expression');
        break;
      case 'SustainPedal':
        if (it.released) {
          if (S.pedalFrom && S.lastEv) out.spanners.push({ id: newId(), type: 'pedal', from: { eventId: S.pedalFrom.id }, to: { eventId: S.lastEv.id } });
          S.pedalFrom = null; S.pedalPending = false;
        } else {
          if (S.pedalFrom && S.lastEv && S.pedalFrom !== S.lastEv) out.spanners.push({ id: newId(), type: 'pedal', from: { eventId: S.pedalFrom.id }, to: { eventId: S.lastEv.id } });
          S.pedalFrom = null; S.pedalPending = true;
        }
        break;
      case 'Instrument':
        if (!sawTimed) { if (it.patch != null) out.patch = it.patch; if (it.trans != null) out.trans = it.trans; }
        break;
      case 'Boundary':
        if (it.style === 'NewSystem') { const m = cur.timed ? cur : prevMeasure(); if (m) { if (it.newPage) m.pageBreak = true; else m.sysBreak = true; } }
        break;
      case 'User': {
        // NWC 2.75 chord-symbol plugin
        if (/^ChordPlay/i.test(it.userType || '') && it.props && it.props.Name) {
          const c = parseChordName(it.props.Name);
          cur.chords.push({ tick: cur.tick, list: [c || { text: it.props.Name }] });
          ctx.hasChordPlugin = true;
        }
        break;
      }
      case 'Text': {
        if (it.visibility === 'Never') break;
        const font = fonts.get(it.font);
        if (it.font === 'StaffSymbols' || it.font === 'StaffCueSymbols' || (font && SYMBOL_FONT_RE.test(font.typeface || ''))) break;
        const text = String(it.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
        if (!text) break;
        const chords = (it.pos == null || it.pos >= 0) ? parseChordText(text) : null;
        if (chords && ctx.chordMode && (ctx.chordMode === 'all' || chords.some(c => !c.weak))) { cur.chords.push({ tick: cur.tick, list: chords }); break; }
        const reh = /^\[([^\[\]\s]{1,4})\]$/.exec(text);
        if (reh && !cur.timed && (it.pos == null || it.pos >= 0)) { cur.rehearsalMark = reh[1]; break; }
        pushText(text.replace(/\s*\n\s*/g, ' / '), it.pos, textStyle(it.font));
        break;
      }
      case 'Note': case 'Chord': case 'Rest': case 'RestChord': {
        // a fermata typed after its note (no placement option): the note in front of it gets the sign
        addTimed(it);
        break;
      }
      default: break;                                     // Spacer, MPC, Marker, unknown objects
    }
  }
  // ---- end of the staff
  flushTexts(cur);
  if (S.pendingFermata && S.lastEv) S.lastEv.fermata = 'above';
  if (S.slur && S.lastNote && S.slur.from !== S.lastNote) out.spanners.push({ id: newId(), type: 'slur', from: { eventId: S.slur.from.id }, to: { eventId: S.lastNote.id } });
  if (S.hairpin && S.hairpin.last !== S.hairpin.from) out.spanners.push({ id: newId(), type: S.hairpin.type, from: { eventId: S.hairpin.from.id }, to: { eventId: S.hairpin.last.id } });
  if (S.pedalFrom && S.lastEv) out.spanners.push({ id: newId(), type: 'pedal', from: { eventId: S.pedalFrom.id }, to: { eventId: S.lastEv.id } });
  const END_BAR = { 'Section Close': 'SectionClose', 'Master Repeat Close': 'MasterRepeatClose', Single: 'Single', Double: 'Double', 'Open (hidden)': 'Transparent' };
  if (cur.timed) { cur.bar = END_BAR[st.endingBar] || 'SectionClose'; cur.endBar = true; out.measures.push(cur); }
  else {
    const prev = prevMeasure();
    if (prev) {
      prev.markers.push(...cur.markers); prev.texts.push(...cur.texts);
      if (prev.bar === 'Single') prev.bar = END_BAR[st.endingBar] || 'SectionClose';
      prev.endBar = true;
    } else out.measures.push(cur);
  }
  return out;
}
// letter of the tonic for a key signature (the tonic's own accidental does not matter here)
const majorTonic = (fifths) => (fifths >= 0 ? 'CGDAEBFC'[fifths] : 'CFBEADGC'[-fifths]);
const minorTonic = (fifths) => (fifths >= 0 ? 'AEBFCGDA'[fifths] : 'ADGCFBEA'[-fifths]);

// ---------------------------------------------------------------------------------------------
// Whole document
// ---------------------------------------------------------------------------------------------
function guessInstrument(st, staff, patch) {
  const n = `${st.name || ''} ${st.label || ''} ${st.group || ''}`.toLowerCase();
  if (staff.percussion) return 'drumset';
  const table = [
    [/piano|피아노|klavier|pf\b/, 'piano'], [/organ|오르간|keyboard|키보드|반주/, 'keyboard'],
    [/sop|alto|ten|bass(?!oon)|bari|voice|vocal|choir|chorus|melody|lead|solo|소프라노|알토|테너|베이스|바리톤|보컬|합창|노래|멜로디|성가|여성|남성/, 'voice'],
    [/violin|바이올린/, 'violin'], [/viola|비올라/, 'viola'], [/cello|첼로/, 'cello'], [/flute|플루트|플룻/, 'flute'], [/clarinet|클라리넷/, 'clarinet'],
    [/sax|색소폰/, 'saxophone'], [/trumpet|트럼펫/, 'trumpet'], [/recorder|리코더/, 'recorder'], [/guitar|기타/, 'guitar'],
  ];
  if (staff.lyricVerses) return 'voice';
  for (const [re, id] of table) if (re.test(n)) return id;
  if (patch != null) {
    const hit = Object.entries(INSTRUMENTS).find(([k, d]) => d.program === patch && d.type === 'standard' && k !== 'guitar-tab' && d.staves.length === 1);
    if (hit) return hit[0];
    if (patch >= 52 && patch <= 54) return 'voice';
  }
  return 'melody';
}

/**
 * @param doc       NWC document from parseNwctxt / parseNwcBinary
 * @param warnings  Set collecting Korean messages about approximations
 * @returns ScoreDoc
 */
export function nwcToScore(doc, warnings = new Set()) {
  const warn = (w) => warnings.add(w);
  let staves = (doc.staves || []).filter(s => s.items);
  if (!staves.length) throw new Error('NWC 파일에 보표가 없습니다');
  const visible = staves.filter(s => s.visible !== false);
  if (visible.length && visible.length < staves.length) {
    warn(`숨겨진 보표 ${staves.length - visible.length}개는 가져오지 않았습니다`);
    staves = visible;
  }
  const fonts = new Map((doc.fonts || []).map(f => [f.style, f]));

  // Chord names are plain text objects in NWC. A name with a quality or accidental ("Am7", "Bb")
  // can be nothing else; bare capital letters are also rehearsal letters or other marks, so they
  // only count when the file has such a name, or at least three different letters that do not
  // simply run A, B, C… down a staff.
  let strong = 0, weak = 0; const roots = new Set(); let alphabet = true;
  for (const st of staves) {
    let expect = 0;
    for (const it of st.items) {
      if (it.type !== 'Text' || it.visibility === 'Never' || (it.pos != null && it.pos < 0)) continue;
      const list = parseChordText(String(it.text || '').trim());
      if (!list) continue;
      for (const c of list) {
        if (c.weak) { weak++; if (c.root === 'ABCDEFG'[expect]) expect++; else alphabet = false; } else strong++;
        if (c.root) roots.add(c.root);
      }
    }
  }
  const ctx = { warn, fonts, chordMode: strong >= 1 || (weak >= 3 && roots.size >= 3 && !alphabet) ? 'all' : null };

  const parsed = staves.map(st => interpretStaff(st, ctx));

  // ---- layer groups → JSE staves; brace → multi-staff parts
  const layering = !(doc.page && doc.page.allowLayering === false);
  const groups = [];                                  // [{ members:[staffIndex…] }]
  for (let i = 0; i < staves.length; i++) {
    const prev = groups[groups.length - 1];
    const prevStaff = staves[i - 1];
    if (prev && prevStaff && prevStaff.withNext && prevStaff.withNext.layer && layering && prev.members.length < 4) prev.members.push(i);
    else groups.push({ members: [i] });
  }
  const parts = []; const groupPart = [];
  for (let g = 0; g < groups.length; g++) {
    const first = staves[groups[g].members[0]], pFirst = parsed[groups[g].members[0]];
    const prevGroup = groups[g - 1];
    const lastOfPrev = prevGroup ? staves[prevGroup.members[prevGroup.members.length - 1]] : null;
    const braced = lastOfPrev && lastOfPrev.withNext && lastOfPrev.withNext.brace && parts.length && parts[parts.length - 1].staves.length < 2;
    const anyPerc = groups[g].members.some(i => parsed[i].percussion);
    const staff = { id: newId(), type: anyPerc ? 'percussion' : 'standard', lines: anyPerc && first.lines === 1 ? 1 : 5, clef: anyPerc ? 'percussion' : (pFirst.initialClef || 'treble') };
    if (anyPerc) staff.drumMap = {};
    if (braced) { parts[parts.length - 1].staves.push(staff); parts[parts.length - 1]._members.push(...groups[g].members); groupPart.push(parts.length - 1); continue; }
    const patch = pFirst.patch != null ? pFirst.patch : first.instrument && first.instrument.patch;
    const instrument = guessInstrument(first, { percussion: anyPerc, lyricVerses: groups[g].members.reduce((n, i) => n + parsed[i].lyricVerses, 0) }, patch);
    const part = createPart(instrument);
    // the printed label names the part; staves layered onto it usually have none
    const labels = groups[g].members.map(i => staves[i].label).filter(Boolean);
    const names = labels.length ? labels : groups[g].members.map(i => staves[i].name).filter(Boolean);
    part.name = [...new Set(names)].join(' / ') || part.name;
    const abbr = groups[g].members.map(i => staves[i].labelAbbr).filter(Boolean);
    part.abbreviation = abbr.length ? [...new Set(abbr)].join('/') : (part.name.length <= 6 ? part.name : part.name.slice(0, 4) + '.');
    if (patch != null && !anyPerc) part.midiProgram = patch & 127;
    const trans = pFirst.trans != null ? pFirst.trans : first.instrument && first.instrument.trans;
    part.transposeChromatic = trans || 0;
    if (anyPerc || first.channel === 10) part.midiChannel = 9;
    if (first.volume != null && first.volume < 127) part.volume = Math.round(first.volume / 127 * 100) / 100;
    part.staves = [staff];
    part._members = [...groups[g].members];
    parts.push(part); groupPart.push(parts.length - 1);
  }
  for (const p of parts) { if (p.staves.length > 1 && p.instrument !== 'piano') { p.instrument = 'piano'; } }

  const score = createScore({ title: '', instruments: [], measures: 0, tempo: 0 });
  score.parts = parts; score.measures = []; score.spanners = [];
  const info = doc.info || {};
  score.meta.title = (info.title || '').trim();
  score.meta.composer = (info.author || '').trim();
  score.meta.lyricist = (info.lyricist || '').trim();
  score.meta.copyright = [info.copyright1, info.copyright2].map(s => (s || '').trim()).filter(Boolean).join(' ');
  applyPage(doc, score);

  // ---- measures
  const count = Math.max(1, ...parsed.map(p => p.measures.length));
  const nStaves = groups.length;
  let ts = { num: 4, den: 4, display: 'normal' };
  let nominal = ts;                                   // time signature the file asks for
  const first = (mi, f) => { for (const p of parsed) { const m = p.measures[mi]; if (m) { const v = f(m, p); if (v != null && v !== false) return v; } } return null; };
  const carry = { timeSig: null, keySig: null, tempo: null, markers: [], clef: new Map() };
  for (let mi = 0; mi < count; mi++) {
    const measure = { id: newId(), staves: [] };
    const newTs = carry.timeSig || first(mi, m => m.timeSig);
    const newKey = carry.keySig || first(mi, m => m.keySig);
    carry.timeSig = first(mi, m => m.after && m.after.timeSig); carry.keySig = first(mi, m => m.after && m.after.keySig);
    if (newTs) { nominal = newTs; }
    const cap = measureCapacity(nominal);
    // A staff that runs X over the bar while its next bar is X short, next to staves that keep
    // time: its last note hangs over the bar line (layered staves that hold a second voice).
    // The next bar of that staff then starts X later.
    const fits = parsed.some(p => { const m = p.measures[mi]; return m && !m.full && !m.lone && m.tick > 0 && m.tick <= cap + 1; });
    if (fits) for (const p of parsed) {
      const m = p.measures[mi], nx = p.measures[mi + 1];
      if (!m || m.full || m.lone || m.tick <= cap + 1 || !nx || nx.full || nx.lone) continue;
      const x = m.tick - cap;
      if (!(nx.tick > 0) || nx.tick + x > cap + 1) continue;
      m.hang = x;
      const pad = ticksToDurations(x).map((d) => { const r = makeRest(d.base, d.dots); r.hidden = true; return r; });
      nx.main.unshift(...pad); nx.tick += x; nx.timed += pad.length;
      for (const e of nx.extra) e.tick += x;
      for (const c of nx.chords) c.tick += x;
    }
    // real length of this bar: the longest staff decides
    let actual = 0, full = false;
    for (const p of parsed) { const m = p.measures[mi]; if (!m) continue; if (m.full || m.lone) full = true; else actual = Math.max(actual, m.tick - (m.hang || 0)); }
    let use = nominal;
    if (actual > cap + 1) {
      // longer than the time signature allows (free rhythm, forgotten bar line): show the real meter
      const fit = fitTimeSig(actual, nominal.den);
      if (fit) { use = fit; warn('박자표보다 긴 마디는 실제 길이에 맞는 박자표로 표시했습니다'); }
    } else if (actual > 0 && actual < cap - 1) measure.pickup = true;
    const tsKey = (t) => `${t.num}/${t.den}/${t.display || 'normal'}`;
    if (mi === 0 || tsKey(use) !== tsKey(ts)) { measure.timeSig = { ...use }; ts = use; }
    if (newKey || mi === 0) measure.keySig = newKey ? { ...newKey } : { fifths: 0, mode: 'major' };
    const tempo = first(mi, m => m.tempo) || carry.tempo;
    carry.tempo = first(mi, m => m.after && m.after.tempoLater);
    if (tempo) measure.tempo = tempo;
    for (const p of parsed) { const m = p.measures[mi]; if (m && m.lone) m.lone.fullMeasureRest = true; }
    // bar lines
    const bar = first(mi, m => (m.bar && m.bar !== 'Single' ? m.bar : null)) || 'Single';
    const RIGHT = { Double: 'double', BrokenSingle: 'dashed', BrokenDouble: 'dashed', SectionClose: 'final', MasterRepeatClose: 'repeat-end', LocalRepeatClose: 'repeat-end', Transparent: 'none' };
    if (RIGHT[bar]) measure.barlineRight = RIGHT[bar];
    if (bar === 'LocalRepeatClose') { const n = first(mi, m => m.repeat); if (n > 2) measure.repeatCount = n; }
    const left = first(mi, m => m.leftBar);
    if (left === 'MasterRepeatOpen' || left === 'LocalRepeatOpen') measure.barlineLeft = 'repeat-start';
    else if (left === 'SectionOpen') measure.barlineLeft = 'double';
    // markers, rehearsal marks, breaks
    const markers = [...carry.markers];
    for (const p of parsed) { const m = p.measures[mi]; if (m) for (const mk of m.markers) if (!markers.includes(mk)) markers.push(mk); }
    carry.markers = [];
    for (const p of parsed) { const m = p.measures[mi]; if (m && m.after && m.after.markers) for (const mk of m.after.markers) if (!carry.markers.includes(mk)) carry.markers.push(mk); }
    if (markers.length) measure.markers = markers;
    const reh = first(mi, m => m.rehearsalMark);
    if (reh) measure.rehearsalMark = reh;
    const top = parsed[0].measures[mi];
    if (top && (top.sysBreak || top.pageBreak) && mi < count - 1) measure.breaks = top.pageBreak ? { page: true } : { system: true };

    // ---- staves and voices
    for (let g = 0; g < nStaves; g++) {
      const members = groups[g].members;
      const sm = { voices: [] };
      const mains = [], extras = [];
      members.forEach((si, k) => {
        const p = parsed[si]; const m = p.measures[mi];
        if (!m) { mains.push([]); return; }
        // a layered staff that only holds hidden rests here is filler that keeps it in step
        if (k > 0 && !m.extra.length && m.main.every(ev => ev.kind === 'rest' && ev.hidden && !ev.lyrics && !ev.texts && !ev.fermata)) { mains.push([]); return; }
        if (m.clef && !sm.clef) sm.clef = m.clef;
        const key = `${g}`;
        if (carry.clef.get(key) && !sm.clef) sm.clef = carry.clef.get(key);
        mains.push(m.main);
        if (m.extra.length) extras.push(buildExtraVoices(m, warn));
        for (const t of m.texts) (measure.texts || (measure.texts = [])).push(g ? { ...t, staffIndex: g } : t);
        for (const c of m.chords) addChords(measure, c, m.tick || cap);
      });
      const nextClef = members.map(si => parsed[si].measures[mi] && parsed[si].measures[mi].clefAfter).find(Boolean);
      carry.clef.set(`${g}`, nextClef || null);
      if (members.length === 1 && extras.length) {
        // one staff with split-stem chords: the group with stems up is the upper voice
        const ex = extras[0];
        const upper = ex.list.filter(x => x.upper).length * 2 > ex.list.length;
        if (upper) {
          // voice 1 must fill the bar: pad behind the last long note with hidden rests
          const len = parsed[members[0]].measures[mi].tick;
          const have = ex.voices[0].reduce((n, ev) => n + durTicks(ev), 0);
          if (have < len - 1) for (const d of ticksToDurations(len - have)) { const r = makeRest(d.base, d.dots); r.hidden = true; ex.voices[0].push(r); }
          sm.voices = [ex.voices[0], mains[0], ...ex.voices.slice(1)];
        } else sm.voices = [mains[0], ...ex.voices];
      } else {
        sm.voices = [...mains];
        for (const ex of extras) sm.voices.push(...ex.voices);
      }
      if (sm.voices.length > 4) { sm.voices.length = 4; warn('한 보표에 4개를 넘는 성부는 생략했습니다'); }
      while (sm.voices.length > 1 && !sm.voices[sm.voices.length - 1].length) sm.voices.pop();
      if (!sm.voices.length) sm.voices = [[]];
      measure.staves.push(sm);
    }
    score.measures.push(measure);
  }

  // clef changes on the first measure belong to the staff itself
  score.measures[0].staves.forEach((sm, g) => { if (sm.clef) { const { staff } = locate(score, g); if (staff.type === 'standard') staff.clef = sm.clef; delete sm.clef; } });
  // percussion staves keep their clef
  score.measures.forEach(m => m.staves.forEach((sm, g) => { if (sm.clef && locate(score, g).staff.type !== 'standard') delete sm.clef; }));

  // ---- spanners, special endings
  for (const p of parsed) score.spanners.push(...p.spanners);
  buildVoltas(score, parsed, count);

  finishNotes(score);
  for (const p of parts) delete p._members;

  // repeat-end directly followed by repeat-start is one sign
  score.measures.forEach((m, mi) => {
    const nxt = score.measures[mi + 1];
    if (m.barlineRight === 'repeat-end' && nxt && nxt.barlineLeft === 'repeat-start') { m.barlineRight = 'repeat-both'; delete nxt.barlineLeft; }
    if (m.chords) m.chords.sort((a, b) => a.tick - b.tick);
  });
  normalizeImported(score);
  validateScore(score, { repair: true });
  const valid = new Set(); score.measures.forEach(m => m.staves.forEach(sm => sm.voices.forEach(v => v.forEach(ev => valid.add(ev.id)))));
  score.spanners = score.spanners.filter(sp => sp.type === 'volta' || (valid.has(sp.from.eventId) && valid.has(sp.to.eventId)));
  return score;
}

function locate(score, g) {
  let k = 0;
  for (const part of score.parts) for (const staff of part.staves) { if (k === g) return { part, staff }; k++; }
  return { part: score.parts[0], staff: score.parts[0].staves[0] };
}

/** n/den with n·(whole/den) = ticks, trying the current denominator first. */
function fitTimeSig(ticks, den) {
  for (const d of [den, 4, 8, 16, 32, 64]) {
    const n = ticks * d / 3840;
    if (Math.abs(n - Math.round(n)) < 1e-6 && n >= 1 && n <= 64) return { num: Math.round(n), den: d, display: 'normal' };
  }
  return null;
}

/** Longer halves of split-stem chords → one or two extra voices, padded with hidden rests. */
function buildExtraVoices(m, warn) {
  const voices = [[]]; const ends = [0];
  const list = [...m.extra].sort((a, b) => a.tick - b.tick);
  for (const x of list) {
    let vi = ends.findIndex(e => e <= x.tick + 1);
    if (vi < 0) { if (voices.length >= 2) { warn('겹치는 음표 일부를 생략했습니다'); continue; } voices.push([]); ends.push(0); vi = voices.length - 1; }
    if (x.tick > ends[vi] + 1) for (const d of ticksToDurations(x.tick - ends[vi])) { const r = makeRest(d.base, d.dots); r.hidden = true; voices[vi].push(r); }
    voices[vi].push(x.ev);
    ends[vi] = Math.max(ends[vi], x.tick) + x.ticks;
  }
  return { voices, list };
}

/** Chord names of one text object; several names share the time up to the end of the bar. */
function addChords(measure, c, length) {
  const arr = measure.chords || (measure.chords = []);
  const n = c.list.length;
  c.list.forEach((ch, k) => {
    const span = Math.max(0, length - c.tick);
    const tick = Math.round((c.tick + (n > 1 ? span * k / n : 0)) / 240) * 240;
    const chord = { id: newId(), tick: Math.max(0, tick), text: ch.text };
    if (ch.root) chord.root = ch.root;
    if (ch.kind) chord.kind = ch.kind;
    if (ch.bass) chord.bass = ch.bass;
    if (!arr.some(x => x.tick === chord.tick && x.text === chord.text)) arr.push(chord);
  });
}

/** Special endings of the top staff that has any → volta spanners. */
function buildVoltas(score, parsed, count) {
  const src = parsed.find(p => p.endings.length);
  if (!src) return;
  const recs = src.endings.map(e => ({ ...e, mi: Math.min(count - 1, e.atEnd ? e.mi + 1 : e.mi) })).filter(e => e.mi < count);
  const special = (m) => !!m.barlineRight && m.barlineRight !== 'dashed' && m.barlineRight !== 'none';
  recs.forEach((e, k) => {
    if (!e.endings.length) return;                       // "D" (default) ending: no bracket, it only stops the one before
    const nextStart = recs[k + 1] ? recs[k + 1].mi : Infinity;
    let end = e.mi;
    for (let mi = e.mi; mi < Math.min(count, e.mi + 16, nextStart); mi++) { end = mi; if (special(score.measures[mi])) break; }
    if (end === Math.min(count, e.mi + 16) - 1 && !special(score.measures[end]) && nextStart === Infinity) end = e.mi;
    const ns = e.endings;
    const consecutive = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
    const label = ns.length > 1 && consecutive ? `${ns[0]}.-${ns[ns.length - 1]}.` : ns.map(n => n + '.').join(', ');
    const closed = e.closed || ['repeat-end', 'repeat-both'].includes(score.measures[end].barlineRight);
    score.spanners.push({ id: newId(), type: 'volta', from: { measureId: score.measures[e.mi].id }, to: { measureId: score.measures[end].id }, number: label, voltaType: closed ? 'closed' : 'open' });
  });
}

/** Drum mapping, forced accidentals (so the page shows what the NWC file showed), note order. */
function finishNotes(score) {
  let g = 0;
  for (const part of score.parts) for (const staff of part.staves) {
    const gi = g++;
    if (staff.type === 'percussion') {
      const trans = part.transposeChromatic || 0;
      const byKey = new Map();
      for (const m of score.measures) for (const v of m.staves[gi].voices) for (const ev of v) for (const n of ev.notes || []) {
        const pos = n._pos != null ? n._pos : 0;
        const midi = midiOf(n) + trans;
        const id = `${pos}:${midi}:${n.head || 'normal'}`;        // the same line with another accidental is another instrument
        let key = byKey.get(id);
        if (!key) {
          const std = Object.keys(DEFAULT_DRUM_MAP).find(k => DEFAULT_DRUM_MAP[k].midi === midi && !staff.drumMap[k]);
          key = std || `drum${midi}-${byKey.size + 1}`;
          staff.drumMap[key] = { line: staff.lines === 1 ? 4 : 4 - pos, head: n.head || 'normal', midi: Math.max(0, Math.min(127, midi)), name: std ? DEFAULT_DRUM_MAP[std].name : `타악기 ${midi}` };
          byKey.set(id, key);
        }
        n.drum = key;
        const shown = noteAtStaffPosition(4 - pos, 'treble');
        n.step = shown.step; n.octave = shown.octave; n.alter = 0;
        delete n.head; delete n._pos; delete n._acc;
      }
      part.transposeChromatic = 0;
      if (!Object.keys(staff.drumMap).length) staff.drumMap = JSON.parse(JSON.stringify(DEFAULT_DRUM_MAP));
      continue;
    }
    // Accidentals: JSE shows them by the usual rule (per octave, per bar, against the global key).
    // Where NWC shows one that JSE would leave out, or the other way round after a tie, force it.
    score.measures.forEach((m, mi) => {
      const key = keyAt(score, mi);
      const state = new Map(); const timeline = [];
      m.staves[gi].voices.forEach((v, vi) => { let t = 0; v.forEach((ev) => { timeline.push({ t, vi, ev }); t += durTicks(ev); }); });
      timeline.sort((a, b) => a.t - b.t || a.vi - b.vi);
      for (const { ev } of timeline) {
        if (ev.kind !== 'note') continue;
        ev.notes.sort((a, b) => midiOf(a) - midiOf(b) || STEP_NAMES.indexOf(a.step) - STEP_NAMES.indexOf(b.step));
        for (const n of ev.notes) {
          const k = n.step + n.octave;
          const current = state.has(k) ? state.get(k) : keyAlter(n.step, key);
          const auto = n.alter !== current;
          if (n._acc && !auto) n.accidental = ACC_NAME[n.alter];
          else if (!n._acc && auto && n.tieEnd) n.accidental = 'none';
          state.set(k, n.alter);
          delete n._acc; delete n._pos;
        }
      }
    });
  }
}
function keyAt(score, mi) { for (let i = mi; i >= 0; i--) if (score.measures[i].keySig) return score.measures[i].keySig.fifths; return 0; }

function applyPage(doc, score) {
  const page = doc.page || {}, s = score.settings;
  if (page.margins) {
    const mm = (cm) => Math.max(5, Math.min(40, Math.round(cm * 10)));
    s.marginsMm = { top: mm(page.margins.top), bottom: mm(page.margins.bottom), left: mm(page.margins.left), right: mm(page.margins.right) };
  }
  // NWC's staff size is the height of the five lines in points
  let sp = 1.75;
  if (page.staffSize > 0) { sp = Math.round(page.staffSize * 0.3528 / 4 * 100) / 100; sp = Math.max(1.0, Math.min(2.6, sp)); s.staffSpaceMm = sp; }
  s.measureNumbers = page.barNumbers && page.barNumbers !== 'None' ? 'system' : 'none';
  // Font table → text styles (sizes in staff spaces)
  const fonts = new Map((doc.fonts || []).map(f => [f.style, f]));
  const toStyle = (f) => {
    if (!f || !f.typeface) return null;
    const o = { family: f.typeface };
    if (f.size > 0) o.size = Math.round(f.size * 0.3528 / sp * 100) / 100;
    if (f.bold) o.bold = true;
    if (f.italic) o.italic = true;
    return o;
  };
  const styles = {};
  const map = { lyrics: 'StaffLyric', title: 'PageTitleText', composer: 'PageText', lyricist: 'PageText', text: 'StaffItalic', technique: 'StaffBold', copyright: 'PageSmallText' };
  for (const [k, style] of Object.entries(map)) { const f = fonts.get(style); if (f && !SYMBOL_FONT_RE.test(f.typeface || '')) { const o = toStyle(f); if (o) styles[k] = o; } }
  if (Object.keys(styles).length) s.textStyles = Object.assign({}, s.textStyles || {}, styles);
  const lf = fonts.get('StaffLyric');
  if (lf && lf.typeface && !/^times new roman$/i.test(lf.typeface) && !SYMBOL_FONT_RE.test(lf.typeface)) s.fonts = { ...(s.fonts || {}), lyrics: lf.typeface };
}
