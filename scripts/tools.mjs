// 이 컴퓨터에 깔린 AI 도구를 찾아 새 harness/config.json에 일감목록(동시상한)을 적을 글을 만든다.
// 찾는 실행 파일 이름과 config.json에 적는 이름이 다른 것은 agy(제미나이)뿐이다.
import fs from 'node:fs';
import path from 'node:path';

const FOUND_AS = { claude: 'claude', codex: 'codex', agy: 'gemini' };
// agy는 제미나이 역할 파일을 까는 antigravity-hook 없이는 번갈아 보기 폴백과 조사 보조가 실패하므로 쓸 수 없다.
const NEEDS_PART = { agy: 'antigravity-hook' };
// 이 저장소 harness/config.json에서 사람이 쓰는 값이다. 실험으로 정한 값이 아니다.
const MAIN_LIMIT = 3;
const PARTNER_LIMIT = 1;

// PATH는 부를 때마다 읽는다(시험이 PATH를 바꿔 부른다). 빈 항목은 셸처럼 현재 폴더다. Windows의 PATHEXT(codex.cmd 등)는 다루지 않는다.
// PATH 항목을 확인하다 어떤 오류든 나면(없음·순환 링크·권한·이름 너무 김 등) 그 항목에는 도구가 없다고 본다. 셸의 command -v와 같다.
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(exe) {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => runnable(path.join(dir, exe)));
}

// 메인이 없거나 메인이 아닌 쓸 수 있는 도구가 하나도 없으면 null(도구가 하나뿐이면 다른 도구 검토가 꺼지는 지금 동작과 같다).
export function toolsConfig(configText, main, without = []) {
  if (!main) return null;
  const usable = exe => onPath(exe) && !without.includes(NEEDS_PART[exe]);
  const partners = Object.entries(FOUND_AS).filter(([exe, name]) => name !== main && usable(exe)).map(([, name]) => name);
  if (!partners.length) return null;
  const limits = { [main]: MAIN_LIMIT, ...Object.fromEntries(partners.map(name => [name, PARTNER_LIMIT])) };
  const pairs = Object.entries(limits).map(([name, count]) => `${JSON.stringify(name)}: ${count}`);
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const anchor = `  "단계모델": {${eol}`;
  const block = ['  "일감목록": {', `    "동시상한": { ${pairs.join(', ')} },`, `    "기본맡길곳": ${JSON.stringify(main)}`, '  },', ''].join(eol);
  const shown = Object.entries(limits).map(([name, count]) => `${name} ${count}`).join('·');
  const note = `일감목록을 적는다(동시상한 ${shown}, 기본맡길곳 ${main}). 숫자는 이 저장소에서 사람이 쓰는 값이지 실험으로 정한 값이 아니다. 바꾸려면 harness/config.json의 일감목록을 고친다`;
  return { content: configText.replace(anchor, () => `${block}${anchor}`), note };
}
