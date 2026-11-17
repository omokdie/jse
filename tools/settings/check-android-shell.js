// The Android-app pages and the back key, with a stand-in for the native shell
// (INIT=tools/settings/init-android.js defines window.ScoreSnapNative before the app boots). Phone profile.
const OUT = '/home/claude/scoresnap/tools/out/';
page.setDefaultTimeout(10000);
const fails = []; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { fails.push(msg); console.log('  FAIL: ' + msg); } };
const wait = ms => page.waitForTimeout(ms);
const row = id => `.st-row[data-id="${id}"]`;
const calls = name => page.evaluate(n => window.__native.calls.filter(c => c[0] === n).map(c => c[1]), name);
const back = async () => { await page.evaluate(() => window.__native.back({ canGoBack: false })); await wait(350); };
const level = () => page.evaluate(() => document.querySelector('.st-win')?.dataset.level || null);
const N = () => page.evaluate(() => ({ min: window.__native.min, exit: window.__native.exit }));

ok(await page.evaluate(() => typeof window.__native.back === 'function'), 'the app subscribed to the back key');
ok((await calls('setKeepScreenOn')).length === 1 && (await calls('setKeepScreenOn'))[0] === false && (await calls('setOrientation'))[0] === 'auto' && (await calls('setImmersive'))[0] === false, 'stored device options are pushed to the shell at start-up');
await page.evaluate(() => window.JSE.ui.settings()); await wait(400);
const secs = await page.$$eval('.st-cat', els => els.map(e => e.dataset.sec));
ok(secs.includes('android') && !secs.includes('web') && !secs.includes('windows'), 'Android page shown, web / Windows pages hidden: ' + secs.join(','));
await page.tap('.st-cat[data-sec="android"]'); await wait(400);
await page.screenshot({ path: OUT + 'st-android-page.png' });
ok((await page.$$eval('.st-row', els => els.map(e => e.dataset.id))).join() === 'keepScreenOn,immersive,orientation,backAction', 'the four Android options');
await page.tap(row('keepScreenOn')); await wait(200);
ok((await calls('setKeepScreenOn')).at(-1) === true, 'keep screen on → native');
await page.tap(row('immersive')); await wait(200);
ok((await calls('setImmersive')).at(-1) === true, 'immersive mode → native');
await page.tap(row('orientation')); await wait(300); await page.tap('.st-sheet [role=radio]:has-text("가로 고정")'); await wait(300);
ok((await calls('setOrientation')).at(-1) === 'landscape', 'orientation lock → native');
// back key walks up: sheet → page → list → closed
await page.tap(row('backAction')); await wait(300);
ok(await page.$('.st-sheet'), 'choice sheet open');
await back(); ok(!(await page.$('.st-sheet')) && (await level()) === 'detail', 'back key: closes the sheet');
await back(); ok((await level()) === 'nav', 'back key: page → list');
await back(); ok(!(await page.$('.st-overlay')), 'back key: closes the settings');
ok((await N()).min === 0, 'the app was not left while there was something to close');
// other open UI is closed first
await page.tap('[data-act=mobileMore]'); await wait(200);
ok(await page.$('#layer .menu'), 'menu open'); await back(); ok(!(await page.$('#layer .menu')), 'back key: closes a menu');
await page.evaluate(() => window.JSE.ui.action('shortcuts')); await wait(300);
ok(await page.$('.dialog-backdrop')); await back(); ok(!(await page.$('.dialog-backdrop')), 'back key: closes a dialog');
await page.evaluate(() => window.JSE.ui.mobileTab('file')); await wait(300);
ok(await page.$('#layer .sheet')); await back(); ok(!(await page.$('#layer .sheet')), 'back key: closes a bottom sheet');
await page.evaluate(() => window.JSE.app.setMode('input')); await wait(150);
await back(); ok(await page.evaluate(() => window.JSE.app.mode) === 'select', 'back key: leaves note entry');
// nothing open: the chosen action
await back();
ok((await N()).min === 0 && await page.evaluate(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('한 번 더'))), '"두 번 눌러 나가기": the first press only says so');
await back(); ok((await N()).min === 1, 'the second press leaves the app (minimise)');
await wait(2400); await back(); ok((await N()).min === 1, 'a late press starts over');
await page.evaluate(() => window.JSE.app.setSetting('backAction', 'none')); await wait(2300);
await back(); await back(); ok((await N()).min === 1, '"아무 동작 안 함"');
await page.evaluate(() => window.JSE.app.setSetting('backAction', 'exit'));
await back(); ok((await N()).min === 2 && (await N()).exit === 0, '"바로 나가기" leaves at once (minimise, not kill)');
// haptics go through the shell
await page.evaluate(() => { window.JSE.app.haptic(7); }); ok((await calls('vibrate')).at(-1) === 7, 'haptic tick → native vibrate');
await page.evaluate(() => { window.JSE.app.setSetting('haptics', false); window.JSE.app.haptic(9); });
ok((await calls('vibrate')).at(-1) === 7, 'haptics off: no native call');
// this device
await page.evaluate(() => window.JSE.ui.settings('device')); await wait(500);
const dev = await page.$$eval('.st-row[data-type=info] .st-info', els => els.map(e => e.textContent));
ok(dev[0].startsWith('Android 앱') && dev[1].includes('앱 v1.0.9'), 'this device: ' + dev.slice(0, 2).join(' | '));
await page.screenshot({ path: OUT + 'st-android-device.png' });
// stored values are re-applied by the next start
await page.evaluate(() => { window.JSE.app.setSetting('backAction', 'twice'); window.JSE.app.setSetting('haptics', true); });
await page.reload({ waitUntil: 'networkidle' }); await wait(1200);
ok((await calls('setKeepScreenOn'))[0] === true && (await calls('setImmersive'))[0] === true && (await calls('setOrientation'))[0] === 'landscape', 'after a restart the shell gets the stored values again');
await page.evaluate(() => { window.JSE.app.prefs.reset(null); }); await wait(200);
ok((await calls('setKeepScreenOn')).at(-1) === false && (await calls('setOrientation')).at(-1) === 'auto', 'reset all reaches the shell');
console.log(`settings/android shell: ${passed} passed, ${fails.length} failed`);
