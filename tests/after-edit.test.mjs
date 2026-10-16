import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

// 인자를 찍고 표시 파일 'ran'을 남긴 뒤 주어진 종료 코드로 끝나는 명령.
const node = (code, extra = '') => [process.execPath, '-e',
  `require('fs').writeFileSync('ran', ''); console.log('afterEdit got', process.argv[1]); ${extra} process.exit(${code})`,
  '{file}'];

// 검사기를 넣고 첫 커밋을 한 임시 git 저장소. code 종류에 afterEdit을 단다.
function repo(t, code = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-after-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  const file = path.join(dir, 'harness/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.kinds = { code: { files: ['**/*.js'], maxFileLines: 5, patterns: true, ...code }, docs: { files: ['**/*.md'] } };
  fs.writeFileSync(file, JSON.stringify(config));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

function write(dir, name, text) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}

function hook(dir, name) {
  const input = JSON.stringify({ tool_input: { file_path: path.join(dir, name) }, cwd: dir });
  return spawnSync(process.execPath, ['harness/check.mjs', '--hook'], { cwd: dir, encoding: 'utf8', input });
}

const ran = dir => fs.existsSync(path.join(dir, 'ran'));

test('a failing afterEdit command blocks the hook with its output and the file path', t => {
  const { dir } = repo(t, { afterEdit: node(1, "console.error('lint says no');") });
  write(dir, 'src/a.js', 'run();\n');
  const result = hook(dir, 'src/a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /afterEdit got src\/a\.js/);
  assert.match(result.stderr, /lint says no/);
  assert.match(result.stderr, /src\/a\.js: .* \(종료 코드 1\)/);
});

test('a passing afterEdit command is silent, and files without one are left alone', t => {
  const { dir } = repo(t, { afterEdit: node(0) });
  write(dir, 'src/a.js', 'run();\n');
  const passed = hook(dir, 'src/a.js');
  assert.equal(passed.status, 0);
  assert.equal(passed.stderr, '');
  assert.ok(ran(dir));
  fs.rmSync(path.join(dir, 'ran'));
  write(dir, 'notes.md', '# hi\n');
  write(dir, 'data.txt', 'hi\n');
  write(dir, 'node_modules/x/b.js', 'run();\n');
  for (const name of ['notes.md', 'data.txt', 'node_modules/x/b.js']) {
    const result = hook(dir, name);
    assert.equal(result.status, 0, name);
    assert.equal(result.stderr, '', name);
  }
  assert.ok(!ran(dir), 'the command ran for a file it should not');
});

test('a missing afterEdit command is reported, not skipped', t => {
  const { dir } = repo(t, { afterEdit: ['no-such-command-harness', '{file}'] });
  write(dir, 'a.js', 'run();\n');
  const result = hook(dir, 'a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'no-such-command-harness'을 찾지 못했다/);
});

test('an afterEdit command over afterEditSeconds is stopped and reported', t => {
  const { dir } = repo(t, { afterEdit: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], afterEditSeconds: 1 });
  write(dir, 'a.js', 'run();\n');
  const started = Date.now();
  const result = hook(dir, 'a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /1초 시간 제한을 넘었다/);
  assert.ok(Date.now() - started < 4000, 'the hook waited for the slow command');
});

test('an afterEdit command that ignores SIGTERM is still stopped at the limit', t => {
  const slow = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000)";
  const { dir } = repo(t, { afterEdit: [process.execPath, '-e', slow], afterEditSeconds: 1 });
  write(dir, 'a.js', 'run();\n');
  const started = Date.now();
  const result = hook(dir, 'a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /1초 시간 제한을 넘었다/);
  assert.ok(Date.now() - started < 4000, 'the hook waited for the command that ignored SIGTERM');
});

test('long afterEdit output is cut to the first 40 lines', t => {
  const { dir } = repo(t, { afterEdit: node(1, "for (let i = 1; i <= 50; i++) console.log('line ' + i);") });
  write(dir, 'a.js', 'run();\n');
  const result = hook(dir, 'a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /line 39\n/);
  assert.doesNotMatch(result.stderr, /line 40\n/, 'the first output line is "afterEdit got", so line 39 is the 40th');
  assert.match(result.stderr, /출력 51줄 중 앞 40줄만/);
});

test('a limit violation and an afterEdit failure are both reported', t => {
  const { dir } = repo(t, { afterEdit: node(1) });
  write(dir, 'a.js', 'a();\nb();\nc();\nd();\ne();\nf();\n');
  const result = hook(dir, 'a.js');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /a\.js:1: 파일이 6줄/);
  assert.match(result.stderr, /afterEdit got a\.js/);
});

test('file mode and staged mode do not run afterEdit', t => {
  const { dir, git } = repo(t, { afterEdit: node(1) });
  write(dir, 'a.js', 'run();\n');
  const run = args => spawnSync(process.execPath, ['harness/check.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run(['a.js']).status, 0);
  git('add', 'a.js');
  assert.equal(run(['--staged']).status, 0);
  assert.ok(!ran(dir));
});
