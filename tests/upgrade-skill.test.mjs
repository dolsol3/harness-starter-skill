// scripts/upgrade.mjs(스킬 업그레이드 명령)를 임시 bare 원격·받는 쪽 clone·임시 HOME으로 시험한다.
// tests/upgrade.test.mjs는 설치기의 --upgrade 시험이라 이름이 다르다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MARK, temp, git, setup, publish, places, snapshot, copiedFiles, ok } from './upgrade-setup.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('preview pulls, reruns the new script, shows the changelog section, and writes nothing under HOME', t => {
  const s = setup(t);
  const section = publish(s, '9.9.9');
  const out = ok(s.upgrade(['--미리보기']));
  assert.equal(s.head(s.clone), s.head(s.bare));
  assert.equal(out.split('\n').filter(line => line === MARK).length, 1, out);
  assert.ok(out.includes(`바뀐 것(${version} → 9.9.9):`), out);
  assert.ok(out.includes(section), out);
  for (const dir of places(s.home)) assert.ok(out.includes(`[새로 만듦] ${dir}`), out);
  assert.deepEqual(fs.readdirSync(s.home), []);
});

test('y copies the five items to all four places, records only the source, and a global copy hands off to it', t => {
  const s = setup(t);
  const registry = path.join(s.home, '.harness-starter', 'projects.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ source: null, projects: ['/somewhere'], checked: null }));
  publish(s, '9.9.9');
  ok(s.upgrade([], 'y\n'));
  for (const dir of places(s.home)) assert.deepEqual(copiedFiles(dir), copiedFiles(s.clone), dir);
  const written = JSON.parse(fs.readFileSync(registry, 'utf8'));
  assert.equal(written.source, fs.realpathSync(s.clone));
  assert.deepEqual(written.projects, ['/somewhere']);

  const copy = path.join(places(s.home)[0], 'scripts', 'upgrade.mjs');
  const out = ok(s.run(copy, ['--미리보기']));
  assert.equal(out.split('\n')[0], `받은 폴더: ${fs.realpathSync(s.clone)}`);
});

test('a global copy with no registry tells how to git clone and writes nothing', t => {
  const s = setup(t);
  const home2 = temp(t, 'home2');
  fs.cpSync(path.join(s.clone, 'scripts'), path.join(home2, 'copy', 'scripts'), { recursive: true });
  const result = s.run(path.join(home2, 'copy', 'scripts', 'upgrade.mjs'), ['--미리보기'], '', { ...process.env, HOME: home2, USERPROFILE: home2 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git clone/);
  assert.equal(fs.existsSync(path.join(home2, '.harness-starter')), false);
});

test('--예 backs up a changed place before replacing it and leaves everything else alone', t => {
  const s = setup(t);
  const claude = places(s.home)[0];
  fs.mkdirSync(path.join(claude, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'SKILL.md'), 'old skill\n');
  fs.writeFileSync(path.join(claude, 'mine.txt'), 'mine\n');
  fs.writeFileSync(path.join(claude, 'scripts', 'old.mjs'), 'old script\n');
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), '{"keep":true}\n');
  fs.mkdirSync(path.join(s.home, '.claude', 'skills', 'other'));
  fs.writeFileSync(path.join(s.home, '.claude', 'skills', 'other', 'SKILL.md'), 'other skill\n');
  ok(s.upgrade(['--예']));
  const backupRoot = path.join(s.home, '.harness-starter', 'backup');
  const [stamp] = fs.readdirSync(backupRoot);
  assert.deepEqual(fs.readdirSync(path.join(backupRoot, stamp)), ['claude']);
  assert.deepEqual(snapshot(path.join(backupRoot, stamp, 'claude')), { 'SKILL.md': 'old skill\n', 'mine.txt': 'mine\n', 'scripts/old.mjs': 'old script\n' });
  assert.equal(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(s.clone, 'SKILL.md'), 'utf8'));
  assert.equal(fs.existsSync(path.join(claude, 'scripts', 'old.mjs')), false);
  assert.equal(fs.readFileSync(path.join(claude, 'mine.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8'), 'other skill\n');
});

