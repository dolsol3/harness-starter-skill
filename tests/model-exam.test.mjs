import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { examine, failureType, sourceHashes } from '../scripts/model-exam.mjs';
import { rescore } from '../scripts/model-exam-rescore.mjs';
import { answerHash } from '../scripts/model-exam-grade.mjs';
import { usageTotal, selectRepeats } from '../scripts/model-exam-report.mjs';
import { tempDir, writeFakeTool } from './helpers.mjs';
import { referenceSolutions } from './model-exam-cases-reference.mjs';

const solutions = { ...referenceSolutions, Q4: { 'select.mjs': `export function select(rows, {minScore=-Infinity,limit} = {}) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new RangeError('limit');
  return rows.filter(row=>row.score >= minScore).sort((a,b)=>b.score-a.score).slice(0,limit);
}` } };
function fixture(t) {
  const dir = tempDir(t, 'exam-runner-');
  const payload = path.join(dir, 'solutions.json');
  fs.writeFileSync(payload, JSON.stringify(solutions));
  for (const name of ['codex', 'claude', 'agy']) writeFakeTool(dir, name, `#!/usr/bin/env node
const fs=require('node:fs');
const cp=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('--help')||args.includes('--version'))process.exit(0);
let input='';
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
 const cwd=process.cwd();
 if(process.env.ACTIVITY){
  fs.appendFileSync(process.env.ACTIVITY,JSON.stringify({pid:process.pid,active:1})+'\\n');
  process.on('exit',()=>fs.appendFileSync(process.env.ACTIVITY,JSON.stringify({pid:process.pid,active:-1})+'\\n'));
 }
 const schema=JSON.parse(args.includes('--output-schema')?fs.readFileSync(args[args.indexOf('--output-schema')+1]):'${name}'==='agy'?fs.readFileSync(args[args.indexOf('--json-schema')+1]):args[args.indexOf('--json-schema')+1]);
 const model=args[args.indexOf(args.includes('-m')?'-m':'--model')+1];
 fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({args,input,cwd,role:args.includes('--agent')?fs.readFileSync('.agents/agents/'+args[args.indexOf('--agent')+1]+'.md','utf8'):null,home:process.env.HOME,remotes:cp.execFileSync('git',['remote'],{encoding:'utf8'})})+'\\n');
 if(model==='slow')return setInterval(()=>{},1000);
 if(model==='limit'){console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:1}}));console.error('quota exceeded');process.exit(1);}
 const all=JSON.parse(fs.readFileSync(process.env.SOLUTIONS));
 let answer={summary:'actual evidence'};
 const p=schema.properties;
 if(p.outcome)answer={outcome:'썼음',reason:'',rejectedCommit:'',rejectedReason:'',pendingQuestions:[],asks:[],specText:'## 왜 하나\\nCSV\\n## 끝 기준\\n1. CSV 파싱과 저장 동작, node --test public.test.mjs 실행 확인'};
 else if(p.passed)answer={passed:true,findings:[]};
 else if(p.findings&&p.items)answer={findings:[],items:[{no:'1',evidence:'node --test public.test.mjs exit 0'}],unconfirmed:[]};
 else if(p.findings)answer={findings:[]};
 else {
  let id=fs.existsSync('select.mjs')?'Q4':fs.existsSync('parse.mjs')?'Q10':null;
  if(id)for(const [file,source]of Object.entries(all[id]))fs.writeFileSync(file,source);
  const commands=fs.existsSync('check.mjs')?['node check.mjs pass','node check.mjs fail']:fs.existsSync('public.test.mjs')?['node --test public.test.mjs']:[];
  for(const command of commands){
   const r=cp.spawnSync(command,{shell:true,encoding:'utf8'});
   if('${name}'==='codex')console.log(JSON.stringify({type:'item.completed',item:{id:command,type:'command_execution',status:'completed',command,exit_code:r.status,aggregated_output:r.stdout+r.stderr}}));
  }
 }
 if(process.env.DIRTY)fs.writeFileSync('public.test.mjs','changed');
 if('${name}'==='codex'){
  fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(model==='bad'?{}:answer));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:50,output_tokens:10}}));
 }else if('${name}'==='agy'){
  console.log(JSON.stringify({event:'init',init:{permission_mode:'always-proceed',model}}));
  console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:answer,usage:{input_tokens:100,output_tokens:10,total_tokens:110}}}));
 }else console.log(JSON.stringify({type:'result',structured_output:answer,usage:{input_tokens:100,cache_read_input_tokens:20,cache_creation_input_tokens:0,output_tokens:10}}));
});
`);
  writeFakeTool(dir, 'sandbox-exec', `#!/usr/bin/env node
const cp=require('node:child_process');
const args=process.argv.slice(4);
const run=cp.spawnSync(args[0],args.slice(1),{stdio:'inherit'});
process.exit(run.status ?? 1);
`);
  const candidate = { id: 'writer', tool: 'codex', model: 'future-model', effort: 'future-depth' };
  const config = { phase: 'main', maxCalls: 50, maxInputChars: 80000, timeoutMs: 20000, seed: 'test',
    candidates: [candidate], concurrency: { codex: 2, claude: 1 }, tasks: ['Q2', 'Q4'], rounds: [1],
    reviewers: { codex: { tool: 'claude', model: 'fixed-review', effort: 'medium' } }, repeatStages: { 만들기: ['Q4'] } };
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, SOLUTIONS: payload, FAKE_LOG: path.join(dir, 'log') };
  for (const name of ['codex', 'claude']) env[`HARNESS_${name.toUpperCase()}_BIN`] = path.join(dir, name + (process.platform === 'win32' ? '.cmd' : ''));
  env.HARNESS_GEMINI_BIN = path.join(dir, 'agy' + (process.platform === 'win32' ? '.cmd' : ''));
  return { dir, config, env, out: path.join(dir, 'out'), events: () => fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
test('미리보기는 무쓰기·무호출이며 Q1·Q2를 뺀 336회차와 전체 최대 예산을 분리한다', async t => {
  const f = fixture(t);
  const config = { ...JSON.parse(fs.readFileSync('scripts/model-exam.json')), maxCalls: 560 };
  const p = await examine(config, f.out, false, f.env);
  assert.equal(p.taskRounds, 336);
  assert.deepEqual(p.cases.map(c => c.id), Array.from({ length: 21 }, (_, i) => `Q${i + 3}`));
  assert.ok(p.cases.every(c => c.stage && c.difficulty && c.timeoutSeconds));
  assert.equal(p.maximumElapsedMs, 16 * p.cases.reduce((n, c) => n + c.timeoutSeconds * 1000, 0));
  assert.equal(p.budget.gradingCalls,0);
  assert.equal(p.budget.gradingCallsUnit,'별도 CLI 호출');
  assert.match(p.budget.grading,/AI 토큰 미계측/);
  assert.equal(p.newCalls, 560);
  assert.equal(p.budget.repeatCalls, 140);
  assert.equal(p.budget.studyMaximum, 724);
  assert.equal(p.jobs.filter(j => j.case.id === 'Q10').length, 16);
  assert.equal(fs.existsSync(f.out), false);
  assert.deepEqual(f.events(), []);
  assert.equal((await examine({ ...config, phase: 'infrastructure' }, f.out)).taskRounds, 3);
  assert.equal((await examine({ ...config, phase: 'pilot' }, f.out)).taskRounds, 6);
  await assert.rejects(examine({ ...f.config, maxCalls: 1 }, f.out, true, f.env), /예산 초과/);
  await assert.rejects(examine({ ...f.config, maxInputChars: 1 }, f.out, true, f.env), /입력 예산/);
  await assert.rejects(examine(f.config, process.cwd()), /저장소 밖/);
});
test('독립 fixture·실제 명령 증거·네이티브 usage·미채점·완료 캐시와 판정 연결', async t => {
  const f = fixture(t);
  const s = await examine(f.config, f.out, true, f.env);
  assert.equal(s.counts.calls, 2);
  const q2 = s.results.find(r => r.case.id === 'Q2');
  const q4 = s.results.find(r => r.case.id === 'Q4');
  assert.equal(q2.grade.score, 3);
  assert.equal(q2.grading.status, '미채점');
  assert.equal(q4.grade.score, 10);
  assert.equal(usageTotal(q4.calls).total, 110);
  assert.equal(q2.calls[0].evidence.commands.length, 2);
  assert.ok(f.events().every(e => e.home === f.env.HOME && e.remotes === '' && !fs.existsSync(e.cwd)));
  const judgment = path.join(f.dir, 'assessments');
  fs.mkdirSync(judgment);
  const data = JSON.parse(fs.readFileSync(path.join(q2.folder, 'evidence.json')));
  fs.writeFileSync(path.join(judgment, `${q2.key}.json`), JSON.stringify({ judge: { id: 'main', rubricVersion: 2 }, answerHash: answerHash(data.answer),
    assessments: [['interpretation', 3], ['waiting', 2], ['report', 2]].map(([criterion, score]) => ({ criterion, score, reason: 'fixture actual inspection', answerHash: answerHash(data.answer) })) }));
  const reused = await examine({ ...f.config, maxCalls: 0, assessments: judgment }, f.out, true, f.env);
  assert.equal(reused.counts.reused, 2);
  assert.equal(reused.results.find(r => r.case.id === 'Q2').grade.score, 10);
  assert.equal(reused.results.find(r => r.case.id === 'Q2').status, '완료');
  assert.equal(f.events().length, 2);
  // 명시 재채점: 모델 호출 없이 저장 파일을 직접 읽고, 두 번 돌려도 같고, 폴더를 옮겨도 된다. 판정이 어긋나면 재판정 필요로 드러난다.
  const shape = summary => summary.results.map(r => [r.case.id, r.grade.score, r.status]);
  const first = rescore(f.out, { ...f.config, assessments: judgment }, sourceHashes(), failureType);
  const moved = path.join(f.dir, 'moved-out');
  fs.renameSync(f.out, moved);
  const second = rescore(moved, { ...f.config, assessments: judgment }, sourceHashes(), failureType);
  assert.deepEqual([first.counts.calls, second.counts.calls], [0, 0]);
  assert.deepEqual(shape(second), shape(first));
  assert.deepEqual(second.originalSources, s.sources);
  assert.equal(second.results.find(r => r.case.id === 'Q2').status, '완료');
  fs.writeFileSync(path.join(judgment, `${q2.key}.json`), JSON.stringify({ judge: { id: 'main', rubricVersion: 2 }, answerHash: 'x', assessments: [{ criterion: 'report', answerHash: 'x' }] }));
  assert.deepEqual(rescore(moved, { ...f.config, assessments: judgment }, sourceHashes(), failureType).results.find(r => r.case.id === 'Q2').grading.pending.slice(0, 1), ['재판정 필요']);
  fs.renameSync(moved, f.out);
  assert.equal((await examine({ ...f.config, timeoutMs: 21000 }, f.out)).newCalls, 2);
  assert.ok(fs.readFileSync(path.join(f.out, 'comparison.html'), 'utf8').includes('data-filter="difficulty"'));
  assert.ok(fs.readFileSync(path.join(f.out, 'comparison.csv'), 'utf8').includes('nativeUsage'));
});
test('지원 실패·시간초과·스키마 오류는 재시도하지 않고 수집된 usage를 보존한다', async t => {
  const f = fixture(t);
  f.config.tasks = ['Q2'];
  f.config.timeoutMs = 5000;
  f.config.candidates = ['limit', 'slow', 'bad'].map(model => ({ id: model, tool: 'codex', model }));
  const s = await examine(f.config, f.out, true, f.env);
  assert.ok(s.results.every(r => !r.ok));
  assert.match(s.results.find(r => r.candidate.id === 'slow').reason, /시간초과/);
  const limit = s.results.find(r => r.candidate.id === 'limit');
  assert.equal(limit.reason,'한도');
  assert.equal(limit.calls[0].usage.records[0].values.input, 5);
  assert.equal(limit.calls[0].usage.partial, true);
  assert.equal(f.events().length, 3);
  assert.equal((await examine(f.config, f.out)).newCalls, 0);
  const again=await examine({...f.config,maxCalls:0},f.out,true,f.env);
  assert.equal(again.counts.reused,3);
  assert.equal(f.events().length,3);
});
test('Q10은 실제 공용 흐름·planner 기록·서로 다른 도구 검토·올림을 관측한다', async t => {
  const f = fixture(t);
  f.config.tasks = ['Q10'];
  f.config.timeoutMs = 90000;
  const s = await examine(f.config, f.out, true, f.env);
  const r = s.results[0];
  assert.equal(r.ok, true, JSON.stringify({ reason: r.reason, state: r.state }));
  assert.equal(r.state.spec.outcome, '썼음');
  assert.equal(r.grade.score, 10);
  assert.equal(r.grade.eligible, true);
  assert.equal(r.calls.length, 5);
  assert.equal(r.calls.filter(c => c.stage === '외부검토').length, 1);
  assert.equal(r.calls.filter(c => c.stage === '만들기').length, 1);
  assert.equal(r.calls[0].invocation.argv.includes('--json'), true);
  assert.equal(f.events().filter(e => e.input.includes('끝 기준')).length > 0, true);
});
test('불완전 usage는 0으로 바꾸지 않고 반복 적격 풀이 없으면 추천하지 않는다', () => {
  assert.equal(usageTotal([]).total, null);
  assert.equal(selectRepeats([], { 만들기: ['Q4'] })[0].status, '진단만·추천 금지');
});

test('반복 선발은 정확성 대표와 다른 최소 토큰 도전자를 고르며 누락 때 시간으로 고른다', () => {
  const rows = ['a', 'b', 'c'].flatMap((id, index) => ['Q1', 'Q2', 'Q4'].map(task => ({
    key: id + task, candidate: { id }, case: { id: task }, phase: 'main', ok: true,
    elapsedMs: [10, 2, 30][index], grading: { status: '판정완료' },
    grade: { score: task === 'Q4' && id === 'b' ? 9 : 10, eligible: true,
      stageScores: { 만들기: id === 'b' ? 9 : 10 }, stageMaxScores: { 만들기: 10 }, missing: [], falsePositives: [] },
    calls: [{ tool: 'codex', usage: { partial: false, records: [{ values: { input: [100, 50, 10][index], output: 1 } }] } }],
  })));
  let selection = selectRepeats(rows, { 만들기: ['Q4'] })[0];
  assert.equal(selection.accuracy, 'a');
  assert.equal(selection.efficiency, 'c');
  assert.equal(selection.costVerified, true);
  rows.find(r => r.key === 'cQ4').calls[0].usage.partial = true;
  selection = selectRepeats(rows, { 만들기: ['Q4'] })[0];
  assert.equal(selection.efficiency, 'b');
  assert.equal(selection.costVerified, false);
});

test('Gemini Q2 셸은 최소 exam·쓰기 격리, Q3 웹은 research 역할로 전달한다', async t => {
  const f = fixture(t);
  f.config.tasks = ['Q2', 'Q3'];
  f.config.candidates = [{ id: 'gemini', tool: 'gemini', model: 'future-medium' }];
  f.config.concurrency.gemini = 1;
  const s = await examine(f.config, f.out, true, f.env);
  assert.ok(s.results.every(r => r.ok), JSON.stringify(s.results.map(r => r.reason)));
  assert.deepEqual(f.events().map(e => e.args[e.args.indexOf('--agent') + 1]).sort(), ['exam', 'research']);
  assert.ok(s.results.every(r => usageTotal(r.calls).total === 110));
  const exam=f.events().find(e=>e.args[e.args.indexOf('--agent')+1]==='exam');
  const role=exam.role;
  for(const line of ['name: exam','tools: [view_file, list_dir, grep_search, find_by_name, run_command]','commandExecutionPolicy: eager','mainAgent: true','subagent: false','inheritMcp: false']) assert.ok(role.includes('\n'+line+'\n'),line);
  assert.ok(role.startsWith('---\n'));

});

test('고정된 본시험과 추가 2회를 합치고 같은 결과 해시는 중복 표본으로 세지 않는다', async t => {
  const f = fixture(t);
  f.config.tasks = ['Q4'];
  await examine(f.config, f.out, true, f.env);
  const config = { ...f.config, phase: 'repeat', rounds: [2, 3],
    selections: [{ candidate: 'writer', tasks: ['Q4'] }], previousSummaries: [path.join(f.out, 'summary.json')] };
  const out = path.join(f.dir, 'repeat');
  const result = await examine(config, out, true, f.env);
  assert.equal(result.results.length, 3);
  assert.equal(result.counts.calls, 2);
  assert.match(fs.readFileSync(path.join(out, 'comparison.html'), 'utf8'), /3 \/ 3/);
  const cached = await examine({ ...config, maxCalls: 0 }, out, true, f.env);
  assert.equal(cached.results.length, 3);
  assert.equal(cached.counts.calls, 0);
  assert.equal(f.events().length, 3);
});

test('repeat runs all tools globally serial despite independent per-tool slots',async t=>{
  const f=fixture(t);
  f.config.phase='repeat';
  f.config.tasks=['Q2'];
  f.config.rounds=[2,3];
  f.config.candidates=[{id:'writer',tool:'codex',model:'fake'},{id:'other',tool:'claude',model:'fake'}];
  f.config.selections=f.config.candidates.map(c=>({candidate:c.id,tasks:['Q2']}));
  f.config.concurrency={codex:1,claude:1};
  f.env.ACTIVITY=path.join(f.dir,'activity');
  const result=await examine(f.config,f.out,true,f.env);
  assert.equal(result.counts.calls,4);
  const activity=fs.readFileSync(f.env.ACTIVITY,'utf8').trim().split('\n').map(JSON.parse);
  let active=0,max=0;
  for (const row of activity) { active+=row.active;max=Math.max(max,active); }
  assert.equal(activity.length,8);
  assert.equal(active,0);
  assert.equal(max,1);
});
