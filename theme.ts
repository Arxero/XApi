export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'colorTheme';

export const normalizeTheme = (value: unknown): Theme =>
  value === 'light' ? 'light' : 'dark';

export const applyTheme = (theme: Theme) => {
  if (typeof document === 'undefined') return;

  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.classList.toggle('dark', normalizedTheme === 'dark');
  document.documentElement.style.colorScheme = normalizedTheme;
};
