# 작은 모델 시험

저장소 루트에서 미리보기부터 만든다. 기본 동작은 모델 호출·파일 쓰기가 없다.

```sh
node scripts/model-exam.mjs --out /tmp/model-exam-results
node scripts/model-exam.mjs --out /tmp/model-exam-results --run
```

실제 호출은 메인이 후보의 지원 모델 ID와 추론 조합을 확인한 다음 한다. 기본 후보는
Claude 3·Codex 9(Astra medium 포함)·Gemini 4의 비교 계획이다. Carbon은 넣지 않았다.
이 목록은 설치된 CLI에서의 지원 여부를 보장하지 않는다. 이번 구현 검증은 가짜 CLI와 미리보기만 한다.
미리보기에서 후보, 신규 호출 수, maxCalls 16, 입력 글자 수, timeout, 도구별 동시상한 5·5·5를 확인한다.
입력 글자 예산은 프롬프트와 JSON 스키마 문자열 길이의 합이며 CLI가 추가하는 컨텍스트는 포함하지 않는다.
설정은 시험 전용이며 프로젝트의 물레방아 설정이나 전역 스킬을 바꾸지 않는다.

`summary.json`에서 점수(4점), 문제별 정확성·누락·헛지적·완전 일치(`exact`), 소요 시간, 실패 이유, 재사용을 본다.
각 해시의 `.json`은 완료 캐시, `.raw.json`은 callTool이 반환한 답안 또는 실패 정보다.
callTool이 stdout 전체와 usage를 반환하지 않으므로 원시 스트림은 저장할 수 없고 사용량은 미측정이다.
출력 폴더는 git 저장소 밖이어야 한다. 결과를 커밋하지 않는다.

동일 명령을 반복하면 완료 결과는 호출 없이 재사용한다. 실패는 다음 실행의 신규 호출 대상이며 자동 재시도하지 않는다.
후보·모델·추론·문제·프롬프트·스키마·채점 코드/버전이 달라지면 새 해시로 호출한다.
기본 Claude 요청은 고정 ID `claude-sonnet-5-5`·`claude-opus-5-5`·`claude-haiku-5-5`다.
설정의 `model`은 요청 모델이며, 성공 응답만으로 실제 처리 모델을 확인했다고 볼 수 없다.
현재 callTool은 실제 처리 모델 필드를 반환하지 않아 이번 결과에서는 확인하지 못한다.
별칭을 선택했다면 해석 대상 모델이 바뀔 때 후보 `id` 또는 `model`을 바꾸거나,
`promptSuffix`에 새 해석 모델/확인 날짜를 적어 캐시를 명시적으로 무효화한다.
예: `"promptSuffix":"별칭 해석 모델 변경: 확인한 모델 ID, 2026-11-03"`. 미리보기에서 신규 호출 수를 확인한다.
필요한 역할의 후보만 설정 사본에 남겨 추가 비교하고, 유력 조합은 전체 물레방아로 확인한다.

후보 추가는 `scripts/model-exam.json`의 사본에
`{"id":"new-medium","tool":"codex","model":"실제-지원-ID","effort":"medium"}`을 더하고
`--config /tmp/exam-config.json`으로 지정한다. 모델·추론 허용 목록은 코드에 고정하지 않는다.
`maxCalls`는 재사용을 뺀 신규 호출 수다. `promptSuffix`로 추가 지시를 주면 재사용 키도 바뀐다.

각 후보는 정답과 채점 코드가 없는 4문제 JSON 묶음을 한 번 받는다. 코드 수정은 진행 중 Promise 동일성을 지키는 한 줄의 공백 정규화 문자열 비교다.
후속 승인 변경·자료 범위/usage·Promise 동일성·검사/삭제 시점을 묻는다.
patch와 review는 같은 동일성 원리를 공유하므로 독립 구현 능력 두 건으로 보지 않는다.
이는 작은 조건 판별 시험이며 웹 조사나 전체 저장소 구현 능력의 입증이 아니다.
짧은 JSON 요청과 스키마는 엄격한 출력 토큰 cap이 아니다. 시간·호출·입력 제한도 실제 토큰 소모를 보장하지 않는다.
구독 소모량·절약률·성능 우열을 측정 없이 주장하지 않는다.
실행 위치만 원격 없는 임시 git 폴더로 분리하고 HOME·USERPROFILE·CODEX_HOME·CLAUDE_CONFIG_DIR 등 기존 인증 환경은 보존한다.
Gemini는 임시 cwd에 기존 readonly 역할을 준비·확인하고 `--agent readonly`와 `HARNESS_READ_ONLY=1`을 쓴다.
Codex에는 `HARNESS_READ_ONLY`를 전달하지 않고 자체 read-only 모드를 쓴다.
호출 전후 임시 cwd의 파일 내용·권한·목록(역할·git 내부 포함)을 비교하며 예상하지 않은 변경은 실패로 기록한 뒤 정리한다.
callTool의 읽기 전용 모드와 지시를 사용하며, 운영체제 전체를 격리하는 보안 샌드박스를 추가하지는 않는다.

