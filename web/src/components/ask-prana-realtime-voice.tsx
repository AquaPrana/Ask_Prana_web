/**
 * Realtime voice chat screen (gpt-realtime-2.1-mini through the OpenAI
 * Realtime API). Shown instead of the classic Voice Chat only when
 * EXPO_PUBLIC_VOICE_ENGINE=realtime. The classic Voice Chat is unchanged.
 *
 * Layouts match the classic screen: "overlay" is the desktop dock under the
 * message list, "screen" is the full-screen phone stage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PRANA_FONT, pranaGradientStyle } from "../constants/prana-theme";
import { pc } from "../constants/prana-theme-mode";
import { ASK_PRANA_LANGUAGE_OPTIONS } from "../lib/ask-prana-language";
import { createVoiceScreenWakeLock } from "../lib/ask-prana-screen-wake-lock";
import {
  isRealtimeVoiceSupported,
  startAskPranaRealtimeVoice,
  type RealtimeVoiceController,
  type RealtimeVoiceHistoryItem,
  type RealtimeVoiceLanguage,
  type RealtimeVoiceStatus,
} from "../lib/ask-prana-realtime";
import { PranaHeader, PranaHeaderButton, PranaLanguageButton } from "./prana-header";
import { PranaVoiceMark, type PranaVoiceVisualState } from "./prana-voice-mark";

/** A call ends on its own after this long, to keep cost predictable. */
export const REALTIME_VOICE_MAX_SESSION_MS = 10 * 60 * 1000;
/** ...or after this long without the farmer speaking or typing. */
export const REALTIME_VOICE_IDLE_MS = 60 * 1000;


type ScreenState = RealtimeVoiceStatus | "muted" | "error" | "idle";

type VoiceBarActions = {
  toggleMute: () => void;
  end: () => void;
  submitTyped: () => void;
};

type Props = {
  visible: boolean;
  variant: "overlay" | "screen";
  draft: string;
  onChangeDraft: (value: string) => void;
  onClose: () => void;
  /** Recent chat turns, so the voice model can continue the conversation. */
  getHistory: () => RealtimeVoiceHistoryItem[];
  onUserText: (text: string) => void;
  onAssistantText: (text: string) => void;
  onOpenMenu?: () => void;
  onMutedChange?: (muted: boolean) => void;
  onRegisterActions?: (actions: VoiceBarActions | null) => void;
};


function statusLabelFor(state: ScreenState, errorText: string | null) {
  switch (state) {
    case "connecting": return "Connecting…";
    case "listening":
    case "hearing": return "Listening…";
    case "thinking": return "Thinking…";
    case "speaking": return "Speaking…";
    case "muted": return "Muted";
    case "error": return errorText || "Voice chat stopped.";
    case "ended": return errorText || "Voice chat ended.";
    default: return "";
  }
}

