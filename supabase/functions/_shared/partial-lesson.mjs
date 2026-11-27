// Parse only finished JSON scalars; incomplete containers may expose finished children.
// Never repair strings, evaluate code, or promote this preview to a durable lesson.
export function partialLesson(raw) {
  if(typeof raw!=='string'||raw.length>180000)return null;
  const source=raw.trimStart().replace(/^```(?:json)?\s*/, '');let i=0;
  const skip=()=>{while(/\s/.test(source[i]??'')&&i<source.length)i++;};
  function value(depth=0){
    if(depth>12)throw Error();skip();const start=i,c=source[i];
    if(c==='"'){
      i++;let escaped=false;
      while(i<source.length){const ch=source[i++];if(ch==='"'&&!escaped)return {value:JSON.parse(source.slice(start,i)),complete:true};if(ch==='\\'&&!escaped)escaped=true;else escaped=false;}
      return {complete:false};
    }
    if(c==='{'||c==='['){
      const object=c==='{',out=object?Object.create(null):[],end=object?'}':']';i++;skip();
      if(source[i]===end){i++;return {value:out,complete:true};}
      while(i<source.length){
        let key;
        if(object){const k=value(depth+1);if(!k.complete||typeof k.value!=='string')return {value:out,complete:false};key=k.value;skip();if(source[i++]!==':')return {value:out,complete:false};}
        const child=value(depth+1);
        if(child.value!==undefined){if(object)out[key]=child.value;else out.push(child.value);}
        if(!child.complete)return {value:out,complete:false};skip();
        if(source[i]===end){i++;return {value:out,complete:true};}
        if(source[i++]!==',')return {value:out,complete:false};skip();
      }
      return {value:out,complete:false};
    }
    const match=source.slice(i).match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]])/);
    if(match){i+=match[1].length;return {value:JSON.parse(match[1]),complete:true};}
    return {complete:false};
  }
  try{
    const p=value().value;if(!p||typeof p!=='object')return null;
    const text=(v,max=5000)=>typeof v==='string'&&v.trim()&&v.length<=max;
    const examples=v=>Array.isArray(v)?v.filter(e=>text(e?.text)&&text(e?.translation)).slice(0,5).map(e=>({text:e.text,translation:e.translation,...(['en','ja'].includes(e.language)?{language:e.language}:{})})):[];
    const vocabulary=(Array.isArray(p.vocabulary)?p.vocabulary:[]).filter(v=>text(v?.term,300)&&text(v?.meaning)&&text(v?.pos,100)&&text(v?.reading,300)).slice(0,5).map(v=>({term:v.term,pos:v.pos,meaning:v.meaning,reading:v.reading,examples:examples(v.examples)}));
    const grammar=(Array.isArray(p.grammar)?p.grammar:[]).filter(g=>text(g?.point,500)&&text(g?.explanation)).slice(0,5).map(g=>({point:g.point,explanation:g.explanation,examples:examples(g.examples)}));
    if(!text(p.summary_zh)&&!vocabulary.length&&!grammar.length)return null;
    return {language:['en','ja','mixed'].includes(p.language)?p.language:'mixed',summary_zh:text(p.summary_zh)?p.summary_zh:'',vocabulary,grammar};
  }catch{return null;}
}
