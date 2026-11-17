// JSE — NWC document → NoteWorthy Composer 1.75 file (the old binary format, uncompressed bytes).
//
// The inverse of nwc-binary.js for format version 1.75, the last version of the 1.x line and the
// one old Korean NWC installations still use. Text is written in a Windows code page (CP949 for
// Korean). The layout is the one nwc-binary.js reads; values of bytes that reader skips were
// taken from what the 106 files of that version in the test corpus hold in the same place
// (see tools/nwc/README.md). What 1.75 cannot express is written as the nearest thing it has:
//   staccatissimo → staccato, marcato → accent, hairpin flags → "cresc." / "dim." marks,
//   broken and transparent bar lines → single / double, percussion clef → bass clef (same pitches),
//   staff labels, lyricist field, noteheads, system/page breaks by boundary object → dropped.

import { encodeText, charSetOfEncoding } from './nwc-encoding.js';
import { FLOW_STYLES, TEMPO_BASES, DYN_VARIANCES, PERFORMANCE_STYLES, FONT_STYLES, ENDING_BARS, MEASURE_NUMBERS, STAFF_LABELS, DYNAMICS } from './nwc-binary.js';

const HEADER = '[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0';
const BAR_STYLES_OLD = ['Single', 'Double', 'SectionOpen', 'SectionClose', 'LocalRepeatOpen', 'LocalRepeatClose', 'MasterRepeatOpen', 'MasterRepeatClose'];
const BAR_FALLBACK = { BrokenSingle: 'Single', BrokenDouble: 'Double', Transparent: 'Single' };
const TEMPO_VARIANCES_OLD = ['Breath Mark', 'Fermata', 'Accelerando', 'Allargando', 'Rallentando', 'Ritardando', 'Ritenuto', 'Rubato', 'Stringendo'];
const CLEF_INDEX = { Treble: 0, Bass: 1, Alto: 2, Tenor: 3, Percussion: 1 };
const DYN_VELOCITY = [10, 30, 45, 60, 75, 92, 108, 127];
const ACC_INDEX = { '#': 0, b: 1, n: 2, x: 3, v: 4, '': 5 };
const MARK = { First: 1, Mid: 2, End: 3 };
const VISIBILITY = { Default: 0, Always: 1, TopStaff: 2, Never: 3 };
const W_LOST = '선택한 문자 인코딩에 없는 글자는 ?로 저장했습니다';
const W_OLD = 'NWC 1.75에 없는 기호(스타카티시모, 마르카토, 크레셴도 선, 점선 세로줄 등)는 가장 가까운 기호로 저장했습니다';

class Out {
  constructor(encoding) { this.b = []; this.encoding = encoding; this.lost = 0; }
  u8(v) { this.b.push(v & 255); return this; }
  i8(v) { return this.u8(Math.max(-128, Math.min(127, Math.round(v)))); }
  u16(v) { this.b.push(v & 255, (v >> 8) & 255); return this; }
  i16(v) { return this.u16(Math.max(-32768, Math.min(32767, Math.round(v)))); }
  raw(bytes) { for (const x of bytes) this.b.push(x & 255); return this; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255); return this; }
  encode(text) {
    // U+2010 (the hyphen the exporter uses inside a syllable) has no code in the ANSI pages
    const { bytes, lost } = encodeText(String(text == null ? '' : text).replace(/‐/g, '­'), this.encoding);
    this.lost += lost;
    return [...bytes].filter(x => x !== 0);
  }
  z(text) { this.raw(this.encode(text)); this.b.push(0); return this; }
}

/** Lyric text of the editor → the syllables NWC keeps in the file, each with the separator typed before it. */
function lyricSyllables(text) {
  const out = [];
  const re = /(\s*)(\S+)/g; let m;
  while ((m = re.exec(String(text || '')))) {
    const ws = m[1], word = m[2];
    // (a text that begins with a skipped note: the blank that "_" stands for must not be taken for a separator)
    const sep = !out.length && !ws ? (word[0] === '_' ? ' ' : '') : /\n\s*\n/.test(ws) ? '\n' : /\n/.test(ws) ? '\r' : ws ? ' ' : '';
    let start = 0; const pieces = [];
    for (let i = 1; i < word.length - 1; i++) if (word[i] === '-' && word[i + 1] !== '-') { pieces.push(word.slice(start, i)); start = i; }
    pieces.push(word.slice(start));
    pieces.forEach((p, k) => out.push((k === 0 ? sep : '') + p.replace(/_/g, ' ')));
  }
  return out;
}

