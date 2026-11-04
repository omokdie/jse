# OMR photo-accuracy work

## Round 6 (after v1.0.7, last round): new holdout6, key signatures on photos

Round 6 is the last training round. See "Where to continue" at the end of this file.

### Results (`node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<split>`; pitch / duration / exact measure count)

| split | v1.0.7 | after | notes |
|---|---|---|---|
| **holdout6_photo** (128 photos, frozen: music never used before, from 2 new corpora, + 3 never-used fonts) | 88.0 / 87.1 / 71.1 % | **88.3 / 87.1 / 71.1 %** | evaluated once, code frozen |
| — scan (25) / flat (46) | 95.5/95.0/72.0 · 93.5/93.4/80.4 | 95.5/95.0/72.0 · 93.5/93.4/80.4 | |
| — curl (32) / hard (25) | 90.9/90.0/71.9 · 66.4/63.9/52.0 | 90.9/90.0/71.9 · **68.2**/63.9/52.0 | hard page key 68 → 72 % |
| — per stage | clef 96.6, page key 89.8, time 73.7, barline R/P 89.9/99.6, heads R 94.5, acc R/P 65.1/97.2 | 96.6, **90.6**, 73.7, 89.9/99.6, 94.5, 65.1/97.5 | |
| — part A (music21 corpus + Lecuona, 80) / part B (OpenScore Lieder, 48) | 91.2/88.5/70.0 · 82.0/84.7/72.9 | 91.2/88.5/70.0 · **83.1**/84.7/72.9 | piano (14) 70.3/77.5/50.0, single staff 91.1 → 91.5 |
| — never-used fonts: Eugene / Punzón / Legato (12 each) | 88.1/83.0 · 91.0/81.3 · 90.2/93.2 | unchanged | pitch / duration |
| holdout6_pages (64 clean pages) | 95.6 / 96.1 / 81.3 | **95.6 / 96.1 / 81.3** | time signature 74.1 → 75.9 % |
| holdout5_photo (80, dev this round) | 77.3 / 80.9 / 66.3 | **77.6 / 81.0 / 66.3** | hard 44.8 → 46.5; Leland 40.9 → 44.2 |
| holdout5_pages (40) | 92.6 / 91.6 / 82.5 | **92.7 / 91.6 / 82.5** | |
| holdout4_photo (80, dev) | 83.6 / 88.9 / 81.3 | **86.8 / 88.9 / 81.3** | page key 86.3 → 95.0 % (Petaluma scans / flat / curl +25…37 notes each) |
| holdout4_pages (40) | 92.1 / 97.2 / 87.5 | **92.8 / 97.2 / 87.5** | |
| holdout3_photo (82) / holdout3_pages (41) | 80.2/84.9/80.5 · 93.2/96.0/87.8 | **80.3**/84.9/80.5 · 93.2/96.0/87.8 | page key 90.2 → 92.7 % |
| fresh_photo (56) | 84.5 / 89.2 / 67.9 | **86.1 / 89.2 / 67.9** | page key 83.9 → 87.5 % |
| eval_photo (60) | 87.7 / 86.1 / 55.0 | **88.3 / 86.1 / 53.3** | one photo: 43 → 42 measures, +46 notes right |
| eval_clean (60) / base (40) / aug (80) | 97.5/97.7/83.3 · 98.1/97.6/95.0 · 92.7/93.7/77.5 | unchanged | |

No photo or page of any dev split lost more than one note (pitch or duration) against v1.0.7, and clean pages show no regression. The 90 % target is
**not reached**: holdout6 photos 88.3 % pitch, 87.1 % duration, with scans at 95.5 % and hard photos at 68 %. holdout6
is easier than holdout5: 33 of its 64 pages are in C, and part A is early music with few accidentals. The same code
reads 77.6 % on holdout5 photos (chromatic Lieder and quartets).

Timing (Node, 2 evaluations in parallel, lyrics off): 2.40 s per holdout6 photo (v1.0.7 2.53 s) and 2.85 s per
holdout5 photo (2.95 s). Chromium in the app worker, through the UI scan flow incl. the lyric stage, fresh browser per
run, same machine and photo for both versions: 6.96 s for a curled photo (holdout4 013; v1.0.7 6.93 s; key now E major
instead of C) and 3.4 s for a hard piano photo (v1.0.7 3.9 s). No console errors. Shipped weights are unchanged at
294 KB (glyphs 87, rhythm 87, heads 60, bars 59). 27/27 tests pass.

### holdout6 (built and frozen before any change)

* **Part A, two corpora never used before** (pages 000–039, `--seed 83`). From the **music21 corpus** (mirror
  `github.com/muscorpus-corpora/music21_corpus`; `cuthbertLab/music21` was not reachable): Monteverdi madrigals
  (books 3–5), Trecento mass movements and motets (PMFC 6/12/13/23/24, incl. Ciconia), Zacara da Teramo (`luca`),
  Corelli op. 3/1, C. P. E. Bach H186 and Weber's clarinet concertino. The music is public domain. The encodings are
  distributed with the encoders' permission, some for non-commercial use only, so they are used here for evaluation
  only and nothing is shipped. Also from **bonillamusic/LecuonaXML** and **GraingerXML** (CC0). None of these composers
  occurs in the Finale corpus, When-in-Rome, OpenScore Lieder or the String Quartets, checked by name. The music21
  corpus's Schoenberg, Verdi, Debussy, Handel, Bach, Haydn, Mozart, Beethoven, Schumann, Schubert, Joplin and Beach
  were excluded for that reason. 36 Monteverdi and 27 Trecento files are UTF-16 and were converted (the app's importer
  reads UTF-8). The page generator accepted 40 pages: Trecento 20, Monteverdi 17, C. P. E. Bach, Zacara and Lecuona's
  "Siboney" (voice).
* **Part B** (pages 100–123, `--seed 89`): 24 OpenScore Lieder songs from 187 songs by the 37 Lieder composers that are
  in no earlier set. They are not in the Finale corpus or When-in-Rome, and they are not holdout5's composers. Round 5
  trained nothing on them. It has 6 piano pages and keys from −6 to +4.
* **Three fonts never used before**, all SIL OFL: Eugene (`mikkopatama/eugenefont`), Punzón (`mikkopatama/punzonfont`)
  and Legato (`eNote-GmbH/Legato`), 6 pages each. The other pages use 9 known fonts.
* `tools/omr/holdout6.json` holds the 262 generator files (`files`) and 84 `reserved` files of the same collections;
  none may be used for training. MusicXML is in `/tmp/r6music/h6`, extracted by `/tmp/r6work/scripts/extract_h6.py` and
  `extract_h6b.py`.
* `corpus/holdout6_pages` has 64 pages (7 piano, 4,281 notes, 1,551 measures). `corpus/holdout6_photo` has 128 photos
  (`gen_photo.py --split holdout6`, seed 8601): 25 scan, 46 flat, 32 curl and 25 hard. sha1 of the folder listings:
  photo `bcd55c29…`, pages `36007654…`; content hashes are in `/tmp/omrw/r6_holdout6_freeze.txt`.

```sh
python3 tools/omr/smufl_glyphs.py --font /tmp/r6src/mikkopatama_eugenefont/Eugene.otf --out /tmp/omr_fonts/eugene.json   # + Punzon.otf → punzon, Legato.otf → legato
node tools/omr/gen_finale_pages.mjs --musicxml --src /tmp/r6music/h6 --keys <part-A file list> --count 40 --per-folder 2 --fonts eugene,punzon,legato,finalebroadway,bravura,leland,petaluma,leipzig,sebastian,finalemaestro,freeserif,mscore --out /tmp/r6work/h6pages --seed 83
node tools/omr/gen_finale_pages.mjs --musicxml --src /tmp/r6music/h6 --keys <part-B file list (OSL6__*)> --count 24 --per-folder 2 --fonts legato,eugene,punzon,mscore,finalemaestro,freeserif,sebastian,leipzig,petaluma,leland,bravura,finalebroadway --out /tmp/r6work/h6pagesB --seed 89   # pages renumbered 100–123
python3 tools/omr/gen_photo.py --pages tools/omr/corpus/holdout6_pages --split holdout6 --start 0 --count 32 --per-page 2 --out /tmp/omrw/r6h6   # + --start 32 --count 32 → corpus/holdout6_photo
```

**What was run on holdout6, and when** (KST, 2026-11-04; log `/tmp/omrw/r6_holdout6_log.txt`):

* 08:52–08:58: the v1.0.7 baseline (`git archive HEAD app tools` → /tmp/v107) on holdout6_pages and _photo. Not opened
  until the end.
* 08:54–08:56: an interim build (the key-vote change only) on holdout6_pages, started too early by mistake. It was
  deleted unopened at 08:57.
* 09:43: code frozen (md5 list `/tmp/omrw/r6_final_code_md5.txt`). 09:56–10:02: the final code on holdout6_pages and
  _photo. 10:03: both results opened for the first time.
* No change was made after that.

### Changes (dev: holdout5 (now dev), holdout4, holdout3, fresh, eval_photo; clean sets checked)

1. **Key signature from windows** (`readKeyWindows`, photo pipeline). It runs when no key accidental was found as a
   component: blurred accidentals merge with the clef or fall apart into pieces between the staff lines, and Petaluma's
   wide sharps form one blob. Windows are placed where a key signature sits: the clef's pitch pattern (treble sharps
   F C G D A E B at half-space positions 0, 3, −1, 2, 5, 1, 4 below the top line, flats 4, 1, 5, 2, 6, 3, 7; bass +2,
   alto +1), evenly spaced at 0.85–1.45 sp after the clef. The tight ink box (line-free image) in each window is
   classified by the glyph model. A sharp counts only if its box is centred on its position; a flat's box must lie
   above it. A run is accepted at ≥ 2 sharps with mean p ≥ 0.9, or ≥ 3 flats with p ≥ 0.97 (a note head with an up-stem
   in a flat's window looks like a flat). A clef component much wider than any clef glyph (Petaluma's alto clef with 3
   sharps was one 5.9 sp component) is scanned from inside, and there ≥ 3 at p ≥ 0.97 are needed (the bass clef's curl
   and dots read as 2 sharps). Fixed boxes were tried first: false flats at p 0.86–1.0 on key-0 and sharp-key pages.
