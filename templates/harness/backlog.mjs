#!/usr/bin/env node
// 작업 장부 명령. 장부(harness/backlog.json)는 이 명령으로만 읽고 쓴다.
//
//   node harness/backlog.mjs 추가 "제목" [--종류 기능|수정] [--영역 a,b] [--확인방법 "…"] [--선행 T-1,T-2] [--원인 "…"] [--방향 "…"]
//   node harness/backlog.mjs 목록 [--상태 할일|진행중|올림|완료]
//   node harness/backlog.mjs 다음                      지금 시작할 수 있는 첫 작업
//   node harness/backlog.mjs 준비                      지금 같이 시작해도 되는 작업(영역이 겹치지 않는 것)과 미룬 이유
//   node harness/backlog.mjs 보기 T-1                  작업 칸과 docs/tasks/T-1.md
//   node harness/backlog.mjs 시작 T-1 [추가와 같은 옵션] [--배정 도구]   비어 있는 칸을 채우며 시작한다. 도구는 config.json의 backlog.limits에 적힌 것.
//                                                      수정 작업의 영역이 최근 수정 커밋에 여러 번(patch.times, 기본 3) 들어 있는 파일과 겹치면 주의 줄을 더 보인다(막지는 않는다)
//   node harness/backlog.mjs 올림 T-1 --커밋 <해시> --증거 "…" [--검토 도구]   도구가 둘 이상이면 작성한 도구와 다른 도구의 검토가 필요하다
//   node harness/backlog.mjs 반려 T-1 --사유 "…"        올림을 진행중으로 돌려보낸다. 올릴 때 적은 커밋·증거·검토는 반려 기록으로 남고, 다시 올릴 때 새로 적는다
//   node harness/backlog.mjs 완료 T-1                  올린 커밋이 기본 브랜치에 병합됐는지 확인하고 끝낸다
//   node harness/backlog.mjs 허락 T-1 "제목" --행동 삭제|약속변경|외부발행|결제|장치풀기 --설명 "…" --보기 "이름=결과|이름=결과" --추천 이름 --이유 "…"
//                                                      허락받고 나서 할 일을 묻는다. 답을 기다리는 동안 그 작업만 시작·올림·완료를 하지 못한다
//   node harness/backlog.mjs 확인 T-1 "제목" --까닭 문서충돌|실데이터|구조변경 --설명 "…" --보기 "…" --추천 이름 --이유 "…"
//                                                      추천대로 진행하며 묻는다. 작업은 멈추지 않고, 3일 안에 답이 없으면 확정되며, 추천과 다른 답은 고칠것이 된다
//   node harness/backlog.mjs 기록 T-1 "제목" --설명 "…" --이유 "…"   허락·확인에 들지 않아 AI가 정한 일을 적어 둔다
//   node harness/backlog.mjs 질문목록 [--상태 대기|확인중|확정|고칠것|답함]   질문 보기(기본은 답을 기다리는 것)
//   node harness/backlog.mjs 답 Q-1 이름|--직접 "글" [--만든시각 …]   사람의 답을 적는다. 만든 시각이 다르면(오래된 페이지의 답) 거절한다
//   node harness/backlog.mjs 서버 [--포트 N]           질문 페이지를 열어 사람이 브라우저에서 답하게 한다. 이 터미널에서 돌고 Ctrl+C로 끈다. 이 컴퓨터에서만 열리고 주소에 저장된 토큰이 붙는다
//   node harness/backlog.mjs 켜두기 [--포트 N]         꺼져 있으면 질문 페이지를 떨어진 프로세스로 띄워 명령이 끝나도 계속 돌게 한다. 포트·토큰은 harness/serve.json에 두고 계속 쓴다
//   node harness/backlog.mjs 끄기                      켜 둔 질문 페이지를 끈다. 다시 켜도 같은 링크다
//   서버·켜두기·끄기 말고 모든 명령은 돌기 전에, 켜 둔 적 있는(harness/serve.json에 pid) 질문 페이지가 꺼져 있으면 다시 켠다.
//   끄기 뒤에는 다시 켜두기까지 켜지 않는다. 허락·확인(옛 질문)은 페이지가 켜져 있으면 끝에 링크 줄을 보인다
//   옛 이름도 같은 뜻으로 받는다: 질문(--행동 설계확인이면 확인, 그 밖의 다섯이면 허락. 옵션은 허락과 확인을 합친 것), 처리함(기록)
//
// 명령마다 쓸 수 있는 옵션이 정해져 있고 그 밖의 옵션은 거절한다. 시작은 비어 있는 칸만 채운다.
// 장부를 쓰는 명령은 잠금(harness/backlog.lock) 안에서 읽고 바꾸고 저장하고 질문 페이지(harness/questions.html)를 다시 쓴다. 읽기만 하는 명령은 잠금 없이 돈다.
// 답이 길면 config.json의 backlog.outputLines(기본 100)줄에서 자르고, 명령마다 맞는 줄이는 방법(narrow)을 알린다.
// 기본 브랜치는 backlog.baseBranch(기본 main, 로컬 브랜치)다. 오류는 표준 오류로 알리고 종료 코드 1로 끝난다.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as ledger from './ledger.mjs';
import * as questions from './questions.mjs';
import * as page from './page.mjs';
import * as patch from './patch.mjs';
import * as serve from './serve.mjs';

