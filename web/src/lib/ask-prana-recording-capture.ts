/**
 * Shared microphone capture checks for the composer microphone and Voice Chat.
 * These look at signal level and settings the browser actually applied.
 * They do not amplify audio, disable echo protection, or invent a transcript.
 */

export const MICROPHONE_NOT_READY_MESSAGE =
  "The microphone is not ready yet. Please try again.";
export const MICROPHONE_UNAVAILABLE_MESSAGE =
  "The microphone is muted or unavailable. Check the selected microphone and try again.";
export const VOICE_TOO_QUIET_MESSAGE =
  "Your voice is too quiet. Please move the phone closer and try again.";
export const VOICE_CLIPPED_MESSAGE =
  "That recording was distorted. Please move the phone a little farther and try again.";

/** Provider confidence at or above this is a single-language decision. Below it, the result is uncertain. */
export const CONFIDENT_LANGUAGE_DETECTION = 0.6;

export type MicrophoneCaptureConstraints = {
  echoCancellation: { ideal: true };
  noiseSuppression: { ideal: true };
  autoGainControl: { ideal: true };
  channelCount: { ideal: 1 };
};

/**
 * Ask for the same processing on a normal recording and an interruption.
 * `ideal` requests the processing without failing capture when a browser
 * cannot apply it. The applied values still have to be read back.
 */
export function microphoneCaptureConstraints(): MicrophoneCaptureConstraints {
  return {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
  };
}

export type AppliedMicrophoneSettings = {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  sampleRate: number | null;
  channelCount: number | null;
  muted: boolean;
  readyState: string;
};

type ReadableMicrophoneTrack = {
  muted?: boolean;
  readyState?: string;
  getSettings?: () => {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
    sampleRate?: number;
    channelCount?: number;
  };
};

function reportedBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Missing fields stay null. A requested setting is not treated as applied. */
export function describeAppliedMicrophoneSettings(
  track: ReadableMicrophoneTrack | null | undefined,
): AppliedMicrophoneSettings {
  const settings = track?.getSettings?.() ?? {};
  return {
    echoCancellation: reportedBoolean(settings.echoCancellation),
    noiseSuppression: reportedBoolean(settings.noiseSuppression),
    autoGainControl: reportedBoolean(settings.autoGainControl),
    sampleRate: typeof settings.sampleRate === "number" ? settings.sampleRate : null,
    channelCount: typeof settings.channelCount === "number" ? settings.channelCount : null,
    muted: track?.muted === true,
    readyState: typeof track?.readyState === "string" ? track.readyState : "unknown",
  };
}

export type RecordingSignalSummary = {
  durationMs: number;
  sampleRate: number;
  rms: number;
  peak: number;
  clippedRatio: number;
  voicedMs: number;
  /** Voiced time at a lower level, for quiet laptop / headset microphones. */
  softVoicedMs?: number;
};

export type RecordingQualityDecision = {
  action: "accept" | "reject";
  reason: "ok" | "too-quiet" | "clipped" | "insufficient-speech" | "muted-track";
  message: string | null;
  summary: RecordingSignalSummary;
};

const WINDOW_SEC = 0.02;
/** Quiet speech still counts. Steady room tone usually stays under this. */
const VOICED_WINDOW_RMS = 0.01;
const MIN_VOICED_MS = 240;
const NEAR_SILENCE_PEAK = 0.012;
const NEAR_SILENCE_RMS = 0.0035;
const CLIP_ABS = 0.985;
/** Lower speech level used only for chat-box dictation (quiet computer mics). */
const SOFT_VOICED_WINDOW_RMS = 0.004;
const SOFT_MIN_VOICED_MS = 200;
const SOFT_MIN_PEAK = 0.006;

/** Message for chat-box dictation; it is used on phones and computers. */
export const DICTATION_TOO_QUIET_MESSAGE =
  "We couldn't hear you clearly. Please speak a little louder or closer to the microphone and try again.";

/**
 * Chat-box dictation only: a recording the normal check called too quiet is
 * still sent for transcription when it holds enough quiet speech. Laptop and
 * headset microphones often record normal speech below the phone-tuned level.
 * Real silence (no peak) is still rejected.
 */
export function isUsableQuietDictation(summary: RecordingSignalSummary): boolean {
  return (
    summary.peak >= SOFT_MIN_PEAK &&
    (summary.softVoicedMs ?? 0) >= SOFT_MIN_VOICED_MS
  );
}
const CLIP_RATIO = 0.12;

