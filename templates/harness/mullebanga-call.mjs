// 공용 물레방아의 도구 부르기: codex·gemini(agy)·claude를 같은 입력으로 부르고 같은 모양으로 돌려준다.
// 성공은 { ok: true, result }, 실패는 { ok: false, reason, detail }이고 reason은 시간초과·한도·권한·결과없음·실패 중 하나다.
// 도구가 실패해도 던지지 않는다(폴백은 부르는 쪽이 고른다). 입력이 틀렸을 때만 던진다. 한 번 부를 뿐 되풀이하지 않고 커밋도 하지 않는다.
// 판정은 종료 코드가 아니라 결과가 있는지로 한다: 멈춰 죽인 codex가 exit 0이었고 결과 파일이 없었다(T-143 실험).
// 선택 입력: agent·logFile(제미나이만), wrap(모든 도구, 실행 파일 앞에 붙는 명령 배열. 예 sandbox-exec -f 규칙).
// stdin은 닫는다: 닫지 않으면 codex가 "Reading additional input from stdin..."에서 끝없이 기다린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DETAIL_TAIL = 2000;
const KILL_GRACE_MS = 2000;
const LIMIT_PATTERN = /usage limit|quota exceeded|rate limit|UsageLimitExceeded|RateLimitExceeded|QuotaExceeded/i;
const EFFORT_IN_MODEL = /-(low|medium|high)$/;
const SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });

const plainObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const optional = (flag, value) => (value ? [flag, value] : []);

// JSON이 아닌 글은 결과가 없는 것으로 본다.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// 도구마다: 실행 파일(command), 인자(args), 끝난 뒤 결과 읽기(read), 도는 중 일찍 멈출 이유(earlyStop, 선택), 결과가 있어도 끝에 멈출 이유(finalStop, 선택).
// read는 { result }(결과 있음), { failed: true }(도구가 오류를 알림), {}(결과 없음) 중 하나를 돌려준다.
const TOOLS = {
  codex(call, dir) {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(call.schema));
    const args = ['exec', '-s', call.write ? 'workspace-write' : 'read-only', '-C', call.cwd, '--json', '--output-schema', schemaFile, '-o', outFile,
      ...optional('-m', call.model), ...optional('-c', call.effort && `model_reasoning_effort="${call.effort}"`), '--', call.prompt];
    // 끝났는데 turn.failed를 찍었으면 결과 파일이 있어도 실패다. 보통 파일이 아닌 -o 경로(FIFO·폴더)는 읽지 않는다: FIFO는 읽기에서 멈춘다.
    const failedTurn = out => out.split('\n').map(parseJson).some(line => plainObject(line)?.type === 'turn.failed');
    const read = out => {
      if (failedTurn(out)) return { failed: true };
      if (!fs.existsSync(outFile) || !fs.statSync(outFile).isFile()) return {};
      return { result: plainObject(parseJson(fs.readFileSync(outFile, 'utf8'))) };
    };
    return { command: 'codex', args, read };
  },
  gemini(call, dir) {
    const schemaFile = path.join(dir, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(call.schema));
    const showEffort = call.effort && !EFFORT_IN_MODEL.test(call.model ?? '');
    const args = ['-p', call.prompt, '--output-format', 'stream-json', '--json-schema', schemaFile, '--print-timeout', `${Math.ceil(call.timeoutMs / 1000)}s`,
      ...optional('--model', call.model), ...optional('--effort', showEffort && call.effort), ...optional('--agent', call.agent), ...optional('--log-file', call.logFile)];
    const events = out => out.split('\n').map(parseJson).filter(plainObject);
    // 권한 없는 도구는 헤드리스에서 조용히 거절되고 exit 0이 되므로, 쓰기 단계는 시작 줄의 권한 모드를 보고 곧바로 멈춘다.
    // 끝났는데 시작 줄이나 그 칸이 없었으면 권한을 확인하지 못한 것이라 성공으로 넘기지 않는다(finalStop).
    const mode = out => events(out).find(line => line.event === 'init')?.init?.permission_mode;
    const denied = seen => ({ reason: '권한', detail: `agy 권한 모드가 ${seen ?? '확인되지 않음'}라 쓰기 도구가 거절될 수 있다(always-proceed가 아님)` });
    const earlyStop = out => (call.write && mode(out) && mode(out) !== 'always-proceed' ? denied(mode(out)) : undefined);
    const finalStop = out => (call.write && mode(out) !== 'always-proceed' ? denied(mode(out)) : undefined);
    const read = out => {
      const final = events(out).findLast(line => line.event === 'result')?.result;
      if (!final) return {};
      if (final.status !== 'SUCCESS' || final.error) return { failed: true };
      return { result: plainObject(final.structured_output) };
    };
    return { command: 'agy', args, read, earlyStop, finalStop };
  },
  claude(call) {
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(call.schema), '--permission-mode', call.write ? 'acceptEdits' : 'plan',
      '--permission-prompts', 'none', '--no-session-persistence', '--settings', SANDBOX_SETTINGS,
      ...optional('--model', call.model), ...optional('--effort', call.effort),
      ...(call.allowedTools?.length ? ['--allowedTools', ...call.allowedTools] : []), '--', call.prompt];
    const read = out => {
      const envelope = plainObject(parseJson(out.trim()));
      if (envelope?.is_error) return { failed: true };
      return { result: plainObject(envelope?.structured_output) };
    };
    return { command: 'claude', args, read };
  },
};

const tail = text => text.trim().slice(-DETAIL_TAIL);

// 자식을 프로세스 그룹째 멈춘다. 자손이 남지 않게 한다.
// 그룹에 거두어지지 않은 좀비만 남으면 macOS가 ESRCH 대신 EPERM을 던진다(2026-10-24 재현). 멈출 것이 없다는 같은 뜻이다.
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

