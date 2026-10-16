// 새 답 줄: 사람이 답하면 장부 명령마다 링크 줄 앞에 한 줄이 뜨고, 메인이 질문목록으로 읽으면 사라진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, ok, refused, rewrite } from './helpers.mjs';
import { answerNotice } from '../templates/harness/questions.mjs';

const READ = '메인은 node harness/backlog.mjs 질문목록 --상태 답함(고칠것은 --상태 고칠것)으로 읽는다';
const COMMON = ['--설명', '쓰지 않는 열이다', '--보기', '지운다=열이 사라진다|둔다=그대로 남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다'];
const PERMIT = ['허락', 'T-1', '지울까요', '--행동', '삭제', ...COMMON];
const CONFIRM = ['확인', 'T-1', '어느 문서를 따를까요', '--까닭', '문서충돌', ...COMMON];
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const lastLine = text => text.split('\n').at(-1);
const DAY = 24 * 60 * 60 * 1000;

test('an answer shows one line at the end of every ledger command until 질문목록 reads it', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  ok(dir, ...CONFIRM);
  assert.doesNotMatch(ok(dir, '목록'), /새 답/);
  assert.equal(ok(dir, '답', 'Q-1', '둔다'), '답: Q-1 [답함] T-1 삭제 지울까요  → 둔다');
  const one = `새 답 1개(Q-1 답함). ${READ}`;
  for (const command of [['목록'], ['다음'], ['준비'], ['보기', 'T-1']]) assert.equal(lastLine(ok(dir, ...command)), one, command.join(' '));
  assert.equal(ok(dir, '답', 'Q-2', '지운다'), '답: Q-2 [고칠것] T-1 설계확인(문서충돌) 어느 문서를 따를까요  → 지운다');
  assert.equal(lastLine(ok(dir, '목록')), `새 답 2개(Q-1 답함, Q-2 고칠것). ${READ}`);
  ok(dir, '질문목록');
  assert.deepEqual(ledgerOf(dir).질문.map(item => item.새답), [true, true], 'the default 질문목록 shows waiting ones, so it keeps the answered marks');
  const left = `새 답 1개(Q-2 고칠것). ${READ}`;
  const read = ok(dir, '질문목록', '--상태', '답함');
  assert.match(read, /^Q-1 \[답함\] /);
  assert.equal(lastLine(read), left);
  assert.ok(!('새답' in ledgerOf(dir).질문[0]), 'reading Q-1 removes its mark');
  assert.equal(lastLine(ok(dir, '목록')), left);
  ok(dir, '질문목록', '--상태', '고칠것');
  assert.equal(ok(dir, '목록'), 'T-1 [할일] 기능 일');
});

test('answers from an old ledger and confirmations settled after 3 days are not new answers', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  ok(dir, ...CONFIRM);
  rewrite(dir, book => {
    Object.assign(book.질문[0], { 상태: '답함', 답: '둔다' });
    book.질문[1].만든시각 = new Date(Date.now() - 4 * DAY).toISOString();
  });
  assert.match(refused(dir, '답', 'Q-2', '둔다'), /확정됐다/);
  assert.equal(ok(dir, '목록'), 'T-1 [할일] 기능 일');
});

test('the line comes after the cut-off line of a long answer', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  ok(dir, '답', 'Q-1', '둔다');
  rewrite(dir, book => {
    for (let number = 2; number <= 101; number += 1) book.작업.push({ ...book.작업[0], 번호: `T-${number}` });
  });
  const lines = ok(dir, '목록').split('\n');
  assert.deepEqual(lines.slice(-2), ['… 1줄 더 있다. --상태로 조건을 좁힌다', `새 답 1개(Q-1 답함). ${READ}`]);
});

test('질문목록 shows new answers first, so a new answer after 100 read ones is read at once', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...PERMIT);
  rewrite(dir, book => {
    Object.assign(book.질문[0], { 상태: '답함', 답: '둔다' });
    for (let number = 2; number <= 100; number += 1) book.질문.push({ ...book.질문[0], 번호: `Q-${number}` });
    book.질문.push({ ...book.질문[0], 번호: 'Q-101', 상태: '대기', 답: undefined });
  });
  ok(dir, '답', 'Q-101', '둔다');
  assert.equal(lastLine(ok(dir, '목록')), `새 답 1개(Q-101 답함). ${READ}`);
  const read = ok(dir, '질문목록', '--상태', '답함').split('\n');
  assert.match(read[0], /^Q-101 \[답함\] /);
  assert.equal(read[1].split(' ')[0], 'Q-1', 'the rest keep the ledger order');
  assert.ok(!ledgerOf(dir).질문.some(item => item.새답), 'reading removes the mark of Q-101');
  assert.equal(ok(dir, '목록'), 'T-1 [할일] 기능 일');
});

// 시험이 끝나면 켜두기로 띄운 서버를 끈다(tests/serve-keep.test.mjs의 stopLater와 같다).
function stopLater(t, dir) {
  const { pid } = JSON.parse(fs.readFileSync(path.join(dir, 'harness/serve.json'), 'utf8'));
  t.after(() => {
    try {
      process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}

test('with the page kept on, 허락 still ends with the link and the new-answer line is just before it', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, '켜두기');
  stopLater(t, dir);
  ok(dir, ...PERMIT);
  ok(dir, '답', 'Q-1', '둔다');
  const lines = ok(dir, ...PERMIT).split('\n');
  assert.equal(lines.at(-2), `새 답 1개(Q-1 답함). ${READ}`);
  assert.match(lines.at(-1), /^질문 페이지: http:\/\/127\.0\.0\.1:\d+\/\?token=/);
});

test('answerNotice gives no line without new answers and one line with them, and leaves the ledger as it was', () => {
  const question = (번호, 상태, extra = {}) => ({ 번호, 작업: 'T-1', 상태, ...extra });
  const quiet = { 질문: [question('Q-1', '대기'), question('Q-2', '답함')] };
  assert.deepEqual(answerNotice(quiet), []);
  const book = { 질문: [question('Q-1', '답함', { 새답: true }), question('Q-2', '대기'), question('Q-3', '고칠것', { 새답: true })] };
  const before = structuredClone(book);
  assert.deepEqual(answerNotice(book), [`새 답 2개(Q-1 답함, Q-3 고칠것). ${READ}`]);
  assert.deepEqual(book, before);
});
