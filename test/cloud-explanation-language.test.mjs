import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {build} from 'esbuild';
import {explanationLanguage,withExplanationLanguage,lessonMessages,validateLesson,parseLesson,lessonDiagnostics,cardsForLesson} from '../supabase/functions/_shared/core.mjs';

test('each explanation language has a complete localized example and same-language paraphrase instructions',()=>{
  const names={zh:'简体中文',ja:'日本語',en:'English'};
  for(const target of ['zh','ja','en']){
    assert.equal(explanationLanguage(target),target);
    const messages=lessonMessages({original_text:'Practice makes progress.',explanation_language:target});
    assert.ok(messages[0].content.includes(`讲解语言固定为${names[target]}（${target}）`));
    assert.match(messages[0].content,/同语言的简明释义/);
    assert.match(messages[0].content,/term、reading和例句text保留学习材料的语言/);
    const example=JSON.parse(messages[0].content.split('\n').find(line=>line.startsWith('{')));
    assert.deepEqual(validateLesson(example,target),example);
    const source=target==='ja'?'ja':'en';
    assert.equal(example.language,source);assert.equal(example.vocabulary[0].term,target==='ja'?'練習':'practice');
    const translations=[...example.vocabulary,...example.grammar].flatMap(p=>p.examples);
    assert.equal(translations.length,6);assert.ok(translations.every(p=>p.text!==p.translation));
    if(target==='en')assert.equal(/\p{Script=Han}/u.test(JSON.stringify(example)),false);
    if(target==='ja')assert.match(example.summary_zh,/\p{Script=Hiragana}/u);
    const trusted=withExplanationLanguage({...example,explanation_language:'model-invented'},target);
    assert.equal(trusted.explanation_language,target);
    const cards=cardsForLesson({record_id:randomUUID(),local_date:'2026-11-20'},trusted);
    assert.equal(cards[0].language,source);assert.equal(cards[0].term_language,source);
    assert.equal(cards[1].term_language,target);assert.ok(cards.every(c=>c.explanation_language===target));
    assert.deepEqual(cards[0].example,example.vocabulary[0].examples[0]);
  }
  for(const value of [null,undefined,'','fr','ZH',{},false,['en']])assert.throws(()=>explanationLanguage(value),/INVALID_EXPLANATION_LANGUAGE/);
});

test('same-language copies are rejected across vocabulary and grammar with trusted metadata and normalized comparison',()=>{
  for(const target of ['ja','en']){
    const valid=JSON.parse(lessonMessages({original_text:target==='ja'?'練習を続けると、少しずつ上達します。':'Practice makes progress.',explanation_language:target})[0].content.split('\n').find(line=>line.startsWith('{')));
    assert.deepEqual(parseLesson(JSON.stringify(valid),target),valid);
    for(const kind of ['vocabulary','grammar'])for(const index of [0,1,2]){
      const copy=structuredClone(valid);copy.explanation_language='zh';
      const example=copy[kind][0].examples[index];example.translation=example.text;
      const rejected=error=>{
        assert.equal(error.message,'INVALID_LESSON');
        const diagnostics=lessonDiagnostics(error);assert.equal(diagnostics.reason,'EXAMPLE_PARAPHRASE_COPY');assert.equal(diagnostics.counts.example_index,index);
        assert.equal(JSON.stringify(diagnostics).includes(example.text),false);return true;
      };
      assert.throws(()=>parseLesson(JSON.stringify(copy),target),rejected);
      // Punctuation, spacing, invisible formatting and width/case cannot disguise a copy.
      example.translation='「'+example.text.toUpperCase().replace(/[!-~]/g,c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)).split('').join(' \u200b')+'」。';
      assert.throws(()=>validateLesson(copy,target),rejected);
      // Old readers do not reinterpret existing records; only the trusted
      // generating request opts into the new same-language quality check.
      assert.doesNotThrow(()=>validateLesson(copy));
      assert.doesNotThrow(()=>validateLesson(copy,'zh'));
    }
  }
});

