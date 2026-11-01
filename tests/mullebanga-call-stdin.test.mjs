import test from 'node:test';
import { writeFakeTool } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../templates/harness/mullebanga-call.mjs';

const schema = { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean' } }, required: ['done'] };
const answer = { done: true };
// 가짜 도구: stdin 전체를 FAKE_LOG에 남기고 정해진 결과를 낸다. FAKE_DIE_EARLY면 stdin을 읽지 않고 바로 죽는다.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const env = process.env;
const args = process.argv.slice(2);
if (env.FAKE_DIE_EARLY) process.exit(3);
if (!env.FAKE_NO_READ) fs.writeFileSync(env.FAKE_LOG, JSON.stringify({ args, stdin: fs.readFileSync(0, 'utf8') }));
if (env.FAKE_FILE !== undefined) fs.writeFileSync(args[args.indexOf('-o') + 1], env.FAKE_FILE);
process.stdout.write(env.FAKE_OUT ?? '');
`;
const geminiOut = [{ event: 'init', init: { permission_mode: 'always-proceed' } }, { event: 'result', result: { status: 'SUCCESS', structured_output: answer } }].map(line => JSON.stringify(line)).join('\n') + '\n';
const fakes = { codex: { FAKE_FILE: JSON.stringify(answer) }, gemini: { FAKE_OUT: geminiOut }, claude: { FAKE_OUT: JSON.stringify({ type: 'result', is_error: false, structured_output: answer }) } };
const binName = { codex: 'codex', gemini: 'agy', claude: 'claude' };

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stdin-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of Object.values(binName)) writeFakeTool(bin, name, FAKE);
  const searchPath = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  const logFile = path.join(dir, 'log.json');
  const call = async (tool, prompt, fake) => {
    const env = { ...process.env, PATH: searchPath, FAKE_LOG: logFile, ...fake };
    const res = await callTool({ tool, prompt, cwd: dir, schema, timeoutMs: 20000, env });
    return { res, log: fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : undefined };
  };
  return call;
}

// Windows 명령줄 한도(32767자)를 넘는 지시문도 stdin으로 전부 받아야 한다.
test('40KB 넘는 지시문을 세 도구 모두 stdin으로 전부 받고 인자에는 없다', async t => {
  const call = setup(t);
  const prompt = '긴 지시문 abc\n'.repeat(5000);
  assert.ok(prompt.length > 40000);
  for (const tool of Object.keys(fakes)) {
    const { res, log } = await call(tool, prompt, fakes[tool]);
    assert.deepEqual(res, { ok: true, result: answer }, tool);
    assert.ok(log.args.every(arg => arg.length < 1000), tool);
    assert.equal(tool === 'gemini' ? JSON.parse(log.stdin).message.content : log.stdin, prompt, tool);
  }
});

test('gemini는 stream-json 입출력 인자를 주고, codex 인자 끝은 -다', async t => {
  const call = setup(t);
  const gemini = await call('gemini', '일', fakes.gemini);
  assert.ok(gemini.log.args.includes('--input-format') && !gemini.log.args.includes('-p'));
  const codex = await call('codex', '일', fakes.codex);
  assert.equal(codex.log.args.at(-1), '-');
});

test('도구가 stdin을 다 읽기 전에 정상 결과를 내고 종료 0으로 끝나도 실패다', async t => {
  const call = setup(t);
  for (const tool of Object.keys(fakes)) {
    const { res } = await call(tool, '긴 지시문\n'.repeat(50000), { ...fakes[tool], FAKE_NO_READ: '1' });
    assert.equal(res.ok, false, tool);
    assert.equal(res.reason, '실패', tool);
    assert.match(res.detail, /지시문을 다 전달하지 못했다/, tool);
  }
});

test('도구가 stdin을 읽기 전에 죽어도 던지지 않고 실패를 돌려준다', async t => {
  const call = setup(t);
  for (const tool of Object.keys(fakes)) {
    const { res } = await call(tool, '긴 지시문\n'.repeat(50000), { FAKE_DIE_EARLY: '1' });
    assert.equal(res.ok, false, tool);
    assert.equal(res.reason, '실패', tool);
  }
});
