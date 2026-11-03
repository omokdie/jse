// ScoreView: shows engraved pages, handles zoom/view modes, selection overlay, cursor and hit-testing.
import { findEvent, durTicks, effectiveTimeSig, measureCapacity, staffList } from '../model/score.js';
import { f3 } from '../engrave/notes.js';

const PX_PER_MM = 96 / 25.4;

export class ScoreView {
  constructor(app, container) {
    this.app = app;
    this.container = container;       // scrolling element
    this.desk = document.createElement('div');
    this.desk.className = 'desk mode-vertical';
    container.appendChild(this.desk);
    this.pageEls = [];
    this.ghost = null;
    app.addEventListener('layout', () => this.render());
    app.addEventListener('selection', () => this.updateSelection());
    app.addEventListener('mode', () => this.updateSelection());
    this._resizeObs = new ResizeObserver(() => {
      clearTimeout(this._rt);
      this._rt = setTimeout(() => {
        if (this.app.viewMode === 'reflow') { const w = this.container.clientWidth - 28; if (Math.abs(w - (this.app.reflowWidthPx || 0)) > 4) { this.app.reflowWidthPx = w; this.app.relayout(); } }
        else if (this.fitMode) this.applyFit();
      }, 120);
    });
    this._resizeObs.observe(container);
    this.fitMode = 'width';
  }
  get pxPerSp() { return this.app.zoom * PX_PER_MM * (this.app.layout?.spMm || 1.75); }
  pageSizePx(p) { return { w: p.width * this.pxPerSp, h: p.height * this.pxPerSp }; }

  setViewMode(mode) {
    const prev = this.app.viewMode;
    this.app.viewMode = mode;
    this.desk.className = `desk mode-${mode}`;
    if (mode === 'reflow') { this.app.reflowWidthPx = this.container.clientWidth - 28; this.app.zoom = 1; this.fitMode = null; this.app.relayout(); }
    else { if (prev === 'reflow') { this.app.relayout(); } this.fitMode = this.fitMode || 'width'; if (mode === 'grid') this.fitMode = 'width'; }
    if (mode === 'single') this.showPage(this.app.currentPage);
    if (this.fitMode) this.applyFit();
    this.app.emit('viewmode');
  }
  setZoom(z, { anchor = null } = {}) {
    const old = this.app.zoom;
    z = Math.max(0.2, Math.min(5, z));
    if (Math.abs(z - old) < 1e-4) return;
    // keep the point under the anchor stable
    const c = this.container;
    const ax = anchor ? anchor.x - c.getBoundingClientRect().left : c.clientWidth / 2;
    const ay = anchor ? anchor.y - c.getBoundingClientRect().top : c.clientHeight / 2;
    const sx = (c.scrollLeft + ax) / old, sy = (c.scrollTop + ay) / old;
    this.app.zoom = z; this.fitMode = null;
    this.applySizes();
    if (this.app.viewMode === 'reflow') { clearTimeout(this._zt); this._zt = setTimeout(() => this.app.relayout(), 260); }
    c.scrollLeft = sx * z - ax; c.scrollTop = sy * z - ay;
    this.app.emit('zoom');
  }
  zoomBy(f, anchor) { this.setZoom(this.app.zoom * f, { anchor }); }
  fit(mode) { this.fitMode = mode; this.applyFit(); }
  applyFit() {
    const pages = this.app.layout?.pages; if (!pages?.length) return;
    const p = pages[0];
    const cw = this.container.clientWidth - 48, ch = this.container.clientHeight - 48;
    const unit = PX_PER_MM * (this.app.layout.spMm || 1.75);
    let z;
    if (this.fitMode === 'width') z = cw / (p.width * unit);
    else if (this.fitMode === 'page') z = Math.min(cw / (p.width * unit), ch / (p.height * unit));
    else return;
    if (this.app.viewMode === 'grid') { const perRow = cw > 1500 ? 4 : cw > 1000 ? 3 : 2; z = Math.min(z, (cw - (perRow - 1) * 30) / perRow / (p.width * unit)); }
    if (this.app.viewMode === 'reflow') { this.app.reflowWidthPx = this.container.clientWidth - 28; z = this.app.zoom; }
    this.app.zoom = Math.max(0.2, Math.min(5, z));
    this.applySizes();
    this.app.emit('zoom');
  }
  applySizes() {
    const pages = this.app.layout?.pages || [];
    this.pageEls.forEach((el, i) => { const p = pages[i]; if (!p) return; const { w, h } = this.pageSizePx(p); el.style.width = w + 'px'; el.style.height = h + 'px'; });
  }

