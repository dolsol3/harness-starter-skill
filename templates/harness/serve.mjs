// 질문 페이지 서버: 사람이 브라우저로 질문 페이지를 보고 답을 보낸다. 사람이 node harness/backlog.mjs 서버로 켜고 Ctrl+C로 끈다.
//
// 이 컴퓨터(127.0.0.1)에서만 열린다. 켤 때마다 새 토큰을 만들어 주소(?token=…)에 붙이고, 토큰이 없거나 틀린 요청은 거절한다.
// 인증 없는 쓰기 서버가 되지 않게 하려는 것이다(다른 웹 페이지가 이 컴퓨터의 서버로 몰래 답을 보내 막힘을 풀어 버리지 못하게).
// 서버는 장부를 읽기만 한다. 답은 backlog 답 명령을 불러 적는다. 그래서 쓰는 길이 명령 하나뿐이고 잠금과 질문 확인(이미 답함,
// 오래된 페이지)도 명령이 한다. 원격에서 보려면 사용자 환경(Tailscale 등)에서 이 포트를 전달한다. 하네스는 이 컴퓨터 밖으로 열지 않는다.
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ledger from './ledger.mjs';
import * as page from './page.mjs';

const BACKLOG = fileURLToPath(new URL('backlog.mjs', import.meta.url));
const MAX_BODY = 20_000; // 글자 수. 답은 명령의 인자로 넘어가는데 한 인자가 길면(리눅스는 128KB) 명령을 못 부르므로 한글로 그 밑이다
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};
const WRONG_TOKEN = '토큰이 없거나 틀렸다. 서버를 켠 터미널에 나온 주소로 연다';

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

async function answer(req, res, token) {
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
  const args = [BACKLOG, '답', ...(직접 ? [`--직접=${직접}`] : []), `--만든시각=${만든시각}`, '--', 번호, ...(선택 ? [선택] : [])];
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
  if (req.method === 'POST' && url.pathname === '/answer') return answer(req, res, token);
  return send(res, 404, 'text/plain', '없는 주소다');
}

export function start(root, portText) {
  const port = portText === undefined ? 0 : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`서버 거절: --포트는 0~65535 사이의 정수다(지금 ${portText})`);
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => route(req, res, root, token).catch(error => send(res, 500, 'text/plain', error.message)));
  server.once('error', error => {
    console.error(`backlog: 서버를 열지 못했다(${error.message})`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`질문 페이지: http://127.0.0.1:${server.address().port}/?token=${token}\n이 컴퓨터에서만 열린다. 끄려면 Ctrl+C`);
  });
}
