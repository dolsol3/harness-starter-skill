#!/usr/bin/env node
// 막는 훅: 일감 목록 규칙을 어기는 시도를 도구를 쓰기 전에 거절한다. 거절은 종료 코드 2와 올바른 길을 알리는 글이다.
//
//   node harness/guard.mjs --hook     AI 도구 훅(PreToolUse: Claude Code·Codex·Antigravity): 표준입력의 도구 호출을 본다
//   node harness/guard.mjs --staged   git pre-commit: 코드 파일을 커밋하는데 진행중인 작업이 없으면 거절한다
//
// 거절하는 것: 일감 목록 파일(harness/backlog.json) 직접 읽기·고치기, 진행중인 작업 없이 코드 파일 고치기,
// 검사 설정·검사기·일감 목록 명령 고치기, 커밋 검사 건너뛰기(--no-verify).
// 진행중인 작업이 있어도 지키는 파일(.env, 잠금 파일, .git 아래, harness/config.json의 protect로 바꿈) 고치기. 읽기는 된다.
// 환경 변수 HARNESS_READ_ONLY=1로 부른 도구(읽기 전용 검토)의 파일 고치기와 명령 실행.
// 코드 파일은 harness/config.json의 kinds에서 한도(줄 수, 줄 길이, 금지 패턴)를 정한 종류의 파일이다.
// 설정이나 일감 목록을 읽지 못하는 등 확인하지 못하면 통과시키지 않고 거절한다(종료 코드 2).
// 한계: 파일을 스크립트나 셸 명령(sed, 리다이렉트, rm 등)으로 바꾸는 것은 명령 글에 일감 목록 파일 이름이 없으면 보지 못한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ledger from './ledger.mjs';

const LEDGER = 'harness/backlog.json';
const PROTECTED = ['config.json', 'check.mjs', 'guard.mjs', 'backlog.mjs', 'ledger.mjs', 'questions.mjs', 'page.mjs', 'patch.mjs', 'serve.mjs', 'stop.mjs'].map(name => `harness/${name}`);
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum'];
const KEEP = ['.env', '.env.*', ...LOCKS, '.git'];
const START = 'node harness/backlog.mjs 추가 "제목"으로 작업을 만들고 시작 T-1 --고칠곳(--영역) … --확인방법 "…"으로 시작한 뒤 고친다';
let config;

const git = args => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('config.json', import.meta.url)), 'utf8'));
  } catch (error) {
    throw new Error(`harness/config.json을 읽을 수 없다(${error.message}). 사람이 고친다`);
  }
}

// 옛 모양이면 check.mjs처럼 알린다. 파일을 다루는 호출에서만 확인해서, 셸 명령(--upgrade)은 막지 않는다.
function kinds() {
  if (!config.kinds) throw new Error('harness/config.json이 옛 모양이다(kinds가 없다). harness-starter 스킬을 다시 돌려 종류별 한도를 정한다');
  return config.kinds;
}

// 없는 파일도 같은 파일을 가리키는 다른 철자(macOS의 대소문자, 한글의 NFC/NFD, /var → /private/var)를 실제 저장된 모양으로 맞추도록,
// 있는 데까지 올라가 운영체제가 돌려주는 경로(native)로 바꾼다.
function real(file) {
  const abs = path.resolve(file);
  return fs.existsSync(abs) ? fs.realpathSync.native(abs) : path.join(real(path.dirname(abs)), path.basename(abs));
}

// check.mjs와 같이 files 패턴에 처음 맞는 종류를 본다. 한도를 정한 종류의 파일이 코드 파일이다.
function isCode(rel) {
  const kind = Object.values(kinds()).find(item => item.files.some(glob => path.posix.matchesGlob(rel, glob)));
  return Boolean(kind && (kind.maxFileLines !== undefined || kind.maxLineLength !== undefined || kind.patterns));
}

