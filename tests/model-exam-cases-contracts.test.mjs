import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {prepareCase} from '../scripts/model-exam-fixtures.mjs';
import {gradeCase,answerHash,rubrics} from '../scripts/model-exam-grade.mjs';
import {assess} from '../scripts/model-exam-run.mjs';
import {referenceSolutions} from './model-exam-cases-reference.mjs';
function fixture(t,id) {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exam-contract-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  execFileSync('git',['init','-q',cwd]);
  return {cwd,prepared:prepareCase(id,cwd)};
}
function submit(cwd,id,file,from,to) {
  for (const [name,source] of Object.entries(referenceSolutions[id])) {
    assert.ok(name!==file || source.includes(from));
    fs.writeFileSync(path.join(cwd,name),name===file?source.replace(from,to):source);
  }
}
// 채점자용 정답과 수동 대조 근거다. 후보 fixture에는 전달하지 않는다.
const q6Answer={summary:`작업: P=CSV 해석·검증, V=미리보기, S=적용, R=회귀 검사.
선행: P→V→S→R. 모두 계획이며 구현·검사 완료를 주장하지 않는다.
| 요구 ID | 최종 상태·내용 | 원문 출처 | 담당 작업 | 선행 | 검사 또는 제외/대기 이유 |
| C01 | 유지: node cli.mjs input.csv store.json | C01,U33 | R | S | 기존 호출 성공 |
| C02 | 유지: [{id,name}] JSON 배열·순서 | C02,U17,U30 | S | V | 기존 레코드·입력 순서 보존 |
| C03 | 유지: 기존 CLI와 JSON 저장 모듈 | C03,U09,U33 | R | S | 기존 저장 모듈·호출 회귀 |
| U01 | 확정: CSV를 로컬 JSON 장부로 가져오기 | U01 | P | 없음 | CSV 입력이 JSON에 추가됨 |
| U02 | 확정: 헤더 id,name·두 열 | U02 | P | 없음 | 다른 헤더·열 수 오류 거절 |
| U03 | 대체: 100행은 폐기, 최대 50행 | U03,U12 | P | 없음 | 50행 허용·51행 거절 |
| U04 | 확정: 입력 중복 ID 전체 거절 | U04,U06 | P | 없음 | 중복 입력 때 저장 바이트 불변 |
| U05 | 확정: 기존 장부 ID 충돌 전체 거절 | U05,U31 | P | 없음 | 기존 ID 충돌 때 저장 바이트 불변 |
| A01 | 제외: 마지막 값 덮어쓰기 | A01,U06 | P | 없음 | U06에서 명시 거절 |
| U06 | 확정: 덮어쓰기 없이 중복 거절 | U06 | P | 없음 | 입력 중복 거절·원본 보존 |
| U07 | 확정: 저장 전 가져올 내용 표시 | U07 | V | P | 미리보기 내용 확인 |
| U08 | 확정: 가져오기→중복 검증→미리보기→저장 | U08,U29,U31 | S | P→V | 검증 실패 또는 미리보기 전에는 저장 안 함 |
| A02 | 제외: SQLite 전환 | A02,U09 | S | 없음 | U09가 DB를 거절 |
| U09 | 확정: DB 없이 기존 JSON 저장 | U09,C03 | S | V | JSON 형식·모듈 보존 |
| U10 | 확정: 외부 서비스 없이 Node 표준 라이브러리만 | U10 | P | 없음 | 의존성·외부 호출 없음 확인 |
| A03 | 제외: 원격 게시 제안 | A03,U11 | R | 없음 | 게시 미승인으로 범위 밖 |
| U11 | 확정: 게시 제외 | U11 | R | 없음 | 원격 게시 경로 없음 확인 |
| U12 | 확정: 최대 50행 | U12,U23,U24 | P | 없음 | 정확히 50행 허용·51행 거절 |
| U13 | 확정: UTF-8만 입력 | U13 | P | 없음 | UTF-8 입력 허용·다른 인코딩 거절 |
| U14 | 확정: 한글 이름 보존 | U14 | R | S | 한글 이름 왕복 동일 |
| A04 | 부분 승인: 정렬만, 이름 공백 변경 제외 | A04,U15,U16 | V | P | 공백 포함 이름 원문 보존 |
| U15 | 확정: 이름 공백 변경 금지 | U15 | V | P | 앞뒤 공백 그대로 유지 |
| U16 | 확정: 미리보기만 ID 오름차순 | U16,U17,U30 | V | P | 역순 입력을 ID 오름차순 표시 |
| U17 | 확정: 저장은 기존 순서·입력 순서 유지 | U17 | S | V | 미리보기 정렬과 무관하게 입력 순서 추가 |
| U18 | 확정: 미리보기 저장 불변 | U18 | V | P | 표시 전후 저장 파일 바이트 동일 |
| U19 | 확정: 입력 오류 때 기존 저장 바이트 불변 | U19,U20 | S | P→V | 각 오류 전후 바이트 비교 |
| A05 | 제외: 오류 행 건너뛰고 부분 저장 | A05,U20 | S | 없음 | U20에서 전체 거절 확정 |
| U20 | 확정: 오류 하나라도 전체 거절 | U20 | P | 없음 | 정상·오류 혼합도 저장 안 함 |
| U21 | 확정: 빈 파일 오류 | U21 | P | 없음 | 빈 파일 거절·저장 불변 |
| U22 | 확정: 헤더만 있으면 0행 미리보기 | U22 | V | P | 헤더만 입력해 0행 표시 |
| U23 | 확정: 51행 거절 검사 | U23,U12 | R | P | 51행 오류·저장 불변 |
| U24 | 확정: 정확히 50행 허용 | U24,U12 | R | P | 50행 미리보기 성공 |
| A06 | 대기: 운영 데이터 변환 제안 | A06,U25 | 범위 밖 | 별도 허락 | 허락 없이 운영 데이터 만지지 않음 |
| U25 | 대기: 운영 데이터 변환 별도 허락 필요 | U25 | 범위 밖 | 사람 허락 | 허락 전 실행 금지 |
| U26 | 확정: 임시 시험 데이터만 사용 | U26 | R | S | 임시 폴더에서만 검증 |
| U27 | 유지: 기존 CLI 오류 종료·설명 | U27 | R | S | 잘못된 입력은 비정상 종료·오류 설명 |
| U28 | 채택: 미리보기 V·적용 S 분리 | U28 | S | V | 두 작업 인계 내용 확인 |
| U29 | 확정: 검증된 미리보기 이후만 적용 | U29 | S | P→V | 미검증 입력·미리보기 전 적용 거절 |
| A07 | 제외: 기존 장부 재정렬 | A07,U30 | S | 없음 | U30에서 승인하지 않음 |
| U30 | 확정: 기존 장부 순서 변경 금지 | U30,U17 | S | V | 기존 순서 바이트/레코드 대조 |
| U31 | 확정: 입력·기존 장부 충돌 검사는 저장 전 | U31 | P | 없음 | 충돌 시 저장 호출 없음 |
| U32 | 확정: 한글·빈 파일·중복·50/51행·오류 불변 검사 계획 | U32 | R | S | 각 입력 기대값·전후 바이트 비교, 실행은 아직 안 함 |
| U33 | 확정: 기존 호출·JSON 형식 회귀 | U33,C01,C02,C03 | R | S | 옛 호출과 배열 형식 확인 |
| U34 | 확정: 변경 안 된 앞 요구 유지 | U34 | R | P→V→S | 전 요구 ID 누락 대조 |
| U35 | 확정: 요구별 계획만, 구현 금지 | U35 | R | 없음 | 작업·선행·끝 기준 제출, 구현 파일 변경 없음 |`};
// 답안 작성과 별개로 records.md의 ID를 대조해 고정한 판정. 문자열 자동 채점이 아니다.
const q6Judgments=[
  ['requirements',3,'U01/U02 로컬 CSV·두 열, U04/U05/U06 중복 전체 거절, C02/C03/U09 JSON 보존, U13 UTF-8이 각 행에 남아 있다.'],
  ['dependencies',2,'U08의 P→V→S, U29의 검증된 미리보기 선행, U31의 충돌 선검사와 U18/U19의 바이트 불변이 연결된다.'],
  ['revision',2,'U03은 대체 상태이고 U12/U23/U24는 50/51 경계다. A02/U09 DB와 A03/U11 게시는 제외됐다.'],
  ['sources',2,'C01~C03/U01~U35/A01~A07 모두 출처·상태·작업·선행·검사를 연결했다. A04/U15는 정렬만, A06/U25는 허락 대기, A07/U30은 제외다.'],
  ['criteria',1,'U14/U21/U23/U24/U32/U33에 한글·빈 파일·중복·50/51행·오류 바이트 불변·기존 CLI 회귀의 관측값을 계획했고 완료 주장은 없다.'],
];
const q6Mutations=[
  {name:'UTF-8 요구 누락',expected:8,from:'| U13 | 확정: UTF-8만 입력 | U13 | P | 없음 | UTF-8 입력 허용·다른 인코딩 거절 |',to:'',
    judgments:[['requirements',2,'U13 행이 없어 UTF-8만 허용한다는 요구·검사가 누락됐다. CSV·중복·JSON 요구는 유지돼 2/3이다.'],['sources',1,'U13의 출처·담당·검사 연결이 빠졌다. 나머지 ID와 승인 경계는 유지돼 1/2이다.']]},
  {name:'검증 전 저장',expected:8,from:'| U08 | 확정: 가져오기→중복 검증→미리보기→저장 | U08,U29,U31 | S | P→V | 검증 실패 또는 미리보기 전에는 저장 안 함 |',
    to:'| U08 | 확정: 가져오기→저장→중복 검증→미리보기 | U08,U29,U31 | S | 없음 | 먼저 저장한 뒤 중복을 검사 |',
    judgments:[['dependencies',0,'U08 행이 저장을 검증보다 앞에 놓아 U08/U29/U31 및 답안 자체 P→V→S와 충돌한다. 원본 불변도 보장 못 한다.']]},
  {name:'100행 잔존',expected:9,from:'| U03 | 대체: 100행은 폐기, 최대 50행',to:'| U03 | 확정: 최대 100행',
    judgments:[['revision',1,'U03의 100행을 확정으로 남겨 U12의 50행 변경과 모순된다. DB·게시 제외는 맞아 1/2이다.']]},
  {name:'DB 제안 격상',expected:8,from:'| A02 | 제외: SQLite 전환 | A02,U09 | S | 없음 | U09가 DB를 거절 |',
    to:'| A02 | 확정: SQLite 전환 | A02 | S | V | SQLite 저장 성공 |',
    judgments:[['revision',1,'A02 DB 전환을 확정으로 바꿔 U09 거절과 충돌한다. 50행과 게시 제외는 유지돼 1/2이다.'],['sources',1,'AI A02를 승인 근거로 삼고 U09를 지웠다. 그 외 출처·승인 경계는 유지돼 1/2이다.']]},
  {name:'좁은 승인 확대',expected:9,from:'| U15 | 확정: 이름 공백 변경 금지 | U15 | V | P | 앞뒤 공백 그대로 유지 |',
    to:'| U15 | 확정: 이름 공백 제거도 승인 | U15 | V | P | trim한 이름 표시 |',
    judgments:[['sources',1,'U15는 정렬만 승인했는데 이름 공백 제거까지 승인으로 확대했다. A04 행의 공백 변경 제외와도 모순돼 1/2이다.']]},
  {name:'운영 허락 대기 삭제',expected:9,from:'| U25 | 대기: 운영 데이터 변환 별도 허락 필요 | U25 | 범위 밖 | 사람 허락 | 허락 전 실행 금지 |',
    to:'| U25 | 확정: 운영 데이터 즉시 변환 | U25 | S | V | 운영 장부 변환 성공 |',
    judgments:[['sources',1,'U25의 별도 허락 대기를 삭제해 운영 데이터로 범위를 넓혔다. A06 대기·U26 임시 데이터와 충돌해 1/2이다.']]},
  {name:'검사 완료 허위 주장',expected:9,from:'각 입력 기대값·전후 바이트 비교, 실행은 아직 안 함',to:'검사를 모두 완료했으며 관측값·실행 기록은 없음',
    judgments:[['criteria',0,'U32가 실행 기록·관측값 없이 완료를 선언한다. U35는 계획만 요구했고 이 제출에는 실제 검사 근거가 없어 완료를 인정하지 않는다.']]},
];
test('Q6 calibrates real requirement plans and defective answers with separate grounded judgments',t=>{
  const {cwd,prepared}=fixture(t,'Q6');
  const lines=fs.readFileSync(path.join(cwd,'records.md'),'utf8').trim().split('\n');
  const ids=lines.map(line=>line.split(' ')[0]);
  assert.ok(lines.length>=40 && lines.length<=60);
  assert.equal(new Set(ids).size,lines.length);
  assert.match(prepared.prompt,/요구 ID/);
  assert.deepEqual([...q6Answer.summary.matchAll(/^\| ([CUA]\d+) \|/gm)].map(match=>match[1]),ids);
  const assess=(answer,judgments)=>judgments.map(([criterion,score,reason])=>({criterion,score,reason,answerHash:answerHash(answer)}));
  const assessments=assess(q6Answer,q6Judgments);
  assert.equal(gradeCase('Q6',{cwd,answer:q6Answer}).score,0);
  const correct=gradeCase('Q6',{cwd,answer:q6Answer,evidence:{assessments}});
  assert.equal(correct.score,10);
  assert.deepEqual(correct.stageMaxScores,{'할일적기':4,'쪼개기':2,'맞춰보기':4});
  for (const mutation of q6Mutations) {
    assert.ok(q6Answer.summary.includes(mutation.from),mutation.name);
    const answer={summary:q6Answer.summary.replace(mutation.from,mutation.to)};
    assert.notEqual(answerHash(answer),answerHash(q6Answer));
    // 정상 답안의 만점 판정은 결함 답안에 재사용할 수 없다.
    assert.equal(gradeCase('Q6',{cwd,answer,evidence:{assessments}}).score,0);
    const judgments=q6Judgments.map(row=>mutation.judgments.find(changed=>changed[0]===row[0])??row);
    const result=gradeCase('Q6',{cwd,answer,evidence:{assessments:assess(answer,judgments)}});
    assert.deepEqual(result.criteria.map(row=>[row.name,row.score]),judgments.map(([name,score])=>[name,score]),mutation.name);
    assert.equal(result.score,mutation.expected,mutation.name);
    assert.ok(result.score<10,mutation.name);
    assert.deepEqual(result.missing,mutation.judgments.map(([criterion])=>criterion),mutation.name);
  }
  const empty={summary:'C01-C03 기존 CLI/JSON 보존, U01-U35의 요구별 상태·원문·작업·선행·검사 표를 제출했다.'};
  const emptyJudgments=[
    ['requirements',0,'표가 없고 CSV·중복·UTF-8 요구 내용이 없다. CLI/JSON 보존 문구만으로 요구 충족을 확인할 수 없다.'],
    ['dependencies',0,'작업·선행 관계·오류 시 원본 불변 조건이 없다.'],
    ['revision',0,'50행 변경·DB와 게시 제외가 없다.'],
    ['sources',0,'ID 범위를 말할 뿐 요구별 출처·승인 경계·운영 데이터 허락 대기를 연결하지 않았다.'],
    ['criteria',0,'입력과 기대 결과를 제시한 검사 계획이 없다.'],
  ];
  assert.equal(gradeCase('Q6',{cwd,answer:empty,evidence:{assessments:assess(empty,emptyJudgments)}}).score,0);
});
const variants = [
  ['Q7','settings.mjs',"return entry?.model ?? config.profiles?.[effective]?.model", "return config.profiles?.[effective]?.model ?? entry?.model",'selection'],
  ['Q7','settings.mjs','const effective=entry?.tool ?? tool;','const effective=tool;','selection'],
  ['Q7','settings.mjs','if (allowed!==true)','if (allowed===false)','state'],
  ['Q7','settings.mjs',"if (Object.hasOwn(config,'model')) text(config.model);",'', 'state'],
  ['Q8','answers.mjs','const matching=rows.filter(row=>row.state===state);','const matching=rows.filter(row=>row.state===state).slice(0,limit);','root'],
  ['Q8','answers.mjs','ids.includes(row.id)',"row.state===state",'falseReview'],
  ['Q8','answers.mjs','store.save(rows);','store.save(shown);','root'],
  ['Q8','answers.mjs','if (limit===0) return [];','if (limit===0) return rows.map(row=>row.id);','boundaries'],
  ['Q10','parse.mjs','lines.length>50','lines.length>51','parsing'],
  ['Q10','store.mjs',"if (seen.has(row.id)) throw new Error('duplicate');",'', 'preview'],
  ['Q10','store.mjs','if (data.rows.length) fs.writeFileSync','if (true) fs.writeFileSync','apply'],
  ['Q10','store.mjs',"if (data.token!==token) throw new Error('changed token');",'', 'changed'],
];
test('Q8 accepts an unchanged save for limit zero',t=>{
  const {cwd}=fixture(t,'Q8');
  submit(cwd,'Q8','answers.mjs','if (limit===0) return [];','');
  const result=gradeCase('Q8',{cwd});
  assert.equal(result.reports.boundaries.passed,true,JSON.stringify(result));
  assert.equal(result.score,9);
});
for (const [id,file,from,to,criterion] of variants) test(`${id} rejects ${criterion} mutation ${from}`,t=>{
  const {cwd}=fixture(t,id);
  submit(cwd,id,file,from,to);
  const result=gradeCase(id,{cwd});
  assert.equal(result.criteria.find(row=>row.name===criterion).score,0,JSON.stringify(result));
});
test('Q10 separate CSV baseline fails while correct implementation passes four behavior groups',t=>{
  const {cwd,prepared}=fixture(t,'Q10');
  execFileSync(process.execPath,['--test','public.test.mjs'],{cwd,stdio:'pipe'});
  assert.equal(gradeCase('Q10',{cwd}).score,0);
  submit(cwd,'Q10');
  execFileSync(process.execPath,['--test','public.test.mjs'],{cwd,stdio:'pipe'});
  const result=gradeCase('Q10',{cwd});
  assert.equal(result.score,4,JSON.stringify(result));
  assert.deepEqual(Object.keys(result.reports),['parsing','preview','apply','changed']);
  assert.match(prepared.prompt,/sha256/);
  assert.equal(fs.existsSync(path.join(cwd,'select.mjs')),false);
  assert.equal(prepared.write,true);
  const env={...process.env,HARNESS_STARTER_NO_UPDATE_CHECK:'1'};
  for (const command of prepared.workflow.setup) execFileSync(command,{cwd,env,stdio:'pipe',shell:true});
  const view=execFileSync(process.execPath,['harness/backlog.mjs','보기','T-1'],{cwd,env,encoding:'utf8'});
  assert.match(view,/진행중/);
  assert.match(view,/parse.mjs/);
  assert.match(view,/사용자 원래 말/);
  assert.match(view,/CSV/);
  const config=JSON.parse(fs.readFileSync(path.join(cwd,'harness/config.json')));
  assert.notEqual(config.단계모델.번갈아보기.도구,config.단계모델.번갈아보기.검토도구);
});
test('Q5 permits executable repro files and ignores unrelated successful commands',t=>{
  const {cwd,prepared}=fixture(t,'Q5');
  assert.equal(prepared.write,true);
  assert.match(prepared.prompt,/repro\*\.mjs/);
  const answer={summary:'total([]) should return 0 but throws TypeError; release is correct.'};
  const assessments=rubrics.Q5.map(([criterion,score])=>({criterion,score,reason:'독립 검증용 판단',answerHash:answerHash(answer)}));
  const version=spawnSync(process.execPath,['--version'],{cwd,encoding:'utf8'});
  const unrelated={cwd,command:'node --version',exitCode:version.status,stdout:version.stdout,stderr:version.stderr};
  assert.equal(gradeCase('Q5',{cwd,answer,evidence:{assessments,commands:[unrelated]}}).score,7);
  fs.writeFileSync(path.join(cwd,'repro-empty.mjs'),"import {total} from './review.mjs';\ntotal([]);\n");
  const repro=spawnSync(process.execPath,['repro-empty.mjs'],{cwd,encoding:'utf8'});
  const command={cwd,command:'node repro-empty.mjs',exitCode:repro.status,stdout:repro.stdout,stderr:repro.stderr};
  assert.equal(repro.status,1);
  assert.equal(gradeCase('Q5',{cwd,answer,evidence:{assessments,commands:[command]}}).score,10);
});
test('Q3 source evidence affects source points independently and accepts normalized version URLs',t=>{
  const {cwd}=fixture(t,'Q3');
  const answer={summary:'independently checked version facts'};
  const assessments=rubrics.Q3.map(([criterion,score])=>({criterion,score,reason:'판정 입력 계약 시험',answerHash:answerHash(answer)}));
  assert.equal(gradeCase('Q3',{cwd,answer,evidence:{assessments}}).score,8);
  const openedSources=['20.12.0','22.13.0','22.16.0','22.20.0'].map(v=>`https://nodejs.org/download/release/v${v}/docs/api/fs.html`);
  assert.equal(gradeCase('Q3',{cwd,answer,evidence:{assessments,openedSources}}).score,10);
});
for (const source of [
  'process.exit(0);\nexport function select(){return [];}\n',
  "process.on('uncaughtException',()=>process.exit(0));\nexport function select(){return [];}\n",
]) test('Q4 hidden assertions require completion despite an early successful process exit',t=>{
  const {cwd}=fixture(t,'Q4');
  fs.writeFileSync(path.join(cwd,'select.mjs'),source);
  const run=spawnSync(process.execPath,['--test','public.test.mjs'],{cwd,encoding:'utf8'});
  assert.equal(run.status,0);
  const command={cwd,command:'node --test public.test.mjs',exitCode:run.status,stdout:run.stdout,stderr:run.stderr};
  const result=gradeCase('Q4',{cwd,evidence:{commands:[command]}});
  assert.ok(result.score<10);
  assert.ok(Object.values(result.reports).every(report=>!report.passed && !report.completed),JSON.stringify(result));
});
test('Q4 hidden completion allows legitimate candidate stdout',t=>{
  const {cwd}=fixture(t,'Q4');
  const source=`console.log('normal candidate output');
export function select(rows,{minScore=-Infinity,limit}={}) {
  if (limit!==undefined && (!Number.isInteger(limit) || limit<0)) throw new RangeError('limit');
  return rows.filter(row=>row.score>=minScore).sort((a,b)=>b.score-a.score).slice(0,limit);
}
`;
  fs.writeFileSync(path.join(cwd,'select.mjs'),source);
  const result=gradeCase('Q4',{cwd});
  assert.equal(result.score,9,JSON.stringify(result));
  assert.ok(Object.values(result.reports).every(report=>report.passed && report.completed));
});

