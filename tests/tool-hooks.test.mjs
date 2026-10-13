import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, ok } from './helpers.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const KINDS = { code: { files: ['src/**'], maxFileLines: 300 }, docs: { files: ['**/*.md'] } };

// 코드(src)와 문서(md) 두 종류를 둔 임시 저장소. 입력은 각 도구가 훅에 실제로 넘긴 모양이다(2026-10-10 기록).
function project(t) {
  const dir = fs.realpathSync(repo(t));
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), kinds: KINDS }));
  return dir;
}

const startTask = dir => {
  ok(dir, '추가', '일');
  ok(dir, '시작', 'T-1', '--영역', 'src', '--확인방법', 'npm test');
};

function guard(dir, input, cwd = dir) {
  const result = spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd, input: JSON.stringify(input), encoding: 'utf8' });
  assert.ok([0, 2].includes(result.status), `exit ${result.status}: ${result.stderr}`);
  return result;
}

const blocked = (result, pattern) => {
  assert.equal(result.status, 2, '거절돼야 한다');
  assert.match(result.stderr, pattern);
};

// Codex: 편집은 apply_patch이고 tool_input.command가 패치 글이다. 셸은 Bash.
const codexPatch = (dir, ...lines) => ({
  cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') },
});
const codexShell = (dir, command) => ({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// Antigravity: cwd와 tool_name이 없고 toolCall과 workspacePaths가 온다. 훅 프로세스의 작업 폴더는 저장소 맨 위가 아닌 .agents였다.
const agy = (dir, name, args) => ({ toolCall: { name, args }, workspacePaths: [dir], stepIdx: 2, conversationId: 'c' });
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';

test('Codex: apply_patch is judged by the files in its patch text, absolute or relative, every kind of line', t => {
  const dir = project(t);
  blocked(guard(dir, codexPatch(dir, `*** Add File: ${dir}/src/a.js`, '+x')), /src\/a\.js|진행중인 작업이 없다/);
  blocked(guard(dir, codexPatch(dir, '*** Update File: src/a.js', '@@', '-a', '+b')), /진행중인 작업이 없다/);
  blocked(guard(dir, codexPatch(dir, '*** Update File: notes.md', '*** Update File: src/b.js', '@@', '-a', '+b')), /진행중인 작업이 없다/);
  blocked(guard(dir, codexPatch(dir, '*** Update File: harness/check.mjs', '@@', '-a', '+b')), /harness\/check\.mjs은\(는\) 검사 설정/);
  blocked(guard(dir, codexPatch(dir, '*** Delete File: harness/guard.mjs')), /harness\/guard\.mjs은\(는\) 검사 설정/);
  blocked(guard(dir, codexPatch(dir, '*** Update File: notes.md', '*** Move to: harness/config.json', '@@', '-a', '+b')), /harness\/config\.json은\(는\) 검사 설정/);
  assert.equal(guard(dir, codexPatch(dir, '*** Add File: notes.md', '+문서')).status, 0, 'docs need no task');
  startTask(dir);
  assert.equal(guard(dir, codexPatch(dir, '*** Add File: src/a.js', '+x')).status, 0, 'with a 진행중 task code can be edited');
  blocked(guard(dir, codexPatch(dir, '*** Update File: harness/check.mjs', '@@', '-a', '+b')), /검사 설정/);
});

test('Codex: headers the real patch reader accepts are all read: leading whitespace, after an Add body, CRLF, trailing spaces', t => {
  const dir = project(t);
  const patch = (...lines) => ({ cwd: dir, tool_name: 'apply_patch', tool_input: { command: lines.join('\n') } });
  blocked(guard(dir, patch(BEGIN, '  *** Update File: harness/check.mjs', '@@', '-a', '+b', END)), /검사 설정/);
  blocked(guard(dir, patch(BEGIN, '\t*** Update File: harness/check.mjs', '@@', '-a', '+b', END)), /검사 설정/);
  blocked(guard(dir, patch(BEGIN, '*** Add File: notes.md', '+문서', '  *** Add File: src/a.js', '+x', END)), /진행중인 작업이 없다/);
  blocked(guard(dir, patch(`${BEGIN}\r`, '*** Update File: harness/check.mjs\r', '@@\r', '-a\r', '+b\r', `${END}\r`)), /검사 설정/);
  blocked(guard(dir, patch(BEGIN, '*** Update File: harness/check.mjs   ', '@@', '-a', '+b', END)), /검사 설정/);
  assert.equal(guard(dir, patch(BEGIN, '*** Add File: notes.md', '+*** Add File: src/a.js', '+*** Update File: harness/check.mjs', END)).status, 0, 'a line of an added file is not a header');
});

test('Codex: a patch given to a shell command (apply_patch <<EOF) is judged like an apply_patch call', t => {
  const dir = project(t);
  const heredoc = (...lines) => codexShell(dir, ["apply_patch <<'EOF'", BEGIN, ...lines, END, 'EOF'].join('\n'));
  blocked(guard(dir, heredoc('*** Update File: harness/check.mjs', '@@', '-a', '+b')), /harness\/check\.mjs은\(는\) 검사 설정/);
  blocked(guard(dir, heredoc('*** Add File: src/a.js', '+x')), /진행중인 작업이 없다/);
  assert.equal(guard(dir, heredoc('*** Add File: notes.md', '+문서')).status, 0);
  startTask(dir);
  assert.equal(guard(dir, heredoc('*** Add File: src/a.js', '+x')).status, 0);
});

test('Codex: shell commands are checked for the ledger file and --no-verify', t => {
  const dir = project(t);
  blocked(guard(dir, codexShell(dir, 'cat harness/backlog.json')), /backlog\.json은 직접/);
  blocked(guard(dir, codexShell(dir, 'git commit -m x --no-verify')), /--no-verify/);
  assert.equal(guard(dir, codexShell(dir, 'ls')).status, 0);
  assert.equal(guard(dir, codexShell(dir, 'node harness/backlog.mjs 목록')).status, 0);
});

test('Antigravity: toolCall is read, from the .agents folder the hook process runs in (inside the repository)', t => {
  const dir = project(t);
  const agents = path.join(dir, '.agents');
  fs.mkdirSync(agents);
  blocked(guard(dir, agy(dir, 'write_to_file', { TargetFile: `${dir}/src/a.js`, CodeContent: 'x' }), agents), /진행중인 작업이 없다/);
  blocked(guard(dir, agy(dir, 'replace_file_content', { TargetFile: `${dir}/src/a.js` }), agents), /진행중인 작업이 없다/);
  blocked(guard(dir, agy(dir, 'multi_replace_file_content', { TargetFile: `${dir}/harness/ledger.mjs` }), agents), /harness\/ledger\.mjs은\(는\) 검사 설정/);
  blocked(guard(dir, agy(dir, 'view_file', { AbsolutePath: `${dir}/harness/backlog.json` }), agents), /backlog\.json은\(는\) Read로 직접/);
  blocked(guard(dir, agy(dir, 'run_command', { CommandLine: 'cat harness/backlog.json', Cwd: dir }), agents), /backlog\.json은 직접/);
  for (const [name, args] of [['view_file', { AbsolutePath: `${dir}/src/a.js` }], ['view_file', { AbsolutePath: `${dir}/harness/check.mjs` }],
    ['run_command', { CommandLine: 'ls', Cwd: dir }], ['write_to_file', { TargetFile: `${dir}/notes.md` }], ['list_dir', { DirectoryPath: dir }]]) {
    assert.equal(guard(dir, agy(dir, name, args), agents).status, 0, `${name} ${JSON.stringify(args)}`);
  }
  startTask(dir);
  assert.equal(guard(dir, agy(dir, 'write_to_file', { TargetFile: `${dir}/src/a.js` }), agents).status, 0);
});

// 설치기: 장부를 설치하면 Codex와 Antigravity에도 쓰기 전 훅이 들어간다.
function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const GUARD_COMMAND = 'node "$(git rev-parse --show-toplevel)/harness/guard.mjs" --hook';

test('the installer adds the before-use guard to the Codex and Antigravity hooks only with the ledger, once, keeping other hooks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-toolhooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo 내 훅' }] };
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [userHook] } }));
  install(dir, '--apply');
  const codex = JSON.parse(fs.readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(codex.PreToolUse, [userHook, { matcher: 'apply_patch|Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] }]);
  assert.equal(codex.PostToolUse[0].matcher, 'apply_patch|Edit|Write');
  const antigravity = JSON.parse(fs.readFileSync(path.join(dir, '.agents/hooks.json'), 'utf8'))['harness-starter'];
  assert.deepEqual(antigravity.PreToolUse, [{
    matcher: 'write_to_file|replace_file_content|multi_replace_file_content|run_command|view_file',
    hooks: [{ type: 'command', command: GUARD_COMMAND }],
  }]);
  assert.doesNotMatch(install(dir, '--apply'), /\[(고침|건너뜀|새로 만듦)\]/, 'a second run changes nothing');

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-toolhooks-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: plain });
  install(plain, '--apply', '--without=backlog');
  for (const rel of ['.codex/hooks.json', '.agents/hooks.json']) assert.doesNotMatch(fs.readFileSync(path.join(plain, rel), 'utf8'), /PreToolUse|guard\.mjs/, rel);
});
