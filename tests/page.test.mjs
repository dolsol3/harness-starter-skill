// 기록의 날짜와 확인 기한은 이 컴퓨터 시간대로 보이므로 시간대를 고정한다(Node는 실행 중 바꾼 TZ를 따른다).
process.env.TZ = 'Asia/Seoul';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo, ok, backlog } from './helpers.mjs';
import { render } from '../templates/harness/page.mjs';

const at = new Date('2026-10-10T03:00:00Z');
const choices = [{ 이름: '지운다', 결과: '열이 사라진다' }, { 이름: '둔다', 결과: '그대로 남는다' }];
const question = (change = {}) => ({
  번호: 'Q-1', 작업: 'T-1', 제목: '열을 지울까요', 행동: '삭제', 설명: '쓰지 않는 열이다', 보기: choices, 추천: '둔다', 이유: '되돌릴 수 없다',
  상태: '대기', 만든시각: '2026-10-10T01:00:00.000Z', ...change,
});
const task = (change = {}) => ({ 번호: 'T-1', 제목: '일', 종류: '기능', 상태: '할일', 영역: ['src'], 확인방법: 'npm test', 선행: [], ...change });
const book = (change = {}) => ({ 다음번호: 2, 작업: [task()], 다음질문번호: 2, 질문: [], 처리함: [], ...change });
const check = (change = {}) => question({ 번호: 'Q-5', 제목: '어느 문서를 따를까요', 행동: '설계확인', 까닭: '문서충돌', 상태: '확인중', ...change });
const hours = n => new Date(Date.parse('2026-10-10T01:00:00.000Z') + n * 3600 * 1000);
const pageFile = dir => path.join(dir, 'harness/questions.html');
const inOrder = (html, titles) => {
  const order = titles.map(title => html.indexOf(title));
  assert.ok(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `order of ${titles}: ${order}`);
};
const section = (html, id) => html.slice(html.indexOf(`<h2 id="${id}">`), html.indexOf('<h2', html.indexOf(`<h2 id="${id}">`) + 1));

test('the page goes permit, confirm, fix, answered, records, patched, progress, each with its count', () => {
  const html = render(book({
    질문: [
      question(), check(), question({ 번호: 'Q-6', 상태: '고칠것', 답: '지운다' }),
      question({ 번호: 'Q-2', 제목: '이미 정했다', 상태: '답함', 답: '둔다' }),
      check({ 번호: 'Q-4', 제목: '고쳐서 반영함', 상태: '반영함', 답: '지운다', 커밋: 'abc123', 반영설명: 'docs/24 보관기간 절' }),
      question({ 번호: 'Q-3', 상태: '답함', 답: '글로 적음', 직접: true }),
      check({ 번호: 'Q-8', 제목: '직접 적어 반영함', 상태: '반영함', 답: '직접 답', 직접: true, 커밋: 'def456', 반영설명: 'src/a.js 반영' }),
    ],
    처리함: [{ 작업: 'T-1', 제목: '날짜 라이브러리는 쓰지 않는다', 설명: '표준 Date로 충분하다', 이유: '의존을 늘리지 않으려고' }],
  }), hours(2));
  inOrder(html, ['허락할 것 1개', '확인할 것 1개', '고칠 것 1개', '답한 것 4개', '기록 1개', '덧댄 곳 0개', '진행 현황']);
  const answered = section(html, 'answered');
  inOrder(answered, ['Q-2', 'Q-4', 'Q-3', 'Q-8']);
  assert.match(answered, /이미 정했다<\/td><td>→ <b>둔다<\/b><\/td>/);
  assert.match(answered, /고쳐서 반영함<\/td><td>반영됨: <b>지운다<\/b> \(커밋 abc123, docs\/24 보관기간 절\)<\/td>/);
  assert.match(answered, /→ <b>글로 적음<\/b> \(직접 적음\)/);
  assert.match(answered, /직접 적어 반영함<\/td><td>반영됨: <b>직접 답<\/b> \(직접 적음\) \(커밋 def456, src\/a\.js 반영\)<\/td>/);
  assert.equal((answered.match(/\(직접 적음\)/g) ?? []).length, 2, 'only the typed answers are marked');
  assert.match(html, /<title>작업 장부<\/title>/);
});

test('a confirm card shows its reason, that the AI goes on with the pick, the deadline and the answer form, not the permit line', () => {
  const html = section(render(book({ 질문: [check()] }), hours(71)), 'confirm');
  assert.match(html, /<article class="card" data-q="Q-5" data-stamp="2026-10-10T01:00:00\.000Z">/);
  assert.match(html, /<span class="tag">확인<\/span>/);
  assert.match(html, /<b>까닭<\/b> 문서충돌 — 문서끼리 말이 달라 어느 쪽을 따를지 골라야 하는 일/);
  assert.match(html, /AI가 추천한 보기\(<b>둔다<\/b>\)대로 진행하고 있습니다\. <b>기한<\/b> 2026-10-13 10:00까지/);
  assert.match(html, /<input type="radio" name="Q-5" value="지운다">/);
  assert.match(html, /<button type="button">답 보내기<\/button>/);
  assert.doesNotMatch(html, /사람이 정합니다/);
});

