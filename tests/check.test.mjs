import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

const KINDS = {
  code: { files: ['**/*.js', '**/*.py'], maxFileLines: 400, maxLineLength: 120, patterns: true },
  docs: { files: ['**/*.md'] },
};

// 검사기를 넣고 첫 커밋을 한 임시 git 저장소. 파일 종류는 kinds로 정한다.
function repo(t, files = {}, kinds = KINDS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  setConfig(dir, config => { config.kinds = kinds; });
  write(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
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

function check(dir, args, input) {
  return spawnSync(process.execPath, ['harness/check.mjs', ...args], { cwd: dir, encoding: 'utf8', input });
}

const lines = n => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';

test('only new long lines are reported, not ones that were already there', t => {
  const { dir } = repo(t, { 'a.js': `const old = '${'x'.repeat(130)}';\n` });
  write(dir, { 'a.js': `const old = '${'x'.repeat(130)}';\nconst neu = '${'y'.repeat(130)}';\n` });
  const result = check(dir, ['a.js']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /a\.js:2: 줄이 \d+자/);
  assert.doesNotMatch(result.stdout, /a\.js:1:/);
});

test('swallowed exceptions and silenced checks are reported, even across lines', t => {
  const { dir } = repo(t, { 'a.js': 'run();\n', 'b.py': 'run()\n' });
  write(dir, {
    'a.js': 'run();\ntry {\n  go();\n} catch (e) {\n}\n// eslint-disable-next-line\n',
    'b.py': 'run()\ntry:\n    go()\nexcept Exception:\n    pass\n',
  });
  const result = check(dir, ['a.js', 'b.py']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /a\.js:4: 빈 catch/);
  assert.match(result.stdout, /a\.js:6: 검사 끄기/);
  assert.match(result.stdout, /b\.py:4: except: pass/);
});

test('a file over the line limit is reported only when it grows', t => {
  const { dir, git } = repo(t, { 'big.js': lines(450) });
  write(dir, { 'big.js': lines(450).replace('const v0 = 0;', 'const v0 = 1;') });
  assert.equal(check(dir, ['big.js']).status, 0, 'editing a legacy big file without growing it is fine');
  write(dir, { 'big.js': lines(451) });
  assert.match(check(dir, ['big.js']).stdout, /big\.js:1: 파일이 451줄\(전에는 450줄\)/);
  write(dir, { 'new.js': lines(401) });
  git('add', 'new.js');
  assert.match(check(dir, ['new.js']).stdout, /new\.js:1: 파일이 401줄\(전에는 0줄\)/);
});

test('a new untracked file is checked as a whole', t => {
  const { dir } = repo(t);
  write(dir, { 'fresh.js': `const s = '${'z'.repeat(130)}';\n` });
  assert.match(check(dir, ['fresh.js']).stdout, /fresh\.js:1: 줄이/);
});

test('staged mode checks what will be committed and the size of the commit', t => {
  const { dir, git } = repo(t);
  write(dir, { 'a.js': lines(250), 'b.js': lines(200) });
  git('add', 'a.js', 'b.js');
  const result = check(dir, ['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /이번 커밋에 더한 줄이 450줄/);
  write(dir, { 'a.js': `const s = '${'q'.repeat(130)}';\n` });
  assert.doesNotMatch(check(dir, ['--staged']).stdout, /줄이 \d+자/, 'unstaged edits are not part of the commit');
});

test('hook mode reads the edited file from Claude Code and reports on stderr with exit code 2', t => {
  const { dir } = repo(t, { 'src/a.js': 'run();\n' });
  write(dir, { 'src/a.js': 'run();\ntry { go(); } catch {}\n' });
  const input = JSON.stringify({ tool_input: { file_path: path.join(dir, 'src/a.js') }, cwd: dir });
  const result = check(dir, ['--hook'], input);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /src\/a\.js:2: 빈 catch/);
  write(dir, { 'src/a.js': 'run();\ngo();\n' });
  assert.equal(check(dir, ['--hook'], input).status, 0);
});

// Windows에서는 경로가 '\'로 나와 git show가 실패하고(이전 줄 수 0) 폴더 무시가 맞지 않았다.
test('subfolder paths: an unchanged big file and ignored folders are not reported', t => {
  const { dir } = repo(t, { 'sub/big.js': lines(450) });
  write(dir, { 'sub/__pycache__/x.py': 'try:\n    y = 1\nexcept Exception: pass\n' });
  const result = check(dir, ['sub/big.js', 'sub/__pycache__/x.py']);
  assert.equal(result.status, 0, result.stdout);
  const input = JSON.stringify({ tool_input: { file_path: path.join(dir, 'sub', 'big.js') }, cwd: dir });
  assert.equal(check(dir, ['--hook'], input).status, 0);
});

test('ignored paths, prose line and file length and running from a subfolder', t => {
  const { dir } = repo(t, { 'docs/x.md': 'a\n' });
  const long = 'w'.repeat(200);
  const prose = `${long}\n`.repeat(450);
  write(dir, { 'package-lock.json': long, 'rebuild/a.js': `const s = '${long}';\n`, 'docs/x.md': prose });
  const files = ['x.md', '../package-lock.json', '../rebuild/a.js'];
  const result = spawnSync(process.execPath, ['../harness/check.mjs', ...files], {
    cwd: path.join(dir, 'docs'),
    encoding: 'utf8',
  });
  assert.match(result.stdout, /rebuild\/a\.js:1: 줄이/, 'rebuild/ is not the ignored build/ folder');
  assert.doesNotMatch(result.stdout, /package-lock|x\.md/);
});

test('moving a file, merge commits and non-ASCII file names', t => {
  const long = `const s = '${'x'.repeat(130)}';\n`;
  const { dir, git } = repo(t, { 'big.js': long + lines(450) });
  git('mv', 'big.js', 'moved.js');
  assert.equal(check(dir, ['--staged']).status, 0, 'a moved file is not new code');
  git('commit', '-q', '-m', 'move');

  git('switch', '-q', '-c', 'other');
  write(dir, { 'o.js': lines(450) });
  git('add', 'o.js');
  git('commit', '-q', '--no-verify', '-m', 'other');
  git('switch', '-q', '-');
  write(dir, { 'm.js': lines(300) });
  git('add', 'm.js');
  git('commit', '-q', '--no-verify', '-m', 'main');
  spawnSync('git', ['merge', '--no-commit', '-q', 'other'], { cwd: dir });
  assert.equal(check(dir, ['--staged']).status, 0, 'merged lines were checked on their own branch');
  git('merge', '--abort');

  write(dir, { '한글.js': 'try { go(); } catch {}\n' });
  git('add', '한글.js');
  assert.match(check(dir, ['--staged']).stdout, /한글\.js:1: 빈 catch/);
});

test('lines written while resolving a merge conflict are checked', t => {
  const { dir, git } = repo(t, { 'c.js': 'run(1);\n' });
  git('switch', '-q', '-c', 'other');
  write(dir, { 'c.js': 'run(2);\n' });
  git('commit', '-q', '-am', 'other');
  git('switch', '-q', '-');
  write(dir, { 'c.js': 'run(3);\n' });
  git('commit', '-q', '-am', 'main');
  spawnSync('git', ['merge', '-q', 'other'], { cwd: dir });
  write(dir, { 'c.js': 'run(3);\ntry { run(2); } catch {}\n' });
  git('add', 'c.js');
  const result = check(dir, ['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /c\.js:2: 빈 catch/);
});

test('hook mode also reads Codex apply_patch and Antigravity edit payloads', t => {
  const { dir } = repo(t, { 'a.js': 'run();\n' });
  write(dir, { 'a.js': 'run();\ntry { go(); } catch {}\n', 'b.js': 'try { go(); } catch {}\n' });
  const patch = [
    '*** Begin Patch', '*** Update File: a.js', '@@', ' run();', '+try { go(); } catch {}',
    '*** Add File: b.js', '+x', '*** End Patch',
  ].join('\n');
  const input = { tool_name: 'apply_patch', tool_input: { command: patch }, cwd: dir };
  const codex = check(dir, ['--hook'], JSON.stringify(input));
  assert.equal(codex.status, 2);
  assert.match(codex.stderr, /a\.js:2: 빈 catch/);
  assert.match(codex.stderr, /b\.js:1: 빈 catch/);
  const call = { name: 'replace_file_content', args: { TargetFile: path.join(dir, 'a.js') } };
  const antigravity = check(dir, ['--hook'], JSON.stringify({ toolCall: call, workspacePaths: [dir] }));
  assert.equal(antigravity.status, 2);
  assert.match(antigravity.stderr, /a\.js:2: 빈 catch/);
});

test('a project rule added to config.json patterns is reported like the built-in ones', t => {
  const { dir } = repo(t, { 'svc.py': 'def run():\n    return 1\n' });
  setConfig(dir, config => {
    config.patterns.push({ regex: '^from db import', message: '서비스 코드에서 db를 직접 부르지 않는다' });
  });
  write(dir, { 'svc.py': 'import os\nfrom db import query\ndef run():\n    return 1\n' });
  assert.match(check(dir, ['svc.py']).stdout, /svc\.py:2: 서비스 코드에서 db를 직접 부르지 않는다/, '^ matches each line');
});

test('limits belong to the file kind: the same long line fails in code and passes in docs or no kind', t => {
  const kinds = { code: { files: ['src/**'], maxLineLength: 80, maxFileLines: 5 }, docs: { files: ['**/*.md'] } };
  const { dir } = repo(t, {}, kinds);
  const long = 'x'.repeat(100);
  const csv = `${long}\n${lines(450)}`;
  write(dir, { 'src/a.js': `${long}\n`, 'notes.md': `${long}\n`, 'data.csv': csv, 'src/b.js': lines(6) });
  const result = check(dir, ['src/a.js', 'notes.md', 'data.csv', 'src/b.js']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\/a\.js:1: 줄이 100자: 80자/);
  assert.match(result.stdout, /src\/b\.js:1: 파일이 6줄\(전에는 0줄\): 5줄/);
  assert.doesNotMatch(result.stdout, /notes\.md|data\.csv/);
});

test('forbidden patterns are checked only in kinds marked patterns', t => {
  const kinds = { code: { files: ['**/*.js'], patterns: true }, plain: { files: ['**/*.txt'], maxLineLength: 200 } };
  const { dir } = repo(t, {}, kinds);
  write(dir, { 'a.js': 'try { go(); } catch {}\n', 'b.txt': 'try { go(); } catch {}\n' });
  const result = check(dir, ['a.js', 'b.txt']);
  assert.match(result.stdout, /a\.js:1: 빈 catch/);
  assert.doesNotMatch(result.stdout, /b\.txt/);
});

test('the commit size counts only the kinds that have a limit', t => {
  const kinds = { code: { files: ['**/*.js'], maxLineLength: 120 }, free: { files: ['**/*.go', '**/*.md'] } };
  const { dir, git } = repo(t, {}, kinds);
  write(dir, { 'big.go': lines(450), 'notes.md': lines(450), 'data.csv': lines(450), 'a.js': lines(399) });
  git('add', '-A');
  assert.equal(check(dir, ['--staged']).status, 0);
  write(dir, { 'b.js': lines(2) });
  git('add', 'b.js');
  assert.match(check(dir, ['--staged']).stdout, /이번 커밋에 더한 줄이 401줄/);
});

test('a config.json in the old shape stops with a message to run the skill again', t => {
  const { dir } = repo(t);
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify({ maxFileLines: 400, patterns: [] }));
  const result = check(dir, ['a.js']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /옛 모양/);
});
