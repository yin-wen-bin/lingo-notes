type Page<T>={items:T[],has_more:boolean};
type Snapshot<T>=Page<T>&{query:string,scroll:number};

// Keep the unfiltered view and ignore replies from superseded searches.
export class HistoryList<T>{
  state:Snapshot<T>={items:[],has_more:false,query:'',scroll:0};
  loading=false;
  private token=0;
  private loaded=false;
  private failed=false;
  private dirtyVersion=0;
  private stateVersion=0;
  private unfilteredVersion=0;
  private unfiltered:Snapshot<T>|null=null;
  private fetchPage:(query:string,offset:number)=>Promise<Page<T>>;
  constructor(fetchPage:(query:string,offset:number)=>Promise<Page<T>>){this.fetchPage=fetchPage;}
  get hasLoaded(){return this.loaded&&!this.failed;}
  get needsRefresh(){return this.stateVersion!==this.dirtyVersion;}
  markDirty(){++this.dirtyVersion;}
  rememberScroll(scroll:number){if(Number.isFinite(scroll))this.state={...this.state,scroll:Math.max(0,scroll)};}
  clear(){++this.token;this.loading=false;this.loaded=false;this.failed=false;this.dirtyVersion=0;this.stateVersion=0;this.unfilteredVersion=0;this.unfiltered=null;this.state={items:[],has_more:false,query:'',scroll:0};}
  replace(matches:(item:T)=>boolean,replacement:T){
    this.state={...this.state,items:this.state.items.map(item=>matches(item)?replacement:item)};
    if(this.unfiltered)this.unfiltered={...this.unfiltered,items:this.unfiltered.items.map(item=>matches(item)?replacement:item)};
  }
  remove(matches:(item:T)=>boolean){
    ++this.token;this.loading=false;
    this.state={...this.state,items:this.state.items.filter(item=>!matches(item))};
    if(this.unfiltered)this.unfiltered={...this.unfiltered,items:this.unfiltered.items.filter(item=>!matches(item))};
  }
  async load(query:string,append=false,scroll=0):Promise<boolean>{
    query=append?this.state.query:query.trim();
    if(append&&(this.loading||!this.state.has_more))return false;
    if(append&&this.needsRefresh){if(!await this.refresh())return false;return this.load(this.state.query,true,scroll);}
    if(!append&&query&&this.state.query===''&&this.loaded&&!this.loading){this.unfiltered={...this.state,items:[...this.state.items],scroll};this.unfilteredVersion=this.stateVersion;}
    const token=++this.token,version=this.dirtyVersion;
    if(!append&&!query&&this.state.query&&this.unfiltered){
      this.state=this.unfiltered;this.stateVersion=this.unfilteredVersion;this.unfiltered=null;this.loading=false;this.loaded=true;this.failed=false;return this.needsRefresh?this.refresh():true;
    }
    const previous=append?this.state.items:[];
    this.state={...this.state,query};this.loading=true;
    try{
      const page=await this.fetchPage(query,previous.length);
      if(token!==this.token)return false;
      this.state={query,items:[...previous,...page.items],has_more:page.has_more,scroll:append?scroll:0};this.loaded=true;this.failed=false;if(!append)this.stateVersion=version;
      return true;
    }catch(error){if(token===this.token){this.failed=true;throw error;}return false;}
    finally{if(token===this.token)this.loading=false;}
  }
  // Re-read the whole loaded window before committing; a failed refresh keeps the cached page intact.
  async refresh():Promise<boolean>{
    const token=++this.token,version=this.dirtyVersion,{query,scroll}=this.state,target=Math.max(1,this.state.items.length);
    const items:T[]=[];let has_more=false;this.loading=true;
    try{
      do{
        const page=await this.fetchPage(query,items.length);if(token!==this.token)return false;
        items.push(...page.items);has_more=page.has_more;
        if(!page.items.length)break;
      }while(has_more&&items.length<target);
      this.state={query,scroll,items,has_more};this.loaded=true;this.failed=false;this.stateVersion=version;return true;
    }catch(error){if(token===this.token)throw error;return false;}
    finally{if(token===this.token)this.loading=false;}
  }
}
