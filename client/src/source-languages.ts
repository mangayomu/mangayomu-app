const STORAGE_KEY_PREFIX = "mangayomu.source-language.";

export function getSourceLanguage(source: string, languages: Array<{ code: string }>, defaultLanguage: string): string {
  try {
    const language = localStorage.getItem(STORAGE_KEY_PREFIX + source);
    if (language && languages.some((item) => item.code === language)) return language;
    return defaultLanguage;
  } catch {
    return defaultLanguage;
  }
}

export function setSourceLanguage(source: string, language: string): void {
  try { localStorage.setItem(STORAGE_KEY_PREFIX + source, language); } catch {}
}
