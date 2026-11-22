import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

// UTC November 20 is already November 21 in the product's Beijing calendar.
const now='2026-11-20T16:30:00.000Z';
const samples=[
  ['today-word','2026-11-21','見えます'],
  ['today-phrase','2026-11-21','a jump in price'],
  ['today-image','2026-11-21','このウィッグは自然に見えます。','complete',true],
  ['yesterday-word','2026-11-20','anticipate'],
  ['yesterday-sentence','2026-11-20',"It's a fall in price over the following days and weeks."],
  ['older-word','2026-11-18','take for granted'],
  ['empty-image','2026-11-18','','failed',true],
  ['last-year','2025-11-18','Keep practising.'],
];
const lesson={language:'en',explanation_language:'zh',summary_zh:'合成笔记',vocabulary:[],grammar:[]};

async function harness(t){
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify('https://panel-history.example'),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic')}});
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      let file=pathname==='/panel.js'?null:pathname==='/panel.css'?'extension/panel.css':'extension/panel.html';
      if(pathname.startsWith('/assets/')){
        const typography=pathname.startsWith('/assets/typography/');
        const root=path.resolve(typography?'shared/typography':'extension/assets');
        file=path.resolve(root,pathname.slice(typography?'/assets/typography/'.length:'/assets/'.length));
        if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      }
      const type=!file?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':'text/html';
      res.writeHead(200,{'content-type':type});res.end(file?await readFile(file):bundle.outputFiles[0].text);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},timezoneId:'America/Los_Angeles'});
  const state={settings:{explanation_language:'zh',font_theme:'clean'},pageSize:2,records:new Map()};
  for(const [record_id,local_date,text,status='complete',has_image=false] of samples){
    state.records.set(record_id,{record_id,revision:1,local_date,status,has_image,input_type:has_image?'image':'text',text,original_text:text,result:status==='complete'?lesson:null,explanation_language:'zh'});
  }
  const calls=[],errors=[],unexpected=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({now})=>{
    const RealDate=Date,instant=RealDate.parse(now);
    window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[instant]));}static now(){return instant;}};
    const session={access_token:'synthetic-account',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:'synthetic-account',email:'synthetic@example.test'}};
    const stores={local:{'lingo-session:https://panel-history.example':JSON.stringify(session)},session:{}};
    const area=name=>({async get(keys){return keys?Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,stores[name][k]])):{...stores[name]};},async set(value){Object.assign(stores[name],value);},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete stores[name][k];}});
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(){}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(){return {ok:true,result:{context:'',status:'none',source:null}};}}};
  },{now});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();
    if(url.origin!=='https://panel-history.example'){unexpected.push(req.url());return route.abort();}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    if(req.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    const body=req.postDataJSON();calls.push(body);let result={};
    if(body.action==='settings.get')result={...state.settings};
    else if(body.action==='settings.update'){Object.assign(state.settings,body.params);result={...state.settings};}
    else if(body.action==='records.history'){
      const query=(body.params.query??'').toLowerCase(),offset=body.params.offset??0;
      const matches=[...state.records.values()].filter(r=>r.text.toLowerCase().includes(query));
      result={items:matches.slice(offset,offset+state.pageSize).map(r=>({record_id:r.record_id,revision:r.revision,local_date:r.local_date,status:r.status,input_type:r.input_type,text:r.text,has_image:r.has_image})),has_more:offset+state.pageSize<matches.length};
    }else if(body.action==='records.get')result=state.records.get(body.params.record_id)??null;
    else if(body.action==='records.delete'){state.records.delete(body.params.record_id);result={deleted:true};}
    else if(body.action==='key.status')result={configured:true};
    else if(body.action==='ping')result={protocol:'cloud/3'};
    else if(body.action.startsWith('learning.')||body.action==='images.url')throw Error('History must not generate lessons or load image details');
    await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  const open=async()=>{await page.locator('#historyTab').click();await page.locator('.history-row').first().waitFor();};
  const all=async()=>{while(await page.locator('#more').isVisible()){await page.locator('#more').click();await page.waitForFunction(()=>!document.querySelector('#more').disabled);}};
  const locale=async language=>{state.settings.explanation_language=language;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(language=>document.documentElement.dataset.uiLanguage===language,language);};
  return {page,state,calls,errors,unexpected,open,all,locale};
}

