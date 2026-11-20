export const referenceSolutions = {
  Q7: {
    'settings.mjs': `import fs from 'node:fs';
function object(value) {
  if (value===null || typeof value!=='object' || Array.isArray(value)) throw new TypeError('object');
}
function text(value) {
  if (typeof value!=='string' || !value.length) throw new TypeError('string');
}
function validate(config) {
  object(config);
  if (Object.hasOwn(config,'model')) text(config.model);
  for (const name of ['profiles','stages']) {
    if (!Object.hasOwn(config,name)) continue;
    object(config[name]);
    for (const entry of Object.values(config[name])) {
      object(entry);
      if (Object.hasOwn(entry,'model')) text(entry.model);
      if (name==='stages' && Object.hasOwn(entry,'tool')) text(entry.tool);
    }
  }
}
export function choose(config,tool,stage) {
  validate(config);
  if (tool!==undefined) text(tool);
  if (stage!==undefined) text(stage);
  const entry=stage===undefined?undefined:config.stages?.[stage];
  const effective=entry?.tool ?? tool;
  return entry?.model ?? config.profiles?.[effective]?.model ?? config.model ?? 'sonnet';
}
export function save(file,config,allowed) {
  if (allowed!==true) throw new Error('not allowed');
  validate(config);
  const bytes=JSON.stringify(config);
  fs.writeFileSync(file,bytes);
}
`,
    'cli.mjs': `import fs from 'node:fs';
import {choose} from './settings.mjs';
console.log(choose(JSON.parse(fs.readFileSync(process.argv[2])),process.argv[3],process.argv[4]));
`,
    'defaults.json': '{"model":"sonnet","profiles":{"codex":{"model":"sol"}},"stages":{"build":{"tool":"codex"}}}\n',
  },
  Q8: {
    'answers.mjs': `export function show(store,state='answered',limit=100) {
  if (!Number.isInteger(limit) || limit<0) throw new RangeError('limit');
  if (limit===0) return [];
  const rows=store.load();
  const matching=rows.filter(row=>row.state===state);
  const shown=[...matching.filter(row=>row.unread),...matching.filter(row=>!row.unread)].slice(0,limit);
  const ids=shown.map(row=>row.id);
  for (const row of rows) if (ids.includes(row.id)) row.unread=false;
  store.save(rows);
  return ids;
}
`,
  },
  Q10: {
    'parse.mjs': String.raw`export function parseCsv(text) {
  if (text.includes('\r') && text.replaceAll('\r\n','').includes('\r')) throw new Error('newline');
  const lines=text.replaceAll('\r\n','\n').split('\n');
  if (lines.at(-1)==='') lines.pop();
  if (lines.shift()!=='id,name' || lines.length>50) throw new Error('header or limit');
  return lines.map(line=>{
    const fields=[];
    let field='';
    let quoted=false;
    let closed=false;
    for (let i=0;i<line.length;i++) {
      const ch=line[i];
      if (quoted) {
        if (ch!=='"') field+=ch;
        else if (line[i+1]==='"') {
          field+='"';
          i++;
        } else {
          quoted=false;
          closed=true;
        }
      } else if (ch===',') {
        fields.push(field);
        field='';
        closed=false;
      } else if (ch==='"' && !field && !closed) quoted=true;
      else if (ch==='"' || closed) throw new Error('quote');
      else field+=ch;
    }
    if (quoted) throw new Error('quote');
    fields.push(field);
    if (fields.length!==2 || !fields[0]) throw new Error('columns');
    return {id:fields[0],name:fields[1]};
  });
}
`,
    'store.mjs': String.raw`import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parseCsv} from './parse.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function load(csvFile,storeFile) {
  const csv=fs.readFileSync(csvFile);
  const bytes=fs.readFileSync(storeFile);
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const rows=parseCsv(decoder.decode(csv));
  const existing=JSON.parse(decoder.decode(bytes));
  const seen=new Set(existing.map(row=>row.id));
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error('duplicate');
    seen.add(row.id);
  }
  const token=hash(JSON.stringify([hash(csv),hash(bytes)]));
  return {rows,existing,token};
}
export function preview(csvFile,storeFile) {
  const {rows,existing,token}=load(csvFile,storeFile);
  return {token,added:rows.length,total:existing.length+rows.length};
}
export function apply(csvFile,storeFile,token) {
  const data=load(csvFile,storeFile);
  if (data.token!==token) throw new Error('changed token');
  if (data.rows.length) fs.writeFileSync(storeFile,JSON.stringify([...data.existing,...data.rows]));
  return {added:data.rows.length,total:data.existing.length+data.rows.length};
}
`,
    'cli.mjs': `import {preview,apply} from './store.mjs';
const [mode,csv,store,token]=process.argv.slice(2);
if (!['preview','apply'].includes(mode)) throw new Error('mode');
console.log(JSON.stringify(mode==='preview'?preview(csv,store):apply(csv,store,token)));
`,
  },
  Q22: { 'memo.mjs': `export function memo(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key);
  };
}
` },
  Q23: { 'ledger.mjs': `import fs from 'node:fs/promises';
import path from 'node:path';
const queues = new Map();
async function apply(file, id, change) {
  const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  let row = rows.find(item => item.id === id);
  const state = await change(row?.state);
  if (JSON.stringify(state) === undefined) throw new TypeError('JSON으로 바꿀 수 없는 state');
  const next = row ? rows : [...rows, { id }];
  row ??= next.at(-1);
  const text = JSON.stringify(next.map(item => item === row ? { ...item, state } : item));
  await fs.writeFile(file, text);
  return state;
}
export function update(file, id, change) {
  const key = path.resolve(file);
  const current = (queues.get(key) ?? Promise.resolve()).then(() => apply(file, id, change));
  queues.set(key, current.then(() => undefined, () => undefined));
  return current;
}
` },
};
