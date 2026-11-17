# JSE — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-18 KST (v1.1.0 — 글꼴 · 다른 악보 프로그램 파일 · 설정, §5). 다음 모델/세션은 이 문서 → `README.md` → `SPEC.md` → `RELEASING.md` 순서로 읽으면 됩니다.
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
| 7 | Windows 설치형 exe, Android apk | ✅ GitHub Actions에서 실제 빌드 성공 (v1.1.0: exe 85MB, apk 6MB) |
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
| 18 | 여러 사진으로 학습해 인식 정확도 개선 (사용자 목표: 사진 90%) | 🔶 6차까지 학습 후 사용자 요청으로 종료(v1.0.8). 마지막 보류 세트 holdout6 사진 음높이 88.3%·박자 87.1%(스캔 95.5 · 평평 93.5 · 휜 페이지 90.9 · 저해상도 68.2%) — 단, 이 세트는 쉬운 편(64쪽 중 33쪽이 다장조)이고 더 어려운 holdout5 사진은 77.6 / 81.0%. 1차 대비: 사진 음높이 약 52%→78~88%. 이어서 할 일은 `tools/omr/IMPROVEMENTS.md` 끝의 "Where to continue" (§4) |
| 19 | GitHub 설정 | ✅ 저장소·Pages·Actions·Android 정식 서명 키(Secrets) — v1.0.2 APK부터 정식 키(지문 55:8D:…:10:55) |
| 20 | MP3(음원)로 악보 만들기 | ✅ `audio/*` + `ui/audioflow.js` (파일 메뉴 · 상단 '음원으로 악보' · 도구 막대 · 시작 화면 · 파일 열기/끌어 놓기 · 휴대폰 보조 버튼). Basic Pitch 그래프를 순수 JS+WASM SIMD로 실행. 합성 보류 세트 음표 F1 멜로디 93 % / 피아노 84 %, 악보 음표(음높이+위치) 57 % / 75 % (빠르기를 맞힌 경우 83 % / 91 %), 4분 곡 약 11초. 학습·평가: `tools/audio/README.md` |
| 21 | 가사·제목·코드의 글꼴 크기와 종류 변경 | ✅ v1.1.0 — 악보 → 글꼴…(휴대폰 ⋯ 메뉴), 글자 오른쪽 클릭 → 글꼴 바꾸기…, 속성 패널. 글자 종류 11가지 × 글꼴·크기(pt)·굵게·기울임, 글자 하나만 따로, 새 악보 기본값. 글꼴: 기본 · 이 기기의 글꼴 · JSE 글꼴 7종(처음 쓸 때 내려받음). SPEC §2b, `tools/fonts/README.md` |
| 22 | Sibelius·MuseScore·NWC 등 다른 프로그램 파일 열기 + 각 프로그램 확장자로 저장 | ✅ v1.1.0 — MuseScore `.mscz/.mscx` 열기·저장, NWC `.nwc/.nwctxt` 열기·저장(1.75 저장은 실험적). 🔶 Sibelius `.sib`는 직접 읽고 쓸 수 없음(비공개·암호화 형식) → MusicXML 경유 안내 + "Sibelius용 (MusicXML)" 내보내기. SPEC §5d–5f, §5 아래 검증 결과 |
| 23 | 설정을 더 자세하고 편하게, 플랫폼별로 | ✅ v1.1.0 — 검색되는 설정 창(약 70개 항목, 13개 구역), Windows 앱·Android 앱·웹 앱 전용 구역. SPEC §9, `tools/settings/README.md` |

결정 사항: 확장자는 `.ssnap` 유지(`.jse`는 Windows JScript 확장자라 사용 불가). 저장소는 공개(무료 Pages + 자동 업데이트에 필요).

## 2. 구조 요약

