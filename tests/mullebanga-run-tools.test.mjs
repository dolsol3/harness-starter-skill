import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, calledStages, stoppedAt } from './run-fixture.mjs';
import { rolePrompt } from '../templates/harness/mullebanga-prompts.mjs';
import { runChecks } from '../templates/harness/mullebanga-git.mjs';
import { callTool, callWritingGemini } from '../templates/harness/mullebanga-call.mjs';

const starts = s => s.called().filter(call => call.ph === 'start');
const startOf = (s, id, stage) => starts(s).find(call => call.id === id && call.stage === stage);
const after = (args, flag) => args[args.indexOf(flag) + 1];

// 일감 목록의 배정(claude)과 실제로 쓴 도구(gemini)가 달라야 바깥 검토 codex를 일감 목록이 받는다: 일감 목록은 배정만 보고 검토 도구를 거른다.
test('단계 도구: 설정의 도구가 먹고 agents·tool 별칭도 먹으며, 도구가 없으면 --도구 값이다', async t => {
  const s = setup(t, { tools: ['claude'] });
  s.editConfig(config => {
    delete config.단계모델;
    config.agents = { build: { tool: 'gemini' } };
  });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(task.raised, true);
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex', 'T-1:specReview:codex', 'T-1:build:agy', 'T-1:review:codex', 'T-1:other:codex', 'T-1:evidence:codex']);
});

test('모델·깊이: 클로드는 기본값이나 설정값을 받고, 코덱스는 단계에 도구를 적었을 때만 받는다', async t => {
  const claude = setup(t, { tools: ['claude'] });
  await claude.run(['--도구', 'claude', 'T-1']);
  const buildArgs = startOf(claude, 'T-1', 'build').args;
  assert.deepEqual([after(buildArgs, '--model'), after(buildArgs, '--effort')], ['sonnet', 'medium']);
  const codex = setup(t);
  await codex.run(['--도구', 'codex', 'T-1']);
  for (const call of starts(codex).filter(item => item.tool === 'codex')) {
    assert.ok(!call.args.includes('-m') && !call.args.some(arg => arg.includes('model_reasoning_effort')), call.stage);
  }
  const named = setup(t, { tools: ['claude'] });
  named.editConfig(config => {
    config.단계모델.만들기 = { 도구: 'codex', 모델: 'x', 깊이: 'low' };
    config.단계모델.맞춰보기 = { 모델: 'haiku', 깊이: 'low' };
  });
  await named.run(['--도구', 'claude', 'T-1']);
  const codexBuild = startOf(named, 'T-1', 'build');
  assert.deepEqual([codexBuild.tool, after(codexBuild.args, '-m'), codexBuild.args.includes('model_reasoning_effort="low"')], ['codex', 'x', true]);
  assert.equal(after(startOf(named, 'T-1', 'specReview').args, '--model'), 'haiku');
});

test('제미나이 쓰기 단계는 쓰기 규칙을 작업 워크트리에만 열고, 읽기 단계는 규칙을 쓰지 않는다', async t => {
  const s = setup(t, { tools: ['gemini'] });
  const [task] = (await s.run(['--도구', 'gemini', 'T-1'])).json;
  assert.equal(task.raised, true);
  const rules = fs.readFileSync(`${s.calls}.rules`, 'utf8');
  assert.ok(rules.includes(`(subpath "${fs.realpathSync(task.worktree)}")`), rules);
  assert.ok(!rules.includes(`(subpath "${s.dir}")`) && !rules.includes(`(subpath "${s.aux}")`), rules);
});

const hasSandbox = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

test('제미나이가 작업 워크트리 밖에 쓰려 하면 진짜 샌드박스가 막고 안 쓰기는 된다', { skip: !hasSandbox }, async t => {
  const s = setup(t, { tools: ['gemini'] });
  fs.rmSync(path.join(s.bin, 'sandbox-exec'));
  const outside = path.join(s.aux, 'outside-worktree.txt');
  s.scenario({ 'T-1': { build: [{ escape: outside }] } });
  const [task] = (await s.run(['--도구', 'gemini', 'T-1'])).json;
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readFileSync(path.join(task.worktree, 'impl.txt'), 'utf8'), 'impl\n');
});

