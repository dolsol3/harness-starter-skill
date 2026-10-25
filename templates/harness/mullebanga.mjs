#!/usr/bin/env node
// 공용 물레방아: 어느 도구(codex·gemini·claude)에서 불러도 같은 순서로 작업을 올림까지 돌린다.
//
//   node harness/mullebanga.mjs --도구 codex|gemini|claude [--시간제한 초] [T-1 …]
//
// 멈춘 작업을 다시 돌리면 남은 ai/ 브랜치에서 이어 간다(할 일 적기·맞춰보기·만들기 도구는 부르지 않고 지금 상태를 돌려본다).
// 순서: 할 일 적기 → 맞춰보기 → 만들기 → (확인 명령) → 커밋 → 번갈아 보기 → 고치기(돌려보기 실패·높음, 합쳐 작업당 3번) → 올림.
// 고르기와 돌려보기와 커밋은 AI가 아니라 이 코드가 한다. 병합·완료·정리·다시하기는 하지 않는다(메인 몫).
// 담당 도구는 --도구가 기본이고 단계모델.<단계>.도구로 바꾼다. 읽기 전용은 도구가 아니라 역할로 정한다: 할 일 적기·맞춰보기·살피기·증거 모으기는 읽기 전용, 만들기·고치기는 작업 워크트리에만 쓴다.
// 확인 명령은 커밋 전에 돌리고 `바뀐 파일들`은 기본 브랜치 이후 바뀐 파일 전부다(커밋 뒤에는 비고, 이번 고침만 보면 고치지 않은 위반이 통과한다).
// 제미나이가 쓰는 단계(만들기·고치기)는 sandbox-exec로 쓰기를 작업 워크트리에 묶는다. 없으면 그 단계가 멈춘다.
// 결과는 표준 출력에 JSON 배열 하나(작업마다 한 칸), 진행은 표준 오류에 낸다. 인자·설정 오류는 종료 코드 1이고 작업이 멈춘 것은 0이다.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { callTool, callWritingGemini } from './mullebanga-call.mjs';
import { createWorktree, commitAll, snapshot, readCheckCommands, runChecks, findResumeBranch, branchExists, openBranch, inspectBranch } from './mullebanga-git.mjs';
import { schemas, rolePrompt, specPrompt, specReviewPrompt, buildPrompt, reviewPrompt, fixPrompt, evidencePrompt } from './mullebanga-prompts.mjs';
import { reviewOther } from './mullebanga-review.mjs';
import { Stop, halt, readConfig, stageOptions, fits, backlog, taskInfo, inProgress, askArgs, recordSpec, criteriaNumbers } from './mullebanga-steps.mjs';

const TOOLS = ['codex', 'gemini', 'claude'];
const TASK_ID = /^[A-Za-z]+-\d+$/;
const MAX_FIXES = 3;
const READ_SECONDS = 300;
const WRITE_SECONDS = 1800;
const SPEC_STOPS = ['허락', '실험 필요'];
const STEPS = {
  spec: { key: '할일적기', label: '할 일 적기' },
  specReview: { key: '맞춰보기', label: '맞춰보기' },
  build: { key: '만들기', label: '만들기' },
  review: { key: '번갈아보기', label: '번갈아 보기' },
  fix: { key: '고치기', label: '고치기' },
  raise: { key: '올림', label: '올림(증거 모으기)' },
};

// 읽기 단계 claude는 작업 문서·일감 목록·git 기록을 읽는 명령만 받는다. Bash를 통째로 주면 읽기 전용(plan) 단계에서도 셸로 파일을 쓴다(재현함).
const READ_COMMANDS = ['node harness/backlog.mjs 보기 *', 'git log *', 'git diff *', 'git show *', 'git status *', 'git rev-parse *', 'git branch --show-current'].map(rule => `Bash(${rule})`);

const log = (id, text) => console.error(`[${id}] ${text}`);
// 동시상한에 적힌 0(또는 양수가 아닌 값)은 그 도구로 돌리지 말라는 뜻이다. 적혀 있지 않으면 막지 않는다.
const barred = (config, tool) => Object.hasOwn(config.limits, tool) && !(config.limits[tool] > 0);

