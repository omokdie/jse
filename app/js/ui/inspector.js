// Properties panel for the current selection.
import { findEvent, effectiveTimeSig, effectiveKeySig, effectiveClef, staffList, KEY_NAMES, KEY_NAMES_MINOR, pitchName, parsePitchName, durTicks, midiOf } from '../model/score.js';
import * as C from '../model/commands.js';
import { noteIcon, accidentalIcon, articIcon, icon } from './icons.js';
import { DURATIONS } from './palette.js';
import { escapeXml } from '../engrave/text.js';
import { t } from '../i18n.js';

const ARTS = ['staccato', 'accent', 'tenuto', 'marcato', 'staccatissimo'];
const DYNS = ['', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'fp'];
const CLEFS = { treble: '높은음자리표', bass: '낮은음자리표', alto: '알토', tenor: '테너', treble8vb: '높은음(8vb)', bass8vb: '낮은음(8vb)', percussion: '타악기', tab: 'TAB' };

export function renderInspector(el, app, ui) {
  const sel = app.selection;
  const score = app.score;
  let html = `<div class="panel-head"><span>${t('inspector')}</span><span class="sub">${summary(app)}</span></div><div class="inspector">`;
  if (sel.type === 'events' && sel.ids.length) html += eventsSection(app, sel);
  else if (sel.type === 'measure' || sel.type === 'range') html += measureSection(app, app.rangeOf(sel));
  else if (sel.type === 'text') html += textSection(app, sel);
  else html += scoreSection(app);
  html += partsSection(app);
  html += '</div>';
  el.innerHTML = html;
  bind(el, app, ui, sel);
}
function summary(app) {
  const s = app.selection;
  if (s.type === 'events') return `${s.ids.length}개 선택`;
  if (s.type === 'measure') return `마디 ${s.mi + 1}`;
  if (s.type === 'range') return `마디 ${s.fromMi + 1}–${s.toMi + 1}`;
  if (s.type === 'text') return '텍스트';
  return '';
}
const seg = (name, opts, cur) => `<div class="seg-btns" data-seg="${name}">${opts.map(o => `<button data-v="${o.v}" class="${o.v === cur ? 'on' : ''}" title="${o.title || o.label || ''}">${o.icon || o.label}</button>`).join('')}</div>`;
const row = (label, ctl) => `<div class="row"><label>${label}</label><div class="ctl">${ctl}</div></div>`;