# 실전 10과제 시험 자산

T-175는 시험 자산과 채점기를 준비한다. 모델 호출, 반복 시험, 실제 사용량 수집,
HTML 비교표, 난도 보정과 모델 배정은 T-176이다. 쉬움 2·중간 3·어려움 3·초고난도 2는
설계 분류이며 실제 성능을 뜻하지 않는다. 기존 `model-exam-cases.mjs`와 runner는 유지했다.

## 준비와 채점

```js
import { cases, prepareCase } from './scripts/model-exam-fixtures.mjs';
import { gradeCase } from './scripts/model-exam-grade.mjs';

const prepared = prepareCase('Q4', candidateDirectory);
// prepared.prompt/schema/write/checks를 후보 실행기에 전달한다.
// 후보 실행이 끝난 뒤에만 채점기를 호출한다.
const result = gradeCase('Q4', {
  cwd: candidateDirectory,
  answer: candidateAnswer,
  evidence: observedEvidence,
});
```

`cases`의 각 항목은 `id/title/difficulty/stage/mode/timeoutSeconds`다.
`prepareCase(id, cwd, options)`는 빈 폴더(빈 git 저장소 포함)에 공개 파일만 쓴다.
git 이력과 원본 저장소를 복사하지 않는다. 후보에는 반환된 prompt/schema와 그 폴더만 준다.
설치된 하네스·역할 지침은 Q10의 공개 실행 자산이다.

`gradeCase`는 항상 동기 호출이다. `score/maxScore/criteria/stageScores/stageMaxScores/missing/falsePositives/gates`와
숨은 실행 결과 `reports`, 배정 가능 여부 `eligible`을 반환한다.
criterion별 배점을 합하며 시험 개수를 점수로 환산하지 않는다.
Q10 전체 연결 점수를 모든 단계에 복제하지 않는다. stageMaxScores는 해당 단계 기준 배점만 합한다.
Q1/Q6 요구·끝 기준은 할일적기, 출처·승인 일치는 맞춰보기, Q6 의존은 쪼개기로 나눈다.
Q2 actualChecks는 실행 여부 지표이며 자동 검사 속도나 명령 실행 자체를 모델 판단 품질로 해석하지 않는다.

구현 채점은 후보가 종료된 뒤 허용된 제출 모듈만 새 임시 폴더에 복사하고 독립 Node 프로세스로 실행한다.
공개 시험을 복사하거나 채점에 사용하지 않는다. 각 숨은 실행 제한은 5초이고 결과에
종료 코드·시간 초과 등 오류 코드·stderr 끝부분을 남긴다. 임시 채점 폴더는 정리한다.
이는 적대적인 JavaScript에 대한 OS 보안 샌드박스가 아니다. T-176은 후보와 채점 프로세스의
파일 접근을 격리하고, 채점 자산 경로를 후보에게 제공하지 않아야 한다.
같은 OS에서 경로만 감추는 것을 읽기 격리로 간주하지 않는다.

## 실행 증거와 의미 채점 계약

후보 답변은 `{summary: string}`이다. 구현 답변의 코드 문자열로 파일 제출을 대신할 수 없다.
계획·조사·리뷰는 자연어 의미 판단이 필요하다. 단어 검색이나 정답 문자열 일치로 이를
자동 채점하는 대신, **후보와 분리된 채점자**가 아래 기준에 따라 판정한다.
이 판정까지 자동화하는 실행기는 T-176에서 연결한다. 미판정 기준은 0점·missing이다.
따라서 준비된 API만 호출해서 서술 답안의 의미가 자동 검증되었다고 발표하면 안 된다.

`evidence`는 실행기가 수집하거나 독립 채점자가 작성한 데이터만 받는다.
후보가 반환한 JSON을 evidence 또는 workflow로 그대로 전달하면 안 된다.

- `commands`: `{cwd, command, exitCode, stdout, stderr}` 배열. 실제 실행 기록이다.
  Q2는 `node check.mjs pass`/`fail`의 종료 0/1을 각각 요구한다.
  구현 실행 점수는 `node --test public.test.mjs` 성공 기록을 요구한다. Q8·Q9는 실제 `node repro*.mjs` 성공 기록과 아래 독립 재현 판정도 함께 요구한다.
  Q5는 `node --input-type=module -e …` 또는 `node repro*.mjs`의 TypeError 관측 기록(종료0/1)과 답안에 연결된 독립 판정이 필요하다. 단순 Node 버전 실행은 재현 점수가 아니다.
