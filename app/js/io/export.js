// Export: PNG / JPG / SVG / PDF (raster, via pdf-lib) / MIDI / MusicXML / print.
import { writeMidi } from './midi.js';

const MM_PER_IN = 25.4;

/** Render one page SVG string to a canvas at `dpi`. */
export async function rasterizePage(page, { dpi = 300, spMm = 1.75, background = '#ffffff', transparent = false } = {}) {
  const wPx = Math.round(page.width * spMm / MM_PER_IN * dpi), hPx = Math.round(page.height * spMm / MM_PER_IN * dpi);
  const svg = page.svg.replace('<svg ', `<svg width="${wPx}" height="${hPx}" `);
  const svgNoBg = transparent ? svg.replace(/<rect class="page-bg"[^>]*\/>/, '') : svg;
  const blob = new Blob([svgNoBg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas'); canvas.width = wPx; canvas.height = hPx;
    const ctx = canvas.getContext('2d');
    if (!transparent) { ctx.fillStyle = background; ctx.fillRect(0, 0, wPx, hPx); }
    ctx.drawImage(img, 0, 0, wPx, hPx);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}
function loadImage(url) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('이미지 렌더링 실패')); img.src = url; }); }
export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) { return new Promise(res => canvas.toBlob(b => res(b), type, quality)); }

export async function exportImages(layout, { format = 'png', dpi = 300, quality = 0.92, pages = null, transparent = false, onProgress = null } = {}) {
  const sel = pages || layout.pages.map((_, i) => i);
  const out = [];
  for (let k = 0; k < sel.length; k++) {
    const p = layout.pages[sel[k]];
    const canvas = await rasterizePage(p, { dpi, spMm: layout.spMm, transparent: transparent && format === 'png' });
    const blob = await canvasToBlob(canvas, format === 'jpg' ? 'image/jpeg' : 'image/png', quality);
    out.push({ index: sel[k], blob });
    onProgress?.((k + 1) / sel.length);
  }
  return out;
}

let pdfLibPromise = null;
function loadPdfLib() {
  if (globalThis.PDFLib) return Promise.resolve(globalThis.PDFLib);
  if (!pdfLibPromise) pdfLibPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = globalThis.JSE_VENDOR?.pdfLib || 'vendor/pdf-lib.min.js'; s.onload = () => res(globalThis.PDFLib); s.onerror = () => rej(new Error('PDF 라이브러리를 불러오지 못했습니다')); document.head.appendChild(s); });
  return pdfLibPromise;
}
export async function exportPdf(layout, score, { dpi = 300, pages = null, onProgress = null, jpeg = false } = {}) {
  const PDFLib = await loadPdfLib();
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(score.meta.title || 'JSE'); doc.setAuthor(score.meta.composer || ''); doc.setCreator('JSE'); doc.setProducer('JSE');
  const sel = pages || layout.pages.map((_, i) => i);
  for (let k = 0; k < sel.length; k++) {
    const p = layout.pages[sel[k]];
    const canvas = await rasterizePage(p, { dpi, spMm: layout.spMm });
    const wPt = p.width * layout.spMm / MM_PER_IN * 72, hPt = p.height * layout.spMm / MM_PER_IN * 72;
    const page = doc.addPage([wPt, hPt]);
    const blob = await canvasToBlob(canvas, jpeg ? 'image/jpeg' : 'image/png', 0.9);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = jpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    onProgress?.((k + 1) / sel.length);
  }
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
export function exportSvg(layout, pageIndex = 0) {
  const p = layout.pages[pageIndex];
  const wMm = p.width * layout.spMm, hMm = p.height * layout.spMm;
  const svg = p.svg.replace('<svg ', `<svg width="${wMm.toFixed(2)}mm" height="${hMm.toFixed(2)}mm" `);
  return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: 'image/svg+xml' });
}
export function exportMidiBlob(score) { return new Blob([writeMidi(score)], { type: 'audio/midi' }); }

export async function zipBlobs(files, JSZip = globalThis.JSZip) {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.blob);
  return zip.generateAsync({ type: 'blob' });
}
export function safeFileName(name, ext) {
  const base = (name || 'score').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'score';
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}
export function printLayout(layout) {
  const w = window.open('', '_blank');
  if (!w) return false;
  const pages = layout.pages.map(p => `<div class="pg">${p.svg}</div>`).join('');
  const wMm = layout.pages[0].width * layout.spMm, hMm = layout.pages[0].height * layout.spMm;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>인쇄</title><style>@page{size:${wMm}mm ${hMm}mm;margin:0}body{margin:0}.pg{width:${wMm}mm;height:${hMm}mm;page-break-after:always;overflow:hidden}.pg svg{width:100%;height:100%;display:block}</style></head><body>${pages}<script>setTimeout(()=>{window.print();},300)</script></body></html>`);
  w.document.close();
  return true;
}
