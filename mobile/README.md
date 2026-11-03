# JSE — Android(Capacitor 6)

`app/` 의 웹 앱을 Android WebView 에 담은 앱입니다. 파일 관리자/공유 시트에서 `.ssnap` 열기,
카메라(`<input type="file" capture>`), 다운로드 폴더 저장, **웹 번들 OTA 자동 업데이트**(SPEC §7)를 제공합니다.

```
mobile/
  package.json              @capacitor/core, android, app, filesystem, share (+ cli)
  capacitor.config.json     appId kr.scoresnap.app, webDir www, androidScheme https
  www-shim/native-android.js   window.ScoreSnapNative (SPEC §6) ← Capacitor 플러그인 브리지
  scripts/
    sync-www.mjs            ../app → www 복사 + shim 주입 (GitHub Pages / OTA zip 도 같은 스크립트로 생성)
    make-android-icons.mjs  app/icons/icon-512.png → res/mipmap-*/ic_launcher*.png
  android/                  Android Studio 프로젝트 (node_modules 없이 커밋)
    app/build.gradle        versionName/versionCode ← ../../app/version.json, 서명 설정(환경변수)
    app/src/main/AndroidManifest.xml   .ssnap 인텐트 필터, 공유 수신, FileProvider
    app/src/main/java/kr/scoresnap/app/
      MainActivity.java            플러그인 등록, 번들 적용
      ScoreSnapNativePlugin.java   getInfo / readPendingFile / saveFile / shareFile / 업데이트 메서드
      WebUpdater.java              version.json 확인 → zip 다운로드 → SHA-256 검증 → 압축 해제 → 번들 전환
      SyncInfoBridge.java          동기 버전 정보(JavascriptInterface)
      Semver.java
```

## 로컬 빌드

1. **JDK 17** 과 **Android Studio**(SDK 34 포함) 설치, Node.js 20 설치
2. 웹 앱을 `www/` 로 복사하고 네이티브 프로젝트를 동기화

   ```bash
   cd mobile
   npm install
   npm i --no-save sharp && npm run icons   # 아이콘 생성(최초 1회 / 아이콘 변경 시)
   npm run sync                             # ../app → www, shim 주입, npx cap sync android
   ```

3. Android Studio 에서 `mobile/android/` 폴더를 열기 → Gradle 동기화 → **Build › Build Bundle(s) / APK(s) › Build APK(s)**
   * Gradle 래퍼(`gradlew`)가 없다고 하면 Android Studio 가 만들어 주거나, 터미널에서 `npm run wrapper`
     (= `gradle wrapper --gradle-version 8.7`, Gradle 설치 필요)
   * 결과: `mobile/android/app/build/outputs/apk/release/JSE-<버전>.apk`
     (서명 키가 없으면 디버그 키로 서명됩니다 — 설치는 되지만 나중에 정식 키 APK 로 덮어쓸 수 없습니다)

명령줄 빌드: `npm run build:apk` (release) / `npm run build:apk:debug`.
웹 앱만 바꿨다면 `npm run copy` 뒤 다시 실행하면 됩니다.

## 서명 키 만들기 (배포용, 한 번만)

```bash
keytool -genkeypair -v -keystore scoresnap-release.keystore -alias scoresnap \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=JSE, OU=Dev, O=JSE, L=Seoul, C=KR"
```

* 이 파일과 비밀번호를 **절대 저장소에 넣지 마세요**. 잃어버리면 같은 패키지 이름으로 업데이트 APK 를 배포할 수 없습니다.
* 로컬 서명 빌드:

  ```bash
  export KEYSTORE_PATH=/절대경로/scoresnap-release.keystore
  export KEYSTORE_PASSWORD=... KEY_ALIAS=scoresnap KEY_PASSWORD=...
  npm run build:apk
  ```
