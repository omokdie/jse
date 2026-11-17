// Browser check of the settings pages on a phone layout (tools/e2e/shot.mjs … mobile): pages, bottom sheets,
// one-level-back through the browser history (= Android back gesture in the PWA), touch / pen options.
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.JSE.app.settings)));
const row = id => `.st-row[data-id="${id}"]`;
const level = () => page.evaluate(() => document.querySelector('.st-win')?.dataset.level || null);
const depth = () => page.evaluate(async () => (await import('./js/native.js')).backDepth());
const wait = ms => page.waitForTimeout(ms);
const cdp = await page.context().newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) });
const pen = (type, x, y, buttons = 1) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'pen' });

// ---- open from the ⋯ menu: full-screen pages
await page.tap('[data-act=mobileMore]'); await page.tap('.menu button:has-text("설정")'); await wait(450);
ok(await page.$('.st-overlay[data-layout="phone"]') && (await level()) === 'nav', 'opens as a full-screen category list');
const box = await page.$eval('.st-win', e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, innerWidth, innerHeight]; });
ok(box[0] === 0 && box[1] === 0 && box[2] === box[4] && box[3] === box[5], 'covers the whole screen');
ok((await depth()) === 1, 'one back level registered');
await page.screenshot({ path: OUT + 'st-phone-nav.png' });
const catH = await page.$$eval('.st-cat', els => Math.min(...els.map(e => e.getBoundingClientRect().height)));
ok(catH >= 56, `category rows are large (${catH}px)`);
await page.tap('.st-cat[data-sec="display"]'); await wait(450);
ok((await level()) === 'detail' && await page.$eval('.st-detail-title h3', e => e.textContent) === '화면' && (await depth()) === 2, 'tapping a category pushes its page');
const sizes = await page.evaluate(() => ({ row: Math.min(...[...document.querySelectorAll('.st-row')].map(e => e.getBoundingClientRect().height)), sw: document.querySelector('.st-switch').getBoundingClientRect().height, back: document.querySelector('.st-back').getBoundingClientRect().width, swatch: document.querySelector('.st-swatch').getBoundingClientRect().width }));
ok(sizes.row >= 56 && sizes.back >= 44 && sizes.swatch >= 36, 'touch sized rows and buttons ' + JSON.stringify(sizes));
// choices open as a bottom sheet
await page.tap(row('theme')); await wait(350);
ok(await page.$('.st-sheet') && (await depth()) === 3, 'a choice opens a bottom sheet');
await page.screenshot({ path: OUT + 'st-phone-sheet.png' });
await page.tap('.st-sheet [role=radio]:has-text("어둡게")'); await wait(350);
ok(!(await page.$('.st-sheet')) && (await st()).theme === 'dark' && await page.$eval(`${row('theme')} .st-value span`, e => e.textContent) === '어둡게', 'picking closes the sheet and applies');
ok((await depth()) === 2, 'the sheet level is gone again');
await page.screenshot({ path: OUT + 'st-phone-dark.png' });
// whole row toggles
await page.tap(`${row('reduceGlass')} .st-text`); await wait(200);
ok((await st()).reduceGlass === true, 'tapping anywhere on a switch row toggles it');
await page.tap(`${row('reduceGlass')} .st-switch`); await wait(200);
ok((await st()).reduceGlass === false, 'the switch itself toggles too (once)');
// ---- back, one level at a time (browser history = Android back gesture / key in a PWA)
await page.tap(row('theme')); await wait(300);
await page.goBack(); await wait(350);
ok(!(await page.$('.st-sheet')) && (await level()) === 'detail' && await page.$('.st-overlay'), 'back closes the sheet only');
await page.goBack(); await wait(350);
ok((await level()) === 'nav' && await page.$('.st-overlay'), 'back returns to the category list');
await page.goBack(); await wait(350);
ok(!(await page.$('.st-overlay')) && (await depth()) === 0, 'back closes the settings');
ok(await page.evaluate(() => !!window.JSE.app.score && !window.JSE.ui.dialogOpen()), 'the editor is still there and active');
// closing from the UI keeps history and stack in step
await page.evaluate(() => window.JSE.ui.settings()); await wait(350);
await page.tap('.st-cat[data-sec="general"]'); await wait(350);
await page.tap('.st-back'); await wait(350);
ok((await level()) === 'nav' && (await depth()) === 1, 'the back arrow goes up one level');
await page.tap('.st-cat[data-sec="playback"]'); await wait(350);
ok((await level()) === 'detail' && (await depth()) === 2, 'another page can be opened straight away');
await page.tap('.st-back'); await wait(300); await page.tap('.st-nav-close'); await wait(400);
ok(!(await page.$('.st-overlay')) && (await depth()) === 0, 'the arrow on the list closes the settings');
ok(await page.evaluate(() => history.state === null), 'history is back on the entry it started from (the next back press leaves the page as usual)');
// ui.settings(section) while the list is showing goes to that page (menu actions, links from toasts)
await page.evaluate(() => window.JSE.ui.settings()); await wait(350);
await page.evaluate(() => window.JSE.ui.settings('files')); await wait(400);
ok((await level()) === 'detail' && await page.$eval('.st-detail-title h3', e => e.textContent) === '파일' && (await depth()) === 2, 'ui.settings(section) enters the page from the list');
await page.evaluate(() => window.JSE.ui.settings('playback')); await wait(400);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '재생' && (await depth()) === 2, 'a second call swaps the page without stacking another back level');
await page.goBack(); await wait(350);
ok((await level()) === 'nav', 'back from there returns to the list');
await page.goBack(); await wait(350);
ok(!(await page.$('.st-overlay')) && (await depth()) === 0, 'and one more closes the settings');
// opened directly on a section (e.g. from a link): back leaves in two steps
await page.evaluate(() => window.JSE.ui.settings('editing')); await wait(400);
ok((await level()) === 'detail' && (await depth()) === 2, 'opening a section directly shows its page');
await page.screenshot({ path: OUT + 'st-phone-editing.png' });
const phoneIds = await page.$$eval('.st-row', els => els.map(e => e.dataset.id));
ok(['touchSlideInput', 'longPressMs', 'haptics', 'penOnly'].every(i => phoneIds.includes(i)) && !phoneIds.includes('wheelMode') && !phoneIds.includes('entryGhost'), 'touch options shown, mouse options hidden: ' + phoneIds.join(','));
await page.goBack(); await wait(300); await page.goBack(); await wait(300);
ok(!(await page.$('.st-overlay')), 'closed by two back presses');
// ---- search on the phone
await page.evaluate(() => window.JSE.ui.settings()); await wait(350);
await page.fill('.st-search input', '진동'); await wait(350);
ok((await level()) === 'detail' && await page.$(row('haptics')), 'search results are a page of their own');
await page.screenshot({ path: OUT + 'st-phone-search.png' });
await page.tap(`${row('haptics')} .st-text`); await wait(250);
ok((await st()).haptics === false && await page.$eval('.st-detail-title h3', e => e.textContent) === '검색 결과', 'a result row is the live control (tap toggles)');
await page.tap(`${row('haptics')} .st-text`); await wait(250);
await page.tap('.st-jump'); await wait(400);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '편집 · 입력' && await page.$eval(row('haptics'), r => r.classList.contains('st-flash')), 'the section heading of a result jumps to its place');
await page.goBack(); await wait(350);
ok((await level()) === 'nav' && (await page.$eval('.st-search input', e => e.value)) === '', 'back from there returns to the list');
ok(!(await page.evaluate(() => [...document.querySelectorAll('.st-cat')].some(c => c.dataset.sec === 'windows' || c.dataset.sec === 'android'))), 'no Windows / Android-app pages in a browser');
await page.goBack(); await wait(300);
await page.evaluate(() => { window.JSE.app.setSetting('theme', 'auto'); });