const ROLE = { spec: 'planner', specReview: 'reviewer', build: 'implementer', review: 'reviewer', fix: 'implementer', evidence: 'implementer' };

test('읽기·쓰기 역할: 읽기 단계는 읽기 전용, 만들기는 작업 워크트리에만 쓰고, 모든 지시문 앞에 역할 안내문이 있다', async t => {
  const s = setup(t, { tools: ['codex', 'claude', 'gemini'] });
  for (const tool of ['codex', 'claude', 'gemini']) await s.run(['--도구', tool]);
  const modeOf = { codex: call => after(call.args, '-s'), claude: call => after(call.args, '--permission-mode'), agy: call => (call.args.includes('--agent') ? 'readonly' : 'write') };
  const modes = { codex: ['read-only', 'workspace-write'], claude: ['plan', 'acceptEdits'], agy: ['readonly', 'write'] };
  const worktrees = [1, 2, 3].map(n => path.join(s.dir, `.claude/worktrees/T-${n}`));
  assert.ok(worktrees.every(dir => !fs.existsSync(path.join(dir, '.claude/agents'))));
  for (const call of starts(s).filter(item => item.stage !== 'other')) {
    const write = ['build', 'fix'].includes(call.stage);
    const task = Number(call.id.slice(2)) - 1;
    assert.equal(modeOf[call.tool](call), modes[call.tool][write ? 1 : 0], `${call.id} ${call.stage}`);
    const prompt = call.tool === 'agy' ? call.args[call.args.indexOf('-p') + 1] : call.args.at(-1);
    assert.ok(prompt.startsWith(rolePrompt(s.dir, ROLE[call.stage], '')), `${call.id} ${call.stage}`);
    const inMain = ['spec', 'specReview'].includes(call.stage);
    assert.equal(fs.realpathSync(call.cwd), inMain ? s.dir : fs.realpathSync(worktrees[task]), `${call.id} ${call.stage}`);
    if (call.tool === 'codex') assert.equal(fs.realpathSync(after(call.args, '-C')), fs.realpathSync(call.cwd));
    if (call.tool === 'agy') assert.equal(call.readOnly, write ? undefined : '1');
    assert.ok(!call.args.includes('--dangerously-skip-permissions') && !call.args.includes('-w'));
  }
});

test('작업 고르기: 번호가 없으면 맡길곳이 부른 도구인 진행중 작업만, 배정이 비면 기본 맡길곳으로 본다', async t => {
  const s = setup(t, { tools: ['claude', 'codex', 'claude'] });
  s.rewrite(book => {
    delete book.작업.find(task => task.번호 === 'T-3').배정;
  });
  assert.deepEqual((await s.run(['--도구', 'codex'])).json.map(task => task.id), ['T-2']);
  assert.deepEqual((await s.run(['--도구', 'claude'])).json.map(task => task.id), ['T-1', 'T-3']);
  assert.deepEqual((await s.run(['--도구', 'claude'])).json, []);
});

test('작업 고르기: 번호를 직접 주었는데 진행중이 아니거나 없으면 그 번호만 멈춘다', async t => {
  const s = setup(t);
  await s.run(['--도구', 'codex', 'T-1']);
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-99']);
  stoppedAt(res.json[0], '진행중이 아니다');
  stoppedAt(res.json[1], '일감 목록에서 읽지 못했다');
  assert.equal(res.status, 0);
});

// 호출 기록에서 한 작업의 [처음 시작, 마지막 끝] 시각
const span = (s, id, stage) => {
  const calls = s.called().filter(call => call.id === id && (!stage || call.stage === stage)).map(call => call.t);
  return [Math.min(...calls), Math.max(...calls)];
};

