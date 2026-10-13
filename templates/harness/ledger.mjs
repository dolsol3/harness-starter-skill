// 작업 장부: 읽기·쓰기와 상태 규칙. 명령줄은 backlog.mjs가 맡는다.
//
// 장부는 메인 폴더의 harness/backlog.json 하나다. git에는 올리지 않는다(워크트리마다 사본이 생겨 상태가 갈라지므로).
// 워크트리 안에서 불러도 git의 공용 .git 폴더(--git-common-dir)의 부모, 곧 메인 폴더를 찾아 같은 장부를 쓴다.
// git 명령은 부른 폴더에서 돌린다. 워크트리에서 HEAD를 말하면 그 워크트리의 HEAD다.
// 상태는 할일 → 진행중 → 올림 → 완료로 간다. 올림은 반려로 진행중에 돌아올 수 있다. 필드 이름과 값은 화면에 그대로 보이므로 한글로 둔다.
// 장부를 쓰는 명령은 withLock 안에서 읽기→바꾸기→저장을 한다. 저장은 임시 파일에 쓴 뒤 바꿔치기해서 읽는 쪽이 반쯤 쓴 장부를 보지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const 종류 = ['기능', '수정'];
const 채울수있는칸 = ['영역', '확인방법', '원인', '방향'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// git이 성공하면 true, 종료 코드가 0이 아니면 false. git을 못 돌리는 경우는 그대로 오류로 올린다.
function gitSucceeds(args) {
  try {
    git(args);
    return true;
  } catch (error) {
    if (typeof error.status === 'number') return false;
    throw error;
  }
}

// 메인 폴더: 공용 .git 폴더의 부모. 저장소가 아니면 git의 오류가 그대로 올라온다.
// .git 폴더가 따로 있거나(--separate-git-dir) 서브모듈이거나 bare면 그 부모는 작업 폴더가 아니라서 엉뚱한 곳에 쓰지 않고 거절한다.
export function mainRoot() {
  const common = path.resolve(git(['rev-parse', '--git-common-dir']));
  if (path.basename(common) !== '.git') {
    throw new Error('작업 폴더 안에 .git 폴더가 있는 일반 저장소에서만 쓴다(분리된 .git 폴더, 서브모듈, bare 저장소는 지원하지 않는다)');
  }
  return path.dirname(common);
}

const ledgerFile = root => path.join(root, 'harness/backlog.json');

// 질문과 처리함은 4단계에서 생겼다. 옛 장부에 없으면 빈 목록으로 읽는다.
const empty = () => ({ 다음번호: 1, 작업: [], 다음질문번호: 1, 질문: [], 처리함: [] });

export function load(root) {
  const file = ledgerFile(root);
  if (!fs.existsSync(file)) return empty();
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    throw new Error(`harness/backlog.json을 읽을 수 없다(${error.message}). 사람이 고치거나 지운다`);
  }
}

export function save(root, ledger) {
  const file = ledgerFile(root);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const LOCK_WAIT_MS = 5000;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 쓰는 동안 다른 명령이 끼어들지 못하게 harness/backlog.lock을 독점해서 만든다. 이미 있으면 기다리고 끝내 못 잡으면 거절한다.
// 명령이 죽어 파일이 남아도 자동으로 지우지 않는다(남이 쓰는 중인 잠금과 구별할 수 없다). 쓰는 명령이 없는데 남아 있으면 사람이 지운다.
export function withLock(root, work) {
  const file = path.join(root, 'harness/backlog.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const giveUp = Date.now() + LOCK_WAIT_MS;
  let handle;
  while (handle === undefined) {
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= giveUp) {
        throw new Error('다른 명령이 장부를 쓰는 중이다(harness/backlog.lock). 잠시 뒤 다시 한다. 쓰는 명령이 없는데 이 파일이 남아 있으면 사람이 지운다');
      }
      sleep(50);
    }
  }
  try {
    return work();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(file);
  }
}

export function find(ledger, id) {
  const task = ledger.작업.find(item => item.번호 === id);
  if (!task) throw new Error(`${id ?? '번호'}: 그런 작업이 없다. backlog 목록으로 번호를 본다`);
  return task;
}

