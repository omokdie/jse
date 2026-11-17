// Text styles of a score: font family / size / bold / italic for every kind of text.
// Pure JS (browser, worker, Node). Data contract:
//
//   score.settings.textStyles = {          // optional; every key and every field optional
//     title: { family, size, bold, italic }, subtitle, composer /* composer + arranger */, lyricist,
//     lyrics, chord, text /* staff / system / expression texts */, tempo, rehearsal, partName, measureNumber
//   }
//   measure.texts[i].font / event.texts[i].font = { family, size, bold, italic }   // optional per-object override
//
//   family  ONE font family name ("Nanum Myeongjo"); '' / absent = the built-in default stack.
//           The engraver appends the default stack as fallback.
//   size    in STAFF SPACES (like the SP constants of engrave/layout.js) so text keeps scaling with the
//           staff size. The UI shows points: pt = sp × staffSpaceMm ÷ 0.3528.
//   bold / italic   booleans; absent = the default of that kind of text (title, chords, tempo words and
//           rehearsal marks are bold).
//           Free texts (`text`) get their emphasis from their own style — expression = italic,
//           technique / system = bold — so for that kind `true` means "all of them", while `false` and
//           absent both mean "automatic". One text can still be forced either way with its own `font`.

export const TEXT_STYLE_KEYS = ['title', 'subtitle', 'composer', 'lyricist', 'lyrics', 'chord', 'text', 'tempo', 'rehearsal', 'partName', 'measureNumber'];

/** Built-in look. The sizes are the SP constants of engrave/layout.js (tools/tests/textstyles.test.js keeps them equal). */
export const TEXT_STYLE_DEFAULTS = Object.freeze({
  title: Object.freeze({ family: '', size: 5.2, bold: true, italic: false }),
  subtitle: Object.freeze({ family: '', size: 3.0, bold: false, italic: false }),
  composer: Object.freeze({ family: '', size: 2.4, bold: false, italic: false }),
  lyricist: Object.freeze({ family: '', size: 2.4, bold: false, italic: false }),
  lyrics: Object.freeze({ family: '', size: 2.1, bold: false, italic: false }),
  chord: Object.freeze({ family: '', size: 2.3, bold: true, italic: false }),
  text: Object.freeze({ family: '', size: 2.2, bold: false, italic: false }),
  tempo: Object.freeze({ family: '', size: 2.4, bold: true, italic: false }),
  rehearsal: Object.freeze({ family: '', size: 2.3, bold: true, italic: false }),
  partName: Object.freeze({ family: '', size: 2.2, bold: false, italic: false }),
  measureNumber: Object.freeze({ family: '', size: 1.6, bold: false, italic: false }),
});

export const MM_PER_PT = 0.3528;
export const DEFAULT_STAFF_SPACE_MM = 1.75;
export const TEXT_SIZE_MIN_SP = 0.5, TEXT_SIZE_MAX_SP = 30;

const round = (x, digits) => { const f = 10 ** digits; return Math.round(x * f) / f; };
const staffSpace = v => (Number.isFinite(v) && v > 0 ? v : DEFAULT_STAFF_SPACE_MM);
/** Points → staff spaces for a staff space of `staffSpaceMm` millimetres. */
export function ptToSp(pt, staffSpaceMm = DEFAULT_STAFF_SPACE_MM) { return round(pt * MM_PER_PT / staffSpace(staffSpaceMm), 4); }
/** Staff spaces → points. */
export function spToPt(sp, staffSpaceMm = DEFAULT_STAFF_SPACE_MM) { return round(sp * staffSpace(staffSpaceMm) / MM_PER_PT, 4); }

// ---------------------------------------------------------------------------------------------
// family names — they end up inside SVG attributes, a <style> element and canvas font strings,
// and a score file may come from anywhere, so only harmless characters are let through.
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
const FAMILY_OK = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._+()\-]*$/u;
/**
 * A usable font family name, or '' (= default). Rejects — never "repairs" — anything that could break
 * out of a quoted CSS string or XML attribute (quotes, backslash, < > & ; { } , control characters …).
 */
export function sanitizeFontFamily(name) {
  if (typeof name !== 'string') return '';
  const s = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80 || !FAMILY_OK.test(s)) return '';
  return s;
}
/** The family as a CSS <family-name>: quoted, or a bare generic keyword (serif, sans-serif, monospace …). */
export function cssFontFamily(name) {
  const s = sanitizeFontFamily(name);
  if (!s) return '';
  return GENERIC_FAMILIES.has(s.toLowerCase()) ? s.toLowerCase() : `'${s}'`;
}
/** `'Family',<fallback stack>` — or just the fallback when there is no family. */
export function cssFontStack(name, fallback) {
  const f = cssFontFamily(name);
  return f ? `${f},${fallback}` : fallback;
}

function validSize(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < TEXT_SIZE_MIN_SP || v > TEXT_SIZE_MAX_SP) return null;
  return v;
}
/** Size clamped into the supported range (for editors). */
export function clampTextSize(sp) { return Math.min(TEXT_SIZE_MAX_SP, Math.max(TEXT_SIZE_MIN_SP, sp)); }

