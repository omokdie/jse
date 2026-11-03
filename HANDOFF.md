# JSE — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-04 02:10 KST. 다음 모델/세션은 이 문서 → `README.md` → `SPEC.md` → `RELEASING.md` 순서로 읽으면 됩니다.
> 소스: **GitHub `omokdie/jse` (공개, main)** — 이 저장소가 원본입니다. 클라우드 세션의 작업 폴더는 `/home/claude/scoresnap`(origin = 위 저장소).

## 1. 사용자 요구사항 (반영 상태)

| # | 요구 | 상태 |
|---|---|---|
| 1 | 카메라/인터넷 악보 사진을 분석해 편집 가능한 악보로 | ✅ 사진 원근·휨 보정 파이프라인 추가 (정확도 §4) |
| 2 | 전용 확장자 저장 + PDF·PNG·JPG 등 내보내기 | ✅ `.ssnap` 유지 / PDF·PNG·JPG·SVG·MusicXML·MXL·MIDI |
| 3 | 즉석 수정, 기존 악보 프로그램 참고, 초보자도 쉽게 | ✅ **피날레 방식 도구**(SPEC §5c) + 간단 모드 + 상황별 옵션 바 |
| 4 | 복사·붙여넣기, 여러 페이지 한눈에 보기 등 편의 기능 | ✅ 보기 5종, 범위 끌어서 복사, 반복, 자동저장 등 |
| 5 | 모바일: 같은 파일, 모바일에 맞는 UI | ✅ 휴대폰·**태블릿**·PC 화면 자동 전환 (`native.js classifyLayout`) |
| 6 | 인터넷 연결 시 자동 업데이트 + 완료 표시 | ✅ 웹(테스트 통과) · Windows(electron-updater, GitHub Releases) · Android(웹 번들 OTA) |
| 7 | Windows 설치형 exe, Android apk | ✅ GitHub Actions에서 실제 빌드 성공 (exe 84MB, apk 5MB, 최신 v1.0.2) |
| 8 | 가사·기타 코드·드럼 악보 등 모든 요소 편집 | ✅ |
| 9 | 리퀴드 글라스 UI, 아이콘 직접 그리기 | ✅ |
| 10 | 창 최소화/최대화/닫기 버튼 | ✅ |
| 11 | 이름 JSE | ✅ (내부 식별자는 `scoresnap` 유지, SPEC 머리말) |
| 12 | 아이콘: "JSE" 글자 + 오선 | ✅ |
| 13 | 상단 버튼 정리 (Adobe식) | ✅ + **포토샵식 묶음 버튼**(마우스를 올리면 종류 선택: 온음표~64분음표, 온쉼표~64분쉼표 등) |
| 14 | Finale `.musx` 파일 열기 | ✅ `io/musx.js` (실제 Finale 파일 1,373개 오류 없이 가져오기) |
| 15 | 이음줄 선택·적용이 어려움, 음표가 포인터와 다른 곳에 들어감 | ✅ 모양 도구(음표→음표 끌기, 클릭 선택+핸들), 음표 입력 시 놓일 자리 미리보기 |
| 16 | 쉼표 종류별 입력 | ✅ 팔레트·옵션 바·휴대폰 입력 바 모두 |
| 17 | 사진 인식에서 한국어 가사 읽기 | ✅ `omr/lyrics.js` + `omr/hangul.js` (§4) |
| 18 | 여러 사진으로 학습해 인식 정확도 개선 | 🔶 2차 학습: 실제 곡(피날레 1,373곡)·음악 글꼴 5종, 기호 분류 모델. 처음 보는 사진 음높이 54→71%·박자 57→66% — 목표 80%에는 미달 (§4) |
| 19 | GitHub 설정 | ✅ 저장소·Pages·Actions·Android 정식 서명 키(Secrets) — v1.0.2 APK부터 정식 키(지문 55:8D:…:10:55) |
| 20 | MP3(음원)로 악보 만들기 | 🔧 작업 중 — Basic Pitch(Spotify, Apache-2.0) JS 이식 + 박자·조성·양자화, 피날레 곡을 소리로 바꾼 데이터로 조정 (`tools/audio/README.md`) |

결정 사항: 확장자는 `.ssnap` 유지(`.jse`는 Windows JScript 확장자라 사용 불가). 저장소는 공개(무료 Pages + 자동 업데이트에 필요).

## 2. 구조 요약

- `app/` 순수 ES 모듈 웹앱(빌드 불필요). `js/main.js` → `ui/ui.js`(UI 컨트롤러) → `app.js`(상태·도구·히스토리) → `model/commands.js`(모든 편집) → `engrave/*`(자체 조판, SVG) → `view/canvas.js`(표시·히트테스트).
- 편집 상호작용: `editor/tools.js`(도구 정의·입력 위치 계산·모양/아티큘레이션/표현 적용), `editor/pointer.js`(도구별 마우스/터치), `editor/keyboard.js`(피날레식 단축키·메타툴). 묶음 버튼: `ui/flyout.js` + `ui/groups.js`, 팔레트 `ui/palette.js`.
- 인식: `omr/omr.js`(auto: 기존 파이프라인 → 신뢰도 0.9 미만이면 사진 파이프라인도 실행해 더 나은 결과), 단계별 모듈 `preprocess/staves/dewarp/barlines/heads/classifiers/lyrics/hangul.js`, 학습된 모델 `omr/models/heads.js`(음표머리), `omr/hangul-weights.js`(한글). 흐름 UI `ui/omrflow.js`.
- 입출력: `io/ssnap.js`, `io/musicxml.js`, `io/musx.js`(Finale), `io/midi.js`, `io/export.js`, `io/storage.js`.
- 배포: `.github/workflows/` — `build-web.yml`(main push → Pages), `release.yml`(main 에 새 버전 → 태그·릴리스·exe·apk 자동). 이 클라우드 세션에서는 **태그 push가 막혀 있음**(브랜치 push만 가능) → 버전 올려 main 에 push 하는 방식으로 릴리스.
- 미리보기: `node tools/build-demo.mjs` → `dist/demo` → claude.ai 아티팩트 slug `91bc8359-75b7-48e0-a9d8-4bd48d714ddb`.

