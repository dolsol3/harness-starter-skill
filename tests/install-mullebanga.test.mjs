import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));
// 설치기가 HOME 아래 명부에 적으므로 진짜 HOME을 건드리지 않게 임시 HOME을 준다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const FILES = ['mullebanga', 'mullebanga-call', 'mullebanga-git', 'mullebanga-prompts', 'mullebanga-review', 'mullebanga-steps'].map(name => `harness/${name}.mjs`);
const WORKTREES = '.claude/worktrees/';
const EXCLUDE = '.git/info/exclude';

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const template = rel => fs.readFileSync(path.join(templates, path.basename(rel)), 'utf8');
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const count = (text, line) => text.split('\n').filter(l => l === line).length;

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mulle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  return dir;
}

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('preview lists the six files as new and writes nothing; --apply copies them from templates', t => {
  const dir = repo(t);
  const preview = install(dir);
  for (const rel of FILES) assert.match(preview, new RegExp(`\\[새로 만듦\\] ${rel}`));
  assert.match(preview, /\[고침\] \.git\/info\/exclude/);
  assert.equal(fs.existsSync(path.join(dir, FILES[0])), false);
  install(dir, '--apply');
  for (const rel of FILES) assert.equal(read(dir, rel), template(rel));
});

test('a second --apply leaves the files as they are and the exclude line appears once', t => {
  const dir = repo(t);
  install(dir, '--apply');
  const again = install(dir, '--apply');
  for (const rel of FILES) assert.match(again, new RegExp(`\\[그대로\\] ${rel}`));
  assert.equal(count(read(dir, EXCLUDE), WORKTREES), 1);
});

test('a changed file is skipped without --upgrade and replaced with it; an old exclude gets the line back and keeps the user line', t => {
  const dir = repo(t);
  install(dir, '--apply');
  const changed = 'harness/mullebanga-call.mjs';
  fs.writeFileSync(path.join(dir, changed), '// 내가 고침\n');
  assert.match(install(dir, '--apply'), new RegExp(`\\[건너뜀\\] ${changed}`));
  assert.equal(read(dir, changed), '// 내가 고침\n');
  fs.writeFileSync(path.join(dir, EXCLUDE), `${read(dir, EXCLUDE).replace(`${WORKTREES}\n`, '')}my-own-line\n`);
  assert.match(install(dir, '--apply', '--upgrade'), new RegExp(`\\[고침\\] ${changed}`));
  assert.equal(read(dir, changed), template(changed));
  assert.equal(count(read(dir, EXCLUDE), WORKTREES), 1);
  assert.equal(count(read(dir, EXCLUDE), 'my-own-line'), 1);
});

test('--without=backlog and a subfolder install do not copy the files', t => {
  const dir = repo(t);
  install(dir, '--apply', '--without=backlog');
  for (const rel of FILES) assert.equal(fs.existsSync(path.join(dir, rel)), false);
  const sub = path.join(repo(t), 'sub');
  fs.mkdirSync(sub);
  install(sub, '--apply');
  for (const rel of FILES) assert.equal(fs.existsSync(path.join(sub, rel)), false);
});

test('installed mullebanga loads all imports and stops at the missing role files, or at the missing tool', t => {
  const dir = repo(t);
  install(dir, '--apply');
  const run = (...args) => spawnSync(process.execPath, ['harness/mullebanga.mjs', ...args], { cwd: dir, encoding: 'utf8', env });
  const missingRoles = run('--도구', 'codex');
  assert.equal(missingRoles.status, 1);
  assert.match(missingRoles.stderr, /mullebanga: 역할 안내문 파일이 없다/);
  assert.doesNotMatch(missingRoles.stderr, /Cannot find module/);
  const noTool = run();
  assert.notEqual(noTool.status, 0);
  assert.match(noTool.stderr, /--도구는 codex\|gemini\|claude 중 하나여야 한다/);
});

test('a worktree under .claude/worktrees is not shown by status and is not staged as a gitlink', t => {
  const dir = repo(t);
  install(dir, '--apply');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(dir, 'worktree', 'add', '-q', '-b', 'x', '.claude/worktrees/x', 'HEAD');
  assert.doesNotMatch(git(dir, 'status', '--short'), /\.claude\/worktrees/);
  git(dir, 'add', '-A');
  assert.doesNotMatch(git(dir, 'ls-files', '--stage'), /^160000/m);
});
