import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const templates = fileURLToPath(new URL('../templates/harness/', import.meta.url));

// 하네스를 넣고 첫 커밋(main)을 한 임시 git 저장소.
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-backlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
  // 설치기가 하는 일: 장부는 git에 올리지 않는다. 안 하면 git add -A가 장부를 작업 브랜치에 실어 간다.
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'harness/backlog.json\nharness/backlog.lock\nharness/questions.html\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

// 장부 명령을 cwd에서 돌린다. 성공이든 거절이든 결과를 돌려준다.
function backlog(cwd, ...args) {
  const script = path.join(cwd, 'harness/backlog.mjs');
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

// 성공해야 하는 명령의 출력
function ok(cwd, ...args) {
  const result = backlog(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// 거절돼야 하는 명령의 오류 글. 거절하면 장부 파일은 전과 똑같아야 한다.
function refused(cwd, ...args) {
  const file = path.join(cwd, 'harness/backlog.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const result = backlog(cwd, ...args);
  assert.equal(result.status, 1, `거절돼야 한다: ${args.join(' ')}\n${result.stdout}`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'a refused command leaves the ledger as it was');
  return result.stderr;
}

const WHERE = ['--영역', 'src/a/**', '--확인방법', 'npm test'];
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const statusOf = (dir, id) => ledgerOf(dir).작업.find(task => task.번호 === id).상태;

// 작업 브랜치에 커밋을 하나 만들고 main으로 돌아와 해시를 돌려준다.
function commitOnBranch({ dir, git }, branch) {
  git('switch', '-q', '-c', branch);
  fs.writeFileSync(path.join(dir, `${branch.replace('/', '-')}.txt`), 'work\n');
  git('add', '-A');
  git('commit', '-q', '-m', branch);
  const hash = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  return hash;
}

test('a new task waits as 할일; 다음 shows the first one that can start', t => {
  const { dir } = repo(t);
  assert.match(ok(dir, '추가', '로그인 만들기'), /추가: T-1 \[할일\] 기능 로그인 만들기/);
  ok(dir, '추가', '결제 만들기');
  assert.match(ok(dir, '다음'), /^T-1 \[할일\]/);
  assert.equal(ok(dir, '목록').trim().split('\n').length, 2);
  assert.equal(ok(dir, '목록', '--상태', '진행중').trim(), '작업이 없다');
});

test('start is refused without the area and the way to check the end; the options fill the blanks', t => {
  const { dir } = repo(t);
  ok(dir, '추가', '로그인 만들기');
  const message = refused(dir, '시작', 'T-1');
  assert.match(message, /영역, 확인방법/);
  assert.equal(statusOf(dir, 'T-1'), '할일', 'a refused start changes nothing');
  assert.match(ok(dir, '시작', 'T-1', ...WHERE), /시작: T-1 \[진행중\]/);
  assert.match(ok(dir, '보기', 'T-1'), /영역: src\/a\/\*\*\n확인방법: npm test/);
  assert.match(refused(dir, '시작', 'T-1'), /이미 진행중/);
});

test('a fix task cannot start without its cause and direction', t => {
  const { dir } = repo(t);
  ok(dir, '추가', '로그인 오류 고치기', '--종류', '수정', ...WHERE);
  assert.match(refused(dir, '시작', 'T-1'), /원인, 방향/);
  assert.equal(statusOf(dir, 'T-1'), '할일');
  ok(dir, '시작', 'T-1', '--원인', '세션 만료 시각을 잘못 비교함(src/a/session.js:40)', '--방향', '비교를 UTC로 통일');
  assert.equal(statusOf(dir, 'T-1'), '진행중');
});

test('a task cannot start before the tasks it depends on are 완료', t => {
  const { dir } = repo(t);
  ok(dir, '추가', '먼저', ...WHERE);
  ok(dir, '추가', '나중에', '--선행', 'T-1', ...WHERE);
  assert.match(refused(dir, '시작', 'T-2'), /선행 작업 T-1/);
  ok(dir, '시작', 'T-1');
  assert.match(ok(dir, '다음'), /시작할 수 있는 작업이 없다/, 'T-2 still waits while T-1 is running');
  assert.match(refused(dir, '추가', '없는 선행', '--선행', 'T-9'), /T-9: 그런 작업이 없다/);
});

test('submitting needs a real commit and the evidence; 완료 needs the commit merged into main', t => {
  const context = repo(t);
  const { dir, git } = context;
  ok(dir, '추가', '로그인 만들기', ...WHERE);
  ok(dir, '추가', '결제 만들기', '--선행', 'T-1', ...WHERE);
  assert.match(refused(dir, '올림', 'T-1', '--커밋', 'abc', '--증거', '테스트 통과'), /진행중인 작업만/);
  ok(dir, '시작', 'T-1');
  assert.match(refused(dir, '올림', 'T-1', '--증거', '테스트 통과'), /--커밋과 --증거/);
  assert.match(refused(dir, '올림', 'T-1', '--커밋', 'deadbeef', '--증거', '테스트 통과'), /찾을 수 없다/);

  const hash = commitOnBranch(context, 'ai/T-1');
  assert.match(refused(dir, '올림', 'T-1', '--커밋', hash), /--커밋과 --증거/, 'a real commit alone is not enough');
  ok(dir, '올림', 'T-1', '--커밋', hash.slice(0, 7), '--증거', 'npm test 통과');
  assert.equal(ledgerOf(dir).작업[0].커밋, hash, 'the full hash is stored');
  assert.match(refused(dir, '완료', 'T-1'), /main에 병합되지 않았다/);
  assert.equal(statusOf(dir, 'T-1'), '올림');

  git('merge', '-q', '--no-ff', 'ai/T-1', '-m', 'merge T-1');
  assert.match(ok(dir, '완료', 'T-1'), /완료: T-1 \[완료\]/);
  assert.match(ok(dir, '다음'), /^T-2 /, 'the task waiting on T-1 can now start');
});

test('each command takes only its own options, so the status cannot be set by hand', t => {
  const { dir } = repo(t);
  assert.match(refused(dir, '추가', '로그인 만들기', '--상태', '완료', ...WHERE), /--상태은\(는\) 이 명령에서 쓰지 않는다/);
  assert.match(refused(dir, '추가', '이상한 종류', '--종류', '버그'), /기능 또는 수정/);
  ok(dir, '추가', '로그인 만들기', ...WHERE);
  assert.equal(statusOf(dir, 'T-1'), '할일');
  assert.match(refused(dir, '시작', 'T-1', '--상태', '완료'), /쓸 수 있는 옵션: --영역 --확인방법 --원인 --방향/);
  assert.match(refused(dir, '시작', 'T-1', '--커밋', 'abc'), /--커밋은\(는\) 이 명령에서 쓰지 않는다/);
  ok(dir, '시작', 'T-1');
  assert.match(refused(dir, '완료', 'T-1'), /올림 상태만/);
});

test('start only fills blanks: the kind, the dependencies and what is already written cannot be swapped', t => {
  const { dir } = repo(t);
  ok(dir, '추가', '버그', '--종류', '수정', ...WHERE);
  assert.match(refused(dir, '시작', 'T-1', '--종류', '기능'), /--종류은\(는\) 이 명령에서 쓰지 않는다/);
  ok(dir, '추가', '먼저');
  ok(dir, '추가', '의존', '--선행', 'T-2', ...WHERE);
  assert.match(refused(dir, '시작', 'T-3', '--선행', 'T-1'), /--선행은\(는\) 이 명령에서 쓰지 않는다/);
  assert.match(refused(dir, '시작', 'T-3'), /선행 작업 T-2/);

  ok(dir, '추가', '칸 채우기', '--영역', 'src/a');
  ok(dir, '시작', 'T-4', '--영역', 'src/zzz', '--확인방법', 'npm test');
  assert.match(ok(dir, '보기', 'T-4'), /영역: src\/a\n확인방법: npm test/, 'the filled area stays; only the blank is filled');
});

test('values made of spaces count as empty', t => {
  const { dir } = repo(t);
  assert.match(refused(dir, '추가', '   '), /제목이 없다/);
  ok(dir, '추가', '버그', '--종류', '수정', '--영역', 'a', '--확인방법', '   ');
  assert.match(refused(dir, '시작', 'T-1', '--원인', '   ', '--방향', ' '), /확인방법, 원인, 방향/);
  ok(dir, '시작', 'T-1', '--확인방법', 'npm test', '--원인', '원인 있음', '--방향', '방향 있음');
  assert.match(refused(dir, '올림', 'T-1', '--커밋', 'HEAD', '--증거', '   '), /--커밋과 --증거/);
  assert.equal(ledgerOf(dir).작업[0].확인방법, 'npm test', 'values are stored without the surrounding spaces');
});

test('완료 looks at the branch even when a tag has the same name', t => {
  const context = repo(t);
  const { dir, git } = context;
  ok(dir, '추가', '로그인 만들기', ...WHERE);
  ok(dir, '시작', 'T-1');
  const hash = commitOnBranch(context, 'ai/T-1');
  git('tag', 'main', hash);
  ok(dir, '올림', 'T-1', '--커밋', hash, '--증거', 'npm test 통과');
  assert.match(refused(dir, '완료', 'T-1'), /main에 병합되지 않았다/);
});

test('a long answer is cut at outputLines and says how to narrow it', t => {
  const { dir } = repo(t);
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), backlog: { outputLines: 3 } }));
  for (let i = 1; i <= 5; i++) ok(dir, '추가', `작업 ${i}`);
  const lines = ok(dir, '목록').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /2줄 더 있다.*조건을 좁힌다/);
});

