import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudClient, CloudError} from '../shared/cloud-client.ts';

const url='https://project.example.test', key='publishable-test';
const session=(expires_at=Math.floor(Date.now()/1000)+3600)=>({access_token:'access-test',refresh_token:'refresh-test',expires_at,user:{id:'user-a',email:'learner@example.test'}});
function memory(initial=session()){const values=new Map(initial?[[`lingo-session:${url}`,JSON.stringify(initial)]]:[]);return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);}};}
const json=(result,status=200)=>new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});
function event(type,data){return `event: ${type}\r\ndata: ${JSON.stringify({request_id:'request-a',record_id:'record-a',revision:1,...data})}\r\n\r\n`;}
const record={record_id:'record-a',revision:2,status:'complete',input_type:'text',local_date:'2026-11-19',result:{language:'ja',summary_zh:'学习日语',vocabulary:[],grammar:[]}};
function streamResponse(text,chunkSize=1){const bytes=new TextEncoder().encode(text);let offset=0;return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,offset+=chunkSize));}}),{headers:{'Content-Type':'text/event-stream'}});}

test('password login never sends OTP/signup and never persists the password',async()=>{
  const storage=memory(null),bodies=[],paths=[];
  const client=createCloudClient({url,publishableKey:key,storage,fetch:async(path,init)=>{paths.push(path);bodies.push(JSON.parse(init.body));return json(session());}});
  await client.signIn(' learner@example.test ','synthetic-private-password');
  assert.deepEqual(bodies[0],{email:'learner@example.test',password:'synthetic-private-password'});
  assert.ok(paths[0].endsWith('/auth/v1/token?grant_type=password'));assert.equal(client.sendOtp,undefined);assert.equal(client.verifyOtp,undefined);
  assert.equal((await client.getSession()).user.id,'user-a');
  assert.equal(storage.values.size,1);assert.ok(![...storage.values.values()][0].includes('synthetic-private-password'));
});

test('recovery clears the old account, persists only setup ownership and requires an authorized PUT password',async()=>{
  const storage=memory(),calls=[],hash='a'.repeat(64);
  const client=createCloudClient({url,publishableKey:key,storage,fetch:async(path,init)=>{
    calls.push({path,method:init.method,body:JSON.parse(init.body),authorization:init.headers.Authorization});
    if(path.endsWith('/verify')){assert.equal(storage.values.has(`lingo-session:${url}`),false);return json(session());}
    return json({id:'user-a'});
  }});
  await client.redeemSetupToken(hash);assert.equal(await client.isPasswordSetupRequired(),true);
  const reloaded=createCloudClient({url,publishableKey:key,storage});assert.equal(await reloaded.isPasswordSetupRequired(),true);
  assert.deepEqual(calls[0].body,{token_hash:hash,type:'recovery'});
  assert.equal([...storage.values.values()].some(value=>value.includes(hash)),false);
  await assert.rejects(client.call('records.history'),error=>error.code==='PASSWORD_SETUP_REQUIRED');
  await assert.rejects(client.setPassword('too-short'),error=>error.code==='PASSWORD_TOO_SHORT');assert.equal(calls.length,1);
  await client.setPassword('a-new-private-password');
  assert.equal(calls[1].method,'PUT');assert.ok(calls[1].path.endsWith('/auth/v1/user'));assert.equal(calls[1].authorization,'Bearer access-test');
  assert.equal(await client.isPasswordSetupRequired(),false);assert.equal(storage.values.size,1);
  assert.equal([...storage.values.values()].some(value=>value.includes('a-new-private-password')),false);
});

test('failed recovery cannot retain the old account or save a one-time token',async()=>{
  const storage=memory(),client=createCloudClient({url,publishableKey:key,storage,fetch:async()=>json({error:'expired token with confidential details'},400)});
  await assert.rejects(client.redeemSetupToken('b'.repeat(64)),error=>error.code==='SETUP_LINK_INVALID');
  assert.equal(await client.getSession(),null);assert.equal(storage.values.size,0);
});

test('a late password login response cannot sign back in after logout',async()=>{
  let release;const client=createCloudClient({url,publishableKey:key,storage:memory(null),fetch:async()=>new Promise(resolve=>{release=()=>resolve(json(session()));})});
  const signingIn=client.signIn('learner@example.test','synthetic-password');while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  await client.signOut();release();await assert.rejects(signingIn,error=>error.code==='AUTH_CANCELLED');assert.equal(await client.getSession(),null);
});

test('a late password update cannot clear the next account setup requirement',async()=>{
  const storage=memory(null);let release,verifications=0;
  const client=createCloudClient({url,publishableKey:key,storage,fetch:async(path)=>{
    if(path.endsWith('/verify'))return json({...session(),user:{id:++verifications===1?'user-a':'user-b'}});
    return new Promise(resolve=>{release=()=>resolve(json({id:'user-a'}));});
  }});
  await client.redeemSetupToken('c'.repeat(64));const updating=client.setPassword('synthetic-password');while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  await client.redeemSetupToken('d'.repeat(64));release();await assert.rejects(updating,error=>error.code==='SESSION_CHANGED');
  assert.equal((await client.getSession()).user.id,'user-b');assert.equal(await client.isPasswordSetupRequired(),true);
});

