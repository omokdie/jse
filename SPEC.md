# JSE — Technical Specification (v1)

JSE is an offline-first sheet-music program (product name **JSE**; internal identifiers keep the historical `scoresnap` prefix: MIME `application/x-scoresnap`, IPC channels `scoresnap:*`, format id `"scoresnap"`, Android package `kr.scoresnap.app`): photograph or load a
score image → recognise it (OMR) → edit it like a notation editor → save as `.ssnap`
→ export PDF / PNG / JPG / SVG / MusicXML / MIDI, or the file of another notation program
(MuseScore `.mscz`, NoteWorthy Composer `.nwc`). One web code base runs as
a PWA (desktop + mobile browser), as a Windows program (Electron, `.exe` installer)
and as an Android app (Capacitor, `.apk`). All three open the same `.ssnap` files.

Everything is plain ES-module JavaScript, no framework, no build step required
(an optional esbuild bundle is produced for release). All modules live in `app/js/`.

---------------------------------------------------------------------------------
## 1. Repository layout

```
app/                     the web application (what every platform ships)
  index.html
  manifest.webmanifest   PWA manifest (file_handlers for .ssnap, MusicXML, Finale, MuseScore, NWC)
  sw.js                  service worker: offline cache + auto-update
  version.json           {"version":"1.0.0","build":"2026-11-03T..."}
  css/app.css, css/settings.css, css/textstyle.css
  js/
    main.js              bootstrap, wires UI ↔ editor ↔ io
    i18n.js              ko (default) / en strings
    config.js            PAGES_BASE_URL (rewritten by tools/set-github-owner.mjs)
    settings.js          settings registry: every option, its platforms, defaults, migration, search — §9
    fonts.js             text fonts: device fonts, downloadable "JSE 글꼴", IndexedDB cache, SVG embedding — §2b
    model/score.js       data model helpers (createScore, ids, ticks, validation, pitch math, ottavaShifts)
    model/textstyles.js  text styles (fonts of title / lyrics / chords …): keys, defaults, resolve, pt ↔ sp — §2b
    model/commands.js    undo/redo + edit operations on a ScoreDoc
    engrave/glyphs.js    music glyph outlines (generated from GNU FreeSerif; GPL+FE)
    engrave/layout.js    measures → systems → pages; horizontal spacing
    engrave/render.js    SVG engraving + geometry index for hit-testing
    engrave/styles.js    per-engrave view of the text styles
    editor/tools.js      Finale-style tools (entry target, smart shapes, articulations, expressions) — §5c
    editor/pointer.js    mouse/touch per tool (ghost note, drag-copy, marquee, pan)
    editor/keyboard.js   Finale-style shortcuts + metatools
    omr/omr.js           image → RecognitionResult (pure JS, runs in a Web Worker)
    omr/*.js             OMR stages (preprocess, dewarp, staves, barlines, heads, classifiers, lyrics/hangul)
    omr/worker.js        worker wrapper around omr.js
    audio/*.js           audio → score (Basic Pitch interpreter, beat/key/quantize) — §4b
    io/ssnap.js          .ssnap container read/write (JSZip); sniffFile() + FOREIGN_SCORE_FORMATS — §5f
    io/musicxml.js       MusicXML import/export (.xml/.musicxml/.mxl)
    io/musx.js           Finale .musx/.ftmx import (§5b)
    io/mscz.js           MuseScore .mscz/.mscx import + export (§5d)
    io/nwc.js, nwc-*.js  NoteWorthy Composer .nwc/.nwctxt import + export (§5e)
    io/midi.js           playback list (buildPlayback) + MIDI export (SMF type 1)
    io/export.js         PDF/PNG/JPG/SVG export, print
    io/storage.js        IndexedDB autosave, recent files
    playback/synth.js    WebAudio playback
    native.js            window.ScoreSnapNative shim (see §6)
    update.js            update manager UI/state (see §7)
    ui/ui.js             UI controller (title bar, option bar, tool rail, menus, files)
    ui/flyout.js         Photoshop-style grouped buttons with flyouts; ui/groups.js defines the groups
    ui/settings.js       settings window (desktop two panes + search, phone pages) — §9
    ui/textstyle.js      글꼴… dialog, font picker, inspector section
    ui/exportdlg.js      export dialog (print / other programs / sound + JSE)
    ui/importflow.js     opening files of other programs: import, encoding choice, how-to for closed formats — §5f
  vendor/jszip.min.js, vendor/pdf-lib.min.js
  fonts/LICENSE-FreeFont.txt
  fonts/web/             downloadable text fonts (7 OFL families, unmodified, WOFF) + manifest.json — published on
                         GitHub Pages only; NOT in the installer, the APK, the OTA bundle or the service-worker cache
electron/                Windows desktop wrapper (electron + electron-builder + electron-updater)
mobile/                  Capacitor 6 Android project (intent filters for .ssnap/.musx/.mscz/.nwc, OTA web update)
.github/workflows/       CI: build web bundle, Windows exe, Android apk, release + Pages deploy
tools/                   dev scripts (glyph extraction, test image generation, tests)
SPEC.md, README.md
```

---------------------------------------------------------------------------------
## 2. ScoreDoc — the in-memory / on-disk score model (JSON)

All durations are in **ticks**, `TPQ = 960` ticks per quarter note.
Positions inside a measure are ticks from the measure start.

