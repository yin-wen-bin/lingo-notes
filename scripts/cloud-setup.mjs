import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,copyFileSync,constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import webpush from 'web-push';
import {adminClient,cli} from './cloud-admin.mjs';
import {ROOT,PROJECT_REF,publicConfig} from './cloud-config.mjs';

const cache=resolve(ROOT,'.cache');
export const DEVELOPMENT_EXTENSION_ID='gpjdnplnbcghjhajllhpngenbplncgdi';
export function extensionOrigins(storeId=null,verified=false){
  if(storeId!==null&&(!verified||!/^[a-p]{32}$/.test(storeId)))throw Error('VERIFIED_STORE_EXTENSION_ID_REQUIRED');
  return [...new Set([DEVELOPMENT_EXTENSION_ID,...(storeId?[storeId]:[])])].map(id=>'chrome-extension://'+id).join(',');
}
function storedPublic(){const file=resolve(ROOT,'config/cloud.public.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};}
// Operator secrets remain encrypted for this Windows user. No secret in process argv.
function dpapi(value,protect){
  if(process.platform!=='win32')throw Error('WINDOWS_DPAPI_REQUIRED');
  const program=`Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $result=[Security.Cryptography.ProtectedData]::${protect?'Protect':'Unprotect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',program],{input:Buffer.from(value).toString('base64'),encoding:'utf8',windowsHide:true});
  if(child.status!==0)throw Error('OPERATOR_SECRET_STORAGE_FAILED');
  return Buffer.from(child.stdout.trim(),'base64');
}
function savedSecrets(){
  const git=spawnSync('git',['rev-parse','--git-common-dir'],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  const projectRoot=git.status===0?dirname(resolve(ROOT,git.stdout.trim())):ROOT;
  const operator=resolve(projectRoot,'data/cloud-operator',PROJECT_REF);mkdirSync(operator,{recursive:true});
  const path=resolve(operator,'secrets.dpapi'),legacy=resolve(cache,'cloud.secrets.dpapi');
  if(!existsSync(path)&&existsSync(legacy))copyFileSync(legacy,path,constants.COPYFILE_EXCL);
  if(existsSync(path))return JSON.parse(dpapi(readFileSync(path),false).toString('utf8'));
  const remote=cli(['secrets','list',`--remote=${PROJECT_REF}`]);
  if(/VAPID_PRIVATE_KEY|CRON_SECRET/.test(JSON.stringify(remote)))throw Error('RECOVER_OPERATOR_SECRETS_BEFORE_SETUP');
  const keys=webpush.generateVAPIDKeys();
  const value={VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,CRON_SECRET:randomBytes(32).toString('hex')};
  writeFileSync(path,dpapi(Buffer.from(JSON.stringify(value)),true),{mode:0o600});
  return value;
}
async function checked(result){if(result.error)throw Error(result.error.code||'CLOUD_SETUP_FAILED');return result.data;}
export async function main(args=process.argv.slice(2)){
const action=args[0],option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
mkdirSync(cache,{recursive:true});
if(action==='secrets'){
  const email=option('--email');if(!email||!/^\S+@\S+\.\S+$/.test(email))throw Error('EMAIL_REQUIRED');
  const config=publicConfig(),pwa=option('--pwa-url')||config.pwaUrl;
  if(pwa&&(!pwa.startsWith('https://')||new URL(pwa).origin!==pwa.replace(/\/$/,'')))throw Error('PWA_ORIGIN_REQUIRED');
  const previous=storedPublic(),explicitStore=option('--store-id'),storeId=explicitStore??previous.verifiedStoreExtensionId??null;
  if(args.includes('--store-id-verified')&&!explicitStore)throw Error('VERIFIED_STORE_EXTENSION_ID_REQUIRED');
  const allowedOrigins=extensionOrigins(storeId,explicitStore?args.includes('--store-id-verified'):!!previous.verifiedStoreExtensionId);
  const values={...savedSecrets(),VAPID_SUBJECT:`mailto:${email}`,ALLOWED_ORIGINS:allowedOrigins,...(pwa?{PWA_URL:pwa}:{} )};
  const file=resolve(cache,'deployment-secrets.env');
  try{
    writeFileSync(file,Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
    cli(['secrets','set',`--remote=${PROJECT_REF}`,'--env-file',file,'--yes'],{json:false});
  }finally{rmSync(file,{force:true});}
  writeFileSync(resolve(ROOT,'config/cloud.public.json'),JSON.stringify({...previous,...config,vapidPublicKey:values.VAPID_PUBLIC_KEY,...(storeId?{verifiedStoreExtensionId:storeId}:{}),...(pwa?{pwaUrl:pwa}:{})},null,2)+'\n');
  console.log(JSON.stringify({secrets_configured:true,private_keys_in_output:false,pwa_configured:!!pwa,cron_not_modified:true}));
}else if(action==='cors'){
  const storeId=option('--store-id');if(!storeId)throw Error('VERIFIED_STORE_EXTENSION_ID_REQUIRED');
  const origins=extensionOrigins(storeId,args.includes('--store-id-verified')),file=resolve(cache,'cors-origins.env');
  try{writeFileSync(file,`ALLOWED_ORIGINS=${origins}\n`,{mode:0o600});cli(['secrets','set',`--remote=${PROJECT_REF}`,'--env-file',file,'--yes'],{json:false});}
  finally{rmSync(file,{force:true});}
  const config=storedPublic();writeFileSync(resolve(ROOT,'config/cloud.public.json'),JSON.stringify({...config,verifiedStoreExtensionId:storeId},null,2)+'\n');
  console.log(JSON.stringify({cors_configured:true,development_id_preserved:true,store_id:storeId,other_secrets_modified:false}));
}else if(action==='owner'){
  const email=option('--email')?.trim().toLowerCase(),file=option('--key-file');
  if(!email||!/^\S+@\S+\.\S+$/.test(email)||!file)throw Error('EMAIL_AND_KEY_FILE_REQUIRED');
  let key=readFileSync(resolve(file),'utf8').trim();if(!/^sk-[A-Za-z0-9_-]{20,}$/.test(key))throw Error('INVALID_DEEPSEEK_KEY');
  const db=await adminClient();
  const list=await checked(await db.auth.admin.listUsers({page:1,perPage:1000}));
  let user=list.users.find(u=>u.email?.toLowerCase()===email),created=false;
  if(!user){
    if(list.users.length>=3)throw Error('INVITATION_LIMIT_REACHED');
    // Only an explicitly invited email is provisioned by the operator; no public signup.
    const result=await checked(await db.auth.admin.createUser({email,email_confirm:true,user_metadata:{app:'Lingo Notes'}}));
    user=result.user;created=true;
  }
  const status=await checked(await db.rpc('lingo_key_get',{p_user:user.id,p_plain:false}));
  if(!status.configured)await checked(await db.rpc('lingo_key_set',{p_user:user.id,p_key:key}));
  key='';
  await checked(await db.from('lingo_settings').upsert({user_id:user.id},{onConflict:'user_id',ignoreDuplicates:true}));
  const settings=await checked(await db.from('lingo_settings').select('review_enabled').eq('user_id',user.id).single());
  console.log(JSON.stringify({owner_created:created,key_configured:true,review_enabled:settings.review_enabled,password_setup_required:created}));
}else if(action==='setup-link'){
  const email=option('--email')?.trim().toLowerCase(),pwa=publicConfig().pwaUrl;
  if(!email||!pwa?.startsWith('https://'))throw Error('EMAIL_AND_DEPLOYED_PWA_REQUIRED');
  const db=await adminClient(),list=await checked(await db.auth.admin.listUsers({page:1,perPage:1000}));
  const user=list.users.find(u=>u.email?.toLowerCase()===email);if(!user)throw Error('INVITED_USER_NOT_FOUND');
  if(!user.email_confirmed_at)await checked(await db.auth.admin.updateUserById(user.id,{email_confirm:true}));
  const link=await checked(await db.auth.admin.generateLink({type:'recovery',email,options:{redirectTo:pwa}}));
  const url=new URL(pwa);url.hash=new URLSearchParams({token_hash:link.properties.hashed_token,token_type:'recovery'}).toString();
  // An explicitly requested one-time bootstrap credential for the invited user; never saved.
  console.log(JSON.stringify({setup_url:url.href,one_time:true,expires_in_seconds:600,email_sent:false}));
}else if(action==='cron-enable'){
  if(!args.includes('--device-received'))throw Error('REAL_DEVICE_RECEIPT_REQUIRED');
  const email=option('--email')?.trim().toLowerCase();if(!email)throw Error('EMAIL_REQUIRED');
  const db=await adminClient(),list=await checked(await db.auth.admin.listUsers({page:1,perPage:1000}));
  const user=list.users.find(u=>u.email?.toLowerCase()===email);if(!user)throw Error('INVITED_USER_NOT_FOUND');
  const settings=await checked(await db.from('lingo_settings').select('review_enabled,push_enabled').eq('user_id',user.id).maybeSingle());
  const subscription=await checked(await db.from('lingo_push_subscriptions').select('user_id').eq('user_id',user.id).maybeSingle());
  if(!settings?.push_enabled||!subscription)throw Error('ENABLE_PUSH_FIRST');
  if(!settings.review_enabled&&!args.includes('--enable-review'))throw Error('ENABLE_REVIEW_FIRST');
  const secrets=savedSecrets(), quote=value=>`'${String(value).replaceAll("'","''")}'`;
  const pairs=[['lingo-cron-url',`https://${PROJECT_REF}.supabase.co/functions/v1/review-tick`],['lingo-cron-secret',secrets.CRON_SECRET]];
  const configSql=pairs.map(([name,value])=>`do $$ declare sid uuid; begin select id into sid from vault.secrets where name=${quote(name)}; if sid is null then perform vault.create_secret(${quote(value)},${quote(name)}); else perform vault.update_secret(sid,${quote(value)}); end if; end $$;`).join('\n');
  const file=resolve(cache,'cron-setup.sql');
  try{
    writeFileSync(file,`begin;\n${configSql}\n${readFileSync(resolve(ROOT,'supabase/enable-review-cron.sql'),'utf8')}\ncommit;`,{mode:0o600});
    cli(['db','query',`--remote=${PROJECT_REF}`,'--file',file,'--yes']);
  }finally{rmSync(file,{force:true});}
  writeFileSync(file,"select jobname,schedule,active from cron.job where jobname='lingo-review-five-minutes';");
  try{
    const state=cli(['db','query',`--remote=${PROJECT_REF}`,'--file',file,'--read-only']);
    if(!settings.review_enabled)await checked(await db.from('lingo_settings').update({review_enabled:true,updated_at:new Date().toISOString()}).eq('user_id',user.id));
    const prefs=await checked(await db.from('lingo_settings').select('review_enabled,push_enabled').eq('user_id',user.id).single());
    console.log(JSON.stringify({cron_readback:state,user_settings:prefs,actual_scheduled_delivery:'not_yet_verified'}));
  }finally{rmSync(file,{force:true});}
}else{
  console.log('Usage: node scripts/cloud-setup.mjs secrets --email <owner> [--pwa-url https://...] [--store-id <id> --store-id-verified]; cors --store-id <id> --store-id-verified; owner --email <owner> --key-file <local path>; setup-link --email <invited user>; cron-enable --email <owner> --device-received [--enable-review]');
}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