export function summarizeRecordingSignal(
  samples: ArrayLike<number>,
  sampleRate: number,
): RecordingSignalSummary {
  const rate = sampleRate > 0 ? sampleRate : 1;
  const total = samples.length;
  if (!total) {
    return { durationMs: 0, sampleRate: rate, rms: 0, peak: 0, clippedRatio: 0, voicedMs: 0, softVoicedMs: 0 };
  }
  let energy = 0;
  let peak = 0;
  let clipped = 0;
  for (let index = 0; index < total; index += 1) {
    const sample = samples[index] ?? 0;
    const abs = Math.abs(sample);
    energy += sample * sample;
    if (abs > peak) peak = abs;
    if (abs >= CLIP_ABS) clipped += 1;
  }
  const window = Math.max(1, Math.round(rate * WINDOW_SEC));
  let voicedMs = 0;
  let softVoicedMs = 0;
  for (let start = 0; start < total; start += window) {
    const end = Math.min(total, start + window);
    let windowEnergy = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      windowEnergy += sample * sample;
    }
    const windowRms = Math.sqrt(windowEnergy / Math.max(1, end - start));
    if (windowRms >= VOICED_WINDOW_RMS) {
      voicedMs += ((end - start) / rate) * 1000;
    }
    if (windowRms >= SOFT_VOICED_WINDOW_RMS) {
      softVoicedMs += ((end - start) / rate) * 1000;
    }
  }
  return {
    durationMs: (total / rate) * 1000,
    sampleRate: rate,
    rms: Math.sqrt(energy / total),
    peak,
    clippedRatio: clipped / total,
    voicedMs,
    softVoicedMs,
  };
}

/**
 * A WAV header and a large file are not evidence of speech. Only near-silence,
 * almost no voiced audio, or severe clipping is rejected. A naturally quiet
 * voice stays above the near-silence floor and is kept.
 */
export function decideRecordingQuality(
  summary: RecordingSignalSummary,
  track?: { muted?: boolean; ended?: boolean },
): RecordingQualityDecision {
  const nearSilence = summary.peak < NEAR_SILENCE_PEAK && summary.rms < NEAR_SILENCE_RMS;
  const severelyClipped = summary.peak >= CLIP_ABS && summary.clippedRatio > CLIP_RATIO;
  const littleSpeech = summary.voicedMs < MIN_VOICED_MS;
  let reason: RecordingQualityDecision["reason"] = "ok";
  let message: string | null = null;
  if (severelyClipped) {
    reason = "clipped";
    message = VOICE_CLIPPED_MESSAGE;
  } else if (nearSilence) {
    reason = "too-quiet";
    message = VOICE_TOO_QUIET_MESSAGE;
  } else if (littleSpeech) {
    reason = "insufficient-speech";
    message = VOICE_TOO_QUIET_MESSAGE;
  }
  if (reason !== "ok" && (track?.muted || track?.ended)) {
    reason = "muted-track";
    message = MICROPHONE_UNAVAILABLE_MESSAGE;
  }
  return {
    action: reason === "ok" ? "accept" : "reject",
    reason,
    message,
    summary,
  };
}

export type RecordingCaptureReport = {
  recordingId: string;
  sampleRate: number;
  contextState: string;
  settings: AppliedMicrophoneSettings;
  quality: RecordingQualityDecision;
};

let recordingSequence = 0;

export function createRecordingId(): string {
  recordingSequence += 1;
  return `rec-${Date.now().toString(36)}-${recordingSequence}`;
}

export function logRecordingCapture(detail: {
  recordingId: string;
  stage: string;
  durationMs?: number;
  sampleRate?: number;
  rms?: number;
  peak?: number;
  clippedRatio?: number;
  voicedMs?: number;
  languageRequested?: string | null;
  languageDetected?: string | null;
  decision?: string;
  contextState?: string;
  settings?: AppliedMicrophoneSettings;
}) {
  if (process.env.NODE_ENV === "production") return;
  console.debug("[AskPranaCapture]", {
    recordingId: detail.recordingId,
    stage: detail.stage,
    durationMs: detail.durationMs != null ? Math.round(detail.durationMs) : undefined,
    sampleRate: detail.sampleRate,
    rms: detail.rms != null ? Number(detail.rms.toFixed(4)) : undefined,
    peak: detail.peak != null ? Number(detail.peak.toFixed(4)) : undefined,
    clippedRatio: detail.clippedRatio != null ? Number(detail.clippedRatio.toFixed(4)) : undefined,
    voicedMs: detail.voicedMs != null ? Math.round(detail.voicedMs) : undefined,
    languageRequested: detail.languageRequested,
    languageDetected: detail.languageDetected,
    decision: detail.decision,
    contextState: detail.contextState,
    echoCancellation: detail.settings?.echoCancellation,
    noiseSuppression: detail.settings?.noiseSuppression,
    autoGainControl: detail.settings?.autoGainControl,
    muted: detail.settings?.muted,
    readyState: detail.settings?.readyState,
  });
}
