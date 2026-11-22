import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {installSelectionQueueBridge} from './helpers/selection-background.mjs';

function lesson(language='zh'){
  const text={zh:['持续练习','名词','练习','每天练习。'],ja:['練習を続ける','名詞','練習すること','毎日練習する。'],en:['Keep practising','noun','repeated learning','Practise each day.']}[language];
  return {language:'en',explanation_language:language,summary_zh:text[0],vocabulary:[{term:'practice',reading:'/ˈpræktɪs/',pos:text[1],meaning:text[2],examples:[{text:'I practise daily.',translation:text[3]}]}],grammar:[{point:text[0],explanation:text[2],examples:[]}]};
}
async function harness(t){
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify('https://panel-language.example'),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic')}});
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      let file=pathname==='/panel.js'?null:pathname==='/panel.css'?'extension/panel.css':'extension/panel.html';
      if(pathname.startsWith('/assets/')){
        const typography=pathname.startsWith('/assets/typography/'),root=path.resolve(typography?'shared/typography':'extension/assets');
        file=path.resolve(root,pathname.slice(typography?'/assets/typography/'.length:'/assets/'.length));
        if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      }
      const type=!file?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/html';
      res.writeHead(200,{'content-type':type});res.end(file?await readFile(file):bundle.outputFiles[0].text);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[],calls=[];
  const state={settings:{one:{explanation_language:'zh',font_theme:'clean'},two:{explanation_language:'ja',font_theme:'clean'}},records:new Map(),failSave:false,failLearning:false,holdRead:false,holdSave:false,holdLearning:false,readGate:null,saveGate:null,learningGate:null};
  const base={record_id:'old-note',revision:1,status:'complete',input_type:'text',local_date:'2026-11-20',original_text:'practice',explanation_language:'zh',result:lesson()};state.records.set(base.record_id,base);
  state.records.set('ocr-note',{...base,record_id:'ocr-note',original_text:'OCR source only',input_type:'image',status:'awaiting_review',recognized_text:'I practise daily.',result:null});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    const session={access_token:'one',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:'one',email:'one@example.test'}};
    const stores=JSON.parse(sessionStorage.getItem('synthetic-stores')||'null')??{local:{'lingo-session:https://panel-language.example':JSON.stringify(session)},session:{}};
    window.testStorage=stores;const persist=()=>sessionStorage.setItem('synthetic-stores',JSON.stringify(stores));
    const area=name=>({async get(keys){return keys?Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,stores[name][k]])):{...stores[name]};},async set(value){Object.assign(stores[name],value);persist();},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete stores[name][k];persist();}});
    window.runtimeMessages=[];
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(fn){window.storageChange=fn;}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(message){window.runtimeMessages.push(message);if(message.kind==='context'&&window.holdContext)await new Promise(resolve=>{window.releaseContext=resolve;});return {ok:true,result:{context:'',status:'none',source:null}};}}};
  });
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.hostname==='127.0.0.1')return route.continue();
    if(url.origin!=='https://panel-language.example')return route.abort();
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    if(req.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    const body=req.postDataJSON();calls.push(body);const owner=req.headers().authorization==='Bearer two'?'two':'one';let result={};
    if(body.action==='settings.get'){
      result={...state.settings[owner]};if(state.holdRead){if(state.readCountdown>0)state.readCountdown--;else{state.holdRead=false;await new Promise(resolve=>{state.readGate=resolve;});}}
    }else if(body.action==='settings.update'){
      if(state.holdSave){state.holdSave=false;await new Promise(resolve=>{state.saveGate=resolve;});}
      if(state.failSave){state.failSave=false;return route.fulfill({status:503,headers,body:JSON.stringify({ok:false,error:'NETWORK_ERROR'})});}
      Object.assign(state.settings[owner],body.params);result={...state.settings[owner]};
    }else if(body.action==='records.history')result={items:[...state.records.values()].map(r=>({...r,text:r.original_text})),has_more:false};
    else if(body.action==='records.get')result=state.records.get(body.params.record_id)??null;
    else if(body.action==='review.cards')result={cards:[]};
    else if(['learning.submit','learning.confirm','learning.retry'].includes(body.action)){
      const p=body.params,old=state.records.get(p.record_id),record={...base,...old,record_id:p.record_id,revision:(old?.revision??0)+1,original_text:old?.original_text??p.text,corrected_text:p.text,status:'processing',request_id:body.request_id,explanation_language:p.explanation_language};
      state.records.set(p.record_id,record);
      if(state.holdLearning){state.holdLearning=false;await new Promise(resolve=>{state.learningGate=resolve;});}
      const failed=state.failLearning;state.failLearning=false;
      const complete={...record,status:failed?'failed':'complete',error:failed?'INVALID_LESSON':null,result:failed?old?.result:lesson(p.explanation_language)};state.records.set(p.record_id,complete);
      const event=(type,payload)=>`event: ${type}\ndata: ${JSON.stringify({request_id:body.request_id,record_id:p.record_id,revision:record.revision,...payload})}\n\n`;
      try{return await route.fulfill({status:200,headers:{...headers,'content-type':'text/event-stream'},body:event('accepted',{sequence:1,record})+event('progress',{sequence:2,preview:lesson(p.explanation_language)})+event(failed?'error':'complete',{sequence:3,record:complete,error:failed?'INVALID_LESSON':undefined})});}catch{return;}
    }else if(body.action==='key.status')result={configured:true};
    else if(body.action==='ping')result={protocol:'cloud/3'};
    await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});
  });
  await installSelectionQueueBridge(t,page,'https://panel-language.example');
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  const ready=()=>page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  const choose=async(id,value)=>{await page.locator('#'+id).selectOption(value);await ready();};
  const open=async id=>{await page.locator('#historyTab').click();const record=state.records.get(id);await page.locator('.history-card').filter({hasText:record.original_text}).last().click();await page.locator('#recordSection').waitFor();};
  return {page,state,calls,errors,ready,choose,open};
}

