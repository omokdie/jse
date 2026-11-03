// Keyboard shortcuts — Finale-style (Selection tool / Simple Entry / Smart Shape / Articulation / Expression metatools).
import { findEvent, staffList, effectiveClef, effectiveKeySig, keyAlter, midiOf, CLEF_TOP_LINE, totalStaffCount, noteAtStaffPosition, staffPosition, STEPS } from '../model/score.js';
import * as C from '../model/commands.js';
import { SHAPE_KEYS, ARTIC_KEYS, EXPR_KEYS, applyArticulation, applyExpression, createShape } from './tools.js';

// Finale Simple Entry duration keys (numeric keypad or number row): 5 = quarter
const DUR_KEYS = { 1: '64th', 2: '32nd', 3: '16th', 4: 'eighth', 5: 'quarter', 6: 'half', 7: 'whole', 8: 'breve' };
const DRUM_KEYS = { A: 'kick', B: 'snare', C: 'hihat-closed', D: 'hihat-open', E: 'tom-high', F: 'floor-tom', G: 'crash', H: 'ride' };

export class KeyboardController {
  constructor(app, view, ui) {
    this.app = app; this.view = view; this.ui = ui;
    this.fretBuffer = ''; this.fretTimer = null;
    this.heldKey = null;          // metatool key held down (Finale: hold key + click)
    this.spaceHeld = false; this.spaceUsed = false;
    window.addEventListener('keydown', e => this.onKey(e));
    window.addEventListener('keyup', e => this.onKeyUp(e));
    window.addEventListener('blur', () => { this.heldKey = null; this.spaceHeld = false; });
  }
  isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  onKeyUp(e) {
    if (e.key === ' ' && this.spaceHeld) {
      this.spaceHeld = false;
      if (!this.spaceUsed && !this.isTyping(e) && !this.ui.dialogOpen?.()) this.ui.togglePlay();
      this.spaceUsed = false;
      return;
    }
    if (this.heldKey && metaKeyOf(e) === this.heldKey) this.heldKey = null;
  }
  onKey(e) {
    if (this.isTyping(e)) return;
    if (this.ui.dialogOpen?.()) return;
    const app = this.app, mod = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
    const k = e.key;
    const K = k.length === 1 ? k.toUpperCase() : k;
    const code = e.code || '';
    const digit = /^(Digit|Numpad)([0-9])$/.exec(code)?.[2] ?? (/^[0-9]$/.test(k) ? k : null);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const tool = app.tool || (app.mode === 'input' ? 'entry' : 'select');
    const entry = app.mode === 'input';
    // ---- global ----
    if (mod && !shift && K === 'Z') { stop(); app.undo(); return; }
    if (mod && (K === 'Y' || (shift && K === 'Z'))) { stop(); app.redo(); return; }
    if (mod && K === 'S') { stop(); shift ? this.ui.saveAs() : this.ui.save(); return; }
    if (mod && K === 'O') { stop(); this.ui.openFile(); return; }
    if (mod && K === 'N' && !shift) { stop(); this.ui.newScoreDialog(); return; }
    if (mod && K === 'P') { stop(); this.ui.exportDialog('pdf'); return; }
    if (mod && K === 'E' && shift) { stop(); this.ui.exportDialog(); return; }
    if (mod && K === 'E') { stop(); this.ui.togglePageScroll?.(); return; }                       // Finale: Page View ↔ Scroll View
    if (mod && (k === '=' || k === '+')) { stop(); this.view.zoomBy(1.15); return; }
    if (mod && k === '-') { stop(); this.view.zoomBy(1 / 1.15); return; }
    if (mod && (k === '0' || k === ']')) { stop(); this.view.fit('width'); return; }
    if (mod && k === '[') { stop(); this.view.fit('page'); return; }
    if (mod && shift && K === 'G') { stop(); this.ui.goToMeasureDialog?.(); return; }
    if (alt && shift && digit && +digit >= 1 && +digit <= 4) { stop(); this.ui.paletteAction('voice', { v: +digit - 1 }); this.ui.toast?.(`${digit}성부(레이어 ${digit})`, 'info'); return; }
    if (k === ' ' && !mod) { stop(); if (!e.repeat) { this.spaceHeld = true; this.spaceUsed = false; } return; }
    if (k === 'Escape') { stop(); this.heldKey = null; if (tool !== 'select') app.setTool('select'); else app.clearSelection(); this.ui.closePopovers?.(); return; }
    if (k === 'F1' || (shift && k === '?')) { stop(); this.ui.showShortcuts(); return; }
    if (k === 'F11' && globalThis.ScoreSnapNative?.windowControls) { stop(); this.ui.toggleFullscreen(); return; }
    if (mod && k === 'PageDown') { stop(); this.view.showPage(app.currentPage + 1); this.ui.goToPage?.(app.currentPage); return; }
    if (mod && k === 'PageUp') { stop(); this.view.showPage(app.currentPage - 1); this.ui.goToPage?.(app.currentPage); return; }
    // ---- editing (all tools) ----
    if (mod && K === 'A') { stop(); app.select({ type: 'range', fromMi: 0, toMi: app.score.measures.length - 1, s0: 0, s1: totalStaffCount(app.score) - 1 }); return; }
    if (mod && K === 'C') { stop(); if (app.copySelection()) this.ui.toast?.('복사했습니다'); return; }
    if (mod && K === 'X') { stop(); app.cutSelection(); return; }
    if (mod && K === 'V') { stop(); this.ui.pasteSmart(); return; }
    if (mod && K === 'B') { stop(); app.exec('마디 추가', s => C.appendMeasures(s, 1)); return; }
    if (mod && k === 'Insert') { stop(); const ip = app.insertPoint(); app.exec('마디 삽입', s => C.insertMeasures(s, ip.mi, 1)); return; }
    if (mod && (k === 'Delete' || k === 'Backspace')) { stop(); this.ui.deleteMeasures(); return; }
    if (mod && /^[2-9]$/.test(k)) { stop(); this.ui.tuplet(parseInt(k, 10)); return; }
    if (mod && K === 'K') { stop(); app.setTool('chord'); this.ui.startChordEntry(); return; }
    if (mod && K === 'L') { stop(); app.setTool('lyrics'); this.ui.startLyricEntry(this.ui.lyricVerse || 1); return; }
    if (mod && K === 'T') { stop(); this.ui.addTextDialog('plain'); return; }
    if (mod && K === 'M') { stop(); this.ui.addRehearsalMark(); return; }
    if (mod && K === 'R') { stop(); this.ui.showPalette?.(); return; }
    if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) { stop(); if (entry) this.chordNoteNav(k === 'ArrowUp' ? 1 : -1); else app.transposeSelection({ octaves: k === 'ArrowUp' ? 1 : -1 }); return; }
    if (mod && (k === 'ArrowLeft' || k === 'ArrowRight')) { stop(); this.measureNav(k === 'ArrowRight' ? 1 : -1); return; }
    if (mod) return;
    // Alt+1..8: change the duration of the selected / just-entered note (Finale)
    if (alt && digit && DUR_KEYS[digit]) { stop(); this.changeDuration(DUR_KEYS[digit]); return; }
    if (alt && K === 'G') { stop(); this.ui.paletteAction('grace'); return; }
    if (k === 'Delete' || k === 'Backspace') { stop(); this.deleteKey(k === 'Delete'); return; }

