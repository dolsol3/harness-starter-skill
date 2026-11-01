import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { killTree, callTool } from '../templates/harness/mullebanga-call.mjs';
import { runChecks } from '../templates/harness/mullebanga-git.mjs';
import { writeFakeTool } from './helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'taskkill은 Windows에만 있다' };
const noRoot = path.join(os.tmpdir(), 'no-such-root');

test('killTree(Windows): PATH 없이도 트리를 끄고, 끝난 pid는 조용하며, taskkill을 못 띄우면 이유를 돌려준다', windowsOnly, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const oldPath = process.env.PATH;
  const oldRoot = process.env.SystemRoot;
  try {
    process.env.PATH = '';
    assert.equal(killTree(child, 'SIGKILL'), undefined);
    await new Promise(resolve => child.on('close', resolve));
    assert.equal(killTree(child, 'SIGKILL'), undefined);
    process.env.SystemRoot = noRoot;
    assert.match(killTree(child, 'SIGKILL'), /taskkill 실행 못 함/);
  } finally {
    process.env.PATH = oldPath;
    process.env.SystemRoot = oldRoot;
  }
});

// 끄기 실패는 SystemRoot를 없는 폴더로 바꿔 taskkill을 못 띄우게 만든다. 남은 자식은 시험 끝에 진짜 taskkill로 끈다.
function failKills(t) {
  const oldRoot = process.env.SystemRoot;
  const restore = () => { process.env.SystemRoot = oldRoot; };
  t.after(restore);
  return { restore, broken: () => { process.env.SystemRoot = noRoot; } };
}
const killLeft = text => {
  const pid = text.match(/pid (\d+)/)?.[1];
  if (pid) execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
};

test('callTool(Windows): 끄기에 실패해도 시간 안에 돌아오고 남은 pid와 끄기 실패를 드러낸다', windowsOnly, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kill-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFakeTool(dir, 'codex', 'setInterval(() => {}, 1000);\n');
  const kills = failKills(t);
  const env = { ...process.env, PATH: [dir, path.dirname(process.execPath)].join(path.delimiter) };
  kills.broken();
  const started = Date.now();
  const res = await callTool({ tool: 'codex', prompt: '일을 해', cwd: dir, schema: {}, timeoutMs: 300, env });
  const elapsed = Date.now() - started;
  kills.restore();
  killLeft(res.detail);
  assert.equal(res.reason, '시간초과');
  assert.match(res.detail, /끄기 실패, pid \d+와 자손이 남았을 수 있다: taskkill 실행 못 함/);
  assert.ok(elapsed < 1500, `${elapsed}ms`);
});

test('runChecks: seconds를 주지 않으면 900초에서 끊는다(가짜 시계라 기다리지 않는다)', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kill-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  // 셸은 첫 await 전에 떠서 가짜 setTimeout이 시간 제한을 잡는다. 시계를 900초로 넘기면 진짜 프로세스도 끈다.
  const running = runChecks(dir, ['node -e "setInterval(() => {}, 1000)"']).then(result => { done = true; return result; });
  t.mock.timers.tick(899_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  t.mock.timers.tick(1);
  const result = await running;
  assert.equal(result.exitCode, null);
  assert.match(result.output, /시간 초과: 900초/);
});

test('runChecks(Windows): 끄기에 실패해도 시간 안에 돌아오고 남은 pid와 끄기 실패를 드러낸다', windowsOnly, async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-kill-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kills = failKills(t);
  const started = Date.now();
  // runChecks는 첫 await 전에 셸을 띄우므로, 띄운 뒤에 SystemRoot를 망가뜨려도 셸은 진짜 값을 받는다.
  const running = runChecks(dir, ['node -e "setInterval(() => {}, 1000)"'], { seconds: 1 });
  kills.broken();
  const result = await running;
  const elapsed = Date.now() - started;
  kills.restore();
  killLeft(result.output);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /끄기에 실패해 pid \d+와 자손이 남았을 수 있다 \(taskkill 실행 못 함/);
  assert.ok(elapsed < 2500, `${elapsed}ms`);
});