// 지키는 글롭은 .gitignore처럼 경로 안 어느 깊이의 부분 경로에 맞아도 되고, 맞은 폴더 아래는 전부 지킨다(모노레포의 하위 폴더 잠금 파일, .git 아래).
// **/로 깊이를 맞추지 않는 까닭: matchesGlob의 **는 점으로 시작하는 폴더·파일(.hidden/.env, .git/.x)을 지나가지 않는다.
function keeps(rel) {
  const parts = rel.split('/');
  const pieces = parts.flatMap((_, start) => parts.slice(start).map((_, length) => parts.slice(start, start + length + 1).join('/')));
  return pieces.some(piece => (config.지키는파일 ?? config.protect ?? KEEP).some(glob => path.posix.matchesGlob(piece, glob)));
}

// 실제 경로(맨 앞)와 함께, 조상 폴더마다 그 폴더까지만 풀고 아래는 적힌 이름 그대로 둔 경로를 돌려준다.
// 지키는 이름이 심볼릭 링크면(.env -> secrets/prod, .git/hooks -> ../shared-hooks) 실제 경로에는 그 이름이 없다.
function spellings(abs) {
  if (abs === path.dirname(abs)) return [abs];
  return [real(abs), ...spellings(path.dirname(abs)).map(dir => path.join(dir, path.basename(abs)))];
}

const working = () => ledger.load(ledger.mainRoot()).작업.some(task => task.상태 === '진행중');

function fileProblem(tool, file) {
  // 작업 폴더(워크트리)와 메인 폴더 어느 쪽 파일이든 저장소 맨 위 기준 같은 이름으로 본다.
  const roots = [git(['rev-parse', '--show-toplevel']), ledger.mainRoot()];
  const rels = spellings(path.resolve(file)).flatMap(abs => roots.map(root => path.relative(root, abs).split(path.sep).join('/'))).filter(rel => rel.split('/')[0] !== '..');
  if (rels.includes(LEDGER)) {
    return `${LEDGER}은(는) ${tool}로 직접 다루지 않는다. node harness/backlog.mjs 목록·보기 T-1·시작 T-1처럼 명령으로 다룬다`;
  }
  if (tool === 'Read') return null;
  // kinds가 비어 있는 설치 직후에는 config.json을 채울 수 있다(종류와 한도를 정하는 설치 절차).
  const setup = Object.keys(kinds()).length === 0;
  const guarded = rels.find(rel => PROTECTED.includes(rel) && !(setup && rel === 'harness/config.json'));
  if (guarded) {
    return `${guarded}은(는) 검사 설정이라 고치지 않는다. 한도를 늘리지 말고 코드를 줄인다. 바꿔야 하면 사람에게 묻는다`;
  }
  const kept = rels.find(keeps);
  if (kept) {
    return `${kept}은(는) 지키는 파일이라 고치지 않는다(읽기는 된다). 잠금 파일은 설치 명령(예: npm install)으로 바뀐다. 바꿔야 하면 사람에게 묻는다. 목록은 harness/config.json의 protect로 바꾼다`;
  }
  // 코드 판정은 파일을 품은 가장 가까운 폴더(작업 폴더가 먼저) 기준 한 경로만 본다. 워크트리가 메인 폴더 안에 있으면
  // 메인 기준 경로는 .claude/worktrees/…로 길어져 워크트리 기준과 다른 종류에 맞을 수 있다.
  if (rels.slice(0, 1).some(isCode) && !working()) return `진행중인 작업이 없다. ${START}`;
  return null;
}

function bashProblem(command) {
  if (command.includes('backlog.json')) {
    return 'backlog.json은 직접 읽거나 고치지 않는다. node harness/backlog.mjs 목록·보기 T-1처럼 명령으로 다룬다';
  }
  if (command.includes('--no-verify')) return '--no-verify로 커밋 검사를 건너뛰지 않는다. 검사가 거절하면 원인을 고친다';
  return null;
}

