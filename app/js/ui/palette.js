// Palette definitions and rendering. Actions are dispatched to the UI controller.
import { noteIcon, accidentalIcon, articIcon, dynamicIcon, clefIcon, keySigIcon, timeSigIcon, barlineIcon, textIcon, glyphIcon, slurIcon, tieIcon, hairpinIcon, tupletIcon, graceIcon, drumIcon, icon } from './icons.js';
import { KEY_NAMES, KEY_NAMES_MINOR, staffList } from '../model/score.js';
import { t } from '../i18n.js';
import { groupHTML, bindGroups, closeFlyout } from './flyout.js';
import { groupFactory } from './groups.js';
import { applyArticulation, applyExpression } from '../editor/tools.js';

export const DURATIONS = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];
const DUR_KEY = { whole: '7', half: '6', quarter: '5', eighth: '4', '16th': '3', '32nd': '2', '64th': '1' };
const REST_LABEL = { breve: '겹온쉼표', whole: '온쉼표', half: '2분쉼표', quarter: '4분쉼표', eighth: '8분쉼표', '16th': '16분쉼표', '32nd': '32분쉼표', '64th': '64분쉼표' };

export function paletteTabs(app) {
  const staff = staffList(app.score)[app.cursor?.si ?? 0]?.staff;
  const tabs = [
    { id: 'notes', label: t('notes') },
    { id: 'accidentals', label: t('accidentals') },
    { id: 'marks', label: '기호' },
    { id: 'dynamics', label: t('dynamics') },
    { id: 'texts', label: t('texts') },
    { id: 'measures', label: t('barlines') },
    { id: 'keys', label: t('keys') },
    { id: 'heads', label: '머리 모양', adv: true },
  ];
  if (staff?.type === 'percussion' || app.score.parts.some(p => p.staves.some(s => s.type === 'percussion'))) tabs.splice(1, 0, { id: 'drums', label: t('drums') });
  return tabs;
}

