import { cropBounds } from './context';
import {cachedUiLanguage,normalizeUiLanguage,surfaceText} from './surface-i18n';
declare const __SUPABASE_URL__:string;
const PANEL=chrome.runtime.getURL('panel.html');
const UI_LANGUAGE_KEY='lingo-ui-language';
const SESSION_KEY='lingo-session:'+(typeof __SUPABASE_URL__==='string'?__SUPABASE_URL__:'https://brbymnycnxtfchffanvs.supabase.co');
let uiLanguageQueue=Promise.resolve();
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
const broadcast=(message:any)=>{ for(const port of panels)try{port.postMessage(message);}catch{} };
const supported=(url?:string)=>!!url&&/^https?:\/\//.test(url)&&!/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);
chrome.runtime.onInstalled.addListener(async()=>{
  await queueLanguage(async()=>{await chrome.contextMenus.removeAll();await refreshMenu();});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false});
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes[SESSION_KEY])void queueLanguage(refreshMenu).catch(()=>{});
});
void queueLanguage(refreshMenu).catch(()=>{});
// A normal action click grants activeTab. Automatic side-panel toggling does not.
chrome.action.onClicked.addListener(tab=>{
  void chrome.sidePanel.open({windowId:tab.windowId}).catch(()=>{});
});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(info.menuItemId!=='learn-selection'||!tab?.id)return;
  const opening=chrome.sidePanel.open({windowId:tab.windowId}); // Keep the user gesture.
  const draft:any={text:info.selectionText??'',source:cleanSource(tab.title??'',tab.url??''),context:'',status:'unavailable',nonce:crypto.randomUUID()};
  void(async()=>{try{const binding=await attach(tab,info.frameId??0);Object.assign(draft,await context(draft.text,binding));}catch{}await chrome.storage.session.set({draft});broadcast({event:'draft.changed',draft});})();
  void opening.catch(()=>{});
});
chrome.runtime.onConnect.addListener(port=>{
  if(port.name!=='learning-panel'||port.sender?.id!==chrome.runtime.id||(port.sender.tab&&port.sender.url!==PANEL))return;
  panels.add(port);port.onDisconnect.addListener(()=>{panels.delete(port);if(!panels.size)for(const binding of captures.values())cancelCapture(binding);});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==PANEL){respond({ok:false,error:'UNTRUSTED_SENDER'});return;}
  (async()=>{
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
