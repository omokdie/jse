// Standard MIDI File (type 1) writer + playback event list builder.
import { durTicks, midiOf, effectiveTempo, measureCapacity, effectiveTimeSig, staffList, ottavaShifts, TPQ } from '../model/score.js';

const REPEAT_LIMIT = 64;
/**
 * Expand repeats into a playback order of measure indices.
 * Handles |: :| repeats, 1./2. voltas, D.C./D.S. al Fine/Coda markers (basic).
 */
export function playbackOrder(score) {
  const ms = score.measures;
  const voltas = (score.spanners || []).filter(s => s.type === 'volta');
  const voltaOf = mi => { const id = ms[mi].id; for (const v of voltas) { const a = ms.findIndex(m => m.id === v.from.measureId), b = ms.findIndex(m => m.id === (v.to?.measureId || v.from.measureId)); if (mi >= a && mi <= b) return { v, a, b, n: parseInt(v.number, 10) || 1 }; } return null; };
  const order = [];
  let mi = 0, repeatStart = 0, pass = 1, guard = 0;
  const passCount = new Map();   // repeatStart → passes done
  let jumped = { dc: false, ds: false };
  let segno = ms.findIndex(m => m.markers?.includes('segno'));
  while (mi < ms.length && guard++ < 5000) {
    const m = ms[mi];
    if (m.barlineLeft === 'repeat-start') { repeatStart = mi; pass = (passCount.get(mi) || 0) + 1; }
    const vt = voltaOf(mi);
    if (vt && vt.n !== pass && !(vt.n < pass && vt.b === vt.a && false)) {
      // skip this volta unless it matches the current pass (last volta catches all later passes)
      const laterVolta = voltas.some(v => { const a = ms.findIndex(x => x.id === v.from.measureId); return a > vt.b && (parseInt(v.number, 10) || 1) === pass; });
      if (vt.n < pass && !laterVolta) { /* final pass goes through the last volta */ }
      else { mi = vt.b + 1; continue; }
    }
    order.push(mi);
    if (m.markers?.includes('fine') && (jumped.dc || jumped.ds)) break;
    if ((m.markers?.includes('dcAlFine') || m.markers?.includes('dcAlCoda') || m.markers?.includes('dc')) && !jumped.dc) { jumped.dc = true; mi = 0; repeatStart = 0; passCount.clear(); pass = REPEAT_LIMIT; continue; }
    if ((m.markers?.includes('dsAlFine') || m.markers?.includes('dsAlCoda') || m.markers?.includes('ds')) && !jumped.ds && segno >= 0) { jumped.ds = true; mi = segno; repeatStart = segno; pass = REPEAT_LIMIT; continue; }
    if (m.markers?.includes('toCoda') && (jumped.dc || jumped.ds)) { const coda = ms.findIndex((x, i) => i > mi && x.markers?.includes('coda')); if (coda >= 0) { mi = coda; continue; } }
    if ((m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both') && pass < (m.repeatCount || 2) && pass < REPEAT_LIMIT) {
      passCount.set(repeatStart, pass); pass++;
      mi = repeatStart; continue;
    }
    if (m.barlineRight === 'repeat-both') { repeatStart = mi + 1; pass = 1; }
    mi++;
  }
  return order;
}

/** Ticks a measure lasts when played: an upbeat (pickup) measure is only as long as its longest voice. */
export function measurePlayTicks(measure, cap) {
  if (!measure || !measure.pickup) return cap;
  let len = 0;
  for (const sm of measure.staves) for (const v of sm.voices) { let t = 0; for (const ev of v) t += durTicks(ev); if (t > len) len = t; }
  return len > 0 && len < cap ? len : cap;
}

/** Flatten the score into timed note events (seconds) for playback / MIDI. */
export function buildPlayback(score) {
  const order = playbackOrder(score);
  const staves = staffList(score);
  const notes = [];      // {time, dur, midi, velocity, channel, program, partIndex, eventId}
  const measureTimes = [];   // {mi, time, dur, ticks, beat} — ticks = length in model ticks, beat = seconds per counted beat
  const clicks = [];     // metronome: {time, accent} — an upbeat measure counts back from the bar line after it
  const ottava = ottavaShifts(score);
  let t = 0;
  const tieChain = new Map();   // key staff:vi:midi → pending note waiting for tie end
  for (const mi of order) {
    const tempo = effectiveTempo(score, mi);
    const beatSec = 60 / (tempo.bpm || 120) * (960 / (({ whole: 3840, half: 1920, quarter: 960, eighth: 480 }[tempo.beatUnit] || 960) * (tempo.dots ? 1.5 : 1)));
    const secPerTick = beatSec / 960;
    const ts = effectiveTimeSig(score, mi);
    const cap = measureCapacity(ts);
    const m = score.measures[mi];
    const len = measurePlayTicks(m, cap), beat = cap / ts.num * secPerTick;
    measureTimes.push({ mi, time: t, dur: len * secPerTick, ticks: len, beat });
    if (len < cap) { for (let k = Math.floor(len * secPerTick / beat + 1e-6); k >= 1; k--) clicks.push({ time: t + len * secPerTick - k * beat, accent: false }); }
    else for (let k = 0; k < ts.num; k++) clicks.push({ time: t + k * beat, accent: k === 0 });
    m.staves.forEach((sm, si) => {
      const { part, staff } = staves[si];
      const channel = part.midiChannel ?? (staff.type === 'percussion' ? 9 : Math.min(15, si === 9 ? 10 : si));
      const velBase = 80;
      sm.voices.forEach((v, vi) => {
        let tick = 0;
        v.forEach(ev => {
          const dt = durTicks(ev);
          if (ev.kind === 'note' && !ev.hidden) {
            const vel = Math.round(velBase * dynamicScale(ev.dynamic) * (ev.articulations?.includes('accent') || ev.articulations?.includes('marcato') ? 1.2 : 1));
            let durSec = dt * secPerTick;
            if (ev.articulations?.includes('staccato')) durSec *= 0.5; else if (ev.articulations?.includes('tenuto')) durSec *= 1.0; else durSec *= 0.92;
            const start = t + tick * secPerTick;
            ev.notes.forEach((n, ni) => {
              let midi;
              if (staff.type === 'percussion') midi = staff.drumMap?.[n.drum]?.midi ?? 38;
              else if (staff.type === 'tab') { const tun = staff.tuning || ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']; const open = tun[tun.length - (n.string || 1)]; midi = (open ? midiOfName(open) : 40) + (n.fret || 0); }
              else midi = midiOf(n) + (part.transposeChromatic || 0) + (ottava.get(ev.id) || 0);   // notes are stored as written
              const key = `${si}:${vi}:${midi}`;
              if (n.tieEnd && tieChain.has(key)) { const prev = tieChain.get(key); prev.dur = (start - prev.time) + durSec; if (!n.tieStart) tieChain.delete(key); else tieChain.set(key, prev); prev.eventIds.push(ev.id); return; }
              const rec = { time: start, dur: durSec, midi, velocity: Math.min(127, vel), channel, program: part.midiProgram || 0, partIndex: staves[si].partIndex, eventId: ev.id, eventIds: [ev.id], grace: !!ev.grace };
              if (ev.grace) { rec.time = Math.max(0, start - 0.08); rec.dur = 0.08; }
              notes.push(rec);
              if (n.tieStart) tieChain.set(key, rec);
              void ni;
            });
          }
          tick += dt;
        });
      });
    });
    t += len * secPerTick;
  }
  notes.sort((a, b) => a.time - b.time);
  return { notes, measureTimes, clicks, duration: t, order };
}
function midiOfName(s) { const m = /^([A-G])(#|b)?(-?\d)$/.exec(s); if (!m) return 40; const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]; return (parseInt(m[3], 10) + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); }
export function dynamicScale(d) { return { pppp: 0.25, ppp: 0.35, pp: 0.5, p: 0.65, mp: 0.8, mf: 1.0, f: 1.15, ff: 1.3, fff: 1.45, ffff: 1.55, sf: 1.4, sfz: 1.4, sffz: 1.5, sfp: 1.3, fp: 1.2, fz: 1.3, rf: 1.3, rfz: 1.3 }[d] || 1; }

// ---------- SMF writer ----------
function vlq(n) { const bytes = [n & 0x7f]; n >>= 7; while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; } return bytes; }
function str(s) { return [...new TextEncoder().encode(s)]; }
export function writeMidi(score) {
  const pb = buildPlayback(score);
  const tracks = [];
  // tempo/meta track: we convert absolute seconds back to ticks using a constant tempo map derived from measures
  const tpq = 480;
  // Build a tempo map from measureTimes: for simplicity emit tempo events at measure starts where tempo changes
  const meta = [];
  meta.push({ tick: 0, data: [0xff, 0x03, ...vlq(str(score.meta.title || 'JSE').length), ...str(score.meta.title || 'JSE')] });
  let lastBpm = null, afterUpbeat = false;
  const secToTick = buildSecToTick(score, pb, tpq);
  pb.order.forEach((mi, k) => {
    const tempo = effectiveTempo(score, mi); const bpm = tempo.bpm || 120;
    if (bpm !== lastBpm) { const us = Math.round(60000000 / bpm); meta.push({ tick: secToTick(pb.measureTimes[k].time), data: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] }); lastBpm = bpm; }
    const ts = effectiveTimeSig(score, mi);
    // an upbeat measure gets a meter of its own length, so that the bar lines of the file fall where the score has them
    const cap = measureCapacity(ts), len = pb.measureTimes[k].ticks;
    let sig = ts;
    if (len < cap) { sig = null; for (const den of [ts.den, 8, 16, 32, 64]) { const n = len * den / 3840; if (den >= ts.den && Math.abs(n - Math.round(n)) < 1e-6 && n >= 1 && n < 256) { sig = { num: Math.round(n), den }; break; } } }
    if (sig && (k === 0 || score.measures[mi].timeSig || sig !== ts || afterUpbeat)) meta.push({ tick: secToTick(pb.measureTimes[k].time), data: [0xff, 0x58, 0x04, sig.num, Math.log2(sig.den), 24, 8] });
    afterUpbeat = sig !== ts;
  });
  tracks.push(meta);
  // one track per part
  score.parts.forEach((part, pi) => {
    const evs = [];
    const chan = part.midiChannel ?? Math.min(15, pi === 9 ? 10 : pi);
    evs.push({ tick: 0, data: [0xff, 0x03, ...vlq(str(part.name || '').length), ...str(part.name || '')] });
    if (chan !== 9) evs.push({ tick: 0, data: [0xc0 | chan, part.midiProgram || 0] });
    for (const n of pb.notes) {
      if (n.partIndex !== pi) continue;
      const on = secToTick(n.time), off = Math.max(on + 1, secToTick(n.time + n.dur));
      evs.push({ tick: on, data: [0x90 | n.channel, n.midi, n.velocity], order: 1 });
      evs.push({ tick: off, data: [0x80 | n.channel, n.midi, 0], order: 0 });
    }
    tracks.push(evs);
  });
  const chunks = [];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (tpq >> 8) & 255, tpq & 255];
  chunks.push(...header);
  for (const evs of tracks) {
    evs.sort((a, b) => a.tick - b.tick || (a.order || 0) - (b.order || 0));
    const bytes = []; let last = 0;
    for (const e of evs) { bytes.push(...vlq(Math.max(0, e.tick - last)), ...e.data); last = e.tick; }
    bytes.push(0, 0xff, 0x2f, 0);
    chunks.push(0x4d, 0x54, 0x72, 0x6b, (bytes.length >> 24) & 255, (bytes.length >> 16) & 255, (bytes.length >> 8) & 255, bytes.length & 255, ...bytes);
  }
  return new Uint8Array(chunks);
}
function buildSecToTick(score, pb, tpq) {
  // piecewise-linear: each measure maps [time, time+dur] → [tickStart, tickStart + its length in MIDI ticks]
  const segs = []; let tickStart = 0;
  pb.measureTimes.forEach(mt => { const ticks = mt.ticks * tpq / TPQ; segs.push({ t0: mt.time, t1: mt.time + mt.dur, k0: tickStart, k1: tickStart + ticks }); tickStart += ticks; });
  return sec => { const s = segs.find(x => sec >= x.t0 && sec < x.t1) || segs[segs.length - 1]; if (!s) return 0; const f = (sec - s.t0) / Math.max(1e-9, s.t1 - s.t0); return Math.round(s.k0 + f * (s.k1 - s.k0)); };
}
