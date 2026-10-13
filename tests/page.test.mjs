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
const pageFile = dir => path.join(dir, 'harness/questions.html');

test('the page puts what the AI decided on its own first, then what the person must decide, then answers and progress', () => {
  const html = render(book({
    질문: [question(), question({ 번호: 'Q-2', 제목: '이미 정했다', 상태: '답함', 답: '둔다' }), question({ 번호: 'Q-3', 상태: '답함', 답: '글로 적음', 직접: true })],
    처리함: [
      { 작업: 'T-1', 제목: '먼저 정한 것', 설명: '설명', 이유: '이유' },
      { 작업: 'T-1', 제목: '날짜 라이브러리는 쓰지 않는다', 설명: '표준 Date로 충분하다', 이유: '의존을 늘리지 않으려고' },
    ],
  }), at);
  assert.ok(html.indexOf('날짜 라이브러리는 쓰지 않는다') < html.indexOf('먼저 정한 것'), 'newest first');
  assert.match(html, /→ <b>글로 적음<\/b> \(직접 적음\)/);
  assert.equal((html.match(/\(직접 적음\)/g) ?? []).length, 1, 'only the typed answer is marked');
  const order = ['알아서 처리한 것 2개', '결정할 것 1개', '답한 것 2개', '진행 현황'].map(title => html.indexOf(title));
  assert.ok(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `section order: ${order}`);
  assert.match(html, /<title>작업 장부<\/title>/);
  assert.match(html, /날짜 라이브러리는 쓰지 않는다[\s\S]*의존을 늘리지 않으려고/);
  assert.match(html, /이미 정했다[\s\S]*→ <b>둔다<\/b>/);
});

test('a waiting question shows what each choice leads to, marks the recommended one and says why a person decides', () => {
  const html = render(book({ 질문: [question()] }), at);
  assert.match(html, /<article class="card" data-q="Q-1" data-stamp="2026-10-10T01:00:00\.000Z">/);
  assert.match(html, /<input type="radio" name="Q-1" value="지운다">[\s\S]*고르면: 열이 사라진다/);
  assert.match(html, /<b>둔다<\/b><em>추천<\/em><small>고르면: 그대로 남는다/);
  assert.doesNotMatch(html, /<b>지운다<\/b><em>/);
  assert.match(html, /진짜 데이터를 지우거나 바꾸는 일이라 사람이 정합니다/);
  assert.match(html, /추천한 이유<\/b> 되돌릴 수 없다/);
  assert.match(html, /<textarea[^>]*>/);
  assert.doesNotMatch(html, /<input[^>]*checked/, 'nothing is chosen for the person');
});

test('the top tiles count the questions waiting and the tasks by state, merge waiting being the submitted ones', () => {
  const tasks = [task(), task({ 번호: 'T-2', 상태: '진행중' }), task({ 번호: 'T-3', 상태: '올림' }), task({ 번호: 'T-4', 상태: '올림' }), task({ 번호: 'T-5', 상태: '완료' })];
  const html = render(book({ 작업: tasks, 질문: [question(), question({ 번호: 'Q-2', 상태: '답함', 답: '둔다' })] }), at);
  const tiles = [...html.matchAll(/<a class="tile( hot)?" href="#\w+"><b>(\d+)<\/b>([^<]+)<\/a>/g)].map(match => [match[3], Number(match[2]), Boolean(match[1])]);
  assert.match(html, /<details><summary>완료 1개<\/summary>/);
  assert.match(html, /<h3>병합 대기 \(브랜치에 올렸고 기본 브랜치에 병합되기를 기다림\) 2개<\/h3>/);
  assert.deepEqual(tiles, [['결정할 것', 1, true], ['덧댄 곳', 0, false], ['병합 대기', 2, false], ['진행중', 1, false], ['할일', 1, false], ['완료', 1, false]]);
  assert.match(render(book(), at), /class="tile" href="#decide"><b>0<\/b>결정할 것/, 'nothing waiting is not highlighted');
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
    ],
    처리함: [{ 작업: 'T-1', 제목: evil, 설명: evil, 이유: evil }],
  }), at);
  const scripts = html.match(/<script>/g) ?? [];
  assert.equal(scripts.length, 1, 'only the page\'s own script exists');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp;/);
  assert.doesNotMatch(html, /value="[^"]*<script/);
});

test('an empty ledger still gives a page that says there is nothing yet', () => {
  const html = render({ 다음번호: 1, 작업: [], 다음질문번호: 1, 질문: [], 처리함: [] }, at);
  assert.match(html, /지금 정할 것이 없습니다/);
  assert.match(html, /작업이 아직 없습니다/);
  assert.equal((html.match(/<p class="sub">아직 없습니다\.<\/p>/g) ?? []).length, 2, 'nothing handled and nothing answered yet');
});

test('every command that writes the ledger rewrites harness/questions.html, and reading commands and refusals do not', t => {
  const dir = repo(t);
  assert.ok(!fs.existsSync(pageFile(dir)));
  ok(dir, '추가', '일');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /진행 현황[\s\S]*할일 1개[\s\S]*<td>일<\/td>/);
  ok(dir, '질문', 'T-1', '열을 지울까요', '--행동', '삭제', '--설명', '쓰지 않는다', '--보기', '지운다=사라진다|둔다=남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /결정할 것 1개[\s\S]*열을 지울까요/);
  ok(dir, '답', 'Q-1', '둔다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /답한 것 1개[\s\S]*→ <b>둔다<\/b>/);
  ok(dir, '처리함', 'T-1', '표준 Date를 쓴다', '--설명', '충분하다', '--이유', '의존을 줄인다');
  assert.match(fs.readFileSync(pageFile(dir), 'utf8'), /알아서 처리한 것 1개[\s\S]*표준 Date를 쓴다/);
  fs.rmSync(pageFile(dir));
  ok(dir, '목록');
  ok(dir, '질문목록');
  assert.ok(!fs.existsSync(pageFile(dir)), 'reading does not write the page');
  fs.writeFileSync(pageFile(dir), 'old');
  assert.equal(backlog(dir, '시작', 'T-9').status, 1);
  assert.equal(fs.readFileSync(pageFile(dir), 'utf8'), 'old', 'a refused command does not rewrite the page');
  assert.equal(ok(dir, '목록'), 'T-1 [할일] 기능 일');
});

test('the page has no outside files: no links, no stylesheets, no remote scripts', () => {
  const html = render(book({ 질문: [question()] }), at);
  assert.doesNotMatch(html, /<link |src=|https?:\/\//);
});
