// 설치기가 질문 페이지 서버의 상태(토큰이 든 serve.json)와 로그를 git에서 빼는지 본다. 새 설치와 --upgrade 모두.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, stopServerAtEnd } from './helpers.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
// 설치기가 HOME 아래 명부(~/.harness-starter)에 적으므로 진짜 HOME을 건드리지 않게 임시 HOME을 준다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const LEDGER_LINES = ['harness/backlog.json', 'harness/backlog.json.tmp', 'harness/backlog.lock', 'harness/questions.html'];
const SERVE_LINES = ['harness/serve.json', 'harness/serve.json.tmp', 'harness/serve.log'];
const EXCLUDE = '.git/info/exclude';

function project(t) {
  const dir = tempDir(t, 'harness-install-serve-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const excludeLines = dir => fs.readFileSync(path.join(dir, EXCLUDE), 'utf8').split('\n');
const count = (lines, line) => lines.filter(each => each === line).length;

let keptPid;

test('a new install keeps the server state and log out of git, once, even while the server is on', t => {
  const dir = project(t);
  assert.match(install(dir), /\[고침\] \.git\/info\/exclude/);
  install(dir, '--apply');
  for (const line of SERVE_LINES) assert.equal(count(excludeLines(dir), line), 1, line);
  assert.match(install(dir, '--apply'), /\[그대로\] \.git\/info\/exclude/);
  for (const line of SERVE_LINES) assert.equal(count(excludeLines(dir), line), 1, line);

  const kept = spawnSync(process.execPath, ['harness/backlog.mjs', '켜두기'], { cwd: dir, encoding: 'utf8' });
  stopServerAtEnd(t, dir);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'harness/serve.json')) && fs.existsSync(path.join(dir, 'harness/serve.log')));
  keptPid = JSON.parse(fs.readFileSync(path.join(dir, 'harness/serve.json'), 'utf8')).pid;
  assert.ok(process.kill(keptPid, 0));
  const status = execFileSync('git', ['status', '--short', '-uall'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(status, /serve\.json|serve\.log/);
});

test('the server started above is gone after its test ends', () => {
  assert.throws(() => process.kill(keptPid, 0), { code: 'ESRCH' });
});

test('--apply --upgrade adds the server lines to an old exclude and keeps the ledger lines and the user\'s own line', t => {
  const dir = project(t);
  install(dir, '--apply');
  fs.writeFileSync(path.join(dir, EXCLUDE), excludeLines(dir).filter(line => !SERVE_LINES.includes(line)).join('\n') + 'my-notes.txt\n');
  assert.match(install(dir, '--apply', '--upgrade'), /\[고침\] \.git\/info\/exclude/);
  const lines = excludeLines(dir);
  for (const line of [...LEDGER_LINES, 'my-notes.txt', ...SERVE_LINES]) assert.equal(count(lines, line), 1, line);
});

const serveState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/serve.json'), 'utf8'));

function keepServer(t, dir) {
  install(dir, '--apply');
  const kept = spawnSync(process.execPath, ['harness/backlog.mjs', '켜두기'], { cwd: dir, encoding: 'utf8' });
  stopServerAtEnd(t, dir);
  assert.equal(kept.status, 0, kept.stderr);
  return serveState(dir);
}

test('--apply --upgrade restarts a running server with the same port and token', t => {
  const dir = project(t);
  const before = keepServer(t, dir);
  assert.match(install(dir, '--apply', '--upgrade'), /\[다시 켬\] 질문 페이지 서버/);
  stopServerAtEnd(t, dir);
  const after = serveState(dir);
  assert.notEqual(after.pid, before.pid);
  assert.throws(() => process.kill(before.pid, 0), { code: 'ESRCH' });
  assert.ok(process.kill(after.pid, 0));
  assert.ok(before.포트 && before.토큰);
  assert.equal(after.포트, before.포트);
  assert.equal(after.토큰, before.토큰);
});

test('--apply --upgrade leaves a stopped server off', t => {
  const dir = project(t);
  keepServer(t, dir);
  execFileSync(process.execPath, ['harness/backlog.mjs', '끄기'], { cwd: dir });
  assert.doesNotMatch(install(dir, '--apply', '--upgrade'), /다시 켬/);
  assert.equal(serveState(dir).pid, undefined);
});

test('--apply --upgrade does not start a server that was never kept on', t => {
  const dir = project(t);
  install(dir, '--apply');
  install(dir, '--apply', '--upgrade');
  assert.ok(!fs.existsSync(path.join(dir, 'harness/serve.json')));
});

test('the --upgrade preview lists the restart and leaves the server alone', t => {
  const dir = project(t);
  const before = keepServer(t, dir);
  assert.match(install(dir, '--upgrade'), /\[다시 켬\] .*--apply면/);
  assert.equal(serveState(dir).pid, before.pid);
});
