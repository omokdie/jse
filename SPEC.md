# JSE — Technical Specification (v1)

JSE is an offline-first sheet-music program (product name **JSE**; internal identifiers keep the historical `scoresnap` prefix: MIME `application/x-scoresnap`, IPC channels `scoresnap:*`, format id `"scoresnap"`, Android package `kr.scoresnap.app`): photograph or load a
score image → recognise it (OMR) → edit it like a notation editor → save as `.ssnap`
→ export PDF / PNG / JPG / SVG / MusicXML / MIDI. One web code base runs as
a PWA (desktop + mobile browser), as a Windows program (Electron, `.exe` installer)
and as an Android app (Capacitor, `.apk`). All three open the same `.ssnap` files.

Everything is plain ES-module JavaScript, no framework, no build step required
(an optional esbuild bundle is produced for release). All modules live in `app/js/`.

---------------------------------------------------------------------------------
## 1. Repository layout

```
app/                     the web application (what every platform ships)
  index.html
  manifest.webmanifest   PWA manifest (file_handlers for .ssnap)
  sw.js                  service worker: offline cache + auto-update
  version.json           {"version":"1.0.0","build":"2026-11-03T..."}
  css/app.css
  js/
    main.js              bootstrap, wires UI ↔ editor ↔ io
    i18n.js              ko (default) / en strings
    model/score.js       data model helpers (createScore, ids, ticks, validation, pitch math)
    model/commands.js    undo/redo + edit operations on a ScoreDoc
    engrave/glyphs.js    music glyph outlines (generated from GNU FreeSerif; GPL+FE)
    engrave/layout.js    measures → systems → pages; horizontal spacing
    engrave/render.js    SVG engraving + geometry index for hit-testing
    editor/tools.js      Finale-style tools (entry target, smart shapes, articulations, expressions) — §5c
    editor/pointer.js    mouse/touch per tool (ghost note, drag-copy, marquee, pan)
    editor/keyboard.js   Finale-style shortcuts + metatools
    omr/omr.js           image → RecognitionResult (pure JS, runs in a Web Worker)
    omr/*.js             OMR stages (preprocess, dewarp, staves, barlines, heads, classifiers, lyrics/hangul)
    omr/worker.js        worker wrapper around omr.js
    io/ssnap.js          .ssnap container read/write (JSZip)
    io/musicxml.js       MusicXML import/export (.xml/.musicxml/.mxl)
    io/musx.js           Finale .musx/.ftmx import (§5b)
    io/midi.js           MIDI export (SMF type 1)
    io/export.js         PDF/PNG/JPG/SVG export
    io/storage.js        IndexedDB autosave, recent files
    playback/synth.js    WebAudio playback
    native.js            window.ScoreSnapNative shim (see §6)
    update.js            update manager UI/state (see §7)
    ui/ui.js             UI controller (title bar, option bar, tool rail, menus, files)
    ui/flyout.js         Photoshop-style grouped buttons with flyouts; ui/groups.js defines the groups
  vendor/jszip.min.js, vendor/pdf-lib.min.js
  fonts/LICENSE-FreeFont.txt
electron/                Windows desktop wrapper (electron + electron-builder + electron-updater)
mobile/                  Capacitor 6 Android project (intent filters for .ssnap/.musx/MusicXML, OTA web update)
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
    concertPitch:true,
    fonts:{ text:"", lyrics:"" }, // "" = default CSS stack
  },
  parts: Part[],
  measures: Measure[],            // every measure has staves[] with one entry per staff of every part, in part order
  spanners: Spanner[],
  sources: Source[],              // original images (OMR); may be empty
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
  texts?: { text, placement:"above"|"below", style:"plain"|"expression"|"technique"|"system" }[],  // measure-anchored text ("Verse 1")
  chords?: { id, tick, text:"Cmaj7/E", root?:"C", kind?:"maj7", bass?:"E", diagram?:{ frets:[-1,3,2,0,1,0], baseFret:1, barres:[] } }[],
  breaks?: { system?:true, page?:true },
  pickup?: true,                // anacrusis: shorter than the time signature is allowed
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
  dynamic?: "ppp"|"pp"|"p"|"mp"|"mf"|"f"|"ff"|"fff"|"sfz"|"sfp"|"fp"|"fz"|"rfz",
  lyrics?: { verse:1, text:"", syllabic:"single"|"begin"|"middle"|"end", extend?:true }[],
  texts?: { text, placement:"above"|"below", style:"plain"|"expression"|"technique" }[],
  arpeggio?: true, tremolo?: 1|2|3,
  fullMeasureRest?: true,        // whole-measure rest (centred) regardless of time signature
  hidden?: true,
  source?: { bbox:[x,y,w,h], confidence:0..1 }
}
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
  deskewAngle: number, binarizedPreview?: ImageData-like (debug),
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
  (split on spaces/hyphens), chords from `chordAssign`, expressions from `measExprAssign` + `textExprDef`,
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
* Pure modules (`model`, `engrave/layout`, `omr`, `io/musicxml`, `io/midi`) must run in Node 22 without DOM
  so they can be unit-tested with `node --test tools/tests/*.test.js`.
* Never mutate a ScoreDoc outside `model/commands.js` (undo/redo relies on it).
* Keep functions small; comment the engraving/OMR heuristics (why, not what).
