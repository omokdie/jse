// Settings registry (app/js/settings.js): defaults, migration of older stored settings,
// platform filtering, search, reset, export / import — all without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, ITEMS, VALUE_ITEMS, SETTINGS_VERSION, itemById, makeContext, isVisible, visibleItems, visibleSections, sectionOf,
  defaultsFor, migrate, coerce, search, choseong, exportSettings, parseImport, getPath, setPath, newScoreDefaults, SettingsManager, fmtBytes, REPO_URL, repoUrlFrom, maxUiScale, effectiveUiScale,
} from '../../app/js/settings.js';
import { PAGES_BASE_URL } from '../../app/js/config.js';
import { createScore } from '../../app/js/model/score.js';
import { normalizeTextStyles } from '../../app/js/model/textstyles.js';

const fn = () => {};
const ctxOf = (shell, layout, extra = {}) => makeContext({
  shell, layout, touch: layout !== 'desktop', platform: shell === 'electron' ? 'windows' : shell === 'android' ? 'android' : 'web',
  native: shell === 'electron' ? { platform: 'windows', setAppSettings: fn, chooseFolder: fn, openSystemSettings: fn, showSettingsFile: fn, relaunch: fn, setZoomFactor: fn }
    : shell === 'android' ? { platform: 'android', setKeepScreenOn: fn, setImmersive: fn, setOrientation: fn, vibrate: fn, onBackButton: fn } : null,
  features: { wakeLock: true, vibrate: shell !== 'electron', storage: true, persist: true, caches: true, cssZoom: true, standalone: false, preview: false },
  ...extra,
});
const ids = (ctx, section) => visibleItems(ctx, section).map(it => it.id);
/** Minimal stand-in for the App class: a plain settings object + the two methods the manager calls. */
function fakeApp(stored) {
  const events = [];
  const app = { settings: migrate(stored), saved: 0, events, saveSettings() { this.saved++; }, emit(type, detail) { events.push({ type, detail }); }, addEventListener() {} };
  app.prefs = new SettingsManager(app);
  return app;
}

test('registry is well formed', () => {
  const sections = new Set(SECTIONS.map(s => s.id));
  const seen = new Set();
  for (const it of ITEMS) {
    assert.ok(!seen.has(it.id), `duplicate id ${it.id}`); seen.add(it.id);
    assert.ok(['toggle', 'select', 'slider', 'color', 'action', 'info'].includes(it.type), `${it.id}: type ${it.type}`);
    assert.ok(typeof it.label === 'string' && it.label, `${it.id}: label`);
    const secs = typeof it.section === 'string' ? [it.section] : Object.values(it.section);
    for (const s of secs) assert.ok(sections.has(s), `${it.id}: unknown section ${s}`);
    if (it.type === 'select' || it.type === 'color') assert.ok(it.options?.length >= 2, `${it.id}: options`);
    if (it.type === 'select') assert.ok(it.options.some(o => o.value === it.default), `${it.id}: default is not an option`);
    if (it.type === 'slider') assert.ok(it.min < it.max && it.step > 0, `${it.id}: range`);
    if (it.type === 'action') assert.ok(it.actions?.length && it.actions.every(a => a.label && typeof a.run === 'function'), `${it.id}: actions`);
    if (it.type === 'info') assert.equal(typeof it.value, 'function', `${it.id}: value()`);
    if (it.default !== undefined) assert.deepEqual(coerce(it, it.default), it.default, `${it.id}: default does not validate`);
  }
});

