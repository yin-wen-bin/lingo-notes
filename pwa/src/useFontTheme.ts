import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyFontTheme, normalizeFontTheme, type FontTheme } from '../../shared/typography/theme';
import { api } from './cloud';
import type { Notice, Settings } from './types';

export function useFontTheme(
  settings: Settings | undefined,
  onSaved: (settings: Settings) => void,
  onError: (error: unknown) => void,
  notify: (notice: Notice) => void
) {
  const [preview, setPreview] = useState<FontTheme | null>(null);
  const saving = useRef(false);
  const live = useRef(true);
  const theme = preview ?? normalizeFontTheme(settings?.font_theme);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useLayoutEffect(() => { applyFontTheme(theme); }, [theme]);
  useLayoutEffect(() => () => applyFontTheme('refined'), []);

  async function choose(value: FontTheme) {
    if (!settings || saving.current) return;
    saving.current = true;
    setPreview(value);
    try {
      await api<Settings>('settings.update', {font_theme:value});
      const confirmed = await api<Settings>('settings.get');
      if (!live.current) return;
      if (normalizeFontTheme(confirmed.font_theme) !== value) throw new Error('FONT_THEME_NOT_CONFIRMED');
      onSaved(confirmed);
      notify({text:'字体方案已保存，会同步到扩展和学习中心。',tone:'success'});
    } catch (error) {
      if (live.current) {
        onError(error);
        notify({text:'字体方案未能保存，已恢复上次设置，请稍后重试。',tone:'error'});
      }
    } finally {
      saving.current = false;
      if (live.current) setPreview(null);
    }
  }

  return {theme, busy:preview !== null, ready:Boolean(settings), choose};
}
