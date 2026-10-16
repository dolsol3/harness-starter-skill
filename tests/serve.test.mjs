import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { repo, ok, backlog } from './helpers.mjs';

const ASK = ['--행동', '삭제', '--설명', '쓰지 않는 열이다', '--보기', '지운다=열이 사라진다|둔다=그대로 남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다'];

// 작업 하나와 질문 하나가 있는 저장소
function seed(t) {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, '질문', 'T-1', '열을 지울까요', ...ASK);
  return dir;
}

// 그 저장소에서 서버를 켜고, 켜졌다고 알린 주소와 토큰을 돌려준다. 설정(config.json)은 서버가 켜질 때 읽는다.
async function launch(t, dir, ...serverArgs) {
  const child = spawn(process.execPath, [path.join(dir, 'harness/backlog.mjs'), '서버', ...serverArgs], { cwd: dir });
  t.after(() => child.kill());
  const server = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
      const found = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\w+)/);
      if (found) resolve({ dir, port: Number(found[1]), base: `http://127.0.0.1:${found[1]}`, token: found[2], out });
    });
    child.on('exit', code => reject(new Error(`the server stopped (${code}) before it said where it is`)));
  });
  const ledger = () => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
  const answer = async (body, { raw, type = 'application/json' } = {}) => {
    const response = await fetch(`${server.base}/answer`, {
      method: 'POST', headers: { 'Content-Type': type }, body: raw ?? JSON.stringify({ token: server.token, 번호: 'Q-1', 만든시각: ledger().질문[0].만든시각, 선택: '', 직접: '', ...body }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { ...server, ledger, answer };
}

const setup = (t, ...serverArgs) => launch(t, seed(t), ...serverArgs);

test('the page comes only with the right token and is drawn fresh from the ledger on every visit', async t => {
  const s = await setup(t);
  assert.match(s.out, /^질문 페이지: http:\/\/127\.0\.0\.1:\d+\/\?token=\w+\n이 컴퓨터에서만 열린다/);
  const page = await fetch(`${s.base}/?token=${s.token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*connect-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /열을 지울까요/);
  ok(s.dir, '질문', 'T-1', '두 번째 질문', ...ASK);
  assert.match(await (await fetch(`${s.base}/?token=${s.token}`)).text(), /두 번째 질문/);
  for (const url of [`${s.base}/`, `${s.base}/?token=nope`, `${s.base}/?token=`]) {
    const refused = await fetch(url);
    assert.equal(refused.status, 403, url);
    assert.doesNotMatch(await refused.text(), /열을 지울까요/);
  }
  assert.equal((await fetch(`${s.base}/other?token=${s.token}`)).status, 404);
  const body = JSON.stringify({ token: s.token, 번호: 'Q-1', 만든시각: '', 선택: '둔다', 직접: '' });
  for (const target of ['/other', '/', '/answer/x']) {
    assert.equal((await fetch(`${s.base}${target}`, { method: 'POST', body })).status, 404, target);
  }
  assert.equal((await fetch(`${s.base}/answer`, { method: 'GET' })).status, 404);
  assert.equal(s.ledger().질문[0].상태, '대기', 'nothing was answered by those');
});

test('the page the server draws shows the files patched by fix commits', async t => {
  const dir = seed(t);
  const config = path.join(dir, 'harness/config.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), kinds: { code: { files: ['src/**'], maxFileLines: 300 } } }));
  fs.mkdirSync(path.join(dir, 'src'));
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) {
    fs.appendFileSync(path.join(dir, 'src/api.ts'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', subject], { cwd: dir });
  }
  const s = await launch(t, dir);
  assert.match(await (await fetch(`${s.base}/?token=${s.token}`)).text(), /<td>src\/api\.ts<\/td><td>3번<\/td>/);
});

test('an answer sent from the page is written by the 답 command, rewrites the page and lets the task start', async t => {
  const s = await setup(t);
  assert.match(backlog(s.dir, '시작', 'T-1').stderr, /답을 기다리는 질문 Q-1/);
  const result = await s.answer({ 선택: '둔다' });
  assert.deepEqual([result.status, result.메시지], [200, '기록했습니다. Q-1의 답: 둔다']);
  assert.deepEqual([s.ledger().질문[0].상태, s.ledger().질문[0].답], ['답함', '둔다']);
  assert.match(fs.readFileSync(path.join(s.dir, 'harness/questions.html'), 'utf8'), /답한 것 1개/);
  ok(s.dir, '시작', 'T-1', '--영역', 'src', '--확인방법', 'npm test');
});

test('a request without the right token writes nothing', async t => {
  const s = await setup(t);
  const before = fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8');
  for (const token of [undefined, '', 'nope', s.token.toUpperCase()]) {
    const result = await s.answer({ token, 선택: '지운다' });
    assert.equal(result.status, 403, String(token));
    assert.match(result.메시지, /토큰/);
  }
  const noJson = await s.answer({}, { raw: `token=${s.token}&번호=Q-1&선택=지운다`, type: 'text/plain' });
  assert.equal(noJson.status, 400);
  assert.equal(fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8'), before);
});

test('what the 답 command refuses comes back as a refusal in the same words and the ledger stays', async t => {
  const s = await setup(t);
  const before = fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8');
  const cases = [
    [{ 선택: '지운다', 만든시각: '2000-01-01T00:00:00.000Z' }, 'Q-1 답 거절: 다른 질문이다(만든 시각이 다르다). 페이지를 새로 고친다'],
    [{ 선택: '모름' }, 'Q-1 답 거절: 모름은(는) 보기에 없다(지운다, 둔다)'],
    [{ 선택: '지운다', 직접: '글' }, 'Q-1 답 거절: 보기 이름 하나나 --직접 "글" 중 하나만 적는다'],
    [{}, 'Q-1 답 거절: 보기 이름 하나나 --직접 "글" 중 하나만 적는다'],
    [{ 번호: 'Q-9', 선택: '지운다' }, 'Q-9: 그런 질문이 없다. backlog 질문목록으로 번호를 본다'],
  ];
  for (const [body, message] of cases) {
    const result = await s.answer(body);
    assert.equal(result.status, 409, JSON.stringify(body));
    assert.equal(result.메시지, message, 'the words of the command, without the command line around them');
  }
  assert.equal(fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8'), before);
  assert.equal((await s.answer({ 선택: '지운다' })).status, 200);
  assert.equal((await s.answer({ 선택: '둔다' })).메시지, 'Q-1 답 거절: 이미 답했다(지운다)');
});

test('words that look like options stay words: a typed answer starting with a dash, and a choice named like an option', async t => {
  const s = await setup(t);
  const hack = await s.answer({ 선택: '--직접=몰래 적은 글' });
  assert.equal(hack.status, 409);
  assert.match(hack.메시지, /보기에 없다/);
  assert.equal(s.ledger().질문[0].상태, '대기');
  const typed = await s.answer({ 직접: '- 이번 주는 미룬다 --만든시각=2000' });
  assert.equal(typed.status, 200, typed.메시지);
  const [question] = s.ledger().질문;
  assert.deepEqual([question.답, question.직접], ['- 이번 주는 미룬다 --만든시각=2000', true]);
});

test('a body that is not JSON, has the wrong kinds of values or is too large is refused and writes nothing', async t => {
  const s = await setup(t);
  const before = fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8');
  assert.equal((await s.answer({}, { raw: '{not json' })).status, 400);
  assert.equal((await s.answer({ 번호: 1 })).status, 400);
  assert.equal((await s.answer({ 만든시각: '', 선택: '둔다' })).status, 400, 'the same-question check cannot be left out');
  assert.equal((await s.answer({ 선택: ['둔다'] })).status, 400);
  assert.equal((await s.answer({ 직접: 'x'.repeat(200_000) })).status, 413);
  assert.equal(s.ledger().질문[0].상태, '대기');
  assert.equal(fs.readFileSync(path.join(s.dir, 'harness/backlog.json'), 'utf8'), before);
});

test('the server listens on this computer only', async t => {
  const s = await setup(t);
  const outside = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal);
  if (!outside) return t.skip('this computer has no address besides its own');
  await assert.rejects(fetch(`http://${outside.address}:${s.port}/?token=${s.token}`), /fetch failed/);
  assert.equal((await fetch(`${s.base}/?token=${s.token}`)).status, 200);
});

test('reading the page does not need the lock, and a held lock only makes the answer wait for it', async t => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.dir, 'harness/backlog.lock'), '');
  assert.equal((await fetch(`${s.base}/?token=${s.token}`)).status, 200);
  setTimeout(() => fs.rmSync(path.join(s.dir, 'harness/backlog.lock')), 500);
  assert.equal((await s.answer({ 선택: '둔다' })).status, 200);
});

test('a bad port is refused, and a port that is taken says so instead of failing silently', async t => {
  const s = await setup(t);
  for (const bad of ['abc', '-1', '70000', '8080.5']) {
    const result = backlog(s.dir, '서버', `--포트=${bad}`);
    assert.equal(result.status, 1, bad);
    assert.match(result.stderr, /--포트는 0~65535 사이의 정수다/);
  }
  const taken = backlog(s.dir, '서버', `--포트=${s.port}`);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /서버를 열지 못했다/);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const fixed = await setup(t, '--포트', String(port));
  assert.equal(fixed.port, port);
  assert.match(fixed.token, /^[0-9a-f]{32}$/);
  assert.notEqual(fixed.token, s.token, 'each project makes its own token');
});

