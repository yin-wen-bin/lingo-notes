import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {createSelectionBackground,eventually,queueKey} from './helpers/selection-background.mjs';

const origin='https://selection-api.example';
const makeSession=owner=>({access_token:owner,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:owner,email:owner+'@example.test'}});
const lesson=language=>({language:'en',explanation_language:language,summary_zh:'Saved synthetic explanation.',vocabulary:[{term:'practice',reading:'/ˈpræktɪs/',pos:'noun',meaning:'合成释义',examples:[{text:'We practise every day.',translation:'我们每天练习。'}]}],grammar:[]});
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};

async function harness(t,{signedIn=true,key=true,language='zh',holdSettings=false,failFirstSettings=false}={}){
  const bundle=await build({entryPoints:['extension/panel.ts'],bundle:true,format:'esm',platform:'browser',write:false,define:{__SUPABASE_URL__:JSON.stringify(origin),__SUPABASE_PUBLISHABLE_KEY__:JSON.stringify('synthetic-public')}});
  const server=http.createServer(async(req,res)=>{try{
    const pathname=new URL(req.url,'http://localhost').pathname;let file=pathname==='/panel.js'?null:pathname==='/panel.css'?'extension/panel.css':'extension/panel.html';
    if(pathname.startsWith('/assets/')){const typography=pathname.startsWith('/assets/typography/'),root=path.resolve(typography?'shared/typography':'extension/assets');file=path.resolve(root,pathname.slice(typography?'/assets/typography/'.length:'/assets/'.length));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}}
    const type=!file?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/html';res.writeHead(200,{'content-type':type});res.end(file?await readFile(file):bundle.outputFiles[0].text);
  }catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host=await createSelectionBackground({origin,local:signedIn?{['lingo-session:'+origin]:JSON.stringify(makeSession('one'))}:{}});
  const browser=await chromium.launch({channel:'msedge',headless:true}),pages=[],errors=[],unexpected=[],calls=[],submissions=[];
  const state={records:new Map(),recordReads:[],pageSize:30,keys:{one:key,two:true},settings:{one:{font_theme:'refined',explanation_language:language,explanation_mode:'fast',review_daily_limit:5},two:{font_theme:'clean',explanation_language:'en',explanation_mode:'fast',review_daily_limit:5}},settingsGate:holdSettings?gate():null,settingsFailuresLeft:failFirstSettings?1:0,failedSettings:0,holdAcceptedActions:new Set(),readError:false,concurrent:0,peak:0};
  t.after(async()=>{state.settingsGate?.release();host.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const recordKey=(owner,id)=>owner+':'+id;
  const open=async(windowId=1)=>{
    const page=await browser.newPage({viewport:{width:390,height:760}});pages.push(page);page.on('pageerror',error=>errors.push(error.message));
    await host.install(page,{windowId});
    await page.exposeBinding('__selectionModelStart',({page},{body,owner})=>{
      assert.ok(['one','two'].includes(owner),'a model POST must carry a synthetic authenticated owner');const record={record_id:body.params.record_id,request_id:body.request_id,revision:body.params.revision?body.params.revision+1:1,status:'processing',input_type:body.action==='learning.recognize'?'image':'text',local_date:'2026-11-22',original_text:body.params.text??'',context:body.params.context??'',source:body.params.source??null,explanation_language:body.params.explanation_language??'zh',result:null};
      const held=state.holdAcceptedActions.has(body.action);if(!held)state.records.set(recordKey(owner,record.record_id),record);submissions.push({owner,body:structuredClone(body),record,page,finished:false,readCountAtStart:state.recordReads.length});state.concurrent++;state.peak=Math.max(state.peak,state.concurrent);return {record,held};
    });
    await page.addInitScript(({origin,lesson})=>{
      const nativeFetch=window.fetch.bind(window);window.__selectionStreams={};
      window.fetch=async(input,init)=>{
        const url=typeof input==='string'?input:input.url;
        if(url===origin+'/functions/v1/app-api'){
          const body=JSON.parse(init.body);
          if(body.action.startsWith('learning.')&&body.action!=='learning.cancel'){
            const owner=new Headers(init.headers).get('Authorization')?.replace(/^Bearer /,'');const {record,held}=await window.__selectionModelStart({body,owner}),encoder=new TextEncoder();let controller,accepted=false;
            const event=(type,payload)=>encoder.encode('event: '+type+'\ndata: '+JSON.stringify({request_id:body.request_id,record_id:record.record_id,revision:record.revision,...payload})+'\n\n');
            const accept=()=>{if(!accepted){accepted=true;controller.enqueue(event('accepted',{sequence:1,record}));}};
            const stream=new ReadableStream({start(value){controller=value;if(!held)accept();}});
            const handle={record,closed:false,accept,finish(result){if(handle.closed)return;handle.closed=true;controller.enqueue(event(result.status==='complete'?'complete':'error',{sequence:3,record:result,error:result.error}));controller.close();},interrupt(){if(handle.closed)return;handle.closed=true;controller.error(new TypeError('Synthetic disconnected stream'));}};
            init.signal.addEventListener('abort',()=>handle.interrupt(),{once:true});window.__selectionStreams[record.record_id]=handle;
            return new Response(stream,{headers:{'content-type':'text/event-stream'}});
          }
        }
        return nativeFetch(input,init);
      };
    },{origin,lesson:lesson(language)});
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());if(url.hostname==='127.0.0.1')return route.continue();if(url.origin!==origin){unexpected.push(url.href);return route.abort();}
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};if(request.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
      const body=request.postDataJSON();
      if(url.pathname==='/auth/v1/token')return route.fulfill({status:200,headers,body:JSON.stringify({...makeSession('one'),expires_in:3600})});
      if(url.pathname==='/auth/v1/logout')return route.fulfill({status:200,headers,body:'{}'});
      const owner=request.headers().authorization==='Bearer two'?'two':'one';calls.push({owner,...body});let result={};
      if(body.action==='settings.get'){if(state.settingsFailuresLeft){state.settingsFailuresLeft--;state.failedSettings++;return route.fulfill({status:503,headers,body:JSON.stringify({ok:false,error:'NETWORK_ERROR'})});}if(state.settingsGate)await state.settingsGate.promise;result={...state.settings[owner]};}
      else if(body.action==='settings.update'){Object.assign(state.settings[owner],body.params);result={...state.settings[owner]};}
      else if(body.action==='key.status')result={configured:state.keys[owner],last_four:state.keys[owner]?'1234':null};
      else if(body.action==='key.save'){state.keys[owner]=true;result={saved:true};}
      else if(body.action==='key.delete'){state.keys[owner]=false;result={deleted:true};}
      else if(body.action==='ping')result={protocol:'cloud/5'};
      else if(body.action==='records.get'){if(state.readError)return route.fulfill({status:503,headers,body:JSON.stringify({ok:false,error:'NETWORK_ERROR'})});result=state.records.get(recordKey(owner,body.params.record_id))??null;state.recordReads.push({owner,recordId:body.params.record_id,result:structuredClone(result)});}
      else if(body.action==='records.history'){const query=String(body.params.query??'').toLowerCase(),offset=body.params.offset??0,items=[...state.records].filter(([key])=>key.startsWith(owner+':')).map(([,record])=>record).reverse().filter(record=>[record.corrected_text,record.recognized_text,record.original_text,record.result?.summary_zh].some(text=>String(text??'').toLowerCase().includes(query)));result={items:items.slice(offset,offset+state.pageSize).map(record=>({...record,text:record.corrected_text??record.recognized_text??record.original_text})),has_more:offset+state.pageSize<items.length};}
      else if(body.action==='review.cards')result={cards:[]};
      else if(body.action==='learning.cancel'){const record=state.records.get(recordKey(owner,body.params.record_id));if(record&&['saved','processing'].includes(record.status)){record.status='cancelled';state.records.set(recordKey(owner,record.record_id),record);const submission=submissions.find(item=>item.owner===owner&&item.record.record_id===record.record_id&&item.body.request_id===record.request_id);if(submission&&!submission.finished){submission.finished=true;state.concurrent--;}}result=record;}
      try{await route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});}catch{/* Deliberate close can abort an outstanding synthetic read. */}
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);return page;
  };
  const ready=page=>page.waitForFunction(()=>!document.querySelector('#explanationLanguage').disabled);
  const started=count=>eventually(()=>submissions.length,value=>value===count,15000);
  const finish=async(index,{status='complete',emit=true}={})=>{
    const submission=submissions[index];assert.ok(submission,'synthetic submission must exist');const result={...submission.record,status,result:status==='complete'?lesson(submission.record.explanation_language):null,error:status==='failed'?'INVALID_LESSON':undefined};state.records.set(recordKey(submission.owner,result.record_id),result);
    if(!submission.finished){submission.finished=true;state.concurrent--;}
    if(emit&&!submission.page.isClosed())await submission.page.evaluate(({id,result})=>window.__selectionStreams[id]?.finish(result),{id:result.record_id,result});return result;
  };
  const interrupt=async(index)=>{const submission=submissions[index];await submission.page.evaluate(id=>window.__selectionStreams[id].interrupt(),submission.record.record_id);};
  const accept=async(index)=>{const submission=submissions[index];state.records.set(recordKey(submission.owner,submission.record.record_id),submission.record);await submission.page.evaluate(id=>window.__selectionStreams[id].accept(),submission.record.record_id);};
  const clean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);};
  return {host,browser,pages,state,calls,submissions,open,ready,started,finish,interrupt,accept,clean,errors};
}

