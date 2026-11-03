// Bridge to the native shell (Electron / Android) when present; pure-web fallbacks otherwise.
export function native() { return globalThis.ScoreSnapNative || null; }
export function platform() { const n = native(); if (n?.platform) return n.platform; if (/Android/i.test(navigator.userAgent)) return 'android-web'; if (/iPhone|iPad/i.test(navigator.userAgent)) return 'ios-web'; return 'web'; }
/** phone | tablet | desktop — sets <html class="phone|tablet|desktop">. Tablets (touch, both sides ≥ 600 px)
 *  get the full desktop tool layout with touch-sized controls; phones get the compact mobile layout. */
export function classifyLayout() {
  const root = document.documentElement;
  const w = window.innerWidth, h = window.innerHeight;
  const coarse = window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 1 && !window.matchMedia('(pointer: fine)').matches);
  const tablet = coarse && Math.min(w, h) >= 600 && Math.max(w, h) >= 900;
  const phone = !tablet && w <= 860;
  const kind = phone ? 'phone' : tablet ? 'tablet' : 'desktop';
  const prev = root.dataset.layout;
  root.classList.toggle('phone', phone); root.classList.toggle('tablet', tablet); root.classList.toggle('desktop', kind === 'desktop');
  root.classList.toggle('portrait', h > w); root.classList.toggle('touch', coarse);
  root.dataset.layout = kind;
  if (prev && prev !== kind) window.dispatchEvent(new CustomEvent('jse-layout', { detail: { kind, prev } }));
  return kind;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  classifyLayout();
  let t = null;
  const re = () => { clearTimeout(t); t = setTimeout(classifyLayout, 60); };
  window.addEventListener('resize', re); window.addEventListener('orientationchange', re);
}
export function isMobileLayout() { return document.documentElement.classList.contains('phone'); }
export function isTabletLayout() { return document.documentElement.classList.contains('tablet'); }
export function isTouch() { return window.matchMedia('(pointer: coarse)').matches; }

export async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer(); const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

/** Save a blob: native shim → File System Access (desktop browsers) → download. Returns {path|handle|download}. */
export async function saveBlob(blob, name, { mime = blob.type, suggestDialog = true, handle = null, types = null } = {}) {
  const n = native();
  if (n?.saveFile) {
    const base64 = await blobToBase64(blob);
    const r = await n.saveFile({ name, mime, base64, suggestDialog });
    return r ? { path: r.path } : null;
  }
  if ('showSaveFilePicker' in window && (suggestDialog || handle) && !globalThis.JSE_PREVIEW) {
    try {
      let h = handle;
      if (!h || suggestDialog) h = await window.showSaveFilePicker({ suggestedName: name, types: types || [{ description: name.split('.').pop().toUpperCase(), accept: { [mime || 'application/octet-stream']: ['.' + name.split('.').pop()] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return { handle: h, name: h.name };
    } catch (e) { if (e?.name === 'AbortError') return null; console.warn('FS access failed, falling back to download', e); }
  }
  if (globalThis.JSE_PREVIEW) {
    // sandboxed preview pages refuse downloads: say so instead of failing silently
    globalThis.JSE?.ui?.toast('미리보기 화면에서는 파일 저장이 막혀 있어요. 설치판(Windows·Android)이나 웹앱 주소에서 저장할 수 있습니다.', 'warn', { timeout: 6000 });
    return null;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return { download: true };
}
/** Pick files: returns [{name, blob, handle?}]. */
export async function pickFiles({ accept = '.ssnap,.musx,.ftmx,.musicxml,.xml,.mxl,image/*', multiple = false, capture = null } = {}) {
  const n = native();
  if (n?.openFileDialog && !capture && !accept.includes('image')) {
    const r = await n.openFileDialog({ accept: accept.split(',') });
    if (!r) return [];
    return [{ name: r.name, blob: new Blob([base64ToBytes(r.base64)], { type: r.mime || 'application/octet-stream' }) }];
  }
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.multiple = multiple;
    if (capture) input.capture = capture;
    input.style.position = 'fixed'; input.style.left = '-9999px'; document.body.appendChild(input);
    let done = false;
    const finish = files => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...input.files].map(f => ({ name: f.name, blob: f }))));
    window.addEventListener('focus', () => setTimeout(() => { if (!done && !input.files.length) finish([]); }, 800), { once: true });
    input.click();
  });
}
export function onNativeOpenFile(cb) { const n = native(); if (n?.onOpenFile) n.onOpenFile(f => cb({ name: f.name, blob: new Blob([base64ToBytes(f.base64)], { type: f.mime || 'application/octet-stream' }) })); }
export async function shareBlob(blob, name, title) {
  const n = native();
  if (n?.shareFile) { await n.shareFile({ name, mime: blob.type, base64: await blobToBase64(blob), title }); return true; }
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] })) { await navigator.share({ files: [new File([blob], name, { type: blob.type })], title }); return true; }
  return false;
}