```js
ScoreDoc {
  format: "scoresnap", version: 1,
  meta: { title:"", subtitle:"", composer:"", lyricist:"", arranger:"", copyright:"",
          created:ISOString, modified:ISOString, appVersion:"1.0.0" },
  settings: {
    pageSize:"A4"|"Letter"|"A3"|"B5"|"custom", orientation:"portrait"|"landscape",
    pageWidthMm:210, pageHeightMm:297,
    marginsMm:{top:15,bottom:15,left:15,right:15},
    staffSpaceMm:1.75,            // size of one staff space (scale of everything)
    systemGapSp:9, staffGapSp:7,  // vertical gaps in staff spaces
    firstSystemIndentSp:0,
    measureNumbers:"system"|"all"|"none",
    concertPitch:true,            // informational (MusicXML <concert-score>); playback never depends on it
    fonts:{ text:"", lyrics:"" }, // legacy (set by importers, ignored by the engraver) — see textStyles
    textStyles?: { [title|subtitle|composer|lyricist|lyrics|chord|text|tempo|rehearsal|partName|measureNumber]:
                   { family?:"Nanum Myeongjo", size?:number /* STAFF SPACES */, bold?:boolean, italic?:boolean } },   // §2b
  },
  parts: Part[],
  measures: Measure[],            // every measure has staves[] with one entry per staff of every part, in part order
  spanners: Spanner[],
  sources: Source[],              // original images (OMR); may be empty
  importInfo?: { from:"finale"|"musescore"|"nwc", version?, program?, warnings:string[] /* Korean, user facing */,
                 encoding?, encodingGuessed? /* NWC text encoding */ },
}

Part {
  id, name:"Piano", abbreviation:"Pno.",
  instrument:"piano"|"guitar"|"voice"|"violin"|"flute"|"drumset"|"bass"|... (free string, see INSTRUMENTS),
  midiProgram:0..127, midiChannel?:0..15 (9 = drums), volume?:0..1, pan?:-1..1,
  transposeChromatic:0,          // written→sounding offset (e.g. Bb clarinet = -2)
  staves: Staff[]                // 1 (most) or 2 (piano) — grand staff gets a brace
}
Staff {
  id, type:"standard"|"percussion"|"tab",
  lines:5,                       // 1 for a rhythm staff, 5 normal, 6 for tab
  clef: ClefType,                // initial clef
  tuning?: ["E2","A2","D3","G3","B3","E4"],   // tab only, low→high
  drumMap?: { [drumKey]: { line:number /*staff position 0=top line, 1=1st space…*/, head:NoteheadStyle, midi:number, name:string } }
}
ClefType = "treble"|"bass"|"alto"|"tenor"|"treble8vb"|"treble8va"|"bass8vb"|"percussion"|"tab"

Measure {
  id,
  timeSig?: { num:4, den:4, display:"normal"|"common"|"cut" },   // only when it changes; measures[0] MUST have one
  keySig?:  { fifths:-7..7, mode:"major"|"minor" },               // only when it changes; measures[0] MUST have one
  tempo?:   { bpm:120, beatUnit:DurBase, dots:0, text:"", showBpm:true },
  barlineLeft?: "none"|"repeat-start"|"double",
  barlineRight?: "single"|"double"|"final"|"repeat-end"|"repeat-both"|"dashed"|"none",
  repeatCount?: 2,
  rehearsalMark?: "A",
  markers?: ("segno"|"coda"|"fine"|"toCoda"|"dsAlCoda"|"dsAlFine"|"dcAlCoda"|"dcAlFine"|"ds"|"dc")[],
  texts?: { text, placement:"above"|"below", style:"plain"|"expression"|"technique"|"system", font?:TextFont }[],  // measure-anchored text ("Verse 1")
  chords?: { id, tick, text:"Cmaj7/E", root?:"C", kind?:"maj7", bass?:"E", diagram?:{ frets:[-1,3,2,0,1,0], baseFret:1, barres:[] } }[],
  breaks?: { system?:true, page?:true },
  pickup?: true,                // shorter than the time signature is allowed: the upbeat, or any irregular short measure
                                // (MuseScore / NWC imports). Played, and exported, as long as its longest voice.
  staves: StaffMeasure[],
  source?: { sourceId, bbox:[x,y,w,h], confidence:0..1 }   // OMR mapping (image px)
}
StaffMeasure { clef?: ClefType /*change at start of this measure*/, voices: Event[][] /* voices[0] always exists; up to 4 */ }

Event {
  id, kind:"note"|"rest",
  dur: { base:DurBase, dots:0|1|2 },
  tuplet?: { id, num:3, den:2, bracket?:true, show:"number"|"ratio"|"none" }, // same id on every event of the group
  notes?: Note[],                // kind=note: 1 note = single, 2+ = chord (sorted low→high)
  stem?: "up"|"down",            // undefined = auto
  beam?: "begin"|"continue"|"end"|"none",   // undefined = auto beaming by beat
  grace?: { slash:true },
  articulations?: ("staccato"|"staccatissimo"|"accent"|"marcato"|"tenuto"|"tenuto-staccato"|"accent-staccato"|"marcato-staccato")[],
  ornaments?: ("trill"|"turn"|"inverted-turn"|"mordent"|"inverted-mordent")[],
  fermata?: "above"|"below",
  dynamic?: "ppp"|"pp"|"p"|"mp"|"mf"|"f"|"ff"|"fff"|"sfz"|"sfp"|"fp"|"fz"|"rfz"   // palette
          | any other spelling with the letters p m f s z r ("sf", "sffz", "rf", "pppp" … from imports),
  lyrics?: { verse:1, text:"", syllabic:"single"|"begin"|"middle"|"end", extend?:true }[],
  texts?: { text, placement:"above"|"below", style:"plain"|"expression"|"technique", font?:TextFont }[],
  arpeggio?: true, tremolo?: 1|2|3,
  fullMeasureRest?: true,        // whole-measure rest (centred) regardless of time signature
  hidden?: true,                 // takes its time but is not printed: faint on screen (25 %), absent from PDF / PNG / JPG / SVG / print
  source?: { bbox:[x,y,w,h], confidence:0..1 }
}
TextFont = { family?, size? /* staff spaces */, bold?, italic? }     // override for ONE text object
DurBase = "breve"|"whole"|"half"|"quarter"|"eighth"|"16th"|"32nd"|"64th"|"128th"
Note {
  step:"C".."G", octave:0..9, alter:-2..2,      // written pitch (C4 = middle C)
  accidental?: "sharp"|"flat"|"natural"|"double-sharp"|"double-flat"|"none",  // forced display; undefined = automatic
  tieStart?: true, tieEnd?: true,
  head?: NoteheadStyle,
  drum?: drumKey,                // percussion staves: key into Staff.drumMap; step/octave give the display line (treble-clef mapping)
  string?: 1..n, fret?: 0..24,   // tab staves (string 1 = highest)
  fingering?: "1", velocity?: 0..127, color?: "#rrggbb"
}
NoteheadStyle = "normal"|"x"|"circle-x"|"diamond"|"diamond-black"|"triangle"|"triangle-black"|"square"|"slash"|"plus"

Spanner {
  id, type:"slur"|"crescendo"|"diminuendo"|"ottava"|"pedal"|"trill"|"glissando"|"textLine"|"volta",
  from:{ eventId } | { measureId }, to:{ eventId } | { measureId },   // volta uses measureIds
  placement?: "above"|"below", text?: "", octaveShift?: 8|-8|15|-15, number?: "1."|"2."|"1.-2.", voltaType?: "closed"|"open"
}
Source { id, name:"IMG_0001.jpg", mime:"image/jpeg", width, height,
         file:"sources/<id>.jpg",   // path inside the .ssnap zip
         blob?: Blob /* in memory only */,
         staves?: { bbox:[x,y,w,h], measureIds:[] }[] }
```

