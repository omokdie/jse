# Settings (설정)

One registry describes every option of the app; one window shows it in the shape that fits the device.

| File | Role |
| --- | --- |
| `app/js/settings.js` | Registry (`SECTIONS`, `ITEMS`), platform filtering, search, defaults / migration, export / import, `SettingsManager` (`app.prefs`) and the hooks that apply a value. Pure at import time, so Node can test it. |
| `app/js/ui/settings.js` | The settings window: `openSettings(app, ui, sectionId?)`, `closeSettings()`, `settingsOpen()`, `bindNativeBack(app, ui)` (Android back key). |
| `app/css/settings.css` | Part 1: appearance options (accent, reduced glass, paper colour, hint bar, interface size). Part 2: the window in its desktop / tablet / phone shapes. Linked after `app.css`. |
| `electron/winstate.js` | Pure helpers of the desktop shell: window bounds restore, validation of the options the shell keeps (`settings.json` → `app`), zoom factor. |
| `tools/tests/settings.test.js`, `electron-shell.test.js`, `android-shim.test.js` | Node tests (no browser, no Electron, no Android). |
| `tools/settings/check-*.js`, `gallery.js`, `init-*.js` | Browser checks and screenshots, run through `tools/e2e/shot.mjs`. |

## How it works

- `app.settings` is still a plain object in `localStorage['ssnap.settings']`; `app.saveSettings()` still writes it.
  `App.loadSettings()` passes whatever is stored through `migrate()`: every key gets a valid value, old keys keep their meaning, unknown keys are carried along.
- `app.prefs.set(id, value)` (or `app.setSetting(id, value)`) validates → stores → saves → runs the item's `apply` hook → `app.emit('settings', { id, value })`.
  After a reset or an import the event has `id: null`.
- An item: `{ id, section, group?, type: toggle|select|slider|color|action|info, label, en?, desc?, default, options?, min/max/step?, keywords, platforms?, layouts?, touch?, mouse?, when?(ctx), apply?(env, value), status?(env), actions? }`.
  `id` is the key path in `app.settings` (`newScore.pageSize` → `app.settings.newScore.pageSize`).
- Visibility is decided per device by `makeContext()`: `shell` (web | electron | android), `layout` (desktop | tablet | phone), `touch`, `ctx.has(method)` (does the native shell implement it?) and browser `features`. An option whose native method is missing is hidden instead of doing nothing.
- The window: desktop = category list + cards, search (`Ctrl+F` or `/`), `Ctrl+,` opens and closes; tablet = the same two panes with targets ≥ 44 px; phone = full-screen list → page with a back arrow, choices as bottom sheets. One level back per Back press (browser history / Android back key).

### Adding an option

1. Add an item to `RAW_ITEMS` in `app/js/settings.js` (give it `keywords` so search finds it; restrict it with `platforms` / `layouts` / `touch` / `when`).
2. Read `app.settings.<key>` where the behaviour lives, or give the item an `apply(env, value)` hook when something must change at once. `env.boot` is true during start-up.
3. Add it to the expected lists in `tools/tests/settings.test.js` (platform filtering) and to a `check-*.js` script that proves it works.

## Running the checks

