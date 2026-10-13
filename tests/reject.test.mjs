import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repo, ok, refused } from './helpers.mjs';

const START = ['--영역', 'src', '--확인방법', 'npm test'];
const ledgerOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const taskOf = (dir, id) => ledgerOf(dir).작업.find(task => task.번호 === id);
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// 새 브랜치에 커밋을 하나 만들고 main으로 돌아와 해시를 돌려준다. 병합은 하지 않는다.
function commitOnBranch(dir, branch) {
  git(dir, 'switch', '-q', '-c', branch);
  fs.writeFileSync(path.join(dir, `${branch.replace('/', '-')}.txt`), 'work\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', branch);
  const hash = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  return hash;
}

const submitted = (dir, branch, proof) => {
  const hash = commitOnBranch(dir, branch);
  ok(dir, '올림', 'T-1', '--커밋', hash, '--증거', proof);
  return hash;
};

test('반려 sends back only an 올림 task, and only with a reason', t => {
  const dir = repo(t);
  ok(dir, '추가', '로그인 만들기');
  assert.match(refused(dir, '반려', 'T-1', '--사유', '다시'), /T-1 반려 거절: 올림 상태만 돌려보낸다\(지금 할일\)/);
  ok(dir, '시작', 'T-1', ...START);
  assert.match(refused(dir, '반려', 'T-1', '--사유', '다시'), /올림 상태만 돌려보낸다\(지금 진행중\)/);

  submitted(dir, 'ai/first', '첫 증거');
  assert.match(refused(dir, '반려', 'T-1'), /T-1 반려 거절: --사유가 필요하다/);
  assert.match(refused(dir, '반려', 'T-1', '--사유', '   '), /--사유가 필요하다/);
  assert.equal(taskOf(dir, 'T-1').상태, '올림');

  git(dir, 'merge', '-q', '--no-ff', 'ai/first', '-m', 'merge');
  ok(dir, '완료', 'T-1');
  assert.match(refused(dir, '반려', 'T-1', '--사유', '다시'), /올림 상태만 돌려보낸다\(지금 완료\)/);
});

test('반려 puts the task back to 진행중, moves the old proof into 반려 and shows the reason in 보기 before the questions', t => {
  const dir = repo(t);
  ok(dir, '추가', '로그인 만들기');
  ok(dir, '시작', 'T-1', ...START);
  const hash = submitted(dir, 'ai/first', '첫 증거');
  ok(dir, '질문', 'T-1', '운영 DB의 옛 열을 지울까요', '--행동', '삭제', '--설명', '쓰지 않는 열이다',
    '--보기', '지운다=열이 사라진다|둔다=그대로 남는다', '--추천', '둔다', '--이유', '되돌릴 수 없다');

  assert.match(ok(dir, '반려', 'T-1', '--사유', '증거가 모자라다'), /^반려: T-1 \[진행중\]/, 'a waiting question does not stop it');
  const task = taskOf(dir, 'T-1');
  assert.equal(task.상태, '진행중');
  for (const name of ['커밋', '증거', '검토']) assert.ok(!(name in task), `${name} is moved out of the task`);
  assert.deepEqual(task.반려, [{ 커밋: hash, 증거: '첫 증거', 사유: '증거가 모자라다' }], '검토 was never written, so it is not a key');

  const rows = ok(dir, '보기', 'T-1').split('\n');
  const rejected = rows.indexOf(`반려: ${hash.slice(0, 7)} 증거가 모자라다`);
  assert.ok(rejected > 0, rows.join('\n'));
  assert.match(rows[rejected + 1], /^질문: Q-1 /);
  assert.ok(!rows.some(row => row.startsWith('증거:')), 'the old proof is not shown as the current one');
});

test('a sent-back task can be 올림 again, merged and 완료; every earlier reason stays in 보기', t => {
  const dir = repo(t);
  ok(dir, '추가', '로그인 만들기');
  ok(dir, '시작', 'T-1', ...START);
  const first = submitted(dir, 'ai/first', '첫 증거');
  ok(dir, '반려', 'T-1', '--사유', '첫 사유');
  const second = submitted(dir, 'ai/second', '둘째 증거');
  ok(dir, '반려', 'T-1', '--사유', '둘째 사유');
  const third = submitted(dir, 'ai/third', '셋째 증거');

  git(dir, 'merge', '-q', '--no-ff', 'ai/third', '-m', 'merge');
  assert.match(ok(dir, '완료', 'T-1'), /완료: T-1 \[완료\]/);
  const task = taskOf(dir, 'T-1');
  assert.equal(task.커밋, third);
  assert.deepEqual(task.반려.map(item => [item.커밋, item.사유]), [[first, '첫 사유'], [second, '둘째 사유']]);
  assert.match(ok(dir, '보기', 'T-1'), new RegExp(`반려: ${first.slice(0, 7)} 첫 사유\\n반려: ${second.slice(0, 7)} 둘째 사유$`));
});

test('반려 keeps the 검토 written at 올림 and does not check the tool limit, because the task was already started', t => {
  const dir = repo(t);
  const configFile = path.join(dir, 'harness/config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, backlog: { limits: { claude: 1 }, defaultTool: 'claude' } }));
  ok(dir, '추가', '하나');
  ok(dir, '추가', '둘');
  ok(dir, '시작', 'T-1', '--영역', 'src/a', '--확인방법', 'npm test');
  ok(dir, '올림', 'T-1', '--커밋', 'HEAD', '--증거', '확인함', '--검토', 'claude');
  ok(dir, '시작', 'T-2', '--영역', 'src/b', '--확인방법', 'npm test');

  ok(dir, '반려', 'T-1', '--사유', '다시');
  assert.deepEqual(taskOf(dir, 'T-1').반려.map(item => item.검토), ['claude']);
  assert.deepEqual(['T-1', 'T-2'].map(id => taskOf(dir, id).상태), ['진행중', '진행중'], 'claude has 2 running tasks over its limit of 1');
});
