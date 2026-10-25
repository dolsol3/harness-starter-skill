// 공용 물레방아의 번갈아 보기 바깥 검토: 작성 도구가 아닌 다른 도구가 원격을 끊은 버릴 복사본에서 만든 코드를 깨뜨려 본다.
// 도구·복사본·git이 실패해도 던지지 않고 검토 못 함 결과(tool: '')로 돌려준다. 입력이 틀렸을 때만 던진다.
// 읽기 전용은 도구가 아니라 역할로 정한다: 이 역할은 쓰기를 복사본 안으로만 묶는다(codex 샌드박스, 맥 제미나이 sandbox-exec, claude 자체 샌드박스).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callTool, agentapiPath, onPath, intact, sandboxWrap } from './mullebanga-call.mjs';
import { schemas } from './mullebanga-prompts.mjs';

const AUTHORS = ['codex', 'gemini', 'claude'];
const LEVELS = ['높음', '중간', '낮음'];
const DEFAULT_TIMEOUTS = { breaking: 1500000, readOnly: 300000 };
const NO_TOOL = '다른 도구 검토 없음: 작성 도구가 아니고 동시상한에 있는 검토·폴백 도구가 없다';
const AGENTAPI_CHANGED = '다른 도구 검토 뒤 진짜 홈 agentapi가 바뀜';
const DETAIL_LINE = 200;
const DEFAULT_MODEL = { gemini: 'gemini-4-argon-medium', codex: 'gpt-6.1-sol' };
const DEFAULT_EFFORT = { gemini: 'medium', codex: 'medium' };

class ReviewFailure extends Error {}

const plainObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const pick = (source, ...names) => names.map(name => source?.[name]).find(value => value !== undefined);
const section = (source, ...names) => plainObject(pick(source, ...names)) ?? {};
const finding = (level, text) => ({ level, text });
const oneLine = text => text.split('\n').findLast(line => line.trim())?.trim().slice(0, DETAIL_LINE) ?? '';

