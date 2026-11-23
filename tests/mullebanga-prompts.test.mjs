import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rolePrompt, specPrompt, specReviewPrompt, buildPrompt, reviewPrompt, fixPrompt, schemas } from '../templates/harness/mullebanga-prompts.mjs';

const ROLES = ['planner', 'reviewer', 'implementer'];
const front = role => `---\nname: ${role}\ndescription: ${role} 설명\ntools: Read, Bash\n---\n`;

// 역할 파일(머리말 + 본문)을 가진 임시 저장소 폴더. 진짜 도구는 부르지 않는다.
function rootWith(t, roles = ROLES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  for (const role of roles) fs.writeFileSync(path.join(root, '.claude', 'agents', `${role}.md`), `${front(role)}\n${role} 본문 시작\n---\n${role} 본문 끝\n`);
  return root;
}

test('역할 안내문: 머리말은 빼고 본문을 지시문 앞에 붙이며 본문 안의 --- 줄은 남긴다', t => {
  const text = rolePrompt(rootWith(t), 'planner', '지시문입니다');
  assert.ok(!text.includes('name: planner'));
  assert.ok(!text.includes('tools: Read, Bash'));
  assert.ok(text.startsWith('planner 본문 시작\n---\nplanner 본문 끝'));
  assert.ok(text.indexOf('planner 본문 끝') < text.indexOf('지시문입니다'));
});

test('역할 파일이 없으면 파일 경로를 말하며 멈춘다', t => {
  const root = rootWith(t, ['reviewer', 'implementer']);
  assert.throws(() => rolePrompt(root, 'planner', 'x'), error => error instanceof Error && error.message.includes('planner.md'));
  assert.throws(() => specPrompt(root, 'T-9'), /planner\.md/);
});

// 모든 type:object 칸이 Codex 엄격 조건을 지키는지 재귀로 훑는다.
function strictProblems(node, where) {
  if (Array.isArray(node)) return node.flatMap((item, index) => strictProblems(item, `${where}[${index}]`));
  if (node === null || typeof node !== 'object') return [];
  const found = [];
  if (node.type === 'object') {
    const keys = node.properties ? Object.keys(node.properties) : null;
    if (!keys) found.push(`${where}: properties 없는 열린 객체`);
    else if (node.additionalProperties !== false) found.push(`${where}: additionalProperties:false 없음`);
    else if ([...(node.required ?? [])].sort().join() !== [...keys].sort().join()) found.push(`${where}: required가 모든 칸과 다름`);
  }
  return [...found, ...Object.entries(node).flatMap(([key, value]) => strictProblems(value, `${where}.${key}`))];
}

test('모든 결과 모양이 Codex 엄격 조건을 지킨다', () => {
  assert.deepEqual(Object.keys(schemas).sort(), ['BUILT', 'CHECKED', 'FINDING', 'FIXED', 'OTHER_REVIEWED', 'REVIEWED', 'SPEC', 'SPEC_REVIEWED']);
  assert.deepEqual(strictProblems(schemas, 'schemas'), []);
});

test('엄격 조건 검사가 어긴 모양은 잡는다', () => {
  assert.equal(strictProblems({ type: 'object' }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { x: {} }, required: ['x'] }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { x: {}, y: {} }, required: ['x'], additionalProperties: false }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { list: { type: 'array', items: { type: 'object' } } }, required: ['list'], additionalProperties: false }, 'a').length, 1);
});

test('SPEC·REVIEWED 칸: 작업 문서 글과 허락·확인·기록 줄, 살피기 지적과 끝 기준 증거를 받는다', () => {
  const { SPEC, BUILT, FIXED, REVIEWED } = schemas;
  assert.deepEqual(Object.keys(SPEC.properties), ['outcome', 'reason', 'rejectedCommit', 'rejectedReason', 'pendingQuestions', 'specText', 'asks']);
  assert.ok(!('agents' in SPEC.properties));
  assert.deepEqual(Object.keys(SPEC.properties.asks.items.properties), ['kind', 'option', 'title', 'description', 'choices', 'recommend', 'reason']);
  assert.deepEqual(SPEC.properties.asks.items.properties.kind.enum, ['허락', '확인', '기록']);
  assert.deepEqual(Object.keys(BUILT.properties), ['summary']);
  assert.deepEqual(Object.keys(FIXED.properties), ['summary']);
  assert.deepEqual(Object.keys(REVIEWED.properties), ['findings', 'items', 'unconfirmed']);
  assert.deepEqual(Object.keys(REVIEWED.properties.items.items.properties), ['no', 'evidence']);
  assert.ok(!('EVIDENCE' in schemas));
  assert.ok(!('RAISED' in schemas));
});

