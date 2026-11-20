import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT} from './cloud-config.mjs';
import {MODEL,deepseek,lessonMessages,parseLesson,safeError,decodePng} from '../supabase/functions/_shared/core.mjs';
import {partialLesson} from '../supabase/functions/_shared/partial-lesson.mjs';
const argument=(name,fallback)=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:fallback;};
const keyPath=argument('--key-file',process.env.DEEPSEEK_KEY_FILE);
if(!keyPath)throw Error('KEY_FILE_REQUIRED');
let key=readFileSync(keyPath,'utf8').trim();
if(!/^sk-[A-Za-z0-9_-]{16,250}$/.test(key))throw Error('INVALID_KEY_FILE');
const report={checked_at:new Date().toISOString(),model:MODEL,tests:[],live:process.argv.includes('--live')};
try{
 const started=performance.now();
 const response=await fetch('https://api.deepseek.com/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(`MODEL_LIST_HTTP_${response.status}`);
 const models=await response.json(),model=models.data?.find(m=>m.id===MODEL);
 if(!model)throw Error('MODEL_UNAVAILABLE');
 report.tests.push({kind:'model-list',passed:true,elapsed_ms:Math.round(performance.now()-started),input_modalities:model.input_modalities??[]});
 if(report.live){
   let firstReadable=null;const textStart=performance.now();
   const lesson=await deepseek({key,messages:lessonMessages({original_text:'She remained resilient despite the setbacks.',context:''}),signal:AbortSignal.timeout(110000),onDelta:raw=>{if(firstReadable===null&&partialLesson(raw)?.summary_zh)firstReadable=Math.round(performance.now()-textStart);}});
   mkdirSync(resolve(ROOT,'.cache'),{recursive:true});
   // Synthetic test output only, never a real user's saved learning material.
   writeFileSync(resolve(ROOT,'.cache/provider-synthetic-text.json'),JSON.stringify({text:lesson.text,usage:lesson.usage,model:lesson.model},null,2));
   const result=parseLesson(lesson.text);
   report.tests.push({kind:'synthetic-text',passed:true,first_readable_ms:firstReadable,complete_ms:Math.round(performance.now()-textStart),points:result.vocabulary.length+result.grammar.length,usage:lesson.usage,actual_model:lesson.model});
   const path=argument('--image',resolve(ROOT,'.cache/synthetic-language.png'));
   const image=`data:image/png;base64,${readFileSync(path).toString('base64')}`;decodePng(image);
   const ocrStart=performance.now();
   const ocr=await deepseek({key,json:false,messages:[{role:'system',content:'逐字识别图片中的文字，保持原文与换行，只返回识别文本。'},{role:'user',content:[{type:'text',text:'请识别图片中的英日语文字。'},{type:'image_url',image_url:{url:image}}]}],signal:AbortSignal.timeout(110000)});
   const passed=ocr.text.includes('I learn something new every day')&&ocr.text.includes('日本語');
   report.tests.push({kind:'synthetic-image',passed,complete_ms:Math.round(performance.now()-ocrStart),usage:ocr.usage,actual_model:ocr.model});
   if(!passed)throw Error('OCR_SYNTHETIC_EXPECTATION_FAILED');
 }
}catch(error){report.error=safeError(error);process.exitCode=1;}
finally{key='';mkdirSync(resolve(ROOT,'.cache'),{recursive:true});writeFileSync(resolve(ROOT,'.cache/provider-probe.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));}
