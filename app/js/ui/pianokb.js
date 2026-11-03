// On-screen piano keyboard (glass panel). Tap a key: enter a note (input mode) or re-pitch the selection.
import { findEvent, staffList, effectiveKeySig, midiOf, noteFromMidi } from '../model/score.js';
import { icon } from './icons.js';

const WHITE = [0, 2, 4, 5, 7, 9, 11];
export class PianoKeyboard {
  constructor(app, ui) {
    this.app = app; this.ui = ui; this.visible = false; this.octave = 4;
    this.el = document.createElement('div'); this.el.className = 'piano-panel glass'; this.el.hidden = true;
    ui.el.main.appendChild(this.el);
  }
  toggle() { this.visible = !this.visible; this.render(); this.ui.renderInputbar?.(); }
  refresh() { if (this.visible) this.highlight(); }
  render() {
    const el = this.el; el.hidden = !this.visible; if (!this.visible) return;
    const octs = window.innerWidth < 600 ? 1 : 2;
    const keys = [];
    for (let o = 0; o < octs; o++) for (let pc = 0; pc < 12; pc++) keys.push((this.octave + 1 + o) * 12 + pc);
    keys.push((this.octave + 1 + octs) * 12);  // closing C
    const whites = keys.filter(m => WHITE.includes(m % 12));
    const ww = 100 / whites.length;
    let html = `<div class="piano-head"><button class="btn sm" data-o="-1">${icon('left')}</button><span>C${this.octave}–C${this.octave + octs}</span><button class="btn sm" data-o="1">${icon('right')}</button><span class="spacer"></span><span class="piano-hint">${this.app.mode === 'input' ? '건반을 누르면 음표 입력' : '선택한 음표의 음높이 변경'}</span><button class="btn sm" data-x>${icon('close')}</button></div><div class="piano-keys">`;
    whites.forEach((m, i) => { html += `<button class="pk white" data-m="${m}" style="left:${i * ww}%;width:${ww}%">${m % 12 === 0 ? `<span>C${Math.floor(m / 12) - 1}</span>` : ''}</button>`; });
    keys.filter(m => !WHITE.includes(m % 12)).forEach(m => {
      const wi = whites.findIndex(w => w > m);
      html += `<button class="pk black" data-m="${m}" style="left:${wi * ww - ww * 0.32}%;width:${ww * 0.64}%"></button>`;
    });
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => { this.octave = Math.max(0, Math.min(7, this.octave + +b.dataset.o)); this.render(); }));
    el.querySelector('[data-x]').addEventListener('click', () => this.toggle());
    el.querySelectorAll('.pk').forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); this.press(+b.dataset.m, e.shiftKey); b.classList.add('down'); setTimeout(() => b.classList.remove('down'), 160); }));
    this.highlight();
  }
  highlight() {
    const ids = this.app.selection.type === 'events' ? this.app.selection.ids : [];
    const on = new Set();
    ids.forEach(id => { const f = findEvent(this.app.score, id); if (f?.ev.kind === 'note' && staffList(this.app.score)[f.staffIndex]?.staff.type === 'standard') f.ev.notes.forEach(n => on.add(midiOf(n))); });
    this.el.querySelectorAll('.pk').forEach(b => b.classList.toggle('on', on.has(+b.dataset.m)));
  }
  press(midi, addToChord) {
    const app = this.app;
    const pos = app.cursor || app.insertPoint();
    const st = staffList(app.score)[pos.si];
    this.ui.player.preview(midi, st?.part.midiProgram || 0);
    if (!st || st.staff.type !== 'standard') { this.ui.toast('피아노 건반은 일반 오선에서 사용할 수 있습니다', 'warn'); return; }
    const key = effectiveKeySig(app.score, pos.mi).fifths;
    const pitch = noteFromMidi(midi, key);
    if (app.mode === 'input') { app.inputNote({ pitch, addToChord }); return; }
    const ids = app.selectedEventIds().filter(id => findEvent(app.score, id)?.ev.kind === 'note');
    if (!ids.length) { app.setMode('input'); app.inputNote({ pitch }); return; }
    app.exec('음높이', s => { for (const id of ids) { const f = findEvent(s, id); const ni = app.selection.noteIndex ?? f.ev.notes.length - 1; Object.assign(f.ev.notes[Math.min(ni, f.ev.notes.length - 1)], { ...pitch }); delete f.ev.notes[Math.min(ni, f.ev.notes.length - 1)].accidental; f.ev.notes.sort((a, b) => midiOf(a) - midiOf(b)); } }, { select: app.selection });
  }
}
