import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const origin='https://panel-review.example';
const record=id=>({record_id:id,revision:1,status:'complete',input_type:'text',local_date:'2026-11-22',original_text:id==='first'?'少しずつ上達しています。':'Every small step counts.',explanation_language:'zh',result:{language:'ja',explanation_language:'zh',summary_zh:'每天前进一步，学习也会逐渐积累。',vocabulary:[{term:'上達',reading:'じょうたつ',pos:'名词',meaning:'进步；熟练程度提高',examples:[{text:'毎日練習すると、上達します。',translation:'每天练习，就会进步。'}]}],grammar:[{point:'〜ています：持续的变化',explanation:'这里表示变化正在持续。',examples:[{text:'少しずつ日本語が上達しています。',translation:'日语正在一点点进步。'}]}]}});
const cards=(id,owner='one')=>['vocabulary','grammar'].map((kind,slot)=>{const lesson=record(id).result,point=slot===0?lesson.vocabulary[0]:lesson.grammar[0];return {id:owner+'-'+id+'-'+slot,record_id:id,slot,point_key:'shared-point-'+slot,kind,term:point.term??point.point,meaning:point.meaning??point.explanation,reading:point.reading??'',pos:point.pos??'',language:lesson.language,explanation_language:lesson.explanation_language,mastered:false,mastered_at:null,review_round:0,next_due_date:'2026-11-23',completed:false};});
async function harness(t){
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify(origin),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic')}});
  const server=http.createServer(async(req,res)=>{try{
    const pathname=new URL(req.url,'http://localhost').pathname;let file=pathname==='/panel.js'?null:pathname==='/panel.css'?'extension/panel.css':'extension/panel.html';
    if(pathname.startsWith('/assets/')){const typography=pathname.startsWith('/assets/typography/'),root=path.resolve(typography?'shared/typography':'extension/assets');file=path.resolve(root,pathname.slice(typography?'/assets/typography/'.length:'/assets/'.length));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}}
    res.writeHead(200,{'content-type':!file?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/html'});res.end(file?await readFile(file):bundle.outputFiles[0].text);
  }catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});const pending=[];
  t.after(async()=>{for(const gate of pending)gate.release();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:390,height:844}}),calls=[],errors=[],unexpected=[],gates=[];
  const state={settings:{one:{font_theme:'refined',explanation_language:'zh',explanation_mode:'fast',review_daily_limit:5},two:{font_theme:'clean',explanation_language:'zh',explanation_mode:'fast',review_daily_limit:12}},cards:{one:{first:cards('first'),second:cards('second')},two:{first:cards('first','two'),second:cards('second','two')}},fail:new Map(),wrongReadback:false};
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({origin})=>{
    const session=owner=>JSON.stringify({access_token:owner,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:owner,email:owner+'@example.test'}});
    const stores={local:{['lingo-session:'+origin]:session('one')},session:{}};
    const area=name=>({async get(keys){return keys?Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,stores[name][key]])):{...stores[name]};},async set(value){Object.assign(stores[name],value);},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete stores[name][key];}});
    window.reviewAccount=owner=>{const key='lingo-session:'+origin,value=session(owner);stores.local[key]=value;window.reviewStorageChange({[key]:{newValue:value}},'local');};window.reviewMessages=[];
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(fn){window.reviewStorageChange=fn;}}},runtime:{connect(){return {onMessage:{addListener(){}}};},async sendMessage(message){window.reviewMessages.push(message);return {ok:true,result:{context:'Synthetic surrounding sentence.',status:'matched',source:{title:'Synthetic article',url:'https://example.test/article'},binding:{tabId:42,url:'https://example.test/article',nonce:'test'}}};}}};
  },{origin});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.hostname==='127.0.0.1')return route.continue();if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};if(request.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    const body=request.postDataJSON(),owner=request.headers().authorization==='Bearer two'?'two':'one';calls.push({owner,...body});
    if(body.action.startsWith('learning.')){unexpected.push(body.action);return route.abort();}
    const code=state.fail.get(body.action);if(code){state.fail.delete(body.action);return route.fulfill({status:409,headers,body:JSON.stringify({ok:false,error:code})});}
    let result={};
    if(body.action==='settings.get')result={...state.settings[owner]};
    else if(body.action==='settings.update'){if(!state.wrongReadback)Object.assign(state.settings[owner],body.params);result={...state.settings[owner]};}
    else if(body.action==='key.status')result={configured:true,last_four:'1234'};
    else if(body.action==='ping')result={protocol:'cloud/5',model:'deepseek-flash'};
    else if(body.action==='records.history')result={items:['first','second'].map(id=>({...record(id),text:record(id).original_text})),has_more:false};
    else if(body.action==='records.get')result=record(body.params.record_id);
    else if(body.action==='review.cards')result={cards:structuredClone(state.cards[owner][body.params.record_id])};
    else if(body.action==='review.mastery'){
      const all=Object.values(state.cards[owner]).flat(),card=all.find(card=>card.id===body.params.card_id);assert.equal(card?.point_key,body.params.point_key);
      for(const item of all)if(item.point_key===card.point_key)Object.assign(item,{mastered:body.params.mastered,mastered_at:body.params.mastered?'2026-11-22T10:00:00Z':null});result={card:structuredClone(card)};
    }else{unexpected.push(body.action);return route.abort();}
    const index=gates.findIndex(g=>g.owner===owner&&g.action===body.action&&g.match(body.params??{}));if(index>=0){const gate=gates.splice(index,1)[0];gate.startedResolve();await gate.promise;}
    try{await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});}catch{/* Held responses may outlive a test page. */}
  });
  const hold=(action,{owner='one',match=()=>true}={})=>{const gate={owner,action,match};gate.started=new Promise(resolve=>{gate.startedResolve=resolve;});gate.promise=new Promise(resolve=>{gate.release=resolve;});pending.push(gate);gates.push(gate);return gate;};
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled&&!document.querySelector('#reviewDailyLimit').disabled);
  const open=async(id='first')=>{await page.locator('#historyTab').click();await page.locator('.history-card').filter({hasText:record(id).original_text}).click();await page.locator('#recordSection').waitFor();};
  const readyCards=()=>page.waitForFunction(()=>[...document.querySelectorAll('.mastery-toggle')].filter(b=>!b.hidden).length===2);
  const shot=async name=>{if(process.env.LINGO_REVIEW_SCREENSHOTS==='1'){await mkdir('.cache/review-controls-extension/screenshots',{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`.cache/review-controls-extension/screenshots/${name}.png`,fullPage:true});}};
  const clean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(calls.some(call=>call.action.startsWith('learning.')),false);};
  return {page,state,calls,hold,open,readyCards,shot,clean};
}