// 추가할 때만 쓴다: 옵션으로 받은 칸을 작업에 적는다(받지 않은 칸과 빈 목록은 건너뛴다).
function fill(task, fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) task[name] = value;
  }
}

export function add(ledger, title, fields) {
  if (!title) throw new Error('추가 거절: 제목이 없다. backlog 추가 "제목"');
  const task = { 번호: `T-${ledger.다음번호}`, 제목: title, 종류: '기능', 상태: '할일', 영역: [], 확인방법: '', 선행: [] };
  fill(task, fields);
  if (!종류.includes(task.종류)) throw new Error(`추가 거절: 종류는 ${종류.join(' 또는 ')}이다`);
  for (const dep of task.선행) find(ledger, dep);
  ledger.다음번호 += 1;
  ledger.작업.push(task);
  return task;
}

const done = (ledger, id) => find(ledger, id).상태 === '완료';
const blockedBy = (ledger, task) => task.선행.filter(dep => !done(ledger, dep));

// 사람의 답을 기다리는 질문. 있는 작업은 시작·올림·완료를 하지 못하고 준비·다음에서 빠진다. 다른 작업은 계속한다.
export const openQuestions = (ledger, id) => ledger.질문.filter(item => item.작업 === id && item.상태 === '대기');
const numbers = items => items.map(item => item.번호).join(', ');

function noOpenQuestion(ledger, task, what) {
  const asking = openQuestions(ledger, task.번호);
  if (asking.length) throw new Error(`${task.번호} ${what} 거절: 답을 기다리는 질문 ${numbers(asking)}이(가) 있다. 다른 작업을 하고 사람이 답한 뒤에 다시 한다`);
}

// 도구 이름은 harness/config.json의 backlog.limits에 적힌 것만 쓴다. limits가 없으면 어떤 도구도 쓸 수 없다.
function checkTool(tool, limits, id, what) {
  if (Object.hasOwn(limits ?? {}, tool)) return;
  const names = Object.keys(limits ?? {}).join(', ') || '아직 없다';
  throw new Error(`${id} ${what} 거절: ${tool}은(는) 쓸 수 있는 도구가 아니다. harness/config.json의 backlog.limits에 적힌 도구만 쓴다(${names})`);
}

// 구현을 맡길 도구를 적는다. --배정이 없으면 backlog.defaultTool을 쓴다. limits를 적지 않은 프로젝트는 이 규칙이 꺼져 있다.
// 그 도구의 진행중 작업이 상한에 차면 거절한다. 올림이 된 작업은 세지 않는다.
function assign(ledger, task, requested, { limits, defaultTool }) {
  if (!limits && !requested) return;
  const tool = requested || defaultTool;
  if (!tool) throw new Error(`${task.번호} 시작 거절: 배정할 도구가 없다. --배정 ${Object.keys(limits).join('|')}로 정하거나 config.json에 backlog.defaultTool을 적는다`);
  if (!requested && !Object.hasOwn(limits, tool)) {
    throw new Error(`${task.번호} 시작 거절: harness/config.json의 backlog.defaultTool(${tool})이(가) backlog.limits에 없다. 사람이 고친다`);
  }
  checkTool(tool, limits, task.번호, '시작');
  if (!Number.isInteger(limits[tool]) || limits[tool] < 0) {
    throw new Error(`${task.번호} 시작 거절: harness/config.json의 backlog.limits.${tool}은(는) 0 이상의 정수여야 한다(지금 ${JSON.stringify(limits[tool])})`);
  }
  const running = ledger.작업.filter(item => item.상태 === '진행중' && item.배정 === tool).length;
  if (running >= limits[tool]) {
    throw new Error(`${task.번호} 시작 거절: ${tool}은(는) 동시에 ${limits[tool]}개까지다(지금 진행중 ${running}개). 하나가 올림이 된 뒤에 시작한다`);
  }
  task.배정 = tool;
}

