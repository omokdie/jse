// Export dialog: PDF / PNG / JPG / SVG / MusicXML / MXL / MIDI / .ssnap
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { exportImages, exportPdf, exportSvg, exportMidiBlob, zipBlobs, safeFileName } from '../io/export.js';
import { writeSsnap } from '../io/ssnap.js';
import { saveBlob, shareBlob, isMobileLayout } from '../native.js';

const FORMATS = [
  { id: 'pdf', name: 'PDF', desc: '인쇄·공유용', icon: 'export', mime: 'application/pdf', ext: '.pdf', pages: true, dpi: true },
  { id: 'png', name: 'PNG', desc: '고화질 이미지', icon: 'image', mime: 'image/png', ext: '.png', pages: true, dpi: true },
  { id: 'jpg', name: 'JPG', desc: '작은 용량 이미지', icon: 'image', mime: 'image/jpeg', ext: '.jpg', pages: true, dpi: true },
  { id: 'svg', name: 'SVG', desc: '벡터(확대해도 선명)', icon: 'image', mime: 'image/svg+xml', ext: '.svg', pages: true },
  { id: 'musicxml', name: 'MusicXML', desc: 'MuseScore·Finale·Sibelius 등', icon: 'file', mime: 'application/vnd.recordare.musicxml+xml', ext: '.musicxml' },
  { id: 'mxl', name: 'MXL', desc: '압축 MusicXML', icon: 'file', mime: 'application/vnd.recordare.musicxml', ext: '.mxl' },
  { id: 'midi', name: 'MIDI', desc: '연주 데이터', icon: 'piano', mime: 'audio/midi', ext: '.mid' },
  { id: 'ssnap', name: 'JSE', desc: '.ssnap (편집 가능, 원본 사진 포함)', icon: 'save', mime: 'application/x-scoresnap', ext: '.ssnap' },
];

function parseRange(text, count) {
  if (!text.trim()) return [...Array(count).keys()];
  const out = new Set();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part); if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

