export const normalizeText=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
export function sentenceContext(text:string,query:string,hint?:number):{context:string,status:string}{
  const body=text.normalize('NFKC').replace(/\s*\n\s*/gu,'\n').replace(/[^\S\n]+/gu,' ').trim(),searchable=body.replace(/\n/g,' '),needle=normalizeText(query);
  if(!needle)return {context:'',status:'not_found'};
  const hits:number[]=[];
  for(let from=0;from<body.length;){const index=searchable.indexOf(needle,from);if(index<0)break;from=index+Math.max(1,needle.length);
    const latin=/^[A-Za-z]/.test(needle),ends=/[A-Za-z]$/.test(needle);
    if((latin&&/[A-Za-z]/.test(body[index-1]??''))||(ends&&/[A-Za-z]/.test(body[index+needle.length]??'')))continue;
    hits.push(index);
  }
  if(!hits.length)return {context:'',status:'not_found'};
  let start=hits[0];
  if(hits.length>1){
    if(hint===undefined)return {context:'',status:'ambiguous'};
    const ordered=hits.map(i=>({i,d:Math.abs(i-hint)})).sort((a,b)=>a.d-b.d);
    if(ordered[0].d===ordered[1].d)return {context:'',status:'ambiguous'};start=ordered[0].i;
  }
  const segmenter=new Intl.Segmenter(/[\u3040-\u30ff]/u.test(body)?'ja':'en',{granularity:'sentence'});
  const segments=Array.from(segmenter.segment(body));
  const first=segments.findIndex(s=>s.index+s.segment.length>start);
  let last=first;while(last+1<segments.length&&segments[last+1].index<start+needle.length)last++;
  const left=segments[Math.max(0,first-1)].index;
  const right=last+2<segments.length?segments[last+2].index:body.length;
  let context=body.slice(left,right).trim();
  if(context.length>1500){const begin=Math.max(left,Math.min(start-500,right-1500));context=body.slice(begin,begin+1500);return {context,status:'truncated'};}
  return {context,status:'matched'};
}

export function cropBounds(rect:{x:number,y:number,width:number,height:number},viewport:{width:number,height:number},bitmap:{width:number,height:number}){
  if(![rect.x,rect.y,rect.width,rect.height,viewport.width,viewport.height,bitmap.width,bitmap.height].every(Number.isFinite)||viewport.width<=0||viewport.height<=0||rect.width<8||rect.height<8||rect.x<0||rect.y<0||rect.x+rect.width>viewport.width+1||rect.y+rect.height>viewport.height+1)throw new Error('INVALID_SELECTION');
  const sx=bitmap.width/viewport.width,sy=bitmap.height/viewport.height;
  const x=Math.floor(rect.x*sx),y=Math.floor(rect.y*sy);
  return {x,y,width:Math.min(bitmap.width,Math.ceil((rect.x+rect.width)*sx))-x,height:Math.min(bitmap.height,Math.ceil((rect.y+rect.height)*sy))-y};
}
