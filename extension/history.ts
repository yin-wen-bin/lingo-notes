type Page<T>={items:T[],has_more:boolean};
type Snapshot<T>=Page<T>&{query:string,scroll:number};

// Keep the unfiltered view and ignore replies from superseded searches.
export class HistoryList<T>{
  state:Snapshot<T>={items:[],has_more:false,query:'',scroll:0};
  loading=false;
  private token=0;
  private loaded=false;
  private unfiltered:Snapshot<T>|null=null;
  private fetchPage:(query:string,offset:number)=>Promise<Page<T>>;
  constructor(fetchPage:(query:string,offset:number)=>Promise<Page<T>>){this.fetchPage=fetchPage;}
  clear(){++this.token;this.loading=false;this.loaded=false;this.unfiltered=null;this.state={items:[],has_more:false,query:'',scroll:0};}
  remove(matches:(item:T)=>boolean){
    ++this.token;this.loading=false;
    this.state={...this.state,items:this.state.items.filter(item=>!matches(item))};
    if(this.unfiltered)this.unfiltered={...this.unfiltered,items:this.unfiltered.items.filter(item=>!matches(item))};
  }
  async load(query:string,append=false,scroll=0):Promise<boolean>{
    query=append?this.state.query:query.trim();
    if(append&&(this.loading||!this.state.has_more))return false;
    if(!append&&query&&this.state.query===''&&this.loaded&&!this.loading)this.unfiltered={...this.state,items:[...this.state.items],scroll};
    const token=++this.token;
    if(!append&&!query&&this.state.query&&this.unfiltered){
      this.state=this.unfiltered;this.unfiltered=null;this.loading=false;this.loaded=true;return true;
    }
    const previous=append?this.state.items:[];
    this.state={...this.state,query};this.loading=true;
    try{
      const page=await this.fetchPage(query,previous.length);
      if(token!==this.token)return false;
      this.state={query,items:[...previous,...page.items],has_more:page.has_more,scroll:append?scroll:0};this.loaded=true;
      return true;
    }catch(error){if(token===this.token)throw error;return false;}
    finally{if(token===this.token)this.loading=false;}
  }
}
