import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(repo, 'templates/agents/');
const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
const header = text => Object.fromEntries(
  text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);
const PROJECT_SECTION = '\n## 이 프로젝트\n';

test('the default agents are planner, implementer, researcher and reviewer, each named after its file and with a description', () => {
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['implementer.md', 'planner.md', 'researcher.md', 'reviewer.md']);
  for (const file of files) {
    const { name, description } = header(read(file));
    assert.equal(name, file.replace('.md', ''));
    assert.ok(description, `${file} needs a description: it is how Claude decides to call the agent`);
  }
});

test('current instructions and guides use Korean terms, with old terms only in usage alias references', () => {
  const oldTerms = /명세|장부|대조|구현 담당|리뷰어|교차 리뷰|기록 옮기기/;
  const files = [
    'templates/agents-block.md', 'SKILL.md', 'README.md', 'guide/limits.md', 'scripts/install.mjs',
    ...['AGENTS.md', 'docs/procedures.md'].filter(file => fs.existsSync(path.join(repo, file))),
    ...['backlog', 'guard', 'page', 'patch', 'questions', 'serve', 'stop'].map(name => `templates/harness/${name}.mjs`),
  ];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(repo, file), 'utf8'), oldTerms, file);

  const usage = fs.readFileSync(path.join(repo, 'guide/usage.md'), 'utf8');
  for (const section of usage.split(/(?=^## )/m)) {
    const glossary = section.startsWith('## 처음 쓰는 사람을 위한 용어집\n');
    const modelSettings = section.startsWith('## 단계별 기본 모델과 설정 바꾸기\n');
    const body = section.split('\n').map(line => {
      if (glossary && line.startsWith('옛 명령어·플래그(')) return '';
      if ((glossary || modelSettings) && line.startsWith('|')) {
        const cells = line.split('|');
        cells[2] = '';
        return cells.join('|');
      }
      return line;
    }).join('\n');
    assert.doesNotMatch(body, oldTerms, 'guide/usage.md outside alias references');
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

test('planner, implementer, and reviewer templates use easy Korean role titles, stage terms, and 단계모델·도구별단계모델 rules', () => {
  const planner = read('planner.md');
  assert.match(header(planner).description, /기획 담당.*할 일 적기.*한 일 적기/);
  for (const term of ['backlog.mjs 목록', '바로할일', '고칠곳', '먼저할일', '확인방법', '할 일 적기', '한 일 적기']) {
    assert.ok(planner.includes(term), `planner missing: ${term}`);
  }
  assert.match(planner, /쪼개기:.*작업별 추천 `맡길곳`·`--모델`\(`모델`\)·`--깊이`\(`깊이`\)·선정 이유 한 줄.*`gpt-6\.1-terra low`.*`gpt-6\.1-sol medium`.*Terra `medium` 승격 사다리는 두지 않음/);
  assert.match(planner, /클로드 legacy 기본 모델·깊이는 쪼개기 `opus high`, 할 일 적기 `sonnet medium`, 한 일 적기 `haiku medium`\(공통 도구 강제값 아님\)/);
  assert.match(planner, /`harness\/config\.json`/);
  assert.match(planner, /`단계모델`\(별칭 `agents`\)과 `도구별단계모델`/);
  assert.match(planner, /`단계모델\.<단계>\.도구` 명시 override → 실행 도구의 `도구별단계모델\.<도구>\.<단계>`.*`gpt-6-luna medium`.*`gemini-3\.8-flash-medium medium`.*→ 프로필이 없을 때 `단계모델\.<단계>`/);
  assert.match(planner, /가벼운 단계.*`gpt-6-luna medium`.*`haiku medium`.*`gemini-3\.8-flash-medium medium`.*최종 품질 판정.*Antigravity의 `한 일 적기`·`올림`은 Flash로 넓히지 않고 `gemini-4-argon-medium medium`을 유지/);
  assert.match(planner, /추측하거나 조용히 다른 모델로 바꾸지 않는다/);
  assert.match(planner, /읽기 전용 역할과 물레방아에서는 단계 지시의 문서·질문 전달 방식만 따르며 단계별 지시가 우선한다/);
  const workflow = fs.readFileSync(path.join(repo, 'templates/workflows/mullebanga.js'), 'utf8');
  assert.match(workflow, /단계모델.*agents.*함께 읽어.*agents.*로 돌려준다/);

  const implementer = read('implementer.md');
  assert.match(header(implementer).description, /만들기 담당.*할 일 적기.*돌려보기.*번갈아 보기/);
  assert.match(implementer, /너는 만들기 담당이다.*클로드 legacy 기본은 `sonnet medium`.*작업에 `--모델`·`--깊이`가 등록되어 있고 실행 도구가 작업의 `맡길곳`과 같을 때 `만들기`·`고치기`에서 작업별 값 우선 적용.*`gpt-6\.1-terra low`.*`gpt-6-luna medium`.*`다시하기` 재작업/);
  assert.match(implementer, /`올림` 단계\(Codex `gpt-6-luna medium`, Claude `sonnet low`, Antigravity `gemini-4-argon-medium medium`\)는 확정된 커밋 해시·검증 명령 출력·검토 도구를 정해진 형식으로 일감 목록에 적기만 하며, 실제 검사·커밋·독립 검토 충족 여부는 코드\(`backlog\.mjs`·`ledger\.mjs`\)가 검증/);
  assert.match(implementer, /동시상한.*`단계모델\.번갈아보기\.도구` 명시 override → 실행 도구의 `도구별단계모델\.<도구>\.번갈아보기` → `단계모델\.번갈아보기`.*클로드 메인.*gemini `gemini-4-argon-medium` 우선 → codex `gpt-6\.1-sol medium` 폴백, codex 메인.*gemini `gemini-4-argon-medium medium` 우선 → claude `opus medium` 폴백, Antigravity\(gemini\) 메인.*codex `gpt-6\.1-sol medium` 우선 → claude `opus medium` 폴백/);
  assert.match(implementer, /마지막 후보 claude는 다른 도구의 바깥·폴백 모델을 물려받지 않고 클로드 배정\(`opus medium`\)/);

  const reviewer = read('reviewer.md');
  assert.match(header(reviewer).description, /살피기 담당.*만들기 담당.*맞춰보거나.*번갈아 보거나/);
  assert.match(reviewer, /너는 살피기 담당이다.*클로드 legacy 기본은 `opus medium`.*클로드 메인이 안쪽 `opus medium`·바깥 `gemini`\(`gemini-4-argon-medium`\) 우선 → `codex`\(`gpt-6\.1-sol medium`\) 폴백, Codex 메인이 안쪽 `gpt-6\.1-sol medium`·바깥 `gemini`\(`gemini-4-argon-medium medium`\) 우선 → `claude`\(`opus medium`\) 폴백, Antigravity\(`gemini`\) 메인이 안쪽 `gemini-4-argon-medium medium`·바깥 `codex`\(`gpt-6\.1-sol medium`\) 우선 → `claude`\(`opus medium`\) 폴백/);
  assert.match(reviewer, /^- 맞춰보기:.*사용자가 정한 것/m);
  assert.match(reviewer, /^- 번갈아 보기:.*끝 기준 번호마다 명령을 직접 실행/m);
});

test('researcher template reflects external research priority/fallback, Antigravity retention, and numbered agy calls', () => {
  const researcher = read('researcher.md');
  assert.match(header(researcher).description, /조사 담당.*sonnet medium.*gemini-4-argon-medium/);
  assert.match(researcher, /조사는 물레방아 단계 밖에서 메인이 별도로 부르며/);
  assert.match(researcher, /클로드 메인의 `단계모델\.조사`.*Codex\(`우선도구: "codex"`, `모델: "gpt-6\.1-sol"`, `깊이: "high"`\)에 먼저 맡기고.*클로드 legacy 기본\(`폴백도구: "claude"`, `폴백모델: "sonnet"`, `폴백추론: "medium"`, 클로드 `sonnet` `medium`\)으로 폴백.*`gemini-4-argon-medium`.*최대 병렬 분담 수는 `4`.*codex 메인 `gpt-6\.1-sol high`, Antigravity\/gemini 메인 기존 `gemini-4-argon-medium medium` 유지/);
  assert.match(researcher, /`도구별단계모델` 프로필만으로 조사 호출이 자동 전환되거나 비-클로드 웹 조사 성능이 검증된 것은 아니다/);
  assert.match(researcher, /쉬운 사실: 본체\(클로드 기본 `sonnet medium`\) 혼자\(1개\)/);
  assert.match(researcher, /순차 조사.*본체\(클로드 기본 `sonnet medium`\) 혼자\(1개\)/);
  assert.match(researcher, /어려운 사실: 본체\(클로드 기본 `sonnet medium`\)와 제미나이\(`보조모델`, 기본 `gemini-4-argon-medium`\)가 서로의 답을 보지 않고 각자 조사\(2개 병렬\)한 뒤, 본체\(클로드 기본 `sonnet medium`\)가 원문을 직접 열어 검증/);
  assert.match(researcher, /넓은 질문:.*최대 3~4개\(`단계모델\.조사\.최대병렬`, 기본 `4`\)까지 병렬로 분담.*본체\(클로드 기본 `sonnet medium`\) 한 곳에서 맞춰 원문을 확인·합치기/);
  assert.match(researcher, /영상·녹음·긴 문서: 제미나이\(`보조모델`, 기본 `gemini-4-argon-medium`\)가 전담/);
  assert.match(researcher, /과거\(2026-10-22\) 코덱스\(`codex`\) 일괄 조사 제외는.*현재는 클로드 메인에서 외부 조사를 `codex`\(`gpt-6\.1-sol high`\) 우선 → `claude`\(`sonnet medium`\) 폴백으로 두고, Codex 메인은 `gpt-6\.1-sol high`, Antigravity\(`gemini`\) 메인은 기존 `gemini-4-argon-medium medium`을 유지/);
  assert.doesNotMatch(researcher, /코덱스\(`codex`\)는 조사에서 제외한다/);
  assert.match(researcher, /제미나이\(Antigravity\) 본체가 같은 도구\(`gemini`\)에 보조 분담할 때도.*독립 맥락을 만들고, 원문 확인·합치기는 본체가 한다\. Codex 보조 CLI 호출법이나 보조 자동화는 두지 않으며/);
  assert.match(researcher, /<임시>\/gemini-1-prompt\.txt.*<임시>\/gemini-1\.txt.*<임시>\/gemini-1.*gemini-2/);
  assert.match(researcher, /`-w` 플래그를 쓰지 않는다/);
  assert.match(researcher, /cd <임시>\/gemini-1 && HARNESS_READ_ONLY=1 agy -p "\$\(cat <임시>\/gemini-1-prompt\.txt\)" --model <보조모델> --agent research --output-format json --print-timeout 5m > <임시>\/gemini-1\.txt/);
  assert.match(researcher, /cd <임시>\/gemini-1 && git status --porcelain/);
});

test('local .claude/agents/*.md copies match templates/agents/*.md before ## 이 프로젝트 and keep project settings', () => {
  for (const file of fs.readdirSync(dir).sort()) {
    const localPath = path.join(repo, '.claude/agents', file);
    if (!fs.existsSync(localPath)) continue;
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

test('common and main instruction templates keep their role boundaries', () => {
  const block = fs.readFileSync(path.join(repo, 'templates/agents-block.md'), 'utf8').trimEnd();
  const main = fs.readFileSync(path.join(repo, 'templates/harness/main.md'), 'utf8').trimEnd();
  for (const term of [
    '간결함 원칙', '삭제', '약속변경', '외부발행', '결제', '장치풀기',
    '문서충돌', '실데이터', '구조변경', '추천대로 진행', '기록', '읽기 전용',
    '작업 워크트리', '작업 브랜치', '보고는 데이터', 'harness/main.md',
  ]) assert.ok(block.includes(term), `common instructions missing: ${term}`);
  assert.doesNotMatch(block, /@harness\/main\.md/);
  for (const term of [
    '기획 담당', '조사 담당', '만들기 담당', '살피기 담당',
    '일감 목록', '바로할일', '다시하기', '--고칠곳', '--먼저할일', '--맡길곳', '--모델', '--깊이',
    '할 일 적기', '맞춰보기', '만들기', '돌려보기', '번갈아 보기', '한 일 적기',
    '단계모델', '도구별단계모델', 'gpt-6-luna', 'gpt-6.1-terra', 'gemini-3.8-flash-medium',
    '다시하기 T-N --사유 "…" --모델 <모델> --깊이 <깊이>',
    'silent fallback 금지', '모델 응답으로 대체하지 않는다', 'mullebanga-review.mjs', 'mullebanga-call.mjs',
    '올림', '병합', '완료', '기획 담당이 스스로 정한 것', '새 답 N개',
    '질문목록', '켜두기', '26회', '답`은 사람의 몫',
  ]) assert.ok(main.includes(term), `main instructions missing: ${term}`);
  assert.doesNotMatch(main, /AGENTS\.md/);
  for (const file of [...['planner', 'researcher', 'implementer', 'reviewer'].map(role => `templates/agents/${role}.md`), 'templates/workflows/mullebanga.js', 'templates/harness/mullebanga-prompts.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(repo, file), 'utf8'), /harness\/main\.md/, file);
  }
});