/** Returns sections [{title, items:[{id, icon, label, key, on, adv, act, args}]}] for a tab. */
export function paletteSections(app, tabId) {
  const inp = app.input;
  const sel = app.selection;
  const S = (title, items) => ({ title, items });
  switch (tabId) {
    case 'notes': return [
      S(t('duration'), DURATIONS.map(d => ({ id: 'dur-' + d, icon: noteIcon(d), label: t(d), key: DUR_KEY[d], on: inp.base === d && !inp.rest, act: 'duration', args: { base: d }, adv: d === '64th' }))),
      S('쉼표', ['breve', ...DURATIONS].map(d => ({ id: 'rest-' + d, icon: noteIcon(d, 0, { rest: true }), label: REST_LABEL[d], key: d === 'quarter' ? '0' : '', on: inp.rest && inp.base === d, act: 'restDuration', args: { base: d }, adv: d === 'breve' || d === '64th' }))),
      S('', [
        { id: 'dot', icon: noteIcon('quarter', 1), label: t('dot'), key: '.', on: inp.dots === 1, act: 'dot' },
        { id: 'dot2', icon: noteIcon('quarter', 2), label: '겹점', on: inp.dots === 2, act: 'dot2', adv: true },
        { id: 'tie', icon: tieIcon(), label: t('tie'), key: '+', on: inp.tie, act: 'tie' },
        { id: 'tuplet3', icon: tupletIcon(3), label: '셋잇단', key: 'Ctrl+3', act: 'tuplet', args: { n: 3 } },
        { id: 'tuplet5', icon: tupletIcon(5), label: '다섯잇단', key: 'Ctrl+5', act: 'tuplet', args: { n: 5 }, adv: true },
        { id: 'tuplet6', icon: tupletIcon(6), label: '여섯잇단', key: 'Ctrl+6', act: 'tuplet', args: { n: 6 }, adv: true },
        { id: 'tuplet2', icon: tupletIcon(2), label: '둘잇단', key: 'Ctrl+2', act: 'tuplet', args: { n: 2 }, adv: true },
        { id: 'grace', icon: graceIcon(), label: t('grace'), on: inp.grace, act: 'grace', adv: true },
      ]),
      S(t('voice'), [1, 2, 3, 4].map(v => ({ id: 'voice' + v, icon: textIcon(String(v), { bold: true, size: 2.6 }), label: `${v}성부`, on: inp.voice === v - 1, act: 'voice', args: { v: v - 1 }, adv: v > 2 }))),
      S('입력 도구', [
        { id: 'mode', icon: icon('noteInput'), label: app.mode === 'input' ? '입력 끄기' : '입력 모드', key: 'N', on: app.mode === 'input', act: 'toggleMode' },
        { id: 'piano', icon: icon('piano'), label: '피아노 건반', act: 'pianoKeyboard' },
      ]),
    ];
    case 'accidentals': return [S('', [
      { id: 'acc-sharp', icon: accidentalIcon('sharp'), label: t('sharp'), on: inp.accidental === 'sharp', act: 'accidental', args: { acc: 'sharp' } },
      { id: 'acc-flat', icon: accidentalIcon('flat'), label: t('flat'), on: inp.accidental === 'flat', act: 'accidental', args: { acc: 'flat' } },
      { id: 'acc-natural', icon: accidentalIcon('natural'), label: t('natural'), on: inp.accidental === 'natural', act: 'accidental', args: { acc: 'natural' } },
      { id: 'acc-ds', icon: accidentalIcon('double-sharp'), label: t('doubleSharp'), on: inp.accidental === 'double-sharp', act: 'accidental', args: { acc: 'double-sharp' }, adv: true },
      { id: 'acc-df', icon: accidentalIcon('double-flat'), label: t('doubleFlat'), on: inp.accidental === 'double-flat', act: 'accidental', args: { acc: 'double-flat' }, adv: true },
      { id: 'acc-none', icon: textIcon('—'), label: '임시표 없음', act: 'accidental', args: { acc: 'none' }, adv: true },
      { id: 'respell', icon: textIcon('♯↔♭', { size: 1.6 }), label: '이명동음', act: 'respell', adv: true },
    ])];
    case 'marks': return [
      S(t('articulations'), [
        { id: 'staccato', icon: articIcon('staccato'), label: t('staccato'), act: 'articulation', args: { art: 'staccato' } },
        { id: 'accent', icon: articIcon('accent'), label: t('accent'), act: 'articulation', args: { art: 'accent' } },
        { id: 'tenuto', icon: articIcon('tenuto'), label: t('tenuto'), act: 'articulation', args: { art: 'tenuto' } },
        { id: 'marcato', icon: articIcon('marcato'), label: t('marcato'), act: 'articulation', args: { art: 'marcato' }, adv: true },
        { id: 'staccatissimo', icon: articIcon('staccatissimo'), label: t('staccatissimo'), act: 'articulation', args: { art: 'staccatissimo' }, adv: true },
        { id: 'tenuto-staccato', icon: articIcon('tenuto-staccato'), label: '테누토-스타카토', act: 'articulation', args: { art: 'tenuto-staccato' }, adv: true },
        { id: 'fermata', icon: glyphIcon('fermataAbove', { y: 1.2, s: 1.1 }), label: t('fermata'), act: 'fermata' },
      ]),
      S(t('ornaments'), [
        { id: 'trill', icon: glyphIcon('ornamentTrill', { y: 1, s: 0.9 }), label: t('trill'), act: 'ornament', args: { orn: 'trill' } },
        { id: 'turn', icon: glyphIcon('ornamentTurn', { y: 0, s: 1 }), label: '턴', act: 'ornament', args: { orn: 'turn' }, adv: true },
        { id: 'mordent', icon: glyphIcon('ornamentMordent', { y: 0, s: 1 }), label: '모르덴트', act: 'ornament', args: { orn: 'mordent' }, adv: true },
        { id: 'inv-mordent', icon: glyphIcon('ornamentShortTrill', { y: 0, s: 1 }), label: '프랄트릴러', act: 'ornament', args: { orn: 'inverted-mordent' }, adv: true },
        { id: 'arpeggio', icon: glyphIcon('arpeggiato', { y: -2, s: 0.9 }), label: '아르페지오', act: 'arpeggio' },
        { id: 'tremolo', icon: glyphIcon('tremolo2', { y: 0, s: 1.2 }), label: '트레몰로', act: 'tremolo', adv: true },
        { id: 'glissando', icon: textIcon('gliss.', { italic: true, size: 1.5 }), label: t('glissando'), act: 'spanner', args: { type: 'glissando' }, adv: true },
      ]),
    ];
    case 'dynamics': return [
      S(t('dynamics'), ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'ppp', 'fff', 'sfz', 'fp'].map(d => ({ id: 'dyn-' + d, icon: dynamicIcon(d), label: d, act: 'dynamic', args: { dyn: d }, adv: ['ppp', 'fff', 'sfz', 'fp'].includes(d) }))),
      S(t('lines'), [
        { id: 'cresc', icon: hairpinIcon('crescendo'), label: t('crescendo'), act: 'spanner', args: { type: 'crescendo' } },
        { id: 'dim', icon: hairpinIcon('diminuendo'), label: t('diminuendo'), act: 'spanner', args: { type: 'diminuendo' } },
        { id: 'slur', icon: slurIcon(), label: t('slur'), key: 'S', act: 'slur' },
        { id: '8va', icon: glyphIcon('ottavaAlta', { y: 1, s: 0.75 }), label: '8va', act: 'spanner', args: { type: 'ottava', octaveShift: 8 }, adv: true },
        { id: '8vb', icon: glyphIcon('ottavaBassa', { y: 1, s: 0.75 }), label: '8vb', act: 'spanner', args: { type: 'ottava', octaveShift: -8 }, adv: true },
        { id: 'pedal', icon: glyphIcon('keyboardPedalPed', { y: 1, s: 0.8 }), label: t('pedal'), act: 'spanner', args: { type: 'pedal' }, adv: true },
        { id: 'trill-line', icon: textIcon('tr~~', { italic: true, size: 1.6 }), label: '트릴 선', act: 'spanner', args: { type: 'trill' }, adv: true },
      ]),
    ];
    case 'texts': return [S('', [
      { id: 'lyric', icon: icon('lyrics'), label: t('lyric'), key: 'Ctrl+L', act: 'lyrics' },
      { id: 'lyrics-line', icon: textIcon('가나다', { size: 1.5 }), label: '가사 한 줄 붙이기', act: 'lyricsLine' },
      { id: 'chord', icon: textIcon('C7', { bold: true, size: 2 }), label: t('chordSymbol'), key: 'Ctrl+K', act: 'chord' },
      { id: 'tempo', icon: textIcon('♩=120', { bold: true, size: 1.4 }), label: t('tempo'), act: 'tempo' },
      { id: 'expr', icon: textIcon('dolce', { italic: true, size: 1.5 }), label: t('expression'), act: 'text', args: { style: 'expression' } },
      { id: 'stafftext', icon: textIcon('Abc', { size: 1.7 }), label: '스태프 텍스트', key: 'Ctrl+T', act: 'text', args: { style: 'plain' } },
      { id: 'rehearsal', icon: textIcon('A', { bold: true, size: 2.2 }), label: t('rehearsal'), key: 'Ctrl+M', act: 'rehearsal' },
      { id: 'fingering', icon: textIcon('1 2 3', { size: 1.4 }), label: '운지 번호', act: 'fingering', adv: true },
      { id: 'meta', icon: icon('pencil'), label: '제목/작곡가', act: 'meta' },
    ])];
    case 'measures': return [
      S(t('barline'), [
        { id: 'bl-single', icon: barlineIcon('single'), label: '보통', act: 'barline', args: { type: 'single' } },
        { id: 'bl-double', icon: barlineIcon('double'), label: t('double'), act: 'barline', args: { type: 'double' } },
        { id: 'bl-final', icon: barlineIcon('final'), label: t('final'), act: 'barline', args: { type: 'final' } },
        { id: 'bl-rs', icon: barlineIcon('repeat-start'), label: t('repeatStart'), act: 'barline', args: { type: 'repeat-start', side: 'left' } },
        { id: 'bl-re', icon: barlineIcon('repeat-end'), label: t('repeatEnd'), act: 'barline', args: { type: 'repeat-end' } },
        { id: 'bl-dashed', icon: barlineIcon('dashed'), label: '점선', act: 'barline', args: { type: 'dashed' }, adv: true },
        { id: 'bl-none', icon: barlineIcon('none'), label: '없음', act: 'barline', args: { type: 'none' }, adv: true },
      ]),
      S(t('repeats'), [
        { id: 'volta1', icon: textIcon('1.', { size: 1.8 }), label: '1번 괄호', act: 'volta', args: { number: '1.' } },
        { id: 'volta2', icon: textIcon('2.', { size: 1.8 }), label: '2번 괄호', act: 'volta', args: { number: '2.' } },
        { id: 'segno', icon: glyphIcon('segno', { y: 1.5, s: 0.8 }), label: 'Segno', act: 'marker', args: { marker: 'segno' }, adv: true },
        { id: 'coda', icon: glyphIcon('coda', { y: 1.5, s: 0.9 }), label: 'Coda', act: 'marker', args: { marker: 'coda' }, adv: true },
        { id: 'fine', icon: textIcon('Fine', { italic: true, bold: true, size: 1.6 }), label: 'Fine', act: 'marker', args: { marker: 'fine' }, adv: true },
        { id: 'tocoda', icon: textIcon('To ⊕', { italic: true, size: 1.5 }), label: 'To Coda', act: 'marker', args: { marker: 'toCoda' }, adv: true },
        { id: 'dsalcoda', icon: textIcon('D.S.', { italic: true, bold: true, size: 1.5 }), label: 'D.S. al Coda', act: 'marker', args: { marker: 'dsAlCoda' }, adv: true },
        { id: 'dcalfine', icon: textIcon('D.C.', { italic: true, bold: true, size: 1.5 }), label: 'D.C. al Fine', act: 'marker', args: { marker: 'dcAlFine' }, adv: true },
      ]),
      S(t('measure'), [
        { id: 'm-add', icon: icon('plus'), label: '끝에 추가', key: 'Ctrl+B', act: 'addMeasure' },
        { id: 'm-insert', icon: icon('left'), label: '앞에 삽입', key: 'Ctrl+Ins', act: 'insertMeasure' },
        { id: 'm-del', icon: icon('trash'), label: '마디 삭제', key: 'Ctrl+Del', act: 'deleteMeasure' },
        { id: 'm-sys', icon: icon('reflow'), label: t('systemBreak'), act: 'break', args: { kind: 'system' } },
        { id: 'm-page', icon: icon('pageSingle'), label: t('pageBreak'), act: 'break', args: { kind: 'page' }, adv: true },
        { id: 'm-pickup', icon: textIcon('못갖춘', { size: 1.2 }), label: '못갖춘마디', act: 'pickup', adv: true },
      ]),
    ];
    case 'keys': return [
      S(t('keySig'), [...Array(15).keys()].map(i => i - 7).map(f => ({ id: 'key' + f, icon: keySigIcon(f), label: `${KEY_NAMES[f]} / ${KEY_NAMES_MINOR[f]}`, act: 'keysig', args: { fifths: f }, adv: Math.abs(f) > 4 }))),
      S(t('timeSig'), [[4, 4], [3, 4], [2, 4], [6, 8], [2, 2], [3, 8], [12, 8], [5, 4], [9, 8], [7, 8]].map(([n, d]) => ({ id: `ts${n}${d}`, icon: timeSigIcon(n, d), label: `${n}/${d}`, act: 'timesig', args: { num: n, den: d }, adv: n >= 5 || (n === 9) })).concat([{ id: 'ts-c', icon: glyphIcon('timeSigCommon', { y: 0, s: 1.1 }), label: 'C', act: 'timesig', args: { num: 4, den: 4, display: 'common' }, adv: true }, { id: 'ts-custom', icon: textIcon('?/?', { size: 1.8 }), label: '직접 입력', act: 'timesigCustom' }])),
      S(t('clef'), ['treble', 'bass', 'alto', 'tenor', 'treble8vb', 'percussion', 'tab'].map(c => ({ id: 'clef-' + c, icon: clefIcon(c), label: { treble: '높은음자리표', bass: '낮은음자리표', alto: '알토', tenor: '테너', treble8vb: '기타(8vb)', percussion: '타악기', tab: 'TAB' }[c], act: 'clef', args: { clef: c }, adv: ['alto', 'tenor', 'treble8vb'].includes(c) }))),
    ];
    case 'drums': {
      const staff = staffList(app.score).find((s, i) => i === (app.cursor?.si ?? 0) && s.staff.type === 'percussion')?.staff || staffList(app.score).find(s => s.staff.type === 'percussion')?.staff;
      const dm = staff?.drumMap || {};
      const keys = { kick: 'A', snare: 'B', 'hihat-closed': 'C', 'hihat-open': 'D', 'tom-high': 'E', 'floor-tom': 'F', crash: 'G', ride: 'H' };
      return [S('드럼 패드 (선택 후 입력)', Object.entries(dm).map(([k, v]) => ({ id: 'drum-' + k, icon: drumIcon(k), label: v.name || k, key: keys[k], on: inp.drum === k, act: 'drum', args: { drum: k }, adv: ['china', 'splash', 'rimshot', 'ride-bell', 'cowbell', 'tom-mid'].includes(k) })))];
    }
    case 'heads': return [S('', ['normal', 'x', 'circle-x', 'diamond', 'diamond-black', 'triangle', 'triangle-black', 'square', 'slash', 'plus'].map(h => ({ id: 'head-' + h, icon: glyphIcon({ normal: 'noteheadBlack', x: 'noteheadX', 'circle-x': 'noteheadCircleX', diamond: 'noteheadDiamondWhite', 'diamond-black': 'noteheadDiamondBlack', triangle: 'noteheadTriangleUpWhite', 'triangle-black': 'noteheadTriangleUpBlack', square: 'noteheadSquareWhite', slash: 'noteheadSlash', plus: 'noteheadPlus' }[h], { y: 0, s: 1.3 }), label: h === 'normal' ? '기본' : h, act: 'notehead', args: { head: h } })))];
    default: return [];
  }
  void sel;
}

