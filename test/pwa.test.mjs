import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { dailyReviewLimit, parseRoute, readSetupLink, reviewCards, safeExternalUrl, speechContent, userError, vapidBytes } from '../pwa/src/model.mjs';

test('PWA notification route survives sign-in URL and rejects arbitrary destinations', () => {
  assert.deepEqual(parseRoute('https://notes.example/?batch=batch_123&record=record-456'), { tab: 'today', batchId: 'batch_123', recordId: 'record-456' });
  assert.deepEqual(parseRoute('https://notes.example/?tab=https://evil.test&batch=../../secret&record=<script>'), { tab: 'today', batchId: null, recordId: null });
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('https://name:secret@example.com'), null);
  assert.equal(safeExternalUrl('https://example.com/article'), 'https://example.com/article');
});
test('password setup accepts only explicit recovery token fragments', () => {
  const token = 'a'.repeat(64);
  assert.deepEqual(readSetupLink(`https://notes.example/#token_hash=${token}&token_type=recovery`), { present: true, token });
  assert.deepEqual(readSetupLink(`https://notes.example/#token_hash=${token}&token_type=signup`), { present: true, token: null });
  assert.deepEqual(readSetupLink('https://notes.example/#token_hash=bad&token_type=recovery'), { present: true, token: null });
  assert.deepEqual(readSetupLink('https://notes.example/?batch=one'), { present: false, token: null });
});
test('PWA shows the server batch without a second limit and excludes mastered points', () => {
  const batch = { cards: Array.from({ length: 9 }, (_, id) => ({ id, mastered: id === 3, reviewed: id === 4 })) };
  assert.deepEqual(reviewCards(batch).map(card => card.id), [0, 1, 2, 4, 5, 6, 7, 8]);
  assert.equal(batch.cards.length, 9);
  assert.deepEqual(reviewCards(null), []);
});

test('daily review count accepts whole numbers within 1–100 only', () => {
  for (const value of ['1', '5', '100', ' 25 ']) assert.equal(dailyReviewLimit(value), Number(value));
  for (const value of ['', ' ', '0', '101', '-1', '1.5', '5.0', '1e2', null, 5]) assert.equal(dailyReviewLimit(value), null);
});
test('pronunciation reads Japanese kana but never reads English IPA as the word', () => {
  assert.deepEqual(speechContent('勉強', 'べんきょう', 'ja'), { lang: 'ja-JP', text: 'べんきょう' });
  assert.deepEqual(speechContent('learn', '/lɜːn/', 'en'), { lang: 'en-US', text: 'learn' });
  assert.deepEqual(speechContent('学校へ行きます。', '', 'ja'), { lang: 'ja-JP', text: '学校へ行きます。' });
  assert.deepEqual([...vapidBytes('AQID-_8')], [1, 2, 3, 251, 255]);
});
test('error presentation never echoes an unknown backend response or credential', () => {
  const error = userError(new Error('sk-private-secret response user@example.com'));
  assert.doesNotMatch(error, /private|example|secret/);
  assert.match(userError({ code: 'AUTH_EXPIRED' }), /登录已过期/);
});

