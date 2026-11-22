import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {cachedUiLanguage,surfaceText} from '../extension/surface-i18n.ts';
import {WordSpeech} from '../extension/speech.ts';

test('browser surface language is scoped to the current account and falls back safely',()=>{
  assert.equal(cachedUiLanguage({owner:'one',language:'ja'},'one'),'ja');
  assert.equal(cachedUiLanguage({owner:'one',language:'ja'},'two'),'zh');
  assert.equal(cachedUiLanguage({owner:'one',language:'en'},null),'zh');
  assert.equal(cachedUiLanguage({owner:'one',language:'bad'},'one'),'zh');
  for(const language of ['zh','ja','en'])assert.ok(surfaceText(language,'contextTitle').includes('%s'));
  assert.match(surfaceText('en','captureHint'),/Drag/);
  assert.match(surfaceText('ja','captureHint'),/キャンセル/);
});

test('speech errors use current interface language while voice selection keeps source language',async()=>{
  let locale='en',utterance;const messages=[];
  const synth={getVoices:()=>[{lang:'en-US',name:'Synthetic English',localService:true}],cancel(){},resume(){},speak(value){utterance=value;}};
  const speech=new WordSpeech(synth,text=>({text}), (code,language)=>`${locale}:${code}:${language??''}`);
  await speech.toggle({},'練習','れんしゅう','ja',(state,message)=>messages.push({state,message}));
  assert.equal(messages.at(-1).message,'en:voiceMissing:ja-JP');
  locale='ja';await speech.toggle({},'practice','/ipa/','en',(state,message)=>messages.push({state,message}));
  assert.equal(utterance.text,'practice');assert.equal(utterance.lang,'en-US');
  utterance.onerror({error:'audio-busy'});assert.equal(messages.at(-1).message,'ja:playFailed:');
});

test('background rejects stale account preference messages and restores context menu language on session changes',async()=>{
  const sessionKey='lingo-session:https://synthetic.example';
  const stored={[sessionKey]:JSON.stringify({user:{id:'one'}}),'lingo-ui-language':{owner:'one',language:'en'}};
  let onMessage,onStorage;const titles=[];
  const event={addListener(){}};
  const chrome={
    runtime:{id:'synthetic-extension',getURL:path=>`chrome-extension://synthetic-extension/${path}`,onInstalled:event,onConnect:event,onMessage:{addListener(fn){onMessage=fn;}}},
    storage:{local:{async get(keys){return Object.fromEntries(keys.map(key=>[key,stored[key]]));},async set(value){Object.assign(stored,value);}},onChanged:{addListener(fn){onStorage=fn;}}},
    contextMenus:{update(_id,value,callback){titles.push(value.title);callback();},create(value,callback){titles.push(value.title);callback?.();},onClicked:event},
    tabs:{onActivated:event,onUpdated:event},action:{onClicked:event},
  };
  const bundle=await build({entryPoints:['extension/background.ts'],bundle:true,platform:'node',format:'cjs',write:false,define:{__SUPABASE_URL__:JSON.stringify('https://synthetic.example')}});
  vm.runInNewContext(bundle.outputFiles[0].text,{chrome,URL,setTimeout,clearTimeout,console});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();
  assert.match(titles.at(-1),/^Learn/);
  const send=(message,sender={id:chrome.runtime.id,url:chrome.runtime.getURL('panel.html')})=>new Promise(resolve=>onMessage(message,sender,resolve));
  await send({kind:'ui-language.changed',accountId:'one',language:'ja'});assert.match(titles.at(-1),/学ぶ/);
  stored[sessionKey]=JSON.stringify({user:{id:'two'}});onStorage({[sessionKey]:{newValue:stored[sessionKey]}},'local');await tick();assert.match(titles.at(-1),/^用/);
  await send({kind:'ui-language.changed',accountId:'one',language:'en'});assert.match(titles.at(-1),/^用/);
  await send({kind:'ui-language.changed',accountId:'two',language:'en'});assert.match(titles.at(-1),/^Learn/);
  const denied=await send({kind:'ui-language.changed',accountId:'two',language:'ja'},{id:'other',url:'https://untrusted.example'});assert.equal(denied.error,'UNTRUSTED_SENDER');assert.match(titles.at(-1),/^Learn/);
  delete stored[sessionKey];onStorage({[sessionKey]:{newValue:undefined}},'local');await tick();assert.match(titles.at(-1),/^用/);
});
