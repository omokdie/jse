# Finale files in JSE (`.musx`)

`app/js/io/musx.js` reads Finale 2014–27 files (`.musx`, `.ftmx`); `app/js/io/musx-write.js` writes `.musx`.
This folder holds the tools used to build and check the writer.

```js
import { exportMusx, buildEnigmaXml, MUSX_VERSION } from './io/musx-write.js';   // lazy: await import('./io/musx-write.js')

await exportMusx(score, { JSZip, warnings })   // ScoreDoc → Uint8Array (.musx). JSZip defaults to globalThis.JSZip
buildEnigmaXml(score, { warnings })            // → { xml, metadata }: the EnigmaXML document alone (tests, tools)
MUSX_VERSION                                   // { major: 26, minor: 1 } — the file format declared
```

* `warnings`: pass an array; one short Korean note is pushed for each kind of thing that was left out or written in a
  nearer form (list below). An empty score (no parts) throws an `Error`.
* Size: `musx-write.js` 98.1 KB + `musx-defaults.js` 57.5 KB (33 KB + 11 KB gzipped). Both are loaded only when a
  file is exported; `musx-write.js` also imports `musx.js` (the reader, 80 KB / 28 KB gzipped) for the scrambling and
  the percussion note-type table.
* Browser-safe: no Node API. gzip uses `CompressionStream('gzip')` where it exists and JSZip's deflate otherwise
  (the gzip header is rewritten to Finale's own: `1f 8b 08 00 00000000 00 0b`).

**Not verified: no copy of Finale was available, so no exported file has been opened in Finale.** Everything below
was checked against Finale's own files and with an independent reader (musxdom/denigma), not with Finale itself.
The export should be labelled experimental until someone opens a few files in Finale 26/27.

## The format, as written

A `.musx` file is a ZIP archive, laid out as Finale lays it out (checked on all 1,373 files of Finale 27's samples):

| entry | content |
|---|---|
| `mimetype` | first, stored: `application/vnd.makemusic.notation` |
| `META-INF/container.xml` | `<container version="26">`, root file `score.dat` (no `META-INF/` folder entry — Finale writes none) |
| `NotationMetadata.xml` | `<metadata version="26.1">`: key, initial tempo, duration in seconds, creator string |
| `score.dat` | EnigmaXML, gzip-compressed (header of Finale for Windows), then scrambled with `musxCrypt()` |

Finale also writes `presets/N.preset` (Audio Unit settings, Mac); those are optional and not written.

EnigmaXML is `<finale version="26.1" xmlns="http://www.makemusic.com/2012/finale">` with `mappings` (a fixed block,
identical in every file), `header` (created/modified stamps: enigma/app/file version 26.1, build 388, `FIN`, `WIN`,
`US`), `options`, `others`, `details`, `entries`, `texts`. A missing element means the default value (0, false), so
like Finale the writer leaves zeros and false flags out (except where Finale writes them anyway, e.g. `harmAlt 0`).
Records are written grouped by type in the order Finale writes them (the order of record types is the same in every
file of the corpus), then by cmper/inci.

**Why 26.1.** 1,208 of the 1,373 files Finale 27 installs as its own samples declare 26.1 (others: 26.3 ×90,
25.6 ×45, 27.2–27.4 ×30). The records, field order and values the writer imitates were measured on those files, so
26.1 is the version the output really matches. Finale 26 and 27 open 26.x files; Finale 25 and older refuse files of
a newer format, and a 25.x header on 26-shaped content would be a guess — so older Finale versions are not targeted.

### Global data

Options (34 option records), fonts, marking categories, articulation and expression library entries, smart shape
line styles, baselines, playback defaults, … come from Finale's factory default document (`Maestro Font
Default.ftmx`, Finale 25–27 Default Files). `tools/musx/gen-defaults.mjs` extracts them into
`app/js/io/musx-defaults.js` in a compact notation (`name[attr=v]=value`, `name{children}`, `name*(v v v)`), checks
that the notation decodes to the same XML, and is the only place those files are needed. No corpus file is shipped.

```bash
node tools/musx/gen-defaults.mjs ["…/Default Files/Maestro Font Default.ftmx"] [--out app/js/io/musx-defaults.js]
```

### Units and conventions the writer relies on

* Durations in EDU (1024 per quarter; JSE ticks × 16/15), positions in EVPU (288 per inch).
* Pitch: `harmLev` = scale step from the key's tonic in the octave of middle C, `harmAlt` = alteration against the key.
  Finale stores concert pitch: a transposing instrument gets `<transposition><keysig interval adjust>` and its notes
  are written in concert pitch (written = concert + adjust). Notes under an 8va line are stored as written, in JSE and
  in Finale alike. Key: `(mode << 8) | fifths`; no `<keySig>` in a measure means C major.
* JSE's key signature is the key of its reference staff (first non-transposing standard staff, else the first
  standard staff); Finale's measure key is concert — the writer converts with the reference staff's transposition.
* Entries are chained per staff and layer (`prev`/`next`); each measure of each staff points to them through
  `gfhold` → `frameSpec`. Beam flag = "this entry starts a beam group or stands alone"; the groups are the ones JSE
  draws (explicit beam modes, else JSE's automatic grouping — same rules as `engrave/layout.js`).
* Lyrics: one text per verse, syllables separated by spaces and hyphens; Finale (with its default "smart word
  extensions") also ends a syllable at "_", so a space, hyphen or underscore inside a syllable is written as a no-break
  space, no-break hyphen or fullwidth low line. `lyrDataVerse` points each entry at its syllable number — these must
  be exactly the syllables Finale counts in the verse text, or every later syllable shifts.
* Chord symbols: root and bass as scale degree of the key + alteration, the suffix as `chordSuffix` characters with
  its played intervals (`chordSuffixPlay`).
* Percussion: each drum staff gets a percussion layout (`drumStaff` → `percussionNoteInfo` per drum of the staff's drum
  map: Finale's note type of the drum's General MIDI key, its line, its noteheads in the Maestro Percussion font);
  every drum note carries its note type (`percussionNoteCode`) and, like Finale's own files, the drum's MIDI key as
  its pitch.
* TAB: one `fretInst` per tuning (strings as MIDI pitches, highest first), string of each note in `tabAlter`.

## What is written

* Score: title, subtitle, composer, lyricist, arranger, copyright as page text blocks (with Finale's inserts such as
  `^title()`), page size, margins, staff size, system and page breaks (`lineBreak`/`pageBreak`), measures per system
  and systems per page estimated from the page.
* Staves and instruments: full and abbreviated names, clef (incl. 8va/8vb clefs), transposition (written key and
  pitch), grand staves (multi-staff instrument with its brace and name — JSE has no other staff groups), one-line
  staves, TAB staves (tuning, strings, frets), drum staves (percussion layout: instrument, line, noteheads),
  instrument UUIDs for Finale's sound setup, MIDI program/channel.
* Measures: time signatures incl. common/cut time and composite meters, pickups and other short measures (actual
  length, the time signature shown unchanged), key changes (major/minor), barlines (double, final, dashed,
  invisible), repeats (with play counts), voltas (pass numbers, open/closed), segno/coda/D.S./D.C./Fine/To Coda,
  clef changes, rehearsal marks, tempo marks (text + metronome), measure texts (also on a lower staff).
* Notes: rests, chords, dots, tuplets (`tupletDef` on the first entry, incl. ratio display and bracket; a tuplet the
  importers split into groups, as nested tuplets come in, is written as one), ties, grace
  notes (slashed or not), forced accidentals, stem directions, beams as JSE draws them (incl. beams over rests),
  noteheads (x, diamond, triangle, square, slash, plus: `noteAlter`), hidden notes/rests, up to 4 voices (Finale
  layers 1–4).
* Lyrics (verses; a space, hyphen or underscore inside a syllable as a no-break space, no-break hyphen or fullwidth low
  line, since Finale ends a syllable at each; word extensions), chord symbols (also two at one position),
  dynamics (all of JSE's: pppp…ffff, sf, sfz, sffz, sfp, sfpp, sfzp, fp, pf, fz, rf, rfz) and text expressions with
  their text styles and fonts (CJK text gets a font that has the glyphs), articulations, ornaments, fermatas (above or
  below), tremolos, arpeggios.
* Lines: slurs (also across staves), crescendo/diminuendo hairpins, 8va/8vb/15ma/15mb, trills, glissandi, pedal lines,
  text lines (e.g. "rit. - - -"). Lines are attached to measure positions as Finale does by default, except slurs,
  glissandi and lines on a lower voice, which are attached to their notes (a lower voice of hidden rests that a line
  is attached to is written for that, and read back).

## What is written in a nearer form (with a Korean warning)

| warning | why |
|---|---|
| 일부 음표 머리 모양(원 안의 x 등)은 보통 음표 머리로 저장했습니다 | Maestro has no circled-x notehead |
| 타악기 음표 머리 일부는 보통 음표 머리로 저장했습니다 | a drum notehead JSE does not normally use |
| 역턴(inverted turn)은 턴으로 저장했습니다 | no inverted turn in Finale's default articulation library |
| 일부 아티큘레이션은 저장하지 않았습니다 / 일부 셈여림표는 글자로 저장했습니다 | marks without a library entry |
| 밑줄(_)만 있는 가사 음절은 앞 음절의 낱말 연장선으로 저장했습니다 | a melisma placeholder syllable ("____", from MusicXML) is Finale's word extension; as text it would shift every later syllable |
| 코드로 읽을 수 없는 코드 기호는 글자로 저장했습니다 | "N.C.", Roman numerals …: Finale chords need a root, so the text goes above the staff |
| 코드 다이어그램(프렛보드)은 저장하지 않았습니다 | fretboard diagrams are not written |
| 끝이 시작보다 앞선 선은 저장하지 않았습니다 | a line whose end lies before its start |
| 이어지는 음표를 찾을 수 없는 선은 저장하지 않았습니다 | a line whose end note does not exist |
| 쉼표만 있는 마디에 걸친 이음줄은 저장하지 않았습니다 | a slur on a rest that Finale draws itself |
| 다른 보표로 이어지는 선은 시작 보표에만 그렸습니다 | a measure-attached line (hairpin, 8va …) lives on one staff |
| 쉼표나 빈 마디에 붙은 가사 일부는 저장하지 않았습니다 | Finale lyrics attach to notes |
| 같은 마디에서 시작하는 반복 괄호는 하나만 저장했습니다 | one ending per measure in Finale |
| 박자표보다 긴 성부가 있는 마디가 있습니다 — Finale에서 마디 길이를 확인해 주세요 | a voice longer than its measure: written as is (Finale shows an overfull measure) |
| 보표가 4개 이상인 악기는 앞의 3개만 한 악기로 묶었습니다 / 한 보표에 4개를 넘는 성부는 생략했습니다 | Finale limits |
| 일부 선(스패너)은 Finale 형식으로 옮기지 못했습니다 | a line type with no Finale smart shape |

Also approximated without a warning: the page layout (systems per page, staff distances) is estimated — Finale
recomputes it; tempo marks keep a whole number of beats per minute; a restated clef or key signature (the one in
force) is not written, Finale shows none; no linked parts are written (Finale creates parts on demand); the library
records Finale keeps of every percussion layout, articulation and shape set a document could use are not copied (only
what the score uses).

## Changes to the reader (`app/js/io/musx.js`)

Found while checking the writer against Finale's files and denigma. Each changes what JSE makes of Finale files too,
always towards what Finale shows; `tools/tests/musx.test.js` covers them:

* tolerate the `v2`/`controller` entry flags, `altNumTsig`/`displayAltNumTsig` (composite meters), dashed barlines;
* segno/coda text repeats drawn with music-font characters, pedal lines and custom text lines (`smartLine`);
* tempo marks with a dotted unit, tuplet numbers kept when the ratio is n:n, arpeggios;
* a measure without `<keySig>` is C major (it was read as "no change"); the key of transposing-only scores;
* a score-level measure without `<barline>` has no barline (Finale's "none"; it writes "normal" for a normal one);
* page breaks (`<pageBreak/>`) — only system breaks were read;
* beams over rests: a short rest without the beam flag between notes of a group belongs to the beam (as musxdom
  reads it) — before, every rest broke the beam;
* per-note noteheads (`noteAlter`, Maestro and SMuFL characters);
* every dynamic JSE knows is kept as it is (sf, sffz, rf, pppp, ffff, sfpp, sfzp were folded into others);
* a fermata placed by hand keeps its side (`overridePlacement`/`aboveEntry`);
* chord symbols: the scale degree is named in the key the score shows (the written key of a transposing-only score);
  two chords at one position of one staff both stay (the same chord on several staves is still one);
* a text expression assigned to a lower staff of an empty measure stays with that staff;
* lyrics: a no-break space, no-break hyphen or fullwidth low line inside a syllable is read as a space, hyphen or
  underscore;
* a whole-measure rest a line starts or ends on is kept (it was emptied away, leaving the line pointing nowhere), and
  so is a lower voice of hidden rests that a line is attached to;
* TAB: the tuning from `fretInst`, the string of each note from `tabAlter`;
* a short measure later in the score (not only the first) stays a pickup measure, as in the MuseScore importer;
* percussion: the staff's percussion layout becomes its drum map (instrument by General MIDI key, line, notehead;
  a drum of JSE's default kit keeps its key, others are named after their General MIDI sound) and each note's drum
  comes from its note type — before, every note was guessed from its pitch. A note without a note type on a laid-out
  staff stays without a drum, as Finale draws it at its pitch.

## Verification

Facts compared (`tools/musx/compare.mjs`, built on `tools/mscz/compare.mjs`): notes (measure, staff, onset, written
pitch with 8va applied, length; drums by MIDI key, TAB by string/fret), spelling, ties, lyrics (verse, text,
syllabic), chord symbols, clef changes, effective meter, key changes, forced accidentals, noteheads (as drawn),
tuplets, grace notes, rests, dynamics, articulations/ornaments, stems, hidden events, texts, beam groups (as JSE draws
them), barlines/repeats/markers, tempo and rehearsal marks, system/page breaks, lines (type, start, end).
Compared as equal because they look the same: a break after the last measure (none) and breaks Finale's layout adds;
a restated clef or key (no change); "repeat both ways" vs end repeat + start repeat on the next measure; runs of
spaces in texts; no-break space/hyphen vs space/hyphen in lyrics; hidden rests that only pad a lower voice.

```bash
node tools/musx/compare.mjs --roundtrip <files-or-dirs>… [--json out.json] [--verbose]   # (a)(b) own round trip
node tools/musx/denigma.mjs <files-or-dirs>… --out /tmp/x [--denigma path] [--verbose]    # (c) independent reader
node tools/musx/structure.mjs <finale-files-or-dirs>… [--every n]                         # (e) structural diff
node --test tools/tests/musx.test.js
```

### Results (final code, 2026-11-19)

**(a)+(b) Own round trip** — every score exported with `exportMusx` and read back with `importMusx`; "failed" means an
exception in export or import; "identical" means the same in every category above:

| set | files | exported + read back | failed | identical in every category | notes | ties | lyrics | lines |
|---|---|---|---|---|---|---|---|---|
| Finale corpus (`.musx`/`.ftmx`, Finale 27's Music Files) | 1,373 | 1,373 | 0 | 1,345 | 100.000 % | 100.000 % | 99.497 % | 99.943 % |
| NWC corpus (`.nwc`/`.nwctxt`) | 645 (12 are not scores) | 633 | 0 | 598 | 100.000 % | 100.000 % | 99.994 % | 99.917 % |
| MusicXML (OpenScore `r5music`) | 379 | 379 | 0 | 60 | 99.998 % | 99.999 % | 99.595 % | 99.921 % |
| MuseScore: OpenScore Lieder (`.mscx`/`.mscz`/`.mxl`) + MuseScore 3/4 test suites (`.mscx`/`.mscz`/`.xml`) | 6,414 (446 JSE cannot open) | 5,968 | 0 | 4,444 | 99.958 % | 99.965 % | 99.624 % | 99.707 % |

Every category of the Finale corpus is at 100 % except: lyrics (54 syllables in 10 files: the source's syllabic chains
are inconsistent — an "end" without a "begin" — and Finale's hyphenated verse text can only hold consistent ones),
meter (3 short measures that are empty: JSE has no length for an empty pickup measure), tuplets (8 in 4 files: tuplets
that never complete in "Jazz Improv XI"), texts (10 identical texts at one position, written once) and lines (22 in 9
files: lines that end before they start — dropped with a warning). System breaks may only grow (Finale's layout adds
its own); none is lost.

In the other sets the remaining differences are of these kinds (all checked by hand on samples):
* source data Finale cannot hold: voices longer than their measure (warned), tuplets that never complete, nested
  tuplets (the importers flatten them; written as consecutive tuplets — mixed nesting can come out wrong in Finale),
  inconsistent lyric syllabic chains, lines that end before they start or have no end note (warned), chord symbols
  without a root (written as text, warned), restated clefs/keys (not compared);
* measures whose voices are shorter than the time signature without being marked as pickups come back filled with
  rests (the reader fills every voice to the measure's length) — this is most of the MusicXML/MuseScore "rests" figure;
* things JSE's Finale reader classifies its own way: a text that looks like a tempo ("Grave") comes back as a tempo
  mark, "system" text style as plain text, fractional metronome values rounded, a hairpin that starts on a hidden rest
  of an otherwise empty voice re-anchored on voice 1 (only when nothing else keeps the voice).

**(c) denigma** — `denigma export --mnx` (musxdom + mnxdom, built from source, see below) on every exported file; all
its messages are collected; the MNX is compared with the ScoreDoc (notes as concert pitch with 8va lines, ties,
lyrics, dynamics, drums (line), drum sounds (General MIDI, where denigma knows the note type's sound), TAB pitches,
meter, keys, repeat barlines, number of slurs/hairpins/8va/voltas):

| set | files | denigma problems | notes | ties | lyrics | drums | TAB | meter / key / repeat diffs |
|---|---|---|---|---|---|---|---|---|
| Finale corpus | 1,373 | 11 files | 99.824 % | 99.736 % | 99.215 % | 100 % (sounds 99.953 %) | 100 % | 0 / 0 / 0 files |
| NWC | 633 | 7 files | 99.695 % | 99.682 % | 99.798 % | 100 % (sounds 100 %) | – | 0 / 0 / 0 files |
| MusicXML | 379 | 18 files | 99.943 % | 99.892 % | 98.448 % | – | – | 0 / 0 / 0 files |
| MuseScore + Lieder | 5,968 | 121 files | 99.877 % | 99.736 % | 98.179 % | 100 % (sounds 100 %) | 98.699 % | 0 / 0 / 0 files ¹ |

¹ The 15 files the run listed with other repeat barlines were a fault of the comparison (a chain of "repeat both
ways" barlines); after correcting it, denigma was run again on those 15 files: 0 differences.

Every "denigma problem" was traced. MNX's semantic check reports measures whose voices add up to more than the time
signature (Finale corpus: all 11 files — for 10 of them denigma reports errors of the same kind for the original
Finale file too, for 6 exactly the same errors —; NWC 5 of 7,
MusicXML 14 of 18, MuseScore set 60 of 121; the writer warns about these), or to less (a voice or tuplet that ends
early in the source: NWC 2, MusicXML 3, MuseScore set 19), and tuplets nested in tuplets (40 files of MuseScore's own
tuplet tests). Left over: one tie whose two notes lie on either side of the end of an 8vb line (Faisst,
"Liebeslied", in its three versions). Entry-attached hairpins (see "Lines" above) are not exported by denigma's MNX
writer, which is why its hairpin counts are lower for the MusicXML/MuseScore sets. Informational messages that
denigma prints for Finale's own files too (measured on 138 original corpus files: stems of whole rests, the missing
clef of TAB staves in MNX) and "hidden grace note skipped" are counted apart. Where the figures are below 100 %: denigma lists notes JSE marks as
hidden (JSE's facts leave hidden notes out — NWC's hidden playback voices), onsets inside tuplets are compared with
one tick of tolerance, lyrics on rests have no place in MNX, a dynamic JSE keeps as text ("mp" in an empty measure)
is a dynamic in MNX, and "fp"/"sfz"-like glyphs are named differently by the MNX exporter.

**(d) MuseScore** — no MuseScore Studio release reads `.musx`: the importers in MuseScore master (2026-11-18, commit
6da159d) are bb, bww, capella, guitarpro, mei, midi, mlscore, mnx, musedata, musicxml, ove, tabledit; its MNX tests use
Finale data converted by denigma, which (c) already covers. No MuseScore binary was available here either.

**(e) Structure** — `tools/musx/structure.mjs` on all 1,373 Finale files (original EnigmaXML vs our export of what JSE
read from it): every record type Finale writes in every file is written. Record types Finale has and the export does
not are its libraries and caches — articulation/expression/shape/percussion-layout libraries, `meta*` records,
staff styles, fretboards and fret styles, text-repeat definitions, chord-suffix library, beat charts and measure
locks, staff-name positions, mixer/VST/Audio Unit state, part voicing, Human Playback data — and per-score features
JSE has no model for (manual beam/stem/tie adjustments, cross-staff notes, performance data, entry sizes, floating
measure numbers). Only one child element that Finale writes in ≥ 90 % of the records of a type is never in ours:
`alternateNotationOptions/quartSlashStemLift` (91 %; missing from the Finale 25 default file the options come from).

## Not verified, and known limits

* **No exported file has been opened in Finale** (none was available). Finale may still reject or misdraw something
  that the checks above cannot see; until a few files have been opened in Finale 26/27 the export is experimental.
  Finale 25 and older are not targeted (format 26.1).
* Lines on a lower voice are attached to their notes ("Attach to Notes"). Finale supports that, but none of
  Finale's own 1,373 sample files has a note-attached hairpin, so this is the least proven choice; denigma does not
  export such hairpins to MNX.
* The page layout is estimated (measures per system, systems per page, staff distances); Finale reflows it.
* Not written: linked parts (Finale makes them from the score), fretboard diagrams, circled-x noteheads on normal
  staves, Finale's libraries (percussion layouts, articulations, shapes …) beyond what the score uses.
* Nested tuplets come flattened from the importers and are written as consecutive tuplets; mixed nesting (a triplet
  inside a triplet next to plain triplet notes) can come out wrong.
* Lyrics on rests have no place in Finale (warned). A melisma placeholder syllable ("____") becomes a word extension.
* The reader changes listed above also change how existing Finale files open in JSE (towards what Finale shows).

## Building denigma (for (c))

```bash
git clone https://github.com/rpatters1/denigma && cd denigma   # (tested at 45c3f62); CMake fetches musxdom, mnxdom,
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release         # smufl-mapping, … into build/_deps
cmake --build build                                             # → build/build/Release/denigma
DENIGMA=$PWD/build/build/Release/denigma node tools/musx/denigma.mjs <files-or-dirs> --out /tmp/x [--verbose]
```

The build runs `xxd -i` to embed resources; where `xxd` is not installed, a small script on `PATH` that prints a file
as a C array (`unsigned char name[] = {…}; unsigned int name_len = …;`) does the same.
