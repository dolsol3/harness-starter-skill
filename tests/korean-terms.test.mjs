import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, ok, refused, rewrite } from './helpers.mjs';
import { render } from '../templates/harness/page.mjs';

const templateConfig = fileURLToPath(new URL('../templates/harness/config.json', import.meta.url));
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function setConfig(dir, extra) {
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
}

test('추가 takes --고칠곳 and --먼저할일, and 바로할일 reports ready and deferred tasks in Korean terms', t => {
  const dir = repo(t);
  assert.match(ok(dir, '추가', '기반', '--고칠곳', 'src/core', '--확인방법', 'npm test'), /추가: T-1 \[할일\] 기능 기반/);
  assert.match(ok(dir, '추가', '화면', '--고칠곳', 'src/ui', '--먼저할일', 'T-1', '--확인방법', 'npm test'), /추가: T-2 \[할일\] 기능 화면/);
  ok(dir, '추가', '겹침', '--고칠곳', 'src/core/sub');
  ok(dir, '추가', '빈칸');

  assert.equal(ok(dir, '바로할일'), [
    '같이 시작해도 되는 작업:',
    'T-1 [할일] 기능 기반  고칠곳: src/core  막는 작업 1개',
    '미룬 작업:',
    'T-2 먼저할일 작업 T-1이(가) 완료되지 않았다',
    'T-3 고칠곳이 겹친다 (T-1의 src/core)',
    'T-4 고칠곳이 비어 있다',
  ].join('\n'));
  assert.match(ok(dir, '준비'), /영역: src\/core[\s\S]*T-2 선행 작업 T-1이\(가\) 완료되지 않았다/);
});

test('일감목록 config keys, 시작 --맡길곳, 보기 dual labels, and 시작 refusal messages work', t => {
  const dir = repo(t);
  setConfig(dir, {
    일감목록: { 동시상한: { claude: 2, codex: 1 }, 기본맡길곳: 'claude', 출력줄수: 50, 기본브랜치: 'main' },
  });
  ok(dir, '추가', '기반', '--고칠곳', 'src/core', '--확인방법', 'npm test');
  ok(dir, '추가', '화면', '--고칠곳', 'src/ui', '--먼저할일', 'T-1', '--확인방법', 'npm test');
  ok(dir, '추가', '빈칸');

  assert.match(refused(dir, '시작', 'T-3'), /영역, 확인방법이\(가\) 비어 있다\. --고칠곳\(--영역\) --확인방법로 채운다/);
  assert.match(refused(dir, '시작', 'T-2'), /먼저할일\(선행 작업 T-1\)이\(가\) 완료되지 않았다/);

  assert.match(ok(dir, '시작', 'T-1', '--맡길곳', 'claude'), /시작: T-1 \[진행중\] 기능 기반/);
  const detail1 = ok(dir, '보기', 'T-1');
  assert.match(detail1, /고칠곳 · 영역: src\/core/);
  assert.match(detail1, /맡길곳 · 배정: claude/);
  assert.match(ok(dir, '보기', 'T-2'), /먼저할일 · 선행: T-1/);

  ok(dir, '시작', 'T-3', '--고칠곳', 'src/other', '--확인방법', 'npm test');
  assert.match(ok(dir, '보기', 'T-3'), /맡길곳 · 배정: claude/, '기본맡길곳 fills in when --맡길곳 is omitted');

  setConfig(dir, { 일감목록: { 한도: { claude: 2 }, 출력줄수: 2 } });
  ok(dir, '추가', '넷째', '--고칠곳', 'src/four', '--확인방법', 'npm test');
  assert.match(refused(dir, '시작', 'T-4'), /맡길곳\(배정할 도구가 없다\)/);
  assert.match(ok(dir, '목록'), /… 2줄 더 있다/);
});

test('다시하기 returns an 올림 task to 진행중 and refuses non-올림 tasks or missing --사유 with 다시하기 거절', t => {
  const dir = repo(t);
  ok(dir, '추가', '기반', '--고칠곳', 'src/core', '--확인방법', 'npm test');
  assert.match(refused(dir, '다시하기', 'T-1', '--사유', '보완 필요'), /T-1 다시하기 거절: 올림 상태만 돌려보낸다\(지금 할일\)/);
  ok(dir, '시작', 'T-1');
  assert.match(refused(dir, '다시하기', 'T-1', '--사유', '보완 필요'), /T-1 다시하기 거절: 올림 상태만 돌려보낸다\(지금 진행중\)/);

  ok(dir, '올림', 'T-1', '--커밋', 'HEAD', '--증거', '첫 증거');
  assert.match(refused(dir, '다시하기', 'T-1'), /T-1 다시하기 거절: --사유가 필요하다/);
  assert.match(ok(dir, '다시하기', 'T-1', '--사유', '보완 필요'), /^다시하기: T-1 \[진행중\] 기능 기반$/);
  assert.match(ok(dir, '보기', 'T-1'), /반려: [0-9a-f]{7} 보완 필요/);
});