const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('config.json', import.meta.url)), 'utf8'));
const { outputLines = 100, baseBranch = 'main', limits, defaultTool } = config.backlog ?? {};

const list = text => text?.split(',').map(item => item.trim()).filter(Boolean);

// 옵션에서 작업 칸으로: 영역과 선행은 쉼표로 나눈 목록이다.
function fields({ 종류, 영역, 확인방법, 선행, 원인, 방향, 배정 }) {
  return { 종류, 영역: list(영역), 확인방법, 선행: list(선행), 원인, 방향, 배정 };
}

const summary = task => `${task.번호} [${task.상태}] ${task.종류} ${task.제목}`;

const readyRow = ({ task, blocks }) =>
  [summary(task), `영역: ${task.영역.join(', ')}`, ...(blocks ? [`막는 작업 ${blocks}개`] : [])].join('  ');

const questionLine = item =>
  `${item.번호} [${questions.shownState(item)}] ${item.작업} ${item.행동}${item.까닭 ? `(${item.까닭})` : ''} ${item.제목}  ${item.답 ? `→ ${item.답}` : `(추천: ${item.추천})`}`;

// 옛 이름 질문으로 불러도 실제로 된 종류를 첫머리에 보인다.
const asked = item => ({ rows: [`${item.행동 === '설계확인' ? '확인' : '허락'}: ${questionLine(item)}`] });

const recorded = ({ ledger: book, args: [id, title], values }) => {
  const item = questions.record(book, id, title, values);
  return { rows: [`기록: ${item.작업} ${item.제목}`] };
};

function detail(root, book, task) {
  const rows = [summary(task)];
  for (const name of ['영역', '선행']) if (task[name].length) rows.push(`${name}: ${task[name].join(', ')}`);
  for (const name of ['확인방법', '원인', '방향', '배정', '커밋', '증거', '검토']) if (task[name]) rows.push(`${name}: ${task[name]}`);
  rows.push(...(task.반려 ?? []).map(item => `반려: ${item.커밋.slice(0, 7)} ${item.사유}`));
  rows.push(...book.질문.filter(item => item.작업 === task.번호).map(item => `질문: ${questionLine(item)}`));
  const doc = path.join(root, 'docs/tasks', `${task.번호}.md`);
  if (fs.existsSync(doc)) rows.push(`--- docs/tasks/${task.번호}.md ---`, ...fs.readFileSync(doc, 'utf8').trimEnd().split('\n'));
  return rows;
}