test('a confirm past its 3 days leaves the confirm section and is folded as settled on the day it settled', () => {
  const html = render(book({ 질문: [check()] }), hours(73));
  assert.match(html, /<h2 id="confirm">확인할 것 0개<\/h2>/);
  assert.doesNotMatch(html, /data-q="Q-5"/);
  assert.match(section(html, 'records'), /<details><summary>2026-10-13 · 확정 1개<\/summary>[\s\S]*Q-5 · T-1[\s\S]*어느 문서를 따를까요[\s\S]*→ <b>둔다<\/b>[\s\S]*기한이 지나 추천대로 확정/);
});

test('a confirm answered against the pick shows in fix with the pick and the answer and no form', () => {
  const html = section(render(book({
    질문: [
      check({ 상태: '고칠것', 답: '지운다' }),
      check({ 번호: 'Q-7', 상태: '고칠것', 답: '반만', 직접: true }),
      check({ 번호: 'Q-8', 상태: '반영함', 답: '지운다', 커밋: 'abc123', 반영설명: '고침' }),
    ],
  }), at), 'fix');
  assert.match(html, /고칠 것 2개/);
  assert.match(html, /Q-5 · T-1[\s\S]*AI가 진행한 것 <b>둔다<\/b> → 사람의 답 <b>지운다<\/b><\/p>/);
  assert.match(html, /사람의 답 <b>반만<\/b> \(직접 적음\)/);
  assert.match(html, /추천과 다르게 답하신 것 중 AI가 아직 고치지 않은 것입니다\. 고치면 '답한 것'으로 옮겨집니다\./);
  assert.doesNotMatch(html, /Q-8/);
  assert.doesNotMatch(html, /<input|<textarea|<button/);
});

test('records fold by local day, newest day and item first, with the day counts, and undated old records last', () => {
  const html = section(render(book({
    질문: [check()],
    처리함: [
      { 작업: 'T-1', 제목: '옛 기록', 설명: 'a', 이유: 'b' },
      { 작업: 'T-1', 제목: '열하루', 설명: 'a', 이유: 'b', 만든시각: '2026-10-11T03:00:00.000Z' },
      { 작업: 'T-1', 제목: '서울로는 열사흘', 설명: 'a', 이유: 'b', 만든시각: '2026-10-12T16:00:00.000Z' },
      { 작업: 'T-1', 제목: '더 옛 기록', 설명: 'a', 이유: 'b' },
    ],
  }), hours(73)), 'records');
  assert.match(html, /기록 5개/);
  assert.doesNotMatch(html, /<details open/);
  inOrder(html, ['<summary>2026-10-13 · 기록 1개 · 확정 1개</summary>', 'Q-5', '서울로는 열사흘', '<summary>2026-10-11 · 기록 1개</summary>', '열하루',
    '<summary>날짜 없음 · 기록 2개</summary>', '더 옛 기록', '<h3>옛 기록']);
});

test('a permit card (waiting question) shows what each choice leads to, marks the recommended one and says why a person decides', () => {
  const html = render(book({ 질문: [question()] }), at);
  assert.match(html, /<article class="card" data-q="Q-1" data-stamp="2026-10-10T01:00:00\.000Z">/);
  assert.match(html, /<input type="radio" name="Q-1" value="지운다">[\s\S]*고르면: 열이 사라진다/);
  assert.match(html, /<b>둔다<\/b><em>추천<\/em><small>고르면: 그대로 남는다/);
  assert.doesNotMatch(html, /<b>지운다<\/b><em>/);
  assert.match(html, /진짜 데이터를 지우거나 바꾸는 일이라 사람이 정합니다/);
  assert.doesNotMatch(html, /<b>까닭<\/b>/, 'only 설계확인 has a reason line');
  assert.match(html, /추천한 이유<\/b> 되돌릴 수 없다/);
  assert.match(html, /<textarea[^>]*>/);
  assert.doesNotMatch(html, /<input[^>]*checked/, 'nothing is chosen for the person');
});

