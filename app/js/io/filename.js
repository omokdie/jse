// File names for saving and exporting: the name the dialogs start with, what the user may type, what gets written.
// Pure functions (no DOM) — used by the export dialog, 저장 / 다른 이름으로 저장 and their tests.

/** Characters Windows (and Android's file providers) refuse in a file name, plus control characters. */
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const HAS_BAD = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
/** Extensions JSE writes. One typed at the end of a name is dropped — the chosen format decides the extension. */
const OWN_EXT = /\.(pdf|png|jpe?g|svg|zip|mscz|mscx|nwc|nwctxt|musicxml|mxl|xml|midi?|ssnap|musx)$/i;
/** Names Windows reserves for devices ("con.pdf" cannot be created). */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_FILE_BASE = 120;
export const FALLBACK_BASE = '악보';
/** For the dialogs' note: the characters that are replaced, as the user sees them. */
export const BAD_CHARS_TEXT = '\\ / : * ? " < > |';

/** Typed text → a safe base name without extension: refused characters become "_", runs of spaces become one,
 *  a typed JSE extension and trailing dots/spaces go. '' when nothing usable is left. */
export function cleanFileBase(text) {
  let s = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(BAD_CHARS, '_').trim();
  s = s.replace(OWN_EXT, '').replace(/[. ]+$/, '').trim();
  if (RESERVED.test(s)) s = '_' + s;
  const chars = [...s];
  return chars.length > MAX_FILE_BASE ? chars.slice(0, MAX_FILE_BASE).join('').trim() : s;
}

/** Whether typed text holds characters that will be replaced (the dialog says so). */
export function hasBadFileChars(text) { return HAS_BAD.test(String(text ?? '').replace(/\s+/g, ' ')); }

/** base + ext ("봄바람" + ".pdf"); a name already ending in that extension keeps it once. */
export function safeFileName(name, ext = '') {
  const base = cleanFileBase(name) || FALLBACK_BASE;
  return ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? base + ext : base;
}

/** The name the export and 다른 이름으로 저장 dialogs start with (no extension): the name last chosen for this
 *  document, else the document's file name, else its title. */
export function defaultFileBase({ lastName = null, fileName = null, title = '' } = {}) {
  const fromFile = fileName ? String(fileName).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : '';
  return cleanFileBase(lastName) || cleanFileBase(fromFile) || cleanFileBase(title) || FALLBACK_BASE;
}

/** What the user typed → the base to use; nothing usable typed → `fallback`. */
export function fileBaseFromInput(text, fallback = FALLBACK_BASE) {
  return cleanFileBase(text) || cleanFileBase(fallback) || FALLBACK_BASE;
}

/** The files an export writes: one name, one ZIP, or numbered files (base-1.png, base-2.png …). */
export function exportFileNames(base, ext, { count = 1, zip = true } = {}) {
  if (count <= 1) return [safeFileName(base, ext)];
  if (zip) return [safeFileName(base, '.zip')];
  return Array.from({ length: count }, (_, i) => safeFileName(`${cleanFileBase(base) || FALLBACK_BASE}-${i + 1}`, ext));
}

/** The text shown after the name field: ".pdf", ".zip", "-1.png, -2.png" or "-1.png … -5.png". */
export function exportNameSuffix(ext, { count = 1, zip = true } = {}) {
  if (count <= 1) return ext;
  if (zip) return '.zip';
  return count === 2 ? `-1${ext}, -2${ext}` : `-1${ext} … -${count}${ext}`;
}

/** Where a saved file went, in words, from what saveBlob returned ({path} · {handle,name} · {download}). */
export function savedFileLabel(res, name) {
  if (!res) return name;
  if (res.path) {
    const p = String(res.path);
    const android = /^Download\/(.+)$/i.exec(p);          // Android: Download/JSE/<final name>
    if (android) return `다운로드/${android[1]}`;
    return p.split(/[\\/]/).pop() || name;                // desktop: the name chosen in the save dialog
  }
  return res.name || name;
}