test('defaults: every stored key, existing keys keep their old defaults', () => {
  const d = defaultsFor();
  assert.equal(d._v, SETTINGS_VERSION);
  // the keys the app had before the registry existed
  assert.deepEqual({ tips: d.tips, lang: d.lang, autosave: d.autosave, keymap: d.keymap, theme: d.theme, autoUpdate: d.autoUpdate, mobileDurationBar: d.mobileDurationBar },
    { tips: true, lang: 'ko', autosave: true, keymap: 'musescore', theme: 'auto', autoUpdate: true, mobileDurationBar: true });
  assert.deepEqual(d.newScore, { pageSize: 'A4', orientation: 'portrait', marginsMm: { top: 15, bottom: 15, left: 15, right: 15 }, staffSpaceMm: 1.75, measureNumbers: 'system' });
  assert.equal(d.exportFormat, 'pdf'); assert.equal(d.exportDpi, 300);
  for (const it of VALUE_ITEMS) assert.notEqual(getPath(d, it.key), undefined, it.key);
  assert.equal(JSON.stringify(d), JSON.stringify(JSON.parse(JSON.stringify(d))), 'plain JSON object');
  // new-score defaults equal what createScore() produces, so nothing changes until the user edits them
  const s = createScore().settings;
  for (const [k, v] of Object.entries(newScoreDefaults(d))) assert.deepEqual(s[k], v, k);
});

test('migration: old stored settings survive and gain the new keys', () => {
  const old = { tips: false, lang: 'en', autosave: false, keymap: 'musescore', theme: 'dark', autoUpdate: false, mobileDurationBar: true, viewMode: 'grid', lastPageView: 'single' };
  const m = migrate(old);
  for (const [k, v] of Object.entries(old)) assert.deepEqual(m[k], v, `${k} kept`);
  assert.equal(m.hints, false, 'v1 "초보자 안내" off also hid the hint bar');
  assert.equal(m._v, SETTINGS_VERSION);
  assert.equal(m.accent, '#0a84ff'); assert.equal(m.newScore.pageSize, 'A4');
  assert.equal(migrate({ tips: true }).hints, true);
  assert.equal(migrate({ _v: 2, tips: false }).hints, true, 'already migrated: hints is its own switch');
  assert.equal(migrate({ _v: 2, tips: false, hints: false }).hints, false);
  // idempotent
  assert.deepEqual(migrate(m), m);
  // nothing stored / broken storage → defaults
  assert.deepEqual(migrate(null), defaultsFor());
  assert.deepEqual(migrate('oops'), defaultsFor());
  assert.deepEqual(migrate([1, 2]), defaultsFor());
});

test('migration: invalid values fall back, partial newScore is completed, unknown keys are kept', () => {
  const m = migrate({ theme: 'neon', uiScale: 400, volume: '55', longPressMs: 'x', accent: 'red', exportDpi: '600', countIn: '2', autosave: 'false',
    newScore: { pageSize: 'B5', marginsMm: { top: 10, bottom: 20, left: 12, right: 12 }, textStyles: { title: { family: 'Noto Serif KR', size: 5 } } }, somethingElse: { a: 1 } });
  assert.equal(m.theme, 'auto');
  assert.equal(m.uiScale, 150, 'clamped');
  assert.equal(m.volume, 55); assert.equal(m.longPressMs, 550); assert.equal(m.accent, '#0a84ff');
  assert.equal(m.exportDpi, 600); assert.equal(m.countIn, 2); assert.equal(m.autosave, false);
  assert.deepEqual(m.newScore.marginsMm, { top: 10, bottom: 20, left: 12, right: 12 }, 'four separate margins are not flattened');
  assert.equal(m.newScore.pageSize, 'B5'); assert.equal(m.newScore.orientation, 'portrait'); assert.equal(m.newScore.staffSpaceMm, 1.75);
  assert.deepEqual(m.newScore.textStyles, { title: { family: 'Noto Serif KR', size: 5 } }, 'text styles of the fonts dialog pass through');
  assert.deepEqual(m.somethingElse, { a: 1 });
  assert.deepEqual(migrate({ newScore: { marginsMm: 'wide' } }).newScore.marginsMm, { top: 15, bottom: 15, left: 15, right: 15 });
  assert.equal(migrate({ uiScale: 97 }).uiScale, 95, 'snapped to the slider step');
});

