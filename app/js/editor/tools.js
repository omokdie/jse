// Finale-style tools (Selection · Simple Entry · Smart Shape · Articulation · Expression · Lyrics · Chord · Text · Measure).
// Palettes, metatool keys and the Simple Entry placement rules live here; pointer.js / keyboard.js / ui.js use them.
import {
  findEvent, durTicks, effectiveTimeSig, measureCapacity, staffList, noteAtStaffPosition, effectiveClef,
  effectiveKeySig, keyAlter,
} from '../model/score.js';
import * as C from '../model/commands.js';

export const TOOLS = [
  { id: 'select', icon: 'select', label: '선택 도구', key: 'Esc', hint: '클릭: 음표·기호 선택 · 오선 클릭: 마디 선택 · 더블클릭: 세로 마디 묶음 선택 / 음표는 입력 도구로 · 6/7: 한 음 내림/올림 · 8/9: 옥타브 내림/올림 · 오른쪽 버튼 끌기: 화면 이동' },
  { id: 'entry', icon: 'noteInput', label: '심플 입력 (음표 입력)', key: 'N', hint: '클릭: 마우스 높이의 음을 다음 자리에 입력 · 기존 음표 위·아래 클릭: 화음 추가 · 1–8 음길이(5=4분음표) · A–G 음이름 · 0 쉼표 · = ♯ · - ♭ · N 제자리 · T 붙임줄 · Esc 끝' },
  { id: 'shape', icon: 'slurTool', label: '스마트 셰이프 — 이음줄·크레셴도·8va', key: '', hint: '음표 클릭: 다음 음표까지 · 음표에서 다른 음표로 끌기: 그 음표까지 · 키를 누른 채 클릭: S 이음줄, < 크레셴도, > 디크레셴도, T 트릴, 8 8va, P 페달 · 기호 클릭 후 Delete 삭제, F 위·아래 뒤집기' },
  { id: 'artic', icon: 'articTool', label: '아티큘레이션 — 스타카토·악센트·늘임표', key: '', hint: '음표 클릭: 고른 기호 붙이기/떼기 · 빈 곳에서 끌어 범위 지정: 여러 음표에 한꺼번에 · 키를 누른 채 클릭: S 스타카토, A 악센트, E 테누토, V 마르카토, F 늘임표, T 트릴' },
  { id: 'expr', icon: 'dynamicsTool', label: '표현 — 셈여림·빠르기·나타냄말', key: '', hint: '음표 클릭: 고른 표현 붙이기 · 숫자를 누른 채 클릭: 2 fff · 3 ff · 4 f · 5 mf · 6 mp · 7 p · 8 pp · 9 ppp · R rit. · T a tempo · M 리허설 마크' },
  { id: 'lyrics', icon: 'lyrics', label: '가사', key: 'Ctrl+L', hint: '음표 클릭 후 입력 · Space: 다음 음표 · - : 음절 잇기 · 한글 여러 글자는 한 음표에 한 글자씩 자동 배치 · ↑/↓ 절 바꾸기' },
  { id: 'chord', icon: 'chord', label: '코드', key: 'Ctrl+K', hint: '음표나 박 위치 클릭 후 코드 입력 (예: Am7, G/B) · Space: 다음 박 · Tab: 다음 마디 · Enter: 끝' },
  { id: 'text', icon: 'text', label: '텍스트', key: 'Ctrl+T', hint: '음표 클릭: 그 음표에 붙는 글자 · 오선 빈 곳 클릭: 마디 텍스트' },
  { id: 'measure', icon: 'measureTool', label: '마디 — 조표·박자표·음자리표·도돌이표', key: '', hint: '마디 클릭: 조표·박자표·음자리표·세로줄·도돌이표·마디 추가/삭제 메뉴' },
];
export const TOOL_IDS = TOOLS.map(t => t.id);
export const toolById = (id) => TOOLS.find(t => t.id === id) || TOOLS[0];

