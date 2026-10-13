import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../templates/agents/', import.meta.url));
const read = file => fs.readFileSync(`${dir}${file}`, 'utf8');
const header = text => Object.fromEntries(
  text.match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
);

test('the default agents are planner, implementer, researcher and reviewer, each named after its file and with a description', () => {
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['implementer.md', 'planner.md', 'researcher.md', 'reviewer.md']);
  for (const file of files) {
    const { name, description } = header(read(file));
    assert.equal(name, file.replace('.md', ''));
    assert.ok(description, `${file} needs a description: it is how Claude decides to call the agent`);
  }
});

test('the reviewer may only read: an allowlist with no editing, MCP or Agent tool (omitting tools would inherit them all)', () => {
  const { tools, disallowedTools } = header(read('reviewer.md'));
  assert.deepEqual(tools.split(',').map(tool => tool.trim()), ['Read', 'Grep', 'Glob', 'Bash']);
  assert.equal(disallowedTools, undefined);
});

test('the researcher may only read and search the web: an allowlist with no editing, MCP or Agent tool', () => {
  const { tools, disallowedTools } = header(read('researcher.md'));
  assert.deepEqual(tools.split(',').map(tool => tool.trim()), ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch']);
  assert.equal(disallowedTools, undefined);
});

test('the implementer works in its own worktree, so parallel implementers do not share a working folder', () => {
  assert.equal(header(read('implementer.md')).isolation, 'worktree');
});

test('every agent has a 이 프로젝트 section for the skill to fill, so the project facts are not baked into the template', () => {
  for (const file of fs.readdirSync(dir)) assert.match(read(file), /^## 이 프로젝트\n- .+<.+>/m, file);
});
