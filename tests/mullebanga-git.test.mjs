import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorktree, commitAll, readCheckCommands, runChecks, findResumeBranch, openBranch, branchExists, inspectBranch } from '../templates/harness/mullebanga-git.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// 첫 커밋(main)이 있는 임시 git 저장소.
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mgit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'base\n');
  fs.writeFileSync(path.join(dir, 'c d.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, git };
}

// 워크트리 하나와 거기서 한 커밋.
function withBranch(t, name) {
  const { dir, git } = repo(t);
  const made = createWorktree(dir, name);
  fs.writeFileSync(path.join(made.worktree, 'x.txt'), 'x\n');
  const committed = commitAll(made.worktree, '반려될 커밋');
  return { dir, git, made, commit: committed.commit };
}

const worktreesAndBranches = (dir, git) => `${git(dir, 'worktree', 'list')}\n${git(dir, 'branch')}`;

test('createWorktree: 폴더와 ai/ 브랜치가 생기고 기본 브랜치 HEAD에서 갈라진다', t => {
  const { dir, git } = repo(t);
  const made = createWorktree(dir, 'job');
  assert.deepEqual(made, { ok: true, worktree: path.join(dir, '.claude/worktrees/job'), branch: 'ai/job', base: 'main' });
  assert.ok(fs.statSync(made.worktree).isDirectory());
  assert.equal(git(made.worktree, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'main'));
  assert.equal(git(dir, 'branch', '--list', 'ai/job', '--format=%(refname:short)'), 'ai/job');
});

test('createWorktree: 설정한 기본 브랜치에서 가른다', t => {
  const { dir, git } = repo(t);
  git(dir, 'switch', '-q', '-c', 'dev');
  fs.writeFileSync(path.join(dir, 'dev.txt'), 'dev\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'dev');
  git(dir, 'switch', '-q', 'main');
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify({ 일감목록: { 기본브랜치: 'dev' } }));
  const made = createWorktree(dir, 'job');
  assert.equal(made.base, 'dev');
  assert.equal(git(made.worktree, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'dev'));
  assert.notEqual(git(made.worktree, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'main'));
});

test('createWorktree: 같은 이름 두 번째와 없는 기본 브랜치는 이유를 돌려주고 상태를 바꾸지 않는다', t => {
  const { dir, git } = repo(t);
  createWorktree(dir, 'job');
  const before = worktreesAndBranches(dir, git);
  const again = createWorktree(dir, 'job');
  assert.equal(again.ok, false);
  assert.match(again.reason, /job/);
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify({ backlog: { baseBranch: 'nope' } }));
  const missing = createWorktree(dir, 'other');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /nope/);
  assert.equal(worktreesAndBranches(dir, git), before);
  assert.ok(!fs.existsSync(path.join(dir, '.claude/worktrees/other')));
});

test('commitAll: 새 파일과 고친 파일을 커밋하고 git으로 확인한 해시를 돌려준다', t => {
  const { dir, git } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'new\n');
  fs.appendFileSync(path.join(worktree, 'b.txt'), 'more\n');
  const result = commitAll(worktree, '내 메시지');
  assert.equal(result.ok, true);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(result.commit, git(worktree, 'rev-parse', 'HEAD'));
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.equal(git(worktree, 'log', '-1', '--format=%s'), '내 메시지');
});

test('commitAll: 바뀐 것이 없으면 실패하고 HEAD가 그대로다', t => {
  const { dir, git } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const result = commitAll(worktree, 'm');
  assert.equal(result.ok, false);
  assert.match(result.reason, /없다/);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), head);
});

test('commitAll: git add가 index.lock으로 거절되면 바뀐 파일 없음이 아니라 git 출력을 이유로 돌려준다', t => {
  const { dir, git } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  const head = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'new\n');
  fs.writeFileSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'index.lock')), '');
  const result = commitAll(worktree, 'm');
  assert.equal(result.ok, false);
  assert.match(result.reason, /index\.lock/);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), head);
});

test('commitAll: pre-commit 훅이 거절하면 훅 출력을 이유에 담고 HEAD가 그대로다', t => {
  const { dir, git } = repo(t);
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "훅이 막은 사유" >&2\nexit 1\n', { mode: 0o755 });
  const { worktree } = createWorktree(dir, 'job');
  const head = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'new\n');
  const result = commitAll(worktree, 'm');
  assert.equal(result.ok, false);
  assert.match(result.reason, /훅이 막은 사유/);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), head);
});

