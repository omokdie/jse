// Mouse / touch / pen interaction on the score canvas — Finale-style tools (see editor/tools.js).
import { findEvent, staffList, noteAtStaffPosition, effectiveClef, effectiveKeySig, keyAlter, durTicks, effectiveTimeSig, measureCapacity, totalStaffCount } from '../model/score.js';
import { f3 } from '../engrave/notes.js';
import { staffPosOf } from '../engrave/layout.js';
import { GLYPHS } from '../engrave/glyphs.js';
import * as C from '../model/commands.js';
import { entryTarget, applyArticulation, applyExpression, createShape, SHAPE_KEYS, ARTIC_KEYS, EXPR_KEYS } from './tools.js';

const HEAD_W = 1.257;

export class PointerController {
  constructor(app, view, ui) {
    this.app = app; this.view = view; this.ui = ui;
    this.container = view.container;
    this.pointers = new Map();
    this.drag = null;
    this.lastTap = 0;
    const c = this.container;
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    c.addEventListener('pointerup', e => this.onUp(e));
    c.addEventListener('pointercancel', e => this.onUp(e, true));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.view.setGhost(null); this.view.setHover(null); } });
    c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (this.suppressMenu) { this.suppressMenu = false; return; }
      const hit = this.hitAt(e);
      // macOS/Linux fire this on press: wait for the release so a right-button drag can pan instead
      if (this.drag?.right) { this.drag.menuPending = { x: e.clientX, y: e.clientY, hit }; return; }
      this.ui.showContextMenu(e.clientX, e.clientY, hit);
    });
    c.addEventListener('dblclick', e => this.onDouble(e));
  }
  get tool() { return this.app.tool || (this.app.mode === 'input' ? 'entry' : 'select'); }
  hitAt(e, opts = {}) {
    const pt = this.view.pointToPage(e.clientX, e.clientY); if (!pt) return null;
    const hit = this.view.hitTest(pt.page, pt.x, pt.y, opts); if (hit) { hit.page = pt.page; hit.px = pt.x; hit.py = pt.y; }
    return hit;
  }
  onWheel(e) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const f = e.deltaY < 0 ? 1.1 : 1 / 1.1; this.view.zoomBy(f, { x: e.clientX, y: e.clientY }); }
    else if (this.app.viewMode === 'horizontal' && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); this.container.scrollLeft += e.deltaY; }
  }
  /** Which palette item applies: a held metatool key wins over the palette selection (Finale). */
  metatool(tool) {
    const k = this.ui.keyboard?.heldKey;
    if (k) {
      if (tool === 'shape' && SHAPE_KEYS[k]) return SHAPE_KEYS[k];
      if (tool === 'artic' && ARTIC_KEYS[k]) return ARTIC_KEYS[k];
      if (tool === 'expr' && EXPR_KEYS[k]) return EXPR_KEYS[k];
    }
    return this.app.toolItem[tool];
  }

  // ------------------------------------------------------------------ down
  onDown(e) {
    // right button (any tool): drag = hand grabber, click = context menu (Finale)
    if (e.button === 2) { this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.container.scrollLeft, st: this.container.scrollTop, right: true }; this.container.setPointerCapture?.(e.pointerId); return; }
    if (e.button === 1) { e.preventDefault(); this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.container.scrollLeft, st: this.container.scrollTop }; return; }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pointers.size === 2) { // pinch start
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.app.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.drag = null; this.view.setGhost(null);
      return;
    }
    const tool = this.tool;
    // Finale: hold Space and click a measure = play from there
    if (this.ui.keyboard?.spaceHeld) { const h = this.hitAt(e); const mi = h?.mi ?? h?.event?.mi; this.ui.keyboard.spaceUsed = true; if (mi != null) this.ui.playFrom?.(mi); return; }
    const hit = this.hitAt(e, { preferSpanners: tool === 'shape' || tool === 'select' });
    this.container.setPointerCapture?.(e.pointerId);
    const isTouch = e.pointerType === 'touch';
    const now = Date.now();
    const dbl = now - this.lastTap < 320 && this.lastHit && hit && this.lastHit.eventId === hit.eventId && hit.eventId;
    this.lastTap = now; this.lastHit = hit;
    this.ui.hideContextMenu?.();
    const pan = (extra = {}) => { this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.container.scrollLeft, st: this.container.scrollTop, touch: isTouch, ...extra }; };

    switch (tool) {
      case 'entry': return this.downEntry(e, hit, isTouch, pan);
      case 'shape': return this.downShape(e, hit, isTouch, pan, dbl);
      case 'artic': case 'expr': return this.downMark(e, hit, isTouch, pan, tool);
      case 'lyrics': case 'chord': case 'text': case 'measure': return this.downTextTool(e, hit, isTouch, pan, tool);
      default: return this.downSelect(e, hit, isTouch, pan, dbl);
    }
  }
  downSelect(e, hit, isTouch, pan, dbl) {
    const app = this.app;
    if (hit && hit.kind === 'spanner') { app.select({ type: 'spanner', id: hit.id }); if (hit.handle) this.drag = { kind: 'shapeHandle', id: hit.id, handle: hit.handle, x: e.clientX, y: e.clientY }; return; }
    if (hit && (hit.kind === 'note' || hit.kind === 'rest' || hit.kind === 'event')) {
      if (hit.implicit) { this.selectMeasureAt(hit.event.mi, hit.event.si, e); return; }
      const sel = app.selection;
      let ids;
      if (e.shiftKey && sel.type === 'events') ids = sel.ids.includes(hit.eventId) ? sel.ids : [...sel.ids, hit.eventId];
      else if ((e.ctrlKey || e.metaKey) && sel.type === 'events') ids = sel.ids.includes(hit.eventId) ? sel.ids.filter(i => i !== hit.eventId) : [...sel.ids, hit.eventId];
      else if (sel.type === 'events' && sel.ids.includes(hit.eventId) && sel.ids.length > 1 && !isTouch) { ids = sel.ids; this._keptMulti = hit; }   // keep a multi-selection for dragging
      else ids = [hit.eventId];
      const single = ids.length === 1 && hit.kind === 'note';
      app.select({ type: 'events', ids, noteIndex: single ? hit.noteIndex : undefined });
      if (dbl) { this.ui.onDoubleTapEvent?.(hit); return; }
      // potential pitch drag (vertical) — commit on release
      this.drag = { kind: 'pitch', hit, x: e.clientX, y: e.clientY, steps: 0, touch: isTouch, started: false, longPress: isTouch ? setTimeout(() => this.longPress(e, hit), 550) : null };
      return;
    }
    if (hit && hit.kind === 'text') { app.select({ type: 'text', ref: hit.ref }); if (dbl || (!isTouch && e.detail === 2)) this.ui.editText?.(hit.ref); this.drag = { kind: 'none', touch: isTouch, longPress: isTouch ? setTimeout(() => this.longPress(e, hit), 550) : null }; return; }
    if (hit && (hit.kind === 'staff' || hit.kind === 'measure')) {
      if (isTouch) { pan({ hit, longPress: setTimeout(() => this.longPress(e, hit), 550), tapSelect: true }); return; }
      const sel = app.selection;
      // drag a selected region onto other measures = copy (Alt = insert), like Finale
      if ((sel.type === 'measure' || sel.type === 'range') && !e.shiftKey) {
        const r = app.rangeOf(sel);
        if (hit.mi >= r.fromMi && hit.mi <= r.toMi && hit.si >= r.s0 && hit.si <= r.s1) { this.drag = { kind: 'dragCopy', start: hit, x: e.clientX, y: e.clientY, started: false, range: { ...r } }; return; }
      }
      if (e.shiftKey && (sel.type === 'measure' || sel.type === 'range')) {
        const r = app.rangeOf(sel);
        app.select({ type: 'range', fromMi: Math.min(r.fromMi, hit.mi), toMi: Math.max(r.toMi, hit.mi), s0: Math.min(r.s0, hit.si), s1: Math.max(r.s1, hit.si) });
        return;
      }
      this.drag = { kind: 'range', start: hit, x: e.clientX, y: e.clientY, started: false };
      return;
    }
    pan({ clear: true });
  }
  selectMeasureAt(mi, si, e) {
    const app = this.app; const sel = app.selection;
    if (e?.shiftKey && (sel.type === 'measure' || sel.type === 'range')) { const r = app.rangeOf(sel); app.select({ type: 'range', fromMi: Math.min(r.fromMi, mi), toMi: Math.max(r.toMi, mi), s0: Math.min(r.s0, si), s1: Math.max(r.s1, si) }); }
    else app.select({ type: 'measure', mi, si });
  }
  downEntry(e, hit, isTouch, pan) {
    if (!hit || (hit.kind !== 'staff' && hit.kind !== 'note' && hit.kind !== 'rest' && hit.kind !== 'event')) { pan(); return; }
    if (isTouch || e.pointerType === 'pen') {
      // touch/pen: press → slide up/down to choose the pitch (ghost follows) → release to place; sideways = scroll
      this.drag = { kind: 'touchInput', hit, x: e.clientX, y: e.clientY, sl: this.container.scrollLeft, st: this.container.scrollTop, steps: 0 };
      this.showEntryGhost(hit, 0, false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && hit.eventId) { this.app.select({ type: 'events', ids: [hit.eventId], noteIndex: hit.noteIndex }); return; }   // Finale: Ctrl+click selects
    this.commitEntry(hit, { forceChord: e.shiftKey });
  }
  downShape(e, hit, isTouch, pan, dbl) {
    const app = this.app;
    if (hit && hit.kind === 'spanner') {
      app.select({ type: 'spanner', id: hit.id });
      if (hit.handle) this.drag = { kind: 'shapeHandle', id: hit.id, handle: hit.handle, x: e.clientX, y: e.clientY };
      return;
    }
    const evHit = this.eventFromHit(hit);
    if (!evHit) { pan({ clear: true }); return; }
    if (dbl) return;   // the first click already created the shape
    this.drag = { kind: 'shapeDraw', from: evHit, item: this.metatool('shape'), x: e.clientX, y: e.clientY, started: false, to: null };
  }
  downMark(e, hit, isTouch, pan, tool) {
    const evHit = hit && (hit.kind === 'note' || hit.kind === 'rest' || hit.kind === 'event') && !hit.implicit ? hit : null;
    const item = this.metatool(tool);
    if (evHit) {
      if (tool === 'artic') applyArticulation(this.app, [evHit.eventId], item);
      else applyExpression(this.app, this.ui, item, { eventId: evHit.eventId });
      return;
    }
    if (tool === 'expr' && hit && (hit.kind === 'staff' || hit.kind === 'measure')) {
      const ev = this.eventFromHit(hit);
      const isMeasureItem = ['tempo', 'rehearsal'].includes(item) || !/^(f|ff|fff|p|pp|ppp|mf|mp|fp|fz|sfz|sfp|rfz)$/.test(item);
      if (isMeasureItem && ['tempo', 'rehearsal'].includes(item)) applyExpression(this.app, this.ui, item, { mi: hit.mi, si: hit.si });
      else if (ev) applyExpression(this.app, this.ui, item, { eventId: ev.eventId });
      else applyExpression(this.app, this.ui, item, { mi: hit.mi, si: hit.si });
      return;
    }
    // drag-enclose: apply to every note inside the rectangle (Finale)
    const pt = this.view.pointToPage(e.clientX, e.clientY);
    if (!pt || isTouch) { pan({ clear: true }); return; }
    this.drag = { kind: 'marquee', tool, item, page: pt.page, x0: pt.x, y0: pt.y, x: e.clientX, y: e.clientY, started: false };
  }
  downTextTool(e, hit, isTouch, pan, tool) {
    const ui = this.ui, app = this.app;
    if (hit && hit.kind === 'text') { app.select({ type: 'text', ref: hit.ref }); ui.editText?.(hit.ref); return; }
    if (!hit) { pan({ clear: true }); return; }
    const evHit = this.eventFromHit(hit);
    if (tool === 'lyrics') {
      const target = evHit && findEvent(app.score, evHit.eventId)?.ev.kind === 'note' ? evHit.eventId : this.nearestNoteId(hit);
      if (target) ui.lyricAt(target, ui.lyricVerse || 1, null); else ui.toast('가사는 음표에 붙습니다. 음표를 클릭하세요', 'warn');
      return;
    }
    if (tool === 'chord') {
      if (evHit) { const f = findEvent(app.score, evHit.eventId); if (f) { ui.chordAt(f.mi, f.tick); return; } }
      if (hit.mi != null) { const ts = effectiveTimeSig(app.score, hit.mi); const beat = ts.den === 8 && ts.num % 3 === 0 ? 1440 : 3840 / ts.den; ui.chordAt(hit.mi, Math.max(0, Math.min(measureCapacity(ts) - 1, Math.round((hit.tick || 0) / beat) * beat))); }
      return;
    }
    if (tool === 'text') {
      if (evHit && hit.kind !== 'staff') { app.select({ type: 'events', ids: [evHit.eventId] }); ui.addTextDialog('expression'); }
      else if (hit.mi != null) { app.select({ type: 'measure', mi: hit.mi, si: hit.si ?? 0 }); ui.addTextDialog('plain'); }
      return;
    }
    if (tool === 'measure') {
      const mi = hit.mi ?? hit.event?.mi, si = hit.si ?? hit.event?.si ?? 0;
      if (mi == null) { pan({ clear: true }); return; }
      app.select({ type: 'measure', mi, si });
      ui.measureMenu?.(e.clientX, e.clientY, mi, si);
    }
  }
  longPress(e, hit) {
    if (!this.drag) return;
    this.drag.longPressed = true;
    if (navigator.vibrate) navigator.vibrate(10);
    if (hit?.eventId && this.app.selection.type !== 'events') this.app.select({ type: 'events', ids: [hit.eventId] });
    else if (hit?.kind === 'staff' || hit?.kind === 'measure') this.app.select({ type: 'measure', mi: hit.mi, si: hit.si });
    this.ui.showContextMenu(e.clientX, e.clientY, hit);
    this.drag = null;
  }

  // ------------------------------------------------------------------ move
  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.view.setZoom(this.pinch.zoom * d / this.pinch.dist, { anchor: { x: this.pinch.cx, y: this.pinch.cy } });
      return;
    }
    const d = this.drag;
    if (!d) { this.hover(e); return; }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.longPress && Math.hypot(dx, dy) > 8) { clearTimeout(d.longPress); d.longPress = null; }
    switch (d.kind) {
      case 'touchInput': {
        if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.2) { this.view.setGhost(null); this.ui.hidePitchHint?.(); Object.assign(d, { kind: 'pan' }); return; }
        const steps = Math.round(-dy / Math.max(4, this.view.pxPerSp / 2));
        if (steps !== d.steps) { d.steps = steps; this.showEntryGhost(d.hit, steps, true); if (navigator.vibrate) navigator.vibrate(4); }
        return;
      }
      case 'pan':
        if (Math.hypot(dx, dy) > 5) { d.moved = true; if (d.tapSelect) d.tapSelect = false; }
        this.container.scrollLeft = d.sl - dx; this.container.scrollTop = d.st - dy;
        return;
      case 'pitch': {
        const spPx = this.view.pxPerSp / 2;   // one staff step = half a space
        const steps = Math.round(-dy / spPx);
        if (!d.started && Math.abs(dy) > spPx * 0.8) d.started = true;
        if (d.started && steps !== d.steps) { d.steps = steps; this.previewPitch(d, steps); }
        return;
      }
      case 'range': return this.moveRange(e, d, dx, dy);
      case 'dragCopy': {
        if (!d.started && Math.hypot(dx, dy) > 8) d.started = true;
        if (!d.started) return;
        const hit = this.hitAt(e);
        const mi = hit?.mi ?? hit?.event?.mi, si = hit?.si ?? hit?.event?.si;
        if (mi == null) { this.view.setDropTarget(null); d.target = null; return; }
        d.target = { mi, si, insert: e.altKey };
        const loc = this.view.measureRect(mi);
        if (loc) { const w = d.range.toMi - d.range.fromMi; const end = this.view.measureRect(Math.min(this.app.score.measures.length - 1, mi + w)); const x1 = end && end.page === loc.page ? end.x + end.w : loc.x + loc.w; this.view.setDropTarget({ page: loc.page, svg: `<rect class="drop-target${e.altKey ? ' insert' : ''}" x="${f3(loc.x)}" y="${f3(loc.y)}" width="${f3(x1 - loc.x)}" height="${f3(loc.h)}" rx="0.6"/>${e.altKey ? `<line class="insert-bar" x1="${f3(loc.x)}" y1="${f3(loc.y)}" x2="${f3(loc.x)}" y2="${f3(loc.y + loc.h)}"/>` : ''}` }); }
        return;
      }
      case 'shapeDraw': {
        if (!d.started && Math.hypot(dx, dy) > 6) d.started = true;
        if (!d.started) return;
        const hit = this.hitAt(e);
        const to = this.eventFromHit(hit);
        d.to = to && to.eventId !== d.from.eventId ? to : null;
        this.view.setHover(d.to?.eventId || null);
        this.drawShapePreview(d, e);
        return;
      }
      case 'shapeHandle': {
        const hit = this.hitAt(e); const to = this.eventFromHit(hit);
        d.to = to; this.view.setHover(to?.eventId || null);
        return;
      }
      case 'marquee': {
        if (!d.started && Math.hypot(dx, dy) > 6) d.started = true;
        if (!d.started) return;
        const pt = this.view.pointToPage(e.clientX, e.clientY); if (!pt || pt.page !== d.page) return;
        d.x1 = pt.x; d.y1 = pt.y;
        this.view.setMarquee({ page: d.page, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
        return;
      }
    }
  }
  moveRange(e, d, dx, dy) {
    if (!d.started && Math.hypot(dx, dy) > 6) d.started = true;
    if (!d.started) return;
    const hit = this.hitAt(e);
    if (hit && (hit.kind === 'staff' || hit.kind === 'measure' || hit.eventId)) {
      const mi = hit.mi ?? hit.event?.mi, si = hit.si ?? hit.event?.si;
      if (mi == null) return;
      const s = d.start;
      const fromMi = Math.min(s.mi, mi), toMi = Math.max(s.mi, mi);
      const sel = { type: 'range', fromMi, toMi, s0: Math.min(s.si, si), s1: Math.max(s.si, si) };
      if (fromMi === toMi && s.mi === mi) {
        const t0 = Math.min(s.tick ?? 0, hit.tick ?? 0), t1 = Math.max(s.tick ?? 0, hit.tick ?? 0);
        sel.fromTick = snapTick(this.app.score, mi, s.si, t0, 'floor'); sel.toTick = snapTick(this.app.score, mi, s.si, t1, 'ceil');
        if (sel.toTick - sel.fromTick < 1) { sel.fromTick = 0; delete sel.toTick; }
      } else if (s.mi <= mi) { sel.fromTick = snapTick(this.app.score, s.mi, s.si, s.tick ?? 0, 'floor'); if (sel.fromTick < 1) delete sel.fromTick; }
      this.app.select(sel);
    }
  }
  /** Hover feedback: ghost note in Simple Entry, highlighted target elsewhere. */
  hover(e) {
    if (e.pointerType === 'touch') return;
    const tool = this.tool;
    if (tool === 'entry') { const hit = this.hitAt(e); this.view.setHover(null); if (!hit || hit.kind === 'text' || hit.kind === 'spanner') { this.view.setGhost(null); return; } this.showEntryGhost(hit, 0, false); return; }
    const hit = this.hitAt(e, { preferSpanners: tool === 'shape' || tool === 'select' });
    if (tool === 'select') { this.view.setHover(hit?.eventId && !hit.implicit ? hit.eventId : null); this.container.style.cursor = hit?.kind === 'spanner' ? 'pointer' : ''; return; }
    if (tool === 'measure') { this.view.setHover(null); return; }
    const ev = hit?.kind === 'spanner' ? null : this.eventFromHit(hit, tool === 'lyrics');
    this.view.setHover(ev?.eventId || null);
    this.container.style.cursor = hit?.kind === 'spanner' ? 'pointer' : ev ? 'copy' : '';
  }
  previewPitch(d, steps) {
    const ids = this.app.selection.type === 'events' ? this.app.selection.ids : [d.hit.eventId];
    const dySp = -steps / 2;
    this.view.pageEls.forEach(el => el.querySelectorAll('g.ev').forEach(g => { if (ids.includes(g.dataset.id)) g.setAttribute('transform', `translate(0 ${f3(dySp)})`); }));
    d.previewIds = ids;
    this.ui.showPitchHint?.(d.hit, steps);
  }
  drawShapePreview(d, e) {
    const pt = this.view.pointToPage(e.clientX, e.clientY); if (!pt) return;
    const a = this.eventGeo(d.from.eventId); if (!a || a.page !== pt.page) { this.view.setGhost(null); return; }
    const b = d.to ? this.eventGeo(d.to.eventId) : null;
    const x0 = a.xCenter ?? a.x, y0 = a.y0 - 0.6, x1 = b ? (b.xCenter ?? b.x) : pt.x, y1 = b ? b.y0 - 0.6 : pt.y;
    const h = Math.min(3, 0.8 + Math.abs(x1 - x0) * 0.15);
    this.view.setGhost({ page: pt.page, svg: `<path class="shape-preview" d="M${f3(x0)} ${f3(y0)} C${f3(x0 + (x1 - x0) * 0.3)} ${f3(y0 - h)} ${f3(x0 + (x1 - x0) * 0.7)} ${f3(y1 - h)} ${f3(x1)} ${f3(y1)}"/>` });
  }

  // ------------------------------------------------------------------ up
  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) { this.pinch = null; this.drag = null; return; }
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.longPress) clearTimeout(d.longPress);
    if (d.longPressed) return;
    switch (d.kind) {
      case 'touchInput':
        this.view.setGhost(null); this.ui.hidePitchHint?.();
        if (!cancelled) this.commitEntry(d.hit, { steps: d.steps });
        return;
      case 'pan':
        if (d.right) {
          if (d.moved) { this.suppressMenu = true; setTimeout(() => { this.suppressMenu = false; }, 400); }
          else if (d.menuPending) this.ui.showContextMenu(d.menuPending.x, d.menuPending.y, d.menuPending.hit);
          return;
        }
        if (d.tapSelect && d.hit) this.app.select({ type: 'measure', mi: d.hit.mi, si: d.hit.si });
        else if (d.clear && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) this.app.clearSelection();
        return;
      case 'pitch':
        if (d.previewIds) this.view.pageEls.forEach(el => el.querySelectorAll('g.ev').forEach(g => g.removeAttribute('transform')));
        this.ui.hidePitchHint?.();
        if (d.started && d.steps && !cancelled) {
          const ids = d.previewIds || [d.hit.eventId];
          this.app.exec('음높이 변경', s => C.transposeEvents(s, ids, { diatonic: d.steps }), { select: this.app.selection });
        } else if (d.touch && !d.started) this.ui.showMiniToolbar?.(d.hit);
        else if (!d.started && this._keptMulti === d.hit) this.app.select({ type: 'events', ids: [d.hit.eventId], noteIndex: d.hit.kind === 'note' ? d.hit.noteIndex : undefined });
        this._keptMulti = null;
        return;
      case 'range':
        if (!d.started) this.selectMeasureAt(d.start.mi, d.start.si, e);
        return;
      case 'dragCopy': {
        this.view.setDropTarget(null);
        if (!d.started) { this.app.select({ type: 'measure', mi: d.start.mi, si: d.start.si }); return; }
        if (cancelled || !d.target) return;
        this.ui.dragCopy?.(d.range, d.target);
        return;
      }
      case 'shapeDraw': {
        this.view.setGhost(null); this.view.setHover(null);
        if (cancelled) return;
        createShape(this.app, d.item, d.from.eventId, d.to?.eventId || null);
        return;
      }
      case 'shapeHandle': {
        this.view.setHover(null);
        if (cancelled || !d.to) return;
        const sp = (this.app.score.spanners || []).find(s => s.id === d.id); if (!sp) return;
        const keep = { type: 'spanner', id: d.id };
        this.app.exec('기호 범위 변경', s => { const x = s.spanners.find(q => q.id === d.id); if (!x) return; if (d.handle === 'start') x.from = { eventId: d.to.eventId }; else x.to = { eventId: d.to.eventId }; const fa = findEvent(s, x.from.eventId), fb = findEvent(s, x.to.eventId); if (fa && fb && (fb.mi < fa.mi || (fb.mi === fa.mi && fb.tick < fa.tick))) [x.from, x.to] = [x.to, x.from]; }, { select: keep });
        return;
      }
      case 'marquee': {
        this.view.setMarquee(null);
        if (!d.started) { this.app.clearSelection(); return; }
        if (cancelled) return;
        const g = this.app.layout.pages[d.page]?.geometry; if (!g) return;
        const xa = Math.min(d.x0, d.x1), xb = Math.max(d.x0, d.x1), ya = Math.min(d.y0, d.y1), yb = Math.max(d.y0, d.y1);
        const ids = g.events.filter(ev => !ev.implicit && (ev.xCenter ?? ev.x) >= xa && (ev.xCenter ?? ev.x) <= xb && ev.y1 >= ya && ev.y0 <= yb).map(ev => ev.id);
        if (!ids.length) return;
        if (d.tool === 'artic') applyArticulation(this.app, ids, d.item, { toggle: false });
        else { const first = ids.find(id => findEvent(this.app.score, id)?.ev.kind === 'note') || ids[0]; applyExpression(this.app, this.ui, d.item, { eventId: first }); }
        this.app.select({ type: 'events', ids });
        return;
      }
    }
  }
  onDouble(e) {
    const tool = this.tool; if (tool !== 'select') return;
    const hit = this.hitAt(e);
    if (!hit) return;
    if (hit.kind === 'staff' || hit.kind === 'measure' || hit.implicit) {
      // Finale: double-click a measure = select the measure stack (that measure in every staff)
      const mi = hit.mi ?? hit.event?.mi;
      this.app.select({ type: 'range', fromMi: mi, toMi: mi, s0: 0, s1: totalStaffCount(this.app.score) - 1, stack: true });
    } else if (hit.eventId) this.ui.onDoubleTapEvent?.(hit);
  }

  // ------------------------------------------------------------------ Simple Entry
  showEntryGhost(hit, steps = 0, audition = false) {
    const h = steps ? this.shiftHit(hit, steps) : hit;
    const t = h && entryTarget(this.app, this.view, h);
    if (!t) { this.view.setGhost(null); return; }
    this.view.setGhost({ page: t.page, svg: ghostSvg(t, this.app.input) });
    this.ui.showGhostInfo?.(t, audition);
    if (audition) this.ui.audition?.(t);
  }
  shiftHit(hit, steps) { return { ...hit, py: hit.py - steps / 2 }; }
  commitEntry(hit, { forceChord = false, steps = 0 } = {}) {
    const app = this.app;
    const h = steps ? this.shiftHit(hit, steps) : hit;
    const t = entryTarget(app, this.view, h); if (!t) return;
    const note = { pitch: t.pitch, drum: t.drum, string: t.string, fret: t.fret };
    if (t.action === 'full' && !forceChord) { this.ui.toast?.('이 마디는 가득 찼습니다. 다음 마디를 클릭하세요 (기존 음표 위·아래를 클릭하면 화음이 됩니다)', 'warn'); return; }
    if (t.action === 'modify') {
      // clicking an existing notehead with a duration chosen changes its duration (Finale); same value → select it
      const f = findEvent(app.score, t.eventId); if (!f) return;
      const inp = app.input;
      if (!inp.rest && (f.ev.dur.base !== inp.base || (f.ev.dur.dots || 0) !== (inp.dots || 0)) && !f.ev.tuplet) app.exec('음길이', s => C.setDuration(s, [t.eventId], inp.base, inp.dots || 0), { select: { type: 'events', ids: [t.eventId], noteIndex: t.noteIndex } });
      else app.select({ type: 'events', ids: [t.eventId], noteIndex: t.noteIndex });
      app.cursor = { mi: f.mi, si: f.staffIndex, vi: f.voiceIndex, tick: f.tick + durTicks(f.ev) };
      return;
    }
    const chord = t.action === 'chord' || forceChord;
    if (chord && t.eventId && !app.input.rest) {
      const keepCursor = app.cursor;
      const id = app.inputNote({ ...note, at: { mi: t.mi, si: t.si, tick: t.tick, exact: true }, addToChord: true });
      if (id && keepCursor) app.cursor = keepCursor;
      this.view.setGhost(null);
      return;
    }
    const id = app.inputNote({ ...note, at: { mi: t.mi, si: t.si, tick: t.tick, exact: true } });
    if (id) this.view.setGhost(null);
  }

  // ------------------------------------------------------------------ helpers
  /** The event under a hit (or the event at the hit's beat on its staff). */
  eventFromHit(hit, notesOnly = false) {
    if (!hit) return null;
    if ((hit.kind === 'note' || hit.kind === 'rest' || hit.kind === 'event') && !hit.implicit) return { eventId: hit.eventId };
    if (hit.kind === 'staff' || (hit.kind === 'rest' && hit.implicit)) {
      const mi = hit.mi ?? hit.event?.mi, si = hit.si ?? hit.event?.si; if (mi == null) return null;
      const g = this.app.layout.pages[hit.page]?.geometry.events.filter(ev => ev.mi === mi && ev.si === si && !ev.implicit) || [];
      let best = null, bd = 2.2;
      for (const ev of g) { if (notesOnly && ev.rest) continue; const d = Math.abs((ev.xCenter ?? ev.x) - hit.px); if (d < bd) { bd = d; best = ev; } }
      return best ? { eventId: best.id } : null;
    }
    return null;
  }
  nearestNoteId(hit) { const e = this.eventFromHit(hit, true); return e && findEvent(this.app.score, e.eventId)?.ev.kind === 'note' ? e.eventId : null; }
  eventGeo(id) { for (const p of this.app.layout?.pages || []) { const e = p.geometry.events.find(x => x.id === id); if (e) return { ...e, page: p.index }; } return null; }

  // kept for compatibility with older callers
  ghostFor(hit, steps = 0, audition = false) { this.showEntryGhost(hit, steps, audition); }
  inputAt(hit, addToChord, steps = 0) { this.commitEntry(hit, { forceChord: addToChord, steps }); }
}

