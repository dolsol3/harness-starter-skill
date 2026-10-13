import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

// 하네스를 넣고 첫 커밋(main)을 한 임시 git 저장소. backlogConfig를 주면 config.json의 backlog 칸이 된다.
function repo(t, backlogConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delegation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  if (backlogConfig) {
    const file = path.join(dir, 'harness/config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), backlog: backlogConfig }));
  }
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'harness/backlog.json\nharness/backlog.lock\nharness/questions.html\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

function backlog(dir, ...args) {
  return spawnSync(process.execPath, [path.join(dir, 'harness/backlog.mjs'), ...args], { cwd: dir, encoding: 'utf8' });
}

function ok(dir, ...args) {
  const result = backlog(dir, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// 거절돼야 하는 명령의 오류 글. 거절하면 장부 파일은 전과 똑같아야 한다.
function refused(dir, ...args) {
  const file = path.join(dir, 'harness/backlog.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const result = backlog(dir, ...args);
  assert.equal(result.status, 1, `거절돼야 한다: ${args.join(' ')}\n${result.stdout}`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'a refused command leaves the ledger as it was');
  return result.stderr;
}

const CHECK = ['--확인방법', 'npm test'];

test('준비 picks tasks that do not touch the same area, the ones blocking most first, and says why it put off the rest', t => {
  const dir = repo(t);
  ok(dir, '추가', '알림', '--영역', 'src/core/notify.js');
  ok(dir, '추가', '결제', '--영역', 'src/pay');
  ok(dir, '추가', '기반', '--영역', 'src/core');
  ok(dir, '추가', '로그인', '--영역', 'src/login', '--선행', 'T-3');
  ok(dir, '추가', '환불', '--영역', 'src/pay/refund.js');
  ok(dir, '추가', '영역 모름');
  ok(dir, '추가', '대시보드', '--영역', 'src/dash', '--선행', 'T-3');
  ok(dir, '추가', '공지', '--영역', 'src/notice');
  assert.equal(ok(dir, '준비'), [
    '같이 시작해도 되는 작업:',
    'T-3 [할일] 기능 기반  영역: src/core  막는 작업 2개',
    'T-2 [할일] 기능 결제  영역: src/pay',
    'T-8 [할일] 기능 공지  영역: src/notice',
    '미룬 작업:',
    'T-1 영역이 겹친다 (T-3의 src/core)',
    'T-4 선행 작업 T-3이(가) 완료되지 않았다',
    'T-5 영역이 겹친다 (T-2의 src/pay)',
    'T-6 영역이 비어 있다',
    'T-7 선행 작업 T-3이(가) 완료되지 않았다',
  ].join('\n'));
});

test('areas overlap when equal or when one is inside the other folder; a glob tail and a slash tail do not matter', t => {
  const dir = repo(t);
  ok(dir, '추가', 'A', '--영역', 'src/a/**');
  ok(dir, '추가', 'B', '--영역', 'src/a/x.js');
  ok(dir, '추가', 'C', '--영역', 'src/ab');
  ok(dir, '추가', 'D', '--영역', 'lib,src/a/');
  ok(dir, '추가', 'E', '--영역', 'lib');
  ok(dir, '추가', 'F', '--영역', 'src');
  ok(dir, '추가', 'G', '--영역', 'lib2/*');
  ok(dir, '추가', 'H', '--영역', 'lib2/y.js');
  const rows = ok(dir, '준비').split('\n');
  assert.deepEqual(rows.filter(row => row.startsWith('T-')).map(row => row.slice(0, 3)), ['T-1', 'T-3', 'T-5', 'T-7', 'T-2', 'T-4', 'T-6', 'T-8']);
  assert.match(rows.find(row => row.startsWith('T-6')), /영역이 겹친다 \(T-1의 src\/a\/\*\*\)/);
  assert.match(rows.find(row => row.startsWith('T-4')), /영역이 겹친다 \(T-1의 src\/a\/\*\*\)/);
});

test('areas of tasks that are 진행중 or 올림 count as taken, but 완료 ones do not', t => {
  const dir = repo(t);
  ok(dir, '추가', '진행', '--영역', 'src/a', ...CHECK);
  ok(dir, '추가', '올림', '--영역', 'src/b', ...CHECK);
  ok(dir, '추가', '끝남', '--영역', 'src/c', ...CHECK);
  ok(dir, '시작', 'T-1');
  ok(dir, '시작', 'T-2');
  ok(dir, '올림', 'T-2', '--커밋', 'HEAD', '--증거', '확인함');
  ok(dir, '시작', 'T-3');
  ok(dir, '올림', 'T-3', '--커밋', 'HEAD', '--증거', '확인함');
  ok(dir, '완료', 'T-3');
  ok(dir, '추가', 'a 안쪽', '--영역', 'src/a/x');
  ok(dir, '추가', 'b 안쪽', '--영역', 'src/b/x');
  ok(dir, '추가', 'c 안쪽', '--영역', 'src/c/x');
  assert.equal(ok(dir, '준비'), [
    '같이 시작해도 되는 작업:',
    'T-6 [할일] 기능 c 안쪽  영역: src/c/x',
    '미룬 작업:',
    'T-4 영역이 겹친다 (T-1(진행중)의 src/a)',
    'T-5 영역이 겹친다 (T-2(올림)의 src/b)',
  ].join('\n'));
});

test('every area of a task counts, not only the first, for the tasks being picked and for the ones already running', t => {
  const dir = repo(t);
  ok(dir, '추가', '둘', '--영역', 'src/a,src/b', ...CHECK);
  ok(dir, '추가', '안쪽', '--영역', 'src/b/x');
  ok(dir, '추가', '끝이 겹침', '--영역', 'src/z,src/a/y');
  const rows = ok(dir, '준비').split('\n');
  assert.deepEqual(rows.slice(1), ['T-1 [할일] 기능 둘  영역: src/a, src/b', '미룬 작업:',
    'T-2 영역이 겹친다 (T-1의 src/b)', 'T-3 영역이 겹친다 (T-1의 src/a)']);
  ok(dir, '시작', 'T-1');
  assert.match(ok(dir, '준비'), /T-2 영역이 겹친다 \(T-1\(진행중\)의 src\/b\)/);
});

test('준비 says so when nothing can start', t => {
  const dir = repo(t);
  assert.equal(ok(dir, '준비'), '시작할 수 있는 작업이 없다');
});

const TOOLS = { limits: { claude: 2, codex: 1 }, defaultTool: 'claude' };
const PROOF = ['--커밋', 'HEAD', '--증거', '확인함'];
// 작업마다 영역이 달라서 준비와 상관없이 시작할 수 있다.
const begin = (id, ...extra) => ['시작', id, '--영역', `src/${id}`, ...CHECK, ...extra];

test('시작 writes down which tool takes the task: --배정, or backlog.defaultTool when it is left out', t => {
  const dir = repo(t, TOOLS);
  ok(dir, '추가', '하나');
  ok(dir, '추가', '둘');
  ok(dir, ...begin('T-1'));
  ok(dir, ...begin('T-2', '--배정', 'codex'));
  assert.match(ok(dir, '보기', 'T-1'), /배정: claude/);
  assert.match(ok(dir, '보기', 'T-2'), /배정: codex/);
});

test('시작 is refused when the tool already has as many 진행중 tasks as its limit; other tools and 올림 tasks do not count', t => {
  const dir = repo(t, TOOLS);
  for (const title of ['a', 'b', 'c', 'd', 'e']) ok(dir, '추가', title);
  ok(dir, ...begin('T-1', '--배정', 'codex'));
  assert.match(refused(dir, ...begin('T-2', '--배정', 'codex')), /codex은\(는\) 동시에 1개까지다/);
  ok(dir, ...begin('T-2'));
  ok(dir, ...begin('T-3'));
  assert.match(refused(dir, ...begin('T-4')), /claude은\(는\) 동시에 2개까지다/);
  ok(dir, '올림', 'T-1', ...PROOF, '--검토', 'claude');
  ok(dir, ...begin('T-4', '--배정', 'codex'));
});

test('배정 names only tools written in backlog.limits; without limits the option is refused and 시작 works as before', t => {
  const dir = repo(t, TOOLS);
  ok(dir, '추가', '하나');
  assert.match(refused(dir, ...begin('T-1', '--배정', 'gemini')), /gemini은\(는\) 쓸 수 있는 도구가 아니다/);
  for (const inherited of ['constructor', '__proto__', 'toString']) {
    assert.match(refused(dir, ...begin('T-1', '--배정', inherited)), /쓸 수 있는 도구가 아니다/);
  }
  const strayDefault = repo(t, { limits: { claude: 1 }, defaultTool: 'gemini' });
  ok(strayDefault, '추가', '하나');
  const message = refused(strayDefault, ...begin('T-1'));
  assert.match(message, /backlog\.defaultTool\(gemini\)이\(가\) backlog\.limits에 없다/);
  assert.doesNotMatch(message, /--배정/, 'the setting is at fault, not an option the person gave');
  ok(strayDefault, ...begin('T-1', '--배정', 'claude'));
  const noDefault = repo(t, { limits: { claude: 1, codex: 1 } });
  ok(noDefault, '추가', '하나');
  assert.match(refused(noDefault, ...begin('T-1')), /배정할 도구가 없다/);
  const plain = repo(t);
  ok(plain, '추가', '하나');
  assert.match(refused(plain, ...begin('T-1', '--배정', 'claude')), /쓸 수 있는 도구가 아니다/);
  ok(plain, ...begin('T-1'));
  assert.match(refused(plain, '올림', 'T-1', ...PROOF, '--검토', 'claude'), /쓸 수 있는 도구가 아니다/);
  assert.doesNotMatch(ok(plain, '보기', 'T-1'), /배정/);
});

test('with two or more tools 올림 needs --검토 by a tool other than the one that wrote it', t => {
  const dir = repo(t, TOOLS);
  ok(dir, '추가', '하나');
  ok(dir, ...begin('T-1', '--배정', 'codex'));
  assert.match(refused(dir, '올림', 'T-1', ...PROOF), /--검토가 필요하다. 작성한 도구\(codex\)가 아닌 도구\(claude\)가/);
  assert.match(refused(dir, '올림', 'T-1', ...PROOF, '--검토', 'codex'), /직접 검토할 수 없다/);
  assert.match(refused(dir, '올림', 'T-1', ...PROOF, '--검토', 'gemini'), /gemini은\(는\) 쓸 수 있는 도구가 아니다/);
  ok(dir, '올림', 'T-1', ...PROOF, '--검토', 'claude');
  assert.match(ok(dir, '보기', 'T-1'), /검토: claude/);
});

test('with one tool 올림 needs no reviewer', t => {
  const dir = repo(t, { limits: { claude: 3 }, defaultTool: 'claude' });
  ok(dir, '추가', '하나');
  ok(dir, ...begin('T-1'));
  assert.match(ok(dir, '올림', 'T-1', ...PROOF), /올림: T-1 \[올림\]/);
});

test('a limit that is not a whole number refuses 시작 instead of switching the limit off', t => {
  for (const bad of ['two', 1.5, -1, null, {}]) {
    const dir = repo(t, { limits: { claude: bad }, defaultTool: 'claude' });
    ok(dir, '추가', '하나');
    assert.match(refused(dir, ...begin('T-1')), /backlog\.limits\.claude은\(는\) 0 이상의 정수여야 한다/, JSON.stringify(bad));
  }
  const zero = repo(t, { limits: { claude: 0 }, defaultTool: 'claude' });
  ok(zero, '추가', '하나');
  assert.match(refused(zero, ...begin('T-1')), /동시에 0개까지다/);
});
