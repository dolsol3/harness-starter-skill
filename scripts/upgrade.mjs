#!/usr/bin/env node
// 이 스킬을 git으로 받은 폴더에서 새 버전을 받고, 바뀐 것을 보이고, 승인받아 전역 스킬 네 곳을 백업한 뒤 바꾼다.
//
// 이어서 명부의 프로젝트마다 깐 버전과 설치기 미리보기를 보이고, 승인받은 곳만 install.mjs --upgrade로 올린다.
//
//   node scripts/upgrade.mjs [--미리보기 | --예] [--프로젝트 <경로> ...]
//   node scripts/upgrade.mjs --등록 <경로> ...
//
// 깃발 없이: 받고, 네 곳과 프로젝트를 하나씩 보여 주고, y일 때만 바꾼다. --미리보기: 받고 보여 주기만 한다(네 곳·명부·프로젝트는 그대로).
// --예: 받지 않고 묻지 않고 바꾼다(미리보기로 보여 준 그대로 바꾸려고). 프로젝트는 --프로젝트로 고른 곳만 올린다(명부 전체를 한꺼번에 바꾸지 않게).
// --프로젝트: 명부의 프로젝트 중 그곳만 다룬다. --등록: 명부가 생기기 전에 깐 옛 프로젝트를 명부에 적기만 하고 끝낸다.
// 받아서 커밋이 바뀌면 새 upgrade.mjs를 --받은뒤=<옛 커밋>으로 다시 돌린다. 옛 코드가 새 파일을 다루지 않게 하려고.
// 전역 복사본(.git 없음)에서 불리면 명부의 source(마지막으로 네 곳을 바꾼 받은 폴더)로 넘긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addProject, readRegistry, registryFile, writeRegistry } from './registry.mjs';

const ROOT = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const COPIED = ['SKILL.md', 'package.json', 'CHANGELOG.md', 'scripts', 'templates'];
const FOLDERS = ['scripts', 'templates'];
const AFTER = '--받은뒤=';
const USAGE = '사용법: node scripts/upgrade.mjs [--미리보기 | --예] [--프로젝트 <경로> ...]\n       node scripts/upgrade.mjs --등록 <경로> ...';
const PATH_FLAGS = { '--프로젝트': 'projects', '--등록': 'register' };
const CLONE = 'git clone https://github.com/dolsol3/harness-starter-skill.git';

// 경로는 README의 전역 스킬 위치 표와 같다. 이름은 백업 폴더 이름이다.
function places() {
  const home = os.homedir();
  return [
    ['claude', path.join(home, '.claude', 'skills', 'harness-starter')],
    ['agents', path.join(home, '.agents', 'skills', 'harness-starter')],
    ['antigravity-cli', path.join(home, '.gemini', 'antigravity-cli', 'skills', 'harness-starter')],
    ['antigravity-ide', path.join(home, '.gemini', 'config', 'skills', 'harness-starter')],
  ];
}

function usage() {
  console.error(USAGE);
  process.exit(1);
}

// --프로젝트·--등록은 깃발마다 바로 뒤 인자 하나를 경로로 받는다.
function parseArgs(argv) {
  const options = { preview: false, yes: false, after: undefined, projects: [], register: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg.startsWith(AFTER)) options.after = arg.slice(AFTER.length);
    else if (arg === '--미리보기') options.preview = true;
    else if (arg === '--예') options.yes = true;
    else if (PATH_FLAGS[arg] && next !== undefined && !next.startsWith('--')) options[PATH_FLAGS[arg]].push(argv[++i]);
    else usage();
  }
  const others = options.preview || options.yes || options.projects.length > 0;
  if ((options.preview && options.yes) || (options.register.length > 0 && others)) usage();
  return options;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function runUpgrade(root, argv) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'upgrade.mjs'), ...argv], { stdio: 'inherit' });
  return result.status ?? 1;
}

