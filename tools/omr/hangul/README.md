# Hangul lyric recogniser (OMR lyric stage)

When a score photo is recognised, `app/js/omr/lyrics.js` finds the lyric lines
printed under each staff, reads them with the recogniser in
`app/js/omr/hangul.js` and attaches one syllable per note. The recogniser was
trained here, from the Korean fonts installed on the build machine, with numpy
only. Nothing is downloaded at build or run time.

## Files

| file | role |
|---|---|
| `app/js/omr/hangul.js` | inference: em-box sampling, ink normalisation, features, MLP, syllable decoding (pure JS, Worker + Node) |
| `app/js/omr/hangul-weights.js` | generated model (int8 weights + fp32 scales/biases, base64, ~1.05 MB), decoded on first use |
| `app/js/omr/lyrics.js` | lyric stage: text lines → syllable tokens → reading → verses → note assignment → `result.lyrics` |
| `tools/omr/hangul/charset.py` | classes: `HANGUL` + digits + punctuation `, . ! ? ( ) ~ ' " : -` + A–Z a–z + `NOISE`; jamo heads 19 / 21 / 28 |
| `tools/omr/hangul/core.py` | numerics shared with `hangul.js` (em-box sampling, normalisation, features) — keep both in sync |
| `tools/omr/hangul/gen_data.py` | training / evaluation samples (font registry, rendering, augmentation) |
| `tools/omr/hangul/fetch_fonts.sh` | sparse checkout of the Google Fonts Korean families used for training (OFL, training data only) |
| `tools/omr/hangul/train.py` | training (several sets, warm start / widening), int8 export, JS parity fixtures |
| `tools/omr/hangul/evaluate.py` | accuracy of shipped JS weights or checkpoints on sample sets, by font group / font / em size |
| `tools/omr/hangul/eval_pages.mjs` | page-level lyric metrics of several weight files on the same recognised music |
| `tools/omr/hangul/build_prior.py` | syllable unigram prior → `syllable_prior.json` |
| `tools/omr/korean_lyrics.py`, `tools/omr/gen_lyrics_corpus.py` | synthetic score pages with Korean lyrics + ground truth |
| `tools/omr/lyric_eval.mjs` | lyric metrics used by `run_eval.mjs` |
| `tools/omr/lyric_regression.mjs` | checks that the lyric stage never changes the recognised music |
| `tools/tests/hangul.test.js`, `tools/tests/lyrics.test.js` | JS ↔ Python parity, end-to-end lyric test |

## Model

* **Input**: one token (a syllable block or a symbol) cut out as an *em-box*.
  The box side is 1.25 × the height of the line's Hangul ink band. It is centred
  horizontally on the token's ink box and vertically on the band, then resampled
  from the original photo to 32 × 32 (bilinear with k×k supersampling). It is
  normalised to an ink map (paper = 75th percentile, ink = 2nd percentile) and
  quantised to 1/255. Ink of neighbouring tokens is masked out. Because the box
  is relative to the line, the size and position of `.` `,` `'` `-` stay
  visible to the classifier.
* **Features (768)**: Sobel gradient split into 8 directions, pooled on an 8×8
  grid ([1,2,1] smoothing, square root), plus 16×16 ink averages.
* **Network**: MLP 768 → 640 → 384 (ReLU) → 4 softmax heads: type (75 classes:
  `HANGUL`, 73 symbols, `NOISE`), initial (19), medial (21), final (28 incl.
  none). The decoder scores the 2,350 KS X 1001 syllables as
  log p(i) + log p(m) + log p(f) + λ·log prior. The other 8,822 syllables
  remain readable, at a fixed penalty. Confidence = P(HANGUL) · p(i) · p(m) · p(f).
  The prior never enters the confidence.
* **Why an MLP on gradient features rather than a CNN**: it reaches 100 % clean
  and 95.8 % degraded syllable accuracy on its training fonts, trains in about
  10 min on 2 CPUs with numpy, and costs about 0.8 M multiply-adds per token in
  JS (fewer in practice: zero inputs are skipped, ~1.4 ms per token here, the same
  as the 512-unit v1). A comparable 3-layer CNN costs about 2.8 M, too slow for
  several hundred tokens per page on a phone.
