import {createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,renameSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOT,PROJECT_REF} from './cloud-config.mjs';

export const BACKUP_FORMAT='lingo-cloud-backup/1';
export const TABLES=['lingo_records','lingo_requests','lingo_settings','lingo_cards','lingo_review_batches','lingo_review_items','lingo_deliveries'];
const MAX_JSON=64*1024*1024,MAX_IMAGE=4*1024*1024;
const MAGIC=Buffer.from('LNENC001');
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const safeCode=error=>/^[A-Z][A-Z0-9_]{2,90}$/.test(error?.message??'')?error.message:'CLOUD_BACKUP_FAILED';
const fail=code=>{throw new Error(code);};
function passphrase(value){if(typeof value!=='string'||value.length<16||value.length>4096)fail('BACKUP_PASSPHRASE_REQUIRED_MIN_16');return value;}
export function deriveKey(value,salt){
  passphrase(value);
  if(!Buffer.isBuffer(salt)||salt.length!==32)fail('INVALID_BACKUP_HEADER');
  return scryptSync(value,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export function encryptObject(key,bytes,aad){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([MAGIC,iv,cipher.getAuthTag(),encrypted]);
}
export function decryptObject(key,bytes,aad){
  if(bytes.length<36||!bytes.subarray(0,8).equals(MAGIC))fail('BACKUP_AUTHENTICATION_FAILED');
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));
    decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(bytes.subarray(20,36));
    return Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]);
  }catch{fail('BACKUP_AUTHENTICATION_FAILED');}
}
function writeExclusive(file,bytes){
  const fd=openSync(file,'wx',0o600);
  try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd);}finally{closeSync(fd);}
}
export function privateFile(root,relative,maxBytes){
  if(relative!=='snapshot.enc'&&relative!=='manifest.enc'&&!/^objects\/[a-f0-9-]{36}\.enc$/.test(relative))fail('INVALID_BACKUP_PATH');
  const base=resolve(root),file=resolve(base,relative);
  if(!file.startsWith(base+sep))fail('INVALID_BACKUP_PATH');
  try{
    if(lstatSync(base).isSymbolicLink()||lstatSync(dirname(file)).isSymbolicLink())fail('INVALID_BACKUP_PATH');
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)fail('INVALID_BACKUP_FILE');
    return readFileSync(file);
  }catch(error){if(error?.code==='ENOENT')fail('BACKUP_FILE_MISSING');throw error;}
}
export function validateSnapshot(snapshot){
  if(snapshot?.format!=='lingo-cloud/1'||!snapshot.tables||typeof snapshot.captured_at!=='string'||!Number.isFinite(Date.parse(snapshot.captured_at)))fail('INVALID_BACKUP_FORMAT');
  if(JSON.stringify(Object.keys(snapshot.tables).sort())!==JSON.stringify([...TABLES].sort()))fail('INVALID_BACKUP_TABLES');
  const owners=new Set(),images=[];
  for(const table of TABLES){
    if(!Array.isArray(snapshot.tables[table]))fail('INVALID_BACKUP_TABLES');
    for(const row of snapshot.tables[table]){if(!ID.test(row.user_id))fail('INVALID_BACKUP_OWNER');owners.add(row.user_id);}
  }
  for(const record of snapshot.tables.lingo_records){
    if(!ID.test(record.id)||record.payload?.record_id!==record.id)fail('INVALID_BACKUP_RECORD');
    if(record.deleted_at){if(record.image_path)fail('DELETED_IMAGE_IN_BACKUP');continue;}
    if(!record.image_path){if(record.payload?.image)fail('BACKUP_IMAGE_REFERENCE_MISMATCH');continue;}
    const image=record.payload?.image;
    if(!image||image.path!==record.image_path||!image.path.startsWith(`${record.user_id}/${record.id}/`)||!new RegExp(`^[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}\\.png$`,'i').test(image.path)||image.mime_type!=='image/png'||!/^[a-f0-9]{64}$/i.test(image.sha256)||!Number.isInteger(image.byte_size)||image.byte_size<1||image.byte_size>MAX_IMAGE)fail('BACKUP_IMAGE_REFERENCE_MISMATCH');
    images.push({path:image.path,sha256:image.sha256.toLowerCase(),byte_size:image.byte_size,mime_type:'image/png'});
  }
  if(new Set(images.map(i=>i.path)).size!==images.length)fail('BACKUP_DUPLICATE_IMAGE_REFERENCE');
  return {owners:[...owners].sort(),images};
}
export function assertImage(bytes,image){
  if(bytes.byteLength!==image.byte_size||hash(bytes)!==image.sha256)fail('BACKUP_IMAGE_CHECKSUM_FAILED');
}
export async function checkedRpc(client,name,params={}){
  const {data,error}=await client.rpc(name,params);if(error)throw new Error(safeCode(error));return data;
}
export async function download(client,path){
  const {data,error}=await client.storage.from('lingo-images').download(path);
  if(error||!data)fail('BACKUP_IMAGE_DOWNLOAD_FAILED');
  if(data.size>MAX_IMAGE)fail('BACKUP_IMAGE_TOO_LARGE');
  return Buffer.from(await data.arrayBuffer());
}