/** Palette tab → grouped tiles (Photoshop-style: one tile per family, hover to choose the variant). */
function paletteGroups(app, ui, tabId) {
  const F = groupFactory(app, ui);
  const one = (id, title, ic, label, key, onPick, active = false) => ({ id, title, items: [{ id, icon: ic, label, key }], current: id, active, onPick });
  const staff = staffList(app.score)[app.cursor?.si ?? 0]?.staff;
  switch (tabId) {
    case 'notes': return [
      F.noteDur(), F.restDur(), F.dots(), F.tuplet(), F.tie(), F.grace(), F.voice(),
      { ...one('mode', '음표 입력', icon('noteInput'), app.mode === 'input' ? '음표 입력 끄기' : '음표 입력 켜기', 'N', () => ui.paletteAction('toggleMode'), app.mode === 'input'), sub: app.mode === 'input' ? '켜짐 · N 키' : '꺼짐 · N 키' },
      one('piano', '피아노 건반', icon('piano'), '피아노 건반', '', () => ui.paletteAction('pianoKeyboard'), !!ui.piano?.visible),
    ];
    case 'accidentals': return [F.accidental(), one('respell', '이명동음 바꾸기', textIcon('♯↔♭', { size: 1.6 }), '이명동음', '\\', () => ui.paletteAction('respell')), one('acc-none', '임시표 숨기기', textIcon('—'), '임시표 없음', '', () => ui.paletteAction('accidental', { acc: 'none' }))];
    case 'marks': return [
      paletteArtic(F.articStacc()), paletteArtic(F.articAccent()), paletteArtic(F.articFermata()), paletteArtic(F.articOrn()), paletteArtic(F.articOther()),
      one('gliss', '글리산도', textIcon('gliss.', { italic: true, size: 1.5 }), '글리산도', '', () => ui.paletteAction('spanner', { type: 'glissando' })),
    ];
    case 'dynamics': return [
      paletteDyn(F.exprDyn()),
      { ...F.shapeHairpin(), onPick: (it) => ui.paletteAction('spanner', { type: it.id === 'cresc' ? 'crescendo' : 'diminuendo' }), active: false },
      one('slur', '이음줄', slurIcon(), '이음줄', 'S', () => ui.paletteAction('slur')),
      { ...F.shapeOctave(), onPick: (it) => ui.paletteAction('spanner', { type: 'ottava', octaveShift: { '8va': 8, '8vb': -8, '15ma': 15 }[it.id] }), active: false },
      { ...F.shapeLine(), onPick: (it) => ui.paletteAction('spanner', { type: { trill: 'trill', pedal: 'pedal', gliss: 'glissando', line: 'textLine' }[it.id] }), active: false },
    ];
    case 'texts': return [
      { id: 'lyricsG', title: '가사', items: [{ id: 'lyric', icon: icon('lyrics'), label: '가사 입력', key: 'Ctrl+L' }, { id: 'line', icon: textIcon('가나다', { size: 1.5 }), label: '가사 한꺼번에 붙이기' }], current: 'lyric', onPick: (it) => it.id === 'lyric' ? ui.paletteAction('lyrics') : ui.paletteAction('lyricsLine') },
      one('chord', '코드 기호', textIcon('C7', { bold: true, size: 2 }), '코드', 'Ctrl+K', () => ui.paletteAction('chord')),
      one('tempo', '빠르기 (템포)', textIcon('♩=120', { bold: true, size: 1.4 }), '템포', '', () => ui.paletteAction('tempo')),
      { id: 'textG', title: '텍스트', items: [{ id: 'expr', icon: textIcon('dolce', { italic: true, size: 1.5 }), label: '나타냄말 (음표에)' }, { id: 'staff', icon: textIcon('Abc', { size: 1.7 }), label: '스태프 텍스트', key: 'Ctrl+T' }, { id: 'fing', icon: textIcon('1 2 3', { size: 1.4 }), label: '운지 번호' }], current: 'expr', onPick: (it) => ({ expr: () => ui.paletteAction('text', { style: 'expression' }), staff: () => ui.paletteAction('text', { style: 'plain' }), fing: () => ui.paletteAction('fingering') })[it.id]() },
      one('rehearsal', '리허설 마크', textIcon('A', { bold: true, size: 2.2 }), '리허설 마크', 'Ctrl+M', () => ui.paletteAction('rehearsal')),
      one('meta', '제목·작곡가', icon('pencil'), '제목/작곡가', '', () => ui.paletteAction('meta')),
    ];
    case 'measures': return [F.barline(), F.repeat(), F.measureOps()];
    case 'keys': return [F.keySig(), F.timeSig(), F.clef()];
    case 'heads': return [{ id: 'heads', title: '음표 머리 모양', items: ['normal', 'x', 'circle-x', 'diamond', 'diamond-black', 'triangle', 'triangle-black', 'square', 'slash', 'plus'].map(h => ({ id: h, icon: glyphIcon({ normal: 'noteheadBlack', x: 'noteheadX', 'circle-x': 'noteheadCircleX', diamond: 'noteheadDiamondWhite', 'diamond-black': 'noteheadDiamondBlack', triangle: 'noteheadTriangleUpWhite', 'triangle-black': 'noteheadTriangleUpBlack', square: 'noteheadSquareWhite', slash: 'noteheadSlash', plus: 'noteheadPlus' }[h], { y: 0, s: 1.3 }), label: { normal: '기본', x: 'X', 'circle-x': '원 X', diamond: '다이아몬드', 'diamond-black': '검은 다이아몬드', triangle: '세모', 'triangle-black': '검은 세모', square: '네모', slash: '빗금', plus: '+' }[h] })), current: ui.flyMem?.heads || 'x', onPick: (it) => { (ui.flyMem || (ui.flyMem = {})).heads = it.id; ui.paletteAction('notehead', { head: it.id }); } }];
    case 'drums': return null;   // drum pads stay a flat grid (each pad is played directly)
    default: return [];
  }
  function paletteArtic(g) { return { ...g, active: false, onPick: (it) => { (ui.flyMem || (ui.flyMem = {}))[g.id] = it.id; const ids = app.selectedEventIds(); if (ids.length) applyArticulation(app, ids, it.id); else { app.setTool('artic'); app.setToolItem('artic', it.id); ui.toast(`${it.label} — 음표를 클릭하면 붙습니다`, 'info'); } } }; }
  function paletteDyn(g) { return { ...g, active: false, onPick: (it) => { (ui.flyMem || (ui.flyMem = {}))[g.id] = it.id; const ids = app.selectedEventIds(); if (ids.length) applyExpression(app, ui, it.id, { eventId: ids[0] }); else { app.setTool('expr'); app.setToolItem('expr', it.id); ui.toast(`${it.label} — 음표를 클릭하면 붙습니다`, 'info'); } } }; }
  void staff;
}

