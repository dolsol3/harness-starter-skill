// https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts
// https://code.claude.com/docs/en/agent-sdk/typescript · /cost-tracking
// https://antigravity.google/docs/cli/headless/ (2026-11-03). init.model은 실행 설정이다.
const FIELDS = {
  codex: ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'],
  gemini: ['input_tokens', 'cache_read_tokens', null, 'output_tokens', 'thinking_tokens'],
  claude: ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'output_tokens_details.thinking_tokens'],
  claudeModel: ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'thinkingTokens'],
};
export const commandSucceeded = run => run.exitCode === 0 || (run.exitCode === null && run.toolStatus === 'success');
export const examScript = command => command?.match(/^node (?:--test )?(public\.test\.mjs|repro[\w.-]*\.mjs)$/)?.[1] ?? null;
export function reproductionFile(command) {
  const script = examScript(command);
  if (script?.startsWith('repro')) return script;
  const direct = command?.match(/^node --input-type=module -e "await import\('\.\/(repro[\w.-]*\.mjs)'\)"$/);
  const wrapped = command?.match(/^\/(?:bin|usr\/bin)\/(?:zsh|bash|sh) -lc "node --input-type=module -e \\"await import\('\.\/(repro[\w.-]*\.mjs)'\)\\""$/);
  return direct?.[1] ?? wrapped?.[1] ?? null;
}
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
// 단독 Node 명령의 알려진 CLI 셸 포장만 벗긴다. 복합 셸은 원문으로 남긴다.
function commandTrace(rawCommand, exitCode, stdout, toolStatus, exitSource) {
  const wrapped = rawCommand?.match(/^\/(?:bin|usr\/bin)\/(?:zsh|bash|sh) -lc (['"])(node [\w./ -]+)\1$/);
  const command = wrapped?.[2] ?? rawCommand;
  const row = {command, rawCommand, exitCode, stdout, stderr:'', toolStatus, exitSource};
  const mode = command?.match(/^node check\.mjs (pass|fail)$/)?.[1];
  for (const line of stdout.split('\n')) {
    if (!mode || !line.startsWith('EXAM_CHECK_RESULT:')) continue;
    const observed = parse(line.slice('EXAM_CHECK_RESULT:'.length));
    if (observed?.mode === mode && Number.isInteger(observed.exitCode)) {
      row.observedExitCode = observed.exitCode;
      row.observationSource = 'check.mjs process exit event';
    }
  }
  return row;
}
export function meter(tool) {
  let pending = '';
  let final;
  const steps = new Map();
  const turns = [];
  const tools = new Map();
  const traces = new Map();
  const commands = new Map();
  const openedSources = [];
  let configuredModel = null;
  function event(e) {
    if (!e || typeof e !== 'object') return;
    if (tool === 'codex') {
      const item = e.type === 'item.completed' && e.item;
      if (item?.type === 'command_execution' && Number.isInteger(item.exit_code)) {
        traces.set(item.id, commandTrace(item.command,item.exit_code,item.aggregated_output ?? '',item.exit_code===0?'success':'error','item.exit_code'));
      }
      if (item?.type === 'web_search' && item.action?.type === 'open_page' && !item.error) {
        for (const result of item.results ?? []) {
          if (result.type === 'text_result' && result.url && result.ref_id && result.snippet?.trim()) openedSources.push(result.url);
        }
      }
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
        if (step.step_type === 'tool' && step.tool_name && step.state === 'DONE') {
          tools.set(key, step.tool_name);
          const info=step.tool_info ?? {};
          const output=typeof info.output==='string'?info.output:'';
          traces.set(key,{name:step.tool_name,...info});
          if (step.tool_name==='run_command' && info.parameters?.CommandLine) {
            const match=output.match(/^(?:(?:Created|Completed) At:[^\n]*\r?\n)*Command exited with code (-?\d+)\./);
            const code=match?Number(match[1]):null;
            commands.set(key,commandTrace(info.parameters.CommandLine,code,output,info.error?'error':code===0?'success':code===null?'unknown':'error',match?'tool_info.output exit header':null));
          }
          if (step.tool_name==='read_url_content' && info.parameters?.Url && !info.error && output.trim()) openedSources.push(info.parameters.Url);
        }
      }
    }
    if (tool === 'claude') {
      if (e.type === 'result') final = e;
      for (const block of e.message?.content ?? []) {
        if (block.type === 'tool_use') tools.set(block.id, { name: block.name, input: block.input });
        if (block.type !== 'tool_result') continue;
        const intent = tools.get(block.tool_use_id);
        if (!intent) continue;
        const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        traces.set(block.tool_use_id, { ...intent, output, isError: block.is_error === true });
        if (intent.name === 'Bash') {
          const match=output.match(/^Exit code:? (-?\d+)(?:\r?\n|$)/);
          const code=Number.isInteger(block.exit_code)?block.exit_code:match?Number(match[1]):null;
          commands.set(block.tool_use_id,commandTrace(intent.input.command,code,output,block.is_error?'error':'success',Number.isInteger(block.exit_code)?'tool_result.exit_code':match?'tool_result exit header':null));
        }
        if (intent.name === 'WebFetch' && !block.is_error && output.trim() && intent.input.url) openedSources.push(intent.input.url);
      }
    }
  }
  return {
    chunk(text) {
      pending += text;
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
      for (const [id, entry] of tools) {
        if (tool === 'claude' && !traces.has(id)) continue;
        const kind = typeof entry === 'string' ? entry : entry.name;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return {
        actualModels: perModel.length ? perModel.map(p => p.model) : null,
        modelSource: perModel.length ? 'result.modelUsage keys' : null,
        modelMissingReason: perModel.length ? null : '처리 모델 필드 미제공; 요청값·init 설정으로 대체하지 않음',
        configuredModel,
        nativeFinalResponse: tool === 'gemini' ? final?.response ?? null : null,
        actualEffort: null, effortMissingReason: '처리 추론을 확인하는 CLI 필드 미확인',
        usage: { records, perModel, partial: !ok || !records.length || (tool !== 'codex' && !final?.usage),
          aggregation: tool === 'codex' ? 'disjoint-turns' : final?.usage ? 'latest-result' : 'observed-steps',
          perModelRelation: '별도 관점; records와 합산하지 않음',
          missingReason: records.length ? null : '종료 전 usage 미제공',
          inclusionNote: tool === 'gemini' ? '캐시의 입력 포함 관계 미확인; 합계 환산하지 않음' : null },
        evidence: { commands: tool === 'codex' ? [...traces.values()] : [...commands.values()], openedSources },
        traces: [...traces.entries()],
        toolExecutions: { counts, partial: !ok || (tool === 'claude' && tools.size !== traces.size),
          source: tool === 'codex' ? 'item.completed (id 중복 제외)' : tool === 'gemini' ? 'step_update (conversation_id·step_index 중복 제외)' : 'assistant.tool_use + user.tool_result',
          missingReason: !tools.size ? '도구 실행 흔적 미수집' : null },
      };
    },
  };
}
