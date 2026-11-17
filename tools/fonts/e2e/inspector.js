// Inspector font section (all lyrics), 이 글자만 on a free text, and the "글꼴 바꾸기…" context menu of the title.
// run: INIT=<script that sets localStorage ssnap.welcomed> node tools/e2e/shot.mjs http://localhost:8765/ tools/out/x.png desktop tools/fonts/e2e/inspector.js
// add a measure text + an event text, then select texts and use the inspector
await page.evaluate(() => {
  const a = window.JSE.app;
  a.exec('t', s => { s.measures[0].texts = [{ text: 'Verse 1', placement: 'above', style: 'system', staffIndex: 0 }]; const ev = s.measures[1].staves[0].voices[0][0]; ev.texts = [{ text: 'dolce', placement: 'above', style: 'expression' }]; });
});
await page.waitForTimeout(300);
const pick = (pred) => page.evaluate((src) => { const a = window.JSE.app; const f = new Function('t', 'return ' + src); for (const p of a.layout.pages) { const t = p.geometry.texts.find(f); if (t) { a.select({ type: 'text', ref: t }); return JSON.stringify(t); } } return null; }, pred);
console.log('lyric ref', await pick("t.kind === 'lyric'"));
await page.waitForTimeout(200);
await page.screenshot({ path: 'tools/out/fonts-i1-lyric.png' });
// category controls: size + / font
await page.click('.ts-insp [data-scope=kind] [data-ts=inc]');
await page.waitForTimeout(150);
await page.click('.ts-insp [data-scope=kind] [data-ts=inc]');
await page.waitForTimeout(150);
await page.click('.ts-insp [data-scope=kind] .ts-font');
await page.waitForSelector('.ts-picker');
await page.click('.ts-picker .ts-opt[data-family="Gowun Batang"]');
await page.waitForTimeout(1500);
const s1 = await page.evaluate(() => ({ ts: window.JSE.app.score.settings.textStyles, undo: window.JSE.app.history.undo.map(u => u.label), sel: window.JSE.app.selection.type, selW: Math.round(window.JSE.app.selection.ref.w * 100) / 100 }));
console.log('after lyric edits', JSON.stringify(s1));
// free text: per-object override
console.log('mtext ref', await pick("t.kind === 'mtext'"));
await page.waitForTimeout(200);
await page.click('.ts-insp [data-scope=own] [data-ts=italic]');
await page.waitForTimeout(200);
await page.selectOption('.ts-insp [data-scope=own] [data-ts=preset]', '16');
await page.waitForTimeout(200);
await page.click('.ts-insp [data-scope=own] .ts-font');
await page.click('.ts-picker .ts-opt[data-family="Nanum Pen Script"]');
await page.waitForTimeout(1500);
const s2 = await page.evaluate(() => ({ mtext: window.JSE.app.score.measures[0].texts, etext: window.JSE.app.score.measures[1].staves[0].voices[0][0].texts, ts: window.JSE.app.score.settings.textStyles }));
console.log('own override', JSON.stringify(s2));
await page.screenshot({ path: 'tools/out/fonts-i1-own.png' });
const html = await page.evaluate(() => [...document.querySelectorAll('.page-svg text.mtext, .page-svg text.etext')].map(t => t.outerHTML));
console.log(html.join('\n'));
// clear the override
await page.click('.ts-insp [data-ts-act=clearOwn]');
await page.waitForTimeout(300);
console.log('cleared', JSON.stringify(await page.evaluate(() => window.JSE.app.score.measures[0].texts)));
// context menu on the title
const box = await page.evaluate(() => { const t = document.querySelector('.page-svg text.title').getBoundingClientRect(); return { x: t.x + t.width / 2, y: t.y + t.height / 2 }; });
await page.mouse.click(box.x, box.y, { button: 'right' });
await page.waitForSelector('.menu');
console.log('context menu:', (await page.$$eval('.menu button', bs => bs.map(b => b.textContent.trim()))).join(' | '));
await page.screenshot({ path: 'tools/out/fonts-i1-ctx.png' });
await page.click('.menu button:has-text("글꼴 바꾸기")');
await page.waitForSelector('.ts-dialog');
console.log('dialog focus row:', await page.$eval('.ts-row.focus', r => r.dataset.key));