test('integrated composer fits three languages and four font themes at 320/390; empty drafts hide material details',{timeout:90000},async t=>{
  const {page,shot,clean}=await harness(t);
  assert.equal(await page.locator('#draftDetails').isVisible(),false);assert.equal(await page.locator('#send').isDisabled(),true);
  for(const language of ['zh','ja','en']){
    await page.locator('#explanationLanguage').selectOption(language);await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);await page.locator('#notice').evaluate(e=>{e.hidden=true;});
    for(const theme of ['refined','handwritten','bookish','clean'])for(const width of [390,320]){
      await page.setViewportSize({width,height:844});await page.evaluate(theme=>{document.documentElement.dataset.fontTheme=theme;},theme);await page.evaluate(()=>document.fonts.ready);
      const layout=await page.evaluate(()=>{const rect=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,size:getComputedStyle(e).fontSize};};return {overflow:document.documentElement.scrollWidth>innerWidth,source:rect('sourceText'),send:rect('send'),tools:['capture','filePick','explanationLanguage'].map(rect),integrated:['sourceText','capture','filePick','explanationLanguage'].every(id=>document.getElementById(id).closest('.composer-input')),icons:[...document.querySelectorAll('.input-tools img')].every(i=>i.complete&&i.naturalWidth>0)};});
      assert.equal(layout.overflow,false,`${language}/${theme}/${width}`);assert.ok(layout.integrated);assert.ok(layout.icons);assert.equal(layout.send.size,'15px');assert.equal(layout.source.size,'15px');
      assert.ok(Math.abs(layout.source.width-layout.send.width)<3);assert.ok(layout.send.top>=Math.max(...layout.tools.map(r=>r.bottom))+12);
      for(const control of layout.tools){assert.ok(control.height>=44);assert.ok(control.left>=0&&control.right<=width);assert.equal(control.size,'15px');}
      if(theme==='refined')await shot(`composer-empty-${language}-${width}`);
    }
  }
  await page.locator('#explanationLanguage').selectOption('zh');await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);await page.setViewportSize({width:390,height:844});await page.locator('#sourceText').fill('少しずつ上達しています。');await page.locator('#draftDetails').waitFor();assert.equal(await page.locator('#send').isDisabled(),false);
  await page.waitForFunction(()=>document.querySelector('#contextStatus').textContent.includes('已从原网页'));await shot('composer-filled-zh-390');await page.locator('#learnTab').click();assert.equal(await page.locator('#draftDetails').isVisible(),false);assert.equal(await page.locator('#send').isDisabled(),true);clean();
});

