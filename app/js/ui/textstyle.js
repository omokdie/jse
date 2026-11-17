// "글꼴" — font family / size / bold / italic of the score's texts:
//   textStylesDialog()    the dialog (one row per kind of text, live preview on the score, one undo step)
//   openFontPicker()      searchable font list: 기본 / 이 기기의 글꼴 / JSE 글꼴 (downloaded on demand)
//   textStyleSectionHTML() + bindTextStyleSection()   the inspector section of a selected title / lyric / chord / text
//   initScoreFonts()      loads the JSE fonts a score uses and re-lays it out when they arrive
import {
  TEXT_STYLE_KEYS, TEXT_STYLE_DEFAULTS, resolveTextStyle, resolveTextObjectStyle, autoEmphasis,
  normalizeTextStyles, normalizeTextFont, applyTextStyles, textStylesEqual, ptToSp, spToPt, clampTextSize, cssFontFamily, fontNeeds,
} from '../model/textstyles.js';
import {
  JSE_FONTS, FONT_CATEGORY_LABELS, jseFont, fontDisplayName, fontState, jseDownloadSize, loadFont, ensureFonts, fontEvents,
  refreshFontCacheIndex, knownDeviceFonts, canQueryLocalFonts, queryDeviceFonts, deviceFontsListed, localFontAccess, isFontInstalled, fontFailed, formatBytes,
} from '../fonts.js';
import { clearTextWidthCache, escapeXml } from '../engrave/text.js';
import { findEvent } from '../model/score.js';
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { toast } from './popover.js';
import { PAGES_BASE_URL } from '../config.js';

export const TEXT_STYLE_LABELS = {
  title: '제목', subtitle: '부제', composer: '작곡가·편곡자', lyricist: '작사가', lyrics: '가사', chord: '코드',
  text: '일반 글자', tempo: '빠르기', rehearsal: '리허설 마크', partName: '악기 이름', measureNumber: '마디 번호',
};
const HINTS = { text: '나타냄말·연주법', tempo: '빠르기말·♩=120', partName: '단 왼쪽', rehearsal: 'A · B · C' };
const PRESETS_PT = [6, 7, 8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 60, 72];
const PT_MIN = 3, PT_MAX = 144;
const CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const fmtPt = pt => String(Math.round(pt * 10) / 10);
const esc = escapeXml;

/** Which text style a hit / selection reference belongs to ('title', 'lyrics', …) — null when it has none. */
export function styleKeyOfRef(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return TEXT_STYLE_KEYS.includes(ref) ? ref : null;
  if (ref.field) return { title: 'title', subtitle: 'subtitle', composer: 'composer', arranger: 'composer', lyricist: 'lyricist' }[ref.field] || null;
  return { lyric: 'lyrics', chord: 'chord', mtext: 'text', text: 'text', tempo: 'tempo', rehearsal: 'rehearsal' }[ref.kind] || null;
}
/** The free text object ( measure.texts[i] / event.texts[i] ) a selection reference points at, or null. */
export function textObjectOfRef(score, ref) {
  if (!ref) return null;
  if (ref.kind === 'mtext') { const m = score.measures.find(x => x.id === ref.measureId); const t = m?.texts?.[ref.index ?? 0]; return t ? { t, measureLevel: true } : null; }
  if (ref.kind === 'text') { const f = findEvent(score, ref.eventId); const t = f?.ev.texts?.[ref.index ?? 0]; return t ? { t, measureLevel: false } : null; }
  return null;
}
const sameRef = (a, b) => (a.field || b.field ? a.field === b.field : a.kind === b.kind && a.measureId === b.measureId && a.eventId === b.eventId && a.chordId === b.chordId && (a.verse ?? 0) === (b.verse ?? 0) && (a.index ?? 0) === (b.index ?? 0));
/** After a re-layout the selected text has a new box: point the selection at it again. */
export function refreshTextSelection(app) {
  const sel = app.selection; if (sel?.type !== 'text' || !sel.ref || !app.layout) return;
  for (const p of app.layout.pages) { const hit = (p.geometry.texts || []).find(t => sameRef(t, sel.ref)); if (hit) { app.select({ type: 'text', ref: hit }); return; } }
}