// ---- Smart Shape palette (Finale metatools: S slur, < > hairpins, T trill, 8 8va, 1 15ma, P pedal, G gliss, L line) ----
export const SHAPES = [
  { id: 'slur', label: '이음줄', key: 'S', type: 'slur' },
  { id: 'cresc', label: '크레셴도', key: '<', type: 'crescendo' },
  { id: 'dim', label: '디크레셴도', key: '>', type: 'diminuendo' },
  { id: 'trill', label: '트릴', key: 'T', type: 'trill' },
  { id: '8va', label: '8va', key: '8', type: 'ottava', octaveShift: 8 },
  { id: '8vb', label: '8vb', key: 'B', type: 'ottava', octaveShift: -8 },
  { id: '15ma', label: '15ma', key: '1', type: 'ottava', octaveShift: 15 },
  { id: 'pedal', label: '페달', key: 'P', type: 'pedal' },
  { id: 'gliss', label: '글리산도', key: 'G', type: 'glissando' },
  { id: 'line', label: '선', key: 'L', type: 'textLine' },
];
export const SHAPE_KEYS = Object.fromEntries(SHAPES.filter(s => s.key).map(s => [s.key, s.id]));
SHAPE_KEYS[','] = 'cresc'; SHAPE_KEYS['.'] = 'dim';

// ---- Articulation palette (Finale default metatools) ----
export const ARTICS = [
  { id: 'staccato', label: '스타카토', key: 'S', kind: 'art' },
  { id: 'accent', label: '악센트', key: 'A', kind: 'art' },
  { id: 'tenuto', label: '테누토', key: 'E', kind: 'art' },
  { id: 'marcato', label: '마르카토', key: 'V', kind: 'art' },
  { id: 'staccatissimo', label: '스타카티시모', key: 'X', kind: 'art' },
  { id: 'accent-staccato', label: '악센트+스타카토', key: 'Z', kind: 'art' },
  { id: 'marcato-staccato', label: '마르카토+스타카토', key: 'G', kind: 'art' },
  { id: 'tenuto-staccato', label: '테누토+스타카토', key: 'W', kind: 'art' },
  { id: 'tenuto-accent', label: '테누토+악센트', key: 'Q', kind: 'art2', arts: ['tenuto', 'accent'] },
  { id: 'fermata', label: '늘임표', key: 'F', kind: 'fermata' },
  { id: 'trill', label: '트릴', key: 'T', kind: 'orn' },
  { id: 'mordent', label: '모르덴트', key: 'K', kind: 'orn' },
  { id: 'inverted-mordent', label: '윗 모르덴트', key: 'M', kind: 'orn' },
  { id: 'turn', label: '턴', key: 'J', kind: 'orn' },
  { id: 'arpeggio', label: '아르페지오', key: 'R', kind: 'arp' },
  { id: 'tremolo', label: '트레몰로', key: '7', kind: 'trem' },
];
export const ARTIC_KEYS = Object.fromEntries(ARTICS.map(a => [a.key, a.id]));

// ---- Expression palette (Finale default metatools) ----
export const EXPRS = [
  { id: 'fff', label: 'fff', key: '2', kind: 'dyn' }, { id: 'ff', label: 'ff', key: '3', kind: 'dyn' }, { id: 'f', label: 'f', key: '4', kind: 'dyn' },
  { id: 'mf', label: 'mf', key: '5', kind: 'dyn' }, { id: 'mp', label: 'mp', key: '6', kind: 'dyn' }, { id: 'p', label: 'p', key: '7', kind: 'dyn' },
  { id: 'pp', label: 'pp', key: '8', kind: 'dyn' }, { id: 'ppp', label: 'ppp', key: '9', kind: 'dyn' },
  { id: 'fp', label: 'fp', key: 'F', kind: 'dyn' }, { id: 'fz', label: 'fz', key: 'G', kind: 'dyn' }, { id: 'sfz', label: 'sfz', key: 'S', kind: 'dyn' },
  { id: 'sfp', label: 'sfp', key: 'H', kind: 'dyn' }, { id: 'rfz', label: 'rfz', key: 'Z', kind: 'dyn' },
  { id: 'rit', label: 'rit.', key: 'R', kind: 'text', text: 'rit.', style: 'expression', placement: 'above' },
  { id: 'atempo', label: 'a tempo', key: 'T', kind: 'text', text: 'a tempo', style: 'expression', placement: 'above' },
  { id: 'accel', label: 'accel.', key: 'E', kind: 'text', text: 'accel.', style: 'expression', placement: 'above' },
  { id: 'cresc', label: 'cresc.', key: 'C', kind: 'text', text: 'cresc.', style: 'expression', placement: 'below' },
  { id: 'dimtext', label: 'dim.', key: 'D', kind: 'text', text: 'dim.', style: 'expression', placement: 'below' },
  { id: 'dolce', label: 'dolce', key: '', kind: 'text', text: 'dolce', style: 'expression', placement: 'below' },
  { id: 'espress', label: 'espress.', key: '', kind: 'text', text: 'espress.', style: 'expression', placement: 'below' },
  { id: 'arco', label: 'arco', key: 'O', kind: 'text', text: 'arco', style: 'technique', placement: 'above' },
  { id: 'pizz', label: 'pizz.', key: 'P', kind: 'text', text: 'pizz.', style: 'technique', placement: 'above' },
  { id: 'rehearsal', label: '리허설 마크', key: 'M', kind: 'rehearsal' },
  { id: 'tempo', label: '빠르기…', key: '', kind: 'tempo' },
];
export const EXPR_KEYS = Object.fromEntries(EXPRS.filter(e => e.key).map(e => [e.key, e.id]));