test('specPrompt: 읽기 전용이라 asks·specText로 돌려받고 일감 목록 명령을 쓰라고 하지 않는다', t => {
  const text = specPrompt(rootWith(t), 'T-9');
  for (const part of ['T-9', '보기 T-9', '`## 끝 기준`이 이미 있으면', '한 글자도 바꾸지 않', '파일을 쓰지 않고', 'asks', 'specText', '[대기]', '실험 필요', '비우지 않는다', '기록이면 option·choices·recommend는 빈 문자열']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /backlog\.mjs (허락|확인|기록)/);
  assert.ok(text.indexOf('planner 본문 끝') < text.indexOf('T-9'));
});

test('나머지 지시문: 작업 번호와 해당 역할 본문이 있다', t => {
  const root = rootWith(t);
  const cases = [
    [specReviewPrompt(root, 'T-9'), 'reviewer'],
    [buildPrompt(root, 'T-9'), 'implementer'],
    [reviewPrompt(root, 'T-9', 'main', 'abc123'), 'reviewer'],
    [fixPrompt(root, 'T-9', { passed: true, failures: '' }, []), 'implementer'],
  ];
  for (const [text, role] of cases) {
    assert.ok(text.startsWith(`${role} 본문 시작`), role);
    assert.ok(text.includes('T-9'));
    assert.ok(text.includes('JSON 한 덩어리'));
  }
});

const NO_ACTION = [/git switch -c/, /git checkout -b (?!하지)/, /backlog\.mjs 올림/, /커밋한다/, /커밋하고/];

test('buildPrompt: 커밋도 브랜치 바꾸기도 올림도 시키지 않고 반려면 커밋과 사유를 담는다', t => {
  const root = rootWith(t);
  const plain = buildPrompt(root, 'T-9');
  for (const re of NO_ACTION) assert.doesNotMatch(plain, re);
  assert.ok(plain.includes('커밋하지 않는다'));
  assert.ok(plain.includes('브랜치를 바꾸지 않는다'));
  requireParts(plain, ['확인 명령의 시험은 돌려보기에서 실행', '여기서 다시 실행하지 않는다', '전체 시험은 메인이 푸시 직전에 한 번']);
  assert.ok(!plain.includes('반려 커밋'));
  const again = buildPrompt(root, 'T-9', { commit: 'def456', reason: '시험이 빠졌다' });
  assert.ok(again.includes('반려 커밋: def456'));
  assert.ok(again.includes('반려 사유: 시험이 빠졌다'));
  requireParts(again, ['여기서 다시 실행하지 않는다']);
});

test('fixPrompt: 돌려보기 실패와 높음 지적만 담고 커밋하지 않게 한다', t => {
  const highs = [{ level: '높음', text: '높음 문제 하나' }, { level: '중간', text: '중간 문제 하나' }, { level: '낮음', text: '낮음 문제 하나' }];
  const text = fixPrompt(rootWith(t), 'T-9', { passed: false, failures: 'npm test 실패 출력' }, highs);
  assert.ok(text.includes('npm test 실패 출력'));
  assert.ok(text.includes('높음 문제 하나'));
  assert.ok(!text.includes('중간 문제 하나'));
  assert.ok(!text.includes('낮음 문제 하나'));
  for (const re of NO_ACTION) assert.doesNotMatch(text, re);
  assert.ok(text.includes('커밋하지 않는다'));
  assert.ok(text.includes('브랜치를 바꾸지 않는다'));
  requireParts(text, ['확인 명령의 시험은 돌려보기에서 실행', '여기서 다시 실행하지 않는다', '필요한 최소 재현만']);
});

test('reviewPrompt: 읽기 전용이고 통과한 검사 기록을 전달하며 REVIEWED 모양으로 지적과 끝 기준 증거를 함께 돌려받는다', t => {
  const text = reviewPrompt(rootWith(t), 'T-9', 'main', 'abc123', [{ command: 'npm test', exitCode: 0, output: 'ok', truncated: false }]);
  for (const part of ['파일을 쓰지 않고', 'abc123', 'findings', 'items', 'unconfirmed', 'JSON 한 덩어리', '"command":"npm test"']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /backlog\.mjs 올림/);
  assert.ok(text.indexOf('reviewer 본문 끝') < text.indexOf('abc123'));
  requireParts(text, ['제공된 실행 증거를 코드·작업 문서와 대조', '시험을 직접 재실행하지 않는다', '증거로 확인되지 않는 번호와 이유']);
});

