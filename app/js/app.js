// Application state: score, layout, selection, history. UI modules subscribe to events.
import { createScore, cloneScore, validateScore, findEvent, effectiveTimeSig, measureCapacity, durTicks, staffList, totalStaffCount } from './model/score.js';
import * as C from './model/commands.js';
import { engrave } from './engrave/render.js';

export class App extends EventTarget {
  constructor() {
    super();
    this.score = null;
    this.layout = null;
    this.fileName = null;
    this.fileHandle = null;      // FileSystemFileHandle when available
    this.dirty = false;
    this.history = { undo: [], redo: [], limit: 120 };
    this.selection = { type: 'none' };
    this.mode = 'select';        // 'select' | 'input'
    this.tool = 'select';        // Finale-style tool: select | entry | shape | artic | expr | lyrics | chord | text | measure
    this.toolItem = { shape: 'slur', artic: 'staccato', expr: 'mf' };   // current palette item per tool
    this.input = { base: 'quarter', dots: 0, rest: false, accidental: null, voice: 0, tie: false, grace: false, tuplet: null, drum: 'snare', string: 1 };
    this.cursor = null;          // { mi, si, vi, tick } note-input cursor
    this.clipboard = null;
    this.zoom = 1;
    this.viewMode = 'vertical';  // single | vertical | horizontal | grid | reflow
    this.currentPage = 0;
    this.playing = false;
    this.settings = this.loadSettings();
    this._layoutTimer = null;
  }
  loadSettings() {
    const def = { tips: true, lang: 'ko', autosave: true, keymap: 'musescore', theme: 'auto', autoUpdate: true, mobileDurationBar: true };
    try { return { ...def, ...(JSON.parse(localStorage.getItem('ssnap.settings') || '{}')) }; } catch { return def; }
  }
  saveSettings() { try { localStorage.setItem('ssnap.settings', JSON.stringify(this.settings)); } catch { /* ignore */ } }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---------- document lifecycle ----------
  setScore(score, { fileName = null, fileHandle = null, dirty = false, keepHistory = false } = {}) {
    validateScore(score, { repair: true });
    this.score = score;
    this.fileName = fileName;
    this.fileHandle = fileHandle;
    this.dirty = dirty;
    if (!keepHistory) { this.history.undo = []; this.history.redo = []; }
    this.selection = { type: 'none' };
    this.cursor = null;
    this.relayout();
    this.emit('document', { score });
    this.emit('selection');
    this.emit('dirty');
  }
  newScore(opts) { this.setScore(createScore(opts), { fileName: null }); }
  relayout() {
    const t0 = performance.now();
    let src = this.score; const opts = {};
    if (this.viewMode === 'reflow' && this.reflowWidthPx) {
      // continuous mode: one tall page as wide as the screen (systems re-wrap to fit)
      const widthMm = this.reflowWidthPx / (96 / 25.4) / Math.max(0.3, this.zoom);
      src = { ...this.score, settings: { ...this.score.settings, pageSize: 'custom', orientation: 'portrait', pageWidthMm: Math.max(70, widthMm), pageHeightMm: 100000, marginsMm: { top: 8, bottom: 10, left: 4, right: 4 }, firstSystemIndentSp: 0 } };
      opts.trimHeight = true;
    }
    try { this.layout = engrave(src, opts); }
    catch (err) { console.error('layout failed', err); this.emit('error', { message: '악보를 그리는 중 오류가 발생했습니다: ' + err.message }); if (!this.layout) this.layout = { pages: [] }; }
    this.layoutMs = performance.now() - t0;
    if (this.currentPage >= this.layout.pages.length) this.currentPage = Math.max(0, this.layout.pages.length - 1);
    this.emit('layout');
  }