test('n and a closed stdin change nothing', t => {
  const s = setup(t);
  ok(s.upgrade(['--예']));
  fs.writeFileSync(path.join(places(s.home)[1], 'SKILL.md'), 'edited\n');
  const before = snapshot(s.home);
  for (const input of ['n\n', '']) {
    const out = ok(s.upgrade([], input));
    assert.match(out, /바꾸지 않았다/);
    assert.deepEqual(snapshot(s.home), before);
  }
});

test('--예 does not pull and shows no summary', t => {
  const s = setup(t);
  const head = s.head(s.clone);
  publish(s, '9.9.9');
  const out = ok(s.upgrade(['--예']));
  assert.equal(s.head(s.clone), head);
  assert.ok(!out.includes('바뀐 것('), out);
  for (const dir of places(s.home)) assert.deepEqual(copiedFiles(dir), copiedFiles(s.clone), dir);
});

test('a pull that cannot fast-forward stops before changing anything', t => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.clone, 'local.txt'), 'local\n');
  git(s.env, s.clone, 'add', 'local.txt');
  git(s.env, s.clone, 'commit', '-q', '-m', 'local');
  publish(s, '9.9.9');
  const head = s.head(s.clone);
  const result = s.upgrade([], 'y\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fatal/);
  assert.equal(s.head(s.clone), head);
  assert.deepEqual(fs.readdirSync(s.home), []);
});

test('both flags or an unknown flag print usage and change nothing', t => {
  const s = setup(t);
  const head = s.head(s.clone);
  publish(s, '9.9.9');
  for (const args of [['--미리보기', '--예'], ['--모름']]) {
    const result = s.upgrade(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /사용법/);
    assert.equal(s.head(s.clone), head);
    assert.deepEqual(fs.readdirSync(s.home), []);
  }
});

test('a place that is a symlink is refused before anything outside it changes', t => {
  const s = setup(t);
  const outside = temp(t, 'outside');
  fs.mkdirSync(path.join(outside, 'scripts'));
  fs.writeFileSync(path.join(outside, 'scripts', 'old.mjs'), 'old script\n');
  const claude = places(s.home)[0];
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.symlinkSync(outside, claude);
  const result = s.upgrade(['--예']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /링크/);
  assert.deepEqual(snapshot(outside), { 'scripts/old.mjs': 'old script\n' });
  assert.equal(fs.existsSync(path.join(s.home, '.harness-starter')), false);
});

test('a linked folder above a place is refused before anything outside it changes', t => {
  const s = setup(t);
  const outside = temp(t, 'outside');
  fs.mkdirSync(path.join(outside, 'harness-starter', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'harness-starter', 'scripts', 'old.mjs'), 'old script\n');
  const skills = path.dirname(places(s.home)[0]);
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.symlinkSync(outside, skills);
  const result = s.upgrade(['--예']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /링크/);
  assert.deepEqual(snapshot(outside), { 'harness-starter/scripts/old.mjs': 'old script\n' });
  assert.equal(fs.existsSync(path.join(s.home, '.harness-starter')), false);
});

test('a linked registry or backup folder is refused before another global file changes', t => {
  for (const linked of [['projects.json'], ['backup']]) {
    const s = setup(t);
    const settings = path.join(s.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"theme":"dark"}\n');
    const outside = temp(t, 'outside');
    const target = linked[0] === 'backup' ? outside : settings;
    fs.mkdirSync(path.join(s.home, '.harness-starter'));
    fs.symlinkSync(target, path.join(s.home, '.harness-starter', ...linked));
    const result = s.upgrade(['--예']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /링크/);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"theme":"dark"}\n');
    assert.deepEqual(fs.readdirSync(outside), []);
    for (const place of places(s.home)) assert.equal(fs.existsSync(place), false);
  }
});
