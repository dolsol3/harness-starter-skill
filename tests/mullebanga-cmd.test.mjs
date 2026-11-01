// npm이 놓는 .cmd 쪽지 도구를 셸 없이 node로 직접 부르는지 본다(W-18). .cmd·.exe 시험은 Windows에서만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool, launcher, onPath } from '../templates/harness/mullebanga-call.mjs';

const windows = process.platform === 'win32';
const onlyWindows = windows ? false : 'Windows에서만 도는 시험(.cmd·.exe)';
const cmdText = name => `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${name}\\bin\\${name}.js" %*\r\n`;
// 받은 인자를 codex가 읽는 결과 파일(-o)에 JSON으로 적는다. 판을 묻는 호출(--version)에는 답만 하고 끝낸다.
const echoJs = "const fs = require('node:fs'); const args = process.argv.slice(2); if (args[0] === '--version') { process.stdout.write('fake 1.0\\n'); process.exit(0); } if (args[0] === '--help') process.exit(0); fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ args, stdin: fs.readFileSync(0, 'utf8') }));\n";

function makeDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function npmCmd(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.cmd`), cmdText(name));
  const js = path.join(dir, 'node_modules', name, 'bin', `${name}.js`);
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, echoJs);
  return js;
}

test('npm 모양 .cmd는 [node, 쪽지 안 js]로 풀리고, onPath가 일치한다', { skip: onlyWindows }, t => {
  const dir = makeDir(t);
  const js = npmCmd(dir, 'x');
  assert.deepEqual(launcher('x', dir), [process.execPath, js]);
  assert.equal(onPath('x', dir), true);
});

test('.exe만 있으면 그 경로 하나, 아무것도 없거나 js가 없는 .cmd는 undefined', { skip: onlyWindows }, t => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, 'e.exe'), '');
  fs.writeFileSync(path.join(dir, 'broken.cmd'), cmdText('broken'));
  assert.deepEqual(launcher('e', dir), [path.join(dir, 'e.exe')]);
  assert.equal(launcher('none', dir), undefined);
  assert.equal(launcher('broken', dir), undefined);
  assert.equal(onPath('none', dir), false);
  assert.equal(onPath('broken', dir), false);
});

test('따옴표·줄바꿈이 든 지시문이 .cmd 도구에 그대로 도착한다(셸을 거치지 않는다)', { skip: onlyWindows }, async t => {
  const dir = makeDir(t);
  npmCmd(dir, 'codex');
  const prompt = 'say "hi" and\nthen \'bye\' & echo %PATH%';
  const res = await callTool({ tool: 'codex', prompt, cwd: dir, schema: { type: 'object' }, timeoutMs: 20000, env: { ...process.env, PATH: dir } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.stdin, prompt);
});

test('맥·리눅스는 PATH에 그 이름의 파일이 있으면 이름 그대로 [이름]을 돌려준다', { skip: windows && 'Windows에서는 해당 없음' }, t => {
  const dir = makeDir(t);
  fs.writeFileSync(path.join(dir, 'codex'), '', { mode: 0o755 });
  assert.deepEqual(launcher('codex', dir), ['codex']);
  assert.equal(onPath('codex', dir), true);
  assert.equal(onPath('none', dir), false);
});

test('빈 PATH 항목(현재 폴더)의 .cmd도 절대 경로로 풀려, 다른 cwd로 띄워도 돈다', { skip: onlyWindows }, async t => {
  const before = process.cwd();
  t.after(() => process.chdir(before));
  const dir = makeDir(t);
  const js = npmCmd(dir, 'codex');
  process.chdir(dir);
  const searchPath = path.delimiter;
  assert.deepEqual(launcher('codex', searchPath), [process.execPath, js]);
  const other = makeDir(t);
  const res = await callTool({ tool: 'codex', prompt: 'p', cwd: other, schema: { type: 'object' }, timeoutMs: 20000, env: { ...process.env, PATH: searchPath } });
  assert.equal(res.ok, true, JSON.stringify(res));
});
