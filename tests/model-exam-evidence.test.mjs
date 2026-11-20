import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareCase} from '../scripts/model-exam-fixtures.mjs';
import {gradeCase} from '../scripts/model-exam-grade.mjs';
import {meter,examScript} from '../scripts/model-exam-meter.mjs';
import {usageTotal,selectRepeats,stageTiming,stageRows,writeReport} from '../scripts/model-exam-report.mjs';
import {fileState,scopeChanges,observeCall} from '../scripts/model-exam-observe.mjs';
import {tempDir} from './helpers.mjs';
function measured(tool,events) {
  const m=meter(tool);
  m.chunk(events.map(e=>JSON.stringify(e)).join('\n'));
  return m.finish(true);
}
test('Codex completed failure retains native exit and only simple shell wrapping is normalized',()=>{
  const commands=["/bin/zsh -lc 'node check.mjs pass'","/bin/zsh -lc 'node check.mjs fail'","/bin/zsh -lc 'node check.mjs fail; echo OK'"];
  const r=measured('codex',commands.map((command,i)=>({type:'item.completed',item:{id:String(i),type:'command_execution',status:i===1?'failed':'completed',command,exit_code:i===1?1:0,aggregated_output:''}})));
  assert.deepEqual(r.evidence.commands.map(row=>row.exitCode),[0,1,0]);
  assert.deepEqual(r.evidence.commands.map(row=>row.command),['node check.mjs pass','node check.mjs fail',commands[2]]);
  assert.equal(r.evidence.commands[1].rawCommand,commands[1]);
});
function claude(command,output,is_error=false) {
  return [{type:'assistant',message:{content:[{type:'tool_use',id:command,name:'Bash',input:{command}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:command,content:output,is_error}]}}];
}
test('Claude tool success is distinct from native and observed child exit',()=>{
  const events=[...claude('node check.mjs fail; echo "EXIT=$?"','EXIT=1'),
    ...claude('node check.mjs pass','EXAM_CHECK_RESULT:{"mode":"pass","exitCode":0}'),
    ...claude('node check.mjs fail','EXAM_CHECK_RESULT:{"mode":"fail","exitCode":1}',true),
    ...claude('node --test public.test.mjs','tests passed'),
    ...claude('node repro-empty.mjs','Exit code 1\nTypeError: empty reduce',true)];
  const rows=measured('claude',events).evidence.commands;
  assert.equal(rows[0].exitCode,null);
  assert.equal(rows[0].toolStatus,'success');
  assert.equal(rows[0].observedExitCode,undefined);
  assert.equal(rows[1].exitCode,null);
  assert.equal(rows[1].observedExitCode,0);
  assert.equal(rows[2].observedExitCode,1);
  assert.equal(rows[3].toolStatus,'success');
  assert.equal(rows[3].exitSource,null);
  assert.equal(rows[4].exitCode,1);
});
function gemini(index,name,parameters,output,extra={}) {
  return {event:'step_update',step_update:{conversation_id:'observed',step_index:index,step_type:'tool',state:'DONE',tool_name:name,tool_info:{parameters,output,...extra}}};
}
test('Gemini native DONE command headers and actual URL bodies are collected once',()=>{
  const command=gemini(1,'run_command',{CommandLine:'node check.mjs fail; echo "FAIL_EXIT:$?"'},'Command exited with code 0.\n\nCommand output:\nFAIL_EXIT:1\r\n');
  const r=measured('gemini',[command,command,
    gemini(2,'run_command',{CommandLine:'node check.mjs fail'},'Command exited with code 1.\n\nCommand output:\nEXAM_CHECK_RESULT:{"mode":"fail","exitCode":1}'),
    gemini(3,'run_command',{CommandLine:'node --version'},'Command started'),
    gemini(4,'read_url_content',{Url:'https://nodejs.org/body'},'actual document body'),
    gemini(5,'read_url_content',{Url:'https://nodejs.org/pending'},''),
    gemini(6,'read_url_content',{Url:'https://nodejs.org/error'},'not a body',{error:{message:'failed'}})]);
  assert.equal(r.evidence.commands.length,3);
  assert.equal(r.evidence.commands[0].exitCode,0);
  assert.equal(r.evidence.commands[0].observedExitCode,undefined);
  assert.equal(r.evidence.commands[1].exitCode,1);
  assert.equal(r.evidence.commands[2].exitCode,null);
  assert.deepEqual(r.evidence.openedSources,['https://nodejs.org/body']);
});
test('Gemini agy 1.5.8 puts timestamp lines before the exit header',()=>{
  const head='Created At: 2026-11-13T01:00:00Z\nCompleted At: 2026-11-13T01:00:01Z\n';
  const r=measured('gemini',[
    gemini(1,'run_command',{CommandLine:'node a.mjs'},`${head}Command exited with code 0.\n\nCommand output:\nok`),
    gemini(2,'run_command',{CommandLine:'node b.mjs'},`${head}Command exited with code 2.\n\nCommand output:\nfail`),
    gemini(3,'run_command',{CommandLine:'echo x'},'Command exited with code 0.\n\nCommand output:\nCommand exited with code 9.')]);
  const [ok,bad,old]=r.evidence.commands;
  assert.deepEqual([ok.exitCode,ok.toolStatus],[0,'success']);
  assert.deepEqual([bad.exitCode,bad.toolStatus],[2,'error']);
  assert.equal(old.exitCode,0);
});
test('Workflow raw chunks and an incomplete receipt survive immediate process exit',t=>{
  const dir=tempDir(t,'exam-observer-');
  const module=new URL('../scripts/model-exam-observe.mjs',import.meta.url).href;
  const source=`import {observeCall} from ${JSON.stringify(module)};
process.env.EXAM_OBSERVE=${JSON.stringify(dir)};
process.env.EXAM_CALL_LIMIT='15';
process.env.EXAM_MAX_INPUT='10000';
await observeCall({tool:'codex',cwd:${JSON.stringify(dir)},prompt:'x',schema:{},examStage:'만들기'},async call=>{
  call.observe('stdout','collected before abrupt exit');
  call.observe('stderr','diagnostic');
  process.exit(7);
});`;
  const run=spawnSync(process.execPath,['--input-type=module'],{input:source,encoding:'utf8'});
  assert.equal(run.status,7,run.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'call-000/stdout'),'utf8'),'collected before abrupt exit');
  assert.equal(fs.readFileSync(path.join(dir,'call-000/stderr'),'utf8'),'diagnostic');
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,'call-000/receipt.json')));
  assert.equal(receipt.result.ok,false);
  assert.equal(receipt.usage.partial,true);
  assert.equal(receipt.elapsedMs,null);
});
test('Claude totals prefer perModel without double counting and expose main-loop-only incompleteness',()=>{
  const record={values:{input:12,cacheRead:9,cacheWrite:3,output:6}};
  const model={values:{input:20,cacheRead:10,cacheWrite:4,output:8}};
  const call={tool:'claude',usage:{partial:false,records:[record],perModel:[model]}};
  assert.equal(usageTotal([call]).total,42);
  const limited=usageTotal([{...call,usage:{...call.usage,perModel:[]}}]);
  assert.equal(limited.observed,30);
  assert.equal(limited.total,null);
  assert.equal(limited.incomplete,true);
});
test('Unrelated hard-task failure does not exclude a qualified stage but a gate does',()=>{
  const rows=['Q1','Q2','Q4'].map(id=>({candidate:{id:'a'},case:{id},phase:'main',ok:true,elapsedMs:1,grading:{status:'판정완료'},grade:{score:10,eligible:true,stageScores:{만들기:10},stageMaxScores:{만들기:10},missing:[],falsePositives:[]},calls:[]}));
  rows.push({candidate:{id:'a'},case:{id:'Q9'},phase:'main',ok:false,calls:[]});
  assert.equal(selectRepeats(rows,{만들기:['Q4']})[0].status,'적격 1명');
  rows.at(-1).grade={eligible:false};
  assert.equal(selectRepeats(rows,{만들기:['Q4']})[0].status,'진단만·추천 금지');
});

