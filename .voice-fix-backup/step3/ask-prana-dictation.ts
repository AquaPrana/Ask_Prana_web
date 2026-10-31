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
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onsoundstart?: (() => void) | null;
  onsoundend?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onaudioend?: (() => void) | null;
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
  /** The browser session cannot continue and its owner must clear UI/refs. */
  onTerminalError?: (error: { code: string; message: string }) => void;
  /** Fires once after the user has spoken and then paused. Composer dictation omits this. */
  onUtteranceEnd?: (text: string) => void;
};

/** Development-only timing markers for diagnosing browser recognition stalls. */
function logRecognitionTiming(stage: string, startedAt: number, detail?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.debug("[AskPranaVoiceTiming]", stage, { elapsedMs, ...detail });
}

/**
 * A turn should only be sent after a deliberate pause.  800 ms treated normal
 * breaths and clause breaks as the end of a question, which cut off the rest
 * of long voice turns.  Keep the recognizer open through short pauses.
 */
/** A confirmed browser speech-end signal gets a natural, non-aggressive pause. */
// These values are only used to bridge browser recognition events: they are
// not retry loops. Keep them short enough for a conversational handoff while
// still allowing Chrome to publish its final segment after speech ends.
const CONFIRMED_SILENCE_MS = 900;
/** Browser speech-end events are inconsistent; never wait forever for one. */
const AMBIGUOUS_SILENCE_FALLBACK_MS = 1_500;
const RESTART_DELAY_MS = 120;
const STOP_FINAL_RESULT_GRACE_MS = 750;
const MAX_RAPID_UNEXPECTED_ENDS = 3;
const RAPID_END_WINDOW_MS = 1200;

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
  const startedAt = performance.now();
  let firstResultSeen = false;
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
  /** Transcript reported by the last onUtteranceEnd. */
  let sentTranscript = "";
  let speechActive = false;
  let speechEnded = false;
  let rapidUnexpectedEnds = 0;
  let recognitionStartedAt = performance.now();
  // Chromium may deliver `onend` before the Voice Mode callback gets a chance
  // to call stop(). In that case calling recognition.stop() cannot produce a
  // second `onend`, previously forcing the five-second safety wait below.
  let recognitionRunning = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let ambiguousPauseTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: ((value: string) => void) | null = null;

  const clearPause = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  const clearAmbiguousPause = () => {
    if (ambiguousPauseTimer) {
      clearTimeout(ambiguousPauseTimer);
      ambiguousPauseTimer = null;
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

  const terminalError = (code: string, message: string) => {
    if (settled) return;
    stopRequested = true;
    settled = true;
    clearPause();
    clearAmbiguousPause();
    clearRestart();
    recognitionRunning = false;
    logRecognitionTiming("recognition-terminal-error", startedAt, { code });
    handlers.onTerminalError?.({ code, message });
    resolveStop?.(currentTranscript());
    resolveStop = null;
    try {
      recognition.abort();
    } catch {
      // ignore
    }
  };

  const finalizeUtterance = (reason: "speech-end" | "fallback") => {
    if (utteranceSent || stopRequested || settled) return;
    const text = currentTranscript().trim();
    if (!text) return;
    utteranceSent = true;
    sentTranscript = text;
    clearPause();
    clearAmbiguousPause();
    logRecognitionTiming("end-of-turn", startedAt, {
      transcriptLength: text.length,
      reason,
    });
    handlers.onUtteranceEnd?.(text);
  };

  const armUtterancePause = () => {
    if (!handlers.onUtteranceEnd || utteranceSent || stopRequested || settled) return;
    if (speechActive) return;
    if (!currentTranscript().trim()) return;
    clearPause();
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (speechActive) return;
      finalizeUtterance("speech-end");
    }, CONFIRMED_SILENCE_MS);
  };

  const armAmbiguousPauseFallback = () => {
    if (!handlers.onUtteranceEnd || utteranceSent || stopRequested || settled) return;
    if (!currentTranscript().trim()) return;
    clearAmbiguousPause();
    // `onspeechend` is absent on some Chromium sessions. A result gap is not
    // normally considered silence; this is the bounded recovery path only
    // when the browser never sends a speech-end event.
    ambiguousPauseTimer = setTimeout(() => {
      ambiguousPauseTimer = null;
      if (speechEnded) return;
      finalizeUtterance("fallback");
    }, AMBIGUOUS_SILENCE_FALLBACK_MS);
  };

  const currentTranscript = () => {
    return mergeTranscript(committedText, sessionTranscript());
  };

  const emitPartial = () => {
    handlers.onPartial(currentTranscript());
  };

  recognition.onresult = (event) => {
    if (!firstResultSeen) {
      firstResultSeen = true;
      logRecognitionTiming("first-recognition-result", startedAt);
    }
    // A result is evidence that the engine is still receiving the utterance.
    // Do not let a pause armed for an earlier phrase submit while the browser
    // is delivering the next portion of a long sentence.
    // A final result often arrives *after* onspeechend. It is not new speech
    // and must re-arm the already-ended turn rather than cancelling it.
    if (!speechEnded) speechActive = true;
    clearPause();
    clearAmbiguousPause();
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
    rapidUnexpectedEnds = 0;
    // If the owner did not stop us after the last end-of-turn (the signal was
    // dropped or ignored), new words must be able to end a turn again;
    // otherwise every later question is silently never submitted.
    if (utteranceSent && currentTranscript().trim() !== sentTranscript) {
      utteranceSent = false;
    }
    emitPartial();
    if ([...finalSegments.values()].length > 0) {
      logRecognitionTiming("final-recognition-segment", startedAt, {
        transcriptLength: currentTranscript().trim().length,
      });
    }
    if (speechEnded) {
      armUtterancePause();
    } else {
      armAmbiguousPauseFallback();
    }
  };

  recognition.onspeechstart = () => {
    // Browser speech events arrive before the next interim result on some
    // Chrome builds. Clearing here protects the words immediately following a
    // natural pause from an old end-of-turn timer.
    speechActive = true;
    speechEnded = false;
    clearPause();
    clearAmbiguousPause();
  };

  recognition.onspeechend = () => {
    speechActive = false;
    speechEnded = true;
    armUtterancePause();
  };

  recognition.onsoundstart = () => {
    speechActive = true;
    speechEnded = false;
    clearPause();
    clearAmbiguousPause();
  };

  recognition.onsoundend = () => {
    speechActive = false;
    speechEnded = true;
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
      terminalError(
        code,
        "Microphone or speech permission was blocked. Allow mic access in the browser and try again.",
      );
    } else if (code === "audio-capture" || code === "language-not-supported" || code === "security") {
      terminalError(
        code,
        code === "audio-capture"
          ? "No microphone input is available. Check the selected microphone and try again."
          : "Browser speech recognition is unavailable for this language or page. Please try again.",
      );
    } else {
      handlers.onError("Could not hear that clearly. Please try speaking again.");
    }
  };

  recognition.onend = () => {
    recognitionRunning = false;
    if (settled) return;
    if (!stopRequested) {
      const runDuration = performance.now() - recognitionStartedAt;
      rapidUnexpectedEnds = runDuration < RAPID_END_WINDOW_MS
        ? rapidUnexpectedEnds + 1
        : 0;
      if (rapidUnexpectedEnds >= MAX_RAPID_UNEXPECTED_ENDS) {
        terminalError(
          "recognition-restart-loop",
          "Speech recognition stopped repeatedly. Please check microphone permission and try again.",
        );
        return;
      }
      logRecognitionTiming("recognition-ended-recovering", startedAt, {
        transcriptLength: currentTranscript().trim().length,
      });
      committedText = currentTranscript();
      finalSegments.clear();
      interimSegments.clear();
      // `onend` can follow a browser-imposed recognition boundary without a
      // preceding speechend. Preserve the accumulated turn and allow the
      // normal end-of-turn callback to finalize it instead of losing it.
      speechActive = false;
      speechEnded = true;
      armUtterancePause();
      // Chromium can end a continuous recognition session unexpectedly. Delay
      // the restart one task so the engine has fully released its prior state.
      clearRestart();
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (settled || stopRequested) return;
        try {
          recognition.start();
          recognitionRunning = true;
          recognitionStartedAt = performance.now();
          logRecognitionTiming("recognition-restarted", startedAt);
        } catch (error) {
          console.log("[AskPranaDictation] recognition restart failed:", error);
          terminalError(
            "recognition-restart-failed",
            "Speech recognition could not restart. Please try Voice Chat again.",
          );
        }
      }, RESTART_DELAY_MS);
      return;
    }
    settled = true;
    const text = currentTranscript();
    logRecognitionTiming("recognition-stopped", startedAt, { transcriptLength: text.trim().length });
    resolveStop?.(text);
    resolveStop = null;
  };

  try {
    recognition.start();
    recognitionRunning = true;
    recognitionStartedAt = performance.now();
    logRecognitionTiming("recognition-started", startedAt, { language: recognition.lang });
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
        logRecognitionTiming("recognition-stop-requested", startedAt);
        clearPause();
        clearAmbiguousPause();
        clearRestart();
        // `onend` may precede the last `onresult` in Chromium. Do not settle
        // immediately in that case: a short grace period preserves the final
        // words without reintroducing the former five-second stuck state.
        if (!recognitionRunning) {
          setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve(currentTranscript());
            }
          }, STOP_FINAL_RESULT_GRACE_MS);
          return;
        }
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
      clearAmbiguousPause();
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
