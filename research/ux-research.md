# JSE UX Research: notation editors, touch input, OMR correction

Scope: desktop (Electron), PWA, Android (touch); Korean beginners/hobbyists. Researched 2026-11-03 (vendor docs, Scoring Notes, forums, app reviews).

## 1. Desktop notation editors: what to copy

**Landscape.** MuseScore Studio 4 is the hobbyist default; Dorico and Sibelius are the pro pair. Finale was discontinued on 26 Aug 2024 (development and sales ended, $149 Dorico crossgrade); model nothing on it. Flat.io and Noteflight are the browser references for the PWA.

**Note-input paradigms.**
- *MuseScore*: `N` toggles input; pick a duration (`1`–`9`, `5` = quarter), then a pitch by letter `A`–`G`, mouse click (ghost-note preview), on-screen piano (`P`) or MIDI. `0` rest, arrows semitone, `Shift+letter` chord tone, `T` tie. "Duration first, then pitch" is the model.
- *Sibelius*: six numeric-keypad layouts (`F7`–`F12`): `1`–`6` durations (`4` = quarter), `7/8/9` accidentals, `0` rest, `Enter` tie. Fast for experts, useless without a numpad.
- *Dorico*: durations `1`–`9` (`6` = quarter); `Shift+N`/`Enter` starts input; popovers (`Shift+K` key, `Shift+M` meter, `Shift+D` dynamics, `Shift+L` lyrics, `Shift+Q` chords) accept typed text like `3/4` or `Am7`. Poorly discoverable, efficient, touch-friendly.
- *Flat/Noteflight*: toolbar duration buttons plus letter keys; click the staff; Flat tells users to "press play" to catch mistakes.

Opinion: ship MuseScore's map (`5` = quarter; Dorico `6`, Sibelius `4`), others as presets.

**Palettes vs properties.** MuseScore: left Palettes ("add something") plus a Properties panel ("tweak the selected thing"), with palette search. Dorico splits panels by mode; Sibelius uses a ribbon plus Inspector. Copy MuseScore's split with a curated beginner palette.

**Selection and editing.** All three distinguish *list selection* (click, `Ctrl+click`; styling) from *range selection* (`Shift+click`/`Shift+arrows`, a time-by-staves rectangle; copy, transpose, delete). `Ctrl+C` a range, click a destination, `Ctrl+V` overwrites from there (no insert). `R` repeats the selection after itself in all three. Undo is unlimited; Dorico also shows a history list.

**Onboarding.** Nobody ships a true simple mode: MuseScore has a new-score wizard then the full UI, Flat an interactive tutorial, Dorico SE/Sibelius First tier features, not UI. MuseScore forum threads ("User unfriendly", "Difficult to Use", "confusing for beginners") repeat one pain: a lead sheet feels "quite challenging", the program is "full of features I don't need", the handbook overwhelms, letters do nothing outside `N` mode, rests cannot be deleted because bars are always full. Power users complain about shortcut hunting.

**Consensus shortcuts** (MS MuseScore, Sib Sibelius, Dor Dorico):

