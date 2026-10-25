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
const checker = fileURLToPath(new URL('../templates/harness/check.mjs', import.meta.url));
const JS_KIND = { code: { files: ['**/*.js'], maxLineLength: 120, patterns: true } };

function project(t, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// 설치한 config.json은 kinds가 비어 있다. 스킬 절차가 종류를 채우는 일을 흉내 낸다.
function setKinds(dir, kinds) {
  const config = { ...JSON.parse(read(dir, 'harness/config.json')), kinds };
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify(config));
}

test('preview writes nothing; apply installs every part; a second run changes nothing', t => {
  const dir = project(t);
  assert.match(install(dir), /미리보기입니다/);
  assert.deepEqual(fs.readdirSync(dir), ['.git']);

  install(dir, '--apply');
  assert.match(read(dir, 'AGENTS.md'), /간결함 원칙/);
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n', 'Claude Code loads the principles from AGENTS.md');
  assert.ok(fs.existsSync(path.join(dir, 'harness/check.mjs')));
  const config = JSON.parse(read(dir, 'harness/config.json'));
  assert.deepEqual(config.kinds, {}, 'no limits until the skill procedure picks them per file kind');
  assert.equal(config.maxFileLines, undefined);
  for (const skills of ['.agents/skills', '.claude/skills']) {
    assert.ok(fs.existsSync(path.join(dir, skills, 'lean-review/SKILL.md')), skills);
  }
  const settings = JSON.parse(read(dir, '.claude/settings.json'));
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /harness\/check\.mjs" --hook$/);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Edit|Write|MultiEdit|Bash');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /^node "\$CLAUDE_PROJECT_DIR\/harness\/guard\.mjs" --hook$/);
  const codex = JSON.parse(read(dir, '.codex/hooks.json')).hooks.PostToolUse[0];
  assert.equal(codex.matcher, 'apply_patch|Edit|Write');
  assert.equal(codex.hooks[0].command, 'node harness/check.mjs --hook');
  const antigravity = JSON.parse(read(dir, '.agents/hooks.json'))['harness-starter'].PostToolUse[0];
  assert.match(antigravity.matcher, /^write_to_file\|replace_file_content\|/);
  assert.equal(antigravity.hooks[0].command, 'node ../harness/check.mjs --hook');
  const hook = path.join(dir, '.git/hooks/pre-commit');
  assert.match(fs.readFileSync(hook, 'utf8'), /node harness\/check\.mjs --staged/);
  assert.match(fs.readFileSync(hook, 'utf8'), /node harness\/guard\.mjs --staged/);
  assert.doesNotMatch(fs.readFileSync(hook, 'utf8'), /--no-verify/, 'the hook does not invite skipping itself');
  // Windows에는 실행 비트가 없다. Git for Windows는 비트 없이도 훅을 돌린다.
  if (process.platform !== 'win32') assert.ok(fs.statSync(hook).mode & 0o100, 'pre-commit is executable');

  const again = install(dir, '--apply');
  assert.doesNotMatch(again, /\[새로 만듦\]|\[고침\]|\[건너뜀\]/);
});

test('user content in AGENTS.md, CLAUDE.md and settings.json is kept; only the marked block is replaced', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Team rules\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# My project\n\nKeep this.\n');
  const allow = { allow: ['Bash(node harness/check.mjs:*)'] };
  const userStop = { hooks: [{ type: 'command', command: 'say done' }] };
  const before = { model: 'x', permissions: allow, hooks: { Stop: [userStop] } };
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify(before));
  install(dir, '--apply');
  assert.ok(read(dir, 'AGENTS.md').startsWith('# Team rules\n\n<!-- harness-starter:begin -->'));
  const first = read(dir, 'CLAUDE.md');
  assert.ok(first.startsWith('# My project\n\nKeep this.\n\n<!-- harness-starter:begin -->'));
  const settings = JSON.parse(read(dir, '.claude/settings.json'));
  assert.equal(settings.model, 'x');
  assert.deepEqual(settings.hooks.Stop[0], userStop, 'the user Stop hook stays first; the ledger Stop hook is added after it');
  assert.equal(settings.hooks.PostToolUse.length, 1, 'the checker named in permissions is not the hook');

  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), first.replace('간결함 원칙', 'old text') + '\nAfter block.\n');
  assert.match(install(dir, '--apply'), /\[고침\] CLAUDE\.md/);
  assert.match(read(dir, 'CLAUDE.md'), /간결함 원칙[\s\S]*After block\./);
  assert.equal(read(dir, 'CLAUDE.md').split('harness-starter:begin').length, 2, 'one block only');
});

test('existing files that differ are left alone with a note', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), '{ broken');
  fs.writeFileSync(path.join(dir, 'harness/config.json'), '{ "maxFileLines": 800 }\n');
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nnpm test\n');
  const out = install(dir, '--apply');
  assert.match(out, /\[건너뜀\] \.claude\/settings\.json — JSON으로 읽을 수 없어/);
  assert.match(out, /\[건너뜀\] harness\/config\.json — 이미 다른 내용이 있어/);
  assert.match(out, /\[건너뜀\] \.git\/hooks\/pre-commit — 이미 있는 pre-commit 끝에/);
  assert.equal(read(dir, '.claude/settings.json'), '{ broken');
  assert.equal(read(dir, 'harness/config.json'), '{ "maxFileLines": 800 }\n');
  assert.equal(read(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nnpm test\n');
});

