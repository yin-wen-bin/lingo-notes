import {readFileSync,readdirSync,lstatSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {ROOT} from './cloud-config.mjs';
import {extensionManifest} from './build.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const required=['manifest.json','background.js','panel.js','page.js','panel.html','panel.css','assets/THIRD_PARTY_NOTICES.md',...[16,32,48,128].map(n=>`assets/icon-${n}.png`),'assets/pronunciation.png','assets/typography/fonts.css','assets/typography/typography.css'];
const fonts=['zen-kaku-gothic-new','noto-serif-sc','noto-serif-jp','noto-sans-sc','lxgw-wenkai-screen','lora','literata','klee-one','dm-sans'];
const permitted=path=>required.includes(path)||/^assets\/typography\/fonts\/[a-z0-9-]+\.woff2$/.test(path)||fonts.some(name=>path===`assets/typography/licenses/${name}-OFL.txt`);
export function assertSafeText(text){
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsb_secret_[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{20,}/.test(text))throw Error('SECRET_PATTERN_IN_EXTENSION');
  for(const token of text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)??[]){
    try{if(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).role==='service_role')throw Error('SERVICE_ROLE_TOKEN_IN_EXTENSION');}catch(error){if(error.message==='SERVICE_ROLE_TOKEN_IN_EXTENSION')throw error;}
  }
}
export function inspectExtension(directory){
  const root=resolve(directory),files=[];let total=0;
  if(lstatSync(root).isSymbolicLink())throw Error('PACKAGE_SYMLINK_NOT_ALLOWED');
  function visit(current){for(const entry of readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const absolute=join(current,entry.name),stat=lstatSync(absolute),name=relative(root,absolute).split(sep).join('/');
    if(stat.isSymbolicLink())throw Error('PACKAGE_SYMLINK_NOT_ALLOWED');
    if(entry.isDirectory()){if(!['assets','assets/typography','assets/typography/fonts','assets/typography/licenses'].includes(name))throw Error('UNEXPECTED_PACKAGE_DIRECTORY');visit(absolute);continue;}
    if(!entry.isFile()||!permitted(name))throw Error('UNEXPECTED_PACKAGE_FILE');
    const bytes=readFileSync(absolute);total+=bytes.length;if(total>128*1024*1024)throw Error('EXTENSION_PACKAGE_TOO_LARGE');
    if(/\.(js|css|html|json|txt|md)$/.test(name))assertSafeText(bytes.toString('utf8'));
    files.push({path:name,bytes,sha256:digest(bytes)});
  }}
  visit(root);const names=new Set(files.map(file=>file.path));
  for(const name of [...required,...fonts.map(name=>`assets/typography/licenses/${name}-OFL.txt`)])if(!names.has(name))throw Error('REQUIRED_PACKAGE_FILE_MISSING');
  const manifest=JSON.parse(files.find(file=>file.path==='manifest.json').bytes.toString());extensionManifest(manifest,manifest.key??null);
  const permissions=['activeTab','contextMenus','scripting','sidePanel','storage'];
  if(JSON.stringify([...manifest.permissions].sort())!==JSON.stringify(permissions)||manifest.background?.service_worker!=='background.js'||manifest.side_panel?.default_path!=='panel.html')throw Error('UNREVIEWED_EXTENSION_CAPABILITY');
  if(manifest.host_permissions?.length!==1||!/^https:\/\/[a-z0-9]+\.supabase\.co\/\*$/.test(manifest.host_permissions[0]))throw Error('UNREVIEWED_HOST_PERMISSION');
  const css=files.find(file=>file.path==='assets/typography/fonts.css').bytes.toString();
  let fontReferences=0;
  for(const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)){
    const font=match[1].replace(/^\.\//,'');if(!/^fonts\/[a-z0-9-]+\.woff2$/.test(font)||!names.has('assets/typography/'+font))throw Error('MISSING_OR_REMOTE_FONT');fontReferences++;
  }
  if(!fontReferences)throw Error('FONT_REFERENCES_REQUIRED');
  return {manifest,files,font_files:files.filter(file=>file.path.endsWith('.woff2')).length,font_licenses:fonts.length};
}
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function zipFiles(files){
  if(files.length>65535)throw Error('ZIP64_NOT_SUPPORTED');
  const local=[],central=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.path),data=deflateRawSync(file.bytes),crc=crc32(file.bytes),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(file.bytes.length,22);header.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(file.bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    local.push(header,name,data);central.push(entry,name);offset+=header.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function packageExtension({root=ROOT,out=resolve(root,'artifacts'),allowUnconfigured=false}={}){
  const info=JSON.parse(readFileSync(resolve(root,'dist/build-info.json'),'utf8'));
  if(info.profile!=='store')throw Error('STORE_PROFILE_BUILD_REQUIRED');
  if(!info.configured&&!allowUnconfigured)throw Error('CONFIGURED_STORE_BUILD_REQUIRED');
  const inspected=inspectExtension(resolve(root,'dist/extension'));
  const source=JSON.parse(readFileSync(resolve(root,'extension/manifest.json'),'utf8'));
  if(inspected.manifest.version!==source.version||info.version!==source.version)throw Error('BUILD_VERSION_MISMATCH');
  const zip=zipFiles(inspected.files),sha256=digest(zip),suffix=info.configured?'':'-draft';
  const directory=resolve(out);mkdirSync(directory,{recursive:true});
  const filename=`lingo-notes-${source.version}-store${suffix}.zip`,file=resolve(directory,filename);
  if(existsSync(file)){if(digest(readFileSync(file))!==sha256)throw Error('ARTIFACT_EXISTS_BUMP_VERSION_OR_CHANGE_OUTPUT');}
  else writeFileSync(file,zip,{flag:'wx'});
  const report={version:source.version,profile:'store',configured:!!info.configured,extension_id:info.extension_id??null,zip:filename,bytes:zip.length,sha256,file_count:inspected.files.length,font_files:inspected.font_files,font_licenses:inspected.font_licenses,files:inspected.files.map(({path,bytes,sha256})=>({path,bytes:bytes.length,sha256}))};
  writeFileSync(file+'.sha256',`${sha256}  ${filename}\n`);writeFileSync(file+'.report.json',JSON.stringify(report,null,2)+'\n');
  return {...report,zip:file,files:undefined};
}
export function main(args=process.argv.slice(2)){
  const options={};for(let i=0;i<args.length;i++){
    if(args[i]==='--allow-unconfigured')options.allowUnconfigured=true;
    else if(args[i]==='--out'&&args[i+1]&&!args[i+1].startsWith('--'))options.out=args[++i];
    else throw Error('INVALID_PACKAGE_ARGUMENT');
  }
  const result=packageExtension(options);console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