test('Actual Q2 exit markers supply observed child status without forging Claude native exits',t=>{
  const cwd=tempDir(t,'exam-check-marker-');
  assert.equal(spawnSync('git',['init','-q',cwd]).status,0);
  prepareCase('Q2',cwd);
  const events=[];
  for (const mode of ['pass','fail']) {
    const run=spawnSync(process.execPath,['check.mjs',mode],{cwd,encoding:'utf8'});
    assert.equal(run.status,mode==='pass'?0:1);
    events.push(...claude(`node check.mjs ${mode}`,run.stdout,run.status!==0));
  }
  const commands=measured('claude',events).evidence.commands.map(row=>({...row,cwd}));
  assert.deepEqual(commands.map(row=>row.exitCode),[null,null]);
  assert.deepEqual(commands.map(row=>row.observedExitCode),[0,1]);
  assert.equal(gradeCase('Q2',{cwd,evidence:{commands}}).score,3);
});

test('Empty CLI metadata directories are neutral but files and symlink targets remain observable',t=>{
  const cwd=tempDir(t,'exam-metadata-');
  prepareCase('Q4',cwd);
  const before=fileState(cwd);
  for (const name of ['.claude/.cc-writes','.git/branches','.git/objects/info/commit-graphs','.git/remotes']) fs.mkdirSync(path.join(cwd,name),{recursive:true});
  assert.deepEqual(scopeChanges(before,cwd,/^$/),[]);
  assert.equal(gradeCase('Q4',{cwd}).criteria.find(row=>row.name==='scope').score,1);
  fs.writeFileSync(path.join(cwd,'.claude/.cc-writes/changed.txt'),'candidate changed file');
  assert.deepEqual(scopeChanges(before,cwd,/^$/),['.claude/.cc-writes/changed.txt']);
  assert.equal(gradeCase('Q4',{cwd}).criteria.find(row=>row.name==='scope').score,0);
});
test('Preprovided role metadata is separate from submitted implementation scope',t=>{
  const cwd=tempDir(t,'exam-role-baseline-');
  prepareCase('Q4',cwd);
  fs.mkdirSync(path.join(cwd,'.agents/agents'),{recursive:true});
  const role=path.join(cwd,'.agents/agents/exam.md');
  fs.writeFileSync(role,'known role');
  const before=fileState(cwd);
  assert.equal(gradeCase('Q4',{cwd,evidence:{metadataRoots:['.agents']}}).criteria.find(row=>row.name==='scope').score,1);
  fs.writeFileSync(role,'changed role');
  assert.deepEqual(scopeChanges(before,cwd,/^select\.mjs$/),['.agents/agents/exam.md']);
});
test('Gemini original final Markdown remains available when common structured fallback is wrong',()=>{
  const response='# 정상 조사 보고\n내용과 근거';
  const r=measured('gemini',[{event:'result',result:{status:'SUCCESS',response}}]);
  assert.equal(r.nativeFinalResponse,response);
});

