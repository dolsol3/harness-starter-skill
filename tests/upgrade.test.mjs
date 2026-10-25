import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
// 설치기가 HOME 아래 명부(~/.harness-starter)에 적으므로 진짜 HOME을 건드리지 않게 임시 HOME을 준다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));
const COMMAND_FILES = ['backlog', 'ledger', 'questions', 'page', 'patch', 'serve', 'guard', 'stop'].map(name => `harness/${name}.mjs`);
const HOOK = '.git/hooks/pre-commit';
const GUARD_LINE = 'if [ -f harness/guard.mjs ]; then node harness/guard.mjs --staged || exit 1; fi';

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// 장부를 설치한 저장소를 옛 설치처럼 만든다: 명령 파일은 옛 글, pre-commit에는 막는 훅 줄이 없다.
function oldInstall(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  install(dir, '--apply');
  for (const rel of COMMAND_FILES) fs.writeFileSync(path.join(dir, rel), `// 옛 ${rel}\n`);
  fs.writeFileSync(path.join(dir, HOOK), read(dir, HOOK).replace(`${GUARD_LINE}\n`, ''));
  return dir;
}

test('--upgrade shows then replaces the installed ledger commands and adds the guard line to the old pre-commit; without it they are left alone', t => {
  const dir = oldInstall(t);
  const oldHook = read(dir, HOOK);
  assert.ok(!oldHook.includes('guard.mjs'));

  const plain = install(dir, '--apply');
  for (const rel of COMMAND_FILES) assert.match(plain, new RegExp(`\\[건너뜀\\] ${rel.replace('.', '\\.')}`), rel);
  assert.equal(read(dir, HOOK), oldHook, 'without --upgrade the pre-commit is not touched');

  const preview = install(dir, '--upgrade');
  for (const rel of COMMAND_FILES) assert.match(preview, new RegExp(`\\[고침\\] ${rel.replace('.', '\\.')}`), rel);
  assert.match(preview, /\[고침\] \.git\/hooks\/pre-commit/);
  assert.equal(read(dir, 'harness/ledger.mjs'), '// 옛 harness/ledger.mjs\n', 'the preview writes nothing');

  install(dir, '--apply', '--upgrade');
  for (const rel of COMMAND_FILES) assert.equal(read(dir, rel), fs.readFileSync(path.join(templates, path.basename(rel)), 'utf8'), rel);
  assert.equal(read(dir, HOOK), `${oldHook.trimEnd()}\n${GUARD_LINE}\n`);
  assert.doesNotMatch(install(dir, '--apply', '--upgrade'), /\[(고침|건너뜀|새로 만듦)\]/, 'a second upgrade changes nothing');
  assert.equal(spawnSync(process.execPath, ['harness/backlog.mjs', '목록'], { cwd: dir, encoding: 'utf8' }).status, 0, 'the upgraded commands run');
});

test('--upgrade keeps the run permission of the pre-commit as it is, so a hook someone switched off stays off', { skip: process.platform === 'win32' && '실행 권한이 다르다' }, t => {
  const dir = oldInstall(t);
  fs.chmodSync(path.join(dir, HOOK), 0o644);
  install(dir, '--apply', '--upgrade');
  assert.ok(read(dir, HOOK).includes(GUARD_LINE));
  assert.equal(fs.statSync(path.join(dir, HOOK)).mode & 0o777, 0o644);
});

test('--upgrade leaves a pre-commit that another tool wrote alone', t => {
  const dir = oldInstall(t);
  const other = '#!/bin/sh\necho 다른 도구의 훅\n';
  fs.writeFileSync(path.join(dir, HOOK), other);
  assert.match(install(dir, '--apply', '--upgrade'), /\[건너뜀\] \.git\/hooks\/pre-commit/);
  assert.equal(read(dir, HOOK), other);
});