test('right-click learns immediately from cold and warm sidebars, and duplicate notifications never submit twice',{timeout:60000},async t=>{
  const h=await harness(t);await h.host.select('Practice starts now.');await eventually(()=>h.host.snapshot()?.waiting?.length,value=>value===1);
  const page=await h.open();await h.started(1);assert.equal(h.submissions[0].body.params.text,'Practice starts now.');assert.equal(h.submissions[0].body.params.context,'Context for Practice starts now.');
  assert.equal(await page.locator('#recordSection').isVisible(),true);const active=h.host.snapshot().active;assert.equal(active.recordId,h.submissions[0].record.record_id);assert.equal(active.requestId,h.submissions[0].body.request_id);assert.ok(active.params,'request material is durable before the model POST');
  for(const port of h.host.ports.values()){port.postMessage({event:'selection-queue.changed',snapshot:h.host.snapshot()});port.postMessage({event:'selection-queue.changed',snapshot:h.host.snapshot()});}
  await page.evaluate(async key=>{const saved=await chrome.storage.session.get(key);await chrome.storage.session.set(saved);},queueKey);assert.equal(h.submissions.length,1);
  await h.finish(0);await h.host.select('A second small discovery.');await h.started(2);await h.host.select('Continue after the current task is cancelled.');await page.locator('#queueCancel').click();await h.started(3);assert.equal(h.state.records.get('one:'+h.submissions[1].record.record_id).status,'cancelled');await h.finish(2);await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(h.state.peak,1);h.clean();
});

test('selection FIFO follows click order even when context finishes out of order',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);const slow=h.host.holdContext('Alpha first.');await h.host.select('Alpha first.');await h.host.select('Bravo second.');await h.host.select('Charlie third.');
  await eventually(()=>h.host.snapshot()?.waiting,value=>value?.length===3&&value[1].phase==='ready'&&value[2].phase==='ready');assert.equal(h.submissions.length,0);slow.release();
  for(let index=0;index<3;index++){await h.started(index+1);assert.equal(h.submissions[index].body.params.text,['Alpha first.','Bravo second.','Charlie third.'][index]);assert.equal(h.submissions[index].body.params.context,'Context for '+h.submissions[index].body.params.text);await h.finish(index);}
  await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(h.state.peak,1);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);assert.equal(await page.locator('#recordSection').isVisible(),true);h.clean();
});

test('invalid or overlong selections never POST or pause the following valid selection',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await h.host.select('123 !!! １２３');await h.host.select('A'.repeat(12001));await h.host.select('The third selection is valid.');await h.started(1);
  assert.equal(h.submissions[0].body.params.text,'The third selection is valid.');assert.equal(h.host.snapshot().paused,null);await h.finish(0);await eventually(()=>h.host.snapshot(),snapshot=>!snapshot.active&&!snapshot.waiting.length);assert.equal(h.submissions.length,1);assert.equal(h.host.snapshot().paused,null);h.clean();
});

test('manual work and selections share one permit across windows, while later results preserve drafts and navigation',{timeout:60000},async t=>{
  const h=await harness(t),first=await h.open(1);await h.ready(first);await first.locator('#sourceText').fill('A manual lesson is already running.');await first.locator('#send').click();await h.started(1);
  const second=await h.open(2);await second.locator('#settingsTab').click();await h.host.select('A queued selection from another window.',{windowId:2});await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);assert.equal(h.submissions.length,1);
  await second.locator('#learnView').waitFor();assert.equal(await second.locator('#recordOriginal').textContent(),'A queued selection from another window.');assert.equal(await second.locator('#recordContext').textContent(),'Context for A queued selection from another window.');assert.equal(await second.locator('#recordSource').getAttribute('href'),'https://example.test/reading-2');
  await first.locator('#learnTab').click();await first.locator('#sourceText').fill('Keep this unsent editor content.');await first.locator('#settingsTab').click();
  await h.finish(0);await h.started(2);assert.equal(h.submissions[1].page,second);assert.equal(h.submissions[1].body.params.text,'A queued selection from another window.');
  await second.locator('#historyTab').click();await h.finish(1);await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(await first.locator('#settingsView').isVisible(),true);assert.equal(await first.locator('#sourceText').inputValue(),'Keep this unsent editor content.');assert.equal(await second.locator('#historyView').isVisible(),true);assert.equal(h.state.peak,1);h.clean();
});

