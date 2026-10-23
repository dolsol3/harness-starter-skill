import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo, ok, refused, rewrite } from './helpers.mjs';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const WHERE = ['--영역', 'a.txt', '--확인방법', '본다'];

test('a ledger with no 앞글자 counts with T, even an old one that continues from a high number', t => {
  const dir = repo(t);
  assert.match(ok(dir, '추가', '처음'), /^추가: T-1 /);
  rewrite(dir, book => {
    book.다음번호 = 104;
  });
  assert.match(ok(dir, '추가', '이어서'), /^추가: T-104 /);
  assert.equal('앞글자' in JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8')), false);
});

test('앞글자 W starts at W-1 and 보기, 선행, 시작, 올림, 완료 work with it', t => {
  const dir = repo(t);
  assert.equal(ok(dir, '앞글자', 'W'), '앞글자: W (다음 작업 W-1)');
  assert.match(ok(dir, '추가', '가', ...WHERE), /^추가: W-1 \[할일\] 기능 가/);
  assert.match(ok(dir, '추가', '나', '--영역', 'b.txt', '--확인방법', '본다', '--선행', 'W-1'), /^추가: W-2 /);
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/tasks/W-1.md'), '# W-1 명세 내용\n');
  assert.match(ok(dir, '보기', 'W-1'), /--- docs\/tasks\/W-1\.md ---\n# W-1 명세 내용/);

  assert.match(refused(dir, '시작', 'W-2'), /W-2 시작 거절: .*W-1.*완료되지 않았다/);
  ok(dir, '시작', 'W-1');
  git(dir, 'switch', '-q', '-c', 'ai/w-1');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'work\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'w-1');
  const hash = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  ok(dir, '올림', 'W-1', '--커밋', hash, '--증거', '본다');
  git(dir, 'merge', '-q', '--no-ff', 'ai/w-1', '-m', 'merge W-1');
  assert.match(ok(dir, '완료', 'W-1'), /^완료: W-1 \[완료\]/);
  assert.match(ok(dir, '시작', 'W-2'), /^시작: W-2 \[진행중\]/);
});

test('setting a letter again continues after the largest number of that letter', t => {
  const dir = repo(t);
  ok(dir, '추가', 'T 하나');
  ok(dir, '앞글자', 'W');
  ok(dir, '추가', 'W 하나');
  ok(dir, '추가', 'W 둘');
  assert.equal(ok(dir, '앞글자', 'W'), '앞글자: W (다음 작업 W-3)');
  assert.equal(ok(dir, '앞글자', 'T'), '앞글자: T (다음 작업 T-2)');
  assert.match(ok(dir, '추가', 'T 둘'), /^추가: T-2 /);
});

test('앞글자 refuses anything but capital letters A-Z and leaves the ledger as it was', t => {
  const dir = repo(t);
  ok(dir, '추가', '장부 만들기');
  for (const letter of [[], ['w'], ['W-'], ['1'], ['가']]) {
    assert.match(refused(dir, '앞글자', ...letter), /^backlog: 앞글자 거절: .*영어 대문자/, letter.join());
  }
});
