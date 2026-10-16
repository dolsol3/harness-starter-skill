// scripts/upgrade.mjs의 프로젝트 단계(명부의 프로젝트마다 보이고 묻고 올리기)와 --프로젝트·--등록을 임시 HOME으로 시험한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, setup, publish, places, snapshot, ok } from './upgrade-setup.mjs';

const HIDDEN = ['.claude', '.agents', '.gemini'];

// 임시 git 저장소에 받은 폴더의 설치기를 --apply로 돌려 명부에 적고 harness/VERSION을 깐다.
function project(s, name) {
  const dir = path.join(s.work, name);
  git(s.env, s.work, 'init', '-q', '-b', 'main', dir);
  ok(s.run(path.join(s.clone, 'scripts', 'install.mjs'), [dir, '--apply']));
  return fs.realpathSync(dir);
}

function versionFile(dir) {
  return path.join(dir, 'harness', 'VERSION');
}

function installed(dir) {
  return fs.existsSync(versionFile(dir)) ? fs.readFileSync(versionFile(dir), 'utf8') : null;
}

// R1은 옛 버전 0.1.0, R2는 VERSION이 없는(깐 버전을 모르는) 프로젝트다.
function fixture(t) {
  const s = setup(t);
  const r1 = project(s, 'R1');
  const r2 = project(s, 'R2');
  fs.writeFileSync(versionFile(r1), '0.1.0\n');
  fs.rmSync(versionFile(r2));
  const next = JSON.parse(fs.readFileSync(path.join(s.clone, 'package.json'), 'utf8')).version;
  const status = dir => git(s.env, dir, 'status', '--porcelain');
  const registry = path.join(s.home, '.harness-starter', 'projects.json');
  const readProjects = () => JSON.parse(fs.readFileSync(registry, 'utf8')).projects;
  return { ...s, r1, r2, next, status, registry, readProjects };
}

function hasLine(out, ...parts) {
  return out.split('\n').some(line => parts.every(part => line.includes(part)));
}

function noGlobals(home) {
  for (const name of HIDDEN) assert.equal(fs.existsSync(path.join(home, name)), false, name);
}

test('preview shows each project version and installer preview and changes nothing', t => {
  const s = fixture(t);
  const before = [s.status(s.r1), s.status(s.r2)];
  const out = ok(s.upgrade(['--미리보기']));
  assert.ok(hasLine(out, s.r1, '0.1.0'), out);
  assert.ok(hasLine(out, s.r2, '모름'), out);
  assert.ok(out.includes('[고침] harness/VERSION'), out);
  assert.ok(out.includes('[새로 만듦] harness/VERSION'), out);
  assert.equal(installed(s.r1), '0.1.0\n');
  assert.equal(installed(s.r2), null);
  assert.deepEqual([s.status(s.r1), s.status(s.r2)], before);
  noGlobals(s.home);
});

test('without flags only the projects answered y are upgraded, after their preview', t => {
  const s = fixture(t);
  const out = ok(s.upgrade([], 'n\ny\nn\n'));
  assert.equal(installed(s.r1), `${s.next}\n`);
  assert.equal(installed(s.r2), null);
  for (const dir of places(s.home)) assert.equal(fs.existsSync(dir), false, dir);
  const ask = '이 프로젝트를 올릴까요?';
  assert.ok(out.indexOf(`프로젝트: ${s.r1}`) < out.indexOf(ask), out);
  assert.ok(out.indexOf('[고침] harness/VERSION') < out.indexOf(ask), out);
  assert.ok(out.indexOf(`프로젝트: ${s.r2}`) < out.lastIndexOf(ask), out);
  assert.ok(out.indexOf('[새로 만듦] harness/VERSION') < out.lastIndexOf(ask), out);
});

test('a closed stdin upgrades no project', t => {
  const s = fixture(t);
  const status = [s.status(s.r1), s.status(s.r2)];
  const before = [snapshot(s.r1), snapshot(s.r2), snapshot(s.home)];
  ok(s.upgrade([], ''));
  assert.deepEqual([snapshot(s.r1), snapshot(s.r2), snapshot(s.home)], before);
  assert.deepEqual([s.status(s.r1), s.status(s.r2)], status);
});

