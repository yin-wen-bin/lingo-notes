import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionQueue,SELECTION_QUEUE_KEY} from '../extension/selection-queue.ts';
import {createSelectionBackground,eventually} from './helpers/selection-background.mjs';

const material=text=>({text,context:'Context '+text,status:'matched',source:{title:'Synthetic',url:'https://example.test'}});
const who=(clientId='first',windowId=1,owner='one')=>({clientId,windowId,owner});
function fixture(saved){
  const data=saved?{[SELECTION_QUEUE_KEY]:structuredClone(saved)}:{};let counter=0;
  const area={async get(key){return {[key]:structuredClone(data[key])};},async set(values){Object.assign(data,structuredClone(values));}};
  const queue=new SelectionQueue(area,()=>{},()=>`synthetic-${++counter}`,()=>1000+counter),first=who(),second=who('second',2);queue.register(first);queue.register(second);
  const command=(op,extra={},identity=first)=>queue.command({kind:'selection-queue',op,...identity,...extra});
  return {data,queue,area,first,second,command};
}
const commandFor=(identity,op,extra={})=>({kind:'selection-queue',...identity,op,...extra});

test('presentations belong to the click window and track prepared, running and completed job state',async()=>{
  const f=fixture(),a=await f.queue.enqueue('one',1,material('first')),other=await f.queue.enqueue('one',2,material('other window'));
  await f.queue.contextReady('one',a.id,{context:'Prepared context'});let snapshot=(await f.command('sync')).snapshot;
  assert.equal(snapshot.presentations['1'].context,'Prepared context');assert.equal(snapshot.presentations['1'].phase,'ready');assert.equal(snapshot.presentations['2'].id,other.id);
  assert.equal((await f.command('presented',{jobId:a.id,sequence:a.sequence},f.second)).snapshot.presented['2'],undefined);
  await f.command('presented',{jobId:a.id,sequence:a.sequence});
  const b=await f.queue.enqueue('one',1,material('newest'));await f.command('presented',{jobId:a.id,sequence:a.sequence});
  snapshot=(await f.command('sync')).snapshot;assert.equal(snapshot.presented['1'],a.sequence);assert.equal(snapshot.presentations['1'].id,b.id);assert.ok(snapshot.presented['1']<b.sequence);
  const grant=(await f.command('claim',{explanationLanguage:'ja'})).job;assert.equal(grant.id,a.id);
  await f.command('finish',{jobId:a.id,terminalStatus:'complete',revision:1});
  await f.queue.contextReady('one',other.id,{});const second=(await f.command('claim',{explanationLanguage:'en'},f.second)).job;
  await f.command('finish',{jobId:second.id,terminalStatus:'complete',revision:1},f.second);
  await f.queue.contextReady('one',b.id,{});await f.command('claim',{explanationLanguage:'en'});
  snapshot=(await f.command('sync')).snapshot;assert.equal(snapshot.presentations['1'].phase,'running');assert.equal(snapshot.presentations['1'].params.explanation_language,'en');
  await f.command('finish',{jobId:b.id,terminalStatus:'failed',revision:1});
  const manual=(await f.command('acquire',{action:'learning.submit',requestId:'manual-request',recordId:'manual-record',params:{text:'manual'}})).job;
  await f.command('finish',{jobId:manual.id,terminalStatus:'complete',revision:1});
  snapshot=(await f.command('sync')).snapshot;assert.equal(snapshot.last.id,manual.id);assert.equal(snapshot.presentations['1'].id,b.id);assert.equal(snapshot.presentations['1'].terminalStatus,'failed');
});

test('old v1 storage upgrades metadata without fabricating navigation or changing request identities',async()=>{
  const f=fixture(),job=await f.queue.enqueue('one',1,material('old saved work'));await f.queue.contextReady('one',job.id,{});await f.command('claim',{explanationLanguage:'en'});
  const saved=structuredClone(f.data[SELECTION_QUEUE_KEY]);delete saved.presentations;delete saved.presented;delete saved.recordsVersion;delete saved.recordSignatures;delete saved.skippedRequests;
  const upgraded=fixture(saved),snapshot=(await upgraded.command('sync')).snapshot;
  assert.deepEqual(snapshot.presentations,{});assert.deepEqual(snapshot.presented,{});assert.equal(snapshot.recordsVersion,0);
  assert.equal(snapshot.active.phase,'unknown');assert.equal(snapshot.active.recordId,job.recordId);assert.equal(snapshot.active.requestId,job.requestId);assert.equal(snapshot.active.executorId,undefined);
  assert.deepEqual(upgraded.data[SELECTION_QUEUE_KEY].presentations,{});assert.deepEqual(snapshot.skippedRequests,[]);assert.deepEqual(upgraded.data[SELECTION_QUEUE_KEY].skippedRequests,[]);assert.equal('recordSignatures' in snapshot,false);
});