export function AskPranaRealtimeVoice({
  visible,
  variant,
  draft,
  onChangeDraft,
  onClose,
  getHistory,
  onUserText,
  onAssistantText,
  onOpenMenu,
  onMutedChange,
  onRegisterActions,
}: Props) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<ScreenState>("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [language, setLanguage] = useState<RealtimeVoiceLanguage>("auto");
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(false);
  const [lastUserText, setLastUserText] = useState<string | null>(null);
  const [lastAssistantText, setLastAssistantText] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [wakeLockNote, setWakeLockNote] = useState<string | null>(null);
  /** Bumped to start a new call (open, retry, language change). */
  const [callKey, setCallKey] = useState(0);

  const controllerRef = useRef<RealtimeVoiceController | null>(null);
  const statusRef = useRef<ScreenState>("idle");
  const mutedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const startedAtRef = useRef(Date.now());
  const callbacksRef = useRef({ getHistory, onUserText, onAssistantText });
  callbacksRef.current = { getHistory, onUserText, onAssistantText };

  const applyState = useCallback((next: ScreenState) => {
    statusRef.current = next;
    setState(next);
  }, []);

  // Start one call per (visible, callKey, language); stop it on change/close.
  useEffect(() => {
    if (!visible) return;
    if (!isRealtimeVoiceSupported()) {
      setErrorText("This browser does not support live voice chat.");
      applyState("error");
      return;
    }
    let current = true;
    const startedAt = Date.now();
    startedAtRef.current = startedAt;
    lastActivityRef.current = startedAt;
    setErrorText(null);
    setNotice(null);
    setLastUserText(null);
    setLastAssistantText(null);
    applyState("connecting");
    void startAskPranaRealtimeVoice({
      language,
      history: callbacksRef.current.getHistory(),
      handlers: {
        onStatus: (status) => {
          if (!current) return;
          if (status === "speaking") lastActivityRef.current = Date.now();
          if (status === "ended") {
            controllerRef.current = null;
            if (statusRef.current !== "error") applyState("ended");
            return;
          }
          // Muted stays muted; the model can still finish speaking.
          applyState(mutedRef.current && status !== "speaking" ? "muted" : status);
        },
        onUserText: (text) => {
          if (!current) return;
          setLastUserText(text);
          setLastAssistantText(null);
          callbacksRef.current.onUserText(text);
        },
        onAssistantText: (text) => {
          if (!current) return;
          setLastAssistantText(text);
          callbacksRef.current.onAssistantText(text);
        },
        onError: (message, fatal) => {
          if (!current) return;
          if (fatal) {
            setErrorText(message);
            applyState("error");
          } else {
            setNotice(message);
          }
        },
        onActivity: () => {
          lastActivityRef.current = Date.now();
          setNotice(null);
        },
      },
    }).then((controller) => {
      if (!current) {
        controller.stop();
        return;
      }
      controllerRef.current = controller;
      controller.setMuted(mutedRef.current);
    });
    return () => {
      current = false;
      controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, [visible, callKey, language, applyState]);

  // Reset per-open UI when the screen closes.
  useEffect(() => {
    if (visible) return;
    applyState("idle");
    setLanguageMenuOpen(false);
    setMuted(false);
    mutedRef.current = false;
  }, [visible, applyState]);

  // Session length and idle limits.
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      if (!controllerRef.current) return;
      const now = Date.now();
      const busy = statusRef.current === "speaking" || statusRef.current === "thinking";
      let reason: string | null = null;
      if (now - startedAtRef.current >= REALTIME_VOICE_MAX_SESSION_MS) {
        reason = "Voice chat ended after 10 minutes. Tap the circle to continue.";
      } else if (!busy && now - lastActivityRef.current >= REALTIME_VOICE_IDLE_MS) {
        reason = "Voice chat paused because it was quiet. Tap the circle to continue.";
      }
      if (reason) {
        setErrorText(reason);
        controllerRef.current.stop();
        controllerRef.current = null;
        applyState("ended");
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [visible, applyState]);

  // Orb loudness from the live microphone / speaker.
  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof window === "undefined") return;
    let frame = 0;
    let last = 0;
    const tick = () => {
      const levels = controllerRef.current?.levels();
      const next = levels
        ? statusRef.current === "speaking" ? levels.speaker : levels.mic
        : 0;
      if (Math.abs(next - last) > 0.03) {
        last = next;
        setLevel(next);
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  // Keep the phone screen awake during the call (same helper as classic voice).
  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof navigator === "undefined" || typeof document === "undefined") {
      return;
    }
    const sessionId = Date.now();
    const navigatorWithLock = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    const wakeLock = createVoiceScreenWakeLock({
      supported: typeof navigatorWithLock.wakeLock?.request === "function",
      request: () => navigatorWithLock.wakeLock!.request("screen"),
      isDocumentVisible: () => document.visibilityState === "visible",
      onUnavailable: (message) => setWakeLockNote(message),
    });
    wakeLock.open(sessionId, document.visibilityState === "visible");
    const onVisibility = () => wakeLock.onDocumentVisibility(sessionId, document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      setWakeLockNote(null);
      void wakeLock.close(sessionId);
    };
  }, [visible]);

  useEffect(() => {
    onMutedChange?.(muted);
  }, [muted, onMutedChange]);

  const restart = useCallback(() => {
    setErrorText(null);
    setCallKey((key) => key + 1);
  }, []);

  const handleMuteToggle = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    controllerRef.current?.setMuted(next);
    lastActivityRef.current = Date.now();
    if (statusRef.current === "listening" || statusRef.current === "hearing" || statusRef.current === "muted") {
      applyState(next ? "muted" : "listening");
    }
  }, [applyState]);

  const handleEnd = useCallback(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    onClose();
  }, [onClose]);

  const handleSendTyped = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (controllerRef.current?.sendText(text)) {
      onChangeDraft("");
      setNotice(null);
    } else {
      setNotice("Voice chat is not connected. Tap the circle to reconnect, then send again.");
    }
  }, [draft, onChangeDraft]);

  const handleOrbPress = useCallback(() => {
    const current = statusRef.current;
    if (current === "error" || current === "ended" || current === "idle") {
      restart();
      return;
    }
    if (current === "speaking" || current === "thinking") {
      controllerRef.current?.interrupt();
      lastActivityRef.current = Date.now();
      applyState(mutedRef.current ? "muted" : "listening");
    }
  }, [applyState, restart]);

  const handleLanguageChange = useCallback((next: RealtimeVoiceLanguage) => {
    setLanguageMenuOpen(false);
    if (next === language) return;
    // A new language needs new instructions, so the call restarts.
    setLanguage(next);
  }, [language]);

  useEffect(() => {
    if (!visible) {
      onRegisterActions?.(null);
      return;
    }
    onRegisterActions?.({
      toggleMute: handleMuteToggle,
      end: handleEnd,
      submitTyped: handleSendTyped,
    });
    return () => onRegisterActions?.(null);
  }, [visible, handleMuteToggle, handleEnd, handleSendTyped, onRegisterActions]);

  if (!visible) return null;

  const statusLabel = statusLabelFor(state, errorText);
  const canRetry = state === "error" || state === "ended";
  const visualState = visualStateFor(state);
  const languageLabel = language === "auto"
    ? "Auto"
    : ASK_PRANA_LANGUAGE_OPTIONS.find((option) => option.code === language)?.nativeLabel ?? language;
  const mark = (
    <Pressable
      onPress={handleOrbPress}
      accessibilityRole="button"
      accessibilityLabel={canRetry ? "Start voice chat again" : "Voice conversation. Tap to interrupt."}
      style={variant === "overlay" ? styles.markOverlay : styles.markScreen}
    >
      <View
        style={[
          styles.markFill,
          // Grows slightly with the live voice volume, as the old circle did.
          { transform: [{ scale: !reducedMotion && (state === "speaking" || state === "hearing") ? 1 + level * 0.06 : 1 }] },
        ]}
      >
        <PranaVoiceMark state={visualState} style={styles.markFill} />
      </View>
    </Pressable>
  );
  const languagePicker = (
    <View style={styles.languageMenu}>
      {([{ mode: "auto", label: "Auto" }, ...ASK_PRANA_LANGUAGE_OPTIONS.map((option) => ({
        mode: option.code,
        label: option.nativeLabel,
      }))] as { mode: RealtimeVoiceLanguage; label: string }[]).map((option) => (
        <Pressable
          key={option.mode}
          onPress={() => handleLanguageChange(option.mode)}
          style={[styles.languageOption, option.mode === language && styles.languageOptionActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: option.mode === language }}
        >
          <Text style={[styles.languageOptionText, option.mode === language && styles.languageOptionTextActive]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
  const retryButton = canRetry ? (
    <Pressable
      onPress={restart}
      style={[styles.retryBtn, pranaGradientStyle]}
      accessibilityRole="button"
      accessibilityLabel="Start voice chat again"
    >
      <Text style={styles.retryText}>{state === "error" ? "Try again" : "Continue"}</Text>
    </Pressable>
  ) : null;
  const statusText = statusLabel ? (
    <Text style={[styles.status, state === "error" && styles.errorText]}>{statusLabel}</Text>
  ) : null;

  if (variant === "overlay") {
    // Desktop: mounted under the message list; questions and answers appear
    // in the conversation. Mute, end and typing use the page's bottom bar.
    return (
      <View style={styles.overlayHost}>
        {mark}
        {statusText}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {retryButton}
        <Pressable
          onPress={() => setLanguageMenuOpen((open) => !open)}
          style={styles.languageToggle}
          accessibilityRole="button"
          accessibilityLabel="Change voice language"
        >
          <Feather name="globe" size={14} color={pc.fg("#5C7570")} />
          <Text style={styles.languageToggleText}>
            {language === "auto" ? "Auto language" : languageLabel}
          </Text>
        </Pressable>
        {languageMenuOpen ? languagePicker : null}
        {wakeLockNote ? <Text style={styles.wakeLockNote}>{wakeLockNote}</Text> : null}
      </View>
    );
  }

  // Phone: full-screen voice chat, as in the AskPrana prototype.
  const showCaptions = captionsVisible && (state === "thinking" || state === "speaking");
  return (
    // Bottom space is for the chat page's voice bar (type, mute, end), shown below.
    <View style={[styles.root, { paddingBottom: Math.max(insets.bottom, 10) + 84 }]}>
      <PranaHeader
        variant="teal"
        left={<PranaHeaderButton icon="menu" onPress={() => onOpenMenu?.()} label="Open menu" />}
        right={
          <PranaLanguageButton
            label={language === "auto" ? "Auto" : language}
            onPress={() => setLanguageMenuOpen((open) => !open)}
            accessibilityLabel={`Change voice language: ${languageLabel}`}
          />
        }
      />
      {languageMenuOpen ? <View style={styles.languageMenuBar}>{languagePicker}</View> : null}

      <View style={styles.stage}>
        {mark}
        {statusText}
        <Pressable
          onPress={() => setCaptionsVisible((value) => !value)}
          style={[styles.captionsChip, captionsVisible && styles.captionsChipOn]}
          accessibilityRole="button"
          accessibilityLabel={captionsVisible ? "Hide captions" : "Show captions"}
        >
          <Feather name="align-left" size={14} color={pc.fg("#397C6A")} />
          <Text style={styles.captionsChipText}>{captionsVisible ? "Hide captions" : "Captions"}</Text>
        </Pressable>
        {showCaptions && lastUserText ? (
          <Text style={styles.caption} numberOfLines={3} accessibilityLabel={`You said: ${lastUserText}`}>
            {lastUserText}
          </Text>
        ) : null}
        {showCaptions && lastAssistantText ? (
          <Text style={styles.caption} numberOfLines={4} accessibilityLabel={`Ask Prana said: ${lastAssistantText}`}>
            {lastAssistantText}
          </Text>
        ) : null}
        {notice ? <Text style={[styles.notice, styles.noticeCard]}>{notice}</Text> : null}
        {retryButton}
        {wakeLockNote ? <Text style={styles.wakeLockNote}>{wakeLockNote}</Text> : null}
      </View>

    </View>
  );
}

/** Which motion the voice artwork shows for each call state. */
function visualStateFor(state: ScreenState): PranaVoiceVisualState {
  switch (state) {
    case "listening":
    case "hearing": return "listening";
    case "speaking": return "speaking";
    case "connecting":
    case "thinking": return "thinking";
    case "muted": return "muted";
    case "error": return "error";
    default: return "ready";
  }
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    height: "100%",
    backgroundColor: pc.bg("#F5F5DF"),
    ...(Platform.OS === "web"
      ? ({ position: "fixed", top: 0, right: 0, bottom: 0, left: 0, zIndex: 100 } as unknown as ViewStyle)
      : {}),
  },
  overlayHost: {
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingTop: 20,
    paddingBottom: 10,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  markScreen: { width: "82%", maxWidth: 300, aspectRatio: 1.62 },
  markOverlay: { width: 240, maxWidth: "80%", aspectRatio: 1.62 },
  markFill: { width: "100%", height: "100%" },
  languageMenuBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: pc.bg("#F5F5DF"),
    borderBottomWidth: 1,
    borderBottomColor: pc.bd("#D9DDC6"),
  },
  languageMenu: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  languageOption: {
    minHeight: 34,
    justifyContent: "center",
    borderColor: pc.bd("#C6D6BF"),
    backgroundColor: pc.bg("#F0F3E4"),
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  languageOptionActive: { backgroundColor: "#008081", borderColor: "#008081" },
  languageOptionText: {
    color: pc.fg("#397C6A"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },
  languageOptionTextActive: { color: "#FFFFFF" },
  languageToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  languageToggleText: {
    color: pc.fg("#5C7570"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 24,
  },
  status: {
    color: pc.fg("#5C7570"),
    fontFamily: F,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    textAlign: "center",
    paddingHorizontal: 16,
  },
  errorText: { color: pc.fg("#AD3D31") },
  notice: {
    color: pc.fg("#5C7570"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 16,
    maxWidth: 420,
  },
  noticeCard: {
    alignSelf: "stretch",
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: pc.bg("#FFFDF0"),
    color: pc.fg("#6D5549"),
  },
  caption: {
    color: pc.fg("#15393A"),
    fontFamily: F,
    fontSize: 15,
    lineHeight: 23,
    textAlign: "center",
    paddingHorizontal: 8,
    maxWidth: 560,
  },
  wakeLockNote: {
    color: pc.fg("#5C7570"),
    fontFamily: F,
    fontSize: 11,
    lineHeight: 16,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  retryBtn: {
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: {
    color: "#FFFFFF",
    fontFamily: F,
    fontSize: 13,
    fontWeight: "800",
  },
  captionsChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: pc.bd("#C6D6BF"),
    backgroundColor: pc.bg("#F0F3E4"),
  },
  captionsChipOn: { backgroundColor: pc.bg("#D7EEE0"), borderColor: pc.bd("#8EB49E") },
  captionsChipText: { color: pc.fg("#397C6A"), fontFamily: F, fontSize: 11, lineHeight: 14, fontWeight: "700" },
  footer: {
    paddingTop: 12,
    paddingHorizontal: 14,
    backgroundColor: pc.bg("#F5F5DF"),
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    padding: 8,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: pc.bd("#C7D5BD"),
    backgroundColor: pc.bg("#FFFDF0"),
  },
  barBtn: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  barBtnOn: { backgroundColor: pc.bg("#EDF2E2") },
  bars: { flex: 1, minWidth: 0, height: 26 },
  micLive: { backgroundColor: pc.bg("#D7EEE0") },
  micDot: {
    position: "absolute",
    top: 7,
    right: 7,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: pc.fg("#008081"),
  },
  endRow: { height: 34, marginTop: 6, alignItems: "flex-end", justifyContent: "center", paddingRight: 5 },
  endBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: pc.bd("#CDD9C3"),
    alignItems: "center",
    justifyContent: "center",
  },
});