test('a hooks folder managed by another tool, a folder without git, and parts left out', t => {
  const husky = project(t);
  execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: husky });
  assert.match(install(husky, '--apply'), /\[건너뜀\] pre-commit — 훅 폴더\(\.husky\/_\)를 쓰는 도구/);

  const plain = project(t, { git: false });
  const plainOut = install(plain);
  for (const rel of ['pre-commit', '.codex/hooks.json', '.agents/hooks.json']) {
    assert.ok(plainOut.includes(`[건너뜀] ${rel} — git 저장소가 아니다.`), rel);
  }
  assert.match(plainOut, /\[새로 만듦\] \.claude\/settings\.json/, 'Claude finds the checker through CLAUDE_PROJECT_DIR');

  const some = project(t);
  install(some, '--apply', '--without=git-hook,lean-review');
  assert.ok(fs.existsSync(path.join(some, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(some, '.git/hooks/pre-commit')));
  assert.ok(!fs.existsSync(path.join(some, '.claude/skills')));

  const bad = spawnSync(process.execPath, [installer, some, '--without=hooks'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /모르는 장치: hooks/);
});

test('--upgrade swaps the old checker and old-shaped config.json only when asked, keeping project rules', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.writeFileSync(path.join(dir, 'harness/check.mjs'), '// old checker\n');
  const mine = { regex: '^from db import', message: 'db를 직접 부르지 않는다' };
  const limits = { maxFileLines: 300, maxLineLength: 100, notCode: ['.md'] };
  const old = { ...limits, maxCommitLines: 250, ignore: ['gen/'], patterns: [mine] };
  fs.writeFileSync(path.join(dir, 'harness/config.json'), JSON.stringify(old));

  assert.match(install(dir, '--apply'), /\[건너뜀\] harness\/check\.mjs/, 'without --upgrade nothing is replaced');
  assert.equal(read(dir, 'harness/check.mjs'), '// old checker\n');
  assert.match(install(dir, '--upgrade'), /\[고침\] harness\/check\.mjs[\s\S]*\[고침\] harness\/config\.json — 옛 한도/);
  assert.equal(read(dir, 'harness/check.mjs'), '// old checker\n', 'the preview writes nothing');
  assert.deepEqual(JSON.parse(read(dir, 'harness/config.json')), old);

  install(dir, '--apply', '--upgrade');
  assert.equal(read(dir, 'harness/check.mjs'), fs.readFileSync(checker, 'utf8'));
  const moved = { kinds: {}, maxCommitLines: 250, ignore: ['gen/'], patterns: [mine] };
  assert.deepEqual(JSON.parse(read(dir, 'harness/config.json')), moved);
  assert.equal(spawnSync(process.execPath, ['harness/check.mjs', '--staged'], { cwd: dir }).status, 0);
  assert.match(install(dir, '--apply', '--upgrade'), /\[그대로\] harness\/check\.mjs\n\[그대로\] harness\/config\.json/);
});

test('the installed git hook blocks a commit that breaks the limits', t => {
  const dir = project(t);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  install(dir, '--apply');
  setKinds(dir, JS_KIND);
  fs.writeFileSync(path.join(dir, 'a.js'), 'try { go(); } catch (e) {}\n');
  git('add', '-A');
  const blocked = git('commit', '-q', '-m', 'x');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout + blocked.stderr, /빈 catch/);
  fs.writeFileSync(path.join(dir, 'a.js'), 'go();\n');
  git('add', '-A');
  const noTask = git('commit', '-q', '-m', 'x');
  assert.notEqual(noTask.status, 0);
  assert.match(noTask.stdout + noTask.stderr, /진행중인 작업이 없다/);
  const backlog = (...args) => spawnSync(process.execPath, ['harness/backlog.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  backlog('추가', '일');
  assert.equal(backlog('시작', 'T-1', '--영역', 'a.js', '--확인방법', 'npm test').status, 0);
  assert.equal(git('commit', '-q', '-m', 'x').status, 0);
});

test('a line added after the check in the git hook does not hide a failed check', t => {
  const dir = project(t);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  install(dir, '--apply');
  setKinds(dir, JS_KIND);
  fs.appendFileSync(path.join(dir, '.git/hooks/pre-commit'), 'true\n');
  fs.writeFileSync(path.join(dir, 'a.js'), 'try { go(); } catch (e) {}\n');
  git('add', '-A');
  assert.notEqual(git('commit', '-q', '-m', 'x').status, 0);
});

test('the git hook lets commits through on a branch without the harness', t => {
  const dir = project(t);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('switch', '-q', '-c', 'ai/harness');
  install(dir, '--apply');
  git('add', '-A');
  git('commit', '-q', '-m', 'harness');
  git('switch', '-q', '-');
  fs.writeFileSync(path.join(dir, 'b.js'), 'go();\n');
  git('add', 'b.js');
  assert.equal(git('commit', '-q', '-m', 'y').status, 0);
});

test('a CLAUDE.md that already imports AGENTS.md is left alone; a subfolder of a repository gets no git hook', t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Notes\n@AGENTS.md\n');
  assert.match(install(dir, '--apply'), /\[그대로\] CLAUDE\.md/);
  assert.equal(read(dir, 'CLAUDE.md'), '# Notes\n@AGENTS.md\n');
  assert.match(read(dir, 'AGENTS.md'), /간결함 원칙/);

  fs.mkdirSync(path.join(dir, 'app'));
  const out = install(path.join(dir, 'app'), '--apply');
  for (const rel of ['pre-commit', '.codex/hooks.json', '.agents/hooks.json', 'harness/backlog.mjs']) {
    assert.ok(out.includes(`[건너뜀] ${rel} — 저장소 맨 위가 아니다.`), rel);
  }
  const hooks = JSON.parse(read(path.join(dir, 'app'), '.claude/settings.json')).hooks;
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.PreToolUse, undefined, 'guard.mjs is not installed there, so nothing may call it');
});

