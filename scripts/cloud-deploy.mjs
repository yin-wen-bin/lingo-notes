import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {cli,projectKeys} from './cloud-admin.mjs';
import {ROOT,PROJECT_REF,publicConfig} from './cloud-config.mjs';
const action=process.argv[2]??'check';
const cache=resolve(ROOT,'.cache');mkdirSync(cache,{recursive:true});
function sql(statement,readOnly=false){
  const file=resolve(cache,'deployment-query.sql');writeFileSync(file,statement);
  return cli(['db','query',`--remote=${PROJECT_REF}`,'--file',file,...(readOnly?['--read-only']:['--yes'])]);
}
if(action==='check'){
  const result=sql("select current_database() as database, count(*) filter(where tablename like 'lingo_%')::int as app_tables from pg_tables where schemaname='public';",true);
  console.log(JSON.stringify({project:PROJECT_REF,check:result}));
}else if(action==='public-config'){
  const {url,publishableKey}=projectKeys(),existing=publicConfig();
  mkdirSync(resolve(ROOT,'config'),{recursive:true});
  writeFileSync(resolve(ROOT,'config/cloud.public.json'),JSON.stringify({...existing,url,publishableKey},null,2)+'\n');
  console.log(JSON.stringify({project:PROJECT_REF,public_config_written:true}));
}else if(action==='schema'){
  // CLI uses a single transaction for each SQL file. Ledger prevents blind re-application.
  const migrations=readdirSync(resolve(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
  sql('create table if not exists public.lingo_deployments(name text primary key, sha256 text not null, applied_at timestamptz not null default now()); alter table public.lingo_deployments enable row level security; revoke all on public.lingo_deployments from public,anon,authenticated;');
  for(const name of migrations){
    const content=readFileSync(resolve(ROOT,'supabase/migrations',name),'utf8'),hash=createHash('sha256').update(content).digest('hex');
    const check=sql(`select name,sha256 from public.lingo_deployments where name='${name.replaceAll("'","''")}';`,true);
    const found=JSON.stringify(check).includes(hash);
    if(found){console.log(JSON.stringify({migration:name,state:'already_applied'}));continue;}
    if(JSON.stringify(check).includes(name))throw Error('APPLIED_MIGRATION_CHANGED');
    sql(`begin;\n${content}\ninsert into public.lingo_deployments(name,sha256) values('${name}','${hash}');\ncommit;`);
    console.log(JSON.stringify({migration:name,state:'applied'}));
  }
}else if(action==='functions'){
  cli(['functions','deploy','app-api','review-tick',`--remote=${PROJECT_REF}`,'--use-api','--yes'],{json:false});
  console.log(JSON.stringify({project:PROJECT_REF,functions_deployed:['app-api','review-tick'],cron_not_modified:true}));
}else if(action==='auth-diff'){
  console.log(cli(['config','diff',`--remote=${PROJECT_REF}`],{json:false}));
}else if(action==='auth-apply'){
  cli(['config','push',`--remote=${PROJECT_REF}`,'--yes'],{json:false});console.log(JSON.stringify({auth_config_applied:true}));
}else throw Error('UNKNOWN_DEPLOY_ACTION');
