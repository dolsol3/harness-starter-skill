import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rolePrompt, specPrompt, specReviewPrompt, buildPrompt, reviewPrompt, fixPrompt, evidencePrompt, schemas } from '../templates/harness/mullebanga-prompts.mjs';

const ROLES = ['planner', 'reviewer', 'implementer'];
const front = role => `---\nname: ${role}\ndescription: ${role} 설명\ntools: Read, Bash\n---\n`;

// 역할 파일(머리말 + 본문)을 가진 임시 저장소 폴더. 진짜 도구는 부르지 않는다.
function rootWith(t, roles = ROLES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  for (const role of roles) fs.writeFileSync(path.join(root, '.claude', 'agents', `${role}.md`), `${front(role)}\n${role} 본문 시작\n---\n${role} 본문 끝\n`);
  return root;
}

test('역할 안내문: 머리말은 빼고 본문을 지시문 앞에 붙이며 본문 안의 --- 줄은 남긴다', t => {
  const text = rolePrompt(rootWith(t), 'planner', '지시문입니다');
  assert.ok(!text.includes('name: planner'));
  assert.ok(!text.includes('tools: Read, Bash'));
  assert.ok(text.startsWith('planner 본문 시작\n---\nplanner 본문 끝'));
  assert.ok(text.indexOf('planner 본문 끝') < text.indexOf('지시문입니다'));
});

test('역할 파일이 없으면 파일 경로를 말하며 멈춘다', t => {
  const root = rootWith(t, ['reviewer', 'implementer']);
  assert.throws(() => rolePrompt(root, 'planner', 'x'), error => error instanceof Error && error.message.includes('planner.md'));
  assert.throws(() => specPrompt(root, 'T-9'), /planner\.md/);
});

// 모든 type:object 칸이 Codex 엄격 조건을 지키는지 재귀로 훑는다.
function strictProblems(node, where) {
  if (Array.isArray(node)) return node.flatMap((item, index) => strictProblems(item, `${where}[${index}]`));
  if (node === null || typeof node !== 'object') return [];
  const found = [];
  if (node.type === 'object') {
    const keys = node.properties ? Object.keys(node.properties) : null;
    if (!keys) found.push(`${where}: properties 없는 열린 객체`);
    else if (node.additionalProperties !== false) found.push(`${where}: additionalProperties:false 없음`);
    else if ([...(node.required ?? [])].sort().join() !== [...keys].sort().join()) found.push(`${where}: required가 모든 칸과 다름`);
  }
  return [...found, ...Object.entries(node).flatMap(([key, value]) => strictProblems(value, `${where}.${key}`))];
}

test('모든 결과 모양이 Codex 엄격 조건을 지킨다', () => {
  assert.deepEqual(Object.keys(schemas).sort(), ['BUILT', 'CHECKED', 'EVIDENCE', 'FINDING', 'FIXED', 'OTHER_REVIEWED', 'REVIEWED', 'SPEC', 'SPEC_REVIEWED']);
  assert.deepEqual(strictProblems(schemas, 'schemas'), []);
});

test('엄격 조건 검사가 어긴 모양은 잡는다', () => {
  assert.equal(strictProblems({ type: 'object' }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { x: {} }, required: ['x'] }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { x: {}, y: {} }, required: ['x'], additionalProperties: false }, 'a').length, 1);
  assert.equal(strictProblems({ type: 'object', properties: { list: { type: 'array', items: { type: 'object' } } }, required: ['list'], additionalProperties: false }, 'a').length, 1);
});

test('SPEC 칸: 작업 문서 글과 허락·확인·기록 줄을 받고 agents는 없다', () => {
  const { SPEC, BUILT, FIXED, EVIDENCE } = schemas;
  assert.deepEqual(Object.keys(SPEC.properties), ['outcome', 'reason', 'rejectedCommit', 'rejectedReason', 'pendingQuestions', 'specText', 'asks']);
  assert.ok(!('agents' in SPEC.properties));
  assert.deepEqual(Object.keys(SPEC.properties.asks.items.properties), ['kind', 'option', 'title', 'description', 'choices', 'recommend', 'reason']);
  assert.deepEqual(SPEC.properties.asks.items.properties.kind.enum, ['허락', '확인', '기록']);
  assert.deepEqual(Object.keys(BUILT.properties), ['summary']);
  assert.deepEqual(Object.keys(FIXED.properties), ['summary']);
  assert.deepEqual(Object.keys(EVIDENCE.properties), ['items', 'unconfirmed']);
  assert.deepEqual(Object.keys(EVIDENCE.properties.items.items.properties), ['no', 'evidence']);
  assert.ok(!('RAISED' in schemas));
});

