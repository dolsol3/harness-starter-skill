// --upgrade가 파일만 바꾸면 켜져 있는 질문 페이지 서버는 옛 코드로 계속 돈다.
// 끄기 상태·켠 적 없음은 사용자 뜻이고 죽은 pid는 일감 목록 명령이 알아서 켜므로, 살아 있는 pid일 때만 다시 켠다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function serverRunning(target) {
  const state = path.join(target, 'harness/serve.json');
  if (!fs.existsSync(state)) return false;
  const { pid } = JSON.parse(fs.readFileSync(state, 'utf8'));
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function restartServer(target, apply) {
  console.log(`[다시 켬] 질문 페이지 서버 — ${apply ? '새 코드로 다시 켠다' : '--apply면 서버를 다시 켠다'}`);
  if (!apply) return;
  for (const word of ['끄기', '켜두기']) execFileSync(process.execPath, ['harness/backlog.mjs', word], { cwd: target, stdio: 'inherit' });
}