* GitHub Actions 용 Secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 scoresnap-release.keystore` 결과),
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — `RELEASING.md` 참고.

## `.ssnap` 파일 연결이 동작하는 방식

* `AndroidManifest.xml` 의 `MainActivity` 에 세 가지 `VIEW` 인텐트 필터가 있습니다:
  MIME `application/x-scoresnap`, 확장자 패턴(`.*\.ssnap`, MIME 있음), 확장자 패턴(MIME 없음).
  점이 여러 개인 파일 이름을 위해 `pathPattern` 을 여러 번 반복하는 표준 우회법을 씁니다.
  `SEND`(공유 시트)로 들어온 모든 파일도 받습니다(악보 사진 → OMR).
* `launchMode="singleTask"` 이므로 앱이 떠 있으면 `onNewIntent` 로 들어옵니다.
  Capacitor 가 모든 플러그인의 `handleOnNewIntent()` 를 호출 → `ScoreSnapNativePlugin` 이 URI 를 보관하고
  JS 에 `openFile` 이벤트(메타데이터만)를 보냅니다 → shim 이 `readPendingFile()` 로 내용을 base64 로 받아
  `ScoreSnapNative.onOpenFile(cb)` 로 전달합니다. 콜드 스타트 때는 shim 이 시작하자마자 `readPendingFile()` 을 호출합니다.
* 크기 제한 50 MB.

## OTA 웹 번들 업데이트가 동작하는 방식

```
시작 4초 후 / 포그라운드 복귀(4시간 간격) / 사용자 요청
  → GET  update_base_url/version.json          { version, web:{bundle, sha256}, android:{minNative, apkUrl}, notes }
  → 현재 서빙 중인 번들의 version.json 과 semver 비교 (자산 폴더면 APK 에 포함된 버전)
  → 새 버전이면 {state:'available'} → (auto=true) zip 다운로드({state:'downloading', percent})
  → SHA-256 검증 → files/bundles/<version>/ 에 압축 해제(zip-slip 차단, index.html 확인)
  → Capacitor 의 SharedPreferences(CapWebViewSettings/serverBasePath)에 경로 저장 → {state:'ready'}
  → 웹 앱이 안전한 시점에 installUpdate() → bridge.setServerBasePath(path) → WebView 리로드
  → 새 번들에서 shim 이 getUpdateStatus() → {state:'done', version} → "업데이트 완료" 토스트
```

* 적용 방식: `Bridge.setServerBasePath()` 는 메모리에서만 유효하므로 Capacitor 가 시작할 때 읽는
  `CapWebViewSettings/serverBasePath` 키(코어 `WebView.persistServerBasePath()` 가 쓰는 것과 동일)를 네이티브에서 직접 기록합니다.
  추가로 `MainActivity.onCreate()` 끝에서 `WebUpdater.ensureActiveBundle()` 이 "패키지된 웹 앱보다 새로운 유효한 번들"이
  실제로 서빙되고 있는지 확인하고, 아니면 적용(리로드 1회)하며, APK 가 갱신되어 패키지 버전이 더 새로우면 옛 번들을 지웁니다.
* 웹 앱이 `installUpdate()` 를 끝내 호출하지 않아도 다음 콜드 스타트에서 새 번들이 뜹니다.
* 번들은 최신 2개만 보관합니다.
* `android.minNative` 가 설치된 앱 버전보다 높으면 웹 번들 대신 `{state:'available', requiresNative:true, apkUrl}` 을 보내고,
  `installUpdate()` 는 브라우저로 APK 링크를 엽니다(설치는 사용자가 진행).
* 설정: `getUpdateSettings()` → `{auto, wifiOnly, channel, url}`, `setUpdateSettings({auto:false})`.

### 업데이트 URL 바꾸기

`mobile/android/app/src/main/res/values/strings.xml` 의 `update_base_url` (`https://<GitHub계정>.github.io/jse/`).
`REPLACE_GITHUB_OWNER` 그대로면 업데이트 확인을 건너뜁니다.

## 웹 앱 작성자에게

* Android 에서는 `window.ScoreSnapNative.platform === 'android'` 입니다. `appVersion` 은 네이티브 앱 버전, `webVersion` 은 현재 웹 번들 버전입니다.
* 내보내기 저장은 반드시 `saveFile()` 을 쓰세요 (WebView 는 `<a download>` 의 blob 을 저장하지 못합니다). 결과 `{path:'Download/JSE/…', uri}`.
* 사진 입력은 `<input type="file" accept="image/*" capture="environment">` 로 충분합니다(Capacitor 가 카메라 권한을 처리).
* 네이티브 셸에서는 서비스 워커를 등록하지 않는 편이 안전합니다(OTA 번들이 대신합니다). 등록했더라도 shim 이
  `installUpdate()` 와 번들 전환 직후에 SW/캐시를 정리합니다.
