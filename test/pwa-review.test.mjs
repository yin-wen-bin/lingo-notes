import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';

const apiOrigin = 'https://pwa-review.example';
const examples = [{ text: 'We learn every day.', translation: '我们每天都学习。' }];
const session = user => ({ access_token: user, refresh_token: `synthetic-${user}`, expires_at: Date.now() / 1000 + 3600, user: { id: user, email: `${user}@example.test` } });
const makeCards = () => Array.from({ length: 7 }, (_, index) => ({
  id: `card-${index + 1}`, record_id: index < 2 ? 'record-one' : `record-${index + 1}`, slot: index === 1 ? 1 : 0,
  kind: index === 1 ? 'grammar' : 'vocabulary', point_key: `point-${index + 1}`, term: index === 0 ? 'learn' : index === 1 ? '描述习惯' : `word ${index + 1}`,
  reading: index === 0 ? '/lɜːn/' : '', pos: index === 1 ? '' : '动词', language: 'en', explanation_language: 'zh', term_language: index === 1 ? 'zh' : 'en',
  meaning: index === 1 ? '描述经常发生的事情。' : '学习；学会', example: examples[0], local_date: '2026-11-20',
  mastered: false, mastered_at: null, review_round: 0, scheduled_round: 1, reviewed: false, completed: false, next_due_date: '2026-11-21'
}));

