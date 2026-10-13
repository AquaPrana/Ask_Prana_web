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
import type { AskPranaRequestContext } from "../services/ask-prana";
import {
  ASK_PRANA_LANGUAGE_OPTIONS,
  getAskPranaLanguageOption,
  type AskPranaSpeechLanguageCode,
} from "../lib/ask-prana-language";
import {
  speakAskPranaText,
  stopAskPranaSpeech,
} from "../lib/ask-prana-speech";
import { transcribeAskPranaAudio } from "../services/ask-prana";
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
  console.debug("[AskPranaVoiceTiming]", stage, {
    elapsedMs: Math.round(performance.now() - turnStartedAt),
    ...detail,
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
  | "muted"
  | "reconnecting"
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
  onStartListening: () => Promise<void>;
  onCancelListening: () => Promise<void>;
  onStopListeningToTranscript: () => Promise<string | null>;
  onAsk: (
    question: string,
    context: AskPranaRequestContext,
  ) => Promise<{ answer: string; language: AskPranaSpeechLanguageCode } | null>;
  onLanguageChange: (code: AskPranaSpeechLanguageCode) => Promise<void>;
  onOpenMenu?: () => void;
  onAddImage?: () => void;
  onAddFile?: () => void;
  addImageLabel?: string;
  addFileLabel?: string;
  onMutedChange?: (muted: boolean) => void;
  onRegisterActions?: (actions: VoiceBarActions | null) => void;
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
const BARGE_IN_SILENCE_MS = 1400;
/** Below this, a "barge-in" was most likely echo or noise; skip transcription. */
const BARGE_IN_MIN_VOICED_MS = 250;
const BARGE_IN_TRANSCRIBE_TIMEOUT_MS = 8000;
const WAV_SAMPLE_RATE = 16000;

type InterruptCapture = {
  hadSpeech: () => boolean;
  /** Stops capture and returns 16 kHz mono WAV of the interruption. */
  takeWav: () => Blob | null;
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

function wordCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

async function transcribeInterruption(wav: Blob): Promise<string> {
  try {
    const transcript = await Promise.race([
      transcribeAskPranaAudio({
        uri: "voice-interruption.wav",
        blob: wav,
        mimeType: "audio/wav",
        fileName: "voice-interruption.wav",
        language: "auto",
      }),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(""), BARGE_IN_TRANSCRIBE_TIMEOUT_MS),
      ),
    ]);
    return transcript.trim();
  } catch (error) {
    console.log("[AskPranaVoice] interruption transcription failed:", error);
    return "";
  }
}

function voiceTurnErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
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
}: Props) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<VoiceModeState>("idle");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(false);
  const [activeLanguage, setActiveLanguage] =
    useState<AskPranaSpeechLanguageCode>(language);
  const loopArmedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const stateRef = useRef<VoiceModeState>("idle");
  const isRecordingRef = useRef(false);
  const orbPressLockRef = useRef(false);
  /** Stops the barge-in mic stream, detection loop and PCM capture. */
  const bargeInReleaseRef = useRef<(() => void) | null>(null);
  const bargeInTriggeredRef = useRef(false);
  /** Audio of the current interruption, including its pre-roll. */
  const interruptCaptureRef = useRef<InterruptCapture | null>(null);
  const runTurnRef = useRef<(transcript: string) => Promise<void>>(async () => {});
  /** Lets the barge-in monitor (declared earlier) start the normal listener. */
  const interruptListeningRef = useRef<() => Promise<unknown>>(async () => {});
  /** Lets the barge-in monitor (declared earlier) end the interrupting turn. */
  const finishListeningTurnRef = useRef<() => Promise<void>>(async () => {});
  const speechTurnRef = useRef(0);
  const speechEndedAtRef = useRef<number | null>(null);
  /** Invalidates callbacks from a closed/reopened modal session. */
  const voiceSessionIdRef = useRef(0);
  /** Exactly one user turn may advance through finalizing/AI/TTS at a time. */
  const turnInFlightRef = useRef(false);
  /** Invalidates a stale recognition start while a newer start is pending. */
  const listeningAttemptRef = useRef(0);
  /** Browser tab suspension stops recognition without a reliable onend event. */
  const resumeAfterVisibilityRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    if (visible) {
      setActiveLanguage(language);
    }
  }, [visible, language]);

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

  const startBargeInMonitor = useCallback(async () => {
    // Keep one echo-cancelled stream open while TTS plays. It detects that the
    // user started talking and keeps a short rolling PCM buffer, so the first
    // words of an interruption (spoken before the browser recognizer is up)
    // are not lost. The recognizer still runs for live text and end-of-turn.
    if (
      Platform.OS !== "web" ||
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      bargeInReleaseRef.current
    ) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!sessionActiveRef.current || stateRef.current !== "speaking") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const AudioContextCtor = window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const audioContext = new AudioContextCtor();
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

      const ignoreUntil = Date.now() + 700;
      let consecutiveVoiceFrames = 0;
      let voicedMs = 0;
      let lastFrameAt = 0;
      let silenceSince = 0;
      let autoFinished = false;

      const monitor = () => {
        if (released) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / samples.length);
        setAudioLevel((current) => Math.abs(current - rms) > 0.012 ? rms : current);
        const now = Date.now();

        if (!capturing) {
          // Sustained input avoids treating a short playback echo or click as
          // a user interruption. Echo cancellation is requested at the source.
          consecutiveVoiceFrames = now >= ignoreUntil && rms > 0.055
            ? consecutiveVoiceFrames + 1
            : 0;
          if (consecutiveVoiceFrames >= 5 && !bargeInTriggeredRef.current) {
            bargeInTriggeredRef.current = true;
            capturing = true;
            lastFrameAt = now;
            interruptCaptureRef.current = {
              hadSpeech: () => voicedMs >= BARGE_IN_MIN_VOICED_MS,
              takeWav: () => {
                release();
                return pcmLength ? encodeWav(pcm, pcmLength, sampleRate) : null;
              },
            };
            // Retire the reply's turn: its speak() call returns "interrupted"
            // and must not restart listening on top of this handoff.
            speechTurnRef.current += 1;
            void stopAskPranaSpeech();
            void interruptListeningRef.current();
          }
        } else {
          const elapsed = now - lastFrameAt;
          lastFrameAt = now;
          if (rms > 0.03) {
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
    } catch (error) {
      // Barge-in is progressive enhancement; manual orb interruption remains
      // available when a browser declines a second mic stream.
      console.log("[AskPranaVoice] barge-in monitor unavailable:", error);
    }
  }, []);

  const cleanupSession = useCallback(async () => {
    const closingSessionId = voiceSessionIdRef.current;
    sessionActiveRef.current = false;
    loopArmedRef.current = false;
    listeningAttemptRef.current += 1;
    turnInFlightRef.current = false;
    speechTurnRef.current += 1;
    logVoiceLifecycle("session-closed", { sessionId: closingSessionId });
    stopBargeInMonitor();
    // The parent also cancels on its close handler, but keeping teardown here
    // makes modal unmounts and route changes release the microphone promptly.
    await onCancelListening();
    await stopAskPranaSpeech();
    setState("idle");
    stateRef.current = "idle";
  }, [onCancelListening, stopBargeInMonitor]);

  const startListeningSafely = useCallback(
    async (reason: "open" | "resume" | "retry" | "interrupt" | "visibility") => {
      const sessionId = voiceSessionIdRef.current;
      const attemptId = ++listeningAttemptRef.current;
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
      if (reason !== "interrupt" && interruptCaptureRef.current) {
        // A capture left over from a failed interruption must not be merged
        // into an unrelated later turn.
        stopBargeInMonitor();
      }
      setState("listening");
      stateRef.current = "listening";
      setErrorText(null);
      logVoiceLifecycle("recognition-start-requested", { sessionId, attemptId, reason });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await onStartListening();
          if (
            !sessionActiveRef.current ||
            voiceSessionIdRef.current !== sessionId ||
            listeningAttemptRef.current !== attemptId
          ) {
            // A close/new session won while startup was awaiting permission.
            await onCancelListening();
            return false;
          }
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
          setState("error");
          stateRef.current = "error";
          setErrorText(voiceTurnErrorMessage(error));
          logVoiceLifecycle("recognition-start-failed", { sessionId, attemptId, attempt });
          return false;
        }
      }
      return false;
    },
    [onCancelListening, onStartListening, stopBargeInMonitor],
  );

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
    turnInFlightRef.current = false;
    loopArmedRef.current = true;
    logVoiceLifecycle("session-opened", { sessionId: voiceSessionIdRef.current });
    setState(muted ? "muted" : "listening");
    if (!muted) {
      void startListeningSafely("open");
    }

    return () => {
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
    async (transcript: string) => {
      if (!sessionActiveRef.current) return;
      const cleaned = transcript.trim();
      if (!cleaned) return;
      const turnStartedAt = performance.now();
      const speechEndedAt = speechEndedAtRef.current;
      speechEndedAtRef.current = null;
      logVoiceTiming("final-transcript-available", turnStartedAt, { transcriptLength: cleaned.length });
      console.log("[AskPranaVoice] transcript received", {
        length: cleaned.length,
      });
      appendLine("user", cleaned);
      setState("processing");
      setErrorText(null);
      try {
        if (speechEndedAt != null && process.env.NODE_ENV !== "production") {
          console.debug("[AskPranaVoiceTiming] speech-end-to-ai-request", {
            elapsedMs: Math.round(performance.now() - speechEndedAt),
          });
        }
        logVoiceTiming("ai-request-start", turnStartedAt);
        console.log("[AskPranaVoice] ask started");
        const result = await onAsk(cleaned, {
          ...requestContext,
          // Voice header language (e.g. తెలుగు) must drive replies even if STT is messy.
          sessionLanguageCode: activeLanguage,
          language: getAskPranaLanguageOption(activeLanguage).llmLabel,
        });
        if (!sessionActiveRef.current) return;
        if (!result?.answer?.trim()) {
          // A null result is now reserved for a stale/cancelled request. The
          // submitted user message stays in chat; do not send it again, but
          // restore Listening so the conversation is not stranded in Error.
          console.warn("[AskPranaVoice] voice request returned no answer", {
            sessionId: voiceSessionIdRef.current,
            state: stateRef.current,
          });
          turnInFlightRef.current = false;
          setErrorText(
            "That reply was interrupted before it could be shown. Listening again.",
          );
          const resumed = await startListeningSafely("retry");
          if (resumed) {
            setErrorText(
              "That reply was interrupted before it could be shown. Listening again.",
            );
          }
          return;
        }
        const cleanedAnswer = result.answer.trim();
        const responseReceivedAt = performance.now();
        logVoiceTiming("ai-response-complete", turnStartedAt, {
          answerLength: cleanedAnswer.length,
        });
        if (process.env.NODE_ENV !== "production") {
          console.debug("[AskPranaVoiceTiming] ai-response-first-and-complete-buffered", {
            elapsedMs: Math.round(responseReceivedAt - turnStartedAt),
          });
        }
        if (/^no response received\.?$/i.test(cleanedAnswer)) {
          setState("error");
          setErrorText(
            "Ask Prana could not finish that answer. Tap the orb to try again.",
          );
          appendLine(
            "assistant",
            "Sorry — I could not finish that answer just now. Please ask again.",
          );
          return;
        }
        // The Voice Mode header is an explicit user selection. A reply's text
        // must never change it (for example, Telugu → Tamil/English).
        const replyLanguage = activeLanguage;
        console.log("[AskPranaVoice] ask ok", {
          answerLength: cleanedAnswer.length,
          replyLanguage,
        });
        appendLine("assistant", cleanedAnswer);
        if (mutedRef.current) {
          setErrorText(null);
          setState("muted");
          stateRef.current = "muted";
          return;
        }
        setState("speaking");
        stateRef.current = "speaking";
        logVoiceTiming("tts-request-start", turnStartedAt, { replyLanguage });
        console.log("[AskPranaVoice] speak started", { replyLanguage });
        const speechTurn = ++speechTurnRef.current;
        const spoken = await speakAskPranaText(cleanedAnswer, replyLanguage, {
          shouldPlay: () =>
            sessionActiveRef.current &&
            !mutedRef.current &&
            speechTurn === speechTurnRef.current,
          onPlaybackStart: () => {
            // This marks playback being handed to the platform. Browsers do not
            // expose a reliable cross-engine first-sample callback.
            logVoiceTiming("audio-playback-requested", turnStartedAt);
            if (process.env.NODE_ENV !== "production") {
              console.debug("[AskPranaVoiceTiming] response-to-playback-requested", {
                elapsedMs: Math.round(performance.now() - responseReceivedAt),
              });
            }
            void startBargeInMonitor();
          },
          keepMicrophoneActive: true,
        });
        // A newer owner (barge-in, orb tap, typed message, language change)
        // has already started the next turn. Restarting listening here would
        // collide with it and drop the user's interrupting question.
        if (speechTurn !== speechTurnRef.current) return;
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
          setErrorText(
            spoken.reason ||
              "Could not play speech. The reply is shown above — listening continues.",
          );
        } else {
          logVoiceTiming("voice-turn-complete", turnStartedAt, { provider: spoken.provider });
          console.log("[AskPranaVoice] speak finished", { provider: spoken.provider });
          setErrorText(null);
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
        if (!sessionActiveRef.current) return;
        setState("error");
        setErrorText(
          error instanceof Error
            ? error.message
            : "Voice turn failed. You can keep using text chat.",
        );
      }
    },
    [
      activeLanguage,
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
      const recognized = (await onStopListeningToTranscript())?.trim() ?? "";
      const isStale = () =>
        !sessionActiveRef.current ||
        mutedRef.current ||
        voiceSessionIdRef.current !== sessionId ||
        listeningAttemptRef.current !== listeningAttempt;
      // An interruption's first words were spoken before the recognizer was
      // running; its recognizer text may be only the last word. Transcribe
      // the captured audio (with pre-roll) and keep the fuller result.
      const capture = interruptCaptureRef.current;
      interruptCaptureRef.current = null;
      let transcript = recognized;
      if (capture) {
        const hadSpeech = capture.hadSpeech();
        const wav = capture.takeWav();
        if (wav && (hadSpeech || recognized)) {
          const captured = await transcribeInterruption(wav);
          if (captured && wordCount(captured) >= wordCount(recognized)) {
            transcript = captured;
          }
          logVoiceLifecycle("interruption-transcribed", {
            sessionId,
            turnId,
            recognizedWords: wordCount(recognized),
            capturedWords: wordCount(captured),
          });
        }
      }
      if (isStale()) return;
      if (!transcript) {
        console.log("[AskPranaVoice] empty transcript — keep listening");
        logVoiceLifecycle("transcript-empty", { sessionId, turnId });
        await startListeningSafely("retry");
        return;
      }
      logVoiceLifecycle("transcript-finalized", {
        sessionId,
        turnId,
        transcriptLength: transcript.trim().length,
      });
      await runTurnFromTranscript(transcript.trim());
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
  }, [onStopListeningToTranscript, runTurnFromTranscript, startListeningSafely]);

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
    if (current === "processing") return;

    orbPressLockRef.current = true;
    try {
      if (current === "speaking") {
        speechTurnRef.current += 1;
        stopBargeInMonitor();
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
  }, [finishListeningTurn, muted, startListeningSafely, stopBargeInMonitor]);

  const handleMuteToggle = useCallback(async () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setErrorText(null);
    if (next) {
      await onCancelListening();
      speechTurnRef.current += 1;
      stopBargeInMonitor();
      await stopAskPranaSpeech();
      setErrorText(null);
      setState("muted");
      stateRef.current = "muted";
      return;
    }
    await stopAskPranaSpeech();
    await startListeningSafely("resume");
  }, [onCancelListening, startListeningSafely, stopBargeInMonitor]);

  const handleEnd = useCallback(async () => {
    await cleanupSession();
    onClose();
  }, [cleanupSession, onClose]);

  const handleLanguageChange = useCallback(
    async (code: AskPranaSpeechLanguageCode) => {
      if (code === activeLanguage) {
        setLanguageMenuOpen(false);
        return;
      }

      setLanguageMenuOpen(false);
      setErrorText(null);
      speechTurnRef.current += 1;
      stopBargeInMonitor();
      await stopAskPranaSpeech();
      await onLanguageChange(code);
      if (!sessionActiveRef.current) return;
      setActiveLanguage(code);
      await startListeningSafely("resume");
    },
    [activeLanguage, onLanguageChange, startListeningSafely, stopBargeInMonitor],
  );

  const handleSendTyped = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSending || isTranscribing) return;
    onChangeDraft("");
    speechTurnRef.current += 1;
    stopBargeInMonitor();
    await stopAskPranaSpeech();
    await onCancelListening();
    await runTurnFromTranscript(text);
  }, [
    draft,
    isSending,
    isTranscribing,
    onCancelListening,
    onChangeDraft,
    runTurnFromTranscript,
    stopBargeInMonitor,
  ]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  useEffect(() => {
    if (!visible || variant !== "overlay") {
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

  const statusLabel = (() => {
    if (state === "listening") return "Listening…";
    if (state === "finalizing" || state === "processing" || isTranscribing || isSending) return "Thinking…";
    if (state === "speaking") return "Speaking… Tap the orb to interrupt.";
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
          state={state === "finalizing" ? "processing" : state}
          audioLevel={reducedMotion ? 0 : Math.min(effectiveAudioLevel * 3, 1)}
          reducedMotion={reducedMotion}
        />
      </Animated.View>
    </Pressable>
  );

  if (!visible) return null;

  if (variant === "overlay") {
    return (
      <View pointerEvents="box-none" style={styles.overlayHost}>
        {orb}
        {errorText ? <Text style={styles.errorHint}>{errorText}</Text> : null}
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
            {ASK_PRANA_LANGUAGE_OPTIONS.map((option) => (
              <Pressable
                key={option.code}
                onPress={() => void handleLanguageChange(option.code)}
                style={[
                  styles.languageOption,
                  option.code === activeLanguage && styles.languageOptionActive,
                ]}
              >
                <Text style={styles.languageOptionText}>{option.nativeLabel}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.stage}>
          {orb}
          {statusLabel ? <Text style={styles.status}>{statusLabel}</Text> : null}
          {captionsVisible && lines.length ? (
            <Text style={styles.caption} numberOfLines={3}>
              {lines[lines.length - 1]?.text}
            </Text>
          ) : null}
          {errorText && state !== "error" ? (
            <Text style={styles.errorHint}>{errorText}</Text>
          ) : null}
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
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 28,
    zIndex: 5,
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
    outlineStyle: "none",
    outlineWidth: 0,
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
