# 실전 과제 비교 실행기

기본은 모델 호출·파일 쓰기 없는 미리보기다. 결과는 저장소 밖 새 폴더에 둔다.

```sh
node scripts/model-exam.mjs --out /tmp/model-comparison-v2
node scripts/model-exam.mjs --out /tmp/model-infrastructure-v2 --phase infrastructure
node scripts/model-exam.mjs --out /tmp/model-infrastructure-v2 --phase infrastructure --run
```

실제 CLI 호출은 검증·독립 검토 뒤 메인이 한다. 만들기 담당은 가짜 CLI와 미리보기만 실행했다.
인프라 시범은 Haiku/Sol/Flash의 Q2 3회, 품질 시범은 Haiku/Astra xhigh의 Q3/Q7/Q9 6회다.
시범 결과를 본시험에 합산하지 않는다. 실제 지원 모델과 trace 추출을 확인하고 시범에서
양쪽 만점/영점인 문제를 검토·보정한 뒤 소스 해시를 다시 고정한다. 자동 재시도는 없다.

설정 사본의 `phase`는 main/infrastructure/pilot/repeat/mixed다. main 기본은 16후보×21과제(Q3~Q23, 쉬운 Q1·Q2 제외)
336회차다. 미리보기의 `cases`에 계획한 문제마다 단계·난이도·시간 제한이 나온다. Q10은 단일 답변 호출이 아니라 실제 공용 물레방아 subprocess다.
Q10 한 회차 상한은 계획·맞춰보기·만들기 3 + 최대 4번의 내부/외부 검토 8 + 수정 3 + 올림 1 = 15호출이다.
고정 독립 검토자는 도구별 `reviewers`에 적으며 작성 도구와 달라야 한다. 시험 사본의
동시상한에는 작성/검토 도구만 넣어 별도 제3 도구로 전환하지 않는다. 실패 시 실제 attempts를 남긴다.
본시험 16×(단일 20+Q10 15)=560, 인프라 3, 품질 시범 6, 반복 예약 140, 최종 혼합 15로 최대 724호출이다.
반복 예약은 단계별 서로 다른 최대 2후보×추가 2회×관련 과제이며 올림의 Q10도 15로 센다. 쉬운 Q1·Q2는 더하지 않는다.
`scripts/model-exam.json`의 `maxCalls`는 본시험 560에 맞춘 560이다(384에서 올림, 2026-11-14 사람 허락 Q-18).
실행하는 phase의 미재사용 회차 상한을 `maxCalls`와 대조해 시작 전에 거절한다.
의미 채점은 후보명을 가린 AI 판정·메인 확인으로 진행한다. 별도 채점 CLI 호출은 0이며 채점 AI 토큰은 미계측이다.
CLI에 강제 토큰 한도를 추가하지 않았다. 토큰·구독 소모량을 미리 보장하지 않는다.

`tasks`, `rounds`, `timeoutMs`, `maxInputChars`, `concurrency`, `seed`를 사본에서 고른다.
시간 제한을 생략하면 과제의 공개 timeoutSeconds를 쓴다. Q10은 전체 제한의 1/15을 각 호출 제한으로 쓴다.
`promptSuffix`도 키에 들어간다. 요청 모델의 별칭 해석이 바뀌면 모델·suffix를 바꿔 재사용을 끊는다.
후보·문제·회차·phase·접근 조건·동시상한·시간·소스 해시가 같고 CLI가 완료된 답안만 재사용한다.
미채점 답안도 다시 호출하지 않고 판정을 더할 수 있다. 재사용을 새 표본으로 세지 않는다.
출력 원시 스트림은 실행마다 새 폴더를 만들고 실패 시 수집된 usage도 보존한다.
인증 HOME/CODEX_HOME/CLAUDE_CONFIG_DIR은 단독 CLI에 보존한다. 설치 준비에만 임시 HOME/USERPROFILE을 쓴다.
Q10 바깥 검토는 기존 공용 검토기의 임시 홈·인증 규칙을 그대로 따른다.

