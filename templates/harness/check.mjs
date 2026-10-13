#!/usr/bin/env node
// 간결함 검사: 새로 쓰거나 바꾼 코드가 프로젝트 한도를 넘는지 본다.
//
//   node harness/check.mjs <파일...>   지정한 파일에서 바뀐 줄을 검사한다
//   node harness/check.mjs --staged     커밋할 파일(git add 한 것)을 검사한다 (git pre-commit)
//   node harness/check.mjs --hook       AI 도구 훅(Claude Code·Codex·Antigravity): 방금 고친 파일을 검사한다
//
// 이미 있던 코드는 탓하지 않는다. 새로 더한 줄과, 한도를 넘은 채로 더 커진 파일만 본다.
// 한도는 harness/config.json의 파일 종류(kinds)마다 정한다. 어느 종류에도 없는 파일은 보지 않는다.
// 위반이 있으면 종료 코드 1(훅 모드는 2)로 끝난다. config.json이 옛 모양이면 2로 끝난다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = git(['rev-parse', '--show-toplevel'], process.cwd())?.trim() ?? process.cwd();
const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('config.json', import.meta.url)), 'utf8'));
if (!config.kinds) {
  console.error('harness/config.json이 옛 모양이다(kinds가 없다). harness-starter 스킬을 다시 돌려 종류별 한도를 정한다.');
  process.exit(2);
}
// 'm': 프로젝트 규칙의 ^ 와 $ 가 덩어리 안의 줄마다 맞게 한다.
const patterns = config.patterns.map(p => ({ regex: new RegExp(p.regex, 'gm'), message: p.message }));

// git 명령을 저장소 맨 위에서 실행해 출력을 돌려준다. 실패하면(저장소가 아님, 처음 보는 파일 등) null.
function git(args, cwd = root) {
  try {
    const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], options);
  } catch {
    return null;
  }
}

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// 무시 목록: '/'로 끝나면 폴더 이름(경로 어디에 있든), 아니면 파일 이름 끝.
function ignored(file) {
  return config.ignore.some(entry => entry.endsWith('/')
    ? file.split('/').includes(entry.slice(0, -1))
    : file.endsWith(entry));
}

// 파일 종류: files 패턴(저장소 맨 위 기준 경로)에 처음 맞는 종류. 어느 종류에도 없으면 undefined.
function kindOf(file) {
  return Object.values(config.kinds).find(kind => kind.files.some(glob => path.posix.matchesGlob(file, glob)));
}

// 검사할 내용: 커밋 모드는 git에 올린 내용, 그 밖에는 작업 폴더의 파일.
function readContent(file, staged) {
  if (staged) return git(['show', `:${file}`]) ?? '';
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// diff에서 새로 더한 줄: 줄 번호 → 내용
function addedLines(diff) {
  const added = new Map();
  let next = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) next = Number(hunk[1]);
    else if (line.startsWith('+') && next > 0) added.set(next++, line.slice(1));
  }
  return added;
}

// 새로 더한 줄을 이어진 덩어리로 돌려준다: [{ start: 첫 줄 번호, lines: [...] }]
// git이 모르는 파일(새 파일, 저장소 밖)은 전체를 새로 더한 것으로 본다.
// 병합 중에는 양쪽 브랜치 어디에도 없던 줄(충돌을 풀며 쓴 줄)만 새 줄이다. 상대 브랜치의 줄은 그쪽에서 검사했다.
function addedBlocks(file, content, staged) {
  const tracked = git(['ls-files', '--error-unmatch', file]) !== null;
  const paths = renames.has(file) ? [renames.get(file), file] : [file];
  const diffFrom = base => git(['diff', ...base, '-M', '-U0', '--no-color', '--no-ext-diff', '--', ...paths]);
  const diff = diffFrom(staged ? ['--cached'] : ['HEAD']);
  const whole = content.split('\n').slice(0, lineCount(content));
  let added = new Map(whole.map((text, i) => [i + 1, text]));
  if (diff !== null && (staged || tracked)) added = addedLines(diff);
  if (merging) {
    const theirs = addedLines(diffFrom(['--cached', 'MERGE_HEAD']) ?? '');
    added = new Map([...added].filter(([number]) => theirs.has(number)));
  }
  const blocks = [];
  for (const [number, text] of added) {
    const last = blocks.at(-1);
    if (last && last.start + last.lines.length === number) last.lines.push(text);
    else blocks.push({ start: number, lines: [text] });
  }
  return blocks;
}

