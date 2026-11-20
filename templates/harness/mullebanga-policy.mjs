// 후보 순서는 작업 문서의 구원투수 순서다. 탐색 후보는 승급 사다리와 따로 둔다.
const pair = (model, effort = 'medium') => ({ model, effort });
const gem = name => pair(`gemini-4-${name}`, name.split('-').at(-1));
export const GROUPS = {
  경량: ['고르기', '할일적기', '한일적기', '돌려보기'],
  구현: ['만들기', '고치기'],
  추론: ['조사', '쪼개기', '맞춰보기', '번갈아보기'],
};
export const groupOf = stage => Object.keys(GROUPS).find(group => GROUPS[group].includes(stage));
export const CANDIDATES = {
  codex: {
    경량: { start: 0, ladder: [pair('gpt-6-luna'), pair('gpt-6.1-terra')] },
    구현: { start: 1, ladder: [pair('gpt-6.1-terra'), pair('gpt-6.1-terra', 'high'), pair('gpt-6.1-sol', 'high'), pair('gpt-6.1-sol', 'xhigh')] },
    추론: { start: 1, ladder: [pair('gpt-6.1-sol'), pair('gpt-6.1-sol', 'high'), pair('gpt-6.1-sol', 'xhigh')] },
  },
  claude: {
    경량: { start: 0, ladder: [pair('haiku'), pair('sonnet')] },
    구현: { start: 0, ladder: [pair('sonnet'), pair('sonnet', 'high'), pair('sonnet', 'xhigh'), pair('opus'), pair('opus', 'high')] },
    추론: { start: 2, ladder: [pair('sonnet', 'high'), pair('sonnet', 'xhigh'), pair('opus'), pair('opus', 'high'), pair('opus', 'xhigh')] },
  },
  gemini: {
    경량: { start: 0, ladder: [gem('hydrogen-medium'), gem('hydrogen-high')], explore: [gem('neon-medium'), gem('argon-medium')] },
    구현: { start: 0, ladder: [gem('hydrogen-high'), gem('hydrogen-xhigh')], explore: [gem('neon-medium'), gem('neon-high')] },
    추론: { start: 0, ladder: [gem('hydrogen-high'), gem('hydrogen-xhigh'), gem('neon-xhigh')], explore: [gem('neon-high'), gem('argon-medium')] },
  },
};
export const sameModel = (a, b) => a.model === b.model && a.effort === b.effort;
export function above(table, model) {
  const index = table.ladder.findIndex(item => sameModel(item, model));
  return table.ladder[index < 0 ? table.start : Math.min(index + 1, table.ladder.length - 1)];
}
const recent = rows => rows.slice(-10);
const rate = rows => rows.filter(row => row.firstPass).length / rows.length;
const average = (rows, key) => rows.every(row => row[key] !== null) ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : Infinity;
export function choosePrimary(table, state, rows) {
  const current = state.primary;
  const fresh = rows.slice(state.since).filter(row => sameModel(row, current));
  if (state.changed && fresh.length < 5) return current;
  const samples = recent(rows.filter(row => sameModel(row, current)));
  if (samples.length < 5) return current;
  if (rate(samples) < 0.7) return above(table, current);
  if (!samples.slice(-5).every(row => row.firstPass)) return current;
  const eligible = [...table.ladder, ...(table.explore ?? [])].map(candidate => ({ candidate, rows: recent(rows.filter(row => sameModel(row, candidate))) })).filter(item => item.rows.length >= 5 && rate(item.rows) >= 0.8);
  eligible.sort((a, b) => average(a.rows, 'elapsedMs') - average(b.rows, 'elapsedMs') || average(a.rows, 'tokens') - average(b.rows, 'tokens') || Number(sameModel(b.candidate, current)) - Number(sameModel(a.candidate, current)));
  return eligible[0]?.candidate ?? current;
}
export function chooseTrial(table, state, rows) {
  const samples = rows.filter(row => sameModel(row, state.primary));
  if ((state.changed && rows.slice(state.since).filter(row => sameModel(row, state.primary)).length < 5) || samples.length < 5 || !samples.slice(-5).every(row => row.firstPass)) {
    state.stable = 0;
    return state.primary;
  }
  state.stable = (state.stable ?? 0) + 1;
  if (state.stable % 5 !== 0) return state.primary;
  const index = table.ladder.findIndex(item => sameModel(item, state.primary));
  const candidates = [...table.ladder.slice(0, Math.max(0, index)), ...(table.explore ?? [])].filter(item => !sameModel(item, state.primary));
  const trial = candidates[(state.trials ?? 0) % candidates.length];
  state.trials = (state.trials ?? 0) + 1;
  return trial ?? state.primary;
}
