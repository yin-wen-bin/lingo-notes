import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const apiOrigin='https://panel-navigation.example';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const lesson={language:'en',explanation_language:'zh',summary_zh:'Synthetic saved lesson.',vocabulary:[{term:'practice',reading:'/ˈpræktɪs/',pos:'名词',meaning:'合成练习说明',examples:[{text:'We practise every day.',translation:'我们每天练习。'}]}],grammar:[]};
const makeRecord=(id,text,status='complete')=>({record_id:id,revision:1,status,input_type:'text',local_date:'2026-11-21',original_text:text,context:'Saved synthetic context.',context_meta:{status:'matched'},explanation_language:'zh',result:status==='complete'?lesson:null});

async function harness(t,{restoreProcessing=false,holdAccepted=false}={}){
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
  const page=await browser.newPage({viewport:{width:390,height:600}}),calls=[],errors=[],unexpected=[],gates=new Map(),pendingGates=new Set();
  const records=new Map(Array.from({length:12},(_,i)=>{const id='old-'+i;return [id,makeRecord(id,`Synthetic alpha note ${String(i+1).padStart(2,'0')}`)];}));
  if(restoreProcessing)records.set('pending',makeRecord('pending','Synthetic pending source.','processing'));
  const state={records,secondRecords:new Map([['two-note',makeRecord('two-note','Only second account material.')]]),settings:{one:{font_theme:'refined',explanation_language:'zh'},two:{font_theme:'clean',explanation_language:'zh'}},pageSize:4};
  await page.exposeFunction('navSaveStreamRecord',record=>{state.records=new Map([[record.record_id,record],...[...state.records].filter(([id])=>id!==record.record_id)]);});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({apiOrigin,png,lesson,restoreProcessing,holdAccepted})=>{
    const session={access_token:'one',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:'one',email:'one@example.test'}};
    const saved=sessionStorage.getItem('synthetic-navigation-storage'),stores=saved?JSON.parse(saved):{local:{['lingo-session:'+apiOrigin]:JSON.stringify(session)},session:{}};
    if(restoreProcessing&&!saved)stores.session['panel:one']={last_record_id:'pending',panel_state:{view:'record'}};
    window.navStores=stores;window.navCalls=[];window.navStreams=[];
    const persist=()=>sessionStorage.setItem('synthetic-navigation-storage',JSON.stringify(stores));
    const area=name=>({async get(keys){return keys?Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,stores[name][key]])):{...stores[name]};},async set(value){Object.assign(stores[name],value);persist();},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete stores[name][key];persist();}});
    const source={title:'Synthetic source',url:'https://example.test/synthetic'},binding={tabId:42,url:source.url,nonce:'synthetic-binding'};
    window.chrome={storage:{local:area('local'),session:area('session'),onChanged:{addListener(fn){window.navStorageChanged=fn;}}},runtime:{connect(){return {onMessage:{addListener(fn){window.navPortMessage=fn;}}};},async sendMessage(message){if(message.kind==='capture'){if(window.navHoldCapture){window.navCaptureStarted=true;await new Promise(resolve=>{window.navReleaseCapture=resolve;});}return {ok:true,result:{image:png,binding,source}};}return {ok:true,result:{context:'Synthetic nearby context.',status:'matched',binding,source}};}}};
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input.url;
      if(url===apiOrigin+'/functions/v1/app-api'){
        const body=JSON.parse(init.body);window.navCalls.push(body);
        if(body.action==='learning.submit'){
          const record={record_id:body.params.record_id,request_id:body.request_id,revision:1,status:'processing',input_type:'text',original_text:body.params.text,context:body.params.context,local_date:'2026-11-21',explanation_language:'zh',result:null};
          window.navStreamRecord=record;await window.navSaveStreamRecord(record);
          let controller,accepted=false;const encoder=new TextEncoder();
          const event=(type,value)=>encoder.encode('event: '+type+'\ndata: '+JSON.stringify({request_id:body.request_id,record_id:record.record_id,revision:1,...value})+'\n\n');
          const held=holdAccepted&&window.navStreams.length===0;
          const releaseAccepted=()=>{if(!accepted){accepted=true;controller.enqueue(event('accepted',{sequence:1,record}));}};
          const streamState={record,releaseAccepted,aborted:false};window.navStreams.push(streamState);init.signal.addEventListener('abort',()=>{streamState.aborted=true;},{once:true});
          const stream=new ReadableStream({start(value){controller=value;if(!held)releaseAccepted();}});
          window.navPreview=()=>controller.enqueue(event('progress',{sequence:2,preview:lesson}));
          window.navComplete=async()=>{const complete={...record,status:'complete',result:lesson};window.navStreamRecord=complete;await window.navSaveStreamRecord(complete);controller.enqueue(event('complete',{sequence:3,record:complete}));controller.close();};
          return new Response(stream,{headers:{'content-type':'text/event-stream'}});
        }
      }
      return nativeFetch(input,init);
    };
  },{apiOrigin,png,lesson,restoreProcessing,holdAccepted});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(url.hostname==='127.0.0.1')return route.continue();
    if(url.origin!==apiOrigin){unexpected.push(request.url());return route.abort();}
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    if(request.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    if(url.pathname==='/auth/v1/logout')return route.fulfill({status:200,headers,body:'{}'});
    const body=request.postDataJSON();calls.push(body);const owner=request.headers().authorization==='Bearer two'?'two':'one',store=owner==='one'?state.records:state.secondRecords;let result={};
    if(body.action==='settings.get')result={...state.settings[owner]};
    else if(body.action==='settings.update'){Object.assign(state.settings[owner],body.params);result={...state.settings[owner]};}
    else if(body.action==='records.history'){
      const query=(body.params.query??'').toLowerCase(),offset=body.params.offset??0,items=[...store.values()].filter(record=>record.original_text.toLowerCase().includes(query));
      result={items:items.slice(offset,offset+state.pageSize).map(record=>({...record,text:record.original_text})),has_more:offset+state.pageSize<items.length};
    }else if(body.action==='records.get'){
      result=structuredClone(store.get(body.params.record_id)??null);
      const gate=gates.get(body.params.record_id);if(gate){gates.delete(body.params.record_id);gate.startedResolve();await gate.releasePromise;}
    }else if(body.action==='records.delete'){store.delete(body.params.record_id);result={deleted:true};}
    else if(body.action==='key.status')result={configured:true};
    else if(body.action==='review.cards')result={cards:[]};
    else if(body.action==='ping')result={protocol:'cloud/4'};
    else if(body.action.startsWith('learning.'))throw Error('Unexpected model request from navigation');
    try{await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});}catch{/* Page may close after a deliberately held read. */}
  });
  const holdRecord=id=>{
    const gate={};gate.started=new Promise(resolve=>{gate.startedResolve=resolve;});gate.releasePromise=new Promise(resolve=>{gate.release=resolve;});gates.set(id,gate);pendingGates.add(gate);return gate;
  };
  t.after(()=>{for(const gate of pendingGates)gate.release();});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if(restoreProcessing)await page.locator('#cancelJob').waitFor();else await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  const selected=async id=>{assert.equal(await page.locator('#'+id).getAttribute('aria-current'),'page');assert.equal(await page.locator('nav [aria-current="page"]').count(),1);assert.equal(await page.locator('#'+id).evaluate(element=>element.classList.contains('is-active')),true);};
  const historyCount=()=>calls.filter(call=>call.action==='records.history').length;
  const openHistory=async()=>{await page.locator('#historyTab').click();await page.locator('.history-card').first().waitFor();await selected('historyTab');};
  const screenshot=async name=>{if(process.env.LINGO_NAV_SCREENSHOTS==='1'){await mkdir('.cache/navigation-ui',{recursive:true});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'.cache/navigation-ui/'+name+'.png',fullPage:true});}};
  const clean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);};
  return {page,state,calls,errors,unexpected,selected,historyCount,openHistory,holdRecord,screenshot,clean};
}

