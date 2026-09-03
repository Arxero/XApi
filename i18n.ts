import enMessages from './_locales/en/messages.json';
import zhCNMessages from './_locales/zh_CN/messages.json';

export type AppLanguage = 'system' | 'en' | 'zh_CN';

export const LANGUAGE_STORAGE_KEY = 'appLanguage';

const MESSAGE_MAP: Record<Exclude<AppLanguage, 'system'>, Record<string, { message: string }>> = {
  en: enMessages,
  zh_CN: zhCNMessages,
};

const originalGetMessage = chrome.i18n.getMessage.bind(chrome.i18n);
let activeLanguage: AppLanguage = 'system';

const formatMessage = (message: string, substitutions?: string | string[]) => {
  if (substitutions === undefined) return message;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return message.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
};

export const applyLanguage = (language: AppLanguage) => {
  activeLanguage = language;
  chrome.i18n.getMessage = ((key: string, substitutions?: string | string[]) => {
    if (activeLanguage !== 'system') {
      const message = MESSAGE_MAP[activeLanguage]?.[key]?.message;
      if (message) return formatMessage(message, substitutions);
    }
    return originalGetMessage(key, substitutions as any);
  }) as typeof chrome.i18n.getMessage;
};

applyLanguage('en');
