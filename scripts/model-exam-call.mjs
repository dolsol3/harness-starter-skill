import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callTool, callWritingGemini } from '../templates/harness/mullebanga-call.mjs';

// https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
// https://code.claude.com/docs/en/agent-sdk/typescript · /cost-tracking
// https://antigravity.google/docs/cli/headless/ (2026-11-03). init.model은 실행 설정이다.
const FIELDS = {
  codex: ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'],
  gemini: ['input_tokens', 'cache_read_tokens', null, 'output_tokens', 'thinking_tokens'],
  claude: ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'output_tokens_details.thinking_tokens'],
  claudeModel: ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'thinkingTokens'],
};
const NAMES = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function record(tool, usage, source, scope, fields = FIELDS[tool]) {
  const values = {};
  const missing = {};
  for (const [index, name] of NAMES.entries()) {
    const field = fields[index];
    const value = field?.split('.').reduce((obj, key) => obj?.[key], usage);
    values[name] = number(value) ? value : null;
    if (values[name] === null) missing[name] = field ? `${source}.${field} 미제공` : 'CLI 필드 미확인';
  }
  return { source, scope, nativeUsage: usage, values, missing,
    cacheReadIncludedInInput: tool === 'codex' ? true : tool === 'claude' ? false : null,
    cacheWriteIncludedInInput: tool === 'codex' ? true : tool === 'claude' ? false : null,
    reasoningIncludedInOutput: true };
}
function parse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
function meter(tool) {
  let pending = '';
  let final;
  const steps = new Map();
  const turns = [];
  const tools = new Map();
  let configuredModel = null;
  function event(e) {
    if (!e || typeof e !== 'object') return;
    if (tool === 'codex') {
      if (e.type === 'turn.completed' && e.usage) turns.push(record(tool, e.usage, 'turn.completed.usage', 'turn'));
      if (e.type === 'item.completed' && e.item?.id && ['command_execution', 'web_search', 'mcp_tool_call', 'file_change'].includes(e.item.type)) tools.set(e.item.id, e.item.type);
    }
    if (tool === 'gemini') {
      if (e.event === 'init') configuredModel = e.init?.model ?? null;
      if (e.event === 'result') final = e.result;
      const step = e.event === 'step_update' && e.step_update;
      if (step && Number.isInteger(step.step_index)) {
        const key = `${step.conversation_id}:${step.step_index}`;
        if (step.state === 'DONE' && step.usage) steps.set(key, record(tool, step.usage, 'step_update.usage', 'step'));
        if (step.step_type === 'tool' && step.tool_name) tools.set(key, step.tool_name);
      }
    }
    if (tool === 'claude' && e.type === 'result') final = e;
  }
  return {
    chunk(text) {
      pending += text;
      if (tool === 'claude') return;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) event(parse(line));
    },
    finish(ok) {
      event(parse(pending));
      const records = final?.usage ? [record(tool, final.usage, tool === 'claude' ? 'result.usage' : 'result.result.usage', tool === 'claude' ? 'main-loop' : 'session')]
        : tool === 'codex' ? turns : [...steps.values()];
      const perModel = tool === 'claude' ? Object.entries(final?.modelUsage ?? {}).map(([model, u]) => ({ model,
        ...record(tool, u, `result.modelUsage[${JSON.stringify(model)}]`, 'model-including-subagents', FIELDS.claudeModel) })) : [];
      const counts = Object.create(null);
      for (const kind of tools.values()) counts[kind] = (counts[kind] ?? 0) + 1;
      return {
        actualModels: perModel.length ? perModel.map(p => p.model) : null,
        modelSource: perModel.length ? 'result.modelUsage keys' : null,
        modelMissingReason: perModel.length ? null : '처리 모델 필드 미제공; 요청값·init 설정으로 대체하지 않음',
        configuredModel,
        actualEffort: null, effortMissingReason: '처리 추론을 확인하는 CLI 필드 미확인',
        usage: { records, perModel, partial: !ok || !records.length || (tool !== 'codex' && !final?.usage),
          aggregation: tool === 'codex' ? 'disjoint-turns' : final?.usage ? 'latest-result' : 'observed-steps',
          perModelRelation: '별도 관점; records와 합산하지 않음',
          missingReason: records.length ? null : '종료 전 usage 미제공',
          inclusionNote: tool === 'gemini' ? '캐시의 입력 포함 관계 미확인; 합계 환산하지 않음' : null },
        toolExecutions: { counts: tool === 'claude' ? null : counts, partial: !ok,
          source: tool === 'codex' ? 'item.completed (id 중복 제외)' : tool === 'gemini' ? 'step_update (conversation_id·step_index 중복 제외)' : null,
          missingReason: tool === 'claude' ? '기존 json 출력은 일반 도구 실행 흔적을 제공하지 않음' : null },
      };
    },
  };
}
// 원시 스트림은 git 저장소 밖 새 폴더에만 쓴다. 인증 환경과 권한 설정은 공용 호출기에 그대로 넘긴다.
function rawFolder(output) {
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
  try {
    const invoke = call.tool === 'gemini' && call.write ? callWritingGemini : callTool;
    const result = await invoke({ ...call, observe(stream, chunk) {
      fs.writeSync(files[stream === 'stdout' ? 0 : 1], chunk);
      if (stream === 'stdout') telemetry.chunk(chunk);
      call.observe?.(stream, chunk);
    } });
    fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result));
    return { ok: result.ok, reason: result.reason, result: result.result, elapsedMs: performance.now() - started,
      requested: { tool: call.tool, model: call.model ?? null, effort: call.effort ?? null }, ...telemetry.finish(result.ok) };
  } finally {
    for (const fd of files) fs.closeSync(fd);
  }
}
