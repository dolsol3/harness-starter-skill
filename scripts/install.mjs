#!/usr/bin/env node
// 간결함 하네스를 대상 프로젝트에 설치한다. 기본은 미리보기이고 --apply일 때만 쓴다.
//
//   node scripts/install.mjs <대상 폴더> [--apply] [--upgrade] [--without=<장치,...>]
//   장치: instructions, claude-hook, codex-hook, antigravity-hook, git-hook, lean-review, backlog
//
// 원칙은 AGENTS.md에 넣는다(Codex·Antigravity가 읽는다). Claude Code는 CLAUDE.md의 @AGENTS.md로 불러온다.
//
// 사용자가 쓴 내용은 덮어쓰지 않는다. 이미 다른 내용이 있으면 건너뛰고 할 일을 알린다.
// 예외는 --upgrade뿐이다. 옛 검사기, 옛 모양의 harness/config.json, 설치된 장부 명령 파일(backlog·ledger·questions·page·patch·serve·guard·stop), 제미나이 역할 파일(readonly·research)을 새것으로 바꾸고
// 우리가 만든 pre-commit에 막는 훅 줄을 더한다. 사용자가 승인했고 미리보기에서 [고침]으로 먼저 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const PARTS = ['instructions', 'claude-hook', 'codex-hook', 'antigravity-hook', 'git-hook', 'lean-review', 'backlog'];
const BEGIN = '<!-- harness-starter:begin -->';
const END = '<!-- harness-starter:end -->';
const CHECK = 'harness/check.mjs';
const GUARD = 'harness/guard.mjs';
const STOP = 'harness/stop.mjs';
const LEDGER = 'harness/backlog.json';
const UNTRACKED = [LEDGER, `${LEDGER}.tmp`, 'harness/backlog.lock', 'harness/questions.html'];
const CLAUDE_COMMAND = `node "$CLAUDE_PROJECT_DIR/${CHECK}" --hook`;
const ROOT_COMMAND = `node "$(git rev-parse --show-toplevel)/${CHECK}" --hook`;
const GUARD_ROOT_COMMAND = `node "$(git rev-parse --show-toplevel)/${GUARD}" --hook`;
// 도구별 "파일을 고친 직후" 훅: 설정 파일, 편집 도구 이름, 훅 항목을 넣을 자리(공식 문서 2026-10-06).
// guard는 "도구를 쓰기 전" 훅(작업 장부를 설치할 때만). 이름은 도구마다 다르다(공식 문서와 직접 시험 2026-10-10).
// stop은 Claude Code가 멈추려 할 때 진행중 작업이 있으면 이유를 설명하게 하는 훅(작업 장부를 설치할 때만). Stop은 matcher를 받지 않는다.
// Codex: apply_patch(편집)·Bash. 읽기 전용 도구가 없어 장부 읽기는 Bash 명령 글로만 거른다. Antigravity: 편집 셋·run_command·view_file.
const HOOKS = {
  'claude-hook': {
    rel: '.claude/settings.json',
    matcher: 'Edit|Write|MultiEdit',
    command: CLAUDE_COMMAND,
    guard: { matcher: 'Read|Edit|Write|MultiEdit|Bash', command: `node "$CLAUDE_PROJECT_DIR/${GUARD}" --hook` },
    stop: `node "$CLAUDE_PROJECT_DIR/${STOP}"`,
  },
  'codex-hook': {
    rel: '.codex/hooks.json',
    matcher: 'apply_patch|Edit|Write',
    command: ROOT_COMMAND,
    guard: { matcher: 'apply_patch|Bash', command: GUARD_ROOT_COMMAND },
  },
  'antigravity-hook': {
    rel: '.agents/hooks.json',
    group: 'harness-starter',
    matcher: 'write_to_file|replace_file_content|multi_replace_file_content',
    command: ROOT_COMMAND,
    guard: { matcher: 'write_to_file|replace_file_content|multi_replace_file_content|run_command|view_file', command: GUARD_ROOT_COMMAND },
  },
};
const GIT_LINE = `node ${CHECK} --staged || exit 1`;
const GUARD_LINE = `if [ -f ${GUARD} ]; then node ${GUARD} --staged || exit 1; fi`;
const GIT_HOOK = [
  '#!/bin/sh',
  '# harness-starter: 커밋 전에 간결함 검사를 돌리고, 작업 장부가 있으면 진행중 작업을 확인한다.',
  `[ -f ${CHECK} ] || exit 0  # 하네스가 없는 브랜치에서는 건너뛴다`,
  GIT_LINE,
  GUARD_LINE,
  '',
].join('\n');
const LABEL = { create: '새로 만듦', update: '고침', same: '그대로', skip: '건너뜀' };