/**
 * @param doc              NWC document (scoreToNwcDoc / parseNwctxt)
 * @param opts.encoding    'euc-kr' (CP949) or 'windows-1252'
 * @param opts.warnings    array for Korean notes about what could not be written
 * @returns {Uint8Array}   the file as NWC 1.75 writes it before compression
 */
export function writeNwc175(doc, { encoding = 'euc-kr', warnings = [] } = {}) {
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  const o = new Out(encoding);
  const info = doc.info || {}, page = doc.page || {};
  const staves = (doc.staves || []).slice(0, 255);
  o.ascii(HEADER).u8(75).u8(1);                              // version 1.75
  o.raw([2, 0, 0, 0]).ascii('N/A\0').ascii('Jse\0');         // user name (1.75 never stores it), writer id
  o.raw([0, 0, 0, 0, 0, 0, 0, 0]).u16(16);
  const comments = [info.comments, info.lyricist ? `Lyricist: ${info.lyricist}` : ''].filter(Boolean).join('\r\n');
  o.z(info.title).z(info.author).z(info.copyright1).z(info.copyright2).z(comments);
  o.ascii(page.extendLastSystem ? 'Y' : 'N').ascii(page.durationPadding === false ? 'N' : 'Y');
  o.raw([0x5f, 0x00, 0x46, 0x32, 0x00]);
  o.u8(Math.max(0, MEASURE_NUMBERS.indexOf(page.barNumbers))).u8(0).i16(page.startingBar || 1);
  const mg = page.margins || { top: 1.27, left: 1.27, right: 1.27, bottom: 1.27 };
  o.ascii([mg.top, mg.left, mg.right, mg.bottom].map(v => (v / 2.54).toFixed(8)).join(' ') + '\0');   // inches
  o.u8(page.mirrorMargins ? 1 : 0).u8(6).u8(0);
  const visible = new Uint8Array(32);
  staves.forEach((st, i) => { if (st.visible !== false) visible[i >> 3] |= 1 << (i & 7); });
  o.raw(visible);
  o.u8(staves.some(st => st.withNext && st.withNext.layer) ? 0xff : 0);
  o.i16(Math.max(4, Math.min(100, Math.round(page.staffSize || 16))));
  const fonts = new Map((doc.fonts || []).map(f => [f.style, f]));
  const defaults = { StaffItalic: [10, 3], StaffBold: [8, 1], StaffLyric: [7, 0], PageTitleText: [24, 1], PageText: [12, 0], PageSmallText: [8, 0] };
  const charSet = charSetOfEncoding(encoding);
  for (const style of FONT_STYLES) {
    const d = defaults[style] || [8, 0];
    const f = fonts.get(style);
    const face = o.encode((f && f.typeface) || 'Times New Roman').slice(0, 31);
    o.raw(face).u8(0);
    o.u8(f ? (f.bold ? 1 : 0) | (f.italic ? 2 : 0) : d[1]).u8(Math.max(1, Math.min(127, Math.round((f && f.size) || d[0])))).u8(0).u8((f && f.charSet) || charSet);
  }
  o.u8(page.titlePage === false ? 0 : 0xff).u8(Math.max(0, STAFF_LABELS.indexOf(page.staffLabels))).i16(page.pageNumbers || 0);
  o.i16(staves.length);

  let lower = false;                                         // inside the lower half of a grand staff
  let old = false;
  staves.forEach((st, si) => {
    const w = st.withNext || {};
    o.z(st.name || `Staff ${si + 1}`).z(st.group || 'Standard');
    o.u8(Math.max(0, ENDING_BARS.indexOf(st.endingBar))).u8(st.muted ? 1 : 0).u8(0);
    o.u8(Math.max(0, Math.min(15, (st.channel || 1) - 1))).u8(0).u8(st.device || 0).u8(0);
    o.u8(0).raw([0, 0, 0]).u8(((st.instrument && st.instrument.patch) || 0) & 127).u8(0);
    // 1.x names the halves of a grand staff; staves layered onto a half belong to it
    const style = w.brace ? 1 : lower ? 2 : w.bracket ? 3 : 0;
    if (w.brace) lower = !w.layer; else if (lower) lower = !!w.layer;
    o.i16(style).i16(-(st.boundaryTop || 12)).i16(st.boundaryBottom || 12).u8(st.lines === 1 ? 1 : 5);
    o.i16(w.layer ? 1 : 0).i16((st.instrument && st.instrument.trans) || 0);
    o.i16(st.volume == null ? 127 : st.volume).i16(st.pan == null ? 64 : st.pan).u8(0).i16(1);
    // lyrics: one block per verse, 1024 bytes at a time
    const lines = (st.lyricLines || []).map(l => (l && l.text) || '');
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    lines.length = Math.min(8, lines.length);
    o.i16(lines.length);
    if (lines.length) o.i16(2).i16((st.lyrics && st.lyrics.offset) || 0);
    for (const text of lines) {
      const block = [0, 1];
      for (const syl of lyricSyllables(text)) { block.push(...o.encode(syl)); block.push(0); }
      const size = Math.ceil((block.length + 1) / 1024) * 1024;
      if (size > 0xfc00) { block.length = 0xfc00 - 1; block.push(0); }
      o.u16(Math.min(size, 0xfc00)).u16(block.length).raw(block).raw(new Uint8Array(Math.min(size, 0xfc00) - block.length));
    }
    if (lines.length) o.u16(0);
    o.u16(0);
    // objects
    const body = new Out(encoding);
    const count = writeItems(body, st.items || []);
    o.lost += body.lost;
    o.u16(count + 2).raw(body.b);
  });
  if (o.lost) warn(W_LOST);
  if (old) warn(W_OLD);
  return Uint8Array.from(o.b);

  // ---------------------------------------------------------------------------------------------
  function writeItems(out, items) {
    let count = 0;
    const pending = new Set();                               // staff positions with a tie running into the next note
    let slurIn = false, hairpin = null;
    const head = (type, it) => out.u16(type).u8(VISIBILITY[it.visibility] || 0);
    const expr = (it, defPos = 8) => {
      const j = ['Left', 'Center', 'Right'].indexOf(it.justify || 'Left'), p = ['BestFit', 'BestFitForward', 'AsStaffSignature', 'AtNextNote'].indexOf(it.placement || 'BestFit');
      out.i8(-(it.pos == null ? defPos : it.pos)).u8((it.wide ? 1 : 0) | (Math.max(0, j) << 1) | (Math.max(0, p) << 3));
    };
    /** The eight bytes of a note / chord member. */
    const noteBytes = (dur, opts, h, { member = false, stem = 0, beamTrip = true, slurred = false } = {}) => {
      const tieIn = pending.has(h.pos);
      const dots = dur.dots || 0;
      if (dur.staccatissimo || dur.marcato) old = true;
      const up = stem ? stem === 1 : h.pos <= 0;
      return [
        Math.max(0, Math.min(6, dur.base)), 0,
        (beamTrip ? (MARK[opts.beam] || 0) | ((MARK[dur.triplet] || 0) << 2) : 0) | (stem << 4) | (!member && opts.lyric === 'Always' ? 0x80 : 0),
        !member && opts.lyric === 'Never' ? 1 : 0,
        (dots === 2 ? 1 : 0) | (dur.staccato || dur.staccatissimo ? 2 : 0) | (dots === 1 ? 4 : 0) | (tieIn ? 8 : 0) | (h.tie ? 0x10 : 0) | (dur.accent || dur.marcato ? 0x20 : 0) | (member ? 0x40 : 0),
        (dur.slur ? 1 : 0) | (slurred ? 2 : 0) | (dur.tenuto ? 4 : 0) | (dur.grace ? 0x20 : 0),
        (256 - h.pos) & 255,
        (ACC_INDEX[h.acc || ''] == null ? 5 : ACC_INDEX[h.acc || '']) | (up ? 8 : 0),
      ];
    };
    for (const it of items) {
      // hairpins are flags on notes in NWC 2; 1.75 only has the written-out marks
      if (it.dur && it.type !== 'RestChord') {
        const hp = it.opts && it.opts.crescendo ? 'Crescendo' : it.opts && it.opts.diminuendo ? 'Diminuendo' : null;
        if (hp && hp !== hairpin) { out.u16(15).u8(0).i8(8).u8(0).u8(DYN_VARIANCES.indexOf(hp)); count++; old = true; }
        hairpin = hp;
      }
      switch (it.type) {
        case 'Clef': head(0, it).u16(CLEF_INDEX[it.clef] || 0).u16(it.octave > 0 ? 1 : it.octave < 0 ? 2 : 0); break;
        case 'Key': {
          let flat = 0, sharp = 0;
          'ABCDEFG'.split('').forEach((n, i) => { const a = (it.alters || {})[n]; if (a > 0) sharp |= 1 << i; else if (a < 0) flat |= 1 << i; });
          head(1, it).u8(flat).u8(0).u8(sharp).raw([0, 0, 0, 0, 0, 0, 0]);
          break;
        }
        case 'Bar': {
          const name = BAR_FALLBACK[it.style] || it.style || 'Single';
          if (BAR_FALLBACK[it.style]) old = true;
          const idx = Math.max(0, BAR_STYLES_OLD.indexOf(name));
          head(2, it).u8(idx | (it.sysBreak ? 0x80 : 0)).u8(name === 'LocalRepeatClose' ? Math.max(2, Math.min(255, it.repeat || 2)) : idx ? 2 : 1);
          break;
        }
        case 'Ending': {
          let bits = 0; for (const n of it.endings || []) if (n >= 1 && n <= 7) bits |= 1 << (n - 1);
          if (it.default) bits |= 0x80;
          head(3, it).u8(bits).u8(0);
          break;
        }
        case 'TimeSig': head(5, it).i16(it.num).i16(Math.max(0, Math.min(6, Math.round(Math.log2(it.den || 4))))).i16(it.style === 'Common' ? 1 : it.style === 'AllaBreve' ? 2 : 0); break;
        case 'Tempo': head(6, it); expr(it, 10); out.i16(it.bpm || 120).u8(Math.max(0, TEMPO_BASES.indexOf(it.base || 'Quarter'))).z(it.text || ''); break;
        case 'Dynamic': { const i = Math.max(0, DYNAMICS.indexOf(it.style)); head(7, it); expr(it, -8); out.u8(i).i16(DYN_VELOCITY[i]).u16(0xffff); break; }
        case 'SustainPedal': head(11, it); expr(it, -10); out.u8(it.released ? 0 : 1); break;
        case 'Flow': head(12, it); expr(it, 8); out.u16(Math.max(0, FLOW_STYLES.indexOf(it.style))); break;
        case 'TempoVariance': {
          const i = TEMPO_VARIANCES_OLD.indexOf(it.style);
          if (i < 0) { old = true; continue; }                // caesura: not in 1.75
          head(14, it); expr(it, 9); out.u8(i).u8(Math.max(0, Math.min(255, it.pause || 0)));
          break;
        }
        case 'DynamicVariance': head(15, it); expr(it, -8); out.u8(Math.max(0, DYN_VARIANCES.indexOf(it.style))); break;
        case 'PerformanceStyle': { const i = PERFORMANCE_STYLES.indexOf(it.style); if (i < 0) continue; head(16, it); expr(it, 8); out.u8(i); break; }
        case 'Text': head(17, it); expr(it, 9); out.u8(Math.max(0, FONT_STYLES.indexOf(it.font || 'StaffItalic'))).z(it.text || ''); break;
        case 'Rest': {
          const d = it.dur, dots = d.dots || 0, op = it.opts || {};
          head(9, it).raw([Math.max(0, Math.min(6, d.base)), 0, ((MARK[d.triplet] || 0) << 2) | (op.lyric === 'Always' ? 0x80 : 0), op.lyric === 'Never' ? 1 : 0,
            (dots === 2 ? 1 : 0) | (dots === 1 ? 4 : 0), d.slur ? 1 : 0, 0, 0]);
          slurIn = !!d.slur;
          break;
        }
        case 'Note': case 'Chord': {
          const d = it.dur, op = it.opts || {};
          const heads = [...(it.notes || [])].sort((a, b) => a.pos - b.pos);
          if (!heads.length) continue;
          const explicit = op.stem === 'Up' ? 1 : op.stem === 'Down' ? 2 : 0;
          if (heads.length === 1) {
            head(8, it).raw(noteBytes(d, op, heads[0], { stem: explicit, slurred: slurIn }));
          } else {
            // every member of a chord carries a stem direction; NWC fills it in when the chord has none
            let far = 0; for (const h of heads) if (Math.abs(h.pos) > Math.abs(far)) far = h.pos;
            const stem = explicit || (far > 0 ? 2 : 1);
            const members = heads.map(h => noteBytes(d, op, h, { member: true, stem, slurred: slurIn }));
            const lead = (stem === 1) === !!explicit ? heads[heads.length - 1] : heads[0];
            const hd = noteBytes(d, op, lead, { stem: explicit, slurred: slurIn });
            hd[4] = members.reduce((x, m) => x | m[4], 0) & ~0x40;
            hd[5] = members[0][5];
            hd[7] = 5 | (stem === 1 ? 8 : 0);
            head(10, it).raw(hd).u16(members.length);
            for (const m of members) head(8, it).raw(m);    // members are part of the chord object, not counted
          }
          for (const h of heads) { if (h.tie) pending.add(h.pos); else pending.delete(h.pos); }
          if (!d.grace) slurIn = !!d.slur;
          break;
        }
        default: continue;                                    // boundary changes, user objects: not in 1.75
      }
      count++;
    }
    return count;
  }
}
