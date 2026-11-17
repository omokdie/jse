// Browser check, part 2 (desktop): editing, new-score defaults, recognition, files, update, web app,
// this device, advanced, start-up options and persistence across a reload.
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.JSE.app.settings)));
const open = async sec => { await page.evaluate(s => window.JSE.ui.settings(s), sec); await page.waitForTimeout(220); };
const close = async () => { await page.evaluate(() => document.querySelector('.st-x')?.click()); await page.waitForTimeout(150); };
const row = id => `.st-row[data-id="${id}"]`;
const seg = async (id, label) => { await page.click(`${row(id)} [role=radio]:has-text("${label}")`); await page.waitForTimeout(140); };
const toggle = async id => { await page.click(`${row(id)} .st-switch`); await page.waitForTimeout(140); };
const pick = async (id, value) => { await page.selectOption(`${row(id)} select`, String(value)); await page.waitForTimeout(160); };
const slide = async (id, value) => { await page.evaluate(([sel, v]) => { const i = document.querySelector(sel + ' input[type=range]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, [row(id), value]); await page.waitForTimeout(200); };
const statusOf = id => page.$eval(`${row(id)} .st-status`, e => e.textContent).catch(() => '');
const reload = async () => { await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(1300); };
const noPicker = () => page.evaluate(() => { try { delete window.showSaveFilePicker; } catch { /* ignore */ } });   // headless: no native save dialog → plain download
await noPicker();
try { await page.context().grantPermissions(['screen-wake-lock']); } catch (e) { console.log('  (wake-lock permission not granted: ' + e.message + ')'); }   // headless Chromium never prompts

// ---- 편집 · 입력
const wheel = (opts = {}) => page.evaluate(o => { const c = document.getElementById('canvas'), r = c.getBoundingClientRect(); const a = window.JSE.app; const z0 = a.zoom, t0 = c.scrollTop; c.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...o })); return { dz: a.zoom - z0, dt: c.scrollTop - t0 }; }, opts);
ok((await wheel()).dz === 0, 'wheel = scroll by default (no zoom)');
ok((await wheel({ ctrlKey: true })).dz > 0, 'Ctrl+wheel zooms');
await open('editing');
await seg('wheelMode', '확대·축소');
await close();
ok((await wheel()).dz > 0, 'wheel mode "zoom": plain wheel zooms');
await page.evaluate(() => { window.JSE.ui.view.setZoom(2.5); document.getElementById('canvas').scrollTop = 600; });
const sh = await wheel({ shiftKey: true });
ok(sh.dz === 0 && sh.dt < 0, `wheel mode "zoom": Shift+wheel scrolls (dt ${sh.dt})`);
await open('editing'); await seg('wheelMode', '스크롤'); await close();
await page.evaluate(() => { const a = window.JSE.app; a.newScore({ title: 't', instruments: ['voice'], measures: 4 }); window.JSE.ui.view.fit('width'); document.getElementById('canvas').scrollTo(0, 0); a.setTool('entry'); });
await page.waitForTimeout(300);
const spot = await page.evaluate(() => { const v = window.JSE.ui.view; const r = v.measureRect(1); const p = v.pageToClient(r.page, r.x + r.w * 0.5, r.y + r.h * 0.5); return p; });
await page.mouse.move(spot.x - 30, spot.y); await page.mouse.move(spot.x, spot.y); await page.waitForTimeout(150);
ok(await page.$('#main .overlay .ghost-glyph'), 'entry preview (ghost note) follows the mouse');
await page.evaluate(() => window.JSE.app.setSetting('entryGhost', false));
await page.mouse.move(spot.x - 20, spot.y + 4); await page.mouse.move(spot.x + 6, spot.y + 2); await page.waitForTimeout(150);
ok(!(await page.$('#main .overlay .ghost-glyph')), 'entry preview off: no ghost note');
await page.evaluate(() => window.JSE.app.setSetting('entryGhost', true));
const clickEntry = async () => {
  await page.evaluate(() => { const p = window.JSE.ui.player; window.__n = 0; window.__n0 = p.playNote.bind(p); p.playNote = () => { window.__n++; }; window.__u = window.JSE.app.history.undo.length; });
  await page.mouse.click(spot.x, spot.y); await page.waitForTimeout(200);
  return page.evaluate(() => { const p = window.JSE.ui.player; p.playNote = window.__n0; p.lastPreviewAt = 0; return { sounds: window.__n, entered: window.JSE.app.history.undo.length - window.__u }; });
};
let ce = await clickEntry();
ok(ce.entered >= 1 && ce.sounds >= 1, `a clicked note is entered and heard (${ce.sounds} sound)`);
await page.evaluate(() => window.JSE.app.setSetting('inputSound', false));
ce = await clickEntry();
ok(ce.entered >= 1 && ce.sounds === 0, 'sound on entry off: silent');
await page.evaluate(() => { window.JSE.app.setSetting('inputSound', true); window.JSE.app.setTool('select'); });

// ---- 새 악보 기본값
await open('newScore');
await page.screenshot({ path: OUT + 'st-desktop-newscore.png' });
await pick('newScore.pageSize', 'A5'); await seg('newScore.orientation', '가로'); await slide('newScore.marginsMm', 10); await slide('newScore.staffSpaceMm', 2); await seg('newScore.measureNumbers', '모든 마디');
ok(JSON.stringify((await st()).newScore) === JSON.stringify({ pageSize: 'A5', orientation: 'landscape', marginsMm: { top: 10, bottom: 10, left: 10, right: 10 }, staffSpaceMm: 2, measureNumbers: 'all' }), 'new-score defaults stored: ' + JSON.stringify((await st()).newScore));
ok(await page.$(row('newScoreFonts')), 'fonts row is shown (ui.textStyles exists)');
await close();
await page.evaluate(() => { window.JSE.app.dirty = false; window.JSE.ui.action('new'); }); await page.waitForTimeout(350);
await page.fill('#ns-title', '기본값 시험'); await page.click('.dialog footer .btn.primary'); await page.waitForTimeout(400);
const ns = await page.evaluate(() => { const s = window.JSE.app.score; return { title: s.meta.title, ...s.settings }; });
ok(ns.title === '기본값 시험' && ns.pageSize === 'A5' && ns.orientation === 'landscape' && ns.marginsMm.left === 10 && ns.staffSpaceMm === 2 && ns.measureNumbers === 'all', 'New-score dialog applies them: ' + JSON.stringify({ p: ns.pageSize, o: ns.orientation, m: ns.marginsMm, s: ns.staffSpaceMm, n: ns.measureNumbers }));
const pg = await page.evaluate(() => { const p = window.JSE.app.layout.pages[0]; return p.width > p.height; });
ok(pg, 'the engraved page is landscape');
await open('newScore'); await page.click('.st-reset'); await page.waitForTimeout(200);
ok(JSON.stringify((await st()).newScore) === JSON.stringify({ pageSize: 'A4', orientation: 'portrait', marginsMm: { top: 15, bottom: 15, left: 15, right: 15 }, staffSpaceMm: 1.75, measureNumbers: 'system' }), 'section reset restores new-score defaults');
await close();

// ---- 인식
await open('recognition');
await seg('omrParts', '피아노'); await toggle('omrLyrics'); await seg('audioMode', '멜로디'); await toggle('audioTriplets'); await toggle('audioChords');
await close();
const omr = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 200; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 120);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  let captured = null; const pm = Worker.prototype.postMessage; Worker.prototype.postMessage = function (msg, tr) { if (msg && msg.options) captured = msg.options; return pm.call(this, msg, tr); };
  window.JSE.ui.scan({ files: [{ name: 't.png', blob }] });
  await new Promise(r => setTimeout(r, 700));
  const parts = document.querySelector('#scan-parts')?.value;
  document.querySelector('.dialog [data-b=run]')?.click();
  await new Promise(r => setTimeout(r, 500));
  Worker.prototype.postMessage = pm;
  document.querySelector('.dialog header .x')?.click();
  return { parts, captured };
});
ok(omr.parts === '2', 'scan dialog starts with the chosen score type');
ok(omr.captured && omr.captured.lyrics === false && omr.captured.parts === 2, 'recognition runs without the lyric stage: ' + JSON.stringify(omr.captured));
await page.waitForTimeout(300);
const au = await page.evaluate(async () => { window.JSE.ui.audio(); await new Promise(r => setTimeout(r, 600)); const q = s => document.querySelector(s); const r = { mode: q('#au-mode')?.value, trip: q('#au-trip')?.checked, chords: q('#au-chords')?.checked }; q('.dialog header .x')?.click(); return r; });
ok(au.mode === 'melody' && au.trip === true && au.chords === false, 'audio dialog starts with the chosen defaults: ' + JSON.stringify(au));
await open('recognition'); await page.click('.st-reset'); await close();