// 종류에 적힌 한도만 본다: 줄 길이, 파일 길이, 금지 패턴(patterns: true). 커밋 크기(더한 줄 수, 줄을 더한 파일 수)에는 한도가 있는 종류만 센다.
function checkFile(file, staged) {
  const kind = kindOf(file);
  if (!kind) return { problems: [], added: 0 };
  const content = readContent(file, staged);
  if (content.includes('\0')) return { problems: [], added: 0 };
  const { maxFileLines = Infinity, maxLineLength = Infinity } = kind;
  const problems = [];
  const report = (line, message) => problems.push(`${file}:${line}: ${message}`);
  const blocks = addedBlocks(file, content, staged);

  for (const block of blocks) {
    block.lines.forEach((text, i) => {
      if (text.length > maxLineLength) report(block.start + i, `줄이 ${text.length}자: ${maxLineLength}자 안으로 나눈다`);
    });
    const text = block.lines.join('\n');
    for (const { regex, message } of kind.patterns ? patterns : []) {
      for (const match of text.matchAll(regex)) {
        report(block.start + lineCount(text.slice(0, match.index + 1)) - 1, message);
      }
    }
  }

  const lines = lineCount(content);
  const refs = merging ? ['HEAD', 'MERGE_HEAD'] : ['HEAD'];
  const before = Math.max(...refs.map(ref => lineCount(git(['show', `${ref}:${renames.get(file) ?? file}`]) ?? '')));
  if (lines > maxFileLines && lines > before) {
    report(1, `파일이 ${lines}줄(전에는 ${before}줄): ${maxFileLines}줄을 넘었다. 나누거나 줄인다`);
  }
  const limited = maxFileLines < Infinity || maxLineLength < Infinity;
  const added = limited ? blocks.reduce((sum, block) => sum + block.lines.length, 0) : 0;
  return { problems, added };
}

function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '-M', '--diff-filter=ACMR']) ?? '';
  return out.split('\n').filter(Boolean);
}

// git mv로 옮긴 파일: 새 경로 → 옛 경로. 옮기기만 한 코드를 새 코드로 탓하지 않는다.
function findRenames() {
  const out = git(['diff', '--cached', '-M', '--name-status', '--diff-filter=R']) ?? '';
  return new Map(out.split('\n').filter(Boolean).map(line => line.split('\t').slice(1).reverse()));
}

// 저장소 맨 위 기준 경로로 바꾼다. macOS의 /var → /private/var 같은 별칭을 풀어 비교한다.
// git은 '/' 경로만 알아들으므로 Windows의 '\'를 바꾼다(아니면 git show가 실패해 이전 줄 수가 0이 된다).
function fromRoot(file) {
  const abs = path.resolve(file);
  return path.relative(root, fs.existsSync(abs) ? fs.realpathSync(abs) : abs).split(path.sep).join('/');
}

// AI 도구가 표준입력으로 주는 JSON에서 고친 파일을 꺼낸다.
// Claude Code는 tool_input.file_path, Codex는 apply_patch 패치 글의 파일 줄, Antigravity는 toolCall.args.TargetFile.
function hookFiles() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = input.cwd ?? input.workspacePaths?.[0] ?? root;
  const patch = input.tool_name === 'apply_patch' ? String(input.tool_input?.command ?? '') : '';
  const fileLines = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
  const patched = [...patch.matchAll(fileLines)].map(match => match[1].trim());
  const files = [input.tool_input?.file_path, input.toolCall?.args?.TargetFile, ...patched];
  return files.filter(Boolean).map(file => fromRoot(path.resolve(base, file)));
}

const args = process.argv.slice(2);
const staged = args.includes('--staged');
const merging = staged && git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null;
const renames = findRenames();
const hook = args.includes('--hook');
let files = args.filter(arg => !arg.startsWith('--')).map(fromRoot);
if (staged) files = stagedFiles();
if (hook) files = hookFiles();
files = files.filter(file => !file.startsWith('..') && !ignored(file));
if (!staged) files = files.filter(file => fs.existsSync(path.join(root, file)));

const results = files.map(file => checkFile(file, staged));
const problems = results.flatMap(result => result.problems);
const added = results.reduce((sum, result) => sum + result.added, 0);
if (staged && added > config.maxCommitLines) {
  problems.push(`이번 커밋에 더한 줄이 ${added}줄: ${config.maxCommitLines}줄 안으로 나눠서 커밋한다`);
}
const changedFiles = results.filter(result => result.added > 0).length;
const maxCommitFiles = config.maxCommitFiles ?? 15;
if (staged && changedFiles > maxCommitFiles) {
  problems.push(`이번 커밋에 고친 파일이 ${changedFiles}개: ${maxCommitFiles}개 안으로 나눠서 커밋한다`);
}

if (problems.length) {
  const out = hook ? process.stderr : process.stdout;
  out.write(`간결함 검사(harness/check.mjs) 위반 ${problems.length}건:\n`);
  out.write(problems.map(problem => `  ${problem}`).join('\n') + '\n');
  out.write('한도를 늘리지 말고 코드를 줄이세요. 한도를 바꾸려면 사람에게 묻습니다.\n');
  process.exitCode = hook ? 2 : 1;
}
