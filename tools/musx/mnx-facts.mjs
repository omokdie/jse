// Facts of an MNX document (JSON, as written by denigma from a .musx file) in the shape of tools/mscz/compare.mjs
// facts(), so that a ScoreDoc and what an independent Finale reader made of our .musx can be compared.
//
//   mnxFacts(mnx, score)  — `score` is the ScoreDoc the .musx was written from; it supplies what MNX does not say
//                           in the same terms: the global staff index of each part staff and the transposition
//                           (MNX pitches are concert pitches with 8va lines applied; JSE facts use written pitch
//                           with 8va lines applied, so the part's transposition is taken off again).
import { staffList } from '../../app/js/model/score.js';

const BASE = { maxima: 30720, longa: 15360, breve: 7680, whole: 3840, half: 1920, quarter: 960, eighth: 480, '16th': 240, '32nd': 120, '64th': 60, '128th': 30, '256th': 15 };
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const durOf = (d) => { if (!d) return 0; if (Array.isArray(d)) return d[1] ? 3840 * d[0] / d[1] : 0; let t = BASE[d.base] || 0, add = t; for (let i = 0; i < (d.dots || 0); i++) { add /= 2; t += add; } return t; };
const midiOf = (p) => (p.octave + 1) * 12 + STEP[p.step] + (p.alter || 0);

export function mnxFacts(mnx, score) {
  const staves = staffList(score);
  const out = { measures: (mnx.global?.measures || []).length, notes: [], drums: [], tab: [], lyrics: [], meter: [], keys: [], repeats: [], dynamics: [], wedges: [], slurs: 0, ottavas: 0, tempos: [], endings: [], fermatas: [], markings: [], problems: [] };
  // global: meter, keys, repeats
  let ts = { count: 4, unit: 4 }, key = 0;
  (mnx.global?.measures || []).forEach((gm, mi) => {
    if (gm.time) ts = gm.time;
    if (gm.key) key = gm.key.fifths || 0;
    out.meter.push(`${ts.count}/${ts.unit}`);
    out.keys.push(key);
    out.repeats.push([gm.repeatStart ? '|:' : '', gm.repeatEnd ? ':|' : ''].filter(Boolean).join(' '));
    if (gm.ending) out.endings.push({ mi, duration: gm.ending.duration, numbers: (gm.ending.numbers || []).join(',') });
    for (const t of gm.tempos || []) out.tempos.push({ mi, bpm: t.bpm, base: t.value?.base });
  });
  (mnx.parts || []).forEach((part, pi) => {
    const pStaves = staves.filter(s => s.partIndex === pi);
    if (!pStaves.length) { out.problems.push(`part ${pi + 1} not in score`); return; }
    const trans = Math.round(pStaves[0].part.transposeChromatic || 0);
    const evIndex = new Map();   // event id → note facts (for ties) and event info
    const pendingTies = [];
    (part.measures || []).forEach((pm, mi) => {
      for (const seq of pm.sequences || []) {
        const si = Math.max(0, (seq.staff || 1) - 1);
        const st = pStaves[Math.min(si, pStaves.length - 1)];
        let t = 0;
        const walk = (items, ratio, grace) => {
          for (const it of items || []) {
            if (it.type === 'tuplet') {
              const inner = (it.inner?.multiple || 1) * durOf(it.inner?.duration), outer = (it.outer?.multiple || 1) * durOf(it.outer?.duration);
              walk(it.content, ratio * (inner ? outer / inner : 1), grace);
            } else if (it.type === 'grace') walk(it.content, ratio, true);
            else if (it.type === 'space') t += durOf(it.duration) * ratio;
            else if (it.type === 'event' || it.duration || it.measure || it.notes || it.rest) {
              const d = it.measure ? null : grace ? 0 : Math.round(durOf(it.duration) * ratio);
              // drums: the kit component's sound (General MIDI key) and line (0 = middle line, up positive)
              for (const n of it.kitNotes || []) {
                const comp = part.kit?.[n.kitComponent] || {};
                out.drums.push({ mi, si: st.globalIndex, tick: Math.round(t), midi: mnx.global?.sounds?.[comp.sound]?.midiNumber ?? -1, pos: comp.staffPosition ?? 0 });
              }
              for (const n of it.notes || []) {
                if (st.staff.type === 'tab') { out.tab.push({ mi, si: st.globalIndex, tick: Math.round(t), midi: midiOf(n.pitch) }); continue; }
                if (st.staff.type === 'percussion') continue;
                const f = { mi, si: st.globalIndex, pi, tick: Math.round(t), dur: d ?? 0, midi: midiOf(n.pitch) - trans, grace: !!grace, tie: 0, id: n.id };
                out.notes.push(f); evIndex.set(n.id, f);
                for (const tie of n.ties || []) { f.tie |= 1; if (tie.target) pendingTies.push(tie.target); }
              }
              const lines = it.lyrics?.lines || {};
              for (const [lk, l] of Object.entries(lines)) {
                const verse = parseInt(String(lk).replace(/\D/g, ''), 10) || 1;
                out.lyrics.push({ mi, pi, tick: Math.round(t), verse, text: l.text, syllabic: { whole: 'single', start: 'begin', middle: 'middle', end: 'end' }[l.type] || 'single' });
              }
              out.slurs += (it.slurs || []).length;
              if (it.fermata) out.fermatas.push({ mi, si: st.globalIndex, tick: Math.round(t) });
              if (it.markings) for (const k of Object.keys(it.markings)) out.markings.push({ mi, si: st.globalIndex, tick: Math.round(t), kind: k });
              if (!grace && d != null) t += d;
              if (it.measure) t = Infinity;
            } else out.problems.push(`unknown sequence item ${it.type}`);
          }
        };
        walk(seq.content, 1, false);
      }
      for (const dyn of pm.dynamics || []) {
        const st = pStaves[Math.min(Math.max(0, (dyn.staff || 1) - 1), pStaves.length - 1)];
        const pos = dyn.position?.fraction ? Math.round(3840 * dyn.position.fraction[0] / dyn.position.fraction[1]) : 0;
        if (dyn.type === 'gradual') out.wedges.push({ mi, si: st.globalIndex, type: dyn.wedgeType });
        else out.dynamics.push({ mi, si: st.globalIndex, tick: pos, value: (dyn.accentPrefix || '') + (dyn.value || '') + (dyn.accentSuffix || '') });
      }
      out.ottavas += (pm.ottavas || []).length;
    });
    for (const target of pendingTies) { const f = evIndex.get(target); if (f) f.tie |= 2; }
  });
  return out;
}
