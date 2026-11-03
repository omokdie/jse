// JSE bootstrap.
import { App } from './app.js';
import { UI } from './ui/ui.js';
import { storage } from './io/storage.js';
import { setLang } from './i18n.js';
import { exampleScore } from './model/examples.js';
import { GLYPHS } from './engrave/glyphs.js';
import { isMobileLayout } from './native.js';

const FALLBACK_VERSION = '1.0.0';

function injectGlyphSprite() {
  // One shared <defs> for all on-screen pages/thumbnails so <use href="#g-…"> always resolves.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>${Object.entries(GLYPHS).map(([n, g]) => `<path id="g-${n}" d="${g.p}"/>`).join('')}</defs></svg>`;
  document.body.insertAdjacentHTML('afterbegin', svg);
}

async function readVersion() {
  try { const r = await fetch('version.json', { cache: 'no-cache' }); if (r.ok) { const v = await r.json(); return v.version || FALLBACK_VERSION; } } catch { /* offline first run */ }
  return FALLBACK_VERSION;
}

async function boot() {
  injectGlyphSprite();
  const version = await readVersion();
  const app = new App();
  setLang(app.settings.lang || 'ko');
  window.JSE = { app };                 // handy for debugging & native shells
  const ui = new UI(app, { version });
  window.JSE.ui = ui;

  // initial document: autosaved draft → else the example score
  let restored = false;
  try {
    const draft = app.settings.autosave ? await storage.loadDraft() : null;
    if (draft?.score?.measures?.length) {
      app.setScore(draft.score, { fileName: draft.meta?.fileName || null });
      restored = true;
    }
  } catch (e) { console.warn('draft restore failed', e); }
  if (!restored) app.setScore(exampleScore(), { fileName: null });

  // view defaults: phones get the continuous (reflow) view, desktops the page view
  const mode = isMobileLayout() ? 'reflow' : (app.settings.viewMode && app.settings.viewMode !== 'reflow' ? app.settings.viewMode : 'vertical');
  ui.view.setViewMode(mode);
  if (mode !== 'reflow') ui.view.fit('width');
  ui.updateMode(); ui.updateHint(); ui.renderInputbar(); ui.updateTitle(); ui.renderPanels(); ui.updateStatus();
  document.getElementById('app').setAttribute('aria-busy', 'false');

  if (restored) ui.toast('이전에 작업하던 악보를 불러왔습니다', 'info', { action: { label: '새로 시작', onClick: () => ui.action('new') } });

  // files handed to the PWA by the OS (file_handlers) or via ?action= shortcuts
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map(async h => ({ name: h.name, blob: await h.getFile(), handle: h })));
      ui.openFiles(files);
    });
  }
  const action = new URLSearchParams(location.search).get('action');
  if (action === 'scan') ui.scan(); else if (action === 'new') ui.action('new');
  else if (!restored) ui.welcome();

  const chip = document.querySelector('[data-act=update]');
  ui.updater.addEventListener('status', e => {
    const s = e.detail; if (!chip) return;
    const txt = { checking: '업데이트 확인 중', available: `새 버전 ${s.version || ''}`, downloading: `업데이트 받는 중${s.percent ? ' ' + Math.round(s.percent) + '%' : ''}`, ready: '다시 시작하면 업데이트', done: `업데이트 완료 v${s.version || ''}`, error: '업데이트 확인 실패' }[s.state];
    chip.hidden = !txt;
    chip.className = 'update-chip desktop-only ' + ({ checking: 'busy', available: 'busy', downloading: 'busy', ready: 'ready', done: 'ok', error: '' }[s.state] || '');
    chip.querySelector('[data-update-text]').textContent = txt || '';
    if (s.state === 'done') setTimeout(() => { chip.hidden = true; }, 15000);
  });

  ui.updater.start();

  window.addEventListener('unhandledrejection', e => { console.error(e.reason); });
}

boot().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 16px 16px 16px;padding:14px 18px;border-radius:14px;background:#fff;color:#b42318;font:14px sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:999">JSE를 시작하지 못했습니다: ${String(err.message || err)}</div>`);
});
