import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {png} from './png-fixture.mjs';
import {backupCloud,loadBackup,hash} from '../scripts/cloud-backup.mjs';
import {restoreCloud} from '../scripts/cloud-restore.mjs';

const PASSWORD='test-only-backup-passphrase-2026';
const readSql=name=>readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
async function database(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user_id',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(name text,bucket_id text,created_at timestamptz default now());
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text,name text unique);create view vault.decrypted_secrets as select id,secret as decrypted_secret,name from vault.secrets;
    create function vault.create_secret(value text,name text) returns uuid language sql as $$insert into vault.secrets(secret,name) values(value,name) returning id$$;
    create function vault.update_secret(sid uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=sid$$;`);
  await db.exec(readSql('202611190001_lingo_cloud.sql').replace('create extension if not exists supabase_vault with schema vault;',''));
  await db.exec(readSql('202611190002_lingo_backup.sql'));
  await db.exec(readSql('202611190003_explanation_mode.sql'));
  await db.exec(readSql('202611200004_font_preferences.sql'));
  return db;
}
function temp(t){const directory=mkdtempSync(join(tmpdir(),'lingo-backup-test-'));t.after(()=>{
  const root=resolve(directory);assert.ok(root.startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('lingo-backup-test-'));
  rmSync(root,{recursive:true,force:true});
});return directory;}
async function count(db,table){return Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);}
function client(db,files=new Map()){
  const stats={uploads:0,reads:0,snapshots:0};
  return {files,stats,async rpc(name,p={}){
    try{
      let rows;
      if(name==='lingo_backup_snapshot'){stats.snapshots++;rows=(await db.query('select public.lingo_backup_snapshot() as value')).rows;}
      else if(name==='lingo_restore_check')rows=(await db.query('select public.lingo_restore_check(array(select jsonb_array_elements_text($1::jsonb)::uuid)) as value',[JSON.stringify(p.p_users)])).rows;
      else if(name==='lingo_restore_empty')rows=(await db.query('select public.lingo_restore_empty($1::jsonb) as value',[JSON.stringify(p.p_snapshot)])).rows;
      else throw Error('UNKNOWN_TEST_RPC');
      return {data:rows[0].value,error:null};
    }catch(error){return {data:null,error};}
  },storage:{from(bucket){assert.equal(bucket,'lingo-images');return {
    async download(path){stats.reads++;return files.has(path)?{data:new Blob([files.get(path)]),error:null}:{data:null,error:Error('MISSING_OBJECT')};},
    async upload(path,bytes,options){stats.uploads++;assert.equal(options.upsert,false);if(files.has(path))return {data:null,error:Error('EXISTS')};files.set(path,Buffer.from(bytes));await db.query('insert into storage.objects(name,bucket_id) values($1,$2)',[path,bucket]);return {data:{path},error:null};}
  };}}};
}
async function seed(db,files,{images=1}={}){
  const user=randomUUID(),recordIDs=[],created='2026-11-19T01:00:00.000Z';
  await db.query('insert into auth.users(id,email) values($1,$2)',[user,'synthetic@example.test']);
  await db.query("insert into lingo_settings(user_id,review_enabled,push_enabled,email_enabled,explanation_mode,font_theme) values($1,true,true,false,'fast','bookish')",[user]);
  await db.query('insert into lingo_push_subscriptions(user_id,subscription) values($1,$2)',[user,JSON.stringify({endpoint:'https://web.push.apple.com/synthetic-sensitive-endpoint',keys:{auth:'synthetic-auth'}})]);
  await db.query('select public.lingo_key_set($1,$2)',[user,'sk-'+ 'a'.repeat(32)]);
  for(let i=0;i<images;i++){
    const id=randomUUID(),request=randomUUID(),card=randomUUID(),batch=randomUUID(),bytes=png(8+i,8),path=`${user}/${id}/${request}.png`;
    const metadata={path,sha256:hash(bytes),byte_size:bytes.length,width:8+i,height:8,mime_type:'image/png'};
    const payload={record_id:id,request_id:request,revision:1,status:'processing',local_date:'2026-11-19',input_type:'image',original_text:'private learning content',image:metadata,result:null};
    await db.query('insert into lingo_records(id,user_id,created_at,local_date,payload,image_path) values($1,$2,$3,$4,$5,$6)',[id,user,created,'2026-11-19',JSON.stringify(payload),path]);
    await db.query('insert into lingo_requests(user_id,id,record_id,action,input_hash,status,deadline) values($1,$2,$3,$4,$5,$6,$7)',[user,request,id,'learning.recognize','synthetic-hash',i===0?'processing':'complete','2026-11-20T00:00:00Z']);
    await db.query('insert into lingo_cards(id,user_id,record_id,slot,local_date,payload) values($1,$2,$3,0,$4,$5)',[card,user,id,'2026-11-19',JSON.stringify({id:card,term:'learn'})]);
    await db.query('insert into lingo_review_batches(id,user_id,local_date) values($1,$2,$3)',[batch,user,`2026-11-${String(18-i).padStart(2,'0')}`]);
    await db.query('insert into lingo_review_items(batch_id,card_id,user_id,position) values($1,$2,$3,1)',[batch,card,user]);
    await db.query('insert into lingo_deliveries(batch_id,user_id,channel,status,claim_token) values($1,$2,$3,$4,$5)',[batch,user,'push','sending',randomUUID()]);
    files.set(path,bytes);await db.query('insert into storage.objects(name,bucket_id) values($1,$2)',[path,'lingo-images']);recordIDs.push(id);
  }
  return {user,recordIDs};
}
test('encrypted backup is complete only after all objects verify; excludes keys/subscriptions',async t=>{
  const db=await database(t),files=new Map(),seeded=await seed(db,files),cloud=client(db,files),directory=join(temp(t),'backup');
  const receipt=await backupCloud({client:cloud,directory,passphrase:PASSWORD});assert.equal(receipt.complete,true);assert.equal(cloud.stats.snapshots,1);
  const publicHeader=readFileSync(join(directory,'backup.json'),'utf8');assert.equal(publicHeader.includes('private learning'),false);assert.equal(publicHeader.includes(seeded.user),false);
  const loaded=loadBackup(directory,PASSWORD),json=JSON.stringify(loaded.snapshot);
  assert.equal(json.includes('sk-'+ 'a'.repeat(32)),false);assert.equal(json.includes('synthetic-sensitive-endpoint'),false);assert.equal(json.includes('synthetic-auth'),false);assert.equal(loaded.snapshot.tables.lingo_deliveries[0].claim_token,null);loaded.key.fill(0);
  assert.throws(()=>loadBackup(directory,'wrong-password-at-least-16'),/BACKUP_AUTHENTICATION_FAILED/);
});
test('tampered or missing encrypted image is rejected before target writes',async t=>{
  const source=await database(t),files=new Map(),{user}=await seed(source,files),directory=join(temp(t),'backup');
  await backupCloud({client:client(source,files),directory,passphrase:PASSWORD});
  const target=await database(t);await target.query('insert into auth.users(id) values($1)',[user]);const dest=client(target);
  const loaded=loadBackup(directory,PASSWORD),file=join(directory,loaded.manifest.images[0].file);loaded.key.fill(0);
  const original=readFileSync(file),bad=Buffer.from(original);bad[bad.length-1]^=1;writeFileSync(file,bad);
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/BACKUP_AUTHENTICATION_FAILED/);assert.equal(dest.stats.uploads,0);
  writeFileSync(file,original);unlinkSync(file);
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/BACKUP_FILE_MISSING/);assert.equal(dest.stats.uploads,0);assert.equal(await count(target,'lingo_records'),0);
});
test('source screenshot loss leaves writing state, never a complete backup',async t=>{
  const db=await database(t),files=new Map();await seed(db,files);files.clear();const directory=join(temp(t),'backup');
  await assert.rejects(backupCloud({client:client(db,files),directory,passphrase:PASSWORD}),/BACKUP_IMAGE_DOWNLOAD_FAILED/);
  assert.equal(JSON.parse(readFileSync(join(directory,'backup.json'),'utf8')).state,'writing');assert.equal(existsSync(join(directory,'manifest.enc')),false);
});
test('restore refuses nonempty app, nonempty bucket, or missing Auth identity',async t=>{
  const source=await database(t),files=new Map(),{user}=await seed(source,files),directory=join(temp(t),'backup');await backupCloud({client:client(source,files),directory,passphrase:PASSWORD});
  const target=await database(t),dest=client(target);
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/RESTORE_AUTH_USER_MISSING/);
  await target.query('insert into auth.users(id) values($1)',[user]);await target.query('insert into lingo_settings(user_id) values($1)',[user]);
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/RESTORE_TARGET_NOT_EMPTY/);
  await target.query('delete from lingo_settings');await target.query("insert into storage.objects(name,bucket_id) values('unrelated','lingo-images')");
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/RESTORE_BUCKET_NOT_EMPTY/);assert.equal(dest.stats.uploads,0);
});
test('restore preserves IDs/images but disables reminders and interrupts all in-flight work',async t=>{
  const source=await database(t),files=new Map(),{user,recordIDs}=await seed(source,files),directory=join(temp(t),'backup');await backupCloud({client:client(source,files),directory,passphrase:PASSWORD});
  const target=await database(t);await target.query('insert into auth.users(id) values($1)',[user]);const dest=client(target);
  const receipt=await restoreCloud({client:dest,directory,passphrase:PASSWORD});assert.equal(receipt.complete,true);assert.equal(receipt.keys_restored,false);
  const record=(await target.query('select * from lingo_records')).rows[0];assert.equal(record.id,recordIDs[0]);assert.equal(new Date(record.local_date).toISOString().slice(0,10),'2026-11-19');assert.equal(record.payload.status,'interrupted');assert.equal(record.payload.error,'RESTORED_REQUEST_NOT_RESUMED');
  assert.equal((await target.query('select status from lingo_requests')).rows[0].status,'interrupted');
  const settings=(await target.query('select * from lingo_settings')).rows[0];assert.equal(settings.review_enabled,false);assert.equal(settings.push_enabled,false);assert.equal(settings.email_enabled,false);assert.equal(settings.font_theme,'bookish');
  assert.equal((await target.query('select status from lingo_deliveries')).rows[0].status,'disabled');assert.equal(await count(target,'lingo_push_subscriptions'),0);assert.equal(await count(target,'lingo_private.user_keys'),0);
  assert.equal(hash(dest.files.get(record.image_path)),record.payload.image.sha256);
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),/RESTORE_TARGET_NOT_EMPTY/);
});
test('existing cloud backups without font preference restore as clean and cannot revive email reminders',async t=>{
  const source=await database(t),files=new Map(),{user,recordIDs}=await seed(source,files);
  const snapshot=(await client(source,files).rpc('lingo_backup_snapshot')).data;
  delete snapshot.tables.lingo_settings[0].font_theme;snapshot.tables.lingo_settings[0].email_enabled=true;
  const email={...snapshot.tables.lingo_deliveries[0],channel:'email',status:'accepted',accepted_at:'2026-11-19T01:00:00.000Z'};
  snapshot.tables.lingo_deliveries.push(email);
  const target=await database(t);await target.query('insert into auth.users(id) values($1)',[user]);
  for(const path of files.keys())await target.query('insert into storage.objects(name,bucket_id) values($1,$2)',[path,'lingo-images']);
  const result=(await target.query('select public.lingo_restore_empty($1) as value',[JSON.stringify(snapshot)])).rows[0].value;
  assert.equal(result.restored,true);assert.equal(result.record_count,recordIDs.length);
  const settings=(await target.query('select * from lingo_settings')).rows[0];
  assert.equal(settings.font_theme,'clean');assert.equal(settings.email_enabled,false);assert.equal(settings.review_enabled,false);assert.equal(settings.push_enabled,false);
  assert.equal((await target.query('select id from lingo_records')).rows[0].id,recordIDs[0]);
  const audit=(await target.query("select status,accepted_at from lingo_deliveries where channel='email'")).rows[0];
  assert.equal(audit.status,'accepted');assert.equal(new Date(audit.accepted_at).toISOString(),email.accepted_at);
  assert.equal((await target.query("select public.lingo_claim_delivery($1,'email') as value",[email.batch_id])).rows[0].value,null);
});
test('mid-upload restore failure is explicitly partial and does not insert database rows',async t=>{
  const source=await database(t),files=new Map(),{user}=await seed(source,files,{images:2}),directory=join(temp(t),'backup');await backupCloud({client:client(source,files),directory,passphrase:PASSWORD});
  const target=await database(t);await target.query('insert into auth.users(id) values($1)',[user]);const dest=client(target),original=dest.storage.from;
  dest.storage.from=bucket=>{const storage=original(bucket);return {...storage,async upload(...args){if(dest.stats.uploads===1)return {error:Error('SIMULATED_FAILURE')};return storage.upload(...args);}};};
  await assert.rejects(restoreCloud({client:dest,directory,passphrase:PASSWORD}),error=>error.message==='RESTORE_IMAGE_UPLOAD_FAILED'&&error.uploaded_images===1&&error.complete===false);
  assert.equal(await count(target,'lingo_records'),0);assert.equal(dest.files.size,1);
});
test('restore transaction rolls back cross-owner references; browser roles cannot invoke backup RPCs',async t=>{
  const source=await database(t),files=new Map(),{user}=await seed(source,files),snapshot=(await client(source,files).rpc('lingo_backup_snapshot')).data;
  const target=await database(t),other=randomUUID();await target.query('insert into auth.users(id) values($1),($2)',[user,other]);
  for(const path of files.keys())await target.query('insert into storage.objects(name,bucket_id) values($1,$2)',[path,'lingo-images']);
  snapshot.tables.lingo_cards[0].user_id=other;
  await assert.rejects(target.query('select public.lingo_restore_empty($1)',[JSON.stringify(snapshot)]),/BACKUP_OWNERSHIP_MISMATCH/);assert.equal(await count(target,'lingo_records'),0);
  await target.exec('set role authenticated');
  await assert.rejects(target.query('select public.lingo_backup_snapshot()'),/permission denied/);
  await assert.rejects(target.query('select public.lingo_restore_empty($1)',[JSON.stringify(snapshot)]),/permission denied/);await target.exec('reset role');
});
