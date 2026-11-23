import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, calledStages, stoppedAt } from './run-fixture.mjs';

const finding = (level, text) => ({ payload: { findings: [{ level, text }] } });
const count = (s, name) => calledStages(s.called()).filter(stage => stage === name).length;

test('고치기 3번: 높음이 계속되면 고치기 호출이 정확히 3번이고 올리지 않고 진행중으로 둔다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { review: [finding('높음', '계속 높음')] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.fixes, task.raised, task.stopped], [3, false, undefined]);
  assert.equal(count(s, 'T-1:fix:codex'), 3);
  assert.equal(count(s, 'T-1:evidence:codex'), 0);
  assert.deepEqual(task.highs, [{ level: '높음', text: '계속 높음' }]);
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
  assert.equal(s.gitIn(s.dir, 'rev-list', '--count', 'main..ai/T-1'), '4');
});

test('고치기: 다른 도구의 높음도 합쳐 한 번 고치고 통과하면 fixes 1로 올림까지 간다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { other: [finding('높음', '다른 도구가 찾음'), {}] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.fixes, task.raised, task.highs], [1, true, []]);
  const fixPrompt = s.called().find(call => call.stage === 'fix' && call.ph === 'start').prompt;
  assert.ok(fixPrompt.includes('높음 지적: 다른 도구가 찾음'));
});

test('고치기: 고친 뒤 바뀐 파일이 없으면 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { review: [finding('높음', '높음')], fix: [{ write: {} }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '고치기', '커밋할 바뀐 파일이 없다');
});

