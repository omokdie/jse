// Pretend to be the Android app shell (what mobile/www-shim/native-android.js exposes), recording every native call.
try { localStorage.setItem('ssnap.welcomed', '1'); } catch (e) {}
(function () {
  var calls = []; window.__native = { calls: calls, back: null, min: 0, exit: 0 };
  var rec = function (name) { return function (a) { calls.push([name, a]); return Promise.resolve(a); }; };
  window.ScoreSnapNative = {
    platform: 'android', appVersion: '1.0.9', nativeVersion: '1.0.9', webVersion: '1.0.9',
    onOpenFile: function () {}, checkForUpdates: function () { return Promise.resolve(); }, onUpdateStatus: function () {}, installUpdate: function () { return Promise.resolve(); },
    getUpdateSettings: function () { return Promise.resolve({ auto: true, channel: 'stable', url: '' }); }, setUpdateSettings: rec('setUpdateSettings'),
    setKeepScreenOn: rec('setKeepScreenOn'), setImmersive: rec('setImmersive'), setOrientation: rec('setOrientation'), vibrate: rec('vibrate'),
    onBackButton: function (cb) { window.__native.back = cb; },
    minimizeApp: function () { window.__native.min++; return Promise.resolve(); }, exitApp: function () { window.__native.exit++; return Promise.resolve(); },
  };
})();