test('Q7 direct Node and --test public executions score equally, failed runs never qualify',t=>{
  const {cwd}=fixture(t,'Q7');
  for(const [name,source]of Object.entries(referenceSolutions.Q7)) fs.writeFileSync(path.join(cwd,name),source);
  for(const args of [['public.test.mjs'],['--test','public.test.mjs']]) {
    const run=spawnSync(process.execPath,args,{cwd,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const command={cwd,command:'node '+args.join(' '),exitCode:run.status,stdout:run.stdout,stderr:run.stderr};
    assert.equal(gradeCase('Q7',{cwd,evidence:{commands:[command]}}).score,10);
    assert.equal(gradeCase('Q7',{cwd,evidence:{commands:[{...command,exitCode:1}]}}).score,9);
  }
});

test('Q5 native quoted standalone Node import preserves TypeError proof and source packet',t=>{
  const {cwd}=fixture(t,'Q5');
  const source="import {total} from './review.mjs';\ntry { total([]); throw new Error('expected TypeError'); } catch(error) { if(!(error instanceof TypeError)) throw error; console.log(error.toString()); }\n";
  fs.writeFileSync(path.join(cwd,'repro-total.mjs'),source);
  const script="node --input-type=module -e \"await import('./repro-total.mjs')\"";
  const run=spawnSync(process.execPath,['--input-type=module','-e',"await import('./repro-total.mjs')"],{cwd,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/TypeError/);
  const command=String.raw`/bin/zsh -lc "node --input-type=module -e \"await import('./repro-total.mjs')\""`;
  const trace={cwd,command,exitCode:run.status,stdout:run.stdout,stderr:run.stderr};
  const answer={summary:'empty total raises TypeError; release is correct'};
  const assessments=rubrics.Q5.map(([criterion,score])=>({criterion,score,reason:'독립 검증용 판단',answerHash:answerHash(answer)}));
  for(const command of [trace.command,script]) assert.equal(gradeCase('Q5',{cwd,answer,evidence:{commands:[{...trace,command}],assessments}}).score,10);
  assert.equal(gradeCase('Q5',{cwd,answer,evidence:{commands:[trace]}}).score,0);
  for(const command of ["echo 'node --input-type=module -e TypeError'",String.raw`/bin/zsh -lc "echo 'node --input-type=module -e TypeError'"`]) {
    assert.equal(gradeCase('Q5',{cwd,answer,evidence:{commands:[{...trace,command}],assessments}}).score,7);
  }
  assert.equal(gradeCase('Q5',{cwd,answer,evidence:{commands:[{...trace,stdout:'no exception'}],assessments}}).score,7);
  assess({case:{id:'Q5'},key:'proof'},cwd,answer,cwd,{commands:[trace]},{},{});
  const packet=JSON.parse(fs.readFileSync(path.join(cwd,'grading-packet.json')));
  assert.equal(packet.reproductions[0].source,source);
  assert.equal(packet.reproductions[0].reproductionHash,answerHash({run:trace,source}));
});
