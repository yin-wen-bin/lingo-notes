import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const PROJECT_REF='brbymnycnxtfchffanvs';
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
