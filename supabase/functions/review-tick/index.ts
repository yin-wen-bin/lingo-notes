import {database,rpc,checked,json} from '../_shared/server.ts';
import {push} from '../_shared/notifications.ts';
import {safeError,shanghaiClock} from '../_shared/core.mjs';

export async function handler(request:Request):Promise<Response> {
  if(request.method!=='POST')return json({ok:false,error:'METHOD_NOT_ALLOWED'},{},405);
  const secret=Deno.env.get('CRON_SECRET');
  if(!secret||secret.length<32||request.headers.get('x-cron-secret')!==secret)return json({ok:false,error:'UNAUTHORIZED'},{},401);
  const db=database();
  const clock=shanghaiClock();
  const summary={date:clock.date,batches:0,accepted:0,failed:0,images_cleaned:0,errors:[] as string[]};
  try{
    const paths=await rpc(db,'lingo_cleanup_candidates',{});
    if(paths.length){
      checked(await db.storage.from('lingo-images').remove(paths));
      checked(await db.from('lingo_records').update({image_path:null}).not('deleted_at','is',null).in('image_path',paths));
      summary.images_cleaned=paths.length;
    }
  }catch(error){summary.errors.push(`CLEANUP_${safeError(error)}`);}
  if(clock.hour>=7&&clock.hour<9){
    // Invitation-only first release: process all configured users, with a hard runtime budget.
    const started=Date.now();
    try{
      const users=checked<any[]>(await db.from('lingo_settings').select('user_id').eq('review_enabled',true).order('user_id').limit(100));
      for(const {user_id:userId} of users){
        if(Date.now()-started>105000){summary.errors.push('TICK_TIME_BUDGET');break;}
        try{
          await rpc(db,'lingo_expire',{p_user:userId});
          const batchId=await rpc(db,'lingo_make_batch',{p_user:userId});if(!batchId)continue;
          summary.batches++;
          const claim=await rpc(db,'lingo_claim_delivery',{p_batch:batchId,p_channel:'push'});
          if(!claim)continue;
          let status='accepted',error:string|null=null;
          try{
            // A fresh check reduces the pause/delete race immediately before transmission.
            const settings=checked<any>(await db.from('lingo_settings').select('*').eq('user_id',userId).single());
            const items=checked<any[]>(await db.from('lingo_review_items').select('card_id').eq('batch_id',batchId).eq('user_id',userId).limit(1));
            if(!settings.review_enabled||!settings.push_enabled||!items.length)status='disabled';
            else{await push(db,userId,batchId);summary.accepted++;}
          }catch(e){error=safeError(e);status=['PUSH_SUBSCRIPTION_EXPIRED','PUSH_SUBSCRIPTION_MISSING'].includes(error)?'disabled':'failed';summary.failed++;}
          await rpc(db,'lingo_finish_delivery',{p_batch:batchId,p_channel:'push',p_token:claim.claim_token,p_status:status,p_error:error});
        }catch(error){summary.errors.push(safeError(error));}
      }
    }catch(error){summary.errors.push(safeError(error));}
  }
  // Only counts and safe error codes; no user IDs, material, endpoints or secrets in logs.
  console.log(JSON.stringify({event:'review_tick',...summary}));
  return json({ok:summary.errors.length===0,result:summary},{},summary.errors.length?207:200);
}
Deno.serve(handler);
