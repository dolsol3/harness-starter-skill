// 바깥 검토 시험이 함께 쓰는 도우미: 가짜 codex·agy·claude, 임시 git 저장소(메인 폴더와 작업 워크트리), 호출 도우미.
// 가짜는 받은 인자·작업 폴더·환경·복사본 모양을 지적 글자(JSON)로 돌려준다. 샌드박스 안의 가짜는 밖에 파일을 못 쓰기 때문이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewOther } from '../templates/harness/mullebanga-review.mjs';

// 부른 기록(FAKE_CALLS)은 샌드박스 밖이라 제미나이 깨뜨려 보기에서는 남지 않는다. 그때는 결과의 attempts를 본다.
// 환경 FAKE_X_CODEX·FAKE_X_AGY·FAKE_X_CLAUDE가 FAKE_X보다 먼저 쓰인다.
// FAKE_MODE: limit(한도 문구, exit 1) fail(exit 1) sleep(자손을 띄우고 안 끝남) notarray badlevel(결과 칸이 틀림).
// FAKE_WRITE: 작업 폴더에 쓸 파일 이름. FAKE_PROBE: 쓰기를 시도해 볼 경로 JSON 목록({cwd}는 작업 폴더, {root}는 그 위 임시 폴더, 내용은 바꾸지 않는다).
// FAKE_AGENTAPI와 FAKE_AGENTAPI_ACTION: change link delete 중 하나로 그 파일을 바꾼다.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { spawn } = cp;
const env = process.env;
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const opt = name => env[name + '_' + tool.toUpperCase()] ?? env[name];
const mode = opt('FAKE_MODE') || 'ok';
// sleep은 시험이 읽을 손자 pid 파일을 git 호출·objects 걷기보다 먼저 쓴다. 뒤에 두면 부하로 앞 일이 timeoutMs를 넘길 때 pid 파일 없이 죽는다.
if (mode === 'sleep') {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });
  if (env.FAKE_PIDFILE) fs.writeFileSync(env.FAKE_PIDFILE, String(grandchild.pid));
  setInterval(() => {}, 1000);
}
const prompt = tool === 'agy' ? args[args.indexOf('-p') + 1] : args[args.length - 1];
const git = (...a) => { try { return cp.execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'ERR'; } };
const links = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? links(path.join(dir, e.name)) : [fs.statSync(path.join(dir, e.name)).nlink]);
const base = /git diff (\\w+) HEAD/.exec(prompt)?.[1];
const probe = {};
for (const raw of JSON.parse(env.FAKE_PROBE || '[]')) { const p = raw.replace('{cwd}', process.cwd()).replace('{root}', path.dirname(process.cwd())); try { fs.appendFileSync(p, ''); probe[p] = 'ok'; } catch (e) { probe[p] = e.code; } }
const names = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'TMPDIR', 'HARNESS_READ_ONLY', 'WRAPPED'];
const obs = {
  tool, args, prompt, cwd: process.cwd(), probe, env: Object.fromEntries(names.map(n => [n, env[n]])),
  remotes: git('remote'), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), diff: git('diff', '--name-only', base, 'HEAD'),
  files: fs.readdirSync('.').filter(n => n !== '.git').sort(), maxLinks: Math.max(...links('.git/objects')),
};
try { fs.appendFileSync(env.FAKE_CALLS, tool + '\\n'); } catch { /* 맥 샌드박스 안이면 밖에 쓸 수 없다 */ }
if (opt('FAKE_WRITE')) fs.writeFileSync(opt('FAKE_WRITE'), 'x');
const action = opt('FAKE_AGENTAPI_ACTION');
if (action === 'change') fs.appendFileSync(env.FAKE_AGENTAPI, 'tamper');
if (action === 'link') { fs.unlinkSync(env.FAKE_AGENTAPI); fs.symlinkSync('/etc/hosts', env.FAKE_AGENTAPI); }
if (action === 'delete') fs.unlinkSync(env.FAKE_AGENTAPI);
if (mode === 'limit' || mode === 'fail') { process.stderr.write(mode === 'limit' ? 'usage limit reached' : 'boom'); process.exit(1); }
if (mode !== 'sleep') {
  const findings = [{ level: '낮음', text: JSON.stringify(obs) }];
  if (mode === 'badlevel') findings[0].level = '큼';
  const payload = { findings: mode === 'notarray' ? 'x' : findings };
  if (tool === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(payload));
  else if (tool === 'agy') process.stdout.write([{ event: 'init', init: { permission_mode: 'always-proceed' } }, { event: 'result', result: { status: 'SUCCESS', structured_output: payload } }].map(l => JSON.stringify(l)).join('\\n') + '\\n');
  else process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: payload }));
}
`;

export const DEFAULT_CONFIG = {
  일감목록: { 동시상한: { claude: 3, codex: 1, gemini: 1 } },
  단계모델: { 번갈아보기: { 모델: 'opus', 깊이: 'medium', 검토도구: 'codex', 폴백도구: 'gemini', 폴백모델: 'gemini-4-argon-medium' } },
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const observed = res => JSON.parse(res.findings[0].text);
export const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

// roles는 첫 커밋에 넣을 .agents/agents 역할 파일. 시험이 모듈과 같은 프로세스에서 TMPDIR을 바꾸므로 시험끼리 겹쳐 돌리지 않는다.
export function setup(t, { roles = ['breaker', 'readonly'] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-review-')));
  const savedTmp = process.env.TMPDIR;
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  process.env.TMPDIR = tmpRoot;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'bin');
  const gitBin = path.join(dir, 'gitbin');
  fs.mkdirSync(bin);
  fs.mkdirSync(gitBin);
  for (const name of ['codex', 'agy', 'claude']) fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(gitBin, 'git'));
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(path.join(repo, 'docs/tasks'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'harness'));
  fs.mkdirSync(path.join(repo, '.agents/agents'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'docs/tasks/T-1.md'), '# T-1 시험 작업\n\n## 끝 기준\n\n1. 된다\n');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  for (const role of roles) fs.writeFileSync(path.join(repo, '.agents/agents', `${role}.md`), `# ${role}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'ai/T-1', worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'impl.txt'), 'impl\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'impl');
  const commit = git(worktree, 'rev-parse', 'HEAD');
  const home = path.join(dir, 'home');
  const agentapi = path.join(home, '.gemini/antigravity-cli/bin/agentapi');
  fs.mkdirSync(path.dirname(agentapi), { recursive: true });
  fs.writeFileSync(agentapi, '#!/bin/sh\necho agentapi\n');
  const nodeDir = path.dirname(process.execPath);
  const searchPath = [bin, nodeDir, '/usr/bin', '/bin'].join(path.delimiter);
  // sandbox-exec가 없는 PATH: /usr/bin을 빼고 git만 따로 둔다(fake가 git을 부른다).
  const noSandboxPath = [bin, nodeDir, gitBin].join(path.delimiter);
  const setConfig = config => fs.writeFileSync(path.join(repo, 'harness/config.json'), JSON.stringify(config));
  setConfig(DEFAULT_CONFIG);
  let count = 0;
  const calls = path.join(dir, 'calls');
  const review = (fake = {}, input = {}) => {
    const n = count++;
    const env = { PATH: searchPath, HOME: home, FAKE_CALLS: calls, FAKE_PIDFILE: path.join(dir, `pid${n}`), FAKE_AGENTAPI: agentapi, ...fake };
    return reviewOther({ repo, id: 'T-1', worktree, commit, base: 'main', author: 'claude', env, timeouts: { breaking: 20000, readOnly: 20000 }, ...input });
  };
  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, repo, worktree, commit, home, agentapi, tmpRoot, searchPath, noSandboxPath, setConfig, review, called, git: (...args) => git(worktree, ...args) };
}
