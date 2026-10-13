// 덧대기 신호: 같은 파일이 최근 수정 커밋에 여러 번 들어 있으면 알린다. 알리기만 하고 막지는 않는다.
//
// 기본 브랜치(backlog.baseBranch)의 최근 커밋 patch.lastCommits(기본 50)개 중 제목이 patch.fixPattern(기본: fix 또는 🐛로 시작)에 맞는 커밋을 모아
// 파일마다 몇 번 들어 있는지 센다. patch.times(기본 3)번 이상이면 신호다. 한도(줄 수, 줄 길이, 금지 패턴)가 정해진 종류(config.json의 kinds)의 파일만 센다. 문서·설정은 세지 않는다.
// 기본 브랜치를 찾지 못하면(커밋이 아직 없거나 이름이 다름) 신호가 없는 것으로 본다. 신호 때문에 장부를 쓰는 명령이 멈추면 안 된다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { overlaps } from './ledger.mjs';

const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('config.json', import.meta.url)), 'utf8'));
const { times = 3, lastCommits = 50, fixPattern = '^(fix\\b|🐛)' } = config.patch ?? {};
const { baseBranch = 'main' } = config.backlog ?? {};

// 수정 커밋 제목의 규칙(fixPattern)을 정규식으로 만든다. 틀렸으면 어느 설정인지 알린다.
// 장부를 저장한 뒤에 실패하지 않도록 backlog가 명령을 돌리기 전에도 부른다.
export function check() {
  try {
    return new RegExp(fixPattern, 'i');
  } catch (error) {
    throw new Error(`config.json의 patch.fixPattern이 올바른 정규식이 아니다 (${error.message})`);
  }
}

// 한도가 정해진 종류의 파일인가 (막는 훅의 isCode와 같다. 어느 종류에도 없거나 한도가 없는 종류는 아니다)
function limited(file) {
  const kind = Object.values(config.kinds ?? {}).find(item => item.files.some(glob => path.posix.matchesGlob(file, glob)));
  return Boolean(kind && (kind.maxFileLines !== undefined || kind.maxLineLength !== undefined || kind.patterns));
}

// 신호가 뜬 파일: [{ file, subjects }] (많이 고친 것부터). 제목은 그 파일을 고친 수정 커밋의 제목이다.
// -z로 읽으면 파일 이름을 따옴표로 감싸지 않으므로 "나 역슬래시가 든 이름도 그대로 온다. 출력은 커밋마다 \x01제목, 파일 이름들이 NUL로 이어진다.
// 파일 이름이 많은 커밋(처음 가져온 코드 등)이 있어도 장부 쓰기가 실패하지 않게 출력 한도를 크게 잡는다.
export function signals(root) {
  const isFix = check();
  let log;
  try {
    log = execFileSync('git', ['log', '-z', `-n${lastCommits}`, '--name-only', '--format=%x01%s', `refs/heads/${baseBranch}`, '--'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28,
    });
  } catch (error) {
    if (typeof error.status === 'number') return [];
    throw error;
  }
  const subjectsByFile = new Map();
  let subject;
  let fix;
  for (const token of log.split('\0')) {
    if (token.startsWith('\x01')) {
      subject = token.slice(1);
      fix = isFix.test(subject);
      continue;
    }
    const file = token.replace(/^\n/, '');
    if (fix && limited(file)) subjectsByFile.set(file, [...(subjectsByFile.get(file) ?? []), subject]);
  }
  return [...subjectsByFile]
    .filter(([, subjects]) => subjects.length >= times)
    .map(([file, subjects]) => ({ file, subjects }))
    .sort((a, b) => b.subjects.length - a.subjects.length);
}

// 수정 작업을 시작할 때 보일 줄: 작업 영역이 신호가 뜬 파일과 겹치는 것마다 한 줄
export const warn = (found, areas) =>
  found.filter(({ file }) => areas.some(area => overlaps(area, file))).map(({ file, subjects }) =>
    `주의: ${file}은(는) 최근 커밋 ${lastCommits}개 중 수정 커밋 ${subjects.length}번에 들어 있다 (${subjects.join(' / ')}). 같은 곳을 또 덧대는 것이 아닌지 원인부터 다시 본다`);
