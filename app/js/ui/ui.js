// UI controller: builds the liquid-glass shell and connects every module (view, editors, panels, io, playback, update).
import { t } from '../i18n.js';
import * as C from '../model/commands.js';
import { findEvent, staffList, effectiveTimeSig, effectiveKeySig, measureCapacity, durTicks, totalStaffCount, keyAlter, midiOf, pitchName, noteFromMidi, forEachEvent, createScore } from '../model/score.js';
import { beatTicks } from '../engrave/layout.js';
import { ScoreView } from '../view/canvas.js';
import { PointerController } from '../editor/pointer.js';
import { KeyboardController } from '../editor/keyboard.js';
import { renderPalette, DURATIONS } from './palette.js';
import { renderInspector } from './inspector.js';
import * as D from './dialogs.js';
import { toast, showMenu, hideMenu, showTextPopover, closePopover, showMiniToolbar, hideMiniToolbar, showSheet } from './popover.js';
import { icon, noteIcon, accidentalIcon, tieIcon, drumIcon, tupletIcon, barlineIcon, articIcon, dynamicIcon, hairpinIcon, slurIcon, clefIcon, keySigIcon, graceIcon, glyphIcon } from './icons.js';
import { TOOLS, SHAPES, ARTICS, EXPRS, toolById } from '../editor/tools.js';
import { groupHTML, bindGroups, closeFlyout } from './flyout.js';
import { groupFactory } from './groups.js';
import { writeSsnap, readSsnap, sniffFile } from '../io/ssnap.js';
import { storage } from '../io/storage.js';
import { rasterizePage, canvasToBlob, safeFileName, printLayout } from '../io/export.js';
import { Player } from '../playback/synth.js';
import { Updater } from '../update.js';
import { saveBlob, pickFiles, onNativeOpenFile, isMobileLayout, native, shareBlob } from '../native.js';
import { PianoKeyboard } from './pianokb.js';
import { exportDialog } from './exportdlg.js';
import { scanDialog } from './omrflow.js';
import { exampleScore } from '../model/examples.js';
import { escapeXml } from '../engrave/text.js';

const $ = (sel, root = document) => root.querySelector(sel);

export class UI {
  constructor(app, { version }) {
    this.app = app; this.version = version;
    this.commands = C;
    this.paletteState = { tab: 'notes', query: '' };
    this.el = { topbar: $('#topbar'), body: $('#body'), left: $('#left'), right: $('#right'), main: $('#main'), canvas: $('#canvas'), mini: $('#mini'), hint: $('#hint'), status: $('#statusbar'), mobilebar: $('#mobilebar'), inputbar: $('#inputbar') };
    this.applyTheme();
    this.buildShell();
    this.view = new ScoreView(app, this.el.canvas);
    this.pointer = new PointerController(app, this.view, this);
    this.keyboard = new KeyboardController(app, this.view, this);
    this.player = new Player(app);
    this.piano = new PianoKeyboard(app, this);
    this.updater = new Updater(app, { version, onToast: (m, k, o) => this.toast(m, k, o) });
    this.bindAppEvents();
    this.bindPlayer();
    this.bindGlobal();
  }

