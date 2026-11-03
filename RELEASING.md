# 배포 · 자동 업데이트 안내

GitHub 저장소 하나로 **Windows exe, Android apk, 웹앱, 자동 업데이트 서버**가 모두 해결됩니다. 서버를 따로 운영할 필요가 없습니다.

## 처음 한 번만 하는 설정

1. GitHub에서 새 저장소를 만듭니다. 이름은 `jse`를 권장합니다(다른 이름이면 아래 2번에 함께 적습니다).
2. 이 폴더에서 아래 명령으로 자리표시자(`REPLACE_GITHUB_OWNER`)를 내 계정으로 바꿉니다.
   ```bash
   node tools/set-github-owner.mjs <GitHub계정이름> [저장소이름]
   ```
   바뀌는 파일: `electron/package.json`(업데이트 피드), `mobile/android/app/src/main/res/values/strings.xml`(앱 업데이트 주소)
3. 코드를 올립니다.
   ```bash
   git init && git add . && git commit -m "JSE 1.0.0"
   git branch -M main
   git remote add origin https://github.com/<GitHub계정이름>/jse.git
   git push -u origin main
   ```
4. 저장소 **Settings → Pages → Source** 를 **GitHub Actions** 로 바꿉니다. 이제 `https://<계정>.github.io/jse/` 에 웹앱이 올라갑니다.
5. (권장) Android 서명 키 — 없으면 디버그 키로 서명된 APK가 만들어집니다(설치는 되지만, 나중에 정식 키로 바꾸면 한 번 지우고 다시 설치해야 합니다). 정식 배포용이면:
   ```bash
   keytool -genkeypair -v -keystore jse-release.keystore -storetype PKCS12 -alias jse -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 jse-release.keystore    # 출력값을 복사
   ```
   저장소 **Settings → Secrets and variables → Actions → New repository secret** 에 두 개만 추가하면 됩니다.
   - `ANDROID_KEYSTORE_BASE64` — 위 base64 출력값
   - `ANDROID_KEYSTORE_PASSWORD` — 키 저장소 비밀번호
   (별칭이 `jse`가 아니거나 키 비밀번호가 다르면 `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`도 추가)
   > 같은 키로 계속 서명해야 앱 업데이트가 설치됩니다. 키 파일과 비밀번호를 잃어버리지 마세요.
6. (선택) Windows 코드 서명 인증서 — 없으면 처음 실행할 때 "Windows의 PC 보호" 경고가 뜹니다(추가 정보 → 실행). 인증서가 있으면 `CSC_LINK`(pfx를 base64로), `CSC_KEY_PASSWORD` 비밀값을 추가합니다.

## 새 버전 내보내기

1. `app/version.json` 의 `version` 을 올립니다 (예: `1.0.0` → `1.0.1`).
2. 커밋하고 같은 번호로 태그를 붙여 올립니다.
   ```bash
   git commit -am "v1.0.1" && git tag v1.0.1 && git push && git push --tags
   ```
3. 몇 분 뒤 GitHub **Releases** 에 자동으로 올라옵니다.
   - `JSE-Setup-1.0.1.exe` — Windows 설치 파일
   - `JSE-1.0.1.apk` — Android 앱
   - 웹앱은 `https://<계정>.github.io/jse/` 에 자동 반영

## 사용자 쪽에서 업데이트되는 방식

| 플랫폼 | 방식 | 사용자에게 보이는 것 |
|---|---|---|
| 웹앱(PWA) | 앱을 켜 둔 채 1시간마다·인터넷 연결 시 새 버전 확인 → 백그라운드로 받기 → 저장 안 된 작업이 없을 때(또는 자동 저장 후) 새로고침 | "업데이트 완료 — v1.0.1" 알림 |
| Windows | 실행 시·4시간마다 GitHub Releases 확인 → 조용히 다운로드 → 종료할 때 설치 | 상단 "다시 시작하면 업데이트" → 다음 실행 때 "업데이트 완료" |
| Android | 웹 화면(앱 내용)을 무선으로 받아 바로 교체 (`version.json` + `web-<버전>.zip`, SHA-256 검증) | "업데이트 완료" 알림. 네이티브 부분이 바뀐 큰 업데이트일 때만 새 APK 받기 안내 |

설정 → "인터넷 연결 시 자동으로 업데이트" 로 끌 수 있습니다.

## 워크플로 파일

| 파일 | 하는 일 |
|---|---|
| `.github/workflows/build-web.yml` | main에 올릴 때마다 웹앱을 Pages에 배포, Android 무선 업데이트용 `web-<버전>.zip`·`version.json` 생성 |
| `.github/workflows/release.yml` | `v*` 태그 → 릴리스 생성 후 Windows·Android 빌드 실행 |
| `.github/workflows/build-windows.yml` | Windows에서 exe 빌드 → 릴리스에 업로드(+ 자동 업데이트용 `latest.yml`) |
| `.github/workflows/build-android.yml` | apk 빌드 → 릴리스에 업로드 |
