// Browser check of the settings window on a desktop layout (run through tools/e2e/shot.mjs, see README.md).
// Every option is changed through the real UI where possible and its effect is asserted.
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const st = () => page.evaluate(() => JSON.parse(JSON.stringify(window.JSE.app.settings)));
const open = async sec => { await page.evaluate(s => window.JSE.ui.settings(s), sec); await page.waitForTimeout(200); };
const close = async () => { await page.evaluate(() => document.querySelector('.st-x')?.click()); await page.waitForTimeout(120); };
const row = id => `.st-row[data-id="${id}"]`;
const seg = async (id, label) => { await page.click(`${row(id)} [role=radio]:has-text("${label}")`); await page.waitForTimeout(120); };
const toggle = async id => { await page.click(`${row(id)} .st-switch`); await page.waitForTimeout(120); };
const pick = async (id, value) => { await page.selectOption(`${row(id)} select`, String(value)); await page.waitForTimeout(150); };
const slide = async (id, value) => { await page.evaluate(([sel, v]) => { const i = document.querySelector(sel + ' input[type=range]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, [row(id), value]); await page.waitForTimeout(200); };
const css = (sel, prop) => page.evaluate(([s, p]) => { const el = s === ':root' ? document.documentElement : document.querySelector(s); return el ? getComputedStyle(el).getPropertyValue(p).trim() : null; }, [sel, prop]);

// ---- entry points
await page.evaluate(() => document.getElementById('canvas').focus());
await page.keyboard.press('Control+,');
await page.waitForTimeout(250);
ok(await page.$('.st-overlay[data-layout="desktop"] .st-win'), 'Ctrl+, opens the settings window');
ok(await page.evaluate(() => window.JSE.ui.dialogOpen()), 'editor shortcuts are off while settings are open');
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
ok(!(await page.$('.st-overlay')), 'Esc closes');
await page.click('[data-act=settings]'); await page.waitForTimeout(250);
ok(await page.$('.st-overlay'), 'gear button opens');
await page.keyboard.press('Control+,'); await page.waitForTimeout(150);
ok(!(await page.$('.st-overlay')), 'Ctrl+, closes again');
await page.click('[data-menu=help]'); await page.click('.menu button:has-text("설정")'); await page.waitForTimeout(250);
ok(await page.$('.st-overlay'), 'Help › 설정… opens');

// ---- keyboard: arrows walk the categories, Tab stays inside
await page.click('.st-cat[data-sec="general"]');
await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '화면', 'ArrowDown selects the next category');
await page.keyboard.press('End'); await page.waitForTimeout(120);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '고급', 'End jumps to the last category');
await page.keyboard.press('Home'); await page.waitForTimeout(120);
for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
ok(await page.evaluate(() => !!document.activeElement.closest('.st-win')), 'Tab is trapped in the window');

// ---- 화면
await open('display');
await seg('theme', '어둡게');
ok(await page.evaluate(() => document.documentElement.classList.contains('theme-dark')), 'theme → dark');
await page.screenshot({ path: OUT + 'st-desktop-dark.png' });
await seg('theme', '밝게');
ok(await page.evaluate(() => document.documentElement.classList.contains('theme-light')), 'theme → light');
await page.click(`${row('accent')} .st-swatch[data-v="#e5484d"]`); await page.waitForTimeout(450);   // (the category pill fades to the new colour)
ok((await css(':root', '--accent')) === '#e5484d', 'accent variable set (' + await css(':root', '--accent') + ')');
ok((await css('.st-cat[aria-selected="true"]', 'background-color')) === 'rgb(229, 72, 77)', 'accent used by the UI');
ok((await page.$eval(row('accent'), r => r.classList.contains('modified'))), 'changed row is marked');
await page.screenshot({ path: OUT + 'st-desktop-accent.png' });
await page.click(`${row('accent')} .st-row-reset`); await page.waitForTimeout(150);
ok((await st()).accent === '#0a84ff' && (await css(':root', '--accent')) === '#0a84ff', 'row reset restores the default accent');
await toggle('reduceGlass');
ok((await css(':root', '--blur')) === 'none' && await page.evaluate(() => document.documentElement.classList.contains('jse-reduce-glass')), 'reduce glass: no blur');
await toggle('reduceGlass');
await page.click(`${row('paperColor')} .st-swatch[data-v="ivory"]`); await page.waitForTimeout(150);
ok((await css('#main .page', 'background-color')) === 'rgb(251, 246, 233)', 'paper colour on the page');
ok((await css('#main .page rect.page-bg', 'fill')) === 'rgb(251, 246, 233)', 'paper colour on the engraved background');
const px = await page.evaluate(async () => { const { rasterizePage } = await import('./js/io/export.js'); const a = window.JSE.app; const c = await rasterizePage(a.layout.pages[0], { dpi: 40, spMm: a.layout.spMm }); return [...c.getContext('2d').getImageData(3, 3, 1, 1).data]; });
ok(px.join() === '255,255,255,255', 'exports stay white (' + px.join() + ')');
await close(); await page.screenshot({ path: OUT + 'st-desktop-paper.png' }); await open('display');
await page.click(`${row('paperColor')} .st-swatch[data-v="white"]`);
await pick('defaultView', 'grid');
ok(await page.evaluate(() => window.JSE.app.viewMode) === 'grid', 'default view applied now');
await pick('defaultView', 'vertical');
await pick('defaultZoom', '125');
ok(Math.abs(await page.evaluate(() => window.JSE.app.zoom) - 1.25) < 0.01, 'default zoom 125%');
await pick('defaultZoom', 'width');
await seg('panelLeft', '숨기기');
ok(await page.evaluate(() => document.getElementById('body').classList.contains('hide-left')), 'palette panel hidden');
await seg('panelLeft', '보이기');
ok(await page.evaluate(() => !document.getElementById('body').classList.contains('hide-left')), 'palette panel shown');
await seg('panelLeft', '자동');
await seg('panelRight', '숨기기');
ok(await page.evaluate(() => document.getElementById('body').classList.contains('hide-right')), 'properties panel hidden');
await seg('panelRight', '자동');

// ---- 일반
await open('general');
await toggle('hints');
ok(await page.evaluate(() => document.documentElement.classList.contains('jse-no-hints')) && (await css('.ob-hint', 'display')) === 'none', 'hints off hides the option-bar hint');
await toggle('hints');
const tabs0 = await page.$$eval('#left .tabs button', b => b.length);
await toggle('tips');
const tabs1 = await page.$$eval('#left .tabs button', b => b.length);
ok(tabs1 > tabs0, `simple mode off shows every palette tab (${tabs0} → ${tabs1})`);
await toggle('tips');
await seg('lang', 'English');
ok(await page.$eval('[data-menu=file]', e => e.textContent) === 'File', 'language → English');
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === 'General', 'settings window follows the language');
await seg('lang', '한국어');
ok(await page.$eval('[data-menu=file]', e => e.textContent) === '파일', 'language → Korean');
await page.click(`${row('clearRecent')} [data-act=clear]`); await page.waitForTimeout(300);
ok(await page.evaluate(async () => { const { storage } = await import('./js/io/storage.js'); await storage.addRecent({ id: 'a.ssnap', name: 'a.ssnap', title: 'A' }); return (await storage.recent()).length; }) === 1, 'recent list has one entry');
await open('advanced'); await open('general');
ok((await page.$eval(`${row('clearRecent')} .st-status`, e => e.textContent)) === '1개', 'recent count shown');
await page.click(`${row('clearRecent')} [data-act=clear]`); await page.waitForTimeout(400);
ok(await page.evaluate(async () => { const { storage } = await import('./js/io/storage.js'); return (await storage.recent()).length; }) === 0, 'recent list cleared');

// ---- search
await page.fill('.st-search input', '메트로놈'); await page.waitForTimeout(200);
ok(await page.$(row('metronome')), 'search finds 메트로놈');
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '검색 결과', 'results page');
await page.screenshot({ path: OUT + 'st-desktop-search.png' });
await page.keyboard.press('Enter'); await page.waitForTimeout(350);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '재생' && await page.$eval(row('metronome'), r => r.classList.contains('st-flash')), 'Enter jumps to the match');
await page.fill('.st-search input', 'ㅌㅁ'); await page.waitForTimeout(200);
ok(await page.$(row('theme')), '초성 search');
await page.fill('.st-search input', 'zzzz'); await page.waitForTimeout(200);
ok(await page.$('.st-empty'), 'empty result message');
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
ok(await page.$('.st-overlay') && (await page.$eval('.st-search input', e => e.value)) === '', 'Esc clears the search first');

