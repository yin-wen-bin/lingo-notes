import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {build} from 'esbuild';
import vm from 'node:vm';
import {inputText,safeSource,safeError,decodePng,validateLesson,parseLesson,lessonDiagnostics,lessonMessages,learningFailurePatch,sseEvents,deepseek,shanghaiClock,explanationMode,fontTheme,REQUEST_MS} from '../supabase/functions/_shared/core.mjs';
import {partialLesson} from '../supabase/functions/_shared/partial-lesson.mjs';
import {png} from './png-fixture.mjs';

const examples=[1,2,3].map(n=>({text:`Example ${n}.`,translation:`译文${n}。`}));
const lesson={language:'en',summary_zh:'测试说明',vocabulary:[{term:'learn',reading:'/lɜːn/',pos:'verb',meaning:'学习',examples}],grammar:[]};
const stream=(strings)=>new ReadableStream({start(c){for(const s of strings)c.enqueue(typeof s==='string'?new TextEncoder().encode(s):s);c.close();}});
test('language detection accepts Japanese kanji; source cleaning removes secrets',()=>{
  assert.equal(inputText('勉強'),'勉強');assert.throws(()=>inputText('1234'),/NO_LANGUAGE_TEXT/);
  assert.deepEqual(safeSource({title:'Page',url:'https://name:password@example.com/a?q=secret#token'}),{title:'Page',url:'https://example.com/a'});
  assert.equal(safeSource({url:'javascript:alert(1)'}),null);
  assert.equal(safeError(new Error('sk-sensitive-user-key')),'REQUEST_FAILED_RESULT_UNKNOWN');
});
test('final lesson requires 1–3 points and exactly three complete examples',()=>{
  assert.deepEqual(parseLesson(JSON.stringify(lesson)),lesson);
  assert.throws(()=>validateLesson({...lesson,vocabulary:[{...lesson.vocabulary[0],examples:examples.slice(0,2)}]}),/INVALID_LESSON/);
  assert.throws(()=>validateLesson({...lesson,vocabulary:Array(4).fill(lesson.vocabulary[0])}),/INVALID_LESSON/);
  assert.throws(()=>parseLesson('{"language":"en"'),/INVALID_LESSON/);
  assert.equal(partialLesson('{"language":"ja","summary_zh":"学习","vocabulary":[').summary_zh,'学习');
});

test('structure diagnostics identify the observed 3 vocabulary + 2 grammar overflow without content',()=>{
  const invalid={...lesson,summary_zh:'private learning content',vocabulary:Array(3).fill(lesson.vocabulary[0]),grammar:Array(2).fill({point:'private grammar',explanation:'private explanation',examples})};
  let failure;
  try{validateLesson(invalid);}catch(error){failure=error;}
  assert.equal(safeError(failure),'INVALID_LESSON');
  assert.deepEqual(lessonDiagnostics(failure),{reason:'POINT_COUNT',counts:{vocabulary_count:3,grammar_count:2,point_count:5}});
  assert.equal(JSON.stringify(lessonDiagnostics(failure)).includes('private'),false);
  const copy=lessonDiagnostics(failure);copy.counts.point_count=99;
  assert.equal(lessonDiagnostics(failure).counts.point_count,5);
  assert.equal(lessonDiagnostics(Object.assign(new Error('INVALID_LESSON'),{reason:'private',counts:{text:'secret'}})),null);
});

test('schema failures distinguish missing fields, malformed JSON and incomplete examples',()=>{
  const invalids=[
    ['MALFORMED_JSON',()=>parseLesson('{"private":"material"')],
    ['LANGUAGE',()=>validateLesson({...lesson,language:'English'})],
    ['VOCABULARY_READING',()=>validateLesson({...lesson,vocabulary:[{...lesson.vocabulary[0],reading:''}]})],
    ['EXAMPLE_COUNT',()=>validateLesson({...lesson,vocabulary:[{...lesson.vocabulary[0],examples:examples.slice(0,1)}]})],
    ['EXAMPLE_TRANSLATION',()=>validateLesson({...lesson,vocabulary:[{...lesson.vocabulary[0],examples:[examples[0],{text:'private'},examples[2]]}]})]
  ];
  for(const [reason,action] of invalids)assert.throws(action,error=>{assert.equal(lessonDiagnostics(error)?.reason,reason);assert.equal(safeError(error),'INVALID_LESSON');return true;});
});

