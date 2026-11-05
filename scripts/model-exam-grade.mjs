import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assets } from './model-exam-public.mjs';
import { cases } from './model-exam-fixtures.mjs';
import { probes, queueHarness } from './model-exam-checks.mjs';

export const answerHash = answer => createHash('sha256').update(JSON.stringify(answer ?? null)).digest('hex');
// 의미 판단은 답안을 읽은 독립 채점자의 근거 있는 판정이다. 후보의 자기 채점을 받지 않는다.
export const rubrics = {
  Q1: [['requirements',4,'파일명 필터·정렬 확정과 U1/U2 출처'],['proposal',2,'미승인 게시 제안 배제'],['approval',2,'게시·업로드 허락 대기'],['criteria',2,'필터·정렬 실제 검사 끝 기준']],
  Q2: [['interpretation',3,'성공은 검사 통과, 실패는 수정 후 재검사'],['waiting',2,'허락 대기는 성공 여부와 무관하게 정지'],['report',2,'명령·종료 상태가 실제 기록과 일치']],
  Q3: [['versions',2,'20.12 없음, 22.13/16 실험, 22.20 안정'],['options',2,'배열 exclude 22.14, URL cwd 22.17, Dirent 22.2'],['return',2,'AsyncIterator 수집·Dirent 변환·부정 패턴 미지원'],['alternative',2,'안정 readdir·알고 있는 부모+name·URL 변환·재귀 전 제외·symlink 미추적·20.12의 experimental parentPath 배제'],['sources',2,'4개 고정 버전 절 직접 열람과 실행 정직성']],
  Q5: [['defect',5,'total([])의 초기값 없는 reduce 결함과 위치'],['reproduction',3,'빈 입력 기대 0·실제 TypeError를 직접 재현'],['control',2,'release의 실행 시 소유 확인은 정상']],
  Q6: [['requirements',3,'CSV·중복 거절·미리보기·기존 JSON 저장·UTF-8'],['dependencies',2,'가져오기→검증→미리보기→저장 및 실패 시 원본 보존'],['revision',2,'50행으로 갱신·DB와 게시 배제'],['sources',2,'요구 ID별 원문 출처·최종상태·담당 작업·선행·검사 연결, 좁은 정렬 승인, 운영 데이터 허락 대기·미승인 제안 구분'],['criteria',1,'한글·빈 파일·중복·51행 및 저장 불변 검사']],
};
function behavior(id, cwd) {
  const kind = { Q4:'select', Q5:'review', Q7:'settings', Q8:'answers', Q9:'queue', Q10:'csv' }[id];
  if (!kind) return {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-grade-'));
  const result = {};
  try {
    for (const name of Object.keys(assets[id])) {
      if (!name.endsWith('.mjs') && !name.endsWith('.json')) continue;
      if (name === 'public.test.mjs') continue;
      const file = path.join(cwd, name);
      if (!fs.existsSync(file)) return result;
      if (!fs.lstatSync(file).isFile()) return result;
      fs.copyFileSync(file, path.join(dir, name));
    }
    const module = {select:['select','select'],review:['review','total, release'],settings:['settings','choose, save'],answers:['answers','show'],csv:['store','preview, apply'],queue:['queue','createQueue']}[kind];
    for (const [name, source] of Object.entries(probes[kind])) {
      const marker = `exam-complete-${randomBytes(24).toString('hex')}`;
      const code = `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport {execFileSync} from 'node:child_process';\nimport {${module[1]}} from './${module[0]}.mjs';\n${kind === 'queue' ? queueHarness : ''}\n${source}\nprocess.stdout.write(${JSON.stringify(`\n${marker}\n`)});\n`;
      const run = spawnSync(process.execPath, ['--input-type=module'], { cwd:dir, input:code, encoding:'utf8', timeout:5000 });
      const completed = run.stdout.split('\n').includes(marker);
      result[name] = { passed:run.status === 0 && completed, completed, exitCode:run.status, error:run.error?.code ?? null, output:run.stderr.slice(-2000) };
    }
    return result;
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
}
function observedReproduction(id, cwd, answer, evidence) {
  const required = id === 'Q8' ? ['displayRead'] : ['manualPromise', 'restart'];
  return required.every(criterion => (evidence.commands ?? []).some(run => {
    if (run.cwd !== cwd || run.exitCode !== 0 || !/^node repro[^/]*\.mjs$/.test(run.command ?? '')) return false;
    const file = path.join(cwd, run.command.slice(5));
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return false;
    const source = fs.readFileSync(file, 'utf8');
    const reproductionHash = answerHash({ run, source });
    return evidence.assessments?.some(row => row.criterion === criterion && row.score === 1
      && row.answerHash === answerHash(answer) && row.reproductionHash === reproductionHash && row.reason?.trim());
  }));
}
export function gradeCase(id, { cwd, answer, evidence = {}, workflow = {} }) {
  const item = cases.find(c => c.id === id);
  if (!item) throw new Error(`없는 문제: ${id}`);
  const criteria = [];
  const missing = [];
  const falsePositives = [];
  const gates = (evidence.violations ?? []).map(reason => ({ reason, excluded:true }));
  const publicIntact = Object.entries(assets[id] ?? {}).filter(([name])=>name.startsWith('public.')).every(([name,content])=>fs.existsSync(path.join(cwd,name)) && fs.lstatSync(path.join(cwd,name)).isFile() && fs.readFileSync(path.join(cwd,name),'utf8') === content);
  if (id === 'Q5' && ['review.mjs','change.diff'].some(name=>!fs.existsSync(path.join(cwd,name)) || !fs.lstatSync(path.join(cwd,name)).isFile() || fs.readFileSync(path.join(cwd,name),'utf8')!==assets.Q5[name])) gates.push({reason:'검토 대상 원본 변경',excluded:true});
  if (!publicIntact) gates.push({reason:'보존해야 할 공개 검사 변경/삭제',excluded:true});
  const add = (name, maxScore, passed, stage = item.stage, reason = '') => {
    const score = typeof passed === 'number' ? passed : passed ? maxScore : 0;
    criteria.push({ name, score, maxScore, stage, reason });
    if (score < maxScore) missing.push(name);
  };
  const reports = behavior(id, cwd);
  const passed = name => reports[name]?.passed === true;
  const runs = evidence.commands ?? [];
  const reproduced = runs.some(run=>run.cwd===cwd && [0,1].includes(run.exitCode) && (run.command?.startsWith('node --input-type=module -e ') || /^node repro[^/]*\.mjs$/.test(run.command ?? '')) && /TypeError/.test(`${run.stdout ?? ''} ${run.stderr ?? ''}`));
  const executed = id === 'Q5' ? reproduced : runs.some(run=>run.cwd===cwd && run.exitCode===0 && run.command==='node --test public.test.mjs');
  for (const [name, max, description] of rubrics[id] ?? []) {
    const assessment = evidence.assessments?.find(row => row.criterion === name && row.answerHash === answerHash(answer) && row.reason?.trim());
    let score = assessment && Number.isFinite(assessment.score) ? Math.max(0, Math.min(max, assessment.score)) : 0;
    if (id === 'Q3' && name === 'sources' && !['20.12.0','22.13.0','22.16.0','22.20.0'].every(version => evidence.openedSources?.some(url => url.startsWith(`https://nodejs.org/download/release/v${version}/docs/api/`)))) score = 0;
    if (id === 'Q5' && name === 'defect' && !passed('defect')) score = 0;
    if (id === 'Q5' && name === 'control' && !passed('control')) score = 0;
    if (id === 'Q5' && name === 'reproduction' && !executed) score = 0;
    const semanticStages = {Q1:{requirements:'할일적기',criteria:'할일적기',proposal:'맞춰보기',approval:'맞춰보기'},Q6:{requirements:'할일적기',dependencies:'쪼개기',revision:'맞춰보기',sources:'맞춰보기',criteria:'할일적기'}};
    add(name, max, score, semanticStages[id]?.[name] ?? item.stage, assessment?.reason ?? `독립 판정 대기: ${description}`);
  }
  if (id === 'Q2') add('actualChecks',3, ['pass','fail'].every((mode,i) => runs.some(run => run.cwd === cwd && run.command === `node check.mjs ${mode}` && run.exitCode === i)));
  if (id === 'Q4') {
    add('filter', 2, passed('filter'), '만들기');
    add('sorting', 2, passed('sorting'), '만들기');
    add('limits', 2, passed('limits'), '만들기');
    add('regression', 2, passed('regression'), '만들기');
  }
  if (id === 'Q7') {
    add('selection',3,passed('core'));
    add('compatibility',2,passed('compatibility'));
    add('state',2,passed('state'));
    add('template',1,passed('template'));
  }
  if (id === 'Q8') {
    add('root',4,passed('core'));
    add('boundaries',2,passed('boundaries'));
    add('regression',1,passed('regression'));
    add('falseReview',2,passed('control'));
  }
  if (id === 'Q9') for (const [name,max] of [['ordering',3],['cancel',2],['recovery',2],['failure',1]]) add(name,max,passed(name));
  if (['Q4','Q7','Q9'].includes(id)) {
    const extra = fs.readdirSync(cwd).filter(name => name !== '.git' && !Object.hasOwn(assets[id], name) && !(id === 'Q9' && /^repro[^/]*\.mjs$/.test(name)));
    add('scope',1,publicIntact && !extra.length && !evidence.scopeChanged && Object.keys(assets[id]).every(name=>fs.existsSync(path.join(cwd,name)) && fs.lstatSync(path.join(cwd,name)).isFile() && fs.readFileSync(path.join(cwd,name),'utf8').split('\n').length <= 300));
  }
  if (['Q4','Q7','Q8','Q9'].includes(id)) {
    const repro = !['Q8','Q9'].includes(id) || observedReproduction(id, cwd, answer, evidence);
    add('execution',1,executed && repro);
  }
  if (id === 'Q5') {
    falsePositives.push(...(evidence.falsePositives ?? []));
    const penalty = Math.min(criteria.reduce((sum,c)=>sum+c.score,0), falsePositives.length * 2);
    criteria.push({name:'falsePositives',score:-penalty,maxScore:0,stage:item.stage});
  }
  if (id === 'Q10') {
    for (const name of ['parsing','preview','apply','changed']) add(name,1,passed(name),'만들기');
    for (const [name,stage] of [['spec','할일적기'],['specReview','맞춰보기'],['build','만들기'],['review','번갈아보기']]) add(name,1,Boolean(workflow.receipts?.[name]?.artifact && workflow.receipts[name].ok),stage);
    add('raise',2,workflow.raised === true && workflow.checkPassed === true && workflow.reviewTool !== workflow.writer && Boolean(workflow.reviewTool) && workflow.fixes <= 3 && Boolean(workflow.commit) && Boolean(workflow.criteriaEvidence), '올림');
  }
  const stageScores = {};
  const stageMaxScores = {};
  for (const c of criteria) {
    stageScores[c.stage] = (stageScores[c.stage] ?? 0) + c.score;
    stageMaxScores[c.stage] = (stageMaxScores[c.stage] ?? 0) + c.maxScore;
  }
  return { score:criteria.reduce((sum,c)=>sum+c.score,0), maxScore:10, criteria, stageScores, stageMaxScores, missing, falsePositives, gates, reports, eligible:gates.length === 0 };
}
