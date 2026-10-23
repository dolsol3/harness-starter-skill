import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolsConfig } from '../scripts/tools.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const templateText = fs.readFileSync(new URL('../templates/harness/config.json', import.meta.url), 'utf8');
const template = JSON.parse(templateText);
const skip = process.platform === 'win32' && 'Windows에는 실행 비트가 없어 가짜 도구를 만들 수 없다';
const CONFIG_LINE = '[새로 만듦] harness/config.json';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

// 진짜 git만 심볼릭 링크한 폴더: PATH를 이 폴더와 가짜 도구 폴더로만 줘서 기계에 깔린 진짜 도구에 흔들리지 않게 한다.
// Windows에는 which도 실행 비트도 없으므로 건너뛸 때는 준비하지 않는다.
const gitDir = skip ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-git-'));
if (!skip) {
  after(() => fs.rmSync(gitDir, { recursive: true, force: true }));
  const git = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'git')).find(file => fs.existsSync(file));
  fs.symlinkSync(git, path.join(gitDir, 'git'));
}

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

// 빈 셸 스크립트에 chmod 755한 가짜 실행 파일이 든 폴더를 PATH로 만든다.
function pathWith(t, ...names) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const name of names) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  return [bin, gitDir].join(path.delimiter);
}

function install(dir, tools, ...args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: tools };
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(dir).join('<대상>');
}

const configOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/config.json'), 'utf8'));
const lineOf = (out, text) => out.split('\n').find(line => line.includes(text));

// 일감목록을 뺀 나머지가 템플릿과 같은지 본다.
function assertTemplateExceptTools(dir) {
  const { 일감목록, ...rest } = configOf(dir);
  assert.ok(일감목록, 'the 일감목록 is written');
  assert.deepEqual(rest, template);
}

function assertNoTools(dir) {
  assert.equal(fs.readFileSync(path.join(dir, 'harness/config.json'), 'utf8'), templateText);
}

const STAGE_TWO = { 동시상한: { claude: 3, codex: 1, gemini: 1 }, 기본맡길곳: 'claude' };

test('preview tells what the 일감목록 would be and writes nothing', { skip }, t => {
  const dir = project(t);
  const out = install(dir, pathWith(t, 'codex', 'agy'), '--main=claude');
  const line = lineOf(out, CONFIG_LINE);
  assert.match(line, /일감목록을 적는다/);
  assert.doesNotMatch(line, /적었다/, 'a preview has not written anything');
  assert.match(line, /claude 3·codex 1·gemini 1/);
  assert.match(line, /기본맡길곳 claude/);
  assert.match(line, /실험으로 정한 값이 아니다/);
  assert.match(line, /harness\/config\.json의 일감목록을 고친다/);
  assert.equal(fs.existsSync(path.join(dir, 'harness/config.json')), false);
});

test('apply writes the 일감목록 and leaves the rest of the template alone', { skip }, t => {
  const dir = project(t);
  install(dir, pathWith(t, 'codex', 'agy'), '--main=claude', '--apply');
  assert.deepEqual(configOf(dir).일감목록, STAGE_TWO);
  assertTemplateExceptTools(dir);
});

test('the main tool leaves the partners; any main name is taken as it is', { skip }, t => {
  const codexMain = project(t);
  install(codexMain, pathWith(t, 'codex', 'agy'), '--main=codex', '--apply');
  assert.deepEqual(configOf(codexMain).일감목록, { 동시상한: { codex: 3, gemini: 1 }, 기본맡길곳: 'codex' });
  const kimiMain = project(t);
  install(kimiMain, pathWith(t, 'claude', 'codex'), '--main=kimi', '--apply');
  assert.deepEqual(configOf(kimiMain).일감목록, { 동시상한: { kimi: 3, claude: 1, codex: 1 }, 기본맡길곳: 'kimi' });
});