// ---------------------------------------------------------------------------
// Simple Entry placement (Finale rules): notes are entered one after another;
// clicking above/below an existing note adds to its chord; clicking an earlier
// rest fills it; clicking anywhere to the right of the music appends.
// ---------------------------------------------------------------------------
export function voiceItems(score, mi, si, vi) {
  const voice = score.measures[mi]?.staves[si]?.voices[vi] || [];
  const items = []; let t = 0;
  for (const ev of voice) { const d = durTicks(ev); items.push({ ev, start: t, end: t + d }); if (!ev.grace) t += d; }
  return items;
}

/** Where a new entry goes in (mi, si, vi): after the last note, or after the input cursor if it is further on. */
export function appendTick(app, mi, si, vi) {
  const items = voiceItems(app.score, mi, si, vi);
  let end = 0;
  for (const it of items) if (it.ev.kind === 'note' && !it.ev.grace) end = Math.max(end, it.end);
  const c = app.cursor;
  if (c && c.mi === mi && c.si === si && (c.vi ?? 0) === vi && c.tick > end) end = c.tick;
  return end;
}

/**
 * Resolve a canvas hit into a Simple Entry target.
 * Returns { action:'append'|'chord'|'replace'|'modify'|'full', mi, si, vi, tick, eventId?, x, staffY, pos, page, measure, pitch?, drum?, string?, fret? }
 */
export function entryTarget(app, view, hit) {
  if (!hit) return null;
  const score = app.score;
  // normalise to the staff under the pointer
  let mi, si, py = hit.py, page = hit.page, mr, st;
  if (hit.kind === 'staff') { mi = hit.mi; si = hit.si; mr = hit.measure; st = mr.staves.find(s => s.si === si); }
  else if (hit.event) {
    mi = hit.event.mi; si = hit.event.si;
    mr = app.layout.pages[page]?.geometry.measures.find(m => m.mi === mi); st = mr?.staves.find(s => s.si === si);
  } else return null;
  if (!mr || !st) return null;
  const staffY = st.y;
  const pos = Math.round((py - staffY) * 2);
  const vi = app.input.voice || 0;
  const cap = measureCapacity(effectiveTimeSig(score, mi));
  const items = voiceItems(score, mi, si, vi);
  const tAppend = appendTick(app, mi, si, vi);
  const geoById = new Map(app.layout.pages[page].geometry.events.filter(e => e.mi === mi && e.si === si).map(e => [e.id, e]));
  // column under the pointer (existing music before the append point)
  let col = null, best = Infinity;
  for (const it of items) {
    if (it.ev.grace || it.start >= tAppend - 1) continue;
    const g = geoById.get(it.ev.id); if (!g || g.implicit) continue;
    const x0 = g.x - 0.7, x1 = (g.x1 ?? g.x + 1.3) + 0.7;
    if (hit.px >= x0 && hit.px <= x1) { const d = Math.abs(hit.px - (g.xCenter ?? g.x + 0.6)); if (d < best) { best = d; col = { it, g }; } }
  }
  const base = { mi, si, vi, staffY, pos, page, measure: mr };
  const res = resolvePitch(app, { mi, si, pos, py, staffY });
  if (!res) return null;
  Object.assign(base, res);
  if (col) {
    const { it, g } = col;
    const x = g.xCenter ?? (g.x + 0.63);
    if (it.ev.kind === 'note') {
      const same = it.ev.notes.findIndex(n => res.pitch ? (n.step === res.pitch.step && n.octave === res.pitch.octave) : res.drum ? n.drum === res.drum : n.string === res.string);
      if (same >= 0) return { ...base, action: 'modify', tick: it.start, eventId: it.ev.id, noteIndex: same, x };
      return { ...base, action: 'chord', tick: it.start, eventId: it.ev.id, x };
    }
    return { ...base, action: 'replace', tick: it.start, eventId: it.ev.id, x };
  }
  if (tAppend >= cap - 1) return { ...base, action: 'full', tick: tAppend, x: view.xAtTick(mr, Math.max(0, cap - 1)) + 1.2 };
  return { ...base, action: 'append', tick: tAppend, x: view.xAtTick(mr, tAppend) };
}

