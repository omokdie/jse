// File names for 내보내기 / 다른 이름으로 저장 (app/js/io/filename.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanFileBase, hasBadFileChars, safeFileName, defaultFileBase, fileBaseFromInput,
  exportFileNames, exportNameSuffix, savedFileLabel, MAX_FILE_BASE,
} from '../../app/js/io/filename.js';

test('cleanFileBase: refused characters, spaces, typed extensions, trailing dots, reserved names, length', () => {
  assert.equal(cleanFileBase('  봄바람   (예제)  '), '봄바람 (예제)');
  assert.equal(cleanFileBase('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(cleanFileBase('tab\there\nnewline'), 'tab here newline');
  assert.equal(cleanFileBase('장미.pdf'), '장미');            // a typed JSE extension goes — the format decides it
  assert.equal(cleanFileBase('장미.MSCZ'), '장미');
  assert.equal(cleanFileBase('v1.2 final'), 'v1.2 final');    // dots inside a name stay
  assert.equal(cleanFileBase('끝에 점...'), '끝에 점');          // Windows drops trailing dots
  assert.equal(cleanFileBase('con'), '_con');
  assert.equal(cleanFileBase('   '), '');
  assert.equal(cleanFileBase(null), '');
  assert.equal([...cleanFileBase('가'.repeat(300))].length, MAX_FILE_BASE);
  assert.equal(cleanFileBase('e\u0301'), '\u00e9');            // NFC (names typed on macOS)
});

test('hasBadFileChars flags what will be replaced', () => {
  assert.equal(hasBadFileChars('장미:편곡'), true);
  assert.equal(hasBadFileChars('장미 편곡 (2)'), false);
});

test('safeFileName adds the extension once and never returns an empty name', () => {
  assert.equal(safeFileName('봄바람', '.pdf'), '봄바람.pdf');
  assert.equal(safeFileName('봄바람.pdf', '.pdf'), '봄바람.pdf');
  assert.equal(safeFileName('봄바람.png', '.pdf'), '봄바람.pdf');
  assert.equal(safeFileName('', '.ssnap'), '악보.ssnap');
  assert.equal(safeFileName('a?b', '.mid'), 'a_b.mid');
});

test('defaultFileBase: last export name → file name → title', () => {
  assert.equal(defaultFileBase({ lastName: '장미-편곡', fileName: '170124장미.ssnap', title: '장미' }), '장미-편곡');
  assert.equal(defaultFileBase({ fileName: 'C:\\악보\\170124장미.ssnap', title: '장미' }), '170124장미');
  assert.equal(defaultFileBase({ fileName: null, title: '봄바람 (예제)' }), '봄바람 (예제)');
  assert.equal(defaultFileBase({}), '악보');
});

test('fileBaseFromInput falls back to the starting name when nothing usable was typed', () => {
  assert.equal(fileBaseFromInput('  ', '봄바람'), '봄바람');
  assert.equal(fileBaseFromInput('새 이름.pdf', '봄바람'), '새 이름');
});

test('export names and the suffix shown after the field', () => {
  assert.deepEqual(exportFileNames('장미', '.pdf'), ['장미.pdf']);
  assert.deepEqual(exportFileNames('장미', '.png', { count: 3, zip: true }), ['장미.zip']);
  assert.deepEqual(exportFileNames('장미', '.png', { count: 3, zip: false }), ['장미-1.png', '장미-2.png', '장미-3.png']);
  assert.equal(exportNameSuffix('.pdf'), '.pdf');
  assert.equal(exportNameSuffix('.png', { count: 4, zip: true }), '.zip');
  assert.equal(exportNameSuffix('.png', { count: 2, zip: false }), '-1.png, -2.png');
  assert.equal(exportNameSuffix('.svg', { count: 5, zip: false }), '-1.svg … -5.svg');
});

test('savedFileLabel says where the file went', () => {
  assert.equal(savedFileLabel({ path: 'Download/JSE/장미 (1).pdf', name: '장미 (1).pdf' }, '장미.pdf'), '다운로드/JSE/장미 (1).pdf');
  assert.equal(savedFileLabel({ path: 'C:\\Users\\me\\Documents\\새 이름.pdf' }, '장미.pdf'), '새 이름.pdf');
  assert.equal(savedFileLabel({ handle: {}, name: 'picked.pdf' }, '장미.pdf'), 'picked.pdf');
  assert.equal(savedFileLabel({ download: true }, '장미.pdf'), '장미.pdf');
});
