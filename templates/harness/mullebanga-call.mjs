// 공용 물레방아의 도구 부르기: codex·gemini(agy)·claude를 같은 입력으로 부르고 같은 모양으로 돌려준다.
// 성공은 { ok: true, result }, 실패는 { ok: false, reason, detail }이고 reason은 시간초과·한도·권한·결과없음·실패 중 하나다.
// 도구가 실패해도 던지지 않는다(폴백은 부르는 쪽이 고른다). 입력이 틀렸을 때만 던진다. 한 번 부를 뿐 되풀이하지 않고 커밋도 하지 않는다.
// 판정은 종료 코드가 아니라 결과가 있는지로 한다: 멈춰 죽인 codex가 exit 0이었고 결과 파일이 없었다(T-143 실험).
// 선택 입력: agent·logFile(제미나이만), wrap(실행 파일 앞 명령 배열), observe(stream, chunk)(stdout/stderr 관찰자).
// 지시문은 인자가 아니라 stdin으로 주고 쓴 뒤 닫는다: Windows는 명령줄이 32767자를 넘으면 도구를 못 띄우고, 닫지 않으면 codex가 "Reading additional input from stdin..."에서 끝없이 기다린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DETAIL_TAIL = 2000;
const KILL_GRACE_MS = 2000;
const VERSION_TIMEOUT_MS = 10000;
const IS_WINDOWS = process.platform === 'win32';
export const SPAWN_GROUP = { detached: !IS_WINDOWS, windowsHide: true }; // Windows의 detached는 windowsHide를 무시해 손자가 콘솔 창을 띄운다
const ENV_BIN = { codex: 'HARNESS_CODEX_BIN', gemini: 'HARNESS_GEMINI_BIN', claude: 'HARNESS_CLAUDE_BIN' };
const LIMIT_PATTERN = /usage limit|quota exceeded|rate limit|UsageLimitExceeded|RateLimitExceeded|QuotaExceeded/i;
const EFFORT_IN_MODEL = /-(low|medium|high)$/;
const SANDBOX_SETTINGS = JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } });

const plainObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined);
const optional = (flag, value) => (value ? [flag, value] : []);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// 글 안에서 마지막으로 성립하는 JSON 객체를 꺼낸다(agy는 같은 JSON을 response에 여러 번 담아 온다). 문자열 안의 중괄호는 세지 않는다.
const BRACES = /\\.|"(?:\\.|[^"\\])*"|[{}]/g;
function lastJsonObject(text) {
  const found = [];
  let depth = 0;
  let start = 0;
  for (const match of text.matchAll(BRACES)) {
    if (match[0] === '{') {
      if (depth++ === 0) start = match.index;
    } else if (match[0] === '}' && depth > 0 && --depth === 0) found.push(text.slice(start, match.index + 1));
  }
  return found.map(parseJson).filter(plainObject).at(-1);
}

// read는 { result }(결과 있음), { failed: true }(도구가 오류를 알림), {}(결과 없음) 중 하나를 돌려준다.
const TOOLS = {
  codex(call, { dir, bin }) {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(call.schema));
    const args = ['exec', '-s', call.write ? 'workspace-write' : 'read-only', '-C', call.cwd, '--json', '--output-schema', schemaFile, '-o', outFile,
      ...optional('-m', call.model), ...optional('-c', call.effort && `model_reasoning_effort="${call.effort}"`), '-'];
    // 끝났는데 turn.failed를 찍었으면 결과 파일이 있어도 실패다. 보통 파일이 아닌 -o 경로(FIFO·폴더)는 읽지 않는다: FIFO는 읽기에서 멈춘다.
    const failedTurn = out => out.split('\n').map(parseJson).some(line => plainObject(line)?.type === 'turn.failed');
    const read = out => {
      if (failedTurn(out)) return { failed: true };
      if (!fs.existsSync(outFile) || !fs.statSync(outFile).isFile()) return {};
      return { result: plainObject(parseJson(fs.readFileSync(outFile, 'utf8'))) };
    };
    return { command: 'codex', bin, args, stdin: call.prompt, read };
  },
  gemini(call, { dir, bin }) {
    const schemaFile = path.join(dir, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(call.schema));
    const showEffort = call.effort && !EFFORT_IN_MODEL.test(call.model ?? '');
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', schemaFile, '--print-timeout', `${Math.ceil(call.timeoutMs / 1000)}s`,
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
      // structured_output이 비면 response 글에서 JSON을 꺼낸다(같은 JSON이 여러 번 들어 와도 마지막 것을 쓴다).
      return { result: plainObject(final.structured_output) ?? lastJsonObject(String(final.response ?? '')) };
    };
    // agy는 일반 텍스트 stdin을 받지 않아 stream-json 입력(NDJSON 한 줄)으로 준다.
    const stdin = `${JSON.stringify({ event: 'user', message: { content: call.prompt } })}\n`;
    return { command: 'agy', bin, args, stdin, read, earlyStop, finalStop };
  },
  claude(call, { bin }) {
    const permissionPrompts = flagSupported(bin, '--permission-prompts') ? ['--permission-prompts', 'none'] : [];
    const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(call.schema), '--permission-mode', call.write ? 'acceptEdits' : 'plan',
      ...permissionPrompts, '--no-session-persistence', '--settings', SANDBOX_SETTINGS,
      ...optional('--model', call.model), ...optional('--effort', call.effort),
      ...(call.allowedTools?.length ? ['--allowedTools', ...call.allowedTools] : [])];
    const read = out => {
      const envelope = plainObject(parseJson(out.trim()));
      if (envelope?.is_error) return { failed: true };
      return { result: plainObject(envelope?.structured_output) };
    };
    return { command: 'claude', bin, args, stdin: call.prompt, read };
  },
};

