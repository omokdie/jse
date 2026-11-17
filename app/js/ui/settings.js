// Settings window — one registry (../settings.js), three shapes:
//   desktop  large window: category list (left) · search · grouped cards (right)
//   tablet   the same two panes, touch sized
//   phone    full-screen pages: category list → page with a back arrow; choices open as bottom sheets
// Every change is applied immediately (no Apply button).
import { icon } from './icons.js';
import { visibleSections, visibleItems, search, itemById, sectionOf, groupOf, labelOf } from '../settings.js';
import { confirmDialog, modalCount } from './dialogs.js';
import { native, pushBack, goBack } from '../native.js';
import { getLang } from '../i18n.js';

const ui24 = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const tint = 'fill="currentColor" fill-opacity=".16"';
/** Icons only this window needs, drawn in the same hand as ui/icons.js. */
const OWN = {
  display: ui24(`<rect x="3" y="4" width="18" height="12.5" rx="3" ${tint}/><path d="M9 20.5h6M12 16.5v4"/>`),
  windows: ui24(`<rect x="3" y="4.5" width="18" height="15" rx="3.2" ${tint}/><path d="M3 9.5h18"/><path d="M6.4 7h.01M9.2 7h.01"/>`),
  android: ui24(`<rect x="6.5" y="2.5" width="11" height="19" rx="3" ${tint}/><path d="M10.5 18.5h3"/>`),
  web: ui24(`<circle cx="12" cy="12" r="9" ${tint}/><path d="M3 12h18M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9S9.4 5.5 12 3z"/>`),
  search: ui24('<circle cx="10.8" cy="10.8" r="6.3"/><path d="m20 20-4.6-4.6"/>'),
  reset: ui24('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4.5h4.5"/>'),
  folder: ui24(`<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2l2 2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" ${tint}/>`),
};
const SECTION_ICON = { general: 'sliders', display: 'display', editing: 'pencil', newScore: 'new', playback: 'play', recognition: 'scan', files: 'folder', update: 'update', windows: 'windows', android: 'android', web: 'web', device: 'info', advanced: 'settings' };
const ic = name => OWN[name] || icon(name);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cssId = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
const UI_KEY = 'ssnap.settingsUi';

let current = null;
/** Open the settings window (or bring the open one to `sectionId`). */
export function openSettings(app, ui, sectionId = null, opts = {}) {
  if (current) { if (sectionId) current.select(sectionId, { enter: true, ...opts }); return current; }   // on a phone this also leaves the category list
  current = new SettingsWindow(app, ui);
  current.open(sectionId, opts);
  return current;
}
export function closeSettings() { current?.close(); }
export function settingsOpen() { return !!current; }

class SettingsWindow {
  constructor(app, ui) {
    this.app = app; this.ui = ui; this.prefs = app.prefs;
    this.query = ''; this.section = null; this.level = 'nav'; this.backs = { win: null, detail: null, sheet: null };
    this.onSettings = e => this.onSettingsEvent(e.detail || {});
    this.onLayout = () => this.rebuild();
    this.onUpdate = () => this.refreshLive('update');
  }
  get layout() { return document.documentElement.dataset.layout || 'desktop'; }
  get phone() { return this.layout === 'phone'; }
  ctx() { return this.prefs.ctx(); }
  env() {
    return { ...this.prefs.env(false), toast: (m, k, o) => this.ui.toast(m, k, o), confirm: confirmDialog, close: () => this.close(), set: (id, v) => this.prefs.set(id, v), refresh: () => this.renderDetail() };
  }

