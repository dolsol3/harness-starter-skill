// 물레방아 워크플로 템플릿을 가짜 agent()로 돌려, 돌려준 결과와 기록된 호출로 흐름을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../templates/workflows/mullebanga.js', import.meta.url)), 'utf8');
const [metaHead, metaText] = source.match(/^export const meta = (\{[\s\S]*?\n\});\n/);
const meta = Function(`return ${metaText}`)();
const body = source.slice(metaHead.length);
const AsyncFunction = (async () => {}).constructor;
const script = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body);

// 실제 계약처럼 단계가 던지면 그 항목은 null, 던진 thunk도 null이 된다.
const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
  let result = item;
  for (const stage of stages) result = await stage(result, item, index).catch(() => null);
  return result;
}));
const parallel = thunks => Promise.all(thunks.map(thunk => thunk().catch(() => null)));

// 장면: checks·reviews는 차례로 꺼내 쓰고 다 쓰면 통과·지적 없음. tool은 다른 도구 검토가 돌려줄 이름.
// skipped는 사용자가 건너뛴 agent의 label(null 반환). spec·specReview·resumed는 각 단계 답에 덮어쓸 칸.
async function run({ args, picked = ['T-5'], checks = [], reviews = [], tool = 'codex', skipped = '', spec = {}, specReview = {}, resumed = {} } = {}) {
  const calls = [];
  const phases = [];
  const built = prompt => {
    const id = prompt.match(/T-\d+/)[0];
    return { worktree: `/repo/.claude/worktrees/wf_1-${id}`, worktreeBranch: `worktree-wf_1-${id}`, branch: `ai/work-${id}`, commit: 'c0' };
  };
  const answers = {
    '작업 고르기': () => ({ tasks: picked }),
    '기획 담당': () => ({ outcome: '썼음', reason: '', rejectedCommit: '', rejectedReason: '', pendingQuestions: [], ...spec }),
    '살피기 담당 맞춰보기': () => ({ passed: true, findings: [], ...specReview }),
    '만들기 담당': built,
    '만들기 담당 이어 고치기': prompt => ({ ...built(prompt), stopReason: '', ...resumed }),
    '돌려보기': () => checks.shift() ?? { passed: true, failures: '' },
    '살피기 담당': () => ({ findings: reviews.shift() ?? [] }),
    '다른 도구 검토': () => ({ tool, findings: [] }),
    '고치기': () => ({ commit: `c${calls.length}` }),
    '올림': () => ({ raised: true, output: '올림: ok' }),
  };
  // label에서 작업 번호부터 뒤를 떼면 단계 이름이 남는다. 그래서 '살피기 담당 맞춰보기'는 번갈아 보기의 '살피기 담당' 답을 타지 않는다.
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    if (opts.label === skipped) return null;
    return answers[opts.label.replace(/ T-\d+.*$/, '')](prompt);
  };
  const result = await script(agent, pipeline, parallel, title => phases.push(title), () => {}, args);
  return { result, calls, phases: [...phases, ...calls.map(call => call.phase)] };
}

const raises = calls => calls.filter(call => call.prompt.includes('backlog.mjs 올림'));
const fixes = calls => calls.filter(call => call.label.startsWith('고치기'));
const high = text => ({ level: '높음', text });
const ledgerCommand = names => new RegExp(`backlog\\.mjs (${names})(?=[\\s\`]|$)`, 'm');

