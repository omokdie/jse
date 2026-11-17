// Font catalogue for score texts + on-demand web fonts ("JSE 글꼴").
//
//   기본            the built-in stack (engrave/text.js TEXT_FONT) — family ''
//   이 기기의 글꼴   fonts installed on this device: queryLocalFonts() where the browser has it (desktop
//                   Chromium, Electron), otherwise a curated candidate list filtered by a measuring test
//   JSE 글꼴        free (SIL OFL) fonts that work on every device. They are NOT bundled with the app:
//                   the files live in app/fonts/web/ (served by the web site only), are downloaded the first
//                   time a font is used, kept in IndexedDB and registered with the FontFace API.
//
// Importable in Node (catalogue + URL logic are pure); everything that touches the DOM checks for it.
import { PAGES_BASE_URL } from './config.js';
import { sanitizeFontFamily, fontNeeds } from './model/textstyles.js';

/** Folder of the downloadable fonts, relative to the web root. */
export const WEB_FONTS_DIR = 'fonts/web/';

/**
 * JSE 글꼴 — the same data as app/fonts/web/manifest.json (written by tools/fonts/build-webfonts.py;
 * tools/tests/textstyles.test.js fails when the two differ). `family` is the CSS family the font is
 * registered with (its published name), `files` maps a weight to a file below WEB_FONTS_DIR.
 */
export const JSE_FONTS = Object.freeze([
  { family: 'Nanum Myeongjo', ko: '나눔명조', category: 'serif-ko', license: 'OFL-1.1', files: { 400: { file: 'nanummyeongjo/NanumMyeongjo-Regular.woff', bytes: 1034448 }, 700: { file: 'nanummyeongjo/NanumMyeongjo-Bold.woff', bytes: 1111460 } } },
  { family: 'Gowun Batang', ko: '고운바탕', category: 'serif-ko', license: 'OFL-1.1', files: { 400: { file: 'gowunbatang/GowunBatang-Regular.woff', bytes: 1805512 }, 700: { file: 'gowunbatang/GowunBatang-Bold.woff', bytes: 1593260 } } },
  { family: 'Nanum Gothic', ko: '나눔고딕', category: 'sans-ko', license: 'OFL-1.1', files: { 400: { file: 'nanumgothic/NanumGothic-Regular.woff', bytes: 685348 }, 700: { file: 'nanumgothic/NanumGothic-Bold.woff', bytes: 780372 } } },
  { family: 'Gowun Dodum', ko: '고운돋움', category: 'sans-ko', license: 'OFL-1.1', files: { 400: { file: 'gowundodum/GowunDodum-Regular.woff', bytes: 1429264 } } },
  { family: 'Nanum Pen Script', ko: '나눔손글씨 펜', category: 'hand-ko', license: 'OFL-1.1', files: { 400: { file: 'nanumpenscript/NanumPenScript-Regular.woff', bytes: 1288496 } } },
  { family: 'Old Standard TT', ko: '올드 스탠더드', category: 'serif-latin', license: 'OFL-1.1', files: { 400: { file: 'oldstandardtt/OldStandard-Regular.woff', bytes: 95456 }, 700: { file: 'oldstandardtt/OldStandard-Bold.woff', bytes: 97232 } } },
  { family: 'Libertinus Serif', ko: '리베르티누스 세리프', category: 'serif-latin', license: 'OFL-1.1', files: { 400: { file: 'libertinusserif/LibertinusSerif-Regular.woff', bytes: 295688 }, 700: { file: 'libertinusserif/LibertinusSerif-Bold.woff', bytes: 251628 } } },
]);
export const FONT_CATEGORY_LABELS = Object.freeze({ 'serif-ko': '명조', 'sans-ko': '고딕', 'hand-ko': '손글씨', 'serif-latin': '영문 세리프' });

const JSE_BY_FAMILY = new Map(JSE_FONTS.map(f => [f.family.toLowerCase(), f]));
/** Catalogue entry of a JSE font (case-insensitive family), or null. */
export function jseFont(family) { return JSE_BY_FAMILY.get(String(family || '').trim().toLowerCase()) || null; }
/** The file that serves `weight` (400 | 700): the bold file when there is one, else the regular one (the browser emboldens it). */
export function jseFontFile(font, weight) {
  const w = +weight >= 600 && font.files[700] ? 700 : 400;
  return { weight: w, ...font.files[w] };
}
/** Bytes still to download for `family` in the given weights (0 when nothing is missing). */
export function jseDownloadSize(family, weights = [400]) {
  const font = jseFont(family); if (!font) return 0;
  const files = new Map();
  for (const w of weights) { const f = jseFontFile(font, w); if (!MEM.has(f.file) && !CACHED.has(f.file)) files.set(f.file, f.bytes); }
  return [...files.values()].reduce((a, b) => a + b, 0);
}