// ---- 재생
await open('playback');
await toggle('metronome');
ok(await page.evaluate(() => window.JSE.ui.player.metronome === true), 'metronome on');
await seg('countIn', '한 마디');
await slide('volume', 30);
ok(await page.evaluate(() => Math.abs(window.JSE.ui.player.volume - 0.3) < 1e-6), 'volume 30%');
await slide('playbackSpeed', 50);
ok(await page.evaluate(() => window.JSE.ui.player.tempoScale === 0.5), 'speed 50%');
const play = await page.evaluate(async () => {
  const p = window.JSE.ui.player, clicks = [], notes = []; let scrolled = 0;
  const c0 = p.click.bind(p), n0 = p.playNote.bind(p), v = window.JSE.ui.view, s0 = v.scrollToMeasure.bind(v);
  p.click = (when, accent) => { clicks.push([when, accent]); }; p.playNote = (n, when) => { notes.push(when); }; v.scrollToMeasure = () => { scrolled++; };
  p.metronome = false; p.play(0);
  const now = p.ctx.currentTime, lead = p.startAt - now, pos0 = p.position;
  await new Promise(r => setTimeout(r, 400));
  const pos1 = p.position; p.pause(); const off = p.offset; p.stop();
  p.click = c0; p.playNote = n0; v.scrollToMeasure = s0;
  const ts = window.JSE.app.score.measures[0].timeSig, bpm = window.JSE.app.score.measures[0].tempo?.bpm || 120;
  return { n: clicks.length, accents: clicks.filter(c => c[1]).length, lead, beat: 60 / bpm / 0.5, num: ts.num, pos0, pos1, off, firstNote: Math.min(...notes) - p.startAt };
});
ok(play.n === play.num && play.accents === 1, `count-in: ${play.n} clicks for a ${play.num}/x bar, first accented`);
ok(Math.abs(play.lead - (0.08 + play.num * play.beat)) < 0.05, `music starts after the count-in (${play.lead.toFixed(2)}s, beat ${play.beat.toFixed(2)}s at half speed)`);
ok(play.pos0 === 0 && play.pos1 === 0 && play.off === 0, 'position waits at the start during the count-in');
await seg('countIn', '없음');
await toggle('followPlayback');
const follow = await page.evaluate(async () => {
  const ui = window.JSE.ui, p = ui.player, v = ui.view; let scrolled = 0; const s0 = v.scrollToMeasure.bind(v); const n0 = p.playNote.bind(p);
  v.scrollToMeasure = () => { scrolled++; }; p.playNote = () => {};
  p.play(0); await new Promise(r => setTimeout(r, 500)); const off = scrolled; p.stop();
  window.JSE.app.settings.followPlayback = true; p.play(0); await new Promise(r => setTimeout(r, 500)); const on = scrolled - off; p.stop();
  window.JSE.app.settings.followPlayback = false; v.scrollToMeasure = s0; p.playNote = n0; return { off, on };
});
ok(follow.off === 0 && follow.on > 0, `follow playback gate (off ${follow.off}, on ${follow.on})`);
await toggle('followPlayback');
await page.click('.st-reset'); await page.waitForTimeout(250);
const s1 = await st();
ok(s1.metronome === false && s1.volume === 80 && s1.playbackSpeed === 100 && s1.countIn === 0, 'section reset restores 재생');
ok(await page.evaluate(() => { const p = window.JSE.ui.player; return p.metronome === false && Math.abs(p.volume - 0.8) < 1e-6 && p.tempoScale === 1 && p.countIn === 0; }), 'reset is applied to the player');
await page.click('.toast button:has-text("되돌리기")'); await page.waitForTimeout(250);
ok((await st()).volume === 30 && await page.evaluate(() => Math.abs(window.JSE.ui.player.volume - 0.3) < 1e-6), 'undo of the reset');
await page.click('.st-reset'); await page.waitForTimeout(200);
await close();
await page.evaluate(() => window.JSE.ui.action('metronome')); await page.waitForTimeout(100);
ok((await st()).metronome === true, 'metronome button outside the window is remembered');
await page.evaluate(() => window.JSE.ui.action('metronome'));

console.log(`settings/desktop A: ${passed} passed, ${fails.length} failed`);
