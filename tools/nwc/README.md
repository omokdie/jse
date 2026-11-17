# NoteWorthy Composer (NWC) files in JSE

Code: `app/js/io/nwc.js` (API) · `nwc-binary.js` (reader for `.nwc` 1.5–2.5) · `nwc-text.js` (nwctxt reader/writer) ·
`nwc-convert.js` (NWC document → ScoreDoc) · `nwc-export.js` (ScoreDoc → NWC document, 2.75 container) ·
`nwc-binary-write.js` (writer for `.nwc` 1.75) · `nwc-encoding.js` (code pages) · `nwc-zlib.js` (inflate/deflate fallback).
Tests: `tools/tests/nwc.test.js` (hand-made fixtures only). Corpus tool: `tools/nwc/check.mjs`.

NoteWorthy Composer itself was **not** available while this was written. Reading was checked against files written
by NWC and against other programs that read them; writing was checked by having those other programs read JSE's files.
Whether NWC opens them was not tested — see "What was verified".

## API

```js
import { NWC_EXTENSIONS, NWC_ENCODINGS, looksLikeNwc, importNwc, exportNwctxt, exportNwc } from './js/io/nwc.js';

looksLikeNwc(bytes)                       // "[NWZ]", "[NoteWorthy ArtWare]" or "!NoteWorthyComposer"
score = await importNwc(bytes, { encoding: 'auto', fallbackEncoding: 'windows-1252', fileName });
  // score.importInfo = { from:'nwc', version:'1.75', container:'nwz'|'nwc'|'nwctxt',
  //                      encoding:'euc-kr', encodingGuessed:true, warnings:[…Korean…] }
text  = exportNwctxt(score, { warnings: [] });            // nwctxt for NWC 2.75 (string; write it as UTF-8)
bytes = await exportNwc(score, { warnings: [] });         // .nwc of NWC 2.75 (compressed)
bytes = await exportNwc(score, { version: '1.75', encoding: 'euc-kr', warnings: [] });   // old binary format
  // other options: compress:false (plain file), chords:'plugin' (ChordPlay.nw objects instead of text)
```

* `encoding`: an id from `NWC_ENCODINGS` is used exactly as given; `'auto'` detects (below). When detection cannot
  decide, `fallbackEncoding` is used and `encodingGuessed` is `true` — the UI should then offer the encoding menu.
* `warnings` receives Korean sentences about everything that was approximated (no duplicates).
* All functions work in the browser/WebView and in Node. Inflate uses `DecompressionStream('deflate')` when the
  platform has it and a built-in inflate otherwise; deflate falls back to zlib "stored" blocks.

## Containers and versions

| file | what it is |
|---|---|
| `[NWZ]\0` + zlib stream | compressed wrapper around one of the two below (what NWC saves by default) |
| `[NoteWorthy ArtWare]\0\0\0[NoteWorthy Composer]\0` + minor, major version byte | binary file |
| `!NoteWorthyComposer(2.75)` … `!NoteWorthyComposer-End` | nwctxt (text export, clipboard format) |

Binary versions seen in real files: 1.55, 1.70, 1.75, 2.00, 2.01, 2.05 — an object stream — and 2.75, which is a
short binary header followed by nwctxt.

**2.75 header** (all 436 files of the corpus agree):
`product strings (45 bytes)` `4B 02` `02 00 00 00` `"N/A\0"` `22-character id + \0` `2 bytes: DOS date of saving or 0`
`2 bytes: ANSI code page of the system (E4 04 = 1252, B5 03 = 949)` `00 00 00 00` `24 00`, then the nwctxt in UTF-8
with CRLF line ends. The id is 22 characters of `.0-9A-Z_a-z`, the first one `0`–`3`: 128 bits. Copies of a song
share it, different songs do not, so it is a document id; JSE writes a random one. Single lines of the text may
still be in the ANSI code page (font names, strings carried over from old files): lines are decoded one by one.

**Binary 1.x / 2.0x** (little endian; `z` = NUL-terminated string):
* header: version, 4 flag bytes, user name `z`, id `z`, 8 bytes (2.x: code page at bytes 2–3), `u16`, title, author,
  (2.x: lyricist), copyright 1, copyright 2, comments (`z` each), page setup (`'Y'/'N'` flags, bar numbers, starting bar,
  margins as text in inches "top inside outside bottom", mirror, zoom, 32-byte staff-visibility bit mask, allow layering,
  2.x: notation typeface), staff size, 10 or 12 fonts (`z`, style, size, 0, CharSet), title page, staff labels,
  page numbers, staff count.
