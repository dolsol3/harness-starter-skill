// 공용 물레방아(mullebanga.mjs)가 단계마다 도구에 보내는 지시문, 역할 안내문 붙이기, 결과 모양(JSON 스키마).
// 글과 모양만 돌려준다. 도구 부르기·파일 쓰기·일감 목록 명령은 하지 않는다.
// codex exec에는 역할(--agent) 기능이 없어서 클로드판과 같은 .claude/agents/<역할>.md 본문을 지시문 앞에 붙인다.
import fs from 'node:fs';
import path from 'node:path';

const ONLY_JSON = '결과는 스키마대로 JSON 한 덩어리로만 돌려준다. 앞뒤에 설명 글을 붙이지 않는다.';
const READ_STEP = id => `먼저 \`node harness/backlog.mjs 보기 ${id}\`로 작업 문서를 읽는다.`;
const CUT_STEP = id => `출력이 잘리면(\`…줄 더 있다\` 안내가 보이면) 메인 폴더(\`git rev-parse --git-common-dir\`의 부모)의 \`docs/tasks/${id}.md\` 전체를 읽는다.`;
// 커밋은 순서 본체 코드가 한다. codex exec 워크트리의 git commit이 거절되기 때문이다(실험 2026-10-24).
const NO_COMMIT = '커밋하지 않는다. 브랜치를 바꾸지 않는다. 새 브랜치도 만들지 않는다(git commit·git switch·git checkout -b 하지 않는다). 바뀐 것은 작업 폴더에 그대로 둔다. 일감 목록에 올리는 일, 병합, 푸시도 하지 않는다. 안내문과 다르면 이 지시가 우선한다.';
const SUMMARY_STEP = '한 일 요약(summary)을 돌려준다. 새로 알게 된 것과 스스로 정한 것도 여기 적는다.';

// 머리말(맨 앞 --- 줄부터 다음 --- 줄까지)은 한 덩어리만 뺀다. 본문 안의 --- 줄은 남긴다.
export function rolePrompt(root, role, instruction) {
  const file = path.join(root, '.claude', 'agents', `${role}.md`);
  if (!fs.existsSync(file)) throw new Error(`역할 안내문 파일이 없다: ${file} (역할 없이 지시문만 보내지 않는다)`);
  const body = fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return `${body.trim()}\n\n${instruction}`;
}

// Codex --output-schema 엄격 조건: 모든 객체에 additionalProperties:false, 모든 칸이 required, 열린 객체 없음.
const schemaObj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const strList = description => ({ type: 'array', items: { type: 'string' }, description });
const FINDING = schemaObj({ level: { type: 'string', enum: ['높음', '중간', '낮음'] }, text: { type: 'string' } });
const FINDINGS = { type: 'array', items: FINDING };
// 허락·확인·기록 줄 하나가 backlog.mjs 허락|확인|기록의 "제목"·--설명·--보기·--추천·--이유에 대응한다.
const ASK = schemaObj({
  kind: { type: 'string', enum: ['허락', '확인', '기록'] },
  option: { type: 'string', description: '허락이면 --행동 값(삭제|약속변경|외부발행|결제|장치풀기), 확인이면 --까닭 값(문서충돌|실데이터|구조변경), 기록이면 빈 문자열' },
  title: { type: 'string' },
  description: { type: 'string' },
  choices: { type: 'string', description: '이름=결과|이름=결과 한 글. 기록이면 빈 문자열' },
  recommend: { type: 'string', description: '추천하는 보기 이름. 기록이면 빈 문자열' },
  reason: { type: 'string' },
});

export const schemas = {
  FINDING,
  // 허락·실험 필요면 그 작업은 맞춰보기·만들기로 가지 않는다. 반려 칸은 어느 결과든 채운다(이어 고치기에 쓴다).
  SPEC: schemaObj({
    outcome: { type: 'string', enum: ['썼음', '건너뜀', '허락', '실험 필요'] },
    reason: { type: 'string', description: '허락·실험 필요로 멈춘 이유. 아니면 빈 문자열' },
    rejectedCommit: { type: 'string', description: '보기의 마지막 반려 줄의 커밋. 반려가 없으면 빈 문자열' },
    rejectedReason: { type: 'string', description: '보기의 마지막 반려 줄의 사유. 반려가 없으면 빈 문자열' },
    pendingQuestions: strList('보기의 [대기] 질문 줄. 없으면 빈 목록'),
    specText: { type: 'string', description: '썼음이면 ## 왜 하나부터 ## 끝 기준까지 쓴 글 전체. 사용자 원래 말 절은 넣지 않는다. 그 밖에는 빈 문자열' },
    asks: { type: 'array', items: ASK, description: '남길 허락·확인·기록 줄. 없으면 빈 목록' },
  }),
  BUILT: schemaObj({ summary: { type: 'string', description: '한 일 요약. 새로 알게 된 것과 스스로 정한 것 포함' } }),
  CHECKED: schemaObj({ passed: { type: 'boolean' }, failures: { type: 'string', description: '실패한 명령과 출력. 통과면 빈 문자열' } }),
  SPEC_REVIEWED: schemaObj({ passed: { type: 'boolean' }, findings: FINDINGS }),
  REVIEWED: schemaObj({ findings: FINDINGS }),
  OTHER_REVIEWED: schemaObj({
    tool: { type: 'string', description: '검토한 도구 이름. 다른 도구가 없어 건너뛰었으면 빈 문자열' },
    findings: FINDINGS,
    agentapiChanged: { type: 'boolean', description: '검토 뒤 진짜 홈 agentapi가 바뀌었으면 true. 아니면 false' },
  }),
  FIXED: schemaObj({ summary: { type: 'string', description: '고친 일 요약' } }),
  EVIDENCE: schemaObj({
    items: { type: 'array', items: schemaObj({ no: { type: 'string', description: '끝 기준 번호' }, evidence: { type: 'string', description: '실행한 명령과 본 결과' } }) },
    unconfirmed: strList('확인하지 못한 끝 기준 번호와 이유. 없으면 빈 목록'),
  }),
};

