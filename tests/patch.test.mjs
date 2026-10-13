import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo, ok, backlog, refused } from './helpers.mjs';

const KINDS = { notes: { files: ['src/notes/**'] }, code: { files: ['src/**'], maxFileLines: 300 }, scripts: { files: ['app/**'], patterns: true }, docs: { files: ['**/*.md'] } };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// 한도가 정해진 코드 종류(src)와 한도 없는 문서 종류를 가진 임시 저장소. patch 설정은 있으면 config.json에 넣는다.
function project(t, patch) {
  const dir = repo(t);
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), kinds: KINDS, ...(patch && { patch }) }));
  git(dir, 'commit', '-qam', '설정');
  return dir;
}

function commit(dir, subject, ...files) {
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.appendFileSync(path.join(dir, name), 'x\n');
  }
  git(dir, 'add', ...files);
  git(dir, 'commit', '-q', '-m', subject);
}

// 장부를 쓰는 명령을 한 번 불러 페이지를 새로 그리게 하고, 그 페이지를 읽는다.
function page(dir) {
  ok(dir, '추가', '일');
  return fs.readFileSync(path.join(dir, 'harness/questions.html'), 'utf8');
}

test('a file that three fix commits touched is flagged on the page, a file touched twice is not', t => {
  const dir = project(t);
  commit(dir, '🐛 로그인 빈 값', 'src/api.ts', 'src/b.ts');
  commit(dir, 'fix: 토큰 만료', 'src/api.ts', 'src/b.ts');
  commit(dir, 'Fix(api): 다시', 'src/api.ts');
  const html = page(dir);
  assert.match(html, /<h2 id="patch">덧댄 곳 1개<\/h2>/);
  assert.match(html, /<td>src\/api\.ts<\/td><td>3번<\/td><td>Fix\(api\): 다시<br>fix: 토큰 만료<br>🐛 로그인 빈 값<\/td>/);
  assert.doesNotMatch(html, /src\/b\.ts/);
  assert.match(html, /class="tile hot" href="#patch"><b>1<\/b>덧댄 곳/);
});

test('the file fixed most often comes first', t => {
  const dir = project(t);
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋', '🐛 넷']) commit(dir, subject, 'src/four.ts');
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'src/three.ts');
  const html = page(dir);
  assert.ok(html.includes('src/four.ts') && html.includes('src/three.ts'));
  assert.ok(html.indexOf('src/four.ts') < html.indexOf('src/three.ts'));
});

test('only fix commits on files of a kind with a limit count, Korean file names included', t => {
  const dir = project(t);
  for (const subject of ['✨ 하나', '✨ 둘', '✨ 셋']) commit(dir, subject, 'src/feature.ts');
  for (const subject of ['fixture 추가', 'fixture 둘', 'fixture 셋']) commit(dir, subject, 'src/fixtures.ts');
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'README.md', 'lib/other.js');
  for (const subject of ['hotfix: 하나', 'docs: fix typo', 'add hotfix']) commit(dir, subject, 'src/hot.ts');
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'src/notes/a.ts');
  assert.match(page(dir), /<h2 id="patch">덧댄 곳 0개<\/h2>/,
    'features, "fixture", fix in the middle of a title, docs, files without a limit and a limitless kind listed first are not patches');
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'src/로그인.ts', 'app/run.ts');
  const html = page(dir);
  assert.match(html, /<td>src\/로그인\.ts<\/td><td>3번<\/td>/);
  assert.match(html, /<td>app\/run\.ts<\/td><td>3번<\/td>/, 'a kind with only forbidden patterns is code too, as for the guard');
});

test('times, lastCommits and fixPattern come from config.json', t => {
  const dir = project(t, { times: 2, lastCommits: 3, fixPattern: '^버그' });
  commit(dir, '버그: 하나', 'src/a.ts');
  commit(dir, '버그: 둘', 'src/a.ts');
  commit(dir, '🐛 패턴에 안 맞는다', 'src/a.ts');
  assert.match(page(dir), /<td>src\/a\.ts<\/td><td>2번<\/td>/, 'two matching commits are enough when times is 2');
  commit(dir, '✨ 다른 일', 'src/other.ts');
  assert.match(page(dir), /덧댄 곳 0개/, 'the first fix is the 4th commit back, outside the last 3');
});

