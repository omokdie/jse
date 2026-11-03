'use strict';
/**
 * Auto-update (Windows) — thin wrapper around electron-updater.
 *
 *  feed      : GitHub Releases of build.publish[0] (latest.yml + JSE-Setup-x.y.z.exe)
 *  policy    : autoDownload (when settings.update.auto, default true), autoInstallOnAppQuit
 *  statuses  : SPEC §6 UpdateStatus objects → webContents.send('scoresnap:update-status', s)
 *  re-check  : every 4 hours while online
 *  "done"    : emitted once on the first launch after an update was applied
 *              (we remember the downloaded version; if it equals the running version, it was installed)
 *
 * Nothing here ever throws to the renderer: every failure becomes {state:'error', message}.
 */
const { app, net } = require('electron');
const log = require('electron-log/main');
const settings = require('./settings');
const pkg = require('./package.json');

const PLACEHOLDER_OWNER = 'REPLACE_GITHUB_OWNER';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8 * 1000;

let autoUpdater = null;        // lazily required (keeps `electron .` working even if deps are broken)
let sendToRenderer = () => {};
let lastStatus = { state: 'idle' };
let doneStatus = null;         // {state:'done', version} to deliver once to the renderer
let availableVersion = null;
let downloadedVersion = null;
let installWhenDownloaded = false;
let checking = false;
let errorReported = false;
let timer = null;
let initialized = false;

/* ------------------------------------------------------------------ helpers */

function githubPublish() {
  const p = pkg.build && pkg.build.publish;
  const list = Array.isArray(p) ? p : p ? [p] : [];
  return list.find((x) => x && x.provider === 'github') || null;
}

function isConfigured() {
  const gh = githubPublish();
  return !!(gh && gh.owner && gh.owner !== PLACEHOLDER_OWNER && gh.repo);
}

function feedUrl() {
  const gh = githubPublish();
  if (!gh) return '';
  return `https://github.com/${gh.owner}/${gh.repo}/releases`;
}

function isOnline() {
  try {
    return typeof net.isOnline === 'function' ? net.isOnline() : true;
  } catch {
    return true;
  }
}

function autoEnabled() {
  return settings.getIn('update', 'auto', true) !== false;
}

function emit(status) {
  lastStatus = status;
  try {
    sendToRenderer('scoresnap:update-status', status);
  } catch (err) {
    log.warn('updater: failed to send status', err);
  }
}

function notesToText(releaseNotes) {
  if (!releaseNotes) return '';
  let text = '';
  if (typeof releaseNotes === 'string') text = releaseNotes;
  else if (Array.isArray(releaseNotes)) {
    text = releaseNotes
      .map((n) => (n && typeof n === 'object' ? `${n.version ? n.version + '\n' : ''}${n.note || ''}` : String(n)))
      .join('\n\n');
  }
  // GitHub provider delivers HTML; keep it readable as plain text.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
}

function friendlyError(err) {
  const raw = String((err && (err.message || err.code)) || err || '');
  const lower = raw.toLowerCase();
  if (/err_internet_disconnected|enotfound|econnrefused|etimedout|err_connection|err_name_not_resolved|network/.test(lower)) {
    return { kind: 'offline', message: '인터넷에 연결되어 있지 않아 업데이트를 확인하지 못했습니다. 연결되면 자동으로 다시 시도합니다.' };
  }
  if (/404|cannot find latest\.yml|no published versions|not found/.test(lower)) {
    return { kind: 'nofeed', message: '아직 배포된 업데이트가 없습니다.' };
  }
  if (/sha512|checksum|integrity/.test(lower)) {
    return { kind: 'corrupt', message: '다운로드한 업데이트 파일이 손상되었습니다. 나중에 다시 시도합니다.' };
  }
  const short = raw.split('\n')[0].slice(0, 160);
  return { kind: 'other', message: `업데이트 확인 중 오류가 발생했습니다.${short ? ' (' + short + ')' : ''}` };
}

/* ------------------------------------------------------------------ wiring */

function wire(updater) {
  updater.on('checking-for-update', () => {
    errorReported = false;
    emit({ state: 'checking' });
  });

  updater.on('update-available', (info) => {
    availableVersion = info && info.version ? String(info.version) : null;
    emit({
      state: 'available',
      version: availableVersion || '',
      notes: notesToText(info && info.releaseNotes),
    });
    if (!updater.autoDownload) return; // auto=false → wait for installUpdate()
    // autoDownload=true: electron-updater starts the download by itself.
  });

  updater.on('update-not-available', (info) => {
    emit({ state: 'up-to-date', version: (info && info.version) || app.getVersion() });
  });

  updater.on('download-progress', (p) => {
    const percent = p && Number.isFinite(p.percent) ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0;
    emit({ state: 'downloading', version: availableVersion || '', percent });
  });

  updater.on('update-downloaded', (info) => {
    downloadedVersion = (info && info.version) || availableVersion || '';
    // Remember what was downloaded; on next launch, if app.getVersion() matches, show "done".
    settings.setIn('update', 'pendingVersion', downloadedVersion);
    emit({ state: 'ready', version: downloadedVersion });
    if (installWhenDownloaded) {
      installWhenDownloaded = false;
      setTimeout(() => quitAndInstall(), 300);
    }
  });

  updater.on('error', (err) => {
    const f = friendlyError(err);
    log.warn('updater: error event', err && (err.stack || err.message || err));
    errorReported = true;
    if (f.kind === 'nofeed') {
      // A missing latest.yml simply means nothing has been published yet.
      emit({ state: 'up-to-date', version: app.getVersion() });
      return;
    }
    emit({ state: 'error', message: f.message });
  });
}

