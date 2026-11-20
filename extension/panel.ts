import {hasLearningText} from './learning-ui';
import {HistoryList} from './history';
import {WordSpeech} from './speech';
import {PanelSessionState, PrivateImageUrls} from './panel-cloud';
import {createCloudClient, type CloudSession} from '../shared/cloud-client';
import {applyFontTheme, FONT_THEMES, normalizeFontTheme, type FontTheme} from '../shared/typography/theme';
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
const labels:Record<string,string>={saved:'已保存到云端',processing:'已保存 · 处理中',awaiting_review:'检查识别文字',complete:'学习笔记',failed:'处理失败',interrupted:'已中断 · 结果未知',cancelled:'已取消'};
const contexts:Record<string,string>={matched:'已从原网页获取前后句',truncated:'已获取附近句子，较长内容已截短',not_found:'原网页中未找到匹配文字，将仅按输入讲解',ambiguous:'原网页中有多处匹配，未自动选用上下文',unavailable:'无法读取原页面，将仅按输入讲解',none:'未附加网页上下文'};
contexts.timeout='获取上下文超时，本次仅按输入讲解';
const errors:Record<string,string>={LOGIN_REQUIRED:'请在“连接与设置”登录 Lingo Notes。',AUTH_EXPIRED:'登录已过期，请重新登录；不会自动重新发送讲解。',AUTH_FAILED:'邮箱或密码不正确，或账号尚未开通。',AUTH_UNAVAILABLE:'登录服务暂时不可用，请稍后重试。',CLOUD_NOT_CONFIGURED:'此安装包尚未配置云端连接。',KEY_REQUIRED:'请先在“连接与设置”保存 DeepSeek API Key。',NETWORK_ERROR:'网络不可用，尚未确认云端结果；请连接网络后从历史查看。',RATE_LIMITED:'请求较多，请稍后重试。',STREAM_INTERRUPTED:'连接中断，正在核对云端结果；不会自动重新发送。',REQUEST_DISCONNECTED:'连接已断开，正在核对云端结果。',CAPTURE_RESTRICTED:'此页面无法截图。请在普通网页点击扩展图标后重试，或选择图片。',TAB_CHANGED:'标签页已切换，选区已取消。',VIEWPORT_CHANGED:'页面位置或大小已变化，选区已取消。',CAPTURE_CANCELLED:'已取消截图，未发送图片。',EMPTY_TEXT:'请先选择或输入文字。',IMAGE_TOO_LARGE:'图片过大，请选择较小区域（不超过 4 MB）。',REVISION_CONFLICT:'记录已更新，请从历史重新打开。',INPUT_CHANGED:'输入内容已改变，请确认后重新点击讲解。',REQUEST_IN_PROGRESS:'请等待当前请求结束或先取消。',RECORD_BUSY:'这条记录仍在处理，请稍后查看。',RESULT_UNKNOWN:'未能确认完整结果；重新讲解可能再次产生 API 费用。'};
Object.assign(errors,{DEEPSEEK_KEY_REQUIRED:errors.KEY_REQUIRED,DEEPSEEK_KEY_INVALID:'DeepSeek Key 未通过验证，请在“连接与设置”更新。',DEEPSEEK_BALANCE_INSUFFICIENT:'DeepSeek 账户余额不足，请在厂商处检查额度。',DEEPSEEK_RATE_LIMIT:'DeepSeek 暂时限流，请稍后手动重试。',KEY_UNAVAILABLE:'暂时无法读取已保存的 Key，请稍后检查连接。',INVALID_API_KEY:'Key 格式不正确，请检查后重新填写。',REQUEST_INTERRUPTED_RESULT_UNKNOWN:errors.RESULT_UNKNOWN,REQUEST_FAILED_RESULT_UNKNOWN:errors.RESULT_UNKNOWN,MODEL_OUTPUT_INCOMPLETE:'模型未返回完整讲解；材料已保存，重试可能再次产生 API 费用。',INVALID_LESSON:'本次讲解未通过完整性检查；材料已保存，可手动重新讲解。',CANCELLED_REQUEST_MAY_HAVE_BEEN_SENT:'请求已取消；已发生的 API 费用不保证撤回。',REQUEST_NOT_ACTIVE:'本次请求已结束，请从历史查看最终状态。',IMAGE_NOT_SAVED:'截图未成功保存，请重新框选或选择图片。',IMAGE_NOT_FOUND:'截图暂时无法读取，请刷新记录后再试。',IMAGE_URL_INVALID:'截图链接校验未通过，请重新读取。',RECORD_NOT_FOUND:'这条记录已不存在，请刷新历史。'});
let current:any=null,material:any={context:'',status:'unavailable',source:null,binding:null},draftNonce='';
let accountId:string|null|undefined,accountEpoch=0,displayEpoch=0;
let fontTheme:FontTheme='clean',confirmedFontTheme:FontTheme='clean',fontVersion=0,savingFont=false,fontReady=false;
let activeStream:{recordId:string,requestId:string,controller:AbortController}|null=null;
const sessionState=new PanelSessionState(chrome.storage.session);
let pendingSubmit:any=null,pendingImage:any=null,cropped:string|null=null,contextToken=0;
let progressSequence=0,progressRequest='';const deletedRecords=new Set<string>();
let imagePreviousMaterial:any=null;
let imageUrl:string|null=null,imageRecord='',imageLoading=false,debounce:ReturnType<typeof setTimeout>;
let polling=false;
function notice(message=''){ $('notice').textContent=message;show('notice',!!message); }
function failure(error:any){if(error.message==='SESSION_CHANGED')return;notice(errors[error.message]??`操作未完成：${error.message??'未知错误'}。已保存内容可从历史查看。`);}
async function call(message:any){const reply=await chrome.runtime.sendMessage(message);if(!reply?.ok)throw new Error(reply?.error??'PAGE_UNAVAILABLE');return reply.result;}
const api=async(action:string,params:any={},id?:string)=>{const epoch=accountEpoch;const result=await cloud.call(action,params,id);if(epoch!==accountEpoch)throw Error('SESSION_CHANGED');return result;};
function renderFont(theme:FontTheme){
  fontTheme=theme;applyFontTheme(theme);$<HTMLSelectElement>('fontTheme').value=theme;
  $('fontDescription').textContent=FONT_THEMES.find(item=>item.id===theme)?.description??'';
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
  const stamp=++fontVersion,previous=confirmedFontTheme;savingFont=true;renderFont(theme);$('fontState').textContent='正在保存字体方案…';
  try{
    await api('settings.update',{font_theme:theme});
    const settings=await api('settings.get');if(stamp!==fontVersion)return;
    if(normalizeFontTheme(settings.font_theme)!==theme)throw Error('FONT_THEME_NOT_CONFIRMED');
    confirmedFontTheme=theme;renderFont(theme);$('fontState').textContent='字体方案已保存，会同步到扩展和学习中心。';
  }catch(error){
    if(stamp===fontVersion){renderFont(previous);$('fontState').textContent='字体方案未能保存，已恢复上次设置，请稍后重试。';notice($('fontState').textContent);}
  }finally{if(stamp===fontVersion){savingFont=false;renderFont(fontTheme);}}
}
const privateImages=new PrivateImageUrls(recordId=>api('images.url',{record_id:recordId}),cloudUrl);
const historyList=new HistoryList<any>((query,offset)=>api('records.history',{query,offset}));
const speech='speechSynthesis' in window?new WordSpeech(window.speechSynthesis):null;
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function fingerprint(value:any){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))));}
const para=(text:string,style?:string)=>{const p=document.createElement('p');p.textContent=text;p.lang='zh-CN';if(style)p.className=style;return p;};
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
  const subject=example?`例句：${text}`:`${text} 的发音`;
  button.setAttribute('aria-label',`播放 ${subject}`);button.setAttribute('aria-pressed','false');button.title='点击播放，再次点击停止';
  const status=para('','pronunciation-status sr-only');status.setAttribute('role','status');status.hidden=true;
  const update=(state:string,message?:string)=>{
    const playing=state==='loading'||state==='speaking';button.setAttribute('aria-label',`${playing?'停止':'播放'} ${subject}`);button.setAttribute('aria-pressed',String(playing));button.title=playing?'再次点击停止':'点击播放';
    status.className=`pronunciation-status ${state==='error'?'muted':'sr-only'}`;
    status.textContent=message??(state==='loading'?'正在准备发音…':state==='speaking'?'正在播放…':state==='ended'?'已播放':'');status.hidden=!status.textContent;
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
function action(id:string,task:()=>Promise<unknown>){$(id).onclick=async()=>{const b=$<HTMLButtonElement>(id);b.disabled=true;$<HTMLDetailsElement>('menu').open=false;try{await task();}catch(e){failure(e);}finally{b.disabled=false;}};}
function view(name:string){if(name!=='learn')speech?.stop();for(const item of ['learn','history','settings'])show(item+'View',item===name);}
function stage(name:string,activate=true){for(const item of ['composer','imageStage','recordSection'])show(item,item===name);if(activate)view('learn');}
function link(id:string,source:any){const a=$<HTMLAnchorElement>(id);show(id,false);a.removeAttribute('href');if(!source?.url)return;try{const u=new URL(source.url);if(!['http:','https:'].includes(u.protocol))return;a.href=u.href;a.textContent=source.title||u.hostname;show(id,true);}catch{}}
function renderMaterial(){ $('contextStatus').textContent=contexts[material.status]??contexts.unavailable;$('draftContext').textContent=material.context??'';link('draftSource',material.source); }
async function saveDraft(){await sessionState.set({panel_state:{view:'compose',text:field('sourceText').value,context:material.context,status:material.status,source:material.source}});await sessionState.set({draft_binding:material.binding});}
async function resolveContext(text:string,forRecord=false){
  const token=++contextToken,binding=material.binding;
  if(forRecord&&!binding){material={...material,context:current?.context??'',status:current?.context_meta?.status??'none'};return;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=await Promise.race([call({kind:'context',text,binding:binding??undefined}),new Promise<any>(resolve=>{timer=setTimeout(()=>resolve({context:'',status:'timeout',binding,source:material.source}),1500);})]).finally(()=>clearTimeout(timer));if(token!==contextToken)return;
  material={...result,source:result.source??material.source};renderMaterial();if(!forRecord)await saveDraft();
}
function releaseImage(){cropped=null;pendingImage=null;imagePreviousMaterial=null;$<HTMLImageElement>('cropPreview').removeAttribute('src');$<HTMLInputElement>('imageFile').value='';}
function previewImage(image:string,nextMaterial:any){const previous=imagePreviousMaterial??material;releaseImage();imagePreviousMaterial=previous;cropped=image;material=nextMaterial;$<HTMLImageElement>('cropPreview').src=image;stage('imageStage');notice();}
function releaseStoredImage(){privateImages.clear();imageRecord='';imageLoading=false;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;$<HTMLDialogElement>('imageDialog').close();for(const id of ['recordImage','fullImage'])$<HTMLImageElement>(id).removeAttribute('src');show('openImage',false);}
async function bindRecord(id:string){if(material.binding)await sessionState.set({['binding:'+id]:material.binding});}
async function openRecord(record:any,restoreBinding=false){
  if(!record)return;if(current?.record_id!==record.record_id)++contextToken;const epoch=accountEpoch;if(record.input_type!=='image'||record.image)releaseImage();if(restoreBinding){const result=await sessionState.get('binding:'+record.record_id);if(epoch!==accountEpoch)return;material={context:record.context??'',status:record.context_meta?.status??'none',source:record.source,binding:result['binding:'+record.record_id]??null};}
  render(record);view('learn');await sessionState.set({last_record_id:record.record_id,panel_state:{view:'record'}});
}
function render(record:any){
  if(!record||deletedRecords.has(record.record_id)||(current?.record_id===record.record_id&&record.revision<current.revision))return;const changed=current?.record_id!==record.record_id||current.revision!==record.revision;
  if(changed){progressSequence=0;progressRequest='';}
  if(current?.record_id!==record.record_id){releaseStoredImage();$<HTMLDetailsElement>('recordDetails').open=false;}
  current=record;stage('recordSection',false);$('recordHeading').textContent=labels[record.status]??record.status;
  $('recordMeta').textContent=`${record.local_date} · 修订 ${record.revision}`;
  $('recordOriginal').textContent=record.corrected_text??record.recognized_text??record.original_text??'';
  link('recordSource',record.source);
  show('cancelJob',['saved','processing'].includes(record.status));show('reviewSection',record.status==='awaiting_review');
  if(changed){show('retrySection',false);if(record.status==='awaiting_review')field('corrected').value=record.corrected_text??record.recognized_text??'';}
  show('editRecord',['complete','failed','cancelled','interrupted'].includes(record.status));show('retryOcr',!!record.image&&['failed','cancelled','interrupted'].includes(record.status));
  const error=record.error?.code??record.error;show('recordError',!!error);$('recordError').textContent=errors[error]??(error?`处理未完成：${error}`:'');
  show('imageState',record.input_type==='image');$('imageState').textContent=record.image?'截图已保存在私有云端':'截图尚未确认保存，请保留原图。';
  renderLesson(record);
  if($<HTMLDetailsElement>('recordDetails').open)void loadStoredImage().catch(failure);
}
function renderLesson(record:any){
  const container=$('lesson');speech?.stop();container.replaceChildren();
  const language=record.result?.language;
  setLearningLanguage($('recordOriginal'),language);
  const context=$('recordContext');context.replaceChildren();context.lang='zh-CN';
  if(record.context){
    const prefix=document.createElement('span');prefix.className='ui-text';prefix.lang='zh-CN';prefix.textContent='上下文：';
    const text=document.createElement('span');text.textContent=record.context;setLearningLanguage(text,language);
    context.append(prefix,text);
  }else context.textContent=contexts[record.context_meta?.status??'none'];
  if(!record.result)return;
  if(record.status!=='complete'&&!record.preview)container.append(para('上次完整讲解 · 本次生成尚未完成','muted'));
  container.append(para(record.result.summary_zh,'lesson-overview ui-text'));
  for(const point of [...(record.result.vocabulary??[]),...(record.result.grammar??[])]){
    const block=document.createElement('article');block.className='point';
    const tag=para(point.term?'词汇':'语法','point-label ui-text');
    const heading=document.createElement('h3');heading.lang='zh-CN';heading.className='ui-text';
    if(point.term){
      const term=document.createElement('span');term.className='term-text learning-title';term.textContent=point.term;setLearningLanguage(term,language);heading.append(term);
      if(point.pos){const pos=document.createElement('span');pos.className='part-of-speech ui-text';pos.lang='zh-CN';pos.textContent=' · '+point.pos;heading.append(pos);}
    }else heading.textContent=point.point;
    block.append(tag,heading);
    if(point.term){
      const reading=readingParagraph(point.reading??'',language);
      const {button,status}=pronunciationControl(point.term,point.reading??'',language);reading.append(button);block.append(reading,status);
    }else if(point.reading)block.append(readingParagraph(point.reading,language));
    block.append(para(point.meaning??point.explanation,'ui-text'));
    for(const example of point.examples??[]){
      const item=document.createElement('div');item.className='example';const original=para('','example-original');
      setLearningLanguage(original,language);
      const {button,status}=pronunciationControl(example.text,'',language,true);appendExampleText(original,example.text,button);
      item.append(original,status,para(example.translation,'translation learning-text'));block.append(item);
    }
    container.append(block);
  }
}
function renderProgress(message:any){
  if(!message||!current||current.status!=='processing'||deletedRecords.has(message.record_id)||message.record_id!==current.record_id||message.revision!==current.revision||message.sequence<=progressSequence||(progressRequest&&progressRequest!==message.request_id))return;
  progressRequest=message.request_id;progressSequence=message.sequence;
  renderLesson({...current,result:message.preview,preview:true});$('recordHeading').textContent='生成中 · 尚未保存完整讲解';
}
async function loadStoredImage(){
  const record=current;if(!record?.image||imageLoading)return;imageLoading=true;$<HTMLButtonElement>('openImage').disabled=true;
  const epoch=accountEpoch;
  try{const signed=await privateImages.get(record.record_id);if(epoch!==accountEpoch||current?.record_id!==record.record_id)return;
    imageUrl=signed;imageRecord=record.record_id;$<HTMLImageElement>('recordImage').src=imageUrl;show('openImage',true);
  }finally{imageLoading=false;$<HTMLButtonElement>('openImage').disabled=false;}
}
async function newDraft(){++displayEpoch;speech?.stop();clearTimeout(debounce);++contextToken;current=null;releaseStoredImage();releaseImage();pendingSubmit=null;material={context:'',status:'unavailable',source:null,binding:null};field('sourceText').value='';show('editRecord',false);show('retryOcr',false);await sessionState.remove('pending_submit');stage('composer');renderMaterial();notice();await saveDraft();}
async function loadDraft(draft:any){if(!draft||draft.nonce===draftNonce)return;const epoch=accountEpoch;draftNonce=draft.nonce;await newDraft();if(epoch!==accountEpoch)return;material={...draft,source:draft.source??null};field('sourceText').value=draft.text;renderMaterial();await sessionState.set({last_draft_nonce:draftNonce});await saveDraft();}
async function runLearning(action:string,params:any,requestId:string,assertTarget=()=>{}){
  assertTarget();
  if(activeStream)throw Error('REQUEST_IN_PROGRESS');
  if(!await cloud.getSession())throw Error('LOGIN_REQUIRED');
  assertTarget();
  const epoch=accountEpoch,display=++displayEpoch,controller=new AbortController();
  const stream={recordId:params.record_id,requestId,controller};activeStream=stream;
  const visible=()=>!controller.signal.aborted&&epoch===accountEpoch&&display===displayEpoch&&!deletedRecords.has(params.record_id);
  try{
    const record=await cloud.start(action,params,requestId,async event=>{
      if(!visible()||controller.signal.aborted)return;
      if(event.type==='accepted'&&event.record){await openRecord(event.record);notice(event.record.input_type==='image'&&!event.record.image?'正在保存截图…':'材料已保存到云端，正在生成…');}
      if(event.type==='progress')renderProgress(event);
      if(event.type==='complete'&&event.record)render(event.record);
      if(event.type==='error'&&event.record&&event.record.record_id===params.record_id&&['failed','interrupted','cancelled','complete','awaiting_review'].includes(event.record.status))render(event.record);
    },{signal:controller.signal});
    if(visible()){await openRecord(record);notice(record.status==='complete'?'':record.status==='awaiting_review'?'截图已保存，请检查识别文字。':['failed','interrupted'].includes(record.status)?'本次处理未完成；重试可能再次产生 API 费用。':'已保存到云端。');}
  }catch(error){
    if(!visible())return;
    failure(error); // Recover the same request by reading; never start a second model call.
    try{const record=await api('records.get',{record_id:params.record_id});if(visible()&&record){await openRecord(record);if(record.status==='complete')notice();else if(record.status==='cancelled')notice('已取消，已发生的 API 费用不保证撤回。');else if(record.status==='interrupted')notice(errors.RESULT_UNKNOWN);}}
    catch{ /* Keep the material and recovery ID while offline. */ }
  }finally{if(activeStream===stream)activeStream=null;}
}
field('sourceText').addEventListener('input',()=>{pendingSubmit=null;++contextToken;clearTimeout(debounce);void saveDraft();debounce=setTimeout(()=>void resolveContext(field('sourceText').value).catch(failure),400);});
action('send',async()=>{
  const clicked=performance.now();notice('正在准备讲解…');
  const text=field('sourceText').value.trim();if(!text)throw new Error('EMPTY_TEXT');if(!hasLearningText(text)){notice('请输入要学习的英语或日语文字（日语可以只含汉字）；当前内容只有数字、符号或暂不支持的文字。');return;}
  if(pendingSubmit?.record_id){const saved=await api('records.get',{record_id:pendingSubmit.record_id});if(saved){await openRecord(saved,true);notice('已恢复上次保存的记录。');return;}}
  const feedback=performance.now()-clicked,contextStarted=performance.now();
  clearTimeout(debounce);await resolveContext(text);const contextMs=performance.now()-contextStarted;const timedOut=material.status==='timeout';const params={text,context:material.context??'',context_meta:{status:timedOut?'unavailable':material.status},source:material.source};const signature=await fingerprint(params);
  if(field('sourceText').value.trim()!==text)throw new Error('INPUT_CHANGED');
  if(!pendingSubmit||pendingSubmit.fingerprint!==signature)pendingSubmit={id:crypto.randomUUID(),record_id:crypto.randomUUID(),fingerprint:signature,params};
  await sessionState.set({pending_submit:pendingSubmit,last_record_id:pendingSubmit.record_id});await bindRecord(pendingSubmit.record_id);
  const request=pendingSubmit;void api('telemetry.record',{request_id:request.id,timings:{context_ms:contextMs,click_feedback_ms:feedback}}).catch(()=>{});
  await runLearning('learning.submit',{...request.params,record_id:request.record_id},request.id);
});
action('newDraft',newDraft);
action('newNote',newDraft);
async function capture(){clearTimeout(debounce);++contextToken;const epoch=accountEpoch;notice('请在原网页拖动框选，Esc 取消。');const result=await call({kind:'capture'});if(epoch!==accountEpoch)return;previewImage(result.image,{binding:result.binding,source:result.source,context:'',status:'unavailable'});}
action('capture',capture);action('recapture',capture);action('filePick',async()=>{$<HTMLInputElement>('imageFile').click();});
$<HTMLInputElement>('imageFile').onchange=async()=>{clearTimeout(debounce);++contextToken;try{const file=$<HTMLInputElement>('imageFile').files?.[0];if(!file)return;if(file.size>12*1024*1024)throw new Error('IMAGE_TOO_LARGE');
  const epoch=accountEpoch,bitmap=await createImageBitmap(file);try{if(epoch!==accountEpoch)return;if(bitmap.width*bitmap.height>24000000)throw new Error('IMAGE_TOO_LARGE');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);const data=canvas.toDataURL('image/png');if(atob(data.split(',')[1]).length>4*1024*1024)throw new Error('IMAGE_TOO_LARGE');previewImage(data,{context:'',status:'none',source:null,binding:null});}finally{bitmap.close();}
}catch(e){failure(e);}};
action('cancelImage',async()=>{const previous=imagePreviousMaterial;releaseImage();if(previous)material=previous;renderMaterial();stage(current?'recordSection':'composer');if(!current)await saveDraft();notice('已取消选图，未发送图片。');});
action('recognize',async()=>{
  if(!cropped)throw new Error('IMAGE_REGION_REQUIRED');const signature=await fingerprint({image:cropped,source:material.source});if(!pendingImage||pendingImage.signature!==signature)pendingImage={recordId:crypto.randomUUID(),requestId:crypto.randomUUID(),signature};
  const {recordId,requestId}=pendingImage;await sessionState.set({last_record_id:recordId,panel_state:{view:'record'}});await bindRecord(recordId);
  await runLearning('learning.recognize',{record_id:recordId,image:cropped,source:material.source},requestId);
});
async function operation(method:string,text?:string){
  if(!current)throw Error('INPUT_CHANGED');
  const target={recordId:current.record_id,revision:current.revision,account:accountEpoch,display:displayEpoch};
  const assertTarget=()=>{if(target.account!==accountEpoch||target.display!==displayEpoch||current?.record_id!==target.recordId||current?.revision!==target.revision)throw Error('INPUT_CHANGED');};
  if(text!==undefined)await resolveContext(text,true);assertTarget();
  const params={record_id:target.recordId,revision:target.revision,confirmed:true,...(text!==undefined?{text,context:material.context??'',context_meta:{status:material.status??'none'}}:{})};
  const signature=await fingerprint({method,...params});assertTarget();
  const stored=await sessionState.get('pending_operation');assertTarget();const pending:any=stored.pending_operation;const id=pending?.signature===signature?pending.id:crypto.randomUUID();
  await sessionState.set({pending_operation:{id,signature,record_id:target.recordId}});assertTarget();
  await runLearning(method,params,id,assertTarget);
}
action('cancelJob',async()=>{const id=current.record_id;notice('正在请求取消…');try{const record=await api('learning.cancel',{record_id:id});if(activeStream&&activeStream.recordId===id)activeStream.controller.abort();if(current?.record_id===id)render(record);notice(record.status==='complete'?'讲解已先完成并保存。':'已取消，已发生的 API 费用不保证撤回。');}catch(error){notice('取消尚未确认；请连接网络后重新检查。');throw error;}});
action('confirmText',()=>operation('learning.confirm',field('corrected').value));
action('editRecord',async()=>{field('retryText').value=current.corrected_text??current.recognized_text??current.original_text??'';show('retrySection',true);view('learn');field('retryText').focus();});
action('retryConfirm',()=>operation('learning.retry',field('retryText').value));
action('retryOcr',async()=>{if(window.confirm('重新识别将发送已保存图片，可能再次产生 API 费用。继续吗？'))await operation('learning.recognizeRetry');});
$<HTMLDetailsElement>('recordDetails').addEventListener('toggle',()=>{if($<HTMLDetailsElement>('recordDetails').open)void loadStoredImage().catch(failure);});
action('openImage',async()=>{const id=current?.record_id;await loadStoredImage();if(imageUrl&&current?.record_id===id){$<HTMLImageElement>('fullImage').src=imageUrl;$<HTMLDialogElement>('imageDialog').showModal();}});action('closeImage',async()=>$<HTMLDialogElement>('imageDialog').close());
async function history(reset=true){
  const request=historyList.load(field('search').value,!reset,window.scrollY);$<HTMLButtonElement>('more').disabled=historyList.loading;
  try{if(!await request)return;$('historyList').replaceChildren();const result=historyList.state;
    for(const item of result.items){
      const row=document.createElement('div');row.className='history-row';
      const button=document.createElement('button');button.className='history-card';button.append(document.createTextNode(item.text||item.original_text||item.recognized_text||'图片识别记录'));const small=document.createElement('small');small.textContent=`${item.local_date} · ${labels[item.status]??item.status}${item.input_type==='image'?' · 图片':''}`;button.append(small);button.onclick=async()=>{try{++displayEpoch;await openRecord(await api('records.get',{record_id:item.record_id}),true);notice();}catch(e){failure(e);}};
      const remove=document.createElement('button');remove.type='button';remove.className='delete-record';remove.textContent='删除';remove.setAttribute('aria-label',`删除 ${item.text||'图片识别记录'}`);
      remove.onclick=async()=>{
        if(!window.confirm('删除这条云端记录及截图，并移出后续复习？已经发送的通知和已有备份不会撤回。'))return;
        remove.disabled=true;
        try{const record=await api('records.get',{record_id:item.record_id});if(record)await api('records.delete',{record_id:item.record_id,revision:record.revision,confirmed:true});if(activeStream&&activeStream.recordId===item.record_id)activeStream.controller.abort();await forgetDeleted(item.record_id);await history();notice('已从云端历史和后续复习移除。');}catch(e){failure(e);remove.disabled=false;}
      };
      row.append(button,remove);$('historyList').append(row);
    }
    show('more',result.has_more);if(!result.items.length)$('historyList').append(para('还没有匹配的记录。','muted'));window.scrollTo({top:result.scroll});
  }finally{$<HTMLButtonElement>('more').disabled=historyList.loading;}
}
async function forgetDeleted(id:string){
  deletedRecords.add(id);historyList.remove((item:any)=>item.record_id===id);
  const saved:any=await sessionState.get(['last_record_id','pending_submit','pending_operation']);
  const keys:string[]=[];if(saved.last_record_id===id)keys.push('last_record_id');if(saved.pending_submit?.record_id===id){keys.push('pending_submit');pendingSubmit=null;}
  if(saved.pending_operation?.record_id===id)keys.push('pending_operation');
  await sessionState.remove(keys);await sessionState.remove('binding:'+id);
  if(current?.record_id===id){const inHistory=!$('historyView').hidden;await newDraft();if(inHistory)view('history');}
}
action('historyTab',async()=>{view('history');await history();});action('searchButton',()=>history());action('more',()=>history(false));field('search').onkeydown=e=>{if(e.key==='Enter')void history().catch(failure);};
field('search').addEventListener('input',()=>{if(!field('search').value.trim())void history().catch(failure);});
action('backFromHistory',async()=>view('learn'));action('backFromSettings',async()=>view('learn'));
async function restorePanel(){
  const epoch=accountEpoch;
  const saved:any=await sessionState.get(),selection:any=await chrome.storage.session.get('draft');
  if(epoch!==accountEpoch)return;
  draftNonce=saved.last_draft_nonce??'';pendingSubmit=saved.pending_submit??null;
  if(selection.draft&&selection.draft.nonce!==draftNonce){await loadDraft(selection.draft);return;}
  if(saved.panel_state?.view==='compose'){field('sourceText').value=saved.panel_state.text??'';material={...saved.panel_state,binding:saved.draft_binding??null};renderMaterial();return;}
  if(accountId&&saved.last_record_id){const record=await api('records.get',{record_id:saved.last_record_id});if(record){await openRecord(record,true);return;}notice('上次发送未确认保存，请检查材料后重试。');}
  if(pendingSubmit?.params){field('sourceText').value=pendingSubmit.params.text??'';material={...pendingSubmit.params,status:pendingSubmit.params.context_meta?.status??'unavailable',binding:saved.draft_binding??null};}renderMaterial();
}
async function changeAccount(session:CloudSession|null){
  const next=session?.user.id??null;if(accountId===next)return;
  const old=accountId;accountId=next;++accountEpoch;++displayEpoch;++contextToken;
  ++fontVersion;savingFont=false;fontReady=false;confirmedFontTheme='clean';renderFont('clean');$('fontState').textContent='标题、按钮和学习内容一起切换，并在登录后同步。';
  activeStream?.controller.abort();activeStream=null;clearTimeout(debounce);speech?.stop();
  current=null;pendingSubmit=null;draftNonce='';material={context:'',status:'unavailable',source:null,binding:null};deletedRecords.clear();historyList.clear();
  releaseStoredImage();releaseImage();field('sourceText').value='';field('search').value='';field('apiKey').value='';field('password').value='';
  $('historyList').replaceChildren();$('lesson').replaceChildren();show('editRecord',false);show('retryOcr',false);stage('composer',false);renderMaterial();notice();
  await sessionState.switchOwner(next,old!==undefined);if(old)await chrome.storage.session.remove('draft');
  show('loginFields',!session);show('keyFields',!!session);show('modeFields',!!session);show('fontFields',!!session);show('signOut',!!session);renderMode('fast');
  $('connectionState').textContent=session?`已登录 ${session.user.email??'Lingo Notes'}`:'登录后，笔记将保存在你的私有云端。';
  if(!next&&old)view('settings');
  if(old===undefined||next)await restorePanel();
  if(next)await refreshFontTheme();
}
let accountChange=Promise.resolve();
function scheduleAccount(session:CloudSession|null){accountChange=accountChange.catch(()=>{}).then(()=>changeAccount(session));return accountChange;}
cloud.onAuthChange(session=>{void scheduleAccount(session).catch(failure);});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes['lingo-session:'+cloudUrl])void cloud.getSession().then(scheduleAccount).catch(failure);
  if(area==='session'&&changes.draft?.newValue)void loadDraft(changes.draft.newValue).catch(failure);
});
async function diagnose(){
  const session=await cloud.getSession();await scheduleAccount(session);if(!session)return;
  const [info,key,settings]=await Promise.all([api('ping'),api('key.status'),api('settings.get'),refreshFontTheme()]);
  $('connectionState').replaceChildren(para(`已登录 ${session.user.email??'Lingo Notes'}`),para('云端连接正常','muted'));
  $('keyState').textContent=key.configured?`DeepSeek Key 已保存${key.last_four?' · 尾号 '+key.last_four:''}`:'尚未配置 DeepSeek API Key';
  if(info.model)$('keyState').textContent+=` · ${info.model}`;
  renderMode(settings.explanation_mode??'fast');
}
function renderMode(mode:string){
  for(const [id,value] of [['modeFast','fast'],['modeThinking','thinking']]){$(id).setAttribute('aria-pressed',String(value===mode));$(id).classList.toggle('primary',value===mode);}
  $('modeState').textContent=mode==='thinking'?'当前为思考模式。':'当前为快速模式。';
}
let savingMode=false;
async function saveMode(mode:'fast'|'thinking'){
  if(savingMode)return;savingMode=true;
  for(const id of ['modeFast','modeThinking'])$<HTMLButtonElement>(id).disabled=true;
  try{
    await api('settings.update',{explanation_mode:mode});
    const settings=await api('settings.get');renderMode(settings.explanation_mode??'fast');
    if(settings.explanation_mode!==mode){notice('暂未确认讲解模式已保存，请检查连接后重试。');return;}
    notice(`讲解模式已保存：${mode==='thinking'?'思考':'快速'}。对下一次新讲解生效。`);
  }finally{savingMode=false;for(const id of ['modeFast','modeThinking'])$<HTMLButtonElement>(id).disabled=false;}
}
action('modeFast',()=>saveMode('fast'));action('modeThinking',()=>saveMode('thinking'));
$<HTMLSelectElement>('fontTheme').onchange=()=>{void saveFontTheme(normalizeFontTheme($<HTMLSelectElement>('fontTheme').value));};
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
action('saveKey',async()=>{const input=field('apiKey'),key=input.value.trim();if(!key){notice('请输入 DeepSeek API Key。');return;}try{await api('key.save',{key});notice('Key 已加密保存，模型费用由 DeepSeek 直接收取。');await diagnose();}finally{input.value='';}});
action('deleteKey',async()=>{if(!window.confirm('移除已保存的 DeepSeek Key？已有笔记和复习仍会保留。'))return;await api('key.delete');field('apiKey').value='';await diagnose();notice('已移除 Key。');});
action('settingsTab',async()=>{view('settings');await diagnose();});action('diagnose',diagnose);
const port=chrome.runtime.connect({name:'learning-panel'});
port.onMessage.addListener(message=>{if(message.event==='draft.changed')void loadDraft(message.draft).catch(failure);});
// Only recover by reading. Never replay a model POST when the stream or sidebar closes.
setInterval(async()=>{if(polling||activeStream||!accountId||!current||!['saved','processing'].includes(current.status))return;const id=current.record_id,epoch=accountEpoch;polling=true;try{const record=await api('records.get',{record_id:id});if(epoch!==accountEpoch||current?.record_id!==id)return;if(!record){await forgetDeleted(id);return;}if(record.revision>=current.revision){render(record);if(record.status==='complete')notice();else if(record.status==='interrupted')notice(errors.RESULT_UNKNOWN);}}catch(e){failure(e);}finally{polling=false;}},3000);
const menu=$<HTMLDetailsElement>('menu');
const dismissMenu=(event:Event)=>{if(event.target instanceof Node&&!menu.contains(event.target))menu.open=false;};
document.addEventListener('pointerdown',dismissMenu);document.addEventListener('focusin',dismissMenu);
window.addEventListener('blur',()=>{menu.open=false;});window.addEventListener('pagehide',()=>{field('password').value='';speech?.stop();activeStream?.controller.abort();});
const refreshPreferences=()=>{if(document.visibilityState!=='hidden')void cloud.getSession().then(scheduleAccount).then(refreshFontTheme).catch(failure);};
window.addEventListener('focus',refreshPreferences);document.addEventListener('visibilitychange',refreshPreferences);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;speech?.stop();void call({kind:'capture.cancel'}).catch(()=>{});}});
void(async()=>{try{await scheduleAccount(await cloud.getSession());}catch(e){failure(e);}})();
