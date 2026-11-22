export const SELECTION_QUEUE_KEY='lingo-selection-queue-v1';
export type QueueOwner=string|null;
export type QueueMaterial={text:string;context:string;status:string;source:any;binding?:any};
export type QueueJob=QueueMaterial&{id:string;owner:QueueOwner;sequence:number;windowId:number;createdAt:number;phase:'collecting'|'ready'|'running'|'unknown';action:string;requestId:string;recordId:string;params?:Record<string,any>;executorId?:string;error?:string;terminalStatus?:string};
export type ManualSelection=QueueMaterial&{nonce:string;owner:QueueOwner;windowId:number;manual:true;reason:'login'|'key'};
export type QueueSnapshot={owner:QueueOwner;version:number;waiting:QueueJob[];active:QueueJob|null;last:QueueJob|null;manualDraft:ManualSelection|null;paused:'setup'|null};
export type QueueIdentity={clientId:string;windowId:number;owner:QueueOwner};
export type QueueCommand=QueueIdentity&{kind:'selection-queue';op:'sync'|'claim'|'acquire'|'finish'|'unknown'|'clear'|'skip'|'manual'|'recover';jobId?:string;explanationLanguage?:'zh'|'ja'|'en';action?:string;params?:Record<string,any>;requestId?:string;recordId?:string;terminalStatus?:string;error?:string;reason?:'login'|'key'};
export type QueueReply={snapshot:QueueSnapshot;job?:QueueJob|null;draft?:ManualSelection|null};
export type QueueRegistration=QueueIdentity&{kind:'selection-queue.register'};

type Area={get(key:string):Promise<Record<string,any>>;set(value:Record<string,any>):Promise<void>};
type Stored=QueueSnapshot&{nextSequence:number};
const terminal=new Set(['complete','failed','interrupted','cancelled','awaiting_review']);
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const empty=(owner:QueueOwner):Stored=>({owner,version:0,nextSequence:1,waiting:[],active:null,last:null,manualDraft:null,paused:null});

/** A single background writer owns all model permits in this browser session.
 * A claimed permit is never returned as executable again, even after a restart. */