test('Workflow 호출 throw도 수집 usage·원시 스트림·실패 receipt를 돌려준다',async t=>{
  const dir=tempDir(t,'exam-observer-throw-');
  const keys=['EXAM_OBSERVE','EXAM_CALL_LIMIT','EXAM_MAX_INPUT'];
  const before=keys.map(key=>process.env[key]);
  process.env.EXAM_OBSERVE=dir;
  process.env.EXAM_CALL_LIMIT='1';
  process.env.EXAM_MAX_INPUT='1000';
  let result;
  try {
    result=await observeCall({tool:'codex',cwd:dir,prompt:'x',schema:{}},async call=>{
      call.observe('stdout',JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}})+'\n');
      call.observe('stderr','cleanup diagnostic');
      throw Object.assign(new Error('real invocation cleanup error'),{code:'ENOTEMPTY'});
    });
  } finally { keys.forEach((key,i)=>before[i]===undefined?delete process.env[key]:process.env[key]=before[i]); }
  assert.equal(result.ok,false);
  assert.equal(result.code,'ENOTEMPTY');
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,'call-000/receipt.json')));
  assert.match(receipt.result.detail,/real invocation cleanup error/);
  assert.equal(receipt.usage.records[0].values.input,7);
  assert.equal(receipt.usage.partial,true);
  assert.equal(fs.readFileSync(path.join(dir,'call-000/stderr'),'utf8'),'cleanup diagnostic');
});

