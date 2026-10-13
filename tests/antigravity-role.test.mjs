import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const template = name => fs.readFileSync(fileURLToPath(new URL(`../templates/antigravity/${name}.md`, import.meta.url)), 'utf8');
const role = template('readonly');
const research = template('research');
const ROLES = [['.agents/agents/readonly.md', role], ['.agents/agents/research.md', research]];
const WRITERS = ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'run_command'];
const header = text => Object.fromEntries(
  text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);

function project(t, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agyrole-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function install(dir, ...args) {
  const result = spawnSync(process.execPath, [installer, dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const installed = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function assertReadOnlyHeader(text, name, tools) {
  const { description, ...fields } = header(text);
  assert.ok(description, 'description');
  assert.deepEqual(fields, { name, tools, commandExecutionPolicy: 'off', mainAgent: 'true', subagent: 'false', inheritMcp: 'false' });
  const listed = tools.slice(1, -1).split(',').map(tool => tool.trim());
  for (const writer of WRITERS) assert.ok(!listed.includes(writer), writer);
}

// 메인 실험(2026-10-12, agy 1.3.3): name과 description이 둘 다 있어야 agy가 역할을 찾고, 네 칸으로 쓰기 도구를 넘기지 않고, inheritMcp: false로 call_mcp_tool이 빠진다.
test('the Gemini readonly role has the seven tested header fields and hands the model no writing tool', () => {
  assertReadOnlyHeader(role, 'readonly', '[view_file, list_dir, grep_search, find_by_name]');
});

// 같은 실험: 웹 도구 search_web·read_url_content를 더해도 도구 선언에 쓰기 도구는 없었다.
test('the Gemini research role adds only the two web tools and hands the model no writing tool', () => {
  assertReadOnlyHeader(research, 'research', '[view_file, list_dir, grep_search, find_by_name, search_web, read_url_content]');
});

test('the role tells the model to only read and to rate each finding high, medium or low', () => {
  assert.match(role, /고치지 않고 읽기만 한다/);
  assert.match(role, /지적마다 높음·중간·낮음을 붙인다/);
});

test('the research role says not to edit, to cite every claim, to mark the unchecked, and which recordings view_file reads', () => {
  assert.match(research, /고치지 않고/);
  assert.match(research, /주장마다 출처/);
  assert.match(research, /'확인 못 함'/);
  assert.match(research, /`view_file`로 읽는다\. mp4·wav·mp3는 읽히고, aiff·m4a는 읽히지 않는다/);
});

test('apply installs the roles as the templates, keeps a different file without upgrade, replaces it on upgrade, and skips them without antigravity-hook', t => {
  for (const [rel, text] of ROLES) {
    const dir = project(t);
    assert.match(install(dir), new RegExp(`\\[새로 만듦\\] ${rel}`));
    install(dir, '--apply');
    assert.equal(installed(dir, rel), text);

    fs.writeFileSync(path.join(dir, rel), '내 역할\n');
    assert.match(install(dir, '--apply'), new RegExp(`\\[건너뜀\\] ${rel}`), rel);
    assert.equal(installed(dir, rel), '내 역할\n', rel);
    assert.match(install(dir, '--apply', '--upgrade'), new RegExp(`\\[고침\\] ${rel}`), rel);
    assert.equal(installed(dir, rel), text, rel);

    const without = project(t);
    for (const args of [['--apply'], ['--apply', '--upgrade']]) {
      install(without, ...args, '--without=antigravity-hook');
      assert.ok(!fs.existsSync(path.join(without, rel)), `${rel} ${args.join(' ')}`);
    }
  }
});

test('the roles need no checker path, so they install outside git and in a subfolder while the Antigravity hook is still skipped', t => {
  const plain = project(t, { git: false });
  const repo = project(t);
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  for (const dir of [plain, sub]) {
    assert.match(install(dir, '--apply'), /\[건너뜀\] \.agents\/hooks\.json/, dir);
    for (const [rel, text] of ROLES) assert.equal(installed(dir, rel), text, `${dir} ${rel}`);
  }
});
