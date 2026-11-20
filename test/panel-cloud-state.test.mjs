import test from 'node:test';
import assert from 'node:assert/strict';
import {PanelSessionState, PrivateImageUrls} from '../extension/panel-cloud.ts';
import {HistoryList} from '../extension/history.ts';

function area(){const values={};return {values,async get(key){return {[key]:values[key]};},async set(update){Object.assign(values,update);},async remove(key){delete values[key];}};}
test('concurrent draft and recovery writes preserve both fields in browser-session storage',async()=>{
  const store=new PanelSessionState(area());await store.switchOwner('user-a',false);
  await Promise.all([store.set({draft:'hello'}),store.set({last_record_id:'record-a'})]);assert.deepEqual(await store.get(),{draft:'hello',last_record_id:'record-a'});
});
test('logout waits for a delayed write then removes all previous account content',async()=>{
  const storage=area(),realSet=storage.set;let release,started;
  storage.set=async update=>{started=true;await new Promise(resolve=>{release=resolve;});await realSet(update);};
  const store=new PanelSessionState(storage);await store.switchOwner('user-a',false);const writing=store.set({draft:'private material'});while(!started)await new Promise(r=>setTimeout(r,0));
  const logout=store.switchOwner(null,true);release();await Promise.all([writing,logout]);assert.equal(storage.values['panel:user-a'],undefined);assert.deepEqual(await store.get(),{});
});
test('a queued stale write never becomes the next account draft',async()=>{
  const storage=area(),store=new PanelSessionState(storage);await store.switchOwner('user-a',false);
  const writing=store.set({last_record_id:'old-record'}),switching=store.switchOwner('user-b',true);await Promise.all([writing,switching]);assert.deepEqual(await store.get(),{});assert.equal(storage.values['panel:user-a'],undefined);
});
test('account reset invalidates an in-flight history response and its unfiltered cache',async()=>{
  let done;const history=new HistoryList(async()=>new Promise(resolve=>{done=resolve;}));const request=history.load('');history.clear();done({items:[{record_id:'old-account'}],has_more:false});assert.equal(await request,false);assert.deepEqual(history.state.items,[]);
});

test('opening a screenshot after reading renews an expired URL instead of reusing the thumbnail credential',async()=>{
  let now=0,calls=0;const images=new PrivateImageUrls(async()=>({url:`https://project.example.test/image?token=${++calls}`,expires_in:60}),'https://project.example.test',()=>now);
  assert.equal(await images.get('record-a'),'https://project.example.test/image?token=1');now=20000;
  assert.equal(await images.get('record-a'),'https://project.example.test/image?token=1');assert.equal(calls,1);
  now=56000;assert.equal(await images.get('record-a'),'https://project.example.test/image?token=2');assert.equal(calls,2);
});
test('account change discards an image URL that arrives late',async()=>{
  let done;const images=new PrivateImageUrls(()=>new Promise(resolve=>{done=resolve;}),'https://project.example.test');
  const request=images.get('old-record');images.clear();done({url:'https://project.example.test/image?private=1',expires_in:60});await assert.rejects(request,/SESSION_CHANGED/);
});
test('private screenshot URLs cannot switch to an unexpected host',async()=>{
  const images=new PrivateImageUrls(async()=>({url:'https://unexpected.example.test/image',expires_in:60}),'https://project.example.test');await assert.rejects(images.get('record-a'),/IMAGE_URL_INVALID/);
});
