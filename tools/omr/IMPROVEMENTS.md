# OMR photo-accuracy work

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
