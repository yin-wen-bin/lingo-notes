import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {installSelectionQueueBridge} from './helpers/selection-background.mjs';

const apiOrigin='https://panel-settings.example';
const syntheticRecord={record_id:'synthetic-note',revision:1,status:'complete',input_type:'text',local_date:'2026-11-21',original_text:'見えます',explanation_language:'zh',result:{language:'ja',explanation_language:'zh',summary_zh:'表示事物在视野中可以被看见。',vocabulary:[{term:'見えます',reading:'みえます',pos:'动词',meaning:'看得见',examples:[{text:'窓から山が見えます。',translation:'从窗户可以看见山。'}]}],grammar:[]}};

async function harness(t,{configured=true,signedIn=true}={}){
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify(apiOrigin),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic-public')}});
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
  const page=await browser.newPage({viewport:{width:390,height:844}}),calls=[],errors=[],logs=[],unexpected=[],gates=new Map(),pendingGates=[];
  const state={settings:{one:{font_theme:'refined',explanation_language:'zh',explanation_mode:'fast'},two:{font_theme:'clean',explanation_language:'zh',explanation_mode:'fast'}},keys:{one:{configured,last_four:configured?'1234':null},two:{configured:false}},failActions:new Set()};
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>logs.push(message.text()));
  await page.addInitScript(({apiOrigin,signedIn})=>{
    const makeSession=owner=>JSON.stringify({access_token:owner,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:owner,email:owner+'@example.test'}});
    const stores={local:signedIn?{['lingo-session:'+apiOrigin]:makeSession('one')}:{},session:{}};window.settingsStores=stores;
    const area=name=>({async get(keys){return keys?Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,stores[name][key]])):{...stores[name]};},async set(value){Object.assign(stores[name],value);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete stores[name][key];}});
    window.changeSettingsAccount=owner=>{const key='lingo-session:'+apiOrigin,value=owner?makeSession(owner):undefined;if(value)stores.local[key]=value;else delete stores.local[key];window.settingsStorageChange({[key]:{newValue:value}},'local');};
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(fn){window.settingsStorageChange=fn;}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(){return {ok:true,result:{context:'',status:'none',source:null}};}}};
  },{apiOrigin,signedIn});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.hostname==='127.0.0.1')return route.continue();
    if(url.origin!==apiOrigin){unexpected.push(request.url());return route.abort();}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    if(request.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    if(url.pathname==='/auth/v1/logout')return route.fulfill({status:200,headers,body:'{}'});
    const body=request.postDataJSON(),owner=request.headers().authorization==='Bearer two'?'two':'one';calls.push({owner,...body});
    if(body.action.startsWith('learning.')){unexpected.push(body.action);return route.abort();}
    if(state.failActions.delete(body.action))return route.fulfill({status:503,headers,body:JSON.stringify({ok:false,error:'NETWORK_ERROR'})});
    let result={};
    if(body.action==='settings.get')result={...state.settings[owner]};
    else if(body.action==='settings.update'){Object.assign(state.settings[owner],body.params);result={...state.settings[owner]};}
    else if(body.action==='key.status')result={...state.keys[owner]};
    else if(body.action==='key.save'){state.keys[owner]={configured:true,last_four:body.params.key.slice(-4)};result={saved:true};}
    else if(body.action==='key.delete'){state.keys[owner]={configured:false};result={deleted:true};}
    else if(body.action==='ping')result={protocol:'cloud/4',model:'deepseek-flash'};
    else if(body.action==='records.history')result={items:[{...syntheticRecord,text:syntheticRecord.original_text}],has_more:false};
    else if(body.action==='records.get')result=syntheticRecord;
    else if(body.action==='review.cards')result={cards:[]};
    else {unexpected.push(body.action);return route.abort();}
    const gate=gates.get(owner+':'+body.action);if(gate){gates.delete(owner+':'+body.action);gate.startedResolve();await gate.releasePromise;}
    try{await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});}catch{/* A held response may outlive the page. */}
  });
  const hold=(action,owner='one')=>{const gate={};gate.started=new Promise(resolve=>{gate.startedResolve=resolve;});gate.releasePromise=new Promise(resolve=>{gate.release=resolve;});gates.set(owner+':'+action,gate);pendingGates.push(gate);return gate;};
  t.after(()=>{for(const gate of pendingGates)gate.release();});
  await installSelectionQueueBridge(t,page,apiOrigin);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if(signedIn)await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  await page.locator('#settingsTab').click();
  if(signedIn)await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('one@example.test'));
  const shot=async name=>{if(process.env.LINGO_SETTINGS_SCREENSHOTS==='1'){await mkdir('.cache/settings-ui/screenshots',{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'.cache/settings-ui/screenshots/'+name+'.png',fullPage:name!=='settings-configured-zh-refined-390'});}};
  const clean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(calls.some(call=>call.action.startsWith('learning.')),false);};
  return {page,state,calls,logs,hold,shot,clean};
}