test('a different browser client supersedes a delayed sign-in without account rollback',async()=>{
  const storage=memory(null);let release;
  const old=createCloudClient({url,publishableKey:key,storage,fetch:async()=>new Promise(resolve=>{release=()=>resolve(json(session()));})});
  const next=createCloudClient({url,publishableKey:key,storage,fetch:async()=>json({...session(),access_token:'access-new',user:{id:'user-b'}})});
  const pending=old.signIn('learner@example.test','old-password');while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  await next.signIn('other@example.test','new-password');release();await assert.rejects(pending,error=>error.code==='AUTH_CANCELLED');
  assert.equal((await next.getSession()).user.id,'user-b');assert.equal(storage.values.size,1);
});

test('parallel calls share a refresh and preserve each original request ID',async()=>{
  const storage=memory(session(1));let refreshed=0;const requests=[];
  const transport=async(path,init)=>{if(path.includes('grant_type=refresh_token')){refreshed++;await new Promise(r=>setTimeout(r,10));return json(session());}requests.push(JSON.parse(init.body));return json({ok:true,result:{ready:true}});};
  const one=createCloudClient({url,publishableKey:key,storage,fetch:transport}),two=createCloudClient({url,publishableKey:key,storage,fetch:transport});
  await Promise.all([one.call('records.get',{record_id:'a'},'id-a'),two.call('records.get',{record_id:'b'},'id-b')]);
  assert.equal(refreshed,1);assert.deepEqual(requests.map(x=>x.request_id).sort(),['id-a','id-b']);
});

test('SSE handles UTF-8 and CRLF split at every byte and awaits accepted before later events',async()=>{
  let posts=0;const events=[];
  const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async()=>{posts++;return streamResponse(': heartbeat\r\n\r\n'+event('accepted',{record:{...record,status:'processing',revision:1}})+event('progress',{sequence:1,preview:{summary_zh:'漢字、日本語'}})+event('complete',{record}));}});
  const result=await client.start('learning.submit',{text:'漢字'},'request-a',async e=>{if(e.type==='accepted')await new Promise(r=>setTimeout(r,5));events.push(e);});
  assert.equal(posts,1);assert.deepEqual(events.map(e=>e.type),['accepted','progress','complete']);assert.equal(events[1].preview.summary_zh,'漢字、日本語');assert.deepEqual(result,record);
});

test('a truncated stream never resubmits; recovery is an explicit records.get',async()=>{
  const actions=[];const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async(_path,init)=>{const body=JSON.parse(init.body);actions.push(body.action);return body.action==='records.get'?json({ok:true,result:record}):streamResponse(event('accepted',{record:{...record,status:'processing'}}));}});
  await assert.rejects(client.start('learning.submit',{text:'study'},'request-a',()=>{}),e=>e instanceof CloudError&&e.code==='STREAM_INTERRUPTED');
  assert.deepEqual(actions,['learning.submit']);assert.deepEqual(await client.call('records.get',{record_id:'record-a'}),record);assert.deepEqual(actions,['learning.submit','records.get']);
});

test('401 clears the revoked session and never retries a billable POST',async()=>{
  let posts=0;const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async()=>{posts++;return json({ok:false,error:'UNAUTHORIZED'},401);}});
  await assert.rejects(client.start('learning.submit',{text:'study'},'request-a',()=>{}),e=>e.code==='AUTH_EXPIRED');
  assert.equal(posts,1);assert.equal(await client.getSession(),null);
});

test('cancellation is a separate server request; aborting the stream cannot restart inference',async()=>{
  const stop=new AbortController(),actions=[];
  const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async(_path,init)=>{
    const action=JSON.parse(init.body).action;actions.push(action);
    if(action==='learning.cancel')return json({ok:true,result:{...record,status:'cancelled'}});
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event('accepted',{record:{...record,status:'processing'}})));init.signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  await assert.rejects(client.start('learning.submit',{text:'study'},'request-a',e=>{if(e.type==='accepted')stop.abort();},{signal:stop.signal}),e=>e.code==='REQUEST_DISCONNECTED');
  assert.equal((await client.call('learning.cancel',{record_id:'record-a'})).status,'cancelled');
  assert.deepEqual(actions,['learning.submit','learning.cancel']);
});

test('wrong request IDs are rejected before any preview is applied',async()=>{
  const seen=[];const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async()=>streamResponse(event('progress',{request_id:'another-request',preview:{summary_zh:'wrong'}}))});
  await assert.rejects(client.start('learning.submit',{},'request-a',e=>seen.push(e)),e=>e.code==='STREAM_REQUEST_MISMATCH');assert.deepEqual(seen,[]);
});

test('abort during accepted suppresses a completion already buffered in the same network chunk',async()=>{
  const stop=new AbortController(),seen=[];
  const client=createCloudClient({url,publishableKey:key,storage:memory(),fetch:async()=>streamResponse(event('accepted',{record:{...record,status:'processing'}})+event('complete',{record}),100000)});
  await assert.rejects(client.start('learning.submit',{},'request-a',e=>{seen.push(e.type);stop.abort();},{signal:stop.signal}),e=>e.code==='REQUEST_DISCONNECTED');
  assert.deepEqual(seen,['accepted']);
});

test('signing out during refresh cannot restore a stale session',async()=>{
  let release;const storage=memory(session(1)),client=createCloudClient({url,publishableKey:key,storage,fetch:async path=>{if(path.includes('refresh_token'))await new Promise(resolve=>{release=resolve;});return json(path.includes('refresh_token')?session():{});}});
  const refreshing=client.getSession();while(!release)await new Promise(r=>setTimeout(r,0));await client.signOut();release();assert.equal(await refreshing,null);assert.equal(await client.getSession(),null);
});
