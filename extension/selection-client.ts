import type {QueueCommand,QueueIdentity,QueueReply,QueueSnapshot} from './selection-queue';

export type SelectionConnectionState='connecting'|'ready'|'retrying'|'closed';
const RETRY_DELAYS=[400,1000,2000,5000,10000];
const transportErrors=new Set(['QUEUE_UNAVAILABLE','UNTRUSTED_SENDER','SESSION_CHANGED']);

/** Reconnection only registers and synchronizes. A model permit is never replayed. */
export class SelectionQueueClient {
  readonly clientId=crypto.randomUUID();
  private windowId:number|null=null;
  private port:chrome.runtime.Port|null=null;
  private transportId:string|null=null;
  private owner:string|null=null;
  private ownerSet=false;
  private version=-1;
  private stopped=false;
  private generation=0;
  private connecting:Promise<void>|null=null;
  private registered:{port:chrome.runtime.Port;resolve:()=>void;reject:(error:Error)=>void}|null=null;
  private registrationReady=false;
  private pendingSnapshot:QueueSnapshot|null=null;
  private pending=new Set<(error:Error)=>void>();
  private retryTimer:ReturnType<typeof setTimeout>|null=null;
  private retryAttempt=0;
  private connectionState:SelectionConnectionState='closed';
  ready=false;
  get window(){return this.windowId;}
  constructor(private changed:(snapshot:QueueSnapshot)=>void,private unavailable:()=>void,private draft:(value:any)=>void,private stateChanged:(state:SelectionConnectionState)=>void=()=>{}){}
  private state(value:SelectionConnectionState){if(this.connectionState===value)return;this.connectionState=value;try{this.stateChanged(value);}catch{/* UI observers cannot break transport recovery. */}}
  private identity():QueueIdentity {if(this.windowId===null||!this.transportId)throw Error('QUEUE_UNAVAILABLE');return {clientId:this.clientId,windowId:this.windowId,owner:this.owner,transportId:this.transportId};}
  private valid(snapshot:QueueSnapshot){return !!snapshot&&snapshot.owner===this.owner&&Array.isArray(snapshot.waiting)&&Number.isInteger(snapshot.version);}
  private accept(snapshot:QueueSnapshot){
    if(!this.registrationReady||!this.ready||!this.valid(snapshot))throw Error('QUEUE_UNAVAILABLE');
    if(snapshot.version<this.version)return;this.version=snapshot.version;try{this.changed(snapshot);}catch{/* An observer must not strand a healthy connection. */}
  }
  private wait<T>(promise:Promise<T>,milliseconds:number):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);this.pending.delete(cancel);error?reject(error):resolve(value as T);};
      const cancel=(error:Error)=>finish(error),timer=setTimeout(()=>finish(Error('QUEUE_UNAVAILABLE')),milliseconds);
      this.pending.add(cancel);promise.then(value=>finish(undefined,value),error=>finish(Error(transportErrors.has(error?.message)?error.message:'QUEUE_UNAVAILABLE')));
    });
  }
  private retire(error:Error){
    const port=this.port;this.port=null;this.transportId=null;this.ready=false;this.registrationReady=false;this.pendingSnapshot=null;
    this.registered?.reject(error);this.registered=null;
    for(const cancel of [...this.pending])cancel(error);
    try{port?.disconnect();}catch{/* The browser may already have closed it. */}
  }
  private retry(){
    if(this.stopped||this.ready||this.retryTimer!==null)return;
    const generation=this.generation,delay=RETRY_DELAYS[Math.min(this.retryAttempt++,RETRY_DELAYS.length-1)];this.state('retrying');
    this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(!this.stopped&&generation===this.generation&&!this.ready)void this.ensureConnected().catch(()=>{});},delay);
  }
  private failed(error:Error,generation:number,port:chrome.runtime.Port|null){
    if(this.stopped||generation!==this.generation||port&&this.port!==port)return;
    this.retire(error);try{this.unavailable();}catch{}
    if(error.message!=='SESSION_CHANGED')this.retry();else this.state('closed');
  }
  private current(generation:number,port:chrome.runtime.Port){return !this.stopped&&generation===this.generation&&this.port===port;}
  async connect(owner:string|null){
    if(this.stopped)throw Error('QUEUE_UNAVAILABLE');
    if(!this.ownerSet||owner!==this.owner){
      ++this.generation;this.owner=owner;this.ownerSet=true;this.version=-1;
      if(this.retryTimer!==null)clearTimeout(this.retryTimer);this.retryTimer=null;this.retryAttempt=0;
      this.retire(Error('SESSION_CHANGED'));this.connecting=null;
    }
    return this.ensure(true);
  }
  ensureConnected():Promise<void>{return this.ensure(false);}
  private ensure(forceSync:boolean):Promise<void>{
    if(this.stopped)return Promise.reject(Error('QUEUE_UNAVAILABLE'));
    if(this.connecting)return this.connecting;
    if(this.ready&&!forceSync)return Promise.resolve();
    if(this.retryTimer!==null)clearTimeout(this.retryTimer);this.retryTimer=null;
    const generation=this.generation,opening=this.ready?this.syncCurrent(generation):this.open(generation);
    this.connecting=opening;
    void opening.then(()=>{if(this.connecting===opening)this.connecting=null;},()=>{if(this.connecting===opening)this.connecting=null;});
    return opening;
  }
  private async syncCurrent(generation:number){
    const port=this.port;if(!port)throw Error('QUEUE_UNAVAILABLE');
    try{const reply=await this.send('sync',{},generation,port);this.accept(reply.snapshot);}
    catch(error){this.failed(error as Error,generation,port);throw error;}
  }
  private async open(generation:number){
    let port:chrome.runtime.Port|null=null;this.state(this.retryAttempt?'retrying':'connecting');
    try{
      if(this.windowId===null){const window=await this.wait(chrome.windows.getCurrent(),10000);if(typeof window.id!=='number')throw Error('QUEUE_UNAVAILABLE');this.windowId=window.id;}
      if(this.stopped||generation!==this.generation)throw Error('SESSION_CHANGED');
      port=chrome.runtime.connect({name:'learning-panel'});this.port=port;this.transportId=crypto.randomUUID();const connected=port;
      connected.onMessage.addListener(message=>{
        if(!this.current(generation,connected))return;
        if(message.event==='selection-queue.registered'&&message.clientId===this.clientId&&message.owner===this.owner&&message.windowId===this.windowId&&message.transportId===this.transportId)this.registered?.resolve();
        if(message.event==='selection-queue.error')this.registered?.reject(Error(message.error??'QUEUE_UNAVAILABLE'));
        if(message.event==='selection-queue.changed'&&this.valid(message.snapshot)){
          if(this.ready){try{this.accept(message.snapshot);}catch{}}
          else if(this.registrationReady&&(!this.pendingSnapshot||message.snapshot.version>=this.pendingSnapshot.version))this.pendingSnapshot=message.snapshot;
        }
        if(message.event==='draft.changed'&&message.draft?.owner===this.owner&&message.draft?.windowId===this.windowId)try{this.draft(message.draft);}catch{}
      });
      connected.onDisconnect.addListener(()=>{if(this.current(generation,connected))this.failed(Error('QUEUE_UNAVAILABLE'),generation,connected);});
      let resolve!:()=>void,reject!:(error:Error)=>void;
      const acknowledgement=new Promise<void>((yes,no)=>{resolve=yes;reject=no;}),registration={port:connected,resolve,reject};this.registered=registration;
      const waiting=this.wait(acknowledgement,5000);
      try{try{connected.postMessage({kind:'selection-queue.register',...this.identity()});}catch{reject(Error('QUEUE_UNAVAILABLE'));}await waiting;}
      finally{if(this.registered===registration)this.registered=null;}
      if(!this.current(generation,connected))throw Error(generation!==this.generation?'SESSION_CHANGED':'QUEUE_UNAVAILABLE');
      this.registrationReady=true;
      const reply=await this.send('sync',{},generation,connected);
      const snapshot=this.pendingSnapshot&&this.pendingSnapshot.version>reply.snapshot.version?this.pendingSnapshot:reply.snapshot;
      this.pendingSnapshot=null;this.ready=true;this.retryAttempt=0;this.state('ready');this.accept(snapshot);
    }catch(error){this.failed(error as Error,generation,port);throw error;}
  }
  private async send(op:QueueCommand['op'],extra:Partial<QueueCommand>,generation:number,port:chrome.runtime.Port):Promise<QueueReply>{
    if(!this.current(generation,port)||!this.registrationReady)throw Error('QUEUE_UNAVAILABLE');
    let response:Promise<any>;try{response=chrome.runtime.sendMessage({...extra,kind:'selection-queue',...this.identity(),op});}catch{throw Error('QUEUE_UNAVAILABLE');}
    const reply=await this.wait(response,10000);
    if(!this.current(generation,port))throw Error(generation!==this.generation?'SESSION_CHANGED':'QUEUE_UNAVAILABLE');
    if(!reply?.ok)throw Error(reply?.error??'QUEUE_UNAVAILABLE');
    if(!this.valid(reply.result?.snapshot))throw Error('QUEUE_UNAVAILABLE');
    return reply.result;
  }
  async command(op:QueueCommand['op'],extra:Partial<QueueCommand>={}):Promise<QueueReply>{
    await this.ensureConnected();const generation=this.generation,port=this.port;if(!port)throw Error('QUEUE_UNAVAILABLE');
    try{const reply=await this.send(op,extra,generation,port);this.accept(reply.snapshot);return reply;}
    catch(error){if(transportErrors.has((error as Error).message))this.failed(error as Error,generation,port);throw error;}
  }
  close(){
    if(this.stopped)return;this.stopped=true;++this.generation;
    if(this.retryTimer!==null)clearTimeout(this.retryTimer);this.retryTimer=null;this.connecting=null;
    this.retire(Error('QUEUE_UNAVAILABLE'));this.state('closed');
  }
}