    // ---- tool-specific metatools (hold the key and click, or press it with notes selected) ----
    if ((tool === 'shape' || tool === 'artic' || tool === 'expr') && !alt) {
      const mk = metaKeyOf(e);
      const map = tool === 'shape' ? SHAPE_KEYS : tool === 'artic' ? ARTIC_KEYS : EXPR_KEYS;
      if (tool === 'shape' && K === 'F' && app.selection.type === 'spanner') { stop(); this.flipSpanner(); return; }
      if (map[mk]) {
        stop();
        if (!e.repeat) {
          const ids = app.selectedEventIds();
          const item = map[mk];
          if (ids.length) {
            if (tool === 'artic') applyArticulation(app, ids, item);
            else if (tool === 'expr') applyExpression(app, this.ui, item, { eventId: ids[0] });
            else this.shapeFromSelection(item);
          } else { app.setToolItem(tool, item); }
        }
        this.heldKey = mk;
        return;
      }
    }

    if (entry) { if (this.entryKey(e, k, K, digit, shift, alt, stop)) return; }
    else if (this.selectKey(e, k, K, digit, shift, alt, stop)) return;
    // ---- shared navigation ----
    if (k === 'ArrowLeft' || k === 'ArrowRight') { stop(); const dir = k === 'ArrowRight' ? 1 : -1; if (shift) this.extendSelection(dir); else app.moveCursor(dir); return; }
    if (k === 'PageDown' || k === 'PageUp') { stop(); this.view.showPage(app.currentPage + (k === 'PageDown' ? 1 : -1)); return; }
    if (k === 'Home') { stop(); app.cursor = { mi: 0, si: app.cursor?.si || 0, vi: 0, tick: 0 }; app.moveCursor(0); this.view.scrollToMeasure(0); return; }
    if (k === 'End') { stop(); const mi = app.score.measures.length - 1; app.cursor = { mi, si: app.cursor?.si || 0, vi: 0, tick: 0 }; app.moveCursor(0); this.view.scrollToMeasure(mi); return; }
  }

  /** Selection tool keys. Returns true when handled. */
  selectKey(e, k, K, digit, shift, alt, stop) {
    const app = this.app; const sel = app.selection;
    const hasSel = app.selectedEventIds().length > 0 || sel.type === 'spanner';
    // Finale Selection-tool metatools: 6/7 = step down/up, 8/9 = octave down/up
    if (digit && !shift && !alt && ['6', '7', '8', '9'].includes(digit) && app.selectedEventIds().length) {
      stop(); const d = { 6: { diatonic: -1 }, 7: { diatonic: 1 }, 8: { octaves: -1 }, 9: { octaves: 1 } }[digit]; app.transposeSelection(d); return true;
    }
    if (K === 'N' && !alt && !shift) { stop(); app.setTool('entry'); return true; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      stop(); const dir = k === 'ArrowUp' ? 1 : -1;
      if (!app.selectedEventIds().length) return true;
      if (shift) app.transposeSelection({ octaves: dir }); else if (alt) app.transposeSelection({ semitones: dir }); else app.transposeSelection({ diatonic: dir });
      return true;
    }
    if (!hasSel) {
      if (digit && DUR_KEYS[digit]) { stop(); app.setInput({ base: DUR_KEYS[digit], dots: 0 }); return true; }
      return false;
    }
    if (K === 'S' && !shift && !alt) { stop(); this.ui.addSlur(); return true; }
    if (k === '<' || k === '>') { stop(); this.shapeFromSelection(k === '<' ? 'cresc' : 'dim'); return true; }
    if (K === 'F' && sel.type === 'spanner') { stop(); this.flipSpanner(); return true; }
    if (k === '.' ) { stop(); const ids = app.selectedEventIds(); if (ids.length) app.exec('점', s => C.toggleDot(s, ids), { select: sel }); return true; }
    if (K === 'T' && !shift) { stop(); this.toggleTie(); return true; }
    if (K === 'L' || K === 'X') { stop(); this.flipStems(); return true; }
    if (k === '\\') { stop(); this.ui.paletteAction('respell'); return true; }
    if (k === '/') { stop(); this.toggleBeamBreak(); return true; }
    if (K === 'H' && !shift) { stop(); this.toggleHidden(); return true; }
    if (K === 'R' && !alt) { stop(); const ids = app.selectedEventIds(); if (ids.length) { const nids = app.exec('반복', s => C.repeatEvents(s, ids)); if (nids?.length) app.select({ type: 'events', ids: nids }); } return true; }
    if (k === '=' || k === '+') { stop(); this.accidentalKey(k === '+' ? 'double-sharp' : 'sharp'); return true; }
    if (k === '-' || k === '_') { stop(); this.accidentalKey(k === '_' ? 'double-flat' : 'flat'); return true; }
    if (shift && /^[A-G]$/.test(K) && !alt) { stop(); this.pitchKey(K, true); return true; }
    if (/^[A-G]$/.test(K) && !alt) { stop(); this.pitchKey(K, false); return true; }
    if (k === 'Enter' && !shift) {
      if (sel.type === 'text') { stop(); this.ui.editText(sel.ref); return true; }
      if (sel.type === 'events' && sel.ids.length === 1) { stop(); this.ui.onDoubleTapEvent?.({ eventId: sel.ids[0] }); return true; }
    }
    return false;
  }

  /** Simple Entry keys (Finale caret). Returns true when handled. */
  entryKey(e, k, K, digit, shift, alt, stop) {
    const app = this.app;
    const selIds = app.selection.type === 'events' ? app.selection.ids : [];
    if (k === 'F2' || k === 'F3' || k === 'F4' || k === 'F5' || k === 'F6' || k === 'F7' || k === 'F8' || (shift && k === 'F9')) {
      stop(); const n = parseInt(k.slice(1), 10); this.addInterval(shift ? -(n - 1) : n - 1); return true;
    }
    if (digit && !shift && !alt) {
      stop();
      if (digit === '0') { this.inputRest(); return true; }
      if (digit === '9') { this.ui.tuplet(3); return true; }
      this.durationKey(digit);
      return true;
    }
    if (k === 'Tab' && !shift) { stop(); this.inputRest(); return true; }
    if (k === '.') { stop(); if (app.selection.type === 'events' && app.selection.last && selIds.length) app.exec('점', s => C.toggleDot(s, selIds), { select: app.selection }); else app.setInput({ dots: app.input.dots ? 0 : 1 }); return true; }
    if (k === 'Enter') { stop(); this.enterAtCaret(shift); return true; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      stop(); const dir = k === 'ArrowUp' ? 1 : -1;
      if (selIds.length) { if (shift) app.transposeSelection({ octaves: dir }); else if (alt) app.transposeSelection({ semitones: dir }); else app.transposeSelection({ diatonic: dir }); const f = findEvent(app.score, selIds[0]); if (f?.ev.notes) app.lastPitch = f.ev.notes[f.ev.notes.length - 1]; }
      else { this.moveCaret(shift ? dir * 7 : dir); }
      return true;
    }
    if (k === '=' || k === '+') { stop(); this.accidentalKey(k === '+' ? 'double-sharp' : 'sharp'); return true; }
    if (k === '-' || k === '_') { stop(); this.accidentalKey(k === '_' ? 'double-flat' : 'flat'); return true; }
    if (K === 'N' && !shift && !alt) { stop(); this.accidentalKey('natural'); return true; }
    if (K === 'T' && !alt) { stop(); this.toggleTie(); return true; }
    if (K === 'L' && !alt) { stop(); this.flipStems(); return true; }
    if (k === '\\') { stop(); this.ui.paletteAction('respell'); return true; }
    if (k === '/') { stop(); this.toggleBeamBreak(); return true; }
    if (K === 'R' && !alt && !shift) { stop(); this.noteRestToggle(); return true; }
    if (K === 'H' && !alt && !shift && staffList(app.score)[app.cursor?.si ?? 0]?.staff.type !== 'percussion') { stop(); this.toggleHidden(); return true; }
    if (shift && /^[A-G]$/.test(K) && !alt) { stop(); this.pitchKey(K, true); return true; }
    if (/^[A-H]$/.test(K) && !alt) { stop(); this.pitchKey(K, false); return true; }
    return false;
  }

  // ------------------------------------------------------------------ actions
  durationKey(k) {
    const app = this.app; const sel = app.selection;
    const staff = staffList(app.score)[app.cursor?.si || 0]?.staff;
    // TAB: digits are fret numbers for the selected tab note
    if (staff?.type === 'tab' && sel.type === 'events' && sel.ids.length === 1 && !app.input.rest) {
      const f = findEvent(app.score, sel.ids[0]);
      if (f?.ev.kind === 'note') {
        this.fretBuffer = (this.fretBuffer + k).slice(-2);
        clearTimeout(this.fretTimer); this.fretTimer = setTimeout(() => { this.fretBuffer = ''; }, 700);
        let fret = parseInt(this.fretBuffer, 10); if (fret > 24) { fret = parseInt(k, 10); this.fretBuffer = k; }
        app.exec('프렛', s => { const ff = findEvent(s, sel.ids[0]); ff.ev.notes.forEach(n => { n.fret = fret; }); }, { select: sel });
        app.input.fret = fret;
        return;
      }
    }
    const base = DUR_KEYS[k]; if (!base) return;
    // Finale: pressing a duration twice quickly clears the dot and accidental
    const now = Date.now();
    const twice = this._lastDur === base && now - (this._lastDurAt || 0) < 400;
    this._lastDur = base; this._lastDurAt = now;
    app.setInput(twice ? { base, dots: 0, accidental: null, rest: false } : { base, rest: false });
  }
  changeDuration(base) {
    const app = this.app; const ids = app.selectedEventIds();
    app.setInput({ base });
    if (ids.length) app.exec('음길이', s => C.setDuration(s, ids, base, 0), { select: app.selection });
  }
  inputRest() {
    const app = this.app;
    if (app.mode !== 'input') app.setMode('input');
    app.inputNote({ rest: true });
  }
  /** Enter at the caret pitch (Finale: Enter enters a note, Shift+Enter a rest). */
  enterAtCaret(rest = false) {
    const app = this.app;
    if (rest) { this.inputRest(); return; }
    const pos = app.cursor || app.insertPoint();
    const staff = staffList(app.score)[pos.si]?.staff; if (!staff || staff.type !== 'standard') { this.inputRest(); return; }
    const pitch = { ...this.caretPitch(pos) };
    pitch.alter = keyAlter(pitch.step, effectiveKeySig(app.score, pos.mi).fifths);
    app.inputNote({ pitch });
  }
  caretPitch(pos) {
    const app = this.app;
    if (app.caretPitch) return app.caretPitch;
    const clef = effectiveClef(app.score, pos.mi, pos.si);
    return this.referencePitch(pos, clef);
  }
  moveCaret(steps) {
    const app = this.app; const pos = app.cursor || app.insertPoint();
    const p = this.caretPitch(pos);
    const idx = p.octave * 7 + STEPS.indexOf(p.step) + steps;
    app.caretPitch = { step: STEPS[((idx % 7) + 7) % 7], octave: Math.floor(idx / 7), alter: 0 };
    this.ui.showCaret?.(app.caretPitch);
  }
  /** Letter key: input a note (Simple Entry) or re-pitch the selection (Selection tool). */
  pitchKey(letter, addToChord) {
    const app = this.app;
    const pos = app.cursor || app.insertPoint();
    const staff = staffList(app.score)[pos.si]?.staff;
    if (!staff) return;
    if (staff.type === 'percussion') {
      const drum = DRUM_KEYS[letter]; if (!drum || !staff.drumMap?.[drum]) return;
      if (app.mode !== 'input') app.setMode('input');
      app.setInput({ drum });
      app.inputNote({ drum, addToChord });
      return;
    }
    if (letter === 'H') return;
    if (staff.type === 'tab') return;
    const clef = effectiveClef(app.score, pos.mi, pos.si);
    const key = effectiveKeySig(app.score, pos.mi).fifths;
    if (app.mode === 'input') {
      const ref = this.referencePitch(pos, clef);
      const pitch = nearestOctave(letter, ref, addToChord ? 'above' : 'nearest');
      pitch.alter = keyAlter(pitch.step, key);
      if (addToChord && app.selection.type === 'events' && app.selection.ids.length) {
        const f = findEvent(app.score, app.selection.ids[0]);
        if (f?.ev.kind === 'note') { const top = f.ev.notes[f.ev.notes.length - 1]; const p = nearestOctave(letter, top, 'above'); p.alter = keyAlter(p.step, key); app.inputNote({ pitch: p, at: { mi: f.mi, si: f.staffIndex, tick: f.tick, exact: true }, addToChord: true }); app.select({ type: 'events', ids: [f.ev.id], last: true }); return; }
      }
      app.inputNote({ pitch, addToChord });
      app.caretPitch = pitch;
    } else {
      const ids = app.selectedEventIds(); if (!ids.length) { app.setMode('input'); this.pitchKey(letter, addToChord); return; }
      app.exec('음높이', s => {
        for (const id of ids) {
          const f = findEvent(s, id); if (!f || f.ev.kind !== 'note') continue;
          if (addToChord) { const top = f.ev.notes[f.ev.notes.length - 1]; const p = nearestOctave(letter, top, 'above'); p.alter = keyAlter(p.step, key); if (!f.ev.notes.some(n => n.step === p.step && n.octave === p.octave)) { f.ev.notes.push(p); f.ev.notes.sort((a, b) => midiOf(a) - midiOf(b)); } }
          else f.ev.notes.forEach(n => { const p = nearestOctave(letter, n, 'nearest'); n.step = p.step; n.octave = p.octave; n.alter = keyAlter(p.step, key); delete n.accidental; });
        }
      }, { select: app.selection });
    }
  }
  referencePitch(pos, clef) {
    const app = this.app;
    if (app.lastPitch) return app.lastPitch;
    const v = app.score.measures[pos.mi].staves[pos.si].voices[pos.vi] || [];
    for (let i = v.length - 1; i >= 0; i--) if (v[i].kind === 'note') return v[i].notes[v[i].notes.length - 1];
    const top = CLEF_TOP_LINE[clef] || CLEF_TOP_LINE.treble;
    return noteAtStaffPosition(4, clef) || { step: top.step, octave: top.octave - 1, alter: 0 };
  }
  /** Finale number-row/F-key intervals: add a note n steps above (n>0) or below (n<0) the selected note. */
  addInterval(n) {
    const app = this.app; const ids = app.selection.type === 'events' ? app.selection.ids : [];
    const f = ids.length ? findEvent(app.score, ids[0]) : null;
    if (!f || f.ev.kind !== 'note') { this.ui.toast?.('먼저 음표를 입력하거나 선택하세요', 'warn'); return; }
    const key = effectiveKeySig(app.score, f.mi).fifths;
    const ref = n > 0 ? f.ev.notes[f.ev.notes.length - 1] : f.ev.notes[0];
    const idx = ref.octave * 7 + STEPS.indexOf(ref.step) + n;
    const p = { step: STEPS[((idx % 7) + 7) % 7], octave: Math.floor(idx / 7) }; p.alter = keyAlter(p.step, key);
    app.exec('음정 추가', s => { const g = findEvent(s, f.ev.id); if (!g.ev.notes.some(x => x.step === p.step && x.octave === p.octave)) { g.ev.notes.push(p); g.ev.notes.sort((a, b) => midiOf(a) - midiOf(b)); } }, { select: app.selection });
  }
  accidentalKey(acc) {
    const app = this.app; const ids = app.selectedEventIds().filter(id => findEvent(app.score, id)?.ev.kind === 'note');
    if (ids.length) { app.exec('임시표', s => C.setAccidental(s, ids, acc), { select: app.selection }); return; }
    app.setInput({ accidental: app.input.accidental === acc ? null : acc });
  }
  noteRestToggle() {
    const app = this.app; const ids = app.selection.type === 'events' ? app.selection.ids : [];
    if (!ids.length) { app.setInput({ rest: !app.input.rest }); return; }
    const f = findEvent(app.score, ids[0]); if (!f) return;
    if (f.ev.kind === 'note') app.exec('쉼표로', s => C.deleteEvents(s, ids), { select: app.selection });
    else { const p = app.lastPitch || this.referencePitch({ mi: f.mi, si: f.staffIndex, vi: f.voiceIndex }, effectiveClef(app.score, f.mi, f.staffIndex)); app.exec('음표로', s => { const g = findEvent(s, ids[0]); g.ev.kind = 'note'; g.ev.notes = [{ step: p.step, octave: p.octave, alter: p.alter || 0 }]; delete g.ev.fullMeasureRest; }, { select: app.selection }); }
  }
  chordNoteNav(dir) {
    const app = this.app; const sel = app.selection; if (sel.type !== 'events' || sel.ids.length !== 1) return;
    const f = findEvent(app.score, sel.ids[0]); if (!f || f.ev.kind !== 'note') return;
    const n = f.ev.notes.length; const cur = sel.noteIndex ?? (dir > 0 ? -1 : n);
    const ni = Math.max(0, Math.min(n - 1, cur + dir));
    app.select({ ...sel, noteIndex: ni });
  }
  measureNav(dir) {
    const app = this.app; const c = app.cursor || app.insertPoint();
    const mi = Math.max(0, Math.min(app.score.measures.length - 1, c.mi + dir));
    app.cursor = { ...c, mi, tick: 0 }; app.moveCursor(0); this.view.scrollToMeasure(mi);
  }
  deleteKey(isDelete) {
    const app = this.app; const s = app.selection;
    // Finale: Delete on a measure stack removes the measures; Backspace only clears
    if (isDelete && s.type === 'range' && s.stack) { this.ui.deleteMeasures(); return; }
    app.deleteSelection();
  }
  shapeFromSelection(shapeId) {
    const app = this.app; const sp = this.ui.selectionSpan();
    if (!sp) { this.ui.toast?.('먼저 음표를 선택하세요 (여러 개 선택하면 처음~끝)', 'warn'); return; }
    createShape(app, shapeId, sp.first.ev.id, sp.single ? null : sp.last.ev.id);
  }
  flipSpanner() {
    const app = this.app; const id = app.selection.id;
    app.exec('위·아래 뒤집기', s => { const sp = (s.spanners || []).find(x => x.id === id); if (!sp) return; if (sp.type === 'ottava') sp.octaveShift = -(sp.octaveShift || 8); else sp.placement = sp.placement === 'above' ? 'below' : sp.placement === 'below' ? 'above' : 'below'; }, { select: app.selection });
  }
  flipStems() {
    const app = this.app; const ids = app.selectedEventIds(); if (!ids.length) return;
    app.exec('기둥 방향', s => { for (const id of ids) { const f = findEvent(s, id); if (!f || f.ev.kind !== 'note') continue; const cur = f.ev.stem; const geo = this.view.app.layout?.pages.flatMap(p => p.geometry.events).find(e => e.id === id); const up = cur ? cur === 'up' : geo?.stemUp; f.ev.stem = up ? 'down' : 'up'; } }, { select: app.selection });
  }
  toggleTie() {
    const app = this.app;
    if (app.mode === 'input' && !app.selectedEventIds().length) { app.setInput({ tie: !app.input.tie }); return; }
    const ids = app.selectedEventIds(); if (!ids.length) return;
    app.exec('붙임줄', s => C.toggleTie(s, ids), { select: app.selection });
  }
  toggleBeamBreak() {
    const app = this.app; const ids = app.selectedEventIds(); if (!ids.length) return;
    app.exec('빔 끊기/잇기', s => { for (const id of ids) { const f = findEvent(s, id); if (!f) continue; f.ev.beam = f.ev.beam === 'begin' ? 'continue' : 'begin'; } }, { select: app.selection });
  }
  toggleHidden() {
    const app = this.app; const ids = app.selectedEventIds(); if (!ids.length) return;
    app.exec('숨기기', s => { for (const id of ids) { const f = findEvent(s, id); if (!f) continue; if (f.ev.hidden) delete f.ev.hidden; else f.ev.hidden = true; } }, { select: app.selection });
  }
  makeTuplet(n) {
    const app = this.app; const ids = app.selectedEventIds(); if (!ids.length) return;
    const den = n === 3 ? 2 : n === 5 || n === 6 || n === 7 ? 4 : n === 2 || n === 4 ? 3 : 8;
    app.exec('잇단음표', s => { for (const id of ids) C.makeTuplet(s, id, n, den); }, { select: app.selection });
  }
  extendSelection(dir) {
    const app = this.app; const s = app.selection;
    if (s.type === 'events' && s.ids.length) {
      const f = findEvent(app.score, s.ids[s.ids.length - 1]); if (!f) return;
      const v = f.voice; const ni = f.index + dir;
      if (ni >= 0 && ni < v.length) app.select({ type: 'events', ids: [...s.ids, v[ni].id] });
      else { const mi = f.mi + dir; const vv = app.score.measures[mi]?.staves[f.staffIndex]?.voices[f.voiceIndex]; if (vv?.length) app.select({ type: 'events', ids: [...s.ids, dir > 0 ? vv[0].id : vv[vv.length - 1].id] }); }
    } else if (s.type === 'measure' || s.type === 'range') {
      const r = app.rangeOf(s); const toMi = Math.max(r.fromMi, Math.min(app.score.measures.length - 1, r.toMi + dir));
      app.select({ type: 'range', fromMi: r.fromMi, toMi, s0: r.s0, s1: r.s1 });
    }
  }
}
/** Key as Finale's metatool chart writes it ("S", "<", "8"…). */
function metaKeyOf(e) {
  const k = e.key || '';
  if (k === '<' || k === '>') return k;
  if (/^(Digit|Numpad)[0-9]$/.test(e.code || '')) return e.code.slice(-1);
  return k.length === 1 ? k.toUpperCase() : k;
}
/** Octave choice for a letter relative to a reference pitch ('nearest' | 'above' | 'below'). */
export function nearestOctave(letter, ref, mode = 'nearest') {
  const refMidi = midiOf(ref);
  let best = null, bd = Infinity;
  for (let oct = Math.max(0, ref.octave - 2); oct <= Math.min(9, ref.octave + 2); oct++) {
    const cand = { step: letter, octave: oct, alter: 0 };
    const m = midiOf(cand);
    if (mode === 'above' && m <= refMidi) continue;
    if (mode === 'below' && m >= refMidi) continue;
    const d = Math.abs(m - refMidi);
    if (d < bd || (d === bd && m > refMidi)) { bd = d; best = cand; }
  }
  return best || { step: letter, octave: ref.octave, alter: 0 };
}
export { DUR_KEYS, DRUM_KEYS, staffPosition };