// ---- 파일
const edit = () => page.evaluate(() => { const a = window.JSE.app; a.exec('테스트', s => { s.meta.subtitle = String(Math.random()); }); return window.JSE.ui._asT; });
const t1 = await edit(), t2 = await edit();
ok(t1 && t2 && t1 !== t2, 'autosave "고칠 때마다": the timer restarts with every edit');
await open('files'); await seg('autosaveDelay', '5초'); await close();
await page.waitForTimeout(1500);
const t3 = await edit(), t4 = await edit();
ok(t3 && t3 === t4, 'autosave every 5 s: one pending save, not restarted by further edits');
await open('files'); await seg('autosaveDelay', '고칠 때마다'); await toggle('autosave'); await close();
await page.waitForTimeout(100);
const dirtyText = await page.$eval('[data-state]', e => e.textContent);
ok((await st()).autosave === false && dirtyText === '수정됨', `autosave off: title shows "${dirtyText}"`);
await open('files'); await toggle('autosave');
const src = () => page.evaluate(() => { const a = window.JSE.app; a.score.sources = [{ id: 'src1', name: 'a.jpg', mime: 'image/jpeg', width: 1, height: 1, blob: new Blob(['x']) }]; return { file: window.JSE.ui.scoreForFile().sources.length, score: a.score.sources.length }; });
ok((await src()).file === 1, 'source photos are saved by default');
await toggle('saveSourcePhotos');
const s2 = await src();
ok(s2.file === 0 && s2.score === 1, 'source photos left out of the file (score itself untouched)');
await toggle('saveSourcePhotos');
await pick('exportFormat', 'png'); await seg('exportDpi', '600');
await close();
await page.evaluate(() => { window.JSE.app.score.sources = []; window.JSE.ui.exportDialog(); }); await page.waitForTimeout(400);
const ex = await page.evaluate(() => ({ fmt: document.querySelector('.dialog .card.on')?.dataset.f, dpi: document.querySelector('#ex-dpi button.on')?.dataset.v }));
ok(ex.fmt === 'png' && ex.dpi === '600', 'export dialog opens with the default format and resolution: ' + JSON.stringify(ex));
await page.click('.dialog header .x'); await page.waitForTimeout(150);