2. **Unconfirmed window keys are undone**. After all staff headers, a provisional page key vote runs. A staff whose
   window reading disagrees with it gets back its header end and its components, which then hold the first notes.
3. **Page key vote** (`voteKey`). On low-resolution photos (≤ 11 px staff space) a key signature is often missed on
   most staves, so "nothing found" counts 0.12 there instead of 0.35. A key read on a single staff is accepted only if it
   is clear: ≥ 3 accidentals with confidence ≥ 0.8. One or two accidentals after the clef are often the first notes'.
   A 2-flat reading on 1 of 5 staves of a key-0 page had cost 36 notes on eval_photo before this limit. Hard photos of
   holdout3/4/5 gain +0.7 to +1.2 pitch points from this alone. With changes 1–2 the hard photos go from
   44.8 → 46.5 (holdout5), 61.7 → 64.7 (holdout4) and 47.4 → 48.1 (holdout3).

Tried, not kept:
* A lower threshold for accidental windows on low-resolution photos (0.92 → 0.8): no change, because the windows are
  rejected before classification.
* Accidental windows without long vertical and horizontal runs. These are accidentals joined to stems, beams or slurs
  of beamed groups: 19 % of the in-measure accidentals on 14 flat holdout5 photos sit in a head's component. Recall
  rose 60.7 → 62.5 % but precision fell 97.0 → 92.8 % (94.4 % at p ≥ 0.985), and pitch did not move.

No model was retrained.

### What blocks 90 % now (holdout6 photos: 1,000 of 8,562 notes with a wrong pitch)

1. **Hard / low-resolution photos**: 53 % of the lost notes (532), at 68 % pitch and 64 % duration. Their page key is
   72 % (215 lost), and in 5 photos fewer than 85 % of the heads are found (161 lost). Clefs are 86 % (126 lost), and
   one hard photo kept the original pipeline with 0/7 clefs
   and 1/36 barlines (`057_117_single_freeserif1_hard`). On dev hard photos the wrong clefs were mostly alto clefs and
   grand staves that were not paired. Accidentals are 20 % on hard photos. The models see these photos only after
   upsampling to 12 px.
2. **Piano photos**: 70 % pitch (14 photos). Barlines through the grand staff are missed on curled and hard photos
   (0/5, 0/7 on the worst), and the measures then misalign.
3. **Accidentals inside measures** on flat and curl photos (flat other 167 + curl other 103 lost). Recall is 65 %
   (holdout5 48 %); 19 % of them are merged into a beamed group's component.
4. Rhythm: duration 87 %, exact measure count 71 %, barline recall 90 %, and 74 % of time signatures read (50 % on
   hard photos).

### Files (round 6)

`app/js/omr/omr.js` (`readKeyWindows`, undo of unconfirmed window keys after the headers, `voteKey`); tools:
`gen_photo.py` (split `holdout6`), `tools/omr/holdout6.json`, `tools/e2e/omr_scan.js` (timed scan-dialog check);
corpora `corpus/holdout6_pages`, `corpus/holdout6_photo` (git-ignored). Results are in `/tmp/omrw/r6_final_*.json`
(final code) and `r6_base107_holdout6_*.json` (v1.0.7). Dev checkpoints are `r6_k1…k6_*.json`.

## Round 5 (after v1.0.6): grand staves on photos, stems / dots / full-bar rests, key signatures

### Results (`node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<split>`; pitch / duration / exact measure count)

| split | v1.0.6 | after | notes |
|---|---|---|---|
| **holdout5_photo** (80 photos, frozen; unseen music + a never-used font) | 72.8 / 75.2 / 61.3 % | **77.3 / 80.9 / 66.3 %** | evaluated once, code frozen |
| — scan (16) / flat (28) | 92.6/91.0/75.0 · 79.1/79.3/60.7 | 92.9/92.3/75.0 · 84.7/87.0/64.3 | |
| — curl (20) / hard (16) | 71.2/73.9/60.0 · 42.3/52.8/50.0 | 79.7/82.2/65.0 · 44.8/57.2/62.5 | |
| — per stage | clef 89.1, page key 85.0, time 71.6, barline R/P 89.1/99.3, heads R 91.0, rests R 91.1, acc R/P 48.0/97.0 | 93.2, 87.5, 71.6, 91.5/99.6, 92.0, 91.1, 48.1/96.3 | |
| holdout5_pages (40 clean pages) | 92.6 / 90.6 / 82.5 | **92.6 / 91.6 / 82.5** | |
| holdout4_photo (80, dev this round) | 75.1 / 81.6 / 73.8 | **83.6 / 88.9 / 81.3** | scan 88.5/96.1, flat 89.0/94.5, curl 92.1/96.6, hard 61.7/65.6 |
| holdout4_pages (40, dev) | 92.1 / 95.8 / 87.5 | **92.1 / 97.2 / 87.5** | |
| holdout3_photo (82, dev) | 74.0 / 79.7 / 74.4 | **80.2 / 84.9 / 80.5** | scan 89.0/95.3, flat 89.7/92.7, curl 82.9/89.4, hard 47.4/51.8 |
| holdout3_pages (41) | 93.0 / 95.5 / 87.8 | **93.2 / 96.0 / 87.8** | |
| fresh_photo (56) | 83.7 / 85.7 / 67.9 | **84.5 / 89.2 / 67.9** | |
| eval_photo (60) | 84.1 / 84.3 / 56.7 | **87.7 / 86.1 / 55.0** | |
| eval_clean (60) | 97.5 / 97.8 / 83.3 | **97.5 / 97.7 / 83.3** | |
| base (40) | 97.6 / 97.1 / 92.5 | **98.1 / 97.6 / 95.0** | |
| aug (80) | 87.4 / 91.6 / 75.0 | **92.7 / 93.7 / 77.5** | |

holdout5 photos by font (pitch / duration, v1.0.6 → after): Finale Broadway (never used) 88.5/82.7 →
89.0/86.3, Finale Maestro 97.2/96.3, Sebastian 74.3 → 91.3, Bravura 84.1 → 88.3, MScore 69.3 → 75.3,
Petaluma 63.2 → 73.6, Leipzig 76.3, FreeSerif 72.3, Gootville 66.8, Leland 40.8 → 40.9; piano
59.9 → 70.8, single staff 80.1 → 81.0.  v1.0.6 = `git archive HEAD app tools` → /tmp/v106; results
/tmp/omrw/r5_final_*.json and r5_base106_*.json.  holdout5 was evaluated once, after the code was
frozen.

The 90 % target is **not reached** (holdout5 photos 77 % pitch, 81 % duration; scans 93 %).  Timing:
Node, 2 evaluations in parallel, lyrics off: 3.0 s per holdout5 photo (v1.0.6 2.8 s); Chromium, app
worker, UI scan flow incl. the lyric stage: 6.0 s for a curled photo (round 4: 5.9 s), 4.9 s for a
hard piano photo (now read as a grand staff, 12 / 12 measures).  Shipped weights unchanged (294 KB);
27/27 tests pass.

### What blocks 90 % now (holdout5 photos: 1,496 of 6,578 notes with a wrong pitch)

1. **Hard / low-resolution photos** — half of the lost notes (732; 44.8 % pitch): heads 74 %,
   accidentals 6 %, clefs 85 %, keys 75 %.
2. **"Other" errors on curled / flat photos** (588 of all lost notes): accidentals inside measures
   (recall 48 % on holdout5 — this music is chromatic), chord heads, notes lost in dense passages.
3. **Key signatures** (426): page key 87.5 % (curl 80 %).
4. **Clefs** (375) and the staves missed on hard photos (107).
5. One font is far below the rest: Leland 41 % pitch on holdout5 photos (single-font failure to be
   analysed on dev data next round; it was 94 % on holdout4).
6. Rhythm: 16th / 32nd vs eighth, tuplets, and the exact measure count (66 %; barline recall 91 %).

### holdout5 (built and frozen before any change)

* When-in-Rome is used up (2 files of collections no earlier set touched), so holdout5 music comes from
  two other CC0 corpora never used before: **OpenScore Lieder** (`github.com/OpenScore/Lieder`, 1,462
  songs as .mxl) — only songs by the 96 composers that occur in no earlier set (all When-in-Rome /
  Finale-corpus composers excluded, accents matched, Amy Beach excluded for her Finale song) — and
  **OpenScore String Quartets** (`github.com/OpenScore/StringQuartets`, 184 movements without
  Beethoven).  Split by composer folder: FNV-1a % 2 == 0 → holdout5 (312 songs + 67 quartet
  movements, `tools/omr/holdout5.json`), the other half may be used for training.  Sparse checkout:
  `git clone --filter=blob:none --no-checkout …` then `git checkout HEAD --pathspec-from-file=…`;
  MusicXML extracted to `/tmp/r5music/h5`.
* **Font never used before:** Finale Broadway (MuseScore repo, SIL OFL; its 32nd–128th flags fall
  back to FreeSerif) + Finale Maestro, Gootville, MScore (holdout4 fonts, never trained), Bravura,
  Leland, Petaluma, Leipzig, Sebastian, FreeSerif — 4 pages each.
