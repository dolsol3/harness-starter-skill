import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFakeTool } from './helpers.mjs';
import { callExam } from '../scripts/model-exam-call.mjs';
import { callTool, callWritingGemini } from '../templates/harness/mullebanga-call.mjs';

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) { console.log('fake'); process.exit(0); }
fs.readFileSync(0, 'utf8');
if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o')+1], '{"done":true}');
const chunks = JSON.parse(process.env.CHUNKS);
async function run() {
 for (const chunk of chunks) {
  process.stdout.write(chunk);
  await new Promise(resolve => setTimeout(resolve, 15));
 }
 process.stderr.write('diagnostic');
 if (process.env.HANG) setInterval(() => {}, 1000);
 else process.exitCode = Number(process.env.EXIT || 0);
}
run();
`;
const json = value => JSON.stringify(value);
const codexUsage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10 };
const agyUsage = { input_tokens: 100, cache_read_tokens: 60, output_tokens: 20, thinking_tokens: 10, total_tokens: 120 };
const agyStep = (step_index, extra) => ({ event: 'step_update', step_update: { conversation_id: 'a', step_index, ...extra } });
const agyFinal = usage => ({ event: 'result', result: { status: 'SUCCESS', structured_output: { done: true }, ...(usage ? { usage } : {}) } });
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exam-call-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  assert.equal(execFileSync('git', ['remote'], { cwd, encoding: 'utf8' }), '');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['codex', 'agy', 'claude']) writeFakeTool(bin, name, FAKE);
  let counter = 0;
  function options(tool, events, extra = {}, fake = {}) {
    const text = events.map(e => typeof e === 'string' ? e : json(e)).join('\n');
    return { tool, cwd, prompt: 'return done', schema: { type: 'object' }, model: 'requested-model', effort: 'medium', timeoutMs: 10000,
      env: { ...process.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        HARNESS_CODEX_BIN: path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
        HARNESS_GEMINI_BIN: path.join(bin, process.platform === 'win32' ? 'agy.cmd' : 'agy'),
        HARNESS_CLAUDE_BIN: path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'),
        CHUNKS: json([text.slice(0, 13), text.slice(13, 49), text.slice(49)]), ...fake }, ...extra };
  }
  return { dir, cwd, options, call: (tool, events, extra, fake) => callExam(options(tool, events, extra, fake), path.join(dir, `raw${counter++}`)) };
}
test('codex: 청크 분할·마지막 줄·턴 usage·도구 상태 중복과 요청/처리 모델 구분', async t => {
  const { call, dir } = setup(t);
  const item = { id: 'tool1', type: 'command_execution' };
  const events = [{ type: 'item.started', item }, { type: 'item.updated', item },
    { type: 'item.completed', item }, { type: 'item.completed', item },
    { type: 'turn.completed', usage: codexUsage }];
  const r = await call('codex', events);
  assert.equal(r.ok, true);
  assert.equal(r.requested.model, 'requested-model');
  assert.equal(r.actualModels, null);
  assert.equal(r.actualEffort, null);
  assert.equal(r.usage.records.length, 1);
  assert.deepEqual(r.usage.records[0].values, { input: 100, cacheRead: 60, cacheWrite: null, output: 20, reasoning: 10 });
  assert.equal(r.usage.records[0].cacheReadIncludedInInput, true);
  assert.equal(r.usage.records[0].reasoningIncludedInOutput, true);
  assert.match(r.usage.records[0].missing.cacheWrite, /미제공/);
  assert.equal(r.toolExecutions.counts.command_execution, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'raw0/stderr'), 'utf8'), 'diagnostic');
  assert.equal(fs.readFileSync(path.join(dir, 'raw0/stdout'), 'utf8'), events.map(json).join('\n'));
});
test('gemini: 중간 usage를 최종 누계에 더하지 않고 도구 step을 한 번만 센다', async t => {
  const { call } = setup(t);
  const tool = { step_type: 'tool', tool_name: 'run_command' };
  const r = await call('gemini', [{ event: 'init', init: { model: 'configured' } },
    agyStep(1, { state: 'DONE', usage: agyUsage }), agyStep(2, { ...tool, state: 'ACTIVE' }),
    agyStep(2, { ...tool, state: 'ACTIVE' }), agyStep(2, { ...tool, state: 'DONE' }), agyFinal(agyUsage)]);
  assert.equal(r.ok, true);
  assert.equal(r.configuredModel, 'configured');
  assert.equal(r.actualModels, null);
  assert.equal(r.usage.records.length, 1);
  assert.equal(r.usage.records[0].values.input, 100);
  assert.deepEqual(r.usage.records[0].nativeUsage, agyUsage);
  assert.equal(r.usage.records[0].source, 'result.result.usage');
  assert.equal(r.usage.records[0].cacheReadIncludedInInput, null);
  assert.equal(r.toolExecutions.counts.run_command, 1);
});
test('claude: 최종 main-loop와 여러 모델의 사용량을 별도로 보존한다', async t => {
  const { call } = setup(t);
  const r = await call('claude', [{ type: 'result', structured_output: { done: true },
    usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 9, cache_creation_input_tokens: 3 },
    modelUsage: { 'served-a': { inputTokens: 10, outputTokens: 5, thinkingTokens: 2 },
      'served-b': { inputTokens: 2, outputTokens: 1, canonicalModel: 'canonical-b' } } }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.actualModels, ['served-a', 'served-b']);
  assert.equal(r.usage.records[0].values.reasoning, null);
  assert.equal(r.usage.records[0].cacheReadIncludedInInput, false);
  assert.equal(r.usage.perModel[0].values.reasoning, 2);
  assert.equal(r.usage.records[0].nativeUsage.cache_read_input_tokens, 9);
  assert.deepEqual(r.usage.perModel[1].nativeUsage, { inputTokens: 2, outputTokens: 1, canonicalModel: 'canonical-b' });
  assert.equal(r.usage.perModel[1].missing.cacheRead, 'result.modelUsage["served-b"].cacheReadInputTokens 미제공');
  assert.equal(r.usage.perModel[1].missing.cacheWrite, 'result.modelUsage["served-b"].cacheCreationInputTokens 미제공');
  assert.equal(r.usage.perModel[1].missing.reasoning, 'result.modelUsage["served-b"].thinkingTokens 미제공');
  assert.deepEqual({ ...r.toolExecutions.counts }, {});
  assert.match(r.toolExecutions.missingReason, /미수집/);
});
test('실패·시간초과에도 받은 usage와 stderr를 보존하며 부분 집계를 표시한다', async t => {
  const { call } = setup(t);
  for (const fake of [{ EXIT: '1' }, { HANG: '1' }]) {
    const r = await call('gemini', [agyStep(1, { state: 'DONE', usage: agyUsage }),
      agyStep(1, { state: 'DONE', usage: agyUsage })], { timeoutMs: 2000 }, fake);
    assert.equal(r.ok, false);
    assert.equal(r.reason, fake.HANG ? '시간초과' : '실패');
    assert.equal(r.usage.partial, true);
    assert.equal(r.usage.records.length, 1);
    assert.equal(r.usage.records[0].values.input, 100);
  }
  const failed = await call('codex', [{ type: 'turn.completed', usage: codexUsage }, { type: 'turn.failed' }]);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /turn.failed/);
  assert.equal(failed.usage.records[0].values.input, 100);
  const error = await call('claude', [{ type: 'result', is_error: true, usage: { input_tokens: 0, output_tokens: 0 } }]);
  assert.equal(error.ok, false);
  assert.equal(error.usage.records[0].values.input, 0);
  assert.equal(error.usage.partial, true);
});
test('usage 미제공은 0이 아니며 병렬 호출 계측은 섞이지 않는다', async t => {
  const { call } = setup(t);
  const [a, b, c] = await Promise.all([
    call('codex', [{ type: 'turn.completed', usage: codexUsage }]),
    call('codex', [{ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 0 } }]),
    call('gemini', [agyFinal()]),
  ]);
  assert.equal(a.usage.records[0].values.input, 100);
  assert.equal(b.usage.records[0].values.input, 7);
  assert.equal(b.usage.records[0].values.output, 0);
  assert.equal(b.usage.records[0].values.cacheRead, null);
  assert.deepEqual(c.usage.records, []);
  assert.match(c.usage.missingReason, /미제공/);
});
test('관찰자 없는 호출 결과와 같고 실패 호출의 청크도 관찰한다', async t => {
  const { options } = setup(t);
  const call = options('codex', [{ type: 'turn.completed', usage: codexUsage }]);
  const seen = { stdout: '', stderr: '' };
  assert.deepEqual(await callTool(call), await callTool({ ...call, observe: (s, c) => seen[s] += c }));
  assert.match(seen.stdout, /turn.completed/);
  assert.equal(seen.stderr, 'diagnostic');
  const failed = await callTool({ ...call, env: { ...call.env, EXIT: '1' }, observe: (s, c) => seen[s] += c });
  assert.equal(failed.ok, false);
  assert.equal(seen.stderr, 'diagnosticdiagnostic');
});
test('원시 출력의 저장소 안·심볼릭 링크 경로를 거절한다', async t => {
  const { dir, cwd, options } = setup(t);
  const call = options('codex', []);
  await assert.rejects(callExam(call, path.join(cwd, 'raw')), /저장소 밖/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(cwd, path.join(dir, 'link'));
    await assert.rejects(callExam(call, path.join(dir, 'link/raw')), /저장소 밖/);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'raw')), false);
});
test('Git 환경에 관계없이 저장소 경계를 검사하고 새 다단계 출력 폴더를 만든다', async t => {
  const { dir, cwd, options } = setup(t);
  const call = options('codex', []);
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES'];
  const saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }));
  const sub = path.join(cwd, 'sub');
  fs.mkdirSync(sub);
  process.env.GIT_CEILING_DIRECTORIES = cwd;
  const inside = path.join(sub, 'raw');
  await assert.rejects(callExam(call, inside), /저장소 밖/);
  assert.equal(fs.existsSync(inside), false);
  delete process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_DIR = path.join(cwd, '.git');
  process.env.GIT_WORK_TREE = cwd;
  const outside = path.join(dir, 'outside');
  assert.equal((await callExam(call, outside)).ok, true);
  assert.equal(process.env.GIT_DIR, path.join(cwd, '.git'));
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  const nested = path.join(dir, 'run1', 'cand1');
  assert.equal((await callExam(call, nested)).ok, true);
  assert.equal(fs.existsSync(path.join(nested, 'stdout')), true);
  await assert.rejects(callExam(call, nested), { code: 'EEXIST' });
});
test('Gemini 공식 스트림의 CLI 총량을 환산 없이 보존한다', async t => {
  const { call } = setup(t);
  const usage = { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 };
  const r = await call('gemini', [agyFinal(usage)]);
  assert.equal(r.usage.records[0].nativeUsage.total_tokens, 11007);
  assert.deepEqual(r.usage.records[0].nativeUsage, usage);
  assert.equal(r.usage.records[0].source, 'result.result.usage');
});

test('시험 전용 Claude JSONL은 실제 tool_result만 세고 종결 result를 읽는다', async t => {
  const { call } = setup(t);
  const r = await call('claude', [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'done', name: 'Bash', input: { command: 'node check.mjs pass' } },
      { type: 'tool_use', id: 'pending', name: 'Bash', input: { command: 'never completed' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'done', content: 'ok', is_error: false }] } },
    { type: 'result', structured_output: { done: true }, usage: { input_tokens: 3, output_tokens: 2 } },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.toolExecutions.counts.Bash, 1);
  assert.equal(r.toolExecutions.partial, true);
  assert.equal(r.evidence.commands[0].command, 'node check.mjs pass');
  assert.ok(r.invocation.argv.includes('--verbose'));
  assert.ok(r.invocation.argv.includes('stream-json'));
});
test('Codex Q3만 live 웹 인자를 넘기며 일반 호출은 보존한다', async t => {
  const { options, dir } = setup(t);
  const call = options('codex', [{ type: 'turn.completed', usage: codexUsage }], { liveWeb: true });
  const r = await callExam(call, path.join(dir, 'live'));
  assert.ok(r.invocation.argv.includes('web_search="live"'));
});

test('호출 종료 정리가 throw해도 실제 수집 스트림·usage와 실패 원인을 보존한다', async t => {
  const {call,dir}=setup(t);
  const remove=fs.rmSync;
  fs.rmSync=(file,options)=>{
    remove(file,options);
    if(path.basename(file).startsWith('mullebanga-call-')) throw Object.assign(new Error('observed cleanup ENOTEMPTY'),{code:'ENOTEMPTY'});
  };
  let result;
  try { result=await call('codex',[{type:'turn.completed',usage:codexUsage}]); }
  finally { fs.rmSync=remove; }
  assert.equal(result.ok,false);
  assert.equal(result.code,'ENOTEMPTY');
  assert.match(result.detail,/observed cleanup ENOTEMPTY/);
  assert.equal(result.usage.records[0].values.input,100);
  assert.equal(result.usage.partial,true);
  assert.match(fs.readFileSync(path.join(dir,'raw0/stdout'),'utf8'),/turn.completed/);
  assert.equal(fs.readFileSync(path.join(dir,'raw0/stderr'),'utf8'),'diagnostic');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'raw0/result.json'))).code,'ENOTEMPTY');
});
test('Gemini 임시 쓰기 폴더는 ENOTEMPTY 대상 재시도를 제한하고 영구 오류는 그대로 올린다', {skip:process.platform==='win32'}, async t => {
  const {options,dir}=setup(t);
  writeFakeTool(path.join(dir,'bin'),'sandbox-exec','#!/bin/sh\nshift 2\nexec "$@"\n');
  const remove=fs.rmSync;
  const seen=[];
  let fail=false;
  fs.rmSync=(file,opts)=>{
    if(path.basename(file).startsWith('mullebanga-write-')) {
      seen.push(opts);
      fs.writeFileSync(path.join(file,'late-write'),'late CLI output');
      assert.throws(()=>fs.rmdirSync(file),{code:'ENOTEMPTY'});
      remove(file,opts);
      if(fail) throw Object.assign(new Error('persistent cleanup failure'),{code:'ENOTEMPTY'});
    } else remove(file,opts);
  };
  try {
    assert.equal((await callWritingGemini(options('gemini',[agyFinal(agyUsage)]))).ok,true);
    fail=true;
    await assert.rejects(callWritingGemini(options('gemini',[agyFinal(agyUsage)])),{code:'ENOTEMPTY'});
  } finally { fs.rmSync=remove; }
  assert.deepEqual(seen,[{recursive:true,force:true,maxRetries:3,retryDelay:100},{recursive:true,force:true,maxRetries:3,retryDelay:100}]);
});
