import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { speechContent } from './model.mjs';

type Speech = { active: string | null; toggle: (id: string, text: string, reading: string, language: string) => void; stop: () => void; available: boolean };
const SpeechContext = createContext<Speech>({ active: null, toggle() {}, stop() {}, available: false });
export function SpeechProvider({ children, onError }: { children: ReactNode; onError: (message: string) => void }) {
  const [active, setActive] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const generation = useRef(0);
  const available = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const stop = useCallback(() => { ++generation.current; current.current = null; setActive(null); if (available) window.speechSynthesis.cancel(); }, [available]);
  const toggle = useCallback((id: string, text: string, reading: string, language: string) => {
    if (!available) { onError('当前浏览器无法播放发音。'); return; }
    if (current.current === id) { stop(); return; }
    stop();
    const token = generation.current;
    const content = speechContent(text, reading, language);
    const utterance = new SpeechSynthesisUtterance(content.text);
    utterance.lang = content.lang; utterance.rate = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(value => value.lang === content.lang) || voices.find(value => value.lang.startsWith(content.lang.slice(0, 2)));
    if (voice) utterance.voice = voice;
    current.current = id; setActive(id);
    const end = () => { if (token === generation.current) { current.current = null; setActive(null); } };
    utterance.onend = end;
    utterance.onerror = event => { if (token !== generation.current) return; end(); if (!['canceled', 'interrupted'].includes(event.error)) onError('发音未能播放，请检查静音设置和语音后重试。'); };
    // Keep speak() in the button gesture; awaiting voice discovery prevents playback on iPhone.
    try { window.speechSynthesis.resume(); window.speechSynthesis.speak(utterance); } catch { end(); onError('暂时无法播放发音，请再试一次。'); }
  }, [available, onError, stop]);
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); if (available) window.speechSynthesis.cancel(); };
  }, [stop, available]);
  return <SpeechContext.Provider value={{ active, toggle, stop, available }}>{children}</SpeechContext.Provider>;
}
export const useSpeech = () => useContext(SpeechContext);
