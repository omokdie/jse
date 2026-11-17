// Browser check of the settings window on a tablet layout (tools/e2e/shot.mjs … tablet | tablet-portrait | android-tablet).
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const wait = ms => page.waitForTimeout(ms);
const row = id => `.st-row[data-id="${id}"]`;
const vp = page.viewportSize(); const tag = vp.width > vp.height ? 'tablet' : vp.width < 760 ? 'tablet-narrow' : 'tablet-portrait';
ok(await page.evaluate(() => document.documentElement.dataset.layout) === 'tablet', 'tablet layout');
await page.tap('[data-act=settings]'); await wait(400);
ok(await page.$('.st-overlay[data-layout="tablet"]'), 'opens from the gear button');
const g = await page.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const n = r('.st-nav'), d = r('.st-detail'), w = r('.st-win'); return { nav: [n.left, n.width], detail: [d.left, d.width], win: [w.left, w.top, w.width, w.height], vw: innerWidth, vh: innerHeight }; });
ok(g.nav[1] >= 216 && g.nav[1] <= 301 && g.detail[0] >= g.nav[0] + g.nav[1] - 1 && g.detail[1] > g.nav[1], 'two panes: list left, detail right ' + JSON.stringify(g));
ok(g.win[0] >= 0 && g.win[1] >= 0 && g.win[0] + g.win[2] <= g.vw && g.win[1] + g.win[3] <= g.vh, 'the window fits the screen');
await page.tap('.st-cat[data-sec="display"]'); await wait(300);
const sizes = await page.evaluate(() => { const h = s => Math.min(...[...document.querySelectorAll(s)].map(e => e.getBoundingClientRect().height)); return { cat: h('.st-cat'), row: h('.st-row'), seg: h('.st-seg button'), select: h('.st-select'), x: h('.st-x'), search: h('.st-search input'), reset: h('.st-reset') }; });
ok(Object.values(sizes).every(v => v >= 44), 'touch targets are at least 44 px: ' + JSON.stringify(sizes));
await page.screenshot({ path: OUT + `st-${tag}-display.png` });
await page.tap(`${row('theme')} [role=radio]:has-text("어둡게")`); await wait(250);
ok(await page.evaluate(() => document.documentElement.classList.contains('theme-dark')), 'segmented choice by touch');
await page.tap(`${row('theme')} [role=radio]:has-text("자동")`);
await page.tap('.st-cat[data-sec="editing"]'); await wait(300);
const ids = await page.$$eval('.st-row', els => els.map(e => e.dataset.id));
ok(['wheelMode', 'entryGhost', 'touchSlideInput', 'longPressMs', 'haptics', 'penOnly'].every(i => ids.includes(i) || i === 'haptics'), 'tablet shows mouse, touch and pen options: ' + ids.join());
await page.tap(`${row('penOnly')} .st-switch`); await wait(250);
ok(await page.evaluate(() => window.JSE.app.settings.penOnly === true) && await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('펜 전용 입력을 켰습니다'))), 'pen-only switch + explanation');
await page.screenshot({ path: OUT + `st-${tag}-editing.png` });
await page.tap(`${row('penOnly')} .st-switch`);
// no control may stick out of its row in any section (narrow right pane on portrait tablets)
const clipped = [];
for (const sec of await page.$$eval('.st-cat', els => els.map(e => e.dataset.sec))) {
  await page.tap(`.st-cat[data-sec="${sec}"]`); await wait(200);
  clipped.push(...await page.evaluate(s => [...document.querySelectorAll('.st-detail .st-row')].flatMap(r => {
    const rr = r.getBoundingClientRect(), cs = getComputedStyle(r), lo = rr.left + parseFloat(cs.paddingLeft) - 0.6, hi = rr.right - parseFloat(cs.paddingRight) + 0.6;
    return [...r.querySelectorAll('.st-text, .st-ctl, .st-ctl > *, .st-seg button')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.left < lo || b.right > hi); }).map(e => `${s}/${r.dataset.id}/${e.className || e.tagName}`); }), sec));
}
ok(clipped.length === 0, 'every control stays inside its row: ' + clipped.join(', '));
await page.tap('.st-cat[data-sec="files"]'); await wait(250);
await page.screenshot({ path: OUT + `st-${tag}-files.png` });
await page.fill('.st-search input', '용지'); await wait(300);
ok(await page.$(row('newScore.pageSize')), 'search on the tablet');
await page.tap(`${row('newScore.pageSize')} .st-label`); await wait(400);
ok(await page.$eval('.st-detail-title h3', e => e.textContent) === '새 악보 기본값', 'tapping a result name jumps to its section');
await page.goBack(); await wait(350);
ok(!(await page.$('.st-overlay')), 'back closes the window (one level on a tablet)');
await page.evaluate(() => window.JSE.app.prefs.reset(null));
console.log(`settings/${tag}: ${passed} passed, ${fails.length} failed`);
