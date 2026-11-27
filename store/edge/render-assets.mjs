import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createSelectionBackground } from '../../test/helpers/selection-background.mjs';

const api = 'https://store-demo.invalid';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
const output = resolve(root, 'artifacts', `edge-${manifest.version}-screenshots`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const exercise = (language, term, reading, meaning, text, translation) => ({
  term, reading, pos: language === 'ja' ? '副词性表达' : '短语', meaning,
  examples: [{ text, translation, language }]
});
const english = {
  language: 'en', explanation_language: 'zh',
  summary_zh: 'make a difference 表示产生影响。这里强调小小的行动也能带来改变。',
  vocabulary: [exercise('en', 'make a difference', '/meɪk ə ˈdɪfərəns/', '产生影响，起作用', 'Small steps make a difference.', '小小的行动也能带来改变。')],
  grammar: []
};
const japanese = {
  language: 'ja', explanation_language: 'zh',
  summary_zh: '少しずつ表示一点一点地，常用来描述持续而缓慢的变化。',
  vocabulary: [exercise('ja', '少しずつ', 'すこしずつ', '一点一点地，逐渐地', '少しずつ上達します。', '一点点进步。')],
  grammar: [{
    point: '〜ています表示持续状态', explanation: '用动词て形加います描述正在进行的动作。',
    examples: [{ text: '毎日、練習しています。', translation: '我每天都在练习。', language: 'ja' }]
  }]
};
const records = [
  { record_id: 'synthetic-english', local_date: '2026-11-27', original_text: 'Small steps make a difference.', result: english },
  { record_id: 'synthetic-japanese', local_date: '2026-11-26', original_text: '毎日、少しずつ練習しています。', result: japanese }
].map(record => ({
  ...record, status: 'complete', input_type: 'text', explanation_language: 'zh', revision: 1, source: null, image: null
}));
const scenes = [
  { shot: '01-english-notes.png', title: 'Learn from the web', example: records[0].original_text, record: records[0], summary: 'Select a useful expression and read examples in the sidebar.' },
  { shot: '02-japanese-notes.png', title: 'Listen and learn', example: records[1].original_text, record: records[1], summary: 'Examples and pronunciation follow the original language.' },
  { shot: '03-history.png', title: 'Find what you learned', example: 'Your saved learning notes', summary: 'Search and reopen saved notes from History.' }
];
const bundle = await build({
  absWorkingDir: root, entryPoints: ['extension/panel.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'chrome116',
  define: {
    __SUPABASE_URL__: JSON.stringify(api),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify('synthetic-public')
  }
});
const [html, css] = await Promise.all(['panel.html', 'panel.css'].map(name => readFile(resolve(root, 'extension', name))));
const mime = new Map([
  ['html', 'text/html'], ['css', 'text/css'], ['js', 'text/javascript'],
  ['png', 'image/png'], ['svg', 'image/svg+xml'], ['woff2', 'font/woff2']
]);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    let bytes;
    if (path === '/panel.html') bytes = html;
    else if (path === '/panel.css') bytes = css;
    else if (path === '/panel.js') bytes = bundle.outputFiles[0].contents;
    else if (path.startsWith('/assets/')) {
      const isTypography = path.startsWith('/assets/typography/');
      const parent = resolve(root, isTypography ? 'shared/typography' : 'extension/assets');
      const prefix = isTypography ? '/assets/typography/' : '/assets/';
      const file = resolve(parent, decodeURIComponent(path.slice(prefix.length)));
      if (!file.startsWith(parent + sep)) return response.writeHead(403).end();
      bytes = await readFile(file);
    } else return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': mime.get(path.split('.').at(-1)), 'Cache-Control': 'no-store' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

function preview(scene, panel, logo) {
  return `<html lang="en"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#fbfdf6;color:#243b32;font-family:Segoe UI,sans-serif}
    main{width:650px;height:800px;padding:48px;display:flex;flex-direction:column;background:linear-gradient(145deg,#fbfdf6 60%,#e9f4db)}
    header{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:600}
    header img{width:64px;height:64px}h1{font-size:52px;line-height:1.18;margin:67px 0 30px}
    blockquote{margin:14px 0;border-left:4px solid #d6f494;padding-left:20px;font-size:30px;line-height:1.55}
    p{font-size:22px;line-height:1.5}footer{margin-top:auto;font-size:15px;line-height:1.65}
    .panel{position:absolute;right:0;top:0;width:630px;height:800px;border-left:1px solid #dce5d9}
    </style><main><header><img alt="" src="data:image/png;base64,${logo}">Lingo Notes</header>
    <h1>${scene.title}</h1><blockquote>${scene.example}</blockquote><p>${scene.summary}</p>
    <footer>Invite-only trial · Your own DeepSeek API key required<br>Synthetic demo · Actual extension interface</footer></main>
    <img class="panel" alt="Lingo Notes sidebar" src="data:image/png;base64,${panel.toString('base64')}"></html>`;
}

await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + server.address().port;
const report = { version: manifest.version, synthetic: true, images: [], actions: [], external_requests: 0 };
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const icon = resolve(root, 'extension/assets/icon-128.png');
  const logo = (await readFile(icon)).toString('base64');
  await mkdir(output, { recursive: true });
  await copyFile(icon, resolve(output, 'icon-128.png'));
  for (const scene of scenes) {
    const background = await createSelectionBackground({ origin: api });
    const context = await browser.newContext({ viewport: { width: 630, height: 800 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await background.changeAccount('synthetic-edge-store');
      await background.install(page);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin) return route.continue();
        if (url.origin !== api) {
          ++report.external_requests;
          return route.abort();
        }
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers, body: '' });
        const body = request.postDataJSON();
        report.actions.push(body.action);
        const result = {
          'ping': { protocol: 'cloud/6' },
          'settings.get': { explanation_language: 'zh', explanation_mode: 'fast', font_theme: 'refined', review_daily_limit: 5 },
          'key.status': { configured: true, last_four: 'DEMO' },
          'records.history': { items: records.map(record => ({ ...record, text: record.original_text })), has_more: false },
          'records.get': records.find(record => record.record_id === body.params?.record_id),
          'review.cards': { cards: [] }
        }[body.action];
        if (!result) return route.abort();
        await route.fulfill({ status: 200, headers, body: JSON.stringify({ ok: true, result }) });
      });
      await page.goto(origin + '/panel.html');
      await page.locator('#historyTab').click();
      await page.locator('.history-row').first().waitFor();
      if (scene.record) {
        await page.locator('.history-card').filter({ hasText: scene.record.original_text }).click();
        await page.locator('#lesson .point').first().waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      const panel = await page.screenshot({ animations: 'disabled' });
      const presentation = await context.newPage();
      await presentation.setViewportSize({ width: 1280, height: 800 });
      await presentation.setContent(preview(scene, panel, logo));
      await presentation.locator('.panel').evaluate(image => image.decode());
      const png = await presentation.screenshot({ path: resolve(output, scene.shot), animations: 'disabled' });
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 800);
      assert.equal(png[25], 2);
      report.images.push({ file: scene.shot, width: 1280, height: 800, sha256: sha256(png) });
    } finally {
      await context.close();
      background.close();
    }
  }
  assert.equal(report.external_requests, 0);
  assert.ok(report.actions.every(action => !action.startsWith('learning.')));
  await writeFile(resolve(output, 'render-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, output, actions: undefined }));
} finally {
  await browser?.close();
  const closed = new Promise(done => server.close(done));
  server.closeAllConnections();
  await closed;
}
