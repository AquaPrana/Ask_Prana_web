import AsyncStorage from "@react-native-async-storage/async-storage";

/** Ask Prana conversation languages (codes). UI i18n remains en/hi/te. */
export type AskPranaSpeechLanguageCode =
  | "en"
  | "te"
  | "hi";

export type AskPranaLanguageOption = {
  code: AskPranaSpeechLanguageCode;
  /** Native display name for the selector */
  nativeLabel: string;
  /** English label sent to the LLM */
  llmLabel: string;
  /** BCP-47 for device TTS / STT hints */
  bcp47: string;
  /** OpenAI transcription language code when supported */
  openaiStt?: string;
  /** Whether on-device TTS is commonly available */
  deviceTtsLikely: boolean;
  /** Primary launch languages vs structured for later */
  primary: boolean;
};

export const ASK_PRANA_LANGUAGE_OPTIONS: readonly AskPranaLanguageOption[] = [
  {
    code: "en",
    nativeLabel: "English",
    llmLabel: "English",
    bcp47: "en-IN",
    openaiStt: "en",
    deviceTtsLikely: true,
    primary: true,
  },
  {
    code: "te",
    nativeLabel: "తెలుగు",
    llmLabel: "Telugu",
    bcp47: "te-IN",
    openaiStt: "te",
    deviceTtsLikely: true,
    primary: true,
  },
  {
    code: "hi",
    nativeLabel: "हिन्दी",
    llmLabel: "Hindi",
    bcp47: "hi-IN",
    openaiStt: "hi",
    deviceTtsLikely: true,
    primary: true,
  },
] as const;

export type TeluguScriptPreference = "native" | "romanized";

const PREFERRED_LANGUAGE_KEY = "ask_prana_preferred_language";
const TELUGU_SCRIPT_KEY = "ask_prana_telugu_script";
const EXPLICIT_LANGUAGE_KEY = "ask_prana_explicit_language";

export function getAskPranaLanguageOption(
  code: string | null | undefined,
): AskPranaLanguageOption {
  const normalized = mapToAskPranaLanguageCode(code);
  const found = ASK_PRANA_LANGUAGE_OPTIONS.find((item) => item.code === normalized);
  return found ?? ASK_PRANA_LANGUAGE_OPTIONS[0];
}

export function mapToAskPranaLanguageCode(
  value: string | null | undefined,
): AskPranaSpeechLanguageCode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw === "te" || raw.includes("telugu") || raw.includes("తెలుగు")) return "te";
  if (raw === "hi" || raw.includes("hindi") || raw.includes("हिन्दी") || raw.includes("हिंदी"))
    return "hi";
  if (raw === "en" || raw.includes("english")) return "en";
  // Drop unsupported legacy codes (ta/kn/ml/bn/mr/gu/pa/or/…) → English.
  return "en";
}

/**
 * Detect an explicit language-change request in the farmer's message.
 * Does NOT flip language for mixed pond jargon like "oxygen low undi".
 */
export function detectExplicitLanguageRequest(
  text: string,
): AskPranaSpeechLanguageCode | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const teluguAsk =
    /తెలుగు\s*లో|తెలుగులో\s*మాట్లాడ|speak\s+in\s+telugu|talk\s+in\s+telugu|reply\s+in\s+telugu|answer\s+in\s+telugu|give\s+(it\s+|me\s+|the\s+answer\s+)?in\s+telugu|can\s+you\s+(give|say|reply|answer|speak).{0,40}telugu|in\s+telugu\s+please|telugu\s+lo\s+matlad|telugu\s+lo|please\s+in\s+telugu/i.test(
      trimmed,
    );

  const hindiAsk =
    /हिन्दी|हिंदी\s*में|speak\s+in\s+hindi|talk\s+in\s+hindi|reply\s+in\s+hindi|answer\s+in\s+hindi|give\s+(it\s+|me\s+|the\s+answer\s+)?in\s+hindi|can\s+you\s+(give|say|reply|answer|speak).{0,40}hindi|in\s+hindi\s+please/i.test(
      trimmed,
    );

  const englishAsk =
    /speak\s+in\s+english|talk\s+in\s+english|reply\s+in\s+english|answer\s+in\s+english|give\s+(it\s+|me\s+|the\s+answer\s+)?in\s+english|can\s+you\s+(give|say|reply|answer|speak).{0,40}english|in\s+english\s+please|ఇంగ్లీష్\s*లో/i.test(
      trimmed,
    );

  if (teluguAsk) return "te";
  if (hindiAsk) return "hi";
  if (englishAsk) return "en";
  return null;
}

/** Detect substantial Indic script in the farmer message (not a single borrowed glyph). */
export function detectMessageLanguageHint(
  text: string,
): AskPranaSpeechLanguageCode | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const nonSpace = trimmed.replace(/\s+/g, "");
  const total = nonSpace.length || 1;
  const count = (re: RegExp) => (nonSpace.match(re) || []).length;

  const telugu = count(/[\u0C00-\u0C7F]/g);
  const devanagari = count(/[\u0900-\u097F]/g);

  const substantial = (n: number) => n >= 4 || n / total >= 0.28;

  if (substantial(telugu)) return "te";
  if (substantial(devanagari)) return "hi";

  // Latin-only / mixed jargon without clear script — do not infer Indic here.
  return null;
}

/**
 * True when the message is predominantly Latin letters with no Indic script.
 * Used so English questions get English replies even if the UI is set to Telugu.
 */
export function isPredominantlyLatinMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (detectMessageLanguageHint(trimmed)) return false;

  const nonSpace = trimmed.replace(/\s+/g, "");
  const total = nonSpace.length || 1;
  const latin = (nonSpace.match(/[A-Za-z]/g) || []).length;
  return latin >= 8 || latin / total >= 0.55;
}

