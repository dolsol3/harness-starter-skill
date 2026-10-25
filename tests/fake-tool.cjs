#!/usr/bin/env node
// 물레방아 본체 시험용 가짜 codex·agy·claude(같은 파일을 세 이름으로 복사해 쓴다).
// 지시문에서 단계(stage)와 작업 번호를 알아내 FAKE_CALLS에 시작·끝 줄을 남기고, FAKE_SCENARIO(JSON 파일)의 { 작업번호 또는 "*": { 단계: [응답, …] } }대로 답한다.
// 같은 단계를 또 부르면 다음 응답을 쓰고 모자라면 마지막 응답을 쓴다. 응답 칸: payload(기본 결과에 덮어씀), write({이름: 내용 또는 null=지움}),
// exit(종료 코드), stderr, delay(밀리초), sleep(안 끝남, 자손을 띄움), noresult(아무것도 안 내고 끝), tamper(FAKE_AGENTAPI 파일을 바꿈), escape(작업 폴더 밖 파일 경로에 쓰기를 시도함),
// ledger({cwd, args}: 도는 중에 일감 목록 명령을 돌림, 예: 허락 질문 등록).
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const env = process.env;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const prompt = tool === 'agy' ? args[args.indexOf('-p') + 1] : args[args.length - 1];
const MARKERS = [['specReview', '의 맞춰보기를 한다'], ['spec', '의 할 일 적기를 맡는다'], ['build', '를 만든다.'],
  ['other', '의 만든 코드를 다른 도구의 눈으로'], ['review', '의 만든 코드를 살핀다'], ['fix', '를 고친다.'], ['evidence', '의 끝 기준 증거를 모은다']];
const CLEAN = { findings: [] };
const DEFAULTS = {
  spec: { outcome: '건너뜀', reason: '', rejectedCommit: '', rejectedReason: '', pendingQuestions: [], specText: '', asks: [] },
  specReview: { passed: true, findings: [] },
  build: { summary: '만들었다\n둘째 줄' },
  review: CLEAN,
  other: CLEAN,
  fix: { summary: '고쳤다' },
  evidence: { items: [{ no: '1', evidence: '실행해 봄' }], unconfirmed: [] },
};

function identify() {
  for (const [stage, marker] of MARKERS) {
    const found = new RegExp('(T-\\d+)' + marker.replace(/[()]/g, '\\$&')).exec(prompt);
    if (found) return [stage, found[1]];
  }
  return ['unknown', ''];
}
const [stage, id] = identify();
const note = line => {
  try {
    fs.appendFileSync(env.FAKE_CALLS, JSON.stringify({ ...line, tool, stage, id, t: Date.now() }) + '\n');
  } catch (error) {
    // 맥 샌드박스 안이면 밖에 쓸 수 없다(EPERM). 그 밖의 오류는 올린다.
    if (error.code !== 'EPERM') throw error;
  }
};
const earlier = fs.existsSync(env.FAKE_CALLS) ? fs.readFileSync(env.FAKE_CALLS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const index = earlier.filter(call => call.ph === 'start' && call.stage === stage && call.id === id).length;
note({ ph: 'start', args, cwd: process.cwd(), prompt, readOnly: env.HARNESS_READ_ONLY });

async function main() {
  const scenario = JSON.parse(fs.readFileSync(env.FAKE_SCENARIO, 'utf8'));
  const list = (scenario[id] ?? scenario['*'] ?? {})[stage] ?? [];
  const resp = list.length ? list[Math.min(index, list.length - 1)] : {};
  const writes = resp.write ?? { build: { 'impl.txt': 'impl\n' }, fix: { ['fix' + index + '.txt']: 'fix\n' } }[stage] ?? {};
  for (const [name, text] of Object.entries(writes)) {
    if (text === null) fs.rmSync(name, { force: true });
    else fs.writeFileSync(name, text);
  }
  if (resp.ledger) cp.spawnSync(process.execPath, ['harness/backlog.mjs', ...resp.ledger.args], { cwd: resp.ledger.cwd });
  if (resp.tamper) fs.appendFileSync(env.FAKE_AGENTAPI, 'tamper');
  if (resp.escape) {
    try {
      fs.writeFileSync(resp.escape, 'escaped');
    } catch (error) {
      // 샌드박스가 막으면(EPERM) 쓰지 못하는 것이 정상이다. 그 밖의 오류는 올린다.
      if (error.code !== 'EPERM') throw error;
    }
  }
  if (resp.delay) await new Promise(resolve => setTimeout(resolve, resp.delay));
  if (resp.stderr) process.stderr.write(resp.stderr);
  if (resp.sleep) {
    const grandchild = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });
    fs.writeFileSync(env.FAKE_CALLS + '.pid' + process.pid, String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  note({ ph: 'end' });
  if (resp.exit) process.exit(resp.exit);
  if (resp.noresult) return;
  const payload = { ...DEFAULTS[stage], ...resp.payload };
  if (tool === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(payload));
  else if (tool === 'agy') process.stdout.write([{ event: 'init', init: { permission_mode: 'always-proceed' } }, { event: 'result', result: { status: 'SUCCESS', structured_output: payload } }].map(line => JSON.stringify(line)).join('\n') + '\n');
  else process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: payload }));
}
main();