과제 폴더에는 공개 자산만 준비하며 정답·숨은 채점기·원본 이력·원격을 복사하지 않는다.
Q2·Q16·Q17(돌려보기)은 파일 수정 허용 없이 셸을 실행해야 하므로 세 도구 모두 작업 폴더 쓰기 모드로 호출하고 스냅샷으로 파일 보존을 검사한다. Gemini Q2는 기존 breaker 역할, Q3은 웹 도구가 있는 research 역할을 쓴다. Gemini 쓰기·Q2 셸은 기존 callWritingGemini를 사용한다. Q10 관측은 시험 사본의 부모 호출기에만 연결하고
자식의 실제 실행파일·인자·stdin·sandbox·종료 상태를 보존한다. EXAM 관측 환경은 자식에 넘기지 않는다.
Claude 시험만 stream-json/verbose로 종결 result와 tool_use/tool_result를 읽는다. 일반 json 호출은 유지한다.
Codex Q3만 `-c web_search="live"`를 쓴다. 의도·진행중 이벤트를 완료 실행으로 세지 않는다.
Gemini 명령 본문/종료 상태는 네이티브 구조의 실제 확인이 남아 있어 자동 commands로 추정하지 않는다.
Claude Bash의 종료 판정 출처는 `tool_result.is_error`다. 이 필드와 실제 프로세스 종료 코드의
일치 여부도 인프라 시범에서 확인해야 한다. 확인 모델·추론 필드가 없으면 요청값으로 대신하지 않는다.
**읽기 접근 격리는 아직 검증되지 않았다.** 경로를 숨긴 것만으로 격리됐다고 부르지 않으며,
메인은 본시험 전에 후보가 원본 채점 자산과 보고 폴더에 접근하지 못하는 조건을 검증해야 한다.

`summary.json`은 호출/실패/완료/미채점/재사용 수와 전체 소스 해시를 담는다.
실행별 폴더에는 raw, submission, evidence.json, grading-packet.json이 있다. 원시 자료를 커밋하지 않는다.
`comparison.csv`는 criterion별 점수와 native usage를, `comparison.html`은 도구·후보·추론·난도·단계 필터,
후보별 합계와 중간·고난도·초고난도 점수, 단계×난이도 칸별 점수, 문제 heatmap, gate·누락·헛지적, 시간·토큰,
단계별 표본·완전 성공·중앙/범위를 보여 준다. 쉬운 Q1·Q2는 합계·난이도별·칸별 표에 들어가지 않고 heatmap에 '성적 제외'로만 보인다.
단계·난이도는 저장된 결과가 아니라 지금 문제 정의(`cases`)에서 ID로 찾으므로 옛 결과도 새 칸에 들어간다.
단회는 평균/분산으로 표시하지 않는다. 네이티브 입력/캐시/출력/추론의 포함 관계를 보존하고
작성·외부 검토·전체를 분리한다. Claude 전체 작업량은 modelUsage가 있으면 그 모델별 집계를 쓰고 main-loop usage와 합산하지 않는다. 누락은 0으로 합산하지 않으며 `total:null`과 observed/불완전을 남긴다.

## 메인의 의미 판정과 반복

`grading-packet.json`은 후보 이름·모델·추론을 제외한 답안·rubric·실제 명령·열람 근거와 재현 소스/해시다.
독립 판정자는 답안의 주장과 실제 submission 파일·명령·공식 근거를 읽는다. 단어 포함만으로 점수를 주지 않는다.
메인은 실제 판정 후 저장소 밖 `assessments/<결과key>.json`을 만들고 설정에 `assessments` 폴더를 지정한다.

```json
{"judge":{"id":"main-실제판정자","rubricVersion":2},"answerHash":"답안해시",
 "assessments":[{"criterion":"requirements","score":4,"reason":"답안 위치와 실제 근거 대조","answerHash":"답안해시"}],
 "falsePositives":[]}
```