/** Faded note of the chosen value at the Simple Entry target (Finale's entry preview). */
function ghostSvg(t, input) {
  const x = t.x, y = t.staffY + t.pos / 2;
  let s = '';
  const cls = t.action === 'full' ? 'ghost-glyph full' : 'ghost-glyph';
  if (t.action === 'append' || t.action === 'replace') s += `<line class="entry-guide" x1="${f3(x)}" y1="${f3(t.staffY - 1.5)}" x2="${f3(x)}" y2="${f3(t.staffY + 5.5)}"/>`;
  if (input.rest) {
    const g = { whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', breve: 'restDoubleWhole' }[input.base] || 'restQuarter';
    return s + `<use class="${cls}" href="#g-${g}" transform="translate(${f3(x - 0.6)} ${f3(t.staffY + 2)})"/>`;
  }
  const head = input.base === 'whole' ? 'noteheadWhole' : input.base === 'breve' ? 'noteheadWhole' : input.base === 'half' ? 'noteheadHalf' : 'noteheadBlack';
  const hx = x - HEAD_W / 2;
  // ledger lines
  if (t.pos <= -2) for (let p = -2; p >= t.pos; p -= 2) s += `<line class="ghost-ledger" x1="${f3(hx - 0.35)}" y1="${f3(t.staffY + p / 2)}" x2="${f3(hx + HEAD_W + 0.35)}" y2="${f3(t.staffY + p / 2)}"/>`;
  if (t.pos >= 10) for (let p = 10; p <= t.pos; p += 2) s += `<line class="ghost-ledger" x1="${f3(hx - 0.35)}" y1="${f3(t.staffY + p / 2)}" x2="${f3(hx + HEAD_W + 0.35)}" y2="${f3(t.staffY + p / 2)}"/>`;
  s += `<use class="${cls}" href="#g-${head}" transform="translate(${f3(hx)} ${f3(y)})"/>`;
  if (input.base !== 'whole' && input.base !== 'breve' && t.action !== 'chord') {
    const up = t.pos >= 4;
    const sx = up ? hx + HEAD_W - 0.06 : hx + 0.06, sy1 = up ? y - 3.3 : y + 3.3;
    s += `<line class="ghost-stem" x1="${f3(sx)}" y1="${f3(y)}" x2="${f3(sx)}" y2="${f3(sy1)}"/>`;
    const flags = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 }[input.base];
    if (flags) { const fg = ['flag8th', 'flag16th', 'flag32nd', 'flag64th'][flags - 1] + (up ? 'Up' : 'Down'); if (GLYPHS[fg]) s += `<use class="${cls}" href="#g-${fg}" transform="translate(${f3(sx - 0.06)} ${f3(sy1)})"/>`; }
  }
  if (input.dots) s += `<circle class="${cls}" cx="${f3(hx + HEAD_W + 0.45)}" cy="${f3(y - (t.pos % 2 === 0 ? 0.5 : 0))}" r="0.2"/>`;
  if (input.accidental) { const g = { sharp: 'accidentalSharp', flat: 'accidentalFlat', natural: 'accidentalNatural' }[input.accidental]; if (g) s += `<use class="${cls}" href="#g-${g}" transform="translate(${f3(hx - 1.15)} ${f3(y)})"/>`; }
  if (t.action === 'chord') s += `<text class="ghost-tag" x="${f3(hx + HEAD_W + 0.5)}" y="${f3(y + 0.5)}" font-size="1.5">+</text>`;
  if (t.action === 'modify') s += `<circle class="ghost-ring" cx="${f3(x)}" cy="${f3(y)}" r="1.1"/>`;
  return s;
}

