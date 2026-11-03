import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(fileURLToPath(new URL('..', import.meta.url)), 'templates/harness');
// 앞에 점이 붙은 것(정규식 .exec 등)은 child_process 호출이 아니다.
const CALL = /(?<![.\w])(execFileSync|execFile|spawnSync|spawn|execSync|exec|fork)\(/g;

// 호출 괄호가 닫히는 곳까지의 글(여러 줄 포함)을 돌려준다.
function callBody(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

test('Windows에서 콘솔 창이 뜨지 않도록 모든 child_process 호출에 windowsHide: true가 있다', () => {
  const missing = [];
  let seen = 0;
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(CALL)) {
      seen++;
      if (!callBody(source, match.index + match[0].length - 1).includes('windowsHide: true')) {
        missing.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
  }
  assert.ok(seen >= 14, `child_process 호출을 ${seen}곳만 찾았다(정규식이 틀어졌다)`);
  assert.deepEqual(missing, [], `windowsHide: true가 빠진 곳: ${missing.join(', ')}`);
});
