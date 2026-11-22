import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionQueue,SELECTION_QUEUE_KEY} from '../extension/selection-queue.ts';

const material=text=>({text,context:'Nearby '+text,status:'matched',source:{title:'Synthetic page',url:'https://example.test/learning'},binding:{tabId:1,windowId:1}});
const identity=(clientId='first',owner='one',windowId=1)=>({clientId,owner,windowId});
function fixture(){
  const data={},events=[];let count=0;
  const area={async get(key){return {[key]:structuredClone(data[key])};},async set(value){Object.assign(data,structuredClone(value));}};
  const queue=new SelectionQueue(area,snapshot=>events.push(snapshot),()=>`synthetic-${++count}`,()=>1000+count);
  const first=identity(),second=identity('second','one',2);queue.register(first);queue.register(second);
  const command=(op,values={},who=first)=>queue.command({kind:'selection-queue',op,...who,...values});
  return {queue,area,data,events,first,second,command};
}

test('selection jobs reserve click order before context reads and only one panel receives the execution grant',async()=>{
  const f=fixture(),a=await f.queue.enqueue('one',1,material('first selection')),b=await f.queue.enqueue('one',1,material('second selection'));
  await f.queue.contextReady('one',b.id,{context:'Second context'});
  assert.equal((await f.command('claim',{explanationLanguage:'en'})).job,null,'a later context reply must not overtake the head');
  await f.queue.contextReady('one',a.id,{context:'First context'});
  const attempts=await Promise.all([f.command('claim',{explanationLanguage:'ja'}),f.command('claim',{explanationLanguage:'ja'}),f.command('claim',{explanationLanguage:'en'},f.second)]);
  assert.equal(attempts.filter(reply=>reply.job).length,1);
  const job=attempts.find(reply=>reply.job).job;
  assert.equal(job.id,a.id);assert.equal(job.params.context,'First context');assert.equal(job.params.explanation_language,'ja');
  const saved=f.data[SELECTION_QUEUE_KEY];assert.equal(saved.active.requestId,job.requestId);assert.equal(saved.active.recordId,job.recordId);assert.deepEqual(saved.active.params,job.params);
  await f.command('finish',{jobId:job.id,terminalStatus:'complete'});
  assert.equal((await f.command('claim',{explanationLanguage:'en'})).job.id,b.id);
});

test('an origin window retains ready work until it closes, then another same-account panel can take over',async()=>{
  const f=fixture(),job=await f.queue.enqueue('one',1,material('source window'));
  await f.queue.contextReady('one',job.id,{});
  assert.equal((await f.command('claim',{explanationLanguage:'zh'},f.second)).job,null);
  await f.queue.disconnect(f.first.clientId,'one');
  const grant=await f.command('claim',{explanationLanguage:'en'},f.second);
  assert.equal(grant.job.id,job.id);assert.equal(grant.job.executorId,'second');
});

test('a model permit is returned only after its complete identity and material have persisted',async()=>{
  const f=fixture(),job=await f.queue.enqueue('one',1,material('persist before post'));await f.queue.contextReady('one',job.id,{});
  const write=f.area.set;let release,writing=false,granted=false;
  f.area.set=async value=>{writing=true;await new Promise(resolve=>{release=resolve;});await write(value);};
  const claim=f.command('claim',{explanationLanguage:'ja'}).then(value=>{granted=true;return value;});
  while(!writing)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(granted,false);assert.equal(f.data[SELECTION_QUEUE_KEY].active,null);
  release();const result=await claim;assert.equal(granted,true);assert.deepEqual(f.data[SELECTION_QUEUE_KEY].active.params,result.job.params);
});

test('storage failure cannot return a usable permit or consume the ready task',async()=>{
  const f=fixture(),job=await f.queue.enqueue('one',1,material('storage failure'));await f.queue.contextReady('one',job.id,{});
  const write=f.area.set;f.area.set=async()=>{throw Error('QUOTA_EXCEEDED');};
  await assert.rejects(f.command('claim',{explanationLanguage:'en'}),/QUOTA_EXCEEDED/);
  f.area.set=write;const state=(await f.command('sync')).snapshot;
  assert.equal(state.active,null);assert.equal(state.waiting[0].id,job.id);
  assert.equal((await f.command('claim',{explanationLanguage:'en'})).job.id,job.id);
});

test('worker restart and disconnected executors recover by record ID without issuing a second POST grant',async()=>{
  const f=fixture(),first=await f.queue.enqueue('one',1,material('possibly sent')),second=await f.queue.enqueue('one',2,material('after recovery'));
  await f.queue.contextReady('one',first.id,{});await f.queue.contextReady('one',second.id,{});
  const granted=(await f.command('claim',{explanationLanguage:'en'})).job;
  const restarted=new SelectionQueue(f.area);restarted.register(f.second);
  const call=(op,extra={})=>restarted.command({kind:'selection-queue',op,...f.second,...extra});
  const snapshot=(await call('sync')).snapshot;
  assert.equal(snapshot.active.phase,'unknown');assert.equal(snapshot.active.recordId,granted.recordId);assert.equal(snapshot.active.requestId,granted.requestId);
  assert.equal((await call('claim',{explanationLanguage:'ja'})).job,null);
  assert.equal((await call('recover',{jobId:first.id})).job,null,'recovery can never be an execution grant');
  await call('recover',{jobId:first.id,terminalStatus:'interrupted'});
  assert.equal((await call('claim',{explanationLanguage:'en'})).job.id,second.id);
});

