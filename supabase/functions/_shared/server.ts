import { createClient } from 'npm:@supabase/supabase-js@2';
import { safeError, fail } from './core.mjs';

export function database() {
  const url=Deno.env.get('SUPABASE_URL');
  const key=Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) fail('SERVER_NOT_CONFIGURED');
  return createClient(url!,key!,{auth:{persistSession:false,autoRefreshToken:false}});
}
export async function rpc(db:any,name:string,params:any) {
  const {data,error}=await db.rpc(name,params);
  if(error) throw new Error(safeError(error));
  return data;
}
export function checked<T=any>(response:{data:T|null,error:any}):T {
  if(response.error) throw new Error(safeError(response.error));
  return response.data as T;
}
export async function ownedRecord(db:any,userId:string,id:string,includeDeleted=false):Promise<any> {
  let query=db.from('lingo_records').select('*').eq('user_id',userId).eq('id',id);
  if(!includeDeleted)query=query.is('deleted_at',null);
  return checked(await query.maybeSingle());
}
export function cors(request:Request) {
  const origin=request.headers.get('origin');
  const allowed=(Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(v=>v.trim()).filter(Boolean);
  const pwa=Deno.env.get('PWA_URL');
  if(pwa)allowed.push(new URL(pwa).origin);
  if(origin && !allowed.includes(origin)) fail('ORIGIN_NOT_ALLOWED');
  return {
    ...(origin?{'Access-Control-Allow-Origin':origin}:{}),
    'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods':'POST, OPTIONS',
    'Access-Control-Max-Age':'3600','Vary':'Origin','Cache-Control':'no-store'
  };
}
export function json(result:any,headers:Record<string,string>,status=200) {
  return new Response(JSON.stringify(result),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
}
export async function readJson(request:Request) {
  if(!request.body)fail('INVALID_REQUEST');
  if(Number(request.headers.get('content-length')??0)>6_000_000)fail('REQUEST_TOO_LARGE');
  const reader=request.body!.getReader(),decoder=new TextDecoder();let size=0,text='';
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6_000_000){await reader.cancel();fail('REQUEST_TOO_LARGE');}text+=decoder.decode(value,{stream:true});}
    text+=decoder.decode();
  } finally {reader.releaseLock();}
  try{return JSON.parse(text);}catch{fail('INVALID_REQUEST');}
}
export async function batchResult(db:any,userId:string,batchId?:string,date?:string) {
  let query=db.from('lingo_review_batches').select('*').eq('user_id',userId);
  query=batchId?query.eq('id',batchId):query.eq('local_date',date);
  const batch=checked<any>(await query.maybeSingle());
  if(!batch)return {batch:null};
  const items=checked<any[]>(await db.from('lingo_review_items').select('card_id,position').eq('batch_id',batch.id).eq('user_id',userId).order('position'));
  const ids=items.map(i=>i.card_id);
  const cards=ids.length?checked<any[]>(await db.from('lingo_cards').select('id,payload').eq('user_id',userId).in('id',ids)):[];
  const deliveries=checked<any[]>(await db.from('lingo_deliveries').select('channel,status,attempts,accepted_at,last_error').eq('user_id',userId).eq('batch_id',batch.id));
  return {batch:{id:batch.id,local_date:batch.local_date,created_at:batch.created_at,opened_at:batch.opened_at,cards:ids.map(id=>cards.find(c=>c.id===id)?.payload).filter(Boolean),deliveries}};
}
