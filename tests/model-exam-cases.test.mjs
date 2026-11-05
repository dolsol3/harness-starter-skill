import { referenceSolutions } from './model-exam-cases-reference.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cases, prepareCase } from '../scripts/model-exam-fixtures.mjs';
import { gradeCase, answerHash, rubrics } from '../scripts/model-exam-grade.mjs';
import { assets } from '../scripts/model-exam-public.mjs';
import { createWorktree } from '../templates/harness/mullebanga-git.mjs';

const reproductions = {
  Q8: `import assert from 'node:assert/strict';
import {show} from './answers.mjs';
let rows=Array.from({length:101},(_,i)=>({id:String(i),state:'answered',unread:false}));
rows.push({id:'new',state:'answered',unread:true},{id:'unseen',state:'answered',unread:true});
const ids=show({load:()=>structuredClone(rows),save:value=>{rows=value;}},'answered',1);
assert.deepEqual(ids,['new']);
assert.equal(rows.find(row=>row.id==='new').unread,false);
assert.equal(rows.find(row=>row.id==='unseen').unread,true);
`,
  Q9: `import assert from 'node:assert/strict';
import {createQueue} from './queue.mjs';
let rows=[];
const store={load:()=>structuredClone(rows),save:value=>{rows=structuredClone(value);}};
const calls=[];
let release;
const queue=createQueue(store,id=>{calls.push(id);return new Promise(resolve=>{release=resolve;});});
queue.add('a');
queue.add('b');
const first=queue.run();
const second=queue.run();
assert.deepEqual(calls,['a']);
assert.equal(rows[0].state,'running');
queue.cancel('a');
queue.cancel('b');
release();
await Promise.all([first,second]);
assert.deepEqual(rows.map(row=>row.state),['cancelled','cancelled']);
assert.deepEqual(calls,['a']);
rows.push({id:'interrupted',state:'running'},{id:'done',state:'done'},{id:'failed',state:'failed'});
const restarted=createQueue(store,async id=>{calls.push(id);});
assert.equal(rows.find(row=>row.id==='interrupted').state,'queued');
await restarted.run();
assert.deepEqual(calls,['a','interrupted']);
assert.deepEqual(rows.map(row=>row.state),['cancelled','cancelled','done','done','failed']);
`,
};