/** Pitch / drum / string for a staff position. */
export function resolvePitch(app, { mi, si, pos, py, staffY }) {
  const score = app.score;
  const staff = staffList(score)[si]?.staff; if (!staff) return null;
  if (staff.type === 'percussion') {
    const dm = staff.drumMap || {}; let bestK = null, bd = Infinity;
    for (const [k, v] of Object.entries(dm)) { const d = Math.abs(v.line - pos); if (d < bd) { bd = d; bestK = k; } }
    const drum = bestK || app.input.drum;
    return { drum, pos: dm[drum]?.line ?? pos };
  }
  if (staff.type === 'tab') {
    const str = Math.max(1, Math.min(staff.lines || 6, Math.round((py - staffY) / 1.5) + 1));
    return { string: str, fret: app.input.fret ?? 0, pos: (str - 1) * 2 };
  }
  const clef = effectiveClef(score, mi, si);
  const key = effectiveKeySig(score, mi).fifths;
  const pitch = noteAtStaffPosition(pos, clef);
  pitch.alter = keyAlter(pitch.step, key);
  if (app.input.accidental) pitch.alter = { sharp: 1, flat: -1, natural: 0, 'double-sharp': 2, 'double-flat': -2 }[app.input.accidental] ?? pitch.alter;
  return { pitch, pos };
}

// ---------------------------------------------------------------------------
// Applying palette items
// ---------------------------------------------------------------------------
export function applyArticulation(app, ids, articId, { toggle = true } = {}) {
  const a = ARTICS.find(x => x.id === articId); if (!a || !ids.length) return;
  const noteIds = ids.filter(id => findEvent(app.score, id)?.ev.kind === 'note');
  const targets = a.kind === 'fermata' ? ids : noteIds; if (!targets.length) return;
  const first = findEvent(app.score, targets[0])?.ev;
  const has = (ev) => a.kind === 'art' ? ev?.articulations?.includes(a.id) : a.kind === 'art2' ? a.arts.every(x => ev?.articulations?.includes(x)) : a.kind === 'fermata' ? !!ev?.fermata : a.kind === 'orn' ? ev?.ornaments?.includes(a.id) : a.kind === 'arp' ? !!ev?.arpeggio : !!ev?.tremolo;
  const remove = toggle && has(first);
  app.exec(a.label, s => {
    for (const id of targets) {
      const f = findEvent(s, id); if (!f) continue; const ev = f.ev;
      const set = (field, v, on) => { const arr = ev[field] || []; const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); if (arr.length) ev[field] = arr; else delete ev[field]; };
      if (a.kind === 'art') set('articulations', a.id, !remove);
      else if (a.kind === 'art2') a.arts.forEach(x => set('articulations', x, !remove));
      else if (a.kind === 'orn') set('ornaments', a.id, !remove);
      else if (a.kind === 'fermata') { if (remove) delete ev.fermata; else ev.fermata = 'above'; }
      else if (a.kind === 'arp') { if (remove) delete ev.arpeggio; else ev.arpeggio = true; }
      else if (a.kind === 'trem') { if (remove) delete ev.tremolo; else ev.tremolo = 3; }
    }
  }, { select: app.selection });
}