test('동시 수: 상한이 없으면 하나씩, 2이면 겹쳐 돌고 워크트리와 브랜치는 서로 다르다', async t => {
  for (const limit of [undefined, 2]) {
    const s = setup(t, { tools: ['codex', 'codex'] });
    s.editConfig(config => {
      config.일감목록.동시상한 = { claude: 5, gemini: 5, ...(limit && { codex: limit }) };
    });
    // 부하에서 둘째 가짜의 node 기동이 늦어 800ms로는 겹침이 안 보였다(부하 60개·48번 중 46번 실패). 1500도 실패, 2500은 통과.
    s.scenario({ '*': { build: [{ delay: 2500 }] } });
    const { json } = await s.run(['--도구', 'codex', 'T-1', 'T-2']);
    assert.deepEqual(json.map(task => task.raised), [true, true]);
    assert.notEqual(json[0].worktree, json[1].worktree);
    assert.notDeepEqual(json[0].branches, json[1].branches);
    const [, firstEnd] = span(s, 'T-1', 'build');
    const [secondStart] = span(s, 'T-2', 'build');
    if (limit) assert.ok(secondStart < firstEnd, '겹쳐야 한다');
    else assert.ok(span(s, 'T-1')[1] <= span(s, 'T-2')[0], '순서대로여야 한다');
  }
});

test('이어 고치기: 반려 기록이 있으면 새 워크트리 없이 같은 브랜치에서 반려 커밋과 사유를 받아 고친다', async t => {
  const s = setup(t);
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  s.ledger('다시하기', 'T-1', '--사유', '이름을 고쳐 주세요');
  s.scenario({ 'T-1': { spec: [{ payload: { rejectedCommit: first.commit, rejectedReason: '이름을 고쳐 주세요' } }], build: [{ write: { 'impl.txt': 'v2\n' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.resumed, task.branches, task.raised], [true, ['ai/T-1'], true]);
  assert.equal(fs.realpathSync(task.worktree), fs.realpathSync(first.worktree));
  assert.notEqual(task.commit, first.commit);
  assert.equal(s.gitIn(s.dir, 'rev-list', '--count', 'main..ai/T-1'), '2');
  assert.equal(s.gitIn(s.dir, 'worktree', 'list').split('\n').length, 2);
  const prompt = starts(s).filter(call => call.stage === 'build').at(-1).prompt;
  assert.ok(prompt.includes(`반려 커밋: ${first.commit}`) && prompt.includes('반려 사유: 이름을 고쳐 주세요'));
});

test('이어 고치기: 반려 커밋이 든 브랜치를 못 찾으면 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { spec: [{ payload: { rejectedCommit: 'f'.repeat(40), rejectedReason: '모름' } }] } });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '만들기', '반려 커밋');
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex', 'T-1:specReview:codex']);
});

test('앞 작업 고침 (a): 한글 한 글자의 바이트가 둘로 쪼개져 나와도 확인 명령 실패 출력이 깨지지 않는다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-split-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'split.mjs'), "process.stdout.write(Buffer.from([0xed, 0x95]));\nsetTimeout(() => { process.stdout.write(Buffer.from([0x9c])); process.exit(1); }, 200);\n");
  const result = await runChecks(dir, ['node split.mjs']);
  assert.equal(result.ok, false);
  assert.equal(result.output, '한');
});

test('앞 작업 고침 (b): 제미나이 쓰기 단계는 권한 모드를 확인하지 못하면 권한 실패이고 읽기 단계는 그대로다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'agy'), '#!/bin/sh\nprintf "%s" "$FAKE_OUT"\n', { mode: 0o755 });
  const lines = (...events) => `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  const result = { event: 'result', result: { status: 'SUCCESS', structured_output: { done: true } } };
  const env = out => ({ PATH: `${dir}:/usr/bin:/bin`, FAKE_OUT: out });
  const call = (write, out) => callTool({ tool: 'gemini', cwd: dir, prompt: 'x', timeoutMs: 5000, write, env: env(out), schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } });
  const noInit = lines(result);
  const noMode = lines({ event: 'init', init: {} }, result);
  const proceed = lines({ event: 'init', init: { permission_mode: 'always-proceed' } }, result);
  assert.deepEqual([(await call(true, noInit)).reason, (await call(true, noMode)).reason, (await call(true, proceed)).ok], ['권한', '권한', true]);
  assert.deepEqual([(await call(false, noInit)).ok, (await call(false, noMode)).ok], [true, true]);
});

test('제미나이 쓰기 호출은 sandbox-exec가 없으면 도구를 부르지 않고 권한 실패로 돌려준다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nosb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = await callWritingGemini({ tool: 'gemini', cwd: dir, prompt: 'x', timeoutMs: 5000, write: true, env: { PATH: dir }, schema: { type: 'object' } });
  assert.deepEqual([res.ok, res.reason], [false, '권한']);
});
