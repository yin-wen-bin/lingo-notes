import test from 'node:test';
import assert from 'node:assert/strict';
import {PanelNavigation} from '../extension/navigation.ts';
import {HistoryList} from '../extension/history.ts';

test('history details keep the history section selected while displaying the record view',()=>{
  const navigation=new PanelNavigation();navigation.go('history-detail');
  assert.equal(navigation.selectedTab,'history');assert.equal(navigation.visibleView,'learn');
  const opening=navigation.ticket();navigation.go('settings');assert.equal(navigation.isCurrent(opening),false);
  const oldAccount=navigation.ticket();navigation.clear();assert.equal(navigation.isCurrent(oldAccount),false);assert.equal(navigation.selectedTab,'learn');
});

test('cached history preserves paged search, deletion and scroll when returning from details',async()=>{
  const calls=[],history=new HistoryList(async(query,offset)=>{calls.push({query,offset});return {items:[{id:offset+1},{id:offset+2}],has_more:offset===0};});
  await history.load('');history.rememberScroll(80);
  await history.load('practice',false,80);await history.load('practice',true,160);history.rememberScroll(240);
  assert.equal(history.hasLoaded,true);assert.deepEqual(history.state,{query:'practice',items:[{id:1},{id:2},{id:3},{id:4}],has_more:false,scroll:240});
  history.remove(item=>item.id===1);assert.equal(history.state.scroll,240);assert.equal(history.state.query,'practice');assert.deepEqual(history.state.items,[{id:2},{id:3},{id:4}]);
  const requests=calls.length;await history.load('');assert.equal(calls.length,requests);assert.deepEqual(history.state.items,[{id:2}]);assert.equal(history.state.scroll,80);
});

test('a failed first history read remains retryable and account reset rejects late results',async()=>{
  let fail=true,finish;const history=new HistoryList(async()=>{if(fail)throw Error('NETWORK_ERROR');return new Promise(resolve=>{finish=resolve;});});
  await assert.rejects(history.load(''),/NETWORK_ERROR/);assert.equal(history.hasLoaded,false);
  fail=false;const pending=history.load('');history.clear();finish({items:[{id:'old-owner'}],has_more:false});
  assert.equal(await pending,false);assert.equal(history.hasLoaded,false);assert.deepEqual(history.state.items,[]);
});

test('dirty history refreshes the complete search window atomically and preserves scroll',async()=>{
  const calls=[];let records=Array.from({length:8},(_,id)=>({id,text:'practice '+id})),blocked=false,release;
  const history=new HistoryList(async(query,offset)=>{calls.push({query,offset});if(blocked&&offset===2)await new Promise(resolve=>{release=resolve;});return {items:records.slice(offset,offset+2),has_more:offset+2<records.length};});
  await history.load('practice');await history.load('practice',true,120);history.rememberScroll(240);
  records=[{id:'new',text:'practice new'},...records];history.markDirty();blocked=true;const refresh=history.refresh();
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(history.state.items.map(item=>item.id),[0,1,2,3]);
  history.markDirty();release();await refresh;
  assert.deepEqual(calls.slice(-2),[{query:'practice',offset:0},{query:'practice',offset:2}]);assert.deepEqual(history.state.items.map(item=>item.id),['new',0,1,2]);assert.equal(history.state.scroll,240);assert.equal(history.state.has_more,true);assert.equal(history.needsRefresh,true,'an accepted mutation during refresh remains dirty');
  blocked=false;await history.refresh();assert.equal(history.needsRefresh,false);
});

test('refresh failure preserves cached rows and dirty state for the next navigation attempt',async()=>{
  let fail=false;const history=new HistoryList(async()=>{if(fail)throw Error('NETWORK_ERROR');return {items:[{id:1}],has_more:false};});
  await history.load('practice');history.rememberScroll(160);history.markDirty();fail=true;
  await assert.rejects(history.refresh(),/NETWORK_ERROR/);assert.equal(history.hasLoaded,true);assert.equal(history.needsRefresh,true);assert.deepEqual(history.state,{query:'practice',items:[{id:1}],has_more:false,scroll:160});
  fail=false;await history.refresh();assert.equal(history.needsRefresh,false);
});

test('a dirty append revalidates the loaded window before calculating the next offset',async()=>{
  const calls=[];let records=Array.from({length:8},(_,id)=>({id}));const history=new HistoryList(async(query,offset)=>{calls.push(offset);return {items:records.slice(offset,offset+2),has_more:offset+2<records.length};});
  await history.load('');await history.load('',true);records=[{id:'new'},...records];history.markDirty();await history.load('',true,200);
  assert.deepEqual(calls,[0,2,0,2,4]);assert.deepEqual(history.state.items.map(item=>item.id),['new',0,1,2,3,4]);assert.equal(history.state.scroll,200);
});

test('an account reset discards an in-flight dirty window refresh',async()=>{
  let hold=false,finish;const history=new HistoryList(async()=>hold?new Promise(resolve=>{finish=resolve;}):{items:[{id:'old-owner'}],has_more:false});
  await history.load('practice');history.markDirty();hold=true;const request=history.refresh();history.clear();
  finish({items:[{id:'late-old-owner'}],has_more:false});assert.equal(await request,false);assert.equal(history.hasLoaded,false);assert.equal(history.needsRefresh,false);assert.deepEqual(history.state,{query:'',items:[],has_more:false,scroll:0});
});