/** Apply an expression to an event (dynamics/text) or a measure (tempo/rehearsal/text). */
export function applyExpression(app, ui, exprId, { eventId = null, mi = null, si = 0 } = {}) {
  const e = EXPRS.find(x => x.id === exprId); if (!e) return;
  if (e.kind === 'tempo') { ui.tempoDialogAt?.(mi ?? (eventId ? findEvent(app.score, eventId)?.mi : 0) ?? 0); return; }
  if (e.kind === 'rehearsal') {
    const m0 = mi ?? (eventId ? findEvent(app.score, eventId)?.mi : 0) ?? 0;
    const used = app.score.measures.slice(0, m0).map(m => m.rehearsalMark).filter(Boolean);
    const cur = app.score.measures[m0].rehearsalMark;
    const next = used.length ? String.fromCharCode(Math.min(90, used[used.length - 1].charCodeAt(0) + 1)) : 'A';
    app.exec('리허설 마크', s => C.setMeasureProp(s, m0, 'rehearsalMark', cur ? null : next));
    return;
  }
  if (e.kind === 'dyn') {
    if (!eventId) return;
    app.exec('셈여림', s => { const f = findEvent(s, eventId); if (!f) return; if (f.ev.dynamic === e.id) delete f.ev.dynamic; else f.ev.dynamic = e.id; }, { select: app.selection });
    return;
  }
  if (e.kind === 'text') {
    if (eventId) app.exec(e.label, s => { const f = findEvent(s, eventId); if (!f) return; const arr = f.ev.texts || []; const i = arr.findIndex(t => t.text === e.text); if (i >= 0) arr.splice(i, 1); else arr.push({ text: e.text, placement: e.placement, style: e.style }); if (arr.length) f.ev.texts = arr; else delete f.ev.texts; }, { select: app.selection });
    else if (mi != null) app.exec(e.label, s => C.addMeasureText(s, mi, e.text, e.placement, e.style, si));
  }
}

/** Create a smart shape from event a to event b (b defaults to the next note). */
export function createShape(app, shapeId, fromId, toId = null) {
  const sh = SHAPES.find(s => s.id === shapeId) || SHAPES[0];
  const fa = findEvent(app.score, fromId); if (!fa) return null;
  let fa2 = fa;
  let fb = toId ? findEvent(app.score, toId) : null;
  if (fb && (fb.mi < fa2.mi || (fb.mi === fa2.mi && fb.tick < fa2.tick))) { const t = fa2; fa2 = fb; fb = t; }
  return createShapeOrdered(app, sh, fa2, fb);
}
function createShapeOrdered(app, sh, fa, fb) {
  if (!fb || fb.ev.id === fa.ev.id) {
    // single click: to the next note (slur, glissando) or to the end of the next event (lines, hairpins)
    fb = nextEventAfter(app.score, fa, sh.type === 'slur' || sh.type === 'glissando');
    if (!fb) fb = fa;
  }
  if ((sh.type === 'slur' || sh.type === 'glissando') && fb.ev.id === fa.ev.id) return null;
  const extra = {}; if (sh.octaveShift) extra.octaveShift = sh.octaveShift; if (sh.type === 'textLine') extra.text = '';
  const id = app.exec(sh.label, s => C.addSpanner(s, sh.type, fa.ev.id, fb.ev.id, extra), { select: app.selection });
  if (id) app.select({ type: 'spanner', id });
  return id;
}
export function nextEventAfter(score, f, notesOnly = true) {
  for (let mi = f.mi, ei = f.index + 1; mi < score.measures.length; mi++, ei = 0) {
    const v = score.measures[mi].staves[f.staffIndex]?.voices[f.voiceIndex] || [];
    for (; ei < v.length; ei++) if (!v[ei].grace && (!notesOnly || v[ei].kind === 'note')) return findEvent(score, v[ei].id);
  }
  return null;
}