test('review limit validates 1–100 and requires explicit save plus readback without changing other settings',{timeout:45000},async t=>{
  const {page,state,calls,hold,shot,clean}=await harness(t);await page.locator('#settingsTab').click();assert.equal(await page.locator('#reviewDailyLimit').inputValue(),'5');
  for(const value of ['', '0','1.5','101']){await page.locator('#reviewDailyLimit').fill(value);await page.locator('#saveReviewLimit').click();await page.waitForFunction(()=>document.querySelector('#reviewLimitState').textContent.includes('1–100'));}
  assert.equal(calls.some(c=>c.action==='settings.update'),false);
  await page.locator('#reviewDailyLimit').fill('16');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await page.locator('#reviewDailyLimit').inputValue(),'16');assert.equal(state.settings.one.review_daily_limit,5);
  const gate=hold('settings.update');await page.locator('#saveReviewLimit').click();await gate.started;assert.equal(await page.locator('#reviewDailyLimit').isDisabled(),true);assert.match(await page.locator('#reviewLimitState').textContent(),/正在保存/);gate.release();await page.waitForFunction(()=>document.querySelector('#reviewLimitState').textContent==='复习数量已保存。');
  assert.equal(state.settings.one.review_daily_limit,16);assert.deepEqual(calls.filter(c=>c.action==='settings.update').map(c=>c.params),[{review_daily_limit:16}]);assert.equal(state.settings.one.font_theme,'refined');assert.equal(state.settings.one.explanation_mode,'fast');await shot('settings-review-limit-zh-390');clean();
});

test('review limit failed/unconfirmed saves retain typed value; old account completion cannot overwrite a new save',{timeout:60000},async t=>{
  const {page,state,hold,clean}=await harness(t);await page.locator('#settingsTab').click();
  state.fail.set('settings.update','NETWORK_ERROR');await page.locator('#reviewDailyLimit').fill('8');await page.locator('#saveReviewLimit').click();await page.waitForFunction(()=>!document.querySelector('#saveReviewLimit').disabled);assert.equal(await page.locator('#reviewDailyLimit').inputValue(),'8');assert.match(await page.locator('#reviewLimitState').textContent(),/未能确认/);
  state.wrongReadback=true;await page.locator('#saveReviewLimit').click();await page.waitForFunction(()=>!document.querySelector('#saveReviewLimit').disabled);assert.match(await page.locator('#reviewLimitState').textContent(),/未能确认/);state.wrongReadback=false;
  const old=hold('settings.update');await page.locator('#saveReviewLimit').click();await old.started;await page.evaluate(()=>window.reviewAccount('two'));await page.waitForFunction(()=>!document.querySelector('#reviewDailyLimit').disabled&&document.querySelector('#reviewDailyLimit').value==='12');
  const next=hold('settings.update',{owner:'two'});await page.locator('#reviewDailyLimit').fill('24');await page.locator('#saveReviewLimit').click();await next.started;old.release();await page.waitForTimeout(50);assert.equal(await page.locator('#reviewDailyLimit').inputValue(),'24');assert.equal(await page.locator('#saveReviewLimit').isDisabled(),true);next.release();await page.waitForFunction(()=>document.querySelector('#reviewLimitState').textContent==='复习数量已保存。');assert.equal(state.settings.two.review_daily_limit,24);clean();
});

