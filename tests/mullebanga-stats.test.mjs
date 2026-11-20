import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setup } from './run-fixture.mjs';
import { statsFile, selectModel, transaction, recordCall, markQuality } from '../templates/harness/mullebanga-stats.mjs';
import { CANDIDATES, above, choosePrimary } from '../templates/harness/mullebanga-policy.mjs';
import { runDirect } from '../templates/harness/mullebanga-direct.mjs';

const auto = { 사용: true, 프로필: '자동', 기본단계: '자동' };
const activate = s => s.editConfig(c => { c.자동모델 = auto; });
const envOf = s => ({ ...process.env, PATH: s.searchPath, HOME: s.home, USERPROFILE: s.home, FAKE_CALLS: s.calls, FAKE_SCENARIO: path.join(s.aux, 'scenario.json') });
const dataOf = s => JSON.parse(fs.readFileSync(statsFile(envOf(s)), 'utf8'));
const input = { prompt: 'T-1의 만든 코드를 살핀다', schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] } };

test('서로 다른 프로젝트의 실제 실행이 같은 홈 성적부에 누적된다', async t => {
  const a = setup(t);
  const b = setup(t);
  activate(a);
  activate(b);
  const home = { HOME: a.home, USERPROFILE: a.home };
  const results = await Promise.all([a.run(['--도구', 'codex', 'T-1'], home), b.run(['--도구', 'codex', 'T-1'], home)]);
  assert.ok(results.every(r => r.json[0].raised), results.map(r => r.stderr).join('\n'));
  const records = dataOf(a).records;
  assert.deepEqual(new Set(records.map(r => r.project)), new Set([path.basename(a.dir), path.basename(b.dir)]));
  assert.equal(records.filter(r => r.stage === '만들기').length, 2);
  assert.ok(records.filter(r => r.stage === '만들기').every(r => r.firstPass));
  const before = records.length;
  const resumed = await a.run(['--도구', 'codex', 'T-1'], home);
  assert.equal(resumed.json[0].stopped, true, resumed.stderr);
  const after = dataOf(a).records;
  assert.equal(after.filter(r => r.stage === '만들기').length, 2);
  assert.equal(after.length, before, '이미 올린 작업은 실행하지 않고 새 품질 표본을 만들지 않는다');
});

test('프로세스 둘이 동시에 저장해도 기록과 JSON이 보존된다', async t => {
  const s = setup(t);
  const module = new URL('../templates/harness/mullebanga-stats.mjs', import.meta.url).href;
  const code = `import { recordCall } from ${JSON.stringify(module)}; for (let i = 0; i < 15; i++) await recordCall({callId: process.argv[1]+i, project: 'fixture'}, process.env);`;
  await Promise.all(['a', 'b'].map(id => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, id], { env: envOf(s) })));
  assert.equal(dataOf(s).records.length, 30);
  assert.equal(new Set(dataOf(s).records.map(r => r.callId)).size, 30);
});

test('실패→고치기 한 칸 승급·최상단·3회 상한, 이어하기 첫 실패 유지', async t => {
  const s = setup(t);
  activate(s);
  s.scenario({ 'T-1': { review: [{ payload: { findings: [{ level: '높음', text: '계속 실패' }] } }] } });
  const result = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(result.json[0].fixes, 3);
  assert.equal(result.json[0].raised, false);
  const rows = dataOf(s).records.filter(r => r.group === '구현');
  assert.deepEqual(rows.map(r => [r.model, r.effort]), [['gpt-6.1-terra', 'high'], ['gpt-6.1-sol', 'high'], ['gpt-6.1-sol', 'xhigh'], ['gpt-6.1-sol', 'xhigh']]);
  assert.equal(rows[0].firstPass, false);
  const top = CANDIDATES.codex.구현.ladder.at(-1);
  assert.deepEqual(above(CANDIDATES.codex.구현, top), top);
  s.scenario({});
  await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(dataOf(s).records.filter(r => r.stage === '만들기').length, 1);
  assert.equal(dataOf(s).records.find(r => r.stage === '만들기').firstPass, false);
});

test('실제 확인 실패 뒤에만 승급하고 첫 검사 실패는 수정 성공으로 지워지지 않는다', async t => {
  const s = setup(t);
  activate(s);
  s.scenario({ 'T-1': { build: [{ write: { FAIL: '확인 실패', 'impl.txt': '첫 구현' } }], fix: [{ write: { FAIL: null, 'fixed.txt': '고침' } }] } });
  const result = await s.run(['--도구', 'codex', 'T-1']);
  assert.equal(result.json[0].raised, true, result.stderr);
  const rows = dataOf(s).records.filter(r => r.group === '구현');
  assert.equal(rows[0].firstPass, false);
  assert.equal(rows[1].model, 'gpt-6.1-sol');
  assert.equal(rows[1].effort, 'high');
});

