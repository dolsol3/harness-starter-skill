// 공용 성적부는 잠금 안에서 읽고 원자 교체한다. 남은 잠금을 임의로 지우지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CANDIDATES, sameModel, above, choosePrimary, chooseTrial, groupOf } from './mullebanga-policy.mjs';

export const statsFile = (env = process.env) => path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), '.harness-starter', 'model-stats.json');
export const sampleId = (root, id, text = '') => createHash('sha256').update(`${root}\n${id}\n${text}`).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function transaction(env, change) {
  const file = statsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lock;
  for (let tries = 0; ; tries++) {
    try {
      lock = fs.openSync(`${file}.lock`, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tries === 200) throw new Error('성적부 잠금을 얻지 못했다(model-stats.json.lock)');
      await sleep(25);
    }
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { records: [], states: {}, assignments: {} };
    const result = change(data);
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return result;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.closeSync(lock);
    fs.unlinkSync(`${file}.lock`);
  }
}
const qualityRows = (data, tool, group) => {
  const seen = new Set();
  return data.records.filter(row => {
    const key = `${row.sampleId}:${row.tool}:${row.group}:${row.stage}`;
    if (row.tool !== tool || row.group !== group || !row.managed || typeof row.firstPass !== 'boolean' || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.qualityAt ?? 0) - (b.qualityAt ?? 0));
};
export async function selectModel({ tool, stage, sample, env = process.env, rescue = false }) {
  const group = groupOf(stage);
  const table = CANDIDATES[tool]?.[group];
  if (!table) throw new Error(`자동 후보가 없는 도구·단계: ${tool} ${stage}`);
  return transaction(env, data => {
    const key = `${tool}:${group}`;
    const state = data.states[key] ??= { primary: table.ladder[table.start], since: 0, changed: false };
    const rows = qualityRows(data, tool, group);
    const primary = choosePrimary(table, state, rows);
    if (!sameModel(primary, state.primary)) Object.assign(state, { primary, since: rows.length, changed: true, stable: 0 });
    const assignment = `${sample}:${key}`;
    const selected = data.assignments[assignment] ??= chooseTrial(table, state, rows);
    const previous = data.records.filter(row => row.sampleId === sample && row.tool === tool && row.group === group && row.managed).at(-1);
    const chosen = rescue && previous?.quality === false ? above(table, previous) : previous && rescue ? previous : selected;
    return { tool, model: chosen.model, effort: chosen.effort, managed: true, escalated: !sameModel(chosen, selected) };
  });
}
export async function recordCall(input, env = process.env) {
  const fields = ['project', 'tool', 'group', 'stage', 'model', 'effort', 'elapsedMs', 'tokens', 'ok', 'escalated', 'sampleId', 'callId', 'managed', 'firstPass', 'quality', 'qualityAt', 'status'];
  const row = Object.fromEntries(fields.map(key => [key, input[key] ?? null]));
  return transaction(env, data => {
    if (!data.records.some(item => item.callId === row.callId)) data.records.push(row);
    return row.callId;
  });
}
export async function markQuality(sample, passed, env = process.env) {
  return transaction(env, data => {
    const rows = data.records.filter(row => row.sampleId === sample && row.group === '구현' && row.ok === true);
    const first = rows.find(row => row.stage === '만들기');
    const last = rows.at(-1);
    if (last) last.quality = passed;
    if (first && first.firstPass === null) {
      first.firstPass = passed && first === last;
      first.qualityAt = Date.now();
    }
  });
}
export const newCallId = () => randomUUID();
