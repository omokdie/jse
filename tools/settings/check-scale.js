// Browser check of 설정 › 화면 › 화면 요소 크기 outside the desktop shell: CSS zoom of the app chrome
// (app/css/settings.css, section 1) on desktop / tablet layouts, and no effect at all on the phone layout.
//   INIT=/tmp/init-welcomed.js node tools/e2e/shot.mjs http://localhost:8765/ tools/out/st-scale.png desktop|tablet|tablet-portrait|mobile tools/settings/check-scale.js
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const wait = ms => page.waitForTimeout(ms);
const layout = await page.evaluate(() => document.documentElement.dataset.layout);
const vp = page.viewportSize(); const tag = layout === 'tablet' && vp.width < vp.height ? 'tablet-portrait' : layout;
const geo = () => page.evaluate(() => {
  const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.width || b.height ? { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } : null; };
  const d = document.documentElement;
  return { vw: innerWidth, vh: innerHeight, sw: d.scrollWidth, sh: d.scrollHeight, attr: d.getAttribute('data-ui-scale'), top: r('#topbar .bar'), main: r('#main'), rail: r('#rail'), status: r('#statusbar .bar'), mobilebar: r('#mobilebar') };
});
const rect = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }, sel);
const set = async pct => { await page.evaluate(p => window.JSE.app.setSetting('uiScale', p), pct); await wait(450); };
const inside = (b, g, slack = 1) => !!b && b.l >= -slack && b.t >= -slack && b.r <= g.vw + slack && b.b <= g.vh + slack;
const supported = await page.evaluate(() => 'currentCSSZoom' in Element.prototype);
const base = await geo();
// sizes above 100% are capped by what the window can hold (maxUiScale in app/js/settings.js)
const cap = await page.evaluate(async () => (await import('/js/settings.js')).maxUiScale(document.documentElement.dataset.layout, innerWidth));