// 도구가 둘 이상이면 작성한 도구와 다른 도구가 검토했다고 적어야 올린다. 도구가 하나뿐이면 적지 않아도 된다.
function review(task, tool, limits) {
  if (tool) checkTool(tool, limits, task.번호, '올림');
  const names = Object.keys(limits ?? {});
  if (names.length > 1) {
    const author = task.배정 ? `작성한 도구(${task.배정})` : '작성한 도구';
    const others = names.filter(name => name !== task.배정);
    if (!tool) throw new Error(`${task.번호} 올림 거절: --검토가 필요하다. ${author}가 아닌 도구(${others.join(', ')})가 검토한 뒤 적는다`);
    if (tool === task.배정) throw new Error(`${task.번호} 올림 거절: ${author}가 직접 검토할 수 없다. 다른 도구가 검토한다`);
  }
  if (tool) task.검토 = tool;
}

// 시작하려면 건드리는 곳과 끝을 확인하는 방법이 있어야 한다. 수정 작업은 원인과 고칠 방향도 있어야 한다.
// 옵션은 비어 있는 칸만 채운다. 종류와 선행은 추가할 때 정한 그대로다. 거절하면 장부는 저장되지 않는다.
// 구현을 맡을 도구(배정)는 backlog.limits를 적은 프로젝트에서만 정한다.
export function start(ledger, id, fields, tools) {
  const task = find(ledger, id);
  if (task.상태 !== '할일') throw new Error(`${id} 시작 거절: 이미 ${task.상태}이다`);
  noOpenQuestion(ledger, task, '시작');
  for (const name of 채울수있는칸) if (!task[name]?.length && fields[name]?.length) task[name] = fields[name];
  const needed = ['영역', '확인방법', ...(task.종류 === '수정' ? ['원인', '방향'] : [])];
  const missing = needed.filter(name => !task[name]?.length);
  if (missing.length) {
    throw new Error(`${id} 시작 거절: ${missing.join(', ')}이(가) 비어 있다. ${missing.map(name => `--${name}`).join(' ')}로 채운다`);
  }
  const blocked = blockedBy(ledger, task);
  if (blocked.length) throw new Error(`${id} 시작 거절: 선행 작업 ${blocked.join(', ')}이(가) 완료되지 않았다`);
  assign(ledger, task, fields.배정, tools);
  task.상태 = '진행중';
  return task;
}

// 올리려면 브랜치에 올린 커밋과 확인한 증거가 있어야 한다. 커밋은 저장소에서 찾아 전체 해시로 적는다.
export function submit(ledger, id, { 커밋, 증거, 검토 }, { limits }) {
  const task = find(ledger, id);
  if (task.상태 !== '진행중') throw new Error(`${id} 올림 거절: 진행중인 작업만 올린다(지금 ${task.상태})`);
  noOpenQuestion(ledger, task, '올림');
  if (!커밋 || !증거) throw new Error(`${id} 올림 거절: --커밋과 --증거가 필요하다`);
  review(task, 검토, limits);
  if (!gitSucceeds(['rev-parse', '--verify', '--quiet', `${커밋}^{commit}`])) {
    throw new Error(`${id} 올림 거절: 커밋 ${커밋}을(를) 저장소에서 찾을 수 없다`);
  }
  Object.assign(task, { 상태: '올림', 커밋: git(['rev-parse', `${커밋}^{commit}`]), 증거 });
  return task;
}

// 올림을 진행중으로 돌려보낸다. 올릴 때 적힌 커밋·증거·검토는 작업에서 빼서 반려 목록에 사유와 함께 쌓는다. 그래야 다시 올릴 때 새로 적는다.
// 이미 시작했던 작업이 돌아오는 것이라 도구별 동시 상한은 보지 않는다. 답을 기다리는 질문이 있어도 돌려보낼 수 있다.
export function reject(ledger, id, 사유) {
  const task = find(ledger, id);
  if (task.상태 !== '올림') throw new Error(`${id} 반려 거절: 올림 상태만 돌려보낸다(지금 ${task.상태})`);
  if (!사유) throw new Error(`${id} 반려 거절: --사유가 필요하다`);
  const { 커밋, 증거, 검토 } = task;
  task.반려 = [...(task.반려 ?? []), { 커밋, 증거, ...(검토 ? { 검토 } : {}), 사유 }];
  for (const name of ['커밋', '증거', '검토']) delete task[name];
  task.상태 = '진행중';
  return task;
}