test('history and settings preserve the hidden draft; New explicitly clears text, context and image preview',{timeout:60000},async t=>{
  const {page,selected,openHistory,screenshot,clean}=await harness(t);
  assert.equal(await page.locator('#menu,.tagline,#backFromHistory,#backFromSettings').count(),0);await selected('learnTab');
  await page.locator('#learnTab').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#historyTab').evaluate(element=>element===document.activeElement),true);
  assert.equal(await page.locator('#historyTab').evaluate(element=>{const style=getComputedStyle(element);return style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>=2;}),true,'keyboard navigation keeps a visible focus outline');
  await page.keyboard.press('Tab');assert.equal(await page.locator('#settingsTab').evaluate(element=>element===document.activeElement),true);await page.keyboard.press('Enter');await selected('settingsTab');
  await page.locator('#learnTab').click();await page.locator('#sourceText').fill('Preserve this unsent draft.');
  await page.waitForFunction(()=>document.querySelector('#draftContext').textContent==='Synthetic nearby context.');
  await openHistory();await screenshot('history');assert.ok((await page.locator('#historyHeading').boundingBox()).width<=1);
  await page.locator('#settingsTab').click();await selected('settingsTab');assert.ok((await page.locator('#settingsHeading').boundingBox()).width<=1);await screenshot('settings');
  assert.equal(await page.locator('#sourceText').inputValue(),'Preserve this unsent draft.');assert.equal(await page.locator('#draftContext').textContent(),'Synthetic nearby context.');
  assert.equal(await page.locator('#learnTab').textContent(),'新建');assert.equal(await page.locator('#newNote,#newDraft').count(),0);
  await page.locator('#learnTab').click();assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#draftContext').textContent(),'');
  assert.equal(await page.locator('#sourceText').evaluate(element=>element===document.activeElement),true);
  await page.locator('#sourceText').fill('Draft before image preview.');
  await page.locator('#capture').click();await page.locator('#imageStage').waitFor();const preview=await page.locator('#cropPreview').getAttribute('src');
  await screenshot('image-preview');await openHistory();await page.locator('#settingsTab').click();
  assert.equal(await page.locator('#cropPreview').getAttribute('src'),preview);assert.equal(await page.locator('#sourceText').inputValue(),'Draft before image preview.');
  await page.locator('#learnTab').click();assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#cropPreview').getAttribute('src'),null);assert.equal(await page.locator('#imageStage').isVisible(),false);await selected('learnTab');await screenshot('compose');
  assert.equal(await page.evaluate(()=>window.navCalls.some(call=>call.action.startsWith('learning.'))),false);clean();
});

