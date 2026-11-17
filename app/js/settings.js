// Settings registry: one schema for every option of the app (sections + items), platform filtering,
// search, defaults / migration, reset, export / import — and the hooks that apply a value.
// `app.settings` stays a plain object (localStorage `ssnap.settings`); this module only describes it.
// Pure at import time (no DOM access) so tools/tests/settings.test.js can run it in Node.
import { native, platform, saveBlob, pickFiles } from './native.js';
import { setLang, getLang } from './i18n.js';
import { normalizeTextStyles } from './model/textstyles.js';
import { PAGES_BASE_URL } from './config.js';

export const SETTINGS_VERSION = 2;
export const STORAGE_KEY = 'ssnap.settings';
/** GitHub repository of the project — derived from the Pages address, so tools/set-github-owner.mjs moves both at once. */
export function repoUrlFrom(pagesUrl) { const m = /^https:\/\/([^./]+)\.github\.io\/([^/]+)\/?$/.exec(String(pagesUrl || '')); return m ? `https://github.com/${m[1]}/${m[2]}` : 'https://github.com/omokdie/jse'; }
export const REPO_URL = repoUrlFrom(PAGES_BASE_URL);

export const ACCENTS = [
  { value: '#0a84ff', label: '파랑', en: 'Blue' },
  { value: '#5856d6', label: '남색', en: 'Indigo' },
  { value: '#a550dc', label: '보라', en: 'Purple' },
  { value: '#e0457b', label: '분홍', en: 'Pink' },
  { value: '#e5484d', label: '빨강', en: 'Red' },
  { value: '#e8730c', label: '주황', en: 'Orange' },
  { value: '#1f9d55', label: '초록', en: 'Green' },
  { value: '#0e9aa7', label: '청록', en: 'Teal' },
  { value: '#5b6475', label: '회색', en: 'Graphite' },
];
export const PAPERS = [
  { value: 'white', label: '흰색', en: 'White', color: '#ffffff' },
  { value: 'ivory', label: '미색', en: 'Ivory', color: '#fbf6e9' },
  { value: 'cream', label: '크림', en: 'Cream', color: '#f5ecd7' },
  { value: 'gray', label: '연회색', en: 'Light gray', color: '#eceef2' },
  { value: 'green', label: '연녹색', en: 'Soft green', color: '#e6f0e4' },
];

// ----------------------------------------------------------------------------- context (what platform are we on)
/** shell: electron | android | web · layout: desktop | tablet | phone · touch: coarse pointer available. */
export function makeContext(over = {}) {
  const n = over.native !== undefined ? over.native : native();
  const hasDoc = typeof document !== 'undefined';
  const p = over.platform || platform();
  const shell = over.shell || (n?.platform === 'android' ? 'android' : n ? 'electron' : 'web');
  const layout = over.layout || (hasDoc ? (document.documentElement.dataset.layout || 'desktop') : 'desktop');
  const touch = over.touch ?? (hasDoc && typeof matchMedia === 'function' ? (matchMedia('(pointer: coarse)').matches || document.documentElement.classList.contains('touch')) : false);
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ctx = {
    platform: p, shell, layout, touch, native: n, ui: over.ui || null,
    os: over.os || (shell === 'electron' ? (p === 'windows' ? 'windows' : p) : shell === 'android' || /android/i.test(p) ? 'android' : 'web'),
    features: {
      wakeLock: 'wakeLock' in nav,
      vibrate: typeof nav.vibrate === 'function',
      storage: !!nav.storage?.estimate,
      persist: !!nav.storage?.persist,
      caches: typeof caches !== 'undefined',
      cssZoom: typeof Element !== 'undefined' && 'currentCSSZoom' in Element.prototype,
      standalone: hasDoc && typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || nav.standalone === true),
      preview: !!globalThis.JSE_PREVIEW,
      ...(over.features || {}),
    },
    /** true when the native shell implements this method (older shells + newer web bundle: it may not). */
    has(name) { return typeof this.native?.[name] === 'function'; },
  };
  return ctx;
}

