import test from 'node:test';
import assert from 'node:assert/strict';
import {main,parseOptions,runSmoke,safeCode,syntheticPng,isPermissionDenial,safeModelEvidence} from '../scripts/cloud-smoke.mjs';
import {decodePng} from '../supabase/functions/_shared/core.mjs';

test('smoke defaults to explanation without running or reading a supplied key file',async()=>{
  const messages=[];let called=false;
  assert.equal(await main(['--live-key-file','does-not-exist'],{log:value=>messages.push(JSON.parse(value)),runner:async()=>{called=true;throw Error('MUST_NOT_RUN');}}),0);
  assert.equal(called,false);assert.equal(messages[0].executed,false);
  await assert.rejects(runSmoke({run:false}),/RUN_FLAG_REQUIRED/);
});
test('remote mode and paid mode require explicit separate flags',()=>{
  assert.deepEqual(parseOptions(['--run']),{run:true,liveKeyFile:null,help:false});
  assert.deepEqual(parseOptions(['--run','--live-key-file','synthetic-key-path']),{run:true,liveKeyFile:'synthetic-key-path',help:false});
  assert.throws(()=>parseOptions(['--live-key-file','--run']),/INVALID_KEY_FILE_ARGUMENT/);
  assert.throws(()=>parseOptions(['--owner-user','someone']),/UNKNOWN_ARGUMENT/);
});
test('reports suppress raw provider errors, secrets and long material',()=>{
  assert.equal(safeCode(Error('sk-secret-value-for-test')),'SMOKE_OPERATION_FAILED');
  assert.equal(safeCode(Error('SQL query containing personal text')),'SMOKE_OPERATION_FAILED');
  assert.equal(safeCode(Error('QA_VAULT_ROUNDTRIP_FAILED')),'QA_VAULT_ROUNDTRIP_FAILED');
});
test('network and server failures are never counted as successful permission denials',()=>{
  assert.equal(isPermissionDenial({error:{message:'fetch failed'}}),false);
  assert.equal(isPermissionDenial({error:{status:503}},'storage'),false);
  assert.equal(isPermissionDenial({error:{code:'42501'}}),true);
  assert.equal(isPermissionDenial({error:{status:403}},'storage'),true);
});
test('failed stream evidence retains observed timings while unknown completion and usage stay null',()=>{
  const evidence=safeModelEvidence({accepted_ms:300,first_readable_ms:1900,error_event_ms:3400,last_sse_event:'error',saved_status:'failed',key:'sk-secret',preview:{summary_zh:'must not be logged'}});
  assert.deepEqual(evidence,{accepted_ms:300,first_readable_ms:1900,complete_ms:null,error_event_ms:3400,last_sse_event:'error',saved_status:'failed',usage:null});
  assert.equal(JSON.stringify(evidence).includes('secret'),false);assert.equal(JSON.stringify(evidence).includes('must not be logged'),false);
});
test('OCR fixture is a small deterministic valid PNG created without reading external material',()=>{
  const png=syntheticPng();assert.deepEqual(png,syntheticPng());const decoded=decodePng('data:image/png;base64,'+png.toString('base64'));
  assert.equal(decoded.width,520);assert.equal(decoded.height,128);assert.ok(png.length<10000);
});
