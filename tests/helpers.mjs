// 4단계(잠금, 질문, 페이지, 서버) 테스트가 함께 쓰는 도우미: 하네스를 넣은 임시 git 저장소와 장부 명령 실행.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

// 하네스를 넣고 첫 커밋(main)을 한 임시 git 저장소. 설치기가 하는 대로 장부 관련 파일은 git에 올리지 않는다.
export function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

// 거절돼야 하는 명령의 오류 글. 거절하면 장부 파일은 전과 똑같아야 한다.
export function refused(dir, ...args) {
  const file = path.join(dir, 'harness/backlog.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const result = backlog(dir, ...args);
  assert.equal(result.status, 1, `거절돼야 한다: ${args.join(' ')}\n${result.stdout}`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'a refused command leaves the ledger as it was');
  return result.stderr;
}