  /** Re-render all pages from the layout. */
  render() {
    const pages = this.app.layout?.pages || [];
    const desk = this.desk;
    // reuse page elements
    while (this.pageEls.length > pages.length) { const el = this.pageEls.pop(); el.remove(); }
    pages.forEach((p, i) => {
      let el = this.pageEls[i];
      if (!el) {
        el = document.createElement('div'); el.className = 'page'; el.dataset.page = i;
        const inner = document.createElement('div'); inner.className = 'page-svg'; el.appendChild(inner);
        const ov = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ov.setAttribute('class', 'overlay'); el.appendChild(ov);
        const label = document.createElement('div'); label.className = 'page-label'; el.appendChild(label);
        desk.appendChild(el); this.pageEls.push(el);
      }
      const { w, h } = this.pageSizePx(p);
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.querySelector('.page-svg').innerHTML = p.svg;
      const ov = el.querySelector('.overlay'); ov.setAttribute('viewBox', `0 0 ${f3(p.width)} ${f3(p.height)}`); ov.innerHTML = '';
      el.querySelector('.page-label').textContent = `${i + 1} / ${pages.length}`;
      el.classList.toggle('current', i === this.app.currentPage);
    });
    if (this.app.viewMode === 'single') this.showPage(this.app.currentPage);
    this.updateSelection();
  }
  showPage(i) {
    const pages = this.app.layout?.pages || [];
    this.app.currentPage = Math.max(0, Math.min(pages.length - 1, i));
    this.pageEls.forEach((el, k) => { el.classList.toggle('current', k === this.app.currentPage); if (this.app.viewMode === 'single') el.style.display = k === this.app.currentPage ? '' : 'none'; else el.style.display = ''; });
    this.app.emit('page');
  }
  scrollToMeasure(mi, { center = false } = {}) {
    const loc = this.measureRect(mi); if (!loc) return;
    const el = this.pageEls[loc.page]; if (!el) return;
    if (this.app.viewMode === 'single' && loc.page !== this.app.currentPage) this.showPage(loc.page);
    const s = this.pxPerSp;
    const top = el.offsetTop + loc.y * s, left = el.offsetLeft + loc.x * s;
    const c = this.container;
    if (center || top < c.scrollTop || top + loc.h * s > c.scrollTop + c.clientHeight) c.scrollTo({ top: Math.max(0, top - (center ? c.clientHeight / 2 : 80)), behavior: 'smooth' });
    if (left < c.scrollLeft || left + loc.w * s > c.scrollLeft + c.clientWidth) c.scrollTo({ left: Math.max(0, left - 60), behavior: 'smooth' });
  }
  measureRect(mi) {
    for (const p of this.app.layout?.pages || []) {
      const mr = p.geometry.measures.find(m => m.mi === mi);
      if (mr) { const st = mr.staves; const y0 = Math.min(...st.map(s => s.y)) - 4, y1 = Math.max(...st.map(s => s.y + s.h)) + 4; return { page: p.index, x: mr.x, y: y0, w: mr.width, h: y1 - y0, measure: mr }; }
    }
    return null;
  }

