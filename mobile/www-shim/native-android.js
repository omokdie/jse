/* JSE — Android native shim (window.ScoreSnapNative, SPEC §6)
 *
 * Loaded as a classic <script> before app/js/main.js (module) by mobile/scripts/sync-www.mjs.
 * Talks to the Capacitor plugin "ScoreSnapNative" (mobile/android/.../ScoreSnapNativePlugin.java)
 * through the runtime Capacitor injects into the WebView (window.Capacitor) — no bundler needed.
 *
 * Outside the Android app (plain browser / PWA / Electron) this file does nothing.
 */
(function () {
  'use strict';

  var cap = window.Capacitor;
  var isNative = !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  var platform = isNative && typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'web';
  if (!isNative || platform !== 'android') return;
  if (window.ScoreSnapNative && window.ScoreSnapNative.platform === 'android') return;

  var PLUGIN = 'ScoreSnapNative';
  var plugin = typeof cap.registerPlugin === 'function' ? cap.registerPlugin(PLUGIN) : null;

  /* ---------------------------------------------------------------- transport */

  // Prefer the low-level bridge primitives (always present in the injected runtime);
  // fall back to the registerPlugin() proxy.
  function call(method, options) {
    var opts = options && typeof options === 'object' ? options : {};
    try {
      if (typeof cap.nativePromise === 'function') return cap.nativePromise(PLUGIN, method, opts);
      if (plugin && typeof plugin[method] === 'function') return plugin[method](opts);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.reject(new Error('ScoreSnapNative.' + method + ' unavailable'));
  }

  function listen(eventName, handler) {
    var cb = function (data, err) {
      if (err) return;
      try {
        handler(data);
      } catch (e) {
        console.error('[ScoreSnapNative] listener error', e);
      }
    };
    try {
      if (typeof cap.nativeCallback === 'function') {
        cap.nativeCallback(PLUGIN, 'addListener', { eventName: eventName }, cb);
        return;
      }
      if (plugin && typeof plugin.addListener === 'function') plugin.addListener(eventName, cb);
    } catch (e) {
      console.error('[ScoreSnapNative] addListener failed', e);
    }
  }

  /* ---------------------------------------------------------------- sync info */

  // MainActivity/plugin adds a JavascriptInterface so version info is available synchronously.
  var info = { appVersion: '0.0.0', nativeVersion: '0.0.0', versionCode: 0, webVersion: '', packagedWebVersion: '' };
  try {
    var sync = window.ScoreSnapNativeSync;
    if (sync && typeof sync.getInfoJson === 'function') {
      var parsed = JSON.parse(sync.getInfoJson());
      if (parsed && typeof parsed === 'object') info = Object.assign(info, parsed);
    }
  } catch (e) {
    /* fall back to async getInfo below */
  }
  call('getInfo').then(function (r) {
    if (r && typeof r === 'object') info = Object.assign(info, r);
  }).catch(function () {});

  /* ---------------------------------------------------------------- open-file */

  var fileListeners = [];
  var fileQueue = [];

  function emitFile(file) {
    if (!file || typeof file !== 'object' || typeof file.base64 !== 'string') return;
    var payload = { name: String(file.name || ''), mime: String(file.mime || 'application/octet-stream'), base64: file.base64 };
    if (fileListeners.length) {
      fileListeners.forEach(function (cb) {
        try { cb(payload); } catch (e) { console.error('[ScoreSnapNative] onOpenFile error', e); }
      });
    } else {
      fileQueue.push(payload);
    }
  }

  var fetchingPending = false;
  function fetchPendingFile() {
    if (fetchingPending) return;
    fetchingPending = true;
    call('readPendingFile').then(function (r) {
      fetchingPending = false;
      if (r && r.file) emitFile(r.file);
    }).catch(function (err) {
      fetchingPending = false;
      console.warn('[ScoreSnapNative] readPendingFile failed', err);
    });
  }

  // Native keeps the intent's file queued; the event only carries metadata.
  listen('openFile', function () { fetchPendingFile(); });
  // Cold start via file manager / share sheet: the intent arrived before any JS ran.
  fetchPendingFile();

  /* ---------------------------------------------------------------- update status */

  var statusListeners = [];
  var lastStatus = null;
  var pendingDone = null;

  function emitStatus(status) {
    if (!status || typeof status !== 'object' || !status.state) return;
    if (status.state === 'done' && !statusListeners.length) {
      pendingDone = status;
      return;
    }
    lastStatus = status;
    statusListeners.forEach(function (cb) {
      try { cb(status); } catch (e) { console.error('[ScoreSnapNative] onUpdateStatus error', e); }
    });
  }

  listen('updateStatus', emitStatus);

  function clearWebCaches() {
    var tasks = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        tasks.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }));
      }
    } catch (e) { /* ignore */ }
    try {
      if (window.caches && caches.keys) {
        tasks.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
    } catch (e) { /* ignore */ }
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    return Promise.race([Promise.all(tasks), timeout]).catch(function () {});
  }

  // First run after a bundle switch: native reports {state:'done'} exactly once.
  // If a service worker from the previous bundle still controls this page, drop it
  // and reload once so the new files are really the ones running.
  call('getUpdateStatus').then(function (s) {
    if (!s || !s.state || s.state === 'idle') return;
    if (s.state === 'done') {
      var key = 'ssnap.native.postUpdateReload';
      var controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      var already = false;
      try { already = sessionStorage.getItem(key) === s.version; } catch (e) { /* ignore */ }
      if (controlled && !already) {
        try {
          sessionStorage.setItem(key, s.version);
          sessionStorage.setItem('ssnap.native.pendingDone', JSON.stringify(s));
        } catch (e) { /* ignore */ }
        clearWebCaches().then(function () { location.reload(); });
        return;
      }
    }
    emitStatus(s);
  }).catch(function () {});
  try {
    var stored = sessionStorage.getItem('ssnap.native.pendingDone');
    if (stored) {
      sessionStorage.removeItem('ssnap.native.pendingDone');
      emitStatus(JSON.parse(stored));
    }
  } catch (e) { /* ignore */ }

  /* ---------------------------------------------------------------- file picker */

  function extFromAccept(accept) {
    return Array.isArray(accept) ? accept.map(String).join(',') : '';
  }

  function mimeFromName(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var map = {
      ssnap: 'application/x-scoresnap', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', musicxml: 'application/vnd.recordare.musicxml+xml',
      xml: 'application/vnd.recordare.musicxml+xml', mxl: 'application/vnd.recordare.musicxml', mid: 'audio/midi', midi: 'audio/midi'
    };
    return map[ext] || '';
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.onload = function () {
        var s = String(reader.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  // Uses the WebView's own chooser (Capacitor routes <input type=file> to the system picker / camera).
  function openFileDialog(opts) {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      var accept = extFromAccept(opts && opts.accept);
      if (accept) input.accept = accept;
      input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(v);
      }
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (!f) return finish(null);
        blobToBase64(f).then(function (b64) {
          finish({ name: f.name, mime: f.type || mimeFromName(f.name) || 'application/octet-stream', base64: b64, size: f.size });
        }).catch(function () { finish(null); });
      });
      input.addEventListener('cancel', function () { finish(null); });
      document.body.appendChild(input);
      input.click();
    });
  }

  /* ---------------------------------------------------------------- public API */

  function cleanSave(opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    return {
      name: typeof o.name === 'string' ? o.name : '',
      mime: typeof o.mime === 'string' ? o.mime : 'application/octet-stream',
      base64: typeof o.base64 === 'string' ? o.base64 : '',
      title: typeof o.title === 'string' ? o.title : '',
      share: !!o.share
    };
  }

  var api = {
    platform: 'android',
    get appVersion() { return String(info.appVersion || '0.0.0'); },
    get nativeVersion() { return String(info.nativeVersion || info.appVersion || '0.0.0'); },
    get webVersion() { return String(info.webVersion || ''); },

    onOpenFile: function (cb) {
      if (typeof cb !== 'function') return;
      fileListeners.push(cb);
      while (fileQueue.length) {
        var f = fileQueue.shift();
        try { cb(f); } catch (e) { console.error('[ScoreSnapNative] onOpenFile error', e); }
      }
    },
    saveFile: function (opts) {
      var o = cleanSave(opts);
      return call('saveFile', o).then(function (r) { return r && r.path ? r : null; });
    },
    openFileDialog: openFileDialog,
    shareFile: function (opts) {
      var o = cleanSave(opts);
      o.share = true;
      return call('shareFile', o).then(function () {});
    },

    checkForUpdates: function () {
      return call('checkForUpdates').then(function () {});
    },
    onUpdateStatus: function (cb) {
      if (typeof cb !== 'function') return;
      statusListeners.push(cb);
      if (pendingDone) {
        var d = pendingDone;
        pendingDone = null;
        try { cb(d); } catch (e) { /* ignore */ }
      }
      if (lastStatus) {
        try { cb(lastStatus); } catch (e) { /* ignore */ }
      }
    },
    installUpdate: function () {
      // Unregister old service workers / caches first so the new bundle is not shadowed.
      return clearWebCaches().then(function () { return call('installUpdate'); }).then(function () {});
    },
    getUpdateSettings: function () {
      return call('getUpdateSettings').then(function (r) {
        var s = r && typeof r === 'object' ? r : {};
        return { auto: s.auto !== false, channel: String(s.channel || 'stable'), url: String(s.url || '') };
      });
    },
    setUpdateSettings: function (s) {
      var partial = {};
      if (s && typeof s.auto === 'boolean') partial.auto = s.auto;
      if (s && typeof s.wifiOnly === 'boolean') partial.wifiOnly = s.wifiOnly;
      return call('setUpdateSettings', partial).then(function () {});
    },

    // extras
    openExternal: function (url) {
      return call('openUrl', { url: String(url || '') }).then(function () { return true; });
    },
    getInfo: function () {
      return call('getInfo');
    }
  };

  window.ScoreSnapNative = api;
})();
