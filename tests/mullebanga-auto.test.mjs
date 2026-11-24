import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './run-fixture.mjs';
import { runDirect } from '../templates/harness/mullebanga-direct.mjs';
import { statsFile, selectModel, recordCall, markQuality, sampleId, transaction } from '../templates/harness/mullebanga-stats.mjs';
import { CANDIDATES, choosePrimary, chooseTrial } from '../templates/harness/mullebanga-policy.mjs';
import { modelOptions, outsideOptions } from '../templates/harness/mullebanga-model.mjs';
import { valueAfter } from './review-fixture.mjs';

const auto = { 사용: true, 프로필: '자동', 기본단계: '자동' };
const envOf = s => ({ ...process.env, PATH: s.searchPath, HOME: s.home, USERPROFILE: s.home, FAKE_CALLS: s.calls, FAKE_SCENARIO: path.join(s.aux, 'scenario.json') });
const dataOf = s => JSON.parse(fs.readFileSync(statsFile(envOf(s)), 'utf8'));
const activate = s => s.editConfig(config => { config.자동모델 = auto; });
const starts = s => s.called().filter(row => row.ph === 'start');
const model = call => valueAfter(call.args, call.tool === 'codex' ? '-m' : '--model');
const effort = call => valueAfter(call.args, call.tool === 'codex' ? '-c' : '--effort');
const noSandbox = process.platform === 'win32' && '제미나이 쓰기는 맥 sandbox-exec가 필요하다';
const initial = {
  codex: { 경량: ['gpt-6-luna', 'medium'], 구현: ['gpt-6.1-terra', 'high'], 추론: ['gpt-6.1-sol', 'high'] },
  claude: { 경량: ['haiku', 'medium'], 구현: ['sonnet', 'medium'], 추론: ['opus', 'medium'] },
  gemini: { 경량: ['gemini-4-hydrogen-medium', 'medium'], 구현: ['gemini-4-hydrogen-high', 'high'], 추론: ['gemini-4-hydrogen-high', 'high'] },
};
const row = (model, firstPass = true, elapsedMs = 100, tokens = null) => ({ ...model, firstPass, elapsedMs, tokens });

test('가짜 CLI: 세 도구 초기 주력, 추론 맞춰보기, 높음 뒤 구원투수, 새 작업 기본 주력', async t => {
  for (const tool of ['codex', 'claude', 'gemini']) {
    if (tool === 'gemini' && process.platform === 'win32') continue;
    const s = setup(t, { tools: [tool, tool] });
    activate(s);
    s.scenario({ 'T-1': { review: [{ payload: { findings: [{ level: '높음', text: '수정' }] } }, { payload: { findings: [] } }] } });
    const result = await s.run(['--도구', tool, 'T-1', 'T-2']);
    assert.equal(result.json[0].raised, true, result.stderr);
    const expected = { spec: '경량', specReview: '추론', build: '구현', review: '추론' };
    for (const [stage, group] of Object.entries(expected)) {
      const call = starts(s).find(call => call.id === 'T-1' && call.stage === stage);
      const [expectedModel, expectedEffort] = initial[tool][group];
      const primary = { model: expectedModel, effort: expectedEffort };
      assert.equal(model(call), primary.model, `${tool}:${stage}`);
      if (tool !== 'gemini') assert.equal(effort(call), tool === 'codex' ? `model_reasoning_effort="${primary.effort}"` : primary.effort);
    }
    const table = CANDIDATES[tool].구현;
    const fix = starts(s).find(call => call.stage === 'fix');
    assert.equal(model(fix), table.ladder[table.start + 1].model);
    assert.equal(model(starts(s).find(call => call.id === 'T-2' && call.stage === 'build')), table.ladder[table.start].model);
    const data = dataOf(s);
    assert.equal(data.records.find(r => r.stage === '만들기' && r.sampleId === sampleId(s.dir, 'T-1')).firstPass, false);
    assert.equal(data.records.find(r => r.stage === '고치기').escalated, true);
    assert.ok(data.records.filter(r => r.stage === '번갈아보기').every(r => r.ok));
    for (const record of data.records) {
      for (const field of ['project', 'tool', 'group', 'stage', 'model', 'effort', 'elapsedMs', 'tokens', 'ok', 'escalated']) assert.ok(Object.hasOwn(record, field));
      assert.equal(record.tokens, null);
      assert.doesNotMatch(record.model, /astra|carbon|fable/);
    }
    assert.ok(!JSON.stringify(data).includes(s.dir));
  }
});