export class SelectionQueue {
  private area:Area;
  private state:Stored|null=null;
  private pending:Promise<unknown>=Promise.resolve();
  private recoveryDirty=false;
  private clients=new Map<string,QueueIdentity>();
  private publish:(snapshot:QueueSnapshot)=>void;
  private id:()=>string;
  private now:()=>number;
  constructor(area:Area,publish:(snapshot:QueueSnapshot)=>void=()=>{},id=()=>crypto.randomUUID(),now=()=>Date.now()){
    this.area=area;this.publish=publish;this.id=id;this.now=now;
  }
  register(identity:QueueIdentity){
    if(!identity.clientId||!Number.isInteger(identity.windowId))throw Error('UNTRUSTED_SENDER');
    this.clients.set(identity.clientId,{...identity});
  }
  private async transaction<T>(owner:QueueOwner,mutate:(state:Stored)=>T,reconcile=true,rejectMismatch=false):Promise<T>{
    const run=this.pending.catch(()=>{}).then(async()=>{
      if(!this.state){
        const saved=(await this.area.get(SELECTION_QUEUE_KEY))[SELECTION_QUEUE_KEY];
        this.state=saved&&Array.isArray(saved.waiting)&&Number.isInteger(saved.nextSequence)?clone(saved):empty(owner);
        // The previous executor may already have POSTed. Recovery is always GET-only.
        if(this.state!.active){this.state!.active.phase='unknown';this.state!.active.error='EXECUTOR_DISCONNECTED';delete this.state!.active.executorId;this.recoveryDirty=true;}
        for(const job of this.state!.waiting)if(job.phase==='collecting'){job.phase='ready';job.status='unavailable';job.context='';this.recoveryDirty=true;}
      }
      const before=JSON.stringify(this.state),state=clone(this.state!);
      if(!reconcile&&state.owner!==owner){if(rejectMismatch)throw Error('SESSION_CHANGED');return clone(this.snapshot(state)) as T;}
      if(state.owner!==owner){
        const manual=state.owner===null&&owner&&state.manualDraft?.owner===null?{...state.manualDraft,owner}:null;
        const replacement=empty(owner);replacement.version=state.version+1;replacement.manualDraft=manual;replacement.paused=manual?'setup':null;Object.assign(state,replacement);
      }
      const value=mutate(state);
      if(JSON.stringify(state)!==before||this.recoveryDirty){state.version++;await this.area.set({[SELECTION_QUEUE_KEY]:state});this.state=state;this.recoveryDirty=false;this.publish(this.snapshot(state));}
      if(value&&typeof value==='object'&&'snapshot' in value)(value as QueueReply).snapshot=this.snapshot(state);
      else if(value&&typeof value==='object'&&'waiting' in value&&'version' in value)Object.assign(value,this.snapshot(state));
      return clone(value);
    });
    this.pending=run;return run;
  }
  private snapshot(state:Stored):QueueSnapshot{
    const {nextSequence:_,...snapshot}=state,result=clone(snapshot);
    // Image bytes are needed only in the persisted active permit, never in broadcasts/history.
    for(const job of [result.active,result.last])if(job?.params)delete job.params.image;
    return result;
  }
  private authorized(identity:QueueIdentity){
    const registered=this.clients.get(identity.clientId);
    if(!registered||registered.owner!==identity.owner||registered.windowId!==identity.windowId)throw Error('UNTRUSTED_SENDER');
  }
  private eligible(job:QueueJob,identity:QueueIdentity){
    const originPresent=[...this.clients.values()].some(client=>client.owner===identity.owner&&client.windowId===job.windowId);
    return !originPresent||job.windowId===identity.windowId;
  }
  async syncOwner(owner:QueueOwner){return this.transaction(owner,state=>this.snapshot(state));}
  async enqueue(owner:QueueOwner,windowId:number,material:QueueMaterial,nonce=this.id()){
    return this.transaction(owner,state=>{
      const known=[...state.waiting,state.active,state.last].find(job=>job?.id===nonce);if(known)return known;
      const job:QueueJob={...material,id:nonce,owner,sequence:state.nextSequence++,windowId,createdAt:this.now(),phase:'collecting',action:'learning.submit',requestId:this.id(),recordId:this.id()};
      state.waiting.push(job);return job;
    });
  }
  async contextReady(owner:QueueOwner,jobId:string,material:Partial<QueueMaterial>){
    return this.transaction(owner,state=>{
      const job=state.waiting.find(job=>job.id===jobId);
      if(job&&job.phase==='collecting'){
        if(typeof material.context==='string')job.context=material.context;
        if(typeof material.status==='string')job.status=material.status;
        if(material.binding!==undefined)job.binding=material.binding;
        job.phase='ready';
      }
      return this.snapshot(state);
    },false);
  }
  async disconnect(clientId:string,owner:QueueOwner){
    if(this.clients.get(clientId)?.owner===owner)this.clients.delete(clientId);
    return this.transaction(owner,state=>{if(state.active?.executorId===clientId){state.active.phase='unknown';state.active.error='EXECUTOR_DISCONNECTED';delete state.active.executorId;}return this.snapshot(state);},false);
  }
  async command(message:QueueCommand):Promise<QueueReply>{
    this.authorized(message);
    return this.transaction(message.owner,state=>{
      let job:QueueJob|null|undefined,draft:ManualSelection|null|undefined;
      const active=()=>{if(!state.active||state.active.id!==message.jobId)throw Error('QUEUE_TASK_CHANGED');return state.active;};
      switch(message.op){
        case 'sync':
          if(state.manualDraft&&![...this.clients.values()].some(client=>client.owner===message.owner&&client.windowId===state.manualDraft!.windowId))state.manualDraft.windowId=message.windowId;
          break;
        case 'claim':{
          const next=state.waiting[0];
          if(!message.owner||state.active||state.paused||!next||next.phase!=='ready'||!this.eligible(next,message)){job=null;break;}
          if(!['zh','ja','en'].includes(message.explanationLanguage??''))throw Error('LANGUAGE_NOT_READY');
          job=state.waiting.shift()!;job.phase='running';job.executorId=message.clientId;
          job.params={text:job.text,explanation_language:message.explanationLanguage,context:job.context,context_meta:{status:job.status==='timeout'?'unavailable':job.status},source:job.source,record_id:job.recordId};
          state.active=job;break;
        }
        case 'acquire':{
          if(!message.owner)throw Error('LOGIN_REQUIRED');
          if(state.active||(state.waiting.length&&!state.paused))throw Error('REQUEST_IN_PROGRESS');
          if(!message.requestId||!message.recordId||!message.action?.startsWith('learning.')||!message.params)throw Error('INVALID_QUEUE_REQUEST');
          job={id:this.id(),owner:message.owner,sequence:state.nextSequence++,windowId:message.windowId,createdAt:this.now(),phase:'running',executorId:message.clientId,action:message.action,requestId:message.requestId,recordId:message.recordId,params:message.params,text:message.params.text??'',context:message.params.context??'',status:message.params.context_meta?.status??'none',source:message.params.source??null};
          state.active=job;state.paused=null;state.manualDraft=null;break;
        }
        case 'finish':{
          const current=active();if(current.executorId!==message.clientId)throw Error('UNTRUSTED_SENDER');
          if(!terminal.has(message.terminalStatus??''))throw Error('QUEUE_RESULT_UNKNOWN');
          current.terminalStatus=message.terminalStatus;if(current.params)delete current.params.image;state.last=current;state.active=null;break;
        }
        case 'unknown':{
          const current=active();if(current.executorId!==message.clientId)throw Error('UNTRUSTED_SENDER');
          current.phase='unknown';current.error=message.error??'RESULT_UNKNOWN';break;
        }
        case 'recover':{
          const current=active();
          if(message.terminalStatus){if(!terminal.has(message.terminalStatus))throw Error('QUEUE_RESULT_UNKNOWN');current.terminalStatus=message.terminalStatus;if(current.params)delete current.params.image;state.last=current;state.active=null;}
          else if(current.phase==='unknown'){current.executorId=message.clientId;job=null;}
          break;
        }
        case 'clear':state.waiting=[];state.paused=null;state.manualDraft=null;break;
        case 'skip':{
          const current=active();if(current.phase!=='unknown')throw Error('REQUEST_IN_PROGRESS');
          current.terminalStatus='skipped';if(current.params)delete current.params.image;state.last=current;state.active=null;break;
        }
        case 'manual':{
          if(state.active)throw Error('REQUEST_IN_PROGRESS');
          if(state.paused==='setup'&&state.manualDraft){draft=state.manualDraft;break;}
          const next=state.waiting[0];
          if(!next||next.phase!=='ready'||!this.eligible(next,message)){draft=state.manualDraft;break;}
          state.waiting.shift();draft={text:next.text,context:next.context,status:next.status,source:next.source,binding:next.binding,nonce:next.id,owner:next.owner,windowId:message.windowId,manual:true,reason:message.reason==='login'?'login':'key'};
          state.manualDraft=draft;state.paused='setup';break;
        }
        default:throw Error('UNKNOWN_METHOD');
      }
      return {snapshot:this.snapshot(state),...(job!==undefined?{job}:{}),...(draft!==undefined?{draft}:{})};
    },false,true);
  }
}