function handOff(argv) {
  const { source } = readRegistry();
  if (source && fs.existsSync(path.join(source, '.git'))) return runUpgrade(source, argv);
  console.error(`git으로 받은 폴더가 아니다: ${ROOT}`);
  console.error(`${CLONE} 로 받은 뒤 그 폴더에서 node scripts/upgrade.mjs 를 돌린다.`);
  return 1;
}

// 받은 것이 있으면 새 코드로 다시 돌리고 그 종료 코드로 끝낸다.
function pull(argv) {
  const old = git('rev-parse', 'HEAD');
  const result = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) process.exit(1);
  if (git('rev-parse', 'HEAD') !== old) process.exit(runUpgrade(ROOT, [`${AFTER}${old}`, ...argv]));
  console.log(`새로 받은 것이 없다(${version()}).`);
}

// CHANGELOG의 첫 절부터 옛 버전 절 바로 앞까지를 고치지 않고 그대로 낸다.
function summary(old) {
  const before = JSON.parse(git('show', `${old}:package.json`)).version;
  const lines = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.startsWith('## '));
  const end = lines.findIndex(line => line.startsWith(`## [${before}]`));
  console.log(`바뀐 것(${before} → ${version()}):`);
  console.log(lines.slice(start, end === -1 ? undefined : end).join('\n'));
}

function listFiles(base) {
  return COPIED.flatMap(item => {
    const full = path.join(base, item);
    if (!fs.existsSync(full)) return [];
    if (fs.statSync(full).isFile()) return [item];
    const names = fs.readdirSync(full, { recursive: true }).map(name => path.join(item, name));
    return names.filter(name => fs.statSync(path.join(base, name)).isFile());
  }).sort();
}

function sameAsRoot(dir) {
  const mine = listFiles(ROOT);
  const theirs = listFiles(dir);
  if (mine.join('\n') !== theirs.join('\n')) return false;
  return mine.every(name => fs.readFileSync(path.join(ROOT, name)).equals(fs.readFileSync(path.join(dir, name))));
}

function judge(dir) {
  if (!fs.existsSync(dir)) return '새로 만듦';
  return sameAsRoot(dir) ? '그대로' : '고침';
}

// 전역과 프로젝트 질문이 한 읽개를 함께 쓴다. 질문마다 새로 만들면 파이프로 준 입력의 둘째 줄부터 잃을 수 있다.
const input = {};

async function ask(question) {
  process.stdout.write(`${question} (y/n) `);
  input.reader ??= createInterface({ input: process.stdin });
  input.lines ??= input.reader[Symbol.asyncIterator]();
  const { value = '' } = await input.lines.next();
  return /^y(es)?$/i.test(value.trim());
}

function backupRoot() {
  return path.join(os.homedir(), '.harness-starter', 'backup');
}

// 다섯 밖의 파일과 네 곳 밖의 것은 건드리지 않는다.
function replace(plan) {
  const backup = path.join(backupRoot(), new Date().toISOString().replace(/[:.]/g, '-'));
  const changed = plan.filter(place => place.label !== '그대로');
  for (const { name, dir, label } of changed) {
    if (label === '고침') fs.cpSync(dir, path.join(backup, name), { recursive: true });
    for (const folder of FOLDERS) fs.rmSync(path.join(dir, folder), { recursive: true, force: true });
    for (const item of COPIED) fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  }
  console.log(`전역 ${changed.length}곳을 바꿨다.`);
  if (changed.some(place => place.label === '고침')) console.log(`백업: ${backup}`);
}