test('explicit skipped request identities survive later results and worker recovery without inventing a cloud terminal status',async()=>{
  const f=fixture();
  const first=(await f.command('acquire',{action:'learning.submit',requestId:'skipped-request',recordId:'still-processing-record',params:{text:'manual work'}})).job;
  await f.command('unknown',{jobId:first.id});await f.command('skip',{jobId:first.id},f.second);
  let snapshot=(await f.command('sync')).snapshot;
  assert.deepEqual(snapshot.skippedRequests,[{recordId:first.recordId,requestId:first.requestId}]);assert.equal(snapshot.recordsVersion,0,'skip does not report a fabricated terminal cloud record');
  const next=(await f.command('acquire',{action:'learning.submit',requestId:'later-request',recordId:'later-record',params:{text:'later work'}})).job;
  await f.command('finish',{jobId:next.id,terminalStatus:'complete',revision:1});snapshot=(await f.command('sync')).snapshot;
  assert.equal(snapshot.last.id,next.id);assert.deepEqual(snapshot.skippedRequests,[{recordId:first.recordId,requestId:first.requestId}]);
  const reopened=fixture(f.data[SELECTION_QUEUE_KEY]),restored=(await reopened.command('sync')).snapshot;
  assert.equal(restored.last.id,next.id);assert.deepEqual(restored.skippedRequests,[{recordId:first.recordId,requestId:first.requestId}]);assert.equal(restored.active,null);
});

test('skip receipts distinguish requests, deduplicate exact pairs, remain bounded and clear on account change',async()=>{
  const f=fixture(),skip=async(recordId,requestId)=>{
    const job=(await f.command('acquire',{action:'learning.submit',requestId,recordId,params:{text:'synthetic skip'}})).job;
    await f.command('unknown',{jobId:job.id});return (await f.command('skip',{jobId:job.id})).snapshot;
  };
  await skip('same-record','first-request');await skip('same-record','second-request');let snapshot=await skip('same-record','first-request');
  assert.deepEqual(snapshot.skippedRequests,[{recordId:'same-record',requestId:'second-request'},{recordId:'same-record',requestId:'first-request'}]);
  for(let i=0;i<257;i++)snapshot=await skip('bounded-record-'+i,'bounded-request-'+i);
  assert.equal(snapshot.skippedRequests.length,256);assert.deepEqual(snapshot.skippedRequests[0],{recordId:'bounded-record-1',requestId:'bounded-request-1'});assert.equal(f.data[SELECTION_QUEUE_KEY].skippedRequests.length,256);
  await f.queue.syncOwner('two');const next=who('next',1,'two');f.queue.register(next);
  assert.deepEqual((await f.command('sync',{},next)).snapshot.skippedRequests,[]);assert.deepEqual(f.data[SELECTION_QUEUE_KEY].skippedRequests,[]);
});

test('legacy or malformed skip metadata normalizes without deriving skipped requests from old jobs',async()=>{
  const f=fixture(),job=(await f.command('acquire',{action:'learning.submit',requestId:'old-request',recordId:'old-record',params:{text:'old work'}})).job;
  await f.command('unknown',{jobId:job.id});await f.command('skip',{jobId:job.id});
  const original=structuredClone(f.data[SELECTION_QUEUE_KEY]);
  for(const metadata of [undefined,null,{},[null,{recordId:'',requestId:'r'},{recordId:'r',requestId:1},{recordId:'r',requestId:'x'.repeat(257)}]]){
    const saved=structuredClone(original);if(metadata===undefined)delete saved.skippedRequests;else saved.skippedRequests=metadata;
    const restored=fixture(saved),snapshot=(await restored.command('sync')).snapshot;
    assert.equal(snapshot.last.terminalStatus,'skipped');assert.deepEqual(snapshot.skippedRequests,[]);assert.deepEqual(restored.data[SELECTION_QUEUE_KEY].skippedRequests,[]);
  }
  const duplicate=fixture({...original,skippedRequests:[{recordId:'r',requestId:'a',extra:'discard'},{recordId:'r',requestId:'b'},{recordId:'r',requestId:'a'}]});
  assert.deepEqual((await duplicate.command('sync')).snapshot.skippedRequests,[{recordId:'r',requestId:'b'},{recordId:'r',requestId:'a'}]);
});

