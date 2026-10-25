import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    pickExtra: { agents: { 맞춰보기: { 모델: 'sonnet', 깊이: 'low' } } },
  });
  assert.deepEqual(
    { model: fromPick.find(c => c.label.startsWith('살피기 담당 맞춰보기')).model, effort: fromPick.find(c => c.label.startsWith('살피기 담당 맞춰보기')).effort },
    { model: 'sonnet', effort: 'low' },
  );
  const { calls: fromSpec } = await run({
    args: ['T-1'],
    spec: { agents: englishSpecCfg, rejectedCommit: 'abc1234', rejectedReason: 'fix' },
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

test('otherReviewPrompt reads 일감목록.동시상한 and 단계모델.번갈아보기, invokes codex with model and effort, and falls back to codex gpt-6.1-sol on quota/rate-limit or failure', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  assert.match(prompt, /일감목록\.동시상한.*backlog\.limits.*단계모델\.번갈아보기/);
  assert.match(prompt, /기본 검토도구·바깥도구 `gemini`, 바깥모델 `gemini-4-argon-medium`, 폴백도구 `codex`, 폴백모델 `gpt-6\.1-sol`, 폴백추론 `medium`/);
  assert.match(prompt, /<모델>·<추론>은 그 도구가 `검토도구`면 `바깥모델`·`바깥추론`, 폴백으로 부르면 `폴백모델`·`폴백추론`/);
  assert.match(prompt, /codex exec -s workspace-write --ephemeral -m <모델> -c model_reasoning_effort='"<추론>"' -C <임시>\/copy -o <임시>\/result\.txt - < <임시>\/prompt\.txt/);
  assert.match(prompt, /토큰·한도 부족\(quota·rate limit·usage limit 등\)이나 실행 실패로 검토를 못 하면.*폴백 도구\(`폴백도구`, 기본 `codex`, 모델 `폴백모델` 기본 `gpt-6\.1-sol`, 추론 `폴백추론` 기본 `medium`; `gemini`면 기본 `gemini-4-argon-medium`\)로 폴백/);
  assert.match(prompt, /sandbox-exec -f <임시>\/sb\.sb env TMPDIR=<임시>\/tmp agy -p "\$\(cat <임시>\/prompt\.txt\)" --model <모델> --agent breaker --output-format json --print-timeout 25m --log-file <임시>\/agy\.log > <임시>\/result\.txt/);
  assert.match(prompt, /cd <임시>\/copy && HARNESS_READ_ONLY=1 agy -p "\$\(cat <임시>\/prompt\.txt\)" --model <모델> --agent readonly --output-format json --print-timeout 5m > <임시>\/result\.txt/);
});

test('otherReviewPrompt picks the first of 검토도구, 폴백도구 that is not the author and is in 동시상한, calls nothing when none, and falls back only to a tool meeting the same condition', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  assert.match(prompt, /후보는 `검토도구`, `폴백도구` 순서다.*작성 도구가 아니고 `동시상한`에 있는 첫 도구를 고른다/);
  assert.match(prompt, /고를 도구가 없으면 아무것도 부르지 않고 tool을 빈 문자열.*다른 도구 검토 없음/);
  assert.match(prompt, /`폴백도구`가 작성 도구가 아니고 `동시상한`에 있을 때만.*이미 `폴백도구`였으면 폴백 없이/);
  assert.doesNotMatch(prompt, /기본 검토도구\(`codex`\)를 우선 고르고|작성 도구 `claude` 말고/);
});

test('every answer-shape property key passed to agent() matches the API pattern, nested ones included', async () => {
  const badKeys = (node, path) => {
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) => {
      const own = key === 'properties' && !Array.isArray(value)
        ? Object.keys(value).filter(name => !/^[a-zA-Z0-9_.-]{1,64}$/.test(name)).map(name => `${path}.${name}`)
        : [];
      return [...own, ...badKeys(value, `${path}.${key}`)];
    });
  };
  const first = await run({ checks: [{ passed: false, failures: 'fail' }], reviews: [[{ level: '높음', text: 'x' }]] });
  const resumed = await run({ args: ['T-1'], spec: { rejectedCommit: 'abc1234', rejectedReason: 'fix' } });
  const schemas = [...first.calls, ...resumed.calls].filter(call => call.schema);
  assert.ok(schemas.length >= 8);
  assert.deepEqual(schemas.flatMap(call => badKeys(call.schema, call.label)), []);
});

test('작업 고르기와 기획 담당 지시문은 단계 모델을 답 모양의 agents 칸으로 돌려 달라고 한다', () => {
  const returnLines = source.split('\n').filter(line => line.includes('함께 읽어'));
  assert.equal(returnLines.length, 2);
  for (const line of returnLines) {
    assert.match(line, /agents\\?`로 돌려준다/);
    assert.doesNotMatch(line, /단계모델\\?`로 돌려준다/);
  }
});

test('otherReviewPrompt has the other tool break the clone: cut origin first, temp HOME, repro-only highs, backgrounded Codex with a long enough wait, gemini keeps the read-only call as the fallback path', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  assert.doesNotMatch(prompt, /s read.only/);
  const order = ['git clone --no-hardlinks . <임시>/copy', 'git checkout --detach c0', 'git remote remove origin', 'mkdir <임시>/home', 'R=${CODEX_HOME:-$HOME/.codex}; cd <임시>/copy && HOME=<임시>/home CODEX_HOME="$R" codex exec'].map(text => prompt.indexOf(text));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), order.join());
  assert.ok(prompt.indexOf('pkill -P $(cat <임시>/pid)') < prompt.indexOf('kill $(cat <임시>/pid)`로 부모'), '자식을 먼저 멈춘다');
  assert.match(prompt, /깨뜨릴 입력·환경·순서를 직접 찾아 명령으로 재현한다/);
  assert.match(prompt, /재현한 것만 높음·중간으로, 재현하지 못한 의심은 낮음으로/);
  assert.match(prompt, /HOME·USERPROFILE을 `<임시>\/home`으로 주고/);
  assert.match(prompt, /& echo \$! > <임시>\/pid/);
  assert.match(prompt, /timeout 600000으로 최대 3번.*seq 1 110.*sleep 5/);
  assert.match(prompt, /kill \$\(cat <임시>\/pid\).*시간이 다 된 것은 모두 실행 실패/);
  assert.match(prompt, /HARNESS_READ_ONLY=1 agy -p .* --agent readonly --output-format json --print-timeout 5m/);
});

