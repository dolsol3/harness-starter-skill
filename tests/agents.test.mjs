import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(repo, 'templates/agents/');
const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
const header = text => Object.fromEntries(
  text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);
const PROJECT_SECTION = '\n## 이 프로젝트\n';

function mainRepoDir() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim();
    return path.dirname(common);
  } catch {
    return repo;
  }
}

test('the default agents are planner, implementer, researcher and reviewer, each named after its file and with a description', () => {
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['implementer.md', 'planner.md', 'researcher.md', 'reviewer.md']);
  for (const file of files) {
    const { name, description } = header(read(file));
    assert.equal(name, file.replace('.md', ''));
    assert.ok(description, `${file} needs a description: it is how Claude decides to call the agent`);
  }
});

test('the reviewer may only read: an allowlist with no editing, MCP or Agent tool (omitting tools would inherit them all)', () => {
  const { tools, disallowedTools } = header(read('reviewer.md'));
  assert.deepEqual(tools.split(',').map(tool => tool.trim()), ['Read', 'Grep', 'Glob', 'Bash']);
  assert.equal(disallowedTools, undefined);
});

test('the researcher may only read and search the web: an allowlist with no editing, MCP or Agent tool', () => {
  const { tools, disallowedTools } = header(read('researcher.md'));
  assert.deepEqual(tools.split(',').map(tool => tool.trim()), ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch']);
  assert.equal(disallowedTools, undefined);
});

test('the implementer works in its own worktree, so parallel implementers do not share a working folder', () => {
  assert.equal(header(read('implementer.md')).isolation, 'worktree');
});

test('every agent has a 이 프로젝트 section for the skill to fill, so the project facts are not baked into the template', () => {
  for (const file of fs.readdirSync(dir)) assert.match(read(file), /^## 이 프로젝트\n- .+<.+>/m, file);
});

test('planner, implementer, and reviewer templates use easy Korean role titles, stage terms, and 단계모델 model rules', () => {
  const planner = read('planner.md');
  assert.match(header(planner).description, /기획 담당.*할 일 적기.*한 일 적기/);
  for (const term of ['일감 목록(장부)', '바로할일', '고칠곳(영역', '먼저할일(선행', '할 일 적기 (명세 쓰기)', '한 일 적기 (기록 옮기기)', '만들기 담당(구현 담당)', '살피기 담당']) {
    assert.ok(planner.includes(term), `planner missing: ${term}`);
  }
  assert.match(planner, /1\. \*\*쪼개기\*\*.*opus.*high.*단계모델\.쪼개기/);
  assert.match(planner, /2\. \*\*할 일 적기 \(명세 쓰기\)\*\*.*sonnet.*high.*단계모델\.할일적기/);
  assert.match(planner, /3\. \*\*한 일 적기 \(기록 옮기기\)\*\*.*haiku.*medium.*단계모델\.한일적기/);
  assert.match(planner, /## 물레방아 안에서[\s\S]*`harness\/config\.json`에 `단계모델`\(또는 `agents`\)이 있으면 함께 읽어 응답의 `agents` 칸으로 돌려준다/);

  const implementer = read('implementer.md');
  assert.match(header(implementer).description, /만들기 담당\(구현 담당\).*할 일 적기\(명세\).*돌려보기\(검사\).*번갈아 보기\(교차 리뷰\)/);
  assert.match(implementer, /너는 만들기 담당\(옛 구현 담당\)이다.*`sonnet` `high`.*`단계모델\.만들기`·`단계모델\.고치기`/);
  assert.match(implementer, /`일감목록\.동시상한`\(`backlog\.limits`\)[\s\S]*`단계모델\.번갈아보기`.*`codex`.*`gemini`.*`gemini-4-argon-high`/);

  const reviewer = read('reviewer.md');
  assert.match(header(reviewer).description, /살피기 담당\(리뷰어\).*만들기 담당\(구현 담당\).*맞춰보거나.*번갈아 보거나/);
  assert.match(reviewer, /너는 살피기 담당\(옛 리뷰어\)이다.*`opus` `high`.*`단계모델\.맞춰보기`·`단계모델\.번갈아보기`/);
  assert.match(reviewer, /^## 맞춰보기 · 명세 대조 \(할 일 적기 뒤, 만들기 전\)/m);
  assert.match(reviewer, /^## 번갈아 보기 · 구현 검사 \(돌려보기 뒤, 올림 전\)/m);
});

test('researcher template reflects the sonnet high + gemini-4-argon-high table, excludes codex, and documents numbered agy calls', () => {
  const researcher = read('researcher.md');
  assert.match(header(researcher).description, /조사 담당.*sonnet high.*gemini-4-argon-high/);
  assert.match(researcher, /클로드 `sonnet` `high`.*`gemini-4-argon-high`.*최대 병렬 분담 수는 `4`.*`단계모델\.조사`.*`모델`.*`깊이`.*`보조모델`.*`최대병렬`/);
  assert.match(researcher, /쉬운 사실: 본체\(`sonnet high`\) 혼자\(1개\)/);
  assert.match(researcher, /순차 조사.*본체\(`sonnet high`\) 혼자\(1개\)/);
  assert.match(researcher, /어려운 사실: 본체\(`sonnet high`\)와 제미나이\(`보조모델`, 기본 `gemini-4-argon-high`\)가 서로의 답을 보지 않고 각자 조사\(2개 병렬\)한 뒤, 본체\(`sonnet high`\)가 원문을 직접 열어 검증/);
  assert.match(researcher, /넓은 질문:.*최대 3~4개\(`단계모델\.조사\.최대병렬`, 기본 `4`\)까지 병렬로 분담.*본체\(`sonnet high`\) 한 곳에서 맞춰 원문을 확인·합치기/);
  assert.match(researcher, /영상·녹음·긴 문서: 제미나이\(`보조모델`, 기본 `gemini-4-argon-high`\)가 전담/);
  assert.match(researcher, /코덱스\(`codex`\)는 조사에서 제외/);
  assert.match(researcher, /<임시>\/gemini-1-prompt\.txt.*<임시>\/gemini-1\.txt.*<임시>\/gemini-1.*gemini-2/);
  assert.match(researcher, /`-w` 플래그를 쓰지 않는다/);
  assert.match(researcher, /cd <임시>\/gemini-1 && HARNESS_READ_ONLY=1 agy -p "\$\(cat <임시>\/gemini-1-prompt\.txt\)" --model <보조모델> --agent research --output-format json --print-timeout 5m > <임시>\/gemini-1\.txt/);
  assert.match(researcher, /cd <임시>\/gemini-1 && git status --porcelain/);
});

test('local .claude/agents/*.md copies match templates/agents/*.md before ## 이 프로젝트 and keep project settings', () => {
  const roots = [repo, mainRepoDir()];
  for (const file of fs.readdirSync(dir).sort()) {
    const localPath = roots.map(root => path.join(root, '.claude/agents', file)).find(candidate => fs.existsSync(candidate));
    if (!localPath) continue;
    const tmpl = read(file);
    const local = fs.readFileSync(localPath, 'utf8');
    assert.equal(
      local.slice(0, local.indexOf(PROJECT_SECTION)),
      tmpl.slice(0, tmpl.indexOf(PROJECT_SECTION)),
      `${file} body before ## 이 프로젝트 must match template`,
    );
    const tail = local.slice(local.indexOf(PROJECT_SECTION));
    assert.doesNotMatch(tail, /<.+>/, `${file} local copy should have concrete project settings`);
  }
});

test('templates/agents-block.md and AGENTS.md block match byte-for-byte and include Korean role titles, terms, and 단계모델 rules', () => {
  const block = fs.readFileSync(path.join(repo, 'templates/agents-block.md'), 'utf8').trimEnd();
  const agentsPath = path.join(repo, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const agentsMd = fs.readFileSync(agentsPath, 'utf8');
    const begin = '<!-- harness-starter:begin -->\n';
    const end = '\n<!-- harness-starter:end -->';
    assert.ok(agentsMd.includes(begin) && agentsMd.includes(end), 'AGENTS.md must have harness-starter markers');
    const extracted = agentsMd.slice(agentsMd.indexOf(begin) + begin.length, agentsMd.indexOf(end));
    assert.equal(extracted, block);
  }

  for (const term of [
    '기획 담당', '조사 담당', '만들기 담당', '살피기 담당',
    '일감 목록', '바로할일', '다시하기', '--고칠곳', '--먼저할일', '--맡길곳',
    '할 일 적기', '맞춰보기', '만들기', '돌려보기', '번갈아 보기', '한 일 적기',
    '단계모델', 'gemini-4-argon-high',
  ]) {
    assert.ok(block.includes(term), `agents-block.md missing: ${term}`);
  }
});