test('record invalidation is deduplicated across clients, bounded to 256 signatures and reset by account',async()=>{
  const f=fixture(),record={recordId:'shared-record',revision:1,status:'processing'};
  await Promise.all([f.command('record-changed',record),f.command('record-changed',record,f.second)]);
  assert.equal((await f.command('sync')).snapshot.recordsVersion,1);
  await f.command('record-changed',{...record,status:'complete'});await f.command('record-changed',{...record,revision:2,status:'complete'});await f.command('record-changed',{...record,revision:2,status:'deleted'},f.second);
  assert.equal((await f.command('sync')).snapshot.recordsVersion,4);
  for(let i=0;i<260;i++)await f.command('record-changed',{recordId:`bounded-${i}`,revision:1,status:'complete'});
  assert.equal(f.data[SELECTION_QUEUE_KEY].recordSignatures.length,256);assert.equal((await f.command('sync')).snapshot.recordsVersion,264);
  await f.command('record-changed',record);assert.equal((await f.command('sync')).snapshot.recordsVersion,265,'evicted signatures may invalidate again without retaining unbounded history');
  for(const invalid of [{recordId:'',revision:1,status:'complete'},{recordId:'r',revision:0,status:'complete'},{recordId:'r',revision:1,status:'invented'}])await assert.rejects(f.command('record-changed',invalid),/INVALID_QUEUE_REQUEST/);
  await f.queue.syncOwner('two');const next=who('next',1,'two');f.queue.register(next);
  const snapshot=(await f.command('sync',{},next)).snapshot;assert.equal(snapshot.recordsVersion,0);assert.deepEqual(snapshot.presentations,{});assert.deepEqual(snapshot.presented,{});assert.deepEqual(f.data[SELECTION_QUEUE_KEY].recordSignatures,[]);
});

test('finish/recovery record invalidation deduplicates explicit notifications and clear retires only waiting intentions',async()=>{
  const f=fixture(),a=await f.queue.enqueue('one',1,material('running')),b=await f.queue.enqueue('one',2,material('cleared waiting'));
  await f.queue.contextReady('one',a.id,{});await f.queue.contextReady('one',b.id,{});await f.command('claim',{explanationLanguage:'en'});
  await f.command('clear');let snapshot=(await f.command('sync')).snapshot;
  assert.equal(snapshot.active.id,a.id);assert.equal(snapshot.presented['1'],undefined);assert.equal(snapshot.presented['2'],b.sequence);assert.equal(snapshot.waiting.length,0);
  await f.command('record-changed',{recordId:a.recordId,revision:1,status:'complete'});await f.command('finish',{jobId:a.id,terminalStatus:'complete',revision:1});
  snapshot=(await f.command('sync')).snapshot;assert.equal(snapshot.recordsVersion,1);
  const next=(await f.command('acquire',{action:'learning.retry',requestId:'retry',recordId:a.recordId,params:{revision:1,text:'retry'}})).job;
  await f.command('unknown',{jobId:next.id});await f.command('recover',{jobId:next.id,terminalStatus:'interrupted',revision:2});assert.equal((await f.command('sync')).snapshot.recordsVersion,2);
});

test('clearing an unconsumed setup draft retires the originating window intention',async()=>{
  const f=fixture(),job=await f.queue.enqueue('one',1,material('unconsumed missing Key selection'));await f.queue.contextReady('one',job.id,{});
  await f.command('manual',{reason:'key'});let snapshot=(await f.command('sync')).snapshot;
  assert.equal(snapshot.manualDraft.nonce,job.id);assert.equal(snapshot.presented['1'],undefined);assert.equal(snapshot.presentations['1'].phase,'ready');
  await f.command('clear',{},f.second);snapshot=(await f.command('sync')).snapshot;
  assert.equal(snapshot.manualDraft,null);assert.equal(snapshot.presented['1'],job.sequence);assert.equal(snapshot.presented['2'],undefined);assert.equal(snapshot.waiting.length,0);
});

test('authorization is rechecked inside the serialized queue transaction',async()=>{
  const f=fixture();await f.command('sync');let release,started=false;const write=f.area.set;
  f.area.set=async value=>{started=true;await new Promise(resolve=>{release=resolve;});await write(value);};
  const updating=f.queue.enqueue('one',1,material('storage gate'));
  await eventually(()=>started);const stale=f.command('claim',{explanationLanguage:'en'}),rejected=assert.rejects(stale,/UNTRUSTED_SENDER/);
  const disconnection=f.queue.disconnect(f.first.clientId,'one');release();await updating;await rejected;await disconnection;
  assert.equal(f.data[SELECTION_QUEUE_KEY].active,null);
});