Conventions
* Ticks: `breve 7680, whole 3840, half 1920, quarter 960, eighth 480, 16th 240, 32nd 120, 64th 60, 128th 30`;
  dots ×1.5 / ×1.75; tuplet ×den/num. `model/score.js` exports `durTicks(ev)`.
* Pitch helpers in `model/score.js`: `midiOf(note)`, `noteFromMidi(midi, keyFifths)`, `staffPosition(note, clef)`
  (0 = top line, +1 per step downward: 1 = first space…), `transposeNote(note, semitones, keyFifths)`.
* IDs: `newId()` → 8-char base36 strings, unique within the document.
* `measures[0].timeSig` and `measures[0].keySig` are mandatory. Every measure has exactly
  `totalStaffCount(score)` entries in `staves`.
* A measure whose voice 0 is empty is rendered as a whole-measure rest.
* Percussion: `Staff.type="percussion"`, clef `"percussion"`, default `drumMap` = `DEFAULT_DRUM_MAP` in
  `model/score.js` (GM kit: kick 36, snare 38, hihat-closed 42, hihat-open 46, hihat-pedal 44, tom-high 50,
  tom-mid 47, tom-low 45, floor-tom 41, crash 49, ride 51, ride-bell 53, cowbell 56, …).
* Chord symbols live on measures (`measure.chords[].tick`), not on events, so they survive note edits.
* **Pitches are stored as written on the staff.** Sounding pitch = written + `part.transposeChromatic`
  + the shift of an 8va / 8vb / 15ma line over the note (`ottavaShifts(score)` → Map eventId → ±12 / ±24; a line
  covers every voice of its staff from its first to its last event). Playback, MIDI and the NWC export (which has no
  ottava line) add these; MusicXML — which stores sounding pitch under an `<octave-shift>` — converts on import and
  export; MuseScore and Finale files store written pitch like a ScoreDoc.
* A tuplet group = the events sharing `tuplet.id`. Importers keep every voice exactly as long as its notes say:
  where the other notes of a tuplet sit on another staff (cross-staff beaming), their places are hidden rests of
  the same tuplet.

---------------------------------------------------------------------------------
## 2b. Text styles and fonts (`model/textstyles.js`, `engrave/styles.js`, `fonts.js`, `ui/textstyle.js`)

`score.settings.textStyles` gives each kind of text (title, subtitle, composer + arranger, lyricist, lyrics, chord
symbols, free text, tempo, rehearsal marks, part names, measure numbers) a font family, a size, bold and italic;
a single free text can override them with its own `font`. `app.settings.newScore.textStyles` (same shape) is the
default for new scores.
* `size` is in **staff spaces**, so text scales with the staff. The UI shows points: `pt = sp × staffSpaceMm ÷ 0.3528`
  (`ptToSp` / `spToPt`). `family` is ONE family name, validated by `sanitizeFontFamily` (it is written into SVG / CSS).