function eventsSection(app, sel) {
  const found = sel.ids.map(id => findEvent(app.score, id)).filter(Boolean);
  if (!found.length) return '';
  const first = found[0]; const ev = first.ev;
  const staff = staffList(app.score)[first.staffIndex].staff;
  const allNotes = found.every(f => f.ev.kind === 'note');
  const single = found.length === 1;
  let h = `<div class="insp-section"><h4>${allNotes ? (single ? (ev.notes.length > 1 ? '화음' : '음표') : '음표 여러 개') : single ? '쉼표' : '선택 항목'}<span class="chip">마디 ${first.mi + 1} · ${first.voiceIndex + 1}성부</span></h4>`;
  if (allNotes && single) {
    if (staff.type === 'standard') {
      const notes = ev.notes;
      const ni = sel.noteIndex != null ? sel.noteIndex : notes.length - 1;
      const n = notes[ni] || notes[0];
      h += row('음높이', `<input type="text" data-prop="pitch" value="${pitchName(n)}" size="5" style="width:70px"> <span class="seg-btns"><button data-act="semi" data-v="1" title="반음 올림 (↑)">${icon('up')}</button><button data-act="semi" data-v="-1" title="반음 내림 (↓)">${icon('down')}</button><button data-act="oct" data-v="1" title="옥타브 올림 (Ctrl+↑)">8va</button><button data-act="oct" data-v="-1" title="옥타브 내림 (Ctrl+↓)">8vb</button></span>`);
      if (notes.length > 1) h += row('화음 구성', `<div class="seg-btns">${notes.map((x, i) => `<button data-act="pickNote" data-v="${i}" class="${i === ni ? 'on' : ''}">${pitchName(x)}</button>`).join('')}</div>`);
      h += row('임시표', seg('acc', [{ v: 'sharp', icon: accidentalIcon('sharp') }, { v: 'flat', icon: accidentalIcon('flat') }, { v: 'natural', icon: accidentalIcon('natural') }, { v: 'none', label: '없음' }], n.accidental || ''));
    } else if (staff.type === 'percussion') {
      const dm = staff.drumMap || {};
      h += row('악기', `<select data-prop="drum">${Object.entries(dm).map(([k, v]) => `<option value="${k}" ${ev.notes[0].drum === k ? 'selected' : ''}>${v.name || k}</option>`).join('')}</select>`);
    } else if (staff.type === 'tab') {
      const n = ev.notes[sel.noteIndex ?? 0] || ev.notes[0];
      h += row('줄/프렛', `<input type="number" data-prop="string" min="1" max="${staff.lines || 6}" value="${n.string || 1}"> <input type="number" data-prop="fret" min="0" max="24" value="${n.fret ?? 0}">`);
    }
  }
  if (allNotes && !single) h += row('음높이', `<span class="seg-btns"><button data-act="semi" data-v="1">${icon('up')} 반음</button><button data-act="semi" data-v="-1">${icon('down')} 반음</button><button data-act="oct" data-v="1">8va</button><button data-act="oct" data-v="-1">8vb</button></span>`);
  h += row(t('duration'), seg('dur', DURATIONS.slice(0, 6).map(d => ({ v: d, icon: noteIcon(d), title: t(d) })), single ? ev.dur.base : ''));
  h += row('', `<label class="checkbox"><input type="checkbox" data-prop="dot" ${single && ev.dur.dots ? 'checked' : ''}> 점음표</label> ${ev.tuplet ? `<span class="chip">${ev.tuplet.num}잇단 <button class="btn sm" data-act="untuplet">해제</button></span>` : `<button class="btn sm" data-act="tuplet3">셋잇단</button>`}`);
  if (allNotes) {
    h += row(t('articulations'), seg('art', ARTS.map(a => ({ v: a, icon: articIcon(a), title: t(a) })), null).replace(/class=""/g, (m, off, str) => m));
    h += row('', `<label class="checkbox"><input type="checkbox" data-prop="fermata" ${ev.fermata ? 'checked' : ''}> 늘임표</label><label class="checkbox"><input type="checkbox" data-prop="tie" ${ev.notes.some(n => n.tieStart) ? 'checked' : ''}> 붙임줄</label>`);
    h += row(t('dynamics'), `<select data-prop="dynamic">${DYNS.map(d => `<option value="${d}" ${(ev.dynamic || '') === d ? 'selected' : ''}>${d || '(없음)'}</option>`).join('')}</select>`);
    h += row('기둥 방향', seg('stem', [{ v: '', label: '자동' }, { v: 'up', label: '위' }, { v: 'down', label: '아래' }], ev.stem || ''));
    h += row('꼬리(빔)', seg('beam', [{ v: '', label: '자동' }, { v: 'begin', label: '시작' }, { v: 'continue', label: '연결' }, { v: 'none', label: '끊기' }], ev.beam || ''));
    h += row('가사 1절', `<input type="text" data-prop="lyric1" value="${escapeXml(ev.lyrics?.find(l => (l.verse || 1) === 1)?.text || '')}" placeholder="가사">`);
    h += row('가사 2절', `<input type="text" data-prop="lyric2" value="${escapeXml(ev.lyrics?.find(l => l.verse === 2)?.text || '')}" placeholder="2절">`);
    if (staff.type !== 'tab') h += row('머리 모양', `<select data-prop="head">${['normal', 'x', 'circle-x', 'diamond', 'triangle', 'slash', 'square', 'plus'].map(x => `<option value="${x}" ${(ev.notes[0].head || 'normal') === x ? 'selected' : ''}>${x === 'normal' ? '기본' : x}</option>`).join('')}</select>`);
    h += row('성부', seg('voice', [0, 1, 2, 3].map(v => ({ v: String(v), label: String(v + 1) })), String(first.voiceIndex)));
    h += row('기타', `<label class="checkbox"><input type="checkbox" data-prop="grace" ${ev.grace ? 'checked' : ''}> 앞꾸밈음</label><label class="checkbox"><input type="checkbox" data-prop="arpeggio" ${ev.arpeggio ? 'checked' : ''}> 아르페지오</label>`);
  } else if (single) {
    h += row('', `<label class="checkbox"><input type="checkbox" data-prop="fullMeasureRest" ${ev.fullMeasureRest ? 'checked' : ''}> 온마디 쉼표</label><label class="checkbox"><input type="checkbox" data-prop="hidden" ${ev.hidden ? 'checked' : ''}> 숨김</label>`);
  }
  h += row('텍스트', `<input type="text" data-prop="text" value="${escapeXml(ev.texts?.[0]?.text || '')}" placeholder="음표에 붙는 글 (예: dolce)">`);
  h += `<div class="btn-row"><button class="btn sm danger" data-act="delete">${icon('trash')} 삭제</button><button class="btn sm" data-act="repeat">반복 (R)</button><button class="btn sm" data-act="copy">복사</button></div>`;
  h += '</div>';
  return h;
}
function measureSection(app, r) {
  const score = app.score; const m = score.measures[r.fromMi];
  const ts = effectiveTimeSig(score, r.fromMi), ks = effectiveKeySig(score, r.fromMi);
  const staves = staffList(score);
  let h = `<div class="insp-section"><h4>마디 ${r.fromMi + 1}${r.toMi > r.fromMi ? `–${r.toMi + 1}` : ''}</h4>`;
  h += row(t('timeSig'), `<input type="number" data-prop="tsNum" min="1" max="32" value="${ts.num}"> / <select data-prop="tsDen">${[1, 2, 4, 8, 16, 32].map(d => `<option ${d === ts.den ? 'selected' : ''}>${d}</option>`).join('')}</select>`);
  h += row(t('keySig'), `<select data-prop="key">${[...Array(15).keys()].map(i => i - 7).map(f => `<option value="${f}" ${f === ks.fifths ? 'selected' : ''}>${KEY_NAMES[f]} / ${KEY_NAMES_MINOR[f]}</option>`).join('')}</select>`);
  for (let si = r.s0; si <= Math.min(r.s1, r.s0 + 3); si++) {
    const st = staves[si]; if (!st || st.staff.type === 'tab') continue;
    h += row(`음자리표${r.s1 > r.s0 ? ` (${st.part.abbreviation || st.part.name}${st.part.staves.length > 1 ? ' ' + (st.staffIndex + 1) : ''})` : ''}`, `<select data-prop="clef" data-si="${si}">${Object.entries(CLEFS).filter(([k]) => st.staff.type === 'percussion' ? k === 'percussion' : k !== 'percussion' && k !== 'tab').map(([k, v]) => `<option value="${k}" ${effectiveClef(score, r.fromMi, si) === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`);
  }
  h += row(t('tempo'), `<input type="number" data-prop="bpm" min="20" max="300" value="${m.tempo?.bpm || ''}" placeholder="BPM"> <input type="text" data-prop="tempoText" value="${escapeXml(m.tempo?.text || '')}" placeholder="Allegro…" style="width:90px">`);
  h += row('왼쪽 세로줄', seg('blL', [{ v: '', label: '보통' }, { v: 'repeat-start', label: '도돌이 시작' }, { v: 'double', label: '겹' }], m.barlineLeft || ''));
  h += row('오른쪽 세로줄', seg('blR', [{ v: '', label: '보통' }, { v: 'double', label: '겹' }, { v: 'final', label: '끝' }, { v: 'repeat-end', label: '도돌이 끝' }, { v: 'dashed', label: '점선' }, { v: 'none', label: '없음' }], m.barlineRight || ''));
  h += row(t('rehearsal'), `<input type="text" data-prop="rehearsal" value="${escapeXml(m.rehearsalMark || '')}" placeholder="A, B, …">`);
  h += row('줄/페이지', `<label class="checkbox"><input type="checkbox" data-prop="sysBreak" ${m.breaks?.system ? 'checked' : ''}> 뒤에서 줄 바꿈</label><label class="checkbox"><input type="checkbox" data-prop="pageBreak" ${m.breaks?.page ? 'checked' : ''}> 페이지 나눔</label>`);
  h += row('', `<label class="checkbox"><input type="checkbox" data-prop="pickup" ${m.pickup ? 'checked' : ''}> 못갖춘마디</label>`);
  if (m.chords?.length) h += row('코드', `<div>${m.chords.map(c => `<span class="chip">${escapeXml(c.text)}</span>`).join(' ')}</div>`);
  if (m.texts?.length) h += row('텍스트', `<div>${m.texts.map((x, i) => `<span class="chip">${escapeXml(x.text)} <button data-act="delMText" data-v="${i}" title="삭제">×</button></span>`).join(' ')}</div>`);
  h += `<div class="btn-row"><button class="btn sm" data-act="insertMeasure">${icon('plus')} 앞에 삽입</button><button class="btn sm" data-act="appendMeasure">끝에 추가</button><button class="btn sm danger" data-act="deleteMeasure">${icon('trash')} 마디 삭제</button></div>`;
  h += `<div class="btn-row"><button class="btn sm" data-act="transposeRange">조옮김…</button><button class="btn sm" data-act="lyricsLine">가사 한 줄 붙이기</button><button class="btn sm" data-act="fixMeasure">박자 맞추기</button></div>`;
  h += '</div>';
  return h;
}
function textSection(app, sel) {
  const ref = sel.ref;
  const kindName = { lyric: '가사', chord: '코드 기호', tempo: '템포', rehearsal: '리허설 마크', text: '텍스트', mtext: '텍스트', title: '제목' }[ref.kind] || '텍스트';
  return `<div class="insp-section"><h4>${kindName}</h4><div class="btn-row"><button class="btn sm" data-act="editText">${icon('pencil')} 편집 (Enter)</button><button class="btn sm danger" data-act="delete">${icon('trash')} 삭제</button></div></div>`;
}
function scoreSection(app) {
  const s = app.score;
  return `<div class="insp-section"><h4>악보 정보 <button class="btn sm" data-act="meta">${icon('pencil')} 편집</button></h4>
    <div class="row"><label>제목</label><div class="ctl">${escapeXml(s.meta.title || '(없음)')}</div></div>
    <div class="row"><label>작곡</label><div class="ctl">${escapeXml(s.meta.composer || '-')}</div></div>
    <div class="row"><label>마디</label><div class="ctl">${s.measures.length}마디 · ${effectiveTimeSig(s, 0).num}/${effectiveTimeSig(s, 0).den} · ${KEY_NAMES[effectiveKeySig(s, 0).fifths]}</div></div>
    <div class="row"><label>페이지</label><div class="ctl">${app.layout?.pages?.length || 0}쪽 <button class="btn sm" data-act="pageSetup">${icon('settings')} 페이지 설정</button></div></div>
    ${app.settings.tips ? `<div class="empty-state"><b>시작하기</b><br>· 오선을 더블클릭하면 음표 입력이 시작됩니다 (<span class="kbd">N</span>)<br>· 음표를 클릭해 선택하고 <span class="kbd">↑</span><span class="kbd">↓</span>로 음높이를 바꿉니다<br>· 숫자 <span class="kbd">4</span>~<span class="kbd">7</span>로 음길이, <span class="kbd">0</span>은 쉼표<br>· <span class="kbd">Ctrl+L</span> 가사, <span class="kbd">Ctrl+K</span> 코드, <span class="kbd">Space</span> 재생</div>` : ''}
  </div>`;
}
function partsSection(app) {
  const s = app.score;
  return `<div class="insp-section"><h4>${t('instruments')} <button class="btn sm" data-act="instruments">${icon('sliders')} 관리</button></h4>
    ${s.parts.map(p => `<div class="row"><label>${escapeXml(p.name)}</label><div class="ctl"><span class="chip">${p.staves.map(st => st.type === 'standard' ? CLEFS[st.clef] || st.clef : st.type === 'tab' ? 'TAB' : '타악기').join(' + ')}</span></div></div>`).join('')}
  </div>`;
}

function bind(el, app, ui, sel) {
  const ids = sel.type === 'events' ? sel.ids : [];
  const q = s => el.querySelectorAll(s);
  const exec = (label, fn) => app.exec(label, fn, { select: app.selection });
  // segmented controls
  q('[data-seg]').forEach(segEl => segEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const name = segEl.dataset.seg, v = b.dataset.v;
    switch (name) {
      case 'dur': exec('음길이', s => C.setDuration(s, ids, v, 0)); break;
      case 'acc': exec('임시표', s => C.setAccidental(s, ids, v)); break;
      case 'art': exec('아티큘레이션', s => C.toggleArticulation(s, ids, v)); break;
      case 'stem': exec('기둥', s => C.setEventProp(s, ids, 'stem', v || null)); break;
      case 'beam': exec('빔', s => C.setEventProp(s, ids, 'beam', v || null)); break;
      case 'voice': exec('성부', s => C.setVoiceOfEvents(s, ids, +v)); break;
      case 'blL': { const r = app.rangeOf(sel); exec('세로줄', s => { for (let mi = r.fromMi; mi <= r.toMi; mi++) C.setMeasureProp(s, mi, 'barlineLeft', v || null); }); break; }
      case 'blR': { const r = app.rangeOf(sel); exec('세로줄', s => C.setMeasureProp(s, r.toMi, 'barlineRight', v || null)); break; }
    }
  })));
  q('[data-prop]').forEach(inp => {
    const prop = inp.dataset.prop;
    const handler = () => {
      const v = inp.type === 'checkbox' ? inp.checked : inp.value;
      const r = app.rangeOf(sel);
      switch (prop) {
        case 'pitch': { const p = parsePitchName(v); if (!p) return; exec('음높이', s => { const f = findEvent(s, ids[0]); const ni = sel.noteIndex ?? f.ev.notes.length - 1; Object.assign(f.ev.notes[ni], p); delete f.ev.notes[ni].accidental; f.ev.notes.sort((a, b) => midiOf(a) - midiOf(b)); }); break; }
        case 'drum': exec('드럼', s => { const f = findEvent(s, ids[0]); f.ev.notes.forEach(n => { n.drum = v; }); }); break;
        case 'string': case 'fret': exec('TAB', s => { const f = findEvent(s, ids[0]); const n = f.ev.notes[sel.noteIndex ?? 0]; n[prop] = +v; }); break;
        case 'dot': exec('점', s => C.toggleDot(s, ids)); break;
        case 'fermata': exec('늘임표', s => C.setEventProp(s, ids, 'fermata', v ? 'above' : null)); break;
        case 'tie': exec('붙임줄', s => C.toggleTie(s, ids)); break;
        case 'dynamic': exec('셈여림', s => C.setEventProp(s, ids, 'dynamic', v || null)); break;
        case 'lyric1': exec('가사', s => C.setLyric(s, ids[0], 1, v)); break;
        case 'lyric2': exec('가사', s => C.setLyric(s, ids[0], 2, v)); break;
        case 'head': exec('머리 모양', s => C.setNoteProp(s, ids, 'head', v)); break;
        case 'grace': exec('꾸밈음', s => C.setEventProp(s, ids, 'grace', v ? { slash: true } : null)); break;
        case 'arpeggio': exec('아르페지오', s => C.setEventProp(s, ids, 'arpeggio', v)); break;
        case 'fullMeasureRest': exec('온마디 쉼표', s => C.setEventProp(s, ids, 'fullMeasureRest', v)); break;
        case 'hidden': exec('숨김', s => C.setEventProp(s, ids, 'hidden', v)); break;
        case 'text': exec('텍스트', s => { for (const id of ids) { const f = findEvent(s, id); if (!f) continue; if (!v) delete f.ev.texts; else f.ev.texts = [{ text: v, placement: 'above', style: 'expression' }]; } }); break;
        case 'tsNum': case 'tsDen': { const num = +el.querySelector('[data-prop=tsNum]').value || 4, den = +el.querySelector('[data-prop=tsDen]').value || 4; exec('박자표', s => C.setTimeSig(s, r.fromMi, { num, den })); break; }
        case 'key': exec('조표', s => C.setKeySig(s, r.fromMi, +v)); break;
        case 'clef': exec('음자리표', s => C.setClef(s, r.fromMi, +inp.dataset.si, v)); break;
        case 'bpm': case 'tempoText': { const bpm = +el.querySelector('[data-prop=bpm]').value, text = el.querySelector('[data-prop=tempoText]').value; exec('템포', s => C.setTempo(s, r.fromMi, bpm || text ? { bpm: bpm || 120, text, showBpm: !!bpm } : null)); break; }
        case 'rehearsal': exec('리허설 마크', s => C.setMeasureProp(s, r.fromMi, 'rehearsalMark', v || null)); break;
        case 'sysBreak': exec('줄 바꿈', s => C.toggleBreak(s, r.toMi, 'system')); break;
        case 'pageBreak': exec('페이지 나눔', s => C.toggleBreak(s, r.toMi, 'page')); break;
        case 'pickup': exec('못갖춘마디', s => C.setMeasureProp(s, r.fromMi, 'pickup', v)); break;
      }
    };
    inp.addEventListener('change', handler);
    if (inp.type === 'text' && prop !== 'pitch') inp.addEventListener('keydown', e => { if (e.key === 'Enter') { inp.blur(); } });
  });
  q('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act, v = b.dataset.v;
    const r = app.rangeOf(sel);
    switch (act) {
      case 'semi': app.transposeSelection({ semitones: +v }); break;
      case 'oct': app.transposeSelection({ octaves: +v }); break;
      case 'pickNote': app.select({ ...sel, noteIndex: +v }); break;
      case 'untuplet': exec('잇단음표 해제', s => C.removeTuplet(s, ids[0])); break;
      case 'tuplet3': exec('셋잇단', s => ids.forEach(id => C.makeTuplet(s, id, 3, 2))); break;
      case 'delete': app.deleteSelection(); break;
      case 'repeat': { const nids = app.exec('반복', s => C.repeatEvents(s, ids)); if (nids?.length) app.select({ type: 'events', ids: nids }); break; }
      case 'copy': app.copySelection(); ui.toast('복사했습니다'); break;
      case 'insertMeasure': app.exec('마디 삽입', s => C.insertMeasures(s, r.fromMi, 1)); break;
      case 'appendMeasure': app.exec('마디 추가', s => C.appendMeasures(s, 1)); break;
      case 'deleteMeasure': ui.deleteMeasures(); break;
      case 'transposeRange': ui.transposeDialog(); break;
      case 'lyricsLine': ui.lyricsLineDialog(); break;
      case 'fixMeasure': { const n = app.exec('박자 맞추기', s => C.fixMeasures(s, Array.from({ length: r.toMi - r.fromMi + 1 }, (_, i) => r.fromMi + i))); ui.toast(n ? `${n}개 성부를 고쳤습니다` : '이미 박자가 맞습니다'); break; }
      case 'delMText': exec('텍스트 삭제', s => C.setMeasureText(s, r.fromMi, +v, '')); break;
      case 'editText': ui.editText(sel.ref); break;
      case 'meta': ui.metaDialog(); break;
      case 'pageSetup': ui.pageSetupDialog(); break;
      case 'instruments': ui.instrumentsDialog(); break;
    }
  }));
}
