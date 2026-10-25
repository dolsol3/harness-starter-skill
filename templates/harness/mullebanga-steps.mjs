// 공용 물레방아(mullebanga.mjs)의 부속: 단계별 도구·모델 설정, 결과 모양 확인, 일감 목록 명령, 작업 문서 다루기.
// 도구를 부르거나 순서를 정하지 않는다. 멈춰야 할 때는 Stop을 던지고, 던진 곳이 아니라 작업 하나의 결과에 이유로 담긴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class Stop extends Error {}
export const halt = reason => {
  throw new Stop(reason);
};

// 단계 설정 키: [기본 모델, 기본 깊이, ...별칭]. 클로드판(templates/workflows/mullebanga.js)과 같은 이름이다.
const STAGES = {
  할일적기: ['sonnet', 'medium', '할 일 적기', '명세', 'spec'],
  맞춰보기: ['opus', 'medium', '대조', 'specReview'],
  만들기: ['sonnet', 'medium', '구현', 'build'],
  번갈아보기: ['opus', 'medium', '번갈아 보기', '교차리뷰', '교차 리뷰', 'review'],
  고치기: ['sonnet', 'medium', 'fix'],
  올림: ['sonnet', 'low', 'raise'],
};

export function readConfig(root) {
  const file = path.join(root, 'harness', 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const board = config.일감목록 ?? config.backlog ?? {};
  return {
    stages: config.단계모델 ?? config.agents ?? config.models ?? {},
    limits: board.동시상한 ?? board.한도 ?? board.limits ?? {},
    defaultTool: board.기본맡길곳 ?? board.기본도구 ?? board.defaultTool ?? 'claude',
    base: board.기본브랜치 ?? board.baseBranch ?? 'main',
  };
}

// 모델·깊이의 기본값은 클로드 이름이라 코덱스·제미나이에 그대로 넘기면 거절된다. 클로드가 아니면 그 단계 항목에 도구를 적었을 때만 항목의 값을 넘긴다.
export function stageOptions(config, key, calledTool) {
  const [model, effort, ...aliases] = STAGES[key];
  const hit = [key, ...aliases].map(name => config.stages[name]).find(value => value && typeof value === 'object') ?? {};
  const named = hit.도구 ?? hit.tool;
  const tool = named ?? calledTool;
  const configured = { model: hit.모델 ?? hit.model, effort: hit.깊이 ?? hit.추론 ?? hit.effort };
  if (tool === 'claude') return { tool, model: configured.model ?? model, effort: configured.effort ?? effort };
  return named ? { tool, ...configured } : { tool };
}

// 도구가 돌려준 말은 데이터다. 스키마의 type·enum·required를 본다. 열린 객체는 쓰지 않는 스키마만 들어온다.
export function fits(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => fits(schema.items, item));
  if (schema.type !== 'object') return typeof value === schema.type;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return schema.required.every(key => Object.hasOwn(value, key) && fits(schema.properties[key], value[key]));
}