function parseArguments(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 도구: { type: 'string' }, 시간제한: { type: 'string' } } });
  if (!TOOLS.includes(values.도구)) throw new Error(`--도구는 ${TOOLS.join('|')} 중 하나여야 한다(받은 값: ${values.도구 ?? '없음'})`);
  const seconds = values.시간제한 === undefined ? undefined : Number(values.시간제한);
  if (seconds !== undefined && !(seconds > 0)) throw new Error(`--시간제한은 0보다 큰 초다(받은 값: ${values.시간제한})`);
  const bad = positionals.find(id => !TASK_ID.test(id));
  if (bad) throw new Error(`작업 번호가 아니다: ${bad} (예: T-1)`);
  return { tool: values.도구, seconds, ids: positionals };
}

// 한 번 부르고 되풀이하지 않는다. 실패는 던지지 않고 이유를 담아 돌려준다(폴백은 바깥 검토 안에서만 한다).
async function callStep(ctx, id, step, { cwd, prompt, schema, write = false }) {
  const { tool, model, effort } = stageOptions(ctx.config, step.key, ctx.tool);
  if (barred(ctx.config, tool)) return { ok: false, reason: `${step.label} 단계에서 멈춤: 일감목록.동시상한.${tool}이 ${ctx.config.limits[tool]}이라 이 도구로는 돌리지 않는다` };
  log(id, `${step.label} 시작 (${tool})`);
  const call = { tool, cwd, prompt, schema, write, model, effort, timeoutMs: (ctx.seconds ?? (write ? WRITE_SECONDS : READ_SECONDS)) * 1000 };
  if (tool === 'claude') call.allowedTools = write ? ['Bash'] : READ_COMMANDS;
  if (tool === 'gemini' && !write) Object.assign(call, { agent: 'readonly', env: { ...process.env, HARNESS_READ_ONLY: '1' } });
  const res = await (tool === 'gemini' && write ? callWritingGemini(call) : callTool(call));
  if (!res.ok) return { ok: false, reason: `${step.label} 단계 도구 실패(${res.reason}): ${res.detail}` };
  if (!fits(schema, res.result)) return { ok: false, reason: `${step.label} 단계 도구 실패(결과없음): 결과 모양이 스키마와 다르다` };
  return { ok: true, tool, result: res.result };
}
const must = res => (res.ok ? res.result : halt(res.reason));

async function writeSpec(ctx, state) {
  const { id } = state;
  const spec = must(await callStep(ctx, id, STEPS.spec, { cwd: ctx.root, prompt: specPrompt(ctx.root, id), schema: schemas.SPEC }));
  state.spec = spec;
  for (const ask of spec.asks) {
    const asked = backlog(ctx.root, ...askArgs(id, ask));
    if (!asked.ok) halt(`할 일 적기 단계에서 멈춤(일감 목록 ${ask.kind} 명령 실패): ${asked.err || asked.out}`);
  }
  if (spec.pendingQuestions.length) halt(`할 일 적기 단계에서 멈춤(답을 기다리는 질문): ${spec.pendingQuestions.join(' / ')}`);
  const waiting = spec.asks.some(ask => ask.kind === '허락');
  if (waiting || SPEC_STOPS.includes(spec.outcome)) halt(`할 일 적기 단계에서 멈춤(${waiting ? '허락 대기' : spec.outcome}): ${spec.reason}`);
  recordSpec(ctx.root, id, spec);
}

async function matchSpec(ctx, state) {
  const { id } = state;
  const review = must(await callStep(ctx, id, STEPS.specReview, { cwd: ctx.root, prompt: specReviewPrompt(ctx.root, id), schema: schemas.SPEC_REVIEWED }));
  state.specReview = review;
  if (!review.passed || review.findings.some(finding => finding.level !== '낮음')) halt('맞춰보기 단계에서 멈춤: 높음·중간 지적이 있거나 사용자 원래 말 절이 없다');
}

const failureText = check => (check.output === undefined ? check.reason : `${check.command} (종료 코드 ${check.exitCode ?? '없음, 시간 초과'})\n${check.output}`);