test('configured Key stays collapsed; failed updates retain the editor and successful verified saves collapse it',{timeout:60000},async t=>{
  const {page,state,calls,logs,hold,shot,clean}=await harness(t);
  assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),false);assert.match(await page.locator('#keyState').textContent(),/已配置/);assert.equal(await page.locator('#keyEditorAction').textContent(),'更新');
  await page.locator('#keyEditor summary').click();assert.match(await page.locator('#keyDetail').textContent(),/1234/);await shot('settings-key-expanded-zh-refined-390');
  const key='sk-SYNTHETIC-ONLY-5678';state.failActions.add('key.save');await page.locator('#apiKey').fill(key);await page.locator('#saveKey').click();
  await page.waitForFunction(()=>!document.querySelector('#saveKey').disabled&&document.querySelector('#apiKey').value==='');
  assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true);assert.match(await page.locator('#keyDetail').textContent(),/未能确认/);assert.doesNotMatch(await page.locator('#keyState').textContent(),/已配置/);
  assert.equal(JSON.stringify(await page.evaluate(()=>window.settingsStores)).includes(key),false);assert.equal(logs.join('\n').includes(key),false);
  const readback=hold('key.status');await page.locator('#apiKey').fill(key);await page.locator('#saveKey').click();await readback.started;
  assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true,'wait for confirmed status before collapsing');
  readback.release();await page.waitForFunction(()=>!document.querySelector('#keyEditor').open&&!document.querySelector('#saveKey').disabled);
  assert.match(await page.locator('#keyDetail').textContent(),/5678/);assert.equal(await page.locator('#apiKey').inputValue(),'');
  assert.equal(calls.filter(call=>call.action==='key.save').length,2);clean();
});

test('missing Key opens configuration and removal requires confirmation without losing saved notes',{timeout:60000},async t=>{
  const {page,state,calls,shot,clean}=await harness(t,{configured:false});
  assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true);assert.equal(await page.locator('#keyEditorAction').textContent(),'收起');await shot('settings-unconfigured-zh-refined-390');
  await page.locator('#apiKey').fill('sk-SYNTHETIC-ONLY-7788');await page.locator('#saveKey').click();await page.waitForFunction(()=>!document.querySelector('#keyEditor').open);
  await page.locator('#keyEditor summary').click();page.once('dialog',dialog=>dialog.dismiss());await page.locator('#deleteKey').click();
  assert.equal(calls.filter(call=>call.action==='key.delete').length,0);assert.equal(state.keys.one.configured,true);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#deleteKey').click();await page.waitForFunction(()=>document.querySelector('#keyEditor').open&&document.querySelector('#keyState').textContent.includes('未配置'));
  assert.equal(calls.filter(call=>call.action==='key.delete').length,1);assert.equal(state.keys.one.configured,false);assert.equal(calls.some(call=>call.action==='records.delete'),false);
  await page.locator('#historyTab').click();await page.locator('.history-card').waitFor();assert.equal(await page.locator('.history-text').textContent(),'見えます');clean();
});

