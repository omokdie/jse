// All mutations of a ScoreDoc live here so undo/redo and autosave stay consistent.
// Functions take the score and mutate it in place; the caller (app.js) wraps them in history.
import {
  newId, durTicks, measureCapacity, voiceTicks, ticksToDurations, makeRest, makeNote, padVoiceWithRests,
  effectiveTimeSig, effectiveKeySig, effectiveClef, staffList, totalStaffCount, createMeasure, createPart,
  findEvent, transposeNote, noteAtStaffPosition, staffPosition, midiOf, noteFromMidi, forEachEvent, keyAlter, DUR_TICKS, STEPS,
} from './score.js';

const EPS = 0.5;
const near = (a, b) => Math.abs(a - b) < EPS;

// ---------------------------------------------------------------------------
// Voice surgery
// ---------------------------------------------------------------------------
function expand(voice) {
  let t = 0; return voice.map(ev => { const o = { ev, start: t, end: t + (ev.grace ? 0 : durTicks(ev)) }; if (!ev.grace) t = o.end; return o; });
}
/** Split `ticks` starting at `onset` into note values aligned to the metric grid (beat-friendly). */
export function alignedDurations(onset, ticks) {
  const cands = [];
  for (const [base, t] of Object.entries(DUR_TICKS)) { cands.push({ base, dots: 1, t: t * 1.5 }); cands.push({ base, dots: 0, t }); }
  cands.sort((a, b) => b.t - a.t);
  const out = []; let t = onset, rem = ticks, guard = 0;
  while (rem >= 30 - EPS && guard++ < 64) {
    const mod = (a, b) => { const r = a % b; return Math.min(Math.abs(r), Math.abs(r - b)); };
    const aligned = cands.find(c => c.t <= rem + EPS && mod(t, c.dots ? DUR_TICKS[c.base] * 2 : c.t) < EPS);
    const c = aligned || cands.find(c => c.t <= rem + EPS);
    if (!c) break;
    out.push({ base: c.base, dots: c.dots }); t += c.t; rem -= c.t;
  }
  return out;
}
function piecesLike(ev, ticks, { tieFrom = false, tieTo = false, onset = 0 } = {}) {
  const durs = alignedDurations(onset, ticks);
  return durs.map((d, i) => {
    const copy = JSON.parse(JSON.stringify(ev));
    copy.id = newId(); copy.dur = { base: d.base, dots: d.dots }; delete copy.tuplet; delete copy.lyrics; delete copy.texts; delete copy.dynamic;
    if (i > 0) { delete copy.articulations; delete copy.grace; }
    if (copy.kind === 'note') copy.notes.forEach(n => {
      n.tieStart = (i < durs.length - 1) || (i === durs.length - 1 && tieTo) ? true : n.tieStart && i === durs.length - 1 ? n.tieStart : undefined;
      n.tieEnd = (i > 0) || (i === 0 && tieFrom) ? true : undefined;
      if (!n.tieStart) delete n.tieStart; if (!n.tieEnd) delete n.tieEnd;
    });
    if (i === 0 && ev.lyrics) copy.lyrics = JSON.parse(JSON.stringify(ev.lyrics));
    return copy;
  });
}
/** Groups of tuplet events are atomic: return [start,end] of the tuplet containing tick, else null. */
function tupletSpan(items, idx) {
  const id = items[idx].ev.tuplet?.id; if (!id) return null;
  let a = idx, b = idx;
  while (a > 0 && items[a - 1].ev.tuplet?.id === id) a--;
  while (b < items.length - 1 && items[b + 1].ev.tuplet?.id === id) b++;
  return [items[a].start, items[b].end];
}
/**
 * Replace the time range [start, start+len) of a voice with `newEvents` (whose total ticks should be len,
 * otherwise the remainder is filled with rests). Returns the new voice array.
 */
export function replaceRange(voice, start, len, newEvents) {
  const items = expand(voice);
  let end = start + len;
  // widen to tuplet boundaries
  items.forEach((it, i) => { if (it.end > start + EPS && it.start < end - EPS) { const sp = tupletSpan(items, i); if (sp) { start = Math.min(start, sp[0]); end = Math.max(end, sp[1]); } } });
  const out = [];
  let inserted = false;
  const insertNew = () => { if (!inserted) { inserted = true; out.push(...newEvents); const have = newEvents.reduce((a, e) => a + durTicks(e), 0); if (have < end - start - EPS) out.push(...alignedDurations(start + have, end - start - have).map(d => makeRest(d.base, d.dots))); } };
  for (const it of items) {
    if (it.ev.grace) { if (it.start < start - EPS || it.start >= end - EPS) out.push(it.ev); continue; }
    if (it.end <= start + EPS) { out.push(it.ev); continue; }
    if (it.start >= end - EPS) { insertNew(); out.push(it.ev); continue; }
    // overlapping
    if (it.start < start - EPS) out.push(...piecesLike(it.ev, start - it.start, { tieTo: it.ev.kind === 'note' && it.end > end + EPS, onset: it.start }));
    insertNew();
    if (it.end > end + EPS) out.push(...piecesLike(it.ev, it.end - end, { tieFrom: it.ev.kind === 'note' && it.start < start - EPS, onset: end }));
  }
  if (!inserted) {
    const total = items.length ? Math.max(...items.map(it => it.end)) : 0;
    if (start > total + EPS) out.push(...alignedDurations(total, start - total).map(d => makeRest(d.base, d.dots)));
  }
  insertNew();
  return out;
}
function normalizeVoice(voice, capacity) {
  // trim overflow
  const items = expand(voice); const out = [];
  for (const it of items) {
    if (it.ev.grace) { out.push(it.ev); continue; }
    if (it.start >= capacity - EPS) break;
    if (it.end > capacity + EPS) { out.push(...piecesLike(it.ev, capacity - it.start, { onset: it.start })); break; }
    out.push(it.ev);
  }
  padVoiceWithRests(out, capacity);
  // merge trailing rest fragments into bigger rests where simple
  return mergeRests(out);
}
function mergeRests(voice) {
  // merge consecutive plain rests when their sum is a single representable duration and they lie in one beat group
  const out = [];
  for (const ev of voice) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'rest' && ev.kind === 'rest' && !prev.tuplet && !ev.tuplet && !prev.fermata && !ev.fermata && !prev.fullMeasureRest && !prev.userRest && !ev.userRest) {
      const sum = durTicks(prev) + durTicks(ev);
      const d = ticksToDurations(sum);
      const startTick = voiceTicks(out.slice(0, -1));
      const beat = 960;
      if (d.length === 1 && Math.floor(startTick / beat) === Math.floor((startTick + sum - 1) / beat) || (d.length === 1 && startTick % sum === 0)) { prev.dur = d[0]; continue; }
    }
    out.push(ev);
  }
  return out;
}

