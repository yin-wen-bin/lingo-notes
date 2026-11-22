import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyFontTheme, normalizeFontTheme, type FontTheme } from '../../shared/typography/theme';
import { api } from './cloud';
import type { Notice, Settings } from './types';

// Keep confirmed preferences in this account's mounted view only. Old reads and
// writes cannot change a newer selection or another account's document theme.
export function useFontTheme(accountId: string, onError: (error: unknown) => void, notify: (notice: Notice) => void) {
  const [theme, setTheme] = useState<FontTheme>('refined');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const confirmed = useRef<FontTheme>('refined');
  const version = useRef(0); const live = useRef(false); const saving = useRef(false);
  const display = useCallback((value: FontTheme) => { applyFontTheme(value); setTheme(value); }, []);

  useLayoutEffect(() => {
    live.current = true; ++version.current; saving.current = false; confirmed.current = 'refined';
    display('refined'); setBusy(false); setReady(false);
    return () => { live.current = false; ++version.current; saving.current = false; applyFontTheme('refined'); };
  }, [accountId, display]);

  const refresh = useCallback(async () => {
    if (!live.current || saving.current) return;
    const stamp = ++version.current;
    try {
      const settings = await api<Settings>('settings.get');
      if (!live.current || stamp !== version.current) return;
      confirmed.current = normalizeFontTheme(settings.font_theme); display(confirmed.current); setReady(true);
    } catch (error) {
      if (live.current && stamp === version.current) { setReady(true); onError(error); }
    }
  }, [display, onError]);

  useEffect(() => {
    void refresh();
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const visibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
  }, [accountId, refresh]);

  const choose = useCallback(async (value: FontTheme) => {
    if (!live.current || saving.current) return;
    const stamp = ++version.current; const previous = confirmed.current;
    saving.current = true; setBusy(true); display(value);
    try {
      await api<Settings>('settings.update', { font_theme: value });
      const settings = await api<Settings>('settings.get');
      if (!live.current || stamp !== version.current) return;
      if (normalizeFontTheme(settings.font_theme) !== value) throw new Error('FONT_THEME_NOT_CONFIRMED');
      confirmed.current = value; display(value);
      notify({ text: '字体方案已保存，会同步到扩展和学习中心。', tone: 'success' });
    } catch (error) {
      if (live.current && stamp === version.current) {
        display(previous); onError(error);
        notify({ text: '字体方案未能保存，已恢复上次设置，请稍后重试。', tone: 'error' });
      }
    } finally {
      if (live.current && stamp === version.current) { saving.current = false; setBusy(false); }
    }
  }, [display, notify, onError]);

  return { theme, busy, ready, choose };
}
