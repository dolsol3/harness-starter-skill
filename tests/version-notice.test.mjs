// scripts/version-notice.mjs 시험: 127.0.0.1 시험 서버와 임시 HOME으로 돌려 진짜 ~/.harness-starter와 GitHub을 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/version-notice.mjs', import.meta.url));
const MINE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const [major, minor] = MINE.split('.').map(Number);
// 가운데 칸에 10을 더해 글자 비교라면 낮다고 나오는 값을 만든다(0.2.0 → 0.12.0).
const HIGHER = `${major}.${minor + 10}.0`;
const DAY_MS = 24 * 60 * 60 * 1000;
const date = time => new Date(time).toLocaleDateString('sv-SE');
const TODAY = date(Date.now());
const YESTERDAY = date(Date.now() - DAY_MS);

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-version-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const registryOf = dir => path.join(dir, '.harness-starter', 'projects.json');
const readRegistry = dir => JSON.parse(fs.readFileSync(registryOf(dir), 'utf8'));

function writeRaw(dir, text) {
  fs.mkdirSync(path.dirname(registryOf(dir)), { recursive: true });
  fs.writeFileSync(registryOf(dir), text);
}

// handler(req, res)로 응답을 정하고, 받은 요청 수를 센다.
async function server(t, handler) {
  const state = { requests: 0 };
  const s = http.createServer((req, res) => {
    state.requests += 1;
    handler(req, res);
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  state.url = `http://127.0.0.1:${s.address().port}/package.json`;
  return state;
}

const versionServer = (t, version) => server(t, (req, res) => res.end(JSON.stringify({ version })));

// 같은 프로세스의 시험 서버가 응답할 수 있게 기다리는 방식으로 부른다.
function run(dir, url, extra = {}) {
  // 시험을 돌리는 사람의 셸에 끄는 값이 있어도 시험이 정한 값만 쓴다.
  const { HARNESS_STARTER_NO_UPDATE_CHECK, ...base } = process.env;
  const env = { ...base, HOME: dir, USERPROFILE: dir, HARNESS_STARTER_VERSION_URL: url, ...extra };
  const child = spawn(process.execPath, [SCRIPT], { env });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { out.stdout += chunk; });
  child.stderr.on('data', chunk => { out.stderr += chunk; });
  return new Promise(resolve => child.on('close', status => resolve({ status, ...out })));
}

test('a higher version prints one line once a day', async t => {
  const s = await versionServer(t, HIGHER);
  const dir = home(t);
  const first = await run(dir, s.url);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const lines = first.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(HIGHER) && lines[0].includes(MINE) && lines[0].includes('업그레이드'), lines[0]);
  assert.equal(readRegistry(dir).checked, TODAY);
  const second = await run(dir, s.url);
  assert.deepEqual(second, { status: 0, stdout: '', stderr: '' });
  assert.equal(s.requests, 1);
});

test('the same or a lower version prints nothing', async t => {
  for (const version of [MINE, '0.0.1']) {
    const s = await versionServer(t, version);
    const dir = home(t);
    const result = await run(dir, s.url);
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, version);
    assert.equal(readRegistry(dir).checked, TODAY);
  }
});

function assertCouldNotCheck(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^새 버전 확인 못 함: [^\n]+\n$/);
}

test('a closed port or a 404 says it could not check and exits 0', async t => {
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedUrl = `http://127.0.0.1:${closed.address().port}/package.json`;
  await new Promise(resolve => closed.close(resolve));
  const dir = home(t);
  assertCouldNotCheck(await run(dir, closedUrl));
  assert.equal(readRegistry(dir).checked, TODAY);

  const s = await server(t, (req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  const other = home(t);
  const result = await run(other, s.url);
  assertCouldNotCheck(result);
  assert.match(result.stderr, /404/);
  assert.equal(readRegistry(other).checked, TODAY);
});

test('a 200 page that is not JSON and has line breaks still gives one line', async t => {
  // 와이파이 로그인 화면처럼 200으로 HTML을 주면 JSON 오류 글에 그 줄바꿈이 섞인다.
  const s = await server(t, (req, res) => res.end('<html>\n<body>\r\nlogin\n</body>'));
  const dir = home(t);
  assertCouldNotCheck(await run(dir, s.url));
  assert.equal(readRegistry(dir).checked, TODAY);
});

test('a server that never answers is given up within 6 seconds', async t => {
  const s = await server(t, () => {});
  const started = Date.now();
  const result = await run(home(t), s.url);
  assert.ok(Date.now() - started < 6000, `${Date.now() - started}ms`);
  assertCouldNotCheck(result);
  assert.equal(s.requests, 1);
});

test('HARNESS_STARTER_NO_UPDATE_CHECK=1 does nothing', async t => {
  const s = await versionServer(t, HIGHER);
  const dir = home(t);
  const off = { HARNESS_STARTER_NO_UPDATE_CHECK: '1' };
  assert.deepEqual(await run(dir, s.url, off), { status: 0, stdout: '', stderr: '' });
  assert.equal(fs.existsSync(path.join(dir, '.harness-starter')), false);
  const text = `${JSON.stringify({ source: null, projects: [], checked: YESTERDAY })}\n`;
  writeRaw(dir, text);
  assert.deepEqual(await run(dir, s.url, off), { status: 0, stdout: '', stderr: '' });
  assert.equal(fs.readFileSync(registryOf(dir), 'utf8'), text);
  assert.equal(s.requests, 0);
});

test('a broken registry fails before asking the server', async t => {
  const s = await versionServer(t, HIGHER);
  const dir = home(t);
  writeRaw(dir, '{ broken');
  const result = await run(dir, s.url);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /명부를 JSON으로 읽을 수 없다/);
  assert.equal(s.requests, 0);
  assert.equal(fs.readFileSync(registryOf(dir), 'utf8'), '{ broken');
});

test('only checked changes in an existing registry', async t => {
  const s = await versionServer(t, MINE);
  const dir = home(t);
  const before = { source: '/some/clone', projects: ['/a', '/b'], checked: YESTERDAY };
  writeRaw(dir, JSON.stringify(before));
  const result = await run(dir, s.url);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRegistry(dir), { ...before, checked: TODAY });
});