test('명시 설정·작업별 값 우선, 자동 생략 시 legacy, 부분 프로필 유지', async () => {
  const config = { stages: { 만들기: { model: 'explicit', effort: 'low' } }, profiles: {}, auto };
  config.auto = { 사용: true, 프로필: '자동' };
  assert.equal((await modelOptions(config, '만들기', 'claude', null, 'sample')).model, 'explicit');
  config.auto = auto;
  config.stages.만들기.자동 = false;
  assert.equal((await modelOptions(config, '만들기', 'claude', null, 'sample')).model, 'explicit');
  assert.equal((await modelOptions(config, '만들기', 'claude', { tool: 'claude', model: 'task' }, 'sample')).model, 'task');
  config.stages.만들기 = { tool: 'claude', model: 'forced' };
  assert.equal((await modelOptions(config, '만들기', 'codex', null, 'sample')).model, 'forced');
  delete config.auto;
  assert.equal((await modelOptions(config, '만들기', 'codex', null, 'sample')).model, 'forced');
});

test('5건 최소, 70% 경계·최근10건, 강등80%·시간·토큰·쿨다운', () => {
  const table = CANDIDATES.codex.구현;
  const [low, primary, high] = table.ladder;
  const state = () => ({ primary, since: 0, changed: false });
  assert.deepEqual(choosePrimary(table, state(), Array.from({ length: 4 }, () => row(primary, false))), primary);
  const seven = [...Array.from({ length: 3 }, () => row(primary, false)), ...Array.from({ length: 7 }, () => row(primary))];
  assert.deepEqual(choosePrimary(table, state(), seven), primary);
  assert.deepEqual(choosePrimary(table, state(), [...seven, row(primary, false), row(primary, false), row(primary, false), row(primary, false)]), high);
  assert.deepEqual(choosePrimary(table, { ...state(), changed: true, since: 10 }, [...seven, row(primary, false)]), primary);
  const stable = Array.from({ length: 5 }, () => row(primary));
  const candidate = [row(low, false, 50), ...Array.from({ length: 4 }, () => row(low, true, 50))];
  assert.deepEqual(choosePrimary(table, state(), [...stable, ...candidate]), low);
  assert.deepEqual(choosePrimary(table, state(), [...stable, ...candidate.slice(1)]), primary);
  assert.deepEqual(choosePrimary(table, state(), [...stable, ...candidate.map(r => ({ ...r, elapsedMs: 200 }))]), primary);
  const tied = [...stable.map(r => ({ ...r, tokens: 20 })), ...candidate.map(r => ({ ...r, elapsedMs: 100 }))];
  assert.deepEqual(choosePrimary(table, state(), tied), primary, '미확인 토큰은 0이 아니다');
  assert.deepEqual(choosePrimary(table, state(), tied.map(r => ({ ...r, tokens: r.model === low.model && r.effort === low.effort ? 10 : 20 }))), low);
  const trialState = state();
  assert.deepEqual(Array.from({ length: 5 }, () => chooseTrial(table, trialState, stable)), [primary, primary, primary, primary, low]);
  assert.deepEqual(chooseTrial(CANDIDATES.claude.구현, { primary: CANDIDATES.claude.구현.ladder[0] }, stable), CANDIDATES.claude.구현.ladder[0]);
});

test('공용 저장: 두 프로젝트·병렬 호출·중복 callId·재시작·1차 품질 유지', async t => {
  const s = setup(t);
  const env = envOf(s);
  await Promise.all(Array.from({ length: 24 }, (_, i) => recordCall({ project: i % 2 ? 'a' : 'b', tool: 'codex', group: '구현', stage: '만들기', ...CANDIDATES.codex.구현.ladder[1], sampleId: `s${i}`, callId: `c${i}`, managed: true, firstPass: null, elapsedMs: 1, tokens: null, ok: true, escalated: false }, env)));
  await recordCall({ callId: 'c0' }, env);
  assert.equal(dataOf(s).records.length, 24);
  await markQuality('s0', false, env);
  await markQuality('s0', true, env);
  assert.equal(dataOf(s).records[0].firstPass, false);
  const selected = await selectModel({ tool: 'codex', stage: '만들기', sample: 'restart', env });
  const again = await selectModel({ tool: 'codex', stage: '만들기', sample: 'restart', env });
  assert.deepEqual(selected, again);
  await transaction(env, data => { data.states['codex:구현'].primary = CANDIDATES.codex.구현.ladder[2]; });
  const next = await selectModel({ tool: 'codex', stage: '만들기', sample: 'next', env });
  assert.equal(next.model, 'gpt-6.1-sol');
});

