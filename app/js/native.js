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

// ---- "back one level" stack: full-screen pages (settings) register a handler; the browser Back button,
//      the Android back gesture and the Android app's back key all pop the top one.
const backStack = [];
let backSilent = 0, backBound = false;
// The desktop shell has no back button, and its main process watches page loads — keep its history untouched.
function backUsesHistory() { return typeof history !== 'undefined' && typeof window !== 'undefined' && !globalThis.JSE_PREVIEW && !native()?.windowControls; }
function bindBackStack() {
  if (backBound) return; backBound = true;
  window.addEventListener('popstate', () => {
    if (backSilent > 0) { backSilent--; return; }      // our own history.go() after a level was closed from the UI
    const top = backStack.pop();
    if (top) { top.hist = false; try { top.onBack(); } catch (e) { console.error(e); } }
  });
}
/** Register `onBack` as the newest level. Returns { release() } — call it when the level is closed from the UI. */
export function pushBack(onBack) {
  const entry = { onBack, hist: false };
  backStack.push(entry);
  if (backUsesHistory()) { try { history.pushState({ jseBack: backStack.length }, ''); entry.hist = true; bindBackStack(); } catch { /* sandboxed page */ } }
  return {
    release() {
      const i = backStack.indexOf(entry); if (i < 0) return;
      const n = backStack.splice(i).filter(e => e.hist).length;   // this level and everything opened above it
      if (n) { backSilent++; try { history.go(-n); } catch { backSilent--; } }
    },
  };
}
/** Go back one level (Android back key). False when nothing is registered. */
export function goBack() {
  const top = backStack[backStack.length - 1]; if (!top) return false;
  if (top.hist) { try { history.back(); return true; } catch { /* fall through */ } }
  backStack.pop(); try { top.onBack(); } catch (e) { console.error(e); }
  return true;
}
export function backDepth() { return backStack.length; }

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
/** What a file picker may be asked to filter by. Android pickers filter by MIME type only: an extension Android has no
 *  MIME type for (.ssnap, .mscz, .nwc, .musx …) is dropped from the filter and such files can then not be chosen at all.
 *  So on Android a list holding any such extension asks for every file — a file is recognised by its content anyway. */
const ANDROID_KNOWN_ACCEPT = /^(?:(?:image|audio|video)\/[\w.+*-]+|application\/(?:pdf|json)|\.(?:pdf|json|png|jpe?g|webp|gif|bmp|mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4|aif|aiff))$/i;
export function pickerAccept(accept, android = /Android/i.test(globalThis.navigator?.userAgent || '')) {
  const list = String(accept || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!android) return list.join(',');
  return list.every(a => ANDROID_KNOWN_ACCEPT.test(a)) ? list.join(',') : '';
}
/** Pick files: returns [{name, blob, handle?}]. */
export async function pickFiles({ accept = '.ssnap,.musx,.ftmx,.musicxml,.xml,.mxl,image/*', multiple = false, capture = null } = {}) {
  const n = native();
  const filter = pickerAccept(accept);
  if (n?.openFileDialog && !capture && !accept.includes('image')) {
    const r = await n.openFileDialog({ accept: filter ? filter.split(',') : [] });
    if (!r) return [];
    return [{ name: r.name, blob: new Blob([base64ToBytes(r.base64)], { type: r.mime || 'application/octet-stream' }) }];
  }
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; if (filter) input.accept = filter; input.multiple = multiple;
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