function readSettings(repo) {
  const file = path.join(repo, 'harness', 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const review = section(section(config, '단계모델', 'agents', 'models'), '번갈아보기', '번갈아 보기', '교차리뷰', '교차 리뷰', 'review');
  return {
    reviewTool: pick(review, '검토도구', '바깥도구', 'reviewTool') ?? 'gemini',
    fallbackTool: pick(review, '폴백도구', 'fallbackTool') ?? 'codex',
    outsideModel: pick(review, '바깥모델', 'outsideModel'),
    outsideEffort: pick(review, '바깥추론', 'outsideEffort'),
    fallbackModel: pick(review, '폴백모델', 'fallbackModel'),
    fallbackEffort: pick(review, '폴백추론', 'fallbackEffort'),
    model: pick(review, '모델', 'model') ?? 'opus',
    effort: pick(review, '깊이', '추론', 'effort') ?? 'medium',
    // 동시상한에 0(또는 양수가 아닌 값)으로 적힌 도구는 쓰지 말라는 뜻이라 검토 후보에서도 뺀다.
    limits: Object.entries(section(section(config, '일감목록', 'backlog'), '동시상한', '한도', 'limits')).filter(([, limit]) => limit > 0).map(([tool]) => tool),
  };
}

// 부를 도구 차례: 작성 도구가 아니고 동시상한에 있는 첫 도구, 그것이 검토도구면 폴백도구 한 번.
function planTools(settings, author) {
  const candidates = [settings.reviewTool, settings.fallbackTool, 'claude'];
  const usable = candidates.filter((tool, i) => candidates.indexOf(tool) === i && tool !== author && AUTHORS.includes(tool) && settings.limits.includes(tool));
  const [chosen] = usable;
  const fallback = chosen === settings.reviewTool ? usable.find(tool => tool === settings.fallbackTool && tool !== chosen) : undefined;
  return [chosen, fallback].filter(Boolean);
}

// 모델·추론은 자리(주/폴백)가 아니라 부르는 도구로 고른다: 검토도구면 바깥 값, 폴백으로 불리면 폴백 값(없으면 바깥 값), 둘 다 없으면 그 도구 기본값.
function toolOptions(settings, tool) {
  const asReviewTool = tool === settings.reviewTool;
  const model = asReviewTool ? settings.outsideModel : (settings.fallbackModel ?? settings.outsideModel);
  const effort = asReviewTool ? settings.outsideEffort : (settings.fallbackEffort ?? settings.outsideEffort);
  return { model: model ?? DEFAULT_MODEL[tool], effort: effort ?? DEFAULT_EFFORT[tool] };
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new ReviewFailure(`git ${args[0]} 실패: ${oneLine(result.stderr || result.stdout)}`);
  return result.stdout.trimEnd();
}

// 기준 커밋은 원격을 끊기 전에 구한다: 복사본에는 기본 브랜치 이름이 없어 base...HEAD diff가 실패한다.
// 하드링크 없이 복사한다: 복사본 객체를 고치면 하드링크로 공유한 원본이 깨진다.
function makeCopy(input, tmp) {
  const copy = path.join(tmp, 'copy');
  const baseCommit = git(input.worktree, 'merge-base', input.base, input.commit);
  git(tmp, 'clone', '-q', '--no-hardlinks', input.worktree, copy);
  git(copy, 'checkout', '-q', '--detach', input.commit);
  git(copy, 'remote', 'remove', 'origin');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  return { copy, home, baseCommit };
}

const resetCopy = ctx => {
  git(ctx.copy, 'checkout', '-q', '-f', '--detach', ctx.commit);
  git(ctx.copy, 'clean', '-q', '-ffdx');
};

const promptHead = ctx => [
  `작업 ${ctx.id}의 만든 코드를 다른 도구의 눈으로 검토한다. 지금 있는 곳(현재 폴더)은 검토할 커밋만 꺼낸 복사본이다. 이 복사본에는 일감 목록이 없으니 아래 작업 문서 전문을 읽는다.`,
  `기준 대비 변경은 \`git diff ${ctx.baseCommit} HEAD\`로 본다.`,
];
const promptTail = ctx => [
  '지적마다 높음·중간·낮음을 붙여 돌려준다. 지적이 없으면 빈 목록을 돌려준다. 결과는 스키마대로 JSON 한 덩어리로만 돌려주고 앞뒤에 설명 글을 붙이지 않는다.',
  `## 작업 문서 전문\n${ctx.spec}`,
];

const breakPrompt = ctx => [
  ...promptHead(ctx),
  '끝 기준 번호마다 기준대로 되는지 보는 데서 멈추지 말고, 이 만든 코드를 깨뜨릴 입력·환경·순서를 직접 찾아 명령으로 재현한다.',
  '재현한 것만 높음·중간으로, 재현하지 못한 의심은 낮음으로 적는다. 명령을 실행하지 못했으면 \'실행 못 함\'과 이유를 적는다.',
  `시험·설치기를 돌릴 때는 HOME과 USERPROFILE을 ${ctx.home}으로 준다. 복사본 밖 경로(작업 워크트리·진짜 홈)는 쓰지 않는다.`,
  ...promptTail(ctx),
].join('\n');

const readOnlyPrompt = ctx => [
  ...promptHead(ctx),
  '명령을 돌릴 수 없으니 작업 문서와 변경만 읽고 지적한다. 지적마다 근거가 되는 코드를 적는다.',
  ...promptTail(ctx),
].join('\n');

const checkFindings = list =>
  Array.isArray(list) && list.every(item => plainObject(item) && LEVELS.includes(item.level) && typeof item.text === 'string')
    ? list.map(item => finding(item.level, item.text))
    : undefined;

// 도구가 돌려준 말은 데이터다. level과 text만 꺼내 쓴다. 스키마 검증 엔진이 없어 바깥에서 오는 값은 이 경계에서 한 번 본다.
async function callChecked(ctx, call) {
  const res = await callTool({ cwd: ctx.copy, schema: schemas.REVIEWED, ...call });
  if (!res.ok) return { ok: false, detail: oneLine(`${res.reason}: ${res.detail}`) };
  const findings = checkFindings(res.result.findings);
  return findings ? { ok: true, findings } : { ok: false, detail: '결과없음: findings 모양이 틀렸다' };
}

// 깨뜨려 보기 경로: 쓰기는 복사본·임시 홈·임시 tmp·로그·/dev와 진짜 홈의 agentapi 한 파일만 열린다.
// agentapi는 agy가 명령 도구를 돌릴 때마다 다시 쓴다(막으면 run_command가 operation not permitted로 실패, 2026-10-23 사용자 결정).
async function breakGemini(ctx, agentapi, backup) {
  const tmpDir = path.join(ctx.tmp, 'tmp');
  const log = path.join(ctx.tmp, 'agy.log');
  fs.mkdirSync(tmpDir, { recursive: true });
  const allowed = [`(subpath "${ctx.copy}")`, `(subpath "${ctx.home}")`, `(subpath "${tmpDir}")`, `(literal "${log}")`, '(subpath "/dev")', `(literal "${agentapi}")`];
  const outcome = await callChecked(ctx, {
    tool: 'gemini', write: true, agent: 'breaker', logFile: log, wrap: sandboxWrap(path.join(ctx.tmp, 'sb.sb'), allowed), prompt: breakPrompt(ctx),
    env: { ...ctx.env, TMPDIR: tmpDir }, model: toolOptions(ctx.settings, 'gemini').model, timeoutMs: ctx.timeouts.breaking,
  });
  return intact(agentapi, backup) ? outcome : { ...outcome, agentapiChanged: true, extra: [finding('높음', AGENTAPI_CHANGED)] };
}

async function readOnlyGemini(ctx) {
  if (!fs.existsSync(path.join(ctx.copy, '.agents', 'agents', 'readonly.md'))) return { ok: false, detail: '읽기 전용 역할 파일 없음' };
  const outcome = await callChecked(ctx, {
    tool: 'gemini', write: false, agent: 'readonly', prompt: readOnlyPrompt(ctx),
    env: { ...ctx.env, HARNESS_READ_ONLY: '1' }, model: toolOptions(ctx.settings, 'gemini').model, timeoutMs: ctx.timeouts.readOnly,
  });
  const dirty = git(ctx.copy, 'status', '--porcelain');
  if (!dirty) return outcome;
  const files = dirty.split('\n').map(line => line.slice(3)).join(', ');
  return { ...outcome, extra: [finding('높음', `다른 도구 검토 뒤 복사본이 바뀜: ${files}`)] };
}

function attemptGemini(ctx) {
  const agentapi = agentapiPath(ctx.realHome);
  const backup = path.join(ctx.tmp, 'agentapi.bak');
  const canBreak = fs.existsSync(path.join(ctx.copy, '.agents', 'agents', 'breaker.md')) && onPath('sandbox-exec', ctx.env.PATH) && fs.existsSync(agentapi);
  if (!canBreak) return readOnlyGemini(ctx);
  fs.copyFileSync(agentapi, backup);
  return breakGemini(ctx, agentapi, backup);
}

// codex 로그인은 진짜 홈에 있어 HOME만 임시로 바꾸고 CODEX_HOME은 진짜 홈 쪽을 가리킨다.
const attemptCodex = ctx => callChecked(ctx, {
  tool: 'codex', write: true, prompt: breakPrompt(ctx), ...toolOptions(ctx.settings, 'codex'), timeoutMs: ctx.timeouts.breaking,
  env: { ...ctx.env, HOME: ctx.home, CODEX_HOME: ctx.env.CODEX_HOME ?? path.join(ctx.realHome, '.codex') },
});

// 샌드박스가 allowUnsandboxedCommands:false로 켜져 있어 모든 Bash가 샌드박스 안이다.
const attemptClaude = ctx => callChecked(ctx, {
  tool: 'claude', write: true, allowedTools: ['Bash'], prompt: breakPrompt(ctx), model: ctx.settings.model, effort: ctx.settings.effort, timeoutMs: ctx.timeouts.breaking, env: ctx.env,
});

const ATTEMPTS = { codex: attemptCodex, gemini: attemptGemini, claude: attemptClaude };

function toResult(tool, outcome, attempts, extra) {
  const changed = outcome.agentapiChanged === true;
  if (outcome.ok) return { tool, findings: [...outcome.findings, ...extra], agentapiChanged: changed, attempts };
  return { tool: '', findings: [finding('중간', `다른 도구 검토 실패: ${outcome.detail}`), ...extra], agentapiChanged: changed, attempts };
}

// 한 번씩만 부르고 되풀이하지 않는다. agentapi가 바뀌었으면 사람이 봐야 하니 폴백하지 않고 멈춘다.
// 복사본이 바뀐 높음 지적은 폴백 전 resetCopy가 흔적을 지우므로 시도마다 모아 최종 결과까지 남긴다.
async function runPlan(plan, ctx) {
  const attempts = [];
  const extra = [];
  let outcome;
  for (const tool of plan) {
    if (attempts.length) resetCopy(ctx);
    outcome = await ATTEMPTS[tool](ctx);
    extra.push(...(outcome.extra ?? []));
    attempts.push({ tool, ok: outcome.ok, detail: outcome.ok ? '' : outcome.detail });
    if (outcome.ok || outcome.agentapiChanged) return toResult(tool, outcome, attempts, extra);
  }
  return toResult('', outcome, attempts, extra);
}

function checkInput({ repo, worktree, author }) {
  if (!AUTHORS.includes(author)) throw new Error(`모르는 작성 도구: ${author}`);
  for (const dir of [repo, worktree]) if (!path.isAbsolute(dir ?? '')) throw new Error(`절대 경로가 아니다: ${dir}`);
}

export async function reviewOther(input) {
  checkInput(input);
  const { repo, id, author, env = process.env } = input;
  const specFile = path.join(repo, 'docs', 'tasks', `${id}.md`);
  if (!fs.existsSync(specFile)) throw new Error(`작업 문서 파일이 없다: ${specFile}`);
  const settings = readSettings(repo);
  const plan = planTools(settings, author);
  if (!plan.length) return { tool: '', findings: [finding('중간', NO_TOOL)], agentapiChanged: false, attempts: [] };
  const realHome = fs.realpathSync(env.HOME ?? os.homedir());
  // 맥의 /var/folders/…는 /private/var/…로 이어진 링크라 링크 경로의 샌드박스 규칙은 복사본 쓰기도 막는다.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-review-')));
  try {
    const ctx = { ...input, ...makeCopy(input, tmp), env, tmp, realHome, settings, spec: fs.readFileSync(specFile, 'utf8'), timeouts: { ...DEFAULT_TIMEOUTS, ...input.timeouts } };
    return await runPlan(plan, ctx);
  } catch (error) {
    if (!(error instanceof ReviewFailure)) throw error;
    return toResult('', { ok: false, detail: error.message }, [], []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
