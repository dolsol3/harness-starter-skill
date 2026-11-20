import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callTool, callWritingGemini } from '../templates/harness/mullebanga-call.mjs';

import { meter } from './model-exam-meter.mjs';
// 원시 스트림은 git 저장소 밖 새 폴더에만 쓴다. 인증 환경과 권한 설정은 공용 호출기에 그대로 넘긴다.
export function rawFolder(output) {
  if (typeof output !== 'string' || !output) throw new Error('--out 저장소 밖 폴더가 필요하다');
  const full = path.resolve(output);
  let parent = full;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  // Git 환경이 검사 대상 경로 대신 호출자의 저장소를 고르지 않게 한다.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    execFileSync('git', ['-C', fs.realpathSync(parent), 'rev-parse', '--absolute-git-dir'], { stdio: 'ignore', env });
  } catch (error) {
    if (error.status === 128) return full;
    throw error;
  }
  throw new Error('원시 출력은 git 저장소 밖이어야 한다');
}
export async function callExam(call, output) {
  const folder = rawFolder(output);
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  fs.mkdirSync(folder);
  const files = ['stdout', 'stderr'].map(stream => fs.openSync(path.join(folder, stream), 'wx'));
  const telemetry = meter(call.tool);
  const started = performance.now();
  let invocation;
  try {
    const invoke = call.tool === 'gemini' && call.write ? callWritingGemini : callTool;
    let result;
    try {
      result = await invoke({ ...call, streamJson: true, trace: value => { invocation = value; }, observe(stream, chunk) {
      fs.writeSync(files[stream === 'stdout' ? 0 : 1], chunk);
      if (stream === 'stdout') telemetry.chunk(chunk);
      call.observe?.(stream, chunk);
      } });
    } catch (error) {
      result = { ok: false, reason: '호출 예외', detail: error.stack ?? String(error), code: error.code };
    }
    fs.writeFileSync(path.join(folder, 'prompt.txt'), call.prompt);
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result));
    return { ok: result.ok, reason: result.reason, detail: result.detail, code: result.code, result: result.result, elapsedMs: performance.now() - started,
      promptHash: createHash('sha256').update(call.prompt).digest('hex'), schemaHash: createHash('sha256').update(JSON.stringify(call.schema)).digest('hex'), invocation, requested: { tool: call.tool, model: call.model ?? null, effort: call.effort ?? null }, ...telemetry.finish(result.ok) };
  } finally {
    for (const fd of files) fs.closeSync(fd);
  }
}