|Action|Key|Notes|
|---|---|---|
|Toggle note input|`N`|MS, Sib; Dor `Shift+N`|
|Pitch|`A`–`G`|all|
|Durations|`1`–`9`|quarter: MS 5, Dor 6, Sib 4|
|Rest|`0`|MS, Sib; Dor `,`|
|Dot|`.`|all|
|Tie|`T`|MS, Dor; Sib `Enter`|
|Slur|`S`|all|
|Sharp/flat/natural|`+` `-` `=`|MS; Dor `=` `-` `0`; Sib 8/9/7|
|Semitone|`↑` `↓`|MS, Sib; Dor `Shift+Alt+↑↓`|
|Octave|`Ctrl+↑↓`|MS, Sib; Dor `Ctrl+Alt+↑↓`|
|Chord tone / interval|`Shift+A–G`, `Alt+1–9`|MS; Sib plain `1–9`|
|Repeat selection|`R`|all|
|Triplet|`Ctrl+3`|MS, Sib; Dor `;` popover|
|Voice 1–4|`Ctrl+Alt+1–4`|MS; Sib `Alt+1–4`; Dor `V`|
|Flip stem|`X`|MS, Sib; Dor `F`|
|Chord symbol|`Ctrl+K`|MS, Sib; Dor `Shift+Q`|
|Lyrics|`Ctrl+L`|MS, Sib; Dor `Shift+L`|
|Staff text|`Ctrl+T`|MS, Sib; Dor `Shift+X`|
|Append measure|`Ctrl+B`|MS, Sib; Dor `Shift+B`|
|Play/stop|`Space`|MS, Flat, Noteflight; Sib/Dor `P`|
|Extend range|`Shift+←→`, `Shift+click`|all|
|Copy/cut/paste|`Ctrl+C/X/V`|all|
|Undo/redo|`Ctrl+Z` / `Ctrl+Shift+Z`|accept `Ctrl+Y` too|
|Delete to rest|`Delete`|all|
|Zoom / fit|`Ctrl+=` `Ctrl+-` / `Ctrl+0`|all|

## 2. Mobile notation apps: how touch input works

- **MuseScore mobile**: a viewer/player for musescore.com, no editing; the dominant brand has no touch editor.
- **Flat (iOS/Android)**: pick a duration, tap the staff line/space; tap a note to change or delete. Official advice: zoom in first, use landscape, verify by playback; small targets are the implicit weakness.
- **Dorico for iPad**: desktop layout kept; duration buttons left; bottom panel with piano, fretboard and drum pads for pitch; double-tap starts entry; a right-side palette opens popovers with the soft keyboard. No Pencil handwriting. Praised for keyboard-free entry; Read mode is "rudimentary".
- **Symphony Pro 5**: MyScript handwriting per measure (Pencil), fingers for pan/pinch; a hidden two-finger tap is the only route to the meter/key dialog. Also criticized: buggy lasso, intrusive over-filled-bar warning.
- **StaffPad**: pen-first handwriting recognized on pen-lift; superb with a stylus, useless for fingers.
- **Komp (iPad)**: symbol-by-symbol handwriting, a movable radial menu for durations/rests/accidentals, tap-and-drag re-pitches; stray dots, misfires, subscription.
- **Notation Pad (iOS/Android, 4.3 stars)**: tap-to-place with a movable toolbar; praised as beginner-friendly; complaints: ads after nearly every action, tiny overlapped chord symbols, hidden double bar line.
- **Notion Mobile, Score Creator, Maestro, Music Writer, Crescendo**: toolbar duration plus tap-to-place; Notion and Score Creator add a piano strip; complaints: tiny targets, IAP walls, hard duration changes.

Patterns: duration-first is universal; pitch is disambiguated by zoom (Flat) or a piano strip (Dorico, Notion); handwriting needs a stylus; hidden gestures and modal warnings get punished.

**Recommended JSE touch input.**
1. Bottom duration bar in the thumb zone: durations, dot, rest, tie, accidentals; swipe for articulations/dynamics.
2. Tap-to-place with a ghost note above the fingertip; vertical drag re-pitches with a haptic tick per step; release commits; horizontal drag is ignored.
3. Tap a note for a floating mini-toolbar (duration, accidental, delete, voice); long-press for the full menu; range selection via drag handles.
4. Optional piano strip above the bar for staff-free entry.
5. Input mode auto-zooms the staff; pinch and two-finger pan.
6. Undo/redo always visible; no gesture is the only way to do anything.
7. No modal "measure full" dialogs; inline red badge with one-tap fixes.

## 3. OMR / scanning apps: correction workflow

