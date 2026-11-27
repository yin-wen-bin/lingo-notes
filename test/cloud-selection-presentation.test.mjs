import test from 'node:test';
import assert from 'node:assert/strict';
import {SelectionPresentationCursor,RecordChangeNotifier,hasUnsubmittedContent} from '../extension/selection-presentation.ts';

const job=(id,sequence,windowId=1,phase='collecting')=>({id,sequence,windowId,phase,owner:'one',text:id,context:'',status:'none',createdAt:sequence,action:'learning.start',requestId:id+'-request',recordId:id+'-record'});
const snapshot=(intent,extra={})=>({owner:'one',version:1,waiting:[intent],active:null,last:null,manualDraft:null,paused:null,presentations:{[intent.windowId]:intent},presented:{},...extra});

test('only a new right-click intent in the origin window can focus navigation',()=>{
  const cursor=new SelectionPresentationCursor(),first=job('first',1);
  assert.equal(cursor.take(snapshot(first),2),null);assert.equal(cursor.take(snapshot(first),null),null);
  assert.equal(cursor.take(snapshot(first),1)?.id,'first');assert.equal(cursor.take(snapshot(first,{version:2}),1),null);
  const next=job('next',2);assert.equal(cursor.take(snapshot(next),1)?.id,'next');assert.equal(cursor.take(snapshot(first),1),null);
});

test('consumed intents survive reopening and old snapshots do not invent a presentation',()=>{
  const first=job('first',1),cursor=new SelectionPresentationCursor();
  assert.equal(cursor.take(snapshot(first,{presented:{1:1}}),1),null);
  assert.equal(cursor.take(snapshot(first,{presentations:undefined,presented:undefined}),1),null);
});

test('presentation resolves its live queue state while FIFO stays in execution order',()=>{
  const first=job('first',1),second=job('second',2),ready={...second,phase:'ready',context:'resolved second context'};
  const state=snapshot(second,{waiting:[first,ready]});const shown=new SelectionPresentationCursor().take(state,1);
  assert.equal(shown.context,'resolved second context');assert.deepEqual(state.waiting.map(item=>item.id),['first','second']);
});

test('a latest completed fallback and account reset keep display intent separate from execution',()=>{
  const cursor=new SelectionPresentationCursor(),first={...job('first',1),terminalStatus:'complete'};
  assert.equal(cursor.take(snapshot(first,{waiting:[],last:null}),1)?.terminalStatus,'complete');cursor.reset();
  assert.equal(cursor.take(snapshot(job('new-account',1)),1)?.id,'new-account');
});

test('unsent text, saved revision editor, OCR correction and image previews need a checkpoint',()=>{
  const base={current:null,stage:'composer',retryOpen:false,cropped:null,fields:{sourceText:''}};
  assert.equal(hasUnsubmittedContent(base),false);assert.equal(hasUnsubmittedContent({...base,fields:{sourceText:'  hello  '}}),true);
  assert.equal(hasUnsubmittedContent({...base,current:{status:'saved'},stage:'recordSection',retryOpen:true}),true);
  assert.equal(hasUnsubmittedContent({...base,current:{status:'awaiting_review'},stage:'recordSection',fields:{corrected:'edited OCR'}}),true);
  assert.equal(hasUnsubmittedContent({...base,stage:'imageStage',cropped:'data:image/png;base64,synthetic'}),true);
  assert.equal(hasUnsubmittedContent({...base,current:{status:'processing'},stage:'recordSection'}),false);
  assert.equal(hasUnsubmittedContent({...base,current:{status:'complete'},stage:'recordSection'}),false);
});

test('a failed record notice survives reconnect and retries invalidation without a model action',async()=>{
  const calls=[];let connected=false,remoteVersion=0;
  const notices=new RecordChangeNotifier(async notice=>{calls.push(notice);if(!connected)throw Error('QUEUE_UNAVAILABLE');remoteVersion++;});
  const deleted={recordId:'deleted-note',revision:3,status:'deleted'};
  assert.equal(notices.changed(deleted),true);await notices.flush();assert.equal(remoteVersion,0);
  assert.equal(notices.changed(deleted),false);connected=true;await notices.flush();assert.equal(remoteVersion,1);
  await notices.flush();assert.deepEqual(calls,[deleted,deleted]);
});

test('record notices coalesce to the latest revision and account reset drops old pending notices',async()=>{
  const calls=[],notices=new RecordChangeNotifier(async notice=>calls.push(notice));
  notices.changed({recordId:'note',revision:1,status:'processing'});notices.changed({recordId:'note',revision:2,status:'complete'});
  await notices.flush();assert.deepEqual(calls,[{recordId:'note',revision:2,status:'complete'}]);
  notices.changed({recordId:'old-owner',revision:1,status:'deleted'});notices.reset();await notices.flush();assert.equal(calls.length,1);
});