// 허락 질문이 답을 기다리는 동안은 그 작업에 쓰는 일(워크트리 만들기·만들기·고치기)을 시작하지 않는다. 도는 중에 질문이 생길 수 있어 쓰기 직전마다 일감 목록을 다시 본다.
function haltIfWaiting(ctx, id) {
  const { waiting, error } = taskInfo(ctx.root, id);
  if (error) halt(`허락 질문을 확인하지 못해 쓰기 전에 멈춤: ${error}`);
  if (waiting.length) halt(`답을 기다리는 허락 질문이 있어 쓰기 전에 멈춤: ${waiting.join(' / ')}`);
}

const treeOf = worktree => {
  const shot = snapshot(worktree);
  return shot.ok ? shot.tree : halt(`작업 폴더 상태를 읽지 못했다: ${shot.reason}`);
};

// 만들기·고치기: 도구가 작업 워크트리에 쓰고, 코드가 확인 명령을 돌린다. 통과했을 때만 커밋한다:
// 실패한 내용을 먼저 커밋하면 검사기가 HEAD와 비교해 그 위반을 이미 있던 것으로 보고 고치지 않은 채 통과시킨다(Codex 재현).
async function writeCode(ctx, state, step, prompt, schema) {
  const before = treeOf(state.worktree);
  const res = await callStep(ctx, state.id, step, { cwd: state.worktree, prompt, schema, write: true });
  const { summary } = must(res);
  state.writer = res.tool;
  if (treeOf(state.worktree) === before) halt(`${step.label} 단계에서 멈춤: 커밋할 바뀐 파일이 없다`);
  await checkAndCommit(ctx, state, step, `${state.id}: ${summary.split('\n')[0]}`);
}

// 확인 명령을 돌리고 통과했을 때만 message로 커밋한다. skipIfClean이면 통과한 뒤에도 바뀐 파일이 없을 때 state.commit(지금 HEAD)을 그대로 쓴다.
// 확인 명령이 파일을 고칠 수 있어, 검사한 상태와 올릴 커밋이 같도록 커밋 여부는 통과한 뒤에 정한다.
async function checkAndCommit(ctx, state, step, message, skipIfClean = false) {
  const check = ctx.checks.length ? await runChecks(state.worktree, ctx.checks, { base: ctx.config.base }) : undefined;
  if (check) Object.assign(state, { checkPassed: check.ok, checkFailures: check.ok ? '' : failureText(check) });
  if (check && !check.ok) return;
  if (!skipIfClean || inspectBranch(state.worktree, ctx.config.base).dirty) {
    const committed = commitAll(state.worktree, message);
    if (!committed.ok) halt(`${step.label} 단계에서 멈춤: ${committed.reason}`);
    state.commit = committed.commit;
  }
  if (!check) halt('돌려보기 단계에서 멈춤: 돌릴 확인 명령이 없다(.claude/agents/implementer.md의 `- 확인 명령:` 줄)');
}

// 멈춘 작업 이어 가기: 만들기 도구를 부르지 않고 지금 상태를 돌려본다. 앞서 한 일이 없으면 false(만들기를 처음처럼 부른다).
// 앞서 어느 도구가 썼는지는 기록에 없어 만들기 단계 도구를 작성 도구로 둔다.
async function resumeWork(ctx, state) {
  const { commits, dirty, head } = inspectBranch(state.worktree, ctx.config.base);
  if (!commits && !dirty) return false;
  state.writer = stageOptions(ctx.config, STEPS.build.key, ctx.tool).tool;
  if (!dirty) state.commit = head;
  await checkAndCommit(ctx, state, STEPS.build, `${state.id}: 앞서 멈춘 작업을 이어 간다`, true);
  return true;
}

