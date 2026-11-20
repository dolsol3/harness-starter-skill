import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileState, scopeChanges } from './model-exam-observe.mjs';
import {commandSucceeded,reproductionFile} from './model-exam-meter.mjs';
import { callExam } from './model-exam-call.mjs';
import { prepareCase, workflowChecks } from './model-exam-fixtures.mjs';
import { gradeCase, rubrics, answerHash, reproductionCriteria } from './model-exam-grade.mjs';
import { fits } from '../templates/harness/mullebanga-steps.mjs';
import { killTree, SPAWN_GROUP } from '../templates/harness/mullebanga-call.mjs';

export const save = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
export function git(cwd, args, env) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
// 공용 호출기는 모델 CLI를 detached로 따로 그룹을 만들어 띄운다. 물레방아 그룹만 끄면 그 자식이 살아남아 다음 회차와 겹치므로,
// 끄기 전에 자손 전체의 그룹을 모은다(Windows의 taskkill /T는 이미 트리째 끈다).
function descendantGroups(pid) {
  const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const tree = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, parent] of rows) if (tree.has(parent) && !tree.has(id)) {
      tree.add(id);
      grew = true;
    }
  }
  return [...new Set(rows.filter(([id]) => tree.has(id)).map(([, , group]) => group))].map(group => ({ pid: group }));
}
export function processRun(cwd, args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, ...SPAWN_GROUP });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killer;
    let groups = [child];
    const stop = signal => { for (const group of groups) killTree(group, signal); };
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32') groups = descendantGroups(child.pid);
      stop('SIGTERM');
      killer = setTimeout(() => stop('SIGKILL'), 2000);
    }, timeoutMs);
    child.on('error', error => { stderr += error.message; });
    child.on('close', exitCode => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut) stop('SIGKILL');
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}
function observeWorkflow(cwd, raw) {
  const file = path.join(cwd, 'harness/mullebanga-call.mjs');
  let source = fs.readFileSync(file, 'utf8');
  source = `import { observeCall } from './model-exam-observe.mjs';\n${source}`;
  source = source.replace('export async function callTool(call) {', 'export const callTool = call => observeCall(call, unobservedCall);\nasync function unobservedCall(call) {');
  fs.writeFileSync(file, source);
  for (const name of ['model-exam-observe.mjs', 'model-exam-meter.mjs']) fs.copyFileSync(new URL(name, import.meta.url), path.join(cwd, 'harness', name));
  const flow = path.join(cwd, 'harness/mullebanga.mjs');
  fs.writeFileSync(flow, fs.readFileSync(flow, 'utf8').replace('const call = { tool, cwd,', 'const call = { examStage: step.key, tool, cwd,'));
  fs.mkdirSync(raw);
}
export async function runWorkflow(job, cwd, folder, prepared, env) {
  const raw = path.join(folder, 'calls');
  observeWorkflow(cwd, raw);
  git(cwd, ['add', '.'], env);
  git(cwd, ['-c', 'user.name=Exam', '-c', 'user.email=exam@example.invalid', 'commit', '-qm', 'fixture'], env);
  const runNode = args => execFileSync(process.execPath, args, { cwd, env, stdio: 'pipe' });
  runNode(['harness/backlog.mjs', '추가', 'CSV 미리보기와 확인 저장']);
  runNode(['harness/backlog.mjs', '시작', 'T-1', '--맡길곳', job.candidate.tool, '--고칠곳', 'parse.mjs,store.mjs,cli.mjs,repro*.mjs', '--확인방법', workflowChecks.join('; ')]);
  const run = await processRun(cwd, ['harness/mullebanga.mjs', '--도구', job.candidate.tool, '--시간제한', String(Math.floor(job.timeoutMs / 15000)), 'T-1'],
    { ...env, EXAM_OBSERVE: raw, EXAM_CALL_LIMIT: '15', EXAM_MAX_INPUT: String(job.maxInputChars), EXAM_PROMPT_SUFFIX: job.promptSuffix ?? '' }, job.timeoutMs);
  save(path.join(folder, 'workflow-process.json'), run);
  let state;
  try { state = JSON.parse(run.stdout)[0]; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const calls = fs.readdirSync(raw).sort().map(name => ({ id: name, ...JSON.parse(fs.readFileSync(path.join(raw, name, 'receipt.json'))) }));
  const target = state?.worktree && fs.existsSync(state.worktree) ? state.worktree : cwd;
  const taskFile = path.join(cwd, 'docs/tasks/T-1.md');
  const receipts = {};
  for (const [name, stage] of [['spec', '할일적기'], ['specReview', '맞춰보기'], ['build', '만들기'], ['review', '번갈아보기']]) {
    const call = calls.findLast(row => row.stage === stage && row.result?.ok);
    const produced = name === 'spec' ? state?.spec?.outcome === '썼음' && fs.readFileSync(taskFile, 'utf8').includes(state.spec.specText.trim())
      : name === 'build' ? Boolean(state?.commit && git(target, ['diff', '--name-only', 'main'], env))
        : name === 'specReview' ? state?.specReview?.passed === true : Boolean(state?.reviewTool);
    receipts[name] = { ok: Boolean(call && produced), artifact: call ? path.join(raw, call.id, 'receipt.json') : null };
  }
  return { ok: state?.raised === true, reason: run.timedOut ? '시간초과' : state?.reason ?? (state?.raised ? null : '물레방아 미완료'),
    result: { summary: state?.raiseOutput ?? '' }, calls, target, state,
    workflow: { ...state, writer: job.candidate.tool, receipts, criteriaEvidence: state?.raiseOutput || null } };
}
export function assess(job, folder, result, cwd, evidence, workflow, config) {
  const file = config.assessments && path.join(config.assessments, `${job.key}.json`);
  const judgment = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  const hash = answerHash(result);
  const valid = judgment?.judge?.id && judgment.judge.rubricVersion === 2 && judgment.answerHash === hash;
  const required = [...(rubrics[job.case.id] ?? []).map(([name]) => name),
    ...(reproductionCriteria[job.case.id] ?? [])];
  const assessments = valid ? judgment.assessments ?? [] : [];
  const reproductions = (evidence.commands ?? []).filter(run => reproductionFile(run.command)).map(run => {
    const file = path.join(cwd, reproductionFile(run.command));
    const source = fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file,'utf8') : null;
    return { run, source, reproductionHash: answerHash({ run, source }) };
  });
  // 판정이 있는데 지금 답안·재현 증거와 어긋나면 자동 인정도 0점도 아닌 '재판정 필요'로 드러낸다.
  const mismatched = a => a.reproductionHash && !reproductions.some(r => r.reproductionHash === a.reproductionHash);
  const stale = judgment?.assessments?.length && (!valid || assessments.some(mismatched)) ? ['재판정 필요'] : [];
  const pending = [...stale, ...(evidence.limitations ?? []), ...required.filter(name => !assessments.some(a => a.criterion === name && a.answerHash === hash && a.reason?.trim() && Number.isFinite(a.score)))];
  const observed = { ...evidence, assessments, ...(valid && { falsePositives: judgment.falsePositives ?? [] }) };
  const grade = gradeCase(job.case.id, { cwd, answer: result, evidence: observed, workflow });
  save(path.join(folder, 'grading-packet.json'), { case: job.case, answer: result, answerHash: hash, rubricVersion: 2,
    rubric: rubrics[job.case.id], evidence, reproductions, files: fs.readdirSync(cwd).filter(name => name.endsWith('.mjs')) });
  return { grade, grading: { status: pending.length ? '미채점' : '판정완료', pending, judge: valid ? judgment.judge : null } };
}
export async function runCase(job, cwd, folder, env, config) {
  fs.mkdirSync(folder);
  fs.mkdirSync(cwd);
  git(cwd, ['init', '-q'], env);
  const prepared = prepareCase(job.case.id, cwd, { writer: job.candidate, reviewer: job.reviewer, stages: job.mixedStages });
  let result;
  if (prepared.workflow) result = await runWorkflow(job, cwd, folder, prepared, env);
  else {
    const callEnv = { ...env };
    delete callEnv.HARNESS_READ_ONLY;
    // 검사를 실제로 돌리는 돌려보기 문제는 명령 실행 역할로 부른다.
    const runsChecks = ['Q2', 'Q16', 'Q17'].includes(job.case.id);
    if (runsChecks) prepared.write = true;
    const agent = job.case.id === 'Q3' ? 'research' : runsChecks ? 'exam' : 'readonly';
    if (job.candidate.tool === 'gemini' && (!prepared.write || runsChecks)) {
      const role = path.join(cwd, `.agents/agents/${agent}.md`);
      fs.mkdirSync(path.dirname(role), { recursive: true });
      if (agent === 'exam') fs.writeFileSync(role,'---\nname: exam\ndescription: 공개 시험 명령을 실행하고 실제 관측 결과를 보고한다\ntools: [view_file, list_dir, grep_search, find_by_name, run_command]\ncommandExecutionPolicy: eager\nmainAgent: true\nsubagent: false\ninheritMcp: false\n---\n# 시험 실행\n공개 과제의 확인 명령만 각각 단독 실행하고 결과를 보고한다. HOME·인증·권한·설정은 변경하지 않는다. 최종 답은 summary 문자열 하나를 가진 JSON이다.\n');
      else fs.copyFileSync(new URL(`../templates/antigravity/${agent}.md`, import.meta.url), role);
      if (!prepared.write) callEnv.HARNESS_READ_ONLY = '1';
    }
    const prompt = prepared.prompt + (config.promptSuffix ?? '');
    if (prompt.length + JSON.stringify(prepared.schema).length > config.maxInputChars) throw new Error('입력 예산 초과');
    const before = fileState(cwd);
    result = await callExam({ ...job.candidate, cwd, ...prepared, prompt,
      timeoutMs: job.timeoutMs, env: callEnv, liveWeb: job.case.id === 'Q3',
      agent: job.candidate.tool === 'gemini' && (!prepared.write || runsChecks) ? agent : undefined,
      allowedTools: job.case.id === 'Q3' ? ['Read', 'Bash', 'WebFetch', 'WebSearch'] : prepared.write ? ['Read', 'Bash', 'Edit', 'Write'] : ['Read', 'Bash'] }, path.join(folder, 'raw'));
    if (result.ok && !fits(prepared.schema, result.result)) Object.assign(result, { ok: false, reason: '출력 형식 불일치', detail:'구조화 응답 연결 미확인; 실제 원시 최종 응답과 풀이 정확성을 별도 확인' });
    let allowed = { Q4: /^(select)\.mjs$/, Q5: /^repro[^/]*\.mjs$/, Q7: /^(settings|cli)\.mjs$|^defaults\.json$/, Q8: /^(answers|cli)\.mjs$|^repro[^/]*\.mjs$/, Q9: /^queue\.mjs$|^repro[^/]*\.mjs$/,
      Q20: /^repro[^/]*\.mjs$/, Q21: /^repro[^/]*\.mjs$/, Q22: /^(memo|prices)\.mjs$|^repro[^/]*\.mjs$/, Q23: /^ledger\.mjs$|^repro[^/]*\.mjs$/ }[job.case.id] ?? /^$/;
    if (job.case.id === 'Q8' && result.evidence.commands.some(run => commandSucceeded(run) && /^node cli\.mjs board\.json(?: |$)/.test(run.command))) allowed = /^(answers|cli)\.mjs$|^repro[^/]*\.mjs$|^board\.json$/;
    result.metadataRoots = ['.agents','.claude','.codex'].filter(root=>Object.keys(before).some(name=>name.startsWith(root+'/')));
    result.scopeViolations = scopeChanges(before, cwd, allowed);
    result.calls = [{ ...result, stage: job.case.stage, tool: job.candidate.tool }];
  }
  const target = result.target ?? cwd;
  const evidence = { metadataRoots:result.metadataRoots ?? [], limitations: [], violations: result.calls.flatMap(c => c.scopeViolations ?? []).map(name => `허용 범위 밖 변경: ${name}`), commands: result.calls.flatMap(c => (c.evidence?.commands ?? []).map(run => ({ ...run, cwd: c.cwd ?? target }))),
    openedSources: result.calls.flatMap(c => c.evidence?.openedSources ?? []) };
  let grade;
  let grading = { status: '미채점', pending: ['실행실패'] };
  if (result.result) ({ grade, grading } = assess(job, folder, result.result, target, evidence, result.workflow, config));
  const artifact = path.join(folder, 'submission');
  fs.cpSync(target, artifact, { recursive: true, filter: name => !['.git', '.claude', 'harness', '.agents', '.codex'].includes(path.basename(name)) });
  save(path.join(folder, 'evidence.json'), { evidence, workflow: result.workflow, answer: result.result, originalCwd: target });
  return { ...result, target: artifact, grade, grading };
}
