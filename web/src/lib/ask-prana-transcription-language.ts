import { getAskPranaLanguageOption, type AskPranaSpeechLanguageCode } from "./ask-prana-language";

/**
 * Attempt budget for one Voice Chat recording.
 *
 * The client sends exactly one gpt-transcribe request per recording. A browser
 * WebM/Opus recording is remuxed locally to WAV first; that remux is not a
 * provider call. Explicit `te`, `hi`, or `en` is never replaced with automatic
 * detection. Auto is constrained to the three supported input languages and
 * remains unresolved if the provider cannot identify one. Maximum provider
 * calls: 1.
 */
/** gpt-transcribe detects one bounded recording once; it is not retried blindly. */
export const CLOUD_TRANSCRIPTION_ATTEMPTS_PER_REQUEST = 1;
export const VOICE_TRANSCRIPTION_REQUESTS_PER_RECORDING = 1;
export const MAX_PROVIDER_CALLS_PER_RECORDING =
  CLOUD_TRANSCRIPTION_ATTEMPTS_PER_REQUEST * VOICE_TRANSCRIPTION_REQUESTS_PER_RECORDING;

export type CloudSttLanguage = "en" | "te" | "hi" | null;

export type CloudTranscriptionAttempt = {
  model: "gpt-transcribe";
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

/** One provider pass preserves the explicit hint, or detects within the supported set. */
export function planCloudTranscriptionAttempts(language: CloudSttLanguage): CloudTranscriptionAttempt[] {
  return [{ model: "gpt-transcribe", language }];
}

export type ProviderTranscriptionResult = {
  ok: boolean;
  transcript: string;
};

/** No hidden fallback: service/auth/quota failures must remain visible. */
export function shouldUseFallbackModel(whisperResults: ProviderTranscriptionResult[]): boolean {
  void whisperResults;
  return false;
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

/** True when the bytes were already accepted as a recording the provider can receive. */
export function recognizedTranscriptionContainer(containerOrExtension: string): boolean {
  return ACCEPTED_RECORDING_CONTAINERS.has(containerOrExtension.trim().toLowerCase());
}

/**
 * gpt-transcribe lists WebM, but its file-transcription examples upload WAV.
 * MediaRecorder's `audio/webm;codecs=opus` file is rejected with `param: "file"`.
 * Those recordings are uploaded as WAV. WAV, MP4, and MPEG stay unchanged.
 */
export function documentedUploadForRecording(containerOrMime: string): {
  container: "wav" | "original";
  mimeType: string;
  fileName: string;
} {
  const value = containerOrMime.trim().toLowerCase();
  if (value.includes("webm") || value.includes("ogg") || value.includes("oga")) {
    return { container: "wav", mimeType: "audio/wav", fileName: "askprana-recording.wav" };
  }
  return { container: "original", mimeType: "", fileName: "" };
}

/**
 * A recognized WebM or Ogg recording is remuxed before the provider sees it,
 * so that recording is not reported as PROVIDER_AUDIO_FILE. A file the
 * provider still rejects after remux, or a container that was never a
 * recording, stays a real audio-file failure.
 */
export function providerAudioFileCode(input: {
  recognizedContainer: string;
  uploadedContainer: string;
  providerParam: string | null;
  providerMessage: string;
}): "PROVIDER_AUDIO_FILE" | null {
  const detail = input.providerMessage.toLowerCase();
  const fileRejected =
    input.providerParam === "file" || /(corrupted|unsupported).{0,30}audio/.test(detail);
  if (!fileRejected) return null;
  const recognized = input.recognizedContainer.trim().toLowerCase();
  const uploaded = input.uploadedContainer.trim().toLowerCase();
  if ((recognized === "webm" || recognized === "ogg") && (uploaded === "webm" || uploaded === "ogg")) {
    return null;
  }
  return "PROVIDER_AUDIO_FILE";
}

/** 16-bit mono PCM WAV. The leading bytes are the RIFF header used for file transcription. */
export function encodeWavPcm(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
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

/** Auto detects each question. The other three lock recognition until changed. */
export type AskPranaRecognitionMode = "auto" | AskPranaSpeechLanguageCode;

export function recognitionModeFrom(value: string | null | undefined): AskPranaRecognitionMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto" || raw === "multilingual") return "auto";
  if (raw === "te" || raw.startsWith("te-") || raw.includes("telugu") || raw.includes("తెలుగు")) return "te";
  if (raw === "hi" || raw.startsWith("hi-") || raw.includes("hindi") || raw.includes("हिन्दी") || raw.includes("हिंदी")) return "hi";
  if (raw === "en" || raw.startsWith("en-") || raw.includes("english")) return "en";
  return "auto";
}

/** Value sent to cloud transcription. Auto omits a language hint inside the function. */
export function cloudLanguageForRecognition(mode: AskPranaRecognitionMode): "auto" | AskPranaSpeechLanguageCode {
  return mode === "auto" ? "auto" : mode;
}

/**
 * Explicit recognition wins and is never replaced by Auto.
 * Auto accepts only actual provider audio-language detection. A transcript's
 * script can be wrong (for example Telugu rendered in Devanagari), so it is
 * never evidence of the original spoken language. Website language is not used.
 */
export function resolveSpokenReplyLanguage(input: {
  mode: AskPranaRecognitionMode;
  detected?: string | null;
  transcript?: string | null;
}): AskPranaSpeechLanguageCode | null {
  if (input.mode === "te" || input.mode === "hi" || input.mode === "en") return input.mode;
  const detected = mapRequestedSttLanguage(input.detected);
  if (detected === "te" || detected === "hi" || detected === "en") return detected;
  return null;
}

/**
 * Submit a real Telugu, Hindi, or English question. Repeat only when there
 * is no transcript. The original words are returned unchanged.
 */
export function acceptSpokenQuestion(input: {
  mode: AskPranaRecognitionMode;
  transcript: string;
  detected?: string | null;
}):
  | { action: "accept"; text: string; language: AskPranaSpeechLanguageCode }
  | { action: "repeat" } {
  const text = input.transcript.trim();
  if (!text) return { action: "repeat" };
  const language = resolveSpokenReplyLanguage({
    mode: input.mode,
    detected: input.detected,
    transcript: text,
  });
  if (!language) return { action: "repeat" };
  return { action: "accept", text, language };
}

export type VoiceCaptureSnapshot = {
  epoch: number;
  turnId: string;
  /** Recognition mode captured when this recording started. */
  language: AskPranaRecognitionMode;
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
 * A non-empty transcript is the question. An empty retry does not throw away
 * the first text, including a Devanagari reading of Telugu speech.
 */
export function decideVoiceTranscript(input: {
  language: AskPranaSpeechLanguageCode;
  first: string;
  /** Pass only after the single explicit-language retry has finished. */
  retry?: string | null;
}): VoiceTranscriptOutcome {
  if (input.retry !== undefined) {
    const retry = input.retry?.trim() ?? "";
    if (retry) return { action: "accept", text: retry, retryCount: 1, reason: "script-retry" };
    const first = input.first.trim();
    if (first) return { action: "accept", text: first, retryCount: 1, reason: "initial" };
    return { action: "repeat", retryCount: 1, reason: "empty" };
  }
  const first = input.first.trim();
  if (!first) return { action: "repeat", retryCount: 0, reason: "empty" };
  return { action: "accept", text: first, retryCount: 0, reason: "initial" };
}