async function worker({ origin = 'https://notes.example', transport = async () => new Response('<html>/assets/app.js /assets/app.css</html>'), cachedResponse, clients = [] } = {}) {
  const source = (await readFile(new URL('../pwa/service-worker.js', import.meta.url), 'utf8')).replace('__CACHE_VERSION__', 'test').replace('/*__BUILD_ASSETS__*/', '"/assets/app.js","/assets/app.css"').replace('/*__BUILD_FONTS__*/', '"/assets/public-font.woff2"');
  const listeners = new Map(); const notifications = []; const fetched = []; const cached = []; const opened = [];
  const stored = new Map(cachedResponse ? [['/',cachedResponse]] : []);
  const cache = {
    async addAll(paths) { cached.push(...paths); },
    async put(path, response) { cached.push(path); stored.set(path, response.clone()); },
    async match(path) { return stored.get(path)?.clone(); },
  };
  const self = {
    location: { origin },
    addEventListener(type, handler) { listeners.set(type, handler); },
    async skipWaiting() {},
    clients: { async claim() {}, async matchAll() { return clients; }, async openWindow(url) { opened.push(url); } },
    registration: { async showNotification(title, options) { notifications.push({ title, options }); } },
  };
  vm.runInNewContext(source, { self, URL, Response, Set, Promise, MessageChannel, setTimeout, clearTimeout, caches: { async open() { return cache; }, async keys() { return []; }, async delete() {} }, async fetch(url, options) { fetched.push(url); return transport(url, options); } });
  async function dispatch(type, data = {}) {
    const promises = []; let responded = false, responsePromise;
    const event = { ...data, waitUntil(promise) { promises.push(promise); }, respondWith(promise) { responded = true; responsePromise = Promise.resolve(promise); promises.push(responsePromise); } };
    listeners.get(type)(event);
    await Promise.all(promises);
    await Promise.all(promises);
    return { responded, response: responsePromise ? await responsePromise : undefined };
  }
  return { dispatch, notifications, fetched, cached, opened };
}
test('service worker caches only the public build shell; never API or signed images', async () => {
  const sw = await worker(); await sw.dispatch('install');
  assert.ok(sw.cached.includes('/assets/app.js'));
  assert.ok(sw.cached.includes('/'));
  assert.equal(sw.cached.includes('/index.html'), false);
  for (const url of [
    'https://project.supabase.co/functions/v1/app-api',
    'https://project.supabase.co/storage/v1/object/sign/screenshots/picture.png?token=private',
    'https://notes.example/api/private',
    'https://notes.example/private/picture.png',
    'https://notes.example/assets/app.js?user=private',
  ]) {
    assert.equal((await sw.dispatch('fetch', { request: { url, method: 'GET', mode: 'cors' } })).responded, false, url);
  }
  const result = await sw.dispatch('fetch', { request: { url: 'https://notes.example/?batch=private-batch', method: 'GET', mode: 'navigate' } });
  assert.equal(result.responded, true);
  assert.deepEqual(sw.fetched, ['/'], 'only installation requests HTML; warm navigation reads the installed cache');
  assert.equal(sw.cached.some(path => path.includes('private')), false);
});