  // ------------------------------------------------------------------ lifecycle
  open(sectionId, opts = {}) {
    this.restoreFocus = document.activeElement;
    let last = null; try { last = JSON.parse(localStorage.getItem(UI_KEY) || 'null')?.section; } catch { /* ignore */ }
    const secs = visibleSections(this.ctx());
    this.section = secs.find(s => s.id === sectionId)?.id || secs.find(s => s.id === last)?.id || secs[0].id;
    if (sectionId && this.section === sectionId) { try { localStorage.setItem(UI_KEY, JSON.stringify({ section: this.section })); } catch { /* ignore */ } }
    this.root = document.createElement('div'); this.root.className = 'st-overlay';
    document.getElementById('layer').appendChild(this.root);
    modalCount(1);
    this.backs.win = pushBack(() => { this.backs.win = null; this.close(true); });
    this.level = this.phone && !sectionId ? 'nav' : 'detail';
    this.rebuild();
    if (this.phone && this.level === 'detail') this.backs.detail = pushBack(() => { this.backs.detail = null; this.showNav(true); });
    this.app.addEventListener('settings', this.onSettings);
    window.addEventListener('jse-layout', this.onLayout);
    this.ui.updater?.addEventListener?.('status', this.onUpdate);
    this.root.addEventListener('keydown', e => this.onKey(e));
    this.root.addEventListener('pointerdown', e => { if (e.target === this.root && !this.phone) this.close(); });
    if (opts.focusItem) this.flash(opts.focusItem);
    if (!this.phone) this.root.querySelector('.st-cat[aria-selected="true"]')?.focus({ preventScroll: true });
  }
  close(fromBack = false) {
    if (!this.root) return;
    this.closeSheet(true);
    this.app.removeEventListener('settings', this.onSettings);
    window.removeEventListener('jse-layout', this.onLayout);
    this.ui.updater?.removeEventListener?.('status', this.onUpdate);
    this.root.remove(); this.root = null;
    modalCount(-1);
    if (!fromBack) this.backs.win?.release();   // also drops the levels above it
    this.backs = { win: null, detail: null, sheet: null };
    current = null;
    try { this.restoreFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
  /** Build the whole window for the current layout (also after a rotation / window resize crossed a layout border). */
  rebuild() {
    if (!this.root) return;
    const lay = this.layout;
    this.closeSheet(true);
    if (lay !== 'phone') { this.level = 'detail'; if (this.backs.detail) { this.backs.detail.release(); this.backs.detail = null; } }
    this.root.dataset.layout = lay;
    this.root.innerHTML = `
      <div class="st-win" role="dialog" aria-modal="true" aria-labelledby="st-title" data-level="${this.level}">
        <nav class="st-nav" aria-label="설정 분류">
          <div class="st-nav-head"><button type="button" class="st-ibtn st-nav-close" aria-label="닫기">${ic(lay === 'phone' ? 'left' : 'close')}</button><h2 id="st-title">설정</h2></div>
          <div class="st-search">${ic('search')}<input type="search" placeholder="설정 검색" aria-label="설정 검색" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button type="button" class="st-clear" aria-label="검색어 지우기" hidden>${ic('close')}</button></div>
          <div class="st-list" role="tablist" aria-orientation="vertical"></div>
          <div class="st-nav-foot"></div>
        </nav>
        <section class="st-detail" role="tabpanel" aria-labelledby="st-detail-title">
          <header class="st-detail-head">
            <button type="button" class="st-ibtn st-back" aria-label="뒤로">${ic('left')}</button>
            <div class="st-detail-title"><h3 id="st-detail-title"></h3><p></p></div>
            <button type="button" class="btn sm st-reset">${ic('reset')}<span>기본값 복원</span></button>
            <button type="button" class="st-ibtn st-x" aria-label="닫기">${ic('close')}</button>
          </header>
          <div class="st-body" tabindex="-1"></div>
        </section>
      </div>`;
    const $ = s => this.root.querySelector(s);
    this.el = { win: $('.st-win'), list: $('.st-list'), body: $('.st-body'), input: $('.st-search input'), clear: $('.st-clear'), title: $('.st-detail-title h3'), sub: $('.st-detail-title p'), reset: $('.st-reset'), foot: $('.st-nav-foot') };
    this.el.input.value = this.query;
    $('.st-nav-close').addEventListener('click', () => this.close());
    $('.st-x').addEventListener('click', () => this.close());
    $('.st-back').addEventListener('click', () => this.back());
    this.el.reset.addEventListener('click', () => this.resetSection());
    this.el.input.addEventListener('input', () => this.setQuery(this.el.input.value));
    this.el.input.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); this.jumpToFirstResult(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (this.query ? this.el.body.querySelector('button,select,input') : this.el.list.querySelector('.st-cat[aria-selected="true"]') || this.el.list.querySelector('.st-cat'))?.focus(); }
    });
    this.el.clear.addEventListener('click', () => { this.setQuery(''); this.el.input.focus(); });
    this.el.foot.textContent = `JSE v${this.ui.version || ''}`;
    this.renderNav(); this.renderDetail();
  }

  // ------------------------------------------------------------------ navigation
  renderNav() {
    const secs = visibleSections(this.ctx());
    if (!secs.some(s => s.id === this.section)) this.section = secs[0].id;
    this.el.list.innerHTML = secs.map(s => `<button type="button" role="tab" class="st-cat" data-sec="${s.id}" id="st-tab-${s.id}" aria-selected="${!this.query && s.id === this.section}" tabindex="${s.id === this.section ? 0 : -1}">${ic(SECTION_ICON[s.id] || 'settings')}<span class="st-cat-text"><b>${esc(s.label)}</b><small>${esc(s.desc || '')}</small></span><span class="st-chev">${ic('right')}</span></button>`).join('');
    this.el.list.querySelectorAll('.st-cat').forEach(b => {
      b.addEventListener('click', () => { if (this.query) this.setQuery('', false); this.select(b.dataset.sec, { enter: true }); });
      b.addEventListener('keydown', e => this.onCatKey(e, b));
    });
  }
  onCatKey(e, btn) {
    const cats = [...this.el.list.querySelectorAll('.st-cat')]; const i = cats.indexOf(btn);
    let to = null;
    if (e.key === 'ArrowDown') to = cats[Math.min(cats.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') to = i === 0 ? this.el.input : cats[i - 1];
    else if (e.key === 'Home') to = cats[0];
    else if (e.key === 'End') to = cats[cats.length - 1];
    else if (e.key === 'ArrowRight' && !this.phone) { e.preventDefault(); this.focusFirstControl(); return; }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') { this.el.input.focus(); return; }   // type to search
    if (!to) return;
    e.preventDefault(); to.focus();
    if (to.classList?.contains('st-cat') && !this.phone) this.select(to.dataset.sec, { keepFocus: true });   // tabs with automatic activation
  }
  focusFirstControl() { this.el.body.querySelector('button:not([disabled]),select,input')?.focus(); }
  select(id, { enter = false, focusItem = null, keepFocus = false } = {}) {
    const secs = visibleSections(this.ctx()); if (!secs.some(s => s.id === id)) return;
    this.section = id;
    try { localStorage.setItem(UI_KEY, JSON.stringify({ section: id })); } catch { /* ignore */ }
    if (this.query) this.setQuery('', false);
    this.el.list.querySelectorAll('.st-cat').forEach(b => { const onIt = b.dataset.sec === id; b.setAttribute('aria-selected', String(onIt)); b.tabIndex = onIt ? 0 : -1; });
    this.renderDetail();
    if (this.phone && (enter || focusItem) && this.level !== 'detail') {
      this.level = 'detail'; this.el.win.dataset.level = 'detail';
      this.backs.detail = pushBack(() => { this.backs.detail = null; this.showNav(true); });
    }
    this.el.body.scrollTop = 0;
    if (focusItem) this.flash(focusItem);
    else if (!keepFocus && !this.phone && document.activeElement && !this.root.contains(document.activeElement)) this.el.list.querySelector('.st-cat[aria-selected="true"]')?.focus();
  }
  showNav(fromBack = false) {
    if (!fromBack) { this.backs.detail?.release(); this.backs.detail = null; }
    this.level = 'nav'; if (this.el?.win) this.el.win.dataset.level = 'nav';
  }
  /** One level back: choice sheet → page → category list → close. */
  back() {
    if (this.sheet) { this.closeSheet(); return; }
    if (this.phone && this.level === 'detail') { if (this.query) { this.setQuery('', false); } this.showNav(); return; }
    this.close();
  }

  // ------------------------------------------------------------------ search
  setQuery(q, render = true) {
    this.query = q.trim() ? q : '';
    if (this.el.input.value !== q) this.el.input.value = q;
    this.el.clear.hidden = !q;
    this.el.list.querySelectorAll('.st-cat').forEach(b => b.setAttribute('aria-selected', String(!this.query && b.dataset.sec === this.section)));
    if (this.phone) {
      // results are shown as a page of their own
      if (this.query && this.level !== 'detail') { this.level = 'detail'; this.el.win.dataset.level = 'detail'; this.backs.detail = pushBack(() => { this.backs.detail = null; this.setQuery('', false); this.showNav(true); }); }
    }
    if (render) this.renderDetail();
  }
  jumpToFirstResult() {
    if (!this.query) return;
    const r = search(this.query, this.ctx())[0]; if (!r) return;
    this.jumpTo(r.item.id);
  }
  jumpTo(itemId) {
    const it = itemById(itemId); if (!it) return;
    const sec = sectionOf(it, this.ctx());
    if (this.phone && this.level === 'detail' && this.query) { this.query = ''; this.el.input.value = ''; this.el.clear.hidden = true; this.section = sec; this.renderNav(); this.renderDetail(); this.flash(itemId); try { localStorage.setItem(UI_KEY, JSON.stringify({ section: sec })); } catch { /* ignore */ } return; }
    this.select(sec, { focusItem: itemId, enter: true });
  }
  flash(itemId) {
    requestAnimationFrame(() => {
      const row = this.root?.querySelector(`.st-row[data-id="${itemId}"]`); if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.classList.remove('st-flash'); void row.offsetWidth; row.classList.add('st-flash');
      row.querySelector('button,select,input')?.focus({ preventScroll: true });
    });
  }

  // ------------------------------------------------------------------ detail pane
  renderDetail() {
    if (!this.root) return;
    const ctx = this.ctx(), lang = getLang();
    const body = this.el.body;
    if (this.query) {
      const res = search(this.query, ctx, lang);
      const bySec = new Map(); for (const r of res) { if (!bySec.has(r.section)) bySec.set(r.section, []); bySec.get(r.section).push(r.item); }
      const secs = visibleSections(ctx, lang);
      this.el.title.textContent = '검색 결과'; this.el.sub.textContent = res.length ? `${res.length}개 찾음 · Enter를 누르면 첫 항목으로 이동` : '';
      this.el.reset.hidden = true;
      body.innerHTML = res.length
        ? [...bySec.entries()].map(([sid, items]) => { const s = secs.find(x => x.id === sid); return `<div class="st-group"><h4><button type="button" class="st-jump" data-jump="${items[0].id}" title="이 분류로 이동">${ic(SECTION_ICON[sid] || 'settings')}<span>${esc(s?.label || sid)}</span>${ic('right')}</button></h4><div class="st-card">${items.map(it => this.rowHTML(it, ctx, lang, true)).join('')}</div></div>`; }).join('')
        : `<div class="st-empty">${ic('search')}<b>“${esc(this.query)}”에 맞는 설정이 없습니다</b><span>다른 낱말로 찾아 보세요. 예: 테마, 자동 저장, 메트로놈, 용지</span></div>`;
      body.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => this.jumpTo(b.dataset.jump)));
    } else {
      const sec = visibleSections(ctx, lang).find(s => s.id === this.section); if (!sec) return;
      this.el.title.textContent = sec.label; this.el.sub.textContent = sec.desc || '';
      const groups = []; for (const it of sec.items) { const g = groupOf(it, ctx); let grp = groups.find(x => x.name === g); if (!grp) groups.push(grp = { name: g, items: [] }); grp.items.push(it); }
      body.innerHTML = groups.map(g => `<div class="st-group">${g.name ? `<h4>${esc(g.name)}</h4>` : ''}<div class="st-card">${g.items.map(it => this.rowHTML(it, ctx, lang, false)).join('')}</div></div>`).join('');
      this.el.reset.hidden = !sec.items.some(it => it.default !== undefined);
      this.updateResetButton();
    }
    body.querySelectorAll('.st-row').forEach(row => this.bindRow(row));
  }
  updateResetButton() {
    if (!this.el || this.query) return;
    const dirty = visibleItems(this.ctx(), this.section).some(it => !this.prefs.isDefault(it.id)) || (this.section === 'newScore' && !!this.app.settings.newScore?.textStyles);
    this.el.reset.disabled = !dirty;
  }
  selectStyle(it) {
    if (it.swatches) return 'swatch';
    if (this.phone) return 'sheet';
    const len = it.options.reduce((a, o) => a + o.label.length, 0);
    return it.options.length <= 3 || (it.options.length <= 5 && len <= 20) ? 'seg' : 'native';
  }
  fmt(it, v) { const n = Number(v); return `${it.digits ? n.toFixed(it.digits) : n}${it.unit ? (it.unit === '%' ? '%' : ' ' + it.unit) : ''}`; }
  optLabel(it, v) { const o = it.options.find(o => o.value === v) || it.options.find(o => String(o.value) === String(v)); return o ? (getLang() === 'en' && o.en ? o.en : o.label) : String(v ?? ''); }
  rowHTML(it, ctx, lang, inSearch) {
    const id = cssId(it.id), label = labelOf(it, ctx, lang), v = this.prefs.get(it.id);
    const lid = `st-l-${id}`;
    let ctl = '';
    switch (it.type) {
      case 'toggle': ctl = `<button type="button" role="switch" class="st-switch" aria-checked="${!!v}" aria-labelledby="${lid}"><i></i></button>`; break;
      case 'select': {
        const style = this.selectStyle(it);
        if (style === 'swatch') ctl = `<div class="st-swatches" role="radiogroup" aria-labelledby="${lid}">${it.options.map(o => `<button type="button" role="radio" class="st-swatch" aria-checked="${o.value === v}" data-v="${esc(o.value)}" title="${esc(o.label)}" aria-label="${esc(o.label)}" style="--sw:${esc(o.color)}">${ic('check')}</button>`).join('')}</div>`;
        else if (style === 'seg') ctl = `<div class="st-seg" role="radiogroup" aria-labelledby="${lid}">${it.options.map(o => `<button type="button" role="radio" aria-checked="${o.value === v}" tabindex="${o.value === v ? 0 : -1}" data-v="${esc(o.value)}"${o.desc ? ` title="${esc(o.desc)}"` : ''}>${esc(this.optLabel(it, o.value))}</button>`).join('')}</div>`;
        else if (style === 'native') ctl = `<select class="st-select" aria-labelledby="${lid}">${it.options.map(o => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(this.optLabel(it, o.value))}</option>`).join('')}</select>`;
        else ctl = `<button type="button" class="st-value" aria-haspopup="dialog" aria-labelledby="${lid} st-v-${id}"><span id="st-v-${id}">${esc(this.optLabel(it, v))}</span>${ic('right')}</button>`;
        break;
      }
      case 'slider': ctl = `<div class="st-slider"><input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}" aria-labelledby="${lid}"><output>${esc(this.fmt(it, v))}</output></div>`; break;
      case 'color': {
        const custom = !it.options.some(o => o.value === v);
        ctl = `<div class="st-swatches" role="radiogroup" aria-labelledby="${lid}">${it.options.map(o => `<button type="button" role="radio" class="st-swatch" aria-checked="${o.value === v}" data-v="${esc(o.value)}" title="${esc(o.label)}" aria-label="${esc(o.label)}" style="--sw:${esc(o.value)}">${ic('check')}</button>`).join('')}<label class="st-swatch st-custom${custom ? ' on' : ''}" title="직접 고르기" style="--sw:${esc(custom ? v : 'transparent')}"><input type="color" value="${esc(v)}" aria-label="색 직접 고르기">${custom ? ic('check') : ic('plus')}</label></div>`;
        break;
      }
      case 'action': {
        const env = this.env();
        ctl = `<div class="st-actions">${it.actions.filter(a => !a.when || a.when(env)).map(a => `<button type="button" class="btn sm${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}" data-act="${a.id}">${esc(a.label)}</button>`).join('')}</div>`;
        break;
      }
      case 'info': ctl = `<output class="st-info" id="st-v-${id}">…</output>`; break;
    }
    const modified = it.default !== undefined && it.type !== 'action' && !this.prefs.isDefault(it.id);
    return `<div class="st-row${modified ? ' modified' : ''}" data-id="${esc(it.id)}" data-type="${it.type}"${it.type === 'select' ? ` data-style="${this.selectStyle(it)}"` : ''}>
      <div class="st-text"><span class="st-label" id="${lid}"${inSearch && !this.phone ? ' data-jumpable' : ''}>${esc(label)}${modified ? `<button type="button" class="st-row-reset" title="기본값으로 되돌리기" aria-label="${esc(label)} 기본값으로 되돌리기">${ic('reset')}</button>` : ''}</span>${it.desc ? `<p>${esc(it.desc)}</p>` : ''}${it.status ? '<p class="st-status" hidden></p>' : ''}</div>
      <div class="st-ctl">${ctl}</div></div>`;
  }
  bindRow(row) {
    const it = itemById(row.dataset.id); if (!it) return;
    const set = v => this.change(it, v);
    row.querySelector('.st-row-reset')?.addEventListener('click', e => { e.stopPropagation(); set(it.unpack ? it.unpack(it.default) : it.default); });
    // search results (desktop / tablet): the name of a setting leads to its place; on phones the whole row is the control
    row.querySelector('[data-jumpable]')?.addEventListener('click', e => { if (!e.target.closest('button')) { e.stopPropagation(); this.jumpTo(it.id); } });
    switch (it.type) {
      case 'toggle': {
        const sw = row.querySelector('.st-switch');
        const flip = () => set(sw.getAttribute('aria-checked') !== 'true');
        sw.addEventListener('click', e => { e.stopPropagation(); flip(); });
        if (this.phone) row.addEventListener('click', e => { if (!e.target.closest('button')) flip(); });
        break;
      }
      case 'select': case 'color': {
        row.querySelectorAll('[role=radio]').forEach(b => b.addEventListener('click', () => { const o = it.options.find(o => String(o.value) === b.dataset.v); if (o) set(o.value); }));
        row.querySelector('[role=radiogroup]')?.addEventListener('keydown', e => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          const bs = [...row.querySelectorAll('[role=radio]')]; const i = Math.max(0, bs.findIndex(b => b.getAttribute('aria-checked') === 'true'));
          const n = bs[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + bs.length) % bs.length];
          e.preventDefault(); e.stopPropagation(); n.click(); this.root?.querySelector(`.st-row[data-id="${it.id}"] [role=radio][aria-checked="true"]`)?.focus();
        });
        row.querySelector('select')?.addEventListener('change', e => { const o = it.options.find(o => String(o.value) === e.target.value); if (o) set(o.value); });
        const val = row.querySelector('.st-value');
        if (val) { const open = () => this.openSheet(it); val.addEventListener('click', e => { e.stopPropagation(); open(); }); row.addEventListener('click', e => { if (!e.target.closest('button')) open(); }); }
        const col = row.querySelector('input[type=color]');
        if (col) col.addEventListener('change', () => set(col.value));
        break;
      }
      case 'slider': {
        const input = row.querySelector('input'), out = row.querySelector('output');
        input.addEventListener('input', () => { out.textContent = this.fmt(it, input.value); if (!it.lazy) set(Number(input.value)); });
        input.addEventListener('change', () => set(Number(input.value)));
        break;
      }
      case 'action': {
        row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async e => {
          e.stopPropagation();
          const a = it.actions.find(x => x.id === b.dataset.act); if (!a) return;
          b.disabled = true;
          try { await a.run(this.env()); } catch (err) { console.error(err); this.ui.toast(`${labelOf(it, this.ctx())}: ${err?.message || err}`, 'error', { timeout: 5000 }); }
          if (this.root) { b.disabled = false; this.refreshRow(it.id); }
        }));
        break;
      }
      case 'info': {
        const out = row.querySelector('.st-info');
        Promise.resolve().then(() => it.value(this.env())).then(t => { if (out.isConnected) out.textContent = t ?? ''; }).catch(() => { if (out.isConnected) out.textContent = '알 수 없음'; });
        break;
      }
    }
    if (it.status) {
      const st = row.querySelector('.st-status');
      Promise.resolve().then(() => it.status(this.env())).then(t => { if (st.isConnected) { st.textContent = t || ''; st.hidden = !t; } }).catch(() => {});
    }
  }
  change(it, value) {
    const changed = this.prefs.set(it.id, value);
    if (!changed) { this.refreshRow(it.id); return; }
    if (it.restart && this.ui.requestRelaunch) this.ui.toast('앱을 다시 시작하면 적용됩니다', 'info', { timeout: 7000, action: { label: '지금 다시 시작', onClick: () => this.ui.requestRelaunch() } });
    if (it.id === 'penOnly' && value) this.ui.toast('펜 전용 입력을 켰습니다 — 손가락은 화면 이동·확대만 합니다', 'info', { timeout: 4500 });
  }
  /** Re-draw one row in place (value changed, an action ran). Keeps keyboard focus on the same control. */
  refreshRow(id) {
    const row = this.root?.querySelector(`.st-row[data-id="${id}"]`); const it = itemById(id); if (!row || !it) return;
    const active = document.activeElement; const hadFocus = row.contains(active);
    const sel = hadFocus ? (active.matches('[role=radio]') ? '[role=radio][aria-checked="true"]' : active.dataset.act ? `[data-act="${active.dataset.act}"]` : active.className ? '.' + active.className.split(' ')[0] : active.tagName) : null;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.rowHTML(it, this.ctx(), getLang(), !!this.query);
    const fresh = tmp.firstElementChild;
    if (hadFocus && active.matches('input[type=range]')) {   // do not replace a slider that is being dragged
      row.classList.toggle('modified', fresh.classList.contains('modified'));
      const lab = row.querySelector('.st-label'), nlab = fresh.querySelector('.st-label'); lab.innerHTML = nlab.innerHTML;
      lab.querySelector('.st-row-reset')?.addEventListener('click', e => { e.stopPropagation(); this.change(it, it.unpack ? it.unpack(it.default) : it.default); });
      row.querySelector('output').textContent = this.fmt(it, this.prefs.get(it.id));
      if (Number(active.value) !== Number(this.prefs.get(it.id))) active.value = this.prefs.get(it.id);
    } else {
      row.replaceWith(fresh); this.bindRow(fresh);
      if (sel) { try { (fresh.querySelector(sel) || fresh.querySelector('button,select,input'))?.focus({ preventScroll: true }); } catch { /* ignore */ } }
    }
    this.updateResetButton();
  }
  refreshLive(kind) { this.root?.querySelectorAll('.st-row').forEach(r => { if (itemById(r.dataset.id)?.live === kind) this.refreshRow(r.dataset.id); }); }
  onSettingsEvent({ id }) {
    if (!this.root) return;
    if (!id) { this.renderNav(); this.renderDetail(); return; }
    if (id === 'lang') { this.rebuild(); return; }
    this.refreshRow(id);
  }
  async resetSection() {
    const sec = visibleSections(this.ctx()).find(s => s.id === this.section); if (!sec) return;
    const before = JSON.stringify(this.app.settings);
    const changed = this.prefs.reset(this.section);
    if (!changed.length) return;
    this.ui.toast(`‘${sec.label}’ 설정을 기본값으로 되돌렸습니다`, 'ok', { timeout: 6000, action: { label: '되돌리기', onClick: () => { try { this.prefs.importText(before); } catch (e) { console.warn(e); } } } });
  }

  // ------------------------------------------------------------------ bottom sheet for choices (phone)
  openSheet(it) {
    this.closeSheet(true);
    const v = this.prefs.get(it.id), label = labelOf(it, this.ctx());
    const wrap = document.createElement('div'); wrap.className = 'st-sheet-wrap';
    wrap.innerHTML = `<div class="st-sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="st-grabber"></div><h4>${esc(label)}</h4>${it.desc ? `<p>${esc(it.desc)}</p>` : ''}<div class="st-options" role="radiogroup" aria-label="${esc(label)}">${it.options.map(o => `<button type="button" role="radio" aria-checked="${o.value === v}" data-v="${esc(o.value)}"><span><b>${esc(this.optLabel(it, o.value))}</b>${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span>${ic('check')}</button>`).join('')}</div></div>`;
    this.root.appendChild(wrap); this.sheet = wrap;
    wrap.addEventListener('pointerdown', e => { if (e.target === wrap) this.closeSheet(); });
    wrap.querySelectorAll('[role=radio]').forEach(b => b.addEventListener('click', () => { const o = it.options.find(o => String(o.value) === b.dataset.v); this.closeSheet(); if (o) this.change(it, o.value); }));
    this.backs.sheet = pushBack(() => { this.backs.sheet = null; this.closeSheet(true); });
    (wrap.querySelector('[aria-checked="true"]') || wrap.querySelector('[role=radio]'))?.focus({ preventScroll: true });
  }
  closeSheet(fromBack = false) {
    if (!this.sheet) return;
    this.sheet.remove(); this.sheet = null;
    if (!fromBack) this.backs.sheet?.release();
    this.backs.sheet = null;
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (this.sheet) this.closeSheet();
      else if (this.query) { this.setQuery(''); if (this.phone) this.showNav(); else this.el.input.focus(); }
      else this.back();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === ',') { e.preventDefault(); e.stopPropagation(); this.close(); return; }   // (stop: the editor's own Ctrl+, would reopen it)
    if ((mod && e.key.toLowerCase() === 'f') || (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) { e.preventDefault(); if (this.phone && this.level === 'detail' && !this.query) this.showNav(); this.el.input.focus(); this.el.input.select(); return; }
    if (e.key === 'Tab') {   // keep focus inside the window
      const scope = this.sheet || this.el.win;
      const f = [...scope.querySelectorAll('button:not([disabled]):not([tabindex="-1"]),select,input,[tabindex="0"]')].filter(x => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  }
}

// ---------------------------------------------------------------------- Android back key (app shell)
/** Close whatever transient UI is on top (flyout, menu, text popover, dialog, sheet …). True when something was closed. */
function closeTransient(ui) {
  const q = s => document.querySelector(s);
  if (q('#layer .fly-panel')) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (q('#layer .menu')) { ui.hideContextMenu(); return true; }
  if (q('#layer .popover')) { ui.closePopovers(); return true; }
  const dlgs = document.querySelectorAll('#layer .dialog-backdrop');
  if (dlgs.length) { dlgs[dlgs.length - 1].querySelector('header .x')?.click(); return true; }   // a dialog without ✕ must be answered
  const sheet = q('#layer .sheet [data-close]'); if (sheet) { sheet.click(); return true; }
  if (ui.el?.mini && !ui.el.mini.hidden) { ui.hideMini(); return true; }
  if (ui.piano?.visible) { ui.piano.toggle(); ui.updateRail?.(); return true; }
  return false;
}
/**
 * The Android shell hands us its back key (shim: onBackButton). Order: our own pages → other open UI →
 * leave note entry → what the user chose in 설정 › Android 앱 › 뒤로 버튼 동작.
 */
export function bindNativeBack(app, ui) {
  const n = native(); if (typeof n?.onBackButton !== 'function') return false;
  let last = 0;
  n.onBackButton(() => {
    if (goBack()) return;
    if (closeTransient(ui)) return;
    if (app.mode === 'input') { app.setMode('select'); return; }
    const act = app.settings.backAction || 'twice';
    if (act === 'none') return;
    const leave = () => { try { (n.minimizeApp || n.exitApp)?.call(n); } catch { /* ignore */ } };
    if (act === 'exit') { leave(); return; }
    const now = Date.now();
    if (now - last < 2200) { last = 0; leave(); } else { last = now; ui.toast('뒤로를 한 번 더 누르면 앱에서 나갑니다', 'info', { timeout: 2000 }); }
  });
  return true;
}
