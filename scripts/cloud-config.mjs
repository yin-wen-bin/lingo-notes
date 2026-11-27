import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const PROJECT_REF='brbymnycnxtfchffanvs';
export const HOSTED_PWA_ORIGIN='https://lingo-notes.pages.dev';
export function publicConfig(){
  const file=resolve(ROOT,'config/cloud.public.json');
  const stored=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
  const config={url:process.env.SUPABASE_URL||stored.url||`https://${PROJECT_REF}.supabase.co`,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY||stored.publishableKey||'',vapidPublicKey:process.env.VAPID_PUBLIC_KEY||stored.vapidPublicKey||'',pwaUrl:process.env.PWA_URL||stored.pwaUrl||''};
  if(new URL(config.url).hostname!==`${PROJECT_REF}.supabase.co`)throw Error('UNEXPECTED_SUPABASE_PROJECT');
  if(config.publishableKey.startsWith('sb_secret_'))throw Error('SERVER_KEY_IN_PUBLIC_CONFIG');
  if(config.publishableKey.startsWith('eyJ')){
    let payload;try{payload=JSON.parse(Buffer.from(config.publishableKey.split('.')[1],'base64url').toString());}catch{throw Error('INVALID_PUBLIC_KEY');}
    if(payload.role!=='anon')throw Error('SERVER_KEY_IN_PUBLIC_CONFIG');
  }
  return config;
}

function cleanHttpsOrigin(value) {
  let url;
  try { url=new URL(value); } catch { throw Error('INVALID_SELF_HOST_ORIGIN'); }
  if(url.protocol!=='https:'||url.port||![url.origin,url.origin+'/'].includes(value))throw Error('INVALID_SELF_HOST_ORIGIN');
  return url;
}

export function selfHostPublicConfig(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_SELF_HOST_PUBLIC_CONFIG');
  if(Object.keys(value).some(key=>!['url','pwaUrl','publishableKey','vapidPublicKey','supportEmail'].includes(key)))throw Error('INVALID_SELF_HOST_PUBLIC_CONFIG');
  const {publishableKey,vapidPublicKey,supportEmail}=value;
  const upstream=cleanHttpsOrigin(value.url),site=cleanHttpsOrigin(value.pwaUrl);
  const projectRef=/^([a-z0-9]{20})\.supabase\.co$/.exec(upstream.hostname)?.[1];
  if(!projectRef||projectRef===PROJECT_REF||site.origin===HOSTED_PWA_ORIGIN)throw Error('INVALID_SELF_HOST_TARGET');
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pages\.dev$/.test(site.hostname))throw Error('SELF_HOST_PAGES_ORIGIN_REQUIRED');
  if(typeof publishableKey!=='string')throw Error('INVALID_SELF_HOST_PUBLISHABLE_KEY');
  if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)){
    if(!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(publishableKey))throw Error('INVALID_SELF_HOST_PUBLISHABLE_KEY');
    let payload;
    try { payload=JSON.parse(Buffer.from(publishableKey.split('.')[1],'base64url').toString()); } catch { throw Error('INVALID_SELF_HOST_PUBLISHABLE_KEY'); }
    if(payload?.role!=='anon'||(payload.ref!==undefined&&payload.ref!==projectRef))throw Error('INVALID_SELF_HOST_PUBLISHABLE_KEY');
  }
  if(typeof vapidPublicKey!=='string'||!/^[A-Za-z0-9_-]{87}$/.test(vapidPublicKey)||Buffer.from(vapidPublicKey,'base64url')[0]!==4)throw Error('INVALID_SELF_HOST_VAPID_PUBLIC_KEY');
  if(supportEmail!==undefined&&(typeof supportEmail!=='string'||!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(supportEmail)))throw Error('INVALID_SELF_HOST_SUPPORT_EMAIL');
  return {projectRef,url:upstream.origin,pwaUrl:site.origin,publishableKey,vapidPublicKey,supportEmail};
}
