// JSE data model helpers. Pure JS — runs in browser, worker and Node.
// See SPEC.md §2 for the ScoreDoc shape.

export const TPQ = 960;
export const DUR_TICKS = {
  breve: 7680, whole: 3840, half: 1920, quarter: 960, eighth: 480,
  '16th': 240, '32nd': 120, '64th': 60, '128th': 30,
};
export const DUR_BASES = Object.keys(DUR_TICKS);
export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Order of sharps / flats in key signatures
export const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
export const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

let idCounter = 0;
export function newId() {
  idCounter = (idCounter + 1) % 1296;
  const t = Date.now().toString(36).slice(-5);
  const r = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return t + r + idCounter.toString(36).padStart(1, '0');
}

export function durTicks(ev) {
  if (!ev || !ev.dur) return 0;
  let t = DUR_TICKS[ev.dur.base] || 0;
  const dots = ev.dur.dots || 0;
  if (dots === 1) t *= 1.5; else if (dots === 2) t *= 1.75; else if (dots === 3) t *= 1.875;
  if (ev.tuplet) t = t * ev.tuplet.den / ev.tuplet.num;
  if (ev.grace) return 0;
  return t;
}
export function baseTicks(base, dots = 0) { return durTicks({ dur: { base, dots } }); }
export function measureCapacity(timeSig) { return (timeSig.num * 3840) / timeSig.den; }
export function voiceTicks(voice) { return voice.reduce((s, e) => s + durTicks(e), 0); }

/** Returns a list of {base,dots} that sum to `ticks` (greedy, largest first). */
export function ticksToDurations(ticks) {
  const out = [];
  let rem = Math.round(ticks);
  const candidates = [];
  for (const base of DUR_BASES) for (const dots of [2, 1, 0]) candidates.push({ base, dots, t: baseTicks(base, dots) });
  candidates.sort((a, b) => b.t - a.t);
  let guard = 0;
  while (rem >= 30 && guard++ < 64) {
    const c = candidates.find(c => c.t <= rem + 1e-6);
    if (!c) break;
    out.push({ base: c.base, dots: c.dots });
    rem -= c.t;
  }
  return out;
}

// ---------- pitch ----------
export function midiOf(note) {
  return (note.octave + 1) * 12 + STEP_SEMITONE[note.step] + (note.alter || 0);
}
export function pitchName(note) {
  const acc = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[note.alter || 0] || '';
  return `${note.step}${acc}${note.octave}`;
}
export function parsePitchName(s) {
  const m = /^([A-Ga-g])(#{1,2}|b{1,2}|x)?(-?\d)$/.exec(s.trim());
  if (!m) return null;
  const alter = { '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[m[2]] || 0;
  return { step: m[1].toUpperCase(), octave: parseInt(m[3], 10), alter };
}
/** Spelling for a MIDI number given key signature (prefers key-signature accidentals). */
export function noteFromMidi(midi, keyFifths = 0) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const useFlats = keyFifths < 0;
  const sharpNames = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const flatNames = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  const [step, alter] = (useFlats ? flatNames : sharpNames)[pc];
  // octave correction for enharmonics is unnecessary with these spellings
  return { step, octave, alter };
}
/** Diatonic/chromatic-aware transposition keeping a sane spelling. */
export function transposeNote(note, semitones, keyFifths = 0) {
  if (!semitones) return { ...note };
  const midi = midiOf(note) + semitones;
  // diatonic step movement estimate
  const stepIdx = STEPS.indexOf(note.step);
  const diatonic = Math.round(semitones * 7 / 12);
  let newStepIdx = stepIdx + diatonic;
  let octave = note.octave + Math.floor(newStepIdx / 7);
  newStepIdx = ((newStepIdx % 7) + 7) % 7;
  const step = STEPS[newStepIdx];
  const natural = (octave + 1) * 12 + STEP_SEMITONE[step];
  let alter = midi - natural;
  if (alter > 2 || alter < -2 || (Math.abs(alter) === 2 && Math.abs(note.alter || 0) < 2)) return noteFromMidi(midi, keyFifths || (semitones < 0 ? -1 : 1));
  return { step, octave, alter };
}
/** Alteration implied by the key signature for a step. */
export function keyAlter(step, fifths) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}
export const KEY_NAMES = {
  '-7': 'C♭', '-6': 'G♭', '-5': 'D♭', '-4': 'A♭', '-3': 'E♭', '-2': 'B♭', '-1': 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F♯', 7: 'C♯',
};
export const KEY_NAMES_MINOR = {
  '-7': 'A♭m', '-6': 'E♭m', '-5': 'B♭m', '-4': 'Fm', '-3': 'Cm', '-2': 'Gm', '-1': 'Dm',
  0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F♯m', 4: 'C♯m', 5: 'G♯m', 6: 'D♯m', 7: 'A♯m',
};