- `app/` 순수 ES 모듈 웹앱(빌드 불필요). `js/main.js` → `ui/ui.js`(UI 컨트롤러) → `app.js`(상태·도구·히스토리) → `model/commands.js`(모든 편집) → `engrave/*`(자체 조판, SVG) → `view/canvas.js`(표시·히트테스트).
- 편집 상호작용: `editor/tools.js`(도구 정의·입력 위치 계산·모양/아티큘레이션/표현 적용), `editor/pointer.js`(도구별 마우스/터치), `editor/keyboard.js`(피날레식 단축키·메타툴). 묶음 버튼: `ui/flyout.js` + `ui/groups.js`, 팔레트 `ui/palette.js`.
- 인식: `omr/omr.js`(auto: 기존 파이프라인 → 신뢰도 0.9 미만이면 사진 파이프라인도 실행해 더 나은 결과), 단계별 모듈 `preprocess/staves/dewarp/barlines/heads/classifiers/lyrics/hangul.js`, 학습된 모델 `omr/models/heads.js`(음표머리), `omr/hangul-weights.js`(한글). 흐름 UI `ui/omrflow.js`.
- 음원: `audio/engine.js`(디코드→분석→정리), `audio/basicpitch.js`+`tfgraph.js`+`wasmconv.js`(Basic Pitch 실행), `audio/transcribe.js`(빠르기·박자·조성·양자화·코드 → ScoreDoc), `audio/keymodel.js`, 모델 `vendor/basic-pitch/`. 흐름 UI `ui/audioflow.js`.
- 입출력: `io/ssnap.js`(+ `sniffFile`, `FOREIGN_SCORE_FORMATS`), `io/musicxml.js`, `io/musx.js`(Finale), `io/mscz.js`(MuseScore), `io/nwc.js` + `io/nwc-*.js`(NWC), `io/midi.js`(재생 목록 + MIDI), `io/export.js`, `io/storage.js`. 다른 프로그램 파일 열기 흐름 `ui/importflow.js`, 내보내기 대화상자 `ui/exportdlg.js`.
- 글꼴: `model/textstyles.js`(글자 종류·기본값·pt↔sp) → `engrave/styles.js` → 조판, `fonts.js`(기기 글꼴·JSE 글꼴 내려받기·IndexedDB·SVG에 담기), `ui/textstyle.js`. 글꼴 파일 `app/fonts/web/`는 **GitHub Pages에서만** 제공(설치 파일·APK·OTA 묶음·서비스 워커 캐시에는 없음).
- 설정: `settings.js`(항목 목록·플랫폼 조건·기본값·이전 값 옮기기) + `ui/settings.js`. 값은 `localStorage['ssnap.settings']`, Windows 셸은 필요한 값의 사본을 자기 `settings.json`에 둠.
- 배포: `.github/workflows/` — `build-web.yml`(main push → Pages), `release.yml`(main 에 새 버전 → 태그·릴리스·exe·apk 자동). 이 클라우드 세션에서는 **태그 push가 막혀 있음**(브랜치 push만 가능) → 버전 올려 main 에 push 하는 방식으로 릴리스.
- 미리보기: `node tools/build-demo.mjs` → `dist/demo` → claude.ai 아티팩트 slug `91bc8359-75b7-48e0-a9d8-4bd48d714ddb`.

## 3. 테스트 / 검증 방법

```bash
node --test tools/tests/*.test.js                  # 112개 통과 (편집·MusicXML·MuseScore·NWC·글꼴·설정·재생·셸·한글/가사 인식·음원)
python3 -m http.server 8765 -d app                  # 앱 실행
node tools/e2e/shot.mjs http://localhost:8765/ out.png desktop|mobile|tablet|tablet-portrait|android-tablet [script.js]
node tools/musx/check.mjs <Finale 파일/폴더>        # Finale 가져오기 일괄 점검
node tools/mscz/check.mjs <폴더> [--export]         # MuseScore 가져오기(+ 내보내고 다시 읽기). 실제 MuseScore 대조: tools/mscz/README.md (roundtrip.mjs, compare.mjs)
node tools/nwc/check.mjs <폴더> [--export]          # NWC 가져오기(+ 세 가지 형식으로 내보내고 다시 읽기)
node tools/settings/…  ·  tools/fonts/e2e/…        # 설정·글꼴 브라우저 점검 스크립트(shot.mjs 로 실행, 각 README)
node tools/omr/stage_eval.mjs --dir tools/omr/corpus/eval_photo   # 사진 인식 정확도 (eval_clean, base, aug 도)
node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md   # 가사 인식
node tools/audio/eval.mjs …                        # 음원 → 악보 평가 (명령은 tools/audio/README.md)
```
참고: `enigmaToScore(xml, { meta })` 의 meta 는 null 또는 파싱된 NotationMetadata XML 노드여야 함(일반 객체를 넘기면 오류).
릴리스 확인: `https://api.github.com/repos/omokdie/jse/actions/runs`, 체크런 주석(`/check-runs/<job id>/annotations`)으로 경고 확인. APK 서명 지문은 `python3 tools/apkcert.py <apk>`(APK Signing Block v2 인증서 SHA-256)으로 확인 — 정식 키 지문 `55:8D:D9:07:…:10:55`.

