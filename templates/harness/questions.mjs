// 사람에게 넘기는 세 갈래. 허락은 답이 올 때까지 그 작업만 멈추고, 확인은 진행하며 묻고, 기록은 AI가 정한 일을 적어만 둔다.
// 허락·확인은 장부의 질문 목록에, 기록은 처리함 목록에 남는다.
// 상태 규칙(답을 기다리는 작업 막기)은 ledger.mjs가, 명령줄은 backlog.mjs가 맡는다.
import { find } from './ledger.mjs';

// 사람이 정할 행동과 그 뜻(질문 페이지에 그대로 보인다). 설계확인은 확인이, 나머지는 허락이 묻는다. 여기에 들지 않는 일은 기록으로 남긴다.
export const 행동설명 = {
  삭제: '진짜 데이터를 지우거나 바꾸는 일',
  약속변경: '이미 남이 쓰는 약속(공개 API의 응답 모양이나 이름 등)을 바꾸는 일',
  외부발행: '밖으로 내보내는 일(배포, 메일·메시지 발송, 게시, 패키지 공개)',
  결제: '진짜 돈이 움직이는 일(결제, 유료 가입)',
  장치풀기: '지키는 장치를 끄거나 넓히는 일(훅이나 검사를 끄는 것, 한도를 늘리는 것, 권한이나 비밀번호를 다루는 것)',
  설계확인: '설계 중 사람이 확인해야 하는 일(아래 까닭 셋 중 하나)',
};
const 허락행동 = Object.keys(행동설명).filter(name => name !== '설계확인');

// 설계확인일 때 고르는 까닭과 그 뜻(질문 페이지에 그대로 보인다).
export const 까닭설명 = {
  문서충돌: '문서끼리 말이 달라 어느 쪽을 따를지 골라야 하는 일',
  실데이터: '실제 데이터·개인정보를 지우거나 남기거나 드러내는 방식을 정하는 일',
  구조변경: '새 의존성을 들이거나 폴더 구조·아키텍처를 바꾸는 일',
};
const 까닭 = Object.keys(까닭설명);

// 반드시 적어야 하는 칸이 비어 있으면 거절한다.
function insist(what, fields, names) {
  const missing = names.filter(name => !fields[name]);
  if (missing.length) throw new Error(`${what} 거절: ${missing.map(name => `--${name}`).join(' ')}이(가) 비어 있다`);
}

// "이름=결과|이름=결과"를 보기 목록으로. 둘 이상이어야 하고, 이름은 서로 달라야 하며, 결과를 비우지 않는다.
function choices(text) {
  const list = text.split('|').map(part => {
    const [name, ...result] = part.split('=');
    return { 이름: name.trim(), 결과: result.join('=').trim() };
  });
  if (list.length < 2 || list.some(item => !item.이름 || !item.결과) || new Set(list.map(item => item.이름)).size !== list.length) {
    throw new Error('질문 거절: --보기는 "이름=결과|이름=결과"로 둘 이상 적는다. 이름은 서로 달라야 하고 결과를 비우지 않는다');
  }
  return list;
}

// 허락·확인 공통: 작업과 제목, 빈 칸, 보기, 추천을 살피고 보기 목록을 돌려준다.
function prepare(what, ledger, id, title, fields, names) {
  find(ledger, id);
  if (!title) throw new Error(`${what} 거절: 제목이 없다. backlog ${what} T-1 "제목" ${names.map(name => `--${name} …`).join(' ')}`);
  insist(what, fields, names);
  const options = choices(fields.보기);
  if (!options.some(item => item.이름 === fields.추천)) {
    throw new Error(`${what} 거절: --추천 ${fields.추천}은(는) 보기에 없다(${options.map(item => item.이름).join(', ')})`);
  }
  return options;
}

function store(ledger, id, title, fields, options, state) {
  const question = {
    번호: `Q-${ledger.다음질문번호}`,
    작업: id,
    제목: title,
    행동: fields.행동,
    ...(fields.까닭 && { 까닭: fields.까닭 }),
    설명: fields.설명,
    보기: options,
    추천: fields.추천,
    이유: fields.이유,
    상태: state,
    만든시각: new Date().toISOString(),
  };
  ledger.다음질문번호 += 1;
  ledger.질문.push(question);
  return question;
}

// 허락: 답이 올 때까지 그 작업만 멈춘다(ledger.mjs의 openQuestions가 상태 대기만 본다).
export function permit(ledger, id, title, fields, what = '허락') {
  const options = prepare(what, ledger, id, title, fields, ['행동', '설명', '보기', '추천', '이유']);
  if (fields.행동 === '설계확인') throw new Error(`${what} 거절: 설계확인은 확인 명령으로 묻는다. backlog 확인 T-1 "제목" --까닭 … --설명 … --보기 … --추천 … --이유 …`);
  if (!허락행동.includes(fields.행동)) {
    throw new Error(`${what} 거절: --행동은 ${허락행동.join(', ')} 중 하나다. 이 다섯에 들지 않으면 AI가 정하고 기록으로 남긴다`);
  }
  if (fields.까닭 !== undefined) throw new Error(`${what} 거절: --까닭은 --행동 설계확인일 때만 적는다`);
  return store(ledger, id, title, fields, options, '대기');
}