test('platform filtering: each platform sees only its own options', () => {
  const win = ctxOf('electron', 'desktop'), phone = ctxOf('android', 'phone'), tab = ctxOf('android', 'tablet'), web = ctxOf('web', 'desktop'), mweb = ctxOf('web', 'phone');
  const secs = c => visibleSections(c).map(s => s.id);
  assert.ok(secs(win).includes('windows') && !secs(win).includes('android') && !secs(win).includes('web'));
  assert.ok(secs(phone).includes('android') && !secs(phone).includes('windows') && !secs(phone).includes('web'));
  assert.ok(secs(web).includes('web') && !secs(web).includes('windows') && !secs(web).includes('android'));
  for (const c of [win, phone, tab, web, mweb]) for (const s of ['general', 'display', 'editing', 'newScore', 'playback', 'recognition', 'files', 'update', 'device', 'advanced']) assert.ok(secs(c).includes(s), `${c.shell}/${c.layout}: ${s}`);
  // Windows app
  for (const id of ['winRememberBounds', 'winStartMaximized', 'winCloseConfirm', 'winDisableGpu', 'winDefaultDir', 'winFileAssoc', 'winSettingsFile', 'keepScreenOn']) assert.ok(ids(win, 'windows').includes(id), id);
  assert.ok(!ids(web).some(id => id.startsWith('win')), 'no Windows options in the browser');
  // Android app
  assert.deepEqual(ids(phone, 'android'), ['keepScreenOn', 'immersive', 'orientation', 'backAction']);
  assert.ok(!ids(win).includes('immersive') && !ids(web).includes('orientation'));
  // web app
  assert.deepEqual(ids(web, 'web'), ['keepScreenOn', 'pwaInstall', 'storagePersist', 'clearCache']);
  assert.ok(!ids(phone).includes('pwaInstall') && !ids(win).includes('clearCache'));
  // input devices
  for (const id of ['touchSlideInput', 'longPressMs', 'haptics', 'penOnly']) { assert.ok(ids(phone).includes(id), id); assert.ok(ids(tab).includes(id), id); assert.ok(!ids(web).includes(id), `${id} hidden without touch`); }
  for (const id of ['wheelMode', 'entryGhost']) { assert.ok(ids(win).includes(id) && ids(tab).includes(id), id); assert.ok(!ids(phone).includes(id), `${id} hidden on phones`); }
  // phones always use the continuous view: no page-view / panel options there
  for (const id of ['defaultView', 'defaultZoom', 'panelLeft', 'panelRight']) { assert.ok(ids(tab).includes(id), id); assert.ok(!ids(phone).includes(id) && !ids(mweb).includes(id), `${id} hidden on phones`); }
});

test('platform filtering: older shells without the new native methods hide what they cannot do', () => {
  const oldAndroid = makeContext({ shell: 'android', layout: 'phone', touch: true, platform: 'android', native: { platform: 'android', saveFile: fn }, features: { wakeLock: false, vibrate: false, cssZoom: true } });
  assert.deepEqual(ids(oldAndroid, 'android'), [], 'section disappears');
  assert.ok(!visibleSections(oldAndroid).some(s => s.id === 'android'));
  assert.ok(!ids(oldAndroid).includes('haptics'));
  const oldWin = makeContext({ shell: 'electron', layout: 'desktop', touch: false, platform: 'windows', native: { platform: 'windows', saveFile: fn }, features: { wakeLock: false, cssZoom: false } });
  assert.deepEqual(ids(oldWin, 'windows'), ['winCloseConfirm'], 'only the option the web side implements alone');
  assert.ok(!ids(oldWin).includes('uiScale'), 'no native zoom and no CSS zoom → no size slider');
  assert.ok(isVisible(itemById('uiScale'), ctxOf('web', 'desktop')));
  assert.ok(isVisible(itemById('uiScale'), ctxOf('android', 'tablet')));
  assert.ok(!isVisible(itemById('uiScale'), ctxOf('web', 'phone')) && !isVisible(itemById('uiScale'), ctxOf('android', 'phone')), 'the phone layout is not scaled');
  assert.ok(isVisible(itemById('uiScale'), ctxOf('electron', 'phone')), 'the desktop app zooms natively, whatever the window width');
  // the fonts row appears only when the fonts dialog exists
  assert.ok(!ids(ctxOf('web', 'desktop')).includes('newScoreFonts'));
  assert.ok(ids(ctxOf('web', 'desktop', { ui: { textStyles: fn } })).includes('newScoreFonts'));
  // every item lands in exactly one visible section
  for (const c of [ctxOf('electron', 'desktop'), ctxOf('android', 'tablet'), ctxOf('web', 'phone')]) for (const it of visibleItems(c)) assert.ok(SECTIONS.some(s => s.id === sectionOf(it, c)), it.id);
});