  // ---------- history ----------
  /** Run a mutation with undo support. fn(score) may return a value (e.g., new ids). */
  exec(label, fn, { select = undefined, silent = false } = {}) {
    const before = cloneScore(this.score);
    let result;
    try { result = fn(this.score); }
    catch (err) { console.error(label, err); this.score = before; this.emit('error', { message: `${label} 실패: ${err.message}` }); return null; }
    const v = validateScore(this.score, { repair: true });
    if (!v.ok) console.warn('validation', v.errors);
    this.history.undo.push({ label, before, selection: this.selection, cursor: this.cursor });
    if (this.history.undo.length > this.history.limit) this.history.undo.shift();
    this.history.redo = [];
    this.score.meta.modified = new Date().toISOString();
    this.dirty = true;
    if (select !== undefined) this.selection = select;
    this.relayout();
    this.emit('change', { label });
    this.emit('dirty');
    if (!silent) this.emit('selection');
    return result;
  }
  undo() {
    const h = this.history.undo.pop(); if (!h) return false;
    this.history.redo.push({ label: h.label, before: cloneScore(this.score), selection: this.selection, cursor: this.cursor });
    this.score = h.before; this.selection = h.selection; this.cursor = h.cursor; this.dirty = true;
    this.relayout(); this.emit('change', { label: 'undo' }); this.emit('selection'); this.emit('dirty');
    return true;
  }
  redo() {
    const h = this.history.redo.pop(); if (!h) return false;
    this.history.undo.push({ label: h.label, before: cloneScore(this.score), selection: this.selection, cursor: this.cursor });
    this.score = h.before; this.selection = h.selection; this.cursor = h.cursor; this.dirty = true;
    this.relayout(); this.emit('change', { label: 'redo' }); this.emit('selection'); this.emit('dirty');
    return true;
  }

  // ---------- selection ----------
  select(sel, { silent = false } = {}) {
    this.selection = sel || { type: 'none' };
    if (sel?.type === 'events' && sel.ids.length) {
      const f = findEvent(this.score, sel.ids[sel.ids.length - 1]);
      if (f) this.cursor = { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: f.tick };
    } else if (sel?.type === 'measure') this.cursor = { mi: sel.mi, si: sel.si ?? 0, vi: 0, tick: 0 };
    if (!silent) this.emit('selection');
  }
  clearSelection() { this.select({ type: 'none' }); }
  selectedEventIds() {
    const s = this.selection;
    if (s.type === 'events') return s.ids;
    if (s.type === 'range' || s.type === 'measure') {
      const ids = []; const r = this.rangeOf(s);
      for (let mi = r.fromMi; mi <= r.toMi; mi++) for (let si = r.s0; si <= r.s1; si++) this.score.measures[mi].staves[si].voices.forEach(v => { let t = 0; v.forEach(e => { const end = t + durTicks(e); if ((mi > r.fromMi || end > (r.fromTick || 0) + 1) && (mi < r.toMi || r.toTick == null || t < r.toTick - 1)) ids.push(e.id); t = end; }); });
      return ids;
    }
    return [];
  }
  rangeOf(s) {
    if (s.type === 'range') return s;
    if (s.type === 'measure') return { fromMi: s.mi, toMi: s.toMi ?? s.mi, s0: s.si ?? 0, s1: s.si ?? (totalStaffCount(this.score) - 1) };
    return null;
  }
  selectedNoteEvents() { return this.selectedEventIds().map(id => findEvent(this.score, id)).filter(f => f && f.ev.kind === 'note'); }
  /** Anchor for pasting / inserting: first selected position. */
  insertPoint() {
    const s = this.selection;
    if (s.type === 'events' && s.ids.length) { const f = findEvent(this.score, s.ids[0]); if (f) return { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: f.tick }; }
    if (s.type === 'range' || s.type === 'measure') { const r = this.rangeOf(s); return { mi: r.fromMi, si: r.s0, vi: 0, tick: r.fromTick || 0 }; }
    if (this.cursor) return this.cursor;
    return { mi: 0, si: 0, vi: 0, tick: 0 };
  }

