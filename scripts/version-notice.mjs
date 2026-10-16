// 스킬을 부를 때 공개본의 버전 번호(package.json)만 하루 한 번 읽어, 내 것보다 높으면 한 줄로 알린다. 코드는 받지 않는다.
// 끄려면 HARNESS_STARTER_NO_UPDATE_CHECK=1. 마지막 확인 날짜는 명부(~/.harness-starter/projects.json)의 checked 칸이다.
import fs from 'node:fs';
import { readRegistry, writeRegistry } from './registry.mjs';

const DEFAULT_URL = 'https://raw.githubusercontent.com/dolsol3/harness-starter-skill/main/package.json';
const TIMEOUT_MS = 3000;

// 사람이 하루라고 느끼는 기준이라 이 컴퓨터 시간대의 날짜로 센다.
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// 글자 비교면 0.10.0이 0.9.0보다 낮게 나오므로 칸마다 숫자로 비교한다.
function isNewer(remote, mine) {
  const a = remote.split('.').map(Number);
  const b = mine.split('.').map(Number);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index !== -1 && a[index] > b[index];
}

async function remoteVersion(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).version;
}

// 네트워크·응답 문제만 '확인 못 함'으로 넘긴다. 내 package.json과 명부의 오류는 이 밖에서 그대로 올라간다.
// JSON 오류 글에는 받은 본문(로그인 화면 HTML 등)의 줄바꿈이 섞여 들어오므로 한 줄로 편다.
async function check(url) {
  try {
    return { version: await remoteVersion(url) };
  } catch (error) {
    return { failure: (error.cause?.message ?? error.message).replace(/\s+/g, ' ') };
  }
}

async function main() {
  if (process.env.HARNESS_STARTER_NO_UPDATE_CHECK === '1') return;
  const mine = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const registry = readRegistry();
  const date = today();
  if (registry.checked === date) return;
  const result = await check(process.env.HARNESS_STARTER_VERSION_URL ?? DEFAULT_URL);
  writeRegistry({ ...registry, checked: date });
  if (result.failure) console.error(`새 버전 확인 못 함: ${result.failure}`);
  else if (isNewer(result.version, mine)) console.log(`harness-starter 새 버전 ${result.version}이 나왔다(지금 ${mine}). "업그레이드 해 줘"라고 하면 올린다.`);
}

await main();
