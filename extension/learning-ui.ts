// Han characters are shared by Chinese and Japanese; absence of kana is not
// evidence that a Japanese word is invalid. Preserve the user's original text.
export function hasLearningText(text:string){
  return /[\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text.normalize('NFKC'));
}

export function pronunciation(term:string,reading:string,language:string){
  const normalized=term.normalize('NFKC');
  const japanese=/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(normalized);
  const lang=japanese?'ja-JP':/[\p{Script=Latin}]/u.test(normalized)?'en-US':language==='ja'?'ja-JP':'en-US';
  const kana=reading.normalize('NFKC').trim();
  return {lang,text:lang==='ja-JP'&&/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(kana)&&/^[\p{Script=Hiragana}\p{Script=Katakana}\sー・]+$/u.test(kana)?kana:term};
}

export function chooseVoice<T extends {lang:string,localService:boolean,default:boolean}>(voices:T[],lang:string):T|undefined{
  const normalized=lang.toLowerCase(),base=normalized.split('-')[0];
  return voices.filter(v=>v.lang.toLowerCase().replaceAll('_','-').split('-')[0]===base)
    .sort((a,b)=>score(b)-score(a))[0];
  function score(v:T){return Number(v.localService)*4+Number(v.lang.toLowerCase().replaceAll('_','-')===normalized)*2+Number(v.default);}
}
