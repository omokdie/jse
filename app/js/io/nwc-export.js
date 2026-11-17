// JSE — ScoreDoc (SPEC §2) → NWC document → nwctxt text / .nwc file.
//
// The score is first turned into the same "NWC document" the readers produce (nwc-text.js,
// nwc-binary.js): staves with a flat list of objects. writeNwctxt() / writeNwc175() then only
// have to spell that document out. What NoteWorthy Composer needs that JSE does not store:
//   * one staff per voice — extra voices become staves layered on the first ("Layer with next staff");
//   * staff positions instead of pitches, and accidentals written by NWC's rule (an accidental
//     holds for the note NAME in every octave until the bar line, and through ties);
//   * lyrics as one text per verse that NWC hands out to the notes itself, so the text is built
//     to make NWC's own rules land every syllable where JSE has it (Lyric=Always / Never on the
//     notes where the rules would differ);
//   * slurs, hairpins and beams as flags on the notes; repeats, endings and flow signs on every
//     staff (NWC plays each staff by its own signs);
//   * every staff exactly as long as the others in every bar — hidden rests fill the gaps.
// Conventions (positions of expressions, "Stem=" on every beamed note, "\n" in lyrics, …) follow
// what files written by NWC 2.75 itself contain.

import { durTicks, DUR_TICKS, measureCapacity, staffList, noteFromMidi, ottavaShifts } from '../model/score.js';
import { writeNwctxt } from './nwc-text.js';
import { deflateZlib } from './nwc-zlib.js';
import { writeNwc175 } from './nwc-binary-write.js';

const BASE_INDEX = { whole: 0, half: 1, quarter: 2, eighth: 3, '16th': 4, '32nd': 5, '64th': 6 };
const STEPS = 'CDEFGAB';
const CLEF_CENTER = { Treble: 34, Bass: 22, Alto: 28, Tenor: 26, Percussion: 22 };
const CLEF_OF = {
  treble: ['Treble', 0], treble8vb: ['Treble', -1], treble8va: ['Treble', 1], bass: ['Bass', 0], bass8vb: ['Bass', -1],
  alto: ['Alto', 0], tenor: ['Tenor', 0], percussion: ['Percussion', 0], tab: ['Treble', -1],
};
const ACC_CHAR = { 2: 'x', 1: '#', 0: 'n', '-1': 'b', '-2': 'v' };
const SHARPS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'], FLATS = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MAJOR_TONIC = (f) => (f >= 0 ? 'CGDAEBFC'[f] : 'CFBEADGC'[-f]);
const MINOR_TONIC = (f) => (f >= 0 ? 'AEBFCGDA'[f] : 'ADGCFBEA'[-f]);
const TEMPO_BASE = { 'eighth:0': 'Eighth', 'eighth:1': 'Eighth Dotted', 'quarter:0': 'Quarter', 'quarter:1': 'Quarter Dotted', 'half:0': 'Half', 'half:1': 'Half Dotted' };
const FLOW_OF = { coda: 'Coda', segno: 'Segno', fine: 'Fine', toCoda: 'ToCoda', dc: 'DaCapo', dcAlCoda: 'DCalCoda', dcAlFine: 'DCalFine', ds: 'DalSegno', dsAlCoda: 'DSalCoda', dsAlFine: 'DSalFine' };
const DYNAMICS = new Set(['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff']);
const ORNAMENT_TEXT = { trill: 'tr', turn: 'turn', 'inverted-turn': 'turn', mordent: 'mordent', 'inverted-mordent': 'mordent' };
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힣]/;

const W = {
  tuplet: '셋잇단음표가 아닌 잇단음표는 NWC에 없어 가장 가까운 음길이로 바꿔 저장했습니다',
  duration: 'NWC에 없는 음길이(겹온음표, 128분음표 등)는 나누거나 가까운 길이로 저장했습니다',
  voices: '둘째 성부부터는 NWC의 겹침 보표(Layer)로 저장했습니다',
  verses: '가사는 8절까지만 저장했습니다',
  chordMoved: '음표가 시작하지 않는 자리의 코드 기호는 가까운 음표 위에 모아 적었습니다',
  drums: '타악기 보표는 NWC 방식(음표 위치 = GM 드럼 음높이)으로 저장해 음표 위치가 달라집니다',
  tab: 'TAB 보표는 일반 오선 보표로 저장했습니다',
  ornaments: '꾸밈음 기호(트릴 등)·아르페지오·트레몰로는 NWC에 없어 글자로 적거나 생략했습니다',
  dynamics: 'NWC에 없는 셈여림 기호(fp, sfp, fz)는 글자로 저장했습니다',
  heads: '일부 음표 머리 모양은 NWC에 없어 보통 머리로 저장했습니다',
  unison: '같은 줄·칸에 겹친 화음 음표는 하나만 저장했습니다',
  cut: '마디 끝을 넘어 다음 마디와 겹치는 음표는 마디 끝에서 잘랐습니다',
  spanners: '옥타브 기호(8va)는 선 없이 실제 음높이로 옮겨 적었고, 글리산도·트릴 선 등 NWC에 없는 선은 저장하지 않았습니다',
};

// every duration NWC can write, longest first
const NWC_DURS = [];
for (let b = 0; b <= 6; b++) for (const dots of [2, 1, 0]) NWC_DURS.push({ base: b, dots, t: (3840 >> b) * (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1) });
NWC_DURS.sort((a, b) => b.t - a.t);
const pieceTicks = (p) => (3840 >> p.base) * (p.dots === 2 ? 1.75 : p.dots === 1 ? 1.5 : 1) * (p.triplet ? 2 / 3 : 1);
/** ticks → durations NWC can write (greedy). Thirds of a 64th grid become triplet values. */
function splitTicks(ticks) {
  const out = []; let rem = Math.round(ticks);
  if (rem % 60) {
    // a remainder that only triplets can fill (after an unfinished triplet): one triplet value
    for (const t of [2560, 1280, 640, 320, 160, 80, 40]) {
      if (t <= rem && (rem - t) % 60 === 0) { out.push({ base: Math.round(Math.log2(3840 / (t * 1.5))), dots: 0, triplet: 'End' }); rem -= t; break; }
    }
  }
  let guard = 0;
  while (rem >= 60 && guard++ < 64) {
    const c = NWC_DURS.find(d => d.t <= rem + 1e-6);
    if (!c) break;
    out.unshift({ base: c.base, dots: c.dots }); rem -= c.t;
  }
  // unshift put the pieces in rising order; longest first reads better
  const plain = out.filter(p => !p.triplet).sort((a, b) => pieceTicks(b) - pieceTicks(a));
  return [...plain, ...out.filter(p => p.triplet)];
}