function template(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// 바꿀 일 하나: { rel: 대상 안 경로, action, content(쓸 내용), mode, note(알릴 말) }
function decide(rel, now, content) {
  if (now === null) return { rel, action: 'create', content };
  if (now === content) return { rel, action: 'same' };
  return { rel, action: 'update', content };
}

function planCopy(target, rel, name, overwrite = false) {
  const content = template(name);
  const now = read(path.join(target, rel));
  if (now !== null && now !== content && !overwrite) {
    return { rel, action: 'skip', note: '이미 다른 내용이 있어 그대로 둔다. 필요하면 직접 비교한다' };
  }
  return decide(rel, now, content);
}

// 업그레이드: 검사기를 새것으로 바꾸고, 옛 config.json은 옛 한도(전역 숫자와 notCode)만 빼고 kinds를 더한다.
// 사용자가 더한 규칙(patterns, ignore, 커밋 크기)은 그대로 옮긴다. 종류별 한도는 스킬 절차로 다시 정한다.
function planUpgrade(target) {
  const rel = 'harness/config.json';
  const items = [decide(CHECK, read(path.join(target, CHECK)), template('harness/check.mjs'))];
  const now = read(path.join(target, rel));
  if (now === null) return [...items, planCopy(target, rel, rel)];
  let old;
  try {
    old = JSON.parse(now);
  } catch {
    return [...items, { rel, action: 'skip', note: 'JSON으로 읽을 수 없어 그대로 둔다. 옛 한도는 직접 kinds로 옮긴다' }];
  }
  if (old.kinds) return [...items, { rel, action: 'same' }];
  const moved = { kinds: {}, ...old };
  for (const key of ['maxFileLines', 'maxLineLength', 'notCode']) delete moved[key];
  const note = '옛 한도(maxFileLines, maxLineLength, notCode)는 빼고 kinds를 더한다. 종류별 한도는 스킬 절차로 정한다';
  return [...items, { ...decide(rel, now, `${JSON.stringify(moved, null, 2)}\n`), note }];
}

// 원칙 구역: 표시 구역 안만 바꾸고, 구역 밖의 사용자 내용은 그대로 둔다.
function planBlock(target, rel) {
  const block = `${BEGIN}\n${template('agents-block.md').trimEnd()}\n${END}`;
  const now = read(path.join(target, rel));
  let content = `${block}\n`;
  if (now !== null && now.includes(BEGIN) && now.includes(END)) {
    content = now.slice(0, now.indexOf(BEGIN)) + block + now.slice(now.indexOf(END) + END.length);
  } else if (now !== null) {
    content = `${now.trimEnd()}\n\n${block}\n`;
  }
  return decide(rel, now, content);
}

// CLAUDE.md가 있으면 Claude Code는 AGENTS.md를 따로 읽지 않는다. 없으면 AGENTS.md를 불러오는 한 줄로 만들고,
// 이미 있는데 불러오지 않으면 같은 원칙 구역을 넣는다. 불러오는데 예전 구역이 남아 있으면 지운다(원칙은 한 곳에만).
function planClaudeMd(target) {
  const now = read(path.join(target, 'CLAUDE.md'));
  if (now === null) return decide('CLAUDE.md', now, '@AGENTS.md\n');
  if (!/^@AGENTS\.md\s*$/m.test(now)) return planBlock(target, 'CLAUDE.md');
  if (!now.includes(BEGIN) || !now.includes(END)) return { rel: 'CLAUDE.md', action: 'same' };
  const without = now.slice(0, now.indexOf(BEGIN)) + now.slice(now.indexOf(END) + END.length);
  return decide('CLAUDE.md', now, without.replace(/\n{3,}/g, '\n\n'));
}

// 훅 설정 파일에 "고친 직후 검사" 항목을 더한다(withBacklog면 "쓰기 전 막기"와 "멈출 때 설명" 항목도). 다른 설정은 그대로 둔다.
// Antigravity는 이름 붙인 묶음 안에 이벤트를 둔다: { "묶음 이름": { "PostToolUse": [...] } }
function planHook(target, { rel, group, matcher, command, guard, stop }, withBacklog) {
  const now = read(path.join(target, rel));
  let settings = {};
  if (now !== null) {
    try {
      settings = JSON.parse(now);
    } catch {
      return { rel, action: 'skip', note: 'JSON으로 읽을 수 없어 그대로 둔다. 훅은 직접 더한다' };
    }
  }
  const key = group ?? 'hooks';
  const events = [['PostToolUse', CHECK, matcher, command]];
  if (guard && withBacklog) events.push(['PreToolUse', GUARD, guard.matcher, guard.command]);
  if (stop && withBacklog) events.push(['Stop', STOP, undefined, stop]);
  let changed = false;
  for (const [event, marker, eventMatcher, eventCommand] of events) {
    const entries = settings[key]?.[event] ?? [];
    if (JSON.stringify(entries).includes(marker)) continue;
    const hook = { matcher: eventMatcher, hooks: [{ type: 'command', command: eventCommand }] };
    settings[key] = { ...settings[key], [event]: [...entries, hook] };
    changed = true;
  }
  return changed ? decide(rel, now, `${JSON.stringify(settings, null, 2)}\n`) : { rel, action: 'same' };
}

// git 훅과 Codex·Antigravity 훅은 저장소 맨 위에서 검사기를 찾는다. 그럴 수 없는 대상이면 이유를 돌려준다.
function rootIssue(target) {
  if (git(target, ['rev-parse', '--git-dir']) === null) return 'git 저장소가 아니다';
  if (git(target, ['rev-parse', '--show-prefix'])) return '저장소 맨 위가 아니다';
  return null;
}

// git pre-commit: 없을 때만 만든다. 다른 도구가 훅을 관리하면 한 줄을 직접 더하게 알린다.
function planGitHook(target, upgrade) {
  const line = `'${GIT_LINE}'과 '${GUARD_LINE}'`;
  const issue = rootIssue(target);
  if (issue) return { rel: 'pre-commit', action: 'skip', note: `${issue}. git 훅은 저장소 맨 위에 설치한다` };
  const hooksPath = git(target, ['config', 'core.hooksPath']);
  if (hooksPath) {
    return { rel: 'pre-commit', action: 'skip', note: `훅 폴더(${hooksPath})를 쓰는 도구의 pre-commit에 ${line}을 더한다` };
  }
  const dir = git(target, ['rev-parse', '--git-path', 'hooks']);
  const rel = path.relative(target, path.resolve(target, dir, 'pre-commit')).split(path.sep).join('/');
  const now = read(path.join(target, rel));
  if (now !== null && !now.includes(CHECK)) {
    return { rel, action: 'skip', note: `이미 있는 pre-commit 끝에 ${line}을 더한다` };
  }
  // 옛 설치의 pre-commit에는 막는 훅 줄이 없다. --upgrade는 우리가 만든(검사기 줄이 있는) pre-commit 끝에 그 줄을 더한다.
  if (upgrade && now !== null && !now.includes(GUARD)) return decide(rel, now, `${now.trimEnd()}\n${GUARD_LINE}\n`); // 이미 있는 파일이라 실행 권한은 그대로 둔다(사용자가 꺼 둔 것을 켜지 않는다)
  return { ...decide(rel, now, now ?? GIT_HOOK), mode: 0o755 };
}

// 작업 장부: 명령 파일(backlog, ledger, questions, page, patch, serve, 멈출 때 설명 훅 stop, 막는 훅 guard)을 복사하고, 장부 파일(장부, 잠금, 질문 페이지)은 git에 올리지 않게 .git/info/exclude에 더한다
// (워크트리마다 사본이 생겨 상태가 갈라지고, git add -A가 작업 브랜치에 실어 가기 때문이다). 장부는 저장소 맨 위의 harness/에 있어야 한다.
function planBacklog(target, upgrade) {
  const issue = rootIssue(target);
  if (issue) return [{ rel: 'harness/backlog.mjs', action: 'skip', note: `${issue}. 작업 장부는 저장소 맨 위에 설치한다` }];
  const excludePath = path.resolve(target, git(target, ['rev-parse', '--git-path', 'info/exclude']));
  const exclude = path.relative(target, excludePath).split(path.sep).join('/');
  const now = read(path.join(target, exclude));
  const kept = now && !now.endsWith('\n') ? `${now}\n` : (now ?? '');
  const missing = UNTRACKED.filter(line => !now?.split('\n').includes(line));
  const files = ['backlog', 'ledger', 'questions', 'page', 'patch', 'serve', 'stop'].map(name => `harness/${name}.mjs`);
  return [
    ...[...files, GUARD].map(rel => planCopy(target, rel, rel, upgrade)),
    missing.length ? decide(exclude, now, `${kept}${missing.join('\n')}\n`) : { rel: exclude, action: 'same' },
  ];
}

function plan(target, without, upgrade) {
  const wants = part => !without.includes(part);
  const items = [];
  if (wants('instructions')) items.push(planBlock(target, 'AGENTS.md'), planClaudeMd(target));
  if (['claude-hook', 'codex-hook', 'antigravity-hook', 'git-hook', 'backlog'].some(wants)) {
    if (upgrade) {
      items.push(...planUpgrade(target));
    } else {
      items.push(planCopy(target, CHECK, 'harness/check.mjs'));
      items.push(planCopy(target, 'harness/config.json', 'harness/config.json'));
    }
  }
  const issue = rootIssue(target);
  for (const [part, hook] of Object.entries(HOOKS)) {
    if (!wants(part)) continue;
    // Claude Code는 CLAUDE_PROJECT_DIR로 검사기를 찾으므로 저장소 맨 위가 아니어도 된다.
    const note = `${issue}. 이 훅은 저장소 맨 위에 설치한다`;
    items.push(issue && part !== 'claude-hook' ? { rel: hook.rel, action: 'skip', note } : planHook(target, hook, wants('backlog') && !issue));
  }
  // 제미나이 읽기 전용 역할(agy --agent readonly·research): 쓰기 도구를 모델에 넘기지 않는다. 검사기 경로가 필요 없어 저장소 맨 위가 아니어도 깐다.
  // research는 조사용이라 웹 도구를 더 받고, readonly는 검토용이라 읽기 도구만 받는다.
  if (wants('antigravity-hook')) {
    for (const role of ['readonly', 'research']) items.push(planCopy(target, `.agents/agents/${role}.md`, `antigravity/${role}.md`, upgrade));
  }
  if (wants('git-hook')) items.push(planGitHook(target, upgrade));
  // lean-review: Codex·Antigravity·OpenClaw는 .agents/skills, Claude Code는 .claude/skills에서 찾는다.
  if (wants('lean-review')) {
    for (const dir of ['.agents/skills', '.claude/skills']) {
      items.push(planCopy(target, `${dir}/lean-review/SKILL.md`, 'lean-review/SKILL.md'));
    }
  }
  if (wants('backlog')) items.push(...planBacklog(target, upgrade));
  return items;
}

const args = process.argv.slice(2);
const target = args.find(arg => !arg.startsWith('--'));
const without = (args.find(arg => arg.startsWith('--without='))?.slice('--without='.length) ?? '')
  .split(',')
  .filter(Boolean);
const unknown = without.filter(part => !PARTS.includes(part));
if (!target || !fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() || unknown.length) {
  console.error('사용법: node scripts/install.mjs <대상 폴더> [--apply] [--upgrade] [--without=' + PARTS.join(',') + ']');
  if (unknown.length) console.error('모르는 장치: ' + unknown.join(', '));
  process.exit(1);
}

const apply = args.includes('--apply');
for (const item of plan(target, without, args.includes('--upgrade'))) {
  console.log(`[${LABEL[item.action]}] ${item.rel}${item.note ? ` — ${item.note}` : ''}`);
  if (!apply || item.content === undefined) continue;
  const file = path.join(target, item.rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, item.content);
  if (item.mode) fs.chmodSync(file, item.mode);
}
console.log(apply ? '설치했습니다.' : '미리보기입니다. 쓰려면 --apply를 붙입니다.');