async function build(ctx, state) {
  const { id } = state;
  haltIfWaiting(ctx, id);
  const rejection = state.spec?.rejectedCommit ? { commit: state.spec.rejectedCommit, reason: state.spec.rejectedReason } : undefined;
  const found = state.resume ? openBranch(ctx.root, `ai/${id}`) : rejection ? findResumeBranch(ctx.root, rejection.commit) : createWorktree(ctx.root, id);
  if (!found.ok) halt(`만들기 단계에서 멈춤: ${found.stopReason ?? found.reason}`);
  Object.assign(state, { worktree: found.worktree, branches: [found.branch], resumed: Boolean(state.resume || rejection), fixes: 0 });
  if (state.resume && await resumeWork(ctx, state)) return;
  await writeCode(ctx, state, STEPS.build, buildPrompt(ctx.root, id, rejection), schemas.BUILT);
}

// 살피기 담당과 다른 도구는 서로의 지적을 모른 채 따로 본다. 둘 다 끝난 뒤에 실패를 알린다.
async function crossReview(ctx, state) {
  const { id } = state;
  const ms = ctx.seconds && ctx.seconds * 1000;
  const [mine, other] = await Promise.all([
    callStep(ctx, id, STEPS.review, { cwd: state.worktree, prompt: reviewPrompt(ctx.root, id, ctx.config.base), schema: schemas.REVIEWED }),
    reviewOther({ repo: ctx.root, id, worktree: state.worktree, commit: state.commit, base: ctx.config.base, author: state.writer, ...(ms && { timeouts: { breaking: ms, readOnly: ms } }) }),
  ]);
  const findings = [...(mine.ok ? mine.result.findings : []), ...other.findings];
  Object.assign(state, { reviewTool: other.tool, highs: findings.filter(finding => finding.level === '높음'), others: findings.filter(finding => finding.level !== '높음') });
  if (other.agentapiChanged) halt('다른 도구 검토 뒤 진짜 홈 agentapi가 바뀜: 고치지 않고 멈춘다. 사람이 본다');
  must(mine);
}

async function raise(ctx, state) {
  const { id } = state;
  // 일감 목록은 맡길곳을 작성 도구로 보고 그 도구의 검토를 거절한다. 단계 도구로 실제 작성 도구를 바꾸면 바깥 검토가 맡길곳과 같아질 수 있다.
  if (Object.keys(ctx.config.limits).length > 1 && state.reviewTool === state.assignee) {
    halt(`올림 단계에서 멈춤: 바깥 검토 도구(${state.reviewTool})가 일감 목록의 맡길곳과 같아 일감 목록이 올림을 거절한다(실제 작성 도구 ${state.writer}). 단계모델의 만들기·고치기 도구를 맡길곳과 맞추거나 사람이 다른 도구로 검토한다`);
  }
  const numbers = criteriaNumbers(ctx.root, id);
  if (!numbers.length) halt('올림 단계에서 멈춤: 작업 문서 `## 끝 기준` 절에서 번호 항목(1. 또는 1))을 하나도 읽지 못했다');
  const evidence = must(await callStep(ctx, id, STEPS.raise, { cwd: state.worktree, prompt: evidencePrompt(ctx.root, id, state.commit), schema: schemas.EVIDENCE }));
  const have = new Set(evidence.items.filter(item => item.evidence.trim()).map(item => item.no.trim().replace(/[.)]+$/, '')));
  const missing = numbers.filter(no => !have.has(no));
  if (evidence.unconfirmed.length || missing.length) {
    halt(`올림 단계에서 멈춤(증거 부족): ${[...missing.map(no => `${no}번 증거 없음`), ...evidence.unconfirmed].join(' / ')}`);
  }
  const text = evidence.items.map(item => `${item.no}. ${item.evidence}`).join('\n');
  const raised = backlog(ctx.root, '올림', id, '--커밋', state.commit, '--증거', text, ...(state.reviewTool ? ['--검토', state.reviewTool] : []));
  Object.assign(state, { raised: raised.ok, raiseOutput: [raised.out, raised.ok ? '' : raised.err].filter(Boolean).join('\n') });
}

