'use strict';
/**
 * Preload — exposes window.ScoreSnapNative (SPEC §6) to the web app.
 *
 * Everything crosses the context bridge as plain data.  Events that may arrive
 * before the app subscribed (a file from the command line, an update status)
 * are buffered here and replayed to the first subscriber.
 */
const { contextBridge, ipcRenderer } = require('electron');

const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';

let appVersion = '0.0.0';
try {
  appVersion = String(ipcRenderer.sendSync('scoresnap:get-app-version-sync') || appVersion);
} catch {
  /* keep default */
}

function safeCall(cb, ...args) {
  try {
    cb(...args);
  } catch (err) {
    console.error('[ScoreSnapNative] listener error', err);
  }
}

/* ---- open-file: buffered until the first onOpenFile() subscriber ---- */
const fileListeners = [];
const fileQueue = [];
ipcRenderer.on('scoresnap:open-file', (_event, file) => {
  if (!file || typeof file !== 'object') return;
  const payload = { name: String(file.name || ''), mime: String(file.mime || ''), base64: String(file.base64 || ''), path: file.path || '' };
  if (fileListeners.length) fileListeners.forEach((cb) => safeCall(cb, payload));
  else fileQueue.push(payload);
});

/* ---- update status: last status replayed; "done" delivered once ---- */
const statusListeners = [];
let lastStatus = null;
let pendingDone = null;
ipcRenderer.on('scoresnap:update-status', (_event, status) => {
  if (!status || typeof status !== 'object') return;
  if (status.state === 'done' && !statusListeners.length) {
    pendingDone = status;
    return;
  }
  lastStatus = status;
  statusListeners.forEach((cb) => safeCall(cb, status));
});

/* ---- native menu actions ---- */
const menuListeners = [];
ipcRenderer.on('scoresnap:menu', (_event, action, payload) => {
  menuListeners.forEach((cb) => safeCall(cb, String(action), payload));
});

/* ---- close confirmation: main asks before the window closes (Alt+F4, taskbar) once the app subscribed ---- */
const closeListeners = [];
ipcRenderer.on('scoresnap:close-request', () => {
  ipcRenderer.invoke('scoresnap:close-ack').catch(() => {});
  if (!closeListeners.length) {
    ipcRenderer.invoke('scoresnap:win', 'close').catch(() => {});
    return;
  }
  closeListeners.forEach((cb) => safeCall(cb));
});

function cleanSaveOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    name: typeof o.name === 'string' ? o.name : '',
    mime: typeof o.mime === 'string' ? o.mime : 'application/octet-stream',
    base64: typeof o.base64 === 'string' ? o.base64 : '',
    suggestDialog: !!o.suggestDialog,
  };
}

const api = {
  platform: PLATFORM,
  appVersion,

  // ---- files ----
  onOpenFile(cb) {
    if (typeof cb !== 'function') return;
    fileListeners.push(cb);
    while (fileQueue.length) safeCall(cb, fileQueue.shift());
  },
  saveFile(opts) {
    return ipcRenderer.invoke('scoresnap:save-file', cleanSaveOpts(opts));
  },
  openFileDialog(opts) {
    const accept = opts && Array.isArray(opts.accept) ? opts.accept.map(String) : [];
    return ipcRenderer.invoke('scoresnap:open-dialog', { accept });
  },

  // ---- updates ----
  checkForUpdates() {
    return ipcRenderer.invoke('scoresnap:update-check');
  },
  onUpdateStatus(cb) {
    if (typeof cb !== 'function') return;
    statusListeners.push(cb);
    if (pendingDone) {
      const d = pendingDone;
      pendingDone = null;
      safeCall(cb, d);
    }
    if (lastStatus) safeCall(cb, lastStatus);
  },
  installUpdate() {
    return ipcRenderer.invoke('scoresnap:update-install');
  },
  getUpdateSettings() {
    return ipcRenderer.invoke('scoresnap:update-get-settings');
  },
  setUpdateSettings(s) {
    const partial = {};
    if (s && typeof s.auto === 'boolean') partial.auto = s.auto;
    return ipcRenderer.invoke('scoresnap:update-set-settings', partial);
  },

  // ---- custom title bar (frameless window) ----
  windowControls: {
    minimize: () => ipcRenderer.invoke('scoresnap:win', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('scoresnap:win', 'toggle-maximize'),
    toggleFullScreen: () => ipcRenderer.invoke('scoresnap:win', 'toggle-fullscreen'),
    close: () => ipcRenderer.invoke('scoresnap:win', 'close'),
    getState: () => ipcRenderer.invoke('scoresnap:win', 'state'),
    onStateChange(cb) {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('scoresnap:win-state', (_e, st) => safeCall(cb, st));
    },
  },

  // ---- desktop extras (not in SPEC §6, optional for the web app) ----
  onMenu(cb) {
    if (typeof cb === 'function') menuListeners.push(cb);
  },
  openExternal(url) {
    return ipcRenderer.invoke('scoresnap:open-external', String(url || ''));
  },
  showInFolder(filePath) {
    return ipcRenderer.invoke('scoresnap:show-in-folder', String(filePath || ''));
  },

  // ---- settings window: desktop options (설정 › Windows 앱); every call resolves, none is required by the web app ----
  getAppSettings() {
    return ipcRenderer.invoke('scoresnap:app-settings-get');
  },
  setAppSettings(partial) {
    const p = partial && typeof partial === 'object' ? partial : {};
    const clean = {};
    for (const k of ['rememberBounds', 'startMaximized', 'disableGpu']) if (typeof p[k] === 'boolean') clean[k] = p[k];
    if (typeof p.defaultDir === 'string') clean.defaultDir = p.defaultDir;
    return ipcRenderer.invoke('scoresnap:app-settings-set', clean);
  },
  chooseFolder(opts) {
    const defaultPath = opts && typeof opts.defaultPath === 'string' ? opts.defaultPath : '';
    return ipcRenderer.invoke('scoresnap:choose-folder', { defaultPath });
  },
  openSystemSettings(what) {
    return ipcRenderer.invoke('scoresnap:open-system-settings', String(what || ''));
  },
  showSettingsFile() {
    return ipcRenderer.invoke('scoresnap:show-settings-file');
  },
  relaunch() {
    return ipcRenderer.invoke('scoresnap:relaunch');
  },
  setZoomFactor(factor) {
    return ipcRenderer.invoke('scoresnap:set-zoom', Number(factor) || 1);
  },
  setKeepScreenOn(on) {
    return ipcRenderer.invoke('scoresnap:keep-awake', !!on);
  },
  getAppInfo() {
    return ipcRenderer.invoke('scoresnap:app-info');
  },
  /** The web app wants to be asked before the window closes; it answers with windowControls.close(). */
  onCloseRequest(cb) {
    if (typeof cb !== 'function') return;
    closeListeners.push(cb);
    ipcRenderer.invoke('scoresnap:close-guard', true).catch(() => {});
  },
};

contextBridge.exposeInMainWorld('ScoreSnapNative', api);

// Tell main we can receive messages (queued files / statuses are flushed then).
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.invoke('scoresnap:ready').catch(() => {});
});