test('new selections display immediately from settings, history and history detail, with each queued material kept separate',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);
  await h.host.select('An earlier saved selection.');await h.started(1);await h.finish(0);await eventually(()=>h.host.snapshot().active,value=>!value);
  const text='A new selection from settings.';await page.locator('#settingsTab').click();await h.host.select(text);await h.started(2);await page.locator('#learnView').waitFor();assert.equal(await page.locator('#learnTab').getAttribute('aria-current'),'page');assert.equal(await page.locator('#recordOriginal').textContent(),text);assert.equal(await page.locator('#recordContext').textContent(),'上下文：Context for '+text);assert.equal(await page.locator('#recordSource').getAttribute('href'),'https://example.test/reading-1');
  const queued='The most recent queued selection has its own context.';await page.locator('#settingsTab').click();await h.host.select(queued);await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await page.locator('#learnView').waitFor();assert.equal(await page.locator('#recordOriginal').textContent(),queued);assert.equal(await page.locator('#recordContext').textContent(),'Context for '+queued);await h.finish(1);await h.started(3);assert.equal(await page.locator('#recordOriginal').textContent(),queued);await h.finish(2);await eventually(()=>h.host.snapshot().active,value=>!value);
  for(const route of ['history','history-detail']){
    await page.locator('#historyTab').click();await page.locator('.history-card').first().waitFor();if(route==='history-detail'){await page.locator('.history-card').first().click();await page.locator('#backToHistory').waitFor();}
    const index=h.submissions.length,text=`The next explicit intent from ${route}.`;await h.host.select(text);await h.started(index+1);await page.locator('#learnView').waitFor();assert.equal(await page.locator('#recordOriginal').textContent(),text);await h.finish(index);await eventually(()=>h.host.snapshot().active,value=>!value);
  }
  h.clean();
});

test('a new selection preserves an unsent draft and saved-record revision for the explicit return action',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await page.locator('#sourceText').fill('An unsent draft remains exactly as edited.');await page.locator('#settingsTab').click();await h.host.select('The selection temporarily replaces the editor.');await h.started(1);await page.locator('#heldContent').waitFor();await page.locator('#restoreHeldContent').click();assert.equal(await page.locator('#sourceText').inputValue(),'An unsent draft remains exactly as edited.');assert.equal(await page.locator('#composer').isVisible(),true);await h.finish(0);await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(await page.locator('#sourceText').inputValue(),'An unsent draft remains exactly as edited.');
  await page.locator('#historyTab').click();await page.locator('.history-card').first().click();await page.locator('#editRecord').click();await page.locator('#retryText').fill('An unsent correction to the saved record.');const record=await page.locator('#recordOriginal').textContent();await h.host.select('A new intent while a saved revision is being edited.');await h.started(2);await page.locator('#restoreHeldContent').click();assert.equal(await page.locator('#retrySection').isVisible(),true);assert.equal(await page.locator('#retryText').inputValue(),'An unsent correction to the saved record.');assert.equal(await page.locator('#recordOriginal').textContent(),record);assert.equal(await page.locator('#backToHistory').isVisible(),true);await h.finish(1);await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(await page.locator('#retryText').inputValue(),'An unsent correction to the saved record.');assert.equal(h.submissions.length,2);h.clean();
});

test('returning to a preaccepted manual draft keeps its workbench persistence identity',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);h.state.holdAcceptedActions.add('learning.submit');const original='This manual draft is still waiting for accepted.';await page.locator('#sourceText').fill(original);await page.locator('#send').click();await h.started(1);
  await h.host.select('A new selection temporarily displays over the manual draft.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await page.locator('#restoreHeldContent').click();assert.equal(await page.locator('#composer').isVisible(),true);assert.equal(await page.locator('#sourceText').inputValue(),original);
  h.state.holdAcceptedActions.delete('learning.submit');await h.accept(0);await h.finish(0);await h.started(2);await h.finish(1);await eventually(()=>h.host.snapshot().active,value=>!value);
  assert.equal(await page.locator('#composer').isVisible(),true,'accepted and completion of the old manual request must not take over the returned draft');const edited='The returned draft continues to save as the workbench.';await page.locator('#sourceText').fill(edited);await eventually(()=>h.host.stores.session['panel:one']?.panel_state?.text,value=>value===edited);
  assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,2);h.clean();
});

test('other windows refresh accepted and terminal history changes while retaining the search, loaded pages and visible anchor',{timeout:60000},async t=>{
  const h=await harness(t);h.state.pageSize=4;
  for(let index=0;index<12;index++){const id='history-'+index;h.state.records.set('one:'+id,{record_id:id,request_id:'saved-'+index,revision:1,status:'complete',input_type:'text',local_date:'2026-11-22',original_text:'Synthetic alpha note '+String(index).padStart(2,'0'),explanation_language:'zh',result:lesson('zh')});}
  const first=await h.open(1),second=await h.open(2);await first.setViewportSize({width:390,height:500});await h.ready(first);await h.ready(second);await first.locator('#historyTab').click();await first.locator('#search').fill('alpha');await first.locator('#searchButton').click();await first.locator('#more').click();await first.waitForFunction(()=>document.querySelectorAll('.history-row').length===8);await first.evaluate(()=>window.scrollTo(0,100));
  const visibleAnchor=()=>first.evaluate(()=>{const top=document.querySelector('header').getBoundingClientRect().bottom,row=[...document.querySelectorAll('.history-row')].find(row=>row.getBoundingClientRect().bottom>top);return {id:row.dataset.recordId,top:row.getBoundingClientRect().top};});const anchor=await visibleAnchor();
  const count=h.calls.filter(call=>call.action==='records.history').length;await h.host.select('A new alpha selection in the other window.',{windowId:2});await h.started(1);await first.locator('.history-text').filter({hasText:'A new alpha selection in the other window.'}).waitFor();assert.equal(await first.locator('#historyView').isVisible(),true);assert.equal(await first.locator('#search').inputValue(),'alpha');assert.equal(await first.locator('.history-row').count(),8);assert.ok(h.calls.filter(call=>call.action==='records.history').length>count);const acceptedTop=await first.locator(`[data-record-id="${anchor.id}"]`).evaluate(row=>row.getBoundingClientRect().top);assert.ok(Math.abs(acceptedTop-anchor.top)<=1,JSON.stringify({stage:'accepted',anchor,actualTop:acceptedTop,scroll:await first.evaluate(()=>scrollY)}));
  const beforeTerminal=await visibleAnchor();await h.finish(0);await eventually(()=>h.host.snapshot().active,value=>!value);await first.waitForFunction(()=>{const row=[...document.querySelectorAll('.history-row')].find(row=>row.textContent.includes('A new alpha selection'));return row&&!row.textContent.includes('处理中');});assert.equal(await first.locator('#historyView').isVisible(),true);assert.equal(await first.locator('#search').inputValue(),'alpha');assert.equal(await first.locator('.history-row').count(),8);const terminalTop=await first.locator(`[data-record-id="${beforeTerminal.id}"]`).evaluate(row=>row.getBoundingClientRect().top);assert.ok(Math.abs(terminalTop-beforeTerminal.top)<=1,JSON.stringify({stage:'terminal',anchor:beforeTerminal,actualTop:terminalTop,scroll:await first.evaluate(()=>scrollY)}));
  await first.locator('.history-card').filter({hasText:'A new alpha selection'}).click();await first.locator('#backToHistory').waitFor();assert.equal(await first.locator('#recordOriginal').textContent(),'A new alpha selection in the other window.');await first.locator('#backToHistory').click();assert.equal(await first.locator('#search').inputValue(),'alpha');assert.equal(await first.locator('.history-row').count(),8);h.clean();
});

