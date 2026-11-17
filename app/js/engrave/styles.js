// Text styles as the engraver needs them (see model/textstyles.js for the data contract).
// Everything here is arranged so that a score WITHOUT settings.textStyles engraves to exactly the same
// SVG as before the feature existed: sizes are scaled with k = size / default size (exactly 1 then),
// no extra attributes, classes or CSS rules are written.
import { TEXT_STYLE_KEYS, TEXT_STYLE_DEFAULTS, resolveTextStyle, resolveTextObjectStyle, autoEmphasis, cssFontStack } from '../model/textstyles.js';
import { TEXT_FONT } from './text.js';

/** The built-in stack the way it is written into SVG / CSS (single quotes). */
export const DEFAULT_STACK = TEXT_FONT.replace(/"/g, "'");

/** CSS class each kind of text carries in the page SVG. */
const KIND_CLASSES = {
  title: ['title'], subtitle: ['subtitle'], composer: ['composer'], lyricist: ['lyricist'],
  lyrics: ['lyric'], chord: ['chord'], text: ['mtext', 'etext', 'marker-text', 'line-text'],
  tempo: ['tempo-text', 'tempo-bpm'], rehearsal: ['rehearsal'], partName: ['part-name'], measureNumber: ['measure-number'],
};

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Per-engrave view of the score's text styles:
 *   S[key] = { family, size, bold, italic,      // resolved style
 *              k,        // size ÷ built-in size (exactly 1 when the size is the built-in one)
 *              stack,    // CSS font-family list for measuring, undefined = the built-in stack
 *              custom }  // differs from the built-in look
 *   S.custom   any kind differs · S.css  extra rules for the page <style> ('' when default)
 *   S.cls      extra class of the page <svg> that scopes those rules ('' when default)
 *   S.textObj(t, measureLevel) → style of one free text object (with k / stack like above)
 */
export function engraveStyles(score) {
  const settings = score.settings || {};
  const S = { custom: false, css: '', cls: '' };
  const rules = [];
  for (const key of TEXT_STYLE_KEYS) {
    const st = resolveTextStyle(settings, key), d = TEXT_STYLE_DEFAULTS[key];
    const custom = !!st.family || st.size !== d.size || st.bold !== d.bold || st.italic !== d.italic;
    S[key] = { ...st, k: st.size / d.size, stack: st.family ? cssFontStack(st.family, DEFAULT_STACK) : undefined, custom };
    if (custom) S.custom = true;
    const decl = [];
    if (st.family) decl.push(`font-family:${cssFontStack(st.family, DEFAULT_STACK)}`);
    if (key === 'chord' && !st.bold) decl.push('font-weight:400');     // the base sheet makes .chord bold
    if (decl.length) rules.push({ classes: KIND_CLASSES[key], decl: decl.join(';') });
  }
  if (rules.length) {
    const body = rules.map(r => r.decl).join('|');
    S.cls = 'ts-' + hash(body);
    // scoped to this style set: several differently styled scores can be in one document (previews, thumbnails)
    S.css = rules.map(r => `${r.classes.map(c => `.score-page.${S.cls} text.${c}`).join(',')}{${r.decl}}`).join('');
  }
  const base = S.text, dText = TEXT_STYLE_DEFAULTS.text;
  S.textObj = (t, measureLevel = false) => {
    const st = resolveTextObjectStyle(settings, t, autoEmphasis(t, { measureLevel }));
    // the family only has to be written on the element when it is not the one the class rule already gives
    const ownFamily = st.own && st.family && st.family !== base.family ? cssFontStack(st.family, DEFAULT_STACK) : '';
    return { ...st, k: st.size / dText.size, stack: st.family ? cssFontStack(st.family, DEFAULT_STACK) : undefined, inline: ownFamily };
  };
  return S;
}