test('meta is a pure literal named 물레방아 whose phases are exactly the phases the agents are grouped under', async () => {
  const valuesLeft = metaText.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/\w+:/g, '');
  assert.match(valuesLeft, /^[\s{}[\],']*$/, 'meta may hold only literal strings, arrays and objects');
  assert.equal(meta.name, '물레방아');
  assert.ok(meta.description);
  const { phases } = await run({ checks: [{ passed: false, failures: 'x' }] });
  assert.deepEqual(new Set(phases), new Set(meta.phases.map(entry => entry.title)));
});

test('args runs only the given tasks without a picking agent; without args the picking agent goes first', async () => {
  const given = await run({ args: ['T-30', 'T-31'] });
  assert.ok(given.calls.every(call => call.phase !== '고르기'));
  assert.deepEqual(given.result.map(task => task.id), ['T-30', 'T-31']);
  const picked = await run({ picked: ['T-7'] });
  assert.equal(picked.calls[0].phase, '고르기');
  assert.match(picked.calls[0].prompt, /목록 --상태 진행중/);
  assert.deepEqual(picked.result.map(task => task.id), ['T-7']);
});

test('args given as one line of text is split on spaces and commas into the tasks, without a picking agent', async () => {
  for (const [args, ids] of [['T-28', ['T-28']], ['T-28, T-29', ['T-28', 'T-29']]]) {
    const { calls, result } = await run({ args });
    assert.ok(calls.every(call => call.phase !== '고르기'), args);
    assert.deepEqual(result.map(task => task.id), ids);
  }
});

test('the implementer works in its own worktree; the reviewer and a break-it other-tool review look separately', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const build = calls.find(call => call.phase === '만들기');
  assert.equal(build.agentType, 'implementer');
  assert.equal(build.isolation, 'worktree');
  const reviews = calls.filter(call => call.phase === '번갈아 보기');
  assert.deepEqual(reviews.map(call => call.agentType), ['reviewer', undefined]);
  const other = reviews.find(call => call.agentType !== 'reviewer');
  assert.match(other.prompt, /backlog\.limits/);
  assert.match(other.prompt, /복사본 안에서 깨뜨려 보는 검토/);
  assert.match(other.prompt, /-s workspace-write/);
});

test('the other tool runs in a throwaway clone outside the worktree, which is checked (gemini only) and removed', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  const lines = prompt.split('\n');
  const line = text => lines.find(each => each.includes(text)) ?? '';
  assert.match(prompt, /mktemp -d/);
  assert.match(prompt, /cd \/repo\/\.claude\/worktrees\/wf_1-T-1 && git clone --no-hardlinks \. <임시>\/copy/);
  assert.match(prompt, /cd <임시>\/copy && git checkout --detach c0/);
  assert.match(line('prompt.txt'), /<임시>\/prompt\.txt.*<임시>\/result\.txt.*복사본 밖/);
  assert.match(line('codex exec'), /-s workspace-write .*-C <임시>\/copy -o <임시>\/result\.txt - < <임시>\/prompt\.txt/);
  assert.match(line('--agent breaker'), /cd <임시>\/copy && sandbox-exec -f <임시>\/sb\.sb env TMPDIR=<임시>\/tmp agy -p .* --agent breaker --output-format json --print-timeout 25m --log-file <임시>\/agy\.log > <임시>\/result\.txt; echo \$\? > <임시>\/done/);
  assert.match(line('--agent readonly --output-format'), /cd <임시>\/copy && HARNESS_READ_ONLY=1 agy -p .* --agent readonly --output-format json --print-timeout 5m > <임시>\/result\.txt/);
  assert.match(line('readonly.md`가 없으면'), /없으면 부르지 않고.*중간.*읽기 전용 역할 파일 없음/);
  assert.match(line('git status --porcelain'), /^4\. 읽기 전용 경로의 gemini면 .*cd <임시>\/copy && git status --porcelain.*높음.*깨뜨려 보기 경로\(Codex·gemini\)는 .* 확인을 하지 않는다/);
  assert.equal(lines.filter(each => each.includes('git status')).length, 1);
  assert.match(line('rm -rf'), /끝나거나 실패해도 `rm -rf <임시>`/);
  assert.match(line('cd·지우기'), /복사본 만들기·cd·지우기가 막히거나 실패하면.*tool은 빈 문자열, 지적은 중간 하나로 "다른 도구 검토 실패: <이유>"/);
});

test('a failed check goes to a fix and back to the check, then a clean pass raises once', async () => {
  const { calls, result } = await run({ args: ['T-1'], checks: [{ passed: false, failures: 'tests failed' }] });
  const steps = calls.map(call => call.phase);
  assert.deepEqual(steps.slice(0, 6), ['할 일 적기', '맞춰보기', '만들기', '돌려보기', '고치기', '돌려보기']);
  assert.match(fixes(calls)[0].prompt, /tests failed/);
  assert.equal(raises(calls).length, 1);
  assert.equal(result[0].fixes, 1);
  assert.equal(result[0].raised, true);
});