// ---- 업데이트
await open('update');
ok((await page.$eval(`${row('version')} .st-info`, e => e.textContent)).startsWith('v'), 'version shown');
await toggle('autoUpdate');
ok(await page.evaluate(() => window.JSE.ui.updater.auto === false), 'auto update off reaches the updater');
await toggle('autoUpdate');
await page.click(`${row('checkUpdate')} [data-act=check]`); await page.waitForTimeout(1500);
const us = await statusOf('checkUpdate');
ok(us.length > 0, `update check reports a status ("${us}")`);
ok(await page.$(`${row('releaseNotes')} [data-act=open]`), 'release notes action present');
await page.screenshot({ path: OUT + 'st-desktop-update.png' });

// ---- 웹 앱
await open('web');
await page.waitForTimeout(400);
ok((await statusOf('storagePersist')).includes('사용'), 'storage usage: ' + await statusOf('storagePersist'));
await page.click(`${row('storagePersist')} [data-act=persist]`); await page.waitForTimeout(300);
ok(await page.$('.toast'), 'persist request answered with a message');
await page.evaluate(async () => { const c = await caches.open('scoresnap-test'); await c.put('/x', new Response('x')); });
await open('device'); await open('web'); await page.waitForTimeout(300);
ok((await statusOf('clearCache')).startsWith('파일'), 'offline cache size: ' + await statusOf('clearCache'));
await page.click(`${row('clearCache')} [data-act=clear]`); await page.waitForTimeout(500);
ok(await page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('scoresnap-')).length) === 0, 'offline cache cleared');
ok((await statusOf('clearCache')) === '비어 있음', 'cache row refreshed after the action');
await toggle('keepScreenOn'); await page.waitForTimeout(300);
const wake = await page.evaluate(async () => (await import('./js/settings.js')).keepAwakeActive());
ok(wake === true, 'keep screen on holds a wake lock');
await toggle('keepScreenOn'); await page.waitForTimeout(200);
ok(await page.evaluate(async () => (await import('./js/settings.js')).keepAwakeActive()) === false, 'wake lock released');
await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; return Promise.resolve(); }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
await open('device'); await open('web'); await page.waitForTimeout(250);
ok((await statusOf('pwaInstall')) === '설치할 수 있습니다', 'install prompt captured');
await page.click(`${row('pwaInstall')} [data-act=install]`); await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__prompted === true), 'install button shows the browser prompt');
await page.screenshot({ path: OUT + 'st-desktop-web.png' });