// ---------------------------------------------------------------------------------------------
// the controls of one style: [font ▾] [− 10.4 pt + ▾] [가 가]
/** `st` = resolved { family, size, bold, italic }. */
export function styleControlsHTML(st, spMm) {
  const state = st.family ? fontState(st.family, [st.bold ? 700 : 400]) : 'device';
  const face = st.family && (state === 'ready' || state === 'device') ? ` style="font-family:${cssFontFamily(st.family)},var(--font)"` : '';
  let note = '', noteCls = '';
  if (st.family && state === 'device' && !isFontInstalled(st.family)) { note = '이 기기에 없음'; noteCls = ' warn'; }
  else if (state === 'remote' && fontFailed(st.family)) { note = '받지 못함'; noteCls = ' warn'; }
  else if (state === 'loading' || state === 'remote' || state === 'cached') note = '받는 중…';
  return `<button type="button" class="ts-font" data-ts="font" title="글꼴 종류 고르기" aria-haspopup="listbox"><span class="ts-font-name"${face}>${esc(fontDisplayName(st.family))}</span><span class="ts-font-note${noteCls}">${note}</span>${CARET}<span class="ts-bar"></span></button>`
    + `<div class="ts-size"><button type="button" data-ts="dec" title="작게" aria-label="글자 작게">${icon('minus')}</button>`
    + `<span class="ts-preset" title="크기 고르기">${CARET}<select data-ts="preset" aria-label="글자 크기 고르기"><option value="" selected disabled hidden></option>${PRESETS_PT.map(p => `<option value="${p}">${p} pt</option>`).join('')}</select></span>`
    + `<label class="ts-pt"><input type="text" inputmode="decimal" data-ts="size" value="${fmtPt(spToPt(st.size, spMm))}" aria-label="글자 크기 (pt)" autocomplete="off" enterkeyhint="done"><span>pt</span></label>`
    + `<button type="button" data-ts="inc" title="크게" aria-label="글자 크게">${icon('plus')}</button></div>`
    + `<div class="ts-emph"><button type="button" data-ts="bold" class="${st.bold ? 'on' : ''}" aria-pressed="${!!st.bold}" title="굵게" aria-label="굵게"><b>가</b></button><button type="button" data-ts="italic" class="${st.italic ? 'on' : ''}" aria-pressed="${!!st.italic}" title="기울임" aria-label="기울임"><i>가</i></button></div>`;
}
/**
 * One delegated listener set for every `.ts-ctl` inside `root`.
 * apiOf(ctlEl) → { get(): resolved style, set(field, value), spMm } | null
 */