* **Syllable prior**: counts of the 1,076 syllables in the 79,277-word list of
  Tesseract's Korean model (`kor.traineddata`, Apache-2.0), add-3 smoothed over
  the 2,350 KS syllables, stored as uint8 (−log p / 0.05). Weight λ = 0.6, tuned
  on a separate dev corpus: syllables read correctly were 98.89 % at λ = 0,
  99.12 % at 0.3, 99.20 % at 0.6 and 99.23 % at 1.0. The Tesseract binaries are
  used only to extract this word list. The app does not depend on them.

## Training data (`gen_data.py`)

Fonts (`gen_data.FONTS`, selected with `--fonts <group>`):

| group | fonts | role |
|---|---|---|
| `old` | Noto Sans CJK KR (Thin … Black, 7), Noto Serif CJK KR (ExtraLight … Black, 7), WenQuanYi Zen Hei — system fonts | v1 training fonts |
| `new` | Google Fonts (OFL): Nanum Myeongjo (3 weights), Song Myung, Hahmlet (9 weight instances of the variable font), Diphylleia; Nanum Gothic (3), Nanum Gothic Coding (2), Gothic A1 (9), Sunflower (3), Dongle (3), Orbit | added in v2: Myeongjo/Batang- and Gothic/Dotum-style text faces |
| `display` | Jua, Do Hyeon, Black Han Sans, Gugi, Stylish, Yeon Sung, Hi Melody, Poor Story, Nanum Pen / Brush Script, Cute Font, Gamja Flower, Single Day, Dokdo, East Sea Dokdo, Gaegu (3) | ~12 % of the new-font samples, for robustness |
| `holdout` | Gowun Batang (2, Myeongjo), Gowun Dodum (Dotum), IBM Plex Sans KR (7, Gothic) | **never trained on**: the unseen-font test |

`tools/omr/hangul/fetch_fonts.sh` fetches the Google Fonts (sparse git checkout,
~170 MB) into `/tmp/gfonts` (`$JSE_GFONTS` overrides the location). Only KS X 1001
syllables are drawn from fonts that lack the rest, and symbols a font lacks come
from FreeSans/FreeSerif. Latin letters and digits are also drawn from
FreeSans/FreeSerif. Each glyph is rendered at em = 64 px and then augmented:

* rotation (σ 1.2°), shear (σ 0.06), x-scale (σ 6 %), elastic warp
* stroke weight (partial dilate / erode)
* line remnants (underline, ledger, extender), specks
* downscaling to em = 9…48 px (a quarter of the `train` samples at 9–13.5 px;
  mode `train_small` = 9–14 px only), blur (σ up to 5.5 % of the em), noise,
  uneven light
* JPEG q 25–90, binarisation, low contrast
* em-box jitter (±4 % x, ±5 % y, ±8 % size)

The v2 training set has 1.06 M samples:

* the v1 set: 600 k samples, `old` fonts
* 340 k samples in mode `train` with the `new` + `display` fonts
* 120 k samples in mode `train_small` with all training fonts

Mix: 74 % KS X 1001 syllables, 8 % other syllables (so the jamo heads compose),
9 % symbols, 9 % `NOISE`. The noise samples are:

* left or right halves of syllables (over-segmentation)
* two syllables run together (under-segmentation)
* note heads with stems / ledger lines, beams, slurs and ties, hairpins
* dynamics (`p`, `mf`, `sfz`, `cresc.` …)
* scribbles and specks

Evaluation sets use other seeds:

* *clean*: black on white, em 22–36 px, no distortion
* *degraded*: all the photo-like degradations above at em 12–40 px, with
  milder blur and noise than training
* *small_clean* / *small*: the same two pipelines at em 10–12 px, i.e. about
  9–11 px of Hangul ink height

Syllables are drawn uniformly from KS X 1001, so these sets are scored with the
visual model only (`evaluate.py --no-prior`). The word-frequency prior helps on
real text, not on random syllables.

