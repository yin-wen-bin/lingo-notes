import type {QueueJob,QueueSnapshot} from './selection-queue';

/** Only a new right-click intent for this window may move its local navigation. */
export class SelectionPresentationCursor {
  private sequence=0;
  reset(){this.sequence=0;}
  take(snapshot:QueueSnapshot,windowId:number|null):QueueJob|null {
    if(windowId===null)return null;
    const key=String(windowId),intent=snapshot.presentations?.[key];
    if(!intent||intent.windowId!==windowId||intent.sequence<=Math.max(this.sequence,snapshot.presented?.[key]??0))return null;
    this.sequence=intent.sequence;
    return [...snapshot.waiting,snapshot.active,snapshot.last].find(job=>job?.id===intent.id)??intent;
  }
}

export function hasUnsubmittedContent(snapshot:{current?:any;stage:string;retryOpen:boolean;cropped?:string|null;fields:Record<string,string>}):boolean {
  if(snapshot.retryOpen||snapshot.stage==='imageStage'&&!!snapshot.cropped)return true;
  if(snapshot.current&&['saved','processing'].includes(snapshot.current.status))return false;
  return snapshot.retryOpen||snapshot.stage==='imageStage'&&!!snapshot.cropped||snapshot.current?.status==='awaiting_review'||snapshot.stage==='composer'&&!!snapshot.fields.sourceText?.trim();
}

type RecordNotice={recordId:string;revision:number;status:string};
/** Retry only a deduplicated history invalidation after reconnect, never a model request. */
export class RecordChangeNotifier {
  private signatures=new Map<string,string>();
  private pending=new Map<string,RecordNotice>();
  private running:Promise<void>|null=null;
  private generation=0;
  private send:(notice:RecordNotice)=>Promise<unknown>;
  constructor(send:(notice:RecordNotice)=>Promise<unknown>){this.send=send;}
  reset(){++this.generation;this.signatures.clear();this.pending.clear();this.running=null;}
  changed(notice:RecordNotice){
    const signature=JSON.stringify([notice.revision,notice.status]);if(this.signatures.get(notice.recordId)===signature)return false;
    this.signatures.set(notice.recordId,signature);this.pending.set(notice.recordId,notice);return true;
  }
  async flush(){
    if(this.running)return this.running;
    const generation=this.generation;let succeeded=true;
    const operation=(async()=>{for(const [id,notice] of [...this.pending]){
      if(generation!==this.generation)return;
      try{await this.send(notice);}catch{succeeded=false;return;}
      if(generation!==this.generation)return;if(this.pending.get(id)===notice)this.pending.delete(id);
    }})();
    this.running=operation;await operation;
    if(this.running===operation){this.running=null;if(succeeded&&generation===this.generation&&this.pending.size)void this.flush();}
  }
}
