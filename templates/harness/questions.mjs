// 질문과 알아서 처리한 것(처리함). 질문은 사람의 결정을 기다리고, 처리함은 AI가 정한 일을 사람이 볼 수 있게 남긴다.
// 상태 규칙(답을 기다리는 작업 막기)은 ledger.mjs가, 명령줄은 backlog.mjs가 맡는다.
import { find } from './ledger.mjs';

// 사람만 정할 수 있는 행동과 그 뜻(질문 페이지에 그대로 보인다). 여기에 들지 않는 일은 AI가 정하고 처리함으로 남긴다.
export const 행동설명 = {
  삭제: '진짜 데이터를 지우거나 바꾸는 일',
  약속변경: '이미 남이 쓰는 약속(공개 API의 응답 모양이나 이름 등)을 바꾸는 일',
  외부발행: '밖으로 내보내는 일(배포, 메일·메시지 발송, 게시, 패키지 공개)',
  결제: '진짜 돈이 움직이는 일(결제, 유료 가입)',
};
const 행동 = Object.keys(행동설명);

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

export function ask(ledger, id, title, fields) {
  find(ledger, id);
  if (!title) throw new Error('질문 거절: 제목이 없다. backlog 질문 T-1 "제목" --행동 … --설명 … --보기 … --추천 … --이유 …');
  insist('질문', fields, ['행동', '설명', '보기', '추천', '이유']);
  if (!행동.includes(fields.행동)) {
    throw new Error(`질문 거절: --행동은 ${행동.join(', ')} 중 하나다. 이 넷에 들지 않으면 AI가 정하고 처리함으로 남긴다`);
  }
  const options = choices(fields.보기);
  if (!options.some(item => item.이름 === fields.추천)) {
    throw new Error(`질문 거절: --추천 ${fields.추천}은(는) 보기에 없다(${options.map(item => item.이름).join(', ')})`);
  }
  const question = {
    번호: `Q-${ledger.다음질문번호}`,
    작업: id,
    제목: title,
    행동: fields.행동,
    설명: fields.설명,
    보기: options,
    추천: fields.추천,
    이유: fields.이유,
    상태: '대기',
    만든시각: new Date().toISOString(),
  };
  ledger.다음질문번호 += 1;
  ledger.질문.push(question);
  return question;
}

// 사람이 고른 보기 이름(선택) 또는 직접 적은 글(직접)로 답한다. 만든시각을 함께 받으면 같은 질문인지 확인한다(오래된 페이지의 답을 막는다).
export function answer(ledger, id, { 선택, 직접, 만든시각 }) {
  const question = ledger.질문.find(item => item.번호 === id);
  if (!question) throw new Error(`${id ?? '번호'}: 그런 질문이 없다. backlog 질문목록으로 번호를 본다`);
  if (question.상태 !== '대기') throw new Error(`${id} 답 거절: 이미 답했다(${question.답})`);
  if (만든시각 && 만든시각 !== question.만든시각) throw new Error(`${id} 답 거절: 다른 질문이다(만든 시각이 다르다). 페이지를 새로 고친다`);
  if (Boolean(선택) === Boolean(직접)) throw new Error(`${id} 답 거절: 보기 이름 하나나 --직접 "글" 중 하나만 적는다`);
  if (선택 && !question.보기.some(item => item.이름 === 선택)) {
    throw new Error(`${id} 답 거절: ${선택}은(는) 보기에 없다(${question.보기.map(item => item.이름).join(', ')})`);
  }
  Object.assign(question, { 상태: '답함', 답: 선택 || 직접 });
  if (직접) question.직접 = true;
  return question;
}

export function handled(ledger, id, title, fields) {
  find(ledger, id);
  if (!title) throw new Error('처리함 거절: 제목이 없다. backlog 처리함 T-1 "제목" --설명 … --이유 …');
  insist('처리함', fields, ['설명', '이유']);
  const item = { 작업: id, 제목: title, 설명: fields.설명, 이유: fields.이유 };
  ledger.처리함.push(item);
  return item;
}