## Results: v2 (current) vs v1 (v1.0.2)

v1: 512 hidden units, `old` fonts only, 600 k samples. v2: 640 units, warm-started
from v1, 1.06 M samples with the new fonts and more small text, 5 epochs. Both are
scored as shipped (int8 `hangul-weights.js`).

**Sample sets.** Syllable accuracy, visual model only (`evaluate.py --no-prior`),
about 6,800 syllables per set (17,000 for the old-font clean/degraded sets).
Symbol accuracy is in brackets.

| fonts | clean | degraded | 10–12 px clean | 10–12 px degraded |
|---|---|---|---|---|
| **held out** (Gowun Batang / Gowun Dodum / IBM Plex Sans KR — unseen by both) | 99.68 → **99.87** % (99.0 → 99.5) | 93.41 → **94.69** % (93.4 → 94.0) | 97.55 → **98.28** % | 78.47 → **81.66** % (86.5 → 88.6) |
| old (Noto Sans/Serif KR, WenQuanYi — seen by both) | 99.99 → 100.00 % | 95.59 → 95.82 % | 99.20 → 99.47 % | 84.31 → 85.56 % |
| new text fonts (Nanum, Song Myung, Hahmlet, Gothic A1, … — seen by v2 only) | 96.7 → 99.7 % | 87.6 → 93.3 % | — | 72.9 → 80.8 % |
| display / handwriting faces | 53.4 → 84.9 % | 36.0 → 65.6 % | — | 23.9 → 44.1 % |

Held-out fonts one by one (degraded / 10–12 px degraded):

* Gowun Batang (Myeongjo): 91.8 → 93.5 % / 75.8 → 79.8 %
* Gowun Dodum: 94.1 → 95.4 % / 78.0 → 80.3 %
* IBM Plex Sans KR: 94.2 → 95.2 % / 80.8 → 83.8 %

**v1 on unfamiliar designs.** It read Song Myung (an old-style Myeongjo) at only
92.8 % clean and 77.7 % degraded; v2 reads it at 99.2 % and 90.1 % after
training on it. Unseen-font accuracy depends on how unusual the design is.
The three held-out fonts are conventional designs, which v1 already handled
fairly well. The earlier WenQuanYi hold-out experiment (99.0 % / 90.9 %) used a
smaller 200 k-sample model.

**Score pages.** The music was recognised once per page; the lyric stage then
ran with each model on that same result (`eval_pages.mjs`).

| corpus | pages | v1 → v2: read correctly | lyric char accuracy | text on the right note | lyric stage |
|---|---|---|---|---|---|
| `corpus_ko` clean (seen fonts) | 30 | 99.7 → 99.7 % | 99.7 → 99.7 % | 99.3 → 99.3 % | 264 → 274 ms |
| `corpus_ko` photo-like | 60 | 96.6 → **97.6** % | 96.3 → **97.3** % | 90.0 → 90.8 % | 303 → 302 ms |
| held-out fonts, clean¹ | 20 | 96.5 → **97.2** % | 91.3 → 92.1 % | 90.8 → 91.4 % | 275 → 291 ms |
| held-out fonts, photo-like¹ | 20 | 91.2 → **92.8** % | 77.4 → 77.6 % | 71.3 → 71.7 % | 374 → 368 ms |
| small text (em 10–14 px, seen fonts), clean | 6 | 99.2 → 99.4 % | 98.7 → 98.9 % | 96.3 → 96.4 % | 257 → 263 ms |
| small text, photo-like | 6 | 95.7 → **97.1** % | 91.9 → **93.3** % | 83.7 → 84.9 % | 376 → 320 ms |

¹ `gen_lyrics_corpus.py --font-set holdout`: 14 normal pages and 6 pages at
staff space 6–7 px (lyric em 9–14 px), plus 1 photo-like variant each. Detection
is 95 % on these clean pages. Almost all misses (165 of 171) are on two pages in
**IBM Plex Sans KR Thin at 9–10 px**: hairline strokes that small do not survive
the text binarisation. This is a detection limit, not a recognition limit, and
it is the same for both models.

