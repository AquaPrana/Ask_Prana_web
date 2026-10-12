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

/**
 * A turn should only be sent after a deliberate pause.  800 ms treated normal
 * breaths and clause breaks as the end of a question, which cut off the rest
 * of long voice turns.  Keep the recognizer open through short pauses.
 */
const UTTERANCE_PAUSE_MS = 2200;
const RESTART_DELAY_MS = 120;
const STOP_FINAL_RESULT_GRACE_MS = 5000;

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
  // SpeechRecognition returns a mutable result list.  Keep each result slot
  // rather than repeatedly merging the entire list, otherwise a restart or an
  // interim-to-final update can duplicate or discard earlier words.
  const finalSegments = new Map<number, string>();
  const interimSegments = new Map<number, string>();
  let settled = false;
  let stopRequested = false;
  let utteranceSent = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: ((value: string) => void) | null = null;

  const clearPause = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  const clearRestart = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const sessionTranscript = () => {
    const indexes = new Set([...finalSegments.keys(), ...interimSegments.keys()]);
    return [...indexes]
      .sort((left, right) => left - right)
      .reduce((text, index) => {
        const segment = finalSegments.get(index) ?? interimSegments.get(index) ?? "";
        return mergeTranscript(text, segment);
      }, "");
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
    return mergeTranscript(committedText, sessionTranscript());
  };

  const emitPartial = () => {
    handlers.onPartial(currentTranscript());
  };

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const piece = result?.[0]?.transcript?.trim() ?? "";
      if (!piece) continue;
      if (result.isFinal) {
        finalSegments.set(i, piece);
        interimSegments.delete(i);
      } else {
        interimSegments.set(i, piece);
      }
    }
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
      finalSegments.clear();
      interimSegments.clear();
      // Chromium can end a continuous recognition session unexpectedly. Delay
      // the restart one task so the engine has fully released its prior state.
      clearRestart();
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (settled || stopRequested) return;
        try {
          recognition.start();
        } catch (error) {
          console.log("[AskPranaDictation] recognition restart failed:", error);
          settled = true;
          resolveStop?.(currentTranscript());
          resolveStop = null;
        }
      }, RESTART_DELAY_MS);
      return;
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
        clearRestart();
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
        }, STOP_FINAL_RESULT_GRACE_MS);
      }),
    cancel: () => {
      stopRequested = true;
      clearPause();
      clearRestart();
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