test('language preference saves, snapshots every learning flow, and failed retry retains old result language', {timeout:45000},async t=>{
  const {page,state,calls,errors,ready,choose}=await harness(t);
  assert.equal(await page.locator('#explanationLanguage').inputValue(),'zh');
  state.holdSave=true;await page.locator('#explanationLanguage').selectOption('ja');
  await page.waitForFunction(()=>document.querySelector('#send').disabled);
  assert.equal(calls.some(c=>c.action.startsWith('learning.')),false);
  while(!state.saveGate)await new Promise(resolve=>setTimeout(resolve,10));state.saveGate();await ready();
  await page.locator('#sourceText').fill('Practice makes progress.');await page.locator('#send').click();
  await page.waitForFunction(()=>!document.querySelector('#editRecord').hidden);await ready();
  assert.equal(calls.find(c=>c.action==='learning.submit').params.explanation_language,'ja');
  for(const selector of ['.lesson-overview','.part-of-speech','.point > p:not(.point-label):not(.reading):not(.pronunciation-status)','.translation:not(.reading)'])assert.equal(await page.locator(selector).first().getAttribute('lang'),'ja');
  assert.equal(await page.locator('.term-text').getAttribute('lang'),'en');assert.equal(await page.locator('.example-original').getAttribute('lang'),'en');
  await page.locator('#editRecord').click();assert.equal(await page.locator('#retryLanguage').inputValue(),'ja');
  await choose('retryLanguage','en');state.failLearning=true;await page.locator('#retryConfirm').click();
  await page.locator('#recordError').waitFor();await ready();
  assert.equal(calls.find(c=>c.action==='learning.retry').params.explanation_language,'en');assert.equal(await page.locator('.lesson-overview').getAttribute('lang'),'ja');
  await page.locator('#learnTab').click();assert.equal(await page.locator('#explanationLanguage').inputValue(),'en');
  await page.locator('#historyTab').click();await page.locator('.history-row').filter({hasText:'OCR source only'}).locator('.history-card').click();
  await page.locator('#reviewSection').waitFor();assert.equal(await page.locator('#reviewLanguage').inputValue(),'en');
  await choose('reviewLanguage','zh');await page.locator('#confirmText').click();await page.waitForFunction(()=>document.querySelector('#reviewSection').hidden&&!document.querySelector('#editRecord').hidden);await ready();
  assert.equal(calls.find(c=>c.action==='learning.confirm').params.explanation_language,'zh');
  await page.locator('#learnTab').click();state.failSave=true;await choose('explanationLanguage','en');
  assert.equal(await page.locator('#explanationLanguage').inputValue(),'zh');assert.match(await page.locator('#notice').textContent(),/已恢复/);
  const legacy=state.records.get('old-note');legacy.status='failed';legacy.explanation_language='ja';delete legacy.result.explanation_language;
  await page.locator('#historyTab').click();await page.locator('.history-card').first().click();
  await page.locator('#editRecord').click();
  assert.equal(await page.locator('#retryLanguage').inputValue(),'zh','old results without language remain Chinese after a failed attempt in Japanese');
  assert.equal(await page.locator('.lesson-overview').getAttribute('lang'),'zh-CN');
  assert.deepEqual(errors,[]);
});

