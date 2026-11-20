import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildOptions,extensionIdentity,extensionManifest} from '../scripts/build.mjs';
import {packageExtension,inspectExtension,assertSafeText,crc32} from '../scripts/package-extension.mjs';
import {extensionOrigins,DEVELOPMENT_EXTENSION_ID} from '../scripts/cloud-setup.mjs';

const licenseNames=['zen-kaku-gothic-new','noto-serif-sc','noto-serif-jp','noto-sans-sc','lxgw-wenkai-screen','lora','literata','klee-one','dm-sans'];
function fixture(t){
  const root=mkdtempSync(resolve(tmpdir(),'lingo-release-test-'));
  t.after(()=>{assert.ok(root.startsWith(resolve(tmpdir())+sep)&&root.split(sep).at(-1).startsWith('lingo-release-test-'));rmSync(root,{recursive:true,force:true});});
  const write=(name,value)=>{const path=resolve(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const manifest={manifest_version:3,name:'Synthetic release',version:'1.2.3',permissions:['contextMenus','sidePanel','activeTab','scripting','storage'],host_permissions:['https://synthetic.supabase.co/*'],background:{service_worker:'background.js'},side_panel:{default_path:'panel.html'}};
  write('extension/manifest.json',manifest);write('dist/extension/manifest.json',manifest);
  write('dist/build-info.json',{version:manifest.version,profile:'store',configured:false,extension_id:null});
  for(const name of ['background.js','panel.js','page.js','panel.html','panel.css','assets/THIRD_PARTY_NOTICES.md','assets/typography/typography.css'])write('dist/extension/'+name,'synthetic fixture');
  for(const name of ['icon-16','icon-32','icon-48','icon-128','pronunciation'])write('dist/extension/assets/'+name+'.png',Buffer.from([137,80,78,71]));
  write('dist/extension/assets/typography/fonts.css','@font-face { src: url("./fonts/synthetic.woff2"); }');
  write('dist/extension/assets/typography/fonts/synthetic.woff2','synthetic font');
  for(const name of licenseNames)write('dist/extension/assets/typography/licenses/'+name+'-OFL.txt','Synthetic license fixture');
  return {root,manifest,write,extension:resolve(root,'dist/extension')};
}
function unzipLocal(bytes){
  const entries=new Map();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){
    assert.equal(bytes.readUInt16LE(offset+8),8);const size=bytes.readUInt32LE(offset+18),nameSize=bytes.readUInt16LE(offset+26),extraSize=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameSize).toString(),start=offset+30+nameSize+extraSize,data=inflateRawSync(bytes.subarray(start,start+size));
    assert.equal(data.length,bytes.readUInt32LE(offset+22));assert.equal(crc32(data),bytes.readUInt32LE(offset+14));entries.set(name,data);offset=start+size;
  }
  assert.equal(bytes.readUInt32LE(offset),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),entries.size);assert.equal(bytes.readUInt32LE(bytes.length-6),offset);
  return entries;
}

test('build uses manifest version and preserves the checked-in development identity',()=>{
  const publicKey=readFileSync(new URL('../extension/public-key.txt',import.meta.url),'utf8');
  assert.equal(extensionIdentity(publicKey).id,DEVELOPMENT_EXTENSION_ID);
  const source={manifest_version:3,version:'3.4.5',permissions:[],key:'stale'};
  const development=extensionManifest(source,publicKey),draft=extensionManifest(source);
  assert.equal(development.manifest.version,'3.4.5');assert.equal(development.id,DEVELOPMENT_EXTENSION_ID);assert.equal(draft.id,null);assert.equal('key' in draft.manifest,false);assert.equal(source.key,'stale');
  for(const version of [1,'0','01.2','1.2.3.4.5','65536.0'])assert.throws(()=>extensionManifest({...source,version}),/INVALID_EXTENSION_VERSION/);
  assert.deepEqual(buildOptions(['--profile','store','--extension-key','public.txt','--allow-unconfigured']),{profile:'store',extensionKey:'public.txt',allowUnconfigured:true});
  assert.throws(()=>extensionIdentity('-----BEGIN PRIVATE KEY-----'),/PUBLIC_SPKI_KEY_REQUIRED/);
  assert.throws(()=>buildOptions(['--profile','unknown']),/INVALID_BUILD_ARGUMENT/);
});

