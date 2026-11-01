import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SPAWN_GROUP } from '../templates/harness/mullebanga-call.mjs';

const SOURCES = ['mullebanga-call.mjs', 'mullebanga-git.mjs'].map(name => fs.readFileSync(new URL(`../templates/harness/${name}`, import.meta.url), 'utf8'));

test('물레방아가 띄우는 자식은 Windows에서 detached 없이, 그 밖에서는 detached로 시작하고 창을 숨긴다', () => {
  assert.equal(SPAWN_GROUP.detached, process.platform !== 'win32');
  assert.equal(SPAWN_GROUP.windowsHide, true);
});

test('run과 runShell이 자식을 띄울 때 SPAWN_GROUP을 쓰고 detached를 직접 적지 않는다', () => {
  const spawns = SOURCES.flatMap(source => source.split('\n').filter(line => /\bspawn\(/.test(line)));
  assert.equal(spawns.length, 2);
  for (const line of spawns) {
    assert.match(line, /\.\.\.SPAWN_GROUP/);
    assert.doesNotMatch(line, /detached/);
  }
});
