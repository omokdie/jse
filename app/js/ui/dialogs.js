// Modal dialogs: generic helper + specific dialogs (new score, meta, page setup, instruments, transpose, shortcuts...).
import { INSTRUMENTS, KEY_NAMES, KEY_NAMES_MINOR, staffList } from '../model/score.js';
import * as C from '../model/commands.js';
import { PAGE_SIZES } from '../engrave/render.js';
import { escapeXml } from '../engrave/text.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

let openCount = 0;
export function dialogOpen() { return openCount > 0; }

/**
 * Show a modal. Returns a promise resolving with the value passed to close(value).
 * opts: { title, body (html), buttons:[{label, value, primary, danger}], wide, onOpen(root, close) }
 */
export function showDialog({ title, body, buttons = [{ label: t('ok'), value: true, primary: true }], wide = false, onOpen = null, closable = true }) {
  return new Promise(resolve => {
    const back = document.createElement('div'); back.className = 'dialog-backdrop';
    back.innerHTML = `<div class="dialog ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><header><span>${title}</span>${closable ? `<button class="x" aria-label="${t('close')}">×</button>` : ''}</header><div class="content">${body}</div>${buttons.length ? `<footer>${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-i="${i}">${b.label}</button>`).join('')}</footer>` : ''}</div>`;
    document.getElementById('layer').appendChild(back); openCount++;
    const close = v => { if (!back.isConnected) return; back.remove(); openCount--; resolve(v); };
    back.querySelector('.x')?.addEventListener('click', () => close(null));
    back.addEventListener('pointerdown', e => { if (e.target === back && closable) close(null); });
    back.querySelectorAll('footer button').forEach(b => b.addEventListener('click', () => { const def = buttons[+b.dataset.i]; const v = typeof def.value === 'function' ? def.value(back) : def.value; if (v !== undefined) close(v); }));
    back.addEventListener('keydown', e => { if (e.key === 'Escape' && closable) { e.stopPropagation(); close(null); } if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.isComposing) { const p = buttons.find(b => b.primary); if (p) { e.preventDefault(); const v = typeof p.value === 'function' ? p.value(back) : p.value; if (v !== undefined) close(v); } } });
    onOpen?.(back, close);
    const first = back.querySelector('input,select,textarea,button.primary'); first?.focus();
  });
}
export const alertDialog = (title, msg) => showDialog({ title, body: `<p>${msg}</p>` });
export const confirmDialog = (title, msg, okLabel = t('ok')) => showDialog({ title, body: `<p>${msg}</p>`, buttons: [{ label: t('cancel'), value: false }, { label: okLabel, value: true, primary: true }] });
export const promptDialog = (title, label, value = '', { placeholder = '', hint = '' } = {}) => showDialog({ title, body: `<div class="row"><label>${label}</label><div class="ctl"><input type="text" id="pd-v" value="${escapeXml(value)}" placeholder="${placeholder}"></div></div>${hint ? `<p>${hint}</p>` : ''}`, buttons: [{ label: t('cancel'), value: null }, { label: t('ok'), primary: true, value: r => r.querySelector('#pd-v').value }] });

// ---------------------------------------------------------------------------
export async function newScoreDialog(app, ui) {
  const insts = Object.entries(INSTRUMENTS);
  const templates = [
    { id: 'melody', name: '멜로디 (한 줄)', desc: '보컬·리코더·플루트 등', instruments: ['voice'] },
    { id: 'lead', name: '리드 시트', desc: '멜로디 + 코드 + 가사', instruments: ['voice'], chords: true },
    { id: 'piano', name: '피아노', desc: '큰보표 (오른손+왼손)', instruments: ['piano'] },
    { id: 'vocal-piano', name: '보컬 + 피아노', desc: '노래 반주 악보', instruments: ['voice', 'piano'] },
    { id: 'guitar', name: '기타 (악보+TAB)', desc: '표준 악보와 타브', instruments: ['guitar', 'guitar-tab'] },
    { id: 'drums', name: '드럼', desc: '드럼 세트 악보', instruments: ['drumset'] },
    { id: 'band', name: '밴드', desc: '보컬·기타·베이스·드럼', instruments: ['voice', 'guitar', 'bass', 'drumset'] },
    { id: 'custom', name: '직접 선택', desc: '악기를 골라 구성', instruments: [] },
  ];
  const body = `
    <h4>1. 어떤 악보인가요?</h4>
    <div class="cards" id="tpl">${templates.map((tp, i) => `<button class="card ${i === 0 ? 'on' : ''}" data-i="${i}"><b>${tp.name}</b><span>${tp.desc}</span></button>`).join('')}</div>
    <div id="custom-insts" hidden><h4>악기 선택 (여러 개 가능)</h4><div class="cards">${insts.map(([k, v]) => `<button class="card inst" data-k="${k}"><b>${v.name}</b><span>${v.staves.join('+')}</span></button>`).join('')}</div></div>
    <h4>2. 기본 정보</h4>
    <div class="grid-2">
      <div class="row"><label>제목</label><div class="ctl"><input type="text" id="ns-title" placeholder="제목 없음"></div></div>
      <div class="row"><label>작곡</label><div class="ctl"><input type="text" id="ns-composer"></div></div>
      <div class="row"><label>박자</label><div class="ctl"><input type="number" id="ns-num" value="4" min="1" max="32" style="width:60px"> / <select id="ns-den">${[2, 4, 8, 16].map(d => `<option ${d === 4 ? 'selected' : ''}>${d}</option>`).join('')}</select></div></div>
      <div class="row"><label>조성</label><div class="ctl"><select id="ns-key">${[...Array(15).keys()].map(i => i - 7).map(f => `<option value="${f}" ${f === 0 ? 'selected' : ''}>${KEY_NAMES[f]} 장조 / ${KEY_NAMES_MINOR[f]}</option>`).join('')}</select></div></div>
      <div class="row"><label>템포</label><div class="ctl"><input type="number" id="ns-tempo" value="100" min="20" max="300" style="width:70px"> BPM</div></div>
      <div class="row"><label>마디 수</label><div class="ctl"><input type="number" id="ns-measures" value="16" min="1" max="500" style="width:70px"></div></div>
    </div>`;
  let tpl = 0; const custom = new Set(['piano']);
  const res = await showDialog({
    title: t('new'), body, wide: true,
    buttons: [{ label: t('cancel'), value: null }, { label: '만들기', primary: true, value: r => ({ title: r.querySelector('#ns-title').value, composer: r.querySelector('#ns-composer').value, num: +r.querySelector('#ns-num').value || 4, den: +r.querySelector('#ns-den').value || 4, key: +r.querySelector('#ns-key').value, tempo: +r.querySelector('#ns-tempo').value || 100, measures: +r.querySelector('#ns-measures').value || 16 }) }],
    onOpen: root => {
      root.querySelectorAll('#tpl .card').forEach(c => c.addEventListener('click', () => { tpl = +c.dataset.i; root.querySelectorAll('#tpl .card').forEach(x => x.classList.toggle('on', x === c)); root.querySelector('#custom-insts').hidden = templates[tpl].id !== 'custom'; }));
      root.querySelectorAll('.inst').forEach(c => { c.classList.toggle('on', custom.has(c.dataset.k)); c.addEventListener('click', () => { if (custom.has(c.dataset.k)) custom.delete(c.dataset.k); else custom.add(c.dataset.k); c.classList.toggle('on'); }); });
    },
  });
  if (!res) return;
  const instruments = templates[tpl].id === 'custom' ? [...custom] : templates[tpl].instruments;
  if (!instruments.length) instruments.push('piano');
  app.newScore({ title: res.title || '제목 없음', composer: res.composer, instruments, measures: res.measures, timeSig: { num: res.num, den: res.den }, keyFifths: res.key, tempo: res.tempo });
  ui.view.fit('width');
  ui.toast('새 악보를 만들었습니다. 오선을 더블클릭하면 음표를 입력할 수 있어요.', 'ok');
}

export async function metaDialog(app) {
  const m = app.score.meta;
  const f = (k, label) => `<div class="row"><label>${label}</label><div class="ctl"><input type="text" data-k="${k}" value="${escapeXml(m[k] || '')}"></div></div>`;
  const res = await showDialog({ title: '제목 / 작곡가', body: f('title', t('title')) + f('subtitle', t('subtitle')) + f('composer', t('composer')) + f('lyricist', t('lyricist')) + f('arranger', t('arranger')) + f('copyright', t('copyright')), buttons: [{ label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => Object.fromEntries([...r.querySelectorAll('input[data-k]')].map(i => [i.dataset.k, i.value])) }] });
  if (res) app.exec('악보 정보', s => Object.assign(s.meta, res));
}

export async function pageSetupDialog(app) {
  const st = app.score.settings;
  const body = `
    <div class="row"><label>용지</label><div class="ctl"><select id="ps-size">${Object.keys(PAGE_SIZES).map(k => `<option ${st.pageSize === k ? 'selected' : ''}>${k}</option>`).join('')}<option value="custom" ${st.pageSize === 'custom' ? 'selected' : ''}>직접 지정</option></select>
      <select id="ps-orient"><option value="portrait" ${st.orientation !== 'landscape' ? 'selected' : ''}>세로</option><option value="landscape" ${st.orientation === 'landscape' ? 'selected' : ''}>가로</option></select></div></div>
    <div class="row" id="ps-custom" ${st.pageSize === 'custom' ? '' : 'hidden'}><label>크기(mm)</label><div class="ctl"><input type="number" id="ps-w" value="${st.pageWidthMm}"> × <input type="number" id="ps-h" value="${st.pageHeightMm}"></div></div>
    <div class="row"><label>여백(mm)</label><div class="ctl">위 <input type="number" id="ps-mt" value="${st.marginsMm.top}" style="width:56px"> 아래 <input type="number" id="ps-mb" value="${st.marginsMm.bottom}" style="width:56px"> 좌 <input type="number" id="ps-ml" value="${st.marginsMm.left}" style="width:56px"> 우 <input type="number" id="ps-mr" value="${st.marginsMm.right}" style="width:56px"></div></div>
    <div class="row"><label>오선 크기</label><div class="ctl"><input type="range" id="ps-sp" min="1.2" max="2.6" step="0.05" value="${st.staffSpaceMm}"> <span id="ps-sp-v">${st.staffSpaceMm}mm</span></div></div>
    <div class="row"><label>단 간격</label><div class="ctl"><input type="number" id="ps-sg" value="${st.systemGapSp}" min="4" max="30" style="width:64px"> 보표 간격 <input type="number" id="ps-stg" value="${st.staffGapSp}" min="4" max="30" style="width:64px"></div></div>
    <div class="row"><label>마디 번호</label><div class="ctl"><select id="ps-mn"><option value="system" ${st.measureNumbers === 'system' ? 'selected' : ''}>단 시작마다</option><option value="all" ${st.measureNumbers === 'all' ? 'selected' : ''}>모든 마디</option><option value="none" ${st.measureNumbers === 'none' ? 'selected' : ''}>없음</option></select></div></div>
    <div class="row"><label>파트 이름</label><div class="ctl"><label class="checkbox"><input type="checkbox" id="ps-pn" ${st.showPartNames !== false ? 'checked' : ''}> 단 왼쪽에 표시</label></div></div>`;
  const res = await showDialog({ title: t('pageSetup'), body, buttons: [{ label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => ({ pageSize: r.querySelector('#ps-size').value, orientation: r.querySelector('#ps-orient').value, pageWidthMm: +r.querySelector('#ps-w').value || 210, pageHeightMm: +r.querySelector('#ps-h').value || 297, marginsMm: { top: +r.querySelector('#ps-mt').value, bottom: +r.querySelector('#ps-mb').value, left: +r.querySelector('#ps-ml').value, right: +r.querySelector('#ps-mr').value }, staffSpaceMm: +r.querySelector('#ps-sp').value, systemGapSp: +r.querySelector('#ps-sg').value, staffGapSp: +r.querySelector('#ps-stg').value, measureNumbers: r.querySelector('#ps-mn').value, showPartNames: r.querySelector('#ps-pn').checked }) }],
    onOpen: root => { root.querySelector('#ps-size').addEventListener('change', e => { root.querySelector('#ps-custom').hidden = e.target.value !== 'custom'; }); root.querySelector('#ps-sp').addEventListener('input', e => { root.querySelector('#ps-sp-v').textContent = e.target.value + 'mm'; }); } });
  if (res) app.exec('페이지 설정', s => Object.assign(s.settings, res));
}

export async function instrumentsDialog(app, ui) {
  const render = root => {
    const list = root.querySelector('#inst-list');
    list.innerHTML = app.score.parts.map((p, i) => `<div class="row" data-id="${p.id}"><div class="ctl" style="flex:1"><input type="text" data-name value="${escapeXml(p.name)}" style="flex:1"> <input type="text" data-abbr value="${escapeXml(p.abbreviation || '')}" style="width:64px" title="약어"></div>
      <span class="seg-btns"><button data-up title="위로" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button data-down title="아래로" ${i === app.score.parts.length - 1 ? 'disabled' : ''}>${icon('down')}</button><button data-del title="삭제" ${app.score.parts.length === 1 ? 'disabled' : ''}>${icon('trash')}</button></span></div>`).join('');
    list.querySelectorAll('[data-id]').forEach(rowEl => {
      const id = rowEl.dataset.id;
      rowEl.querySelector('[data-name]').addEventListener('change', e => app.exec('파트 이름', s => C.setPartProp(s, id, 'name', e.target.value)));
      rowEl.querySelector('[data-abbr]').addEventListener('change', e => app.exec('파트 약어', s => C.setPartProp(s, id, 'abbreviation', e.target.value)));
      rowEl.querySelector('[data-up]').addEventListener('click', () => { app.exec('파트 이동', s => C.movePart(s, id, -1)); render(root); });
      rowEl.querySelector('[data-down]').addEventListener('click', () => { app.exec('파트 이동', s => C.movePart(s, id, 1)); render(root); });
      rowEl.querySelector('[data-del]').addEventListener('click', async () => { if (await confirmDialog('파트 삭제', '이 파트의 모든 음표가 삭제됩니다. 계속할까요?', '삭제')) { app.exec('파트 삭제', s => C.removePart(s, id)); render(root); } });
    });
  };
  await showDialog({
    title: t('instruments'), wide: false,
    body: `<div id="inst-list"></div><h4>파트 추가</h4><div class="cards">${Object.entries(INSTRUMENTS).map(([k, v]) => `<button class="card" data-add="${k}"><b>${v.name}</b><span>${v.type === 'tab' ? 'TAB' : v.type === 'percussion' ? '타악기' : v.staves.length > 1 ? '큰보표' : v.staves[0]}</span></button>`).join('')}</div>`,
    buttons: [{ label: t('done'), value: true, primary: true }],
    onOpen: root => { render(root); root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => { app.exec('파트 추가', s => C.addPart(s, b.dataset.add)); render(root); })); },
  });
  void ui;
}

export async function transposeDialog(app) {
  const body = `<p>선택한 범위(또는 전체 악보)를 조옮김합니다.</p>
    <div class="row"><label>방법</label><div class="ctl"><select id="tr-mode"><option value="semi">반음 단위</option><option value="key">조성으로</option></select></div></div>
    <div class="row" id="tr-semi-row"><label>반음</label><div class="ctl"><input type="number" id="tr-semi" value="2" min="-24" max="24" style="width:70px"> (양수 = 올림)</div></div>
    <div class="row" id="tr-key-row" hidden><label>새 조성</label><div class="ctl"><select id="tr-key">${[...Array(15).keys()].map(i => i - 7).map(f => `<option value="${f}">${KEY_NAMES[f]} / ${KEY_NAMES_MINOR[f]}</option>`).join('')}</select></div></div>
    <div class="row"><label>적용</label><div class="ctl"><label class="checkbox"><input type="checkbox" id="tr-keysig" checked> 조표도 함께 바꾸기</label></div></div>`;
  const res = await showDialog({ title: t('transpose'), body, buttons: [{ label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => ({ mode: r.querySelector('#tr-mode').value, semi: +r.querySelector('#tr-semi').value, key: +r.querySelector('#tr-key').value, keysig: r.querySelector('#tr-keysig').checked }) }],
    onOpen: root => root.querySelector('#tr-mode').addEventListener('change', e => { root.querySelector('#tr-semi-row').hidden = e.target.value !== 'semi'; root.querySelector('#tr-key-row').hidden = e.target.value !== 'key'; }) });
  if (!res) return;
  const sel = app.selection; const r = (sel.type === 'range' || sel.type === 'measure') ? app.rangeOf(sel) : { fromMi: 0, toMi: app.score.measures.length - 1, s0: 0, s1: staffList(app.score).length - 1 };
  let semis = res.semi;
  if (res.mode === 'key') { const cur = app.score.measures[r.fromMi].keySig?.fifths ?? 0; let d = ((res.key - cur) * 7) % 12; if (d > 6) d -= 12; if (d < -6) d += 12; semis = d; }
  if (!semis) return;
  app.exec('조옮김', s => { if (res.keysig && r.s0 === 0) C.transposeKey(s, semis, r.fromMi, r.toMi); else C.transposeRange(s, r, semis); });
}

export function shortcutsDialog() {
  const sec = (title, rows) => `<h4 class="sc-h">${title}</h4><div class="grid-2">${rows.map(([k, d]) => `<div class="row"><label><span class="kbd">${k}</span></label><div class="ctl">${d}</div></div>`).join('')}</div>`;
  const body = [
    sec('도구 (피날레 메인 도구 팔레트)', [['Esc', '선택 도구'], ['N', '심플 입력(음표 입력)'], ['Ctrl+L', '가사 도구'], ['Ctrl+K', '코드 도구'], ['Ctrl+T', '텍스트'], ['왼쪽 도구 막대', '스마트 셰이프 · 아티큘레이션 · 표현 · 마디 도구']]),
    sec('선택 도구', [['클릭', '음표·기호 선택 / 오선 클릭 = 마디 선택'], ['더블클릭(마디)', '세로 마디 묶음 선택 (Delete로 마디 삭제)'], ['더블클릭(음표)', '그 음표를 선택한 채 심플 입력'], ['선택 영역 끌기', '끌어서 복사 (Alt = 끼워 넣기)'], ['6 / 7', '한 음 내림 / 올림'], ['8 / 9', '옥타브 내림 / 올림'], ['↑ / ↓', '한 음 올림/내림 (Shift = 옥타브, Alt = 반음)'], ['Alt+1–8', '음길이 바꾸기'], ['S · < · >', '선택한 음표에 이음줄 · 크레셴도 · 디크레셴도'], ['Backspace / Delete', '지우기 / 묶음이면 마디 삭제']]),
    sec('심플 입력', [['클릭', '마우스 높이의 음을 다음 자리에 입력'], ['기존 음표 위·아래 클릭', '화음에 추가 (Shift+클릭도 가능)'], ['1 – 8', '음길이: 1=64분 · 2=32분 · 3=16분 · 4=8분 · 5=4분 · 6=2분 · 7=온음표 · 8=겹온음표 (두 번 빨리 = 점·임시표 해제)'], ['9', '셋잇단음표'], ['A – G', '음이름으로 입력'], ['Shift+A–G', '화음에 음 추가'], ['0 / Tab', '쉼표'], ['Enter', '캐럿 높이에 입력 (↑↓로 캐럿 이동)'], ['. (점)', '점음표'], ['= / - / N', '♯ / ♭ / 제자리표'], ['T', '붙임줄'], ['L', '기둥 방향 뒤집기'], ['\\', '이명동음 바꾸기'], ['/', '빔 끊기/잇기'], ['R', '음표 ↔ 쉼표'], ['H', '숨기기/보이기'], ['Alt+G', '꾸밈음'], ['F2–F8', '위로 2·3·…·8도 음 추가 (Shift = 아래로)'], ['Ctrl+↑/↓', '화음 안에서 위/아래 음 선택'], ['← / →', '이전 / 다음 음표'], ['Ctrl+← / →', '이전 / 다음 마디'], ['Delete', '선택한 음표 지우기']]),
    sec('스마트 셰이프 · 아티큘레이션 · 표현 (키를 누른 채 클릭)', [['S · < · >', '이음줄 · 크레셴도 · 디크레셴도'], ['T · 8 · P', '트릴 · 8va · 페달'], ['F (기호 선택 시)', '위·아래 뒤집기'], ['S A E V F', '스타카토 · 악센트 · 테누토 · 마르카토 · 늘임표'], ['2 – 9', 'fff · ff · f · mf · mp · p · pp · ppp'], ['R · T · M', 'rit. · a tempo · 리허설 마크']]),
    sec('화면 · 재생 · 파일', [['Ctrl+E', '페이지 보기 ↔ 스크롤 보기'], ['Ctrl+= / Ctrl+-', '확대 / 축소'], ['Ctrl+] / Ctrl+[', '폭 맞춤 / 페이지 맞춤'], ['오른쪽 버튼 끌기', '화면 이동 (손 도구)'], ['Ctrl+PgUp / PgDn', '이전 / 다음 페이지'], ['Ctrl+Shift+G', '마디로 이동'], ['Space', '재생 / 일시정지'], ['Space+클릭', '그 마디부터 재생'], ['Alt+Shift+1–4', '성부(레이어) 선택'], ['Ctrl+Z / Ctrl+Y', '실행 취소 / 다시 실행'], ['Ctrl+C / X / V', '복사 / 잘라내기 / 붙여넣기'], ['Ctrl+A', '전체 선택'], ['Ctrl+B · Ctrl+Insert', '마디 끝에 추가 · 앞에 삽입'], ['Ctrl+S · Ctrl+O · Ctrl+P', '저장 · 열기 · PDF']]),
  ].join('');
  return showDialog({ title: t('shortcuts') + ' — 피날레 방식', wide: true, body: `<div class="shortcuts">${body}</div>` });
}
export function aboutDialog(version) {
  return showDialog({ title: 'JSE 정보', body: `<p><b>JSE</b> v${version} — 악보 사진 인식 · 편집 · 내보내기</p><p>음악 기호 글꼴: GNU FreeSerif (GPLv3 + 글꼴 예외) · 압축: JSZip (MIT) · PDF: pdf-lib (MIT)</p><p>파일 형식 <code>.ssnap</code>은 ZIP 컨테이너이며 <code>score.json</code>과 원본 사진을 담습니다. MusicXML로 다른 프로그램과 주고받을 수 있습니다.</p>` });
}
export async function timeSigDialog(app, mi) {
  const ts = app.score.measures[mi]?.timeSig || { num: 4, den: 4 };
  const res = await showDialog({ title: t('timeSig'), body: `<div class="row"><label>박자</label><div class="ctl"><input type="number" id="ts-n" value="${ts.num}" min="1" max="32" style="width:64px"> / <select id="ts-d">${[1, 2, 4, 8, 16, 32].map(d => `<option ${d === ts.den ? 'selected' : ''}>${d}</option>`).join('')}</select></div></div><div class="row"><label>표시</label><div class="ctl"><select id="ts-disp"><option value="normal">숫자</option><option value="common">C</option><option value="cut">¢</option></select></div></div>`, buttons: [{ label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => ({ num: +r.querySelector('#ts-n').value || 4, den: +r.querySelector('#ts-d').value || 4, display: r.querySelector('#ts-disp').value }) }] });
  if (res) app.exec('박자표', s => C.setTimeSig(s, mi, res));
}
export async function tempoDialog(app, mi) {
  const tp = app.score.measures[mi]?.tempo || { bpm: 120, text: '', beatUnit: 'quarter' };
  const res = await showDialog({ title: t('tempo'), body: `<div class="row"><label>빠르기말</label><div class="ctl"><input type="text" id="tp-text" value="${escapeXml(tp.text || '')}" placeholder="Allegro, 보통 빠르게…"></div></div><div class="row"><label>BPM</label><div class="ctl"><select id="tp-unit">${['quarter', 'half', 'eighth'].map(u => `<option value="${u}" ${tp.beatUnit === u ? 'selected' : ''}>${t(u)}</option>`).join('')}</select> = <input type="number" id="tp-bpm" value="${tp.bpm || 120}" min="20" max="300" style="width:70px"></div></div><div class="row"><label></label><div class="ctl"><label class="checkbox"><input type="checkbox" id="tp-show" ${tp.showBpm !== false ? 'checked' : ''}> BPM 숫자 표시</label></div></div>`, buttons: [{ label: '삭제', value: 'delete', danger: true }, { label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => ({ text: r.querySelector('#tp-text').value, bpm: +r.querySelector('#tp-bpm').value || 120, beatUnit: r.querySelector('#tp-unit').value, showBpm: r.querySelector('#tp-show').checked, dots: 0 }) }] });
  if (res === 'delete') app.exec('템포 삭제', s => C.setTempo(s, mi, null));
  else if (res) app.exec('템포', s => C.setTempo(s, mi, res));
}
export async function settingsDialog(app, ui) {
  const st = app.settings;
  const res = await showDialog({ title: t('settings'), body: `
    <div class="row"><label>언어</label><div class="ctl"><select id="st-lang"><option value="ko" ${st.lang === 'ko' ? 'selected' : ''}>한국어</option><option value="en" ${st.lang === 'en' ? 'selected' : ''}>English</option></select></div></div>
    <div class="row"><label>테마</label><div class="ctl"><select id="st-theme"><option value="auto" ${st.theme === 'auto' ? 'selected' : ''}>시스템 설정</option><option value="light" ${st.theme === 'light' ? 'selected' : ''}>밝게</option><option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>어둡게</option></select></div></div>
    <div class="row"><label>자동 저장</label><div class="ctl"><label class="checkbox"><input type="checkbox" id="st-autosave" ${st.autosave ? 'checked' : ''}> 편집 내용을 브라우저에 자동 저장</label></div></div>
    <div class="row"><label>자동 업데이트</label><div class="ctl"><label class="checkbox"><input type="checkbox" id="st-update" ${st.autoUpdate ? 'checked' : ''}> 인터넷 연결 시 자동으로 업데이트</label></div></div>
    <div class="row"><label>초보자 안내</label><div class="ctl"><label class="checkbox"><input type="checkbox" id="st-tips" ${st.tips ? 'checked' : ''}> 간단 모드 + 도움말 표시</label></div></div>
    <div class="row"><label>버전</label><div class="ctl">${ui.version || ''} <button class="btn sm" id="st-check">${icon('refresh')} 업데이트 확인</button></div></div>`,
    buttons: [{ label: t('cancel'), value: null }, { label: t('apply'), primary: true, value: r => ({ lang: r.querySelector('#st-lang').value, theme: r.querySelector('#st-theme').value, autosave: r.querySelector('#st-autosave').checked, autoUpdate: r.querySelector('#st-update').checked, tips: r.querySelector('#st-tips').checked }) }],
    onOpen: root => root.querySelector('#st-check').addEventListener('click', () => ui.updater?.check(true)) });
  if (!res) return;
  const langChanged = res.lang !== st.lang;
  Object.assign(app.settings, res); app.saveSettings();
  ui.applyTheme(); ui.updater?.setAuto(res.autoUpdate);
  if (langChanged) { const { setLang } = await import('../i18n.js'); setLang(res.lang); ui.rebuild(); }
  ui.renderPanels();
}