모델 채점자를 별도로 부른다면 id와 callId·시간·토큰을 별도 기록하고 호출 예산을 먼저 재설계한다.
현재 runner는 별도 채점 CLI를 부르지 않는다. 새 컨텍스트의 블라인드 AI 판정 보조와 메인 확인은 기존 assessments JSON 경로로 연결하며, 그 AI 토큰은 미계측으로 구분한다. 후보 자기 점수는 받지 않는다.
Q8·Q9·Q20·Q21·Q22·Q23 재현 판정에는 packet의 reproductionHash를 연결한다. 판정이 없으면 `미채점`이며
gradeCase의 누락→0은 오답으로 확정하지 않는다. CLI 재사용 실행으로 실제 답안을 재호출하지 않고 재채점한다.
보관 사본 재채점은 evidence.originalCwd로 실제 실행 장소를 유지하며 원래 재현 해시를 바꾸지 않는다.

재채점 명령(모델 호출 0): `node scripts/model-exam.mjs --config <설정.json> --rescore <결과 폴더>`.
결과 폴더의 `summary.json`·회차별 `evidence.json`·`raw/stdout`을 직접 읽어 지금 계측·채점 코드로 다시 채점하며, 두 번 돌려도 같다.
폴더 위치는 결과 폴더 기준이라 옮겨도 된다(설정의 `assessments`는 판정 폴더 경로). summary의 `originalSources`는 처음 실행 소스, `rescoreSources`는 재채점 소스다.
`재판정 필요`(미채점)는 기존 판정의 answerHash·reproductionHash가 바뀐 증거와 맞지 않아 자동 인정도 0점도 하지 않았다는 뜻이다. 판정을 새로 받는다.

`repeatSelection`은 정확성 대표와 효율 도전자를 고르고 전체 풀·탈락/누락을 남긴다.
관련 정확성 90%, gate 없음 뒤 관련 과제 점수→오류/헛지적→예비 시간→ID로 대표를 고른다.
다른 후보 중 완전 수집 토큰→예비 시간→ID로 도전자를 고른다. 토큰 불완전이면 시간순이며 비용 우위를 미검증으로 둔다.
적격이 없으면 진단만, 한 명이면 한 명만 남긴다. 이 선발은 최종 추천이 아니다.
반복 phase는 도구 간에도 전체 직렬로 실행한다. 반복 사본에 `phase:"repeat"`, `rounds:[2,3]`, `concurrency` 각 1,
`selections:[{"candidate":"선발ID","tasks":["관련과제"]}]`를 넣고 동일 관련 과제로 실행한다.
단계가 겹치는 같은 후보/과제/회차는 중복하지 않는다. `previousSummaries:["/tmp/본시험/summary.json"]`으로 고정된 이전 결과를 합쳐 본시험 1회와 추가 2회를 함께 보고한다. runner/소스가 다르면 호출 전에 거절한다. 같은 결과 해시는 한 표본으로 세고 시범·혼합은 본시험/반복과 별도 표본 묶음으로 표시한다. 조건이 다른 표본은 실행 조건 혼합을 표시한다. 실제 직렬 비교는 첫 본시험의 병렬 시간과 구분한다.
최종 혼합은 후보를 실제 만들기 도구 한 명으로 좁히고 `phase:"mixed"`,
`mixedStages:{"할일적기":{"tool":"...","model":"...","effort":"..."},...}`를 적는다.
고정 독립 reviewer는 실제 만들기·고치기 도구와 다르게 유지한다. 이 실행도 Q10 공용 흐름을 거친다.
혼합 완주·직렬 반복·토큰 완전성을 확인한 뒤 메인이 모델/추론·직접 시험 횟수·상향 조건·한계를 권고한다.
운영 설정을 자동 변경하지 않는다. 최종 HTML은 기존 Downloads 보고서를 보존하며
`harness-model-comparison-2026-11-03-v2.html` 이름으로 메인이 저장한다.