// 끝날 때까지 기다려 { code, out, err, stopped, spawnError }를 돌려준다. stopped는 우리가 멈춘 이유로, 종료 코드보다 먼저 본다.
function run(spec, call) {
  return new Promise(resolve => {
    // wrap은 실행 파일 앞에 붙는 명령이다(예: sandbox-exec -f 규칙). 자식 프로세스 그룹은 그대로 만들어진다.
    const argv = [...(call.wrap ?? []), spec.command, ...spec.args];
    const child = spawn(argv[0], argv.slice(1), { cwd: call.cwd, env: call.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { out: '', err: '', stopped: undefined };
    let killer;
    const stop = (reason, detail) => {
      if (state.stopped) return;
      state.stopped = { reason, detail };
      killGroup(child, 'SIGTERM');
      killer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('시간초과', `${call.timeoutMs}ms 안에 끝나지 않아 멈췄다`), call.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      state.out += chunk;
      const early = spec.earlyStop?.(state.out);
      if (early) stop(early.reason, early.detail);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { state.err += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ...state, spawnError: error });
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killer);
      // 부모가 SIGTERM에 먼저 끝나도 SIGTERM을 무시하는 자손이 남을 수 있어, 우리가 멈춘 호출이면 그룹을 바로 끊는다.
      if (state.stopped) killGroup(child, 'SIGKILL');
      resolve({ ...state, code });
    });
  });
}

function judge(spec, finished) {
  if (finished.spawnError) return { ok: false, reason: '실패', detail: `${spec.command} 실행 못 함: ${finished.spawnError.message}` };
  if (finished.stopped) return { ok: false, ...finished.stopped };
  const read = spec.read(finished.out);
  if (finished.code !== 0 || read.failed) {
    const text = `${finished.out}\n${finished.err}`;
    return { ok: false, reason: LIMIT_PATTERN.test(text) ? '한도' : '실패', detail: tail(text) || `종료 코드 ${finished.code}` };
  }
  if (!read.result) return { ok: false, reason: '결과없음', detail: `${spec.command}가 읽을 수 있는 JSON 객체 결과 없이 끝났다: ${tail(finished.out)}` };
  const late = spec.finalStop?.(finished.out);
  if (late) return { ok: false, ...late };
  return { ok: true, result: read.result };
}

export async function callTool(call) {
  if (!Object.hasOwn(TOOLS, call.tool)) throw new Error(`모르는 도구: ${call.tool}`);
  if (!fs.existsSync(call.cwd) || !fs.statSync(call.cwd).isDirectory()) throw new Error(`작업 폴더가 없다: ${call.cwd}`);
  if (typeof call.prompt !== 'string' || !call.prompt.trim()) throw new Error('지시문이 비었다');
  if (!plainObject(call.schema)) throw new Error('schema는 객체여야 한다');
  if (!(call.timeoutMs > 0)) throw new Error('timeoutMs가 필요하다');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-call-'));
  try {
    const spec = TOOLS[call.tool](call, dir);
    return judge(spec, await run(spec, call));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const agentapiPath = home => path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agentapi');
export const onPath = (name, searchPath = '') => searchPath.split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, name)));
export const intact = (file, backup) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true && fs.readFileSync(file).equals(fs.readFileSync(backup));

// 쓰기는 allowed 칸(sandbox-exec 규칙 조각, 예 `(subpath "/a")`)만 연다. 제미나이 자체에는 쓰기를 폴더로 묶는 장치가 없어 프로세스 권한으로 묶는다.
export function sandboxWrap(rulesFile, allowed) {
  fs.writeFileSync(rulesFile, ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* ${allowed.join(' ')})`].join('\n'));
  return ['sandbox-exec', '-f', rulesFile];
}

// 제미나이 쓰기 호출: 쓰기를 작업 폴더(call.cwd)·임시 폴더·/dev·로그로 묶는다. 워크트리의 git 폴더는 열지 않는다(커밋은 부르는 코드가 한다).
// 진짜 홈의 agentapi 한 파일은 agy가 명령 도구를 돌릴 때마다 다시 써서 열고(2026-10-23 사용자 결정), 끝난 뒤 그대로인지 본다.
export async function callWritingGemini(call) {
  const env = call.env ?? process.env;
  if (!onPath('sandbox-exec', env.PATH)) return { ok: false, reason: '권한', detail: 'sandbox-exec가 없어 제미나이 쓰기를 작업 폴더로 묶을 수 없다' };
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mullebanga-write-')));
  try {
    const tmpDir = path.join(tmp, 'tmp');
    fs.mkdirSync(tmpDir);
    const log = path.join(tmp, 'agy.log');
    const agentapi = agentapiPath(fs.realpathSync(env.HOME ?? os.homedir()));
    const guarded = fs.existsSync(agentapi);
    const backup = path.join(tmp, 'agentapi.bak');
    if (guarded) fs.copyFileSync(agentapi, backup);
    const allowed = [`(subpath "${fs.realpathSync(call.cwd)}")`, `(subpath "${tmpDir}")`, `(literal "${log}")`, '(subpath "/dev")', ...(guarded ? [`(literal "${agentapi}")`] : [])];
    const res = await callTool({ ...call, env: { ...env, TMPDIR: tmpDir }, logFile: log, wrap: sandboxWrap(path.join(tmp, 'sb.sb'), allowed) });
    if (guarded && !intact(agentapi, backup)) return { ok: false, reason: '권한', detail: '제미나이 쓰기 뒤 진짜 홈 agentapi가 바뀜' };
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
