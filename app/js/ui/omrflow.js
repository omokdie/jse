// Scan flow: pick photo/PDF → prepare (rotate, options) → recognize in a worker → review side by side → apply.
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { pickFiles, isMobileLayout } from '../native.js';
import { engrave } from '../engrave/render.js';
import { totalStaffCount, effectiveTimeSig, effectiveKeySig, validateScore, KEY_NAMES } from '../model/score.js';
import { escapeXml } from '../engrave/text.js';

const MAX_SIDE = 3200;

// ---------- image helpers ----------
async function blobToBitmap(blob) {
  if ('createImageBitmap' in window) { try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall through */ } }
  const url = URL.createObjectURL(blob);
  try { return await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('이미지를 읽을 수 없습니다 (지원하지 않는 형식일 수 있습니다)')); img.src = url; }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
/** Draw a page source (bitmap) rotated by `rot` quarter turns and scaled to MAX_SIDE → canvas. */
function toCanvas(bmp, rot = 0) {
  const w0 = bmp.width, h0 = bmp.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const swap = rot % 2 === 1;
  const c = document.createElement('canvas'); c.width = swap ? h : w; c.height = swap ? w : h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rot * Math.PI / 2); ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
  return c;
}
let pdfjsP = null;
async function pdfPages(blob, onPage) {
  const V = globalThis.JSE_VENDOR || {};
  if (!pdfjsP) pdfjsP = import(V.pdfjs || new URL('../../vendor/pdfjs/pdf.min.mjs', import.meta.url).href).then(m => { m.GlobalWorkerOptions.workerSrc = V.pdfjsWorker || new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href; return m; });
  const pdfjs = await pdfjsP;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2400 / Math.max(vp0.width, vp0.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(c); onPage?.(i, doc.numPages);
  }
  return out;
}

// ---------- recognition (worker with main-thread fallback) ----------
let worker = null, seq = 0;
function getWorker() {
  if (worker) return worker;
  try { worker = new Worker(new URL('../omr/worker.js', import.meta.url), { type: 'module' }); } catch { worker = null; }
  return worker;
}
function recognizeCanvas(canvas, options, onProgress) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const w = getWorker();
  if (!w) return import('../omr/omr.js').then(m => m.recognize({ width: img.width, height: img.height, data: img.data }, options, onProgress));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMsg = e => {
      const d = e.data; if (d.id !== id) return;
      if (d.type === 'progress') onProgress(d);
      else { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); d.type === 'result' ? resolve(d.result) : reject(new Error(d.message)); }
    };
    const onErr = e => { w.removeEventListener('message', onMsg); worker = null; w.terminate(); import('../omr/omr.js').then(m => m.recognize({ width: img.width, height: img.height, data: img.data }, options, onProgress)).then(resolve, reject); e.preventDefault?.(); };
    w.addEventListener('message', onMsg); w.addEventListener('error', onErr);
    w.postMessage({ id, image: { width: img.width, height: img.height, data: img.data.buffer }, options }, [img.data.buffer]);
  });
}
export function cancelRecognition() { if (worker) { worker.terminate(); worker = null; } }

/** Merge several page results into one score (measures appended; sources renumbered). */
function mergeResults(results) {
  const base = results[0].score;
  results.forEach((r, k) => {
    const sid = `src${k + 1}`;
    const s = r.score;
    s.sources.forEach(src => { src.id = sid; src.file = `sources/${sid}.jpg`; src.mime = 'image/jpeg'; src.blob = r._blob; src.name = r._name || src.name; src.width = r._w; src.height = r._h; });
    s.measures.forEach(m => { if (m.source) m.source.sourceId = sid; });
    if (k === 0) return;
    if (totalStaffCount(s) !== totalStaffCount(base)) { r._skipped = true; return; }
    const prevTs = effectiveTimeSig(base, base.measures.length - 1), prevKs = effectiveKeySig(base, base.measures.length - 1);
    const first = s.measures[0];
    if (first.timeSig && first.timeSig.num === prevTs.num && first.timeSig.den === prevTs.den) delete first.timeSig;
    if (first.keySig && first.keySig.fifths === prevKs.fifths) delete first.keySig;
    if (first.tempo && !first.tempo.text) delete first.tempo;
    first.staves.forEach((sm, si) => { if (!sm.clef) sm.clef = s.parts.flatMap(p => p.staves)[si]?.clef; });
    base.measures.push(...s.measures);
    base.sources.push(...s.sources);
    base.spanners.push(...(s.spanners || []));
  });
  validateScore(base, { repair: true });
  return base;
}

