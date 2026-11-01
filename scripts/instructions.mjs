// 지침 세 파일은 운영 문서를 안전하게 설치할 수 있을 때 함께 갱신한다.
import fs from 'node:fs';
import path from 'node:path';

const BEGIN = '<!-- harness-starter:begin -->';
const END = '<!-- harness-starter:end -->';
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const template = name => fs.readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8');

function decide(rel, now, content) {
  if (now === content) return { rel, action: 'same' };
  return { rel, action: now === null ? 'create' : 'update', content };
}

// 원칙 구역: 표시 구역 안만 바꾸고, 구역 밖의 사용자 내용은 그대로 둔다.
function planBlock(target, rel, name = 'agents-block.md') {
  const block = `${BEGIN}\n${template(name).trimEnd()}\n${END}`;
  const now = read(path.join(target, rel));
  let content = `${block}\n`;
  if (now !== null && now.includes(BEGIN) && now.includes(END)) {
    content = now.slice(0, now.indexOf(BEGIN)) + block + now.slice(now.indexOf(END) + END.length);
  } else if (now !== null) {
    content = `${now.trimEnd()}\n\n${block}\n`;
  }
  return decide(rel, now, content);
}

// CLAUDE.md가 있으면 Claude Code는 AGENTS.md를 따로 읽지 않는다. 없으면 AGENTS.md를 불러오는 한 줄로 만들고,
// 이미 있는데 불러오지 않으면 같은 원칙 구역을 넣는다. 불러오는데 예전 구역이 남아 있으면 지운다(원칙은 한 곳에만).
function planClaudeMd(target) {
  const now = read(path.join(target, 'CLAUDE.md'));
  if (now === null) return decide('CLAUDE.md', now, '@AGENTS.md\n');
  if (!/^@AGENTS\.md\s*$/m.test(now)) return planBlock(target, 'CLAUDE.md');
  if (!now.includes(BEGIN) || !now.includes(END)) return { rel: 'CLAUDE.md', action: 'same' };
  const without = now.slice(0, now.indexOf(BEGIN)) + now.slice(now.indexOf(END) + END.length);
  return decide('CLAUDE.md', now, without.replace(/\n{3,}/g, '\n\n'));
}

// 운영 문서는 사용자가 만든 동명 파일에 구역을 덧붙이지 않는다.
export function planInstructions(target) {
  const rel = 'harness/main.md';
  const now = read(path.join(target, rel));
  const marked = now?.split(BEGIN).length === 2 && now.split(END).length === 2 && now.indexOf(BEGIN) < now.indexOf(END);
  if (now !== null && !marked) {
    return [rel, 'AGENTS.md', 'CLAUDE.md'].map(file => ({
      rel: file,
      action: 'skip',
      note: 'harness/main.md의 관리 구역이 없거나 불완전해 지침 세 파일을 함께 보존한다',
    }));
  }
  return [planBlock(target, rel, 'harness/main.md'), planBlock(target, 'AGENTS.md'), planClaudeMd(target)];
}