// Same grouping rules as engrave/layout.js autoBeamGroups (see io/musicxml.js): what JSE draws
// when an event has no explicit beam.
function autoBeamGroups(voice, ts) {
  const beat = ts.den === 8 && ts.num % 3 === 0 ? 1440 : ts.den === 2 ? 1920 : ts.den >= 8 ? 480 : 960;
  const beamable = ev => ev.kind === 'note' && !ev.grace && DUR_TICKS[ev.dur.base] <= DUR_TICKS.eighth;
  const groups = []; let cur = null, tick = 0;
  const flush = () => { if (cur && cur.idx.length > 1) groups.push(cur.idx); cur = null; };
  voice.forEach((ev, i) => {
    if (!beamable(ev)) flush();
    else {
      const bi = Math.floor((tick + 1e-6) / beat);
      if (cur && Math.floor((cur.start + 1e-6) / beat) === bi && cur.tid === (ev.tuplet ? ev.tuplet.id : null)) cur.idx.push(i);
      else { flush(); cur = { start: tick, idx: [i], tid: ev.tuplet ? ev.tuplet.id : null }; }
    }
    if (!ev.grace) tick += durTicks(ev);
  });
  flush();
  if (ts.den === 4 && ts.num % 2 === 0) {
    const merged = [];
    const tickOf = idx => { let t = 0; for (let k = 0; k < idx; k++) if (!voice[k].grace) t += durTicks(voice[k]); return t; };
    const plain8 = g => g.every(i => voice[i].dur.base === 'eighth' && !voice[i].dur.dots && !voice[i].tuplet);
    for (const g of groups) {
      const prev = merged[merged.length - 1];
      if (prev && plain8(prev) && plain8(g) && prev[prev.length - 1] + 1 === g[0] && Math.floor(tickOf(prev[0]) / 1920) === Math.floor(tickOf(g[0]) / 1920)) { prev.push(...g); continue; }
      merged.push(g);
    }
    return merged;
  }
  return groups;
}

/** A voice that is one whole rest: the rest lasts as long as the bar, whatever the meter. */
function isBarRest(voice) {
  const real = voice.filter(ev => !ev.grace);
  return real.length === 1 && voice.length === 1 && real[0].kind === 'rest' && (!!real[0].fullMeasureRest || (real[0].dur.base === 'whole' && !real[0].dur.dots && !real[0].tuplet));
}

/** How each event of a voice is written: one duration, or several tied ones where NWC has no such value. */
function planVoice(voice, warn) {
  const plan = new Array(voice.length);
  let pos = 0;
  voice.forEach((ev, i) => {
    const base = BASE_INDEX[ev.dur.base];
    const dots = ev.dur.dots || 0;
    if (ev.grace) { plan[i] = { pieces: [{ base: base == null ? 3 : base, dots: 0 }], ticks: 0, start: pos }; return; }
    const t = durTicks(ev);
    const triplet = !!ev.tuplet && ev.tuplet.num * 2 === ev.tuplet.den * 3;
    if (base != null && dots <= 2 && (!ev.tuplet || triplet)) {
      plan[i] = { pieces: [{ base, dots }], ticks: t, start: pos };
      if (triplet) plan[i].tid = ev.tuplet.id;
    } else {
      const a = Math.round(pos / 60) * 60, b = Math.max(a + 60, Math.round((pos + t) / 60) * 60);
      plan[i] = { pieces: splitTicks(b - a), ticks: b - a, start: pos, approx: true };
      warn(ev.tuplet ? W.tuplet : W.duration);
    }
    pos += t;
  });
  // triplet brackets: First … End; a 6:4 group is two triplets
  for (let s = 0; s < voice.length; s++) {
    const tid = plan[s].tid;
    if (!tid || plan[s].pieces[0].triplet) continue;
    const members = [];
    for (let k = s; k < voice.length; k++) { if (plan[k].tid === tid) members.push(k); else if (!voice[k].grace) break; }
    const num = voice[s].tuplet.num;
    const total = members.reduce((n, k) => n + pieceTicks(plan[k].pieces[0]), 0);
    const chunk = num > 3 && num % 3 === 0 ? total / (num / 3) : total;
    let acc = 0, first = true;
    members.forEach((k, idx) => {
      const p = plan[k].pieces[0];
      acc += pieceTicks(p);
      const closes = idx === members.length - 1 || Math.abs(acc / chunk - Math.round(acc / chunk)) < 1e-6;
      p.triplet = closes ? 'End' : first ? 'First' : 'Mid';
      first = closes;
    });
  }
  return plan;
}

/** Beam marks per event ('First' | 'Mid' | 'End' | null) and the stem every beam group shares. */
function planBeams(voice, plan, ts) {
  const state = new Array(voice.length).fill(null);
  if (voice.some(ev => ev.beam && !ev.grace)) voice.forEach((ev, i) => { if (!ev.grace && ev.beam && ev.beam !== 'none') state[i] = ev.beam; });
  else for (const g of autoBeamGroups(voice, ts)) g.forEach((idx, k) => { state[idx] = k === 0 ? 'begin' : k === g.length - 1 ? 'end' : 'continue'; });
  const groups = []; let open = null;
  const close = () => { if (open && open.length > 1) groups.push(open); open = null; };
  voice.forEach((ev, i) => {
    if (ev.grace) return;
    const ok = ev.kind === 'note' && !plan[i].approx && plan[i].pieces[0].base >= 3 && state[i];
    if (!ok) { close(); return; }
    if (state[i] === 'begin') { close(); open = [i]; }
    else if (state[i] === 'continue') { if (open) open.push(i); else open = [i]; }
    else { if (open) open.push(i); close(); }
  });
  close();
  return groups;
}

function randomId() {
  // 128 random bits the way NWC 2 writes its document id: 22 characters, the first one 0–3
  const A = '.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  const r = new Uint8Array(22);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(r);
  else for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 256);
  let s = '0123'[r[0] & 3];
  for (let i = 1; i < 22; i++) s += A[r[i] & 63];
  return s;
}

