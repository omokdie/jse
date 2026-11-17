// Android shim (mobile/www-shim/native-android.js) against a fake Capacitor bridge.
// The web bundle is updated over the air, so a NEW shim must keep working inside an OLD app shell:
// native additions (screen on, immersive, orientation, vibrate) may only appear when the shell has them,
// while the back key (Capacitor's App plugin) works in both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeContext, visibleItems, visibleSections } from '../../app/js/settings.js';

const SHIM = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mobile/www-shim/native-android.js'), 'utf8');
const OLD_METHODS = ['getInfo', 'readPendingFile', 'saveFile', 'shareFile', 'openUrl', 'checkForUpdates', 'getUpdateStatus', 'installUpdate', 'getUpdateSettings', 'setUpdateSettings'];
const NEW_METHODS = ['setKeepScreenOn', 'setImmersive', 'setOrientation', 'vibrate'];
const tick = () => new Promise(r => setTimeout(r, 0));
const plain = v => JSON.parse(JSON.stringify(v));   // objects made inside the sandbox belong to another realm

/** Run the shim in a sandbox that looks like the Capacitor WebView. `shell`: 'old' | 'new' | 'no-app-plugin'. */
function loadShim(shell) {
  const isNew = shell !== 'old';
  const calls = [];              // [plugin, method, options]
  const listeners = [];          // { plugin, eventName, cb }
  const methods = name => (name === 'ScoreSnapNative' ? [...OLD_METHODS, ...(isNew ? NEW_METHODS : [])] : ['exitApp', 'minimizeApp', 'getInfo', 'getState']);
  const plugins = shell === 'no-app-plugin' ? ['ScoreSnapNative'] : ['ScoreSnapNative', 'App'];
  const respond = (plugin, method, options) => {
    if (!plugins.includes(plugin) || (!methods(plugin).includes(method) && method !== 'addListener')) return Promise.reject(new Error(`"${plugin}.${method}()" is not implemented on android`));
    if (method === 'getInfo') return Promise.resolve({ platform: 'android', appVersion: '1.0.2', nativeVersion: '1.0.2', webVersion: '1.0.9', ...(isNew ? { api: 2 } : {}) });
    if (method === 'readPendingFile') return Promise.resolve({ file: null });
    if (method === 'getUpdateStatus') return Promise.resolve({ state: 'idle' });
    if (method === 'getUpdateSettings') return Promise.resolve({ auto: true, channel: 'stable', url: 'https://example.invalid/' });
    return Promise.resolve(options && options.echo ? options : undefined);
  };
  const cap = {
    isNativePlatform: () => true, getPlatform: () => 'android',
    PluginHeaders: plugins.map(name => ({ name, methods: methods(name).map(m => ({ name: m, rtype: 'promise' })) })),
    Plugins: {},
    nativePromise: (plugin, method, options) => { calls.push([plugin, method, options]); return respond(plugin, method, options); },
    nativeCallback: (plugin, method, options, cb) => { calls.push([plugin, method, options]); if (method === 'addListener') listeners.push({ plugin, eventName: options.eventName, cb }); },
  };
  const window = {
    Capacitor: cap,
    ScoreSnapNativeSync: { getInfoJson: () => JSON.stringify({ platform: 'android', appVersion: '1.0.2', nativeVersion: '1.0.2', versionCode: 10002, webVersion: '1.0.9', ...(isNew ? { api: 2 } : {}) }) },
  };
  const sandbox = { window, console, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, navigator: {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { reload() {} }, document: {} };
  vm.runInNewContext(SHIM, sandbox, { filename: 'native-android.js' });
  return { api: window.ScoreSnapNative, calls, listeners, fire: (plugin, eventName, data) => listeners.filter(l => l.plugin === plugin && l.eventName === eventName).forEach(l => l.cb(data)) };
}

test('new shell: the device options are exposed and reach the plugin with clean arguments', async () => {
  const { api, calls } = loadShim('new');
  assert.equal(api.platform, 'android'); assert.equal(api.appVersion, '1.0.2'); assert.equal(api.webVersion, '1.0.9');
  for (const m of ['onOpenFile', 'saveFile', 'openFileDialog', 'shareFile', 'checkForUpdates', 'onUpdateStatus', 'installUpdate', 'getUpdateSettings', 'setUpdateSettings', 'openExternal', 'getInfo']) assert.equal(typeof api[m], 'function', `${m} (existing)`);
  for (const m of [...NEW_METHODS, 'onBackButton', 'minimizeApp', 'exitApp']) assert.equal(typeof api[m], 'function', m);
  calls.length = 0;
  assert.equal(await api.setKeepScreenOn(1), true);
  assert.equal(await api.setImmersive(false), false);
  assert.equal(await api.setOrientation('landscape'), 'landscape');
  assert.equal(await api.setOrientation('upside-down'), 'auto');
  await api.vibrate(4); await api.vibrate(99999); await api.vibrate('x');
  assert.deepEqual(plain(calls), [
    ['ScoreSnapNative', 'setKeepScreenOn', { on: true }], ['ScoreSnapNative', 'setImmersive', { on: false }],
    ['ScoreSnapNative', 'setOrientation', { orientation: 'landscape' }], ['ScoreSnapNative', 'setOrientation', { orientation: 'auto' }],
    ['ScoreSnapNative', 'vibrate', { duration: 4 }], ['ScoreSnapNative', 'vibrate', { duration: 200 }], ['ScoreSnapNative', 'vibrate', { duration: 10 }],
  ]);
});

test('old shell + new web bundle: additions are absent (not broken), everything else still works', async () => {
  const { api, calls } = loadShim('old');
  for (const m of NEW_METHODS) assert.equal(api[m], undefined, `${m} must not be offered by a shell that lacks it`);
  for (const m of ['saveFile', 'checkForUpdates', 'getUpdateSettings', 'onBackButton', 'minimizeApp']) assert.equal(typeof api[m], 'function', m);
  assert.deepEqual(plain(await api.getUpdateSettings()), { auto: true, channel: 'stable', url: 'https://example.invalid/' });
  await tick();
  assert.ok(!calls.some(c => NEW_METHODS.includes(c[1])), 'no call to a method the shell does not have');
  // the settings window hides what this shell cannot do, and keeps the back-button option
  const ctx = makeContext({ shell: 'android', layout: 'phone', touch: true, platform: 'android', native: api, features: { wakeLock: false, vibrate: false, cssZoom: true } });
  assert.deepEqual(visibleItems(ctx, 'android').map(i => i.id), ['backAction']);
  assert.ok(!visibleItems(ctx).some(i => i.id === 'haptics'));
  const full = makeContext({ shell: 'android', layout: 'phone', touch: true, platform: 'android', native: loadShim('new').api, features: { wakeLock: false, vibrate: false, cssZoom: true } });
  assert.deepEqual(visibleItems(full, 'android').map(i => i.id), ['keepScreenOn', 'immersive', 'orientation', 'backAction']);
  assert.ok(visibleItems(full).some(i => i.id === 'haptics'));
  assert.ok(visibleSections(full).some(s => s.id === 'android'));
});

test('back key: one native subscription, every listener called; leaving the app prefers minimise', async () => {
  const { api, calls, listeners, fire } = loadShim('new');
  assert.equal(listeners.filter(l => l.plugin === 'App').length, 0, 'the default back behaviour stays until the app subscribes');
  const seen = [];
  api.onBackButton(e => seen.push(['a', e.canGoBack])); api.onBackButton(e => seen.push(['b', e.canGoBack])); api.onBackButton('not a function');
  assert.equal(listeners.filter(l => l.plugin === 'App' && l.eventName === 'backButton').length, 1);
  fire('App', 'backButton', { canGoBack: true }); fire('App', 'backButton', undefined);
  assert.deepEqual(seen, [['a', true], ['b', true], ['a', undefined], ['b', undefined]]);
  calls.length = 0;
  await api.minimizeApp(); await api.exitApp();
  assert.deepEqual(plain(calls.map(c => c.slice(0, 2))), [['App', 'minimizeApp'], ['App', 'exitApp']]);
});

test('a shell without the App plugin keeps its default back behaviour', () => {
  const { api, listeners } = loadShim('no-app-plugin');
  assert.equal(api.onBackButton, undefined); assert.equal(api.minimizeApp, undefined);
  assert.equal(listeners.length > 0, true, 'our own plugin events are still subscribed');
  assert.ok(listeners.every(l => l.plugin === 'ScoreSnapNative'));
  assert.equal(typeof api.setKeepScreenOn, 'function');
});
