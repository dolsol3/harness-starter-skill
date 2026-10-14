import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo, ok, refused, rewrite } from './helpers.mjs';

// 질문 명령의 인자. change로 칸을 바꾸고, 값이 null인 칸은 아예 적지 않는다.
const ask = (task, title = '운영 DB의 옛 열을 지울까요', change = {}) => {
  const fields = {
    행동: '삭제', 설명: '쓰지 않는 열이다', 보기: '지운다=열이 사라진다|둔다=그대로 남는다', 추천: '둔다', 이유: '되돌릴 수 없다', ...change,
  };
  return ['질문', task, title, ...Object.entries(fields).filter(([, value]) => value !== null).flatMap(([name, value]) => [`--${name}`, value])];
};
const START = ['--영역', 'src', '--확인방법', 'npm test'];
const head = dir => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));

test('질문 records a question for a task and shows it in the list and in the task view', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  assert.equal(ok(dir, ...ask('T-1')), '허락: Q-1 [대기] T-1 삭제 운영 DB의 옛 열을 지울까요  (추천: 둔다)');
  assert.match(ok(dir, '질문목록'), /^Q-1 \[대기\] T-1 삭제 .*\(추천: 둔다\)$/);
  assert.match(ok(dir, '보기', 'T-1'), /^질문: Q-1 \[대기\]/m);
  const [question] = ledgerOf(dir).질문;
  assert.deepEqual(question.보기, [{ 이름: '지운다', 결과: '열이 사라진다' }, { 이름: '둔다', 결과: '그대로 남는다' }]);
  assert.match(question.만든시각, /^\d{4}-\d\d-\d\dT/);
  assert.match(ok(dir, ...ask('T-1', '또 하나')), /^허락: Q-2 /);
});

test('질문 refuses when something the page needs is missing or wrong, and leaves the ledger as it was', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  for (const name of ['행동', '설명', '보기', '추천', '이유']) {
    assert.match(refused(dir, ...ask('T-1', '제목', { [name]: null })), new RegExp(`--${name}이\\(가\\) 비어 있다`));
  }
  assert.match(refused(dir, ...ask('T-1', '')), /제목이 없다/);
  assert.match(refused(dir, ...ask('T-9')), /T-9: 그런 작업이 없다/);
  assert.match(refused(dir, ...ask('T-1', '제목', { 행동: '정하기' })), /--행동은 삭제, 약속변경, 외부발행, 결제, 장치풀기, 설계확인 중 하나다.*기록/);
  assert.match(refused(dir, ...ask('T-1', '제목', { 추천: '모름' })), /--추천 모름은\(는\) 보기에 없다\(지운다, 둔다\)/);
  for (const bad of ['지운다=사라진다', '지운다|둔다', '지운다=사라진다|둔다=', '지운다=사라진다|지운다=또', '=사라진다|둔다=남는다']) {
    assert.match(refused(dir, ...ask('T-1', '제목', { 보기: bad })), /--보기는 "이름=결과\|이름=결과"로 둘 이상/, bad);
  }
});

const DESIGN = { 행동: '설계확인', 까닭: '문서충돌' };

test('설계확인 takes one of three reasons, shows it next to the action, and keeps it only on that question', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  assert.equal(ok(dir, ...ask('T-1', '어느 문서를 따를까요', DESIGN)), '확인: Q-1 [확인중] T-1 설계확인(문서충돌) 어느 문서를 따를까요  (추천: 둔다)');
  assert.match(ok(dir, ...ask('T-1', '성명을 남길까요', { ...DESIGN, 까닭: '실데이터' })), /^확인: Q-2 \[확인중\] T-1 설계확인\(실데이터\) /);
  assert.match(ok(dir, ...ask('T-1', '라이브러리를 들일까요', { ...DESIGN, 까닭: '구조변경' })), /^확인: Q-3 \[확인중\] T-1 설계확인\(구조변경\) /);
  ok(dir, ...ask('T-1', '옛 열'));
  assert.match(ok(dir, '보기', 'T-1'), /^질문: Q-1 \[확인중\] T-1 설계확인\(문서충돌\) /m);
  assert.deepEqual(ledgerOf(dir).질문.map(item => item.까닭), ['문서충돌', '실데이터', '구조변경', undefined]);
  assert.match(ok(dir, '질문목록'), /^Q-4 \[대기\] T-1 삭제 옛 열  \(추천: 둔다\)$/m);
});

