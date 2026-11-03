// Inline SVG icons. Music icons are built from the engraving glyphs; UI icons are simple strokes.
import { GLYPHS } from '../engrave/glyphs.js';

const esc = s => s;
function gpath(name, x, y, scale = 1, extra = '') {
  const g = GLYPHS[name]; if (!g) return '';
  return `<path d="${g.p}" transform="translate(${x} ${y})${scale !== 1 ? ` scale(${scale})` : ''}" ${extra}/>`;
}
/** Compose a music icon in staff-space units. parts: [{g,x,y,s}|{line:[x1,y1,x2,y2,w]}|{rect}] */
export function musicIcon(parts, { vb = '-1 -3.5 6 7', cls = '' } = {}) {
  let s = '';
  for (const p of parts) {
    if (p.g) s += gpath(p.g, p.x || 0, p.y || 0, p.s || 1);
    else if (p.line) { const [x1, y1, x2, y2, w] = p.line; s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${w || 0.14}"/>`; }
    else if (p.circle) { const [cx, cy, r] = p.circle; s += `<circle cx="${cx}" cy="${cy}" r="${r}"/>`; }
    else if (p.text) s += `<text x="${p.x}" y="${p.y}" font-size="${p.size || 2}" text-anchor="${p.anchor || 'middle'}" font-weight="${p.bold ? 700 : 400}" font-style="${p.italic ? 'italic' : 'normal'}" fill="currentColor" font-family="serif">${esc(p.text)}</text>`;
    else if (p.raw) s += p.raw;
  }
  return `<svg viewBox="${vb}" class="mi ${cls}" fill="currentColor" aria-hidden="true">${s}</svg>`;
}
const staffLines = (x0 = -0.8, x1 = 4.8) => Array.from({ length: 5 }, (_, i) => ({ line: [x0, i - 2, x1, i - 2, 0.08] }));

export function noteIcon(base, dots = 0, { rest = false } = {}) {
  if (rest) {
    const g = { whole: 'restWhole', half: 'restHalf', quarter: 'restQuarter', eighth: 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd', '64th': 'rest64th', breve: 'restDoubleWhole' }[base] || 'restQuarter';
    const parts = [{ g, x: 1.3, y: 0, s: 1 }];
    if (base === 'whole') parts.push({ line: [0.6, -1, 3.2, -1, 0.1] });
    if (base === 'half') parts.push({ line: [0.6, 0, 3.2, 0, 0.1] });
    if (dots) parts.push({ circle: [3.2, -0.5, 0.22] });
    return musicIcon(parts, { vb: '-0.5 -3 5 6' });
  }
  const headG = base === 'whole' ? 'noteheadWhole' : base === 'breve' ? 'noteheadDoubleWhole' : base === 'half' ? 'noteheadHalf' : 'noteheadBlack';
  const parts = [{ g: headG, x: 0.6, y: 1.5 }];
  const hw = GLYPHS[headG].w;
  const flags = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 }[base] || 0;
  if (base !== 'whole' && base !== 'breve') {
    const top = 1.5 - 3.2 - (flags > 1 ? (flags - 1) * 0.4 : 0);
    parts.push({ line: [0.6 + hw - 0.07, 1.5, 0.6 + hw - 0.07, top, 0.14] });
    if (flags) parts.push({ g: ['flag8thUp', 'flag16thUp', 'flag32ndUp', 'flag64thUp'][flags - 1], x: 0.6 + hw - 0.13, y: top });
  }
  if (dots) for (let i = 0; i < dots; i++) parts.push({ circle: [0.6 + hw + 0.5 + i * 0.55, 1.0, 0.22] });
  return musicIcon(parts, { vb: '-0.6 -3 5 6' });
}
export function accidentalIcon(acc) {
  const g = { sharp: 'accidentalSharp', flat: 'accidentalFlat', natural: 'accidentalNatural', 'double-sharp': 'accidentalDoubleSharp', 'double-flat': 'accidentalDoubleFlat' }[acc];
  return musicIcon([{ g, x: 1.3, y: 0, s: 1.1 }], { vb: '0 -2.5 5 5' });
}
export function articIcon(art) {
  const g = { staccato: 'articStaccato', staccatissimo: 'articStaccatissimo', accent: 'articAccent', marcato: 'articMarcato', tenuto: 'articTenuto', 'tenuto-staccato': 'articTenutoStaccato', 'accent-staccato': 'articAccentStaccato', 'marcato-staccato': 'articMarcatoStaccato' }[art];
  return musicIcon([{ g: 'noteheadBlack', x: 1.2, y: 1.2 }, { line: [1.2 + 1.19, 1.2, 1.2 + 1.19, -1.8, 0.14] }, { g, x: 1.83, y: 2.3, s: 1.1 }], { vb: '0 -2.5 5 6' });
}
export function dynamicIcon(dyn) {
  const map = { p: 'dynamicPiano', m: 'dynamicMezzo', f: 'dynamicForte', s: 'dynamicSforzando', z: 'dynamicZ', r: 'dynamicRinforzando' };
  const parts = []; let x = 0.2; const scale = 0.72;
  for (const ch of dyn) { const g = map[ch]; if (!g) continue; parts.push({ g, x, y: 1.1, s: scale }); x += (GLYPHS[g].adv || 2) * scale; }
  return musicIcon(parts, { vb: `-0.4 -1.8 ${Math.max(4.4, x + 1)} 4.4` });
}
export function clefIcon(clef) {
  const g = { treble: 'gClef', bass: 'fClef', alto: 'cClef', tenor: 'cClef', percussion: 'percClef', treble8vb: 'gClef8vb', bass8vb: 'fClef8vb' }[clef];
  const y = { treble: 1, bass: -1, alto: 0, tenor: -1, percussion: 0, treble8vb: 1, bass8vb: -1 }[clef] ?? 0;
  if (clef === 'tab') return musicIcon([...staffLines(0, 4), { text: 'TAB', x: 2, y: 0.6, size: 1.6, bold: true }], { vb: '-0.5 -3.2 5 6.4' });
  return musicIcon([...staffLines(0, 4), { g, x: 0.6, y, s: 0.95 }], { vb: '-0.5 -3.6 5 7.2' });
}
export function keySigIcon(fifths) {
  const parts = [...staffLines(0, 5)];
  const pos = fifths > 0 ? [0, 3, -1, 2, 5, 1, 4] : [4, 1, 5, 2, 6, 3, 7];
  const n = Math.abs(fifths);
  for (let i = 0; i < n; i++) parts.push({ g: fifths > 0 ? 'accidentalSharp' : 'accidentalFlat', x: 0.3 + i * 0.65, y: pos[i] / 2 - 2, s: 0.7 });
  if (!n) parts.push({ g: 'accidentalNatural', x: 1.8, y: 0, s: 0.9 });
  return musicIcon(parts, { vb: '-0.3 -3.5 5.6 7' });
}
export function timeSigIcon(num, den) {
  const parts = [];
  const dw = s => String(s).split('').reduce((a, c) => a + GLYPHS['tsDigit' + c].w, 0);
  const w = Math.max(dw(num), dw(den)); let x = (3.2 - w) / 2;
  for (const c of String(num)) { parts.push({ g: 'tsDigit' + c, x, y: 0 }); x += GLYPHS['tsDigit' + c].w; }
  x = (3.2 - dw(den)) / 2; for (const c of String(den)) { parts.push({ g: 'tsDigit' + c, x, y: 2 }); x += GLYPHS['tsDigit' + c].w; }
  return musicIcon(parts, { vb: '-0.6 -2.4 4.4 5' });
}
export function barlineIcon(type) {
  const parts = [...staffLines(0, 4)];
  const x = 2;
  switch (type) {
    case 'double': parts.push({ line: [x - 0.3, -2, x - 0.3, 2, 0.16] }, { line: [x + 0.3, -2, x + 0.3, 2, 0.16] }); break;
    case 'final': parts.push({ line: [x - 0.4, -2, x - 0.4, 2, 0.16] }, { line: [x + 0.3, -2, x + 0.3, 2, 0.5] }); break;
    case 'repeat-start': parts.push({ line: [x - 0.6, -2, x - 0.6, 2, 0.5] }, { line: [x + 0.1, -2, x + 0.1, 2, 0.16] }, { circle: [x + 0.8, -0.5, 0.22] }, { circle: [x + 0.8, 0.5, 0.22] }); break;
    case 'repeat-end': parts.push({ line: [x + 0.6, -2, x + 0.6, 2, 0.5] }, { line: [x - 0.1, -2, x - 0.1, 2, 0.16] }, { circle: [x - 0.8, -0.5, 0.22] }, { circle: [x - 0.8, 0.5, 0.22] }); break;
    case 'dashed': parts.push({ raw: `<line x1="${x}" y1="-2" x2="${x}" y2="2" stroke="currentColor" stroke-width="0.16" stroke-dasharray="0.5 0.4"/>` }); break;
    case 'none': parts.push({ raw: `<line x1="${x}" y1="-2" x2="${x}" y2="2" stroke="currentColor" stroke-width="0.12" stroke-dasharray="0.2 0.3" opacity=".4"/>` }); break;
    default: parts.push({ line: [x, -2, x, 2, 0.16] });
  }
  return musicIcon(parts, { vb: '-0.5 -3 5 6' });
}
export function textIcon(label, { italic = false, bold = false, size = 2.2 } = {}) {
  return musicIcon([{ text: label, x: 2.5, y: 0.8, size, italic, bold }], { vb: '0 -2 5 4' });
}
export function glyphIcon(name, { s = 1, y = 0, x = 2.5, vb = '0 -2.5 5 5' } = {}) {
  return musicIcon([{ g: name, x: x - (GLYPHS[name]?.w || 2) * s / 2, y, s }], { vb });
}
export function slurIcon() { return musicIcon([{ g: 'noteheadBlack', x: 0.3, y: 1 }, { g: 'noteheadBlack', x: 3.2, y: 0.5 }, { raw: '<path d="M0.9 -0.1 Q2.6 -2.2 4.3 -0.6" stroke="currentColor" stroke-width="0.22" fill="none"/>' }], { vb: '-0.3 -2.6 5.4 5' }); }
export function tieIcon() { return musicIcon([{ g: 'noteheadBlack', x: 0.3, y: 0.5 }, { g: 'noteheadBlack', x: 3.2, y: 0.5 }, { raw: '<path d="M1.2 1.3 Q2.6 2.6 4 1.3" stroke="currentColor" stroke-width="0.22" fill="none"/>' }], { vb: '-0.3 -2 5.4 5' }); }
export function hairpinIcon(type) { return musicIcon([{ raw: type === 'crescendo' ? '<path d="M4.4 -1 L0.4 0 L4.4 1" stroke="currentColor" stroke-width="0.16" fill="none"/>' : '<path d="M0.4 -1 L4.4 0 L0.4 1" stroke="currentColor" stroke-width="0.16" fill="none"/>' }], { vb: '0 -2.2 5 4.4' }); }
export function tupletIcon(n) { return musicIcon([{ g: 'noteheadBlack', x: 0, y: 1.2 }, { g: 'noteheadBlack', x: 1.6, y: 1.2 }, { g: 'noteheadBlack', x: 3.2, y: 1.2 }, { line: [1.19, 1.2, 1.19, -1.4, 0.13] }, { line: [2.79, 1.2, 2.79, -1.4, 0.13] }, { line: [4.39, 1.2, 4.39, -1.4, 0.13] }, { raw: '<path d="M1.12 -1.65 L4.46 -1.65 L4.46 -1.15 L1.12 -1.15 Z"/>' }, { g: 'tsDigit' + n, x: 2.3, y: -2.1, s: 0.55 }], { vb: '-0.6 -3.4 6 6' }); }
export function graceIcon() { return musicIcon([{ g: 'noteheadBlack', x: 0.3, y: 1, s: 0.65 }, { line: [1.05, 1, 1.05, -1.2, 0.1] }, { g: 'flag8thUp', x: 1.0, y: -1.2, s: 0.65 }, { line: [0.5, -0.3, 1.6, -1.0, 0.1] }, { g: 'noteheadBlack', x: 2.6, y: 1.2 }, { line: [3.79, 1.2, 3.79, -1.8, 0.14] }], { vb: '-0.3 -2.6 5.4 5' }); }
export function drumIcon(key) {
  const head = { kick: 'noteheadBlack', snare: 'noteheadBlack', 'hihat-closed': 'noteheadX', 'hihat-open': 'noteheadCircleX', crash: 'noteheadX', ride: 'noteheadX', 'tom-high': 'noteheadBlack', 'tom-mid': 'noteheadBlack', 'tom-low': 'noteheadBlack', 'floor-tom': 'noteheadBlack', 'hihat-pedal': 'noteheadX', cowbell: 'noteheadTriangleUpBlack', 'ride-bell': 'noteheadDiamondBlack', rimshot: 'noteheadX', china: 'noteheadX', splash: 'noteheadX' }[key] || 'noteheadBlack';
  return musicIcon([...staffLines(0, 4), { g: head, x: 1.4, y: 0 }], { vb: '-0.5 -3 5 6' });
}
export function restDurationIcon(base) { return noteIcon(base, 0, { rest: true }); }

// ---- UI icons (24×24), drawn for the liquid-glass look: 1.7px rounded strokes + a soft tinted fill ----
const ui = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const tint = 'fill="currentColor" fill-opacity=".16"';
const solid = 'fill="currentColor" stroke="none"';
export const ICONS = {
  logo: `<svg viewBox="0 0 1024 1024" aria-hidden="true"> <defs> <linearGradient id="jse-bg" gradientUnits="userSpaceOnUse" x1="120" y1="40" x2="900" y2="1000"><stop offset="0" stop-color="#3fb3ff"/><stop offset=".5" stop-color="#0a6cff"/><stop offset="1" stop-color="#5b4bea"/></linearGradient> <radialGradient id="jse-glow" gradientUnits="userSpaceOnUse" cx="260" cy="120" r="760"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient> <linearGradient id="jse-ink" gradientUnits="userSpaceOnUse" x1="0" y1="360" x2="0" y2="660"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e3ecff"/></linearGradient> <linearGradient id="jse-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient> <filter id="jse-sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#0b1a5c" flood-opacity=".35"/></filter> </defs> <rect width="1024" height="1024" rx="232" fill="url(#jse-bg)"/> <g stroke="#fff" stroke-opacity=".5" stroke-width="12" stroke-linecap="round"><line x1="104" y1="372" x2="920" y2="372"/><line x1="104" y1="442" x2="920" y2="442"/><line x1="104" y1="512" x2="920" y2="512"/><line x1="104" y1="582" x2="920" y2="582"/><line x1="104" y1="652" x2="920" y2="652"/></g> <path d="M305.6 661.6C357.7 661.6 388.1 634.7 388.1 586.2V422H331.1V585.3C331.1 603.8 321.3 614.1 304.8 614.1C288.2 614.1 278.4 603.8 278.4 585.3V567.6H225.3V584.8C225.3 634.2 254.9 661.6 305.6 661.6Z M506.1 661.8C567 661.8 603.1 633.8 603.1 586.2C603.1 549.8 580.4 529.1 528.2 518.6L507.4 514.5C480.5 509 469.2 501.8 469.2 489C469.2 474.3 484.3 464 505.8 464C528.3 464 543.4 476 544.9 495.5H597.7C596.3 447.2 561.6 418.2 505 418.2C449.6 418.2 412.2 447.8 412.2 491.7C412.2 526.1 435.8 548.9 481.9 558.4L506.1 563.3C534.5 569.1 546.7 576.9 546.7 590.4C546.7 605.9 530.7 616 506.6 616C479.4 616 462.7 602.7 461.9 580.1H407.6C407.6 632.2 443.3 661.8 506.1 661.8Z M622.9 658H798.7V609.5H679.9V563H789.7V515.9H679.9V470.5H798.7V422H622.9Z" fill="url(#jse-bg)" stroke="url(#jse-bg)" stroke-width="40" stroke-linejoin="round"/> <rect width="1024" height="1024" rx="232" fill="url(#jse-glow)"/> <path d="M305.6 661.6C357.7 661.6 388.1 634.7 388.1 586.2V422H331.1V585.3C331.1 603.8 321.3 614.1 304.8 614.1C288.2 614.1 278.4 603.8 278.4 585.3V567.6H225.3V584.8C225.3 634.2 254.9 661.6 305.6 661.6Z M506.1 661.8C567 661.8 603.1 633.8 603.1 586.2C603.1 549.8 580.4 529.1 528.2 518.6L507.4 514.5C480.5 509 469.2 501.8 469.2 489C469.2 474.3 484.3 464 505.8 464C528.3 464 543.4 476 544.9 495.5H597.7C596.3 447.2 561.6 418.2 505 418.2C449.6 418.2 412.2 447.8 412.2 491.7C412.2 526.1 435.8 548.9 481.9 558.4L506.1 563.3C534.5 569.1 546.7 576.9 546.7 590.4C546.7 605.9 530.7 616 506.6 616C479.4 616 462.7 602.7 461.9 580.1H407.6C407.6 632.2 443.3 661.8 506.1 661.8Z M622.9 658H798.7V609.5H679.9V563H789.7V515.9H679.9V470.5H798.7V422H622.9Z" fill="url(#jse-ink)"/> <rect x="5" y="5" width="1014" height="1014" rx="228" fill="none" stroke="url(#jse-rim)" stroke-width="10"/> </svg>`,
  menu: ui('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  more: ui(`<circle cx="5.5" cy="12" r="1.6" ${solid}/><circle cx="12" cy="12" r="1.6" ${solid}/><circle cx="18.5" cy="12" r="1.6" ${solid}/>`),
  new: ui(`<path d="M13.5 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.5z" ${tint}/><path d="M13.5 3v3.5a2 2 0 0 0 2 2H19M12 11.5v6M9 14.5h6"/>`),
  open: ui(`<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2l2 2H18a2.5 2.5 0 0 1 2.5 2.5v.5H8.4a2 2 0 0 0-1.9 1.4L4 19z" ${tint}/><path d="M3.5 18V7.5A2.5 2.5 0 0 1 6 5h3.2l2 2H18a2.5 2.5 0 0 1 2.5 2.5V10"/><path d="M4 19l2.5-7.6A2 2 0 0 1 8.4 10H21l-2.6 7.7a2 2 0 0 1-1.9 1.3z"/>`),
  save: ui(`<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h8.8L20 6.7v11.8a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 5 18.5z" ${tint}/><path d="M8.5 3v4.5h6V3M8 21v-6.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V21"/>`),
  camera: ui(`<path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h1.8l1.6-2.2h5.2L16.2 6H18a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" ${tint}/><circle cx="12" cy="12.8" r="3.6"/><circle cx="17.3" cy="9" r=".9" ${solid}/>`),
  audio: ui(`<path d="M3 13.5v-3M6.5 16v-8M10 18.5v-13M13.5 15v-6" /><path d="M17.5 17.2V6.5l3.5-1v3l-3.5 1" ${tint}/><ellipse cx="16" cy="17.4" rx="2" ry="1.6" ${solid}/>`),
  scan: ui(`<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="2" ${tint} stroke="none"/><path d="M7.5 10h9M7.5 12h9M7.5 14h9" stroke-width="1.1" opacity=".7"/><ellipse cx="11" cy="14.3" rx="1.5" ry="1.1" transform="rotate(-20 11 14.3)" ${solid}/><path d="M12.4 14V9" stroke-width="1.3"/>`),
  image: ui(`<rect x="3" y="4.5" width="18" height="15" rx="3" ${tint}/><circle cx="8.5" cy="9.5" r="1.7"/><path d="m21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L6 19.3"/>`),
  undo: ui('<path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: ui('<path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  play: ui(`<path d="M7.5 5.3v13.4a1 1 0 0 0 1.5.9l10.6-6.7a1 1 0 0 0 0-1.8L9 4.4a1 1 0 0 0-1.5.9z" fill="currentColor"/>`),
  pause: ui(`<rect x="6.5" y="5" width="3.6" height="14" rx="1.3" ${solid}/><rect x="13.9" y="5" width="3.6" height="14" rx="1.3" ${solid}/>`),
  stop: ui(`<rect x="6" y="6" width="12" height="12" rx="3" ${solid}/>`),
  zoomIn: ui(`<circle cx="10.5" cy="10.5" r="6.5" ${tint}/><path d="m20 20-4.6-4.6M8 10.5h5M10.5 8v5"/>`),
  zoomOut: ui(`<circle cx="10.5" cy="10.5" r="6.5" ${tint}/><path d="m20 20-4.6-4.6M8 10.5h5"/>`),
  fit: ui('<path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15"/>'),
  pageSingle: ui(`<rect x="6" y="3" width="12" height="18" rx="2.5" ${tint}/><path d="M9 8h6M9 11h6M9 14h4" stroke-width="1.3"/>`),
  pageVertical: ui(`<rect x="7" y="2.5" width="10" height="8.5" rx="2" ${tint}/><rect x="7" y="13" width="10" height="8.5" rx="2" ${tint}/>`),
  pageHorizontal: ui(`<rect x="2.5" y="7" width="8.5" height="10" rx="2" ${tint}/><rect x="13" y="7" width="8.5" height="10" rx="2" ${tint}/>`),
  pageGrid: ui(`<rect x="3.5" y="3.5" width="7" height="7" rx="2" ${tint}/><rect x="13.5" y="3.5" width="7" height="7" rx="2" ${tint}/><rect x="3.5" y="13.5" width="7" height="7" rx="2" ${tint}/><rect x="13.5" y="13.5" width="7" height="7" rx="2" ${tint}/>`),
  reflow: ui('<path d="M4 6h16M4 10.5h16M4 15h9.5a2.5 2.5 0 0 1 0 5H11"/><path d="m12.5 18.3-1.7 1.7 1.7 1.7"/>'),
  trash: ui(`<path d="M5.5 7h13l-1 12a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8z" ${tint}/><path d="M3.5 7h17M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M10 11v6M14 11v6"/>`),
  copy: ui(`<rect x="8.5" y="8.5" width="12" height="12" rx="2.8" ${tint}/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>`),
  paste: ui(`<rect x="5" y="5" width="14" height="16" rx="2.8" ${tint}/><rect x="8.5" y="3" width="7" height="4" rx="1.5"/><path d="M9 12h6M9 15.5h4"/>`),
  cut: ui('<circle cx="6.5" cy="17.5" r="2.8"/><circle cx="17.5" cy="17.5" r="2.8"/><path d="M8.6 15.7 17 4M15.4 15.7 7 4"/>'),
  settings: ui(`<path d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.2.9a1.7 1.7 0 0 0 2.5 1l.8-.5a1.7 1.7 0 0 1 2.4 2.4l-.5.8a1.7 1.7 0 0 0 1 2.5l.9.2a1.7 1.7 0 0 1 0 3.4l-.9.2a1.7 1.7 0 0 0-1 2.5l.5.8a1.7 1.7 0 0 1-2.4 2.4l-.8-.5a1.7 1.7 0 0 0-2.5 1l-.2.9a1.7 1.7 0 0 1-3.4 0l-.2-.9a1.7 1.7 0 0 0-2.5-1l-.8.5a1.7 1.7 0 0 1-2.4-2.4l.5-.8a1.7 1.7 0 0 0-1-2.5l-.9-.2a1.7 1.7 0 0 1 0-3.4l.9-.2a1.7 1.7 0 0 0 1-2.5l-.5-.8a1.7 1.7 0 0 1 2.4-2.4l.8.5a1.7 1.7 0 0 0 2.5-1z" ${tint}/><circle cx="12" cy="12" r="3"/>`),
  download: ui(`<path d="M12 3.5v11m0 0 4.2-4.2M12 14.5l-4.2-4.2"/><path d="M4 15.5v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2"/>`),
  export: ui(`<path d="M8 8.5H7A2.5 2.5 0 0 0 4.5 11v7.5A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V11A2.5 2.5 0 0 0 17 8.5h-1" ${tint}/><path d="M12 14.5V3m0 0L8.2 6.8M12 3l3.8 3.8"/>`),
  up: ui('<path d="m6 14.5 6-6 6 6"/>'),
  down: ui('<path d="m6 9.5 6 6 6-6"/>'),
  left: ui('<path d="m14.5 6-6 6 6 6"/>'),
  right: ui('<path d="m9.5 6 6 6-6 6"/>'),
  check: ui('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  close: ui('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  plus: ui('<path d="M12 5v14M5 12h14"/>'),
  minus: ui('<path d="M5 12h14"/>'),
  pencil: ui(`<path d="M4 20h4L18.6 9.4a2.8 2.8 0 0 0-4-4L4 16z" ${tint}/><path d="m13.2 6.8 4 4"/>`),
  text: ui(`<rect x="3.5" y="3.5" width="17" height="17" rx="4" ${tint} stroke="none"/><path d="M7.5 8h9M12 8v9"/>`),
  lyrics: ui(`<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" ${tint}/><path d="M8 8.5h8M8 11.5h5"/>`),
  chord: ui(`<rect x="5" y="3.5" width="14" height="17" rx="2.5" ${tint} stroke="none"/><path d="M5 7.5h14M8 3.5v17M12 3.5v17M16 3.5v17M5 12h14M5 16.5h14" stroke-width="1.2"/><circle cx="12" cy="9.8" r="1.7" ${solid}/><circle cx="16" cy="14.3" r="1.7" ${solid}/>`),
  info: ui(`<circle cx="12" cy="12" r="9" ${tint}/><path d="M12 11v5.5M12 7.8v.1"/>`),
  help: ui(`<circle cx="12" cy="12" r="9" ${tint}/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4M12 16.8v.1"/>`),
  refresh: ui('<path d="M19.5 11a7.5 7.5 0 1 0-1.4 5"/><path d="M20 4.5V10h-5.5"/>'),
  keyboard: ui(`<rect x="2.5" y="6" width="19" height="12" rx="3" ${tint}/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>`),
  piano: ui(`<rect x="3" y="4" width="18" height="16" rx="3" ${tint}/><path d="M8 20v-6M12 20v-6M16 20v-6"/><rect x="6.6" y="4" width="2.8" height="10" rx=".8" ${solid}/><rect x="10.6" y="4" width="2.8" height="10" rx=".8" ${solid} opacity="0"/><rect x="14.6" y="4" width="2.8" height="10" rx=".8" ${solid}/>`),
  palette: ui(`<rect x="3.5" y="3.5" width="7" height="7" rx="2.2" ${tint}/><rect x="13.5" y="3.5" width="7" height="7" rx="2.2" ${tint}/><rect x="3.5" y="13.5" width="7" height="7" rx="2.2" ${tint}/><path d="M17 13.8v6.4M13.8 17h6.4"/>`),
  sliders: ui(`<path d="M4 7h9M18 7h2M4 17h3M12 17h8M4 12h2.5M11 12h9"/><circle cx="15.5" cy="7" r="2.3" ${tint}/><circle cx="9.5" cy="17" r="2.3" ${tint}/><circle cx="8.8" cy="12" r="2.3" ${tint}/>`),
  score: ui(`<rect x="3.5" y="3.5" width="17" height="17" rx="4" ${tint} stroke="none"/><path d="M6 8h12M6 11h12M6 14h12M6 17h12" stroke-width="1.2"/><ellipse cx="10" cy="15.6" rx="1.8" ry="1.3" transform="rotate(-20 10 15.6)" ${solid}/><path d="M11.6 15.2V7.5" stroke-width="1.4"/>`),
  share: ui(`<path d="M8 9.5H7A2.5 2.5 0 0 0 4.5 12v6.5A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V12A2.5 2.5 0 0 0 17 9.5h-1" ${tint}/><path d="M12 15V3m0 0L8.5 6.5M12 3l3.5 3.5"/>`),
  link: ui('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1-1"/>'),
  file: ui(`<path d="M13.5 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.5z" ${tint}/><path d="M13.5 3v3.5a2 2 0 0 0 2 2H19"/>`),
  flip: ui('<path d="M12 3v18M8 7.5 4 12l4 4.5M16 7.5l4 4.5-4 4.5"/>'),
  select: ui(`<path d="M5.5 4.2 18.8 11a.8.8 0 0 1-.1 1.5l-5.5 1.6-2.3 5.3a.8.8 0 0 1-1.5-.1L5 5.1a.7.7 0 0 1 .5-.9z" ${tint}/>`),
  noteInput: ui(`<ellipse cx="7.5" cy="17.5" rx="3.2" ry="2.4" transform="rotate(-20 7.5 17.5)" ${solid}/><path d="M10.3 16.8V4.5l8 2.2"/><path d="M14 20h6M17 17v6" stroke-width="1.8"/>`),
  drum: ui(`<ellipse cx="12" cy="8" rx="8" ry="3.2" ${tint}/><path d="M4 8v8.2c0 1.8 3.6 3.3 8 3.3s8-1.5 8-3.3V8"/><path d="m5 3 7 5M19 3l-7 5"/>`),
  measure: ui(`<rect x="3" y="5" width="18" height="14" rx="3" ${tint} stroke="none"/><path d="M3 8h18M3 11h18M3 14h18M3 17h18" stroke-width="1"/><path d="M9 6.5v12M15 6.5v12" stroke-width="2"/>`),
  metronome: ui(`<path d="M9.3 3.5h5.4a1 1 0 0 1 1 .8l3 15a1.5 1.5 0 0 1-1.5 1.7H6.8a1.5 1.5 0 0 1-1.5-1.7l3-15a1 1 0 0 1 1-.8z" ${tint}/><path d="m12 16 5-9.5M7 16h10"/>`),
  update: ui(`<circle cx="12" cy="12" r="9" ${tint}/><path d="M12 7v7m0 0 3-3m-3 3-3-3M8 17h8"/>`),
  spark: ui(`<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z" ${tint}/><path d="M19 15.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3z"/>`),
  print: ui(`<path d="M7 9V4h10v5" /><rect x="3.5" y="9" width="17" height="8" rx="2.5" ${tint}/><rect x="7" y="14" width="10" height="6.5" rx="1.2"/>`),
  eye: ui(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ${tint}/><circle cx="12" cy="12" r="3"/>`),
  photo: ui(`<rect x="3" y="4.5" width="18" height="15" rx="3" ${tint}/><path d="M6.5 8.5h11M6.5 11h11M6.5 13.5h11M6.5 16h11" stroke-width="1"/><ellipse cx="10" cy="15.6" rx="1.4" ry="1" transform="rotate(-20 10 15.6)" ${solid}/>`),
  warning: ui(`<path d="M10.3 4.2a2 2 0 0 1 3.4 0l7.4 12.8a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z" ${tint}/><path d="M12 9.5v4.5M12 17v.1"/>`),
  next: ui('<path d="M5 12h13m0 0-5-5m5 5-5 5"/>'),
  sun: ui(`<circle cx="12" cy="12" r="4" ${tint}/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>`),
  moon: ui(`<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" ${tint}/>`),
  sidebarLeft: ui(`<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M9.5 4v16"/><rect x="3.8" y="4.8" width="5" height="14.4" rx="2.5" ${tint} stroke="none"/>`),
  sidebarRight: ui(`<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M14.5 4v16"/><rect x="15.2" y="4.8" width="5" height="14.4" rx="2.5" ${tint} stroke="none"/>`),
  dynamicsTool: `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="17.5" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-style="italic" font-weight="700" font-size="15" fill="currentColor">mf</text></svg>`,
  articTool: ui('<path d="M5.5 5.5 18.5 9 5.5 12.5"/><circle cx="12" cy="17.5" r="2.3" fill="currentColor" stroke="none"/>'),
  measureTool: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3.5 4v16M20.5 4v16" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><text x="12" y="11" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-weight="800" font-size="9.5">3</text><text x="12" y="20" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-weight="800" font-size="9.5">4</text></svg>`,
  slurTool: ui('<path d="M4 15.5c3.5-6 12.5-6 16 0"/><circle cx="4.5" cy="17" r="1.6" fill="currentColor" stroke="none"/><circle cx="19.5" cy="17" r="1.6" fill="currentColor" stroke="none"/>'),
  winMin: ui('<path d="M6.5 12.5h11"/>'),
  winMax: ui(`<rect x="6" y="6" width="12" height="12" rx="3.2" ${tint}/>`),
  winRestore: ui(`<rect x="5" y="8.5" width="10.5" height="10.5" rx="2.8" ${tint}/><path d="M8.5 5.5h7a3 3 0 0 1 3 3v7"/>`),
  winClose: ui('<path d="M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6"/>'),
  fullscreen: ui('<path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15"/><path d="M9.5 9.5 7 7M14.5 9.5 17 7M9.5 14.5 7 17M14.5 14.5 17 17" stroke-width="1.4"/>'),
  rotate: ui('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4.5h4.5"/>'),
  crop: ui('<path d="M6 2.5V16a2 2 0 0 0 2 2h13.5M2.5 6H16a2 2 0 0 1 2 2v13.5"/>'),
};
export function icon(name) { return ICONS[name] || ''; }
