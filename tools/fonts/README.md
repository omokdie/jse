# 글꼴 (text styles) and the downloadable "JSE 글꼴"

Everything about fonts of score texts: where the code is, how the downloadable fonts are built and
published, and what a release has to do (written with the font feature, 2026-11).

## What the user gets

* **악보 → 글꼴…** (phone: ⋯ menu and the 파일·악보 sheet; right-click a title / lyric / chord / text →
  **글꼴 바꾸기…**; inspector button "제목·가사·코드 글꼴"): one row per kind of text — 제목, 부제,
  작곡가·편곡자, 작사가, 가사, 코드, 일반 글자, 빠르기, 리허설 마크, 악기 이름, 마디 번호 — with font family,
  size in pt, 굵게, 기울임. The panel docks beside the score (phone / portrait tablet: bottom sheet), every
  change shows on the score at once, 확인 = one undo step, 취소 puts everything back.
  기본값으로 resets, 새 악보 기본값으로 저장 writes `app.settings.newScore.textStyles`.
* Selecting a title, lyric, chord, tempo, rehearsal mark or text shows a 글꼴 section in the inspector
  ("모든 가사에 적용" …). A free text additionally has **이 글자만** (per-object override).
* Font list: **기본** · **이 기기의 글꼴** · **JSE 글꼴** (7 free fonts, downloaded the first time they are used).

## Data

```js
score.settings.textStyles = {            // optional; every key and field optional
  title: { family, size, bold, italic }, subtitle, composer /* + arranger */, lyricist,
  lyrics, chord, text /* staff / system / expression texts, repeat words, text lines */,
  tempo, rehearsal, partName, measureNumber
}
measure.texts[i].font / event.texts[i].font = { family, size, bold, italic }   // optional override of ONE text
app.settings.newScore.textStyles                                                // same shape; applied to new scores
```

* `family` — one font family name; '' / absent = built-in stack. Validated by `sanitizeFontFamily`
  (letters, digits, space, `. _ + ( ) -` only; anything else = default) because it is written into SVG and CSS.
* `size` — **staff spaces**, so text scales with the staff. UI unit: `pt = sp × staffSpaceMm ÷ 0.3528`
  (`ptToSp` / `spToPt`). 새 악보 기본값으로 저장 converts so that the pt stays the same at the new-score staff size.
* `bold` / `italic` — absent = built-in (title, chords, tempo words, rehearsal marks bold). For `text`,
  `true` = every free text, `false` / absent = automatic (expression italic, technique / system bold);
  a single text is forced either way with its own `font`.
* Absent `textStyles` ⇒ the engraver output is byte-identical to v1.0.8
  (`node engrave-diff.mjs` over 42 real scores: `identical 42 different 0`; `tools/tests/textstyles.test.js`
  checks "explicit defaults == nothing" on the fixtures).
* The older `settings.fonts { text, lyrics }` (set by the Finale / MusicXML importers) is still ignored by
  the engraver, as before.

## Code map

| File | Role |
|---|---|
| `app/js/model/textstyles.js` | keys, defaults, `resolveTextStyle`, `resolveTextObjectStyle`, `normalizeTextStyles`, `applyTextStyles`, `ptToSp` / `spToPt`, `sanitizeFontFamily`, `fontNeeds(score)` |
| `app/js/engrave/styles.js` | per-engrave view of the styles (`k = size ÷ default`, CSS rules, scope class) |
| `app/js/engrave/layout.js`, `render.js`, `notes.js`, `text.js` | measuring + drawing with the resolved style; `clearTextWidthCache()` |
| `app/js/fonts.js` | catalogue (`JSE_FONTS` = `app/fonts/web/manifest.json`), device font detection, download + IndexedDB (`jse-fonts`) + `FontFace`, `fontSourceUrls`, `embedFontsInSvg` |
| `app/js/config.js` | `PAGES_BASE_URL` (rewritten by `tools/set-github-owner.mjs`) |
| `app/js/ui/textstyle.js`, `app/css/textstyle.css` | dialog, font picker, inspector section, `initScoreFonts(app, ui)` |
| `app/js/io/export.js` | embeds the downloaded fonts into PNG / JPG / PDF pages, exported SVG and the print window |
| `app/js/io/musicxml.js` | `<lyric-font>`, `<word-font>`, credit fonts, `miscellaneous-field name="jse-text-styles"` |

