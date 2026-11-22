import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';

test('both reading scales preserve three font themes and add refined default headings, body and buttons', { timeout: 90000 }, async t => {
  const typography = path.resolve('shared/typography');
  const styles = {
    '/extension.css': await readFile('extension/panel.css'),
    '/web.css': await readFile('pwa/src/styles.css'),
  };
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push(pathname);
    if (pathname === '/extension' || pathname === '/web') {
      const css = pathname === '/extension' ? '/extension.css' : '/web.css';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/typography/typography.css"><link rel="stylesheet" href="${css}"></head><body>
        <p id="ui-en" class="ui-text" lang="en">Lingo Notes</p>
        <p id="ui-zh" class="ui-text" lang="zh-CN">学习笔记</p>
        <p id="ui-ja" class="ui-text" lang="ja">設定 Lingo Notes</p>
        <p id="learn-en" class="learning-text" lang="en">serendipity</p>
        <p id="learn-zh" class="learning-text" lang="zh-CN">读书与学习</p>
        <p id="learn-ja" class="learning-text" lang="ja">図書館</p>
        <h2 id="heading-en" class="ui-text" lang="en">Study Notes</h2>
        <h2 id="heading-zh" class="ui-text" lang="zh-CN">学习笔记</h2>
        <h2 id="heading-ja" class="ui-text" lang="ja" data-ui-bound>設定 Lingo Notes</h2>
        <section id="lesson"><div class="point"><h3 class="ui-text"><span id="term-en" class="term-text learning-title learning-text" lang="en">serendipity</span></h3><h3 class="ui-text"><span id="term-zh" class="term-text learning-title learning-text" lang="zh-CN">读书</span></h3><h3 class="ui-text"><span id="term-ja" class="term-text learning-title learning-text" lang="ja">図書館</span></h3></div></section>
        <p id="ipa" class="reading-ipa" lang="en">/lɜːn/</p>
        <p><button id="action-en" class="primary" lang="en">Confirm</button></p>
        <p><button id="action" class="primary" lang="zh-CN">确认重新讲解</button></p>
        <p><button id="action-ja" class="primary ui-text" lang="ja" data-ui-bound>確認 Confirm</button></p>
      </body></html>`);
      return;
    }
    if (styles[pathname]) {
      response.writeHead(200, { 'Content-Type': 'text/css' }).end(styles[pathname]);
      return;
    }
    const file = path.resolve(typography, '.' + pathname.slice('/typography'.length));
    if (!pathname.startsWith('/typography/') || !file.startsWith(typography + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'font/woff2' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [surface, size] of [['extension', '16px'], ['web', '18px']]) {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
    const unexpectedRequests = [];
    page.on('request', request => {
      if (!request.url().startsWith(origin)) unexpectedRequests.push(request.url());
    });
    await page.goto(origin + '/' + surface);
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    for (const [theme, families, titleFamilies, headingWeights, termWeights] of [
      ['default', ['Inter', 'Noto Sans SC', 'Noto Sans JP'], ['Manrope', 'Noto Sans SC', 'Noto Sans JP'], [600,600,600], [600,600,600]],
      ['handwritten', ['Lora', 'LXGW WenKai Screen', 'Klee One'], ['Lora', 'LXGW WenKai Screen', 'Klee One'], [400,400,600], [500,400,600]],
      ['bookish', ['Literata', 'Noto Serif SC', 'Noto Serif JP'], ['Literata', 'Noto Serif SC', 'Noto Serif JP'], [600,600,600], [600,600,600]],
      ['clean', ['DM Sans', 'Noto Sans SC', 'Zen Kaku Gothic New'], ['DM Sans', 'Noto Sans SC', 'Zen Kaku Gothic New'], [600,600,500], [600,600,500]],
      ['refined', ['Inter', 'Noto Sans SC', 'Noto Sans JP'], ['Manrope', 'Noto Sans SC', 'Noto Sans JP'], [600,600,600], [600,600,600]],
    ]) {
      await page.evaluate(value => { if(value==='default')delete document.documentElement.dataset.fontTheme;else document.documentElement.dataset.fontTheme = value; }, theme);
      await page.locator('#learn-ja').boundingBox();
      await page.evaluate(() => document.fonts.ready);
      const refined = theme === 'refined' || theme === 'default';
      const bodyWeight = refined ? 500 : 400, buttonWeight = theme === 'handwritten' ? 400 : 500;
      for (const [id, family] of [
        ['ui-en', families[0]], ['ui-zh', families[1]], ['ui-ja', families[2]],
        ['learn-en', families[0]], ['learn-zh', families[1]], ['learn-ja', families[2]],
      ]) {
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + id });
        const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
        assert.ok(fonts.some(font => font.isCustomFont && font.familyName.includes(family)), `${surface}/${theme}/${id}: ${JSON.stringify(fonts)}`);
        assert.equal(await page.locator('#' + id).evaluate(node => getComputedStyle(node).fontSize), size);
        assert.equal(await page.locator('#' + id).evaluate(node => getComputedStyle(node).fontWeight), String(bodyWeight));
      }
      for (const [index, language] of ['en','zh','ja'].entries()) {
        for (const [id, weight] of [['heading-'+language,headingWeights[index]],['term-'+language,termWeights[index]],[language==='zh'?'action':'action-'+language,buttonWeight]]) {
          const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#' + id });
          const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
          assert.ok(fonts.some(font => font.isCustomFont && font.familyName.includes(titleFamilies[index])), `${surface}/${theme}/${id}: ${JSON.stringify(fonts)}`);
          if(language==='ja'&&id!=='term-ja')assert.ok(fonts.some(font=>font.isCustomFont&&font.familyName.includes(titleFamilies[0])),`${surface}/${theme}/${id}: Japanese UI Latin headings/buttons use ${titleFamilies[0]}`);
          const style=await page.locator('#'+id).evaluate(node=>({weight:getComputedStyle(node).fontWeight,synthesis:getComputedStyle(node).fontSynthesis}));
          assert.equal(style.weight,String(weight),`${surface}/${theme}/${id} weight`);assert.equal(style.synthesis,'none');
        }
      }
      await page.evaluate(()=>{document.documentElement.dataset.uiLanguage='ja';});
      for(const id of ['heading-ja','action-ja']){
        const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:'#'+id});const {fonts}=await session.send('CSS.getPlatformFontsForNode',{nodeId});
        assert.ok(fonts.some(font=>font.isCustomFont&&font.familyName.includes(titleFamilies[2])),`${surface}/${theme}/${id} in Japanese UI`);
      }
      await page.evaluate(()=>{delete document.documentElement.dataset.uiLanguage;});
    }
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#ipa' });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    assert.ok(fonts.every(font => !/LastResort/i.test(font.familyName)), 'IPA uses real glyphs');
    assert.deepEqual(unexpectedRequests, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.route('**/*.woff2', route => route.abort());
    await page.reload();
    assert.equal(await page.locator('#action').isVisible(), true);
    assert.equal(await page.locator('#learn-ja').textContent(), '図書館');
    await page.close();
  }
  assert.ok(requests.some(pathname => pathname.endsWith('.woff2')));
});