// ---------- clefs & staff positions ----------
// Staff position: 0 = top line, +1 for each step downward (1 = first space, 8 = bottom line).
// CLEF_TOP_LINE gives {step, octave} of the top line of a 5-line staff.
export const CLEF_TOP_LINE = {
  treble: { step: 'F', octave: 5 }, treble8vb: { step: 'F', octave: 4 }, treble8va: { step: 'F', octave: 6 },
  bass: { step: 'A', octave: 3 }, bass8vb: { step: 'A', octave: 2 },
  alto: { step: 'G', octave: 4 }, tenor: { step: 'E', octave: 4 },
  percussion: { step: 'F', octave: 5 }, tab: { step: 'F', octave: 5 },
};
function diatonicIndex(step, octave) { return octave * 7 + STEPS.indexOf(step); }
export function staffPosition(note, clef = 'treble') {
  const top = CLEF_TOP_LINE[clef] || CLEF_TOP_LINE.treble;
  return diatonicIndex(top.step, top.octave) - diatonicIndex(note.step, note.octave);
}
export function noteAtStaffPosition(pos, clef = 'treble') {
  const top = CLEF_TOP_LINE[clef] || CLEF_TOP_LINE.treble;
  const idx = diatonicIndex(top.step, top.octave) - pos;
  const octave = Math.floor(idx / 7);
  const step = STEPS[((idx % 7) + 7) % 7];
  return { step, octave, alter: 0 };
}

// ---------- drums ----------
export const DEFAULT_DRUM_MAP = {
  'crash':        { line: -1, head: 'x', midi: 49, name: '크래시 심벌' },
  'ride':         { line: 0, head: 'x', midi: 51, name: '라이드 심벌' },
  'hihat-closed': { line: -1, head: 'x', midi: 42, name: '하이햇(닫힘)' },
  'hihat-open':   { line: -1, head: 'circle-x', midi: 46, name: '하이햇(열림)' },
  'tom-high':     { line: 1, head: 'normal', midi: 50, name: '하이 탐' },
  'tom-mid':      { line: 2, head: 'normal', midi: 47, name: '미드 탐' },
  'snare':        { line: 3, head: 'normal', midi: 38, name: '스네어' },
  'rimshot':      { line: 3, head: 'x', midi: 37, name: '림샷' },
  'tom-low':      { line: 4, head: 'normal', midi: 45, name: '로우 탐' },
  'floor-tom':    { line: 5, head: 'normal', midi: 41, name: '플로어 탐' },
  'kick':         { line: 7, head: 'normal', midi: 36, name: '킥(베이스 드럼)' },
  'hihat-pedal':  { line: 9, head: 'x', midi: 44, name: '하이햇 페달' },
  'cowbell':      { line: -2, head: 'triangle-black', midi: 56, name: '카우벨' },
  'ride-bell':    { line: 0, head: 'diamond-black', midi: 53, name: '라이드 벨' },
  'china':        { line: -2, head: 'x', midi: 52, name: '차이나 심벌' },
  'splash':       { line: -2, head: 'x', midi: 55, name: '스플래시' },
};

export const INSTRUMENTS = {
  piano:     { name: '피아노', abbr: 'Pno.', program: 0, staves: ['treble', 'bass'], type: 'standard' },
  keyboard:  { name: '키보드', abbr: 'Kbd.', program: 4, staves: ['treble'], type: 'standard' },
  voice:     { name: '보컬', abbr: 'Vo.', program: 52, staves: ['treble'], type: 'standard' },
  melody:    { name: '멜로디', abbr: 'Mel.', program: 73, staves: ['treble'], type: 'standard' },
  guitar:    { name: '기타', abbr: 'Gtr.', program: 24, staves: ['treble8vb'], type: 'standard' },
  'guitar-tab': { name: '기타 TAB', abbr: 'TAB', program: 24, staves: ['tab'], type: 'tab' },
  bass:      { name: '베이스', abbr: 'Bass', program: 33, staves: ['bass8vb'], type: 'standard' },
  violin:    { name: '바이올린', abbr: 'Vn.', program: 40, staves: ['treble'], type: 'standard' },
  viola:     { name: '비올라', abbr: 'Va.', program: 41, staves: ['alto'], type: 'standard' },
  cello:     { name: '첼로', abbr: 'Vc.', program: 42, staves: ['bass'], type: 'standard' },
  flute:     { name: '플루트', abbr: 'Fl.', program: 73, staves: ['treble'], type: 'standard' },
  clarinet:  { name: '클라리넷', abbr: 'Cl.', program: 71, staves: ['treble'], type: 'standard' },
  saxophone: { name: '색소폰', abbr: 'Sax.', program: 65, staves: ['treble'], type: 'standard' },
  trumpet:   { name: '트럼펫', abbr: 'Tpt.', program: 56, staves: ['treble'], type: 'standard' },
  recorder:  { name: '리코더', abbr: 'Rec.', program: 74, staves: ['treble'], type: 'standard' },
  ukulele:   { name: '우쿨렐레', abbr: 'Uke.', program: 24, staves: ['treble'], type: 'standard' },
  drumset:   { name: '드럼', abbr: 'Dr.', program: 0, channel: 9, staves: ['percussion'], type: 'percussion' },
  rhythm:    { name: '리듬', abbr: 'Rhy.', program: 0, channel: 9, staves: ['percussion'], type: 'percussion', lines: 1 },
};

