// 4단계(잠금, 질문, 페이지, 서버) 테스트가 함께 쓰는 도우미: 하네스를 넣은 임시 git 저장소와 장부 명령 실행.
// 물레방아 시험이 함께 쓰는 것: 가짜 도구를 만드는 `writeFakeTool`(Windows는 .cmd 쪽지+.js), 임시 폴더를 바꾸는 `setTmpdir`, git 폴더를 찾는 `gitDirs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const toStop = new WeakMap(); // 시험(t) -> 끝날 때 끌 프로세스 번호들

// 시험이 끝날 때 끌 프로세스를 적는다. 폴더를 지우기 전에 끈다.
export const stopAtEnd = (t, pid) => toStop.set(t, [...(toStop.get(t) ?? []), pid]);

// 켜두기로 띄운 서버를 시험이 끝날 때 끈다. 단언이 실패해도 남지 않게 켜는 명령 바로 뒤, 단언보다 먼저 부른다. 상태 파일이 없거나 pid가 없으면(끈 뒤 남는 상태) 띄운 서버도 없다.
export function stopServerAtEnd(t, dir) {
  const file = path.join(dir, 'harness/serve.json');
  if (!fs.existsSync(file)) return;
  const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pid !== undefined) stopAtEnd(t, pid);
}

// kill은 신호만 보내고 돌아온다. 죽는 중인 서버에 fetch를 보내면 잡을 수 없는 예외로 시험이 죽으므로(Node 26.3, undici setTypeOfService EINVAL) 프로세스가 사라질 때까지 기다린다.
export async function gone(pid) {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await sleep(20);
  }
}

async function stopAll(t) {
  for (const pid of toStop.get(t) ?? []) {
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await gone(pid);
  }
  toStop.delete(t);
}

// 프로세스가 사라진 뒤에도 Windows는 수십 ms 동안 그 작업 폴더를 지우지 못한다(EPERM). 서버가 아직 파일을 쥐고 있으면 EBUSY다.
const BUSY_CODES = ['EPERM', 'EBUSY'];
async function removeDir(dir) {
  for (let tries = 0; ; tries += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!BUSY_CODES.includes(error.code) || tries === 100) throw error;
      await sleep(50);
    }
  }
}

// 임시 폴더를 만든다. 시험이 끝나면 적어 둔 프로세스를 모두 끄고 사라진 것을 확인한 뒤 폴더를 지운다.
export function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await stopAll(t);
    await removeDir(dir);
  });
  return dir;
}

// 하네스를 넣고 첫 커밋(main)을 한 임시 git 저장소. 설치기가 하는 대로 장부 관련 파일은 git에 올리지 않는다.
export function repo(t) {
  const dir = tempDir(t, 'harness-ledger-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'harness/backlog.json\nharness/backlog.json.tmp\nharness/backlog.lock\nharness/questions.html\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

export const backlog = (dir, ...args) =>
  spawnSync(process.execPath, [path.join(dir, 'harness/backlog.mjs'), ...args], { cwd: dir, encoding: 'utf8' });

// 같은 명령을 기다리지 않고 돌린다. 여러 명령을 동시에 부를 때 쓴다.
export const backlogLater = (dir, ...args) =>
  new Promise(resolve => {
    execFile(process.execPath, [path.join(dir, 'harness/backlog.mjs'), ...args], { cwd: dir, encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ status: error ? error.code : 0, stdout, stderr }));
  });

export function ok(dir, ...args) {
  const result = backlog(dir, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// 장부 파일을 명령 밖에서 바꾼다. 옛 장부나 시간이 지난 질문을 만들 때 쓴다.
export function rewrite(dir, change) {
  const file = path.join(dir, 'harness/backlog.json');
  const book = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(book);
  fs.writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`);
}

// 거절돼야 하는 명령의 오류 글. 거절하면 장부 파일은 전과 똑같아야 한다.
export function refused(dir, ...args) {
  const file = path.join(dir, 'harness/backlog.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const result = backlog(dir, ...args);
  assert.equal(result.status, 1, `거절돼야 한다: ${args.join(' ')}\n${result.stdout}`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'a refused command leaves the ledger as it was');
  return result.stderr;
}

// 확장자 없는 가짜 도구는 Windows의 spawn이 실행하지 못한다(spawn ENOENT). 그래서 writeFakeTool은 Windows에서 npm 모양 .cmd 쪽지와 .js로 만든다(W-18의 launcher가 셸 없이 node로 부른다).
// 물레방아는 도구를 처음 부를 때 --version과 --help를 묻는다. 가짜도 답해야 판 확인이 부작용(FAKE_CALLS·안 끝남)을 일으키지 않는다. sh 가짜(설치기 시험이 PATH에만 두는 것)에는 붙이지 않는다.
const prelude = name => `(() => { const first = process.argv[2]; if (first === '--version' || first === '--help') { process.stdout.write('${name} fake 1.0\\n--permission-prompts <mode>\\n'); process.exit(0); } })();\n`;
const afterShebang = (source, text) => (source.startsWith('#!') ? source.replace(/^#![^\n]*\n/, line => line + text) : text + source);
// 가짜 도구 하나를 binDir에 만든다. source는 node 스크립트(첫 줄 shebang 가능). binDir는 os.tmpdir() 아래라야 한다: 위쪽에 "type": "module" package.json이 있으면 .js 가짜가 ESM으로 읽혀 깨진다.
export function writeFakeTool(binDir, name, source) {
  const node = !source.startsWith('#!') || /^#!.*node/.test(source);
  const body = node ? afterShebang(source, prelude(name)) : source;
  if (process.platform !== 'win32') return fs.writeFileSync(path.join(binDir, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, `${name}.js`), body);
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${name}.js" %*\r\n`);
}

// PATH에서 git이 든 폴더들. Windows에는 which도 심볼릭 링크도 없어 가짜 PATH에 이 폴더를 그대로 넣는다.
export const gitDirs = () => process.env.PATH.split(path.delimiter).filter(dir => ['git', 'git.exe'].some(name => fs.existsSync(path.join(dir, name))));

// os.tmpdir()는 Windows에서 TMPDIR이 아니라 TEMP·TMP를 본다. 셋을 dir로 바꾸고, 시험이 끝나면 원래 값(없었으면 없음)으로 되돌린다.
export function setTmpdir(t, dir) {
  const saved = ['TMPDIR', 'TEMP', 'TMP'].map(name => [name, process.env[name]]);
  for (const [name] of saved) process.env[name] = dir;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// 폴더 링크. junction은 권한 없이 만들어지고 대상이 절대 경로여야 해서 resolve한다(맥에서도 같은 호출이 된다).
export const linkDir = (target, link) => fs.symlinkSync(path.resolve(target), link, 'junction');

// 파일 링크를 한 번 만들어 보고 정한다: 만들 수 있으면 false, 없으면 건너뛸 이유 글(skip 옵션에 그대로 쓴다).
export const fileLinkSkip = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelink-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), '');
    fs.symlinkSync('a', path.join(dir, 'b'));
    return false;
  } catch (error) {
    if (error.code === 'EPERM') return '파일 심볼릭 링크를 만들 권한이 없다(Windows 개발자 모드)';
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
})();
