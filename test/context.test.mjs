import test from 'node:test';
import assert from 'node:assert/strict';
import {sentenceContext,cropBounds} from '../extension/context.ts';
test('context selects the matching sentence and one neighbor in English and Japanese',()=>{
  assert.equal(sentenceContext('Heading\nWe study every day. Practice makes progress. Small steps matter.','Practice makes progress.').context,'We study every day. Practice makes progress. Small steps matter.');
  assert.equal(sentenceContext('First. Before. Learning is useful. After. Last.','Learning').context,'Before. Learning is useful. After.');
  assert.equal(sentenceContext('最初です。昨日です。日本語を勉強します。明日です。最後です。','勉強').context,'昨日です。日本語を勉強します。明日です。');
  assert.equal(sentenceContext('The cat sat. Another cat slept.','cat').status,'ambiguous');
  assert.equal(sentenceContext('The cat sat. Another cat slept.','cat',21).status,'matched');
  assert.equal(sentenceContext('concatenate','cat').status,'not_found');assert.equal(sentenceContext('ＡＢＣ is here.','ABC').status,'matched');
  assert.ok(sentenceContext('Start '+ 'long '.repeat(700)+'end.','end').context.length<=1500);
});
test('crop uses actual bitmap dimensions at fractional zoom and high DPI',()=>{
  assert.deepEqual(cropBounds({x:10,y:20,width:100,height:80},{width:800,height:600},{width:1600,height:1200}),{x:20,y:40,width:200,height:160});
  assert.deepEqual(cropBounds({x:10,y:20,width:100,height:80},{width:800,height:600},{width:1000,height:750}),{x:12,y:25,width:126,height:100});
  assert.throws(()=>cropBounds({x:790,y:20,width:100,height:80},{width:800,height:600},{width:1000,height:750}));
});