test('직접 조사·보조·정리도 실제 CLI 호출·성적부 연결, 외부 조사 폴백', async t => {
  const s = setup(t);
  activate(s);
  const env = envOf(s);
  const input = { prompt: 'T-1의 만든 코드를 살핀다', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } };
  for (const [stage, tool] of [['조사', 'codex'], ['쪼개기', 'claude'], ['고르기', 'gemini'], ['한일적기', 'claude']]) {
    const result = await runDirect({ root: s.dir, id: `${stage}-1`, stage, tool, input, env });
    assert.equal(result.ok, true);
    const record = dataOf(s).records.at(-1);
    assert.equal(record.stage, stage);
    assert.equal(record.model, result.attempts[0].model);
    assert.equal(record.group, stage === '조사' || stage === '쪼개기' ? '추론' : '경량');
  }
  s.scenario({ 'T-1': { review: [...Array.from({ length: 5 }, () => ({ exit: 1 })), {}] } });
  const result = await runDirect({ root: s.dir, id: 'external', stage: '조사', tool: 'gemini', input, env, external: true });
  assert.deepEqual(result.attempts.map(r => r.tool), ['codex', 'claude']);
  assert.equal(dataOf(s).records.at(-2).ok, false);
});

test('외부 조사 Claude 명시 폴백은 우선 도구 모델 대신 폴백 모델·추론과 기본값을 쓴다', async t => {
  for (const enabled of [false, true]) {
    for (const custom of [false, true]) {
      const s = setup(t);
      s.editConfig(config => {
        config.자동모델 = { 사용: enabled, 기본단계: '명시' };
        config.단계모델.조사 = { 모델: 'gpt-6.1-sol', 깊이: 'high', ...(custom ? { 폴백모델: 'opus', 폴백추론: 'xhigh' } : {}) };
      });
      s.scenario(enabled ? { 'T-1': { review: [{ exit: 1 }, {}] } } : {});
      const input = { prompt: 'T-1의 만든 코드를 살핀다', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } };
      const result = await runDirect({ root: s.dir, id: 'explicit-external', stage: '조사', tool: enabled ? 'codex' : 'claude', input, env: envOf(s), external: true });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.attempts.map(r => r.tool), enabled ? ['codex', 'claude'] : ['claude']);
      const call = starts(s).find(call => call.tool === 'claude');
      assert.equal(model(call), custom ? 'opus' : 'sonnet');
      assert.equal(effort(call), custom ? 'xhigh' : 'medium');
    }
  }
});

