import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo, ok, refused, rewrite } from './helpers.mjs';

// 명령 인자. change로 칸을 바꾸고, 값이 null인 칸은 아예 적지 않는다.
const args = (name, task, title, base, change = {}) => [
  name, task, title, ...Object.entries({ ...base, ...change }).filter(([, value]) => value !== null).flatMap(([key, value]) => [`--${key}`, value]),
];
const COMMON = { 설명: '쓰지 않는 열이다', 보기: '지운다=열이 사라진다|둔다=그대로 남는다', 추천: '둔다', 이유: '되돌릴 수 없다' };
const permit = (task, change, title = '옛 열을 지울까요') => args('허락', task, title, { 행동: '삭제', ...COMMON }, change);
const confirm = (task, change, title = '어느 문서를 따를까요') => args('확인', task, title, { 까닭: '문서충돌', ...COMMON }, change);
const record = (name, task, change) => args(name, task, '표준 Date를 쓴다', { 설명: '충분하다', 이유: '의존을 줄인다' }, change);
const head = dir => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const submit = dir => ['올림', 'T-1', '--커밋', head(dir), '--증거', '통과'];
const HOUR = 60 * 60 * 1000;

function twoTasks(t) {
  const dir = repo(t);
  ok(dir, '추가', '이 일', '--영역', 'src/a', '--확인방법', 'npm test');
  ok(dir, '추가', '다른 일', '--영역', 'src/b', '--확인방법', 'npm test');
  return dir;
}

test('허락 takes each of the five actions and holds only its own task until it is answered', t => {
  const dir = twoTasks(t);
  ['삭제', '약속변경', '외부발행', '결제', '장치풀기'].forEach((action, index) => {
    const number = `Q-${index + 1}`;
    assert.equal(ok(dir, ...permit('T-1', { 행동: action })), `허락: ${number} [대기] T-1 ${action} 옛 열을 지울까요  (추천: 둔다)`);
    assert.match(refused(dir, '시작', 'T-1'), new RegExp(`T-1 시작 거절: 답을 기다리는 질문 ${number}`));
    assert.match(ok(dir, '다음'), /^T-2 /);
    assert.match(ok(dir, '준비'), /같이 시작해도 되는 작업:\nT-2 [^\n]*\n미룬 작업:\nT-1 답을 기다리는/);
    ok(dir, '답', number, '둔다');
  });
  ok(dir, '시작', 'T-2');
  ok(dir, '시작', 'T-1');
  ok(dir, ...permit('T-1'));
  assert.match(refused(dir, ...submit(dir)), /T-1 올림 거절: 답을 기다리는 질문 Q-6/);
  ok(dir, '답', 'Q-6', '둔다');
  ok(dir, ...submit(dir));
  ok(dir, ...permit('T-1'));
  assert.match(refused(dir, '완료', 'T-1'), /T-1 완료 거절: 답을 기다리는 질문 Q-7/);
  ok(dir, '답', 'Q-7', '지운다');
  ok(dir, '완료', 'T-1');
});