test('missing Key preserves the selection for manual submission after setup instead of auto-resuming',{timeout:60000},async t=>{
  const h=await harness(t,{key:false}),page=await h.open();await h.host.select('Keep this selected sentence for setup.');await page.locator('#settingsView').waitFor();await page.locator('#queueCurrent').waitFor();assert.equal(h.submissions.length,0);
  await page.locator('#apiKey').fill('sk-synthetic-test-key-for-selection-1234');await page.locator('#saveKey').click();await page.waitForFunction(()=>document.querySelector('#keyState').textContent.includes('已配置'));assert.equal(h.submissions.length,0);
  await page.locator('#queueCurrent').click();assert.equal(await page.locator('#sourceText').inputValue(),'Keep this selected sentence for setup.');assert.equal(h.submissions.length,0);await page.locator('#send').click();await h.started(1);await h.finish(0);h.clean();
});

test('signed-out selections survive first login but still require the explicit manual lesson click',{timeout:60000},async t=>{
  const h=await harness(t,{signedIn:false}),page=await h.open();await h.host.select('A guest selection must survive login.');await page.locator('#loginFields').waitFor();await page.locator('#email').fill('one@example.test');await page.locator('#password').fill('Synthetic password for test');await page.locator('#signIn').click();
  await page.waitForFunction(()=>document.querySelector('#loginFields').hidden&&!document.querySelector('#explanationLanguage').disabled);assert.equal(h.submissions.length,0);await page.locator('#queueCurrent').click();assert.equal(await page.locator('#sourceText').inputValue(),'A guest selection must survive login.');await page.locator('#send').click();await h.started(1);await h.finish(0);h.clean();
});

test('automatic selection waits for confirmed language and does not pull the user back from settings',{timeout:60000},async t=>{
  const h=await harness(t,{language:'ja',holdSettings:true});await h.host.select('Wait for the confirmed Japanese preference.');const page=await h.open();await page.waitForFunction(()=>document.querySelector('#recordOriginal').textContent==='Wait for the confirmed Japanese preference.');await page.locator('#settingsTab').click();assert.equal(h.submissions.length,0);h.state.settingsGate.release();await h.started(1);assert.equal(h.submissions[0].body.params.explanation_language,'ja');assert.equal(await page.locator('#settingsView').isVisible(),true);await h.finish(0);assert.equal(await page.locator('#settingsView').isVisible(),true);h.clean();
});

test('one failed initial preference read cannot strand the original selection after focus recovery',{timeout:60000},async t=>{
  const h=await harness(t,{language:'en',failFirstSettings:true});await h.host.select('Retry initialization without replaying the selection.');const page=await h.open();await eventually(()=>h.state.failedSettings,value=>value===1);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await h.started(1);
  assert.equal(h.submissions[0].body.params.text,'Retry initialization without replaying the selection.');assert.equal(h.submissions[0].body.params.explanation_language,'en');await h.finish(0);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(h.submissions.length,1);h.clean();
});

test('lost registration and synchronization replies recover without reloading or reviving an old port',{timeout:90000},async t=>{
  const h=await harness(t);h.host.dropRegistrationAcks();const page=await h.open();await page.locator('#queueConnection').waitFor();await h.ready(page);await page.locator('#queueConnection').waitFor({state:'hidden'});assert.ok(h.host.ports.size===1);const old=[...h.host.ports.values()][0];
  h.host.dropCommandReplies('sync');await h.host.disconnectPage(page);await page.locator('#queueConnection').waitFor();assert.throws(()=>old.postMessage({event:'selection-queue.changed',snapshot:h.host.snapshot()}),/disconnected port/);await page.locator('#queueConnection').waitFor({state:'hidden'});assert.equal(h.host.ports.has(old.id),false,'only an explicit new runtime.connect can create a live port');const connected=[...h.host.ports.keys()][0];assert.notEqual(connected,old.id);await h.host.deliverLateDisconnect(old.id);assert.equal(h.host.ports.has(connected),true,'a late old disconnect cannot retire the replacement connection');
  await h.host.select('The sidebar still responds after transport recovery.');await h.started(1);await h.finish(0);await eventually(()=>h.host.snapshot().active,value=>!value);assert.equal(h.submissions.length,1);h.clean();
});

test('a lost permit reply is never replayed, and skipping its unknown outcome permits the next selection',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);h.host.dropCommandReplies('claim');await h.host.select('This uncertain permit must never be resubmitted.');await eventually(()=>h.host.snapshot()?.active,value=>!!value);const held=structuredClone(h.host.snapshot().active);await page.locator('#queueCheck').waitFor();assert.equal(h.submissions.length,0);assert.equal(h.host.snapshot().active.requestId,held.requestId);assert.equal(h.host.commands.filter(entry=>entry.message.op==='claim').length,1,'a lost permit reply does not replay the state-changing claim');
  await h.host.select('Only the subsequent explicit selection may be sent.');await page.locator('#queueSkip').click();await h.started(1);assert.equal(h.submissions[0].body.params.text,'Only the subsequent explicit selection may be sent.');assert.notEqual(h.submissions[0].body.request_id,held.requestId);assert.equal(h.host.commands.filter(entry=>entry.message.op==='claim').length,2,'only the later explicit task obtains a new permit');await h.finish(0);h.clean();
});