const tail = text => text.trim().slice(-DETAIL_TAIL);

// 그룹에 거두어지지 않은 좀비만 남으면 macOS가 ESRCH 대신 EPERM을 던진다(2026-10-24 재현). 멈출 것이 없다는 같은 뜻이다.
// Windows에는 프로세스 그룹이 없어 taskkill /T로 트리째 끈다. /T는 살아 있는 부모에서 트리를 따라가므로 유예 없이 바로 /F로 끈다.
// taskkill은 PATH에 System32가 없어도 되도록 절대 경로로 부른다. 128은 이미 끝난 pid라 멈출 것이 없다는 같은 뜻이고, 실행 실패와 그 밖의 종료 코드는 실패 설명을 돌려준다(던지면 타이머 안에서 프로그램이 죽는다).
// taskkill의 stderr는 콘솔 코드 페이지로 나와 utf8로 읽으면 깨지므로 종료 코드만 담는다.
export function killTree(child, signal) {
  if (IS_WINDOWS) {
    const killed = spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (killed.error) return `taskkill 실행 못 함: ${killed.error.message}`;
    if (killed.status !== 0 && killed.status !== 128) return `taskkill 종료 코드 ${killed.status}`;
    return undefined;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

function run(spec, call) {
  return new Promise(resolve => {
    const argv = [...(call.wrap ?? []), ...spec.bin, ...spec.args];
    const child = spawn(argv[0], argv.slice(1), { cwd: call.cwd, env: call.env ?? process.env, ...SPAWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { out: '', err: '', stopped: undefined };
    let killer;
    const stop = (reason, detail) => {
      if (state.stopped) return;
      state.stopped = { reason, detail };
      const failure = killTree(child, 'SIGTERM');
      // 끄지 못한 자식은 close가 오지 않을 수 있어, 기다리지 않고 남은 pid를 드러내며 바로 돌아온다.
      if (failure) {
        state.stopped.detail += ` (끄기 실패, pid ${child.pid}와 자손이 남았을 수 있다: ${failure})`;
        clearTimeout(timer);
        resolve({ ...state, code: null });
        return;
      }
      // Windows는 부모가 살아 있을 때 한 번 끄면 끝이고, 거둔 pid는 재사용될 수 있어 다시 끄지 않는다.
      if (!IS_WINDOWS) killer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('시간초과', `${call.timeoutMs}ms 안에 끝나지 않아 멈췄다`), call.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      state.out += chunk;
      call.observe?.('stdout', chunk);
      const early = spec.earlyStop?.(state.out);
      if (early) stop(early.reason, early.detail);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      state.err += chunk;
      call.observe?.('stderr', chunk);
    });
    // 자식이 지시문을 다 읽기 전에 끝나면 EPIPE가 난다. 던지지 않고 실패 detail에 담는다.
    child.stdin.on('error', error => { state.stdinError = error; });
    child.stdin.end(spec.stdin);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ...state, spawnError: error });
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killer);
      // 부모가 SIGTERM에 먼저 끝나도 SIGTERM을 무시하는 자손이 남을 수 있어, 우리가 멈춘 호출이면 그룹을 바로 끊는다.
      if (state.stopped && !IS_WINDOWS) killTree(child, 'SIGKILL');
      resolve({ ...state, code });
    });
  });
}

const stdinNote = finished => (finished.stdinError ? ` (stdin 쓰기 오류: ${finished.stdinError.message})` : '');