* staff: names (`z` × 2 in 1.x, 4 in 2.0, 5 in 2.05), ending bar, muted, channel, device, bank, patch (2.x: 0 = none,
  n = patch n − 1), style (1.x: Standard / Upper Grand / Lower Grand / Orchestral; 2.x: bits bracket, brace, connect),
  boundaries, lines, layer, transposition, volume, pan, colour, lyric alignment, number of lyric lines, lyric blocks,
  object count (+ 2), objects.
* lyric block: `u16` size (multiple of 1024), `u16` used, 2 bytes, then the syllables **as NWC split them**:
  NUL-terminated, each beginning with the separator typed before it (space, `\r` new line, `\n` blank line, `-` for
  the next syllable of a word); a space inside a syllable is an underscore of the editor.
* object: `u16` type, visibility byte (from 1.70), then per type. Notes carry duration, dots, beam, triplet, stem,
  tie, slur, grace, accent/staccato/tenuto, lyric option, staff position (downward positive) and accidental.
  A chord is a header plus complete note objects; every member has its own stem and duration, which is how
  "split stem" chords (two rhythms at once) are stored; a rest chord may contain a whole chord object.
* differences between versions that are easy to get wrong: versions before 2.05 use the old lists (bar lines: Single,
  Double, SectionOpen, SectionClose, LocalRepeatOpen/Close, MasterRepeatOpen/Close; tempo variance without Caesura;
  text fonts start at StaffItalic; visibility Default/Always/TopStaff/Never), 2.05 uses the nwctxt lists; bar style
  bit 7 = forced system break, bit 6 = not counted; 2.05 notes with bit 7 of the 4th data byte have one more byte
  (notehead) in front of the position; early 2.00 files have no notation-typeface string; 1.5x stores dynamic
  variances as style, position. Where a layout detail is not fixed the reader tries the possibilities and keeps
  the one that parses the whole file to its last byte.

## Text encoding

NWC 1.x and 2.0x store text in the ANSI code page of the Windows it ran on — CP949 for Korean — and nothing in a 1.x
file says which. `importNwc(…, { encoding: 'auto' })` decides in this order:

1. all text is ASCII → nothing to decide (`encodingGuessed: false`);
2. the text is valid UTF-8 (2.75, and 2.05 files with code page 65001) → `utf-8`;
3. a font of the file names a character set (129 = Korean, 128 = Japanese, 134/136 = Chinese, 204 = Cyrillic, …);
4. the 2.x header or a `|Locale|ACP:` line names a code page other than 1252;
5. the bytes themselves: pairs that form Hangul syllables of KS X 1001 with (almost) no invalid pairs → `euc-kr`;
   likewise Shift-JIS, GBK, Big5, Cyrillic; isolated high bytes → `windows-1252`. Result: `encodingGuessed: true`;
6. undecidable (one or two stray bytes) → `fallbackEncoding`, `encodingGuessed: true`.

Decoding is `TextDecoder`. `euc-kr` there means CP949; Node's decoder only knows the KS X 1001 part, so the 8,822
other Hangul syllables (0x8141 갂 … 0xC652 힣, in Unicode order over the unused lead/trail bytes) are added by
`nwc-encoding.js` — used for reading where the platform lacks them and for writing everywhere.

## Meaning of the notation (what the importer does)

* Pitch = staff position + clef (centre line: treble B4, bass D3, alto C4, tenor A3, percussion like bass) ± octave shift.
* Accidentals follow NWC's playback rule, not the engraving rule: an accidental holds until the bar line for that
  note **name in every octave**; all heads of a chord see the state before the chord; a tied-to note keeps the pitch
  of the tie, also across a bar line. JSE's `note.accidental` is set where NWC shows a sign that JSE would not.
* Time moves on by the shorter part of a split-stem chord; the longer part (and the rest of a rest chord) becomes a
  second voice, padded with hidden rests. Layered staves ("Layer with next staff") become voices of one staff,
  a braced pair a two-staff piano part. Hidden staves are skipped (warning).
* A whole rest alone in a bar is a whole-bar rest. Bars shorter than the time signature become `pickup` measures;
  bars longer in every staff get the time signature that fits (warning); a single staff that runs over the bar line
  while its next bar is that much shorter is a note hanging over the bar line.
