# Changelog

이 프로젝트의 눈에 띄는 변경을 적는다.
모양은 [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)을, 번호는 [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)을 따른다.

## [Unreleased]

## [0.8.1] - 2026-10-26

### Added

- 공용 물레방아(`node harness/mullebanga.mjs --도구 codex|gemini|claude`): Codex·Antigravity·Claude 어느 도구에서든 진행중 작업을 `할 일 적기`부터 `올림`까지 같은 순서로 돌린다(담당은 부른 도구가 기본, 단계마다 `단계모델.<단계>.도구`로 바꿈, 읽기 전용은 도구가 아니라 역할로 정함). 설치기가 일감 목록과 함께 여섯 파일을 깔고, 이미 깐 프로젝트는 `install.mjs --upgrade`로 받는다. 클로드판(`.claude/workflows/mullebanga.js`)은 그대로이고 `--upgrade`가 바꾸지 않는다. 쓰는 법은 `guide/usage.md`, 한계는 `guide/limits.md`에 있다.
- WorkBuddy AI(딥시크) 지원: 설치기에 `workbuddy-hook` 장치를 더해 `.codebuddy/settings.json`에 Claude Code와 같은 훅(고친 직후 알림·쓰기 전 막기·멈출 때 설명)을 깔고, `.codebuddy/skills/lean-review/`에도 간결함 리뷰를 복사한다. `upgrade.mjs`는 다섯째 전역 스킬 폴더 `~/.workbuddy-ai/skills/harness-starter`(macOS·Windows 공통)를 함께 갱신한다. 워크버디 앱은 프로젝트 루트 `AGENTS.md`를 읽고, 단계는 앱 내장 `Agent` 도구(`.codebuddy/agents/`, Claude Code와 같은 파일)로 돌리며 로컬에 없는 클로드 모델 이름은 앱에 선택된 `deepseek-v4.1-flash` 등으로 대체한다. 앱에서 훅·스킬이 실제로 읽히는지는 확인하지 못했다(`guide/limits.md`).

### Changed

- `기다리기` 기본 대기 시간을 55분으로 바꾸고 `--횟수 1~26`을 더했다. 메인이 멈춰 있을 때 질문이 없어도 기다리며 55분마다 프롬프트 캐시를 유지하고, 하루 최대 26회 뒤에는 다시 걸지 않는다.
- 원칙·역할 파일·물레방아·안내 문서에서 `명세`·`장부` 등 옛 용어와 괄호 병기를 걷어내고, 하위 호환 설정·명령 별칭과 용어집 대조표만 남겼다.
- 11개 단계 `단계모델` 기본값을 낮췄다(T-155): `조사` `sonnet` `medium` + `보조모델` `gemini-4-argon-medium`, `쪼개기` `opus` `high`, `할일적기`·`만들기`·`고치기` `sonnet` `medium`, `맞춰보기`·`번갈아보기` `opus` `medium`, `돌려보기`·`고르기`·`한일적기` `haiku` `medium`, `올림` `sonnet` `low`. `번갈아보기` 바깥 검토 기본은 `gemini`(`gemini-4-argon-medium`), 폴백은 `codex`(`gpt-6.1-sol` `medium`)다. 근거는 2026-10-25 적대적 리뷰 24회 재시험과 `medium` 실전 검증이다.

### Fixed

- 저장소 루트에 `.gitattributes`(`* text=auto eol=lf`)를 더했다. `core.autocrlf=true`인 Windows에서도 글 파일이 LF로 꺼내져 시험과 설치 파일의 줄바꿈이 맞는다. 공개본에도 들어가고, 이미 꺼낸 폴더는 다시 꺼내야 바뀐다.
- Windows `cmd.exe`에서 `$(git rev-parse --show-toplevel)` 치환이 되지 않던 문제를 고쳐 Codex 훅(`.codex/hooks.json`)은 `node harness/check.mjs --hook`·`node harness/guard.mjs --hook`, Antigravity 훅(`.agents/hooks.json`)은 `node ../harness/check.mjs --hook`·`node ../harness/guard.mjs --hook` 상대 경로 명령으로 깐다. `install.mjs --upgrade`는 두 파일의 옛 `$(git rev-parse --show-toplevel)` 훅 명령을 새 명령으로 바꾼다.

## [0.8.0] - 2026-10-23

### Added