// 곳·명부·백업이나 그 위 폴더(HOME 아래)가 링크면 지우기·복사·쓰기가 링크를 따라가 바깥 파일(다른 전역 설정 등)을 바꾸고 백업도 링크가 되어 되돌릴 수 없다.
function isLink(dir) {
  return fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function linkOnPath(dir) {
  const home = os.homedir();
  const parts = path.relative(home, dir).split(path.sep);
  return parts.map((_, i) => path.join(home, ...parts.slice(0, i + 1))).find(isLink);
}

function linksOn(written) {
  const links = [...new Set(written.map(linkOnPath).filter(Boolean))];
  for (const link of links) console.error(`링크라 바꾸지 않는다: ${link} (링크를 풀고 다시 돌린다)`);
  return links.length > 0;
}

async function globalStep({ preview, yes }) {
  if (linksOn([...places().map(([, dir]) => dir), registryFile(), backupRoot()])) process.exit(1);
  const plan = places().map(([name, dir]) => ({ name, dir, label: judge(dir) }));
  for (const { dir, label } of plan) console.log(`[${label}] ${dir}${label === '고침' ? ' (바꾸기 전에 백업)' : ''}`);
  if (plan.every(place => place.label === '그대로')) return console.log('전역 네 곳은 이미 같다.');
  if (preview) return console.log('미리보기입니다. 바꾸려면 --예를 붙입니다.');
  if (!yes && !(await ask('전역 네 곳을 바꿀까요?'))) return console.log('바꾸지 않았다.');
  // 명부가 깨져 있으면 네 곳을 바꾸기 전에 멈추도록 먼저 읽는다.
  const registry = readRegistry();
  replace(plan);
  writeRegistry({ ...registry, source: ROOT });
}

// 하네스가 깔렸는지는 보지 않는다(옛 프로젝트에는 harness/VERSION이 없다).
function register(dirs) {
  const missing = dirs.filter(dir => !isFolder(dir));
  for (const dir of missing) console.error(`폴더가 없다: ${dir}`);
  if (linksOn([registryFile()]) || missing.length > 0) return 1;
  for (const dir of dirs) console.log(`[${addProject(dir) ? '등록' : '이미 있음'}] ${fs.realpathSync(dir)}`);
  return 0;
}

function isFolder(dir) {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// 명부에는 실제 경로가 적혀 있다(addProject).
function chosen(dirs) {
  const listed = readRegistry().projects;
  const picked = dirs.map(dir => (fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir)));
  const unknown = picked.filter(dir => !listed.includes(dir));
  for (const dir of unknown) console.error(`명부에 없는 프로젝트다: ${dir} (먼저 --등록 ${dir} 로 적는다)`);
  if (unknown.length > 0) process.exit(1);
  return picked;
}

function installed(dir) {
  const file = path.join(dir, 'harness', 'VERSION');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '모름';
}

function install(dir, ...flags) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install.mjs'), dir, ...flags], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function upgradeProject(dir, { preview, yes }) {
  if (!isFolder(dir)) return console.log(`[없음] ${dir} — 없어진 경로라 건너뛴다`);
  console.log(`프로젝트: ${dir} (깐 버전 ${installed(dir)} → ${version()})`);
  if (!yes) install(dir, '--upgrade');
  if (preview) return;
  if (!yes && !(await ask('이 프로젝트를 올릴까요?'))) return console.log('바꾸지 않았다.');
  install(dir, '--apply', '--upgrade');
}

async function projectStep(options, picked) {
  if (options.yes && picked.length === 0) return console.log('프로젝트는 --프로젝트 <경로>로 고른 곳만 올린다.');
  const listed = readRegistry().projects;
  const targets = picked.length > 0 ? listed.filter(dir => picked.includes(dir)) : listed;
  if (targets.length === 0) return console.log('명부에 프로젝트가 없다. 옛 프로젝트는 --등록 <경로>로 적는다.');
  for (const dir of targets) await upgradeProject(dir, options);
  if (options.preview) console.log('미리보기입니다. 프로젝트를 올리려면 --예 --프로젝트 <경로>를 붙입니다.');
}

const argv = process.argv.slice(2);
const options = parseArgs(argv);
if (options.register.length > 0) process.exit(register(options.register));
if (!fs.existsSync(path.join(ROOT, '.git'))) process.exit(handOff(argv));
console.log(`받은 폴더: ${ROOT}`);
const picked = chosen(options.projects);
if (options.after) summary(options.after);
else if (!options.yes) pull(argv);
await globalStep(options);
await projectStep(options, picked);
input.reader?.close();
