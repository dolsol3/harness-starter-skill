import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cases, levels, prepareCase } from '../scripts/model-exam-fixtures.mjs';
import { gradeCase, answerHash, rubrics, reproductionCriteria } from '../scripts/model-exam-grade.mjs';
import { assets } from '../scripts/model-exam-public.mjs';
import { writeReport } from '../scripts/model-exam-report.mjs';
import { levelAnswers } from './model-exam-levels-answers.mjs';
import { referenceSolutions } from './model-exam-cases-reference.mjs';

function fixture(t, id) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-level-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  return { cwd, prepared: prepareCase(id, cwd) };
}
// 이 시험 안에서 돈 node --test가 바깥 시험의 하위 보고로 바뀌어 종료 코드를 잃지 않게 한다.
const { NODE_TEST_CONTEXT, ...plainEnv } = process.env;
function execution(cwd, command) {
  const [bin, ...args] = command.split(' ');
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', env: plainEnv });
  return { cwd, command, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
function repro(cwd, name, source) {
  fs.writeFileSync(path.join(cwd, name), source);
  return execution(cwd, `node ${name}`);
}
const judge = (answer, scores) => Object.entries(scores).map(([criterion, [score, reason]]) => ({ criterion, score, reason, answerHash: answerHash(answer) }));
// 재현 실행마다 판정자가 그 실행·소스를 보고 기준별로 인정한 판정이다.
const reproJudged = (id, cwd, answer, commands = []) => commands.flatMap(run => (reproductionCriteria[id] ?? []).map(criterion => ({ criterion, score: 1,
  reason: `${run.command} 종료 ${run.exitCode}와 소스 assert 대조`, answerHash: answerHash(answer),
  reproductionHash: answerHash({ run, source: fs.readFileSync(path.join(cwd, run.command.split(' ')[1]), 'utf8') }) })));
const full = id => Object.fromEntries(rubrics[id].map(([name, max]) => [name, [max, `${name}: 답안 주장과 공개 자료를 대조함`]]));

test('Q1~Q23 칸 표: 쉬움 Q1·Q2는 성적 밖, 중간 8·고난도 8·초고난도 5', t => {
  assert.deepEqual(cases.map(c => c.id), Array.from({ length: 23 }, (_, i) => `Q${i + 1}`));
  assert.deepEqual(levels.map(level => cases.filter(c => c.difficulty === level).length), [8, 8, 5]);
  assert.deepEqual(cases.filter(c => !levels.includes(c.difficulty)).map(c => [c.id, c.difficulty]), [['Q1', null], ['Q2', null]]);
  const cells = Object.fromEntries(cases.filter(c => c.difficulty).map(c => [c.id, `${c.stage}/${c.difficulty}`]));
  assert.deepEqual(cells, {
    Q3: '조사/중간', Q4: '만들기/중간', Q5: '번갈아보기/중간', Q6: '쪼개기/고난도', Q7: '만들기/고난도', Q8: '고치기/고난도', Q9: '만들기/초고난도', Q10: '전체연결/초고난도',
    Q11: '할일적기/중간', Q12: '할일적기/고난도', Q13: '맞춰보기/중간', Q14: '맞춰보기/고난도', Q15: '쪼개기/중간', Q16: '돌려보기/중간', Q17: '돌려보기/고난도',
    Q18: '조사/고난도', Q19: '조사/초고난도', Q20: '번갈아보기/고난도', Q21: '번갈아보기/초고난도', Q22: '고치기/중간', Q23: '고치기/초고난도',
  });
  for (const item of cases.slice(10)) {
    const { cwd, prepared } = fixture(t, item.id);
    assert.ok(item.timeoutSeconds > 0 && prepared.prompt.length > 200);
    assert.deepEqual(fs.readdirSync(cwd).filter(name => name !== '.git').sort(), Object.keys(assets[item.id] ?? {}).sort());
    assert.ok(Object.values(assets[item.id] ?? {}).every(content => !/채점|rubric|fixedSources/.test(content)));
    if (rubrics[item.id]) assert.equal(rubrics[item.id].reduce((n, row) => n + row[1], 0) + (['Q16', 'Q17'].includes(item.id) ? 3 : 0), 10);
  }
});

const evidence = {
  Q16: (cwd, wrong) => ({ commands: ['node --test public.test.mjs', 'node lint.mjs'].map(command => execution(cwd, command)) }),
  Q17: (cwd, wrong) => ({ commands: (wrong ? levelAnswers.Q17.wrongRuns : ['node run-checks.mjs', 'node --test unit.test.mjs']).map(command => execution(cwd, command)) }),
  Q20: cwd => ({ commands: [repro(cwd, 'repro-limits.mjs', levelAnswers.Q20.repro)] }),
  Q21: cwd => ({ commands: [repro(cwd, 'repro-cache.mjs', levelAnswers.Q21.repro)] }),
};
for (const [id, item] of Object.entries(levelAnswers)) test(`${id}: 정답 답안은 만점, 흔한 오답은 감점`, t => {
  const { cwd } = fixture(t, id);
  const answer = { summary: item.answer };
  const observed = evidence[id]?.(cwd, false) ?? {};
  if (id === 'Q16') assert.deepEqual(observed.commands.map(run => run.exitCode), [1, 0]);
  if (id === 'Q17') assert.deepEqual(observed.commands.map(run => run.exitCode), [0, 1]);
  if (['Q20', 'Q21'].includes(id)) assert.equal(observed.commands[0].exitCode, 1, observed.commands[0].stderr);
  const correct = gradeCase(id, { cwd, answer, evidence: { ...observed, assessments: [...judge(answer, full(id)), ...reproJudged(id, cwd, answer, observed.commands)] } });
  assert.equal(correct.score, 10, JSON.stringify(correct.criteria));
  assert.equal(correct.eligible, true);
  // Claude 기록 형식: 성공한 명령은 종료 코드 없이 성공 상태만, 실패한 명령은 종료 코드 머리줄과 오류 상태를 남긴다.
  const claude = observed.commands?.map(run => run.exitCode === 0 ? { ...run, exitCode: null, toolStatus: 'success' } : { ...run, toolStatus: 'error' });
  if (['Q16', 'Q17'].includes(id)) assert.equal(gradeCase(id, { cwd, answer, evidence: { commands: claude, assessments: judge(answer, full(id)) } }).score, 10);
  const wrong = { summary: item.wrong.reduce((text, [from, to]) => { assert.ok(text.includes(from), from); return text.replace(from, to); }, item.answer) };
  const wrongObserved = evidence[id]?.(cwd, true) ?? {};
  // 정답 답안에 준 만점 판정은 오답 답안에 옮겨 쓸 수 없다.
  assert.ok(gradeCase(id, { cwd, answer: wrong, evidence: { ...wrongObserved, assessments: judge(answer, full(id)) } }).score <= 3);
  const judged = gradeCase(id, { cwd, answer: wrong, evidence: { ...wrongObserved, assessments: [...judge(wrong, { ...full(id), ...item.lowered }), ...reproJudged(id, cwd, wrong, wrongObserved.commands)], falsePositives: item.falsePositives } });
  const lost = Object.entries(item.lowered).reduce((n, [name, [score]]) => n + rubrics[id].find(row => row[0] === name)[1] - score, 0);
  const actualLost = id === 'Q17' ? 3 : 0;
  assert.equal(judged.score, 10 - lost - actualLost - 2 * (item.falsePositives?.length ?? 0), JSON.stringify(judged.criteria));
  assert.ok(judged.score < 10);
});

for (const id of ['Q20', 'Q21']) test(`${id}: 재현 점수는 결함마다 원본에서 실패하고 고친 코드에서 통과하며 판정이 그 실행에 묶인 재현만 받는다`, t => {
  const { cwd } = fixture(t, id);
  const answer = { summary: levelAnswers[id].answer };
  const assessments = judge(answer, full(id));
  const score = (commands, judged = commands) => gradeCase(id, { cwd, answer, evidence: { commands, assessments: [...assessments, ...reproJudged(id, cwd, answer, judged)] } }).criteria.find(c => c.name === 'reproduction').score;
  const strong = repro(cwd, 'repro-strong.mjs', levelAnswers[id].repro);
  assert.equal(score([strong]), 2);
  assert.equal(score([]), 0);
  assert.equal(score([strong], []), 0);
  assert.equal(score([{ ...strong, exitCode: 0 }]), 0);
  assert.equal(score([{ ...strong, cwd: '/elsewhere' }]), 0);
  if (id === 'Q21') assert.equal(score([repro(cwd, 'repro-weak.mjs', levelAnswers.Q21.weakRepro)]), 0);
  if (id === 'Q20') {
    // 결함 하나만 재현하는 파일 둘: 하나씩은 0점, 둘을 함께 실행하면 두 결함 모두 재현이다.
    const [window, rejected] = levelAnswers.Q20.repro.split('let s = 0;\n');
    const halves = [repro(cwd, 'repro-window.mjs', window), repro(cwd, 'repro-rejected.mjs', `import assert from 'node:assert/strict';\nimport { createLimiter } from './limits.mjs';\nlet s = 0;\n${rejected}`)];
    assert.deepEqual(halves.map(run => run.exitCode), [1, 1]);
    assert.equal(score([halves[0]]), 0);
    assert.equal(score([halves[1]]), 0);
    assert.equal(score(halves), 2);
    // 허용된 이름으로 나눈 재현: 진입 파일이 보조 파일을 불러도 묶음을 함께 옮겨 돌린다.
    fs.writeFileSync(path.join(cwd, 'repro-helper.mjs'), levelAnswers.Q20.repro);
    const split = repro(cwd, 'repro-main.mjs', "await import('./repro-helper.mjs');\n");
    assert.equal(split.exitCode, 1, split.stderr);
    assert.equal(score([split]), 2);
    fs.writeFileSync(path.join(cwd, 'repro-helper.mjs'), window);
    assert.equal(score([split]), 0);
    fs.writeFileSync(path.join(cwd, 'repro-도우미.mjs'), levelAnswers.Q20.repro);
    const korean = repro(cwd, 'repro-main.mjs', "await import('./repro-도우미.mjs');\n");
    assert.equal(korean.exitCode, 1, korean.stderr);
    assert.equal(score([korean]), 2);
  }
  fs.writeFileSync(path.join(cwd, 'repro-strong.mjs'), "process.exitCode = 1;\n");
  assert.equal(score([strong]), 0);
  fs.appendFileSync(path.join(cwd, id === 'Q20' ? 'limits.mjs' : 'cache.mjs'), '\n');
  assert.equal(gradeCase(id, { cwd, answer, evidence: { commands: [strong], assessments } }).eligible, false);
});

const fixRepro = {
  Q22: ['collision', `import assert from 'node:assert/strict';
import { convert, taxRate } from './prices.mjs';
assert.equal(convert(100, 'USD'), 100);
assert.equal(convert(100, 'EUR'), 90);
assert.equal(taxRate('kr', 2025), 0.1);
assert.equal(taxRate('kr', 2026), 0.12);
`],
  Q23: ['lostUpdate', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { update } from './ledger.mjs';
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repro-ledger-')), 'a.json');
fs.writeFileSync(file, '[{"id":"x","state":0}]');
const inc = async state => { await new Promise(resolve => setTimeout(resolve, 10)); return state + 1; };
await Promise.all([update(file, 'x', inc), update(file, 'x', inc)]);
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].state, 2);
`],
};
// 증상만 덮는 흔한 오답: 리뷰가 권한 고침을 그대로 따른 구현.
const symptomFixes = {
  Q22: [
    ['prices.mjs', assets.Q22['prices.mjs'].replace('export const convert = memo((amount, currency) => Math.round(amount * rates[currency] * 100) / 100);', 'export const convert = (amount, currency) => Math.round(amount * rates[currency] * 100) / 100;'), ['root', 'boundaries'], 4],
    ['memo.mjs', referenceSolutions.Q22['memo.mjs'].replace('JSON.stringify(args)', "args.join(',')"), ['boundaries'], 8],
    // 세 번째 이후 인자를 키에서 버리는 memo.
    ['memo.mjs', referenceSolutions.Q22['memo.mjs'].replace('JSON.stringify(args)', 'JSON.stringify(args.slice(0, 2))'), ['boundaries'], 8],
    // 고친 memo를 두고 convert·taxRate에서 memo를 벗긴 구현: 값은 맞지만 memo로 감싼 채 둔다는 계약을 깬다.
    ['prices.mjs', assets.Q22['prices.mjs'].replace(/memo\((\(.*\) => .*)\);/g, '$1;'), ['root'], 6],
  ],
  Q23: [
    ['ledger.mjs', assets.Q23['ledger.mjs'].replace("  if (!row) {", "  const fresh = JSON.parse(await fs.readFile(file, 'utf8'));\n  rows.splice(0, rows.length, ...fresh);\n  row = rows.find(item => item.id === id);\n  if (!row) {"), ['ordering', 'failure', 'identity'], 4],
    ['ledger.mjs', referenceSolutions.Q23['ledger.mjs'].replace('const key = path.resolve(file);', "const key = 'all';"), ['independence'], 8],
    // change가 undefined를 돌려주면 거절하지 않고 그 행의 state를 지우는 구현.
    ['ledger.mjs', referenceSolutions.Q23['ledger.mjs'].replace("  if (JSON.stringify(state) === undefined) throw new TypeError('JSON으로 바꿀 수 없는 state');\n", ''), ['failure'], 8],
  ],
};
for (const id of ['Q22', 'Q23']) test(`${id}: 빈 폴더에 정답 구현은 만점, 증상만 덮는 구현은 감점`, t => {
  const { cwd, prepared } = fixture(t, id);
  assert.deepEqual(prepared.checks, ['node --test public.test.mjs']);
  assert.equal(prepared.write, true);
  const baseline = gradeCase(id, { cwd });
  assert.equal(baseline.score, 3, JSON.stringify(baseline.criteria));
  for (const [name, content] of Object.entries(referenceSolutions[id])) fs.writeFileSync(path.join(cwd, name), content);
  const run = execution(cwd, prepared.checks[0]);
  assert.equal(run.exitCode, 0, run.stderr);
  const [criterion, source] = fixRepro[id];
  fs.writeFileSync(path.join(cwd, 'repro-bug.mjs'), source);
  const shown = execution(cwd, 'node repro-bug.mjs');
  assert.equal(shown.exitCode, 0, shown.stderr);
  const assessments = [{ criterion, score: 1, reason: '원본에서 실패하던 순서를 같은 파일로 고친 뒤 통과로 관측', answerHash: answerHash(undefined), reproductionHash: answerHash({ run: shown, source }) }];
  const evidence = { commands: [run, shown], assessments };
  const correct = gradeCase(id, { cwd, evidence });
  assert.equal(correct.score, 10, JSON.stringify(correct.reports));
  assert.ok(baseline.score < correct.score);
  assert.equal(gradeCase(id, { cwd, evidence: { commands: [run] } }).score, 9);
  for (const [file, content, broken, expected] of symptomFixes[id]) {
    for (const [name, reference] of Object.entries({ ...assets[id], ...referenceSolutions[id] })) fs.writeFileSync(path.join(cwd, name), reference);
    fs.writeFileSync(path.join(cwd, file), content);
    if (file === 'prices.mjs' && broken.includes('boundaries')) fs.writeFileSync(path.join(cwd, 'memo.mjs'), assets.Q22['memo.mjs']);
    const graded = gradeCase(id, { cwd, evidence });
    assert.deepEqual(graded.missing, broken, JSON.stringify(graded.reports));
    assert.equal(graded.score, expected);
  }
  fs.writeFileSync(path.join(cwd, 'public.test.mjs'), 'process.exitCode = 0;\n');
  assert.equal(gradeCase(id, { cwd, evidence }).eligible, false);
});

test('성적표는 Q1·Q2를 빼고 난이도별·단계×난이도 칸별 점수를 보인다', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-report-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const row = (id, score, candidate = 'a', status = '판정완료') => ({ key: candidate + id, candidate: { id: candidate, tool: 'codex', model: 'm', effort: 'medium' },
    case: { id, difficulty: '옛 이름', stage: '옛 단계' }, phase: 'main', round: 1, ok: true, status: '완료', elapsedMs: 1000, calls: [],
    grading: { status }, grade: { score, eligible: true, criteria: [{ name: 'x', score, maxScore: 10, stage: '옛 단계' }], stageScores: {}, stageMaxScores: {}, gates: [], missing: [], falsePositives: [] } });
  // 같은 key의 재사용 회차(Q4·Q22)는 한 번만 센다.
  const results = [row('Q1', 10), row('Q2', 0), row('Q4', 10), row('Q22', 6), row('Q7', 5), row('Q9', 0), row('Q23', 8, 'a', '미채점'), row('Q11', 7, 'b'), { ...row('Q4', 10), reused: true }, { ...row('Q22', 6), reused: true }];
  writeReport({ config: { phase: 'main' }, counts: {}, results, repeatSelection: [] }, out);
  const html = fs.readFileSync(path.join(out, 'comparison.html'), 'utf8');
  assert.match(html, /<th>후보<\/th><th>합계<\/th><th>중간<\/th><th>고난도<\/th><th>초고난도<\/th>/);
  assert.ok(html.includes('<tr><td>a</td><td>21/40 · 미채점 1</td><td>16/20</td><td>5/10</td><td>0/10 · 미채점 1</td>'), html);
  assert.ok(html.includes('<tr><td>b</td><td>7/10</td><td>7/10</td><td>—</td><td>—</td>'));
  assert.ok(html.includes('<tr><td>a</td><td>만들기</td><td>10/10</td><td>5/10</td><td>0/10</td></tr>'));
  assert.ok(html.includes('<tr><td>a</td><td>고치기</td><td>6/10</td><td>—</td><td>0/0 · 미채점 1</td></tr>'));
  assert.ok(!html.includes('<td>할일적기</td><td>10/10') && !html.includes('<td>돌려보기</td>'));
  assert.match(html, /Q1 할일적기 성적 제외/);
  assert.match(fs.readFileSync(path.join(out, 'comparison.csv'), 'utf8'), /"Q22","중간"/);
});
