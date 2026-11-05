import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { examine } from '../scripts/model-exam.mjs';
import { grade, schema, versions } from '../scripts/model-exam-cases.mjs';
import { tempDir, writeFakeTool, linkDir } from './helpers.mjs';

const answer = { extract: ['E1', 'E3', 'E4', 'E6'], compare: ['C2', 'C3', 'C6', 'C7', 'C8'], patch: 'if (pending.get(k) === p) pending.delete(k);', review: ['R1', 'R4'] };
function fixture(t) {
  const dir = tempDir(t, 'model-exam-test-');
  const log = path.join(dir, 'calls');
  for (const name of ['codex', 'agy', 'claude']) writeFakeTool(dir, name, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('--version')) process.exit(0);
const model = args[args.indexOf(args.includes('-m') ? '-m' : '--model') + 1];
const event = state => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ state, tool: '${name}', model, args, input, cwd: process.cwd(), auth: Object.fromEntries(['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR'].map(k => [k,process.env[k]])), ro: process.env.HARNESS_READ_ONLY, role: fs.existsSync('.agents/agents/readonly.md') ? fs.readFileSync('.agents/agents/readonly.md','utf8') : null, remotes: cp.execFileSync('git', ['remote'], {encoding:'utf8'}) }) + '\\n');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  event('start');
  if (model === 'dirty') fs.writeFileSync('unexpected.txt', 'changed');
  if (model === 'role-dirty') fs.appendFileSync('.agents/agents/readonly.md', 'changed');
  if (model === 'ignored-dirty') fs.writeFileSync('.git/unexpected', 'changed');
  if (model === 'slow') return setInterval(() => {}, 1000);
  if (model === 'limit') { console.error('quota exceeded'); process.exit(1); }
  setTimeout(() => {
    const answer = model === 'bad' ? {} : ${JSON.stringify(answer)};
    if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(answer));
    else if ('${name}' === 'agy') console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:answer}}));
    else console.log(JSON.stringify({structured_output:answer}));
    event('end');
  }, 80);
});
`);
  const config = { maxCalls: 16, timeoutMs: 3000, maxInputChars: 5000, concurrency: { codex: 2, gemini: 1, claude: 1 },
    candidates: ['codex', 'gemini', 'claude'].flatMap(tool => [0, 1, 2].map(i => ({ id: tool + i, tool, model: 'future-model-' + i, effort: 'future-depth' }))) };
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, FAKE_LOG: log, HOME: path.join(dir, 'existing-home'), USERPROFILE: path.join(dir, 'existing-profile'), CODEX_HOME: path.join(dir, 'existing-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'existing-claude'), HARNESS_READ_ONLY: 'inherited' };
  for (const [tool, bin] of Object.entries({ CODEX: 'codex', GEMINI: 'agy', CLAUDE: 'claude' })) env[`HARNESS_${tool}_BIN`] = path.join(dir, bin + (process.platform === 'win32' ? '.cmd' : ''));
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, log, config, env, events, out: path.join(dir, 'out') };
}
test('기본 CLI 미리보기는 쓰거나 호출하지 않는다; 저장소·링크 출력 거절', async t => {
  const f = fixture(t);
  const text = execFileSync(process.execPath, ['scripts/model-exam.mjs', '--out', f.out], { env: f.env, encoding: 'utf8' });
  const plan = JSON.parse(text);
  assert.equal(plan.newCalls, 16);
  const matrix = plan.candidates.map(({ id, tool, model, effort }) => [id, tool, model, effort]);
  assert.deepEqual(matrix, [
    ...['sonnet', 'opus', 'haiku'].map(id => [id, 'claude', `claude-${id}-5-5`, 'medium']),
    ...['sol', 'terra', 'astra'].flatMap(id => ['medium', 'high', 'xhigh'].map(effort =>
      [`${id}-${effort}`, 'codex', id === 'astra' ? 'gpt-6-astra' : `gpt-6.1-${id}`, effort])),
    ...['argon', 'flash'].flatMap(id => ['medium', 'high'].map(effort =>
      [`${id}-${effort}`, 'gemini', `gemini-${id === 'argon' ? '4-argon' : '3.8-flash'}-${effort}`, undefined])),
  ]);
  assert.equal(plan.config.concurrency.codex, 5);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(f.events().length, 0);
  const repo = path.join(f.dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  linkDir(repo, path.join(f.dir, 'link'));
  await assert.rejects(examine(f.config, path.join(repo, 'out')), /저장소 밖/);
  await assert.rejects(examine(f.config, path.join(repo, '.git/out')), /저장소 밖/);
  await assert.rejects(examine(f.config, path.join(f.dir, 'link/out')), /저장소 밖/);
  const bare = path.join(f.dir, 'bare');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  await assert.rejects(examine(f.config, path.join(bare, 'out')), /저장소 밖/);
});
test('새 모델·추론 전달, 1묶음 1호출, 격리, 도구별 동시상한, 완료 재사용', async t => {
  const f = fixture(t);
  const first = await examine(f.config, f.out, true, f.env);
  assert.equal(first.results.length, 9);
  assert.ok(first.results.every(r => r.ok && r.grade.score === 4 && r.usage === '미측정'));
  const active = { codex: 0, agy: 0, claude: 0 };
  const peak = { ...active };
  for (const e of f.events()) {
    active[e.tool] += e.state === 'start' ? 1 : -1;
    peak[e.tool] = Math.max(peak[e.tool], active[e.tool]);
    assert.equal(e.remotes, '');
    assert.notEqual(e.cwd, process.cwd());
    for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) assert.equal(e.auth[key], f.env[key]);
    assert.equal(e.ro, e.tool === 'codex' ? undefined : e.tool === 'agy' ? '1' : 'inherited');
    if (e.tool === 'agy') {
      assert.equal(e.args[e.args.indexOf('--agent') + 1], 'readonly');
      assert.equal(e.role, fs.readFileSync('templates/antigravity/readonly.md', 'utf8'));
    }
    if (e.tool === 'codex') assert.equal(e.args[e.args.indexOf('-s') + 1], 'read-only');
    if (e.tool === 'claude') assert.equal(e.args[e.args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(fs.existsSync(e.cwd), false);
    assert.ok(['extract', 'compare', 'patch', 'review'].every(key => e.input.includes(key)));
    if (e.state === 'start') assert.ok(e.args.some(arg => arg.includes('future-depth')));
  }
  assert.deepEqual(peak, { codex: 2, agy: 1, claude: 1 });
  const second = await examine({ ...f.config, maxCalls: 0 }, f.out, true, f.env);
  assert.ok(second.results.every(r => r.reused));
  assert.equal(f.events().length, 18);
  assert.equal((await examine({ ...f.config, promptSuffix: '한 번 더 확인.' }, f.out)).newCalls, 9);
  for (const [target, key] of [
    ...['model', 'effort'].map(key => [f.config.candidates[0], key]),
    ...Object.keys(versions).map(key => [versions, key]),
    [schema, 'description'],
  ]) {
    const original = target[key];
    target[key] = `${original}-new`;
    try {
      assert.equal((await examine(f.config, f.out)).newCalls, target === f.config.candidates[0] ? 1 : 9);
    } finally {
      if (original === undefined) delete target[key];
      else target[key] = original;
    }
  }
});
test('예산 초과는 호출 전 거절하고 실패·시간초과는 재시도·재사용하지 않는다', async t => {
  const f = fixture(t);
  await assert.rejects(examine({ ...f.config, maxCalls: 8 }, f.out, true, f.env), /호출 예산/);
  await assert.rejects(examine({ ...f.config, maxInputChars: 1 }, f.out, true, f.env), /입력 예산/);
  assert.equal(f.events().length, 0);
  const config = { ...f.config, candidates: ['slow', 'limit', 'bad', 'dirty', 'role-dirty', 'ignored-dirty'].map(model => ({ id: model, tool: ['slow', 'limit', 'bad'].includes(model) ? 'codex' : 'gemini', model })) };
  const result = await examine(config, f.out, true, f.env);
  assert.deepEqual(result.results.map(r => r.ok), Array(6).fill(false));
  assert.match(result.results[0].reason, /시간초과/);
  assert.match(result.results[1].reason, /한도/);
  assert.match(result.results[2].reason, /스키마/);
  assert.equal(f.events().filter(e => e.state === 'start').length, 6);
  assert.ok(result.results.slice(3).every(r => /예상하지 않은 변경/.test(r.reason)));
  assert.equal((await examine(config, f.out)).newCalls, 6);
  assert.ok(f.events().every(e => !fs.existsSync(e.cwd)));
});
test('고난도 문제와 정확성·누락·헛지적·집합 완전 일치·패치 채점', () => {
  const full = grade(answer);
  assert.equal(full.score, 4);
  assert.ok(Object.values(full.parts).every(part => part.exact));
  assert.ok(grade({ ...answer, extract: [...answer.extract].reverse() }).parts.extract.exact);
  for (const key of ['extract', 'compare', 'review']) {
    const duplicate = grade({ ...answer, [key]: [...answer[key], answer[key][0], 'UNKNOWN'] }).parts[key];
    assert.equal(duplicate.exact, false);
    assert.deepEqual(duplicate.falsePositives, [answer[key][0], 'UNKNOWN']);
    assert.ok(duplicate.score < 1);
    const missing = grade({ ...answer, [key]: answer[key].slice(1) }).parts[key];
    assert.equal(missing.exact, false);
    assert.deepEqual(missing.missing, [answer[key][0]]);
  }
  const wrong = grade({ extract: ['E2', 'E5', 'E7'], compare: ['C1', 'C4', 'C5'], patch: 'if (pending.has(k)) pending.delete(k);', review: ['R2', 'R3'] });
  assert.equal(wrong.score, 0);
  assert.ok(Object.values(wrong.parts).every(part => !part.exact));
  assert.equal(grade({ ...answer, patch: ' if ( pending.get(k) === p ) pending.delete(k); ' }).parts.patch.exact, true);
});
