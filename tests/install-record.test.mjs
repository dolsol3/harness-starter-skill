import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-record-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 빈 임시 HOME과 임시 git 저장소. 설치기는 HOME 아래 명부에 적으므로 진짜 HOME 대신 임시 HOME을 준다.
function setup(t) {
  const home = temp(t, 'home');
  const repo = temp(t, 'repo');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (target, ...args) => spawnSync(process.execPath, [installer, target, ...args], { cwd: repo, encoding: 'utf8', env });
  const registry = path.join(home, '.harness-starter', 'projects.json');
  const versionFile = path.join(repo, 'harness/VERSION');
  return { home, repo, run, registry, versionFile };
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('preview shows the version file and the registry line but writes neither', t => {
  const { home, repo, run, registry } = setup(t);
  const out = ok(run(repo));
  assert.match(out, /\[새로 만듦\] harness\/VERSION/);
  assert.ok(out.includes(`[명부] ${registry}`), out);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
  assert.ok(!fs.existsSync(path.join(home, '.harness-starter')));
});

test('apply writes the version and lists the project once, however the folder is named', t => {
  const { repo, run, registry, versionFile } = setup(t);
  const listed = () => JSON.parse(fs.readFileSync(registry, 'utf8'));
  ok(run(repo, '--apply'));
  assert.equal(fs.readFileSync(versionFile, 'utf8'), `${version}\n`);
  assert.deepEqual(listed(), { source: null, projects: [fs.realpathSync(repo)], checked: null });

  ok(run(repo, '--apply', '--upgrade'));
  assert.match(ok(run('.', '--apply')), /이미 적혀 있다/);
  assert.deepEqual(listed().projects, [fs.realpathSync(repo)]);
});

test('apply in a worktree lists the main folder, not the worktree', t => {
  const { repo, run, registry } = setup(t);
  const worktree = path.join(repo, '.claude/worktrees/w1');
  const main = fs.realpathSync(repo);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'w1'], { cwd: repo });
  assert.ok(ok(run(worktree, '--apply')).includes(`${main}를 적었다`));
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')).projects, [main]);

  assert.match(ok(run(repo, '--apply')), /이미 적혀 있다/);
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')).projects, [main]);
});

test('an installed version differs: apply skips it, upgrade replaces it', t => {
  const { repo, run, versionFile } = setup(t);
  ok(run(repo, '--apply'));
  fs.writeFileSync(versionFile, '0.1.0\n');
  assert.match(ok(run(repo, '--apply')), /\[건너뜀\] harness\/VERSION/);
  assert.equal(fs.readFileSync(versionFile, 'utf8'), '0.1.0\n');
  assert.match(ok(run(repo, '--apply', '--upgrade')), /\[고침\] harness\/VERSION/);
  assert.equal(fs.readFileSync(versionFile, 'utf8'), `${version}\n`);
});

test('a broken registry stops the installer and is left as it was', t => {
  const { repo, run, registry } = setup(t);
  fs.mkdirSync(path.dirname(registry));
  fs.writeFileSync(registry, '{ broken');
  const result = run(repo, '--apply');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /명부를 JSON으로 읽을 수 없다/);
  assert.equal(fs.readFileSync(registry, 'utf8'), '{ broken');
});