```sh
node --test tools/tests/*.test.js                      # settings 12, electron-shell 7, android-shim 4 (+ everyone else's)
python3 -m http.server 8765 -d app &                   # then, with INIT=/tmp/init-welcomed.js (localStorage ssnap.welcomed = 1):
S="node tools/e2e/shot.mjs http://localhost:8765/"
INIT=/tmp/init-welcomed.js $S tools/out/st-desktop-check.png  desktop tools/settings/check-desktop.js      # 49 checks
INIT=/tmp/init-welcomed.js $S tools/out/st-desktop-check2.png desktop tools/settings/check-desktop-2.js    # 52
INIT=/tmp/init-welcomed.js $S tools/out/st-phone-check.png    mobile  tools/settings/check-phone.js        # 47
INIT=/tmp/init-welcomed.js $S tools/out/st-tablet-check.png   tablet  tools/settings/check-tablet.js       # 12 (also tablet-portrait, android-tablet)
INIT=/tmp/init-welcomed.js $S tools/out/st-scale.png          desktop tools/settings/check-scale.js        # 40 (also tablet, tablet-portrait, android-tablet; mobile: 3)
INIT=tools/settings/init-android.js  $S tools/out/st-android-check.png mobile  tools/settings/check-android-shell.js   # 29, fake Android shell
INIT=tools/settings/init-electron.js $S tools/out/st-windows-check.png desktop tools/settings/check-windows-shell.js   # 33, fake Windows shell
TAG=desktop INIT=/tmp/init-welcomed.js $S tools/out/settings-desktop.png desktop tools/settings/gallery.js # every section → tools/out/settings-<TAG>-<section>.png
```

Each script prints `… N passed, 0 failed`; `shot.mjs` adds `no console errors`. `init-android.js` / `init-electron.js` define a `window.ScoreSnapNative` that records every native call, so the scripts can assert what the web side asks of the shell.

---

## For SPEC/HANDOFF

### Entry points

`ui.settings(sectionId?)` everywhere (`D.settingsDialog` is gone): 도움말 › 설정… (`Ctrl+,`), the gear button, the phone ⋯ menu, the `settings` action (`ui.action('settings', { section })`, also what the Electron menu sends). Section ids: `general display editing newScore playback recognition files update windows android web device advanced`.

### Stored keys (`localStorage['ssnap.settings']`, `_v: 2`)

