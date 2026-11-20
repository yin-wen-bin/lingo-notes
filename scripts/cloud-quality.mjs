import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {adminClient,projectKeys} from './cloud-admin.mjs';
import {PROJECT_REF,ROOT} from './cloud-config.mjs';
import {createCloudClient} from '../shared/cloud-client.ts';
import {parseOptions,safeCode,safeModelEvidence,syntheticPng} from './cloud-smoke.mjs';
import {validateLesson} from '../supabase/functions/_shared/core.mjs';

// Fixed, public/synthetic samples only. This is not an import of personal history.
export const QUALITY_CASES=Object.freeze([
  {id:'en-word-01',kind:'word',language:'en',text:'resilient'},
  {id:'en-word-02',kind:'word',language:'en',text:'subtle'},
  {id:'en-word-03',kind:'word',language:'en',text:'afford'},
  {id:'en-word-04',kind:'word',language:'en',text:'eventually'},
  {id:'en-word-05',kind:'word',language:'en',text:'considerate'},
  {id:'ja-word-01',kind:'word',language:'ja',text:'勉強',context:'「日本語の勉強を続けています。」という日本語の文。',pure_kanji:true},
  {id:'ja-word-02',kind:'word',language:'ja',text:'約束',context:'「友達との約束を守ります。」という日本語の文。',pure_kanji:true},
  {id:'ja-word-03',kind:'word',language:'ja',text:'素晴らしい'},
  {id:'ja-word-04',kind:'word',language:'ja',text:'懐かしい'},
  {id:'ja-word-05',kind:'word',language:'ja',text:'丁寧',context:'「丁寧に説明してくれました。」という日本語の文。',pure_kanji:true},
  {id:'en-sentence-01',kind:'sentence',language:'en',text:'She remained resilient despite the setbacks.'},
  {id:'en-sentence-02',kind:'sentence',language:'en',text:'If I had known earlier, I would have called you.'},
  {id:'en-sentence-03',kind:'sentence',language:'en',text:'I have been learning Japanese for three years.'},
  {id:'en-sentence-04',kind:'sentence',language:'en',text:'Would you mind giving me a hand?'},
  {id:'en-sentence-05',kind:'sentence',language:'en',text:'The book that you recommended was worth reading.'},
  {id:'ja-sentence-01',kind:'sentence',language:'ja',text:'毎朝、電車の中で日本語を勉強しています。'},
  {id:'ja-sentence-02',kind:'sentence',language:'ja',text:'雨が降りそうなので、傘を持っていきます。'},
  {id:'ja-sentence-03',kind:'sentence',language:'ja',text:'もっと早く知っていれば、手伝えたのに。'},
  {id:'ja-sentence-04',kind:'sentence',language:'ja',text:'この本は読みやすいですが、少し長すぎます。'},
  {id:'ja-sentence-05',kind:'sentence',language:'ja',text:'先生にレポートを直していただきました。'}
].map(sample=>Object.freeze(sample)));
export const MAX_MODEL_REQUESTS=22;
const assert=(condition,code)=>{if(!condition)throw Error(code);};
const checked=(response,code)=>{if(response.error)throw Error(code);return response.data;};
const terminal=new Set(['complete','awaiting_review','failed','interrupted','cancelled']);
export function safeDiagnostics(value){
  if(!value||typeof value.reason!=='string'||!/^[A-Z][A-Z0-9_]{2,79}$/.test(value.reason))return null;
  const counts={};
  for(const field of ['characters','vocabulary_count','grammar_count','point_count','vocabulary_index','grammar_index','example_count','example_index']){
    if(Number.isSafeInteger(value.counts?.[field])&&value.counts[field]>=0)counts[field]=value.counts[field];
  }
  return {reason:value.reason,counts};
}
export function qualityChecks(record,sample){
  const result=validateLesson(record.result),points=[...result.vocabulary,...result.grammar];
  const issues=[];
  if(result.language!==sample.language)issues.push('LANGUAGE_MISMATCH');
  for(const point of points)if(new Set(point.examples.map(example=>example.text.trim())).size!==3)issues.push('DUPLICATE_EXAMPLES');
  for(const word of result.vocabulary){
    if(sample.language==='ja'&&!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word.reading))issues.push('JAPANESE_READING_MISSING');
    if(sample.language==='en'&&!/^\s*(?:\/[^/]+\/|\[[^\]]+\])\s*$/.test(word.reading))issues.push('IPA_FORMAT_MISSING');
  }
  return {points:points.length,examples:points.reduce((count,point)=>count+point.examples.length,0),issues:[...new Set(issues)]};
}