Lyric-stage times are Node on this shared machine. The wider network costs the
same per token as v1 (1.45 ms per read), and the weights file is 1,050 KB
(v1: 856 KB). `lyric_regression.mjs` on `tools/omr/corpus/base` gives identical
music with and without the lyric stage on all pages, and no syllables on the
Latin-lyric pages.

**Tried and dropped: a small-text fine-tune.** Two more epochs from v2 at
lr 5e-4, with another 200 k `train_small` samples (1.26 M in all), changed
held-out 10–12 px degraded by +0.2 points, held-out degraded by −0.1 and
old-font 10–12 px by +0.6. All of these are within noise (±0.3–0.5 points on
these sets), so v2 was kept. At 10–12 px with blur, JPEG and noise, the 32 × 32
gradient features seem close to their limit. A further gain would need context
(a syllable language model over the line) or a different input
representation.

**Tried and dropped: re-reading doubtful small tokens.** Averaging three
em-boxes (shifted ±5 % / ±3 %, scaled ±6 %) for tokens below a confidence gate
gained at most +1.1 points on held-out 10–12 px text and nothing on seen fonts,
while re-reading 40–60 % of the tokens. `gen_data.py --tta` and
`evaluate.py --tta-gate` reproduce the test.

Flagging (`lowConfidence`, confidence < 0.8) marks 73 % of the misread
syllables on photo-like `corpus_ko` pages with v2 (v1: 67 %).
`tools/omr/lyric_regression.mjs` checks that the recognised music is identical
with and without the lyric stage. It also checks that pages with Latin dummy
lyrics (`tools/omr/corpus/base`) get no syllables.

## Retrain / re-evaluate

Run heavy steps with `nice -n 10` on a shared machine (2 CPUs here).

```bash
sh tools/omr/hangul/fetch_fonts.sh                          # Google Fonts → /tmp/gfonts/ofl (or set JSE_GFONTS)
python3 tools/omr/hangul/build_prior.py                     # optional: refresh syllable_prior.json (needs tesseract tools)
G="python3 tools/omr/hangul/gen_data.py"
$G --mode train       --fonts old   --count 600000 --seed 1  --out /tmp/jse-hangul/train.npz   # v1 set (~6 min)¹
$G --mode train       --fonts new   --count 340000 --seed 41 --out /tmp/jse-h2/train_new.npz   # ~5 min
$G --mode train_small --fonts train --count 120000 --seed 42 --out /tmp/jse-h2/train_small.npz # ~4 min
# v2 as shipped: warm start from the v1 checkpoint, widened to 640 units (~10 min + ~6 min features)
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --tag v2 --init /tmp/jse-hangul/model.npz --hidden 640,384 \
    --epochs 5 --lr 1.5e-3 --no-export --time-budget 800 \
    --train-sets /tmp/jse-hangul/train.npz,/tmp/jse-h2/train_new.npz,/tmp/jse-h2/train_small.npz
#   (from scratch instead: drop --init and use --epochs 10 — about twice as long)
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --tag v2 --resume ...   # if the time budget stopped it
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --tag v2 --export-only --prior-weight 0.6   # JS weights + fixtures
node --test tools/tests/*.test.js                           # parity + end-to-end tests

# sample-set evaluation (eval sets: gen_data.py --mode clean|degraded|small_clean|small --fonts holdout|old|new …)
python3 tools/omr/hangul/evaluate.py --no-prior --by-font --by-size \
    --models v1=<old hangul-weights.js>,v2=app/js/omr/hangul-weights.js --sets <set.npz>,<set.npz>,…
# page-level evaluation, same music for every model
python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 24 --seed 9
python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 6 --start 24 --seed 9 --kinds piano
python3 tools/omr/augment.py --corpus tools/omr/corpus_ko --per-image 2 --seed 7
python3 tools/omr/gen_lyrics_corpus.py --out /tmp/jse-h2/corpus_unseen --count 14 --seed 21 --font-set holdout
python3 tools/omr/gen_lyrics_corpus.py --out /tmp/jse-h2/corpus_unseen --count 6 --start 14 --seed 21 --font-set holdout --sp 6,7 --kinds mono,dense
python3 tools/omr/gen_lyrics_corpus.py --out /tmp/jse-h2/corpus_small --count 6 --seed 23 --sp 6,7 --kinds mono,dense
python3 tools/omr/augment.py --corpus /tmp/jse-h2/corpus_unseen --per-image 1 --seed 5   # (and corpus_small, --seed 6)
node tools/omr/hangul/eval_pages.mjs --dir tools/omr/corpus_ko --models v1=<old weights>,v2=app/js/omr/hangul-weights.js
node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md   # music + lyrics
node tools/omr/lyric_regression.mjs --dir tools/omr/corpus/base   # music unchanged by the lyric stage
```

