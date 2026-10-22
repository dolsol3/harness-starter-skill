# harness-starter

AI와 개발하면 코드가 점점 커지고, 읽기 어려워지고, 예외에 예외를 덧대기 쉽다.
harness-starter는 이것을 막는 장치("간결함 하네스")를 프로젝트에 씌우는 스킬이다.
일감 목록(작업 장부), 질문 페이지, 물레방아로 AI가 사람 없이 오래 일하도록 돕는다.
Claude Code, Codex, Antigravity, OpenClaw에서 쓴다.

일감 목록(장부) 명령은 AI가 쓴다. 사람이 하는 일은 설치를 승인하고 질문 페이지에 답하는 것뿐이다.

## 빠른 시작

준비물: git, Node 22.20 이상.

1. 스킬을 받는다.

   ```sh
   git clone https://github.com/dolsol3/harness-starter-skill.git
   ```

2. 받은 폴더에서 전역 스킬 네 곳에 깐다. 물으면 y를 누른다.

   ```sh
   cd harness-starter-skill
   node scripts/upgrade.mjs
   ```

3. 하네스를 씌울 프로젝트에서 AI에게 "하네스 씌워줘"라고 한다.
   스킬이 프로젝트를 살피고, 몇 가지를 묻고, 미리보기를 보여 준 뒤 승인을 받아 깐다.

새 버전은 같은 폴더에서 같은 명령(`node scripts/upgrade.mjs`)으로 받는다. AI에게 "업그레이드 해 줘"라고 해도 된다.

## 전역 스킬 위치

`upgrade.mjs`가 아래 네 곳에 스킬을 복사한다.

| 도구 | 전역 스킬 위치 |
|---|---|
| Claude Code | `~/.claude/skills/harness-starter` |
| Codex, OpenClaw | `~/.agents/skills/harness-starter` (둘 다 이 위치를 읽는다) |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/harness-starter` |
| Antigravity IDE | `~/.gemini/config/skills/harness-starter` |

## 설치되는 장치

| 장치 | 하는 일 |
|---|---|
| 간결함 원칙 | AI가 지킬 규칙(요청받은 것만 바꾸기, 예외 삼키지 않기 등)을 프로젝트 지침에 적는다. |
| git 훅 | 너무 긴 줄, 예외를 삼키는 코드, 너무 큰 커밋이 있으면 커밋을 막는다. |
| 고친 직후 알림 훅 | AI가 파일을 고치자마자 같은 검사를 돌려 문제를 바로 알려 준다. |
| 간결함 리뷰 | 작업을 끝내기 전에 지울 수 있는 코드가 남았는지 살피는 절차다. |
| 일감 목록 (작업 장부) | 할 일, 진행 상태, 사람에게 묻는 질문을 한곳에 적고 질문 페이지로 보여 준다. |
| 막는 훅 | 일감 목록(장부)에 연 작업 없이 코드를 고치거나 검사 설정을 바꾸려 하면 거절한다. |
| 멈출 때 설명 훅 | 일이 남았는데 AI가 멈추려 하면 왜 멈추는지 한 번 설명하게 한다. |
| 제미나이 읽기 전용 역할 | 제미나이를 파일을 고치지 못하는 검토·조사 역할로 부를 수 있게 한다. |

## 문서 지도

- [guide/usage.md](guide/usage.md): 자세한 쓰는 법. 처음 쓰는 사람을 위한 쉬운 우리말 용어집, 단계별 기본 모델·추론 깊이(`단계모델`)와 `harness/config.json`에서 모델·추론 깊이·병렬 수·검토 도구를 바꾸는 법, 일감 목록 명령과 일 나누기, 조사 담당과 물레방아, 막는 훅, 업그레이드 옵션, 손 복사, 설치 스크립트 직접 돌리기, 개발 시험.
- [guide/limits.md](guide/limits.md): 안 되는 것과 아직 확인하지 못한 것.
- [CHANGELOG.md](CHANGELOG.md): 버전마다 바뀐 것.
- [Releases](https://github.com/dolsol3/harness-starter-skill/releases): 내놓은 버전.
- [SKILL.md](SKILL.md): AI가 설치할 때 따르는 절차.

## 문의

질문과 버그는 [Issues](https://github.com/dolsol3/harness-starter-skill/issues)에 남긴다.

## 라이선스

MIT. [LICENSE](LICENSE)를 본다.