test('store draft ZIP has root manifest, attribution, all licenses, deterministic hash and valid CRC',t=>{
  const value=fixture(t);assert.throws(()=>packageExtension({root:value.root}),/CONFIGURED_STORE_BUILD_REQUIRED/);
  const report=packageExtension({root:value.root,allowUnconfigured:true}),bytes=readFileSync(report.zip),entries=unzipLocal(bytes);
  assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);assert.equal(report.version,'1.2.3');assert.equal(report.font_files,1);assert.equal(report.font_licenses,9);
  assert.equal(report.sha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(report.zip.endsWith('-store-draft.zip'));
  assert.ok(entries.has('manifest.json'));assert.ok(entries.has('assets/THIRD_PARTY_NOTICES.md'));assert.equal(JSON.parse(entries.get('manifest.json')).version,'1.2.3');
  for(const name of licenseNames)assert.ok(entries.has('assets/typography/licenses/'+name+'-OFL.txt'));
  assert.equal([...entries.keys()].some(name=>/\.ts$|(^|\/)(data|pwa|extension)\//.test(name)),false);
  assert.equal(packageExtension({root:value.root,allowUnconfigured:true}).sha256,report.sha256);
});

test('package blocks unreviewed capabilities, unexpected source and missing runtime font',t=>{
  const value=fixture(t);value.write('dist/extension/debug.ts','export {}');assert.throws(()=>inspectExtension(value.extension),/UNEXPECTED_PACKAGE_FILE/);rmSync(resolve(value.extension,'debug.ts'));
  value.write('dist/extension/manifest.json',{...value.manifest,permissions:[...value.manifest.permissions,'tabs']});assert.throws(()=>inspectExtension(value.extension),/UNREVIEWED_EXTENSION_CAPABILITY/);
  value.write('dist/extension/manifest.json',value.manifest);value.write('dist/extension/assets/typography/fonts.css','@font-face { src: url("https://example.test/font.woff2"); }');assert.throws(()=>inspectExtension(value.extension),/MISSING_OR_REMOTE_FONT/);
});

test('package refuses development profile and version drift',t=>{
  const value=fixture(t);value.write('dist/build-info.json',{version:'1.2.3',profile:'development',configured:true});assert.throws(()=>packageExtension({root:value.root}),/STORE_PROFILE_BUILD_REQUIRED/);
  value.write('dist/build-info.json',{version:'1.2.4',profile:'store',configured:true});assert.throws(()=>packageExtension({root:value.root}),/BUILD_VERSION_MISMATCH/);
});

test('secret checks allow public anon tokens and reject private credentials without echoing them',()=>{
  const token=role=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.synthetic_signature';
  assert.doesNotThrow(()=>assertSafeText(token('anon')));assert.throws(()=>assertSafeText(token('service_role')),/SERVICE_ROLE_TOKEN_IN_EXTENSION/);
  for(const text of ['-----BEGIN PRIVATE KEY-----','sb_secret_'+'x'.repeat(32),'sk-'+'x'.repeat(32)])assert.throws(()=>assertSafeText(text),/SECRET_PATTERN_IN_EXTENSION/);
});

test('CORS store ID is explicit and verified, always preserving development ID',()=>{
  const store='a'.repeat(32);assert.equal(extensionOrigins(),'chrome-extension://'+DEVELOPMENT_EXTENSION_ID);
  assert.throws(()=>extensionOrigins(store),/VERIFIED_STORE_EXTENSION_ID_REQUIRED/);assert.throws(()=>extensionOrigins('z'.repeat(32),true),/VERIFIED_STORE_EXTENSION_ID_REQUIRED/);
  assert.equal(extensionOrigins(store,true),'chrome-extension://'+DEVELOPMENT_EXTENSION_ID+',chrome-extension://'+store);
  assert.equal(extensionOrigins(DEVELOPMENT_EXTENSION_ID,true),'chrome-extension://'+DEVELOPMENT_EXTENSION_ID);
});