test('the work ledger is installed with its file kept out of git, and can be left out', t => {
  const dir = project(t);
  assert.match(install(dir), /\[새로 만듦\] harness\/backlog\.mjs[\s\S]*\[고침\] \.git\/info\/exclude/);
  install(dir, '--apply');
  for (const file of ['backlog.mjs', 'ledger.mjs', 'questions.mjs', 'page.mjs', 'patch.mjs', 'serve.mjs', 'guard.mjs']) assert.ok(fs.existsSync(path.join(dir, 'harness', file)), file);
  for (const line of ['backlog\\.json', 'backlog\\.json\\.tmp', 'backlog\\.lock', 'questions\\.html']) assert.match(read(dir, '.git/info/exclude'), new RegExp(`^harness/${line}$`, 'm'));
  const run = spawnSync(process.execPath, ['harness/backlog.mjs', '추가', '시험'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const status = execFileSync('git', ['status', '--short', '-uall'], { cwd: dir, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(dir, 'harness/backlog.json')));
  assert.doesNotMatch(status, /backlog\.json/, 'the ledger is not offered to git add');

  // 검사 훅을 모두 뺀 설치에서도 명령이 읽을 config.json은 있어야 한다.
  const only = project(t);
  install(only, '--apply', '--without=instructions,claude-hook,codex-hook,antigravity-hook,git-hook,lean-review');
  const list = spawnSync(process.execPath, ['harness/backlog.mjs', '목록'], { cwd: only, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);

  const without = project(t);
  install(without, '--apply', '--without=backlog');
  assert.ok(!fs.existsSync(path.join(without, 'harness/backlog.mjs')) && !fs.existsSync(path.join(without, 'harness/guard.mjs')));
  assert.doesNotMatch(read(without, '.git/info/exclude'), /backlog/);
  assert.equal(JSON.parse(read(without, '.claude/settings.json')).hooks.PreToolUse, undefined, 'no ledger, nothing to guard');
});

test('without the ledger commits are not blocked by the guard line; adding the ledger later adds the guard hook once', t => {
  const dir = project(t);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  install(dir, '--apply', '--without=backlog');
  setKinds(dir, JS_KIND);
  fs.writeFileSync(path.join(dir, 'a.js'), 'go();\n');
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'x').status, 0, 'the guard file is absent, so its line passes');

  const out = install(dir, '--apply');
  assert.match(out, /\[새로 만듦\] harness\/guard\.mjs/);
  assert.match(out, /\[고침\] \.claude\/settings\.json/);
  const hooks = JSON.parse(read(dir, '.claude/settings.json')).hooks;
  assert.equal(hooks.PostToolUse.length, 1);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.doesNotMatch(install(dir, '--apply'), /\[고침\]/);
});

test('an old principles block next to @AGENTS.md in CLAUDE.md is removed (principles in one place)', t => {
  const dir = project(t);
  const old = '<!-- harness-starter:begin -->\nold principles\n<!-- harness-starter:end -->';
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `@AGENTS.md\n\n${old}\n\nMy note.\n`);
  assert.match(install(dir, '--apply'), /\[고침\] CLAUDE\.md/);
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n\nMy note.\n');
  assert.match(install(dir, '--apply'), /\[그대로\] CLAUDE\.md/);
});

test('an Antigravity hooks file keeps its other hook groups', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.agents'));
  fs.writeFileSync(path.join(dir, '.agents/hooks.json'), '{ "lint": { "PostToolUse": [] } }\n');
  install(dir, '--apply', '--without=codex-hook,claude-hook');
  const hooks = JSON.parse(read(dir, '.agents/hooks.json'));
  assert.deepEqual(hooks.lint, { PostToolUse: [] });
  assert.equal(hooks['harness-starter'].PostToolUse.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, '.codex')) && !fs.existsSync(path.join(dir, '.claude/settings.json')));
});