| Key | Values (default first) | Shown on | What it does / where it is read |
| --- | --- | --- | --- |
| `lang` | `ko`, `en` | all | UI language (`i18n.setLang`, `ui.rebuild`) |
| `startup` | `resume`, `welcome`, `new` | all | `main.js` boot: reopen the draft / welcome screen / empty score (the draft is then offered in a toast) |
| `tips` | `true` | all | 간단 모드: short palette + start guide (existing key, unchanged meaning) |
| `hints` | `true` | all | Hint bar under the toolbar. New in v2; migrated from `tips` when absent |
| `theme` | `auto`, `light`, `dark` | all | `ui.applyTheme` |
| `accent` | `#0a84ff` + 8 presets or any `#rrggbb` | all | `--jse-accent` + `:root[data-accent]` |
| `uiScale` | `100` (85–150, step 5) | Windows; desktop / tablet layouts elsewhere (web, Android tablets) | Windows: `setZoomFactor` (real page zoom). Browsers: CSS zoom of the app chrome, capped by `maxUiScale(layout, width)` so the layout keeps its minimum width (tablet 600 px, desktop 880 px); the row says so when the cap applies. Not on the phone layout |
| `reduceGlass` | `false` | all | `:root.jse-reduce-glass` (no backdrop blur, opaque panels) |
| `paperColor` | `white`, `ivory`, `cream`, `gray`, `green` | all | Screen only (`:root[data-paper]`); exports stay white |
| `defaultView` | `last`, `single`, `vertical`, `horizontal`, `grid`, `reflow` | desktop, tablet | Page view at start-up (`main.js`) |
| `defaultZoom` | `width`, `page`, `100`, `125`, `150` | desktop, tablet | `ui.fitDefault()` after opening / creating a score |
| `panelLeft`, `panelRight` | `auto`, `show`, `hide` | desktop, tablet | Palette / properties panel at start-up |
| `startTool` | `select`, `entry` | all | Tool after boot (`app.prefs.afterBoot`) |
| `entryGhost` | `true` | desktop, tablet | Hover preview note (`pointer.js`) |
| `inputSound` | `true` | all | Sound when a note is entered or its pitch chosen (`synth.preview`, `SettingsManager.bindEntrySound`) |
| `wheelMode` | `scroll`, `zoom` | desktop, tablet | Mouse wheel: scroll (Ctrl+wheel zooms) or zoom (Shift+wheel scrolls) |
| `touchSlideInput` | `true` | touch | Press-and-slide entry; off = a tap enters the note where it lands |
| `longPressMs` | `550` (300–1000, step 50) | touch | Long-press time on the score (`pointer.js`) |
| `haptics` | `true` | touch with a vibrator | `app.haptic(ms)`: native `vibrate` on Android, else `navigator.vibrate` |
| `penOnly` | `false` | touch | Fingers only pan / zoom, the pen edits; palm contact is ignored while the pen is down |
| `newScore.pageSize` | `A4`, `Letter`, `A3`, `B5`, `A5`, `Legal` | all | Copied into every new score by `app.applyNewScoreDefaults(score)` — `App.newScore`, photo recognition ("new"), audio recognition ("new") |
| `newScore.orientation` | `portrait`, `landscape` | all | 〃 |
| `newScore.marginsMm` | `{ top, bottom, left, right }`, 15 each (slider 5–30 sets all four) | all | 〃 (four different sides from an imported file are kept) |
| `newScore.staffSpaceMm` | `1.75` (1.2–2.6, step 0.05) | all | 〃 |
| `newScore.measureNumbers` | `system`, `all`, `none` | all | 〃 |
| `newScore.textStyles` | absent (written by the 글꼴… dialog, `ui.textStyles()`) | all, when `ui.textStyles` exists | 〃, passed through `normalizeTextStyles`; same shape as `score.settings.textStyles` |
| `metronome` | `false` | all | `player.metronome` (the toolbar button now stores it too) |
| `countIn` | `0`, `1`, `2` measures | all | `player.countIn` (`synth.scheduleCountIn`) |
| `volume` | `80` (0–100) | all | `player.setVolume` |
| `playbackSpeed` | `100` (50–150) | all | `player.tempoScale` |
| `followPlayback` | `true` | all | Auto-scroll during playback (`ui.js`) |
| `omrParts` | `auto`, `1`, `2` | all | Initial choice in the photo dialog |
| `omrLyrics` | `true` | all | Photo recognition reads lyrics |
| `audioMode`, `audioTriplets`, `audioChords` | `auto` / `false` / `true` | all | Initial choices in the audio dialog |
| `autosave` | `true` | all | Draft autosave (existing key) |
| `autosaveDelay` | `1.2`, `5`, `15`, `30`, `60` s | all | `ui.scheduleAutosave` |
| `saveSourcePhotos` | `true` | all | `.ssnap` keeps the source photos (`ui.scoreForFile`) |
| `exportFormat` | `pdf`, `png`, `jpg`, `svg`, `musicxml`, `musescore`, `nwc`, `sibelius`, `finale`, `midi`, `ssnap` | all | **Read by `exportdlg.js`**: format selected when the export dialog opens |
| `exportDpi` | `300`, `150`, `600` | all | **Read by `exportdlg.js`**: default resolution |
| `autoUpdate` | `true` | all (not the claude.ai preview) | `ui.updater.setAuto` (existing key) |
| `winRememberBounds` | `true` | Windows | Mirrored to the shell (`app.rememberBounds`) |
| `winStartMaximized` | `false` | Windows | `app.startMaximized` |
| `winCloseConfirm` | `auto`, `always`, `never` | Windows | `ui.confirmLeave()`: `auto` asks only when autosave is off (the behaviour before), `always` whenever there are unsaved changes |
| `winDisableGpu` | `false` | Windows | `app.disableGpu`, applied at the next start ("지금 다시 시작" in the toast) |
| `winDefaultDir` | `''` | Windows | `app.defaultDir`: first folder of the open / save dialogs; empty = last used |
| `keepScreenOn` | `false` | Windows, Android, web (Wake Lock) | See below |
| `immersive` | `false` | Android | Hides status + navigation bars |
| `orientation` | `auto`, `portrait`, `landscape` | Android | Locks the rotation |
| `backAction` | `twice`, `exit`, `none` | Android | Back key when nothing is open |
| `keymap`, `mobileDurationBar`, `viewMode`, `lastPageView` | — | not shown | Existing app state in the same object; untouched (a full reset keeps `viewMode` / `lastPageView`) |

