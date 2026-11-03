// Windows에서 도구 실행 파일을 어떻게 고르고, 어느 판인지 남기며, 판에 없는 인자를 빼고 부르는지 본다(W-28).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callTool, launcher } from '../templates/harness/mullebanga-call.mjs';

const modulePath = fileURLToPath(new URL('../templates/harness/mullebanga-call.mjs', import.meta.url));
const schema = { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] };
const answer = { done: true };

function makeDir(t, prefix = 'harness-bin-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 가짜 도구: 판·도움말에는 그 글을 내고, 나머지 호출은 받은 인자를 FAKE_LOG에 남긴 뒤 claude 봉투를 낸다.
const claudeFake = ({ version = 'fake 1.0', help = '', result = answer } = {}) => `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(${JSON.stringify(help)} + '\\n'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(args));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: ${JSON.stringify(result)} }));
`;
// agy 가짜: 판을 물으면 아무것도 내지 않고 끝나고, 부르면 정해진 stream-json 줄을 낸다.
const agyFake = out => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
process.stdout.write(${JSON.stringify(out)});
`;
function writeTool(dir, name, source) {
  if (process.platform !== 'win32') return fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${name}.js`), source);
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${name}.js" %*\r\n`);
}
const toolPath = (dir, name) => (process.platform === 'win32' ? path.join(dir, `${name}.cmd`) : path.join(dir, name));
const searchPath = (...dirs) => [...dirs, path.dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter);
const envFor = (dir, extra = {}) => ({ ...process.env, PATH: searchPath(dir), FAKE_LOG: path.join(dir, 'log.json'), ...extra });
const readLog = dir => JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
const geminiOut = response => [JSON.stringify({ event: 'init', init: { permission_mode: 'always-proceed' } }), JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } })].join('\n') + '\n';

test('도구를 처음 부를 때 실제 판 번호를 stderr에 남기고, --help에 없는 인자는 넘기지 않는다', async t => {
  const dir = makeDir(t);
  writeTool(dir, 'claude', claudeFake({ version: '2.1.31 (Claude Code)', help: 'Usage: claude [options]' }));
  const script = `import { callTool } from ${JSON.stringify(pathToFileURL(modulePath).href)};
const res = await callTool({ tool: 'claude', prompt: 'p', cwd: process.cwd(), schema: ${JSON.stringify(schema)}, timeoutMs: 20000, env: process.env });
process.stdout.write(JSON.stringify(res));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: envFor(dir), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, result: answer });
  assert.match(child.stderr, /\[harness\] claude 2\.1\.31 \(Claude Code\)/);
  assert.ok(!readLog(dir).includes('--permission-prompts'), '판에 없는 인자는 넘기지 않는다');
});

test('--help에 --permission-prompts가 있으면 그대로 넘긴다', async t => {
  const dir = makeDir(t);
  writeTool(dir, 'claude', claudeFake({ help: 'Usage: claude --permission-prompts <mode>' }));
  assert.deepEqual(await callTool({ tool: 'claude', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env: envFor(dir) }), { ok: true, result: answer });
  const args = readLog(dir);
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
});

test('HARNESS_CLAUDE_BIN으로 실행 파일을 바꿔 끼우고, 없는 파일을 가리키면 그 이름을 담아 던진다', async t => {
  const dir = makeDir(t);
  const other = makeDir(t, 'harness-bin-other-');
  writeTool(dir, 'claude', claudeFake({ result: { done: false } }));
  writeTool(other, 'claude', claudeFake());
  const env = envFor(dir, { HARNESS_CLAUDE_BIN: toolPath(other, 'claude') });
  assert.deepEqual(await callTool({ tool: 'claude', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env }), { ok: true, result: answer });
  const missing = { ...env, HARNESS_CLAUDE_BIN: path.join(dir, 'nope') };
  await assert.rejects(callTool({ tool: 'claude', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env: missing }), /HARNESS_CLAUDE_BIN/);
});

test('npm 쪽지가 .js가 아니라 .exe를 가리켜도 그 .exe를 고른다', { skip: process.platform !== 'win32' && 'Windows에서만 .cmd·.exe를 본다' }, t => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@ECHO off\r\n"%dp0%\\claude.exe" %*\r\n');
  assert.deepEqual(launcher('claude', dir), [path.join(dir, 'claude.exe')]);
});

test('npm 쪽지가 node.exe와 .js를 함께 적으면 .js를 node로 부른다(코덱스 모양)', { skip: process.platform !== 'win32' && 'Windows에서만 .cmd·.exe를 본다' }, t => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  fs.writeFileSync(path.join(dir, 'codex.js'), '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\codex.js" %*\r\n');
  assert.deepEqual(launcher('codex', dir), [process.execPath, path.join(dir, 'codex.js')]);
});

test('gemini: structured_output이 없으면 response에서 마지막으로 성립하는 JSON 객체를 쓴다', async t => {
  const dir = makeDir(t);
  writeTool(dir, 'agy', agyFake(geminiOut(Array.from({ length: 4 }, () => JSON.stringify({ findings: [] })).join('\n'))));
  assert.deepEqual(await callTool({ tool: 'gemini', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env: envFor(dir) }), { ok: true, result: { findings: [] } });
});

test('gemini: response에 중첩된 JSON이 여러 번 들어 있어도 바깥 객체를 온전히 꺼낸다', async t => {
  const dir = makeDir(t);
  const one = JSON.stringify({ findings: [{ level: '낮음', text: 'x' }] });
  writeTool(dir, 'agy', agyFake(geminiOut(`앞말 ${one}\n${one}\n뒤말`)));
  assert.deepEqual(await callTool({ tool: 'gemini', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env: envFor(dir) }), { ok: true, result: { findings: [{ level: '낮음', text: 'x' }] } });
});

test('gemini: 지적 글에 중괄호가 들어 있어도 JSON을 온전히 꺼낸다', async t => {
  const dir = makeDir(t);
  const one = JSON.stringify({ findings: [{ level: '중간', text: '`{"a": 1}` 꼴이 깨진다 }' }] });
  writeTool(dir, 'agy', agyFake(geminiOut(`검토 결과다.\n${one}\n`)));
  assert.deepEqual(await callTool({ tool: 'gemini', prompt: 'p', cwd: dir, schema, timeoutMs: 20000, env: envFor(dir) }), { ok: true, result: { findings: [{ level: '중간', text: '`{"a": 1}` 꼴이 깨진다 }' }] } });
});
