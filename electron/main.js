'use strict';
/**
 * JSE — Electron main process (Windows desktop shell).
 *
 *  - single instance; .ssnap files from argv / second-instance / open-file are
 *    read here and pushed to the renderer once it reported 'scoresnap:ready'
 *  - the web app (../app) is served from app://scoresnap/ (see protocol.js)
 *  - IPC: save-file, open-dialog, update-*, open-external, get-app-version
 *  - native menu forwards actions to the renderer ('scoresnap:menu')
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log/main');

const proto = require('./protocol');
const updater = require('./updater');
const settings = require('./settings');
const { buildMenu } = require('./menu');

const APP_ID = 'kr.scoresnap.app';
const SSNAP_MIME = 'application/x-scoresnap';
const MAX_OPEN_BYTES = 200 * 1024 * 1024; // sanity limit for files handed to the renderer

/* ------------------------------------------------------------------ logging */
try {
  log.transports.file.level = 'info';
  log.transports.file.maxSize = 2 * 1024 * 1024;
  if (log.errorHandler && typeof log.errorHandler.startCatching === 'function') {
    log.errorHandler.startCatching({ showDialog: false });
  }
} catch {
  /* logging is best effort */
}

/* ------------------------------------------------------------------ state */
let mainWindow = null;
let rendererReady = false;
const pendingFiles = []; // payloads waiting for the renderer
/** name → absolute path of the file it was opened from / last saved to (enables "Save" without a dialog). */
const knownPaths = new Map();

/* ------------------------------------------------------------------ MIME / filters */
const MIME_BY_EXT = {
  '.ssnap': SSNAP_MIME,
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.xml': 'application/vnd.recordare.musicxml+xml',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.musx': 'application/vnd.makemusic.notation',
  '.ftmx': 'application/vnd.makemusic.notation',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

const FILTER_BY_MIME = {
  [SSNAP_MIME]: { name: 'JSE 악보', extensions: ['ssnap'] },
  'application/pdf': { name: 'PDF 문서', extensions: ['pdf'] },
  'image/png': { name: 'PNG 이미지', extensions: ['png'] },
  'image/jpeg': { name: 'JPEG 이미지', extensions: ['jpg', 'jpeg'] },
  'image/webp': { name: 'WebP 이미지', extensions: ['webp'] },
  'image/svg+xml': { name: 'SVG 이미지', extensions: ['svg'] },
  'application/vnd.recordare.musicxml+xml': { name: 'MusicXML', extensions: ['musicxml', 'xml'] },
  'application/vnd.recordare.musicxml': { name: 'MusicXML (압축)', extensions: ['mxl'] },
  'application/vnd.makemusic.notation': { name: 'Finale 악보', extensions: ['musx', 'ftmx'] },
  'audio/midi': { name: 'MIDI', extensions: ['mid', 'midi'] },
  'audio/mid': { name: 'MIDI', extensions: ['mid', 'midi'] },
  'application/json': { name: 'JSON', extensions: ['json'] },
};

const ALL_FILES = { name: '모든 파일', extensions: ['*'] };

function mimeForFile(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function safeBaseName(name, fallback) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  return base || fallback;
}

/** Build dialog filters for a save: by mime first, then by the name's extension. */
function saveFilters(mime, name) {
  const filters = [];
  if (mime && FILTER_BY_MIME[mime]) filters.push(FILTER_BY_MIME[mime]);
  const ext = path.extname(name || '').toLowerCase();
  if (ext && !filters.some((f) => f.extensions.includes(ext.slice(1)))) {
    filters.push({ name: `${ext.slice(1).toUpperCase()} 파일`, extensions: [ext.slice(1)] });
  }
  filters.push(ALL_FILES);
  return filters;
}

/**
 * accept: [".ssnap", ".musicxml", "image/*", "application/pdf", …] → dialog filters
 */
function openFilters(accept) {
  const exts = new Set();
  const list = Array.isArray(accept) ? accept : [];
  for (const raw of list) {
    const a = String(raw || '').trim().toLowerCase();
    if (!a) continue;
    if (a.startsWith('.')) exts.add(a.slice(1));
    else if (a === 'image/*') ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'].forEach((e) => exts.add(e));
    else if (FILTER_BY_MIME[a]) FILTER_BY_MIME[a].extensions.forEach((e) => exts.add(e));
    else if (/^[a-z0-9]+$/.test(a)) exts.add(a);
  }
  const filters = [];
  if (exts.size) filters.push({ name: '지원하는 파일', extensions: [...exts] });
  for (const f of Object.values(FILTER_BY_MIME)) {
    if (f.extensions.some((e) => exts.has(e)) && !filters.includes(f)) filters.push(f);
  }
  filters.push(ALL_FILES);
  return filters;
}

/* ------------------------------------------------------------------ file open */

/** Pick .ssnap paths out of a command line (dev: argv[1] is "." / the app dir). */
function extractFileArgs(argv, cwd) {
  const out = [];
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.startsWith('--') || arg.startsWith('-')) continue;
    if (!/\.(ssnap|musx|ftmx|musicxml|mxl)$/i.test(arg)) continue;
    const abs = path.isAbsolute(arg) ? arg : path.resolve(cwd || process.cwd(), arg);
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch {
      /* ignore non-existent */
    }
  }
  return out;
}

