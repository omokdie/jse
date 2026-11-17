// Screenshot of every settings section on the current profile → tools/out/settings-<TAG>-<section>.png
//   TAG=desktop INIT=/tmp/init-welcomed.js node tools/e2e/shot.mjs http://localhost:8765/ tools/out/settings-desktop.png desktop tools/settings/gallery.js
//   TAG=windows INIT=tools/settings/init-electron.js … desktop …      TAG=android INIT=tools/settings/init-android.js … mobile …
// Also fails loudly when a control sticks out of its row or the window leaves the screen.
const OUT = '/home/claude/scoresnap/tools/out/';
const wait = ms => page.waitForTimeout(ms);
const layout = await page.evaluate(() => document.documentElement.dataset.layout);
const tag = process.env.TAG || layout;
await page.evaluate(() => window.JSE.ui.settings()); await wait(450);
const secs = await page.$$eval('.st-cat', els => els.map(e => e.dataset.sec));
const problems = [];
if (layout === 'phone') { await page.evaluate(() => document.querySelector('.st-win').dataset.level === 'detail' && history.back()); await wait(350); await page.screenshot({ path: OUT + `settings-${tag}-list.png` }); }
for (const sec of secs) {
  await page.evaluate(s => window.JSE.ui.settings(s), sec); await wait(layout === 'phone' ? 420 : 260);
  problems.push(...await page.evaluate(s => {
    const out = [], win = document.querySelector('.st-win').getBoundingClientRect();
    if (win.left < -0.6 || win.top < -0.6 || win.right > innerWidth + 0.6 || win.bottom > innerHeight + 0.6) out.push(`${s}: window leaves the screen`);
    for (const r of document.querySelectorAll('.st-detail .st-row')) {
      const rr = r.getBoundingClientRect(), cs = getComputedStyle(r), lo = rr.left + parseFloat(cs.paddingLeft) - 0.6, hi = rr.right - parseFloat(cs.paddingRight) + 0.6;
      for (const e of r.querySelectorAll('.st-text, .st-ctl, .st-ctl > *, .st-seg button')) { const b = e.getBoundingClientRect(); if (b.width && (b.left < lo || b.right > hi)) out.push(`${s}/${r.dataset.id}: ${e.className || e.tagName} sticks out`); }
    }
    return out; }, sec));
  await page.screenshot({ path: OUT + `settings-${tag}-${sec}.png` });
}
console.log(`settings gallery ${tag} (${layout}): ${secs.join(' ')}`);
console.log(problems.length ? 'LAYOUT PROBLEMS:\n  ' + problems.join('\n  ') : 'layout ok in every section');
