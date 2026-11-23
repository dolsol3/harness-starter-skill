import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-area-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.copyFileSync(new URL('area-tests.mjs', import.meta.url), path.join(dir, 'tests/area-tests.mjs'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function run(dir, files, cwd = dir) {
  // 중첩 시험이 바깥 시험의 내부 호출로 취급되지 않게 한다.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(dir, 'tests/area-tests.mjs'), ...files], {
    cwd, encoding: 'utf8', windowsHide: true, env,
  });
}

const passing = "import test from 'node:test';\ntest('selected test ran', () => {});\n";
const failing = "import test from 'node:test';\ntest('unrelated failure', () => { throw Error('intentional failure'); });\n";

test('a changed test runs directly and leaves unrelated tests out', t => {
  const dir = repo(t, { 'tests/chosen.test.mjs': passing, 'tests/other.test.mjs': failing });
  const result = run(dir, ['tests/chosen.test.mjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /selected test ran/);
  assert.doesNotMatch(result.stdout, /unrelated failure/);
});

test('source files select only tests mentioning the full basename', t => {
  const dir = repo(t, {
    'src/mullebanga-git.mjs': '',
    'tests/first.test.mjs': `// mullebanga-git.mjs\n${passing}`,
    'tests/second.test.mjs': `// mullebanga-git.mjs\n${passing}`,
    'tests/other.test.mjs': `// mullebanga-git.js\n${failing}`,
  });
  const result = run(dir, ['src/mullebanga-git.mjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\btests 2\b/);
  assert.doesNotMatch(result.stdout, /unrelated failure/);
});

test('unmatched documentation exits successfully without running tests', t => {
  const dir = repo(t, { 'docs/guide.md': '', 'tests/other.test.mjs': failing });
  const result = run(dir, ['docs/guide.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '맞는 시험 없음: 병합 뒤 전체 시험에서 확인');
});

test('a selected test failure makes the command fail', t => {
  const dir = repo(t, { 'tests/broken.test.mjs': failing });
  const result = run(dir, ['tests/broken.test.mjs']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /intentional failure/);
});

test('equivalent test paths work at the root and inside tests', t => {
  const dir = repo(t, { 'tests/chosen.test.mjs': passing, 'tests/other.test.mjs': failing });
  const inside = path.join(dir, 'tests');
  const cases = [
    [dir, 'tests/chosen.test.mjs'],
    [dir, './tests/chosen.test.mjs'],
    [dir, 'tests/./chosen.test.mjs'],
    [dir, path.join(dir, 'tests/chosen.test.mjs')],
    [inside, './chosen.test.mjs'],
    [inside, '../tests/./chosen.test.mjs'],
    [inside, path.join(dir, 'tests/chosen.test.mjs')],
  ];
  for (const [cwd, file] of cases) {
    const result = run(dir, [file], cwd);
    assert.equal(result.status, 0, `${cwd}: ${file}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /selected test ran/);
    assert.doesNotMatch(result.stdout, /unrelated failure/);
  }
});

test('source paths select matching tests from a non-root cwd', t => {
  const dir = repo(t, {
    'src/worker.mjs': '',
    'tests/chosen.test.mjs': `// worker.mjs\n${passing}`,
    'tests/other.test.mjs': failing,
  });
  const inside = path.join(dir, 'src');
  for (const file of ['./worker.mjs', '../src/./worker.mjs', path.join(dir, 'src/worker.mjs')]) {
    const result = run(dir, [file], inside);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /selected test ran/);
    assert.doesNotMatch(result.stdout, /unrelated failure/);
  }
});