test('an idle transport restart reads the existing request before advancing and never posts it twice',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await h.host.select('An accepted record remains the same after worker recovery.');await h.started(1);const original=structuredClone(h.submissions[0].body);await h.host.select('The waiting selection follows the recovered record.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await h.interrupt(0);await h.host.restart();await h.finish(0,{emit:false});await h.started(2);assert.ok(h.state.recordReads.slice(0,h.submissions[1].readCountAtStart).some(read=>read.recordId===original.params.record_id&&read.result?.request_id===original.request_id&&read.result?.status==='complete'));assert.equal(h.submissions.filter(item=>item.body.request_id===original.request_id).length,1);assert.equal(h.submissions[1].body.params.text,'The waiting selection follows the recovered record.');await h.finish(1);h.clean();
});

test('disconnect recovery reads the original request, and explicit skip advances without replaying it',{timeout:90000},async t=>{
  const h=await harness(t),page=await h.open();await h.host.select('Recover the original request.');await h.started(1);await h.host.select('A second request can be skipped.');await h.host.select('Continue to the third request.');
  await h.interrupt(0);await page.locator('#queueCheck').waitFor();assert.equal(h.submissions.length,1);assert.equal(h.host.snapshot().active.recordId,h.submissions[0].record.record_id);
  await page.locator('#queueCheck').click();await page.locator('#queueCheck').waitFor();assert.equal(h.host.snapshot().active.recordId,h.submissions[0].record.record_id,'a recovery GET that still returns processing must not unlock the next request');assert.equal(h.submissions.length,1);
  await h.finish(0,{emit:false});await h.started(2);assert.ok(h.state.recordReads.slice(0,h.submissions[1].readCountAtStart).some(read=>read.recordId===h.submissions[0].record.record_id&&read.result?.request_id===h.submissions[0].body.request_id&&read.result?.status==='complete'),'a matching terminal GET must precede the next POST');
  await h.interrupt(1);await page.locator('#queueSkip').waitFor();assert.equal(h.submissions.length,2);await page.locator('#queueSkip').click();await h.started(3);assert.equal(h.submissions[2].body.params.text,'Continue to the third request.');await h.finish(2);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);assert.ok(h.calls.some(call=>call.action==='records.get'&&call.params.record_id===h.submissions[0].record.record_id));h.clean();
});

test('a late SSE completion from before a worker restart cannot unlock the next active request',{timeout:90000},async t=>{
  const h=await harness(t),original=await h.open(1);await h.host.select('The original live stream.');await h.started(1);await h.host.select('The next request after an explicit skip.');await h.host.select('The third request still has to wait.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===2);
  const firstRequest=h.submissions[0].body.request_id,firstRecordId=h.submissions[0].record.record_id;h.host.restart();const recovery=await h.open(2);await recovery.locator('#queueSkip').waitFor();
  await eventually(()=>h.host.commands.some(entry=>entry.generation===h.host.generation&&entry.message.op==='sync'&&entry.message.windowId===1&&entry.resolved));assert.equal(await original.evaluate(id=>window.__selectionStreams[id]?.closed,firstRecordId),false,'the recovered origin still owns its original live stream before another window skips it');
  await recovery.locator('#queueSkip').click();await h.started(2);const secondId=h.submissions[1].record.record_id;
  await eventually(()=>original.evaluate(id=>window.__selectionStreams[id]?.closed,firstRecordId));assert.equal(h.submissions[1].page,original,'the recovered origin sidebar executes its next selection after the old local stream is released');
  assert.equal(await original.locator('#recordOriginal').textContent(),'The third request still has to wait.','newest selected material remains displayed while older FIFO work runs');
  await h.finish(0);assert.equal(h.host.snapshot().active.recordId,secondId);assert.equal(h.submissions.length,2,'old completion cannot advance the third request');assert.equal(await original.locator('#recordOriginal').textContent(),'The third request still has to wait.','late old completion cannot replace the newer selection');
  assert.equal(await recovery.locator('#queueStatus').isVisible(),true);await h.finish(1);await h.started(3);assert.equal(h.submissions[2].page,original);assert.equal(h.submissions[2].body.params.text,'The third request still has to wait.');await h.finish(2);
  assert.equal(h.submissions.filter(item=>item.body.request_id===firstRequest).length,1);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);assert.ok(h.submissions.every(item=>item.owner==='one'));h.clean();
});

test('a cross-window skip of manual work releases the origin queue without falsifying its saved record',{timeout:60000},async t=>{
  const h=await harness(t),original=await h.open(1);await h.ready(original);await original.locator('#sourceText').fill('Manual work remains processing when its uncertain result is skipped.');await original.locator('#send').click();await h.started(1);await original.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='processing');
  const first=h.submissions[0],queued='The origin selection continues after the manual request is skipped.';await h.host.select(queued);await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);h.host.restart();
  const recovery=await h.open(2);await recovery.locator('#queueSkip').waitFor();await eventually(()=>h.host.commands.some(entry=>entry.generation===h.host.generation&&entry.message.op==='sync'&&entry.message.windowId===1&&entry.resolved));await recovery.locator('#queueSkip').click();await h.started(2);
  assert.equal(h.submissions[1].page,original);assert.equal(h.submissions[1].body.params.text,queued);assert.equal(h.state.records.get('one:'+first.record.record_id).status,'processing','skip releases local arbitration without inventing a cloud terminal status');assert.equal(h.calls.filter(call=>call.action==='learning.cancel').length,0,'skip does not send a model cancellation or retry');
  assert.equal(await original.evaluate(id=>window.__selectionStreams[id]?.closed,first.record.record_id),true);await h.finish(0);assert.equal(h.host.snapshot().active.requestId,h.submissions[1].body.request_id);assert.equal(await original.locator('#recordOriginal').textContent(),queued);await h.finish(1);
  assert.equal(h.submissions.length,2);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,2);assert.equal(h.submissions.filter(item=>item.body.request_id===first.body.request_id).length,1);h.clean();
});

