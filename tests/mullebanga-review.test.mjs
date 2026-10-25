import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, observed, valueAfter, DEFAULT_CONFIG } from './review-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lines = file => read(file).split('\n').length - 1;
const limits = (...names) => ({ 일감목록: { 동시상한: Object.fromEntries(names.map(name => [name, 1])) } });
const review = (extra = {}) => ({ 단계모델: { 번갈아보기: { ...DEFAULT_CONFIG.단계모델.번갈아보기, ...extra } } });

test('모듈은 reviewOther를 내보내고 허용한 것만 가져오며 관련 파일이 모두 300줄 이하다', () => {
  const text = read('templates/harness/mullebanga-review.mjs');
  const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
  assert.match(text, /export async function reviewOther/);
  assert.deepEqual(imports.filter(name => !name.startsWith('node:')).sort(), ['./mullebanga-call.mjs', './mullebanga-prompts.mjs']);
  assert.ok(imports.every(name => name.startsWith('node:') || name.startsWith('./mullebanga-')));
  assert.doesNotMatch(text, /workflows\/mullebanga/);
  for (const file of ['templates/harness/mullebanga-review.mjs', 'templates/harness/mullebanga-call.mjs', 'tests/mullebanga-review.test.mjs', 'tests/mullebanga-review-sandbox.test.mjs', 'tests/review-fixture.mjs']) {
    assert.ok(lines(file) <= 300, `${file} ${lines(file)}줄`);
  }
});

test('후보 고르기: 작성 도구가 아니고 동시상한에 있는 첫 도구, 설정 별칭도 먹는다', async t => {
  const cases = [
    ['claude 작성이면 codex', DEFAULT_CONFIG, 'claude', 'codex'],
    ['gemini 작성이면 codex', DEFAULT_CONFIG, 'gemini', 'codex'],
    ['codex 작성이면 gemini', DEFAULT_CONFIG, 'codex', 'gemini'],
    ['동시상한에서 codex를 빼면 gemini', limits('claude', 'gemini'), 'claude', 'gemini'],
    ['검토·폴백이 둘 다 밖이면 claude', limits('claude', 'codex'), 'codex', 'claude'],
    ['영문 별칭', { backlog: { limits: { codex: 1, gemini: 1, claude: 1 } }, agents: { review: { reviewTool: 'gemini', fallbackTool: 'claude' } } }, 'claude', 'gemini'],
    ['한글 별칭', { 일감목록: { 한도: { codex: 1, gemini: 1 } }, 단계모델: { '교차 리뷰': { 바깥도구: 'gemini' } } }, 'claude', 'gemini'],
  ];
  for (const [name, config, author, tool] of cases) {
    await t.test(name, async st => {
      const s = setup(st);
      s.setConfig(config);
      const res = await s.review({}, { author });
      assert.equal(res.tool, tool);
      assert.deepEqual(res.attempts.map(a => a.tool), [tool]);
    });
  }
});

