import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, ok } from './helpers.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
// 설치기가 HOME 아래 명부(~/.harness-starter)에 적으므로 진짜 HOME을 건드리지 않게 임시 HOME을 준다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };

// Claude Code가 Stop 훅에 넘기는 입력 모양(code.claude.com/docs/en/hooks, 2026-10-12 조회)
const stopInput = (dir, active) => ({ session_id: 's', cwd: dir, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: '끝' });

function stop(dir, input) {
  return spawnSync(process.execPath, [path.join(dir, 'harness/stop.mjs')], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8' });
}

const startTask = (dir, title) => {
  const id = ok(dir, '추가', title).match(/T-\d+/)[0];
  ok(dir, '시작', id, '--영역', `src/${id}`, '--확인방법', 'npm test');
  return id;
};

test('with no 진행중 task the stop passes silently', t => {
  const dir = repo(t);
  const empty = stop(dir, stopInput(dir, false));
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
  ok(dir, '추가', '할일만');
  const todo = stop(dir, stopInput(dir, false));
  assert.equal(todo.status, 0, todo.stderr);
  assert.equal(todo.stdout, '', 'a 할일 task is not being worked on');
});

test('with a 진행중 task the stop asks once for a short reason, without telling Claude to go on working', t => {
  const dir = repo(t);
  const ids = [startTask(dir, '하나'), startTask(dir, '둘')];
  const result = stop(dir, stopInput(dir, false));
  assert.equal(result.status, 0, result.stderr);
  const { hookSpecificOutput: output, decision } = JSON.parse(result.stdout);
  assert.equal(decision, undefined, 'feedback, not a hook error');
  assert.equal(output.hookEventName, 'Stop');
  for (const id of ids) assert.match(output.additionalContext, new RegExp(id));
  assert.match(output.additionalContext, /왜 멈추는지 짧게 설명/);
  assert.match(output.additionalContext, /설명한 뒤에는 멈춰도 된다/);
  assert.doesNotMatch(output.additionalContext, /다음 작업|계속|이어서|시작하/);
});

test('once Claude is already continuing because of a stop hook it passes, so there is no loop', t => {
  const dir = repo(t);
  startTask(dir, '하나');
  const result = stop(dir, stopInput(dir, true));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

const ANSWER = '새 답 1개(Q-1 답함). 메인은 node harness/backlog.mjs 질문목록 --상태 답함(고칠것은 --상태 고칠것)으로 읽는다';
const PERMIT = ['허락', 'T-1', '지울까요', '--행동', '삭제', '--설명', '쓰지 않는 열이다', '--보기', '지운다=열이 사라진다|둔다=그대로 남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다'];
const ledgerText = dir => fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8');

const contextOf = result => {
  assert.equal(result.status, 0, result.stderr);
  const { hookSpecificOutput: output, decision } = JSON.parse(result.stdout);
  assert.equal(decision, undefined, 'feedback, not a hook error');
  assert.equal(output.hookEventName, 'Stop');
  return output.additionalContext;
};

test('an unread answer is told at every stop until 질문목록 reads it, joined after the 진행중 reason', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  ok(dir, '답', 'Q-1', '둔다');
  const before = ledgerText(dir);
  assert.equal(contextOf(stop(dir, stopInput(dir, false))), ANSWER, 'told with no 진행중 task');
  assert.equal(contextOf(stop(dir, stopInput(dir, false))), ANSWER, 'the hook does not clear the mark');
  assert.equal(ledgerText(dir), before, 'the hook only reads the ledger');

  const id = startTask(dir, '둘');
  const lines = contextOf(stop(dir, stopInput(dir, false))).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^진행중 작업: ${id}\\. .*설명한 뒤에는 멈춰도 된다\\.$`));
  assert.equal(lines[1], ANSWER);
  assert.doesNotMatch(lines.join('\n'), /다음 작업|계속|이어서|시작하/);
  assert.equal(stop(dir, stopInput(dir, true)).stdout, '', 'stop_hook_active passes even with both');

  ok(dir, '질문목록', '--상태', '답함');
  assert.doesNotMatch(contextOf(stop(dir, stopInput(dir, false))), /새 답/, 'only the 진행중 reason is left');
  assert.equal(contextOf(stop(dir, stopInput(dir, false))).split('\n').length, 1);
});

test('once read with no 진행중 task the stop is silent again', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  ok(dir, '답', 'Q-1', '둔다');
  ok(dir, '질문목록', '--상태', '답함');
  const result = stop(dir, stopInput(dir, false));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a ledger that cannot be read is not swallowed: it fails with a code other than 2, which does not hold the stop', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'harness/backlog.json'), '{ broken');
  const result = stop(dir, stopInput(dir, false));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /harness\/backlog\.json을 읽을 수 없다/);
});

test('the guard refuses AI edits to harness/stop.mjs', t => {
  const dir = fs.realpathSync(repo(t));
  const config = path.join(dir, 'harness/config.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), kinds: { code: { files: ['src/**'], maxFileLines: 300 } } }));
  startTask(dir, '하나');
  const input = { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'harness/stop.mjs') } };
  const result = spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /harness\/stop\.mjs은\(는\) 검사 설정/);
});

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const install = (dir, ...args) => {
  const result = spawnSync(process.execPath, [installer, dir, '--apply', ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const stopHooks = dir => JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).hooks.Stop;

test('the installer adds the Stop hook once with the ledger, and not without it', t => {
  const dir = project(t);
  install(dir);
  assert.deepEqual(stopHooks(dir), [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/harness/stop.mjs"' }] }]);
  assert.ok(fs.existsSync(path.join(dir, 'harness/stop.mjs')));
  assert.doesNotMatch(install(dir), /\[고침\] \.claude\/settings\.json/);
  assert.equal(stopHooks(dir).length, 1, 'running again does not add another');

  const without = project(t);
  install(without, '--without=backlog');
  assert.equal(stopHooks(without), undefined, 'no ledger, no 진행중 task to explain');
  assert.ok(!fs.existsSync(path.join(without, 'harness/stop.mjs')));
});
