import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'vite';
import { chromium } from '@playwright/test';

test('PWA browser flow: password login, one-time setup, batch route, audio, history deletion and permission gesture', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lingo-pwa-ui-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('lingo-pwa-ui-'));
    await rm(directory, { recursive: true, force: true });
  });
  const previous = process.env.VITE_SUPABASE_URL;
  process.env.VITE_SUPABASE_URL = 'https://pwa-api.example';
  try {
    await build({ configFile: 'pwa/vite.config.ts', logLevel: 'silent', build: { outDir: directory, emptyOutDir: true }, define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://pwa-api.example'), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('synthetic-publishable-key'), 'import.meta.env.VITE_VAPID_PUBLIC_KEY': JSON.stringify('AQIDBA') } });
  } finally { if (previous === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous; }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${directory}${path.sep}`)) { response.writeHead(403).end(); return; }
    try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(body); } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let browser;
  try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.testSpeech = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], cancel: () => window.testSpeech.push('stop'), resume() {}, speak: utterance => window.testSpeech.push(utterance.text) } });
    window.permissionRequests = 0;
    function TestNotification() {}
    TestNotification.permission = 'default';
    TestNotification.requestPermission = async () => { window.permissionRequests++; TestNotification.permission = 'granted'; return 'granted'; };
    Object.defineProperty(window, 'Notification', { configurable: true, value: TestNotification });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} });
    let subscribed = false;
    const subscription = { endpoint: 'https://push.example/synthetic', toJSON: () => ({ endpoint: 'https://push.example/synthetic', keys: { p256dh: 'fixture', auth: 'fixture' } }), unsubscribe: async () => { subscribed = false; return true; } };
    const worker = { active: {}, pushManager: { getSubscription: async () => subscribed ? subscription : null, subscribe: async () => { if (window.pushErrorName) throw new DOMException('private endpoint https://push.example/private-token', window.pushErrorName); subscribed = true; return subscription; } } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => worker, register: async () => worker, ready: Promise.resolve(worker) } });
  });
  const examples = [{ text: 'We learn every day.', translation: '我们每天都学习。' }, { text: 'I want to learn.', translation: '我想学习。' }, { text: 'They learn together.', translation: '他们一起学习。' }];
  const vocabulary = [{ term: 'learn', reading: '/lɜːn/', pos: '动词', meaning: '学习；学会', examples }];
  const japaneseExamples = [{ text: '毎日、本を読みます。', translation: '每天读书。' }, { text: '毎日歩きます。', translation: '每天走路。' }, { text: '毎日少しずつ学びます。', translation: '每天学一点。' }];
  const japaneseVocabulary = [{ term: '毎日', reading: 'まいにち', pos: '名词', meaning: '每天', examples: japaneseExamples }];
  let records = [{ record_id: 'record-one', revision: 1, local_date: '2026-11-19', text: 'learn', status: 'completed', input_type: 'text' }, { record_id: 'record-two', revision: 1, local_date: '2026-11-19', text: '毎日', status: 'completed', input_type: 'text' }];
  const settings = { review_enabled: true, push_enabled: false, explanation_mode: 'fast', font_theme: 'clean' };
  const actions = []; const authBodies = []; const authCalls = []; let imageSequence = 0, holdNextImage = false, releaseImage, staleSettings = false, serverSubscription = null;
  let holdNextSettings = false, releaseSettings, settingsHeld, holdNextFontSave = false, releaseFontSave, fontSaveHeld, rejectNextFontSave = false;
  await page.route('https://pwa-api.example/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 200, headers, body: '' }); return; }
    if (request.method() === 'GET' && url.pathname.startsWith('/storage/')) { await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'image/png', 'cache-control': 'no-store' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGs8AAAAASUVORK5CYII=', 'base64') }); return; }
    const body = request.postDataJSON();
    if (url.pathname.startsWith('/auth/v1/')) {
      authBodies.push(body);
      authCalls.push({ path: url.pathname, query: url.search, method: request.method(), body });
      if (url.pathname.endsWith('/verify') && body.token_hash === 'e'.repeat(64)) { await route.fulfill({ status: 400, headers, body: JSON.stringify({ error: 'Expired setup token' }) }); return; }
      const response = url.pathname.endsWith('/verify') || url.pathname.endsWith('/token') ? { access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_in: 3600, user: { id: 'synthetic-user', email: 'reader@example.test' } } : { id: 'synthetic-user' };
      await route.fulfill({ status: 200, headers, body: JSON.stringify(response) }); return;
    }
    actions.push(body);
    if (body.action === 'settings.get' && staleSettings) { staleSettings = false; await route.fulfill({ status: 400, headers, body: JSON.stringify({ ok: false, error: 'SESSION_CHANGED' }) }); return; }
    let result = {};
    if (body.action === 'review.cards') result = { cards: [] };
    if (body.action === 'review.get' || body.action === 'review.today') result = { batch: { id: 'batch-one', local_date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10), cards: [{ id: 'card-one', record_id: 'record-one', term: 'learn', reading: '/lɜːn/', language: 'en', meaning: '学习；学会', example: examples[0], local_date: '2026-11-18' }] } };
    if (body.action === 'records.history') result = { items: records.filter(item => item.text.includes(body.params.query || '')), has_more: false };
    if (body.action === 'records.get') {
      const japanese = body.params.record_id === 'record-two';
      result = { ...records.find(item => item.record_id === body.params.record_id), context: japanese ? '毎日、本を読みます。' : 'We learn every day.', result: { language: japanese ? 'ja' : 'en', summary_zh: '从新知识中学习。', vocabulary: japanese ? japaneseVocabulary : vocabulary, grammar: [] }, source: null, image: { path: `${body.params.record_id}.png`, mime_type: 'image/png' } };
    }
    if (body.action === 'images.url') { if (holdNextImage && body.params.record_id === 'record-one') { holdNextImage = false; await new Promise(resolve => { releaseImage = resolve; }); } result = { url: `https://pwa-api.example/storage/${body.params.record_id}.png?signature=${++imageSequence}`, expires_in: 60 }; }
    if (body.action === 'records.delete') records = records.filter(item => item.record_id !== body.params.record_id);
    if (body.action === 'settings.get') { result = { ...settings }; if (holdNextSettings) { holdNextSettings = false; settingsHeld?.(); await new Promise(resolve => { releaseSettings = resolve; }); } }
    if (body.action === 'settings.update') {
      if (body.params.font_theme && rejectNextFontSave) { rejectNextFontSave = false; await route.fulfill({ status: 503, headers, body: JSON.stringify({ ok: false, error: 'NETWORK_ERROR' }) }); return; }
      if (body.params.font_theme && holdNextFontSave) { holdNextFontSave = false; fontSaveHeld?.(); await new Promise(resolve => { releaseFontSave = resolve; }); }
      if (body.params.push_enabled && !serverSubscription) { await route.fulfill({ status: 400, headers, body: JSON.stringify({ ok: false, error: 'PUSH_SUBSCRIPTION_MISSING' }) }); return; }
      Object.assign(settings, body.params); result = { ...settings };
    }
    if (body.action === 'key.status') result = { configured: true, last_four: '1234' };
    if (body.action === 'push.subscribe') { serverSubscription = body.params.subscription; result = { subscribed: true }; }
    if (body.action === 'push.status' || body.action === 'push.test') {
      const fingerprint = serverSubscription ? createHash('sha256').update(JSON.stringify([serverSubscription.endpoint,serverSubscription.keys.p256dh,serverSubscription.keys.auth])).digest('hex') : null;
      const matches = Boolean(fingerprint && fingerprint === body.params.fingerprint);
      result = body.action === 'push.status' ? {device:matches?'current':fingerprint?'other':'missing'} : {accepted:matches};
    }
    await route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, result }) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?batch=batch-one`);
  await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
  await page.getByLabel('密码', { exact: true }).fill('synthetic-login-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: 'learn', exact: true }).waitFor();
  assert.equal(authCalls[0].query, '?grant_type=password');
  assert.equal(authBodies[0].password, 'synthetic-login-password');
  assert.equal(authCalls.some(call => /otp|signup/.test(call.path)), false);
  assert.ok(actions.some(item => item.action === 'review.get' && item.params.batch_id === 'batch-one'));
  assert.equal(await page.evaluate(() => window.permissionRequests), 0);
  const sizes = await page.locator('.example').first().evaluate(element => ({ example: getComputedStyle(element.querySelector('.example-original p')).fontSize, translation: getComputedStyle(element.querySelector('.translation')).fontSize }));
  assert.deepEqual(sizes, { example: '18px', translation: '18px' });
  assert.equal(await page.locator('.card-meta').first().evaluate(element => getComputedStyle(element).fontSize), '14px');
  assert.equal(await page.locator('.review-card .term').first().getAttribute('lang'), 'en');
  assert.match(await page.locator('.review-card .term').first().evaluate(element => getComputedStyle(element).fontFamily), /DM Sans/);
  assert.equal(await page.locator('.review-card .term').first().evaluate(element => getComputedStyle(element).fontWeight), '600');
  assert.equal(await page.locator('.example-original p').first().getAttribute('lang'), 'en');
  assert.equal(await page.locator('.translation').first().getAttribute('lang'), 'zh-CN');
  assert.match(await page.locator('.translation').first().evaluate(element => getComputedStyle(element).fontFamily), /Noto Sans SC/);
  assert.equal(await page.locator('.reading .reading-ipa').first().getAttribute('lang'), 'en');
  assert.match(await page.locator('.card-meta').first().evaluate(element => getComputedStyle(element).fontFamily), /DM Sans/);
  assert.equal(await page.getByRole('heading', { name: '今日复习', exact: true }).evaluate(element => getComputedStyle(element).fontSize), '30px');
  assert.equal(await page.getByRole('button', { name: '回看完整讲解' }).evaluate(element => getComputedStyle(element).fontWeight), '500');
  if (process.env.LINGO_PWA_SCREENSHOT === '1') {
    const screenshotPath = path.resolve('.cache/ui-review.png');
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await page.getByRole('button', { name: '播放发音：learn', exact: true }).click();
  await page.getByRole('button', { name: '停止发音：learn', exact: true }).click();
  assert.ok((await page.evaluate(() => window.testSpeech)).includes('learn'));
  await page.getByRole('button', { name: '回看完整讲解' }).click();
  await page.getByRole('heading', { name: '一句话读懂' }).waitFor();
  assert.equal(await page.locator('.examples .example').count(), 3);
  await page.getByRole('button', { name: '放大查看截图', exact: true }).waitFor();
  const firstImage = await page.locator('.image-thumbnail img').getAttribute('src');
  await page.getByRole('button', { name: '放大查看截图', exact: true }).click();
  await page.getByRole('dialog', { name: '查询截图' }).waitFor();
  assert.notEqual(await page.getByAltText('查询时保存的完整截图').getAttribute('src'), firstImage, 'zoom refreshes a short-lived signed URL instead of reusing the thumbnail URL');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  holdNextImage = true;
  await page.getByRole('button', { name: '放大查看截图', exact: true }).click();
  while (!releaseImage) await new Promise(resolve => setTimeout(resolve, 10));
  await page.getByRole('button', { name: '学习历史', exact: true }).click();
  await page.locator('.history-open').filter({ hasText: '毎日' }).click();
  await page.getByRole('button', { name: '放大查看截图', exact: true }).waitFor();
  assert.match(await page.locator('.image-thumbnail img').getAttribute('src'), /record-two/);
  assert.equal(await page.locator('.record-heading h1').getAttribute('lang'), 'ja', 'saved language identifies a Japanese term containing only Han characters');
  assert.equal(await page.locator('.lesson-point .term').getAttribute('lang'), 'ja');
  assert.match(await page.locator('.lesson-point .term').evaluate(element => getComputedStyle(element).fontFamily), /Zen Kaku Gothic New/);
  assert.equal(await page.locator('.lesson-point .term').evaluate(element => getComputedStyle(element).fontWeight), '500');
  assert.equal(await page.locator('.lesson-point .reading > span').getAttribute('lang'), 'ja');
  assert.equal(await page.locator('.explanation > p').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.locator('.source-card details > p').getAttribute('lang'), 'ja');
  releaseImage();
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('dialog').count(), 0, 'late image URL does not reopen a dialog after leaving its record');
  assert.match(await page.locator('.image-thumbnail img').getAttribute('src'), /record-two/);
  await page.getByRole('button', { name: '学习历史', exact: true }).click();
  await page.getByRole('heading', { name: '毎日', exact: true }).waitFor();
  await page.getByRole('searchbox').fill('learn');
  await page.waitForFunction(() => document.querySelectorAll('.history-row').length === 1);
  await page.getByRole('button', { name: '删除记录：learn' }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByRole('heading', { name: '还没找到这条记录' }).waitFor();
  await page.getByRole('button', { name: '清空搜索' }).click();
  await page.getByRole('heading', { name: '毎日', exact: true }).waitFor();
  assert.equal(await page.locator('.history-row').count(), 1);
  assert.ok(actions.some(item => item.action === 'records.delete' && item.params.revision === 1 && item.params.confirmed === true));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '开启通知', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '发送测试通知', exact: true }).isDisabled(), true);
  await page.getByText('先开启通知，再发送测试通知。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('讲解模式', { exact: true }).inputValue(), 'fast');
  assert.equal(actions.filter(item => item.action === 'settings.update' && item.params.explanation_mode).length, 0, 'loading settings never writes the displayed default mode');
  const fontSelect = page.getByLabel('字体组合', { exact: true });
  assert.equal(await page.getByRole('heading', { name: '字体方案', exact: true }).count(), 1);
  await page.waitForFunction(() => document.querySelector('#font-theme')?.disabled === false);
  assert.equal(await fontSelect.inputValue(), 'clean');
  assert.deepEqual(await fontSelect.locator('option').evaluateAll(options=>options.map(option=>option.value)), ['handwritten','bookish','clean','refined']);
  assert.equal(actions.filter(item => item.action === 'settings.update' && item.params.font_theme).length, 0, 'reading a default font never writes it to the account');
  const heldRead = new Promise(resolve => { settingsHeld = resolve; }); holdNextSettings = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await heldRead;
  const heldSave = new Promise(resolve => { fontSaveHeld = resolve; }); holdNextFontSave = true;
  const fontStart = actions.length;
  await fontSelect.selectOption('bookish'); await heldSave;
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fontTheme), 'bookish', 'font changes before the network save finishes');
  assert.equal(await fontSelect.isDisabled(), true);
  assert.equal(settings.font_theme, 'clean');
  releaseFontSave();
  await page.waitForFunction(() => document.querySelector('#font-theme')?.value === 'bookish' && !document.querySelector('#font-theme')?.disabled);
  assert.deepEqual(actions.slice(fontStart).map(item => item.action), ['settings.update', 'settings.get']);
  assert.deepEqual(actions[fontStart].params, { font_theme: 'bookish' });
  releaseSettings(); await page.waitForTimeout(50);
  assert.equal(await fontSelect.inputValue(), 'bookish', 'an older settings response cannot overwrite the new selection');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fontTheme), 'bookish');
  assert.match(await page.locator('.font-preview [lang="en"]').evaluate(element => getComputedStyle(element).fontFamily), /Literata/);
  await fontSelect.selectOption('clean');
  await page.waitForFunction(() => document.querySelector('#font-theme')?.value === 'clean' && !document.querySelector('#font-theme')?.disabled);
  assert.match(await page.getByRole('heading', { name: '设置', exact: true }).evaluate(element => getComputedStyle(element).fontFamily), /DM Sans/);
  assert.equal(await fontSelect.evaluate(element => getComputedStyle(element).fontSize), '16px');
  rejectNextFontSave = true;
  await fontSelect.selectOption('handwritten');
  await page.getByRole('alert').filter({ hasText: '字体方案未能保存' }).waitFor();
  assert.equal(await fontSelect.inputValue(), 'clean');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fontTheme), 'clean', 'failed save restores the last confirmed theme');
  settings.font_theme = 'bookish';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.documentElement.dataset.fontTheme === 'bookish');
  assert.equal(await fontSelect.inputValue(), 'bookish', 'focus reads the account preference saved from another client');
  await page.reload();
  await page.getByRole('button', { name: '开启通知', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.fontTheme === 'bookish' && document.querySelector('#font-theme')?.value === 'bookish');
  await fontSelect.selectOption('refined');
  await page.waitForFunction(() => document.querySelector('#font-theme')?.value === 'refined' && !document.querySelector('#font-theme')?.disabled);
  assert.match(await page.getByRole('heading', { name: '设置', exact: true }).evaluate(element => getComputedStyle(element).fontFamily), /Manrope/);
  assert.match(await page.locator('.font-preview [lang="en"]').evaluate(element => getComputedStyle(element).fontFamily), /Inter/);
  await page.reload();await page.getByRole('button', { name: '开启通知', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.fontTheme === 'refined' && document.querySelector('#font-theme')?.value === 'refined');
  const defaultReadStart = actions.length; delete settings.font_theme;
  await page.reload();await page.getByRole('button', { name: '开启通知', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.fontTheme === 'refined' && document.querySelector('#font-theme')?.disabled === false);
  assert.equal(actions.slice(defaultReadStart).some(item => item.action === 'settings.update' && item.params.font_theme), false, 'a missing preference uses refined without writing on load');
  settings.font_theme = 'refined';
  if (process.env.LINGO_FONT_SCREENSHOTS === '1') {
    const screenshotDirectory = path.resolve('.cache/refined-ui'); await mkdir(screenshotDirectory, { recursive: true });
    for (const theme of ['handwritten', 'bookish', 'clean', 'refined']) {
      await fontSelect.selectOption(theme);
      await page.waitForFunction(value => document.querySelector('#font-theme')?.value === value && !document.querySelector('#font-theme')?.disabled, theme);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 }); await page.evaluate(() => document.fonts.ready);
        await page.locator('.font-settings').evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${theme} at ${width}px stays within the PWA viewport`);
        await page.screenshot({ path: path.join(screenshotDirectory, `pwa-${theme}-${width}.png`) });
      }
    }
  }
  const modeStart = actions.length;
  await page.getByLabel('讲解模式', { exact: true }).selectOption('thinking');
  await page.waitForFunction(() => document.querySelector('#explanation-mode')?.value === 'thinking' && !document.querySelector('#explanation-mode')?.disabled);
  assert.deepEqual(actions.slice(modeStart).map(item => item.action), ['settings.update', 'settings.get']);
  assert.deepEqual(actions[modeStart].params, { explanation_mode: 'thinking' });
  await page.getByText('快速适合随手查询。思考通常更慢、用量更多，不保证更准确。', { exact: true }).waitFor();
  assert.equal(actions.some(item => item.action.startsWith('learning.')), false, 'changing mode does not run a phone AI query');
  await page.getByLabel('讲解模式', { exact: true }).selectOption('fast');
  await page.waitForFunction(() => document.querySelector('#explanation-mode')?.value === 'fast' && !document.querySelector('#explanation-mode')?.disabled);
  assert.equal(await page.getByRole('switch', { name: /邮件提醒/ }).count(), 0);
  assert.equal(await page.evaluate(() => window.permissionRequests), 0);
  const browserFailures = [['AbortError', '请检查网络'], ['NotAllowedError', '通知权限未获允许'], ['NotSupportedError', 'iOS 16.4'], ['InvalidStateError', '请刷新页面']];
  for (const [name, expected] of browserFailures) {
    await page.evaluate(errorName => { window.pushErrorName = errorName; }, name);
    await page.getByRole('button', { name: '开启通知', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: expected }).waitFor();
    assert.doesNotMatch(await page.getByRole('alert').textContent(), /private|endpoint|https:\/\/push/);
    assert.equal(actions.filter(item => item.action === 'push.subscribe').length, 0, 'browser subscription failure does not claim a server subscription');
    assert.equal(settings.push_enabled, false);
    assert.equal(await page.getByRole('button', { name: '发送测试通知', exact: true }).isDisabled(), true);
  }
  await page.evaluate(() => { window.pushErrorName = null; });
  const activationStart = actions.length;
  await page.getByRole('button', { name: '开启通知', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === '发送测试通知')?.disabled === false);
  assert.equal(await page.evaluate(() => window.permissionRequests), 1);
  assert.equal(actions.filter(item => item.action === 'push.subscribe').length, 1);
  assert.deepEqual(actions.slice(activationStart,activationStart+4).map(item => item.action), ['push.subscribe', 'settings.update', 'settings.get', 'push.status']);
  assert.deepEqual(actions[activationStart + 1].params, { push_enabled: true });
  assert.equal(settings.push_enabled, true);
  assert.equal(await page.getByRole('switch', { name: /邮件提醒/ }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole('button',{name:'发送测试通知',exact:true}).click();
  await page.getByText('推送服务已受理测试，请查看这台设备的锁屏或通知中心。').waitFor();
  assert.match(actions.find(item=>item.action==='push.test').params.fingerprint,/^[a-f0-9]{64}$/);
  serverSubscription = {...serverSubscription, endpoint:'https://push.example/newer-synthetic-device'};
  await page.waitForTimeout(510);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('通知连在另一台设备',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'发送测试通知',exact:true}).isDisabled(),true);
  settings.push_enabled = false;
  await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone Safari' }); Notification.permission = 'default'; });
  await page.getByRole('button', { name: '今日复习', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('先把 Lingo Notes 放到主屏幕', { exact: true }).waitFor();
  await page.waitForTimeout(510);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: '开启通知', exact: true }).click();
  assert.equal(await page.evaluate(() => window.permissionRequests), 1, 'iPhone browser tab must not request permission before installation');
  const existingNotice = await page.locator('.notice').textContent();
  staleSettings = true;
  await page.getByRole('button', { name: '今日复习', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(510);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#explanation-mode') !== null);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.notice').textContent(), existingNotice, 'SESSION_CHANGED does not replace the current account notice');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 Lingo Notes', exact: true }).waitFor();
  assert.ok(actions.some(item => item.action === 'push.unsubscribe' && item.params.endpoint === 'https://push.example/synthetic'), 'logout removes only the current device subscription');
  await page.getByLabel('邮箱', { exact: true }).fill('reader@example.test');
  await page.getByLabel('密码', { exact: true }).fill('synthetic-login-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).waitFor();
  const stops = (await page.evaluate(() => window.testSpeech)).filter(value => value === 'stop').length;
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('lingo-session:')) localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage')); });
  await page.getByRole('heading', { name: '登录 Lingo Notes', exact: true }).waitFor();
  assert.ok((await page.evaluate(() => window.testSpeech)).filter(value => value === 'stop').length > stops, 'external logout stops previous account audio');
  assert.equal(await page.locator('.app-main').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fontTheme), 'refined', 'external logout clears the old account font preference');
  const beforeSetupActions = actions.length;
  const setupToken = 'a'.repeat(64);
  await page.goto(`http://127.0.0.1:${server.address().port}/?batch=batch-one#token_hash=${setupToken}&token_type=recovery`);
  await page.getByRole('heading', { name: '设置登录密码', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '', 'one-time token is removed from the URL before UI use');
  assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), setupToken), false);
  assert.equal(actions.length, beforeSetupActions, 'setup credentials never grant access to the app before setting a password');
  await page.reload();
  await page.getByRole('heading', { name: '设置登录密码', exact: true }).waitFor();
  assert.equal(authCalls.filter(call => call.path.endsWith('/verify')).length, 1, 'reload resumes setup without storing or replaying token_hash');
  await page.getByLabel('新密码', { exact: true }).fill('synthetic-new-password');
  await page.getByLabel('再次输入新密码', { exact: true }).fill('synthetic-mismatch-password');
  await page.getByRole('button', { name: '保存密码并继续' }).click();
  await page.getByText('两次输入的密码不一致。', { exact: true }).waitFor();
  assert.equal(authCalls.filter(call => call.method === 'PUT').length, 0);
  await page.getByLabel('再次输入新密码', { exact: true }).fill('synthetic-new-password');
  await page.getByRole('button', { name: '保存密码并继续' }).click();
  await page.getByRole('heading', { name: '今日复习', exact: true }).waitFor();
  assert.equal(authCalls.filter(call => call.method === 'PUT' && call.path.endsWith('/user')).length, 1);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('synthetic-new-password'))), false);
  await page.goto(`http://127.0.0.1:${server.address().port}/#token_hash=${'e'.repeat(64)}&token_type=recovery`);
  await page.getByRole('heading', { name: '设置链接暂时无法使用', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByLabel('新密码', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('lingo-session:'))), false, 'invalid setup link does not fall through to an existing account');
  await page.evaluate(token => { window.location.hash = `token_hash=${token}&token_type=recovery`; }, 'b'.repeat(64));
  await page.getByRole('heading', { name: '设置登录密码', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '', 'same-document setup links are also consumed immediately');
  assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), 'b'.repeat(64)), false);
  assert.deepEqual(errors, []);
});
