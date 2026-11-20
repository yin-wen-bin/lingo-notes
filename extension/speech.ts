import {chooseVoice,pronunciation} from './learning-ui.ts';

export type PlaybackState='loading'|'speaking'|'ended'|'stopped'|'error';
type Update=(state:PlaybackState,message?:string)=>void;

export class WordSpeech{
  private token=0;
  private active:{key:object,update:Update,utterance?:SpeechSynthesisUtterance}|null=null;
  private abortWait:(()=>void)|null=null;
  private synth:SpeechSynthesis;
  private createUtterance:(text:string)=>SpeechSynthesisUtterance;
  constructor(synth:SpeechSynthesis,createUtterance:(text:string)=>SpeechSynthesisUtterance=text=>new SpeechSynthesisUtterance(text)){this.synth=synth;this.createUtterance=createUtterance;}
  stop(){
    ++this.token;this.abortWait?.();const active=this.active;this.active=null;
    this.synth.cancel();active?.update('stopped');
  }
  async toggle(key:object,term:string,reading:string,language:string,update:Update){
    if(this.active?.key===key){this.stop();return;}
    this.stop();const token=this.token;this.active={key,update};update('loading');
    try{
      const {lang,text}=pronunciation(term,reading,language);
      let voices=this.synth.getVoices();
      if(!voices.length){await this.waitForVoices();if(token!==this.token)return;voices=this.synth.getVoices();}
      const voice=chooseVoice(voices,lang);
      if(!voice){this.active=null;update('error',`当前浏览器没有${lang==='ja-JP'?'日语':'英语'}语音。请在 Windows 语言设置中添加对应语音后重新打开侧栏。`);return;}
      const utterance=this.createUtterance(text);utterance.lang=lang;utterance.voice=voice;utterance.rate=.85;
      this.active!.utterance=utterance;
      utterance.onstart=()=>{if(token===this.token)update('speaking');};
      utterance.onend=()=>{if(token===this.token){this.active=null;update('ended');}};
      utterance.onerror=event=>{if(token!==this.token)return;this.active=null;update(event.error==='canceled'||event.error==='interrupted'?'stopped':'error','发音未能播放，请检查声音或稍后重试。');};
      this.synth.resume();this.synth.speak(utterance);
    }catch{if(token===this.token){this.active=null;update('error','当前浏览器无法播放发音，请重新打开侧栏后重试。');}}
  }
  private waitForVoices(){
    return new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);this.synth.removeEventListener('voiceschanged',finish);this.abortWait=null;resolve();};
      const timer=setTimeout(finish,1500);this.abortWait=finish;this.synth.addEventListener('voiceschanged',finish);
    });
  }
}
