// Grouped tools (Photoshop-style flyouts) shared by the options bar, the tool rail and the palette.
import { t } from '../i18n.js';
import { KEY_NAMES, KEY_NAMES_MINOR, findEvent, staffList } from '../model/score.js';
import { noteIcon, accidentalIcon, articIcon, dynamicIcon, clefIcon, keySigIcon, timeSigIcon, barlineIcon, textIcon, glyphIcon, slurIcon, hairpinIcon, tupletIcon, graceIcon, tieIcon, icon } from './icons.js';
import { SHAPES, ARTICS, EXPRS, applyArticulation, applyExpression, createShape } from '../editor/tools.js';
import * as C from '../model/commands.js';

export const NOTE_VALUES = [
  ['breve', '겹온음표', '8'], ['whole', '온음표', '7'], ['half', '2분음표', '6'], ['quarter', '4분음표', '5'],
  ['eighth', '8분음표', '4'], ['16th', '16분음표', '3'], ['32nd', '32분음표', '2'], ['64th', '64분음표', '1'],
];
export const REST_VALUES = NOTE_VALUES.map(([id, label, key]) => [id, label.replace('음표', '쉼표'), key]);

/** Group factories. Each returns { id, title, items, current, active, onPick, onMain? }. */
export function groupFactory(app, ui) {
  const mem = ui.flyMem || (ui.flyMem = {});
  const inp = app.input;
  const remember = (k, v) => { mem[k] = v; };
  const selIds = () => app.selectedEventIds();
  const noteIds = () => selIds().filter(id => findEvent(app.score, id)?.ev.kind === 'note');
  const keep = () => ({ select: app.selection });
  const artIcon = (a) => a.kind === 'art' ? articIcon(a.id) : a.kind === 'art2' ? articIcon('tenuto') : a.kind === 'fermata' ? glyphIcon('fermataAbove', { y: 1.2, s: 1.1 }) : a.kind === 'orn' ? glyphIcon({ trill: 'ornamentTrill', mordent: 'ornamentMordent', 'inverted-mordent': 'ornamentShortTrill', turn: 'ornamentTurn' }[a.id], { y: a.id === 'trill' ? 1 : 0, s: a.id === 'trill' ? 0.9 : 1 }) : a.kind === 'arp' ? glyphIcon('arpeggiato', { y: -2, s: 0.9 }) : glyphIcon('tremolo3', { y: 0, s: 1.2 });
  const shapeIcon = (sh) => sh.type === 'slur' ? slurIcon() : sh.type === 'crescendo' || sh.type === 'diminuendo' ? hairpinIcon(sh.type) : sh.type === 'ottava' ? glyphIcon(Math.abs(sh.octaveShift) === 15 ? (sh.octaveShift > 0 ? 'quindicesimaAlta' : 'quindicesimaBassa') : (sh.octaveShift > 0 ? 'ottavaAlta' : 'ottavaBassa'), { y: 1, s: 0.75 }) : sh.type === 'pedal' ? glyphIcon('keyboardPedalPed', { y: 1, s: 0.8 }) : sh.type === 'trill' ? textIcon('tr~~', { italic: true, size: 1.6 }) : sh.type === 'glissando' ? textIcon('gliss.', { italic: true, size: 1.5 }) : textIcon('—', { size: 2 });
  const shapeItems = (ids) => SHAPES.filter(s => ids.includes(s.id)).map(s => ({ id: s.id, icon: shapeIcon(s), label: s.label, key: s.key }));
  const articItems = (ids) => ARTICS.filter(a => ids.includes(a.id)).map(a => ({ id: a.id, icon: artIcon(a), label: a.label, key: a.key }));
  const exprIcon = (e) => e.kind === 'dyn' ? dynamicIcon(e.id) : e.kind === 'rehearsal' ? textIcon('A', { bold: true, size: 2.2 }) : e.kind === 'tempo' ? textIcon('♩=', { bold: true, size: 1.8 }) : textIcon(e.label, { italic: true, size: e.label.length > 6 ? 1.2 : 1.5 });
  const exprItems = (pred) => EXPRS.filter(pred).map(e => ({ id: e.id, icon: exprIcon(e), label: e.label, key: e.key }));
  const F = {};

  // ---------------- Simple Entry ----------------
  F.noteDur = () => ({
    id: 'noteDur', title: '음표', current: inp.rest ? (mem.noteDur || 'quarter') : inp.base, active: app.mode === 'input' && !inp.rest,
    items: NOTE_VALUES.map(([id, label, key]) => ({ id, icon: noteIcon(id), label, key })),
    onPick: (it) => { remember('noteDur', it.id); if (app.mode !== 'input' && noteIds().length) { app.setInput({ base: it.id, rest: false }); app.exec('음길이', s => C.setDuration(s, selIds(), it.id, 0), keep()); return; } app.setInput({ base: it.id, rest: false, dots: 0 }); if (app.mode !== 'input') app.setTool('entry'); },
  });
  F.restDur = () => ({
    id: 'restDur', title: '쉼표', current: inp.rest ? inp.base : (mem.restDur || 'quarter'), active: app.mode === 'input' && inp.rest,
    items: REST_VALUES.map(([id, label]) => ({ id, icon: noteIcon(id, 0, { rest: true }), label, key: id === 'quarter' ? '0' : '' })),
    onPick: (it) => { remember('restDur', it.id); ui.paletteAction('restDuration', { base: it.id }); },
  });
  F.dots = () => ({
    id: 'dots', title: '점', current: inp.dots === 2 ? 'dot2' : 'dot', active: app.mode === 'input' && inp.dots > 0,
    items: [{ id: 'dot', icon: noteIcon('quarter', 1), label: '점음표', key: '.' }, { id: 'dot2', icon: noteIcon('quarter', 2), label: '겹점음표' }],
    onPick: (it) => ui.paletteAction(it.id === 'dot2' ? 'dot2' : 'dot'),
  });
  F.tuplet = () => ({
    id: 'tuplet', title: '잇단음표', current: mem.tuplet || '3', active: false,
    items: [['3', '셋잇단음표', '9'], ['2', '둘잇단음표'], ['4', '넷잇단음표'], ['5', '다섯잇단음표'], ['6', '여섯잇단음표'], ['7', '일곱잇단음표']].map(([id, label, key]) => ({ id, icon: tupletIcon(+id), label, key })),
    onPick: (it) => { remember('tuplet', it.id); ui.tuplet(+it.id); },
  });
  F.tie = () => ({ id: 'tie', title: '붙임줄', current: 'tie', active: !!inp.tie, items: [{ id: 'tie', icon: tieIcon(), label: '붙임줄', key: 'T' }], onPick: () => ui.paletteAction('tie') });
  F.grace = () => ({ id: 'grace', title: '꾸밈음', current: 'grace', active: !!inp.grace, items: [{ id: 'grace', icon: graceIcon(), label: '꾸밈음', key: 'Alt+G' }], onPick: () => ui.paletteAction('grace') });
  F.accidental = () => ({
    id: 'acc', title: '임시표', current: inp.accidental || mem.acc || 'sharp', active: !!inp.accidental,
    items: [['sharp', '올림표 ♯', '='], ['flat', '내림표 ♭', '-'], ['natural', '제자리표 ♮', 'N'], ['double-sharp', '겹올림표', '+'], ['double-flat', '겹내림표', '_']].map(([id, label, key]) => ({ id, icon: accidentalIcon(id), label, key })),
    onPick: (it) => { remember('acc', it.id); ui.paletteAction('accidental', { acc: it.id }); },
  });
  F.voice = () => ({
    id: 'voice', title: '성부', current: String(inp.voice || 0), active: false, showLabel: false,
    items: [0, 1, 2, 3].map(v => ({ id: String(v), icon: textIcon(String(v + 1), { bold: true, size: 2.6 }), label: `${v + 1}성부 (레이어 ${v + 1})`, key: `Alt+Shift+${v + 1}` })),
    onPick: (it) => ui.paletteAction('voice', { v: +it.id }),
  });

  // ---------------- selection context ----------------
  F.pitchMore = () => ({
    id: 'pitchMore', title: '음높이 옮기기', current: mem.pitchMore || 'oct+', active: false,
    items: [['semi+', '반음 올림', 'Alt+↑', '<b class="ob-num">♯½</b>'], ['semi-', '반음 내림', 'Alt+↓', '<b class="ob-num">♭½</b>'], ['oct+', '옥타브 올림', '9', '<b class="ob-num">8va</b>'], ['oct-', '옥타브 내림', '8', '<b class="ob-num">8vb</b>'], ['respell', '이명동음 바꾸기', '\\', '<b class="ob-num">♯↔♭</b>'], ['transpose', '조옮김…', '', icon('refresh')]].map(([id, label, key, ic]) => ({ id, icon: ic, label, key })),
    onPick: (it) => { remember('pitchMore', it.id); ({ 'semi+': () => app.transposeSelection({ semitones: 1 }), 'semi-': () => app.transposeSelection({ semitones: -1 }), 'oct+': () => app.transposeSelection({ octaves: 1 }), 'oct-': () => app.transposeSelection({ octaves: -1 }), respell: () => ui.paletteAction('respell'), transpose: () => ui.transposeDialog() })[it.id](); },
  });
  F.selDur = () => ({
    id: 'selDur', title: '음길이', current: (() => { const f = selIds().length ? findEvent(app.score, selIds()[0]) : null; return f?.ev.dur.base || 'quarter'; })(), active: false,
    items: NOTE_VALUES.map(([id, label, key]) => ({ id, icon: noteIcon(id), label, key: 'Alt+' + key })),
    onPick: (it) => app.exec('음길이', s => C.setDuration(s, selIds(), it.id, 0), keep()),
  });
  F.selShape = () => ({
    id: 'selShape', title: '이음줄·셈여림 기호·8va', current: mem.selShape || 'slur', active: false,
    items: shapeItems(SHAPES.map(s => s.id)),
    onPick: (it) => { remember('selShape', it.id); const sp = ui.selectionSpan(); if (!sp) { ui.toast('먼저 음표를 선택하세요', 'warn'); return; } createShape(app, it.id, sp.first.ev.id, sp.single ? null : sp.last.ev.id); },
  });
  F.selArtic = () => ({
    id: 'selArtic', title: '아티큘레이션', current: mem.selArtic || 'staccato', active: false,
    items: articItems(ARTICS.map(a => a.id)),
    onPick: (it) => { remember('selArtic', it.id); applyArticulation(app, selIds(), it.id); },
  });
  F.selDyn = () => ({
    id: 'selDyn', title: '셈여림', current: mem.selDyn || 'mf', active: false,
    items: exprItems(e => e.kind === 'dyn'),
    onPick: (it) => { remember('selDyn', it.id); const id = selIds()[0]; if (id) applyExpression(app, ui, it.id, { eventId: id }); },
  });
  F.selText = () => ({
    id: 'selText', title: '가사·코드·텍스트', current: mem.selText || 'lyrics', active: false,
    items: [{ id: 'lyrics', icon: icon('lyrics'), label: '가사', key: 'Ctrl+L' }, { id: 'chord', icon: icon('chord'), label: '코드', key: 'Ctrl+K' }, { id: 'text', icon: textIcon('Abc', { size: 1.7 }), label: '텍스트', key: 'Ctrl+T' }, { id: 'fingering', icon: textIcon('1 2 3', { size: 1.4 }), label: '운지 번호' }],
    onPick: (it) => { remember('selText', it.id); ({ lyrics: () => ui.startLyricEntry(ui.lyricVerse || 1), chord: () => ui.startChordEntry(), text: () => ui.addTextDialog('expression'), fingering: () => ui.fingeringDialog() })[it.id](); },
  });

  // ---------------- measures ----------------
  F.keySig = () => ({
    id: 'keySig', title: '조표', current: String(mem.keySig ?? 1), active: false,
    items: [...Array(15).keys()].map(i => i - 7).map(f => ({ id: String(f), icon: keySigIcon(f), label: `${KEY_NAMES[f]} 장조 / ${KEY_NAMES_MINOR[f]}` })),
    onPick: (it) => { remember('keySig', +it.id); ui.paletteAction('keysig', { fifths: +it.id }); },
  });
  F.timeSig = () => ({
    id: 'timeSig', title: '박자표', current: mem.timeSig || '4/4', active: false,
    items: [[4, 4], [3, 4], [2, 4], [6, 8], [2, 2], [3, 8], [9, 8], [12, 8], [5, 4], [7, 8]].map(([n, d]) => ({ id: `${n}/${d}`, icon: timeSigIcon(n, d), label: `${n}/${d}` })).concat([{ id: 'C', icon: glyphIcon('timeSigCommon', { y: 0, s: 1.1 }), label: '공통 박자 (C)' }, { id: 'cut', icon: glyphIcon('timeSigCutCommon', { y: 0, s: 1.1 }), label: '알라 브레베 (₵)' }, { id: 'custom', icon: textIcon('?/?', { size: 1.8 }), label: '직접 입력…' }]),
    onPick: (it) => { remember('timeSig', it.id); if (it.id === 'custom') ui.paletteAction('timesigCustom'); else if (it.id === 'C') ui.paletteAction('timesig', { num: 4, den: 4, display: 'common' }); else if (it.id === 'cut') ui.paletteAction('timesig', { num: 2, den: 2, display: 'cut' }); else { const [n, d] = it.id.split('/').map(Number); ui.paletteAction('timesig', { num: n, den: d }); } },
  });
  F.clef = () => ({
    id: 'clef', title: '음자리표', current: mem.clef || 'treble', active: false,
    items: [['treble', '높은음자리표'], ['bass', '낮은음자리표'], ['alto', '알토 음자리표'], ['tenor', '테너 음자리표'], ['treble8vb', '높은음자리표 8vb (기타)'], ['bass8vb', '낮은음자리표 8vb']].map(([id, label]) => ({ id, icon: clefIcon(id), label })),
    onPick: (it) => { remember('clef', it.id); ui.paletteAction('clef', { clef: it.id }); },
  });
  F.barline = () => ({
    id: 'barline', title: '세로줄', current: mem.barline || 'double', active: false,
    items: [['single', '보통 세로줄'], ['double', '겹세로줄'], ['final', '끝세로줄'], ['dashed', '점선 세로줄'], ['none', '세로줄 없음']].map(([id, label]) => ({ id, icon: barlineIcon(id), label })),
    onPick: (it) => { remember('barline', it.id); ui.paletteAction('barline', { type: it.id }); },
  });
  F.repeat = () => ({
    id: 'repeat', title: '도돌이표·반복 기호', current: mem.repeat || 'rep-start', active: false,
    items: [
      { id: 'rep-start', icon: barlineIcon('repeat-start'), label: '도돌이표 시작' }, { id: 'rep-end', icon: barlineIcon('repeat-end'), label: '도돌이표 끝' },
      { id: 'volta1', icon: textIcon('1.', { size: 1.8 }), label: '1번 괄호' }, { id: 'volta2', icon: textIcon('2.', { size: 1.8 }), label: '2번 괄호' },
      { id: 'segno', icon: glyphIcon('segno', { y: 1.5, s: 0.8 }), label: 'Segno (세뇨)' }, { id: 'coda', icon: glyphIcon('coda', { y: 1.5, s: 0.9 }), label: 'Coda (코다)' },
      { id: 'fine', icon: textIcon('Fine', { italic: true, bold: true, size: 1.6 }), label: 'Fine (끝)' }, { id: 'toCoda', icon: textIcon('To ⊕', { italic: true, size: 1.5 }), label: 'To Coda' },
      { id: 'dsAlCoda', icon: textIcon('D.S.', { italic: true, bold: true, size: 1.5 }), label: 'D.S. al Coda' }, { id: 'dcAlFine', icon: textIcon('D.C.', { italic: true, bold: true, size: 1.5 }), label: 'D.C. al Fine' },
    ],
    onPick: (it) => { remember('repeat', it.id); if (it.id === 'rep-start') ui.paletteAction('barline', { type: 'repeat-start' }); else if (it.id === 'rep-end') ui.paletteAction('barline', { type: 'repeat-end' }); else if (it.id === 'volta1' || it.id === 'volta2') ui.paletteAction('volta', { number: it.id === 'volta1' ? '1.' : '2.' }); else ui.paletteAction('marker', { marker: it.id }); },
  });
  F.measureOps = () => ({
    id: 'measureOps', title: '마디', current: mem.measureOps || 'insert', active: false,
    items: [{ id: 'insert', icon: icon('left'), label: '앞에 마디 삽입', key: 'Ctrl+Ins' }, { id: 'add', icon: icon('plus'), label: '끝에 마디 추가', key: 'Ctrl+B' }, { id: 'delete', icon: icon('trash'), label: '마디 삭제', key: 'Ctrl+Del' }, { id: 'sys', icon: icon('reflow'), label: '여기서 줄 바꿈' }, { id: 'page', icon: icon('pageSingle'), label: '여기서 페이지 나눔' }, { id: 'pickup', icon: textIcon('못갖춘', { size: 1.2 }), label: '못갖춘마디' }],
    onPick: (it) => { remember('measureOps', it.id); ({ insert: () => ui.paletteAction('insertMeasure'), add: () => ui.paletteAction('addMeasure'), delete: () => ui.deleteMeasures(), sys: () => ui.paletteAction('break', { kind: 'system' }), page: () => ui.paletteAction('break', { kind: 'page' }), pickup: () => ui.paletteAction('pickup') })[it.id](); },
  });

  // ---------------- Smart Shape / Articulation / Expression tools (palette item = tool item) ----------------
  const toolGroup = (tool, id, title, items) => ({
    id, title, items, current: items.some(it => it.id === app.toolItem[tool]) ? app.toolItem[tool] : (mem[id] || items[0].id),
    active: app.tool === tool && items.some(it => it.id === app.toolItem[tool]),
    onPick: (it) => { remember(id, it.id); if (app.tool !== tool) app.setTool(tool); app.setToolItem(tool, it.id); },
  });
  F.shapeSlur = () => toolGroup('shape', 'shSlur', '이음줄', shapeItems(['slur']));
  F.shapeHairpin = () => toolGroup('shape', 'shHair', '크레셴도·디크레셴도', shapeItems(['cresc', 'dim']));
  F.shapeOctave = () => toolGroup('shape', 'shOct', '옥타브 기호', shapeItems(['8va', '8vb', '15ma']));
  F.shapeLine = () => toolGroup('shape', 'shLine', '트릴·페달·선', shapeItems(['trill', 'pedal', 'gliss', 'line']));
  F.articStacc = () => toolGroup('artic', 'arStac', '스타카토 종류', articItems(['staccato', 'staccatissimo', 'tenuto-staccato', 'accent-staccato', 'marcato-staccato']));
  F.articAccent = () => toolGroup('artic', 'arAcc', '악센트·테누토', articItems(['accent', 'marcato', 'tenuto', 'tenuto-accent']));
  F.articFermata = () => toolGroup('artic', 'arFer', '늘임표', articItems(['fermata']));
  F.articOrn = () => toolGroup('artic', 'arOrn', '꾸밈 (트릴·모르덴트·턴)', articItems(['trill', 'mordent', 'inverted-mordent', 'turn']));
  F.articOther = () => toolGroup('artic', 'arOth', '아르페지오·트레몰로', articItems(['arpeggio', 'tremolo']));
  F.exprDyn = () => toolGroup('expr', 'exDyn', '셈여림', exprItems(e => e.kind === 'dyn'));
  F.exprTempoAlt = () => toolGroup('expr', 'exTA', '빠르기 변화', exprItems(e => ['rit', 'accel', 'atempo'].includes(e.id)));
  F.exprText = () => toolGroup('expr', 'exTxt', '나타냄말', exprItems(e => ['cresc', 'dimtext', 'dolce', 'espress'].includes(e.id)));
  F.exprTech = () => toolGroup('expr', 'exTech', '연주법', exprItems(e => ['arco', 'pizz'].includes(e.id)));
  F.exprMark = () => toolGroup('expr', 'exMark', '리허설 마크·템포', exprItems(e => ['rehearsal', 'tempo'].includes(e.id)));
  F.verse = () => ({
    id: 'verse', title: '가사 절', current: String(ui.lyricVerse || 1), active: false,
    items: [1, 2, 3, 4, 5, 6].map(n => ({ id: String(n), icon: textIcon(String(n), { bold: true, size: 2.4 }), label: `${n}절`, key: '' })),
    onPick: (it) => { ui.lyricVerse = +it.id; ui.renderOptionsBar(); ui.toast(`${it.id}절 가사 — 음표를 클릭해 입력하세요`, 'info'); },
  });

  // ---------------- rail tool groups ----------------
  F.railTools = (gid, title, ids, defs) => ({
    id: gid, title, items: ids.map(id => defs.find(d => d.id === id)).map(d => ({ id: d.id, icon: icon(d.icon), label: d.label, key: d.key })),
    current: ids.includes(app.tool) ? app.tool : (mem[gid] || ids[0]), active: ids.includes(app.tool),
    onPick: (it) => { remember(gid, it.id); ui.railAction('tool:' + it.id); },
  });
  void t; void staffList;
  return F;
}