function ensureVoice(sm, vi) { while (sm.voices.length <= vi) sm.voices.push([]); return sm.voices[vi]; }

// ---------------------------------------------------------------------------
// Note / rest input
// ---------------------------------------------------------------------------
/**
 * Enter a note or rest at a position (overwrite semantics like MuseScore).
 * opts: { mi, si, vi, tick, dur:{base,dots}, rest, pitch:{step,octave,alter}, drum, string, fret, accidental, addToChord, tieToPrev, tuplet }
 * Returns the id of the created event (or the chord event).
 */
export function inputEvent(score, opts) {
  const m = score.measures[opts.mi]; if (!m) return null;
  const sm = m.staves[opts.si];
  const voice = ensureVoice(sm, opts.vi || 0);
  const ts = effectiveTimeSig(score, opts.mi); const capacity = measureCapacity(ts);
  const staff = staffList(score)[opts.si].staff;
  let tick = Math.max(0, Math.min(opts.tick ?? 0, capacity));
  // snap tick to an existing event onset if close, else to nearest grid of the new duration's half
  const items = expand(voice);
  const hit = items.find(it => !it.ev.grace && it.start <= tick + EPS && it.end > tick + EPS);
  if (hit && !opts.exactTick) tick = hit.start;
  if (hit && hit.ev.tuplet && !opts.grace && !opts.addToChord && !opts.tuplet) {
    // entering into an existing tuplet fills its slot (keeps the tuplet)
    const old = hit.ev; const idx = voice.indexOf(old);
    const ne = opts.rest ? makeRest(old.dur.base, old.dur.dots) : Object.assign(makeRest(old.dur.base, old.dur.dots), { kind: 'note', notes: [makeNoteObj(opts, staff)] });
    ne.tuplet = { ...old.tuplet };
    if (old.lyrics) ne.lyrics = old.lyrics;
    voice[idx] = ne; sm.voices[opts.vi || 0] = voice;
    return ne.id;
  }
  if (opts.addToChord && hit && hit.ev.kind === 'note' && !opts.rest) {
    const n = makeNoteObj(opts, staff);
    if (!hit.ev.notes.some(x => x.step === n.step && x.octave === n.octave && (x.drum || null) === (n.drum || null) && (x.string || null) === (n.string || null))) hit.ev.notes.push(n);
    return hit.ev.id;
  }
  const base = opts.dur?.base || 'quarter', dots = opts.dur?.dots || 0;
  const ev = opts.rest ? makeRest(base, dots) : Object.assign(makeRest(base, dots), { kind: 'note', notes: [makeNoteObj(opts, staff)] });
  if (opts.rest) ev.userRest = true;   // explicitly entered rests keep their value (not merged with filler rests)
  if (opts.tuplet) ev.tuplet = { ...opts.tuplet };
  if (opts.grace) { ev.grace = { slash: true }; }
  let len = durTicks(ev);
  const created = ev.id;
  if (opts.grace) {
    // insert before the event at tick
    const idx = items.findIndex(it => !it.ev.grace && it.start >= tick - EPS);
    voice.splice(idx < 0 ? voice.length : idx, 0, ev);
    sm.voices[opts.vi || 0] = voice;
    return created;
  }
  if (hit && !opts.exactTick) {
    if (hit.ev.kind === 'note' || hit.ev.tuplet) tick = hit.start;
    else { const grid = Math.min(len, DUR_TICKS[base]); tick = hit.start + Math.floor((tick - hit.start + EPS) / grid) * grid; }
  }
  if (capacity - tick < 30) return null;
  placeEventAt(score, opts.si, opts.vi || 0, opts.mi, tick, ev);
  if (opts.tieToPrev && ev.kind === 'note') {
    const prev = prevEventOf(score, opts.si, opts.vi || 0, opts.mi, created);
    if (prev) toggleTie(score, [prev.id], true);
  }
  return created;
}
function prevEventOf(score, si, vi, mi, id) {
  const v = score.measures[mi].staves[si].voices[vi]; const i = v.findIndex(e => e.id === id);
  if (i > 0) return v[i - 1];
  for (let k = mi - 1; k >= 0; k--) { const vv = score.measures[k].staves[si]?.voices[vi]; if (vv?.length) return vv[vv.length - 1]; }
  return null;
}
/**
 * Place `ev` at (mi, tick) in voice (si, vi) with overwrite semantics, splitting across measures with ties.
 * Returns the cursor {mi, tick} just after the placed event.
 */
