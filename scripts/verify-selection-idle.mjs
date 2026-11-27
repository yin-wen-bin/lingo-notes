/* Real MV3 idle acceptance fixture. Never uses the user's profile or a production API.
 * Native sidebar/context-menu actions belong to the operator; this runner does not
 * fake Chrome APIs and keeps no debugger attached while the browser is idle. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,cp,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SYNTHETIC='https://selection-idle.example';
const SESSION_KEY='lingo-session:'+SYNTHETIC;
const OWNER='synthetic-idle-account';
const textOne='Small synthetic steps make a difference.';
const textTwo='A second synthetic discovery starts after the idle period.';
const sha=value=>createHash('sha256').update(value).digest('hex');
const utc=()=>new Date().toISOString();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const args=process.argv.slice(2),mode=args.shift()??'start';
const option=(name,fallback)=>{const index=args.indexOf(name);return index>=0?args[index+1]:fallback;};
const run=option('--run',new Date().toISOString().replace(/\D/g,'').slice(0,14));
assert.match(run,/^[a-zA-Z0-9_-]{1,60}$/);
const runRoot=path.resolve(ROOT,'.cache/selection-idle',run),metadataPath=path.join(runRoot,'run.json');
assert.ok(runRoot.startsWith(path.resolve(ROOT,'.cache/selection-idle')+path.sep));

async function cdp(websocketUrl,method,params={}){
  const socket=new WebSocket(websocketUrl),id=1;
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('TEST_CDP_CONNECT_FAILED')),{once:true});});
  try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('TEST_CDP_TIMEOUT')),10000);
    socket.addEventListener('message',event=>{let message;try{message=JSON.parse(String(event.data));}catch{return;}if(message.id!==id)return;clearTimeout(timer);message.error?reject(Error('TEST_CDP_COMMAND_FAILED')):resolve(message.result);});
    socket.send(JSON.stringify({id,method,params}));
  });}finally{
    socket.close();
    await Promise.race([new Promise(resolve=>socket.addEventListener('close',resolve,{once:true})),sleep(1000)]);
  }
}
async function targets(meta){return await (await fetch(`http://127.0.0.1:${meta.debugPort}/json/list`)).json();}
async function seed(meta){
  let worker;
  for(let attempt=0;attempt<40;attempt++){
    worker=(await targets(meta)).find(target=>target.type==='service_worker'&&target.url===`chrome-extension://${meta.extensionId}/background.js`);
    if(worker)break;await sleep(250);
  }
  if(!worker)throw Error('REAL_EXTENSION_WORKER_NOT_FOUND');
  const session={access_token:'synthetic-idle-access',refresh_token:'synthetic-idle-refresh',expires_at:Date.now()/1000+1200,user:{id:OWNER,email:'idle@example.test'}};
  const expression=`chrome.storage.local.set(${JSON.stringify({[SESSION_KEY]:JSON.stringify(session)})}).then(()=>({seeded:true}))`;
  const result=await cdp(worker.webSocketDebuggerUrl,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails||result.result?.value?.seeded!==true)throw Error('TEST_SESSION_SEED_FAILED '+JSON.stringify(result));
  return {seeded_at:utc(),debugger_detached:true,session_expires_in_seconds:1200};
}
async function readMeta(){return JSON.parse(await readFile(metadataPath,'utf8'));}
if(mode==='status'){
  const meta=await readMeta();console.log(JSON.stringify(await (await fetch(meta.httpOrigin+'/__harness/status')).json(),null,2));
}else if(mode==='seed'){
  const meta=await readMeta(),result=await seed(meta);console.log(JSON.stringify(result));
}else if(mode==='snapshot'){
  const meta=await readMeta(),found=(await targets(meta)).filter(target=>target.url===`chrome-extension://${meta.extensionId}/panel.html`);
  const results=[];
  for(const target of found){
    const expression=`(()=>({url:location.href,title:document.title,route:[...document.querySelectorAll('header nav button')].filter(node=>node.getAttribute('aria-current')==='page').map(node=>node.id),visibleViews:[...document.querySelectorAll('#learnView,#historyView,#settingsView')].filter(node=>!node.hidden).map(node=>node.id),original:document.querySelector('#recordOriginal')?.textContent,heading:document.querySelector('#recordHeading')?.textContent,queue:document.querySelector('#queueStatus')?.textContent,notice:document.querySelector('#notice')?.textContent,history:[...document.querySelectorAll('.history-text')].map(node=>node.textContent),editor:document.querySelector('#sourceText')?.value}))()`;
    const result=await cdp(target.webSocketDebuggerUrl,'Runtime.evaluate',{expression,returnByValue:true});
    results.push({targetType:target.type,targetId:target.id,state:result.result?.value,error:!!result.exceptionDetails});
  }
  const result={observed_at:utc(),debugger_detached:true,real_panel_targets:results};
  await writeFile(path.join(runRoot,'snapshot-'+Date.now()+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}else if(mode==='stop'){
  const meta=await readMeta();await fetch(meta.httpOrigin+'/__harness/stop',{method:'POST',headers:{'x-harness-token':meta.controlToken}});console.log(JSON.stringify({stopping:true,run}));
}else if(mode==='start'){
  await mkdir(path.dirname(runRoot),{recursive:true});
  await mkdir(runRoot,{recursive:false});
  const records=new Map(),requests=new Map(),events=[],postings=[],unexpected=[],controlToken=randomUUID();
  let authRefreshes=0,profileBrowser,meta,stopping=false;
  const log=(event,extra={})=>{const entry={at:utc(),event,...extra};events.push(entry);console.log(JSON.stringify(entry));return entry;};
  const lesson=text=>({language:'en',explanation_language:'zh',summary_zh:'Synthetic explanation: '+text,vocabulary:[{term:'synthetic',reading:'/sɪnˈθetɪk/',pos:'形容词',meaning:'仅供隔离验收的合成材料',examples:[{text:'This is a synthetic test.',translation:'这是合成测试。'},{text:'Synthetic examples protect private notes.',translation:'合成例句保护私人笔记。'},{text:'We use synthetic data.',translation:'我们使用合成数据。'}]}],grammar:[]});
  const headers=req=>({'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':req.headers.origin??'*','access-control-allow-headers':'authorization, apikey, content-type, accept','access-control-allow-methods':'POST, OPTIONS'});
  const reply=(req,res,value,status=200)=>{res.writeHead(status,headers(req));res.end(JSON.stringify(value));};
  const status=()=>({run,started_at:events[0]?.at,observed_at:utc(),synthetic_only:true,real_chrome_apis:true,runner_keeps_debugger_attached:false,extension_id:meta?.extensionId,http_origin:meta?.httpOrigin,auth_refreshes:authRefreshes,model_post_count:postings.length,unique_request_count:new Set(postings.map(item=>item.request_id)).size,postings,records:[...records.values()].map(record=>({record_id:record.record_id,request_id:record.request_id,text:record.original_text,status:record.status})),events,unexpected});
  async function stop(){
    if(stopping)return;stopping=true;log('stopping');await writeFile(path.join(runRoot,'result.json'),JSON.stringify(status(),null,2));
    try{const version=await (await fetch(`http://127.0.0.1:${meta.debugPort}/json/version`)).json();await cdp(version.webSocketDebuggerUrl,'Browser.close');}catch{}
    server.closeAllConnections();server.close();
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/__harness/status')return reply(req,res,status());
      if(url.pathname==='/__harness/stop'&&req.method==='POST'&&req.headers['x-harness-token']===controlToken){reply(req,res,{stopping:true});setTimeout(()=>void stop(),100);return;}
      if(req.method==='OPTIONS'){res.writeHead(204,headers(req)).end();return;}
      if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
      if(req.method==='GET'&&url.pathname==='/'){
        res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><meta charset="utf-8"><title>Lingo Notes isolated idle acceptance ${run}</title><style>body{font:22px system-ui;padding:48px;max-width:900px;line-height:2}p{padding:20px;border:1px solid #ccc}</style><h1>Lingo Notes isolated idle acceptance</h1><div>Local synthetic page. No production account, key, or notes.</div><p id="before">${textOne}</p><p id="after">${textTwo}</p><p id="queued">Queued synthetic work continues after recovery.</p><div>Run ${run}</div>`);return;
      }
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>500000)throw Error('BODY_TOO_LARGE');}const body=raw?JSON.parse(raw):{};
      if(url.pathname==='/auth/v1/token'){
        authRefreshes++;log('synthetic_auth_refresh');return reply(req,res,{access_token:'synthetic-idle-access',refresh_token:'synthetic-idle-refresh-'+authRefreshes,expires_in:3600,expires_at:Date.now()/1000+3600,user:{id:OWNER,email:'idle@example.test'}});
      }
      if(url.pathname==='/auth/v1/logout')return reply(req,res,{});
      if(url.pathname!=='/functions/v1/app-api'){unexpected.push({at:utc(),path:url.pathname,method:req.method});return reply(req,res,{ok:false,error:'SYNTHETIC_PATH_ONLY'},404);}
      if(req.headers.apikey!=='synthetic-idle-public'||!String(req.headers.authorization??'').startsWith('Bearer synthetic-idle-access'))return reply(req,res,{ok:false,error:'LOGIN_REQUIRED'},401);
      const action=body.action,params=body.params??{};
      if(action==='learning.submit'){
        const requestId=body.request_id;postings.push({at:utc(),request_id:requestId,record_id:params.record_id,text:params.text});log('synthetic_model_post',{request_id:requestId,record_id:params.record_id,text:params.text});
        let record=requests.get(requestId);
        if(!record){record={record_id:params.record_id,request_id:requestId,revision:1,status:'processing',input_type:'text',local_date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),original_text:params.text,context:params.context,context_meta:params.context_meta,source:params.source,explanation_language:params.explanation_language??'zh',result:null};records.set(record.record_id,record);requests.set(requestId,record);}
        res.writeHead(200,{...headers(req),'content-type':'text/event-stream; charset=utf-8'});
        const emit=(type,payload)=>{if(!res.destroyed)res.write(`event: ${type}\ndata: ${JSON.stringify({request_id:requestId,record_id:record.record_id,revision:record.revision,...payload})}\n\n`);};
        emit('accepted',{sequence:1,record});
        if(record.status==='complete'){emit('complete',{sequence:3,record});res.end();return;}
        setTimeout(()=>{record={...record,status:'complete',result:lesson(record.original_text)};records.set(record.record_id,record);requests.set(requestId,record);log('synthetic_record_complete',{record_id:record.record_id,request_id:requestId});emit('complete',{sequence:3,record});res.end();},1500);return;
      }
      let result;
      if(action==='ping')result={protocol:'cloud/5',protocol_version:'lingo-cloud/5'};
      else if(action==='key.status')result={configured:true,last_four:'TEST'};
      else if(action==='settings.get')result={font_theme:'refined',explanation_language:'zh',explanation_mode:'fast',review_daily_limit:5,review_enabled:false,push_enabled:false};
      else if(action==='records.get')result=records.get(params.record_id)??null;
      else if(action==='records.history'){const query=String(params.query??'').toLowerCase(),items=[...records.values()].reverse().filter(record=>(record.original_text+' '+(record.result?.summary_zh??'')).toLowerCase().includes(query)),offset=params.offset??0;result={items:items.slice(offset,offset+30).map(record=>({...record,text:record.original_text})),has_more:offset+30<items.length};}
      else if(action==='review.cards')result={cards:[]};
      else if(action==='telemetry.record')result={saved:true};
      else if(action==='learning.cancel'){const old=records.get(params.record_id);result=old?{...old,status:'cancelled'}:null;if(result)records.set(result.record_id,result);}
      else if(action==='settings.update')result={...params};
      else {unexpected.push({at:utc(),action});return reply(req,res,{ok:false,error:'UNEXPECTED_SYNTHETIC_ACTION'},400);}
      reply(req,res,{ok:true,result});
    }catch{if(!res.headersSent)reply(req,res,{ok:false,error:'SYNTHETIC_FIXTURE_ERROR'},500);else res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const httpOrigin=`http://127.0.0.1:${server.address().port}`,extension=path.join(runRoot,'extension'),profile=path.join(runRoot,'profile');
  await mkdir(extension);await mkdir(profile);
  await cp(path.join(ROOT,'extension/assets'),path.join(extension,'assets'),{recursive:true});
  await Promise.all([cp(path.join(ROOT,'shared/typography'),path.join(extension,'assets/typography'),{recursive:true}),cp(path.join(ROOT,'extension/panel.html'),path.join(extension,'panel.html')),cp(path.join(ROOT,'extension/panel.css'),path.join(extension,'panel.css'))]);
  const transport=`{const nativeFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url);if(url.origin!==${JSON.stringify(SYNTHETIC)})return Promise.reject(new Error('UNEXPECTED_TEST_NETWORK_ORIGIN'));return nativeFetch(${JSON.stringify(httpOrigin)}+url.pathname+url.search,init);};}`;
  const sourceHashes={};
  for(const entry of ['background','panel','page']){
    const result=await build({entryPoints:[path.join(ROOT,'extension',entry+'.ts')],outfile:path.join(extension,entry+'.js'),bundle:true,format:entry==='page'?'iife':'esm',platform:'browser',target:'chrome116',metafile:true,define:{__SUPABASE_URL__:JSON.stringify(SYNTHETIC),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic-idle-public')},...(entry==='panel'?{banner:{js:transport}}:{})});
    for(const filename of Object.keys(result.metafile.inputs)){const full=path.resolve(ROOT,filename);sourceHashes[path.relative(ROOT,full).split(path.sep).join('/')]=sha(await readFile(full));}
  }
  const manifest=JSON.parse(await readFile(path.join(ROOT,'extension/manifest.json'),'utf8')),key=(await readFile(path.join(ROOT,'extension/public-key.txt'),'utf8')).trim();
  const extensionId=[...createHash('sha256').update(Buffer.from(key,'base64')).digest().subarray(0,16)].flatMap(byte=>[byte>>4,byte&15]).map(n=>String.fromCharCode(97+n)).join('');
  manifest.key=key;manifest.host_permissions=[httpOrigin+'/*'];delete manifest.update_url;
  manifest.content_security_policy={extension_pages:`script-src 'self'; object-src 'none'; font-src 'self'; connect-src ${httpOrigin}; img-src 'self' data: blob:`};
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest,null,2));
  for(const filename of ['extension/manifest.json','extension/public-key.txt','extension/panel.html','extension/panel.css'])sourceHashes[filename]=sha(await readFile(path.join(ROOT,filename)));
  const candidates=[option('--browser-path',''),process.env.LINGO_TEST_EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);let executable;
  for(const candidate of candidates)try{await access(candidate);executable=candidate;break;}catch{}
  if(!executable)throw Error('DEDICATED_EDGE_EXECUTABLE_NOT_FOUND');
  meta={run,created_at:utc(),httpOrigin,controlToken,extensionId,profile,extension,sourceHashes,transport_sha256:sha(transport),executable,synthetic_origin:SYNTHETIC,production_source_modified:false,chrome_api_mocks:false,certificate_bypass:false};
  log('fixture_prepared',{run,extension_id:extensionId,http_origin:httpOrigin});
  profileBrowser=spawn(executable,[`--user-data-dir=${profile}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',httpOrigin+'/'],{windowsHide:false,stdio:'ignore'});meta.browser_launcher_pid=profileBrowser.pid;
  let debugFile;
  for(let i=0;i<80;i++){try{debugFile=await readFile(path.join(profile,'DevToolsActivePort'),'utf8');break;}catch{}await sleep(250);}
  if(!debugFile)throw Error('DEDICATED_EDGE_DEBUG_PORT_UNAVAILABLE');
  meta.debugPort=Number(debugFile.split(/\r?\n/)[0]);await writeFile(metadataPath,JSON.stringify(meta,null,2));
  const seeded=await seed(meta);Object.assign(meta,seeded);await writeFile(metadataPath,JSON.stringify(meta,null,2));
  log('session_seeded_debugger_detached',{debug_port:meta.debugPort,source_hashes:sourceHashes});
  console.log(JSON.stringify({ready:true,run,metadata:metadataPath,status_url:httpOrigin+'/__harness/status',fixture_page:httpOrigin+'/',extension_id:extensionId,transport_injected:true,real_chrome_apis:true,debugger_detached:true,instructions:'Use the dedicated Edge window and native context menu to query the first paragraph. After completion leave untouched for 30 wall-clock minutes; do not attach a debugger. Then select the second paragraph and verify exactly one additional POST and visible result.'}));
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}else throw Error('Usage: start|status|seed|snapshot|stop --run <safe name>');
