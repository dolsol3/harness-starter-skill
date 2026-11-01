// --upgrade가 프로젝트의 역할 사본(.claude/agents/)과 물레방아 사본(.claude/workflows/mullebanga.js)을 새 템플릿으로 맞출 일을 계획한다.
// 역할 파일은 '## 이 프로젝트' 줄부터 끝까지(프로젝트마다 손으로 채운 칸)를 살리고 그 위만 바꾼다. 사본이 없으면 만들지 않는다.
import fs from 'node:fs';
import path from 'node:path';

const HEADING = '## 이 프로젝트';
const AGENTS = '.claude/agents';
const WORKFLOW = '.claude/workflows/mullebanga.js';

const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
// 링크(junction 포함)가 프로젝트 밖을 가리키면 밖의 공유 파일을 덮어쓰게 되므로 실제 경로로 확인한다.
// 드라이브가 다른 경로는 상대 경로가 절대 경로로 나오므로 그것도 밖으로 본다
export const outside = (root, real, p = path) => {
  const rel = p.relative(root, real);
  return rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel);
};
const outsideTarget = (target, file) => outside(fs.realpathSync(target), fs.realpathSync(file));
const OUTSIDE = { action: 'skip', note: '실제 경로가 이 프로젝트 밖(링크)이라 쓰지 않는다' };
const lf = text => text.replaceAll('\r\n', '\n');
const withEol = (text, like) => (like.includes('\r\n') ? lf(text).replaceAll('\n', '\r\n') : lf(text));
// 줄 전체가 '## 이 프로젝트'(끝 공백 허용)인 첫 줄이 시작하는 위치. 없으면 -1
const headingAt = text => {
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.trimEnd() === HEADING) return offset;
    offset += line.length + 1;
  }
  return -1;
};

function decide(rel, now, content) {
  return lf(content) === lf(now) ? { rel, action: 'same' } : { rel, action: 'update', content };
}

function planRole(target, templates, role) {
  const rel = `${AGENTS}/${role}`;
  const now = read(path.join(target, rel));
  if (now === null) return null;
  if (outsideTarget(target, path.join(target, rel))) return { rel, ...OUTSIDE };
  const at = headingAt(now);
  if (at < 0) return { rel, action: 'skip', note: "'## 이 프로젝트' 줄이 없어 그대로 둔다. 필요하면 직접 비교한다" };
  const fresh = lf(fs.readFileSync(path.join(templates, 'agents', role), 'utf8'));
  // 줄바꿈은 원문 전체에서 한 번 정해 새 윗부분에만 쓰고, 프로젝트 절은 원문 그대로 붙인다
  return decide(rel, now, withEol(fresh.slice(0, headingAt(fresh)), now) + now.slice(at));
}

function planWorkflow(target, templates) {
  const now = read(path.join(target, WORKFLOW));
  if (now === null) return null;
  if (outsideTarget(target, path.join(target, WORKFLOW))) return { rel: WORKFLOW, ...OUTSIDE };
  return decide(WORKFLOW, now, withEol(fs.readFileSync(path.join(templates, 'workflows/mullebanga.js'), 'utf8'), now));
}

export function planRoleCopies(target, templates) {
  const roles = fs.readdirSync(path.join(templates, 'agents')).filter(name => name.endsWith('.md'));
  return [...roles.map(role => planRole(target, templates, role)), planWorkflow(target, templates)].filter(Boolean);
}
