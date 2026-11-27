import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { build } from 'esbuild';

test('current-device push status and test only use the verified account subscription', async () => {
  const sends = [];
  const subscription = suffix => ({endpoint:'https://web.push.apple.com/' + suffix, keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}, expirationTime:null});
  const a = subscription('synthetic-a'), b = subscription('synthetic-b');
  const owners = new Map([['owner-a',a],['owner-b',b]]);
  const fingerprint = value => createHash('sha256').update(JSON.stringify([value.endpoint,value.keys.p256dh,value.keys.auth])).digest('hex');
  let providerError;
  const client = {
    auth:{async getUser(token){ return {data:{user:['owner-a','owner-b'].includes(token) ? {id:token} : null},error:null}; }},
    from(table) {
      let owner;
      const chain = {
        select() { return chain; },
        eq(field,value) { assert.equal(field,'user_id');owner=value;return chain; },
        async maybeSingle() {
          const entry = owners.get(owner);
          return {data:table === 'lingo_settings' ? {push_enabled:true} : entry ? {subscription:entry} : null,error:null};
        }
      };
      return chain;
    },
    async rpc(name,p) {
      assert.equal(name,'lingo_unsubscribe');
      assert.deepEqual(JSON.parse(JSON.stringify(p.p_subscription)),owners.get(p.p_user));
      owners.delete(p.p_user);
      return {data:{removed:true},error:null};
    },
  };
  const bundle = await build({entryPoints:['supabase/functions/app-api/index.ts'],bundle:true,format:'cjs',platform:'node',write:false,plugins:[{
    name:'fixture',setup(builder) {
      builder.onResolve({filter:/^npm:/}, ({path}) => ({path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'}, ({path}) => ({
        contents:path.includes('supabase') ? 'export const createClient=()=>globalThis.testClient;'
          : 'export default {sendNotification:(...args)=>globalThis.send(...args)};'
      }));
    }
  }]});
  const module = {exports:{}};
  const env = {SUPABASE_URL:'https://synthetic.test',SUPABASE_SERVICE_ROLE_KEY:'fixture',VAPID_PUBLIC_KEY:'fixture',VAPID_PRIVATE_KEY:'fixture',VAPID_SUBJECT:'fixture'};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,testClient:client,Request,Response,URL,TextEncoder,TextDecoder,crypto:webcrypto,
    Deno:{serve(){},env:{get:key=>env[key]}},
    send(sub,payload) { if (providerError) throw { statusCode:providerError }; sends.push([sub.endpoint,JSON.parse(payload)]); }
  });
  async function call(owner,action,params) {
    const response=await module.exports.handler(new Request('https://synthetic.test/app-api',{
      method:'POST',headers:{Authorization:'Bearer '+owner},body:JSON.stringify({action,params})
    }));
    return await response.json();
  }
  assert.deepEqual(await call('owner-a','push.status',{fingerprint:fingerprint(a)}),{ok:true,result:{device:'current'}});
  assert.deepEqual(await call('owner-a','push.status',{fingerprint:fingerprint(b)}),{ok:true,result:{device:'other'}});
  assert.deepEqual(await call('owner-a','push.test',{fingerprint:fingerprint(b)}),{ok:false,error:'PUSH_DEVICE_MISMATCH'});
  assert.deepEqual(await call('owner-a','push.unsubscribe',{endpoint:b.endpoint,fingerprint:fingerprint(b)}),{ok:false,error:'PUSH_DEVICE_MISMATCH'});
  assert.deepEqual(sends,[]);
  assert.deepEqual(await call('owner-a','push.test',{fingerprint:fingerprint(a)}),{ok:true,result:{accepted:true,delivered:false}});
  assert.deepEqual(sends,[[a.endpoint,{kind:'test',batch_id:null}]]);
  providerError=410;
  assert.deepEqual(await call('owner-a','push.test',{fingerprint:fingerprint(a)}),{ok:false,error:'PUSH_SUBSCRIPTION_EXPIRED'});
  assert.deepEqual(await call('owner-a','push.status',{}),{ok:true,result:{device:'missing'}});
  assert.deepEqual(await call('owner-b','push.status',{fingerprint:fingerprint(b)}),{ok:true,result:{device:'current'}});
});
