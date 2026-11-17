# MuseScore files in JSE (`.mscz` / `.mscx`)

`app/js/io/mscz.js` reads MuseScore files of MuseScore 2, 3 and 4 and writes MuseScore 3 files
(which MuseScore 3 and 4 both open). This folder holds the tools used to check it.

```js
import { MSCZ_EXTENSIONS, looksLikeMscx, importMscz, importMscx, exportMscz, exportMscx } from './io/mscz.js';

MSCZ_EXTENSIONS                                   // ['.mscz', '.mscx']
looksLikeMscx(textOrBytes)                        // true for XML with a <museScore> root (false for a zip)
await importMscz(data, { JSZip, fileName })       // ArrayBuffer | Uint8Array: .mscz (zip) OR plain .mscx bytes → ScoreDoc
importMscx(xmlText, { fileName, styleXml })       // XML text → ScoreDoc (styleXml = score_style.mss of a MuseScore 4 archive)
exportMscx(score, { target: 3, warnings })        // ScoreDoc → XML text (format 3.02)
await exportMscz(score, { JSZip, target: 3, warnings })   // ScoreDoc → Uint8Array (zip: META-INF/container.xml + score.mscx)
```

* `score.importInfo = { from: 'musescore', version: '3.02', program: '3.6.2', warnings: [Korean strings] }`.
* `warnings` (export): pass an array; short Korean notes about anything left out or changed are pushed onto it.
* `target` 3 and 4 both write format 3.02. MuseScore 4 converts such a file when it opens it (and asks to save
  as a new file); a separate 4.x writer was not built.
* Errors are thrown as `Error` with a Korean message (MuseScore 1.x file, not a MuseScore file, damaged zip,
  an `.mxl` renamed to `.mscz`, empty score on export).

## Commands

```bash
# import a file or a whole directory and report problems
node tools/mscz/check.mjs <file-or-dir>… [--by-version] [--verbose] [--limit n] [--json out.json]
node tools/mscz/check.mjs <dir> --export          # also: export every score and import it again (must be the same music)

# compare two files measure by measure (any of .mscz .mscx .mxl .musicxml .ssnap, or a ScoreDoc .json)
node tools/mscz/compare.mjs a.mscz a.mxl --verbose
node tools/mscz/compare.mjs --pairs <dir>         # every x.mscz|x.mscx against x.mxl next to it (OpenScore layout)

# round trip through real MuseScore
node tools/mscz/roundtrip.mjs prepare <out-dir> <scores…>     # our export of every score + job.json
mscore -j <out-dir>/job.json                                   # MuseScore converts each export to MusicXML
node tools/mscz/roundtrip.mjs verify <out-dir> [--verbose]     # compares with what we exported

node --test tools/tests/mscz.test.js              # unit tests (fixtures: tools/tests/fixtures/mscz-*)
```

Real MuseScore without a display (AppImages from the GitHub releases of musescore/MuseScore, unpacked with
`--appimage-extract`):

```bash
# MuseScore 3.6.2 — its AppImage only has the X11 platform plugin, so it needs a virtual display
xvfb-run -a squashfs-root/AppRun -o out.musicxml in.mscz
xvfb-run -a squashfs-root/AppRun -j job.json
# MuseScore Studio 4.5.2
QT_QPA_PLATFORM=offscreen squashfs-root/AppRun -o out.musicxml in.mscz
```

## What was measured (2026-11)

Import (`check.mjs`), 4,400 files — MuseScore's own test files and templates (branch 3.x and master) and 863
real songs from OpenScore Lieder:

| format | files | imported | notes |
|---|---|---|---|
| 1.14 / 1.24 | 59 | 0 — refused on purpose | |
| 2.00 – 2.07 | 286 | 286 | flat layout |
| 3.00 – 3.02 | 2,135 | 2,135 | |
| 4.00 – 4.70 | 1,238 | 1,238 | |
| 5.00 (development) | 685 | 685 | with a warning |

No file fails. OpenScore Lieder (900,724 notes, 156,556 lyric syllables): no voice is longer or shorter than its
measure. In MuseScore's test files 27 voices are too long — all in files that test damaged or partial tuplets.