Rows without a stored value: 시작 안내 다시 보기, 최근 파일 지우기, 글꼴…, 현재 버전, 업데이트 확인, 변경 내용, 파일 연결, 설정 파일 위치, 앱 다시 시작, 앱으로 설치, 저장 공간, 오프라인 캐시, the "이 기기" page (platform, versions, screen, storage, engine, 진단 정보 복사), 설정 내보내기 / 가져오기 (`jse-settings.json`, `{ format: 'jse-settings', version, settings }`), 모든 설정 초기화.

### Platform options

**Windows app (Electron)** — section `windows`. The renderer keeps the values; a copy goes to the shell's own `settings.json` (key `app`) because the shell needs them before a page exists.

| Option | Shell side |
| --- | --- |
| 창 크기·위치 기억 / 시작할 때 최대화 | `initialBounds()` restores the saved bounds when they are still on a connected display (`winstate.restoreBounds`); bounds are saved (debounced) on resize / move / close; turning it off forgets them |
| 닫을 때 저장 확인 | Close guard: the window's `close` event is held, the renderer is asked (`scoresnap:close-request`), it answers through `ui.requestClose()`. If the page does not acknowledge within 2.5 s the window closes anyway; `before-quit`, a reload and `relaunch` bypass or reset the guard |
| 하드웨어 가속 끄기 | `app.disableHardwareAcceleration()` before `ready`; needs a restart |
| 앱 다시 시작 | `app.relaunch(); app.quit()` after `confirmLeave()` |
| 화면 켜짐 유지 | `powerSaveBlocker.start('prevent-display-sleep')` |
| 열기·저장 기본 폴더 | Folder picker; `dialogDir()` feeds `defaultPath` of the open / save dialogs |
| 파일 연결 | Opens `ms-settings:defaultapps` (Windows only) |
| 설정 파일 위치 | `shell.showItemInFolder(settings.json)` |
| 화면 요소 크기 | `webContents.setZoomFactor` (0.5–2) |

New IPC channels (`electron/main.js`) and their `window.ScoreSnapNative` methods (`electron/preload.js`):
`scoresnap:app-settings-get` / `-set` → `getAppSettings()` / `setAppSettings(partial)`, `choose-folder` → `chooseFolder({ defaultPath })`, `open-system-settings` → `openSystemSettings('default-apps')`, `show-settings-file` → `showSettingsFile()`, `relaunch` → `relaunch()`, `set-zoom` → `setZoomFactor(f)`, `keep-awake` → `setKeepScreenOn(on)`, `app-info` → `getAppInfo()`, `close-guard` + `close-ack` + event `scoresnap:close-request` → `onCloseRequest(cb)`.

**Android app (Capacitor)** — section `android`. `ScoreSnapNativePlugin` reports `api: 2` in `getInfo()`; the shim (`mobile/www-shim/native-android.js`) only defines a method when the installed shell has it (`info.api >= 2` or the plugin header lists it), so a newer web bundle (OTA) in an older shell simply does not show the option.

| Option | Native side |
| --- | --- |
| 화면 켜짐 유지 | `setKeepScreenOn({ on })` → `FLAG_KEEP_SCREEN_ON` |
| 전체 화면 (몰입 모드) | `setImmersive({ on })` → `WindowInsetsControllerCompat`, bars return on a swipe; re-applied in `handleOnResume` |
| 화면 방향 | `setOrientation({ orientation })` → `SENSOR_PORTRAIT` / `SENSOR_LANDSCAPE` / `UNSPECIFIED` |
| 진동 피드백 | `vibrate({ duration })` (1–200 ms) → `Vibrator`; needs the new `VIBRATE` permission line in the manifest |
| 뒤로 버튼 동작 | Capacitor App plugin `backButton` → `onBackButton(cb)`. Order: settings level → open flyout / menu / popover / dialog / sheet / mini toolbar / piano → input mode → `backAction` (`twice`: toast "뒤로를 한 번 더 누르면 앱에서 나갑니다", a second press within 2.2 s leaves; `exit`; `none`). Leaving = `minimizeApp()` (or `exitApp()`) |