- 설치기(`install.mjs`)의 `--main=<메인 도구 이름>`: 이 컴퓨터의 PATH에서 `claude`·`codex`·`agy`를 찾아, 새 `harness/config.json`을 만들 때 `일감목록`(`동시상한`, `기본맡길곳`)을 적는다(메인 3, 같이 쓸 도구 1씩, `agy`는 `gemini`). 설치 절차(`SKILL.md`)는 도구를 묻지 않고 설치하는 AI가 `--main`을 준다.
- `앞글자 <영어 대문자>`: 일감 목록(장부)의 작업 번호 앞 글자를 정한다(`앞글자 W` 뒤에는 `W-1`, `W-2`…). 정하면 그 글자의 가장 큰 번호 다음부터 세고, 정하지 않은 장부(옛 장부 포함)는 그대로 `T-`로 센다. 앞 글자는 장부에만 적혀 git에 올라가지 않으므로 컴퓨터마다 장부를 따로 쓰면서 `docs/tasks/`를 함께 쓸 때 명세 번호가 겹치지 않게 한다.
- 번갈아 보기 바깥 검토 도구로 `claude`를 부르는 법(`guide/usage.md`): 메인이 Codex·제미나이·그 밖의 도구인 사람이 손으로 넘길 때 쓰는 마지막 후보이며, 버릴 복사본에서 Claude 자체 샌드박스로 쓰기를 묶는다.

### Changed

- 번갈아 보기 바깥 검토 도구 Codex가 읽기 전용(`-s read-only`)으로 읽기만 하던 것을, 원격을 지운 버릴 복사본·임시 HOME 안에서 `-s workspace-write`로 명령을 돌려 끝 기준마다 깨뜨릴 입력·환경·순서를 재현하는 깨뜨려 보기로 바꿨다(뒤에서 돌리고 `done` 파일을 기다리며 최대 약 27분, 시간 초과면 자식 프로세스부터 멈춘다). 한계는 `guide/limits.md`에 있다.
- 같은 깨뜨려 보기를 제미나이 폴백도 한다. 새 제미나이 역할 파일 `.agents/agents/breaker.md`(설치기가 깔고 `--upgrade`가 바꾼다)를 쓰고, 맥에서는 `sandbox-exec`로 복사본·임시 폴더 밖 쓰기를 막되 진짜 홈의 `agentapi` 한 파일 쓰기는 열고 부르기 전 복사본과 끝난 뒤 내용이 같은지 비교한다. 맥이 아니거나 `sandbox-exec`·`breaker.md`가 없으면 기존 읽기 전용 경로(`--agent readonly`)로 돈다. 한계는 `guide/limits.md`에 있다.
- 이미 깐 프로젝트가 할 일: `install.mjs --upgrade`는 `.claude/workflows/mullebanga.js`와 `.claude/agents/`를 바꾸지 않으므로, 이 판의 `templates/workflows/mullebanga.js`·`templates/agents/planner.md`·`templates/agents/implementer.md`를 사본과 비교해 손으로 맞춰야 이 판의 깨뜨려 보기(Changed), `claude` 후보(Added), 물레방아 고침·도구 고르기(Fixed)가 반영된다.

### Fixed

- 물레방아가 단계 결과를 받는 형식(`agent()`의 결과 모양)의 칸 이름이 한글 `단계모델`이어서 API가 한글 칸 이름을 거절해(영문·숫자·`_.-`만 받음) 첫 단계에서 멈췄다. 칸 이름을 `agents`로 바꾸고 기획 담당 안내문(`templates/agents/planner.md`)도 `agents` 칸으로 돌려주게 맞췄다. 0.7.0을 깐 프로젝트는 이 고침이 없어 물레방아가 돌지 않았다.
- 물레방아 `번갈아 보기`의 바깥 도구 고르기: 기본 검토 도구(`codex`)를 먼저 고르던 규칙 때문에 메인이 Codex이면 `올림 --검토 codex`가 거절되고, `agy`만 있는 컴퓨터는 없는 Codex를 한 번 부른 뒤 폴백했다. 이제 `검토도구`, `폴백도구` 순서 중 작성 도구(맡길곳)가 아니고 `동시상한`에 있는 첫 도구를 고르고, 없으면 부르지 않는다.

## [0.7.0] - 2026-10-22

### Added

- `반영 Q-N --커밋 <해시> --설명 "…"`: 확인 질문의 `고칠것`을 답대로 고친 뒤 `반영함`으로 닫아 질문 페이지의 '고칠 것'에서 빼고 '답한 것'에 `반영됨: …`으로 옮긴다.
- `harness/config.json`의 `단계모델`(영문 별칭 `agents`): 물레방아와 역할 에이전트의 11개 단계(`조사`, `쪼개기`, `할일적기`, `맞춰보기`, `만들기`, `돌려보기`, `번갈아보기`, `고치기`, `한일적기`, `고르기`, `올림`)별 기본 모델·추론 깊이(`모델`, `깊이`), 조사 보조 모델(`보조모델`)과 병렬 분담 수(`최대병렬`), 번갈아 보기 바깥 검토 도구(`검토도구`)와 폴백(`폴백도구`, `폴백모델`)을 설정 파일에서 바꿀 수 있다.
- 처음 쓰는 사람을 위한 쉬운 우리말 용어집 표 3개(일감 목록 명령·옵션·칸, 물레방아·작업 흐름 11단계, 네 담당 호칭)와 단계별 기본 모델·설정 변경 안내(`guide/usage.md`).

### Changed

