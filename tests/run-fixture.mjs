// 물레방아 본체(mullebanga.mjs) 시험이 함께 쓰는 도우미: 하네스·역할 파일·장부 작업이 든 임시 git 저장소와, 가짜 codex·agy·claude를 놓은 PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, ok, rewrite } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeTool = fs.readFileSync(path.join(root, 'tests/fake-tool.cjs'), 'utf8');
const docOf = (n, criteria) => `# T-${n} 시험 작업\n\n## 사용자 원래 말\n\n- 사용자: "시험"\n${criteria ? '\n## 끝 기준\n\n1. hello 한다\n' : ''}`;
const CI = "import fs from 'node:fs';\nif (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS + '.ci', process.argv.slice(2).join(' ') + '\\n');\nif (fs.existsSync('FAIL')) { console.error('확인 실패 ' + fs.readFileSync('FAIL', 'utf8')); process.exit(1); }\n";

export const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
export const stoppedAt = (result, ...words) => {
  assert.equal(result.stopped, true, JSON.stringify(result));
  for (const word of words) assert.ok(result.reason.includes(word), `${word} 없음: ${result.reason}`);
};
export const calledStages = calls => calls.filter(call => call.ph === 'start').map(call => `${call.id}:${call.stage}:${call.tool}`);

// tools[i]가 T-(i+1)의 맡길곳이다. bareSpec이면 문서에 끝 기준이 없다. checkLine이 null이면 implementer.md에 확인 명령 줄이 없다.
export function setup(t, { tools = ['codex'], bareSpec = false, checkLine = '- 확인 명령: `node ci.mjs 바뀐 파일들`', limits = { claude: 5, codex: 5, gemini: 5 } } = {}) {
  const dir = fs.realpathSync(repo(t));
  const aux = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-run-aux-')));
  t.after(() => fs.rmSync(aux, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  for (const role of ['planner', 'reviewer', 'implementer']) {
    const body = fs.readFileSync(path.join(root, 'templates/agents', `${role}.md`), 'utf8');
    fs.writeFileSync(path.join(dir, '.claude/agents', `${role}.md`), role === 'implementer' ? body.replace(/^- 확인 명령:.*$/m, checkLine ?? '- 확인 명령 없음') : body);
  }
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.claude/\n');
  fs.cpSync(path.join(root, 'templates/antigravity'), path.join(dir, '.agents/agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs/tasks'), { recursive: true });
  tools.forEach((_, i) => fs.writeFileSync(path.join(dir, `docs/tasks/T-${i + 1}.md`), docOf(i + 1, !bareSpec)));
  fs.writeFileSync(path.join(dir, 'ci.mjs'), CI);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  const configFile = path.join(dir, 'harness/config.json');
  const editConfig = change => {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    change(config);
    fs.writeFileSync(configFile, JSON.stringify(config));
  };
  editConfig(config => {
    config.일감목록 = { 동시상한: limits, 기본맡길곳: 'claude' };
    config.단계모델.번갈아보기 = { 모델: 'opus', 깊이: 'high', 검토도구: 'codex', 폴백도구: 'gemini', 폴백모델: 'gemini-4-argon-high' };
  });
  tools.forEach((tool, i) => {
    ok(dir, '추가', `작업 ${i + 1}`, '--고칠곳', 'src', '--확인방법', '시험');
    ok(dir, '시작', `T-${i + 1}`, '--맡길곳', tool);
  });
  const bin = path.join(aux, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['codex', 'agy', 'claude']) fs.writeFileSync(path.join(bin, name), fakeTool, { mode: 0o755 });
  // 쓰기 묶기를 실제로 걸지 않고 규칙 파일만 FAKE_CALLS.rules에 남기는 가짜: 시험이 호출 기록을 쓰려면 묶이지 않아야 한다. 진짜 묶기는 이 파일을 지워 시험한다.
  fs.writeFileSync(path.join(bin, 'sandbox-exec'), '#!/bin/sh\ncp "$2" "$FAKE_CALLS.rules"\nshift 2\nexec "$@"\n', { mode: 0o755 });
  const gitDir = path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
  const searchPath = [bin, path.dirname(process.execPath), gitDir, '/usr/bin', '/bin'].join(path.delimiter);
  const home = path.join(aux, 'home');
  fs.mkdirSync(home);
  const calls = path.join(aux, 'calls');
  const scenarioFile = path.join(aux, 'scenario.json');
  const scenario = value => fs.writeFileSync(scenarioFile, JSON.stringify(value));
  scenario({});
  const run = (args, extraEnv = {}) => new Promise(resolve => {
    // TMPDIR은 넘긴다: /tmp 쓰기가 막히고 TMPDIR만 열린 샌드박스(바깥 검토)에서도 본체가 임시 폴더를 만든다.
    const env = { PATH: searchPath, HOME: home, USERPROFILE: home, FAKE_CALLS: calls, FAKE_SCENARIO: scenarioFile, ...(process.env.TMPDIR && { TMPDIR: process.env.TMPDIR }), ...extraEnv };
    const child = spawn(process.execPath, ['harness/mullebanga.mjs', ...args], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined }));
  });
  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const harnessBefore = fs.readdirSync(path.join(dir, 'harness')).sort();
  return { dir, aux, home, calls, bin, searchPath, git: (...args) => git(dir, ...args), gitIn: git, scenario, run, called, editConfig, ledger: (...args) => ok(dir, ...args), rewrite: change => rewrite(dir, change), harnessBefore };
}