test('specPrompt: 읽기 전용이라 asks·specText로 돌려받고 일감 목록 명령을 쓰라고 하지 않는다', t => {
  const text = specPrompt(rootWith(t), 'T-9');
  for (const part of ['T-9', '보기 T-9', '`## 끝 기준`이 이미 있으면', '한 글자도 바꾸지 않', '파일을 쓰지 않고', 'asks', 'specText', '[대기]', '실험 필요']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /backlog\.mjs (허락|확인|기록)/);
  assert.ok(text.indexOf('planner 본문 끝') < text.indexOf('T-9'));
});

test('나머지 지시문: 작업 번호와 해당 역할 본문이 있다', t => {
  const root = rootWith(t);
  const cases = [
    [specReviewPrompt(root, 'T-9'), 'reviewer'],
    [buildPrompt(root, 'T-9'), 'implementer'],
    [reviewPrompt(root, 'T-9', 'main'), 'reviewer'],
    [fixPrompt(root, 'T-9', { passed: true, failures: '' }, []), 'implementer'],
    [evidencePrompt(root, 'T-9', 'abc123'), 'implementer'],
  ];
  for (const [text, role] of cases) {
    assert.ok(text.startsWith(`${role} 본문 시작`), role);
    assert.ok(text.includes('T-9'));
    assert.ok(text.includes('JSON 한 덩어리'));
  }
});

const NO_ACTION = [/git switch -c/, /git checkout -b (?!하지)/, /backlog\.mjs 올림/, /커밋한다/, /커밋하고/];

test('buildPrompt: 커밋도 브랜치 바꾸기도 올림도 시키지 않고 반려면 커밋과 사유를 담는다', t => {
  const root = rootWith(t);
  const plain = buildPrompt(root, 'T-9');
  for (const re of NO_ACTION) assert.doesNotMatch(plain, re);
  assert.ok(plain.includes('커밋하지 않는다'));
  assert.ok(plain.includes('브랜치를 바꾸지 않는다'));
  assert.ok(!plain.includes('반려 커밋'));
  const again = buildPrompt(root, 'T-9', { commit: 'def456', reason: '시험이 빠졌다' });
  assert.ok(again.includes('반려 커밋: def456'));
  assert.ok(again.includes('반려 사유: 시험이 빠졌다'));
});

test('fixPrompt: 돌려보기 실패와 높음 지적만 담고 커밋하지 않게 한다', t => {
  const highs = [{ level: '높음', text: '높음 문제 하나' }, { level: '중간', text: '중간 문제 하나' }, { level: '낮음', text: '낮음 문제 하나' }];
  const text = fixPrompt(rootWith(t), 'T-9', { passed: false, failures: 'npm test 실패 출력' }, highs);
  assert.ok(text.includes('npm test 실패 출력'));
  assert.ok(text.includes('높음 문제 하나'));
  assert.ok(!text.includes('중간 문제 하나'));
  assert.ok(!text.includes('낮음 문제 하나'));
  for (const re of NO_ACTION) assert.doesNotMatch(text, re);
  assert.ok(text.includes('커밋하지 않는다'));
  assert.ok(text.includes('브랜치를 바꾸지 않는다'));
});

test('evidencePrompt: 읽기 전용이고 올림 명령을 시키지 않으며 EVIDENCE 모양으로만 돌려받는다', t => {
  const text = evidencePrompt(rootWith(t), 'T-9', 'abc123');
  for (const part of ['파일을 쓰지 않고', 'abc123', 'items', 'unconfirmed', 'JSON 한 덩어리']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /backlog\.mjs 올림/);
  assert.ok(text.indexOf('implementer 본문 끝') < text.indexOf('abc123'));
});
