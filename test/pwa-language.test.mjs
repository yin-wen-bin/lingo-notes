import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'vite';
import { chromium } from '@playwright/test';
import { explanationLang, reviewTerm, speechContent } from '../pwa/src/model.mjs';

test('review title language is independent from source examples and legacy cards keep their reading', () => {
  assert.equal(explanationLang(undefined), 'zh-CN');
  assert.equal(explanationLang('ja'), 'ja');
  const legacy = { term: '毎日', reading: 'まいにち', language: 'ja' };
  assert.deepEqual(reviewTerm(legacy), { language: 'ja', reading: 'まいにち' });
  assert.deepEqual(speechContent(legacy.term, reviewTerm(legacy).reading, reviewTerm(legacy).language), { lang: 'ja-JP', text: 'まいにち' });
  const grammar = { ...legacy, term: '描述习惯', term_language: 'zh' };
  assert.deepEqual(reviewTerm(grammar), { language: 'zh', reading: '' });
  assert.deepEqual(speechContent(grammar.term, grammar.reading, 'zh'), { lang: 'zh-CN', text: '描述习惯' });
  assert.deepEqual(speechContent('Describing habits', '/stale/', 'en'), { lang: 'en-US', text: 'Describing habits' });
});

test('PWA renders saved explanation languages, same-language glosses and mixed review speech without translation calls', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lingo-pwa-language-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('lingo-pwa-language-'));
    await rm(directory, { recursive: true, force: true });
  });
  const previous = process.env.VITE_SUPABASE_URL;
  process.env.VITE_SUPABASE_URL = 'https://pwa-language.example';
  try {
    await build({ configFile: 'pwa/vite.config.ts', logLevel: 'silent', build: { outDir: directory, emptyOutDir: true }, define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://pwa-language.example'), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('synthetic-publishable-key') } });
  } finally { if (previous === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous; }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${directory}${path.sep}`)) { response.writeHead(403).end(); return; }
    try { response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(); const errors = [], actions = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('lingo-session:https://pwa-language.example', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_at: Date.now() / 1000 + 3600, user: { id: 'synthetic-language-user', email: 'language@example.test' } }));
    window.spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [], cancel() {}, resume() {}, speak: value => window.spoken.push({ text: value.text, lang: value.lang }) } });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => ({}) } });
  });
  const localized = {
    zh: { summary: '描述每天学习的习惯。', meaning: '学习；学会', pos: '动词', point: '描述习惯', explanation: '用这个形式描述经常发生的事情。', translation: '每天都花时间学习。' },
    ja: { summary: '毎日の学習習慣を表します。', meaning: '知識や技能を身につける', pos: '動詞', point: '習慣を表す形', explanation: 'この形は繰り返す行動を表します。', translation: '日々、新しいことを身につけます。' },
    en: { summary: 'This describes a daily learning habit.', meaning: 'to gain knowledge or a skill', pos: 'verb', point: 'Describing habits', explanation: 'This form describes repeated actions.', translation: 'They spend time gaining knowledge each day.' },
  };
  const cases = [
    { id: 'legacy', source: 'en', target: undefined }, { id: 'english-japanese', source: 'en', target: 'ja' },
    { id: 'japanese-english', source: 'ja', target: 'en' }, { id: 'english-english', source: 'en', target: 'en' },
    { id: 'japanese-japanese', source: 'ja', target: 'ja' }, { id: 'japanese-chinese', source: 'ja', target: 'zh' },
  ];
  const record = sample => {
    const words = localized[sample.target || 'zh']; const japanese = sample.source === 'ja';
    const example = { text: japanese ? '毎日、勉強します。' : 'We learn every day.', translation: words.translation };
    return { record_id: sample.id, revision: 4, local_date: '2026-11-20', status: 'failed', explanation_language: 'ja', original_text: example.text, result: { language: sample.source, ...(sample.target ? { explanation_language: sample.target } : {}), summary_zh: words.summary, vocabulary: [{ term: japanese ? '勉強' : 'learn', reading: japanese ? 'べんきょう' : '/lɜːn/', pos: words.pos, meaning: words.meaning, examples: [example] }], grammar: [{ point: words.point, explanation: words.explanation, examples: [example] }] } };
  };
  const cards = [
    { id: 'legacy-card', record_id: 'legacy', language: 'ja', term: '毎日', reading: 'まいにち', meaning: '每天', example: { text: '毎日、勉強します。', translation: '每天学习。' } },
    { id: 'zh-grammar', record_id: 'japanese-chinese', language: 'ja', term_language: 'zh', explanation_language: 'zh', term: '描述习惯', reading: 'まいにち', meaning: localized.zh.explanation, example: { text: '毎日、勉強します。', translation: localized.zh.translation } },
    { id: 'ja-grammar', record_id: 'english-japanese', language: 'en', term_language: 'ja', explanation_language: 'ja', term: localized.ja.point, reading: '/stale/', meaning: localized.ja.explanation, example: { text: 'We learn every day.', translation: localized.ja.translation } },
    { id: 'en-grammar', record_id: 'japanese-english', language: 'ja', term_language: 'en', explanation_language: 'en', term: localized.en.point, reading: 'まいにち', meaning: localized.en.explanation, example: { text: '毎日、勉強します。', translation: localized.en.translation } },
  ].map(card => ({ ...card, local_date: '2026-11-19' }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname !== 'pwa-language.example') { unexpected.push(url.origin); return route.abort(); }
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
    const body = route.request().postDataJSON(); actions.push(body.action); let result;
    if (body.action === 'settings.get') result = { font_theme: 'clean', explanation_language: 'en', review_enabled: false, push_enabled: false };
    else if (body.action === 'records.get') result = record(cases.find(item => item.id === body.params.record_id));
    else if (body.action === 'review.cards') result = { cards: [] };
    else if (body.action === 'review.today') result = { batch: { id: 'mixed-review', local_date: '2026-11-20', cards } };
    else if (body.action === 'review.opened') result = {};
    else throw Error('UNEXPECTED_ACTION:' + body.action);
    await route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, result }) });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const sample of cases) {
    await page.goto(`${origin}/?record=${sample.id}`);
    await page.locator('.lesson-point').first().waitFor();
    const lang = explanationLang(sample.target), expected = localized[sample.target || 'zh'];
    const annotations = await page.locator('.explanation p, .lesson-point .meaning, .lesson-point .eyebrow .learning-text, .lesson-point .translation, .lesson-point > h2:not(.term), .lesson-point > .preserve-lines').evaluateAll(elements => elements.map(element => ({ lang: element.lang, font: getComputedStyle(element).fontFamily })));
    assert.equal(annotations.length, 7); assert.ok(annotations.every(value => value.lang === lang));
    if (lang === 'ja') assert.ok(annotations.every(value => value.font.includes('Zen Kaku Gothic New')));
    assert.equal(await page.locator('.explanation p').textContent(), expected.summary);
    assert.equal(await page.locator('.translation').first().textContent(), expected.translation);
    assert.equal(await page.locator('.example-original p').first().getAttribute('lang'), sample.source);
    assert.equal(await page.locator('.lesson-point .term').getAttribute('lang'), sample.source);
    assert.equal(await page.locator('.reading > span').getAttribute('lang'), sample.source);
    if (sample.source === sample.target) assert.notEqual(await page.locator('.translation').first().textContent(), await page.locator('.example-original p').first().textContent());
    await page.locator('.lesson-point .reading .sound-button').click();
    assert.deepEqual(await page.evaluate(() => window.spoken.at(-1)), sample.source === 'ja' ? { lang: 'ja-JP', text: 'べんきょう' } : { lang: 'en-US', text: 'learn' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.goto(origin);
  await page.locator('.review-card').nth(3).waitFor();
  for (const [index, card] of cards.entries()) {
    const item = page.locator('.review-card').nth(index); const term = reviewTerm(card);
    assert.equal(await item.locator('.meaning').getAttribute('lang'), explanationLang(card.explanation_language));
    assert.equal(await item.locator('.translation').getAttribute('lang'), explanationLang(card.explanation_language));
    assert.equal(await item.locator('.example-original p').getAttribute('lang'), card.language);
    await item.locator('.reading .sound-button').click();
    assert.deepEqual(await page.evaluate(() => window.spoken.at(-1)), speechContent(card.term, term.reading, term.language));
    await item.locator('.example-original .sound-button').click();
    assert.deepEqual(await page.evaluate(() => window.spoken.at(-1)), speechContent(card.example.text, '', card.language));
    if (index) assert.notEqual(await item.locator('.reading > span').textContent(), card.reading);
  }
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  assert.ok(actions.every(action => ['settings.get', 'records.get', 'review.cards', 'review.today', 'review.opened'].includes(action)));
  if (process.env.LINGO_PWA_LANGUAGE_SCREENSHOT === '1') {
    await mkdir('.cache/cloud3-pwa', { recursive: true });
    await page.screenshot({ path: '.cache/cloud3-pwa/mixed-review.png', fullPage: true });
  }
});
