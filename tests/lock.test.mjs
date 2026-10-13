import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, ok, backlog, backlogLater } from './helpers.mjs';

test('commands that write the ledger at the same time all take effect (none is silently lost)', async t => {
  const dir = repo(t);
  for (const name of ['가', '나', '다', '라']) ok(dir, '추가', name);
  const results = await Promise.all(
    [1, 2, 3, 4].map(n => backlogLater(dir, '시작', `T-${n}`, '--영역', `src/area${n}`, '--확인방법', 'npm test')),
  );
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(ok(dir, '목록', '--상태', '진행중').split('\n').length, 4, 'all four starts are in the ledger');
});

test('a command waits for the lock another command holds and then goes on', async t => {
  const dir = repo(t);
  const lock = path.join(dir, 'harness/backlog.lock');
  fs.writeFileSync(lock, '');
  const running = backlogLater(dir, '추가', '기다림');
  setTimeout(() => fs.rmSync(lock), 400);
  const result = await running;
  assert.equal(result.status, 0, result.stderr);
  assert.match(ok(dir, '목록'), /기다림/);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the command');
});

test('a lock that stays refuses the command, names the file and leaves the ledger alone', t => {
  const dir = repo(t);
  const lock = path.join(dir, 'harness/backlog.lock');
  fs.writeFileSync(lock, '');
  const result = backlog(dir, '추가', '막힘');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /harness\/backlog\.lock/);
  assert.ok(!fs.existsSync(path.join(dir, 'harness/backlog.json')), 'nothing was written');
  assert.ok(fs.existsSync(lock), 'a lock held by someone else is not removed');
});

test('a refused command releases the lock and reading commands do not need it', t => {
  const dir = repo(t);
  assert.equal(backlog(dir, '시작', 'T-9').status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'harness/backlog.lock')), 'the lock is released after a refusal');
  fs.writeFileSync(path.join(dir, 'harness/backlog.lock'), '');
  assert.equal(backlog(dir, '목록').status, 0, 'listing reads without the lock');
});

test('each save puts a new file in place of the ledger instead of writing into the old one, and leaves no temporary file', t => {
  const dir = repo(t);
  const file = path.join(dir, 'harness/backlog.json');
  ok(dir, '추가', '하나');
  const first = fs.statSync(file).ino;
  ok(dir, '추가', '둘');
  assert.notEqual(fs.statSync(file).ino, first, 'the ledger is replaced, not rewritten where it is');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'harness')).filter(name => name.startsWith('backlog.json')), ['backlog.json']);
});