How the engraver applies a style: the **size, bold, italic** are attributes of each `<text>`; the
**family** of a kind of text is one CSS rule in the page `<style>` (`.score-page.ts-<hash> text.lyric{font-family:'X',<default stack>}`)
— the extra class `ts-<hash>` on the `<svg>` scopes the rules, so two differently styled scores can sit in
one document (previews, thumbnails); a per-object family is an inline `style`. Nothing of this is written
when the score has no styles.

## JSE 글꼴 (app/fonts/web)

| Family (CSS name) | 한글 이름 | Kind | Files | Size (WOFF) | Licence |
|---|---|---|---|---|---|
| Nanum Myeongjo | 나눔명조 | Korean serif | Regular, Bold | 1.03 + 1.11 MB | SIL OFL 1.1 |
| Gowun Batang | 고운바탕 | Korean serif | Regular, Bold | 1.81 + 1.59 MB | SIL OFL 1.1 |
| Nanum Gothic | 나눔고딕 | Korean sans | Regular, Bold | 0.69 + 0.78 MB | SIL OFL 1.1 |
| Gowun Dodum | 고운돋움 | Korean sans | Regular | 1.43 MB | SIL OFL 1.1 |
| Nanum Pen Script | 나눔손글씨 펜 | Korean handwriting | Regular | 1.29 MB | SIL OFL 1.1 |
| Old Standard TT | 올드 스탠더드 | Latin serif (classic engraving look) | Regular, Bold | 0.10 + 0.10 MB | SIL OFL 1.1 |
| Libertinus Serif | 리베르티누스 세리프 | Latin serif (Times-like) | Regular, Bold | 0.30 + 0.25 MB | SIL OFL 1.1 |

12 files, 9.98 MB. Source: `github.com/google/fonts` @ `7af0d90b4d532ffa4b041937b560c6df4e7b1e95`
(`ofl/<family>/`). Each family folder holds its `OFL.txt`; `manifest.json` lists family, Korean name,
category, files per weight, byte sizes, SHA-256 of the WOFF and of the original TTF, copyright and version.

**The fonts are unmodified.** Several have Reserved Font Names (Nanum, NanumGothic, NanumMyeongjo, NanumPen …),
so they must not be subset, renamed, re-hinted or converted lossily. `build-webfonts.py` only wraps the
original TrueType file into a WOFF 1.0 container (per-table zlib, no metadata block) — OFL-FAQ 2.2 does not
count that as a Modified Version — and proves it for every file: the WOFF is decoded again and must equal
the original file bit for bit, and fontTools must read identical raw tables from both.
The same reason is why an exported SVG embeds the **whole** font (a few MB per page): no subsetting.