* No `textStyles` ⇒ the engraver output is byte-identical to a score without the feature. With styles, size / bold /
  italic are attributes of each `<text>`, a family is one CSS rule scoped by a class `ts-<hash>` on the page `<svg>`.
* Font sources: the built-in stack, the fonts of the device (`queryLocalFonts` where available, else a probe list),
  and **JSE 글꼴** — 7 free families (Nanum Myeongjo / Gothic / Pen Script, Gowun Batang / Dodum, Old Standard TT,
  Libertinus Serif; SIL OFL 1.1, shipped unmodified as lossless WOFF in `app/fonts/web/`). They are downloaded the
  first time they are used (own origin, else `PAGES_BASE_URL/fonts/web/`), kept in IndexedDB `jse-fonts` and
  registered with `FontFace`; exports embed the ones a page uses as `@font-face` data URLs (PNG / JPG / PDF / SVG /
  print). Build + licence notes: `tools/fonts/README.md`.
* Importers fill `textStyles` only where a file departs from the defaults (MusicXML `<lyric-font>` / `<word-font>` /
  credits, MuseScore `<…FontFace>` / `<…FontSize>`, NWC fonts) and the exporters write them back.

---------------------------------------------------------------------------------
## 3. `.ssnap` file container

A ZIP archive (JSZip). Entries:

```
mimetype                 "application/x-scoresnap" (stored first, uncompressed)
manifest.json            { "format":"scoresnap", "version":1, "app":"JSE", "appVersion":"1.0.0", "modified":ISO }
score.json               the ScoreDoc (sources[].blob omitted; sources[].file points into the zip)
sources/<id>.<ext>       original photographs/scans (optional)
thumbnail.png            first page preview, ~400px wide (optional)
```
`io/ssnap.js` exports `writeSsnap(score, {thumbnailBlob}) → Blob` and `readSsnap(arrayBuffer) → ScoreDoc`
(blobs restored into `sources[].blob`). Unknown entries are preserved on round-trip when feasible.
MIME `application/x-scoresnap`, extension `.ssnap`.

---------------------------------------------------------------------------------
## 4. OMR module contract (`app/js/omr/omr.js`)

```js
export async function recognize(image, options = {}, onProgress = () => {}) → RecognitionResult
// image: { width, height, data: Uint8ClampedArray (RGBA) }   — same shape as ImageData; works in browser & Node
// options: { parts?: "auto"|1|2, assumeGrandStaff?: boolean, timeSig?: {num,den}, keyFifths?: number, debug?: boolean,
//            lyrics?: boolean /* default true; false skips the Korean lyric stage */ }
// onProgress({ stage: "preprocess"|"staves"|"symbols"|"assemble", percent: 0..100, message })
RecognitionResult {
  score: ScoreDoc,                       // valid ScoreDoc (one Source entry referencing this image, id "src1")
  confidence: 0..1,                      // overall
  warnings: string[],                    // Korean, user facing ("3번째 마디의 박자가 맞지 않습니다")
  staves: { bbox:[x,y,w,h], lineYs:number[], spacing:number, partIndex, staffIndex, systemIndex }[],
  measures: { measureId, bbox:[x,y,w,h], confidence }[],
  symbols?: { kind, bbox, confidence, eventId? }[],   // when options.debug
  deskewAngle: number, binarizedPreview?: ImageData-like (debug), pipeline: 'legacy'|'photo',
  // Korean lyric stage (omr/lyrics.js + omr/hangul.js, model weights in omr/hangul-weights.js)
  lyrics: { eventId|null, measureId|null, staffIndex, systemIndex, verse, text, confidence: 0..1,
            lowConfidence: boolean /* confidence < 0.8 */, bbox:[x,y,w,h] /* original px */, alternatives: string[] }[],
  lyricLines: { staffIndex, systemIndex, verse, text, bbox, confidence, syllables }[],
  lyricStats: { lines, tokens, reads, ms },
}
```
Lyrics: text lines below each staff (and between the staves of a system) are read syllable by syllable
(Hangul MLP over gradient features; any of the 11,172 syllables, KS X 1001 preferred, word-frequency prior)
and written into the score as `event.lyrics = [{ verse, text, syllabic:'single' }]` — one Hangul syllable per
note, like the editor's Korean input. Rests and tied continuation notes get none; `1.`/`2.` set the verse,
otherwise stacked lines are verses 1, 2, … top to bottom. `confidence` = recognition × note-alignment quality
(halved when unattached). The review dialog and the editor mark `lowConfidence` syllables in orange until
they are edited (`ui.reviewState.lowLyrics`). Training/eval: `tools/omr/hangul/README.md`.
Requirements: pure JS, no DOM (runs in a Worker and in Node for tests), deterministic,
≤ ~10 s for a 2500×3500 photo on a mid-range phone. Must handle: slight rotation (±5°),
uneven lighting, JPEG artefacts, 1–2 staves per system (piano), treble/bass clefs,
key & time signatures, note heads (filled/hollow/whole), stems, beams (durations ≤ 16th),
flags, dots, ties, accidentals, rests, barlines (single/double/final/repeat), chords
(stacked noteheads). Lyrics/chord text are optional (if detected, attach to nearest event).
Low-confidence measures get `measure.source.confidence < 0.6` so the UI can highlight them.
Everything it cannot read becomes rests of the correct total length so measures stay valid.

---------------------------------------------------------------------------------
## 4b. Audio → score (`app/js/audio/*`, dialog `app/js/ui/audioflow.js`)