test('manual OCR and automatic text share one permit; image bytes are not retained in completed history or snapshots',async()=>{
  const f=fixture(),image='data:image/png;base64,'+'A'.repeat(4096);
  const permit=(await f.command('acquire',{action:'learning.recognize',requestId:'ocr-request',recordId:'ocr-record',params:{image,record_id:'ocr-record'}})).job;
  assert.equal(f.data[SELECTION_QUEUE_KEY].active.params.image,image);
  assert.equal((await f.command('sync')).snapshot.active.params.image,undefined);
  const text=await f.queue.enqueue('one',1,material('after screenshot'));await f.queue.contextReady('one',text.id,{});
  assert.equal((await f.command('claim',{explanationLanguage:'zh'})).job,null);
  await assert.rejects(f.command('acquire',{action:'learning.retry',requestId:'retry',recordId:'old-record',params:{text:'manual'}}),/REQUEST_IN_PROGRESS/);
  await f.command('finish',{jobId:permit.id,terminalStatus:'awaiting_review'});
  assert.equal(f.data[SELECTION_QUEUE_KEY].last.params.image,undefined);
  assert.equal((await f.command('claim',{explanationLanguage:'en'})).job.id,text.id);
});

test('missing setup preserves a manual draft across first login but never resumes it automatically',async()=>{
  const f=fixture(),guest=identity('guest',null,1);f.queue.register(guest);await f.queue.syncOwner(null);
  const selected=await f.queue.enqueue(null,1,material('before first login'));await f.queue.contextReady(null,selected.id,{});
  const fallback=await f.command('manual',{reason:'login'},guest);
  assert.equal(fallback.draft.text,'before first login');assert.equal(fallback.snapshot.paused,'setup');
  await f.queue.syncOwner('one');
  const signedIn=await f.command('sync');assert.equal(signedIn.snapshot.manualDraft.text,'before first login');assert.equal(signedIn.snapshot.manualDraft.owner,'one');
  assert.equal((await f.command('claim',{explanationLanguage:'en'})).job,null);
  const permit=await f.command('acquire',{action:'learning.submit',requestId:'explicit-request',recordId:'explicit-record',params:{text:'before first login',record_id:'explicit-record',explanation_language:'en'}});
  assert.equal(permit.snapshot.manualDraft,null);assert.equal(permit.snapshot.paused,null);assert.equal(permit.job.requestId,'explicit-request');
});

test('a missing Key pauses remaining selections until an explicit manual query and clear drops only waiting work',async()=>{
  const f=fixture(),first=await f.queue.enqueue('one',1,material('needs key')),second=await f.queue.enqueue('one',1,material('queued second'));
  await f.queue.contextReady('one',first.id,{});await f.queue.contextReady('one',second.id,{});
  const manual=await f.command('manual',{reason:'key'});assert.equal(manual.draft.text,'needs key');
  assert.equal((await f.command('manual',{reason:'key'})).draft.text,'needs key','polling must not consume another queued selection');
  assert.equal((await f.command('claim',{explanationLanguage:'ja'})).job,null);
  const explicit=(await f.command('acquire',{action:'learning.submit',requestId:'manual',recordId:'manual-record',params:{text:'needs key'}})).job;
  await f.command('clear');const state=(await f.command('sync')).snapshot;
  assert.equal(state.waiting.length,0);assert.equal(state.manualDraft,null);assert.equal(state.active.id,explicit.id);
});

test('account changes discard old work, and late context, disconnect and panel commands cannot reset the new account',async()=>{
  const f=fixture(),old=await f.queue.enqueue('one',1,material('old private material'));
  await f.queue.syncOwner('two');const next=identity('next','two',2);f.queue.register(next);
  const current=await f.queue.enqueue('two',2,material('new account material'));
  await f.queue.contextReady('one',old.id,{context:'late private context'});await f.queue.disconnect(f.first.clientId,'one');
  f.queue.register(f.first);await assert.rejects(f.command('sync'),/SESSION_CHANGED/);
  const state=(await f.command('sync',{},next)).snapshot;
  assert.equal(state.owner,'two');assert.equal(state.waiting.length,1);assert.equal(state.waiting[0].id,current.id);assert.equal(state.manualDraft,null);
});

test('skipping unknown work never reissues its request and stale completion cannot finish the next task',async()=>{
  const f=fixture(),a=await f.queue.enqueue('one',1,material('unknown first')),b=await f.queue.enqueue('one',1,material('next task'));
  await f.queue.contextReady('one',a.id,{});await f.queue.contextReady('one',b.id,{});await f.command('claim',{explanationLanguage:'en'});
  await f.command('unknown',{jobId:a.id,error:'NETWORK_ERROR'});await f.command('skip',{jobId:a.id});
  const next=(await f.command('claim',{explanationLanguage:'en'})).job;assert.equal(next.id,b.id);assert.notEqual(next.requestId,a.requestId);
  await assert.rejects(f.command('finish',{jobId:a.id,terminalStatus:'complete'}),/QUEUE_TASK_CHANGED/);
  assert.equal((await f.command('sync')).snapshot.active.id,b.id);
});

test('queue commands require a registered account and window identity',async()=>{
  const f=fixture();await assert.rejects(f.command('sync',{},identity('stranger')),/UNTRUSTED_SENDER/);
  await assert.rejects(f.command('sync',{},identity('first','one',99)),/UNTRUSTED_SENDER/);
  assert.equal((await f.command('sync')).snapshot.owner,'one');
});