test('prompt demonstrates a fully valid two-point lesson with all six example objects',()=>{
  const messages=lessonMessages({original_text:'untrusted material',context:'quoted context'});
  const example=JSON.parse(messages[0].content.split('\n').find(line=>line.startsWith('{')));
  assert.deepEqual(validateLesson(example),example);
  assert.equal(example.vocabulary.length+example.grammar.length,2);
  assert.equal([...example.vocabulary,...example.grammar].flatMap(p=>p.examples).length,6);
  assert.match(messages[0].content,/vocabulary.length \+ grammar.length/);
  assert.deepEqual(JSON.parse(messages[1].content),{text:'untrusted material',context:'quoted context'});
});
test('PNG validation checks chunk CRC and complete image, not MIME claim alone',()=>{
  const bytes=png(16,16),uri='data:image/png;base64,'+bytes.toString('base64');
  const decoded=decodePng(uri);assert.equal(decoded.width,16);assert.equal(decoded.height,16);assert.equal(decoded.byte_size,bytes.length);
  const corrupt=Buffer.from(bytes);corrupt[50]^=1;
  assert.throws(()=>decodePng('data:image/png;base64,'+corrupt.toString('base64')),/INVALID_IMAGE/);
  assert.throws(()=>decodePng('data:image/png;base64,'+btoa('not a PNG')),/INVALID_IMAGE/);
  assert.throws(()=>decodePng(uri.slice(0,40)),/INVALID_IMAGE/);
});
test('SSE parses UTF-8 characters split across packets and multi-line data',async()=>{
  const bytes=new TextEncoder().encode('data: {"text":"学习"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const events=[];for await(const value of sseEvents(stream([...bytes].map(b=>new Uint8Array([b])))))events.push(value);
  assert.deepEqual(events,['{"text":"学习"}','[DONE]']);
});
test('DeepSeek requires successful finish, does not retry failures, captures usage',async()=>{
  let calls=0,posted;
  const fetchFn=async(url,options)=>{calls++;posted=JSON.parse(options.body);assert.equal(url,'https://api.deepseek.com/chat/completions');return new Response(stream([
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    'data: [DONE]\n\n'
  ]));};
  const result=await deepseek({key:'test',messages:[],fetchFn});assert.equal(result.text,'hello');assert.equal(result.usage.total_tokens,3);assert.equal(calls,1);assert.deepEqual(posted.thinking,{type:'disabled'});assert.equal(posted.temperature,0);
  await assert.rejects(deepseek({key:'test',messages:[],fetchFn:async()=>new Response(stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']))}),/MODEL_OUTPUT_INCOMPLETE/);
  calls=0;await assert.rejects(deepseek({key:'test',messages:[],fetchFn:async()=>{calls++;return new Response('billing details',{status:402});}}),/DEEPSEEK_BALANCE_INSUFFICIENT/);assert.equal(calls,1);
});

test('provider usage survives a failed final schema and a length finish; unavailable counters stay null',async()=>{
  const invalid={...lesson,vocabulary:Array(3).fill(lesson.vocabulary[0]),grammar:[{point:'x',explanation:'x',examples}]};
  const raw=JSON.stringify(invalid);let metadata,calls=0;
  const chunks=[
    {model:'deepseek-flash',choices:[{delta:{content:raw},finish_reason:'stop'}]},
    {choices:[],usage:{prompt_tokens:14,completion_tokens:33,total_tokens:47}}
  ];
  const result=await deepseek({key:'test',messages:[],onMetadata:value=>{metadata=value;},fetchFn:async()=>{calls++;return new Response(stream(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).concat('data: [DONE]\n\n')));}});
  let error;try{parseLesson(result.text);}catch(value){error=value;}
  const patch=learningFailurePatch(error,metadata);
  assert.equal(patch.error_details.reason,'POINT_COUNT');assert.deepEqual(patch.usage,{input_tokens:14,output_tokens:33,total_tokens:47});assert.equal(patch.status,'failed');
  assert.equal(Object.hasOwn(patch,'result'),false);assert.equal(Object.hasOwn(patch,'text'),false);assert.equal(calls,1);
  let incompleteMetadata;
  await assert.rejects(deepseek({key:'test',messages:[],onMetadata:value=>{incompleteMetadata=value;},fetchFn:async()=>new Response(stream([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    'data: {"choices":[],"usage":{"completion_tokens":5000}}\n\n',
    'data: [DONE]\n\n'
  ]))}),/MODEL_OUTPUT_INCOMPLETE/);
  assert.deepEqual(incompleteMetadata.usage,{input_tokens:null,output_tokens:5000,total_tokens:null});
  assert.equal(learningFailurePatch(new Error('MODEL_OUTPUT_INCOMPLETE')).usage,null);
});

let db;
async function database(fontPreferences=true){
  const db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user_id',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(name text,bucket_id text,created_at timestamptz default now());
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text unique);
    create view vault.decrypted_secrets as select id,secret as decrypted_secret,name from vault.secrets;
    create function vault.create_secret(value text,name text) returns uuid language sql as $$insert into vault.secrets(secret,name) values(value,name) returning id$$;
    create function vault.update_secret(sid uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=sid$$;
  `);
  const sql=readFileSync(new URL('../supabase/migrations/202611190001_lingo_cloud.sql',import.meta.url),'utf8').replace('create extension if not exists supabase_vault with schema vault;','');
  await db.exec(sql);
  await db.exec(readFileSync(new URL('../supabase/migrations/202611190003_explanation_mode.sql',import.meta.url),'utf8'));
  if(fontPreferences)await db.exec(readFileSync(new URL('../supabase/migrations/202611200004_font_preferences.sql',import.meta.url),'utf8'));
  return db;
}
before(async()=>{db=await database();});
after(async()=>{await db?.close();});
const query=async(sql,args=[])=> (await db.query(sql,args)).rows;
const call=async(name,args)=> (await query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args))[0].value;
async function user(){const id=randomUUID();await query('insert into auth.users(id) values($1)',[id]);return id;}
async function begin(u,{record=randomUUID(),request=randomUUID(),action='learning.submit',hash='abc',revision=null,material={original_text:'learn'}}={}){
  const value=await call('lingo_begin',[u,request,record,action,hash,JSON.stringify(material),revision]);return {value,record,request};
}
const finish=(u,req,patch={status:'complete',result:lesson},cards=[])=>call('lingo_finish',[u,req,'complete',JSON.stringify(patch),JSON.stringify(cards)]);
test('settings API validates themes, preserves partial settings and scopes writes to the authenticated account',async()=>{
  const a=await user(),b=await user(),authUsers=new Map([['session-a',a],['session-b',b]]);
  const client={auth:{async getUser(token){return {data:{user:authUsers.has(token)?{id:authUsers.get(token)}:null},error:null};}},from(table){
    assert.equal(table,'lingo_settings');let fields='*',owner=null,values=null;
    const chain={select(value){fields=value;return chain;},eq(key,value){assert.equal(key,'user_id');owner=value;return chain;},upsert(value){values=value;return chain;},async maybeSingle(){
      return {data:(await query(`select ${fields} from lingo_settings where user_id=$1`,[owner]))[0]??null,error:null};
    },async single(){
      const keys=Object.keys(values);assert.ok(keys.every(key=>['user_id','updated_at','review_enabled','push_enabled','explanation_mode','font_theme'].includes(key)));
      const rows=await query(`insert into lingo_settings(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) on conflict(user_id) do update set ${keys.filter(key=>key!=='user_id').map(key=>`${key}=excluded.${key}`).join(',')} returning ${fields}`,keys.map(key=>values[key]));
      return {data:rows[0],error:null};
    }};return chain;
  }};
  const bundle=await build({entryPoints:['supabase/functions/app-api/index.ts'],bundle:true,format:'cjs',platform:'node',write:false,plugins:[{name:'emulated-platform',setup(builder){
    builder.onResolve({filter:/^npm:/},args=>({path:args.path,namespace:'emulated-platform'}));
    builder.onLoad({filter:/.*/,namespace:'emulated-platform'},args=>({contents:args.path.startsWith('npm:@supabase/')?'export const createClient=()=>globalThis.testClient;':'export default {sendNotification(){throw Error("UNEXPECTED_PUSH");}};',loader:'js'}));
  }}]});
  const module={exports:{}},env={SUPABASE_URL:'https://synthetic.example.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',PWA_URL:'https://pwa.example.test/',VAPID_PUBLIC_KEY:'synthetic-public'};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,testClient:client,Request,Response,URL,TextEncoder,TextDecoder,Deno:{serve(){},env:{get:key=>env[key]}}});
  const callApi=async(action,params={},session='session-a')=>{
    const response=await module.exports.handler(new Request('https://synthetic.example.test/functions/v1/app-api',{method:'POST',headers:{Authorization:`Bearer ${session}`,'Content-Type':'application/json'},body:JSON.stringify({action,params})}));
    return response.json();
  };
  const fresh=await callApi('settings.get');assert.equal(fresh.result.font_theme,'clean');assert.equal('email_enabled' in fresh.result,false);assert.equal('email_available' in fresh.result,false);
  await query("insert into lingo_settings(user_id,review_enabled,push_enabled,explanation_mode,font_theme) values($1,false,true,'thinking','handwritten'),($2,true,false,'fast','clean')",[a,b]);
  const changed=await callApi('settings.update',{font_theme:'bookish',user_id:b});
  assert.deepEqual(changed,{ok:true,result:{review_enabled:false,push_enabled:true,explanation_mode:'thinking',font_theme:'bookish'}});
  assert.equal((await callApi('settings.get',{},'session-b')).result.font_theme,'clean');
  for(const font_theme of [null,'','CLEAN','unknown',{},false,42,['clean']])assert.deepEqual(await callApi('settings.update',{font_theme}),{ok:false,error:'INVALID_SETTINGS'});
  for(const email_enabled of [true,false])assert.deepEqual(await callApi('settings.update',{email_enabled}),{ok:false,error:'INVALID_SETTINGS'});
  assert.equal((await callApi('settings.get')).result.font_theme,'bookish');
  assert.equal((await callApi('ping')).result.protocol,'cloud/2');
  assert.equal((await callApi('ping')).result.protocol_version,'lingo-cloud/2');
  assert.deepEqual(await callApi('settings.get',{},'expired'),{ok:false,error:'SESSION_EXPIRED'});
});
test('font preferences default clean, enforce enum and preserve other account settings',async()=>{
  const a=await user(),b=await user();
  await query("insert into lingo_settings(user_id,review_enabled,push_enabled,explanation_mode) values($1,false,true,'thinking'),($2,true,false,'fast')",[a,b]);
  assert.equal((await query('select font_theme from lingo_settings where user_id=$1',[a]))[0].font_theme,'clean');
  for(const value of ['handwritten','bookish','clean']){
    assert.equal(fontTheme(value),value);
    await query('update lingo_settings set font_theme=$2 where user_id=$1',[a,value]);
  }
  const settings=(await query('select * from lingo_settings where user_id=$1',[a]))[0];
  assert.equal(settings.font_theme,'clean');assert.equal(settings.review_enabled,false);assert.equal(settings.push_enabled,true);assert.equal(settings.explanation_mode,'thinking');
  assert.equal((await query('select font_theme from lingo_settings where user_id=$1',[b]))[0].font_theme,'clean');
  for(const value of [null,'','HANDWRITTEN','other',{},false,0,['clean']])assert.throws(()=>fontTheme(value),/INVALID_SETTINGS/);
  await assert.rejects(query("update lingo_settings set font_theme='other' where user_id=$1",[a]),/check constraint/);
  await assert.rejects(query('update lingo_settings set font_theme=null where user_id=$1',[a]),/not-null constraint/);
  await assert.rejects(query('update lingo_settings set email_enabled=true where user_id=$1',[a]),/check constraint/);
  await db.exec(`set role authenticated;select set_config('test.user_id','${b}',false)`);
  try{
    const visible=await query('select user_id,font_theme from lingo_settings');
    assert.deepEqual(visible,[{user_id:b,font_theme:'clean'}]);
    await assert.rejects(query("update lingo_settings set font_theme='bookish' where user_id=$1",[a]),/permission denied/);
    await assert.rejects(query("select public.lingo_claim_delivery($1,'email')",[randomUUID()]),/permission denied/);
  }finally{await db.exec('reset role');}
});

test('font migration disables unfinished email deliveries and preserves accepted audit and push work',async t=>{
  const old=await database(false);t.after(()=>old.close());
  const u=randomUUID(),batches=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  await old.query('insert into auth.users(id) values($1)',[u]);
  await old.query("insert into lingo_settings(user_id,review_enabled,push_enabled,email_enabled,explanation_mode) values($1,true,true,true,'thinking')",[u]);
  for(let i=0;i<batches.length;i++){
    await old.query('insert into lingo_review_batches(id,user_id,local_date) values($1,$2,$3)',[batches[i],u,`2026-11-${10+i}`]);
    await old.query('insert into lingo_deliveries(batch_id,user_id,channel,status,claim_token,lease_until,attempts) values($1,$2,$3,$4,$5,now()+interval \'2 minutes\',1)',[batches[i],u,'email',['pending','failed','sending','accepted'][i],randomUUID()]);
  }
  await old.query("insert into lingo_deliveries(batch_id,user_id,channel,status,attempts) values($1,$2,'push','pending',1)",[batches[0],u]);
  await old.exec(readFileSync(new URL('../supabase/migrations/202611200004_font_preferences.sql',import.meta.url),'utf8'));
  const settings=(await old.query('select * from lingo_settings where user_id=$1',[u])).rows[0];
  assert.equal(settings.email_enabled,false);assert.equal(settings.font_theme,'clean');assert.equal(settings.explanation_mode,'thinking');assert.equal(settings.review_enabled,true);assert.equal(settings.push_enabled,true);
  const emails=(await old.query("select status,claim_token,lease_until,attempts from lingo_deliveries where channel='email' order by batch_id")).rows;
  assert.equal(emails.filter(row=>row.status==='accepted').length,1);assert.equal(emails.filter(row=>row.status==='disabled').length,3);
  for(const row of emails.filter(row=>row.status==='disabled')){assert.equal(row.claim_token,null);assert.equal(row.lease_until,null);assert.equal(row.attempts,1);}
  assert.equal((await old.query("select status from lingo_deliveries where channel='push'")).rows[0].status,'pending');
  for(const batch of batches)assert.equal((await old.query("select public.lingo_claim_delivery($1,'email') as value",[batch])).rows[0].value,null);
  await assert.rejects(old.query('update lingo_settings set email_enabled=true where user_id=$1',[u]),/check constraint/);
});
test('explanation preference defaults fast, rejects invalid values, and is snapshotted after replay detection',async()=>{
  const u=await user(),first=await begin(u,{material:{original_text:'learn',explanation_mode:'thinking'}});
  assert.equal(first.value.record.explanation_mode,'fast');
  const seconds=await query('select extract(epoch from deadline-created_at)::integer as seconds from lingo_requests where user_id=$1 and id=$2',[u,first.request]);
  assert.equal(seconds[0].seconds,REQUEST_MS/1000);
  await query("insert into lingo_settings(user_id,explanation_mode) values($1,'thinking')",[u]);
  const replay=await begin(u,{record:first.record,request:first.request});
  assert.equal(replay.value.replay,true);assert.equal(replay.value.record.explanation_mode,'fast');
  assert.equal((await query('select count(*)::integer as n from lingo_requests where user_id=$1',[u]))[0].n,1);
  await assert.rejects(query("update lingo_settings set explanation_mode='turbo' where user_id=$1",[u]),/check constraint/);
  for(const value of [null,'FAST','',{},false])assert.throws(()=>explanationMode(value),/INVALID_EXPLANATION_MODE/);
  assert.equal(explanationMode('fast'),'fast');assert.equal(explanationMode('thinking'),'thinking');
  await finish(u,first.request,{status:'complete',result:lesson,result_mode:'fast',usage:{total_tokens:12}});
  const retry=await begin(u,{record:first.record,action:'learning.retry',revision:2,hash:'new-attempt'});
  assert.equal(retry.value.record.explanation_mode,'thinking');assert.equal(retry.value.record.result_mode,'fast');assert.equal(retry.value.record.usage,null);
  const failure=learningFailurePatch(new Error('MODEL_OUTPUT_INCOMPLETE'),{model:'deepseek-flash',explanation_mode:'thinking',usage:{input_tokens:7,output_tokens:12000,total_tokens:12007}});
  const saved=await call('lingo_finish',[u,retry.request,'failed',JSON.stringify(failure),'[]']);
  assert.equal(saved.explanation_mode,'thinking');assert.equal(saved.result_mode,'fast');assert.deepEqual(saved.result,lesson);assert.equal(saved.usage.output_tokens,12000);
  await query("update lingo_settings set explanation_mode='fast' where user_id=$1",[u]);
  assert.equal((await query('select payload from lingo_records where id=$1',[first.record]))[0].payload.explanation_mode,'thinking');
  await assert.rejects(query('update lingo_settings set explanation_mode=null where user_id=$1',[u]),/not-null constraint/);
});

test('OCR and OCR retry always snapshot fast while confirmed explanation uses the current preference',async()=>{
  const u=await user();await query("insert into lingo_settings(user_id,explanation_mode) values($1,'thinking')",[u]);
  const ocr=await begin(u,{action:'learning.recognize'});assert.equal(ocr.value.record.explanation_mode,'fast');
  await call('lingo_attach_image',[u,ocr.request,JSON.stringify({path:`${u}/${ocr.record}/synthetic.png`})]);
  await finish(u,ocr.request,{status:'awaiting_review',recognized_text:'learn',explanation_mode:'fast'});
  const confirm=await begin(u,{record:ocr.record,action:'learning.confirm',revision:2,hash:'confirm',material:{corrected_text:'learn'}});
  assert.equal(confirm.value.record.explanation_mode,'thinking');
  await finish(u,confirm.request,{status:'complete',result:lesson,result_mode:'thinking'});
  const again=await begin(u,{record:ocr.record,action:'learning.recognizeRetry',revision:4,hash:'ocr-again'});
  assert.equal(again.value.record.explanation_mode,'fast');assert.equal(again.value.record.result_mode,'thinking');
});

test('mode selects one provider call and token budget; OCR ignores thinking and reasoning is never displayed',async()=>{
  for(const [mode,json,expected,budget] of [['fast',true,'fast',5000],['thinking',true,'thinking',12000],['thinking',false,'fast',5000]]){
    let count=0,posted,metadata;const shown=[];
    const response=await deepseek({key:'synthetic',messages:[],mode,json,onMetadata:value=>{metadata=value;},onDelta:value=>shown.push(value),fetchFn:async(_url,options)=>{
      count++;posted=JSON.parse(options.body);
      return new Response(stream([
        'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"final content"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":6,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n'
      ]));
    }});
    assert.equal(count,1);assert.equal(posted.max_tokens,budget);assert.equal(posted.thinking.type,expected==='thinking'?'enabled':'disabled');
    assert.equal(response.explanation_mode,expected);assert.equal(metadata.explanation_mode,expected);assert.deepEqual(shown,['final content']);
    assert.equal(JSON.stringify(response).includes('private reasoning'),false);
  }
  let metadata,count=0;
  await assert.rejects(deepseek({key:'synthetic',messages:[],mode:'thinking',onMetadata:value=>{metadata=value;},fetchFn:async()=>{count++;return new Response('',{status:429});}}),/DEEPSEEK_RATE_LIMIT/);
  const failed=learningFailurePatch(new Error('DEEPSEEK_RATE_LIMIT'),metadata);assert.equal(failed.explanation_mode,'thinking');assert.equal(failed.usage,null);assert.equal(count,1);
});

test('SQL idempotency returns original request and rejects changed material/parallel calls',async()=>{
  const u=await user(),first=await begin(u);
  const replay=await begin(u,{record:first.record,request:first.request});assert.equal(replay.value.replay,true);
  await assert.rejects(begin(u,{record:first.record,request:first.request,hash:'changed'}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(begin(u),/REQUEST_IN_PROGRESS/);
  await finish(u,first.request);
  const again=await begin(u,{record:first.record,request:first.request});assert.equal(again.value.record.status,'complete');
});
test('SQL cancelled/deleted requests reject late completion and clear deleted text',async()=>{
  const u=await user(),first=await begin(u);
  const cancelled=await call('lingo_cancel',[u,first.record]);assert.equal(cancelled.status,'cancelled');
  await assert.rejects(finish(u,first.request),/REQUEST_NOT_ACTIVE/);
  const second=await begin(u);await call('lingo_delete',[u,second.record,1]);
  await assert.rejects(finish(u,second.request),/REQUEST_NOT_ACTIVE/);
  const row=(await query('select payload from lingo_records where id=$1',[second.record]))[0];assert.equal(JSON.stringify(row).includes('learn'),false);
  assert.equal((await call('lingo_delete',[u,second.record,1])).deleted,true);
});
test('SQL expiry unlocks user and preserves previous complete result on retry failure',async()=>{
  const u=await user(),first=await begin(u);await finish(u,first.request);
  const retry=await begin(u,{record:first.record,action:'learning.retry',revision:2,hash:'retry',material:{corrected_text:'study'}});
  await query("update lingo_requests set deadline=now()-interval '1 second' where id=$1",[retry.request]);
  await call('lingo_expire',[u]);
  const row=(await query('select payload from lingo_records where id=$1',[first.record]))[0].payload;
  assert.equal(row.status,'interrupted');assert.deepEqual(row.result,lesson);
  await assert.rejects(finish(u,retry.request),/REQUEST_NOT_ACTIVE/);
  await begin(u);
});

test('SQL failed validation saves known billed usage and diagnostics without replacing previous result',async()=>{
  const u=await user(),first=await begin(u);await finish(u,first.request);
  const retry=await begin(u,{record:first.record,action:'learning.retry',revision:2,hash:'retry',material:{corrected_text:'study'}});
  let error;try{validateLesson({...lesson,vocabulary:Array(3).fill(lesson.vocabulary[0]),grammar:[{point:'private partial',explanation:'private partial',examples}]});}catch(value){error=value;}
  const patch=learningFailurePatch(error,{model:'deepseek-flash',usage:{input_tokens:299,output_tokens:634,total_tokens:933}});
  const saved=await call('lingo_finish',[u,retry.request,'failed',JSON.stringify(patch),'[]']);
  assert.equal(saved.status,'failed');assert.equal(saved.error,'INVALID_LESSON');assert.equal(saved.error_details.reason,'POINT_COUNT');
  assert.deepEqual(saved.usage,{input_tokens:299,output_tokens:634,total_tokens:933});assert.deepEqual(saved.result,lesson);
  assert.equal(JSON.stringify(saved).includes('private partial'),false);
  const replay=await begin(u,{record:first.record,request:retry.request,action:'learning.retry',revision:2,hash:'retry',material:{corrected_text:'study'}});
  assert.equal(replay.value.replay,true);assert.equal(replay.value.record.status,'failed');assert.deepEqual(replay.value.record.usage,saved.usage);
});
test('SQL RLS denies other accounts, browser writes and secret RPCs',async()=>{
  const a=await user(),b=await user(),saved=await begin(a);await finish(a,saved.request);
  await db.exec(`set role authenticated;select set_config('test.user_id','${b}',false)`);
  assert.equal((await query('select * from lingo_records where id=$1',[saved.record])).length,0);
  await assert.rejects(query('update lingo_records set payload=$1 where id=$2',['{}',saved.record]),/permission denied/);
  await assert.rejects(call('lingo_key_get',[a,true]),/permission denied/);
  await assert.rejects(query('select * from vault.decrypted_secrets'),/permission denied/);
  await query("select set_config('test.user_id',$1,false)",[a]);
  assert.equal((await query('select * from lingo_records where id=$1',[saved.record])).length,1);
  await db.exec('reset role');
});
test('SQL batches are unique, deletes remove card references, delivery claims cap retries',async()=>{
  const u=await user(),first=await begin(u),cardId=randomUUID();
  await finish(u,first.request,{status:'complete',result:lesson},[{id:cardId,record_id:first.record,term:'learn'}]);
  await query("update lingo_cards set local_date='2026-11-18' where user_id=$1",[u]);
  await query('insert into lingo_settings(user_id,review_enabled,push_enabled) values($1,true,true)',[u]);
  const batch=await call('lingo_make_batch',[u,'2026-11-19T23:00:00Z']);assert.ok(batch);
  assert.equal(await call('lingo_make_batch',[u,'2026-11-19T23:10:00Z']),batch);
  for(let i=0;i<3;i++){
    const claim=await call('lingo_claim_delivery',[batch,'push']);assert.equal(claim.attempts,i+1);
    assert.equal(await call('lingo_claim_delivery',[batch,'push']),null);
    assert.equal(await call('lingo_finish_delivery',[batch,'push',randomUUID(),'accepted',null]),false);
    assert.equal(await call('lingo_finish_delivery',[batch,'push',claim.claim_token,'failed','PUSH_SEND_FAILED']),true);
  }
  assert.equal(await call('lingo_claim_delivery',[batch,'push']),null);
  await call('lingo_delete',[u,first.record,2]);
  assert.equal((await query('select * from lingo_review_items where batch_id=$1',[batch])).length,0);
});
test('SQL key lifecycle uses private references and clears Vault on user deletion',async()=>{
  const u=await user();await call('lingo_key_set',[u,'sk-'+ 'a'.repeat(32)]);
  assert.deepEqual(await call('lingo_key_get',[u,false]),{configured:true,last_four:'aaaa'});
  await call('lingo_key_set',[u,'sk-'+ 'b'.repeat(32)]);
  assert.equal((await call('lingo_key_get',[u,true])).key,'sk-'+ 'b'.repeat(32));
  await query('delete from auth.users where id=$1',[u]);
  assert.equal((await query('select * from vault.secrets where name=$1',['lingo-user-'+u])).length,0);
});
test('SQL history treats search punctuation literally, keeps dates and removes deleted records',async()=>{
  const u=await user(),first=await begin(u,{material:{original_text:"100% learn,_ 'example'"}});await finish(u,first.request);
  const found=await call('lingo_history',[u,"% learn,_ '",0,30]);assert.equal(found.items.length,1);assert.equal(found.items[0].record_id,first.record);
  const noWildcard=await call('lingo_history',[u,'%',0,30]);assert.equal(noWildcard.items.length,1);
  await call('lingo_delete',[u,first.record,2]);assert.deepEqual(await call('lingo_history',[u,'',0,30]),{items:[],has_more:false});
});
test('logout unsubscribe matches device endpoint and does not remove another primary device',async()=>{
  const u=await user();await query('insert into lingo_settings(user_id,push_enabled,review_enabled) values($1,true,true)',[u]);
  await query('insert into lingo_push_subscriptions(user_id,subscription) values($1,$2)',[u,JSON.stringify({endpoint:'https://web.push.apple.com/new-device'})]);
  assert.equal((await call('lingo_unsubscribe',[u,'https://web.push.apple.com/old-device'])).removed,false);
  assert.equal((await query('select push_enabled from lingo_settings where user_id=$1',[u]))[0].push_enabled,true);
  assert.equal((await call('lingo_unsubscribe',[u,'https://web.push.apple.com/new-device'])).removed,true);
  const settings=(await query('select * from lingo_settings where user_id=$1',[u]))[0];assert.equal(settings.push_enabled,false);assert.equal(settings.review_enabled,true);
});
test('SQL selection limits daily cards, skips today/recent repeats and keeps empty days empty',async()=>{
  assert.deepEqual(shanghaiClock(new Date('2026-11-19T23:00:00Z')),{date:'2026-11-20',hour:7});
  const u=await user();await query('insert into lingo_settings(user_id,review_enabled) values($1,true)',[u]);
  assert.equal(await call('lingo_make_batch',[u,'2026-11-19T23:00:00Z']),null);
  const definitions=[['new1','2026-11-19',null],['new2','2026-11-18',null],['old1','2026-10-01',null],['old2','2026-10-02',null],['old3','2026-10-03',null],['today','2026-11-20',null],['repeat','2026-10-01','2026-11-19T00:00:00Z']];
  for(const [term,date,lastSelected] of definitions){
    const saved=await begin(u),card=randomUUID();await finish(u,saved.request,{status:'complete',result:lesson},[{id:card,term}]);
    await query('update lingo_cards set local_date=$1,last_selected_at=$2 where id=$3',[date,lastSelected,card]);
  }
  const batch=await call('lingo_make_batch',[u,'2026-11-19T23:00:00Z']);
  const selected=await query('select c.payload from lingo_review_items i join lingo_cards c on c.id=i.card_id where i.batch_id=$1 order by i.position',[batch]);
  assert.deepEqual(selected.map(r=>r.payload.term),['new1','new2','old1','old2','old3']);
  assert.equal((await query('select * from lingo_deliveries where batch_id=$1',[batch])).length,0);
});
test('existing daily batch gains an enabled notification channel without reselection',async()=>{
  const u=await user(),saved=await begin(u),card=randomUUID();await finish(u,saved.request,{status:'complete',result:lesson},[{id:card,term:'learn'}]);
  await query("update lingo_cards set local_date='2026-11-18' where user_id=$1",[u]);
  await query('insert into lingo_settings(user_id,review_enabled) values($1,true)',[u]);
  const batch=await call('lingo_make_batch',[u,'2026-11-19T23:00:00Z']);
  await query('update lingo_settings set push_enabled=true where user_id=$1',[u]);
  assert.equal(await call('lingo_make_batch',[u,'2026-11-19T23:05:00Z']),batch);
  await call('lingo_make_batch',[u,'2026-11-19T23:10:00Z']);
  assert.equal((await query('select * from lingo_deliveries where batch_id=$1',[batch])).length,1);
  assert.equal((await query('select channel from lingo_deliveries where batch_id=$1',[batch]))[0].channel,'push');
  assert.equal((await query('select card_id from lingo_review_items where batch_id=$1',[batch]))[0].card_id,card);
});
test('regenerating a note updates stable card slots without emptying existing batches',async()=>{
  const u=await user(),saved=await begin(u),card=randomUUID();await finish(u,saved.request,{status:'complete',result:lesson},[{id:card,term:'learn'}]);
  await query("update lingo_cards set local_date='2026-11-18' where user_id=$1",[u]);
  await query('insert into lingo_settings(user_id,review_enabled) values($1,true)',[u]);
  const batch=await call('lingo_make_batch',[u,'2026-11-19T23:00:00Z']);
  const retry=await begin(u,{record:saved.record,action:'learning.retry',revision:2,hash:'revised'});
  await finish(u,retry.request,{status:'complete',result:lesson},[{id:randomUUID(),term:'study',meaning:'修订说明'}]);
  const item=(await query('select c.id,c.payload from lingo_review_items i join lingo_cards c on c.id=i.card_id where i.batch_id=$1',[batch]))[0];
  assert.equal(item.id,card);assert.equal(item.payload.id,card);assert.equal(item.payload.term,'study');
  await call('lingo_delete',[u,saved.record,4]);assert.equal((await query('select * from lingo_review_items where batch_id=$1',[batch])).length,0);
});
test('expired old push response does not remove refreshed keys on the same endpoint',async()=>{
  const u=await user(),old={endpoint:'https://web.push.apple.com/device',keys:{auth:'old'}},fresh={...old,keys:{auth:'new'}};
  await query('insert into lingo_settings(user_id,push_enabled) values($1,true)',[u]);
  await query('insert into lingo_push_subscriptions(user_id,subscription) values($1,$2)',[u,JSON.stringify(fresh)]);
  assert.equal((await call('lingo_unsubscribe',[u,old.endpoint,JSON.stringify(old)])).removed,false);
  assert.equal((await query('select push_enabled from lingo_settings where user_id=$1',[u]))[0].push_enabled,true);
});
