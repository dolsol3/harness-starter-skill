import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, stoppedAt } from './run-fixture.mjs';

const stages = s => s.called().filter(call => call.ph === 'start').map(call => call.stage);
const PERMIT = ['허락', 'T-1', '지울까', '--행동', '삭제', '--설명', '설명', '--보기', '예=지움|아니오=둠', '--추천', '아니오', '--이유', '이유'];
const worktreeLines = s => s.git('worktree', 'list').split('\n').length;
// 첫 실행은 올림 증거 부족으로 멈추고, 다시 돌리면 증거가 나온다.
const evidenceLater = [{ payload: { unconfirmed: ['실행 못 함'] } }, {}];

test('이어 가기: 커밋 뒤 멈춘 작업을 다시 돌리면 할 일 적기·만들기 없이 같은 브랜치에서 올린다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { evidence: evidenceLater } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(first, '증거 부족');
  const before = s.git('rev-list', '--count', 'main..ai/T-1');
  const afterFirst = stages(s).length;
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed, task.spec], [true, true, null]);
  assert.deepEqual(stages(s).slice(afterFirst).sort(), ['evidence', 'other', 'review']);
  assert.equal(s.git('branch', '--list', 'ai/*').split('\n').length, 1);
  assert.equal(s.git('rev-list', '--count', 'main..ai/T-1'), before);
  assert.equal(task.commit, first.commit);
});

test('이어 가기: 확인 실패로 커밋 없이 남은 변경은 만들기 없이 고치기로 이어 통과시킨다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { build: [{ write: { 'impl.txt': 'impl\n', FAIL: 'x' } }], fix: [{}, {}, {}, { write: { FAIL: null } }] } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([first.stopped, first.fixes, first.commit, first.checkPassed], [undefined, 3, null, false]);
  const ciLines = () => fs.readFileSync(`${s.calls}.ci`, 'utf8').split('\n').filter(Boolean);
  const seen = ciLines().length;
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed, task.fixes], [true, true, 1]);
  assert.equal(stages(s).filter(stage => stage === 'build').length, 1);
  assert.ok(ciLines()[seen].includes('impl.txt'), ciLines()[seen]);
  assert.equal(s.git('rev-list', '--count', 'main..ai/T-1'), '1');
  assert.match(s.git('log', '-1', '--format=%s', 'ai/T-1'), /^T-1: 고쳤다$/);
});

test('이어 가기: 변경을 확인 명령이 통과하면 만들기 없이 코드가 커밋한다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { build: [{ write: { 'impl.txt': 'impl\n', FAIL: 'x' } }] } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(first.fixes, 3);
  fs.rmSync(path.join(s.dir, '.claude/worktrees/T-1/FAIL'));
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed], [true, true]);
  assert.equal(s.git('log', '-1', '--format=%s', 'ai/T-1'), 'T-1: 앞서 멈춘 작업을 이어 간다');
  assert.equal(stages(s).filter(stage => stage === 'build').length, 1);
});

test('이어 가기: 확인 명령이 만든 변경도 커밋해 검사한 상태 그대로 올린다', async t => {
  const s = setup(t, { checkLine: "- 확인 명령: `node -e \"require('fs').appendFileSync('impl.txt', 'check\\\\n')\"`" });
  s.scenario({ 'T-1': { evidence: evidenceLater } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(first, '증거 부족');
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed], [true, true]);
  assert.notEqual(task.commit, first.commit);
  assert.equal(task.commit, s.git('rev-parse', 'ai/T-1'));
  assert.equal(s.gitIn(task.worktree, 'status', '--porcelain'), '');
});

test('이어 가기: 아직 한 일이 없으면 새 워크트리 없이 같은 워크트리에서 만들기를 부른다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { build: [{ write: {} }, {}] } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(first, '만들기', '바뀐 파일이 없다');
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed], [true, true]);
  assert.equal(stages(s).filter(stage => stage === 'build').length, 2);
  assert.equal(fs.realpathSync(task.worktree), fs.realpathSync(path.join(s.dir, '.claude/worktrees/T-1')));
  assert.equal(worktreeLines(s), 2);
});

test('이어 가기: 할 일 적기를 다시 부르지 않아 기록이 겹치지 않는다', async t => {
  const s = setup(t, { bareSpec: true });
  const asks = [{ kind: '기록', title: '이름을 정했다', option: '', description: '설명', choices: '', recommend: '', reason: '이유' }];
  s.scenario({ 'T-1': { spec: [{ payload: { outcome: '썼음', asks, specText: '## 끝 기준\n\n1. 된다\n' } }], evidence: evidenceLater } });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '증거 부족');
  const records = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8')).처리함.length;
  assert.equal(records(), 1);
  assert.equal((await s.run(['--도구', 'codex', 'T-1'])).json[0].raised, true);
  assert.equal(records(), 1);
  assert.equal(stages(s).filter(stage => stage === 'spec').length, 1);
});

test('이어 가기: 사람이 올린 허락 질문이 대기 중이면 브랜치와 작업 폴더를 건드리지 않고 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { evidence: evidenceLater } });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '증거 부족');
  const head = s.git('rev-parse', 'ai/T-1');
  fs.writeFileSync(path.join(s.dir, '.claude/worktrees/T-1/untracked.txt'), 'keep\n');
  s.ledger(...PERMIT);
  const afterFirst = stages(s).length;
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '답을 기다리는 허락 질문이 있어 쓰기 전에 멈춤');
  assert.equal(stages(s).length, afterFirst);
  assert.equal(s.git('rev-parse', 'ai/T-1'), head);
  assert.equal(fs.readFileSync(path.join(s.dir, '.claude/worktrees/T-1/untracked.txt'), 'utf8'), 'keep\n');
});

test('이어 가기: 워크트리 폴더만 지워졌으면 같은 브랜치로 다시 열어 이어 간다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { evidence: evidenceLater } });
  const [first] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  s.git('worktree', 'remove', '--force', first.worktree);
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.deepEqual([task.raised, task.resumed, task.branches], [true, true, ['ai/T-1']]);
  assert.ok(fs.statSync(task.worktree).isDirectory());
  assert.equal(worktreeLines(s), 2);
});
