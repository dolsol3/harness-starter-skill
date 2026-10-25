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
    'T-1': { evidence: [{ payload: { unconfirmed: ['1번: 실행 못 함'] } }] },
    'T-2': { evidence: [{ payload: { items: [] } }] },
  });
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-2']);
  stoppedAt(res.json[0], '올림', '1번: 실행 못 함');
  stoppedAt(res.json[1], '올림', '1번 증거 없음');
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});
