import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryList,HistoryRefreshScheduler} from '../extension/history.ts';

const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};

test('visible mutations merge into one 200ms history refresh',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let reads=0;
  const scheduler=new HistoryRefreshScheduler(async()=>{reads++;return false;},()=>true);t.after(()=>scheduler.reset());
  scheduler.schedule();scheduler.schedule();t.mock.timers.tick(199);await settle();assert.equal(reads,0);
  t.mock.timers.tick(1);await settle();assert.equal(reads,1);t.mock.timers.tick(1000);assert.equal(reads,1);
});

test('a change received during refresh produces one merged follow-up read',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let reads=0;const pending=deferred();
  const scheduler=new HistoryRefreshScheduler(async()=>{reads++;if(reads===1)await pending.promise;return false;},()=>true);t.after(()=>scheduler.reset());
  scheduler.schedule();t.mock.timers.tick(200);await settle();assert.equal(reads,1);
  scheduler.schedule();scheduler.schedule();pending.resolve();await settle();t.mock.timers.tick(200);await settle();assert.equal(reads,2);
});

test('hidden history defers dirty work until entry and refresh failures do not spin',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let visible=false,reads=0;
  const scheduler=new HistoryRefreshScheduler(async()=>{reads++;throw Error('NETWORK_ERROR');},()=>visible);t.after(()=>scheduler.reset());
  scheduler.schedule();t.mock.timers.tick(1000);assert.equal(reads,0);
  visible=true;await assert.rejects(scheduler.flush(),/NETWORK_ERROR/);t.mock.timers.tick(5000);await settle();assert.equal(reads,1);
  await assert.rejects(scheduler.flush(),/NETWORK_ERROR/);assert.equal(reads,2);
});

test('account reset removes scheduled work and prevents an old read from scheduling follow-up',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let reads=0;const pending=deferred();
  const scheduler=new HistoryRefreshScheduler(async()=>{reads++;await pending.promise;return true;},()=>true);
  scheduler.schedule();t.mock.timers.tick(200);await settle();scheduler.schedule();scheduler.reset();pending.resolve();await settle();
  t.mock.timers.tick(5000);await settle();assert.equal(reads,1);scheduler.reset();
});

test('a mutation during initial history load remains dirty and is refreshed after load',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const pending=deferred();let reads=0;
  const history=new HistoryList(async()=>{reads++;return reads===1?pending.promise:{items:[{id:'new'},{id:'old'}],has_more:false};});
  const scheduler=new HistoryRefreshScheduler(async()=>{if(history.loading||!history.needsRefresh)return false;await history.refresh();return history.needsRefresh;},()=>history.hasLoaded);t.after(()=>scheduler.reset());
  const loading=history.load('practice');history.markDirty();scheduler.schedule();pending.resolve({items:[{id:'old'}],has_more:false});await loading;
  assert.equal(history.needsRefresh,true);scheduler.schedule();t.mock.timers.tick(200);await settle();
  assert.equal(reads,2);assert.equal(history.needsRefresh,false);assert.equal(history.state.query,'practice');assert.equal(history.state.items[0].id,'new');
});

test('a dirty refresh retains search, loaded page window and scroll across an in-flight mutation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let values=['a','b','c','d'],block=null;const calls=[];
  const history=new HistoryList(async(query,offset)=>{calls.push([query,offset]);if(block){const pending=block;block=null;await pending.promise;}return {items:values.slice(offset,offset+2),has_more:offset+2<values.length};});
  await history.load('practice');await history.load('',true,90);history.rememberScroll(180);
  const scheduler=new HistoryRefreshScheduler(async()=>{if(history.loading||!history.needsRefresh)return false;await history.refresh();return history.needsRefresh;},()=>true);t.after(()=>scheduler.reset());
  const pending=deferred();block=pending;history.markDirty();const refresh=scheduler.flush();await settle();
  values=['new','a','b','c','d'];history.markDirty();scheduler.schedule();pending.resolve();await refresh;
  assert.equal(history.needsRefresh,true);t.mock.timers.tick(200);await settle();
  assert.equal(history.needsRefresh,false);assert.equal(history.state.query,'practice');assert.equal(history.state.items.length,4);assert.equal(history.state.scroll,180);
  assert.deepEqual(calls.slice(-2),[['practice',0],['practice',2]]);
});

test('entering history while a dirty refresh is in flight waits for the same read',async()=>{
  const pending=deferred();let reads=0;
  const scheduler=new HistoryRefreshScheduler(async()=>{reads++;await pending.promise;return false;},()=>true,200);
  const first=scheduler.flush(),entry=scheduler.flush();await settle();assert.equal(reads,1);pending.resolve();await Promise.all([first,entry]);scheduler.reset();
});