export function placeEventAt(score, si, vi, mi, tick, ev, { tieFrom = false } = {}) {
  for (let guard = 0; guard < 64; guard++) {
    if (mi >= score.measures.length) appendMeasures(score, 1);
    const m = score.measures[mi];
    const sm = m.staves[si]; const voice = ensureVoice(sm, vi);
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    const len = durTicks(ev);
    if (cap - tick < 30 - EPS) { mi++; tick = 0; continue; }
    if (tick + len <= cap + EPS) {
      const e = ev;
      if (tieFrom && e.kind === 'note') e.notes.forEach(n => { n.tieEnd = true; });
      sm.voices[vi] = normalizeVoice(replaceRange(voice, tick, len, [e]), cap);
      const after = tick + len;
      return after >= cap - EPS ? { mi: mi + 1, tick: 0 } : { mi, tick: after };
    }
    // split: head here (tied), tail in the following measure(s)
    const here = cap - tick;
    const hasNext = mi + 1 < score.measures.length || true;
    const head = piecesLike(ev, here, { tieTo: ev.kind === 'note' && hasNext, tieFrom: tieFrom && ev.kind === 'note', onset: tick });
    head[0].id = ev.id;
    sm.voices[vi] = normalizeVoice(replaceRange(voice, tick, here, head), cap);
    const tail = JSON.parse(JSON.stringify(ev)); tail.id = newId();
    delete tail.lyrics; delete tail.texts; delete tail.dynamic; delete tail.articulations; delete tail.grace;
    const rem = len - here;
    const durs = alignedDurations(0, rem);
    if (!durs.length) return { mi: mi + 1, tick: 0 };
    // tail may itself need several values: place them one by one (tied together for notes)
    let cur = { mi: mi + 1, tick: 0 };
    durs.forEach((d, i) => {
      const piece = JSON.parse(JSON.stringify(tail)); piece.id = i === 0 ? tail.id : newId(); piece.dur = { base: d.base, dots: d.dots };
      if (piece.kind === 'note') piece.notes.forEach(n => { n.tieEnd = true; if (i < durs.length - 1) n.tieStart = true; else delete n.tieStart; });
      cur = placeEventAt(score, si, vi, cur.mi, cur.tick, piece, { tieFrom: piece.kind === 'note' });
    });
    return cur;
  }
  return { mi, tick };
}
function makeNoteObj(opts, staff) {
  const n = { step: 'B', octave: 4, alter: 0 };
  if (opts.pitch) Object.assign(n, { step: opts.pitch.step, octave: opts.pitch.octave, alter: opts.pitch.alter || 0 });
  if (opts.accidental && opts.accidental !== 'auto') { n.accidental = opts.accidental === 'none' ? undefined : opts.accidental; const a = { sharp: 1, flat: -1, natural: 0, 'double-sharp': 2, 'double-flat': -2 }[opts.accidental]; if (a != null && opts.applyAccidental !== false) n.alter = a; }
  if (staff.type === 'percussion' && opts.drum) { n.drum = opts.drum; const dm = staff.drumMap?.[opts.drum]; if (dm) Object.assign(n, noteAtStaffPosition(dm.line, 'treble')); }
  if (staff.type === 'tab') { n.string = opts.string || 1; n.fret = opts.fret ?? 0; }
  if (opts.head) n.head = opts.head;
  return n;
}

/** Delete events: notes become rests of the same duration (rests stay). Removes lyrics etc. */
export function deleteEvents(score, ids) {
  const set = new Set(ids);
  score.measures.forEach((m, mi) => {
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach(sm => sm.voices.forEach((v, vi) => {
      let changed = false;
      for (let i = 0; i < v.length; i++) {
        const ev = v[i]; if (!set.has(ev.id)) continue;
        if (ev.grace) { v.splice(i, 1); i--; changed = true; continue; }
        if (ev.kind === 'note') { const r = makeRest(ev.dur.base, ev.dur.dots); r.id = ev.id; if (ev.tuplet) r.tuplet = ev.tuplet; v[i] = r; changed = true; }
        else if (ev.lyrics || ev.texts || ev.dynamic || ev.fermata) { delete ev.lyrics; delete ev.texts; delete ev.dynamic; delete ev.fermata; changed = true; }
      }
      if (changed) sm.voices[vi] = vi > 0 && v.every(e => e.kind === 'rest') ? [] : normalizeVoice(v, cap);
    }));
  });
  // remove dangling spanners
  const alive = new Set(); forEachEvent(score, ev => alive.add(ev.id));
  score.spanners = (score.spanners || []).filter(sp => !sp.from.eventId || (alive.has(sp.from.eventId) && (!sp.to?.eventId || alive.has(sp.to.eventId))) || sp.type === 'volta');
}

export function removeNoteFromChord(score, eventId, noteIndex) {
  const f = findEvent(score, eventId); if (!f || f.ev.kind !== 'note') return;
  if (f.ev.notes.length <= 1) { deleteEvents(score, [eventId]); return; }
  f.ev.notes.splice(noteIndex, 1);
}