/**
 * ScoreDoc → NWC document (see nwc-text.js for the shape).
 * @param score     ScoreDoc
 * @param warnings  array that receives Korean notes about approximations (no duplicates)
 * @param opts      { chords: 'text' (default) | 'plugin' }
 */
export function scoreToNwcDoc(score, warnings = [], opts = {}) {
  const warn = (w) => { if (w && !warnings.includes(w)) warnings.push(w); };
  const M = score.measures || [];
  const ottava = ottavaShifts(score);      // NWC has no 8va line: its notes are written where they sound
  const SL = staffList(score);
  if (!M.length || !SL.length) throw new Error('저장할 악보가 비어 있습니다');
  const meta = score.meta || {}, settings = score.settings || {};

  // ---- per measure: time signature, key, real length
  const TS = [], KEY = [], LEN = [], START = [];
  { let ts = { num: 4, den: 4 }, key = { fifths: 0, mode: 'major' }, at = 0;
    M.forEach((m) => {
      if (m.timeSig) ts = m.timeSig;
      if (m.keySig) key = m.keySig;
      TS.push(ts); KEY.push(key);
      const cap = measureCapacity(ts);
      // voices that hold music: the bar is as long as the time signature says, shorter for an
      // upbeat, longer only when every voice is longer (a single long voice hangs over the bar line)
      let max = 0, min = Infinity;
      for (const sm of m.staves) for (const v of sm.voices || []) {
        if (!v.length || isBarRest(v)) continue;
        const t = v.reduce((n, ev) => n + durTicks(ev), 0);
        if (t > 0) { max = Math.max(max, t); min = Math.min(min, t); }
      }
      const len = m.pickup && max > 0 && max < cap ? max : Math.max(cap, min === Infinity ? 0 : min);
      LEN.push(Math.round(len)); START.push(at); at += Math.round(len);
    }); }

  // ---- voices per staff
  const NV = SL.map((_, g) => {
    let n = 1;
    for (const m of M) { const vs = (m.staves[g] && m.staves[g].voices) || []; for (let v = vs.length - 1; v >= n; v--) if (vs[v] && vs[v].length) { n = v + 1; break; } }
    return Math.min(4, n);
  });
  if (NV.some(n => n > 1)) warn(W.voices);

  // ---- where every event is: stream (staff, voice) and order inside it
  const where = new Map();                       // eventId → { g, vi, k, abs }
  const streams = SL.map((_, g) => Array.from({ length: NV[g] }, () => []));
  M.forEach((m, mi) => SL.forEach((_, g) => {
    for (let vi = 0; vi < NV[g]; vi++) {
      const voice = (m.staves[g] && m.staves[g].voices && m.staves[g].voices[vi]) || [];
      let t = 0;
      voice.forEach((ev, ei) => {
        const rec = { g, vi, mi, ei, k: streams[g][vi].length, abs: START[mi] + t, ev };
        streams[g][vi].push(rec); where.set(ev.id, rec);
        t += durTicks(ev);
      });
    }
  }));

  // ---- spanners → flags on events
  const slurOut = new Set(), slurDir = new Map(), cresc = new Set(), dim = new Set();
  const pedalDown = new Set(), pedalUp = new Set();
  const voltaAt = new Map();
  const measureIndex = new Map(M.map((m, i) => [m.id, i]));
  const hairpinStarts = new Set((score.spanners || []).filter(x => x.type === 'crescendo' || x.type === 'diminuendo').map(x => x.from && x.from.eventId));
  const span = (sp, restEnds = false) => {
    const a = where.get(sp.from && sp.from.eventId), b = where.get(sp.to && sp.to.eventId);
    if (!a) return null;
    const list = streams[a.g][a.vi];
    let end;
    // a hairpin that stops on a rest: NWC ends it on the last flagged object
    if (b && b.g === a.g && b.vi === a.vi) end = restEnds && b.ev.kind === 'rest' && !hairpinStarts.has(b.ev.id) ? b.k + 1 : b.k;
    else if (b) { end = list.findIndex(r => r.k > a.k && r.abs >= b.abs); if (end < 0) end = list.length; }
    else end = a.k + 1;
    return { list, from: a.k, to: Math.max(a.k + 1, end) };       // events [from, to) carry the flag
  };
  for (const sp of score.spanners || []) {
    if (sp.type === 'slur') {
      const s = span(sp); if (!s) continue;
      for (let k = s.from; k < s.to; k++) slurOut.add(s.list[k].ev.id);        // rests under a slur carry the flag too, as in NWC's own files
      if (sp.placement) slurDir.set(s.list[s.from].ev.id, sp.placement === 'above' ? 'Upward' : 'Downward');
    } else if (sp.type === 'crescendo' || sp.type === 'diminuendo') {
      const s = span(sp, true); if (!s) continue;
      for (let k = s.from; k < s.to; k++) (sp.type === 'crescendo' ? cresc : dim).add(s.list[k].ev.id);      // NWC puts these flags on rests too
    } else if (sp.type === 'pedal') {
      const a = where.get(sp.from && sp.from.eventId), b = where.get(sp.to && sp.to.eventId);
      if (a) { pedalDown.add(a.ev.id); pedalUp.add((b || a).ev.id); }
    } else if (sp.type === 'volta') {
      const a = measureIndex.get(sp.from && sp.from.measureId), b = measureIndex.get(sp.to && sp.to.measureId);
      if (a == null) continue;
      const label = String(sp.number || '1.');
      const range = /(\d+)\s*\.?\s*[-–~]\s*(\d+)/.exec(label);
      let ns = [];
      if (range) for (let n = +range[1]; n <= +range[2]; n++) ns.push(n);
      else ns = (label.match(/\d+/g) || ['1']).map(Number);
      ns = [...new Set(ns.filter(n => n >= 1 && n <= 7))];
      if (!ns.length) ns = [1];
      const last = M[b == null ? a : b];
      const back = last.barlineRight === 'repeat-end' || last.barlineRight === 'repeat-both';
      // the last ending of a repeat is also the one NWC plays after D.C. / D.S. ("D")
      voltaAt.set(a, { type: 'Ending', endings: ns, default: !back, closed: sp.voltaType === 'closed' && !back });
    } else warn(W.spanners);
  }

  // ---- repeats: a repeat with a count is a "local" repeat in NWC
  const localOpen = new Set(), localClose = new Set();
  const closes = (m) => m.barlineRight === 'repeat-end' || m.barlineRight === 'repeat-both';
  M.forEach((m, mi) => {
    if (!(m.repeatCount > 2) || !closes(m)) return;
    localClose.add(mi);
    let s = mi;
    while (s > 0 && M[s].barlineLeft !== 'repeat-start' && !closes(M[s - 1])) s--;
    localOpen.add(s);
  });

  // ---- document
  const hasHangul = HANGUL_RE.test(JSON.stringify([meta, score.parts.map(p => p.name)])) || [...where.values()].some(r => (r.ev.lyrics || []).some(l => HANGUL_RE.test(l.text || '')));
  const doc = { version: '2.75', versionNumber: 275, info: {}, page: {}, fonts: [], staves: [], hasHangul };
  doc.info = { title: meta.title || '', author: meta.composer || meta.arranger || '', lyricist: meta.lyricist || '', copyright1: meta.copyright || '', copyright2: '', comments: '' };
  if (meta.subtitle) doc.info.comments = meta.subtitle;
  const sp = settings.staffSpaceMm > 0 ? settings.staffSpaceMm : 1.75;
  const mg = settings.marginsMm || { top: 15, bottom: 15, left: 15, right: 15 };
  doc.page = {
    staffSize: Math.max(8, Math.min(40, Math.round(sp * 4 / 0.3528 * 2) / 2)), zoom: 4, titlePage: true, extendLastSystem: false, durationPadding: true,
    pageNumbers: 0, staffLabels: 'First System', barNumbers: settings.measureNumbers === 'none' ? 'None' : 'Plain', startingBar: 1, allowLayering: true,
    margins: { left: mg.left / 10, top: mg.top / 10, right: mg.right / 10, bottom: mg.bottom / 10 }, mirrorMargins: false,
  };
  // fonts: NWC's defaults, with the score's text styles where it has them
  const styles = settings.textStyles || {};
  const fontOf = (style, def, src, family) => {
    const f = { style, typeface: def[0], size: def[1], bold: def[2], italic: def[3], charSet: 0 };
    if (family) f.typeface = family;
    if (src) {
      if (src.family) f.typeface = String(src.family).split(',')[0].replace(/["']/g, '').trim() || f.typeface;
      if (src.size > 0) f.size = Math.max(4, Math.min(72, Math.round(src.size * sp / 0.3528 * 10) / 10));
      if (src.bold != null) f.bold = !!src.bold;
      if (src.italic != null) f.italic = !!src.italic;
    }
    return f;
  };
  const T = 'Times New Roman';
  doc.fonts = [
    fontOf('StaffItalic', [T, 10, true, true], styles.text), fontOf('StaffBold', [T, 8, true, false], styles.technique),
    fontOf('StaffLyric', [T, 7.2, false, false], styles.lyrics, settings.fonts && settings.fonts.lyrics), fontOf('PageTitleText', [T, 24, true, false], styles.title),
    fontOf('PageText', [T, 12, false, false], styles.composer), fontOf('PageSmallText', [T, 8, false, false], styles.copyright),
    ...['User1', 'User2', 'User3', 'User4', 'User5', 'User6'].map(s => fontOf(s, [T, 8, false, false])),
  ];

  // ---- staves
  let channel = 0;
  const partChannel = new Map();
  SL.forEach(({ part, staff, staffIndex }, g) => {
    const perc = staff.type === 'percussion';
    if (perc) warn(W.drums);
    if (staff.type === 'tab') warn(W.tab);
    if (!partChannel.has(part.id)) {
      let ch;
      if (part.midiChannel != null) ch = part.midiChannel + 1;
      else if (perc) ch = 10;
      else { ch = (channel % 15) + 1; if (ch >= 10) ch++; channel++; }
      partChannel.set(part.id, Math.max(1, Math.min(16, ch)));
    }
    const lastOfPart = staffIndex === part.staves.length - 1;
    for (let vi = 0; vi < NV[g]; vi++) {
      const lastLayer = vi === NV[g] - 1;
      const st = {
        name: (part.name || 'Staff') + (part.staves.length > 1 ? ` ${staffIndex + 1}` : '') + (vi ? ` (${vi + 1})` : ''),
        label: vi === 0 && staffIndex === 0 ? (part.name || '') : '', labelAbbr: vi === 0 && staffIndex === 0 ? (part.abbreviation || '') : '', group: 'Standard',
        visible: true, endingBar: 'Section Close', muted: false,
        volume: part.volume != null ? Math.max(0, Math.min(127, Math.round(part.volume * 127))) : 127,
        pan: part.pan != null ? Math.max(0, Math.min(127, Math.round(64 + part.pan * 63))) : 64,
        channel: partChannel.get(part.id), device: 0, boundaryTop: 12, boundaryBottom: 12, lines: staff.lines === 1 ? 1 : 5,
        withNext: { bracket: false, brace: !lastOfPart, connectBars: !lastOfPart, layer: !lastLayer },
        instrument: { patch: perc ? 0 : (part.midiProgram || 0) & 127, trans: perc ? 0 : (part.transposeChromatic || 0) },
        lyrics: { placement: 'Bottom', align: 'Standard Rules', offset: 0 }, lyricLines: [], items: [],
      };
      buildStream(st, g, vi, staff, perc);
      doc.staves.push(st);
    }
  });
  return doc;

  // -------------------------------------------------------------------------------------------
  function buildStream(st, g, vi, staff, perc) {
    const items = st.items;
    const top = g === 0 && vi === 0;
    const multi = NV[g] > 1;
    const list = streams[g][vi];
    const S = { clef: 'Treble', octave: 0, center: 34, key: {}, run: {}, ties: new Map(), slurState: false };
    // lyrics of this stream
    let lastLyric = -1, nVerses = 0;
    list.forEach((r) => {
      const ls = (r.ev.lyrics || []).filter(l => l && l.text && l.verse >= 1);
      if (!ls.length) return;
      lastLyric = r.k;
      for (const l of ls) { if (l.verse > 8) warn(W.verses); else nVerses = Math.max(nVerses, l.verse); }
    });
    const verses = Array.from({ length: nVerses }, () => ({ text: '', joins: false, mi: -1, any: false, pendingSkips: '' }));
    const addSyllables = (ev, mi) => {
      const by = new Map((ev.lyrics || []).filter(l => l && l.text && l.verse >= 1 && l.verse <= 8).map(l => [l.verse, l]));
      verses.forEach((v, i) => {
        const l = by.get(i + 1);
        let body = '_';
        if (l) {
          const raw = String(l.text).replace(/\s/g, '_');
          // a hyphen NWC would read as "next syllable of the word" is written as a typographic hyphen
          // (U+2010); runs of hyphens at the end of a syllable ("Oh---") are plain text for NWC too
          body = raw.replace(/-/g, (c, at) => (raw.length > 1 && at < raw.length - 1 && raw[at + 1] !== '-' ? String.fromCharCode(0x2010) : c));
        }
        const sep = !v.any ? '' : v.joins ? '-' : (Math.floor(mi / 4) !== Math.floor(v.mi / 4) ? '\n' : ' ');     // a new line every four bars
        if (!l) { v.pendingSkips += sep + body; v.mi = mi; v.any = true; return; }      // kept only if a syllable follows
        v.text += v.pendingSkips + sep + body; v.pendingSkips = '';
        v.any = true; v.mi = mi;
        v.joins = l.syllabic === 'begin' || l.syllabic === 'middle';
      });
    };

    const setClef = (name) => {
      const [clef, octave] = CLEF_OF[name] || CLEF_OF.treble;
      S.clef = clef; S.octave = octave; S.center = CLEF_CENTER[clef] + 7 * octave;
      const it = { type: 'Clef', clef, octave };
      items.push(it);
    };
    const hiddenRest = (p) => ({ type: 'Rest', dur: { base: p.base, dots: p.dots, ...(p.triplet ? { triplet: p.triplet } : {}) }, opts: {}, visibility: 'Never' });
    const timedMeta = (it, { isNote = false, grace = false, tiedIn = false, slur = false, ev = null, k = -1, mi = 0 } = {}) => {
      const takes = isNote && !grace && !tiedIn && !S.slurState;
      if (nVerses && k >= 0 && k <= lastLyric) {
        // (a rest takes a syllable only when told to — NWC files do carry lyrics on rests that way)
        const wants = !!ev && (ev.lyrics || []).some(l => l && l.text && l.verse >= 1 && l.verse <= 8);
        if (wants) { if (!takes) it.opts.lyric = 'Always'; addSyllables(ev, mi); }
        else if (takes) it.opts.lyric = 'Never';
      }
      if (!grace) S.slurState = slur;
    };

    let carry = 0;
    for (let mi = 0; mi < M.length; mi++) {
      const m = M[mi], sm = m.staves[g] || { voices: [[]] };
      const voice = (sm.voices && sm.voices[vi]) || [];
      const len = LEN[mi], cap = measureCapacity(TS[mi]);
      // ---- signatures
      if (mi === 0 || sm.clef) setClef(mi === 0 ? (sm.clef || staff.clef || 'treble') : sm.clef);
      if ((mi === 0 || m.keySig) && !perc) {
        const f = Math.max(-7, Math.min(7, KEY[mi].fifths || 0));
        const alters = {};
        if (f > 0) SHARPS.slice(0, f).forEach(n => { alters[n] = 1; }); else FLATS.slice(0, -f).forEach(n => { alters[n] = -1; });
        S.key = alters;
        items.push({ type: 'Key', alters: { ...alters }, tonic: KEY[mi].mode === 'minor' ? MINOR_TONIC(f) : MAJOR_TONIC(f) });
      }
      S.run = { ...S.key };
      if (mi === 0 || m.timeSig) {
        const ts = TS[mi];
        items.push({ type: 'TimeSig', num: ts.num, den: ts.den, style: ts.display === 'common' && ts.num === 4 && ts.den === 4 ? 'Common' : ts.display === 'cut' && ts.num === 2 && ts.den === 2 ? 'AllaBreve' : 'Standard' });
      }
      if (mi === 0) {
        if (localOpen.has(0)) items.push({ type: 'Bar', style: 'LocalRepeatOpen' });
        else if (m.barlineLeft === 'repeat-start') items.push({ type: 'Bar', style: 'MasterRepeatOpen' });
        else if (m.barlineLeft === 'double') items.push({ type: 'Bar', style: 'SectionOpen' });
      }
      if (top && m.tempo && m.tempo.bpm > 0) {
        const t = m.tempo;
        let base = TEMPO_BASE[`${t.beatUnit || 'quarter'}:${t.dots || 0}`], bpm = Math.round(t.bpm);
        if (!base) { base = 'Quarter'; bpm = Math.max(20, Math.min(750, Math.round(t.bpm * durTicks({ dur: { base: t.beatUnit || 'quarter', dots: t.dots || 0 } }) / 960))); }
        const it = { type: 'Tempo', bpm, base, text: t.text || '', pos: 10 };
        if (t.showBpm === false && !t.text) it.visibility = 'Never';
        items.push(it);
      }
      if (voltaAt.has(mi)) items.push({ ...voltaAt.get(mi), endings: [...voltaAt.get(mi).endings] });
      for (const mk of m.markers || []) if (mk === 'segno' || mk === 'coda') items.push({ type: 'Flow', style: FLOW_OF[mk], pos: 8, wide: true, visibility: 'TopStaff' });
      if (top && m.rehearsalMark) items.push({ type: 'Text', text: `[${m.rehearsalMark}]`, font: 'StaffBold', pos: 12 });
      if (vi === 0) for (const t of m.texts || []) if ((t.staffIndex || 0) === g && t.text) items.push(textItem(t));

      // ---- chord symbols: text above the top staff, in front of the note they start with
      let chordAt = null, restCuts = null;
      if (top && m.chords && m.chords.length) {
        const cs = [...m.chords].filter(c => c && c.text).sort((a, b) => a.tick - b.tick);
        if (!voice.some(ev => !ev.grace) || isBarRest(voice)) {
          // nothing but a bar of rest: cut the rest where the chords change
          restCuts = [...new Set([0, ...cs.map(c => Math.max(0, Math.min(len - 60, Math.round(c.tick / 60) * 60)))])].sort((a, b) => a - b);
          chordAt = new Map();
          for (const c of cs) { const t = Math.max(0, Math.min(len - 60, Math.round(c.tick / 60) * 60)); chordAt.set(t, [...(chordAt.get(t) || []), c]); }
        } else {
          chordAt = new Map();
          let t = 0; const starts = [];
          voice.forEach((ev, i) => { if (!ev.grace) { starts.push({ i, t, end: t + durTicks(ev) }); t += durTicks(ev); } });
          // A chord that starts with a note stands in front of that note. Chords between notes ride
          // on the chord before them when NWC's habit — several names in one text, spread over the
          // rest of the bar — puts them back in place; otherwise they move to the note they sound in.
          const anchor = (c) => starts.find(s => Math.abs(c.tick - s.t) <= 1);
          const put = (i, list2) => chordAt.set(i, [...(chordAt.get(i) || []), ...list2]);
          for (let k = 0; k < cs.length;) {
            const a = anchor(cs[k]);
            if (a) {
              let e = k + 1; while (e < cs.length && !anchor(cs[e])) e++;
              const n = e - k;
              const even = n > 1 && cs.slice(k, e).every((c, j) => Math.abs(Math.round((a.t + (len - a.t) * j / n) / 240) * 240 - c.tick) <= 1);
              if (even) { put(a.i, cs.slice(k, e)); k = e; } else { put(a.i, [cs[k]]); k++; }
              continue;
            }
            const hit = starts.find(s => cs[k].tick >= s.t - 1 && cs[k].tick < s.end - 1) || starts[starts.length - 1];
            warn(W.chordMoved);
            put(hit.i, [cs[k]]); k++;
          }
        }
      }
      // chord names: one text object (several names spaced out, the way NWC users type them), or
      // objects of NWC 2.75's chord plugin
      const chordText = (list2) => {
        if (opts.chords !== 'plugin') return [{ type: 'Text', text: list2.map(c => c.text).join('     '), font: 'StaffBold', pos: 9 }];
        if (list2.length > 1) warn(W.chordMoved);
        return list2.map(c => ({ type: 'User', userType: 'ChordPlay.nw', pos: 8, props: { Name: c.text } }));
      };

      // ---- events. `have` starts at what the previous bar of this voice ran over the bar line.
      let have = carry; carry = 0;
      const real = voice.filter(ev => !ev.grace);
      if (have > 0 && (!real.length || isBarRest(voice))) {
        const hidden = vi > 0 || !!(real[0] && real[0].hidden);
        for (const p of splitTicks(Math.max(0, len - have))) { const it = hiddenRest(p); if (!hidden) delete it.visibility; items.push(it); timedMeta(it, {}); }
        have = Math.max(have, len);
      } else if (!real.length || isBarRest(voice)) {
        // an empty bar: NWC stretches a whole rest that stands alone over the bar, whatever the meter
        const hidden = (vi > 0 && !real.length) || !!(real[0] && real[0].hidden);
        const rec = real[0] ? where.get(real[0].id) : null;
        let firstRest = true;
        const rest = (p) => {
          const it = hiddenRest(p);
          if (!hidden) delete it.visibility;
          if (real[0] && cresc.has(real[0].id)) it.opts.crescendo = true; else if (real[0] && dim.has(real[0].id)) it.opts.diminuendo = true;
          items.push(it); timedMeta(it, { ev: firstRest ? real[0] || null : null, k: rec ? rec.k : -1, mi });
          firstRest = false;
        };
        if (restCuts && restCuts.length > 1) {
          restCuts.forEach((t, k) => {
            const end = k + 1 < restCuts.length ? restCuts[k + 1] : len;
            if (chordAt.get(t)) items.push(...chordText(chordAt.get(t)));
            if (k === 0 && real[0]) before(real[0], items);
            splitTicks(end - t).forEach(rest);
          });
        } else {
          if (chordAt && chordAt.get(0)) items.push(...chordText(chordAt.get(0)));
          if (real[0]) before(real[0], items);
          (Math.abs(len - cap) < 1 ? [{ base: 0, dots: 0 }] : splitTicks(len)).forEach(rest);
        }
        if (real[0]) after(real[0], items);
        have = len;
      } else {
        const plan = planVoice(voice, warn);
        const beamOf = new Map(), stemOf = new Map();
        for (const grp of planBeams(voice, plan, TS[mi])) {
          let stem = null;
          const stems = new Set(grp.map(i => voice[i].stem || ''));
          if (stems.size === 1 && voice[grp[0]].stem) stem = voice[grp[0]].stem === 'up' ? 'Up' : 'Down';
          else if (multi) stem = vi % 2 ? 'Down' : 'Up';
          else {
            let far = 0;
            for (const i of grp) for (const n of voice[i].notes || []) { const p = perc ? drumHead(n, staff).pos : posOf(n); if (Math.abs(p) > Math.abs(far)) far = p; }
            stem = far >= 0 ? 'Down' : 'Up';
          }
          grp.forEach((i, k) => { beamOf.set(i, k === 0 ? 'First' : k === grp.length - 1 ? 'End' : 'Mid'); stemOf.set(i, stem); });
        }
        // hidden rests at the start make room for what hangs over from the previous bar
        let skip = 0;
        if (have > 0) {
          let room = 0;
          while (skip < voice.length && room < have - 1 && voice[skip].kind === 'rest' && voice[skip].hidden && !voice[skip].grace && !(chordAt && chordAt.get(skip))) { room += plan[skip].ticks; skip++; }
          if (room > have) for (const p of splitTicks(room - have)) { const it = hiddenRest(p); items.push(it); timedMeta(it, {}); }
          have = Math.max(have, room);
        }
        // A voice that runs over the bar line needs room at the start of its next bar (hidden rests
        // or nothing at all); without it the whole staff would fall behind, so the note is cut.
        {
          let total = have; for (let i = skip; i < voice.length; i++) total += plan[i].ticks;
          let over = total - len;
          const nextVoice = M[mi + 1] && ((M[mi + 1].staves[g] && M[mi + 1].staves[g].voices && M[mi + 1].staves[g].voices[vi]) || []);
          if (over > 1 && nextVoice) {
            let room = 0;
            if (!nextVoice.some(ev => !ev.grace) || isBarRest(nextVoice)) room = LEN[mi + 1];
            else for (const ev of nextVoice) { if (ev.kind === 'rest' && ev.hidden && !ev.grace) room += durTicks(ev); else break; }
            if (room < over - 1) {
              warn(W.cut);
              for (let i = voice.length - 1; i >= skip && over > 1; i--) {
                if (voice[i].grace) continue;
                const t = plan[i].ticks;
                if (t - over >= 60) { plan[i] = { ...plan[i], pieces: splitTicks(t - over), ticks: Math.round(t - over), approx: true }; over = 0; }
                else { plan[i] = { ...plan[i], drop: true, ticks: 0 }; over -= t; }
              }
            }
          }
        }
        voice.forEach((ev, i) => {
          if (i < skip || plan[i].drop) return;
          const rec = where.get(ev.id);
          if (chordAt && chordAt.get(i)) items.push(...chordText(chordAt.get(i)));
          before(ev, items);
          const pieces = plan[i].pieces;
          pieces.forEach((p, pk) => {
            const lastPiece = pk === pieces.length - 1;
            const dur = { base: p.base, dots: p.dots };
            if (p.triplet) dur.triplet = p.triplet;
            if (ev.grace) dur.grace = true;
            const opts = {};
            let it;
            if (ev.kind === 'note' && ev.notes && ev.notes.length) {
              if (slurOut.has(ev.id)) dur.slur = true;
              for (const a of ev.articulations || []) {
                if (/staccatissimo/.test(a)) dur.staccatissimo = true; else if (/staccato/.test(a)) dur.staccato = true;
                if (/tenuto/.test(a)) dur.tenuto = true;
                if (/accent/.test(a)) dur.accent = true;
                if (/marcato/.test(a)) dur.marcato = true;
              }
              const stem = stemOf.get(i) || (ev.stem === 'up' ? 'Up' : ev.stem === 'down' ? 'Down' : multi ? (vi % 2 ? 'Down' : 'Up') : null);
              if (stem) opts.stem = stem;
              if (cresc.has(ev.id)) opts.crescendo = true; else if (dim.has(ev.id)) opts.diminuendo = true;
              if (pk === 0 && slurDir.has(ev.id)) opts.slurDir = slurDir.get(ev.id);
              if (beamOf.has(i) && pieces.length === 1) opts.beam = beamOf.get(i);
              // heads: position, accidental, tie
              const heads = []; const seen = new Set(); const changes = {}; let tiedIn = false;
              for (const n of ev.notes) {
                let pos, step, alter, head = null;
                if (perc) ({ pos, step, alter, head } = drumHead(n, staff));
                else {
                  pos = posOf(n) + 7 * (ottava.get(ev.id) || 0) / 12; step = n.step; alter = n.alter || 0;
                  if (n.head === 'x') head = 'x'; else if (n.head === 'circle-x') head = 'X'; else if (n.head && n.head !== 'normal') warn(W.heads);
                }
                if (seen.has(pos)) { warn(W.unison); continue; }
                seen.add(pos);
                const tieOut = !lastPiece || !!n.tieStart;
                const running = S.ties.get(pos);
                const receives = running != null && running === alter;
                let acc = '';
                if (running != null) { if (running !== alter) acc = ACC_CHAR[alter]; }
                else if (alter !== (S.run[step] || 0)) acc = ACC_CHAR[alter];
                if (!acc && pk === 0 && n.accidental && n.accidental !== 'none') acc = ACC_CHAR[alter];
                if (acc) changes[step] = alter;
                if (receives) { tiedIn = true; if (!tieOut) S.ties.delete(pos); }
                else { if (running != null) S.ties.delete(pos); if (tieOut) S.ties.set(pos, alter); }
                const h = { pos, acc };
                if (head) h.head = head;
                if (tieOut) h.tie = true;
                heads.push(h);
              }
              Object.assign(S.run, changes);
              heads.sort((a, b) => a.pos - b.pos);
              it = { type: heads.length > 1 ? 'Chord' : 'Note', dur, opts, notes: heads };
              if (ev.hidden) it.visibility = 'Never';
              items.push(it);
              timedMeta(it, { isNote: true, grace: !!ev.grace, tiedIn, slur: !!dur.slur, ev: pk === 0 ? ev : null, k: rec.k, mi });
            } else {
              if (cresc.has(ev.id)) opts.crescendo = true; else if (dim.has(ev.id)) opts.diminuendo = true;
              if (slurOut.has(ev.id)) dur.slur = true;
              it = { type: 'Rest', dur, opts };
              if (ev.hidden) it.visibility = 'Never';
              items.push(it);
              timedMeta(it, { grace: !!ev.grace, slur: !!dur.slur, ev: pk === 0 ? ev : null, k: rec.k, mi });
            }
          });
          after(ev, items);
          have += plan[i].ticks;
        });
      }
      // ---- every staff is as long as the bar
      if (have < len - 1) for (const p of splitTicks(len - have)) { const it = hiddenRest(p); items.push(it); timedMeta(it, {}); }
      else if (have > len + 1) carry = have - len;

      // ---- end of the bar
      for (const mk of m.markers || []) if (mk !== 'segno' && mk !== 'coda' && FLOW_OF[mk]) items.push({ type: 'Flow', style: FLOW_OF[mk], pos: 8, wide: true, visibility: 'TopStaff' });
      const right = m.barlineRight || 'single';
      const next = M[mi + 1];
      if (!next) {
        st.endingBar = right === 'final' ? 'Section Close' : right === 'double' ? 'Double' : right === 'repeat-end' || right === 'repeat-both' ? 'Master Repeat Close' : right === 'none' ? 'Open (hidden)' : 'Single';
        // the staff's own ending bar cannot count repeats: write the bar line, hide the ending bar
        if (localClose.has(mi)) { items.push({ type: 'Bar', style: 'LocalRepeatClose', repeat: m.repeatCount }); st.endingBar = 'Open (hidden)'; }
        break;
      }
      const bars = [];
      const closeStyle = localClose.has(mi) ? 'LocalRepeatClose' : 'MasterRepeatClose';
      if (right === 'double') bars.push({ type: 'Bar', style: 'Double' });
      else if (right === 'final') bars.push({ type: 'Bar', style: 'SectionClose' });
      else if (right === 'repeat-end' || right === 'repeat-both') bars.push({ type: 'Bar', style: closeStyle, ...(closeStyle === 'LocalRepeatClose' ? { repeat: m.repeatCount } : {}) });
      else if (right === 'dashed') bars.push({ type: 'Bar', style: 'BrokenSingle' });
      else if (right === 'none') bars.push({ type: 'Bar', style: 'Transparent' });
      const opens = right === 'repeat-both' || next.barlineLeft === 'repeat-start' || localOpen.has(mi + 1);
      if (opens) bars.push({ type: 'Bar', style: localOpen.has(mi + 1) ? 'LocalRepeatOpen' : 'MasterRepeatOpen' });
      else if (next.barlineLeft === 'double') bars.push({ type: 'Bar', style: 'SectionOpen' });
      if (!bars.length) bars.push({ type: 'Bar', style: 'Single' });
      if (m.breaks && (m.breaks.system || m.breaks.page)) bars[0].sysBreak = true;
      items.push(...bars);
      if (top && m.breaks && m.breaks.page) items.push({ type: 'Boundary', style: 'NewSystem', newPage: true });
    }

    // ---- lyric lines
    st.lyricLines = verses.map(v => ({ text: v.text }));
    while (st.lyricLines.length && !st.lyricLines[st.lyricLines.length - 1].text) st.lyricLines.pop();

    // ---- helpers bound to this stream
    function posOf(n) { return n.octave * 7 + STEPS.indexOf(n.step) - S.center; }
    function before(ev, out) {
      if (pedalDown.has(ev.id)) out.push({ type: 'SustainPedal', released: false, pos: -10 });
      if (ev.dynamic) {
        if (DYNAMICS.has(ev.dynamic)) out.push({ type: 'Dynamic', style: ev.dynamic, pos: -8 });
        else if (ev.dynamic === 'sfz') out.push({ type: 'DynamicVariance', style: 'Sforzando', pos: -8 });
        else if (ev.dynamic === 'rfz') out.push({ type: 'DynamicVariance', style: 'Rinforzando', pos: -8 });
        else { out.push({ type: 'Text', text: ev.dynamic, font: 'StaffItalic', pos: -8 }); warn(W.dynamics); }
      }
      for (const t of ev.texts || []) if (t && t.text) out.push(textItem(t));
      for (const o of ev.ornaments || []) { out.push({ type: 'Text', text: ORNAMENT_TEXT[o] || o, font: 'StaffItalic', pos: 9 }); warn(W.ornaments); }
      if (ev.arpeggio || ev.tremolo) warn(W.ornaments);
      if (ev.fermata) out.push({ type: 'TempoVariance', style: 'Fermata', pause: 3, pos: ev.fermata === 'below' ? -9 : 9, justify: 'Center', placement: 'AtNextNote' });
    }
    function after(ev, out) {
      if (pedalUp.has(ev.id)) out.push({ type: 'SustainPedal', released: true, pos: -10 });
    }
  }

  function textItem(t) {
    const font = t.style === 'expression' ? 'StaffItalic' : t.style === 'technique' || t.style === 'system' ? 'StaffBold' : 'PageSmallText';
    return { type: 'Text', text: String(t.text), font, pos: t.placement === 'below' ? -9 : 9 };
  }
  /** Percussion: NWC plays a percussion staff by bass-clef pitch, so the GM drum note decides the line. */
  function drumHead(n, staff) {
    const d = (staff.drumMap && staff.drumMap[n.drum]) || null;
    const midi = d && d.midi != null ? d.midi : 38;
    const p = noteFromMidi(midi, 0);
    const shape = (d && d.head) || n.head;
    return { pos: p.octave * 7 + STEPS.indexOf(p.step) - CLEF_CENTER.Percussion, step: p.step, alter: p.alter || 0, head: shape === 'x' ? 'x' : shape === 'circle-x' ? 'X' : null };
  }
}

/** ScoreDoc → nwctxt (NWC 2.75 text, UTF-8 when written to a file). */
export function scoreToNwctxt(score, opts = {}) {
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  return writeNwctxt(scoreToNwcDoc(score, warnings, opts));
}

const HEADER = '[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0';
const latin = (s) => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * The .nwc file NWC 2.75 writes: a short binary header (product strings, version 2.75, a random
 * 128-bit document id, save date, the ANSI code page of the system) followed by the nwctxt in
 * UTF-8. Layout established from 436 files saved by NWC 2.75 (see tools/nwc/README.md).
 */
export function nwc275Bytes(text, { id = randomId(), date = new Date(), codePage } = {}) {
  const cp = codePage || (HANGUL_RE.test(text) ? 949 : 1252);
  const dos = date ? (((date.getFullYear() - 1980) & 127) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() : 0;
  return concat([
    latin(HEADER), Uint8Array.of(0x4b, 0x02, 0x02, 0, 0, 0), latin('N/A\0'), latin(String(id).slice(0, 22).padEnd(22, '0') + '\0'),
    Uint8Array.of(dos & 255, (dos >> 8) & 255, cp & 255, (cp >> 8) & 255, 0, 0, 0, 0, 0x24, 0x00),
    new TextEncoder().encode(text),
  ]);
}

/**
 * ScoreDoc → .nwc file bytes.
 * @param opts.version   '2.75' (default) or '1.75' (old binary format, text in a Windows code page)
 * @param opts.compress  true (default): "[NWZ]" + zlib, the way NWC saves
 * @param opts.encoding  1.75 only: 'euc-kr' (default when the score has Hangul) or 'windows-1252'
 * @param opts.warnings  array that receives Korean notes about approximations
 */
export async function scoreToNwcFile(score, opts = {}) {
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  const old = String(opts.version || '2.75') === '1.75';
  const doc = scoreToNwcDoc(score, warnings, old ? { ...opts, chords: 'text' } : opts);
  let plain;
  if (old) {
    const encoding = opts.encoding && opts.encoding !== 'auto' ? opts.encoding : (doc.hasHangul ? 'euc-kr' : 'windows-1252');
    plain = writeNwc175(doc, { encoding, warnings });
  } else plain = nwc275Bytes(writeNwctxt(doc), { id: opts.id, date: opts.date === undefined ? new Date() : opts.date, codePage: opts.codePage });
  if (opts.compress === false) return plain;
  return concat([latin('[NWZ]\0'), await deflateZlib(plain)]);
}
