import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createCloudClient } from '../shared/cloud-client.ts';

const session = id => ({ access_token: `synthetic-${id}`, refresh_token: `synthetic-refresh-${id}`, expires_at: Date.now() / 1000 + 3600, user: { id, email: `${id}@example.test` } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('late 401 from old account must not remove the newly authenticated account', async () => {
  const pending = new Map(); const saved = new Map([['lingo-session:https://review-api.example', JSON.stringify(session('user-a'))]]);
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } };
  const client = createCloudClient({ url: 'https://review-api.example', publishableKey: 'synthetic', storage, fetch: async (url, options) => {
    if (url.endsWith('/token?grant_type=password')) return json(session('user-b'));
    const body = JSON.parse(options.body); const wait = deferred(); pending.set(body.request_id, wait); return wait.promise;
  } });
  const first = client.call('records.history', {}, 'first').catch(error => error.code);
  const second = client.call('records.history', {}, 'second').catch(error => error.code);
  while (pending.size !== 2) await new Promise(resolve => setTimeout(resolve, 0));
  pending.get('first').resolve(json({ ok: false, error: 'UNAUTHORIZED' }, 401));
  assert.equal(await first, 'AUTH_EXPIRED');
  await client.signIn('user-b@example.test', 'synthetic-password');
  assert.equal((await client.getSession()).user.id, 'user-b');
  pending.get('second').resolve(json({ ok: false, error: 'UNAUTHORIZED' }, 401));
  assert.equal(await second, 'SESSION_CHANGED');
  assert.equal((await client.getSession())?.user.id, 'user-b');
});

test('editing record A while context waits must never send its text as a retry of record B', { timeout: 30000 }, async t => {
  const bundle = await build({ entryPoints: ['extension/panel.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, define: { __SUPABASE_URL__: JSON.stringify('https://review-api.example'), __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify('synthetic') } });
  const html = await readFile('extension/panel.html'); const css = await readFile('extension/panel.css');
  const server = http.createServer((request, response) => {
    const asset = request.url === '/panel.js' ? [bundle.outputFiles[0].text, 'text/javascript'] : request.url === '/panel.css' ? [css, 'text/css'] : [html, 'text/html'];
    response.writeHead(200, { 'content-type': asset[1] }); response.end(asset[0]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(({ session }) => {
    const stores = { local: { 'lingo-session:https://review-api.example': JSON.stringify(session) }, session: { 'panel:user-a': { last_record_id: 'record-a', panel_state: { view: 'record' }, 'binding:record-a': { tabId: 1 }, 'binding:record-b': { tabId: 1 } } } };
    const area = name => ({ async get(keys) { if (!keys) return { ...stores[name] }; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stores[name][key]])); }, async set(update) { Object.assign(stores[name], update); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stores[name][key]; } });
    window.chrome = { storage: { local: area('local'), session: area('session'), onChanged: { addListener() {} } }, runtime: { connect() { return { onMessage: { addListener() {} } }; }, async sendMessage(message) { if (message.kind === 'context') return new Promise(resolve => { window.releaseContext = () => resolve({ ok: true, result: { context: 'context for A', status: 'matched', binding: { tabId: 1 }, source: null } }); }); return { ok: true, result: {} }; } } };
  }, { session: session('user-a') });
  const record = id => ({ record_id: id, revision: 2, status: 'complete', input_type: 'text', local_date: '2026-11-19', original_text: id === 'record-a' ? 'alpha' : 'bravo', result: { language: 'en', summary_zh: '合成讲解', vocabulary: [], grammar: [] } });
  const calls = [];
  await page.route('https://review-api.example/**', async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 200, headers, body: '' }); return; }
    const body = route.request().postDataJSON(); calls.push(body); let result;
    if (body.action === 'records.get') result = record(body.params.record_id);
    else if (body.action === 'records.history') result = { items: ['record-a', 'record-b'].map(id => ({ ...record(id), text: record(id).original_text })), has_more: false };
    else if (body.action === 'learning.retry') result = record(body.params.record_id);
    else result = {};
    await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, result }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('#recordOriginal').textContent === 'alpha');
  await page.locator('#menu summary').click(); await page.locator('#editRecord').click();
  await page.locator('#retryText').fill('edited alpha'); await page.locator('#retryConfirm').click();
  await page.waitForFunction(() => typeof window.releaseContext === 'function');
  await page.locator('#historyTab').click(); await page.locator('.history-card').filter({ hasText: 'bravo' }).click();
  await page.waitForFunction(() => document.querySelector('#recordOriginal').textContent === 'bravo');
  await page.evaluate(() => window.releaseContext());
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('输入内容已改变'));
  assert.equal(calls.some(call => call.action === 'learning.retry'), false);
  assert.equal(await page.locator('#recordOriginal').textContent(), 'bravo');
});

