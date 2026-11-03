# JSE — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-04 07:10 KST. 다음 모델/세션은 이 문서 → `README.md` → `SPEC.md` → `RELEASING.md` 순서로 읽으면 됩니다.
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
| 7 | Windows 설치형 exe, Android apk | ✅ GitHub Actions에서 실제 빌드 성공 (exe 84MB, apk 5MB) |
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
| 18 | 여러 사진으로 학습해 인식 정확도 개선 (사용자 목표: 사진 90%) | 🔶 4차까지: 실제 곡(피날레 1,373곡 + When-in-Rome 761곡)·음악 글꼴 10종, 기호·박자(빔/꼬리)·마디선 모델, 음자리표·조표·오선 검출 수정. 새 보류 세트 holdout4 사진 음높이 69→75%·박자 80→82%·마디 70→74% — 90%까지 계속 (§4) |
| 19 | GitHub 설정 | ✅ 저장소·Pages·Actions·Android 정식 서명 키(Secrets) — v1.0.2 APK부터 정식 키(지문 55:8D:…:10:55) |
| 20 | MP3(음원)로 악보 만들기 | ✅ `audio/*` + `ui/audioflow.js` (파일 메뉴 · 상단 '음원으로 악보' · 도구 막대 · 시작 화면 · 파일 열기/끌어 놓기 · 휴대폰 보조 버튼). Basic Pitch 그래프를 순수 JS+WASM SIMD로 실행. 합성 보류 세트 음표 F1 멜로디 93 % / 피아노 84 %, 악보 음표(음높이+위치) 57 % / 75 % (빠르기를 맞힌 경우 83 % / 91 %), 4분 곡 약 11초. 학습·평가: `tools/audio/README.md` |

결정 사항: 확장자는 `.ssnap` 유지(`.jse`는 Windows JScript 확장자라 사용 불가). 저장소는 공개(무료 Pages + 자동 업데이트에 필요).

## 2. 구조 요약

- `app/` 순수 ES 모듈 웹앱(빌드 불필요). `js/main.js` → `ui/ui.js`(UI 컨트롤러) → `app.js`(상태·도구·히스토리) → `model/commands.js`(모든 편집) → `engrave/*`(자체 조판, SVG) → `view/canvas.js`(표시·히트테스트).
- 편집 상호작용: `editor/tools.js`(도구 정의·입력 위치 계산·모양/아티큘레이션/표현 적용), `editor/pointer.js`(도구별 마우스/터치), `editor/keyboard.js`(피날레식 단축키·메타툴). 묶음 버튼: `ui/flyout.js` + `ui/groups.js`, 팔레트 `ui/palette.js`.
- 인식: `omr/omr.js`(auto: 기존 파이프라인 → 신뢰도 0.9 미만이면 사진 파이프라인도 실행해 더 나은 결과), 단계별 모듈 `preprocess/staves/dewarp/barlines/heads/classifiers/lyrics/hangul.js`, 학습된 모델 `omr/models/heads.js`(음표머리), `omr/hangul-weights.js`(한글). 흐름 UI `ui/omrflow.js`.
- 음원: `audio/engine.js`(디코드→분석→정리), `audio/basicpitch.js`+`tfgraph.js`+`wasmconv.js`(Basic Pitch 실행), `audio/transcribe.js`(빠르기·박자·조성·양자화·코드 → ScoreDoc), `audio/keymodel.js`, 모델 `vendor/basic-pitch/`. 흐름 UI `ui/audioflow.js`.
- 입출력: `io/ssnap.js`, `io/musicxml.js`, `io/musx.js`(Finale), `io/midi.js`, `io/export.js`, `io/storage.js`.
- 배포: `.github/workflows/` — `build-web.yml`(main push → Pages), `release.yml`(main 에 새 버전 → 태그·릴리스·exe·apk 자동). 이 클라우드 세션에서는 **태그 push가 막혀 있음**(브랜치 push만 가능) → 버전 올려 main 에 push 하는 방식으로 릴리스.
- 미리보기: `node tools/build-demo.mjs` → `dist/demo` → claude.ai 아티팩트 slug `91bc8359-75b7-48e0-a9d8-4bd48d714ddb`.

