import { Platform } from "react-native";
import * as Speech from "expo-speech";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import {
  ensureValidSession,
  getSupabasePublicConfig,
} from "./supabase";
import {
  getAskPranaLanguageOption,
  type AskPranaSpeechLanguageCode,
} from "./ask-prana-language";
import { splitCompleteSentences } from "./ask-prana-sentences";

export type AskPranaSpeakResult = {
  spoke: boolean;
  provider: "expo-speech" | "openai-tts" | "none";
  reason?: string;
};

type AskPranaSpeakOptions = {
  shouldPlay?: () => boolean;
  onPlaybackStart?: () => void;
  /** Voice mode keeps its capture path alive while the reply is playing. */
  keepMicrophoneActive?: boolean;
  /** When set, a device voice that fails is skipped for the rest of this Voice Chat session. */
  voiceSession?: boolean;
};

let activePlayer: ReturnType<typeof createAudioPlayer> | null = null;
let speakGeneration = 0;
let speechOutputActive = false;
let speechOutputIdleAt = 0;

function markSpeechOutputStarted() {
  speechOutputActive = true;
}

function markSpeechOutputStopped() {
  speechOutputActive = false;
  speechOutputIdleAt = Date.now();
}

/** True only while a voice reply we started is still the active output. */
export function isAskPranaSpeechOutputActive() {
  return speechOutputActive;
}

/** Covers the short tail after stop, when a speaker can still be audible. */
export function wasAskPranaSpeechOutputRecent(withinMs = 1200) {
  return speechOutputActive || Date.now() - speechOutputIdleAt < withinMs;
}
const ttsAbortControllers = new Set<AbortController>();
const failedDeviceVoices = new Set<string>();
const activeAudioUrls = new Set<string>();

/** Clears the remembered device-voice failure when a Voice Chat session opens or closes. */
export function resetAskPranaVoiceSpeechSession() {
  failedDeviceVoices.clear();
}

function resumeWebSpeech() {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;
  try {
    synth.resume();
  } catch {
    // ignore
  }
}

export async function stopAskPranaSpeech() {
  speakGeneration += 1;
  markSpeechOutputStopped();
  for (const controller of ttsAbortControllers) controller.abort();
  ttsAbortControllers.clear();
  for (const url of activeAudioUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  activeAudioUrls.clear();
  try {
    await Speech.stop();
  } catch {
    // ignore
  }
  resumeWebSpeech();
  try {
    if (activePlayer) {
      activePlayer.pause();
      activePlayer.remove();
      activePlayer = null;
    }
  } catch {
    activePlayer = null;
  }
}

export async function isAskPranaSpeaking() {
  try {
    if (await Speech.isSpeakingAsync()) return true;
  } catch {
    // ignore
  }
  try {
    return Boolean(activePlayer?.playing);
  } catch {
    return false;
  }
}

async function hasDeviceVoiceFor(bcp47: string): Promise<boolean> {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    if (!voices?.length) {
      // Many Android builds still speak without listing voices reliably.
      return Platform.OS !== "web";
    }
    const prefix = bcp47.split("-")[0]?.toLowerCase() ?? "";
    return voices.some((voice) => {
      const lang = String(voice.language ?? "").toLowerCase();
      return lang === bcp47.toLowerCase() || lang.startsWith(`${prefix}-`) || lang === prefix;
    });
  } catch {
    return Platform.OS !== "web";
  }
}

const SPEECH_CHUNK_MAX_CHARS = 160;

