// Minimal i18n: Korean first, English fallback.
const ko = {
  app: 'JSE', untitled: '제목 없음',
  file: '파일', edit: '편집', view: '보기', score: '악보', export: '내보내기', help: '도움말',
  new: '새 악보', open: '열기', scan: '사진으로 인식', save: '저장', saveAs: '다른 이름으로 저장', recent: '최근 파일',
  undo: '실행 취소', redo: '다시 실행', cut: '잘라내기', copy: '복사', paste: '붙여넣기', delete: '삭제', selectAll: '모두 선택', repeat: '반복(R)',
  play: '재생', stop: '정지', pause: '일시정지', tempo: '템포', metronome: '메트로놈',
  zoomIn: '확대', zoomOut: '축소', fitWidth: '폭 맞춤', fitPage: '페이지 맞춤', actual: '실제 크기',
  viewSingle: '한 페이지', viewVertical: '세로 연속', viewHorizontal: '가로 연속', viewGrid: '여러 페이지 한눈에', viewReflow: '화면 맞춤(연속)',
  palette: '기호 팔레트', inspector: '속성', pages: '페이지',
  notes: '음표', rests: '쉼표', accidentals: '임시표', articulations: '아티큘레이션', dynamics: '셈여림', lines: '선', texts: '텍스트', barlines: '마디', keys: '조표/박자', clefs: '음자리표', repeats: '반복/도돌이', ornaments: '꾸밈음', drums: '드럼', chords: '코드', lyrics: '가사',
  inputMode: '음표 입력 모드', selectMode: '선택 모드',
  duration: '음길이', dot: '점', tie: '붙임줄', rest: '쉼표', voice: '성부', grace: '꾸밈음(앞꾸밈)', tuplet: '잇단음표',
  whole: '온음표', half: '2분음표', quarter: '4분음표', eighth: '8분음표', '16th': '16분음표', '32nd': '32분음표', '64th': '64분음표', breve: '겹온음표',
  sharp: '올림표(♯)', flat: '내림표(♭)', natural: '제자리표(♮)', doubleSharp: '겹올림표', doubleFlat: '겹내림표',
  staccato: '스타카토', accent: '악센트', tenuto: '테누토', marcato: '마르카토', staccatissimo: '스타카티시모', fermata: '늘임표',
  crescendo: '크레셴도', diminuendo: '디미누엔도', slur: '이음줄', ottava: '옥타브 기호', pedal: '페달', trill: '트릴', glissando: '글리산도',
  title: '제목', subtitle: '부제', composer: '작곡', lyricist: '작사', arranger: '편곡', copyright: '저작권',
  pageSetup: '페이지 설정', instruments: '악기(파트)', addPart: '파트 추가', removePart: '파트 삭제',
  timeSig: '박자표', keySig: '조표', clef: '음자리표', measure: '마디', addMeasure: '마디 추가', insertMeasure: '앞에 마디 삽입', deleteMeasure: '마디 삭제',
  systemBreak: '줄 바꿈', pageBreak: '페이지 나눔', barline: '세로줄', repeatStart: '도돌이표 시작', repeatEnd: '도돌이표 끝', final: '끝세로줄', double: '겹세로줄', volta: '1., 2. 괄호',
  rehearsal: '리허설 마크', text: '텍스트', expression: '나타냄말', chordSymbol: '코드 기호', lyric: '가사',
  transposeUp: '반음 올림', transposeDown: '반음 내림', octaveUp: '옥타브 올림', octaveDown: '옥타브 내림', transpose: '조옮김',
  exportPdf: 'PDF', exportPng: 'PNG 이미지', exportJpg: 'JPG 이미지', exportSvg: 'SVG', exportMusicXml: 'MusicXML', exportMidi: 'MIDI', exportSsnap: 'JSE 파일(.ssnap)',
  settings: '설정', about: '정보', shortcuts: '단축키', update: '업데이트', checkUpdate: '업데이트 확인', upToDate: '최신 버전입니다', updateDone: '업데이트 완료', updating: '업데이트 중',
  confirmDiscard: '저장하지 않은 변경사항이 있습니다. 계속할까요?', saved: '저장했습니다', autosaved: '자동 저장됨', opened: '열었습니다',
  omrTitle: '사진으로 악보 인식', omrHint: '악보가 화면에 꽉 차고 평평하게, 그림자 없이 밝게 찍어주세요.', omrRun: '인식 시작', omrReview: '인식 결과 검토', omrAccept: '이대로 사용', omrRetry: '다시 인식',
  camera: '카메라', gallery: '사진 선택', fromUrl: '주소(URL)로 가져오기',
  ok: '확인', cancel: '취소', close: '닫기', apply: '적용', done: '완료', more: '더보기', back: '뒤로',
  beginnerTips: '초보자 안내', hideTips: '안내 숨기기',
};
const en = {
  app: 'JSE', untitled: 'Untitled', file: 'File', edit: 'Edit', view: 'View', score: 'Score', export: 'Export', help: 'Help',
  new: 'New score', open: 'Open', scan: 'Scan photo', save: 'Save', saveAs: 'Save as', recent: 'Recent',
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', delete: 'Delete', selectAll: 'Select all', repeat: 'Repeat (R)',
  play: 'Play', stop: 'Stop', pause: 'Pause', tempo: 'Tempo', metronome: 'Metronome',
  zoomIn: 'Zoom in', zoomOut: 'Zoom out', fitWidth: 'Fit width', fitPage: 'Fit page', actual: 'Actual size',
  viewSingle: 'Single page', viewVertical: 'Vertical', viewHorizontal: 'Horizontal', viewGrid: 'All pages', viewReflow: 'Continuous',
  palette: 'Palette', inspector: 'Properties', pages: 'Pages',
  notes: 'Notes', rests: 'Rests', accidentals: 'Accidentals', articulations: 'Articulations', dynamics: 'Dynamics', lines: 'Lines', texts: 'Text', barlines: 'Measures', keys: 'Key/Time', clefs: 'Clefs', repeats: 'Repeats', ornaments: 'Ornaments', drums: 'Drums', chords: 'Chords', lyrics: 'Lyrics',
  inputMode: 'Note input', selectMode: 'Select',
  duration: 'Duration', dot: 'Dot', tie: 'Tie', rest: 'Rest', voice: 'Voice', grace: 'Grace note', tuplet: 'Tuplet',
  whole: 'Whole', half: 'Half', quarter: 'Quarter', eighth: 'Eighth', '16th': '16th', '32nd': '32nd', '64th': '64th', breve: 'Breve',
  sharp: 'Sharp', flat: 'Flat', natural: 'Natural', doubleSharp: 'Double sharp', doubleFlat: 'Double flat',
  staccato: 'Staccato', accent: 'Accent', tenuto: 'Tenuto', marcato: 'Marcato', staccatissimo: 'Staccatissimo', fermata: 'Fermata',
  crescendo: 'Crescendo', diminuendo: 'Diminuendo', slur: 'Slur', ottava: 'Ottava', pedal: 'Pedal', trill: 'Trill', glissando: 'Glissando',
  title: 'Title', subtitle: 'Subtitle', composer: 'Composer', lyricist: 'Lyricist', arranger: 'Arranger', copyright: 'Copyright',
  pageSetup: 'Page setup', instruments: 'Instruments', addPart: 'Add part', removePart: 'Remove part',
  timeSig: 'Time signature', keySig: 'Key signature', clef: 'Clef', measure: 'Measure', addMeasure: 'Add measure', insertMeasure: 'Insert measure before', deleteMeasure: 'Delete measure',
  systemBreak: 'System break', pageBreak: 'Page break', barline: 'Barline', repeatStart: 'Start repeat', repeatEnd: 'End repeat', final: 'Final barline', double: 'Double barline', volta: 'Volta',
  rehearsal: 'Rehearsal mark', text: 'Text', expression: 'Expression', chordSymbol: 'Chord symbol', lyric: 'Lyrics',
  transposeUp: 'Up a semitone', transposeDown: 'Down a semitone', octaveUp: 'Octave up', octaveDown: 'Octave down', transpose: 'Transpose',
  exportPdf: 'PDF', exportPng: 'PNG image', exportJpg: 'JPG image', exportSvg: 'SVG', exportMusicXml: 'MusicXML', exportMidi: 'MIDI', exportSsnap: 'JSE file (.ssnap)',
  settings: 'Settings', about: 'About', shortcuts: 'Shortcuts', update: 'Update', checkUpdate: 'Check for updates', upToDate: 'Up to date', updateDone: 'Update complete', updating: 'Updating',
  confirmDiscard: 'You have unsaved changes. Continue?', saved: 'Saved', autosaved: 'Autosaved', opened: 'Opened',
  omrTitle: 'Recognize a photo', omrHint: 'Fill the frame with the page, keep it flat and evenly lit.', omrRun: 'Recognize', omrReview: 'Review result', omrAccept: 'Use as is', omrRetry: 'Retry',
  camera: 'Camera', gallery: 'Choose photo', fromUrl: 'From URL',
  ok: 'OK', cancel: 'Cancel', close: 'Close', apply: 'Apply', done: 'Done', more: 'More', back: 'Back',
  beginnerTips: 'Beginner tips', hideTips: 'Hide tips',
};
let lang = (typeof localStorage !== 'undefined' && localStorage.getItem('ssnap.lang')) || 'ko';
export function setLang(l) { lang = l; try { localStorage.setItem('ssnap.lang', l); } catch { /* ignore */ } }
export function getLang() { return lang; }
export function t(key, vars) {
  let s = (lang === 'en' ? en[key] : ko[key]) ?? ko[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