test('readCheckCommands: 백틱 명령을 차례로 뽑고 없으면 빈 배열', t => {
  const { dir } = repo(t);
  const file = path.join(dir, '.claude/agents/implementer.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '## 이 프로젝트\n- 확인 명령: `a b`, `c`\n- 실행: `x`\n');
  assert.deepEqual(readCheckCommands(dir), ['a b', 'c']);
  fs.writeFileSync(file, '- 실행: `x`\n');
  assert.deepEqual(readCheckCommands(dir), []);
  fs.writeFileSync(file, '- 확인 명령: <테스트·린트 명령>\n');
  assert.deepEqual(readCheckCommands(dir), []);
  fs.writeFileSync(path.join(dir, 'other.md'), '- 확인 명령: `z`\n');
  assert.deepEqual(readCheckCommands(dir, 'other.md'), ['z']);
  assert.deepEqual(readCheckCommands(dir, 'missing.md'), []);
});

test('runChecks: 통과하면 ok, 처음 실패에서 멈추고 명령·종료 코드·출력을 돌려준다', async t => {
  const { dir } = repo(t);
  const pass = 'node -e "process.exit(0)"';
  assert.deepEqual(await runChecks(dir, [pass, pass]), { ok: true });
  const fail = `node -e "console.error('boom'); process.exit(3)"`;
  const result = await runChecks(dir, [pass, fail, `node -e "require('fs').writeFileSync('third.txt','x')"`]);
  assert.equal(result.ok, false);
  assert.equal(result.command, fail);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /boom/);
  assert.ok(!fs.existsSync(path.join(dir, 'third.txt')));
});

test('runChecks: 출력은 뒤쪽 4000자만, 빈 명령 목록은 실패', async t => {
  const { dir } = repo(t);
  const result = await runChecks(dir, [`node -e "process.stdout.write('a'.repeat(5000)+'END'); process.exit(1)"`]);
  assert.equal(result.output.length, 4000);
  assert.ok(result.output.endsWith('END'));
  const empty = await runChecks(dir, []);
  assert.equal(empty.ok, false);
  assert.ok(empty.reason);
});

test('runChecks: 바뀐 파일들이 파일마다 한 인자로 들어가고, 바뀐 것이 없으면 실패한다', async t => {
  const { dir } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  const show = `node -e "console.log(process.argv.slice(1).join('|')); process.exit(1)" 바뀐 파일들`;
  const none = await runChecks(worktree, [show]);
  assert.equal(none.ok, false);
  assert.ok(none.reason);
  assert.equal(none.output, undefined);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'new\n');
  fs.appendFileSync(path.join(worktree, 'b.txt'), 'more\n');
  fs.appendFileSync(path.join(worktree, 'c d.txt'), 'more\n');
  const shown = await runChecks(worktree, [show]);
  assert.deepEqual(shown.output.split('|').sort(), ['a.txt', 'b.txt', 'c d.txt']);
});

test('runChecks: 파일을 지우기만 한 작업도 바뀐 것으로 보고 확인 명령을 돌린다', async t => {
  const { dir } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  fs.rmSync(path.join(worktree, 'b.txt'));
  const failing = await runChecks(worktree, [`node -e "console.log('args=' + process.argv.slice(1).join('|')); process.exit(1)" 바뀐 파일들`]);
  assert.equal(failing.ok, false);
  assert.equal(failing.exitCode, 1);
  assert.match(failing.output, /^args=$/);
});

test('runChecks: 파일명의 백틱·$()·따옴표는 명령으로 실행되지 않고 글자 그대로 넘어간다', async t => {
  const { dir } = repo(t);
  const { worktree } = createWorktree(dir, 'job');
  const names = ['`touch injected`.txt', '$(touch injected2).txt', "it's.txt"];
  for (const name of names) fs.writeFileSync(path.join(worktree, name), 'x\n');
  const show = `node -e "console.log(process.argv.slice(1).join('|')); process.exit(1)" 바뀐 파일들`;
  const shown = await runChecks(worktree, [show]);
  assert.deepEqual(shown.output.split('|').sort(), [...names].sort());
  assert.equal(fs.existsSync(path.join(worktree, 'injected')), false);
  assert.equal(fs.existsSync(path.join(worktree, 'injected2')), false);
});

