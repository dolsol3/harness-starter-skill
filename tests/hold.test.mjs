// 보류 상태: 진행중·할일을 사유·구분·시각과 함께 치워 두고, 시작으로 되살린다. 보류는 고르기·동시 상한·영역 겹침·멈춤 훅·커밋 검사에 세지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repo, ok, refused, rewrite } from './helpers.mjs';

const CHECK = ['--확인방법', 'npm test'];

// 작업을 추가하고 영역을 정해 둔다. 시작하려면 start를 참으로 준다.
function task(dir, title, area, start = false) {
  const id = ok(dir, '추가', title, '--영역', area, ...CHECK).match(/T-\d+/)[0];
  if (start) ok(dir, '시작', id);
  return id;
}

// config.json에 칸을 더한다(동시 상한, 코드 종류).
function configure(dir, extra) {
  const file = path.join(dir, 'harness/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
}

const book = dir => JSON.parse(fs.readFileSync(path.join(dir, 'harness/backlog.json'), 'utf8'));
const entry = (dir, id) => book(dir).작업.find(item => item.번호 === id);

test('보류 moves 진행중 and 할일 tasks to 보류 with 사유, 시각 and 구분 미룸 by default', t => {
  const dir = repo(t);
  const running = task(dir, '돌던 일', 'src/a', true);
  const waiting = task(dir, '기다리던 일', 'src/b');
  assert.match(ok(dir, '보류', running, '--사유', '나중에'), /보류: T-1 \[보류\]/);
  assert.match(ok(dir, '보류', waiting, '--사유', '안 급함'), /보류: T-2 \[보류\]/);
  for (const [id, 사유] of [[running, '나중에'], [waiting, '안 급함']]) {
    const held = entry(dir, id);
    assert.equal(held.상태, '보류');
    assert.equal(held.보류사유, 사유);
    assert.equal(held.보류구분, '미룸');
    assert.match(held.보류시각, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
});

test('보류 --구분 writes 대체, 취소 or 미룸 and refuses anything else', t => {
  const dir = repo(t);
  for (const kind of ['대체', '취소', '미룸']) {
    const id = task(dir, kind, `src/${kind}`);
    ok(dir, '보류', id, '--사유', `T-9가 맡음 ${kind}`, '--구분', kind);
    assert.equal(entry(dir, id).보류구분, kind);
  }
  const other = task(dir, '기타', 'src/x');
  assert.match(refused(dir, '보류', other, '--사유', '왜', '--구분', '버림'), /--구분은 미룸·대체·취소 중 하나다/);
});

test('보류 is refused without 사유 or when the task is 올림, 완료 or already 보류', t => {
  const dir = repo(t);
  const id = task(dir, '일', 'src/a', true);
  assert.match(refused(dir, '보류', id), /--사유가 필요하다/);
  assert.match(refused(dir, '보류', id, '--사유', ''), /--사유가 필요하다/);
  ok(dir, '올림', id, '--커밋', 'HEAD', '--증거', '확인함');
  assert.match(refused(dir, '보류', id, '--사유', '왜'), /진행중이나 할일인 작업만 보류한다\(지금 올림\)/);
  ok(dir, '완료', id);
  assert.match(refused(dir, '보류', id, '--사유', '왜'), /지금 완료/);
  const held = task(dir, '둘', 'src/b');
  ok(dir, '보류', held, '--사유', '미룸');
  assert.match(refused(dir, '보류', held, '--사유', '또'), /지금 보류/);
});

test('시작 brings a 보류 task back to 진행중 and clears the 보류 fields, whether it was 진행중 or 할일', t => {
  const dir = repo(t);
  const running = task(dir, '돌던 일', 'src/a', true);
  const waiting = task(dir, '기다리던 일', 'src/b');
  ok(dir, '보류', running, '--사유', '나중에');
  ok(dir, '보류', waiting, '--사유', 'T-9가 대신', '--구분', '대체');
  for (const id of [running, waiting]) {
    assert.match(ok(dir, '시작', id), /\[진행중\]/);
    const back = entry(dir, id);
    for (const name of ['보류사유', '보류구분', '보류시각']) assert.equal(name in back, false, name);
  }
});

test('시작 of a 보류 task is refused like a new start when a 선행 is not 완료 or the tool limit is full; 보류 does not count toward the limit', t => {
  const dir = repo(t);
  configure(dir, { backlog: { limits: { claude: 1 }, defaultTool: 'claude' } });
  const first = task(dir, '먼저', 'src/a');
  const after = ok(dir, '추가', '뒤', '--영역', 'src/b', '--선행', first, ...CHECK).match(/T-\d+/)[0];
  ok(dir, '보류', after, '--사유', '기다림');
  assert.match(refused(dir, '시작', after), /선행 작업 T-1\)이\(가\) 완료되지 않았다/);
  ok(dir, '시작', first);
  ok(dir, '보류', first, '--사유', '잠깐');
  const other = task(dir, '다른', 'src/c', true);
  assert.equal(entry(dir, other).상태, '진행중', 'the 보류 task left the limit free');
  assert.match(refused(dir, '시작', first), /claude은\(는\) 동시에 1개까지다/);
});

test('보류 tasks leave 바로할일 and 다음, and do not take their 영역', t => {
  const dir = repo(t);
  const running = task(dir, '돌던 일', 'src/a', true);
  const same = task(dir, '같은 곳', 'src/a');
  assert.match(ok(dir, '바로할일'), new RegExp(`${same} 고칠곳이 겹친다 \\(${running}\\(진행중\\)`));
  ok(dir, '보류', running, '--사유', '나중에');
  assert.match(ok(dir, '바로할일'), new RegExp(`같이 시작해도 되는 작업:\\n${same} \\[할일\\]`));

  const old = task(dir, '오래된 넓은 일', 'tests');
  const fresh = task(dir, '새 일', 'tests/a.test.mjs');
  assert.match(ok(dir, '바로할일'), new RegExp(`${fresh} 고칠곳이 겹친다 \\(${old}\\(할일\\)의 tests\\)`));
  ok(dir, '보류', old, '--사유', '안 하기로 함', '--구분', '취소');
  const shown = ok(dir, '바로할일');
  assert.doesNotMatch(shown, new RegExp(`${old}\\b`));
  assert.match(shown, new RegExp(`${fresh} \\[할일\\]`));
  ok(dir, '보류', same, '--사유', '나중에');
  ok(dir, '보류', fresh, '--사유', '나중에');
  assert.equal(ok(dir, '다음'), '시작할 수 있는 작업이 없다');
});

test('the stop hook does not hold on when only 보류 tasks are left', t => {
  const dir = repo(t);
  const stop = () => spawnSync(process.execPath, [path.join(dir, 'harness/stop.mjs')], { cwd: dir, input: JSON.stringify({ cwd: dir, stop_hook_active: false }), encoding: 'utf8' });
  const kept = task(dir, '하나', 'src/a', true);
  const held = task(dir, '둘', 'src/b', true);
  ok(dir, '보류', held, '--사유', '나중에');
  assert.match(stop().stdout, new RegExp(`진행중 작업: ${kept}\\.`));
  ok(dir, '보류', kept, '--사유', '나중에');
  assert.equal(stop().stdout, '');
});

test('the commit check refuses code when only 보류 tasks exist and passes with a 진행중 task', t => {
  const dir = repo(t);
  configure(dir, { kinds: { code: { files: ['src/**'], maxFileLines: 300 } } });
  execFileSync('git', ['commit', '-qam', 'kinds'], { cwd: dir });
  const id = task(dir, '일', 'src/a', true);
  ok(dir, '보류', id, '--사유', '나중에');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const guard = () => spawnSync(process.execPath, [path.join(dir, 'harness/guard.mjs'), '--staged'], { cwd: dir, encoding: 'utf8' });
  const blocked = guard();
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /진행중인 작업이 없다/);
  ok(dir, '시작', id);
  assert.equal(guard().status, 0, guard().stderr);
});

test('the 물레방아 in-progress list leaves out 보류 tasks', async t => {
  const dir = repo(t);
  const kept = task(dir, '하나', 'src/a', true);
  const held = task(dir, '둘', 'src/b', true);
  ok(dir, '보류', held, '--사유', '나중에');
  const steps = await import(pathToFileURL(path.join(dir, 'harness/mullebanga-steps.mjs')).href);
  assert.deepEqual(steps.inProgress(dir), [kept]);
});

test('목록 --상태 보류 lists only 보류 tasks and 보기 shows 사유, 구분 and 시각', t => {
  const dir = repo(t);
  task(dir, '하나', 'src/a', true);
  const held = task(dir, '둘', 'src/b');
  ok(dir, '보류', held, '--사유', 'T-9가 대신 함', '--구분', '대체');
  assert.equal(ok(dir, '목록', '--상태', '보류'), `${held} [보류] 기능 둘`);
  const shown = ok(dir, '보기', held);
  assert.match(shown, /^보류: T-9가 대신 함$/m);
  assert.match(shown, /^보류구분: 대체$/m);
  assert.match(shown, /^보류시각: \d{4}-\d\d-\d\dT/m);
});

test('an old ledger whose 보류 task has only 보류사유 still lists, shows and starts; 보류 without --구분 still works', t => {
  const dir = repo(t);
  const old = task(dir, '옛 보류', 'src/a');
  const next = task(dir, '다음', 'src/b', true);
  rewrite(dir, ledgerBook => {
    const item = ledgerBook.작업.find(each => each.번호 === old);
    Object.assign(item, { 상태: '보류', 보류사유: '옛 사유' });
  });
  assert.match(ok(dir, '목록'), new RegExp(`${old} \\[보류\\] 기능 옛 보류`));
  const shown = ok(dir, '보기', old);
  assert.match(shown, /^보류: 옛 사유$/m);
  assert.doesNotMatch(shown, /보류구분|보류시각/);
  ok(dir, '시작', old);
  assert.equal('보류사유' in entry(dir, old), false);
  ok(dir, '보류', next, '--사유', '옛 호출');
  assert.equal(entry(dir, next).보류구분, '미룸');
});