/** Splits text at sentence ends, then commas, then spaces, into short pieces. */
export function splitSpeechChunks(text: string, maxChars = SPEECH_CHUNK_MAX_CHARS): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?\u0964\u0965\n]+[.!?\u0964\u0965]*\s*/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";
  const pushPiece = (piece: string) => {
    const trimmed = piece.trim();
    if (!trimmed) return;
    if (!current) {
      current = trimmed;
    } else if (current.length + 1 + trimmed.length <= maxChars) {
      current = `${current} ${trimmed}`;
    } else {
      chunks.push(current);
      current = trimmed;
    }
  };
  for (const sentence of sentences) {
    if (sentence.trim().length <= maxChars) {
      pushPiece(sentence);
      continue;
    }
    // A very long sentence: break at commas, then at word boundaries.
    for (const part of sentence.split(/(?<=[,;:])\s+/)) {
      if (part.length <= maxChars) {
        pushPiece(part);
        continue;
      }
      let rest = part.trim();
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        pushPiece(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      pushPiece(rest);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function speakChunkWithExpoSpeech(
  text: string,
  option: ReturnType<typeof getAskPranaLanguageOption>,
  generation: number,
  onStarted?: () => void,
): Promise<AskPranaSpeakResult> {
  return new Promise<AskPranaSpeakResult>((resolve) => {
    let settled = false;
    let started = false;
    // Some phone browsers accept speak() but never produce sound. If this
    // piece has not started within a few seconds, report failure so the
    // cloud voice is used instead of a silent "Speaking".
    const startTimer = setTimeout(() => {
      if (started || generation !== speakGeneration) return;
      void (async () => {
        if (started || generation !== speakGeneration) return;
        let engineSpeaking = false;
        try {
          engineSpeaking = await Speech.isSpeakingAsync();
        } catch {
          engineSpeaking = false;
        }
        if (started || generation !== speakGeneration) return;
        if (engineSpeaking) {
          started = true;
          onStarted?.();
          return;
        }
        void Speech.stop();
        finish({ spoke: false, provider: "none", reason: "The device voice did not start." });
      })();
    }, 4_000);
    // If a piece still never reports its end (audio-device change, engine
    // hiccup), skip it after a bounded wait instead of stalling the reply.
    const safetyMs = Math.min(45_000, Math.max(8_000, text.length * 110 + 4_000));
    const safetyTimer = setTimeout(() => {
      if (generation !== speakGeneration) {
        finish({ spoke: false, provider: "expo-speech", reason: "interrupted" });
        return;
      }
      console.log("[ask-prana-speech] speech piece did not report its end; continuing");
      void Speech.stop();
      finish({ spoke: true, provider: "expo-speech" });
    }, safetyMs);
    const finish = (result: AskPranaSpeakResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      clearTimeout(startTimer);
      resolve(result);
    };

    Speech.speak(text, {
      language: option.bcp47,
      rate: 0.95,
      pitch: 1,
      onStart: () => {
        if (generation !== speakGeneration || started) return;
        started = true;
        onStarted?.();
      },
      onDone: () => {
        if (generation !== speakGeneration) {
          finish({ spoke: false, provider: "expo-speech", reason: "interrupted" });
          return;
        }
        finish({ spoke: true, provider: "expo-speech" });
      },
      onStopped: () =>
        finish({ spoke: false, provider: "expo-speech", reason: "interrupted" }),
      onError: () => {
        if (generation !== speakGeneration) {
          finish({ spoke: false, provider: "expo-speech", reason: "interrupted" });
          return;
        }
        finish({
          spoke: false,
          provider: "none",
          reason: `Could not speak in ${option.nativeLabel} on this device.`,
        });
      },
    });
  });
}

type PreparedSpeech =
  | { kind: "device"; text: string }
  | { kind: "cloud"; text: string; uri: string }
  | { kind: "failed"; reason: string }
  | { kind: "interrupted" };

export type AskPranaSpeechQueue = {
  enqueue: (sentence: string) => void;
  /** Drops unplayed speech and speaks this text when playback has not started. */
  replaceUnplayed: (text: string) => void;
  close: () => void;
  cancel: () => void;
  done: Promise<AskPranaSpeakResult>;
};

function rememberAudioUrl(uri: string) {
  if (uri.startsWith("blob:")) activeAudioUrls.add(uri);
}

function forgetAudioUrl(uri: string) {
  if (!activeAudioUrls.has(uri)) return;
  activeAudioUrls.delete(uri);
  try {
    URL.revokeObjectURL(uri);
  } catch {
    // ignore
  }
}

async function audioUriFromResponse(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("text/")) {
    const raw = await response.text();
    let data: { audioBase64?: string; mimeType?: string; error?: string } = {};
    try {
      data = raw ? JSON.parse(raw) as typeof data : {};
    } catch {
      return null;
    }
    if (!response.ok || !data.audioBase64) return null;
    return `data:${data.mimeType || "audio/mpeg"};base64,${data.audioBase64}`;
  }
  if (!response.ok) return null;
  const blob = await response.blob();
  if (!blob.size) return null;
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(blob);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return `data:audio/mpeg;base64,${btoa(binary)}`;
}

async function fetchCloudSpeechAudio(
  text: string,
  language: AskPranaSpeechLanguageCode,
  generation: number,
): Promise<string | "interrupted" | null> {
  if (generation !== speakGeneration) return "interrupted";
  const auth = await ensureValidSession();
  const accessToken = auth?.access_token;
  if (!accessToken) return null;
  const config = getSupabasePublicConfig();
  const anonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (!config.url || !anonKey) return null;
  const controller = new AbortController();
  ttsAbortControllers.add(controller);
  try {
    if (generation !== speakGeneration) return "interrupted";
    const option = getAskPranaLanguageOption(language);
    const response = await fetch(`${config.url}/functions/v1/ask-prana-tts`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        language: option.llmLabel,
        languageCode: option.code,
        delivery: "audio",
      }),
    });
    if (generation !== speakGeneration) return "interrupted";
    const uri = await audioUriFromResponse(response);
    if (uri) rememberAudioUrl(uri);
    return uri;
  } catch (error) {
    if (controller.signal.aborted || generation !== speakGeneration) return "interrupted";
    console.log("[ask-prana-speech] cloud TTS failed:", error);
    return null;
  } finally {
    ttsAbortControllers.delete(controller);
  }
}