test('search: words, keywords, option names, 초성, several words', () => {
  const web = ctxOf('web', 'desktop'), phone = ctxOf('android', 'phone'), win = ctxOf('electron', 'desktop');
  const top = (q, c = web) => search(q, c).map(r => r.item.id);
  assert.equal(top('테마')[0], 'theme');
  assert.equal(top('다크')[0], 'theme'); assert.deepEqual(top('다크'), ['theme'], 'no match across a sentence boundary');
  assert.equal(top('dark')[0], 'theme');
  assert.equal(top('ㅌㅁ')[0], 'theme');
  assert.equal(choseong('강조 색'), 'ㄱㅈ ㅅ');
  assert.equal(top('강조색')[0], 'accent');
  assert.equal(top('메트로놈')[0], 'metronome');
  assert.equal(top('자동 저장')[0], 'autosave');
  assert.ok(top('자동 저장').includes('autosaveDelay'));
  assert.equal(top('dpi')[0], 'exportDpi');
  assert.equal(top('미색')[0], 'paperColor', 'option label');
  assert.equal(top('PDF')[0], 'exportFormat');
  assert.equal(top('휠')[0], 'wheelMode');
  assert.equal(top('초기화').at(0), 'resetAll');
  assert.deepEqual(top(''), []); assert.deepEqual(top('   '), []); assert.deepEqual(top('zzqqxx'), []);
  // search only finds what the platform shows
  assert.deepEqual(top('몰입'), []); assert.equal(top('몰입', phone)[0], 'immersive');
  assert.deepEqual(top('하드웨어', web), []); assert.equal(top('하드웨어', win)[0], 'winDisableGpu');
  assert.equal(top('펜', phone)[0], 'penOnly'); assert.ok(!top('펜').includes('penOnly'));
  assert.equal(search('테마', web)[0].section, 'display');
  assert.equal(search('theme', web, 'en')[0].item.id, 'theme');
});