if (layout === 'phone') {
  await page.evaluate(() => window.JSE.ui.settings('display')); await wait(450);
  ok(!(await page.$('.st-row[data-id="uiScale"]')) && await page.$('.st-row[data-id="theme"]'), 'the phone layout has no interface-size row');
  await page.goBack(); await wait(300); await page.goBack(); await wait(300);
  await set(125);
  const g = await geo();
  ok(g.top && Math.abs(g.top.h - base.top.h) < 0.5 && Math.abs(g.main.w - base.main.w) < 0.5 && Math.abs(g.main.h - base.main.h) < 0.5, 'a stored size (settings file from a PC) leaves the phone layout alone');
  ok(g.sw <= g.vw + 1, 'no sideways scrolling');
  await page.screenshot({ path: OUT + 'st-scale-phone-125.png' });
} else if (!supported) {
  await page.evaluate(() => window.JSE.ui.settings('display')); await wait(450);
  ok(!(await page.$('.st-row[data-id="uiScale"]')), 'engines without CSS zoom support do not offer the option');
} else {
  for (const pct of [125, 150, 85]) {
    await set(pct);
    const eff = pct <= 100 ? pct : Math.min(pct, cap), f = eff / 100, g = await geo();
    ok(g.attr === (eff === 100 ? null : String(eff)), `${pct}%: applied as ${eff}% (cap ${cap}%, <html> says ${g.attr})`);
    ok(Math.abs(g.top.h / base.top.h - f) < 0.04, `${pct}%: the top bar is ${eff}% as tall (${base.top.h.toFixed(1)} → ${g.top.h.toFixed(1)})`);
    const gear = await rect('#topbar [data-act=settings]');
    ok(gear && gear.w > 0 && gear.l >= 0 && gear.r <= g.vw + 0.5, `${pct}%: the settings button stays on the top bar (${gear ? Math.round(gear.l) + '..' + Math.round(gear.r) : 'missing'} of ${g.vw})`);
    ok(g.sw <= g.vw + 1 && g.sh <= g.vh + 1, `${pct}%: the page itself does not scroll (${g.sw}×${g.sh} in ${g.vw}×${g.vh})`);
    ok(inside(g.top, g) && inside(g.main, g) && (!g.rail || inside(g.rail, g)) && (!g.status || inside(g.status, g)), `${pct}%: bars, tool rail and score area stay on screen`);
    ok(g.main.w >= 240 && g.main.h >= 240 && g.main.t >= g.top.b - 1, `${pct}%: the score keeps its room below the bars (${Math.round(g.main.w)}×${Math.round(g.main.h)})`);
    await page.screenshot({ path: OUT + `st-scale-${tag}-${pct}.png` });
    // a menu opens right under its button
    if (await page.$('[data-menu=file]')) {
      await page.click('[data-menu=file]'); await wait(250);
      const m = await rect('#layer .menu'), a = await rect('[data-menu=file]');
      ok(inside(m, g) && Math.abs(m.l - a.l) <= 2 && m.t >= a.b - 1 && m.t - a.b <= 14 * f, `${pct}%: the file menu hangs under its button ${JSON.stringify([Math.round(m?.l), Math.round(m?.t), Math.round(a.l), Math.round(a.b)])}`);
      await page.screenshot({ path: OUT + `st-scale-${tag}-${pct}-menu.png` });
      await page.keyboard.press('Escape'); await page.evaluate(() => window.JSE.ui.hideContextMenu?.()); await wait(150);
    }
    // dialogs and the settings window fit the screen
    await page.evaluate(() => { window.JSE.app.dirty = false; window.JSE.ui.action('new'); }); await wait(400);
    const dlg = await rect('.dialog');
    ok(inside(dlg, g), `${pct}%: the new-score dialog fits (${dlg ? Math.round(dlg.w) + '×' + Math.round(dlg.h) : 'missing'})`);
    await page.screenshot({ path: OUT + `st-scale-${tag}-${pct}-dialog.png` });
    await page.evaluate(() => document.querySelector('.dialog header .x')?.click()); await wait(250);
    await page.evaluate(() => window.JSE.ui.settings('display')); await wait(450);
    const win = await rect('.st-win');
    ok(inside(win, g), `${pct}%: the settings window fits (${win ? Math.round(win.w) + '×' + Math.round(win.h) : 'missing'})`);
    ok(await page.$eval('.st-row[data-id="uiScale"] output', e => e.textContent) === `${pct}%`, `${pct}%: the slider shows the value`);
    const note = await page.$eval('.st-row[data-id="uiScale"] .st-status', e => (e.hidden ? '' : e.textContent));
    ok(pct > cap ? note.includes(`${cap}%까지만`) : note === '', `${pct}%: ${pct > cap ? 'the row says why it is not bigger' : 'no note'} ("${note}")`);
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.st-detail .st-row')].flatMap(r => {
      const rr = r.getBoundingClientRect(), cs = getComputedStyle(r), z = rr.width / r.offsetWidth || 1, lo = rr.left + parseFloat(cs.paddingLeft) * z - 0.8, hi = rr.right - parseFloat(cs.paddingRight) * z + 0.8;
      return [...r.querySelectorAll('.st-text, .st-ctl, .st-ctl > *, .st-seg button')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.left < lo || b.right > hi); }).map(e => `${r.dataset.id}/${e.className || e.tagName}`); }));
    ok(clipped.length === 0, `${pct}%: settings rows are not clipped: ${clipped.join(', ')}`);
    await page.screenshot({ path: OUT + `st-scale-${tag}-${pct}-settings.png` });
    await page.keyboard.press('Escape'); await wait(300);
    ok(!(await page.$('.st-overlay')), `${pct}%: the settings window closes`);
  }
  await set(100);
  const g = await geo();
  ok(g.attr === null && Math.abs(g.top.h - base.top.h) < 0.5 && Math.abs(g.main.w - base.main.w) < 1.5, '100% removes every trace (same layout as before)');
}
await page.evaluate(() => window.JSE.app.prefs.reset(null));
console.log(`settings/scale ${tag}: ${passed} passed, ${fails.length} failed`);