function playCloudUri(
  uri: string,
  generation: number,
  onStarted?: () => void,
  shouldPlay?: () => boolean,
): Promise<AskPranaSpeakResult> {
  return new Promise<AskPranaSpeakResult>((resolve) => {
    if (generation !== speakGeneration || shouldPlay?.() === false) {
      forgetAudioUrl(uri);
      resolve({ spoke: false, provider: "openai-tts", reason: "interrupted" });
      return;
    }
    if (activePlayer) {
      try {
        activePlayer.remove();
      } catch {
        // ignore
      }
      activePlayer = null;
    }
    const player = createAudioPlayer({ uri });
    activePlayer = player;
    player.play();
    const started = Date.now();
    let settled = false;
    let everPlayed = false;
    let replayed = false;
    let lastTime = 0;
    let lastAdvanceAt = started;
    const finish = (result: AskPranaSpeakResult, stop: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(safety);
      try {
        if (stop) player.pause();
        player.remove();
      } catch {
        // ignore
      }
      if (activePlayer === player) activePlayer = null;
      forgetAudioUrl(uri);
      resolve(result);
    };
    const timer = setInterval(() => {
      if (generation !== speakGeneration || shouldPlay?.() === false) {
        finish({ spoke: false, provider: "openai-tts", reason: "interrupted" }, true);
        return;
      }
      const status = player.currentStatus;
      const elapsed = Date.now() - started;
      const time = Number(status?.currentTime ?? 0);
      if (time > lastTime + 0.01) {
        lastTime = time;
        lastAdvanceAt = Date.now();
      }
      // Android browsers can play cloud audio while status.playing stays
      // false. Advancing currentTime means this sentence is audible.
      if (!everPlayed && (status?.playing || time > 0.05)) {
        everPlayed = true;
        onStarted?.();
      }
      const stalled = Date.now() - lastAdvanceAt > 800;
      if (status?.didJustFinish || (everPlayed && stalled && !status?.playing)) {
        finish({ spoke: true, provider: "openai-tts" }, false);
        return;
      }
      if (!everPlayed && !replayed && elapsed > 2_500) {
        replayed = true;
        player.play();
      }
      if (!everPlayed && elapsed > 10_000) {
        finish({
          spoke: false,
          provider: "none",
          reason: "The answer could not be played aloud. It is shown on screen.",
        }, true);
      }
    }, 200);
    const safety = setTimeout(() => {
      finish({ spoke: everPlayed, provider: everPlayed ? "openai-tts" : "none" }, true);
    }, 45_000);
  });
}

