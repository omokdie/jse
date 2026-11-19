// Export dialog: PDF / PNG / JPG / SVG · other notation programs (MuseScore, NWC, Sibelius, Finale, MusicXML) · MIDI / .ssnap
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { exportImages, exportPdf, exportSvg, exportMidiBlob, zipBlobs } from '../io/export.js';
import { safeFileName, defaultFileBase, fileBaseFromInput, cleanFileBase, hasBadFileChars, exportNameSuffix, savedFileLabel, BAD_CHARS_TEXT } from '../io/filename.js';
import { writeSsnap } from '../io/ssnap.js';
import { escapeXml } from '../engrave/text.js';
import { saveBlob, shareBlob, isMobileLayout, saveDestination, saveDestinationText } from '../native.js';

const XML_VARIANTS = [
  { id: 'musicxml', label: '.musicxml', ext: '.musicxml', mime: 'application/vnd.recordare.musicxml+xml' },
  { id: 'mxl', label: '.mxl (압축)', ext: '.mxl', mime: 'application/vnd.recordare.musicxml' },
];
const GROUPS = [['print', '인쇄 · 이미지'], ['apps', '다른 악보 프로그램'], ['other', '소리 · JSE']];
/** `variants` = file types of one target program (first = default); `hint` explains how to open the file there. */
const FORMATS = [
  { id: 'pdf', group: 'print', name: 'PDF', desc: '인쇄·공유용', icon: 'export', mime: 'application/pdf', ext: '.pdf', pages: true, dpi: true },
  { id: 'png', group: 'print', name: 'PNG', desc: '고화질 이미지', icon: 'image', mime: 'image/png', ext: '.png', pages: true, dpi: true },
  { id: 'jpg', group: 'print', name: 'JPG', desc: '작은 용량 이미지', icon: 'image', mime: 'image/jpeg', ext: '.jpg', pages: true, dpi: true },
  { id: 'svg', group: 'print', name: 'SVG', desc: '벡터(확대해도 선명)', icon: 'image', mime: 'image/svg+xml', ext: '.svg', pages: true },
  { id: 'musescore', group: 'apps', name: 'MuseScore', desc: '.mscz', icon: 'file',
    variants: [{ id: 'mscz', label: '.mscz', ext: '.mscz', mime: 'application/x-musescore' }, { id: 'mscx', label: '.mscx (압축 안 함)', ext: '.mscx', mime: 'application/x-musescore+xml' }],
    hint: 'MuseScore 3과 4에서 바로 열립니다.' },
  { id: 'nwc', group: 'apps', name: 'NWC', desc: '.nwc · .nwctxt', icon: 'file',
    variants: [
      { id: 'nwc', label: '.nwc (2.75)', ext: '.nwc', mime: 'application/x-nwc' },
      { id: 'nwctxt', label: '.nwctxt (텍스트)', ext: '.nwctxt', mime: 'text/x-nwctxt' },
      { id: 'nwc175', label: '.nwc (1.75 · 실험적)', ext: '.nwc', mime: 'application/x-nwc',
        hint: '옛 NoteWorthy Composer 1.75용 형식입니다 (<b>실험적</b> — 실제 NWC 1.75에서 여는 것까지는 확인하지 못했습니다). 한글은 그 시절 방식(CP949)으로 저장하고, 1.75에 없는 표기(크레셴도 선 등)는 빠집니다. 열리지 않으면 <b>.nwc (2.75)</b>나 <b>.nwctxt</b>로 저장해 보세요.' },
    ],
    hint: 'NoteWorthy Composer 2.75에서 <b>파일 → 열기</b>로 엽니다. NWC에 없는 표기(셋잇단 외 잇단음표 등)는 가장 가까운 표기로 바뀝니다.' },
  { id: 'sibelius', group: 'apps', name: 'Sibelius', desc: 'MusicXML', icon: 'file', variants: XML_VARIANTS,
    hint: 'Sibelius 자체 형식(.sib)은 비공개라 다른 프로그램이 만들 수 없습니다. 대신 Sibelius가 바로 여는 MusicXML로 저장합니다 — Sibelius에서 <b>파일 → 열기</b>로 이 파일을 고르세요.' },
  { id: 'finale', group: 'apps', name: 'Finale', desc: '.musx · MusicXML', icon: 'file',
    variants: [
      { id: 'musx', label: '.musx (실험적)', ext: '.musx', mime: 'application/vnd.makemusic.notation',
        hint: 'Finale 자체 형식으로 저장합니다 (<b>실험적</b> — Finale이 쓰는 파일 구조를 그대로 따라 만들었지만, 실제 Finale에서 열어 보는 것까지는 확인하지 못했습니다). Finale에서 <b>파일 → 열기</b>로 엽니다. 열리지 않으면 <b>.musicxml</b>로 저장해 Finale의 <b>파일 → 가져오기 → MusicXML</b>로 여세요.' },
      ...XML_VARIANTS.map(v => ({ ...v, hint: 'Finale에서 <b>파일 → 가져오기 → MusicXML</b>로 엽니다. 가장 확실한 방법입니다.' })),
    ],
    hint: 'Finale에서 <b>파일 → 가져오기 → MusicXML</b>로 엽니다.' },
  { id: 'musicxml', group: 'apps', name: 'MusicXML', desc: '그 밖의 프로그램', icon: 'file', variants: XML_VARIANTS,
    hint: '거의 모든 악보 프로그램이 읽는 공통 형식입니다.' },
  { id: 'midi', group: 'other', name: 'MIDI', desc: '연주 데이터', icon: 'piano', mime: 'audio/midi', ext: '.mid' },
  { id: 'ssnap', group: 'other', name: 'JSE', desc: '.ssnap 원본', icon: 'save', mime: 'application/x-scoresnap', ext: '.ssnap' },
];
/** Old format ids used by menus and settings → { format, variant }. */
const ALIASES = { mxl: ['musicxml', 'mxl'], mscz: ['musescore', 'mscz'], mscx: ['musescore', 'mscx'], nwctxt: ['nwc', 'nwctxt'], nwc175: ['nwc', 'nwc175'], musx: ['finale', 'musx'], finale: ['finale', 'musicxml'] };   // 'finale' (menus, settings) = MusicXML for Finale, as before 1.2

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