async function readFilePayload(filePath) {
  const st = await fs.promises.stat(filePath);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_OPEN_BYTES) throw new Error('file too large');
  const buf = await fs.promises.readFile(filePath);
  return {
    name: path.basename(filePath),
    mime: mimeForFile(filePath),
    base64: buf.toString('base64'),
    size: st.size,
    path: filePath,
  };
}

function flushPendingFiles() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  while (pendingFiles.length) {
    const payload = pendingFiles.shift();
    mainWindow.webContents.send('scoresnap:open-file', payload);
  }
}

async function openPath(filePath) {
  try {
    const payload = await readFilePayload(filePath);
    knownPaths.set(payload.name, filePath);
    settings.set('lastDir', path.dirname(filePath));
    pendingFiles.push(payload);
    flushPendingFiles();
    log.info('open-file queued', filePath);
  } catch (err) {
    log.warn('open-file failed', filePath, err && err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'JSE',
        message: '파일을 열 수 없습니다.',
        detail: `${filePath}\n${err && err.message ? err.message : ''}`,
        buttons: ['확인'],
      });
    }
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#dfe6fa',
    // The web UI draws its own liquid-glass title bar with minimise / maximise / close buttons
    // (see app/js/ui/ui.js → windowControls). The native frame is hidden but the window keeps
    // its resize borders and Aero-snap behaviour; the top bar is a drag region (-webkit-app-region).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 22 },
    title: 'JSE',
    icon: app.isPackaged ? undefined : path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // The renderer re-announces itself (preload → 'scoresnap:ready') after every load.
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  // Links: open http(s) in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(proto.APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Window-state changes are mirrored to the renderer so the maximise button can show "restore".
  const sendWinState = () => sendToRenderer('scoresnap:win-state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() });
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore'].forEach((ev) => win.on(ev, sendWinState));

  win.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  win.loadURL(proto.INDEX_URL);
  return win;
}