test('설계확인 without a reason or with another one, and a reason on another action, are refused and use no number', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  assert.match(refused(dir, ...ask('T-1', '제목', { 행동: '설계확인' })), /확인 거절: --까닭이\(가\) 비어 있다/);
  assert.match(refused(dir, ...ask('T-1', '제목', { ...DESIGN, 까닭: '기타' })), /--까닭은 문서충돌, 실데이터, 구조변경 중 하나로/);
  assert.match(refused(dir, ...ask('T-1', '제목', { 까닭: '문서충돌' })), /--까닭은 --행동 설계확인일 때만 적는다/);
  assert.equal(ok(dir, '질문목록', '--상태', '확인중'), '확인중 질문이 없다');
  assert.match(ok(dir, ...ask('T-1', '제목', DESIGN)), /^확인: Q-1 /);
  assert.match(refused(dir, '처리함', 'T-1', '제목', '--설명', '내용', '--이유', '이유', '--까닭', '문서충돌'), /--까닭은\(는\) 이 명령에서 쓰지 않는다/);
});

test('a waiting 설계확인 question left in an old ledger holds only its task until it is answered', t => {
  const dir = repo(t);
  ok(dir, '추가', '막힌 일', '--영역', 'src/a', '--확인방법', 'npm test');
  ok(dir, '추가', '다른 일', '--영역', 'src/b', '--확인방법', 'npm test');
  ok(dir, ...ask('T-1', '어느 문서를 따를까요', DESIGN));
  rewrite(dir, book => { book.질문[0].상태 = '대기'; });
  assert.match(refused(dir, '시작', 'T-1'), /답을 기다리는 질문 Q-1/);
  assert.match(ok(dir, '다음'), /^T-2 /);
  assert.match(ok(dir, '준비'), /같이 시작해도 되는 작업:\nT-2 /);
  ok(dir, '시작', 'T-2');
  ok(dir, '답', 'Q-1', '둔다');
  ok(dir, '시작', 'T-1');
});

test('a task with a question waiting is left out of 다음 and 준비 and cannot be started, while other tasks go on', t => {
  const dir = repo(t);
  ok(dir, '추가', '막힌 일', '--영역', 'src/a', '--확인방법', 'npm test');
  ok(dir, '추가', '다른 일', '--영역', 'src/b', '--확인방법', 'npm test');
  ok(dir, ...ask('T-1'));
  assert.match(refused(dir, '시작', 'T-1'), /T-1 시작 거절: 답을 기다리는 질문 Q-1이\(가\) 있다/);
  assert.match(ok(dir, '다음'), /^T-2 /);
  const ready = ok(dir, '준비');
  assert.match(ready, /같이 시작해도 되는 작업:\nT-2 /);
  assert.match(ready, /미룬 작업:\nT-1 답을 기다리는 질문 Q-1이\(가\) 있다/);
  ok(dir, '시작', 'T-2');
  ok(dir, '답', 'Q-1', '둔다');
  assert.match(ok(dir, '다음'), /^T-1 /);
  ok(dir, '시작', 'T-1');
});

test('a question stops a running task from being submitted and a submitted one from being finished', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, '시작', 'T-1', ...START);
  ok(dir, ...ask('T-1'));
  const submit = ['올림', 'T-1', '--커밋', head(dir), '--증거', '통과'];
  assert.match(refused(dir, ...submit), /T-1 올림 거절: 답을 기다리는 질문 Q-1이\(가\) 있다/);
  ok(dir, '답', 'Q-1', '지운다');
  ok(dir, ...submit);
  ok(dir, ...ask('T-1', '병합 전에 또 있다'));
  assert.match(refused(dir, '완료', 'T-1'), /T-1 완료 거절: 답을 기다리는 질문 Q-2이\(가\) 있다/);
  ok(dir, '답', 'Q-2', '둔다');
  ok(dir, '완료', 'T-1');
});