// ---- 이 기기
await open('device'); await page.waitForTimeout(400);
const dev = await page.$$eval('.st-row[data-type=info] .st-info', els => els.map(e => e.textContent));
ok(dev.length >= 4 && dev.every(t => t && t !== '…'), 'device facts: ' + dev.join(' | '));
await page.click(`${row('devDiagnostics')} [data-act=copy]`); await page.waitForTimeout(400);
ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => /진단 정보를 복사했습니다|복사하지 못했습니다/.test(t.textContent))), 'diagnostics copy answered');
const diag = await page.evaluate(async () => { const m = await import('./js/settings.js'); const a = window.JSE.app; return m.diagnostics({ ...a.prefs.env(false) }); });
ok(/^JSE v/.test(diag) && diag.includes('바꾼 설정') && diag.includes('User-Agent') && !diag.includes('undefined'), 'diagnostics text is complete');
await page.screenshot({ path: OUT + 'st-desktop-device.png' });

// ---- 고급: export → change → import → reset all
await open('advanced');
await page.evaluate(() => { window.JSE.app.setSetting('volume', 35); window.JSE.app.setSetting('accent', '#1f9d55'); });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`${row('exportSettings')} [data-act=export]`)]);
const file = JSON.parse(await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8'));
ok(dl.suggestedFilename() === 'jse-settings.json' && file.format === 'jse-settings' && file.settings.volume === 35 && file.settings.accent === '#1f9d55', 'settings exported to jse-settings.json');
await page.evaluate(() => { window.JSE.app.setSetting('volume', 90); window.JSE.app.setSetting('accent', '#0a84ff'); });
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(`${row('importSettings')} [data-act=import]`)]);
await fc.setFiles({ name: 'jse-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
await page.waitForTimeout(500);
const imp = await st();
ok(imp.volume === 35 && imp.accent === '#1f9d55' && await page.evaluate(() => document.documentElement.getAttribute('data-accent')) === '#1f9d55', 'settings imported and applied');
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click(`${row('importSettings')} [data-act=import]`)]);
await fc2.setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') });
await page.waitForTimeout(400);
ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('읽지 못했습니다'))) && (await st()).volume === 35, 'a broken file is refused with a message');
await page.click(`${row('resetAll')} [data-act=reset]`); await page.waitForTimeout(250);
ok(await page.$('.dialog-backdrop'), 'reset all asks first');
await page.click('.dialog footer .btn.primary'); await page.waitForTimeout(350);
const def = await page.evaluate(async () => { const m = await import('./js/settings.js'); const d = m.defaultsFor(), s = window.JSE.app.settings; return m.VALUE_ITEMS.filter(it => JSON.stringify(m.getPath(s, it.key)) !== JSON.stringify(m.getPath(d, it.key))).map(it => it.id); });
ok(def.length === 0 && await page.evaluate(() => !document.documentElement.hasAttribute('data-accent')), 'everything back to defaults ' + JSON.stringify(def));
await close();