  // ---------- coordinates ----------
  /** Map a client point to {page, x, y} in sp. */
  pointToPage(clientX, clientY) {
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i]; if (el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        const p = this.app.layout.pages[i];
        return { page: i, x: (clientX - r.left) / r.width * p.width, y: (clientY - r.top) / r.height * p.height, el };
      }
    }
    return null;
  }
  /** Convert page coords to client coords. */
  pageToClient(page, x, y) {
    const el = this.pageEls[page]; if (!el) return null;
    const r = el.getBoundingClientRect(); const p = this.app.layout.pages[page];
    return { x: r.left + x / p.width * r.width, y: r.top + y / p.height * r.height };
  }

  // ---------- hit testing ----------
  hitTest(page, x, y, opts = {}) {
    const tolerance = opts.tolerance ?? 0.6;
    const p = this.app.layout?.pages[page]; if (!p) return null;
    const g = p.geometry;
    // 1. note heads
    let best = null, bestD = Infinity;
    for (const e of g.events) {
      if (e.heads?.length) {
        for (const h of e.heads) {
          if (x >= h.x0 - tolerance && x <= h.x1 + tolerance && y >= h.y0 - tolerance && y <= h.y1 + tolerance) {
            const d = Math.hypot(x - (h.x0 + h.x1) / 2, y - h.y);
            if (d < bestD) { bestD = d; best = { kind: 'note', eventId: e.id, noteIndex: h.noteIndex, event: e }; }
          }
        }
      }
      // rest / stem box
      if (x >= e.x - tolerance && x <= (e.x1 ?? e.x + 1.3) + tolerance && y >= e.y0 - tolerance && y <= e.y1 + tolerance) {
        const d = Math.hypot(x - (e.xCenter ?? e.x), y - (e.y0 + e.y1) / 2) + 0.5;
        if (d < bestD) { bestD = d; best = { kind: e.rest ? 'rest' : 'event', eventId: e.id, event: e, implicit: e.implicit }; }
      }
    }
    if (best && !(opts.preferSpanners && best.kind !== 'note')) return best;
    // 1b. smart shapes (slurs, hairpins, lines) — nearest point on the sampled curve
    const spHit = this.spannerAt(p, x, y);
    if (spHit) return spHit;
    if (best) return best;
    // 2. texts (lyrics, chords, tempo, rehearsal, title...)
    for (const t of g.texts) {
      if (x >= t.x - 0.3 && x <= t.x + t.w + 0.3 && y >= t.y - 0.3 && y <= t.y + t.h + 0.3) return { kind: 'text', ref: t };
    }
    // 3. staff area → measure/staff/tick/pos
    for (const mr of g.measures) {
      if (x < mr.x || x > mr.x + mr.width) continue;
      for (const st of mr.staves) {
        if (y >= st.y - 5 && y <= st.y + st.h + 5) {
          const pos = Math.round((y - st.y) * 2);
          const tick = this.tickAtX(mr, x);
          return { kind: 'staff', mi: mr.mi, measureId: mr.measureId, si: st.si, pos, tick, staffY: st.y, staffH: st.h, measure: mr, x, y, inStaff: y >= st.y - 1 && y <= st.y + st.h + 1 };
        }
      }
    }
    // 4. between staves of a measure: still return measure
    for (const mr of g.measures) {
      const y0 = Math.min(...mr.staves.map(s => s.y)) - 6, y1 = Math.max(...mr.staves.map(s => s.y + s.h)) + 6;
      if (x >= mr.x && x <= mr.x + mr.width && y >= y0 && y <= y1) {
        const st = mr.staves.reduce((b, s) => Math.abs(s.y + s.h / 2 - y) < Math.abs(b.y + b.h / 2 - y) ? s : b, mr.staves[0]);
        return { kind: 'measure', mi: mr.mi, measureId: mr.measureId, si: st.si, measure: mr, tick: this.tickAtX(mr, x) };
      }
    }
    return null;
  }
  /** Smart shape under (x, y): {kind:'spanner', id, handle:'start'|'end'|null} */
  spannerAt(p, x, y, tol = 0.75) {
    let best = null, bd = tol;
    for (const sp of (p.geometry.spanners || [])) {
      const pts = sp.pts;
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (d < bd) { bd = d; best = sp; }
      }
      if (pts.length === 1) { const d = Math.hypot(x - pts[0][0], y - pts[0][1]); if (d < bd) { bd = d; best = sp; } }
    }
    if (!best) return null;
    const hs = Math.hypot(x - best.start[0], y - best.start[1]), he = Math.hypot(x - best.end[0], y - best.end[1]);
    const handle = hs < 1.1 && best.hasStart !== false ? 'start' : he < 1.1 && best.hasEnd !== false ? 'end' : null;
    return { kind: 'spanner', id: best.id, spanner: best, handle };
  }
  /** Interpolate a tick from x inside a laid-out measure. */
  tickAtX(mr, x) {
    const slots = mr.slots.filter(s => !s.grace);
    if (!slots.length) return 0;
    const cap = measureCapacity(effectiveTimeSig(this.app.score, mr.mi));
    const headW = 1.26;
    if (x <= slots[0].x + headW / 2) return 0;
    for (let i = 0; i < slots.length; i++) {
      const a = slots[i], b = slots[i + 1];
      const ax = a.x + headW / 2;
      const bx = b ? b.x + headW / 2 : mr.x + mr.width - 1;
      const bt = b ? b.tick : cap;
      if (x >= ax && x < bx) { const f = (x - ax) / Math.max(0.01, bx - ax); return a.tick + f * (bt - a.tick); }
    }
    return cap - 1;
  }
  /** Nearest slot tick (snapping to existing onsets) within measure for x. */
  nearestSlot(mr, x) {
    let best = null, bd = Infinity;
    for (const s of mr.slots) { const d = Math.abs(s.x + 0.63 - x); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  // ---------- overlays ----------
  updateSelection() {
    const sel = this.app.selection;
    const ids = new Set(sel.type === 'events' ? sel.ids : []);
    this.pageEls.forEach((el, pi) => {
      el.querySelectorAll('g.ev.selected').forEach(g => g.classList.remove('selected'));
      el.querySelectorAll('.nh.selected-note').forEach(g => g.classList.remove('selected-note'));
      if (ids.size) el.querySelectorAll('g.ev').forEach(g => { if (ids.has(g.dataset.id)) { g.classList.add('selected'); if (sel.noteIndex != null && sel.ids.length === 1) { g.querySelectorAll('.nh').forEach(n => { if (+n.dataset.n !== sel.noteIndex) n.classList.add('deselected-note'); else n.classList.remove('deselected-note'); }); } else g.querySelectorAll('.nh').forEach(n => n.classList.remove('deselected-note')); } });
      el.querySelectorAll('g.stem-g').forEach(g => g.classList.toggle('selected', ids.has(g.dataset.id)));
      el.querySelectorAll('text.selected-text').forEach(t => t.classList.remove('selected-text'));
      el.querySelectorAll('[data-sp].sp-selected').forEach(g => g.classList.remove('sp-selected'));
      if (sel.type === 'spanner') el.querySelectorAll(`[data-sp="${sel.id}"]`).forEach(g => g.classList.add('sp-selected'));
      el.querySelectorAll('g.ev.hover').forEach(g => g.classList.remove('hover'));
      if (this.hoverId) el.querySelectorAll(`g.ev[data-id="${this.hoverId}"]`).forEach(g => g.classList.add('hover'));
      const ov = el.querySelector('.overlay'); if (!ov) return;
      let html = '';
      const p = this.app.layout.pages[pi];
      if (sel.type === 'range' || sel.type === 'measure') {
        const r = this.app.rangeOf(sel);
        for (const mr of p.geometry.measures) {
          if (mr.mi < r.fromMi || mr.mi > r.toMi) continue;
          const st = mr.staves.filter(s => s.si >= r.s0 && s.si <= r.s1); if (!st.length) continue;
          const y0 = Math.min(...st.map(s => s.y)) - 1.5, y1 = Math.max(...st.map(s => s.y + s.h)) + 1.5;
          let x0 = mr.x, x1 = mr.x + mr.width;
          if (sel.type === 'range' && mr.mi === r.fromMi && r.fromTick) x0 = this.xAtTick(mr, r.fromTick) - 0.8;
          if (sel.type === 'range' && mr.mi === r.toMi && r.toTick != null) x1 = this.xAtTick(mr, r.toTick) - 0.8;
          html += `<rect class="sel-range" x="${f3(x0)}" y="${f3(y0)}" width="${f3(x1 - x0)}" height="${f3(y1 - y0)}"/>`;
        }
      }
      if (sel.type === 'text') { const t = sel.ref; if (t.page === pi) html += `<rect class="sel-text" x="${f3(t.x - 0.3)}" y="${f3(t.y - 0.2)}" width="${f3(t.w + 0.6)}" height="${f3(t.h + 0.4)}" rx="0.4"/>`; }
      // input cursor
      const c = this.app.cursor;
      if (this.app.mode === 'input' && c && !(this.ghost && this.ghost.page === pi)) {
        const mr = p.geometry.measures.find(m => m.mi === c.mi);
        if (mr) {
          const st = mr.staves.find(s => s.si === c.si);
          if (st) { const x = this.xAtTick(mr, c.tick); html += `<line class="cursor" x1="${f3(x - 0.9)}" y1="${f3(st.y - 2)}" x2="${f3(x - 0.9)}" y2="${f3(st.y + st.h + 2)}"/><rect class="cursor-box" x="${f3(x - 1.4)}" y="${f3(st.y - 2.5)}" width="${f3(Math.max(2.6, 2.6))}" height="${f3(st.h + 5)}" rx="0.5"/>`; }
        }
      }
      // smart-shape handles (Finale shows them while the Smart Shape tool is active)
      if (this.app.tool === 'shape' || sel.type === 'spanner') {
        for (const sp of (p.geometry.spanners || [])) {
          const on = sel.type === 'spanner' && sel.id === sp.id;
          if (!on && this.app.tool !== 'shape') continue;
          const r = on ? 0.55 : 0.38;
          for (const [hx, hy] of [sp.start, sp.end]) html += `<rect class="sp-handle${on ? ' on' : ''}" x="${f3(hx - r)}" y="${f3(hy - r)}" width="${f3(r * 2)}" height="${f3(r * 2)}" transform="rotate(45 ${f3(hx)} ${f3(hy)})"/>`;
        }
      }
      if (this.marquee && this.marquee.page === pi) { const m = this.marquee; html += `<rect class="marquee" x="${f3(Math.min(m.x0, m.x1))}" y="${f3(Math.min(m.y0, m.y1))}" width="${f3(Math.abs(m.x1 - m.x0))}" height="${f3(Math.abs(m.y1 - m.y0))}"/>`; }
      if (this.dropTarget && this.dropTarget.page === pi) html += this.dropTarget.svg;
      if (this.ghost && this.ghost.page === pi) html += this.ghost.svg;
      if (this.playCursor && this.playCursor.page === pi) html += this.playCursor.svg;
      ov.innerHTML = html;
    });
  }
  xAtTick(mr, tick) {
    const slots = mr.slots.filter(s => !s.grace);
    const hit = slots.find(s => Math.abs(s.tick - tick) < 1);
    if (hit) return hit.x + 0.63;
    const cap = measureCapacity(effectiveTimeSig(this.app.score, mr.mi));
    for (let i = 0; i < slots.length; i++) {
      const a = slots[i], b = slots[i + 1];
      const at = a.tick, bt = b ? b.tick : cap;
      if (tick >= at && tick < bt) { const ax = a.x + 0.63, bx = b ? b.x + 0.63 : mr.x + mr.width - 1; return ax + (bx - ax) * (tick - at) / Math.max(1, bt - at); }
    }
    return slots.length ? slots[slots.length - 1].x + 2 : mr.x + 2;
  }
  setGhost(ghost) { this.ghost = ghost; this.updateSelection(); }
  setHover(id) { if (this.hoverId === id) return; this.hoverId = id; this.updateSelection(); }
  setMarquee(m) { this.marquee = m; this.updateSelection(); }
  setDropTarget(t) { this.dropTarget = t; this.updateSelection(); }
  setPlayCursor(pc) { this.playCursor = pc; this.updateSelection(); }
  /** Highlight events currently sounding (playback). */
  highlightPlaying(ids) {
    const set = new Set(ids);
    this.pageEls.forEach(el => el.querySelectorAll('g.ev.playing').forEach(g => { if (!set.has(g.dataset.id)) g.classList.remove('playing'); }));
    if (!ids.length) return;
    this.pageEls.forEach(el => el.querySelectorAll('g.ev').forEach(g => { if (set.has(g.dataset.id)) g.classList.add('playing'); }));
  }
  /** Rect (client coords) of an event for anchoring popovers. */
  eventClientRect(eventId) {
    for (const p of this.app.layout?.pages || []) {
      const e = p.geometry.events.find(e => e.id === eventId);
      if (e) { const a = this.pageToClient(p.index, e.x, e.y0), b = this.pageToClient(p.index, e.x1 ?? e.x + 1.3, e.y1); if (a && b) return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y }; }
    }
    return null;
  }
  thumbnails() { return (this.app.layout?.pages || []).map(p => p.svg); }
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay; const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export { PX_PER_MM };
