// 공용 물레방아의 git 부분: 워크트리 만들기, 커밋, 돌려보기, 반려 뒤나 멈춘 뒤 이어 갈 브랜치 열기.
// 커밋을 AI에게 맡기지 않고 코드가 한다: 코덱스 샌드박스가 연결 워크트리의 git commit을 거절한 적이 있고(index.lock), 클로드판은 해시 칸에 PLACEHOLDER가 들어온 적이 있다(docs/notes.md).
// 결과는 늘 git(rev-parse, status)으로 직접 확인한다. 실패는 던지지 않고 {ok: false, ...}로 돌려준다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const OUTPUT_TAIL = 4000;
const CHANGED_FILES = '바뀐 파일들';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

const worktreeDir = (repo, name) => path.join(repo, '.claude', 'worktrees', name);
const gitMessage = result => [result.err, result.out].filter(Boolean).join('\n');

// patch.mjs와 같은 읽기. 설정 파일이 없으면 main.
function baseBranch(repo) {
  const file = path.join(repo, 'harness', 'config.json');
  if (!fs.existsSync(file)) return 'main';
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const 일감설정 = config.일감목록 ?? config.backlog ?? {};
  return 일감설정.기본브랜치 ?? 일감설정.baseBranch ?? 'main';
}

export function createWorktree(repo, name) {
  const base = baseBranch(repo);
  const branch = `ai/${name}`;
  const worktree = worktreeDir(repo, name);
  const baseRef = git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`);
  if (!baseRef.ok) return { ok: false, reason: `기본 브랜치 ${base}가 없다` };
  const added = git(repo, 'worktree', 'add', '-b', branch, worktree, `refs/heads/${base}`);
  if (!added.ok) return { ok: false, reason: gitMessage(added) };
  return { ok: true, worktree, branch, base };
}

// 지금 작업 폴더 내용을 가리키는 트리 해시. 도구가 아무것도 안 바꿨는지 볼 때 쓴다(스테이징만 하고 커밋은 하지 않는다).
export function snapshot(worktree) {
  const staged = git(worktree, 'add', '-A');
  if (!staged.ok) return { ok: false, reason: gitMessage(staged) };
  return { ok: true, tree: git(worktree, 'write-tree').out };
}

export function commitAll(worktree, message) {
  const before = git(worktree, 'rev-parse', 'HEAD').out;
  const staged = git(worktree, 'add', '-A');
  if (!staged.ok) return { ok: false, reason: gitMessage(staged) };
  if (git(worktree, 'diff', '--cached', '--quiet').ok) return { ok: false, reason: '커밋할 바뀐 파일이 없다' };
  const committed = git(worktree, 'commit', '-q', '-m', message);
  if (!committed.ok) return { ok: false, reason: gitMessage(committed) };
  const leftover = git(worktree, 'status', '--porcelain').out;
  if (leftover) return { ok: false, reason: `커밋 뒤에도 바뀐 파일이 남았다:\n${leftover}` };
  const commit = git(worktree, 'rev-parse', 'HEAD').out;
  if (commit === before) return { ok: false, reason: '커밋했는데 HEAD가 그대로다' };
  return { ok: true, commit };
}

export function readCheckCommands(repo, file = '.claude/agents/implementer.md') {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return [];
  const line = fs.readFileSync(full, 'utf8').split('\n').find(text => text.startsWith('- 확인 명령:'));
  if (!line) return [];
  return [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]);
}

// 기준 브랜치와 갈라진 곳부터 지금까지 바뀐 파일: 앞서 커밋한 것, 커밋 전 것, 새 파일을 다 담는다(고치지 않은 위반도 계속 검사하려고).
// files는 남아 있는 것(수정·추가·새 파일)이고 deleted는 지운 것이다. -z로 읽어 공백·한글 이름을 그대로 얻는다.
function changedFiles(worktree, base) {
  const read = (...args) => git(worktree, '-c', 'core.quotepath=false', ...args).out.split('\0').filter(Boolean);
  const since = git(worktree, 'merge-base', base, 'HEAD').out;
  const tracked = read('diff', '-z', '--name-only', '--diff-filter=d', since);
  const deleted = read('diff', '-z', '--name-only', '--diff-filter=D', since);
  return { files: [...tracked, ...read('ls-files', '-z', '--others', '--exclude-standard')], deleted };
}

// 시간 제한을 넘기면 자식과 손자까지 프로세스 그룹째 끝낸다.
function runShell(command, cwd, seconds) {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    // 청크를 글자로 바꿀 때 한글 한 글자의 바이트가 청크 경계에서 쪼개지면 깨지므로 디코더에 맡긴다.
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, 'SIGKILL');
    }, seconds * 1000);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) resolve({ exitCode: null, output: `${output}\n시간 초과: ${seconds}초 안에 끝나지 않아 끝냈다` });
      else resolve({ exitCode: code, output });
    });
  });
}

// 작은따옴표 안에서는 셸이 아무것도 풀지 않으므로 백틱·$()·큰따옴표가 든 파일명도 글자 그대로 넘어간다.
const quote = file => `'${file.replaceAll("'", "'\\''")}'`;

export async function runChecks(worktree, commands, { seconds = 300, base = 'HEAD' } = {}) {
  if (commands.length === 0) return { ok: false, reason: '돌릴 확인 명령이 없다' };
  for (const template of commands) {
    let command = template;
    if (template.includes(CHANGED_FILES)) {
      const { files, deleted } = changedFiles(worktree, base);
      if (files.length + deleted.length === 0) return { ok: false, command: template, reason: `${CHANGED_FILES}이 하나도 없어 검사할 것이 없다` };
      command = template.replaceAll(CHANGED_FILES, files.map(quote).join(' '));
    }
    const result = await runShell(command, worktree, seconds);
    if (result.exitCode !== 0) {
      return { ok: false, command: template, exitCode: result.exitCode, output: result.output.trim().slice(-OUTPUT_TAIL) };
    }
  }
  return { ok: true };
}

// git worktree list --porcelain을 {path, branch, prunable} 목록으로 바꾼다.
function listWorktrees(repo) {
  const blocks = git(repo, 'worktree', 'list', '--porcelain').out.split('\n\n');
  return blocks.map(block => {
    const lines = block.split('\n');
    const field = key => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1);
    return { path: field('worktree'), branch: field('branch')?.replace('refs/heads/', ''), prunable: lines.some(line => line.startsWith('prunable')) };
  });
}

export const branchExists = (repo, name) => git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/ai/${name}`).ok;