test('돌려보기: 실패한 내용은 커밋하지 않아, HEAD와 비교하는 기본 검사기가 고치지 않은 위반을 통과시키지 않는다', async t => {
  const s = setup(t, { checkLine: '- 확인 명령: `node harness/check.mjs 바뀐 파일들`' });
  s.editConfig(config => { config.kinds = { code: { files: ['*.mjs'], maxFileLines: 300, basis: '시험용' } }; });
  s.git('add', '-A');
  s.git('commit', '-q', '-m', '시험 설정');
  const long = Array.from({ length: 301 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  s.scenario({ 'T-1': { build: [{ write: { 'long.mjs': long } }], fix: [1, 2, 3].map(n => ({ write: { [`other${n}.txt`]: 'ok' } })) } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.fixes, task.raised, task.checkPassed], [3, false, false]);
  assert.equal(task.commit, null);
  assert.equal(s.gitIn(s.dir, 'rev-list', '--count', 'main..ai/T-1'), '0');
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('돌려보기: 제한 1초의 sleep은 고치기 없이 시간 초과로 멈춘다', async t => {
  const s = setup(t, { checkLine: '- 확인 명령: `sleep 10`' });
  const [task] = (await s.run(['--도구', 'codex', '--시간제한', '1', 'T-1'])).json;
  stoppedAt(task, '돌려보기 시간 초과');
  assert.deepEqual([task.fixes, task.raised, task.checkPassed, task.commit], [0, false, false, null]);
  assert.match(task.checkFailures, /sleep 10.*\n시간 초과/s);
  assert.equal(count(s, 'T-1:fix:codex'), 0);
  assert.equal(count(s, 'T-1:review:codex'), 0);
});

test('돌려보기: 종료 코드 1이면 고치기를 한 번 호출하고 통과한다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { build: [{ write: { FAIL: '실패' } }], fix: [{ write: { FAIL: null, 'fixed.txt': '고침' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.fixes, task.raised, task.checkPassed], [1, true, true]);
  assert.equal(count(s, 'T-1:fix:codex'), 1);
});

test('허락 대기: 맞춰보기 도중 허락 질문이 생기면 워크트리도 만들기도 없이 멈춘다', async t => {
  const s = setup(t);
  const ask = ['허락', 'T-1', '지워도 되나', '--행동', '삭제', '--설명', '설명', '--보기', '예=지움|아니오=둠', '--추천', '아니오', '--이유', '이유'];
  s.scenario({ 'T-1': { specReview: [{ ledger: { cwd: s.dir, args: ask } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '허락 질문', '지워도 되나');
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex', 'T-1:specReview:codex']);
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')));
});

test('허락 대기: 번갈아 보기 도중 허락 질문이 생기면 고치기를 시작하지 않고 멈춘다', async t => {
  const s = setup(t);
  const ask = ['허락', 'T-1', '지워도 되나', '--행동', '삭제', '--설명', '설명', '--보기', '예=지움|아니오=둠', '--추천', '아니오', '--이유', '이유'];
  s.scenario({ 'T-1': { review: [{ ...finding('높음', '고쳐야 함'), ledger: { cwd: s.dir, args: ask } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '허락 질문');
  assert.equal(count(s, 'T-1:fix:codex'), 0);
  assert.equal(count(s, 'T-1:evidence:codex'), 0);
});

test('바깥 검토 뒤 진짜 홈 agentapi가 바뀌면 고치지 않고 멈춘다', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async t => {
  const s = setup(t);
  const agentapi = path.join(s.home, '.gemini/antigravity-cli/bin/agentapi');
  fs.mkdirSync(path.dirname(agentapi), { recursive: true });
  fs.writeFileSync(agentapi, '#!/bin/sh\necho agentapi\n');
  s.scenario({ 'T-1': { other: [{ tamper: true }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'], { FAKE_AGENTAPI: agentapi })).json;
  stoppedAt(task, 'agentapi');
  assert.equal(count(s, 'T-1:fix:codex'), 0);
});

// 자손이 죽을 때까지 잠깐 기다린다.
async function assertDead(pid) {
  for (let i = 0; i < 40; i++) {
    if (spawnSync('kill', ['-0', String(pid)]).status !== 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`자손 ${pid}이 살아 있다`);
}

test('멈춤 이유: 한도·결과없음·시간초과는 단계 이름과 함께 남고 되풀이해 부르지 않으며 다른 작업은 올림까지 간다', async t => {
  const s = setup(t, { tools: ['codex', 'codex', 'codex', 'codex'] });
  s.scenario({
    'T-1': { build: [{ exit: 1, stderr: 'usage limit reached' }] },
    'T-2': { specReview: [{ noresult: true }] },
    'T-3': { build: [{ sleep: true }] },
  });
  const res = await s.run(['--도구', 'codex', '--시간제한', '4', 'T-1', 'T-2', 'T-3', 'T-4']);
  stoppedAt(res.json[0], '만들기 단계 도구 실패(한도)');
  stoppedAt(res.json[1], '맞춰보기 단계 도구 실패(결과없음)');
  stoppedAt(res.json[2], '만들기 단계 도구 실패(시간초과)');
  assert.equal(res.json[3].raised, true);
  assert.deepEqual([count(s, 'T-1:build:codex'), count(s, 'T-2:specReview:codex'), count(s, 'T-3:build:codex')], [1, 1, 1]);
  for (const file of fs.readdirSync(s.aux).filter(name => name.startsWith('calls.pid'))) {
    await assertDead(Number(fs.readFileSync(path.join(s.aux, file), 'utf8')));
  }
});

test('결과 모양이 스키마와 다르면 결과없음으로 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { specReview: [{ payload: { passed: 'yes' } }] } });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '맞춰보기 단계 도구 실패(결과없음)');
});

test('올림: 확인하지 못한 끝 기준이 있거나 번호가 모자라면 올리지 않고 멈춘다', async t => {
  const s = setup(t, { tools: ['codex', 'codex'] });
  s.scenario({
    'T-1': { review: [{ payload: { unconfirmed: ['1번: 실행 못 함'] } }] },
    'T-2': { review: [{ payload: { items: [] } }] },
  });
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-2']);
  stoppedAt(res.json[0], '올림', '1번: 실행 못 함');
  stoppedAt(res.json[1], '올림', '1번 증거 없음');
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('클로드 워크플로: 확인 명령 시간 초과면 검토·고치기·올림 없이 멈춘다', async () => {
  const source = fs.readFileSync(new URL('../templates/workflows/mullebanga.js', import.meta.url), 'utf8');
  const body = source.replace(/^export const meta = \{[\s\S]*?\n\};\n/, '');
  const script = new (async () => {}).constructor('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body);
  const calls = [];
  const replies = {
    '할 일 적기': { outcome: '썼음', rejectedCommit: '', pendingQuestions: [] },
    '맞춰보기': { passed: true, findings: [] },
    '만들기': { worktree: '/tmp/work', branch: 'ai/T-1', commit: 'abc' },
    '돌려보기': { passed: false, timedOut: true, failures: 'sleep 10 시간 초과' },
  };
  const agent = async (prompt, options) => {
    calls.push(options.phase);
    assert.ok(replies[options.phase], `예상 밖 호출: ${options.phase}`);
    return replies[options.phase];
  };
  const pipeline = (items, ...stages) => Promise.all(items.map(async item => {
    for (const stage of stages) item = await stage(item);
    return item;
  }));
  const [task] = await script(agent, pipeline, null, () => {}, () => {}, ['T-1']);
  stoppedAt(task, '돌려보기 시간 초과');
  assert.deepEqual([task.fixes, task.raised, task.checkPassed], [0, false, false]);
  assert.deepEqual(calls, ['할 일 적기', '맞춰보기', '만들기', '돌려보기']);
});