/** Snap an interpolated tick to existing onsets or to the input duration grid inside rests. */
export function snapTick(score, mi, si, tick, mode = 'nearest', input = null) {
  const m = score.measures[mi]; if (!m) return 0;
  const cap = measureCapacity(effectiveTimeSig(score, mi));
  const onsets = new Set([0]);
  m.staves[si].voices.forEach(v => { let t = 0; v.forEach(e => { onsets.add(t); if (!e.grace) t += durTicks(e); }); });
  const grid = input ? ({ whole: 3840, half: 1920, quarter: 960, eighth: 480, '16th': 240, '32nd': 120, '64th': 60 }[input.base] || 960) : 240;
  const cands = [...onsets];
  for (let t = 0; t < cap; t += grid) cands.push(t);
  cands.sort((a, b) => a - b);
  if (mode === 'floor') return cands.filter(c => c <= tick + 1).pop() ?? 0;
  if (mode === 'ceil') return cands.find(c => c >= tick - 1) ?? cap;
  let best = 0, bd = Infinity;
  for (const c of cands) { const d = Math.abs(c - tick); if (d < bd) { bd = d; best = c; } }
  return Math.min(best, cap - 1);
}
export { staffPosOf };
void noteAtStaffPosition; void effectiveClef; void effectiveKeySig; void keyAlter; void staffList;