test('--예 upgrades only the projects chosen with --프로젝트', t => {
  const s = fixture(t);
  const out = ok(s.upgrade(['--예']));
  assert.match(out, /--프로젝트/);
  assert.equal(installed(s.r1), '0.1.0\n');
  assert.equal(installed(s.r2), null);
  ok(s.upgrade(['--예', '--프로젝트', s.r2]));
  assert.equal(installed(s.r2), `${s.next}\n`);
  assert.equal(installed(s.r1), '0.1.0\n');
});

test('a project folder that is gone is reported and skipped and stays in the registry', t => {
  const s = fixture(t);
  const r3 = project(s, 'R3');
  fs.rmSync(r3, { recursive: true, force: true });
  const projects = s.readProjects();
  assert.ok(projects.includes(r3));
  for (const [args, input] of [[['--미리보기'], ''], [[], 'n\ny\ny\n']]) {
    const out = ok(s.upgrade(args, input));
    assert.ok(hasLine(out, r3, '건너뛴다'), out);
  }
  assert.equal(installed(s.r1), `${s.next}\n`);
  assert.equal(installed(s.r2), `${s.next}\n`);
  assert.deepEqual(s.readProjects(), projects);
  assert.equal(fs.existsSync(r3), false);
});

test('--프로젝트 outside the registry stops before pulling and points to --등록', t => {
  const s = fixture(t);
  const r4 = path.join(s.work, 'R4');
  git(s.env, s.work, 'init', '-q', '-b', 'main', r4);
  publish(s, '9.9.9');
  const head = s.head(s.clone);
  const before = [snapshot(s.r1), snapshot(s.r2), snapshot(r4), snapshot(s.home)];
  const result = s.upgrade(['--프로젝트', r4], 'y\ny\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--등록/);
  assert.equal(s.head(s.clone), head);
  assert.deepEqual([snapshot(s.r1), snapshot(s.r2), snapshot(r4), snapshot(s.home)], before);
});

test('--등록 adds new folders to the registry only, without pulling or touching globals', t => {
  const s = fixture(t);
  const r4 = path.join(s.work, 'R4');
  git(s.env, s.work, 'init', '-q', '-b', 'main', r4);
  const data = JSON.parse(fs.readFileSync(s.registry, 'utf8'));
  fs.writeFileSync(s.registry, JSON.stringify({ ...data, source: '/somewhere', checked: '2026-10-16' }));
  publish(s, '9.9.9');
  const head = s.head(s.clone);
  const out = ok(s.upgrade(['--등록', r4, '--등록', s.r1]));
  assert.ok(out.includes(fs.realpathSync(r4)), out);
  const written = JSON.parse(fs.readFileSync(s.registry, 'utf8'));
  assert.deepEqual(written.projects, [...data.projects, fs.realpathSync(r4)]);
  assert.equal(written.source, '/somewhere');
  assert.equal(written.checked, '2026-10-16');
  assert.equal(s.head(s.clone), head);
  noGlobals(s.home);
  assert.equal(fs.existsSync(path.join(s.home, '.harness-starter', 'backup')), false);
});

test('--등록 of a missing folder or a bad flag combination exits 1 and leaves the registry alone', t => {
  const s = fixture(t);
  const r4 = path.join(s.work, 'R4');
  git(s.env, s.work, 'init', '-q', '-b', 'main', r4);
  const text = fs.readFileSync(s.registry, 'utf8');
  const missing = s.upgrade(['--등록', path.join(s.work, 'none')]);
  assert.equal(missing.status, 1);
  assert.equal(fs.readFileSync(s.registry, 'utf8'), text);
  for (const args of [['--등록', r4, '--예'], ['--등록'], ['--프로젝트']]) {
    const result = s.upgrade(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /사용법/);
  }
  assert.equal(fs.readFileSync(s.registry, 'utf8'), text);
});
