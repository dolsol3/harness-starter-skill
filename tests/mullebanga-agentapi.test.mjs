import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../templates/workflows/mullebanga.js', import.meta.url)), 'utf8');
const [metaHead] = source.match(/^export const meta = (\{[\s\S]*?\n\});\n/);
const AsyncFunction = (async () => {}).constructor;
const script = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', source.slice(metaHead.length));
const compare = source.match(/`(\[ -f <홈>[^`]+cmp [^`]+)`/)[1];
const onlyOnPosix = { skip: process.platform === 'win32' && 'sh와 cmp가 없다' };

// 지시문이 말하는 비교 명령을 임시 폴더에서 그대로 돌려, 보통 파일이고 내용이 같을 때만 통과하는지 본다.
const compareIn = (setup) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentapi-compare-'));
  const bin = path.join(dir, 'home', '.gemini', 'antigravity-cli', 'bin');
  const file = path.join(bin, 'agentapi');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(file, 'original\n');
  fs.copyFileSync(file, path.join(dir, 'agentapi.bak'));
  setup(file, dir);
  const { status } = spawnSync('sh', ['-c', compare.replaceAll('<홈>', path.join(dir, 'home')).replaceAll('<임시>', dir)]);
  fs.rmSync(dir, { recursive: true, force: true });
  return status;
};

test('the agentapi compare command passes only for the same regular file and fails for changed content, a symlink or a missing file', onlyOnPosix, () => {
  assert.equal(compareIn(() => {}), 0);
  assert.notEqual(compareIn(file => fs.writeFileSync(file, 'changed\n')), 0);
  assert.notEqual(compareIn((file, dir) => { fs.rmSync(file); fs.symlinkSync(path.join(dir, 'agentapi.bak'), file); }), 0);
  assert.notEqual(compareIn(file => fs.rmSync(file)), 0);
});

// 다른 도구 검토만 agentapiChanged를 돌려주는 가짜 agent로 한 작업을 돌린다.
async function runWith(otherReview) {
  const calls = [];
  const answers = {
    '기획 담당': () => ({ outcome: '썼음', reason: '', rejectedCommit: '', rejectedReason: '', pendingQuestions: [] }),
    '살피기 담당 맞춰보기': () => ({ passed: true, findings: [] }),
    '만들기 담당': () => ({ worktree: '/repo/w', worktreeBranch: 'worktree-wf_1', branch: 'ai/x', commit: 'c0' }),
    '돌려보기': () => ({ passed: true, failures: '' }),
    '살피기 담당': () => ({ findings: [] }),
    '다른 도구 검토': () => otherReview,
    '고치기': () => ({ commit: 'c1' }),
    '올림': () => ({ raised: true, output: 'ok' }),
  };
  const agent = async (prompt, opts) => { calls.push(opts.label); return answers[opts.label.replace(/ T-\d+.*$/, '')](prompt); };
  const pipeline = (items, ...stages) => Promise.all(items.map(async item => { let result = item; for (const stage of stages) result = await stage(result, item, 0); return result; }));
  const [result] = await script(agent, pipeline, thunks => Promise.all(thunks.map(thunk => thunk())), () => {}, () => {}, ['T-1']);
  return { result, calls };
}

test('a changed agentapi stops the task with the high finding kept: no fix, no second review, no 올림', async () => {
  const high = { level: '높음', text: '다른 도구 검토 뒤 진짜 홈 agentapi가 바뀜' };
  const { result, calls } = await runWith({ tool: 'gemini', findings: [high], agentapiChanged: true });
  assert.equal(result.stopped, true);
  assert.match(result.reason, /agentapi가 바뀜/);
  assert.deepEqual(result.highs, [high]);
  assert.deepEqual(calls.filter(label => /^(고치기|올림)|다른 도구 검토 T-1 2번째/.test(label)), []);
});

test('an unchanged agentapi leaves the task raised as before', async () => {
  const { result, calls } = await runWith({ tool: 'gemini', findings: [], agentapiChanged: false });
  assert.equal(result.stopped, undefined);
  assert.ok(calls.some(label => label.startsWith('올림')));
});