// 돌려보기(만들기·고치기 안) → 통과하면 번갈아 보기 → 실패나 높음이 있으면 고치고 다시. 고치기는 합쳐서 MAX_FIXES번까지.
async function work(ctx, state) {
  const { id } = state;
  if (!state.resume) {
    await writeSpec(ctx, state);
    await matchSpec(ctx, state);
  }
  await build(ctx, state);
  for (;;) {
    if (state.checkPassed) await crossReview(ctx, state);
    else Object.assign(state, { highs: [], others: [], reviewTool: '' });
    if (state.checkPassed && !state.highs.length) return raise(ctx, state);
    if (state.fixes === MAX_FIXES) return log(id, `${MAX_FIXES}번 고쳐도 돌려보기 실패나 높음이 남아 올리지 않고 진행중으로 둔다`);
    haltIfWaiting(ctx, id);
    state.fixes++;
    const check = { passed: state.checkPassed, failures: state.checkFailures };
    await writeCode(ctx, state, STEPS.fix, fixPrompt(ctx.root, id, check, state.highs), schemas.FIXED);
  }
}

// 멈춘 작업도 같은 칸을 다 둔다. 아직 없는 칸은 null이나 빈 값이다(undefined면 JSON에서 칸이 빠진다).
const finish = state => ({
  id: state.id, worktree: state.worktree ?? null, branches: state.branches ?? [], commit: state.commit ?? null, fixes: state.fixes ?? 0, raised: state.raised ?? false,
  raiseOutput: state.raiseOutput ?? '', checkPassed: state.checkPassed ?? null, checkFailures: state.checkFailures ?? '', highs: state.highs ?? [], others: state.others ?? [],
  resumed: state.resumed ?? false, spec: state.spec ?? null, specReview: state.specReview ?? null,
});
const stopped = (state, reason) => ({ ...finish(state), stopped: true, reason });

async function runTask(ctx, id) {
  const state = { id };
  try {
    const info = taskInfo(ctx.root, id);
    if (info.error) halt(`일감 목록에서 읽지 못했다: ${info.error}`);
    if (info.status !== '진행중') halt(`진행중이 아니다(지금 ${info.status})`);
    state.assignee = info.tool;
    // 반려 기록이 없고 ai/ 브랜치가 이미 있으면 할 일 적기와 맞춰보기는 앞서 통과했다(work는 둘 다 통과한 뒤에만 워크트리를 만든다). 반려는 할 일 적기 결과에서 반려 커밋을 받아야 해서 건너뛰지 못한다.
    state.resume = !info.rejected && branchExists(ctx.root, id);
    await work(ctx, state);
    return finish(state);
  } catch (error) {
    const reason = error instanceof Stop ? error.message : `오류: ${error.message}`;
    log(id, `멈춤: ${reason.split('\n')[0]}`);
    return stopped(state, reason);
  }
}

// 번호를 직접 받지 않으면 맡길곳이 부른 도구인 진행중 작업만 고른다. 배정이 비어 있으면 기본 맡길곳으로 본다.
// 일감 목록에서 맡길곳을 읽지 못한 작업은 어느 도구 것인지 몰라 함께 골라, 그 작업 결과에 멈춘 이유를 남긴다.
const pickTasks = ctx => inProgress(ctx.root).filter(id => {
  const info = taskInfo(ctx.root, id);
  return Boolean(info.error) || (info.tool ?? ctx.config.defaultTool) === ctx.tool;
});

async function runPool(items, limit, job) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await job(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { tool, seconds, ids } = parseArguments(process.argv.slice(2));
  const config = readConfig(root);
  for (const role of ['planner', 'reviewer', 'implementer']) rolePrompt(root, role, '');
  const ctx = { root, tool, seconds, config, checks: readCheckCommands(root) };
  const tasks = ids.length ? ids : pickTasks(ctx);
  // 동시상한이 설정에 없을 때만 1이다. 적힌 0은 그 도구로 돌리지 말라는 뜻으로 지킨다.
  const limit = barred(config, tool) ? 1 : config.limits[tool] ?? 1;
  const job = barred(config, tool) ? async id => stopped({ id }, `일감목록.동시상한.${tool}이 ${config.limits[tool]}이라 이 도구로는 돌리지 않는다`) : id => runTask(ctx, id);
  console.log(JSON.stringify(await runPool(tasks, limit, job), null, 2));
}

main().catch(error => {
  console.error(`mullebanga: ${error.message}`);
  process.exitCode = 1;
});