export async function exportDialog(app, ui, initial = 'pdf') {
  let fmt = FORMATS.find(f => f.id === initial) || FORMATS[0];
  const pageCount = app.layout.pages.length;
  const body = `
    <div class="cards fmt-cards">${FORMATS.map(f => `<button class="card ${f.id === fmt.id ? 'on' : ''}" data-f="${f.id}">${icon(f.icon)}<b>${f.name}</b><span>${f.desc}</span></button>`).join('')}</div>
    <div id="ex-opts">
      <h4>옵션</h4>
      <div class="row" data-for="pages"><label>페이지</label><div class="ctl"><select id="ex-range"><option value="all">전체 (${pageCount}쪽)</option><option value="current">현재 페이지 (${app.currentPage + 1})</option><option value="custom">직접 지정</option></select><input type="text" id="ex-custom" placeholder="예: 1-3, 5" style="width:120px" hidden></div></div>
      <div class="row" data-for="dpi"><label>해상도</label><div class="ctl"><div class="seg-btns" id="ex-dpi">${[150, 300, 600].map(d => `<button data-v="${d}" class="${d === 300 ? 'on' : ''}">${d} dpi</button>`).join('')}</div></div></div>
      <div class="row" data-for="jpg"><label>JPG 품질</label><div class="ctl"><input type="range" id="ex-q" min="50" max="100" value="90"><span id="ex-qv">90</span></div></div>
      <div class="row" data-for="png"><label></label><div class="ctl"><label class="checkbox"><input type="checkbox" id="ex-transparent"> 투명 배경</label></div></div>
      <div class="row" data-for="multi"><label></label><div class="ctl"><label class="checkbox"><input type="checkbox" id="ex-zip" checked> 여러 페이지는 ZIP 하나로 묶기</label></div></div>
      <div class="row"><label>파일 이름</label><div class="ctl"><input type="text" id="ex-name" value="${(app.score.meta.title || 'score').replace(/"/g, '')}"></div></div>
      <div class="progress" id="ex-prog" hidden><div></div></div>
    </div>`;
  const sync = root => {
    root.querySelectorAll('[data-f]').forEach(c => c.classList.toggle('on', c.dataset.f === fmt.id));
    root.querySelector('[data-for=pages]').hidden = !fmt.pages;
    root.querySelector('[data-for=dpi]').hidden = !fmt.dpi;
    root.querySelector('[data-for=jpg]').hidden = fmt.id !== 'jpg';
    root.querySelector('[data-for=png]').hidden = fmt.id !== 'png';
    root.querySelector('[data-for=multi]').hidden = !(fmt.pages && fmt.id !== 'pdf' && pageCount > 1);
  };
  const buttons = [{ label: '취소', value: null }];
  if (isMobileLayout() && navigator.share) buttons.push({ label: '공유', value: r => ({ share: true, root: r }) });
  buttons.push({ label: '내보내기', primary: true, value: r => ({ share: false, root: r }) });
  const res = await showDialog({ title: '내보내기', body, wide: false, buttons, onOpen: root => {
    sync(root);
    root.querySelectorAll('[data-f]').forEach(c => c.addEventListener('click', () => { fmt = FORMATS.find(f => f.id === c.dataset.f); sync(root); }));
    root.querySelector('#ex-range').addEventListener('change', e => { root.querySelector('#ex-custom').hidden = e.target.value !== 'custom'; });
    root.querySelectorAll('#ex-dpi button').forEach(b => b.addEventListener('click', () => root.querySelectorAll('#ex-dpi button').forEach(x => x.classList.toggle('on', x === b))));
    root.querySelector('#ex-q').addEventListener('input', e => { root.querySelector('#ex-qv').textContent = e.target.value; });
  } });
  if (!res) return;
  const r = res.root;
  const rangeSel = r.querySelector('#ex-range').value;
  const pages = rangeSel === 'all' ? null : rangeSel === 'current' ? [app.currentPage] : parseRange(r.querySelector('#ex-custom').value, pageCount);
  const dpi = +(r.querySelector('#ex-dpi button.on')?.dataset.v || 300);
  const quality = +r.querySelector('#ex-q').value / 100;
  const transparent = r.querySelector('#ex-transparent').checked;
  const zip = r.querySelector('#ex-zip').checked;
  const base = r.querySelector('#ex-name').value || 'score';
  const busy = ui.toast(`${fmt.name} 만드는 중…`, 'info', { timeout: 0 });
  try {
    const layout = app.viewMode === 'reflow' ? (await import('../engrave/render.js')).engrave(app.score) : app.layout;
    let blob, name = safeFileName(base, fmt.ext), files = null;
    switch (fmt.id) {
      case 'pdf': blob = await exportPdf(layout, app.score, { dpi, pages }); break;
      case 'png': case 'jpg': {
        const imgs = await exportImages(layout, { format: fmt.id, dpi, quality, pages, transparent });
        if (imgs.length === 1) blob = imgs[0].blob;
        else if (zip) { blob = await zipBlobs(imgs.map(i => ({ name: safeFileName(`${base}-${i.index + 1}`, fmt.ext), blob: i.blob }))); name = safeFileName(base, '.zip'); }
        else files = imgs.map(i => ({ name: safeFileName(`${base}-${i.index + 1}`, fmt.ext), blob: i.blob }));
        break;
      }
      case 'svg': {
        const sel = pages || layout.pages.map((_, i) => i);
        if (sel.length === 1) blob = exportSvg(layout, sel[0]);
        else if (zip) { blob = await zipBlobs(sel.map(i => ({ name: safeFileName(`${base}-${i + 1}`, '.svg'), blob: exportSvg(layout, i) }))); name = safeFileName(base, '.zip'); }
        else files = sel.map(i => ({ name: safeFileName(`${base}-${i + 1}`, '.svg'), blob: exportSvg(layout, i) }));
        break;
      }
      case 'musicxml': { const mx = await import('../io/musicxml.js'); blob = new Blob([mx.exportMusicXML(app.score)], { type: fmt.mime }); break; }
      case 'mxl': {
        const mx = await import('../io/musicxml.js');
        if (mx.exportMXL) { const out = await mx.exportMXL(app.score); blob = out instanceof Blob ? out : new Blob([out], { type: fmt.mime }); }
        else {
          const Z = new globalThis.JSZip(); Z.file('mimetype', 'application/vnd.recordare.musicxml', { compression: 'STORE' });
          Z.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>');
          Z.file('score.musicxml', mx.exportMusicXML(app.score)); blob = await Z.generateAsync({ type: 'blob', mimeType: fmt.mime, compression: 'DEFLATE' });
        }
        break;
      }
      case 'midi': blob = exportMidiBlob(app.score); break;
      case 'ssnap': blob = await writeSsnap(app.score, { thumbnailBlob: await ui.thumbnail(), appVersion: ui.version }); break;
    }
    busy.remove();
    const list = files || [{ name, blob }];
    if (res.share) { const ok = await shareBlob(list[0].blob, list[0].name, app.score.meta.title).catch(() => false); if (ok) { ui.toast('공유했습니다', 'ok'); return; } }
    for (const f of list) { const out = await saveBlob(f.blob, f.name, { mime: f.blob.type || fmt.mime, suggestDialog: list.length === 1 }); if (!out) return; }
    ui.toast(`${fmt.name}로 내보냈습니다 — ${list.length > 1 ? list.length + '개 파일' : list[0].name}`, 'ok');
  } catch (e) { busy.remove(); console.error(e); ui.toast('내보내기 실패: ' + e.message, 'error', { timeout: 6000 }); }
}