test('remembered marks are confirmed by server, shared by point, reversible, and do not request a model',{timeout:45000},async t=>{
  const {page,state,calls,hold,open,readyCards,shot,clean}=await harness(t);await open();await readyCards();const button=page.locator('.mastery-toggle').first();assert.equal(await button.getAttribute('aria-pressed'),'false');
  const gate=hold('review.mastery');await button.click();await gate.started;assert.equal(await button.getAttribute('aria-pressed'),'false');assert.equal(await button.isDisabled(),true);assert.match(await button.textContent(),/正在保存/);gate.release();await page.waitForFunction(()=>document.querySelector('.mastery-toggle').getAttribute('aria-pressed')==='true');
  assert.deepEqual(calls.find(c=>c.action==='review.mastery').params,{card_id:'one-first-0',point_key:'shared-point-0',mastered:true});assert.equal(await page.locator('.mastery-toggle').nth(1).getAttribute('aria-pressed'),'false');await shot('remembered-zh-390');
  await open('second');await readyCards();assert.equal(await button.getAttribute('aria-pressed'),'true','same learning point uses server state across records');await button.click();await page.waitForFunction(()=>document.querySelector('.mastery-toggle').getAttribute('aria-pressed')==='false');assert.equal(state.cards.one.first[0].mastered,false);assert.equal(calls.filter(c=>c.action==='review.mastery').length,2);clean();
});

test('review metadata failure preserves explanations and retries; revised-point errors do not falsely mark mastery',{timeout:45000},async t=>{
  const {page,state,calls,open,readyCards,clean}=await harness(t);state.fail.set('review.cards','NETWORK_ERROR');await open();await page.locator('.review-control-status').waitFor();assert.match(await page.locator('.lesson-overview').textContent(),/每天/);assert.match(await page.locator('.review-control-status').textContent(),/暂时无法/);assert.equal(await page.locator('.mastery-toggle').first().isVisible(),false);
  await page.locator('.review-control-status button').click();await readyCards();state.fail.set('review.mastery','CARD_CHANGED');await page.locator('.mastery-toggle').first().click();await page.waitForFunction(()=>document.querySelector('.review-control-status').textContent.includes('学习点已更新'));assert.equal(await page.locator('.mastery-toggle').first().getAttribute('aria-pressed'),'false');assert.equal(state.cards.one.first[0].mastered,false);assert.equal(calls.filter(c=>c.action==='review.mastery').length,1);clean();
});

test('late point reads cannot contaminate another record or account; switching records waits for pending mastery',{timeout:60000},async t=>{
  const {page,state,hold,open,readyCards,clean}=await harness(t);state.cards.one.first[0].mastered=true;const oldRead=hold('review.cards',{match:p=>p.record_id==='first'});await open();await oldRead.started;await open('second');await readyCards();oldRead.release();await page.waitForTimeout(50);assert.equal(await page.locator('.mastery-toggle').first().getAttribute('aria-pressed'),'false');
  const mutation=hold('review.mastery');await page.locator('.mastery-toggle').first().click();await mutation.started;await open('first');assert.equal(await page.locator('.mastery-toggle').first().isVisible(),false);mutation.release();await readyCards();assert.equal(await page.locator('.mastery-toggle').first().getAttribute('aria-pressed'),'true');
  const oldMutation=hold('review.mastery');await page.locator('.mastery-toggle').first().click();await oldMutation.started;await page.evaluate(()=>window.reviewAccount('two'));await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#explanationLanguage').disabled);await open();await readyCards();oldMutation.release();await page.waitForTimeout(50);assert.equal(await page.locator('.mastery-toggle').first().getAttribute('aria-pressed'),'false');assert.equal(state.cards.two.first[0].mastered,false);clean();
});

test('new metadata in a reused slot cannot attach to older wording, part of speech, or explanation language',{timeout:45000},async t=>{
  const {page,state,calls,open,clean}=await harness(t);const original=structuredClone(state.cards.one.first);
  for(const change of [{term:'changed term'},{pos:'动词'},{explanation_language:'en'}]){
    state.cards.one.first=structuredClone(original);Object.assign(state.cards.one.first[0],change);await open();await page.waitForFunction(()=>document.querySelector('.review-control-status').textContent.includes('学习点已更新'));
    assert.equal(await page.locator('.mastery-toggle').first().isVisible(),false);assert.equal(await page.locator('.mastery-toggle').nth(1).isVisible(),true);assert.equal(await page.locator('.term-text').textContent(),'上達');
  }
  assert.equal(calls.some(c=>c.action==='review.mastery'),false);clean();
});