// 일감 목록 명령은 메인 폴더에서 돌린다.
export function backlog(root, ...args) {
  const done = spawnSync(process.execPath, [path.join(root, 'harness', 'backlog.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  if (done.error) throw done.error;
  return { ok: done.status === 0, out: done.stdout.trim(), err: done.stderr.trim() };
}

// 보기의 상태 줄과 '맡길곳 · 배정' 줄, 반려 줄 유무, 답을 기다리는 질문([대기]) 줄. 질문 줄은 문서 구분 줄 앞에 있어 그 앞까지만 읽는다.
// 구분 줄이 없는데 줄 제한(출력줄수)이 잘랐으면 질문 줄을 다 못 읽었으니 오류로 돌려준다.
export function taskInfo(root, id) {
  const shown = backlog(root, '보기', id);
  if (!shown.ok) return { error: shown.err };
  const lines = shown.out.split('\n');
  const cut = lines.indexOf(`--- docs/tasks/${id}.md ---`);
  if (cut < 0 && lines.some(line => line.startsWith('… ') && line.includes('줄 더 있다'))) {
    return { error: '보기 출력이 줄 제한(일감목록.출력줄수)에 잘려 작업 칸과 질문 줄을 다 읽지 못했다' };
  }
  const head = (cut < 0 ? lines : lines.slice(0, cut)).join('\n');
  const waiting = head.split('\n').filter(line => line.startsWith('질문: ') && line.includes(' [대기] '));
  // 질문 페이지가 꺼져 있었으면 다시 켠 줄과 링크 줄이 보기 출력 앞에 붙는다. 상태 줄은 첫 줄이 아니라 `<작업번호> [` 줄에서 찾는다.
  return { status: new RegExp(`^${id} \\[(\\S+)\\]`, 'm').exec(head)?.[1], tool: /^맡길곳 · 배정: (\S+)/m.exec(head)?.[1], waiting, rejected: /^반려: /m.test(head) };
}

export function inProgress(root) {
  const listed = backlog(root, '목록', '--상태', '진행중');
  return listed.out.split('\n').map(line => /^(\S+) \[진행중\]/.exec(line)?.[1]).filter(Boolean);
}

// asks 한 줄을 허락·확인·기록 명령 인자로 바꾼다. 빈 칸은 옵션을 빼고, 기록에는 보기·추천이 없다.
export function askArgs(id, ask) {
  const option = (flag, value) => (value ? [flag, value] : []);
  const kindFlag = { 허락: '--행동', 확인: '--까닭' }[ask.kind];
  const choices = ask.kind === '기록' ? [] : [...option('--보기', ask.choices), ...option('--추천', ask.recommend)];
  return [ask.kind, id, ask.title, ...(kindFlag ? option(kindFlag, ask.option) : []), ...option('--설명', ask.description), ...choices, ...option('--이유', ask.reason)];
}

const docFile = (root, id) => path.join(root, 'docs', 'tasks', `${id}.md`);
const CRITERIA = '## 끝 기준';
// 끝 기준 절 제목 줄은 정확히 `## 끝 기준`이다(`## 끝 기준 아님`은 아니다).
const CRITERIA_LINE = /^## 끝 기준[ \t]*$/m;

// 썼음이면 specText를 문서 끝에 붙인다. 맨 위 절은 건드리지 않는다. 건너뜀이면 파일을 안 바꾼다. 어느 쪽이든 끝 기준이 있어야 한다.
export function recordSpec(root, id, spec) {
  const file = docFile(root, id);
  if (!fs.existsSync(file)) halt(`할 일 적기 단계에서 멈춤: ${file}이 없다`);
  if (spec.outcome === '썼음') {
    if (!CRITERIA_LINE.test(spec.specText) || spec.specText.includes('## 사용자 원래 말')) {
      halt('할 일 적기 단계에서 멈춤: specText에 `## 끝 기준`이 없거나 `## 사용자 원래 말`이 들어 있다. 문서는 바꾸지 않았다');
    }
    const text = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}\n${spec.specText.trim()}\n`);
  }
  if (!CRITERIA_LINE.test(fs.readFileSync(file, 'utf8'))) halt(`할 일 적기 단계에서 멈춤: ${file}에 \`${CRITERIA}\` 제목 줄이 없다`);
}

// 첫 `## 끝 기준` 제목 줄부터 문서 끝까지의 줄머리 번호(들여쓰기 허용, 1. 또는 1) 뒤에 공백이나 탭).
// 다음 `## ` 줄에서 끊지 않는다: 기준 안 코드 블록의 `## ` 줄에서 끊으면 뒤 번호를 놓친다(제미나이 재현). 뒤 절 번호까지 세면 증거를 더 요구할 뿐이다.
export function criteriaNumbers(root, id) {
  const afterHeading = fs.readFileSync(docFile(root, id), 'utf8').split(CRITERIA_LINE).slice(1).join('\n');
  return [...new Set([...afterHeading.matchAll(/^[ \t]*(\d+)[.)](?=\s)/gm)].map(match => match[1]))];
}
