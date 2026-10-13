import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));
const KINDS = { code: { files: ['src/**'], maxFileLines: 300, patterns: true }, docs: { files: ['**/*.md'] } };

// 하네스를 넣고 첫 커밋(main)을 한 임시 git 저장소. kinds는 코드(src)와 문서(md) 두 종류다.
function repo(t, kinds = KINDS, label = '') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `harness-guard-${label}`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), kinds }));
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'harness/backlog.json\nharness/backlog.lock\nharness/questions.html\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

const run = (cwd, script, ...args) => spawnSync(process.execPath, [path.join(cwd, 'harness', script), ...args], { cwd, encoding: 'utf8' });

// 작업 하나를 만들어 진행중으로 둔다.
function startTask(dir) {
  const done = [run(dir, 'backlog.mjs', '추가', '일'), run(dir, 'backlog.mjs', '시작', 'T-1', '--영역', 'src/**', '--확인방법', 'npm test')];
  done.forEach(result => assert.equal(result.status, 0, result.stderr));
}

// 훅이 받는 도구 호출. 막히면 { blocked: true, message }, 통과하면 { blocked: false }.
function hook(dir, tool, params, cwd = dir) {
  const input = JSON.stringify({ cwd, tool_name: tool, tool_input: params });
  const result = spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd: dir, input, encoding: 'utf8' });
  assert.ok([0, 2].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  return { blocked: result.status === 2, message: result.stderr };
}

const blocked = (result, pattern) => {
  assert.equal(result.blocked, true, '거절돼야 한다');
  assert.match(result.message, pattern);
};

test('the ledger file cannot be read or edited directly; commands are pointed to', t => {
  const { dir } = repo(t);
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    blocked(hook(dir, tool, { file_path: path.join(dir, 'harness/backlog.json') }), /backlog\.mjs 목록/);
  }
  blocked(hook(dir, 'Bash', { command: 'cat harness/backlog.json' }), /backlog\.mjs 목록/);
  blocked(hook(dir, 'Bash', { command: 'cd harness && jq . backlog.json' }), /backlog\.mjs 목록/);
  assert.equal(hook(dir, 'Bash', { command: 'node harness/backlog.mjs 목록' }).blocked, false);
});

test('the ledger is found through a symlinked path and from a worktree', t => {
  const { dir, git } = repo(t);
  const link = path.join(path.dirname(dir), `${path.basename(dir)}-link`);
  fs.symlinkSync(dir, link);
  t.after(() => fs.rmSync(link));
  blocked(hook(dir, 'Read', { file_path: path.join(link, 'harness/backlog.json') }), /직접 다루지 않는다/);
  const tree = path.join(dir, 'wt');
  git('worktree', 'add', '-q', '-b', 'ai/x', tree);
  blocked(hook(dir, 'Read', { file_path: path.join(dir, 'harness/backlog.json') }, tree), /직접 다루지 않는다/);
  blocked(hook(dir, 'Read', { file_path: 'harness/backlog.json' }, tree), /직접 다루지 않는다/);
});

test('code files need a 진행중 task; docs and unlisted files do not', t => {
  const { dir } = repo(t);
  const code = path.join(dir, 'src/a.js');
  for (const tool of ['Edit', 'Write', 'MultiEdit']) blocked(hook(dir, tool, { file_path: code }), /진행중인 작업이 없다.*시작 T-1/);
  assert.equal(hook(dir, 'Read', { file_path: code }).blocked, false);
  assert.equal(hook(dir, 'Write', { file_path: path.join(dir, 'docs/a.md') }).blocked, false);
  assert.equal(hook(dir, 'Write', { file_path: path.join(dir, 'data/a.csv') }).blocked, false);
  startTask(dir);
  assert.equal(hook(dir, 'Edit', { file_path: code }).blocked, false);
});

test('in a worktree the main folder ledger decides', t => {
  const { dir, git } = repo(t);
  const tree = path.join(dir, 'wt');
  git('worktree', 'add', '-q', '-b', 'ai/x', tree);
  blocked(hook(dir, 'Edit', { file_path: path.join(tree, 'src/a.js') }, tree), /진행중인 작업이 없다/);
  startTask(dir);
  assert.equal(hook(dir, 'Edit', { file_path: path.join(tree, 'src/a.js') }, tree).blocked, false);
  assert.equal(hook(dir, 'Edit', { file_path: 'src/a.js' }, tree).blocked, false);
});

test('the check settings and the harness commands cannot be edited, but can be read', t => {
  const { dir } = repo(t);
  startTask(dir);
  for (const name of ['config.json', 'check.mjs', 'guard.mjs', 'backlog.mjs', 'ledger.mjs', 'questions.mjs', 'page.mjs', 'patch.mjs', 'serve.mjs']) {
    const file = path.join(dir, 'harness', name);
    blocked(hook(dir, 'Edit', { file_path: file }), /검사 설정이라 고치지 않는다.*사람에게 묻는다/);
    assert.equal(hook(dir, 'Read', { file_path: file }).blocked, false);
  }
});