test('덧대기 and 지키는파일 Korean config keys and external Korean task fields work', t => {
  const dir = repo(t);
  setConfig(dir, {
    kinds: { code: { files: ['src/**'], maxFileLines: 300 } },
    덧대기: { 횟수: 2, 최근커밋: 5, 수정패턴: '^고침:' },
    지키는파일: ['secret.txt'],
  });
  git(dir, 'commit', '-qam', '설정');
  for (const msg of ['고침: 하나', '고침: 둘']) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.appendFileSync(path.join(dir, 'src/a.js'), 'x\n');
    git(dir, 'add', 'src/a.js');
    git(dir, 'commit', '-q', '-m', msg);
  }

  const guardHook = file => spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--hook'], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, file) } }),
    encoding: 'utf8',
  });
  const noTask = guardHook('src/a.js');
  assert.equal(noTask.status, 2);
  assert.match(noTask.stderr, /--고칠곳\(--영역\)/);

  ok(dir, '추가', '수정일', '--종류', '수정', '--고칠곳', 'src', '--확인방법', 'npm test', '--원인', '원인', '--방향', '방향');
  assert.match(ok(dir, '시작', 'T-1'), /주의: src\/a\.js은\(는\) 최근 커밋 5개 중 수정 커밋 2번에 들어 있다/);
  assert.equal(guardHook('secret.txt').status, 2);
  assert.equal(guardHook('.env').status, 0, '지키는파일 replaces default protect list');

  rewrite(dir, book => {
    book.작업.push({ 번호: 'T-2', 제목: '외부', 종류: '기능', 상태: '할일', 고칠곳: ['src/ext'], 확인방법: 'npm test', 먼저할일: ['T-1'], 맡길곳: 'claude', 다시하기: [{ 커밋: '1234567', 사유: '옛사유' }] });
  });
  const view = ok(dir, '보기', 'T-2');
  assert.match(view, /고칠곳 · 영역: src\/ext/);
  assert.match(view, /먼저할일 · 선행: T-1/);
  assert.match(view, /맡길곳 · 배정: claude/);
  assert.match(view, /반려: 1234567 옛사유/);
});

test('page.mjs renders 일감 목록 (작업 장부) heading and 고칠곳/맡길곳 headers while keeping <title>작업 장부</title>', () => {
  const html = render({
    다음번호: 3,
    작업: [
      { 번호: 'T-1', 제목: '첫일', 종류: '기능', 상태: '진행중', 영역: ['src/a'], 확인방법: 'npm test', 선행: [], 배정: 'claude', 검토: 'codex' },
      { 번호: 'T-2', 제목: '둘째', 종류: '기능', 상태: '할일', 고칠곳: ['src/b'], 확인방법: 'npm test', 먼저할일: [], 맡길곳: 'gemini' },
    ],
    다음질문번호: 1,
    질문: [],
    처리함: [],
  }, new Date('2026-10-22T00:00:00Z'));
  assert.match(html, /<title>작업 장부<\/title>/);
  assert.match(html, /<h1>일감 목록 \(작업 장부\)<\/h1>/);
  assert.match(html, /<tr><th>번호<\/th><th>제목<\/th><th>고칠곳<\/th><th>맡길곳<\/th><\/tr>/);
  assert.match(html, /<td>첫일<\/td><td>src\/a<\/td><td>배정 claude, 검토 codex<\/td>/);
  assert.match(html, /<td>둘째<\/td><td>src\/b<\/td><td>배정 gemini<\/td>/);
});

test('templates/harness/config.json includes valid 단계모델 defaults for all 11 stages', () => {
  const config = JSON.parse(fs.readFileSync(templateConfig, 'utf8'));
  const stages = ['조사', '쪼개기', '할일적기', '맞춰보기', '만들기', '돌려보기', '번갈아보기', '고치기', '한일적기', '고르기', '올림'];
  assert.deepEqual(Object.keys(config.단계모델), stages);
  assert.deepEqual(config.단계모델.조사, { 모델: 'sonnet', 깊이: 'high', 보조모델: 'gemini-4-argon-high', 최대병렬: 4 });
  assert.deepEqual(config.단계모델.번갈아보기, {
    모델: 'opus',
    깊이: 'high',
    검토도구: 'codex',
    폴백도구: 'gemini',
    폴백모델: 'gemini-4-argon-high',
  });
  assert.deepEqual(config.단계모델.한일적기, { 모델: 'haiku', 깊이: 'medium' });
  assert.equal(config.일감목록, undefined, 'default template keeps tool limits off');
});