test('runChecks: 한도를 넘는 새 파일은 커밋 전에 check.mjs가 잡는다', async t => {
  const { dir, git } = repo(t);
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.copyFileSync(path.join(root, 'templates/harness/check.mjs'), path.join(dir, 'harness/check.mjs'));
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify({ patterns: [], ignore: [], kinds: { code: { files: ['scripts/**'], maxFileLines: 300 } } }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'harness');
  const { worktree } = createWorktree(dir, 'job');
  fs.mkdirSync(path.join(worktree, 'scripts'));
  fs.writeFileSync(path.join(worktree, 'scripts/big.mjs'), 'export const x = 1;\n'.repeat(400));
  const result = await runChecks(worktree, ['node harness/check.mjs 바뀐 파일들']);
  assert.equal(result.ok, false);
  assert.match(result.output, /간결함 검사/);
});

test('runChecks: 시간 제한을 넘으면 손자 프로세스까지 끝내고 시간 초과를 돌려준다', async t => {
  const { dir } = repo(t);
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'long.cjs');
  fs.writeFileSync(script, `
    const { spawn } = require('child_process');
    spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `);
  const started = Date.now();
  const result = await runChecks(dir, [`node ${script}`], { seconds: 1 });
  assert.ok(Date.now() - started < 3500);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /시간 초과/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('findResumeBranch: 워크트리가 있으면 그대로, 지워졌으면 같은 브랜치로 다시 만든다', t => {
  const { dir, git, made, commit } = withBranch(t, 'x');
  assert.deepEqual(findResumeBranch(dir, commit), { ok: true, branch: 'ai/x', worktree: made.worktree, created: false });
  fs.rmSync(made.worktree, { recursive: true, force: true });
  assert.deepEqual(findResumeBranch(dir, commit), { ok: true, branch: 'ai/x', worktree: made.worktree, created: true });
  assert.ok(fs.statSync(made.worktree).isDirectory());
  assert.match(git(dir, 'worktree', 'list'), /\.claude\/worktrees\/x\s+[0-9a-f]+ \[ai\/x\]/);
});

test('openBranch: 열린 워크트리는 그대로, 지워졌으면 다시 열고, 브랜치 유무와 진행 상태를 알려 준다', t => {
  const { dir, made } = withBranch(t, 'x');
  assert.deepEqual([branchExists(dir, 'x'), branchExists(dir, 'y')], [true, false]);
  assert.deepEqual(openBranch(dir, 'ai/x'), { ok: true, branch: 'ai/x', worktree: made.worktree, created: false });
  const { commits, dirty } = inspectBranch(made.worktree, 'main');
  assert.deepEqual([commits, dirty], [1, false]);
  fs.writeFileSync(path.join(made.worktree, 'new.txt'), 'n\n');
  assert.equal(inspectBranch(made.worktree, 'main').dirty, true);
  fs.rmSync(made.worktree, { recursive: true, force: true });
  assert.deepEqual(openBranch(dir, 'ai/x'), { ok: true, branch: 'ai/x', worktree: made.worktree, created: true });
});

test('findResumeBranch: ai/ 브랜치가 없거나 둘 이상이거나 없는 커밋이면 만들지 않고 멈춘 이유를 돌려준다', t => {
  const { dir, git, commit } = withBranch(t, 'x');
  fs.writeFileSync(path.join(dir, 'main-only.txt'), 'm\n');
  git(dir, 'add', 'main-only.txt');
  git(dir, 'commit', '-q', '-m', 'main only');
  const mainOnly = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'branch', 'ai/y', 'ai/x');
  const before = worktreesAndBranches(dir, git);
  const none = findResumeBranch(dir, mainOnly);
  assert.equal(none.ok, false);
  assert.ok(none.stopReason);
  const two = findResumeBranch(dir, commit);
  assert.equal(two.ok, false);
  assert.match(two.stopReason, /ai\/x/);
  assert.match(two.stopReason, /ai\/y/);
  assert.equal(findResumeBranch(dir, 'f'.repeat(40)).ok, false);
  assert.equal(worktreesAndBranches(dir, git), before);
});

test('이 모듈은 일감 목록(장부) 파일을 만들지 않는다', t => {
  const { dir, commit } = withBranch(t, 'x');
  findResumeBranch(dir, commit);
  const ledgerFiles = fs.readdirSync(dir, { recursive: true }).filter(name => path.basename(name).startsWith('backlog'));
  assert.deepEqual(ledgerFiles, []);
});
