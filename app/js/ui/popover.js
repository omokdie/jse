// Lightweight floating UI: toasts, context menu, inline text popovers, mini toolbar.
import { icon } from './icons.js';

export function toast(message, kind = '', { timeout = 2600, action = null } = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div'); el.className = `toast ${kind}`;
  el.innerHTML = `<span>${message}</span>${action ? `<button>${action.label}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { action.onClick(); el.remove(); });
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  if (timeout) setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, timeout);
  return el;
}

let currentMenu = null;
export function hideMenu() { if (currentMenu) { currentMenu.remove(); currentMenu = null; document.removeEventListener('pointerdown', onDocDown, true); } }
function onDocDown(e) { if (currentMenu && !currentMenu.contains(e.target)) hideMenu(); }
/** items: [{label, icon, key, disabled, onClick, sep, header}] */
export function showMenu(x, y, items, { anchorEl = null } = {}) {
  hideMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map(it => it.sep ? '<hr>' : it.header ? `<div class="mh">${it.header}</div>` : `<button role="menuitem" ${it.disabled ? 'disabled' : ''}>${it.icon ? icon(it.icon) : '<span style="width:16px"></span>'}<span>${it.label}</span>${it.key ? `<span class="k">${it.key}</span>` : ''}</button>`).join('');
  document.getElementById('layer').appendChild(m);
  let bi = 0;
  m.querySelectorAll('button').forEach(b => { const it = items.filter(i => !i.sep && !i.header)[bi++]; b.addEventListener('click', () => { hideMenu(); it.onClick?.(); }); });
  // position within viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  if (anchorEl) { const r = anchorEl.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  m.style.left = '0px'; m.style.top = '0px';
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, vw - w - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, vh - h - 4)) + 'px';
  currentMenu = m;
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  return m;
}

let currentPopover = null;
export function closePopover(commit = false) {
  if (!currentPopover) return;
  const p = currentPopover; currentPopover = null;
  if (commit) p._commit?.(); else p._cancel?.();
  p.remove();
}
/**
 * Inline text popover anchored near a client rect.
 * opts: { value, placeholder, hint, onCommit(value, how), onCancel, onNavigate(dir) (Space/Tab/hyphen advancing), multiline }
 */
export function showTextPopover(rect, opts) {
  closePopover(false);
  const p = document.createElement('div'); p.className = 'popover';
  p.innerHTML = `<input type="text" value="" enterkeyhint="next" placeholder="${opts.placeholder || ''}" aria-label="${opts.placeholder || ''}" autocomplete="off" autocapitalize="off" spellcheck="false">${opts.hint ? `<span class="hint">${opts.hint}</span>` : ''}<button class="btn primary" title="확인 (Enter)">${icon('check')}</button><button class="btn" title="닫기 (Esc)">${icon('close')}</button>`;
  document.getElementById('layer').appendChild(p);
  const input = p.querySelector('input'); input.value = opts.value || '';
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = p.offsetWidth, h = p.offsetHeight;
  let x = rect ? rect.left : vw / 2 - w / 2, y = rect ? rect.bottom + 8 : vh / 2;
  if (y + h > vh - 8) y = (rect ? rect.top : vh / 2) - h - 8;
  p.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px'; p.style.top = Math.max(8, y) + 'px';
  let done = false;
  const finish = (how) => { if (done) return; done = true; const v = input.value.trim(); currentPopover = null; p.remove(); opts.onCommit?.(v, how); };
  p._commit = () => finish('enter'); p._cancel = () => { if (!done) { done = true; opts.onCancel?.(); } };
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;   // let Hangul IME finish composing
    if (e.key === 'Enter') { e.preventDefault(); finish('enter'); }
    else if (e.key === 'Escape') { e.preventDefault(); closePopover(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(e.shiftKey ? 'prev' : 'tab'); }
    else if (opts.advanceOnSpace && e.key === ' ' && !e.shiftKey) { e.preventDefault(); finish('next'); }
    else if (opts.advanceOnHyphen && e.key === '-' && !e.shiftKey && input.value) { e.preventDefault(); finish('hyphen'); }
    else if (opts.advanceOnHyphen && e.key === '_' && input.value) { e.preventDefault(); finish('extend'); }
    else if (opts.advanceOnSpace && e.key === 'ArrowLeft' && input.selectionStart === 0 && !input.value) { e.preventDefault(); finish('prev'); }
    e.stopPropagation();
  });
  input.addEventListener('keyup', e => e.stopPropagation());
  // IME (Hangul) safety: a space/hyphen typed right after composition arrives as an input event
  input.addEventListener('input', e => {
    if (e.isComposing) return;
    const v = input.value;
    if (opts.advanceOnSpace && v.endsWith(' ') && v.trim()) { input.value = v.trimEnd(); finish('next'); }
    else if (opts.advanceOnHyphen && v.length > 1 && v.endsWith('-')) { input.value = v.slice(0, -1); finish('hyphen'); }
  });
  p.querySelector('.btn.primary').addEventListener('click', () => finish('enter'));
  p.querySelector('.btn:not(.primary)').addEventListener('click', () => closePopover(false));
  input.focus(); input.select();
  currentPopover = p;
  return p;
}

/** Mini toolbar for touch: shows actions above a note. */
export function showMiniToolbar(host, rect, actions) {
  host.innerHTML = actions.map((a, i) => `<button data-i="${i}" title="${a.label}">${icon(a.icon)}<span>${a.label}</span></button>`).join('');
  host.hidden = false;
  host.querySelectorAll('button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); actions[+b.dataset.i].onClick(); }));
  const main = host.parentElement.getBoundingClientRect();
  const w = host.offsetWidth, h = host.offsetHeight;
  let x = rect.left + rect.width / 2 - w / 2 - main.left, y = rect.top - h - 12 - main.top;
  if (y < 4) y = rect.bottom + 12 - main.top;
  host.style.left = Math.max(4, Math.min(x, main.width - w - 4)) + 'px'; host.style.top = Math.max(4, y) + 'px';
}
export function hideMiniToolbar(host) { host.hidden = true; }

/** Bottom sheet (mobile). Returns the sheet element; closes on backdrop tap. */
export function showSheet(title, bodyHtml, onOpen) {
  const back = document.createElement('div'); back.className = 'sheet-backdrop';
  const sheet = document.createElement('div'); sheet.className = 'sheet';
  sheet.innerHTML = `<div class="grabber"></div><div class="panel-head"><span>${title}</span><button class="btn sm" data-close>${icon('close')}</button></div><div class="sheet-body">${bodyHtml}</div>`;
  const layer = document.getElementById('layer'); layer.appendChild(back); layer.appendChild(sheet);
  const close = () => { back.remove(); sheet.remove(); };
  back.addEventListener('pointerdown', close); sheet.querySelector('[data-close]').addEventListener('click', close);
  onOpen?.(sheet, close);
  return { sheet, close };
}
