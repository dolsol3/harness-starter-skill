import { levelProbes } from './model-exam-checks-levels.mjs';
const boardHarness = `function board(rows) {
  let data=structuredClone(rows);
  return {
    load:()=>structuredClone(data),
    save(value) {
      data=structuredClone(value);
    },
    data:()=>data,
  };
}
const row=(id,unread,state='answered')=>({id,unread,state,extra:id});
`;
const csvHarness = `const {parseCsv}=await import('./parse.mjs');
const {createHash}=await import('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
function setup(text='id,name\\na,가\\n', stored='[{"id":"old","name":"keep"}]\\n') {
  fs.writeFileSync('in.csv',text);
  fs.writeFileSync('out.json',stored);
  return stored;
}
function unchanged(fn) {
  const before=fs.readFileSync('out.json');
  assert.throws(fn);
  assert.deepEqual(fs.readFileSync('out.json'),before);
}
`;
// 채점자 전용. 후보 파일은 별도 사본에서만 import하며 공개 시험을 실행하지 않는다.
export const probes = {
  settings: {
    core: `const c={model:'old',profiles:{codex:{model:'sol'},other:{model:'custom'}},stages:{build:{tool:'codex'},review:{tool:'other',model:'explicit'}}};
assert.equal(choose(c,'other','build'),'sol');
assert.equal(choose(c,'codex','review'),'explicit');
assert.equal(choose(c,'missing','missing'),'old');
assert.equal(choose({profiles:{alien:{model:'arbitrary'}}},'alien'),'arbitrary');
assert.equal(choose({stages:{build:{tool:'absent'}}},'codex','build'),'sonnet');`,
    compatibility: `const c={model:'old',profiles:{codex:{model:'sol'}},stages:{build:{tool:'codex'}}};
assert.equal(choose(c),'old');
assert.equal(choose({}),'sonnet');
assert.equal(choose(c,'codex'),'sol');
fs.writeFileSync('input.json',JSON.stringify(c));
for (const [args,value] of [[[],'old'],[['codex'],'sol'],[['other','build'],'sol']]) {
  assert.equal(execFileSync(process.execPath,['cli.mjs','input.json',...args],{encoding:'utf8'}).trim(),value);
}
fs.writeFileSync('bad.json','{"profiles":null}');
assert.throws(()=>execFileSync(process.execPath,['cli.mjs','bad.json'],{stdio:'pipe'}));`,
    state: `const invalid=[null,[],{model:''},{model:3},{profiles:null},{profiles:[]},{profiles:{x:null}},{profiles:{x:[]}},{profiles:{x:{model:0}}},{stages:null},{stages:{x:{tool:''}}},{stages:{x:{model:false}}}];
for (const config of invalid) {
  assert.throws(()=>choose(config),TypeError);
  fs.writeFileSync('saved.json','original');
  assert.throws(()=>save('saved.json',config,true));
  assert.equal(fs.readFileSync('saved.json','utf8'),'original');
}
for (const arg of [null,'',false,0,[]]) {
  assert.throws(()=>choose({},arg),TypeError);
  assert.throws(()=>choose({},undefined,arg),TypeError);
}
for (const allowed of [undefined,false,1,'true',null]) {
  fs.writeFileSync('saved.json','original');
  assert.throws(()=>save('saved.json',{model:'ok'},allowed));
  assert.equal(fs.readFileSync('saved.json','utf8'),'original');
}
const circular={model:'ok'};
circular.extra=circular;
assert.throws(()=>save('saved.json',circular,true));
assert.equal(fs.readFileSync('saved.json','utf8'),'original');
assert.equal(circular.extra,circular);
const valid=Object.freeze({model:'valid',extra:Object.freeze({keep:7})});
save('saved.json',valid,true);
assert.deepEqual(JSON.parse(fs.readFileSync('saved.json')),valid);`,
    template: `const c=JSON.parse(fs.readFileSync('defaults.json'));
assert.equal(c.model,'sonnet');
assert.equal(c.profiles.codex.model,'sol');
assert.equal(c.stages.build.tool,'codex');
assert.equal(choose(c,'other','build'),'sol');
assert.equal(execFileSync(process.execPath,['cli.mjs','defaults.json','other','build'],{encoding:'utf8'}).trim(),'sol');`,
  },
  answers: {
    core: `${boardHarness}
const rows=Array.from({length:102},(_,i)=>row(String(i),i>=100));
const b=board(rows);
assert.deepEqual(show(b,'answered',1),['100']);
assert.equal(b.data()[100].unread,false);
assert.equal(b.data()[101].unread,true);
assert.deepEqual(b.data().map(x=>x.id),rows.map(x=>x.id));
fs.writeFileSync('cli-board.json',JSON.stringify(rows));
assert.deepEqual(JSON.parse(execFileSync(process.execPath,['cli.mjs','cli-board.json','answered','1'],{encoding:'utf8'})),['100']);
assert.equal(JSON.parse(fs.readFileSync('cli-board.json'))[100].unread,false);`,
    boundaries: `${boardHarness}
const rows=[row('a',false),row('x',true,'waiting'),row('b',true),row('c',true),row('d',false)];
const b=board(rows);
assert.deepEqual(show(b,'answered',3),['b','c','a']);
assert.deepEqual(b.data().map(x=>x.id),rows.map(x=>x.id));
assert.deepEqual(b.data()[1],rows[1]);
const zero=board(rows);
assert.deepEqual(show(zero,'answered',0),[]);
assert.deepEqual(zero.data(),rows);
for (const limit of [-1,1.5,NaN]) {
  const invalid=board(rows);
  assert.throws(()=>show(invalid,'answered',limit),RangeError);
  assert.deepEqual(invalid.data(),rows);
}`, 
    regression: `${boardHarness}
const rows=[row('a',false),row('b',true),row('c',true)];
const b=board(rows);
assert.deepEqual(show(b),['b','c','a']);
assert.deepEqual(b.data(),rows.map(x=>({...x,unread:false})));
assert.deepEqual(show(board([])),[]);`,
    control: `${boardHarness}
const rows=[row('read',false),row('new1',true),row('new2',true),row('other',true,'waiting')];
const b=board(rows);
show(b,'answered',1);
assert.equal(b.data()[2].unread,true);
assert.equal(b.data()[3].unread,true);
assert.deepEqual(b.data().map(x=>x.extra),rows.map(x=>x.extra));`,
  },
  csv: {
    parsing: String.raw`${csvHarness}
assert.deepEqual(parseCsv('id,name\r\na,한글\r\n"b,c","say ""hi"""\r\n'),[{id:'a',name:'한글'},{id:'b,c',name:'say "hi"'}]);
assert.deepEqual(parseCsv('id,name\n A ,\na,x'),[{id:' A ',name:''},{id:'a',name:'x'}]);
assert.deepEqual(parseCsv('id,name'),[]);
assert.equal(parseCsv('id,name\n'+Array.from({length:50},(_,i)=>i+',n').join('\n')).length,50);
for (const text of ['', 'id,name\n\n','id,name\n,x','id,name\na,b,c','id,name\na,"x','id,name\na,x"y','id,name\n"a\nx",y','id,name\n'+Array.from({length:51},(_,i)=>i+',n').join('\n')]) assert.throws(()=>parseCsv(text));`,
    preview: String.raw`${csvHarness}
const before=setup();
const p=preview('in.csv','out.json');
const token=hash(JSON.stringify([hash(fs.readFileSync('in.csv')),hash(fs.readFileSync('out.json'))]));
assert.deepEqual(p,{token,added:1,total:2});
assert.equal(fs.readFileSync('out.json','utf8'),before);
for (const text of ['id,name\na,x\na,y','id,name\nold,conflict']) {
  setup(text);
  unchanged(()=>preview('in.csv','out.json'));
}`, 
    apply: String.raw`${csvHarness}
setup('id,name\nb,second\na,first\n');
const p=preview('in.csv','out.json');
assert.deepEqual(apply('in.csv','out.json',p.token),{added:2,total:3});
assert.deepEqual(JSON.parse(fs.readFileSync('out.json')).map(x=>x.id),['old','b','a']);
const before=setup('id,name\n','[ {"id":"old","name":"keep"} ]\n');
assert.deepEqual(apply('in.csv','out.json',preview('in.csv','out.json').token),{added:0,total:1});
assert.equal(fs.readFileSync('out.json','utf8'),before);
setup();
const output=JSON.parse(execFileSync(process.execPath,['cli.mjs','preview','in.csv','out.json'],{encoding:'utf8'}));
assert.deepEqual(JSON.parse(execFileSync(process.execPath,['cli.mjs','apply','in.csv','out.json',output.token],{encoding:'utf8'})),{added:1,total:2});`,
    changed: String.raw`${csvHarness}
setup();
const valid=preview('in.csv','out.json');
assert.equal(apply('in.csv','out.json',valid.token).added,1);
for (const file of ['in.csv','out.json']) {
  setup();
  const p=preview('in.csv','out.json');
  fs.appendFileSync(file,'\n');
  unchanged(()=>apply('in.csv','out.json',p.token));
}
setup();
unchanged(()=>apply('in.csv','out.json','bad'));
setup('id,name\nold,conflict');
const token=hash(JSON.stringify([hash(fs.readFileSync('in.csv')),hash(fs.readFileSync('out.json'))]));
unchanged(()=>apply('in.csv','out.json',token));`,
  },
  select: {
    filter: `const rows=[{id:'below',score:1},{id:'equal',score:2},{id:'above',score:3}];
assert.deepEqual(select(rows, {minScore:2}).map(x=>x.id).sort(), ['above','equal']);`,
    sorting: `assert.deepEqual(select([{id:'a',score:1},{id:'b',score:3},{id:'c',score:3},{id:'d',score:2}]).map(x=>x.id), ['b','c','d','a']);`,
    limits: `assert.deepEqual(select([{score:3}], {limit:0}), []);
assert.throws(()=>select([], {limit:-1}), RangeError);
assert.throws(()=>select([], {limit:1.5}), RangeError);
assert.throws(()=>select([], {limit:Infinity}), RangeError);
assert.throws(()=>select([], {limit:NaN}), RangeError);
assert.deepEqual(select([{id:'a',score:2},{id:'b',score:2}], {limit:1}).map(x=>x.id), ['a']);`,
    regression: `const rows = Object.freeze([Object.freeze({id:'a',score:-2}),Object.freeze({id:'b',score:-2})]);
assert.deepEqual(select([]), []);
assert.deepEqual(select(rows), [...rows]);
assert.deepEqual(rows, [{id:'a',score:-2},{id:'b',score:-2}]);`,
  },
  review: {
    defect: `assert.throws(()=>total([]), TypeError);`,
    control: `const map = new Map();
const a = {}, b = {};
map.set('x', a);
release(map,'x',a);
map.set('x', b);
await Promise.resolve();
assert.equal(map.get('x'), b);
release(map,'x',b);
await Promise.resolve();
assert.equal(map.has('x'), false);`,
  },
  queue: {
    ordering: `const h = harness();
h.q.add('a');
h.q.add('b');
const first = h.q.run();
const second = h.q.run();
await h.started(0);
assert.deepEqual(h.calls, ['a']);
assert.equal(h.data()[0].state, 'running');
h.pending[0].resolve();
await h.started(1);
assert.deepEqual(h.calls, ['a','b']);
h.pending[1].resolve();
await Promise.all([first,second]);
assert.deepEqual(h.data().map(r=>r.state), ['done','done']);
const reentrant = harness([],()=>{ reentrant.q.run(); });
reentrant.q.add('a');
reentrant.q.add('b');
const completion = reentrant.q.run();
await reentrant.started(0);
assert.deepEqual(reentrant.calls,['a']);
reentrant.pending[0].resolve();
await reentrant.started(1);
assert.deepEqual(reentrant.calls,['a','b']);
reentrant.pending[1].resolve();
await completion;
assert.deepEqual(reentrant.data().map(r=>r.state),['done','done']);`,
    cancel: `const h = harness();
h.q.add('a');
h.q.add('b');
h.q.cancel('b');
const run = h.q.run();
await h.started(0);
h.q.cancel('a');
h.pending[0].resolve();
await run;
assert.deepEqual(h.calls, ['a']);
assert.deepEqual(h.data().map(r=>r.state), ['cancelled','cancelled']);`,
    recovery: `const h = harness([{id:'a',state:'running'},{id:'b',state:'done'},{id:'c',state:'failed'},{id:'d',state:'cancelled'}]);
assert.equal(h.data()[0].state, 'queued');
h.q.add('a');
assert.equal(h.data().length, 4);
const run = h.q.run();
await h.started(0);
h.pending[0].resolve();
await run;
assert.deepEqual(h.calls, ['a']);
assert.deepEqual(h.data().map(r=>r.state), ['done','done','failed','cancelled']);`,
    failure: `const h = harness();
h.q.add('a');
h.q.add('b');
const run = h.q.run();
await h.started(0);
h.pending[0].reject(new Error('expected'));
await h.started(1);
assert.equal(h.data()[0].state, 'failed');
h.pending[1].resolve();
await run;
assert.equal(h.data()[1].state, 'done');`,
  },
  ...levelProbes,
};
export const queueHarness = `function harness(initial = [], onStart = ()=>{}) {
  let data = structuredClone(initial);
  const calls = [], pending = [];
  const waiting = new Map();
  const store = {load:()=>structuredClone(data), save:rows=>{data=structuredClone(rows);}};
  const execute = id => {
    calls.push(id);
    const promise = new Promise((resolve,reject)=>pending.push({resolve,reject}));
    onStart(id);
    waiting.get(calls.length-1)?.();
    return promise;
  };
  const started = index => calls.length > index ? Promise.resolve() : new Promise(resolve=>waiting.set(index,resolve));
  return {q:createQueue(store,execute),calls,pending,started,data:()=>data};
}
`;