/* ------------------------------------------------------------------ IPC */

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function registerIpc() {
  ipcMain.on('scoresnap:get-app-version-sync', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.handle('scoresnap:get-app-version', () => app.getVersion());

  ipcMain.handle('scoresnap:ready', () => {
    rendererReady = true;
    flushPendingFiles();
    updater.onRendererReady();
    return { appVersion: app.getVersion(), platform: process.platform };
  });

  ipcMain.handle('scoresnap:save-file', async (event, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (typeof o.base64 !== 'string') throw new Error('base64 data required');
    const mime = typeof o.mime === 'string' ? o.mime : 'application/octet-stream';
    const name = safeBaseName(o.name, 'score.ssnap');
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;

    let target = knownPaths.get(name) || null;
    if (target) {
      try {
        if (!fs.statSync(path.dirname(target)).isDirectory()) target = null;
      } catch {
        target = null;
      }
    }

    if (o.suggestDialog || !target) {
      const lastDir = settings.get('lastDir', app.getPath('documents'));
      const defaultPath = target || path.join(lastDir, name);
      const res = await dialog.showSaveDialog(win, {
        title: '저장',
        defaultPath,
        filters: saveFilters(mime, name),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }

    const data = Buffer.from(o.base64, 'base64');
    await writeAtomic(target, data);
    knownPaths.set(name, target);
    knownPaths.set(path.basename(target), target);
    settings.set('lastDir', path.dirname(target));
    log.info('saved', target, data.length, 'bytes');
    return { path: target };
  });

  ipcMain.handle('scoresnap:open-dialog', async (event, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const res = await dialog.showOpenDialog(win, {
      title: '열기',
      defaultPath: settings.get('lastDir', app.getPath('documents')),
      filters: openFilters(o.accept),
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    const payload = await readFilePayload(filePath);
    knownPaths.set(payload.name, filePath);
    settings.set('lastDir', path.dirname(filePath));
    return { name: payload.name, mime: payload.mime, base64: payload.base64, size: payload.size, path: filePath };
  });

  ipcMain.handle('scoresnap:update-check', async () => {
    await updater.check(true);
  });
  ipcMain.handle('scoresnap:update-install', async () => {
    await updater.installUpdate();
  });
  ipcMain.handle('scoresnap:update-get-settings', () => updater.getSettings());
  ipcMain.handle('scoresnap:update-set-settings', (event, partial) => updater.setSettings(partial));
  ipcMain.handle('scoresnap:update-last-status', () => updater.getLastStatus());

  // ---- custom title-bar buttons ----
  ipcMain.handle('scoresnap:win', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    switch (String(action)) {
      case 'minimize': win.minimize(); break;
      case 'toggle-maximize': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
      case 'toggle-fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'close': win.close(); break;
      default: break;
    }
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
  });

  ipcMain.handle('scoresnap:open-external', async (event, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    await shell.openExternal(u);
    return true;
  });

  ipcMain.handle('scoresnap:show-in-folder', (event, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });
}

/** Write via temp file + rename so a crash never leaves a truncated .ssnap behind. */
async function writeAtomic(target, data) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* ignore */
    }
    // Fallback (e.g. rename refused by a sync client): plain write.
    await fs.promises.writeFile(target, data);
  }
}

/* ------------------------------------------------------------------ app lifecycle */

function bootstrap() {
  // Files from a second launch (double-click while running) are forwarded here.
  app.on('second-instance', (event, argv, workingDirectory) => {
    focusMainWindow();
    for (const f of extractFileArgs(argv, workingDirectory)) openPath(f);
  });

  // macOS: Finder → open with
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    openPath(filePath);
  });

  app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.whenReady().then(() => {
    proto.registerAppProtocol(log);
    registerIpc();
    if (process.platform === 'darwin') {
      buildMenu({
        sendAction: (action, payload) => sendToRenderer('scoresnap:menu', action, payload),
        checkForUpdates: () => updater.check(true),
      });
    } else {
      // Windows/Linux: the app shows its own menus inside the glass title bar; a native menu would
      // only duplicate keyboard shortcuts (Ctrl+S, Ctrl+Z …) that the web app already handles.
      Menu.setApplicationMenu(null);
    }
    createWindow();
    updater.init({ send: sendToRenderer });

    for (const f of extractFileArgs(process.argv, process.cwd())) openPath(f);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ------------------------------------------------------------------ single instance + start */
app.setAppUserModelId(APP_ID); // must equal build.appId so taskbar/shortcut grouping works

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  proto.registerSchemes(); // must happen before 'ready'
  bootstrap();
}

module.exports = { extractFileArgs, openFilters, saveFilters, safeBaseName, mimeForFile };
