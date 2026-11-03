import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outside } from '../scripts/role-copies.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const templates = fileURLToPath(new URL('../templates/', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const ROLES = ['planner', 'implementer', 'reviewer', 'researcher'].map(role => `.claude/agents/${role}.md`);
const FLOW = '.claude/workflows/mullebanga.js';
const MARK = '\n## 이 프로젝트\n';

const lf = text => text.replaceAll('\r\n', '\n');
const fresh = rel => lf(fs.readFileSync(path.join(templates, rel.replace('.claude/', '')), 'utf8'));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const mine = role => `\n## 이 프로젝트\n- 확인 명령: 내것 ${role}\n`;
const old = rel => lf(fresh(rel)).replace(MARK, `\n옛 줄\n${MARK}`).split(MARK)[0] + mine(rel);

function repo(t, { roles = ROLES, flow = true, eol = '\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-copies-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text.replaceAll('\n', eol));
  };
  for (const rel of roles) put(rel, old(rel));
  if (flow) put(FLOW, `${fresh(FLOW)}// 옛 줄\n`);
  return dir;
}

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const snapshot = (dir, rels) => rels.map(rel => read(dir, rel));

test('preview shows old copies as 고침 and leaves bytes alone; --upgrade is required to change them', t => {
  const dir = repo(t);
  const before = snapshot(dir, [...ROLES, FLOW]);
  const preview = install(dir, '--upgrade');
  for (const rel of [...ROLES, FLOW]) assert.match(preview, new RegExp(`\\[고침\\] ${rel.replaceAll('.', '\\.')}`));
  assert.deepEqual(snapshot(dir, [...ROLES, FLOW]), before);
  assert.doesNotMatch(install(dir), /\.claude\/agents|\.claude\/workflows/);
  install(dir, '--apply');
  assert.deepEqual(snapshot(dir, [...ROLES, FLOW]), before);
});

test('--apply --upgrade replaces the part above 이 프로젝트 and keeps the rest exactly; second run changes nothing', t => {
  const dir = repo(t);
  install(dir, '--apply', '--upgrade');
  for (const rel of ROLES) {
    const text = read(dir, rel);
    assert.equal(text.split(MARK)[0], fresh(rel).split(MARK)[0]);
    assert.equal(text.slice(text.indexOf(MARK)), mine(rel));
  }
  assert.equal(read(dir, FLOW), fresh(FLOW));
  assert.doesNotMatch(install(dir, '--apply', '--upgrade'), /\[고침\] \.claude\//);
  assert.match(install(dir, '--upgrade'), /\[그대로\] \.claude\/workflows\/mullebanga\.js/);
});

test('copy line endings are kept when they differ from the template', t => {
  const dir = repo(t, { eol: '\r\n' });
  install(dir, '--apply', '--upgrade');
  for (const rel of [...ROLES, FLOW]) {
    const text = read(dir, rel);
    assert.equal(text.replaceAll('\r\n', '').includes('\n'), false, rel);
    assert.equal(lf(text).includes('\r'), false, rel);
  }
  assert.equal(lf(read(dir, FLOW)), fresh(FLOW));
});

test('missing copies are not created and only existing roles are handled', t => {
  const none = repo(t, { roles: [], flow: false });
  const out = install(none, '--apply', '--upgrade');
  assert.doesNotMatch(out, /\.claude\/agents|\.claude\/workflows/);
  assert.equal(fs.existsSync(path.join(none, '.claude/agents')), false);
  assert.equal(fs.existsSync(path.join(none, '.claude/workflows')), false);
  const some = repo(t, { roles: ROLES.slice(0, 1), flow: false });
  const text = install(some, '--apply', '--upgrade');
  assert.match(text, /\[고침\] \.claude\/agents\/planner\.md/);
  assert.doesNotMatch(text, /implementer|workflows/);
  assert.equal(fs.existsSync(path.join(some, ROLES[1])), false);
});

test('a role copy without 이 프로젝트 is skipped with a reason and left unchanged', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, ROLES[0]), '내가 새로 쓴 파일\n');
  const out = install(dir, '--apply', '--upgrade');
  assert.match(out, /\[건너뜀\] \.claude\/agents\/planner\.md — /);
  assert.equal(read(dir, ROLES[0]), '내가 새로 쓴 파일\n');
  assert.match(out, /\[고침\] \.claude\/agents\/implementer\.md/);
  assert.equal(read(dir, ROLES[1]).split(MARK)[0], fresh(ROLES[1]).split(MARK)[0]);
});