test('high findings that keep coming stop after 3 fixes, are not raised, and are reported', async () => {
  const always = Array.from({ length: 10 }, () => [high('wrong')]);
  const { calls, result } = await run({ args: ['T-1'], reviews: always });
  assert.equal(fixes(calls).length, 3);
  assert.equal(raises(calls).length, 0);
  assert.equal(result[0].raised, false);
  assert.deepEqual(result[0].highs.map(finding => finding.text), ['wrong']);
});

test('check failures and high fixes share the same limit of 3', async () => {
  const failed = { passed: false, failures: 'lint' };
  const { calls, result } = await run({ args: ['T-1'], checks: [failed, { passed: true, failures: '' }, failed], reviews: [[high('a')], [high('b')]] });
  assert.equal(fixes(calls).length, 3);
  assert.equal(raises(calls).length, 0);
  assert.equal(result[0].fixes, 3);
  assert.deepEqual(result[0].highs.map(finding => finding.text), ['b']);
});

test('medium and low findings are not fixed: the task is raised and the findings come back', async () => {
  const findings = [{ level: '중간', text: 'name' }, { level: '낮음', text: 'comment' }];
  const { calls, result } = await run({ args: ['T-1'], reviews: [findings] });
  assert.equal(fixes(calls).length, 0);
  assert.equal(raises(calls).length, 1);
  assert.deepEqual(result[0].others, findings);
});