export async function backupCloud({client,directory,passphrase:password,projectRef=PROJECT_REF}){
  passphrase(password);
  const output=resolve(directory),id=randomUUID(),salt=randomBytes(32),key=deriveKey(password,salt);
  mkdirSync(dirname(output),{recursive:true});mkdirSync(output);mkdirSync(join(output,'objects'));
  const header={format:BACKUP_FORMAT,backup_id:id,cipher:'AES-256-GCM',kdf:{name:'scrypt',N:32768,r:8,p:1,salt:salt.toString('base64')},state:'writing'};
  writeExclusive(join(output,'backup.json'),Buffer.from(JSON.stringify(header,null,2)));
  try{
    const snapshot=await checkedRpc(client,'lingo_backup_snapshot');
    const {images}=validateSnapshot(snapshot),snapshotBytes=Buffer.from(JSON.stringify(snapshot));
    if(snapshotBytes.length>MAX_JSON)fail('BACKUP_SNAPSHOT_TOO_LARGE');
    writeExclusive(join(output,'snapshot.enc'),encryptObject(key,snapshotBytes,`${id}:snapshot.enc`));
    const files=[];
    for(const image of images){
      const bytes=await download(client,image.path);assertImage(bytes,image);
      const file=`objects/${randomUUID()}.enc`;
      writeExclusive(join(output,file),encryptObject(key,bytes,`${id}:${file}`));
      files.push({...image,file});
    }
    const manifest={format:BACKUP_FORMAT,backup_id:id,project_ref:projectRef,captured_at:snapshot.captured_at,complete:true,
      snapshot:{file:'snapshot.enc',sha256:hash(snapshotBytes),byte_size:snapshotBytes.length},images:files,
      counts:Object.fromEntries(TABLES.map(t=>[t,snapshot.tables[t].length]))};
    writeExclusive(join(output,'manifest.enc'),encryptObject(key,Buffer.from(JSON.stringify(manifest)),`${id}:manifest.enc`));
    const temp=join(output,'backup.complete.tmp');writeExclusive(temp,Buffer.from(JSON.stringify({...header,state:'complete'},null,2)));renameSync(temp,join(output,'backup.json'));
    return {complete:true,directory:output,records:snapshot.tables.lingo_records.length,images:files.length,captured_at:snapshot.captured_at};
  }catch(error){throw Object.assign(new Error(safeCode(error)),{directory:output,complete:false});}
  finally{key.fill(0);}
}

export function loadBackup(directory,password){
  passphrase(password);let header;
  try{const file=join(resolve(directory),'backup.json'),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10000)fail('INVALID_BACKUP_HEADER');header=JSON.parse(readFileSync(file,'utf8'));}catch(error){if(/^[A-Z_]+$/.test(error.message??''))throw error;fail('INVALID_BACKUP_HEADER');}
  if(header?.format!==BACKUP_FORMAT||header.state!=='complete'||!ID.test(header.backup_id)||header.cipher!=='AES-256-GCM'||header.kdf?.name!=='scrypt'||header.kdf.N!==32768||header.kdf.r!==8||header.kdf.p!==1||typeof header.kdf.salt!=='string')fail('BACKUP_NOT_COMPLETE');
  const key=deriveKey(password,Buffer.from(header.kdf.salt,'base64'));
  try{
    const manifest=JSON.parse(decryptObject(key,privateFile(directory,'manifest.enc',MAX_JSON),`${header.backup_id}:manifest.enc`).toString('utf8'));
    if(manifest?.format!==BACKUP_FORMAT||manifest.backup_id!==header.backup_id||manifest.complete!==true||manifest.snapshot?.file!=='snapshot.enc'||!Array.isArray(manifest.images))fail('INVALID_BACKUP_MANIFEST');
    const bytes=decryptObject(key,privateFile(directory,'snapshot.enc',MAX_JSON+36),`${header.backup_id}:snapshot.enc`);
    if(bytes.length!==manifest.snapshot.byte_size||hash(bytes)!==manifest.snapshot.sha256)fail('BACKUP_SNAPSHOT_CHECKSUM_FAILED');
    const snapshot=JSON.parse(bytes.toString('utf8')),{images,owners}=validateSnapshot(snapshot);
    if(images.length!==manifest.images.length||new Set(manifest.images.map(i=>i.file)).size!==images.length)fail('BACKUP_IMAGE_REFERENCE_MISMATCH');
    for(const image of images){const entry=manifest.images.find(i=>i.path===image.path);if(!entry||entry.sha256!==image.sha256||entry.byte_size!==image.byte_size||entry.mime_type!==image.mime_type)fail('BACKUP_IMAGE_REFERENCE_MISMATCH');}
    for(const table of TABLES)if(manifest.counts?.[table]!==snapshot.tables[table].length)fail('BACKUP_COUNT_MISMATCH');
    return {key,manifest,snapshot,owners};
  }catch(error){key.fill(0);throw new Error(safeCode(error));}
}
export function imageFromBackup(directory,loaded,image){
  const bytes=decryptObject(loaded.key,privateFile(directory,image.file,MAX_IMAGE+36),`${loaded.manifest.backup_id}:${image.file}`);assertImage(bytes,image);return bytes;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--out'))fail('USAGE_CLOUD_BACKUP_OUT_DIRECTORY');
    const password=process.env.LINGO_BACKUP_PASSPHRASE;passphrase(password);
    const {adminClient}=await import('./cloud-admin.mjs');
    const directory=args[1]??join(ROOT,'data','cloud-backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
    console.log(JSON.stringify(await backupCloud({client:await adminClient(),directory,passphrase:password})));
  }catch(error){console.error(JSON.stringify({complete:false,error:safeCode(error)}));process.exitCode=1;}
}
