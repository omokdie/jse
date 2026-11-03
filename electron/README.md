# JSE — Windows 데스크톱(Electron)

`app/` 의 웹 앱을 그대로 감싸는 Windows용 셸입니다. 설치 프로그램(`JSE-Setup-x.y.z.exe`),
`.ssnap` 파일 연결, 자동 업데이트를 제공합니다.

```
electron/
  main.js        메인 프로세스: 창, 단일 인스턴스, 파일 열기, IPC, 메뉴
  preload.js     window.ScoreSnapNative (SPEC §6) 구현
  updater.js     electron-updater 래퍼 (GitHub Releases 피드)
  protocol.js    app://scoresnap/ 프로토콜 — app/ 폴더를 서빙
  menu.js        파일/편집/보기/도움말 메뉴
  settings.js    %APPDATA%\JSE\settings.json
  scripts/
    sync-version.mjs   app/version.json → package.json 버전 동기화
    make-icons.mjs     app/icons/icon-512.png → build/icon.ico, build/ssnap.ico
  build/         아이콘(빌드 리소스) — build/README.md 참고
```

## 로컬 빌드 (Windows)

1. [Node.js 20 LTS](https://nodejs.org/) 설치
2. 터미널에서

   ```bat
   cd electron
   npm install
   npm i --no-save sharp && node scripts\make-icons.mjs   :: 아이콘 생성(최초 1회 / 아이콘 변경 시)
   npm run dist:win
   ```

3. 결과물: `electron\dist\JSE-Setup-<버전>.exe`
   (같은 폴더의 `latest.yml`, `*.blockmap` 은 자동 업데이트용 메타데이터입니다)

개발 중 바로 실행: `npm start` (`../app` 폴더를 그대로 읽습니다. 웹 앱 파일을 고치고 F5/Ctrl+R).

> `npm install` 뒤에 생성되는 `package-lock.json` 은 커밋해 두면 CI 가 `npm ci` 로 더 빠르고 재현성 있게 설치합니다.

## 어디에 무엇이 들어가나

| 항목 | 값 |
|------|----|
| 설치 위치 | `%LOCALAPPDATA%\Programs\JSE\` (사용자별 설치, 관리자 권한 불필요) |
| 웹 앱 파일 | `<설치 폴더>\resources\web\index.html` (electron-builder `extraResources: ../app → web`) |
| 렌더러 URL | `app://scoresnap/index.html` — `file://` 는 ES 모듈·서비스 워커가 막히고, `http://127.0.0.1:임의포트` 는 포트가 바뀌면 IndexedDB/localStorage 가 사라지므로 고정 origin 의 커스텀 스킴을 사용합니다 |
| 설정 파일 | `%APPDATA%\JSE\settings.json` (`update.auto`, 마지막 폴더 등) |
| 로그 | `%APPDATA%\JSE\logs\main.log` |
| 파일 연결 | `.ssnap` → ProgID `kr.scoresnap.app.ssnap` (HKCU), 아이콘 `ssnap.ico`, 더블클릭·"연결 프로그램" 모두 지원 |

### `.ssnap` 파일 열기 흐름
1. 탐색기 더블클릭 → `JSE.exe "C:\...\곡.ssnap"`
2. 이미 실행 중이면 `second-instance` 이벤트로 기존 창에 전달(단일 인스턴스)
3. 메인 프로세스가 파일을 읽어 `{name, mime:'application/x-scoresnap', base64}` 로 만들고,
   렌더러가 `scoresnap:ready` 를 보낸 뒤 `ScoreSnapNative.onOpenFile(cb)` 로 전달
4. 같은 이름으로 `saveFile()` 하면 대화상자 없이 원래 경로에 덮어씁니다(`suggestDialog:true` 면 "다른 이름으로 저장")

## 자동 업데이트

* 피드: `package.json → build.publish` 의 GitHub 저장소 Releases (`latest.yml` + `JSE-Setup-x.y.z.exe`)
* 시작 8초 후, 이후 4시간마다 온라인일 때 확인 → **자동 다운로드** → 앱 종료 시 자동 설치
  (`autoDownload`, `autoInstallOnAppQuit`). 사용자가 "지금 다시 시작" 을 누르면 즉시 조용히 설치 후 재실행
* 진행 상태는 `ScoreSnapNative.onUpdateStatus(cb)` 로 전달 (`checking / available / downloading / ready / up-to-date / error`)
* 업데이트가 적용된 첫 실행에서는 `{state:'done', version}` 을 한 번 보냅니다 → 웹 앱이 "업데이트 완료 — vX.Y.Z" 토스트 표시
* 설정: `getUpdateSettings()` / `setUpdateSettings({auto:false})` (자동 다운로드 끄기; 수동 확인은 계속 가능)
* 네트워크가 없거나 피드가 없으면 조용히 넘어갑니다(사용자에게 예외가 던져지지 않음)
* `build.publish[0].owner` 가 `REPLACE_GITHUB_OWNER` 그대로면 업데이트 확인을 건너뛰고 로그만 남깁니다

## 반드시 바꿔야 하는 값

| 파일 | 항목 |
|------|------|
| `electron/package.json` | `build.publish[0].owner` → 본인 GitHub 계정/조직 이름, `homepage` |

자세한 배포 절차는 저장소 루트의 `RELEASING.md` 를 보세요.

## 코드 서명 (선택)

서명하지 않은 exe 는 처음 실행할 때 Windows SmartScreen 경고("알 수 없는 게시자")가 뜹니다.
"추가 정보 → 실행" 으로 실행할 수 있고, 자동 업데이트도 정상 동작합니다.
경고를 없애려면 코드 서명 인증서(OV/EV)가 필요합니다. 인증서가 있으면

```bat
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=비밀번호
npm run dist:win
```

GitHub Actions 에서는 같은 이름의 Secrets(`CSC_LINK` = pfx 의 base64, `CSC_KEY_PASSWORD`)를 추가하면 electron-builder 가 자동으로 서명합니다.

## 메뉴 → 웹 앱 액션

메뉴 항목은 `ScoreSnapNative.onMenu((action, payload) => …)` 로 전달됩니다:
`new, open, open-image, import-musicxml, save, save-as, export(payload: pdf|png|jpg|svg|musicxml|mxl|midi), print,
undo, redo, settings, zoom-in, zoom-out, zoom-reset, zoom-fit, help`.
렌더러가 단축키를 직접 처리(`preventDefault`)하면 메뉴 액셀러레이터는 발동하지 않으므로 중복 실행되지 않습니다.
텍스트 입력란에 포커스가 있을 때의 `undo/redo` 액션은 웹 앱에서 무시해야 합니다(브라우저가 이미 텍스트 실행 취소를 수행).
