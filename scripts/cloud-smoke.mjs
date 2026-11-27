import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createClient} from '@supabase/supabase-js';
import {adminClient,projectKeys} from './cloud-admin.mjs';
import {PROJECT_REF} from './cloud-config.mjs';
import {createCloudClient} from '../shared/cloud-client.ts';

// This script never discovers existing users, records or keys. Only IDs returned by
// its own createUser calls can enter the cleanup and privileged-fixture paths.
export function parseOptions(args){
  const options={run:false,liveKeyFile:null,help:false};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--run')options.run=true;
    else if(args[i]==='--help'||args[i]==='-h')options.help=true;
    else if(args[i]==='--live-key-file'){
      if(!args[i+1]||args[i+1].startsWith('--')||options.liveKeyFile)throw Error('INVALID_KEY_FILE_ARGUMENT');
      options.liveKeyFile=args[++i];
    }else throw Error('UNKNOWN_ARGUMENT');
  }
  return options;
}
export function safeCode(error){
  const code=error?.code??error?.message;
  return typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(code)?code:'SMOKE_OPERATION_FAILED';
}
function requireThat(condition,code){if(!condition)throw Error(code);}
function checked(response,code){if(response.error)throw Error(code);return response.data;}
export function isPermissionDenial(response,layer='database'){
  if(!response?.error)return false;
  if(layer==='storage')return [400,401,403,404].includes(Number(response.error.status??response.error.statusCode));
  return ['42501','PGRST106','PGRST202'].includes(response.error.code);
}
export function safeModelEvidence(value){
  if(!value||typeof value!=='object')return {};
  const clean={};
  for(const field of ['accepted_ms','first_readable_ms','complete_ms','error_event_ms'])clean[field]=Number.isFinite(value[field])&&value[field]>=0?Math.round(value[field]):null;
  clean.last_sse_event=['accepted','progress','complete','error'].includes(value.last_sse_event)?value.last_sse_event:null;
  clean.saved_status=['saved','processing','complete','awaiting_review','failed','interrupted','cancelled'].includes(value.saved_status)?value.saved_status:null;
  clean.usage=null;
  if(value.usage&&typeof value.usage==='object'){
    const usage={};for(const field of ['input_tokens','output_tokens','total_tokens'])if(Number.isFinite(value.usage[field])&&value.usage[field]>=0)usage[field]=value.usage[field];
    if(Object.keys(usage).length)clean.usage=usage;
  }
  return clean;
}
function chunk(type,data){
  const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  const out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
// A deterministic, non-personal OCR fixture; no file, screenshot or user material is read.
export function syntheticPng(){
  const glyphs={
    A:['01110','10001','10001','11111','10001','10001','10001'],D:['11110','10001','10001','10001','10001','10001','11110'],
    E:['11111','10000','10000','11110','10000','10000','11111'],G:['01110','10001','10000','10111','10001','10001','01110'],
    I:['11111','00100','00100','00100','00100','00100','11111'],L:['10000','10000','10000','10000','10000','10000','11111'],
    N:['10001','11001','11001','10101','10011','10011','10001'],O:['01110','10001','10001','10001','10001','10001','01110'],
    R:['11110','10001','10001','11110','10100','10010','10001'],S:['01111','10000','10000','01110','00001','00001','11110'],
    T:['11111','00100','00100','00100','00100','00100','00100'],V:['10001','10001','10001','10001','10001','01010','00100'],
    W:['10001','10001','10001','10101','10101','10101','01010'],Y:['10001','10001','01010','00100','00100','00100','00100'],
    '.':['00000','00000','00000','00000','00000','00100','00100']
  };
  const width=520,height=128,scale=4,stride=width*4+1,scan=Buffer.alloc(stride*height,255);
  for(let y=0;y<height;y++)scan[y*stride]=0;
  for(const [line,text] of ['LINGO NOTES','WE LEARN EVERY DAY.'].entries())for(const [column,char] of [...text].entries()){
    const glyph=glyphs[char];if(!glyph)continue;
    for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(glyph[y][x]==='1')for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
      const offset=(22+line*52+y*scale+dy)*stride+1+(20+column*6*scale+x*scale+dx)*4;
      scan[offset]=37;scan[offset+1]=87;scan[offset+2]=63;
    }
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}

const syntheticLesson={language:'en',summary_zh:'合成验收内容',vocabulary:[{term:'learn',pos:'verb',reading:'/lɜːn/',meaning:'学习',examples:[{text:'We learn every day.',translation:'我们每天学习。'},{text:'I learn by reading.',translation:'我通过阅读学习。'},{text:'They learn together.',translation:'他们一起学习。'}]}],grammar:[]};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sdkOptions={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init={})=>fetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(20000),...(init.signal?[init.signal]:[])])})}};

