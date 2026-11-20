import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT} from './cloud-config.mjs';
import {parseOptions,safeCode} from './cloud-smoke.mjs';
import {deepseek,lessonMessages,parseLesson,lessonDiagnostics,sseEvents,MODEL,TEMPLATE_VERSION} from '../supabase/functions/_shared/core.mjs';
import {partialLesson} from '../supabase/functions/_shared/partial-lesson.mjs';

const IDS=['ja-sentence-02','ja-sentence-03','ja-sentence-05'];
const requireThat=(condition,code)=>{if(!condition)throw Error(code);};
export function usageOnly(value){
  if(!value||typeof value!=='object')return null;
  const out={};
  for(const key of ['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens'])if(Number.isSafeInteger(value[key])&&value[key]>=0)out[key]=value[key];
  if(Number.isSafeInteger(value.completion_tokens_details?.reasoning_tokens)&&value.completion_tokens_details.reasoning_tokens>=0)out.reasoning_tokens=value.completion_tokens_details.reasoning_tokens;
  return Object.keys(out).length?out:null;
}

export async function runCompare(options,{onProgress=()=>{}}={}){
  requireThat(options.run===true,'RUN_FLAG_REQUIRED');requireThat(options.liveKeyFile,'EXPLICIT_KEY_FILE_REQUIRED');
  const fixture=JSON.parse(readFileSync(resolve(ROOT,'test/fixtures/quality-language-ja.json'),'utf8'));
  const fast=JSON.parse(readFileSync(resolve(ROOT,'.cache/quality-language-recheck.json'),'utf8'));
  requireThat(TEMPLATE_VERSION==='lingo-cloud-3'&&fast.template_version===TEMPLATE_VERSION,'PROMPT_VERSION_MISMATCH');
  const cases=IDS.map(id=>({fixture:fixture.cases.find(sample=>sample.id===id),fast:fast.samples.find(sample=>sample.id===id)}));
  requireThat(cases.every(item=>item.fixture&&item.fast),'COMPARISON_SAMPLE_MISSING');
  const report={mode:'local-direct-provider-thinking-comparison',model:MODEL,template_version:TEMPLATE_VERSION,temperature:0,temperature_note:'Sent as 0 in both modes; DeepSeek documents that temperature has no effect in thinking mode.',thinking:'enabled',max_tokens:12000,deadline_ms:120000,request_limit:3,model_requests_attempted:0,automatic_retries:0,fast_source:'.cache/quality-language-recheck.json',fast_calls:0,reasoning_saved:false,quality_status:'manual_review_required',started_at:new Date().toISOString(),samples:[]};
  const output=resolve(ROOT,'.cache/quality-thinking-compare.json');
  const save=()=>{mkdirSync(resolve(ROOT,'.cache'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');};
  let key='';
  try{
    try{key=readFileSync(resolve(options.liveKeyFile),'utf8').replace(/^\uFEFF/,'').trim();}catch{throw Error('KEY_FILE_UNREADABLE');}
    requireThat(/^sk-[A-Za-z0-9_-]{16,250}$/.test(key),'INVALID_KEY_FILE');
    for(const item of cases){
      const started=performance.now(),signal=AbortSignal.timeout(120000);let first=null,observer=Promise.resolve(),calls=0,metadata={usage:null};
      const outcome={id:item.fixture.id,input:item.fixture.text,context:item.fixture.context,fast:{schema_passed:item.fast.schema_passed,result:item.fast.result,first_readable_ms:item.fast.first_readable_ms,complete_ms:item.fast.complete_ms,usage:item.fast.usage},thinking:{schema_passed:false,first_readable_ms:null,complete_ms:null,usage:null,provider_usage:null}};
      onProgress({id:outcome.id,status:'started',request_number:report.model_requests_attempted+1});
      try{
        const response=await deepseek({key,messages:lessonMessages({original_text:item.fixture.text,context:item.fixture.context}),signal,onMetadata:value=>{metadata=value;},onDelta:raw=>{if(first===null&&partialLesson(raw)?.summary_zh)first=Math.round(performance.now()-started);},fetchFn:async(url,init)=>{
          requireThat(++calls===1&&report.model_requests_attempted<3,'MODEL_REQUEST_LIMIT');
          const body=JSON.parse(init.body);requireThat(body.model===MODEL&&body.thinking?.type==='disabled'&&body.temperature===0,'PRODUCTION_REQUEST_CHANGED');
          // Comparison-only override: production core and its disabled-thinking default are unchanged.
          body.thinking={type:'enabled'};body.max_tokens=12000;report.model_requests_attempted++;save();
          const fetched=await fetch(url,{...init,body:JSON.stringify(body)});
          if(!fetched.ok||!fetched.body)return fetched;
          const [content,observed]=fetched.body.tee();
          observer=(async()=>{
            try{for await(const data of sseEvents(observed)){
              if(data==='[DONE]')break;
              let event;try{event=JSON.parse(data);}catch{continue;}
              // Never retain or log reasoning_content, prompts, or complete stream chunks.
              if(event.usage)outcome.thinking.provider_usage=usageOnly(event.usage);
            }}catch{outcome.thinking.usage_observation_interrupted=true;}
          })();
          return new Response(content,{status:fetched.status,statusText:fetched.statusText,headers:fetched.headers});
        }});
        outcome.thinking.first_readable_ms=first;outcome.thinking.complete_ms=Math.round(performance.now()-started);outcome.thinking.usage=response.usage;
        try{outcome.thinking.result=parseLesson(response.text);outcome.thinking.schema_passed=true;}
        catch(error){outcome.thinking.error=safeCode(error);outcome.thinking.error_details=lessonDiagnostics(error);try{outcome.thinking.final_json=JSON.parse(response.text);}catch{}}
      }catch(error){outcome.thinking.error=signal.aborted?'REQUEST_TIMEOUT':safeCode(error);outcome.thinking.error_details=lessonDiagnostics(error);outcome.thinking.first_readable_ms=first;outcome.thinking.usage=metadata.usage??null;}
      finally{await observer;outcome.thinking.elapsed_ms=Math.round(performance.now()-started);report.samples.push(outcome);save();}
      onProgress({id:outcome.id,status:'finished',schema_passed:outcome.thinking.schema_passed,error:outcome.thinking.error??null,first_readable_ms:outcome.thinking.first_readable_ms,complete_ms:outcome.thinking.complete_ms,usage:outcome.thinking.usage,provider_usage:outcome.thinking.provider_usage});
    }
  }finally{key='';report.completed_at=new Date().toISOString();save();}
  return report;
}

export async function main(args=process.argv.slice(2),{log=console.log,runner=runCompare}={}){
  const options=parseOptions(args);
  if(!options.run||options.help){log(JSON.stringify({executed:false,usage:'node scripts/cloud-thinking-compare.mjs --run --live-key-file <explicit-key-file>',paid_calls:3,retries:0,fast_calls:0,production_changes:false,reasoning_saved:false}));return 0;}
  requireThat(options.liveKeyFile,'EXPLICIT_KEY_FILE_REQUIRED');
  const report=await runner(options,{onProgress:value=>log(JSON.stringify(value))});
  log(JSON.stringify({model_requests_attempted:report.model_requests_attempted,automatic_retries:report.automatic_retries,quality_status:report.quality_status,schema_passed:report.samples.filter(sample=>sample.thinking.schema_passed).length,output:'.cache/quality-thinking-compare.json'}));
  return report.samples.length===3&&report.samples.every(sample=>sample.thinking.schema_passed)?0:1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().then(code=>{process.exitCode=code;},error=>{console.error(JSON.stringify({error:safeCode(error)}));process.exitCode=1;});
}
