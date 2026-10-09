import { Platform } from "react-native";
import {
  getAskPranaLanguageOption,
  type AskPranaSpeechLanguageCode,
} from "./ask-prana-language";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export type WebDictationHandlers = {
  onPartial: (text: string) => void;
  onError: (message: string) => void;
  /** Fires once after the user has spoken and then paused. Composer dictation omits this. */
  onUtteranceEnd?: (text: string) => void;
};

/** Pause after real speech before a voice-mode turn sends itself. */
const UTTERANCE_PAUSE_MS = 800;

export type WebDictationSession = {
  stop: () => Promise<string>;
  cancel: () => void;
};

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return null;
  }
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isWebDictationAvailable(): boolean {
  return getSpeechRecognitionCtor() != null;
}

/** Keep one wording when the browser sends the same phrase again as it grows. */
function mergeTranscript(previous: string, next: string): string {
  const stored = previous.replace(/\s+/g, " ").trim();
  let incoming = next.replace(/\s+/g, " ").trim();
  if (!stored) return incoming;
  if (!incoming) return stored;
  const storedKey = stored.toLowerCase();
  let incomingKey = incoming.toLowerCase();
  if (storedKey === incomingKey) return stored.length >= incoming.length ? stored : incoming;
  if (incomingKey.startsWith(storedKey)) {
    let rest = incoming.slice(stored.length).trim();
    let restKey = rest.toLowerCase();
    while (restKey.startsWith(storedKey)) {
      rest = rest.slice(stored.length).trim();
      restKey = rest.toLowerCase();
    }
    if (!rest || storedKey.endsWith(restKey)) return stored;
    return mergeTranscript(stored, rest);
  }
  if (incomingKey.endsWith(storedKey)) return incoming;
  if (storedKey.startsWith(incomingKey) || storedKey.endsWith(incomingKey)) return stored;

  const storedWords = stored.split(" ");
  const incomingWords = incoming.split(" ");
  const max = Math.min(storedWords.length, incomingWords.length);
  for (let size = max; size > 0; size -= 1) {
    const tail = storedWords.slice(storedWords.length - size).join(" ").toLowerCase();
    const head = incomingWords.slice(0, size).join(" ").toLowerCase();
    if (tail === head) {
      const added = incomingWords.slice(size).join(" ");
      return added ? `${stored} ${added}` : stored;
    }
  }
  return `${stored} ${incoming}`;
}

/**
 * Browser-native speech-to-text (no OpenAI). Used for Ask Prana composer
 * dictation on web when cloud transcription is unavailable or preferred.
 */
export function startWebDictation(
  language: AskPranaSpeechLanguageCode,
  handlers: WebDictationHandlers,
): WebDictationSession {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    throw new Error("WEB_DICTATION_UNAVAILABLE");
  }

  const recognition = new Ctor();
  const option = getAskPranaLanguageOption(language);
  recognition.lang = option.bcp47 || "en-IN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let committedText = "";
  let sessionFinal = "";
  let interimText = "";
  let settled = false;
  let stopRequested = false;
  let utteranceSent = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: ((value: string) => void) | null = null;

  const clearPause = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  const armUtterancePause = () => {
    if (!handlers.onUtteranceEnd || utteranceSent || stopRequested || settled) return;
    if (!currentTranscript().trim()) return;
    clearPause();
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (utteranceSent || stopRequested || settled) return;
      const text = currentTranscript().trim();
      if (!text) return;
      utteranceSent = true;
      handlers.onUtteranceEnd?.(text);
    }, UTTERANCE_PAUSE_MS);
  };

  const currentTranscript = () => {
    const spoken = mergeTranscript(committedText, sessionFinal);
    return interimText ? mergeTranscript(spoken, interimText) : spoken;
  };

  const emitPartial = () => {
    handlers.onPartial(currentTranscript());
  };

  recognition.onresult = (event) => {
    let finals = "";
    let interim = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      const piece = result?.[0]?.transcript?.trim() ?? "";
      if (!piece) continue;
      if (result.isFinal) finals = mergeTranscript(finals, piece);
      else interim = mergeTranscript(interim, piece);
    }
    sessionFinal = finals;
    interimText = interim;
    emitPartial();
    armUtterancePause();
  };

  recognition.onspeechend = () => {
    armUtterancePause();
  };

  recognition.onerror = (event) => {
    const code = String(event?.error ?? "unknown");
    // "aborted" / "no-speech" are normal stop/cancel paths.
    if (code === "aborted" || code === "no-speech") {
      return;
    }
    console.log("[AskPranaDictation] web speech error:", code);
    if (code === "not-allowed" || code === "service-not-allowed") {
      handlers.onError(
        "Microphone or speech permission was blocked. Allow mic access in the browser and try again.",
      );
    } else {
      handlers.onError("Could not hear that clearly. Please try speaking again.");
    }
  };

  recognition.onend = () => {
    if (settled) return;
    if (!stopRequested) {
      committedText = currentTranscript();
      sessionFinal = "";
      interimText = "";
      // Browser sometimes ends mid-session — restart while still recording.
      try {
        recognition.start();
        return;
      } catch {
        // fall through and settle
      }
    }
    settled = true;
    const text = currentTranscript();
    resolveStop?.(text);
    resolveStop = null;
  };

  try {
    recognition.start();
  } catch (error) {
    console.log("[AskPranaDictation] failed to start:", error);
    throw new Error("WEB_DICTATION_START_FAILED");
  }

  return {
    stop: () =>
      new Promise<string>((resolve) => {
        if (settled) {
          resolve(currentTranscript());
          return;
        }
        stopRequested = true;
        clearPause();
        resolveStop = resolve;
        try {
          recognition.stop();
        } catch {
          settled = true;
          resolve(currentTranscript());
        }
        // Safety: if onend never fires
        setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              recognition.abort();
            } catch {
              // ignore
            }
            resolve(currentTranscript());
          }
        }, 2500);
      }),
    cancel: () => {
      stopRequested = true;
      clearPause();
      settled = true;
      resolveStop?.("");
      resolveStop = null;
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    },
  };
}
