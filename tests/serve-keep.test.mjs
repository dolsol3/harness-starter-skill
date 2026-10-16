// 켜두기·끄기: 떨어진 프로세스로 띄운 질문 페이지가 명령이 끝나도 돌고, 포트·토큰이 저장돼 링크가 바뀌지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { repo, ok, backlog } from './helpers.mjs';

const LINK = /^질문 페이지: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{32}))$/m;
const state = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/serve.json'), 'utf8'));
const status = async url => (await fetch(url)).status;

// 이 저장소의 장부 명령으로 돈 서버 프로세스들(ps에 보이는 명령 줄). 맥의 임시 폴더는 링크라 실제 경로로 찾는다.
const servers = dir => execFileSync('ps', ['-ax', '-o', 'command'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(`${fs.realpathSync(dir)}/harness/backlog.mjs 서버`));

// 시험이 끝나면 띄운 서버를 끈다. 임시 폴더가 먼저 지워져도 끌 수 있게 켠 직후 읽은 pid로 끈다.
// 단언이 실패해도 서버가 남지 않게 켜는 명령 바로 뒤, 단언보다 먼저 부른다. 상태 파일이 없으면 띄운 서버도 없다.
function stopLater(t, dir) {
  if (!fs.existsSync(path.join(dir, 'harness/serve.json'))) return;
  const { pid } = state(dir);
  t.after(() => {
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}

// 켜두기를 끝날 때까지 기다려 부르고, 링크를 읽어 돌려준다.
function keep(t, dir, ...args) {
  const started = Date.now();
  const result = backlog(dir, '켜두기', ...args);
  stopLater(t, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 5000, 'keep returns within 5 seconds');
  const [, url, port, token] = result.stdout.match(LINK);
  return { url, port: Number(port), token, out: result.stdout };
}

// kill은 신호만 보내고 돌아온다. 죽는 중인 서버에 fetch를 보내면 잡을 수 없는 예외로 시험이 죽으므로(Node 26.3, undici setTypeOfService EINVAL) 프로세스가 사라질 때까지 기다린다.
async function gone(pid) {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// 포트를 잠깐 열어 보고 닫는다. 0이면 빈 포트를 고른다. 다른 프로그램이 쓰고 있으면 undefined.
async function freePort(port = 0) {
  const probe = net.createServer();
  const opened = await new Promise((resolve, reject) => {
    probe.once('error', error => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
    probe.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (!opened) return undefined;
  const chosen = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return chosen;
}

test('keep starts one detached server that answers after the command ends, and a second keep reuses it', async t => {
  const dir = repo(t);
  const first = keep(t, dir);
  assert.match(first.out, /명령이 끝나도 계속 돈다\. 끄려면 node harness\/backlog\.mjs 끄기/);
  assert.equal(await status(first.url), 200);
  const pid = state(dir).pid;
  const second = keep(t, dir);
  assert.equal(second.url, first.url);
  assert.match(second.out, /이미 켜져 있다/);
  assert.equal(state(dir).pid, pid);
  assert.equal(fs.readFileSync(path.join(dir, 'harness/serve.log'), 'utf8').match(/질문 페이지:/g).length, 1);
  assert.equal(servers(dir).length, 1);
  for (const url of [`http://127.0.0.1:${first.port}/`, `http://127.0.0.1:${first.port}/?token=${'0'.repeat(32)}`]) assert.equal(await status(url), 403, url);
});

test('stop closes the port, a second stop says it is already off, and keep or the foreground server come back with the same link', async t => {
  const dir = repo(t);
  const first = keep(t, dir);
  assert.match(ok(dir, '끄기'), /껐다/);
  await assert.rejects(fetch(first.url));
  assert.deepEqual(servers(dir), []);
  assert.deepEqual(Object.keys(state(dir)), ['포트', '토큰'], 'stop keeps the port and token but drops the pid');
  assert.equal(ok(dir, '목록'), '작업이 없다', 'a stopped page is not revived');
  assert.deepEqual(servers(dir), []);
  assert.match(ok(dir, '끄기'), /이미 꺼져 있다/);
  const again = keep(t, dir);
  assert.equal(again.url, first.url);
  assert.equal(await status(again.url), 200);
  ok(dir, '끄기');
  const child = spawn(process.execPath, [path.join(dir, 'harness/backlog.mjs'), '서버'], { cwd: dir });
  t.after(() => child.kill());
  const out = await new Promise(resolve => child.stdout.on('data', chunk => resolve(String(chunk))));
  assert.equal(out.match(LINK)[1], first.url);
});

test('a port given once is kept, and a different port while it is on is refused', async t => {
  const dir = repo(t);
  const port = await freePort();
  assert.equal(keep(t, dir, '--포트', String(port)).port, port);
  ok(dir, '끄기');
  assert.equal(keep(t, dir).port, port);
  const other = backlog(dir, '켜두기', '--포트', String(await freePort()));
  assert.equal(other.status, 1);
  assert.match(other.stderr, new RegExp(`이미 ${port} 포트에서 켜져 있다.*끄기`));
  assert.match(ok(dir, '켜두기', '--포트', String(port)), /이미 켜져 있다/);
});

// 6000은 브라우저와 fetch가 막는 포트지만 서버는 열 수 있다. 켜졌는지 보는 길이 그 포트에서도 통해야 한다.
test('keep and stop work on a port that fetch refuses (6000)', async t => {
  if (!(await freePort(6000))) return t.skip('another program holds port 6000');
  const dir = repo(t);
  assert.equal(keep(t, dir, '--포트', '6000').port, 6000);
  assert.match(ok(dir, '끄기'), /껐다/);
  assert.deepEqual(servers(dir), []);
});

test('a stored port that another program holds is refused with the port and the reason, and no server is left', async t => {
  const dir = repo(t);
  const { port } = keep(t, dir);
  ok(dir, '끄기');
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(port, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const taken = backlog(dir, '켜두기');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, new RegExp(`${port} 포트.*EADDRINUSE`));
  assert.deepEqual(servers(dir), []);
});

test('a state file left from before a restart (dead pid, silent port) starts a new server with the same token', async t => {
  const dir = repo(t);
  const token = 'a'.repeat(32);
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'harness/serve.json'), JSON.stringify({ 포트: port, 토큰: token, pid: 999999 }));
  const kept = keep(t, dir);
  assert.equal(kept.url, `http://127.0.0.1:${port}/?token=${token}`);
  assert.equal(await status(kept.url), 200);
});

// 재부팅 뒤처럼 저장된 pid를 다른 프로그램이 쓰고, 그 프로그램이 저장된 포트에서 토큰을 보지 않고 200을 준다.
// 시험 프로세스는 명령을 spawnSync로 기다리는 동안 답하지 못하므로 그 서버는 따로 띄운다.
test('a 200 from another server on the stored port is not taken as ours, so stop sends no signal to the stored pid', async t => {
  const dir = repo(t);
  const code = "const s = require('http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => console.log(s.address().port))";
  const other = spawn(process.execPath, ['-e', code]);
  t.after(() => other.kill());
  const port = Number(await new Promise(resolve => other.stdout.once('data', resolve)));
  const url = `http://127.0.0.1:${port}/?token=${'a'.repeat(32)}`;
  assert.equal(await status(url), 200);
  fs.writeFileSync(path.join(dir, 'harness/serve.json'), JSON.stringify({ 포트: port, 토큰: 'a'.repeat(32), pid: other.pid }));
  assert.match(ok(dir, '끄기'), /이미 꺼져 있다/);
  assert.equal(await status(url), 200, 'the other program is still running');
  const taken = backlog(dir, '켜두기');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, new RegExp(`${port} 포트.*EADDRINUSE`));
  assert.deepEqual(servers(dir), []);
});

test('keep from a worktree runs the main folder\'s commands, so answers still work after the worktree is removed', async t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, '질문', 'T-1', '열을 지울까요', '--행동', '삭제', '--설명', '쓰지 않는 열', '--보기', '지운다=사라진다|둔다=남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다');
  const worktree = path.join(fs.realpathSync(dir), '.claude/worktrees/sub-1');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'sub-1', worktree], { cwd: dir });
  const result = backlog(worktree, '켜두기');
  stopLater(t, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(servers(dir).length, 1, 'the server runs the main folder\'s backlog.mjs');
  execFileSync('git', ['worktree', 'remove', worktree], { cwd: dir });
  const [, url, port, token] = result.stdout.match(LINK);
  assert.equal(await status(url), 200);
  const ledger = () => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
  const body = JSON.stringify({ token, 번호: 'Q-1', 만든시각: ledger().질문[0].만든시각, 선택: '둔다', 직접: '' });
  const answered = await fetch(`http://127.0.0.1:${port}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(answered.status, 200, await answered.text());
  assert.equal(ledger().질문[0].상태, '답함');
});

test('keep and stop refuse options they do not use', t => {
  const dir = repo(t);
  assert.equal(backlog(dir, '켜두기', '--아무거나').status, 1);
  const stray = backlog(dir, '켜두기', '--사유', 'x');
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /켜두기 거절: --사유.*쓸 수 있는 옵션: --포트/);
  assert.match(backlog(dir, '끄기', '--포트', '1').stderr, /끄기 거절: --포트.*쓸 수 있는 옵션: 없음/);
  assert.equal(fs.existsSync(path.join(dir, 'harness/serve.json')), false);
});

// 맥을 다시 켠 것처럼 켜 둔 서버를 SIGKILL로 죽이면 다음 장부 명령이 같은 링크로 다시 켠다(사용자 결정 2026-10-16).
test('a ledger command revives a killed kept page with the same link, and leaves a live one alone', async t => {
  const dir = repo(t);
  const first = keep(t, dir);
  const { pid } = state(dir);
  assert.equal(ok(dir, '목록'), '작업이 없다', 'a live page prints no page line');
  assert.equal(state(dir).pid, pid);
  process.kill(pid, 'SIGKILL');
  await gone(pid);
  const revived = backlog(dir, '목록');
  stopLater(t, dir);
  assert.equal(revived.status, 0, revived.stderr);
  assert.match(revived.stdout, /^질문 페이지를 다시 켰다$/m);
  assert.equal(revived.stdout.match(LINK)[1], first.url);
  assert.equal(await status(first.url), 200);
  assert.equal(servers(dir).length, 1);
});

test('a repo that never kept the page starts nothing and prints no page line', t => {
  const dir = repo(t);
  assert.doesNotMatch(ok(dir, '목록'), /질문 페이지/);
  assert.equal(fs.existsSync(path.join(dir, 'harness/serve.json')), false);
  assert.deepEqual(servers(dir), []);
});

test('stop on a state file with a dead pid says it is already off and drops the pid', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'harness/serve.json'), JSON.stringify({ 포트: 1, 토큰: 'a'.repeat(32), pid: 999999 }));
  assert.match(ok(dir, '끄기'), /이미 꺼져 있다/);
  assert.deepEqual(servers(dir), []);
  assert.deepEqual(state(dir), { 포트: 1, 토큰: 'a'.repeat(32) });
});

test('when the stored port is taken, a ledger command still runs and warns on stderr with the port and the reason', async t => {
  const dir = repo(t);
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const { port } = holder.address();
  fs.writeFileSync(path.join(dir, 'harness/serve.json'), JSON.stringify({ 포트: port, 토큰: 'a'.repeat(32), pid: 999999 }));
  const listed = backlog(dir, '목록');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), '작업이 없다');
  assert.match(listed.stderr, new RegExp(`질문 페이지를 다시 켜지 못했다.*${port} 포트.*EADDRINUSE`));
  assert.deepEqual(servers(dir), []);
});

test('permit and confirm end with the page link while it is on, and record does not', t => {
  const dir = repo(t);
  const { out } = keep(t, dir);
  const line = out.match(LINK)[0];
  // 줄 제한이 질문 줄 하나여도 링크 줄은 잘리지 않는다.
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), backlog: { outputLines: 1 } }));
  ok(dir, '추가', '일');
  const choices = ['--설명', 'x', '--보기', '지운다=사라짐|둔다=남음', '--추천', '둔다', '--이유', 'y'];
  assert.equal(ok(dir, '허락', 'T-1', '지울까요', '--행동', '삭제', ...choices).split('\n').at(-1), line);
  assert.equal(ok(dir, '확인', 'T-1', '고를까요', '--까닭', '문서충돌', ...choices).split('\n').at(-1), line);
  assert.doesNotMatch(ok(dir, '기록', 'T-1', '정함', '--설명', 'x', '--이유', 'y'), /질문 페이지/);
});
