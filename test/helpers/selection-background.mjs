import vm from 'node:vm';
import {webcrypto,randomUUID} from 'node:crypto';
import {build} from 'esbuild';

export const queueKey='lingo-selection-queue-v1';
const clone=value=>value===undefined?undefined:structuredClone(value);
const event=()=>{const listeners=new Set();return {addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);},emit(...args){for(const fn of [...listeners])fn(...args);},clear(){listeners.clear();}};};
export async function eventually(read,predicate=Boolean,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,15));}throw Error('Timed out waiting for synthetic state');}

/** Real extension background bundle, with only Chrome platform and webpage reads emulated. */
export async function createSelectionBackground({origin,local={},session={}}={}){
  const bundle=await build({entryPoints:['extension/background.ts'],bundle:true,platform:'node',format:'cjs',write:false,define:{__SUPABASE_URL__:JSON.stringify(origin)}});
  const stores={local:clone(local),session:clone(session)},ports=new Map(),pages=new Set(),tabs=new Map(),contextGates=new Map(),timers=new Set(),logs=[],commands=[];
  let chrome,events,workerGeneration=0;
  const sessionKey='lingo-session:'+origin,panelUrl='chrome-extension://synthetic-selection/panel.html';
  const publishStorage=(changes,area)=>{events.storage.emit(clone(changes),area);for(const page of pages)if(!page.isClosed())void page.evaluate(({changes,area})=>window.__selectionStorageEvent?.(changes,area),{changes:clone(changes),area}).catch(()=>{});};
  const area=name=>({async get(keys){if(!keys)return clone(stores[name]);if(typeof keys==='object'&&!Array.isArray(keys))return Object.fromEntries(Object.entries(keys).map(([key,fallback])=>[key,clone(stores[name][key]??fallback)]));return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,clone(stores[name][key])]));},async set(values){const changes={};for(const [key,value] of Object.entries(values)){changes[key]={oldValue:clone(stores[name][key]),newValue:clone(value)};stores[name][key]=clone(value);}publishStorage(changes,name);},async remove(keys){const changes={};for(const key of Array.isArray(keys)?keys:[keys]){changes[key]={oldValue:clone(stores[name][key])};delete stores[name][key];}publishStorage(changes,name);}});
  function disconnect(id){const port=ports.get(id);if(port){ports.delete(id);port.onDisconnect.emit();}}
  function connect(id,page,name='learning-panel'){
    if(ports.has(id))return ports.get(id);
    const port={name,sender:{id:'synthetic-selection',url:panelUrl},onMessage:event(),onDisconnect:event(),postMessage(message){if(!page.isClosed())void page.evaluate(({id,message})=>window.__selectionPortEvent?.(id,message),{id,message:clone(message)}).catch(()=>{});},disconnect(){disconnect(id);}};
    ports.set(id,port);port.page=page;events.connect.emit(port);return port;
  }
  function boot(){
    ++workerGeneration;events={storage:event(),installed:event(),connect:event(),message:event(),clicked:event(),action:event()};
    chrome={runtime:{id:'synthetic-selection',getURL:file=>'chrome-extension://synthetic-selection/'+file,onInstalled:events.installed,onConnect:events.connect,onMessage:events.message},storage:{local:area('local'),session:area('session'),onChanged:events.storage},contextMenus:{update(_id,_value,callback){callback?.();},create(_value,callback){callback?.();},async removeAll(){},onClicked:events.clicked},sidePanel:{async open(){},async setPanelBehavior(){}},tabs:{onActivated:event(),onUpdated:event(),async get(id){return clone(tabs.get(id)??{id,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'});},async query(){return [clone([...tabs.values()].at(-1)??{id:11,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'})];},async sendMessage(id,message){const tab=tabs.get(id)??{id,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'};if(message.action==='context'){const gate=contextGates.get(message.text);if(gate){gate.started=true;await gate.promise;}return {ok:true,result:{context:'Context for '+message.text,status:'matched',selection:message.text,title:tab.title,url:tab.url,pageState:{stable:true}}};}return {ok:true,result:message.action==='state'?{stable:true}:{}};}},scripting:{async executeScript(){return [{documentId:'synthetic-document'}];}}};
    chrome.action={onClicked:events.action};
    vm.runInNewContext(bundle.outputFiles[0].text,{chrome,crypto:webcrypto,URL,console:{log:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' '))},structuredClone,performance,setTimeout(fn,delay,...args){const timer=setTimeout(()=>{timers.delete(timer);fn(...args);},delay);timer.unref?.();timers.add(timer);return timer;},clearTimeout(timer){timers.delete(timer);clearTimeout(timer);},setInterval,clearInterval,Promise,AbortController,Buffer,atob,btoa},{filename:'synthetic-background.cjs'});
  }
  boot();
  const host={stores,ports,pages,logs,commands,get generation(){return workerGeneration;},
    async syncLocal(localSnapshot){const changes={};for(const key of [sessionKey,'lingo-ui-language']){const value=localSnapshot[key];if(JSON.stringify(stores.local[key])!==JSON.stringify(value)){changes[key]={oldValue:clone(stores.local[key]),newValue:clone(value)};if(value===undefined)delete stores.local[key];else stores.local[key]=clone(value);}}if(Object.keys(changes).length)events.storage.emit(changes,'local');},
    async bridge(page,payload){
      if(payload.localSnapshot)await host.syncLocal(payload.localSnapshot);
      if(payload.kind==='get')return area(payload.area).get(payload.keys);
      if(payload.kind==='set')return area(payload.area).set(payload.values);
      if(payload.kind==='remove')return area(payload.area).remove(payload.keys);
      if(payload.kind==='connect'){connect(payload.id,page,payload.name);return;}
      if(payload.kind==='port'){connect(payload.id,page).onMessage.emit(clone(payload.message));return;}
      if(payload.kind==='disconnect'){disconnect(payload.id);return;}
      if(payload.kind==='runtime'){const entry={message:clone(payload.message),resolved:false};commands.push(entry);return new Promise(resolve=>events.message.emit(clone(payload.message),{id:'synthetic-selection',url:panelUrl},reply=>{entry.resolved=true;entry.reply=clone(reply);resolve(reply);}));}
      throw Error('Unknown synthetic Chrome command');
    },
    async install(page,{windowId=1,legacy=false}={}){
      pages.add(page);page.on('close',()=>{pages.delete(page);for(const [id,port] of ports)if(port.page===page)disconnect(id);});
      await page.exposeBinding('__selectionBridge',({page:source},payload)=>host.bridge(source,payload));
      await page.addInitScript(({windowId,legacy,sessionKey})=>{
        const portListeners=new Map(),storageListeners=new Set();let serial=Promise.resolve();
        window.__selectionPortEvent=(id,message)=>{for(const listener of portListeners.get(id)??[])listener(message);};
        window.__selectionStorageEvent=(changes,area)=>{for(const listener of storageListeners)listener(changes,area);};
        const bridge=payload=>window.__selectionBridge(payload);
        const patch=chrome=>{
          if(!chrome||chrome.__selectionPatched)return chrome;chrome.__selectionPatched=true;
          const originalSend=chrome.runtime?.sendMessage?.bind(chrome.runtime),originalConnect=chrome.runtime?.connect?.bind(chrome.runtime);
          const localSnapshot=async()=>legacy?chrome.storage.local.get([sessionKey,'lingo-ui-language']):undefined;
          chrome.windows={...chrome.windows,async getCurrent(){return {id:windowId};}};
          chrome.runtime={...chrome.runtime,id:'synthetic-selection',getURL:file=>'chrome-extension://synthetic-selection/'+file,
            connect(options){const old=legacy?originalConnect?.(options):null,id=crypto.randomUUID(),listeners=new Set();portListeners.set(id,listeners);serial=serial.then(()=>bridge({kind:'connect',id,name:options.name}));return {name:options.name,onMessage:{addListener(fn){listeners.add(fn);old?.onMessage?.addListener?.(fn);}},onDisconnect:{addListener(){}},postMessage(message){serial=serial.then(async()=>bridge({kind:'port',id,message,localSnapshot:await localSnapshot()}));},disconnect(){void bridge({kind:'disconnect',id});}};},
            async sendMessage(message){if(legacy&&message.kind!=='selection-queue')return originalSend(message);await serial;return bridge({kind:'runtime',message,localSnapshot:await localSnapshot()});}
          };
          if(!legacy)chrome.storage={local:{get:keys=>bridge({kind:'get',area:'local',keys}),set:values=>bridge({kind:'set',area:'local',values}),remove:keys=>bridge({kind:'remove',area:'local',keys})},session:{get:keys=>bridge({kind:'get',area:'session',keys}),set:values=>bridge({kind:'set',area:'session',values}),remove:keys=>bridge({kind:'remove',area:'session',keys})},onChanged:{addListener(fn){storageListeners.add(fn);}}};
          return chrome;
        };
        if(legacy){let value=window.chrome;if(value)patch(value);else Object.defineProperty(window,'chrome',{configurable:true,get(){return value;},set(next){value=patch(next);}});}
        else window.chrome=patch({runtime:{},storage:{}});
      },{windowId,legacy,sessionKey});
    },
    async select(text,{windowId=1,tabId=windowId*100+1}={}){const tab={id:tabId,windowId,url:'https://example.test/reading-'+windowId,title:'Synthetic reading '+windowId};tabs.set(tabId,tab);events.clicked.emit({menuItemId:'learn-selection',selectionText:text,frameId:0},clone(tab));},
    holdContext(text){let release;const promise=new Promise(resolve=>{release=resolve;});const gate={promise,release,started:false};contextGates.set(text,gate);return gate;},
    snapshot(){return clone(stores.session[queueKey]);},
    async changeAccount(owner){const value=owner?JSON.stringify({access_token:owner,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:owner,email:owner+'@example.test'}}):undefined;return value?area('local').set({[sessionKey]:value}):area('local').remove(sessionKey);},
    disconnectPage(page){for(const [id,port] of ports)if(port.page===page)disconnect(id);},
    restart(){for(const id of [...ports.keys()])disconnect(id);for(const timer of timers)clearTimeout(timer);timers.clear();boot();},
    close(){for(const id of [...ports.keys()])disconnect(id);for(const timer of timers)clearTimeout(timer);timers.clear();for(const gate of contextGates.values())gate.release();}
  };return host;
}

/** Existing focused browser tests keep their API/context fixtures but use the real queue arbiter. */
export async function installSelectionQueueBridge(t,page,origin){const host=await createSelectionBackground({origin});t.after(()=>host.close());await host.install(page,{legacy:true});return host;}
