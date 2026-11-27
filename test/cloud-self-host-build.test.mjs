import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOptions} from '../scripts/build.mjs';
import {HOSTED_PWA_ORIGIN,PROJECT_REF,selfHostPublicConfig} from '../scripts/cloud-config.mjs';

const projectRef='fixtureselfhost00000';
const fixture={
  url:`https://${projectRef}.supabase.co`,
  pwaUrl:'https://lingo-synthetic.pages.dev',
  publishableKey:'sb_publishable_fixture',
  vapidPublicKey:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')
};

test('self-host build requires an explicit configuration and independent identity input',()=>{
  const required=['--profile','self-host','--config','instance.public.json','--extension-key','instance-public.txt'];
  assert.deepEqual(buildOptions(required),{
    profile:'self-host',allowUnconfigured:false,configFile:'instance.public.json',extensionKey:'instance-public.txt'
  });
  assert.throws(()=>buildOptions(['--profile','self-host','--config','instance.public.json']),/SELF_HOST_CONFIG_AND_EXTENSION_KEY_REQUIRED/);
  assert.throws(()=>buildOptions([...required,'--allow-unconfigured']),/SELF_HOST_CONFIG_AND_EXTENSION_KEY_REQUIRED/);
  assert.throws(()=>buildOptions(['--profile','store','--config','instance.public.json']),/SELF_HOST_PROFILE_REQUIRED/);
  assert.throws(()=>buildOptions(['--out','artifacts']),/SELF_HOST_PROFILE_REQUIRED/);
});

test('self-host public configuration binds clean origins without inheriting the hosted project or support contact',()=>{
  const config=selfHostPublicConfig({...fixture,url:fixture.url+'/',pwaUrl:fixture.pwaUrl+'/'});
  assert.equal(config.projectRef,projectRef);
  assert.equal(config.url,fixture.url);
  assert.equal(config.pwaUrl,fixture.pwaUrl);
  assert.equal(config.supportEmail,undefined);
  for(const patch of [
    {url:`https://${PROJECT_REF}.supabase.co`},
    {pwaUrl:HOSTED_PWA_ORIGIN},
    {url:fixture.url+'/rest/v1'},
    {url:fixture.url+':443'},
    {pwaUrl:fixture.pwaUrl+'?test=1'},
    {pwaUrl:'https://fixture.other.example'},
    {supportEmail:'support@example.test"><div>'}
  ])assert.throws(()=>selfHostPublicConfig({...fixture,...patch}),/SELF_HOST/);
});

test('self-host public configuration rejects server keys and credentials for a different project',()=>{
  const legacyKey=(role,ref)=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role,ref})).toString('base64url')+'.fixture';
  assert.equal(selfHostPublicConfig({...fixture,publishableKey:legacyKey('anon',projectRef)}).projectRef,projectRef);
  for(const key of ['sb_secret_fixture','sk-fixture',legacyKey('service_role',projectRef),legacyKey('anon',PROJECT_REF)])
    assert.throws(()=>selfHostPublicConfig({...fixture,publishableKey:key}),/INVALID_SELF_HOST_PUBLISHABLE_KEY/);
  assert.throws(()=>selfHostPublicConfig({...fixture,vapidPublicKey:'not-a-public-key'}),/INVALID_SELF_HOST_VAPID_PUBLIC_KEY/);
  assert.throws(()=>selfHostPublicConfig({...fixture,serviceRoleKey:'synthetic-fixture'}),/INVALID_SELF_HOST_PUBLIC_CONFIG/);
});