# 실전 10과제 시험 자산

T-175는 시험 자산과 채점기를 준비한다. 모델 호출, 반복 시험, 실제 사용량 수집,
HTML 비교표, 난도 보정과 모델 배정은 T-176이다. 난이도는 설계 분류이며 실제 성능을 뜻하지 않는다.
과거 4문제 자산은 당시 기록이다. T-189에서 단계별 난이도 칸을 채워 23문제가 됐다(아래 '단계별 난이도 칸').

## 단계별 난이도 칸

난이도는 중간·고난도·초고난도 세 가지다(옛 '어려움'은 고난도). 쉬운 Q1·Q2는 문제 자산만 남기고 난이도를 null로 둬
기본 본시험과 성적에서 뺀다(인프라 시범은 그대로 Q2를 쓴다). 새 문제 ID는 기존 ID를 지키려고 Q11부터 잇는다.

| 단계 | 중간 | 고난도 | 초고난도 |
|---|---|---|---|
| 할일적기 | Q11 검색 요청 정리 | Q12 공유 요청의 허락·확인 분류 | |
| 맞춰보기 | Q13 작업 문서와 원래 말 대조 | Q14 작업 문서·결과 보고 대조 | |
| 쪼개기 | Q15 휴지통 작업 나누기 | Q6 | |
| 돌려보기 | Q16 검사 실행과 실패 보고 | Q17 실패를 삼키는 검사기 | |
| 조사 | Q3 | Q18 버전별 재시도 설정 조사 | Q19 보안 공지와 백포트 판정 |
| 만들기 | Q4 | Q7 | Q9 |
| 번갈아보기 | Q5 | Q20 제한기 변경 검토 | Q21 두 변경이 만난 캐시 결함 |
| 고치기 | Q22 메모이즈 키 충돌 고치기 | Q8 | Q23 동시 갱신 유실 고치기 |
| 전체연결 | | | Q10 |

중간 8·고난도 8·초고난도 5다. 문제마다 만점은 10점이다.
Q18·Q19는 웹을 쓰지 않는 고정 자료(`sources.md`, 가상 제품의 공식 문서·변경 기록·벤더 노트·블로그·자산 목록)로만 푼다.
외부 공식 문서를 자산에 넣지 않았으므로 실제 연 주소 기록이 따로 없다. Q12·Q19는 허락·확인 분류 뜻을 문제에 함께 준다.
Q20은 바꾸기 전 `before.mjs`와 바꾼 뒤 `limits.mjs`를, Q21은 두 변경 기록 `log.md`와 합친 `cache.mjs`를 준다.
두 문제는 원본을 고치면 gate이고, 재현 점수는 후보가 실제로 돌린 `repro*.mjs`를 원본 자산에 붙이면 실패하고
계약대로 고친 코드(`scripts/model-exam-checks-levels.mjs`의 `fixedSources`)에 붙이면 통과할 때만 준다.
Q22·Q23은 리뷰 두 개 중 증상만 덮는 쪽을 판별하고 원인을 고치는 구현 문제다. 숨은 행동 검사는 Q22 root(4)·boundaries(2)·cache(2),
Q23 ordering(3)·independence(2)·failure(2)·identity(1)이고, 둘 다 scope(1)·execution(1)을 더한다.
고치지 않은 원본은 3점이고, 리뷰를 그대로 따른 흔한 오답(convert에서만 memo 빼기 4점, join 키 8점, 쓰기 전 다시 읽어 합치기 4점, 전체 잠금 8점)은 감점된다.

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
Q2·Q16·Q17 actualChecks는 실행 여부 지표이며 자동 검사 속도나 명령 실행 자체를 모델 판단 품질로 해석하지 않는다.

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
T-176은 독립 메인 판정 파일을 연결한다. gradeCase의 미판정 기준은 0점·missing이지만 runner는 미채점으로 구분한다.
따라서 준비된 API만 호출해서 서술 답안의 의미가 자동 검증되었다고 발표하면 안 된다.