  // ---------- note input ----------
  setMode(mode) {
    this.mode = mode;
    if (mode === 'input' && !this.cursor) this.cursor = this.insertPoint();
    const tool = mode === 'input' ? 'entry' : (this.tool === 'entry' ? 'select' : this.tool);
    if (tool !== this.tool) { this.tool = tool; this.emit('tool'); }
    this.emit('mode');
  }
  setTool(tool) {
    if (tool === 'entry') { this.setMode('input'); return; }
    this.tool = tool;
    if (this.mode !== 'select') { this.mode = 'select'; this.emit('mode'); }
    this.emit('tool');
  }
  setToolItem(tool, item) { this.toolItem[tool] = item; this.emit('tool'); }
  toggleMode() { this.setMode(this.mode === 'input' ? 'select' : 'input'); }
  setInput(patch) { Object.assign(this.input, patch); this.emit('input'); }
  /** Enter a note at the cursor (keyboard) or at an explicit position. */
  inputNote({ pitch, drum, string, fret, at = null, addToChord = false, rest = false } = {}) {
    const pos = at || this.cursor || this.insertPoint();
    const staff = staffList(this.score)[pos.si]?.staff;
    const opts = {
      mi: pos.mi, si: pos.si, vi: this.input.voice, tick: pos.tick, dur: { base: this.input.base, dots: this.input.dots },
      rest: rest || this.input.rest, pitch, accidental: this.input.accidental, addToChord, tieToPrev: this.input.tie, grace: this.input.grace,
      drum: drum || this.input.drum, string: string || this.input.string, fret: fret ?? 0, exactTick: !!at?.exact,
    };
    if (this.input.tuplet && !addToChord) opts.tuplet = null; // tuplets are made after input via Ctrl+number
    const id = this.exec('입력', s => C.inputEvent(s, opts), { silent: true });
    if (!id) return null;
    const f = findEvent(this.score, id);
    if (f) {
      if (addToChord) this.cursor = { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: f.tick };
      else {
        const cap = measureCapacity(effectiveTimeSig(this.score, f.mi));
        const after = f.tick + durTicks(f.ev);
        this.cursor = after >= cap - 1 ? { mi: Math.min(f.mi + 1, this.score.measures.length - 1), si: f.staffIndex, vi: f.voiceIndex, tick: f.mi + 1 >= this.score.measures.length ? after : 0 } : { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: after };
        if (f.mi + 1 >= this.score.measures.length && after >= cap - 1) {
          // auto-append a measure so input can continue
          this.exec('마디 추가', s => C.appendMeasures(s, 1), { silent: true });
          this.cursor = { mi: this.score.measures.length - 1, si: f.staffIndex, vi: f.voiceIndex, tick: 0 };
        }
      }
      this.lastInputId = id;
      this.lastPitch = pitch || this.lastPitch;
      this.selection = { type: 'events', ids: [id], last: true };
      if (this.input.tie) this.input.tie = false;
      this.emit('selection'); this.emit('input');
    }
    void staff;
    return id;
  }
  moveCursor(delta) {
    const c = this.cursor || this.insertPoint();
    const v = this.score.measures[c.mi].staves[c.si].voices[c.vi] || [];
    let t = 0; const onsets = [0]; v.forEach(e => { t += durTicks(e); if (t < measureCapacity(effectiveTimeSig(this.score, c.mi)) - 1) onsets.push(t); });
    const i = onsets.findIndex(o => Math.abs(o - c.tick) < 1);
    let ni = (i < 0 ? onsets.findIndex(o => o > c.tick) : i) + delta;
    if (ni < 0) { if (c.mi > 0) { const pm = c.mi - 1; const pv = this.score.measures[pm].staves[c.si].voices[c.vi] || []; let tt = 0; const po = [0]; pv.forEach(e => { tt += durTicks(e); if (tt < measureCapacity(effectiveTimeSig(this.score, pm)) - 1) po.push(tt); }); this.cursor = { ...c, mi: pm, tick: po[po.length - 1] }; } }
    else if (ni >= onsets.length) { if (c.mi + 1 < this.score.measures.length) this.cursor = { ...c, mi: c.mi + 1, tick: 0 }; }
    else this.cursor = { ...c, tick: onsets[ni] };
    // select the event at the cursor if any
    const cc = this.cursor; const vv = this.score.measures[cc.mi].staves[cc.si].voices[cc.vi] || []; let tk = 0; const ev = vv.find(e => { const hit = Math.abs(tk - cc.tick) < 1; tk += durTicks(e); return hit; });
    this.selection = ev ? { type: 'events', ids: [ev.id] } : { type: 'none' };
    this.emit('selection');
  }
  moveCursorStaff(delta) {
    const c = this.cursor || this.insertPoint(); const n = totalStaffCount(this.score);
    this.cursor = { ...c, si: Math.max(0, Math.min(n - 1, c.si + delta)) }; this.emit('selection');
  }