test('a skipped manual request stays retired after later work completes and the origin sidebar reopens',{timeout:60000},async t=>{
  const h=await harness(t),original=await h.open(1);await h.ready(original);await original.locator('#sourceText').fill('This skipped manual request keeps its real processing status.');await original.locator('#send').click();await h.started(1);await original.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='processing');const first=h.submissions[0];
  await h.host.select('The first queued task completes after manual work is skipped.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);h.host.restart();const recovery=await h.open(2);await recovery.locator('#queueSkip').waitFor();await eventually(()=>h.host.commands.some(entry=>entry.generation===h.host.generation&&entry.message.op==='sync'&&entry.message.windowId===1&&entry.resolved));await recovery.locator('#queueSkip').click();await h.started(2);await h.finish(1);await eventually(()=>h.host.snapshot().active,value=>!value);
  assert.equal(h.host.snapshot().last.recordId,h.submissions[1].record.record_id);assert.equal(h.state.records.get('one:'+first.record.record_id).status,'processing');await original.close();const reopened=await h.open(1);await reopened.waitForFunction(()=>document.querySelector('#recordHeading').dataset.status==='processing');await reopened.locator('#queueConnection').waitFor({state:'hidden'});
  const next='A fresh selection runs after the origin sidebar reopens.';await h.host.select(next);await h.started(3);assert.equal(h.submissions[2].page,reopened);assert.equal(h.submissions[2].body.params.text,next);assert.equal(h.state.records.get('one:'+first.record.record_id).status,'processing','reopening must not invent a terminal status for the skipped cloud request');await h.finish(2);
  assert.equal(h.submissions.filter(item=>item.body.request_id===first.body.request_id).length,1);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);h.clean();
});

test('an old terminal revision cannot release a retry permit before its matching accepted event',{timeout:90000},async t=>{
  const h=await harness(t),first=await h.open(1);await h.ready(first);await first.locator('#sourceText').fill('The original saved explanation.');await first.locator('#send').click();await h.started(1);await h.finish(0);await h.ready(first);await eventually(()=>h.host.snapshot().active,value=>!value);
  const oldRecord=structuredClone(h.state.records.get('one:'+h.submissions[0].record.record_id));h.state.holdAcceptedActions.add('learning.retry');await first.locator('#editRecord').click();await first.locator('#retryText').fill('The corrected material for a new attempt.');await first.locator('#retryConfirm').click();await h.started(2);
  assert.equal(h.submissions[1].record.record_id,oldRecord.record_id);assert.notEqual(h.submissions[1].body.request_id,oldRecord.request_id);assert.equal(h.state.records.get('one:'+oldRecord.record_id).request_id,oldRecord.request_id,'GET fixture deliberately still has the preceding complete attempt');
  const reads=h.calls.filter(call=>call.action==='records.get'&&call.params.record_id===oldRecord.record_id).length;const second=await h.open(2);await eventually(()=>h.calls.filter(call=>call.action==='records.get'&&call.params.record_id===oldRecord.record_id).length,value=>value>reads);await h.host.select('A selection must wait for the retry.',{windowId:2});await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);
  assert.equal(h.host.snapshot().active.requestId,h.submissions[1].body.request_id);assert.equal(h.submissions.length,2,'old GET complete must not grant a third POST');await h.accept(1);await h.finish(1);await h.started(3);assert.equal(h.submissions[2].page,second);assert.equal(h.submissions[2].body.params.text,'A selection must wait for the retry.');await h.finish(2);h.clean();
});

test('a cancel response for the previous attempt cannot release a held retry permit',{timeout:90000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await page.locator('#sourceText').fill('The original completed note.');await page.locator('#send').click();await h.started(1);await h.finish(0);await h.ready(page);await eventually(()=>h.host.snapshot().active,value=>!value);
  const oldRecord=structuredClone(h.state.records.get('one:'+h.submissions[0].record.record_id));h.state.holdAcceptedActions.add('learning.retry');await page.locator('#editRecord').click();await page.locator('#retryText').fill('The new attempt is not accepted yet.');await page.locator('#retryConfirm').click();await h.started(2);const retryRequest=h.submissions[1].body.request_id;
  await h.host.select('This selection must wait for matching cancellation recovery.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await page.locator('#queueCancel').click();await eventually(()=>h.host.commands.some(entry=>entry.message.op==='recover'&&entry.resolved)||h.host.snapshot().active?.phase==='unknown');
  assert.equal(h.state.records.get('one:'+oldRecord.record_id).request_id,oldRecord.request_id,'cancel of a terminal record returns its existing attempt unchanged');assert.equal(h.state.records.get('one:'+oldRecord.record_id).status,'complete');assert.equal(h.host.snapshot().active?.requestId,retryRequest,'a previous attempt cannot release the new retry permission');assert.equal(h.host.snapshot().active?.phase,'unknown');assert.equal(h.submissions.length,2);
  await h.finish(1,{emit:false});await h.started(3);assert.ok(h.state.recordReads.slice(0,h.submissions[2].readCountAtStart).some(read=>read.result?.request_id===retryRequest&&read.result?.status==='complete'),'matching new-attempt terminal GET must precede further learning');assert.equal(h.submissions[2].body.params.text,'This selection must wait for matching cancellation recovery.');await h.finish(2);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);assert.equal(h.submissions.filter(item=>item.body.request_id===retryRequest).length,1);h.clean();
});

test('a retry stream interruption cannot finish its permit from the preceding attempt returned by GET',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await page.locator('#sourceText').fill('The completed attempt returned by a stale GET.');await page.locator('#send').click();await h.started(1);await h.finish(0);await h.ready(page);await eventually(()=>h.host.snapshot().active,value=>!value);const oldRecord=structuredClone(h.state.records.get('one:'+h.submissions[0].record.record_id));
  h.state.holdAcceptedActions.add('learning.retry');await page.locator('#editRecord').click();await page.locator('#retryText').fill('The retry disconnects before accepted is delivered.');await page.locator('#retryConfirm').click();await h.started(2);const retry=h.submissions[1],jobId=h.host.snapshot().active.id;await h.host.select('This selection waits for the interrupted retry to be verified.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await h.interrupt(1);
  await eventually(()=>h.host.commands.some(entry=>entry.message.jobId===jobId&&['finish','unknown'].includes(entry.message.op)&&entry.resolved));assert.equal(h.state.records.get('one:'+oldRecord.record_id).request_id,oldRecord.request_id);assert.equal(h.host.snapshot().active?.requestId,retry.body.request_id,'a GET of the preceding complete request cannot settle the retry permit');assert.equal(h.host.snapshot().active?.phase,'unknown');assert.equal(h.submissions.length,2);
  await h.finish(1,{emit:false});await h.started(3);assert.ok(h.state.recordReads.slice(0,h.submissions[2].readCountAtStart).some(read=>read.result?.request_id===retry.body.request_id&&read.result?.status==='complete'),'matching retry GET must precede the next POST');await h.finish(2);assert.equal(h.submissions.filter(item=>item.body.request_id===retry.body.request_id).length,1);assert.equal(new Set(h.submissions.map(item=>item.body.request_id)).size,3);h.clean();
});

