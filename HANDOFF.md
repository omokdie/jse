# JSE — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-03 21:50 KST. 다음 모델/세션은 이 문서 → `README.md` → `SPEC.md` 순서로 읽으면 됩니다.
> 작업 폴더: `/home/claude/scoresnap` (클라우드 세션 안에만 존재 — 세션이 바뀌면 사용자에게 받은 zip을 풀어서 사용)

## 1. 사용자 요구사항 (반영 상태)

| # | 요구 | 상태 |
|---|---|---|
| 1 | 카메라/인터넷 악보 사진을 분석해 편집 가능한 악보로 | ✅ (인식 품질은 §4 참고) |
| 2 | 전용 확장자 저장 + PDF·PNG·JPG 등 내보내기 | ✅ `.ssnap` / PDF·PNG·JPG·SVG·MusicXML·MXL·MIDI |
| 3 | 즉석 수정, 기존 악보 프로그램 참고, 초보자도 쉽게 | ✅ MuseScore식 입력 + 간단 모드 + 상황별 옵션 바 |
| 4 | 복사·붙여넣기, 여러 페이지 한눈에 보기 등 편의 기능 | ✅ 보기 5종(그리드=아트보드 방식), 반복, 자동저장 등 |
| 5 | 모바일: 같은 파일, 모바일에 맞는 UI | ✅ 화면 맞춤 보기, 하단 탭/입력 바, 바텀시트, 터치 입력 |
| 6 | 인터넷 연결 시 자동 업데이트 + 완료 표시 | ✅ 웹(실제 테스트 통과), Windows/Android(코드 작성, 실기기 미검증) |
| 7 | Windows 설치형 exe, Android apk | ✅ 빌드 설정·CI 작성 (이 환경은 외부망 차단이라 실제 빌드는 GitHub Actions/사용자 PC에서) |
| 8 | 가사·기타 코드·드럼 악보 등 모든 요소 편집 | ✅ |
| 9 | 리퀴드 글라스 UI, 아이콘 직접 그리기 | ✅ |
| 10 | 창 최소화/최대화/닫기 버튼 영역 | ✅ Electron 프레임리스 + 유리 버튼 (`ui.js buildWindowControls`) |
| 11 | 이름 JSE | ✅ 사용자에게 보이는 곳 전부. 내부 식별자는 `scoresnap` 유지 (SPEC 3행) |
| 12 | 아이콘: "JSE" 글자 + 오선 | ✅ `tools/icons/make_wordmark.py` (Inter Display ExtraBold 윤곽 변환) |
| 13 | 상단 버튼 정리 (Adobe식) | ✅ 제목/메뉴 바 · 상황별 옵션 바 · 왼쪽 도구 레일 · 도킹 패널 |

**미결정(사용자 답변 대기)**: 전용 확장자를 `.ssnap` 그대로 둘지, 새 이름으로 바꿀지 (`.jse`는 Windows의 JScript 스크립트 확장자라 쓰면 안 됨 → `.jses` 등 제안).

## 2. 구조 요약

- `app/` 순수 ES 모듈 웹앱(빌드 불필요). 진입점 `js/main.js` → `ui/ui.js`(UI 컨트롤러: 제목바·옵션바·도구 레일·메뉴·텍스트 입력·파일) → `app.js`(상태·히스토리) → `model/commands.js`(모든 편집) → `engrave/*`(자체 조판 엔진, SVG) → `view/canvas.js`(페이지 표시·히트테스트).
- 인식: `omr/omr.js`(순수 JS, Worker) + `ui/omrflow.js`(촬영→준비→인식→검토→적용, PDF는 pdf.js).
- 입출력: `io/ssnap.js`, `io/musicxml.js`(자체 XML 파서, 왕복 테스트 통과), `io/midi.js`, `io/export.js`, `io/storage.js`(IndexedDB).
- 업데이트: `update.js` + `sw.js`(버전은 `mobile/scripts/sync-www.mjs`의 `finalizeWebTree`가 스탬프).
- 패키징: `electron/`(창 제어 IPC `scoresnap:win`, 네이티브 메뉴는 macOS만), `mobile/`(Capacitor 6, OTA 업데이트 Java 플러그인), `.github/workflows/`.
- 아이콘: `tools/icons/make_wordmark.py` → `make-icons.mjs`(PNG 전체) → `make-ico.mjs`(Windows .ico, 앱+문서 아이콘).
- 미리보기: `node tools/build-demo.mjs` → `dist/demo` (라이브러리는 cdnjs, 다운로드는 차단 안내) → claude.ai 아티팩트 slug `91bc8359-75b7-48e0-a9d8-4bd48d714ddb` (publish_files로 재게시).

## 3. 테스트 / 검증 방법

```bash
node --test tools/tests/*.test.js                 # 14개 통과 (편집 9 + MusicXML 5)
python3 -m http.server 8765 -d app                 # 앱 실행
node tools/e2e/shot.mjs http://localhost:8765/ out.png desktop|mobile [script.js]   # 스크린샷 + 콘솔 에러
INIT=<fake-electron.js> node tools/e2e/shot.mjs …  # window.ScoreSnapNative 흉내 → 창 버튼 표시 확인
node tools/omr/run_eval.mjs                        # 인식 정확도
```
브라우저에서 확인 완료: 부팅·편집·키보드 입력·가사(한글 자동 분배)·컨텍스트 메뉴·모바일 터치 입력·사진 인식 전체 흐름·모든 내보내기·.ssnap 왕복·PWA 자동 업데이트(1.0.0→1.0.1, 완료 알림).

## 4. 남은 일 (우선순위)

1. **사진 인식 정확도 개선** — `tools/omr/eval_report.md`: 깨끗한 이미지 음높이 91%/박자 93%, 사진형(회전·원근·휨·조명) 음높이 55%/박자 53%. 원근 보정(네 모서리 검출 + 수동 조정 UI), 오선 휨 추적, 적응형 이진화 개선이 다음 단계.
2. Electron/Android 실제 빌드 검증(외부망 필요) — CI 첫 실행 로그 확인.
3. 확장자 결정 반영(§1).
4. 세부: 운지 번호 전용 렌더링, 복잡한 반복 기호 재생, MIDI 가져오기, 이조 악기 표시.
