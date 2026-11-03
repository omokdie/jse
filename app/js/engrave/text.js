// Text measurement helpers (sp units). Uses a canvas when available, heuristic otherwise.
export const TEXT_FONT = '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
export const SERIF_FONT = '"Noto Serif KR","Nanum Myeongjo","Times New Roman",Georgia,serif';

let ctx = null;
function getCtx() {
  if (ctx !== null) return ctx;
  try {
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); ctx = c.getContext('2d'); }
    else if (typeof OffscreenCanvas !== 'undefined') { ctx = new OffscreenCanvas(10, 10).getContext('2d'); }
    else ctx = false;
  } catch { ctx = false; }
  return ctx;
}
const cache = new Map();
/** Width of `str` drawn at font-size `size` (sp) → width in sp. */
export function textWidth(str, size, bold = false, italic = false, family = TEXT_FONT) {
  if (!str) return 0;
  const key = `${size}|${bold}|${italic}|${family}|${str}`;
  const c = cache.get(key); if (c != null) return c;
  let w;
  const cx = getCtx();
  if (cx) {
    cx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}100px ${family}`;
    w = cx.measureText(str).width / 100 * size;
  } else {
    let units = 0;
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code > 0x2E80) units += 1.0;           // CJK / Hangul full-width
      else if (/[iljtfI.,:;'!|]/.test(ch)) units += 0.3;
      else if (/[mwMW@]/.test(ch)) units += 0.85;
      else if (/[A-Z]/.test(ch)) units += 0.68;
      else if (ch === ' ') units += 0.28;
      else units += 0.55;
    }
    w = units * size * (bold ? 1.06 : 1);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, w);
  return w;
}
export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Pretty chord text: C#m7 → C♯m7, Bb → B♭ (only the root/bass letters). */
export function prettyChord(text) {
  return String(text || '').replace(/([A-G])#/g, '$1♯').replace(/([A-G])b(?![a-z])/g, '$1♭').replace(/\/([A-G])#/g, '/$1♯').replace(/\/([A-G])b/g, '/$1♭');
}