test('canonical navigation avoids a real index.html redirect and never returns redirected cached HTML', async t => {
  let redirectRoot = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/index.html') { response.writeHead(301, { Location: '/' }).end(); return; }
    if (request.url === '/' && redirectRoot) { response.writeHead(302, { Location: '/landing' }).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>canonical public shell</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(`${origin}/`, { redirect: 'manual' });
  const index = await fetch(`${origin}/index.html`, { redirect: 'manual' });
  assert.equal(root.status, 200); assert.equal(index.status, 301); assert.equal(index.headers.get('location'), '/');
  const oldRedirected = await fetch(`${origin}/index.html`);
  assert.equal(oldRedirected.redirected, true, 'models the redirected response previously cached under index.html');
  const optionsSeen = [];
  const transport = async (url, options) => { optionsSeen.push(options); return fetch(new URL(url, origin), options); };
  const sw = await worker({ origin, transport, cachedResponse: oldRedirected });
  requests.length = 0;
  for (const pathname of ['/?batch=private-id', '/index.html']) {
    const result = await sw.dispatch('fetch', { request: { url: origin + pathname, method: 'GET', mode: 'navigate' } });
    assert.equal(result.response.status, 200); assert.equal(result.response.redirected, false);
    assert.equal(await result.response.text(), '<html>canonical public shell</html>');
  }
  assert.deepEqual(requests, ['/', '/']);
  assert.ok(optionsSeen.every(options => options.redirect === 'error' && options.credentials === 'omit'));
  assert.deepEqual(sw.cached, [], 'a fallback response must not mix versions in the installed cache');
  redirectRoot = true;
  const rejected = await sw.dispatch('fetch', { request: { url: `${origin}/`, method: 'GET', mode: 'navigate' } });
  assert.equal(rejected.response.type, 'error', 'a network redirect must not fall back to an old redirected response');
  const offline = await worker({ origin, transport: async () => { throw new Error('offline'); }, cachedResponse: new Response('safe cached public shell') });
  const fallback = await offline.dispatch('fetch', { request: { url: `${origin}/`, method: 'GET', mode: 'navigate' } });
  assert.equal(fallback.response.redirected, false); assert.equal(await fallback.response.text(), 'safe cached public shell');
});
test('public fonts are cached on demand and failures or private font URLs are not cached', async () => {
  let networkCalls = 0;
  let available = false;
  const sw = await worker({ transport: async (request, options) => {
    if(request === '/')return new Response('<html>/assets/app.js /assets/app.css</html>');
    networkCalls++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(available ? 'wOF2public-font-bytes' : 'unavailable', { status: available ? 200 : 503, headers: { 'content-type': 'font/woff2' } });
  } });
  await sw.dispatch('install');
  assert.equal(sw.cached.includes('/assets/public-font.woff2'), false, 'install does not fetch every CJK subset');
  const request = { url: 'https://notes.example/assets/public-font.woff2', method: 'GET', mode: 'cors' };
  const failed = await sw.dispatch('fetch', { request });
  assert.equal(failed.response.status, 503);
  assert.equal(sw.cached.includes('/assets/public-font.woff2'), false);
  available = true;
  const loaded = await sw.dispatch('fetch', { request });
  assert.equal(await loaded.response.text(), 'wOF2public-font-bytes');
  const reused = await sw.dispatch('fetch', { request });
  assert.equal(await reused.response.text(), 'wOF2public-font-bytes');
  assert.equal(networkCalls, 2, 'the third request uses the current cache');
  for (const url of ['https://notes.example/assets/unknown-font.woff2', request.url + '?token=private', 'https://private.example/assets/public-font.woff2']) {
    assert.equal((await sw.dispatch('fetch', { request: { ...request, url } })).responded, false);
  }
  for (const [body, type] of [['<html>SPA fallback</html>', 'text/html'], ['not-a-font', 'font/woff2']]) {
    const invalid = await worker({ transport: async () => new Response(body, { headers: { 'content-type': type } }) });
    await invalid.dispatch('fetch', { request });
    assert.equal(invalid.cached.includes('/assets/public-font.woff2'), false, 'a successful HTTP response must still contain a WOFF2 font');
  }
});

test('service worker ignores push plaintext and binds notification tag to batch', async () => {
  const sw = await worker();
  await sw.dispatch('push', { data: { json() { return { batch_id: 'batch_123', title: 'private term', body: 'private explanation', url: 'https://evil.test' }; } } });
  assert.equal(sw.notifications[0].title, 'Lingo Notes');
  assert.doesNotMatch(sw.notifications[0].options.body, /private/);
  assert.equal(sw.notifications[0].options.tag, 'lingo-review-batch_123');
  assert.equal(sw.notifications[0].options.data.path, '/?batch=batch_123');
  await sw.dispatch('notificationclick', { notification: { close() {}, data: { path: 'https://evil.test' } } });
  assert.deepEqual(sw.opened, ['https://notes.example/']);
  await sw.dispatch('notificationclick', { notification: { close() {}, data: { path: '/?batch=batch_123' } } });
  assert.equal(sw.opened.at(-1), 'https://notes.example/?batch=batch_123');
});

test('test notifications are distinct and a batch opens in the existing PWA without a reload', async () => {
  const delivered=[];
  let focused=0;
  const client={
    url:'https://notes.example/?tab=history',
    postMessage(message, [port]) { delivered.push(message); port.postMessage('LINGO_REVIEW_OPENED'); port.close(); },
    async focus() { focused++; },
    async navigate() { assert.fail('confirmed in-app navigation must not reload the document'); }
  };
  const sw=await worker({clients:[client]});
  await sw.dispatch('push',{data:{json:()=>({kind:'test',batch_id:null})}});
  assert.equal(sw.notifications[0].options.tag,'lingo-test');
  assert.match(sw.notifications[0].options.body,/通知测试/);
  await sw.dispatch('notificationclick',{notification:{close(){},data:{path:'/?batch=batch_123'}}});
  assert.equal(delivered[0].type,'LINGO_OPEN_REVIEW');
  assert.equal(delivered[0].batch,'batch_123');
  assert.equal(focused,1);
  assert.deepEqual(sw.opened,[]);
});
