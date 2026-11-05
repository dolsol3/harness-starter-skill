export const versions = { cases: 2, prompt: 2, schema: 1, scoring: 2 };
export const prompt = `제시된 기록·코드만 사용하라. 도구·웹·파일을 쓰지 마라. 네 문제는 독립적이며 다른 문제의 규칙을 가져오지 않는다. 답은 설명 없는 JSON 하나다. 키는 extract,compare,patch,review뿐이다. extract/compare/review는 해당 ID의 중복 없는 배열이며, 해당하지 않는 ID를 넣지 않는다. patch는 요청된 코드 한 줄 문자열이다. 알 수 없음을 사실로 확정하지 마라.

1. extract — 최종 계약
시간순 대화:
U1 사용자: "시험 전체 새 호출 예산은 12번이다. 성공한 답은 모델·추론단계·시험지 버전이 모두 같을 때만 재사용해. 실패 답은 재사용하지 말고, 재시도는 하지 마. 원시 로그는 커밋하지 마."
A1 AI: "병렬 상한을 5로 하고, 채점 뒤 임시 시험 저장소를 지우겠습니다. 재시도 2번과 추론단계가 다른 성공 답 재사용도 제안합니다."
U2 사용자: "상한 5와 임시 시험 저장소 정리만 승인해. 나머지는 원래대로."
A2 AI: "타임아웃도 재시도 금지로 확정하겠습니다."
U3 사용자: "네트워크 타임아웃만 같은 설정으로 1번 재시도하자. 그 호출도 전체 12번 안에서 세고. 요금제 한도 오류까지 재시도하자는 뜻은 아니야."
A3 AI: "그럼 남은 예산이 없으면 재시도 전용 1회를 추가로 허용하겠습니다."
U4 사용자: "아니, 전체 예산 예외는 없어."
질문: 이 대화로 확정된 현재 계약과 일치하는 문장 ID만 고르라. AI 제안 자체는 사용자 승인이 아니다. 원래 계약은 사용자가 바꾼 부분만 대체된다.
E1 병렬 상한은 5이며 전체 새 호출 예산은 12다.
E2 실패 답은 재사용하지 않으므로 요금제 한도 오류도 한 번 재호출한다.
E3 네트워크 타임아웃은 같은 설정으로 최대 1번 재시도할 수 있지만, 새 호출 예산이 남아 있어야 한다.
E4 성공 답이라도 모델·추론단계·시험지 버전 중 하나라도 다르면 재사용할 수 없다.
E5 마지막 답에서 전체 예산 예외를 거절했으므로 타임아웃 재시도 승인도 취소됐다.
E6 채점 뒤 임시 시험 저장소를 지울 수 있지만 원시 로그를 커밋할 수는 없다.
E7 성공 답의 추론단계가 다를 때 재사용하는 것은 U2에서 함께 승인됐다.

2. compare — 자료의 범위
다음은 가상 제품의 자료 전부다. 공식 설명은 해당 버전·실행면의 규칙에 대한 근거이고, 실제 처리 모델을 확인하려면 실제 모델 필드가 필요하다.
D1 공식 IDE 3.2 안내, 11월 1일: "IDE 자동 모드 기본 모델은 Nova다. 이 안내는 CLI에 적용되지 않는다."
D2 공식 CLI 8.0 설명, 11월 2일: "모델을 생략하면 Orion이다. --model을 명시하면 그 요청이 기본값보다 우선한다. 이 설명은 요청 모델의 선택 규칙이다."
D3 실행 기록, 11월 3일: "CLI 8.0; 명령 tool run --model Vega; 종료 성공; 실제 처리 모델 필드는 미수집; usage.input_tokens=900; usage.cached_input_tokens=700; 이 실행의 usage 필드 단위는 토큰."
D4 팀 메모, 11월 3일: "새 IDE 안내가 나왔으니 모든 실행면이 Nova일 것이다. 실행도 성공했으니 실제 Vega 처리까지 검증됐다."
D5 계측 설명: "cached_input_tokens는 input_tokens에 포함된다. usage는 이 실행의 API 토큰 집계이며 월 구독 한도 차감량을 나타내지 않는다."
질문: 자료가 직접 뒷받침하거나 그 자료로 필연적으로 추론되는 문장 ID만 고르라. 가능성이 있다는 것만으로 선택하지 않는다.
C1 최신 날짜의 메모에 따라 CLI 8.0 기본 모델도 Nova라고 확정한다.
C2 CLI 8.0에서 모델 옵션을 생략할 때의 기본 요청 모델은 Orion이다.
C3 D3의 요청 모델은 Vega지만 실제 처리 모델은 이 기록만으로 확인할 수 없다.
C4 실제 처리 모델이 미수집이므로 명령이 Vega를 요청했다는 사실도 확인할 수 없다.
C5 D3의 총 입력 토큰은 1,600이고, 그중 캐시가 아닌 입력은 900이다.
C6 D3의 캐시가 아닌 입력 토큰은 200이다.
C7 D3의 usage만으로 월 구독 한도가 900토큰만큼 차감됐다고 확정할 수 없다.
C8 D1은 CLI 적용 제외를 명시하므로 D2의 CLI 규칙과 충돌하지 않는다.

3. patch — 이전 요청의 정리
각 load(k)는 독립적인 Promise를 반환한다. Promise 콜백은 마이크로태스크로 실행되며 각 호출자는 반환된 Promise의 성공·실패를 처리한다. invalidate는 Map 등록만 지우고 진행 중 작업은 취소하지 않는다. 성공값 캐시는 없으며 완료된 자신의 등록은 성공·실패 모두에서 지워야 한다.
const pending = new Map();
function get(k) {
  if (pending.has(k)) return pending.get(k);
  const p = load(k).finally(() => {
    pending.delete(k); // 바꿀 한 줄
  });
  pending.set(k, p);
  return p;
}
function invalidate(k) { pending.delete(k); }
재현: get("x")로 P1 시작 → invalidate("x") → get("x")로 P2 시작 → P1의 finally 실행 → P2는 아직 대기.
목표: P1의 완료가 P2 등록을 지우면 안 된다. P2 자신의 완료는 등록을 지워야 한다.
아래 후보 중 주석 줄을 교체하여 목표를 만족하는 코드 한 줄만 patch 문자열에 그대로 적어라. 후보 번호나 설명은 쓰지 마라.
P1 if (pending.has(k)) pending.delete(k);
P2 if (pending.get(k) === p) pending.delete(k);
P3 if (pending.get(k) !== p) pending.delete(k);
P4 queueMicrotask(() => pending.delete(k));

4. review — 검사 시점과 삭제 시점
아래 R1~R4는 서로 독립적인 finish 구현 후보다. leases는 표준 Map이며 키마다 현재 작업의 고유 토큰 객체 하나를 저장한다. 토큰 객체는 재사용하지 않는다. finish(id, token)의 계약: 같은 작업의 현재 등록만 지우며, 다른 작업의 등록은 지우지 않는다. 등록이 바뀌었다면 지우지 않아도 된다.
JavaScript 단일 스레드다. 표준 Map의 get/delete는 동기이고 그 사이에 사용자 코드가 끼어들지 않는다. queueMicrotask 콜백은 현재 스택이 끝난 뒤 실행된다. audit()는 await 시 제어권을 넘기며, 성공 후에도 원래 token 객체는 변하지 않는다.
공통 시작: leases.set("x", A); finish("x", A)를 호출한다. finish 호출이 반환되거나 await로 멈춘 직후 다른 코드가 leases.set("x", B)를 실행할 수 있다. A와 B는 서로 다른 토큰이다.
R1 function finish(id, token) {
  const owned = leases.get(id) === token;
  queueMicrotask(() => { if (owned) leases.delete(id); });
}
R2 function finish(id, token) {
  queueMicrotask(() => {
    if (leases.get(id) === token) leases.delete(id);
  });
}
R3 function finish(id, token) {
  if (leases.get(id) === token) leases.delete(id);
}
R4 async function finish(id, token) {
  if (leases.get(id) !== token) return;
  await audit();
  leases.delete(id);
}
질문: 명시한 실행 조건에서 다른 작업 B의 등록을 잘못 지울 수 있는 구현 ID만 고르라. 비동기라는 이유만으로 지적하지 말고, 동기 구간 내부에 임의 인터리빙을 가정하지 마라. 새로운 사양이나 취소 요구는 추가하지 않는다.`;
const list = { type: 'array', items: { type: 'string' } };
export const schema = {
  type: 'object', additionalProperties: false,
  required: ['extract', 'compare', 'patch', 'review'],
  properties: { extract: list, compare: list, patch: { type: 'string' }, review: list },
};
export function grade(answer) {
  if (!answer || Object.keys(answer).sort().join() !== 'compare,extract,patch,review'
    || typeof answer.patch !== 'string'
    || ['extract', 'compare', 'review'].some(key => !Array.isArray(answer[key]) || answer[key].some(id => typeof id !== 'string'))) {
    throw new Error('답안 스키마 불일치');
  }
  const expected = { extract: ['E1', 'E3', 'E4', 'E6'], compare: ['C2', 'C3', 'C6', 'C7', 'C8'], review: ['R1', 'R4'] };
  const parts = {};
  for (const [key, ids] of Object.entries(expected)) {
    const correct = ids.filter(id => answer[key].includes(id));
    const missing = ids.filter(id => !answer[key].includes(id));
    const falsePositives = answer[key].filter((id, index) => !ids.includes(id) || answer[key].indexOf(id) !== index);
    parts[key] = { correct, missing, falsePositives, exact: missing.length === 0 && falsePositives.length === 0, score: Math.max(0, (correct.length - falsePositives.length) / ids.length) };
  }
  const exact = answer.patch.replace(/\s/g, '') === 'if(pending.get(k)===p)pending.delete(k);';
  parts.patch = { exact, score: exact ? 1 : 0 };
  return { parts, score: Object.values(parts).reduce((sum, part) => sum + part.score, 0), maxScore: 4 };
}
