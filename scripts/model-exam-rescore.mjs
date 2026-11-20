import fs from 'node:fs';
import path from 'node:path';
import { meter } from './model-exam-meter.mjs';
import { assess, save } from './model-exam-run.mjs';
import { writeReport, selectRepeats } from './model-exam-report.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// 모델 호출 없이 결과 폴더에 저장된 답안·원시 출력을 지금 계측·채점 코드로 다시 읽는다. 폴더 위치와 소스 해시에 기대지 않는다.
export function rescore(dir, config, sources, failureType) {
  const stored = read(path.join(dir, 'summary.json'));
  const results = stored.results.map(row => {
    const folder = path.join(dir, path.basename(row.folder));
    const result = { ...row, reused: true, folder, target: path.join(folder, 'submission'), calls: row.calls };
    if (row.ok) {
      const data = read(path.join(folder, 'evidence.json'));
      const evidence = { ...data.evidence, originalCwd: data.originalCwd };
      const stdout = path.join(folder, 'raw', 'stdout');
      if (fs.existsSync(stdout)) {
        const telemetry = meter(row.candidate.tool);
        telemetry.chunk(fs.readFileSync(stdout, 'utf8'));
        const found = telemetry.finish(true).evidence;
        const cwd = evidence.commands?.[0]?.cwd ?? data.originalCwd;
        Object.assign(evidence, { commands: found.commands.map(run => ({ ...run, cwd })), openedSources: found.openedSources });
        result.evidence = { ...row.evidence, ...found };
      }
      Object.assign(result, assess(row, folder, data.answer, result.target, evidence, data.workflow, config));
      result.failureType = failureType(result);
      result.status = result.grading.status === '미채점' ? '미채점' : result.grade.eligible ? '완료' : '위반';
    }
    return result;
  });
  const summary = { ...stored, config, sources: stored.originalSources ?? stored.sources, originalSources: stored.originalSources ?? stored.sources, rescoreSources: sources, output: dir, results,
    counts: { planned: results.length, collected: results.length, reused: results.length, completed: results.filter(r => r.status === '완료').length,
      failed: results.filter(r => !r.ok).length, ungraded: results.filter(r => r.grading?.status === '미채점').length, calls: 0 } };
  summary.repeatSelection = selectRepeats(results, config.repeatStages);
  save(path.join(dir, 'summary.json'), summary);
  writeReport(summary, dir);
  return summary;
}
