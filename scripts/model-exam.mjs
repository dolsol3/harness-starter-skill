#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requests } from './model-exam-public.mjs';
import { cases, schema } from './model-exam-fixtures.mjs';
import { rawFolder } from './model-exam-call.mjs';
import { runCase, assess, save } from './model-exam-run.mjs';
import { writeReport, selectRepeats } from './model-exam-report.mjs';
import { rescore } from './model-exam-rescore.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const positive = n => Number.isSafeInteger(n) && n > 0;
export const failureType = r => r.ok ? (r.grade?.eligible === false ? 'gate 위반' : r.grading?.status === '미채점' ? '판정 대기' : r.grade?.score < 10 ? '풀이 오답' : null)
  : /출력 형식/.test(r.reason) ? '구조화 출력/연결' : /시간초과/.test(r.reason) ? '시간 초과' : /unsupported|not supported|unknown model|model.*not found/i.test(r.detail ?? r.reason) ? '미지원'
    : /권한|permission|EPERM|EACCES/i.test(r.detail ?? r.reason) ? '권한' : /network|ECONN|ENOTFOUND|fetch failed/i.test(r.detail ?? r.reason) ? '네트워크' : r.reason ?? '실행 실패';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function sourceHashes() {
  const files = ['scripts', 'templates/harness', 'templates/agents', 'templates/antigravity'];
  const entries = files.flatMap(dir => fs.readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(name => /\.(mjs|md)$/.test(name))
    .filter(name => dir !== 'scripts' || name.startsWith('model-exam') || name.startsWith('install'))
    .map(name => `${dir}/${name}`)).concat('templates/harness/config.json').sort();
  return Object.fromEntries(entries.map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]));
}
function validate(config) {
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 0 || !positive(config.maxInputChars)) throw new Error('호출·입력 예산 오류');
  if (!config.candidates?.length) throw new Error('후보가 비었다');
  const ids = new Set();
  for (const candidate of config.candidates) {
    if (!['claude', 'codex', 'gemini'].includes(candidate.tool) || !positive(config.concurrency?.[candidate.tool])) throw new Error('도구·동시상한 오류');
    if (!candidate.id || ids.has(candidate.id) || !candidate.model) throw new Error('후보 ID·모델 오류');
    ids.add(candidate.id);
  }
  if (config.timeoutMs !== undefined && !positive(config.timeoutMs)) throw new Error('시간 예산 오류');
  if (!['main', 'infrastructure', 'pilot', 'repeat', 'mixed'].includes(config.phase)) throw new Error('시험 phase 오류');
  if (config.phase === 'repeat' && !config.selections?.length) throw new Error('반복 선발 목록이 필요하다');
  if (config.phase === 'mixed' && !config.mixedStages) throw new Error('혼합 단계 설정이 필요하다');
}
const reviewerFor = (candidate, config) => {
  const reviewer = config.reviewers?.[candidate.tool];
  if (!reviewer || reviewer.tool === candidate.tool || !positive(config.concurrency?.[reviewer.tool])) throw new Error('고정 독립 검토 후보·동시상한 필요');
  return reviewer;
};
export function planJobs(config) {
  validate(config);
  let selected = config.candidates;
  let questions = config.tasks ?? cases.filter(c => c.difficulty).map(c => c.id);
  let repetitions = config.rounds ?? [1];
  if (config.phase === 'infrastructure') {
    selected = config.candidates.filter(c => ['haiku', 'sol-medium', 'flash-medium'].includes(c.id));
    if (selected.length !== 3) throw new Error('인프라 시범 3후보 필요');
    questions = ['Q2'];
  }
  if (config.phase === 'mixed') questions = ['Q10'];
  if (config.phase === 'pilot') {
    selected = config.candidates.filter(c => ['haiku', 'astra-xhigh'].includes(c.id));
    if (selected.length !== 2) throw new Error('품질 시범 2후보 필요');
    questions = ['Q3', 'Q7', 'Q9'];
  }
  if (!questions.length || questions.some(id => !cases.some(c => c.id === id)) || !repetitions.length || repetitions.some(n => !positive(n)) || new Set(repetitions).size !== repetitions.length || new Set(questions).size !== questions.length) throw new Error('과제·회차 오류');
  const jobs = [];
  for (const round of repetitions) for (const id of questions) for (const candidate of selected) {
    if (config.phase === 'repeat' && !config.selections.some(s => s.candidate === candidate.id && s.tasks.includes(id))) continue;
    if ((requests[id] + (config.promptSuffix ?? '')).length + JSON.stringify(schema).length > config.maxInputChars) throw new Error('입력 예산 초과');
    const item = cases.find(c => c.id === id);
    const reviewer = id === 'Q10' ? reviewerFor(candidate, config) : null;
    jobs.push({ candidate, reviewer, case: item, round, phase: config.phase, mixedStages: config.mixedStages,
      promptSuffix: config.promptSuffix, access: { file: '원격 없는 최소 fixture', shell: true, liveWeb: id === 'Q3', readIsolation: '미검증' }, maxInputChars: config.maxInputChars, timeoutMs: config.timeoutMs ?? item.timeoutSeconds * 1000, maxCalls: id === 'Q10' ? 15 : 1 });
  }
  // 고정 seed의 해시 순서: 같은 후보가 항상 먼저 돌지 않게 하며 재현 가능하게 남긴다.
  return jobs.sort((a, b) => hash([config.seed, a]).localeCompare(hash([config.seed, b])));
}
export async function examine(config, output, execute = false, env = process.env) {
  const out = rawFolder(output);
  const sources = sourceHashes();
  const jobs = planJobs(config).map(job => {
    const key = hash({ ...job, sources, promptSuffix: config.promptSuffix, maxInputChars: config.maxInputChars,
      concurrency: config.concurrency, access: config.accessVersion });
    const file = path.join(out, `${key}.json`);
    const cached = fs.existsSync(file) ? read(file) : null;
    return { ...job, key, file, cached: cached?.finished === true ? cached : null };
  });
  const newCalls = jobs.reduce((sum, j) => sum + (j.cached ? 0 : j.maxCalls), 0);
  if (newCalls > config.maxCalls) throw new Error(`신규 최대 호출 예산 초과: ${newCalls}/${config.maxCalls}`);
  const stages = config.repeatStages;
  const callsOf = id => id === 'Q10' ? 15 : 1;
  const scored = cases.filter(c => c.difficulty);
  const mainCalls = config.candidates.length * scored.reduce((n, c) => n + callsOf(c.id), 0);
  const repeatCalls = Object.values(stages ?? {}).reduce((sum, ids) => sum + 4 * [...new Set(ids)].reduce((n, id) => n + callsOf(id), 0), 0);
  const plan = { config, versions: { runner: 2, rubric: 2, fixture: jobs.some(job => job.case.id === 'Q10') ? 3 : 2, schema: 1 }, sources, output: out, taskRounds: jobs.length, newCalls,
    cases: cases.filter(c => jobs.some(job => job.case.id === c.id)),
    budget: { mainTaskRounds: config.candidates.length * scored.length, mainCalls,
      infrastructureCalls: 3, pilotCalls: 6, repeatCalls, mixedCalls: 15, gradingCalls: 0, gradingCallsUnit: '별도 CLI 호출',
      studyMaximum: mainCalls + 3 + 6 + repeatCalls + 15,
      grading: '후보명을 가린 AI 판정·메인 확인; 별도 채점 CLI 호출 0; 채점 AI 토큰 미계측', tokenBudget: 'CLI 강제 토큰 상한 없음; 수집량을 보고하며 구독 차감 추정 안 함' },
    maximumElapsedMs: jobs.filter(j => !j.cached).reduce((sum, j) => sum + j.timeoutMs, 0),
    jobs: jobs.map(({ cached, file, ...job }) => ({ ...job, reused: Boolean(cached) })) };
  const previous = (config.previousSummaries ?? []).flatMap(file => {
    const stored = read(file);
    if (stored.versions?.runner !== 2 || hash(stored.sources) !== hash(sources) || !Array.isArray(stored.results)) throw new Error('이전 결과의 runner·소스 버전 불일치');
    return stored.results;
  });
  if (!execute) return plan;
  fs.mkdirSync(out, { recursive: true });
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].includes(key)));
  Object.assign(cleanEnv, { GIT_AUTHOR_NAME: 'Exam', GIT_AUTHOR_EMAIL: 'exam@example.invalid', GIT_COMMITTER_NAME: 'Exam', GIT_COMMITTER_EMAIL: 'exam@example.invalid' });
  async function run(job) {
    if (job.cached) {
      job.result = { ...job.cached, reused: true };
      if (job.result.ok) {
        const data = read(path.join(job.result.folder, 'evidence.json'));
        const evidence = { ...data.evidence, originalCwd: data.originalCwd };
        Object.assign(job.result, assess(job, job.result.folder, data.answer, job.result.target, evidence, data.workflow, config));
        job.result.failureType = failureType(job.result);
        job.result.status = job.result.grading.status === '미채점' ? '미채점' : job.result.grade.eligible ? '완료' : '위반';
      }
      save(job.file, job.result);
      return;
    }
    const folder = path.join(out, `${job.key}-${randomUUID()}`);
    const cwd = path.join(fs.realpathSync(os.tmpdir()), `model-exam-${randomUUID()}`);
    const started = performance.now();
    try {
      const raw = await runCase(job, cwd, folder, cleanEnv, config);
      job.result = { ...raw, status: raw.ok ? (raw.grading.status === '미채점' ? '미채점' : raw.grade.eligible ? '완료' : '위반') : raw.reason,
        elapsedMs: performance.now() - started };
    } catch (error) {
      job.result = { ok: false, status: '실행실패', reason: error.message, elapsedMs: performance.now() - started, calls: [] };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    job.result.failureType = failureType(job.result);
    Object.assign(job.result, { candidate: job.candidate, case: job.case, round: job.round, phase: job.phase, key: job.key,
      sources, folder, finished: true, reused: false, timeoutMs: job.timeoutMs, concurrency: config.concurrency });
    save(job.file, job.result);
  }
  // Q10은 외부 검토도 부르므로 다른 회차와 겹치지 않게 전체 도구 슬롯을 비운 뒤 직렬 실행한다.
  if (config.phase === 'repeat') {
    for (const job of jobs) await run(job);
  } else {
  const singles = jobs.filter(j => j.case.id !== 'Q10');
  await Promise.all(Object.entries(config.concurrency).map(async ([tool, limit]) => {
    const queue = singles.filter(j => j.candidate.tool === tool);
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await run(queue.shift());
    }));
  }));
  for (const job of jobs.filter(j => j.case.id === 'Q10')) await run(job);
  }
  const current = jobs.map(job => job.result);
  const results = [...new Map([...previous, ...current].map(row => [row.key, row])).values()];
  const summary = { ...plan, results, counts: { planned: jobs.length, collected: results.length, reused: current.filter(r => r.reused).length,
    completed: current.filter(r => r.status === '완료').length, failed: current.filter(r => !r.ok).length,
    ungraded: current.filter(r => r.grading?.status === '미채점').length, calls: current.filter(r => !r.reused).reduce((n, r) => n + r.calls.length, 0) } };
  summary.repeatSelection = selectRepeats(results, config.repeatStages);
  save(path.join(out, 'summary.json'), summary);
  writeReport(summary, out);
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') options.run = true;
      else if (['--config', '--out', '--phase', '--rescore'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw new Error(`모르는 옵션 또는 값 누락: ${args[i]}`);
    }
    const config = read(options.config ?? new URL('./model-exam.json', import.meta.url));
    if (options.phase) config.phase = options.phase;
    if (options.rescore) console.log(JSON.stringify(rescore(path.resolve(options.rescore), config, sourceHashes(), failureType).counts, null, 2));
    else console.log(JSON.stringify(await examine(config, options.out, options.run), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
