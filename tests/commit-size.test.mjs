// 커밋 크기 상한 중 파일 수: 한 커밋에 줄을 더한, 한도가 있는 종류의 파일이 maxCommitFiles(없으면 15)를 넘으면 거절한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

const KINDS = {
  code: { files: ['src/**'], maxLineLength: 120 },
  free: { files: ['free/**'] },
  docs: { files: ['**/*.md'] },
};

// 검사기와 설치기가 만드는 것과 같은 검사기 줄의 pre-commit을 넣고 첫 커밋을 한 임시 git 저장소.
function repo(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-commit-size-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  setConfig(dir, config => { config.kinds = KINDS; });
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nnode harness/check.mjs --staged || exit 1\n', { mode: 0o755 });
  write(dir, files);
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
  return { dir, git };
}

function setConfig(dir, change) {
  const file = path.join(dir, 'harness/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(config);
  fs.writeFileSync(file, JSON.stringify(config));
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

// 폴더 아래 파일 n개, 파일마다 한 줄.
const many = (folder, n, ext = 'js') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${folder}/f${i}.${ext}`, `run(${i});\n`]));

function check(dir, args, input) {
  return spawnSync(process.execPath, ['harness/check.mjs', ...args], { cwd: dir, encoding: 'utf8', input });
}

function commit(dir) {
  return spawnSync('git', ['commit', '-q', '-m', 'work'], { cwd: dir, encoding: 'utf8' });
}

test('pre-commit refuses 16 limited files in one commit and lets 15 through', t => {
  const { dir, git } = repo(t);
  write(dir, many('src', 16));
  git('add', '-A');
  const refused = commit(dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /이번 커밋에 고친 파일이 16개: 15개 안으로 나눠서 커밋한다/);
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1', 'no commit was made');
  git('rm', '-q', '--cached', 'src/f15.js');
  assert.equal(commit(dir).status, 0, '15 files fit');
});

test('files of no kind and of kinds without a limit are not counted', t => {
  const { dir, git } = repo(t);
  write(dir, { ...many('src', 15), ...many('docs', 20, 'md'), ...many('free', 20), ...many('data', 20, 'csv') });
  git('add', '-A');
  const result = check(dir, ['--staged']);
  assert.equal(result.status, 0, result.stdout);
});

test('files with only deleted lines, deleted files and moved files are not counted', t => {
  const base = Object.fromEntries(Object.entries(many('src', 20)).map(([name, text]) => [name, `${text}keep();\n`]));
  const { dir, git } = repo(t, { ...base, ...many('src/gone', 20), ...many('src/old', 20) });
  write(dir, Object.fromEntries(Object.keys(base).map(name => [name, 'keep();\n'])));
  git('rm', '-q', '-r', 'src/gone');
  git('mv', 'src/old', 'src/new');
  write(dir, { 'src/added.js': 'run();\n' });
  git('add', '-A');
  const result = check(dir, ['--staged']);
  assert.equal(result.status, 0, result.stdout);
});

test('files that come in unchanged from the merged branch are not counted', t => {
  const { dir, git } = repo(t);
  git('switch', '-q', '-c', 'other');
  write(dir, many('src/theirs', 20));
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'other');
  git('switch', '-q', '-');
  write(dir, { 'src/mine.js': 'run();\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'main');
  spawnSync('git', ['merge', '--no-commit', '-q', 'other'], { cwd: dir });
  const result = check(dir, ['--staged']);
  assert.equal(result.status, 0, result.stdout);
});

test('maxCommitFiles in config sets the limit, and 15 is used when it is missing', t => {
  const { dir, git } = repo(t);
  setConfig(dir, config => { config.maxCommitFiles = 3; });
  write(dir, many('src', 4));
  git('add', 'src');
  assert.match(check(dir, ['--staged']).stdout, /이번 커밋에 고친 파일이 4개: 3개 안으로/);
  setConfig(dir, config => { delete config.maxCommitFiles; });
  assert.equal(check(dir, ['--staged']).status, 0);
  write(dir, many('src', 16));
  git('add', 'src');
  assert.match(check(dir, ['--staged']).stdout, /이번 커밋에 고친 파일이 16개: 15개 안으로/);
});

test('file mode and hook mode do not count files', t => {
  const { dir } = repo(t);
  const files = many('src', 16);
  write(dir, files);
  const fileMode = check(dir, Object.keys(files));
  assert.equal(fileMode.status, 0, fileMode.stdout);
  const patch = ['*** Begin Patch', ...Object.keys(files).flatMap(name => [`*** Add File: ${name}`, '+run();']), '*** End Patch'];
  const input = { tool_name: 'apply_patch', tool_input: { command: patch.join('\n') }, cwd: dir };
  const hook = check(dir, ['--hook'], JSON.stringify(input));
  assert.equal(hook.status, 0, hook.stderr);
});