Rebuild / add a font:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/google/fonts.git gf
(cd gf && git sparse-checkout set ofl/nanummyeongjo ofl/gowunbatang ofl/nanumgothic ofl/gowundodum ofl/nanumpenscript ofl/oldstandardtt ofl/libertinusserif)
python3 -I tools/fonts/build-webfonts.py --src gf/ofl --source-commit "$(git -C gf rev-parse HEAD)"
# → app/fonts/web/**, prints the catalogue: paste it into JSE_FONTS in app/js/fonts.js
node --test tools/tests/textstyles.test.js      # fails when fonts.js and manifest.json differ
```

Keep published file names stable: installed apps of older versions fetch `fonts/web/<file>` from the web
site. To change a font, add a new file name rather than replacing a file in place.

## On demand, not bundled

`app/fonts/web/` is served by the web site only:

| Target | How it is kept out |
|---|---|
| Windows package | `electron/package.json` → `build.extraResources[0].filter`: `"!fonts/web/**"` |
| Android web bundle | `mobile/scripts/sync-www.mjs`: the copy skips `fonts/web` unless `--pages` |
| OTA bundle `web-<ver>.zip` | `.github/workflows/build-web.yml`: `zip … -x '.nojekyll' 'fonts/web/*'` |
| Service-worker precache | `sync-www.mjs` `finalizeWebTree`: `asset-list.json` leaves `fonts/web/` out; `app/sw.js` does not handle `/fonts/web/` requests at all |
| claude.ai preview build | `tools/build-demo.mjs` filter |

At run time `fontSourceUrls(file)` gives the places to try: the app's own origin when it is a web page
served over http(s) (web / PWA), then `PAGES_BASE_URL + 'fonts/web/' + file`
(`https://omokdie.github.io/jse/fonts/web/…`); inside a native shell (Windows `app://`, Android
`https://localhost`) only the latter. The bytes go to IndexedDB (`jse-fonts` / `files`) and are registered
with `new FontFace(family, bytes, { weight })`; then the text-width cache is cleared and the score laid out
again. Opening a score that names a JSE font loads it automatically; offline and not yet stored ⇒ default
font and one toast (retried when the device is online again).

## Known limits

* PDF / PNG / JPG stay raster (as before); an exported **SVG** with a JSE font carries the whole font
  (≈ 1–2 MB per family and weight, base64) in every page file.
* Bold / italic of a font without that cut (Gowun Dodum, Nanum Pen Script; no italics at all) are
  synthesised by the browser.
* Fonts of the device are used by name: a score opened on another device where the font is missing falls
  back to the default stack (the dialog marks it "이 기기에 없음"). JSE 글꼴 look the same everywhere.
* `queryLocalFonts()` (full list of installed fonts) exists in desktop Chromium / Electron only; elsewhere
  the list is the curated candidates that pass the measuring test.
* The running title on pages 2+ and volta numbers keep the default font.
* MusicXML carries lyric / word / credit fonts for other programs; chord, tempo, rehearsal, part-name and
  measure-number styles travel only in JSE's own `jse-text-styles` field.

## For SPEC / HANDOFF

SPEC §1 (layout): add `js/model/textstyles.js`, `js/engrave/styles.js`, `js/fonts.js`, `js/config.js`,
`js/ui/textstyle.js`, `css/textstyle.css`, `fonts/web/` (on-demand fonts + `manifest.json`), `tools/fonts/`.

SPEC §2 (ScoreDoc): in `settings` add
`textStyles?: { title|subtitle|composer|lyricist|lyrics|chord|text|tempo|rehearsal|partName|measureNumber: { family?, size? /* staff spaces */, bold?, italic? } }`;
in `Measure.texts[]` and `Event.texts[]` add `font?: { family?, size?, bold?, italic? }`.
Geometry: `texts[]` now also has `field: 'subtitle' | 'composer' | 'arranger' | 'lyricist'` boxes and
`index` on `mtext` / `text` records.

SPEC §3 (engraver): text styles as described under "Code map"; no `textStyles` ⇒ output unchanged.

SPEC §7 / RELEASING: GitHub Pages must publish `fonts/web/` (it does: `sync-www.mjs --pages` copies it);
the OTA zip, the APK and the Windows installer must not contain it (see the table above).

HANDOFF §1: new row — "가사·제목·코드의 글꼴 크기와 종류 변경" ✅ (악보 → 글꼴…, 속성 패널, 글자 오른쪽 클릭).
HANDOFF §3: tests 27 → includes `tools/tests/textstyles.test.js` (20 tests: model, engraver, catalogue,
MusicXML, packaging).

## Browser checks

`tools/fonts/e2e/*.js` are Playwright snippets for `tools/e2e/shot.mjs` (serve `app/` on :8765 first):
`dialog.js` (cancel / 확인 / undo / reset / new-score default), `cache-offline.js` (IndexedDB reuse, offline
fallback and its single toast), `export.js` (PNG · JPG · PDF · SVG with embedded fonts → `tools/out/fonts-export.*`),
`inspector.js` (inspector section, 이 글자만, context menu).