export function bindStyleControls(root, apiOf) {
  const stepPt = (pt, dir) => {   // 0.5 pt steps below 20 pt, 1 pt above
    const step = pt >= 20 ? 1 : 0.5;
    const next = dir > 0 ? Math.floor(pt / step + 1e-6) * step + step : Math.ceil(pt / step - 1e-6) * step - step;
    return Math.min(PT_MAX, Math.max(PT_MIN, Math.round(next * 100) / 100));
  };
  const setPt = (api, pt) => { if (!Number.isFinite(pt)) return; api.set('size', clampTextSize(ptToSp(Math.min(PT_MAX, Math.max(PT_MIN, pt)), api.spMm))); };
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-ts]'); if (!b || !root.contains(b) || b.tagName !== 'BUTTON') return;
    const api = apiOf(b.closest('.ts-ctl')); if (!api) return;
    const st = api.get();
    switch (b.dataset.ts) {
      case 'font': openFontPicker(b, { current: st.family, weights: [st.bold ? 700 : 400], onPick: family => api.set('family', family) }); break;
      case 'dec': setPt(api, stepPt(spToPt(st.size, api.spMm), -1)); break;
      case 'inc': setPt(api, stepPt(spToPt(st.size, api.spMm), 1)); break;
      case 'bold': api.set('bold', !st.bold); break;
      case 'italic': api.set('italic', !st.italic); break;
    }
  });
  root.addEventListener('change', e => {
    const el = e.target.closest('[data-ts]'); if (!el || !root.contains(el)) return;
    const api = apiOf(el.closest('.ts-ctl')); if (!api) return;
    if (el.dataset.ts === 'preset' && el.value) setPt(api, +el.value);
    else if (el.dataset.ts === 'size') { const v = parseFloat(String(el.value).replace(',', '.')); if (Number.isFinite(v)) setPt(api, v); else el.value = fmtPt(spToPt(api.get().size, api.spMm)); }
  });
  root.addEventListener('keydown', e => {
    const el = e.target.closest?.('[data-ts=size]'); if (!el) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); el.blur(); }          // commit, do not close the dialog
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const api = apiOf(el.closest('.ts-ctl')); if (!api) return; e.preventDefault(); setPt(api, stepPt(spToPt(api.get().size, api.spMm), e.key === 'ArrowUp' ? 1 : -1)); }
  });
  root.addEventListener('focusin', e => { if (e.target.matches?.('[data-ts=size]')) e.target.select?.(); });
}
/** New value of one kind's stored style after `field` := `value` (fields equal to the built-in look are dropped). */
function withField(stored, key, field, value, spMm) {
  const cur = { ...(stored || {}) }, d = TEXT_STYLE_DEFAULTS[key];
  if (field === 'family') { if (value) cur.family = value; else delete cur.family; }
  else if (field === 'size') { if (Math.abs(spToPt(value, spMm) - spToPt(d.size, spMm)) < 0.05) delete cur.size; else cur.size = value; }
  else if (value === d[field]) delete cur[field]; else cur[field] = value;   // (`text`: off = automatic — expression stays italic …)
  return Object.keys(cur).length ? cur : null;
}