// 일꾼은 대화를 못 본다. 그래서 작업 문서 맨 위 사용자 원래 말 절이 맞춰보기의 원문이다(사용자 결정 2026-10-12).
// 기획 담당은 읽기 전용으로 불린다. 파일 쓰기와 일감 목록 명령은 순서 본체가 하므로 asks·specText로 돌려받는다.
export function specPrompt(root, id) {
  return rolePrompt(root, 'planner', [
    `작업 ${id}의 할 일 적기를 맡는다. ${READ_STEP(id)} ${CUT_STEP(id)}`,
    '이번 호출에서는 파일을 쓰지 않고 `허락`·`확인`·`기록` 명령도 쓰지 않는다. 대신 쓴 작업 문서 글은 specText로, 남길 허락·확인·기록 줄은 asks로 돌려준다. 안내문과 다르면 이 지시가 우선한다.',
    '`보기` 출력에 `반려: <커밋> <사유>` 줄이 있으면 마지막 반려 줄의 커밋과 사유를 rejectedCommit·rejectedReason으로 돌려준다. 없으면 둘 다 빈 문자열이다. 아래 어느 경우든 돌려준다.',
    '`보기` 출력의 `질문: … [대기] …` 줄(답을 기다리는 질문)을 그대로 pendingQuestions로 돌려준다. 하나라도 있으면 끝 기준을 보기 전에 멈춘다: 작업 문서를 쓰지 않고 새 질문도 하지 않고 허락으로 돌려준다.',
    '작업 문서에 `## 끝 기준`이 이미 있으면 작업 문서를 쓰지 않고 건너뜀으로 돌려준다.',
    `없으면 나머지를 specText에 쓴다: 왜 하나 / 어디까지·하지 않을 것 / 이미 정한 것 / 참고할 파일 / 끝 기준. \`## 왜 하나\`부터 \`## 끝 기준\`까지 글 전체를 적고, 순서 본체가 이 글을 \`docs/tasks/${id}.md\` 끝에 붙인다.`,
    '맨 위 `## 사용자 원래 말` 절은 한 글자도 바꾸지 않고 specText에 넣지 않는다. \'사용자가 정한 것\' 표시는 그 절에 있는 말에만 붙인다.',
    '허락 다섯(진짜 데이터를 지우거나 바꾸는 일, 이미 남이 쓰는 약속을 바꾸는 일, 배포·발송·게시, 진짜 돈이 움직이는 일, 지키는 장치를 끄거나 넓히는 일)이 나오면 asks에 kind 허락 줄(option은 삭제|약속변경|외부발행|결제|장치풀기 중 하나)을 넣고 허락으로 돌려준다. 그 작업은 멈춘다.',
    '확인 셋(문서끼리 말이 달라 어느 쪽을 따를지 골라야 할 때, 실제 데이터·개인정보를 지우거나 남기거나 드러내는 방식을 정할 때, 새 의존성을 들이거나 폴더 구조·아키텍처를 바꿀 때)이 나오면 하나를 골라(추천) 작업 문서를 끝까지 쓰고 asks에 kind 확인 줄(option은 문서충돌|실데이터|구조변경 중 하나)을 넣는다. 그 작업은 멈추지 않는다(썼음으로 돌려준다). 고른 것은 \'이미 정한 것\'에 기획 담당 결정으로 적는다.',
    '그 밖의 결정은 스스로 정하고 asks에 kind 기록 줄로 무엇을 왜 정했는지 남긴다.',
    'asks 줄 칸: title(제목), description(설명), choices(`이름=결과|이름=결과` 한 글), recommend(추천 보기 이름), reason(이유). 기록이면 option·choices·recommend는 빈 문자열이다.',
    '임시 실험 코드가 있어야 작업 문서를 쓸 수 있으면 쓰지 않고 실험 필요와 그 이유(reason)를 돌려준다. 이 순서 안에는 실험을 맡을 메인이 없다.',
    '일감 목록은 읽기만 한다.',
    ONLY_JSON,
  ].join('\n'));
}