**Web / PWA** — section `web`: 화면 켜짐 유지 (Screen Wake Lock, re-acquired when the page becomes visible again; a toast says when the browser refuses), 앱으로 설치 (`beforeinstallprompt` is kept, not suppressed), 저장 공간 (`navigator.storage.estimate` / `persist`), 오프라인 캐시 (deletes the `scoresnap-*` caches and asks the service worker to update).

### What main must check in the CI builds

Nothing below could be run here: there is no Electron and no Android SDK in this environment. Covered instead: `electron-shell.test.js` runs `main.js` + `preload.js` against a fake `electron` module; the plugin was parsed and type-checked with `javac` against minimal stubs; the shim runs in a `vm` context.

Windows build
1. `electron/winstate.js` is in the package (`build.files` in `electron/package.json` has it; the app must start).
2. Move / resize / maximise the window, restart → same place; with 창 크기·위치 기억 off → default size. Unplug the second monitor case: the window comes back on a visible display.
3. 닫을 때 저장 확인 = 항상 묻기: edit, press the window's X and Alt+F4 → the question appears once; 취소 keeps the window, 저장 안 함 closes it. With 묻지 않기 it closes at once. Quit from the menu / installer update still closes.
4. 하드웨어 가속 끄기 → 지금 다시 시작 → the app comes back; "이 기기 › 진단 정보 복사" shows the shell line.
5. 화면 요소 크기 125 % / 150 %: everything scales and the value survives a restart (no double zoom, the window does not shrink).
6. 열기·저장 기본 폴더: the open and save dialogs start there. 파일 연결 opens the Windows default-apps page. 설정 파일 위치 selects `settings.json` in Explorer.

Android build
1. The plugin compiles (`androidx.core.view.WindowCompat` / `WindowInsetsControllerCompat` come in through appcompat; `VibrationEffect` is guarded by `SDK_INT >= O`).
2. 설정 shows "Android 앱" with all four rows; each toggles the real thing (screen stays on, bars hide and return on a swipe and after switching apps, rotation locks, a tick is felt on long-press).
3. Back key / back gesture: closes one level at a time (choice sheet → page → list → settings → …), then the "한 번 더" toast and the second press minimises. With predictive back (Android 14+) the listener must still fire.
4. An older installed shell with the new web bundle (OTA): the app starts, the Android page shows only what that shell can do (뒤로 버튼 동작 through the App plugin; 화면 켜짐 유지 only if its WebView has the Wake Lock API) and no errors appear in logcat.

Web: install the PWA from 설정 › 웹 앱, check 저장 공간 numbers and that 오프라인 캐시 › 캐시 지우기 followed by a reload online restores offline use.

### Known limits

- `app/js/ui/flyout.js` has its own long-press time and calls `navigator.vibrate` directly, so 길게 누르기 시간 and 진동 피드백 do not reach the tool flyouts (only the score).
- The browser version of 화면 요소 크기 needs CSS `zoom` with `currentCSSZoom` (Chromium 128+); elsewhere the row is hidden. It never applies to the phone layout. In the Windows app a large size in a small window can switch to the compact layout, exactly as browser zoom would.
- Descriptions are Korean only (labels and section names have English); `i18n.js` was not extended.
- 입력할 때 소리 내기 (default on) now also sounds for mouse and keyboard entry on the desktop, not only while sliding on touch screens.
- Android: the back key did nothing at the top level before; the default is now "두 번 눌러 나가기".
- The 파일 연결 row only opens the Windows settings page; it cannot register file types itself (the installer does that).
