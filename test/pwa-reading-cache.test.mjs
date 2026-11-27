import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import http from 'node:http';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';

test('mobile reading preserves history anchors and reopens the same account cache offline', {timeout:90_000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-mobile-reading-'));
  const apiOrigin = 'https://reading-fixture.example';
  const storageKey = 'lingo-session:' + apiOrigin;
  const auth = id => ({user:{id,email:id+'@example.test'},access_token:id,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600});
  const previous = process.env.VITE_SUPABASE_URL;
  process.env.VITE_SUPABASE_URL = apiOrigin;
  try {
    await build({
      configFile:'pwa/vite.config.ts', logLevel:'silent', build:{outDir:directory,emptyOutDir:true},
      define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(apiOrigin),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'"fixture-key"'}
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = previous;
  }
  let documents=0;
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
  const server = http.createServer(async (request,response) => {
    const pathname=new URL(request.url,'http://127.0.0.1').pathname;
    const name=pathname === '/' ? '/index.html' : pathname;
    if (name === '/index.html') documents++;
    const file=resolve(directory, '.'+name);
    if (!file.startsWith(directory+sep)) return response.writeHead(403).end();
    try { const body=await readFile(file); response.writeHead(200,{'Content-Type':types[extname(file)] || 'application/octet-stream'}).end(body); }
    catch { response.writeHead(404).end(); }
  });
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('lingo-mobile-reading-'));
      await rm(directory,{recursive:true,force:true});
    }
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const first=Array.from({length:75},(_,index)=>({
    record_id:'note-'+index,revision:1,local_date:'2026-11-26',text:'Practice entry '+index,input_type:'text',status:'complete'
  }));
  const second=[{...first[0],record_id:'owner-b-note',text:'New owner only'}];
  const tracked=[];
  let removeNote=false;
  let readArrived, releaseRead;
  await context.route(apiOrigin+'/**',async route=>{
    const request=route.request();
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json'};
    if(request.method()==='OPTIONS')return route.fulfill({status:200,headers,body:''});
    const { action, params }=request.postDataJSON();
    const owner=request.headers().authorization?.slice(7);
    tracked.push({action,params,owner});
    const entries=owner==='owner-a' ? first.filter(note=>!removeNote || note.record_id!=='note-33') : second;
    let result;
    if (action==='settings.get') result={review_enabled:true,push_enabled:false};
    else if (action==='review.cards') result={cards:[]};
    else if (action==='records.history') {
      if (readArrived) {
        const ready=readArrived;readArrived=null;
        await new Promise(done=>{releaseRead=done;ready();});
      }
      const filtered=entries.filter(note=>note.text.includes(params.query));
      result={items:filtered.slice(params.offset,params.offset+30),has_more:filtered.length>params.offset+30};
    } else if (action==='records.get') {
      const note=entries.find(item=>item.record_id===params.record_id);
      result=note ? {...note,original_text:note.text,result:{language:'en',summary_zh:'合成讲解 '+note.text,vocabulary:[],grammar:[]}} : null;
    } else throw Error('UNEXPECTED_ACTION '+action);
    return route.fulfill({status:200,headers,body:JSON.stringify({ok:true,result})});
  });
  async function disk(page) {
    return await page.evaluate(()=>new Promise((resolve,reject)=>{
      const request=indexedDB.open('lingo-private-reading');
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result;
        const transaction=db.transaction('pages');
        const get=transaction.objectStore('pages').getAll();
        get.onsuccess=()=>resolve(get.result);
        transaction.oncomplete=()=>db.close();
      };
    }));
  }
  let page=await context.newPage();
  await page.addInitScript(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key:storageKey,value:auth('owner-a')});
  await page.goto(origin+'/?tab=history');
  await expect(page.locator('.history-row')).toHaveCount(30);
  await page.getByRole('searchbox').fill('Practice');
  await expect.poll(()=>tracked.some(call=>call.action==='records.history'&&call.params.query==='Practice')).toBeTruthy();
  await page.getByRole('button',{name:'查看更多',exact:true}).click();
  await expect(page.locator('.history-row')).toHaveCount(60);
  const target=page.locator('[data-reading-anchor="note-33"]');
  await target.evaluate(row=>window.scrollBy(0,row.getBoundingClientRect().top-140));
  const scroll=await page.evaluate(()=>scrollY);
  const historyReads=()=>tracked.filter(call=>call.action==='records.history').length;
  const beforeBack=historyReads(), initialDocuments=documents;
  await target.locator('.history-open').click();
  await expect(page.getByRole('heading',{name:'Practice entry 33',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.getByRole('searchbox')).toHaveValue('Practice');
  await expect(page.locator('.history-row')).toHaveCount(60);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scroll)<5);
  assert.equal(historyReads(),beforeBack);
  assert.equal(documents,initialDocuments);
  await page.goForward();
  await expect(page.getByRole('heading',{name:'Practice entry 33',exact:true})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('Practice');
  await expect(page.locator('.history-row')).toHaveCount(60);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scroll)<5);

  await page.waitForTimeout(510);
  const started=new Promise(done=>{readArrived=done;});
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  await started;
  await expect(page.locator('.history-row')).toHaveCount(60);
  assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scroll)<5);
  releaseRead();
  await expect.poll(historyReads).toBe(beforeBack+2);
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  await expect.poll(async()=> (await disk(page)).some(row=>row.key==='record:note-33')).toBeTruthy();
  assert.doesNotMatch(JSON.stringify(await disk(page)),/synthetic-refresh|access_token|push\.apple/);
  const docsBeforeOffline=documents;
  await context.setOffline(true);
  await page.close();
  page=await context.newPage();
  await page.goto(origin+'/?record=note-33');
  await expect(page.getByRole('heading',{name:'Practice entry 33',exact:true})).toBeVisible();
  await expect(page.locator('.offline-notice')).toBeVisible();
  assert.equal(documents,docsBeforeOffline);
  await expect(page.getByRole('button',{name:'删除这条记录',exact:true})).toBeDisabled();

  removeNote=true;
  await context.setOffline(false);
  await expect(page.getByRole('heading',{name:'暂时无法打开记录',exact:true})).toBeVisible();
  await expect.poll(async()=> (await disk(page)).some(row=>JSON.stringify(row.value).includes('"record_id":"note-33"'))).toBe(false);
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.getByRole('heading',{name:'学习历史',exact:true})).toBeVisible();
  await page.evaluate(({key,value})=>{
    localStorage.setItem(key,JSON.stringify(value));
    window.dispatchEvent(new StorageEvent('storage',{key}));
  },{key:storageKey,value:auth('owner-b')});
  await expect(page.getByRole('heading',{name:'New owner only',exact:true})).toBeVisible();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await expect.poll(async()=> (await disk(page)).every(row=>row.owner.endsWith(':owner-b'))).toBeTruthy();
});