// 끝내려면 올린 커밋이 기본 브랜치에 들어가 있어야 한다. 병합은 하지 않고 git으로 확인만 한다.
// 같은 이름의 태그가 브랜치를 가리지 못하게 refs/heads/로 정확히 가리킨다.
export function finish(ledger, id, baseBranch) {
  const task = find(ledger, id);
  const base = `refs/heads/${baseBranch}`;
  if (task.상태 !== '올림') throw new Error(`${id} 완료 거절: 올림 상태만 끝낸다(지금 ${task.상태})`);
  noOpenQuestion(ledger, task, '완료');
  if (!gitSucceeds(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) {
    throw new Error(`${id} 완료 거절: 기본 브랜치 ${baseBranch}을(를) 찾을 수 없다. 사람에게 harness/config.json의 backlog.baseBranch를 고치게 한다`);
  }
  if (!gitSucceeds(['merge-base', '--is-ancestor', task.커밋, base])) {
    throw new Error(`${id} 완료 거절: 커밋 ${task.커밋.slice(0, 7)}이(가) ${baseBranch}에 병합되지 않았다`);
  }
  task.상태 = '완료';
  return task;
}

// 지금 시작할 수 있는 첫 작업: 할일이고 선행 작업이 모두 완료되었고 답을 기다리는 질문이 없는 것.
export function next(ledger) {
  return ledger.작업.find(task => task.상태 === '할일' && blockedBy(ledger, task).length === 0 && !openQuestions(ledger, task.번호).length);
}

// 영역 둘이 겹치는가: 같거나 한쪽이 다른 쪽 폴더 안이다. 끝의 /, /*, /**는 보지 않는다. 가운데 와일드카드는 풀지 않는다.
const folder = area => area.replace(/\/\*{0,2}$/, '');
export function overlaps(a, b) {
  const [x, y] = [folder(a), folder(b)];
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// 지금 같이 시작해도 되는 작업. 후보는 할일이고 선행이 모두 완료이며 답을 기다리는 질문이 없는 것이다. 다른 작업을 더 많이 막고 있는 것부터 보고,
// 영역이 비었거나 이미 쓰는 곳(진행중·올림 작업, 앞서 고른 작업)과 겹치면 미룬다. 올림은 아직 병합 전이라 같은 곳을 건드리면 충돌한다.
export function ready(ledger) {
  const waiting = ledger.작업.filter(task => task.상태 === '할일');
  const taken = ledger.작업
    .filter(task => task.상태 === '진행중' || task.상태 === '올림')
    .flatMap(task => task.영역.map(area => ({ area, owner: `${task.번호}(${task.상태})` })));
  const blocks = task => ledger.작업.filter(other => other.선행.includes(task.번호)).length;
  const group = [];
  const deferred = [];
  const startable = [];
  for (const task of waiting) {
    const blocked = blockedBy(ledger, task);
    const asking = openQuestions(ledger, task.번호);
    if (blocked.length) deferred.push({ task, reason: `선행 작업 ${blocked.join(', ')}이(가) 완료되지 않았다` });
    else if (asking.length) deferred.push({ task, reason: `답을 기다리는 질문 ${numbers(asking)}이(가) 있다` });
    else startable.push(task);
  }
  for (const task of startable.sort((a, b) => blocks(b) - blocks(a))) {
    const clash = task.영역.map(area => taken.find(item => overlaps(area, item.area))).find(Boolean);
    if (!task.영역.length) deferred.push({ task, reason: '영역이 비어 있다' });
    else if (clash) deferred.push({ task, reason: `영역이 겹친다 (${clash.owner}의 ${clash.area})` });
    else {
      group.push({ task, blocks: blocks(task) });
      taken.push(...task.영역.map(area => ({ area, owner: task.번호 })));
    }
  }
  deferred.sort((a, b) => waiting.indexOf(a.task) - waiting.indexOf(b.task));
  return { group, deferred };
}