* Bar lines: Double, SectionClose (final), Master/Local repeats (a local repeat's count → `repeatCount`), broken
  (dashed), transparent (none). Special endings 1–7 → volta spanners; "D" (the ending played after D.C./D.S.) has no
  bracket. Flow directions → `measure.markers`. Multi-bar rests are written out.
* Tempo (text, beat unit, hidden = `showBpm:false`), dynamics, sfz/rfz, fermata (goes to the next note, at the end of
  a bar to the note before), cresc./dim. words and tempo words as text, breath mark, pedal → spanner, crescendo /
  diminuendo flags of notes → hairpins, slur flags → slurs, staff instrument patch and transposition.
* Text objects that are chord names become `measure.chords`. A name with a quality or accidental ("Am7", "Bb", "C/E")
  is always a chord; bare capital letters count only if the file has such a name, or at least three different letters
  that do not simply run A, B, C… (rehearsal letters). `[A]` at the start of a bar is a rehearsal mark.
  `ChordPlay.nw` user objects (NWC 2.75) are chords too.
* Page setup: margins, staff size → `staffSpaceMm`, bar numbers, font table → `settings.textStyles`
  (sizes in staff spaces) and `settings.fonts.lyrics`.

### Lyrics

NWC keeps one text per verse (up to 8) and hands the syllables out itself:

* blanks and line breaks separate syllables; a hyphen inside a word starts the next syllable of that word
  (`jun-gle` → jun, -gle); a hyphen on its own or at the end of a word is just text (`wi - - wi`, `우-`, `Oh---`);
  `_` is a space that does not separate (`1._O`), a syllable of underscores only skips a note
  (with `UnderscoreAsSpace:N` trailing underscores are an extender line);
* a syllable goes to every note that is not a grace note and does not receive a tie or a slur; rests are passed
  over; a chord (also a split one) is one target; the note option "Lyric syllable: Always / Never" overrides the rule.

These rules come from NoteWorthy's help and were checked against the syllable lists NWC itself stores in binary files.

## Export

`scoreToNwcDoc()` builds the same document the readers produce, `writeNwctxt()` / `writeNwc175()` spell it out.

* One NWC staff per voice: voices 2–4 are staves layered on the first (stems up / down by voice).
  Every staff gets hidden rests where it has nothing, so all staves are equally long in every bar — NWC lines staves
  up by time, not by bar lines. A voice that runs over the bar line needs room at the start of its next bar;
  where there is none the note is cut at the bar line (warning).
* Accidentals are written by simulating NWC's rule, so NWC plays the pitches JSE has. Ties are written as they are.
* Lyrics: one text per verse, built so that NWC's own rules put every syllable where JSE has it; `Lyric=Always` on
  notes that would not get one (under a slur or tie, rests), `Lyric=Never` on notes that have none between
  syllables, `_` where only some verses skip. Inner hyphens are written as U+2010 so NWC does not split there.
* Slurs, hairpins and beams are note flags (rests inside a slur or hairpin carry them too, as in NWC's own files);
  every beamed note gets a stem direction (NWC's files always have one). Explicit beams are kept, otherwise JSE's
  automatic beaming is written out.
* Repeats, special endings and flow signs are written on **every** staff (NWC plays each staff by its own signs);
  a repeat with a count is a local repeat; the last ending of a repeat also gets "D".
* Chord symbols: text objects (font StaffBold) in front of the note they start with. Chords between notes ride on
  the chord before them when NWC's habit of spacing several names in one text puts them back in place, otherwise
  they move to the note they sound in (warning). `chords: 'plugin'` writes `ChordPlay.nw` objects instead.
* Percussion: NWC plays a percussion staff by bass-clef pitch, so notes are written at the position of their GM
  drum note (the sound is right, the line differs from JSE's drum notation — warning).
* Tuplets other than 3:2 (and 6:4, 12:8, written as triplets) become the nearest plain note values with the same
  total length (warning). Breves and other values NWC lacks are split into tied notes.
* 1.75 has less: staccatissimo → staccato, marcato → accent, hairpins → "cresc." / "dim." marks, dashed and invisible
  bar lines → single, percussion clef → bass clef, no staff labels, no lyricist field (goes to the comments), no
  key tonic (minor keys come back as the relative major), text in one code page (characters outside it → `?`, warning).

## What was verified

Corpus: 794 real files collected from public repositories (kept under /tmp, never in the repo) — 533 of them Korean
a-cappella scores — in versions 1.55 (6), 1.70 (85), 1.75 (106), 2.00/2.01 (53), 2.05 (67), 2.75 (437) and 40 nwctxt files.

* Import: 794/794 parse and validate (62,500 measures, 1.41 million notes, 541,000 lyric syllables, 373,000 of them Hangul).
* Binary reader against the parser of nwc-viewer (a JavaScript port of nwc2xml): 293 files both read, 1,059,403
  objects compared, 320 differ — all in how the comparison is set up (order of two heads on one line in a split
  chord, the slur flag per stem group, text decoding). 252 files are identical object by object; that parser
  fails on 5 files JSE reads.
* Meaning against nwc2musicxml (Java): expected-output pairs of its test suite 18/20 note-identical; on 60 Korean
  2.75 files notes identical on 258/265 staves, lyrics on 203/208. The differences are that tool's: it ignores
  accidentals carried inside a bar and by ties over a bar line, and treats `--` and trailing hyphens differently.
* Export, own round trip (`check.mjs --export`; notes, ties, rhythm, lyrics, chords, signatures, bar lines, repeats,
  flow signs and spanner counts compared) over all 794 scores, no failures:
  nwctxt — 753 come back identical, 41 differ (ties and slurs between voices that become separate staves, drum key
  names, chords between notes, notes cut at a bar line, two files without usable bar lines);
  .nwc 2.75 — 794/794 identical to the nwctxt result;
  .nwc 1.75 — 635 identical to the nwctxt result, 159 differ by what 1.75 lacks (hairpins, percussion clef, a few
  characters outside CP949).
* Export, other readers: nwc2musicxml read all 118 exported files of 60 Korean scores (nwctxt and .nwc 2.75) with
  the same notes on 522/550 staves and the same lyrics on 382/396 — the differences it also has on the originals;
  nwc2ly (Python) and nwc-viewer read the 2.75 files (title, staves, object counts as expected);
  nwc-viewer's binary parser read 106 exported 1.75 files object for object as JSE's reader does
  (881,377 objects; 10 text objects differ, dashes that parser drops).
* In the app (Chromium): a Korean 1.75 file imports, shows and exports to both .nwc versions without console errors
  (`tools/out/nwc-import-k175.png`).
* **Not verified:** that NoteWorthy Composer opens the files. For 2.75 the risk is small (the container is what 436
  real files look like, the text is nwctxt as documented by NoteWorthy). For 1.75 it is real: bytes no reader
  interprets were set to the values most common in real files, and the second header string (a per-user code in
  real files, meaning unknown) is a made-up value. Treat 1.75 export as experimental until someone opens a file
  in NWC 1.75.

## Not supported

* Import: MIDI controller objects (MPC), markers, user objects other than ChordPlay; mid-bar clef changes (moved to the
  next bar, warning); staves whose bars do not line up with the others (free rhythm, missing bar lines) are matched
  bar by bar, not by time; noteheads other than x; stem lengths, spacing and colour options; boundary changes other
  than forced breaks; multi-bar rests in binary files are read by a guessed layout (none in the corpus).
* Export: ottava lines, glissando, trill lines, arpeggio, tremolo, ornaments (written as text or dropped, warning),
  fingering, TAB (written as a normal staff), lyric extender lines, more than 8 verses, more than 4 voices per staff.

## Commands

```sh
node --test tools/tests/nwc.test.js
node tools/nwc/check.mjs <file-or-dir…>                    # import everything, per-version and per-encoding table
node tools/nwc/check.mjs <dir> --list --lyrics             # one line per file, first lyric syllables (eyeball encodings)
node tools/nwc/check.mjs <dir> --fallback euc-kr           # what the Korean UI does
node tools/nwc/check.mjs <dir> --export --verbose          # + export to nwctxt / .nwc 2.75 / .nwc 1.75 and compare
node tools/nwc/check.mjs <dir> --export --out /tmp/out     # keep the exported files (feed them to other readers)
```

## For SPEC / HANDOFF

* New module family `app/js/io/nwc*.js`; public API only in `nwc.js` (see above). No dependencies, no build step.
* File open: `.nwc` and `.nwctxt` → `importNwc(bytes, { fallbackEncoding: 'euc-kr', fileName })`. When
  `score.importInfo.encodingGuessed` is true, show the encoding that was used and let the user pick another id of
  `NWC_ENCODINGS` (re-import with `encoding: id`). `importInfo.warnings` are ready to show.
* File save: "NoteWorthy Composer (.nwc)" → `exportNwc(score, { warnings })`; "NWC text (.nwctxt)" →
  `exportNwctxt(score, { warnings })` written as UTF-8; optional "NWC 1.75 (.nwc, 한국어 CP949)" →
  `exportNwc(score, { version: '1.75', warnings })`, to be labelled experimental.
* ScoreDoc fields the importer fills beyond the basics: `measure.pickup`, `measure.chords`, `measure.markers`,
  `measure.rehearsalMark`, `measure.breaks`, `note.accidental` (forced / `'none'`), `event.hidden`,
  `staff.drumMap` (custom keys `drum<midi>-<n>`), `settings.textStyles`, `settings.fonts.lyrics`, `score.importInfo`.
* Things in shared code noticed on the way — handled by the main session in v1.1.0: `buildPlayback` / MIDI export
  now play a `pickup` measure as long as its longest voice (it was a full measure, i.e. a pause); hidden events are
  still faint on screen but are left out of PDF / PNG / JPG / SVG / print; an 8va line (NWC has none) is exported as
  sounding pitch. Still open: with two voices the engraver forces stem directions by voice number and ignores `ev.stem`.
* Re-run with the final v1.1.0 code (`check.mjs <corpus> --export`, 631 files of the corpus): import 631 / 631;
  export → own import: nwctxt 617 same · 14 differ, `.nwc` 2.75 631 same, `.nwc` 1.75 502 same · 129 differ, 0 failed.