test('a mixed line ending copy keeps the 이 프로젝트 part byte for byte', t => {
  const dir = repo(t, { roles: [], flow: false });
  const rel = ROLES[0];
  const project = mine(rel).slice(1) + '둘째 줄\n';
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), old(rel).split(MARK)[0].replaceAll('\n', '\r\n') + '\r\n' + project);
  install(dir, '--apply', '--upgrade');
  const text = read(dir, rel);
  assert.equal(text.slice(text.length - project.length), project);
  assert.equal(lf(text.slice(0, text.length - project.length)), fresh(rel).split(MARK)[0] + '\n');
  assert.equal(text.includes('\r\n'), true);
});

test('a copy that differs only by line endings is 그대로 and not rewritten', t => {
  const dir = repo(t, { roles: [], flow: false });
  const rel = ROLES[0];
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  const text = (fresh(rel).split(MARK)[0] + mine(rel)).replaceAll('\n', '\r\n');
  fs.writeFileSync(path.join(dir, rel), text);
  assert.match(install(dir, '--apply', '--upgrade'), /\[그대로\] \.claude\/agents\/planner\.md/);
  assert.equal(read(dir, rel), text);
});

test('a heading at end of file without newline is still kept as 이 프로젝트', t => {
  const dir = repo(t, { roles: [], flow: false });
  const rel = ROLES[0];
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), old(rel).split(MARK)[0] + '\n## 이 프로젝트');
  const out = install(dir, '--apply', '--upgrade');
  assert.match(out, /\[고침\] \.claude\/agents\/planner\.md/);
  assert.equal(read(dir, rel), fresh(rel).split(MARK)[0] + '\n## 이 프로젝트');
});

test('a role copy whose folder links outside the project is skipped and the outside file is not written', t => {
  const dir = repo(t, { roles: [], flow: false });
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shared-'));
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const rel = ROLES[0];
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.symlinkSync(shared, path.join(dir, '.claude/agents'), 'junction');
  fs.writeFileSync(path.join(shared, 'planner.md'), old(rel));
  const out = install(dir, '--apply', '--upgrade');
  assert.match(out, /\[건너뜀\] \.claude\/agents\/planner\.md — /);
  assert.equal(fs.readFileSync(path.join(shared, 'planner.md'), 'utf8'), old(rel));
});

test('a heading on the first line and a one-line CRLF top are both handled by the same line rule', t => {
  const dir = repo(t, { roles: [], flow: false });
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  const first = '## 이 프로젝트\n내것\n';
  fs.writeFileSync(path.join(dir, ROLES[0]), first);
  const oneLine = '옛 한 줄\r\n## 이 프로젝트  \r\n내것\r\n';
  fs.writeFileSync(path.join(dir, ROLES[1]), oneLine);
  install(dir, '--apply', '--upgrade');
  assert.equal(read(dir, ROLES[0]), fresh(ROLES[0]).split(MARK)[0] + '\n' + first);
  const text = read(dir, ROLES[1]);
  assert.equal(text.slice(text.lastIndexOf('## 이 프로젝트')), '## 이 프로젝트  \r\n내것\r\n');
  assert.equal(text.split('\r\n## 이 프로젝트')[0], fresh(ROLES[1]).split(MARK)[0].replaceAll('\n', '\r\n'));
});

test('outside treats a relative path that is absolute (other drive) as outside', () => {
  assert.equal(outside('C:\\proj', 'D:\\shared\\planner.md', path.win32), true);
  assert.equal(outside('C:\\proj', 'C:\\other\\planner.md', path.win32), true);
  assert.equal(outside('C:\\proj', 'C:\\proj\\.claude\\agents\\planner.md', path.win32), false);
  assert.equal(outside('C:\\proj', 'C:\\proj\\..roles\\planner.md', path.win32), false);
});