## 3. 테스트 / 검증 방법

```bash
node --test tools/tests/*.test.js                  # 27개 통과 (편집·MusicXML·한글/가사 인식·음원)
python3 -m http.server 8765 -d app                  # 앱 실행
node tools/e2e/shot.mjs http://localhost:8765/ out.png desktop|mobile|tablet|tablet-portrait|android-tablet [script.js]
node tools/musx/check.mjs <Finale 파일/폴더>        # Finale 가져오기 일괄 점검
node tools/omr/stage_eval.mjs --dir tools/omr/corpus/eval_photo   # 사진 인식 정확도 (eval_clean, base, aug 도)
node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md   # 가사 인식
node tools/audio/eval.mjs …                        # 음원 → 악보 평가 (명령은 tools/audio/README.md)
```
참고: `enigmaToScore(xml, { meta })` 의 meta 는 null 또는 파싱된 NotationMetadata XML 노드여야 함(일반 객체를 넘기면 오류).
릴리스 확인: `https://api.github.com/repos/omokdie/jse/actions/runs`, 체크런 주석(`/check-runs/<job id>/annotations`)으로 경고 확인. APK 서명 지문은 `python3 tools/apkcert.py <apk>`(APK Signing Block v2 인증서 SHA-256)으로 확인 — 정식 키 지문 `55:8D:D9:07:…:10:55`.

## 4. 사진 인식 현황과 남은 일

정확도는 `node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<세트>` (음높이 / 박자 / 마디 수 정확, %). 시험 세트 원칙: 매 차수 시작 때 새 보류 세트를 만들어 잠그고 마지막에만 잰다(이전 보류 세트는 개발용으로 강등).

| 시험 세트 | 2차(v1.0.3) | 3차(v1.0.5) | 4차(v1.0.6) |
|---|---|---|---|
| **holdout4 사진 80장** — 처음 쓰는 곡(When-in-Rome·OpenScore 가곡·모차르트·베토벤 4중주), 처음 쓰는 글꼴 3종(Finale Maestro·Gootville·MScore) | – | 68.9 / 79.9 / 70.0 | **75.1 / 81.6 / 73.8** |
| ─ 스캔 / 평평 / 휜 페이지 / 저해상도 (음높이/박자/마디) | – | 71.0/94.3/81.3 · 85.9/89.2/75.0 · 81.7/89.2/80.0 · 26.3/42.8/37.5 | 84.6/94.9/75.0 · 84.8/89.2/75.0 · 88.0/92.7/90.0 · 37.9/46.1/50.0 |
| holdout4 깨끗한 페이지 40장 | – | 87.0 / 95.7 / 90.0 | 92.1 / 95.8 / 87.5 |
| holdout3 사진 82장 (3차 보류 → 4차 개발용) | 59.1 / 65.1 / 61.0 | 63.5 / 75.6 / 68.3 | 74.0 / 79.7 / 74.4 |
| holdout3 깨끗한 페이지 41장 | 81.4 / 89.3 / 82.9 | 84.1 / 92.3 / 85.4 | 93.0 / 95.5 / 87.8 |
| fresh_photo 56 | 70.5 / 66.0 / 35.7 | 81.1 / 85.1 / 66.1 | 83.7 / 85.7 / 67.9 |
| eval_photo 60 | 66.9 / 65.7 / 36.7 | 83.2 / 85.9 / 53.3 | 84.1 / 84.3 / 56.7 |
| eval_clean 60 / base 40 | 96.0 / 97.2 / 83.3 · 94.2 / 95.3 / 92.5 | 96.5 / 97.8 / 83.3 · 97.1 / 97.1 / 92.5 | 97.5 / 97.8 / 83.3 · 97.6 / 97.1 / 92.5 |
| 단계별(holdout4 사진) | – | 음자리표 83.7 · 페이지 조표 78.8 · 마디선 89.5/99.5 · 음표머리 89.9 · 쉼표 91.2 · 임시표 58.6 | 89.2 · 80.0 · 90.5/99.8 · 92.3 · 94.4 · 62.3 |
| 한국어 가사 v2 (corpus_ko 깨끗 / 사진형, 글자 정확) | 99.7 / 97.3 % | (변경 없음) |