test('manager: set validates, saves, notifies; reset per section and all', () => {
  const app = fakeApp({ theme: 'dark' });
  assert.equal(app.prefs.set('volume', 30), true);
  assert.equal(app.settings.volume, 30); assert.equal(app.saved, 1);
  assert.deepEqual(app.events.at(-1), { type: 'settings', detail: { id: 'volume', value: 30 } });
  assert.equal(app.prefs.set('volume', 30), false, 'unchanged value does nothing'); assert.equal(app.saved, 1);
  app.prefs.set('volume', 999); assert.equal(app.settings.volume, 100, 'clamped');
  app.prefs.set('theme', 'purple'); assert.equal(app.settings.theme, 'auto', 'invalid → default');
  assert.equal(app.prefs.set('nope', 1), false);
  // nested key + packed value
  app.prefs.set('newScore.pageSize', 'Letter'); assert.equal(app.settings.newScore.pageSize, 'Letter');
  app.prefs.set('newScore.marginsMm', 12); assert.deepEqual(app.settings.newScore.marginsMm, { top: 12, bottom: 12, left: 12, right: 12 });
  assert.equal(app.prefs.get('newScore.marginsMm'), 12);
  assert.equal(app.prefs.isDefault('newScore.staffSpaceMm'), true); assert.equal(app.prefs.isDefault('newScore.pageSize'), false);
  // section reset touches only that section
  app.prefs.set('metronome', true); app.prefs.set('countIn', 2);
  const changed = app.prefs.reset('playback');
  assert.deepEqual(changed.sort(), ['countIn', 'metronome', 'volume']);
  assert.equal(app.settings.metronome, false); assert.equal(app.settings.volume, 80); assert.equal(app.settings.newScore.pageSize, 'Letter');
  assert.deepEqual(app.prefs.reset('playback'), [], 'nothing left to reset');
  // new-score section reset also drops the text styles written by the fonts dialog
  app.settings.newScore.textStyles = { title: { size: 6 } };
  assert.ok(app.prefs.reset('newScore').includes('newScore.textStyles')); assert.equal(app.settings.newScore.textStyles, undefined);
  // reset all: defaults again, but the view the user is in stays
  app.settings.viewMode = 'grid'; app.prefs.set('lang', 'en'); app.prefs.reset(null);
  assert.deepEqual({ ...app.settings, viewMode: undefined, lastPageView: undefined }, { ...defaultsFor(), viewMode: undefined, lastPageView: undefined });
  assert.equal(app.settings.viewMode, 'grid');
});

test('export / import round trip, foreign and broken files', () => {
  const a = fakeApp();
  a.prefs.set('theme', 'dark'); a.prefs.set('accent', '#e5484d'); a.prefs.set('uiScale', 125); a.prefs.set('newScore.orientation', 'landscape'); a.prefs.set('exportFormat', 'png');
  a.settings.newScore.textStyles = { lyrics: { family: 'Nanum Myeongjo', size: 2.2, bold: false, italic: false } };
  const text = a.prefs.exportText();
  const file = JSON.parse(text);
  assert.equal(file.format, 'jse-settings'); assert.equal(file.version, SETTINGS_VERSION); assert.equal(file.settings.theme, 'dark');
  const b = fakeApp({ theme: 'light', volume: 10 });
  const r = b.prefs.importText(text);
  assert.ok(r.applied >= 6); assert.deepEqual(r.skipped, []);
  for (const it of VALUE_ITEMS) assert.deepEqual(getPath(b.settings, it.key), getPath(a.settings, it.key), it.key);
  assert.deepEqual(b.settings.newScore.textStyles, normalizeTextStyles(a.settings.newScore.textStyles), 'text styles are sanitised on the way in');
  assert.equal(parseImport(JSON.stringify({ newScore: { textStyles: { title: { family: 'x"><script>', size: 9999 }, bogus: { size: 3 } } } })).extra.textStyles, undefined);
  assert.equal(b.events.at(-1).type, 'settings');
  // a bare object (hand-written / very old backup) works too; unknown keys are reported, bad values repaired
  const p = parseImport(JSON.stringify({ theme: 'dark', volume: 500, wat: 1 }));
  assert.deepEqual(p.values, { theme: 'dark', volume: 100 }); assert.deepEqual(p.skipped, ['wat']);
  const c = fakeApp({ lang: 'en' });
  c.prefs.importText(JSON.stringify({ theme: 'dark' }));
  assert.equal(c.settings.theme, 'dark'); assert.equal(c.settings.lang, 'en', 'keys missing from the file are left alone');
  assert.throws(() => parseImport('not json'), /JSON/);
  assert.throws(() => parseImport('[1,2]'));
  assert.throws(() => parseImport(JSON.stringify({ format: 'other-app', settings: {} })));
  assert.throws(() => parseImport(JSON.stringify({ format: 'jse-settings' })));
  assert.equal(exportSettings({ a: 1 }, { platform: 'web' }).includes('"platform": "web"'), true);
});