test('--upgrade replaces old $(git rev-parse --show-toplevel) commands in .codex/hooks.json and .agents/hooks.json while keeping user hooks and other groups', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-upgrade-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  install(dir, '--apply');
  const oldCheck = 'node "$(git rev-parse --show-toplevel)/harness/check.mjs" --hook';
  const oldGuard = 'node "$(git rev-parse --show-toplevel)/harness/guard.mjs" --hook';
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 내 훅' }] };
  const oldCodex = {
    hooks: {
      PostToolUse: [{ matcher: 'apply_patch|Edit|Write', hooks: [{ type: 'command', command: oldCheck }] }],
      PreToolUse: [userHook, { matcher: 'apply_patch|Bash', hooks: [{ type: 'command', command: oldGuard }] }],
    },
  };
  const oldAgents = {
    lint: { PostToolUse: [] },
    'harness-starter': {
      PostToolUse: [{ matcher: 'write_to_file|replace_file_content|multi_replace_file_content', hooks: [{ type: 'command', command: oldCheck }] }],
      PreToolUse: [{ matcher: 'write_to_file|replace_file_content|multi_replace_file_content|run_command|view_file', hooks: [{ type: 'command', command: oldGuard }] }],
    },
  };
  fs.writeFileSync(path.join(dir, '.codex/hooks.json'), `${JSON.stringify(oldCodex, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, '.agents/hooks.json'), `${JSON.stringify(oldAgents, null, 2)}\n`);

  const plain = install(dir, '--apply');
  assert.match(plain, /\[그대로\] \.codex\/hooks\.json/);
  assert.match(plain, /\[그대로\] \.agents\/hooks\.json/);
  assert.deepEqual(JSON.parse(read(dir, '.codex/hooks.json')), oldCodex);
  assert.deepEqual(JSON.parse(read(dir, '.agents/hooks.json')), oldAgents);

  const preview = install(dir, '--upgrade');
  assert.match(preview, /\[고침\] \.codex\/hooks\.json/);
  assert.match(preview, /\[고침\] \.agents\/hooks\.json/);
  assert.deepEqual(JSON.parse(read(dir, '.codex/hooks.json')), oldCodex);
  assert.deepEqual(JSON.parse(read(dir, '.agents/hooks.json')), oldAgents);

  install(dir, '--apply', '--upgrade');
  const codex = JSON.parse(read(dir, '.codex/hooks.json')).hooks;
  assert.equal(codex.PostToolUse[0].hooks[0].command, 'node harness/check.mjs --hook');
  assert.deepEqual(codex.PreToolUse, [userHook, { matcher: 'apply_patch|Bash', hooks: [{ type: 'command', command: 'node harness/guard.mjs --hook' }] }]);
  const agents = JSON.parse(read(dir, '.agents/hooks.json'));
  assert.deepEqual(agents.lint, { PostToolUse: [] });
  assert.equal(agents['harness-starter'].PostToolUse[0].hooks[0].command, 'node ../harness/check.mjs --hook');
  assert.equal(agents['harness-starter'].PreToolUse[0].hooks[0].command, 'node ../harness/guard.mjs --hook');
  const second = install(dir, '--apply', '--upgrade');
  assert.match(second, /\[그대로\] \.codex\/hooks\.json/);
  assert.match(second, /\[그대로\] \.agents\/hooks\.json/);
  assert.doesNotMatch(second, /\[고침\]/);

  fs.writeFileSync(path.join(dir, '.codex/hooks.json'), `${JSON.stringify(oldCodex, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, '.agents/hooks.json'), `${JSON.stringify(oldAgents, null, 2)}\n`);
  install(dir, '--apply', '--upgrade', '--without=backlog');
  assert.equal(JSON.parse(read(dir, '.codex/hooks.json')).hooks.PreToolUse[1].hooks[0].command, 'node harness/guard.mjs --hook');
  assert.equal(JSON.parse(read(dir, '.agents/hooks.json'))['harness-starter'].PreToolUse[0].hooks[0].command, 'node ../harness/guard.mjs --hook');

  const noBacklog = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-upgrade-nobacklog-'));
  t.after(() => fs.rmSync(noBacklog, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: noBacklog });
  install(noBacklog, '--apply', '--without=backlog');
  fs.writeFileSync(path.join(noBacklog, '.codex/hooks.json'), JSON.stringify({ hooks: { PostToolUse: oldCodex.hooks.PostToolUse } }));
  fs.writeFileSync(path.join(noBacklog, '.agents/hooks.json'), JSON.stringify({ 'harness-starter': { PostToolUse: oldAgents['harness-starter'].PostToolUse } }));
  install(noBacklog, '--apply', '--upgrade', '--without=backlog');
  const nbCodex = JSON.parse(read(noBacklog, '.codex/hooks.json')).hooks;
  assert.equal(nbCodex.PostToolUse[0].hooks[0].command, 'node harness/check.mjs --hook');
  assert.equal(nbCodex.PreToolUse, undefined);
  const nbAgents = JSON.parse(read(noBacklog, '.agents/hooks.json'))['harness-starter'];
  assert.equal(nbAgents.PostToolUse[0].hooks[0].command, 'node ../harness/check.mjs --hook');
  assert.equal(nbAgents.PreToolUse, undefined);

  const claudeHooks = { ...JSON.parse(read(dir, '.claude/settings.json')).hooks, ...oldCodex.hooks };
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), `${JSON.stringify({ hooks: claudeHooks }, null, 2)}\n`);
  assert.match(install(dir, '--apply', '--upgrade'), /\[그대로\] \.claude\/settings\.json/);
  assert.deepEqual(JSON.parse(read(dir, '.claude/settings.json')).hooks, claudeHooks);
});
