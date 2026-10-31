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
};

let activePlayer: ReturnType<typeof createAudioPlayer> | null = null;
let speakGeneration = 0;

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

async function speakWithExpoSpeech(
  text: string,
  language: AskPranaSpeechLanguageCode,
  options?: AskPranaSpeakOptions,
): Promise<AskPranaSpeakResult> {
  if (options?.shouldPlay?.() === false) {
    return { spoke: false, provider: "none", reason: "interrupted" };
  }
  const option = getAskPranaLanguageOption(language);
  const available = await hasDeviceVoiceFor(option.bcp47);
  if (!available && language !== "en") {
    return {
      spoke: false,
      provider: "none",
      reason: `On-device speech for ${option.nativeLabel} is not available on this device.`,
    };
  }

  const generation = speakGeneration;
  await setAudioModeAsync({
    allowsRecording: Boolean(options?.keepMicrophoneActive),
    playsInSilentMode: true,
  });
  resumeWebSpeech();

  return await new Promise<AskPranaSpeakResult>((resolve) => {
    let settled = false;
    // Browser speech synthesis can occasionally omit both onDone and onError
    // after an audio-device change. Bound that failure so Voice Mode can
    // resume recognition instead of staying in Speaking forever.
    const safetyMs = Math.min(120_000, Math.max(30_000, text.length * 75 + 12_000));
    const safetyTimer = setTimeout(() => {
      finish({
        spoke: false,
        provider: "expo-speech",
        reason: "Speech playback did not finish. Listening has resumed.",
      });
    }, safetyMs);
    const finish = (result: AskPranaSpeakResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      resolve(result);
    };

    options?.onPlaybackStart?.();
    Speech.speak(text, {
      language: option.bcp47,
      rate: 0.95,
      pitch: 1,
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

async function speakWithOpenAiTts(
  text: string,
  language: AskPranaSpeechLanguageCode,
  options?: AskPranaSpeakOptions,
): Promise<AskPranaSpeakResult> {
  const auth = await ensureValidSession();
  const accessToken = auth?.access_token;
  if (!accessToken) {
    return { spoke: false, provider: "none", reason: "Not signed in for cloud speech." };
  }

  const config = getSupabasePublicConfig();
  const anonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (!config.url || !anonKey) {
    return {
      spoke: false,
      provider: "none",
      reason: "Speech service URL is not configured.",
    };
  }

  const option = getAskPranaLanguageOption(language);
  const response = await fetch(`${config.url}/functions/v1/ask-prana-tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      language: option.llmLabel,
      languageCode: option.code,
    }),
  });

  const raw = await response.text();
  let data: { audioBase64?: string; mimeType?: string; error?: string } = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return {
      spoke: false,
      provider: "none",
      reason: "Speech service returned an invalid response.",
    };
  }

  if (!response.ok || !data.audioBase64) {
    return {
      spoke: false,
      provider: "none",
      reason: data.error || "Cloud speech is unavailable right now.",
    };
  }

  if (options?.shouldPlay?.() === false) {
    return { spoke: false, provider: "none", reason: "interrupted" };
  }

  const generation = speakGeneration;
  const mime = data.mimeType || "audio/mpeg";
  const dataUri = `data:${mime};base64,${data.audioBase64}`;

  await setAudioModeAsync({
    allowsRecording: Boolean(options?.keepMicrophoneActive),
    playsInSilentMode: true,
  });

  if (activePlayer) {
    try {
      activePlayer.remove();
    } catch {
      // ignore
    }
    activePlayer = null;
  }

  const player = createAudioPlayer({ uri: dataUri });
  activePlayer = player;
  options?.onPlaybackStart?.();
  player.play();

  return await new Promise<AskPranaSpeakResult>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (generation !== speakGeneration) {
        clearInterval(timer);
        try {
          player.pause();
          player.remove();
        } catch {
          // ignore
        }
        if (activePlayer === player) activePlayer = null;
        resolve({ spoke: false, provider: "openai-tts", reason: "interrupted" });
        return;
      }

      const status = player.currentStatus;
      if (status?.didJustFinish || (status?.isLoaded && !status.playing && Date.now() - started > 800)) {
        clearInterval(timer);
        try {
          player.remove();
        } catch {
          // ignore
        }
        if (activePlayer === player) activePlayer = null;
        resolve({ spoke: true, provider: "openai-tts" });
      }
    }, 200);

    // Safety timeout (~2 min)
    setTimeout(() => {
      clearInterval(timer);
      try {
        player.pause();
        player.remove();
      } catch {
        // ignore
      }
      if (activePlayer === player) activePlayer = null;
      resolve({ spoke: true, provider: "openai-tts" });
    }, 120_000);
  });
}

/**
 * Speak assistant text aloud. Prefers cloud TTS for Indic languages, then device TTS.
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

  // A matching device voice begins immediately and avoids waiting for an entire
  // cloud audio file. Keep cloud TTS as the fallback for devices that do not
  // ship Telugu/Hindi voices.
  if (language !== "en") {
    try {
      const device = await speakWithExpoSpeech(cleaned, language, options);
      if (device.spoke) return device;
      if (device.reason === "interrupted") return device;
      const cloud = await speakWithOpenAiTts(cleaned, language, options);
      if (cloud.spoke || cloud.reason === "interrupted") return cloud;
      return {
        spoke: false,
        provider: "none",
        reason:
          device.reason ||
          cloud.reason ||
          "Speech playback is not available for this language on this device.",
      };
    } catch (error) {
      console.log("[ask-prana-speech] cloud TTS failed:", error);
    }
  }

  return speakWithExpoSpeech(cleaned, language === "en" ? "en" : language, options);
}