// ---- touch options really change the editor
const prep = async () => { await page.evaluate(() => { const a = window.JSE.app; a.dirty = false; a.newScore({ title: 't', instruments: ['voice'], measures: 4 }); a.setTool('entry'); document.getElementById('canvas').scrollTo(0, 0); }); await wait(500); return page.evaluate(() => { const v = window.JSE.ui.view; const r = v.measureRect(0); return v.pageToClient(r.page, r.x + r.w * 0.6, r.y + r.h * 0.5); }); };
const notes = () => page.evaluate(() => { const out = []; for (const m of window.JSE.app.score.measures) for (const e of m.staves[0].voices[0]) if (e.kind === 'note') out.push(e.notes[0].step + e.notes[0].octave); return out; });
let p = await prep();
await touch('touchStart', [[p.x, p.y]]); await wait(60);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[p.x, p.y - i * 6]]); await wait(20); }
ok(await page.$('#main .overlay .ghost-glyph'), 'press and slide: the preview note follows the finger');
await touch('touchEnd', []); await wait(250);
const slid = await notes();
ok(slid.length === 1, 'press and slide enters the note on release: ' + slid.join(' '));
await page.evaluate(() => window.JSE.app.setSetting('touchSlideInput', false));
p = await prep();
const top0 = await page.evaluate(() => document.getElementById('canvas').scrollTop);
await touch('touchStart', [[p.x, p.y]]); await wait(60);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[p.x, p.y - i * 6]]); await wait(20); }
ok(!(await page.$('#main .overlay .ghost-glyph')), 'slide entry off: no preview while dragging');
await touch('touchEnd', []); await wait(250);
ok((await notes()).length === 0, 'slide entry off: dragging does not enter a note');
await page.touchscreen.tap(p.x, p.y); await wait(300);
ok((await notes()).length === 1, 'slide entry off: a tap enters the note where it was touched');
await page.evaluate(() => window.JSE.app.setSetting('touchSlideInput', true));
// long-press time + haptics
await page.evaluate(() => { window.JSE.app.setTool('select'); window.__vib = []; navigator.vibrate = (...a) => { window.__vib.push(a); return true; }; });
const notePos = await page.evaluate(() => { const g = document.querySelector('#main .page g.ev'); const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
// (holds are spaced out: two short presses on the same note in quick succession would be a double tap = "edit this note")
const hold = async ms => { await wait(650); await page.evaluate(() => { window.JSE.ui.hideContextMenu(); window.JSE.ui.hideMini(); window.JSE.app.clearSelection(); }); await touch('touchStart', [[notePos.x, notePos.y]]); await wait(ms); const menu = !!(await page.$('#layer .menu')); await touch('touchEnd', []); await wait(150); await page.evaluate(() => window.JSE.ui.hideContextMenu()); return menu; };
await page.evaluate(() => window.JSE.app.setSetting('longPressMs', 300));
ok(await hold(480), 'long press 300 ms: the menu opens after a short hold');
ok(await page.evaluate(() => window.__vib.length) >= 1, 'haptic tick on long press');
await page.evaluate(() => { window.JSE.app.setSetting('longPressMs', 1000); window.__vib = []; });
ok(!(await hold(480)), 'long press 1000 ms: the same hold is not long enough');
await page.evaluate(() => { window.JSE.app.setSetting('longPressMs', 300); window.JSE.app.setSetting('haptics', false); window.__vib = []; });
const h3 = await hold(480), v3 = await page.evaluate(() => ({ n: window.__vib.length, mode: window.JSE.app.mode, tool: window.JSE.app.tool }));
ok(h3 && v3.n === 0, 'haptics off: no vibration ' + JSON.stringify({ menu: h3, ...v3 }));
await page.evaluate(() => { window.JSE.app.setSetting('haptics', true); window.JSE.app.setSetting('longPressMs', 550); });
// pen-only editing
const sel = () => page.evaluate(() => window.JSE.app.selection.type);
await page.evaluate(() => window.JSE.app.clearSelection());
await page.touchscreen.tap(notePos.x, notePos.y); await wait(250);
ok((await sel()) === 'events', 'a finger tap selects a note (pen-only off)');
await page.evaluate(() => { window.JSE.ui.hideMini(); window.JSE.app.clearSelection(); window.JSE.app.setSetting('penOnly', true); });
await page.touchscreen.tap(notePos.x, notePos.y); await wait(300);
ok((await sel()) === 'none', 'pen-only: a finger tap edits nothing');
ok(await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('펜 전용 입력') && t.querySelector('button'))), 'pen-only: the tap is explained, with a way to switch it off');
const z0 = await page.evaluate(() => window.JSE.app.zoom);
await touch('touchStart', [[120, 400], [280, 400]]); await wait(40); await touch('touchMove', [[90, 400], [310, 400]]); await wait(40); await touch('touchMove', [[60, 400], [340, 400]]); await wait(40); await touch('touchEnd', []); await wait(200);
ok(await page.evaluate(() => window.JSE.app.zoom) > z0, 'pen-only: two fingers still zoom');
await page.evaluate(() => { window.JSE.ui.view.fit('width'); document.getElementById('canvas').scrollTo(0, 0); }); await wait(500);
const np = await page.evaluate(() => { const g = document.querySelector('#main .page g.ev'); const r = g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await pen('mousePressed', np.x, np.y); await pen('mouseReleased', np.x, np.y, 0); await wait(300);
ok((await sel()) === 'events', 'pen-only: the pen selects / edits');
// palm on the screen while the pen is down: ignored
await page.evaluate(() => { window.JSE.app.clearSelection(); window.JSE.ui.hideMini(); });
const zz = await page.evaluate(() => window.JSE.app.zoom);
await pen('mousePressed', np.x, np.y);
await touch('touchStart', [[200, 600]]); await wait(30); await touch('touchMove', [[230, 560]]); await wait(30); await touch('touchEnd', []);
await pen('mouseReleased', np.x, np.y, 0); await wait(300);
ok((await sel()) === 'events' && await page.evaluate(() => window.JSE.app.zoom) === zz, 'pen-only: a palm touching while the pen is down changes nothing');
await page.evaluate(() => [...document.querySelectorAll('.toast button')].find(b => b.textContent === '끄기')?.click()); await wait(200);
ok((await st()).penOnly === false, 'the "끄기" button of the hint switches pen-only off');
await page.evaluate(() => { window.JSE.app.prefs.reset(null); window.JSE.app.dirty = false; });

console.log(`settings/phone: ${passed} passed, ${fails.length} failed`);
