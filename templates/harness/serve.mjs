// 질문 페이지 서버: 사람이 브라우저로 질문 페이지를 보고 답을 보낸다. node harness/backlog.mjs 서버는 이 터미널에서 켜고 Ctrl+C로 끄고,
// 켜두기는 같은 서버를 떨어진 프로세스로 띄워 명령이 끝나도 계속 돌게 하고(이미 켜져 있으면 두고), 끄기가 그것을 끈다.
// 이 컴퓨터(127.0.0.1)에서만 열린다. 토큰은 처음 한 번 만들어 포트와 함께 harness/serve.json에 두고 계속 써서 링크가 바뀌지 않는다(사용자 결정 2026-10-16:
// 폰 즐겨찾기로 아무 때나 본다). 주소(?token=…)에 토큰이 없거나 틀린 요청은 거절한다.
// 인증 없는 쓰기 서버가 되지 않게 하려는 것이다(다른 웹 페이지가 이 컴퓨터의 서버로 몰래 답을 보내 막힘을 풀어 버리지 못하게).
// 서버는 일감 목록을 읽기만 한다. 답은 backlog 답 명령을 불러 적는다. 그래서 쓰는 길이 명령 하나뿐이고 잠금과 질문 확인(이미 답함,
// 오래된 페이지)도 명령이 한다. 원격에서 보려면 사용자 환경(Tailscale 등)에서 이 포트를 전달한다. 하네스는 이 컴퓨터 밖으로 열지 않는다.
// 다시 켜기(revive): 켜 둔 적 있는데(상태 파일에 pid) 꺼져 있으면 일감 목록 명령이 다시 켠다(사용자 결정 2026-10-16: 맥을 다시 켠 뒤 AI가 일감 목록을 볼 때). 끄기는 pid를 빼서 사람이 끈 것을 지킨다.
// 링크 줄(pageLine): 켜져 있으면 허락·확인 출력에 링크를 보여 AI가 대화창에서 알려 줄 수 있게 한다.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as ledger from './ledger.mjs';
import * as page from './page.mjs';

// 일감 목록 명령은 이 파일 옆이 아니라 메인 폴더의 것을 부른다. 작업 폴더에서 켜두기해도 작업 폴더를 지운 뒤 계속 답을 적을 수 있게 하려는 것이다.
const backlogOf = root => path.join(root, 'harness/backlog.mjs');
const MAX_BODY = 20_000; // 글자 수. 답은 명령의 인자로 넘어가는데 한 인자가 길면(리눅스는 128KB) 명령을 못 부르므로 한글로 그 밑이다
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  // 켜졌는지 볼 때 답한 서버가 저장된 pid의 우리 서버인지 맞춰 본다(alive).
  'X-Harness-Pid': String(process.pid),
};
const WRONG_TOKEN = '토큰이 없거나 틀렸다. 켜 둔 질문 페이지 링크(켜두기 출력, AI가 알려 준 링크, 즐겨찾기)로 연다';

function send(res, status, type, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}
const reply = (res, status, message) => send(res, status, 'application/json', JSON.stringify({ 메시지: message }));

// 본문을 글로 읽는다. 받는 대로 글자 수를 세어 넘으면 버리고, 끝에 413으로 답하게 오류를 올린다.
// 글자를 바이트 조각 단위로 풀면 조각 경계에 걸린 한글이 깨지므로 받는 쪽에서 UTF-8로 이어 붙인다.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooBig) return;
      text += chunk;
      tooBig = text.length > MAX_BODY;
    });
    req.on('end', () => (tooBig ? reject(Object.assign(new Error('요청이 너무 크다'), { status: 413 })) : resolve(text)));
  });
}

async function answer(req, res, root, token) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    return reply(res, error.status ?? 400, error.status ? error.message : '요청을 읽을 수 없다(JSON이 아니다)');
  }
  if (body?.token !== token) return reply(res, 403, WRONG_TOKEN);
  const { 번호, 만든시각, 선택, 직접 } = body;
  if (![번호, 만든시각, 선택, 직접].every(value => typeof value === 'string') || !만든시각) {
    return reply(res, 400, '번호, 만든시각, 선택, 직접은 모두 글이어야 하고 만든시각은 비울 수 없다(같은 질문인지 확인한다)');
  }
  // 값은 --이름=값 꼴로 넘기고 위치 인자는 -- 뒤에 둔다. 글이 -로 시작해도 옵션으로 읽히지 않게 하려는 것이다.
  const args = [backlogOf(root), '답', ...(직접 ? [`--직접=${직접}`] : []), `--만든시각=${만든시각}`, '--', 번호, ...(선택 ? [선택] : [])];
  return execFile(process.execPath, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) return reply(res, 409, stderr.replace(/^backlog: /, '').trim() || error.message);
    return reply(res, 200, `기록했습니다. ${번호}의 답: ${선택 || 직접}`);
  });
}

async function route(req, res, root, token) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('token') !== token) return send(res, 403, 'text/plain', WRONG_TOKEN);
    return send(res, 200, 'text/html', page.draw(root, ledger.load(root)));
  }
  if (req.method === 'POST' && url.pathname === '/answer') return answer(req, res, root, token);
  return send(res, 404, 'text/plain', '없는 주소다');
}