`evidence`는 실행기가 수집하거나 독립 채점자가 작성한 데이터만 받는다.
후보가 반환한 JSON을 evidence 또는 workflow로 그대로 전달하면 안 된다.

- `commands`: `{cwd, command, exitCode, stdout, stderr}` 배열. 실제 실행 기록이다.
  Q2는 `node check.mjs pass`/`fail`의 종료 0/1을, Q16은 `node --test public.test.mjs` 종료 1과 `node lint.mjs` 종료 0을,
  Q17은 `node run-checks.mjs` 종료 0과 `node --test unit.test.mjs`(또는 `node --test`) 종료 1을 요구한다.
  구현 실행 점수는 `node --test public.test.mjs` 성공 기록을 요구한다. Q8·Q9·Q22·Q23은 실제 `node repro*.mjs` 성공 기록과 아래 독립 재현 판정도 함께 요구한다.
  Q20·Q21은 코드를 고치지 않으므로 `node repro*.mjs`가 지금 코드에서 실패(종료 0 아님)한 기록과 아래 독립 재현 판정을 요구한다.
  Q5는 `node --input-type=module -e …` 또는 `node repro*.mjs`의 TypeError 관측 기록(종료0/1)과 답안에 연결된 독립 판정이 필요하다. 단순 Node 버전 실행은 재현 점수가 아니다.
- `assessments`: `{criterion, score, reason, answerHash}` 배열.
  `answerHash(answer)` export로 대상 답안의 해시를 계산한다. reason에는 답안의 어느 주장과
  어떤 관측 근거를 대조했는지 적는다. 각 기준의 0~배점 사이 점수를 줄 수 있다.
  해시 일치는 판정 대상 연결일 뿐 판정의 진실성을 보증하지 않는다.
  Q8·Q9·Q20·Q21·Q22·Q23의 재현 판정은 같은 형식에 `reproductionHash: answerHash({run, source})`를 더한다.
  run은 commands의 해당 실제 실행 기록, source는 그 명령으로 실행한 재현 파일의 UTF-8 내용이다.
  채점자는 파일 내용·실행 기록·assertion/관측값을 직접 대조하고 각 기준에 score:1 또는 0을 준다.
  Q8의 criterion은 `displayRead`: 한도 뒤 새 답을 표시하고 표시 ID와 저장된 읽음 ID가 일치하며 안 보인 답은 보존되는 실제 재현이다.
  Q9는 `manualPromise`(직접 resolve/reject하는 Promise로 실행 순서·취소 후 상태를 관측)와
  `restart`(저장 상태에서 새 인스턴스를 만들고 running 복구·종료 작업 미재실행을 관측) 둘 다 필요하다.
  Q22는 `collision`(convert·taxRate의 인자 충돌을 고친 뒤 재현이 통과), Q23은 `lostUpdate`(같은 파일 동시 갱신이 모두 남음)다.
  Q20은 `window`(정확히 windowMs 지난 기록이 만료되지 않음)와 `rejected`(거절된 요청도 기록됨) 둘 다, Q21은 `staleCompletion`(invalidate 뒤 이전 load 완료가 새 상태를 건드림)이다.
  Q20·Q21은 판정과 함께 기계 검사도 한다. 재현 파일(같은 폴더의 `repro*.mjs` 묶음을 함께 옮겨 실행한 진입 파일)이 결함마다 그 결함만 남긴 코드에서 실패하고 계약대로 고친 코드에서 통과해야 한다. 결함 하나만 재현하면 Q20 reproduction은 0점이다.
  각 reason에는 해당 입력·제어 순서·기대값·관측 결과를 적는다. 이름뿐인 재현 파일, 공개 시험만 실행,
  내용 없는 성공 기록은 0점이며 미판정도 0점이다. 두 시나리오는 같은 파일에 있어도 된다.