// 각 명령: 쓸 수 있는 옵션과, 화면에 보일 줄을 돌려주는 함수. 장부를 쓰는 명령은 writes: true로 표시한다.
// 상태·커밋·증거는 전용 명령(시작·올림·반려·완료)의 옵션으로만 바뀐다.
const commands = {
  추가: {
    writes: true,
    options: ['종류', '영역', '확인방법', '선행', '원인', '방향'],
    run: ({ ledger: book, args: [title], values }) => ({ rows: [`추가: ${summary(ledger.add(book, title, fields(values)))}`] }),
  },
  목록: {
    options: ['상태'],
    narrow: '--상태로 조건을 좁힌다',
    run: ({ ledger: book, values }) => {
      const tasks = book.작업.filter(task => !values.상태 || task.상태 === values.상태);
      return { rows: tasks.length ? tasks.map(summary) : ['작업이 없다'] };
    },
  },
  다음: {
    options: [],
    run: ({ ledger: book }) => {
      const task = ledger.next(book);
      return { rows: [task ? summary(task) : '시작할 수 있는 작업이 없다'] };
    },
  },
  준비: {
    options: [],
    run: ({ ledger: book }) => {
      const { group, deferred } = ledger.ready(book);
      const rows = group.length ? ['같이 시작해도 되는 작업:', ...group.map(readyRow)] : ['시작할 수 있는 작업이 없다'];
      if (deferred.length) rows.push('미룬 작업:', ...deferred.map(({ task, reason }) => `${task.번호} ${reason}`));
      return { rows };
    },
  },
  보기: { options: [], narrow: 'docs/tasks/ 아래의 작업 문서를 직접 읽는다', run: ({ root, ledger: book, args: [id] }) => ({ rows: detail(root, book, ledger.find(book, id)) }) },
  시작: {
    writes: true,
    options: ['영역', '확인방법', '원인', '방향', '배정'],
    run: ({ root, ledger: book, args: [id], values }) => {
      const task = ledger.start(book, id, fields(values), { limits, defaultTool });
      if (task.종류 !== '수정') return { rows: [`시작: ${summary(task)}`] };
      const patched = patch.signals(root);
      return { rows: [`시작: ${summary(task)}`, ...patch.warn(patched, task.영역)], patched };
    },
  },
  올림: {
    writes: true,
    options: ['커밋', '증거', '검토'],
    run: ({ ledger: book, args: [id], values }) => ({ rows: [`올림: ${summary(ledger.submit(book, id, values, { limits }))}`] }),
  },
  반려: {
    writes: true,
    options: ['사유'],
    run: ({ ledger: book, args: [id], values }) => ({ rows: [`반려: ${summary(ledger.reject(book, id, values.사유))}`] }),
  },
  완료: {
    writes: true,
    options: [],
    run: ({ ledger: book, args: [id] }) => ({ rows: [`완료: ${summary(ledger.finish(book, id, baseBranch))}`] }),
  },
  허락: {
    writes: true,
    options: ['행동', '설명', '보기', '추천', '이유'],
    links: true,
    run: ({ ledger: book, args: [id, title], values }) => asked(questions.permit(book, id, title, values)),
  },
  확인: {
    writes: true,
    options: ['까닭', '설명', '보기', '추천', '이유'],
    links: true,
    run: ({ ledger: book, args: [id, title], values }) => asked(questions.confirm(book, id, title, values)),
  },
  기록: { writes: true, options: ['설명', '이유'], run: recorded },
  질문목록: {
    options: ['상태'],
    run: ({ ledger: book, values }) => {
      const state = values.상태 || '대기';
      const items = book.질문.filter(item => questions.shownState(item) === state);
      return { rows: items.length ? items.map(questionLine) : [`${state} 질문이 없다`] };
    },
  },
  답: {
    writes: true,
    options: ['직접', '만든시각'],
    run: ({ ledger: book, args: [id, choice], values }) => ({ rows: [`답: ${questionLine(questions.answer(book, id, { 선택: choice, ...values }))}`] }),
  },
  서버: {
    serves: true,
    options: ['포트'],
    run: ({ root, values }) => {
      serve.start(root, values.포트);
      return { rows: [] };
    },
  },
  질문: {
    writes: true,
    options: ['행동', '까닭', '설명', '보기', '추천', '이유'],
    links: true,
    run: ({ ledger: book, args: [id, title], values }) => asked(questions.ask(book, id, title, values)),
  },
  처리함: { writes: true, options: ['설명', '이유'], run: recorded },
  // 켜두기·끄기는 서버가 답할 때까지 기다리므로 줄을 약속(Promise)으로 돌려준다. 장부는 쓰지 않는다.
  // 서버·켜두기·끄기(serves)는 스스로 켜고 끄므로 다시 켜기를 하지 않는다. 서버는 앞에서 열 포트를 떨어진 서버가 먼저 잡으면 안 된다.
  켜두기: { serves: true, options: ['포트'], run: ({ root, values }) => ({ rows: serve.keep(root, values.포트) }) },
  끄기: { serves: true, options: [], run: ({ root }) => ({ rows: serve.stop(root) }) },
};
const OPTIONS = Object.fromEntries(
  [...new Set(Object.values(commands).flatMap(command => command.options))].map(name => [name, { type: 'string' }]),
);

// 페이지를 못 켠 것 때문에 장부 일이 막히지 않게, 실패는 표준 오류로 알리고 명령은 그대로 돈다.
async function revivePage(root) {
  try {
    const rows = await serve.revive(root);
    if (rows.length) console.log(rows.join('\n'));
  } catch (error) {
    console.error(`backlog: 질문 페이지를 다시 켜지 못했다(${error.message})`);
  }
}

async function run() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: OPTIONS });
  const [name, ...args] = positionals.map(text => text.trim());
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`명령: ${Object.keys(commands).join(', ')} (사용법은 이 파일 맨 위 설명)`);
  const stray = Object.keys(values).filter(option => !command.options.includes(option));
  if (stray.length) {
    const usable = command.options.map(option => `--${option}`).join(' ') || '없음';
    throw new Error(`${name} 거절: ${stray.map(option => `--${option}`).join(' ')}은(는) 이 명령에서 쓰지 않는다. 쓸 수 있는 옵션: ${usable}`);
  }
  const trimmed = Object.fromEntries(Object.entries(values).map(([option, text]) => [option, text.trim()]));
  patch.check();
  const root = ledger.mainRoot();
  if (!command.serves) await revivePage(root);
  const execute = () => {
    const book = ledger.load(root);
    const { rows: shown, patched } = command.run({ root, ledger: book, args, values: trimmed });
    if (command.writes) {
      ledger.save(root, book);
      page.write(root, book, patched);
    }
    return shown;
  };
  const rows = await (command.writes ? ledger.withLock(root, execute) : execute());
  if (rows.length) console.log(rows.slice(0, outputLines).join('\n'));
  if (rows.length > outputLines) console.log(`… ${rows.length - outputLines}줄 더 있다${command.narrow ? `. ${command.narrow}` : ''}`);
  // 링크 줄은 줄 제한 뒤에 찍어, 출력이 잘려도 허락·확인의 마지막 줄이 링크다.
  const links = command.links ? await serve.pageLine(root) : [];
  if (links.length) console.log(links.join('\n'));
}

run().catch(error => {
  console.error(`backlog: ${error.message}`);
  process.exitCode = 1;
});