// ---------- construction ----------
export function createStaff(clef = 'treble', type = 'standard') {
  const st = { id: newId(), type, lines: type === 'tab' ? 6 : 5, clef };
  if (type === 'percussion') { st.clef = 'percussion'; st.drumMap = JSON.parse(JSON.stringify(DEFAULT_DRUM_MAP)); }
  if (type === 'tab') { st.clef = 'tab'; st.tuning = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']; }
  return st;
}
export function createPart(instrument = 'piano', overrides = {}) {
  const def = INSTRUMENTS[instrument] || INSTRUMENTS.piano;
  const part = {
    id: newId(), name: def.name, abbreviation: def.abbr || def.name.slice(0, 2) + '.', instrument,
    midiProgram: def.program, transposeChromatic: 0,
    staves: def.staves.map(c => createStaff(c, def.type === 'tab' ? 'tab' : def.type === 'percussion' ? 'percussion' : 'standard')),
  };
  if (def.channel != null) part.midiChannel = def.channel;
  if (def.lines) part.staves.forEach(st => { st.lines = def.lines; if (st.type === 'percussion' && def.lines === 1) st.drumMap = { hit: { line: 4, head: 'normal', midi: 38, name: '타격' } }; });
  return Object.assign(part, overrides);
}
export function totalStaffCount(score) { return score.parts.reduce((n, p) => n + p.staves.length, 0); }
/** Flattened list of {part, staff, partIndex, staffIndex, globalIndex}. */
export function staffList(score) {
  const out = []; let g = 0;
  score.parts.forEach((part, pi) => part.staves.forEach((staff, si) => out.push({ part, staff, partIndex: pi, staffIndex: si, globalIndex: g++ })));
  return out;
}
export function createMeasure(score, opts = {}) {
  const n = totalStaffCount(score);
  const m = { id: newId(), staves: [] };
  for (let i = 0; i < n; i++) m.staves.push({ voices: [[]] });
  return Object.assign(m, opts);
}
export function createScore({ title = '제목 없음', composer = '', instruments = ['piano'], measures = 8, timeSig = { num: 4, den: 4 }, keyFifths = 0, tempo = 120 } = {}) {
  const now = new Date().toISOString();
  const score = {
    format: 'scoresnap', version: 1,
    meta: { title, subtitle: '', composer, lyricist: '', arranger: '', copyright: '', created: now, modified: now, appVersion: '1.0.0' },
    settings: {
      pageSize: 'A4', orientation: 'portrait', pageWidthMm: 210, pageHeightMm: 297,
      marginsMm: { top: 15, bottom: 15, left: 15, right: 15 },
      staffSpaceMm: 1.75, systemGapSp: 9, staffGapSp: 7, firstSystemIndentSp: 0,
      measureNumbers: 'system', concertPitch: true, fonts: { text: '', lyrics: '' },
    },
    parts: instruments.map(i => createPart(i)),
    measures: [], spanners: [], sources: [],
  };
  for (let i = 0; i < measures; i++) {
    const m = createMeasure(score);
    if (i === 0) { m.timeSig = { ...timeSig, display: 'normal' }; m.keySig = { fifths: keyFifths, mode: 'major' }; if (tempo) m.tempo = { bpm: tempo, beatUnit: 'quarter', dots: 0, text: '', showBpm: true }; }
    score.measures.push(m);
  }
  return score;
}
export function makeRest(base = 'quarter', dots = 0) { return { id: newId(), kind: 'rest', dur: { base, dots } }; }
export function makeNote(pitch, base = 'quarter', dots = 0) {
  const p = typeof pitch === 'string' ? parsePitchName(pitch) : pitch;
  return { id: newId(), kind: 'note', dur: { base, dots }, notes: [{ step: p.step, octave: p.octave, alter: p.alter || 0 }] };
}
/** Fill the remainder of a voice with rests so it reaches `capacity` ticks. */
export function padVoiceWithRests(voice, capacity) {
  const have = voiceTicks(voice);
  if (have >= capacity - 1e-6) return voice;
  for (const d of ticksToDurations(capacity - have)) voice.push(makeRest(d.base, d.dots));
  return voice;
}

// ---------- queries ----------
/** Effective time signature / key / clef at a measure index. */
export function effectiveTimeSig(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i].timeSig) return score.measures[i].timeSig;
  return { num: 4, den: 4, display: 'normal' };
}
export function effectiveKeySig(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i].keySig) return score.measures[i].keySig;
  return { fifths: 0, mode: 'major' };
}
export function effectiveClef(score, mi, staffIndex) {
  for (let i = mi; i >= 0; i--) { const c = score.measures[i].staves[staffIndex]?.clef; if (c) return c; }
  return staffList(score)[staffIndex]?.staff.clef || 'treble';
}
export function effectiveTempo(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i].tempo) return score.measures[i].tempo;
  return { bpm: 120, beatUnit: 'quarter', dots: 0 };
}
/** Iterate every event: cb(ev, {measure, mi, staffIndex, voiceIndex, index, tick}) */
export function forEachEvent(score, cb) {
  score.measures.forEach((m, mi) => m.staves.forEach((sm, si) => sm.voices.forEach((v, vi) => {
    let tick = 0;
    v.forEach((ev, ei) => { cb(ev, { measure: m, mi, staffIndex: si, voiceIndex: vi, index: ei, tick, voice: v }); tick += durTicks(ev); });
  })));
}
export function findEvent(score, id) {
  let found = null;
  forEachEvent(score, (ev, ctx) => { if (!found && ev.id === id) found = { ev, ...ctx }; });
  return found;
}
export function findMeasure(score, id) { const mi = score.measures.findIndex(m => m.id === id); return mi < 0 ? null : { measure: score.measures[mi], mi }; }