export async function runQuality(options,{onProgress=()=>{}}={}){
  assert(options.run===true,'RUN_FLAG_REQUIRED');assert(options.liveKeyFile,'EXPLICIT_KEY_FILE_REQUIRED');
  const runId=randomUUID(),created=new Map(),records=new Set(),objects=new Set(),synthetic=[];
  const report={run_id:runId,checked_at:new Date().toISOString(),project_ref:PROJECT_REF,model_requests_limit:MAX_MODEL_REQUESTS,model_requests_attempted:0,automatic_retries:0,cases:[],quality_status:'manual_review_required',cleanup:{passed:false,users_deleted:0,objects_removed:0},passed:false};
  let key='',admin,qaId,qaEmail,cloud;
  const artifactPath=resolve(ROOT,'.cache/quality-synthetic.json'),reportPath=resolve(ROOT,'.cache/quality-report.json');
  function saveEvidence(){
    mkdirSync(resolve(ROOT,'.cache'),{recursive:true});
    writeFileSync(artifactPath,JSON.stringify({run_id:runId,synthetic_only:true,quality_status:report.quality_status,samples:synthetic},null,2)+'\n');
    writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  async function sampleRun(sample,action,params){
    assert(report.model_requests_attempted<MAX_MODEL_REQUESTS,'MODEL_REQUEST_LIMIT');
    const requestId=randomUUID(),start=performance.now();
    const evidence={accepted_ms:null,first_readable_ms:null,complete_ms:null,error_event_ms:null,last_sse_event:null,saved_status:null,usage:null};
    const outcome={id:sample.id,kind:sample.kind,language:sample.language,request_id:requestId,record_id:params.record_id,passed:false,readback:false};
    let saved=null,caught=null;
    records.add(params.record_id);
    if(action==='learning.recognize')objects.add(`${qaId}/${params.record_id}/${requestId}.png`);
    report.model_requests_attempted++;
    try{
      saved=await cloud.start(action,params,requestId,event=>{
        const elapsed=Math.round(performance.now()-start);evidence.last_sse_event=event.type;
        if(event.record){saved=event.record;evidence.saved_status=saved.status;evidence.usage=saved.usage??null;}
        if(event.type==='accepted')evidence.accepted_ms??=elapsed;
        if(event.type==='progress'&&event.preview?.summary_zh)evidence.first_readable_ms??=elapsed;
        if(event.type==='complete'){evidence.complete_ms=elapsed;if(event.record?.recognized_text||event.record?.result?.summary_zh)evidence.first_readable_ms??=elapsed;}
        if(event.type==='error')evidence.error_event_ms=elapsed;
      });
    }catch(error){caught=error;outcome.error=safeCode(error);}
    // Exactly one status read after the single model attempt; never resubmit or poll a billable action.
    try{
      const readback=await cloud.call('records.get',{record_id:params.record_id});
      if(readback){
        outcome.readback=!saved||(saved.record_id===readback.record_id&&saved.revision===readback.revision&&saved.status===readback.status);
        saved=readback;evidence.saved_status=saved.status;evidence.usage=saved.usage??null;
      }
    }catch(error){outcome.readback_error=safeCode(error);}
    outcome.error_details=safeDiagnostics(saved?.error_details);
    if(saved?.error&&!outcome.error)outcome.error=safeCode({code:saved.error});
    if(!caught&&saved){
      try{
        assert(outcome.readback,'QUALITY_READBACK_MISMATCH');
        if(action==='learning.recognize'){
          assert(saved.status==='awaiting_review','OCR_STATUS_MISMATCH');
          assert(String(saved.recognized_text).toUpperCase().replace(/\s+/g,' ').includes('WE LEARN EVERY DAY'),'OCR_TEXT_MISMATCH');
        }else{
          assert(saved.status==='complete','LESSON_STATUS_MISMATCH');
          const checks=qualityChecks(saved,sample);Object.assign(outcome,checks);
          assert(checks.issues.length===0,'QUALITY_CHECK_FAILED');
          if(action==='learning.confirm')assert(saved.corrected_text===params.text,'CORRECTED_TEXT_MISMATCH');
        }
        outcome.passed=true;
      }catch(error){outcome.error=safeCode(error);}
    }
    Object.assign(outcome,safeModelEvidence(evidence),{elapsed_ms:Math.round(performance.now()-start)});
    synthetic.push({id:sample.id,input:sample.text??null,context:sample.context??'',action,record_id:params.record_id,status:saved?.status??null,result:saved?.result??null,recognized_text:saved?.recognized_text??null,corrected_text:saved?.corrected_text??null,error:outcome.error??null,error_details:outcome.error_details,usage:outcome.usage,model:saved?.model??null,template_version:saved?.template_version??null});
    report.cases.push(outcome);saveEvidence();onProgress({run_id:runId,completed:report.cases.length,limit:MAX_MODEL_REQUESTS,...outcome});
    const systemic=['DEEPSEEK_KEY_INVALID','DEEPSEEK_KEY_REQUIRED','DEEPSEEK_BALANCE_INSUFFICIENT','DEEPSEEK_RATE_LIMIT','SESSION_EXPIRED','SESSION_CHANGED','LOGIN_REQUIRED','REQUEST_IN_PROGRESS'];
    if(!saved||!terminal.has(saved.status)||systemic.includes(outcome.error)||outcome.readback_error)throw Error(outcome.error??outcome.readback_error??'REQUEST_STATE_UNKNOWN');
    return {record:saved,passed:outcome.passed};
  }
  try{
    try{key=readFileSync(resolve(options.liveKeyFile),'utf8').replace(/^\uFEFF/,'').trim();}catch{throw Error('KEY_FILE_UNREADABLE');}
    assert(/^sk-[A-Za-z0-9_-]{16,250}$/.test(key),'INVALID_KEY_FILE');
    const {url,publishableKey}=projectKeys();assert(new URL(url).hostname===`${PROJECT_REF}.supabase.co`,'UNEXPECTED_PROJECT');admin=await adminClient();
    qaEmail=`lingo-quality-${runId}@example.invalid`;
    const createdData=checked(await admin.auth.admin.createUser({email:qaEmail,email_confirm:true,app_metadata:{lingo_quality_run:runId,qa_only:true}}),'QA_USER_CREATE_FAILED');
    assert(createdData.user?.id,'QA_USER_ID_MISSING');qaId=createdData.user.id;created.set(qaId,qaEmail);
    const link=checked(await admin.auth.admin.generateLink({type:'magiclink',email:qaEmail}),'QA_LINK_GENERATION_FAILED');
    assert(link.user?.id===qaId&&link.properties?.hashed_token,'QA_LINK_IDENTITY_MISMATCH');
    const client=createClient(url,publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const verified=checked(await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'}),'QA_SESSION_FAILED');
    assert(verified.user?.id===qaId&&verified.session?.access_token,'QA_SESSION_IDENTITY_MISMATCH');
    let memory=JSON.stringify(verified.session);
    cloud=createCloudClient({url,publishableKey,storage:{getItem:()=>memory,setItem:(_name,value)=>{memory=value;},removeItem:()=>{memory=null;}}});
    assert((await cloud.call('key.status')).configured===false,'QA_KEY_NOT_EMPTY');
    await cloud.call('key.save',{key});key='';
    assert((await cloud.call('key.status')).configured===true,'QA_KEY_NOT_SAVED');
    assert((await cloud.call('records.history')).items.length===0,'QA_HISTORY_NOT_EMPTY');
    for(const sample of QUALITY_CASES)await sampleRun(sample,'learning.submit',{record_id:randomUUID(),text:sample.text,context:sample.context??'',context_meta:{status:sample.context?'matched':'none'}});
    const imageId=randomUUID();
    const ocr=await sampleRun({id:'ocr-01',kind:'ocr',language:'en',text:'LINGO NOTES\nWE LEARN EVERY DAY.'},'learning.recognize',{record_id:imageId,image:`data:image/png;base64,${syntheticPng().toString('base64')}`});
    if(ocr.passed){
      const corrected='We learn something new every day.';
      await sampleRun({id:'ocr-confirm-01',kind:'corrected-image-lesson',language:'en',text:corrected},'learning.confirm',{record_id:imageId,revision:ocr.record.revision,text:corrected});
    }else report.skipped=['ocr-confirm-01'];
    report.passed=report.cases.length===MAX_MODEL_REQUESTS&&report.cases.every(item=>item.passed);
  }catch(error){report.error=safeCode(error);}
  finally{
    key='';const failed=[];
    if(admin&&created.has(qaId)){
      for(const recordId of records)try{await admin.rpc('lingo_cancel',{p_user:qaId,p_record:recordId});}catch{}
      for(const path of objects)try{
        assert(path.startsWith(`${qaId}/`),'QA_CLEANUP_PATH_DENIED');
        const removed=checked(await admin.storage.from('lingo-images').remove([path]),'QA_OBJECT_CLEANUP_FAILED');
        report.cleanup.objects_removed+=Array.isArray(removed)?removed.length:0;
        const parts=path.split('/'),name=parts.pop();
        const remaining=checked(await admin.storage.from('lingo-images').list(parts.join('/'),{search:name}),'QA_OBJECT_CLEANUP_VERIFY_FAILED');
        assert(!remaining.some(item=>item.name===name),'QA_OBJECT_STILL_PRESENT');
      }catch(error){failed.push({kind:'object',path,error:safeCode(error)});}
      try{
        const found=checked(await admin.auth.admin.getUserById(qaId),'QA_CLEANUP_IDENTITY_READ_FAILED');
        assert(found.user?.id===qaId&&found.user.email===qaEmail&&found.user.app_metadata?.lingo_quality_run===runId,'QA_CLEANUP_IDENTITY_MISMATCH');
        checked(await admin.auth.admin.deleteUser(qaId),'QA_USER_CLEANUP_FAILED');
        const after=await admin.auth.admin.getUserById(qaId);
        assert(!!after.error&&Number(after.error.status)===404,'QA_USER_CLEANUP_VERIFY_FAILED');
        report.cleanup.users_deleted++;
      }catch(error){failed.push({kind:'user',id:qaId,error:safeCode(error)});}
    }
    report.cleanup.passed=failed.length===0&&report.cleanup.users_deleted===created.size;
    if(failed.length)report.cleanup.remaining=failed;
    report.passed=report.passed&&report.cleanup.passed;
    report.completed_at=new Date().toISOString();saveEvidence();
  }
  return report;
}

export async function main(args=process.argv.slice(2),{log=console.log,runner=runQuality}={}){
  const options=parseOptions(args);
  if(!options.run||options.help){log(JSON.stringify({executed:false,usage:'node scripts/cloud-quality.mjs --run --live-key-file <explicit-key-file>',default:'No network, key reads, account creation or model calls without --run.',scope:'One temporary QA user; 10 words and 10 sentences, English/Japanese equally split; one synthetic OCR and one corrected-image lesson.',paid_model_request_limit:MAX_MODEL_REQUESTS,automatic_retries:0,manual_quality_review:'Full synthetic lessons saved only in .cache/quality-synthetic.json; schema success is not language-quality acceptance.'}));return 0;}
  assert(options.liveKeyFile,'EXPLICIT_KEY_FILE_REQUIRED');
  const report=await runner(options,{onProgress:value=>log(JSON.stringify({progress:value}))});log(JSON.stringify(report,null,2));return report.passed?0:1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().then(code=>{process.exitCode=code;},error=>{console.error(JSON.stringify({passed:false,error:safeCode(error)}));process.exitCode=1;});
}