export function renderPalette(el, app, ui, state) {
  closeFlyout();
  const tabs = paletteTabs(app);
  if (!tabs.some(tb => tb.id === state.tab)) state.tab = tabs[0].id;
  const beginner = app.settings.tips;
  const head = `
    <div class="panel-head"><span>${t('palette')}</span><span class="sub">${app.mode === 'input' ? '입력 모드' : '마우스를 올리면 종류 선택'}</span></div>
    <div class="pal-search"><input type="search" placeholder="기호 검색… (예: 8분쉼표, 셋잇단, 도돌이)" value="${state.query || ''}" aria-label="기호 검색"></div>
    <div class="tabs">${tabs.filter(tb => !beginner || !tb.adv).map(tb => `<button data-tab="${tb.id}" class="${tb.id === state.tab ? 'on' : ''}">${tb.label}</button>`).join('')}</div>`;
  const groups = !state.query ? paletteGroups(app, ui, state.tab) : null;
  let body;
  let flat = [];
  if (groups) body = `<div class="palette-body"><div class="pal-groups">${groups.map(g => groupHTML(g, 'tile')).join('')}</div></div>`;
  else {
    // search (or drum pads): flat list of matching items across tabs
    const tabIds = state.query ? tabs.map(tb => tb.id) : [state.tab];
    const sections = tabIds.flatMap(id => paletteSections(app, id)).map(s => ({ ...s, items: s.items.filter(it => !state.query || (it.label + ' ' + it.id).toLowerCase().includes(state.query.toLowerCase())) })).filter(s => s.items.length);
    flat = sections.flatMap(s => s.items);
    body = `<div class="palette-body">${sections.map(s => `<div class="pal-section">${s.title ? `<h4>${s.title}</h4>` : ''}<div class="pal-grid">${s.items.map(it => `<button class="pal-item ${it.on ? 'on' : ''}" data-id="${it.id}" title="${it.label}${it.key ? ` (${it.key})` : ''}">${it.icon}<span class="lbl">${it.label}</span>${it.key && it.key.length <= 3 ? `<span class="key">${it.key}</span>` : ''}</button>`).join('')}</div></div>`).join('') || '<div class="empty-state">검색 결과가 없습니다.</div>'}</div>`;
  }
  el.innerHTML = head + body + `<label class="beginner-toggle"><input type="checkbox" ${beginner ? 'checked' : ''}> 간단 모드 (자주 쓰는 탭만)</label>`;
  el.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.query = ''; renderPalette(el, app, ui, state); }));
  const search = el.querySelector('.pal-search input');
  search.addEventListener('input', () => { state.query = search.value; const pos = search.selectionStart; renderPalette(el, app, ui, state); const s2 = el.querySelector('.pal-search input'); s2.focus(); s2.setSelectionRange(pos, pos); });
  if (groups) bindGroups(el, groups, { placement: 'right' });
  el.querySelectorAll('.pal-item').forEach(b => b.addEventListener('click', () => { const it = flat.find(i => i.id === b.dataset.id); if (it) ui.paletteAction(it.act, it.args || {}); }));
  el.querySelector('.beginner-toggle input').addEventListener('change', e => { app.settings.tips = e.target.checked; app.saveSettings(); renderPalette(el, app, ui, state); ui.updateHint?.(); });
}
