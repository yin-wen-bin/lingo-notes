export const FONT_THEMES = [
  { id: 'handwritten', label: '手写感', description: '中文文楷 · 英文 Lora · 日文 Klee One' },
  { id: 'bookish', label: '书卷感', description: '中文 Noto Serif SC · 英文 Literata · 日文 Noto Serif JP' },
  { id: 'clean', label: '清爽自然', description: '中文 Noto Sans SC · 英文 DM Sans · 日文 Zen Kaku Gothic New' },
] as const;

export type FontTheme = typeof FONT_THEMES[number]['id'];

export function normalizeFontTheme(value: unknown): FontTheme {
  return FONT_THEMES.some(theme => theme.id === value) ? value as FontTheme : 'clean';
}

export function applyFontTheme(theme: FontTheme): void {
  document.documentElement.dataset.fontTheme = normalizeFontTheme(theme);
}