export type AskPranaLanguageSource =
  | "explicit"
  | "script"
  | "saved"
  | "context"
  | "default";

export type ResolvedAskPranaLanguage = {
  code: AskPranaSpeechLanguageCode;
  source: AskPranaLanguageSource;
  llmLabel: string;
};

/**
 * Priority (match THIS question's language):
 * 1) explicit language-change request
 * 2) substantial Indic script in THIS message → that language
 * 3) predominantly Latin (English) message → English
 * 4) session / UI preferred language
 * 5) saved Ask Prana preferred language
 * 6) caller/context language
 * 7) English default
 */
export function resolveAskPranaReplyLanguage(
  message: string,
  options?: {
    savedPreferred?: AskPranaSpeechLanguageCode | null;
    sessionPreferred?: AskPranaSpeechLanguageCode | null;
    contextLanguage?: string | null;
  },
): ResolvedAskPranaLanguage {
  const explicit = detectExplicitLanguageRequest(message);
  if (explicit) {
    return {
      code: explicit,
      source: "explicit",
      llmLabel: getAskPranaLanguageOption(explicit).llmLabel,
    };
  }

  const script = detectMessageLanguageHint(message);
  if (script) {
    return {
      code: script,
      source: "script",
      llmLabel: getAskPranaLanguageOption(script).llmLabel,
    };
  }

  // English (or other Latin) question must not stay locked to a Telugu UI preference.
  if (isPredominantlyLatinMessage(message)) {
    return {
      code: "en",
      source: "script",
      llmLabel: getAskPranaLanguageOption("en").llmLabel,
    };
  }

  if (options?.sessionPreferred) {
    return {
      code: options.sessionPreferred,
      source: "saved",
      llmLabel: getAskPranaLanguageOption(options.sessionPreferred).llmLabel,
    };
  }

  if (options?.savedPreferred) {
    return {
      code: options.savedPreferred,
      source: "saved",
      llmLabel: getAskPranaLanguageOption(options.savedPreferred).llmLabel,
    };
  }

  if (options?.contextLanguage?.trim()) {
    const code = mapToAskPranaLanguageCode(options.contextLanguage);
    return {
      code,
      source: "context",
      llmLabel: getAskPranaLanguageOption(code).llmLabel,
    };
  }

  return {
    code: "en",
    source: "default",
    llmLabel: "English",
  };
}

export async function resolveAndPersistAskPranaReplyLanguage(
  message: string,
  contextLanguage?: string | null,
  sessionPreferred?: AskPranaSpeechLanguageCode | null,
): Promise<ResolvedAskPranaLanguage> {
  const savedPreferred = await loadAskPranaPreferredLanguage();
  const resolved = resolveAskPranaReplyLanguage(message, {
    savedPreferred,
    sessionPreferred: sessionPreferred ?? null,
    contextLanguage,
  });

  if (
    resolved.source === "explicit" ||
    resolved.source === "script" ||
    resolved.source === "saved"
  ) {
    await saveAskPranaPreferredLanguage(resolved.code, {
      explicit: resolved.source === "explicit" || resolved.source === "script",
    });
  }

  console.log("[AskPranaLanguage] resolved", {
    detectedExplicit: detectExplicitLanguageRequest(message),
    detectedScript: detectMessageLanguageHint(message),
    preferredLanguage: savedPreferred,
    sessionPreferred: sessionPreferred ?? null,
    contextLanguage: contextLanguage ?? null,
    finalLanguage: resolved.code,
    source: resolved.source,
  });

  return resolved;
}

export async function loadAskPranaPreferredLanguage(): Promise<AskPranaSpeechLanguageCode> {
  try {
    const explicit = await AsyncStorage.getItem(EXPLICIT_LANGUAGE_KEY);
    if (explicit) return mapToAskPranaLanguageCode(explicit);
    const preferred = await AsyncStorage.getItem(PREFERRED_LANGUAGE_KEY);
    if (preferred) return mapToAskPranaLanguageCode(preferred);
  } catch {
    // ignore
  }
  return "en";
}

export async function saveAskPranaPreferredLanguage(
  code: AskPranaSpeechLanguageCode,
  options?: { explicit?: boolean },
) {
  const allowed = mapToAskPranaLanguageCode(code);
  await AsyncStorage.setItem(PREFERRED_LANGUAGE_KEY, allowed);
  if (options?.explicit) {
    await AsyncStorage.setItem(EXPLICIT_LANGUAGE_KEY, allowed);
  }
}

export async function loadTeluguScriptPreference(): Promise<TeluguScriptPreference> {
  try {
    const value = await AsyncStorage.getItem(TELUGU_SCRIPT_KEY);
    if (value === "romanized" || value === "native") return value;
  } catch {
    // ignore
  }
  return "native";
}

export async function saveTeluguScriptPreference(value: TeluguScriptPreference) {
  await AsyncStorage.setItem(TELUGU_SCRIPT_KEY, value);
}

export function buildLanguageInstructionForLlm({
  language,
  teluguScript,
}: {
  language: AskPranaSpeechLanguageCode;
  teluguScript: TeluguScriptPreference;
}) {
  const option = getAskPranaLanguageOption(language);
  const scriptNote =
    language === "te"
      ? teluguScript === "romanized"
        ? "Write Telugu replies in Romanized Telugu (Latin script), not Telugu script, unless the farmer asks for తెలుగు script."
        : "Write Telugu replies in Telugu script (తెలుగు), unless the farmer asks for Romanized Telugu."
      : "";

  return {
    llmLabel: option.llmLabel,
    code: option.code,
    scriptNote,
  };
}