test('new-score defaults are applied to a created score', () => {
  const st = migrate({ newScore: { pageSize: 'Letter', orientation: 'landscape', marginsMm: { top: 10, bottom: 10, left: 20, right: 20 }, staffSpaceMm: 2, measureNumbers: 'all', textStyles: { title: { size: 7 } } } });
  const score = createScore({ instruments: ['voice'], measures: 4 });
  Object.assign(score.settings, newScoreDefaults(st));
  assert.equal(score.settings.pageSize, 'Letter'); assert.equal(score.settings.orientation, 'landscape');
  assert.deepEqual(score.settings.marginsMm, { top: 10, bottom: 10, left: 20, right: 20 });
  assert.equal(score.settings.staffSpaceMm, 2); assert.equal(score.settings.measureNumbers, 'all');
  assert.deepEqual(score.settings.textStyles, { title: { size: 7 } });
  assert.notEqual(score.settings.textStyles, st.newScore.textStyles, 'copied, not shared');
  assert.equal(newScoreDefaults({ newScore: { textStyles: { title: { family: '<bad>' } } } }).textStyles, undefined, 'unusable styles are dropped');
  assert.equal(score.settings.systemGapSp, 9, 'other page settings untouched');
  assert.deepEqual(newScoreDefaults({}), {});
});

test('interface size: CSS zoom is capped by what the window can hold', () => {
  // wide windows take the whole range
  assert.equal(maxUiScale('desktop', 1440), 150); assert.equal(maxUiScale('tablet', 1180), 150);
  // narrow ones only as far as the layout keeps its minimum width (tablet 600 px, desktop 880 px)
  assert.equal(maxUiScale('tablet', 820), 135); assert.equal(maxUiScale('tablet', 712), 115); assert.equal(maxUiScale('desktop', 1024), 115);
  assert.equal(maxUiScale('desktop', 900), 100); assert.equal(maxUiScale('tablet', 600), 100); assert.equal(maxUiScale('phone', 412), 100);
  assert.equal(maxUiScale('desktop', undefined), 100, 'never below 100');
  for (const w of [600, 712, 820, 1024, 1280, 1440]) for (const lay of ['tablet', 'desktop']) { const m = maxUiScale(lay, w); assert.equal(m % 5, 0); assert.ok(m >= 100 && m <= 150); assert.ok(m === 100 || w / (m / 100) >= (lay === 'tablet' ? 600 : 880), `${lay} ${w}px at ${m}% keeps the minimum width`); }
  // making things smaller is always possible; bigger is capped; the stored value itself is never changed
  assert.equal(effectiveUiScale(85, 'tablet', 712), 85); assert.equal(effectiveUiScale(100, 'tablet', 712), 100);
  assert.equal(effectiveUiScale(150, 'tablet', 712), 115); assert.equal(effectiveUiScale(110, 'tablet', 712), 110); assert.equal(effectiveUiScale(150, 'desktop', 1440), 150);
  assert.equal(effectiveUiScale(undefined, 'desktop', 1440), 100);
  const it = itemById('uiScale');
  assert.equal(coerce(it, 150), 150); assert.equal(it.max, 150);
});

test('helpers', () => {
  const o = {}; setPath(o, 'a.b.c', 1); assert.equal(getPath(o, 'a.b.c'), 1); assert.equal(getPath(o, 'a.x.c'), undefined);
  setPath(o, 'a.b.c', undefined); assert.deepEqual(o, { a: { b: {} } });
  assert.equal(fmtBytes(0), '0 B'); assert.equal(fmtBytes(1536), '1.5 KB'); assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  // the "변경 내용" link follows the Pages address that tools/set-github-owner.mjs rewrites
  assert.equal(repoUrlFrom('https://someone.github.io/scores/'), 'https://github.com/someone/scores');
  assert.equal(REPO_URL, repoUrlFrom(PAGES_BASE_URL));
  assert.match(REPO_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.match(repoUrlFrom('not a pages url'), /^https:\/\/github\.com\//, 'falls back to a valid address');
});
