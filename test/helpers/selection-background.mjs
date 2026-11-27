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
  const stores={local:clone(local),session:clone(session)},ports=new Map(),allPorts=new Map(),pages=new Set(),tabs=new Map(),contextGates=new Map(),timers=new Set(),logs=[],commands=[],pendingReplies=new Set(),replyGates=new Map();
  const faults={registrationAcks:0,registrationGate:null,commandReplies:new Map()};
  let chrome,events,workerGeneration=0;
  const sessionKey='lingo-session:'+origin,panelUrl='chrome-extension://synthetic-selection/panel.html';
  const publishStorage=(changes,area)=>{events.storage.emit(clone(changes),area);for(const page of pages)if(!page.isClosed())void page.evaluate(({changes,area})=>window.__selectionStorageEvent?.(changes,area),{changes:clone(changes),area}).catch(()=>{});};
  const area=(name,generation=null)=>{const live=()=>{if(generation!==null&&generation!==workerGeneration)throw Error('Synthetic worker terminated');};return {async get(keys){live();if(!keys)return clone(stores[name]);if(typeof keys==='object'&&!Array.isArray(keys))return Object.fromEntries(Object.entries(keys).map(([key,fallback])=>[key,clone(stores[name][key]??fallback)]));return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,clone(stores[name][key])]));},async set(values){live();const changes={};for(const [key,value] of Object.entries(values)){changes[key]={oldValue:clone(stores[name][key]),newValue:clone(value)};stores[name][key]=clone(value);}publishStorage(changes,name);},async remove(keys){live();const changes={};for(const key of Array.isArray(keys)?keys:[keys]){changes[key]={oldValue:clone(stores[name][key])};delete stores[name][key];}publishStorage(changes,name);}};};
  const clientDisconnect=(port,force=false)=>!port.page.isClosed()?port.page.evaluate(({id,force})=>window.__selectionPortDisconnected?.(id,force),{id:port.id,force}).catch(()=>{}):Promise.resolve();
  function disconnect(id,{notifyClient=true}={}){const port=ports.get(id);if(!port)return Promise.resolve();ports.delete(id);port.connected=false;port.onDisconnect.emit();return notifyClient?clientDisconnect(port):Promise.resolve();}
  function connect(id,page,name='learning-panel'){
    if(ports.has(id))return ports.get(id);
    if(allPorts.has(id))throw Error('Attempting to reconnect a disconnected synthetic port');
    const generation=workerGeneration;
    const port={id,name,generation,connected:true,page,sender:{id:'synthetic-selection',url:panelUrl},onMessage:event(),onDisconnect:event(),postMessage(message){if(!port.connected||generation!==workerGeneration)throw Error('Attempting to use a disconnected port object');if(message.event==='selection-queue.registered'&&faults.registrationAcks>0){faults.registrationAcks--;return;}const deliver=()=>{if(port.connected&&generation===workerGeneration&&!page.isClosed())void page.evaluate(({id,message})=>window.__selectionPortEvent?.(id,message),{id,message:clone(message)}).catch(()=>{});};if(message.event==='selection-queue.registered'&&faults.registrationGate){faults.registrationGate.started=true;faults.registrationGate.replies.push(deliver);return;}deliver();},disconnect(){void disconnect(id);}};
    ports.set(id,port);allPorts.set(id,port);events.connect.emit(port);return port;
  }
  function boot(){
    ++workerGeneration;events={storage:event(),installed:event(),connect:event(),message:event(),clicked:event(),action:event()};
    chrome={runtime:{id:'synthetic-selection',getURL:file=>'chrome-extension://synthetic-selection/'+file,onInstalled:events.installed,onConnect:events.connect,onMessage:events.message},storage:{local:area('local',workerGeneration),session:area('session',workerGeneration),onChanged:events.storage},contextMenus:{update(_id,_value,callback){callback?.();},create(_value,callback){callback?.();},async removeAll(){},onClicked:events.clicked},sidePanel:{async open(){},async setPanelBehavior(){}},tabs:{onActivated:event(),onUpdated:event(),async get(id){return clone(tabs.get(id)??{id,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'});},async query(){return [clone([...tabs.values()].at(-1)??{id:11,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'})];},async sendMessage(id,message){const tab=tabs.get(id)??{id,windowId:1,url:'https://example.test/reading',title:'Synthetic reading'};if(message.action==='context'){const gate=contextGates.get(message.text);if(gate){gate.started=true;await gate.promise;}return {ok:true,result:{context:'Context for '+message.text,status:'matched',selection:message.text,title:tab.title,url:tab.url,pageState:{stable:true}}};}return {ok:true,result:message.action==='state'?{stable:true}:{}};}},scripting:{async executeScript(){return [{documentId:'synthetic-document'}];}}};
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
      if(payload.kind==='port'){const port=ports.get(payload.id);if(!port||!port.connected||port.page!==page)throw Error('Attempting to use a disconnected port object');port.onMessage.emit(clone(payload.message));return;}
      if(payload.kind==='disconnect'){disconnect(payload.id);return;}
      if(payload.kind==='runtime'){const entry={message:clone(payload.message),generation:workerGeneration,resolved:false,produced:false};commands.push(entry);return new Promise((resolve,reject)=>{const pending={entry,resolve,reject};pendingReplies.add(pending);events.message.emit(clone(payload.message),{id:'synthetic-selection',url:panelUrl},reply=>{entry.produced=true;entry.reply=clone(reply);const op=payload.message.op,drops=faults.commandReplies.get(op)??0;if(drops>0){faults.commandReplies.set(op,drops-1);return;}const deliver=()=>{if(!pendingReplies.delete(pending))return;entry.resolved=true;resolve(clone(reply));};const gate=replyGates.get(op);if(gate){gate.replies.push(deliver);gate.started=true;}else deliver();});});}
      throw Error('Unknown synthetic Chrome command');
    },
    async install(page,{windowId=1,legacy=false}={}){
      pages.add(page);page.on('close',()=>{pages.delete(page);for(const [id,port] of ports)if(port.page===page)disconnect(id);});
      await page.exposeBinding('__selectionBridge',({page:source},payload)=>host.bridge(source,payload));
      await page.addInitScript(({windowId,legacy,sessionKey})=>{
        const clientPorts=new Map(),storageListeners=new Set();let serial=Promise.resolve();
        window.__selectionPortEvent=(id,message)=>{const port=clientPorts.get(id);if(!port||port.closed)return;for(const listener of port.messages)listener(message);};
        window.__selectionPortDisconnected=(id,force=false)=>{const port=clientPorts.get(id);if(!port||port.closed&&!force)return;port.closed=true;for(const listener of port.disconnections)listener();};
        window.__selectionStorageEvent=(changes,area)=>{for(const listener of storageListeners)listener(changes,area);};
        const bridge=payload=>window.__selectionBridge(payload);
        const patch=chrome=>{
          if(!chrome||chrome.__selectionPatched)return chrome;chrome.__selectionPatched=true;
          const originalSend=chrome.runtime?.sendMessage?.bind(chrome.runtime),originalConnect=chrome.runtime?.connect?.bind(chrome.runtime);
          const localSnapshot=async()=>legacy?chrome.storage.local.get([sessionKey,'lingo-ui-language']):undefined;
          chrome.windows={...chrome.windows,async getCurrent(){return {id:windowId};}};
          chrome.runtime={...chrome.runtime,id:'synthetic-selection',getURL:file=>'chrome-extension://synthetic-selection/'+file,
            connect(options){const old=legacy?originalConnect?.(options):null,id=crypto.randomUUID(),state={messages:new Set(),disconnections:new Set(),closed:false};clientPorts.set(id,state);const enqueue=task=>{const operation=serial.then(task);serial=operation.catch(()=>{});void operation.catch(()=>window.__selectionPortDisconnected(id));};enqueue(()=>bridge({kind:'connect',id,name:options.name}));return {name:options.name,onMessage:{addListener(fn){state.messages.add(fn);old?.onMessage?.addListener?.(fn);},removeListener(fn){state.messages.delete(fn);}},onDisconnect:{addListener(fn){state.disconnections.add(fn);},removeListener(fn){state.disconnections.delete(fn);}},postMessage(message){if(state.closed)throw Error('Attempting to use a disconnected port object');enqueue(async()=>{if(state.closed)throw Error('Attempting to use a disconnected port object');return bridge({kind:'port',id,message,localSnapshot:await localSnapshot()});});},disconnect(){if(state.closed)return;state.closed=true;void bridge({kind:'disconnect',id}).catch(()=>{});}};},
            async sendMessage(message){if(legacy&&message.kind!=='selection-queue')return originalSend(message);await serial;return bridge({kind:'runtime',message,localSnapshot:await localSnapshot()});}
          };
          if(!legacy)chrome.storage={local:{get:keys=>bridge({kind:'get',area:'local',keys}),set:values=>bridge({kind:'set',area:'local',values}),remove:keys=>bridge({kind:'remove',area:'local',keys})},session:{get:keys=>bridge({kind:'get',area:'session',keys}),set:values=>bridge({kind:'set',area:'session',values}),remove:keys=>bridge({kind:'remove',area:'session',keys})},onChanged:{addListener(fn){storageListeners.add(fn);},removeListener(fn){storageListeners.delete(fn);}}};
          else if(chrome.storage?.onChanged){const changed=chrome.storage.onChanged;chrome.storage.onChanged={...changed,addListener(fn){storageListeners.add(fn);changed.addListener?.(fn);},removeListener(fn){storageListeners.delete(fn);changed.removeListener?.(fn);}};}
          return chrome;
        };
        if(legacy){let value=window.chrome;if(value)patch(value);Object.defineProperty(window,'chrome',{configurable:true,get(){return value;},set(next){value=patch(next);}});}
        else window.chrome=patch({runtime:{},storage:{}});
      },{windowId,legacy,sessionKey});
    },
    async select(text,{windowId=1,tabId=windowId*100+1}={}){const tab={id:tabId,windowId,url:'https://example.test/reading-'+windowId,title:'Synthetic reading '+windowId};tabs.set(tabId,tab);events.clicked.emit({menuItemId:'learn-selection',selectionText:text,frameId:0},clone(tab));},
    holdContext(text){let release;const promise=new Promise(resolve=>{release=resolve;});const gate={promise,release,started:false};contextGates.set(text,gate);return gate;},
    snapshot(){return clone(stores.session[queueKey]);},
    async changeAccount(owner){const value=owner?JSON.stringify({access_token:owner,refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+3600,user:{id:owner,email:owner+'@example.test'}}):undefined;return value?area('local').set({[sessionKey]:value}):area('local').remove(sessionKey);},
    disconnectPage(page,options){return Promise.all([...ports].filter(([,port])=>port.page===page).map(([id])=>disconnect(id,options)));},
    deliverLateDisconnect(id){const port=allPorts.get(id);return port?clientDisconnect(port,true):Promise.resolve();},
    dropRegistrationAcks(count=1){faults.registrationAcks+=count;},
    holdRegistrationAcks(){const gate={started:false,replies:[],release(){if(faults.registrationGate===gate)faults.registrationGate=null;for(const deliver of gate.replies.splice(0))deliver();}};faults.registrationGate=gate;return gate;},
    dropCommandReplies(op,count=1){faults.commandReplies.set(op,(faults.commandReplies.get(op)??0)+count);},
    holdCommandReplies(op){const gate={started:false,replies:[],release(){replyGates.delete(op);for(const deliver of gate.replies.splice(0))deliver();}};replyGates.set(op,gate);return gate;},
    restart(){const disconnected=[...ports.keys()].map(id=>disconnect(id));for(const pending of pendingReplies){pending.entry.resolved=true;pending.resolve(undefined);}pendingReplies.clear();for(const timer of timers)clearTimeout(timer);timers.clear();boot();return Promise.all(disconnected);},
    close(){for(const id of [...ports.keys()])void disconnect(id);for(const pending of pendingReplies)pending.resolve(undefined);pendingReplies.clear();for(const timer of timers)clearTimeout(timer);timers.clear();for(const gate of contextGates.values())gate.release();for(const gate of replyGates.values())gate.release();faults.registrationGate?.release();}
  };return host;
}

/** Existing focused browser tests keep their API/context fixtures but use the real queue arbiter. */
export async function installSelectionQueueBridge(t,page,origin){const host=await createSelectionBackground({origin});t.after(()=>host.close());await host.install(page,{legacy:true});return host;}