```js
// app/js/audio/engine.js — AudioTranscriber: decode(blob) → analyze(onProgress) → transcribe(opts); cancel()
// app/js/audio/basicpitch.js — new BasicPitch(loadGraph(modelJson, weights)).evaluate(mono22050) → post
//   (pure-JS interpreter for the Basic Pitch TF.js graph, tfgraph.js; WASM-SIMD conv kernel wasmconv.js, JS fallback)
// app/js/audio/transcribe.js — pure, runs in Worker and Node
transcribe(post, opts) → { score: ScoreDoc, notes, qnotes, beats, bpm, key:{fifths,mode,tonic}, timeSig, mode,
                           pickupBeats, stats:{notes, polyphony, ms, measures, duration}, warnings: string[] }
// post: { nFrames, note: Float32Array(nFrames·88), onset: Float32Array(nFrames·88) }  (Basic Pitch posteriorgrams)
// opts: { mode:'auto'|'melody'|'piano', timeSig:'auto'|'4/4'|'3/4'|'2/4'|'6/8', bpm:null|number, grid:16|8,
//         triplets, chords, keyFifths, title, notes (cached extraction for re-quantising), tuned }
```
Decoding uses the browser's `decodeAudioData` (MP3/M4A/OGG/WAV/FLAC) → mono 22,050 Hz. Output ScoreDoc: one part
`voice` (treble / treble8vb / bass clef by range) or `piano` (grand staff split around C4); measure 0 has timeSig,
keySig, tempo (6/8: dotted quarter) and `pickup: true` for an anacrusis; chord symbols in `measure.chords`;
triplets as `tuplet {num:3, den:2}`. Re-quantising (tempo ÷2/×2, BPM, meter, grid, mode) reuses the network output.
Model: `app/vendor/basic-pitch/` (Spotify Basic Pitch, Apache-2.0, NOTICE), 917 KB, lazy-loaded.
Tuning/eval data: Finale pieces rendered to audio (`tools/audio/`, see its README).

---------------------------------------------------------------------------------
## 5. MusicXML module contract (`app/js/io/musicxml.js`)

```js
export function importMusicXML(xmlText) → ScoreDoc          // partwise or timewise, MusicXML 2.0–4.0
export async function importMXL(arrayBuffer) → ScoreDoc      // compressed; uses JSZip (global `JSZip` or injected)
export function exportMusicXML(score) → string              // partwise 4.0, UTF-8, pretty printed
export async function exportMXL(score) → Blob
```
Must map: parts/staves (grand staff via <staves>2), clefs, key/time, notes/chords/rests, durations incl.
dots/tuplets (<time-modification>), ties, slurs, beams, stems, articulations, ornaments, fermata,
dynamics, hairpins (wedge), lyrics (syllabic/extend), chord symbols (<harmony>, with <frame> for
diagrams), repeats/endings (<barline>, <ending>), rehearsal marks, tempo (<sound tempo>, <metronome>),
text directions (<words>), percussion (<unpitched> + <instrument>), tab (<technical><string>/<fret>),
grace notes, tremolo, arpeggiate, octave shifts, pedal, system/page breaks (<print>), page & scaling
(<defaults>). Round trip `importMusicXML(exportMusicXML(x))` must preserve every field above.
Use `DOMParser`/`XMLSerializer` (in Node tests, inject via `setXMLImplementation({DOMParser, XMLSerializer})`
or build strings manually for export — export must not depend on DOM).