// ---- start-up options and persistence (reload)
await page.evaluate(() => { const a = window.JSE.app; a.setSetting('theme', 'dark'); a.setSetting('accent', '#a550dc'); a.setSetting('paperColor', 'cream'); a.setSetting('reduceGlass', true); a.setSetting('volume', 45); a.setSetting('metronome', true); a.setSetting('countIn', 2); a.setSetting('defaultView', 'grid'); a.setSetting('startTool', 'entry'); a.setSetting('startup', 'new'); a.setSetting('panelLeft', 'hide'); window.JSE.ui.settings('files'); });
await page.waitForTimeout(200); await close();
await reload();
const b1 = await page.evaluate(() => { const a = window.JSE.app, r = document.documentElement, p = window.JSE.ui.player; return { theme: r.classList.contains('theme-dark'), accent: r.getAttribute('data-accent'), paper: r.getAttribute('data-paper'), glass: r.classList.contains('jse-reduce-glass'), vol: p.volume, met: p.metronome, countIn: p.countIn, view: a.viewMode, mode: a.mode, title: a.score.meta.title, measures: a.score.measures.length, parts: a.score.parts.length, left: document.getElementById('body').classList.contains('hide-left'), welcome: !!document.querySelector('.welcome-cards') }; });
ok(b1.theme && b1.accent === '#a550dc' && b1.paper === 'cream' && b1.glass, 'appearance persists across a reload: ' + JSON.stringify(b1));
ok(Math.abs(b1.vol - 0.45) < 1e-6 && b1.met === true && b1.countIn === 2, 'player options persist');
ok(b1.view === 'grid', 'default view used at start-up');
ok(b1.mode === 'input', 'start tool: note entry');
ok(b1.title === '제목 없음' && b1.measures === 16 && b1.parts === 1 && !b1.welcome, 'start-up "새 악보": an empty score');
ok(b1.left === true, 'panel default applied at start-up');
await page.screenshot({ path: OUT + 'st-desktop-reloaded.png' });
await page.evaluate(() => window.JSE.ui.settings()); await page.waitForTimeout(250);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '파일', 'the last section is remembered');
await page.screenshot({ path: OUT + 'st-desktop-dark-glassoff.png' });
await close();
await page.evaluate(() => { window.JSE.app.setSetting('startup', 'welcome'); window.JSE.app.setSetting('startTool', 'select'); });
await reload();
ok(await page.$('.welcome-cards'), 'start-up "환영 화면": the welcome choices are shown');
await page.evaluate(() => document.querySelector('.dialog header .x')?.click());
await page.evaluate(() => { window.JSE.app.prefs.reset(null); });
await reload();
const b2 = await page.evaluate(() => ({ mode: window.JSE.app.mode, view: window.JSE.app.viewMode, welcome: !!document.querySelector('.welcome-cards'), dark: document.documentElement.classList.contains('theme-dark') }));
ok(b2.mode === 'select' && !b2.welcome && !b2.dark, 'defaults after reset all: ' + JSON.stringify(b2));

console.log(`settings/desktop B: ${passed} passed, ${fails.length} failed`);