test('language cannot change during context/request; reopening recovers snapshot without re-sending', {timeout:45000},async t=>{
  const {page,state,calls,errors,ready,choose}=await harness(t);await choose('explanationLanguage','en');
  await page.locator('#sourceText').fill('Keep learning.');await page.evaluate(()=>{window.holdContext=true;});
  await page.locator('#send').click();assert.equal(await page.locator('#explanationLanguage').isDisabled(),true);
  state.settings.one.explanation_language='ja';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(50);assert.equal(await page.locator('#explanationLanguage').inputValue(),'en');
  state.holdLearning=true;await page.evaluate(()=>{window.holdContext=false;window.releaseContext?.();});
  while(!state.learningGate)await new Promise(resolve=>setTimeout(resolve,10));
  const sent=calls.find(c=>c.action==='learning.submit');assert.equal(sent.params.explanation_language,'en');
  await page.reload();await page.locator('#cancelJob').waitFor();
  assert.match(await page.locator('#recordMeta').textContent(),/英語|英语|English/);assert.equal(await page.locator('#retryLanguage').inputValue(),'en');
  assert.equal(await page.locator('#retryLanguage').isDisabled(),true);assert.equal(calls.filter(c=>c.action==='learning.submit').length,1);
  state.learningGate();await page.waitForTimeout(50);
  assert.deepEqual(errors,[]);
});

test('stale language settings and saves cannot overwrite a new account; layouts fit all themes', {timeout:45000},async t=>{
  const {page,state,errors,ready,choose}=await harness(t);
  // Stale reads are captured before a preference write and returned afterwards.
  state.holdRead=true;state.readCountdown=1;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  while(!state.readGate)await new Promise(resolve=>setTimeout(resolve,10));
  await choose('explanationLanguage','en');state.readGate();await page.waitForTimeout(50);
  assert.equal(await page.locator('#explanationLanguage').inputValue(),'en');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  state.holdSave=true;await page.locator('#explanationLanguage').selectOption('ja');
  while(!state.saveGate)await new Promise(resolve=>setTimeout(resolve,10));
  state.settings.two.explanation_language='zh';
  await page.evaluate(()=>{const key='lingo-session:https://panel-language.example';const value=JSON.stringify({access_token:'two',refresh_token:'synthetic-refresh-two',expires_at:Date.now()/1000+3600,user:{id:'two',email:'two@example.test'}});window.testStorage.local[key]=value;window.storageChange({[key]:{newValue:value}},'local');});
  await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#explanationLanguage').disabled);
  state.saveGate();await page.waitForTimeout(50);assert.equal(await page.locator('#explanationLanguage').inputValue(),'zh');
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  await choose('explanationLanguage','en');await page.locator('#sourceText').fill('少しずつ日本語がわかるようになりました。');
  for(const theme of ['clean','handwritten','bookish','refined'])for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await page.evaluate(theme=>{document.documentElement.dataset.fontTheme=theme;},theme);await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const rects=await page.locator('.composer-toolbar').locator('button,select').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {top:r.top,width:r.width,height:r.height};}));
    assert.equal(rects[2].width,92);assert.ok(rects.every(r=>r.width>30&&r.height>=44));
    if(process.env.LINGO_LANGUAGE_SCREENSHOTS==='1'){await mkdir('.cache/language-ui',{recursive:true});await page.screenshot({path:`.cache/language-ui/${theme}-${width}.png`});}
  }
  assert.deepEqual(errors,[]);
});

