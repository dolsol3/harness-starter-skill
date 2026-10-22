import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const templatePath = fileURLToPath(new URL('../templates/workflows/mullebanga.js', import.meta.url));
const localCopyPath = fileURLToPath(new URL('../.claude/workflows/mullebanga.js', import.meta.url));
const configTemplatePath = fileURLToPath(new URL('../templates/harness/config.json', import.meta.url));

const source = fs.readFileSync(templatePath, 'utf8');
const [metaHead, metaText] = source.match(/^export const meta = (\{[\s\S]*?\n\});\n/);
const meta = Function(`return ${metaText}`)();
const body = source.slice(metaHead.length);
const AsyncFunction = (async () => {}).constructor;
const script = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body);

const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => {
  let result = item;
  for (const stage of stages) result = await stage(result, item, index).catch(() => null);
  return result;
}));
const parallel = thunks => Promise.all(thunks.map(thunk => thunk().catch(() => null)));

async function run({ args, picked = ['T-1'], pickExtra = {}, checks = [], reviews = [], spec = {}, specReview = {}, resumed = {} } = {}) {
  const calls = [];
  const built = prompt => {
    const id = prompt.match(/T-\d+/)[0];
    return { worktree: `/repo/.claude/worktrees/wf_1-${id}`, worktreeBranch: `worktree-wf_1-${id}`, branch: `ai/work-${id}`, commit: 'c0' };
  };
  const answers = {
    '작업 고르기': () => ({ tasks: picked, ...pickExtra }),
    '기획 담당': () => ({ outcome: '썼음', reason: '', rejectedCommit: '', rejectedReason: '', pendingQuestions: [], ...spec }),
    '살피기 담당 맞춰보기': () => ({ passed: true, findings: [], ...specReview }),
    '만들기 담당': built,
    '만들기 담당 이어 고치기': prompt => ({ ...built(prompt), stopReason: '', ...resumed }),
    '돌려보기': () => checks.shift() ?? { passed: true, failures: '' },
    '살피기 담당': () => ({ findings: reviews.shift() ?? [] }),
    '다른 도구 검토': () => ({ tool: 'codex', findings: [] }),
    '고치기': () => ({ commit: `c${calls.length}` }),
    '올림': () => ({ raised: true, output: '올림: ok' }),
  };
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    return answers[opts.label.replace(/ T-\d+.*$/, '')](prompt);
  };
  const result = await script(agent, pipeline, parallel, () => {}, () => {}, args);
  return { result, calls };
}

test('local copy .claude/workflows/mullebanga.js is byte-for-byte identical to templates/workflows/mullebanga.js', () => {
  if (fs.existsSync(localCopyPath)) assert.equal(fs.readFileSync(localCopyPath, 'utf8'), source);
});

test('meta.phases titles and all 10 agent labels use easy Korean stage names and role titles', async () => {
  assert.deepEqual(
    meta.phases.map(entry => entry.title),
    ['고르기', '할 일 적기', '맞춰보기', '만들기', '돌려보기', '번갈아 보기', '고치기', '올림'],
  );
  const { calls } = await run({ checks: [{ passed: false, failures: 'fail' }] });
  const resumed = await run({ args: ['T-1'], spec: { rejectedCommit: 'abc1234', rejectedReason: 'fix' } });
  const labels = [...calls, ...resumed.calls].map(call => call.label);
  for (const expected of [
    '작업 고르기',
    '기획 담당 T-1',
    '살피기 담당 맞춰보기 T-1',
    '만들기 담당 T-1',
    '만들기 담당 이어 고치기 T-1',
    '돌려보기 T-1 1번째',
    '살피기 담당 T-1 1번째',
    '다른 도구 검토 T-1 1번째',
    '고치기 T-1 1번째',
    '올림 T-1',
  ]) {
    assert.ok(labels.includes(expected), `missing label: ${expected}`);
  }
});

test('default stage models in mullebanga.js match templates/harness/config.json 단계모델 defaults', async () => {
  const cfg = JSON.parse(fs.readFileSync(configTemplatePath, 'utf8')).단계모델;
  const { calls } = await run({ checks: [{ passed: false, failures: 'fail' }] });
  const resumedCall = (await run({ args: ['T-1'], spec: { rejectedCommit: 'abc1234', rejectedReason: 'fix' } }))
    .calls.find(call => call.label.startsWith('만들기 담당 이어 고치기'));
  const byLabel = prefix => calls.find(call => call.label.startsWith(prefix));
  const pairs = [
    [byLabel('작업 고르기'), cfg.고르기],
    [byLabel('기획 담당'), cfg.할일적기],
    [byLabel('살피기 담당 맞춰보기'), cfg.맞춰보기],
    [byLabel('만들기 담당 T-1'), cfg.만들기],
    [resumedCall, cfg.만들기],
    [byLabel('돌려보기'), cfg.돌려보기],
    [byLabel('살피기 담당 T-1'), cfg.번갈아보기],
    [byLabel('고치기'), cfg.고치기],
    [byLabel('올림'), cfg.올림],
  ];
  for (const [call, stageCfg] of pairs) {
    assert.deepEqual({ model: call.model, effort: call.effort }, { model: stageCfg.모델, effort: stageCfg.깊이 }, call.label);
  }
});

