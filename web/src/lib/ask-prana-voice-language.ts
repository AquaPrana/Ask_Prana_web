import {
  detectExplicitLanguageRequest,
  detectMessageLanguageHint,
  getAskPranaLanguageOption,
  isPredominantlyLatinMessage,
  type AskPranaSpeechLanguageCode,
} from "./ask-prana-language";
import type { AskPranaRecognitionMode } from "./ask-prana-transcription-language";

export type VoiceLanguageLabel = "English" | "Hindi" | "Telugu";

/**
 * The website language is accepted and ignored. Only an already resolved
 * spoken-turn code (en, te, hi, or its English name) is returned.
 */
export function voiceTurnLanguage(input: {
  spoken?: string | null;
  uiLanguage?: string | null;
}): AskPranaSpeechLanguageCode | null {
  void input.uiLanguage;
  const raw = String(input.spoken ?? "").trim().toLowerCase();
  if (raw === "te" || raw === "telugu") return "te";
  if (raw === "hi" || raw === "hindi") return "hi";
  if (raw === "en" || raw === "english") return "en";
  return null;
}

/** Phrases that make the model refuse a spoken language because of the website. */
const WEBSITE_LANGUAGE_CONTRADICTIONS = [
  "overrides the question",
  "do not switch language to match the question",
  "cannot answer",
  "app language",
  "website is set",
];

export function voiceRequestContradictsSpokenLanguage(notes: string): boolean {
  const lower = notes.toLowerCase();
  return WEBSITE_LANGUAGE_CONTRADICTIONS.some((phrase) => lower.includes(phrase));
}

export function voiceLanguageNotes(label: VoiceLanguageLabel): string {
  return [
    `This Voice Chat turn was spoken in ${label}.`,
    `Write the entire farmer-facing answer in ${label}.`,
    "The website interface language is separate and must not change this answer.",
    "Never refuse English, Telugu, or Hindi, and do not mention a website language setting.",
    "Keep aquaculture terms, numbers, and units such as pH, DO, oxygen, FCR, and mg/L as written.",
    "Ignore the language of earlier conversation turns.",
  ].join(" ");
}

export function unresolvedVoiceLanguageNotes(): string {
  return [
    "The spoken language of this Voice Chat turn was not identified.",
    "Ask the farmer to choose English, Telugu, or Hindi and say the question again.",
    "Do not answer in a language taken from the website interface.",
    "Do not mention a website language setting.",
  ].join(" ");
}

export function buildVoiceLanguageRequest(spoken: AskPranaSpeechLanguageCode) {
  const label = getAskPranaLanguageOption(spoken).llmLabel as VoiceLanguageLabel;
  return {
    spokenTurnLanguage: spoken,
    language: label,
    sessionLanguageCode: spoken,
    voiceModeLanguageLock: null as null,
    languageLock: true,
    languageNotes: voiceLanguageNotes(label),
    inputMode: "voice" as const,
  };
}

export function unresolvedVoiceLanguageRequest() {
  return {
    spokenTurnLanguage: null,
    language: null as null,
    sessionLanguageCode: null as null,
    voiceModeLanguageLock: null as null,
    languageLock: false,
    languageNotes: unresolvedVoiceLanguageNotes(),
    inputMode: "voice" as const,
  };
}

/**
 * A typed Voice Chat question has no audio detection. An explicit recognition
 * choice wins. Otherwise the typed characters decide. The website language
 * is not a fallback.
 */
export function languageForTypedVoiceQuestion(
  text: string,
  mode: AskPranaRecognitionMode,
): AskPranaSpeechLanguageCode | null {
  if (mode === "te" || mode === "hi" || mode === "en") return mode;
  return detectExplicitLanguageRequest(text)
    ?? detectMessageLanguageHint(text)
    ?? (isPredominantlyLatinMessage(text) ? "en" : null);
}
