// 설치기가 질문 페이지 서버의 상태(토큰이 든 serve.json)와 로그를 git에서 빼는지 본다. 새 설치와 --upgrade 모두.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
// 설치기가 HOME 아래 명부(~/.harness-starter)에 적으므로 진짜 HOME을 건드리지 않게 임시 HOME을 준다.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const LEDGER_LINES = ['harness/backlog.json', 'harness/backlog.json.tmp', 'harness/backlog.lock', 'harness/questions.html'];
const SERVE_LINES = ['harness/serve.json', 'harness/serve.json.tmp', 'harness/serve.log'];
const EXCLUDE = '.git/info/exclude';

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-serve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

// 이 저장소의 장부 명령으로 돈 서버 프로세스들. 맥의 임시 폴더는 링크라 실제 경로로 찾는다.
const servers = real => execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`${real}/harness/backlog.mjs 서버`));

// 켜 둔 서버를 시험이 끝날 때 끈다. 단언이 실패해도 남지 않게 켜는 명령 바로 뒤, 단언보다 먼저 부른다.
function stopLater(t, dir) {
  if (!fs.existsSync(path.join(dir, 'harness/serve.json'))) return;
  const { pid } = JSON.parse(fs.readFileSync(path.join(dir, 'harness/serve.json'), 'utf8'));
  t.after(() => {
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}

let keptReal;

test('a new install keeps the server state and log out of git, once, even while the server is on', t => {
  const dir = project(t);
  keptReal = fs.realpathSync(dir);
  assert.match(install(dir), /\[고침\] \.git\/info\/exclude/);
  install(dir, '--apply');
  for (const line of SERVE_LINES) assert.equal(count(excludeLines(dir), line), 1, line);
  assert.match(install(dir, '--apply'), /\[그대로\] \.git\/info\/exclude/);
  for (const line of SERVE_LINES) assert.equal(count(excludeLines(dir), line), 1, line);

  const kept = spawnSync(process.execPath, ['harness/backlog.mjs', '켜두기'], { cwd: dir, encoding: 'utf8' });
  stopLater(t, dir);
  assert.equal(kept.status, 0, kept.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'harness/serve.json')) && fs.existsSync(path.join(dir, 'harness/serve.log')));
  const status = execFileSync('git', ['status', '--short', '-uall'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(status, /serve\.json|serve\.log/);
});

test('the server started above is gone after its test ends', async () => {
  for (let tries = 0; tries < 20 && servers(keptReal).length; tries++) await sleep(100);
  assert.deepEqual(servers(keptReal), []);
});

test('--apply --upgrade adds the server lines to an old exclude and keeps the ledger lines and the user\'s own line', t => {
  const dir = project(t);
  install(dir, '--apply');
  fs.writeFileSync(path.join(dir, EXCLUDE), excludeLines(dir).filter(line => !SERVE_LINES.includes(line)).join('\n') + 'my-notes.txt\n');
  assert.match(install(dir, '--apply', '--upgrade'), /\[고침\] \.git\/info\/exclude/);
  const lines = excludeLines(dir);
  for (const line of [...LEDGER_LINES, 'my-notes.txt', ...SERVE_LINES]) assert.equal(count(lines, line), 1, line);
});