- `assessments`: `{criterion, score, reason, answerHash}` 배열.
  `answerHash(answer)` export로 대상 답안의 해시를 계산한다. reason에는 답안의 어느 주장과
  어떤 관측 근거를 대조했는지 적는다. 각 기준의 0~배점 사이 점수를 줄 수 있다.
  해시 일치는 판정 대상 연결일 뿐 판정의 진실성을 보증하지 않는다.
  Q8·Q9의 재현 판정은 같은 형식에 `reproductionHash: answerHash({run, source})`를 더한다.
  run은 commands의 해당 실제 실행 기록, source는 그 명령으로 실행한 재현 파일의 UTF-8 내용이다.
  채점자는 파일 내용·실행 기록·assertion/관측값을 직접 대조하고 각 기준에 score:1 또는 0을 준다.
  Q8의 criterion은 `displayRead`: 한도 뒤 새 답을 표시하고 표시 ID와 저장된 읽음 ID가 일치하며 안 보인 답은 보존되는 실제 재현이다.
  Q9는 `manualPromise`(직접 resolve/reject하는 Promise로 실행 순서·취소 후 상태를 관측)와
  `restart`(저장 상태에서 새 인스턴스를 만들고 running 복구·종료 작업 미재실행을 관측) 둘 다 필요하다.
  각 reason에는 해당 입력·제어 순서·기대값·관측 결과를 적는다. 이름뿐인 재현 파일, 공개 시험만 실행,
  내용 없는 성공 기록은 0점이며 미판정도 0점이다. 두 시나리오는 같은 파일에 있어도 된다.
- `openedSources`: 실제 열람 도구에서 수집한 공식 URL 배열. Q3 sources 점수는 네 버전의 고정 문서 열람 근거를 요구한다.
  절 주소는 답안에서 대조하며 도구가 fragment를 제거해도 문서 열람으로 인정한다. 다른 사실 기준과 출처 점수는 분리한다. 단순 URL 존재만으로 의미 정확성을 인정하지 않으며
  독립 채점자가 해당 주장·버전·절 내용과 실행 여부를 대조한다.
- `falsePositives`: Q5의 재현되지 않은 헛지적 목록. 항목당 2점 감점, 최저 0점.
- `violations`: 실제 관측한 검사/권한 해제·정답 엿봄·범위 밖 실제 저장소/홈 쓰기.
  gate는 점수와 별개로 `eligible:false`를 만든다. 관측하지 않은 위반을 추정하지 않는다.
- `scopeChanged`: 실행기가 관측한 허용 범위 밖 변경 여부. 구현 과제는 공개 시험 보존,
  파일 300줄과 허용 파일 목록도 별도로 확인한다.

| 문제 | 독립 의미 채점 기준(괄호는 배점) |
|---|---|
| Q1 | requirements(4), proposal(2), approval(2), criteria(2) |
| Q2 | interpretation(3), waiting(2), report(2), 실제 검사 기록(3) |
| Q3 | versions/options/return/alternative/sources(각 2) |
| Q5 | defect(5), reproduction(3), control(2), 헛지적 감점 |
| Q6 | requirements(3), dependencies(2), revision(2), sources(2), criteria(1) |

기준별 상세 채점 키는 `scripts/model-exam-grade.mjs`의 `rubrics`에 있다.
후보 폴더에는 이 파일이나 이 가이드를 복사하지 않는다. 올바른 구현과 결함 변형은
`tests/model-exam-cases*.mjs`에만 두고 후보에게 전달하지 않는다.
의미 채점 테스트는 정답·누락·잘못된 답안 해시·헛지적·미열람 처리를 확인한다.
독립 채점자의 의미 판단 능력 자체를 이 단위 테스트가 검증하는 것은 아니다.

## Q3 고정 출처

2026-11-03 직접 연 공식 문서를 바탕으로 채점 키를 고정했다. 원문은 저장하지 않았다.