/** { family, size, bold, italic } of one kind of text — the stored style over the built-in default. */
export function resolveTextStyle(settings, key) {
  const d = TEXT_STYLE_DEFAULTS[key] || TEXT_STYLE_DEFAULTS.text;
  const o = settings && settings.textStyles && settings.textStyles[key];
  if (!o || typeof o !== 'object') return { family: d.family, size: d.size, bold: d.bold, italic: d.italic };
  return {
    family: sanitizeFontFamily(o.family),
    size: validSize(o.size) ?? d.size,
    bold: typeof o.bold === 'boolean' ? o.bold : d.bold,
    italic: typeof o.italic === 'boolean' ? o.italic : d.italic,
  };
}
/** All kinds at once: { title: {...}, subtitle: {...}, … }. */
export function resolveTextStyles(settings) {
  const out = {};
  for (const key of TEXT_STYLE_KEYS) out[key] = resolveTextStyle(settings, key);
  return out;
}
/**
 * Style of ONE free text object (measure.texts[i] / event.texts[i]):
 *   family / size   its own `font` → the `text` style of the score
 *   bold / italic   its own `font` (true or false) → `true` in the score's `text` style → what its own style
 *                   implies (`auto`: expression = italic, technique / system = bold)
 * `own` tells whether the object carries an override.
 */
export function resolveTextObjectStyle(settings, obj, auto = {}) {
  const base = resolveTextStyle(settings, 'text');
  const cat = settings && settings.textStyles && typeof settings.textStyles.text === 'object' ? settings.textStyles.text : null;
  const f = obj && obj.font && typeof obj.font === 'object' ? obj.font : null;
  const pick = (k) => (f && typeof f[k] === 'boolean' ? f[k] : cat && cat[k] === true ? true : !!auto[k]);
  return {
    family: (f && sanitizeFontFamily(f.family)) || base.family,
    size: (f && validSize(f.size)) ?? base.size,
    bold: pick('bold'),
    italic: pick('italic'),
    own: !!f,
  };
}
/** The emphasis a free text gets from its `style` when nothing else says so. */
export function autoEmphasis(textObj, { measureLevel = false } = {}) {
  const st = textObj && textObj.style;
  return { italic: st === 'expression', bold: st === 'technique' || (measureLevel && st === 'system') };
}

/** One style object reduced to its valid fields ({} when nothing is left). `defaults` given → fields equal to it are dropped. */
export function normalizeTextStyle(o, defaults = null) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  const fam = sanitizeFontFamily(o.family);
  if (fam) out.family = fam;
  const size = validSize(o.size);
  if (size != null && !(defaults && Math.abs(size - defaults.size) < 1e-6)) out.size = round(size, 4);
  for (const k of ['bold', 'italic']) if (typeof o[k] === 'boolean' && !(defaults && o[k] === defaults[k])) out[k] = o[k];
  return out;
}
/**
 * A clean copy of a textStyles object: known keys, valid fields, values that equal the built-in default
 * left out. Returns undefined when nothing differs from the defaults (then `settings.textStyles` should
 * simply be absent — the engraver output is then exactly the built-in one).
 */
export function normalizeTextStyles(styles) {
  if (!styles || typeof styles !== 'object') return undefined;
  const out = {};
  for (const key of TEXT_STYLE_KEYS) {
    const one = normalizeTextStyle(styles[key], TEXT_STYLE_DEFAULTS[key]);
    if (Object.keys(one).length) out[key] = one;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Write `styles` into score.settings (removing the property when everything is default). Returns the stored object. */
export function applyTextStyles(score, styles) {
  const clean = normalizeTextStyles(styles);
  if (!score.settings) score.settings = {};
  if (clean) score.settings.textStyles = clean; else delete score.settings.textStyles;
  return clean;
}
export function textStylesEqual(a, b) { return JSON.stringify(normalizeTextStyles(a) || {}) === JSON.stringify(normalizeTextStyles(b) || {}); }

/** Per-object override reduced to its valid fields, or undefined. */
export function normalizeTextFont(font) {
  const one = normalizeTextStyle(font);
  return Object.keys(one).length ? one : undefined;
}

/** Calls cb(textObj, { level: 'measure' | 'event', measure, mi, index, ev? }) for every free text object. */
export function forEachTextObject(score, cb) {
  (score.measures || []).forEach((m, mi) => {
    (m.texts || []).forEach((t, index) => cb(t, { level: 'measure', measure: m, mi, index }));
    for (const sm of (m.staves || [])) for (const v of (sm.voices || [])) for (const ev of v) {
      if (ev.texts) ev.texts.forEach((t, index) => cb(t, { level: 'event', measure: m, mi, index, ev }));
    }
  });
}

/**
 * Font files a score needs: Map(family → Set of weights 400 / 700). Only families the score names
 * explicitly are listed (the default stack needs nothing).
 */
export function fontNeeds(score) {
  const needs = new Map();
  const add = (family, bold) => { if (!family) return; if (!needs.has(family)) needs.set(family, new Set()); needs.get(family).add(bold ? 700 : 400); };
  const settings = (score && score.settings) || {};
  for (const key of TEXT_STYLE_KEYS) {
    if (key === 'text') continue;
    const st = resolveTextStyle(settings, key);
    add(st.family, st.bold);
    if (key === 'tempo') add(st.family, false);          // the "= 120" part is never bold
  }
  const text = resolveTextStyle(settings, 'text');
  let any = false;
  if (score && Array.isArray(score.measures)) {
    forEachTextObject(score, (t, ctx) => { any = true; const st = resolveTextObjectStyle(settings, t, autoEmphasis(t, { measureLevel: ctx.level === 'measure' })); add(st.family, st.bold); });
    if (text.family) {
      if (score.measures.some(m => m.markers && m.markers.length)) add(text.family, true);                      // Fine, D.S. al Coda …
      if ((score.spanners || []).some(sp => sp.type === 'textLine' && sp.text)) add(text.family, false);
    }
  }
  if (text.family && !any) add(text.family, text.bold);   // nothing written yet: have the face ready for the first text
  return needs;
}
