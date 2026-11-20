import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TABLES,loadBackup,imageFromBackup,download,assertImage,checkedRpc,safeCode} from './cloud-backup.mjs';

const fail=code=>{throw new Error(code);};
export async function restoreCloud({client,directory,passphrase}){
  const loaded=loadBackup(directory,passphrase);let uploaded=0,commitStarted=false;
  try{
    // Authenticate and checksum every file before sending any plaintext to the cloud.
    for(const image of loaded.manifest.images)imageFromBackup(directory,loaded,image);
    const preflight=await checkedRpc(client,'lingo_restore_check',{p_users:loaded.owners});
    if(preflight?.empty!==true||preflight.users_verified!==loaded.owners.length)fail('RESTORE_PREFLIGHT_FAILED');
    for(const image of loaded.manifest.images){
      const bytes=imageFromBackup(directory,loaded,image);
      const {error}=await client.storage.from('lingo-images').upload(image.path,bytes,{contentType:'image/png',upsert:false});
      if(error)fail('RESTORE_IMAGE_UPLOAD_FAILED');uploaded++;
      assertImage(await download(client,image.path),image);
    }
    commitStarted=true;
    const result=await checkedRpc(client,'lingo_restore_empty',{p_snapshot:loaded.snapshot});
    if(result?.restored!==true||result.record_count!==loaded.snapshot.tables.lingo_records.length)fail('RESTORE_RECEIPT_INVALID');
    const check=await checkedRpc(client,'lingo_backup_snapshot');
    for(const table of TABLES)if(check.tables?.[table]?.length!==loaded.snapshot.tables[table].length)fail('RESTORE_READBACK_FAILED');
    const expected=loaded.snapshot.tables.lingo_records.map(r=>r.id).sort(),actual=check.tables.lingo_records.map(r=>r.id).sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected)||check.tables.lingo_requests.some(r=>r.status==='processing')||check.tables.lingo_settings.some(r=>r.review_enabled||r.push_enabled||r.email_enabled)||check.tables.lingo_deliveries.some(r=>!['accepted','disabled'].includes(r.status)))fail('RESTORE_READBACK_FAILED');
    return {complete:true,records:expected.length,images:uploaded,review_enabled:false,keys_restored:false,subscriptions_restored:false};
  }catch(error){
    const code=safeCode(error);
    throw Object.assign(new Error(commitStarted&&code==='CLOUD_BACKUP_FAILED'?'RESTORE_COMMIT_RESULT_UNKNOWN':code),{complete:false,uploaded_images:uploaded,commit_started:commitStarted});
  }finally{loaded.key.fill(0);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--from')fail('USAGE_CLOUD_RESTORE_FROM_DIRECTORY');
    const {adminClient}=await import('./cloud-admin.mjs');
    console.log(JSON.stringify(await restoreCloud({client:await adminClient(),directory:args[1],passphrase:process.env.LINGO_BACKUP_PASSPHRASE})));
  }catch(error){console.error(JSON.stringify({complete:false,error:safeCode(error),uploaded_images:error.uploaded_images??0,commit_started:error.commit_started??false}));process.exitCode=1;}
}
