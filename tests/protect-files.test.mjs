import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repo, ok } from './helpers.mjs';

// 진행중인 작업이 있는 임시 저장소. 지키는 파일은 작업이 있어도 편집 도구로 고치지 못하고 읽기만 된다.
function project(t) {
  const dir = fs.realpathSync(repo(t));
  ok(dir, '추가', '일');
  ok(dir, '시작', 'T-1', '--영역', 'src', '--확인방법', 'npm test');
  return dir;
}

function guard(dir, input, cwd = dir) {
  const result = spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd, input: JSON.stringify(input), encoding: 'utf8' });
  assert.ok([0, 2].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  return result;
}

const blocked = (result, name) => {
  assert.equal(result.status, 2, `${name}은(는) 거절돼야 한다`);
  assert.ok(result.stderr.includes(`${name}은(는) 지키는 파일`), result.stderr);
};
const passed = (result, label) => assert.equal(result.status, 0, `${label}: ${result.stderr}`);

// 세 도구가 훅에 넘기는 입력 모양(tests/tool-hooks.test.mjs와 같다).
const claude = (dir, tool, file) => ({ cwd: dir, tool_name: tool, tool_input: { file_path: file } });
const patch = file => ['*** Begin Patch', `*** Update File: ${file}`, '@@', '-a', '+b', '*** End Patch'].join('\n');
const codexPatch = (dir, file) => ({ cwd: dir, tool_name: 'apply_patch', tool_input: { command: patch(file) } });
const codexShell = (dir, file) => ({ cwd: dir, tool_name: 'Bash', tool_input: { command: `apply_patch <<'EOF'\n${patch(file)}\nEOF` } });
const agy = (dir, name, args) => ({ toolCall: { name, args }, workspacePaths: [dir] });

const writers = (dir, rel) => [
  claude(dir, 'Edit', path.join(dir, rel)),
  claude(dir, 'Write', path.join(dir, rel)),
  codexPatch(dir, rel),
  codexShell(dir, rel),
  agy(dir, 'write_to_file', { TargetFile: path.join(dir, rel), CodeContent: 'x' }),
  agy(dir, 'replace_file_content', { TargetFile: path.join(dir, rel) }),
];

const readers = (dir, rel) => [claude(dir, 'Read', path.join(dir, rel)), agy(dir, 'view_file', { AbsolutePath: path.join(dir, rel) })];

test('.env, lock files and .git are refused for every editing tool even with a 진행중 task', t => {
  const dir = project(t);
  for (const rel of ['.env', 'package-lock.json', '.git/hooks/pre-commit']) {
    for (const input of writers(dir, rel)) blocked(guard(dir, input), rel);
  }
});

test('protected files in sub folders and .env.* are refused, and every one of them can still be read', t => {
  const dir = project(t);
  for (const rel of ['app/.env', 'packages/a/yarn.lock', '.env.local', '.env.example', 'go.sum']) {
    for (const input of writers(dir, rel)) blocked(guard(dir, input), rel);
  }
  for (const rel of ['.env', 'package-lock.json', '.git/hooks/pre-commit', 'app/.env', 'packages/a/yarn.lock', '.env.local']) {
    for (const input of readers(dir, rel)) passed(guard(dir, input), `read ${rel}`);
  }
  passed(guard(dir, claude(dir, 'Write', path.join(dir, 'notes.md'))), 'a plain file');
  passed(guard(dir, claude(dir, 'Write', path.join(dir, 'environment.md'))), 'a name that only starts like .env');
});

test('protect in harness/config.json replaces the default list instead of adding to it', t => {
  const dir = project(t);
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), protect: ['secret.txt'] }));
  blocked(guard(dir, claude(dir, 'Edit', path.join(dir, 'secret.txt'))), 'secret.txt');
  passed(guard(dir, claude(dir, 'Edit', path.join(dir, '.env'))), '.env is no longer protected');
  passed(guard(dir, codexPatch(dir, 'package-lock.json')), 'lock files are no longer protected');
});

test('a hook called in a worktree refuses the main folder .git/hooks/pre-commit', t => {
  const dir = project(t);
  const tree = path.join(dir, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'ai/x', tree], { cwd: dir });
  const hook = path.join(dir, '.git/hooks/pre-commit');
  blocked(guard(tree, claude(tree, 'Edit', hook), tree), '.git/hooks/pre-commit');
  blocked(guard(tree, codexPatch(tree, hook), tree), '.git/hooks/pre-commit');
  passed(guard(tree, claude(tree, 'Read', hook), tree), 'read');
  passed(guard(tree, claude(tree, 'Edit', path.join(tree, 'notes.md')), tree), 'a plain file in the worktree');
});

test('protected files under hidden folders and hidden files under .git are refused too', t => {
  const dir = project(t);
  for (const rel of ['.hidden/.env', '.cache/package-lock.json', '..cache/.env', '..cache/package-lock.json', '.hidden/.git/hooks/pre-commit', '.git/.hidden']) {
    for (const input of writers(dir, rel)) blocked(guard(dir, input), rel);
  }
  passed(guard(dir, claude(dir, 'Write', path.join(dir, '.hidden/notes.md'))), 'a plain file in a hidden folder');
});

test('a protected name that is a symbolic link is refused by its own name, not only by its target', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets/prod'), 'KEY=1\n');
  fs.symlinkSync('secrets/prod', path.join(dir, '.env'));
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.writeFileSync(path.join(dir, '.githooks/pre-commit'), '#!/bin/sh\n');
  fs.rmSync(path.join(dir, '.git/hooks/pre-commit'), { force: true });
  fs.symlinkSync('../../.githooks/pre-commit', path.join(dir, '.git/hooks/pre-commit'));
  for (const rel of ['.env', '.git/hooks/pre-commit']) {
    for (const input of writers(dir, rel)) blocked(guard(dir, input), rel);
  }
  passed(guard(dir, claude(dir, 'Write', path.join(dir, 'secrets/prod'))), 'the link target itself is not a protected name');
});

test('a file under a protected folder whose parent is a symbolic link is refused (.git/hooks -> ../shared-hooks)', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'shared-hooks'));
  fs.writeFileSync(path.join(dir, 'shared-hooks/pre-commit'), '#!/bin/sh\n');
  fs.rmSync(path.join(dir, '.git/hooks'), { recursive: true, force: true });
  fs.symlinkSync('../shared-hooks', path.join(dir, '.git/hooks'));
  for (const input of writers(dir, '.git/hooks/pre-commit')) blocked(guard(dir, input), '.git/hooks/pre-commit');
  passed(guard(dir, claude(dir, 'Write', path.join(dir, 'shared-hooks/pre-commit'))), 'the link target itself is not a protected name');
});