test('확인 waits as 확인중 and never holds the task, whatever the answer', t => {
  const dir = twoTasks(t);
  assert.equal(ok(dir, ...confirm('T-1')), '확인: Q-1 [확인중] T-1 설계확인(문서충돌) 어느 문서를 따를까요  (추천: 둔다)');
  assert.match(ok(dir, '다음'), /^T-1 /);
  assert.match(ok(dir, '준비'), /같이 시작해도 되는 작업:\nT-1 [^\n]*\nT-2 /);
  assert.match(ok(dir, '질문목록', '--상태', '확인중'), /^Q-1 \[확인중\] T-1 설계확인\(문서충돌\) 어느 문서를 따를까요  \(추천: 둔다\)$/);
  ok(dir, '시작', 'T-1');
  ok(dir, ...confirm('T-1', { 까닭: '실데이터' }));
  ok(dir, ...confirm('T-1', { 까닭: '구조변경' }));
  assert.equal(ok(dir, '답', 'Q-1', '둔다'), '답: Q-1 [답함] T-1 설계확인(문서충돌) 어느 문서를 따를까요  → 둔다');
  assert.equal(ok(dir, '답', 'Q-2', '지운다'), '답: Q-2 [고칠것] T-1 설계확인(실데이터) 어느 문서를 따를까요  → 지운다');
  assert.match(ok(dir, '답', 'Q-3', '--직접', '다른 길로 간다'), /^답: Q-3 \[고칠것\] .*→ 다른 길로 간다$/);
  assert.match(ok(dir, '질문목록', '--상태', '고칠것'), /^Q-2 \[고칠것\][^\n]*\nQ-3 \[고칠것\]/);
  assert.match(refused(dir, '답', 'Q-2', '둔다'), /Q-2 답 거절: 이미 답했다\(지운다\)/);
  ok(dir, ...submit(dir));
  ok(dir, ...confirm('T-1'));
  ok(dir, '완료', 'T-1');
  assert.deepEqual(ledgerOf(dir).질문.map(item => item.상태), ['답함', '고칠것', '고칠것', '확인중']);
});

test('an unanswered 확인 counts as settled after three days: listed as 확정, answers refused, nothing stored', t => {
  const dir = twoTasks(t);
  ok(dir, ...confirm('T-1'));
  ok(dir, ...confirm('T-1', {}, '둘째'));
  const now = Date.now();
  rewrite(dir, book => {
    book.질문[0].만든시각 = new Date(now - 73 * HOUR).toISOString();
    book.질문[1].만든시각 = new Date(now - 71 * HOUR).toISOString();
  });
  assert.match(ok(dir, '질문목록', '--상태', '확정'), /^Q-1 \[확정\] T-1 설계확인\(문서충돌\) 어느 문서를 따를까요  \(추천: 둔다\)$/);
  assert.match(ok(dir, '보기', 'T-1'), /^질문: Q-1 \[확정\]/m);
  assert.match(refused(dir, '답', 'Q-1', '둔다'), /Q-1 답 거절: 기한\(3일\)이 지나 확정됐다/);
  assert.match(refused(dir, '답', 'Q-1', '--직접', '글'), /확정됐다/);
  assert.equal(ledgerOf(dir).질문[0].상태, '확인중', 'settling is worked out when read, not stored');
  assert.match(ok(dir, '질문목록', '--상태', '확인중'), /^Q-2 \[확인중\] T-1 설계확인\(문서충돌\) 둘째/);
  assert.match(ok(dir, '답', 'Q-2', '지운다'), /^답: Q-2 \[고칠것\]/);
});

test('기록 keeps what the AI decided with the time it was written', t => {
  const dir = twoTasks(t);
  const before = Date.now();
  assert.equal(ok(dir, ...record('기록', 'T-1')), '기록: T-1 표준 Date를 쓴다');
  const [item] = ledgerOf(dir).처리함;
  assert.deepEqual(Object.keys(item), ['작업', '제목', '설명', '이유', '만든시각']);
  assert.equal(new Date(item.만든시각).toISOString(), item.만든시각);
  assert.ok(Date.parse(item.만든시각) >= before - 1000);
});

