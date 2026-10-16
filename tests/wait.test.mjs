// 기다리기: 사람이 답하면 몇 초 안에 새 답 줄을 내고 끝나고, 상한이 지나거나 기다릴 질문이 없어도 끝난다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { repo, ok, refused, rewrite, backlogLater } from './helpers.mjs';

const NEW = '새 답 1개(Q-1 답함). 메인은 node harness/backlog.mjs 질문목록 --상태 답함(고칠것은 --상태 고칠것)으로 읽는다';
const NOTHING = '기다릴 질문도 새 답도 없다';
const COMMON = ['--설명', '쓰지 않는 열이다', '--보기', '지운다=열이 사라진다|둔다=그대로 남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다'];
const PERMIT = ['허락', 'T-1', '지울까요', '--행동', '삭제', ...COMMON];
const CONFIRM = ['확인', 'T-1', '어느 문서를 따를까요', '--까닭', '문서충돌', ...COMMON];
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const DAY = 24 * 60 * 60 * 1000;

// 기다리기를 띄우고 끝날 때의 결과와 걸린 밀리초를 돌려준다.
async function timed(dir, ...args) {
  const started = Date.now();
  const result = await backlogLater(dir, '기다리기', ...args);
  return { ...result, took: Date.now() - started };
}

function asked(t, question) {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...question);
  return dir;
}

test('waiting ends a few seconds after the person answers and leaves the new-answer mark', async t => {
  const dir = asked(t, PERMIT);
  let done = false;
  const waiting = backlogLater(dir, '기다리기', '--분', '1').then(result => {
    done = true;
    return result;
  });
  await sleep(3000);
  assert.equal(done, false, 'it keeps waiting while nobody answers');
  ok(dir, '답', 'Q-1', '둔다');
  const answered = Date.now();
  const result = await waiting;
  assert.ok(Date.now() - answered < 5000, 'it ends within 5 seconds of the answer');
  assert.deepEqual([result.status, result.stdout], [0, `${NEW}\n`]);
  assert.equal(ledgerOf(dir).질문[0].새답, true);
});

test('an answer already there ends waiting at once without removing the mark', async t => {
  const dir = asked(t, PERMIT);
  ok(dir, '답', 'Q-1', '둔다');
  const result = await timed(dir, '--분', '1');
  assert.ok(result.took < 2000, `took ${result.took}ms`);
  assert.deepEqual([result.status, result.stdout], [0, `${NEW}\n`]);
  assert.equal(ledgerOf(dir).질문[0].새답, true);
});

test('waiting ends without an answer when the limit passes', async t => {
  const dir = asked(t, CONFIRM);
  const result = await timed(dir, '--분', '0.05');
  assert.ok(result.took > 3000 && result.took < 10000, `took ${result.took}ms`);
  assert.deepEqual([result.status, result.stdout], [0, '답 없이 지났다(0.05분). 다시 걸지 않는다\n']);
});

test('with nothing to wait for it ends at once', async t => {
  const empty = repo(t);
  ok(empty, '추가', '일');
  const read = asked(t, PERMIT);
  ok(read, '답', 'Q-1', '둔다');
  ok(read, '질문목록', '--상태', '답함');
  const settled = asked(t, CONFIRM);
  rewrite(settled, book => {
    book.질문[0].만든시각 = new Date(Date.now() - 4 * DAY).toISOString();
  });
  for (const dir of [empty, read, settled]) {
    const result = await timed(dir, '--분', '1');
    assert.ok(result.took < 2000, `took ${result.took}ms`);
    assert.deepEqual([result.status, result.stdout], [0, `${NOTHING}\n`]);
  }
});

test('a limit that is not a positive number and other options are refused', t => {
  const dir = asked(t, PERMIT);
  for (const limit of [['--분', '0'], ['--분=-1'], ['--분', 'abc']]) {
    assert.match(refused(dir, '기다리기', ...limit), /--분은 0보다 큰 수다/, limit.join(' '));
  }
  assert.match(refused(dir, '기다리기', '--상태', '대기'), /--상태은\(는\) 이 명령에서 쓰지 않는다/);
});
