import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, calledStages, read, stoppedAt } from './run-fixture.mjs';

const KEYS = ['id', 'worktree', 'branches', 'commit', 'fixes', 'raised', 'raiseOutput', 'checkPassed', 'checkFailures', 'highs', 'others', 'resumed', 'spec', 'specReview'];

test('순서대로 불리고 표준 출력은 JSON 하나, 진행은 표준 오류, 올림은 다른 도구 검토로 적힌다', async t => {
  const s = setup(t);
  const docBefore = read(s.dir, 'docs/tasks/T-1.md');
  const res = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex', 'T-1:specReview:codex', 'T-1:build:codex', 'T-1:review:codex', 'T-1:other:agy', 'T-1:evidence:codex']);
  assert.equal(res.json.length, 1);
  const [task] = res.json;
  assert.deepEqual(Object.keys(task), KEYS);
  assert.equal(task.raised, true);
  assert.match(res.stderr, /\[T-1\] 만들기 시작 \(codex\)/);
  assert.ok(!res.stdout.includes('시작 (codex)'));
  const shown = s.ledger('보기', 'T-1');
  assert.match(shown, /^T-1 \[올림\]/);
  assert.ok(shown.includes(`커밋: ${s.gitIn(s.dir, 'rev-parse', 'ai/T-1')}`));
  assert.equal(task.commit, s.gitIn(s.dir, 'rev-parse', 'ai/T-1'));
  assert.match(shown, /^검토: gemini$/m);
  assert.match(shown, /^증거: 1\. 실행해 봄$/m);
  assert.equal(read(s.dir, 'docs/tasks/T-1.md'), docBefore);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'harness')).sort(), s.harnessBefore);
});

test('인자 오류는 종료 코드 1, 표준 출력은 비고 표준 오류에 이유가 있다', async t => {
  const s = setup(t);
  for (const args of [['T-1'], ['--도구', 'foo', 'T-1'], ['--도구', 'codex', '--모름', 'T-1'], ['--도구', 'codex', '--시간제한', '0'], ['--도구', 'codex', '../x']]) {
    const res = await s.run(args);
    assert.equal(res.status, 1, args.join(' '));
    assert.equal(res.stdout, '');
    assert.ok(res.stderr.trim(), args.join(' '));
  }
  assert.deepEqual(s.called(), []);
});