test('history detail returns to the same query, loaded pages and scroll without replacing the original draft',{timeout:60000},async t=>{
  const {page,selected,historyCount,openHistory,screenshot,clean}=await harness(t);
  await page.locator('#sourceText').fill('Original workbench draft.');await page.waitForFunction(()=>document.querySelector('#draftContext').textContent==='Synthetic nearby context.');
  await openHistory();await page.locator('#search').fill('alpha');await page.locator('#searchButton').click();
  await page.locator('#more').click();await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===8);
  await page.evaluate(()=>window.scrollTo(0,220));const scroll=await page.evaluate(()=>window.scrollY),requests=historyCount();
  await page.locator('.history-card').nth(3).click();await page.locator('#backToHistory').waitFor();await selected('historyTab');assert.equal(await page.locator('#recordOriginal').textContent(),'Synthetic alpha note 04');await screenshot('history-detail');
  await page.locator('#backToHistory').click();await page.locator('#historyView').waitFor();assert.equal(await page.locator('#search').inputValue(),'alpha');assert.equal(await page.locator('.history-row').count(),8);assert.equal(historyCount(),requests);assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scroll)<=1);
  await page.locator('.history-card').nth(3).click();await page.locator('#backToHistory').waitFor();await page.locator('#learnTab').click();
  assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#draftContext').textContent(),'');await selected('learnTab');
  await page.locator('#historyTab').click();assert.equal(await page.locator('#search').inputValue(),'alpha');assert.equal(await page.locator('.history-row').count(),8);assert.equal(historyCount(),requests);clean();
});

test('late history reads cannot hijack another tab or restore another account snapshot',{timeout:60000},async t=>{
  const {page,selected,openHistory,holdRecord,clean}=await harness(t);
  await page.locator('#sourceText').fill('Only first account draft.');await openHistory();
  const first=holdRecord('old-0');await page.locator('.history-card').first().click();await first.started;
  await page.locator('#settingsTab').click();await selected('settingsTab');const firstResponse=page.waitForResponse(response=>response.url()===apiOrigin+'/functions/v1/app-api'&&response.request().postDataJSON()?.action==='records.get');first.release();await firstResponse;await selected('settingsTab');assert.equal(await page.locator('#settingsView').isVisible(),true);
  await page.locator('#historyTab').click();const previous=holdRecord('old-0');await page.locator('.history-card').first().click();await previous.started;
  await page.evaluate(()=>{const key='lingo-session:https://panel-navigation.example',value=JSON.stringify({access_token:'two',refresh_token:'synthetic-two',expires_at:Date.now()/1000+3600,user:{id:'two',email:'two@example.test'}});window.navStores.local[key]=value;window.navStorageChanged({[key]:{newValue:value}},'local');});
  await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#explanationLanguage').disabled);
  const staleResponse=page.waitForResponse(response=>response.url()===apiOrigin+'/functions/v1/app-api'&&response.request().postDataJSON()?.action==='records.get');previous.release();await staleResponse;await page.locator('#learnTab').click();assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#backToHistory').isVisible(),false);
  await openHistory();assert.deepEqual(await page.locator('.history-text').allTextContents(),['Only second account material.']);clean();
});

