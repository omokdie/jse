# OMR photo-accuracy work (v1.0.1)

## Results (fixed splits; `node tools/omr/stage_eval.mjs --dir <split>`)

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

## Corpus (goal 1)

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

## Pipeline changes

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

## Remaining failure modes (eval_photo)

* hard photos (≤ 10 px staff space, heavy JPEG): heads 67 % recall, pitch 28 %.
* barline precision 85 % (stems / thick strokes accepted) and recall 77 % → wrong measure
  splits, which `fitVoice` turns into duration errors.
* key signatures (merged accidentals) and time signatures (66–90 %); hollow vs. filled is
  learned, but whole notes are rare in the training data (77 samples).
* durations (beams / flags counting) still heuristic.
* not done: Finale-corpus page generator (`importMusx` + engraver geometry → GT), glyph model
  training, more training data (only ~47 of 160 planned training pages were used).

## Commands

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