// ---------------------------------------------------------------------------------------------
// font picker
let closePicker = null;
/** Searchable font list anchored to `anchor`. onPick(family) — '' = 기본. */
export function openFontPicker(anchor, { current = '', weights = [400], onPick }) {
  closePicker?.();
  const layer = document.getElementById('layer');
  const catcher = document.createElement('div'); catcher.className = 'ts-picker-catch';
  const box = document.createElement('div'); box.className = 'ts-picker'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', '글꼴 고르기');
  box.innerHTML = '<div class="ts-picker-head"><input type="search" placeholder="글꼴 찾기" aria-label="글꼴 찾기" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button type="button" aria-label="닫기">×</button></div><div class="ts-picker-list" role="listbox"></div>';
  layer.appendChild(catcher); layer.appendChild(box);
  const input = box.querySelector('input'), list = box.querySelector('.ts-picker-list');
  const uiFont = getComputedStyle(document.body).fontFamily;
  let kb = -1, note = '';
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) { const n = en.target; n.style.fontFamily = `${cssFontFamily(n.dataset.face)},${uiFont}`; io.unobserve(n); }
  }, { root: list, rootMargin: '120px' }) : null;
  const stateHTML = (f) => {
    const st = fontState(f.family, weights);
    if (st === 'ready') return `<span class="ts-opt-state ok">${icon('check')}</span>`;
    if (st === 'loading') return '<span class="ts-opt-state">받는 중…</span>';
    if (st === 'cached') return '<span class="ts-opt-state ok">받음</span>';
    return `<span class="ts-opt-state get">${icon('download')}${formatBytes(jseDownloadSize(f.family, weights) || Object.values(f.files)[0].bytes)}</span>`;
  };
  const opt = (family, name, sub, state = '', ownFace = true) => `<button type="button" class="ts-opt${family.toLowerCase() === String(current || '').toLowerCase() ? ' on' : ''}" role="option" data-family="${esc(family)}"><span class="ts-opt-name"${ownFace && family ? ` data-face="${esc(family)}"` : ''}>${esc(name)}</span><span class="ts-opt-sub">${esc(sub)}</span>${state}</button>`;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const hit = (...names) => !q || names.some(n => String(n || '').toLowerCase().includes(q));
    let html = '';
    if (hit('기본', 'default', '기본 글꼴')) html += `<div class="ts-group">기본</div>${opt('', '기본 글꼴', '기기에 있는 고딕체 (Noto Sans KR · 맑은 고딕 …)')}`;
    const device = knownDeviceFonts();
    const known = new Set(['', ...device.map(d => d.family.toLowerCase()), ...JSE_FONTS.map(f => f.family.toLowerCase())]);
    if (current && !known.has(current.toLowerCase()) && hit(current)) html += `<div class="ts-group">이 악보의 글꼴</div>${opt(current, current, isFontInstalled(current) ? '' : '이 기기에 없어 기본 글꼴로 보입니다')}`;
    const dev = device.filter(d => hit(d.family, d.ko));
    const more = canQueryLocalFonts() && !deviceFontsListed();
    if (dev.length || (more && !q)) {
      html += `<div class="ts-group">이 기기의 글꼴<small>${device.length}개</small></div>${dev.map(d => opt(d.family, d.ko || d.family, d.ko && d.ko !== d.family ? d.family : '')).join('')}`;
      if (more && !q) html += '<button type="button" class="ts-opt ts-more" data-more="1"><span class="ts-opt-name">이 기기의 모든 글꼴 보기…</span><span class="ts-opt-sub"></span></button>';
    }
    const jse = JSE_FONTS.filter(f => hit(f.family, f.ko, FONT_CATEGORY_LABELS[f.category]));
    if (jse.length) html += `<div class="ts-group">JSE 글꼴<small>어느 기기에서나 같은 모양 · 처음 쓸 때 내려받기</small></div>${jse.map(f => opt(f.family, f.ko, `${f.family} · ${FONT_CATEGORY_LABELS[f.category] || ''}`, stateHTML(f), fontState(f.family) === 'ready')).join('')}`;
    if (note) html += `<div class="ts-empty">${note}</div>`;
    list.innerHTML = html || '<div class="ts-empty">찾는 글꼴이 없습니다.</div>';
    kb = -1;
    if (io) list.querySelectorAll('[data-face]').forEach(n => io.observe(n)); else list.querySelectorAll('[data-face]').forEach(n => { n.style.fontFamily = `${cssFontFamily(n.dataset.face)},${uiFont}`; });
  };
  const close = () => {
    if (closePicker !== close) return;
    closePicker = null; io?.disconnect(); fontEvents.removeEventListener('loaded', onFont); fontEvents.removeEventListener('error', onFont);
    catcher.remove(); box.remove(); if (anchor.isConnected) anchor.focus?.({ preventScroll: true });
  };
  const onFont = () => { if (box.isConnected) { const top = list.scrollTop; render(); list.scrollTop = top; } };
  const all = async () => {
    const got = await queryDeviceFonts();
    if (!got) note = '설치된 글꼴 목록을 읽을 수 없습니다 (브라우저가 허용하지 않음). 위 목록의 글꼴은 그대로 쓸 수 있습니다.';
    if (box.isConnected) render();
  };
  list.addEventListener('click', e => {
    const b = e.target.closest('.ts-opt'); if (!b) return;
    if (b.dataset.more) { all(); return; }
    const family = b.dataset.family; close(); onPick(family);
  });
  box.querySelector('.ts-picker-head button').addEventListener('click', close);
  catcher.addEventListener('pointerdown', e => { e.preventDefault(); close(); });
  input.addEventListener('input', render);
  box.addEventListener('keydown', e => {
    e.stopPropagation();   // the dialog underneath must not see Enter / Escape
    const opts = [...list.querySelectorAll('.ts-opt')];
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!opts.length) return; opts[kb]?.classList.remove('kb'); kb = (kb + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; opts[kb].classList.add('kb'); opts[kb].scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); (opts[kb] || (opts.length === 1 ? opts[0] : null))?.click(); }
  });
  // place: below the button, above it when there is no room (phones: CSS turns it into a bottom sheet)
  const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(r.width, 340), vw - 16);
  const below = vh - r.bottom - 14, above = r.top - 14, under = below >= 260 || below >= above;
  box.style.width = `${w}px`; box.style.maxHeight = `${Math.max(180, Math.min(460, under ? below : above))}px`;
  box.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
  if (under) box.style.top = `${r.bottom + 6}px`; else { box.style.top = 'auto'; box.style.bottom = `${vh - r.top + 6}px`; }   // above: grows upward from the button
  closePicker = close;
  fontEvents.addEventListener('loaded', onFont); fontEvents.addEventListener('error', onFont);
  render();
  list.querySelector('.ts-opt.on')?.scrollIntoView({ block: 'center' });
  if (!document.documentElement.classList.contains('touch')) input.focus();
  // fonts already on this device show in their own face; the stored index tells which ones are
  refreshFontCacheIndex().then(() => { if (!box.isConnected) return; render(); for (const f of JSE_FONTS) if (fontState(f.family) === 'cached') loadFont(f.family, [400]); });
  if (canQueryLocalFonts() && !deviceFontsListed()) localFontAccess().then(s => { if (s === 'granted' && box.isConnected) all(); });
  return close;
}