- **PlayScore 2**: camera/PDF to playback; no editing, only a mask to hide misreads; MusicXML export is subscription-only. Ties read as slurs, lyrics as trills.
- **ScanScore**: original left, result right (or stacked). Purple dashed line = short measure, blue = too many beats, with voice number. Palette-only editing, no shortcuts; cannot add or remove dots or bars.
- **PhotoScore Ultimate**: original above, result below; Sibelius keypad editing, Find & Replace; text shows staff-attachment lines. Misses whole-note ties, tremolos.
- **SmartScore 64**: original above, result below; richest editor including crop/deskew; steep learning curve. Tips: page square and fully framed, spines pressed flat, no handwriting.
- **Audiveris** (open source; an older build powers MuseScore's cloud "Import PDF"): overlays recognized symbols on the image and flags measures whose rhythm does not add up. MuseScore users report "quite a few errors" per page and wrong-length bars where notes spill over and rests cannot be deleted; fixes are Measure Properties or local Audiveris 5.3+.
- **Flat OMR / Opuscan**: one credit per page; Opuscan marks uncertain notes "in pink for tap-to-fix"; system breaks match the original. Tips: sharp high-resolution images, avoid spines, shadows, skew; one piece per file; no handwriting.
- **Newzik**: flat surface, dark background for edge detection, phone upright and close, flash if dim, fixed support for consistent framing, manual shutter, corner adjustment.
- **Sheet Music Scanner, Halbestunde**: playback only.

Universal complaints: ties vs slurs, rhythms that break bar lengths, lost lyrics/chords/multi-bar rests.

**Recommended review mode.**
- *Capture*: live edge-detection frame, level and light/glare hints, auto-shutter when stable, dark-background tip, draggable-corner crop, batch pages, image-quality score before processing.
- *Review*: synchronized panes (photo top on phone, left on desktop) with an overlay toggle; tapping a bar in either pane highlights its twin. Red badge = rhythm does not add up (quick fixes: make dotted, split, set actual duration); amber = low-confidence symbol with tap-to-cycle alternatives (tie/slur, dot, accidental). Spellcheck-style "next issue" with a counter; playback cursor over the photo.
- Never gate editing behind correction: open the editor any time; the photo stays as a toggleable layer.

## 4. Multi-page / canvas viewing

MuseScore offers Page, Continuous (one endless system) and Single-page views; Dorico has Page and Galley (all staves, no layout, remembered per tab); Sibelius calls it Panorama. Illustrator/Affinity artboards add a thumbnail navigator and `Ctrl+0` fit / `Ctrl+1` 100%. Beginners are confused when spacing differs between views; label modes by purpose.

Recommendations: desktop default = vertical Page stack at fit-width, "Editing view" (continuous) one toggle away, page thumbnails in a left rail. Mobile default = **Reflow**: systems re-wrapped to screen width (as Flat does), Page view only as pre-export preview, a page scrubber. Never auto-scroll more than one system during input.

## 5. Drums, chord symbols and diagrams, lyrics

- **Drums**: MuseScore 4 shows a bottom percussion panel when a drum staff is selected: pads with letter shortcuts (first row `A`–`H`), click to write, preview button, kit customization. The 90% kit: 8 pads (kick, snare, closed/open hi-hat, ride, crash, high tom, floor tom), durations from the shared bar, automatic hands-up/feet-down voicing, `R` to repeat a bar.
- **Chord symbols**: `Ctrl+K`, type `G7` or `F#m7b5` (`#`/`b` typed plainly), `Space` next note/beat, `Shift+Space` back, `;`/`:` by beat, `Ctrl+→` next bar, `Esc`. MuseScore auto-generates guitar diagrams for common chords. For hobbyists: autocomplete chips, a diatonic palette (I ii iii IV V vi) for the current key, an "auto diagrams" toggle, and on touch a chord keyboard (root/quality/bass rows).
- **Lyrics**: `Ctrl+L`, `Space` next syllable, `-` continues a word, `_` melisma, `Enter`/`↓` next verse, `Ctrl+Space` literal space. Korean specifics: Hangul lyrics map one syllable block per note without hyphens, so "paste a line, distribute one syllable per note, keep word spaces" covers most needs (MuseScore lacks it). Hangul IME composition means `Space`/`-` must be handled after `compositionend`; test Gboard and Samsung Keyboard.

## 6. Design implications for JSE (prioritized)

1. Duration-first input, MuseScore key map (`5` = quarter), `N` toggle, `A`–`G` pitches; other maps as presets.
2. Undo/redo always visible, unlimited; history list on desktop.
3. One selection model: tap = element, handles/`Shift` = range, visible range box, contextual toolbar.
4. Paste overwrites at selection, `R` repeats, `Ctrl+B` appends, `Delete` leaves rests.
5. Curated beginner palette plus palette search; rest behind "More…".
6. Popover-style typed entry (key, time, tempo, chord, lyric) with autocomplete.
7. Mobile: bottom duration bar, tap-with-ghost, vertical drag to re-pitch, optional piano strip.
8. Long-press context menus; gestures only accelerate.
9. No modal warnings; inline measure badges with one-tap fixes.
10. OMR review: synced panes, overlay toggle, red/amber badges, next-issue navigation, alternative cycling.
11. Capture guidance: edge frame, level/light/glare hints, auto-shutter, corner adjust, quality score.
12. Views: Page (desktop default), Continuous (editing), Reflow (mobile default).
13. Drum-pad panel with `A`–`H` keys and an 8-pad default kit.
14. Chord entry with autocomplete, `Space` to advance, diatonic palette, touch chord keyboard, optional diagrams.
15. Lyrics with `Space`/`-`/`_` plus Korean paste-and-distribute; IME-safe keys.
16. Playback cursor synced to score and photo; `Space` plays.
17. Three-step wizard with hobbyist templates: lead sheet, piano, guitar+TAB, drum kit, SATB.
18. Shortcut cheat-sheet overlay (`?`) and one tip per session, no tour.
19. MusicXML core; export MusicXML/PDF/MIDI/MP3 from day one.
20. Korean-first terminology, 48 dp targets, high-contrast selection.

## Sources

- https://handbook.musescore.org/basics/entering-notes-and-rests
- https://handbook.musescore.org/text/chord-symbols
- https://handbook.musescore.org/text/lyrics.md
- https://handbook.musescore.org/de/idiomatic-notation/percussion/inputting-percussion-notation
- https://musescore.org/en/node/280823, https://musescore.org/en/node/260711, https://musescore.org/en/comment/833643 (beginner complaints)
- https://musescore.org/en/node/336965
- https://musescore.org/en/node/251536
- https://musescore.org/en/node/372490
- https://musescore.org/en/node/355168
- https://steinberg.help/dorico/v4/en/dorico/topics/user_interface/user_interface_view_types_r.html
- https://www.scoringnotes.com/news/makemusic-ends-development-and-availability-of-finale/
- https://www.scoringnotes.com/reviews/dorico-arrives-on-ipad/
- https://www.scoringnotes.com/reviews/symphony-pro-5-takes-several-steps-toward-mobile-notation-future/
- https://www.scoringnotes.com/reviews/komp-beautiful-ambitious-new-scoring-app-ipad/
- https://www.scoringnotes.com/reviews/staffpad-for-ipad/
- https://www.scoringnotes.com/reviews/a-review-of-optical-music-recognition-software/
- https://apps.apple.com/us/app/notation-pad-sheet-music-composer-composition/id1091921942
- https://apps.apple.com/app/musescore-sheet-music/id835731296
- https://blog.flat.io/how-to-write-sheet-music-on-your-phone/
- https://blog.flat.io/best-sheet-music-scanner-apps-android/
- https://help.flat.io/en/music-notation-software/omr/
- https://en.blog.newzik.com/blog/numerisation-partition
- https://www.musitek.com/smartscore-online-help/piano/scanning_music/scanning_tips.php?os=win
- https://github.com/Audiveris/audiveris/wiki/Techniques