  // ---------- convenience wrappers used by UI ----------
  deleteSelection() {
    const s = this.selection;
    if (s.type === 'measure' && s.whole) { const r = this.rangeOf(s); this.exec('마디 삭제', sc => C.deleteMeasures(sc, r.fromMi, r.toMi), { select: { type: 'none' } }); return; }
    if (s.type === 'text') { this.deleteText(s); return; }
    if (s.type === 'spanner') { this.exec('삭제', sc => C.removeSpanner(sc, s.id), { select: { type: 'none' } }); return; }
    const ids = this.selectedEventIds(); if (!ids.length) return;
    if (s.type === 'events' && s.noteIndex != null && ids.length === 1) { this.exec('음표 삭제', sc => C.removeNoteFromChord(sc, ids[0], s.noteIndex), { select: { type: 'none' } }); return; }
    const keep = this.cursor;
    this.exec('삭제', sc => C.deleteEvents(sc, ids), { select: { type: 'none' } });
    this.cursor = keep;
  }
  deleteText(sel) {
    const ref = sel.ref;
    if (ref.kind === 'lyric') this.exec('가사 삭제', sc => C.setLyric(sc, ref.eventId, ref.verse, ''), { select: { type: 'none' } });
    else if (ref.kind === 'chord') this.exec('코드 삭제', sc => { const m = sc.measures.find(m => m.id === ref.measureId); if (m?.chords) { m.chords = m.chords.filter(c => c.id !== ref.chordId); if (!m.chords.length) delete m.chords; } }, { select: { type: 'none' } });
    else if (ref.kind === 'tempo') this.exec('템포 삭제', sc => { const m = sc.measures.find(m => m.id === ref.measureId); if (m) delete m.tempo; }, { select: { type: 'none' } });
    else if (ref.kind === 'rehearsal') this.exec('리허설 마크 삭제', sc => { const m = sc.measures.find(m => m.id === ref.measureId); if (m) delete m.rehearsalMark; }, { select: { type: 'none' } });
    else if (ref.kind === 'mtext') this.exec('텍스트 삭제', sc => { const m = sc.measures.find(m => m.id === ref.measureId); if (m?.texts) { m.texts.splice(ref.index, 1); if (!m.texts.length) delete m.texts; } }, { select: { type: 'none' } });
    else if (ref.kind === 'text') this.exec('텍스트 삭제', sc => { const f = findEvent(sc, ref.eventId); if (f?.ev.texts) { f.ev.texts.splice(ref.index || 0, 1); if (!f.ev.texts.length) delete f.ev.texts; } }, { select: { type: 'none' } });
  }
  copySelection() {
    const s = this.selection;
    if (s.type === 'range' || s.type === 'measure') this.clipboard = C.copyRange(this.score, this.rangeOf(s));
    else if (s.type === 'events') this.clipboard = C.copyEvents(this.score, s.ids);
    else return false;
    try { navigator.clipboard?.writeText('scoresnap-clip:' + JSON.stringify(this.clipboard)).catch(() => {}); } catch { /* ignore */ }
    this.emit('clipboard');
    return !!this.clipboard;
  }
  cutSelection() { if (this.copySelection()) this.deleteSelection(); }
  pasteClipboard(clip = this.clipboard) {
    if (!clip) return;
    const at = this.insertPoint();
    const ids = this.exec('붙여넣기', sc => C.paste(sc, clip, at));
    if (ids?.length) this.select({ type: 'events', ids });
  }
  transposeSelection(opts) {
    const s = this.selection;
    if ((s.type === 'range' || s.type === 'measure') && opts.semitones) { const r = this.rangeOf(s); this.exec('조옮김', sc => C.transposeRange(sc, r, opts.semitones)); return; }
    const ids = this.selectedEventIds(); if (!ids.length) return;
    this.exec('음높이 변경', sc => C.transposeEvents(sc, ids, opts), { select: this.selection });
  }
  pageOfMeasure(mi) {
    if (!this.layout) return 0;
    for (const p of this.layout.pages) if (p.geometry.measures.some(m => m.mi === mi)) return p.index;
    return 0;
  }
}
