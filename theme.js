export const THEME_STORAGE_KEY = 'erjie-vault-multi-theme-v1';
export const DEFAULT_THEME = 'jade';

export function normalizeTheme(value) {
  return value === 'berry' ? 'berry' : DEFAULT_THEME;
}

export function readTheme(storage) {
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(storage, theme) {
  const selected = normalizeTheme(theme);
  storage.setItem(THEME_STORAGE_KEY, selected);
  return selected;
}
