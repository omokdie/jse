// JSE — "nwctxt", the text form of NoteWorthy Composer files (NWC 2.0 and later): reader and writer.
//
// One object per line: |Type|Key:Value|Key:Value… between "!NoteWorthyComposer(2.75)" and
// "!NoteWorthyComposer-End". NWC 2.75 keeps this text inside .nwc files (see nwc.js for the
// container); NWC 2.0 / 2.5 export it as .nwctxt. Vocabulary and escaping follow NoteWorthy's
// published user-tool library (nwc2clips) and the files NWC 2.75 itself writes.
//
// Both directions use the "NWC document" structure that nwc-binary.js also produces:
//   { version, info:{title,author,lyricist,copyright1,copyright2,comments}, page:{…}, fonts:[…],
//     staves:[{ name, label, group, withNext:{bracket,brace,connectBars,layer}, instrument:{patch,trans,name},
//               lyrics:{placement,align,offset,underscoreAsSpace}, lyricLines:[{text}], items:[…] }] }
// Items mirror the nwctxt objects with parsed values:
//   Note  { dur:{base 0=Whole…6=64th, dots, triplet:'First'|'Mid'|'End', grace, slur, staccato, tenuto, accent, …},
//           opts:{stem, beam, lyric, crescendo, diminuendo, …}, notes:[{pos, acc:'#'|'b'|'n'|'x'|'v'|'', tie, head}] }
//   Chord adds dur2 / notes2 for the second stem; RestChord has the rest in dur and the notes in dur2 / notes2.