test('Claude 자동 워크플로는 공용 본체 한 번만 실행하고 별도 올림 AI를 부르지 않는다', async () => {
  const source = fs.readFileSync(new URL('../templates/workflows/mullebanga.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('\n};\n') + 4);
  const calls = [];
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    return { output: '[{"id":"T-1","raised":false}]' };
  };
  const run = new ((async () => {}).constructor)('agent', 'args', body);
  const result = await run(agent, { tasks: ['T-1'], 자동모델: { 사용: true } });
  assert.deepEqual(result, [{ id: 'T-1', raised: false }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /node harness\/mullebanga.mjs --도구 claude T-1/);
  assert.doesNotMatch(calls[0].prompt, /backlog.mjs 올림/);
});

test('자동 바깥 검토 우선 실패·폴백 각각 상대 추론군 주력과 실제 성적을 남긴다', async t => {
  const s = setup(t);
  activate(s);
  s.scenario({ 'T-1': { other: [{ exit: 1 }, {}] } });
  const result = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(result.json[0].raised, true, result.stderr);
  const outside = starts(s).filter(call => call.stage === 'other');
  assert.deepEqual(outside.map(call => [call.tool, model(call)]), [['agy', 'gemini-4-hydrogen-high'], ['claude', 'opus']]);
  const rows = dataOf(s).records.filter(row => row.stage === '번갈아보기' && row.tool !== 'codex');
  assert.deepEqual(rows.map(row => [row.tool, row.ok, row.group]), [['gemini', false, '추론'], ['claude', true, '추론']]);
});


test('명시 프로필은 기본단계 자동과 분리하며 개별 자동 설정만 우선한다', async t => {
  const s = setup(t);
  const env = envOf(s);
  const profile = { 모델: 'profile', 깊이: 'low' };
  const config = { stages: {}, profiles: { codex: { 번갈아보기: profile } }, auto: { 사용: true, 프로필: '명시', 기본단계: '자동' } };
  assert.equal((await modelOptions(config, '번갈아보기', 'codex', null, 'profile', env)).model, 'profile');
  assert.equal(await outsideOptions(config, 'codex', 'gemini', 'profile', env), undefined);
  profile.자동 = true;
  assert.equal((await outsideOptions(config, 'codex', 'gemini', 'forced-auto', env)).model, 'gemini-4-hydrogen-high');
  profile.자동 = false;
  assert.equal(await outsideOptions(config, 'codex', 'gemini', 'forced-explicit', env), undefined);
  delete config.profiles.codex;
  assert.equal((await outsideOptions(config, 'codex', 'gemini', 'default-auto', env)).model, 'gemini-4-hydrogen-high');
});

test('사다리 밖 탐색 후보 실패 후 고치기는 주력부터 한 칸씩 승급한다', async t => {
  const s = setup(t);
  const env = envOf(s);
  const table = CANDIDATES.gemini.구현;
  for (const candidate of table.explore) {
    const sample = candidate.model;
    await transaction(env, data => { data.assignments[`${sample}:gemini:구현`] = candidate; });
    const selected = await selectModel({ tool: 'gemini', stage: '만들기', sample, env });
    assert.equal(selected.model, candidate.model);
    await recordCall({ ...selected, group: '구현', stage: '만들기', sampleId: sample, callId: sample, ok: true }, env);
    await markQuality(sample, false, env);
    const fix = await selectModel({ tool: 'gemini', stage: '고치기', sample, env, rescue: true });
    assert.equal(fix.model, 'gemini-4-hydrogen-high');
    await recordCall({ ...fix, group: '구현', stage: '고치기', sampleId: sample, callId: `${sample}-fix`, ok: true }, env);
    await markQuality(sample, false, env);
    assert.equal((await selectModel({ tool: 'gemini', stage: '고치기', sample, env, rescue: true })).model, 'gemini-4-hydrogen-xhigh');
    const failures = Array.from({ length: 5 }, () => row(candidate, false));
    assert.deepEqual(choosePrimary(table, { primary: candidate, since: 0 }, failures), table.ladder[0]);
  }
});

test('Codex 메인·Gemini 작성의 자동 바깥 검토는 Codex 우선·Claude 폴백이다', { skip: noSandbox }, async t => {
  for (const failFirst of [false, true]) {
    const s = setup(t, { tools: ['gemini'] });
    activate(s);
    s.editConfig(config => { config.단계모델.만들기 = { 도구: 'gemini' }; });
    s.scenario({ 'T-1': { other: failFirst ? [{ exit: 1 }, {}] : [{}] } });
    const result = await s.run(['--도구', 'codex', 'T-1']);
    assert.equal(result.json[0].raised, true, result.stderr);
    assert.equal(starts(s).find(call => call.stage === 'build').tool, 'agy');
    const outside = starts(s).filter(call => call.stage === 'other');
    const expected = failFirst ? [['codex', 'gpt-6.1-sol'], ['claude', 'opus']] : [['codex', 'gpt-6.1-sol']];
    assert.deepEqual(outside.map(call => [call.tool, model(call)]), expected);
    const rows = dataOf(s).records.filter(row => row.stage === '번갈아보기');
    const expectedRows = [['codex', true], ...expected.map(([tool], i) => [tool, !failFirst || i > 0])];
    assert.deepEqual(rows.map(row => [row.tool, row.ok]).sort(), expectedRows.sort());
  }
});

test('썼음 결과의 새 허락 요청은 품질 표본에서 제외하고 확인·기록 요청은 유지한다', async t => {
  for (const kind of ['허락', '확인', '기록']) {
    const s = setup(t, { bareSpec: true });
    activate(s);
    const ask = { kind, option: kind === '허락' ? '삭제' : kind === '확인' ? '구조변경' : '', title: '시험 결정', description: '설명', choices: '진행=진행|유지=유지', recommend: '유지', reason: '이유' };
    s.scenario({ 'T-1': { spec: [{ payload: { outcome: '썼음', pendingQuestions: [], asks: [ask], specText: '## 끝 기준\n\n1. hello 한다\n' } }] } });
    const result = await s.run(['--도구', 'codex', 'T-1']);
    const record = dataOf(s).records.find(row => row.stage === '할일적기');
    assert.equal(record.ok, true);
    assert.equal(record.managed, true);
    assert.equal(record.firstPass, kind === '허락' ? null : true);
    assert.equal(record.status, kind === '허락' ? '건너뜀' : '완료');
    if (kind === '허락') {
      assert.equal(result.json[0].stopped, true);
      assert.match(result.json[0].reason, /허락 대기/);
      assert.deepEqual(starts(s).map(call => call.stage), ['spec']);
    } else assert.equal(result.json[0].raised, true, result.stderr);
  }
});