function judge(spec, finished) {
  if (finished.spawnError) return { ok: false, reason: '실패', detail: `${spec.command} 실행 못 함: ${finished.spawnError.message}${stdinNote(finished)}` };
  if (finished.stopped) return { ok: false, ...finished.stopped };
  if (finished.stdinError) return { ok: false, reason: '실패', detail: `지시문을 다 전달하지 못했다: ${finished.stdinError.message}` };
  const read = spec.read(finished.out);
  if (finished.code !== 0 || read.failed) {
    const text = `${finished.out}\n${finished.err}`;
    return { ok: false, reason: LIMIT_PATTERN.test(text) ? '한도' : '실패', detail: (tail(text) || `종료 코드 ${finished.code}`) + stdinNote(finished) };
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
    const bin = resolveBin(call.tool, call.env ?? process.env);
    const spec = TOOLS[call.tool](call, { dir, bin });
    reportVersion(call.tool, bin);
    return judge(spec, await run(spec, call));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const agentapiPath = home => path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agentapi');
// Windows의 spawn은 .exe만 실행한다. .exe가 없고 npm이 놓은 .cmd만 있으면 쪽지가 가리키는 것을 꺼내 부른다(셸로 감싸면 지시문 인용이 깨진다, 2026-10-27 확인).
// .cmd 안의 대상은 npm이 만드는 고정 모양 `"%dp0%\상대경로"`만 읽는다. .js가 있으면 node로 부르고(codex는 node.exe도 함께 적는다) 없으면 .exe를 그대로 부른다(claude). 맥은 PATH에 그 이름의 파일이 있으면 이름 그대로 쓴다.
const CMD_ENTRY = /"%dp0%\\([^"]+\.(?:js|exe))"/g;
const isFile = file => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
function cmdEntry(cmdFile) {
  const targets = [...fs.readFileSync(cmdFile, 'utf8').matchAll(CMD_ENTRY)].map(match => path.join(path.dirname(cmdFile), match[1]));
  const js = targets.find(target => target.endsWith('.js') && isFile(target));
  if (js) return [process.execPath, js];
  const exe = targets.find(isFile);
  return exe ? [exe] : undefined;
}
function candidate(dir, name) {
  if (process.platform !== 'win32') {
    const file = path.join(dir, name);
    fs.accessSync(file, fs.constants.X_OK);
    return isFile(file) ? [name] : undefined;
  }
  const exe = path.join(dir, `${name}.exe`);
  if (fs.statSync(exe, { throwIfNoEntry: false })?.isFile()) return [exe];
  return cmdEntry(path.join(dir, `${name}.cmd`));
}
// PATH 항목을 확인하다 어떤 오류든 나면(없음·폴더·순환 링크·권한·이름 너무 김 등) 그 항목에는 도구가 없다고 본다. 셸의 command -v와 같다.
function launcherIn(dir, name) {
  try {
    return candidate(dir, name);
  } catch {
    return undefined;
  }
}
// 빈 PATH 항목은 셸처럼 현재 폴더다. 절대 경로로 고정한다: 상대 경로 js가 돌아오면 다른 cwd로 띄울 때 못 찾는다. 검색 경로 자체가 비면 찾을 곳이 없다.
export const launcher = (name, searchPath = '') => searchPath === '' ? undefined : searchPath.split(path.delimiter).map(dir => launcherIn(path.resolve(dir), name)).find(Boolean);
export const onPath = (name, searchPath = '') => launcher(name, searchPath) !== undefined;
export const intact = (file, backup) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true && fs.readFileSync(file).equals(fs.readFileSync(backup));

// 도구 이름과 실행 파일 이름은 다르다(제미나이는 agy). 실행 파일은 환경 변수(HARNESS_<도구>_BIN)로 바꿔 끼울 수 있고, 없으면 PATH에서 .exe·.cmd를 직접 찾는다. 못 찾으면 이름 그대로 넘겨 spawn 오류로 드러낸다.
const COMMAND = { codex: 'codex', gemini: 'agy', claude: 'claude' };
export function resolveBin(name, env) {
  const chosen = env[ENV_BIN[name]];
  if (!chosen) return launcher(COMMAND[name], env.PATH ?? '') ?? [COMMAND[name]];
  const full = path.resolve(chosen);
  const bin = !isFile(full) ? undefined : full.endsWith('.cmd') ? cmdEntry(full) : [full];
  if (!bin) throw new Error(`${ENV_BIN[name]}가 가리키는 실행 파일이 없다: ${chosen}`);
  return bin;
}
export const hasTool = (name, env) => (env[ENV_BIN[name]] ? isFile(path.resolve(env[ENV_BIN[name]])) : onPath(COMMAND[name], env.PATH));

// 어느 판을 쓰는지 stderr에 남기고, 판마다 있고 없고가 다른 인자는 --help로 확인해 없으면 뺀다(낡은 claude 2.1.31에는 --permission-prompts가 없었다).
// 둘 다 그 프로세스에서 도구마다 처음 한 번만 묻는다. --help를 읽지 못했으면 인자를 넘긴다: 빼면 파일 도구가 쓰기마다 확인을 묻는다.
const probed = new Map();
function probe(bin, flag) {
  const key = `${bin.join(' ')}\n${flag}`;
  if (!probed.has(key)) {
    const done = spawnSync(bin[0], [...bin.slice(1), flag], { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS });
    probed.set(key, `${done.stdout ?? ''}${done.stderr ?? ''}`);
  }
  return probed.get(key);
}
function reportVersion(name, bin) {
  if (probed.has(`version ${name}`)) return;
  const line = probe(bin, '--version').trim().split('\n').find(text => text.trim())?.trim() || '판 번호를 읽지 못했다';
  probed.set(`version ${name}`, line);
  console.error(`[harness] ${name} ${line} — ${bin.join(' ')}`);
}
const flagSupported = (bin, flag) => probe(bin, '--help').trim() === '' || probe(bin, '--help').includes(flag);

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