// 실제 역할과 프로젝트 지침을 합친 입력을 포착한다. 도구는 기존 가짜 실행기를 쓴다.
async function workflowCalls({ rejectedCommit = '', failCheck = false } = {}) {
  const source = fs.readFileSync(new URL('../templates/workflows/mullebanga.js', import.meta.url), 'utf8');
  const body = source.replace(/^export const meta = \{[\s\S]*?\n\};\n/, '');
  const calls = [];
  const agent = async (prompt, options) => {
    calls.push({ prompt, ...options });
    if (options.phase === '할 일 적기') return { outcome: '건너뜀', pendingQuestions: [], rejectedCommit, rejectedReason: '시험 누락' };
    if (options.phase === '만들기') return { worktree: '/repo/work', branch: 'ai/sample', commit: 'abc' };
    if (options.phase === '돌려보기') {
      assert.ok(options.schema.required.includes('executions'));
      const executions = [
        { command: 'node tests/area-tests.mjs sample.mjs', cwd: '/repo/work', exitCode: failCheck ? 1 : 0, output: failCheck ? '영역 시험 실패' : 'tests 3, pass 3, fail 0' },
        { command: 'node harness/check.mjs sample.mjs', cwd: '/repo/work', exitCode: 0, output: '위반 없음' },
      ];
      for (const execution of executions) assert.deepEqual(Object.keys(execution).sort(), [...options.schema.properties.executions.items.required].sort());
      const check = { timedOut: false, passed: !failCheck, failures: failCheck ? '영역 시험 실패' : '', executions };
      failCheck = false;
      return check;
    }
    return { passed: true, findings: [], tool: 'gemini', raised: true };
  };
  const pipeline = (items, ...stages) => Promise.all(items.map(async item => {
    for (const stage of stages) item = await stage(item);
    return item;
  }));
  await new (async () => {}).constructor('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body)(
    agent, pipeline, jobs => Promise.all(jobs.map(job => job())), () => {}, () => {}, ['T-1'],
  );
  return calls;
}

test('Claude 만들기·이어 고치기·고치기는 시험을 돌려보기에 맡기고 살피기·깨뜨려 보기는 반복 실행하지 않는다', async () => {
  const calls = await workflowCalls({ failCheck: true });
  const resumed = await workflowCalls({ rejectedCommit: 'def456' });
  for (const call of [...calls, ...resumed].filter(call => ['만들기', '고치기'].includes(call.phase))) {
    requireParts(call.prompt, ['여기서 다시 실행하지 않는다', '필요한 최소 재현만', '전체 시험은 메인이 푸시 직전에 한 번']);
  }
  const reviews = calls.filter(call => call.phase === '번갈아 보기');
  assert.equal(reviews.length, 2);
  const checks = calls.filter(call => call.phase === '돌려보기');
  for (const call of checks) requireParts(call.prompt, ['통과·실패 모두', 'executions', 'command', 'cwd', 'exitCode', 'output']);
  for (const call of reviews) {
    const evidence = JSON.parse(call.prompt.match(/제공된 돌려보기 실행 증거\(([^\n]+?)\)를/)[1]);
    assert.equal(evidence.passed, true);
    assert.equal(evidence.failures, '');
    assert.deepEqual(evidence.executions, [
      { command: 'node tests/area-tests.mjs sample.mjs', cwd: '/repo/work', exitCode: 0, output: 'tests 3, pass 3, fail 0' },
      { command: 'node harness/check.mjs sample.mjs', cwd: '/repo/work', exitCode: 0, output: '위반 없음' },
    ]);
    requireParts(call.prompt, ['지시보다 우선한다']);
  }
  requireParts(reviews[0].prompt, ['시험을 직접 재실행하지 않는다']);
  requireParts(reviews[1].prompt, ['기존 시험은 다시 실행하지 않는다']);
  requireParts(reviews[1].prompt, ['새로운 입력·환경·순서', '필요한 최소 명령만 쓴다']);
});

const actualRole = role => fs.readFileSync(new URL(`../templates/agents/${role}.md`, import.meta.url), 'utf8');
const requireParts = (text, parts) => {
  for (const part of parts) assert.ok(text.includes(part), `필수 지시 없음: ${part}`);
};