test('starting a fix task whose area overlaps a flagged file warns once per file and still starts it', t => {
  const dir = project(t);
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'src/api.ts');
  const fix = ['--종류', '수정', '--확인방법', 'npm test', '--원인', '빈 값', '--방향', '막는다'];
  ok(dir, '추가', '고침', ...fix, '--영역', 'src/');
  ok(dir, '추가', '다른 곳 고침', ...fix, '--영역', 'docs');
  ok(dir, '추가', '기능', '--확인방법', 'npm test', '--영역', 'src');
  const warned = ok(dir, '시작', 'T-1');
  assert.match(warned, /^시작: T-1 \[진행중\] 수정 고침\n주의: src\/api\.ts은\(는\) 최근 커밋 50개 중 수정 커밋 3번에 들어 있다 \(🐛 셋 \/ 🐛 둘 \/ 🐛 하나\)/);
  assert.equal(warned.split('\n').length, 2);
  assert.doesNotMatch(ok(dir, '시작', 'T-2'), /주의/, 'a fix task elsewhere is not warned');
  assert.doesNotMatch(ok(dir, '시작', 'T-3'), /주의/, 'a feature task is not warned');
});

test('without the base branch there is no signal and the commands still work', t => {
  const dir = project(t);
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, 'src/api.ts');
  git(dir, 'branch', '-m', 'main', 'trunk');
  git(dir, 'tag', 'main');
  assert.match(page(dir), /덧댄 곳 0개/, 'a tag named like the base branch does not stand in for it');
  const task = backlog(dir, '추가', '고침', '--종류', '수정', '--영역', 'src', '--확인방법', 'x', '--원인', 'y', '--방향', 'z');
  assert.equal(task.status, 0, task.stderr);
  assert.equal(backlog(dir, '시작', 'T-2').status, 0);
});

test('file names with quotes, backslashes and tabs are counted as they are', { skip: process.platform === 'win32' && '이 이름은 Windows에서 만들 수 없다' }, t => {
  const dir = project(t);
  const names = ['src/a"b.ts', 'src/back\\d.ts', 'src/tab\tc.ts'];
  for (const subject of ['🐛 하나', '🐛 둘', '🐛 셋']) commit(dir, subject, ...names);
  const html = page(dir);
  for (const name of ['src/a&quot;b.ts', 'src/back\\d.ts', 'src/tab\tc.ts']) assert.ok(html.includes(`<td>${name}</td><td>3번</td>`), name);
});

test('a commit that lists over a megabyte of file names does not stop the commands that write the ledger', t => {
  const dir = project(t);
  // 파일을 만들지 않고 빈 파일 하나를 이름 1,000개로 색인에 넣어 커밋한다(이름 목록이 약 1.2MB)
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, encoding: 'utf8', input: '' }).trim();
  const index = Array.from({ length: 1000 }, (_, i) => `100644 ${blob}\tsrc/${'n'.repeat(1200)}${i}.ts`).join('\n');
  execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: dir, input: index });
  git(dir, 'commit', '-q', '-m', '✨ 처음 가져온 코드');
  assert.match(page(dir), /덧댄 곳 0개/);
  assert.match(ok(dir, '추가', '둘째'), /^추가: T-2/);
});

test('a fixPattern that is not a regular expression stops every command with one line naming the setting, before the ledger is touched', t => {
  const dir = project(t, { fixPattern: '[' });
  for (const command of [['추가', '일'], ['목록'], ['서버']]) {
    assert.match(refused(dir, ...command), /^backlog: config\.json의 patch\.fixPattern이 올바른 정규식이 아니다 \(Invalid regular expression: \/\[\/i: .*\)\n$/, command[0]);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'harness/backlog.json')), 'the refused 추가 saved nothing');
});
