import test from 'node:test';
import assert from 'node:assert/strict';
import {main,runQuality,QUALITY_CASES,MAX_MODEL_REQUESTS,safeDiagnostics,qualityChecks} from '../scripts/cloud-quality.mjs';

test('quality runner is inert without --run and requires an explicit paid key file',async()=>{
  let called=false;const messages=[];
  const runner=async()=>{called=true;throw Error('MUST_NOT_RUN');};
  assert.equal(await main(['--live-key-file','missing-file'],{log:text=>messages.push(JSON.parse(text)),runner}),0);
  assert.equal(called,false);assert.equal(messages[0].executed,false);
  await assert.rejects(main(['--run'],{runner}),/EXPLICIT_KEY_FILE_REQUIRED/);
  await assert.rejects(runQuality({run:false}),/RUN_FLAG_REQUIRED/);
});

test('quality matrix covers 10 words and 10 sentences, English/Japanese equally, including kanji-only words',()=>{
  assert.equal(QUALITY_CASES.length,20);assert.equal(new Set(QUALITY_CASES.map(sample=>sample.id)).size,20);
  for(const kind of ['word','sentence'])for(const language of ['en','ja'])assert.equal(QUALITY_CASES.filter(sample=>sample.kind===kind&&sample.language===language).length,5);
  const kanji=QUALITY_CASES.filter(sample=>sample.pure_kanji);assert.ok(kanji.length>=1);
  for(const sample of kanji){assert.match(sample.text,/^\p{Script=Han}+$/u);assert.ok(sample.context);}
  assert.equal(MAX_MODEL_REQUESTS,22);
});

test('safe diagnostics retain constant reason/counts but never model field values',()=>{
  assert.deepEqual(safeDiagnostics({reason:'POINT_COUNT',counts:{point_count:5,secret:'private',example_index:-1},text:'secret'}),{reason:'POINT_COUNT',counts:{point_count:5}});
  assert.equal(safeDiagnostics({reason:'private secret',counts:{point_count:5}}),null);
});

test('automated quality checks detect repeated examples, wrong language and absent reading format',()=>{
  const example={text:'We learn.',translation:'我们学习。'};
  const record={result:{language:'en',summary_zh:'说明',vocabulary:[{term:'learn',pos:'verb',reading:'learn',meaning:'学习',examples:[example,example,example]}],grammar:[]}};
  assert.deepEqual(qualityChecks(record,{language:'en'}).issues,['DUPLICATE_EXAMPLES','IPA_FORMAT_MISSING']);
  assert.deepEqual(qualityChecks(record,{language:'ja'}).issues,['LANGUAGE_MISMATCH','DUPLICATE_EXAMPLES','JAPANESE_READING_MISSING']);
});