const stateFile = root => path.join(root, 'harness/serve.json');
const readState = root => (fs.existsSync(stateFile(root)) ? JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) : {});
const link = state => `질문 페이지: http://127.0.0.1:${state.포트}/?token=${state.토큰}`;

// 켜두기가 기다리는 동안 이 파일을 되풀이해 읽으므로 반쯤 쓴 파일이 읽히지 않게 다른 이름으로 쓰고 바꿔 끼운다.
function writeState(root, state) {
  fs.writeFileSync(`${stateFile(root)}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(`${stateFile(root)}.tmp`, stateFile(root));
}

function portOf(state, portText) {
  const port = portText === undefined ? (state.포트 ?? 0) : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`서버 거절: --포트는 0~65535 사이의 정수다(지금 ${portText})`);
  return port;
}

// 켜져 있는지는 pid만이 아니라 저장된 포트와 토큰으로 받은 200과, 그 답이 알린 pid가 저장된 pid인지로 본다.
// 맥을 다시 켜면 같은 pid가 다른 프로그램일 수 있고, 저장된 포트의 다른 서버가 토큰을 보지 않고 200을 줄 수 있다. 둘이 겹쳐도 끄기가 남의 프로세스에 신호를 보내지 않게 한다.
// 연결 거절·시간 초과·HTTP가 아닌 답은 모두 우리 서버가 답하지 않는 것이라 꺼져 있다로 본다.
// fetch를 쓰지 않는다. fetch는 6000 같은 포트를 거절하고, 꺼지는 중인 서버에 보내면 잡을 수 없는 예외로 프로세스가 죽는다(Node 26.3, undici setTypeOfService EINVAL).
function alive(state) {
  if (!state.포트 || !state.토큰) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: state.포트, path: `/?token=${state.토큰}`, agent: false, timeout: 1000 }, response => {
      response.resume();
      resolve(response.statusCode === 200 && response.headers['x-harness-pid'] === String(state.pid));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitFor(check) {
  for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) if (await check()) return true;
  return false;
}

export function start(root, portText) {
  const state = readState(root);
  const port = portOf(state, portText);
  const token = state.토큰 ?? crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => route(req, res, root, token).catch(error => send(res, 500, 'text/plain', error.message)));
  server.once('error', error => {
    console.error(`backlog: 서버를 열지 못했다(${error.message})`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const saved = { 포트: server.address().port, 토큰: token, pid: process.pid };
    writeState(root, saved);
    console.log(`${link(saved)}\n이 컴퓨터에서만 열린다. 끄려면 Ctrl+C`);
  });
}

const KEPT = '명령이 끝나도 계속 돈다. 끄려면 node harness/backlog.mjs 끄기';

export async function keep(root, portText) {
  const state = readState(root);
  const port = portOf(state, portText);
  if (await alive(state)) {
    if (port !== state.포트) throw new Error(`켜두기 거절: 질문 페이지가 이미 ${state.포트} 포트에서 켜져 있다. ${port} 포트로 열려면 먼저 node harness/backlog.mjs 끄기`);
    return [link(state), `이미 켜져 있다. ${KEPT}`];
  }
  // 출력을 파이프로 물려주면 부른 쪽이 서버가 끝날 때까지 기다리므로 로그 파일에 바로 쓰게 한다.
  const log = path.join(root, 'harness/serve.log');
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [backlogOf(root), '서버', `--포트=${port}`], { cwd: root, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  const started = await waitFor(async () => {
    if (child.exitCode !== null) return true;
    const now = readState(root);
    return now.pid === child.pid && alive(now);
  });
  if (!started || child.exitCode !== null) {
    // 준비 확인이 끝까지 실패했는데 자식이 아직 돌면 끈다. 남겨 두면 저장된 상태와 맞지 않는 서버가 포트를 쥔다.
    if (child.exitCode === null) child.kill();
    const reason = fs.readFileSync(log, 'utf8').trimEnd().split('\n').at(-1);
    throw new Error(`켜두기 거절: ${port} 포트에서 질문 페이지를 켜지 못했다. harness/serve.log 끝: ${reason}`);
  }
  return [link(readState(root)), KEPT];
}

export async function stop(root) {
  const state = readState(root);
  const on = await alive(state);
  if (on) {
    process.kill(state.pid, 'SIGTERM');
    if (!(await waitFor(async () => !(await alive(state))))) throw new Error(`끄기 거절: pid ${state.pid}에 끄라고 알렸지만 ${state.포트} 포트가 아직 답한다`);
  }
  // pid를 빼면 다음 일감 목록 명령이 다시 켜지 않는다. 포트·토큰은 남겨 다시 켜두기하면 같은 링크다.
  if (state.pid) writeState(root, { 포트: state.포트, 토큰: state.토큰 });
  return [on ? '질문 페이지를 껐다. 다시 켜두기하면 같은 링크로 열린다' : '질문 페이지는 이미 꺼져 있다'];
}

// 켜 둔 적 있는데(pid가 있는데) 꺼져 있으면 저장된 포트로 다시 켠다. 켜 둔 적 없거나 켜져 있으면 아무것도 하지 않는다.
export async function revive(root) {
  const state = readState(root);
  if (!state.pid || (await alive(state))) return [];
  await keep(root);
  return ['질문 페이지를 다시 켰다', link(readState(root))];
}

export async function pageLine(root) {
  const state = readState(root);
  return (await alive(state)) ? [link(state)] : [];
}
