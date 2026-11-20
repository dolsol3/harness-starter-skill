import fs from 'node:fs';
import path from 'node:path';
import { cases, levels } from './model-exam-fixtures.mjs';

export function usageTotal(calls = []) {
  let total = 0;
  let incomplete = !calls.length;
  for (const call of calls) {
    const records = call.tool === 'claude' && call.usage?.perModel?.length ? call.usage.perModel : call.usage?.records ?? [];
    incomplete ||= call.usage?.partial !== false || !records.length || (call.tool === 'claude' && !call.usage?.perModel?.length);
    for (const record of records) {
      const { input, output, cacheRead, cacheWrite } = record.values;
      const value = call.tool === 'gemini' ? record.nativeUsage.total_tokens
        : input === null || output === null ? null
          : call.tool === 'claude' ? (cacheRead === null || cacheWrite === null ? null : input + output + cacheRead + cacheWrite) : input + output;
      if (typeof value === 'number') total += value;
      else incomplete = true;
    }
  }
  return { observed: total, incomplete, total: incomplete ? null : total };
}
export function selectRepeats(results, stages = {}) {
  const candidates = [...new Set(results.map(r => r.candidate.id))];
  const selections = [];
  for (const [stage, tasks] of Object.entries(stages)) {
    const pool = candidates.map(id => {
      const rows = results.filter(r => r.candidate.id === id && r.phase === 'main');
      const related = rows.filter(r => tasks.includes(r.case.id));
      const score = related.reduce((n, r) => n + (r.grade?.stageScores[stage] ?? 0), 0);
      const max = related.reduce((n, r) => n + (r.grade?.stageMaxScores[stage] ?? 0), 0);
      const judged = related.length === tasks.length && related.every(r => r.ok && r.grading?.status === '판정완료');
      const eligible = judged && rows.every(r => r.grade?.eligible !== false && !(r.scopeViolations?.length) && !(r.calls ?? []).some(c=>c.scopeViolations?.length)) && max > 0 && score / max >= 0.9;
      return { id, eligible, score, max, usage: usageTotal(related.flatMap(r => r.calls)),
        errors: related.reduce((n, r) => n + (r.grade?.falsePositives.length ?? 0) + (r.grade?.missing.length ?? 0), 0),
        elapsedMs: related.reduce((n, r) => n + r.elapsedMs, 0) };
    });
    const quality = (a, b) => b.score - a.score || a.errors - b.errors || a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id);
    const eligible = pool.filter(c => c.eligible).sort(quality);
    const accuracy = eligible[0] ?? [...pool].sort(quality)[0];
    const complete = eligible.every(c => c.usage.total !== null);
    const others = eligible.filter(c => c.id !== accuracy?.id).sort((a, b) => (complete ? a.usage.total - b.usage.total : 0) || a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id));
    const efficiency = others[0] ?? (!eligible.length ? [...pool].filter(c => c.id !== accuracy?.id).sort(quality)[0] : null);
    selections.push({ stage, tasks: [...new Set(tasks)], accuracy: accuracy?.id ?? null, efficiency: efficiency?.id ?? null,
      status: eligible.length > 1 ? '반복 후보' : eligible.length === 1 ? '적격 1명' : '진단만·추천 금지',
      costVerified: complete && eligible.length > 1, pool });
  }
  return selections;
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// 저장된 결과의 단계·난이도 대신 지금 문제 정의를 쓴다. 문제 ID는 그대로라 옛 결과도 새 칸에 들어간다.
const meta = row => cases.find(c => c.id === row.case.id) ?? row.case;
// 같은 결과 해시(key)는 재사용돼도 한 회차로 센다.
const unique = rows => [...new Map(rows.map(r => [r.key, r])).values()];
const scoredRows = rows => unique(rows).filter(r => ['main', 'repeat'].includes(r.phase) && meta(r).difficulty);
function scoreCell(rows) {
  const judged = rows.filter(r => r.grading?.status === '판정완료');
  const pending = rows.length - judged.length;
  return rows.length ? `${judged.reduce((n, r) => n + r.grade.score, 0)}/${judged.length * 10}${pending ? ` · 미채점 ${pending}` : ''}` : '—';
}
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
export function stageTiming(row, stage) {
  if (row.case.id !== 'Q10') {
    const shared = Object.keys(row.grade?.stageMaxScores ?? {}).length > 1;
    return { elapsedMs: shared ? null : row.elapsedMs, taskElapsedMs: row.elapsedMs, externalElapsedMs: null,
      basis: shared ? '단계 분할 미측정·과제 시간 공유' : '과제 전체 시간' };
  }
  const calls = (row.calls ?? []).filter(call => call.stage === stage || (stage === '번갈아보기' && call.stage === '외부검토'));
  const sum = list => list.length && list.every(c => Number.isFinite(c.elapsedMs)) ? list.reduce((n,c)=>n+c.elapsedMs,0) : null;
  return { elapsedMs: sum(calls), taskElapsedMs: row.elapsedMs,
    externalElapsedMs: sum(calls.filter(c=>c.stage === '외부검토')), basis: '단계 호출 합·번갈아보기는 외부 검토 포함' };
}
export function stageRows(results) {
  const groups = new Map();
  for (const row of unique(results)) for (const [stage, max] of Object.entries(row.grade?.stageMaxScores ?? {})) {
    const phase = ['main', 'repeat'].includes(row.phase) ? '본시험·반복' : row.phase;
    const key = `${row.candidate.id}/${stage}/${row.case.id}/${phase}`;
    if (!groups.has(key)) groups.set(key, { candidate: row.candidate.id, stage, task: row.case.id, phase, conditions: new Set(), scores: [], times: [], taskTimes: [], timingBases: new Set(), success: 0, max });
    const group = groups.get(key);
    group.conditions.add(JSON.stringify([row.concurrency, row.timeoutMs]));
    group.scores.push(row.grade.stageScores[stage]);
    const timing = stageTiming(row, stage);
    if (timing.elapsedMs !== null) group.times.push(timing.elapsedMs);
    group.taskTimes.push(timing.taskElapsedMs);
    group.timingBases.add(timing.basis);
    group.success += Number(row.ok && row.grading?.status === '판정완료' && row.grade.stageScores[stage] === max && row.grade.eligible);
  }
  return [...groups.values()].map(g => {
    const times = g.times.sort((a, b) => a - b);
    const timedN = times.length;
    return { ...g, n: g.scores.length, timedN, median: !timedN ? null : timedN % 2 ? times[(timedN - 1) / 2] : (times[timedN / 2 - 1] + times[timedN / 2]) / 2,
      range: timedN ? [times[0], times.at(-1)] : null };
  });
}
export function writeReport(summary, out) {
  const rows = summary.results;
  const fields = ['candidate', 'tool', 'requestedModel', 'actualModels', 'effort', 'case', 'difficulty', 'stage', 'round', 'phase', 'status', 'failureType', 'reused',
    'criterion', 'score', 'maxScore', 'gate', 'missing', 'falsePositives', 'elapsedMs', 'stageElapsedMs', 'externalElapsedMs', 'timingBasis', 'tokens', 'incomplete', 'nativeUsage', 'sourceHashes'];
  const records = rows.flatMap(r => (r.grade?.criteria ?? [{ name: '', stage: r.case.stage }]).map(c => {
    const total = usageTotal(r.calls);
    const timing = stageTiming(r, c.stage);
    return [r.candidate.id, r.candidate.tool, r.candidate.model, JSON.stringify(r.calls.flatMap(c => c.actualModels ?? [])), r.candidate.effort,
      r.case.id, meta(r).difficulty ?? '성적 제외', c.stage, r.round, r.phase, r.status, r.failureType, r.reused, c.name, c.score, c.maxScore,
      JSON.stringify(r.grade?.gates), JSON.stringify(r.grade?.missing), JSON.stringify(r.grade?.falsePositives), r.elapsedMs, timing.elapsedMs, timing.externalElapsedMs, timing.basis,
      total.total, total.incomplete, JSON.stringify(r.calls.map(c => ({ stage: c.stage, tool: c.tool, usage: c.usage }))), JSON.stringify(r.sources)];
  }));
  fs.writeFileSync(path.join(out, 'comparison.csv'), [fields, ...records].map(row => row.map(csv).join(',')).join('\n'));
  const dimensions = { tool: r => r.candidate.tool, candidate: r => r.candidate.id, effort: r => r.candidate.effort ?? '미지정',
    difficulty: r => meta(r).difficulty ?? '성적 제외', stage: r => Object.keys(r.grade?.stageScores ?? { [r.case.stage]: 0 }) };
  const filters = Object.entries(dimensions).map(([key, get]) => `<label>${key} <select data-filter="${key}"><option value="">전체</option>${[...new Set(rows.flatMap(get))].map(v => `<option>${escape(v)}</option>`).join('')}</select></label>`).join(' ');
  const table = rows.map(r => {
    const total = usageTotal(r.calls);
    const writer = usageTotal(r.calls.filter(c => c.stage !== '외부검토'));
    const external = usageTotal(r.calls.filter(c => c.stage === '외부검토'));
    const attrs = Object.entries(dimensions).map(([key, get]) => `data-${key}="${escape(JSON.stringify(get(r)))}"`).join(' ');
    const ratio = r.grading?.status === '판정완료' ? (r.grade?.score ?? 0) / 10 : 0;
    return `<tr ${attrs}><td>${escape(r.candidate.id)}<br>${escape(r.candidate.model)} ${escape(r.candidate.effort)}</td><td>${escape(r.case.id)} ${escape(meta(r).stage)} ${escape(meta(r).difficulty ?? '성적 제외')}<br>${escape(r.phase)} #${r.round}${r.reused ? ' 재사용' : ''}</td><td style="background:rgba(35,165,100,${ratio * 0.35})">${r.grade?.score ?? '—'}/10 ${escape(r.grading?.status)}<br>${escape(r.status)} ${escape(r.failureType)}</td><td>${escape(r.grade?.gates.join(', '))}<br>누락 ${escape(r.grade?.missing.join(', '))}<br>헛지적 ${escape(r.grade?.falsePositives.join(', '))}</td><td>${(r.elapsedMs / 1000).toFixed(2)}s</td><td>${total.total ?? `${total.observed}+ 미수집`}<br>작성 ${writer.total ?? '불완전'} / 외부 ${external.total ?? '미수집'}</td><td><details><summary>호출 ${r.calls.length}·criterion·native usage</summary><pre>${escape(JSON.stringify({ failure: { reason: r.reason, detail: r.detail }, actual: r.calls.map(c => ({ stage: c.stage, model: c.actualModels, reason: c.modelMissingReason, usage: c.usage })), criteria: r.grade?.criteria }, null, 2))}</pre></details></td></tr>`;
  }).join('');
  const samples = stageRows(rows).map(g => `<tr><td>${escape(g.candidate)}</td><td>${escape(g.stage)} / ${g.task} / ${escape(g.phase)}${g.conditions.size > 1 ? ' · 실행 조건 혼합' : ''}</td><td>${g.n} / ${g.success}</td><td>${g.scores.join(', ')} / ${g.max}</td><td>${g.median === null ? '미측정' : `${g.timedN === 1 ? '단회' : '중앙'} ${(g.median / 1000).toFixed(2)}s / ${g.range.map(n => (n / 1000).toFixed(2)).join('–')}s`}<br>${escape([...g.timingBases].join(', '))}<br>과제 전체 ${g.taskTimes.map(n=>(n/1000).toFixed(2)).join(', ')}s</td></tr>`).join('');
  const candidateTotals = [...new Set(rows.map(r => r.candidate.id))].map(id => {
    const all = unique(rows.filter(r => r.candidate.id === id));
    const scored = scoredRows(all);
    const calls = all.flatMap(r => r.calls);
    const totals = [calls.filter(c => c.stage !== '외부검토'), calls.filter(c => c.stage === '외부검토'), calls].map(usageTotal);
    return `<tr><td>${escape(id)}</td>${[scored, ...levels.map(level => scored.filter(r => meta(r).difficulty === level))].map(cell => `<td>${scoreCell(cell)}</td>`).join('')}<td>${all.filter(r => !r.ok).length}</td><td>${totals.map(u => u.total ?? `${u.observed}+ 불완전`).join(' / ')}</td></tr>`;
  }).join('');
  const stageNames = [...new Set(cases.filter(c => c.difficulty).map(c => c.stage))];
  const stageLevels = [...new Set(rows.map(r => r.candidate.id))].flatMap(id => stageNames.map(stage => {
    const scored = scoredRows(rows.filter(r => r.candidate.id === id && meta(r).stage === stage));
    return scored.length ? `<tr><td>${escape(id)}</td><td>${escape(stage)}</td>${levels.map(level => `<td>${scoreCell(scored.filter(r => meta(r).difficulty === level))}</td>`).join('')}</tr>` : '';
  })).join('');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>모델 실전 과제 비교</title>
<style>body{font:15px system-ui;margin:32px;color:#172c3e}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{padding:10px;border:1px solid #cbd5df;text-align:left;vertical-align:top}th{background:#edf3f7}pre{white-space:pre-wrap;max-width:700px}select{padding:6px}label{display:inline-block;margin:6px}tr[hidden]{display:none}</style>
<h1>모델 실전 과제 비교</h1><p>phase ${escape(summary.config.phase)} · 과제 회차 ${rows.length} · ${escape(JSON.stringify(summary.counts))}</p>
<p>미채점은 오답·순위로 확정하지 않는다. 쉬운 Q1/Q2는 성적 합계·난이도별 표에서 뺀다. 병렬 단회 시간은 속도 순위가 아니다. 3회 반복도 장기 안정성 입증은 아니다. 운영 배정에 적용하지 않았다.</p>
<p><a href="summary.json">원본 JSON</a> · <a href="comparison.csv">criterion별 CSV</a>. 캐시·추론은 네이티브 포함 관계를 보존한다. 미수집은 0이 아니다. 구독 차감·금액은 추정하지 않는다.</p>
<h2>후보 합계·난이도별 점수</h2><p>점수는 본시험·반복의 판정완료 회차 합/만점이다. 토큰은 시범·실패를 포함한 수집된 모든 회차의 해시별 1회분이다. 미채점·gate가 있으면 품질 우위로 확정하지 않는다.</p><table><tr><th>후보</th><th>합계</th>${levels.map(level => `<th>${level}</th>`).join('')}<th>실패</th><th>작성 / 외부 / 전체 토큰</th></tr>${candidateTotals}</table><div>${filters}</div><h2>문제별 heatmap·실패·시간·토큰</h2><table id="results"><thead><tr><th>후보 / 요청</th><th>과제 / 회차</th><th>점수·상태</th><th>gate·쉬운 실수·누락</th><th>시간</th><th>전체 토큰</th><th>근거</th></tr></thead><tbody>${table}</tbody></table>
<h2>단계×난이도 칸별 점수</h2><p>문제마다 정해 둔 칸(단계·난이도)에 문제 점수 전체를 넣는다. 아래 단계별 표본표는 기준별 단계로 나눈 점수다.</p><table><tr><th>후보</th><th>단계</th>${levels.map(level => `<th>${level}</th>`).join('')}</tr>${stageLevels}</table>
<h2>단계별 표본·반복 성공·중앙/범위</h2><p>동일 후보·과제·단계를 묶는다. 같은 결과 해시는 재사용해도 표본 하나로 센다. Q10 단계 시간은 해당 호출 합이며 번갈아보기는 외부 검토 시간을 포함한다. 호출이 없거나 시간이 누락되면 미측정이다. Q1/Q6 복수 단계는 분할 미측정으로 과제 전체 시간을 공유 표시한다. CSV elapsedMs는 과제 전체, stageElapsedMs는 단계 시간이다. 시간·토큰 확정 비교에는 같은 조건의 직렬 반복이 필요하다.</p><table><tr><th>후보</th><th>단계 / 과제</th><th>표본 / 완전 성공</th><th>점수</th><th>시간</th></tr>${samples}</table>
<h2>반복 선발 근거·남은 미확인</h2><p>관련 정확성 90%·gate 없음을 충족한 뒤 품질 대표와 효율 도전자를 고른다. 아래는 반복 후보이며 최종 추천은 실제 직렬 반복과 혼합 Q10 완주 뒤 메인이 판단한다.</p><pre>${escape(JSON.stringify(summary.repeatSelection, null, 2))}</pre>
<script>const filters=[...document.querySelectorAll('[data-filter]')];for(const filter of filters)filter.addEventListener('change',()=>{for(const row of document.querySelectorAll('#results tbody tr'))row.hidden=!filters.every(f=>!f.value||[JSON.parse(row.dataset[f.dataset.filter])].flat().includes(f.value));});</script></html>`;
  fs.writeFileSync(path.join(out, 'comparison.html'), html);
}
