import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim();
const changed = process.argv.slice(2).map(file => {
  const absolute = path.resolve(file);
  return path.relative(root, fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute).split(path.sep).join('/');
});
const names = changed.filter(file => !/^tests\/[^/]+\.test\.mjs$/.test(file)).map(file => path.posix.basename(file));
const selected = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .filter(name => {
    if (changed.includes(`tests/${name}`)) return true;
    const content = fs.readFileSync(path.join(root, 'tests', name), 'utf8');
    return names.some(file => content.includes(file));
  })
  .map(name => `tests/${name}`);

if (selected.length === 0) {
  console.log('맞는 시험 없음: 병합 뒤 전체 시험에서 확인');
} else {
  const result = spawnSync(process.execPath, ['--test', ...selected], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