test('a ledger that cannot be read gives an error page with the reason and does not stop the server', async t => {
  const s = await setup(t);
  const file = path.join(s.dir, 'harness/backlog.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{broken');
  const broken = await fetch(`${s.base}/?token=${s.token}`);
  assert.equal(broken.status, 500);
  assert.match(await broken.text(), /harness\/backlog\.json을 읽을 수 없다/);
  fs.writeFileSync(file, good);
  assert.equal((await fetch(`${s.base}/?token=${s.token}`)).status, 200);
});

test('the body limit counts every piece received: 20,000 characters are read and one more is refused', async t => {
  const s = await setup(t);
  const bodyOf = length => {
    const fields = { token: s.token, 번호: 'Q-9', 만든시각: 'x', 선택: '', 직접: '' };
    return JSON.stringify({ ...fields, 직접: 'y'.repeat(length - JSON.stringify(fields).length) });
  };
  for (const [length, status] of [[20_000, 409], [20_001, 413]]) {
    const body = bodyOf(length);
    assert.equal(body.length, length);
    assert.equal((await fetch(`${s.base}/answer`, { method: 'POST', body })).status, status, String(length));
  }
});

test('an answer whose bytes arrive in pieces is read whole, even when a Korean letter is cut between the pieces', async t => {
  const s = await setup(t);
  const body = Buffer.from(JSON.stringify({ token: s.token, 번호: 'Q-1', 만든시각: s.ledger().질문[0].만든시각, 선택: '', 직접: '삭제하지 마세요' }));
  const cut = body.indexOf(Buffer.from('삭')) + 1;
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: s.port, path: '/answer', method: 'POST', headers: { 'Content-Length': body.length } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.write(body.subarray(0, cut));
    setTimeout(() => request.end(body.subarray(cut)), 150);
  });
  assert.equal(status, 200);
  assert.equal(s.ledger().질문[0].답, '삭제하지 마세요');
});