/** Fonts that may be installed on the device, tried when the browser cannot list them (Android, Safari, Firefox …). */
export const DEVICE_FONT_CANDIDATES = Object.freeze([
  // Korean — Windows
  { family: 'Malgun Gothic', ko: '맑은 고딕', alt: ['맑은 고딕'] },
  { family: 'Batang', ko: '바탕', alt: ['바탕'] },
  { family: 'Gulim', ko: '굴림', alt: ['굴림'] },
  { family: 'Dotum', ko: '돋움', alt: ['돋움'] },
  { family: 'Gungsuh', ko: '궁서', alt: ['궁서'] },
  // Korean — Nanum / Noto / Hancom (often installed by hand or with an office suite)
  { family: 'NanumGothic', ko: '나눔고딕', alt: ['나눔고딕'] },
  { family: 'NanumMyeongjo', ko: '나눔명조', alt: ['나눔명조'] },
  { family: 'NanumBarunGothic', ko: '나눔바른고딕', alt: ['나눔바른고딕'] },
  { family: 'NanumSquare', ko: '나눔스퀘어', alt: ['나눔스퀘어'] },
  { family: 'NanumSquareRound', ko: '나눔스퀘어라운드', alt: ['나눔스퀘어라운드'] },
  { family: 'Nanum Brush Script', ko: '나눔손글씨 붓', alt: ['나눔손글씨 붓'] },
  { family: 'Noto Sans KR', ko: '본고딕 (Noto Sans KR)' },
  { family: 'Noto Serif KR', ko: '본명조 (Noto Serif KR)' },
  { family: 'Noto Sans CJK KR' },
  { family: 'Noto Serif CJK KR' },
  { family: 'HCR Batang', ko: '함초롬바탕', alt: ['함초롬바탕'] },
  { family: 'HCR Dotum', ko: '함초롬돋움', alt: ['함초롬돋움'] },
  { family: 'Pretendard', ko: '프리텐다드' },
  // Korean — Apple
  { family: 'Apple SD Gothic Neo', ko: '애플 SD 산돌고딕 Neo' },
  { family: 'AppleMyungjo', ko: '애플명조' },
  { family: 'AppleGothic', ko: '애플고딕' },
  // Latin
  { family: 'Roboto' }, { family: 'Noto Sans' }, { family: 'Noto Serif' }, { family: 'Arial' }, { family: 'Helvetica Neue' }, { family: 'Helvetica' },
  { family: 'Times New Roman' }, { family: 'Georgia' }, { family: 'Palatino Linotype', alt: ['Palatino'] }, { family: 'Garamond' }, { family: 'Cambria' },
  { family: 'Century Schoolbook' }, { family: 'Book Antiqua' }, { family: 'Segoe UI' }, { family: 'Calibri' }, { family: 'Verdana' }, { family: 'Tahoma' },
  { family: 'Trebuchet MS' }, { family: 'Courier New' }, { family: 'Consolas' }, { family: 'Comic Sans MS' },
  { family: 'DejaVu Sans' }, { family: 'DejaVu Serif' }, { family: 'Liberation Sans' }, { family: 'Liberation Serif' }, { family: 'Ubuntu' },
]);
const KO_NAMES = new Map(DEVICE_FONT_CANDIDATES.filter(c => c.ko).flatMap(c => [c.family, ...(c.alt || [])].map(n => [n.toLowerCase(), c.ko])));
/** Korean display name of a font family where one is known (catalogue or candidate list), else the name itself. */
export function fontDisplayName(family) {
  if (!family) return '기본';
  const j = jseFont(family); if (j) return j.ko;
  return KO_NAMES.get(String(family).toLowerCase()) || family;
}

// ---------------------------------------------------------------------------------------------
// where a font file is fetched from
/**
 * Candidate URLs for a file of app/fonts/web/, in the order to try:
 *   1. the app's own origin — only when it is a web page served over http(s) (web / PWA: the file is there).
 *      The Windows and Android packages leave the fonts out, so inside a native shell this step is skipped
 *      (Android serves the app from https://localhost, where the request could only fail);
 *   2. the project's web site (GitHub Pages).
 * Pure: pass `href` / `native` / `pagesBase` to test it.
 */
