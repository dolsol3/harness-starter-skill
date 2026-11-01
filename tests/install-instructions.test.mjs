import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const begin = '<!-- harness-starter:begin -->';
const end = '<!-- harness-starter:end -->';
const block = `${begin}\nold instructions\n${end}`;
const files = ['harness/main.md', 'AGENTS.md', 'CLAUDE.md'];
const parts = ['instructions', 'claude-hook', 'workbuddy-hook', 'codex-hook', 'antigravity-hook', 'git-hook', 'lean-review', 'backlog'];
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function project(t) {
  const dir = tempDir(t, 'instructions-');
  const home = tempDir(t, 'instructions-home-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const install = (...args) => execFileSync(process.execPath, [installer, dir, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  return { dir, home, install, write };
}

test('instructions preview, new install, repeat and upgrade keep a consistent set', t => {
  const { dir, home, install } = project(t);
  const preview = install();
  for (const file of files) assert.ok(preview.includes(`[새로 만듦] ${file}`));
  assert.deepEqual(fs.readdirSync(dir), ['.git']);
  assert.deepEqual(fs.readdirSync(home), []);
  install('--apply');
  assert.match(read(dir, 'harness/main.md'), /메인 운영 절차/);
  assert.match(read(dir, 'AGENTS.md'), /메인.*일을 나누기 전에 `harness\/main.md`/);
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  for (const args of [['--apply'], ['--apply', '--upgrade']]) {
    assert.doesNotMatch(install(...args), /\[새로 만듦\]|\[고침\]|\[건너뜀\]/);
  }
});

for (const upgrade of [false, true]) {
  test(`managed instructions preserve outside bytes and converge (upgrade=${upgrade})`, t => {
    const { dir, install, write } = project(t);
    const prefix = '사용자 앞  \r\n\r\n';
    const suffix = '\r\n\n사용자 뒤  \n\n\n';
    for (const file of files) write(file, prefix + block + suffix);
    const args = upgrade ? ['--apply', '--upgrade'] : ['--apply'];
    install(...args);
    for (const file of files) {
      const content = read(dir, file);
      assert.equal(content.slice(0, content.indexOf(begin)), prefix, file);
      assert.equal(content.slice(content.indexOf(end) + end.length), suffix, file);
      assert.equal(content.split(begin).length, 2, file);
      assert.doesNotMatch(content, /old instructions/);
    }
    assert.doesNotMatch(install(...args), /\[새로 만듦\]|\[고침\]|\[건너뜀\]/);
  });
}

const conflicts = ['user file\n', `${begin}\nunfinished`, `unfinished\n${end}`, `${end}\n${begin}`, `${block}\n${block}`];
for (const upgrade of [false, true]) {
  for (const [index, conflict] of conflicts.entries()) {
    for (const claude of [block, `@AGENTS.md\n\n${block}`, null]) {
      test(`main conflict preserves all instructions (upgrade=${upgrade}, conflict=${index}, claude=${claude})`, t => {
        const { dir, install, write } = project(t);
        write('harness/main.md', conflict);
        if (claude !== null) {
          write('CLAUDE.md', claude);
          write('AGENTS.md', `user agents\n${block}\n`);
        }
        const before = files.map(file => fs.existsSync(path.join(dir, file)) ? read(dir, file) : null);
        const out = install('--apply', ...(upgrade ? ['--upgrade'] : []));
        for (const [i, file] of files.entries()) {
          assert.ok(out.includes(`[건너뜀] ${file} — harness/main.md의 관리 구역이 없거나 불완전`));
          assert.equal(fs.existsSync(path.join(dir, file)) ? read(dir, file) : null, before[i], file);
        }
        assert.ok(fs.existsSync(path.join(dir, 'harness/backlog.mjs')), 'other parts still install');
      });
    }
  }
}

test('CLAUDE import keeps its existing import and removes the old duplicate block', t => {
  const { dir, install, write } = project(t);
  write('CLAUDE.md', `@AGENTS.md\n\n${block}\n\nuser note\n`);
  install('--apply');
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n\nuser note\n');
  assert.match(read(dir, 'AGENTS.md'), /harness\/main.md/);
  assert.match(read(dir, 'harness/main.md'), /메인 운영 절차/);
});

for (const selected of [parts.filter(p => p !== 'instructions'), ['backlog'], ['instructions'], parts.filter(p => p !== 'backlog')]) {
  test(`selected parts: ${selected.join(',')}`, t => {
    const { dir, install, write } = project(t);
    const without = `--without=${parts.filter(p => !selected.includes(p)).join(',')}`;
    install('--apply', without);
    for (const file of files) assert.equal(fs.existsSync(path.join(dir, file)), selected.includes('instructions'), file);
    if (selected.includes('instructions')) {
      assert.match(read(dir, 'harness/main.md'), /없으면 장부·질문 페이지·대기 명령을 실행하지 않고/);
      assert.match(read(dir, 'AGENTS.md'), /harness\/main.md/);
      assert.doesNotMatch(read(dir, 'AGENTS.md'), /@harness\/main.md/);
    } else {
      for (const file of files) write(file, 'user rules\n');
      install('--apply', '--upgrade', without);
      for (const file of files) assert.equal(read(dir, file), 'user rules\n');
    }
  });
}
