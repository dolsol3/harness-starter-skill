import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, stoppedAt } from './run-fixture.mjs';
import { taskInfo } from '../templates/harness/mullebanga-steps.mjs';

const KEYS = ['id', 'worktree', 'branches', 'commit', 'fixes', 'raised', 'raiseOutput', 'checkPassed', 'checkFailures', 'highs', 'others', 'resumed', 'spec', 'specReview'];
const stages = s => s.called().filter(call => call.ph === 'start').map(call => call.stage);
const PERMIT = ['허락', 'T-1', '지울까', '--행동', '삭제', '--설명', '설명', '--보기', '예=지움|아니오=둠', '--추천', '아니오', '--이유', '이유'];
const withCriteria = (s, criteria, heading = '## 끝 기준') => fs.writeFileSync(path.join(s.dir, 'docs/tasks/T-1.md'), `# T-1 시험 작업\n\n## 사용자 원래 말\n\n- 사용자: "시험"\n\n${heading}\n\n${criteria}`);

test('허락 대기: 보기 출력이 줄 제한에 잘려 질문 줄을 다 못 읽으면 쓰기 전에 멈춘다', async t => {
  const s = setup(t);
  s.editConfig(config => { config.일감목록.출력줄수 = 2; });
  s.scenario({ 'T-1': { specReview: [{ ledger: { cwd: s.dir, args: PERMIT } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '출력줄수');
  assert.ok(!stages(s).includes('build'));
  assert.equal(fs.existsSync(path.join(s.dir, '.claude/worktrees/T-1')), false);
});

test('허락 대기: 쓰기 직전에 보기 명령이 실패하면 지나가지 않고 멈춘다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { specReview: [{ write: { 'harness/backlog.json': '{깨짐' } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '허락 질문을 확인하지 못해');
  assert.ok(!stages(s).includes('build'));
});

test('끝 기준: 탭으로 띄우거나 들여쓴 번호도 읽고 번호마다 증거가 있어야 올린다', async t => {
  const s = setup(t);
  withCriteria(s, '1.\t첫째\n 2)\t둘째\n');
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '2번 증거 없음');
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('끝 기준: 절에서 번호를 하나도 못 읽거나 제목이 `## 끝 기준`이 아니면 증거를 모으지 않고 멈춘다', async t => {
  for (const [criteria, heading] of [['- 번호 없는 기준\n'], ['1. 가짜 기준\n', '## 끝 기준 아님']]) {
    const s = setup(t);
    withCriteria(s, criteria, heading);
    const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
    stoppedAt(task, '끝 기준');
    assert.ok(!stages(s).includes('evidence'));
    assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
  }
});

test('끝 기준: 기준 안 코드 블록의 `## ` 줄 뒤 번호도 세고, specText 제목이 `## 끝 기준 아님`이면 문서를 안 바꾸고 멈춘다', async t => {
  const s = setup(t);
  withCriteria(s, '1. 다음 절이 있다:\n```md\n## 예시 절\n```\n2. 둘째\n');
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '2번 증거 없음');
  const bare = setup(t, { bareSpec: true });
  const before = fs.readFileSync(path.join(bare.dir, 'docs/tasks/T-1.md'), 'utf8');
  bare.scenario({ 'T-1': { spec: [{ payload: { outcome: '썼음', specText: '## 왜 하나\n시험\n\n## 끝 기준 아님\n\n1. 가짜\n' } }] } });
  stoppedAt((await bare.run(['--도구', 'codex', 'T-1'])).json[0], '할 일 적기');
  assert.equal(fs.readFileSync(path.join(bare.dir, 'docs/tasks/T-1.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(bare.dir, '.claude/worktrees/T-1')), false);
});

test('동시상한: 단계 도구·바깥 검토에도 0을 지키고, 숫자가 아닌 값이나 일감 목록을 못 읽은 작업도 결과 칸이 빠지지 않는다', async t => {
  const s = setup(t);
  s.editConfig(config => { config.일감목록.동시상한.gemini = 0; config.단계모델.할일적기 = { 도구: 'gemini' }; });
  stoppedAt((await s.run(['--도구', 'codex', 'T-1'])).json[0], '동시상한.gemini');
  assert.ok(!s.called().some(call => call.tool === 'agy'));
  s.editConfig(config => { delete config.단계모델.할일적기; });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  assert.equal(task.raised, true);
  assert.ok(!s.called().some(call => call.tool === 'agy'));
  const odd = setup(t);
  odd.editConfig(config => { config.일감목록.동시상한.codex = '없음'; });
  stoppedAt((await odd.run(['--도구', 'codex', 'T-1'])).json[0], '동시상한');
  const cut = setup(t);
  cut.editConfig(config => { config.일감목록.출력줄수 = 2; });
  stoppedAt((await cut.run(['--도구', 'codex'])).json[0], '일감 목록에서 읽지 못했다');
});

test('끝 기준: 빈 증거는 증거로 받지 않는다', async t => {
  const s = setup(t);
  s.scenario({ 'T-1': { evidence: [{ payload: { items: [{ no: '1', evidence: '  ' }], unconfirmed: [] } }] } });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '1번 증거 없음');
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('동시상한 0: 그 도구로는 돌리지 않고 이유를 남기며, 멈춘 결과도 공통 칸을 다 둔다', async t => {
  const s = setup(t);
  s.editConfig(config => { config.일감목록.동시상한.codex = 0; });
  const res = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(res.status, 0, res.stderr);
  const [task] = res.json;
  stoppedAt(task, '동시상한');
  assert.deepEqual(Object.keys(task), [...KEYS, 'stopped', 'reason']);
  assert.deepEqual(s.called(), []);
});

test('맡길곳과 실제 작성 도구가 달라 바깥 검토가 맡길곳과 같으면 올리기 전에 이유를 남기고 멈춘다', async t => {
  const s = setup(t);
  s.editConfig(config => { config.단계모델.만들기 = { 도구: 'gemini' }; });
  const [task] = (await s.run(['--도구', 'codex', 'T-1'])).json;
  stoppedAt(task, '맡길곳');
  assert.deepEqual(Object.keys(task), [...KEYS, 'stopped', 'reason']);
  assert.ok(!stages(s).includes('evidence'));
  assert.match(s.ledger('보기', 'T-1'), /^T-1 \[진행중\]/);
});

test('읽기 단계 claude는 Bash를 통째로 받지 않고 읽기 명령만 받으며, 쓰기 단계는 Bash를 받는다', async t => {
  const s = setup(t, { tools: ['claude'] });
  const [task] = (await s.run(['--도구', 'claude', 'T-1'])).json;
  assert.equal(task.raised, true);
  const allowed = call => call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--'));
  for (const call of s.called().filter(item => item.ph === 'start' && item.tool === 'claude')) {
    const tools = allowed(call);
    if (call.stage === 'build') assert.deepEqual(tools, ['Bash']);
    else {
      assert.ok(tools.length && tools.every(rule => /^Bash\((node harness\/backlog\.mjs 보기|git) /.test(rule)), `${call.stage}: ${tools}`);
      assert.ok(tools.includes('Bash(node harness/backlog.mjs 보기 *)'), call.stage);
    }
  }
});

// 질문 페이지가 꺼져 있으면 backlog.mjs가 보기 출력 앞에 다시 켠 줄과 링크 줄을 찍는다(메인이 겪음). 그 출력을 그대로 내는 가짜 일감 목록으로 읽는다.
test('보기 앞에 질문 페이지 다시 켠 줄이 붙어도 상태·맡길곳·허락 대기를 읽는다', t => {
  const s = setup(t);
  s.ledger(...PERMIT);
  const shown = `질문 페이지를 다시 켰다\nhttp://127.0.0.1:1/?token=x\n${s.ledger('보기', 'T-1')}\n`;
  const root = fs.mkdtempSync(path.join(s.aux, 'revive-'));
  fs.mkdirSync(path.join(root, 'harness'));
  fs.cpSync(path.join(s.dir, 'docs'), path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'harness/backlog.mjs'), `process.stdout.write(${JSON.stringify(shown)});\n`);
  const info = taskInfo(root, 'T-1');
  assert.deepEqual([info.status, info.tool, info.waiting.length], ['진행중', 'codex', 1]);
});