// ----------------------------------------------------------------------------- small helpers
export function getPath(obj, path) { let o = obj; for (const k of String(path).split('.')) { if (o == null) return undefined; o = o[k]; } return o; }
export function setPath(obj, path, value) {
  const ks = String(path).split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  if (value === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = value;
}
const clone = v => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function fmtBytes(n) { if (!(n >= 0)) return '?'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`; }
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
/** Initial consonants of Hangul syllables ("테마" → "ㅌㅁ") so settings can be found by 초성. */
export function choseong(s) { let o = ''; for (const ch of String(s)) { const c = ch.charCodeAt(0); o += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch; } return o; }
const uniform = n => ({ top: n, bottom: n, left: n, right: n });

// ----------------------------------------------------------------------------- sections
export const SECTIONS = [
  { id: 'general', label: '일반', en: 'General', icon: 'general', desc: '언어 · 시작 화면 · 도움말' },
  { id: 'display', label: '화면', en: 'Display', icon: 'display', desc: '테마 · 색 · 크기 · 악보 보기' },
  { id: 'editing', label: '편집 · 입력', en: 'Editing', icon: 'editing', desc: '음표 입력 · 마우스 · 터치 · 펜' },
  { id: 'newScore', label: '새 악보 기본값', en: 'New score', icon: 'newScore', desc: '용지 · 여백 · 보표 크기 · 글꼴' },
  { id: 'playback', label: '재생', en: 'Playback', icon: 'playback', desc: '메트로놈 · 카운트인 · 음량' },
  { id: 'recognition', label: '인식', en: 'Recognition', icon: 'recognition', desc: '사진 인식 · 음원 인식 기본값' },
  { id: 'files', label: '파일', en: 'Files', icon: 'files', desc: '자동 저장 · 내보내기 기본값' },
  { id: 'update', label: '업데이트', en: 'Updates', icon: 'update', desc: '자동 업데이트 · 버전' },
  { id: 'windows', label: ctx => (ctx.os === 'windows' ? 'Windows 앱' : '데스크톱 앱'), en: 'Desktop app', icon: 'windows', desc: '창 · 폴더 · 파일 연결' },
  { id: 'android', label: 'Android 앱', en: 'Android app', icon: 'android', desc: '화면 켜짐 · 전체 화면 · 방향 · 뒤로 버튼' },
  { id: 'web', label: '웹 앱 (PWA)', en: 'Web app', icon: 'web', desc: '앱으로 설치 · 저장 공간 · 오프라인' },
  { id: 'device', label: '이 기기', en: 'This device', icon: 'device', desc: '플랫폼 · 버전 · 저장 공간 · 진단 정보' },
  { id: 'advanced', label: '고급', en: 'Advanced', icon: 'advanced', desc: '설정 내보내기 · 가져오기 · 초기화' },
];

// ----------------------------------------------------------------------------- apply helpers (browser only)
let desktopPush = false;
/** Mirror the desktop options to the shell's own store (it needs them before any page exists). One IPC call per tick. */
function pushDesktopSettings(env) {
  if (desktopPush || typeof env.native?.setAppSettings !== 'function') return;
  desktopPush = true;
  queueMicrotask(() => {
    desktopPush = false;
    const s = env.app.settings;
    try { Promise.resolve(env.native.setAppSettings({ rememberBounds: s.winRememberBounds !== false, startMaximized: !!s.winStartMaximized, disableGpu: !!s.winDisableGpu, defaultDir: s.winDefaultDir || '' })).catch(() => {}); } catch { /* older shell */ }
  });
}
let wakeSentinel = null, wakeBound = false;
async function applyKeepAwake(env, on) {
  const n = env.native;
  if (typeof n?.setKeepScreenOn === 'function') { try { await n.setKeepScreenOn(!!on); } catch { /* older shell */ } return; }
  if (!('wakeLock' in navigator)) return;
  const acquire = async () => { try { if (env.app.settings.keepScreenOn && document.visibilityState === 'visible' && !wakeSentinel) { wakeSentinel = await navigator.wakeLock.request('screen'); wakeSentinel.addEventListener('release', () => { wakeSentinel = null; }); } } catch { /* denied (battery saver, hidden page) */ } };
  if (!wakeBound) { wakeBound = true; document.addEventListener('visibilitychange', acquire); }   // the lock is dropped whenever the page is hidden
  if (on) {
    await acquire();
    if (!wakeSentinel && !env.boot && document.visibilityState === 'visible') env.ui?.toast?.('이 브라우저가 지금은 화면 켜짐 유지를 허용하지 않습니다 (절전 모드이거나 권한이 막혀 있습니다)', 'warn', { timeout: 5000 });
  } else { try { await wakeSentinel?.release(); } catch { /* ignore */ } wakeSentinel = null; }
}
export function keepAwakeActive() { return !!wakeSentinel; }
/**
 * Largest interface size (%) the window can hold with CSS zoom: the chrome still needs the width its layout was
 * designed for (tablet ≥ 600 px, desktop > 860 px — classifyLayout in native.js), or buttons fall off the top bar.
 * The desktop shell does not need this: its real page zoom re-classifies the layout by itself.
 */
export function maxUiScale(layout, width) {
  const need = layout === 'tablet' ? 600 : 880;
  return Math.max(100, Math.min(150, Math.floor((Number(width) || 0) / need * 20) * 5));
}
/** What a stored interface size comes to in this window (CSS zoom only): sizes above 100% are capped by maxUiScale. */
export function effectiveUiScale(pct, layout, width) { const p = Number(pct) || 100; return p <= 100 ? p : Math.min(p, maxUiScale(layout, width)); }
let scaleBound = false, scaleTimer = null;
function applyUiScale(env, pct) {
  let f = Math.max(0.7, Math.min(1.6, (Number(pct) || 100) / 100));
  const root = env.root; if (!root) return;
  if (typeof env.native?.setZoomFactor === 'function') {   // desktop shell: real page zoom (everything scales, layout adapts)
    root.removeAttribute('data-ui-scale'); root.removeAttribute('data-ui-big'); root.style.removeProperty('--ui-scale');
    try { Promise.resolve(env.native.setZoomFactor(f)).catch(() => {}); } catch { /* ignore */ }
    return;
  }
  // browsers: CSS zoom of the chrome (settings.css); it only takes effect on desktop / tablet layouts
  if (!('currentCSSZoom' in Element.prototype)) { root.removeAttribute('data-ui-scale'); root.removeAttribute('data-ui-big'); root.style.removeProperty('--ui-scale'); return; }
  f = effectiveUiScale(Math.round(f * 100), root.dataset.layout || 'desktop', window.innerWidth) / 100;
  const before = root.getAttribute('data-ui-scale');
  if (Math.abs(f - 1) < 0.005) { root.removeAttribute('data-ui-scale'); root.removeAttribute('data-ui-big'); root.style.removeProperty('--ui-scale'); }
  else { root.style.setProperty('--ui-scale', String(f)); root.setAttribute('data-ui-scale', String(Math.round(f * 100))); root.toggleAttribute('data-ui-big', f > 1.15); }
  if (!scaleBound) {   // a narrower window (rotation, split screen) can hold less: follow it
    scaleBound = true;
    const app = env.app;
    const again = () => { clearTimeout(scaleTimer); scaleTimer = setTimeout(() => applyUiScale({ ...(app.prefs?.env?.(false) || env), boot: false, quiet: true }, app.settings.uiScale), 140); };
    window.addEventListener('resize', again); window.addEventListener('jse-layout', again);
  }
  if (env.boot || (env.quiet && before === root.getAttribute('data-ui-scale'))) return;
  setTimeout(() => {
    env.ui?.view?.fitMode && env.ui.view.applyFit();
    if (env.quiet) env.app.emit?.('settings', { id: 'uiScale', value: env.app.settings.uiScale });   // an open settings window re-draws the row (its "…까지만 커집니다" note)
    else window.dispatchEvent(new Event('resize'));
  }, 60);
}
function applyAccent(env, color) {
  const root = env.root; if (!root) return;
  if (!color || color.toLowerCase() === ACCENTS[0].value) { root.removeAttribute('data-accent'); root.style.removeProperty('--jse-accent'); }
  else { root.style.setProperty('--jse-accent', color); root.setAttribute('data-accent', color); }
}
function applyPaper(env, id) {
  const root = env.root; if (!root) return;
  const p = PAPERS.find(x => x.value === id);
  if (!p || p.value === 'white') { root.style.removeProperty('--jse-paper'); root.removeAttribute('data-paper'); }
  else { root.style.setProperty('--jse-paper', p.color); root.setAttribute('data-paper', p.value); }
}
function applyPanels(env) {
  const ui = env.ui, body = ui?.el?.body; if (!body) return;
  const lay = document.documentElement.dataset.layout;
  if (lay === 'phone') return;
  const s = env.app.settings;
  const want = (v, auto) => (v === 'show' ? true : v === 'hide' ? false : auto);
  const autoLeft = lay !== 'tablet', autoRight = lay !== 'tablet' && window.innerWidth >= 1180;
  // at start-up "자동" keeps whatever the shell decided; an explicit change in the dialog applies right away
  if (!(env.boot && (s.panelLeft || 'auto') === 'auto')) body.classList.toggle('hide-left', !want(s.panelLeft, autoLeft));
  if (!(env.boot && (s.panelRight || 'auto') === 'auto')) body.classList.toggle('hide-right', !want(s.panelRight, autoRight));
  if (env.boot) return;   // the shell renders its panels once the first score is loaded
  ui.renderPanels?.(); ui.updateRail?.();
  setTimeout(() => ui.view?.fitMode && ui.view.applyFit(), 50);
}
async function storageText() {
  try { const e = await navigator.storage.estimate(); const persisted = await navigator.storage.persisted?.(); return `${fmtBytes(e.usage || 0)} 사용 / ${fmtBytes(e.quota || 0)} 가능${persisted ? ' · 영구 저장' : ''}`; } catch { return '알 수 없음'; }
}
function platformText(ctx) {
  const lay = { desktop: 'PC 화면', tablet: '태블릿 화면', phone: '휴대폰 화면' }[ctx.layout] || ctx.layout;
  const sh = ctx.shell === 'electron' ? (ctx.os === 'windows' ? 'Windows 앱' : `데스크톱 앱 (${ctx.platform})`) : ctx.shell === 'android' ? 'Android 앱' : ctx.features.standalone ? '웹 앱 (설치됨)' : /android/i.test(ctx.platform) ? '웹 브라우저 (Android)' : /ios/i.test(ctx.platform) ? '웹 브라우저 (iOS)' : '웹 브라우저';
  return `${sh} · ${lay}`;
}
function versionText(env) {
  const n = env.native, v = env.ui?.version || '?';
  if (!n) return `v${v}`;
  if (n.platform === 'android') return `웹 번들 v${n.webVersion || v} · 앱 v${n.nativeVersion || n.appVersion || '?'}`;
  return n.appVersion && n.appVersion !== v ? `v${v} (앱 v${n.appVersion})` : `v${v}`;
}
function screenText() {
  const dpr = window.devicePixelRatio || 1;
  return `${window.innerWidth}×${window.innerHeight} (×${Math.round(dpr * 100) / 100})${matchMedia('(pointer: coarse)').matches ? ' · 터치' : ''}${navigator.maxTouchPoints > 0 && matchMedia('(pointer: fine)').matches ? ' · 마우스/펜' : ''}`;
}
/** Plain-text report for bug reports ("진단 정보 복사"). */
export async function diagnostics(env) {
  const ctx = env.ctx, s = env.app.settings, d = defaultsFor(ctx);
  const changed = ITEMS.filter(it => it.default !== undefined && !same(getPath(s, it.key), getPath(d, it.key))).map(it => `  ${it.key} = ${JSON.stringify(getPath(s, it.key))}`);
  const lines = [
    `JSE ${versionText(env)}`,
    `플랫폼: ${platformText(ctx)}`,
    `화면: ${screenText()}`,
    `User-Agent: ${navigator.userAgent}`,
    `언어: ${navigator.language} (앱 ${getLang()})`,
    `온라인: ${navigator.onLine ? '예' : '아니오'}`,
    `저장 공간: ${ctx.features.storage ? await storageText() : '알 수 없음'}`,
    `서비스 워커: ${navigator.serviceWorker?.controller ? '동작 중' : '없음'}`,
    `업데이트 상태: ${env.ui?.updater?.status?.state || '?'}`,
    `악보: ${env.app.score ? `${env.app.score.measures.length}마디 · ${env.app.score.parts.length}파트 · ${env.app.layout?.pages?.length || 0}쪽 · 조판 ${Math.round(env.app.layoutMs || 0)}ms` : '없음'}`,
    `바꾼 설정 (${changed.length}):`, ...(changed.length ? changed : ['  (없음)']),
    `시각: ${new Date().toISOString()}`,
  ];
  if (typeof env.native?.getAppInfo === 'function') { try { const i = await env.native.getAppInfo(); lines.splice(3, 0, `셸: Electron ${i.electron || '?'} · Chromium ${i.chrome || '?'} · ${i.os || ''}`); } catch { /* ignore */ } }
  return lines.join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
}
// beforeinstallprompt must be caught when it fires (long before the settings window is opened)
let installEvent = null, installed = false;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', e => { installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; installed = true; });
}
export function canInstall() { return !!installEvent; }

// ----------------------------------------------------------------------------- items
const on = (v = true) => ({ type: 'toggle', default: v });
const VIEW_OPTS = [{ value: 'single', label: '한 페이지' }, { value: 'vertical', label: '세로 연속' }, { value: 'horizontal', label: '가로 연속' }, { value: 'grid', label: '여러 페이지 한눈에' }, { value: 'reflow', label: '화면 맞춤 (연속)' }];
const NOT_PHONE = ['desktop', 'tablet'];

/** id = key path in app.settings unless `key` says otherwise. */
const RAW_ITEMS = [
  // ---------- 일반
  { id: 'lang', section: 'general', type: 'select', default: 'ko', label: '언어', en: 'Language', desc: '메뉴와 대화상자에 쓰는 언어입니다.', keywords: 'language 한국어 english 영어 korean',
    options: [{ value: 'ko', label: '한국어' }, { value: 'en', label: 'English' }], apply: (env, v) => { setLang(v); if (!env.boot) env.ui?.rebuild?.(); } },
  { id: 'startup', section: 'general', type: 'select', default: 'resume', label: '시작 화면', en: 'On start-up', desc: '앱을 열었을 때 무엇을 보여 줄지 고릅니다.', keywords: 'start launch 시작 환영 이어서 새 악보 welcome resume',
    options: [{ value: 'resume', label: '마지막 악보 이어서', desc: '작업하던 악보를 그대로 엽니다' }, { value: 'welcome', label: '환영 화면', desc: '무엇을 할지 고르는 화면부터' }, { value: 'new', label: '새 악보', desc: '빈 악보로 시작합니다' }] },
  { id: 'tips', section: 'general', ...on(), label: '간단 모드', en: 'Simple mode', desc: '기호 팔레트에 자주 쓰는 탭만 보이고 시작 안내를 보여 줍니다.', keywords: '초보자 beginner simple 팔레트 쉬운',
    apply: env => { if (!env.boot) env.ui?.renderPanels?.(); } },
  { id: 'hints', section: 'general', ...on(), label: '도움말 힌트', en: 'Hints', desc: '도구를 고르면 사용법을 한 줄로 알려 줍니다.', keywords: 'hint tip 안내 도움말 설명',
    apply: (env, v) => { env.root?.classList.toggle('jse-no-hints', v === false); if (!env.boot) env.ui?.updateHint?.(); } },
  { id: 'welcomeAgain', section: 'general', type: 'action', label: '시작 안내', en: 'Welcome screen', desc: '처음 실행했을 때 보이는 환영 화면을 다시 엽니다.', keywords: 'welcome 환영 처음',
    actions: [{ id: 'show', label: '다시 보기', run: env => { env.close(); env.ui.welcome(true); } }] },
  { id: 'clearRecent', section: 'general', type: 'action', label: '최근 파일', en: 'Recent files', desc: '파일 메뉴의 최근 파일 목록을 비웁니다. 파일 자체는 지워지지 않습니다.', keywords: 'recent history 기록 목록 지우기 삭제',
    status: async () => { const { storage } = await import('./io/storage.js'); return `${(await storage.recent()).length}개`; },
    actions: [{ id: 'clear', label: '목록 지우기', run: async env => { const { storage } = await import('./io/storage.js'); const list = await storage.recent(); for (const r of list) await storage.removeRecent(r.id); env.toast(list.length ? `최근 파일 ${list.length}개를 목록에서 지웠습니다` : '최근 파일 목록이 이미 비어 있습니다', 'ok'); } }] },

  // ---------- 화면
  { id: 'theme', section: 'display', group: '모양', type: 'select', default: 'auto', label: '테마', en: 'Theme', desc: '자동은 기기의 밝게/어둡게 설정을 따릅니다.', keywords: 'theme dark light 다크 라이트 어둡게 밝게 야간 night mode',
    options: [{ value: 'auto', label: '자동' }, { value: 'light', label: '밝게' }, { value: 'dark', label: '어둡게' }], apply: env => env.ui?.applyTheme?.() },
  { id: 'accent', section: 'display', group: '모양', type: 'color', default: ACCENTS[0].value, label: '강조 색', en: 'Accent colour', desc: '버튼·선택 표시·입력 미리보기에 쓰는 색입니다.', keywords: 'accent color colour 색상 포인트 강조 테마색',
    options: ACCENTS, apply: (env, v) => applyAccent(env, v) },
  { id: 'uiScale', section: 'display', group: '모양', type: 'slider', default: 100, min: 85, max: 150, step: 5, unit: '%', label: '화면 요소 크기', en: 'Interface size', desc: '메뉴·버튼·글자 크기를 키우거나 줄입니다. 악보 확대와는 따로입니다.', keywords: 'ui scale zoom 배율 크기 글자 크게 작게 dpi',
    marks: [85, 100, 125, 150], lazy: true, when: ctx => ctx.has('setZoomFactor') || (ctx.features.cssZoom && ctx.layout !== 'phone'),
    // (hidden in the phone layout, but still applied: the size comes back as soon as the window grows into a tablet / desktop layout)
    applyWhen: ctx => ctx.has('setZoomFactor') || ctx.features.cssZoom, apply: (env, v) => applyUiScale(env, v),
    status: env => { if (env.ctx.has('setZoomFactor') || typeof window === 'undefined') return ''; const want = Number(env.app.settings.uiScale) || 100, cap = maxUiScale(env.ctx.layout, window.innerWidth); return want > cap ? `이 화면 너비에서는 ${cap}%까지만 커집니다. 창을 넓히거나 화면을 가로로 돌리면 더 커집니다.` : ''; } },
  { id: 'reduceGlass', section: 'display', group: '모양', ...on(false), label: '유리 효과 줄이기', en: 'Reduce transparency', desc: '반투명 흐림 효과를 끄고 불투명한 패널을 씁니다. 느린 기기에서 더 부드럽게 움직입니다.', keywords: 'blur glass transparency performance 성능 흐림 투명 느림 렉',
    apply: (env, v) => env.root?.classList.toggle('jse-reduce-glass', !!v) },
  { id: 'paperColor', section: 'display', group: '악보 보기', type: 'select', swatches: true, default: 'white', label: '악보 종이 색', en: 'Paper colour', desc: '화면에서만 바뀝니다. PDF·이미지로 내보내면 항상 흰색입니다.', keywords: 'paper page background 종이 배경 미색 아이보리 눈 편한 sepia',
    options: PAPERS, apply: (env, v) => applyPaper(env, v) },
  { id: 'defaultView', section: 'display', group: '악보 보기', type: 'select', default: 'last', layouts: NOT_PHONE, label: '기본 보기 방식', en: 'Default view', desc: '앱을 열었을 때의 페이지 보기 방식입니다.', keywords: 'view page scroll 보기 페이지 세로 가로 연속 한눈에',
    options: [{ value: 'last', label: '마지막에 쓴 방식' }, ...VIEW_OPTS], apply: (env, v) => { if (!env.boot && v !== 'last' && document.documentElement.dataset.layout !== 'phone') env.ui?.setView?.(v); } },
  { id: 'defaultZoom', section: 'display', group: '악보 보기', type: 'select', default: 'width', layouts: NOT_PHONE, label: '기본 확대', en: 'Default zoom', desc: '악보를 열 때의 확대 정도입니다.', keywords: 'zoom fit 확대 축소 폭 맞춤 페이지 맞춤 배율',
    options: [{ value: 'width', label: '폭 맞춤' }, { value: 'page', label: '페이지 맞춤' }, { value: '100', label: '100%' }, { value: '125', label: '125%' }, { value: '150', label: '150%' }], apply: env => { if (!env.boot) env.ui?.fitDefault?.(); } },
  { id: 'panelLeft', section: 'display', group: '패널', type: 'select', default: 'auto', layouts: NOT_PHONE, label: '기호 팔레트', en: 'Palette panel', desc: '왼쪽 기호 팔레트를 시작할 때 보일지 정합니다.', keywords: 'panel palette sidebar 패널 팔레트 왼쪽 사이드바',
    options: [{ value: 'auto', label: '자동' }, { value: 'show', label: '보이기' }, { value: 'hide', label: '숨기기' }], apply: env => applyPanels(env) },
  { id: 'panelRight', section: 'display', group: '패널', type: 'select', default: 'auto', layouts: NOT_PHONE, label: '속성 패널', en: 'Properties panel', desc: '오른쪽 속성 패널을 시작할 때 보일지 정합니다. 자동은 화면이 넓을 때만 보입니다.', keywords: 'panel inspector properties sidebar 패널 속성 오른쪽 사이드바',
    options: [{ value: 'auto', label: '자동' }, { value: 'show', label: '보이기' }, { value: 'hide', label: '숨기기' }], apply: env => applyPanels(env) },

  // ---------- 편집 · 입력
  { id: 'startTool', section: 'editing', group: '음표 입력', type: 'select', default: 'select', label: '시작 도구', en: 'Start with', desc: '악보를 열었을 때 먼저 잡고 있을 도구입니다.', keywords: 'tool 도구 선택 입력 시작',
    options: [{ value: 'select', label: '선택 도구' }, { value: 'entry', label: '음표 입력' }] },
  { id: 'entryGhost', section: 'editing', group: '음표 입력', ...on(), mouse: true, label: '입력 미리보기 음표', en: 'Entry preview', desc: '마우스나 펜을 오선 위에 올리면 음표가 놓일 자리를 흐리게 보여 줍니다.', keywords: 'ghost preview 미리보기 흐린 음표 놓일 자리 hover' },
  { id: 'inputSound', section: 'editing', group: '음표 입력', ...on(), label: '입력할 때 소리 내기', en: 'Sound on entry', desc: '음표를 넣거나 음높이를 고를 때 그 음을 들려줍니다.', keywords: 'sound audition 소리 미리 듣기 음 재생 무음' },
  { id: 'wheelMode', section: 'editing', group: '마우스', type: 'select', default: 'scroll', mouse: true, label: '마우스 휠 동작', en: 'Mouse wheel', desc: '휠을 굴릴 때 악보를 움직일지 확대·축소할지 정합니다.', keywords: 'wheel scroll zoom 휠 스크롤 확대 축소 ctrl',
    options: [{ value: 'scroll', label: '스크롤', desc: 'Ctrl+휠 = 확대·축소' }, { value: 'zoom', label: '확대·축소', desc: 'Shift+휠 = 위아래 스크롤' }] },
  { id: 'touchSlideInput', section: 'editing', group: '터치 · 펜', ...on(), touch: true, label: '누르고 밀어 입력', en: 'Press and slide entry', desc: '오선을 누른 채 위아래로 밀어 음높이를 고르고 떼면 들어갑니다. 끄면 누른 자리에 바로 들어갑니다.', keywords: 'touch slide drag 터치 밀어 드래그 음높이 탭' },
  { id: 'longPressMs', section: 'editing', group: '터치 · 펜', type: 'slider', default: 550, min: 300, max: 1000, step: 50, unit: 'ms', touch: true, label: '길게 누르기 시간', en: 'Long-press time', desc: '악보를 얼마나 오래 눌러야 메뉴가 열리는지 정합니다.', keywords: 'long press hold 길게 누르기 꾹 메뉴 시간', marks: [300, 550, 1000] },
  { id: 'haptics', section: 'editing', group: '터치 · 펜', ...on(), touch: true, when: ctx => ctx.has('vibrate') || ctx.features.vibrate, label: '진동 피드백', en: 'Haptic feedback', desc: '길게 누르거나 음높이를 바꿀 때 짧게 진동합니다.', keywords: 'vibrate haptic 진동 햅틱 떨림',
    apply: (env, v) => { if (v && !env.boot) env.app.haptic?.(12); } },
  { id: 'penOnly', section: 'editing', group: '터치 · 펜', ...on(false), touch: true, label: '펜 전용 입력', en: 'Pen-only editing', desc: '켜면 손가락은 화면 이동과 확대만 하고, 펜(스타일러스)으로만 악보를 고칩니다. 손바닥이 닿아도 음표가 들어가지 않습니다.', keywords: 'pen stylus s펜 spen 애플펜슬 pencil 손바닥 palm 스타일러스 손가락' },

  // ---------- 새 악보 기본값
  { id: 'newScore.pageSize', section: 'newScore', group: '용지', type: 'select', default: 'A4', label: '용지 크기', en: 'Paper size', keywords: 'paper page size a4 letter 용지 종이',
    options: ['A4', 'Letter', 'A3', 'B5', 'A5', 'Legal'].map(v => ({ value: v, label: v })) },
  { id: 'newScore.orientation', section: 'newScore', group: '용지', type: 'select', default: 'portrait', label: '용지 방향', en: 'Orientation', keywords: 'orientation portrait landscape 세로 가로 방향',
    options: [{ value: 'portrait', label: '세로' }, { value: 'landscape', label: '가로' }] },
  { id: 'newScore.marginsMm', section: 'newScore', group: '용지', type: 'slider', default: uniform(15), min: 5, max: 30, step: 1, unit: 'mm', label: '여백', en: 'Margins', desc: '종이 네 변의 여백입니다. 악보마다 [악보 → 페이지 설정]에서 따로 바꿀 수 있습니다.', keywords: 'margin 여백 테두리',
    unpack: v => Number(v?.top) || 15, pack: n => uniform(n), marks: [5, 15, 30],
    coerce: v => { const c = n => Math.max(0, Math.min(60, n)); if (v && typeof v === 'object' && ['top', 'bottom', 'left', 'right'].every(k => Number.isFinite(Number(v[k])) && v[k] !== null && v[k] !== '')) return { top: c(+v.top), bottom: c(+v.bottom), left: c(+v.left), right: c(+v.right) }; const n = Number(v); return uniform(Number.isFinite(n) && typeof v === 'number' ? Math.max(5, Math.min(30, n)) : 15); } },
  { id: 'newScore.staffSpaceMm', section: 'newScore', group: '악보', type: 'slider', default: 1.75, min: 1.2, max: 2.6, step: 0.05, unit: 'mm', digits: 2, label: '보표 크기', en: 'Staff size', desc: '오선 한 칸의 높이입니다. 크게 하면 음표가 커지고 한 줄에 들어가는 마디가 줄어듭니다.', keywords: 'staff size 오선 크기 음표 크기 보표', marks: [1.2, 1.75, 2.6] },
  { id: 'newScore.measureNumbers', section: 'newScore', group: '악보', type: 'select', default: 'system', label: '마디 번호', en: 'Measure numbers', keywords: 'measure bar number 마디 번호',
    options: [{ value: 'system', label: '단 시작마다' }, { value: 'all', label: '모든 마디' }, { value: 'none', label: '없음' }] },
  { id: 'newScoreFonts', section: 'newScore', group: '악보', type: 'action', label: '글꼴', en: 'Fonts', desc: '제목·가사·코드 등 글자의 글꼴과 크기 기본값입니다.', keywords: 'font 글꼴 폰트 서체 제목 가사 코드',
    when: ctx => typeof ctx.ui?.textStyles === 'function',
    status: env => { const n = Object.keys(env.app.settings.newScore?.textStyles || {}).length; return n ? `${n}가지 바꿈` : '기본 글꼴'; },
    actions: [{ id: 'open', label: '글꼴…', run: env => env.ui.textStyles() }] },

  // ---------- 재생
  { id: 'metronome', section: 'playback', ...on(false), label: '메트로놈', en: 'Metronome', desc: '재생할 때 박자 소리를 함께 냅니다.', keywords: 'metronome click 메트로놈 박자 똑딱',
    apply: (env, v) => { if (env.ui?.player) { env.ui.player.metronome = !!v; if (!env.boot) env.ui.scheduleOptions?.(); } } },
  { id: 'countIn', section: 'playback', type: 'select', default: 0, label: '카운트인', en: 'Count-in', desc: '재생을 시작하기 전에 박자를 미리 세어 줍니다.', keywords: 'count in 카운트 예비박 준비 하나 둘',
    options: [{ value: 0, label: '없음' }, { value: 1, label: '한 마디' }, { value: 2, label: '두 마디' }], apply: (env, v) => { if (env.ui?.player) env.ui.player.countIn = Number(v) || 0; } },
  { id: 'volume', section: 'playback', type: 'slider', default: 80, min: 0, max: 100, step: 5, unit: '%', label: '음량', en: 'Volume', keywords: 'volume 음량 소리 크기 볼륨', marks: [0, 50, 100],
    apply: (env, v) => env.ui?.player?.setVolume?.(Math.max(0, Math.min(1, Number(v) / 100))) },
  { id: 'playbackSpeed', section: 'playback', type: 'slider', default: 100, min: 50, max: 150, step: 5, unit: '%', label: '재생 빠르기', en: 'Playback speed', desc: '악보의 템포는 그대로 두고 연습용으로 느리게 또는 빠르게 재생합니다.', keywords: 'speed tempo 빠르기 속도 느리게 연습 템포', marks: [50, 100, 150], lazy: true,
    apply: (env, v) => { const p = env.ui?.player; if (!p) return; const was = p.playing; if (was) p.pause(); p.tempoScale = Math.max(0.25, Math.min(2, Number(v) / 100)); if (was) p.play(null, { countIn: false }); } },
  { id: 'followPlayback', section: 'playback', ...on(), label: '재생 중 화면 따라가기', en: 'Follow playback', desc: '재생 위치가 화면 밖으로 나가면 악보를 자동으로 넘깁니다.', keywords: 'follow scroll 따라가기 자동 넘김 스크롤 커서' },

  // ---------- 인식
  { id: 'omrParts', section: 'recognition', group: '사진 인식', type: 'select', default: 'auto', label: '악보 종류', en: 'Score type', desc: '사진으로 인식할 때 처음 선택되어 있는 악보 종류입니다.', keywords: 'omr photo scan 사진 인식 큰보표 피아노 멜로디',
    options: [{ value: 'auto', label: '자동 감지' }, { value: '1', label: '한 줄 악보' }, { value: '2', label: '피아노 (큰보표)' }] },
  { id: 'omrLyrics', section: 'recognition', group: '사진 인식', ...on(), label: '가사 읽기', en: 'Read lyrics', desc: '사진 속 한국어 가사를 읽어 음표에 붙입니다. 끄면 인식이 조금 빨라집니다.', keywords: 'lyrics 가사 한글 한국어 ocr 글자' },
  { id: 'audioMode', section: 'recognition', group: '음원 인식', type: 'select', default: 'auto', label: '음원 종류', en: 'Audio type', desc: '음원으로 악보를 만들 때 처음 선택되어 있는 종류입니다.', keywords: 'audio mp3 음원 멜로디 피아노 다성',
    options: [{ value: 'auto', label: '자동 판단' }, { value: 'melody', label: '멜로디' }, { value: 'piano', label: '피아노·다성' }] },
  { id: 'audioTriplets', section: 'recognition', group: '음원 인식', ...on(false), label: '셋잇단음표 허용', en: 'Allow triplets', desc: '스윙·셔플처럼 셋으로 나뉘는 리듬을 셋잇단음표로 적습니다.', keywords: 'triplet 셋잇단 스윙 셔플' },
  { id: 'audioChords', section: 'recognition', group: '음원 인식', ...on(), label: '코드 기호 붙이기', en: 'Add chord symbols', desc: '들리는 화음을 코드 기호로 적어 넣습니다.', keywords: 'chord 코드 화음 기호' },

  // ---------- 파일
  { id: 'autosave', section: 'files', group: '저장', ...on(), label: '자동 저장', en: 'Autosave', desc: '고친 내용을 이 기기에 자동으로 보관해 두고, 다음에 열 때 이어서 작업합니다. 파일로 저장하는 것과는 별개입니다.', keywords: 'autosave draft 자동 저장 임시 복구 이어서',
    apply: env => { if (env.boot) return; env.ui?.updateTitle?.(); if (env.app.settings.autosave && env.app.dirty) env.ui?.scheduleAutosave?.(); } },
  { id: 'autosaveDelay', section: 'files', group: '저장', type: 'select', default: 1.2, label: '자동 저장 간격', en: 'Autosave interval', desc: '큰 악보에서 편집이 느리면 간격을 늘려 보세요.', keywords: 'autosave interval 간격 주기 초',
    options: [{ value: 1.2, label: '고칠 때마다' }, { value: 5, label: '5초' }, { value: 15, label: '15초' }, { value: 30, label: '30초' }, { value: 60, label: '1분' }] },
  { id: 'saveSourcePhotos', section: 'files', group: '저장', ...on(), label: '원본 사진 포함', en: 'Keep source photos', desc: '사진으로 인식한 악보를 저장할 때 원본 사진도 파일에 넣습니다. 끄면 파일이 작아지지만 다시 열었을 때 원본과 대조할 수 없습니다.', keywords: 'photo source 원본 사진 용량 크기 파일 ssnap' },
  { id: 'exportFormat', section: 'files', group: '내보내기', type: 'select', default: 'pdf', label: '내보내기 기본 형식', en: 'Default export format', desc: '내보내기 창을 열었을 때 처음 선택되어 있는 형식입니다.', keywords: 'export format pdf png jpg svg musicxml midi 내보내기 형식 musescore nwc sibelius finale 시벨리우스 피날레 뮤즈스코어',
    options: [{ value: 'pdf', label: 'PDF' }, { value: 'png', label: 'PNG 이미지' }, { value: 'jpg', label: 'JPG 이미지' }, { value: 'svg', label: 'SVG 벡터' }, { value: 'musicxml', label: 'MusicXML' }, { value: 'musescore', label: 'MuseScore' }, { value: 'nwc', label: 'NWC' }, { value: 'sibelius', label: 'Sibelius (MusicXML)' }, { value: 'finale', label: 'Finale (MusicXML)' }, { value: 'midi', label: 'MIDI' }, { value: 'ssnap', label: 'JSE (.ssnap)' }] },
  { id: 'exportDpi', section: 'files', group: '내보내기', type: 'select', default: 300, label: '내보내기 해상도', en: 'Export resolution', desc: 'PDF·PNG·JPG의 기본 해상도입니다. 인쇄용은 300 dpi를 권합니다.', keywords: 'dpi resolution 해상도 화질 인쇄',
    options: [{ value: 150, label: '150 dpi', desc: '화면용' }, { value: 300, label: '300 dpi', desc: '인쇄용' }, { value: 600, label: '600 dpi', desc: '고화질' }] },

  // ---------- 업데이트
  { id: 'autoUpdate', section: 'update', ...on(), label: '자동 업데이트', en: 'Automatic updates', desc: '인터넷에 연결되어 있으면 새 버전을 자동으로 받아 적용합니다.', keywords: 'update 업데이트 자동 새 버전', when: ctx => !ctx.features.preview,
    apply: (env, v) => { if (!env.boot) env.ui?.updater?.setAuto?.(!!v); } },
  { id: 'version', section: 'update', type: 'info', label: '현재 버전', en: 'Version', keywords: 'version 버전', value: env => versionText(env) },
  { id: 'checkUpdate', section: 'update', type: 'action', label: '업데이트 확인', en: 'Check for updates', keywords: 'check update 확인 최신', live: 'update', when: ctx => !ctx.features.preview,
    status: env => ({ idle: '', checking: '확인하는 중…', 'up-to-date': '최신 버전입니다', available: `새 버전 ${env.ui?.updater?.status?.version || ''}이 있습니다`, downloading: `받는 중 ${Math.round(env.ui?.updater?.status?.percent || 0)}%`, ready: '다시 시작하면 적용됩니다', done: `업데이트 완료 v${env.ui?.updater?.status?.version || ''}`, error: `확인 실패${env.ui?.updater?.status?.message ? ': ' + env.ui.updater.status.message : ''}` }[env.ui?.updater?.status?.state || 'idle'] || ''),
    actions: [
      { id: 'check', label: '지금 확인', primary: true, run: env => env.ui.updater?.check(true) },
      { id: 'install', label: '지금 적용', when: env => env.ui?.updater?.status?.state === 'ready', run: env => env.ui.updater.install() },
    ] },
  { id: 'releaseNotes', section: 'update', type: 'action', label: '변경 내용', en: 'Release notes', desc: '버전별로 달라진 점을 봅니다.', keywords: 'release notes changelog 변경 내용 새 기능',
    actions: [{ id: 'open', label: '변경 내용 보기', run: async env => {
      const notes = env.ui?.updater?.status?.notes;
      if (notes) { const { alertDialog } = await import('./ui/dialogs.js'); const esc = String(notes).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); alertDialog('변경 내용', esc.replace(/\n/g, '<br>')); return; }
      const url = REPO_URL + '/releases';
      if (typeof env.native?.openExternal === 'function') { try { await env.native.openExternal(url); return; } catch { /* fall through */ } }
      if (!window.open(url, '_blank', 'noopener')) env.toast(`브라우저에서 ${url} 을 열어 주세요`, 'info', { timeout: 6000 });
    } }] },

  // ---------- Windows 앱 (Electron) — the values are mirrored to electron/settings.js through IPC
  { id: 'winRememberBounds', section: 'windows', group: '창', ...on(), platforms: ['electron'], when: ctx => ctx.has('setAppSettings'), label: '창 크기·위치 기억', en: 'Remember window size', desc: '다음에 열 때 마지막 창 크기와 위치로 엽니다.', keywords: 'window size position 창 크기 위치 기억', apply: env => pushDesktopSettings(env) },
  { id: 'winStartMaximized', section: 'windows', group: '창', ...on(false), platforms: ['electron'], when: ctx => ctx.has('setAppSettings'), label: '시작할 때 최대화', en: 'Start maximised', desc: '항상 화면 가득 찬 창으로 시작합니다.', keywords: 'maximize 최대화 전체 창', apply: env => pushDesktopSettings(env) },
  { id: 'winCloseConfirm', section: 'windows', group: '창', type: 'select', default: 'auto', platforms: ['electron'], label: '닫을 때 저장 확인', en: 'Confirm on close', desc: '저장하지 않은 변경이 있을 때 창을 닫기 전에 물어봅니다. 자동은 자동 저장이 꺼져 있을 때만 묻습니다.', keywords: 'close confirm save 닫기 종료 저장 확인 묻기',
    options: [{ value: 'auto', label: '자동' }, { value: 'always', label: '항상 묻기' }, { value: 'never', label: '묻지 않기' }] },
  { id: 'winDisableGpu', section: 'windows', group: '창', ...on(false), platforms: ['electron'], when: ctx => ctx.has('setAppSettings'), label: '하드웨어 가속 끄기', en: 'Disable hardware acceleration', desc: '화면이 깜빡이거나 검게 나올 때 켜 보세요. 앱을 다시 시작해야 적용됩니다.', keywords: 'gpu hardware acceleration 하드웨어 가속 그래픽 깜빡 검은 화면', restart: true, apply: env => pushDesktopSettings(env) },
  { id: 'winDefaultDir', section: 'windows', group: '파일', type: 'action', default: '', platforms: ['electron'], when: ctx => ctx.has('chooseFolder') && ctx.has('setAppSettings'), label: '열기·저장 기본 폴더', en: 'Default folder', desc: '열기와 저장 창이 처음 보여 주는 폴더입니다.', keywords: 'folder directory 폴더 경로 위치 저장 열기', apply: env => pushDesktopSettings(env),
    status: env => env.app.settings.winDefaultDir || '마지막으로 쓴 폴더',
    actions: [
      { id: 'choose', label: '폴더 선택…', run: async env => { const dir = await env.native.chooseFolder({ defaultPath: env.app.settings.winDefaultDir || '' }); if (dir) env.set('winDefaultDir', String(dir)); } },
      { id: 'clear', label: '마지막 폴더 사용', when: env => !!env.app.settings.winDefaultDir, run: env => env.set('winDefaultDir', '') },
    ] },
  { id: 'winFileAssoc', section: 'windows', group: '파일', type: 'action', platforms: ['electron'], when: ctx => ctx.os === 'windows' && ctx.has('openSystemSettings'), label: '파일 연결', en: 'File associations', desc: '악보 파일(.ssnap 등)을 더블클릭했을 때 JSE로 열리게 하려면 Windows의 기본 앱 설정에서 고릅니다.', keywords: 'file association default app 파일 연결 기본 앱 확장자 ssnap 더블클릭',
    actions: [{ id: 'open', label: '파일 연결 설정 열기', run: env => env.native.openSystemSettings('default-apps') }] },
  { id: 'winSettingsFile', section: 'windows', group: '파일', type: 'action', platforms: ['electron'], when: ctx => ctx.has('showSettingsFile'), label: '설정 파일 위치', en: 'Settings file', desc: '창 위치·업데이트 설정이 들어 있는 settings.json과 로그 폴더를 탐색기에서 엽니다.', keywords: 'settings file folder log 설정 파일 위치 폴더 로그 appdata',
    actions: [{ id: 'open', label: '폴더 열기', run: env => env.native.showSettingsFile() }] },
  { id: 'winRestart', section: 'windows', group: '창', type: 'action', platforms: ['electron'], when: ctx => ctx.has('relaunch'), label: '앱 다시 시작', en: 'Restart app', desc: '하드웨어 가속처럼 다시 시작해야 적용되는 설정을 바로 적용합니다.', keywords: 'restart relaunch 다시 시작 재시작',
    actions: [{ id: 'restart', label: '다시 시작', run: env => env.ui.requestRelaunch?.() }] },

  // ---------- Android 앱 / 웹 앱 — 화면 켜짐 유지는 플랫폼마다 구현이 다르지만 같은 키를 씁니다
  { id: 'keepScreenOn', section: { android: 'android', electron: 'windows', web: 'web' }, group: { electron: '창' }, ...on(false), when: ctx => ctx.has('setKeepScreenOn') || ctx.features.wakeLock, label: '화면 켜짐 유지', en: 'Keep screen on', desc: '앱이 열려 있는 동안 화면이 저절로 꺼지지 않게 합니다. 악보를 보며 연주할 때 편합니다.', keywords: 'screen awake wake lock 화면 켜짐 꺼짐 절전 잠자기 sleep',
    apply: (env, v) => applyKeepAwake(env, v) },
  { id: 'immersive', section: 'android', ...on(false), platforms: ['android'], when: ctx => ctx.has('setImmersive'), label: '전체 화면 (몰입 모드)', en: 'Immersive mode', desc: '상태 표시줄과 내비게이션 바를 숨겨 악보를 더 넓게 봅니다. 화면 가장자리를 쓸어 내리면 잠깐 다시 보입니다.', keywords: 'fullscreen immersive 전체 화면 몰입 상태 표시줄 내비게이션 바',
    apply: (env, v) => { try { Promise.resolve(env.native?.setImmersive?.(!!v)).catch(() => {}); } catch { /* older shell */ } } },
  { id: 'orientation', section: 'android', type: 'select', default: 'auto', platforms: ['android'], when: ctx => ctx.has('setOrientation'), label: '화면 방향', en: 'Screen orientation', desc: '화면을 한 방향으로 고정합니다. 자동은 기기의 회전 설정을 따릅니다.', keywords: 'orientation rotate 방향 회전 세로 가로 고정',
    options: [{ value: 'auto', label: '자동' }, { value: 'portrait', label: '세로 고정' }, { value: 'landscape', label: '가로 고정' }],
    apply: (env, v) => { try { Promise.resolve(env.native?.setOrientation?.(v || 'auto')).catch(() => {}); } catch { /* older shell */ } } },
  { id: 'backAction', section: 'android', type: 'select', default: 'twice', platforms: ['android'], when: ctx => ctx.has('onBackButton'), label: '뒤로 버튼 동작', en: 'Back button', desc: '열려 있는 창이 없을 때 뒤로 버튼(또는 뒤로 제스처)이 할 일입니다. 창이 열려 있으면 언제나 그 창을 닫습니다.', keywords: 'back button gesture 뒤로 버튼 제스처 종료 나가기',
    options: [{ value: 'twice', label: '두 번 눌러 나가기' }, { value: 'exit', label: '바로 나가기' }, { value: 'none', label: '아무 동작 안 함' }] },

  // ---------- 웹 앱 (PWA)
  { id: 'pwaInstall', section: 'web', type: 'action', platforms: ['web'], when: ctx => !ctx.features.preview, label: '앱으로 설치', en: 'Install as app', desc: '홈 화면이나 시작 메뉴에 JSE를 추가해 주소 표시줄 없이 따로 실행합니다. 인터넷 없이도 열립니다.', keywords: 'install pwa 설치 홈 화면 추가 앱 바로가기',
    status: () => (installed || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ? '설치되어 실행 중입니다' : installEvent ? '설치할 수 있습니다' : ''),
    actions: [{ id: 'install', label: '설치…', primary: true, when: () => !(typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches), run: async env => {
      if (!installEvent) { env.toast('브라우저 메뉴에서 "앱 설치" 또는 "홈 화면에 추가"를 눌러 주세요. (이미 설치했거나 이 브라우저가 설치 버튼을 지원하지 않습니다)', 'info', { timeout: 7000 }); return; }
      try { const ev = installEvent; await ev.prompt(); const choice = await ev.userChoice; installEvent = null; if (choice?.outcome === 'accepted') { installed = true; env.toast('JSE를 설치했습니다', 'ok'); } }
      catch { env.toast('브라우저 메뉴에서 "앱 설치"를 눌러 주세요', 'info', { timeout: 6000 }); }
    } }] },
  { id: 'storagePersist', section: 'web', type: 'action', platforms: ['web'], when: ctx => ctx.features.storage, label: '저장 공간', en: 'Storage', desc: '자동 저장한 악보와 오프라인 파일이 쓰는 공간입니다. 영구 저장을 허용하면 기기 공간이 부족해도 브라우저가 지우지 않습니다.', keywords: 'storage persist quota 저장 공간 용량 영구 지워짐',
    status: () => storageText(),
    actions: [{ id: 'persist', label: '영구 저장 요청', when: (env) => env.ctx.features.persist, run: async env => { const ok = await navigator.storage.persist(); env.toast(ok ? '영구 저장이 허용되었습니다' : '브라우저가 아직 허용하지 않았습니다. 앱으로 설치하거나 자주 사용하면 허용됩니다.', ok ? 'ok' : 'info', { timeout: 6000 }); } }] },
  { id: 'clearCache', section: 'web', type: 'action', platforms: ['web'], when: ctx => ctx.features.caches && !ctx.features.preview, label: '오프라인 캐시', en: 'Offline cache', desc: '인터넷 없이 열 수 있게 받아 둔 앱 파일을 지웁니다. 악보와 설정은 그대로이고, 다음에 온라인으로 열 때 다시 받습니다.', keywords: 'cache offline 캐시 오프라인 지우기 초기화 새로 받기',
    status: async () => { try { const keys = (await caches.keys()).filter(k => k.startsWith('scoresnap-')); let n = 0; for (const k of keys) n += (await (await caches.open(k)).keys()).length; return keys.length ? `파일 ${n}개` : '비어 있음'; } catch { return ''; } },
    actions: [{ id: 'clear', label: '캐시 지우기', run: async env => { const keys = (await caches.keys()).filter(k => k.startsWith('scoresnap-')); await Promise.all(keys.map(k => caches.delete(k))); try { (await navigator.serviceWorker?.getRegistration?.())?.update(); } catch { /* offline */ } env.toast(keys.length ? '오프라인 캐시를 지웠습니다. 온라인에서 다시 열면 새로 받습니다.' : '지울 캐시가 없습니다', 'ok', { timeout: 5000 }); } }] },

  // ---------- 이 기기
  { id: 'devPlatform', section: 'device', type: 'info', label: '플랫폼', en: 'Platform', keywords: 'platform os 플랫폼 운영체제 기기', value: env => platformText(env.ctx) },
  { id: 'devVersion', section: 'device', type: 'info', label: '앱 버전', en: 'App version', keywords: 'version 버전', value: env => versionText(env) },
  { id: 'devScreen', section: 'device', type: 'info', label: '화면', en: 'Screen', keywords: 'screen resolution 화면 해상도 크기', value: () => screenText() },
  { id: 'devStorage', section: 'device', type: 'info', label: '저장 공간', en: 'Storage', keywords: 'storage 저장 공간 용량', when: ctx => ctx.features.storage, value: () => storageText() },
  { id: 'devEngine', section: 'device', type: 'info', label: '브라우저 엔진', en: 'Engine', keywords: 'browser engine chrome 브라우저 엔진 웹뷰', value: () => { const m = /(Edg|Chrome|Firefox|Version)\/([\d.]+)/.exec(navigator.userAgent); return m ? `${{ Edg: 'Edge', Version: 'Safari' }[m[1]] || m[1]} ${m[2]}` : '알 수 없음'; } },
  { id: 'devDiagnostics', section: 'device', type: 'action', label: '진단 정보', en: 'Diagnostics', desc: '문제를 알릴 때 붙여 넣을 수 있도록 버전·기기·바꾼 설정을 글자로 복사합니다. 악보 내용은 들어가지 않습니다.', keywords: 'diagnostics debug bug report 진단 오류 신고 복사 정보',
    actions: [{ id: 'copy', label: '진단 정보 복사', primary: true, run: async env => { const ok = await copyText(await diagnostics(env)); env.toast(ok ? '진단 정보를 복사했습니다' : '복사하지 못했습니다 (클립보드 권한이 없습니다)', ok ? 'ok' : 'warn'); } }] },

  // ---------- 고급
  { id: 'exportSettings', section: 'advanced', type: 'action', label: '설정 내보내기', en: 'Export settings', desc: '지금 설정을 파일(jse-settings.json)로 저장합니다. 다른 기기에서 가져올 수 있습니다.', keywords: 'export backup 내보내기 백업 설정 파일',
    actions: [{ id: 'export', label: '파일로 저장', run: async env => { const r = await saveBlob(new Blob([exportSettings(env.app.settings, { platform: env.ctx.platform, appVersion: env.ui?.version })], { type: 'application/json' }), 'jse-settings.json', { mime: 'application/json' }); if (r) env.toast('설정을 저장했습니다', 'ok'); } }] },
  { id: 'importSettings', section: 'advanced', type: 'action', label: '설정 가져오기', en: 'Import settings', desc: '내보낸 설정 파일을 불러와 지금 설정을 바꿉니다.', keywords: 'import restore 가져오기 복원 설정 파일',
    actions: [{ id: 'import', label: '파일 선택…', run: async env => {
      const files = await pickFiles({ accept: '.json,application/json' }); if (!files.length) return;
      try { const r = env.app.prefs.importText(await files[0].blob.text()); env.toast(`설정 ${r.applied}개를 가져왔습니다${r.skipped.length ? ` (건너뜀 ${r.skipped.length}개)` : ''}`, 'ok'); }
      catch (e) { env.toast('설정 파일을 읽지 못했습니다: ' + e.message, 'error', { timeout: 6000 }); }
    } }] },
  { id: 'resetAll', section: 'advanced', type: 'action', label: '모든 설정 초기화', en: 'Reset all settings', desc: '모든 설정을 처음 상태로 되돌립니다. 악보와 저장한 파일은 그대로입니다.', keywords: 'reset default 초기화 기본값 되돌리기 처음',
    actions: [{ id: 'reset', label: '초기화…', danger: true, run: async env => { if (await env.confirm('모든 설정 초기화', '모든 설정을 처음 상태로 되돌릴까요? 악보는 지워지지 않습니다.', '초기화')) { env.app.prefs.reset(null); env.toast('모든 설정을 기본값으로 되돌렸습니다', 'ok'); } } }] },
];

export const ITEMS = RAW_ITEMS.map(it => ({ key: it.id, ...it }));
const BY_ID = new Map(ITEMS.map(it => [it.id, it]));
export function itemById(id) { return BY_ID.get(id) || null; }
/** Items that hold a stored value (toggle / select / slider / color, and actions that declare a default). */
export const VALUE_ITEMS = ITEMS.filter(it => it.default !== undefined);

// ----------------------------------------------------------------------------- visibility
export function sectionOf(item, ctx) { return typeof item.section === 'string' ? item.section : (item.section[ctx.shell] || null); }
export function groupOf(item, ctx) { return typeof item.group === 'string' ? item.group : (item.group?.[ctx.shell] || ''); }
export function isVisible(item, ctx) {
  if (!sectionOf(item, ctx)) return false;
  if (item.platforms && !item.platforms.includes(ctx.shell)) return false;
  if (item.layouts && !item.layouts.includes(ctx.layout)) return false;
  if (item.touch && !ctx.touch) return false;
  if (item.mouse && ctx.layout === 'phone') return false;   // phones have no hover / wheel
  if (item.when && !item.when(ctx)) return false;
  return true;
}
export function visibleItems(ctx, sectionId = null) { return ITEMS.filter(it => isVisible(it, ctx) && (!sectionId || sectionOf(it, ctx) === sectionId)); }
export function labelOf(x, ctx, lang = getLang()) { const l = typeof x.label === 'function' ? x.label(ctx) : x.label; return lang === 'en' && x.en ? x.en : l; }
/** Sections that have at least one visible item, in display order: [{ id, label, icon, desc, items }]. */
export function visibleSections(ctx, lang = getLang()) {
  return SECTIONS.map(s => ({ ...s, label: labelOf(s, ctx, lang), items: visibleItems(ctx, s.id) })).filter(s => s.items.length);
}

// ----------------------------------------------------------------------------- values: defaults, coercion, migration
export function coerce(item, value) {
  if (item.coerce) return item.coerce(value);
  const def = clone(item.default);
  switch (item.type) {
    case 'toggle': return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : def;
    case 'select': { const o = item.options.find(o => o.value === value) || item.options.find(o => String(o.value) === String(value)); return o ? o.value : def; }
    case 'slider': {
      const n = Number(value); if (value === null || value === '' || !Number.isFinite(n)) return def;
      const c = Math.max(item.min, Math.min(item.max, n)); const k = Math.round((c - item.min) / item.step); return +(item.min + k * item.step).toFixed(4);
    }
    case 'color': return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : def;
    default: return typeof value === typeof def ? value : def;
  }
}
/** Every stored key with its default value (all platforms: a settings file moves between devices). */
export function defaultsFor() {
  const d = { _v: SETTINGS_VERSION };
  for (const it of VALUE_ITEMS) setPath(d, it.key, clone(it.default));
  // state the app keeps in the same object (not shown in the settings window)
  d.keymap = 'musescore'; d.mobileDurationBar = true;
  return d;
}
/**
 * Stored object (any older shape, possibly broken) → complete, valid settings.
 * Old keys keep their meaning; unknown keys are carried along untouched.
 */
export function migrate(stored) {
  const src = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const out = defaultsFor();
  for (const [k, v] of Object.entries(src)) if (k !== 'newScore' && k !== '_v') out[k] = clone(v);   // carry everything, validate below
  if (src.newScore && typeof src.newScore === 'object') out.newScore = { ...out.newScore, ...clone(src.newScore) };
  const ver = Number(src._v) || 1;
  if (ver < 2) {
    // v1 had one "초보자 안내" switch (tips) for both the simple palette and the hint bar
    if (src.hints === undefined && typeof src.tips === 'boolean') out.hints = src.tips;
  }
  for (const it of VALUE_ITEMS) { const cur = getPath(out, it.key); const fixed = coerce(it, cur); if (!same(cur, fixed)) setPath(out, it.key, fixed); }
  out._v = SETTINGS_VERSION;
  return out;
}

// ----------------------------------------------------------------------------- search
function norm(s) { return String(s || '').toLowerCase().replace(/[\s·.,()\-_/]+/g, ''); }
const low = s => String(s || '').toLowerCase();   // sentences keep their spaces: "…입니다. 크게" must not match "다크"
/** Find settings by words in the label, description, keywords, option names (also by 초성: "ㅌㅁ" → 테마). */
export function search(query, ctx, lang = getLang()) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
  if (!tokens.length) return [];
  const secLabel = new Map(SECTIONS.map(s => [s.id, labelOf(s, ctx, lang)]));
  const res = [];
  for (const it of visibleItems(ctx)) {
    const sid = sectionOf(it, ctx);
    const label = norm(labelOf(it, ctx, lang)), ko = norm(typeof it.label === 'string' ? it.label : ''), en = norm(it.en);
    const fields = [
      [label, 100], [ko, 100], [en, 90], [choseong(ko), 80], [low(it.keywords), 60], [norm(groupOf(it, ctx)), 40], [norm(secLabel.get(sid)), 35],
      [low((it.options || []).map(o => `${o.label} ${o.en || ''}`).join(' ')), 30], [low((it.actions || []).map(a => a.label).join(' ')), 30], [low(it.desc), 20],
    ];
    let score = 0, ok = true;
    for (const tk of tokens) {
      let best = 0;
      for (const [text, w] of fields) { const i = text.indexOf(tk); if (i >= 0) best = Math.max(best, w + (i === 0 ? 15 : 0)); }
      if (!best) { ok = false; break; }
      score += best;
    }
    if (ok) res.push({ item: it, section: sid, score });
  }
  return res.sort((a, b) => b.score - a.score || ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item));
}

// ----------------------------------------------------------------------------- export / import
export function exportSettings(settings, meta = {}) {
  return JSON.stringify({ format: 'jse-settings', version: SETTINGS_VERSION, app: 'JSE', exported: new Date().toISOString(), ...meta, settings: clone(settings) }, null, 2);
}
/** Parse an exported file → { values: { [itemId]: value }, extra: { textStyles? }, skipped: [key…] }. Throws on a file that is not a settings file. */
export function parseImport(text) {
  let data; try { data = JSON.parse(text); } catch { throw new Error('JSON 형식이 아닙니다'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('설정 파일이 아닙니다');
  if (data.format && data.format !== 'jse-settings') throw new Error('JSE 설정 파일이 아닙니다');
  const src = data.format ? data.settings : data;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('설정 내용이 없습니다');
  const full = migrate(src);
  const values = {}, skipped = [];
  for (const it of VALUE_ITEMS) if (getPath(src, it.key) !== undefined) values[it.id] = getPath(full, it.key);
  const known = new Set([...VALUE_ITEMS.map(it => it.key.split('.')[0]), '_v', 'keymap', 'mobileDurationBar', 'viewMode', 'lastPageView']);
  for (const k of Object.keys(src)) if (!known.has(k)) skipped.push(k);
  const extra = {};
  const ts = normalizeTextStyles(src.newScore?.textStyles);   // a settings file may come from anywhere: known keys, safe family names only
  if (ts) extra.textStyles = ts;
  return { values, extra, skipped };
}

// ----------------------------------------------------------------------------- manager (bound to the running app)
/** Applied in the App constructor, before anything is drawn. */
const EARLY = ['accent', 'reduceGlass', 'paperColor', 'hints', 'uiScale'];
export class SettingsManager {
  constructor(app) {
    this.app = app; this.ui = null;
    if (typeof document !== 'undefined') this.applyAppearance();
  }
  env(boot = false) {
    const ctx = this.ctx();
    return { app: this.app, ui: this.ui, native: ctx.native, root: typeof document !== 'undefined' ? document.documentElement : null, boot, ctx };
  }
  ctx() { return makeContext({ ui: this.ui }); }
  get(id) { const it = itemById(id); const v = getPath(this.app.settings, it ? it.key : id); return it?.unpack ? it.unpack(v) : v; }
  isDefault(id) { const it = itemById(id); return !it || it.default === undefined || same(getPath(this.app.settings, it.key), it.default); }
  /** Change one setting: validate → store → apply → notify (`app.emit('settings', { id, value })`). */
  set(id, value, { silent = false } = {}) {
    const it = itemById(id); if (!it || it.default === undefined) return false;
    const next = coerce(it, it.pack ? it.pack(value) : value);
    if (same(getPath(this.app.settings, it.key), next)) return false;
    setPath(this.app.settings, it.key, next);
    this.app.saveSettings();
    const env = this.env(false);
    if (this.applies(it, env.ctx)) { try { it.apply(env, next); } catch (e) { console.warn('setting apply failed', id, e); } }
    if (!silent) this.app.emit('settings', { id, value: next });
    return true;
  }
  /** Has an apply hook that makes sense on this platform (a value imported from another device may not). */
  applies(it, ctx) { const when = it?.applyWhen || it?.when; return !!it?.apply && (!it.platforms || it.platforms.includes(ctx.shell)) && (!when || !!when(ctx)); }
  /** Colours, scale and other things that must be right before the first paint. */
  applyAppearance() {
    const env = this.env(true), s = this.app.settings;
    for (const id of EARLY) { const it = itemById(id); if (this.applies(it, env.ctx)) { try { it.apply(env, getPath(s, id)); } catch { /* ignore */ } } }
  }
  /** Called once by the UI controller when the shell exists: push every value to where it is used. */
  attach(ui) {
    this.ui = ui;
    this.applyAll(true);
    this.bindEntrySound();
    document.addEventListener('visibilitychange', () => {
      const a = this.app;
      if (document.visibilityState === 'hidden' && a.dirty && a.settings.autosave && a.score) import('./io/storage.js').then(m => m.storage.saveDraft(a.score, { fileName: a.fileName })).catch(() => {});
    });
    if (typeof native()?.onBackButton === 'function') import('./ui/settings.js').then(m => m.bindNativeBack(this.app, ui)).catch(e => console.warn('back key', e));
    // desktop shell: Alt+F4 / taskbar close go through the same "save first?" question as the ✕ button
    try { native()?.onCloseRequest?.(() => { Promise.resolve(ui.requestClose()).catch(() => native()?.windowControls?.close()); }); } catch { /* older shell */ }
  }
  applyAll(boot = false) {
    const env = this.env(boot), ctx = env.ctx;
    for (const it of VALUE_ITEMS) {
      if (!this.applies(it, ctx)) continue;
      if (boot && (it.id === 'lang' || it.id === 'theme' || EARLY.includes(it.id))) continue;   // already done: main.js, the UI constructor, applyAppearance()
      try { it.apply(env, getPath(this.app.settings, it.key)); } catch (e) { console.warn('setting apply failed', it.id, e); }
    }
  }
  /** Restore defaults for the visible items of one section, or for everything (sectionId = null). */
  reset(sectionId = null) {
    const ctx = this.ctx(); const changed = [];
    if (!sectionId) {
      const keep = { viewMode: this.app.settings.viewMode, lastPageView: this.app.settings.lastPageView };
      for (const k of Object.keys(this.app.settings)) delete this.app.settings[k];
      Object.assign(this.app.settings, defaultsFor(), JSON.parse(JSON.stringify(keep)));
      this.app.saveSettings(); this.applyAll(false);
      this.app.emit('settings', { id: null, value: null });
      return ['*'];
    }
    for (const it of visibleItems(ctx, sectionId)) {
      if (it.default === undefined) continue;
      if (same(getPath(this.app.settings, it.key), it.default)) continue;
      setPath(this.app.settings, it.key, clone(it.default)); changed.push(it.id);
    }
    if (sectionId === 'newScore' && this.app.settings.newScore?.textStyles) { delete this.app.settings.newScore.textStyles; changed.push('newScore.textStyles'); }
    if (changed.length) {
      this.app.saveSettings();
      const env = this.env(false);
      for (const id of changed) { const it = itemById(id); if (this.applies(it, env.ctx)) { try { it.apply(env, getPath(this.app.settings, it.key)); } catch (e) { console.warn('setting apply failed', id, e); } } }
      this.app.emit('settings', { id: null, value: null, section: sectionId });
    }
    return changed;
  }
  exportText() { return exportSettings(this.app.settings, { platform: this.ctx().platform, appVersion: this.ui?.version }); }
  importText(text) {
    const { values, extra, skipped } = parseImport(text);
    let applied = 0;
    for (const [id, v] of Object.entries(values)) { const it = itemById(id); if (!same(getPath(this.app.settings, it.key), v)) { setPath(this.app.settings, it.key, clone(v)); applied++; } }
    if (extra.textStyles) { setPath(this.app.settings, 'newScore.textStyles', extra.textStyles); applied++; }
    this.app.saveSettings(); this.applyAll(false);
    this.app.emit('settings', { id: null, value: null });
    return { applied, skipped };
  }
  /** After the first document is on screen (main.js): things that need a score. */
  afterBoot() {
    if (this.app.settings.startTool === 'entry' && this.app.score) this.app.setTool('entry');
  }
  /** "입력할 때 소리 내기": play the note that was just entered (touch entry already auditions while sliding). */
  bindEntrySound() {
    if (this._soundBound) return; this._soundBound = true;
    const app = this.app;
    app.addEventListener('change', e => {
      if (e.detail?.label !== '입력' || app.settings.inputSound === false) return;
      setTimeout(async () => {
        const p = this.ui?.player; if (!p || p.playing) return;
        if (p.lastPreviewAt && performance.now() - p.lastPreviewAt < 350) return;   // already heard (slide entry, piano keys)
        const { findEvent, staffList, midiOf } = await import('./model/score.js');
        const f = app.lastInputId && findEvent(app.score, app.lastInputId); if (!f || f.ev.kind !== 'note') return;
        const sl = staffList(app.score)[f.staffIndex]; if (!sl) return;
        const note = f.ev.notes.find(n => app.lastPitch && n.step === app.lastPitch.step && n.octave === app.lastPitch.octave) || f.ev.notes[f.ev.notes.length - 1];
        if (sl.staff.type === 'percussion') p.preview(sl.staff.drumMap?.[note.drum]?.midi ?? 38, 0, 9);
        else p.preview(midiOf(note), sl.part.midiProgram || 0);
      }, 0);
    });
  }
}

/** Page settings (and text styles) a brand-new score starts with — from 새 악보 기본값. */
export function newScoreDefaults(settings) {
  const ns = settings?.newScore || {};
  const out = {};
  if (typeof ns.pageSize === 'string') out.pageSize = ns.pageSize;
  if (ns.orientation === 'portrait' || ns.orientation === 'landscape') out.orientation = ns.orientation;
  if (ns.marginsMm && typeof ns.marginsMm === 'object') out.marginsMm = { top: +ns.marginsMm.top || 15, bottom: +ns.marginsMm.bottom || 15, left: +ns.marginsMm.left || 15, right: +ns.marginsMm.right || 15 };
  if (Number(ns.staffSpaceMm) > 0) out.staffSpaceMm = Number(ns.staffSpaceMm);
  if (['system', 'all', 'none'].includes(ns.measureNumbers)) out.measureNumbers = ns.measureNumbers;
  const ts = normalizeTextStyles(ns.textStyles);   // written by the fonts dialog (ui/textstyle.js); same shape as score.settings.textStyles
  if (ts) out.textStyles = ts;
  return out;
}
