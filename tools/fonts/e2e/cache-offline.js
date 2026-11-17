// JSE 글꼴 download → IndexedDB → reload with the files unreachable (0 requests) → cache emptied + unreachable (default font + ONE toast).
// The four "net::ERR_FAILED" console lines at the end are the requests this script aborts on purpose.
// run: INIT=<script that sets localStorage ssnap.welcomed> node tools/e2e/shot.mjs http://localhost:8765/ tools/out/x.png desktop tools/fonts/e2e/cache-offline.js
const reqs = [];
page.on('request', r => { if (r.url().includes('/fonts/web/')) reqs.push(r.url().replace(/.*\/fonts\/web\//, '')); });
// 1. pick a JSE font for lyrics (regular) and chords (bold) and confirm
await page.evaluate(() => { window.JSE.ui.textStyles(); });
await page.waitForSelector('.ts-dialog');
await page.click('.ts-row[data-key=lyrics] .ts-font');
await page.click('.ts-picker .ts-opt[data-family="Nanum Gothic"]');
await page.click('.ts-row[data-key=chord] .ts-font');
await page.click('.ts-picker .ts-opt[data-family="Nanum Gothic"]');
await page.waitForTimeout(1200);
await page.click('.ts-dialog footer .btn.primary');
await page.waitForTimeout(2200);   // autosave (1.2 s)
const idb = () => page.evaluate(() => new Promise(res => { const r = indexedDB.open('jse-fonts'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('files')) return res([]); const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => res(q.result.map(x => [x.file, x.size])); }; r.onerror = () => res('err'); }));
const state = () => page.evaluate(() => ({ ts: window.JSE.app.score.settings.textStyles, faces: [...document.fonts].map(f => `${f.family} ${f.weight} ${f.status}`), toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), lyricFont: getComputedStyle(document.querySelector('.page-svg text.lyric')).fontFamily.slice(0, 40) }));
console.log('1 requests', JSON.stringify(reqs), '\n  idb', JSON.stringify(await idb()), '\n  state', JSON.stringify(await state()));
// 2. reload with the font files unreachable: must come from IndexedDB
reqs.length = 0;
await page.route('**/fonts/web/**', r => r.abort());
await page.context().route('https://omokdie.github.io/**', r => r.abort());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('2 after reload (files blocked) requests', JSON.stringify(reqs), '\n  state', JSON.stringify(await state()));
await page.screenshot({ path: 'tools/out/fonts-e1-cached.png' });
// 3. cache emptied + still unreachable: default font + ONE toast
await page.evaluate(() => new Promise(res => { const r = indexedDB.open('jse-fonts'); r.onsuccess = () => { const t = r.result.transaction('files', 'readwrite'); t.objectStore('files').clear(); t.oncomplete = () => res(); }; }));
reqs.length = 0;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const s3 = await state();
// a few edits must not repeat the toast
await page.evaluate(() => { const a = window.JSE.app; a.exec('t', s => { s.meta.subtitle = 'x'; }); a.exec('t', s => { s.meta.subtitle = 'y'; }); });
await page.waitForTimeout(800);
const s3b = await state();
console.log('3 offline, not cached: requests', JSON.stringify(reqs), '\n  state', JSON.stringify(s3), '\n  toasts after 2 more edits', JSON.stringify(s3b.toasts));
await page.screenshot({ path: 'tools/out/fonts-e1-offline.png' });