## 4. 사진 인식 현황과 남은 일

정확도는 `node tools/omr/stage_eval.mjs --dir tools/omr/corpus/<세트>` (음높이 / 박자 / 마디 수 정확, %). 시험 세트 원칙: 매 차수 시작 때 새 보류 세트를 만들어 잠그고 마지막에만 잰다(이전 보류 세트는 개발용으로 강등).

| 시험 세트 | 3차(v1.0.5) | 4차(v1.0.6) | 5차(v1.0.7) | 6차(v1.0.8) |
|---|---|---|---|---|
| **holdout6 사진 128장** — 처음 쓰는 곡(music21 코퍼스 옛 음악: 몬테베르디 마드리갈·트레첸토 미사 등 + 레쿠오나 · OpenScore 가곡에서 이전에 없던 작곡가 37명), 처음 쓰는 글꼴 Eugene · Punzón · Legato | – | – | 88.0 / 87.1 / 71.1 (v1.0.7로 측정) | **88.3 / 87.1 / 71.1** |
| ─ 스캔 / 평평 / 휜 페이지 / 저해상도 (음높이/박자/마디) | – | – | 95.5/95.0/72.0 · 93.5/93.4/80.4 · 90.9/90.0/71.9 · 66.4/63.9/52.0 | 95.5/95.0/72.0 · 93.5/93.4/80.4 · 90.9/90.0/71.9 · 68.2/63.9/52.0 |
| holdout6 깨끗한 페이지 64장 | – | – | 95.6 / 96.1 / 81.3 | 95.6 / 96.1 / 81.3 |
| holdout5 사진 80장 (5차 보류 → 6차 개발용) — OpenScore 가곡·현악4중주, 글꼴 Finale Broadway | – | 72.8 / 75.2 / 61.3 | 77.3 / 80.9 / 66.3 | 77.6 / 81.0 / 66.3 |
| ─ 스캔 / 평평 / 휜 페이지 / 저해상도 (음높이/박자/마디) | – | 92.6/91.0/75.0 · 79.1/79.3/60.7 · 71.2/73.9/60.0 · 42.3/52.8/50.0 | 92.9/92.3/75.0 · 84.7/87.0/64.3 · 79.7/82.2/65.0 · 44.8/57.2/62.5 | 92.9/92.3/75.0 · 84.7/87.0/64.3 · 79.7/82.2/65.0 · 46.5/57.6/62.5 |
| holdout5 깨끗한 페이지 40장 | – | 92.6 / 90.6 / 82.5 | 92.6 / 91.6 / 82.5 | 92.7 / 91.6 / 82.5 |
| holdout4 사진 80장 | 68.9 / 79.9 / 70.0 | 75.1 / 81.6 / 73.8 | 83.6 / 88.9 / 81.3 | 86.8 / 88.9 / 81.3 |
| holdout4 깨끗한 페이지 40장 | 87.0 / 95.7 / 90.0 | 92.1 / 95.8 / 87.5 | 92.1 / 97.2 / 87.5 | 92.8 / 97.2 / 87.5 |
| holdout3 사진 82장 | 63.5 / 75.6 / 68.3 | 74.0 / 79.7 / 74.4 | 80.2 / 84.9 / 80.5 | 80.3 / 84.9 / 80.5 |
| holdout3 깨끗한 페이지 41장 | 84.1 / 92.3 / 85.4 | 93.0 / 95.5 / 87.8 | 93.2 / 96.0 / 87.8 | 93.2 / 96.0 / 87.8 |
| fresh_photo 56 | 81.1 / 85.1 / 66.1 | 83.7 / 85.7 / 67.9 | 84.5 / 89.2 / 67.9 | 86.1 / 89.2 / 67.9 |
| eval_photo 60 | 83.2 / 85.9 / 53.3 | 84.1 / 84.3 / 56.7 | 87.7 / 86.1 / 55.0 | 88.3 / 86.1 / 53.3 |
| eval_clean 60 / base 40 | 96.5 / 97.8 / 83.3 · 97.1 / 97.1 / 92.5 | 97.5 / 97.8 / 83.3 · 97.6 / 97.1 / 92.5 | 97.5 / 97.7 / 83.3 · 98.1 / 97.6 / 95.0 | (변경 없음) |
| 단계별(holdout5 사진: 음자리표 · 페이지 조표 · 마디선 R/P · 음표머리 · 쉼표 · 임시표) | – | 89.1 · 85.0 · 89.1/99.3 · 91.0 · 91.1 · 48.0 | 93.2 · 87.5 · 91.5/99.6 · 92.0 · 91.1 · 48.1 | 93.2 · 87.5 · 91.5/99.6 · 92.0 · 91.1 · 48.1 |
| 단계별(holdout6 사진, 같은 순서) | – | – | 96.6 · 89.8 · 89.9/99.6 · 94.5 · 93.2 · 65.1 | 96.6 · 90.6 · 89.9/99.6 · 94.5 · 93.2 · 65.1 |
| 한국어 가사 v2 (corpus_ko 깨끗 / 사진형, 글자 정확) | 99.7 / 97.3 % | (변경 없음) | (변경 없음) | (변경 없음) |

