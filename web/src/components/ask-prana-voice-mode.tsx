import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ASK_PRANA_FONT_FAMILY } from "../constants/ask-prana-typography";
import {
  isAskPranaAbortError,
  type AskPranaRequestContext,
  type AskPranaVoiceHandlers,
} from "../services/ask-prana";
import {
  ASK_PRANA_LANGUAGE_OPTIONS,
  type AskPranaSpeechLanguageCode,
} from "../lib/ask-prana-language";
import {
  createAskPranaSpeechQueue,
  isAskPranaSpeechOutputActive,
  resetAskPranaVoiceSpeechSession,
  stopAskPranaSpeech,
  warmAskPranaDeviceVoices,
  wasAskPranaSpeechOutputRecent,
  type AskPranaSpeechQueue,
} from "../lib/ask-prana-speech";
import { splitCompleteSentences } from "../lib/ask-prana-sentences";
import { currentVoiceTurnId } from "../lib/ask-prana-voice-turn-timing";
import {
  BARGE_IN_ECHO_LEARN_MS,
  BARGE_IN_ECHO_RATIO,
  stepBargeInEcho,
} from "../lib/ask-prana-barge-in";
import {
  chooseInterruptionTranscript,
  isAssistantEchoTranscript,
  isUnclearVoiceTranscript,
} from "../lib/ask-prana-voice-transcript";
import {
  createRecordingId,
  decideRecordingQuality,
  describeAppliedMicrophoneSettings,
  logRecordingCapture,
  microphoneCaptureConstraints,
  summarizeRecordingSignal,
} from "../lib/ask-prana-recording-capture";
import { createVoiceScreenWakeLock } from "../lib/ask-prana-screen-wake-lock";
import {
  createVoiceLanguageSwitch,
  shouldReleaseOwnedCapture,
  type VoiceLanguageSwitch,
} from "../lib/ask-prana-voice-language-switch";
import {
  logVoiceTranscription,
  transcribeVoiceRecording,
  type VoiceListenResult,
  type VoiceTranscriptionDecision,
} from "../services/ask-prana";
import {
  cloudLanguageForRecognition,
  type AskPranaRecognitionMode,
} from "../lib/ask-prana-transcription-language";
import {
  buildVoiceLanguageRequest,
  languageForQuestionText,
  languageForTypedVoiceQuestion,
} from "../lib/ask-prana-voice-language";
import {
  setVoiceAutoStopListener,
  setVoiceRecognitionErrorListener,
} from "../context/ask-prana-chat-context";

const colors = {
  primary: "#0F766E",
  primaryDark: "#0B5F59",
  // Same dark surfaces as the Ask Prana chat screen.
  background: "#171717",
  card: "#212121",
  white: "#FFFFFF",
  muted: "#9DB4B8",
  text: "#E8F4F2",
  danger: "#F87171",
  orb: "#14B8A6",
  orbSoft: "rgba(45, 212, 191, 0.35)",
};

function logVoiceTiming(stage: string, turnStartedAt: number, detail?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  const { turnId: voiceTurn, ...rest } = detail ?? {};
  console.debug("[AskPranaVoiceTiming]", stage, {
    turnId: currentVoiceTurnId(),
    voiceTurn: voiceTurn ?? null,
    elapsedMs: Math.round(performance.now() - turnStartedAt),
    ...rest,
  });
}

function logVoiceLifecycle(stage: string, detail?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  console.debug("[AskPranaVoiceLifecycle]", stage, {
    at: Math.round(performance.now()),
    ...detail,
  });
}

export type VoiceModeState =
  | "listening"
  | "finalizing"
  | "processing"
  | "speaking"
  | "interrupted"
  | "muted"
  | "reconnecting"
  | "switching"
  | "error"
  | "idle";

type TranscriptLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type VoiceBarActions = {
  toggleMute: () => void;
  end: () => void;
  submitTyped: () => void;
};

type Props = {
  visible: boolean;
  variant: "overlay" | "screen";
  language: AskPranaSpeechLanguageCode;
  requestContext: AskPranaRequestContext;
  isRecording: boolean;
  isTranscribing: boolean;
  audioLevel?: number;
  isSending: boolean;
  draft: string;
  onChangeDraft: (value: string) => void;
  onClose: () => void;
  onStartListening: (recognition: AskPranaRecognitionMode) => Promise<void>;
  /** Drops a display-only partial so a rejected turn cannot remain on screen. */
  onClearLiveTranscript?: () => void;
  onCancelListening: () => Promise<void>;
  onStopListeningToTranscript: () => Promise<VoiceListenResult>;
  onAsk: (
    question: string,
    context: AskPranaRequestContext,
    handlers?: AskPranaVoiceHandlers,
  ) => Promise<{ answer: string; language: AskPranaSpeechLanguageCode } | null>;
  onLanguageChange: (recognition: AskPranaRecognitionMode) => Promise<void>;
  onOpenMenu?: () => void;
  onAddImage?: () => void;
  onAddFile?: () => void;
  addImageLabel?: string;
  addFileLabel?: string;
  onMutedChange?: (muted: boolean) => void;
  onRegisterActions?: (actions: VoiceBarActions | null) => void;
  /** Cancels an answer that is still being generated. */
  onCancelAsk?: () => void;
};

function mixHex(from: string, to: string, amount: number) {
  const read = (hex: string) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const start = read(from);
  const end = read(to);
  const channel = start.map((value, index) =>
    Math.round(value + (end[index] - value) * amount),
  );
  return `rgb(${channel[0]}, ${channel[1]}, ${channel[2]})`;
}

function VoiceSkyOrb({
  size,
  scale,
  intensity = 0,
  motion,
  breathAmount,
}: {
  size: number;
  scale: number;
  intensity?: number;
  motion: Animated.Value;
  breathAmount: number;
}) {
  const breathScale = motion.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1 + breathAmount],
  });
  const uid = `ask-prana-orb-${Math.round(size)}-${Math.round(intensity * 100)}`;
  const animated = breathAmount > 0;
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        transform: [{ scale: Animated.multiply(scale, breathScale) }],
        backgroundColor: "#0F766E",
        shadowColor: "#2DD4BF",
        shadowOpacity: 0.22 + intensity * 0.45,
        shadowRadius: 10 + intensity * 24,
        elevation: 2 + Math.round(intensity * 8),
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <defs>
          <radialGradient id={`${uid}-base`} cx="38%" cy="30%" r="78%">
            <stop offset="0%" stopColor="#C8FFF6" />
            <stop offset="26%" stopColor="#5EEAD4" />
            <stop offset="65%" stopColor="#14B8A6" />
            <stop offset="100%" stopColor="#075F5A" />
          </radialGradient>
          <radialGradient id={`${uid}-aqua`} cx="50%" cy="45%" r="62%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.84" />
            <stop offset="42%" stopColor="#99F6E4" stopOpacity="0.52" />
            <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${uid}-ribbon`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#E6FFFB" stopOpacity="0.72" />
            <stop offset="48%" stopColor="#72F5DF" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#0B837A" stopOpacity="0.06" />
          </linearGradient>
          <filter id={`${uid}-soft`} x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <clipPath id={`${uid}-clip`}>
            <circle cx="100" cy="100" r="99" />
          </clipPath>
        </defs>
        <circle cx="100" cy="100" r="100" fill={`url(#${uid}-base)`} />
        <g clipPath={`url(#${uid}-clip)`}>
          <ellipse cx="68" cy="79" rx="76" ry="55" fill={`url(#${uid}-aqua)`} opacity="0.72" filter={`url(#${uid}-soft)`}>
            {animated ? <animateTransform attributeName="transform" type="translate" values="-12 6; 17 -9; -12 6" dur="6.4s" repeatCount="indefinite" /> : null}
          </ellipse>
          <ellipse cx="137" cy="130" rx="83" ry="49" fill="#0A8F84" opacity="0.52" filter={`url(#${uid}-soft)`}>
            {animated ? <animateTransform attributeName="transform" type="translate" values="13 -5; -18 11; 13 -5" dur="7.7s" repeatCount="indefinite" /> : null}
          </ellipse>
          <path d="M-22 127 C24 96 55 150 99 125 S171 84 224 123 L224 211 L-22 211 Z" fill={`url(#${uid}-ribbon)`} opacity="0.78">
            {animated ? <animateTransform attributeName="transform" type="translate" values="-8 9; 11 -8; -8 9" dur="5.3s" repeatCount="indefinite" /> : null}
          </path>
          <path d="M-26 154 C17 120 65 169 105 145 S177 111 228 148 L228 210 L-26 210 Z" fill="#D8FFF7" opacity="0.29">
            {animated ? <animateTransform attributeName="transform" type="translate" values="12 -4; -13 6; 12 -4" dur="6.8s" repeatCount="indefinite" /> : null}
          </path>
          <ellipse cx="79" cy="61" rx="35" ry="23" fill="#FFFFFF" opacity="0.24" filter={`url(#${uid}-soft)`}>
            {animated ? <animate attributeName="opacity" values="0.15;0.34;0.15" dur="4.8s" repeatCount="indefinite" /> : null}
          </ellipse>
        </g>
        <circle cx="100" cy="100" r="98" fill="none" stroke="#D9FFF8" strokeOpacity="0.3" strokeWidth="2" />
      </svg>
    </Animated.View>
  );
}

/**
 * Web-only procedural voice visualization. It intentionally uses Canvas rather
 * than CSS/SVG wave paths: overlapping radial color fields can drift without
 * exposing a repeated geometric edge. The draw loop mutates only the canvas,
 * never React state, and is released as soon as Voice Mode unmounts.
 */
