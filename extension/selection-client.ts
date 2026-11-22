import type {QueueCommand,QueueIdentity,QueueReply,QueueSnapshot} from './selection-queue';

/** The background owns the queue. A panel may post a model request only after an explicit grant. */
export class SelectionQueueClient {
  readonly clientId=crypto.randomUUID();
  private windowId:number|null=null;
  private port:chrome.runtime.Port|null=null;
  private owner:string|null=null;
  private version=-1;
  private stopped=false;
  private generation=0;
  private connecting:Promise<void>|null=null;
  private registered:((error?:Error)=>void)|null=null;
  private registrationReady=false;
  ready=false;
  get window(){return this.windowId;}
  constructor(private changed:(snapshot:QueueSnapshot)=>void,private unavailable:()=>void,private draft:(value:any)=>void){}
  private identity():QueueIdentity {if(this.windowId===null)throw Error('QUEUE_UNAVAILABLE');return {clientId:this.clientId,windowId:this.windowId,owner:this.owner};}
  private accept(snapshot:QueueSnapshot){
    if(!this.registrationReady||!snapshot||snapshot.owner!==this.owner||!Array.isArray(snapshot.waiting)||!Number.isInteger(snapshot.version))throw Error('QUEUE_UNAVAILABLE');
    this.ready=true;if(snapshot.version<this.version)return;this.version=snapshot.version;this.changed(snapshot);
  }
  async connect(owner:string|null){
    const generation=++this.generation;this.owner=owner;this.version=-1;this.ready=false;this.registrationReady=false;this.registered?.(Error('SESSION_CHANGED'));
    if(this.connecting)await this.connecting.catch(()=>{});
    if(generation!==this.generation)throw Error('SESSION_CHANGED');
    const opening=this.open(generation);this.connecting=opening;
    try{await opening;}finally{if(this.connecting===opening)this.connecting=null;}
    if(generation!==this.generation)throw Error('SESSION_CHANGED');await this.command('sync');
  }
  private async open(generation=this.generation){
    if(this.windowId===null){const window=await chrome.windows.getCurrent();if(typeof window.id!=='number')throw Error('QUEUE_UNAVAILABLE');this.windowId=window.id;}
    if(this.stopped||generation!==this.generation)throw Error('SESSION_CHANGED');
    if(!this.port){
      const port=chrome.runtime.connect({name:'learning-panel'});this.port=port;
      port.onMessage.addListener(message=>{
        if(message.event==='selection-queue.registered'&&message.clientId===this.clientId&&message.owner===this.owner)this.registered?.();
        if(message.event==='selection-queue.error')this.registered?.(Error(message.error??'QUEUE_UNAVAILABLE'));
        if(message.event==='selection-queue.changed'){try{this.accept(message.snapshot);}catch{/* A stale owner broadcast is not actionable. */}}
        if(message.event==='draft.changed')this.draft(message.draft);
      });
      port.onDisconnect.addListener(()=>{if(this.port!==port)return;this.port=null;this.ready=false;this.registrationReady=false;this.registered?.(Error('QUEUE_UNAVAILABLE'));this.unavailable();if(!this.stopped)setTimeout(()=>void this.connect(this.owner).catch(()=>{}),400);});
    }
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.registered=null;reject(Error('QUEUE_UNAVAILABLE'));},5000);this.registered=(error)=>{clearTimeout(timer);this.registered=null;error?reject(error):resolve();};this.port!.postMessage({kind:'selection-queue.register',...this.identity()});});
    if(generation!==this.generation)throw Error('SESSION_CHANGED');this.registrationReady=true;
  }
  async command(op:QueueCommand['op'],extra:Partial<QueueCommand>={}):Promise<QueueReply>{
    if(this.stopped)throw Error('QUEUE_UNAVAILABLE');
    if(!this.registrationReady){if(this.connecting)await this.connecting;else await this.open();}
    const generation=this.generation,reply=await chrome.runtime.sendMessage({kind:'selection-queue',...this.identity(),...extra,op});
    if(generation!==this.generation)throw Error('SESSION_CHANGED');
    if(!reply?.ok)throw Error(reply?.error??'QUEUE_UNAVAILABLE');
    this.accept(reply.result?.snapshot);return reply.result;
  }
  close(){this.stopped=true;this.ready=false;this.port?.disconnect();this.port=null;}
}
