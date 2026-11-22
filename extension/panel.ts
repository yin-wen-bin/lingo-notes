import {hasLearningText} from './learning-ui';
import {HistoryList} from './history';
import {PanelNavigation, type PanelRoute} from './navigation';
import {WordSpeech, type SpeechMessage} from './speech';
import {translate, type UiLanguage, type UiValues} from './panel-i18n';
import {PanelSessionState, PrivateImageUrls} from './panel-cloud';
import {createCloudClient, type CloudSession} from '../shared/cloud-client';
import {applyFontTheme, FONT_THEMES, normalizeFontTheme, type FontTheme} from '../shared/typography/theme';
import type {ExplanationLanguage} from '../shared/cloud-types';
declare const __SUPABASE_URL__:string;
declare const __SUPABASE_PUBLISHABLE_KEY__:string;
const cloudUrl=typeof __SUPABASE_URL__==='string'?__SUPABASE_URL__:'https://brbymnycnxtfchffanvs.supabase.co';
const cloud=createCloudClient({url:cloudUrl,publishableKey:typeof __SUPABASE_PUBLISHABLE_KEY__==='string'?__SUPABASE_PUBLISHABLE_KEY__:'',storage:{
  async getItem(key){const value=(await chrome.storage.local.get(key))[key];return typeof value==='string'?value:null;},
  async setItem(key,value){await chrome.storage.local.set({[key]:value});},
  async removeItem(key){await chrome.storage.local.remove(key);}
}});
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const field=(id:string)=>$<HTMLTextAreaElement>(id);
const show=(id:string,visible:boolean)=>$(id).hidden=!visible;
let uiLanguage:UiLanguage='zh';
type Values=UiValues|(()=>UiValues);
type UiBinding={key:string,values?:Values};
const uiBindings=new WeakMap<HTMLElement,Map<string,UiBinding>>();
const uiLang=()=>uiLanguage==='zh'?'zh-CN':uiLanguage;
const tr=(key:string,values?:UiValues)=>translate(uiLanguage,key,values);
function renderUiBinding(element:HTMLElement,target:string,binding:UiBinding){
  const text=tr(binding.key,typeof binding.values==='function'?binding.values():binding.values);
  if(target==='text'){element.textContent=text;element.lang=uiLang();}else element.setAttribute(target,text);
}
function bindUi(element:HTMLElement|string,key:string,values?:Values,target='text'){
  const node=typeof element==='string'?$(element):element;
  let bindings=uiBindings.get(node);if(!bindings){bindings=new Map();uiBindings.set(node,bindings);}
  bindings.set(target,{key,values});node.dataset.uiBound='';renderUiBinding(node,target,{key,values});return node;
}
function unbindUi(element:HTMLElement){uiBindings.delete(element);delete element.dataset.uiBound;}
function setUiLanguage(language:UiLanguage){
  uiLanguage=language;document.documentElement.lang=uiLang();document.documentElement.dataset.uiLanguage=language;
  // Update only explicit UI bindings. Never replace editors, lessons, or raw material.
  for(const node of document.querySelectorAll<HTMLElement>('[data-ui-bound]'))for(const [target,binding] of uiBindings.get(node)??[])renderUiBinding(node,target,binding);
}
function publishUiLanguage(){
  // A failed surface update must not fail a confirmed account preference save.
  try{void chrome.runtime.sendMessage({kind:'ui-language.changed',language:uiLanguage,accountId:accountId??null}).catch(()=>{});}catch{/* Extension context may be closing. */}
}
for(const node of document.querySelectorAll<HTMLElement>('[data-i18n],[data-i18n-placeholder],[data-i18n-aria-label],[data-i18n-alt]')){
  for(const [attribute,target] of [['data-i18n','text'],['data-i18n-placeholder','placeholder'],['data-i18n-aria-label','aria-label'],['data-i18n-alt','alt']]){
    const key=node.getAttribute(attribute);if(key!==null)bindUi(node,key,undefined,target);
  }
}
setUiLanguage('zh');
const labels:Record<string,string>={saved:'已保存到云端',processing:'已保存 · 处理中',awaiting_review:'检查识别文字',complete:'学习笔记',failed:'处理失败',interrupted:'已中断 · 结果未知',cancelled:'已取消'};
const contexts:Record<string,string>={matched:'已从原网页获取前后句',truncated:'已获取附近句子，较长内容已截短',not_found:'原网页中未找到匹配文字，将仅按输入讲解',ambiguous:'原网页中有多处匹配，未自动选用上下文',unavailable:'无法读取原页面，将仅按输入讲解',none:'未附加网页上下文'};
contexts.timeout='获取上下文超时，本次仅按输入讲解';
const errors:Record<string,string>={LOGIN_REQUIRED:'请在“连接与设置”登录 Lingo Notes。',AUTH_EXPIRED:'登录已过期，请重新登录；不会自动重新发送讲解。',AUTH_FAILED:'邮箱或密码不正确，或账号尚未开通。',AUTH_UNAVAILABLE:'登录服务暂时不可用，请稍后重试。',CLOUD_NOT_CONFIGURED:'此安装包尚未配置云端连接。',KEY_REQUIRED:'请先在“连接与设置”保存 DeepSeek API Key。',NETWORK_ERROR:'网络不可用，尚未确认云端结果；请连接网络后从历史查看。',RATE_LIMITED:'请求较多，请稍后重试。',STREAM_INTERRUPTED:'连接中断，正在核对云端结果；不会自动重新发送。',REQUEST_DISCONNECTED:'连接已断开，正在核对云端结果。',CAPTURE_RESTRICTED:'此页面无法截图。请在普通网页点击扩展图标后重试，或选择图片。',TAB_CHANGED:'标签页已切换，选区已取消。',VIEWPORT_CHANGED:'页面位置或大小已变化，选区已取消。',CAPTURE_CANCELLED:'已取消截图，未发送图片。',EMPTY_TEXT:'请先选择或输入文字。',IMAGE_TOO_LARGE:'图片过大，请选择较小区域（不超过 4 MB）。',REVISION_CONFLICT:'记录已更新，请从历史重新打开。',INPUT_CHANGED:'输入内容已改变，请确认后重新点击讲解。',REQUEST_IN_PROGRESS:'请等待当前请求结束或先取消。',RECORD_BUSY:'这条记录仍在处理，请稍后查看。',RESULT_UNKNOWN:'未能确认完整结果；重新讲解可能再次产生 API 费用。'};
Object.assign(errors,{DEEPSEEK_KEY_REQUIRED:errors.KEY_REQUIRED,DEEPSEEK_KEY_INVALID:'DeepSeek Key 未通过验证，请在“连接与设置”更新。',DEEPSEEK_BALANCE_INSUFFICIENT:'DeepSeek 账户余额不足，请在厂商处检查额度。',DEEPSEEK_RATE_LIMIT:'DeepSeek 暂时限流，请稍后手动重试。',KEY_UNAVAILABLE:'暂时无法读取已保存的 Key，请稍后检查连接。',INVALID_API_KEY:'Key 格式不正确，请检查后重新填写。',REQUEST_INTERRUPTED_RESULT_UNKNOWN:errors.RESULT_UNKNOWN,REQUEST_FAILED_RESULT_UNKNOWN:errors.RESULT_UNKNOWN,MODEL_OUTPUT_INCOMPLETE:'模型未返回完整讲解；材料已保存，重试可能再次产生 API 费用。',INVALID_LESSON:'本次讲解未通过完整性检查；材料已保存，可手动重新讲解。',CANCELLED_REQUEST_MAY_HAVE_BEEN_SENT:'请求已取消；已发生的 API 费用不保证撤回。',REQUEST_NOT_ACTIVE:'本次请求已结束，请从历史查看最终状态。',IMAGE_NOT_SAVED:'截图未成功保存，请重新框选或选择图片。',IMAGE_NOT_FOUND:'截图暂时无法读取，请刷新记录后再试。',IMAGE_URL_INVALID:'截图链接校验未通过，请重新读取。',RECORD_NOT_FOUND:'这条记录已不存在，请刷新历史。'});
let current:any=null,material:any={context:'',status:'unavailable',source:null,binding:null},draftNonce='';
Object.assign(errors,{LANGUAGE_NOT_READY:'尚未读取讲解语言，请检查连接后重试。',INVALID_EXPLANATION_LANGUAGE:'请选择中文、日语或英语作为讲解语言。',LANGUAGE_NOT_CONFIRMED:'尚未确认讲解语言已保存，请检查连接后重试。'});
let accountId:string|null|undefined,accountEpoch=0,displayEpoch=0;
let fontTheme:FontTheme='refined',confirmedFontTheme:FontTheme='refined',fontVersion=0,savingFont=false,fontReady=false;
let diagnosisVersion=0,keyMutationVersion=0,savingKey=false,keyConfigured:boolean|null=null,keyLastFour='',keyEditorTouched=false;
let confirmedMode:'fast'|'thinking'='fast',modeVersion=0,savingMode=false;
let confirmedReviewLimit=5,reviewLimitVersion=0,savingReviewLimit=false,reviewLimitReady=false,reviewLimitDirty=false;
type ReviewPoint={id:string;record_id?:string;slot:number;point_key:string;kind?:string;term?:string;meaning?:string;reading?:string;pos?:string;language?:string;explanation_language?:string;mastered:boolean;mastered_at?:string|null;review_round?:number;next_due_date?:string|null;completed?:boolean};
type ReviewMount={epoch:number;recordId:string;revision:number;loadVersion:number;rows:{slot:number;button:HTMLButtonElement;expected:Pick<ReviewPoint,'kind'|'term'|'meaning'|'reading'|'pos'|'language'|'explanation_language'>;card?:ReviewPoint}[];status:HTMLElement;statusText:HTMLElement;retry:HTMLButtonElement};
let reviewMount:ReviewMount|null=null,reviewMutation:Promise<void>|null=null;
const languageSelects=['explanationLanguage','reviewLanguage','retryLanguage'] as const;
const languageButtons=new Set(['send','confirmText','retryConfirm']);
const languageNames={zh:'中文',ja:'日语',en:'英语'};
const normalizeLanguage=(value:unknown):ExplanationLanguage=>value==='en'||value==='ja'?value:'zh';
let preferredLanguage:ExplanationLanguage='zh',languageReady=false,savingLanguage=false,languageVersion=0,selectionVersion=0;
let preparingLearning:symbol|null=null;
let activeStream:{recordId:string,requestId:string,controller:AbortController}|null=null;
const sessionState=new PanelSessionState(chrome.storage.session);
let pendingSubmit:any=null,pendingImage:any=null,cropped:string|null=null,contextToken=0;
let progressSequence=0,progressRequest='';const deletedRecords=new Set<string>();
let imagePreviousMaterial:any=null;
let imageUrl:string|null=null,imageRecord='',imageLoading=false,debounce:ReturnType<typeof setTimeout>;
let polling=false;
type ContentSnapshot={current:any;material:any;pendingSubmit:any;pendingImage:any;cropped:string|null;imagePreviousMaterial:any;stage:string;retryOpen:boolean;detailsOpen:boolean;draftDetailsOpen:boolean;progressSequence:number;progressRequest:string;preview:any;fields:Record<string,string>;languages:Record<string,{value:string,confirmed?:string}>;scroll:number};
type ContentSlot={epoch:number;snapshot:ContentSnapshot|null};
const navigation=new PanelNavigation();
let workspaceSlot:ContentSlot={epoch:0,snapshot:null},historySlot:ContentSlot|null=null,activeContent:ContentSlot=workspaceSlot;
let settingsScroll=0;
const navigationButtons=new Set(['learnTab','historyTab','settingsTab','backToHistory']);
let lastPreview:any=null;
function notice(key='',values?:Values){bindUi('notice',key,values);show('notice',!!key);}
function failure(error:any){if(error?.message==='SESSION_CHANGED')return;notice(errors[error?.message]??'操作未完成。已保存内容可从历史查看，请稍后重试。');}
async function call(message:any){const reply=await chrome.runtime.sendMessage(message);if(!reply?.ok)throw new Error(reply?.error??'PAGE_UNAVAILABLE');return reply.result;}
const api=async(action:string,params:any={},id?:string)=>{const epoch=accountEpoch;const result=await cloud.call(action,params,id);if(epoch!==accountEpoch)throw Error('SESSION_CHANGED');return result;};
function renderFont(theme:FontTheme){
  fontTheme=theme;applyFontTheme(theme);$<HTMLSelectElement>('fontTheme').value=theme;
  bindUi('fontDescription',FONT_THEMES.find(item=>item.id===theme)?.description??'');
  $<HTMLSelectElement>('fontTheme').disabled=savingFont||!fontReady;
}
async function refreshFontTheme(){
  if(!accountId||savingFont)return;
  const stamp=++fontVersion;
  try{
    const settings=await api('settings.get');if(stamp!==fontVersion)return;
    fontReady=true;confirmedFontTheme=normalizeFontTheme(settings.font_theme);renderFont(confirmedFontTheme);
  }catch(error){if(stamp===fontVersion){fontReady=true;renderFont(fontTheme);throw error;}}
}
async function saveFontTheme(theme:FontTheme){
  if(!accountId||savingFont)return;
  const stamp=++fontVersion,previous=confirmedFontTheme;savingFont=true;renderFont(theme);bindUi('fontState','正在保存字体方案…');
  try{
    await api('settings.update',{font_theme:theme});
    const settings=await api('settings.get');if(stamp!==fontVersion)return;
    if(normalizeFontTheme(settings.font_theme)!==theme)throw Error('FONT_THEME_NOT_CONFIRMED');
    confirmedFontTheme=theme;renderFont(theme);bindUi('fontState','字体方案已保存，会同步到扩展和学习中心。');
  }catch(error){
    if(stamp===fontVersion){renderFont(previous);bindUi('fontState','字体方案未能保存，已恢复上次设置，请稍后重试。');notice('字体方案未能保存，已恢复上次设置，请稍后重试。');}
  }finally{if(stamp===fontVersion){savingFont=false;renderFont(fontTheme);}}
}
function languageLocked(){return !!preparingLearning||!!activeStream||!!current&&['saved','processing'].includes(current.status);}
function syncLanguageControls(){
  const disabled=!accountId||!languageReady||savingLanguage||languageLocked();
  for(const id of languageSelects)$<HTMLSelectElement>(id).disabled=disabled;
  for(const id of languageButtons)$<HTMLButtonElement>(id).disabled=disabled||(id==='send'&&!field('sourceText').value.trim());
}
function usePreferredLanguage(){
  if(languageLocked()||savingLanguage)return;
  $<HTMLSelectElement>('explanationLanguage').value=pendingSubmit?.params?.explanation_language??preferredLanguage;
  $<HTMLSelectElement>('reviewLanguage').value=preferredLanguage;
}
async function refreshExplanationLanguage(){
  if(!accountId||savingLanguage)return;
  const stamp=++languageVersion;
  try{
    const settings=await api('settings.get');if(stamp!==languageVersion)return;
    preferredLanguage=normalizeLanguage(settings.explanation_language);languageReady=true;usePreferredLanguage();setUiLanguage(preferredLanguage);publishUiLanguage();
  }catch(error){if(stamp===languageVersion){languageReady=false;throw error;}}
  finally{if(stamp===languageVersion)syncLanguageControls();}
}
async function saveExplanationLanguage(id:typeof languageSelects[number]){
  if(!accountId||!languageReady||savingLanguage||languageLocked()){syncLanguageControls();return;}
  const control=$<HTMLSelectElement>(id),next=normalizeLanguage(control.value);
  const previous=control.dataset.confirmedLanguage??preferredLanguage,previousAccountLanguage=preferredLanguage,stamp=++languageVersion,selection=selectionVersion;
  savingLanguage=true;setUiLanguage(next);syncLanguageControls();notice('正在保存讲解语言…');
  try{
    await api('settings.update',{explanation_language:next});
    const saved=await api('settings.get');if(stamp!==languageVersion)return;
    if(normalizeLanguage(saved.explanation_language)!==next)throw Error('LANGUAGE_NOT_CONFIRMED');
    preferredLanguage=next;
    if(selection===selectionVersion){control.value=next;control.dataset.confirmedLanguage=next;}
    if(id==='explanationLanguage'){pendingSubmit=null;await sessionState.remove('pending_submit').catch(()=>{});}
    if(stamp!==languageVersion)return;
    setUiLanguage(next);publishUiLanguage();notice('讲解语言已保存：{language}。',()=>({language:tr(languageNames[next])}));
  }catch(error){
    if(stamp===languageVersion){if(selection===selectionVersion)control.value=previous;setUiLanguage(previousAccountLanguage);notice('讲解语言未能确认保存，已恢复上次选择，请稍后重试。');}
  }finally{
    if(stamp===languageVersion){savingLanguage=false;usePreferredLanguage();syncLanguageControls();}
  }
}
function selectedLanguage(id:typeof languageSelects[number]){
  if(!languageReady||savingLanguage)throw Error('LANGUAGE_NOT_READY');
  return normalizeLanguage($<HTMLSelectElement>(id).value);
}
const privateImages=new PrivateImageUrls(recordId=>api('images.url',{record_id:recordId}),cloudUrl);
const historyList=new HistoryList<any>((query,offset)=>api('records.history',{query,offset}));
const speechMessages=new Map<string,UiBinding>();
function speechMessage(code:SpeechMessage,voiceLanguage?:string){
  const key=code==='voiceMissing'?'当前浏览器没有{language}语音。请在 Windows 语言设置中添加对应语音后重新打开侧栏。':code==='playFailed'?'发音未能播放，请检查声音或稍后重试。':'当前浏览器无法播放发音，请重新打开侧栏后重试。';
  const values=()=>({language:tr(voiceLanguage==='ja-JP'?'日语':'英语')});
  const text=tr(key,values());speechMessages.set(text,{key,values});return text;
}
const speech='speechSynthesis' in window?new WordSpeech(window.speechSynthesis,undefined,speechMessage):null;
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function fingerprint(value:any){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))));}
const para=(text:string,style?:string)=>{const p=document.createElement('p');p.textContent=text;p.lang='zh-CN';if(style)p.className=style;return p;};
const uiPara=(key:string,style?:string,values?:Values)=>bindUi(para('',style),key,values);
function explanationParagraph(text:string,language:ExplanationLanguage,style='ui-text'){
  const element=para(text,style);setLearningLanguage(element,language);return element;
}
function setLearningLanguage(element:HTMLElement,language:unknown){
  const lang=language==='ja'?'ja':language==='en'?'en':null;
  element.classList.toggle('learning-text',!!lang);
  element.classList.toggle('ui-text',!lang);
  element.lang=lang??'zh-CN';
}
function readingParagraph(text:string,language:unknown){
  const reading=para(text,'translation reading');
  if(language==='ja')setLearningLanguage(reading,'ja');
  else{reading.lang=language==='en'?'en':'zh-CN';reading.classList.add('reading-ipa');}
  return reading;
}
function pronunciationControl(text:string,reading:string,language:string,example=false){
  const button=document.createElement('button');button.className='pronounce';button.type='button';
  const icon=document.createElement('img');icon.src='assets/pronunciation.png';icon.alt='';icon.width=20;icon.height=20;button.append(icon);
  const playKey=example?'播放例句：{text}':'播放单词：{text}',stopKey=example?'停止例句：{text}':'停止单词：{text}';
  bindUi(button,playKey,{text},'aria-label');button.setAttribute('aria-pressed','false');bindUi(button,'点击播放，再次点击停止',undefined,'title');
  const status=para('','pronunciation-status sr-only');status.setAttribute('role','status');status.hidden=true;
  const update=(state:string,message?:string)=>{
    const playing=state==='loading'||state==='speaking';bindUi(button,playing?stopKey:playKey,{text},'aria-label');button.setAttribute('aria-pressed',String(playing));bindUi(button,playing?'再次点击停止':'点击播放',undefined,'title');
    status.className=`pronunciation-status ${state==='error'?'muted':'sr-only'}`;
    const binding=message?speechMessages.get(message):undefined;
    const key=binding?.key??(state==='error'?(message==='当前浏览器不支持发音。'?message:'发音未能播放，请检查声音或稍后重试。'):state==='loading'?'正在准备发音…':state==='speaking'?'正在播放…':state==='ended'?'已播放':'');
    bindUi(status,key,binding?.values);status.hidden=!key;
  };
  button.onclick=()=>{if(!speech){update('error','当前浏览器不支持发音。');return;}void speech.toggle(button,text,reading,language,update);};
  return {button,status};
}
function appendExampleText(container:HTMLElement,text:string,button:HTMLButtonElement){
  // Keep the speaker with the final word/characters instead of on an empty line.
  const tail=text.match(/(?:[\p{Script=Latin}\p{N}\p{M}'’-]+[.!?…。！？、，,;:]*|[^\s]{1,3})\s*$/u);
  if(!tail){container.append(document.createTextNode(text),button);return;}
  container.append(document.createTextNode(text.slice(0,tail.index)));
  const ending=document.createElement('span');ending.className='speech-tail';ending.append(document.createTextNode(tail[0]),button);container.append(ending);
}
function action(id:string,task:()=>Promise<unknown>){$(id).onclick=async()=>{
  const learning=languageButtons.has(id);if(learning&&(!languageReady||savingLanguage||languageLocked()))return;
  const token=learning?Symbol(id):null;if(token)preparingLearning=token;
  const b=$<HTMLButtonElement>(id);b.disabled=true;syncLanguageControls();
  try{await task();}catch(e){failure(e);}finally{if(token&&preparingLearning===token)preparingLearning=null;b.disabled=false;if(id==='saveKey'||id==='deleteKey')syncKeyControls();if(id==='modeFast'||id==='modeThinking')renderMode(confirmedMode);if(id==='saveReviewLimit')syncReviewLimitControls();if(!navigationButtons.has(id))usePreferredLanguage();syncLanguageControls();}
};}
function captureContent():ContentSnapshot{
  const fields=Object.fromEntries(['sourceText','corrected','retryText'].map(id=>[id,field(id).value]));
  const languages=Object.fromEntries(languageSelects.map(id=>{const control=$<HTMLSelectElement>(id);return [id,{value:control.value,confirmed:control.dataset.confirmedLanguage}];}));
  return {current,material,pendingSubmit,pendingImage,cropped,imagePreviousMaterial,stage:['composer','imageStage','recordSection'].find(id=>!$(id).hidden)??'composer',retryOpen:!$('retrySection').hidden,detailsOpen:$<HTMLDetailsElement>('recordDetails').open,draftDetailsOpen:$<HTMLDetailsElement>('draftDetails').open,progressSequence,progressRequest,preview:lastPreview,fields,languages,scroll:navigation.visibleView==='learn'?window.scrollY:activeContent.snapshot?.scroll??0};
}
function emptyContent():ContentSnapshot{return {current:null,material:{context:'',status:'unavailable',source:null,binding:null},pendingSubmit:null,pendingImage:null,cropped:null,imagePreviousMaterial:null,stage:'composer',retryOpen:false,detailsOpen:false,draftDetailsOpen:false,progressSequence:0,progressRequest:'',preview:null,fields:{sourceText:'',corrected:'',retryText:''},languages:Object.fromEntries(languageSelects.map(id=>[id,{value:preferredLanguage}])),scroll:0};}
function rememberVisibleScroll(){
  if(navigation.route==='history')historyList.rememberScroll(window.scrollY);
  else if(navigation.route==='settings')settingsScroll=window.scrollY;
  else activeContent.snapshot=captureContent();
}
function showRoute(route:PanelRoute,remember=true){
  if(remember)rememberVisibleScroll();if(route!=='learn'&&route!=='history-detail')speech?.stop();
  navigation.go(route);
  for(const item of ['learn','history','settings'])show(item+'View',item===navigation.visibleView);
  for(const [id,item] of [['learnTab','learn'],['historyTab','history'],['settingsTab','settings']]){
    const button=$(id),selected=item===navigation.selectedTab;button.classList.toggle('is-active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  }
  show('backToHistory',route==='history-detail');
  const scroll=route==='history'?historyList.state.scroll:route==='settings'?settingsScroll:activeContent.snapshot?.scroll??0,ticket=navigation.ticket();
  requestAnimationFrame(()=>{if(navigation.isCurrent(ticket))window.scrollTo({top:scroll});});
}
function view(name:string){showRoute(name==='learn'&&activeContent===historySlot?'history-detail':name as PanelRoute);}
function applyContent(snapshot:ContentSnapshot){
  releaseStoredImage();$<HTMLDetailsElement>('recordDetails').open=false;
  $<HTMLInputElement>('imageFile').value='';
  current=null;material=snapshot.material;pendingSubmit=snapshot.pendingSubmit;pendingImage=snapshot.pendingImage;cropped=snapshot.cropped;imagePreviousMaterial=snapshot.imagePreviousMaterial;
  lastPreview=null;progressSequence=0;progressRequest='';
  if(snapshot.current)render(snapshot.current);else{$('lesson').replaceChildren();show('editRecord',false);show('retryOcr',false);}
  for(const [id,value] of Object.entries(snapshot.fields))field(id).value=value;
  for(const [id,value] of Object.entries(snapshot.languages)){const control=$<HTMLSelectElement>(id);control.value=value.value;if(value.confirmed)control.dataset.confirmedLanguage=value.confirmed;else delete control.dataset.confirmedLanguage;}
  if(cropped)$<HTMLImageElement>('cropPreview').src=cropped;else $<HTMLImageElement>('cropPreview').removeAttribute('src');
  stage(snapshot.stage,false);show('retrySection',snapshot.retryOpen);$<HTMLDetailsElement>('draftDetails').open=snapshot.draftDetailsOpen;$<HTMLDetailsElement>('recordDetails').open=snapshot.detailsOpen;
  renderMaterial();
  if(snapshot.preview)renderProgress(snapshot.preview);else{progressSequence=snapshot.progressSequence;progressRequest=snapshot.progressRequest;}
  syncLanguageControls();
}
function switchContent(slot:ContentSlot){
  if(activeContent===slot)return;rememberVisibleScroll();activeContent.snapshot=captureContent();clearTimeout(debounce);++contextToken;++displayEpoch;++selectionVersion;speech?.stop();
  activeContent=slot;applyContent(slot.snapshot??emptyContent());
}
async function showHistoryList(){
  const refresh=historyList.needsRefresh&&(navigation.route==='learn'||navigation.route==='settings');rememberVisibleScroll();showRoute('history',false);notice();
  if(historyList.hasLoaded){
    if(refresh){const request=historyList.refresh();$<HTMLButtonElement>('more').disabled=true;try{if(!await request)return;}finally{$<HTMLButtonElement>('more').disabled=historyList.loading;}}
    renderHistory();const ticket=navigation.ticket();if(navigation.route==='history')requestAnimationFrame(()=>{if(navigation.isCurrent(ticket))window.scrollTo({top:historyList.state.scroll});});
  }
  else if(!historyList.loading)await history();
}
function stage(name:string,activate=true){for(const item of ['composer','imageStage','recordSection'])show(item,item===name);if(activate)view('learn');}
function link(id:string,source:any){const a=$<HTMLAnchorElement>(id);show(id,false);a.removeAttribute('href');if(!source?.url)return;try{const u=new URL(source.url);if(!['http:','https:'].includes(u.protocol))return;a.href=u.href;a.textContent=source.title||u.hostname;a.lang='zh-CN';show(id,true);}catch{}}
function renderMaterial(){
  bindUi('contextStatus',contexts[material.status]??contexts.unavailable);$('draftContext').textContent=material.context??'';$('draftContext').lang='zh-CN';link('draftSource',material.source);
  const meaningful=!!material.context?.trim()||!!material.source?.url||!!cropped||!!field('sourceText').value.trim()&&material.status!=='none';
  show('draftDetails',meaningful);if(!meaningful)$<HTMLDetailsElement>('draftDetails').open=false;
}
async function saveDraft(){if(activeContent!==workspaceSlot)return;await sessionState.set({panel_state:{view:'compose',text:field('sourceText').value,context:material.context,status:material.status,source:material.source},draft_binding:material.binding});}
async function resolveContext(text:string,forRecord=false){
  const token=++contextToken,binding=material.binding;
  if(forRecord&&!binding){material={...material,context:current?.context??'',status:current?.context_meta?.status??'none'};return;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=await Promise.race([call({kind:'context',text,binding:binding??undefined}),new Promise<any>(resolve=>{timer=setTimeout(()=>resolve({context:'',status:'timeout',binding,source:material.source}),1500);})]).finally(()=>clearTimeout(timer));if(token!==contextToken)return;
  material={...result,source:result.source??material.source};renderMaterial();if(!forRecord)await saveDraft();
}
function releaseImage(){cropped=null;pendingImage=null;imagePreviousMaterial=null;$<HTMLImageElement>('cropPreview').removeAttribute('src');$<HTMLInputElement>('imageFile').value='';}
function previewImage(image:string,nextMaterial:any,slot=activeContent){
  if(!retainedContent(slot))return;
  if(slot!==activeContent){const snapshot=slot.snapshot??emptyContent();snapshot.imagePreviousMaterial=snapshot.imagePreviousMaterial??snapshot.material;snapshot.cropped=image;snapshot.pendingImage=null;snapshot.material=nextMaterial;snapshot.stage='imageStage';slot.snapshot=snapshot;return;}
  const previous=imagePreviousMaterial??material;releaseImage();imagePreviousMaterial=previous;cropped=image;material=nextMaterial;$<HTMLImageElement>('cropPreview').src=image;stage('imageStage',false);if(contentVisible(slot))notice();
}
function releaseStoredImage(){privateImages.clear();imageRecord='';imageLoading=false;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;$<HTMLDialogElement>('imageDialog').close();for(const id of ['recordImage','fullImage'])$<HTMLImageElement>(id).removeAttribute('src');show('openImage',false);}
async function bindRecord(id:string){if(material.binding)await sessionState.set({['binding:'+id]:material.binding});}
function retainedContent(slot:ContentSlot){return slot.epoch===accountEpoch&&(slot===workspaceSlot||slot===historySlot);}
function contentRecord(slot:ContentSlot){return slot===activeContent?current:slot.snapshot?.current;}
function contentVisible(slot:ContentSlot){return slot===activeContent&&navigation.visibleView==='learn';}
function syncHistoryRecord(record:any){
  historyList.replace((item:any)=>item.record_id===record.record_id,{record_id:record.record_id,revision:record.revision,local_date:record.local_date,status:record.status,input_type:record.input_type,has_image:!!record.image,text:(record.corrected_text??record.recognized_text??record.original_text??'').slice(0,180)});
}
function updateRecord(slot:ContentSlot,record:any){
  if(!retainedContent(slot)||!record||deletedRecords.has(record.record_id))return;
  const previous=contentRecord(slot);if(previous?.record_id===record.record_id&&previous.revision>record.revision)return;syncHistoryRecord(record);
  if(slot===activeContent){if(current?.record_id!==record.record_id)++contextToken;if(record.input_type!=='image'||record.image)releaseImage();render(record);return;}
  const snapshot=slot.snapshot??emptyContent(),changed=previous?.record_id!==record.record_id||previous?.revision!==record.revision;
  snapshot.current=record;snapshot.stage='recordSection';
  if(record.input_type!=='image'||record.image){snapshot.cropped=null;snapshot.pendingImage=null;snapshot.imagePreviousMaterial=null;}
  if(changed){snapshot.retryOpen=false;snapshot.preview=null;snapshot.progressRequest='';snapshot.progressSequence=0;if(record.status==='awaiting_review'){snapshot.fields.corrected=record.corrected_text??record.recognized_text??'';snapshot.languages.reviewLanguage={value:preferredLanguage};}}
  if(record.status!=='processing')snapshot.preview=null;
  if(['saved','processing'].includes(record.status))for(const id of languageSelects)snapshot.languages[id]={value:normalizeLanguage(record.explanation_language)};
  slot.snapshot=snapshot;
}
async function openRecord(record:any,restoreBinding=false,slot=activeContent){
  if(!record||!retainedContent(slot))return;const epoch=accountEpoch;
  if(restoreBinding){
    const result=await sessionState.get('binding:'+record.record_id);if(epoch!==accountEpoch||!retainedContent(slot))return;
    const nextMaterial={context:record.context??'',status:record.context_meta?.status??'none',source:record.source,binding:result['binding:'+record.record_id]??null};
    if(slot===activeContent)material=nextMaterial;else{slot.snapshot??=emptyContent();slot.snapshot.material=nextMaterial;}
  }
  updateRecord(slot,record);
  if(slot===workspaceSlot&&retainedContent(slot))await sessionState.set({last_record_id:record.record_id,panel_state:{view:'record'}});
}
function render(record:any){
  if(!record||deletedRecords.has(record.record_id)||(current?.record_id===record.record_id&&record.revision<current.revision))return;const changed=current?.record_id!==record.record_id||current.revision!==record.revision;
  if(changed||record.status!=='processing'){progressSequence=0;progressRequest='';lastPreview=null;}
  if(current?.record_id!==record.record_id){releaseStoredImage();$<HTMLDetailsElement>('recordDetails').open=false;}
  current=record;stage('recordSection',false);bindUi('recordHeading',labels[record.status]??'学习笔记');$('recordHeading').dataset.status=record.status;
  bindUi('recordMeta','{date} · 修订 {revision} · 本次讲解：{language}',()=>({date:record.local_date,revision:record.revision,language:tr(languageNames[normalizeLanguage(record.explanation_language??record.result?.explanation_language)])}));
  $('recordOriginal').textContent=record.corrected_text??record.recognized_text??record.original_text??'';
  link('recordSource',record.source);
  show('cancelJob',['saved','processing'].includes(record.status));show('reviewSection',record.status==='awaiting_review');
  if(changed){++selectionVersion;show('retrySection',false);if(record.status==='awaiting_review'){field('corrected').value=record.corrected_text??record.recognized_text??'';$<HTMLSelectElement>('reviewLanguage').value=preferredLanguage;}}
  if(['saved','processing'].includes(record.status)){const language=normalizeLanguage(record.explanation_language);for(const id of languageSelects)$<HTMLSelectElement>(id).value=language;}
  syncLanguageControls();
  show('editRecord',['complete','failed','cancelled','interrupted'].includes(record.status));show('retryOcr',!!record.image&&['failed','cancelled','interrupted'].includes(record.status));
  const error=record.error?.code??record.error;show('recordError',!!error);bindUi('recordError',errors[error]??(error?'处理未完成。已保存材料仍可从历史查看。':''));
  show('imageState',record.input_type==='image');bindUi('imageState',record.image?'截图已保存在私有云端':'截图尚未确认保存，请保留原图。');
  renderLesson(record);
  if($<HTMLDetailsElement>('recordDetails').open)void loadStoredImage().catch(failure);
}
function renderLesson(record:any){
  const container=$('lesson');speech?.stop();container.replaceChildren();reviewMount=null;
  const language=record.result?.language;
  const explanationLanguage=normalizeLanguage(record.result?.explanation_language);
  setLearningLanguage($('recordOriginal'),language);
  const context=$('recordContext');unbindUi(context);context.replaceChildren();context.lang=uiLang();
  if(record.context){
    const prefix=document.createElement('span');prefix.className='ui-text';bindUi(prefix,'上下文：');
    const text=document.createElement('span');text.textContent=record.context;setLearningLanguage(text,language);
    context.append(prefix,text);
  }else bindUi(context,contexts[record.context_meta?.status??'none']??contexts.none);
  if(!record.result)return;
  if(record.status!=='complete'&&!record.preview)container.append(uiPara('上次完整讲解 · 本次生成尚未完成','muted'));
  container.append(explanationParagraph(record.result.summary_zh,explanationLanguage,'lesson-overview ui-text'));
  const reviewRows:ReviewMount['rows']=[];
  const points=[...(record.result.vocabulary??[]),...(record.result.grammar??[])];
  for(const [slot,point] of points.entries()){
    const block=document.createElement('article');block.className='point';
    const tag=uiPara(point.term?'词汇':'语法','point-label ui-text');
    const heading=document.createElement('h3');heading.lang='zh-CN';heading.className='ui-text';
    if(point.term){
      const term=document.createElement('span');term.className='term-text learning-title';term.textContent=point.term;setLearningLanguage(term,language);heading.append(term);
      if(point.pos){const pos=document.createElement('span');pos.className='part-of-speech ui-text';setLearningLanguage(pos,explanationLanguage);pos.textContent=' · '+point.pos;heading.append(pos);}
    }else{heading.textContent=point.point;setLearningLanguage(heading,explanationLanguage);}
    const top=document.createElement('div');top.className='point-top';top.append(tag);
    if(record.status==='complete'&&!record.preview){
      const button=document.createElement('button');button.type='button';button.className='mastery-toggle';button.hidden=true;button.disabled=true;button.dataset.slot=String(slot);button.setAttribute('aria-pressed','false');bindUi(button,'已记住');top.append(button);reviewRows.push({slot,button,expected:{kind:point.term?'vocabulary':'grammar',term:point.term??point.point,meaning:point.meaning??point.explanation,reading:point.term?(point.reading??''):'',pos:point.term?(point.pos??''):'',language,explanation_language:explanationLanguage}});
    }
    block.append(top,heading);
    if(point.term){
      const reading=readingParagraph(point.reading??'',language);
      const {button,status}=pronunciationControl(point.term,point.reading??'',language);reading.append(button);block.append(reading,status);
    }else if(point.reading)block.append(readingParagraph(point.reading,language));
    block.append(explanationParagraph(point.meaning??point.explanation,explanationLanguage));
    for(const example of point.examples??[]){
      const item=document.createElement('div');item.className='example';const original=para('','example-original');
      setLearningLanguage(original,language);
      const {button,status}=pronunciationControl(example.text,'',language,true);appendExampleText(original,example.text,button);
      item.append(original,status,explanationParagraph(example.translation,explanationLanguage,'translation learning-text'));block.append(item);
    }
    container.append(block);
  }
  if(reviewRows.length){
    const status=document.createElement('p');status.className='review-control-status';status.setAttribute('role','status');status.hidden=true;
    const statusText=document.createElement('span'),retry=document.createElement('button');retry.type='button';bindUi(retry,'重试复习状态');status.append(statusText,retry);container.append(status);
    const mount:ReviewMount={epoch:accountEpoch,recordId:record.record_id,revision:record.revision,loadVersion:0,rows:reviewRows,status,statusText,retry};reviewMount=mount;
    retry.onclick=()=>{void loadReviewPoints(mount);};void loadReviewPoints(mount);
  }
}
function reviewMountCurrent(mount:ReviewMount){return reviewMount===mount&&mount.epoch===accountEpoch&&current?.record_id===mount.recordId&&current?.revision===mount.revision&&current?.status==='complete'&&!deletedRecords.has(mount.recordId);}
function renderReviewPoint(mount:ReviewMount,row:ReviewMount['rows'][number]){
  const card=row.card;row.button.hidden=!card;row.button.disabled=!card||!!reviewMutation;
  if(!card)return;row.button.setAttribute('aria-pressed',String(card.mastered));row.button.dataset.pointKey=card.point_key;
  bindUi(row.button,card.mastered?'已记住 · 撤销':'已记住');row.button.onclick=()=>{void setRemembered(mount,row);};
}
async function loadReviewPoints(mount:ReviewMount){
  const stamp=++mount.loadVersion;
  try{
    await reviewMutation;if(!reviewMountCurrent(mount)||stamp!==mount.loadVersion)return;
    mount.retry.disabled=true;
    const result=await api('review.cards',{record_id:mount.recordId});if(!reviewMountCurrent(mount)||stamp!==mount.loadVersion)return;
    if(!Array.isArray(result.cards))throw Error('REVIEW_STATE_UNAVAILABLE');
    let mismatched=false;
    for(const row of mount.rows){
      const card=result.cards.find((value:any)=>value?.slot===row.slot);
      // The server can finish a re-explanation between records.get and this read.
      // Match every identity field, not only the slot, before enabling a control.
      const matches=card&&Object.entries(row.expected).every(([key,value])=>(key==='explanation_language'?normalizeLanguage(card[key]):['reading','pos'].includes(key)?card[key]??'':card[key])===value);
      row.card=card&&matches&&typeof card.id==='string'&&typeof card.point_key==='string'&&typeof card.mastered==='boolean'&&(!card.record_id||card.record_id===mount.recordId)?card:undefined;
      if(card&&!row.card)mismatched=true;
      renderReviewPoint(mount,row);
    }
    mount.status.hidden=!mismatched;if(mismatched){mount.retry.hidden=false;bindUi(mount.statusText,'学习点已更新，请刷新后重试。');}
  }catch{
    if(reviewMountCurrent(mount)&&stamp===mount.loadVersion){mount.status.hidden=false;mount.retry.hidden=false;bindUi(mount.statusText,'复习状态暂时无法读取。');}
  }finally{if(reviewMountCurrent(mount)&&stamp===mount.loadVersion)mount.retry.disabled=false;}
}
async function setRemembered(mount:ReviewMount,row:ReviewMount['rows'][number]){
  if(!reviewMountCurrent(mount)||reviewMutation||!row.card)return;
  const card=row.card,wanted=!card.mastered;const epoch=accountEpoch;++mount.loadVersion;
  const operation=(async()=>{
    try{
      const result=await api('review.mastery',{card_id:card.id,point_key:card.point_key,mastered:wanted});
      if(epoch!==accountEpoch)return;
      if(result.card?.point_key!==card.point_key||result.card?.mastered!==wanted)throw Error('REVIEW_STATE_UNAVAILABLE');
      if(reviewMountCurrent(mount)){
        for(const target of mount.rows)if(target.card?.point_key===card.point_key)target.card={...target.card,...result.card};
        mount.status.hidden=false;mount.retry.hidden=true;bindUi(mount.statusText,wanted?'已记住，以后不再安排这个学习点。':'已恢复这个学习点的复习安排。');
      }
    }catch(error:any){
      if(reviewMountCurrent(mount)){mount.status.hidden=false;mount.retry.hidden=false;bindUi(mount.statusText,['CARD_CHANGED','REVIEW_ITEM_NOT_FOUND'].includes(error?.code??error?.message)?'学习点已更新，请刷新后重试。':'掌握状态未能确认保存，请重试。');}
    }
  })();
  reviewMutation=operation;for(const target of mount.rows)renderReviewPoint(mount,target);bindUi(row.button,'正在保存…');
  await operation;
  if(reviewMutation===operation)reviewMutation=null;
  if(reviewMountCurrent(mount))for(const target of mount.rows)renderReviewPoint(mount,target);
}
function renderProgress(message:any){
  if(!message||!current||current.status!=='processing'||deletedRecords.has(message.record_id)||message.record_id!==current.record_id||message.revision!==current.revision||message.sequence<=progressSequence||(progressRequest&&progressRequest!==message.request_id))return;
  progressRequest=message.request_id;progressSequence=message.sequence;lastPreview=message;
  renderLesson({...current,result:message.preview,preview:true});bindUi('recordHeading','生成中 · 尚未保存完整讲解');
}
function updateProgress(slot:ContentSlot,message:any){
  if(!retainedContent(slot))return;if(slot===activeContent){renderProgress(message);return;}
  const snapshot=slot.snapshot,record=snapshot?.current;
  if(!snapshot||!record||record.status!=='processing'||deletedRecords.has(message.record_id)||message.record_id!==record.record_id||message.revision!==record.revision||message.sequence<=snapshot.progressSequence||(snapshot.progressRequest&&snapshot.progressRequest!==message.request_id))return;
  snapshot.progressRequest=message.request_id;snapshot.progressSequence=message.sequence;snapshot.preview=message;
}
async function loadStoredImage(){
  const record=current;if(!record?.image||imageLoading)return;imageLoading=true;$<HTMLButtonElement>('openImage').disabled=true;
  const epoch=accountEpoch;
  try{const signed=await privateImages.get(record.record_id);if(epoch!==accountEpoch||current?.record_id!==record.record_id)return;
    imageUrl=signed;imageRecord=record.record_id;$<HTMLImageElement>('recordImage').src=imageUrl;show('openImage',true);
  }finally{imageLoading=false;$<HTMLButtonElement>('openImage').disabled=false;}
}
async function newDraft(){
  rememberVisibleScroll();++displayEpoch;++selectionVersion;++contextToken;clearTimeout(debounce);speech?.stop();
  workspaceSlot={epoch:accountEpoch,snapshot:emptyContent()};activeContent=workspaceSlot;applyContent(workspaceSlot.snapshot!);showRoute('learn',false);notice();
  const slot=workspaceSlot;
  await sessionState.remove(['pending_submit','last_record_id']);if(retainedContent(slot)&&activeContent===slot)await saveDraft();
}
async function loadDraft(draft:any){if(!draft||draft.nonce===draftNonce)return;const epoch=accountEpoch;draftNonce=draft.nonce;const reset=newDraft(),slot=workspaceSlot;await reset;if(epoch!==accountEpoch||!retainedContent(slot)||activeContent!==slot)return;material={...draft,source:draft.source??null};field('sourceText').value=draft.text;syncLanguageControls();renderMaterial();await sessionState.set({last_draft_nonce:draftNonce});await saveDraft();}
async function runLearning(action:string,params:any,requestId:string,assertTarget=()=>{}){
  assertTarget();
  if(activeStream)throw Error('REQUEST_IN_PROGRESS');
  if(!await cloud.getSession())throw Error('LOGIN_REQUIRED');
  assertTarget();
  const epoch=accountEpoch,slot=activeContent,controller=new AbortController();
  const stream={recordId:params.record_id,requestId,controller};activeStream=stream;syncLanguageControls();
  const valid=()=>!controller.signal.aborted&&epoch===accountEpoch&&!deletedRecords.has(params.record_id);
  let mutationSignature='';
  const rememberMutation=(record:any)=>{if(!record)return;const signature=JSON.stringify([record.record_id,record.revision,record.status,record.corrected_text,record.recognized_text,record.result?.summary_zh]);if(signature!==mutationSignature){mutationSignature=signature;historyList.markDirty();}syncHistoryRecord(record);};
  const inform=(message='')=>{if(contentVisible(slot))notice(message);};
  try{
    const record=await cloud.start(action,params,requestId,async event=>{
      if(!valid())return;if(event.record)rememberMutation(event.record);
      if(event.type==='accepted'&&event.record){await openRecord(event.record,false,slot);inform(event.record.input_type==='image'&&!event.record.image?'正在保存截图…':'材料已保存到云端，正在生成…');}
      if(event.type==='progress')updateProgress(slot,event);
      if(event.type==='complete'&&event.record)updateRecord(slot,event.record);
      if(event.type==='error'&&event.record&&event.record.record_id===params.record_id&&['failed','interrupted','cancelled','complete','awaiting_review'].includes(event.record.status))updateRecord(slot,event.record);
    },{signal:controller.signal});
    if(valid()){rememberMutation(record);await openRecord(record,false,slot);inform(record.status==='complete'?'':record.status==='awaiting_review'?'截图已保存，请检查识别文字。':['failed','interrupted'].includes(record.status)?'本次处理未完成；重试可能再次产生 API 费用。':'已保存到云端。');}
  }catch(error){
    if(!valid())return;
    if(contentVisible(slot))failure(error); // Recover the same request by reading; never start a second model call.
    try{const record=await api('records.get',{record_id:params.record_id});if(valid()&&record){rememberMutation(record);await openRecord(record,false,slot);if(record.status==='complete')inform();else if(record.status==='cancelled')inform('已取消，已发生的 API 费用不保证撤回。');else if(record.status==='interrupted')inform(errors.RESULT_UNKNOWN);}}
    catch{ /* Keep the material and recovery ID while offline. */ }
  }finally{if(activeStream===stream)activeStream=null;syncLanguageControls();}
}
field('sourceText').addEventListener('input',()=>{pendingSubmit=null;++contextToken;clearTimeout(debounce);syncLanguageControls();renderMaterial();void saveDraft();debounce=setTimeout(()=>void resolveContext(field('sourceText').value).catch(failure),400);});
action('send',async()=>{
  const explanation_language=selectedLanguage('explanationLanguage'),epoch=accountEpoch,display=displayEpoch;
  const assertTarget=()=>{if(epoch!==accountEpoch||display!==displayEpoch)throw Error('INPUT_CHANGED');};
  const clicked=performance.now();notice('正在准备讲解…');
  const text=field('sourceText').value.trim();if(!text)throw new Error('EMPTY_TEXT');if(!hasLearningText(text)){notice('请输入要学习的英语或日语文字（日语可以只含汉字）；当前内容只有数字、符号或暂不支持的文字。');return;}
  if(pendingSubmit?.record_id){const saved=await api('records.get',{record_id:pendingSubmit.record_id});assertTarget();if(saved){await openRecord(saved,true);notice('已恢复上次保存的记录。');return;}}
  const feedback=performance.now()-clicked,contextStarted=performance.now();
  clearTimeout(debounce);await resolveContext(text);assertTarget();const contextMs=performance.now()-contextStarted;const timedOut=material.status==='timeout';const params={text,explanation_language,context:material.context??'',context_meta:{status:timedOut?'unavailable':material.status},source:material.source};const signature=await fingerprint(params);assertTarget();
  if(field('sourceText').value.trim()!==text)throw new Error('INPUT_CHANGED');
  if(!pendingSubmit||pendingSubmit.fingerprint!==signature)pendingSubmit={id:crypto.randomUUID(),record_id:crypto.randomUUID(),fingerprint:signature,params};
  await sessionState.set({pending_submit:pendingSubmit,last_record_id:pendingSubmit.record_id});assertTarget();await bindRecord(pendingSubmit.record_id);assertTarget();
  const request=pendingSubmit;void api('telemetry.record',{request_id:request.id,timings:{context_ms:contextMs,click_feedback_ms:feedback}}).catch(()=>{});
  await runLearning('learning.submit',{...request.params,record_id:request.record_id},request.id,assertTarget);
});
async function capture(){clearTimeout(debounce);++contextToken;const epoch=accountEpoch,slot=activeContent;notice('请在原网页拖动框选，Esc 取消。');const result=await call({kind:'capture',ui_language:uiLanguage});if(epoch!==accountEpoch)return;previewImage(result.image,{binding:result.binding,source:result.source,context:'',status:'unavailable'},slot);}
action('capture',capture);action('recapture',capture);action('filePick',async()=>{$<HTMLInputElement>('imageFile').click();});
$<HTMLInputElement>('imageFile').onchange=async()=>{clearTimeout(debounce);++contextToken;try{const file=$<HTMLInputElement>('imageFile').files?.[0];if(!file)return;if(file.size>12*1024*1024)throw new Error('IMAGE_TOO_LARGE');
  const epoch=accountEpoch,slot=activeContent,bitmap=await createImageBitmap(file);try{if(epoch!==accountEpoch||!retainedContent(slot))return;if(bitmap.width*bitmap.height>24000000)throw new Error('IMAGE_TOO_LARGE');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);const data=canvas.toDataURL('image/png');if(atob(data.split(',')[1]).length>4*1024*1024)throw new Error('IMAGE_TOO_LARGE');previewImage(data,{context:'',status:'none',source:null,binding:null},slot);}finally{bitmap.close();}
}catch(e){failure(e);}};
action('cancelImage',async()=>{const previous=imagePreviousMaterial;releaseImage();if(previous)material=previous;renderMaterial();stage(current?'recordSection':'composer');if(!current)await saveDraft();notice('已取消选图，未发送图片。');});
action('recognize',async()=>{
  const epoch=accountEpoch,display=displayEpoch,assertTarget=()=>{if(epoch!==accountEpoch||display!==displayEpoch)throw Error('INPUT_CHANGED');};
  if(!cropped)throw new Error('IMAGE_REGION_REQUIRED');const signature=await fingerprint({image:cropped,source:material.source});assertTarget();if(!pendingImage||pendingImage.signature!==signature)pendingImage={recordId:crypto.randomUUID(),requestId:crypto.randomUUID(),signature};
  const {recordId,requestId}=pendingImage;if(activeContent===workspaceSlot)await sessionState.set({last_record_id:recordId,panel_state:{view:'record'}});assertTarget();await bindRecord(recordId);assertTarget();
  await runLearning('learning.recognize',{record_id:recordId,image:cropped,source:material.source},requestId,assertTarget);
});
async function operation(method:string,text?:string){
  if(!current)throw Error('INPUT_CHANGED');
  const explanation_language=method==='learning.confirm'?selectedLanguage('reviewLanguage'):method==='learning.retry'?selectedLanguage('retryLanguage'):undefined;
  const target={recordId:current.record_id,revision:current.revision,account:accountEpoch,display:displayEpoch};
  const assertTarget=()=>{if(target.account!==accountEpoch||target.display!==displayEpoch||current?.record_id!==target.recordId||current?.revision!==target.revision)throw Error('INPUT_CHANGED');};
  if(text!==undefined)await resolveContext(text,true);assertTarget();
  const params={record_id:target.recordId,revision:target.revision,confirmed:true,...(explanation_language?{explanation_language}:{}),...(text!==undefined?{text,context:material.context??'',context_meta:{status:material.status??'none'}}:{})};
  const signature=await fingerprint({method,...params});assertTarget();
  const stored=await sessionState.get('pending_operation');assertTarget();const pending:any=stored.pending_operation;const id=pending?.signature===signature?pending.id:crypto.randomUUID();
  await sessionState.set({pending_operation:{id,signature,record_id:target.recordId}});assertTarget();
  await runLearning(method,params,id,assertTarget);
}
action('cancelJob',async()=>{const id=current.record_id,slot=activeContent;notice('正在请求取消…');try{const record=await api('learning.cancel',{record_id:id});if(activeStream&&activeStream.recordId===id)activeStream.controller.abort();if(contentRecord(slot)?.record_id===id)updateRecord(slot,record);if(contentVisible(slot))notice(record.status==='complete'?'讲解已先完成并保存。':'已取消，已发生的 API 费用不保证撤回。');}catch(error){if(contentVisible(slot))notice('取消尚未确认；请连接网络后重新检查。');throw error;}});
action('confirmText',()=>operation('learning.confirm',field('corrected').value));
action('editRecord',async()=>{++selectionVersion;field('retryText').value=current.corrected_text??current.recognized_text??current.original_text??'';const control=$<HTMLSelectElement>('retryLanguage');control.value=normalizeLanguage(current.result?current.result.explanation_language:current.explanation_language);control.dataset.confirmedLanguage=control.value;show('retrySection',true);syncLanguageControls();view('learn');field('retryText').focus();});
action('retryConfirm',()=>operation('learning.retry',field('retryText').value));
action('retryOcr',async()=>{if(window.confirm(tr('重新识别将发送已保存图片，可能再次产生 API 费用。继续吗？')))await operation('learning.recognizeRetry');});
$<HTMLDetailsElement>('recordDetails').addEventListener('toggle',()=>{if($<HTMLDetailsElement>('recordDetails').open)void loadStoredImage().catch(failure);});
action('openImage',async()=>{const id=current?.record_id;await loadStoredImage();if(imageUrl&&current?.record_id===id){$<HTMLImageElement>('fullImage').src=imageUrl;$<HTMLDialogElement>('imageDialog').showModal();}});action('closeImage',async()=>$<HTMLDialogElement>('imageDialog').close());
function historyDateLabel(date:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??''))return tr('日期未知');
  const dateKey=(value:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const now=new Date(),today=dateKey(now),yesterday=dateKey(new Date(now.getTime()-86400000));
  if(date===today)return tr('今天');
  if(date===yesterday)return tr('昨天');
  const value=new Date(date+'T00:00:00Z');
  if(!Number.isFinite(value.getTime()))return tr('日期未知');
  return new Intl.DateTimeFormat(uiLang(),{timeZone:'UTC',month:uiLanguage==='en'?'short':'long',day:'numeric',...(date.slice(0,4)!==today.slice(0,4)?{year:'numeric' as const}:{})}).format(value);
}
function historyIcon(name:'trash'|'image'){
  const icon=document.createElement('img');icon.src=`assets/ui/${name}.svg`;icon.alt='';icon.setAttribute('aria-hidden','true');return icon;
}
async function openHistoryRecord(id:string){
  if(navigation.route!=='history')return;
  rememberVisibleScroll();navigation.go('history');const ticket=navigation.ticket(),epoch=accountEpoch;
  const record=await api('records.get',{record_id:id});
  if(epoch!==accountEpoch||!navigation.isCurrent(ticket)||navigation.route!=='history')return;
  if(!record){await forgetDeleted(id);renderHistory();notice(errors.RECORD_NOT_FOUND);return;}
  const slot=historySlot&&contentRecord(historySlot)?.record_id===id?historySlot:{epoch:accountEpoch,snapshot:emptyContent()};historySlot=slot;
  await openRecord(record,true,slot);
  if(epoch!==accountEpoch||!navigation.isCurrent(ticket)||navigation.route!=='history'||historySlot!==slot)return;
  switchContent(slot);showRoute('history-detail',false);notice();
}
function renderHistory(){
  $('historyList').replaceChildren();const result=historyList.state,groups=new Map<string,HTMLElement>();
  for(const item of result.items){
      let items=groups.get(item.local_date);
      if(!items){
        const group=document.createElement('section');group.className='history-group';
        const heading=document.createElement('h3');heading.className='history-date';heading.dataset.date=item.local_date;
        heading.id=`history-date-${groups.size}`;bindUi(heading,'{date}',()=>({date:historyDateLabel(item.local_date)}));group.setAttribute('aria-labelledby',heading.id);
        items=document.createElement('div');items.className='history-items';group.append(heading,items);groups.set(item.local_date,items);$('historyList').append(group);
      }
      const row=document.createElement('div');row.className='history-row';
      const button=document.createElement('button');button.type='button';button.className='history-card';
      const title=document.createElement('span'),text=item.text||item.corrected_text||item.recognized_text||item.original_text;
      title.className='history-text';
      if(text){title.textContent=text;title.title=text;setLearningLanguage(title,item.language??item.result?.language);}else bindUi(title,'截图笔记');button.append(title);
      const metadata=document.createElement('span');metadata.className='history-meta';
      if(item.has_image||item.input_type==='image'){
        const imageLabel=document.createElement('span');imageLabel.className='history-image-label';
        const caption=document.createElement('span');bindUi(caption,'历史截图');imageLabel.append(historyIcon('image'),caption);metadata.append(imageLabel);
      }
      if(item.status!=='complete'){
        const status=document.createElement('span');status.className='history-status';bindUi(status,labels[item.status]??'状态未知');metadata.append(status);
      }
      if(metadata.childElementCount)button.append(metadata);
      button.onclick=async()=>{try{await openHistoryRecord(item.record_id);}catch(e){failure(e);}};
      const remove=document.createElement('button');remove.type='button';remove.className='delete-record';remove.append(historyIcon('trash'));bindUi(remove,'删除',undefined,'title');bindUi(remove,'删除 {text}',()=>({text:text||tr('截图笔记')}),'aria-label');
      remove.onclick=async()=>{
        if(!window.confirm(tr('删除这条云端记录及截图，并移出后续复习？已经发送的通知和已有备份不会撤回。')))return;
        remove.disabled=true;
        try{const record=await api('records.get',{record_id:item.record_id});if(record)await api('records.delete',{record_id:item.record_id,revision:record.revision,confirmed:true});if(activeStream&&activeStream.recordId===item.record_id)activeStream.controller.abort();await forgetDeleted(item.record_id);renderHistory();if(navigation.route==='history')notice('已从云端历史和后续复习移除。');}catch(e){failure(e);remove.disabled=false;}
      };
      row.append(button,remove);items.append(row);
  }
  show('more',result.has_more);if(!result.items.length)$('historyList').append(uiPara('还没有匹配的记录。','muted'));
}
async function history(reset=true){
  const request=historyList.load(field('search').value,!reset,window.scrollY);$<HTMLButtonElement>('more').disabled=historyList.loading;
  try{if(!await request)return;renderHistory();if(navigation.route==='history')window.scrollTo({top:historyList.state.scroll});
  }finally{$<HTMLButtonElement>('more').disabled=historyList.loading;}
}
function clearPendingRecord(id:string){
  const clear=(content:Pick<ContentSnapshot,'pendingSubmit'|'pendingImage'>)=>{if(content.pendingSubmit?.record_id===id)content.pendingSubmit=null;if(content.pendingImage?.recordId===id)content.pendingImage=null;};
  const visible={pendingSubmit,pendingImage};clear(visible);({pendingSubmit,pendingImage}=visible);
  for(const slot of [workspaceSlot,historySlot])if(slot?.snapshot)clear(slot.snapshot);
}
async function forgetDeleted(id:string){
  deletedRecords.add(id);historyList.remove((item:any)=>item.record_id===id);clearPendingRecord(id);
  let resetWorkspace:ContentSlot|null=null;
  if(contentRecord(workspaceSlot)?.record_id===id){
    const old=workspaceSlot;workspaceSlot={epoch:accountEpoch,snapshot:emptyContent()};resetWorkspace=workspaceSlot;
    if(activeContent===old){++displayEpoch;++selectionVersion;++contextToken;clearTimeout(debounce);activeContent=workspaceSlot;applyContent(workspaceSlot.snapshot!);}
  }
  if(historySlot&&contentRecord(historySlot)?.record_id===id){
    const old=historySlot;historySlot=null;if(activeContent===old){switchContent(workspaceSlot);if(navigation.route==='history-detail')showRoute('history',false);}
  }
  const saved:any=await sessionState.get(['last_record_id','pending_submit','pending_operation']);
  const keys:string[]=[];if(saved.last_record_id===id)keys.push('last_record_id');if(saved.pending_submit?.record_id===id)keys.push('pending_submit');
  if(saved.pending_operation?.record_id===id)keys.push('pending_operation');
  await sessionState.remove(keys);await sessionState.remove('binding:'+id);
  if(resetWorkspace&&workspaceSlot===resetWorkspace){
    const draft=activeContent===resetWorkspace?captureContent():resetWorkspace.snapshot;
    if(draft&&!draft.current&&!draft.pendingSubmit&&!draft.pendingImage)await sessionState.set({panel_state:{view:'compose',text:draft.fields.sourceText,context:draft.material.context,status:draft.material.status,source:draft.material.source},draft_binding:draft.material.binding});
  }
}
action('learnTab',async()=>{
  const reset=newDraft(),slot=workspaceSlot;await reset;
  if(retainedContent(slot)&&activeContent===slot&&navigation.route==='learn')field('sourceText').focus();
});action('historyTab',showHistoryList);action('backToHistory',showHistoryList);action('searchButton',()=>history());action('more',()=>history(false));field('search').onkeydown=e=>{if(e.key==='Enter')void history().catch(failure);};
field('search').addEventListener('input',()=>{if(!field('search').value.trim())void history().catch(failure);});
async function restorePanel(){
  const epoch=accountEpoch,slot=workspaceSlot;
  const saved:any=await sessionState.get(),selection:any=await chrome.storage.session.get('draft');
  if(epoch!==accountEpoch||!retainedContent(slot))return;
  draftNonce=saved.last_draft_nonce??'';const pending=saved.pending_submit??null;
  if(activeContent===slot)pendingSubmit=pending;else{slot.snapshot??=emptyContent();slot.snapshot.pendingSubmit=pending;}
  if(selection.draft&&selection.draft.nonce!==draftNonce){await loadDraft(selection.draft);return;}
  const restoreCompose=(text:string,nextMaterial:any)=>{if(!retainedContent(slot))return;if(activeContent===slot){field('sourceText').value=text;material=nextMaterial;renderMaterial();}else{slot.snapshot??=emptyContent();slot.snapshot.fields.sourceText=text;slot.snapshot.material=nextMaterial;}};
  if(saved.panel_state?.view==='compose'&&!pending){restoreCompose(saved.panel_state.text??'',{...saved.panel_state,binding:saved.draft_binding??null});return;}
  if(accountId&&saved.last_record_id){const record=await api('records.get',{record_id:saved.last_record_id});if(!retainedContent(slot))return;if(record){await openRecord(record,true,slot);return;}if(contentVisible(slot))notice('上次发送未确认保存，请检查材料后重试。');}
  if(pending?.params)restoreCompose(pending.params.text??'',{...pending.params,status:pending.params.context_meta?.status??'unavailable',binding:saved.draft_binding??null});else if(activeContent===slot)renderMaterial();
}
async function changeAccount(session:CloudSession|null){
  const next=session?.user.id??null;if(accountId===next)return;
  const old=accountId,wasSettings=navigation.route==='settings';accountId=next;++accountEpoch;++displayEpoch;++contextToken;
  ++languageVersion;++selectionVersion;savingLanguage=false;languageReady=false;preferredLanguage='zh';preparingLearning=null;setUiLanguage('zh');publishUiLanguage();
  for(const id of languageSelects){$<HTMLSelectElement>(id).value='zh';delete $<HTMLSelectElement>(id).dataset.confirmedLanguage;}
  ++fontVersion;savingFont=false;fontReady=false;confirmedFontTheme='refined';renderFont('refined');bindUi('fontState','更改后自动保存');
  ++diagnosisVersion;++keyMutationVersion;savingKey=false;keyConfigured=null;keyLastFour='';keyEditorTouched=false;$<HTMLDetailsElement>('keyEditor').open=false;renderKeyState();syncKeyControls();
  ++modeVersion;savingMode=false;confirmedMode='fast';renderMode('fast');bindUi('modeSaveState','');
  ++reviewLimitVersion;savingReviewLimit=false;reviewLimitReady=false;reviewLimitDirty=false;confirmedReviewLimit=5;field('reviewDailyLimit').value='5';bindUi('reviewLimitState','');syncReviewLimitControls();reviewMount=null;reviewMutation=null;
  activeStream?.controller.abort();activeStream=null;clearTimeout(debounce);speech?.stop();
  current=null;pendingSubmit=null;draftNonce='';material={context:'',status:'unavailable',source:null,binding:null};deletedRecords.clear();historyList.clear();
  navigation.clear();workspaceSlot={epoch:accountEpoch,snapshot:null};historySlot=null;activeContent=workspaceSlot;settingsScroll=0;lastPreview=null;progressSequence=0;progressRequest='';
  syncLanguageControls();
  releaseStoredImage();releaseImage();field('sourceText').value='';field('search').value='';field('apiKey').value='';field('password').value='';
  $('historyList').replaceChildren();$('lesson').replaceChildren();show('editRecord',false);show('retryOcr',false);show('retrySection',false);field('corrected').value='';field('retryText').value='';stage('composer',false);renderMaterial();showRoute(wasSettings?'settings':'learn',false);notice();
  await sessionState.switchOwner(next,old!==undefined);if(old)await chrome.storage.session.remove('draft');
  show('loginFields',!session);show('keyFields',!!session);show('modeFields',!!session);show('reviewSettings',!!session);show('fontFields',!!session);show('signOut',!!session);renderMode('fast');
  renderConnection(session?.user.email??null,'尚未确认云端连接');
  if(!next&&old)view('settings');
  if(old===undefined||next)await restorePanel();
  if(next)await Promise.all([refreshFontTheme(),refreshExplanationLanguage(),refreshReviewLimit()]);
}
let accountChange=Promise.resolve();
function scheduleAccount(session:CloudSession|null){accountChange=accountChange.catch(()=>{}).then(()=>changeAccount(session));return accountChange;}
cloud.onAuthChange(session=>{void scheduleAccount(session).catch(failure);});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes['lingo-session:'+cloudUrl])void cloud.getSession().then(scheduleAccount).catch(failure);
  if(area==='session'&&changes.draft?.newValue)void loadDraft(changes.draft.newValue).catch(failure);
});
function renderConnection(email:string|null,status:string){
  unbindUi($('connectionState'));
  $('connectionState').replaceChildren(...(email?[para(email,'account-email'),uiPara(status,'connection-status muted')]:[uiPara('登录后，笔记将保存在你的私有云端。','connection-status muted')]));
}
function renderKeyAction(){bindUi('keyEditorAction',$<HTMLDetailsElement>('keyEditor').open?'收起':keyConfigured===true?'更新':'配置');}
function renderKeyState(){
  bindUi('keyState',keyConfigured===null?'尚未确认':keyConfigured?'已配置':'未配置');
  bindUi('keyDetail',keyConfigured===null?'未能确认配置状态，请检查连接后重试。':keyConfigured&&keyLastFour?'尾号 {text}':'',{text:keyLastFour});
  show('deleteKey',keyConfigured===true);renderKeyAction();
}
function syncKeyControls(){for(const id of ['saveKey','deleteKey'])$<HTMLButtonElement>(id).disabled=savingKey||!accountId;}
// Track deliberate disclosure changes separately from programmatic status updates.
$('keyEditor').querySelector('summary')!.addEventListener('click',()=>{keyEditorTouched=true;});
$('keyEditor').addEventListener('toggle',renderKeyAction);
async function diagnose():Promise<boolean|null>{
  const initialEpoch=accountEpoch,session=await cloud.getSession();if(initialEpoch!==accountEpoch)return null;
  await scheduleAccount(session);if(!session||session.user.id!==accountId)return null;
  const epoch=accountEpoch,stamp=++diagnosisVersion,keyStamp=keyMutationVersion,modeStamp=modeVersion,limitStamp=reviewLimitVersion;
  const valid=()=>epoch===accountEpoch&&stamp===diagnosisVersion&&keyStamp===keyMutationVersion;
  renderConnection(session.user.email??'Lingo Notes','正在检查云端连接…');
  try{
    const [,key,settings]=await Promise.all([api('ping'),api('key.status'),api('settings.get'),refreshFontTheme(),refreshExplanationLanguage()]);
    if(!valid())return null;
    if(typeof key?.configured!=='boolean')throw Error('KEY_UNAVAILABLE');
    const wasUnknown=keyConfigured===null;keyConfigured=key.configured;keyLastFour=typeof key.last_four==='string'&&/^[\w-]{4}$/.test(key.last_four)?key.last_four:'';
    if(!keyConfigured)$<HTMLDetailsElement>('keyEditor').open=true;
    else if(wasUnknown&&!keyEditorTouched&&!savingKey)$<HTMLDetailsElement>('keyEditor').open=false;
    renderKeyState();renderConnection(session.user.email??'Lingo Notes','云端连接正常');
    if(modeStamp===modeVersion&&!savingMode){confirmedMode=settings.explanation_mode==='thinking'?'thinking':'fast';renderMode(confirmedMode);}
    if(limitStamp===reviewLimitVersion&&!savingReviewLimit)readReviewLimit(settings);
    return keyConfigured;
  }catch(error){
    if(!valid())return null;
    keyConfigured=null;keyLastFour='';renderKeyState();renderConnection(session.user.email??'Lingo Notes','未能确认云端连接，请稍后重试。');throw error;
  }
}
function renderMode(mode:string){
  for(const [id,value] of [['modeFast','fast'],['modeThinking','thinking']]){$(id).setAttribute('aria-pressed',String(value===mode));$(id).classList.toggle('primary',value===mode);$<HTMLButtonElement>(id).disabled=savingMode||!accountId;}
  bindUi('modeState',mode==='thinking'?'等待更久，用量较多。':'等待更短，用量较少。');
}
async function saveMode(mode:'fast'|'thinking'){
  if(savingMode||!accountId)return;
  const stamp=++modeVersion,epoch=accountEpoch,previous=confirmedMode,valid=()=>stamp===modeVersion&&epoch===accountEpoch;
  savingMode=true;renderMode(previous);bindUi('modeSaveState','正在保存讲解模式…');
  try{
    await api('settings.update',{explanation_mode:mode});if(!valid())return;
    const settings=await api('settings.get');if(!valid())return;
    if(settings.explanation_mode!==mode)throw Error('MODE_NOT_CONFIRMED');
    confirmedMode=mode;renderMode(mode);bindUi('modeSaveState','已保存');
  }catch(error){if(valid()){renderMode(previous);bindUi('modeSaveState','讲解模式未能确认保存，已恢复上次显示。');}}
  finally{if(valid()){savingMode=false;renderMode(confirmedMode);}}
}
action('modeFast',()=>saveMode('fast'));action('modeThinking',()=>saveMode('thinking'));
function syncReviewLimitControls(){for(const id of ['reviewDailyLimit','saveReviewLimit'])$<HTMLInputElement>(id).disabled=savingReviewLimit||!reviewLimitReady||!accountId;}
function readReviewLimit(settings:any){
  const value=settings.review_daily_limit??5;if(!Number.isInteger(value)||value<1||value>100)throw Error('INVALID_SETTINGS');
  confirmedReviewLimit=value;reviewLimitReady=true;if(!reviewLimitDirty)field('reviewDailyLimit').value=String(value);syncReviewLimitControls();
}
async function refreshReviewLimit(){
  if(!accountId||savingReviewLimit||reviewLimitDirty)return;const stamp=reviewLimitVersion,epoch=accountEpoch;
  try{const settings=await api('settings.get');if(stamp===reviewLimitVersion&&epoch===accountEpoch)readReviewLimit(settings);}
  catch{if(stamp===reviewLimitVersion&&epoch===accountEpoch){bindUi('reviewLimitState','未能读取复习数量，请检查连接。');syncReviewLimitControls();}}
}
field('reviewDailyLimit').addEventListener('input',()=>{reviewLimitDirty=true;++reviewLimitVersion;bindUi('reviewLimitState','');});
action('saveReviewLimit',async()=>{
  if(!accountId||savingReviewLimit||!reviewLimitReady)return;
  const raw=field('reviewDailyLimit').value.trim(),value=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isInteger(value)||value<1||value>100){bindUi('reviewLimitState','请输入 1–100 的整数。');field('reviewDailyLimit').focus();return;}
  const epoch=accountEpoch,stamp=++reviewLimitVersion,valid=()=>epoch===accountEpoch&&stamp===reviewLimitVersion;
  savingReviewLimit=true;syncReviewLimitControls();bindUi('reviewLimitState','正在保存复习数量…');
  try{await api('settings.update',{review_daily_limit:value});if(!valid())return;const settings=await api('settings.get');if(!valid())return;if(settings.review_daily_limit!==value)throw Error('REVIEW_LIMIT_NOT_CONFIRMED');reviewLimitDirty=false;readReviewLimit(settings);bindUi('reviewLimitState','复习数量已保存。');}
  catch{if(valid())bindUi('reviewLimitState','复习数量未能确认保存，请重试。');}
  finally{if(valid()){savingReviewLimit=false;syncReviewLimitControls();}}
});
$<HTMLSelectElement>('fontTheme').onchange=()=>{void saveFontTheme(normalizeFontTheme($<HTMLSelectElement>('fontTheme').value));};
for(const id of languageSelects)$<HTMLSelectElement>(id).onchange=()=>{void saveExplanationLanguage(id);};
action('signIn',async()=>{
  const email=field('email').value.trim(),password=field('password').value;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){notice('请输入有效邮箱。');field('email').focus();return;}
  if(!password){notice('请输入密码。首次使用请先通过学习中心一次性链接设置密码。');field('password').focus();return;}
  field('password').value='';
  await cloud.signIn(email,password);await accountChange;await diagnose();notice('登录成功。');
});
for(const id of ['email','password'])field(id).addEventListener('keydown',event=>{
  if(event.key==='Enter'){event.preventDefault();$<HTMLButtonElement>('signIn').click();}
});
action('signOut',async()=>{await cloud.signOut();await accountChange;view('settings');notice('已退出登录，并清除本设备的草稿和浏览缓存。');});
async function mutateKey(remove=false){
  if(savingKey||!accountId)return;
  const input=field('apiKey'),key=remove?'':input.value.trim();
  if(!remove&&!key){notice('请输入 DeepSeek API Key。');return;}
  if(remove&&!window.confirm(tr('移除已保存的 DeepSeek Key？已有笔记和复习仍会保留。')))return;
  const epoch=accountEpoch,stamp=++keyMutationVersion,valid=()=>epoch===accountEpoch&&stamp===keyMutationVersion;
  ++diagnosisVersion;savingKey=true;keyConfigured=null;keyLastFour='';renderKeyState();syncKeyControls();$<HTMLDetailsElement>('keyEditor').open=true;keyEditorTouched=true;
  try{
    await api(remove?'key.delete':'key.save',remove?{}:{key});if(!valid())return;
    const configured=await diagnose();if(!valid())return;
    if(configured!==!remove)throw Error('KEY_UNAVAILABLE');
    $<HTMLDetailsElement>('keyEditor').open=remove;renderKeyAction();
    notice(remove?'已移除 Key。':'Key 已加密保存，模型费用由 DeepSeek 直接收取。');
  }catch(error){if(valid()){$<HTMLDetailsElement>('keyEditor').open=true;renderKeyAction();throw error;}}
  finally{if(valid()){input.value='';savingKey=false;syncKeyControls();}}
}
action('saveKey',()=>mutateKey());action('deleteKey',()=>mutateKey(true));
action('settingsTab',async()=>{view('settings');await diagnose();});action('diagnose',diagnose);
const port=chrome.runtime.connect({name:'learning-panel'});
port.onMessage.addListener(message=>{if(message.event==='draft.changed')void loadDraft(message.draft).catch(failure);});
// Only recover by reading. Never replay a model POST when the stream or sidebar closes.
setInterval(async()=>{
  if(polling||activeStream||!accountId)return;polling=true;const epoch=accountEpoch;
  try{for(const slot of [workspaceSlot,historySlot]){
    if(!slot||!retainedContent(slot))continue;const previous=contentRecord(slot);if(!previous||!['saved','processing'].includes(previous.status))continue;
    const id=previous.record_id,record=await api('records.get',{record_id:id});if(epoch!==accountEpoch)return;if(!retainedContent(slot)||contentRecord(slot)?.record_id!==id)continue;
    if(!record){await forgetDeleted(id);continue;}updateRecord(slot,record);if(contentVisible(slot)){if(record.status==='complete')notice();else if(record.status==='interrupted')notice(errors.RESULT_UNKNOWN);}
  }}catch(e){failure(e);}finally{polling=false;}
},3000);
window.addEventListener('pagehide',()=>{field('password').value='';speech?.stop();activeStream?.controller.abort();});
const refreshPreferences=()=>{if(document.visibilityState!=='hidden')void cloud.getSession().then(scheduleAccount).then(()=>Promise.all([refreshFontTheme(),refreshExplanationLanguage(),refreshReviewLimit(),reviewMount?loadReviewPoints(reviewMount):Promise.resolve()])).catch(failure);};
window.addEventListener('focus',refreshPreferences);document.addEventListener('visibilitychange',refreshPreferences);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){speech?.stop();void call({kind:'capture.cancel'}).catch(()=>{});}});
void(async()=>{try{await scheduleAccount(await cloud.getSession());}catch(e){failure(e);}})();
