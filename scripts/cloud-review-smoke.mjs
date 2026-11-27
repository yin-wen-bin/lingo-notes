import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {adminClient,projectKeys} from './cloud-admin.mjs';
import {createCloudClient} from '../shared/cloud-client.ts';
import {safeCode} from './cloud-smoke.mjs';

// Only disposable users created in this run may be read or mutated by fixtures.
// No model key, real learning material, notification, or email is used.
export async function runReviewSmoke(){
  const run=randomUUID(),created=new Map(),report={run_id:run,checked_at:new Date().toISOString(),model_requests:0,push_requests:0,checks:[],cleanup:false,passed:false};
  const admin=await adminClient(),{url,publishableKey}=projectKeys();
  const requireThat=(ok,code)=>{if(!ok)throw Error(code);};
  const data=(response,code)=>{if(response.error)throw Error(code);return response.data;};
  const rpc=async(name,params)=>{requireThat(created.has(params.p_user),'FIXTURE_OWNERSHIP_REQUIRED');const response=await admin.rpc(name,params);if(response.error){const error=Error('RPC_'+name.toUpperCase()+'_FAILED');error.diagnostic={database_code:response.error.code,database_message:String(response.error.message).slice(0,240)};throw error;}return response.data;};
  const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true});}catch(error){report.checks.push({name,passed:false,error:safeCode(error)});throw error;}};
  const reject=async(promise,code)=>{let error;try{await promise;}catch(e){error=e;}requireThat(error?.code===code,'EXPECTED_'+code);};
  const addDays=(date,n)=>new Date(Date.parse(date+'T04:00:00Z')+n*86400000).toISOString();
  try{
    const accounts=[];
    for(const label of ['a','b']){
      const email=`lingo-review-${run}-${label}@example.invalid`;
      const user=data(await admin.auth.admin.createUser({email,email_confirm:true,app_metadata:{lingo_review_smoke:run,qa_only:true}}),'QA_CREATE_FAILED').user;
      created.set(user.id,email);
      const link=data(await admin.auth.admin.generateLink({type:'magiclink',email}),'QA_LINK_FAILED');
      requireThat(link.user.id===user.id,'QA_ID_MISMATCH');
      const browser=createClient(url,publishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      const session=data(await browser.auth.verifyOtp({type:'magiclink',token_hash:link.properties.hashed_token}),'QA_LOGIN_FAILED').session;
      requireThat(session.user.id===user.id,'QA_SESSION_MISMATCH');
      let memory=JSON.stringify(session);
      const cloud=createCloudClient({url,publishableKey,storage:{getItem:()=>memory,setItem:(_k,v)=>{memory=v;},removeItem:()=>{memory=null;}}});
      accounts.push({id:user.id,cloud,browser});
    }
    const [a,b]=accounts;
    await check('cloud5_and_daily_limit_validation',async()=>{
      requireThat((await a.cloud.call('ping')).protocol==='cloud/6','PROTOCOL_MISMATCH');
      requireThat((await a.cloud.call('settings.get')).review_daily_limit===5,'DEFAULT_LIMIT_MISMATCH');
      for(const value of [0,101,1.5,'8'])await reject(a.cloud.call('settings.update',{review_daily_limit:value}),'INVALID_SETTINGS');
      await a.cloud.call('settings.update',{review_daily_limit:8,review_enabled:true,push_enabled:false});
      requireThat((await a.cloud.call('settings.get')).review_daily_limit===8,'LIMIT_NOT_PERSISTED');
    });
    const records=[];let date;
    for(let group=0;group<3;group++){
      const rid=randomUUID(),request=randomUUID();records.push(rid);
      const examples=[{text:'This is a synthetic example.',translation:'这是合成例句。'},{text:'We review a sample.',translation:'我们复习一个样本。'},{text:'The example is for testing.',translation:'这个例子用于测试。'}];
      const cards=Array.from({length:3},(_,slot)=>({id:randomUUID(),record_id:rid,kind:slot<2?'vocabulary':'grammar',term:`Synthetic point ${group*3+slot}`,reading:slot<2?'synthetic':'',pos:slot<2?'noun':'',language:'en',explanation_language:'zh',meaning:`合成释义 ${group*3+slot}`,example:examples[0]}));
      const lesson={language:'en',explanation_language:'zh',summary_zh:'合成复习验收',vocabulary:cards.slice(0,2).map(c=>({term:c.term,pos:c.pos,reading:c.reading,meaning:c.meaning,examples})),grammar:cards.slice(2).map(c=>({point:c.term,explanation:c.meaning,examples}))};
      const saved=await rpc('lingo_begin',{p_user:a.id,p_id:request,p_record:rid,p_action:'learning.submit',p_hash:run+group,p_material:{original_text:'Synthetic review fixture'},p_revision:null});
      await rpc('lingo_finish',{p_user:a.id,p_id:request,p_status:'complete',p_patch:{status:'complete',result:lesson},p_cards:cards});
      date??=saved.record.local_date;
    }
    const record=records[0];
    let batch,selected;
    await check('due_only_over_five_and_batch_idempotency',async()=>{
      requireThat(await rpc('lingo_make_batch',{p_user:a.id,p_now:addDays(date,0)})===null,'SAME_DAY_SELECTED');
      batch=await rpc('lingo_make_batch',{p_user:a.id,p_now:addDays(date,1)});
      const view=(await a.cloud.call('review.get',{batch_id:batch})).batch;
      requireThat(view.cards.length===8&&view.deliveries.length===0,'BATCH_SIZE_OR_PUSH_MISMATCH');selected=view.cards;
      requireThat(selected.every(c=>c.review_round===0&&c.scheduled_round===1&&!c.reviewed),'GENERATION_ADVANCED_PROGRESS');
      await a.cloud.call('settings.update',{review_daily_limit:2});
      requireThat(await rpc('lingo_make_batch',{p_user:a.id,p_now:addDays(date,1)})===batch,'BATCH_DUPLICATED');
      requireThat((await a.cloud.call('review.get',{batch_id:batch})).batch.cards.length===8,'EXISTING_BATCH_RESHUFFLED');
    });
    await check('cross_account_and_browser_write_denied',async()=>{
      const c=selected[0];
      requireThat((await b.cloud.call('review.get',{batch_id:batch})).batch===null,'BATCH_LEAKED');
      await reject(b.cloud.call('review.cards',{record_id:record}),'RECORD_NOT_FOUND');
      await reject(b.cloud.call('review.mastery',{card_id:c.id,point_key:c.point_key,mastered:true}),'CARD_CHANGED');
      const rows=data(await b.browser.from('lingo_review_points').select('point_key').eq('user_id',a.id),'RLS_READ_FAILED');requireThat(rows.length===0,'POINT_LEAKED');
      const write=await a.browser.from('lingo_review_points').update({review_round:5}).eq('user_id',a.id);requireThat(!!write.error,'DIRECT_PROGRESS_WRITE_ALLOWED');
    });
    await check('mastery_excludes_existing_batch_and_is_reversible',async()=>{
      const c=selected[0],params={card_id:c.id,point_key:c.point_key};
      requireThat((await a.cloud.call('review.mastery',{...params,mastered:true})).card.mastered,'MASTERY_NOT_SAVED');
      requireThat(!(await a.cloud.call('review.get',{batch_id:batch})).batch.cards.some(v=>v.point_key===c.point_key),'MASTERED_STILL_VISIBLE');
      requireThat((await a.cloud.call('records.get',{record_id:c.record_id})).result,'SOURCE_REMOVED');
      requireThat(!(await a.cloud.call('review.mastery',{...params,mastered:false})).card.mastered,'UNDO_FAILED');
      requireThat((await a.cloud.call('review.get',{batch_id:batch})).batch.cards.length===8,'UNDO_NOT_VISIBLE');
      await reject(a.cloud.call('review.mastery',{card_id:c.id,point_key:'0'.repeat(64),mastered:true}),'CARD_CHANGED');
    });
    await check('explicit_completion_once_and_increasing_intervals',async()=>{
      const c=selected[1],params={batch_id:batch,card_id:c.id,point_key:c.point_key};
      const done=await a.cloud.call('review.complete',params);
      requireThat(done.reviewed&&done.card.review_round===1,'COMPLETION_NOT_SAVED');
      const completedDay=new Date(Date.parse(done.card.last_completed_at)+8*3600000).toISOString().slice(0,10);
      requireThat(done.card.next_due_date===addDays(completedDay,2).slice(0,10),'FIRST_INTERVAL_MISMATCH');
      requireThat((await a.cloud.call('review.complete',params)).card.review_round===1,'DOUBLE_COMPLETION_ADVANCED');
      let due=done.card.next_due_date;
      await a.cloud.call('settings.update',{review_daily_limit:100});
      for(const [round,gap] of [[2,4],[3,7],[4,16],[5,null]]){
        const actualDay=round===3?addDays(due,3).slice(0,10):due;
        const nextBatch=await rpc('lingo_make_batch',{p_user:a.id,p_now:addDays(actualDay,0)});
        const next=(await a.cloud.call('review.get',{batch_id:nextBatch})).batch.cards.find(v=>v.point_key===c.point_key);
        requireThat(next?.scheduled_round===round,'ROUND_SELECTION_MISMATCH');
        const result=await rpc('lingo_review_complete',{p_user:a.id,p_batch:nextBatch,p_card:next.id,p_point:c.point_key,p_now:addDays(actualDay,0)});
        requireThat(result.card.review_round===round,'ROUND_NOT_ADVANCED');
        requireThat(result.card.next_due_date===(gap===null?null:addDays(actualDay,gap).slice(0,10)),'INTERVAL_MISMATCH');due=result.card.next_due_date;
      }
      requireThat((await a.cloud.call('review.cards',{record_id:c.record_id})).cards.find(v=>v.point_key===c.point_key).completed,'FIVE_ROUNDS_NOT_COMPLETE');
      requireThat((await a.cloud.call('review.complete',params)).card.review_round===5,'OLD_BATCH_ADVANCED');
    });
    report.passed=true;
  }catch(error){report.error=safeCode(error);if(error.diagnostic)report.diagnostic=error.diagnostic;}
  finally{
    let clean=true;
    for(const [id,email] of created){
      try{
        const user=data(await admin.auth.admin.getUserById(id),'QA_CLEANUP_READ_FAILED').user;
        requireThat(user.id===id&&user.email===email&&user.app_metadata?.lingo_review_smoke===run,'QA_CLEANUP_OWNERSHIP_FAILED');
        data(await admin.auth.admin.deleteUser(id),'QA_CLEANUP_FAILED');
        requireThat((await admin.auth.admin.getUserById(id)).error,'QA_USER_REMAINS');
      }catch{clean=false;}
    }
    report.cleanup=clean;report.passed&&=clean;
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3||process.argv[2]!=='--run')throw Error('EXPLICIT_RUN_REQUIRED');
  try{const report=await runReviewSmoke();console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;}
  catch(error){console.log(JSON.stringify({passed:false,error:safeCode(error)}));process.exitCode=1;}
}