3차 주요 변경: 마디선을 찾은 뒤 같은 x의 다른 단 줄기까지 지우던 1차 버그 수정(음표머리 약 11% 손실 → 가장 큰 향상), 마디선 검증 모델 `models/bars.js`, 빔·꼬리 수 모델 `models/rhythm.js` + 마디를 정확히 채우는 길이 해석(`omr/rhythm.js`, 셋잇단 포함), 음표머리에 붙은 임시표, 페이지 전체 조표 투표, 빠진 음자리표는 다른 단에서, 마디 내용과 안 맞는 박자표 교체. 모델 합계 294 KB(glyphs 87 · rhythm 87 · heads 60 · bars 59) + 한글 1,050 KB. 사진 1장 브라우저 워커 3.4–4.4초.
4차 주요 변경(정확도 표의 '4차'): 음자리표 선택(보표 머리의 큰 모양을 분류기로 골라 리허설 마크 상자·위 보표의 높은음자리표를 건너뜀, 조각난/번진 음자리표), 빔이 빽빽한 보표 검출, 스캔의 검은 테두리 처리, 자동 모드에서 엉터리 박자(1/4 등)로 '확신'한 결과 거르기, 박자표 투표, 넓은 샵(조표)·높은 플랫(임시표)·화음 임시표. 모델(294 KB)은 그대로 — 글꼴·저해상도 사진을 늘려 다시 학습한 기호·박자 모델은 개발 세트에서 나아지지 않아 넣지 않음. 사진 1장 브라우저 워커(스캔 화면 전체 흐름) 약 5–6초(v1.0.5와 같은 사진·같은 기계에서 같음). holdout4는 코드를 잠근 뒤 한 번(76.5 / 81.6 / 73.8), 개발 세트에서 찾은 알토 음자리표 회귀를 고친 최종 코드로 한 번 더 쟀음(위 표). 상세: `tools/omr/IMPROVEMENTS.md` Round 4.
5차 주요 변경(표의 '5차'): 흐린 사진에서 피아노 큰보표 짝짓기(괄호가 안 보여 두 보표가 따로 읽히던 문제 — 저해상도 피아노 사진 음높이 15→86% 등), 줄기가 끊긴 음표머리에 줄기 이어 찾기, 오선에 붙은 점, 온마디 쉼표를 온쉼표로(앱 규칙), 붙은 조표 임시표 나누기·오선에 잘린 샵 합치기, 큰보표 아래 보표는 기본 낮은음자리표, 음자리표를 못 읽은 원래 파이프라인 결과는 사진 파이프라인과 비교. 조판기: 넓은 음악 글꼴(Petaluma 등)의 조표 간격을 글리프 폭에 맞춤(앱 기본 글꼴은 그대로). 모델(294 KB) 그대로. 사진 1장 브라우저 워커 약 5–6초. 상세: `tools/omr/IMPROVEMENTS.md` Round 5.