test('a 설계확인 question card shows the action, what it means, and the chosen reason with its meaning', () => {
  const html = render(book({ 질문: [question({ 행동: '설계확인', 까닭: '실데이터', 설명: '<b>성명</b>' })] }), at);
  assert.match(html, /<span class="tag">설계확인<\/span>/);
  assert.match(html, /설계 중 사람이 확인해야 하는 일\(아래 까닭 셋 중 하나\)이라 사람이 정합니다\.<\/p>\n<p class="why"><b>까닭<\/b> 실데이터 — 실제 데이터·개인정보를 지우거나 남기거나 드러내는 방식을 정하는 일<\/p>/);
  assert.match(html, /<p>&lt;b&gt;성명&lt;\/b&gt;<\/p>/);
});

test('the top tiles count what a person must see and the tasks by state, merge waiting being the submitted ones', () => {
  const tasks = [task(), task({ 번호: 'T-2', 상태: '진행중' }), task({ 번호: 'T-3', 상태: '올림' }), task({ 번호: 'T-4', 상태: '올림' }), task({ 번호: 'T-5', 상태: '완료' })];
  const html = render(book({
    작업: tasks,
    질문: [
      question(), question({ 번호: 'Q-2', 상태: '답함', 답: '둔다' }), check(), check({ 번호: 'Q-6' }),
      check({ 번호: 'Q-7', 상태: '고칠것', 답: '지운다' }), check({ 번호: 'Q-8', 상태: '반영함', 답: '지운다', 커밋: 'abc', 반영설명: '고침' }),
    ],
  }), at);
  const tiles = [...html.matchAll(/<a class="tile( hot)?" href="#\w+"><b>(\d+)<\/b>([^<]+)<\/a>/g)].map(match => [match[3], Number(match[2]), Boolean(match[1])]);
  assert.match(html, /<details><summary>완료 1개<\/summary>/);
  assert.match(html, /<h3>병합 대기 \(브랜치에 올렸고 기본 브랜치에 병합되기를 기다림\) 2개<\/h3>/);
  assert.deepEqual(tiles, [['허락할 것', 1, true], ['확인할 것', 2, true], ['고칠 것', 1, true], ['덧댄 곳', 0, false], ['병합 대기', 2, false], ['진행중', 1, false], ['할일', 1, false], ['완료', 1, false]]);
  const none = render(book({ 질문: [check({ 번호: 'Q-8', 상태: '반영함', 답: '지운다', 커밋: 'abc', 반영설명: '고침' })] }), at);
  for (const label of ['허락할 것', '확인할 것', '고칠 것']) assert.match(none, new RegExp(`class="tile" href="#\\w+"><b>0</b>${label}`), `${label} at 0 is not highlighted`);
});

test('the patched files section lists each file with its fix commits, lights its tile, and escapes what git gave', () => {
  const html = render(book(), at, [{ file: 'src/<api>.ts', subjects: ['🐛 로그인 빈 값', '🐛 <b>토큰</b> 만료', 'fix: 다시'] }]);
  assert.match(html, /class="tile hot" href="#patch"><b>1<\/b>덧댄 곳/);
  assert.match(html, /<h2 id="patch">덧댄 곳 1개<\/h2>/);
  assert.match(html, /<td>src\/&lt;api&gt;\.ts<\/td><td>3번<\/td><td>🐛 로그인 빈 값<br>🐛 &lt;b&gt;토큰&lt;\/b&gt; 만료<br>fix: 다시<\/td>/);
  assert.doesNotMatch(html, /<b>토큰<\/b>/);
  assert.match(render(book(), at), /<h2 id="patch">덧댄 곳 0개<\/h2>[\s\S]*지금 없습니다\./);
});

test('the progress table shows the area and the tools, and marks a task with a waiting question', () => {
  const html = render(book({ 작업: [task({ 영역: ['src', 'docs'], 배정: 'claude', 검토: 'codex' })], 질문: [question()] }), at);
  assert.match(html, /<td>일 <span class="tag">Q-1 답 대기<\/span><\/td><td>src, docs<\/td><td>배정 claude, 검토 codex<\/td>/);
  assert.doesNotMatch(render(book({ 질문: [question({ 상태: '답함', 답: '둔다' })] }), at), /답 대기/);
});