export async function runSmoke(options){
  requireThat(options.run===true,'RUN_FLAG_REQUIRED');
  const runId=randomUUID(),created=new Map(),objects=new Set(),records=new Map();let liveKey='';
  const report={run_id:runId,checked_at:new Date().toISOString(),project_ref:PROJECT_REF,mode:options.liveKeyFile?'deployed-api-with-up-to-two-paid-model-requests':'deployed-api-and-sql-no-model-requests',fixture_source:'synthetic fixtures written to deployed SQL and Storage; not model-generated unless labelled live',model_requests_attempted:0,checks:[],cleanup:{passed:false,users_deleted:0,objects_removed:0},passed:false};
  let admin;
  async function check(name,work){const at=performance.now();try{const detail=await work();report.checks.push({name,passed:true,elapsed_ms:Math.round(performance.now()-at),...(detail??{})});return detail;}catch(error){report.checks.push({name,passed:false,error:safeCode(error),elapsed_ms:Math.round(performance.now()-at),...safeModelEvidence(error.smokeEvidence)});throw error;}}
  function owned(id){requireThat(created.has(id),'QA_OWNERSHIP_REQUIRED');return created.get(id);}
  function recordFor(id){owned(id);const rid=randomUUID();records.set(rid,id);return rid;}
  function objectFor(id,rid,requestId){owned(id);requireThat(records.get(rid)===id,'QA_RECORD_OWNERSHIP_REQUIRED');const path=`${id}/${rid}/${requestId}.png`;objects.add(path);return path;}
  async function rpc(name,params){requireThat(params.p_user&&created.has(params.p_user),'QA_RPC_OWNERSHIP_REQUIRED');return checked(await admin.rpc(name,params),`RPC_${name.replace('lingo_','').toUpperCase()}_FAILED`);}
  async function deniedRpc(client,name,params){const response=await client.rpc(name,params);requireThat(!!response.error&&['42501','PGRST202'].includes(response.error.code),'BROWSER_RPC_NOT_DENIED');}
  async function expectRpcError(name,params,expected){owned(params.p_user);const response=await admin.rpc(name,params);requireThat(!!response.error&&response.error.message===expected,`EXPECTED_${expected}`);}
  async function begin(user,{recordId=recordFor(user.id),requestId=randomUUID(),action='learning.submit',revision=null,patch={original_text:'Synthetic learning record'}}={}){
    requireThat(records.get(recordId)===user.id,'QA_RECORD_OWNERSHIP_REQUIRED');
    const params={p_user:user.id,p_id:requestId,p_record:recordId,p_action:action,p_hash:digest(JSON.stringify({action,revision,patch})),p_material:patch,p_revision:revision};
    return {recordId,requestId,params,result:await rpc('lingo_begin',params)};
  }
  async function finish(user,requestId,patch={status:'complete',result:syntheticLesson},cards=[]){return rpc('lingo_finish',{p_user:user.id,p_id:requestId,p_status:'complete',p_patch:patch,p_cards:cards});}
  async function mustReject(promise,code){let caught;try{await promise;}catch(error){caught=error;}requireThat(caught?.code===code,`EXPECTED_${code}`);}
  try{
    if(options.liveKeyFile){try{liveKey=readFileSync(resolve(options.liveKeyFile),'utf8').replace(/^\uFEFF/,'').trim();}catch{throw Error('KEY_FILE_UNREADABLE');}requireThat(/^sk-[A-Za-z0-9_-]{16,250}$/.test(liveKey),'INVALID_KEY_FILE');}
    const {url,publishableKey}=projectKeys();requireThat(new URL(url).hostname===`${PROJECT_REF}.supabase.co`,'UNEXPECTED_PROJECT');admin=await adminClient();
    const anonymous=createClient(url,publishableKey,sdkOptions);
    const qa=[];
    await check('create_two_isolated_confirmed_qa_users_without_email',async()=>{
      for(const label of ['a','b']){
        const email=`lingo-smoke-${runId}-${label}@example.invalid`;
        const data=checked(await admin.auth.admin.createUser({email,email_confirm:true,app_metadata:{lingo_smoke_run:runId,qa_only:true}}),'QA_USER_CREATE_FAILED');
        requireThat(data.user?.id,'QA_USER_ID_MISSING');const id=data.user.id;created.set(id,{id,email,label});
        const link=checked(await admin.auth.admin.generateLink({type:'magiclink',email}),'QA_LINK_GENERATION_FAILED');
        requireThat(link.user?.id===id&&link.properties?.hashed_token,'QA_LINK_IDENTITY_MISMATCH');
        const client=createClient(url,publishableKey,sdkOptions);
        const verified=checked(await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'}),'QA_SESSION_FAILED');
        requireThat(verified.user?.id===id&&verified.session?.access_token,'QA_SESSION_IDENTITY_MISMATCH');
        let memory=JSON.stringify(verified.session);
        const cloud=createCloudClient({url,publishableKey,storage:{getItem:()=>memory,setItem:(_key,value)=>{memory=value;},removeItem:()=>{memory=null;}}});
        qa.push({id,client,cloud});
      }
      return {users_created:qa.length};
    });
    const [a,b]=qa;
    await check('anonymous_edge_requests_rejected',async()=>{
      const response=await fetch(`${url}/functions/v1/app-api`,{method:'POST',headers:{apikey:publishableKey,'Content-Type':'application/json'},body:JSON.stringify({action:'ping',params:{},request_id:randomUUID()}),signal:AbortSignal.timeout(20000)});
      const body=await response.json();requireThat(response.status===401&&body.ok===false&&body.error==='LOGIN_REQUIRED','ANONYMOUS_EDGE_NOT_DENIED');
    });
    await check('deployed_contract_and_missing_key_flow',async()=>{
      const ping=await a.cloud.call('ping');requireThat(ping.protocol==='cloud/6'&&ping.protocol_version==='lingo-cloud/6','CLOUD_CONTRACT_MISMATCH');
      requireThat((await a.cloud.call('key.status')).configured===false,'QA_KEY_NOT_EMPTY');
      const rid=recordFor(a.id);await mustReject(a.cloud.start('learning.submit',{record_id:rid,text:'Synthetic no-key request'},randomUUID(),()=>{}),'DEEPSEEK_KEY_REQUIRED');
      requireThat(await a.cloud.call('records.get',{record_id:rid})===null,'NO_KEY_REQUEST_SAVED_RECORD');
      requireThat((await a.cloud.call('records.history')).items.length===0,'QA_HISTORY_NOT_EMPTY');
    });
    let fixture;
    await check('deployed_sql_idempotency_and_single_request_gate',async()=>{
      fixture=await begin(a);
      const replay=await rpc('lingo_begin',fixture.params);requireThat(replay.replay===true&&replay.record.record_id===fixture.recordId,'REPLAY_MISMATCH');
      await expectRpcError('lingo_begin',{...fixture.params,p_hash:'different'},'IDEMPOTENCY_CONFLICT');
      await expectRpcError('lingo_begin',{...fixture.params,p_id:randomUUID(),p_record:recordFor(a.id)},'REQUEST_IN_PROGRESS');
      const rows=checked(await admin.from('lingo_requests').select('id').eq('user_id',a.id).eq('id',fixture.requestId),'QA_REQUEST_READ_FAILED');requireThat(rows.length===1,'DUPLICATE_REQUEST_ROWS');
      await finish(a,fixture.requestId,{status:'complete',result:syntheticLesson},[{id:randomUUID(),record_id:fixture.recordId,term:'learn',language:'en',reading:'/lɜːn/',meaning:'合成学习点',example:syntheticLesson.vocabulary[0].examples[0]}]);
    });
    await check('authenticated_rls_owner_read_and_cross_account_denial',async()=>{
      const own=checked(await a.client.from('lingo_records').select('id').eq('id',fixture.recordId),'OWNER_READ_FAILED');requireThat(own.length===1,'OWNER_RECORD_NOT_VISIBLE');
      const other=checked(await b.client.from('lingo_records').select('id').eq('id',fixture.recordId),'OTHER_ACCOUNT_READ_FAILED');requireThat(other.length===0,'CROSS_ACCOUNT_RECORD_LEAK');
      requireThat(await b.cloud.call('records.get',{record_id:fixture.recordId})===null,'EDGE_CROSS_ACCOUNT_RECORD_LEAK');
      await mustReject(b.cloud.call('records.delete',{record_id:fixture.recordId,revision:2,confirmed:true}),'RECORD_NOT_FOUND');
      requireThat((await a.cloud.call('records.get',{record_id:fixture.recordId})).revision===2,'CROSS_ACCOUNT_DELETE_CHANGED_RECORD');
      requireThat(isPermissionDenial(await anonymous.from('lingo_records').select('id').eq('id',fixture.recordId)),'ANONYMOUS_RECORD_TABLE_NOT_DENIED');
      requireThat(isPermissionDenial(await a.client.from('lingo_records').update({payload:{}}).eq('id',fixture.recordId)),'BROWSER_RECORD_WRITE_NOT_DENIED');
    });
    await check('vault_roundtrip_and_browser_rpc_denial_on_qa_key_only',async()=>{
      let fakeKey='sk-'+randomBytes(24).toString('hex');
      await a.cloud.call('key.save',{key:fakeKey});requireThat((await a.cloud.call('key.status')).configured===true,'QA_KEY_NOT_SAVED');
      requireThat((await rpc('lingo_key_get',{p_user:a.id,p_plain:true})).key===fakeKey,'QA_VAULT_ROUNDTRIP_FAILED');
      for(const client of [anonymous,a.client,b.client])await deniedRpc(client,'lingo_key_get',{p_user:a.id,p_plain:true});
      requireThat(isPermissionDenial(await b.client.schema('vault').from('decrypted_secrets').select('decrypted_secret').eq('name','lingo-user-'+a.id)),'BROWSER_VAULT_NOT_DENIED');
      requireThat((await b.cloud.call('key.status')).configured===false,'CROSS_ACCOUNT_KEY_LEAK');
      await a.cloud.call('key.delete');fakeKey='';requireThat((await a.cloud.call('key.status')).configured===false,'QA_KEY_NOT_REMOVED');
    });
    let batchId;
    await check('deployed_daily_batch_unique_and_private',async()=>{
      await a.cloud.call('settings.update',{review_enabled:true,push_enabled:false});
      const tomorrow=new Date(Date.now()+86400000).toISOString();
      batchId=await rpc('lingo_make_batch',{p_user:a.id,p_now:tomorrow});requireThat(!!batchId,'QA_BATCH_NOT_CREATED');
      requireThat(await rpc('lingo_make_batch',{p_user:a.id,p_now:tomorrow})===batchId,'DUPLICATE_DAILY_BATCH');
      requireThat((await a.cloud.call('review.get',{batch_id:batchId})).batch.cards.length===1,'QA_CARD_MISSING');
      requireThat((await b.cloud.call('review.get',{batch_id:batchId})).batch===null,'CROSS_ACCOUNT_BATCH_LEAK');
      const rows=checked(await b.client.from('lingo_review_batches').select('id').eq('id',batchId),'BATCH_RLS_READ_FAILED');requireThat(rows.length===0,'CROSS_ACCOUNT_BATCH_RLS_LEAK');
      requireThat((await a.cloud.call('review.get',{batch_id:batchId})).batch.deliveries.length===0,'QA_NOTIFICATION_UNEXPECTED');
    });
    await check('cancel_rejects_late_completion_and_preserves_previous_result',async()=>{
      const retry=await begin(a,{recordId:fixture.recordId,action:'learning.retry',revision:2,patch:{corrected_text:'Synthetic revised record'}});
      const result=await a.cloud.call('learning.cancel',{record_id:fixture.recordId});requireThat(result.status==='cancelled'&&result.result?.summary_zh===syntheticLesson.summary_zh,'CANCEL_RESULT_MISMATCH');
      await expectRpcError('lingo_finish',{p_user:a.id,p_id:retry.requestId,p_status:'complete',p_patch:{status:'complete',result:syntheticLesson},p_cards:[]},'REQUEST_NOT_ACTIVE');
    });
    await check('simulated_expiry_uses_real_deployed_read_recovery',async()=>{
      const current=await a.cloud.call('records.get',{record_id:fixture.recordId});
      const retry=await begin(a,{recordId:fixture.recordId,action:'learning.retry',revision:current.revision,patch:{corrected_text:'Synthetic expiry fixture'}});
      checked(await admin.from('lingo_requests').update({deadline:new Date(Date.now()-1000).toISOString()}).eq('user_id',a.id).eq('id',retry.requestId),'QA_EXPIRY_SETUP_FAILED');
      const expired=await a.cloud.call('records.get',{record_id:fixture.recordId});requireThat(expired.status==='interrupted'&&expired.result?.summary_zh===syntheticLesson.summary_zh,'EXPIRED_RESULT_MISMATCH');
      await expectRpcError('lingo_finish',{p_user:a.id,p_id:retry.requestId,p_status:'complete',p_patch:{status:'complete'},p_cards:[]},'REQUEST_NOT_ACTIVE');
    });
    await check('delete_is_idempotent_excludes_review_and_rejects_late_completion',async()=>{
      const current=await a.cloud.call('records.get',{record_id:fixture.recordId});
      const retry=await begin(a,{recordId:fixture.recordId,action:'learning.retry',revision:current.revision,patch:{corrected_text:'Synthetic delete fixture'}});
      const params={record_id:fixture.recordId,revision:retry.result.record.revision,confirmed:true};
      requireThat((await a.cloud.call('records.delete',params)).deleted===true,'QA_DELETE_FAILED');
      requireThat((await a.cloud.call('records.delete',params)).deleted===true,'DELETE_NOT_IDEMPOTENT');
      requireThat(await a.cloud.call('records.get',{record_id:fixture.recordId})===null,'DELETED_RECORD_VISIBLE');
      requireThat((await a.cloud.call('review.get',{batch_id:batchId})).batch.cards.length===0,'DELETED_CARD_STILL_VISIBLE');
      await expectRpcError('lingo_finish',{p_user:a.id,p_id:retry.requestId,p_status:'complete',p_patch:{status:'complete'},p_cards:[]},'REQUEST_NOT_ACTIVE');
    });
    const png=syntheticPng();
    await check('private_storage_and_signed_image_owner_checks',async()=>{
      const image=await begin(a,{action:'learning.recognize',patch:{image_hash:digest(png)}}),path=objectFor(a.id,image.recordId,image.requestId);
      checked(await admin.storage.from('lingo-images').upload(path,png,{contentType:'image/png',upsert:false}),'QA_IMAGE_UPLOAD_FAILED');
      await rpc('lingo_attach_image',{p_user:a.id,p_id:image.requestId,p_image:{path,sha256:digest(png),mime_type:'image/png',byte_size:png.length,width:520,height:128}});
      await finish(a,image.requestId,{status:'awaiting_review',recognized_text:'SYNTHETIC OCR FIXTURE'});
      for(const client of [anonymous,a.client,b.client])requireThat(isPermissionDenial(await client.storage.from('lingo-images').download(path),'storage'),'DIRECT_STORAGE_READ_NOT_DENIED');
      requireThat(isPermissionDenial(await b.client.storage.from('lingo-images').createSignedUrl(path,60),'storage'),'CROSS_ACCOUNT_IMAGE_SIGNING_ALLOWED');
      await mustReject(b.cloud.call('images.url',{record_id:image.recordId}),'IMAGE_NOT_FOUND');
      const signed=await a.cloud.call('images.url',{record_id:image.recordId});requireThat(new URL(signed.url).origin===new URL(url).origin&&signed.expires_in===60,'SIGNED_IMAGE_RESPONSE_INVALID');
      const response=await fetch(signed.url,{signal:AbortSignal.timeout(20000)});requireThat(response.ok&&digest(Buffer.from(await response.arrayBuffer()))===digest(png),'SIGNED_IMAGE_CONTENT_MISMATCH');
      const record=await a.cloud.call('records.get',{record_id:image.recordId});await a.cloud.call('records.delete',{record_id:image.recordId,revision:record.revision,confirmed:true});
      await mustReject(a.cloud.call('images.url',{record_id:image.recordId}),'IMAGE_NOT_FOUND');return {synthetic_image_bytes:png.length};
    });
    if(options.liveKeyFile){
      await check('bind_explicit_key_to_qa_user_only',async()=>{owned(a.id);await a.cloud.call('key.save',{key:liveKey});requireThat((await a.cloud.call('key.status')).configured===true,'LIVE_QA_KEY_NOT_SAVED');liveKey='';});
      for(const kind of ['text','image'])await check(`live_deployed_${kind}_single_model_request`,async()=>{
        const rid=recordFor(a.id),requestId=randomUUID(),started=performance.now();let accepted=null,firstReadable=null;
        const evidence={accepted_ms:null,first_readable_ms:null,complete_ms:null,error_event_ms:null,last_sse_event:null,saved_status:null,usage:null};
        if(kind==='image')objectFor(a.id,rid,requestId);
        const params=kind==='text'?{record_id:rid,text:'We learn something new every day.',context:'',context_meta:{status:'none'}}:{record_id:rid,image:`data:image/png;base64,${png.toString('base64')}`};
        report.model_requests_attempted++;
        let record;
        try{record=await a.cloud.start(kind==='text'?'learning.submit':'learning.recognize',params,requestId,event=>{
          const elapsed=Math.round(performance.now()-started);evidence.last_sse_event=event.type;
          if(event.record){evidence.saved_status=event.record.status;evidence.usage=event.record.usage??null;}
          if(event.type==='accepted')accepted??=elapsed;
          if(event.type==='progress'&&event.preview?.summary_zh)firstReadable??=elapsed;
          if(event.type==='complete'){evidence.complete_ms=elapsed;if(event.record?.recognized_text||event.record?.result?.summary_zh)firstReadable??=elapsed;}
          if(event.type==='error')evidence.error_event_ms=elapsed;
          evidence.accepted_ms=accepted;evidence.first_readable_ms=firstReadable;
        });}catch(error){error.smokeEvidence=safeModelEvidence(evidence);throw error;}
        const completed=Math.round(performance.now()-started);
        try{
          if(kind==='text'){const points=[...(record.result?.vocabulary??[]),...(record.result?.grammar??[])];requireThat(record.status==='complete'&&points.length>=1&&points.length<=3&&points.every(p=>p.examples?.length===3),'LIVE_LESSON_INVALID');}
          else requireThat(record.status==='awaiting_review'&&String(record.recognized_text).toUpperCase().replace(/\s+/g,' ').includes('WE LEARN EVERY DAY'),'LIVE_OCR_EXPECTATION_FAILED');
          const readback=await a.cloud.call('records.get',{record_id:rid});requireThat(readback?.status===record.status&&readback.revision===record.revision,'LIVE_READBACK_MISMATCH');
          const usage={};for(const field of ['input_tokens','output_tokens','total_tokens'])if(Number.isFinite(record.usage?.[field]))usage[field]=record.usage[field];
          return {accepted_ms:accepted,first_readable_ms:firstReadable,complete_ms:completed,usage,model:typeof record.model==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/.test(record.model)?record.model:'unknown',requests:1};
        }catch(error){error.smokeEvidence=safeModelEvidence(evidence);throw error;}
      });
    }
    report.passed=true;
  }catch(error){report.error=safeCode(error);}
  finally{
    liveKey='';const failed=[];
    if(admin){
      for(const [recordId,userId] of records){try{owned(userId);await admin.rpc('lingo_cancel',{p_user:userId,p_record:recordId});}catch{/* User deletion below also closes the request ownership. */}}
      for(const path of objects){try{requireThat(created.has(path.split('/')[0]),'QA_CLEANUP_PATH_DENIED');checked(await admin.storage.from('lingo-images').remove([path]),'QA_OBJECT_CLEANUP_FAILED');report.cleanup.objects_removed++;}catch{failed.push({kind:'object',path});}}
      for(const [id,value] of created){try{
        const found=checked(await admin.auth.admin.getUserById(id),'QA_CLEANUP_IDENTITY_READ_FAILED');
        requireThat(found.user?.id===id&&found.user.email===value.email&&found.user.app_metadata?.lingo_smoke_run===runId,'QA_CLEANUP_IDENTITY_MISMATCH');
        checked(await admin.auth.admin.deleteUser(id),'QA_USER_CLEANUP_FAILED');report.cleanup.users_deleted++;
      }catch{failed.push({kind:'user',id});}}
    }
    report.cleanup.passed=failed.length===0;if(failed.length){report.cleanup.remaining=failed;report.passed=false;}
    if(created.size&&report.cleanup.users_deleted!==created.size){report.cleanup.passed=false;report.passed=false;}
  }
  return report;
}

export async function main(args=process.argv.slice(2),{log=console.log,runner=runSmoke}={}){
  const options=parseOptions(args);
  if(!options.run||options.help){log(JSON.stringify({executed:false,usage:'node scripts/cloud-smoke.mjs --run [--live-key-file <explicit-key-file>]',default:'No network, account creation, key reads or model calls without --run.',scope:'Only randomly created QA accounts and synthetic records; never existing owner data.',paid:'--live-key-file adds exactly one text and one synthetic OCR request; no automatic model retries.'}));return 0;}
  const report=await runner(options);log(JSON.stringify(report,null,2));return report.passed?0:1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().then(code=>{process.exitCode=code;},error=>{console.error(JSON.stringify({passed:false,error:safeCode(error)}));process.exitCode=1;});
}