- 쉬운 우리말 용어·담당 호칭·설정 키 기본화(옛 이름·영문 키는 별칭으로 그대로 호환): `작업 장부 → 일감 목록`, `준비 → 바로할일`, `반려 → 다시하기`, `--선행 → --먼저할일`, `--영역 → --고칠곳`, `--배정 → --맡길곳`, `명세 → 할 일 적기`, `대조 → 맞춰보기`, `구현 → 만들기`, `검사 → 돌려보기`, `교차 리뷰 → 번갈아 보기`, `기록 옮기기 → 한 일 적기`, `구현 담당 → 만들기 담당`, `리뷰어 → 살피기 담당`, 설정 키 `backlog → 일감목록`, `patch → 덧대기`, `protect → 지키는파일`.
- 6단계×7모델 시험 결과에 따라 단계별 기본 모델을 배정했다(`조사`: 본체 `sonnet high` + 보조 `gemini-4-argon-high` 최대 4개 병렬·코덱스 제외, `쪼개기`: `opus high`, `할 일 적기`: `sonnet high`, `맞춰보기`: `opus high`, `만들기`·`돌려보기`·`고르기`·`올림`·`고치기`: `sonnet high`, `번갈아 보기`: 살피기 담당 `opus high` + 바깥 검토 `codex` 기본 및 코덱스 토큰 부족 시 `gemini-4-argon-high` 자동 폴백, `한 일 적기`: `haiku medium`).

## [0.6.0] - 2026-10-19

### Added

- 공식 문서 길잡이: 설치할 때 기술마다 `docs/official-docs/<기술>.md`에 "주제 → 공식 문서 주소"를 적고(사용자 승인 뒤), 원칙 한 줄이 처음 쓰는 기능·버전이 바뀐 곳·처음 보는 오류·확실하지 않은 곳에서 맞는 줄만 열게 한다.

## [0.5.0] - 2026-10-18

### Added

- 요금제에 Fable이 있으면 조사 담당 머리말에 `model: fable`을 더할 수 있다는 안내(`guide/usage.md`). 없는 모델을 적으면 그 단계가 오류로 멈추고, 이 스킬을 만들며 돌린 시험(2026-10-18)에서는 Fable이 Opus보다 낫다는 근거가 없었다.

### Changed

- 물레방아의 작업 고르기·검사·올림 단계가 sonnet(생각 깊이 high)으로 돈다. 다른 단계는 지금처럼 메인 모델로 돈다.

## [0.4.0] - 2026-10-16

### Added

- 새 답 알림: 사람이 답했는데 메인이 아직 `질문목록`으로 읽지 않은 답이 있으면 장부 명령 끝에 `새 답 N개(…)` 한 줄을 보이고, 멈출 때 훅도 진행중 작업이 없어도 알린다. Claude Code에서는 답이 오면 끝나는 `기다리기`를 뒤에서 걸어 둔다.

### Changed

- 한계는 `guide/limits.md`로, 자세한 쓰는 법은 `guide/usage.md`로 옮기고 README를 짧게 다시 썼다. 업그레이드와 손 복사 명령이 전역 스킬 폴더에 `guide/`도 복사한다.

## [0.3.0] - 2026-10-16

### Added

- 고친 직후 그 파일 하나에 종류별 명령(린트·포맷, `harness/config.json`의 `afterEdit`)을 돌린다. 설치할 때 이 명령과 커밋 때 전체 검사(pre-commit 한 줄)를 넣을지 묻는다.
- 막는 훅이 `.env`·잠금 파일·`.git` 아래 파일의 편집을 거절한다(읽기는 된다). 목록은 `harness/config.json`의 `protect`로 바꾼다.
- 버전 번호와 이 CHANGELOG. 설치기가 `--apply`일 때 깐 버전을 `harness/VERSION`에, 깐 프로젝트를 `~/.harness-starter/projects.json`(명부)에 적는다.
- `scripts/upgrade.mjs`: git으로 받은 폴더에서 새 버전을 받고(`git pull --ff-only`), 바뀐 것(이 CHANGELOG의 절)을 보이고, 승인받아 전역 스킬 네 곳을 백업한 뒤 바꾸고, 명부의 프로젝트를 하나씩 물어 올린다(`--미리보기`·`--예`·`--프로젝트`·`--등록`).
- `scripts/version-notice.mjs`: 스킬을 부를 때 공개본의 버전 번호만 하루 한 번 읽어 새 버전을 한 줄로 알린다. 끄려면 `HARNESS_STARTER_NO_UPDATE_CHECK=1`.
- 질문 페이지 늘 켜 두기: `켜두기`가 페이지를 떨어진 프로세스로 띄워 명령이 끝나도 돌게 하고 `끄기`가 끈다. 켜 둔 페이지가 꺼져 있으면 다음 장부 명령이 다시 켜고, `허락`·`확인`은 끝에 링크 줄을 보인다.

### Changed

- 질문 페이지는 사람이 아니라 AI가 켜 둔다(`답`은 그대로 사람의 몫). 토큰은 `harness/serve.json`에 두고 계속 써서 링크가 바뀌지 않는다(서버 상태·로그는 git에서 뺀다).
