import webpush from 'npm:web-push@3.6.7';
import { checked,rpc } from './server.ts';
import { fail, sha256 } from './core.mjs';

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
async function ownerSubscription(db: any, userId: string) {
  return checked<any>(await db.from('lingo_push_subscriptions').select('subscription').eq('user_id',userId).maybeSingle());
}

function deviceFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_PUSH_DEVICE');
  return value;
}

async function matchesDevice(value: any, fingerprint: string) {
  const {endpoint, keys} = subscriptionInput(value);
  const canonical = [endpoint, keys.p256dh.replace(/=+$/, ''), keys.auth.replace(/=+$/, '')];
  return await sha256(JSON.stringify(canonical)) === fingerprint;
}

export async function pushStatus(db: any, userId: string, candidate: unknown) {
  const fingerprint = candidate === undefined ? null : deviceFingerprint(candidate);
  const subscription = await ownerSubscription(db, userId);
  const device = !subscription ? 'missing' : fingerprint && await matchesDevice(subscription.subscription, fingerprint) ? 'current' : 'other';
  return {device};
}

export async function removePushDevice(db: any, userId: string, endpoint: string | null, candidate: unknown) {
  const fingerprint = deviceFingerprint(candidate);
  const row = await ownerSubscription(db, userId);
  if (!row || row.subscription.endpoint !== endpoint || !await matchesDevice(row.subscription, fingerprint)) {
    fail('PUSH_DEVICE_MISMATCH');
  }
  return await rpc(db, 'lingo_unsubscribe', {p_user:userId, p_endpoint:endpoint, p_subscription:row.subscription});
}

export async function push(db:any,userId:string,batchId:string|null,test=false,candidate?: unknown) {
  const fingerprint = candidate === undefined ? null : deviceFingerprint(candidate);
  const subscription=await ownerSubscription(db,userId);
  if(!subscription)fail('PUSH_SUBSCRIPTION_MISSING');
  // Compare the exact row used for this send. Do not re-read a different
  // primary device after validating the fingerprint.
  if (fingerprint && !await matchesDevice(subscription.subscription, fingerprint)) fail('PUSH_DEVICE_MISMATCH');
  if (fingerprint && test) {
    const settings = checked<any>(await db.from('lingo_settings').select('push_enabled').eq('user_id',userId).maybeSingle());
    if (!settings?.push_enabled) fail('PUSH_NOT_ENABLED');
  }
  const publicKey=Deno.env.get('VAPID_PUBLIC_KEY'),privateKey=Deno.env.get('VAPID_PRIVATE_KEY'),subject=Deno.env.get('VAPID_SUBJECT');
  if(!publicKey||!privateKey||!subject)fail('PUSH_NOT_CONFIGURED');
  try {
    await webpush.sendNotification(subscriptionInput(subscription.subscription),JSON.stringify({kind:test?'test':'review',batch_id:batchId}),{
      vapidDetails:{subject,publicKey,privateKey},TTL:7200,urgency:'normal',timeout:15000
    });
  } catch(error:any) {
    if(error?.statusCode===404||error?.statusCode===410){
      const removed=await rpc(db,'lingo_unsubscribe',{p_user:userId,p_endpoint:subscription.subscription.endpoint,p_subscription:subscription.subscription});
      fail(removed.removed?'PUSH_SUBSCRIPTION_EXPIRED':'PUSH_SUBSCRIPTION_CHANGED');
    }
    if (error?.statusCode === 401 || error?.statusCode === 403) fail('PUSH_PROVIDER_AUTH_FAILED');
    if (error?.statusCode === 429) fail('PUSH_PROVIDER_RATE_LIMITED');
    fail('PUSH_SEND_FAILED');
  }
  return {accepted:true,delivered:false};
}