test('history groups Beijing dates across page boundaries without detail or image requests',{timeout:45000},async t=>{
  const {page,calls,errors,unexpected,open,all}=await harness(t);await open();
  assert.deepEqual(await page.locator('.history-date').allTextContents(),['今天']);
  assert.equal(await page.locator('.history-row').count(),2);
  await page.locator('#more').click();await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===4);
  assert.equal(await page.locator('.history-group').count(),2);
  assert.equal(await page.locator('.history-group').first().locator('.history-row').count(),3,'a day split across pages stays one group');
  await all();
  const dates=await page.locator('.history-date').allTextContents();
  assert.deepEqual(dates.slice(0,2),['今天','昨天']);assert.match(dates[2],/11.*18/);assert.match(dates[3],/2025.*11.*18/);
  assert.deepEqual(await page.locator('.history-date').evaluateAll(nodes=>nodes.map(n=>n.dataset.date)),['2026-11-21','2026-11-20','2026-11-18','2025-11-18']);
  assert.deepEqual(await page.locator('.history-text').allTextContents(),samples.map(s=>s[2]||'截图笔记'));
  assert.equal(await page.locator('.history-row').first().locator('.history-meta').count(),0,'completed text notes do not repeat status or date');
  const image=page.locator('.history-row').filter({hasText:'このウィッグ'});assert.match(await image.locator('.history-meta').textContent(),/截图/);
  const failed=page.locator('.history-row').filter({hasText:'截图笔记'});assert.match(await failed.locator('.history-meta').textContent(),/处理失败/);
  assert.equal(calls.some(c=>['records.get','images.url'].includes(c.action)||c.action.startsWith('learning.')),false);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
});

test('search clearing restores grouped results and deleting a row never opens its detail',{timeout:45000},async t=>{
  const {page,state,calls,errors,open,all}=await harness(t);await open();await all();
  await page.locator('#search').fill('anticipate');await page.locator('#search').press('Enter');
  await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===1);
  assert.equal(await page.locator('.history-date').textContent(),'昨天');
  page.once('dialog',d=>d.dismiss());await page.locator('.delete-record').click();
  assert.equal(calls.some(c=>c.action==='records.delete'),false);assert.equal(calls.some(c=>c.action==='records.get'),false);
  page.once('dialog',d=>d.accept());await page.locator('.delete-record').click();
  await page.locator('.history-row').waitFor({state:'detached'});
  assert.equal(await page.locator('#historyView').isVisible(),true);assert.equal(await page.locator('#recordSection').isVisible(),false);
  assert.equal(state.records.has('yesterday-word'),false);assert.equal(calls.filter(c=>c.action==='records.delete').length,1);
  await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===7);
  assert.equal(await page.locator('.history-date').count(),4);assert.equal(await page.locator('.history-card').filter({hasText:'anticipate'}).count(),0,'deleted items stay absent from the unfiltered cache');
  const gets=calls.filter(c=>c.action==='records.get').length;
  await page.locator('.history-card').filter({hasText:'a jump in price'}).focus();await page.keyboard.press('Enter');await page.locator('#recordSection').waitFor();
  assert.equal(calls.filter(c=>c.action==='records.get').length,gets+1);assert.equal(calls.at(-1).params.record_id,'today-phrase');
  assert.equal(await page.locator('#historyView').isVisible(),false);assert.equal(await page.locator('#recordOriginal').textContent(),'a jump in price');
  assert.deepEqual(errors,[]);
});

