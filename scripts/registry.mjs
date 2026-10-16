// 하네스를 깐 프로젝트 명부(~/.harness-starter/projects.json). 설치기·업그레이드·새 버전 알림이 이 모듈로만 읽고 쓴다.
// 모양은 { source, projects, checked }다. 깐 버전은 명부에 두지 않고 각 프로젝트의 harness/VERSION에서 읽는다(두 곳에 두면 갈라진다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 시험이 HOME을 임시 폴더로 바꿔 부르므로 부를 때마다 계산한다.
export function registryFile() {
  return path.join(os.homedir(), '.harness-starter', 'projects.json');
}

export function readRegistry() {
  const file = registryFile();
  const data = fs.existsSync(file) ? parse(file) : {};
  return { source: null, projects: [], checked: null, ...data };
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`명부를 JSON으로 읽을 수 없다. 고치거나 지운 뒤 다시 돌린다: ${file}`, { cause: error });
  }
}

export function writeRegistry(data) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// 같은 폴더를 '.'이나 /var·/private/var처럼 다르게 불러도 한 줄이 되게 실제 경로로 적는다. 더했으면 참.
export function addProject(dir) {
  const real = fs.realpathSync(dir);
  const registry = readRegistry();
  if (registry.projects.includes(real)) return false;
  writeRegistry({ ...registry, projects: [...registry.projects, real] });
  return true;
}