6차 주요 변경(표의 '6차(v1.0.8)', 마지막 학습 차수):
* 새 보류 세트 holdout6을 먼저 만들어 잠갔습니다. 곡은 처음 쓰는 두 코퍼스(music21 코퍼스·bonillamusic)와 OpenScore 가곡의 새 작곡가, 글꼴은 처음 쓰는 3종입니다. 맨 마지막에 v1.0.7과 최종 코드로 한 번씩만 쟀습니다.
* 사진에서 조표를 성분(덩어리)으로 못 찾으면 창(window)으로 다시 읽습니다. 음자리표별 조표 위치와 고른 간격에 놓은 창마다 실제 잉크 상자를 학습된 기호 모델로 분류합니다(`readKeyWindows`). 덩어리진 넓은 샵(Petaluma)과 음자리표에 붙은 조표가 대상이고, holdout4 사진 페이지 조표가 86→95%로 올랐습니다.
* 페이지가 확인하지 않은 창 조표는 되돌립니다. 저해상도 사진의 조표 투표에서는 '못 찾음'의 무게를 줄였습니다.
* 모델(294 KB)은 그대로입니다. 사진 1장 시간도 같습니다: 브라우저 워커 휜 사진 6.96초(v1.0.7 6.93초, 같은 기계·같은 사진), Node 2.4초.
* holdout6에서의 향상은 작습니다(+0.3, 저해상도 +1.8). 이 세트에는 조표 없는 곡이 많기 때문입니다.
* 상세와 다음에 할 일: `tools/omr/IMPROVEMENTS.md` Round 6와 맨 끝 'Where to continue'(유형별 현황, 막는 요인, 데이터·모델·평가 재현 명령, 깨끗한 보류 세트 없음 → 다음엔 holdout7을 새로 만들 것).

## 5. v1.1.0 — 글꼴 · 다른 악보 프로그램 파일 · 설정 (2026-11-18)

**확인한 것 / 확인하지 못한 것**

| 항목 | 확인한 방법과 결과 | 확인하지 못한 것 |
|---|---|---|
| MuseScore 가져오기 | 실제 파일 4,396개(MuseScore 2~4 시험 파일·예제, OpenScore 가곡 863곡): 4,337개 가져옴, 59개는 MuseScore 1.x라 안내 후 거절, 실패 0. 가곡 863곡은 MuseScore가 직접 내보낸 MusicXML과 음표 대조 | — |
| MuseScore 저장 | 내보낸 1,879개 악보를 **실제 MuseScore 3.6.2 / 4.5.2**(이 작업 환경에서 화면 없이 실행)로 열고 다시 MusicXML로 받아 대조: 3.6.2는 1,879개 모두 열림(음표 99.94 %, 가사 99.98 % 일치), 4.5.2는 1,870개 열림(음표 99.97 %, 가사 100 %) | 4.5.2가 "Incomplete measure"로 거절한 9개 — 부분마다 박자가 다른 곡 6개(MusicXML에서 읽은 것), 겹잇단음표 등 2곡의 3개. MuseScore 4 창에서는 경고 후 "무시하고 열기"로 열림(창에서 직접 눌러 보지는 못함) |
| NWC 가져오기 | 실제 파일 794개(1.55~2.75, nwctxt; 한국어 아카펠라 악보 533개) 모두 읽음. 다른 공개 판독기 2종과 대조(한 곳은 1,059,403개 개체 중 320개 차이), 한글 CP949 자동 판별 104개 | — |
| NWC 저장 | `.nwctxt` · `.nwc` 2.75 · `.nwc` 1.75 모두 794개 악보 내보내기 성공, 다시 읽어 대조. 2.75·nwctxt는 공개 판독기 3종(nwc2musicxml, nwc2ly, nwc-viewer)이 읽음 | **NoteWorthy Composer 프로그램 자체로는 열어 보지 못함**(구할 수 없었음). 특히 1.75 형식은 판독기가 해석하지 않는 바이트를 흔한 값으로 채워 "실험적"으로 표시 |
| Sibelius | `.sib`는 비공개·암호화 형식이라 직접 지원 불가 → 열려고 하면 Sibelius에서 MusicXML로 내보내는 방법을 안내, 저장은 "Sibelius용 (MusicXML)" | 실제 Sibelius로 여는 것 |
| MusicXML 가져오기(다른 프로그램의 공통 경로) | 이번에 고침(아래). MuseScore 원본과 대조: 같은 자리·같은 음 99.36 % → 99.93 %, 완전히 같은 곡 753 → 833 / 842 | 부분마다 박자가 다른 곡(MusicXML은 부분별 박자, JSE는 마디별 하나) |
| 글꼴 | 단위 테스트 20개 + 브라우저(대화상자·취소·실행 취소·내려받기·오프라인·PNG/JPG/PDF/SVG에 글꼴 담기). 글꼴을 안 바꾼 악보의 조판 결과는 v1.0.8과 바이트 단위로 같음(42곡). 배포 후 github.io에서 브라우저로 내려받기 확인 | Electron 안의 기기 글꼴 목록(`queryLocalFonts`), 실제 Android 기기(앱 안에서 github.io 글꼴 내려받기 포함) |
| 설정 | 단위 테스트 23개(항목·이전 값 옮기기·Electron 셸·Android 심) + 브라우저(PC·휴대폰·태블릿 화면, 검색, 저장·복원, 가짜 Windows/Android 셸) | **실제 Windows·Android 빌드에서의 동작**(창 위치 기억, 닫기 확인, 화면 켜짐, 전체 화면, 방향, 진동, 뒤로 버튼) — CI 빌드가 통과하는 것까지만 확인. 점검표: `tools/settings/README.md` "What main must check in the CI builds" |