- [20.12 readdir](https://nodejs.org/download/release/v20.12.0/docs/api/fs.html#fspromisesreaddirpath-options),
  [당시 experimental parentPath](https://nodejs.org/download/release/v20.12.0/docs/api/fs.html#direntparentpath).
- [22.13 glob](https://nodejs.org/download/release/v22.13.0/docs/api/fs.html#fspromisesglobpattern-options).
- [22.16 glob](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fspromisesglobpattern-options).
- [22.20 glob 이력·반환형·제외 패턴](https://nodejs.org/download/release/v22.20.0/docs/api/fs.html#fspromisesglobpattern-options).

이전 Node 버전 바이너리를 직접 실행한 결과는 아니다. Q3를 풀 때는 시험 시작 전 고정한
문서 범위를 기준으로 사실과 적용 판단을 함께 본다.

## Q10 실행 인계

`prepareCase('Q10', cwd, {writer, reviewer})`는 설치 프로세스에만 임시 HOME/USERPROFILE을 주고
실제 하네스를 설치한다. 각 후보는 `{tool, model, effort}`다. 생략값은 codex
`gpt-6.1-sol medium`, 검토는 gemini `gemini-4-argon-medium medium`이며 잠정 배정이다.
서로 같은 도구면 준비를 거절한다. 단계별 명시 override에 작성 도구·모델·추론을 적고
바깥 검토에는 지정한 다른 도구·모델·추론을 적는다. 모델을 조용히 바꾸지 않는다.
독립 검토 실패 시 같은 도구를 반복 호출하지 않는 기존 공용 물레방아 규칙을 따른다.

prepareCase는 설치 전에 이력·원격 없는 후보 저장소를 초기화하고 초기 브랜치를 main으로 맞춘다.
반환값의 `workflow.setup`은 원격 없는 후보 저장소에서 실행할 기준 커밋·일감 추가/시작
명령이다. `workflow.command`가 실제 `harness/mullebanga.mjs` 호출이다. 기존 공용 흐름의
고치기 상한 3회를 쓴다. 실제 CLI 실행에는 원래 HOME/CODEX_HOME 등 인증 환경을 유지한다.
Q10의 mode는 전체물레방아이며 write:true다. 단일 답변 호출 대신 workflow 실행 경로를 사용한다.

실행기는 실제 물레방아의 worktree를 찾아 그 제출 폴더를 채점 cwd로 넘긴다.
`workflow` 채점 입력은 다음과 같다.

- `receipts.spec/specReview/build/review`: 각 `{ok, artifact}`. 실제 단계 출력·인계의
  보관 경로이며 실행기가 결과와 파일을 확인한 뒤 전달한다. 단순 자기 보고를 넣지 않는다.
- `writer`: 실제 작성 도구. `reviewTool`: 실제 독립 검토 도구.
- `raised/checkPassed/fixes/commit`: 실제 공용 물레방아 JSON 결과와 장부를 대조한 값.
- `criteriaEvidence`: 끝 기준별 명령·장소·실제 결과. 올림 출력과 대조한다.

자동 검사·커밋 실행의 속도를 모델 능력 순위로 매기지 않는다. 독립 검토 호출의 시간·토큰·비용은
작성 후보와 따로 기록한다. 중단·지원 실패·인프라 실패·풀이 오답을 구분하고 미실행을 채우지 않는다.
T-175의 합성 receipts 시험은 이 입력 계약 검증이며 실제 단계 완주 증거가 아니다.

## 검증

```sh
node --test tests/model-exam-cases*.test.mjs
node --test tests/*.test.mjs
node harness/check.mjs scripts/model-exam-fixtures.mjs scripts/model-exam-public.mjs scripts/model-exam-checks.mjs scripts/model-exam-grade.mjs tests/model-exam-cases.test.mjs guide/model-exam.md
```

실제 10과제 모델 시범·난도 보정·본시험은 실행하지 않았다. 추가 코드가 한 커밋 400줄을
넘으므로 메인이 반영할 때 공개 자산/API와 채점/검증을 나눠 커밋해야 한다. 한도를 바꾸지 않는다.

## 강화한 공개 계약

Q6은 고유 ID가 있는 45줄 변경 기록에서 요구별 최종 상태·출처·작업·선행·검사 또는 제외/대기를 연결한다.
Q7은 단계 모델·단계 도구 전환·프로필·legacy 우선순위와 전체 구조 검증, 정확한 true 허락, 직렬화 전 저장 거절을 함께 검사한다.
Q8은 출력과 읽음 대상을 함께 바로잡고 한도·안정 순서·다른 상태·안 보인 새 답을 보존한다. Q5/Q8의 repro*.mjs는 허용한다.
Q10은 Q4와 다른 CSV 파싱·원시 바이트 토큰·미리보기·확인 적용 CLI다. Q6과 업무 영역은 겹치지만 독립 제출이며 점수를 재사용하지 않는다.
정확한 계약 전체는 후보 prompt와 REQUEST.md에 공개한다. tests/model-exam-cases-reference.mjs는 비공개 검증용 정답 구현이다.