test('delayed capture preserves the current settings tab and original draft when its preview arrives',{timeout:60000},async t=>{
  const {page,selected,clean}=await harness(t);
  await page.locator('#sourceText').fill('Draft before the delayed capture.');await page.waitForFunction(()=>document.querySelector('#draftContext').textContent==='Synthetic nearby context.');
  await page.evaluate(()=>{window.navHoldCapture=true;});await page.locator('#capture').click();await page.waitForFunction(()=>window.navCaptureStarted);
  await page.locator('#settingsTab').click();await selected('settingsTab');await page.evaluate(()=>window.navReleaseCapture());
  await page.waitForFunction(()=>document.querySelector('#cropPreview').getAttribute('src')?.startsWith('data:image/png'));await selected('settingsTab');assert.equal(await page.locator('#settingsView').isVisible(),true);
  assert.equal(await page.locator('#cropPreview').getAttribute('src'),png);assert.equal(await page.locator('#sourceText').inputValue(),'Draft before the delayed capture.');
  await page.locator('#learnTab').click();assert.equal(await page.locator('#imageStage').isVisible(),false);assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#draftContext').textContent(),'');
  await page.evaluate(()=>{window.navCaptureStarted=false;});await page.locator('#capture').click();await page.waitForFunction(()=>window.navCaptureStarted);await page.locator('#learnTab').click();await page.evaluate(()=>window.navReleaseCapture());
  await page.waitForFunction(()=>!document.querySelector('#capture').disabled);assert.equal(await page.locator('#sourceText').inputValue(),'');assert.equal(await page.locator('#cropPreview').getAttribute('src'),null);assert.equal(await page.locator('#composer').isVisible(),true);await selected('learnTab');
  assert.equal(await page.evaluate(()=>window.navCalls.some(call=>call.action.startsWith('learning.'))),false);clean();
});

test('reopening the sidebar from a history detail restores the saved workbench draft and context',{timeout:60000},async t=>{
  const {page,calls,selected,openHistory,clean}=await harness(t);
  await page.locator('#sourceText').fill('Draft that must survive a sidebar restart.');await page.waitForFunction(()=>document.querySelector('#draftContext').textContent==='Synthetic nearby context.');
  await openHistory();await page.locator('.history-card').first().click();await page.locator('#backToHistory').waitFor();await selected('historyTab');
  assert.equal(await page.locator('#recordOriginal').textContent(),'Synthetic alpha note 01');
  const recordReads=calls.filter(call=>call.action==='records.get').length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);await selected('learnTab');
  assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),'Draft that must survive a sidebar restart.');assert.equal(await page.locator('#draftContext').textContent(),'Synthetic nearby context.');
  assert.equal(await page.locator('#backToHistory').isVisible(),false);assert.equal(calls.filter(call=>call.action==='records.get').length,recordReads);assert.equal(calls.some(call=>call.action.startsWith('learning.')),false);clean();
});

test('background learning progress and completion do not steal navigation from history or settings',{timeout:60000},async t=>{
  const {page,selected,openHistory,clean}=await harness(t);
  await page.locator('#sourceText').fill('Synthetic streamed learning source.');await page.locator('#send').click();await page.locator('#cancelJob').waitFor();
  await openHistory();await page.evaluate(()=>window.navPreview());await page.waitForFunction(()=>document.querySelector('.lesson-overview')?.textContent==='Synthetic saved lesson.');await selected('historyTab');assert.equal(await page.locator('#historyView').isVisible(),true);
  await page.locator('#settingsTab').click();await page.evaluate(()=>window.navComplete());await page.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='complete');await selected('settingsTab');assert.equal(await page.locator('#settingsView').isVisible(),true);
  await page.locator('#learnTab').click();assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),'');
  await openHistory();await page.locator('.history-card').filter({hasText:'Synthetic streamed learning source.'}).click();await page.locator('#backToHistory').waitFor();assert.equal(await page.locator('.lesson-overview').textContent(),'Synthetic saved lesson.');
  assert.equal(await page.evaluate(()=>window.navCalls.filter(call=>call.action==='learning.submit').length),1);clean();
});