test('a Codex main with only claude installed lists claude as its partner', { skip }, t => {
  const dir = project(t);
  install(dir, pathWith(t, 'claude'), '--main=codex', '--apply');
  assert.deepEqual(configOf(dir).일감목록, { 동시상한: { codex: 3, claude: 1 }, 기본맡길곳: 'codex' });
});

test('a main name with $ replacement patterns is written as it is', { skip }, t => {
  for (const main of ['$&', '$$', "$'", '$`']) {
    const dir = project(t);
    install(dir, pathWith(t, 'codex'), `--main=${main}`, '--apply');
    assert.deepEqual(configOf(dir).일감목록, { 동시상한: { [main]: 3, codex: 1 }, 기본맡길곳: main });
  }
});

test('nothing changes without a main, without partners, without backlog, or with an empty --main=', { skip }, t => {
  const cases = [
    ['no tools installed', pathWith(t), ['--main=claude']],
    ['no --main', pathWith(t, 'codex', 'agy'), []],
    ['empty --main=', pathWith(t, 'codex', 'agy'), ['--main=']],
    ['only the main itself is installed', pathWith(t, 'claude'), ['--main=claude']],
    ['backlog left out', pathWith(t, 'codex', 'agy'), ['--main=claude', '--without=instructions,codex-hook,antigravity-hook,git-hook,lean-review,backlog']],
  ];
  for (const [name, tools, flags] of cases) {
    const dir = project(t);
    const out = install(dir, tools, ...flags, '--apply');
    assert.equal(lineOf(out, CONFIG_LINE), CONFIG_LINE, name);
    assertNoTools(dir);
  }
});

test('an existing config.json is never rewritten', { skip }, t => {
  const dir = project(t);
  const tools = pathWith(t, 'codex', 'agy');
  install(dir, tools, '--apply');
  const file = path.join(dir, 'harness/config.json');
  const same = fs.readFileSync(file, 'utf8');
  install(dir, tools, '--main=claude', '--apply');
  assert.equal(fs.readFileSync(file, 'utf8'), same);
  const edited = `${same.trimEnd()}\n\n`;
  fs.writeFileSync(file, edited);
  install(dir, tools, '--main=claude', '--apply');
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
});

test('--upgrade writes the 일감목록 only when it creates config.json', { skip }, t => {
  const tools = pathWith(t, 'codex', 'agy');
  const fresh = project(t);
  install(fresh, tools, '--upgrade', '--main=claude', '--apply');
  assert.deepEqual(configOf(fresh).일감목록, STAGE_TWO);
  assertTemplateExceptTools(fresh);
  const old = project(t);
  fs.mkdirSync(path.join(old, 'harness'));
  fs.writeFileSync(path.join(old, 'harness/config.json'), '{ "maxFileLines": 300 }\n');
  install(old, tools, '--upgrade', '--main=claude', '--apply');
  assert.equal('일감목록' in configOf(old), false);
});