¹ The shipped v1 set was generated before `train` mode got its small-text share
(em 10–48 px log-uniform, 35 % at 14–28 px), so a regenerated set differs slightly.

The v1 weights (unchanged from 1.0.0 to 1.0.2) can be retrieved from git:
`git show v1.0.0:app/js/omr/hangul-weights.js > /tmp/v1-weights.js`.

Font hold-out experiment (v1 era):
`gen_data.py --exclude-fonts wqy-zenhei` for training,
`--only-fonts wqy-zenhei` for the clean/degraded sets, then
`train.py --data <dir> --train-count 200000 --epochs 6 --no-export`.

`train.py` writes `app/js/omr/hangul-weights.js` and
`tools/tests/fixtures/hangul-fixtures.json` together. Always re-run
`node --test tools/tests/hangul.test.js` after touching `core.py` or
`hangul.js`.

## Notes for SPEC.md / HANDOFF.md (to be merged by the doc owner)

* SPEC §4 `recognize()` options: `lyrics?: boolean` (default true; `false`
  skips the lyric stage).
* SPEC §4 `RecognitionResult` gains:
  * `lyrics: { eventId|null, measureId|null, staffIndex, systemIndex, verse, text, confidence 0..1, lowConfidence: boolean, bbox:[x,y,w,h] (original image px), alternatives: string[] }[]`
    One entry per recognised syllable. `eventId` is null when the syllable
    could not be attached to a note. `lowConfidence` is set when
    `confidence < 0.8`, so the review UI can highlight it. The confidence is
    the recognition confidence × the note-alignment quality; it is halved
    when the syllable could not be attached to a note.
  * `lyricLines: { staffIndex, systemIndex, verse, text, bbox, confidence, syllables }[]`
  * `lyricStats: { lines, tokens, reads, ms }`
* The syllables are written into the score as `event.lyrics = [{ verse, text, syllabic: 'single' }]`.
  This matches the editor's Korean input: one Hangul syllable per note, no
  hyphens. Trailing punctuation stays with its syllable (`"요."`), and a
  leading `(` or quote is prefixed. Rests and tied continuation notes get no
  syllable.
* Verse numbers (`1.`, `2.` left of a line) set the verse and are not
  syllables. Stacked lines without numbers become verses 1, 2, … from top to
  bottom.
* A warning is added when syllables are uncertain or could not be attached to a note.
* HANDOFF §4: lyric recognition is implemented; the review dialog highlights
  `lowConfidence` syllables (v1.0.2). Recogniser v2 (2026-11-04) adds 26 Google
  Fonts Korean families, more small-text training and a 640-unit hidden layer.
  The API is unchanged and the weights file grew from 0.86 to 1.05 MB.
  Remaining work:
  * Latin (English) lyric lines, which need word grouping and hyphen → syllabic
  * lyrics placed above the staff
  * hairline (Thin) text at ≤ 10 px, which is lost in the text binarisation
* Tooling hooks, not for app use:
  * `recognize(img, { onLyricStage(s) })` passes the lyric-stage inputs (ctx,
    staves, events, image, nolines, score) to a callback.
  * `hangul.js` `setModel(model)` swaps the recogniser.
  * `tools/omr/hangul/eval_pages.mjs` uses both to compare weight files on
    identical music.