test('settings save failures roll back locally and previous-account diagnostics cannot overwrite the new account',{timeout:60000},async t=>{
  const {page,state,calls,hold,clean}=await harness(t);
  state.failActions.add('settings.update');await page.locator('#modeThinking').click();
  await page.waitForFunction(()=>!document.querySelector('#modeThinking').disabled&&document.querySelector('#modeSaveState').textContent.includes('恢复'));
  assert.equal(await page.locator('#modeFast').getAttribute('aria-pressed'),'true');assert.equal(state.settings.one.explanation_mode,'fast');
  const gate=hold('key.status');await page.locator('#diagnose').click();await gate.started;
  await page.locator('#keyEditor summary').click();await page.locator('#apiKey').fill('sk-SYNTHETIC-UNSAVED-ONE');
  await page.evaluate(()=>window.changeSettingsAccount('two'));
  await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#fontTheme').disabled);
  assert.equal(await page.locator('#apiKey').inputValue(),'');assert.doesNotMatch(await page.locator('#keyDetail').textContent(),/1234/);
  await page.locator('#settingsTab').click();await page.waitForFunction(()=>document.querySelector('#keyState').textContent.includes('未配置'));
  assert.equal(await page.locator('#apiKey').inputValue(),'');assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true);assert.match(await page.locator('#keyState').textContent(),/未配置/);
  const response=page.waitForResponse(response=>response.url()===apiOrigin+'/functions/v1/app-api'&&response.request().postDataJSON()?.action==='key.status'&&response.request().headers().authorization==='Bearer one');gate.release();await response;
  assert.match(await page.locator('#connectionState').textContent(),/two@example.test/);assert.doesNotMatch(await page.locator('#keyDetail').textContent(),/1234/);assert.match(await page.locator('#keyState').textContent(),/未配置/);assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true);
  assert.equal(calls.some(call=>call.action==='key.save'),false);clean();
});

test('an old account Key save cannot clear or unlock the new account pending editor',{timeout:60000},async t=>{
  const {page,state,hold,clean}=await harness(t);
  await page.locator('#keyEditor summary').click();const oldSave=hold('key.save');await page.locator('#apiKey').fill('sk-SYNTHETIC-ONE-1122');await page.locator('#saveKey').click();await oldSave.started;
  await page.evaluate(()=>window.changeSettingsAccount('two'));await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#fontTheme').disabled);
  await page.locator('#settingsTab').click();await page.waitForFunction(()=>document.querySelector('#keyState').textContent.includes('未配置'));
  const nextSave=hold('key.save','two'),nextKey='sk-SYNTHETIC-TWO-3344';await page.locator('#apiKey').fill(nextKey);await page.locator('#saveKey').click();await nextSave.started;
  const oldResponse=page.waitForResponse(response=>response.url()===apiOrigin+'/functions/v1/app-api'&&response.request().postDataJSON()?.action==='key.save'&&response.request().headers().authorization==='Bearer one');oldSave.release();await oldResponse;
  assert.equal(await page.locator('#saveKey').isDisabled(),true);assert.equal(await page.locator('#apiKey').inputValue(),nextKey);assert.equal(await page.locator('#keyEditor').evaluate(element=>element.open),true);
  nextSave.release();await page.waitForFunction(()=>!document.querySelector('#saveKey').disabled&&!document.querySelector('#keyEditor').open);
  assert.equal(await page.locator('#apiKey').inputValue(),'');assert.match(await page.locator('#keyDetail').textContent(),/3344/);assert.equal(state.keys.one.last_four,'1122');assert.equal(state.keys.two.last_four,'3344');clean();
});