test('closing all panels and restarting the worker preserves pending order and never replays a claimed request',{timeout:90000},async t=>{
  const h=await harness(t),first=await h.open();await h.host.select('An accepted request survives a sidebar close.');await h.started(1);await h.host.select('The next selection waits for recovery.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);h.host.disconnectPage(first);await first.close();h.host.restart();
  const reopened=await h.open();await reopened.locator('#queueCheck').waitFor();assert.equal(h.submissions.length,1);await h.finish(0,{emit:false});await h.started(2);
  assert.ok(h.state.recordReads.slice(0,h.submissions[1].readCountAtStart).some(read=>read.recordId===h.submissions[0].record.record_id&&read.result?.request_id===h.submissions[0].body.request_id&&read.result?.status==='complete'),'the next POST requires a GET-confirmed terminal result of the original request');assert.equal(h.submissions[1].body.params.text,'The next selection waits for recovery.');await h.finish(1);assert.equal(h.submissions.filter(item=>item.body.params.text==='An accepted request survives a sidebar close.').length,1);h.clean();
});

test('account switches discard old pending selections and late results never enter the new account',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.host.select('First account active selection.');await h.started(1);await h.host.select('First account waiting selection.');await eventually(()=>h.host.snapshot().waiting.length,value=>value===1);await h.host.changeAccount('two');
  await page.waitForFunction(()=>document.querySelector('#connectionState').textContent.includes('two@example.test')&&!document.querySelector('#explanationLanguage').disabled);await h.finish(0,{emit:false});assert.equal(h.host.snapshot().waiting.length,0);assert.equal(h.host.snapshot().owner,'two');assert.equal(await page.locator('#sourceText').inputValue(),'');
  await h.host.select('Only the second account should learn this.');await h.started(2);assert.equal(h.submissions[1].owner,'two');assert.equal(h.submissions[1].body.params.explanation_language,'en');assert.equal(h.submissions.some(item=>item.body.params.text==='First account waiting selection.'),false);await h.finish(1);h.clean();
});

test('queue status fits three interface languages and four font themes at narrow sidebar widths',{timeout:90000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await page.locator('#sourceText').fill('An unsent draft keeps the return button visible.');await h.host.select('The active queue layout sample.');await h.started(1);await h.host.select('A waiting queue layout sample.');await page.locator('#selectionQueue').waitFor();await page.locator('#heldContent').waitFor();let iterations=0;
  for(const language of ['zh','ja','en'])for(const font of ['handwritten','bookish','clean','refined']){
    Object.assign(h.state.settings.one,{explanation_language:language,font_theme:font});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(({language,font})=>document.documentElement.dataset.uiLanguage===language&&document.documentElement.dataset.fontTheme===font,{language,font});
    const registration=h.host.holdRegistrationAcks();await h.host.disconnectPage(page);await page.locator('#queueConnection').waitFor();
    for(const width of [320,390,480]){
      await page.setViewportSize({width,height:760});await page.evaluate(()=>document.fonts.ready);
      for(const selector of ['#selectionQueue','#queueConnection','#heldContent']){
        const geometry=await page.locator(selector).evaluate(node=>{const rect=node.getBoundingClientRect(),root=document.documentElement;return {hidden:node.hidden,left:rect.left,right:rect.right,client:root.clientWidth,scroll:root.scrollWidth,buttons:[...node.querySelectorAll('button')].filter(button=>!button.hidden).map(button=>{const box=button.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,height:box.height};})};});const label=`${language}/${font}/${width}/${selector}`;assert.equal(geometry.hidden,false,label);assert.ok(geometry.scroll<=width,label+' must not create page overflow');assert.ok(geometry.left>=0&&geometry.right<=width,label);for(const box of geometry.buttons){assert.ok(box.left>=geometry.left&&box.right<=geometry.right,label);assert.ok(box.width>0&&box.height>=36,label+' keeps a usable button');}
      }
      iterations++;if(process.env.LINGO_SELECTION_SCREENSHOTS==='1'&&font==='refined'&&width!==480){await mkdir('.cache/selection-ui',{recursive:true});await page.screenshot({path:`.cache/selection-ui/${language}-${width}.png`,fullPage:true});}
    }
    registration.release();await page.locator('#queueConnection').waitFor({state:'hidden'});
  }
  assert.equal(iterations,36,'all language/font/width combinations ran with the three visible cards');assert.equal(h.submissions[0].body.params.explanation_language,'zh','later preference changes never rewrite already prepared request material');await page.locator('#queueClear').click();await eventually(()=>h.host.snapshot().waiting.length,value=>value===0);await h.finish(0);h.clean();
});

async function startJitterObservation(page,selector){
  await page.evaluate(()=>document.fonts.ready);
  return page.evaluate(async selector=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const target=document.querySelector(selector);assertTarget(target);
    function assertTarget(node){if(!node)throw Error('Missing geometry target '+selector);}
    const observation={selector,origin:performance.timeOrigin,frames:[],running:true};window.__jitterObservation=observation;
    const sample=()=>{const rect=document.querySelector(selector).getBoundingClientRect(),view=[...document.querySelectorAll('#learnView,#historyView,#settingsView')].find(node=>!node.hidden);observation.frames.push({top:rect.top,height:rect.height,scroll:scrollY,viewTop:view.getBoundingClientRect().top,connectionVisible:!document.querySelector('#queueConnection').hidden});if(observation.running)requestAnimationFrame(sample);};sample();
    return observation.frames[0];
  },selector);
}
async function finishJitterObservation(page){
  return page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const observation=window.__jitterObservation;observation.running=false;return {originUnchanged:performance.timeOrigin===observation.origin,frames:observation.frames};});
}
function assertStableFrames(observation,baseline,label){
  assert.equal(observation.originUnchanged,true,label+' must not reload the document');assert.ok(observation.frames.length>2,label+' measured real rendering frames');
  for(const property of ['top','height','scroll','viewTop']){
    const changed=observation.frames.filter(frame=>Math.abs(frame[property]-baseline[property])>1);
    assert.equal(changed.length,0,label+' changed '+property+' while only the transport recovered: '+JSON.stringify({baseline:baseline[property],first:changed[0],frames:observation.frames.length}));
  }
}