test('올림: 검토 도구가 비면 --검토 없이 올림을 시도하고, 장부가 거절하면 raised false와 거절 글이 남는다', async t => {
  const refused = setup(t);
  refused.scenario({ 'T-1': { other: [{ exit: 1 }] } });
  const [task] = (await refused.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(task.raised, false);
  assert.match(task.raiseOutput, /올림 거절/);
  assert.match(task.others[0].text, /다른 도구 검토 실패/);
  assert.match(refused.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
  const alone = setup(t, { limits: { codex: 3 } });
  const [raised] = (await alone.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(raised.raised, true);
  assert.doesNotMatch(alone.ledger('보기', 'T-1'), /^검토:/m);
});

test('할 일 적기: 끝 기준이 없으면 specText가 문서 끝에 붙고 맨 위 절은 그대로이며 커밋되지 않는다', async t => {
  const s = setup(t, { bareSpec: true });
  const before = read(s.dir, 'docs/tasks/T-1.md');
  s.scenario({ 'T-1': { spec: [{ payload: { outcome: '썼음', specText: '## 왜 하나\n시험\n\n## 끝 기준\n\n1. 된다\n' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(task.raised, true);
  const after = read(s.dir, 'docs/tasks/T-1.md');
  assert.ok(after.startsWith(before));
  assert.ok(after.endsWith('## 끝 기준\n\n1. 된다\n'));
  assert.match(s.git('status', '--porcelain'), /M docs\/tasks\/T-1\.md/);
});

test('할 일 적기: 끝 기준이 없거나 사용자 원래 말이 든 specText는 문서를 안 바꾸고 멈춘다', async t => {
  const s = setup(t, { bareSpec: true, tools: ['codex', 'codex'] });
  const before = read(s.dir, 'docs/tasks/T-1.md');
  s.scenario({
    'T-1': { spec: [{ payload: { outcome: '썼음', specText: '## 왜 하나\n끝 기준 없음\n' } }] },
    'T-2': { spec: [{ payload: { outcome: '썼음', specText: '## 사용자 원래 말\n바꿈\n\n## 끝 기준\n\n1. 된다\n' } }] },
  });
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-2']);
  stoppedAt(res.json[0], '할 일 적기');
  stoppedAt(res.json[1], '할 일 적기');
  assert.equal(read(s.dir, 'docs/tasks/T-1.md'), before);
  assert.ok(!read(s.dir, 'docs/tasks/T-2.md').includes('바꿈'));
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')));
});

test('할 일 적기: 건너뜀인데 끝 기준이 문서에 없으면 멈춘다', async t => {
  const s = setup(t, { bareSpec: true });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '할 일 적기', '끝 기준');
});

test('할 일 적기: 허락은 장부 [대기]로 남고 그 작업은 만들기로 가지 않는다', async t => {
  const s = setup(t);
  const ask = { kind: '허락', option: '삭제', title: '지워도 되나', description: '설명', choices: '예=지움|아니오=둠', recommend: '아니오', reason: '이유' };
  s.scenario({ 'T-1': { spec: [{ payload: { outcome: '허락', reason: '데이터를 지운다', asks: [ask] } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '할 일 적기', '데이터를 지운다');
  assert.match(s.ledger('질문목록'), /\[대기\] T-1 삭제 지워도 되나/);
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex']);
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')));
});

test('할 일 적기: 결과가 건너뜀이어도 허락을 물었으면 만들기로 가지 않고 멈춘다', async t => {
  const s = setup(t);
  const ask = { kind: '허락', option: '삭제', title: '지워도 되나', description: '설명', choices: '예=지움|아니오=둠', recommend: '아니오', reason: '이유' };
  s.scenario({ 'T-1': { spec: [{ payload: { outcome: '건너뜀', reason: '이미 끝 기준이 있다', asks: [ask] } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '할 일 적기', '허락 대기');
  assert.match(s.ledger('질문목록'), /\[대기\] T-1 삭제 지워도 되나/);
  assert.deepEqual(calledStages(s.called()), ['T-1:spec:codex']);
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')));
});

test('할 일 적기: 확인은 작업이 안 멈추고 기록은 남으며 빈 옵션은 명령에 안 붙는다', async t => {
  const s = setup(t, { bareSpec: true });
  const empty = { option: '', description: '', choices: '', recommend: '', reason: '' };
  const asks = [
    { ...empty, kind: '확인', option: '구조변경', title: '폴더를 나눈다', description: '설명', choices: '나눔=나눈다|안나눔=둔다', recommend: '나눔', reason: '이유' },
    { ...empty, kind: '기록', title: '이름을 정했다', description: '설명', reason: '이유' },
  ];
  s.scenario({ 'T-1': { spec: [{ payload: { outcome: '썼음', asks, specText: '## 끝 기준\n\n1. 된다\n' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(task.raised, true);
  assert.match(s.ledger('질문목록', '--상태', '확인중'), /\[확인중\] T-1 설계확인\(구조변경\) 폴더를 나눈다/);
  assert.equal(JSON.parse(read(s.dir, 'harness/backlog.json')).처리함.length, 1);
});

test('할 일 적기: 대기 질문이 있으면 asks 없이도 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { spec: [{ payload: { pendingQuestions: ['Q-9 [대기] 물음'] } }] } });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '할 일 적기', 'Q-9');
});

test('맞춰보기: passed false나 높음·중간 지적이면 멈추고 워크트리를 안 만든다. 낮음만이면 통과한다', async t => {
  const s = setup(t, { tools: ['codex', 'codex', 'codex'] });
  s.scenario({
    'T-1': { specReview: [{ payload: { passed: false } }] },
    'T-2': { specReview: [{ payload: { findings: [{ level: '중간', text: '흐릿' }] } }] },
    'T-3': { specReview: [{ payload: { findings: [{ level: '낮음', text: '사소' }] } }] },
  });
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-2', 'T-3']);
  stoppedAt(res.json[0], '맞춰보기');
  stoppedAt(res.json[1], '맞춰보기');
  assert.equal(res.json[2].raised, true);
  assert.ok(!fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')));
});

test('만들기: 코드가 첫 줄로 한 커밋을 만들고 바뀐 파일이 없으면 멈춘다', async t => {
  const s = setup(t, { tools: ['codex', 'codex'] });
  s.scenario({ 'T-2': { build: [{ write: {} }] } });
  const res = await s.run(['--도구', 'codex', 'T-1', 'T-2']);
  assert.equal(s.gitIn(s.dir, 'log', '-1', '--format=%s', 'ai/T-1'), 'T-1: 만들었다');
  assert.equal(s.gitIn(s.dir, 'rev-list', '--count', 'main..ai/T-1'), '1');
  stoppedAt(res.json[1], '커밋할 바뀐 파일이 없다');
});

test('돌려보기: 확인 명령이 실패하면 번갈아 보기 없이 고치기로 가고, 바뀐 파일이 확인 명령에 넘어간다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { build: [{ write: { 'impl.txt': 'x', FAIL: '처음\n' } }], fix: [{ write: { FAIL: null, 'fixed.txt': 'x' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual(calledStages(s.called()).slice(2, 6), ['T-1:build:codex', 'T-1:fix:codex', 'T-1:review:codex', 'T-1:other:agy']);
  assert.deepEqual([task.fixes, task.raised], [1, true]);
  assert.equal(s.git('log', '--format=%s', 'main..ai/T-1'), 'T-1: 고쳤다');
  const ci = read(`${s.calls}.ci`).split('\n').filter(Boolean);
  assert.deepEqual(ci, ['FAIL impl.txt', 'fixed.txt impl.txt']);
});

test('돌려보기: 고치기가 다른 파일만 바꿔도 앞서 만든 파일의 위반이 남아 있으면 통과하지 않고 올리지 않는다', async t => {
  const s = setup(t, { checkLine: "- 확인 명령: `node -e \"process.exit(process.argv.slice(1).some(f => require('fs').readFileSync(f, 'utf8').includes('bad')) ? 1 : 0)\" 바뀐 파일들`" });
  s.scenario({ 'T-1': { build: [{ write: { 'impl.txt': 'bad' } }], fix: [1, 2, 3].map(n => ({ write: { [`other${n}.txt`]: 'ok' } })) } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.fixes, task.raised, task.checkPassed], [3, false, false]);
  assert.match(task.checkFailures, /종료 코드 1/);
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('돌려보기: 확인 명령이 설정에 없으면 고치기 없이 멈추고 그 커밋은 남는다', async t => {
  const s = setup(t, { checkLine: null });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '돌려보기', '확인 명령');
  assert.ok(!calledStages(s.called()).some(name => name.includes(':fix:')));
  assert.equal(task.commit, s.gitIn(s.dir, 'rev-parse', 'ai/T-1'));
});
