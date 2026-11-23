import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assets, requests } from './model-exam-public.mjs';

// 단계별 칸: 쉬움 Q1·Q2는 성적 밖(난이도 null)이고, 새 문제 Q11~Q23은 칸 표 순서로 잇는다(기존 ID 유지는 보고서·재채점 호환).
const definitions = [
  ['승인 범위 정리', null, '할일적기', '계획', 300],
  ['검사와 허락 대기', null, '돌려보기', '재현검토', 300],
  ['버전 고정 공식 조사', '중간', '조사', '조사', 900],
  ['레코드 선택기', '중간', '만들기', '구현', 900],
  ['실제 결함과 정상 대조군', '중간', '번갈아보기', '재현검토', 900],
  ['변경 요청과 의존 분해', '고난도', '쪼개기', '계획', 900],
  ['설정 선택과 저장 CLI', '고난도', '만들기', '구현', 1800],
  ['새 답 조회와 읽음 일치', '고난도', '고치기', '구현', 1200],
  ['작업 취소와 재시작', '초고난도', '만들기', '구현', 1800],
  ['공용 물레방아 연결', '초고난도', '전체연결', '전체물레방아', 3600],
  ['검색 요청 정리', '중간', '할일적기', '계획', 600],
  ['공유 요청의 허락·확인 분류', '고난도', '할일적기', '계획', 900],
  ['작업 문서와 원래 말 대조', '중간', '맞춰보기', '계획', 600],
  ['작업 문서·결과 보고 대조', '고난도', '맞춰보기', '계획', 900],
  ['휴지통 작업 나누기', '중간', '쪼개기', '계획', 600],
  ['검사 실행과 실패 보고', '중간', '돌려보기', '재현검토', 600],
  ['실패를 삼키는 검사기', '고난도', '돌려보기', '재현검토', 900],
  ['버전별 재시도 설정 조사', '고난도', '조사', '조사', 900],
  ['보안 공지와 백포트 판정', '초고난도', '조사', '조사', 1800],
  ['제한기 변경 검토', '고난도', '번갈아보기', '재현검토', 900],
  ['두 변경이 만난 캐시 결함', '초고난도', '번갈아보기', '재현검토', 1800],
  ['메모이즈 키 충돌 고치기', '중간', '고치기', '구현', 900],
  ['동시 갱신 유실 고치기', '초고난도', '고치기', '구현', 1800],
];
export const levels = ['중간', '고난도', '초고난도'];
export const cases = definitions.map(([title, difficulty, stage, mode, timeoutSeconds], i) => ({ id: `Q${i + 1}`, title, difficulty, stage, mode, timeoutSeconds }));
export const workflowChecks = ['node --test public.test.mjs', 'node public.repro-check.mjs', 'node harness/check.mjs 바뀐 파일들'];
export const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
export function prepareCase(id, cwd, options = {}) {
  const item = cases.find(c => c.id === id);
  if (!item) throw new Error(`없는 문제: ${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (fs.readdirSync(cwd).some(name => name !== '.git')) throw new Error('빈 후보 폴더가 필요하다');
  if (fs.existsSync(path.join(cwd, '.git'))) {
    const history = execFileSync('git', ['-C', cwd, 'rev-list', '--all'], { encoding:'utf8' });
    const remotes = execFileSync('git', ['-C', cwd, 'remote'], { encoding:'utf8' });
    if (history.trim() || remotes.trim()) throw new Error('후보 저장소에는 이력과 원격이 없어야 한다');
  }
  for (const [name, content] of Object.entries(assets[id] ?? {})) fs.writeFileSync(path.join(cwd, name), content);
  const checks = id === 'Q10' ? workflowChecks : assets[id]?.['public.test.mjs'] ? ['node --test public.test.mjs'] : [];
  let workflow;
  if (id === 'Q10') workflow = installWorkflow(cwd, options);
  const repro = ['Q5','Q8','Q9','Q10','Q20','Q21','Q22','Q23'].includes(id) ? ' repro*.mjs 생성·실행도 허용한다.' : '';
  const scope = {Q4:'select.mjs',Q5:'repro*.mjs만 (review.mjs·change.diff 보존)',Q7:'settings.mjs·cli.mjs·defaults.json',Q8:'answers.mjs·cli.mjs·repro*.mjs',Q9:'queue.mjs·repro*.mjs',Q10:'parse.mjs·store.mjs·cli.mjs·repro*.mjs',Q20:'repro*.mjs만 (limits.mjs·before.mjs 보존)',Q21:'repro*.mjs만 (cache.mjs·log.md 보존)',Q22:'memo.mjs·prices.mjs·repro*.mjs',Q23:'ledger.mjs·repro*.mjs'}[id] ?? '없음';
  const prompt = `${requests[id]}\n최종 응답은 정확히 {"summary":"근거와 판단"} 모양의 JSON 객체 하나만 출력한다. Markdown·코드펜스·다른 JSON을 최종 응답에 섞지 않는다. 확인 명령은 각각 단독으로 실행한다(추가 echo·연결 연산자·환경변수 prefix 없이). .agents는 실행 역할 메타데이터이며 문제 풀이 자료가 아니다. 구현은 실제 파일로 제출한다. 수정 허용 파일은 ${scope}이다. 나머지 공개 소스·요구·시험은 보존한다. 장부 데이터 파일은 실제 CLI 실행에 따른 저장만 허용한다.${repro} 공개 시험은 보존한다. 검사·권한 해제, 채점 자산 열람, 후보 폴더 밖 쓰기는 금지다.`;
  return { prompt, schema, write: ['구현','전체물레방아'].includes(item.mode) || ['Q5','Q20','Q21'].includes(id), checks, ...(workflow && { workflow }) };
}
function installWorkflow(cwd, options) {
  const writer = options.writer ?? { tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
  const reviewer = options.reviewer ?? { tool: 'gemini', model: 'gemini-4-argon-medium', effort: 'medium' };
  if (writer.tool === reviewer.tool) throw new Error('독립 검토 도구는 작성 도구와 달라야 한다');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-install-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    execFileSync('git', ['init', '-q', cwd], { env, stdio: 'pipe' });
    execFileSync('git', ['-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { env, stdio: 'pipe' });
    execFileSync(process.execPath, [fileURLToPath(new URL('./install.mjs', import.meta.url)), cwd, '--apply'], { env, stdio: 'pipe' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const configFile = path.join(cwd, 'harness/config.json');
  const config = JSON.parse(fs.readFileSync(configFile));
  config.일감목록 = { 동시상한: { [writer.tool]: 1, [reviewer.tool]: 1 }, 기본맡길곳: writer.tool, 기본브랜치: 'main' };
  for (const key of ['할일적기', '맞춰보기', '만들기', '번갈아보기', '고치기', '올림']) {
    config.단계모델[key] = { 도구: writer.tool, 모델: writer.model, 깊이: writer.effort };
  }
  for (const [stage, candidate] of Object.entries(options.stages ?? {})) config.단계모델[stage] = { 도구: candidate.tool, 모델: candidate.model, 깊이: candidate.effort };
  Object.assign(config.단계모델.번갈아보기, { 검토도구: reviewer.tool, 바깥모델: reviewer.model, 바깥추론: reviewer.effort, 폴백도구: reviewer.tool });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(cwd, '.claude/agents'), { recursive:true });
  for (const role of ['planner','reviewer','implementer']) {
    const source = fs.readFileSync(new URL(`../templates/agents/${role}.md`, import.meta.url), 'utf8');
    fs.writeFileSync(path.join(cwd, `.claude/agents/${role}.md`), source.replace(/^- 확인 명령: .*$/m, `- 확인 명령: ${workflowChecks.map(command => '`' + command + '`').join(', ')}`));
  }
  fs.mkdirSync(path.join(cwd, 'docs/tasks'), { recursive:true });
  fs.writeFileSync(path.join(cwd, 'docs/tasks/T-1.md'), `## 사용자 원래 말\n\n${requests.Q10}\n\n## 어디까지·하지 않을 것\n\nparse.mjs·store.mjs·cli.mjs를 고치고 공개 시험은 보존한다. repro*.mjs 생성·실행 허용.\n`);
  return { writer, reviewer, maxFixes: 3, task: 'T-1',
    setup: ['git add .', 'git -c user.name=Exam -c user.email=exam@example.invalid commit -m fixture', 'node harness/backlog.mjs 추가 "CSV 미리보기와 확인 저장"', `node harness/backlog.mjs 시작 T-1 --고칠곳 'parse.mjs,store.mjs,cli.mjs,repro*.mjs' --확인방법 "${workflowChecks.join('; ')}"`],
    command: `node harness/mullebanga.mjs --도구 ${writer.tool} --시간제한 300 T-1` };
}
