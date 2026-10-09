import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../locales/en.json";
import hi from "../locales/hi.json";
import te from "../locales/te.json";

export const LANGUAGE_STORAGE_KEY = "app_language";
export const DEFAULT_LANGUAGE = "en";

export const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "te", label: "తెలుగు" },
] as const;

export type AppLanguage = (typeof LANGUAGE_OPTIONS)[number]["code"];

const resources = {
  en: { translation: en },
  hi: { translation: hi },
  te: { translation: te },
};

void i18n.use(initReactI18next).init({
  compatibilityJSON: "v4",
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

// export async function loadStoredLanguage() {
//   const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
//   const next = LANGUAGE_OPTIONS.some((item) => item.code === stored)
//     ? (stored as AppLanguage)
//     : DEFAULT_LANGUAGE;

//   if (i18n.language !== next) {
//     await i18n.changeLanguage(next);
//   }

//   return next;
// }

export async function loadStoredLanguage() {
  if (Platform.OS === "web" && typeof window === "undefined") {
    return DEFAULT_LANGUAGE;
  }

  try {
    const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);

    const next = LANGUAGE_OPTIONS.some((item) => item.code === stored)
      ? (stored as AppLanguage)
      : DEFAULT_LANGUAGE;

    if (i18n.language !== next) {
      await i18n.changeLanguage(next);
    }

    return next;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Changes the in-memory i18n language before persisting it.  A picker must
 * never wait for AsyncStorage before its labels and selected value update.
 */
export function setAppLanguage(language: AppLanguage) {
  const languageChanged = i18n.changeLanguage(language);
  // Persistence is deliberately non-blocking.  The app has already switched
  // language locally, and a failed local write should not undo that choice.
  void AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, language).catch(() => undefined);
  return languageChanged;
}

export function getLanguageLabel(language?: string | null) {
  return (
    LANGUAGE_OPTIONS.find((item) => item.code === language)?.label ?? "English"
  );
}

//void loadStoredLanguage();

export default i18n;