// 확인: AI가 추천대로 진행하며 묻는다. 작업은 멈추지 않는다.
export function confirm(ledger, id, title, fields) {
  const options = prepare('확인', ledger, id, title, fields, ['까닭', '설명', '보기', '추천', '이유']);
  if (!까닭.includes(fields.까닭)) throw new Error(`확인 거절: --까닭은 ${까닭.join(', ')} 중 하나로 적는다`);
  return store(ledger, id, title, { ...fields, 행동: '설계확인' }, options, '확인중');
}

// 옛 이름 질문: 이미 하네스를 깐 프로젝트의 역할·워크플로 사본이 계속 부르므로 행동에 따라 허락이나 확인으로 받는다.
export function ask(ledger, id, title, fields) {
  if (fields.행동 === '설계확인') return confirm(ledger, id, title, fields);
  if (fields.행동 && !허락행동.includes(fields.행동)) {
    throw new Error(`질문 거절: --행동은 ${Object.keys(행동설명).join(', ')} 중 하나다. 이 여섯에 들지 않으면 AI가 정하고 기록으로 남긴다`);
  }
  return permit(ledger, id, title, fields, '질문');
}

// 확인에 답이 없으면 3일(사용자 결정 2026-10-14) 뒤 정해진 것으로 본다. 저장하지 않고 읽을 때마다 계산한다.
export const 확인기한 = 72 * 60 * 60 * 1000;
export const shownState = (question, now = new Date()) =>
  (question.상태 === '확인중' && now - new Date(question.만든시각) >= 확인기한 ? '확정' : question.상태);

// 사람이 고른 보기 이름(선택) 또는 직접 적은 글(직접)로 답한다. 만든시각을 함께 받으면 같은 질문인지 확인한다(오래된 페이지의 답을 막는다).
export function answer(ledger, id, { 선택, 직접, 만든시각 }) {
  const question = ledger.질문.find(item => item.번호 === id);
  if (!question) throw new Error(`${id ?? '번호'}: 그런 질문이 없다. backlog 질문목록으로 번호를 본다`);
  const state = shownState(question);
  if (state === '확정') throw new Error(`${id} 답 거절: 기한(3일)이 지나 확정됐다`);
  if (state !== '대기' && state !== '확인중') throw new Error(`${id} 답 거절: 이미 답했다(${question.답})`);
  if (만든시각 && 만든시각 !== question.만든시각) throw new Error(`${id} 답 거절: 다른 질문이다(만든 시각이 다르다). 페이지를 새로 고친다`);
  if (Boolean(선택) === Boolean(직접)) throw new Error(`${id} 답 거절: 보기 이름 하나나 --직접 "글" 중 하나만 적는다`);
  if (선택 && !question.보기.some(item => item.이름 === 선택)) {
    throw new Error(`${id} 답 거절: ${선택}은(는) 보기에 없다(${question.보기.map(item => item.이름).join(', ')})`);
  }
  // 확인에서 추천과 다른 답은 진행한 것을 고쳐야 한다는 뜻이다. 직접 적은 글은 뜻을 가릴 수 없어 메인이 읽게 고칠것으로 둔다.
  const agreed = state === '대기' || 선택 === question.추천;
  // 새답은 메인이 질문목록으로 읽을 때 지운다. 답할 때 적으므로 이 표시가 생기기 전에 답한 질문은 새 답이 아니다.
  Object.assign(question, { 상태: agreed ? '답함' : '고칠것', 답: 선택 || 직접, 새답: true });
  if (직접) question.직접 = true;
  return question;
}

// 확인에서 고칠것이 된 질문을 답대로 고친 뒤 닫는다. 원래 답과 질문 설명은 두고 상태와 반영 기록만 더한다.
export function reflect(ledger, id, fields) {
  const question = ledger.질문.find(item => item.번호 === id);
  if (!question) throw new Error(`${id ?? '번호'}: 그런 질문이 없다. backlog 질문목록으로 번호를 본다`);
  const state = shownState(question);
  if (state !== '고칠것') throw new Error(`${id} 반영 거절: 고칠것 상태만 반영한다(지금 ${state})`);
  insist('반영', fields, ['커밋', '설명']);
  Object.assign(question, { 상태: '반영함', 커밋: fields.커밋, 반영설명: fields.설명 });
  delete question.새답;
  return question;
}

// 사람이 답했는데 메인이 아직 질문목록으로 읽지 않은 답을 알리는 줄. 없으면 빈 배열, 있으면 줄 하나가 든 배열이다.
export function answerNotice(ledger) {
  const fresh = ledger.질문.filter(item => item.새답);
  if (!fresh.length) return [];
  const names = fresh.map(item => `${item.번호} ${item.상태}`).join(', ');
  return [`새 답 ${fresh.length}개(${names}). 메인은 node harness/backlog.mjs 질문목록 --상태 답함(고칠것은 --상태 고칠것)으로 읽는다`];
}

// 기록(옛 이름 처리함): AI가 알아서 정한 일을 적어만 둔다.
export function record(ledger, id, title, fields) {
  find(ledger, id);
  if (!title) throw new Error('기록 거절: 제목이 없다. backlog 기록 T-1 "제목" --설명 … --이유 …');
  insist('기록', fields, ['설명', '이유']);
  const item = { 작업: id, 제목: title, 설명: fields.설명, 이유: fields.이유, 만든시각: new Date().toISOString() };
  ledger.처리함.push(item);
  return item;
}