test('답 takes a listed choice or the person\'s own words, only once, and only for the same question', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  ok(dir, ...ask('T-1'));
  ok(dir, ...ask('T-1', '둘째'));
  assert.match(refused(dir, '답', 'Q-9', '둔다'), /Q-9: 그런 질문이 없다/);
  assert.match(refused(dir, '답', 'Q-1', '모름'), /모름은\(는\) 보기에 없다\(지운다, 둔다\)/);
  assert.match(refused(dir, '답', 'Q-1'), /보기 이름 하나나 --직접 "글" 중 하나만/);
  assert.match(refused(dir, '답', 'Q-1', '둔다', '--직접', '글'), /보기 이름 하나나 --직접 "글" 중 하나만/);
  assert.match(refused(dir, '답', 'Q-1', '둔다', '--만든시각', '2000-01-01T00:00:00.000Z'), /다른 질문이다/);
  const stamp = ledgerOf(dir).질문[0].만든시각;
  assert.equal(ok(dir, '답', 'Q-1', '둔다', '--만든시각', stamp), '답: Q-1 [답함] T-1 삭제 운영 DB의 옛 열을 지울까요  → 둔다');
  assert.match(refused(dir, '답', 'Q-1', '지운다'), /Q-1 답 거절: 이미 답했다\(둔다\)/);
  ok(dir, '답', 'Q-2', '--직접', '이번 주는 미룬다');
  const [first, second] = ledgerOf(dir).질문;
  assert.equal(first.직접, undefined);
  assert.deepEqual([second.상태, second.답, second.직접], ['답함', '이번 주는 미룬다', true]);
});

test('질문목록 shows the waiting ones by default and the answered ones with --상태 답함', t => {
  const dir = repo(t);
  assert.equal(ok(dir, '질문목록'), '대기 질문이 없다');
  ok(dir, '추가', '일');
  ok(dir, ...ask('T-1'));
  ok(dir, ...ask('T-1', '둘째'));
  ok(dir, '답', 'Q-1', '둔다');
  assert.match(ok(dir, '질문목록'), /^Q-2 \[대기\]/);
  assert.equal(ok(dir, '질문목록').split('\n').length, 1);
  assert.match(ok(dir, '질문목록', '--상태', '답함'), /^Q-1 \[답함\] .*→ 둔다$/);
});

test('처리함 keeps what the AI decided on its own, with the reason, and needs a task and both texts', t => {
  const dir = repo(t);
  ok(dir, '추가', '일');
  assert.equal(ok(dir, '처리함', 'T-1', '날짜 라이브러리는 쓰지 않는다', '--설명', '표준 Date로 충분하다', '--이유', '의존을 늘리지 않으려고'), '기록: T-1 날짜 라이브러리는 쓰지 않는다');
  const [{ 만든시각, ...item }] = ledgerOf(dir).처리함;
  assert.match(만든시각, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(item, { 작업: 'T-1', 제목: '날짜 라이브러리는 쓰지 않는다', 설명: '표준 Date로 충분하다', 이유: '의존을 늘리지 않으려고' });
  assert.match(refused(dir, '처리함', 'T-1', '제목', '--설명', '내용'), /--이유이\(가\) 비어 있다/);
  assert.match(refused(dir, '처리함', 'T-1', '제목', '--이유', '까닭'), /--설명이\(가\) 비어 있다/);
  assert.match(refused(dir, '처리함', 'T-1', '', '--설명', '내용', '--이유', '까닭'), /제목이 없다/);
  assert.match(refused(dir, '처리함', 'T-9', '제목', '--설명', '내용', '--이유', '까닭'), /T-9: 그런 작업이 없다/);
  assert.match(refused(dir, '처리함', 'T-1', '제목', '--행동', '삭제'), /--행동은\(는\) 이 명령에서 쓰지 않는다/);
});

test('a ledger written before questions existed still works and gets empty question lists', t => {
  const dir = repo(t);
  const file = path.join(dir, 'harness/backlog.json');
  const old = { 다음번호: 2, 작업: [{ 번호: 'T-1', 제목: '옛 작업', 종류: '기능', 상태: '할일', 영역: ['src'], 확인방법: 'npm test', 선행: [] }] };
  fs.writeFileSync(file, `${JSON.stringify(old)}\n`);
  assert.equal(ok(dir, '질문목록'), '대기 질문이 없다');
  assert.match(ok(dir, '다음'), /^T-1 /);
  ok(dir, ...ask('T-1'));
  assert.deepEqual(Object.keys(ledgerOf(dir)).sort(), ['다음번호', '다음질문번호', '작업', '질문', '처리함']);
});
