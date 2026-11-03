# electron/build — 빌드 리소스

electron-builder가 이 폴더에서 아이콘을 읽습니다. **다음 두 파일이 반드시 있어야 합니다.**

| 파일 | 용도 |
|------|------|
| `icon.ico`  | 프로그램 아이콘 (exe, 설치 프로그램, 바로가기). 16/24/32/48(BMP) + 64/128/256(PNG) 크기 포함 |
| `ssnap.ico` | `.ssnap` 문서 아이콘 (파일 연결) |
| `icon.png`  | 개발 실행(`electron .`) 시 창 아이콘 (256px) |

## 생성 방법

```bash
cd electron
npm i --no-save sharp          # CI 에서는 자동으로 실행됩니다
node scripts/make-icons.mjs    # ../app/icons/icon-512.png → icon.ico, ssnap.ico, icon.png
```

* 원본은 `app/icons/icon-512.png` 입니다. 파일이 아직 없으면 스크립트가 임시(플레이스홀더) 아트로
  아이콘을 만들어 두므로 빌드는 항상 성공합니다. 실제 아이콘이 생기면 다시 실행하세요.
* 현재 저장소에 들어 있는 `icon.ico` / `ssnap.ico` 는 그 플레이스홀더입니다.
* CI(`.github/workflows/build-windows.yml`)는 빌드할 때마다 이 스크립트를 다시 실행합니다.
* `.ico` 컨테이너는 스크립트 안에서 직접 기록합니다(별도 png-to-ico 의존성 없음).