Import details that matter for other code (v1.1.0):
* A part's voices: the first four XML voices seen on a staff keep a voice index for the whole piece; further ones
  (the other staff's voices coming over for cross-staff notes) borrow, measure by measure, a voice that no other XML
  voice of that measure needs at the same time (`voiceIndexFor`, `measureVoiceSpans`).
* Tuplets: an explicit `<tuplet>` lives in one XML voice but may touch several staves; each staff:voice gets its own
  group, the gaps are hidden rests of that tuplet (`applyTuplet`, `gapFill`, `st.owed`). A note without
  `<time-modification>` is never part of a tuplet, whatever was left open before it.
* `<octave-shift>`: notes under it are converted from the file's sounding pitch to written pitch (§2 conventions).
* Dynamics: every MusicXML dynamic spelled with p m f s z r. Chord symbols: `<kind text="7">` + the `<degree>`s the
  text does not already name ("A7" + "b5").
* MusicXML has one time signature per part; a ScoreDoc has one per measure for all staves (the first part's). Pieces
  whose parts are in different meters import with over- or under-full measures in the other parts.
Measured against MuseScore's own files (863 OpenScore Lieder as `.mscx`/`.mscz` next to MuseScore's MusicXML export of
the same score, `node tools/mscz/compare.mjs --pairs <dir>`): notes with the same onset and pitch 99.93 %, 833 of 842
comparable pieces note-identical (v1.0.8: 99.36 %, 753).

---------------------------------------------------------------------------------
## 5b. Finale import (`app/js/io/musx.js`) — read-only

```js
export async function importMusx(data: ArrayBuffer|Uint8Array, {JSZip}) → ScoreDoc   // .musx / .ftmx (Finale 2014+)
export function enigmaToScore(xmlText, {meta}) → ScoreDoc                           // already-decoded EnigmaXML
export function musxCrypt(bytes) → Uint8Array      // the score.dat scrambler (XOR with an LCG keystream; symmetric)
```
* `.musx` is a ZIP. `score.dat` = scrambled gzip of **EnigmaXML** (`xmlns="http://www.makemusic.com/2012/finale"`).
  Keystream: state₀ = `0x28006D45`, reset every `0x20000` bytes; `state = state·0x41C64E6D + 0x3039 (mod 2³²)`,
  `upper = state>>>16`, key byte = `(upper + ⌊upper/255⌋) & 0xFF`. Then gunzip (DecompressionStream, JSZip fallback).
* Units: EDU 1024 per quarter (→ ×960/1024 ticks); EVPU 288 per inch for page layout.
* Pitch: `harmLev` is a scale step relative to the key's tonic in the C4 octave, `harmAlt` the alteration;
  key value = `(mode<<8) | signed fifths`.
* Notes: `gfhold(staff, measure)` → `frameSpec.startEntry/endEntry` → linked entry chain (`v2Launch` = voice 2,
  `dummy` entries skipped, `ignore` → hidden). Tuplets from `tupletDef`, lyrics from `lyrDataVerse` + `texts/verse`
  (split on spaces/hyphens), chords from `chordAssign`, expressions from `measExprAssign` + `textExprDef` (text = `texts/expression[textBlock(textIDKey).textID]`;
  identical expressions on several staves are shown once; staff-assigned ones stay on that staff),
  smart shapes (slurs, hairpins, 8va/8vb, trill, gliss, pedal, lines) from `smartShape` end points, repeats/endings,
  text repeats, system breaks (`staffSystemSpec`), page size/margins (`pageSpec`), staff groups, instrument names,
  transposition. Unknown data is skipped; `score.importInfo = {from:'finale', warnings}` lists what was approximated.
* Older binary Finale files (`.mus`, `.ftm`, before 2014) are detected and rejected with an explanation.
* Checker over a corpus: `node tools/musx/check.mjs <file-or-dir> [--limit n] [--verbose]`
  (1,373 real Finale files import without errors).

---------------------------------------------------------------------------------
## 5c. Editing model — Finale-style tools (`app/js/editor/tools.js`, `pointer.js`, `keyboard.js`)

`app.tool` ∈ `select | entry | shape | artic | expr | lyrics | chord | text | measure`; the current item of the
shape/artic/expr tools is `app.toolItem[tool]` (e.g. `{shape:'slur', artic:'staccato', expr:'mf'}`).
* **Select**: click = select, Shift = extend, drag = range, double-click a measure = whole stack, drag a selected
  range = copy to the drop measure (Alt = insert), double-click a note = edit it in Entry. Right-drag / middle-drag /
  Space-drag pan; Space + click plays from there.
* **Entry (Simple Entry)**: a faded "ghost" note shows exactly where the click will land. Click on an existing note
  → add to that chord; click on an empty spot → append after the last note of the voice (or replace a rest at that
  time). Keys: 1–8 durations, `.` dot, 0/Tab rest, 9 triplet, A–G pitches, ↑/↓ pitch, F2–F8 intervals,
  `=`/`-`/`N` accidentals, T tie, L flip, `/` beam break, R note↔rest, Ctrl+click select.
* **Shape (smart shapes)**: drag from note to note (or click a note → shape to the next note); slur, cresc/dim,
  trill, 8va/8vb/15ma, pedal, gliss, line. Clicking a shape selects it and shows diamond handles to retarget.
  Metatool keys (S, `<`, `>`, T, 8, B, 1, P, G, L) while dragging/clicking.
* **Artic / Expr**: click a note (or marquee) to apply the current articulation/expression; metatool letters/digits.
* **Lyrics / Chord / Text / Measure**: click to type at that note / measure; Measure tool opens the measure menu.
* Toolbars group variants Photoshop-style (`ui/flyout.js` + `ui/groups.js`): one button shows the current choice,
  hovering/long-pressing opens the flyout (e.g. every note value, every rest value), the choice is remembered.
* Layout classes (`native.js classifyLayout`): `html.phone` (≤ 860 px, not a tablet), `html.tablet`
  (coarse pointer, short side ≥ 600 and long side ≥ 900), `html.desktop`, plus `portrait` / `touch`;
  a `jse-layout` event fires when the class changes (rotation, window resize).

---------------------------------------------------------------------------------
## 5d. MuseScore import / export (`app/js/io/mscz.js`)

```js
export const MSCZ_EXTENSIONS = ['.mscz', '.mscx'];
export function looksLikeMscx(textOrBytes) → boolean
export function importMscx(xmlText, { fileName, styleXml } = {}) → ScoreDoc
export async function importMscz(data, { JSZip, fileName } = {}) → ScoreDoc      // zip (.mscz) or plain XML (.mscx) bytes
export function exportMscx(score, { target = 3, warnings } = {}) → string         // format 3.02
export async function exportMscz(score, { JSZip, target = 3, warnings } = {}) → Uint8Array
```
* Reads formats 2.00–2.07, 3.00–3.02, 4.00–4.70 (5.00-dev with a warning); MuseScore 1.x is refused with an
  explanation. Writes 3.02 (MuseScore 3.6), which MuseScore 3 and 4 open.
* `score.importInfo = { from:'musescore', version, program, warnings }`; `opts.warnings` (an array) receives a short
  Korean line for everything an export dropped or approximated.
* A MuseScore file must fill voice 1 of every measure exactly: the exporter completes it with invisible rests and
  turns a too-long measure into an irregular one (`len`). Format notes, every mapped element, measured numbers and
  the oracle tools (real MuseScore 3.6.2 / 4.5.2 run headless): `tools/mscz/README.md`.
* Checks: `node tools/mscz/check.mjs <dir> [--export]`, `compare.mjs`, `roundtrip.mjs prepare|verify`.

---------------------------------------------------------------------------------
## 5e. NoteWorthy Composer import / export (`app/js/io/nwc.js` + `nwc-*.js`)

```js
export const NWC_EXTENSIONS = ['.nwc', '.nwctxt'];
export const NWC_ENCODINGS   // [{ id:'utf-8'|'euc-kr'|'windows-1252'|'shift_jis'|…, label }]
export function looksLikeNwc(bytes) → boolean
export async function importNwc(data, { encoding = 'auto', fallbackEncoding = 'windows-1252', fileName } = {}) → ScoreDoc
export function exportNwctxt(score, { warnings } = {}) → string                   // NWC 2.75 text, UTF-8
export async function exportNwc(score, { version = '2.75' | '1.75', warnings } = {}) → Uint8Array
```
* Reads binary `.nwc` 1.55–2.75 (`[NWZ]` + zlib; 2.75 carries the text format) and `.nwctxt`. Old files hold text in
  the Windows code page of the machine that wrote them: `encoding:'auto'` looks at the bytes, a font / header hint,
  then `fallbackEncoding` (the UI passes `'euc-kr'` for a Korean interface). `importInfo.encoding` says what was used,
  `encodingGuessed` that it was a guess — the UI then offers "글자가 깨졌나요?" to re-import with another one.
  `nwc-encoding.js` carries a full CP949 table (Node's `euc-kr` decoder lacks 8,822 Hangul syllables).
* Writes `.nwctxt`, `.nwc` 2.75 and — experimental — `.nwc` 1.75 (old binary layout, CP949 text). NoteWorthy Composer
  itself could not be run: the writers are checked against three independent open-source readers and by round trip.
* What NWC cannot hold (tuplets other than triplets, ottava lines — written as sounding pitch —, more than two
  layers, ornaments …) is approximated with a warning. Details and numbers: `tools/nwc/README.md`.

---------------------------------------------------------------------------------
## 5f. Files of other programs: detection and the open flow (`io/ssnap.js`, `ui/importflow.js`)

`sniffFile(name, bytes)` → `'ssnap' | 'musicxml' | 'mxl' | 'musx' | 'musescore' | 'nwc' | 'midi' | 'image' | 'pdf' |
'json'` or a key of `FOREIGN_SCORE_FORMATS` — by extension first, then by content (`<museScore`, `[NWZ]`,
`!NoteWorthyComposer`, zip entry names, `MThd`, `SIBELIUS` …). Audio files are recognised by the caller (MIME / extension).
`FOREIGN_SCORE_FORMATS` = closed formats JSE cannot read (`sibelius` .sib, `finale-old` .mus/.ftm, `encore`,
`dorico`, `capella`, `guitarpro`, `overture`): each `{ name, ext, how /* Korean steps to export MusicXML there */ }`.
`openForeign(ui, file)` imports MuseScore / NWC files, or shows that how-to with a "MusicXML 파일 열기" button.
Sibelius `.sib` is proprietary, undocumented and encrypted — the route in both directions is MusicXML
(export dialog: "Sibelius용 (MusicXML)", "Finale용 (MusicXML)"). An imported score always becomes a new `<name>.ssnap`.
Export dialog (`ui/exportdlg.js`): groups 인쇄·이미지 / 다른 악보 프로그램 (MuseScore .mscz|.mscx, NWC .nwc 2.75|
.nwctxt|.nwc 1.75, Sibelius, Finale, MusicXML) / 소리·JSE; `app.settings.exportFormat` / `exportDpi` preselect.
File pickers: on Android an accept list with an extension Android has no MIME type for (.ssnap, .mscz, .nwc …)
is replaced by "any file" (`native.js pickerAccept`), otherwise such files could not be chosen.

---------------------------------------------------------------------------------
## 6. Native shim (`window.ScoreSnapNative`) — implemented by Electron preload / Capacitor plugin

The web app always uses `app/js/native.js`, which falls back to pure-web behaviour when the shim is absent.

```ts
interface ScoreSnapNative {
  platform: "windows"|"android"|"web";
  appVersion: string;                                  // native shell version
  // files
  onOpenFile(cb: (file: {name:string, mime:string, base64:string}) => void): void;   // called on launch (file association) and while running
  saveFile(opts: {name:string, mime:string, base64:string, suggestDialog?:boolean}): Promise<{path:string}|null>;
  openFileDialog(opts: {accept:string[]}): Promise<{name,mime,base64}|null>;        // optional
  shareFile?(opts: {name,mime,base64,title}): Promise<void>;                          // Android
  // updates
  checkForUpdates(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): void;
  installUpdate(): Promise<void>;                      // restart / apply
  getUpdateSettings(): Promise<{auto:boolean, channel:string, url:string}>;
  setUpdateSettings(s: Partial<{auto:boolean}>): Promise<void>;
  // desktop only (Electron, frameless window — the web UI draws glass min/max/close buttons)
  windowControls?: { minimize(): Promise<WinState>; toggleMaximize(): Promise<WinState>; toggleFullScreen(): Promise<WinState>;
                     close(): Promise<void>; getState(): Promise<WinState>; onStateChange(cb: (s: WinState) => void): void };
  onMenu?(cb: (action: string) => void): void;          // macOS native menu only
  // settings (v1.1.0) — every method optional; the web app shows an option only when its method exists
  setKeepScreenOn?(on: boolean): Promise<void>;         // Windows: powerSaveBlocker · Android: FLAG_KEEP_SCREEN_ON
  // Windows (Electron)
  getAppSettings?(): Promise<object>; setAppSettings?(partial: object): Promise<void>;   // shell copy: rememberBounds, startMaximized, disableGpu, defaultDir …
  chooseFolder?(opts: {defaultPath?}): Promise<string|null>; openSystemSettings?(page: 'default-apps'): Promise<void>;
  showSettingsFile?(): Promise<void>; relaunch?(): Promise<void>; setZoomFactor?(f: number): Promise<void>;
  getAppInfo?(): Promise<object>; onCloseRequest?(cb: () => void): void;                  // close guard → ui.requestClose()
  // Android (plugin api 2)
  setImmersive?(on: boolean): Promise<void>; setOrientation?(o: 'auto'|'portrait'|'landscape'): Promise<void>;
  vibrate?(ms: number): Promise<void>; onBackButton?(cb: () => void): void; minimizeApp?(): Promise<void>;
}
type WinState = { maximized: boolean, fullscreen: boolean, focused: boolean };
type UpdateStatus =
  | { state:"idle" } | { state:"checking" } | { state:"up-to-date", version }
  | { state:"available", version, notes? } | { state:"downloading", version, percent }
  | { state:"ready", version }               // downloaded; applies on restart (Electron) or immediately after reload (Android/web)
  | { state:"done", version }                // shown once after an update was applied
  | { state:"error", message }
```

---------------------------------------------------------------------------------
## 7. Auto-update protocol

* **Web/PWA**: `sw.js` precaches `app/` (versioned cache name). On launch and every 60 min while online
  the app calls `registration.update()`; a new worker `skipWaiting()`s, the page reloads at a safe moment
  (no unsaved edits, or right after autosave) and shows the toast “업데이트 완료 — v1.2.0”.
  Installed version is kept in localStorage `ssnap.installedVersion` to detect the first run after an update.
* **Windows (Electron)**: `electron-updater`, provider `github` (owner/repo in `electron/package.json → build.publish`),
  `autoDownload=true`, `autoInstallOnAppQuit=true`; status forwarded through the shim. On first launch after
  install of a new version the app shows the “업데이트 완료” toast (compares `appVersion` with stored value).
* **Android (Capacitor)**: web bundle OTA. `UPDATE_BASE_URL/version.json`:
  ```json
  { "version":"1.2.0", "web":{"bundle":"web-1.2.0.zip","sha256":"…"},
    "android":{"apk":"JSE-1.2.0.apk","minNative":"1.0.0"}, "windows":{"installer":"JSE-Setup-1.2.0.exe"}, "notes":"…" }
  ```
  The plugin downloads the zip when online (Wi-Fi or any network, user setting), verifies sha256, extracts
  to `files/bundles/<version>/`, calls `WebView.setServerBasePath`, persists it, and reloads → “업데이트 완료”.
  If `minNative` > installed native version, it offers the APK download instead.
  The same `version.json` is published by CI next to the web bundle (GitHub Pages or Releases).

---------------------------------------------------------------------------------
## 8. Coding conventions

* ES2022 modules, no bundler needed; `"use strict"` semantics; no globals except `JSZip`, `PDFLib` (vendor).
* Korean-first UI strings via `t('key')` in `i18n.js`; logic/error messages for users in Korean.
* Pure modules (`model`, `engrave/layout`, `omr`, `io/musicxml`, `io/mscz`, `io/nwc*`, `io/midi`, `settings.js`) must run in Node 22 without DOM
  so they can be unit-tested with `node --test tools/tests/*.test.js`.
* Never mutate a ScoreDoc outside `model/commands.js` (undo/redo relies on it).
* Keep functions small; comment the engraving/OMR heuristics (why, not what).
---------------------------------------------------------------------------------
## 9. Settings (`app/js/settings.js`, `app/js/ui/settings.js`)

One registry describes every option: id, section, type (toggle / select / range / color / action), default,
platforms and a `when(ctx)` test, label + description + search keywords, and how it is applied. `app.prefs` is the
manager (`app.setSetting(id, value)`, `app.emit('settings', { id, value })`, reset / export / import as
`jse-settings.json`); values live in `localStorage['ssnap.settings']` (`_v: 2`, older objects are migrated).
`ui.settings(sectionId?)` opens the window (도움말 › 설정…, `Ctrl+,`, the gear button, the phone ⋯ menu):
* desktop — two panes with a search box; tablet — two panes; phone — a list of pages, each page full screen.
* sections: `general display editing newScore playback recognition files update windows android web device advanced`.
  `windows` exists only in the Electron shell, `android` only in the Capacitor shell, `web` only in a browser / PWA;
  inside a section every row is shown only where it works (touch rows on touch screens, wheel rows with a mouse …).
* New scores (`app.applyNewScoreDefaults(score)`: new file, photo → new score, audio → new score) take page size,
  orientation, margins, staff size, measure numbers and text styles from `newScore.*`.
The complete list of keys, defaults and where each is read, the platform options with their shell side, and what
could only be checked in a real Windows / Android build: `tools/settings/README.md`.