test('history localization preserves inputs and stays readable in narrow panels and all font themes',{timeout:90000},async t=>{
  const {page,state,calls,errors,open,all,locale}=await harness(t);state.pageSize=20;await open();await all();
  await page.locator('#search').fill('unsent search');const requests=calls.filter(c=>c.action==='records.history').length;
  await page.locator('#search').evaluate(e=>{window.originalHistorySearch=e;e.focus();e.setSelectionRange(1,4);});
  const labels={zh:['今天','昨天','删除'],ja:['今日','昨日','削除'],en:['Today','Yesterday','Delete']};
  for(const language of ['en','ja','zh']){
    await locale(language);
    assert.deepEqual((await page.locator('.history-date').allTextContents()).slice(0,2),labels[language].slice(0,2));
    assert.match(await page.locator('.delete-record').first().getAttribute('aria-label'),new RegExp(labels[language][2]));
    assert.equal(await page.locator('.history-text').first().textContent(),'見えます');
    assert.equal(await page.locator('#search').inputValue(),'unsent search');
    assert.equal(await page.evaluate(()=>document.querySelector('#search')===window.originalHistorySearch),true);
    assert.equal(calls.filter(c=>c.action==='records.history').length,requests,'locale updates use the loaded list');
    for(const font of ['clean','handwritten','bookish','refined'])for(const width of [320,390,420]){
      await page.setViewportSize({width,height:844});
      await page.evaluate(font=>{document.documentElement.dataset.fontTheme=font;getComputedStyle(document.body).fontFamily;},font);await page.evaluate(()=>document.fonts.ready);
      const metrics=await page.evaluate(()=>{
        const rect=selector=>document.querySelector(selector).getBoundingClientRect();
        const input=rect('.history-search-field'),query=rect('#searchButton');
        const buttons=[...document.querySelectorAll('.delete-record')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));
        return {overflow:document.documentElement.scrollWidth>innerWidth,inputHeight:input.height,queryHeight:query.height,buttons,textSize:getComputedStyle(document.querySelector('.history-text')).fontSize,loadedIcons:[...document.querySelectorAll('#historyView img')].every(e=>e.complete&&e.naturalWidth>0)};
      });
      const label=`${language}-${font}-${width}`;
      assert.equal(metrics.overflow,false,label);assert.ok(Math.abs(metrics.inputHeight-metrics.queryHeight)<1,label+' search alignment');
      assert.ok(metrics.buttons.every(b=>b.width>=44&&b.height>=44),label+' delete targets');assert.equal(metrics.textSize,'16px',label+' reading size');assert.equal(metrics.loadedIcons,true,label+' icons');
      if(process.env.LINGO_HISTORY_SCREENSHOTS==='1'){
        await mkdir('.cache/history-list/screenshots',{recursive:true});
        await page.locator('#search').evaluate(e=>{e.blur();e.value='';});
        await page.locator('.history-card').nth(1).hover();
        await page.screenshot({path:`.cache/history-list/screenshots/${label}.png`,fullPage:true});
        await page.locator('#search').evaluate(e=>{e.value='unsent search';});
      }
    }
  }
  if(process.env.LINGO_HISTORY_SCREENSHOTS==='1'){
    state.records.delete('empty-image');state.records.delete('last-year');
    const template=state.records.get('today-word');
    state.records.set('polite-phrase',{...template,record_id:'polite-phrase',local_date:'2026-11-20',text:'お待ちしております',original_text:'お待ちしております'});
    state.records.set('older-image',{...template,record_id:'older-image',local_date:'2026-11-18',text:'日本語を勉強し始めました。',original_text:'日本語を勉強し始めました。',has_image:true,input_type:'image'});
    state.records=new Map([...state.records].sort((a,b)=>b[1].local_date.localeCompare(a[1].local_date)));
    await page.setViewportSize({width:420,height:870});await page.evaluate(()=>{document.documentElement.dataset.fontTheme='clean';});
    await page.locator('#search').fill('');await page.waitForFunction(()=>document.querySelector('#historyList').textContent.includes('日本語を勉強し始めました。'));
    await page.evaluate(()=>document.fonts.ready);await page.locator('#search').blur();await page.locator('.history-card').nth(1).hover();
    await page.screenshot({path:'.cache/history-list/screenshots/reference-layout-zh-clean-420.png',fullPage:true});
  }
  assert.equal(calls.some(c=>c.action.startsWith('learning.')||c.action==='images.url'),false);assert.deepEqual(errors,[]);
});