export function setDuration(score, ids, base, dots = 0) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f) continue;
    const cap = measureCapacity(effectiveTimeSig(score, f.mi));
    const ev = JSON.parse(JSON.stringify(f.ev));
    ev.dur = { base, dots };
    if (ev.kind === 'note') ev.notes.forEach(n => { delete n.tieStart; });
    const len = Math.min(durTicks(ev), cap - f.tick);
    if (len < 30) continue;
    if (durTicks(ev) > len + EPS) { const ps = piecesLike(ev, len); ps[0].id = ev.id; f.voice.splice(0, f.voice.length, ...normalizeVoice(replaceRange(f.voice, f.tick, len, ps), cap)); }
    else f.voice.splice(0, f.voice.length, ...normalizeVoice(replaceRange(f.voice, f.tick, len, [ev]), cap));
  }
}
export function toggleDot(score, ids) {
  for (const id of ids) { const f = findEvent(score, id); if (!f) continue; setDuration(score, [id], f.ev.dur.base, f.ev.dur.dots ? 0 : 1); }
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
export function transposeEvents(score, ids, { semitones = 0, diatonic = 0, octaves = 0, byInterval = false } = {}) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    const staff = staffList(score)[f.staffIndex].staff;
    const key = effectiveKeySig(score, f.mi).fifths;
    const clef = effectiveClef(score, f.mi, f.staffIndex);
    f.ev.notes.forEach(n => {
      if (staff.type === 'percussion') {
        // move through the drum map lines
        const keys = Object.keys(staff.drumMap || {}).sort((a, b) => staff.drumMap[a].line - staff.drumMap[b].line);
        const idx = keys.indexOf(n.drum); const dir = (semitones || diatonic || octaves) > 0 ? -1 : 1;
        const ni = Math.max(0, Math.min(keys.length - 1, (idx < 0 ? 0 : idx) + dir));
        n.drum = keys[ni]; Object.assign(n, noteAtStaffPosition(staff.drumMap[n.drum].line, 'treble'));
        return;
      }
      if (staff.type === 'tab') {
        if (semitones) n.fret = Math.max(0, Math.min(24, (n.fret || 0) + semitones));
        if (diatonic) n.string = Math.max(1, Math.min((staff.tuning || []).length || 6, (n.string || 1) - diatonic));
        if (octaves) n.fret = Math.max(0, Math.min(24, (n.fret || 0) + 12 * octaves));
        return;
      }
      if (octaves) { n.octave += octaves; }
      if (semitones) {
        let t;
        if (byInterval) t = transposeNote(n, semitones, key);          // key change: keep interval spelling
        else {
          // arrow keys: diatonic notes use the key's spelling; black keys follow the direction of motion
          const midi = midiOf(n) + semitones;
          const preferFlat = semitones < 0 ? key <= 0 : key < 0;
          t = noteFromMidi(midi, key !== 0 ? key : (preferFlat ? -1 : 1));
          if (key !== 0 && t.alter !== 0 && keyAlter(t.step, key) !== t.alter) t = noteFromMidi(midi, preferFlat ? -1 : 1);
        }
        Object.assign(n, { step: t.step, octave: t.octave, alter: t.alter });
      }
      if (diatonic) {
        const pos = staffPosition(n, clef) - diatonic;
        const nn = noteAtStaffPosition(pos, clef);
        n.step = nn.step; n.octave = nn.octave; n.alter = keyAlter(n.step, key);
      }
      delete n.accidental;
    });
    f.ev.notes.sort((a, b) => midiOf(a) - midiOf(b));
  }
}
export function setAccidental(score, ids, acc) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    const key = effectiveKeySig(score, f.mi).fifths;
    const map = { sharp: 1, flat: -1, natural: 0, 'double-sharp': 2, 'double-flat': -2 };
    f.ev.notes.forEach(n => {
      if (acc === 'none' || acc == null) { delete n.accidental; return; }
      if (acc in map) {
        // toggle: same accidental again → back to key default
        if (n.alter === map[acc] && n.accidental === acc) { n.alter = keyAlter(n.step, key); delete n.accidental; }
        else { n.alter = map[acc]; n.accidental = acc; }
      }
    });
  }
}
export function respellEnharmonic(score, ids) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    f.ev.notes.forEach(n => {
      const midi = midiOf(n);
      const alt = n.alter > 0 ? noteFromMidi(midi, -1) : n.alter < 0 ? noteFromMidi(midi, 1) : noteFromMidi(midi, n.step === 'E' || n.step === 'B' ? 1 : -1);
      if (alt.step !== n.step) Object.assign(n, alt); delete n.accidental;
    });
  }
}