- `openedSources`: 실제 열람 도구에서 수집한 공식 URL 배열. Q3 sources 점수는 네 버전의 고정 문서 열람 근거를 요구한다.
  절 주소는 답안에서 대조하며 도구가 fragment를 제거해도 문서 열람으로 인정한다. 다른 사실 기준과 출처 점수는 분리한다. 단순 URL 존재만으로 의미 정확성을 인정하지 않으며
  독립 채점자가 해당 주장·버전·절 내용과 실행 여부를 대조한다.
- `falsePositives`: Q5·Q20·Q21의 재현되지 않은 헛지적 목록. 항목당 2점 감점, 최저 0점.
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
| Q11 | requirements(3), exclusions(2), open(2), criteria(3) |
| Q12 | requirements(3), revisions(2), approvals(3), criteria(2) |
| Q13 | mismatches(6), control(2), fixes(2) |
| Q14 | spec(4), evidence(3), control(2), action(1) |
| Q15 | split(3), dependencies(3), approval(2), criteria(2) |
| Q16 | failure(3), verdict(2), report(2), 실제 검사 기록(3) |
| Q17 | masking(3), verdict(2), report(2), 실제 검사 기록(3) |
| Q18 | versions(3), config(3), conflicts(2), sources(2) |
| Q19 | ranges(2), systems(5), sources(2), action(1) |
| Q20 | defects(4), reproduction(2, 두 결함 모두 가린 재현만), control(2), location(2), 헛지적 감점 |
| Q21 | root(3), symptoms(3), reproduction(2, 결함을 가린 재현만), control(2), 헛지적 감점 |

기준별 상세 채점 키는 `scripts/model-exam-grade.mjs`의 `rubrics`에 있다.
후보 폴더에는 이 파일이나 이 가이드를 복사하지 않는다. 올바른 구현과 결함 변형은
`tests/model-exam-cases*.mjs`·`tests/model-exam-levels*.mjs`에만 두고 후보에게 전달하지 않는다.
Q11~Q21의 정답 답안·흔한 오답·오답 판정은 `tests/model-exam-levels-answers.mjs`에 있다.
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
node harness/check.mjs scripts/model-exam-fixtures.mjs scripts/model-exam-public.mjs scripts/model-exam-public-levels.mjs scripts/model-exam-public-code.mjs scripts/model-exam-checks.mjs scripts/model-exam-checks-levels.mjs scripts/model-exam-grade.mjs tests/model-exam-cases.test.mjs tests/model-exam-levels.test.mjs guide/model-exam.md
```

실제 10과제 모델 시범·난도 보정·본시험은 실행하지 않았다. 추가 코드가 한 커밋 400줄을
넘으므로 메인이 반영할 때 공개 자산/API와 채점/검증을 나눠 커밋해야 한다. 한도를 바꾸지 않는다.

## 강화한 공개 계약

Q6은 고유 ID가 있는 45줄 변경 기록에서 요구별 최종 상태·출처·작업·선행·검사 또는 제외/대기를 연결한다.
Q7은 단계 모델·단계 도구 전환·프로필·legacy 우선순위와 전체 구조 검증, 정확한 true 허락, 직렬화 전 저장 거절을 함께 검사한다.
Q8은 출력과 읽음 대상을 함께 바로잡고 한도·안정 순서·다른 상태·안 보인 새 답을 보존한다. Q5/Q8의 repro*.mjs는 허용한다.
Q10은 Q4와 다른 CSV 파싱·원시 바이트 토큰·미리보기·확인 적용 CLI다. Q6과 업무 영역은 겹치지만 독립 제출이며 점수를 재사용하지 않는다.
정확한 계약 전체는 후보 prompt와 REQUEST.md에 공개한다. tests/model-exam-cases-reference.mjs는 비공개 검증용 정답 구현이다.

실제 Gemini 종료 직후 ENOTEMPTY가 관측되어 임시 폴더 정리에 제한된 재시도를 쓴다: [Node fs.rmSync 옵션](https://nodejs.org/api/fs.html#fsrmsyncpath-options).
