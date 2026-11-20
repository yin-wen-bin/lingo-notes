// Local presentation assets only. All data are synthetic; no production API is contacted.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'store/assets');
const api='https://store-demo.invalid';
const example=(text,translation)=>({text,translation});
const records=[
  {record_id:'store-demo-en',revision:1,status:'complete',input_type:'text',local_date:'2026-11-20',original_text:'make a difference',context:'Small steps make a difference. Keep learning every day.',source:null,result:{language:'en',summary_zh:'make a difference 表示“产生影响；起作用”。这里强调小小的坚持也能带来改变。',vocabulary:[{term:'make a difference',reading:'/meɪk ə ˈdɪfərəns/',pos:'短语',meaning:'产生影响；起作用。常用来说明某个行动或变化带来的效果。',examples:[example('Small steps make a difference.','小小的行动也能带来改变。'),example('Your help makes a difference.','你的帮助很有用。'),example('A kind word can make a difference.','一句友善的话可能带来改变。')]}],grammar:[]}},
  {record_id:'store-demo-ja',revision:1,status:'complete',input_type:'text',local_date:'2026-11-19',original_text:'少しずつ',context:'毎日、少しずつ練習しています。',source:null,result:{language:'ja',summary_zh:'少しずつ 表示“一点一点地；逐渐地”，强调每次少量、持续进行。',vocabulary:[{term:'少しずつ',reading:'すこしずつ',pos:'副词性表达',meaning:'一点一点地；逐渐地。适合描述缓慢而持续的变化或行动。',examples:[example('毎日、少しずつ練習しています。','每天都在一点一点地练习。'),example('少しずつ日本語がわかるようになりました。','我逐渐能听懂日语了。'),example('少しずつ前に進みましょう。','我们一点一点地向前走吧。')]}],grammar:[]}},
  {record_id:'store-demo-three',revision:1,status:'complete',input_type:'text',local_date:'2026-11-18',original_text:'Take your time.',source:null,result:{language:'en',summary_zh:'慢慢来，不用着急。',vocabulary:[],grammar:[]}},
  {record_id:'store-demo-four',revision:1,status:'complete',input_type:'text',local_date:'2026-11-17',original_text:'新しい発見',source:null,result:{language:'ja',summary_zh:'新的发现。',vocabulary:[],grammar:[]}}
];
const scenes=[
  {file:'01-english-notes.png',kind:'english',record:'store-demo-en',eyebrow:'英文阅读 · 中文讲解',title:'Small steps,<br>lasting change.',body:'Small steps <mark>make a difference</mark>.<br>Keep learning every day.',caption:'把阅读中的新表达，记成自己的学习笔记。'},
  {file:'02-japanese-notes.png',kind:'japanese',record:'store-demo-ja',eyebrow:'日文阅读 · 假名与例句',title:'毎日、<br>少しずつ。',body:'毎日、<mark>少しずつ</mark><br>練習しています。',caption:'查看中文说明、假名与带译文的日语例句。'},
  {file:'03-history.png',kind:'history',record:'store-demo-en',eyebrow:'学习历史 · 查询与删除',title:'读过的，<br>慢慢记住。',body:'遇到一个表达，记下一条笔记。<br>下次需要时，从历史里找到它。',caption:'历史支持搜索、打开笔记和删除。'},
  {file:'04-image-confirmation.png',kind:'image',record:null,eyebrow:'图片学习 · 确认后发送',title:'先看清，<br>再发送。',body:'先预览图片区域，确认后识别。<br>校正识别文字，再生成讲解。',caption:'这里展示的是选图后的真实确认界面。'}
];
const bundle=await build({absWorkingDir:root,entryPoints:['extension/panel.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'chrome116',define:{__SUPABASE_URL__:JSON.stringify(api),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic-public-not-a-key')}});
const [panelHtml,panelCss]=await Promise.all(['extension/panel.html','extension/panel.css'].map(file=>readFile(path.join(root,file))));
function demoHtml(index){const s=scenes[index]??scenes[0];return `<!doctype html><html lang="zh-CN" data-font-theme="clean"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/typography/typography.css"><style>
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:#FBFDF6;color:#243B32;font-family:var(--font-ui,"Segoe UI",sans-serif)}
.reading-page{width:650px;height:800px;padding:45px 50px 36px;display:flex;flex-direction:column;background:linear-gradient(145deg,#FBFDF6 56%,#e9f4db)}.brand{display:flex;align-items:center;gap:16px;font:600 29px var(--font-ui,sans-serif)}.brand img{width:62px;height:62px}.eyebrow{font-size:17px;color:#436450;margin:45px 0 20px;letter-spacing:1px}h1{font-size:53px;line-height:1.26;font-weight:600;letter-spacing:-1px;margin:0 0 28px}article{font-size:25px;line-height:1.8;border-left:4px solid #D6F494;padding-left:22px}mark{background:#D6F494;color:#243B32;padding:1px 3px}.caption{margin:28px 0 0;font-size:18px;line-height:1.7;color:#42614c}.foot{margin-top:auto;font-size:15px;color:#5b7261;line-height:1.8}.foot strong{font-weight:500;color:#25573F}iframe{position:absolute;left:650px;top:0;width:630px;height:800px;border:0;border-left:1px solid #dce5d9;background:#fff}
</style></head><body><section class="reading-page"><div class="brand"><img src="/assets/icon-128.png" alt=""><span>Lingo Notes</span></div><p class="eyebrow">${s.eyebrow}</p><h1>${s.title}</h1><article lang="${s.kind==='japanese'?'ja':'zh-CN'}">${s.body}</article><p class="caption">${s.caption}</p><p class="foot"><strong>邀请制 · 需自备 DeepSeek API Key</strong><br>合成演示内容 · 实际扩展界面 · 未连接真实服务</p></section><iframe title="Lingo Notes 扩展实际界面" src="/panel.html"></iframe></body></html>`;}
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let body,type;
    if(url.pathname==='/demo'){body=demoHtml(Number(url.searchParams.get('scene')));type='text/html';}
    else if(url.pathname==='/panel.html'){body=panelHtml;type='text/html';}
    else if(url.pathname==='/panel.js'){body=bundle.outputFiles[0].text;type='text/javascript';}
    else if(url.pathname==='/panel.css'){body=panelCss;type='text/css';}
    else if(url.pathname.startsWith('/assets/')){
      const fonts=url.pathname.startsWith('/assets/typography/'),base=path.resolve(root,fonts?'shared/typography':'extension/assets');
      const file=path.resolve(base,decodeURIComponent(url.pathname.slice(fonts?'/assets/typography/'.length:'/assets/'.length)));
      if(!file.startsWith(base+path.sep)){res.writeHead(403).end();return;}
      body=await readFile(file);type=file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream';
    }else{res.writeHead(404).end();return;}
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'}).end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={synthetic:true,productionRequests:0,modelCalls:0,source:'extension/panel.html + panel.css + bundled panel.ts',sourceHashes:{'extension/panel.html':digest(panelHtml),'extension/panel.css':digest(panelCss),'bundled-panel.js':digest(bundle.outputFiles[0].text)},screenshots:[],blockedRequests:[],browserErrors:[],apiActions:[]};
try{
  try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({channel:'msedge',headless:true});}
  await mkdir(path.join(output,'screenshots'),{recursive:true});
  await copyFile(path.join(root,'extension/assets/icon-128.png'),path.join(output,'icon-128.png'));
  const canvasPage=await browser.newPage();
  const imageData=await canvasPage.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=220;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,640,220);x.fillStyle='#25573F';x.font='24px sans-serif';x.fillText('SYNTHETIC READING SAMPLE',30,45);x.fillStyle='#243B32';x.font='32px sans-serif';x.fillText('Small steps make a difference.',30,105);x.font='24px sans-serif';x.fillText('Keep learning every day.',30,155);return c.toDataURL('image/png');});
  await canvasPage.close();
  for(const [index,scene] of scenes.entries()){
    const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,locale:'zh-CN',serviceWorkers:'block'});
    const page=await context.newPage();page.on('pageerror',e=>report.browserErrors.push(e.message));
    await context.addInitScript(({api,record})=>{
      const user='store-demo';
      const stores={local:{['lingo-session:'+api]:JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:user}})},session:{['panel:'+user]:record?{last_record_id:record,panel_state:{view:'record'}}:{panel_state:{view:'compose'}}}};
      const area=name=>({async get(keys){if(!keys)return {...stores[name]};return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,stores[name][key]]));},async set(v){Object.assign(stores[name],v);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete stores[name][key];}});
      window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(){}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(message){if(message.kind==='context')return {ok:true,result:{context:'',status:'none',source:null,binding:null}};if(message.kind==='capture.cancel')return {ok:true,result:{}};throw new Error('DEMO_CAPTURE_NOT_IMPLEMENTED');}}};
    },{api,record:scene.record});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin===origin){await route.continue();return;}
      if(url.origin!==api){report.blockedRequests.push(url.origin);await route.abort();return;}
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','content-type':'application/json'};
      if(request.method()==='OPTIONS'){await route.fulfill({status:200,headers,body:''});return;}
      const body=request.postDataJSON(),action=body.action;report.apiActions.push(action);
      let result;
      if(action==='records.get')result=records.find(r=>r.record_id===body.params.record_id);
      else if(action==='records.history')result={items:records.filter(r=>!body.params.query||r.original_text.includes(body.params.query)).map(r=>({...r,text:r.original_text})),has_more:false};
      else if(action==='settings.get')result={explanation_mode:'fast',font_theme:'clean',review_enabled:false,push_enabled:false};
      else if(action==='key.status')result={configured:false};
      else if(action==='ping')result={protocol:'cloud/2',model:'deepseek-flash'};
      else throw Error('UNEXPECTED_DEMO_ACTION:'+action);
      await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});
    });
    await page.goto(`${origin}/demo?scene=${index}`);
    const panel=page.frameLocator('iframe');
    if(scene.record)await panel.locator('#lesson .point').first().waitFor();
    else await panel.locator('#sourceText').waitFor();
    if(scene.kind==='history'){await panel.locator('#historyTab').click();await panel.locator('.history-row').first().waitFor();assert.equal(await panel.locator('.history-row').count(),4);}
    if(scene.kind==='image'){await panel.locator('#imageFile').setInputFiles({name:'synthetic-reading.png',mimeType:'image/png',buffer:Buffer.from(imageData.split(',')[1],'base64')});await panel.locator('#imageStage').waitFor();assert.equal(await panel.locator('#recognize').isVisible(),true);}
    await page.evaluate(()=>document.fonts.ready);
    await panel.locator('body').evaluate(()=>document.fonts.ready);
    const overflow=await panel.locator('body').evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
    assert.equal(overflow,false,'extension horizontal overflow');
    assert.equal(await panel.locator('#notice').isVisible(),false,'no fake success or diagnostic notice');
    const png=await page.screenshot({path:path.join(output,'screenshots',scene.file),type:'png',omitBackground:false});
    assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),800);assert.equal(png[24],8);assert.equal(png[25],2);
    report.screenshots.push({file:`screenshots/${scene.file}`,width:1280,height:800,format:'PNG RGB 8-bit, no alpha',bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),view:scene.kind,horizontalOverflow:overflow});
    await context.close();
  }
  assert.deepEqual(report.blockedRequests,[]);assert.deepEqual(report.browserErrors,[]);
  assert.equal(report.apiActions.some(action=>action.startsWith('learning.')),false);
  const icon=await readFile(path.join(output,'icon-128.png'));report.icon={file:'icon-128.png',width:icon.readUInt32BE(16),height:icon.readUInt32BE(20),sha256:createHash('sha256').update(icon).digest('hex'),unchangedFromExtension:true};
  assert.equal(report.icon.width,128);assert.equal(report.icon.height,128);
  await writeFile(path.join(output,'render-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({synthetic:true,screenshots:report.screenshots.length,dimensions:'1280x800',modelCalls:0,externalRequests:0,browserErrors:0}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