  // ---------------------------------------------------------------- shell
  buildShell() {
    this.buildTopbar();
    this.buildStatusbar();
    this.buildMobile();
    this.el.left.classList.add('glass'); this.el.right.classList.add('glass');
    this.el.left.innerHTML = '<div class="palette-host" style="display:flex;flex-direction:column;flex:1;min-height:0"></div><div class="navigator"><div class="panel-head" style="padding:0 2px 8px"><span>페이지</span><span class="sub" data-pages></span></div><div class="thumbs"></div></div>';
    const fab = document.createElement('button'); fab.className = 'fab'; fab.title = t('scan'); fab.innerHTML = icon('scan'); fab.addEventListener('click', () => this.scan()); this.el.main.appendChild(fab); this.fab = fab;
    const fabAudio = document.createElement('button'); fabAudio.className = 'fab secondary'; fabAudio.title = '음원으로 악보 만들기'; fabAudio.innerHTML = icon('audio'); fabAudio.addEventListener('click', () => this.audio()); this.el.main.appendChild(fabAudio); this.fabAudio = fabAudio;   // audio → score
    const peek = document.createElement('div'); peek.className = 'source-peek glass'; peek.hidden = true; this.el.main.appendChild(peek); this.peek = peek;
    const reviewBar = document.createElement('div'); reviewBar.className = 'review-bar glass'; reviewBar.hidden = true; this.el.main.appendChild(reviewBar); this.reviewBar = reviewBar;
    if (window.innerWidth < 1180) this.el.body.classList.add('hide-right');
    if (document.documentElement.classList.contains('tablet')) this.el.body.classList.add('hide-left', 'hide-right');
  }
  // Adobe-style chrome: ① title/menu bar  ② context options bar  ③ vertical tool rail (+ docked panels)
  buildTopbar() {
    this.el.topbar.innerHTML = `
      <div class="bar glass titlebar">
        <div class="brand" title="JSE">${icon('logo')}</div>
        <button class="tb-btn icon-only mobile-only" data-act="mobileMenu" title="메뉴">${icon('menu')}</button>
        <nav class="menu-bar desktop-only">${['file', 'edit', 'view', 'score', 'export', 'help'].map(m => `<button data-menu="${m}">${t(m)}</button>`).join('')}</nav>
        <div class="file-title"><span class="name" data-title></span><span class="state" data-state></span></div>
        <div class="spacer"></div>
        <div class="tb-group mobile-only"><button class="tb-btn icon-only" data-act="undo" title="${t('undo')}">${icon('undo')}</button><button class="tb-btn icon-only" data-act="redo" title="${t('redo')}">${icon('redo')}</button><button class="tb-btn icon-only" data-act="play" title="${t('play')}">${icon('play')}</button></div>
        <button class="update-chip desktop-only" data-act="update" hidden><span class="dot"></span><span data-update-text></span></button>
        <button class="tb-btn icon-only desktop-only" data-act="settings" title="${t('settings')}">${icon('settings')}</button>
        <button class="tb-btn icon-only mobile-only" data-act="mobileMore" title="${t('more')}">${icon('more')}</button>
      </div>`;
    this.buildWindowControls();
    this.el.topbar.querySelectorAll('[data-menu]').forEach(b => b.addEventListener('click', () => this.openMenu(b.dataset.menu, b)));
    this.el.topbar.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this.action(b.dataset.act, {}, b)));
    this.buildRail();
    this.renderOptionsBar();
  }
  /** Vertical tool rail — Finale's main tools, grouped like Photoshop (hover a group to pick another tool). */
  buildRail() {
    const rail = document.getElementById('rail'); if (!rail) return;
    rail.classList.add('glass');
    closeFlyout();
    const btn = (id, ic, label, key) => `<button data-tool="${id}" title="${label}${key ? ` (${key})` : ''}" aria-label="${label}">${icon(ic)}<span class="rail-tip">${label}${key ? `<kbd>${key}</kbd>` : ''}</span></button>`;
    const F = groupFactory(this.app, this);
    const groups = [
      F.railTools('railSym', '기호 (이음줄·아티큘레이션·셈여림)', ['shape', 'artic', 'expr'], TOOLS),
      F.railTools('railText', '글자 (가사·코드·텍스트)', ['lyrics', 'chord', 'text'], TOOLS),
    ];
    const T = (id) => TOOLS.find(t => t.id === id);
    rail.innerHTML = btn('tool:select', T('select').icon, T('select').label, T('select').key) + btn('tool:entry', T('entry').icon, T('entry').label, T('entry').key)
      + '<span class="rail-sep"></span>' + groups.map(g => groupHTML(g, 'rail')).join('') + btn('tool:measure', T('measure').icon, T('measure').label, '')
      + '<span class="rail-sep"></span>' + btn('tool:piano', 'piano', '피아노 건반', '') + btn('tool:scan', 'scan', '사진으로 인식', '') + btn('tool:audio', 'audio', '음원으로 악보 만들기', '') + '<span class="rail-flex"></span>' + btn('panel:left', 'sidebarLeft', '기호 팔레트 패널', '') + btn('panel:right', 'sidebarRight', '속성 패널', '');
    rail.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => this.railAction(b.dataset.tool)));
    bindGroups(rail, groups, { placement: 'right' });
    this.updateRail(true);
  }
  railAction(id) {
    const app = this.app;
    const [kind, name] = id.split(':');
    if (kind === 'tool' && TOOLS.some(t => t.id === name)) {
      app.setTool(name);
      if (name === 'lyrics' && app.selection.type === 'events' && app.selection.ids.length) this.startLyricEntry(this.lyricVerse || 1);
      else if (name === 'chord' && (app.selection.type === 'events' || app.selection.type === 'measure')) this.startChordEntry();
      else if (name !== 'entry' && name !== 'select') this.toast(toolById(name).hint.split(' · ').slice(0, 2).join(' · '), 'info', { timeout: 3200 });
      return;
    }
    switch (id) {
      case 'tool:piano': this.piano.toggle(); this.updateRail(); break;
      case 'tool:scan': this.scan(); break;
      case 'tool:audio': this.audio(); break;
      case 'panel:left': this.action('toggleLeft'); this.updateRail(); break;
      case 'panel:right': this.action('toggleRight'); this.updateRail(); break;
    }
  }
  updateRail(fromBuild = false) {
    const rail = document.getElementById('rail'); if (!rail) return;
    const tool0 = this.app.tool || 'select';
    if (!fromBuild && this._railTool !== tool0) { this._railTool = tool0; this.buildRail(); return; }
    this._railTool = tool0;
    const tool = this.app.tool || (this.app.mode === 'input' ? 'entry' : 'select');
    const on = { 'tool:piano': this.piano?.visible, 'panel:left': !this.el.body.classList.contains('hide-left'), 'panel:right': !this.el.body.classList.contains('hide-right') };
    on['tool:' + tool] = true;
    rail.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', !!on[b.dataset.tool]));
    document.getElementById('app')?.setAttribute('data-tool', tool);
  }
  /** Context-sensitive options bar (Photoshop-like). Related variants share one button; hover shows the flyout. */
  renderOptionsBar() {
    const bar = document.getElementById('optionsbar'); if (!bar || !this.app?.score) return;
    closeFlyout();
    const app = this.app, sel = app.selection, inp = app.input;
    const B = (act, ic, title, { on = false, label = '', cls = '' } = {}) => `<button class="ob-btn ${on ? 'on' : ''} ${cls}" data-ob="${act}" title="${title}">${ic}${label ? `<span>${label}</span>` : ''}</button>`;
    const G = (title, inner) => `<div class="ob-group">${title ? `<span class="ob-label">${title}</span>` : ''}${inner}</div>`;
    const groups = []; const Fy = (g) => { groups.push(g); return groupHTML(g, 'bar'); };
    const F = groupFactory(app, this);
    let ctx = '';
    const staff = staffList(app.score)[app.cursor?.si ?? 0]?.staff;
    const tool = app.tool || (app.mode === 'input' ? 'entry' : 'select');
    const tinfo = toolById(tool);
    const toolHint = (txt) => `<div class="ob-hint">${icon('info')}<span>${txt}</span></div>`;
    if (app.mode === 'input') {
      ctx += G('심플 입력', Fy(F.noteDur()) + Fy(F.restDur()) + Fy(F.dots()) + Fy(F.tuplet()) + Fy(F.tie()) + Fy(F.grace()));
      if (!staff || staff.type === 'standard') ctx += G('', Fy(F.accidental()));
      ctx += G('', Fy(F.voice()));
      ctx += toolHint('버튼에 마우스를 올리면 종류 선택 · 오선 클릭 = 다음 자리에 입력 · 음표 위·아래 클릭 = 화음');
    } else if (tool === 'shape') {
      ctx += G('스마트 셰이프', Fy(F.shapeSlur()) + Fy(F.shapeHairpin()) + Fy(F.shapeOctave()) + Fy(F.shapeLine()));
      if (sel.type === 'spanner') ctx += G('선택한 기호', B('sp-flip', icon('flip'), '위·아래 뒤집기 (F)') + B('delete', icon('trash'), '삭제 (Delete)', { cls: 'danger' }));
      ctx += toolHint('음표 클릭 → 다음 음표까지 · 다른 음표까지 끌기 → 그 음표까지 · 기호 클릭 후 끝의 ◆를 끌어 범위 변경');
    } else if (tool === 'artic') {
      ctx += G('아티큘레이션', Fy(F.articStacc()) + Fy(F.articAccent()) + Fy(F.articFermata()) + Fy(F.articOrn()) + Fy(F.articOther()));
      ctx += toolHint('음표 클릭 → 붙이기/떼기 · 빈 곳에서 끌어 범위 지정 → 여러 음표에 한꺼번에');
    } else if (tool === 'expr') {
      ctx += G('표현', Fy(F.exprDyn()) + Fy(F.exprTempoAlt()) + Fy(F.exprText()) + Fy(F.exprTech()) + Fy(F.exprMark()));
      ctx += toolHint('음표 클릭 → 붙이기 · 숫자를 누른 채 클릭: 2 fff … 5 mf … 9 ppp');
    } else if (tool === 'lyrics') {
      ctx += G('가사', Fy(F.verse()) + B('lyricsline', icon('text'), '가사 한꺼번에 붙여넣기…', { label: '한꺼번에' }));
      ctx += toolHint(tinfo.hint);
    } else if (tool === 'chord' || tool === 'text') {
      ctx += toolHint(tinfo.hint);
    } else if (tool === 'measure' || sel.type === 'measure' || sel.type === 'range') {
      const r = this.measureRange();
      const ts = effectiveTimeSig(app.score, r.fromMi);
      ctx += G(tool === 'measure' ? '마디 도구' : `마디 ${r.fromMi + 1}${r.toMi > r.fromMi ? '–' + (r.toMi + 1) : ''}`, Fy(F.timeSig()) + Fy(F.keySig()) + Fy(F.clef()) + B('tempo', icon('metronome'), '템포') + B('transpose', icon('refresh'), '조옮김'));
      ctx += G('', Fy(F.repeat()) + Fy(F.barline()) + Fy(F.measureOps()));
      if (tool !== 'measure') ctx += G('', B('copy', icon('copy'), '복사 (Ctrl+C) · 선택 영역을 끌어도 복사') + B('paste', icon('paste'), '붙여넣기 (Ctrl+V)'));
      else ctx += toolHint(tinfo.hint);
      void ts;
    } else if (sel.type === 'spanner') {
      ctx += G('선택한 기호', B('sp-flip', icon('flip'), '위·아래 뒤집기 (F)', { label: '뒤집기' }) + B('delete', icon('trash'), '삭제 (Delete)', { cls: 'danger', label: '삭제' }));
    } else if (sel.type === 'events' && sel.ids.length) {
      ctx += G(`${sel.ids.length}개 선택`, B('step:1', icon('up'), '한 음 올림 (↑ 또는 7)') + B('step:-1', icon('down'), '한 음 내림 (↓ 또는 6)') + Fy(F.pitchMore()));
      ctx += G('', Fy(F.selDur()) + Fy(F.selShape()) + Fy(F.selArtic()) + Fy(F.selDyn()) + Fy(F.selText()));
      ctx += G('', B('copy', icon('copy'), '복사 (Ctrl+C)') + B('repeat', icon('refresh'), '반복 (R)') + B('delete', icon('trash'), '삭제 (Delete)', { cls: 'danger' }));
    } else {
      ctx += toolHint('음표·마디를 클릭해 선택 · <b>N</b> 음표 입력 · 왼쪽 도구로 이음줄·아티큘레이션·셈여림·가사·코드 추가 · 마디 더블클릭: 세로 마디 묶음 선택');
    }
    bar.innerHTML = `<div class="bar glass optbar">
      ${G('', B('undo', icon('undo'), `${t('undo')} (Ctrl+Z)`) + B('redo', icon('redo'), `${t('redo')} (Ctrl+Y)`))}
      <div class="ob-context">${ctx}</div>
      <div class="spacer"></div>
      ${G('', B('play', icon(this.player?.playing ? 'pause' : 'play'), `${t('play')} (Space · Space+클릭: 그 마디부터)`, { on: !!this.player?.playing }) + B('stop', icon('stop'), t('stop')) + B('metronome', icon('metronome'), t('metronome'), { on: !!this.player?.metronome }))}
      <div class="ob-group ob-actions"><button class="tb-btn primary" data-ob="scan" title="사진·이미지·PDF에서 악보 인식">${icon('scan')}<span>사진으로 인식</span></button><button class="tb-btn" data-ob="audio" title="MP3·WAV 등 음원을 듣고 악보 만들기">${icon('audio')}<span>음원으로 악보</span></button><button class="tb-btn" data-ob="export" title="${t('export')} (Ctrl+Shift+E)">${icon('export')}<span>내보내기</span></button></div>
    </div>`;
    bar.querySelectorAll('[data-ob]').forEach(b => b.addEventListener('click', () => this.optionAction(b.dataset.ob, b)));
    bindGroups(bar, groups, { placement: 'below' });
  }
  optionAction(id, el) {
    const app = this.app; const [k, v] = id.split(':');
    const r = () => this.measureRange();
    switch (k) {
      case 'undo': app.undo(); break;
      case 'redo': app.redo(); break;
      case 'dur': app.setInput({ base: v, rest: false }); break;
      case 'restdur': app.setInput({ base: v, rest: true }); break;
      case 'setdur': app.setInput({ base: v }); app.exec('음길이', s => C.setDuration(s, app.selectedEventIds(), v, 0), { select: app.selection }); break;
      case 'dot': this.paletteAction('dot'); break;
      case 'rest': this.paletteAction('rest'); break;
      case 'tie': this.paletteAction('tie'); break;
      case 'tuplet': this.tuplet(3); break;
      case 'acc': this.paletteAction('accidental', { acc: v }); break;
      case 'voice': this.paletteAction('voice', { v: +v }); break;
      case 'semi': app.transposeSelection({ semitones: +v }); break;
      case 'step': app.transposeSelection({ diatonic: +v }); break;
      case 'grace': this.paletteAction('grace'); break;
      case 'shape': app.setToolItem('shape', v); if (app.selectedEventIds().length) this.keyboard.shapeFromSelection(v); break;
      case 'artic': app.setToolItem('artic', v); { const ids = app.selectedEventIds(); if (ids.length) import('../editor/tools.js').then(m => m.applyArticulation(app, ids, v)); } break;
      case 'expr': app.setToolItem('expr', v); { const ids = app.selectedEventIds(); if (ids.length && v !== 'tempo') import('../editor/tools.js').then(m => m.applyExpression(app, this, v, { eventId: ids[0] })); else if (v === 'tempo' || v === 'rehearsal') import('../editor/tools.js').then(m => m.applyExpression(app, this, v, { mi: this.measureRange().fromMi })); } break;
      case 'verse': this.lyricVerse = +v; this.renderOptionsBar(); break;
      case 'lyricsline': this.lyricsLineDialog(); break;
      case 'sp-flip': this.keyboard.flipSpanner(); break;
      case 'sel-slur': this.addSlur(); break;
      case 'sel-cresc': this.keyboard.shapeFromSelection('cresc'); break;
      case 'sel-dim': this.keyboard.shapeFromSelection('dim'); break;
      case 'm-key': { const r = this.measureRange(); this.keyMenu(el, r.fromMi); break; }
      case 'm-clef': { const r = this.measureRange(); this.clefMenu(el, r.fromMi, r.s0); break; }
      case 'oct': app.transposeSelection({ octaves: +v }); break;
      case 'lyrics': this.startLyricEntry(); break;
      case 'chord': this.startChordEntry(); break;
      case 'copy': app.copySelection(); this.toast('복사했습니다'); break;
      case 'paste': this.pasteSmart(); break;
      case 'repeat': this.action('repeat'); break;
      case 'delete': app.deleteSelection(); break;
      case 'timesig': D.timeSigDialog(app, r().fromMi); break;
      case 'tempo': D.tempoDialog(app, r().fromMi); break;
      case 'transpose': this.transposeDialog(); break;
      case 'rep-start': this.paletteAction('barline', { type: 'repeat-start' }); break;
      case 'rep-end': this.paletteAction('barline', { type: 'repeat-end' }); break;
      case 'volta1': this.paletteAction('volta', { number: '1.' }); break;
      case 'volta2': this.paletteAction('volta', { number: '2.' }); break;
      case 'm-insert': this.paletteAction('insertMeasure'); break;
      case 'm-break': this.paletteAction('break', { kind: 'system' }); break;
      case 'm-delete': this.deleteMeasures(); break;
      case 'play': this.togglePlay(); break;
      case 'stop': this.player.stop(); break;
      case 'metronome': this.action('metronome'); this.renderOptionsBar(); break;
      case 'scan': this.scan(); break;
      case 'audio': this.audio(); break;
      case 'export': this.exportDialog(); break;
    }
    void el;
  }
  /** Frameless desktop window (Electron): draw minimise / maximise / close into the glass title bar. */
  buildWindowControls() {
    const n = native(); const wc = n?.windowControls;
    const appEl = document.getElementById('app');
    if (!wc) return;
    appEl.classList.add('frameless');
    if (n.platform === 'mac') { this.el.topbar.classList.add('mac-traffic'); return; }
    const box = document.createElement('div'); box.className = 'win-controls';
    box.innerHTML = `<button data-w="min" title="최소화">${icon('winMin')}</button><button data-w="max" title="최대화">${icon('winMax')}</button><button data-w="close" class="close" title="닫기">${icon('winClose')}</button>`;
    this.el.topbar.querySelector('.bar').appendChild(box);
    box.querySelector('[data-w=min]').addEventListener('click', () => wc.minimize());
    box.querySelector('[data-w=max]').addEventListener('click', () => wc.toggleMaximize().then(st => st && this.updateWinState(st)));
    box.querySelector('[data-w=close]').addEventListener('click', () => this.requestClose());
    if (!this._winStateBound) { this._winStateBound = true; wc.onStateChange?.(st => this.updateWinState(st)); }
    wc.getState?.().then(st => st && this.updateWinState(st)).catch(() => {});
  }
  updateWinState(st) {
    const appEl = document.getElementById('app');
    appEl.classList.toggle('win-max', !!st.maximized); appEl.classList.toggle('win-full', !!st.fullscreen); appEl.classList.toggle('win-blur', st.focused === false);
    const b = this.el.topbar.querySelector('.win-controls [data-w=max]');
    if (b) { b.innerHTML = icon(st.maximized || st.fullscreen ? 'winRestore' : 'winMax'); b.title = st.maximized || st.fullscreen ? '이전 크기로' : '최대화'; }
  }
  async requestClose() {
    const app = this.app;
    if (app.dirty && !app.settings.autosave) {
      const v = await D.showDialog({ title: '닫기 전에 저장할까요?', body: '<p>저장하지 않은 변경사항이 있습니다.</p>', buttons: [{ label: '저장 안 함', value: 'discard', danger: true }, { label: t('cancel'), value: null }, { label: t('save'), value: 'save', primary: true }] });
      if (!v) return;
      if (v === 'save' && !(await this.save())) return;
    } else if (app.dirty) await storage.saveDraft(app.score, { fileName: app.fileName });
    native()?.windowControls?.close();
  }
  async toggleFullscreen() {
    const wc = native()?.windowControls;
    if (wc?.toggleFullScreen) { const st = await wc.toggleFullScreen(); if (st) this.updateWinState(st); return; }
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { this.toast('이 환경에서는 전체 화면을 사용할 수 없습니다', 'warn'); }
  }
  buildStatusbar() {
    this.el.status.innerHTML = `<div class="bar glass">
      <div class="seg" data-views>${[['single', 'pageSingle', t('viewSingle')], ['vertical', 'pageVertical', t('viewVertical')], ['horizontal', 'pageHorizontal', t('viewHorizontal')], ['grid', 'pageGrid', t('viewGrid')], ['reflow', 'reflow', t('viewReflow')]].map(([m, ic, lb]) => `<button data-view="${m}" title="${lb}">${icon(ic)}</button>`).join('')}</div>
      <span class="dot-sep"></span>
      <button data-act="zoomOut" title="${t('zoomOut')}">${icon('minus')}</button><button data-act="zoomMenu" data-zoom style="min-width:52px;justify-content:center">100%</button><button data-act="zoomIn" title="${t('zoomIn')}">${icon('plus')}</button><button data-act="fitWidth" title="${t('fitWidth')}">${icon('fit')}</button>
      <span class="dot-sep"></span>
      <button data-act="prevPage" title="이전 페이지">${icon('left')}</button><span data-page>1 / 1</span><button data-act="nextPage" title="다음 페이지">${icon('right')}</button>
      <span class="dot-sep"></span>
      <span data-info></span>
      <span class="dot-sep" data-save-sep></span>
      <span data-save></span>
    </div>`;
    this.el.status.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => this.setView(b.dataset.view)));
    this.el.status.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this.action(b.dataset.act, {}, b)));
  }
  buildMobile() {
    const mb = this.el.mobilebar; mb.classList.add('glass'); mb.hidden = false;
    mb.innerHTML = [['view', 'score', '보기'], ['input', 'noteInput', '입력'], ['palette', 'palette', '기호'], ['inspector', 'sliders', '속성'], ['file', 'file', '파일']].map(([k, ic, lb]) => `<button data-tab="${k}">${icon(ic)}<span>${lb}</span></button>`).join('');
    mb.querySelectorAll('button').forEach(b => b.addEventListener('click', () => this.mobileTab(b.dataset.tab)));
    this.el.inputbar.classList.add('glass');
  }
  renderInputbar() {
    const bar = this.el.inputbar; const app = this.app;
    const show = app.mode === 'input' && isMobileLayout();
    bar.hidden = !show; if (!show) return;
    closeFlyout();
    const inp = app.input;
    const staff = staffList(app.score)[app.cursor?.si ?? 0]?.staff;
    const F = groupFactory(app, this); const groups = []; const Fy = (g) => { groups.push(g); return groupHTML(g, 'bar'); };
    let html = '';
    if (staff?.type === 'percussion') {
      const dm = staff.drumMap || {};
      html += Object.entries(dm).slice(0, 10).map(([k, v]) => `<button data-drum="${k}" class="${inp.drum === k ? 'on' : ''}" title="${v.name}">${drumIcon(k)}</button>`).join('') + '<span class="sep"></span>';
    } else if (staff?.type === 'tab') {
      html += [0, 1, 2, 3, 4, 5, 7, 9, 12].map(f => `<button data-fret="${f}" class="${(inp.fret ?? 0) === f ? 'on' : ''}" style="font-weight:700;font-size:15px">${f}</button>`).join('') + '<span class="sep"></span>';
    }
    // grouped like the desktop bar: tap = use, long-press = choose the variant
    html += Fy(F.noteDur()) + Fy(F.restDur()) + Fy(F.dots()) + Fy(F.tie()) + Fy(F.tuplet()) + '<span class="sep"></span>';
    if (staff?.type === 'standard' || !staff) html += Fy(F.accidental()) + `<button data-x="piano" class="${this.piano.visible ? 'on' : ''}" title="피아노 건반">${icon('piano')}</button>`;
    html += `<span class="sep"></span><button data-x="delete" title="삭제">${icon('trash')}</button><button data-x="done" title="입력 끝" style="color:var(--accent)">${icon('check')}</button>`;
    bar.innerHTML = html;
    bindGroups(bar, groups, { placement: 'above' });
    bar.querySelectorAll('[data-drum]').forEach(b => b.addEventListener('click', () => { app.setInput({ drum: b.dataset.drum }); app.inputNote({ drum: b.dataset.drum }); }));
    bar.querySelectorAll('[data-fret]').forEach(b => b.addEventListener('click', () => this.setFret(+b.dataset.fret)));
    bar.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => {
      const x = b.dataset.x;
      if (x === 'piano') this.piano.toggle();
      else if (x === 'delete') app.deleteSelection();
      else if (x === 'done') app.setMode('select');
    }));
  }
  mobileTab(tab) {
    const app = this.app;
    if (tab === 'view') { app.setMode('select'); this.viewSheet(); }
    else if (tab === 'input') { app.toggleMode(); if (app.mode === 'input') this.toast('오선을 누른 채 위아래로 밀어 음높이를 고르고, 손을 떼면 음표가 들어갑니다', 'info', { timeout: 4200 }); }
    else if (tab === 'palette') { const { close } = showSheet(t('palette'), '<div class="sheet-palette" style="display:flex;flex-direction:column;min-height:50vh"></div>', sh => { const host = sh.querySelector('.sheet-palette'); const r = () => renderPalette(host, app, this, this.paletteState); r(); this._sheetPalette = r; }); this._closeSheet = close; }
    else if (tab === 'inspector') { const { close } = showSheet(t('inspector'), '<div class="sheet-insp"></div>', sh => { const host = sh.querySelector('.sheet-insp'); const r = () => renderInspector(host, app, this); r(); this._sheetInsp = r; }); this._closeSheet = close; }
    else if (tab === 'file') this.fileSheet();
    this.updateMobileBar();
  }
  updateMobileBar() { this.el.mobilebar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === 'input' && this.app.mode === 'input')); }
  viewSheet() {
    const views = [['reflow', 'reflow', '화면 맞춤 (연속)'], ['vertical', 'pageVertical', '페이지 (세로)'], ['horizontal', 'pageHorizontal', '페이지 (가로)'], ['grid', 'pageGrid', '여러 페이지 한눈에'], ['single', 'pageSingle', '한 페이지씩']];
    showSheet('보기', `<div class="cards" style="padding:4px 14px 18px">${views.map(([m, ic, lb]) => `<button class="card ${this.app.viewMode === m ? 'on' : ''}" data-v="${m}">${icon(ic)}<b>${lb}</b></button>`).join('')}</div><div class="btn-row" style="padding:0 14px 16px"><button class="btn" data-z="out">${icon('zoomOut')} 축소</button><button class="btn" data-z="in">${icon('zoomIn')} 확대</button><button class="btn" data-z="fit">${icon('fit')} 맞춤</button></div>`, (sh, close) => {
      sh.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { this.setView(b.dataset.v); close(); }));
      sh.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => { const z = b.dataset.z; if (z === 'in') this.view.zoomBy(1.2); else if (z === 'out') this.view.zoomBy(1 / 1.2); else this.view.fit('width'); }));
    });
  }
  fileSheet() {
    const items = [['new', 'new', t('new')], ['scan', 'scan', '사진으로 인식'], ['audio', 'audio', '음원으로 악보'], ['open', 'open', t('open')], ['save', 'save', t('save')], ['saveAs', 'save', t('saveAs')], ['export', 'export', t('export')], ['share', 'share', '공유'], ['meta', 'pencil', '제목/작곡가'], ['instruments', 'sliders', '악기(파트)'], ['pageSetup', 'pageSingle', '페이지 설정'], ['transpose', 'refresh', '조옮김'], ['shortcuts', 'keyboard', '단축키'], ['settings', 'settings', '설정'], ['about', 'info', '정보']];
    showSheet('파일 · 악보', `<div class="cards" style="padding:4px 14px 18px">${items.map(([a, ic, lb]) => `<button class="card" data-a="${a}">${icon(ic)}<b>${lb}</b></button>`).join('')}</div>`, (sh, close) => sh.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => { close(); this.action(b.dataset.a); })));
  }

  // ---------------------------------------------------------------- events
  bindAppEvents() {
    const app = this.app;
    let panelTimer = null;
    const panels = () => { clearTimeout(panelTimer); panelTimer = setTimeout(() => this.renderPanels(), 30); };
    app.addEventListener('selection', () => { panels(); this.hideMini(); this.updateSourcePeek(); this.updateStatus(); this.piano.refresh(); this.scheduleOptions(); });
    app.addEventListener('mode', () => { panels(); this.updateMode(); this.updateHint(); this.renderInputbar(); this.updateMobileBar(); this.view.setGhost(null); this.scheduleOptions(); this.updateRail(); });
    app.addEventListener('tool', () => { this.updateRail(); this.updateHint(); this.scheduleOptions(); this.view.setGhost(null); this.view.setHover(null); this.view.updateSelection(); this.view.container.style.cursor = ''; });
    app.addEventListener('input', () => { panels(); this.renderInputbar(); this.updateStatus(); this.scheduleOptions(); });
    app.addEventListener('change', () => { this.scheduleAutosave(); this.player.pb = null; });
    app.addEventListener('dirty', () => this.updateTitle());
    app.addEventListener('change', () => this.scheduleOptions());
    app.addEventListener('document', () => { this.updateTitle(); this.renderPanels(); this.reviewState = this.reviewState?.scoreRef === app.score ? this.reviewState : null; this.updateReviewBar(); });
    app.addEventListener('layout', () => { this.scheduleThumbs(); this.updateStatus(); this.drawReviewMarks(); if (this.reviewState?.lowLyrics?.length) this.updateReviewBar(); });
    app.addEventListener('zoom', () => this.updateStatus());
    app.addEventListener('page', () => this.updateStatus());
    app.addEventListener('viewmode', () => this.updateStatus());
    app.addEventListener('error', e => this.toast(e.detail.message, 'error', { timeout: 5000 }));
    this.view.container.addEventListener('scroll', () => { clearTimeout(this._scrollT); this._scrollT = setTimeout(() => this.trackScrollPage(), 80); this.hideMini(); }, { passive: true });
  }
  bindPlayer() {
    const p = this.player; let lastMi = null;
    p.addEventListener('state', () => { const b = this.el.topbar.querySelector('[data-act=play]'); if (b) { b.innerHTML = icon(p.playing ? 'pause' : 'play'); b.classList.toggle('on', p.playing); } this.renderOptionsBar(); });
    p.addEventListener('cursor', e => {
      const d = e.detail;
      if (!d) { this.view.highlightPlaying([]); this.view.setPlayCursor(null); lastMi = null; return; }
      this.view.highlightPlaying(d.ids);
      if (d.mi != null) {
        const r = this.view.measureRect(d.mi);
        if (r) this.view.setPlayCursor({ page: r.page, svg: `<rect class="play-cursor" x="${(r.x + r.measure.width * d.frac - 0.5).toFixed(2)}" y="${r.y.toFixed(2)}" width="1" height="${r.h.toFixed(2)}" rx="0.5"/>` });
        if (d.mi !== lastMi) { lastMi = d.mi; this.view.scrollToMeasure(d.mi); }
      }
    });
  }
  bindGlobal() {
    // drag & drop files
    const main = document.body;
    main.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); main.classList.add('dropping'); } });
    main.addEventListener('dragleave', e => { if (e.target === main || !e.relatedTarget) main.classList.remove('dropping'); });
    main.addEventListener('drop', e => { e.preventDefault(); main.classList.remove('dropping'); const files = [...(e.dataTransfer?.files || [])]; if (files.length) this.openFiles(files.map(f => ({ name: f.name, blob: f }))); });
    // paste images / clips
    document.addEventListener('paste', e => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); this.scan({ files: files.map(f => ({ name: f.name || 'clipboard.png', blob: f })) }); return; }
      const txt = e.clipboardData?.getData('text/plain') || '';
      if (txt.startsWith('scoresnap-clip:')) { e.preventDefault(); try { this.app.pasteClipboard(JSON.parse(txt.slice(15))); } catch { /* ignore */ } }
      else if (/<score-partwise|<score-timewise/.test(txt)) { e.preventDefault(); this.openText('clipboard.musicxml', txt); }
    });
    window.addEventListener('beforeunload', e => { if (this.app.dirty && !this.app.settings.autosave && !native()) { e.preventDefault(); e.returnValue = ''; } });
    native()?.onMenu?.(a => this.nativeMenu(a));
    onNativeOpenFile(f => this.openFiles([f]));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());
    window.addEventListener('jse-layout', (e) => {
      this.renderInputbar(); this.renderPanels(); this.renderOptionsBar(); this.buildRail();
      if (e.detail.kind === 'tablet') this.el.body.classList.add('hide-left', 'hide-right');
      if (e.detail.kind === 'phone' && this.app.viewMode !== 'reflow') this.setView('reflow');
      else if (e.detail.prev === 'phone' && this.app.viewMode === 'reflow') this.setView('vertical');
      this.updateRail();
    });
    this.el.hint.addEventListener('click', e => { if (e.target.closest('[data-hide]')) { this.hintHidden = true; this.updateHint(); } });
  }
  nativeMenu(a) {
    const map = { new: 'new', open: 'open', 'open-image': 'scan', 'import-musicxml': 'open', save: 'save', 'save-as': 'saveAs', export: 'export', print: 'print', undo: 'undo', redo: 'redo', settings: 'settings', 'zoom-in': 'zoomIn', 'zoom-out': 'zoomOut', 'zoom-reset': 'zoom100', 'zoom-fit': 'fitWidth', help: 'shortcuts' };
    this.action(map[a] || a);
  }

  // ---------------------------------------------------------------- rendering helpers
  renderPanels() {
    const host = this.el.left.querySelector('.palette-host');
    if (host && !this.el.body.classList.contains('hide-left')) renderPalette(host, this.app, this, this.paletteState);
    if (!this.el.body.classList.contains('hide-right')) renderInspector(this.el.right, this.app, this);
    this._sheetPalette?.(); this._sheetInsp?.();
    if (this._sheetPalette && !document.querySelector('.sheet-palette')) this._sheetPalette = null;
    if (this._sheetInsp && !document.querySelector('.sheet-insp')) this._sheetInsp = null;
  }
  updateTitle() {
    const app = this.app;
    const name = app.fileName || app.score?.meta.title || t('untitled');
    const tEl = this.el.topbar.querySelector('[data-title]'); if (tEl) tEl.textContent = name;
    const st = this.el.topbar.querySelector('[data-state]'); if (st) { st.classList.toggle('dirty', app.dirty); st.textContent = app.dirty ? (app.settings.autosave ? '자동 저장됨' : '수정됨') : (app.fileName ? '저장됨' : ''); }
    document.title = `${app.dirty ? '• ' : ''}${name} — JSE`;
  }
  updateMode() {
    const input = this.app.mode === 'input';
    this.updateRail?.();
    document.getElementById('app').classList.toggle('input-mode', input);
    this.fab.hidden = input; if (this.fabAudio) this.fabAudio.hidden = input;
    this.view.updateSelection();
  }
  updateStatus() {
    const app = this.app, s = this.el.status; if (!s || !app.layout) return;
    s.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === app.viewMode));
    const z = s.querySelector('[data-zoom]'); if (z) z.textContent = Math.round(app.zoom * 100) + '%';
    const pg = s.querySelector('[data-page]'); if (pg) pg.textContent = `${app.currentPage + 1} / ${app.layout.pages.length}`;
    const info = s.querySelector('[data-info]');
    if (info) {
      if (app.mode === 'input') info.innerHTML = `<b style="color:var(--accent)">입력</b> · ${t(app.input.base)}${app.input.dots ? ' 점' : ''}${app.input.rest ? ' 쉼표' : ''} · ${app.input.voice + 1}성부${this._ghostName ? ' · ' + this._ghostName : ''}`;
      else {
        const sel = app.selection;
        const ts = effectiveTimeSig(app.score, 0), ks = effectiveKeySig(app.score, 0);
        info.textContent = sel.type === 'events' ? `${sel.ids.length}개 선택` : sel.type === 'measure' || sel.type === 'range' ? `마디 ${app.rangeOf(sel).fromMi + 1}${app.rangeOf(sel).toMi > app.rangeOf(sel).fromMi ? '–' + (app.rangeOf(sel).toMi + 1) : ''} 선택` : `${app.score.measures.length}마디 · ${ts.num}/${ts.den} · ${['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'][ks.fifths + 7]}`;
      }
    }
    const sv = s.querySelector('[data-save]'); if (sv) sv.textContent = this._saveText || '';
    const ps = this.el.left.querySelector('[data-pages]'); if (ps) ps.textContent = `${app.layout.pages.length}쪽`;
    this.el.left.querySelectorAll('.thumb').forEach((th, i) => th.classList.toggle('current', i === app.currentPage));
  }
  scheduleThumbs() {
    clearTimeout(this._thumbT);
    this._thumbT = setTimeout(() => {
      const host = this.el.left.querySelector('.thumbs'); if (!host || !this.app.layout) return;
      const pages = this.app.layout.pages;
      host.innerHTML = pages.map((p, i) => `<div><div class="thumb ${i === this.app.currentPage ? 'current' : ''}" data-i="${i}" style="aspect-ratio:${p.width}/${p.height}">${p.svg}</div><div class="thumb-n">${i + 1}</div></div>`).join('');
      host.querySelectorAll('.thumb').forEach(th => th.addEventListener('click', () => this.goToPage(+th.dataset.i)));
    }, 400);
  }
  goToPage(i) {
    const app = this.app; i = Math.max(0, Math.min(app.layout.pages.length - 1, i));
    if (app.viewMode === 'single') this.view.showPage(i);
    else { const el = this.view.pageEls[i]; if (el) { this.view.container.scrollTo({ top: el.offsetTop - 20, left: el.offsetLeft - 20, behavior: 'smooth' }); } app.currentPage = i; app.emit('page'); this.view.pageEls.forEach((p, k) => p.classList.toggle('current', k === i)); }
  }
  trackScrollPage() {
    if (this.app.viewMode === 'single') return;
    const c = this.view.container, mid = c.scrollTop + c.clientHeight / 3, midX = c.scrollLeft + c.clientWidth / 3;
    let best = 0;
    this.view.pageEls.forEach((el, i) => { if ((this.app.viewMode === 'horizontal' ? el.offsetLeft <= midX : el.offsetTop <= mid)) best = i; });
    if (best !== this.app.currentPage) { this.app.currentPage = best; this.updateStatus(); this.view.pageEls.forEach((p, k) => p.classList.toggle('current', k === best)); }
  }
  setView(mode) { this.view.setViewMode(mode); this.updateStatus(); this.app.settings.viewMode = mode; this.app.saveSettings(); }
  updateHint() {
    const h = this.el.hint; const app = this.app;
    if (this.hintHidden || !app.settings.tips) { h.hidden = true; return; }
    let msg = '';
    const tool = app.tool || 'select';
    if (app.mode === 'input') msg = isMobileLayout() ? '오선을 누르고 위아래로 밀어 음높이 선택 → 손을 떼면 다음 자리에 입력 · 기존 음표 위·아래 = 화음' : '심플 입력: 오선 클릭 = 다음 자리에 입력 · 기존 음표 위·아래 클릭 = 화음 · <span class="kbd">5</span> 4분 <span class="kbd">4</span> 8분 <span class="kbd">6</span> 2분 · <span class="kbd">0</span> 쉼표 · <span class="kbd">Esc</span> 끝';
    else if (tool !== 'select') msg = toolById(tool).hint;
    else if (app.selection.type === 'none') msg = isMobileLayout() ? '음표를 누르면 선택돼요 · 아래 <b>입력</b>을 눌러 음표를 넣으세요' : '오선을 <b>더블클릭</b>하면 음표 입력 시작 · 음표를 클릭해 선택하고 <span class="kbd">↑</span><span class="kbd">↓</span>로 음높이 변경';
    else if (app.selection.type === 'events') msg = isMobileLayout() ? '위아래로 드래그해 음높이 변경 · 길게 누르면 메뉴' : '<span class="kbd">↑</span><span class="kbd">↓</span> 음높이 · 숫자키 음길이 · <span class="kbd">Ctrl+L</span> 가사 · <span class="kbd">Ctrl+K</span> 코드 · <span class="kbd">Delete</span> 삭제';
    else msg = '<span class="kbd">Ctrl+C</span> 복사 · <span class="kbd">Ctrl+V</span> 붙여넣기 · <span class="kbd">Shift+클릭</span> 범위 넓히기';
    h.innerHTML = `<span>${msg}</span><button data-hide>숨기기</button>`;
    h.hidden = false;
  }
  applyTheme() {
    const theme = this.app.settings.theme || 'auto';
    const root = document.documentElement;
    root.classList.remove('theme-auto', 'theme-light', 'theme-dark', 'dark');
    root.classList.add('theme-' + theme);
    if (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches) root.classList.add('dark');
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = root.classList.contains('dark') || theme === 'dark' ? '#121726' : '#d9e2fb';
  }
  rebuild() { this.buildTopbar(); this.buildStatusbar(); this.buildMobile(); this.updateTitle(); this.updateMode(); this.updateStatus(); this.renderPanels(); }
  toast(msg, kind = '', opts = {}) { return toast(msg, kind, opts); }
  dialogOpen() { return D.dialogOpen() || !!document.querySelector('.popover,.sheet'); }
  closePopovers() { closePopover(false); hideMenu(); this.hideMini(); }
  hideMini() { hideMiniToolbar(this.el.mini); }
  scheduleOptions() { cancelAnimationFrame(this._obRaf); this._obRaf = requestAnimationFrame(() => this.renderOptionsBar()); }
  showPalette() { this.el.body.classList.remove('hide-left'); this.renderPanels(); setTimeout(() => this.el.left.querySelector('.pal-search input')?.focus(), 50); }
  showGhostInfo(r, touch = false) {
    let name = '';
    if (r.pitch) name = pitchName(r.pitch).replace('#', '♯').replace(/b(\d)/, '♭$1');
    else if (r.drum) name = staffList(this.app.score)[r.si]?.staff.drumMap?.[r.drum]?.name || r.drum;
    else if (r.string) name = `${r.string}번 줄`;
    this._ghostName = name; this.updateStatus();
    if (touch) this.showPitchHint(null, 0, name);
  }
  showPitchHint(hit, steps, label = null) {
    const h = this.el.hint;
    let text = label;
    if (!text && hit) {
      const f = findEvent(this.app.score, hit.eventId);
      if (f?.ev.kind === 'note') { const n = f.ev.notes[hit.noteIndex ?? 0]; text = `${pitchName(n)} → ${steps > 0 ? '+' : ''}${steps}`; }
    }
    if (!text) return;
    h.innerHTML = `<span style="font-weight:700;font-size:15px">${escapeXml(text)}</span>`; h.hidden = false;
  }
  hidePitchHint() { this.updateHint(); }
  audition(r) {
    if (!r) return;
    const staff = staffList(this.app.score)[r.si]?.staff;
    if (staff?.type === 'percussion') this.player.preview(staff.drumMap?.[r.drum]?.midi ?? 38, 0, 9);
    else if (r.pitch) this.player.preview(midiOf(r.pitch), staffList(this.app.score)[r.si]?.part.midiProgram || 0);
  }

  // ---------------------------------------------------------------- menus
  openMenu(name, anchor) {
    const app = this.app; const has = app.selection.type !== 'none';
    const M = {
      file: [
        { label: t('new'), icon: 'new', key: 'Ctrl+N', onClick: () => this.action('new') },
        { label: t('open') + '…', icon: 'open', key: 'Ctrl+O', onClick: () => this.action('open') },
        { label: '사진·PDF로 악보 인식…', icon: 'scan', onClick: () => this.action('scan') },
        { label: '음원으로 악보 만들기…', icon: 'audio', onClick: () => this.action('audio') },
        { label: '최근 파일…', icon: 'file', onClick: () => this.action('recent') },
        { label: '예제 악보 열기', icon: 'score', onClick: () => this.action('example') },
        { sep: true },
        { label: t('save'), icon: 'save', key: 'Ctrl+S', onClick: () => this.action('save') },
        { label: t('saveAs') + '…', icon: 'save', key: 'Ctrl+Shift+S', onClick: () => this.action('saveAs') },
        { label: t('export') + '…', icon: 'export', key: 'Ctrl+Shift+E', onClick: () => this.action('export') },
        { label: '인쇄…', icon: 'print', onClick: () => this.action('print') },
      ],
      edit: [
        { label: t('undo'), icon: 'undo', key: 'Ctrl+Z', disabled: !app.history.undo.length, onClick: () => app.undo() },
        { label: t('redo'), icon: 'redo', key: 'Ctrl+Y', disabled: !app.history.redo.length, onClick: () => app.redo() },
        { sep: true },
        { label: t('cut'), icon: 'cut', key: 'Ctrl+X', disabled: !has, onClick: () => app.cutSelection() },
        { label: t('copy'), icon: 'copy', key: 'Ctrl+C', disabled: !has, onClick: () => { app.copySelection(); this.toast('복사했습니다'); } },
        { label: t('paste'), icon: 'paste', key: 'Ctrl+V', disabled: !app.clipboard, onClick: () => this.pasteSmart() },
        { label: t('delete'), icon: 'trash', key: 'Del', disabled: !has, onClick: () => app.deleteSelection() },
        { label: '선택 반복', icon: 'copy', key: 'R', disabled: !has, onClick: () => this.action('repeat') },
        { label: t('selectAll'), key: 'Ctrl+A', onClick: () => app.select({ type: 'range', fromMi: 0, toMi: app.score.measures.length - 1, s0: 0, s1: totalStaffCount(app.score) - 1 }) },
        { sep: true },
        { label: '조옮김…', icon: 'refresh', onClick: () => this.transposeDialog() },
        { label: '가사 한 줄 붙이기…', icon: 'lyrics', onClick: () => this.lyricsLineDialog() },
        { label: '모든 마디 박자 맞추기', icon: 'check', onClick: () => { const n = app.exec('박자 맞추기', s => C.fixMeasures(s)); this.toast(n ? `${n}개 성부를 고쳤습니다` : '모든 마디의 박자가 맞습니다', 'ok'); } },
      ],
      view: [
        { header: '보기 방식' },
        ...[['single', 'pageSingle', t('viewSingle')], ['vertical', 'pageVertical', t('viewVertical')], ['horizontal', 'pageHorizontal', t('viewHorizontal')], ['grid', 'pageGrid', t('viewGrid')], ['reflow', 'reflow', t('viewReflow')]].map(([m, ic, lb]) => ({ label: (app.viewMode === m ? '✓ ' : '') + lb, icon: ic, onClick: () => this.setView(m) })),
        { sep: true },
        { label: t('zoomIn'), icon: 'zoomIn', key: 'Ctrl++', onClick: () => this.view.zoomBy(1.15) },
        { label: t('zoomOut'), icon: 'zoomOut', key: 'Ctrl+-', onClick: () => this.view.zoomBy(1 / 1.15) },
        { label: t('fitWidth'), icon: 'fit', key: 'Ctrl+0', onClick: () => this.view.fit('width') },
        { label: t('fitPage'), icon: 'pageSingle', onClick: () => this.view.fit('page') },
        { label: '전체 화면', icon: 'fullscreen', key: 'F11', onClick: () => this.toggleFullscreen() },
        { sep: true },
        { label: '팔레트 보기/숨기기', icon: 'sidebarLeft', onClick: () => this.action('toggleLeft') },
        { label: '속성 보기/숨기기', icon: 'sidebarRight', onClick: () => this.action('toggleRight') },
        { label: '피아노 건반', icon: 'piano', onClick: () => this.piano.toggle() },
        { label: '원본 사진 대조', icon: 'photo', disabled: !app.score.sources?.length, onClick: () => this.toggleSourcePeek() },
      ],
      score: [
        { label: '제목/작곡가…', icon: 'pencil', onClick: () => this.metaDialog() },
        { label: '악기(파트)…', icon: 'sliders', onClick: () => this.instrumentsDialog() },
        { label: '페이지 설정…', icon: 'pageSingle', onClick: () => this.pageSetupDialog() },
        { sep: true },
        { label: '마디 끝에 추가', icon: 'plus', key: 'Ctrl+B', onClick: () => app.exec('마디 추가', s => C.appendMeasures(s, 1)) },
        { label: '선택 앞에 마디 삽입', icon: 'plus', key: 'Ctrl+Ins', onClick: () => { const ip = app.insertPoint(); app.exec('마디 삽입', s => C.insertMeasures(s, ip.mi, 1)); } },
        { label: '선택한 마디 삭제', icon: 'trash', key: 'Ctrl+Del', disabled: !has, onClick: () => this.deleteMeasures() },
        { sep: true },
        { label: '박자표…', onClick: () => D.timeSigDialog(app, app.insertPoint().mi) },
        { label: '템포…', icon: 'metronome', onClick: () => D.tempoDialog(app, app.insertPoint().mi) },
        { label: '코드 기호 입력', icon: 'chord', key: 'Ctrl+K', onClick: () => this.startChordEntry() },
        { label: '가사 입력', icon: 'lyrics', key: 'Ctrl+L', onClick: () => this.startLyricEntry() },
        { label: '리허설 마크', key: 'Ctrl+M', onClick: () => this.addRehearsalMark() },
        { sep: true },
        { label: (this.player.metronome ? '✓ ' : '') + '재생 시 메트로놈', icon: 'metronome', onClick: () => this.action('metronome') },
      ],
      export: [
        { label: 'PDF', icon: 'export', key: 'Ctrl+P', onClick: () => this.exportDialog('pdf') },
        { label: 'PNG 이미지', icon: 'image', onClick: () => this.exportDialog('png') },
        { label: 'JPG 이미지', icon: 'image', onClick: () => this.exportDialog('jpg') },
        { label: 'SVG 벡터', icon: 'image', onClick: () => this.exportDialog('svg') },
        { label: 'MusicXML (다른 악보 프로그램용)', icon: 'file', onClick: () => this.exportDialog('musicxml') },
        { label: 'MIDI', icon: 'piano', onClick: () => this.exportDialog('midi') },
        { label: 'JSE 파일 (.ssnap)', icon: 'save', onClick: () => this.exportDialog('ssnap') },
      ],
      help: [
        { label: '시작 안내', icon: 'spark', onClick: () => this.welcome(true) },
        { label: t('shortcuts'), icon: 'keyboard', key: 'F1', onClick: () => D.shortcutsDialog() },
        { label: t('checkUpdate'), icon: 'update', onClick: () => this.updater.check(true) },
        { label: t('settings') + '…', icon: 'settings', onClick: () => D.settingsDialog(app, this) },
        { label: t('about'), icon: 'info', onClick: () => D.aboutDialog(this.version) },
      ],
    };
    const items = M[name]; if (!items) return;
    anchor?.setAttribute('aria-expanded', 'true');
    const m = showMenu(0, 0, items, { anchorEl: anchor });
    const obs = new MutationObserver(() => { if (!m.isConnected) { anchor?.setAttribute('aria-expanded', 'false'); obs.disconnect(); } });
    obs.observe(document.getElementById('layer'), { childList: true });
  }
  showContextMenu(x, y, hit) {
    const app = this.app; const items = [];
    if (hit?.eventId || app.selection.type === 'events') {
      if (hit?.eventId && !(app.selection.type === 'events' && app.selection.ids.includes(hit.eventId))) app.select({ type: 'events', ids: [hit.eventId], noteIndex: hit.noteIndex });
      items.push(
        { label: t('cut'), icon: 'cut', key: 'Ctrl+X', onClick: () => app.cutSelection() },
        { label: t('copy'), icon: 'copy', key: 'Ctrl+C', onClick: () => { app.copySelection(); this.toast('복사했습니다'); } },
        { label: t('paste'), icon: 'paste', key: 'Ctrl+V', disabled: !app.clipboard, onClick: () => this.pasteSmart() },
        { label: t('delete'), icon: 'trash', key: 'Del', onClick: () => app.deleteSelection() },
        { sep: true },
        { label: '여기서 음표 입력', icon: 'noteInput', key: 'N', onClick: () => { app.setMode('input'); } },
        { label: '가사', icon: 'lyrics', key: 'Ctrl+L', onClick: () => this.startLyricEntry() },
        { label: '코드 기호', icon: 'chord', key: 'Ctrl+K', onClick: () => this.startChordEntry() },
        { label: '텍스트', icon: 'text', key: 'Ctrl+T', onClick: () => this.addTextDialog('expression') },
        { sep: true },
        { label: '붙임줄', key: 'T', onClick: () => this.paletteAction('tie') },
        { label: '이음줄', key: 'S', onClick: () => this.addSlur() },
        { label: '셋잇단음표로', key: 'Ctrl+3', onClick: () => this.tuplet(3) },
        { label: '기둥 방향 뒤집기', key: 'X', onClick: () => this.keyboard.flipStems() },
        { sep: true },
        { label: '이 마디 선택', icon: 'measure', onClick: () => { const f = findEvent(app.score, app.selection.ids[0]); if (f) app.select({ type: 'measure', mi: f.mi, si: f.staffIndex }); } },
      );
    } else if (hit?.kind === 'text') {
      app.select({ type: 'text', ref: hit.ref });
      items.push({ label: '편집', icon: 'pencil', key: 'Enter', onClick: () => this.editText(hit.ref) }, { label: t('delete'), icon: 'trash', onClick: () => app.deleteSelection() });
    } else if (hit?.mi != null || app.selection.type === 'measure' || app.selection.type === 'range') {
      if (hit?.mi != null && !(app.selection.type === 'measure' || app.selection.type === 'range')) app.select({ type: 'measure', mi: hit.mi, si: hit.si });
      const mi = hit?.mi ?? app.rangeOf(app.selection).fromMi;
      items.push(
        { label: '여기서 음표 입력', icon: 'noteInput', onClick: () => { app.cursor = { mi, si: hit?.si ?? 0, vi: app.input.voice, tick: 0 }; app.setMode('input'); } },
        { label: t('copy'), icon: 'copy', onClick: () => { app.copySelection(); this.toast('복사했습니다'); } },
        { label: t('paste'), icon: 'paste', disabled: !app.clipboard, onClick: () => this.pasteSmart() },
        { label: '내용 지우기', icon: 'trash', onClick: () => app.deleteSelection() },
        { sep: true },
        { label: '앞에 마디 삽입', icon: 'plus', onClick: () => app.exec('마디 삽입', s => C.insertMeasures(s, mi, 1)) },
        { label: '뒤에 마디 추가', icon: 'plus', onClick: () => app.exec('마디 추가', s => C.insertMeasures(s, mi + 1, 1)) },
        { label: '마디 삭제', icon: 'trash', onClick: () => this.deleteMeasures() },
        { sep: true },
        { label: '박자표…', onClick: () => D.timeSigDialog(app, mi) },
        { label: '템포…', icon: 'metronome', onClick: () => D.tempoDialog(app, mi) },
        { label: '코드 기호', icon: 'chord', onClick: () => this.startChordEntry() },
        { label: '리허설 마크', onClick: () => this.addRehearsalMark() },
        { label: '도돌이표 시작', onClick: () => this.paletteAction('barline', { type: 'repeat-start' }) },
        { label: '도돌이표 끝', onClick: () => this.paletteAction('barline', { type: 'repeat-end' }) },
        { label: '여기서 줄 바꿈', onClick: () => app.exec('줄 바꿈', s => C.toggleBreak(s, mi, 'system')) },
        { label: '여기부터 재생', icon: 'play', onClick: () => this.player.play(mi) },
      );
    } else {
      items.push({ label: t('paste'), icon: 'paste', disabled: !app.clipboard, onClick: () => this.pasteSmart() }, { label: '마디 끝에 추가', icon: 'plus', onClick: () => app.exec('마디 추가', s => C.appendMeasures(s, 1)) }, { label: '사진으로 인식…', icon: 'scan', onClick: () => this.scan() });
    }
    showMenu(x, y, items);
  }
  hideContextMenu() { hideMenu(); }

  // ---------------------------------------------------------------- actions (toolbar / menus / native)
  async action(act, args = {}, el = null) {
    const app = this.app;
    switch (act) {
      case 'undo': app.undo(); break;
      case 'redo': app.redo(); break;
      case 'modeSelect': app.setMode('select'); break;
      case 'modeInput': app.setMode('input'); break;
      case 'play': this.togglePlay(); break;
      case 'stop': this.player.stop(); break;
      case 'metronome': this.player.metronome = !this.player.metronome; this.scheduleOptions(); this.toast(this.player.metronome ? '메트로놈 켬' : '메트로놈 끔'); break;
      case 'scan': this.scan(); break;
      case 'audio': this.audio(); break;
      case 'export': this.exportDialog(); break;
      case 'update': if (this.updater.status.state === 'ready') this.updater.install(); else this.updater.check(true); break;
      case 'settings': D.settingsDialog(app, this); break;
      case 'toggleLeft': this.el.body.classList.toggle('hide-left'); this.renderPanels(); this.updateRail(); setTimeout(() => this.view.fitMode && this.view.applyFit(), 50); break;
      case 'toggleRight': this.el.body.classList.toggle('hide-right'); this.renderPanels(); this.updateRail(); setTimeout(() => this.view.fitMode && this.view.applyFit(), 50); break;
      case 'zoomIn': this.view.zoomBy(1.15); break;
      case 'zoomOut': this.view.zoomBy(1 / 1.15); break;
      case 'zoom100': this.view.setZoom(1); break;
      case 'fitWidth': this.view.fit('width'); break;
      case 'zoomMenu': showMenu(0, 0, [50, 75, 100, 125, 150, 200].map(z => ({ label: z + '%', onClick: () => this.view.setZoom(z / 100) })).concat([{ sep: true }, { label: t('fitWidth'), onClick: () => this.view.fit('width') }, { label: t('fitPage'), onClick: () => this.view.fit('page') }]), { anchorEl: el }); break;
      case 'prevPage': this.goToPage(app.currentPage - 1); break;
      case 'nextPage': this.goToPage(app.currentPage + 1); break;
      case 'new': if (await this.confirmDiscard()) D.newScoreDialog(app, this); break;
      case 'open': this.openFile(); break;
      case 'recent': this.recentDialog(); break;
      case 'example': if (await this.confirmDiscard()) { app.setScore(exampleScore(), { fileName: null }); this.view.fit('width'); } break;
      case 'save': this.save(); break;
      case 'saveAs': this.saveAs(); break;
      case 'print': if (!printLayout(app.layout)) this.toast('팝업이 차단되어 인쇄 창을 열 수 없습니다. PDF로 내보내 인쇄하세요.', 'warn'); break;
      case 'share': this.share(); break;
      case 'repeat': { const ids = app.selectedEventIds(); if (ids.length) { const nids = app.exec('반복', s => C.repeatEvents(s, ids)); if (nids?.length) app.select({ type: 'events', ids: nids }); } break; }
      case 'meta': this.metaDialog(); break;
      case 'instruments': this.instrumentsDialog(); break;
      case 'pageSetup': this.pageSetupDialog(); break;
      case 'transpose': this.transposeDialog(); break;
      case 'shortcuts': D.shortcutsDialog(); break;
      case 'about': D.aboutDialog(this.version); break;
      case 'mobileMenu': this.fileSheet(); break;
      case 'mobileMore': showMenu(0, 0, [
        { label: '사진으로 인식', icon: 'scan', onClick: () => this.scan() },
        { label: '음원으로 악보 만들기', icon: 'audio', onClick: () => this.audio() },
        { label: t('export'), icon: 'export', onClick: () => this.exportDialog() },
        { label: t('save'), icon: 'save', onClick: () => this.save() },
        { label: '피아노 건반', icon: 'piano', onClick: () => this.piano.toggle() },
        { label: (this.player.metronome ? '✓ ' : '') + '메트로놈', icon: 'metronome', onClick: () => this.action('metronome') },
        { label: t('settings'), icon: 'settings', onClick: () => D.settingsDialog(app, this) },
      ], { anchorEl: el }); break;
      default: console.warn('unknown action', act);
    }
  }
  togglePlay() { if (!this.player.playing) { const sel = this.app.selection; const mi = sel.type === 'events' ? findEvent(this.app.score, sel.ids[0])?.mi : sel.type === 'measure' || sel.type === 'range' ? this.app.rangeOf(sel).fromMi : null; this.player.play(this.player.offset > 0 && mi == null ? null : mi); } else this.player.pause(); }

  // ---------------------------------------------------------------- palette actions
  /** Range used by measure-level actions: current selection or cursor measure. */
  measureRange() {
    const app = this.app; const s = app.selection;
    if (s.type === 'measure' || s.type === 'range') return app.rangeOf(s);
    if (s.type === 'events' && s.ids.length) { const fs = s.ids.map(id => findEvent(app.score, id)).filter(Boolean); const mis = fs.map(f => f.mi); return { fromMi: Math.min(...mis), toMi: Math.max(...mis), s0: fs[0].staffIndex, s1: fs[0].staffIndex }; }
    const c = app.cursor || { mi: 0, si: 0 }; return { fromMi: c.mi, toMi: c.mi, s0: c.si, s1: c.si };
  }
  needSelection(msg = '먼저 음표를 선택하세요') { if (!this.app.selectedEventIds().length) { this.toast(msg, 'warn'); return false; } return true; }
  paletteAction(act, args = {}) {
    const app = this.app; const inputMode = app.mode === 'input'; const sel = app.selection;
    const ids = () => app.selectedEventIds();
    const noteIds = () => ids().filter(id => findEvent(app.score, id)?.ev.kind === 'note');
    const keep = { select: app.selection };
    switch (act) {
      case 'duration': app.setInput({ base: args.base, dots: 0, rest: false }); if (!inputMode && ids().length) app.exec('음길이', s => C.setDuration(s, ids(), args.base, 0), keep); break;
      case 'dot': if (!inputMode && ids().length) app.exec('점', s => C.toggleDot(s, ids()), keep); else app.setInput({ dots: app.input.dots === 1 ? 0 : 1 }); break;
      case 'dot2': if (!inputMode && ids().length) app.exec('겹점', s => { for (const id of ids()) { const f = findEvent(s, id); if (f) C.setDuration(s, [id], f.ev.dur.base, f.ev.dur.dots === 2 ? 0 : 2); } }, keep); else app.setInput({ dots: app.input.dots === 2 ? 0 : 2 }); break;
      case 'restDuration': {
        // Finale's Simple Entry Rests palette: choose a rest value, then click in the staff
        const base = args.base;
        if (!inputMode && ids().length) { const sel2 = ids(); app.setInput({ base, rest: true, dots: 0 }); app.exec('쉼표', s => { C.deleteEvents(s, sel2.filter(id => findEvent(s, id)?.ev.kind === 'note')); C.setDuration(s, sel2, base, 0); }, keep); break; }
        if (!inputMode) app.setTool('entry');
        app.setInput({ base, rest: true, dots: 0 });
        if (!inputMode) this.toast(`${{ breve: '겹온쉼표', whole: '온쉼표', half: '2분쉼표', quarter: '4분쉼표', eighth: '8분쉼표', '16th': '16분쉼표', '32nd': '32분쉼표', '64th': '64분쉼표' }[base]} — 오선을 클릭하면 다음 자리에 들어갑니다`, 'info');
        break;
      }
      case 'rest': if (inputMode) app.setInput({ rest: !app.input.rest }); else if (noteIds().length) app.exec('쉼표로', s => C.deleteEvents(s, noteIds()), keep); else { app.setMode('input'); app.setInput({ rest: true }); } break;
      case 'tie': if (inputMode && !ids().length) app.setInput({ tie: !app.input.tie }); else if (noteIds().length) app.exec('붙임줄', s => C.toggleTie(s, noteIds()), keep); else app.setInput({ tie: !app.input.tie }); break;
      case 'tuplet': this.tuplet(args.n); break;
      case 'grace': if (!inputMode && noteIds().length) app.exec('꾸밈음', s => { for (const id of noteIds()) { const f = findEvent(s, id); C.setEventProp(s, [id], 'grace', f.ev.grace ? null : { slash: true }); } }, keep); else app.setInput({ grace: !app.input.grace }); break;
      case 'voice': app.setInput({ voice: args.v }); if (!inputMode && noteIds().length) app.exec('성부', s => C.setVoiceOfEvents(s, noteIds(), args.v), keep); if (app.cursor) app.cursor.vi = args.v; break;
      case 'toggleMode': app.toggleMode(); break;
      case 'pianoKeyboard': this.piano.toggle(); break;
      case 'accidental':
        if (inputMode && !(sel.type === 'events' && sel.last)) app.setInput({ accidental: app.input.accidental === args.acc ? null : args.acc });
        else if (noteIds().length) app.exec('임시표', s => C.setAccidental(s, noteIds(), args.acc), keep);
        else app.setInput({ accidental: app.input.accidental === args.acc ? null : args.acc });
        break;
      case 'respell': if (this.needSelection()) app.exec('이명동음', s => C.respellEnharmonic(s, noteIds()), keep); break;
      case 'articulation': if (this.needSelection()) app.exec('아티큘레이션', s => C.toggleArticulation(s, noteIds(), args.art), keep); break;
      case 'fermata': if (this.needSelection()) app.exec('늘임표', s => { for (const id of ids()) { const f = findEvent(s, id); C.setEventProp(s, [id], 'fermata', f.ev.fermata ? null : 'above'); } }, keep); break;
      case 'ornament': if (this.needSelection()) app.exec('꾸밈', s => C.toggleOrnament(s, noteIds(), args.orn), keep); break;
      case 'arpeggio': if (this.needSelection()) app.exec('아르페지오', s => { for (const id of noteIds()) { const f = findEvent(s, id); C.setEventProp(s, [id], 'arpeggio', !f.ev.arpeggio); } }, keep); break;
      case 'tremolo': if (this.needSelection()) app.exec('트레몰로', s => { for (const id of noteIds()) { const f = findEvent(s, id); C.setEventProp(s, [id], 'tremolo', f.ev.tremolo ? null : 2); } }, keep); break;
      case 'dynamic': if (this.needSelection('셈여림을 붙일 음표를 선택하세요')) app.exec('셈여림', s => { const first = findEvent(s, ids()[0]); const same = first?.ev.dynamic === args.dyn; C.setEventProp(s, [ids()[0]], 'dynamic', same ? null : args.dyn); }, keep); break;
      case 'spanner': this.addSpanner(args); break;
      case 'slur': this.addSlur(); break;
      case 'lyrics': this.startLyricEntry(); break;
      case 'lyricsLine': this.lyricsLineDialog(); break;
      case 'chord': this.startChordEntry(); break;
      case 'tempo': D.tempoDialog(app, this.measureRange().fromMi); break;
      case 'text': this.addTextDialog(args.style); break;
      case 'rehearsal': this.addRehearsalMark(); break;
      case 'fingering': this.fingeringDialog(); break;
      case 'meta': this.metaDialog(); break;
      case 'barline': { const r = this.measureRange(); if (args.type === 'repeat-start') app.exec('도돌이표', s => C.setMeasureProp(s, r.fromMi, 'barlineLeft', s.measures[r.fromMi].barlineLeft === 'repeat-start' ? null : 'repeat-start')); else app.exec('세로줄', s => C.setMeasureProp(s, r.toMi, 'barlineRight', args.type === 'single' ? null : args.type)); break; }
      case 'volta': { const r = this.measureRange(); app.exec('볼타', s => C.setVolta(s, r.fromMi, r.toMi, args.number)); break; }
      case 'marker': { const r = this.measureRange(); app.exec('반복 기호', s => C.toggleMarker(s, ['dsAlCoda', 'dsAlFine', 'dcAlCoda', 'dcAlFine', 'toCoda', 'fine', 'ds', 'dc'].includes(args.marker) ? r.toMi : r.fromMi, args.marker)); break; }
      case 'addMeasure': app.exec('마디 추가', s => C.appendMeasures(s, 1)); break;
      case 'insertMeasure': { const r = this.measureRange(); app.exec('마디 삽입', s => C.insertMeasures(s, r.fromMi, 1)); break; }
      case 'deleteMeasure': this.deleteMeasures(); break;
      case 'break': { const r = this.measureRange(); app.exec(args.kind === 'page' ? '페이지 나눔' : '줄 바꿈', s => C.toggleBreak(s, r.toMi, args.kind)); break; }
      case 'pickup': { const r = this.measureRange(); app.exec('못갖춘마디', s => C.setMeasureProp(s, r.fromMi, 'pickup', !s.measures[r.fromMi].pickup)); break; }
      case 'keysig': { const r = this.measureRange(); app.exec('조표', s => C.setKeySig(s, r.fromMi, args.fifths)); break; }
      case 'timesig': { const r = this.measureRange(); app.exec('박자표', s => C.setTimeSig(s, r.fromMi, { num: args.num, den: args.den, display: args.display || 'normal' })); break; }
      case 'timesigCustom': D.timeSigDialog(app, this.measureRange().fromMi); break;
      case 'clef': {
        const r = this.measureRange(); const staff = staffList(app.score)[r.s0]?.staff;
        if ((args.clef === 'percussion' || args.clef === 'tab') !== (staff?.type !== 'standard') || (args.clef === 'tab') !== (staff?.type === 'tab')) {
          if (args.clef === 'percussion' || args.clef === 'tab' || staff?.type !== 'standard') { this.toast('드럼·TAB 보표는 [악보 → 악기(파트)]에서 파트를 추가해 만드세요', 'warn', { timeout: 4500 }); return; }
        }
        app.exec('음자리표', s => { for (let si = r.s0; si <= r.s1; si++) C.setClef(s, r.fromMi, si, args.clef); }); break;
      }
      case 'drum': {
        app.setInput({ drum: args.drum });
        if (inputMode) app.inputNote({ drum: args.drum });
        else if (noteIds().length) app.exec('드럼', s => { for (const id of noteIds()) { const f = findEvent(s, id); if (staffList(s)[f.staffIndex].staff.type === 'percussion') f.ev.notes.forEach(n => { n.drum = args.drum; }); } }, keep);
        break;
      }
      case 'notehead': if (this.needSelection()) app.exec('머리 모양', s => C.setNoteProp(s, noteIds(), 'head', args.head), keep); break;
      default: console.warn('palette action', act);
    }
  }
  setFret(fret) {
    const app = this.app; app.setInput({ fret });
    const ids = app.selectedEventIds();
    if (ids.length === 1) app.exec('프렛', s => { const f = findEvent(s, ids[0]); if (f?.ev.kind === 'note' && staffList(s)[f.staffIndex].staff.type === 'tab') f.ev.notes.forEach(n => { n.fret = fret; }); }, { select: app.selection });
  }
  /** Ctrl+number: in input mode create an empty tuplet at the cursor; otherwise convert the selection. */
  tuplet(n) {
    const app = this.app;
    const den = n === 3 ? 2 : n === 2 ? 3 : n === 4 ? 3 : n <= 7 ? 4 : 8;
    if (app.mode === 'input' && app.cursor) {
      const c = app.cursor; const base = app.input.base;
      const id = app.exec('잇단음표', s => { const rid = C.inputEvent(s, { mi: c.mi, si: c.si, vi: app.input.voice, tick: c.tick, dur: { base, dots: 0 }, rest: true, exactTick: true }); if (rid) C.makeTuplet(s, rid, n, den); return rid; }, { silent: true });
      if (id) { app.cursor = { ...c }; this.toast(`${n}잇단음표 — 이어서 음표를 입력하세요`, 'info'); app.emit('selection'); }
      return;
    }
    const ids = app.selectedEventIds(); if (!ids.length) { this.toast('잇단음표로 바꿀 음표를 선택하세요', 'warn'); return; }
    app.exec('잇단음표', s => { for (const id of ids) C.makeTuplet(s, id, n, den); }, { select: app.selection });
  }
  /** first and last note events of the current selection, sorted in time. */
  selectionSpan() {
    const app = this.app;
    const fs = app.selectedEventIds().map(id => findEvent(app.score, id)).filter(f => f && f.ev.kind === 'note').sort((a, b) => a.mi - b.mi || a.tick - b.tick);
    if (!fs.length) return null;
    const first = fs[0]; let last = fs.filter(f => f.staffIndex === first.staffIndex).pop();
    return { first, last, single: fs.length === 1 };
  }
  nextNoteAfter(f) {
    const s = this.app.score;
    for (let mi = f.mi, ei = f.index + 1; mi < s.measures.length; mi++, ei = 0) { const v = s.measures[mi].staves[f.staffIndex].voices[f.voiceIndex] || []; for (; ei < v.length; ei++) if (v[ei].kind === 'note') return findEvent(s, v[ei].id); }
    return null;
  }
  addSlur() {
    const sp = this.selectionSpan(); if (!sp) { this.toast('이음줄을 시작할 음표를 선택하세요 (여러 개 선택하면 처음~끝)', 'warn'); return; }
    let to = sp.last; if (sp.single) to = this.nextNoteAfter(sp.first); if (!to) { this.toast('이음줄을 이을 다음 음표가 없습니다', 'warn'); return; }
    this.app.exec('이음줄', s => C.addSpanner(s, 'slur', sp.first.ev.id, to.ev.id), { select: this.app.selection });
  }
  addSpanner(args) {
    const sp = this.selectionSpan(); if (!sp) { this.toast('먼저 음표를 선택하세요 (여러 개 선택하면 처음~끝)', 'warn'); return; }
    let to = sp.last;
    if (sp.single) { if (args.type === 'glissando') to = this.nextNoteAfter(sp.first); else { const v = sp.first.voice; const last = [...v].reverse().find(e => e.kind === 'note'); to = last ? findEvent(this.app.score, last.id) : sp.first; } }
    if (!to) { this.toast('끝 음표가 없습니다', 'warn'); return; }
    const extra = {}; if (args.octaveShift) extra.octaveShift = args.octaveShift;
    this.app.exec(t(args.type) || '선', s => C.addSpanner(s, args.type, sp.first.ev.id, to.ev.id, extra), { select: this.app.selection });
  }

  // ---------------------------------------------------------------- text entry (lyrics / chords / text)
  firstNoteEvent() {
    const app = this.app; const ids = app.selectedEventIds();
    for (const id of ids) { const f = findEvent(app.score, id); if (f?.ev.kind === 'note') return f; }
    if (ids.length) return findEvent(app.score, ids[0]);
    // cursor / first note in score
    let found = null; forEachEvent(app.score, (ev, c) => { if (!found && ev.kind === 'note' && c.staffIndex === (app.cursor?.si ?? 0)) found = findEvent(app.score, ev.id); });
    return found;
  }
  startLyricEntry(verse = 1, from = null) {
    const f = from || this.firstNoteEvent();
    if (!f) { this.toast('가사를 붙일 음표가 없습니다. 먼저 음표를 입력하세요', 'warn'); return; }
    this.app.setMode('select');
    this.lyricAt(f.ev.id, verse, null);
  }
  lyricAt(eventId, verse, prevHow) {
    const app = this.app; const f = findEvent(app.score, eventId); if (!f) return;
    app.select({ type: 'events', ids: [eventId] }, { silent: false });
    this.view.scrollToMeasure(f.mi);
    const cur = f.ev.lyrics?.find(l => (l.verse || 1) === verse)?.text || '';
    requestAnimationFrame(() => {
      const rect = this.view.eventClientRect(eventId);
      showTextPopover(rect, {
        value: cur, placeholder: `가사 ${verse}절`, hint: isMobileLayout() ? '' : 'Space 다음 · - 음절 잇기 · _ 늘임 · Enter 끝',
        advanceOnSpace: true, advanceOnHyphen: true,
        onCommit: (text, how) => {
          // several Hangul syllables typed in one go → spread one per note
          if (/^[ㄱ-힝]{2,}$/.test(text) && (how === 'next' || how === 'enter' || how === 'tab')) {
            const count = app.exec('가사', s => C.distributeLyrics(s, eventId, text, verse));
            let g = findEvent(app.score, eventId); for (let k = 1; k < count && g; k++) g = this.nextNoteAfter(g);
            const nxt = g && this.nextNoteAfter(g);
            if (how !== 'enter' && nxt) this.lyricAt(nxt.ev.id, verse, how);
            return;
          }
          const wasHyphen = prevHow === 'hyphen';
          const syllabic = how === 'hyphen' ? (wasHyphen ? 'middle' : 'begin') : (wasHyphen ? 'end' : 'single');
          app.exec('가사', s => { C.setLyric(s, eventId, verse, text, syllabic); if (how === 'extend') { const g = findEvent(s, eventId); const l = g?.ev.lyrics?.find(x => (x.verse || 1) === verse); if (l) l.extend = true; } }, { select: app.selection });
          if (how === 'enter') return;
          if (how === 'prev') { const p = this.prevNoteBefore(findEvent(app.score, eventId)); if (p) this.lyricAt(p.ev.id, verse, null); return; }
          const nxt = this.nextNoteAfter(findEvent(app.score, eventId));
          if (nxt) this.lyricAt(nxt.ev.id, verse, how); else this.toast('마지막 음표까지 입력했습니다', 'ok');
        },
      });
    });
  }
  prevNoteBefore(f) {
    if (!f) return null; const s = this.app.score;
    for (let mi = f.mi, ei = f.index - 1; mi >= 0; mi--, ei = Infinity) { const v = s.measures[mi].staves[f.staffIndex].voices[f.voiceIndex] || []; for (ei = Math.min(ei, v.length - 1); ei >= 0; ei--) if (v[ei].kind === 'note') return findEvent(s, v[ei].id); }
    return null;
  }
  startChordEntry(at = null) {
    const app = this.app;
    let mi, tick;
    if (at) ({ mi, tick } = at);
    else { const s = app.selection; if (s.type === 'events' && s.ids.length) { const f = findEvent(app.score, s.ids[0]); mi = f.mi; tick = f.tick; } else { const r = this.measureRange(); mi = r.fromMi; tick = s.type === 'range' ? (s.fromTick || 0) : 0; } }
    app.setMode('select');
    this.chordAt(mi, tick);
  }
  chordAt(mi, tick) {
    const app = this.app; const m = app.score.measures[mi]; if (!m) return;
    this.view.scrollToMeasure(mi);
    const cur = (m.chords || []).find(c => Math.abs(c.tick - tick) < 1)?.text || '';
    app.select({ type: 'measure', mi, si: 0 }, { silent: false });
    requestAnimationFrame(() => {
      const r = this.view.measureRect(mi); let rect = null;
      if (r) { const x = this.view.xAtTick(r.measure, tick); const a = this.view.pageToClient(r.page, x, r.y); if (a) rect = { left: a.x - 10, top: a.y - 30, bottom: a.y, right: a.x + 10, width: 20, height: 30 }; }
      showTextPopover(rect, {
        value: cur, placeholder: '코드 (예: C, Am7, G/B)', hint: isMobileLayout() ? '' : 'Space 다음 박 · Tab 다음 마디 · Enter 끝',
        advanceOnSpace: true,
        onCommit: (text, how) => {
          const norm = text.replace(/♯/g, '#').replace(/♭/g, 'b');
          if (norm || cur) app.exec('코드', s => C.setChordSymbol(s, mi, tick, norm));
          if (how === 'enter') return;
          const ts = effectiveTimeSig(app.score, mi); const cap = measureCapacity(ts); const bt = beatTicks(ts);
          let nmi = mi, nt = tick;
          if (how === 'tab') { nmi = mi + 1; nt = 0; }
          else if (how === 'prev') { if (tick > 0) nt = Math.max(0, tick - bt); else { nmi = mi - 1; nt = 0; } }
          else { nt = tick + bt; if (nt >= cap - 1) { nmi = mi + 1; nt = 0; } }
          if (nmi < 0) return;
          if (nmi >= app.score.measures.length) { app.exec('마디 추가', s => C.appendMeasures(s, 1)); }
          this.chordAt(nmi, nt);
        },
      });
    });
  }
  async addTextDialog(style = 'plain') {
    const app = this.app;
    const v = await D.promptDialog(style === 'expression' ? '나타냄말 / 텍스트' : '스태프 텍스트', '내용', '', { placeholder: style === 'expression' ? 'dolce, 부드럽게…' : 'Verse 1, 간주…' });
    if (!v) return;
    const ids = app.selectedEventIds();
    if (app.selection.type === 'events' && ids.length) app.exec('텍스트', s => { const f = findEvent(s, ids[0]); f.ev.texts = [...(f.ev.texts || []), { text: v, placement: 'above', style }]; }, { select: app.selection });
    else { const r = this.measureRange(); app.exec('텍스트', s => C.addMeasureText(s, r.fromMi, v, 'above', style, r.s0)); }
  }
  async addRehearsalMark() {
    const app = this.app; const r = this.measureRange();
    const used = app.score.measures.slice(0, r.fromMi).map(m => m.rehearsalMark).filter(Boolean);
    const next = used.length ? String.fromCharCode(Math.min(90, used[used.length - 1].charCodeAt(0) + 1)) : 'A';
    const v = await D.promptDialog('리허설 마크', '표시', app.score.measures[r.fromMi].rehearsalMark || next);
    if (v !== null) app.exec('리허설 마크', s => C.setMeasureProp(s, r.fromMi, 'rehearsalMark', v || null));
  }
  async fingeringDialog() {
    const app = this.app; if (!this.needSelection('운지 번호를 붙일 음표를 선택하세요')) return;
    const v = await D.promptDialog('운지 번호', '번호', '', { placeholder: '1~5 (화음은 1 3 5)' }); if (!v) return;
    app.exec('운지', s => { for (const id of app.selectedEventIds()) { const f = findEvent(s, id); if (f) f.ev.texts = [...(f.ev.texts || []).filter(x => x.style !== 'fingering'), { text: v, placement: 'above', style: 'technique' }]; } }, { select: app.selection });
  }
  async editText(ref) {
    const app = this.app;
    if (ref.field) { this.metaDialog(); return; }
    switch (ref.kind) {
      case 'lyric': this.lyricAt(ref.eventId, ref.verse || 1, null); break;
      case 'chord': { const mi = app.score.measures.findIndex(m => m.id === ref.measureId); const ch = app.score.measures[mi]?.chords?.find(c => c.id === ref.chordId); this.chordAt(mi, ch?.tick || 0); break; }
      case 'tempo': D.tempoDialog(app, app.score.measures.findIndex(m => m.id === ref.measureId)); break;
      case 'rehearsal': { const mi = app.score.measures.findIndex(m => m.id === ref.measureId); app.select({ type: 'measure', mi, si: 0 }); this.addRehearsalMark(); break; }
      case 'mtext': { const mi = app.score.measures.findIndex(m => m.id === ref.measureId); const m = app.score.measures[mi]; const idx = 0; const v = await D.promptDialog('텍스트 편집', '내용', m.texts?.[idx]?.text || ''); if (v !== null) app.exec('텍스트', s => C.setMeasureText(s, mi, idx, v)); break; }
      case 'text': { const f = findEvent(app.score, ref.eventId); const v = await D.promptDialog('텍스트 편집', '내용', f?.ev.texts?.[0]?.text || ''); if (v !== null) app.exec('텍스트', s => { const g = findEvent(s, ref.eventId); if (!v) delete g.ev.texts; else g.ev.texts = [{ ...(g.ev.texts?.[0] || { placement: 'above', style: 'expression' }), text: v }]; }); break; }
    }
  }
  onDoubleTapEvent(hit) {
    const app = this.app; const f = findEvent(app.score, hit.eventId); if (!f) return;
    app.setMode('input');
    app.cursor = { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: f.tick + durTicks(f.ev) };
    app.input.voice = f.voiceIndex;
    app.select({ type: 'events', ids: [f.ev.id], last: true, noteIndex: hit.noteIndex });
    if (f.ev.kind === 'note') app.lastPitch = f.ev.notes[f.ev.notes.length - 1];
    this.toast('심플 입력 — 선택한 음표: ↑↓ 음높이 · Alt+숫자 음길이 · = ♯ · - ♭ · Delete 지우기', 'info', { timeout: 3500 });
  }
  /** Finale's Measure/Key/Time/Clef tools in one menu. */
  measureMenu(x, y, mi, si) {
    const app = this.app;
    const items = [
      { header: `마디 ${mi + 1}` },
      { label: '조표…', onClick: () => this.keyMenu({ getBoundingClientRect: () => ({ left: x, bottom: y, top: y, right: x }) }, mi) },
      { label: '박자표…', onClick: () => D.timeSigDialog(app, mi) },
      { label: '음자리표…', onClick: () => this.clefMenu({ getBoundingClientRect: () => ({ left: x, bottom: y, top: y, right: x }) }, mi, si) },
      { label: '템포…', icon: 'metronome', onClick: () => D.tempoDialog(app, mi) },
      { sep: true },
      { label: '도돌이표 시작', onClick: () => app.exec('도돌이표', s => C.setMeasureProp(s, mi, 'barlineLeft', s.measures[mi].barlineLeft === 'repeat-start' ? null : 'repeat-start')) },
      { label: '도돌이표 끝', onClick: () => app.exec('도돌이표', s => C.setMeasureProp(s, mi, 'barlineRight', s.measures[mi].barlineRight === 'repeat-end' ? null : 'repeat-end')) },
      { label: '1번 괄호', onClick: () => app.exec('볼타', s => C.setVolta(s, mi, mi, '1.')) },
      { label: '2번 괄호', onClick: () => app.exec('볼타', s => C.setVolta(s, mi, mi, '2.')) },
      { label: '겹세로줄', onClick: () => app.exec('세로줄', s => C.setMeasureProp(s, mi, 'barlineRight', s.measures[mi].barlineRight === 'double' ? null : 'double')) },
      { label: '끝세로줄', onClick: () => app.exec('세로줄', s => C.setMeasureProp(s, mi, 'barlineRight', s.measures[mi].barlineRight === 'final' ? null : 'final')) },
      { sep: true },
      { label: '앞에 마디 삽입', icon: 'plus', onClick: () => app.exec('마디 삽입', s => C.insertMeasures(s, mi, 1)) },
      { label: '뒤에 마디 추가', icon: 'plus', onClick: () => app.exec('마디 추가', s => C.insertMeasures(s, mi + 1, 1)) },
      { label: '여기서 줄 바꿈', onClick: () => app.exec('줄 바꿈', s => C.toggleBreak(s, mi, 'system')) },
      { label: '마디 삭제', icon: 'trash', onClick: () => { app.select({ type: 'measure', mi, si }); this.deleteMeasures(); } },
    ];
    showMenu(x, y, items);
  }
  keyMenu(anchor, mi) {
    const app = this.app; const r = anchor.getBoundingClientRect();
    const NAMES = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
    const items = [{ header: '조표 (장조 / 단조)' }];
    for (let f = -7; f <= 7; f++) items.push({ label: `${NAMES[f + 7]} 장조 · ${['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'][f + 7]} 단조 (${f > 0 ? '♯' + f : f < 0 ? '♭' + -f : '없음'})`, onClick: () => app.exec('조표', s => C.setKeySig(s, mi, f)) });
    showMenu(r.left, r.bottom + 6, items);
  }
  clefMenu(anchor, mi, si) {
    const app = this.app; const r = anchor.getBoundingClientRect();
    const items = [{ header: '음자리표' }, ...[['treble', '높은음자리표'], ['bass', '낮은음자리표'], ['alto', '알토'], ['tenor', '테너'], ['treble8vb', '높은음자리표 8vb (기타)'], ['bass8vb', '낮은음자리표 8vb']].map(([c, n]) => ({ label: n, onClick: () => { app.select({ type: 'measure', mi, si }); this.paletteAction('clef', { clef: c }); } }))];
    showMenu(r.left, r.bottom + 6, items);
  }
  /** Finale drag-copy: copy the selected region onto the target measure (Alt = insert before it). */
  dragCopy(range, target) {
    const app = this.app;
    const clip = C.copyRange(app.score, range); if (!clip) return;
    const count = range.toMi - range.fromMi + 1;
    const si = Math.max(0, Math.min(target.si ?? range.s0, totalStaffCount(app.score) - 1));
    app.exec(target.insert ? '끌어서 삽입' : '끌어서 복사', s => {
      if (target.insert) C.insertMeasures(s, target.mi, count);
      return C.paste(s, clip, { mi: target.mi, si, vi: 0, tick: 0 });
    });
    app.select({ type: 'range', fromMi: target.mi, toMi: Math.min(app.score.measures.length - 1, target.mi + count - 1), s0: si, s1: Math.min(totalStaffCount(app.score) - 1, si + (range.s1 - range.s0)) });
    this.toast(target.insert ? `마디 ${count}개를 끼워 넣었습니다` : `마디 ${target.mi + 1}에 복사했습니다`, 'ok', { action: { label: '되돌리기', onClick: () => app.undo() } });
  }
  tempoDialogAt(mi) { return D.tempoDialog(this.app, mi); }
  togglePageScroll() { const next = this.app.viewMode === 'horizontal' ? (this.app.settings.lastPageView || 'vertical') : 'horizontal'; if (this.app.viewMode !== 'horizontal') this.app.settings.lastPageView = this.app.viewMode; this.setView(next); this.toast(next === 'horizontal' ? '스크롤 보기 (Ctrl+E로 페이지 보기)' : '페이지 보기', 'info'); }
  async goToMeasureDialog() {
    const v = await D.promptDialog('마디로 이동', '마디 번호', '', { placeholder: `1 – ${this.app.score.measures.length}` });
    const n = parseInt(v, 10); if (!n) return;
    const mi = Math.max(0, Math.min(this.app.score.measures.length - 1, n - 1));
    this.app.select({ type: 'measure', mi, si: 0 }); this.view.scrollToMeasure(mi, { center: true });
  }
  playFrom(mi) { this.player.stop?.(); this.player.play(mi); }
  showCaret(pitch) { this.showPitchHint(null, 0, `캐럿: ${pitchName(pitch)} (Enter로 입력)`); }
  showMiniToolbar(hit) {
    const app = this.app; const rect = this.view.eventClientRect(hit.eventId); if (!rect) return;
    const isNote = findEvent(app.score, hit.eventId)?.ev.kind === 'note';
    const acts = isNote ? [
      { icon: 'up', label: '반음↑', onClick: () => app.transposeSelection({ semitones: 1 }) },
      { icon: 'down', label: '반음↓', onClick: () => app.transposeSelection({ semitones: -1 }) },
      { icon: 'lyrics', label: '가사', onClick: () => { this.hideMini(); this.startLyricEntry(); } },
      { icon: 'chord', label: '코드', onClick: () => { this.hideMini(); this.startChordEntry(); } },
      { icon: 'trash', label: '삭제', onClick: () => { this.hideMini(); app.deleteSelection(); } },
      { icon: 'more', label: '더보기', onClick: () => { this.hideMini(); this.showContextMenu(rect.left, rect.bottom + 8, hit); } },
    ] : [
      { icon: 'noteInput', label: '입력', onClick: () => { this.hideMini(); this.onDoubleTapEvent(hit); } },
      { icon: 'paste', label: '붙여넣기', onClick: () => { this.hideMini(); this.pasteSmart(); } },
      { icon: 'more', label: '더보기', onClick: () => { this.hideMini(); this.showContextMenu(rect.left, rect.bottom + 8, hit); } },
    ];
    showMiniToolbar(this.el.mini, rect, acts);
  }
  async pasteSmart() {
    const app = this.app;
    if (app.clipboard) { app.pasteClipboard(); return; }
    try { const txt = await navigator.clipboard?.readText?.(); if (txt?.startsWith('scoresnap-clip:')) { app.pasteClipboard(JSON.parse(txt.slice(15))); return; } } catch { /* permission */ }
    this.toast('붙여넣을 내용이 없습니다. 먼저 복사(Ctrl+C)하세요', 'warn');
  }
  deleteMeasures() {
    const app = this.app; const r = this.measureRange();
    const n = r.toMi - r.fromMi + 1;
    app.exec('마디 삭제', s => C.deleteMeasures(s, r.fromMi, r.toMi), { select: { type: 'none' } });
    this.toast(`마디 ${n}개를 삭제했습니다`, 'ok', { action: { label: '되돌리기', onClick: () => app.undo() } });
  }
  async lyricsLineDialog() {
    const app = this.app; const f = this.firstNoteEvent(); if (!f) { this.toast('먼저 음표를 입력하거나 선택하세요', 'warn'); return; }
    const res = await D.showDialog({ title: '가사 한 줄 붙이기', body: `<p>선택한 음표(${f.mi + 1}마디)부터 순서대로 한 음표에 한 음절씩 들어갑니다. 한글은 글자마다, 영어는 띄어쓰기와 하이픈(-)으로 나눕니다. 붙임줄로 이어진 음은 건너뜁니다.</p>
      <div class="row"><label>절</label><div class="ctl"><select id="ll-v">${[1, 2, 3, 4].map(v => `<option>${v}</option>`).join('')}</select></div></div>
      <div class="row"><label>가사</label><div class="ctl"><textarea id="ll-t" rows="4" placeholder="예: 봄바람 불어오면 꽃잎이 춤을 춰요&#10;Hap-py birth-day to you"></textarea></div></div>`,
      buttons: [{ label: t('cancel'), value: null }, { label: '붙이기', primary: true, value: r => ({ v: +r.querySelector('#ll-v').value, text: r.querySelector('#ll-t').value }) }] });
    if (!res?.text?.trim()) return;
    const n = app.exec('가사 붙이기', s => C.distributeLyrics(s, f.ev.id, res.text.replace(/\n/g, ' '), res.v));
    this.toast(`${n}개 음표에 가사를 붙였습니다`, 'ok');
  }
  metaDialog() { return D.metaDialog(this.app); }
  pageSetupDialog() { return D.pageSetupDialog(this.app); }
  instrumentsDialog() { return D.instrumentsDialog(this.app, this); }
  transposeDialog() { return D.transposeDialog(this.app); }
  showShortcuts() { return D.shortcutsDialog(); }
  newScoreDialog() { return this.action('new'); }
  exportDialog(fmt) { return exportDialog(this.app, this, fmt); }
  scan(opts = {}) { return scanDialog(this.app, this, opts); }
  audio(opts = {}) {
    // the claude.ai preview page does not carry the Basic Pitch model (third-party weights)
    if (window.JSE_PREVIEW) { this.toast('음원으로 악보 만들기는 설치한 앱(Windows·Android)이나 웹앱 https://omokdie.github.io/jse/ 에서 쓸 수 있어요', '', { timeout: 6000 }); return Promise.resolve(); }
    return import('./audioflow.js').then(m => m.audioDialog(this.app, this, opts));
  }

  // ---------------------------------------------------------------- files
  async confirmDiscard() {
    if (!this.app.dirty || this.app.score?.measures.every(m => m.staves.every(sm => sm.voices.every(v => v.every(e => e.kind === 'rest'))))) return true;
    return D.confirmDialog('저장하지 않은 변경', '현재 악보에 저장하지 않은 변경사항이 있습니다. 계속하면 현재 악보는 닫힙니다(자동 저장본은 덮어씁니다). 계속할까요?', '계속');
  }
  async openFile() {
    const files = await pickFiles({ accept: '.ssnap,.musx,.ftmx,.musicxml,.xml,.mxl,.json,image/*,.pdf,application/pdf,audio/*,.mp3,.m4a,.wav,.ogg,.flac', multiple: true });
    if (files.length) this.openFiles(files);
  }
  async openFiles(files) {
    // images & PDFs go to the scanner together; the first score file opens
    const kinds = await Promise.all(files.map(async f => ({ ...f, kind: sniffFile(f.name, await f.blob.slice(0, 4096).arrayBuffer()) })));
    const audios = files.filter(f => /\.(mp3|m4a|mp4|aac|wav|wave|ogg|oga|opus|flac|webm|weba|aif|aiff|caf|amr|3gp)$/i.test(f.name || '') || /^audio\//.test(f.blob?.type || ''));
    if (audios.length && !kinds.some(f => f.kind === 'image' || f.kind === 'pdf')) { this.audio({ files: audios }); return; }
    const scans = kinds.filter(f => f.kind === 'image' || f.kind === 'pdf');
    if (scans.length) { this.scan({ files: scans }); return; }
    const f = kinds[0]; if (!f) return;
    if (!(await this.confirmDiscard())) return;
    try {
      if (f.kind === 'ssnap') { const { score } = await readSsnap(await f.blob.arrayBuffer()); this.app.setScore(score, { fileName: f.name, fileHandle: f.handle || null }); }
      else if (f.kind === 'musicxml') { await this.openText(f.name, await f.blob.text(), true); return; }
      else if (f.kind === 'mxl') { const mx = await import('../io/musicxml.js'); const score = await mx.importMXL(await f.blob.arrayBuffer()); this.app.setScore(score, { fileName: f.name.replace(/\.mxl$/i, '.ssnap') }); this.app.dirty = true; }
      else if (f.kind === 'musx') {
        const busy = this.toast('Finale 파일을 변환하는 중…', 'info', { timeout: 0 });
        try {
          const mod = await import('../io/musx.js');
          const score = await mod.importMusx(await f.blob.arrayBuffer());
          this.app.setScore(score, { fileName: f.name.replace(/\.(musx|ftmx)$/i, '.ssnap') }); this.app.dirty = true;
          const w = score.importInfo?.warnings || [];
          if (w.length) setTimeout(() => this.toast(`Finale 파일을 가져왔습니다. 참고: ${w.slice(0, 2).join(' · ')}`, 'info', { timeout: 7000 }), 600);
        } finally { busy?.remove(); }
      }
      else if (f.kind === 'finale-old') { this.toast('Finale 2012 이전 형식(.mus)은 열 수 없습니다. Finale에서 MusicXML로 내보낸 뒤 열어 주세요.', 'warn', { timeout: 7000 }); return; }
      else if (f.kind === 'json') { const score = JSON.parse(await f.blob.text()); this.app.setScore(score, { fileName: f.name.replace(/\.json$/i, '.ssnap') }); }
      else if (f.kind === 'midi') { this.toast('MIDI 가져오기는 아직 지원하지 않습니다. MusicXML이나 사진을 사용하세요.', 'warn'); return; }
      else { this.toast(`열 수 없는 파일 형식입니다: ${f.name}`, 'error'); return; }
      this.afterOpen(f.name);
    } catch (e) { console.error(e); this.toast(`파일을 열지 못했습니다: ${e.message}`, 'error', { timeout: 6000 }); }
  }
  async openText(name, text, skipConfirm = false) {
    if (!skipConfirm && !(await this.confirmDiscard())) return;
    try { const mx = await import('../io/musicxml.js'); const score = mx.importMusicXML(text); this.app.setScore(score, { fileName: name.replace(/\.(musicxml|xml)$/i, '.ssnap') }); this.app.dirty = true; this.afterOpen(name); }
    catch (e) { console.error(e); this.toast('MusicXML을 읽지 못했습니다: ' + e.message, 'error'); }
  }
  afterOpen(name) {
    if (this.app.viewMode !== 'reflow') this.view.fit('width');
    this.view.container.scrollTo({ top: 0 });
    storage.addRecent({ id: name, name, title: this.app.score.meta.title });
    this.toast(`${name} — ${t('opened')}`, 'ok');
    this.updateTitle();
  }
  async thumbnail() { try { const c = await rasterizePage(this.app.layout.pages[0], { dpi: 40, spMm: this.app.layout.spMm }); return await canvasToBlob(c, 'image/png'); } catch { return null; } }
  async save() { return this.saveInternal(false); }
  async saveAs() { return this.saveInternal(true); }
  async saveInternal(asNew) {
    const app = this.app;
    const name = safeFileName(app.fileName?.replace(/\.[^.]+$/, '') || app.score.meta.title || 'score', '.ssnap');
    try {
      const blob = await writeSsnap(app.score, { thumbnailBlob: await this.thumbnail(), appVersion: this.version });
      const res = await saveBlob(blob, name, { mime: 'application/x-scoresnap', suggestDialog: asNew || (!app.fileHandle && !app.savedOnce), handle: asNew ? null : app.fileHandle, types: [{ description: 'JSE 악보', accept: { 'application/x-scoresnap': ['.ssnap'] } }] });
      if (!res) return false;
      app.savedOnce = true;
      if (res.handle) { app.fileHandle = res.handle; app.fileName = res.name; } else if (res.path) app.fileName = res.path.split(/[\\/]/).pop(); else app.fileName = name;
      app.dirty = false; app.emit('dirty');
      storage.addRecent({ id: app.fileName, name: app.fileName, title: app.score.meta.title });
      this.toast(res.download ? `${app.fileName} 파일을 다운로드했습니다` : `${t('saved')} — ${app.fileName}`, 'ok');
      return true;
    } catch (e) { console.error(e); this.toast('저장 실패: ' + e.message, 'error'); return false; }
  }
  async share() {
    const app = this.app; const blob = await writeSsnap(app.score, { appVersion: this.version });
    const ok = await shareBlob(blob, safeFileName(app.score.meta.title || 'score', '.ssnap'), app.score.meta.title).catch(() => false);
    if (!ok) { this.toast('이 기기에서는 공유를 지원하지 않아 파일로 저장합니다', 'info'); this.saveAs(); }
  }
  async recentDialog() {
    const list = await storage.recent();
    await D.showDialog({ title: '최근 파일', body: list.length ? `<p>브라우저 보안상 최근 파일은 이름만 기억합니다. 파일을 다시 선택해 여세요.</p><div class="cards">${list.map(r => `<div class="card"><b>${escapeXml(r.title || r.name)}</b><span>${escapeXml(r.name)} · ${new Date(r.openedAt).toLocaleString('ko-KR')}</span></div>`).join('')}</div>` : '<p>최근 파일이 없습니다.</p>', buttons: [{ label: t('open') + '…', primary: true, value: 'open' }] }).then(v => { if (v === 'open') this.openFile(); });
  }
  scheduleAutosave() {
    if (!this.app.settings.autosave) return;
    clearTimeout(this._asT);
    this._asT = setTimeout(async () => { const ok = await storage.saveDraft(this.app.score, { fileName: this.app.fileName }); this._saveText = ok ? `자동 저장 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''; this.updateStatus(); this.updateTitle(); }, 1200);
  }

  // ---------------------------------------------------------------- OMR review support (after recognition)
  setReview(state) { this.reviewState = state ? { ...state, scoreRef: this.app.score } : null; this.updateReviewBar(); this.drawReviewMarks(); this.updateSourcePeek(); }
  /** Uncertain OMR lyrics that still read what was recognised (an edited syllable counts as checked). */
  pendingLowLyrics() {
    const st = this.reviewState; if (!st?.lowLyrics?.length || !this.app.score) return [];
    return st.lowLyrics.filter(l => { const f = findEvent(this.app.score, l.eventId); return f && (f.ev.lyrics || []).some(x => (x.verse || 1) === l.verse && x.text === l.text); });
  }
  /** Measures to visit with "다음": uncertain measures + measures holding unchecked lyrics, in score order. */
  reviewTargets() {
    const st = this.reviewState; if (!st || !this.app.score) return [];
    const ids = new Set([...(st.low || []), ...this.pendingLowLyrics().map(l => l.measureId).filter(Boolean)]);
    return this.app.score.measures.filter(m => ids.has(m.id)).map(m => m.id);
  }
  updateReviewBar() {
    const bar = this.reviewBar; const st = this.reviewState;
    const lowLy = this.pendingLowLyrics();
    if (!st || (!st.low?.length && !lowLy.length)) { bar.hidden = true; return; }
    bar.hidden = false;
    const what = [st.low?.length ? `마디 <b>${st.low.length}</b>개` : '', lowLy.length ? `가사 <b>${lowLy.length}</b>글자` : ''].filter(Boolean).join(' · ');
    bar.innerHTML = `${icon('warning')}<span>검토가 필요한 ${what}</span><button class="btn sm" data-r="next">다음 ${icon('next')}</button><button class="btn sm" data-r="peek">${icon('photo')} 원본</button><button class="btn sm" data-r="done">${icon('check')} 검토 끝</button>`;
    bar.querySelector('[data-r=next]').addEventListener('click', () => this.nextReview());
    bar.querySelector('[data-r=peek]').addEventListener('click', () => this.toggleSourcePeek(true));
    bar.querySelector('[data-r=done]').addEventListener('click', () => this.setReview(null));
  }
  nextReview() {
    const st = this.reviewState; const targets = this.reviewTargets(); if (!st || !targets.length) return;
    st.idx = ((st.idx ?? -1) + 1) % targets.length;
    const mi = this.app.score.measures.findIndex(m => m.id === targets[st.idx]);
    if (mi >= 0) { this.app.select({ type: 'measure', mi, si: 0 }); this.view.scrollToMeasure(mi, { center: true }); this.toggleSourcePeek(true); }
  }
  drawReviewMarks() {
    const st = this.reviewState;
    if (!st || !this.app.layout) { this.view.pageEls.forEach(el => { const svg = el.querySelector('svg.review-marks'); if (svg) svg.innerHTML = ''; }); return; }
    const low = new Set(st.low || []);
    const lowLy = new Set(this.pendingLowLyrics().map(l => `${l.eventId}:${l.verse}`));
    this.view.pageEls.forEach((el, pi) => {
      const p = this.app.layout.pages[pi]; let svg = el.querySelector('svg.review-marks');
      if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'overlay review-marks'); el.appendChild(svg); }
      svg.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
      svg.innerHTML = p.geometry.measures.filter(m => low.has(m.measureId)).map(m => { const y0 = Math.min(...m.staves.map(s => s.y)) - 1.5, y1 = Math.max(...m.staves.map(s => s.y + s.h)) + 1.5; return `<rect class="omr-low" x="${m.x}" y="${y0}" width="${m.width}" height="${y1 - y0}" rx="0.6"/>`; }).join('')
        + (lowLy.size ? (p.geometry.texts || []).filter(t => t.kind === 'lyric' && lowLy.has(`${t.eventId}:${t.verse}`)).map(t => `<rect class="omr-low-ly" x="${t.x - 0.25}" y="${t.y - 0.1}" width="${t.w + 0.5}" height="${t.h + 0.2}" rx="0.35"><title>인식이 불확실한 가사 — 더블클릭해 고치기</title></rect>`).join('') : '');
    });
  }
  toggleSourcePeek(force = null) { this.peekOn = force ?? !this.peekOn; this.updateSourcePeek(); }
  updateSourcePeek() {
    const peek = this.peek; const app = this.app;
    if (!this.peekOn || !app.score?.sources?.length) { peek.hidden = true; return; }
    const r = this.measureRange(); const m = app.score.measures[r.fromMi];
    const src = app.score.sources.find(s => s.id === (m?.source?.sourceId || app.score.sources[0].id));
    if (!src?.blob) { peek.hidden = true; return; }
    if (!src._url) src._url = URL.createObjectURL(src.blob);
    const W = 340;
    let html;
    if (m?.source?.bbox) {
      const [x, y, w, h] = m.source.bbox; const pad = 0.08; const bx = Math.max(0, x - w * pad), by = Math.max(0, y - h * 0.5), bw = Math.min(src.width - bx, w * (1 + 2 * pad)), bh = Math.min(src.height - by, h * 2);
      const scale = W / bw; const H = Math.min(260, bh * scale);
      html = `<div class="peek-img" style="width:${W}px;height:${H}px;background-image:url(${src._url});background-size:${src.width * scale}px ${src.height * scale}px;background-position:${-bx * scale}px ${-by * scale}px"></div>`;
    } else html = `<img src="${src._url}" style="width:${W}px;display:block;border-radius:10px">`;
    peek.innerHTML = `<div class="peek-head"><span>원본 · ${r.fromMi + 1}마디</span><button class="btn sm" data-x>${icon('close')}</button></div>${html}`;
    peek.querySelector('[data-x]').addEventListener('click', () => this.toggleSourcePeek(false));
    peek.hidden = false;
  }

  // ---------------------------------------------------------------- first run
  async welcome(force = false) {
    if (!force && localStorage.getItem('ssnap.welcomed')) return;
    localStorage.setItem('ssnap.welcomed', '1');
    const v = await D.showDialog({ title: 'JSE에 오신 것을 환영합니다', wide: false, body: `<p>악보 사진을 찍으면 편집할 수 있는 악보로 바꿔 드립니다. 무엇부터 해볼까요?</p>
      <div class="cards welcome-cards">
        <button class="card" data-v="scan">${icon('scan')}<b>사진으로 악보 만들기</b><span>카메라·이미지·PDF 인식</span></button>
        <button class="card" data-v="audio">${icon('audio')}<b>음원으로 악보 만들기</b><span>MP3·WAV를 듣고 받아 적기</span></button>
        <button class="card" data-v="new">${icon('new')}<b>새 악보 쓰기</b><span>멜로디·피아노·기타·드럼</span></button>
        <button class="card" data-v="open">${icon('open')}<b>파일 열기</b><span>.ssnap · Finale(.musx) · MusicXML</span></button>
        <button class="card" data-v="example">${icon('score')}<b>예제 둘러보기</b><span>가사·코드가 있는 악보</span></button>
      </div>`, buttons: [], onOpen: (root, close) => root.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => close(b.dataset.v))) });
    if (v) this.action(v);
  }
}
