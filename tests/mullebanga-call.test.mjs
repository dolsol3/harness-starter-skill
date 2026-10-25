import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../templates/harness/mullebanga-call.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const modulePath = path.join(root, 'templates/harness/mullebanga-call.mjs');
const schema = { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean' } }, required: ['done'] };
const answer = { done: true };

// 가짜 도구: 받은 인자·작업 폴더·stdin 길이·스키마 파일 내용을 FAKE_LOG에 남기고, 환경 변수로 정한 대로 -o 파일·stdout·stderr를 쓰고 끝낸다.
// FAKE_SLEEP이면 자손(오래 자는 node)을 띄워 pid를 FAKE_PIDFILE에 적고(FAKE_LOG·stdin·-o 파일보다 먼저: 시간초과가 이 일 앞에서 일어나면 시험이 읽을 pid가 없다) 안 끝난다. FAKE_TERM_EXIT0이면 SIGTERM을 받고 exit 0으로 끝난다. FAKE_GC_IGNORE_TERM이면 자손이 SIGTERM을 무시한다.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const env = process.env;
const args = process.argv.slice(2);
if (env.FAKE_SLEEP) {
  const grandchildCode = (env.FAKE_GC_IGNORE_TERM ? "process.on('SIGTERM', () => {});" : '') + 'setTimeout(() => {}, 300000)';
  const grandchild = spawn(process.execPath, ['-e', grandchildCode], { stdio: 'ignore' });
  fs.writeFileSync(env.FAKE_PIDFILE, String(grandchild.pid));
  if (env.FAKE_TERM_EXIT0) process.on('SIGTERM', () => process.exit(0));
}
const schemaFlag = ['--output-schema', '--json-schema'].find(flag => args.includes(flag));
const schemaFile = schemaFlag && args[args.indexOf(schemaFlag) + 1];
const schemaText = schemaFile && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : undefined;
fs.writeFileSync(env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), stdinLength: fs.readFileSync(0).length, schemaText }));
if (env.FAKE_FILE !== undefined) fs.writeFileSync(args[args.indexOf('-o') + 1], env.FAKE_FILE);
if (env.FAKE_OUT_DIR) fs.mkdirSync(args[args.indexOf('-o') + 1]);
if (env.FAKE_OUT_FIFO) require('node:child_process').execFileSync('mkfifo', [args[args.indexOf('-o') + 1]]);
process.stdout.write(env.FAKE_OUT ?? '');
process.stderr.write(env.FAKE_ERR ?? '');
if (env.FAKE_SLEEP) setInterval(() => {}, 1000);
else process.exit(Number(env.FAKE_EXIT ?? 0));
`;

// 가짜 codex·agy·claude가 든 폴더와 PATH를 만들고, 호출 하나를 돌려 { res, log }를 돌려주는 도우미.
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-call-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['codex', 'agy', 'claude']) fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  const searchPath = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  let count = 0;
  const call = async (tool, extra = {}, fake = {}) => {
    const n = count++;
    const logFile = path.join(dir, `log${n}.json`);
    const pidFile = path.join(dir, `pid${n}`);
    const env = { ...process.env, PATH: searchPath, FAKE_LOG: logFile, FAKE_PIDFILE: pidFile, ...fake };
    const res = await callTool({ tool, prompt: '일을 해', cwd: dir, schema, timeoutMs: 20000, env, ...extra });
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : undefined;
    return { res, log, pidFile };
  };
  return { dir, bin, call, path: searchPath };
}

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
const initLine = mode => JSON.stringify({ event: 'init', init: { permission_mode: mode } });
const resultLine = (result = answer, extra = {}) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: result, ...extra } });
const geminiOut = (mode = 'always-proceed') => [initLine(mode), JSON.stringify({ event: 'message', text: '중간' }), 'not json at all', resultLine()].join('\n') + '\n';
const claudeOut = JSON.stringify({ type: 'result', is_error: false, structured_output: answer });

test('모듈은 callTool을 내보내고 node: 표준 모듈만 가져오며 300줄 이하다', () => {
  const text = fs.readFileSync(modulePath, 'utf8');
  const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
  assert.ok(imports.length > 0);
  assert.ok(imports.every(name => name.startsWith('node:')), imports.join());
  assert.equal(typeof callTool, 'function');
  for (const file of [modulePath, fileURLToPath(import.meta.url)]) assert.ok(fs.readFileSync(file, 'utf8').split('\n').length <= 301, file);
});

test('codex: 인자를 만들고 -o 파일의 결과를 돌려준다', async t => {
  const { call, dir } = setup(t);
  const { res, log } = await call('codex', { model: 'gpt-x', effort: 'high' }, { FAKE_FILE: JSON.stringify(answer) });
  assert.deepEqual(res, { ok: true, result: answer });
  const { args } = log;
  assert.equal(args[0], 'exec');
  assert.equal(valueAfter(args, '-s'), 'read-only');
  assert.equal(valueAfter(args, '-C'), dir);
  assert.ok(args.includes('--json'));
  assert.equal(valueAfter(args, '-m'), 'gpt-x');
  assert.equal(valueAfter(args, '-c'), 'model_reasoning_effort="high"');
  assert.equal(args.indexOf('--') + 1, args.length - 1);
  assert.equal(args.at(-1), '일을 해');
  assert.ok(valueAfter(args, '--output-schema').endsWith('schema.json'));
  assert.ok(valueAfter(args, '-o').endsWith('out.json'));
  assert.equal(log.cwd, dir);
});

test('codex·gemini: 스키마 파일 내용이 입력 schema와 같고, 쓰기면 workspace-write이며, model·effort가 없으면 옵션을 뺀다', async t => {
  const { call } = setup(t);
  const codex = await call('codex', { write: true }, { FAKE_FILE: JSON.stringify(answer) });
  assert.equal(valueAfter(codex.log.args, '-s'), 'workspace-write');
  assert.ok(!codex.log.args.includes('-m') && !codex.log.args.includes('-c'));
  assert.deepEqual(JSON.parse(codex.log.schemaText), schema);
  const gemini = await call('gemini', {}, { FAKE_OUT: geminiOut() });
  assert.deepEqual(JSON.parse(gemini.log.schemaText), schema);
  assert.ok(!gemini.log.args.includes('--model') && !gemini.log.args.includes('--effort'));
});

test('gemini: agy 인자를 만들고 result 줄의 structured_output을 돌려준다', async t => {
  const { call, dir } = setup(t);
  const { res, log } = await call('gemini', { timeoutMs: 2500 }, { FAKE_OUT: geminiOut() });
  assert.deepEqual(res, { ok: true, result: answer });
  const { args } = log;
  assert.equal(valueAfter(args, '-p'), '일을 해');
  assert.equal(valueAfter(args, '--output-format'), 'stream-json');
  assert.ok(valueAfter(args, '--json-schema').endsWith('schema.json'));
  assert.equal(valueAfter(args, '--print-timeout'), '3s');
  assert.ok(!args.includes('-w') && !args.includes('--dangerously-skip-permissions'));
  assert.equal(log.cwd, dir);
});

test('gemini: 모델 이름에 깊이가 있으면 --effort를 빼고, 없으면 준다', async t => {
  const { call } = setup(t);
  const fake = { FAKE_OUT: geminiOut() };
  const withDepth = await call('gemini', { model: 'x-argon-high', effort: 'high' }, fake);
  assert.ok(!withDepth.log.args.includes('--effort'));
  assert.equal(valueAfter(withDepth.log.args, '--model'), 'x-argon-high');
  const plain = await call('gemini', { model: 'x-model', effort: 'high' }, fake);
  assert.equal(valueAfter(plain.log.args, '--effort'), 'high');
});

test('claude: 인자를 만들고 봉투의 structured_output을 돌려준다', async t => {
  const { call, dir } = setup(t);
  const { res, log } = await call('claude', { allowedTools: ['Read', 'Grep'], model: 'm', effort: 'low' }, { FAKE_OUT: claudeOut });
  assert.deepEqual(res, { ok: true, result: answer });
  const { args } = log;
  assert.equal(args[0], '-p');
  assert.equal(valueAfter(args, '--output-format'), 'json');
  assert.equal(valueAfter(args, '--json-schema'), JSON.stringify(schema));
  assert.equal(valueAfter(args, '--permission-mode'), 'plan');
  assert.equal(valueAfter(args, '--permission-prompts'), 'none');
  assert.ok(args.includes('--no-session-persistence'));
  assert.deepEqual(JSON.parse(valueAfter(args, '--settings')), { sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['Read', 'Grep']);
  assert.equal(args.indexOf('--') + 1, args.length - 1);
  assert.equal(args.at(-1), '일을 해');
  assert.equal(log.cwd, dir);
  const writing = await call('claude', { write: true }, { FAKE_OUT: claudeOut });
  assert.equal(valueAfter(writing.log.args, '--permission-mode'), 'acceptEdits');
  assert.ok(!writing.log.args.includes('--allowedTools'));
});

test('세 도구 모두 stdin이 닫혀 있다', async t => {
  const { call } = setup(t);
  const fakes = { codex: { FAKE_FILE: JSON.stringify(answer) }, gemini: { FAKE_OUT: geminiOut() }, claude: { FAKE_OUT: claudeOut } };
  for (const tool of Object.keys(fakes)) {
    const { res, log } = await call(tool, { timeoutMs: 8000 }, fakes[tool]);
    assert.equal(res.ok, true, tool);
    assert.equal(log.stdinLength, 0, tool);
  }
});

// 자손이 죽을 때까지 잠깐 기다린다(고아가 된 프로세스는 수거되는 데 시간이 걸린다).
async function assertDead(pid) {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`자손 ${pid}이 살아 있다`);
}

// timeoutMs 4000, < 12000: 가짜의 node 기동이 부하에서 1000ms를 넘어 pid를 쓰기 전에 죽었다(60개 부하 60번 중 14번). 2000도 부하 20개에서 가끔 실패했다. 12000은 4000 + 죽이기 여유다.
test('시간 초과: 자손까지 멈추고 SIGTERM에 exit 0으로 끝나도 시간초과다', async t => {
  const { call } = setup(t);
  for (const [tool, extra] of [['codex', { FAKE_TERM_EXIT0: '1' }], ['gemini', {}], ['claude', { FAKE_TERM_EXIT0: '1' }]]) {
    const started = Date.now();
    const { res, pidFile } = await call(tool, { timeoutMs: 4000 }, { FAKE_SLEEP: '1', FAKE_FILE: JSON.stringify(answer), FAKE_OUT: claudeOut, ...extra });
    assert.equal(res.ok, false, tool);
    assert.equal(res.reason, '시간초과', tool);
    assert.ok(Date.now() - started < 12000, tool);
    await assertDead(Number(fs.readFileSync(pidFile, 'utf8')));
  }
});

test('시간 초과: SIGTERM을 무시하는 자손도 호출이 돌아올 때 이미 죽는다', async t => {
  const { call } = setup(t);
  const { res, pidFile } = await call('codex', { timeoutMs: 4000 }, { FAKE_SLEEP: '1', FAKE_TERM_EXIT0: '1', FAKE_GC_IGNORE_TERM: '1' });
  assert.equal(res.reason, '시간초과');
  await assertDead(Number(fs.readFileSync(pidFile, 'utf8')));
});

test('결과 없는 exit 0은 결과없음이다', async t => {
  const { call } = setup(t);
  const cases = [
    ['codex', {}],
    ['codex', { FAKE_FILE: '' }],
    ['codex', { FAKE_FILE: 'not json' }],
    ['codex', { FAKE_FILE: '[1,2]' }],
    ['claude', { FAKE_OUT: JSON.stringify({ type: 'result', is_error: false }) }],
    ['claude', { FAKE_OUT: 'plain text' }],
    ['gemini', { FAKE_OUT: initLine('always-proceed') + '\n' }],
    ['gemini', { FAKE_OUT: initLine('always-proceed') + '\n' + JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n' }],
  ];
  for (const [tool, fake] of cases) {
    const { res } = await call(tool, {}, fake);
    assert.equal(res.ok, false, `${tool} ${JSON.stringify(fake)}`);
    assert.equal(res.reason, '결과없음', `${tool} ${JSON.stringify(fake)}`);
  }
});

test('codex -o 경로가 폴더나 FIFO여도 읽다 멈추거나 던지지 않고 결과없음이다', async t => {
  const { call } = setup(t);
  for (const fake of [{ FAKE_OUT_DIR: '1' }, { FAKE_OUT_FIFO: '1' }]) {
    const { res } = await call('codex', {}, fake);
    assert.deepEqual([res.ok, res.reason], [false, '결과없음'], JSON.stringify(fake));
  }
});

test('codex가 exit 0이어도 turn.failed를 찍었으면 실패이고, 한도 문구면 한도다', async t => {
  const { call } = setup(t);
  const turnFailed = message => JSON.stringify({ type: 'turn.failed', error: { message } });
  for (const fake of [{ FAKE_FILE: JSON.stringify(answer) }, {}]) {
    const quota = await call('codex', {}, { ...fake, FAKE_OUT: turnFailed('Quota exceeded. Check your plan.') });
    assert.deepEqual([quota.res.ok, quota.res.reason], [false, '한도'], JSON.stringify(fake));
    const boom = await call('codex', {}, { ...fake, FAKE_OUT: turnFailed('boom') });
    assert.deepEqual([boom.res.ok, boom.res.reason], [false, '실패'], JSON.stringify(fake));
  }
});

test('도구가 알린 오류는 실패다', async t => {
  const { call } = setup(t);
  const claude = await call('claude', {}, { FAKE_OUT: JSON.stringify({ is_error: true, result: 'bad request', structured_output: answer }) });
  assert.deepEqual([claude.res.ok, claude.res.reason], [false, '실패']);
  const gemini = await call('gemini', {}, { FAKE_OUT: resultLine(answer, { status: 'ERROR' }) + '\n' });
  assert.deepEqual([gemini.res.ok, gemini.res.reason], [false, '실패']);
});

test('한도 문구는 실패일 때만 한도로 가른다', async t => {
  const { call } = setup(t);
  const failed = message => ({ FAKE_OUT: JSON.stringify({ type: 'turn.failed', error: { message } }), FAKE_EXIT: '1' });
  for (const message of ["You've hit your usage limit. Upgrade to Plus", 'Quota exceeded. Check your plan and billing details.']) {
    const { res } = await call('codex', {}, failed(message));
    assert.equal(res.reason, '한도', message);
  }
  const boom = await call('codex', {}, failed('boom'));
  assert.equal(boom.res.reason, '실패');
  assert.ok(boom.res.detail.includes('boom'));
  const stderrLimit = await call('claude', {}, { FAKE_ERR: 'RateLimitExceeded', FAKE_EXIT: '1' });
  assert.equal(stderrLimit.res.reason, '한도');
  const fine = await call('codex', {}, { FAKE_FILE: JSON.stringify(answer), FAKE_OUT: 'usage limit usage limit' });
  assert.deepEqual(fine.res, { ok: true, result: answer });
});

test('권한: 쓰기 단계에서 always-proceed가 아니면 일찍 멈춘다', async t => {
  const { call } = setup(t);
  const started = Date.now();
  const { res, pidFile } = await call('gemini', { write: true, timeoutMs: 15000 }, { FAKE_SLEEP: '1', FAKE_OUT: initLine('request-review') + '\n' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, '권한');
  assert.ok(res.detail.includes('request-review'));
  assert.ok(Date.now() - started < 8000);
  await assertDead(Number(fs.readFileSync(pidFile, 'utf8')));
  const readOnly = await call('gemini', { write: false }, { FAKE_OUT: geminiOut('request-review') });
  assert.deepEqual(readOnly.res, { ok: true, result: answer });
  const proceed = await call('gemini', { write: true }, { FAKE_OUT: geminiOut('always-proceed') });
  assert.deepEqual(proceed.res, { ok: true, result: answer });
});

test('도구가 없으면 던지지 않고 실패로 돌려주고, 입력이 틀리면 던진다', async t => {
  const { call, dir } = setup(t);
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const { res } = await call('codex', {}, { PATH: empty });
  assert.deepEqual([res.ok, res.reason], [false, '실패']);
  assert.ok(res.detail.includes('codex'));
  await assert.rejects(call('nope'));
  await assert.rejects(call('codex', { cwd: path.join(dir, 'missing') }));
  await assert.rejects(call('codex', { prompt: '  ' }));
});

test('임시 파일을 지우고, 동시에 불러도 결과가 섞이지 않는다', async t => {
  const { call } = setup(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-call-tmp-'));
  const before = process.env.TMPDIR;
  t.after(() => {
    process.env.TMPDIR = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  process.env.TMPDIR = tmp;
  const ok = await call('codex', {}, { FAKE_FILE: JSON.stringify(answer) });
  const failed = await call('codex', {}, { FAKE_FILE: 'x', FAKE_EXIT: '1' });
  assert.equal(ok.res.ok, true);
  assert.equal(failed.res.ok, false);
  assert.deepEqual(fs.readdirSync(tmp), []);
  const [a, b] = await Promise.all([call('codex', {}, { FAKE_FILE: '{"n":1}' }), call('codex', {}, { FAKE_FILE: '{"n":2}' })]);
  assert.deepEqual([a.res.result, b.res.result], [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(fs.readdirSync(tmp), []);
});
