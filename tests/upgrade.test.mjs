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