## 3. 테스트 / 검증 방법

```bash
node --test tools/tests/*.test.js                  # 19개 통과 (편집·MusicXML·한글/가사 인식)
python3 -m http.server 8765 -d app                  # 앱 실행
node tools/e2e/shot.mjs http://localhost:8765/ out.png desktop|mobile|tablet|tablet-portrait|android-tablet [script.js]
node tools/musx/check.mjs <Finale 파일/폴더>        # Finale 가져오기 일괄 점검
node tools/omr/stage_eval.mjs --dir tools/omr/corpus/eval_photo   # 사진 인식 정확도 (eval_clean, base, aug 도)
node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md   # 가사 인식
```
릴리스 확인: `https://api.github.com/repos/omokdie/jse/actions/runs`, 체크런 주석(`/check-runs/<job id>/annotations`)으로 경고 확인. APK 서명 지문은 `python3 tools/apkcert.py <apk>`(APK Signing Block v2 인증서 SHA-256)으로 확인 — 정식 키 지문 `55:8D:D9:07:…:10:55`.

## 4. 사진 인식 현황과 남은 일

정확도는 `node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<세트>` (음높이 / 박자 / 마디 수 정확, %).

| 시험 세트 | 1차(v1.0.2) | 2차(v1.0.3) |
|---|---|---|
| **fresh_photo** — 처음 보는 실제 곡 21곡을 음악 글꼴 5종(Leipzig는 학습에 안 씀)으로 찍은 사진 56장 | 54.4 / 57.2 / 25.0 | **70.5 / 66.0 / 35.7** |
| ─ 스캔 / 평평한 사진 / 휜 페이지 / 저해상도(음높이·박자) | 84.6/76.3 · 53.3/64.2 · 58.1/54.7 · 16.1/24.7 | 85.1/79.5 · 75.4/70.6 · 68.4/60.9 · 46.5/49.3 |
| fresh_pages — 같은 곡 깨끗한 페이지 28장 | 85.6 / 86.2 / 82.1 | 89.8 / 88.5 / 82.1 |
| eval_photo (합성 사진 60) | 60.9 / 61.6 / 35.0 | 66.9 / 65.7 / 36.7 |
| eval_clean (합성 깨끗 60) | 91.6 / 97.1 / 81.7 | 96.0 / 97.2 / 83.3 |
| base (40) | 92.0 / 93.9 / 85.0 | 94.2 / 95.3 / 92.5 |
| 단계별(fresh_photo) | 조표 33% · 박자표 36% · 마디선 재현율 68% | 조표 66% · 박자표 79% · 마디선 87% · 쉼표 95% · 임시표 52% |
| 한국어 가사 v2 (corpus_ko 깨끗 / 사진형, 글자 정확) | 99.7 / 96.3 % | 99.7 / 97.3 % (처음 보는 글꼴 깨끗 99.9 %) |

모델: `omr/models/heads.js`(음표머리, 60 KB) · `omr/models/glyphs.js`(쉼표·임시표·음자리표·박자 숫자, 87 KB) · `omr/hangul-weights.js`(한글 v2, 1,050 KB). 학습 데이터 생성: `tools/omr/gen_finale_pages.mjs`(피날레 곡 → 앱 조판기 → 사진 시뮬레이션, 글꼴은 `smufl_glyphs.py`로 학습용만), `gen_photo.py`, 한글은 `tools/omr/hangul/fetch_fonts.sh` → `gen_data.py` → `train.py`. 상세: `tools/omr/IMPROVEMENTS.md`, `tools/omr/hangul/README.md`.

남은 일(우선순위):
1. 사진 인식: 리듬(빔·꼬리·점·셋잇단)을 규칙 대신 학습으로(8분이 16분으로 읽히는 오류가 가장 많음), 마디선 검증 분류기, 음표머리에 붙은 임시표, 저해상도 학습 데이터 확대, 조판기 조표 간격(글꼴 폭 반영). 상세: `tools/omr/IMPROVEMENTS.md`.
2. 가사: 영어 가사(단어·하이픈), 오선 위 가사, 10px 이하 가는 글씨(이진화에서 사라짐), 줄 단위 언어 모델.
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고). 남은 Node 20 액션 경고(android-actions/setup-android, gradle/actions, softprops/action-gh-release, Pages 액션).
4. Finale 가져오기: 2차에서 표현 텍스트 연결 버그(textIDKey → textBlock → textID) 수정, 여러 보표에 같은 템포·표현 중복 제거, 보표 지정 표현은 그 보표 음표에. 남은 것: 빈 마디 보표의 표현 위치.
5. 세부: 운지 번호 전용 렌더링, 복잡한 반복 재생, MIDI 가져오기, 가사 아래 이음줄 충돌 회피.