test('단계모델 overrides work via args, 작업 고르기, and 기획 담당 with Korean keys (모델·깊이·추론) and aliases (명세/spec, 대조/specReview, 구현/build, 검사/check, 교차리뷰/review, fix, pick, raise, model/effort)', async () => {
  const koreanCfg = {
    고르기: { 모델: 'haiku', 깊이: 'low' },
    할일적기: { 모델: 'opus', 깊이: 'medium' },
    맞춰보기: { 모델: 'sonnet', 추론: 'low' },
    만들기: { 모델: 'opus', 깊이: 'high' },
    돌려보기: { 모델: 'haiku', 추론: 'medium' },
    번갈아보기: { 모델: 'sonnet', 깊이: 'medium' },
    고치기: { 모델: 'opus', 추론: 'low' },
    올림: { 모델: 'haiku', 깊이: 'low' },
  };
  const { calls: fromArgs } = await run({ args: { 단계모델: koreanCfg }, checks: [{ passed: false, failures: 'fail' }] });
  const pickModel = prefix => {
    const hit = fromArgs.find(call => call.label.startsWith(prefix));
    return { model: hit.model, effort: hit.effort };
  };
  assert.deepEqual(pickModel('작업 고르기'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(pickModel('기획 담당'), { model: 'opus', effort: 'medium' });
  assert.deepEqual(pickModel('살피기 담당 맞춰보기'), { model: 'sonnet', effort: 'low' });
  assert.deepEqual(pickModel('만들기 담당 T-1'), { model: 'opus', effort: 'high' });
  assert.deepEqual(pickModel('돌려보기'), { model: 'haiku', effort: 'medium' });
  assert.deepEqual(pickModel('살피기 담당 T-1'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(pickModel('고치기'), { model: 'opus', effort: 'low' });
  assert.deepEqual(pickModel('올림'), { model: 'haiku', effort: 'low' });

  const aliasCfg = {
    pick: { model: 'opus', effort: 'low' },
    명세: { model: 'haiku', effort: 'medium' },
    대조: { model: 'sonnet', effort: 'medium' },
    구현: { model: 'opus', effort: 'low' },
    검사: { model: 'opus', effort: 'medium' },
    교차리뷰: { model: 'haiku', effort: 'high' },
    fix: { model: 'haiku', effort: 'low' },
    raise: { model: 'opus', effort: 'medium' },
  };
  const { calls: fromAliases } = await run({
    args: { tasks: ['T-1'], agents: aliasCfg },
    checks: [{ passed: false, failures: 'fail' }],
  });
  const aliasModel = prefix => {
    const hit = fromAliases.find(call => call.label.startsWith(prefix));
    return { model: hit.model, effort: hit.effort };
  };
  assert.deepEqual(aliasModel('기획 담당'), { model: 'haiku', effort: 'medium' });
  assert.deepEqual(aliasModel('살피기 담당 맞춰보기'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(aliasModel('만들기 담당 T-1'), { model: 'opus', effort: 'low' });
  assert.deepEqual(aliasModel('돌려보기'), { model: 'opus', effort: 'medium' });
  assert.deepEqual(aliasModel('살피기 담당 T-1'), { model: 'haiku', effort: 'high' });
  assert.deepEqual(aliasModel('고치기'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(aliasModel('올림'), { model: 'opus', effort: 'medium' });

  const englishSpecCfg = {
    spec: { model: 'opus', effort: 'low' },
    specReview: { model: 'haiku', effort: 'low' },
    build: { model: 'haiku', effort: 'medium' },
    check: { model: 'opus', effort: 'low' },
    review: { model: 'sonnet', effort: 'low' },
  };
  const { calls: fromPick } = await run({
    pickExtra: { 단계모델: { 맞춰보기: { 모델: 'sonnet', 깊이: 'low' } } },
  });
  assert.deepEqual(
    { model: fromPick.find(c => c.label.startsWith('살피기 담당 맞춰보기')).model, effort: fromPick.find(c => c.label.startsWith('살피기 담당 맞춰보기')).effort },
    { model: 'sonnet', effort: 'low' },
  );
  const { calls: fromSpec } = await run({
    args: ['T-1'],
    spec: { 단계모델: englishSpecCfg, rejectedCommit: 'abc1234', rejectedReason: 'fix' },
  });
  const mergedModel = prefix => {
    const hit = fromSpec.find(call => call.label.startsWith(prefix));
    return { model: hit.model, effort: hit.effort };
  };
  assert.deepEqual(mergedModel('살피기 담당 맞춰보기'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(mergedModel('만들기 담당 이어 고치기'), { model: 'haiku', effort: 'medium' });
  assert.deepEqual(mergedModel('돌려보기'), { model: 'opus', effort: 'low' });
  assert.deepEqual(mergedModel('살피기 담당 T-1'), { model: 'sonnet', effort: 'low' });
});

test('otherReviewPrompt reads 일감목록.동시상한 and 단계모델.번갈아보기, invokes codex with model and effort, and falls back to gemini-4-argon-high on quota/rate-limit or failure', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  assert.match(prompt, /일감목록\.동시상한.*backlog\.limits.*단계모델\.번갈아보기/);
  assert.match(prompt, /codex exec -s read-only --ephemeral -m <바깥모델> -c model_reasoning_effort='"<바깥추론>"' -C <임시>\/copy -o <임시>\/result\.txt - < <임시>\/prompt\.txt/);
  assert.match(prompt, /토큰·한도 부족\(quota·rate limit·usage limit 등\)이나 실행 실패로 검토를 못 하면.*폴백 도구\(`폴백도구`, 기본 `gemini`, 모델 `폴백모델` 기본 `gemini-4-argon-high`\)로 폴백/);
  assert.match(prompt, /cd <임시>\/copy && HARNESS_READ_ONLY=1 agy -p "\$\(cat <임시>\/prompt\.txt\)" --model <폴백모델> --agent readonly --output-format json --print-timeout 5m > <임시>\/result\.txt/);
});