test('Codex completed open pages preserve all returned bodies, never request-only URLs',()=>{
  const urls=['20.12.0','22.13.0','22.16.0','22.20.0'].map(v=>`https://nodejs.org/download/release/v${v}/docs/api/fs.html`);
  const item={id:'batch',type:'web_search',action:{type:'open_page',url:urls[0]+'#fragment'},results:urls.map((url,i)=>({type:'text_result',url,ref_id:'turn0view'+i,snippet:'Total lines: 5054'}))};
  const result=measured('codex',[{type:'item.started',item},{type:'item.completed',item},
    {type:'item.completed',item:{...item,id:'request',results:[]}},
    {type:'item.completed',item:{...item,id:'failed',error:'failed'}},
    {type:'item.completed',item:{...item,id:'search',action:{type:'search'}}}]);
  assert.deepEqual(result.evidence.openedSources,urls);
});
test('Exam execution filenames accept both Node forms and reject shell chains',()=>{
  for (const file of ['public.test.mjs','repro.queue.mjs','repro-empty.mjs']) {
    assert.equal(examScript('node '+file),file);
    assert.equal(examScript('node --test '+file),file);
  }
  for (const command of ['node public.test.mjs && echo ok','node --test repro.queue.mjs; true','node ../repro.mjs','node --test other.mjs']) assert.equal(examScript(command),null);
});
test('Stage time sums Q10 calls including external review, preserving missing and shared time',t=>{
  const row={key:'x',candidate:{id:'x'},case:{id:'Q10'},phase:'main',elapsedMs:100000,
    grade:{stageMaxScores:{할일적기:1,번갈아보기:1,올림:1},stageScores:{할일적기:1,번갈아보기:1,올림:1}},calls:[
      {stage:'할일적기',elapsedMs:1000},{stage:'번갈아보기',elapsedMs:2000},{stage:'외부검토',elapsedMs:3000}]};
  assert.equal(stageTiming(row,'할일적기').elapsedMs,1000);
  assert.equal(stageTiming(row,'번갈아보기').elapsedMs,5000);
  assert.equal(stageTiming(row,'번갈아보기').externalElapsedMs,3000);
  assert.equal(stageTiming(row,'올림').elapsedMs,null);
  const shared={...row,key:'q6',case:{id:'Q6'}};
  assert.equal(stageTiming(shared,'할일적기').elapsedMs,null);
  assert.equal(stageTiming(shared,'할일적기').taskElapsedMs,100000);
  assert.equal(stageRows([row]).find(r=>r.stage==='올림').median,null);
  row.calls.push({stage:'할일적기',elapsedMs:null});
  assert.equal(stageTiming(row,'할일적기').elapsedMs,null);
  const dir=tempDir(t,'exam-stage-report-');
  const complete={...shared,candidate:{id:'x',tool:'codex'},calls:[],grade:{...shared.grade,criteria:[],gates:[],missing:[],falsePositives:[]}};
  writeReport({results:[complete],config:{},counts:{}},dir);
  const html=fs.readFileSync(path.join(dir,'comparison.html'),'utf8');
  assert.match(html,/미측정/);
  assert.match(html,/단계 분할 미측정·과제 시간 공유/);
  assert.match(fs.readFileSync(path.join(dir,'comparison.csv'),'utf8'),/stageElapsedMs/);
});