// ---------------------------------------------------------------------------------------------
// dialog
let dialogOpenNow = false;
/**
 * The 글꼴 dialog. `focus`: a style key ('lyrics') or a text reference from a hit / selection → that row is highlighted.
 * Changes show on the score at once; 확인 makes them ONE undo step, 취소 puts everything back.
 */
export async function textStylesDialog(app, ui, focus = null) {
  if (!app.score || dialogOpenNow) return false;
  dialogOpenNow = true;
  const score = app.score, spMm = score.settings.staffSpaceMm || 1.75;
  const focusKey = styleKeyOfRef(focus);
  const original = normalizeTextStyles(score.settings.textStyles);
  const working = JSON.parse(JSON.stringify(original || {}));
  let timer = null, previewed = false, listEl = null, undock = null;
  const view = key => resolveTextStyle({ textStyles: working }, key);
  const rowInner = key => `<div class="ts-name"><b>${TEXT_STYLE_LABELS[key]}</b>${HINTS[key] ? `<small>${HINTS[key]}</small>` : ''}</div><div class="ts-ctl">${styleControlsHTML(view(key), spMm)}</div>`;
  const renderRow = key => {
    const row = listEl?.querySelector(`[data-key="${key}"]`); if (!row) return;
    const act = row.contains(document.activeElement) ? document.activeElement.dataset.ts : null;   // keep the keyboard focus where it was
    row.innerHTML = rowInner(key);
    if (act) row.querySelector(`[data-ts="${act}"]`)?.focus({ preventScroll: true });
  };
  const jseRows = () => TEXT_STYLE_KEYS.forEach(k => { if (jseFont(view(k).family)) renderRow(k); });
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (app.score !== score) return; applyTextStyles(score, working); previewed = true; app.relayout(); ensureFonts(fontNeeds(score)).then(jseRows); }, 60);
  };
  const set = (key, field, value) => {
    const next = withField(working[key], key, field, value, spMm);
    if (next) working[key] = next; else delete working[key];
    renderRow(key); preview();
    const st = view(key);
    if (field === 'family' && jseFont(st.family)) {     // a font picked by hand: fetch it now, say so when that fails
      loadFont(st.family, [st.bold ? 700 : 400], { force: true }).then(res => {
        if (!res.ok) toast(globalThis.JSE_PREVIEW   // the preview page may not fetch from other sites
          ? `미리보기 화면에서는 JSE 글꼴을 내려받을 수 없어요. 설치한 앱이나 웹앱 ${PAGES_BASE_URL} 에서 쓸 수 있습니다.`
          : `${fontDisplayName(st.family)} 글꼴을 내려받지 못했습니다. 인터넷 연결을 확인하세요 — 그동안은 기본 글꼴로 보입니다.`, 'warn', { timeout: 5600 });
        jseRows();
      });
    }
  };
  const onProgress = e => {
    const { family, loaded, total } = e.detail || {}; if (!listEl || !total) return;
    for (const key of TEXT_STYLE_KEYS) if (view(key).family === family) {
      const row = listEl.querySelector(`[data-key="${key}"]`);
      const bar = row?.querySelector('.ts-bar'), noteEl = row?.querySelector('.ts-font-note');
      if (bar) bar.style.width = `${Math.min(100, Math.round(loaded / total * 100))}%`;
      if (noteEl) { noteEl.className = 'ts-font-note'; noteEl.textContent = `받는 중 ${Math.min(99, Math.round(loaded / total * 100))}%`; }
    }
  };
  const onLoaded = () => jseRows();
  const body = `<p class="ts-intro">바꾸면 악보에 바로 보입니다. 크기는 pt이며, 오선 크기를 바꾸면 글자도 함께 커지고 작아집니다.</p>
    <div class="ts-list">${TEXT_STYLE_KEYS.map(key => `<div class="ts-row${key === focusKey ? ' focus' : ''}" data-key="${key}">${rowInner(key)}</div>`).join('')}</div>
    <div class="ts-actions"><button type="button" class="btn sm" data-a="reset">${icon('refresh')} 기본값으로</button><span class="ts-spacer"></span><button type="button" class="btn sm" data-a="default">${icon('save')} 새 악보 기본값으로 저장</button></div>`;
  let result = null;
  try {
    result = await showDialog({
      title: '글꼴', body, closable: false,
      buttons: [{ label: '취소', value: null }, { label: '확인', value: true, primary: true }],
      onOpen: (back, close) => {
        back.classList.add('ts-back');
        const dlg = back.querySelector('.dialog'); dlg.classList.add('ts-dialog');
        dlg.querySelector('header').insertAdjacentHTML('beforeend', '<button type="button" class="x" aria-label="닫기">×</button>');
        dlg.querySelector('header .x').addEventListener('click', () => close(null));
        back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
        // Enter on one of our buttons presses that button — it must not "confirm" the whole dialog
        dlg.querySelector('.content').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('button,select')) e.stopPropagation(); });
        listEl = back.querySelector('.ts-list');
        bindStyleControls(listEl, ctl => { const key = ctl?.closest('[data-key]')?.dataset.key; return key ? { get: () => view(key), set: (f, v) => set(key, f, v), spMm } : null; });
        back.querySelector('[data-a=reset]').addEventListener('click', () => { for (const k of Object.keys(working)) delete working[k]; TEXT_STYLE_KEYS.forEach(renderRow); preview(); });
        back.querySelector('[data-a=default]').addEventListener('click', () => {
          // sizes are stored in staff spaces: convert so that a new score (its own staff size) shows the same pt
          const nsMm = app.settings.newScore?.staffSpaceMm || 1.75, conv = JSON.parse(JSON.stringify(working));
          if (Math.abs(nsMm - spMm) > 1e-6) for (const k of Object.keys(conv)) if (conv[k].size != null) conv[k].size = clampTextSize(ptToSp(spToPt(conv[k].size, spMm), nsMm));
          const clean = normalizeTextStyles(conv);
          const ns = { ...(app.settings.newScore || {}) }; if (clean) ns.textStyles = clean; else delete ns.textStyles;
          app.settings.newScore = ns; app.saveSettings();
          toast(clean ? '새로 만드는 악보에 이 글꼴을 씁니다' : '새로 만드는 악보는 기본 글꼴을 씁니다', 'ok');
        });
        // the backdrop is see-through so the score shows the changes; let it still be scrolled / dragged there
        const scroller = ui?.view?.container; let drag = null;
        back.addEventListener('wheel', e => { if (e.target === back && scroller) scroller.scrollBy(e.deltaX, e.deltaY); }, { passive: true });
        back.addEventListener('pointerdown', e => { if (e.target !== back) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { back.setPointerCapture(e.pointerId); } catch { /* not capturable */ } });
        back.addEventListener('pointermove', e => { if (!drag || e.pointerId !== drag.id || !scroller) return; scroller.scrollBy(drag.x - e.clientX, drag.y - e.clientY); drag.x = e.clientX; drag.y = e.clientY; });
        const end = e => { if (drag && e.pointerId === drag.id) drag = null; };
        back.addEventListener('pointerup', end); back.addEventListener('pointercancel', end);
        fontEvents.addEventListener('progress', onProgress); fontEvents.addEventListener('loaded', onLoaded);
        // wide screens: make room beside the panel so the whole page stays in view (the score view re-fits itself)
        const bodyEl = ui?.el?.body, cl = document.documentElement.classList;
        if (bodyEl && window.innerWidth >= 1120 && !cl.contains('phone') && !(cl.contains('tablet') && cl.contains('portrait'))) {
          const hadRight = !bodyEl.classList.contains('hide-right');
          bodyEl.classList.add('ts-docked', 'hide-right'); ui.updateRail?.();
          undock = () => { bodyEl.classList.remove('ts-docked'); if (hadRight) bodyEl.classList.remove('hide-right'); ui.renderPanels?.(); ui.updateRail?.(); };
        }
        if (focusKey) requestAnimationFrame(() => listEl.querySelector('.ts-row.focus')?.scrollIntoView({ block: 'center' }));
        refreshFontCacheIndex();
      },
    });
  } finally {
    clearTimeout(timer); closePicker?.(); dialogOpenNow = false; undock?.();
    fontEvents.removeEventListener('progress', onProgress); fontEvents.removeEventListener('loaded', onLoaded);
  }
  if (app.score !== score) return false;
  applyTextStyles(score, original);                      // back to the state before the dialog …
  const changed = !!result && !textStylesEqual(original, working);
  if (changed) { app.exec('글꼴', s => { applyTextStyles(s, working); }, { select: app.selection }); refreshTextSelection(app); }   // … then one undoable edit
  else if (previewed) { app.relayout(); refreshTextSelection(app); }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// inspector section (a title / lyric / chord / text is selected)