test('the gemini breaker path builds the sandbox rule from the real temp path, runs behind the same wait and stop as Codex, and keeps the read-only path for no sandbox-exec or no breaker.md', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  const lines = prompt.split('\n');
  const line = text => lines.find(each => each.includes(text)) ?? '';
  const order = ['git merge-base', 'git remote remove origin', 'mkdir <임시>/home', 'mkdir <임시>/tmp', 'pwd -P', '<임시>/sb.sb`를 만든다', 'agentapi.bak`으로', 'sandbox-exec -f <임시>/sb.sb env', 'cmp <임시>/agentapi.bak'].map(text => prompt.indexOf(text));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), order.join());
  assert.match(line('(version 1)'), /`\(version 1\)` `\(allow default\)` `\(deny file-write\*\)` `\(allow file-write\* \(subpath "<실제 경로>\/copy"\) \(subpath "<실제 경로>\/home"\) \(subpath "<실제 경로>\/tmp"\) \(literal "<실제 경로>\/agy\.log"\) \(subpath "\/dev"\) \(literal "<홈>\/\.gemini\/antigravity-cli\/bin\/agentapi"\)\)`/);
  assert.match(line('(version 1)'), /`agentapi` 한 파일만 열리고, `done`·`pid`와 그 밖의 진짜 홈은 막힌다.*막으면 `run_command`가 `operation not permitted`로 실패한다.*2026-10-23 사용자가 열기로 정했다/);
  assert.match(line('cmp <임시>'), /성공·실패는 바로, 시간 초과는 위 멈추기를 마친 뒤에.*\[ ! -L <홈>.*cmp <임시>\/agentapi\.bak <홈>.*내용이 같은지.*되돌리지 않고.*높음으로 더하고 `agentapiChanged`를 true로.*진짜 홈 agentapi가 바뀜.*고치기·다시 검토로 가지 않고 그 작업을 멈춘다/);
  assert.match(line('git merge-base'), /원격을 끊기 전에.*<기준>/);
  assert.match(prompt, /git diff <기준> HEAD/);
  assert.match(line('pwd -P'), /링크 경로로 적은 규칙은 복사본 쓰기도 막는다/);
  assert.match(line('breaker.md`가 있고'), /command -v sandbox-exec.*하나라도 없으면 읽기 전용 경로/);
  assert.match(line('sandbox-exec -f'), /& echo \$! > <임시>\/pid/);
  assert.match(line('sandbox-exec -f'), /`HARNESS_READ_ONLY`는 주지 않고 `-w`도 쓰지 않는다/);
  assert.match(line('pkill -P'), /자식\(Codex 또는 `agy`\)을 먼저 멈추고/);
  assert.ok(prompt.indexOf('kill $(cat <임시>/pid)`로 부모') < prompt.indexOf('cmp <임시>/agentapi.bak'), '시간 초과면 멈춘 뒤에 비교한다');
  assert.match(line('폴백해 부른다'), /부르기 전에 Codex가 복사본에 남긴 것을 .*cd <임시>\/copy && git checkout -f --detach c0 && git clean -ffdx` 한 줄로.*`<임시>\/done`과 `<임시>\/pid`를 `rm -f`로 지운다/);
  assert.match(line('pkill -P'), /가장 깊은 것부터 `kill`로 멈추고, 이어서 `pkill -P/);
  const printTimeout = Number(line('sandbox-exec -f').match(/--print-timeout (\d+)m/)[1]) * 60;
  const waitSeconds = Number(prompt.match(/최대 (\d)번/)[1]) * Number(prompt.match(/seq 1 (\d+)/)[1]) * Number(prompt.match(/sleep (\d+)/)[1]);
  assert.ok(printTimeout > 908 && printTimeout < waitSeconds, `${printTimeout} ${waitSeconds}`);
});

test('the clone the other tool breaks shares no object files with the worktree, so overwriting a copy object leaves the original readable', async () => {
  const { calls } = await run({ args: ['T-1'] });
  const { prompt } = calls.find(call => call.label.startsWith('다른 도구 검토'));
  const flags = prompt.match(/git clone ((?:--\S+ )*)\. <임시>\/copy/)[1].split(' ').filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-clone-'));
  const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  git(source, 'init', '-q');
  fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
  git(source, 'add', 'a.txt');
  git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  const copy = path.join(dir, 'copy');
  git(source, 'clone', '-q', ...flags, '.', copy);
  const oid = git(source, 'rev-parse', 'HEAD:a.txt');
  const objectPath = root => path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  assert.notEqual(fs.statSync(objectPath(source)).ino, fs.statSync(objectPath(copy)).ino);
  fs.chmodSync(objectPath(copy), 0o644);
  fs.writeFileSync(objectPath(copy), 'broken');
  assert.equal(git(source, 'cat-file', '-p', oid), 'a');
  fs.rmSync(dir, { recursive: true, force: true });
});
