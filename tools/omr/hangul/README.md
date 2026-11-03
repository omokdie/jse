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
| `app/js/omr/hangul-weights.js` | generated model (int8 weights + fp32 scales/biases, base64, ~0.86 MB), decoded on first use |
| `app/js/omr/lyrics.js` | lyric stage: text lines → syllable tokens → reading → verses → note assignment → `result.lyrics` |
| `tools/omr/hangul/charset.py` | classes: `HANGUL` + digits + punctuation `, . ! ? ( ) ~ ' " : -` + A–Z a–z + `NOISE`; jamo heads 19 / 21 / 28 |
| `tools/omr/hangul/core.py` | numerics shared with `hangul.js` (em-box sampling, normalisation, features) — keep both in sync |
| `tools/omr/hangul/gen_data.py` | training / evaluation samples (rendering + augmentation) |
| `tools/omr/hangul/train.py` | training, evaluation, int8 export, JS parity fixtures |
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
* **Network**: MLP 768 → 512 → 384 (ReLU) → 4 softmax heads: type (75 classes:
  `HANGUL`, 73 symbols, `NOISE`), initial (19), medial (21), final (28 incl.
  none). The decoder scores the 2,350 KS X 1001 syllables as
  log p(i) + log p(m) + log p(f) + λ·log prior. The other 8,822 syllables
  remain readable, at a fixed penalty. Confidence = P(HANGUL) · p(i) · p(m) · p(f).
  The prior never enters the confidence.
* **Why an MLP on gradient features rather than a CNN**: it is already at
  99.99 % clean and 95.7 % degraded syllable accuracy, it trains in about 8 min
  on 2 CPUs with numpy, and it costs about 0.65 M multiply-adds per token in JS.
  A comparable 3-layer CNN costs about 2.8 M, which is too slow for several
  hundred tokens per page on a phone. In the first 4-epoch run (120 k samples),
  the same MLP reached 99.8 % clean and 92.0 % degraded.
* **Syllable prior**: counts of the 1,076 syllables in the 79,277-word list of
  Tesseract's Korean model (`kor.traineddata`, Apache-2.0), add-3 smoothed over
  the 2,350 KS syllables, stored as uint8 (−log p / 0.05). Weight λ = 0.6, tuned
  on a separate dev corpus: syllables read correctly were 98.89 % at λ = 0,
  99.12 % at 0.3, 99.20 % at 0.6 and 99.23 % at 1.0. The Tesseract binaries are
  used only to extract this word list. The app does not depend on them.

## Training data (`gen_data.py`)

Glyphs come from Noto Sans CJK KR (Thin … Black, 7 weights), Noto Serif CJK KR
(ExtraLight … Black, 7 weights) and WenQuanYi Zen Hei. Latin letters and digits
are also drawn from FreeSans/FreeSerif. Each glyph is rendered at em = 64 px and
then augmented:

* rotation (σ 1.2°), shear (σ 0.06), x-scale (σ 6 %), elastic warp
* stroke weight (partial dilate / erode)
* line remnants (underline, ledger, extender), specks
* downscaling to em = 10…48 px, blur (σ up to 5.5 % of the em), noise, uneven light
* JPEG q 25–90, binarisation, low contrast
* em-box jitter (±4 % x, ±5 % y, ±8 % size)

Mix: 74 % KS X 1001 syllables, 8 % other syllables (so the jamo heads compose),
9 % symbols, 9 % `NOISE`. The noise samples are:

* left or right halves of syllables (over-segmentation)
* two syllables run together (under-segmentation)
* note heads with stems / ledger lines, beams, slurs and ties, hairpins
* dynamics (`p`, `mf`, `sfz`, `cresc.` …)
* scribbles and specks

Evaluation sets use other seeds: *clean* (black on white, em 22–36 px, no
distortion) and *degraded* (all the photo-like degradations above at em
12–40 px, milder blur and noise than training).

## Results (current model, `train.py` 600 k samples × 10 epochs)

| set | syllables (KS-constrained decode) | symbols | jamo i / m / f |
|---|---|---|---|
| clean (n = 16,984 / 3,016) | **99.99 %** | 99.5 % | 100 / 100 / 100 % |
| degraded (n = 17,026 / 2,974) | **95.7 %** | 96.1 % | 97.5 / 97.4 / 98.2 % |

After int8 quantisation: identical on clean, −0.03 pt on degraded.

**Unseen font design.** A model trained without WenQuanYi Zen Hei (200 k
samples, 6 epochs) and tested only on that font reaches 99.0 % clean and
90.9 % degraded syllable accuracy, and 96.7 % / 82 % on symbols. The full model,
which did see that font, gets 100 % / 96.4 % on it. So expect roughly 99 % and
91 % on print fonts not used in training (Batang, Gulim, Nanum …). Only one
held-out font could be tested; the others installed here are all Noto.

**Synthetic score pages** (`tools/omr/corpus_ko`: 30 clean pages + 60
photo-like variants from `augment.py`, 12,216 syllables, 1–2 verses, Noto Serif
/ Sans KR in several weights and WenQuanYi; full table in
`tools/omr/eval_report_lyrics.md`):

| | detected | read correctly | lyric char accuracy | on the right note¹ | text on the right note | in-score char accuracy² |
|---|---|---|---|---|---|---|
| clean pages | 100.0 % | 99.5 % | 99.4 % | 99.2 % | 95.2 % | 90.4 % |
| photo-like pages | 99.3 % | 96.5 % | 95.9 % | 94.0 % | 72.3 % | 66.7 % |

¹ over syllables whose note was recognised. ² Bounded by the current note
recognition: on these pages it finds 90.8 % of the notes on clean pages and
69.3 % on photo-like ones, and syllables of missed notes stay in
`result.lyrics` without an `eventId`.

The lyric stage adds about 0.2–0.4 s per page in Node on this (shared, slow)
machine, 15–20 % of the total recognition time. Flagging (`lowConfidence`,
confidence < 0.8) marks 78 % of misread syllables on photo-like pages and 38 %
on clean pages, where misreads are rare (0.5 %) and mostly confident. On the
dev set it marks about 2 % of correctly read syllables.
`tools/omr/lyric_regression.mjs` checks that the recognised music is identical
with and without the lyric stage. It also checks that pages with Latin dummy
lyrics (`tools/omr/corpus/base`) get no syllables.

## Retrain / re-evaluate

```bash
python3 tools/omr/hangul/build_prior.py                     # optional: refresh syllable_prior.json (needs tesseract tools)
python3 tools/omr/hangul/gen_data.py --mode train --count 600000 --out /tmp/jse-hangul/train.npz   # ~6 min idle / 12 min loaded
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --prior-weight 0.6   # features + 10 epochs (~8 min) + export + fixtures
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --resume        # if the 560 s time budget stopped it
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --eval-only     # accuracy of the saved model
python3 tools/omr/hangul/train.py --data /tmp/jse-hangul --export-only --prior-weight 0.6   # re-export JS + fixtures
node --test tools/tests/                                    # parity + end-to-end tests

python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 24 --seed 9
python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 6 --start 24 --seed 9 --kinds piano
python3 tools/omr/augment.py --corpus tools/omr/corpus_ko --per-image 2 --seed 7
node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md
node tools/omr/lyric_regression.mjs --dir tools/omr/corpus/base   # music unchanged by the lyric stage
```

Font hold-out experiment:
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
* HANDOFF §4: lyric recognition is implemented. Remaining work: Latin
  (English) lyric lines, which need word grouping and hyphen → syllabic; lyrics
  placed above the staff; a review UI that highlights `lowConfidence` syllables
  from `result.lyrics`.