test('실제 토큰·스키마 실패·한도·시간초과·허락·건너뜀을 구분한다', async t => {
  const s = setup(t);
  activate(s);
  const env = envOf(s);
  const cases = [
    [{ usage: { input_tokens: 10, output_tokens: 4 } }, '완료', true, 14],
    [{ payload: { findings: 'bad' } }, '결과없음', false, null],
    [{ exit: 1, stderr: 'quota exceeded' }, '한도', false, null],
    [{ exit: 1, stderr: 'unsupported model' }, '미지원', false, null],
    [{ sleep: true }, '시간초과', false, null],
  ];
  for (const [response, status, ok, tokens] of cases) {
    s.scenario({ 'T-1': { review: [response] } });
    await runDirect({ root: s.dir, id: status, stage: '조사', tool: 'codex', input: { ...input, timeoutMs: response.sleep ? 300 : 5000 }, env });
    const record = dataOf(s).records.at(-1);
    assert.equal(record.status, status === '결과없음' ? '스키마' : status);
    assert.equal(record.ok, ok);
    assert.equal(record.tokens, tokens);
    if (status === '한도') assert.equal(record.firstPass, null);
  }
  for (const outcome of ['허락', '건너뜀']) {
    s.scenario({ 'T-1': { review: [{ payload: { outcome } }] } });
    await runDirect({ root: s.dir, id: outcome, stage: '할일적기', tool: 'codex', input, env });
    assert.equal(dataOf(s).records.at(-1).firstPass, null);
  }
});

test('성적부 저장 오류는 성공으로 바꾸지 않고 전달한다', async t => {
  const s = setup(t);
  const file = statsFile(envOf(s));
  fs.mkdirSync(file, { recursive: true });
  await assert.rejects(selectModel({ tool: 'codex', stage: '만들기', sample: 'bad', env: envOf(s) }), /EISDIR/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('승급·강등 저장과 쿨다운: 다음 프로세스 선택에도 주력 유지', async t => {
  const s = setup(t);
  const env = envOf(s);
  const table = CANDIDATES.codex.구현;
  const primary = table.ladder[1];
  const samples = Array.from({ length: 5 }, (_, i) => ({ ...primary, managed: true, firstPass: false, group: '구현', tool: 'codex', stage: '만들기', sampleId: `failure${i}`, elapsedMs: 20, tokens: null }));
  await transaction(env, data => { data.records = samples; });
  const selected = await selectModel({ tool: 'codex', stage: '만들기', sample: 'new', env });
  assert.equal(selected.model, 'gpt-6.1-sol');
  const module = new URL('../templates/harness/mullebanga-stats.mjs', import.meta.url).href;
  const code = `import { selectModel } from ${JSON.stringify(module)}; console.log(JSON.stringify(await selectModel({tool:'codex',stage:'만들기',sample:'restart'})));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env });
  assert.equal(JSON.parse(stdout).model, 'gpt-6.1-sol');
  const state = { primary, since: 0, changed: false };
  const stable = Array.from({ length: 5 }, () => ({ ...primary, firstPass: true, elapsedMs: 20, tokens: null }));
  const unknown = stable.map(r => ({ ...r, ...table.ladder[0] }));
  assert.deepEqual(choosePrimary(table, state, [...stable, ...unknown]), primary, '시간·미확인 토큰이 같으면 유지');
});


test('직접 CLI를 링크 경로로 실행해도 호출하고 실제 결과·성적을 출력한다', { skip: process.platform === 'win32' }, t => {
  const s = setup(t);
  activate(s);
  const link = path.join(s.aux, 'direct-link.mjs');
  fs.symlinkSync(path.join(s.dir, 'harness/mullebanga-direct.mjs'), link);
  const result = spawnSync(process.execPath, [link, '--도구', 'codex', '--단계', '조사', '--작업', 'cli-link'], { env: envOf(s), input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), '링크로 실행해도 JSON 출력이 있어야 한다');
  assert.equal(JSON.parse(result.stdout).attempts[0].model, 'gpt-6.1-sol');
  assert.equal(dataOf(s).records.at(-1).stage, '조사');
});


test('도구 실패는 첫 구현 품질 표본에서 빼고 정상 완료된 첫 만들기만 평가한다', async t => {
  const s = setup(t);
  const env = envOf(s);
  for (const status of ['실패', '한도', '권한', '미지원', '시간초과', '스키마']) {
    const base = { tool: 'codex', group: '구현', stage: '만들기', sampleId: status, managed: true, firstPass: null };
    await recordCall({ ...base, callId: `${status}-failed`, ok: false, status }, env);
    await markQuality(status, false, env);
    assert.equal(dataOf(s).records.at(-1).firstPass, null, status);
    await recordCall({ ...base, callId: `${status}-completed`, ok: true, status: '완료' }, env);
    await markQuality(status, true, env);
    const rows = dataOf(s).records.filter(r => r.sampleId === status);
    assert.deepEqual(rows.map(r => r.firstPass), [null, true], status);
    await markQuality(status, false, env);
    assert.equal(dataOf(s).records.at(-1).firstPass, true, '이미 정한 첫 통과는 바뀌지 않는다');
  }
});
