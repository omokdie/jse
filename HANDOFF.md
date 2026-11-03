# JSE — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-04 00:00 KST. 다음 모델/세션은 이 문서 → `README.md` → `SPEC.md` → `RELEASING.md` 순서로 읽으면 됩니다.
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
| 18 | 여러 사진으로 학습해 인식 정확도 개선 | 🔶 개선됨(사진 52→61%), 목표 80%에는 미달 (§4) |
| 19 | GitHub 설정 | ✅ 저장소·Pages·Actions, 릴리스 v1.0.0~v1.0.2 / 🔶 Android 서명 키 Secrets가 아직 빌드에 전달 안 됨(사용자 확인 중 — 고쳐지면 다음 main push 때 APK만 자동 재빌드) |

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

| 시험 세트 | 음높이 / 박자 / 마디 수 정확 |
|---|---|
| 깨끗한 악보 40장 | 92.0 / 93.9 / 85.0 % |
| 실제 같은 사진 60장 | 60.9 / 61.6 / 35.0 % (이전 52.0 / 47.6 / 10.0) |
| 종류별(음높이/박자) | 스캔 90.7/90.1 · 평평한 사진 72.1/65.8 · 휜 페이지 51.0/64.6 · 저해상도 28.0/29.1 |
| 한국어 가사 (깨끗 / 사진형) | 글자 99.4 % / 95.9 %, 음표에 맞게 붙음 99.2 % / 94.0 % (음표를 찾은 경우) |

남은 일(우선순위):
1. 사진 인식: 쉼표·임시표·음자리표·숫자 분류 모델 학습(배선은 되어 있음, `classifiers.js`), 학습 페이지 160장 전부 사용, 저해상도 사진, 마디선 오검출, 조표 기호 붙음, 박자표, 셋잇단·꼬리 리듬. 음악 글꼴이 FreeSerif 하나뿐이라 실제 악보 글꼴로 일반화 위험 → 여러 글꼴로 학습 데이터 생성. 상세: `tools/omr/IMPROVEMENTS.md`.
2. 가사: 영어 가사(단어·하이픈), 오선 위 가사, 작은 글씨(10–12px).
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고). 액션 버전(Node 20 deprecated 경고: checkout/setup-node/setup-java/upload-artifact 새 주 버전으로).
4. 세부: 운지 번호 전용 렌더링, 복잡한 반복 재생, MIDI 가져오기, 가사 아래 이음줄 충돌 회피.
