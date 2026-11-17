// 글꼴 dialog: cancel restores the SVG exactly, 확인 = one undo step, undo restores, 기본값으로 / 새 악보 기본값으로 저장.
// run: INIT=<script that sets localStorage ssnap.welcomed> node tools/e2e/shot.mjs http://localhost:8765/ tools/out/x.png desktop tools/fonts/e2e/dialog.js
const svg0 = await page.evaluate(() => window.JSE.app.layout.pages[0].svg);
// --- cancel restores
await page.evaluate(() => { window.JSE.ui.textStyles('title'); });
await page.waitForSelector('.ts-dialog');
await page.click('.ts-row[data-key=title] .ts-font');
await page.click('.ts-picker .ts-opt[data-family="Gowun Batang"]');
await page.click('.ts-row[data-key=title] [data-ts=bold]');
await page.waitForTimeout(900);
const mid = await page.evaluate(() => ({ ts: window.JSE.app.score.settings.textStyles, dirty: window.JSE.app.dirty, undo: window.JSE.app.history.undo.length }));
await page.click('.ts-dialog footer .btn:not(.primary)');
await page.waitForTimeout(300);
const afterCancel = await page.evaluate((s0) => ({ ts: window.JSE.app.score.settings.textStyles, same: window.JSE.app.layout.pages[0].svg === s0, undo: window.JSE.app.history.undo.length, open: !!document.querySelector('.ts-dialog') }), svg0);
console.log('mid', JSON.stringify(mid), '\ncancel', JSON.stringify(afterCancel));
// --- OK = one undo step; undo restores exactly
await page.evaluate(() => { window.JSE.ui.textStyles(); });
await page.waitForSelector('.ts-dialog');
await page.click('.ts-row[data-key=lyrics] .ts-font');
await page.waitForSelector('.ts-picker');
await page.evaluate(() => { const l = document.querySelector('.ts-picker-list'); l.scrollTop = l.scrollHeight; });
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/out/fonts-d4-picker-jse.png' });
await page.click('.ts-picker .ts-opt[data-family="Nanum Myeongjo"]');
await page.fill('.ts-row[data-key=lyrics] [data-ts=size]', '13');
await page.press('.ts-row[data-key=lyrics] [data-ts=size]', 'Enter');
await page.selectOption('.ts-row[data-key=title] [data-ts=preset]', '32');
await page.click('.ts-row[data-key=text] [data-ts=bold]');
await page.waitForTimeout(900);
const stillOpen = await page.evaluate(() => !!document.querySelector('.ts-dialog'));
await page.click('.ts-dialog footer .btn.primary');
await page.waitForTimeout(600);
const afterOk = await page.evaluate(() => ({ ts: window.JSE.app.score.settings.textStyles, undo: window.JSE.app.history.undo.map(u => u.label), dirty: window.JSE.app.dirty }));
await page.screenshot({ path: 'tools/out/fonts-d4-applied.png' });
await page.evaluate(() => window.JSE.app.undo());
await page.waitForTimeout(300);
const afterUndo = await page.evaluate((s0) => ({ ts: window.JSE.app.score.settings.textStyles, same: window.JSE.app.layout.pages[0].svg === s0, undo: window.JSE.app.history.undo.length }), svg0);
await page.evaluate(() => window.JSE.app.redo());
await page.waitForTimeout(300);
// --- reset + save as default
await page.evaluate(() => { window.JSE.ui.textStyles(); });
await page.waitForSelector('.ts-dialog');
await page.click('.ts-dialog [data-a=default]');
const ns = await page.evaluate(() => JSON.parse(localStorage.getItem('ssnap.settings')).newScore);
await page.click('.ts-dialog [data-a=reset]');
await page.waitForTimeout(400);
const rows = await page.$$eval('.ts-row .ts-font-name', els => els.map(e => e.textContent));
await page.click('.ts-dialog footer .btn.primary');
await page.waitForTimeout(400);
const afterReset = await page.evaluate((s0) => ({ ts: window.JSE.app.score.settings.textStyles, same: window.JSE.app.layout.pages[0].svg === s0, undo: window.JSE.app.history.undo.map(u => u.label) }), svg0);
console.log('stillOpenAfterEnter', stillOpen, '\nok', JSON.stringify(afterOk), '\nundo', JSON.stringify(afterUndo), '\nnewScore', JSON.stringify(ns), '\nrows', rows.join('|'), '\nreset', JSON.stringify(afterReset));