test('settings and result controls fit three UI languages, four font themes and narrow sidebars',{timeout:90000},async t=>{
  const {page,calls,shot,clean}=await harness(t);
  assert.equal(await page.locator('#notice').isVisible(),false);await shot('settings-configured-zh-refined-390');
  for(const language of ['zh','ja','en']){
    await page.locator('#learnTab').click();await page.locator('#explanationLanguage').selectOption(language);await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);await page.locator('#settingsTab').click();
    for(const theme of ['refined','handwritten','bookish','clean']){
      await page.locator('#fontTheme').selectOption(theme);await page.waitForFunction(()=>!document.querySelector('#fontTheme').disabled);
      for(const width of [320,390]){
        await page.setViewportSize({width,height:844});await page.evaluate(()=>document.fonts.ready);
        const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,sections:['modeFields','fontFields','accountSettings'].map(id=>document.getElementById(id).getBoundingClientRect().top),controls:[...document.querySelectorAll('#settingsView button,#settingsView select,#settingsView input')].filter(element=>element.getClientRects().length&&!element.closest('[hidden]')).map(element=>({id:element.id,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,height:element.getBoundingClientRect().height})),fonts:Object.fromEntries(['modeState','modeSaveState','fontTheme','fontState'].map(id=>[id,getComputedStyle(document.getElementById(id)).fontSize]))}));
        assert.equal(metrics.overflow,false,`${language}/${theme}/${width}`);assert.ok(metrics.sections[0]<metrics.sections[1]&&metrics.sections[1]<metrics.sections[2]);
        for(const control of metrics.controls){assert.ok(control.left>=-1&&control.right<=width+1,JSON.stringify({language,theme,width,control}));assert.ok(control.height>=40,JSON.stringify(control));}
        assert.equal(metrics.controls.find(control=>control.id==='diagnose').height,metrics.controls.find(control=>control.id==='signOut').height,`${language}/${theme}/${width}: account buttons align when one label wraps`);
        assert.equal(metrics.fonts.modeState,'14px');assert.equal(metrics.fonts.modeSaveState,'14px');assert.equal(metrics.fonts.fontTheme,'16px');assert.equal(metrics.fonts.fontState,'14px');
        if(theme==='refined'&&width===320&&language!=='zh')await shot(`settings-${language}-${theme}-${width}`);
      }
    }
    await page.locator('#historyTab').click();await page.locator('.history-card').waitFor();
    const search=await page.evaluate(()=>Object.fromEntries(['search','searchButton'].map(id=>{const element=document.getElementById(id);return [id,{size:getComputedStyle(element).fontSize,height:element.getBoundingClientRect().height}];})));
    assert.deepEqual(search,{search:{size:'15px',height:44},searchButton:{size:'14px',height:44}});
    await page.locator('.history-card').click();await page.locator('#editRecord').waitFor();
    for(const width of [320,390]){
      await page.setViewportSize({width,height:844});const row=await page.evaluate(()=>{const heading=document.querySelector('#recordHeading').getBoundingClientRect(),button=document.querySelector('#editRecord').getBoundingClientRect();return {heading:{top:heading.top,bottom:heading.bottom,right:heading.right},button:{top:button.top,bottom:button.bottom,left:button.left,right:button.right},overflow:document.documentElement.scrollWidth>innerWidth};});
      assert.equal(row.overflow,false);assert.ok(row.button.left>=row.heading.right,'revision action follows the title');assert.ok(row.button.top<row.heading.bottom&&row.button.bottom>row.heading.top,'title and revision action share a row');assert.ok(row.button.right<=width-10,'action respects the content inset');
      if(language==='zh'&&width===390){await page.locator('#settingsTab').click();await page.locator('#fontTheme').selectOption('refined');await page.waitForFunction(()=>!document.querySelector('#fontTheme').disabled);await page.locator('#historyTab').click();await page.locator('.history-card').click();await page.locator('#editRecord').waitFor();await shot('result-title-action-zh-refined-390');}
    }
  }
  assert.equal(calls.some(call=>call.action.startsWith('learning.')),false);clean();
});

test('signed-out settings expose sign-in without a misleading configured Key',{timeout:30000},async t=>{
  const {page,calls,shot,clean}=await harness(t,{signedIn:false});
  assert.equal(await page.locator('#loginFields').isVisible(),true);assert.equal(await page.locator('#apiKey').isVisible(),false);assert.equal(await page.locator('#password').getAttribute('type'),'password');assert.equal(calls.length,0);
  await shot('settings-signed-out-zh-refined-390');clean();
});