const APPLIES = { title: '제목에 적용', subtitle: '부제에 적용', composer: '작곡가·편곡자에 적용', lyricist: '작사가에 적용', lyrics: '모든 가사에 적용', chord: '모든 코드에 적용', text: '모든 일반 글자에 적용', tempo: '모든 빠르기 표시에 적용', rehearsal: '모든 리허설 마크에 적용' };
export function textStyleSectionHTML(app, sel) {
  const key = styleKeyOfRef(sel?.ref); if (!key) return '';
  const settings = app.score.settings, spMm = settings.staffSpaceMm || 1.75;
  let h = `<div class="insp-section ts-insp"><h4>글꼴<span class="chip">${APPLIES[key] || ''}</span></h4><div class="ts-ctl" data-scope="kind">${styleControlsHTML(resolveTextStyle(settings, key), spMm)}</div>`;
  const obj = textObjectOfRef(app.score, sel.ref);
  if (obj) {
    const own = resolveTextObjectStyle(settings, obj.t, autoEmphasis(obj.t, obj));
    h += `<div class="ts-own${own.own ? '' : ' off'}"><h4>이 글자만${own.own ? '<button type="button" class="btn sm" data-ts-act="clearOwn">따로 정한 것 지우기</button>' : '<span class="chip">전체 설정을 따름</span>'}</h4><div class="ts-ctl" data-scope="own">${styleControlsHTML(own, spMm)}</div></div>`;
  }
  h += `<div class="btn-row"><button type="button" class="btn sm" data-ts-act="dialog">${icon('font')} 글꼴 전체 설정…</button></div></div>`;
  return h;
}
export function bindTextStyleSection(el, app, ui, sel) {
  const root = el.querySelector('.ts-insp'); if (!root) return;
  const key = styleKeyOfRef(sel.ref), ref = sel.ref;
  const spMm = app.score.settings.staffSpaceMm || 1.75;
  const commit = (label, fn) => { app.exec(label, fn, { select: app.selection }); refreshTextSelection(app); };
  const kindApi = {
    spMm, get: () => resolveTextStyle(app.score.settings, key),
    set: (field, value) => { if (field === 'family' && jseFont(value)) loadFont(value, [400], { force: true }); commit('글꼴', s => { const all = { ...(normalizeTextStyles(s.settings.textStyles) || {}) }; const next = withField(all[key], key, field, value, spMm); if (next) all[key] = next; else delete all[key]; applyTextStyles(s, all); }); },
  };
  const ownApi = {
    spMm, get: () => { const o = textObjectOfRef(app.score, ref); return o ? resolveTextObjectStyle(app.score.settings, o.t, autoEmphasis(o.t, o)) : resolveTextStyle(app.score.settings, 'text'); },
    set: (field, value) => { if (field === 'family' && jseFont(value)) loadFont(value, [400], { force: true }); commit('글자 글꼴', s => {
      const o = textObjectOfRef(s, ref); if (!o) return;
      const base = resolveTextStyle(s.settings, 'text'), font = { ...(o.t.font || {}) };
      if (field === 'family') { if (value && value !== base.family) font.family = value; else delete font.family; }
      else if (field === 'size') { if (Math.abs(spToPt(value, spMm) - spToPt(base.size, spMm)) < 0.05) delete font.size; else font.size = value; }
      else font[field] = !!value;
      const clean = normalizeTextFont(font); if (clean) o.t.font = clean; else delete o.t.font;
    }); },
  };
  bindStyleControls(root, ctl => (ctl?.dataset.scope === 'own' ? ownApi : ctl?.dataset.scope === 'kind' ? kindApi : null));
  root.querySelectorAll('[data-ts-act]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tsAct === 'dialog') ui.textStyles ? ui.textStyles(key) : textStylesDialog(app, ui, key);
    else if (b.dataset.tsAct === 'clearOwn') commit('글자 글꼴', s => { const o = textObjectOfRef(s, ref); if (o) delete o.t.font; });
  }));
}