/**
 * Plays sentences in order. Cloud audio for the next sentence is fetched
 * while the current sentence plays. Only one sentence is prefetched.
 */
export function createAskPranaSpeechQueue(
  language: AskPranaSpeechLanguageCode,
  options?: AskPranaSpeakOptions,
): AskPranaSpeechQueue {
  const generation = speakGeneration;
  const option = getAskPranaLanguageOption(language);
  const pending: string[] = [];
  const seen = new Set<string>();
  let closed = false;
  let cancelled = false;
  let mode: "device" | "cloud" =
    options?.voiceSession && failedDeviceVoices.has(language) ? "cloud" : "device";
  let modeReady: Promise<void> | null = null;
  let preparing: Promise<PreparedSpeech> | null = null;
  let prepared: PreparedSpeech | null = null;
  let playing = false;
  let batch = 0;
  let everSpoke = false;
  let startReported = false;
  let settled = false;
  let lastReason = "Nothing to speak.";
  let resolveDone: (result: AskPranaSpeakResult) => void = () => undefined;
  const done = new Promise<AskPranaSpeakResult>((resolve) => {
    resolveDone = resolve;
  });
  const waiters: Array<() => void> = [];
  const wake = () => {
    const pendingWaiters = waiters.splice(0);
    pendingWaiters.forEach((waiter) => waiter());
  };
  const alive = () =>
    !cancelled && generation === speakGeneration && options?.shouldPlay?.() !== false;
  const finish = (result: AskPranaSpeakResult) => {
    if (settled) return;
    settled = true;
    if (generation === speakGeneration) markSpeechOutputStopped();
    resolveDone(result);
    wake();
  };
  const reportStart = () => {
    if (startReported) return;
    startReported = true;
    markSpeechOutputStarted();
    options?.onPlaybackStart?.();
  };
  const ensureMode = () => {
    if (!modeReady) {
      modeReady = (async () => {
        if (mode === "cloud") return;
        if (language === "en") return;
        const available = await hasDeviceVoiceFor(option.bcp47);
        if (!alive()) return;
        if (!available) {
          if (options?.voiceSession) failedDeviceVoices.add(language);
          mode = "cloud";
        }
      })();
    }
    return modeReady;
  };
  const pushSentence = (sentence: string) => {
    const cleaned = sentence.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    for (const chunk of splitSpeechChunks(cleaned)) pending.push(chunk);
    wake();
  };
  const prepareNext = async (text: string): Promise<PreparedSpeech> => {
    await ensureMode();
    if (!alive()) return { kind: "interrupted" };
    if (mode === "device") return { kind: "device", text };
    await setAudioModeAsync({
      allowsRecording: Boolean(options?.keepMicrophoneActive),
      playsInSilentMode: true,
    });
    const uri = await fetchCloudSpeechAudio(text, language, generation);
    if (uri === "interrupted" || !alive()) return { kind: "interrupted" };
    if (!uri) return { kind: "failed", reason: "Cloud speech is unavailable right now." };
    return { kind: "cloud", text, uri };
  };
  const playPrepared = async (item: PreparedSpeech): Promise<AskPranaSpeakResult> => {
    if (item.kind === "interrupted") {
      return { spoke: false, provider: "none", reason: "interrupted" };
    }
    if (item.kind === "failed") {
      return { spoke: false, provider: "none", reason: item.reason };
    }
    if (item.kind === "device") {
      if (mode === "cloud") {
        const cloud = await prepareNext(item.text);
        return playPrepared(cloud);
      }
      await setAudioModeAsync({
        allowsRecording: Boolean(options?.keepMicrophoneActive),
        playsInSilentMode: true,
      });
      if (!alive()) return { spoke: false, provider: "expo-speech", reason: "interrupted" };
      resumeWebSpeech();
      const spoken = await speakChunkWithExpoSpeech(item.text, option, generation, reportStart);
      if (spoken.spoke || spoken.reason === "interrupted") return spoken;
      try {
        await Speech.stop();
      } catch {
        // The device voice failed; don't leave it running under the cloud voice.
      }
      if (options?.voiceSession) failedDeviceVoices.add(language);
      mode = "cloud";
      const cloud = await prepareNext(item.text);
      return playPrepared(cloud);
    }
    return playCloudUri(item.uri, generation, reportStart, options?.shouldPlay);
  };
  const fillPrefetch = () => {
    if (preparing || prepared || pending.length === 0 || !alive()) return;
    const text = pending.shift();
    if (!text) return;
    const batchAtStart = batch;
    preparing = prepareNext(text).then((item) => {
      preparing = null;
      if (batchAtStart !== batch || !alive()) {
        if (item.kind === "cloud") forgetAudioUrl(item.uri);
        wake();
        return item;
      }
      prepared = item;
      wake();
      return item;
    });
  };
  const run = async () => {
    try {
      while (!settled) {
        if (!alive()) {
          finish({
            spoke: everSpoke,
            provider: everSpoke ? (mode === "cloud" ? "openai-tts" : "expo-speech") : "none",
            reason: "interrupted",
          });
          return;
        }
        if (!prepared && preparing) {
          await preparing;
          continue;
        }
        if (!prepared && pending.length > 0) fillPrefetch();
        if (!prepared && preparing) {
          await preparing;
          continue;
        }
        if (!prepared) {
          if (closed && pending.length === 0 && !preparing) {
            finish(
              everSpoke
                ? { spoke: true, provider: mode === "cloud" ? "openai-tts" : "expo-speech" }
                : { spoke: false, provider: "none", reason: lastReason },
            );
            return;
          }
          await new Promise<void>((resolve) => waiters.push(resolve));
          continue;
        }
        const current = prepared;
        prepared = null;
        if (pending.length > 0) fillPrefetch();
        playing = true;
        const result = await playPrepared(current);
        playing = false;
        if (current.kind === "cloud") forgetAudioUrl(current.uri);
        if (!alive() || result.reason === "interrupted") {
          finish({
            spoke: everSpoke || result.spoke,
            provider: result.provider,
            reason: "interrupted",
          });
          return;
        }
        if (result.spoke) {
          everSpoke = true;
          continue;
        }
        lastReason = result.reason || lastReason;
        if (current.kind === "cloud" && pending.length === 0 && closed && !everSpoke) {
          finish(result);
          return;
        }
      }
    } catch (error) {
      console.log("[ask-prana-speech] queue failed:", error);
      finish({
        spoke: everSpoke,
        provider: everSpoke ? (mode === "cloud" ? "openai-tts" : "expo-speech") : "none",
        reason: "Speech playback failed.",
      });
    }
  };
  void run();
  return {
    enqueue: (sentence) => {
      if (cancelled || settled) return;
      pushSentence(sentence);
    },
    replaceUnplayed: (text) => {
      if (cancelled || settled || startReported || playing || everSpoke) return;
      batch += 1;
      pending.splice(0);
      seen.clear();
      prepared = null;
      preparing = null;
      pushSentence(text);
    },
    close: () => {
      closed = true;
      wake();
    },
    cancel: () => {
      cancelled = true;
      pending.splice(0);
      prepared = null;
      wake();
    },
    done,
  };
}

/**
 * Speak assistant text aloud. Device speech plays sentence by sentence.
 * Cloud speech fetches one sentence at a time and prefetches the next.
 * Never claims success unless audio actually started.
 */
export async function speakAskPranaText(
  text: string,
  language: AskPranaSpeechLanguageCode,
  options?: AskPranaSpeakOptions,
): Promise<AskPranaSpeakResult> {
  const cleaned = text.replace(/\*\*/g, "").trim();
  if (!cleaned) {
    return { spoke: false, provider: "none", reason: "Nothing to speak." };
  }
  await stopAskPranaSpeech();
  const queue = createAskPranaSpeechQueue(language, options);
  for (const sentence of splitCompleteSentences(cleaned)) queue.enqueue(sentence);
  queue.close();
  return queue.done;
}