// 브랜치가 열린 워크트리가 있으면 그것을, 폴더가 지워졌으면 같은 브랜치로 같은 자리에 다시 연다.
export function openBranch(repo, branch) {
  const open = listWorktrees(repo).find(item => item.branch === branch && !item.prunable && fs.existsSync(item.path));
  if (open) return { ok: true, branch, worktree: open.path, created: false };
  git(repo, 'worktree', 'prune');
  const worktree = worktreeDir(repo, branch.slice('ai/'.length));
  const added = git(repo, 'worktree', 'add', worktree, branch);
  if (!added.ok) return { ok: false, stopReason: gitMessage(added) };
  return { ok: true, branch, worktree, created: true };
}

// 멈춘 작업이 어디까지 했는지: 기본 브랜치 이후 커밋 수, 커밋 안 한 변경이 있는지, 지금 HEAD.
export function inspectBranch(worktree, base) {
  return { commits: Number(git(worktree, 'rev-list', '--count', `${base}..HEAD`).out), dirty: git(worktree, 'status', '--porcelain').out !== '', head: git(worktree, 'rev-parse', 'HEAD').out };
}

export function findResumeBranch(repo, commit) {
  if (!git(repo, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`).ok) {
    return { ok: false, stopReason: `반려 커밋 ${commit}을 찾을 수 없다` };
  }
  const contains = git(repo, 'branch', '--contains', commit, '--format=%(refname:short)').out;
  const branches = contains.split('\n').filter(name => name.startsWith('ai/'));
  if (branches.length === 0) return { ok: false, stopReason: `반려 커밋 ${commit}이 든 ai/ 브랜치가 없다` };
  if (branches.length > 1) return { ok: false, stopReason: `반려 커밋 ${commit}이 든 ai/ 브랜치가 둘 이상이다: ${branches.join(', ')}` };
  return openBranch(repo, branches[0]);
}
