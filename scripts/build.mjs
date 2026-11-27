import {build} from 'esbuild';
import {build as buildPwa} from 'vite';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicKey,createHash} from 'node:crypto';
import {ROOT,PROJECT_REF,HOSTED_PWA_ORIGIN,publicConfig,selfHostPublicConfig} from './cloud-config.mjs';

export function buildOptions(args){
  const options={profile:'development',extensionKey:null,allowUnconfigured:false};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--allow-unconfigured')options.allowUnconfigured=true;
    else if(args[i]==='--profile'&&['development','store','self-host'].includes(args[i+1]))options.profile=args[++i];
    else if(args[i]==='--extension-key'&&args[i+1]&&!args[i+1].startsWith('--'))options.extensionKey=args[++i];
    else if(args[i]==='--config'&&args[i+1]&&!args[i+1].startsWith('--'))options.configFile=args[++i];
    else if(args[i]==='--out'&&args[i+1]&&!args[i+1].startsWith('--'))options.out=args[++i];
    else throw Error('INVALID_BUILD_ARGUMENT');
  }
  if(options.profile==='self-host'){
    if(options.allowUnconfigured||!options.configFile||!options.extensionKey)throw Error('SELF_HOST_CONFIG_AND_EXTENSION_KEY_REQUIRED');
  }else if(options.configFile||options.out)throw Error('SELF_HOST_PROFILE_REQUIRED');
  return options;
}
export function extensionIdentity(publicKey){
  const key=publicKey.trim();
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(key))throw Error('PUBLIC_SPKI_KEY_REQUIRED');
  const bytes=Buffer.from(key,'base64');
  try{if(createPublicKey({key:bytes,format:'der',type:'spki'}).asymmetricKeyType!=='rsa')throw Error();}catch{throw Error('PUBLIC_SPKI_KEY_REQUIRED');}
  return {key,id:[...createHash('sha256').update(bytes).digest().subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4),97+(b&15))).join('')};
}
export function extensionManifest(source,publicKey=null){
  if(typeof source.version!=='string'||!/^\d+(?:\.\d+){0,3}$/.test(source.version)||source.version.split('.').some(n=>Number(n)>65535||String(Number(n))!==n)||source.version.split('.').every(n=>Number(n)===0))throw Error('INVALID_EXTENSION_VERSION');
  if(source.manifest_version!==3||source.permissions?.includes('nativeMessaging'))throw Error('INVALID_EXTENSION_MANIFEST');
  const manifest={...source};delete manifest.key;
  const identity=publicKey?extensionIdentity(publicKey):null;if(identity)manifest.key=identity.key;
  return {manifest,id:identity?.id??null};
}
function copyAssets(source,destination,allowed){
  mkdirSync(destination,{recursive:true});
  for(const entry of readdirSync(source,{withFileTypes:true})){
    const input=join(source,entry.name),output=join(destination,entry.name);
    if(lstatSync(input).isSymbolicLink())throw Error('ASSET_SYMLINK_NOT_ALLOWED');
    if(entry.isDirectory())copyAssets(input,output,allowed);
    else if(allowed(entry.name))copyFileSync(input,output);
  }
}

function readSelfHostConfig(file){
  let value;
  try{value=JSON.parse(readFileSync(resolve(file),'utf8'));}catch{throw Error('SELF_HOST_PUBLIC_CONFIG_UNREADABLE');}
  return selfHostPublicConfig(value);
}

function outputDirectory(projectRef,requested){
  const root=resolve(ROOT);
  const parts=projectRef?['.cache','self-host',projectRef,'dist']:['dist'];
  const out=resolve(root,...parts);
  if((requested&&resolve(requested)!==out)||!out.startsWith(root+sep)||!lstatSync(root).isDirectory())throw Error('UNSAFE_BUILD_PATH');
  let current=root;
  for(const part of parts){
    current=join(current,part);
    const stat=lstatSync(current,{throwIfNoEntry:false});
    if(stat&&!stat.isDirectory())throw Error('UNSAFE_BUILD_PATH');
  }
  if(lstatSync(out,{throwIfNoEntry:false})&&realpathSync(out)!==resolve(realpathSync(root),...parts))throw Error('UNSAFE_BUILD_PATH');
  return out;
}

function writeSelfHostedInformation(pwa,config){
  const hostedEmail='wenbinyin@gmail.com';
  const hostedContact=`<a href="mailto:${hostedEmail}">${hostedEmail}</a>`;
  const contact=config.supportEmail
    ? `<a href="mailto:${config.supportEmail}">${config.supportEmail}</a>`
    : '此实例管理员';
  for(const name of ['privacy.html','support.html']){
    const path=resolve(pwa,name);
    const html=readFileSync(path,'utf8')
      .replaceAll(HOSTED_PWA_ORIGIN,'')
      .replace('本服务由 Lingo Notes 项目维护者管理。','本服务由此实例管理员运营。')
      .replace(`请发邮件至 ${hostedContact}，向管理员申请`,`请联系${hostedContact}，申请`)
      .replace(`申请账号请发邮件至 ${hostedContact}`,`申请账号请联系${hostedContact}`)
      .replace('请通过邮件私下联系','请与管理员私下联系')
      .replaceAll(hostedContact,contact);
    writeFileSync(path,html);
  }
}