test('the note under a cut answer fits the command: 목록 can be narrowed, 보기 points to the document, 준비 has nothing to narrow', t => {
  const { dir } = repo(t);
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), backlog: { outputLines: 3 } }));
  for (let i = 1; i <= 5; i++) ok(dir, '추가', `작업 ${i}`);
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/tasks/T-1.md'), '하나\n둘\n셋\n넷\n다섯\n');
  const note = (...args) => ok(dir, ...args).trimEnd().split('\n').at(-1);
  assert.equal(note('목록'), '… 2줄 더 있다. --상태로 조건을 좁힌다');
  assert.equal(note('보기', 'T-1'), '… 4줄 더 있다. docs/tasks/ 아래의 작업 문서를 직접 읽는다');
  assert.match(note('준비'), /^… \d+줄 더 있다$/);
});

test('보기 adds the task document docs/tasks/<번호>.md when there is one', t => {
  const { dir } = repo(t);
  ok(dir, '추가', '로그인 만들기', ...WHERE);
  assert.doesNotMatch(ok(dir, '보기', 'T-1'), /docs\/tasks/);
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/tasks/T-1.md'), '# 로그인\n세션을 쓴다\n');
  assert.match(ok(dir, '보기', 'T-1'), /--- docs\/tasks\/T-1\.md ---\n# 로그인\n세션을 쓴다/);
});

test('inside a worktree the commands read and write the ledger of the main folder', t => {
  const { dir, git } = repo(t);
  ok(dir, '추가', '로그인 만들기', ...WHERE);
  const worktree = path.join(fs.realpathSync(dir), '.claude/worktrees/sub-1');
  git('worktree', 'add', '-q', '-b', 'worktree-sub-1', worktree);
  assert.match(ok(worktree, '목록'), /T-1 \[할일\]/, 'the worktree sees the ledger of the main folder');
  ok(worktree, '시작', 'T-1');
  assert.equal(statusOf(dir, 'T-1'), '진행중');
  assert.equal(fs.existsSync(path.join(worktree, 'harness/backlog.json')), false, 'no second copy in the worktree');

  // HEAD는 부른 워크트리의 HEAD다. 메인 폴더의 HEAD로 풀리면 이미 main에 있는 커밋이 올라가 바로 완료된다.
  fs.writeFileSync(path.join(worktree, 'sub.txt'), 'work\n');
  execFileSync('git', ['add', 'sub.txt'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', 'sub'], { cwd: worktree });
  ok(worktree, '올림', 'T-1', '--커밋', 'HEAD', '--증거', 'npm test 통과');
  assert.equal(ledgerOf(dir).작업[0].커밋, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim());
  assert.match(refused(dir, '완료', 'T-1'), /main에 병합되지 않았다/);
});

test('shapes whose parent of .git is not the project folder are refused instead of writing in the wrong place', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-backlog-shapes-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const prepare = (dir, ...init) => {
    execFileSync('git', ['init', '-q', '-b', 'main', ...init], { cwd: base });
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    fs.cpSync(templates, path.join(dir, 'harness'), { recursive: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  };

  prepare(project, `--separate-git-dir=${path.join(base, 'meta')}`, project);
  assert.match(refused(project, '목록'), /일반 저장소에서만/);
  assert.equal(fs.existsSync(path.join(base, 'harness')), false, 'nothing is written next to the git folder');

  const bare = path.join(base, 'bare.git');
  const linked = path.join(base, 'linked');
  execFileSync('git', ['clone', '-q', '--bare', project, bare]);
  git(bare, 'worktree', 'add', '-q', linked, 'main');
  assert.match(refused(linked, '목록'), /일반 저장소에서만/);
});

test('unknown commands, unknown numbers and a folder without git are refused with a message', t => {
  const { dir } = repo(t);
  assert.match(refused(dir, '지우기'), /명령: 추가, 목록, 다음, 준비, 보기, 시작, 올림, 반려, 완료, 허락, 확인, 기록, 질문목록, 답, 기다리기, 서버, 질문, 처리함, 켜두기, 끄기 /);
  for (const inherited of ['constructor', '__proto__', 'toString']) assert.match(refused(dir, inherited), /^backlog: 명령: 추가, /, inherited);
  assert.match(refused(dir, '보기', 'T-7'), /T-7: 그런 작업이 없다/);
  assert.match(refused(dir, '추가'), /제목이 없다/);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-backlog-bare-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  fs.cpSync(templates, path.join(bare, 'harness'), { recursive: true });
  assert.match(refused(bare, '목록'), /not a git repository/);
});