test('UI locale follows saved preference, previews changes, and preserves drafts and saved lesson languages', {timeout:60000},async t=>{
  const {page,state,calls,errors,ready,choose,open}=await harness(t);
  const draft='Keep this original draft unchanged.';
  await page.locator('#sourceText').fill(draft);
  await page.evaluate(()=>{window.originalInput=document.querySelector('#sourceText');window.originalInput.setSelectionRange(5,9);});
  assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  const initialPlaceholder=await page.locator('#sourceText').getAttribute('placeholder');

  state.holdSave=true;await page.locator('#explanationLanguage').selectOption('ja');
  await page.waitForFunction(()=>document.documentElement.lang==='ja');
  assert.equal(await page.locator('#historyTab').textContent(),'履歴');
  assert.equal(await page.locator('#send').isDisabled(),true);
  while(!state.saveGate)await new Promise(resolve=>setTimeout(resolve,10));state.saveGate();await ready();
  assert.notEqual(await page.locator('#sourceText').getAttribute('placeholder'),initialPlaceholder);
  assert.equal(await page.evaluate(()=>document.querySelector('#sourceText')===window.originalInput),true);
  assert.deepEqual(await page.locator('#sourceText').evaluate(e=>[e.value,e.selectionStart,e.selectionEnd]),[draft,5,9]);
  assert.match(await page.locator('#notice').textContent(),/日本語/);
  assert.match(await page.locator('#notice').getAttribute('lang')??await page.locator('html').getAttribute('lang'),/^ja/);

  await choose('explanationLanguage','en');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#historyTab').textContent(),'History');
  assert.equal(await page.locator('#send').textContent(),'Explain');
  assert.doesNotMatch(await page.locator('#sourceText').getAttribute('placeholder'),/[\p{Script=Han}\p{Script=Hiragana}]/u);
  state.failSave=true;await choose('explanationLanguage','zh');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#explanationLanguage').inputValue(),'en');
  assert.equal(state.settings.one.explanation_language,'en');
  assert.doesNotMatch(await page.locator('#notice').textContent(),/[\p{Script=Han}\p{Script=Hiragana}]/u);

  await page.reload();await ready();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#sourceText').inputValue(),draft);
  assert.equal(await page.locator('#settingsTab').textContent(),'Settings');
  await page.locator('#settingsTab').click();await page.locator('#settingsView').waitFor();
  for(const selector of ['#settingsHeading','#modeState','#fontDescription','#fontState','#connectionState','#keyState']){
    const text=await page.locator(selector).textContent();assert.ok(text.trim(),selector);assert.doesNotMatch(text,/[\p{Script=Han}\p{Script=Hiragana}]/u,selector);
  }
  await page.locator('#learnTab').click();

  const original=structuredClone(state.records.get('old-note'));
  await open('old-note');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('.lesson-overview').textContent(),original.result.summary_zh);
  assert.equal(await page.locator('.lesson-overview').getAttribute('lang'),'zh-CN');
  assert.equal(await page.locator('.term-text').getAttribute('lang'),'en');
  assert.match(await page.locator('.point-label').first().textContent(),/Vocabulary/);
  assert.doesNotMatch(await page.locator('.pronounce').first().getAttribute('aria-label'),/[\p{Script=Han}\p{Script=Hiragana}]/u);
  await page.locator('#editRecord').click();
  const edit='Keep this edited material too.';await page.locator('#retryText').fill(edit);
  await page.locator('#retryText').evaluate(e=>{window.originalEditor=e;e.setSelectionRange(5,9);e.focus();});
  state.settings.one.explanation_language='ja';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.documentElement.lang==='ja');await ready();
  assert.equal(await page.evaluate(()=>document.activeElement===window.originalEditor),true);
  assert.deepEqual(await page.locator('#retryText').evaluate(e=>[e.value,e.selectionStart,e.selectionEnd]),[edit,5,9]);
  assert.equal(await page.locator('#retryLanguage').inputValue(),'zh','editing an old Chinese result does not itself select the account UI locale');
  state.failSave=true;await choose('retryLanguage','en');
  assert.equal(await page.locator('html').getAttribute('lang'),'ja','failed revision-language save restores the account locale, not the old result locale');
  assert.equal(await page.locator('#retryLanguage').inputValue(),'zh');
  assert.equal(await page.locator('.lesson-overview').textContent(),original.result.summary_zh);

  await page.locator('#historyTab').click();await page.locator('.history-card').first().waitFor();
  await page.locator('#search').fill('preserve unsent search');
  const historyRequests=calls.filter(c=>c.action==='records.history').length;
  const oldMeta=await page.locator('.history-meta').first().textContent();
  state.settings.one.explanation_language='en';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.documentElement.lang==='en');await ready();
  assert.equal(await page.locator('#search').inputValue(),'preserve unsent search');
  assert.notEqual(await page.locator('.history-meta').first().textContent(),oldMeta);
  assert.doesNotMatch(await page.locator('.history-meta').first().textContent(),/[\p{Script=Han}\p{Script=Hiragana}]/u);
  assert.equal(calls.filter(c=>c.action==='records.history').length,historyRequests,'localizing loaded history does not fetch it again');
  let confirmation='';page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.dismiss();});
  await page.locator('.delete-record').first().click();
  assert.ok(confirmation);assert.doesNotMatch(confirmation,/[\p{Script=Han}\p{Script=Hiragana}]/u);
  assert.equal(calls.some(c=>c.action==='records.delete'),false);
  assert.equal(calls.some(c=>c.action.startsWith('learning.')),false,'localization never requests a model');
  assert.deepEqual(state.records.get('old-note'),original);
  assert.deepEqual(errors,[]);
});