test('HTTP learning binds language into idempotency and overrides model language metadata on preview and result',async()=>{
  const user=randomUUID(),requests=new Map(),records=new Map(),works=[],hashes=[];let calls=0;
  const modelLesson=JSON.parse(lessonMessages({original_text:'practice',explanation_language:'en'})[0].content.split('\n').find(line=>line.startsWith('{')));
  modelLesson.explanation_language='zh'; // A provider cannot choose the trusted language.
  const client={auth:{async getUser(){return {data:{user:{id:user}},error:null};}},async rpc(name,p){
    if(name==='lingo_key_get')return {data:{key:'synthetic-key'},error:null};
    if(name==='lingo_begin'){
      hashes.push(p.p_hash);const prior=requests.get(p.p_id);
      if(prior){if(prior.hash!==p.p_hash)return {error:Error('IDEMPOTENCY_CONFLICT')};return {data:{record:structuredClone(records.get(p.p_record)),replay:true,deadline:prior.deadline},error:null};}
      const record={record_id:p.p_record,revision:1,status:'processing',local_date:'2026-11-20',...p.p_material,explanation_language:p.p_material.explanation_language??'zh',explanation_mode:'fast'};
      const deadline=new Date(Date.now()+120000).toISOString();records.set(p.p_record,record);requests.set(p.p_id,{hash:p.p_hash,deadline});
      return {data:{record:structuredClone(record),replay:false,deadline},error:null};
    }
    if(name==='lingo_finish'){
      const record=[...records.values()].find(r=>r.status==='processing');assert.ok(record);
      Object.assign(record,p.p_patch,{revision:2});return {data:structuredClone(record),error:null};
    }
    throw Error('UNEXPECTED_RPC');
  },from(table){
    if(table==='lingo_records'){
      let recordId;const chain={select(){return chain;},eq(key,value){if(key==='id')recordId=value;return chain;},is(){return chain;},async maybeSingle(){return {data:{payload:structuredClone(records.get(recordId))},error:null};}};return chain;
    }
    assert.equal(table,'lingo_requests');
    const chain={update(){return chain;},eq(){return chain;},then(resolve){return Promise.resolve(resolve({data:null,error:null}));}};return chain;
  }};
  const bundle=await build({entryPoints:['supabase/functions/app-api/index.ts'],bundle:true,format:'cjs',platform:'node',write:false,plugins:[{name:'synthetic-platform',setup(builder){
    builder.onResolve({filter:/^npm:/},args=>({path:args.path,namespace:'synthetic'}));
    builder.onLoad({filter:/.*/,namespace:'synthetic'},args=>({contents:args.path.startsWith('npm:@supabase/')?'export const createClient=()=>globalThis.testClient;':'export default {sendNotification(){throw Error("UNEXPECTED_PUSH");}};',loader:'js'}));
  }}]});
  const module={exports:{}},env={SUPABASE_URL:'https://synthetic.example.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,testClient:client,Request,Response,URL,TextEncoder,TextDecoder,ReadableStream,AbortController,crypto:webcrypto,performance:{now:()=>1000},setTimeout,clearTimeout,setInterval,clearInterval,
    Deno:{serve(){},env:{get:key=>env[key]}},EdgeRuntime:{waitUntil:work=>works.push(work)},
    fetch:async(_url,options)=>{calls++;const payload=JSON.parse(options.body);assert.ok(payload.messages[0].content.includes('English（en）'));
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(modelLesson)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
  });
  const record=randomUUID(),request=randomUUID();
  const send=async(language,requestId=request,recordId=record)=>module.exports.handler(new Request('https://synthetic.example.test/app-api',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json'},body:JSON.stringify({action:'learning.submit',request_id:requestId,params:{record_id:recordId,text:'Practice makes progress.',explanation_language:language}})}));
  const first=await send('en'),stream=await first.text();await Promise.all(works);
  const events=stream.split('\n\n').filter(block=>block.startsWith('event:')).map(block=>({event:block.split('\n')[0].slice(7),data:JSON.parse(block.split('\ndata: ')[1])}));
  assert.equal(events.find(e=>e.event==='accepted').data.record.explanation_language,'en');
  assert.equal(events.find(e=>e.event==='progress').data.preview.explanation_language,'en');
  const result=events.find(e=>e.event==='complete').data.record.result;
  assert.equal(result.explanation_language,'en');assert.equal(result.language,'en');
  const replay=await send('en');assert.match(await replay.text(),/"replay":true/);assert.equal(calls,1);assert.equal(hashes[0],hashes[1]);
  const changed=await send('ja');assert.deepEqual(await changed.json(),{ok:false,error:'IDEMPOTENCY_CONFLICT'});assert.notEqual(hashes[0],hashes[2]);assert.equal(calls,1);
  for(const value of ['fr',null,{},['en']])assert.deepEqual(await (await send(value,randomUUID())).json(),{ok:false,error:'INVALID_EXPLANATION_LANGUAGE'});
  assert.equal(calls,1);
  const failedRecord=randomUUID();
  modelLesson.vocabulary[0].examples[0].translation=modelLesson.vocabulary[0].examples[0].text;
  const failure=await send('en',randomUUID(),failedRecord),failureStream=await failure.text();await Promise.all(works);
  assert.match(failureStream,/event: error/);assert.doesNotMatch(failureStream,/event: complete/);
  assert.equal(records.get(failedRecord).status,'failed');assert.equal(records.get(failedRecord).error,'INVALID_LESSON');
  assert.equal(records.get(failedRecord).error_details.reason,'EXAMPLE_PARAPHRASE_COPY');
  assert.equal(calls,2,'a rejected paraphrase must not trigger an automatic model retry');
});