test('no prompt writes the ledger beyond 올림, apart from the planner asking 허락·확인 and logging 기록, or uses git -C; every step after building runs each command as one cd && line', async () => {
  const { calls, result } = await run({ checks: [{ passed: false, failures: 'x' }], reviews: [[high('h')]] });
  const resumedRun = await run({ args: ['T-1'], spec: { rejectedCommit: 'abc1234', rejectedReason: 'r' } });
  for (const { prompt, agentType, label } of [...calls, ...resumedRun.calls]) {
    assert.doesNotMatch(prompt, ledgerCommand('추가|시작|완료|반려|다시하기|답|질문|처리함'), label);
    if (agentType !== 'planner') assert.doesNotMatch(prompt, ledgerCommand('허락|확인|기록'), label);
    assert.doesNotMatch(prompt, /git -C/, label);
  }
  const planner = calls.find(call => call.agentType === 'planner');
  for (const name of ['허락', '확인', '기록']) assert.match(planner.prompt, ledgerCommand(name));
  assert.match('`node harness/backlog.mjs 완료`', ledgerCommand('완료'), 'a command closed by a backtick is still caught');
  const steps = calls.filter(call => ['돌려보기', '번갈아 보기', '고치기', '올림'].includes(call.phase));
  assert.deepEqual(new Set(steps.map(call => call.label.split(' ')[0])), new Set(['돌려보기', '살피기', '다른', '고치기', '올림']));
  for (const call of steps) {
    assert.ok(call.prompt.includes(`명령마다 \`cd ${result[0].worktree} && <명령>\` 한 줄로`), call.label);
    assert.doesNotMatch(call.prompt, /` 한 뒤/, call.label);
  }
  assert.doesNotMatch(body, /Date\.now|Math\.random|new Date\(\)|\bimport\b|\brequire\(/);
});

test('맞춰보기 and 번갈아 보기 살피기 담당 run on opus high; every other claude step, the resumed fix included, runs on sonnet high', async () => {
  const { calls } = await run({ checks: [{ passed: false, failures: 'x' }] });
  const resumed = (await run({ args: ['T-1'], spec: { rejectedCommit: 'abc1234', rejectedReason: 'r' } })).calls.find(call => call.label.includes('이어 고치기'));
  assert.deepEqual(new Set(calls.map(call => call.phase)), new Set(meta.phases.map(entry => entry.title)));
  for (const { agentType, model, effort, label } of [...calls, resumed]) assert.deepEqual({ model, effort }, label.startsWith('다른 도구 검토') ? { model: undefined, effort: undefined } : { model: agentType === 'reviewer' ? 'opus' : 'sonnet', effort: 'high' }, label);
});

test('each task result names the task, worktree, both branches, commit, fixes and whether it was raised', async () => {
  const { result } = await run({ args: ['T-1'], checks: [{ passed: false, failures: 'x' }] });
  assert.equal(result[0].id, 'T-1');
  assert.equal(result[0].worktree, '/repo/.claude/worktrees/wf_1-T-1');
  assert.deepEqual(result[0].branches, ['ai/work-T-1', 'worktree-wf_1-T-1']);
  assert.notEqual(result[0].commit, 'c0', 'the commit is the one after the fix');
  assert.equal(result[0].fixes, 1);
  assert.equal(result[0].raised, true);
});

test('the name, phase titles and every agent label are Korean, apart from task numbers and counts', async () => {
  const { calls } = await run({ checks: [{ passed: false, failures: 'x' }] });
  const korean = /^[가-힣 ]+$/;
  assert.match(meta.name, korean);
  for (const { title } of meta.phases) assert.match(title, korean);
  for (const { label } of calls) assert.match(label.replace(/T-\d+|\d+/g, '').trim(), korean, label);
});

test('a returned review tool is named in 올림 with --검토; a skipped review raises without --검토', async () => {
  const reviewed = await run({ args: ['T-1'], tool: 'codex' });
  assert.match(raises(reviewed.calls)[0].prompt, /--검토 codex/);
  const skipped = await run({ args: ['T-1'], tool: '' });
  assert.equal(raises(skipped.calls).length, 1);
  assert.doesNotMatch(raises(skipped.calls)[0].prompt, /--검토/);
});

test('a task whose agent was skipped comes back as stopped by number, and the other tasks still finish', async () => {
  const { result } = await run({ args: ['T-1', 'T-2'], skipped: '살피기 담당 T-1 1번째' });
  assert.deepEqual(result[0], { id: 'T-1', stopped: true });
  assert.equal(result[1].id, 'T-2');
  assert.equal(result[1].raised, true);
});

test('a skipped implementer stops its task before any check, review or 올림 runs', async () => {
  const { calls, result } = await run({ args: ['T-1'], skipped: '만들기 담당 T-1' });
  assert.deepEqual(result, [{ id: 'T-1', stopped: true }]);
  assert.deepEqual(calls.map(call => call.phase), ['할 일 적기', '맞춰보기', '만들기']);
});

test('the planner (no isolation) and the reviewer check the spec before the implementer; a spec that already has 끝 기준 is skipped, not written', async () => {
  const { calls, result } = await run({ args: ['T-1'], spec: { outcome: '건너뜀' } });
  const firstThree = calls.slice(0, 3).map(call => [call.phase, call.agentType, call.isolation]);
  assert.deepEqual(firstThree, [['할 일 적기', 'planner', undefined], ['맞춰보기', 'reviewer', undefined], ['만들기', 'implementer', 'worktree']]);
  assert.match(calls[0].prompt, /`## 끝 기준`이 이미 있으면 명세를 쓰지 않고 건너뜀/);
  assert.equal(result[0].spec.outcome, '건너뜀');
  assert.deepEqual(result[0].specReview, { passed: true, findings: [] });
  assert.equal(result[0].resumed, false);
  assert.equal(result[0].raised, true);
  assert.match(calls[1].prompt, /`## 사용자 원래 말` 절이 없으면 .*실패/);
});

test('the planner writes docs/tasks/T-N.md in the main folder, keeps the user words, does not commit, asks 허락 and stops for the five, leaves 확인 and goes on for the three, and logs the rest in 기록', async () => {
  const { calls } = await run({ args: ['T-3'] });
  const { prompt } = calls.find(call => call.phase === '할 일 적기');
  assert.match(prompt, /보기 T-3/);
  assert.match(prompt, /메인 폴더\(.*\)의 `docs\/tasks\/T-3\.md`에 나머지를 쓴다/);
  assert.match(prompt, /맨 위 `## 사용자 원래 말` 절은 한 글자도 바꾸지 않는다/);
  assert.match(prompt, /명세는 커밋하지 않는다/);
  assert.match(prompt, /지우거나 바꾸는 일.*약속.*배포·발송·게시.*돈.*지키는 장치.*backlog\.mjs 허락 T-3.*--행동 .*그 작업은 멈춘다/);
  assert.match(prompt, /문서끼리 말이 달라.*개인정보.*새 의존성.*아키텍처.*backlog\.mjs 확인 T-3.*--까닭 문서충돌\|실데이터\|구조변경.*그 작업은 멈추지 않는다/);
  assert.match(prompt, /그 밖의 결정.*backlog\.mjs 기록 T-3/);
  assert.doesNotMatch(prompt, /다시 묻지/);
  assert.match(prompt, /`반려: <커밋> <사유>` 줄/);
});

test('a spec review with a high or medium finding stops the task before the implementer with the reason; low findings go on to build', async () => {
  const failed = [{ passed: false, findings: [high('사용자 원래 말 절 없음')] }, { passed: true, findings: [{ level: '중간', text: '출처 없음' }] }];
  for (const specReview of failed) {
    const { calls, result } = await run({ args: ['T-1'], specReview });
    assert.deepEqual(calls.map(call => call.phase), ['할 일 적기', '맞춰보기']);
    assert.equal(result[0].stopped, true);
    assert.match(result[0].reason, /맞춰보기 실패/);
    assert.deepEqual(result[0].specReview, specReview);
    assert.equal(result[0].worktree, undefined);
  }
  const low = { passed: true, findings: [{ level: '낮음', text: '말투' }] };
  const { result } = await run({ args: ['T-1'], specReview: low });
  assert.equal(result[0].raised, true);
  assert.deepEqual(result[0].specReview, low);
});

test('a spec step that stops for 허락 or an experiment runs no spec review or implementer and comes back with its reason, not null', async () => {
  for (const outcome of ['허락', '실험 필요']) {
    const { calls, result } = await run({ args: ['T-1'], spec: { outcome, reason: '배포를 묻는다' } });
    assert.deepEqual(calls.map(call => call.phase), ['할 일 적기']);
    assert.deepEqual(Object.keys(result[0]).sort(), ['id', 'reason', 'spec', 'stopped']);
    assert.match(result[0].reason, new RegExp(`${outcome}.*배포를 묻는다`));
    assert.equal(result[0].spec.outcome, outcome);
  }
});

test('a rejected task is fixed on its rejected ai/ branch by an implementer without isolation; if the branch or worktree is lost the task stops with the reason', async () => {
  const spec = { outcome: '건너뜀', rejectedCommit: 'abc1234', rejectedReason: '중간 한 줄' };
  const { calls, result } = await run({ args: ['T-1'], spec });
  const build = calls.find(call => call.phase === '만들기');
  assert.deepEqual([build.label, build.agentType, build.isolation], ['만들기 담당 이어 고치기 T-1', 'implementer', undefined]);
  for (const text of ['git branch --contains abc1234', '둘 이상이면 멈춘다', 'git worktree list', 'git worktree add', '반려 사유만 고친다', '중간 한 줄', 'stopReason']) assert.ok(build.prompt.includes(text), text);
  assert.equal(result[0].resumed, true);
  assert.equal(result[0].raised, true);
  const lost = await run({ args: ['T-1'], spec, resumed: { stopReason: 'ai/ 브랜치가 없다' } });
  assert.deepEqual(lost.calls.map(call => call.phase), ['할 일 적기', '맞춰보기', '만들기']);
  assert.equal(lost.result[0].stopped, true);
  assert.match(lost.result[0].reason, /ai\/ 브랜치가 없다/);
});

test('a task rerun while its question still waits stops at the spec step even though the spec already has 끝 기준', async () => {
  const waiting = 'Q-1 [대기] T-1 외부발행 배포할까  (추천: 가)';
  const { calls, result } = await run({ args: ['T-1'], spec: { outcome: '건너뜀', pendingQuestions: [waiting] } });
  assert.deepEqual(calls.map(call => call.phase), ['할 일 적기']);
  assert.equal(result[0].stopped, true);
  assert.match(result[0].reason, /답을 기다리는 질문.*Q-1 \[대기\]/);
  const lines = calls[0].prompt.split('\n');
  const at = text => lines.findIndex(line => line.includes(text));
  assert.ok(at('[대기]') >= 0 && at('[대기]') < at('`## 끝 기준`이 이미 있으면'), 'waiting questions are checked before 끝 기준');
});

test('the planner and the spec reviewer read the whole docs/tasks/T-N.md in the main folder when 보기 is cut off, so a long spec keeps its 끝 기준', async () => {
  const { calls } = await run({ args: ['T-7'] });
  for (const phase of ['할 일 적기', '맞춰보기']) assert.match(calls.find(call => call.phase === phase).prompt, /보기 T-7.*출력이 잘리면\(`…줄 더 있다` 안내가 보이면\) 메인 폴더\(.*\)의 `docs\/tasks\/T-7\.md` 전체를 읽는다/, phase);
});