Import against MuseScore's own MusicXML (`compare.mjs --pairs`, the `.mxl` OpenScore publishes next to every
`.mscx`/`.mscz`, read with JSE's MusicXML importer): 863 pairs, measure counts always equal; 842 pairs have the
same meter on both sides (MusicXML cannot express MuseScore's per-staff meters). In those, wherever both
importers produce a complete rhythm, 99.99+ % of the notes agree in measure, part, onset, length and sounding
pitch (837 of 842 files identical), lyrics 99.95 %. The rest is mostly on the MusicXML side — see "Found in
shared code" below.

Export, checked with real MuseScore (`roundtrip.mjs`): 168 exported files — 62 OpenScore songs, 103 MuseScore
demo scores and templates (orchestra, band, jazz, guitar tablature, drum set, transposing instruments) and JSE's
3 sample scores — were all opened by **MuseScore 3.6.2** and by **MuseScore Studio 4.5.2** without an error.
Reading MuseScore's MusicXML re-export back: every note of every measure with a complete rhythm on both sides
(105,140 notes) is where we wrote it, lyrics 99.98 %, meter and repeats identical.

Export then import with our own importer (`check.mjs --export`): 863 of 863 Lieder export; 829 come back as
exactly the same music, the other 34 differ in a few ties (ties whose second note is not found).

## Format notes

A `.mscz` is a zip: `META-INF/container.xml` names the score (`<rootfile full-path="x.mscx">`). MuseScore 4 adds
`score_style.mss` (the style, as its own XML document), `audiosettings.json`, `viewsettings.json`, thumbnails and
linked parts under `Excerpts/…/*.mscx` (ignored). MuseScore 3 keeps the style and the linked parts (nested
`<Score>` elements, ignored) inside the one `.mscx`.

`<museScore version="…">` → `<Score>` → `<Style>`, `<metaTag name="…">`, `<Part>` (staves + `<Instrument>`), then
one `<Staff id="n">` per staff with its `<Measure>`s (title frames `<VBox>` sit in staff 1).

| | 2.0x | 3.0x | 4.x | 5.00 dev |
|---|---|---|---|---|
| measure content | chords are children of `<Measure>` | `<voice>` per voice | as 3 | as 3 |
| other voices | `<track>` on each element, absolute `<tick>` to rewind | next `<voice>`, `<location><fractions>` to skip | as 3 | as 3 |
| tuplets | `<Tuplet id>` + `<Tuplet>id</Tuplet>` in the chord | `<Tuplet>…<endTuplet/>` | as 3 | as 3 |
| slurs | `<Slur id>` + `<Slur type="start" id>` in the chord | `<Spanner type="Slur">` with `<next>`/`<prev>` `<location>` | as 3 | `<SpannerMap>`, `startElement`/`endElement` = `<eid>` |
| hairpin, ottava, pedal, volta | element with `id` … `<endSpanner id>` | `<Spanner type=…>` in the voice | as 3 | `<SpannerMap>`, `startTick` + `ticks` |
| ties | `<Tie id>` in the note … `<endSpanner id>` | `<Spanner type="Tie">` in the note | as 3 | `<Tie>` with eids |
| beams | `<Beam id>` + reference | `<BeamMode>` begin / mid / no | as 3 | as 3 |
| fermata | `<Articulation>` fermata | `<Fermata>` in front of the chord | as 3 | as 3 |
| key signature | `<accidental>` = key as shown | as 2 | `<concertKey>` (+ `<actualKey>`) | as 4 |
| chord symbol | `<root>` `<name>` `<base>` (TPC) | as 2 | `<harmonyInfo>` around them (4.6+) | as 4 |
| ornaments | articulation names (`prall`, `mordent`) | SMuFL names (`ornamentMordent`) | `<Ornament>` | as 4 |
| page | `<page-layout>` in 1/144 inch | `pageWidth` … in inches | in `score_style.mss` | as 4 |

The importer follows the structure it finds, not the version number (early 3.0 files still use the 2.x layout).

Things worth knowing:

* **Pitch.** `<pitch>` is the sounding (concert) MIDI pitch *without* the effect of an ottava line; `<tpc>` spells
  it on the line of fifths (F♭♭ = −1 … C = 14 … B♯♯ = 33), `<tpc2>` is the spelling a transposing instrument reads.
  A ScoreDoc stores the written pitch: `written = pitch − transposeChromatic`, spelled with `tpc2`. Notes under an
  8va line are therefore stored as written, exactly like MuseScore (MusicXML stores them as sounding).
* **Positions** are never stored. A reader keeps a cursor: every chord or rest moves it by its length
  (`durationType`, `dots`, tuplet ratio, the staff's local meter); `<location>` moves it by a fraction, `<tick>` (2.x)
  sets it. A two-chord tremolo writes `durationType` half with `<duration>1/4</duration>`: the second is the real length.
* **Spanner positions** are relative: `<next><location><measures>1</measures><fractions>-1/4</fractions>` = one
  measure later and a quarter earlier inside the measure; the end tag carries the mirror image. `<grace>` is the
  index of a grace note among the grace notes of its chord, `<notes>` the note inside a chord. An end tag is
  written where its tick is — at the start of the following measure when a line ends on a barline.
* **Grace notes** come in front of their chord in the file, also the ones played after it (`grace8after` …).
  Writing a grace note with a slur and no chord to belong to crashes MuseScore 3.
* **Measures.** `len="3/8"` gives the real length of an irregular measure. A `<Measure>` with `<multiMeasureRest>`
  is the generated multi-measure rest and duplicates the measures after it — skipped. `<startRepeat/>`,
  `<endRepeat>2</endRepeat>`, `<LayoutBreak>`, `<Marker>`, `<Jump>` are children of the measure of the first staff.
  A clef change at a barline is the last element of the measure before it.
* **MuseScore refuses** (as "corrupted") a file whose first voice does not fill a measure exactly, or whose other
  voices are longer than the measure. The exporter completes voice 1 with invisible rests and turns a measure that
  is too long into an irregular one (`len`).
* **Texts** hold inline markup (`<b>`, `<i>`, `<font face=…/>`, `<sym>metNoteQuarterUp</sym>`); texts of lines
  (`<beginText>`) hold the same markup escaped. Tempo: `<tempo>` is quarter notes per second.
* **Drums**: `<Drum pitch="38"><head>…<line>…` in the instrument defines the staff line of every MIDI pitch
  (line 0 = top line, as in a ScoreDoc drum map). **Tablature**: `<StringData>` lists the open strings from low to
  high; a note has `<fret>` and `<string>` (0 = top line).

## How MuseScore things map onto a ScoreDoc

* Irregular measure shorter than its meter → `measure.pickup = true` (anywhere in the piece); longer → a measure
  with its own time signature (warning).
* Per-staff ("local") time signature, e.g. 6/8 in the piano against 2/4 in the voice → the staff keeps its note
  values and gets invisible tuplets (3:2), one group per beat (warning).
* Key signature: one per measure for all staves, taken from the first staff that does not transpose (other staves
  of that kind may change key in another measure). Transposing staves keep their written pitches; on export they
  get the key of their transposition again. Diatonic transposition is derived from the chromatic one.
* Clef change inside a measure → nearer barline (warning). Unusual clefs → nearest of the nine clef types.
* Nested tuplets → one tuplet with the combined ratio (warning). An invisible 4:4 "tuplet" is dropped.
* Staff text on a note → text of that event; `SystemText` at the start of a measure → measure text (`system`).
  A measure text of a ScoreDoc is written as a staff text on the first note (it comes back as an event text).
* Dynamics outside the thirteen ScoreDoc marks: `sf`→`sfz`, `pppp`→`ppp` …; `other-dynamics` → expression text
  ("mf zögernd" → `mf` + text).
* Cresc./dim. written as text lines ↔ `textLine` spanners with that text; `GradualTempoChange` → `textLine` "rit.".
* `%` measure repeats → the notes of the measure they repeat (warning).
* Invisible notes and rests → `hidden`; invisible lines, texts and dynamics are not imported; invisible repeat
  marks and jumps are (they steer playback). A voice made only of invisible rests is dropped.
* Courtesy accidentals (`<role>1`) → forced `accidental`; automatic ones are left to the engraver.

## Not supported

Import: cross-staff notation (notes stay on their own staff), two-chord tremolos (read as plain notes of the
sounding length), chord-diagram dots (the chord symbol is kept), figured bass, breath marks, bends, fingering
other than plain text, instrument changes inside a staff, custom key signatures, ambitus, images, staff-type
changes, linked parts, parentheses, volume/pan, positions and all manual layout offsets, MuseScore 1.x files.
Export: everything above, per-object fonts (`event.texts[].font`), chord diagrams, source images.
A MuseScore file written by JSE has no manual layout — MuseScore lays it out afresh.

## Found in shared code — fixed in v1.1.0

Seen while comparing with MuseScore's MusicXML; all were in `app/js/io/musicxml.js` / `midi.js` and were fixed by the
main session for the v1.1.0 release (tests: `tools/tests/musicxml.test.js`, `playback.test.js`):

1. MusicXML import filled a gap in front of a tuplet note with ordinary rests (300 ticks for 320) → now hidden rests
   of the same tuplet (`gapFill`), every voice keeps its exact length.
2. MusicXML import kept a tuplet "open" after `<backup>` in cross-staff passages, so plain notes got a 6:4 or 5:4
   tuplet → an explicit `<tuplet>` is now followed per XML voice across staves (`applyTuplet`), and a note without
   `<time-modification>` never joins a tuplet. A staff that sees more than four XML voices no longer piles the extra
   ones into voice 4 (`voiceIndexFor`).
3. `<degree>` alterations after `<kind text="7">` ("A7♭5" → "A7") and the dynamics `sf`, `sffz`, `rf`, `pppp` … → kept.
4. Notes under `<octave-shift>` were kept at sounding pitch → converted to written pitch on import and back on
   export (`ottavaShifts` in `model/score.js`); playback and the NWC export add the octave.
5. `midi.js`: transposition depended on `settings.concertPitch` (inverted for MusicXML files) → always applied;
   a pickup measure was played as long as a full measure → as long as its longest voice (`measurePlayTicks`).

Effect on `compare.mjs --pairs` over the 863 Lieder (same onset + pitch per part, pieces with the same meter on both
sides): 99.36 % → 99.93 %; note-identical pieces 753 → 833 of 842.
Still open: MusicXML has one meter per part and a ScoreDoc one per measure, so pieces whose parts are in different
meters import with over- or under-full measures in the other parts (21 of the 863 Lieder).

## Final measurements for the v1.1.0 release (main session, final code)

* Import: 4,396 files of the three corpora — 4,337 imported, 59 refused on purpose (MuseScore 1.x), 0 failed.
  Lieder: 863 / 863, 900,724 notes, no voice longer or shorter than its measure.
* Export → own import (`check.mjs --export`, Lieder): 863 export, 833 come back as the same music, 30 differ in a few ties.
* Export → **real MuseScore** (`roundtrip.mjs`), 1,879 scores = 863 Lieder read from `.mscx`/`.mscz`, the same 910 read
  from MuseScore's MusicXML, 103 MuseScore demos and templates, 3 JSE samples:

  | | opened | identical after MuseScore's MusicXML re-export | notes (onset + pitch per part) | lyrics |
  |---|---|---|---|---|
  | MuseScore 3.6.2 | 1,879 / 1,879 | 1,823 | 99.94 % | 99.98 % |
  | MuseScore Studio 4.5.2 | 1,870 / 1,879 | 1,836 | 99.97 % | 100.00 % |

  The 9 files MuseScore 4 refuses in batch mode ("Incomplete measure", e.g. `Found: 9213/9216. Expected: 4/4`) are
  scores whose rhythm does not add up exactly: 6 pieces whose parts are in different meters (read from MusicXML) and
  3 exports of 2 pieces with nested or unusually split tuplets. MuseScore 4 rounds the odd invisible filler tuplet the exporter writes for such a voice;
  MuseScore 3 accepts it. In the MuseScore 4 window such a file opens after "무시하고 열기 / Open anyway".

## For SPEC / HANDOFF

SPEC §5d — MuseScore import/export (`app/js/io/mscz.js`)

```js
export const MSCZ_EXTENSIONS = ['.mscz', '.mscx'];
export function looksLikeMscx(textOrBytes) → boolean
export function importMscx(xmlText, { fileName, styleXml } = {}) → ScoreDoc
export async function importMscz(data, { JSZip, fileName } = {}) → ScoreDoc      // zip (.mscz) or plain XML (.mscx) bytes
export function exportMscx(score, { target = 3, warnings } = {}) → string         // format 3.02
export async function exportMscz(score, { JSZip, target = 3, warnings } = {}) → Uint8Array
```
* Reads formats 2.00–2.07, 3.00–3.02, 4.00–4.70 (5.00-dev with a warning); MuseScore 1.x is refused.
  Writes 3.02 (MuseScore 3.6), opened by MuseScore 3 and 4.
* `score.importInfo = { from:'musescore', version, program, warnings }`.
* Pitches are written pitches (MuseScore `pitch − transposeChromatic`, spelling from `tpc2`), ottavas do not move them.
* `measure.pickup` may now occur on any measure (irregular short measure), not only the first.
* Tuplets may carry `bracket: false` and `show: 'none'` (local time signatures, invisible tuplets).
* `settings.textStyles` is filled only where the file departs from MuseScore's default faces/sizes and is written
  back as `<…FontFace>` / `<…FontSize>` (pt = sp × staffSpaceMm ÷ 0.3528) / `<…FontStyle>`.
* Checked with `tools/mscz/check.mjs`, `compare.mjs`, `roundtrip.mjs`; numbers above.

HANDOFF — requirement "MuseScore 파일 열기·저장": ✅ `io/mscz.js` (가져오기 4,341개 파일 오류 없음 · 내보낸 파일 168개를
실제 MuseScore 3.6.2 / 4.5.2가 모두 엶). 남은 일: 크로스 스태프, 두 음 트레몰로, 코드 다이어그램, 4.x 형식으로 직접 쓰기.