export function fontSourceUrls(file, { href = typeof location !== 'undefined' ? location.href : '', pagesBase = PAGES_BASE_URL, native = !!globalThis.ScoreSnapNative } = {}) {
  const rel = WEB_FONTS_DIR + String(file).replace(/^\/+/, '');
  const urls = [];
  try { const u = new URL(href); if (!native && (u.protocol === 'http:' || u.protocol === 'https:')) urls.push(new URL(rel, u).href); } catch { /* no usable location (Node, about:blank) */ }
  try { const remote = new URL(rel, pagesBase).href; if (!urls.includes(remote)) urls.push(remote); } catch { /* bad base */ }
  return urls;
}

// ---------------------------------------------------------------------------------------------
// state
const MEM = new Map();        // file → ArrayBuffer (also the source of the data: URLs written into exported SVG)
const B64 = new Map();        // file → base64 string (made on first export)
const CACHED = new Set();     // files known to be in IndexedDB
const FACES = new Map();      // `${family}|${weight}` → FontFace
const PENDING = new Map();    // file → Promise<ArrayBuffer>
const FAILED = new Map();     // file → time of the last failed download
const RETRY_MS = 60000;
/** 'progress' { family, file, loaded, total } · 'loaded' { family, weight } · 'error' { family, file, error } */
export const fontEvents = new EventTarget();
const emit = (type, detail) => { try { fontEvents.dispatchEvent(Object.assign(new Event(type), { detail })); } catch { /* listeners must not break loading */ } };
const hasDom = () => typeof document !== 'undefined' && typeof FontFace !== 'undefined' && !!document.fonts;

// ---------------------------------------------------------------------------------------------
// IndexedDB cache (own database: nothing else has to migrate)
const DB_NAME = 'jse-fonts', STORE = 'files';
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'file' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB'));
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}
function idb(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode); const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('indexedDB'));
  }));
}
const cacheGet = file => idb('readonly', s => s.get(file)).then(r => (r && r.data instanceof ArrayBuffer ? r.data : null)).catch(() => null);
const cachePut = (file, data) => idb('readwrite', s => s.put({ file, data, size: data.byteLength, savedAt: Date.now() })).then(() => { CACHED.add(file); return true; }).catch(() => false);
let indexPromise = null;
/** Reads which files are already stored on this device (so the picker can show "받음"). Safe to call often. */
export function refreshFontCacheIndex() {
  if (!indexPromise) indexPromise = idb('readonly', s => s.getAllKeys()).then(keys => { for (const k of keys || []) CACHED.add(k); }).catch(() => {}).finally(() => { setTimeout(() => { indexPromise = null; }, 2000); });
  return indexPromise;
}
/** Removes the downloaded fonts from this device (they are fetched again when needed). */
export async function clearFontCache() {
  try { await idb('readwrite', s => s.clear()); } catch { /* nothing stored */ }
  CACHED.clear();
}
/** { files, bytes } stored on this device. */
export async function fontCacheUsage() {
  try { const all = await idb('readonly', s => s.getAll()); return { files: all.length, bytes: all.reduce((a, r) => a + (r.size || r.data?.byteLength || 0), 0) }; } catch { return { files: 0, bytes: 0 }; }
}

// ---------------------------------------------------------------------------------------------
// download
function looksLikeFont(buf) {
  if (!buf || buf.byteLength < 1024) return false;
  const b = new Uint8Array(buf, 0, 4), sig = String.fromCharCode(b[0], b[1], b[2], b[3]);
  return sig === 'wOFF' || sig === 'wOF2' || sig === 'OTTO' || sig === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0);
}
async function download(file, family, expected) {
  let lastError = new Error('offline');
  for (const url of fontSourceUrls(file)) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const total = +res.headers.get('content-length') || expected || 0;
      let buf;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader(); const chunks = []; let loaded = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); loaded += value.byteLength; emit('progress', { family, file, loaded, total }); }
        const out = new Uint8Array(loaded); let at = 0; for (const c of chunks) { out.set(c, at); at += c.byteLength; }
        buf = out.buffer;
      } else buf = await res.arrayBuffer();
      if (!looksLikeFont(buf)) { lastError = new Error('not a font file'); continue; }   // e.g. an app shell answering 200 for a missing path
      return buf;
    } catch (e) { lastError = e; }
  }
  throw lastError;
}
/** Bytes of one font file: memory → IndexedDB → network (then stored). */
function fileBytes(file, family, expected, { force = false } = {}) {
  if (MEM.has(file)) return Promise.resolve(MEM.get(file));
  if (PENDING.has(file)) return PENDING.get(file);
  const p = (async () => {
    let buf = await cacheGet(file);
    if (buf && looksLikeFont(buf)) CACHED.add(file);
    else {
      const failedAt = FAILED.get(file);
      if (!force && failedAt && Date.now() - failedAt < RETRY_MS) throw new Error('offline');
      try { buf = await download(file, family, expected); } catch (e) { FAILED.set(file, Date.now()); throw e; }
      FAILED.delete(file);
      await cachePut(file, buf);
    }
    MEM.set(file, buf);
    return buf;
  })();
  PENDING.set(file, p);
  p.catch(() => {}).finally(() => PENDING.delete(file));
  return p;
}