// ---------------------------------------------------------------------------
// Ties, articulations, text attachments
// ---------------------------------------------------------------------------
export function toggleTie(score, ids, forceOn = false) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    // find the next event in the voice
    let next = null;
    if (f.index + 1 < f.voice.length) next = f.voice[f.index + 1];
    else for (let k = f.mi + 1; k < score.measures.length && !next; k++) { const v = score.measures[k].staves[f.staffIndex]?.voices[f.voiceIndex]; if (v?.length) next = v[0]; }
    const anyTied = f.ev.notes.some(n => n.tieStart);
    f.ev.notes.forEach(n => {
      const target = next && next.kind === 'note' ? next.notes.find(x => x.step === n.step && x.octave === n.octave) : null;
      if (anyTied && !forceOn) { delete n.tieStart; if (target) delete target.tieEnd; }
      else if (target) { n.tieStart = true; target.tieEnd = true; }
      else if (next && next.kind === 'rest' && !forceOn) {
        // convert the following rest into a tied note of the same pitch
        next.kind = 'note'; next.notes = [{ step: n.step, octave: n.octave, alter: n.alter, tieEnd: true }]; n.tieStart = true;
      }
    });
  }
}
export function toggleArticulation(score, ids, art) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    const arr = f.ev.articulations || [];
    const i = arr.indexOf(art);
    if (i >= 0) arr.splice(i, 1); else arr.push(art);
    if (arr.length) f.ev.articulations = arr; else delete f.ev.articulations;
  }
}
export function toggleOrnament(score, ids, orn) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue;
    const arr = f.ev.ornaments || []; const i = arr.indexOf(orn);
    if (i >= 0) arr.splice(i, 1); else arr.push(orn);
    if (arr.length) f.ev.ornaments = arr; else delete f.ev.ornaments;
  }
}
export function setEventProp(score, ids, prop, value) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f) continue;
    if (value == null || value === '' || value === false) delete f.ev[prop]; else f.ev[prop] = value;
  }
}
export function setNoteProp(score, ids, prop, value) {
  for (const id of ids) { const f = findEvent(score, id); if (!f || f.ev.kind !== 'note') continue; f.ev.notes.forEach(n => { if (value == null || value === '' || value === 'normal') delete n[prop]; else n[prop] = value; }); }
}
export function setLyric(score, eventId, verse, text, syllabic) {
  const f = findEvent(score, eventId); if (!f) return;
  const ly = f.ev.lyrics || [];
  const idx = ly.findIndex(l => (l.verse || 1) === verse);
  if (!text) { if (idx >= 0) ly.splice(idx, 1); }
  else {
    const entry = { verse, text, syllabic: syllabic || 'single' };
    if (idx >= 0) ly[idx] = { ...ly[idx], ...entry }; else ly.push(entry);
  }
  if (ly.length) f.ev.lyrics = ly; else delete f.ev.lyrics;
}
/** Distribute a line of lyrics onto consecutive notes starting at eventId (Hangul: one syllable block per note; Latin: words/hyphenated syllables). */
export function distributeLyrics(score, eventId, line, verse = 1) {
  const f = findEvent(score, eventId); if (!f) return 0;
  const tokens = tokenizeLyrics(line);
  let count = 0; let cur = { mi: f.mi, index: f.index };
  const nextNote = () => {
    for (;;) {
      const v = score.measures[cur.mi]?.staves[f.staffIndex]?.voices[f.voiceIndex];
      if (!v) return null;
      if (cur.index < v.length) { const ev = v[cur.index++]; if (ev.kind === 'note' && !ev.grace && !ev.notes.every(n => n.tieEnd)) return ev; continue; }
      cur.mi++; cur.index = 0; if (cur.mi >= score.measures.length) return null;
    }
  };
  for (const tk of tokens) { const ev = nextNote(); if (!ev) break; setLyric(score, ev.id, verse, tk.text, tk.syllabic); count++; }
  return count;
}
export function tokenizeLyrics(line) {
  const out = [];
  for (const word of line.trim().split(/\s+/).filter(Boolean)) {
    const isHangul = /[ㄱ-힝]/.test(word);
    if (isHangul && !word.includes('-')) {
      const chars = [...word.replace(/_/g, '')];
      chars.forEach((ch) => out.push({ text: ch, syllabic: 'single' }));
      continue;
    }
    const syls = word.split('-');
    syls.forEach((sy, i) => {
      const ext = sy.endsWith('_'); const text = sy.replace(/_+$/, '');
      const syllabic = syls.length === 1 ? 'single' : i === 0 ? 'begin' : i === syls.length - 1 ? 'end' : 'middle';
      const tok = { text, syllabic }; if (ext) tok.extend = true; out.push(tok);
    });
  }
  return out;
}
export function setChordSymbol(score, mi, tick, text, extra = {}) {
  const m = score.measures[mi]; if (!m) return null;
  m.chords = m.chords || [];
  const idx = m.chords.findIndex(c => near(c.tick, tick));
  if (!text) { if (idx >= 0) m.chords.splice(idx, 1); if (!m.chords.length) delete m.chords; return null; }
  const parsed = parseChordText(text);
  const ch = { id: idx >= 0 ? m.chords[idx].id : newId(), tick, text: text.trim(), ...parsed, ...extra };
  if (idx >= 0) m.chords[idx] = ch; else { m.chords.push(ch); m.chords.sort((a, b) => a.tick - b.tick); }
  return ch.id;
}
export function parseChordText(text) {
  const m = /^([A-Ga-g])([#b♯♭]?)([^/]*)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(text.trim());
  if (!m) return {};
  const norm = s => s.replace('♯', '#').replace('♭', 'b');
  return { root: m[1].toUpperCase() + norm(m[2] || ''), kind: m[3] || '', bass: m[4] ? m[4][0].toUpperCase() + norm(m[4].slice(1)) : undefined };
}
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ROOTS_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export function transposeChordText(text, semitones, preferFlat = false) {
  const p = parseChordText(text); if (!p.root) return text;
  const idx = r => { const i = ROOTS.indexOf(r); return i >= 0 ? i : ROOTS_FLAT.indexOf(r); };
  const tr = r => { const i = idx(r); if (i < 0) return r; const j = ((i + semitones) % 12 + 12) % 12; return (preferFlat ? ROOTS_FLAT : ROOTS)[j]; };
  return tr(p.root) + (p.kind || '') + (p.bass ? '/' + tr(p.bass) : '');
}

// ---------------------------------------------------------------------------
// Tuplets, grace, voices
// ---------------------------------------------------------------------------
/** Turn the event into a tuplet of `num` notes in the time of `den` of the next smaller value. */
export function makeTuplet(score, eventId, num = 3, den = 2) {
  const f = findEvent(score, eventId); if (!f || f.ev.tuplet) return;
  const total = durTicks(f.ev);
  const unit = total / den;             // ticks of each tuplet member before ratio
  const bases = Object.entries(DUR_TICKS);
  let base = bases.find(([, t]) => Math.abs(t - unit) < 1)?.[0];
  let dots = 0;
  if (!base) { const dotted = bases.find(([, t]) => Math.abs(t * 1.5 - unit) < 1); if (dotted) { base = dotted[0]; dots = 1; } }
  if (!base) return;
  const id = newId();
  const first = JSON.parse(JSON.stringify(f.ev)); first.dur = { base, dots }; first.tuplet = { id, num, den, show: 'number' };
  if (first.kind === 'note') first.notes.forEach(n => delete n.tieStart);
  const members = [first];
  for (let i = 1; i < num; i++) { const r = makeRest(base, dots); r.tuplet = { id, num, den, show: 'number' }; members.push(r); }
  f.voice.splice(f.index, 1, ...members);
}
export function removeTuplet(score, eventId) {
  const f = findEvent(score, eventId); if (!f || !f.ev.tuplet) return;
  const id = f.ev.tuplet.id;
  const idxs = f.voice.map((e, i) => e.tuplet?.id === id ? i : -1).filter(i => i >= 0);
  const total = idxs.reduce((a, i) => a + durTicks(f.voice[i]), 0);
  const firstEv = f.voice[idxs[0]];
  const repl = piecesLike(firstEv, total); repl.forEach(e => delete e.tuplet);
  f.voice.splice(idxs[0], idxs.length, ...repl);
}
export function setVoiceOfEvents(score, ids, vi) {
  for (const id of ids) {
    const f = findEvent(score, id); if (!f || f.voiceIndex === vi || f.ev.kind !== 'note') continue;
    const m = score.measures[f.mi]; const sm = m.staves[f.staffIndex]; const cap = measureCapacity(effectiveTimeSig(score, f.mi));
    const target = ensureVoice(sm, vi);
    const copy = JSON.parse(JSON.stringify(f.ev));
    sm.voices[vi] = normalizeVoice(replaceRange(target, f.tick, durTicks(f.ev), [copy]), cap);
    const rest = makeRest(f.ev.dur.base, f.ev.dur.dots); if (f.ev.tuplet) rest.tuplet = f.ev.tuplet;
    f.voice[f.index] = rest;
    if (f.voiceIndex > 0 && f.voice.every(e => e.kind === 'rest')) sm.voices[f.voiceIndex] = [];
  }
}

// ---------------------------------------------------------------------------
// Spanners
// ---------------------------------------------------------------------------
export function addSpanner(score, type, fromId, toId, extra = {}) {
  const sp = { id: newId(), type, from: { eventId: fromId }, to: { eventId: toId || fromId }, ...extra };
  score.spanners = score.spanners || [];
  // toggle off if identical exists
  const same = score.spanners.findIndex(s => s.type === type && s.from.eventId === fromId && s.to?.eventId === (toId || fromId));
  if (same >= 0) { score.spanners.splice(same, 1); return null; }
  score.spanners.push(sp); return sp.id;
}
export function removeSpanner(score, id) { score.spanners = (score.spanners || []).filter(s => s.id !== id); }
export function setVolta(score, fromMi, toMi, number) {
  const from = score.measures[fromMi], to = score.measures[toMi] || from;
  score.spanners = (score.spanners || []).filter(s => !(s.type === 'volta' && s.from.measureId === from.id));
  if (number) score.spanners.push({ id: newId(), type: 'volta', from: { measureId: from.id }, to: { measureId: to.id }, number, voltaType: 'closed' });
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------
export function insertMeasures(score, atIndex, count = 1) {
  for (let i = 0; i < count; i++) {
    const m = createMeasure(score);
    score.measures.splice(atIndex + i, 0, m);
  }
  if (atIndex === 0 && count > 0) {
    // move the signature information to the new first measure
    const old = score.measures[count];
    const m0 = score.measures[0];
    m0.timeSig = old.timeSig; m0.keySig = old.keySig; m0.tempo = old.tempo;
    delete old.timeSig; delete old.keySig; delete old.tempo;
    old.staves.forEach((sm, si) => { if (sm.clef) { m0.staves[si].clef = sm.clef; delete sm.clef; } });
  }
}
export function appendMeasures(score, count = 1) { insertMeasures(score, score.measures.length, count); }
export function deleteMeasures(score, from, to) {
  if (score.measures.length <= (to - from + 1)) { // keep at least one
    const first = score.measures[0];
    first.staves.forEach(sm => { sm.voices = [[]]; }); delete first.chords; delete first.rehearsalMark; delete first.texts; delete first.markers;
    score.measures.length = 1; return;
  }
  const removed = score.measures.splice(from, to - from + 1);
  if (from === 0) { const m0 = score.measures[0]; const r0 = removed[0]; if (!m0.timeSig) m0.timeSig = r0.timeSig; if (!m0.keySig) m0.keySig = r0.keySig; if (!m0.tempo && r0.tempo) m0.tempo = r0.tempo; }
  const ids = new Set(removed.map(m => m.id));
  const removedEvents = new Set(); removed.forEach(m => m.staves.forEach(sm => sm.voices.forEach(v => v.forEach(e => removedEvents.add(e.id)))));
  score.spanners = (score.spanners || []).filter(sp => !(ids.has(sp.from.measureId) || ids.has(sp.to?.measureId) || removedEvents.has(sp.from.eventId) || removedEvents.has(sp.to?.eventId)));
}
export function setTimeSig(score, mi, ts) {
  const m = score.measures[mi];
  const prev = effectiveTimeSig(score, mi);
  if (mi > 0 && ts.num === prev.num && ts.den === prev.den && effectiveTimeSig(score, mi - 1).num === ts.num) { delete m.timeSig; }
  else m.timeSig = { num: ts.num, den: ts.den, display: ts.display || 'normal' };
  // re-normalize all affected measures until the next time signature
  for (let k = mi; k < score.measures.length; k++) {
    if (k > mi && score.measures[k].timeSig) break;
    const cap = measureCapacity(ts);
    score.measures[k].staves.forEach(sm => sm.voices.forEach((v, vi) => { if (v.length || vi === 0) sm.voices[vi] = v.length ? normalizeVoice(v, cap) : v; }));
  }
}
export function setKeySig(score, mi, fifths, mode = 'major') {
  const m = score.measures[mi];
  if (mi > 0 && effectiveKeySig(score, mi - 1).fifths === fifths) delete m.keySig; else m.keySig = { fifths, mode };
}
export function setClef(score, mi, si, clef) {
  const m = score.measures[mi];
  if (mi === 0) { staffList(score)[si].staff.clef = clef; delete m.staves[si].clef; return; }
  if (effectiveClef(score, mi - 1, si) === clef) delete m.staves[si].clef; else m.staves[si].clef = clef;
}
export function setTempo(score, mi, tempo) { const m = score.measures[mi]; if (!tempo) delete m.tempo; else m.tempo = { bpm: 120, beatUnit: 'quarter', dots: 0, text: '', showBpm: true, ...tempo }; }
export function setMeasureProp(score, mi, prop, value) { const m = score.measures[mi]; if (value == null || value === '' || value === false || value === 'single' && prop === 'barlineRight') delete m[prop]; else m[prop] = value; }
export function toggleBreak(score, mi, kind) { const m = score.measures[mi]; m.breaks = m.breaks || {}; m.breaks[kind] = !m.breaks[kind]; if (!m.breaks.system && !m.breaks.page) delete m.breaks; }
export function toggleMarker(score, mi, marker) { const m = score.measures[mi]; const arr = m.markers || []; const i = arr.indexOf(marker); if (i >= 0) arr.splice(i, 1); else arr.push(marker); if (arr.length) m.markers = arr; else delete m.markers; }
export function addMeasureText(score, mi, text, placement = 'above', style = 'plain', staffIndex = 0) {
  const m = score.measures[mi]; m.texts = m.texts || []; m.texts.push({ text, placement, style, staffIndex });
}
export function setMeasureText(score, mi, index, text) { const m = score.measures[mi]; if (!m.texts) return; if (!text) m.texts.splice(index, 1); else m.texts[index].text = text; if (!m.texts.length) delete m.texts; }
/** Repair: make every voice exactly fill its measure. Returns number of fixed measures. */
export function fixMeasures(score, indices = null) {
  let n = 0;
  score.measures.forEach((m, mi) => {
    if (indices && !indices.includes(mi)) return;
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    m.staves.forEach(sm => sm.voices.forEach((v, vi) => {
      if (!v.length) return;
      const have = voiceTicks(v);
      if (Math.abs(have - cap) > EPS) { sm.voices[vi] = normalizeVoice(v, cap); n++; }
    }));
  });
  return n;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------
export function addPart(score, instrument, atIndex = score.parts.length) {
  const part = createPart(instrument);
  const before = score.parts.slice(0, atIndex).reduce((a, p) => a + p.staves.length, 0);
  score.parts.splice(atIndex, 0, part);
  score.measures.forEach(m => { for (let i = 0; i < part.staves.length; i++) m.staves.splice(before + i, 0, { voices: [[]] }); });
  return part.id;
}
export function removePart(score, partId) {
  const idx = score.parts.findIndex(p => p.id === partId); if (idx < 0 || score.parts.length === 1) return;
  const before = score.parts.slice(0, idx).reduce((a, p) => a + p.staves.length, 0);
  const n = score.parts[idx].staves.length;
  const removedEvents = new Set();
  score.measures.forEach(m => { m.staves.splice(before, n).forEach(sm => sm.voices.forEach(v => v.forEach(e => removedEvents.add(e.id)))); });
  score.parts.splice(idx, 1);
  score.spanners = (score.spanners || []).filter(sp => !(removedEvents.has(sp.from.eventId) || removedEvents.has(sp.to?.eventId)));
}
export function movePart(score, partId, dir) {
  const idx = score.parts.findIndex(p => p.id === partId); const j = idx + dir;
  if (idx < 0 || j < 0 || j >= score.parts.length) return;
  const offs = []; let acc = 0; score.parts.forEach(p => { offs.push(acc); acc += p.staves.length; });
  const a = score.parts[idx], b = score.parts[j];
  score.measures.forEach(m => {
    const sa = m.staves.slice(offs[idx], offs[idx] + a.staves.length), sb = m.staves.slice(offs[j], offs[j] + b.staves.length);
    const lo = Math.min(idx, j), hi = Math.max(idx, j);
    const first = lo === idx ? sa : sb, second = lo === idx ? sb : sa;
    m.staves.splice(offs[lo], first.length + second.length, ...second, ...first);
  });
  [score.parts[idx], score.parts[j]] = [score.parts[j], score.parts[idx]];
}
export function setPartProp(score, partId, prop, value) { const p = score.parts.find(p => p.id === partId); if (p) p[prop] = value; }

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
/** Copy a range: measures [fromMi..toMi], staves [s0..s1], optionally tick range in the first/last measure. */
export function copyRange(score, range) {
  const { fromMi, toMi, s0, s1 } = range;
  const out = { kind: 'scoresnap-clip', measures: [], staves: s1 - s0 + 1, chords: [], spanners: [] };
  const ids = new Set();
  for (let mi = fromMi; mi <= toMi; mi++) {
    const m = score.measures[mi];
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    const rec = { capacity: cap, staves: [], chords: (m.chords || []).map(c => ({ ...c })) };
    for (let si = s0; si <= s1; si++) {
      const sm = m.staves[si];
      rec.staves.push({ voices: sm.voices.map(v => v.map(e => { ids.add(e.id); return JSON.parse(JSON.stringify(e)); })) });
    }
    out.measures.push(rec);
  }
  out.spanners = (score.spanners || []).filter(sp => ids.has(sp.from.eventId) && ids.has(sp.to?.eventId)).map(sp => JSON.parse(JSON.stringify(sp)));
  return out;
}
export function copyEvents(score, ids) {
  // list selection → copy events in order grouped by voice as a sequence (first voice only)
  const found = ids.map(id => findEvent(score, id)).filter(Boolean).sort((a, b) => a.mi - b.mi || a.tick - b.tick);
  if (!found.length) return null;
  const f0 = found[0];
  return { kind: 'scoresnap-clip', events: found.filter(f => f.staffIndex === f0.staffIndex && f.voiceIndex === f0.voiceIndex).map(f => JSON.parse(JSON.stringify(f.ev))) };
}
/** Paste clip at {mi, si, vi, tick}. Overwrites. Returns ids of pasted events. */
export function paste(score, clip, at) {
  const pasted = [];
  const idMap = new Map();
  const fresh = ev => { const c = JSON.parse(JSON.stringify(ev)); const nid = newId(); idMap.set(c.id, nid); c.id = nid; if (c.tuplet) c.tuplet = { ...c.tuplet, id: 'T' + c.tuplet.id }; pasted.push(nid); return c; };
  if (clip.events) {
    const seq = clip.events.map(fresh);
    let cur = { mi: at.mi, tick: at.tick || 0 };
    for (const ev of seq) {
      if (ev.grace) { const m = score.measures[cur.mi]; if (!m) break; const v = ensureVoice(m.staves[at.si], at.vi || 0); const items = expand(v); const idx = items.findIndex(it => !it.ev.grace && it.start >= cur.tick - EPS); v.splice(idx < 0 ? v.length : idx, 0, ev); continue; }
      cur = placeEventAt(score, at.si, at.vi || 0, cur.mi, cur.tick, ev);
    }
    remapTuplets(score, pasted);
    return pasted;
  }
  // range clip
  const nStaves = totalStaffCount(score);
  clip.measures.forEach((rec, k) => {
    const mi = at.mi + k;
    if (mi >= score.measures.length) appendMeasures(score, 1);
    const m = score.measures[mi];
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    rec.staves.forEach((srec, j) => {
      const si = at.si + j; if (si >= nStaves) return;
      const sm = m.staves[si];
      srec.voices.forEach((v, vi) => {
        if (!v.length) { if (vi > 0) return; }
        const evs = v.map(fresh);
        const len = Math.min(evs.reduce((a, e) => a + durTicks(e), 0), rec.capacity);
        const target = ensureVoice(sm, vi);
        sm.voices[vi] = normalizeVoice(replaceRange(target, k === 0 ? (at.tick || 0) : 0, len, evs), cap);
      });
    });
    if (rec.chords?.length && at.si === 0) { m.chords = rec.chords.map(c => ({ ...c, id: newId() })); }
  });
  for (const sp of (clip.spanners || [])) {
    if (idMap.has(sp.from.eventId) && idMap.has(sp.to?.eventId)) score.spanners.push({ ...sp, id: newId(), from: { eventId: idMap.get(sp.from.eventId) }, to: { eventId: idMap.get(sp.to.eventId) } });
  }
  remapTuplets(score, pasted);
  return pasted;
}
function remapTuplets(score, ids) {
  const set = new Set(ids); const map = new Map();
  forEachEvent(score, ev => { if (set.has(ev.id) && ev.tuplet && String(ev.tuplet.id).startsWith('T')) { if (!map.has(ev.tuplet.id)) map.set(ev.tuplet.id, newId()); ev.tuplet.id = map.get(ev.tuplet.id); } });
}
/** R: repeat the selected events right after themselves. */
export function repeatEvents(score, ids) {
  const clip = copyEvents(score, ids); if (!clip) return [];
  const found = ids.map(id => findEvent(score, id)).filter(Boolean).sort((a, b) => a.mi - b.mi || a.tick - b.tick);
  const last = found[found.length - 1];
  const endTick = last.tick + durTicks(last.ev);
  const cap = measureCapacity(effectiveTimeSig(score, last.mi));
  const at = endTick >= cap - EPS ? { mi: last.mi + 1, tick: 0, si: last.staffIndex, vi: last.voiceIndex } : { mi: last.mi, tick: endTick, si: last.staffIndex, vi: last.voiceIndex };
  if (at.mi >= score.measures.length) appendMeasures(score, 1);
  return paste(score, clip, at);
}
export function transposeRange(score, range, semitones) {
  const ids = [];
  for (let mi = range.fromMi; mi <= range.toMi; mi++) for (let si = range.s0; si <= range.s1; si++) score.measures[mi].staves[si].voices.forEach(v => v.forEach(e => { if (e.kind === 'note') ids.push(e.id); }));
  transposeEvents(score, ids, { semitones, byInterval: true });
  if (range.s0 === 0) for (let mi = range.fromMi; mi <= range.toMi; mi++) (score.measures[mi].chords || []).forEach(c => { c.text = transposeChordText(c.text, semitones, effectiveKeySig(score, mi).fifths < 0); Object.assign(c, parseChordText(c.text)); });
}
export function transposeKey(score, semitones, fromMi = 0, toMi = score.measures.length - 1) {
  // move key signatures
  for (let mi = fromMi; mi <= toMi; mi++) {
    const m = score.measures[mi];
    if (m.keySig || mi === fromMi) {
      const f = effectiveKeySig(score, mi).fifths;
      let nf = ((f + semitones * 7) % 12 + 12) % 12; if (nf > 6) nf -= 12;
      m.keySig = { fifths: nf, mode: m.keySig?.mode || 'major' };
    }
  }
  transposeRange(score, { fromMi, toMi, s0: 0, s1: totalStaffCount(score) - 1 }, semitones);
}
export { expand as expandVoice, normalizeVoice };