test('config.json can be filled while kinds is still empty (the install step)', t => {
  const { dir } = repo(t, {});
  const file = path.join(dir, 'harness/config.json');
  assert.equal(hook(dir, 'Edit', { file_path: file }).blocked, false);
  blocked(hook(dir, 'Edit', { file_path: path.join(dir, 'harness/check.mjs') }), /고치지 않는다/);
});

test('--no-verify is refused in a shell command', t => {
  const { dir } = repo(t);
  blocked(hook(dir, 'Bash', { command: 'git commit --no-verify -m x' }), /--no-verify/);
  assert.equal(hook(dir, 'Bash', { command: 'git commit -m x' }).blocked, false);
});

test('when the ledger cannot be found the call is refused, not allowed', t => {
  const { dir } = repo(t);
  const apart = path.join(path.dirname(dir), `${path.basename(dir)}-apart`);
  fs.mkdirSync(apart);
  t.after(() => fs.rmSync(apart, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--separate-git-dir', path.join(apart, 'git-data'), path.join(apart, 'work')]);
  const input = JSON.stringify({ cwd: path.join(apart, 'work'), tool_name: 'Edit', tool_input: { file_path: path.join(apart, 'work/src/a.js') } });
  const result = spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd: dir, input, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /확인하지 못해 거절한다/);
  assert.equal(run(dir, 'guard.mjs', '--wrong').status, 2);
});

test('a code file whose name has quotes, a backslash or a tab is seen by the commit check', { skip: process.platform === 'win32' && '이 이름은 Windows에서 만들 수 없다' }, t => {
  const { dir, git } = repo(t);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/q"uote.js'), 'x\n');
  git('add', '-A');
  assert.match(run(dir, 'guard.mjs', '--staged').stderr, /src\/q"uote\.js.*진행중인 작업이 없다/);
  git('reset', '-q');
  fs.rmSync(path.join(dir, 'src/q"uote.js'));
  for (const name of ['back\\slash.js', 'tab\tname.js']) {
    fs.writeFileSync(path.join(dir, 'src', name), 'x\n');
    git('add', '-A');
    assert.equal(run(dir, 'guard.mjs', '--staged').status, 2, name);
    git('reset', '-q');
    fs.rmSync(path.join(dir, 'src', name));
  }
});

test('a commit with code needs a 진행중 task; docs only does not', t => {
  const { dir, git } = repo(t);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'a\n');
  git('add', '-A');
  assert.equal(run(dir, 'guard.mjs', '--staged').status, 0);
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'x\n');
  git('add', '-A');
  const refused = run(dir, 'guard.mjs', '--staged');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /src\/a\.js.*진행중인 작업이 없다/);
  startTask(dir);
  assert.equal(run(dir, 'guard.mjs', '--staged').status, 0);
});