async function musicXmlBlob(score, variant) {
  const mx = await import('../io/musicxml.js');
  if (variant.id !== 'mxl') return new Blob([mx.exportMusicXML(score)], { type: variant.mime });
  const out = await mx.exportMXL(score);
  return out instanceof Blob ? out : new Blob([out], { type: variant.mime });
}

export async function exportDialog(app, ui, initial = null) {
  const st = app.settings || {};
  initial = initial || st.exportFormat || 'pdf';
  const [fid, vid] = ALIASES[initial] || [initial, null];
  let fmt = FORMATS.find(f => f.id === fid) || FORMATS[0];
  let variant = fmt.variants ? (fmt.variants.find(v => v.id === vid) || fmt.variants[0]) : null;
  const defDpi = [150, 300, 600].includes(+st.exportDpi) ? +st.exportDpi : 300;
  const pageCount = app.layout.pages.length;
  // the name the field starts with: the one last chosen for this document, else its file name, else its title
  const startBase = defaultFileBase({ lastName: app.exportName, fileName: app.fileName, title: app.score.meta.title });
  const dest = saveDestination();
  const card = f => `<button class="card ${f.id === fmt.id ? 'on' : ''}" data-f="${f.id}">${icon(f.icon)}<b>${f.name}</b><span>${f.desc}</span></button>`;
  // compact cards so that every target and the options fit without much scrolling (3 per row, names only, on phones)
  const css = `<style>
    .exdlg .cards { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
    .exdlg .card { min-height: 0; padding: 8px 10px; gap: 2px; }
    .exdlg .card svg { width: 20px; height: 20px; margin-bottom: 0; }
    .exdlg .card span { font-size: 10.5px; line-height: 1.25; }
    .exdlg h4 { margin: 10px 0 5px; }
    html.phone .exdlg .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    html.phone .exdlg .cards.g-print { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    html.phone .exdlg .card span { display: none; }
  </style>`;
  const body = `${css}<div class="exdlg">
    ${GROUPS.map(([g, title]) => `<h4>${title}</h4><div class="cards fmt-cards g-${g}">${FORMATS.filter(f => f.group === g).map(card).join('')}</div>`).join('')}
    <h4><label for="ex-name">파일 이름</label></h4>
    <div class="name-field"><input type="text" id="ex-name" value="${escapeXml(startBase)}" spellcheck="false" autocomplete="off" autocapitalize="off" enterkeyhint="done" maxlength="160" aria-describedby="ex-name-note"><span class="name-ext" id="ex-ext"></span></div>
    <p class="name-note" id="ex-name-note" hidden></p>
    <div id="ex-opts">
      <h4>옵션</h4>
      <div class="row" data-for="variant"><label>파일 형식</label><div class="ctl"><div class="seg-btns" id="ex-variant"></div></div></div>
      <div class="row" data-for="pages"><label>페이지</label><div class="ctl"><select id="ex-range"><option value="all">전체 (${pageCount}쪽)</option><option value="current">현재 페이지 (${app.currentPage + 1})</option><option value="custom">직접 지정</option></select><input type="text" id="ex-custom" placeholder="예: 1-3, 5" style="width:120px" hidden></div></div>
      <div class="row" data-for="dpi"><label>해상도</label><div class="ctl"><div class="seg-btns" id="ex-dpi">${[150, 300, 600].map(d => `<button data-v="${d}" class="${d === defDpi ? 'on' : ''}">${d} dpi</button>`).join('')}</div></div></div>
      <div class="row" data-for="jpg"><label>JPG 품질</label><div class="ctl"><input type="range" id="ex-q" min="50" max="100" value="90"><span id="ex-qv">90</span></div></div>
      <div class="row" data-for="png"><label></label><div class="ctl"><label class="checkbox"><input type="checkbox" id="ex-transparent"> 투명 배경</label></div></div>
      <div class="row" data-for="multi"><label></label><div class="ctl"><label class="checkbox"><input type="checkbox" id="ex-zip" checked> 여러 페이지는 ZIP 하나로 묶기</label></div></div>
      <p id="ex-hint" style="margin:8px 0 0;color:var(--muted);line-height:1.55" hidden></p>
      <div class="progress" id="ex-prog" hidden><div></div></div>
    </div></div>`;
  const sync = root => {
    root.querySelectorAll('[data-f]').forEach(c => c.classList.toggle('on', c.dataset.f === fmt.id));
    const vs = fmt.variants || [];
    root.querySelector('[data-for=variant]').hidden = vs.length < 2;
    root.querySelector('#ex-variant').innerHTML = vs.map(v => `<button data-v="${v.id}" class="${v === variant ? 'on' : ''}">${v.label}</button>`).join('');
    root.querySelectorAll('#ex-variant button').forEach(b => b.addEventListener('click', () => { variant = vs.find(v => v.id === b.dataset.v); sync(root); }));
    root.querySelector('[data-for=pages]').hidden = !fmt.pages;
    root.querySelector('[data-for=dpi]').hidden = !fmt.dpi;
    root.querySelector('[data-for=jpg]').hidden = fmt.id !== 'jpg';
    root.querySelector('[data-for=png]').hidden = fmt.id !== 'png';
    root.querySelector('[data-for=multi]').hidden = !(fmt.pages && fmt.id !== 'pdf' && pageCount > 1);
    const hintText = variant?.hint || fmt.hint || '';
    const hint = root.querySelector('#ex-hint'); hint.hidden = !hintText; hint.innerHTML = hintText;
    syncName(root);
  };
  // how many files the export writes (pages of PNG/JPG/SVG without ZIP → one file per page)
  const outCount = root => {
    if (!fmt.pages || fmt.id === 'pdf') return 1;
    const sel = root.querySelector('#ex-range').value;
    if (sel === 'current') return 1;
    if (sel === 'custom') return parseRange(root.querySelector('#ex-custom').value, pageCount).length || 1;
    return pageCount;
  };
  // the extension after the name field follows the format, and a note says what happens to the typed name
  const syncName = root => {
    const count = outCount(root), zip = root.querySelector('#ex-zip').checked;
    root.querySelector('#ex-ext').textContent = exportNameSuffix(variant?.ext || fmt.ext, { count, zip });
    const typed = root.querySelector('#ex-name').value;
    let msg = '', warn = false;
    if (hasBadFileChars(typed)) { msg = `파일 이름에 쓸 수 없는 글자(${BAD_CHARS_TEXT})는 _ 로 바꿔 저장합니다.`; warn = true; }
    else if (!cleanFileBase(typed)) msg = `이름을 비워 두면 "${startBase}"(으)로 저장합니다.`;
    else if (dest === 'android') msg = `저장 위치: ${saveDestinationText(dest)} · 같은 이름의 파일이 있으면 이름 뒤에 번호가 붙습니다.`;
    else if (dest === 'download') msg = `저장 위치: ${saveDestinationText(dest)}`;
    const note = root.querySelector('#ex-name-note');
    note.hidden = !msg; note.textContent = msg; note.classList.toggle('warn', warn);
  };
  const buttons = [{ label: '취소', value: null }];
  if (isMobileLayout() && navigator.share) buttons.push({ label: '공유', value: r => ({ share: true, root: r }) });
  buttons.push({ label: '내보내기', primary: true, value: r => ({ share: false, root: r }) });
  // keyboard/mouse: start in the name field (type to rename, Enter to export); touch: focus nothing, so no keyboard pops up
  const initialFocus = document.documentElement.classList.contains('touch') ? false : '#ex-name';
  const res = await showDialog({ title: '내보내기', body, wide: false, buttons, initialFocus, onOpen: root => {
    sync(root);
    root.querySelectorAll('[data-f]').forEach(c => c.addEventListener('click', () => { fmt = FORMATS.find(f => f.id === c.dataset.f); variant = fmt.variants ? fmt.variants[0] : null; sync(root); }));
    root.querySelector('#ex-range').addEventListener('change', e => { root.querySelector('#ex-custom').hidden = e.target.value !== 'custom'; syncName(root); });
    root.querySelector('#ex-custom').addEventListener('input', () => syncName(root));
    root.querySelector('#ex-zip').addEventListener('change', () => syncName(root));
    const nameInput = root.querySelector('#ex-name');
    nameInput.addEventListener('input', () => syncName(root));
    // the first tap/click selects the whole name, so typing replaces it (a second click places the caret)
    nameInput.addEventListener('focus', () => { if (nameInput.dataset.picked) return; nameInput.dataset.picked = '1'; setTimeout(() => nameInput.select(), 0); });
    root.querySelectorAll('#ex-dpi button').forEach(b => b.addEventListener('click', () => root.querySelectorAll('#ex-dpi button').forEach(x => x.classList.toggle('on', x === b))));
    root.querySelector('#ex-q').addEventListener('input', e => { root.querySelector('#ex-qv').textContent = e.target.value; });
    root.querySelector('.card.on')?.scrollIntoView({ block: 'nearest' });
  } });
  if (!res) return;
  const r = res.root;
  const rangeSel = r.querySelector('#ex-range').value;
  const pages = rangeSel === 'all' ? null : rangeSel === 'current' ? [app.currentPage] : parseRange(r.querySelector('#ex-custom').value, pageCount);
  const dpi = +(r.querySelector('#ex-dpi button.on')?.dataset.v || 300);
  const quality = +r.querySelector('#ex-q').value / 100;
  const transparent = r.querySelector('#ex-transparent').checked;
  const zip = r.querySelector('#ex-zip').checked;
  const base = fileBaseFromInput(r.querySelector('#ex-name').value, startBase);
  const ext = variant?.ext || fmt.ext, mime = variant?.mime || fmt.mime;
  const busy = ui.toast(`${fmt.name} 파일 만드는 중…`, 'info', { timeout: 0 });
  try {
    const layout = app.viewMode === 'reflow' ? (await import('../engrave/render.js')).engrave(app.score) : app.layout;
    let blob, name = safeFileName(base, ext), files = null;
    const warnings = [];   // what the target program's format cannot express
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
      case 'musescore': {
        const m = await import('../io/mscz.js');
        blob = variant.id === 'mscx' ? new Blob([m.exportMscx(app.score, { warnings })], { type: mime }) : new Blob([await m.exportMscz(app.score, { warnings })], { type: mime });
        break;
      }
      case 'nwc': {
        const m = await import('../io/nwc.js');
        blob = variant.id === 'nwctxt' ? new Blob([m.exportNwctxt(app.score, { warnings })], { type: mime })
          : new Blob([await m.exportNwc(app.score, variant.id === 'nwc175' ? { version: '1.75', warnings } : { warnings })], { type: mime });
        break;
      }
      case 'finale':
        if (variant.id === 'musx') { const m = await import('../io/musx-write.js'); blob = new Blob([await m.exportMusx(app.score, { warnings })], { type: mime }); }
        else blob = await musicXmlBlob(app.score, variant);
        break;
      case 'sibelius': case 'musicxml': blob = await musicXmlBlob(app.score, variant); break;
      case 'midi': blob = exportMidiBlob(app.score); break;
      case 'ssnap': blob = await writeSsnap(app.score, { thumbnailBlob: await ui.thumbnail(), appVersion: ui.version }); break;
    }
    busy.remove();
    const list = files || [{ name, blob }];
    if (res.share) { const ok = await shareBlob(list[0].blob, list[0].name, app.score.meta.title).catch(() => false); if (ok) { app.exportName = base; ui.toast('공유했습니다', 'ok'); return; } }
    let out = null;
    for (const f of list) { out = await saveBlob(f.blob, f.name, { mime: f.blob.type || mime, suggestDialog: list.length === 1 }); if (!out) return; }
    app.exportName = base;   // the next export of this document starts with the same name
    const what = fmt.group === 'apps' && fmt.id !== 'musicxml' ? `${fmt.name}용 파일로` : `${fmt.name}로`;
    const where = list.length > 1 ? (dest === 'android' ? `${saveDestinationText(dest)}에 ${list.length}개 파일` : `${list.length}개 파일`) : savedFileLabel(out, list[0].name);
    ui.toast(`${what} 내보냈습니다 — ${where}${warnings.length ? ` · 참고: ${warnings.slice(0, 2).join(' · ')}${warnings.length > 2 ? ` 외 ${warnings.length - 2}건` : ''}` : ''}`, 'ok', { timeout: warnings.length ? 9000 : 3600 });
  } catch (e) { busy.remove(); console.error(e); ui.toast('내보내기 실패: ' + e.message, 'error', { timeout: 6000 }); }
}
