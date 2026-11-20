import {spawnSync} from 'node:child_process';
import {resolve,relative,sep} from 'node:path';
import {mkdtempSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import {ROOT,PROJECT_REF} from './cloud-config.mjs';

export function cli(args,{json=true}={}){
  const cliPath=resolve(ROOT,'node_modules/supabase/dist/supabase.js');
  const flags=json?['--output','json','--output-format','json']:['--output-format','text','--agent','no'];
  // The owner's .env is a directory of private inputs. The CLI assumes a dotenv
  // file and crashes on that directory. Stage only deployable sources; never
  // rename the owner's folder or let it enter a deployment/environment loader.
  const cache=resolve(ROOT,'.cache');mkdirSync(cache,{recursive:true});
  const staged=mkdtempSync(resolve(cache,'supabase-cli-'));
  let result;
  try{
    const source=resolve(ROOT,'supabase');
    cpSync(source,resolve(staged,'supabase'),{recursive:true,filter:path=>!relative(source,path).split(/[\\/]/).some(part=>part==='.temp'||part==='.env'||part.startsWith('.env.')||part==='node_modules')});
    result=spawnSync(process.execPath,[cliPath,...args,...flags],{cwd:staged,encoding:'utf8',timeout:180000,maxBuffer:12*1024*1024,windowsHide:true});
  }finally{
    if(!staged.startsWith(cache+sep)||!staged.split(/[\\/]/).at(-1).startsWith('supabase-cli-'))throw Error('UNSAFE_CLI_TEMP_PATH');
    rmSync(staged,{recursive:true,force:true});
  }
  if(result.status!==0){
    // CLI diagnostics can echo SQL and credentials. Never forward raw output.
    let code='SUPABASE_CLI_FAILED';
    try{const value=JSON.parse(result.stdout);if(/^[A-Za-z0-9_]+$/.test(value.error?.code??''))code=value.error.code;}catch{}
    throw Error(`${code}: ${args.slice(0,2).join(' ')}`);
  }
  if(!json)return result.stdout;
  const text=result.stdout.replace(/\x1b\[[0-9;]*m/g,'').trim();
  try{return JSON.parse(text);}catch{
    const lines=text.split(/\r?\n/).filter(l=>l.startsWith('{')||l.startsWith('['));
    try{return JSON.parse(lines.at(-1));}catch{throw Error('SUPABASE_CLI_JSON_REQUIRED');}
  }
}
function objects(value,out=[]){
  if(value&&typeof value==='object'){out.push(value);for(const child of Object.values(value))objects(child,out);}return out;
}
function role(key){
  if(key?.startsWith('sb_publishable_'))return 'anon';
  if(key?.startsWith('sb_secret_'))return 'service_role';
  try{return JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role;}catch{return null;}
}
export function projectKeys(){
  const result=cli(['projects','api-keys',`--remote=${PROJECT_REF}`,'--reveal']);
  const rows=objects(result),keys=rows.flatMap(r=>[r.api_key,r.key,r.value]).filter(v=>typeof v==='string');
  const publishableKey=keys.find(k=>k.startsWith('sb_publishable_'))??keys.find(k=>role(k)==='anon');
  const secretKey=keys.find(k=>k.startsWith('sb_secret_'))??keys.find(k=>role(k)==='service_role');
  if(!publishableKey||!secretKey)throw Error('PROJECT_API_KEYS_UNAVAILABLE');
  return {url:`https://${PROJECT_REF}.supabase.co`,publishableKey,secretKey};
}
export async function adminClient(){
  const {url,secretKey}=projectKeys();
  return createClient(url,secretKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
}
