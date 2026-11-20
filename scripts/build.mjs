import {build} from 'esbuild';
import {build as buildPwa} from 'vite';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPublicKey,createHash} from 'node:crypto';
import {ROOT,publicConfig} from './cloud-config.mjs';

export function buildOptions(args){
  const options={profile:'development',extensionKey:null,allowUnconfigured:false};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--allow-unconfigured')options.allowUnconfigured=true;
    else if(args[i]==='--profile'&&['development','store'].includes(args[i+1]))options.profile=args[++i];
    else if(args[i]==='--extension-key'&&args[i+1]&&!args[i+1].startsWith('--'))options.extensionKey=args[++i];
    else throw Error('INVALID_BUILD_ARGUMENT');
  }
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
export async function main(args=process.argv.slice(2)){
  const options=buildOptions(args),config=publicConfig();
  if(!config.publishableKey&&!options.allowUnconfigured)throw Error('SUPABASE_PUBLISHABLE_KEY_REQUIRED');
  const source=JSON.parse(readFileSync(resolve(ROOT,'extension/manifest.json'),'utf8'));
  // Development identity is checked in as a public key. Builds never create or
  // replace it. Store drafts omit key; a store-assigned public key is opt-in.
  let key=null;
  if(options.extensionKey)key=readFileSync(resolve(options.extensionKey),'utf8');
  else if(options.profile==='development')key=readFileSync(resolve(ROOT,'extension/public-key.txt'),'utf8');
  const {manifest,id}=extensionManifest(source,key);
  const out=resolve(ROOT,'dist');
  if(!out.startsWith(resolve(ROOT)+sep)||out===resolve(ROOT)||lstatSync(ROOT).isSymbolicLink())throw Error('UNSAFE_BUILD_PATH');
  rmSync(out,{recursive:true,force:true});
  const extension=resolve(out,'extension');mkdirSync(extension,{recursive:true});
  writeFileSync(resolve(extension,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  for(const file of ['panel.html','panel.css'])copyFileSync(resolve(ROOT,'extension',file),resolve(extension,file));
  copyAssets(resolve(ROOT,'extension/assets'),resolve(extension,'assets'),name=>/^(?:icon-(?:16|32|48|128)|pronunciation)\.png$/.test(name));
  copyFileSync(resolve(ROOT,'extension/assets/README.md'),resolve(extension,'assets/THIRD_PARTY_NOTICES.md'));
  const typography=resolve(extension,'assets/typography');mkdirSync(typography,{recursive:true});
  for(const file of ['fonts.css','typography.css'])copyFileSync(resolve(ROOT,'shared/typography',file),resolve(typography,file));
  copyAssets(resolve(ROOT,'shared/typography/fonts'),resolve(typography,'fonts'),name=>/\.woff2$/.test(name));
  copyAssets(resolve(ROOT,'shared/typography/licenses'),resolve(typography,'licenses'),name=>/^[a-z0-9-]+-OFL\.txt$/.test(name));
  await build({entryPoints:['extension/background.ts','extension/panel.ts'].map(p=>resolve(ROOT,p)),outdir:extension,bundle:true,format:'esm',platform:'browser',target:'chrome116',define:{__SUPABASE_URL__:JSON.stringify(config.url),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify(config.publishableKey)},logLevel:'warning'});
  await build({entryPoints:[resolve(ROOT,'extension/page.ts')],outfile:resolve(extension,'page.js'),bundle:true,format:'iife',platform:'browser',target:'chrome116',logLevel:'warning'});
  process.env.VITE_SUPABASE_URL=config.url;process.env.VITE_SUPABASE_PUBLISHABLE_KEY=config.publishableKey;process.env.VITE_VAPID_PUBLIC_KEY=config.vapidPublicKey;
  await buildPwa({configFile:resolve(ROOT,'pwa/vite.config.ts'),build:{outDir:resolve(out,'pwa'),emptyOutDir:true}});
  const result={version:manifest.version,profile:options.profile,extension_id:id,extension_path:extension,pwa_path:resolve(out,'pwa'),configured:!!config.publishableKey,built_at:new Date().toISOString()};
  writeFileSync(resolve(out,'build-info.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
