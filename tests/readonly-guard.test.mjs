import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repo, ok } from './helpers.mjs';

// 코드(src)와 문서(md) 두 종류를 둔 임시 저장소. 입력 모양은 tool-hooks.test.mjs와 같다(각 도구가 훅에 실제로 넘긴 모양, 2026-10-10 기록).
function project(t) {
  const dir = fs.realpathSync(repo(t));
  const file = path.join(dir, 'harness/config.json');
  const kinds = { code: { files: ['src/**'], maxFileLines: 300 }, docs: { files: ['**/*.md'] } };
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), kinds }));
  return dir;
}

const startTask = dir => {
  ok(dir, '추가', '일');
  ok(dir, '시작', 'T-1', '--영역', 'src', '--확인방법', 'npm test');
};

function guard(dir, input, readOnly) {
  const env = { ...process.env };
  delete env.HARNESS_READ_ONLY;
  if (readOnly !== undefined) env.HARNESS_READ_ONLY = readOnly;
  return spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], { cwd: dir, env, input: JSON.stringify(input), encoding: 'utf8' });
}

const claude = (dir, tool_name, tool_input) => ({ cwd: dir, hook_event_name: 'PreToolUse', tool_name, tool_input });
const codexPatch = (dir, ...lines) => claude(dir, 'apply_patch', { command: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') });
const agy = (dir, name, args) => ({ toolCall: { name, args }, workspacePaths: [dir], stepIdx: 2, conversationId: 'c' });

// 고치는 도구와 명령 실행 도구. 진행중 작업이 있어 변수가 없으면 모두 통과하는 입력이다.
function writing(dir) {
  const file = path.join(dir, 'src/a.js');
  return {
    'Antigravity write_to_file': agy(dir, 'write_to_file', { TargetFile: file, CodeContent: 'x' }),
    'Antigravity replace_file_content': agy(dir, 'replace_file_content', { TargetFile: file }),
    'Antigravity multi_replace_file_content': agy(dir, 'multi_replace_file_content', { TargetFile: file }),
    'Antigravity run_command': agy(dir, 'run_command', { CommandLine: 'echo hi > out.txt', Cwd: dir }),
    'Claude Edit': claude(dir, 'Edit', { file_path: file }),
    'Claude Write': claude(dir, 'Write', { file_path: file }),
    'Claude MultiEdit': claude(dir, 'MultiEdit', { file_path: file }),
    'Claude NotebookEdit': claude(dir, 'NotebookEdit', { notebook_path: path.join(dir, 'a.ipynb') }),
    'Claude Bash': claude(dir, 'Bash', { command: 'ls' }),
    'Codex apply_patch': codexPatch(dir, '*** Add File: src/a.js', '+x'),
    'Codex Bash': claude(dir, 'Bash', { command: 'cat src/a.js' }),
  };
}

const READ_ONLY_REASON = /^guard: .*읽기 전용.*HARNESS_READ_ONLY=1.*고치거나 명령을 실행하지 않는다/;

test('HARNESS_READ_ONLY=1 refuses every editing and command tool, even with a 진행중 task', t => {
  const dir = project(t);
  startTask(dir);
  for (const [name, input] of Object.entries(writing(dir))) {
    const result = guard(dir, input, '1');
    assert.equal(result.status, 2, `${name} must be refused`);
    assert.match(result.stderr, READ_ONLY_REASON, name);
  }
});

test('HARNESS_READ_ONLY=1 still lets reads through, except the ledger file', t => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'x\n');
  assert.equal(guard(dir, agy(dir, 'view_file', { AbsolutePath: path.join(dir, 'src/a.js') }), '1').status, 0, 'Antigravity view_file');
  assert.equal(guard(dir, claude(dir, 'Read', { file_path: path.join(dir, 'src/a.js') }), '1').status, 0, 'Claude Read');
  const ledger = guard(dir, claude(dir, 'Read', { file_path: path.join(dir, 'harness/backlog.json') }), '1');
  assert.equal(ledger.status, 2);
  assert.match(ledger.stderr, /harness\/backlog\.json은\(는\) Read로 직접 다루지 않는다/);
});

test('without HARNESS_READ_ONLY or with 0 the guard behaves as before', t => {
  const dir = project(t);
  for (const readOnly of [undefined, '0']) {
    const refused = guard(dir, claude(dir, 'Edit', { file_path: path.join(dir, 'src/a.js') }), readOnly);
    assert.equal(refused.status, 2, 'no 진행중 task: code edit is refused as before');
    assert.match(refused.stderr, /진행중인 작업이 없다/);
  }
  startTask(dir);
  for (const readOnly of [undefined, '0']) {
    for (const [name, input] of Object.entries(writing(dir))) {
      const result = guard(dir, input, readOnly);
      assert.equal(result.status, 0, `${name} (HARNESS_READ_ONLY=${readOnly}): ${result.stderr}`);
    }
  }
});