* Engraver (generator realism, no change for the app's own font): key-signature accidentals are
  spaced by glyph width when a font's accidental is wider than 1.05 sp (`layout.js keySigStep`;
  Petaluma's 1.65 sp sharps no longer overlap into one blob; FreeSerif / Bravura / Leland unchanged).
  holdout5 was generated after this change.
* `corpus/holdout5_pages` (40 pages: songs with lyrics, quartet parts incl. viola / alto clef, piano
  accompaniments) and `corpus/holdout5_photo` (80 photos — 16 scan, 28 flat, 20 curl, 16 hard;
  `gen_photo.py --split holdout5`, seed 8501; sha1 of the photo folder listing `bae7e7aa…`).

```sh
node tools/omr/gen_finale_pages.mjs --musicxml --src /tmp/r5music/h5 --keys tools/omr/holdout5.json --count 40 --per-folder 2 --fonts finalebroadway,finalemaestro,gootville,mscore,bravura,leland,petaluma,leipzig,sebastian,freeserif --out tools/omr/corpus/holdout5_pages --seed 71
python3 tools/omr/gen_photo.py --pages tools/omr/corpus/holdout5_pages --split holdout5 --count 40 --per-page 2 --out /tmp/omrw/r5h5   # → corpus/holdout5_photo
```

### Changes (dev: holdout4, holdout3, fresh, eval_photo, clean sets)

1. **Clef default prior** (`assemble` clef vote): the usual clef of a staff (bass for the lower staff
   of a grand staff, treble otherwise) starts with a prior (0.75 / 0.1); weak size-rule guesses
   (0.35) need several systems to outvote it (holdout4 dev: three piano photos had lost their bass
   staff to a weak "alto"; 17 → 65 of 65, 12 → 38 of 41, 29 → 37 of 109 notes).
2. **Key signature**: after a run of accidentals, a unit that fails as a whole (the last accidental
   blurred into the time signature / first note) is classified from its left part, one accidental
   wide.
3. **Auto mode**: an original-pipeline result with staves whose clef was not found is no longer kept
   at once — the photo pipeline runs and the better result wins (a 4-flat flat photo: legacy read
   key 0 on 3 of 5 staves, 54 % pitch; photo pipeline 100 %).
4. **Clef windows at the staff start** (photos, when no component is accepted): the ink of fixed
   windows (−0.3…3.0 sp, −3.2…0.3 sp — a staff start detected right of the clef —, −0.3…2.4 sp) is
   classified as one shape (all pieces of a broken clef together).
5. **Virtual stems** (`virtualStems`, photo pipeline): a confident filled / half head (p ≥ 0.8)
   without a stem follows the column at its stem side with gaps ≤ 0.35 sp; a thin run ≥ 2.3 sp (not
   at a barline) becomes its stem, shared by chord heads on the same column.  Faint stems the
   binarisation lost are followed in the grey image (a column darker than both columns 2 px away by
   ≥ 12 % of the paper–ink contrast); "thin" is tested at several rows (a chord's stem runs through
   its other heads).  On 8 hard holdout4 photos 17 % of the GT heads were "detected but no stem":
   123 → 50 such heads.
6. **Merged key accidentals**: after a run of single accidentals, a unit that fails as a whole is cut
   at the run's own step (key signatures are evenly spaced) and each piece is classified on its own
   (two touching flats at different heights, 4.6 sp tall, read as "none" → 5 flats read as 3); a
   first accidental blurred into a too-wide clef is looked for one step before the first counted one.
7. **Full-measure rests**: a measure holding only a rest that fills it is written as a whole rest with
   `fullMeasureRest` (the app's convention, as in the Finale / MusicXML importers) — the decoder had
   made the whole-rest glyph of a 3/4 bar a dotted half rest (16 % of the duration errors on 40 dev
   photos).
8. **Augmentation dots on photos**: a blurred dot bridges to the staff line above / below it (the line
   removal keeps line pixels next to symbols) and its component is up to ~1.5 sp tall; such blobs
   (≤ 0.8 sp wide, crossing a line of the head's staff) count as dots.  12 dev photos: dotted notes
   with their dot found 36 → 79 of 86.
9. **Grand staves by layout** (`staves.js`): on blurred / low-resolution photos the brace and the
   system's left barline are too faint for the connector test and every staff became its own system
   (a piano page read as unrelated single staves: 8 of 16 hard holdout4 photos are piano, pitch 10–
   40 %).  An even number of staves whose gaps alternate (inner gaps < 14 sp and × 1.35 smaller than
   every outer gap) are paired.  Hard piano photos: 15 → 86 %, 27 → 81 %, 68 → 89 % pitch.
10. **Key-signature pieces stacked on each other** (a thin sharp cut in two by a staff line: same
    columns, gap ≤ 0.5 sp, each < 1.5 sp tall) are merged into one unit before classification (a
    4-sharp Leipzig photo read 2 sharps on most staves → 88 → 100 % pitch).

Tried, not kept: a fixed-step cut of key signatures blurred into the clef (no dev gain); ignoring the
whole-shape clef score of components wider than 4.5 sp (no change on 162 dev photos); looser
virtual-stem limits (2.0 sp, p ≥ 0.7: +4 heads on 8 hard photos).  No model was retrained (the
round-4 retrains gave nothing; on hard photos only ~5 % of the GT heads are missed by the head
classifier / candidates, far less than the stem / layout losses fixed above).

### Files (round 5)

`app/js/omr/omr.js` (clef prior and staff-start windows, key-signature step cut / stacked pieces /
clef-merged first accidental, virtual stems, dots, full-measure rests, auto-mode clef check),
`app/js/omr/staves.js` (grand staves by layout), `app/js/engrave/layout.js` + `render.js`
(`keySigStep`: key-signature spacing by glyph width for wide music fonts — no change for the app's
own font); tools: `gen_photo.py` (splits holdout5, ftrain5), `tools/omr/holdout5.json`; corpora
`corpus/holdout5_pages`, `corpus/holdout5_photo` (git-ignored).

## Round 4 (after v1.0.5): clef selection, staff detection, keys / time / accidentals, new holdout

### Results (`node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<split>`; pitch / duration / exact measure count)

| split | v1.0.5 | after (shipped code) | notes |
|---|---|---|---|
| **holdout4_photo** (80 photos, frozen; unseen music + 3 unseen fonts) | 68.9 / 79.9 / 70.0 % | **75.1 / 81.6 / 73.8 %** | 1st run (frozen code): 76.5 / 81.6 / 73.8 — see below |
| — scan (16) / flat (28) | 71.0/94.3/81.3 · 85.9/89.2/75.0 | 84.6/94.9/75.0 · 84.8/89.2/75.0 | flat: page key 82→75 % |
| — curl (20) / hard (16) | 81.7/89.2/80.0 · 26.3/42.8/37.5 | 88.0/92.7/90.0 · 37.9/46.1/50.0 | |
| — per stage | staff R 97.9, clef 83.7, page key 78.8, time 57.7, barline R/P 89.5/99.5, heads R 89.9, rests R 91.2, acc R/P 58.6/97.4 | 99.2, 89.2, 80.0, 57.7, 90.5/99.8, 92.3, 94.4, 62.3/94.5 | |
| holdout4_pages (40 clean pages of the same music) | 87.0 / 95.7 / 90.0 | **92.1 / 95.8 / 87.5** | clef 94→100; one page lost its exact count |
| holdout3_photo (82, dev this round) | 63.5 / 75.6 / 68.3 | **74.0 / 79.7 / 74.4** | scan 88.8/94.6, flat 79.3/83.3, curl 78.5/87.6, hard 38.1/43.0 |
| holdout3_pages (41, dev) | 84.1 / 92.3 / 85.4 | **93.0 / 95.5 / 87.8** | clef 93→100, page key 95→100 |
| fresh_photo (56, dev) | 81.1 / 85.1 / 66.1 | **83.7 / 85.7 / 67.9** | scan 94.1/95.3, flat 84.7/87.9, curl 84.6/87.1, hard 68.0/67.8 |
| eval_photo (60, dev, synthetic) | 83.2 / 85.9 / 53.3 | **84.1 / 84.3 / 56.7** | curl 83.0/85.4 (85.0/87.5), hard 61.6/61.7 (57.9/64.6) |
| eval_clean (60) | 96.5 / 97.8 / 83.3 | **97.5 / 97.8 / 83.3** | no regression |
| base (40) | 97.1 / 97.1 / 92.5 | **97.6 / 97.1 / 92.5** | no regression |
| aug (80) | 84.6 / 91.7 / 75.0 | **87.4 / 91.6 / 75.0** | |

holdout4 photos by font (pitch / duration, v1.0.5 → after): **unseen fonts** (Finale Maestro, Gootville,
MScore) 80.4/83.4 → 84.3/87.1 (Finale Maestro 87.9/89.3 → 83.8/87.0, Gootville 61.2/68.1 → 78.7/82.2,
MScore 89.9/92.3 → 89.8/92.0); seen fonts 63.2/78.0 → 70.6/78.6 (Leland 94.1/88.9, Leipzig 77.1/83.3,
FreeSerif 69.3/80.9, Bravura 68.4/63.9, Petaluma 45.1/74.9); piano 58.2 → 68.3, single staff 79.0 → 81.5.

**How holdout4 was used.** Built and frozen first (40 pages / 80 photos, sha1 of the photo folder
listing `a273012d…`, pages `b24b9927…`); v1.0.5 measured from `git archive HEAD app tools` → /tmp/v105.
The 1st look was with the code frozen after all dev work (76.5 / 81.6 / 73.8, /tmp/omrw/r4_final_*.json).
The final dev check right after showed an alto-clef regression on eval_photo (thin synthetic alto clefs
that v1.0.5 got right only through the size rule; change 1 had made them "missing" → treble); it was
fixed on eval_photo alone (weak size-rule vote, eval_photo 81.9 → 84.1, aug 84.3 → 87.4, holdout3
photos −0.7, fresh / clean sets unchanged) and holdout4 was measured a 2nd time with that shipped code
(75.1 / 81.6 / 73.8, r4_finalB_*.json: three piano photos lost their bass staff to a weak "alto" vote,
see next steps).  No change was made after looking at holdout4.

The 90 % target is **not reached** (holdout4 photos 75 % pitch, 82 % duration; clean pages 92 / 96 %).
Timing: Node, 2 evaluations in parallel on this 2-core machine, lyrics off: 3.2 s per holdout4 photo
(v1.0.5 2.7 s), 2.7 s per holdout3 / fresh / eval photo, 1.9 s per clean page; Chromium, app worker in
the UI scan flow incl. the lyric stage (fresh browser each run): 5.9 s for a curled photo (v1.0.5 on the
same machine and photo: 5.9 s), 4.9 s for the binarised Vivaldi scan (v1.0.5 found no staff there).
Shipped weights unchanged (294 KB); 27/27 tests pass.

### What blocks 90 % now (holdout4 photos, 1st run: 1,351 of 5,752 notes with a wrong pitch)

1. **Clefs** (49 % of the lost notes; clef 61–66 % on hard photos): clefs broken or blurred into other
   shapes; one wrong staff clef loses the whole staff.  In the shipped code a weak size-rule vote can
   also outvote the grand-staff default (lower staff = bass) when no system has a classified clef —
   found on holdout4, so it must be checked on dev next round: weak votes should not beat the default.
2. **Key signatures with 4–6 accidentals** (33 %): Petaluma 4–5 sharps read as 0 on every staff (the
   generator spaces key accidentals 1 sp apart, so Petaluma's 1.65 sp sharps overlap into one blob),
   Finale Maestro / MScore 4–5 flats under-counted on flat photos and scans; page key on flat photos
   fell 82 → 75 % — possibly change 7 (a ≤ 1.75 sp unit that is clearly one accidental is not cut:
   two tightly spaced flats can be that narrow).  Needs a dev check (not tuned on holdout4).
3. Hard photos in general (38 % pitch): heads recall 75 %, accidentals 16 %, barlines 79 %; the
   faintest ones still lose staves (thin-line mask at 6–8 px staff space).
4. Accidentals inside measures (recall 62 %), dots and 16th/32nd (duration 82 %), barline recall
   (exact measure counts 74 %).  Retraining the glyph / rhythm models with more fonts and hard photos
   did not help on dev (below) — the remaining errors are mostly front-end / layout logic.

### Files (round 4)

`app/js/omr/omr.js` (clef selection + weak fallback, clef / time votes, key-signature units,
accidental windows, auto-mode guard), `staves.js` (permissive bands), `preprocess.js`
(`fillDarkBackground`), `frontend.js` (no permissive bands on rectified strips), `trace.js` (clef
diagnostics); tools: `gen_finale_pages.mjs --musicxml`, `gen_photo.py` (splits holdout4, ftrain4),
`tools/omr/holdout4.json`; corpora `corpus/holdout4_pages`, `corpus/holdout4_photo` (git-ignored).

```sh
git clone --filter=blob:none --sparse https://github.com/MarkGotham/When-in-Rome /tmp/r4fonts/wir   # + sparse patterns /Corpus/**/*.mxl,*.musicxml
git clone --depth 1 --filter=blob:none --sparse https://github.com/musescore/MuseScore /tmp/r4fonts/ms && git -C /tmp/r4fonts/ms sparse-checkout set fonts
python3 tools/omr/smufl_glyphs.py --font /tmp/r4fonts/ms/fonts/finalemaestro/FinaleMaestro.otf --out /tmp/omr_fonts/finalemaestro.json   # + gootville, mscore, musejazz
node tools/omr/gen_finale_pages.mjs --musicxml --src /tmp/r4music/wir --keys /tmp/omrw/r4/train4.json --count 150 --per-folder 3 --fonts sebastian,ekmelos,musejazz,bravura,leland,petaluma,leipzig,freeserif --out /tmp/omrw/r4/tr_pages --seed 61
python3 tools/omr/gen_photo.py --pages /tmp/omrw/r4/tr_pages --split ftrain4 --count 150 --fast --kinds hard,flat,curl,hard,scan,flat,hard,curl --out /tmp/omrw/r4/trp
node tools/omr/extract_glyphs.mjs --dir /tmp/omrw/r4/trp/ftrain4_photo,/tmp/omrw/r4/gmp/ftrain4_photo --out /tmp/omrw/r4/g4 --heads-out /tmp/omrw/r4/h4s --rhythm-out /tmp/omrw/r4/r4s --bars-out /tmp/omrw/r4/b4s
OMR_MODELS=/tmp/omrw/r4/mG node tools/omr/stage_eval.mjs --dir tools/omr/corpus/fresh_photo   # A/B of a model directory
```

### holdout4 (built and frozen before any change)

* The Finale corpus is exhausted: of the 469 cache files never used by any generated set (incl.
  holdout3 files + related), **0** pass the page generator's excerpt filter (worksheets, templates,
  percussion).  holdout4 music therefore comes from an external corpus never used before:
  **When-in-Rome** (`git clone --filter=blob:none --sparse https://github.com/MarkGotham/When-in-Rome`,
  incl. the OpenScore Lieder corpus — CC0 / public domain): 761 MusicXML scores (Lieder voice +
  piano, Mozart piano sonatas, Beethoven quartets, Bach, textbook examples) extracted to
  `/tmp/r4music/wir` (one file per score, path components joined by `__`).
  `gen_finale_pages.mjs --musicxml` reads them with the app's `importMusicXML`.
* Split by collection (first 3 path components, FNV-1a % 3 == 0 → holdout4): `tools/omr/holdout4.json`
  (327 files; `related` = 5 files with the same music as Finale pieces: Mozart K545, WTC I/1,
  Schubert "Ave Maria" — never used).  Training this round uses only the other collections.
* **3 fonts never used before** (MuseScore repo `fonts/`, SIL OFL, sparse clone): Finale Maestro,
  Gootville, MScore (Emmentaler) — holdout only; + Bravura, Leland, Petaluma, Leipzig, FreeSerif.
* `corpus/holdout4_pages`: 40 clean pages (25 single staff, 15 piano; keys −6…+6, 2/4…3/2, lyrics
  under the voice parts), `corpus/holdout4_photo`: 80 photos (`gen_photo.py --split holdout4`, seed
  8401, fixed profile mix incl. hard / low-res).

```sh
node tools/omr/gen_finale_pages.mjs --musicxml --src /tmp/r4music/wir --keys tools/omr/holdout4.json --count 40 --per-folder 2 --fonts finalemaestro,gootville,mscore,bravura,leland,petaluma,leipzig,freeserif --out tools/omr/corpus/holdout4_pages --seed 53
python3 tools/omr/gen_photo.py --pages tools/omr/corpus/holdout4_pages --split holdout4 --count 40 --per-page 2 --out /tmp/omrw/r4/h4   # → corpus/holdout4_photo
```

### Changes (dev: holdout3, fresh, eval, base)

1. **Clef selection** (`detectHeader`): the tall header components (overlapping their own staff by
   ≥ 1.5 sp — in piano music the treble clef of the staff above reached into the bass staff's header
   zone) are scored by the glyph classifier; the first accepted one is the clef, leading shapes it
   firmly rejects (rehearsal boxes, text) are skipped; a clef broken into pieces by staff-line removal
   is classified as the union of its pieces; in photos a clef blurred into the key signature / a slur
   is classified from its left part.  The size rule is only a fallback: on a shape the classifier
   does not read as accidentals it sets the clef type as a weak vote (confidence 0.35) without moving
   the header end (the curved half of a broken alto clef reads as a digit; a chord at the staff start
   must keep its notes).  The per-staff clef vote is
   confidence-weighted, and an uncertain (< 0.8) minority clef follows the page majority in both
   pipelines (was: photo pipeline only).  holdout3_pages: clef 93 → 99 %, pitch 84.1 → 88.4 %.
2. **Staff detection with dense beams** (`staves.js`): 16th/32nd beam groups inside the staff hide
   most of a band's line pixels in the thin-line mask (Vivaldi page: 3 of 7 staves on the clean page,
   0 on its photos).  Each band is also projected with a permissive threshold (0.22 instead of 0.36
   of the band width); a cluster must still contain clearly visible (0.36) bands, and tracking starts
   from one of them (permissive bands alone gave false staves on text / textures).
3. **Dark background** (`preprocess.js fillDarkBackground`, photo front end): solid dark regions
   around the page (binarised scans with black borders, dark tables) — a window of 1/30 of the image
   almost entirely dark — are painted with the paper level before any other step (they broke the
   grey levels and the projections: a binarised scan of the Vivaldi page found no staff).
4. **Auto mode guard** (`recognize`): a "confident" original-pipeline result is no longer returned
   at once when it is implausible — a meter guessed from the measures that no real piece uses (1/4,
   14/8 …) or a single staff with ≤ 3 measures.  On low-resolution photos the original front end
   found 1 of 4 staves, its few measures "fitted" a made-up meter (confidence 1.0) and the photo
   pipeline (4/4 staves) never ran.
5. Accidental windows (classify the ink box left of a head without accidental) also in the original
   pipeline (clean pages).
6. **Time-signature vote**: the first system's reading counts 1.5×, a meter no real piece uses (1/4
   read from a measure number / stray marks at later staff starts) 0.25× (a hard photo: 22 measures
   became 38).
7. **Key signature**: a unit ≤ 1.75 sp wide that is clearly one accidental (p ≥ 0.9) is no longer cut
   into "k touching accidentals" (the halves of Petaluma's 1.65 sp sharp classify as sharps → 2
   sharps); a single accidental may be up to 2.3 sp wide; the first accidental may start under the
   bass clef's dots (wide sharps were skipped → key 0 on every bass staff).
8. **Accidentals in measures**: the window left of a head reaches 2.6 sp up / 2.1 sp down (a flat's
   top is ~2.2 sp above its head: tall flats always touched the old ±1.9 sp window and were
   rejected); chord accidentals may sit in a second column (gap ≤ 2.6 sp instead of 1.4 sp for chord
   heads; a closer accidental is never overwritten).

Tried, not kept: rhythm (beam / flag) model retrained with the new stems (48 k, int8 val 95.8 %):
holdout3 photos 74.7 → 74.6 pitch, exact measures 74.4 → 73.2.  Note-head model retrain with the new
samples (954 k) ran out of memory — not attempted further.  Glyph classifier retrained on 178 k samples (round-2/3 sets + 43.6 k new ones from
150 When-in-Rome train pages + 60 glyph-mode pages in Sebastian, Ekmelos, MuseJazz + the 5 old fonts,
hard-heavy photo mix; int8 val 98.75 %): page key +1.3–3.6 points but pitch −0.4 (fresh) / −0.7
(holdout3), exact measures −1.8 / −2.4 → the shipped `glyphs.js` stays.

## Round 3 (after v1.0.4): learned rhythm + barline verifier, measure decoder, a stem-loss bug

### Results (`node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<split>`; pitch / duration / exact measure count)

| split | before (v1.0.4) | after | per stage (before → after) |
|---|---|---|---|
| **holdout3_photo** (82 photos, frozen, unseen music + 2 unseen fonts) | 59.1 / 65.1 / 61.0 % | **63.5 / 75.6 / 68.3 %** | page key 80.5→81.7, clef 82.4→82.4, barline R/P 82.0/84.5→85.4/99.7, heads R 85.2→89.1, rests R 87.5→91.3, accidentals R 39.1→45.3 |
| — scan (17) / flat (29) | 75.6/82.9/88.2 · 69.4/70.5/69.0 | 80.8/90.2/88.2 · 75.4/83.9/72.4 | |
| — curl (20) / hard (16) | 57.2/71.0/65.0 · 21.2/24.0/12.5 | 60.3/82.3/75.0 · 24.0/33.1/31.2 | |
| holdout3_pages (41 clean pages of the same music) | 81.4 / 89.3 / 82.9 | **84.1 / 92.3 / 85.4** | page key 92.7→95.1, barline P 92.5→96.9 |
| fresh_photo (56, dev this round) | 70.5 / 66.0 / 35.7 | **81.1 / 85.1 / 66.1** | scan 94.3/95.3, flat 85.6/87.8, curl 79.5/85.4, hard 59.0/67.6 (pitch/duration) |
| eval_photo (60, synthetic) | 66.9 / 65.7 / 36.7 | **83.2 / 85.9 / 53.3** | scan 97.2/97.2, flat 90.9/92.5, curl 85.0/87.5, hard 57.9/64.6 |
| eval_clean (60 clean) | 96.0 / 97.2 / 83.3 | **96.5 / 97.8 / 83.3** | no regression |
| base (40 clean) | 94.2 / 95.3 / 92.5 | **97.1 / 97.1 / 92.5** | no regression |
| aug (80) | 73.1 / 72.9 / 35.0 | **84.6 / 91.7 / 75.0** | |

holdout3 photos by font (pitch / duration, before → after): Sebastian (unseen) 60.8/67.7 → 75.9/85.8,
Ekmelos (unseen) 62.5/68.2 → 62.0/78.3, Leipzig 71.3/71.1 → 78.7/81.6, FreeSerif 66.4/62.2 → 74.3/69.7,
Leland 67.5/73.3 → 69.2/77.1, Petaluma 44.0/57.8 → 47.8/71.6, Bravura 47.6/57.0 → 46.7/64.6.
"Before" of the old splits = the round-2 final runs (same code as v1.0.3/v1.0.4, whose OMR files are
unchanged since v1.0.3); holdout3 "before" was run with the v1.0.4 tree (`git archive HEAD`).

Targets (≥ 90 % pitch and duration, ≥ 60 % exact measure counts on photos of unseen music) are
**not reached**: see "What blocks 90 %".  Timing: Node, this machine, lyrics off: 2.9 s per holdout3 photo (2.9 s before), 2.4–2.8 s on the other photo splits; Chromium, app worker incl. the lyric stage: 3.4–4.4 s per photo, 4.9 s in the UI scan flow.  Shipped weights (int8, lazy-loaded):
`models/glyphs.js` 87 KB, `models/rhythm.js` 87 KB (new), `models/heads.js` 60 KB (retrained),
`models/bars.js` 59 KB (new) — 294 KB in total.

### holdout3 (frozen before any round-3 tuning; evaluated once before and once after)

`tools/omr/holdout3.json` lists 136 Finale-corpus repertoire files never used by any generated set up to
v1.0.4 whose (normalised) title matches no used title, plus 24 `related` files (other arrangements /
worksheets of the same tunes, pieces already used).  `gen_finale_pages.mjs --keys tools/omr/holdout3.json`
→ `corpus/holdout3_pages` (41 clean A4 pages from 40 pieces: Bach inventions, Beethoven, Chopin,
Schumann, Satie, Joplin, Handy, Morton, folk songs, rounds, carols; 20 piano grand staves; 4,000+ notes;
7 fonts, 6 pages each — **Sebastian and Ekmelos never used for training**, Leipzig only for dev), and
`gen_photo.py --split holdout3 --per-page 2` → `corpus/holdout3_photo` (82 photos: 17 scan, 29 flat,
20 curl, 16 hard).  One generated page ("When the Saints Go Marching In", a tune used in training under
another title) was removed before evaluation.  Training data of this round excludes `files` + `related`
(`gen_finale_pages.mjs --exclude tools/omr/holdout3.json`).  fresh_photo / fresh_pages and a 20-photo
Finale dev set were used for all tuning.

### Changes

1. **Bug fix — stems lost to barlines of other systems** (`barlines.js`, since round 1): after barline
   detection every vertical object of the *page* at a barline's x (±2 px) was marked as a barline; stems
   of other systems at the same x lost their notes (~11 % of all note heads on photos: detected, but
   "no stem").  Now only objects inside the barline's own system are marked.  Largest single gain of
   the round (fresh_photo, measured together with the clef / key fixes 6–7: pitch +7.7, duration +7.1,
   exact measures +10.7 points).
2. **Barline verifier** (`models/bars.js`, 560+10 → 64 → 32 → 2): grey patch of each candidate on each
   staff + the rule measurements; candidates down to 75 % staff coverage reach it; a detected note head
   0.3–0.85 sp beside the stroke, a head at an end or long extensions veto (down-stems right after a
   barline were read as a second stroke → false double / final barlines).  Trained on 33 k candidates
   (labels from GT barline segments).  Dev: barline precision 88 → 100 %, recall 86 → 89 %.
3. **Learned beam / flag count** (`rhythm.js`, `models/rhythm.js`, 568 → 96 → 48 → 4: none / 8th / 16th /
   32nd+): 20×28 grey patch at the stem's free end (tip on top, down-stems flipped) + stem geometry +
   the rule counts; 35 k stems from detected events matched to exact GT durations; validation 97 %
   (rules 81 %).
4. **Measure decoder** (`decodeVoice`, photo pipeline): per measure, a dynamic program over the running
   tick total picks the cheapest durations that fill the time signature exactly — costs from the beam /
   flag classifier (temperature 0.6), head fill, dots, rest types — including **triplet groups** (three
   equal values in the time of two, cost 1.2); short measures are padded with rests (cheap pickup in the
   first measure).  Replaces fitVoice's greedy repairs there (fitVoice remains the fallback); overfull
   measures keep their notes and shorten durations before dropping anything.
5. **Accidentals touching their head**: the ink box of the window left of every head without an
   accidental is classified (≥ 0.92, sharp / flat / natural; not for displaced chord heads).
6. **Key signature**: confidence-weighted page vote over all staves ("nothing found" is a weak vote),
   explicit accidentals break near ties; an accidental blurred into the clef is cut off at the clef's
   thinnest column and classified; broken accidental pieces merge across slightly larger gaps.
7. **Clefs**: a staff whose clef was not found now takes the clef of the same staff in the other
   systems (was: always treble); in the photo pipeline an uncertain (< 0.8) minority clef follows the
   majority.  Warning text adjusted accordingly.
8. **Time signature**: a read time signature that almost no measure fits is replaced by the length most
   measures share (photo pipeline).
9. Learned heads: a candidate is a head unless "none" dominates (was: arg-max class ≠ none).
10. Retrained `heads.js` (736 k samples, + round-3 photos) — same size; `glyphs.js` kept (a retrain did
    not help on dev).

Tried and dropped (no gain on dev): lower head threshold (0.35 = 0.5: the head model is almost binary),
cheaper "add a dot" in the decoder, a key-signature position check (accidentals vs. the expected staff
positions), lower barline candidate threshold, note-content key evidence beyond tie-breaks (wrong-key
pages have no explicit accidentals to use).

### Data (round 3, all under /tmp; train split only, holdout3 excluded)

309 new Finale pages (5 fonts) → 309 photos with a hard-heavy profile mix (`--kinds hard,flat,curl,hard,
scan,flat,hard,curl`) + the round-2 photos; `extract_glyphs.mjs` now writes glyph, head, rhythm
(`--rhythm-out`) and barline (`--bars-out`) samples in one front-end run.  `train_rhythm.py` trains both
the rhythm counter and (`--kind bars`) the barline verifier.  `OMR_MODELS=<dir>` (Node only) loads models
from another directory for A/B runs; diagnostic options: `learnedRhythm`, `learnedBars`, `decode`,
`decodeT`, `dotAddCost`, `headMinProb`, `barCandMin`, `noFit`.

### What blocks 90 %

Measured on holdout3 photos (pitch 63.5 %, duration 75.6 %) — in order of the notes they cost:

1. **Clef misreads** (clef 82 % on holdout3 photos, 93 % even on its clean pages; dev 94 %): the clef
   detector takes the *first* tall component of the staff header.  On pages with a rehearsal-mark box
   (or other text) at the staff start that component is not the clef: the glyph classifier says "none"
   (0.98) but the old size rule still calls it bass, and the real treble clef right after it is never
   looked at → every note of the staff is wrong (e.g. "Row, Row, Row Your Boat" clean page: 0 % pitch,
   96 % duration).  Fix next: pick the clef among the tall header components with the classifier
   (skip rejected ones), and check clef consistency across systems.  Found on holdout3 after the final
   run, so it was not fixed this round.
2. **Hard / low-resolution photos** (16 of 82; 24 % pitch): heads recall 63 %, page key 50 %, barline
   recall 70 %.  Needs a dedicated low-resolution path (training / super-resolution at 6–10 px staff
   space) — the models see these photos only after rectification to 12 px.
3. **Key signatures** (page key 82 %): mostly "no accidental found" on curled / hard photos, a few
   over-counts; a wrong key corrupts every note of its steps.
4. **Accidentals inside measures** (recall 45 %) and **chord heads** (missing / extra heads in dense
   chords ≈ 5 % of notes).
5. **Rhythm**: dotted values vs. undotted and 16th / 32nd confusions; the decoder cannot overrule a
   confident classifier error when the measure still adds up.
6. **Barlines** (recall 85 %): one missed barline per page breaks the exact measure count (68 %).

The two unseen fonts are not the main problem (Sebastian is among the best fonts); Bravura and Petaluma
pages are the weakest, mostly through clefs and keys.

### Commands (round 3)

```sh
python3 tools/omr/smufl_glyphs.py --font /tmp/fonts3/sebastian/fonts/Sebastian.otf --out /tmp/omr_fonts/sebastian.json   # + ekmelos (generator only)
node tools/omr/gen_finale_pages.mjs --keys tools/omr/holdout3.json --count 42 --per-folder 12 --fonts sebastian,ekmelos,bravura,leland,petaluma,freeserif,leipzig --out tools/omr/corpus/holdout3_pages --seed 31
python3 tools/omr/gen_photo.py --pages tools/omr/corpus/holdout3_pages --split holdout3 --count 42 --per-page 2 --out /tmp/h3   # → corpus/holdout3_photo
node tools/omr/gen_finale_pages.mjs --split train --exclude tools/omr/holdout3.json --count 320 --per-folder 6 --fonts freeserif,bravura,petaluma,leland,leipzig --out /tmp/r3_pages --seed 41
python3 tools/omr/gen_photo.py --pages /tmp/r3_pages --split ftrain --start 1000 --count 309 --fast --kinds hard,flat,curl,hard,scan,flat,hard,curl --out /tmp/r3p
node tools/omr/extract_glyphs.mjs --dir /tmp/r3p/ftrain_photo --shard 0/2 --out /tmp/g0 --heads-out /tmp/h0 --rhythm-out /tmp/r0 --bars-out /tmp/b0   # + shard 1/2
python3 tools/omr/train_rhythm.py --data /tmp/r_old,/tmp/r0,/tmp/r1 --epochs 30                       # → models/rhythm.js
python3 tools/omr/train_rhythm.py --kind bars --data /tmp/b0,/tmp/b1 --epochs 30 --hidden 64,32       # → models/bars.js
python3 tools/omr/train_heads.py --data /tmp/heads_v1,/tmp/h_fclean,/tmp/h_old,/tmp/h0,/tmp/h1 --epochs 16
```


## Round 2 (after v1.0.2): real music, several music fonts, learned glyph classifier

### Results (`node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<split>`; pitch / duration / exact measure count)

| split | before (v1.0.2) | after | notes |
|---|---|---|---|
| **fresh_photo** (56 photos, NEW holdout: real music, 5 fonts) | 54.4 / 57.2 / 25.0 % | **70.5 / 66.0 / 35.7 %** | key sig 33→66 %, time sig 36→79 %, barline R/P 68/90→87/89 %, heads R 79→87 %, rests R 70→95 %, accidentals R 41→52 % |
| — scan (10) | 84.6 / 76.3 / 30.0 | 85.1 / 79.5 / 40.0 | |
| — flat (20) | 53.3 / 64.2 / 30.0 | 75.4 / 70.6 / 40.0 | |
| — curl (15) | 58.1 / 54.7 / 26.7 | 68.4 / 60.9 / 40.0 | |
| — hard (11) | 16.1 / 24.7 / 9.1 | 46.5 / 49.3 / 18.2 | |
| **fresh_pages** (the 28 clean pages of the holdout) | 85.6 / 86.2 / 82.1 | **89.8 / 88.5 / 82.1** | key 59→84 %, time 52→84 % |
| eval_photo (60, synthetic FreeSerif; seen in round 1) | 60.9 / 61.6 / 35.0 | **66.9 / 65.7 / 36.7** | key 60→84 %, time 57→67 % |
| — scan / flat / curl / hard | 90.7/90.1 · 72.1/65.8 · 51.0/64.6 · 28.0/29.1 | 93.7/91.9 · 74.4/69.1 · 65.2/68.5 · 34.8/36.3 | (pitch/duration) |
| eval_clean (60 clean) | 91.6 / 97.1 / 81.7 | **96.0 / 97.2 / 83.3** | no regression |
| base (40 clean, legacy corpus) | 92.0 / 93.9 / 85.0 | **94.2 / 95.3 / 92.5** | no regression |
| aug (80, legacy photo-like) | 68.4 / 68.4 / 26.3 | **73.1 / 72.9 / 35.0** | |

Targets (≥ 80 % pitch and duration, ≥ 60 % exact measure counts on photos) are **still not reached**:
best photo types (scans, flat photos) are at 75–85 % pitch, rhythm lags at 60–80 %, exact measure
counts at ~36 %.  Timing (Node, this machine, 14 photos, lyrics off): 2.33 s → 2.38 s mean, 4.4 s max;
in Chromium through the app's worker incl. the lyric stage: 3.8–4.9 s per photo.  Shipped weights: `models/glyphs.js` 87 KB (new), `models/heads.js`
60 KB (retrained, same size) — 147 KB in total.

The fresh holdout: `tools/omr/corpus/fresh_pages` (28 clean A4 pages = 28 parts from 21 Finale-corpus
collections that are never used for training; 24 single-staff, 4 piano; 5 are later pages without a
time signature; 2,315 notes, 547 measures; fonts Leipzig (never trained on) 6, Bravura 6, Petaluma 6,
Leland 5, FreeSerif 5) and `fresh_photo` (2 photos per page, `gen_photo.py --split holdout`, fixed
profile mix: 10 scan, 20 flat, 15 curl, 11 hard).  One generated page was dropped by a GT sanity rule
(a tenor-sax part imported in bass clef with 6–8 ledger lines on most notes; the rule is now a filter in
the generator).  The holdout was evaluated once before and once after; tuning used the dev sets below.

### New data generators (training-data side only, nothing here is shipped)

* `smufl_glyphs.py` — alternate engraver glyph tables from SMuFL fonts in the exact format and anchor
  conventions of `app/js/engrave/glyphs.js` (SMuFL origins are the engraver anchors except whole rests,
  time-signature digits, centred marks).  Fonts (SIL OFL) are cloned into /tmp, never into the repo:
  `git clone --depth 1 https://github.com/steinbergmedia/bravura` (also `steinbergmedia/petaluma`,
  `MuseScoreFonts/Leland`, `rism-digital/leipzig`).
* `gen_finale_pages.mjs` — real music: EnigmaXML cache → `enigmaToScore` → one single-staff part or one
  piano grand staff (treble/bass/alto, standard 5 lines), excerpt from measure 1 up to the first key /
  time / clef change, extra voices and grace notes dropped, ≤ 10 % notes beyond 4 ledger lines; random
  A4 layout (staff space 1.45–2.05 mm, margins, gaps, indent, measure numbers, staff-line / stem / barline
  / beam weights); font swapped into the engraver's `GLYPHS` (and `SP.head*`) at run time; page 1 (70 %)
  or page 2 (30 %, no time signature); grand-staff barlines drawn through the gap; sharp/librsvg
  rasterisation at 300 dpi; GT JSON in the gen_photo format (systems + line polylines, measures with
  events / heads / tuplets, barlines, `symbols` parsed from the SVG `<use>` glyphs and dots,
  `timeSigShown`).  Split by collection folder: FNV-1a(first ≤ 6 path parts) % 5 == 0 → `holdout`.
  `--glyph-mode` (classifier training only): random key / time signature / clef changes every 1–3
  measures → 10× more header glyphs (digits 0–9, common/cut, naturals, C clefs) in every font.
* `gen_photo.py` — new split seeds `holdout` 7001, `ftrain` 300001.
* `stage_eval.mjs` — time-signature check skipped on pages that show none; reports the share of images
  for which the photo pipeline won (`photo pipe`).

Data used this round (all under /tmp, regenerate with the commands below): 160 synthetic train photos
of round 1, 150 Finale train photos (FreeSerif / Bravura / Petaluma / Leland), 70 glyph-mode photos,
30 clean Finale train pages.  Dev sets for tuning: `corpus/dev_photo` (synthetic) and 20 Finale
train-split photos (`--seed 99`).

### Models

* `models/glyphs.js` (new, 87 KB): 16×24 grey patch + 8 geometry features → 128 → 64 → 26 classes
  (none, ♯ ♭ ♮, 6 rests, 3 clefs, digits 0–9, common, cut, dot).  82 k samples: connected components
  labelled by GT symbol boxes (IoU ≥ 0.35) plus "GT-box" crops (the GT symbol box mapped into the
  working image, jittered — teaches glyphs whose component is merged with a neighbour).  Validation on
  held-out images: 98.8 % (int8).  `extract_glyphs.mjs` gained GT-box samples, `--shard k/n` and
  `--heads-out` (note-head samples from the same front-end run).
* `models/heads.js` (retrained, same 580→64→32→4 architecture): round-1 synthetic samples + Finale
  photos in 4 fonts (413 k samples; whole notes 77 → 395, half notes 1.6 k → 3.1 k); validation 99.97 %.

### Pipeline changes (`omr.js`, `glyphs.js`)

1. The glyph classifier runs in both pipelines (the original pipeline keeps its morphological heads but
   reads clefs, key / time signatures, rests and accidentals with it; `options.learnedLegacy = false`
   restores the templates there).
2. `readKeyLearned`: key signature = run of classified sharps / flats after the clef; pieces cut apart by
   staff-line removal (a flat's stem and bowl) are merged first; a wide component of touching
   accidentals is cut into k equal pieces (vertical extent taken from each piece's central columns) and
   the most convincing k is kept; big clef dots / clef debris are skipped; broken clef pieces absorbed.
3. Key vote (photo pipeline): the same non-zero key on ≥ 2 and ≥ 35 % of the staves beats "0" (a
   misread key signature is mostly "nothing found").
4. Rests via the classifier with size / position gates; accidental size window widened (other fonts),
   class must be the classifier's top class.
5. Auto mode: legacy result kept if confidence ≥ 0.9 (unchanged); otherwise
   q = confidence × min(1, note share / 0.6) × staff share, and the photo result wins unless the legacy
   one is better by 0.05 (photos are what the photo pipeline is for; legacy results that lost most
   notes or whole systems used to win on confidence alone).
6. `mergeUnderfullMeasures` (photo pipeline): two neighbouring short measures that add up to exactly one
   measure were split by a false barline → merged (converse of `splitOverfullMeasures`).
7. Beam / flag count (photo pipeline) must hold at a second probe column: curved SMuFL flags are crossed
   twice by one probe column (eighth read as 16th was the most frequent rhythm error).

### Remaining failure modes (dev sets; fresh holdout looked at only for the final numbers)

* Rhythm: beams / flags / dots are still counted by rules; triplets are not modelled; `fitVoice`
  "repairs" measures that do not add up, which turns one detection error into several duration errors.
* Exact measure counts (~36 % of photos): barline recall ~87 %; one missed or extra barline per page
  already breaks the count.
* Hard photos (6.5–10 px staff space, JPEG 30–65): heads recall ~75 %, key signatures ~40–65 %.
* Accidentals inside measures: recall ~50 % (an accidental touching its note head is not a separate
  component; only free components are classified).
* Generator artefact: the engraver spaces key-signature accidentals 1.0 sp apart whatever the glyph
  width, so Petaluma's wide sharps overlap much more than in a real Petaluma engraving.
* Synthetic alto clefs (FreeSerif) fall apart into pieces after staff-line removal → clef missing.

### Commands (round 2)

```sh
# fonts → alternate glyph tables (generator only)
python3 tools/omr/smufl_glyphs.py --font /tmp/fonts/bravura/redist/otf/Bravura.otf --out /tmp/omr_fonts/bravura.json   # + petaluma, leland, leipzig
# fresh holdout (fixed): 28 pages → 56 photos
node tools/omr/gen_finale_pages.mjs --split holdout --count 60 --fonts leipzig,leland,bravura,petaluma,freeserif --out tools/omr/corpus/fresh_pages --seed 7
python3 tools/omr/gen_photo.py --pages tools/omr/corpus/fresh_pages --split holdout --count 29 --per-page 2 --out /tmp/h   # → move holdout_photo to corpus/fresh_photo
# training pages / photos (train split only)
node tools/omr/gen_finale_pages.mjs --split train --count 160 --fonts freeserif,bravura,petaluma,leland --out /tmp/ftrain_pages --seed 11
node tools/omr/gen_finale_pages.mjs --split train --count 70 --fonts freeserif,bravura,petaluma,leland --out /tmp/glyph_pages --seed 23 --glyph-mode
python3 tools/omr/gen_photo.py --pages /tmp/ftrain_pages --split ftrain --count 160 --fast --out /tmp/ft
# samples (glyphs + heads from one front-end run), training
node tools/omr/extract_glyphs.mjs --dir /tmp/ft/ftrain_photo --out /tmp/g_fin --heads-out /tmp/h_fin
python3 tools/omr/train_glyphs.py --data /tmp/g_syn,/tmp/g_fin,/tmp/g_glyphmode,/tmp/g_clean --epochs 30 --hidden 128,64
python3 tools/omr/train_heads.py --data /tmp/heads_v1,/tmp/h_fin,/tmp/h_glyphmode,/tmp/h_clean --epochs 20
```

## Round 1 (v1.0.1)

### Results (fixed splits; `node tools/omr/stage_eval.mjs --dir <split>`)

| split | metric | before | after |
|---|---|---|---|
| eval_photo (60 realistic photos, never trained on) | pitch acc | 52.0 % | **60.9 %** |
| | duration acc | 47.6 % | **61.6 %** |
| | measure count exact | 10.0 % | **35.0 %** |
| | staff recall | 91.0 % | **98.7 %** |
| | barline recall / precision | 53.4 / 96.1 % | **76.8 / 85.0 %** |
| | note-head recall / precision | 81.8 / 78.4 % | **85.8 / 94.4 %** |
| | symbol error rate | 62.7 % | **51.9 %** |
| eval_clean (the same 60 pages, clean) | pitch / duration / measures | 91.6 / 97.0 / 81.7 % | 91.6 / 97.1 / 81.7 % |
| base (legacy clean corpus, 40) | pitch / duration / measures | 91.3 / 92.8 / 75.0 % | **92.0 / 93.9 / 85.0 %** |
| aug (legacy photo-like corpus, 80) | pitch / duration / measures | 54.7 / 53.0 / 10.0 % | **68.4 / 68.4 / 26.3 %** |

Per photo kind (eval_photo, after): scan 90.7 / 90.1 / 66.7 %, flat 72.1 / 65.8 / 28.6 %,
curl 51.0 / 64.6 / 33.3 %, hard (6.5–10 px staff space, JPEG 30–65) 28.0 / 29.1 / 16.7 %
(pitch / duration / measure count).  Targets (≥ 80 % pitch and duration, ≥ 60 % measures on
photos) are **not reached yet**; see "Remaining failure modes".

Note: the legacy `aug` split has an augmentation bug (rotation of a page cropped to its content
moves music outside the image), so its numbers have a ceiling below 100 %.  The new splits keep
all music inside the frame.

### Corpus (goal 1)

* `photo_sim.py` — 3-D page model (book curl at the spine, bow, waves) seen by a pinhole camera
  (tilt, roll), background, cropped margins; paper tint/texture, ink colour/density, stroke
  weight, show-through, pencil marks; Lambertian gutter shading, gradients, vignetting, soft cast
  shadows, glare, white balance; defocus (also varying across the page), motion blur; low
  resolution, sensor + chroma noise, over-sharpening, JPEG (+ messenger re-compression),
  binarised scans.  One analytic forward map page→photo, so GT (staff-line polylines, measure /
  event / symbol boxes, note-head centres, barline segments) is exact; the image is rendered
  through the numerically inverted map.  Profiles: scan 20 %, flat 35 %, curl 25 %, hard 20 %.
* `gen_photo.py` — full A4 pages (300 dpi) from `gen_synthetic.py` content (imported, glyph
  calls recorded as symbol-level GT), then photos.  Disjoint seed ranges: eval 9001 (fixed, only
  used for reporting), dev 5001 (tuning), train 100001.  `--pages DIR` accepts any clean pages in
  the same GT format (e.g. Finale-rendered pages — not done yet, see below).
* `stage_eval.mjs` + `metrics.mjs` — per-stage scores (staff detection + line error, system
  grouping, clef / key / time, barlines, note heads by type, rests, accidentals) plus the
  end-to-end sequence metrics of `run_eval.mjs`.  Uses `recognize(img, {trace:true})`
  (`app/js/omr/trace.js`).

### Pipeline changes

`recognize()` now runs in `pipeline: 'auto'` mode: the original pipeline first (fast, best on
clean digital pages); if its confidence is < 0.9 the photo pipeline runs and the more confident
result wins (`result.pipeline` tells which).  `options.pipeline = 'legacy' | 'photo'` forces one.
Photo pipeline:

1. **preprocess.js** — illumination normalisation with a radius from the staff space; staff
   space chosen by consensus over 6 relative thresholds (noise floods penalised); thickness from
   the runs that form the 5-line period (robust to speckle); deskew ±15°; anti-aliased
   resampling; noise-adaptive denoising; a horizontally smoothed binary for staff detection; final
   threshold at the half-maximum of the *measured* staff-line darkness.
2. **staves.js** — band projections along 7 sheared directions (±7.5°), slope-aware clustering,
   comb tracking with drift → finds staves under perspective / curl (391/391 on eval photos).
3. **dewarp.js** — per system: tilt of verticals from projection sharpness of thin vertical
   strokes; every system resampled into a straight strip (lines horizontal, staff space exactly
   12 px, verticals vertical, aspect kept); strips stacked; `toOrig`/`fromOrig` composed, so the
   ctx contract (and the lyric stage) is unchanged.
4. **barlines.js** — staff-coverage evidence with 3-column tolerance, end-extension test, flank
   attachment test that ignores the second stroke of double / final / repeat barlines.
5. **heads.js + classifiers.js + models/heads.js** — note heads: candidates on the staff-position
   grid (box ink fraction maxima, 99.2 % candidate recall), classified none / filled / half /
   whole from a 24×24 grey patch by an MLP (580→64→32→4, int8, 60 KB, lazily imported).
   Validation accuracy on held-out training images ≈ 100 %.
6. Adaptive stem-width limit (blurred stems are 4–5 px wide).
7. **glyphs.js** (rests / accidentals / clefs / digits classifier) — runtime hook is in place but
   **no model was trained yet** (`models/glyphs.js` absent → original template matching is used).

### Remaining failure modes (eval_photo)

* hard photos (≤ 10 px staff space, heavy JPEG): heads 67 % recall, pitch 28 %.
* barline precision 85 % (stems / thick strokes accepted) and recall 77 % → wrong measure
  splits, which `fitVoice` turns into duration errors.
* key signatures (merged accidentals) and time signatures (66–90 %); hollow vs. filled is
  learned, but whole notes are rare in the training data (77 samples).
* durations (beams / flags counting) still heuristic.
* not done: Finale-corpus page generator (`importMusx` + engraver geometry → GT), glyph model
  training, more training data (only ~47 of 160 planned training pages were used).

### Commands

```sh
# corpora (eval / dev are fixed; train is large → keep outside the repo or under tools/omr/corpus*/)
python3 tools/omr/gen_photo.py --split eval  --count 60          # tools/omr/corpus/eval_{clean,photo}
python3 tools/omr/gen_photo.py --split dev   --count 40
python3 tools/omr/gen_photo.py --split train --count 160 --per-page 2 --out /tmp/omr_train
# train the note-head classifier → app/js/omr/models/heads.js
node tools/omr/extract_heads.mjs --dir /tmp/omr_train/train_photo,/tmp/omr_train/train_clean --out /tmp/heads_v1
python3 tools/omr/train_heads.py --data /tmp/heads_v1 --epochs 25
# (glyph classifier: extract_glyphs.mjs + train_glyphs.py, same pattern → models/glyphs.js)
# evaluation
node tools/omr/stage_eval.mjs --dir tools/omr/corpus/eval_photo     # per-stage + sequence metrics
node tools/omr/stage_eval.mjs --dir tools/omr/corpus/base
OMR_OPTS='{"pipeline":"photo"}' node tools/omr/stage_eval.mjs --dir tools/omr/corpus/dev_photo
node tools/omr/run_eval.mjs --dir tools/omr/corpus/eval_photo        # original report format
```

## Where to continue (state after round 6, the last round)

Training stopped after round 6. The code is in the working tree after v1.0.7 and is not committed by the agents.

### State of the art (final round-6 code; pitch / duration %)

| photo type | holdout6 (unseen, evaluated once) | holdout5 (dev; chromatic Lieder / quartets) | holdout4 (dev) |
|---|---|---|---|
| scan | 95.5 / 95.0 | 92.9 / 92.3 | 94.3 / 96.1 |
| flat photo | 93.5 / 93.4 | 84.7 / 87.0 | 92.0 / 94.5 |
| curled page | 90.9 / 90.0 | 79.7 / 82.2 | 94.0 / 96.6 |
| hard / low-res (6.5–10 px staff space, JPEG) | 68.2 / 63.9 | 46.5 / 57.6 | 64.7 / 65.6 |
| all photos | **88.3 / 87.1** (exact measure count 71 %) | 77.6 / 81.0 (66 %) | 86.8 / 88.9 (81 %) |
| clean pages | 95.6 / 96.1 | 92.7 / 91.6 | 92.8 / 97.2 |

Scans and flat photos of ordinary music are at or above 90 % pitch. Hard photos, piano photos and chromatic music are
not.

### Top blockers (evidence: holdout6 photos, 1,000 of 8,562 notes with a wrong pitch; `cause.py`-style split by the first failing stage)

1. **Hard / low-resolution photos: 53 % of the lost notes.**
   * Page key 72 % (215 lost notes; often no accidental is found on any staff).
   * Fewer than 85 % of the heads found on 5 photos (161 lost; staves and barlines missed too).
   * Clefs 86 % (126 lost; alto clefs, unpaired grand staves).
   * Accidentals 20 %.
   * Auto mode once kept the original pipeline with 0/7 clefs (`057_117_single_freeserif1_hard`).

   Idea: a native low-resolution path. Train the glyph / head models on samples cut at 6–10 px staff space, without
   upsampling; train a key-window classifier on GT key-signature windows (positives) and shifted windows (negatives);
   check auto mode against clef plausibility.
2. **Accidentals inside measures: recall 65 % (holdout5 48 %), precision 97 %.** On 14 flat holdout5 photos 19 % of
   them are in the same connected component as a head of a beamed group (stem / beam / slur contact). Simple
   stripping of long runs did not help (round 6, "tried"). They need a segmentation that knows the group's stems and
   beams, or a classifier for GT-box crops in beamed groups.
3. **Piano photos: 70 % pitch** on holdout6 (14 photos). Barlines through the grand staff are missed on curled and hard
   photos (0/5 and 0/7 on the worst), and the measures misalign. Dev hard piano photos also lose their grand-staff
   pairing.
4. **Rhythm / measures:** duration 87 %, exact measure count 71 %, time signature read on 74 % of the photos (50 % hard),
   barline recall 90 %. Remaining errors are 16th / 32nd vs eighth confusions and tuplets.

### Which holdout is still clean

**None.** holdout6 was evaluated once at the end of round 6, so it becomes a dev set like holdout3–5. The `reserved`
files in `holdout6.json` belong to the same collections, so they are not an independent test.

Never used anywhere, for a holdout7:
* OpenScore String Quartets composers with FNV-1a(folder) % 2 == 1. Round 5 used only the other half. The clone is in
  `/tmp/r4fonts/OpenScore_StringQuartets`.
* SMuFL fonts never used: Golden Age (`benwiggy/GoldenAge`), Bettenhoven and Skye (`JohnG0070/…`), and the
  Finale Ash / Jazz / Legacy / Engraver / Copyist / Petrucci fonts (`bencarp/finale-fonts`). Check each licence.

Build and freeze the holdout before changing anything, as rounds 3–6 did.

### Commands

```sh
# --- fonts → engraver glyph tables (generator only; repos cloned into /tmp, SIL OFL) ---
git clone --depth 1 https://github.com/steinbergmedia/bravura /tmp/fonts/bravura        # also steinbergmedia/petaluma, MuseScoreFonts/Leland,
#   rism-digital/leipzig, fkretlow/sebastian, tr-igem/ekmelos, musescore/MuseScore (sparse: fonts → finalemaestro, finalebroadway,
#   gootville, mscore, musejazz), mikkopatama/eugenefont, mikkopatama/punzonfont, eNote-GmbH/Legato
python3 tools/omr/smufl_glyphs.py --font <font.otf> --out /tmp/omr_fonts/<name>.json
# --- music sources ---
#   Finale corpus: /home/claude/enigma-cache (EnigmaXML of the user's 1,373 Finale files)
#   When-in-Rome / OpenScore Lieder / String Quartets: see rounds 4–5 (sparse clones, MusicXML extracted to /tmp/r4music, /tmp/r5music)
#   holdout6: music21 corpus mirror (github.com/muscorpus-corpora/music21_corpus), bonillamusic/LecuonaXML + GraingerXML → /tmp/r6music/h6
#   (scripts /tmp/r6work/scripts/extract_h6.py, extract_h6b.py; UTF-16 files converted)
# --- clean pages (real music, engraved by the app) and photos with exact ground truth ---
node tools/omr/gen_finale_pages.mjs [--musicxml --src DIR] --keys tools/omr/holdoutN.json --count N --per-folder 2 --fonts a,b,… --out DIR --seed S
python3 tools/omr/gen_photo.py --pages DIR --split holdoutN --count N --per-page 2 --out OUT   # → OUT/holdoutN_photo; exact commands per holdout in rounds 3–6
python3 tools/omr/gen_photo.py --split eval --count 60          # synthetic eval_clean / eval_photo (dev: --split dev --count 40)
python3 tools/omr/gen_synthetic.py --out tools/omr/corpus --count 40 --seed 1 ; python3 tools/omr/augment.py   # legacy base / aug
# --- training data (never from a holdout: gen_finale_pages.mjs --exclude tools/omr/holdoutN.json) and models ---
python3 tools/omr/gen_photo.py --pages TRAIN_PAGES --split ftrain5 --count N --fast --kinds hard,flat,curl,hard,scan,flat,hard,curl --out /tmp/trp
node tools/omr/extract_glyphs.mjs --dir /tmp/trp/ftrain5_photo --out /tmp/g --heads-out /tmp/h --rhythm-out /tmp/r --bars-out /tmp/b   # --shard k/n
python3 tools/omr/train_glyphs.py --data /tmp/g,… --epochs 30 --hidden 128,64      # → app/js/omr/models/glyphs.js
python3 tools/omr/train_heads.py  --data /tmp/h,… --epochs 16                      # → models/heads.js (subsample: 7 GB RAM)
python3 tools/omr/train_rhythm.py --data /tmp/r,… --epochs 30                      # → models/rhythm.js
python3 tools/omr/train_rhythm.py --kind bars --data /tmp/b,… --epochs 30 --hidden 64,32   # → models/bars.js
OMR_MODELS=/tmp/newmodels node tools/omr/stage_eval.mjs --dir tools/omr/corpus/holdout5_photo   # A/B a model directory
OMR_OPTS='{"keyWindows":false}' node tools/omr/stage_eval.mjs --dir …                          # A/B an option (round 6 key windows off)
# --- every evaluation (≈ 25 min on 2 cores; run 2 lists in parallel) ---
for s in holdout6_photo holdout6_pages holdout5_photo holdout5_pages holdout4_photo holdout4_pages holdout3_photo holdout3_pages \
         fresh_photo eval_photo eval_clean base aug; do
  node tools/omr/stage_eval.mjs --dir tools/omr/corpus/$s --json /tmp/omrw/X_$s.json > /tmp/omrw/X_$s.txt; done
git archive HEAD app tools | tar -x -C /tmp/v107 && (cd /tmp/v107 && node tools/omr/stage_eval.mjs --dir /home/claude/scoresnap/tools/omr/corpus/<split> --json …)   # baseline of a release
node --test tools/tests/*.test.js                                           # 27 tests
python3 -m http.server 8765 -d app &                                        # browser worker, real scan dialog (timing + result)
OMR_IMG=/abs/photo.jpg node tools/e2e/shot.mjs http://localhost:8765/ /tmp/omr-scan.png desktop tools/e2e/omr_scan.js
```

The corpora live in `tools/omr/corpus/` (git-ignored). Fonts, music clones and training samples live in /tmp and must
be regenerated after a machine reset. Rounds 5–6 results are in `/tmp/omrw/r5_*.json` and `r6_*.json`; per image, the
field `perImage` holds stage counts. Diagnostic options: `keyWindows` (false = off) and `dbgKW` (an array that collects
the window-reader decisions).