test('고를 도구가 없으면 아무것도 부르지 않고 임시 폴더도 만들지 않는다', async t => {
  const s = setup(t);
  s.setConfig(limits('claude'));
  const res = await s.review({}, { author: 'claude' });
  assert.equal(res.tool, '');
  assert.equal(res.agentapiChanged, false);
  assert.deepEqual(res.findings, [{ level: '중간', text: '다른 도구 검토 없음: 작성 도구가 아니고 동시상한에 있는 검토·폴백 도구가 없다' }]);
  assert.deepEqual(s.called(), []);
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('입력이 틀리면 던진다: 모르는 작성 도구, 상대 경로, 없는 작업 문서', async t => {
  const s = setup(t);
  await assert.rejects(s.review({}, { author: 'gpt' }), /모르는 작성 도구/);
  await assert.rejects(s.review({}, { repo: 'repo' }), /절대 경로/);
  await assert.rejects(s.review({}, { worktree: 'wt' }), /절대 경로/);
  await assert.rejects(s.review({}, { id: 'T-99' }), /작업 문서 파일이 없다/);
  assert.deepEqual(s.called(), []);
});

test('복사본: 작업 워크트리가 아니고 원격이 없고 분리된 커밋이며 객체는 하드링크가 아니고 끝나면 지워진다', async t => {
  const s = setup(t);
  const mergeBase = s.git('merge-base', 'main', s.commit);
  const res = await s.review({ FAKE_WRITE: 'scribble.txt' });
  const seen = observed(res);
  assert.notEqual(seen.cwd, s.worktree);
  assert.equal(path.dirname(seen.cwd).startsWith(s.tmpRoot), true);
  assert.equal(seen.remotes, '');
  assert.equal(seen.head, s.commit);
  assert.equal(seen.branch, '');
  assert.equal(seen.diff, 'impl.txt');
  assert.equal(seen.maxLinks, 1);
  assert.ok(seen.prompt.includes(`git diff ${mergeBase} HEAD`));
  assert.equal(s.git('status', '--porcelain'), '');
  assert.equal(s.git('rev-parse', 'HEAD'), s.commit);
  assert.equal(fs.existsSync(path.join(s.worktree, 'scribble.txt')), false);
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('복사본은 도구가 실패해도 지워진다', async t => {
  const s = setup(t);
  const res = await s.review({ FAKE_MODE: 'fail' });
  assert.equal(res.tool, '');
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('git이 실패하면 던지지 않고 검토 못 함으로 돌려준다', async t => {
  const s = setup(t);
  const res = await s.review({}, { commit: '0'.repeat(40) });
  assert.equal(res.tool, '');
  assert.match(res.findings[0].text, /^다른 도구 검토 실패: git /);
  assert.deepEqual(s.called(), []);
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('codex 호출: 샌드박스·모델·깊이·복사본, HOME은 임시 홈, CODEX_HOME은 진짜 홈, 지시문에 작업 문서와 diff', async t => {
  const s = setup(t);
  const res = await s.review({ FAKE_WRITE: 'ignored.txt' });
  const seen = observed(res);
  assert.equal(res.tool, 'codex');
  assert.equal(valueAfter(seen.args, '-s'), 'workspace-write');
  assert.equal(valueAfter(seen.args, '-m'), 'gpt-6.1-sol');
  assert.equal(valueAfter(seen.args, '-c'), 'model_reasoning_effort="medium"');
  assert.equal(valueAfter(seen.args, '-C'), seen.cwd);
  assert.equal(seen.env.HOME, path.join(path.dirname(seen.cwd), 'home'));
  assert.equal(seen.env.CODEX_HOME, path.join(s.home, '.codex'));
  assert.ok(seen.prompt.includes('## 작업 문서 전문') && seen.prompt.includes('1. 된다'));
  assert.ok(seen.prompt.includes('HOME과 USERPROFILE을 ' + seen.env.HOME));
  assert.equal(res.findings.length, 1);
});

test('codex: CODEX_HOME 환경과 설정의 바깥모델·바깥추론이 따라간다', async t => {
  const s = setup(t);
  s.setConfig({ ...DEFAULT_CONFIG, ...review({ 바깥모델: 'gpt-x', 바깥추론: 'low' }) });
  const seen = observed(await s.review({ CODEX_HOME: '/somewhere/codex' }));
  assert.equal(valueAfter(seen.args, '-m'), 'gpt-x');
  assert.equal(valueAfter(seen.args, '-c'), 'model_reasoning_effort="low"');
  assert.equal(seen.env.CODEX_HOME, '/somewhere/codex');
});

test('claude 호출: acceptEdits, 샌드박스 설정, Bash 허용, 모델·깊이, HOME은 그대로', async t => {
  const s = setup(t);
  s.setConfig({ ...limits('claude', 'codex'), ...review({ 모델: 'sonnet', 깊이: 'low' }) });
  const res = await s.review({}, { author: 'codex' });
  const seen = observed(res);
  assert.equal(res.tool, 'claude');
  assert.equal(valueAfter(seen.args, '--permission-mode'), 'acceptEdits');
  assert.deepEqual(JSON.parse(valueAfter(seen.args, '--settings')), { sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  assert.equal(valueAfter(seen.args, '--allowedTools'), 'Bash');
  assert.equal(valueAfter(seen.args, '--model'), 'sonnet');
  assert.equal(valueAfter(seen.args, '--effort'), 'low');
  assert.equal(seen.env.HOME, s.home);
});

test('폴백: codex가 한도 문구로 실패하면 gemini를 한 번 부르고 복사본은 처음 모양이다', async t => {
  const s = setup(t);
  const res = await s.review({ FAKE_MODE_CODEX: 'limit', FAKE_WRITE_CODEX: 'left.txt' });
  const seen = observed(res);
  assert.equal(res.tool, 'gemini');
  assert.deepEqual(res.attempts.map(a => [a.tool, a.ok]), [['codex', false], ['gemini', true]]);
  assert.match(res.attempts[0].detail, /^한도/);
  assert.equal(seen.head, s.commit);
  assert.equal(seen.files.includes('left.txt'), false);
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
});

test('폴백 사유: 시간 제한, 결과 칸이 틀림, 실행 실패', async t => {
  const cases = [['시간초과', 'sleep'], ['결과없음', 'notarray'], ['결과없음', 'badlevel'], ['실패', 'fail']];
  for (const [reason, mode] of cases) {
    await t.test(mode, async st => {
      const s = setup(st);
      const res = await s.review({ FAKE_MODE_CODEX: mode }, { timeouts: { breaking: 3000, readOnly: 3000 } });
      assert.equal(res.tool, 'gemini');
      assert.deepEqual(res.attempts.map(a => a.tool), ['codex', 'gemini']);
      assert.match(res.attempts[0].detail, new RegExp(`^${reason}`));
    });
  }
});

test('폴백까지 실패하면 tool을 비우고 중간 하나로 돌려준다', async t => {
  const s = setup(t);
  const res = await s.review({ FAKE_MODE: 'fail' });
  assert.equal(res.tool, '');
  assert.equal(res.attempts.length, 2);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].level, '중간');
  assert.match(res.findings[0].text, /^다른 도구 검토 실패: /);
});

test('폴백이 없는 경우: 폴백도구가 동시상한 밖, 작성 도구, 이미 폴백도구를 골랐을 때', async t => {
  const cases = [
    ['동시상한 밖', limits('claude', 'codex'), 'claude', 'codex'],
    ['폴백도구가 작성 도구', DEFAULT_CONFIG, 'gemini', 'codex'],
    ['처음부터 폴백도구를 골랐다(claude를 부르지 않는다)', DEFAULT_CONFIG, 'codex', 'gemini'],
  ];
  for (const [name, config, author, only] of cases) {
    await t.test(name, async st => {
      const s = setup(st);
      s.setConfig(config);
      const res = await s.review({ FAKE_MODE: 'limit' }, { author });
      assert.equal(res.tool, '');
      assert.deepEqual(res.attempts.map(a => a.tool), [only]);
    });
  }
});

test('읽기 전용 경로(sandbox-exec 없는 PATH): readonly 역할, HARNESS_READ_ONLY, 모델, 300초 제한', async t => {
  const s = setup(t);
  const res = await s.review({ PATH: s.noSandboxPath }, { author: 'codex', timeouts: { breaking: 20000 } });
  const seen = observed(res);
  assert.equal(res.tool, 'gemini');
  assert.equal(valueAfter(seen.args, '--agent'), 'readonly');
  assert.equal(valueAfter(seen.args, '--model'), 'gemini-4-argon-medium');
  assert.equal(valueAfter(seen.args, '--print-timeout'), '300s');
  assert.equal(seen.env.HARNESS_READ_ONLY, '1');
  assert.equal(seen.args.includes('-w'), false);
  assert.equal(res.findings.length, 1);
});

test('읽기 전용 경로: breaker.md가 없으면 sandbox-exec가 있어도 readonly로 간다', async t => {
  const s = setup(t, { roles: ['readonly'] });
  const seen = observed(await s.review({}, { author: 'codex' }));
  assert.equal(valueAfter(seen.args, '--agent'), 'readonly');
  assert.equal(seen.env.HARNESS_READ_ONLY, '1');
});

test('읽기 전용 경로: readonly.md가 없으면 부르지 않고 검토 실패', async t => {
  const s = setup(t, { roles: ['breaker'] });
  const res = await s.review({ PATH: s.noSandboxPath }, { author: 'codex' });
  assert.equal(res.tool, '');
  assert.deepEqual(res.findings, [{ level: '중간', text: '다른 도구 검토 실패: 읽기 전용 역할 파일 없음' }]);
  assert.deepEqual(s.called(), []);
});

test('읽기 전용 경로: 복사본에 파일을 쓰면 높음 하나, 쓰지 않으면 없다', async t => {
  const s = setup(t);
  const clean = await s.review({ PATH: s.noSandboxPath }, { author: 'codex' });
  assert.equal(clean.findings.some(f => f.level === '높음'), false);
  const dirty = await s.review({ PATH: s.noSandboxPath, FAKE_WRITE: 'edited.txt' }, { author: 'codex' });
  assert.equal(dirty.tool, 'gemini');
  assert.deepEqual(dirty.findings.filter(f => f.level === '높음'), [{ level: '높음', text: '다른 도구 검토 뒤 복사본이 바뀜: edited.txt' }]);
  assert.equal(dirty.agentapiChanged, false);
});

test('codex·claude는 복사본에 파일을 써도 높음이 생기지 않는다', async t => {
  const s = setup(t);
  const codex = await s.review({ FAKE_WRITE: 'edited.txt' });
  assert.deepEqual([codex.tool, codex.findings.length], ['codex', 1]);
  s.setConfig(limits('claude', 'codex'));
  const claude = await s.review({ FAKE_WRITE: 'edited.txt' }, { author: 'codex' });
  assert.deepEqual([claude.tool, claude.findings.length], ['claude', 1]);
});

test('읽기 전용 경로: 도구가 실패해도 복사본이 바뀌었으면 높음이 남는다(주 검토 실패)', async t => {
  const s = setup(t);
  const res = await s.review({ PATH: s.noSandboxPath, FAKE_WRITE: 'edited.txt', FAKE_MODE: 'fail' }, { author: 'codex' });
  assert.equal(res.tool, '');
  assert.equal(res.findings[0].level, '중간');
  assert.deepEqual(res.findings.filter(f => f.level === '높음'), [{ level: '높음', text: '다른 도구 검토 뒤 복사본이 바뀜: edited.txt' }]);
});

test('읽기 전용 폴백: 폴백 앞 복사본 초기화 뒤에도 높음이 최종 결과에 남는다(주 검토 실패, 폴백 성공)', async t => {
  const s = setup(t);
  s.setConfig({ ...DEFAULT_CONFIG, ...review({ 검토도구: 'gemini', 폴백도구: 'codex' }) });
  const res = await s.review({ PATH: s.noSandboxPath, FAKE_MODE_AGY: 'fail', FAKE_WRITE_AGY: 'edited.txt' }, { author: 'claude' });
  assert.equal(res.tool, 'codex');
  assert.deepEqual(res.attempts.map(a => [a.tool, a.ok]), [['gemini', false], ['codex', true]]);
  assert.deepEqual(res.findings.filter(f => f.level === '높음'), [{ level: '높음', text: '다른 도구 검토 뒤 복사본이 바뀜: edited.txt' }]);
});

const all = limits('claude', 'codex', 'gemini');

test('번갈아보기를 적지 않으면 gemini가 주 검토(--model gemini-4-argon-medium, --effort 없음), 한도로 실패하면 codex가 gpt-6.1-sol medium으로 폴백한다', async t => {
  const s = setup(t);
  s.setConfig(all);
  const res = await s.review({ PATH: s.noSandboxPath, FAKE_MODE_AGY: 'limit' });
  const seen = observed(res);
  assert.equal(res.tool, 'codex');
  assert.deepEqual(res.attempts.map(a => [a.tool, a.ok]), [['gemini', false], ['codex', true]]);
  assert.equal(valueAfter(seen.args, '-m'), 'gpt-6.1-sol');
  assert.equal(valueAfter(seen.args, '-c'), 'model_reasoning_effort="medium"');
  const first = await s.review({ PATH: s.noSandboxPath });
  assert.equal(valueAfter(observed(first).args, '--model'), 'gemini-4-argon-medium');
  assert.equal(observed(first).args.includes('--effort'), false);
});

test('모델·추론은 자리가 아니라 도구로 고른다: 검토도구면 바깥 값, 폴백으로 불리면 폴백 값(없으면 바깥 값)', async t => {
  const s = setup(t);
  const cases = [
    ['gemini 폴백: 폴백모델', { 검토도구: 'codex', 폴백도구: 'gemini', 바깥모델: 'gpt-x', 폴백모델: 'gem-f' }, '--model', 'gem-f'],
    ['gemini 폴백: 폴백 값 없으면 바깥모델', { 검토도구: 'codex', 폴백도구: 'gemini', 바깥모델: 'gpt-x' }, '--model', 'gpt-x'],
    ['codex 폴백: 폴백모델', { 검토도구: 'gemini', 폴백도구: 'codex', 바깥모델: 'gem-o', 폴백모델: 'gpt-f', 폴백추론: 'low' }, '-m', 'gpt-f'],
    ['codex 폴백: 폴백추론', { 검토도구: 'gemini', 폴백도구: 'codex', 바깥모델: 'gem-o', 바깥추론: 'high', 폴백추론: 'low' }, '-c', 'model_reasoning_effort="low"'],
    ['codex 폴백: 폴백 값 없으면 바깥 값', { 검토도구: 'gemini', 폴백도구: 'codex', 바깥모델: 'gem-o', 바깥추론: 'high' }, '-c', 'model_reasoning_effort="high"'],
  ];
  for (const [name, config, flag, expected] of cases) {
    s.setConfig({ ...all, 단계모델: { 번갈아보기: config } });
    const res = await s.review({ PATH: s.noSandboxPath, [config.검토도구 === 'gemini' ? 'FAKE_MODE_AGY' : 'FAKE_MODE_CODEX']: 'limit' });
    assert.equal(res.attempts.length, 2, name);
    assert.equal(valueAfter(observed(res).args, flag), expected, name);
  }
});