test('everything written in the ledger is escaped so it cannot run as code in the page', () => {
  const evil = '<script>alert(1)</script>"\'&';
  const html = render(book({
    작업: [task({ 제목: evil, 영역: [evil], 배정: evil, 검토: evil })],
    질문: [
      question({ 제목: evil, 설명: evil, 이유: evil, 보기: [{ 이름: evil, 결과: evil }, { 이름: 'b', 결과: evil }], 추천: evil }),
      question({ 번호: 'Q-2', 상태: '답함', 답: evil, 직접: true }),
      check({ 번호: evil, 작업: evil, 제목: evil, 설명: evil, 이유: evil, 보기: [{ 이름: evil, 결과: evil }], 추천: evil }),
      check({ 번호: 'Q-6', 작업: evil, 제목: evil, 상태: '고칠것', 추천: evil, 답: evil }),
      check({ 번호: 'Q-8', 작업: evil, 제목: evil, 상태: '반영함', 추천: evil, 답: evil, 커밋: evil, 반영설명: evil }),
      check({ 번호: 'Q-7', 작업: evil, 제목: evil, 추천: evil, 만든시각: '2026-10-01T01:00:00.000Z' }),
    ],
    처리함: [{ 작업: evil, 제목: evil, 설명: evil, 이유: evil }, { 작업: evil, 제목: evil, 설명: evil, 이유: evil, 만든시각: '2026-10-09T01:00:00.000Z' }],
  }), at);
  const scripts = html.match(/<script>/g) ?? [];
  assert.equal(scripts.length, 1, 'only the page\'s own script exists');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp;/);
  assert.doesNotMatch(html, /value="[^"]*<script/);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*<\/script>/, ''), /<script|alert\(1\)<\/script>/, 'no unescaped copy anywhere');
  for (const id of ['permit', 'confirm', 'fix', 'answered', 'records']) assert.match(section(html, id), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, id);
});

test('an empty ledger still gives a page that says there is nothing yet', () => {
  const html = render({ 다음번호: 1, 작업: [], 다음질문번호: 1, 질문: [], 처리함: [] }, at);
  for (const text of ['지금 허락할 것이 없습니다', '지금 확인할 것이 없습니다', '지금 고칠 것이 없습니다', '작업이 아직 없습니다']) assert.match(html, new RegExp(text));
  assert.equal((html.match(/<p class="sub">아직 없습니다\.<\/p>/g) ?? []).length, 2, 'nothing answered and nothing recorded yet');
});

test('every command that writes the ledger rewrites harness/questions.html, and reading commands and refusals do not', t => {
  const dir = repo(t);
  assert.ok(!fs.existsSync(pageFile(dir)));
  ok(dir, '추가', '일');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /진행 현황[\s\S]*할일 1개[\s\S]*<td>일<\/td>/);
  ok(dir, '질문', 'T-1', '열을 지울까요', '--행동', '삭제', '--설명', '쓰지 않는다', '--보기', '지운다=사라진다|둔다=남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /허락할 것 1개[\s\S]*열을 지울까요/);
  ok(dir, '허락', 'T-1', '검사를 끌까요', '--행동', '장치풀기', '--설명', '느리다', '--보기', '끈다=빨라진다|둔다=그대로다', '--추천', '둔다', '--이유', '지키는 장치다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /허락할 것 2개[\s\S]*지키는 장치를 끄거나 넓히는 일\(훅이나 검사를 끄는 것/);
  ok(dir, '답', 'Q-1', '둔다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /답한 것 1개[\s\S]*→ <b>둔다<\/b>/);
  ok(dir, '확인', 'T-1', '보관 기간', '--까닭', '실데이터', '--설명', '동의 보관', '--보기', '2년=2년|영구=영구', '--추천', '2년', '--이유', '기본');
  ok(dir, '답', 'Q-3', '영구');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /고칠 것 1개[\s\S]*보관 기간/);
  ok(dir, '반영', 'Q-3', '--커밋', 'abc123', '--설명', 'docs/24 보관기간 절');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /고칠 것 0개[\s\S]*답한 것 2개[\s\S]*반영됨: <b>영구<\/b> \(커밋 abc123, docs\/24 보관기간 절\)/);
  ok(dir, '처리함', 'T-1', '표준 Date를 쓴다', '--설명', '충분하다', '--이유', '의존을 줄인다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /기록 1개[\s\S]*<summary>\d{4}-\d\d-\d\d · 기록 1개<\/summary>[\s\S]*표준 Date를 쓴다/);
  fs.rmSync(pageFile(dir));
  ok(dir, '질문목록', '--상태', '답함');
  assert.ok(fs.existsSync(pageFile(dir)), '질문목록 writes the ledger to clear the new-answer marks, so it rewrites the page too');
  fs.rmSync(pageFile(dir));
  ok(dir, '목록');
  ok(dir, '보기', 'T-1');
  assert.ok(!fs.existsSync(pageFile(dir)), 'reading does not write the page');
  fs.writeFileSync(pageFile(dir), 'old');
  assert.equal(backlog(dir, '시작', 'T-9').status, 1);
  assert.equal(backlog(dir, '반영', 'Q-3', '--커밋', 'def456', '--설명', '다시').status, 1);
  assert.equal(fs.readFileSync(pageFile(dir), 'utf8'), 'old', 'a refused command does not rewrite the page');
  assert.equal(ok(dir, '목록'), 'T-1 [할일] 기능 일');
});

test('the page has no outside files: no links, no stylesheets, no remote scripts', () => {
  const html = render(book({ 질문: [question()] }), at);
  assert.doesNotMatch(html, /<link |src=|https?:\/\//);
});
