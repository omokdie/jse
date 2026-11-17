// Windows shell (electron/*.js) without Electron: the main process and the preload script run against a
// small fake of the `electron` module, wired together so IPC really travels both ways.
// Covers the desktop options of the settings window (window bounds, start maximised, hardware
// acceleration, default folder, close confirmation, zoom, keep-awake) and checks that the IPC the web app
// already relied on is still there. The real thing can only run in the CI build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../electron');
const winstate = require(path.join(ELECTRON_DIR, 'winstate.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ pure helpers
test('winstate: stored bounds are restored only when they make sense', () => {
  const one = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(winstate.restoreBounds(null, one), { width: 1360, height: 860 });
  assert.deepEqual(winstate.restoreBounds({ x: 'a' }, one), { width: 1360, height: 860 });
  assert.deepEqual(winstate.restoreBounds({ x: 100, y: 60, width: 1500, height: 900 }, one), { x: 100, y: 60, width: 1500, height: 900 });
  // second monitor unplugged: keep the size, let the OS place the window
  assert.deepEqual(winstate.restoreBounds({ x: 2400, y: 100, width: 1200, height: 800 }, one), { width: 1200, height: 800 });
  assert.deepEqual(winstate.restoreBounds({ x: 2400, y: 100, width: 1200, height: 800 }, [...one, { x: 1920, y: 0, width: 1920, height: 1040 }]), { x: 2400, y: 100, width: 1200, height: 800 });
  // title bar above the screen / almost entirely off to the left
  assert.equal(winstate.restoreBounds({ x: 100, y: -500, width: 1200, height: 800 }, one).x, undefined);
  assert.equal(winstate.restoreBounds({ x: -1150, y: 50, width: 1200, height: 800 }, one).x, undefined);
  assert.equal(winstate.restoreBounds({ x: -900, y: 50, width: 1200, height: 800 }, one).x, -900, 'a 300 px strip is still reachable');
  // clamped to the display and to the minimum window size
  assert.deepEqual(winstate.restoreBounds({ x: 0, y: 0, width: 5000, height: 4000 }, one), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(winstate.restoreBounds({ x: 10, y: 10, width: 200, height: 100 }, one), { x: 10, y: 10, width: 900, height: 600 });
  assert.deepEqual(winstate.restoreBounds({ x: 10, y: 10, width: 1000, height: 700 }, []), { width: 1000, height: 700 }, 'no display information → size only');
  assert.deepEqual(winstate.boundsToStore({ x: 10.4, y: 20.6, width: 1000.2, height: 700 }, 1), { bounds: { x: 10, y: 21, width: 1000, height: 700 }, maximized: true });
  assert.equal(winstate.boundsToStore({ x: 0, y: 0, width: 0, height: 0 }, false), null);
});

test('winstate: desktop options are typed and validated', () => {
  assert.deepEqual(winstate.readAppSettings(undefined), { rememberBounds: true, startMaximized: false, disableGpu: false, defaultDir: '' });
  assert.deepEqual(winstate.readAppSettings({ rememberBounds: false, startMaximized: true, disableGpu: 'yes', defaultDir: 5 }), { rememberBounds: false, startMaximized: true, disableGpu: false, defaultDir: '' });
  assert.deepEqual(winstate.cleanAppSettings({ rememberBounds: false, startMaximized: 'x', disableGpu: true, defaultDir: 'C:\\Scores', evil: 1 }), { rememberBounds: false, disableGpu: true, defaultDir: 'C:\\Scores' });
  assert.deepEqual(winstate.cleanAppSettings(null), {});
  assert.deepEqual(winstate.cleanAppSettings({ defaultDir: 'x'.repeat(2000) }), {});
  assert.equal(winstate.cleanZoomFactor(1.25), 1.25); assert.equal(winstate.cleanZoomFactor(9), 2); assert.equal(winstate.cleanZoomFactor(0.1), 0.5);
  assert.equal(winstate.cleanZoomFactor('abc'), 1); assert.equal(winstate.cleanZoomFactor(-1), 1);
});

test('every local module the shell requires is packaged (electron/package.json build.files)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
  const files = new Set(pkg.build.files);
  const needed = new Set(['main.js', 'preload.js', 'package.json']);
  for (const f of fs.readdirSync(ELECTRON_DIR).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8');
    for (const m of src.matchAll(/require\('\.\/([\w.-]+?)(?:\.js)?'\)/g)) needed.add(m[1].endsWith('.json') ? m[1] : m[1] + '.js');
  }
  for (const f of needed) assert.ok(files.has(f), `${f} is required at run time but missing from build.files`);
});

// ------------------------------------------------------------------ fake Electron
/** Fresh fake `electron` + a main process and a preload loaded against it. */
function startShell({ stored = null, platform = 'win32' } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-shell-'));
  if (stored) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(stored));
  const calls = { disableGpu: 0, relaunch: 0, quit: 0, external: [], shown: [], zoom: [], sent: [], openDialogs: [], saveDialogs: [], blocker: [] };
  const rendererListeners = new Map();   // channel → [fn]  (preload side)
  const handlers = new Map();            // channel → fn    (main side, ipcMain.handle)
  const syncHandlers = new Map();
  const windows = [];
  let nextDialog = { open: { canceled: true, filePaths: [] }, save: { canceled: true } };

  class WebContents extends EventEmitter {
    send(channel, ...args) { calls.sent.push([channel, ...args]); (rendererListeners.get(channel) || []).forEach(fn => fn({}, ...args)); }
    setWindowOpenHandler() {}
    setZoomFactor(f) { calls.zoom.push(f); }
  }
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super(); this.opts = opts; this.webContents = new WebContents(); this.destroyed = false; this.maximized = false; this.shown = false;
      this.bounds = { x: opts.x ?? 50, y: opts.y ?? 50, width: opts.width, height: opts.height };
      windows.push(this);
    }
    static fromWebContents(wc) { return windows.find(w => w.webContents === wc) || null; }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
    static getFocusedWindow() { return windows.find(w => !w.destroyed) || null; }
    show() { this.shown = true; } focus() {} restore() {} minimize() {}
    loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; } isMaximized() { return this.maximized; } isMinimized() { return false; } isFullScreen() { return false; } isFocused() { return true; }
    maximize() { this.maximized = true; this.emit('maximize'); } unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    setFullScreen() {}
    getBounds() { return { ...this.bounds }; } getNormalBounds() { return { ...this.bounds }; }
    close() {
      if (this.destroyed) return;
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', ev);
      if (!ev.defaultPrevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    getPath: name => (name === 'userData' ? userData : path.join(userData, name)),
    getVersion: () => '1.0.8', getName: () => 'JSE',
    setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    disableHardwareAcceleration() { calls.disableGpu++; },
    relaunch() { calls.relaunch++; },
    quit() { calls.quit++; app.emit('before-quit', { preventDefault() {} }); windows.forEach(w => w.close()); },
    exit() {},
  });
  const electron = {
    app, BrowserWindow,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => syncHandlers.set(ch, fn) },
    dialog: {
      showOpenDialog: async (win, o) => { calls.openDialogs.push(o); return nextDialog.open; },
      showSaveDialog: async (win, o) => { calls.saveDialogs.push(o); return nextDialog.save; },
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: { openExternal: async u => { calls.external.push(u); }, showItemInFolder: p => { calls.shown.push(p); } },
    Menu: { setApplicationMenu() {}, buildFromTemplate: t => t },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
    powerSaveBlocker: (() => { const on = new Set(); let id = 0; return { start: kind => { on.add(++id); calls.blocker.push(['start', kind]); return id; }, stop: i => { on.delete(i); calls.blocker.push(['stop']); }, isStarted: i => on.has(i) }; })(),
    protocol: { registerSchemesAsPrivileged() {}, handle() {}, registerFileProtocol() {}, registerBufferProtocol() {} },
    net: { isOnline: () => false, fetch: async () => { throw new Error('offline'); } },
    session: { defaultSession: { protocol: { handle() {} } } },
    // preload side
    contextBridge: { exposeInMainWorld: (name, api) => { shell.api = api; shell.apiName = name; } },
    ipcRenderer: {
      sendSync: ch => { const ev = {}; syncHandlers.get(ch)?.(ev); return ev.returnValue; },
      on: (ch, fn) => { if (!rendererListeners.has(ch)) rendererListeners.set(ch, []); rendererListeners.get(ch).push(fn); },
      invoke: async (ch, ...args) => { const h = handlers.get(ch); if (!h) throw new Error(`No handler registered for '${ch}'`); return h({ sender: windows[windows.length - 1]?.webContents }, ...args); },
    },
  };
  const log = { transports: { file: {} }, errorHandler: { startCatching() {} }, info() {}, warn() {}, error() {}, debug() {} };
  const shell = { calls, handlers, windows, userData, electron, app, api: null, setDialog: d => { nextDialog = { ...nextDialog, ...d }; } };

  // load the shell's modules fresh, with `electron` & friends replaced
  const realLoad = Module._load;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const k of Object.keys(require.cache)) if (k.startsWith(ELECTRON_DIR + path.sep) && !k.endsWith('winstate.js')) delete require.cache[k];
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === 'electron-log/main') return log;
    if (request === 'electron-updater') return { autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: async () => null, quitAndInstall() {} }) };
    return realLoad.call(this, request, ...rest);
  };
  Object.defineProperty(process, 'platform', { value: platform });
  globalThis.window = { addEventListener() {} };
  // the fake stays in place for the life of this shell: main.js also requires `electron` lazily (screen)
  shell.dispose = () => { Module._load = realLoad; Object.defineProperty(process, 'platform', realPlatform); delete globalThis.window; fs.rmSync(userData, { recursive: true, force: true }); };
  try {
    shell.main = require(path.join(ELECTRON_DIR, 'main.js'));
    shell.settings = require(path.join(ELECTRON_DIR, 'settings.js'));
  } catch (e) { shell.dispose(); throw e; }
  // the preload script runs when a page loads — after main registered its IPC (it reads the version synchronously)
  shell.loadPreload = () => require(path.join(ELECTRON_DIR, 'preload.js'));
  shell.invoke = (ch, ...args) => electron.ipcRenderer.invoke(ch, ...args);
  shell.readStore = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  return shell;
}
/** whenReady().then(...) has run and the first window exists. */
async function ready(shell) { await sleep(0); await sleep(0); assert.equal(shell.windows.length, 1, 'main window created'); shell.loadPreload(); return shell.windows[0]; }