async function backgroundFixture(t){
  const origin='https://coordinator.example.test',sessionKey='lingo-session:'+origin;
  const host=await createSelectionBackground({origin,local:{[sessionKey]:JSON.stringify({user:{id:'one'}})}});t.after(()=>host.close());
  const inbox=[],page={isClosed(){return false;},async evaluate(_fn,payload){inbox.push(payload);}};
  const identity={...who('stable-panel'),transportId:'old-transport'};
  const port=async(id)=>{await host.bridge(page,{kind:'connect',id});return host.ports.get(id);};
  const register=(id)=>host.bridge(page,{kind:'port',id,message:{kind:'selection-queue.register',...identity,transportId:id+'-transport'}});
  const call=(op,extra={})=>host.bridge(page,{kind:'runtime',message:commandFor(identity,op,extra)});
  const registered=id=>inbox.some(item=>item.id===id&&item.message?.event==='selection-queue.registered');
  return {host,page,inbox,identity,port,register,call,registered};
}

for(const active of [false,true])test(`late old port disconnect cannot remove the replacement registration (${active?'active':'idle'} queue)`,async t=>{
  const f=await backgroundFixture(t),old=await f.port('old');await f.register('old');await eventually(()=>f.registered('old'));
  let job;if(active){await f.host.select('active synthetic work');await eventually(()=>f.host.snapshot()?.waiting[0]?.phase==='ready');const reply=await f.call('claim',{explanationLanguage:'en'});assert.equal(reply.ok,true);job=reply.result.job;}
  await f.port('new');const registering=f.register('new');old.onDisconnect.emit();await registering;await eventually(()=>f.registered('new'));
  old.onDisconnect.emit();old.onMessage.emit({kind:'selection-queue.register',...f.identity});
  assert.equal((await f.call('sync')).error,'UNTRUSTED_SENDER');
  const sync=await f.call('sync',{transportId:'new-transport'});assert.equal(sync.ok,true);assert.equal(f.host.ports.has('new'),true);
  if(active){assert.equal(sync.result.snapshot.active.id,job.id);assert.equal(sync.result.snapshot.active.phase,'running');assert.equal(sync.result.snapshot.active.executorId,f.identity.clientId);}
});

test('old registration queued after its replacement never reacquires ownership',async t=>{
  const f=await backgroundFixture(t),old=await f.port('old');await f.register('old');await eventually(()=>f.registered('old'));
  await f.port('new');const registering=f.register('new');old.onMessage.emit({kind:'selection-queue.register',...f.identity});await registering;await eventually(()=>f.registered('new'));
  const sync=await f.call('sync',{transportId:'new-transport'});assert.equal(sync.ok,true);assert.equal(f.host.ports.has('new'),true);assert.equal(f.host.ports.has('old'),false);
});

test('old or missing transport nonces cannot obtain a permit after replacement registration is queued',async t=>{
  const f=await backgroundFixture(t);await f.port('old');await f.register('old');await eventually(()=>f.registered('old'));
  await f.host.select('permit fence');await eventually(()=>f.host.snapshot()?.waiting[0]?.phase==='ready');
  await f.port('new');const registration=f.register('new'),oldClaim=f.call('claim',{explanationLanguage:'en'});await registration;await eventually(()=>f.registered('new'));
  assert.equal((await oldClaim).error,'UNTRUSTED_SENDER');
  assert.equal((await f.call('claim',{explanationLanguage:'en',transportId:undefined})).error,'UNTRUSTED_SENDER');assert.equal(f.host.snapshot().active,null);
  const current=await f.call('claim',{explanationLanguage:'ja',transportId:'new-transport'});assert.equal(current.ok,true);assert.equal(current.result.job.params.explanation_language,'ja');
});

test('disconnect during asynchronous identity reads cannot publish a registered acknowledgement for the closed port',async t=>{
  const f=await backgroundFixture(t),old=await f.port('old');const registering=f.register('old');await Promise.resolve();old.onDisconnect.emit();await registering;
  await f.port('new');await f.register('new');await eventually(()=>f.registered('new'));assert.equal(f.registered('old'),false);assert.equal((await f.call('sync',{transportId:'new-transport'})).ok,true);
});
