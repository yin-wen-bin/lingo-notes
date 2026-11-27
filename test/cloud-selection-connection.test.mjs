import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['extension/selection-client.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const event=()=>{const listeners=[];return {addListener(fn){listeners.push(fn);},emit(value){for(const fn of listeners)fn(value);}};};
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
  let time=0,serial=0,version=0,dropAcks=0,dropSyncs=0;
  const timers=new Map(),ports=[],calls=[],changes=[],states=[],errors=[],deferred=[],faults=new Map();
  const snapshot=(owner='one',extra={})=>({owner,version:++version,waiting:[],active:null,last:null,manualDraft:null,paused:null,...extra});
  const setTimeout=(fn,delay)=>{const id=++serial;timers.set(id,{at:time+delay,fn});return id;},clearTimeout=id=>timers.delete(id);
  const chrome={windows:{async getCurrent(){return {id:1};}},runtime:{
    connect(){const port={onMessage:event(),onDisconnect:event(),closed:false,registration:null,postMessage(value){if(port.closed)throw Error('Disconnected');port.registration=value;if(dropAcks){dropAcks--;return;}queueMicrotask(()=>port.ack());},ack(){port.onMessage.emit({event:'selection-queue.registered',...port.registration});},disconnect(){if(port.closed)return;port.closed=true;port.onDisconnect.emit();}};ports.push(port);return port;},
    sendMessage(value){calls.push(value);const fault=faults.get(value.op);if(fault==='throw')throw Error('Extension context invalidated');if(fault==='reject')return Promise.reject(Error('Message channel closed'));if(fault==='hold'||(value.op==='sync'&&dropSyncs-- >0))return new Promise(resolve=>deferred.push({value,resolve}));if(typeof fault==='string')return Promise.resolve({ok:false,error:fault});return Promise.resolve({ok:true,result:{snapshot:snapshot(value.owner)}});}
  }};
  const context={exports:{},chrome,crypto:webcrypto,setTimeout,clearTimeout,queueMicrotask};context.module={exports:context.exports};
  vm.runInNewContext(compiled.outputFiles[0].text,context);
  const client=new context.module.exports.SelectionQueueClient(value=>changes.push(value),()=>errors.push(time),()=>{},value=>states.push(value));
  return {client,ports,calls,changes,states,errors,timers,deferred,faults,snapshot,
    dropAcks(count){dropAcks=count;},dropSyncs(count){dropSyncs=count;},
    async advance(ms){const end=time+ms;for(;;){await settle();const next=[...timers].filter(([,value])=>value.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();}time=end;await settle();},
    delays(){return [...timers.values()].map(value=>value.at-time).sort((a,b)=>a-b);}
  };
}

test('ready requires registration and initial sync; same-owner connects reuse one port and serialize sync',async()=>{
  const f=fixture();f.dropAcks(1);const first=f.client.connect('one'),second=f.client.connect('one');
  await settle();assert.equal(f.ports.length,1);assert.equal(f.client.ready,false);assert.equal(f.calls.length,0);
  f.ports[0].onMessage.emit({event:'selection-queue.registered',...f.ports[0].registration,transportId:'stale-transport'});await settle();assert.equal(f.calls.length,0,'an acknowledgement for another transport cannot start sync');
  f.dropSyncs(1);f.ports[0].ack();await settle();assert.equal(f.client.ready,false);assert.equal(f.states.includes('ready'),false);
  f.deferred[0].resolve({ok:true,result:{snapshot:f.snapshot()}});await Promise.all([first,second]);
  assert.equal(f.client.ready,true);assert.equal(f.states.at(-1),'ready');assert.equal(f.changes.length,1);
  await Promise.all([f.client.connect('one'),f.client.connect('one'),f.client.ensureConnected()]);
  assert.equal(f.ports.length,1);assert.equal(f.calls.filter(value=>value.op==='sync').length,2);f.client.close();
});

test('lost registration acknowledgements retry beyond the old one-shot failure with capped backoff',async()=>{
  const f=fixture();await f.client.connect('one');f.dropAcks(6);f.ports[0].disconnect();
  for(const delay of [400,1000,2000,5000,10000,10000]){
    assert.deepEqual(f.delays(),[delay]);await f.advance(delay);assert.equal(f.client.ready,false);
    assert.deepEqual(f.delays(),[5000]);await f.advance(5000);assert.equal(f.client.ready,false);
  }
  assert.deepEqual(f.delays(),[10000]);await f.advance(10000);assert.equal(f.client.ready,true);
  assert.equal(f.ports.length,8);assert.equal(f.states.at(-1),'ready');assert.equal(f.calls.filter(value=>value.op!=='sync').length,0);f.client.close();
});

for(const op of ['claim','acquire'])test(`${op} with an unknown control response times out once and only syncs on reconnect`,async()=>{
  const f=fixture();await f.client.connect('one');f.faults.set(op,'hold');
  const action=f.client.command(op,{requestId:'original',recordId:'original-record'});const outcome=assert.rejects(action,/QUEUE_UNAVAILABLE/);
  await settle();await f.advance(10000);await outcome;assert.equal(f.client.ready,false);assert.equal(f.calls.filter(value=>value.op===op).length,1);
  const late=f.deferred.at(-1);await f.advance(400);assert.equal(f.client.ready,true);
  const changeCount=f.changes.length;late.resolve({ok:true,result:{snapshot:f.snapshot('one',{active:{id:'late-mutating-reply'}}),job:{id:'must-never-be-replayed'}}});await settle();
  assert.equal(f.calls.filter(value=>value.op===op).length,1);assert.equal(f.changes.length,changeCount);f.client.close();
});

test('old port acknowledgements, disconnects, broadcasts and command replies cannot alter a replacement owner',async()=>{
  const f=fixture();await f.client.connect('one');const old=f.ports[0];f.faults.set('claim','hold');
  const pending=f.client.command('claim'),outcome=assert.rejects(pending,/SESSION_CHANGED/);await settle();
  await f.client.connect('two');await outcome;assert.equal(f.client.ready,true);
  const count=f.changes.length;old.ack();old.onDisconnect.emit();old.onMessage.emit({event:'selection-queue.changed',snapshot:f.snapshot('one')});
  f.deferred[0].resolve({ok:true,result:{snapshot:f.snapshot('one')}});await settle();
  assert.equal(f.client.ready,true);assert.equal(f.changes.length,count);assert.equal(f.changes.at(-1).owner,'two');assert.deepEqual(f.delays(),[]);f.client.close();
});

test('a registration timeout invalidates its port and late acknowledgement cannot make it ready',async()=>{
  const f=fixture();f.dropAcks(2);const attempt=f.client.connect('one'),outcome=assert.rejects(attempt,/QUEUE_UNAVAILABLE/);await settle();const old=f.ports[0];
  await f.advance(5000);await outcome;await f.advance(400);old.ack();old.onMessage.emit({event:'selection-queue.changed',snapshot:f.snapshot()});
  assert.equal(f.client.ready,false);assert.equal(f.changes.length,0);f.ports[1].ack();await settle();assert.equal(f.client.ready,true);f.client.close();
});

test('an explicit registration account mismatch remains SESSION_CHANGED and waits for the new owner',async()=>{
  const f=fixture();f.dropAcks(1);const connecting=f.client.connect('one'),outcome=assert.rejects(connecting,/SESSION_CHANGED/);await settle();
  f.ports[0].onMessage.emit({event:'selection-queue.error',error:'SESSION_CHANGED'});await outcome;
  assert.equal(f.client.ready,false);assert.equal(f.states.at(-1),'closed');assert.deepEqual(f.delays(),[]);
  await f.advance(3600000);assert.equal(f.ports.length,1);await f.client.connect('two');assert.equal(f.client.ready,true);assert.equal(f.changes.at(-1).owner,'two');f.client.close();
});

test('sync deadline and invalid sender restart registration while domain failures keep a healthy transport',async()=>{
  const f=fixture();await f.client.connect('one');f.faults.set('claim','REQUEST_IN_PROGRESS');await assert.rejects(f.client.command('claim'),/REQUEST_IN_PROGRESS/);
  assert.equal(f.client.ready,true);assert.equal(f.ports.length,1);f.faults.set('claim','UNTRUSTED_SENDER');await assert.rejects(f.client.command('claim'),/UNTRUSTED_SENDER/);
  assert.equal(f.client.ready,false);await f.advance(400);assert.equal(f.client.ready,true);assert.equal(f.ports.length,2);
  f.faults.set('sync','hold');const refresh=f.client.connect('one'),outcome=assert.rejects(refresh,/QUEUE_UNAVAILABLE/);await settle();await f.advance(10000);await outcome;assert.equal(f.client.ready,false);
  f.client.close();assert.deepEqual(f.delays(),[]);await f.advance(3600000);assert.equal(f.ports.length,2);
});

test('synchronous transport exceptions and rejected promises are normalized and recover without operation replay',async()=>{
  for(const fault of ['throw','reject']){
    const f=fixture();await f.client.connect('one');f.faults.set('acquire',fault);await assert.rejects(f.client.command('acquire'),/QUEUE_UNAVAILABLE/);
    await f.advance(400);assert.equal(f.client.ready,true);assert.equal(f.calls.filter(value=>value.op==='acquire').length,1);f.client.close();
  }
});
