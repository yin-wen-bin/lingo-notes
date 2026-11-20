import test from 'node:test';
import assert from 'node:assert/strict';
import {main,runCompare,usageOnly} from '../scripts/cloud-thinking-compare.mjs';

test('thinking comparison is opt-in, with a separate explicit key file',async()=>{
  let ran=false;const output=[];const runner=async()=>{ran=true;throw Error('MUST_NOT_RUN');};
  assert.equal(await main(['--live-key-file','missing-file'],{log:value=>output.push(JSON.parse(value)),runner}),0);
  assert.equal(ran,false);assert.equal(output[0].executed,false);assert.equal(output[0].production_changes,false);
  await assert.rejects(main(['--run'],{runner}),/EXPLICIT_KEY_FILE_REQUIRED/);
  await assert.rejects(runCompare({run:false}),/RUN_FLAG_REQUIRED/);
});

test('usage observation retains only numeric token counts, never reasoning or response text',()=>{
  const value=usageOnly({prompt_tokens:100,completion_tokens:200,total_tokens:300,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:36,completion_tokens_details:{reasoning_tokens:150,reasoning_content:'private thinking'},reasoning_content:'private thinking',text:'private content'});
  assert.deepEqual(value,{prompt_tokens:100,completion_tokens:200,total_tokens:300,prompt_cache_hit_tokens:64,prompt_cache_miss_tokens:36,reasoning_tokens:150});
  assert.equal(JSON.stringify(value).includes('private'),false);
  assert.equal(usageOnly({prompt_tokens:'secret',completion_tokens:-1}),null);
});