test('the installed 장부 command reads the written 일감목록', { skip }, t => {
  const dir = project(t);
  install(dir, pathWith(t, 'codex', 'agy'), '--main=claude', '--apply');
  const backlog = (...args) => spawnSync(process.execPath, ['harness/backlog.mjs', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const run = (...args) => {
    const result = backlog(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run('목록');
  run('추가', '일');
  assert.match(run('시작', 'T-1', '--영역', 'src/a/**', '--확인방법', 'npm test', '--맡길곳', 'codex'), /시작: T-1 \[진행중\]/);
  run('추가', '다른 일');
  const refused = backlog('시작', 'T-2', '--영역', 'src/b/**', '--확인방법', 'npm test', '--맡길곳', 'kimi');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /kimi/, '선언하지 않은 도구는 받지 않는다');
});

test('a PATH entry that cannot be read is skipped, and the install still ends with 0', { skip: skip || (process.getuid?.() === 0 && 'root는 권한 없는 폴더도 읽는다') }, t => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tools-broken-'));
  t.after(() => {
    fs.chmodSync(path.join(broken, 'locked'), 0o755);
    fs.rmSync(broken, { recursive: true, force: true });
  });
  fs.symlinkSync('loop', path.join(broken, 'loop'));
  fs.mkdirSync(path.join(broken, 'locked'), { mode: 0o000 });
  const tools = [path.join(broken, 'loop'), path.join(broken, 'locked'), pathWith(t, 'codex')].join(path.delimiter);
  for (const flags of [['--main=claude'], []]) {
    const dir = project(t);
    install(dir, tools, ...flags, '--apply');
    if (flags.length) assert.deepEqual(configOf(dir).일감목록, { 동시상한: { claude: 3, codex: 1 }, 기본맡길곳: 'claude' });
    else assertNoTools(dir);
  }
});

test('a PATH entry with a 300-character folder name is skipped, and the tool after it is found', { skip }, t => {
  const tools = [path.join(os.tmpdir(), 'x'.repeat(300)), pathWith(t, 'codex')].join(path.delimiter);
  const dir = project(t);
  install(dir, tools, '--main=claude', '--apply');
  assert.deepEqual(configOf(dir).일감목록, { 동시상한: { claude: 3, codex: 1 }, 기본맡길곳: 'claude' });
});

test('an empty PATH entry is the current folder, as the shell sees it', { skip }, t => {
  const dir = project(t);
  const [bin, git] = pathWith(t, 'codex').split(path.delimiter);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: [git, ''].join(path.delimiter) };
  const result = spawnSync(process.execPath, [installer, dir, '--main=claude', '--apply'], { cwd: bin, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(configOf(dir).일감목록, { 동시상한: { claude: 3, codex: 1 }, 기본맡길곳: 'claude' });
});

test('a file the current user cannot run is not a tool', { skip: skip || (process.getuid?.() === 0 && 'root는 실행 비트가 하나라도 있으면 실행한다') }, t => {
  const tools = pathWith(t, 'codex');
  const codex = path.join(tools.split(path.delimiter)[0], 'codex');
  for (const mode of [0o644, 0o001]) {
    fs.chmodSync(codex, mode);
    const dir = project(t);
    install(dir, tools, '--main=claude', '--apply');
    assertNoTools(dir);
  }
});

test('a CRLF config.json template gets the 일감목록 with CRLF line ends', { skip }, t => {
  const before = process.env.PATH;
  process.env.PATH = pathWith(t, 'codex');
  t.after(() => { process.env.PATH = before; });
  const found = toolsConfig(templateText.replace(/\n/g, '\r\n'), 'claude');
  assert.deepEqual(JSON.parse(found.content).일감목록, { 동시상한: { claude: 3, codex: 1 }, 기본맡길곳: 'claude' });
  assert.doesNotMatch(found.content, /(?<!\r)\n/, 'no bare line feed is left');
  assert.doesNotMatch(toolsConfig(templateText, 'claude').content, /\r/);
});

const NO_HOOK = '--without=antigravity-hook';

test('without the antigravity-hook, agy is not written as gemini, in the preview, the apply, and the --upgrade that creates config.json', { skip }, t => {
  const tools = pathWith(t, 'codex', 'agy');
  const preview = install(project(t), tools, '--main=claude', NO_HOOK);
  assert.match(lineOf(preview, CONFIG_LINE), /동시상한 claude 3·codex 1,/);
  assert.doesNotMatch(lineOf(preview, CONFIG_LINE), /gemini/);
  for (const flags of [[], ['--upgrade']]) {
    const dir = project(t);
    install(dir, tools, ...flags, '--main=claude', NO_HOOK, '--apply');
    assert.deepEqual(configOf(dir).일감목록, { 동시상한: { claude: 3, codex: 1 }, 기본맡길곳: 'claude' });
    assert.equal(fs.existsSync(path.join(dir, '.agents/agents')), false);
  }
});

test('without the antigravity-hook and without another partner, no 일감목록 is written', { skip }, t => {
  for (const main of ['claude', 'codex']) {
    const dir = project(t);
    install(dir, pathWith(t, 'agy'), `--main=${main}`, NO_HOOK, '--apply');
    assertNoTools(dir);
  }
});
