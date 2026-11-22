import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

test('extension uses password login without sending email or persisting the password', {timeout:60000},async t=>{
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify('https://panel-api.example'),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic')}});
  const html=await readFile('extension/panel.html'),css=await readFile('extension/panel.css');
  const server=http.createServer(async(request,response)=>{
    if(request.url.startsWith('/assets/typography/')){const file=path.resolve('shared/typography',request.url.slice('/assets/typography/'.length));if(!file.startsWith(path.resolve('shared/typography')+path.sep)){response.writeHead(403).end();return;}try{response.writeHead(200,{'content-type':path.extname(file)==='.css'?'text/css':'font/woff2'});response.end(await readFile(file));}catch{response.writeHead(404).end();}return;}
    const asset=request.url==='/panel.js'?[bundle.outputFiles[0].text,'text/javascript']:request.url==='/panel.css'?[css,'text/css']:[html,'text/html'];
    response.writeHead(200,{'content-type':asset[1]});response.end(asset[0]);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],logs=[],calls=[];let settings={explanation_mode:'fast',font_theme:'clean'};
  const secondSettings={explanation_mode:'fast',font_theme:'clean'};let rejectFontSave=false,holdSettings=false,releaseSettings,settingsHeld;
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>logs.push(message.text()));
  await page.addInitScript(()=>{
    const stores={local:JSON.parse(sessionStorage.getItem('qa-extension-local')||'{}'),session:{}};window.testStorage=stores;
    const persist=name=>{if(name==='local')sessionStorage.setItem('qa-extension-local',JSON.stringify(stores.local));};
    const area=name=>({async get(keys){if(!keys)return {...stores[name]};return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,stores[name][key]]));},async set(update){Object.assign(stores[name],update);persist(name);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete stores[name][key];persist(name);}});
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(listener){window.testStorageChange=listener;}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(){return {ok:true,result:{}};}}};
  });
  await page.route('https://panel-api.example/**',async route=>{
    const request=route.request(),url=new URL(request.url()),headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    if(request.method()==='OPTIONS'){await route.fulfill({status:200,headers,body:''});return;}
    const body=request.postData()?request.postDataJSON():null;calls.push({path:url.pathname,query:url.search,body});
    if(url.pathname==='/auth/v1/token'){
      const valid=body?.password==='Synthetic good password 42';
      await route.fulfill({status:valid?200:400,headers,body:JSON.stringify(valid?{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,user:{id:'synthetic-user',email:'learner@example.test'}}:{error:'invalid_credentials'})});return;
    }
    if(url.pathname==='/auth/v1/logout'){await route.fulfill({status:200,headers,body:'{}'});return;}
    if(url.pathname==='/functions/v1/app-api'){
      const prefs=request.headers().authorization==='Bearer second-access'?secondSettings:settings;
      if(body.action==='settings.update'&&body.params.font_theme&&rejectFontSave){rejectFontSave=false;await route.fulfill({status:503,headers,body:JSON.stringify({ok:false,error:'NETWORK_ERROR'})});return;}
      if(body.action==='settings.update')Object.assign(prefs,body.params);
      const result=body.action==='key.status'?{configured:false}:body.action==='ping'?{model:'deepseek-flash'}:['settings.get','settings.update'].includes(body.action)?{...prefs}:{};
      if(body.action==='settings.get'&&holdSettings){holdSettings=false;settingsHeld?.();await new Promise(resolve=>{releaseSettings=resolve;});}
      await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});return;
    }
    await route.fulfill({status:400,headers,body:JSON.stringify({error:'unexpected_request'})});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),'refined','signed-out users start with the new default');
  await page.locator('#settingsTab').click();
  assert.equal(await page.locator('#sendOtp,#verifyOtp,#otp').count(),0);
  assert.match(await page.locator('#loginFields').textContent(),/一次性链接/);
  assert.equal(await page.locator('#password').getAttribute('type'),'password');
  await page.locator('#email').fill('learner@example.test');await page.locator('#signIn').click();
  assert.match(await page.locator('#notice').textContent(),/请输入密码/);assert.equal(calls.length,0);
  await page.locator('#password').fill('Synthetic wrong password');await page.locator('#signIn').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('邮箱或密码不正确'));
  assert.equal(await page.locator('#password').inputValue(),'');
  assert.equal(JSON.stringify(await page.evaluate(()=>window.testStorage)).includes('password'),false);
  await page.locator('#password').fill('Synthetic good password 42');await page.locator('#password').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#notice').textContent==='登录成功。');
  assert.equal(await page.locator('#loginFields').isVisible(),false);assert.equal(await page.locator('#keyFields').isVisible(),true);
  assert.equal(await page.locator('#password').inputValue(),'');
  assert.equal(await page.locator('#modeFast').getAttribute('aria-pressed'),'true');
  await page.locator('#modeThinking').click();await page.waitForFunction(()=>document.querySelector('#modeSaveState').textContent.includes('已保存'));
  assert.equal(await page.locator('#modeThinking').getAttribute('aria-pressed'),'true');
  assert.equal(calls.filter(call=>call.body?.action==='settings.update').length,1);
  assert.deepEqual(calls.find(call=>call.body?.action==='settings.update').body.params,{explanation_mode:'thinking'});
  assert.ok(calls.filter(call=>call.body?.action==='settings.get').length>=2);
  assert.equal(calls.some(call=>call.body?.action?.startsWith('learning.')),false);
  const persisted=JSON.stringify(await page.evaluate(()=>window.testStorage));
  assert.equal(persisted.includes('Synthetic'),false);assert.equal(persisted.includes('password'),false);assert.equal(persisted.includes('synthetic-refresh'),true);
  const authCalls=calls.filter(call=>call.path.startsWith('/auth/'));
  assert.equal(authCalls.length,2);assert.ok(authCalls.every(call=>call.path==='/auth/v1/token'&&call.query==='?grant_type=password'));
  assert.equal(authCalls[1].body.email,'learner@example.test');assert.equal(authCalls[1].body.password,'Synthetic good password 42');
  assert.equal(JSON.stringify(logs).includes('Synthetic'),false);
  assert.equal(await page.getByRole('heading',{name:'字体外观',exact:true}).count(),1);
  const fontSelect=page.getByLabel('字体外观',{exact:true});assert.equal(await fontSelect.inputValue(),'clean');
  assert.deepEqual(await fontSelect.locator('option').evaluateAll(options=>options.map(option=>option.value)),['handwritten','bookish','clean','refined']);
  for(const theme of ['handwritten','bookish','clean','refined']){
    const start=calls.length;await fontSelect.selectOption(theme);
    await page.waitForFunction(value=>document.querySelector('#fontTheme').value===value&&!document.querySelector('#fontTheme').disabled,theme);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),theme);
    assert.deepEqual(calls.slice(start).map(call=>call.body?.action),['settings.update','settings.get']);
    assert.deepEqual(calls[start].body.params,{font_theme:theme});
    if(process.env.LINGO_FONT_SCREENSHOTS==='1'){
      const directory=path.resolve('.cache/refined-ui');await mkdir(directory,{recursive:true});
      for(const width of [320,390]){await page.setViewportSize({width,height:844});await page.evaluate(()=>document.fonts.ready);await page.locator('#fontFields').evaluate(element=>window.scrollTo(0,element.getBoundingClientRect().top+window.scrollY-110));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.screenshot({path:path.join(directory,`extension-${theme}-${width}.png`)});}
    }
  }
  await page.reload();await page.waitForFunction(()=>document.querySelector('#fontTheme').value==='refined'&&!document.querySelector('#fontTheme').disabled);
  await page.locator('#settingsTab').click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),'refined','the new theme persists after reopening');
  delete settings.font_theme;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('#fontTheme').value==='refined'&&!document.querySelector('#fontTheme').disabled);
  await fontSelect.selectOption('clean');await page.waitForFunction(()=>document.querySelector('#fontTheme').value==='clean'&&!document.querySelector('#fontTheme').disabled);
  rejectFontSave=true;await fontSelect.selectOption('handwritten');
  await page.waitForFunction(()=>document.querySelector('#fontState').textContent.includes('已恢复上次设置'));
  assert.equal(await fontSelect.inputValue(),'clean');assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),'clean');
  settings.font_theme='bookish';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.documentElement.dataset.fontTheme==='bookish');
  const heldRead=new Promise(resolve=>{settingsHeld=resolve;});holdSettings=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await heldRead;
  await page.evaluate(()=>{const key='lingo-session:https://panel-api.example';const value=JSON.stringify({access_token:'second-access',refresh_token:'second-refresh',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'second-user',email:'second@example.test'}});window.testStorage.local[key]=value;window.testStorageChange({[key]:{newValue:value}},'local');});
  await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('second@example.test')&&!document.querySelector('#fontTheme').disabled);
  assert.equal(await fontSelect.inputValue(),'clean','the next account starts with its own preference');
  releaseSettings();await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),'clean','a previous account settings response cannot overwrite the new account');
  await page.locator('#signOut').click();await page.waitForFunction(()=>document.querySelector('#loginFields').hidden===false);
  assert.deepEqual(await page.evaluate(()=>window.testStorage.local),{});assert.equal(await page.evaluate(()=>document.documentElement.dataset.fontTheme),'refined');assert.equal(await page.locator('#password').inputValue(),'');
  assert.deepEqual(errors,[]);
});
