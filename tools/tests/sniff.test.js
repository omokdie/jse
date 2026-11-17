// sniffFile(): which importer (or how-to guide) a file goes to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffFile, FOREIGN_SCORE_FORMATS } from '../../app/js/io/ssnap.js';

const bytes = s => new TextEncoder().encode(s).buffer;
const raw = (...b) => new Uint8Array(b).buffer;

test('by extension', () => {
  const cases = {
    'a.ssnap': 'ssnap', 'a.musx': 'musx', 'a.ftmx': 'musx', 'a.mscz': 'musescore', 'A.MSCX': 'musescore',
    'hymn.nwc': 'nwc', 'hymn.nwctxt': 'nwc', 'a.musicxml': 'musicxml', 'a.xml': 'musicxml', 'a.mxl': 'mxl',
    'a.mid': 'midi', 'a.midi': 'midi', 'a.kar': 'midi', 'a.png': 'image', 'a.pdf': 'pdf', 'a.json': 'json',
    '내 악보.sib': 'sibelius', 'old.mus': 'finale-old', 'a.enc': 'encore', 'a.dorico': 'dorico',
    'a.capx': 'capella', 'a.gp5': 'guitarpro', 'a.gpx': 'guitarpro', 'a.ove': 'overture',
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(sniffFile(name, null), kind, name);
});

test('closed formats all have a how-to', () => {
  for (const [kind, f] of Object.entries(FOREIGN_SCORE_FORMATS)) {
    assert.ok(f.name && f.how && f.ext.length, kind);
    for (const e of f.ext) assert.equal(sniffFile('x' + e, null), kind);
  }
});

test('by content when the name does not tell', () => {
  assert.equal(sniffFile('download', bytes('<?xml version="1.0"?>\n<museScore version="3.02">')), 'musescore');
  assert.equal(sniffFile('renamed.xml', bytes('<?xml version="1.0"?><museScore version="4.20">')), 'musescore');
  assert.equal(sniffFile('song.xml', bytes('<?xml version="1.0"?><score-partwise version="3.1">')), 'musicxml');
  assert.equal(sniffFile('download', bytes('<?xml version="1.0"?><score-partwise>')), 'musicxml');
  assert.equal(sniffFile('download', bytes('[NWZ]\0xyz')), 'nwc');
  assert.equal(sniffFile('download', bytes('[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]')), 'nwc');
  assert.equal(sniffFile('download', bytes('!NoteWorthyComposer(2.751)\n|Editor|')), 'nwc');
  assert.equal(sniffFile('download', raw(0x0f, 0x53, 0x49, 0x42, 0x45, 0x4c, 0x49, 0x55, 0x53, 0, 0)), 'sibelius');
  assert.equal(sniffFile('download', bytes('MThd\0\0\0\x06')), 'midi');
  assert.equal(sniffFile('download', bytes('%PDF-1.7')), 'pdf');
});

test('zip containers', () => {
  const zip = name => { const head = [0x50, 0x4b, 3, 4, ...new Array(26).fill(0)]; return new Uint8Array([...head, ...new TextEncoder().encode(name)]).buffer; };
  assert.equal(sniffFile('download', zip('score.json')), 'ssnap');
  assert.equal(sniffFile('download', zip('score.dat')), 'musx');
  assert.equal(sniffFile('download', zip('My_Song.mscx')), 'musescore');
  assert.equal(sniffFile('download', zip('score_style.mss')), 'musescore');
  assert.equal(sniffFile('download', zip('META-INF/container.xml')), 'mxl');
});