**이번에 함께 고친 공용 코드** (다른 프로그램 파일을 대량으로 대조하다 드러난 것, 테스트 `musicxml.test.js` · `playback.test.js`)
* MusicXML 가져오기: 보표를 넘나드는 잇단음표에서 빈자리를 보통 쉼표로 채워 뒤 음표가 밀리던 문제, 잇단음표가 "열린 채" 남아 보통 음표에 6:4 등이 붙던 문제, 한 보표에 XML 성부가 5개 이상일 때 넷째 성부에 몰아넣던 문제, `sf`·`sffz`·`rf` 등 셈여림과 코드 기호의 변화음(♭5 등)이 빠지던 문제.
* 8va/8vb 선 아래 음표: ScoreDoc은 **적힌 음높이**로 저장(재생·MIDI·NWC 저장이 옥타브를 더함). MusicXML은 실제 음높이로 저장하므로 가져올 때·내보낼 때 변환. ⚠ v1.0.8 이하에서 8va가 있는 MusicXML을 가져와 저장한 `.ssnap`은 그 구간이 한 옥타브 높게 저장돼 있음(화면은 전과 같고 재생이 한 옥타브 더 높아짐) → 원본 MusicXML을 다시 가져오면 됨.
* 재생·MIDI: 못갖춘마디를 온 마디 길이로 재생해 쉬는 시간이 생기던 문제(이제 가장 긴 성부 길이만큼), 메트로놈은 마디 기준으로 다시 계산(`pb.clicks`), 이조 악기는 항상 적힌 음 + 이조 값으로 소리(전에는 MusicXML로 가져온 이조 악기가 이조 없이 재생됨).
* 숨긴 음표·쉼표(`hidden`): 화면에서는 흐리게, **PDF·PNG·JPG·SVG·인쇄에서는 안 보이게**(전에는 내보낸 파일에도 흐리게 찍힘).
* Android 파일 고르기: Android가 MIME을 모르는 확장자(.ssnap·.mscz·.nwc 등)가 섞인 목록은 "모든 파일"로 엶(`native.js pickerAccept`) — 그렇지 않으면 그런 파일이 흐리게 표시돼 고를 수 없음(실기기 확인은 못 함).

**배포 관련 결정**
* `release.json`의 `androidMinNative`를 1.1.0으로 올림: Android 네이티브 코드(설정용 플러그인 메서드, 진동 권한, 파일 연결)가 바뀌어, 이전 APK 사용자는 앱이 새 APK 설치를 안내함(같은 서명 키라 덮어 설치).
* Windows: MuseScore·NWC 파일은 **연결 프로그램 목록에만** JSE를 올리고 기본 프로그램은 바꾸지 않음(`electron/build/installer.nsh`). `.ssnap`·`.musx`는 전과 같이 JSE로 열림.
* JSE 글꼴 7종(SIL OFL 1.1)은 원본 그대로(이름·내용 수정 없이 WOFF 포장만) `app/fonts/web/`에 두고 Pages에서만 제공. 설치 파일·APK 크기는 그대로.

