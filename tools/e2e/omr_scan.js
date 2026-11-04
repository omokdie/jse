// Photo recognition through the app's scan dialog (real browser worker, incl. the lyric stage).
//   python3 -m http.server 8765 -d app &
//   OMR_IMG=/abs/path/photo.jpg node tools/e2e/shot.mjs http://localhost:8765/ /tmp/omr-scan.png desktop tools/e2e/omr_scan.js
// Prints the review chips, the recognition time (run click → review step) and the measures / notes
// that end up in the score.
await page.evaluate(() => { document.querySelectorAll('.dialog').forEach(d => d.querySelector('header button')?.click()); });
await page.waitForTimeout(300);
await page.click('[data-ob=scan]');
await page.waitForTimeout(300);
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a=pick]')]);
await fc.setFiles(process.env.OMR_IMG);
await page.waitForSelector('#scan-step2:not([hidden])');
await page.waitForTimeout(300);
const t0 = Date.now();
await page.click('[data-b=run]');
await page.waitForSelector('#scan-step4:not([hidden])', { timeout: 120000 });
console.log('recognition ms:', Date.now() - t0);
await page.waitForTimeout(500);
console.log('chips:', await page.$$eval('.omr-summary .chip', els => els.map(e => e.textContent).join(' | ')));
await page.click('[data-b=apply]');
await page.waitForTimeout(1500);
console.log('reviewbar:', await page.$eval('.review-bar', e => e.textContent).catch(() => 'n/a'));
const st = await page.evaluate(() => { const s = window.JSE?.app?.score; if (!s) return 'no handle'; let notes = 0; for (const m of s.measures) for (const sm of m.staves) for (const v of sm.voices) for (const e of v) if (e.kind === 'note') notes++; return `${s.measures.length} measures, ${notes} notes, key ${s.measures[0]?.keySig?.fifths}`; });
console.log('score:', st);
