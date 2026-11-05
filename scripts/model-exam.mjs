#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callTool } from '../templates/harness/mullebanga-call.mjs';
import { prompt, schema, grade, versions } from './model-exam-cases.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const positive = value => Number.isSafeInteger(value) && value > 0;
function validate(config) {
  if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 0 || !positive(config.timeoutMs) || !positive(config.maxInputChars)) throw new Error('호출·입력·시간 예산 오류');
  if (!Array.isArray(config.candidates) || !config.candidates.length) throw new Error('후보가 비었다');
  const ids = new Set();
  for (const c of config.candidates) {
    if (!['claude', 'codex', 'gemini'].includes(c.tool) || !positive(config.concurrency?.[c.tool])) throw new Error('도구·동시상한 오류');
    if (typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.model !== 'string' || !c.model || (c.effort !== undefined && typeof c.effort !== 'string')) throw new Error('후보 ID·모델·추론 오류');
    ids.add(c.id);
  }
  if (config.promptSuffix !== undefined && typeof config.promptSuffix !== 'string') throw new Error('promptSuffix는 문자열');
}
// 심볼릭 링크를 따라 가장 가까운 실제 부모도 검사해 저장소 안 출력을 거절한다.
function outside(output) {
  if (!output) throw new Error('--out 저장소밖폴더가 필요하다');
  const full = path.resolve(output);
  let parent = full;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  try {
    execFileSync('git', ['-C', fs.realpathSync(parent), 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (error.status === 128) return full;
    throw error;
  }
  throw new Error('출력은 git 저장소 밖이어야 한다');
}
function snapshot(dir) {
  return JSON.stringify(fs.readdirSync(dir, { recursive: true }).sort().map(name => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    const content = stat.isSymbolicLink() ? fs.readlinkSync(file)
      : stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    return [name, stat.mode, content];
  }));
}
export async function examine(config, output, execute = false, env = process.env) {
  validate(config);
  const out = outside(output);
  const input = prompt + (config.promptSuffix ?? '');
  const inputChars = input.length + JSON.stringify(schema).length;
  if (inputChars > config.maxInputChars) throw new Error(`입력 예산 초과: ${inputChars}`);
  const source = fs.readFileSync(new URL('./model-exam-cases.mjs', import.meta.url), 'utf8');
  const jobs = config.candidates.map(candidate => {
    const key = createHash('sha256').update(JSON.stringify({ candidate, input, schema, versions, source })).digest('hex');
    const file = path.join(out, `${key}.json`);
    const cached = fs.existsSync(file) ? read(file) : undefined;
    return { candidate, key, file, cached: cached?.ok === true ? cached : undefined };
  });
  const newCalls = jobs.filter(job => !job.cached).length;
  if (newCalls > config.maxCalls) throw new Error(`신규 호출 예산 초과: ${newCalls}/${config.maxCalls}`);
  const plan = { config, versions, newCalls, inputChars, output: out, candidates: jobs.map(j => ({ ...j.candidate, reused: !!j.cached })) };
  if (!execute) return plan;
  fs.mkdirSync(out, { recursive: true });
  async function run(job) {
    if (job.cached) return job.result = { ...job.cached, reused: true };
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-exam-')));
    const started = Date.now();
    let raw;
    try {
      execFileSync('git', ['init', '-q', dir], { env: { ...env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
      const callEnv = { ...env };
      const gemini = job.candidate.tool === 'gemini';
      if (job.candidate.tool === 'codex') delete callEnv.HARNESS_READ_ONLY;
      if (gemini) {
        const role = path.join(dir, '.agents', 'agents', 'readonly.md');
        fs.mkdirSync(path.dirname(role), { recursive: true });
        fs.copyFileSync(new URL('../templates/antigravity/readonly.md', import.meta.url), role);
        fs.accessSync(role, fs.constants.R_OK);
        callEnv.HARNESS_READ_ONLY = '1';
      }
      const before = snapshot(dir);
      raw = await callTool({ ...job.candidate, cwd: dir, prompt: input, schema, timeoutMs: config.timeoutMs, write: false,
        agent: gemini ? 'readonly' : undefined, env: callEnv });
      if (snapshot(dir) !== before) throw new Error('임시 cwd의 예상하지 않은 변경');
      job.result = { candidate: job.candidate, versions, key: job.key, ok: raw.ok, reason: raw.reason,
        grade: raw.ok ? grade(raw.result) : undefined, elapsedMs: Date.now() - started, reused: false, usage: '미측정' };
    } catch (error) {
      job.result = { candidate: job.candidate, versions, key: job.key, ok: false, reason: error.message, elapsedMs: Date.now() - started, reused: false, usage: '미측정' };
    } finally {
      save(path.join(out, `${job.key}.raw.json`), raw ?? { error: job.result.reason });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    save(job.file, job.result);
  }
  await Promise.all(Object.keys(config.concurrency).map(async tool => {
    const queue = jobs.filter(job => job.candidate.tool === tool);
    await Promise.all(Array.from({ length: Math.min(queue.length, config.concurrency[tool]) }, async () => {
      while (queue.length) await run(queue.shift());
    }));
  }));
  const summary = { ...plan, results: jobs.map(job => job.result) };
  save(path.join(out, 'summary.json'), summary);
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') options.run = true;
      else if (['--config', '--out'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw new Error(`모르는 옵션 또는 값 누락: ${args[i]}`);
    }
    const config = read(options.config ?? new URL('./model-exam.json', import.meta.url));
    console.log(JSON.stringify(await examine(config, options.out, options.run), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