test('transport recovery keeps reading history and draft geometry stable on every frame',{timeout:90000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await page.setViewportSize({width:390,height:500});
  await h.host.select('Reading should stay still while a connection is renewed.');await h.started(1);await h.finish(0);await eventually(()=>h.host.snapshot().active,value=>!value);await h.ready(page);
  const recover=async(selector,label,{draft=false}={})=>{
    if(draft)await page.locator('#sourceText').evaluate(node=>{node.focus();node.setSelectionRange(5,16);});
    const before=await startJitterObservation(page,selector),oldPorts=new Set(h.host.ports.keys());
    await h.host.disconnectPage(page);await eventually(()=>[...h.host.ports.keys()].some(id=>!oldPorts.has(id)));await h.ready(page);
    const transient=await finishJitterObservation(page);assertStableFrames(transient,before,label+'/transient');
    assert.equal(transient.frames.some(frame=>frame.connectionVisible),false,label+' should not flash a connection warning during ordinary short recovery');
    const pending=h.host.holdRegistrationAcks(),persistentBefore=await startJitterObservation(page,selector);
    await h.host.disconnectPage(page);await eventually(()=>pending.started);await page.locator('#queueConnection').waitFor();assert.equal(await page.locator('#queueReconnect').isEnabled(),true);
    assert.match(await page.locator('#queueConnectionText').textContent(),/连接|重连/);pending.release();await h.ready(page);await page.locator('#queueConnection').waitFor({state:'hidden'});
    const persistent=await finishJitterObservation(page);assertStableFrames(persistent,persistentBefore,label+'/persistent');assert.ok(persistent.frames.some(frame=>frame.connectionVisible),label+' must still show actionable sustained failures');
    if(draft){const editor=await page.locator('#sourceText').evaluate(node=>({text:node.value,focus:document.activeElement===node,start:node.selectionStart,end:node.selectionEnd}));assert.deepEqual(editor,{text:'Keep this precise unsent editor selection unchanged.',focus:true,start:5,end:16});}
  };
  await recover('.lesson-overview','reading');
  for(let index=0;index<12;index++){const id='jitter-history-'+index;h.state.records.set('one:'+id,{record_id:id,request_id:'jitter-saved-'+index,revision:1,status:'complete',input_type:'text',local_date:'2026-11-22',original_text:'Stable history reading position '+index,explanation_language:'zh',result:lesson('zh')});}
  await page.locator('#historyTab').click();await page.locator('.history-row').first().waitFor();await page.evaluate(()=>window.scrollTo(0,100));
  const historySelector=await page.evaluate(()=>{const top=document.querySelector('header').getBoundingClientRect().bottom,row=[...document.querySelectorAll('.history-row')].find(row=>row.getBoundingClientRect().bottom>top);return '[data-record-id="'+row.dataset.recordId+'"]';});
  await recover(historySelector,'history');assert.equal(await page.locator('#historyView').isVisible(),true);
  await page.locator('#learnTab').click();await page.locator('#sourceText').fill('Keep this precise unsent editor selection unchanged.');await h.ready(page);await recover('#sourceText','draft',{draft:true});
  assert.equal(h.submissions.length,1,'transport recovery never submits another lesson');h.clean();
});

test('unchanged queue snapshots preserve material selection and native detail state',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);const material='A queued material selection must survive repeated synchronization.';
  await h.host.select('The preceding request holds the execution permit.');await h.started(1);await h.host.select(material);
  await eventually(()=>h.host.snapshot(),snapshot=>snapshot.waiting[0]?.text===material&&snapshot.waiting[0]?.phase==='ready'&&snapshot.presented['1']===snapshot.presentations['1'].sequence);
  await page.locator('#recordSection').waitFor();await page.locator('#recordDetails').evaluate(node=>{node.open=true;});await page.locator('#recordOriginal').filter({hasText:material}).waitFor();await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>{
    const original=document.querySelector('#recordOriginal'),text=original.firstChild,range=document.createRange();range.setStart(text,2);range.setEnd(text,20);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    window.__sameMaterial={text,selected:selection.toString(),detailChanges:0,contentChanges:0};
    new MutationObserver(records=>{window.__sameMaterial.detailChanges+=records.filter(record=>record.attributeName==='open').length;}).observe(document.querySelector('#recordDetails'),{attributes:true,attributeFilter:['open']});
    new MutationObserver(records=>{window.__sameMaterial.contentChanges+=records.length;}).observe(original,{childList:true,characterData:true,subtree:true});
  });
  const version=h.host.snapshot().version;for(let index=0;index<4;index++){for(const port of h.host.ports.values())port.postMessage({event:'selection-queue.changed',snapshot:h.host.snapshot()});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));}
  const syncs=h.host.commands.filter(entry=>entry.message.op==='sync'&&entry.resolved).length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await eventually(()=>h.host.commands.filter(entry=>entry.message.op==='sync'&&entry.resolved).length,value=>value>syncs);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const state=await page.evaluate(()=>({...window.__sameMaterial,text:undefined,textSame:window.__sameMaterial.text===document.querySelector('#recordOriginal').firstChild,selectedNow:getSelection().toString(),open:document.querySelector('#recordDetails').open}));
  assert.equal(h.host.snapshot().version,version,'no semantic queue change was introduced');assert.equal(state.textSame,true,'same material text must retain its native selection node');assert.equal(state.selectedNow,state.selected);assert.equal(state.open,true);assert.equal(state.detailChanges,0,'same snapshots must not close and reopen native details');assert.equal(state.contentChanges,0,'same material must not be rewritten');
  assert.equal(h.submissions.length,1,'the held first request retains the only permit');await h.finish(0);await h.started(2);assert.equal(h.submissions[1].body.params.text,material);await h.finish(1);h.clean();
});

test('unchanged processing recovery keeps the existing lesson and reading selection mounted',{timeout:60000},async t=>{
  const h=await harness(t),page=await h.open();await h.ready(page);await h.host.select('A processing request retains its previously saved lesson.');await h.started(1);
  const submission=h.submissions[0],record={...submission.record,result:lesson('zh')};h.state.records.set('one:'+record.record_id,record);await h.interrupt(0);await page.locator('.lesson-overview').waitFor();await page.locator('#queueCheck').waitFor();
  await page.evaluate(()=>{
    const lesson=document.querySelector('.lesson-overview'),text=lesson.firstChild,range=document.createRange();range.setStart(text,0);range.setEnd(text,8);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    window.__sameLesson={lesson,selected:selection.toString(),mutations:0};new MutationObserver(records=>{window.__sameLesson.mutations+=records.length;}).observe(document.querySelector('#lesson'),{childList:true,subtree:true,characterData:true});
  });
  const reads=h.state.recordReads.filter(read=>read.recordId===record.record_id).length;await eventually(()=>h.state.recordReads.filter(read=>read.recordId===record.record_id).length,value=>value>=reads+2,12000);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  const state=await page.evaluate(()=>({same:window.__sameLesson.lesson===document.querySelector('.lesson-overview'),selected:window.__sameLesson.selected,selectedNow:getSelection().toString(),mutations:window.__sameLesson.mutations}));
  assert.equal(state.same,true,'same processing GET must not remount the lesson');assert.equal(state.selectedNow,state.selected,'read-only recovery keeps native reading selection');assert.equal(state.mutations,0,'same processing record must not rebuild pronunciation/review controls');assert.equal(h.submissions.length,1);
  await h.finish(0,{emit:false});await eventually(()=>h.host.snapshot().active,value=>!value);await page.locator('#recordHeading[data-status="complete"]').waitFor();assert.equal(h.submissions.length,1,'the matching terminal GET advances without replay');h.clean();
});
