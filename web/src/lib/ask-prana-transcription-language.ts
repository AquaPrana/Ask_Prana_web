import {
  getAskPranaLanguageOption,
  type AskPranaSpeechLanguageCode,
} from "./ask-prana-language";

/**
 * Attempt budget for one Voice Chat recording.
 *
 * One HTTP request may call whisper-1 twice, both times with that request's
 * language. Explicit `te`, `hi`, or `en` is never replaced with automatic
 * detection. gpt-4o-mini-transcribe is called at most once, and only after a
 * whisper-1 API failure. An empty whisper transcript does not use it.
 *
 * The client may send one extra HTTP request when a Telugu recording comes
 * back as Devanagari. Maximum provider calls for one recording: 6.
 */
export const WHISPER_CALLS_PER_REQUEST = 2;
export const FALLBACK_CALLS_PER_REQUEST = 1;
export const CLOUD_TRANSCRIPTION_ATTEMPTS_PER_REQUEST =
  WHISPER_CALLS_PER_REQUEST + FALLBACK_CALLS_PER_REQUEST;
export const VOICE_TRANSCRIPTION_REQUESTS_PER_RECORDING = 2;
export const MAX_PROVIDER_CALLS_PER_RECORDING =
  CLOUD_TRANSCRIPTION_ATTEMPTS_PER_REQUEST * VOICE_TRANSCRIPTION_REQUESTS_PER_RECORDING;

export type CloudSttLanguage = "en" | "te" | "hi" | null;

export type CloudTranscriptionAttempt = {
  model: "whisper-1";
  language: CloudSttLanguage;
};

/** Browser SpeechRecognition tags. Cloud transcription uses the short code. */
export function browserRecognitionLanguage(code: AskPranaSpeechLanguageCode): string {
  return getAskPranaLanguageOption(code).bcp47;
}

export function cloudTranscriptionLanguage(code: AskPranaSpeechLanguageCode): Exclude<CloudSttLanguage, null> {
  const hint = getAskPranaLanguageOption(code).openaiStt;
  if (hint === "en" || hint === "te" || hint === "hi") return hint;
  return code;
}

/**
 * Empty or `auto` stays automatic. `te-IN` / `hi-IN` / `en-IN` stay Telugu,
 * Hindi, and English. An unknown value is not guessed as English.
 */
export function mapRequestedSttLanguage(raw: string | null | undefined): CloudSttLanguage {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "auto" || value === "multilingual") return null;
  if (value === "te" || value.startsWith("te-") || value.includes("telugu") || value.includes("తెలుగు")) {
    return "te";
  }
  if (value === "hi" || value.startsWith("hi-") || value.includes("hindi") || value.includes("हिन्दी") || value.includes("हिंदी")) {
    return "hi";
  }
  if (value === "en" || value.startsWith("en-") || value.includes("english")) return "en";
  return null;
}

/** Both whisper-1 attempts keep the request language, including intentional automatic detection. */
export function planCloudTranscriptionAttempts(language: CloudSttLanguage): CloudTranscriptionAttempt[] {
  return [
    { model: "whisper-1", language },
    { model: "whisper-1", language },
  ];
}

export type ProviderTranscriptionResult = {
  ok: boolean;
  transcript: string;
};

/**
 * The fallback model runs only after whisper-1 has been tried twice and one
 * of those calls failed at the API. Two empty transcripts stay on whisper-1.
 */
export function shouldUseFallbackModel(whisperResults: ProviderTranscriptionResult[]): boolean {
  if (whisperResults.length < WHISPER_CALLS_PER_REQUEST) return false;
  const apiFailure = whisperResults.some((result) => !result.ok);
  const transcript = whisperResults.some((result) => result.transcript.trim().length > 0);
  return apiFailure && !transcript;
}

const ACCEPTED_RECORDING_CONTAINERS = new Set([
  "webm",
  "mp4",
  "m4a",
  "wav",
  "ogg",
  "oga",
  "mpeg-4",
]);

/** True when the bytes were already accepted as a recording Whisper can receive. */
export function recognizedTranscriptionContainer(containerOrExtension: string): boolean {
  return ACCEPTED_RECORDING_CONTAINERS.has(containerOrExtension.trim().toLowerCase());
}

/**
 * A format alert is only for a container or extension this service rejected.
 * A provider message that merely contains "format" is a model failure.
 */
export function isRejectedAudioContainerError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("voice recording format isn't supported") ||
    normalized.includes("voice recording format is not supported") ||
    normalized.includes("not a supported audio container") ||
    normalized.includes("unsupported audio extension") ||
    normalized.includes("unsupported audio container")
  );
}

export type VoiceCaptureSnapshot = {
  epoch: number;
  turnId: string;
  language: AskPranaSpeechLanguageCode;
  provider: "browser" | "cloud-recorder";
};

export function isStaleVoiceCapture(
  capture: VoiceCaptureSnapshot | null,
  currentEpoch: number,
): boolean {
  return capture == null || capture.epoch !== currentEpoch;
}

function countScript(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Telugu was requested, and the text is substantial Devanagari with no Telugu
 * letters and without a Latin question. Mixed Telugu-English, “pH”, and a
 * Hindi selection are not signals. This does not reject the text by itself.
 */
export function suggestsTeluguMisread(
  language: AskPranaSpeechLanguageCode,
  transcript: string,
): boolean {
  if (language !== "te") return false;
  const compact = transcript.replace(/\s+/g, "");
  const telugu = countScript(compact, /[\u0C00-\u0C7F]/g);
  const devanagari = countScript(compact, /[\u0900-\u097F]/g);
  const latin = countScript(compact, /[A-Za-z]/g);
  if (telugu > 0 || latin >= 8) return false;
  return devanagari >= 6 && devanagari > latin;
}

export type VoiceTranscriptOutcome =
  | { action: "accept"; text: string; retryCount: 0 | 1; reason: "initial" | "script-retry" }
  | { action: "repeat"; retryCount: 0 | 1; reason: "empty" | "script-retry-still-mismatched" };

/**
 * Accept a transcript that is not a Telugu-to-Devanagari mismatch. After the
 * one allowed retry, accept that result when it is usable. An empty retry or
 * another mismatch asks the user to repeat and does not submit the first text.
 */
export function decideVoiceTranscript(input: {
  language: AskPranaSpeechLanguageCode;
  first: string;
  /** Pass only after the single explicit-language retry has finished. */
  retry?: string | null;
}): VoiceTranscriptOutcome {
  if (input.retry !== undefined) {
    const retry = input.retry?.trim() ?? "";
    if (!retry || suggestsTeluguMisread(input.language, retry)) {
      return { action: "repeat", retryCount: 1, reason: "script-retry-still-mismatched" };
    }
    return { action: "accept", text: retry, retryCount: 1, reason: "script-retry" };
  }
  const first = input.first.trim();
  if (!first) return { action: "repeat", retryCount: 0, reason: "empty" };
  return { action: "accept", text: first, retryCount: 0, reason: "initial" };
}