/** Is `family` (in that weight) registered and ready to draw / measure? Non-JSE families always are (device fonts). */
export function isFontReady(family, weight = 400) {
  const font = jseFont(family); if (!font) return true;
  return FACES.has(`${font.family}|${jseFontFile(font, weight).weight}`);
}
/** 'ready' | 'loading' | 'cached' (on this device, not registered yet) | 'remote' (needs a download) — for a JSE font; 'device' otherwise. */
export function fontState(family, weights = [400]) {
  const font = jseFont(family); if (!font) return 'device';
  const files = weights.map(w => jseFontFile(font, w));
  if (files.every(f => FACES.has(`${font.family}|${f.weight}`))) return 'ready';
  if (files.some(f => PENDING.has(f.file))) return 'loading';
  if (files.every(f => MEM.has(f.file) || CACHED.has(f.file) || FACES.has(`${font.family}|${f.weight}`))) return 'cached';
  return 'remote';
}

/** Did the last download of this JSE font fail (offline, site unreachable)? */
export function fontFailed(family) {
  const font = jseFont(family); if (!font) return false;
  return Object.values(font.files).some(f => FAILED.has(f.file));
}

/**
 * Make a JSE font usable: fetch (or read from this device) the files for `weights` and register them.
 * Resolves { ok, family, loaded: [weights newly registered], error? } — never rejects.
 * Other families resolve { ok: true } at once: fonts installed on the device need no loading.
 */
export async function loadFont(family, weights = [400], { force = false } = {}) {
  const font = jseFont(family);
  if (!font) return { ok: true, family, loaded: [] };
  if (!hasDom()) return { ok: false, family: font.family, loaded: [], error: new Error('no document') };
  const loaded = []; let error = null;
  const wanted = new Map(); for (const w of weights) { const f = jseFontFile(font, w); wanted.set(f.weight, f); }
  await Promise.all([...wanted.values()].map(async f => {
    const key = `${font.family}|${f.weight}`;
    if (FACES.has(key)) return;
    try {
      const buf = await fileBytes(f.file, font.family, f.bytes, { force });
      if (FACES.has(key)) return;                                  // a parallel call got there first
      const face = new FontFace(font.family, buf, { weight: String(f.weight), style: 'normal' });
      await face.load();
      if (FACES.has(key)) return;
      document.fonts.add(face); FACES.set(key, face); loaded.push(f.weight);
      emit('loaded', { family: font.family, weight: f.weight });
    } catch (e) { error = e; emit('error', { family: font.family, file: f.file, error: e }); }
  }));
  return { ok: !error, family: font.family, loaded, error };
}
/**
 * Load every JSE font in `needs` (Map family → Set of weights, see fontNeeds()).
 * Resolves { loaded: number of files newly registered, failed: [family, …] }.
 */
export async function ensureFonts(needs, opts = {}) {
  const jobs = [];
  for (const [family, weights] of needs) if (jseFont(family)) jobs.push(loadFont(family, [...weights], opts));
  const results = await Promise.all(jobs);
  return { loaded: results.reduce((a, r) => a + r.loaded.length, 0), failed: results.filter(r => !r.ok).map(r => r.family) };
}
/** Load the JSE fonts a score names in its text styles / text objects. */
export function ensureScoreFonts(score, opts) { return ensureFonts(fontNeeds(score), opts); }

// ---------------------------------------------------------------------------------------------
// export: an SVG drawn through <img> (PNG / JPG / PDF), saved as a file or printed in another window
// cannot see document fonts, so the JSE fonts it names are written into it as @font-face data: URLs.
function base64Of(file) {
  let s = B64.get(file); if (s) return s;
  const bytes = new Uint8Array(MEM.get(file)); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  s = btoa(bin); B64.set(file, s);
  return s;
}
/** JSE families named in a piece of SVG / CSS text. */
export function jseFamiliesIn(text) {
  const s = String(text || '');
  return JSE_FONTS.filter(f => s.includes(`'${f.family}'`)).map(f => f.family);
}
/**
 * @font-face rules (data: URLs) for the given JSE families — the weights that are registered in this
 * document, i.e. exactly what the screen shows (a font that could not be loaded stays a fallback in the
 * export too, matching the spacing it was laid out with). '' when there is nothing to embed.
 */