test('PWA review controls persist counts, complete explicitly, exclude mastered points and reject stale sessions', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lingo-pwa-review-'));
  let browser, server;
  t.after(async () => {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('lingo-pwa-review-'));
    await rm(directory, { recursive: true, force: true });
  });
  const previous = process.env.VITE_SUPABASE_URL;
  process.env.VITE_SUPABASE_URL = apiOrigin;
  try {
    await build({ configFile: 'pwa/vite.config.ts', logLevel: 'silent', build: { outDir: directory, emptyOutDir: true }, define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(apiOrigin), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('synthetic-public-key')
    } });
  } finally { if (previous === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${directory}${path.sep}`)) return response.writeHead(403).end();
    try { response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], unexpected = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], cancel() {}, resume() {}, speak() {} } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => ({}) } });
  }, { key: `lingo-session:${apiOrigin}`, value: session('reader-a') });
  const accounts = new Map(['reader-a', 'reader-b'].map(user => [user, { cards: makeCards(), settings: { review_enabled: true, push_enabled: false, review_daily_limit: 5, explanation_mode: 'thinking', explanation_language: 'ja', font_theme: 'clean' } }]));
  let nextError = null, hold = null, nextReadback = null, pointOverrides = {};
  function holdNext(action) {
    let release, arrived;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    hold = { action, arrived, gate }; return { waiting, release };
  }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.origin !== apiOrigin) { unexpected.push(url.origin); return route.abort(); }
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
    const body = request.postDataJSON(), user = request.headers().authorization?.replace('Bearer ', '') || 'reader-a';
    const account = accounts.get(user); assert.ok(account, 'only isolated synthetic accounts are used');
    calls.push({ ...body, user });
    if (hold?.action === body.action) { const current = hold; hold = null; current.arrived(); await current.gate; }
    if (nextError?.action === body.action) { const error = nextError.code; nextError = null; return route.fulfill({ status: 400, headers, body: JSON.stringify({ ok: false, error }) }); }
    let result;
    switch (body.action) {
      case 'settings.get': result = { ...account.settings }; if (nextReadback !== null) { result.review_daily_limit = nextReadback; nextReadback = null; } break;
      case 'settings.update': Object.assign(account.settings, body.params); result = { ...account.settings }; break;
      case 'key.status': result = { configured: false }; break;
      case 'review.today': case 'review.get': result = { batch: { id: 'batch-one', local_date: '2026-11-21', cards: account.cards.filter(card => !card.mastered) } }; break;
      case 'review.opened': result = { opened: true }; break;
      case 'review.cards': result = { cards: account.cards.filter(card => card.record_id === body.params.record_id).map(card => ({ ...card, ...pointOverrides[card.id] })) }; break;
      case 'records.get': result = { record_id: 'record-one', revision: 1, local_date: '2026-11-20', original_text: 'learn', status: 'completed', result: { language: 'en', explanation_language: 'zh', summary_zh: '描述日常学习的习惯。', vocabulary: [{ term: 'learn', reading: '/lɜːn/', pos: '动词', meaning: '学习；学会', examples }], grammar: [{ point: '描述习惯', explanation: '描述经常发生的事情。', examples }] } }; break;
      case 'review.mastery': case 'review.complete': {
        const card = account.cards.find(item => item.id === body.params.card_id); assert.equal(body.params.point_key, card.point_key);
        if (body.action === 'review.mastery') { card.mastered = body.params.mastered; card.mastered_at = card.mastered ? '2026-11-21T00:01:00Z' : null; }
        else { assert.equal(body.params.batch_id, 'batch-one'); if (!card.reviewed) card.review_round++; card.reviewed = true; card.next_due_date = '2026-11-23'; }
        result = { card: { ...card }, ...(body.action === 'review.complete' ? { reviewed: true } : {}) }; break;
      }
      default: throw new Error(`UNEXPECTED_ACTION:${body.action}`);
    }
    await route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, result }) });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const card = term => page.locator('.review-card').filter({ has: page.getByRole('heading', { name: term, exact: true }) });
  const gotoSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByLabel('每天最多复习').waitFor(); };
  const gotoToday = async () => { await page.getByRole('button', { name: '今日复习', exact: true }).click(); await page.getByRole('button', { name: '刷新复习' }).waitFor(); };
  await page.goto(`${origin}/?batch=batch-one`);
  await expect(page.locator('.review-card')).toHaveCount(7);
  assert.equal(calls.filter(call => call.action === 'review.complete').length, 0, 'reading/opened audit must not advance progress');
  assert.ok(calls.some(call => call.action === 'review.opened'));

  nextError = { action: 'review.mastery', code: 'CARD_CHANGED' };
  await card('word 3').getByRole('button', { name: '标记已记住：word 3', exact: true }).click();
  await expect(page.locator('.notice.error')).toContainText('学习内容已更新，请刷新后重试。');
  await expect(page.locator('.review-card')).toHaveCount(7);
  await page.locator('.notice').getByRole('button').click();
  const completing = holdNext('review.complete');
  await card('learn').getByRole('button', { name: '已复习', exact: true }).click(); await completing.waiting;
  await expect(card('learn').getByRole('button', { name: '已复习', exact: true })).toBeDisabled();
  assert.equal(accounts.get('reader-a').cards[0].review_round, 0);
  completing.release();
  await expect(card('learn').getByRole('button', { name: '本轮已复习', exact: true })).toBeDisabled();
  await expect(card('learn')).toContainText('下次 2026-11-23');
  await card('learn').getByRole('button', { name: '本轮已复习', exact: true }).evaluate(button => button.click());
  assert.equal(calls.filter(call => call.action === 'review.complete').length, 1);

  const mastering = holdNext('review.mastery');
  await card('learn').getByRole('button', { name: '标记已记住：learn', exact: true }).click(); await mastering.waiting;
  await expect(page.locator('.review-card')).toHaveCount(7);
  mastering.release(); await expect(page.locator('.review-card')).toHaveCount(6);
  await expect(page.locator('.review-undo')).toContainText('不再安排这个学习点');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.review-card')).toHaveCount(7);
  await expect(card('learn').getByRole('button', { name: '本轮已复习', exact: true })).toBeDisabled();
  await card('描述习惯').getByRole('button', { name: '标记已记住：描述习惯', exact: true }).click();
  await expect(page.locator('.review-card')).toHaveCount(6);
  await card('learn').getByRole('button', { name: '回看完整讲解', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销已记住：描述习惯', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销已记住：描述习惯', exact: true }).click();
  await expect(page.getByRole('button', { name: '标记已记住：描述习惯', exact: true })).toBeVisible();
  // A re-explanation may change only POS or explanation language while keeping the slot and wording.
  // Never attach the replacement point's mutation controls to the previously fetched lesson.
  async function reloadNotePoints() {
    await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(7);
    const response = page.waitForResponse(item => item.url().startsWith(apiOrigin) && item.request().postDataJSON()?.action === 'review.cards');
    await card('learn').getByRole('button', { name: '回看完整讲解', exact: true }).click();
    await response; await expect(page.getByText('正在读取复习状态…', { exact: true })).toHaveCount(0);
  }
  pointOverrides = { 'card-1': { pos: '名词' } };
  await reloadNotePoints();
  await expect(page.getByRole('button', { name: '标记已记住：描述习惯', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '标记已记住：learn', exact: true })).toHaveCount(0);
  pointOverrides = { 'card-1': { explanation_language: 'ja' }, 'card-2': { explanation_language: 'ja' } };
  await reloadNotePoints();
  await expect(page.locator('.point-review-controls')).toHaveCount(0);
  pointOverrides = {};
  await reloadNotePoints();
  await page.getByRole('button', { name: '标记已记住：learn', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销已记住：learn', exact: true })).toBeVisible();
  await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(6);
  accounts.get('reader-a').cards[3].mastered = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.review-card')).toHaveCount(5);
  assert.equal(calls.filter(call => call.action === 'review.complete').length, 1, 'foreground refresh is read-only');

  await gotoSettings();
  await expect(page.getByLabel('每天最多复习')).toHaveValue('5');
  const invalidStart = calls.filter(call => call.action === 'settings.update').length;
  for (const value of ['', '0', '101', '2.5']) {
    await page.getByLabel('每天最多复习').fill(value);
    await page.getByRole('button', { name: '保存数量', exact: true }).click();
    await expect(page.locator('#review-limit-status')).toContainText('1–100');
  }
  assert.equal(calls.filter(call => call.action === 'settings.update').length, invalidStart);
  const saveStart = calls.length;
  await page.getByLabel('每天最多复习').fill('9');
  await page.getByRole('button', { name: '保存数量', exact: true }).click();
  await expect(page.locator('#review-limit-status')).toContainText('已保存：每天最多 9 张');
  assert.deepEqual(calls.slice(saveStart).map(call => call.action), ['settings.update', 'settings.get']);
  assert.deepEqual(calls[saveStart].params, { review_daily_limit: 9 });
  assert.equal(accounts.get('reader-a').settings.explanation_mode, 'thinking');
  assert.equal(accounts.get('reader-a').settings.explanation_language, 'ja');
  nextError = { action: 'settings.update', code: 'NETWORK_ERROR' };
  await page.getByLabel('每天最多复习').fill('10'); await page.getByRole('button', { name: '保存数量', exact: true }).click();
  await expect(page.locator('#review-limit-status')).toHaveAttribute('role', 'alert');
  assert.doesNotMatch(await page.locator('#review-limit-status').textContent(), /已保存/);
  assert.equal(accounts.get('reader-a').settings.review_daily_limit, 9);
  nextReadback = 9;
  await page.getByLabel('每天最多复习').fill('11'); await page.getByRole('button', { name: '保存数量', exact: true }).click();
  await expect(page.locator('#review-limit-status')).toContainText('尚未确认每日数量已保存');
  await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(5);
  await gotoSettings(); await expect(page.getByLabel('每天最多复习')).toHaveValue('11');

  // A save finishing after another tab changes account must not update that account's UI.
  const saving = holdNext('settings.update');
  await page.getByLabel('每天最多复习').fill('12'); await page.getByRole('button', { name: '保存数量', exact: true }).click(); await saving.waiting;
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key: `lingo-session:${apiOrigin}`, value: session('reader-b') });
  await expect(page.getByLabel('每天最多复习')).toHaveValue('5');
  saving.release();
  await expect(page.locator('#review-limit-status')).toHaveText('');
  assert.equal(accounts.get('reader-b').settings.review_daily_limit, 5);

  await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(7);
  const oldMutation = holdNext('review.mastery');
  await card('word 7').getByRole('button', { name: '标记已记住：word 7', exact: true }).click(); await oldMutation.waiting;
  await gotoSettings(); oldMutation.release();
  await expect(page.getByLabel('每天最多复习')).toHaveValue('5');
  assert.equal(await page.locator('.review-undo').count(), 0);
  await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(6);

  const otherAccountMutation = holdNext('review.mastery');
  await card('word 6').getByRole('button', { name: '标记已记住：word 6', exact: true }).click(); await otherAccountMutation.waiting;
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key: `lingo-session:${apiOrigin}`, value: session('reader-a') });
  await expect(page.locator('.review-card')).toHaveCount(5);
  otherAccountMutation.release();
  await expect(card('word 6')).toBeVisible();
  assert.equal(await page.locator('.review-undo').count(), 0);
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); }, { key: `lingo-session:${apiOrigin}`, value: session('reader-b') });
  await expect(page.locator('.review-card')).toHaveCount(5);

  if (process.env.LINGO_PWA_REVIEW_SCREENSHOT === '1') await mkdir('.cache/review-controls', { recursive: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await gotoToday(); await expect(page.locator('.review-card')).toHaveCount(5);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `review width ${width}`);
    if (process.env.LINGO_PWA_REVIEW_SCREENSHOT === '1') await page.screenshot({ path: `.cache/review-controls/pwa-review-${width}.png`, fullPage: true });
    await card('learn').getByRole('button', { name: '回看完整讲解', exact: true }).click();
    await page.getByRole('button', { name: '标记已记住：描述习惯', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `note width ${width}`);
    if (process.env.LINGO_PWA_REVIEW_SCREENSHOT === '1') await page.screenshot({ path: `.cache/review-controls/pwa-note-${width}.png`, fullPage: true });
    await gotoSettings();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `settings width ${width}`);
    if (process.env.LINGO_PWA_REVIEW_SCREENSHOT === '1') await page.screenshot({ path: `.cache/review-controls/pwa-settings-${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
