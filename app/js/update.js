// Update manager: service-worker based for the web/PWA, native status passthrough for Electron/Android.
// Emits 'status' events with SPEC §6 UpdateStatus objects and shows the "업데이트 완료" notice.
import { native } from './native.js';

export class Updater extends EventTarget {
  constructor(app, { version, onToast }) {
    super();
    this.app = app; this.version = version; this.toast = onToast;
    this.status = { state: 'idle' }; this.reg = null; this.auto = app.settings.autoUpdate !== false; this.pendingReload = false;
  }
  set(status) { this.status = status; this.dispatchEvent(new CustomEvent('status', { detail: status })); }
  async start() {
    const n = native();
    this.announceIfUpdated();
    if (n?.onUpdateStatus) {
      n.onUpdateStatus(s => { this.set(s); if (s.state === 'done') this.toast?.(`업데이트 완료 — v${s.version}`, 'ok'); if (s.state === 'ready') this.toast?.(`새 버전(v${s.version})을 받았습니다. 다시 시작하면 적용됩니다.`, 'ok', { action: { label: '지금 다시 시작', onClick: () => n.installUpdate?.() } }); });
      try { const st = await n.getUpdateSettings?.(); if (st) this.auto = st.auto !== false; } catch { /* ignore */ }
      if (this.auto && navigator.onLine) setTimeout(() => this.check(false), 4000);
      window.addEventListener('online', () => { if (this.auto) this.check(false); });
      return;
    }
    if (!('serviceWorker' in navigator) || globalThis.JSE_PREVIEW) { this.set({ state: 'idle' }); return; }
    try {
      this.reg = await navigator.serviceWorker.register('sw.js');
      this.reg.addEventListener('updatefound', () => {
        const nw = this.reg.installing; if (!nw) return;
        this.set({ state: 'downloading', version: '?', percent: 50 });
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            this.set({ state: 'ready', version: '?' });
            this.applyWhenSafe();
          } else if (nw.state === 'installed') this.set({ state: 'up-to-date', version: this.version });
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (this.pendingReload) { this.pendingReload = false; location.reload(); } });
      if (this.reg.waiting && navigator.serviceWorker.controller) { this.set({ state: 'ready' }); this.applyWhenSafe(); }
      else this.set({ state: 'up-to-date', version: this.version });
      if (this.auto) { setTimeout(() => this.check(false), 5000); setInterval(() => { if (navigator.onLine && this.auto) this.check(false); }, 60 * 60 * 1000); }
      window.addEventListener('online', () => { if (this.auto) this.check(false); });
    } catch (e) { console.warn('SW registration failed', e); this.set({ state: 'idle' }); }
  }
  announceIfUpdated() {
    try {
      const prev = localStorage.getItem('ssnap.installedVersion');
      if (prev && prev !== this.version) { setTimeout(() => this.toast?.(`업데이트 완료 — v${this.version}`, 'ok', { timeout: 6000 }), 1200); this.set({ state: 'done', version: this.version }); }
      localStorage.setItem('ssnap.installedVersion', this.version);
    } catch { /* ignore */ }
  }
  async check(manual = false) {
    const n = native();
    if (n?.checkForUpdates) { this.set({ state: 'checking' }); try { await n.checkForUpdates(); } catch (e) { this.set({ state: 'error', message: e.message }); } return; }
    if (!this.reg) { if (manual) this.toast?.('이 환경에서는 자동 업데이트를 사용할 수 없습니다 (서비스 워커 미지원)', 'warn'); return; }
    if (!navigator.onLine) { if (manual) this.toast?.('인터넷에 연결되어 있지 않습니다', 'warn'); return; }
    this.set({ state: 'checking' });
    try {
      await this.reg.update();
      // compare version.json from network
      const r = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' });
      const v = await r.json();
      if (v.version && v.version !== this.version) {
        this.set({ state: 'available', version: v.version });
        if (!this.reg.waiting && !this.reg.installing) { /* the SW will pick it up; fallback: reload after a short delay */ setTimeout(() => { if (this.status.state === 'available') this.applyWhenSafe(true); }, 8000); }
      } else { this.set({ state: 'up-to-date', version: this.version }); if (manual) this.toast?.('최신 버전입니다 (v' + this.version + ')', 'ok'); }
    } catch (e) { this.set({ state: 'error', message: e.message }); if (manual) this.toast?.('업데이트 확인 실패: ' + e.message, 'error'); }
  }
  /** Apply a waiting update when there are no unsaved edits (or after autosave). */
  applyWhenSafe(forceReload = false) {
    const go = () => {
      this.pendingReload = true;
      if (this.reg?.waiting) this.reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else if (forceReload) location.reload();
    };
    if (!this.app.dirty || this.app.settings.autosave) { setTimeout(go, 1500); }
    else this.toast?.('새 버전이 준비되었습니다. 저장 후 적용됩니다.', 'ok', { timeout: 8000, action: { label: '지금 적용', onClick: go } });
  }
  setAuto(v) { this.auto = v; native()?.setUpdateSettings?.({ auto: v }); }
  install() { const n = native(); if (n?.installUpdate) n.installUpdate(); else this.applyWhenSafe(true); }
}
