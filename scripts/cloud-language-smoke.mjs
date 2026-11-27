import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {adminClient,projectKeys} from './cloud-admin.mjs';
import {ROOT} from './cloud-config.mjs';
import {createCloudClient} from '../shared/cloud-client.ts';
import {parseOptions,safeCode,safeModelEvidence} from './cloud-smoke.mjs';

export const LANGUAGE_CASES=Object.freeze(['zh','ja','en'].flatMap(target=>[
  Object.freeze({id:`en-${target}`,source:'en',target,text:'A little practice makes a difference.'}),
  Object.freeze({id:`ja-${target}`,source:'ja',target,text:'毎日少しずつ練習しています。'})
]));
export const MAX_LANGUAGE_REQUESTS=6;
const requireThat=(condition,code)=>{if(!condition)throw Error(code);};
const checked=(result,code)=>{if(result.error)throw Error(code);return result.data;};
export function parseLanguageOptions(args){
  const remaining=[];let caseId=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--case'){
      requireThat(!caseId&&LANGUAGE_CASES.some(item=>item.id===args[i+1]),'INVALID_LANGUAGE_CASE');
      caseId=args[++i];
    }else remaining.push(args[i]);
  }
  return {...parseOptions(remaining),caseId};
}

export async function runLanguageSmoke(options,{progress=()=>{}}={}){
  requireThat(options.run&&options.liveKeyFile,'EXPLICIT_RUN_AND_KEY_REQUIRED');
  const selected=options.caseId?LANGUAGE_CASES.filter(item=>item.id===options.caseId):LANGUAGE_CASES;
  requireThat(selected.length>0,'INVALID_LANGUAGE_CASE');
  const runId=randomUUID(),cache=resolve(ROOT,'.cache/cloud3-live',runId),prior=new Map(),ids=new Set(),samples=[];
  const report={run_id:runId,started_at:new Date().toISOString(),max_model_requests:selected.length,attempted:0,automatic_retries:0,cases:[],cleanup:{passed:false},passed:false,language_quality:'manual_review_required'};
  mkdirSync(cache,{recursive:true});
  const save=()=>{writeFileSync(resolve(cache,'report.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(resolve(cache,'synthetic-lessons.json'),JSON.stringify({synthetic_only:true,run_id:runId,samples},null,2)+'\n');};
  let admin,cloud,qaId,qaEmail,key='';
  try{
    try{key=readFileSync(resolve(options.liveKeyFile),'utf8').replace(/^\uFEFF/,'').trim();}catch{throw Error('KEY_FILE_UNREADABLE');}
    requireThat(/^sk-[A-Za-z0-9_-]{16,250}$/.test(key),'INVALID_KEY_FILE');
    const {url,publishableKey}=projectKeys();admin=await adminClient();
    qaEmail=`lingo-language-${runId}@example.invalid`;
    let password=randomUUID()+'Aa7!';
    const created=checked(await admin.auth.admin.createUser({email:qaEmail,password,email_confirm:true,app_metadata:{lingo_language_run:runId,qa_only:true}}),'QA_CREATE_FAILED');
    qaId=created.user?.id;requireThat(qaId,'QA_ID_MISSING');
    writeFileSync(resolve(cache,'qa-receipt.json'),JSON.stringify({run_id:runId,user_id:qaId,email:qaEmail})+'\n');save();
    const auth=createClient(url,publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const signed=checked(await auth.auth.signInWithPassword({email:qaEmail,password}),'QA_AUTH_FAILED');password='';
    requireThat(signed.user?.id===qaId&&signed.session,'QA_SESSION_MISMATCH');
    let memory=JSON.stringify(signed.session);
    cloud=createCloudClient({url,publishableKey,storage:{getItem:()=>memory,setItem:(_k,v)=>{memory=v;},removeItem:()=>{memory=null;}}});
    requireThat((await cloud.call('ping')).protocol==='cloud/6','CLOUD6_REQUIRED');
    requireThat((await cloud.call('settings.get')).explanation_language==='zh','DEFAULT_LANGUAGE_NOT_ZH');
    await cloud.call('key.save',{key});key='';
    await cloud.call('settings.update',{explanation_mode:'fast',review_enabled:false,push_enabled:false});
    for(const sample of selected){
      requireThat(report.attempted<selected.length,'LANGUAGE_REQUEST_LIMIT');
      await cloud.call('settings.update',{explanation_language:sample.target});
      requireThat((await cloud.call('settings.get')).explanation_language===sample.target,'PREFERENCE_READBACK_FAILED');
      const previous=prior.get(sample.source),recordId=previous?.record_id??randomUUID(),requestId=randomUUID();
      ids.add(recordId);
      const action=previous?'learning.retry':'learning.submit';
      const params={record_id:recordId,text:sample.text,explanation_language:sample.target,...(previous?{revision:previous.revision}:{context:'',context_meta:{status:'none'}})};
      const outcome={id:sample.id,source:sample.source,target:sample.target,action,passed:false,preview_language_verified:true};
      const start=performance.now();let saved=null,error=null;
      report.attempted++;save();
      try{
        await cloud.start(action,params,requestId,event=>{
          if(event.record)saved=event.record;
          if(event.type==='progress'&&event.preview?.explanation_language!==sample.target)outcome.preview_language_verified=false;
        });
      }catch(caught){error=safeCode(caught);}
      try{saved=await cloud.call('records.get',{record_id:recordId});}catch{error??='READBACK_FAILED';}
      outcome.complete_ms=Math.round(performance.now()-start);outcome.status=saved?.status??null;
      outcome.usage=safeModelEvidence({usage:saved?.usage}).usage;
      if(error)outcome.error=error;
      if(saved?.status==='complete'&&saved.result){
        prior.set(sample.source,saved);
        samples.push({...sample,result:saved.result});
        const cards=checked(await admin.from('lingo_cards').select('payload').eq('user_id',qaId).eq('record_id',recordId),'QA_CARDS_READ_FAILED').map(row=>row.payload);
        outcome.cards_verified=cards.length>0&&cards.every(card=>card.explanation_language===sample.target&&['zh','ja','en','mixed'].includes(card.term_language));
        outcome.passed=!error&&saved.explanation_language===sample.target&&saved.result.explanation_language===sample.target&&saved.result.language===sample.source&&outcome.preview_language_verified&&outcome.cards_verified;
      }
      report.cases.push(outcome);save();progress(outcome);
      if(!saved||!['complete','failed','cancelled','interrupted'].includes(saved.status)||['DEEPSEEK_KEY_INVALID','DEEPSEEK_BALANCE_INSUFFICIENT','DEEPSEEK_RATE_LIMIT','SESSION_EXPIRED'].includes(error))break;
    }
    report.passed=report.attempted===selected.length&&report.cases.length===selected.length&&report.cases.every(row=>row.passed);
  }catch(error){report.error=safeCode(error);}
  finally{
    key='';
    try{
      if(admin&&qaId){
        const found=checked(await admin.auth.admin.getUserById(qaId),'QA_CLEANUP_IDENTITY_FAILED');
        requireThat(found.user?.id===qaId&&found.user.email===qaEmail&&found.user.app_metadata?.lingo_language_run===runId,'QA_CLEANUP_IDENTITY_MISMATCH');
        for(const id of ids)checked(await admin.rpc('lingo_cancel',{p_user:qaId,p_record:id}),'QA_CANCEL_FAILED');
        checked(await admin.auth.admin.deleteUser(qaId),'QA_DELETE_FAILED');
        const after=await admin.auth.admin.getUserById(qaId);requireThat(after.error?.status===404,'QA_USER_STILL_PRESENT');
        const rows=await admin.from('lingo_records').select('id',{head:true,count:'exact'}).eq('user_id',qaId);
        checked(rows,'QA_RECORD_CLEANUP_CHECK_FAILED');requireThat(rows.count===0,'QA_RECORDS_REMAIN');
      }
      report.cleanup.passed=true;
    }catch(error){report.cleanup.error=safeCode(error);report.passed=false;}
    report.finished_at=new Date().toISOString();save();
  }
  return report;
}

export async function main(args=process.argv.slice(2),{log=console.log,runner=runLanguageSmoke}={}){
  const options=parseLanguageOptions(args);
  if(!options.run||options.help){log(JSON.stringify({executed:false,max_model_requests:options.caseId?1:MAX_LANGUAGE_REQUESTS,automatic_retries:0,usage:'node scripts/cloud-language-smoke.mjs --run --live-key-file <explicit-key-file> [--case en-zh|ja-zh|en-ja|ja-ja|en-en|ja-en]',scope:'One temporary QA account; default 2 new notes and 4 explicit language revisions, or one selected new note; no owner history or notifications.'}));return 0;}
  requireThat(options.liveKeyFile,'EXPLICIT_KEY_FILE_REQUIRED');
  const report=await runner(options,{progress:value=>log(JSON.stringify({progress:value}))});log(JSON.stringify(report));return report.passed?0:1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().then(code=>{process.exitCode=code;},error=>{console.error(JSON.stringify({passed:false,error:safeCode(error)}));process.exitCode=1;});