test('shell starts; the IPC the web app already used is still there, the new one is added', async () => {
  const sh = startShell();
  try {
    const win = await ready(sh);
    assert.equal(sh.calls.disableGpu, 0);
    assert.deepEqual({ w: win.opts.width, h: win.opts.height, minW: win.opts.minWidth, minH: win.opts.minHeight }, { w: 1360, h: 860, minW: 900, minH: 600 });
    assert.equal(win.opts.x, undefined, 'no stored position on first start');
    win.emit('ready-to-show'); assert.equal(win.shown, true); assert.equal(win.maximized, false);
    for (const ch of ['scoresnap:get-app-version', 'scoresnap:ready', 'scoresnap:save-file', 'scoresnap:open-dialog', 'scoresnap:update-check', 'scoresnap:update-install',
      'scoresnap:update-get-settings', 'scoresnap:update-set-settings', 'scoresnap:update-last-status', 'scoresnap:win', 'scoresnap:open-external', 'scoresnap:show-in-folder']) assert.ok(sh.handlers.has(ch), `${ch} (existing)`);
    for (const ch of ['scoresnap:app-settings-get', 'scoresnap:app-settings-set', 'scoresnap:choose-folder', 'scoresnap:open-system-settings', 'scoresnap:show-settings-file',
      'scoresnap:relaunch', 'scoresnap:set-zoom', 'scoresnap:keep-awake', 'scoresnap:app-info', 'scoresnap:close-guard', 'scoresnap:close-ack']) assert.ok(sh.handlers.has(ch), `${ch} (new)`);
    // preload: SPEC §6 surface + the additions
    const api = sh.api; assert.equal(sh.apiName, 'ScoreSnapNative');
    assert.equal(api.platform, 'windows'); assert.equal(api.appVersion, '1.0.8');
    for (const m of ['onOpenFile', 'saveFile', 'openFileDialog', 'checkForUpdates', 'onUpdateStatus', 'installUpdate', 'getUpdateSettings', 'setUpdateSettings', 'onMenu', 'openExternal', 'showInFolder']) assert.equal(typeof api[m], 'function', m);
    for (const m of ['minimize', 'toggleMaximize', 'toggleFullScreen', 'close', 'getState', 'onStateChange']) assert.equal(typeof api.windowControls[m], 'function', `windowControls.${m}`);
    for (const m of ['getAppSettings', 'setAppSettings', 'chooseFolder', 'openSystemSettings', 'showSettingsFile', 'relaunch', 'setZoomFactor', 'setKeepScreenOn', 'getAppInfo', 'onCloseRequest']) assert.equal(typeof api[m], 'function', m);
    assert.deepEqual(await api.getUpdateSettings(), { auto: true, channel: 'latest', url: (await api.getUpdateSettings()).url });
    assert.deepEqual(await api.windowControls.getState(), { maximized: false, fullscreen: false, focused: true });
    const info = await api.getAppInfo(); assert.equal(info.version, '1.0.8'); assert.equal(info.gpuDisabled, false); assert.match(info.homepage, /^https:\/\/github\.com\//);
  } finally { sh.dispose(); }
});

test('desktop options are stored and used: default folder, zoom, keep-awake, system settings', async () => {
  const sh = startShell();
  try {
    await ready(sh);
    const api = sh.api;
    assert.deepEqual(await api.getAppSettings(), { rememberBounds: true, startMaximized: false, disableGpu: false, defaultDir: '', lastDir: '', settingsFile: path.join(sh.userData, 'settings.json') });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jse-scores-'));
    const next = await api.setAppSettings({ startMaximized: true, disableGpu: true, defaultDir: dir, nonsense: 1, rememberBounds: 'no' });
    assert.deepEqual(next, { rememberBounds: true, startMaximized: true, disableGpu: true, defaultDir: dir });
    assert.deepEqual(sh.readStore().app, next, 'written to settings.json');
    // open / save dialogs start in the chosen folder …
    assert.equal(sh.main.dialogDir(), dir);
    await api.openFileDialog({ accept: ['.ssnap'] });
    assert.equal(sh.calls.openDialogs.at(-1).defaultPath, dir);
    const target = path.join(dir, 'song.ssnap');
    sh.setDialog({ save: { canceled: false, filePath: target } });
    const saved = await api.saveFile({ name: 'song.ssnap', mime: 'application/x-scoresnap', base64: Buffer.from('hello').toString('base64'), suggestDialog: true });
    assert.deepEqual(saved, { path: target });
    assert.equal(sh.calls.saveDialogs.at(-1).defaultPath, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
    // … and fall back to the last used one when it disappears
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(sh.main.dialogDir(), dir, 'saving just made it the last used folder as well');
    await api.setAppSettings({ defaultDir: path.join(os.tmpdir(), 'jse-does-not-exist') });
    assert.equal(sh.main.dialogDir(), dir);
    // choose-folder
    sh.setDialog({ open: { canceled: false, filePaths: ['/music/scores'] } });
    assert.equal(await api.chooseFolder({ defaultPath: '/music' }), '/music/scores');
    assert.deepEqual(sh.calls.openDialogs.at(-1).properties, ['openDirectory', 'createDirectory']);
    sh.setDialog({ open: { canceled: true, filePaths: [] } });
    assert.equal(await api.chooseFolder(), null);
    // zoom factor (설정 › 화면 › 화면 요소 크기)
    assert.equal(await api.setZoomFactor(1.25), 1.25); assert.equal(await api.setZoomFactor(99), 2); assert.equal(await api.setZoomFactor('x'), 1);
    assert.deepEqual(sh.calls.zoom, [1.25, 2, 1]);
    // keep the display awake
    assert.equal(await api.setKeepScreenOn(true), true); assert.equal(await api.setKeepScreenOn(true), true);
    assert.equal(await api.setKeepScreenOn(false), false); assert.equal(await api.setKeepScreenOn(false), false);
    assert.deepEqual(sh.calls.blocker, [['start', 'prevent-display-sleep'], ['stop']]);
    // Windows settings page for file associations, settings file in Explorer
    assert.equal(await api.openSystemSettings('default-apps'), true); assert.deepEqual(sh.calls.external, ['ms-settings:defaultapps']);
    assert.equal(await api.openSystemSettings('something-else'), false); assert.equal(sh.calls.external.length, 1);
    await api.showSettingsFile(); assert.deepEqual(sh.calls.shown, [path.join(sh.userData, 'settings.json')]);
    // existing update setting still round-trips through the same store
    await api.setUpdateSettings({ auto: false }); assert.equal((await api.getUpdateSettings()).auto, false); assert.equal(sh.readStore().update.auto, false);
    assert.deepEqual(sh.readStore().app.startMaximized, true, 'other sections untouched');
  } finally { sh.dispose(); }
});

test('window size and position: remembered, restored, start maximised, hardware acceleration off', async () => {
  const sh = startShell({ stored: { app: { rememberBounds: true, startMaximized: false, disableGpu: true }, window: { bounds: { x: 200, y: 120, width: 1500, height: 950 }, maximized: true }, lastDir: '/tmp' } });
  try {
    const win = await ready(sh);
    assert.equal(sh.calls.disableGpu, 1, 'disableHardwareAcceleration() before the app is ready');
    assert.equal((await sh.api.getAppInfo()).gpuDisabled, true);
    assert.deepEqual({ x: win.opts.x, y: win.opts.y, width: win.opts.width, height: win.opts.height }, { x: 200, y: 120, width: 1500, height: 950 });
    win.emit('ready-to-show'); assert.equal(win.maximized, true, 'was maximised when it closed'); assert.equal(win.shown, true);
    // moving / resizing is written (debounced), closing writes immediately
    win.maximized = false; win.bounds = { x: 300, y: 140, width: 1280, height: 800 }; win.emit('resize');
    await sleep(750);
    assert.deepEqual(sh.readStore().window, { bounds: { x: 300, y: 140, width: 1280, height: 800 }, maximized: false });
    win.bounds = { x: 10, y: 20, width: 1000, height: 700 }; win.close();
    assert.equal(win.destroyed, true);
    assert.deepEqual(sh.readStore().window.bounds, { x: 10, y: 20, width: 1000, height: 700 });
    assert.equal(sh.readStore().lastDir, '/tmp', 'other keys kept');
  } finally { sh.dispose(); }

  const off = startShell({ stored: { app: { rememberBounds: false, startMaximized: true }, window: { bounds: { x: 200, y: 120, width: 1500, height: 950 }, maximized: false } } });
  try {
    const win = await ready(off);
    assert.deepEqual({ x: win.opts.x, width: win.opts.width, height: win.opts.height }, { x: undefined, width: 1360, height: 860 }, 'not restored when the option is off');
    win.emit('ready-to-show'); assert.equal(win.maximized, true, '시작할 때 최대화');
    win.bounds = { x: 1, y: 2, width: 1111, height: 777 }; win.close();
    assert.deepEqual(off.readStore().window.bounds, { x: 200, y: 120, width: 1500, height: 950 }, 'nothing written while the option is off');
    await off.invoke('scoresnap:app-settings-set', { rememberBounds: false });
    assert.equal(off.readStore().window, undefined, 'switching it off forgets the stored geometry');
  } finally { off.dispose(); }

  // a position on a display that no longer exists is dropped
  const gone = startShell({ stored: { window: { bounds: { x: 5000, y: 100, width: 1200, height: 800 } } } });
  try { const win = await ready(gone); assert.deepEqual({ x: win.opts.x, y: win.opts.y, width: win.opts.width, height: win.opts.height }, { x: undefined, y: undefined, width: 1200, height: 800 }); }
  finally { gone.dispose(); }
});

test('close confirmation: the web app is asked, can cancel, and can never trap the window', async () => {
  // 1. no subscription (older web bundle): closing works as before
  let sh = startShell();
  try { const win = await ready(sh); await sh.invoke('scoresnap:ready'); win.close(); assert.equal(win.destroyed, true); } finally { sh.dispose(); }

  // 2. subscribed: Alt+F4 → request → the app answers through windowControls.close()
  sh = startShell();
  try {
    const win = await ready(sh); await sh.invoke('scoresnap:ready');
    let asked = 0, answer = 'cancel';
    sh.api.onCloseRequest(() => { asked++; if (answer === 'close') sh.api.windowControls.close(); });
    await sleep(0);
    win.close();
    assert.equal(win.destroyed, false, 'close was held back'); assert.equal(asked, 1);
    assert.ok(sh.calls.sent.some(m => m[0] === 'scoresnap:close-request'));
    await sleep(CLOSE_WAIT);
    assert.equal(win.destroyed, false, 'the app acknowledged: no forced close while it shows its question');
    win.close(); assert.equal(asked, 2, 'asked again after the user cancelled');
    answer = 'close'; win.close(); await sleep(0); await sleep(0);
    assert.equal(asked, 3); assert.equal(win.destroyed, true, 'closed once the app agreed');
  } finally { sh.dispose(); }

  // 3. the ✕ button of the web title bar (requestClose → windowControls.close) closes directly
  sh = startShell();
  try {
    const win = await ready(sh); await sh.invoke('scoresnap:ready');
    let asked = 0; sh.api.onCloseRequest(() => { asked++; }); await sleep(0);
    await sh.api.windowControls.close();
    assert.equal(win.destroyed, true); assert.equal(asked, 0);
  } finally { sh.dispose(); }

  // 4. a renderer that never acknowledges (hung page) is not allowed to keep the window open
  sh = startShell();
  try {
    const win = await ready(sh); await sh.invoke('scoresnap:ready');
    await sh.invoke('scoresnap:close-guard', true);
    sh.electron.ipcRenderer.invoke = async () => new Promise(() => {});   // nothing comes back any more
    const stuck = sh.windows[0].webContents; stuck.send = () => {};       // …and nothing arrives
    win.close(); assert.equal(win.destroyed, false);
    await sleep(CLOSE_WAIT);
    assert.equal(win.destroyed, true, 'forced after the acknowledgement timeout');
  } finally { sh.dispose(); }

  // 5. quitting (updater install, relaunch, menu Quit) and page reloads bypass the question
  sh = startShell();
  try {
    const win = await ready(sh); await sh.invoke('scoresnap:ready');
    let asked = 0; sh.api.onCloseRequest(() => { asked++; }); await sleep(0);
    win.webContents.emit('did-start-loading');     // reload: the old page's subscription is void
    win.close(); assert.equal(win.destroyed, true); assert.equal(asked, 0);
  } finally { sh.dispose(); }
  sh = startShell();
  try {
    const win = await ready(sh); await sh.invoke('scoresnap:ready');
    let asked = 0; sh.api.onCloseRequest(() => { asked++; }); await sleep(0);
    await sh.api.relaunch();
    assert.equal(sh.calls.relaunch, 1); assert.equal(sh.calls.quit, 1); assert.equal(win.destroyed, true); assert.equal(asked, 0);
  } finally { sh.dispose(); }
});
const CLOSE_WAIT = 2700;   // a little more than main.js CLOSE_ACK_MS