export async function main(args=process.argv.slice(2)){
  const options=buildOptions(args),selfHosted=options.profile==='self-host';
  const config=selfHosted?readSelfHostConfig(options.configFile):publicConfig();
  if(!config.publishableKey&&!options.allowUnconfigured)throw Error('SUPABASE_PUBLISHABLE_KEY_REQUIRED');
  const source=JSON.parse(readFileSync(resolve(ROOT,'extension/manifest.json'),'utf8'));
  // Development identity is checked in as a public key. Builds never create or
  // replace it. Store drafts omit key; a store-assigned public key is opt-in.
  let key=null;
  if(options.extensionKey)key=readFileSync(resolve(options.extensionKey),'utf8');
  else if(options.profile==='development')key=readFileSync(resolve(ROOT,'extension/public-key.txt'),'utf8');
  const {manifest,id}=extensionManifest(source,key);
  if(selfHosted){
    if(id===extensionIdentity(readFileSync(resolve(ROOT,'extension/public-key.txt'),'utf8')).id)throw Error('SELF_HOST_IDENTITY_MUST_BE_INDEPENDENT');
    const hostedOrigin=`https://${PROJECT_REF}.supabase.co`;
    const policy=manifest.content_security_policy?.extension_pages;
    if(typeof policy!=='string'||!policy.includes(hostedOrigin))throw Error('REVIEWED_EXTENSION_CSP_REQUIRED');
    manifest.host_permissions=[`${config.url}/*`];
    manifest.content_security_policy={...manifest.content_security_policy,extension_pages:policy.replaceAll(hostedOrigin,config.url)};
  }
  const out=outputDirectory(config.projectRef,options.out);
  rmSync(out,{recursive:true,force:true});
  const extension=resolve(out,'extension'),pwa=resolve(out,'pwa');mkdirSync(extension,{recursive:true});
  writeFileSync(resolve(extension,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  for(const file of ['panel.html','panel.css']){
    const input=resolve(ROOT,'extension',file),output=resolve(extension,file);
    if(selfHosted&&file==='panel.html')writeFileSync(output,readFileSync(input,'utf8').replaceAll(HOSTED_PWA_ORIGIN,config.pwaUrl));
    else copyFileSync(input,output);
  }
  copyAssets(resolve(ROOT,'extension/assets'),resolve(extension,'assets'),name=>/^(?:icon-(?:16|32|48|128)|pronunciation)\.png$/.test(name));
  copyAssets(resolve(ROOT,'extension/assets/ui'),resolve(extension,'assets/ui'),name=>/^(?:search|trash|image|capture)\.svg$|^HEROICONS-LICENSE\.txt$/.test(name));
  copyFileSync(resolve(ROOT,'extension/assets/README.md'),resolve(extension,'assets/THIRD_PARTY_NOTICES.md'));
  const typography=resolve(extension,'assets/typography');mkdirSync(typography,{recursive:true});
  for(const file of ['fonts.css','typography.css'])copyFileSync(resolve(ROOT,'shared/typography',file),resolve(typography,file));
  copyAssets(resolve(ROOT,'shared/typography/fonts'),resolve(typography,'fonts'),name=>/\.woff2$/.test(name));
  copyAssets(resolve(ROOT,'shared/typography/licenses'),resolve(typography,'licenses'),name=>/^[a-z0-9-]+-OFL\.txt$/.test(name));
  // Fold build-time guards in the self-host package so it contains no hosted fallback URL.
  await build({entryPoints:['extension/background.ts','extension/panel.ts'].map(p=>resolve(ROOT,p)),outdir:extension,bundle:true,format:'esm',platform:'browser',target:'chrome116',minifySyntax:selfHosted,define:{__SUPABASE_URL__:JSON.stringify(config.url),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify(config.publishableKey)},logLevel:'warning'});
  await build({entryPoints:[resolve(ROOT,'extension/page.ts')],outfile:resolve(extension,'page.js'),bundle:true,format:'iife',platform:'browser',target:'chrome116',logLevel:'warning'});
  const env={VITE_SUPABASE_URL:config.url,VITE_SUPABASE_PUBLISHABLE_KEY:config.publishableKey,VITE_VAPID_PUBLIC_KEY:config.vapidPublicKey};
  const previous=Object.fromEntries(Object.keys(env).map(name=>[name,process.env[name]]));
  try{
    Object.assign(process.env,env);
    await buildPwa({configFile:resolve(ROOT,'pwa/vite.config.ts'),build:{outDir:pwa,emptyOutDir:true}});
  }finally{
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];
      else process.env[name]=value;
    }
  }
  if(selfHosted)writeSelfHostedInformation(pwa,config);
  const result={version:manifest.version,profile:options.profile,extension_id:id,extension_path:extension,pwa_path:pwa,configured:!!config.publishableKey,built_at:new Date().toISOString(),
    ...(selfHosted?{project_ref:config.projectRef,pwa_url:config.pwaUrl}:{})};
  writeFileSync(resolve(out,'build-info.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
