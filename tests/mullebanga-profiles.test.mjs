import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { taskInfo } from '../templates/harness/mullebanga-steps.mjs';
import { setup as runSetup } from './run-fixture.mjs';
import { setup as reviewSetup, observed, valueAfter, DEFAULT_CONFIG } from './review-fixture.mjs';

const starts = s => s.called().filter(call => call.ph === 'start');
const build = s => starts(s).find(call => call.stage === 'build');
const model = call => valueAfter(call.args, call.tool === 'codex' ? '-m' : '--model');
const effort = call => call.tool === 'codex' ? valueAfter(call.args, '-c') : valueAfter(call.args, '--effort');
const noSandbox = process.platform === 'win32' && '제미나이 쓰기는 맥 sandbox-exec가 필요하다';
const template = JSON.parse(fs.readFileSync(new URL('../templates/harness/config.json', import.meta.url)));

test('실제 CLI 경계: 실행 도구별 프로필과 임의 모델 ID·추론, 클로드 프로필 생략 시 기존값', { skip: noSandbox }, async t => {
  for (const tool of ['codex', 'gemini', 'claude']) {
    const s = runSetup(t, { tools: [tool] });
    s.editConfig(config => {
      config.도구별단계모델 = {
        codex: { build: { model: 'future-codex-id', effort: 'high' } },
        gemini: { 구현: { 모델: 'future-gemini-id', 추론: 'low' } },
      };
    });
    const result = await s.run(['--도구', tool, 'T-1']);
    assert.equal(result.json[0].raised, true, result.stdout + result.stderr);
    const call = build(s);
    assert.equal(model(call), { codex: 'future-codex-id', gemini: 'future-gemini-id', claude: 'sonnet' }[tool]);
    assert.equal(effort(call), { codex: 'model_reasoning_effort="high"', gemini: 'low', claude: 'medium' }[tool]);
    if (tool === 'codex') assert.ok(!starts(s).find(c => c.stage === 'spec').args.includes('-m'));
  }
  const s = runSetup(t, { tools: ['claude'] });
  s.editConfig(config => { config.도구별단계모델 = { claude: { build: { model: 'future-claude-id', effort: 'high' } } }; });
  await s.run(['--도구', 'claude', 'T-1']);
  assert.equal(model(build(s)), 'future-claude-id');
  assert.equal(effort(build(s)), 'high');
});

test('실제 CLI 경계: 명시 도구는 프로필보다 우선하고 부분 프로필에 클로드 모델을 섞지 않는다', async t => {
  const s = runSetup(t, { tools: ['claude'] });
  s.editConfig(config => {
    config.도구별단계모델 = { claude: { build: { model: 'ignored' } }, codex: { review: { effort: 'high' } } };
    config.단계모델.만들기 = { tool: 'codex', model: 'explicit-model', effort: 'low' };
  });
  await s.run(['--도구', 'claude', 'T-1']);
  assert.equal(build(s).tool, 'codex');
  assert.equal(model(build(s)), 'explicit-model');
  const partial = runSetup(t);
  partial.editConfig(config => { config.도구별단계모델 = { codex: { build: { effort: 'high' } } }; });
  await partial.run(['--도구', 'codex', 'T-1']);
  assert.equal(build(partial).args.includes('-m'), false);
  assert.equal(effort(build(partial)), 'model_reasoning_effort="high"');
});