// ---------- validation / repair ----------
export function validateScore(score, { repair = false } = {}) {
  const errors = [];
  if (!score || score.format !== 'scoresnap') errors.push('format');
  if (!Array.isArray(score.parts) || !score.parts.length) errors.push('parts');
  if (!Array.isArray(score.measures)) errors.push('measures');
  if (errors.length) return { ok: false, errors };
  const n = totalStaffCount(score);
  if (!score.measures.length) { if (repair) score.measures.push(createMeasure(score)); else errors.push('no measures'); }
  if (score.measures[0] && !score.measures[0].timeSig) { if (repair) score.measures[0].timeSig = { num: 4, den: 4, display: 'normal' }; else errors.push('measure 0 lacks timeSig'); }
  if (score.measures[0] && !score.measures[0].keySig) { if (repair) score.measures[0].keySig = { fifths: 0, mode: 'major' }; else errors.push('measure 0 lacks keySig'); }
  const ids = new Set();
  score.measures.forEach((m, mi) => {
    if (!m.id) { if (repair) m.id = newId(); else errors.push(`measure ${mi} no id`); }
    if (!Array.isArray(m.staves)) { if (repair) m.staves = []; else errors.push(`measure ${mi} staves`); }
    while (repair && m.staves.length < n) m.staves.push({ voices: [[]] });
    if (repair && m.staves.length > n) m.staves.length = n;
    if (m.staves.length !== n) errors.push(`measure ${mi} has ${m.staves.length} staves, expected ${n}`);
    m.staves.forEach((sm, si) => {
      if (!Array.isArray(sm.voices) || !sm.voices.length) { if (repair) sm.voices = [[]]; else errors.push(`measure ${mi} staff ${si} voices`); }
      (sm.voices || []).forEach(v => v.forEach(ev => {
        if (!ev.id || ids.has(ev.id)) { if (repair) ev.id = newId(); else errors.push(`event id ${ev.id} invalid/duplicate`); }
        ids.add(ev.id);
        if (!DUR_TICKS[ev.dur?.base]) { if (repair) ev.dur = { base: 'quarter', dots: 0 }; else errors.push(`event ${ev.id} bad duration`); }
        if (ev.kind === 'note' && (!ev.notes || !ev.notes.length)) { if (repair) ev.kind = 'rest'; else errors.push(`note ${ev.id} without notes`); }
      }));
    });
  });
  if (!score.spanners) score.spanners = [];
  if (!score.sources) score.sources = [];
  if (!score.meta) score.meta = { title: '' };
  if (!score.settings) score.settings = createScore().settings;
  return { ok: errors.length === 0, errors };
}

export function cloneScore(score) {
  const sources = score.sources;
  const copy = JSON.parse(JSON.stringify({ ...score, sources: [] }));
  copy.sources = (sources || []).map(s => ({ ...s }));  // keep Blob references
  return copy;
}
