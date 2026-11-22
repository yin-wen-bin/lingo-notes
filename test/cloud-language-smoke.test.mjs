import test from 'node:test';
import assert from 'node:assert/strict';
import {main,LANGUAGE_CASES,MAX_LANGUAGE_REQUESTS,parseLanguageOptions} from '../scripts/cloud-language-smoke.mjs';

test('language smoke is inert without explicit run and key; at most six planned requests',async()=>{
  let calls=0;const runner=async()=>{calls++;throw Error('must not run');},messages=[];
  assert.equal(await main(['--live-key-file','missing-secret-file'],{runner,log:value=>messages.push(JSON.parse(value))}),0);
  assert.equal(calls,0);assert.equal(messages[0].executed,false);assert.equal(messages[0].automatic_retries,0);
  await assert.rejects(main(['--run'],{runner}),/EXPLICIT_KEY_FILE_REQUIRED/);assert.equal(calls,0);
  assert.equal(LANGUAGE_CASES.length,MAX_LANGUAGE_REQUESTS);assert.equal(MAX_LANGUAGE_REQUESTS,6);
  assert.deepEqual([...new Set(LANGUAGE_CASES.map(item=>item.source+':'+item.target))].sort(),['en:en','en:ja','en:zh','ja:en','ja:ja','ja:zh']);
});

test('one-case smoke requires an explicit valid case and stays inert without run',async()=>{
  assert.equal(parseLanguageOptions(['--case','ja-ja']).caseId,'ja-ja');
  assert.throws(()=>parseLanguageOptions(['--case','wrong']),/INVALID_LANGUAGE_CASE/);
  assert.throws(()=>parseLanguageOptions(['--case','ja-ja','--case','en-en']),/INVALID_LANGUAGE_CASE/);
  assert.throws(()=>parseLanguageOptions(['--case']),/INVALID_LANGUAGE_CASE/);
  let called=false;const messages=[];
  assert.equal(await main(['--case','ja-ja'],{runner:async()=>{called=true;},log:value=>messages.push(JSON.parse(value))}),0);
  assert.equal(called,false);assert.equal(messages[0].max_model_requests,1);
});