const solutions = {
  ...referenceSolutions,
  Q4: { 'select.mjs': `export function select(rows, {minScore=-Infinity,limit} = {}) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new RangeError('limit');
  return rows.filter(row=>row.score >= minScore).sort((a,b)=>b.score-a.score).slice(0,limit);
}
` },
  Q9: { 'queue.mjs': `export function createQueue(store, execute) {
  const rows = store.load();
  for (const row of rows) if (row.state === 'running') row.state = 'queued';
  store.save(rows);
  let active;
  async function drain() {
    for (const row of rows) {
      if (row.state !== 'queued') continue;
      row.state = 'running';
      store.save(rows);
      let state = 'done';
      try { await execute(row.id); } catch (error) { state = 'failed'; }
      if (row.state === 'running') row.state = state;
      store.save(rows);
    }
  }
  return {
    add(id) {
      if (rows.some(row=>row.id === id)) return;
      rows.push({id,state:'queued'});
      store.save(rows);
    },
    cancel(id) {
      const row = rows.find(row=>row.id === id);
      if (row && ['queued','running'].includes(row.state)) row.state = 'cancelled';
      store.save(rows);
    },
    run() {
      if (!active) active = drain().finally(()=>{active=undefined;});
      return active;
    },
  };
}
` },
};
function fixture(t,id) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'exam-case-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q',cwd]);
  return {cwd, prepared:prepareCase(id,cwd)};
}
function submit(cwd,files) {
  for (const [name,content] of Object.entries(files)) fs.writeFileSync(path.join(cwd,name),content);
}
function execution(cwd,command) {
  const [bin,...args] = command.split(' ');
  const result = spawnSync(bin,args,{cwd,encoding:'utf8'});
  return {cwd,command,exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
}
test('10 cases keep 2/3/3/2 distribution and disclose no grading assets', t=>{
  assert.deepEqual(['쉬움','중간','어려움','초고난도'].map(level=>cases.filter(c=>c.difficulty===level).length),[2,3,3,2]);
  for (const item of cases.filter(c=>c.id !== 'Q10')) {
    const {cwd,prepared} = fixture(t,item.id);
    assert.ok(item.stage && item.mode && item.timeoutSeconds > 0);
    assert.ok(prepared.prompt && prepared.schema && Array.isArray(prepared.checks));
    assert.deepEqual(fs.readdirSync(cwd).filter(n=>n!=='.git').sort(),Object.keys(assets[item.id]??{}).sort());
    assert.equal(execFileSync('git',['rev-list','--all'],{cwd,stdio:'pipe'}).length,0);
  }
});
test('preparation rejects a repository with a remote instead of exposing it to candidates',t=>{
  const {cwd}=fixture(t,'Q1');
  execFileSync('git',['remote','add','origin','.'],{cwd});
  assert.throws(()=>prepareCase('Q1',cwd),/이력과 원격/);
});
for (const id of ['Q4','Q7','Q8','Q9']) test(`${id}: baseline, correct, public-test forgery and omitted execution`,t=>{
  const {cwd,prepared} = fixture(t,id);
  const initial = gradeCase(id,{cwd,answer:{summary:'implemented'}});
  submit(cwd,solutions[id]);
  const command = prepared.checks[0];
  const run = execution(cwd,command);
  assert.equal(run.exitCode,0,run.stderr);
  const commands=[run];
  const assessments=[];
  if (['Q8','Q9'].includes(id)) {
    fs.writeFileSync(path.join(cwd,'repro-fresh.mjs'),reproductions[id]);
    const repro=execution(cwd,'node repro-fresh.mjs');
    assert.equal(repro.exitCode,0,repro.stderr);
    commands.push(repro);
    const reasons=id==='Q8'
      ? {displayRead:'101 read rows then new/unseen, limit 1: only new displayed/read, unseen stays unread; assertions passed'}
      : {manualPromise:'concurrent run while a pending: only a called; cancel a/b then resolve: both stay cancelled',restart:'new queue on saved running/done/failed/cancelled: only interrupted requeued and executed'};
    for (const [criterion,reason] of Object.entries(reasons)) assessments.push({criterion,score:1,reason,answerHash:answerHash(undefined),reproductionHash:answerHash({run:repro,source:reproductions[id]})});
  }
  const evidence = {commands,assessments};
  const correct = gradeCase(id,{cwd,evidence});
  assert.equal(correct.score,10,JSON.stringify(correct));
  assert.ok(initial.score < correct.score);
  assert.equal(gradeCase(id,{cwd}).score,9);
  if (['Q8','Q9'].includes(id)) {
    const executionScore=evidence=>gradeCase(id,{cwd,evidence}).criteria.find(c=>c.name==='execution').score;
    assert.equal(executionScore({commands:[run]}),0);
    assert.equal(executionScore({commands}),0);
    for (const missing of assessments) assert.equal(executionScore({...evidence,assessments:assessments.filter(row=>row!==missing)}),0);
    assert.equal(executionScore({...evidence,assessments:assessments.map(row=>({...row,score:0}))}),0);
    assert.equal(executionScore({...evidence,commands:commands.map(row=>({...row,stdout:'different observation'}))}),0);
    fs.writeFileSync(path.join(cwd,'repro-fresh.mjs'),'');
    const noop=execution(cwd,'node repro-fresh.mjs');
    assert.equal(noop.exitCode,0);
    assert.equal(executionScore({commands:[run,noop]}),0);
    assert.equal(executionScore(evidence),0);
  }
  submit(cwd,assets[id]);
  fs.writeFileSync(path.join(cwd,'public.test.mjs'),'process.exitCode = 0;\n');
  assert.ok(gradeCase(id,{cwd,evidence}).score < 9);
  assert.equal(gradeCase(id,{cwd,evidence}).eligible,false);
});
for (const initial of ['none','master']) test(`Q10 prepares ${initial} repository before installation on main`,t=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exam-workflow-'));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'exam-home-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={...process.env,HOME:home,USERPROFILE:home,HARNESS_STARTER_NO_UPDATE_CHECK:'1'};
  if (initial==='master') execFileSync('git',['-c','init.defaultBranch=master','init','-q',cwd],{env});
  const prepared=prepareCase('Q10',cwd);
  assert.ok(fs.existsSync(path.join(cwd,'harness/mullebanga.mjs')));
  assert.equal(execFileSync('git',['rev-list','--all'],{cwd,encoding:'utf8'}),'');
  for (const command of prepared.workflow.setup) execFileSync(command,{cwd,env,shell:true,stdio:'pipe'});
  assert.equal(execFileSync('git',['branch','--show-current'],{cwd,encoding:'utf8'}).trim(),'main');
  const result=createWorktree(cwd,'T-1');
  assert.equal(result.ok,true,JSON.stringify(result));
});
test('independent requirement weights reject targeted defective solutions',t=>{
  const variants = [
    ['Q4','select.mjs','b.score-a.score','a.score-b.score','sorting'],
    ['Q7','settings.mjs','if (allowed!==true)','if (false)','state'],
    ['Q8','answers.mjs','ids.includes(row.id)',"row.state===state",'falseReview'],
    ['Q9','queue.mjs',"if (row.state === 'running') row.state = state;",'row.state = state;','cancel'],
    ['Q9','queue.mjs',"if (row.state === 'running') row.state = 'queued';", "if (false) row.state = 'queued';",'recovery'],
    ['Q9','queue.mjs','if (!active) active = drain()', 'active = drain()','ordering'],
  ];
  for (const [id,file,from,to,criterion] of variants) {
    const {cwd}=fixture(t,id);
    submit(cwd,solutions[id]);
    assert.ok(solutions[id][file].includes(from));
    fs.writeFileSync(path.join(cwd,file),solutions[id][file].replace(from,to));
    const graded=gradeCase(id,{cwd});
    assert.equal(graded.criteria.find(c=>c.name===criterion).score,0,JSON.stringify(graded));
  }
});
test('Q4 deducts only the independently broken behavior requirement',t=>{
  const variants = [
    ['row.score >= minScore','true','filter'],
    ['b.score-a.score','a.score-b.score','sorting'],
    ['slice(0,limit)','slice(0,Infinity)','limits'],
  ];
  for (const [from,to,missing] of variants) {
    const {cwd}=fixture(t,'Q4');
    submit(cwd,solutions.Q4);
    fs.writeFileSync(path.join(cwd,'select.mjs'),solutions.Q4['select.mjs'].replace(from,to));
    const result=gradeCase('Q4',{cwd});
    assert.equal(result.score,7,JSON.stringify(result));
    assert.deepEqual(result.missing,[missing,'execution']);
    assert.equal(result.criteria.find(row=>row.name===missing).maxScore,2);
  }
});
test('Q2 commands are actually run; prose cannot claim execution',t=>{
  const {cwd}=fixture(t,'Q2');
  const commands=['node check.mjs pass','node check.mjs fail'].map(command=>execution(cwd,command));
  assert.deepEqual(commands.map(c=>c.exitCode),[0,1]);
  assert.equal(gradeCase('Q2',{cwd,evidence:{commands}}).score,3);
  assert.equal(gradeCase('Q2',{cwd,answer:{summary:'both checks passed'}}).score,0);
});
test('semantic rubric requires independent answer-bound reasoning and penalizes false positives',t=>{
  const summaries = {
    Q1:'U1 파일명 필터와 U2 정렬만 확정. 게시·업로드는 허락 전 대기한다. 파일명 필터와 정렬을 실제 검사해 통과하면 끝이다.',
    Q3:'20.12 glob 없음, 22.13/16 experimental, 22.20 stable. exclude 배열 22.14, URL cwd 22.17, withFileTypes 22.2. AsyncIterator를 수집해 Dirent를 상대 경로로 바꿔 정렬한다. 부정 패턴은 미지원이다. 공통 대안은 fileURLToPath와 안정 readdir withFileTypes로 부모와 name을 join하고 node_modules/dist를 재귀 전에 제외하며 isDirectory/isFile만 처리해 symlink를 따라가지 않는다. 4개 버전 문서를 확인했으며 이전 Node는 실행하지 않았다.',
    Q5:'review.mjs total의 초기값 없는 reduce 때문에 []의 기대 0 대신 TypeError가 난다. release는 콜백 실행 시 최신 토큰을 검사하므로 정상이다.',
  };
  for (const id of ['Q1','Q3','Q5']) {
    const {cwd}=fixture(t,id);
    const answer={summary:summaries[id]};
    const assessments=rubrics[id].map(([criterion,score,reason])=>({criterion,score,reason,answerHash:answerHash(answer)}));
    const reproduction = id==='Q5' ? spawnSync(process.execPath,['--input-type=module','-e',"import {total} from './review.mjs'; try {total([])} catch (error) {console.log(error.name)}"],{cwd,encoding:'utf8'}) : {};
    if (id==='Q5') assert.equal(reproduction.stdout.trim(),'TypeError');
    const evidence={assessments,openedSources:['20.12.0','22.13.0','22.16.0','22.20.0'].map(v=>`https://nodejs.org/download/release/v${v}/docs/api/fs.html#${v==='20.12.0'?'fspromisesreaddirpath-options':'fspromisesglobpattern-options'}`),commands:[{cwd,command:'node --input-type=module -e reproduction',exitCode:reproduction.status,stdout:reproduction.stdout,stderr:reproduction.stderr}]};
    assert.equal(gradeCase(id,{cwd,answer,evidence}).score,10);
    assert.equal(gradeCase(id,{cwd,answer:{summary:'wrong'},evidence}).score,0);
    const partial={...evidence,assessments:assessments.slice(1)};
    assert.equal(gradeCase(id,{cwd,answer,evidence:partial}).score,10-rubrics[id][0][1]);
    if (id==='Q5') assert.equal(gradeCase(id,{cwd,answer,evidence:{...evidence,falsePositives:['release']}}).score,8);
    if (id==='Q3') assert.equal(gradeCase(id,{cwd,answer,evidence:{...evidence,openedSources:[]}}).score,8);
  }
});
test('Q10 installs a real workflow, keeps graders out, and needs observed receipts',t=>{
  const {cwd,prepared}=fixture(t,'Q10');
  assert.ok(fs.existsSync(path.join(cwd,'harness/mullebanga.mjs')));
  assert.match(prepared.workflow.command,/mullebanga.mjs --도구 codex/);
  assert.equal(prepared.workflow.maxFixes,3);
  assert.equal(execFileSync('git',['remote'],{cwd,encoding:'utf8'}),'');
  submit(cwd,solutions.Q10);
  assert.equal(gradeCase('Q10',{cwd,answer:{summary:'raised'}}).score,4);
  const receipts=Object.fromEntries(['spec','specReview','build','review'].map(stage=>[stage,{artifact:`external/${stage}.json`,ok:true}]));
  const workflow={receipts,raised:true,checkPassed:true,reviewTool:'gemini',writer:'codex',fixes:0,commit:'observed-hash',criteriaEvidence:'1) checked 2) reviewed'};
  assert.equal(gradeCase('Q10',{cwd,workflow}).score,10);
  assert.equal(gradeCase('Q10',{cwd,workflow:{...workflow,reviewTool:'codex'}}).score,8);
});
test('Q4 distinguishes omitted unlimited limit from explicit Infinity and NaN',t=>{
  const {cwd}=fixture(t,'Q4');
  submit(cwd,solutions.Q4);
  const result=gradeCase('Q4',{cwd});
  assert.equal(result.reports.limits.passed,true,JSON.stringify(result));
  const source=solutions.Q4['select.mjs'];
  const mutant=source.replace('limit !== undefined &&','limit !== Infinity && limit !== undefined &&');
  assert.notEqual(mutant,source);
  fs.writeFileSync(path.join(cwd,'select.mjs'),mutant);
  assert.equal(gradeCase('Q4',{cwd}).reports.limits.passed,false);
});