test('another spelling of the same file (case, Unicode form) is still that file', t => {
  const { dir } = repo(t);
  if (!fs.existsSync(path.join(dir, 'HARNESS/CONFIG.JSON'))) return t.skip('case-sensitive file system');
  startTask(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  blocked(hook(dir, 'Edit', { file_path: path.join(dir, 'Harness/Config.json') }), /검사 설정/);
  blocked(hook(dir, 'Read', { file_path: path.join(dir, 'HARNESS/Backlog.JSON') }), /직접 다루지 않는다/);
  fs.rmSync(path.join(dir, 'harness/backlog.json'));
  blocked(hook(dir, 'Write', { file_path: path.join(dir, 'Src/new.js') }), /진행중인 작업이 없다/);

  const korean = repo(t, KINDS, '프로젝트'.normalize('NFD'));
  const composed = path.join(korean.dir.normalize('NFC'), 'src/a.js');
  const input = (cwd, file_path) => hook(korean.dir, 'Write', { file_path }, cwd);
  if (fs.existsSync(path.dirname(composed))) {
    blocked(input(korean.dir, composed), /진행중인 작업이 없다/);
    blocked(input(korean.dir.normalize('NFC'), composed), /진행중인 작업이 없다/);
  }
});

test('only a 진행중 task opens code files; 할일, 올림 and 완료 do not', t => {
  const { dir } = repo(t);
  const ledgerFile = path.join(dir, 'harness/backlog.json');
  const code = path.join(dir, 'src/a.js');
  for (const status of ['할일', '올림', '완료']) {
    fs.writeFileSync(ledgerFile, JSON.stringify({ 다음번호: 2, 작업: [{ 번호: 'T-1', 상태: status }] }));
    blocked(hook(dir, 'Edit', { file_path: code }), /진행중인 작업이 없다/);
  }
});

test('the first kind that matches decides; any limit makes a kind code, none does not', t => {
  const kinds = {
    docs: { files: ['src/**/*.md'] },
    code: { files: ['src/**'], maxFileLines: 300 },
    wide: { files: ['wide/**'], maxLineLength: 100 },
    strict: { files: ['strict/**'], patterns: true },
    plain: { files: ['plain/**'] },
  };
  const { dir } = repo(t, kinds);
  const edit = file => hook(dir, 'Edit', { file_path: path.join(dir, file) });
  assert.equal(edit('src/notes.md').blocked, false, 'the earlier kind has no limit');
  for (const file of ['src/a.js', 'wide/a.txt', 'strict/a.txt']) blocked(edit(file), /진행중인 작업이 없다/);
  assert.equal(edit('plain/a.txt').blocked, false);
});

test('a commit that changes, deletes or renames code needs a 진행중 task too', t => {
  const { dir, git } = repo(t);
  startTask(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'two\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'code');
  fs.rmSync(path.join(dir, 'harness/backlog.json'));
  fs.appendFileSync(path.join(dir, 'src/a.js'), 'more\n');
  git('add', '-A');
  assert.equal(run(dir, 'guard.mjs', '--staged').status, 2, 'changed');
  git('reset', '-q', '--hard');
  git('rm', '-q', 'src/a.js');
  assert.equal(run(dir, 'guard.mjs', '--staged').status, 2, 'deleted');
  git('reset', '-q', '--hard');
  git('mv', 'src/a.js', 'src/c.js');
  assert.equal(run(dir, 'guard.mjs', '--staged').status, 2, 'renamed');
});

// 충돌 나는 병합을 풀고 스테이지한 상태로 둔다. 상대 브랜치에서 온 src/b.js는 이미 그쪽에서 검사한 코드다.
function conflictedMerge(t, conflictFile) {
  const { dir, git } = repo(t);
  startTask(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, conflictFile), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'files');
  git('switch', '-q', '-c', 'ai/x');
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'theirs\n');
  fs.writeFileSync(path.join(dir, conflictFile), 'from branch\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'branch');
  git('switch', '-q', 'main');
  fs.writeFileSync(path.join(dir, conflictFile), 'from main\n');
  git('commit', '-q', '-am', 'main');
  fs.rmSync(path.join(dir, 'harness/backlog.json'));
  assert.throws(() => git('merge', 'ai/x'));
  fs.writeFileSync(path.join(dir, conflictFile), 'resolved\n');
  git('add', '-A');
  return dir;
}

test('resolving a merge conflict: code that came from the other branch is not counted again', t => {
  assert.equal(run(conflictedMerge(t, 'README.md'), 'guard.mjs', '--staged').status, 0);
  assert.equal(run(conflictedMerge(t, 'src/c.js'), 'guard.mjs', '--staged').status, 2, 'but code written to resolve it is');
});

test('a broken or old-shaped config.json is refused with the reason, never passed', t => {
  const { dir } = repo(t);
  const config = path.join(dir, 'harness/config.json');
  const good = fs.readFileSync(config, 'utf8');
  fs.writeFileSync(config, '{');
  blocked(hook(dir, 'Bash', { command: 'npm test' }), /확인하지 못해 거절한다/);
  fs.writeFileSync(config, JSON.stringify({ maxFileLines: 400 }));
  blocked(hook(dir, 'Edit', { file_path: path.join(dir, 'README.md') }), /옛 모양/);
  assert.equal(hook(dir, 'Bash', { command: 'npm test' }).blocked, false, 'a shell command can still run --upgrade');
  fs.writeFileSync(config, good);
});

test('a broken ledger says which file and what to do', t => {
  const { dir } = repo(t);
  fs.writeFileSync(path.join(dir, 'harness/backlog.json'), '{bad');
  blocked(hook(dir, 'Edit', { file_path: path.join(dir, 'src/a.js') }), /harness\/backlog\.json.*사람이/);
  const result = run(dir, 'backlog.mjs', '목록');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /harness\/backlog\.json.*사람이/);
});

test('in a worktree inside the main folder, a file is judged by the worktree own paths', t => {
  const { dir, git } = repo(t, { claude: { files: ['.claude/**'], maxFileLines: 300 } });
  const tree = path.join(dir, '.claude/worktrees/x');
  git('worktree', 'add', '-q', '-b', 'ai/x', tree);
  assert.equal(hook(dir, 'Write', { file_path: path.join(tree, 'README.md') }, tree).blocked, false);
  blocked(hook(dir, 'Write', { file_path: path.join(tree, '.claude/z.js') }, tree), /진행중인 작업이 없다/);
});