function getUpdater() {
  if (autoUpdater) return autoUpdater;
  // eslint-disable-next-line global-require
  const eu = require('electron-updater');
  autoUpdater = eu.autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = autoEnabled();
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  wire(autoUpdater);
  return autoUpdater;
}

function schedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!autoEnabled() || !isConfigured() || !app.isPackaged) return;
  timer = setInterval(() => {
    if (isOnline()) check(false);
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/* ------------------------------------------------------------------ API */

/**
 * @param {{ send: (channel: string, payload: any) => void }} opts
 */
function init(opts) {
  if (initialized) return;
  initialized = true;
  sendToRenderer = opts.send;

  // First launch after an update? (pendingVersion was written at 'update-downloaded')
  const pending = settings.getIn('update', 'pendingVersion', null);
  if (pending) {
    if (pending === app.getVersion()) {
      doneStatus = { state: 'done', version: pending };
      settings.setIn('update', 'pendingVersion', undefined);
      log.info(`updater: update to ${pending} applied`);
    } else if (compareVersions(app.getVersion(), pending) > 0) {
      settings.setIn('update', 'pendingVersion', undefined);
    }
  }

  if (!isConfigured()) {
    log.info('updater: build.publish owner is still REPLACE_GITHUB_OWNER — update checks are disabled');
    return;
  }
  if (!app.isPackaged) {
    log.info('updater: not packaged — update checks are disabled');
    return;
  }
  try {
    getUpdater();
  } catch (err) {
    log.error('updater: electron-updater could not be loaded', err);
    return;
  }
  schedule();
  if (autoEnabled()) {
    const t = setTimeout(() => {
      if (isOnline()) check(false);
    }, FIRST_CHECK_DELAY_MS);
    if (typeof t.unref === 'function') t.unref();
  }
}

/** Called when the renderer reports ready (also after reloads). */
function onRendererReady() {
  if (doneStatus) {
    const s = doneStatus;
    doneStatus = null;
    emit(s);
    return;
  }
  if (lastStatus && lastStatus.state !== 'idle') emit(lastStatus);
}

/**
 * Check for updates. Never rejects.
 * @param {boolean} manual true when triggered by the user (menu / button)
 */
async function check(manual) {
  if (!isConfigured()) {
    log.info('updater: skipped (publish owner not configured)');
    emit({ state: 'idle' });
    return;
  }
  if (!app.isPackaged) {
    log.info('updater: skipped (not packaged)');
    emit({ state: 'idle' });
    return;
  }
  if (checking) return;
  if (!manual && !isOnline()) return;
  if (manual && !isOnline()) {
    emit({ state: 'error', message: '인터넷에 연결되어 있지 않습니다.' });
    return;
  }
  checking = true;
  try {
    const u = getUpdater();
    u.autoDownload = autoEnabled();
    await u.checkForUpdates();
  } catch (err) {
    if (!errorReported) {
      const f = friendlyError(err);
      log.warn('updater: check failed', err && (err.stack || err.message || err));
      if (f.kind === 'nofeed') emit({ state: 'up-to-date', version: app.getVersion() });
      else emit({ state: 'error', message: f.message });
    }
  } finally {
    checking = false;
  }
}

function quitAndInstall() {
  try {
    // isSilent=true, isForceRunAfter=true: install silently and relaunch.
    // (The assisted NSIS installer supports /S; a visible wizard would be surprising
    //  after an in-app "restart now" click.)
    getUpdater().quitAndInstall(true, true);
  } catch (err) {
    log.error('updater: quitAndInstall failed', err);
    emit({ state: 'error', message: '업데이트를 설치하지 못했습니다. 프로그램을 다시 시작해 주세요.' });
  }
}

/** Apply: restart into the downloaded update (or download first when auto=false). */
async function installUpdate() {
  if (downloadedVersion) {
    quitAndInstall();
    return;
  }
  if (availableVersion) {
    installWhenDownloaded = true;
    try {
      await getUpdater().downloadUpdate();
    } catch (err) {
      installWhenDownloaded = false;
      if (!errorReported) emit({ state: 'error', message: friendlyError(err).message });
    }
    return;
  }
  await check(true);
}

async function getSettings() {
  return {
    auto: autoEnabled(),
    channel: 'latest',
    url: feedUrl(),
  };
}

async function setSettings(partial) {
  if (partial && typeof partial.auto === 'boolean') {
    settings.setIn('update', 'auto', partial.auto);
    if (autoUpdater) autoUpdater.autoDownload = partial.auto;
    schedule();
    if (partial.auto && isConfigured() && app.isPackaged && isOnline()) check(false);
  }
}

function getLastStatus() {
  return lastStatus;
}

/** Numeric semver compare (1.2.3 vs 1.10.0); pre-release < release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '');
    const [core, pre] = s.split('-', 2);
    const nums = core.split('.').map((x) => parseInt(x, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || '' };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

module.exports = {
  init,
  check,
  installUpdate,
  getSettings,
  setSettings,
  onRendererReady,
  getLastStatus,
  isConfigured,
  compareVersions,
  friendlyError,
  notesToText,
};
