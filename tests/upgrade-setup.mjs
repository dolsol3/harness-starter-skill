// scripts/upgrade.mjs 시험(upgrade-skill·upgrade-projects)이 함께 쓰는 준비: 임시 bare 원격·받는 쪽 clone·임시 HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('..', import.meta.url));
const COPIED = ['SKILL.md', 'package.json', 'CHANGELOG.md', 'scripts', 'templates', 'guide'];
export const MARK = '표시: 새 upgrade.mjs가 돌았다';

export function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-upgrade-skill-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 임시 HOME에는 git 전역 설정이 없으므로 커밋하는 사람을 명령에서 준다.
export function git(env, cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// 내는 쪽 P가 bare 원격 B에 올리고, 받는 쪽 C는 B를 clone한다. git도 upgrade.mjs도 임시 HOME H로 돈다.
export function setup(t) {
  const home = temp(t, 'home');
  const work = temp(t, 'work');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const bare = path.join(work, 'B');
  const publisher = path.join(work, 'P');
  const clone = path.join(work, 'C');
  git(env, work, 'init', '-q', '--bare', '-b', 'main', bare);
  git(env, work, 'init', '-q', '-b', 'main', publisher);
  for (const item of COPIED) fs.cpSync(path.join(SOURCE, item), path.join(publisher, item), { recursive: true });
  git(env, publisher, 'add', '-A');
  git(env, publisher, 'commit', '-q', '-m', 'first');
  git(env, publisher, 'remote', 'add', 'origin', bare);
  git(env, publisher, 'push', '-q', '-u', 'origin', 'main');
  git(env, work, 'clone', '-q', bare, clone);
  const run = (script, args, input = '', runEnv = env) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: runEnv, input });
  const upgrade = (args, input) => run(path.join(clone, 'scripts', 'upgrade.mjs'), args, input);
  const head = dir => git(env, dir, 'rev-parse', 'HEAD');
  return { home, work, env, bare, publisher, clone, run, upgrade, head };
}

// 새 버전을 낸다: 버전을 올리고, CHANGELOG에 절을 더하고, upgrade.mjs 끝에 표시를 출력하는 문장을 더한다.
export function publish({ env, publisher }, next) {
  const pkgFile = path.join(publisher, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`);
  const section = `## [${next}] - 2026-10-16\n\n### Added\n\n- 시험용 새 기능 ${next}.\n`;
  const changelog = path.join(publisher, 'CHANGELOG.md');
  fs.writeFileSync(changelog, fs.readFileSync(changelog, 'utf8').replace('## [Unreleased]\n', `## [Unreleased]\n\n${section}`));
  fs.appendFileSync(path.join(publisher, 'scripts', 'upgrade.mjs'), `console.log(${JSON.stringify(MARK)});\n`);
  git(env, publisher, 'commit', '-q', '-am', `release ${next}`);
  git(env, publisher, 'push', '-q');
  return section;
}

export function places(home) {
  return [
    path.join(home, '.claude', 'skills', 'harness-starter'),
    path.join(home, '.agents', 'skills', 'harness-starter'),
    path.join(home, '.gemini', 'antigravity-cli', 'skills', 'harness-starter'),
    path.join(home, '.gemini', 'config', 'skills', 'harness-starter'),
  ];
}

// 폴더 아래 모든 파일의 상대 경로와 내용.
export function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  const names = fs.readdirSync(dir, { recursive: true }).filter(name => fs.statSync(path.join(dir, name)).isFile());
  return Object.fromEntries(names.sort().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

export function copiedFiles(dir) {
  return Object.fromEntries(COPIED.flatMap(item => {
    const full = path.join(dir, item);
    if (fs.statSync(full).isFile()) return [[item, fs.readFileSync(full, 'utf8')]];
    return Object.entries(snapshot(full)).map(([name, text]) => [path.join(item, name), text]);
  }));
}

export function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
