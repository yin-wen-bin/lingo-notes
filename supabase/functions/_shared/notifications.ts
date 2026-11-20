import webpush from 'npm:web-push@3.6.7';
import { checked,rpc } from './server.ts';
import { fail } from './core.mjs';

export function subscriptionInput(value:any) {
  let endpoint:URL;
  try{endpoint=new URL(value?.endpoint);}catch{fail('INVALID_PUSH_SUBSCRIPTION');}
  const host=endpoint!.hostname;
  const validHost=host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com')||host==='web.push.apple.com'||host.endsWith('.push.apple.com');
  if(endpoint!.protocol!=='https:'||endpoint!.username||endpoint!.password||endpoint!.port||!validHost)fail('INVALID_PUSH_SUBSCRIPTION');
  const {p256dh,auth}=value.keys??{};
  if(typeof p256dh!=='string'||!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p256dh)||typeof auth!=='string'||!/^[A-Za-z0-9_-]{20,30}={0,2}$/.test(auth))fail('INVALID_PUSH_SUBSCRIPTION');
  return {endpoint:endpoint!.href,keys:{p256dh,auth},expirationTime:null};
}
export async function push(db:any,userId:string,batchId:string|null,test=false) {
  const subscription=checked<any>(await db.from('lingo_push_subscriptions').select('subscription').eq('user_id',userId).maybeSingle());
  if(!subscription)fail('PUSH_SUBSCRIPTION_MISSING');
  const publicKey=Deno.env.get('VAPID_PUBLIC_KEY'),privateKey=Deno.env.get('VAPID_PRIVATE_KEY'),subject=Deno.env.get('VAPID_SUBJECT');
  if(!publicKey||!privateKey||!subject)fail('PUSH_NOT_CONFIGURED');
  try {
    await webpush.sendNotification(subscriptionInput(subscription.subscription),JSON.stringify({title:'Lingo Notes',body:test?'测试通知已准备好，点击返回学习中心。':'今天的复习卡片已准备好。',batch_id:batchId,tag:batchId?`lingo-${batchId}`:'lingo-test'}),{
      vapidDetails:{subject,publicKey,privateKey},TTL:7200,urgency:'normal',timeout:15000
    });
  } catch(error:any) {
    if(error?.statusCode===404||error?.statusCode===410){
      const removed=await rpc(db,'lingo_unsubscribe',{p_user:userId,p_endpoint:subscription.subscription.endpoint,p_subscription:subscription.subscription});
      fail(removed.removed?'PUSH_SUBSCRIPTION_EXPIRED':'PUSH_SUBSCRIPTION_CHANGED');
    }
    fail('PUSH_SEND_FAILED');
  }
  return {accepted:true,delivered:false};
}
