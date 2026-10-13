#!/usr/bin/env node
// 멈출 때 설명 훅(Claude Code Stop): 장부에 진행중 작업이 있는데 멈추려 하면 한 번 붙잡고 왜 멈추는지 짧게 설명하게 한다.
// 계속 일하게 붙잡는 장치가 아니다. 설명한 뒤 다시 멈출 때는 stop_hook_active가 참이라 통과한다(무한 반복 없음).
// 출력은 hookSpecificOutput.additionalContext다. 공식 문서(code.claude.com/docs/en/hooks, 2026-10-12 조회)에서
// Stop도 이 칸으로 대화를 이어 가고, decision: "block"과 달리 훅 오류로 보이지 않는다.
// 장부를 읽지 못하면 예외를 그대로 올린다. 종료 코드 1은 막지 않는 오류라 멈춤을 붙잡지 않는다.
import fs from 'node:fs';
import * as ledger from './ledger.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const working = input.stop_hook_active ? [] : ledger.load(ledger.mainRoot()).작업.filter(task => task.상태 === '진행중');
if (working.length) {
  const ids = working.map(task => task.번호).join(', ');
  const reason = `진행중 작업: ${ids}. 멈추기 전에 왜 멈추는지 짧게 설명한다(끝났는지, 질문을 기다리는지, 막혔는지). 설명한 뒤에는 멈춰도 된다.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } }));
}
