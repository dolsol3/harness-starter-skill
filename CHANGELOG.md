# Changelog

이 프로젝트의 눈에 띄는 변경을 적는다.
모양은 [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)을, 번호는 [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)을 따른다.

## [Unreleased]

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