import {
  DUR_NAMES, CLEFS, DYNAMICS, BAR_STYLES, FLOW_STYLES, TEMPO_BASES, TEMPO_VARIANCES, DYN_VARIANCES, PERFORMANCE_STYLES,
  FONT_STYLES, ENDING_BARS,
} from './nwc-binary.js';

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
/** Splits "|A|B:\"x\\}y\"|C" at unescaped bars → ['A', 'B:"x\\}y"', 'C']. */
function splitFields(line) {
  const out = []; let cur = '';
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
const UNESCAPE = { r: '\r', n: '\n', t: '\t', '}': '|', '|': '|', ']': '\\', '\\': '\\', "'": "'", '"': '"' };
/** Value of a text field: quotes removed, NWC escapes resolved. */
export function unquoteNwc(v) {
  let s = v == null ? '' : String(v);
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
  if (s.indexOf('\\') < 0) return s;
  return s.replace(/\\(.)/g, (m, c) => (UNESCAPE[c] != null ? UNESCAPE[c] : c));
}
/** Text → quoted nwctxt value. */
export function quoteNwc(s) {
  const t = String(s == null ? '' : s).replace(/[\\\r\n\t"'|]/g, (c) => ({ '\\': '\\]', '\r': '\\r', '\n': '\\n', '\t': '\\t', '"': '\\"', "'": "\\'", '|': '\\}' }[c]));
  return '"' + t + '"';
}

function fieldMap(parts) {
  const f = {};
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]; const c = p.indexOf(':');
    if (c < 0) f[p] = ''; else f[p.slice(0, c)] = p.slice(c + 1);
  }
  return f;
}
const listOf = (v) => (v == null || v === '' ? [] : String(v).split(',').map(x => x.trim()).filter(Boolean));
function assoc(v) {
  const o = {};
  for (const item of listOf(v)) { const e = item.indexOf('='); if (e < 0) o[item] = true; else o[item.slice(0, e)] = item.slice(e + 1); }
  return o;
}
const int = (v, def = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const num = (v, def = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };
const yes = (v) => v === 'Y';

const DUR_INDEX = { Whole: 0, Half: 1, '4th': 2, '8th': 3, '16th': 4, '32nd': 5, '32th': 5, '64th': 6 };
function parseDur(v) {
  const a = assoc(v);
  const dur = { base: 2, dots: 0 };
  for (const k of Object.keys(a)) if (DUR_INDEX[k] != null) dur.base = DUR_INDEX[k];
  if (a.DblDotted) dur.dots = 2; else if (a.Dotted) dur.dots = 1;
  if (a.Triplet != null) dur.triplet = a.Triplet === 'First' ? 'First' : a.Triplet === 'End' ? 'End' : 'Mid';
  if (a.Grace) dur.grace = true;
  if (a.Slur) dur.slur = true;
  for (const [k, f] of [['Staccato', 'staccato'], ['Staccatissimo', 'staccatissimo'], ['Tenuto', 'tenuto'], ['Accent', 'accent'], ['Marcato', 'marcato']]) if (a[k]) dur[f] = true;
  return dur;
}
function parseOpts(v) {
  const a = assoc(v); const o = {};
  if (a.Stem === 'Up' || a.Stem === 'Down') o.stem = a.Stem;
  if (a.Beam != null) o.beam = a.Beam === 'First' ? 'First' : a.Beam === 'End' ? 'End' : 'Mid';
  if (a.Lyric === 'Always' || a.Lyric === 'Never') o.lyric = a.Lyric;
  if (a.Crescendo) o.crescendo = true;
  if (a.Diminuendo) o.diminuendo = true;
  if (a.Slur === 'Upward' || a.Slur === 'Downward') o.slurDir = a.Slur;
  if (a.Tie === 'Upward' || a.Tie === 'Downward') o.tieDir = a.Tie;
  if (a.Muted) o.muted = true;
  if (a.HideRest) o.hideRest = true;
  if (a.NoLegerLines) o.noLegerLines = true;
  if (a.ArticulationsOnStem) o.articulationsOnStem = true;
  if (a.VertOffset != null) o.vertOffset = int(a.VertOffset);
  if (a.StemLength != null) o.stemLength = num(a.StemLength);
  if (a.XNoteSpace != null) o.xNoteSpace = int(a.XNoteSpace);
  if (a.XAccSpace != null) o.xAccSpace = int(a.XAccSpace);
  return o;
}
const POS_RE = /^([#bnxv]?)(-?\d+)([oxXzyYa-w]?)(\^?)/;
function parsePosList(v) {
  const out = [];
  for (const p of listOf(v)) {
    const m = POS_RE.exec(p); if (!m) continue;
    const h = { pos: parseInt(m[2], 10), acc: m[1] || '' };
    if (m[3]) h.head = m[3];
    if (m[4]) h.tie = true;
    out.push(h);
  }
  return out;
}
function expression(f, o) {
  if (f.Pos != null) o.pos = num(f.Pos);
  if (f.Wide === 'Y') o.wide = true;
  if (f.Justify) o.justify = f.Justify;
  if (f.Placement) o.placement = f.Placement;
  return o;
}

function parseItem(type, f) {
  let o;
  switch (type) {
    case 'Clef': o = { type, clef: CLEFS.includes(f.Type) ? f.Type : 'Treble', octave: /Up/.test(f.OctaveShift || '') ? 1 : /Down/.test(f.OctaveShift || '') ? -1 : 0 }; break;
    case 'Key': {
      o = { type, alters: {} };
      for (const s of listOf(f.Signature)) { const m = /^([A-G])([#b])$/.exec(s); if (m) o.alters[m[1]] = m[2] === '#' ? 1 : -1; }
      if (f.Tonic) o.tonic = f.Tonic;
      break;
    }
    case 'TimeSig': {
      const s = f.Signature || '4/4';
      if (s === 'Common') o = { type, num: 4, den: 4, style: 'Common' };
      else if (s === 'AllaBreve') o = { type, num: 2, den: 2, style: 'AllaBreve' };
      else { const m = /^(\d+)\/(\d+)$/.exec(s); o = { type, num: m ? Math.max(1, +m[1]) : 4, den: m ? Math.max(1, +m[2]) : 4, style: 'Standard' }; }
      break;
    }
    case 'Bar':
      o = { type, style: BAR_STYLES.includes(f.Style) ? f.Style : 'Single' };
      if (f.Repeat != null) o.repeat = int(f.Repeat, 2);
      if (yes(f.SysBreak)) o.sysBreak = true;
      if (yes(f.XBarCnt)) o.xBarCnt = true;
      break;
    case 'Ending': {
      o = { type, endings: [] };
      for (const s of listOf(f.Endings)) { if (s === 'D') o.default = true; else { const n = int(s, 0); if (n >= 1 && n <= 7) o.endings.push(n); } }
      if (yes(f.ClosedBracket)) o.closed = true;
      break;
    }
    case 'Instrument':
      o = expression(f, { type });
      if (f.Name != null) o.name = unquoteNwc(f.Name);
      if (f.Patch != null) o.patch = int(f.Patch) & 127;
      if (f.Trans != null) o.trans = int(f.Trans);
      break;
    case 'Tempo':
      o = expression(f, { type, bpm: int(f.Tempo, 120), base: TEMPO_BASES.includes(f.Base) ? f.Base : 'Quarter', text: f.Text != null ? unquoteNwc(f.Text) : '' });
      break;
    case 'Dynamic': o = expression(f, { type, style: DYNAMICS.includes(f.Style) ? f.Style : 'mf' }); break;
    case 'Note': o = { type, dur: parseDur(f.Dur), opts: parseOpts(f.Opts), notes: parsePosList(f.Pos) }; if (!o.notes.length) o.notes = [{ pos: 0, acc: '' }]; break;
    case 'Chord': {
      o = { type, dur: parseDur(f.Dur), opts: parseOpts(f.Opts), notes: parsePosList(f.Pos) };
      if (f.Pos2 != null) { o.notes2 = parsePosList(f.Pos2); o.dur2 = parseDur(f.Dur2 != null ? f.Dur2 : f.Dur); }
      if (!o.notes.length && o.notes2 && o.notes2.length) { o.notes = o.notes2; o.dur = Object.assign(o.dur2, { slur: o.dur.slur || o.dur2.slur }); delete o.notes2; delete o.dur2; }
      if (!o.notes.length) o = { type: 'Rest', dur: o.dur, opts: o.opts };
      break;
    }
    case 'Rest': o = { type, dur: parseDur(f.Dur), opts: parseOpts(f.Opts) }; break;
    case 'RestChord':
      o = { type, dur: parseDur(f.Dur), opts: parseOpts(f.Opts), dur2: parseDur(f.Dur2 != null ? f.Dur2 : f.Dur), notes2: parsePosList(f.Pos2 != null ? f.Pos2 : f.Pos) };
      if (!o.notes2.length) o = { type: 'Rest', dur: o.dur, opts: o.opts };
      break;
    case 'SustainPedal': o = expression(f, { type, released: f.Status === 'Released' }); break;
    case 'Flow': o = expression(f, { type, style: FLOW_STYLES.includes(f.Style) ? f.Style : 'Coda' }); break;
    case 'TempoVariance': o = expression(f, { type, style: TEMPO_VARIANCES.includes(f.Style) ? f.Style : 'Fermata' }); if (f.Pause != null) o.pause = int(f.Pause); break;
    case 'DynamicVariance': o = expression(f, { type, style: DYN_VARIANCES.includes(f.Style) ? f.Style : 'Crescendo' }); break;
    case 'PerformanceStyle': o = expression(f, { type, style: f.Style || '' }); break;
    case 'Text': o = expression(f, { type, text: unquoteNwc(f.Text), font: (f.Font || 'StaffItalic').replace(/\s+/g, '') }); break;
    case 'RestMultiBar': o = { type, numBars: Math.max(1, Math.min(1000, int(f.NumBars, 1))) }; break;
    case 'Boundary': o = { type, style: f.Style || 'Reset' }; if (yes(f.NewPage)) o.newPage = true; break;
    case 'Spacer': o = { type, width: int(f.Width) }; break;
    case 'MPC': o = expression(f, { type }); break;
    case 'Marker': o = expression(f, { type }); break;
    default: o = { type, unknown: true };
  }
  if (f.Visibility && f.Visibility !== 'Default') o.visibility = f.Visibility;
  if (f.Color != null && f.Color !== '0' && f.Color !== 'Default') o.color = int(f.Color);
  return o;
}

/**
 * @param {string} text  decoded nwctxt (file form or clip form)
 * @returns NWC document
 */
export function parseNwctxt(text) {
  const doc = { version: '', versionNumber: 275, container: 'nwctxt', codePage: 0, info: {}, page: {}, fonts: [], staves: [] };
  let staff = null, sawHeader = false;
  const newStaff = (f = {}) => {
    staff = { name: unquoteNwc(f.Name), label: unquoteNwc(f.Label), labelAbbr: unquoteNwc(f.LabelAbbr), group: f.Group != null ? unquoteNwc(f.Group) : 'Standard',
      visible: true, endingBar: 'Section Close', muted: false, volume: 127, pan: 64, channel: (doc.staves.length % 16) + 1, device: 0,
      boundaryTop: 12, boundaryBottom: 12, lines: 5, withNext: { bracket: false, brace: false, connectBars: false, layer: false },
      instrument: { trans: 0 }, lyrics: { placement: 'Bottom', align: 'Standard Rules', offset: 0 }, lyricLines: [], items: [] };
    doc.staves.push(staff);
  };
  for (const raw of String(text || '').split(/\r\n|\n|\r/)) {
    const line = raw.replace(/^[\s\ufeff]+/, '');
    if (line[0] === '!') {
      const m = /^!NoteWorthyComposer(Clip)?\(([0-9.]+)/.exec(line);
      if (m) { sawHeader = true; doc.version = m[2]; doc.versionNumber = Math.round(parseFloat(m[2]) * 100) || 275; if (m[1]) doc.clip = true; }
      if (/^!NoteWorthyComposer(Clip)?-End/.test(line)) break;
      continue;
    }
    if (line[0] !== '|') continue;
    const parts = splitFields(line);
    let type = parts[0];
    if (type === 'Fake' || type === 'Context') continue;         // clip context, not notation
    const f = fieldMap(parts);
    switch (type) {
      case 'Locale': doc.codePage = int(f.ACP); continue;
      case 'Editor': continue;
      case 'SongInfo':
        for (const [k, key] of [['Title', 'title'], ['Author', 'author'], ['Lyricist', 'lyricist'], ['Copyright1', 'copyright1'], ['Copyright2', 'copyright2'], ['Comments', 'comments']]) if (f[k] != null) doc.info[key] = unquoteNwc(f[k]);
        continue;
      case 'PgSetup': {
        const p = doc.page;
        if (f.StaffSize != null) p.staffSize = num(f.StaffSize, 16);
        if (f.Zoom != null) p.zoom = int(f.Zoom, 4);
        if (f.TitlePage != null) p.titlePage = yes(f.TitlePage);
        if (f.ExtendLastSystem != null) p.extendLastSystem = yes(f.ExtendLastSystem);
        if (f.DurationPadding != null) p.durationPadding = yes(f.DurationPadding);
        if (f.PageNumbers != null) p.pageNumbers = int(f.PageNumbers);
        if (f.StaffLabels != null) p.staffLabels = f.StaffLabels;
        if (f.BarNumbers != null) p.barNumbers = f.BarNumbers;
        if (f.StartingBar != null) p.startingBar = int(f.StartingBar, 1);
        if (f.AllowLayering != null) p.allowLayering = yes(f.AllowLayering);
        continue;
      }
      case 'Font': {
        const style = (f.Style || '').replace(/\s+/g, '');
        doc.fonts.push({ style, typeface: unquoteNwc(f.Typeface), size: num(f.Size, 10), bold: yes(f.Bold), italic: yes(f.Italic), charSet: int(f.CharSet) });
        continue;
      }
      case 'PgMargins':
        doc.page.margins = { left: num(f.Left, 1.27), top: num(f.Top, 1.27), right: num(f.Right, 1.27), bottom: num(f.Bottom, 1.27) };
        doc.page.marginUnit = 'cm';
        doc.page.mirrorMargins = yes(f.Mirror);
        continue;
      case 'AddStaff': newStaff(f); continue;
      default: break;
    }
    if (!staff) newStaff();                                        // clips and damaged files: notation without a staff header
    if (type === 'StaffProperties') {
      if (f.EndingBar != null) staff.endingBar = ENDING_BARS.includes(f.EndingBar) ? f.EndingBar : 'Section Close';
      if (f.Visible != null) staff.visible = f.Visible !== 'N';
      if (f.BoundaryTop != null) staff.boundaryTop = int(f.BoundaryTop, 12);
      if (f.BoundaryBottom != null) staff.boundaryBottom = int(f.BoundaryBottom, 12);
      if (f.Lines != null) staff.lines = int(f.Lines, 5);
      if (f.WithNextStaff != null) { const w = listOf(f.WithNextStaff); staff.withNext = { bracket: w.includes('Bracket'), brace: w.includes('Brace'), connectBars: w.includes('ConnectBars'), layer: w.includes('Layer') }; }
      if (f.Style != null) {                                       // NWC 2.0 nwctxt
        const s = f.Style;
        staff.style = s;
        staff.withNext.brace = s === 'Upper Grand Staff'; staff.withNext.bracket = s === 'Orchestral';
        staff.withNext.connectBars = s === 'Upper Grand Staff' || s === 'Orchestral';
      }
      if (f.Layer != null) staff.withNext.layer = yes(f.Layer);
      if (f.Muted != null) staff.muted = yes(f.Muted);
      if (f.Volume != null) staff.volume = int(f.Volume, 127);
      if (f.StereoPan != null) staff.pan = int(f.StereoPan, 64);
      if (f.Device != null) staff.device = int(f.Device);
      if (f.Channel != null) staff.channel = Math.max(1, Math.min(16, int(f.Channel, 1)));
      continue;
    }
    if (type === 'StaffInstrument') {
      if (f.Name != null) staff.instrument.name = unquoteNwc(f.Name);
      if (f.Patch != null) staff.instrument.patch = int(f.Patch) & 127;
      if (f.Trans != null) staff.instrument.trans = int(f.Trans);
      continue;
    }
    if (type === 'Lyrics') {
      staff.lyrics = { placement: f.Placement === 'Top' ? 'Top' : 'Bottom', align: f.Align || 'Standard Rules', offset: int(f.Offset) };
      if (f.UnderscoreAsSpace != null) staff.lyrics.underscoreAsSpace = yes(f.UnderscoreAsSpace);
      continue;
    }
    const lm = /^Lyric(\d)$/.exec(type);
    if (lm) { staff.lyricLines[+lm[1] - 1] = { text: unquoteNwc(f.Text).replace(/\r\n?/g, '\n') }; continue; }
    if (type === 'User') {
      // |User|ChordPlay.nw|Name:"Cm7"|Pos:8  — the second field is the plugin name
      const userType = parts[1] || '';
      const g = fieldMap(parts.slice(1));
      const o = { type: 'User', userType, props: {} };
      for (const [k, v] of Object.entries(g)) o.props[k] = unquoteNwc(v);
      if (g.Pos != null) o.pos = num(g.Pos);
      staff.items.push(o);
      continue;
    }
    staff.items.push(parseItem(type, f));
  }
  for (const st of doc.staves) for (let i = 0; i < st.lyricLines.length; i++) if (!st.lyricLines[i]) st.lyricLines[i] = { text: '' };
  if (!sawHeader && !doc.staves.length) throw new Error('NoteWorthy Composer 텍스트(nwctxt) 형식이 아닙니다');
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------
function durText(d) {
  const a = [DUR_NAMES[d.base] || '4th'];
  if (d.dots === 2) a.push('DblDotted'); else if (d.dots === 1) a.push('Dotted');
  if (d.triplet) a.push(d.triplet === 'Mid' ? 'Triplet' : 'Triplet=' + d.triplet);
  if (d.grace) a.push('Grace');
  if (d.staccato) a.push('Staccato');
  if (d.staccatissimo) a.push('Staccatissimo');
  if (d.tenuto) a.push('Tenuto');
  if (d.slur) a.push('Slur');
  if (d.accent) a.push('Accent');
  if (d.marcato) a.push('Marcato');
  return a.join(',');
}
function optsText(o) {
  if (!o) return '';
  const a = [];
  if (o.stem) a.push('Stem=' + o.stem);
  if (o.crescendo) a.push('Crescendo');
  if (o.diminuendo) a.push('Diminuendo');
  if (o.slurDir) a.push('Slur=' + o.slurDir);
  if (o.lyric) a.push('Lyric=' + o.lyric);
  if (o.stemLength != null) a.push('StemLength=' + o.stemLength);
  if (o.xAccSpace) a.push('XAccSpace=' + o.xAccSpace);
  if (o.beam) a.push(o.beam === 'Mid' ? 'Beam' : 'Beam=' + o.beam);
  if (o.vertOffset) a.push('VertOffset=' + o.vertOffset);
  if (o.xNoteSpace) a.push('XNoteSpace=' + o.xNoteSpace);
  if (o.noLegerLines) a.push('NoLegerLines');
  if (o.tieDir) a.push('Tie=' + o.tieDir);
  if (o.hideRest) a.push('HideRest');
  if (o.articulationsOnStem) a.push('ArticulationsOnStem');
  if (o.muted) a.push('Muted');
  return a.join(',');
}
const posText = (heads) => heads.map(h => `${h.acc || ''}${h.pos}${h.head || ''}${h.tie ? '^' : ''}`).join(',');
function tail(o) {
  let s = '';
  if (o.color) s += '|Color:' + o.color;
  if (o.visibility && o.visibility !== 'Default') s += '|Visibility:' + o.visibility;
  return s;
}
function exprTail(o) {
  let s = '';
  if (o.pos != null) s += '|Pos:' + o.pos;
  if (o.wide) s += '|Wide:Y';
  if (o.justify && o.justify !== 'Left') s += '|Justify:' + o.justify;
  if (o.placement && o.placement !== 'BestFit') s += '|Placement:' + o.placement;
  return s + tail(o);
}

export function itemToNwctxt(o) {
  switch (o.type) {
    case 'Clef': return `|Clef|Type:${o.clef}${o.octave > 0 ? '|OctaveShift:Octave Up' : o.octave < 0 ? '|OctaveShift:Octave Down' : ''}${tail(o)}`;
    case 'Key': {
      const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'].filter(n => o.alters[n] > 0).map(n => n + '#');
      const flats = ['B', 'E', 'A', 'D', 'G', 'C', 'F'].filter(n => o.alters[n] < 0).map(n => n + 'b');
      const sig = [...sharps, ...flats];
      return `|Key|Signature:${sig.length ? sig.join(',') : 'C'}${o.tonic ? '|Tonic:' + o.tonic : ''}${tail(o)}`;
    }
    case 'TimeSig': return `|TimeSig|Signature:${o.style === 'Common' ? 'Common' : o.style === 'AllaBreve' ? 'AllaBreve' : o.num + '/' + o.den}${tail(o)}`;
    case 'Bar': return `|Bar${o.style && o.style !== 'Single' ? '|Style:' + o.style : ''}${o.repeat != null && /LocalRepeatClose/.test(o.style) ? '|Repeat:' + o.repeat : ''}${o.sysBreak ? '|SysBreak:Y' : ''}${o.xBarCnt ? '|XBarCnt:Y' : ''}${tail(o)}`;
    case 'Ending': return `|Ending|Endings:${[...o.endings, ...(o.default ? ['D'] : [])].join(',')}${o.closed ? '|ClosedBracket:Y' : ''}${tail(o)}`;
    case 'Instrument': return `|Instrument${o.name != null ? '|Name:' + quoteNwc(o.name) : ''}${o.patch != null ? '|Patch:' + o.patch : ''}|Trans:${o.trans || 0}|DynVel:10,30,45,60,75,92,108,127${exprTail(o)}`;
    case 'Tempo': return `|Tempo|Tempo:${o.bpm}${o.base && o.base !== 'Quarter' ? '|Base:' + o.base : ''}${o.text ? '|Text:' + quoteNwc(o.text) : ''}${exprTail(o)}`;
    case 'Dynamic': return `|Dynamic|Style:${o.style}${exprTail(o)}`;
    case 'Note': { const op = optsText(o.opts); return `|Note|Dur:${durText(o.dur)}|Pos:${posText(o.notes)}${op ? '|Opts:' + op : ''}${tail(o)}`; }
    case 'Chord': { const op = optsText(o.opts); return `|Chord|Dur:${durText(o.dur)}|Pos:${posText(o.notes)}${op ? '|Opts:' + op : ''}${o.notes2 && o.notes2.length ? `|Dur2:${durText(o.dur2)}|Pos2:${posText(o.notes2)}` : ''}${tail(o)}`; }
    case 'Rest': { const op = optsText(o.opts); return `|Rest|Dur:${durText(o.dur)}${op ? '|Opts:' + op : ''}${tail(o)}`; }
    case 'RestChord': { const op = optsText(o.opts); return `|RestChord|Dur:${durText(o.dur)}${op ? '|Opts:' + op : ''}|Dur2:${durText(o.dur2)}|Pos2:${posText(o.notes2)}${tail(o)}`; }
    case 'SustainPedal': return `|SustainPedal${o.released ? '|Status:Released' : ''}${exprTail(o)}`;
    case 'Flow': return `|Flow|Style:${o.style}${exprTail(o)}`;
    case 'TempoVariance': return `|TempoVariance|Style:${o.style}${o.pause != null && /Fermata|Breath|Caesura/.test(o.style) ? '|Pause:' + o.pause : ''}${exprTail(o)}`;
    case 'DynamicVariance': return `|DynamicVariance|Style:${o.style}${exprTail(o)}`;
    case 'PerformanceStyle': return `|PerformanceStyle|Style:${o.style}${exprTail(o)}`;
    case 'Text': return `|Text|Text:${quoteNwc(o.text)}|Font:${o.font || 'StaffItalic'}${exprTail(o)}`;
    case 'RestMultiBar': return `|RestMultiBar|NumBars:${o.numBars}|PrintOnce:N|WhenHidden:ShowBars,ShowRests${tail(o)}`;
    case 'Boundary': return `|Boundary|Style:${o.style}${o.style === 'NewSystem' ? '|NewPage:' + (o.newPage ? 'Y' : 'N') : ''}`;
    case 'Spacer': return `|Spacer|Width:${o.width || 100}${tail(o)}`;
    case 'User': {
      // object of a plugin: |User|ChordPlay.nw|Pos:8|Name:Am7
      if (!o.userType) return null;
      let s = '|User|' + o.userType + (o.pos != null ? '|Pos:' + o.pos : '');
      for (const [k, v] of Object.entries(o.props || {})) if (k !== 'Pos') s += `|${k}:${/^[\w#+\-/().]+$/.test(String(v)) ? v : quoteNwc(v)}`;
      return s;
    }
    default: return null;                                          // MPC and Marker objects are not written
  }
}

const YN = (v) => (v ? 'Y' : 'N');
const cm = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/0$/, '').replace(/\.$/, '');

/** NWC document → nwctxt (NWC 2.75 file form, CRLF line ends). */
export function writeNwctxt(doc) {
  const L = [];
  const info = doc.info || {}, page = doc.page || {};
  L.push('!NoteWorthyComposer(2.75)');
  L.push('|Editor|ActiveStaff:1|CaretIndex:1|CaretPos:0');
  L.push(`|SongInfo|Title:${quoteNwc(info.title)}|Author:${quoteNwc(info.author)}|Lyricist:${quoteNwc(info.lyricist)}|Copyright1:${quoteNwc(info.copyright1)}|Copyright2:${quoteNwc(info.copyright2)}${info.comments ? '|Comments:' + quoteNwc(info.comments) : ''}`);
  L.push(`|PgSetup|StaffSize:${page.staffSize || 16}|Zoom:${page.zoom || 4}|TitlePage:${YN(page.titlePage !== false)}|JustifyVertically:Y|PrintSystemSepMark:N|ExtendLastSystem:${YN(page.extendLastSystem)}|DurationPadding:${YN(page.durationPadding !== false)}|PageNumbers:${page.pageNumbers || 0}|StaffLabels:${page.staffLabels || 'None'}|BarNumbers:${page.barNumbers || 'None'}|StartingBar:${page.startingBar || 1}${page.allowLayering === false ? '|AllowLayering:N' : ''}`);
  const fonts = new Map((doc.fonts || []).map(f => [f.style, f]));
  const defaults = { StaffItalic: [10, true, true], StaffBold: [8, true, false], StaffLyric: [7.2, false, false], PageTitleText: [24, true, false], PageText: [12, false, false], PageSmallText: [8, false, false] };
  for (const style of FONT_STYLES) {
    const d = defaults[style] || [8, false, false];
    const f = fonts.get(style) || { typeface: 'Times New Roman', size: d[0], bold: d[1], italic: d[2], charSet: 0 };
    L.push(`|Font|Style:${style}|Typeface:${quoteNwc(f.typeface || 'Times New Roman')}|Size:${f.size || d[0]}|Bold:${YN(f.bold)}|Italic:${YN(f.italic)}|CharSet:${f.charSet || 0}`);
  }
  const m = page.margins || { left: 1.27, top: 1.27, right: 1.27, bottom: 1.27 };
  L.push(`|PgMargins|Left:${cm(m.left)}|Top:${cm(m.top)}|Right:${cm(m.right)}|Bottom:${cm(m.bottom)}|Mirror:${YN(page.mirrorMargins)}`);
  (doc.staves || []).forEach((st, si) => {
    L.push(`|AddStaff|Name:${quoteNwc(st.name || 'Staff')}${st.label ? '|Label:' + quoteNwc(st.label) : ''}${st.labelAbbr ? '|LabelAbbr:' + quoteNwc(st.labelAbbr) : ''}|Group:${quoteNwc(st.group || 'Standard')}`);
    const w = st.withNext || {};
    const wn = [w.bracket && 'Bracket', w.brace && 'Brace', w.connectBars && 'ConnectBars', w.layer && 'Layer'].filter(Boolean);
    L.push(`|StaffProperties|EndingBar:${st.endingBar || 'Section Close'}|Visible:${YN(st.visible !== false)}|BoundaryTop:${st.boundaryTop || 12}|BoundaryBottom:${st.boundaryBottom || 12}|Lines:${st.lines || 5}${wn.length ? '|WithNextStaff:' + wn.join(',') : ''}|Color:Default`);
    L.push(`|StaffProperties|Muted:${YN(st.muted)}|Volume:${st.volume == null ? 127 : st.volume}|StereoPan:${st.pan == null ? 64 : st.pan}|Device:${st.device || 0}|Channel:${st.channel || (si % 16) + 1}`);
    const ins = st.instrument || {};
    L.push(`|StaffInstrument${ins.name ? '|Name:' + quoteNwc(ins.name) : ''}${ins.patch != null ? '|Patch:' + ins.patch : ''}|Trans:${ins.trans || 0}|DynVel:10,30,45,60,75,92,108,127`);
    const lines = (st.lyricLines || []).map(l => (l && l.text) || '');
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (lines.length) {
      const ly = st.lyrics || {};
      L.push(`|Lyrics|Placement:${ly.placement || 'Bottom'}|Align:${ly.align || 'Standard Rules'}|Offset:${ly.offset || 0}${ly.underscoreAsSpace === false ? '|UnderscoreAsSpace:N' : ''}`);
      lines.forEach((t, i) => L.push(`|Lyric${i + 1}|Text:${quoteNwc(t)}`));
    }
    for (const it of st.items || []) { const s = itemToNwctxt(it); if (s) L.push(s); }
  });
  L.push('!NoteWorthyComposer-End');
  return L.join('\r\n') + '\r\n';
}
