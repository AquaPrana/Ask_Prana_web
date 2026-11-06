/**
 * Voice-turn transcript checks. These decide whether recognized speech is a
 * real user question. They do not translate or reject text only because it
 * uses an unexpected script.
 */

import type { AskPranaSpeechLanguageCode } from "./ask-prana-language";

const NON_SPEECH_HALLUCINATIONS = [
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "subtitles by",
  "дякую за перегляд",
  "субтитры сделал",
  "субтитры создавал",
  "підписуйтесь",
];

function spokenKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Empty recognition, or a known non-speech phrase, is not a user question. */
export function isUnclearVoiceTranscript(text: string): boolean {
  const key = spokenKey(text);
  if (!key) return true;
  return NON_SPEECH_HALLUCINATIONS.some(
    (phrase) => key === phrase || key.startsWith(`${phrase} `),
  );
}

/**
 * True when the microphone most likely heard the assistant, not a new
 * question. Short overlaps are kept so a real interruption is not swallowed.
 */
export function isAssistantEchoTranscript(transcript: string, spoken: string): boolean {
  const said = spokenKey(transcript);
  const answer = spokenKey(spoken);
  if (!said || !answer) return false;
  if (said.length >= 12 && (answer.includes(said) || said.includes(answer))) return true;
  const saidWords = said.split(" ").filter(Boolean);
  const answerWords = new Set(answer.split(" ").filter(Boolean));
  if (saidWords.length < 4) return false;
  const overlap = saidWords.filter((word) => answerWords.has(word)).length;
  return overlap / saidWords.length >= 0.72;
}

function transcriptWords(text: string): string[] {
  return spokenKey(text).split(" ").filter(Boolean);
}

export type InterruptionTranscriptChoice = {
  text: string;
  language: AskPranaSpeechLanguageCode;
  source: "recognized" | "captured";
  reason: string;
};

/**
 * Pick the interruption transcript from speech evidence.
 * A longer transcript does not win. Assistant echo, including extra words
 * added to an otherwise real question, cannot replace the user transcript.
 */
export function chooseInterruptionTranscript(input: {
  recognizedText: string;
  recognizedLanguage: AskPranaSpeechLanguageCode | null;
  capturedText: string;
  capturedLanguage: AskPranaSpeechLanguageCode | null;
  assistantSpoken: string;
}): InterruptionTranscriptChoice | null {
  const usable = (text: string, language: AskPranaSpeechLanguageCode | null) => {
    const trimmed = text.trim();
    if (!language || !trimmed || isUnclearVoiceTranscript(trimmed)) return false;
    return !isAssistantEchoTranscript(trimmed, input.assistantSpoken);
  };
  const recognizedOk = usable(input.recognizedText, input.recognizedLanguage);
  const capturedOk = usable(input.capturedText, input.capturedLanguage);
  if (recognizedOk && capturedOk && input.recognizedLanguage && input.capturedLanguage) {
    const recognizedWords = transcriptWords(input.recognizedText);
    const capturedWords = transcriptWords(input.capturedText);
    const assistantWords = new Set(transcriptWords(input.assistantSpoken));
    const extra = capturedWords.filter((word) => !recognizedWords.includes(word));
    const extraEcho = extra.filter((word) => assistantWords.has(word)).length;
    const extraIsEcho = extra.length >= 2 && extraEcho / extra.length >= 0.5;
    if (extraIsEcho) {
      return {
        text: input.recognizedText.trim(),
        language: input.recognizedLanguage,
        source: "recognized",
        reason: "captured-echo-extension",
      };
    }
    const recognizedKey = spokenKey(input.recognizedText);
    const capturedKey = spokenKey(input.capturedText);
    const capturedExtendsRecognized = Boolean(recognizedKey) &&
      capturedKey !== recognizedKey &&
      (capturedKey.startsWith(recognizedKey) || capturedKey.endsWith(recognizedKey));
    if (capturedExtendsRecognized && extra.length > 0) {
      return {
        text: input.capturedText.trim(),
        language: input.capturedLanguage,
        source: "captured",
        reason: "captured-keeps-leading-words",
      };
    }
    return {
      text: input.recognizedText.trim(),
      language: input.recognizedLanguage,
      source: "recognized",
      reason: "recognized-user-transcript",
    };
  }
  if (capturedOk && input.capturedLanguage) {
    return {
      text: input.capturedText.trim(),
      language: input.capturedLanguage,
      source: "captured",
      reason: "recognized-missing",
    };
  }
  if (recognizedOk && input.recognizedLanguage) {
    return {
      text: input.recognizedText.trim(),
      language: input.recognizedLanguage,
      source: "recognized",
      reason: "captured-rejected",
    };
  }
  return null;
}
