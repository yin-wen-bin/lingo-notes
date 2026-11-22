import { normalizeText,sentenceContext } from './context';
import {normalizeUiLanguage,surfaceText} from './surface-i18n';
declare global { interface Window { __lingoNotesCleanup?:()=>void } }
try{window.__lingoNotesCleanup?.();}catch{} // An extension update invalidates the previous isolated-world listener.
let cancelSelection:(()=>void)|null=null;
const metrics=()=>({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,scale:visualViewport?.scale??1,url:location.href});
const documentToken=crypto.randomUUID();let mutationVersion=0;
const observer=new MutationObserver(()=>{mutationVersion++;});observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true});
const pageState=()=>({documentToken,mutationVersion,...metrics()});
function resolveContext(query:string,rect?:{x:number,y:number,width:number,height:number}){
  const selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;
  const selected=selection?.toString()??'';
  const article=document.querySelector('article,main,[role="main"]');
  const root=article&&(!range||article.contains(range.commonAncestorContainer))?article:document.body;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let raw='',lastBlock:Element|null=null,hint:number|undefined,nearest=Infinity;
  const started=performance.now();let node:Node|null;
  while((node=walker.nextNode())&&raw.length<400000&&performance.now()-started<350){
    const el=node.parentElement;if(!el||el.closest('script,style,noscript,textarea,input,select,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]'))continue;
    const style=getComputedStyle(el);if(style.display==='none'||style.visibility!=='visible'||style.opacity==='0')continue;
    const r=document.createRange();r.selectNodeContents(node);const bounds=r.getBoundingClientRect();if(!bounds.width||!bounds.height)continue;
    const block=el.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,div,section,article');
    if(block!==lastBlock&&raw&&!/\s$/.test(raw))raw+='\n';lastBlock=block;
    const offset=raw.length;
    if(range&&normalizeText(selected)===normalizeText(query)&&range.startContainer===node)hint=normalizeText(raw+node.textContent!.slice(0,range.startOffset)).length;
    if(rect&&bounds.right>rect.x&&bounds.left<rect.x+rect.width&&bounds.bottom>rect.y&&bounds.top<rect.y+rect.height){
      const distance=Math.abs(bounds.left-rect.x)+Math.abs(bounds.top-rect.y);
      if(distance<nearest){nearest=distance;hint=normalizeText(raw).length;}
    }
    raw+=node.textContent??'';
    if(raw.length===offset)continue;
  }
  return {...sentenceContext(raw,query,hint),selection:selected,title:document.title,url:location.href,pageState:pageState()};
}
function selectRegion(language:unknown):Promise<any>{
  cancelSelection?.();
  return new Promise((resolve,reject)=>{
    const before=metrics(),focus=document.activeElement as HTMLElement|null;
    const host=document.createElement('div');host.setAttribute('data-lingo-overlay','');
    host.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;';
    const shadow=host.attachShadow({mode:'closed'});
    shadow.innerHTML='<style>:host{all:initial} .surface{position:fixed;inset:0;background:rgba(0,0,0,.14);cursor:crosshair;user-select:none} .box{position:absolute;display:none;border:2px solid #267359;box-shadow:0 0 0 9999px rgba(0,0,0,.24);pointer-events:none} .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:8px 16px;background:#fff;color:#243c31;border-radius:24px;font:14px system-ui;pointer-events:none}</style><div class="surface"><div class="box"></div><div class="hint"></div></div>';
    const hint=shadow.querySelector('.hint') as HTMLElement;hint.lang=normalizeUiLanguage(language);hint.textContent=surfaceText(language,'captureHint');
    document.documentElement.append(host);
    const surface=shadow.querySelector('.surface') as HTMLElement,box=shadow.querySelector('.box') as HTMLElement;
    let from:{x:number,y:number}|null=null,settled=false;
    const cleanup=()=>{host.remove();removeEventListener('keydown',key,true);removeEventListener('scroll',changed,true);removeEventListener('resize',changed);visualViewport?.removeEventListener('resize',changed);clearTimeout(timer);cancelSelection=null;focus?.focus({preventScroll:true});};
    const cancel=()=>{if(settled)return;settled=true;cleanup();reject(new Error('CAPTURE_CANCELLED'));};
    const changed=()=>{if(settled)return;settled=true;cleanup();reject(new Error('VIEWPORT_CHANGED'));};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();}else if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))event.preventDefault();};
    const timer=setTimeout(cancel,120000);cancelSelection=cancel;
    addEventListener('keydown',key,true);addEventListener('scroll',changed,true);addEventListener('resize',changed);visualViewport?.addEventListener('resize',changed);
    surface.addEventListener('wheel',e=>e.preventDefault(),{passive:false});
    surface.addEventListener('pointercancel',cancel);
    surface.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();from={x:e.clientX,y:e.clientY};surface.setPointerCapture(e.pointerId);box.style.display='block';box.style.left=from.x+'px';box.style.top=from.y+'px';box.style.width='0';box.style.height='0';});
    surface.addEventListener('pointermove',e=>{if(!from)return;box.style.left=Math.min(from.x,e.clientX)+'px';box.style.top=Math.min(from.y,e.clientY)+'px';box.style.width=Math.abs(e.clientX-from.x)+'px';box.style.height=Math.abs(e.clientY-from.y)+'px';});
    surface.addEventListener('pointerup',async e=>{
      if(!from||settled)return;const rect={x:Math.max(0,Math.min(from.x,e.clientX)),y:Math.max(0,Math.min(from.y,e.clientY)),width:Math.abs(from.x-e.clientX),height:Math.abs(from.y-e.clientY)};
      from=null;if(rect.width<8||rect.height<8){box.style.display='none';return;}
      settled=true;cleanup();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      if(JSON.stringify(metrics())!==JSON.stringify(before))return reject(new Error('VIEWPORT_CHANGED'));
      resolve({rect,viewport:before,title:document.title,url:location.href});
    });
  });
}
const listener=(message:any,sender:chrome.runtime.MessageSender,respond:(value:any)=>void)=>{
  if(sender.id!==chrome.runtime.id||message.channel!=='lingo-page')return;
  (async()=>{
    if(message.action==='context')return resolveContext(String(message.text??'').slice(0,12000),message.rect);
    if(message.action==='select')return selectRegion(message.ui_language);
    if(message.action==='cancel'){cancelSelection?.();return {};}
    if(message.action==='metrics')return metrics();
    if(message.action==='state')return pageState();
    throw new Error('UNKNOWN_ACTION');
  })().then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message}));return true;
};
chrome.runtime.onMessage.addListener(listener);
window.__lingoNotesCleanup=()=>{cancelSelection?.();observer.disconnect();chrome.runtime.onMessage.removeListener(listener);};