// 도구마다 훅이 받는 입력 모양이 다르다. 한 모양 { cwd, tool(Read·Edit·Write·Bash), command, files }로 맞춘다. 모르는 도구는 tool이 없어 통과한다.
//   Claude Code: tool_name과 tool_input(file_path 또는 command), cwd
//   Codex: 파일 편집은 tool_name 'apply_patch'이고 tool_input.command가 패치 글이다. 고치는 파일은 그 안의 '*** Add File: 경로' 같은 줄에 있다. 셸은 'Bash'
//   Antigravity: toolCall.name과 toolCall.args(TargetFile, AbsolutePath, CommandLine). cwd가 없고 훅 프로세스가 hooks.json이 있는 .agents에서 돌므로 이미 저장소 안이다
// 실제 Codex의 패치 읽기는 헤더 줄 앞의 공백을 허용하고(첫 헤더와 Add 본문 뒤, 직접 확인) 셸에서 apply_patch <<'EOF'로도 부른다.
// 그래서 앞 공백을 허용하고 Bash 명령 글에도 같은 헤더를 찾는다. Update 본문의 공백으로 시작하는 문맥 줄이 헤더처럼 보이면 거절 쪽으로 틀린다(드묾).
const PATCH_FILE = /^[^\S\n]*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const ANTIGRAVITY = { write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', view_file: 'Read', run_command: 'Bash' };

function normalize(input) {
  if (input.toolCall) {
    const { name, args = {} } = input.toolCall;
    return { tool: ANTIGRAVITY[name], command: args.CommandLine, files: [args.TargetFile ?? args.AbsolutePath] };
  }
  const { tool_name: tool, tool_input: params = {} } = input;
  if (tool === 'apply_patch') return { cwd: input.cwd, tool: 'Edit', files: patchFiles(params.command) };
  return { cwd: input.cwd, tool, command: params.command, files: [params.file_path] };
}

// 읽기 전용 검토를 맡긴 도구가 고치거나 명령을 실행하지 못하게 한다. Codex는 읽기도 셸로 해서 이 변수를 주면 읽기까지 막힌다.
const WRITING = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];
const READ_ONLY = '읽기 전용 실행(HARNESS_READ_ONLY=1)이라 파일을 고치거나 명령을 실행하지 않는다. 읽기만 하고 보고한다';

const patchFiles = text => [...String(text ?? '').matchAll(PATCH_FILE)].map(match => match[1].trim());
const firstProblem = (tool, files) => files.filter(Boolean).map(file => fileProblem(tool, file)).find(Boolean) ?? null;

function hookProblem() {
  const { cwd, tool, command, files } = normalize(JSON.parse(fs.readFileSync(0, 'utf8')));
  if (process.env.HARNESS_READ_ONLY === '1' && WRITING.includes(tool)) return READ_ONLY;
  if (cwd) process.chdir(cwd);
  if (tool === 'Bash') return bashProblem(String(command ?? '')) ?? firstProblem('Edit', patchFiles(command));
  return firstProblem(tool, files);
}

// 충돌을 풀어 병합하는 중에는 상대 브랜치에서 그대로 온 파일을 세지 않는다(그쪽에서 이미 검사했다).
// 상대 브랜치와도 다른 파일, 곧 충돌을 풀며 쓴 파일(자동으로 합쳐진 파일 포함)만 본다.
function stagedProblem() {
  const staged = refs => git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD', ...refs]).split('\0').filter(Boolean);
  const theirs = fs.existsSync(git(['rev-parse', '--git-path', 'MERGE_HEAD'])) ? new Set(staged(['MERGE_HEAD'])) : null;
  const files = staged([]).filter(file => isCode(file) && (!theirs || theirs.has(file)));
  if (!files.length || working()) return null;
  return `커밋 거절: 코드 파일(${files.slice(0, 3).join(', ')}${files.length > 3 ? ` 외 ${files.length - 3}개` : ''})을 커밋하는데 진행중인 작업이 없다. ${START}`;
}

try {
  config = loadConfig();
  const modes = { '--hook': hookProblem, '--staged': stagedProblem };
  if (!modes[process.argv[2]]) throw new Error('사용법: node harness/guard.mjs --hook | --staged');
  const problem = modes[process.argv[2]]();
  if (problem) {
    console.error(`guard: ${problem}`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`guard: 확인하지 못해 거절한다: ${error.message}`);
  process.exitCode = 2;
}
