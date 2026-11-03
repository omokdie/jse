// Standard MIDI File (type 1) writer + playback event list builder.
import { durTicks, midiOf, effectiveTempo, measureCapacity, effectiveTimeSig, staffList, TPQ } from '../model/score.js';

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

/** Flatten the score into timed note events (seconds) for playback / MIDI. */
export function buildPlayback(score) {
  const order = playbackOrder(score);
  const staves = staffList(score);
  const notes = [];      // {time, dur, midi, velocity, channel, program, partIndex, eventId}
  const measureTimes = [];   // {mi, time, dur}
  let t = 0;
  const tieChain = new Map();   // key staff:vi:midi → pending note waiting for tie end
  for (const mi of order) {
    const tempo = effectiveTempo(score, mi);
    const beatSec = 60 / (tempo.bpm || 120) * (960 / (({ whole: 3840, half: 1920, quarter: 960, eighth: 480 }[tempo.beatUnit] || 960) * (tempo.dots ? 1.5 : 1)));
    const secPerTick = beatSec / 960;
    const cap = measureCapacity(effectiveTimeSig(score, mi));
    measureTimes.push({ mi, time: t, dur: cap * secPerTick });
    const m = score.measures[mi];
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
              else midi = midiOf(n) + (score.settings.concertPitch === false ? 0 : (part.transposeChromatic || 0));
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
    t += cap * secPerTick;
  }
  notes.sort((a, b) => a.time - b.time);
  return { notes, measureTimes, duration: t, order };
}
function midiOfName(s) { const m = /^([A-G])(#|b)?(-?\d)$/.exec(s); if (!m) return 40; const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]]; return (parseInt(m[3], 10) + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); }
export function dynamicScale(d) { return { ppp: 0.35, pp: 0.5, p: 0.65, mp: 0.8, mf: 1.0, f: 1.15, ff: 1.3, fff: 1.45, sfz: 1.4, fp: 1.2, fz: 1.3, rfz: 1.3 }[d] || 1; }

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
  let lastBpm = null;
  const secToTick = buildSecToTick(score, pb, tpq);
  pb.order.forEach((mi, k) => {
    const tempo = effectiveTempo(score, mi); const bpm = tempo.bpm || 120;
    if (bpm !== lastBpm) { const us = Math.round(60000000 / bpm); meta.push({ tick: secToTick(pb.measureTimes[k].time), data: [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255] }); lastBpm = bpm; }
    const ts = effectiveTimeSig(score, mi);
    if (k === 0 || score.measures[mi].timeSig) meta.push({ tick: secToTick(pb.measureTimes[k].time), data: [0xff, 0x58, 0x04, ts.num, Math.log2(ts.den), 24, 8] });
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
  // piecewise-linear: each measure maps [time, time+dur] → [tickStart, tickStart+cap*tpq/TPQ]
  const segs = []; let tickStart = 0;
  pb.measureTimes.forEach(mt => { const cap = measureCapacity(effectiveTimeSig(score, mt.mi)); const ticks = cap * tpq / TPQ; segs.push({ t0: mt.time, t1: mt.time + mt.dur, k0: tickStart, k1: tickStart + ticks }); tickStart += ticks; });
  return sec => { const s = segs.find(x => sec >= x.t0 && sec < x.t1) || segs[segs.length - 1]; if (!s) return 0; const f = (sec - s.t0) / Math.max(1e-9, s.t1 - s.t0); return Math.round(s.k0 + f * (s.k1 - s.k0)); };
}
