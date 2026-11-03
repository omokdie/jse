'use strict';
/**
 * Minimal native menu (파일 / 편집 / 보기 / 도움말).
 *
 * Items that belong to the web app forward an action string to the renderer
 * (webContents.send('scoresnap:menu', action, payload)).  Text-editing items
 * keep their native roles so copy/paste work in input fields.
 *
 * Keyboard-shortcut ordering (Chromium/Electron): the renderer receives the
 * keydown first; a menu accelerator fires only when the page did NOT call
 * preventDefault().  So if the web app handles Ctrl+S / Ctrl+Z itself, the
 * menu action is not sent twice.  Inside text fields the app should ignore
 * 'undo'/'redo' actions (the browser already performed the text undo).
 */
const { Menu, app, dialog, BrowserWindow } = require('electron');

const EXPORT_FORMATS = [
  ['pdf', 'PDF 문서 (.pdf)'],
  ['png', 'PNG 이미지 (.png)'],
  ['jpg', 'JPG 이미지 (.jpg)'],
  ['svg', 'SVG 벡터 (.svg)'],
  ['musicxml', 'MusicXML (.musicxml)'],
  ['mxl', 'MusicXML 압축 (.mxl)'],
  ['midi', 'MIDI (.mid)'],
];

function showAbout() {
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    type: 'info',
    title: 'JSE 정보',
    message: `JSE ${app.getVersion()}`,
    detail:
      '악보 사진 인식 · 편집 · 내보내기\n\n' +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n` +
      '음악 글리프: GNU FreeSerif (GPL + Font Exception)',
    buttons: ['확인'],
    noLink: true,
  };
  if (win) dialog.showMessageBox(win, opts);
  else dialog.showMessageBox(opts);
}

/**
 * @param {{ sendAction: (action: string, payload?: any) => void,
 *           checkForUpdates: () => void }} handlers
 */
function buildMenu(handlers) {
  const { sendAction, checkForUpdates } = handlers;
  const isMac = process.platform === 'darwin';

  const template = [];

  if (isMac) template.push({ role: 'appMenu' });

  template.push({
    label: '파일(&F)',
    submenu: [
      { label: '새 악보', accelerator: 'CmdOrCtrl+N', click: () => sendAction('new') },
      { label: '열기…', accelerator: 'CmdOrCtrl+O', click: () => sendAction('open') },
      { label: '이미지에서 악보 인식…', accelerator: 'CmdOrCtrl+I', click: () => sendAction('open-image') },
      { label: 'MusicXML 가져오기…', click: () => sendAction('import-musicxml') },
      { type: 'separator' },
      { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => sendAction('save') },
      { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendAction('save-as') },
      {
        label: '내보내기',
        submenu: EXPORT_FORMATS.map(([fmt, label]) => ({ label, click: () => sendAction('export', fmt) })),
      },
      { type: 'separator' },
      { label: '인쇄…', accelerator: 'CmdOrCtrl+P', click: () => sendAction('print') },
      { type: 'separator' },
      isMac ? { role: 'close', label: '닫기' } : { role: 'quit', label: '종료' },
    ],
  });

  template.push({
    label: '편집(&E)',
    submenu: [
      { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', click: () => sendAction('undo') },
      { label: '다시 실행', accelerator: isMac ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y', click: () => sendAction('redo') },
      { type: 'separator' },
      { role: 'cut', label: '잘라내기' },
      { role: 'copy', label: '복사' },
      { role: 'paste', label: '붙여넣기' },
      { role: 'selectAll', label: '모두 선택' },
      { type: 'separator' },
      { label: '설정…', accelerator: 'CmdOrCtrl+,', click: () => sendAction('settings') },
    ],
  });

  template.push({
    label: '보기(&V)',
    submenu: [
      { label: '확대', accelerator: 'CmdOrCtrl+=', click: () => sendAction('zoom-in') },
      { label: '축소', accelerator: 'CmdOrCtrl+-', click: () => sendAction('zoom-out') },
      { label: '실제 크기', accelerator: 'CmdOrCtrl+0', click: () => sendAction('zoom-reset') },
      { label: '페이지 맞춤', accelerator: 'CmdOrCtrl+1', click: () => sendAction('zoom-fit') },
      { type: 'separator' },
      // No bare-key accelerators (e.g. Space for play): a menu accelerator fires whenever
      // the page does not preventDefault(), which would break typing in text fields.
      { role: 'togglefullscreen', label: '전체 화면' },
      { role: 'toggleDevTools', label: '개발자 도구' },
    ],
  });

  template.push({
    label: '도움말(&H)',
    submenu: [
      { label: '업데이트 확인', click: () => checkForUpdates() },
      { label: '사용법', accelerator: 'F1', click: () => sendAction('help') },
      { type: 'separator' },
      { label: 'JSE 정보', click: () => showAbout() },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu, showAbout };