test('a saved terminal error stops processing even if the following recovery read fails', { timeout: 30000 }, async t => {
  const bundle = await build({ entryPoints: ['extension/panel.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, define: { __SUPABASE_URL__: JSON.stringify('https://review-api.example'), __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify('synthetic') } });
  const html = await readFile('extension/panel.html'); const css = await readFile('extension/panel.css');
  const server = http.createServer((request, response) => {
    const asset = request.url === '/panel.js' ? [bundle.outputFiles[0].text, 'text/javascript'] : request.url === '/panel.css' ? [css, 'text/css'] : [html, 'text/html'];
    response.writeHead(200, { 'content-type': asset[1] }); response.end(asset[0]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(({ session }) => {
    const stores = { local: { 'lingo-session:https://review-api.example': JSON.stringify(session) }, session: { 'panel:user-a': { last_record_id: 'record-a', panel_state: { view: 'record' }, 'binding:record-a': { tabId: 1 } } } };
    const area = name => ({ async get(keys) { if (!keys) return { ...stores[name] }; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stores[name][key]])); }, async set(update) { Object.assign(stores[name], update); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stores[name][key]; } });
    window.chrome = { storage: { local: area('local'), session: area('session'), onChanged: { addListener() {} } }, runtime: { connect() { return { onMessage: { addListener() {} } }; }, async sendMessage() { return { ok: true, result: { context: 'synthetic context', status: 'matched', binding: { tabId: 1 }, source: null } }; } } };
  }, { session: session('user-a') });
  const saved = { record_id: 'record-a', revision: 2, status: 'complete', input_type: 'text', local_date: '2026-11-19', original_text: 'alpha', result: { language: 'en', summary_zh: '上次完整的合成讲解', vocabulary: [], grammar: [] } };
  let attempted = false, recoveryReads = 0;
  await page.route('https://review-api.example/**', async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 200, headers, body: '' }); return; }
    const body = route.request().postDataJSON();
    if (body.action === 'learning.retry') {
      attempted = true;
      const base = { request_id: body.request_id, record_id: 'record-a' };
      const events = `event: accepted\ndata: ${JSON.stringify({ ...base, revision: 3, record: { ...saved, revision: 3, status: 'processing' } })}\n\nevent: error\ndata: ${JSON.stringify({ ...base, revision: 4, error: 'INVALID_LESSON', record: { ...saved, revision: 4, status: 'failed', error: 'INVALID_LESSON' } })}\n\n`;
      await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/event-stream' }, body: events }); return;
    }
    if (body.action === 'records.get' && attempted) { recoveryReads++; await route.fulfill({ status: 503, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'NETWORK_ERROR' }) }); return; }
    await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, result: body.action === 'records.get' ? saved : {} }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('#recordOriginal').textContent === 'alpha');
  await page.locator('#menu summary').click(); await page.locator('#editRecord').click(); await page.locator('#retryText').fill('edited alpha'); await page.locator('#retryConfirm').click();
  await page.waitForFunction(() => document.querySelector('#recordHeading').textContent === '处理失败');
  while (!recoveryReads) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await page.locator('#cancelJob').isVisible(), false);
  assert.match(await page.locator('#recordError').textContent(), /未通过完整性检查/);
  assert.match(await page.locator('#lesson').textContent(), /上次完整的合成讲解/);
});
