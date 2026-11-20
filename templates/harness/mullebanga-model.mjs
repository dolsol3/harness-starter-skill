// 직접 호출과 공용 실행기가 함께 쓰는 선택·기록 경계. 호출 성공과 작성 품질은 별도로 남긴다.
import path from 'node:path';
import { groupOf } from './mullebanga-policy.mjs';
import { selectModel, recordCall, sampleId, newCallId } from './mullebanga-stats.mjs';
import { callTool, callWritingGemini } from './mullebanga-call.mjs';
import { stageOptions, stageSetting, fits } from './mullebanga-steps.mjs';

export const enabled = config => config.auto?.사용 === true;
export function automaticStage(config, stage, tool) {
  if (!enabled(config)) return false;
  const { hit, profiled } = stageSetting(config, stage, tool);
  return !hit.도구 && !hit.tool && hit.자동 !== false && (hit.자동 === true || (profiled ? config.auto.프로필 === '자동' : config.auto.기본단계 === '자동'));
}
export async function modelOptions(config, stage, tool, task, sample, env = process.env) {
  const base = stageOptions(config, stage, tool, task);
  if (!enabled(config) || !groupOf(stage)) return base;
  const explicitTask = ['만들기', '고치기'].includes(stage) && task?.tool === base.tool && (task.model || task.effort);
  if (explicitTask || !automaticStage(config, stage, tool)) return base;
  return selectModel({ tool: base.tool, stage, sample, env, rescue: stage === '고치기' });
}
export async function outsideOptions(config, author, tool, sample, env) {
  if (!automaticStage(config, '번갈아보기', author)) return undefined;
  return selectModel({ tool, stage: '번갈아보기', sample, env });
}
function tokenCount(text) {
  const events = text.split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
  });
  const usage = events.map(event => event.usage ?? event.result?.usage).filter(Boolean).at(-1);
  if (!usage) return null;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  if (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) return usage.input_tokens + usage.output_tokens;
  return null;
}
export async function trackedCall({ config, root, id, stage, selection, call, env = process.env }) {
  if (!enabled(config)) return (call.tool === 'gemini' && call.write && !call.wrap ? callWritingGemini : callTool)(call);
  let out = '';
  const started = Date.now();
  const res = await (call.tool === 'gemini' && call.write && !call.wrap ? callWritingGemini : callTool)({ ...call, observe: (stream, chunk) => {
    if (stream === 'stdout') out += chunk;
    call.observe?.(stream, chunk);
  } });
  if (!res.ok && /unsupported model|unknown model|invalid model|model.*not.*(?:found|supported)/i.test(res.detail)) res.reason = '미지원';
  const ok = res.ok && fits(call.schema, res.result);
  const skipped = ok && (res.result.outcome === '건너뜀' || res.result.outcome === '허락' || res.result.outcome === '실험 필요' || res.result.pendingQuestions?.length || res.result.asks?.some(ask => ask.kind === '허락'));
  const group = groupOf(stage);
  await recordCall({ project: path.basename(root), tool: call.tool, group, stage, model: call.model ?? null, effort: call.effort ?? null,
    elapsedMs: Date.now() - started, tokens: tokenCount(out), ok, escalated: selection?.escalated === true,
    sampleId: sampleId(root, id), callId: newCallId(), managed: selection?.managed === true,
    firstPass: group === '구현' || skipped || ['권한', '한도', '미지원'].includes(res.reason) ? null : ok,
    quality: null, qualityAt: Date.now(), status: ok ? (skipped ? '건너뜀' : '완료') : res.reason ?? '스키마',
  }, env);
  return res.ok && !ok ? { ok: false, reason: '결과없음', detail: '결과 모양이 스키마와 다르다' } : res;
}