// ---------- dialog ----------
export async function scanDialog(app, ui, { files = null } = {}) {
  const pages = [];   // { name, canvas, rot, srcCanvas }
  let dlgRoot = null, closeDlg = null;
  const addFiles = async list => {
    for (const f of list) {
      try {
        const isPdf = /pdf$/i.test(f.blob.type) || /\.pdf$/i.test(f.name);
        if (isPdf) { ui.toast('PDF 페이지를 불러오는 중…', 'info'); const cs = await pdfPages(f.blob); cs.forEach((c, i) => pages.push({ name: `${f.name} p${i + 1}`, src: c, rot: 0 })); }
        else { const bmp = await blobToBitmap(f.blob); pages.push({ name: f.name, src: bmp, rot: 0 }); }
      } catch (e) { ui.toast(`${f.name}: ${e.message}`, 'error', { timeout: 5000 }); }
    }
    renderPrep();
  };
  const body = `
    <div id="scan-step1">
      <div class="drop-zone" id="scan-drop"><div class="big">${icon('scan')}<br>악보 사진이나 PDF를 여기에 끌어다 놓으세요</div><div>또는 아래에서 선택 · 이미지를 복사해 붙여넣기(Ctrl+V)도 됩니다</div>
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-a="camera">${icon('camera')} 카메라로 촬영</button><button class="btn" data-a="pick">${icon('image')} 사진·PDF 선택</button><button class="btn" data-a="url">${icon('link')} 이미지 주소</button></div></div>
      <div class="photo-tips">
        <div><b>평평하게</b>종이가 휘지 않게 펴고 바로 위에서 찍으세요</div>
        <div><b>밝고 고르게</b>그림자·반사 없이 밝은 곳에서</div>
        <div><b>꽉 차게</b>악보가 화면을 가득 채우도록</div>
        <div><b>선명하게</b>흔들림 없이, 초점을 맞춰서</div>
      </div>
    </div>
    <div id="scan-step2" hidden>
      <div class="scan-pages" id="scan-pages"></div>
      <div class="grid-2" style="margin-top:8px">
        <div class="row"><label>악보 종류</label><div class="ctl"><select id="scan-parts"><option value="auto">자동 감지</option><option value="1">한 줄 악보 (멜로디)</option><option value="2">피아노 (큰보표)</option></select></div></div>
        <div class="row"><label>박자</label><div class="ctl"><select id="scan-ts"><option value="">자동 감지</option>${['4/4', '3/4', '2/4', '6/8', '2/2', '3/8', '12/8'].map(t => `<option>${t}</option>`).join('')}</select></div></div>
        <div class="row"><label>조성</label><div class="ctl"><select id="scan-key"><option value="">자동 감지</option>${[...Array(15).keys()].map(i => i - 7).map(f => `<option value="${f}">${KEY_NAMES[f]} 장조</option>`).join('')}</select></div></div>
        <div class="row"><label>제목</label><div class="ctl"><input type="text" id="scan-title" placeholder="(선택)"></div></div>
      </div>
    </div>
    <div id="scan-step3" hidden>
      <p id="scan-msg">인식 준비 중…</p><div class="progress"><div id="scan-bar"></div></div>
    </div>
    <div id="scan-step4" hidden></div>`;
  const renderPrep = () => {
    if (!dlgRoot) return;
    dlgRoot.querySelector('#scan-step1').hidden = pages.length > 0;
    dlgRoot.querySelector('#scan-step2').hidden = pages.length === 0;
    dlgRoot.querySelector('[data-b=run]').hidden = pages.length === 0;
    dlgRoot.querySelector('[data-b=more]').hidden = pages.length === 0;
    const host = dlgRoot.querySelector('#scan-pages');
    host.innerHTML = '';
    pages.forEach((p, i) => {
      const c = toCanvas(p.src, p.rot); p.canvas = c;
      const card = document.createElement('div'); card.className = 'scan-page';
      const thumb = document.createElement('canvas'); const s = 180 / Math.max(c.width, c.height); thumb.width = Math.round(c.width * s); thumb.height = Math.round(c.height * s); thumb.getContext('2d').drawImage(c, 0, 0, thumb.width, thumb.height);
      card.appendChild(thumb);
      const ctr = document.createElement('div'); ctr.className = 'scan-page-ctl';
      ctr.innerHTML = `<span>${i + 1}쪽</span><button class="btn sm" data-r title="90° 회전">${icon('rotate')}</button><button class="btn sm" data-d title="빼기">${icon('close')}</button>`;
      ctr.querySelector('[data-r]').addEventListener('click', () => { p.rot = (p.rot + 1) % 4; renderPrep(); });
      ctr.querySelector('[data-d]').addEventListener('click', () => { pages.splice(i, 1); renderPrep(); });
      card.appendChild(ctr); host.appendChild(card);
    });
  };
  const pick = async capture => { const fs = await pickFiles({ accept: capture ? 'image/*' : 'image/*,.pdf,application/pdf', multiple: !capture, capture: capture ? 'environment' : null }); if (fs.length) addFiles(fs); };
  const fromUrl = async () => {
    const { promptDialog } = await import('./dialogs.js');
    const url = await promptDialog('이미지 주소로 가져오기', '주소', '', { placeholder: 'https://…/score.png', hint: '일부 사이트는 직접 가져오기를 막습니다. 그럴 땐 이미지를 복사해 이 창에서 Ctrl+V 하세요.' });
    if (!url) return;
    try { const r = await fetch(url, { mode: 'cors' }); if (!r.ok) throw new Error('HTTP ' + r.status); const b = await r.blob(); addFiles([{ name: url.split('/').pop() || 'web-image', blob: b }]); }
    catch { ui.toast('그 사이트는 직접 가져오기를 막고 있습니다. 이미지를 저장해서 열거나, 이미지를 복사(우클릭 → 이미지 복사)한 뒤 여기서 Ctrl+V 하세요.', 'warn', { timeout: 7000 }); }
  };
  let results = null;
  const run = async () => {
    const r = dlgRoot;
    const opts = {};
    const parts = r.querySelector('#scan-parts').value; if (parts !== 'auto') { opts.parts = +parts; if (parts === '2') opts.assumeGrandStaff = true; }
    const ts = r.querySelector('#scan-ts').value; if (ts) { const [n, d] = ts.split('/').map(Number); opts.timeSig = { num: n, den: d }; }
    const key = r.querySelector('#scan-key').value; if (key !== '') opts.keyFifths = +key;
    const title = r.querySelector('#scan-title').value;
    ['#scan-step1', '#scan-step2', '#scan-step4'].forEach(s => { r.querySelector(s).hidden = true; });
    r.querySelector('#scan-step3').hidden = false;
    ['run', 'more', 'apply', 'append', 'retry'].forEach(b => { const el = r.querySelector(`[data-b=${b}]`); if (el) el.hidden = true; });
    const bar = r.querySelector('#scan-bar'), msg = r.querySelector('#scan-msg');
    results = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        const c = pages[i].canvas;
        const res = await recognizeCanvas(c, opts, p => { bar.style.width = ((i + (p.percent || 0) / 100) / pages.length * 100).toFixed(1) + '%'; msg.textContent = `${pages.length > 1 ? `${i + 1}/${pages.length}쪽 · ` : ''}${p.message || p.stage}`; });
        res._blob = await new Promise(rs => c.toBlob(rs, 'image/jpeg', 0.88)); res._w = c.width; res._h = c.height; res._name = pages[i].name; res._canvas = c;
        results.push(res);
      }
      const score = mergeResults(results);
      if (title) score.meta.title = title; else if (!score.meta.title) score.meta.title = (pages[0].name || '인식한 악보').replace(/\.[^.]+$/, '').replace(/ p\d+$/, '');
      showReview(score);
    } catch (e) {
      console.error(e); msg.textContent = '인식 중 오류: ' + e.message;
      r.querySelector('[data-b=retry]').hidden = false;
    }
  };
  const showReview = score => {
    const r = dlgRoot; r.querySelector('#scan-step3').hidden = true;
    const step = r.querySelector('#scan-step4'); step.hidden = false;
    const all = results.flatMap(x => x.measures || []);
    const low = all.filter(m => m.confidence < 0.6);
    const warn = [...new Set(results.flatMap(x => x.warnings || []))];
    // recognised lyrics (Korean): uncertain syllables are marked here and in the editor
    const lyr = results.flatMap(x => x.lyrics || []);
    const lowLy = lyr.filter(l => l.lowConfidence && l.eventId).map(l => ({ eventId: l.eventId, verse: l.verse || 1, text: l.text, measureId: l.measureId }));
    const conf = results.reduce((a, x) => a + (x.confidence || 0), 0) / results.length;
    const layout = engrave(score);
    const first = results[0];
    const marks = (first.measures || []).map(m => `<rect class="${m.confidence < 0.6 ? 'low' : ''}" x="${m.bbox[0]}" y="${m.bbox[1]}" width="${m.bbox[2]}" height="${m.bbox[3]}" rx="4"><title>${Math.round(m.confidence * 100)}%</title></rect>`).join('')
      + (first.lyrics || []).filter(l => l.lowConfidence && l.bbox).map(l => `<rect class="lowly" x="${l.bbox[0]}" y="${l.bbox[1]}" width="${l.bbox[2]}" height="${l.bbox[3]}" rx="2"><title>가사 "${escapeXml(l.text)}" — ${Math.round((l.confidence || 0) * 100)}%</title></rect>`).join('');
    const imgUrl = URL.createObjectURL(first._blob);
    step.innerHTML = `
      <div class="omr-summary"><span class="chip ${conf < 0.6 ? 'warn' : ''}">신뢰도 ${Math.round(conf * 100)}%</span><span class="chip">${score.measures.length}마디</span><span class="chip">${score.parts.map(p => p.name).join(' · ')}</span><span class="chip">${effectiveTimeSig(score, 0).num}/${effectiveTimeSig(score, 0).den} · ${KEY_NAMES[effectiveKeySig(score, 0).fifths]}</span>${low.length ? `<span class="chip warn">확인 필요 ${low.length}마디</span>` : ''}${lyr.length ? `<span class="chip">가사 ${lyr.length}글자</span>` : ''}${lowLy.length ? `<span class="chip warn">가사 확인 ${lowLy.length}</span>` : ''}${results.some(x => x._skipped) ? '<span class="chip warn">보표 수가 다른 쪽은 제외됨</span>' : ''}</div>
      ${warn.length ? `<ul class="omr-warn">${warn.slice(0, 5).map(w => `<li>${escapeXml(w)}</li>`).join('')}</ul>` : ''}
      <div class="omr-split">
        <div class="omr-pane"><div class="img-wrap"><img src="${imgUrl}" alt="원본"><svg class="marks" viewBox="0 0 ${first._w} ${first._h}" preserveAspectRatio="none">${marks}</svg></div></div>
        <div class="omr-pane">${layout.pages[0]?.svg || ''}</div>
      </div>
      <p>왼쪽 원본에서 <b style="color:var(--warn)">주황색</b> 마디${lowLy.length ? '·가사' : ''}는 인식이 불확실한 곳입니다. 편집기로 가져온 뒤 원본과 비교하며 고칠 수 있습니다.${lyr.length ? ' 가사는 글자를 더블클릭하면 바로 고칠 수 있습니다.' : ''}</p>`;
    r.querySelector('[data-b=apply]').hidden = false;
    r.querySelector('[data-b=append]').hidden = !app.score?.measures.some(m => m.staves.some(sm => sm.voices.some(v => v.some(e => e.kind === 'note')))) || totalStaffCount(app.score) !== totalStaffCount(score);
    r.querySelector('[data-b=retry]').hidden = false;
    r._score = score; r._low = low.map(m => m.measureId); r._lowLy = lowLy;
  };
  const res = await showDialog({
    title: '사진으로 악보 인식', wide: true, body,
    buttons: [
      { label: '닫기', value: null },
      { label: '다시 인식', value: () => { dlgRoot.querySelector('#scan-step4').hidden = true; dlgRoot.querySelector('#scan-step3').hidden = true; renderPrep(); ['apply', 'append', 'retry'].forEach(b => { dlgRoot.querySelector(`[data-b=${b}]`).hidden = true; }); return undefined; } },
      { label: '사진 추가', value: () => { pick(false); return undefined; } },
      { label: '현재 악보 뒤에 붙이기', value: () => ({ mode: 'append' }) },
      { label: '인식 시작', primary: true, value: () => { run(); return undefined; } },
      { label: '편집기로 가져오기', primary: true, value: () => ({ mode: 'new' }) },
    ],
    onOpen: (root, close) => {
      dlgRoot = root; closeDlg = close;
      const btns = root.querySelectorAll('footer button');
      ['close', 'retry', 'more', 'append', 'run', 'apply'].forEach((k, i) => btns[i].dataset.b = k);
      ['retry', 'more', 'append', 'run', 'apply'].forEach(k => { root.querySelector(`[data-b=${k}]`).hidden = true; });
      root.querySelector('[data-a=camera]').addEventListener('click', () => pick(true));
      root.querySelector('[data-a=pick]').addEventListener('click', () => pick(false));
      root.querySelector('[data-a=url]').addEventListener('click', fromUrl);
      const dz = root.querySelector('#scan-drop');
      dz.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files].map(f => ({ name: f.name, blob: f }))); });
      root.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (fs.length) { e.preventDefault(); e.stopPropagation(); addFiles(fs.map(f => ({ name: f.name || 'clipboard.png', blob: f }))); } });
      if (isMobileLayout()) root.querySelector('.photo-tips').style.display = 'none';
      if (files?.length) addFiles(files);
    },
  });
  void closeDlg;
  if (!res) { cancelRecognition(); return; }
  const score = dlgRoot._score; if (!score) return;
  if (res.mode === 'append') {
    app.exec('인식 결과 붙이기', s => {
      const offset = s.sources.length;
      score.sources.forEach((src, k) => { const nid = `src${offset + k + 1}`; score.measures.forEach(m => { if (m.source?.sourceId === src.id) m.source.sourceId = nid; }); src.id = nid; src.file = `sources/${nid}.jpg`; });
      const first = score.measures[0]; const pts = effectiveTimeSig(s, s.measures.length - 1), pks = effectiveKeySig(s, s.measures.length - 1);
      if (first.timeSig && first.timeSig.num === pts.num && first.timeSig.den === pts.den) delete first.timeSig;
      if (first.keySig && first.keySig.fifths === pks.fifths) delete first.keySig;
      s.measures.push(...score.measures); s.sources.push(...score.sources); s.spanners.push(...score.spanners);
    });
  } else {
    if (!(await ui.confirmDiscard())) return;
    app.setScore(score, { fileName: null, dirty: true });
    ui.view.fit('width');
  }
  const lowLy = dlgRoot._lowLy || [];
  ui.setReview({ low: dlgRoot._low, lowLyrics: lowLy });
  const parts = [dlgRoot._low.length ? `마디 ${dlgRoot._low.length}개` : '', lowLy.length ? `가사 ${lowLy.length}글자` : ''].filter(Boolean);
  if (parts.length) { ui.toast(`인식 완료 — 확인이 필요한 ${parts.join(', ')}를 주황색으로 표시했습니다`, 'ok', { timeout: 5000 }); ui.toggleSourcePeek(true); }
  else ui.toast('인식 완료 — 원본과 비교하며 수정해 보세요', 'ok');
}