test('the old names make the same entries: 질문 as 허락 or 확인 by its action, 처리함 as 기록', t => {
  const dir = twoTasks(t);
  const same = ({ 번호, 만든시각, ...item }) => item;
  assert.match(ok(dir, ...permit('T-1')), /^허락: Q-1 \[대기\]/);
  assert.match(ok(dir, ...args('질문', 'T-1', '옛 열을 지울까요', { 행동: '삭제', ...COMMON })), /^허락: Q-2 \[대기\]/);
  assert.match(ok(dir, ...confirm('T-1')), /^확인: Q-3 \[확인중\]/);
  assert.match(ok(dir, ...args('질문', 'T-1', '어느 문서를 따를까요', { 행동: '설계확인', 까닭: '문서충돌', ...COMMON })), /^확인: Q-4 \[확인중\]/);
  assert.equal(ok(dir, ...record('처리함', 'T-1')), '기록: T-1 표준 Date를 쓴다');
  ok(dir, ...record('기록', 'T-1'));
  const book = ledgerOf(dir);
  const [permitted, asked, confirmed, askedDesign] = book.질문.map(same);
  assert.deepEqual(asked, permitted);
  assert.deepEqual(askedDesign, confirmed);
  assert.deepEqual(same(book.처리함[0]), same(book.처리함[1]));
});

test('an old ledger without question lists, or with records that have no time, is read and added to', t => {
  const dir = repo(t);
  const old = {
    다음번호: 2,
    작업: [{ 번호: 'T-1', 제목: '옛 작업', 종류: '기능', 상태: '할일', 영역: ['src'], 확인방법: 'npm test', 선행: [] }],
    처리함: [{ 작업: 'T-1', 제목: '옛 기록', 설명: '예전', 이유: '그때' }],
  };
  fs.writeFileSync(path.join(dir, 'harness/backlog.json'), `${JSON.stringify(old)}\n`);
  assert.match(ok(dir, '다음'), /^T-1 /);
  ok(dir, ...record('기록', 'T-1'));
  assert.match(ok(dir, ...confirm('T-1')), /^확인: Q-1 \[확인중\]/);
  const book = ledgerOf(dir);
  assert.deepEqual(book.처리함[0], old.처리함[0]);
  assert.equal(book.처리함.length, 2);
  assert.equal(book.질문.length, 1);
});

test('wrong 허락, 확인, 기록 and old 질문 calls are refused and leave the ledger as it was', t => {
  const dir = twoTasks(t);
  ok(dir, ...record('기록', 'T-1'));
  assert.match(refused(dir, ...permit('T-1', { 행동: '설계확인' })), /허락 거절: 설계확인은 확인 명령으로 묻는다/);
  assert.match(refused(dir, ...permit('T-1', { 행동: '정하기' })), /--행동은 삭제, 약속변경, 외부발행, 결제, 장치풀기 중 하나다/);
  assert.match(refused(dir, ...permit('T-1', { 까닭: '문서충돌' })), /허락 거절: --까닭은\(는\) 이 명령에서 쓰지 않는다/);
  assert.match(refused(dir, ...confirm('T-1', { 행동: '삭제' })), /확인 거절: --행동은\(는\) 이 명령에서 쓰지 않는다/);
  assert.match(refused(dir, ...confirm('T-1', { 까닭: null })), /확인 거절: --까닭이\(가\) 비어 있다/);
  assert.match(refused(dir, ...confirm('T-1', { 까닭: '기타' })), /확인 거절: --까닭은 문서충돌, 실데이터, 구조변경 중 하나로/);
  assert.match(refused(dir, ...record('기록', 'T-1', { 설명: null })), /기록 거절: --설명이\(가\) 비어 있다/);
  assert.match(refused(dir, ...record('기록', 'T-1', { 이유: null })), /기록 거절: --이유이\(가\) 비어 있다/);
  const ask = change => args('질문', 'T-1', '제목', { 행동: '삭제', ...COMMON }, change);
  assert.match(refused(dir, ...ask({ 행동: '정하기' })), /질문 거절: --행동은 삭제, 약속변경, 외부발행, 결제, 장치풀기, 설계확인 중 하나다. 이 여섯에 들지 않으면 AI가 정하고 기록으로/);
  assert.match(refused(dir, ...ask({ 까닭: '문서충돌' })), /질문 거절: --까닭은 --행동 설계확인일 때만 적는다/);
  assert.equal(ledgerOf(dir).질문.length, 0);
});