3차 주요 변경: 마디선을 찾은 뒤 같은 x의 다른 단 줄기까지 지우던 1차 버그 수정(음표머리 약 11% 손실 → 가장 큰 향상), 마디선 검증 모델 `models/bars.js`, 빔·꼬리 수 모델 `models/rhythm.js` + 마디를 정확히 채우는 길이 해석(`omr/rhythm.js`, 셋잇단 포함), 음표머리에 붙은 임시표, 페이지 전체 조표 투표, 빠진 음자리표는 다른 단에서, 마디 내용과 안 맞는 박자표 교체. 모델 합계 294 KB(glyphs 87 · rhythm 87 · heads 60 · bars 59) + 한글 1,050 KB. 사진 1장 브라우저 워커 3.4–4.4초.
4차 주요 변경(정확도 표의 '4차'): 음자리표 선택(보표 머리의 큰 모양을 분류기로 골라 리허설 마크 상자·위 보표의 높은음자리표를 건너뜀, 조각난/번진 음자리표), 빔이 빽빽한 보표 검출, 스캔의 검은 테두리 처리, 자동 모드에서 엉터리 박자(1/4 등)로 '확신'한 결과 거르기, 박자표 투표, 넓은 샵(조표)·높은 플랫(임시표)·화음 임시표. 모델(294 KB)은 그대로 — 글꼴·저해상도 사진을 늘려 다시 학습한 기호·박자 모델은 개발 세트에서 나아지지 않아 넣지 않음. 사진 1장 브라우저 워커(스캔 화면 전체 흐름) 약 5–6초(v1.0.5와 같은 사진·같은 기계에서 같음). holdout4는 코드를 잠근 뒤 한 번(76.5 / 81.6 / 73.8), 개발 세트에서 찾은 알토 음자리표 회귀를 고친 최종 코드로 한 번 더 쟀음(위 표). 상세: `tools/omr/IMPROVEMENTS.md` Round 4.

남은 일(우선순위):
1. 사진 인식(목표 90%, 현재 holdout4 사진 음높이 75%·박자 82%): 저해상도 사진의 음자리표(잃은 음의 약 절반) → 샵/플랫 4–6개 조표(약 1/3) → 저해상도 사진 전반(음높이 38%) → 마디 안 임시표(62%)·점·16/32분 → 마디선. 상세: `tools/omr/IMPROVEMENTS.md`.
2. 가사: 영어 가사(단어·하이픈), 오선 위 가사, 10px 이하 가는 글씨(이진화에서 사라짐), 줄 단위 언어 모델.
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고). 남은 Node 20 액션 경고(android-actions/setup-android, gradle/actions, softprops/action-gh-release, Pages 액션).
4. Finale 가져오기: 2차에서 표현 텍스트 연결 버그(textIDKey → textBlock → textID) 수정, 여러 보표에 같은 템포·표현 중복 제거, 보표 지정 표현은 그 보표 음표에. 남은 것: 빈 마디 보표의 표현 위치.
5. 음원 → 악보: 실제 녹음+정렬된 악보로 평가, 빠르기 절반/두 배 판단 개선(다운비트 단서, 박자 두드리기), 보표당 두 번째 성부(지속음), 마이크 녹음, 멜로디만 있는 입력의 코드 추정.
6. 세부: 운지 번호 전용 렌더링, 복잡한 반복 재생, MIDI 가져오기, 가사 아래 이음줄 충돌 회피.