test('explicit history entry refreshes a dirty server window while preserving its search, loaded pages and scroll',{timeout:60000},async t=>{
  const {page,calls,selected,openHistory,clean}=await harness(t);
  await openHistory();await page.locator('#search').fill('Synthetic');await page.locator('#searchButton').click();await page.locator('#more').click();await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===8);
  await page.evaluate(()=>window.scrollTo(0,220));const scroll=await page.evaluate(()=>window.scrollY);
  await page.locator('#learnTab').click();await page.locator('#sourceText').fill('Synthetic new note after the cached window.');await page.locator('#send').click();await page.locator('#cancelJob').waitFor();
  await page.locator('#settingsTab').click();await page.evaluate(()=>window.navComplete());await page.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='complete');await selected('settingsTab');
  const before=calls.length;await page.locator('#historyTab').click();await page.waitForFunction(()=>document.querySelector('.history-text')?.textContent==='Synthetic new note after the cached window.');await selected('historyTab');
  assert.equal(await page.locator('#search').inputValue(),'Synthetic');assert.equal(await page.locator('.history-row').count(),8);assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scroll)<=1);
  const reads=calls.slice(before).filter(call=>call.action==='records.history');assert.deepEqual(reads.map(call=>({query:call.params.query,offset:call.params.offset??0})),[{query:'Synthetic',offset:0},{query:'Synthetic',offset:4}]);
  await page.locator('.history-card').first().click();await page.locator('#backToHistory').waitFor();const count=calls.filter(call=>call.action==='records.history').length;await page.locator('#backToHistory').click();assert.equal(calls.filter(call=>call.action==='records.history').length,count,'returning from detail reuses the refreshed window');clean();
});

test('read-only recovery polling updates the hidden workbench without stealing the current tab',{timeout:60000},async t=>{
  const {page,state,calls,selected,clean}=await harness(t,{restoreProcessing:true});await page.locator('#cancelJob').waitFor();
  await page.locator('#settingsTab').click();await selected('settingsTab');state.records.set('pending',makeRecord('pending','Synthetic pending source.'));
  await page.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='complete',null,{timeout:10000});
  await selected('settingsTab');await page.locator('#learnTab').click();assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),'');
  await page.locator('#historyTab').click();await page.locator('.history-card').first().waitFor();await page.locator('#search').fill('Synthetic pending source.');await page.locator('#searchButton').click();await page.locator('.history-card').filter({hasText:'Synthetic pending source.'}).click();await page.locator('#backToHistory').waitFor();assert.equal(await page.locator('#recordHeading').getAttribute('data-status'),'complete');
  assert.equal(calls.some(call=>call.action.startsWith('learning.')),false);clean();
});

test('deleting a saved record before its accepted event clears hidden draft request IDs and ignores the late event',{timeout:60000},async t=>{
  const {page,state,selected,openHistory,clean}=await harness(t,{holdAccepted:true});
  const text='Synthetic source deleted before the first accepted event.';
  await page.locator('#sourceText').fill(text);await page.locator('#send').click();await page.waitForFunction(()=>window.navStreams.length===1);
  const first=await page.evaluate(()=>window.navCalls.find(call=>call.action==='learning.submit'));assert.ok(state.records.has(first.params.record_id));assert.equal(await page.locator('#composer').isVisible(),true);
  await openHistory();await page.locator('.history-card').filter({hasText:'Synthetic alpha note 01'}).click();await page.locator('#backToHistory').waitFor();await page.locator('#backToHistory').click();
  const row=page.locator('.history-row').filter({has:page.locator('.history-card').filter({hasText:text})});assert.equal(await row.count(),1);
  page.once('dialog',dialog=>dialog.accept());await row.locator('.delete-record').click();await page.waitForFunction(()=>!window.navStores.session['panel:one']?.pending_submit&&window.navStreams[0].aborted);
  assert.equal(state.records.has(first.params.record_id),false);assert.equal(await row.count(),0);await selected('historyTab');
  await page.evaluate(()=>window.navStreams[0].releaseAccepted());await page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);await selected('historyTab');assert.equal(await page.locator('#historyView').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.navStores.session['panel:one']?.pending_submit??null),null,'deleted pending request cannot remain as a sidebar recovery entry');
  await page.locator('#learnTab').click();assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),'');await page.locator('#sourceText').fill(text);
  await page.locator('#send').click();await page.waitForFunction(()=>window.navCalls.filter(call=>call.action==='learning.submit').length===2);
  const second=await page.evaluate(()=>window.navCalls.filter(call=>call.action==='learning.submit')[1]);
  assert.notEqual(second.params.record_id,first.params.record_id,'resending the same text from New must allocate a new record ID');assert.notEqual(second.request_id,first.request_id,'the deleted request ID must not be restored from the hidden workbench snapshot');
  await page.locator('#cancelJob').waitFor();await page.evaluate(()=>window.navComplete());await page.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='complete');
  assert.equal(state.records.has(first.params.record_id),false);assert.equal(state.records.has(second.params.record_id),true);clean();
});