**v1.1.0 배포 확인** (커밋 `a8e0d83`): Actions의 Pages·Release 워크플로 모두 성공(Windows NSIS — `installer.nsh` 포함 — 와 Android 플러그인 컴파일 통과). 릴리스 자산 `JSE-Setup-1.1.0.exe` 84.8 MB · `JSE-1.1.0.apk` 6.0 MB · `latest.yml` · blockmap. APK 서명 지문 `55:8D:D9:07:…:10:55`(정식 키), APK 안에 글꼴 파일 없음·진동 권한과 `.mscz`/`.nwc` 연결 있음. Pages `version.json` = 1.1.0(`android.minNative` 1.1.0, 웹 묶음 3.1 MB), `fonts/web/manifest.json`과 글꼴 파일이 CORS 허용(`access-control-allow-origin: *`)으로 제공되고 SHA-256이 저장소와 같음. 미리보기 아티팩트도 1.1.0으로 다시 게시. 배포된 웹앱(https://omokdie.github.io/jse/)을 Chromium으로 직접 열어 확인(PC·휴대폰 화면, 2026-11-18): 버전 1.1.0, 설정 창(웹 앱 항목 포함), JSE 글꼴(나눔명조)을 내려받아 적용, `.mscz`(MuseScore 3·4)·`.nwc` 파일 열기와 같은 형식으로 다시 저장 — 콘솔 오류·실패한 요청 없음.

**알려진 한계 / 다음에 할 만한 것**
* NWC: 실제 NoteWorthy Composer(특히 1.75)에서 열어 보기. 셋잇단 외 잇단음표·8va 선·3성부 이상은 근사.
* MuseScore 4가 거절하는 9개 유형(위 표): 길이가 딱 맞지 않는 성부를 MuseScore 4가 받아들이는 방식으로 채우기.
* MusicXML: 부분마다 다른 박자, 5성부 이상이 동시에 울리는 보표.
* 조판: 2성부일 때 기둥 방향을 성부 번호로만 정함(`ev.stem` 무시), 보표를 넘는 음표(크로스 스태프)는 원래 보표에 표시.
* MIDI 가져오기(파일 열기에서 `.mid`는 아직 안내만), Dorico·Encore·Guitar Pro 등은 MusicXML 경유 안내만.
* 설정: 묶음 버튼(`ui/flyout.js`)에는 길게 누르기 시간·진동 설정이 적용되지 않음. 설명 문구는 한국어만.
* 2026-11-17 작업 중 MuseScore 담당 보조 작업이 사용량 한도로 중단됨 — 코드·테스트·README는 끝난 상태였고, 최종 대조는 본 세션이 다시 실행해 위 숫자를 얻음.

남은 일(우선순위):
1. 사진 인식(목표 90%; 6차 후 holdout6 사진 음높이 88.3%·박자 87.1%, 스캔 95.5 · 평평 93.5 · 휜 90.9 · 저해상도 68.2%, 더 어려운 holdout5 사진 77.6%). 학습은 6차로 멈춤 — 이어서 한다면 `tools/omr/IMPROVEMENTS.md` 'Where to continue'부터. 남은 순서: 저해상도 사진(잃은 음의 절반, 음높이 45%) → 휜/평평 사진의 마디 안 임시표(48%)·화음 → 조표(87%) → 음자리표 → Leland 글꼴(holdout5 41%) → 16/32분·셋잇단·마디선. 상세: `tools/omr/IMPROVEMENTS.md`.
2. 가사: 영어 가사(단어·하이픈), 오선 위 가사, 10px 이하 가는 글씨(이진화에서 사라짐), 줄 단위 언어 모델.
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고). 남은 Node 20 액션 경고(android-actions/setup-android, gradle/actions, softprops/action-gh-release, Pages 액션).
4. Finale 가져오기: 2차에서 표현 텍스트 연결 버그(textIDKey → textBlock → textID) 수정, 여러 보표에 같은 템포·표현 중복 제거, 보표 지정 표현은 그 보표 음표에. 남은 것: 빈 마디 보표의 표현 위치.
5. 음원 → 악보: 실제 녹음+정렬된 악보로 평가, 빠르기 절반/두 배 판단 개선(다운비트 단서, 박자 두드리기), 보표당 두 번째 성부(지속음), 마이크 녹음, 멜로디만 있는 입력의 코드 추정.
6. 세부: 운지 번호 전용 렌더링, 복잡한 반복 재생, MIDI 가져오기, 가사 아래 이음줄 충돌 회피.
7. v1.1.0의 남은 것: §5 "알려진 한계" 목록, 실제 Windows·Android 기기에서 설정 항목 점검.