export function specReviewPrompt(root, id) {
  return rolePrompt(root, 'reviewer', [
    `작업 ${id}의 맞춰보기를 한다(안내문의 '맞춰보기'). 고치지 않고 읽기만 한다.`,
    `${READ_STEP(id)} 사용자 원문은 따로 오지 않는다. 작업 문서 맨 위 \`## 사용자 원래 말\` 절이 원문이다. ${CUT_STEP(id)}`,
    '\'이미 정한 것\'에서 \'사용자가 정한 것\' 표시마다 그 말이 `## 사용자 원래 말` 절에 실제로 있는지 본다. 끝 기준이 이미 한 일이 아니라 앞으로 확인할 것인지 본다.',
    '`## 사용자 원래 말` 절이 없으면 맞춰볼 원문이 없으니 실패다. 높음 지적으로 적는다.',
    '통과 여부와 지적(높음·중간·낮음)을 돌려준다. 높음이나 중간이 하나라도 있으면 실패다. 지적이 없으면 빈 목록이다.',
    ONLY_JSON,
  ].join('\n'));
}

// 브랜치와 워크트리는 도구를 부르는 쪽이 만들어 둔 곳에서 시작한다.
export function buildPrompt(root, id, rejection) {
  return rolePrompt(root, 'implementer', [
    `작업 ${id}를 만든다. ${READ_STEP(id)}`,
    '지금 있는 곳(현재 폴더)이 이 작업의 워크트리이고 브랜치도 이미 만들어져 있다. 지금 브랜치는 `git branch --show-current`로 볼 수 있다.',
    ...(rejection ? [
      '이 작업은 다시하기로 돌아왔다. 처음부터 만들지 않고 지금 브랜치에서 반려 사유만 고친다. 작업 문서의 다른 일은 다시 하지 않는다.',
      `반려 커밋: ${rejection.commit}`,
      `반려 사유: ${rejection.reason}`,
    ] : []),
    '만든다.',
    NO_COMMIT,
    SUMMARY_STEP,
    ONLY_JSON,
  ].join('\n'));
}

export function reviewPrompt(root, id, base) {
  return rolePrompt(root, 'reviewer', [
    `작업 ${id}의 만든 코드를 살핀다. 지금 있는 곳(현재 폴더)이 만든 코드가 있는 워크트리다. 고치지 않는다.`,
    `${READ_STEP(id)} ${CUT_STEP(id)}`,
    `\`git diff ${base}...HEAD\`를 읽고 작업 문서의 끝 기준 번호마다 직접 확인한다.`,
    '지적마다 높음·중간·낮음을 붙여 돌려준다. 지적이 없으면 빈 목록을 돌려준다.',
    ONLY_JSON,
  ].join('\n'));
}

export function fixPrompt(root, id, check, highs) {
  return rolePrompt(root, 'implementer', [
    `작업 ${id}를 고친다. 지금 있는 곳(현재 폴더)의 작업 폴더에서 고친다.`,
    check.passed ? '돌려보기는 통과했다.' : `돌려보기가 실패했다:\n${check.failures}`,
    ...highs.filter(finding => finding.level === '높음').map(finding => `높음 지적: ${finding.text}`),
    '이 실패와 높음만 고친다. 중간·낮음은 고치지 않는다.',
    NO_COMMIT,
    SUMMARY_STEP,
    ONLY_JSON,
  ].join('\n'));
}

// 읽기 전용이다. 올림 명령은 순서 본체가 돌려받은 증거 글로 직접 돌린다.
export function evidencePrompt(root, id, commit) {
  return rolePrompt(root, 'implementer', [
    `작업 ${id}의 끝 기준 증거를 모은다. 돌려보기를 통과했고 남은 높음 지적이 없다. 확인할 커밋은 ${commit}이다. 지금 있는 곳(현재 폴더)이 이 작업의 워크트리다.`,
    '이번 호출에서는 파일을 쓰지 않고 `올림`을 포함한 일감 목록 명령도 쓰지 않는다. 커밋하지 않는다. 안내문에 올림이나 커밋 지시가 있어도 이 지시가 우선한다.',
    READ_STEP(id),
    '작업 문서의 끝 기준 번호마다 직접 실행해 보고, 실행한 명령과 본 결과를 items에 번호(no)와 함께 적는다. 실행하지 못한 번호는 지어내지 말고 번호와 이유를 unconfirmed에 적는다. 없으면 빈 목록이다.',
    ONLY_JSON,
  ].join('\n'));
}