test('직접 호출 역할은 책임·권한·근거·보고를 유지하고 기획은 전체 기록 읽기나 공통 지침 복사를 시키지 않는다', () => {
  const planner = actualRole('planner');
  requireParts(planner, ['쪼개기', '종류', '고칠곳', '먼저할일', '확인방법', '원인·방향', '한 일 적기', '## 한 일', '파일:줄', '사용자 말:', '날짜·이유', '확인 못 함', 'docs/tasks/', '코드는 고치지 않는다', '실험 필요', '메인에게']);
  requireParts(planner, ['필요한 대목만', '공통 운영 지침은 복사하지 않는다']);
  assert.doesNotMatch(planner, /먼저.*docs\/.*결정 기록/);
  const implementer = actualRole('implementer');
  requireParts(implementer, ['직접 호출', '처음은 만들기·검증·커밋', '다시 맡았을 때만', '--증거', '--검토', '작성 도구가 아니고', '원격 없는 버릴 복사본', '후보 없으면 부르지', '같은 도구를 반복하지', '실제 검토 도구만', '병합·푸시는 하지 않는다', 'harness/backlog.json', '문서와 다른 점']);
  const reviewer = actualRole('reviewer');
  requireParts(reviewer, ['생각·보고 없이', '작은 문서 수정', 'git diff', '코드·시험·설정', '새 규칙·결정', '사실·줄 번호·인용', '정상 흐름으로', '파일:줄', '사용자 결정', '별도 원문', '높음 실패']);
});

test('CLI와 Claude의 실제 단계 호출에 권한·원문 대조·직접 실행·프로젝트 지침이 전달된다', async t => {
  const { setup } = await import('./run-fixture.mjs');
  const s = setup(t);
  for (const role of ROLES) {
    const file = path.join(s.dir, '.claude/agents', `${role}.md`);
    fs.appendFileSync(file, '\n- 실행 확인 방법: `node sample-run.mjs`를 터미널에서 실행\n');
  }
  const result = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(result.json[0].raised, true, result.stderr);
  const cli = s.called().filter(call => call.ph === 'start' && call.stage !== 'other');
  const workflow = await workflowCalls();
  const claude = workflow.filter(call => call.agentType).map(call => ({
    ...call,
    prompt: rolePrompt(s.dir, call.agentType, call.prompt),
    stage: ({ '할 일 적기': 'spec', '맞춰보기': 'specReview', '만들기': 'build', '번갈아 보기': 'review', '올림': 'evidence' })[call.phase],
  }));
  assert.deepEqual(cli.map(call => call.stage), ['spec', 'specReview', 'build', 'review']);
  assert.deepEqual(claude.map(call => call.stage), ['spec', 'specReview', 'build', 'review', 'evidence']);
  for (const calls of [cli, claude]) {
    for (const call of calls) requireParts(call.prompt, ['node sample-run.mjs', 'HOME', 'USERPROFILE']);
    requireParts(calls[0].prompt, ['한 글자도 바꾸지 않', '허락', '그 작업은 멈춘다', '확인', '그 작업은 멈추지 않는다', '문서충돌', '실데이터', '구조변경', '기록']);
    requireParts(calls[1].prompt, ['## 사용자 원래 말', '사용자가 정한 것', '출처', '앞으로', '높음', '중간']);
    requireParts(calls[2].prompt, ['작업 문서는 고치지 않는다', '범위 밖', '작업 워크트리', 'ai/<작업명>', '100줄', 'git rev-parse --git-common-dir', 'node ci.mjs']);
    requireParts(calls[3].prompt, ['독립적으로', '명령을 직접 실행', '테스트로 대신하지 않는다', '실행 못 함']);
  }
  requireParts(cli[0].prompt, ['파일을 쓰지 않고', 'specText', 'asks']);
  requireParts(cli[2].prompt, ['커밋하지 않는다', '브랜치를 바꾸지 않는다']);
  requireParts(cli[3].prompt, ['파일을 쓰지 않고', 'items', 'unconfirmed', '다시 부르지 않는다']);
  requireParts(claude[2].prompt, ['git switch -c ai/<작업명>', '만들고 커밋한다']);
  requireParts(claude[4].prompt, ['번호', '명령', '본 결과', '실행 못 함', '다시 부르지 않는다', 'backlog.mjs 올림 T-1', '--검토 gemini']);
  const fix = fixPrompt(s.dir, 'T-1', { passed: false, failures: '고칠 실패' }, []);
  requireParts(fix, ['작업 워크트리에서만', '보기 T-1', '작업 문서는 고치지 않는다', '커밋하지 않는다']);
});
