import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.ts';
import zhCN from './locales/zh-CN.ts';
import { resolveMissingTranslation } from './missingTranslation';

/*
 * Hardcoded Chinese fallback dictionary.
 * Flattened from zh-CN.ts so every key has a Chinese fallback baked into the JS bundle —
 * no dependency on i18next resource loading. Built on first use rather than at module load:
 * zhCN itself is already resident as a resource, and a session that never misses a key never
 * needs the flattened copy.
 */
function flattenLocale(obj: Record<string, any>, prefix = ''): Record<string, string> {
  let result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      result = { ...result, ...flattenLocale(value, path) };
    } else {
      result[path] = String(value);
    }
  }
  return result;
}

let zhFallbacks: Record<string, string> | null = null;

const getZhFallbacks = (): Record<string, string> => {
  if (!zhFallbacks) {
    zhFallbacks = flattenLocale(zhCN);
  }
  return zhFallbacks;
};

/*
 * Indonesian ships as its own async chunk instead of riding the startup bundle: en and zh-CN
 * must stay static (fallbackLng and the hardcoded fallback above), but 'in' is only needed when
 * it is the active language. The command-palette search index loads the same chunk on its first
 * Indonesian query; one import, one download, shared by both.
 */
let indonesianLocalePromise: Promise<void> | null = null;

const ensureIndonesianLocale = (): Promise<void> => {
  if (!indonesianLocalePromise) {
    indonesianLocalePromise = import('./locales/in.ts').then((mod) => {
      i18n.addResourceBundle('in', 'translation', mod.default, true, true);
    }).catch(() => {
      // A failed load is retryable: drop the memo so a manual language switch can try again.
      indonesianLocalePromise = null;
    });
  }
  return indonesianLocalePromise;
};

export type AppLanguagePreference = 'system' | 'en' | 'zh-CN' | 'in';
export const APP_LANGUAGE_STORAGE_KEY = 'folia_app_language';

const isSupportedManualLanguage = (value: string | null | undefined): value is Exclude<AppLanguagePreference, 'system'> => (
  value === 'en' || value === 'zh-CN' || value === 'in'
);

const normalizeSupportedLanguage = (value: string | null | undefined): Exclude<AppLanguagePreference, 'system'> => {
  if (!value) {
    return 'en';
  }

  if (value === 'in' || value.toLowerCase().startsWith('id')) {
    return 'in';
  }

  if (value.toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }

  return 'en';
};

export const readStoredAppLanguagePreference = (): AppLanguagePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const saved = localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
  if (saved === 'system' || isSupportedManualLanguage(saved)) {
    return saved;
  }

  return 'system';
};

const initialLanguagePreference = readStoredAppLanguagePreference();

const syncDocumentLanguage = (value: string | null | undefined) => {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = normalizeSupportedLanguage(value);
};

const detectSystemLanguage = (): Exclude<AppLanguagePreference, 'system'> => {
  const detected = i18n.services.languageDetector?.detect();
  if (Array.isArray(detected)) {
    return normalizeSupportedLanguage(detected[0]);
  }

  return normalizeSupportedLanguage(detected ?? (typeof navigator !== 'undefined' ? navigator.language : 'en'));
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: en
      },
      'zh-CN': {
        translation: zhCN
      }
      // 'in' joins via ensureIndonesianLocale() below - see the note above flattenLocale.
    },
    fallbackLng: 'en',
    parseMissingKeyHandler: (key: string, defaultValue?: string): string => (
      resolveMissingTranslation(getZhFallbacks(), key, defaultValue)
    ),
    supportedLngs: ['en', 'zh-CN', 'in'],
    ...(initialLanguagePreference !== 'system' ? { lng: initialLanguagePreference } : {}),
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng'
    },
    interpolation: {
      escapeValue: false
    }
  });

/*
 * The Electron main process keeps its own tiny locale table for the tray menu and
 * native dialogs, and only learns the language through this IPC call. Pushing on every
 * `languageChanged` plus once at startup means a `system` preference reaches the tray
 * too, instead of only manual switches made in Settings.
 */
const pushLocaleToMainProcess = (value: string | null | undefined) => {
  if (typeof window === 'undefined') {
    return;
  }

  void window.electron?.setAppLocale?.(normalizeSupportedLanguage(value));
};

i18n.on('languageChanged', lng => {
  syncDocumentLanguage(lng);
  pushLocaleToMainProcess(lng);
});

syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
pushLocaleToMainProcess(i18n.resolvedLanguage ?? i18n.language);

// An Indonesian boot lands on the en/zh fallback chain until the chunk arrives (one local
// request away, precached under the PWA); changeLanguage then fires languageChanged and every
// subscriber re-renders with the real translations. Without it the app would stay on fallbacks.
// Checked against i18n.language, not resolvedLanguage: with no 'in' resources yet,
// resolvedLanguage reports the fallback ('en') and this branch would never run. Strictly 'in' -
// the codes the old static bundle served - so the trigger surface is unchanged.
if (i18n.language === 'in') {
  void ensureIndonesianLocale().then(() => i18n.changeLanguage('in'));
}

export const applyAppLanguagePreference = async (
  preference: AppLanguagePreference
): Promise<Exclude<AppLanguagePreference, 'system'>> => {
  if (typeof window !== 'undefined') {
    if (preference === 'system') {
      localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, preference);
      localStorage.removeItem('i18nextLng');
    } else {
      localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, preference);
    }
  }

  const nextLanguage = preference === 'system' ? detectSystemLanguage() : preference;
  // Switching to Indonesian has to wait for its chunk, or changeLanguage would resolve into a
  // language with no resources. On load failure the switch still proceeds: the result is the
  // same en/zh fallback rendering the boot path uses, not an error in the user's face.
  if (nextLanguage === 'in') {
    await ensureIndonesianLocale();
  }
  await i18n.changeLanguage(nextLanguage);
  if (typeof window !== 'undefined') {
    await window.electron?.setAppLocale?.(nextLanguage);
  }
  return nextLanguage;
};

export default i18n;
