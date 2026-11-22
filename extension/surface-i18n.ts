export type SurfaceLanguage = 'zh' | 'ja' | 'en';
export const normalizeUiLanguage = (value:unknown):SurfaceLanguage => value==='ja'||value==='en'?value:'zh';

const messages = {
  zh: {contextTitle:'用 Lingo Notes 学习“%s”',captureHint:'拖动框选 · Esc 取消'},
  ja: {contextTitle:'Lingo Notes で「%s」を学ぶ',captureHint:'ドラッグして範囲を選択 · Esc でキャンセル'},
  en: {contextTitle:'Learn “%s” with Lingo Notes',captureHint:'Drag to select · Esc to cancel'},
} as const;
export function surfaceText(language:unknown,key:keyof typeof messages.zh):string {
  return messages[normalizeUiLanguage(language)][key];
}
// Only the currently authenticated account may supply the browser-wide label.
export function cachedUiLanguage(cache:unknown,owner:string|null):SurfaceLanguage {
  if(!owner||!cache||typeof cache!=='object')return 'zh';
  const value=cache as {owner?:unknown,language?:unknown};
  return value.owner===owner?normalizeUiLanguage(value.language):'zh';
}
