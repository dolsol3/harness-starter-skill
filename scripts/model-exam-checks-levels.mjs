import { codeAssets } from './model-exam-public-code.mjs';
// 채점자 전용. 고치기 Q22·Q23의 숨은 행동 검사와, 번갈아 보기 Q20·Q21 재현 파일을 가릴 계약대로 고친 코드다.
const inc = 'const inc=async state=>{await new Promise(resolve=>setTimeout(resolve,20));return state+1;};';
export const levelProbes = {
  memo: {
    root: `assert.equal(convert(100,'USD'),100);
assert.equal(convert(100,'EUR'),90);
assert.equal(convert(100,'KRW'),140000);
assert.equal(taxRate('kr',2025),0.1);
assert.equal(taxRate('kr',2026),0.12);
assert.equal(taxRate('us',2026),0.08);
fs.mkdirSync('wrapped');
fs.copyFileSync('prices.mjs','wrapped/prices.mjs');
fs.writeFileSync('wrapped/memo.mjs',"import {memo as real} from '../memo.mjs';export const made=[];export function memo(fn){const f=real(fn);made.push(f);return f;}");
const wrapped=await import('./wrapped/prices.mjs');
const {made}=await import('./wrapped/memo.mjs');
assert.ok(made.includes(wrapped.convert) && made.includes(wrapped.taxRate));
const {memo}=await import('./memo.mjs');
const f=memo((...args)=>args.length);
assert.equal(f('x'),1);
assert.equal(f('x','y'),2);`,
    boundaries: `const {memo}=await import('./memo.mjs');
const f=memo((...args)=>JSON.stringify(args));
assert.equal(f('a','b'),'["a","b"]');
assert.equal(f('a','c'),'["a","c"]');
assert.equal(f('1'),'["1"]');
assert.equal(f(1),'[1]');
assert.equal(f('a,b'),'["a,b"]');
assert.equal(f('a','b'),'["a","b"]');
assert.equal(f('a','b','c'),'["a","b","c"]');
assert.equal(f('a','b','d'),'["a","b","d"]');`,
    cache: `const {memo}=await import('./memo.mjs');
let calls=0;
const f=memo((a,b)=>{calls++;return a+b;});
assert.equal(f(1,2),3);
assert.equal(f(1,2),3);
assert.equal(f(2,1),3);
assert.equal(f(1,2),3);
assert.equal(calls,2);`,
  },
  ledger: {
    ordering: `${inc}
fs.writeFileSync('a.json','[{"id":"x","state":0,"note":"keep"},{"id":"y","state":5}]');
const results=await Promise.all([update('a.json','x',inc),update('a.json','x',inc),update('a.json','z',async state=>state===undefined?'new':'bad')]);
assert.deepEqual(results,[1,2,'new']);
assert.deepEqual(JSON.parse(fs.readFileSync('a.json','utf8')),[{id:'x',state:2,note:'keep'},{id:'y',state:5},{id:'z',state:'new'}]);`,
    identity: `${inc}
fs.writeFileSync('b.json','[{"id":"x","state":0}]');
await Promise.all([update('b.json','x',inc),update('./b.json','x',inc),update(process.cwd()+'/b.json','x',inc)]);
assert.equal(JSON.parse(fs.readFileSync('b.json','utf8'))[0].state,3);`,
    independence: `fs.writeFileSync('c.json','[]');
fs.writeFileSync('d.json','[]');
let release;
const gate=new Promise(resolve=>{release=resolve;});
const slow=update('c.json','x',async()=>{await gate;return 1;});
let done=false;
const fast=update('d.json','y',async()=>2).then(value=>{done=true;return value;});
await new Promise(resolve=>setTimeout(resolve,300));
assert.equal(done,true);
release();
assert.deepEqual(await Promise.all([slow,fast]),[1,2]);`,
    failure: `fs.writeFileSync('e.json',' [ {"id":"x","state":1} ] ');
const before=fs.readFileSync('e.json','utf8');
await assert.rejects(update('e.json','x',async()=>{throw new Error('expected');}),/expected/);
await assert.rejects(update('e.json','x',async()=>10n));
await assert.rejects(update('e.json','x',async()=>undefined));
assert.equal(fs.readFileSync('e.json','utf8'),before);
${inc}
const settled=await Promise.allSettled([update('e.json','x',inc),update('e.json','x',async()=>{throw new Error('again');}),update('e.json','x',async()=>10n),update('e.json','x',inc)]);
assert.deepEqual(settled.map(row=>row.status),['fulfilled','rejected','rejected','fulfilled']);
assert.equal(JSON.parse(fs.readFileSync('e.json','utf8'))[0].state,3);`,
  },
};
export const fixedSources = {
  Q20: { 'limits.mjs': `export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter(time => t - time < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
` },
  Q21: { 'cache.mjs': `export function createCache(load, { ttlMs, now = Date.now }) {
  const values = new Map();
  const inflight = new Map();
  function get(key) {
    const hit = values.get(key);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const pending = load(key).then(value => {
      if (inflight.get(key) === pending) values.set(key, { value, at: now() });
      return value;
    }).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }
  function invalidate(key) {
    values.delete(key);
    inflight.delete(key);
  }
  return { get, invalidate };
}
` },
};
// 결함마다 그 결함만 남긴 코드다. 재현이 여기서 실패하고 고친 코드에서 통과해야 그 결함을 재현한 것이다.
const limits = codeAssets.Q20['limits.mjs'];
export const defectSources = {
  Q20: { window: { 'limits.mjs': fixedSources.Q20['limits.mjs'].replace('t - time < windowMs', 't - time <= windowMs') },
    rejected: { 'limits.mjs': limits.replace('t - time <= windowMs', 't - time < windowMs') } },
  Q21: { staleCompletion: {} },
};
