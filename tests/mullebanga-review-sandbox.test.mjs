import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callTool } from '../templates/harness/mullebanga-call.mjs';
import { setup, observed, valueAfter, DEFAULT_CONFIG } from './review-fixture.mjs';

// 맥에서 sandbox-exec로 규칙을 실제로 적용할 수 있을 때만 깨뜨려 보기 경로를 시험한다.
const probeRules = process.platform === 'darwin' && spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true']);
const skip = probeRules?.status === 0 ? false : 'sandbox-exec로 규칙을 적용할 수 없는 기계라 건너뜀';
const author = { author: 'codex' };
const schema = { type: 'object', properties: { findings: { type: 'array' } } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

test('깨뜨려 보기 경로: breaker 역할, 로그, 모델, stream-json, 금지 옵션 없음, TMPDIR만 임시', { skip }, async t => {
  const s = setup(t);
  const res = await s.review({}, author);
  const seen = observed(res);
  const rootDir = path.dirname(seen.cwd);
  assert.equal(res.tool, 'gemini');
  assert.equal(valueAfter(seen.args, '--agent'), 'breaker');
  assert.equal(valueAfter(seen.args, '--log-file'), path.join(rootDir, 'agy.log'));
  assert.equal(valueAfter(seen.args, '--model'), 'gemini-4-argon-medium');
  assert.equal(valueAfter(seen.args, '--output-format'), 'stream-json');
  assert.equal(valueAfter(seen.args, '--print-timeout'), '20s');
  for (const flag of ['-w', '--dangerously-skip-permissions', '--effort']) assert.equal(seen.args.includes(flag), false, flag);
  assert.equal(seen.env.TMPDIR, path.join(rootDir, 'tmp'));
  assert.equal(seen.env.HARNESS_READ_ONLY, undefined);
  assert.equal(seen.env.HOME, s.home);
  assert.ok(seen.prompt.includes('재현'));
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('샌드박스: 복사본·임시 홈·임시 tmp·agentapi 한 파일은 쓰고 임시 바로 아래와 진짜 홈의 다른 곳은 못 쓴다', { skip }, async t => {
  const s = setup(t);
  const probes = ['{cwd}/ok.txt', '{root}/home/ok.txt', '{root}/tmp/ok.txt', '{root}/agy.log', s.agentapi, '{root}/deny.txt', path.join(s.home, 'deny.txt'), path.join(s.home, '.gemini/deny.txt')];
  const res = await s.review({ FAKE_PROBE: JSON.stringify(probes) }, author);
  const { probe, cwd } = observed(res);
  const expected = { [`${cwd}/ok.txt`]: 'ok', [`${path.dirname(cwd)}/home/ok.txt`]: 'ok', [`${path.dirname(cwd)}/tmp/ok.txt`]: 'ok', [`${path.dirname(cwd)}/agy.log`]: 'ok', [s.agentapi]: 'ok',
    [`${path.dirname(cwd)}/deny.txt`]: 'EPERM', [path.join(s.home, 'deny.txt')]: 'EPERM', [path.join(s.home, '.gemini/deny.txt')]: 'EPERM' };
  assert.deepEqual(probe, expected);
  assert.equal(fs.existsSync(path.join(s.home, 'deny.txt')), false);
  assert.equal(res.agentapiChanged, false);
});

test('agentapi: 건드리지 않으면 바뀌지 않았고 높음이 없다', { skip }, async t => {
  const s = setup(t);
  const before = fs.readFileSync(s.agentapi, 'utf8');
  const res = await s.review({}, author);
  assert.deepEqual([res.tool, res.agentapiChanged, res.findings.length], ['gemini', false, 1]);
  assert.equal(fs.readFileSync(s.agentapi, 'utf8'), before);
});

test('agentapi: 내용을 바꾸거나 링크로 바꾸거나 지우면 높음과 agentapiChanged, 되돌리지 않는다', { skip }, async t => {
  const high = { level: '높음', text: '다른 도구 검토 뒤 진짜 홈 agentapi가 바뀜' };
  const stillChanged = {
    change: file => fs.readFileSync(file, 'utf8').endsWith('tamper'),
    link: file => fs.lstatSync(file).isSymbolicLink(),
    delete: file => !fs.existsSync(file),
  };
  for (const action of Object.keys(stillChanged)) {
    await t.test(action, async st => {
      const s = setup(st);
      const res = await s.review({ FAKE_AGENTAPI_ACTION: action }, author);
      assert.equal(res.tool, 'gemini');
      assert.equal(res.agentapiChanged, true);
      assert.deepEqual(res.findings.filter(f => f.level === '높음'), [high]);
      assert.equal(stillChanged[action](s.agentapi), true);
    });
  }
});

test('agentapi: 가짜가 실패해 끝나도 같은 확인을 하고 폴백하지 않고 멈춘다', { skip }, async t => {
  const s = setup(t);
  s.setConfig({ ...DEFAULT_CONFIG, 단계모델: { 번갈아보기: { 검토도구: 'gemini', 폴백도구: 'claude' } } });
  const res = await s.review({ FAKE_MODE: 'fail', FAKE_AGENTAPI_ACTION: 'change' }, author);
  assert.equal(res.tool, '');
  assert.equal(res.agentapiChanged, true);
  assert.equal(res.findings.some(f => f.level === '높음'), true);
  assert.deepEqual(res.attempts.map(a => a.tool), ['gemini']);
});

test('agentapi 파일이 없어 복사할 수 없으면 깨뜨려 보기가 아니라 읽기 전용 경로로 간다', { skip }, async t => {
  const s = setup(t);
  fs.rmSync(s.agentapi);
  const seen = observed(await s.review({}, author));
  assert.equal(valueAfter(seen.args, '--agent'), 'readonly');
  assert.equal(seen.env.HARNESS_READ_ONLY, '1');
});

test('callTool agent·logFile: agy에만 붙고 안 주면 없다', async t => {
  const s = setup(t);
  const call = (tool, extra = {}) => callTool({ tool, prompt: '일', cwd: s.repo, schema, timeoutMs: 20000, env: { PATH: s.searchPath, HOME: s.home }, ...extra }).then(res => observed(res.result));
  const given = await call('gemini', { agent: 'breaker', logFile: '/x/agy.log' });
  assert.equal(valueAfter(given.args, '--agent'), 'breaker');
  assert.equal(valueAfter(given.args, '--log-file'), '/x/agy.log');
  const plain = await call('gemini');
  assert.deepEqual(plain.args.filter(arg => ['--agent', '--log-file'].includes(arg)), []);
  for (const tool of ['codex', 'claude']) {
    const seen = await call(tool, { agent: 'breaker', logFile: '/x/agy.log' });
    assert.deepEqual(seen.args.filter(arg => ['--agent', '--log-file', 'breaker', '/x/agy.log'].includes(arg)), [], tool);
  }
});

test('callTool wrap: 실행 파일 앞에 붙는 명령으로 불린다', async t => {
  const s = setup(t);
  const res = await callTool({ tool: 'gemini', prompt: '일', cwd: s.repo, schema, timeoutMs: 20000, wrap: ['env', 'WRAPPED=1'], env: { PATH: s.searchPath, HOME: s.home } });
  assert.equal(observed(res.result).env.WRAPPED, '1');
  const plain = await callTool({ tool: 'gemini', prompt: '일', cwd: s.repo, schema, timeoutMs: 20000, env: { PATH: s.searchPath, HOME: s.home } });
  assert.equal(observed(plain.result).env.WRAPPED, undefined);
});

// timeoutMs는 가짜(node)가 뜨고 손자 pid 파일을 쓸 시간을 포함한다. 부하에서 node 기동만 1초가 걸려 700ms로는 파일을 쓰기 전에 죽었다(가짜는 파일을 먼저 쓴다).
test('callTool wrap: 오래 자는 가짜도 timeoutMs 뒤 자손까지 죽고 시간초과를 돌려준다', async t => {
  const s = setup(t);
  const pidFile = path.join(s.dir, 'grandchild');
  const res = await callTool({ tool: 'gemini', prompt: '일', cwd: s.repo, schema, timeoutMs: 5000, wrap: ['env', 'WRAPPED=1'], env: { PATH: s.searchPath, HOME: s.home, FAKE_MODE: 'sleep', FAKE_PIDFILE: pidFile } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, '시간초과');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let waited = 0; alive(pid) && waited < 5000; waited += 100) await wait(100);
  assert.equal(alive(pid), false);
});
