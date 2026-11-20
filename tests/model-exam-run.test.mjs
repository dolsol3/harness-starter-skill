import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareCase} from '../scripts/model-exam-fixtures.mjs';
import {processRun,runCase} from '../scripts/model-exam-run.mjs';
import {writeReport} from '../scripts/model-exam-report.mjs';
import {tempDir,stopAtEnd} from './helpers.mjs';

const alive=pid=>{
  try { process.kill(pid,0); return true; }
  catch(error){ if(error.code==='ESRCH') return false; throw error; }
};
// 공용 호출기는 모델 CLI를 detached로 띄운다. Q10 전체 시간 초과는 그 자식까지 꺼야 다음 회차와 겹치지 않는다.
test('Q10 전체 시간 초과는 물레방아가 따로 띄운 detached 자식 그룹까지 끈다',{skip:process.platform==='win32'},async t=>{
  const dir=tempDir(t,'exam-run-timeout-');
  const pidFile=path.join(dir,'child.pid');
  fs.writeFileSync(path.join(dir,'flow.mjs'),`import {spawn} from 'node:child_process';
import fs from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
setInterval(()=>{},1000);
`);
  const run=await processRun(dir,['flow.mjs'],process.env,1500);
  assert.equal(run.timedOut,true);
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  stopAtEnd(t,pid);
  for(let i=0;i<50&&alive(pid);i++) await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(alive(pid),false);
});
test('미지원 실패의 분류와 진단이 HTML에 남는다',t=>{
  const dir=tempDir(t,'exam-run-report-');
  const row={key:'x',candidate:{id:'x',tool:'codex',model:'m',effort:'medium'},case:{id:'Q6',stage:'할일적기',difficulty:'중간'},phase:'main',round:1,
    elapsedMs:1000,calls:[],status:'실패',ok:false,reason:'실패',failureType:'미지원',detail:'unknown model gpt-x'};
  writeReport({results:[row],config:{},counts:{}},dir);
  const html=fs.readFileSync(path.join(dir,'comparison.html'),'utf8');
  assert.match(html,/미지원/);
  assert.match(html,/unknown model gpt-x/);
});
test('입력 예산은 promptSuffix를 붙인 실제 전달 길이로 잰다',async t=>{
  const probe=tempDir(t,'exam-run-probe-');
  const prepared=prepareCase('Q1',probe);
  const root=tempDir(t,'exam-run-budget-');
  const env={...process.env,HARNESS_CODEX_BIN:path.join(root,'없는-codex')};
  const job={key:'k',case:{id:'Q1',stage:'만들기',difficulty:'쉬움'},candidate:{id:'c',tool:'codex',model:'m',effort:'medium'},timeoutMs:5000};
  const config={maxInputChars:prepared.prompt.length+JSON.stringify(prepared.schema).length,promptSuffix:'x'.repeat(100)};
  await assert.rejects(runCase(job,path.join(root,'cwd'),path.join(root,'out'),env,config),/입력 예산 초과/);
});