test('실제 바깥 CLI: 실행 프로필의 검토·폴백과 추론, 작성 도구 제외, 기존 명시 도구 우선', async t => {
  const s = reviewSetup(t);
  const profile = { model: 'writer-model', reviewTool: 'gemini', outsideModel: 'future-review-id', outsideEffort: 'high', fallbackTool: 'codex', fallbackModel: 'future-fallback-id', fallbackEffort: 'low' };
  const config = { ...structuredClone(DEFAULT_CONFIG), 도구별단계모델: { gemini: { review: profile } } };
  s.setConfig(config);
  const input = { tool: 'gemini', author: 'claude' };
  const first = await s.review({ PATH: s.noSandboxPath }, input);
  assert.equal(first.tool, 'gemini');
  assert.equal(model(observed(first)), 'future-review-id');
  assert.equal(effort(observed(first)), 'high');
  const fallback = await s.review({ PATH: s.noSandboxPath, FAKE_MODE_AGY: 'limit' }, input);
  assert.deepEqual(fallback.attempts.map(a => a.tool), ['gemini', 'codex']);
  assert.equal(model(observed(fallback)), 'future-fallback-id');
  assert.equal(effort(observed(fallback)), 'model_reasoning_effort="low"');
  const excluded = await s.review({ PATH: s.noSandboxPath }, { ...input, author: 'gemini' });
  assert.deepEqual(excluded.attempts.map(a => a.tool), ['codex']);
  config.단계모델.번갈아보기 = { tool: 'claude', reviewTool: 'codex', outsideModel: 'legacy-review-id', outsideEffort: 'medium' };
  s.setConfig(config);
  const override = await s.review({}, input);
  assert.equal(override.tool, 'codex');
  assert.equal(model(observed(override)), 'legacy-review-id');
});

test('본체가 실제 작성 도구와 별개로 --도구 프로필을 바깥 검토에 전달한다', async t => {
  const s = runSetup(t, { tools: ['claude'] });
  s.editConfig(config => {
    config.단계모델.만들기 = { tool: 'codex' };
    config.도구별단계모델 = { claude: { review: { model: 'opus', reviewTool: 'gemini', outsideModel: 'selected-profile-review' } } };
  });
  const result = await s.run(['--도구', 'claude', 'T-1']);
  assert.equal(result.json[0].raised, true);
  assert.equal(model(starts(s).find(c => c.stage === 'other')), 'selected-profile-review');
});

test('Claude 바깥 검토·폴백의 명시 모델·추론과 비-Claude override 격리', async t => {
  const cases = [
    ['바깥 검토', { 도구별단계모델: { codex: { 번갈아보기: { 검토도구: 'claude', 바깥모델: 'claude-sonnet-5-5', 바깥추론: 'high' } } } }, 'codex', {}, 'claude-sonnet-5-5', 'high'],
    ['폴백', { 도구별단계모델: { gemini: { 번갈아보기: { 검토도구: 'codex', 폴백도구: 'claude', 폴백모델: 'claude-future', 폴백추론: 'low' } } } }, 'gemini', { FAKE_MODE_CODEX: 'limit' }, 'claude-future', 'low'],
    ['비-Claude 명시 도구', { 단계모델: { 번갈아보기: { 도구: 'codex', 모델: 'gpt-6.1-sol', 깊이: 'high', 검토도구: 'gemini', 폴백도구: 'codex' } } }, 'codex', { FAKE_MODE_AGY: 'limit' }, 'opus', 'medium'],
  ];
  for (const [name, config, tool, env, expectedModel, expectedEffort] of cases) {
    await t.test(name, async t => {
      const s = reviewSetup(t);
      s.setConfig({ ...structuredClone(DEFAULT_CONFIG), ...config });
      const result = await s.review({ PATH: s.noSandboxPath, ...env }, { tool, author: tool });
      assert.equal(result.tool, 'claude');
      const call = observed(result);
      assert.equal(model(call), expectedModel);
      assert.equal(effort(call), expectedEffort);
    });
  }
});

