import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { meter, commandSucceeded } from './model-exam-meter.mjs';

export function fileState(cwd) {
  return Object.fromEntries(fs.readdirSync(cwd, { recursive: true }).filter(name=>!fs.lstatSync(path.join(cwd,name)).isDirectory()).sort().map(name => {
    const file = path.join(cwd, name);
    const stat = fs.lstatSync(file);
    const content = stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    return [name, JSON.stringify([stat.mode, content])];
  }));
}
export function scopeChanges(before, cwd, allowed) {
  const after = fileState(cwd);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name] && !allowed.test(name));
}
// 시험 사본의 부모 프로세스에서만 쓴다. CLI 자식의 sandbox 쓰기 범위를 넓히지 않는다.
export async function observeCall(call, invoke) {
  call = { ...call, prompt: call.prompt + (process.env.EXAM_PROMPT_SUFFIX ?? '') };
  if (call.prompt.length + JSON.stringify(call.schema).length > Number(process.env.EXAM_MAX_INPUT)) return { ok: false, reason: '입력 예산', detail: '입력 글자 상한' };
  const root = process.env.EXAM_OBSERVE;
  const index = fs.readdirSync(root).filter(name => name.startsWith('call-')).length;
  if (index >= Number(process.env.EXAM_CALL_LIMIT)) return { ok: false, reason: '예산', detail: 'Q10 모델 호출 상한' };
  const dir = path.join(root, `call-${String(index).padStart(3, '0')}`);
  fs.mkdirSync(dir);
  const telemetry = meter(call.tool);
  const started = performance.now();
  const files = Object.fromEntries(['stdout','stderr'].map(stream=>[stream,fs.openSync(path.join(dir,stream),'wx')]));
  fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({tool:call.tool,stage:call.examStage ?? '외부검토',cwd:call.cwd,result:{ok:false,reason:'미완료'},usage:{records:[],perModel:[],partial:true},elapsedMs:null}));
  let invocation;
  let result;
  const before = call.examStage && call.write ? fileState(call.cwd) : null;
  try {
    const env = Object.fromEntries(Object.entries(call.env ?? process.env).filter(([key]) => !key.startsWith('EXAM_')));
    result = await invoke({ ...call, env, streamJson: true,
      trace: value => { invocation = value; },
      observe(stream, chunk) {
        fs.writeSync(files[stream],chunk);
        if (stream === 'stdout') telemetry.chunk(chunk);
        call.observe?.(stream, chunk);
      } });
  } catch (error) {
    result = { ok: false, reason: '호출 예외', detail: error.stack ?? String(error), code: error.code };
  } finally {
    fs.writeFileSync(path.join(dir, 'prompt.txt'), call.prompt);
    for (const fd of Object.values(files)) fs.closeSync(fd);
    const measured = telemetry.finish(result?.ok === true);
    const dataSaved = measured.evidence.commands.some(run => commandSucceeded(run) && /^node cli\.mjs apply input\.csv store\.json /.test(run.command));
    const allowed = new RegExp('^(parse|store|cli)\\.mjs$|^repro[^/]*\\.mjs$' + (dataSaved ? '|^store\\.json$' : ''));
    const violations = before ? scopeChanges(before, call.cwd, allowed) : [];
    fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ tool: call.tool, model: call.model, effort: call.effort,
      scopeViolations: violations, promptHash: createHash('sha256').update(call.prompt).digest('hex'), schemaHash: createHash('sha256').update(JSON.stringify(call.schema)).digest('hex'), stage: call.examStage ?? '외부검토', cwd: call.cwd, invocation, result, elapsedMs: performance.now() - started,
      ...measured }));
  }
  return result;
}
