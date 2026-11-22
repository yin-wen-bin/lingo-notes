import { cropBounds } from './context';
import {cachedUiLanguage,normalizeUiLanguage,surfaceText} from './surface-i18n';
import {SelectionQueue,type QueueCommand,type QueueIdentity,type QueueSnapshot,type QueueMaterial,type QueueOwner} from './selection-queue';
declare const __SUPABASE_URL__:string;
const PANEL=chrome.runtime.getURL('panel.html');
const UI_LANGUAGE_KEY='lingo-ui-language';
const SESSION_KEY='lingo-session:'+(typeof __SUPABASE_URL__==='string'?__SUPABASE_URL__:'https://brbymnycnxtfchffanvs.supabase.co');
let uiLanguageQueue=Promise.resolve();
let selectionOwner:QueueOwner|undefined,selectionOwnerGeneration=0;
function sessionOwner(raw:unknown):QueueOwner{try{const session=typeof raw==='string'?JSON.parse(raw):null;return typeof session?.user?.id==='string'?session.user.id:null;}catch{return null;}}
function queueLanguage(task:()=>Promise<void>){uiLanguageQueue=uiLanguageQueue.catch(()=>{}).then(task);return uiLanguageQueue;}
async function uiIdentity(){
  const stored=await chrome.storage.local.get([SESSION_KEY,UI_LANGUAGE_KEY]);let owner:string|null=null;
  try{const raw=stored[SESSION_KEY];const session=typeof raw==='string'?JSON.parse(raw):null;if(typeof session?.user?.id==='string')owner=session.user.id;}catch{}
  return {owner,language:cachedUiLanguage(stored[UI_LANGUAGE_KEY],owner)};
}
async function updateMenu(language:unknown){
  const title=surfaceText(language,'contextTitle');
  try{await new Promise<void>((resolve,reject)=>chrome.contextMenus.update('learn-selection',{title},()=>chrome.runtime.lastError?reject(Error('MENU_NOT_READY')):resolve()));}
  catch{await new Promise<void>(resolve=>chrome.contextMenus.create({id:'learn-selection',title,contexts:['selection']},()=>{void chrome.runtime.lastError;resolve();}));}
}
async function refreshMenu(){await updateMenu((await uiIdentity()).language);}
type Binding={tabId:number,windowId:number,frameId:number,documentId?:string,url:string,rect?:{x:number,y:number,width:number,height:number},viewport?:any};
const captures=new Map<number,Binding>();
const contextCache=new Map<string,{text:string,result:any,at:number}>();
const cleanSource=(title:string,url:string)=>{try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return null;u.username='';u.password='';u.search='';u.hash='';return {title:title.slice(0,1000),url:u.href};}catch{return null;}};
async function attach(tab:chrome.tabs.Tab,frameId=0):Promise<Binding>{
  if(!tab.id||!supported(tab.url))throw new Error('CAPTURE_RESTRICTED');
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[frameId]},files:['page.js']});
  return {tabId:tab.id,windowId:tab.windowId,frameId,documentId:results[0]?.documentId,url:tab.url!};
}
async function page(binding:Binding,action:string,params:any={}){
  const tab=await chrome.tabs.get(binding.tabId);if(tab.url!==binding.url)throw new Error('PAGE_CHANGED');
  if(action==='context')await chrome.scripting.executeScript({target:binding.documentId?{tabId:binding.tabId,documentIds:[binding.documentId]}:{tabId:binding.tabId,frameIds:[binding.frameId]},files:['page.js']});
  const result=await chrome.tabs.sendMessage(binding.tabId,{channel:'lingo-page',action,...params},binding.documentId?{documentId:binding.documentId}:{frameId:binding.frameId});
  if(!result?.ok)throw new Error(result?.error??'PAGE_UNAVAILABLE');return result.result;
}
async function context(text:string,binding?:Binding){
  let source=null;
  try{
    if(!binding){const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});source=cleanSource(tab?.title??'',tab?.url??'');binding=await attach(tab);}
    const key=JSON.stringify(binding),cached=contextCache.get(key);
    if(cached&&cached.text===text&&Date.now()-cached.at<30000){
      try{if(JSON.stringify(await page(binding,'state'))===JSON.stringify(cached.result.pageState))return {...cached.result,cached:true};}catch{}
    }
    if(binding.rect&&binding.viewport){const current=await page(binding,'metrics');if(JSON.stringify(current)!==JSON.stringify(binding.viewport))return {context:'',status:'unavailable',binding,source:cleanSource('',binding.url)};}
    const result=await page(binding,'context',{text,rect:binding.rect});
    const output={...result,binding,source:cleanSource(result.title,result.url)};
    if(contextCache.size>=10)contextCache.delete(contextCache.keys().next().value!);
    contextCache.set(key,{text,result:output,at:Date.now()});return output;
  }catch{return {context:'',status:'unavailable',binding,source};}
}
async function capture(language:unknown){
  const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if(captures.has(tab?.windowId))throw new Error('CAPTURE_IN_PROGRESS');
  const binding=await attach(tab);captures.set(binding.windowId,binding);
  try{
    const selection=await page(binding,'select',{ui_language:normalizeUiLanguage(language)});
    const [active]=await chrome.tabs.query({active:true,windowId:binding.windowId});
    if(active?.id!==binding.tabId||active.url!==binding.url)throw new Error('TAB_CHANGED');
    if(JSON.stringify(await page(binding,'metrics'))!==JSON.stringify(selection.viewport))throw new Error('VIEWPORT_CHANGED');
    const full=await chrome.tabs.captureVisibleTab(binding.windowId,{format:'png'});
    const [after]=await chrome.tabs.query({active:true,windowId:binding.windowId});
    if(after?.id!==binding.tabId||after.url!==binding.url)throw new Error('TAB_CHANGED');
    if(JSON.stringify(await page(binding,'metrics'))!==JSON.stringify(selection.viewport))throw new Error('VIEWPORT_CHANGED');
    const bytes=Uint8Array.from(atob(full.split(',')[1]),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const rect=cropBounds(selection.rect,selection.viewport,bitmap),canvas=new OffscreenCanvas(rect.width,rect.height);
    canvas.getContext('2d')!.drawImage(bitmap,rect.x,rect.y,rect.width,rect.height,0,0,rect.width,rect.height);bitmap.close();
    const blob=await canvas.convertToBlob({type:'image/png'});if(blob.size>4*1024*1024)throw new Error('IMAGE_TOO_LARGE');
    const data=new Uint8Array(await blob.arrayBuffer());let encoded='';for(let i=0;i<data.length;i+=32768)encoded+=String.fromCharCode(...data.subarray(i,i+32768));
    return {image:'data:image/png;base64,'+btoa(encoded),binding:{...binding,rect:selection.rect,viewport:selection.viewport},source:cleanSource(selection.title,selection.url)};
  }finally{captures.delete(binding.windowId);void page(binding,'cancel').catch(()=>{});}
}
function cancelCapture(binding:Binding){void page(binding,'cancel').catch(()=>{});}
chrome.tabs.onActivated.addListener(({tabId,windowId})=>{const binding=captures.get(windowId);if(binding&&binding.tabId!==tabId)cancelCapture(binding);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.url||change.status==='loading')for(const b of captures.values())if(b.tabId===tabId)cancelCapture(b);});
const panels=new Set<chrome.runtime.Port>();
const registeredPanels=new Map<chrome.runtime.Port,QueueIdentity>();
let selectionQueue:SelectionQueue|null=null,selectionOperations:Promise<unknown>=Promise.resolve();
function publishSelection(snapshot:QueueSnapshot){
  for(const [port,identity] of registeredPanels)if(identity.owner===snapshot.owner)try{port.postMessage({event:'selection-queue.changed',snapshot});}catch{}
}
function selections(){return selectionQueue??=new SelectionQueue(chrome.storage.session,publishSelection);}
function selectionOperation<T>(task:()=>Promise<T>):Promise<T>{const operation=selectionOperations.catch(()=>{}).then(task);selectionOperations=operation;return operation;}
function validIdentity(identity:any):identity is QueueIdentity{return !!identity&&typeof identity.clientId==='string'&&identity.clientId.length>0&&Number.isInteger(identity.windowId)&&(identity.owner===null||typeof identity.owner==='string');}
async function collectSelection(job:{id:string;owner:string|null},tab:chrome.tabs.Tab,frameId:number,text:string,source:any){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const unavailable:QueueMaterial={text,source,context:'',status:'timeout'};
  const collecting=(async()=>{try{const binding=await attach(tab,frameId);return {...await context(text,binding),text,source};}catch{return {...unavailable,status:'unavailable'};}})();
  const material=await Promise.race([collecting,new Promise<QueueMaterial>(resolve=>{timer=setTimeout(()=>resolve(unavailable),1800);})]);
  clearTimeout(timer);
  await selectionOperation(async()=>{if((await uiIdentity()).owner!==job.owner)return;await selections().contextReady(job.owner,job.id,material);});
}
const broadcast=(message:any)=>{ for(const port of panels)try{port.postMessage(message);}catch{} };
const supported=(url?:string)=>!!url&&/^https?:\/\//.test(url)&&!/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);
chrome.runtime.onInstalled.addListener(async()=>{
  await queueLanguage(async()=>{await chrome.contextMenus.removeAll();await refreshMenu();});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false});
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes[SESSION_KEY]){
    const owner=sessionOwner(changes[SESSION_KEY].newValue);if(owner!==selectionOwner){selectionOwner=owner;++selectionOwnerGeneration;}
    void queueLanguage(refreshMenu).catch(()=>{});
    if(chrome.storage.session)void selectionOperation(async()=>selections().syncOwner((await uiIdentity()).owner)).catch(()=>{});
  }
});
void queueLanguage(refreshMenu).catch(()=>{});
const initialOwnerGeneration=selectionOwnerGeneration;
void uiIdentity().then(identity=>{if(selectionOwnerGeneration===initialOwnerGeneration)selectionOwner=identity.owner;}).catch(()=>{});
// A normal action click grants activeTab. Automatic side-panel toggling does not.
chrome.action.onClicked.addListener(tab=>{
  void chrome.sidePanel.open({windowId:tab.windowId}).catch(()=>{});
});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(info.menuItemId!=='learn-selection'||!tab?.id)return;
  const opening=chrome.sidePanel.open({windowId:tab.windowId}); // Keep the user gesture.
  const text=info.selectionText??'',source=cleanSource(tab.title??'',tab.url??''),nonce=crypto.randomUUID(),generation=selectionOwnerGeneration;
  const atClick=selectionOwner===undefined?uiIdentity():Promise.resolve({owner:selectionOwner});
  // Reserve order before starting asynchronous page reads. Their completion order is irrelevant.
  void selectionOperation(async()=>{
    const {owner}=await atClick;
    if(generation!==selectionOwnerGeneration||(await uiIdentity()).owner!==owner)return;
    const job=await selections().enqueue(owner,tab.windowId,{text,source,context:'',status:'unavailable'},nonce);
    void collectSelection(job,tab,info.frameId??0,text,source).catch(()=>{});
  }).catch(()=>{});
  void opening.catch(()=>{});
});
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=='learning-panel'||port.sender?.id!==chrome.runtime.id||port.sender.url!==PANEL)return;
  panels.add(port);
  port.onMessage.addListener(message=>{
    if(message?.kind!=='selection-queue.register'||!validIdentity(message))return;
    const identity:QueueIdentity={clientId:message.clientId,owner:message.owner,windowId:message.windowId};
    void selectionOperation(async()=>{
      if(!panels.has(port))return;
      if((await uiIdentity()).owner!==identity.owner)throw Error('SESSION_CHANGED');
      const old=registeredPanels.get(port);if(old&&old.clientId!==identity.clientId)await selections().disconnect(old.clientId,old.owner);
      registeredPanels.set(port,identity);selections().register(identity);await selections().syncOwner(identity.owner);
      port.postMessage({event:'selection-queue.registered',...identity});
    }).catch(error=>{try{port.postMessage({event:'selection-queue.error',error:error.message??'REQUEST_FAILED',...identity});}catch{}});
  });
  port.onDisconnect.addListener(()=>{
    panels.delete(port);const identity=registeredPanels.get(port);registeredPanels.delete(port);
    if(identity)void selectionOperation(async()=>selections().disconnect(identity.clientId,identity.owner)).catch(()=>{});
    if(!panels.size)for(const binding of captures.values())cancelCapture(binding);
  });
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==PANEL){respond({ok:false,error:'UNTRUSTED_SENDER'});return;}
  (async()=>{
    if(message.kind==='selection-queue')return selectionOperation(async()=>{
      if(!validIdentity(message)||(await uiIdentity()).owner!==message.owner)throw Error('SESSION_CHANGED');
      if(![...registeredPanels.values()].some(identity=>identity.clientId===message.clientId&&identity.owner===message.owner&&identity.windowId===message.windowId))throw Error('UNTRUSTED_SENDER');
      const command=message as QueueCommand,result=await selections().command(command);
      if(command.op==='manual'&&result.draft){
        for(const [port,identity] of registeredPanels)if(identity.owner===message.owner&&identity.windowId===message.windowId)try{port.postMessage({event:'draft.changed',draft:result.draft});}catch{}
      }
      return result;
    });
    if(message.kind==='context')return context(message.text,message.binding);
    if(message.kind==='capture')return capture(message.ui_language??(await uiIdentity()).language);
    if(message.kind==='ui-language.changed'){
      await queueLanguage(async()=>{
        const {owner}=await uiIdentity();
        if(owner!==(message.accountId??null))return;
        const language=owner?normalizeUiLanguage(message.language):'zh';
        await chrome.storage.local.set({[UI_LANGUAGE_KEY]:{owner,language}});
        // Account changes can happen during storage IO; never show the old label.
        await refreshMenu();
      });return {};
    }
    if(message.kind==='capture.cancel'){for(const binding of captures.values())cancelCapture(binding);return {};}
    throw new Error('UNKNOWN_METHOD');
  })().then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message??'REQUEST_FAILED'}));return true;
});