test('신규 템플릿 프로필로 전 단계 실행, 클로드 폴백과 잠정 후보 표시', { skip: noSandbox }, async t => {
  assert.match(template.도구별단계모델.설명, /실제 비교 전 잠정 후보/);
  for (const tool of ['codex', 'gemini']) {
    const s = runSetup(t, { tools: [tool] });
    s.editConfig(config => { config.도구별단계모델 = template.도구별단계모델; });
    s.scenario({ 'T-1': { review: [{ payload: { findings: [{ level: '높음', text: '고치기 호출 확인' }] } }, { payload: { findings: [] } }] } });
    const result = await s.run(['--도구', tool, 'T-1']);
    assert.equal(result.json[0].raised, true, result.stdout + result.stderr);
    assert.equal(result.json[0].fixes, 1);
    for (const call of starts(s).filter(c => c.stage !== 'other')) {
      const expected = tool === 'codex' ? 'gpt-6.1-sol' : 'gemini-4-argon-medium';
      assert.equal(model(call), expected, `${tool}:${call.stage}`);
    }
  }
  const s = reviewSetup(t);
  s.setConfig({ ...DEFAULT_CONFIG, 도구별단계모델: template.도구별단계모델 });
  for (const [tool, failEnv, firstTool] of [['codex', { FAKE_MODE_AGY: 'limit' }, 'gemini'], ['gemini', { FAKE_MODE_CODEX: 'limit' }, 'codex']]) {
    const fallback = await s.review({ PATH: s.noSandboxPath, ...failEnv }, { tool, author: tool });
    assert.deepEqual(fallback.attempts.map(a => a.tool), [firstTool, 'claude']);
    assert.equal(model(observed(fallback)), 'opus');
    assert.equal(effort(observed(fallback)), 'medium');
  }
});

test('작업별 --모델·--깊이는 만들기·고치기에서만 단계 기본값보다 우선하고 다른 도구 명시 override에는 섞이지 않는다', async t => {
  const s = runSetup(t, { tools: ['codex'] });
  s.editConfig(config => { config.도구별단계모델 = template.도구별단계모델; });
  s.ledger('추가', '작업별 모델 시험', '--고칠곳', 'src', '--확인방법', '시험', '--모델', 'gpt-6.1-terra', '--깊이', 'low');
  s.ledger('시작', 'T-2', '--맡길곳', 'codex');
  fs.copyFileSync(`${s.dir}/docs/tasks/T-1.md`, `${s.dir}/docs/tasks/T-2.md`);
  assert.deepEqual(taskInfo(s.dir, 'T-2'), { status: '진행중', tool: 'codex', model: 'gpt-6.1-terra', effort: 'low', waiting: [], rejected: false });
  s.scenario({ 'T-2': { review: [{ payload: { findings: [{ level: '높음', text: '한 번 고치기' }] } }, { payload: { findings: [] } }] } });
  const result = await s.run(['--도구', 'codex', 'T-2']);
  assert.equal(result.json[0].raised, true, result.stdout + result.stderr);
  const byStage = stage => starts(s).find(c => c.id === 'T-2' && c.stage === stage);
  for (const stage of ['build', 'fix']) {
    assert.equal(model(byStage(stage)), 'gpt-6.1-terra', stage);
    assert.equal(effort(byStage(stage)), 'model_reasoning_effort="low"', stage);
  }
  for (const stage of ['spec', 'specReview', 'review']) {
    assert.equal(model(byStage(stage)), 'gpt-6.1-sol', stage);
    assert.equal(effort(byStage(stage)), 'model_reasoning_effort="medium"', stage);
  }
  assert.equal(byStage('evidence'), undefined);

  s.editConfig(config => { config.단계모델.만들기 = { 도구: 'claude' }; });
  s.ledger('추가', '명시 도구 불일치', '--고칠곳', 'src', '--확인방법', '시험', '--모델', 'gpt-6.1-terra', '--깊이', 'low');
  s.ledger('시작', 'T-3', '--맡길곳', 'codex');
  fs.copyFileSync(`${s.dir}/docs/tasks/T-1.md`, `${s.dir}/docs/tasks/T-3.md`);
  await s.run(['--도구', 'codex', 'T-3']);
  assert.equal(model(starts(s).find(c => c.id === 'T-3' && c.stage === 'build')), 'sonnet');
});