// ---------------------------------------------------------------------------------------------
// glue: a score that uses JSE fonts gets them loaded; when one arrives the widths are measured again
export function initScoreFonts(app, ui) {
  if (app._scoreFonts) return; app._scoreFonts = true;
  const warned = new Set(); let t = null;
  fontEvents.addEventListener('loaded', () => { clearTimeout(t); t = setTimeout(() => { clearTextWidthCache(); if (app.score) { app.relayout(); refreshTextSelection(app); } }, 40); });
  const check = (opts) => {
    if (!app.score) return;
    const needs = fontNeeds(app.score);
    for (const family of jseNamesIn(app.settings?.newScore?.textStyles)) if (!needs.has(family)) needs.set(family, new Set([400]));
    if (![...needs.keys()].some(f => jseFont(f))) return;
    ensureFonts(needs, opts).then(res => {
      const used = fontNeeds(app.score);
      const fresh = res.failed.filter(f => used.has(f) && !warned.has(f)); if (!fresh.length) return;
      fresh.forEach(f => warned.add(f));
      (ui?.toast ? ui.toast.bind(ui) : toast)(`${fresh.map(fontDisplayName).join(', ')} 글꼴을 내려받지 못해 기본 글꼴로 보여 줍니다. 인터넷에 연결되면 다시 받습니다.`, 'warn', { timeout: 6500 });
    });
  };
  app.addEventListener('document', () => check());
  app.addEventListener('change', () => check());
  window.addEventListener('online', () => { warned.clear(); check({ force: true }); });
  if (app.score) check();
}
function jseNamesIn(styles) {
  const out = []; if (!styles || typeof styles !== 'object') return out;
  for (const k of TEXT_STYLE_KEYS) { const f = jseFont(styles[k]?.family); if (f) out.push(f.family); }
  return out;
}
