#!/usr/bin/env node
// 본체 밖 조사·쪼개기·고르기·한일적기도 같은 선택기와 실제 호출 기록을 사용한다.
// stdin: { prompt, schema, task?, timeoutMs? }. stdout: 실제 도구·모델·추론과 호출 결과.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readConfig, stageOptions } from './mullebanga-steps.mjs';
import { modelOptions, trackedCall, enabled } from './mullebanga-model.mjs';
import { sampleId } from './mullebanga-stats.mjs';
import { hasTool } from './mullebanga-call.mjs';

export async function runDirect({ root, id, stage, tool, input, env = process.env, external = false }) {
  if (!['조사', '쪼개기', '고르기', '할일적기', '맞춰보기', '돌려보기', '한일적기'].includes(stage)) throw new Error('직접 호출은 읽기 전용 단계만 받는다');
  const config = readConfig(root);
  const plan = external && enabled(config) ? ['codex', 'claude'] : [tool];
  const attempts = [];
  const seen = new Set();
  for (const calledTool of plan) {
    const actual = stageOptions(config, stage, calledTool, input.task).tool;
    if (seen.has(actual) || (Object.hasOwn(config.limits, actual) && !(config.limits[actual] > 0)) || !hasTool(actual, env)) continue;
    seen.add(actual);
    const selection = await modelOptions(config, stage, calledTool, input.task, sampleId(root, id), env);
    if (external && stage === '조사' && selection.tool === 'claude' && !selection.managed) {
      selection.model = config.stages.조사?.폴백모델 ?? 'sonnet';
      selection.effort = config.stages.조사?.폴백추론 ?? 'medium';
    }
    const call = { ...selection, cwd: root, prompt: input.prompt, schema: input.schema, timeoutMs: input.timeoutMs ?? 900000, write: false, env };
    if (selection.tool === 'claude') call.allowedTools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
    if (selection.tool === 'gemini') Object.assign(call, { agent: stage === '조사' ? 'research' : 'readonly', env: { ...env, HARNESS_READ_ONLY: '1' } });
    const result = await trackedCall({ config, root, id, stage, selection, call, env });
    attempts.push({ tool: selection.tool, model: selection.model, effort: selection.effort, ...result });
    if (result.ok || result.reason === '권한') break;
  }
  return { attempts, ok: attempts.at(-1)?.ok ?? false };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 도구: { type: 'string' }, 단계: { type: 'string' }, 작업: { type: 'string' }, 외부조사: { type: 'boolean' } } });
    if (!values.작업 || !['codex', 'claude', 'gemini'].includes(values.도구)) throw new Error('--작업과 --도구가 필요하다');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = await runDirect({ root, id: values.작업, stage: values.단계, tool: values.도구, input: JSON.parse(fs.readFileSync(0, 'utf8')), external: values.외부조사 });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`mullebanga-direct: ${error.message}`);
    process.exitCode = 1;
  }
}