export function fontFaceCss(families) {
  let css = '';
  for (const family of families) {
    const font = jseFont(family); if (!font) continue;
    for (const [w, f] of Object.entries(font.files)) {
      if (!FACES.has(`${font.family}|${w}`) || !MEM.has(f.file) || typeof btoa === 'undefined') continue;
      css += `@font-face{font-family:'${font.family}';font-weight:${w};font-style:normal;src:url(data:font/woff;base64,${base64Of(f.file)}) format('woff')}`;
    }
  }
  return css;
}
/** The SVG with the JSE fonts it uses embedded (synchronous: uses what is loaded). Unchanged when it uses none. */
export function embedFontsInSvg(svg) {
  const css = fontFaceCss(jseFamiliesIn(svg));
  if (!css) return svg;
  const at = svg.indexOf('<style>');
  if (at >= 0) return svg.slice(0, at + 7) + css + svg.slice(at + 7);
  return svg.replace(/(<svg\b[^>]*>)/, `$1<style>${css}</style>`);
}
// ---------------------------------------------------------------------------------------------
// fonts installed on this device
let detector = null;
function makeDetector() {
  const ctx = document.createElement('canvas').getContext('2d');
  const samples = ['mmmmmmmmmmlliWQ@1', '한글가나다라마바사'], bases = ['monospace', 'serif', 'sans-serif'];
  const width = (font, s) => { ctx.font = `72px ${font}`; return ctx.measureText(s).width; };
  const ref = bases.map(b => samples.map(s => width(b, s)));
  // an installed family measures the same in front of every generic and differently from at least one of them
  return family => bases.some((b, bi) => samples.some((s, si) => Math.abs(width(`'${family}',${b}`, s) - ref[bi][si]) > 0.01));
}
/** Is a font family installed on this device? (measuring test; false in Node) */
export function isFontInstalled(family) {
  const name = sanitizeFontFamily(family);
  if (!name || typeof document === 'undefined') return false;
  try { detector = detector || makeDetector(); return detector(name); } catch { return false; }
}
let candidateCache = null;
/** Installed fonts among DEVICE_FONT_CANDIDATES: [{ family, ko }] (family = the name that matched). */
export function detectDeviceFonts() {
  if (candidateCache) return candidateCache;
  const out = [];
  for (const c of DEVICE_FONT_CANDIDATES) {
    if (jseFont(c.family)) continue;                       // offered as a JSE font (same on every device)
    const hit = [c.family, ...(c.alt || [])].find(n => isFontInstalled(n));
    if (hit) out.push({ family: hit, ko: c.ko || '' });
  }
  candidateCache = out;
  return out;
}
let localList = null, localTried = false;
/** Has the full list of installed fonts been asked for already (successfully or not)? */
export function deviceFontsListed() { return localTried; }
/** Can the browser list the installed fonts (Local Font Access API)? */
export function canQueryLocalFonts() { return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function'; }
/** 'granted' | 'prompt' | 'denied' | 'unsupported' — whether listing the installed fonts would ask the user first. */
export async function localFontAccess() {
  if (!canQueryLocalFonts()) return 'unsupported';
  try { return (await navigator.permissions.query({ name: 'local-fonts' })).state; } catch { return 'prompt'; }
}
/**
 * Every font family installed on this device (asks for permission the first time; call it from a click).
 * Resolves [{ family, ko }] sorted by name, or null when the browser cannot / may not list them.
 */
export async function queryDeviceFonts() {
  if (localList) return localList;
  if (!canQueryLocalFonts()) return null;
  localTried = true;
  try {
    const fonts = await window.queryLocalFonts();
    const seen = new Map();
    for (const f of fonts) {
      const family = sanitizeFontFamily(f.family);
      if (!family || jseFont(family) || seen.has(family.toLowerCase())) continue;
      seen.set(family.toLowerCase(), { family, ko: KO_NAMES.get(family.toLowerCase()) || '' });
    }
    if (!seen.size) return null;                            // permission denied → empty list
    localList = [...seen.values()].sort((a, b) => (a.ko || a.family).localeCompare(b.ko || b.family, 'ko'));
    return localList;
  } catch { return null; }
}
/** The device fonts known so far without asking: the full list when it was already fetched, else the detected candidates. */
export function knownDeviceFonts() { return localList || detectDeviceFonts(); }

/** "1.2 MB" */
export function formatBytes(n) { return n >= 1024000 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
