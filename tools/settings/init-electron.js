// Pretend to be the Windows app shell (what electron/preload.js exposes), recording every native call.
try { localStorage.setItem('ssnap.welcomed', '1'); } catch (e) {}
(function () {
  var calls = []; var N = window.__native = { calls: calls, closeReq: null, closed: 0, folder: 'C:\\Users\\me\\Music\\Scores', openFile: null };
  var rec = function (name, result) { return function (a) { calls.push([name, a]); return Promise.resolve(typeof result === 'function' ? result(a) : result); }; };
  var state = { maximized: false, fullscreen: false, focused: true };
  window.ScoreSnapNative = {
    platform: 'windows', appVersion: '1.0.9',
    onOpenFile: function () {}, onMenu: function () {},
    saveFile: rec('saveFile', function (o) { return { path: 'C:\\Users\\me\\Documents\\' + o.name }; }),
    openFileDialog: function (o) { calls.push(['openFileDialog', o]); return Promise.resolve(N.openFile); },
    checkForUpdates: rec('checkForUpdates'), onUpdateStatus: function () {}, installUpdate: rec('installUpdate'),
    getUpdateSettings: function () { return Promise.resolve({ auto: true, channel: 'latest', url: '' }); }, setUpdateSettings: rec('setUpdateSettings'),
    windowControls: { minimize: rec('minimize', state), toggleMaximize: rec('toggleMaximize', state), toggleFullScreen: rec('toggleFullScreen', state), close: function () { N.closed++; return Promise.resolve(); }, getState: function () { return Promise.resolve(state); }, onStateChange: function () {} },
    openExternal: rec('openExternal', true), showInFolder: rec('showInFolder'),
    getAppSettings: rec('getAppSettings', {}), setAppSettings: rec('setAppSettings', {}),
    chooseFolder: rec('chooseFolder', function () { return N.folder; }), openSystemSettings: rec('openSystemSettings', true), showSettingsFile: rec('showSettingsFile', true),
    relaunch: rec('relaunch', true), setZoomFactor: rec('setZoomFactor'), setKeepScreenOn: rec('setKeepScreenOn'),
    getAppInfo: rec('getAppInfo', { version: '1.0.9', electron: '33.2.0', chrome: '130.0.0.0', node: '20.18.0', os: 'Windows_NT 10.0.22631 (x64)', homepage: 'https://github.com/omokdie/jse', gpuDisabled: false }),
    onCloseRequest: function (cb) { N.closeReq = cb; },
  };
})();
