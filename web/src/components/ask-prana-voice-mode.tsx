import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
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
import { setVoiceAutoStopListener } from "../context/ask-prana-chat-context";

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

export type VoiceModeState =
  | "listening"
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

function VoiceSkyOrb({ size, scale }: { size: number; scale: number }) {
  const bands = 40;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        transform: [{ scale }],
        backgroundColor: "#0F766E",
      }}
    >
      {Array.from({ length: bands }, (_, index) => {
        const t = index / (bands - 1);
        const color = t < 0.42
          ? mixHex("#0F766E", "#5EEAD4", t / 0.42)
          : mixHex("#5EEAD4", "#FFFFFF", (t - 0.42) / 0.58);
        return (
          <View
            key={index}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: (size / bands) * index,
              height: size / bands + 1,
              backgroundColor: color,
            }}
          />
        );
      })}
      <View
        style={{
          position: "absolute",
          left: size * 0.08,
          width: size * 0.7,
          bottom: size * 0.08,
          height: size * 0.34,
          borderRadius: size,
          backgroundColor: "rgba(255,255,255,0.55)",
        }}
      />
      <View
        style={{
          position: "absolute",
          right: size * 0.06,
          width: size * 0.42,
          bottom: size * 0.2,
          height: size * 0.22,
          borderRadius: size,
          backgroundColor: "rgba(255,255,255,0.4)",
        }}
      />
    </View>
  );
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
  const [pulse, setPulse] = useState(0);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [activeLanguage, setActiveLanguage] =
    useState<AskPranaSpeechLanguageCode>(language);
  const loopArmedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const stateRef = useRef<VoiceModeState>("idle");
  const isRecordingRef = useRef(false);
  const orbPressLockRef = useRef(false);

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

  const appendLine = useCallback((role: "user" | "assistant", text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLines((current) => [
      ...current,
      { id: `${Date.now()}-${role}-${current.length}`, role, text: trimmed },
    ]);
  }, []);

  const cleanupSession = useCallback(async () => {
    sessionActiveRef.current = false;
    loopArmedRef.current = false;
    await stopAskPranaSpeech();
    setState("idle");
  }, []);

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
    loopArmedRef.current = true;
    setState(muted ? "muted" : "listening");
    if (!muted) {
      void onStartListening().catch(() => {
        setState("error");
        setErrorText("Could not start the microphone.");
      });
    }

    return () => {
      sessionActiveRef.current = false;
      void stopAskPranaSpeech();
    };
    // Intentionally run on visible/muted open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible || (state !== "listening" && state !== "speaking")) return;
    const timer = setInterval(() => {
      setPulse((current) => (current + 1) % 3);
    }, 420);
    return () => clearInterval(timer);
  }, [visible, state]);

  const runTurnFromTranscript = useCallback(
    async (transcript: string) => {
      if (!sessionActiveRef.current) return;
      const cleaned = transcript.trim();
      console.log("[AskPranaVoice] transcript received", {
        length: cleaned.length,
        preview: cleaned.slice(0, 120),
      });
      appendLine("user", cleaned);
      setState("processing");
      setErrorText(null);
      try {
        console.log("[AskPranaVoice] ask started");
        const result = await onAsk(cleaned, {
          ...requestContext,
          // Voice header language (e.g. తెలుగు) must drive replies even if STT is messy.
          sessionLanguageCode: activeLanguage,
          language: getAskPranaLanguageOption(activeLanguage).llmLabel,
        });
        if (!sessionActiveRef.current) return;
        if (!result?.answer?.trim()) {
          console.log("[AskPranaVoice] ask returned empty answer");
          setState("error");
          setErrorText(
            "Ask Prana could not answer that turn. Tap the orb to try again, or use text chat.",
          );
          return;
        }
        const cleanedAnswer = result.answer.trim();
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
        console.log("[AskPranaVoice] speak started", { replyLanguage });
        const spoken = await speakAskPranaText(cleanedAnswer, replyLanguage);
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
          console.log("[AskPranaVoice] speak finished", { provider: spoken.provider });
          setErrorText(null);
        }
        if (mutedRef.current || !sessionActiveRef.current) {
          setErrorText(null);
          setState("muted");
          stateRef.current = "muted";
          return;
        }
        setState("listening");
        console.log("[AskPranaVoice] resuming listen");
        await onStartListening();
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
    ],
  );

  const finishListeningTurn = useCallback(async () => {
    if (!sessionActiveRef.current || mutedRef.current) return;
    if (stateRef.current === "processing" || stateRef.current === "speaking") return;
    // Immediate UI feedback — do not wait on React isRecording (can be stale).
    setState("processing");
    stateRef.current = "processing";
    setErrorText(null);
    try {
      // Always attempt stop; capture path no-ops if mic is not live.
      const transcript = await onStopListeningToTranscript();
      if (!sessionActiveRef.current || mutedRef.current) return;
      if (!transcript?.trim()) {
        console.log("[AskPranaVoice] empty transcript — keep listening");
        setErrorText(null);
        setState("listening");
        stateRef.current = "listening";
        await onStartListening();
        return;
      }
      await runTurnFromTranscript(transcript.trim());
    } catch (error) {
      console.log("[AskPranaVoice] finish listen failed:", error);
      setState("error");
      stateRef.current = "error";
      // Keep the actionable server/recording error. The previous generic copy
      // concealed whether the microphone, transcription service, or Ask Prana
      // reply had failed, making both mic entry points look broken.
      setErrorText(voiceTurnErrorMessage(error));
    }
  }, [onStartListening, onStopListeningToTranscript, runTurnFromTranscript]);

  useEffect(() => {
    if (!visible) {
      setVoiceAutoStopListener(null);
      return;
    }
    setVoiceAutoStopListener(() => {
      if (!sessionActiveRef.current || mutedRef.current) return;
      if (stateRef.current !== "listening") return;
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
        await stopAskPranaSpeech();
        setState("listening");
        stateRef.current = "listening";
        await onStartListening();
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
        setErrorText(null);
        setState("listening");
        stateRef.current = "listening";
        await onStartListening();
      }
    } finally {
      orbPressLockRef.current = false;
    }
  }, [finishListeningTurn, muted, onStartListening]);

  const handleMuteToggle = useCallback(async () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setErrorText(null);
    if (next) {
      await onCancelListening();
      await stopAskPranaSpeech();
      setErrorText(null);
      setState("muted");
      stateRef.current = "muted";
      return;
    }
    await stopAskPranaSpeech();
    setState("listening");
    stateRef.current = "listening";
    await onStartListening();
  }, [onCancelListening, onStartListening]);

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
      await stopAskPranaSpeech();
      await onLanguageChange(code);
      if (!sessionActiveRef.current) return;
      setActiveLanguage(code);
      setState("listening");
      stateRef.current = "listening";
      await onStartListening();
    },
    [activeLanguage, onLanguageChange, onStartListening],
  );

  const handleSendTyped = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSending || isTranscribing) return;
    onChangeDraft("");
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
    if (state === "listening") return "";
    if (state === "processing" || isTranscribing || isSending) return "";
    if (state === "speaking") return "";
    if (state === "muted") return "Muted";
    if (state === "reconnecting") return "Reconnecting…";
    if (state === "error") return errorText || "Something went wrong";
    return "";
  })();
  const orbScale = state === "speaking" ? 1.06 + pulse * 0.03 : state === "listening" ? 1 + pulse * 0.025 : 1;
  const orb = (
    <Pressable
      onPress={() => {
        void handleOrbPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Voice conversation"
    >
      <VoiceSkyOrb size={variant === "overlay" ? 88 : 200} scale={orbScale} />
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
          {errorText && state !== "error" ? (
            <Text style={styles.errorHint}>{errorText}</Text>
          ) : null}
        </View>

        <View style={styles.bottomBar}>
          <View style={styles.composerPill}>
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