test('localized composer, history, detail and settings remain usable across three locales and four font themes', {timeout:90000},async t=>{
  const {page,state,calls,errors,choose}=await harness(t);
  const learn=async()=>{await page.locator('#learnTab').click();};
  const check=async(label)=>{
    await page.evaluate(async()=>{for(const image of document.images){if(!image.getClientRects().length||image.closest('[hidden]'))continue;try{await image.decode();}catch{throw Error('Visible UI image failed to load: '+image.getAttribute('src'));}}});
    const metrics=await page.evaluate(()=>{
      const inside=e=>{const r=e.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&e.scrollWidth<=e.clientWidth+1;};
      const visible=e=>e.getClientRects().length&&!e.closest('[hidden]');
      const controls=[...document.querySelectorAll('button,select,textarea,input')].filter(e=>visible(e)&&e.type!=='file');
      const navigation=[...document.querySelectorAll('#learnTab,#historyTab,#settingsTab')];
      const selected=navigation.filter(e=>e.getAttribute('aria-current')==='page');
      return {overflow:document.documentElement.scrollWidth>innerWidth,controls:controls.filter(e=>!inside(e)).map(e=>e.id||e.className),navigationFits:navigation.length===3&&navigation.every(e=>visible(e)&&inside(e))&&selected.length===1,menuAbsent:!document.querySelector('#menu,.tagline,#backFromHistory,#backFromSettings')};
    });
    if(metrics.overflow||metrics.controls.length||!metrics.navigationFits){await mkdir('.cache/ui-language/layout',{recursive:true});await page.screenshot({path:`.cache/ui-language/layout/failure-${label.replaceAll('/','-')}.png`});}
    assert.equal(metrics.overflow,false,label);assert.deepEqual(metrics.controls,[],label);assert.equal(metrics.navigationFits,true,label);assert.equal(metrics.menuAbsent,true,label);
    if(process.env.LINGO_NAV_SCREENSHOTS==='1'){await mkdir('.cache/navigation-ui/layout',{recursive:true});await page.screenshot({path:`.cache/navigation-ui/layout/${label.replaceAll('/','-')}.png`,fullPage:true});}
  };
  for(const locale of ['zh','ja','en']){
    await learn();await choose('explanationLanguage',locale);
    for(const theme of ['clean','handwritten','bookish','refined'])for(const width of [320,390,480]){
      state.settings.one.font_theme=theme;await learn();await page.setViewportSize({width,height:844});
      await page.evaluate(theme=>{document.documentElement.dataset.fontTheme=theme;getComputedStyle(document.body).fontFamily;},theme);await page.evaluate(()=>document.fonts.ready);
      await check(`${locale}/${theme}/${width}/compose`);
      await page.locator('#historyTab').click();await page.locator('.history-card').first().waitFor();await check(`${locale}/${theme}/${width}/history`);
      const columns=await page.evaluate(()=>{
        const r=s=>document.querySelector(s).getBoundingClientRect();const input=r('.history-search-field'),query=r('#searchButton'),card=r('.history-row'),remove=r('.delete-record');
        return {inputLeft:input.left,cardLeft:card.left,inputHeight:input.height,queryHeight:query.height,removeWidth:remove.width,removeHeight:remove.height};
      });
      assert.equal(columns.inputLeft,columns.cardLeft);assert.equal(columns.inputHeight,columns.queryHeight);assert.ok(columns.removeWidth>=44);assert.ok(columns.removeHeight>=44);
      assert.equal(await page.locator('#historyTab').getAttribute('aria-current'),'page');
      await page.locator('.history-card').first().click();await page.locator('#backToHistory').waitFor();await check(`${locale}/${theme}/${width}/detail`);
      assert.equal(await page.locator('#historyTab').getAttribute('aria-current'),'page');
      await page.locator('#backToHistory').click();await page.locator('#historyView').waitFor();
      await page.locator('#settingsTab').click();await page.locator('#settingsView').waitFor();await check(`${locale}/${theme}/${width}/settings`);
      if(process.env.LINGO_LANGUAGE_SCREENSHOTS==='1'){
        await mkdir('.cache/ui-language/layout',{recursive:true});await page.screenshot({path:`.cache/ui-language/layout/${locale}-${theme}-${width}-settings.png`});
        await learn();await page.screenshot({path:`.cache/ui-language/layout/${locale}-${theme}-${width}-composer.png`});
      }
    }
  }
  assert.equal(calls.some(c=>c.action.startsWith('learning.')),false);assert.deepEqual(errors,[]);
});
