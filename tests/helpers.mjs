// 4단계(잠금, 질문, 페이지, 서버) 테스트가 함께 쓰는 도우미: 하네스를 넣은 임시 git 저장소와 장부 명령 실행.
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

// 프로세스가 사라진 뒤에도 Windows는 수십 ms 동안 그 작업 폴더를 지우지 못한다(EPERM).
async function removeDir(dir) {
  for (let tries = 0; ; tries += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== 'EPERM' || tries === 100) throw error;
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