function VoiceOrb({
  size,
  state,
  audioLevel,
  reducedMotion,
}: {
  size: number;
  state: VoiceModeState;
  audioLevel: number;
  reducedMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(audioLevel);
  stateRef.current = state;
  levelRef.current = audioLevel;

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    if (document.getElementById("ask-prana-voice-orb-styles")) return;
    const style = document.createElement("style");
    style.id = "ask-prana-voice-orb-styles";
    style.textContent = `
      @keyframes askPranaOrbGlow {
        0%, 100% { box-shadow: 0 0 18px rgba(45, 212, 191, .24), 0 0 42px rgba(20, 184, 166, .10); }
        50% { box-shadow: 0 0 31px rgba(153, 246, 228, .58), 0 0 76px rgba(20, 184, 166, .30); }
      }
      @keyframes askPranaOrbThink {
        0%, 100% { box-shadow: 0 0 18px rgba(45, 212, 191, .28), 0 0 48px rgba(20, 184, 166, .16); }
        50% { box-shadow: 0 0 40px rgba(153, 246, 228, .72), 0 0 92px rgba(20, 184, 166, .44); }
      }
      .ask-prana-fluid-orb { border-radius: 50%; overflow: hidden; background: #0f8f86; isolation: isolate; }
      .ask-prana-fluid-orb.listening { animation: askPranaOrbGlow 3.8s ease-in-out infinite; }
      .ask-prana-fluid-orb.processing { animation: askPranaOrbThink 1.45s ease-in-out infinite; }
      .ask-prana-fluid-orb.speaking { animation: askPranaOrbGlow 1.7s ease-in-out infinite; }
      .ask-prana-fluid-orb.reduced { animation: none; }
    `;
    document.head.appendChild(style);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    const renderSize = Math.min(Math.max(size, 88), 320);
    canvas.width = Math.round(renderSize * pixelRatio);
    canvas.height = Math.round(renderSize * pixelRatio);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    let frameId = 0;
    let mounted = true;
    const palette = [
      [221, 255, 249],
      [132, 245, 226],
      [55, 210, 193],
      [22, 169, 157],
      [189, 255, 243],
    ] as const;
    const paint = (time: number) => {
      if (!mounted) return;
      const currentState = stateRef.current;
      const stateEnergy = currentState === "speaking" ? 1 : currentState === "processing" ? 0.48 : 0.28;
      const meteredEnergy = Math.min(Math.max(levelRef.current, 0), 1);
      const energy = stateEnergy + meteredEnergy * 1.25;
      const t = reducedMotion ? 0 : time / 1000;
      const center = renderSize / 2;
      const radius = renderSize / 2;

      context.clearRect(0, 0, renderSize, renderSize);
      context.save();
      context.beginPath();
      context.arc(center, center, radius - 0.6, 0, Math.PI * 2);
      context.clip();

      const base = context.createRadialGradient(
        center - radius * 0.28,
        center - radius * 0.34,
        radius * 0.06,
        center,
        center,
        radius * 1.1,
      );
      base.addColorStop(0, "#dffff9");
      base.addColorStop(0.27, "#70ead9");
      base.addColorStop(0.68, "#119b91");
      base.addColorStop(1, "#075d58");
      context.fillStyle = base;
      context.fillRect(0, 0, renderSize, renderSize);

      // Five broad, feathered fields with incommensurate periods prevent a
      // visible loop and create the soft cloud motion of the orb.
      for (let index = 0; index < palette.length; index += 1) {
        const phase = index * 1.71;
        const orbit = radius * (0.18 + index * 0.035 + energy * 0.018);
        const x = center + Math.sin(t * (0.32 + index * 0.037) + phase) * orbit + Math.cos(t * 0.17 + phase) * radius * 0.16;
        const y = center + Math.cos(t * (0.26 + index * 0.041) + phase * 1.37) * orbit + Math.sin(t * 0.13 + phase) * radius * 0.14;
        const fieldRadius = radius * (0.57 + (index % 3) * 0.08 + Math.sin(t * 0.42 + phase) * 0.05 + energy * 0.035);
        const [red, green, blue] = palette[index];
        const field = context.createRadialGradient(x, y, 0, x, y, fieldRadius);
        field.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${0.32 + index * 0.035})`);
        field.addColorStop(0.42, `rgba(${red}, ${green}, ${blue}, ${0.16 + index * 0.018})`);
        field.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
        context.fillStyle = field;
        context.fillRect(0, 0, renderSize, renderSize);
      }

      const highlight = context.createRadialGradient(
        center + Math.sin(t * 0.37) * radius * 0.16,
        center - radius * 0.29 + Math.cos(t * 0.31) * radius * 0.09,
        0,
        center,
        center - radius * 0.1,
        radius * 0.8,
      );
      highlight.addColorStop(0, `rgba(255, 255, 255, ${0.22 + energy * 0.08})`);
      highlight.addColorStop(0.34, "rgba(226, 255, 250, 0.10)");
      highlight.addColorStop(1, "rgba(221, 255, 249, 0)");
      context.fillStyle = highlight;
      context.fillRect(0, 0, renderSize, renderSize);

      const edge = context.createRadialGradient(center, center, radius * 0.5, center, center, radius);
      edge.addColorStop(0, "rgba(0, 68, 65, 0)");
      edge.addColorStop(0.72, "rgba(1, 93, 87, 0.04)");
      edge.addColorStop(1, "rgba(0, 54, 52, 0.25)");
      context.fillStyle = edge;
      context.fillRect(0, 0, renderSize, renderSize);
      context.restore();

      if (!reducedMotion) frameId = window.requestAnimationFrame(paint);
    };
    paint(0);
    return () => {
      mounted = false;
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [reducedMotion, size]);

  if (Platform.OS !== "web") {
    return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: "#119B91" }} />;
  }
  return (
    <div
      className={`ask-prana-fluid-orb ${state} ${reducedMotion ? "reduced" : ""}`}
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} aria-hidden="true" style={{ display: "block", borderRadius: "50%" }} />
    </div>
  );
}

/** Audio kept from before the interruption was detected. */
const BARGE_IN_PREROLL_SEC = 1.2;
const BARGE_IN_MAX_CAPTURE_SEC = 30;
/** Pause after an interruption that ends the turn if the recognizer did not. */
const BARGE_IN_SILENCE_MS = 1800;
/** While Thinking there is no echo, but a cough or a door must not cancel the
 * answer, so speech has to last longer before it counts. */
const BARGE_IN_THINKING_SUSTAIN_MS = 450;
/** Below this, a "barge-in" was most likely echo or noise; skip transcription. */
const BARGE_IN_MIN_VOICED_MS = 250;
/** Mobile data can be slow; a too-short limit silently drops the user's words. */
const BARGE_IN_TRANSCRIBE_TIMEOUT_MS = 15000;
/**
 * Barge-in detection adapts to the microphone instead of using one fixed
 * loudness. Normal speech is enough on headphones; on speakers the reply's own
 * echo is measured first so the assistant does not interrupt itself.
 */
// Phones turn the user's voice down while the reply plays (echo cancelling),
// so 0.018 was often never reached. The room-noise and echo checks below
// still keep fans and the reply itself from counting.
const BARGE_IN_MIN_RMS = 0.012;
/** Speech must be this much louder than the room's background noise... */
const BARGE_IN_AMBIENT_RATIO = 2;
/** ...but a noisy room never raises the bar above this. */
const BARGE_IN_AMBIENT_CAP = 0.04;
/** The echo level is not updated this soon after the user was heard. */
const BARGE_IN_ECHO_HOLD_MS = 400;
const BARGE_IN_DEAF_MESSAGE =
  "I can't hear you while the answer is playing. Tap the circle to interrupt.";
/** How long speech must continue (short dips allowed) to count as an interruption. */
const BARGE_IN_SUSTAIN_MS = 250;
/** After an interruption starts, below this level counts as a pause. */
const BARGE_IN_CAPTURE_MIN_RMS = 0.015;
const WAV_SAMPLE_RATE = 16000;

type InterruptCapture = {
  /** Recognition mode when this interruption began. */
  recognition: AskPranaRecognitionMode;
  turnId: string;
  hadSpeech: () => boolean;
  /** Stops capture and returns 16 kHz mono WAV of the interruption. */
  takeWav: () => {
    blob: Blob | null;
    recordingId: string;
    rejectedMessage: string | null;
  };
};

function encodeWav(blocks: Float32Array[], length: number, inputRate: number): Blob {
  const ratio = inputRate / WAV_SAMPLE_RATE;
  const outLength = Math.floor(length / ratio);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const block of blocks) {
    merged.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
    offset += block.length;
    if (offset >= length) break;
  }
  const buffer = new ArrayBuffer(44 + outLength * 2);
  const view = new DataView(buffer);
  const writeText = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + outLength * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, outLength * 2, true);
  for (let i = 0; i < outLength; i += 1) {
    // Average each input window: a cheap low-pass that avoids aliasing.
    const start = Math.floor(i * ratio);
    const end = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += merged[j];
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function interruptionSignal(blocks: Float32Array[], length: number, inputRate: number) {
  const merged = new Float32Array(length);
  let offset = 0;
  for (const block of blocks) {
    const count = Math.min(block.length, length - offset);
    if (count <= 0) break;
    merged.set(block.subarray(0, count), offset);
    offset += count;
  }
  return decideRecordingQuality(summarizeRecordingSignal(merged.subarray(0, offset), inputRate));
}

async function transcribeInterruption(
  wav: Blob,
  recognition: AskPranaRecognitionMode,
  turnId: string,
  recordingId: string,
): Promise<VoiceTranscriptionDecision> {
  try {
    const decision = await Promise.race([
      transcribeVoiceRecording({
        uri: "voice-interruption.wav",
        blob: wav,
        mimeType: "audio/wav",
        fileName: "voice-interruption.wav",
        recognition,
        turnId,
        provider: "cloud-recorder",
        recordingId,
      }),
      new Promise<VoiceTranscriptionDecision>((resolve) =>
        setTimeout(() => resolve({ action: "repeat", retryCount: 0, reason: "empty" }), BARGE_IN_TRANSCRIBE_TIMEOUT_MS),
      ),
    ]);
    return decision;
  } catch (error) {
    console.log("[AskPranaVoice] interruption transcription failed:", error);
    logVoiceTranscription({
      turnId,
      provider: "cloud-recorder",
      selectedLanguage: recognition,
      languageSent: cloudLanguageForRecognition(recognition),
      retryCount: 0,
      reason: "interruption-failed",
    });
    return { action: "repeat", retryCount: 0, reason: "interruption-failed" };
  }
}

function voiceTurnErrorMessage(error: unknown) {
  const raw = error instanceof Error
    ? error.message.trim()
    : typeof error === "string"
      ? error.trim()
      : "";
  if (raw === "VOICE_RECOGNITION_BUSY") {
    return "The microphone is still switching. Please try again.";
  }
  if (raw) return raw;
  return "Could not process that voice turn. Check your connection and try again.";
}

export function AskPranaVoiceModeModal({
  visible,
  variant,
  language,
  requestContext,
  isRecording,
  isTranscribing,
  audioLevel: recorderAudioLevel = 0,
  isSending,
  draft,
  onChangeDraft,
  onClose,
  onStartListening,
  onClearLiveTranscript,
  onCancelListening,
  onStopListeningToTranscript,
  onAsk,
  onLanguageChange,
  onOpenMenu,
  onAddImage,
  onAddFile,
  addImageLabel = "Add image",
  addFileLabel = "Add file",
  onMutedChange,
  onRegisterActions,
  onCancelAsk,
}: Props) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<VoiceModeState>("idle");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [wakeLockNote, setWakeLockNote] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(false);
  const [slowAnswer, setSlowAnswer] = useState(false);
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [retryQuestion, setRetryQuestion] = useState<string | null>(null);
  const retryLanguageRef = useRef<AskPranaSpeechLanguageCode | null>(null);
  const [recognitionMode, setRecognitionMode] = useState<AskPranaRecognitionMode>("auto");
  const [captionTurn, setCaptionTurn] = useState(0);
  const recognitionModeRef = useRef<AskPranaRecognitionMode>("auto");
  /** Assistant text already handed to speech, used to ignore its own echo. */
  const recentSpokenRef = useRef("");
  const loopArmedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const stateRef = useRef<VoiceModeState>("idle");
  const isRecordingRef = useRef(false);
  const orbPressLockRef = useRef(false);
  /** Stops the barge-in mic stream, detection loop and PCM capture. */
  const bargeInReleaseRef = useRef<(() => void) | null>(null);
  const bargeInTriggeredRef = useRef(false);
  /** When the reply was handed to the speaker (lets barge-in learn its echo). */
  const bargeInPlaybackStartedAtRef = useRef<number | null>(null);
  /** The answer still loading when the user spoke during Thinking. Kept so a
   * noise (empty transcript) does not throw the answer away. */
  type HeldAsk = {
    question: string;
    language: AskPranaSpeechLanguageCode;
    promise: Promise<{ answer: string; language: AskPranaSpeechLanguageCode } | null>;
  };
  const pendingAskRef = useRef<HeldAsk | null>(null);
  const heldAskRef = useRef<HeldAsk | null>(null);
  /** Audio of the current interruption, including its pre-roll. */
  const interruptCaptureRef = useRef<InterruptCapture | null>(null);
  const runTurnRef = useRef<(transcript: string) => Promise<void>>(async () => {});
  /** Lets the barge-in monitor (declared earlier) start the normal listener. */
  const interruptListeningRef = useRef<() => Promise<unknown>>(async () => {});
  /** Lets the barge-in monitor (declared earlier) end the interrupting turn. */
  const finishListeningTurnRef = useRef<() => Promise<void>>(async () => {});
  const speechTurnRef = useRef(0);
  const speechQueueRef = useRef<AskPranaSpeechQueue | null>(null);
  const requestLockRef = useRef(false);
  const requestLockIdRef = useRef(0);
  const speechEndedAtRef = useRef<number | null>(null);
  /** Invalidates callbacks from a closed/reopened modal session. */
  const voiceSessionIdRef = useRef(0);
  /** Exactly one user turn may advance through finalizing/AI/TTS at a time. */
  const turnInFlightRef = useRef(false);
  /** Invalidates a stale recognition start while a newer start is pending. */
  const listeningAttemptRef = useRef(0);
  const onCancelListeningRef = useRef(onCancelListening);
  onCancelListeningRef.current = onCancelListening;
  const startListeningSafelyRef = useRef<
    (reason: "open" | "resume" | "retry" | "interrupt" | "visibility", languageOverride?: AskPranaRecognitionMode) => Promise<boolean>
  >(async () => false);
  const languageSwitchRef = useRef<VoiceLanguageSwitch<AskPranaRecognitionMode> | null>(null);
  /** Browser tab suspension stops recognition without a reliable onend event. */
  const resumeAfterVisibilityRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const appendLine = useCallback((role: "user" | "assistant", text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLines((current) => [
      ...current,
      { id: `${Date.now()}-${role}-${current.length}`, role, text: trimmed },
    ]);
  }, []);

  useEffect(() => {
    if (!visible) {
      setVoiceRecognitionErrorListener(null);
      return;
    }
    setVoiceRecognitionErrorListener((message) => {
      if (!sessionActiveRef.current) return;
      turnInFlightRef.current = false;
      setState("error");
      stateRef.current = "error";
      setErrorText(message);
      logVoiceLifecycle("recognition-terminal-error", {
        sessionId: voiceSessionIdRef.current,
      });
    });
    return () => setVoiceRecognitionErrorListener(null);
  }, [visible]);

  const stopBargeInMonitor = useCallback(() => {
    bargeInReleaseRef.current?.();
    bargeInReleaseRef.current = null;
    interruptCaptureRef.current = null;
    bargeInTriggeredRef.current = false;
  }, []);

  const startBargeInMonitorNow = useCallback(async () => {
    // Keep one echo-cancelled stream open while TTS plays. It detects that the
    // user started talking and keeps a short rolling PCM buffer, so the first
    // words of an interruption (spoken before the browser recognizer is up)
    // are not lost. The recognizer still runs for live text and end-of-turn.
    const reportBargeInDeaf = () => {
      if (!sessionActiveRef.current) return;
      const current = stateRef.current;
      if (current !== "speaking" && current !== "processing") return;
      console.log("[AskPranaVoice] barge-in monitor cannot hear the microphone");
      setErrorText(BARGE_IN_DEAF_MESSAGE);
    };
    if (Platform.OS !== "web" || typeof window === "undefined" || bargeInReleaseRef.current) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      reportBargeInDeaf();
      return;
    }

    try {
      const recordingId = createRecordingId();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneCaptureConstraints(),
      });
      const interruptionTrack = stream.getAudioTracks()[0];
      logRecordingCapture({
        recordingId,
        stage: "interruption-microphone-opened",
        settings: describeAppliedMicrophoneSettings(interruptionTrack),
      });
      if (!interruptionTrack || interruptionTrack.readyState === "ended") {
        stream.getTracks().forEach((track) => track.stop());
        reportBargeInDeaf();
        return;
      }
      if (
        !sessionActiveRef.current ||
        (stateRef.current !== "speaking" && stateRef.current !== "processing")
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const AudioContextCtor = window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        stream.getTracks().forEach((track) => track.stop());
        reportBargeInDeaf();
        return;
      }
      const audioContext = new AudioContextCtor();
      if (audioContext.state === "suspended") {
        // Created after async work (or after a reload straight into Voice
        // Mode) the context can start suspended and deliver only silence,
        // which silently disables interruption. Resume it explicitly.
        try {
          await audioContext.resume();
        } catch {
          // handled below
        }
      }
      if (audioContext.state !== "running" || interruptionTrack.muted) {
        console.log("[AskPranaVoice] barge-in audio context not running:", audioContext.state);
        stream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
        reportBargeInDeaf();
        return;
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);

      // Raw PCM capture. A muted gain node keeps the processor pulled by the
      // graph without playing the microphone back through the speakers.
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const sink = audioContext.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(audioContext.destination);
      logRecordingCapture({
        recordingId,
        stage: "interruption-capture-ready",
        sampleRate: audioContext.sampleRate,
        contextState: audioContext.state,
        settings: describeAppliedMicrophoneSettings(interruptionTrack),
        decision: "graph-running",
      });
      const sampleRate = audioContext.sampleRate;
      const preRollSamples = Math.round(sampleRate * BARGE_IN_PREROLL_SEC);
      const maxSamples = Math.round(sampleRate * BARGE_IN_MAX_CAPTURE_SEC);
      const pcm: Float32Array[] = [];
      let pcmLength = 0;
      let capturing = false;
      processor.onaudioprocess = (event) => {
        if (capturing && pcmLength >= maxSamples) return;
        const block = new Float32Array(event.inputBuffer.getChannelData(0));
        pcm.push(block);
        pcmLength += block.length;
        if (!capturing) {
          while (pcm.length > 1 && pcmLength - pcm[0].length >= preRollSamples) {
            pcmLength -= pcm.shift()!.length;
          }
        }
      };

      let released = false;
      let frameId: number | null = null;
      const release = () => {
        if (released) return;
        released = true;
        if (frameId != null) window.cancelAnimationFrame(frameId);
        frameId = null;
        processor.onaudioprocess = null;
        try { source.disconnect(); processor.disconnect(); sink.disconnect(); } catch { /* ignore */ }
        stream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
        if (bargeInReleaseRef.current === release) bargeInReleaseRef.current = null;
      };
      bargeInReleaseRef.current = release;

      // Adaptive detection. Before the reply starts playing, the mic hears
      // only the room, so that sets the background level. For a short moment
      // after playback starts, the mic hears the reply's own echo (speakers),
      // so that sets the echo level. An interruption is speech clearly louder
      // than both, kept up for BARGE_IN_SUSTAIN_MS.
      const monitorStartedAt = Date.now();
      // Only guard the brief output-route click.
      const ignoreUntil = monitorStartedAt + 120;
      let ambient = 0;
      let echoRef = 0;
      let echoCeiling = 0;
      let smoothed = 0;
      let voicedRun = 0;
      let voicedMs = 0;
      let lastVoicedAt = 0;
      let lastFrameAt = monitorStartedAt;
      let silenceSince = 0;
      let autoFinished = false;
      let loggedThreshold = false;
      bargeInPlaybackStartedAtRef.current = null;

      const monitor = () => {
        if (released) return;
        if (stream.getAudioTracks().every((track) => track.readyState === "ended")) {
          reportBargeInDeaf();
          release();
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / samples.length);
        setAudioLevel((current) => Math.abs(current - rms) > 0.012 ? rms : current);
        const now = Date.now();
        // Real elapsed time keeps behaviour the same on 60 Hz and 144 Hz screens.
        const elapsed = Math.min(Math.max(now - lastFrameAt, 0), 100);
        lastFrameAt = now;
        smoothed = smoothed ? smoothed * 0.6 + rms * 0.4 : rms;

        if (!capturing) {
          // Playback can be audible before React leaves "Preparing". Treat
          // that output as the assistant, not as a new question.
          if (
            isAskPranaSpeechOutputActive() &&
            bargeInPlaybackStartedAtRef.current == null
          ) {
            bargeInPlaybackStartedAtRef.current = now;
            voicedRun = 0;
          }
          const playbackAt = bargeInPlaybackStartedAtRef.current;
          const learningEcho =
            playbackAt != null && now - playbackAt < BARGE_IN_ECHO_LEARN_MS;
          if (playbackAt == null && now >= ignoreUntil) {
            // Reply not playing yet: the mic hears only the room. Follow the
            // quiet floor (drops at once, rises slowly) so a user who starts
            // talking early is not mistaken for background noise.
            ambient = !ambient || smoothed < ambient
              ? smoothed
              : ambient + (smoothed - ambient) * Math.min(1, elapsed / 4000);
          }
          // Measure the reply briefly, then stop later peaks from raising the
          // volume a person has to beat. A quieter stretch lowers it. The
          // user's own voice is not learned: once it counts, the hold skips
          // this update.
          let rejoin = false;
          if (playbackAt != null && (learningEcho || now - lastVoicedAt > BARGE_IN_ECHO_HOLD_MS)) {
            const before = { echoRef, echoCeiling };
            const stepped = stepBargeInEcho(
              before,
              smoothed,
              elapsed,
              learningEcho ? "learn" : "follow",
            );
            rejoin = !learningEcho && isAskPranaSpeechOutputActive() && stepped.rejoin;
            if (learningEcho || rejoin || !stepped.rejoin) {
              echoRef = stepped.echoRef;
              echoCeiling = stepped.echoCeiling;
            }
            if (stepped.rejoin && !rejoin) {
              echoRef = before.echoRef;
              echoCeiling = before.echoCeiling;
            }
          }
          const echoForThreshold = echoCeiling > 0 ? Math.min(echoRef, echoCeiling) : echoRef;
          const threshold = Math.max(
            BARGE_IN_MIN_RMS,
            Math.min(ambient * BARGE_IN_AMBIENT_RATIO, BARGE_IN_AMBIENT_CAP),
            echoForThreshold * BARGE_IN_ECHO_RATIO,
          );
          const voiced = !learningEcho && !rejoin && now >= ignoreUntil && smoothed > threshold;
          if (voiced) {
            voicedRun += elapsed;
            lastVoicedAt = now;
          } else {
            // Short dips between syllables do not reset the run.
            voicedRun = Math.max(0, voicedRun - elapsed * 2);
          }
          if (learningEcho) voicedRun = 0;
          if (playbackAt != null && !learningEcho && !loggedThreshold) {
            loggedThreshold = true;
            logVoiceLifecycle("barge-in-calibrated", {
              ambient: Number(ambient.toFixed(4)),
              echo: Number(echoRef.toFixed(4)),
              ceiling: Number(echoCeiling.toFixed(4)),
              threshold: Number(threshold.toFixed(4)),
            });
          }
          const duringThinking = stateRef.current === "processing";
          const sustainNeeded = duringThinking ? BARGE_IN_THINKING_SUSTAIN_MS : BARGE_IN_SUSTAIN_MS;
          if (voicedRun >= sustainNeeded && !bargeInTriggeredRef.current) {
            bargeInTriggeredRef.current = true;
            // Speaking during Thinking: keep the loading answer until we know
            // the user really said something (see finishListeningTurn).
            heldAskRef.current = duringThinking ? pendingAskRef.current : null;
            capturing = true;
            voicedMs = voicedRun;
            interruptCaptureRef.current = {
              recognition: recognitionModeRef.current,
              turnId: `${voiceSessionIdRef.current}-${speechTurnRef.current + 1}`,
              hadSpeech: () => voicedMs >= BARGE_IN_MIN_VOICED_MS,
              takeWav: () => {
                const quality = pcmLength ? interruptionSignal(pcm, pcmLength, sampleRate) : null;
                const blob = quality?.action === "accept" ? encodeWav(pcm, pcmLength, sampleRate) : null;
                logRecordingCapture({
                  recordingId,
                  stage: "interruption-finalized",
                  durationMs: quality?.summary.durationMs,
                  sampleRate,
                  rms: quality?.summary.rms,
                  peak: quality?.summary.peak,
                  clippedRatio: quality?.summary.clippedRatio,
                  voicedMs: quality?.summary.voicedMs,
                  decision: quality?.reason ?? "empty",
                });
                release();
                return {
                  blob,
                  recordingId,
                  rejectedMessage: quality?.action === "reject" ? quality.message : null,
                };
              },
            };
            logVoiceLifecycle("barge-in-triggered", {
              rms: Number(smoothed.toFixed(4)),
              threshold: Number(threshold.toFixed(4)),
            });
            // Retire the reply's turn: its speak() call returns "interrupted"
            // and must not restart listening on top of this handoff.
            speechTurnRef.current += 1;
            setState("interrupted");
            stateRef.current = "interrupted";
            speechQueueRef.current?.cancel();
            speechQueueRef.current = null;
            void stopAskPranaSpeech();
            void interruptListeningRef.current();
          }
        } else {
          // The reply has stopped, so only the room and the user remain.
          const captureThreshold = Math.max(
            BARGE_IN_CAPTURE_MIN_RMS,
            Math.min(ambient * 2, BARGE_IN_AMBIENT_CAP),
          );
          if (smoothed > captureThreshold) {
            voicedMs += elapsed;
            silenceSince = 0;
          } else if (!silenceSince) {
            silenceSince = now;
          }
          // The browser recognizer often misses the start of speech that
          // began before it was running and then never reports end-of-turn.
          // End the turn from this stream so the question is never stranded.
          if (
            !autoFinished &&
            ((silenceSince && now - silenceSince >= BARGE_IN_SILENCE_MS) ||
              pcmLength >= maxSamples)
          ) {
            autoFinished = true;
            void finishListeningTurnRef.current();
          }
        }
        frameId = window.requestAnimationFrame(monitor);
      };
      frameId = window.requestAnimationFrame(monitor);
      setErrorText((current) => (current === BARGE_IN_DEAF_MESSAGE ? null : current));
    } catch (error) {
      // Orb tap, mute, and close still interrupt. Say so, instead of looking
      // as if the microphone were open while the recognizer never starts.
      console.log("[AskPranaVoice] barge-in monitor unavailable:", error);
      reportBargeInDeaf();
    }
  }, []);

  /** One start at a time: Thinking and Speaking both ask for the monitor, and
   * two overlapping starts would open the microphone twice. */
  const bargeInStartingRef = useRef<Promise<void> | null>(null);
  const startBargeInMonitor = useCallback((): Promise<void> => {
    if (bargeInStartingRef.current) return bargeInStartingRef.current;
    const starting = startBargeInMonitorNow().finally(() => {
      if (bargeInStartingRef.current === starting) bargeInStartingRef.current = null;
    });
    bargeInStartingRef.current = starting;
    return starting;
  }, [startBargeInMonitorNow]);

  const cleanupSession = useCallback(async () => {
    const closingSessionId = voiceSessionIdRef.current;
    languageSwitchRef.current?.abandon();
    sessionActiveRef.current = false;
    loopArmedRef.current = false;
    listeningAttemptRef.current += 1;
    turnInFlightRef.current = false;
    speechTurnRef.current += 1;
    speechQueueRef.current?.cancel();
    speechQueueRef.current = null;
    resetAskPranaVoiceSpeechSession();
    onCancelAsk?.();
    logVoiceLifecycle("session-closed", { sessionId: closingSessionId });
    stopBargeInMonitor();
    // The parent also cancels on its close handler, but keeping teardown here
    // makes modal unmounts and route changes release the microphone promptly.
    await onCancelListening();
    await stopAskPranaSpeech();
    setState("idle");
    stateRef.current = "idle";
  }, [onCancelAsk, onCancelListening, stopBargeInMonitor]);

  const startListeningSafely = useCallback(
    async (
      reason: "open" | "resume" | "retry" | "interrupt" | "visibility",
      languageOverride?: AskPranaRecognitionMode,
    ) => {
      const sessionId = voiceSessionIdRef.current;
      const attemptId = ++listeningAttemptRef.current;
      const listenLanguage = languageOverride ?? recognitionModeRef.current;
      if (!sessionActiveRef.current || mutedRef.current) return false;
      if (
        Platform.OS === "web" &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        resumeAfterVisibilityRef.current = true;
        return false;
      }

      turnInFlightRef.current = false;
      setSubmittedQuestion(null);
      onClearLiveTranscript?.();
      if (reason !== "interrupt" && interruptCaptureRef.current) {
        // A capture left over from a failed interruption must not be merged
        // into an unrelated later turn.
        stopBargeInMonitor();
      }
      // Listening stays hidden until capture is ready.
      setErrorText(null);
      logVoiceLifecycle("recognition-start-requested", { sessionId, attemptId, reason });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await onStartListening(listenLanguage);
          const ownsCapture = shouldReleaseOwnedCapture(attemptId, listeningAttemptRef.current);
          const sessionCurrent = sessionActiveRef.current && voiceSessionIdRef.current === sessionId;
          if (!ownsCapture || !sessionCurrent || mutedRef.current) {
            // Release this attempt only while it still owns the microphone.
            // A newer language selection must keep the capture it just started.
            if (ownsCapture && sessionCurrent) await onCancelListening();
            return false;
          }
          setState("listening");
          stateRef.current = "listening";
          logVoiceLifecycle("recognition-started", { sessionId, attemptId, reason, attempt });
          return true;
        } catch (error) {
          const retryable = error instanceof Error && error.message === "VOICE_RECOGNITION_BUSY";
          if (
            retryable &&
            attempt === 0 &&
            sessionActiveRef.current &&
            voiceSessionIdRef.current === sessionId &&
            listeningAttemptRef.current === attemptId
          ) {
            // Chromium can release the barge-in/TTS microphone stream a task
            // after playback ends. One short retry handles that handoff without
            // creating an unbounded restart loop.
            await new Promise<void>((resolve) => setTimeout(resolve, 180));
            continue;
          }
          if (
            !sessionActiveRef.current ||
            voiceSessionIdRef.current !== sessionId ||
            listeningAttemptRef.current !== attemptId
          ) {
            return false;
          }
          if (reason === "interrupt" && interruptCaptureRef.current) {
            // Phones often refuse a second microphone while the interruption
            // monitor holds one. Its capture already has the user's words and
            // ends the turn on silence, so keep listening instead of failing
            // and throwing the interruption away.
            logVoiceLifecycle("recognition-start-failed-using-capture", { sessionId, attemptId });
            return true;
          }
          setState("error");
          stateRef.current = "error";
          setErrorText(voiceTurnErrorMessage(error));
          logVoiceLifecycle("recognition-start-failed", { sessionId, attemptId, attempt });
          return false;
        }
      }
      return false;
    },
    [onCancelListening, onClearLiveTranscript, onStartListening, stopBargeInMonitor],
  );
  startListeningSafelyRef.current = startListeningSafely;
  if (!languageSwitchRef.current) {
    languageSwitchRef.current = createVoiceLanguageSwitch({
      invalidate: () => {
        listeningAttemptRef.current += 1;
      },
      cancelCapture: () => onCancelListeningRef.current(),
      startCapture: (mode) => startListeningSafelyRef.current("resume", mode),
      isSessionOpen: () => sessionActiveRef.current,
      isMuted: () => mutedRef.current,
    });
  }

  useEffect(() => {
    interruptListeningRef.current = () => startListeningSafely("interrupt");
  }, [startListeningSafely]);

  useEffect(() => {
    if (!visible) {
      void cleanupSession();
      setLines([]);
      setErrorText(null);
      mutedRef.current = false;
      setMuted(false);
      return;
    }

    sessionActiveRef.current = true;
    voiceSessionIdRef.current += 1;
    // Each Voice Chat session starts in Auto. The website language and the
    // previous session's recognition choice do not carry into this recording.
    recognitionModeRef.current = "auto";
    setRecognitionMode("auto");
    resetAskPranaVoiceSpeechSession();
    warmAskPranaDeviceVoices();
    turnInFlightRef.current = false;
    loopArmedRef.current = true;
    logVoiceLifecycle("session-opened", { sessionId: voiceSessionIdRef.current });
    setState(muted ? "muted" : "idle");
    stateRef.current = muted ? "muted" : "idle";
    if (!muted) {
      void startListeningSafely("open");
    }

    return () => {
      languageSwitchRef.current?.abandon();
      sessionActiveRef.current = false;
      stopBargeInMonitor();
      void onCancelListening();
      void stopAskPranaSpeech();
    };
    // Intentionally run on visible/muted open only.
    // Session lifetime is tied to visibility; changing callback identities or
    // mute state must not tear down an active microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof navigator === "undefined" || typeof document === "undefined") {
      return;
    }
    const sessionId = voiceSessionIdRef.current;
    const navigatorWithLock = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void>; addEventListener?: (type: "release", listener: () => void) => void; removeEventListener?: (type: "release", listener: () => void) => void }> };
    };
    const wakeLock = createVoiceScreenWakeLock({
      supported: typeof navigatorWithLock.wakeLock?.request === "function",
      request: () => navigatorWithLock.wakeLock!.request("screen"),
      isDocumentVisible: () => document.visibilityState === "visible",
      onUnavailable: (message) => setWakeLockNote(message),
    });
    wakeLock.open(sessionId, document.visibilityState === "visible");
    const onVisibility = () => {
      wakeLock.onDocumentVisibility(sessionId, document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      setWakeLockNote(null);
      void wakeLock.close(sessionId);
    };
  }, [visible]);

  useEffect(() => {
    if (
      !visible ||
      Platform.OS !== "web" ||
      typeof document === "undefined"
    ) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // A hidden Chrome/Edge tab can terminate SpeechRecognition without an
        // event. Cancel the stale capture deliberately so the UI cannot claim
        // it is still listening, but leave the persisted chat untouched.
        if (stateRef.current === "listening") {
          resumeAfterVisibilityRef.current = true;
          listeningAttemptRef.current += 1;
          turnInFlightRef.current = false;
          setState("reconnecting");
          stateRef.current = "reconnecting";
          logVoiceLifecycle("recognition-paused-for-visibility", {
            sessionId: voiceSessionIdRef.current,
          });
          void onCancelListening();
        }
        return;
      }

      if (
        resumeAfterVisibilityRef.current &&
        sessionActiveRef.current &&
        !mutedRef.current &&
        !turnInFlightRef.current
      ) {
        resumeAfterVisibilityRef.current = false;
        void startListeningSafely("visibility");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [onCancelListening, startListeningSafely, visible]);

  const runTurnFromTranscript = useCallback(
    async (transcript: string, resume?: HeldAsk, spokenLanguage?: AskPranaSpeechLanguageCode) => {
      if (!sessionActiveRef.current) return;
      const cleaned = (resume?.question ?? transcript).trim();
      if (!cleaned) return;
      const lockId = ++requestLockIdRef.current;
      requestLockRef.current = true;
      const turnStartedAt = performance.now();
      const speechEndedAt = speechEndedAtRef.current;
      speechEndedAtRef.current = null;
      logVoiceTiming("final-transcript-available", turnStartedAt, { transcriptLength: cleaned.length });
      console.log("[AskPranaVoice] transcript received", {
        length: cleaned.length,
      });
      if (!resume) appendLine("user", cleaned);
      recentSpokenRef.current = "";
      setSubmittedQuestion(cleaned);
      setRetryQuestion(cleaned);
      setState("processing");
      stateRef.current = "processing";
      setErrorText(null);
      // This turn owns the conversation until the user interrupts, taps the
      // orb, types, mutes or changes language (each bumps speechTurnRef).
      const turnToken = ++speechTurnRef.current;
      setCaptionTurn(turnToken);
      const turnId = `${voiceSessionIdRef.current}-${turnToken}`;
      const logTurn = (stage: string, detail?: Record<string, unknown>) => {
        if (process.env.NODE_ENV === "production") return;
        console.debug("[AskPranaVoiceTiming]", stage, {
          turnId,
          at: Math.round(performance.now()),
          ...detail,
        });
      };
      if (speechEndedAt != null) {
        logTurn("speech-ended", { speechEndedAt: Math.round(speechEndedAt) });
      }
      try {
        logTurn("ai-request-started");
        logVoiceTiming("ai-request-start", turnStartedAt, { turnId });
        console.log("[AskPranaVoice] ask started");
        speechQueueRef.current?.cancel();
        // The generation bump is synchronous. Playback waits for the rest of
        // the stop; the answer request does not.
        const stoppingSpeech = stopAskPranaSpeech();
        if (turnToken !== speechTurnRef.current || !sessionActiveRef.current) {
          await stoppingSpeech;
          return;
        }
        const replyLanguage = resume?.language
          ?? languageForQuestionText(cleaned)
          ?? spokenLanguage;
        if (!replyLanguage) return;
        retryLanguageRef.current = replyLanguage;
        let receivedSentence = false;
        let playbackStarted = false;
        const queue = createAskPranaSpeechQueue(replyLanguage, {
          voiceSession: true,
          keepMicrophoneActive: true,
          ready: stoppingSpeech,
          shouldPlay: () =>
            sessionActiveRef.current &&
            !mutedRef.current &&
            turnToken === speechTurnRef.current,
          onPlaybackStart: () => {
            if (!sessionActiveRef.current || turnToken !== speechTurnRef.current) return;
            playbackStarted = true;
            bargeInPlaybackStartedAtRef.current = Date.now();
            // Stay on Speaking for every later sentence of this same reply.
            if (stateRef.current !== "speaking") {
              setState("speaking");
              stateRef.current = "speaking";
            }
            logTurn("first-playback", {
              speechEndToFirstAudioMs:
                speechEndedAt == null ? null : Math.round(performance.now() - speechEndedAt),
            });
            logVoiceTiming("playback-started", turnStartedAt, { turnId });
          },
        });
        speechQueueRef.current = queue;
        const rememberSentence = (sentence: string) => {
          recentSpokenRef.current = `${recentSpokenRef.current} ${sentence}`.trim();
          setLines((current) => {
            const id = `assistant-${turnToken}`;
            const last = current[current.length - 1];
            if (last?.id === id) {
              return [...current.slice(0, -1), { ...last, text: `${last.text} ${sentence}`.trim() }];
            }
            return [...current, { id, role: "assistant", text: sentence }];
          });
        };
        const askPromise = resume?.promise ?? onAsk(cleaned, {
          ...requestContext,
          // Spoken language for this turn only. Website labels stay outside this request.
          ...buildVoiceLanguageRequest(replyLanguage),
        }, {
          turnId,
          onFirstText: () => logTurn("first-text-received"),
          onSentence: (sentence) => {
            if (turnToken !== speechTurnRef.current || resume) return;
            if (!receivedSentence) {
              receivedSentence = true;
              logTurn("first-sentence-ready", { chars: sentence.length });
              logVoiceTiming("speech-preparation-started", turnStartedAt, { turnId });
            }
            rememberSentence(sentence);
            queue.enqueue(sentence);
          },
          onReplace: (text) => {
            if (turnToken !== speechTurnRef.current || playbackStarted) return;
            queue.replaceUnplayed(text);
          },
        });
        pendingAskRef.current = { question: cleaned, language: replyLanguage, promise: askPromise };
        if (!mutedRef.current) void startBargeInMonitor();
        const result = await askPromise;
        if (pendingAskRef.current?.promise === askPromise) pendingAskRef.current = null;
        if (turnToken !== speechTurnRef.current) {
          queue.cancel();
          return;
        }
        if (!sessionActiveRef.current) {
          queue.cancel();
          return;
        }
        logTurn("full-response-completed", { answerLength: result?.answer?.trim().length ?? 0 });
        if (!result?.answer?.trim()) {
          queue.cancel();
          stopBargeInMonitor();
          console.warn("[AskPranaVoice] voice request returned no answer", {
            sessionId: voiceSessionIdRef.current,
            state: stateRef.current,
          });
          turnInFlightRef.current = false;
          setState("error");
          stateRef.current = "error";
          setErrorText("I didn't get an answer for that. Please ask again.");
          return;
        }
        const cleanedAnswer = result.answer.trim();
        logVoiceTiming("ai-response-complete", turnStartedAt, {
          answerLength: cleanedAnswer.length,
          turnId,
        });
        if (/^no response received\.?$/i.test(cleanedAnswer)) {
          queue.cancel();
          stopBargeInMonitor();
          setState("error");
          stateRef.current = "error";
          setErrorText("Ask Prana could not finish that answer. Tap Retry to ask again.");
          appendLine(
            "assistant",
            "Sorry — I could not finish that answer just now. Please ask again.",
          );
          return;
        }
        console.log("[AskPranaVoice] ask ok", {
          answerLength: cleanedAnswer.length,
          replyLanguage,
        });
        if (!receivedSentence || resume) {
          for (const sentence of splitCompleteSentences(cleanedAnswer)) {
            rememberSentence(sentence);
            queue.enqueue(sentence);
          }
        }
        if (mutedRef.current) {
          queue.cancel();
          stopBargeInMonitor();
          setErrorText(null);
          setState("muted");
          stateRef.current = "muted";
          return;
        }
        queue.close();
        await startBargeInMonitor();
        if (turnToken !== speechTurnRef.current || !sessionActiveRef.current) return;
        const spoken = await queue.done;
        if (speechQueueRef.current === queue) speechQueueRef.current = null;
        if (turnToken !== speechTurnRef.current) return;
        stopBargeInMonitor();
        if (!sessionActiveRef.current) return;
        if (mutedRef.current || spoken.reason === "interrupted") {
          setErrorText(null);
          if (mutedRef.current) {
            setState("muted");
            stateRef.current = "muted";
            return;
          }
        } else if (!spoken.spoke) {
          console.log("[AskPranaVoice] speak failed", spoken.reason);
          setCaptionsVisible(true);
          setState("error");
          stateRef.current = "error";
          setErrorText(
            spoken.reason ||
              "Could not play speech. The reply is shown above.",
          );
          return;
        } else {
          logVoiceTiming("voice-turn-complete", turnStartedAt, { provider: spoken.provider, turnId });
          console.log("[AskPranaVoice] speak finished", { provider: spoken.provider });
          setErrorText(null);
          setRetryQuestion(null);
        }
        if (mutedRef.current || !sessionActiveRef.current) {
          setErrorText(null);
          setState("muted");
          stateRef.current = "muted";
          return;
        }
        console.log("[AskPranaVoice] resuming listen");
        await startListeningSafely("resume");
      } catch (error) {
        console.log("[AskPranaVoice] turn failed:", error);
        speechQueueRef.current?.cancel();
        if (!sessionActiveRef.current) return;
        if (turnToken !== speechTurnRef.current) return;
        if (isAskPranaAbortError(error)) return;
        stopBargeInMonitor();
        setState("error");
        stateRef.current = "error";
        setErrorText(
          error instanceof Error
            ? error.message
            : "Voice turn failed. You can keep using text chat.",
        );
      } finally {
        if (requestLockIdRef.current === lockId) requestLockRef.current = false;
      }
    },
    [
      recognitionMode,
      appendLine,
      onAsk,
      onStartListening,
      requestContext,
      startBargeInMonitor,
      startListeningSafely,
      stopBargeInMonitor,
    ],
  );

  useEffect(() => {
    runTurnRef.current = runTurnFromTranscript;
  }, [runTurnFromTranscript]);

  const finishListeningTurn = useCallback(async () => {
    if (!sessionActiveRef.current || mutedRef.current) return;
    if (turnInFlightRef.current || stateRef.current !== "listening") return;
    const sessionId = voiceSessionIdRef.current;
    const listeningAttempt = listeningAttemptRef.current;
    const turnId = speechTurnRef.current + 1;
    turnInFlightRef.current = true;
    // Freeze this utterance before awaiting recognition.stop(). Thinking is
    // entered synchronously by runTurnFromTranscript once a usable transcript
    // is available, rather than waiting for the network request.
    setState("finalizing");
    stateRef.current = "finalizing";
    setErrorText(null);
    logVoiceLifecycle("transcript-finalizing", { sessionId, turnId });
    try {
      // Always attempt stop; capture path no-ops if mic is not live.
      const heard = await onStopListeningToTranscript();
      const isStale = () =>
        !sessionActiveRef.current ||
        mutedRef.current ||
        voiceSessionIdRef.current !== sessionId ||
        listeningAttemptRef.current !== listeningAttempt;
      const capture = interruptCaptureRef.current;
      interruptCaptureRef.current = null;
      const heldAsk = heldAskRef.current;
      heldAskRef.current = null;
      let outcome = heard;
      const recognizedText = heard.status === "ok" ? heard.text : "";
      const recognizedLanguage = heard.status === "ok" ? heard.language : null;
      if (capture && capture.recognition === recognitionModeRef.current) {
        const hadSpeech = capture.hadSpeech();
        const taken = capture.takeWav();
        if (taken.rejectedMessage && !recognizedText) {
          outcome = { status: "repeat", message: taken.rejectedMessage };
        } else if (taken.blob && (hadSpeech || recognizedText)) {
          const captured = await transcribeInterruption(
            taken.blob,
            capture.recognition,
            capture.turnId,
            taken.recordingId,
          );
          const choice = chooseInterruptionTranscript({
            recognizedText,
            recognizedLanguage,
            capturedText: captured.action === "accept" ? captured.text : "",
            capturedLanguage: captured.action === "accept" ? captured.language : null,
            assistantSpoken: recentSpokenRef.current,
          });
          if (choice) {
            outcome = { status: "ok", text: choice.text, language: choice.language };
          }
          logVoiceLifecycle("interruption-transcribed", {
            sessionId,
            turnId,
            recordingId: taken.recordingId,
            source: choice?.source ?? "none",
            reason: choice?.reason ?? captured.reason,
          });
        }
      }
      if (isStale() || (capture && capture.recognition !== recognitionModeRef.current)) return;
      if (outcome.status === "cancelled") return;
      const askToRepeat = async (message: string) => {
        logVoiceLifecycle("transcript-unclear", { sessionId, turnId });
        onClearLiveTranscript?.();
        const listening = await startListeningSafely("retry");
        if (
          listening &&
          sessionActiveRef.current &&
          voiceSessionIdRef.current === sessionId &&
          !mutedRef.current
        ) {
          setErrorText(message);
        }
      };
      if (outcome.status === "error") {
        turnInFlightRef.current = false;
        setState("error");
        stateRef.current = "error";
        setErrorText(outcome.message);
        return;
      }
      if (outcome.status === "choose-language") {
        await askToRepeat("I couldn't tell whether that was Telugu, Hindi, or English. Choose one, or say it again.");
        return;
      }
      if (outcome.status !== "ok") {
        if (heldAsk) {
          logVoiceLifecycle("thinking-interruption-empty-resuming", { sessionId, turnId });
          await runTurnFromTranscript("", heldAsk);
          return;
        }
        await askToRepeat(outcome.status === "repeat" && outcome.message
          ? outcome.message
          : "I couldn't understand that. Please say it again.");
        return;
      }
      const transcript = outcome.text;
      if (isUnclearVoiceTranscript(transcript)) {
        if (heldAsk) {
          logVoiceLifecycle("thinking-interruption-empty-resuming", { sessionId, turnId });
          await runTurnFromTranscript("", heldAsk);
          return;
        }
        await askToRepeat("I couldn't understand that. Please say it again.");
        return;
      }
      if (
        wasAskPranaSpeechOutputRecent() &&
        isAssistantEchoTranscript(transcript, recentSpokenRef.current)
      ) {
        logVoiceLifecycle("assistant-echo-ignored", { sessionId, turnId });
        onClearLiveTranscript?.();
        if (heldAsk) {
          await runTurnFromTranscript("", heldAsk);
          return;
        }
        await startListeningSafely("retry");
        return;
      }
      if (transcript && heldAsk) {
        onCancelAsk?.();
      }
      logVoiceLifecycle("transcript-finalized", {
        sessionId,
        turnId,
        transcriptLength: transcript.trim().length,
      });
      if (process.env.NODE_ENV !== "production") {
        console.debug("[AskPranaVoiceTiming]", "transcript-finalized", {
          turnId: `${sessionId}-${turnId}`,
          at: Math.round(performance.now()),
        });
      }
      await runTurnFromTranscript(transcript.trim(), undefined, outcome.language);
    } catch (error) {
      console.log("[AskPranaVoice] finish listen failed:", error);
      turnInFlightRef.current = false;
      setState("error");
      stateRef.current = "error";
      // Keep the actionable server/recording error. The previous generic copy
      // concealed whether the microphone, transcription service, or Ask Prana
      // reply had failed, making both mic entry points look broken.
      setErrorText(voiceTurnErrorMessage(error));
    }
  }, [onCancelAsk, onClearLiveTranscript, onStopListeningToTranscript, runTurnFromTranscript, startListeningSafely]);

  useEffect(() => {
    finishListeningTurnRef.current = finishListeningTurn;
  }, [finishListeningTurn]);

  useEffect(() => {
    if (!visible) {
      setVoiceAutoStopListener(null);
      return;
    }
    setVoiceAutoStopListener((speechEndedAt) => {
      if (!sessionActiveRef.current || mutedRef.current) return;
      if (stateRef.current !== "listening") return;
      speechEndedAtRef.current = speechEndedAt;
      void finishListeningTurn();
    });
    return () => setVoiceAutoStopListener(null);
  }, [visible, finishListeningTurn]);

  const handleOrbPress = useCallback(async () => {
    if (!sessionActiveRef.current || orbPressLockRef.current) return;
    if (mutedRef.current) {
      Alert.alert("Muted", "Unmute to continue the spoken conversation.");
      return;
    }

    const current = stateRef.current;
    if (current === "switching") return;
    if (current === "processing") {
      // Cancel the answer that is still loading and listen again.
      orbPressLockRef.current = true;
      try {
        speechTurnRef.current += 1;
        heldAskRef.current = null;
        pendingAskRef.current = null;
        speechQueueRef.current?.cancel();
        speechQueueRef.current = null;
        stopBargeInMonitor();
        onCancelAsk?.();
        await stopAskPranaSpeech();
        await startListeningSafely("retry");
      } finally {
        orbPressLockRef.current = false;
      }
      return;
    }

    orbPressLockRef.current = true;
    try {
      if (current === "speaking") {
        speechTurnRef.current += 1;
        speechQueueRef.current?.cancel();
        speechQueueRef.current = null;
        stopBargeInMonitor();
        onCancelAsk?.();
        await stopAskPranaSpeech();
        await startListeningSafely("interrupt");
        return;
      }

      // Stop: UI listening or mic actually live (refs avoid stale React state).
      if (current === "listening" || isRecordingRef.current) {
        // Release lock before the long ask/speak path so user can interrupt later.
        orbPressLockRef.current = false;
        await finishListeningTurn();
        return;
      }

      // Start: idle / error / muted-unmute path
      if (
        current === "error" ||
        current === "idle" ||
        current === "muted" ||
        current === "reconnecting"
      ) {
        await startListeningSafely("retry");
      }
    } finally {
      orbPressLockRef.current = false;
    }
  }, [finishListeningTurn, muted, onCancelAsk, startListeningSafely, stopBargeInMonitor]);

  const handleMuteToggle = useCallback(async () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setErrorText(null);
    if (next) {
      languageSwitchRef.current?.abandon();
      await onCancelListening();
      speechTurnRef.current += 1;
      speechQueueRef.current?.cancel();
      speechQueueRef.current = null;
      stopBargeInMonitor();
      onCancelAsk?.();
      await stopAskPranaSpeech();
      setErrorText(null);
      setState("muted");
      stateRef.current = "muted";
      return;
    }
    await stopAskPranaSpeech();
    await startListeningSafely("resume");
  }, [onCancelAsk, onCancelListening, startListeningSafely, stopBargeInMonitor]);

  const handleEnd = useCallback(async () => {
    await cleanupSession();
    onClose();
  }, [cleanupSession, onClose]);

  const handleLanguageChange = useCallback(
    (mode: AskPranaRecognitionMode) => {
      if (mode === recognitionModeRef.current) {
        setLanguageMenuOpen(false);
        return;
      }

      setLanguageMenuOpen(false);
      setErrorText(null);
      onClearLiveTranscript?.();
      setSubmittedQuestion(null);
      speechTurnRef.current += 1;
      speechQueueRef.current?.cancel();
      speechQueueRef.current = null;
      stopBargeInMonitor();
      onCancelAsk?.();
      void stopAskPranaSpeech();
      recognitionModeRef.current = mode;
      setRecognitionMode(mode);
      // Muted and closed sessions keep the selected language and do not open the microphone.
      if (!sessionActiveRef.current || mutedRef.current) {
        languageSwitchRef.current?.abandon();
        return;
      }
      setState("switching");
      stateRef.current = "switching";
      void languageSwitchRef.current?.request(mode).catch((error) => {
        console.log("[AskPranaVoice] language switch failed:", error);
      });
    },
    [onCancelAsk, onClearLiveTranscript, stopBargeInMonitor],
  );

  const handleSendTyped = useCallback(async () => {
    const text = draft.trim();
    // While a voice answer is loading, a typed question replaces it.
    if (!text || isTranscribing || (isSending && !pendingAskRef.current)) return;
    onChangeDraft("");
    speechTurnRef.current += 1;
    heldAskRef.current = null;
    speechQueueRef.current?.cancel();
    speechQueueRef.current = null;
    if (pendingAskRef.current) {
      // A typed question replaces one that is still loading.
      pendingAskRef.current = null;
      onCancelAsk?.();
    }
    stopBargeInMonitor();
    const stoppingSpeech = stopAskPranaSpeech();
    await onCancelListening();
    const typedLanguage = languageForTypedVoiceQuestion(text, recognitionModeRef.current);
    if (!typedLanguage) {
      await stoppingSpeech;
      setErrorText("I couldn't tell whether that was Telugu, Hindi, or English. Choose one, or say it again.");
      setState("listening");
      stateRef.current = "listening";
      await startListeningSafely("retry");
      return;
    }
    await runTurnFromTranscript(text, undefined, typedLanguage);
  }, [
    draft,
    isSending,
    isTranscribing,
    onCancelAsk,
    onCancelListening,
    onChangeDraft,
    runTurnFromTranscript,
    startListeningSafely,
    stopBargeInMonitor,
  ]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  useEffect(() => {
    // Both layouts use the page's bottom bar (mute, end, typed send). The
    // phone layout ("screen") must register too, otherwise those buttons do
    // nothing on mobile.
    if (!visible) {
      onRegisterActions?.(null);
      return;
    }
    onRegisterActions?.({
      toggleMute: () => {
        void handleMuteToggle();
      },
      end: () => {
        void handleEnd();
      },
      submitTyped: () => {
        void handleSendTyped();
      },
    });
    return () => onRegisterActions?.(null);
  }, [visible, variant, handleMuteToggle, handleEnd, handleSendTyped, onRegisterActions]);

  useEffect(() => {
    if (state !== "processing") {
      setSlowAnswer(false);
      return;
    }
    const timer = setTimeout(() => setSlowAnswer(true), 8_000);
    return () => clearTimeout(timer);
  }, [state]);

  const handleRetry = useCallback(() => {
    if (requestLockRef.current || stateRef.current === "processing" || stateRef.current === "speaking") {
      return;
    }
    const question = retryQuestion?.trim();
    if (!question) return;
    const retryLanguage = retryLanguageRef.current
      ?? languageForTypedVoiceQuestion(question, recognitionModeRef.current);
    if (!retryLanguage) {
      setErrorText("I couldn't tell whether that was Telugu, Hindi, or English. Choose one, or say it again.");
      return;
    }
    void runTurnFromTranscript(question, undefined, retryLanguage);
  }, [retryQuestion, runTurnFromTranscript]);

  const statusLabel = (() => {
    if (state === "switching") return "Switching language…";
    if (state === "listening") return "Listening…";
    if (state === "finalizing" || isTranscribing) return "Finishing your question…";
    if (state === "processing") {
      return slowAnswer ? "This is taking longer than usual…" : "Preparing your answer…";
    }
    if (state === "speaking") return "Speaking…";
    if (state === "interrupted") return "";
    if (state === "muted") return "Muted";
    if (state === "reconnecting") return "Reconnecting…";
    if (state === "error") return errorText || "Something went wrong";
    return "";
  })();
  const effectiveAudioLevel = Math.max(audioLevel, recorderAudioLevel);
  const orbScale = reducedMotion
    ? 1
    : state === "speaking"
      ? 1.02 + Math.min(effectiveAudioLevel * 1.4, 0.13)
      : state === "listening"
        // Browser SpeechRecognition does not expose PCM levels. Keep a small
        // state cue while listening, then layer real recorder/VAD levels on
        // top whenever they are available.
        ? 1 + Math.min(effectiveAudioLevel * 0.9, 0.07)
        : state === "processing" || state === "finalizing"
          ? 1.012
          : 1;
  const showTurnCaption = state === "processing" || state === "speaking";
  const userCaption = showTurnCaption ? submittedQuestion : null;
  const assistantCaption = showTurnCaption && captionsVisible
    ? lines.find((line) => line.id === `assistant-${captionTurn}`)?.text ?? null
    : null;
  const orb = (
    <Pressable
      onPress={() => {
        void handleOrbPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Voice conversation"
    >
      <Animated.View style={{ transform: [{ scale: orbScale }] }}>
        <VoiceOrb
          size={variant === "overlay" ? 88 : 200}
          state={state === "finalizing" || state === "switching" ? "processing" : state}
          audioLevel={reducedMotion ? 0 : Math.min(effectiveAudioLevel * 3, 1)}
          reducedMotion={reducedMotion}
        />
      </Animated.View>
    </Pressable>
  );

  if (!visible) return null;

  if (variant === "overlay") {
    // Desktop only. The parent mounts this under the message list and above
    // the composer. Questions and answers stay in the conversation stream.
    const dockStatus = state === "processing" && !slowAnswer ? "Thinking…" : statusLabel;
    return (
      <View style={styles.overlayHost}>
        {orb}
        {dockStatus ? <Text style={styles.status}>{dockStatus}</Text> : null}
        {errorText ? <Text style={styles.errorHint}>{errorText}</Text> : null}
        {wakeLockNote ? <Text style={styles.wakeLockNote}>{wakeLockNote}</Text> : null}
        {state === "error" && retryQuestion ? (
          <Pressable onPress={handleRetry} style={styles.retryBtn} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.header}>
          <Pressable
            onPress={onOpenMenu}
            style={styles.roundBtn}
            accessibilityRole="button"
            accessibilityLabel="Open menu"
          >
            <Feather name="menu" size={18} color={colors.white} />
          </Pressable>
          <Pressable
            onPress={() => setLanguageMenuOpen((open) => !open)}
            style={styles.roundBtn}
            accessibilityRole="button"
            accessibilityLabel="Change voice language"
          >
            <Feather name="sliders" size={16} color={colors.white} />
          </Pressable>
        </View>

        {languageMenuOpen ? (
          <View style={styles.languageMenu}>
            {([{ mode: "auto", label: "Auto" }, ...ASK_PRANA_LANGUAGE_OPTIONS.map((option) => ({
              mode: option.code,
              label: option.nativeLabel,
            }))] as { mode: AskPranaRecognitionMode; label: string }[]).map((option) => (
              <Pressable
                key={option.mode}
                onPress={() => void handleLanguageChange(option.mode)}
                style={[
                  styles.languageOption,
                  option.mode === recognitionMode && styles.languageOptionActive,
                ]}
              >
                <Text style={styles.languageOptionText}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.stage}>
          {orb}
          {statusLabel ? <Text style={styles.status}>{statusLabel}</Text> : null}
          {userCaption ? (
            <Text
              style={styles.caption}
              numberOfLines={3}
              accessibilityLabel={`You said: ${userCaption}`}
            >
              {userCaption}
            </Text>
          ) : null}
          {state === "error" && retryQuestion ? (
            <Pressable onPress={handleRetry} style={styles.retryBtn} accessibilityRole="button" accessibilityLabel="Retry">
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
          {assistantCaption ? (
            <Text
              style={styles.caption}
              numberOfLines={3}
              accessibilityLabel={`Ask Prana said: ${assistantCaption}`}
            >
              {assistantCaption}
            </Text>
          ) : null}
          {errorText && state !== "error" ? (
            <Text style={styles.errorHint}>{errorText}</Text>
          ) : null}
          {wakeLockNote ? <Text style={styles.wakeLockNote}>{wakeLockNote}</Text> : null}
        </View>

        <View style={styles.bottomBar}>
          <View style={[
            styles.composerPill,
            variant === "screen" && styles.composerPillHidden,
          ]}>
            <Pressable
              onPress={() => setAttachMenuOpen((open) => !open)}
              style={styles.plusBtn}
              accessibilityRole="button"
              accessibilityLabel="Add"
            >
              <Feather name="plus" size={20} color="#E5E5E5" />
            </Pressable>
            {attachMenuOpen ? (
              <View style={styles.attachMenu}>
                <Pressable
                  onPress={() => {
                    setAttachMenuOpen(false);
                    onAddImage?.();
                  }}
                  style={styles.attachItem}
                >
                  <Text style={styles.attachItemText}>{addImageLabel}</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setAttachMenuOpen(false);
                    onAddFile?.();
                  }}
                  style={styles.attachItem}
                >
                  <Text style={styles.attachItemText}>{addFileLabel}</Text>
                </Pressable>
              </View>
            ) : null}
            <TextInput
              value={draft}
              onChangeText={onChangeDraft}
              placeholder="Ask Prana"
              placeholderTextColor="#A3A3A3"
              style={styles.input}
              editable={!isSending && !isTranscribing}
              onSubmitEditing={() => {
                void handleSendTyped();
              }}
            />
          </View>
          <Pressable
            onPress={() => setCaptionsVisible((current) => !current)}
            style={styles.roundBtn}
            accessibilityRole="button"
            accessibilityLabel={captionsVisible ? "Hide captions" : "Show captions"}
          >
            <Feather name="align-left" size={18} color={colors.white} />
          </Pressable>
          <Pressable
            onPress={() => void handleMuteToggle()}
            style={styles.roundBtn}
            accessibilityRole="button"
            accessibilityLabel={muted ? "Unmute" : "Mute"}
          >
            <Feather name={muted ? "mic" : "mic-off"} size={18} color={colors.white} />
          </Pressable>
          <Pressable
            onPress={() => void handleEnd()}
            style={[styles.roundBtn, styles.closeBtn]}
            accessibilityRole="button"
            accessibilityLabel="End"
          >
            <Feather name="x" size={20} color="#111111" />
          </Pressable>
        </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    height: "100%",
    backgroundColor: "#000000",
    paddingHorizontal: 16,
    ...(Platform.OS === "web"
      ? ({ position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: 100 } as unknown as ViewStyle)
      : {}),
  },
  overlayHost: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 36,
    paddingBottom: 10,
    backgroundColor: "#171717",
    overflow: "hidden",
  },
  overlayTranscript: {
    position: "absolute",
    bottom: 128,
    maxWidth: 340,
    color: colors.text,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingHorizontal: 16,
  },
  header: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  subtitle: { color: colors.muted, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 18, fontWeight: "500" },
  languagePicker: { flexDirection: "row", alignItems: "center", gap: 2 },
  languageMenu: { flexDirection: "row", gap: 8 },
  languageOption: {
    borderColor: colors.muted,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  languageOptionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  languageOptionText: { color: colors.text, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
  },
  caption: {
    color: "#D4D4D4",
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
    paddingHorizontal: 24,
    maxWidth: 560,
  },
  orbOuter: {
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: "rgba(45, 212, 191, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  orbMid: {
    width: 232,
    height: 232,
    borderRadius: 116,
    backgroundColor: "rgba(20, 184, 166, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  orbInner: {
    width: 188,
    height: 188,
    borderRadius: 94,
    backgroundColor: "#5EEAD4",
    alignItems: "center",
    justifyContent: "center",
  },
  status: {
    color: colors.text,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
  },
  errorHint: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 16,
  },
  wakeLockNote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  retryBtn: {
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    fontWeight: "600",
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  composerPill: {
    flex: 1,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: "#2F2F2F",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 8,
    paddingRight: 16,
    position: "relative",
  },
  composerPillHidden: { display: "none" },
  plusBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  attachMenu: {
    position: "absolute",
    left: 8,
    bottom: 56,
    backgroundColor: "#171C23",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#3A3A3A",
    paddingVertical: 6,
    minWidth: 150,
    zIndex: 8,
  },
  attachItem: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  attachItemText: {
    color: "#F4F7FA",
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
  },
  input: {
    flex: 1,
    minHeight: 44,
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "400",
    // Web-only: hide the browser focus outline. React Native's style types
    // do not list "none", so it is added untyped (same result at runtime).
    ...({ outlineStyle: "none", outlineWidth: 0 } as object),
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
  },
  roundBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#2F2F2F",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtn: {
    backgroundColor: "#FFFFFF",
  },
});
