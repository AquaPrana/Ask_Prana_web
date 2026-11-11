import { ASK_PRANA_FONT_FAMILY } from "../constants/ask-prana-typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputSelectionChangeEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import Feather from "@expo/vector-icons/Feather";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  useFocusEffect,
  useGlobalSearchParams,
  useNavigation,
  usePathname,
  useRouter,
} from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { LANGUAGE_STORAGE_KEY, setAppLanguage } from "../i18n";
import {
  AskPranaAttachmentViewer,
  AskPranaChatMessageBubble,
  AskPranaThinkingBubble,
} from "../components/ask-prana-chat-message";
import { AskPranaChatSidebar } from "../components/ask-prana-chat-sidebar";
import { AskPranaLogo } from "../components/ask-prana-logo";
import { AskPranaRecordingWaveform } from "../components/ask-prana-recording-waveform";
import { AskPranaVoiceModeModal } from "../components/ask-prana-voice-mode";
import { AskPranaRealtimeVoice } from "../components/ask-prana-realtime-voice";
import { AskPranaVoiceWaveformIcon } from "../components/ask-prana-voice-waveform-icon";
import {
  PranaBrand,
  PranaHeader,
  PranaHeaderButton,
  PranaLanguageButton,
} from "../components/prana-header";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";
import { useAskPranaChat, type ChatMessage } from "../context/ask-prana-chat-context";
import {
  ASK_PRANA_LANGUAGE_OPTIONS,
  getAskPranaLanguageOption,
  loadAskPranaPreferredLanguage,
  mapToAskPranaLanguageCode,
  saveAskPranaPreferredLanguage,
  type AskPranaSpeechLanguageCode,
} from "../lib/ask-prana-language";
import { speakAskPranaText, stopAskPranaSpeech } from "../lib/ask-prana-speech";
import { languageForQuestionText } from "../lib/ask-prana-voice-language";
import { type AskPranaRequestContext } from "../services/ask-prana";
import {
  retryAskPranaVisibleTranslations,
  selectAskPranaLanguageWhenReady,
  useAskPranaDisplayTranslation,
} from "../lib/ask-prana-display-translation";
/**
 * Voice Chat engine. "realtime" uses the OpenAI Realtime voice chat
 * (gpt-realtime-2.1-mini); anything else keeps the classic Voice Chat.
 */
const REALTIME_VOICE_ENABLED = import.meta.env.EXPO_PUBLIC_VOICE_ENGINE === "realtime";

// AskPrana cream / teal theme (mobile prototype + desktop design).
const colors = {
  primary: prana.teal,
  primaryDark: prana.tealDeep,
  primarySoft: "#DCEEE1",
  primaryBright: prana.teal,
  background: prana.cream,
  white: "#FFFFFF",
  textDark: prana.ink,
  muted: prana.muted,
  border: prana.line,
  suggestion: prana.card,
  warningSoft: prana.cream,
};

const COMPOSER_INPUT_MIN_HEIGHT = 48;
const NEAR_BOTTOM_DISTANCE = 96;

/** Label-only hint for the loading bubble; the Edge Function decides the real export. */
function detectRequestedFileFormat(text: string): "docx" | "pdf" | "xlsx" | null {
  if (/\b(excel|xlsx|spreadsheet)\b|ఎక్సెల్|एक्सेल/i.test(text)) return "xlsx";
  if (/\bpdf\b|పీడీఎఫ్|पीडीएफ/i.test(text)) return "pdf";
  if (
    /\b(docx|word\s+(document|file|format)|document\s+(format|file)|downloadable\s+document)\b/i.test(text) ||
    /\b(in|as|into|to|with|by|via|using|through|on)\s+(a\s+|an\s+|the\s+)?(\.?docx?|word|document)\b(?!\s*[-:]?\s*\d)/i.test(text) ||
    /వర్డ్|డాక్యుమెంట్|वर्ड|डॉक्यूमेंट|दस्तावेज/.test(text)
  ) {
    return "docx";
  }
  return null;
}

function splitAttachmentFileName(fileName: string): { base: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return { base: fileName, extension: "" };
  }
  return { base: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

const LANGUAGE_SHORT_LABELS: Record<AskPranaSpeechLanguageCode, string> = {
  en: "En",
  te: "Te",
  hi: "Hi",
};
const COMPOSER_INPUT_LINE_HEIGHT = 20;
const COMPOSER_INPUT_MIN_VIEWPORT_MAX_HEIGHT = 120;
const COMPOSER_INPUT_ABSOLUTE_MAX_HEIGHT = 144;

type WebTextInputRef = TextInput & {
  getNativeRef?: () => { scrollHeight?: number } | null;
};

function getComposerInputMaxHeight(viewportHeight: number) {
  // The compact composer is intentionally capped at a few lines. A long
  // draft belongs in the expanded editor; allowing it to consume a large
  // percentage of the viewport turns the input into the tall narrow strip
  // seen on Android when controls share the composer row.
  return Math.min(
    COMPOSER_INPUT_ABSOLUTE_MAX_HEIGHT,
    Math.max(
      COMPOSER_INPUT_MIN_VIEWPORT_MAX_HEIGHT,
      Math.floor(viewportHeight * 0.22),
    ),
  );
}

function clampComposerInputHeight(height: number, maxHeight: number) {
  return Math.min(
    maxHeight,
    Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.ceil(height)),
  );
}

/**
 * Native content-size events provide the exact height. This estimate is a
 * fallback for web and programmatic speech updates, where that event may not
 * fire after a controlled value changes.
 */
/** Text metrics for the estimate: desktop 14 px text, phones 16 px text. */
type ComposerTextMetrics = { charWidth: number; lineHeight: number; padding: number };
const DESKTOP_COMPOSER_METRICS: ComposerTextMetrics = {
  charWidth: 7,
  lineHeight: COMPOSER_INPUT_LINE_HEIGHT,
  padding: 12,
};
// Phones use 16 px text (so iPhone Safari doesn't zoom) with 22 px lines and
// no vertical padding; desktop numbers made long questions lose a line.
const MOBILE_COMPOSER_METRICS: ComposerTextMetrics = { charWidth: 9, lineHeight: 22, padding: 0 };

function estimateComposerInputHeight(
  text: string,
  availableWidth: number,
  maxHeight: number,
  metrics: ComposerTextMetrics = DESKTOP_COMPOSER_METRICS,
) {
  if (!text) return COMPOSER_INPUT_MIN_HEIGHT;

  // 14 pt medium text averages about 7 px per character (16 px text about 9).
  // The conservative estimate only fills a gap until an exact measurement.
  const charactersPerLine = Math.max(
    12,
    Math.floor(Math.max(availableWidth - 4, 0) / metrics.charWidth),
  );
  const visualLines = text.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  );
  return clampComposerInputHeight(
    visualLines * metrics.lineHeight + metrics.padding,
    maxHeight,
  );
}
const AUTH_ONBOARDING_ROUTES = new Set([
  "",
  "/",
  "index",
  "/index",
  "phone-login",
  "/phone-login",
  "verify-otp",
  "/verify-otp",
  "farmer-profile",
  "/farmer-profile",
]);

type NavStateLike = {
  index?: number;
  routes?: Array<{ name?: string; state?: NavStateLike }>;
};

function normalizeNavRouteName(name: string | undefined | null): string {
  if (!name) {
    return "";
  }
  const trimmed = name.replace(/^\//, "").replace(/\/$/, "");
  return trimmed === "" || trimmed === "index" ? "index" : trimmed;
}

function isAuthOnboardingRoute(name: string | undefined | null): boolean {
  const normalized = normalizeNavRouteName(name);
  return (
    AUTH_ONBOARDING_ROUTES.has(normalized) ||
    AUTH_ONBOARDING_ROUTES.has(`/${normalized}`)
  );
}

function getPreviousRouteName(state: NavStateLike | undefined): string | null {
  if (!state?.routes?.length) {
    return null;
  }

  let current: NavStateLike | undefined = state;
  let previous: string | null = null;

  while (current?.routes?.length) {
    const index: number = current.index ?? current.routes.length - 1;
    if (index > 0) {
      previous = current.routes[index - 1]?.name ?? null;
    }
    const focused: { name?: string; state?: NavStateLike } | undefined =
      current.routes[index];
    if (focused?.state) {
      current = focused.state;
    } else {
      break;
    }
  }

  return previous;
}

export default function AskPranaScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const navigation = useNavigation();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{
    pondId?: string | string[];
    cycleId?: string | string[];
    sessionId?: string | string[];
  }>();
  const { width } = useWindowDimensions();
  // React Native Web can briefly report the layout viewport width rather than
  // the browser viewport after hydration/zoom. Prefer the larger browser
  // measurement so desktop Voice Chat never falls into the mobile screen.
  const browserWidth =
    Platform.OS === "web" && typeof window !== "undefined"
      ? window.innerWidth
      : 0;
  const isDesktop = Platform.OS === "web" && Math.max(width, browserWidth) >= 1024;
  // Keep the established intermediate/tablet layout intact. The compact,
  // stacked composer is reserved for phone-width viewports.
  const isMobileComposer = Math.max(width, browserWidth) < 768;
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const listNearBottomRef = useRef(true);
  const listMetricsRef = useRef({ offsetY: 0, contentHeight: 0, viewportHeight: 0 });
  const pendingOlderLoadRef = useRef(false);
  const messageCountRef = useRef(0);
  const voiceInlineRef = useRef(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [scrollToLatestFocused, setScrollToLatestFocused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const composerInputRef = useRef<TextInput>(null);
  const measuredDraftRef = useRef<string | null>(null);
  const composerEnterSubmitLockRef = useRef(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [focusedLanguageOption, setFocusedLanguageOption] = useState<string | null>(null);
  const [hoveredLanguageOption, setHoveredLanguageOption] = useState<string | null>(null);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const failedRecordingIntentRef = useRef<"composer" | "send">("composer");
  // Start from the already-loaded UI language so nothing renders in English first.
  const [preferredLanguage, setPreferredLanguage] =
    useState<AskPranaSpeechLanguageCode>(() =>
      mapToAskPranaLanguageCode(i18n.resolvedLanguage),
    );
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const attachWrapRef = useRef<View>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    uri: string;
    fileName: string;
    mimeType: string;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(isDesktop);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [composerInputHeight, setComposerInputHeight] = useState(
    COMPOSER_INPUT_MIN_HEIGHT,
  );
  const [composerInputWidth, setComposerInputWidth] = useState(0);
  const [composerViewportHeight, setComposerViewportHeight] = useState(
    Dimensions.get("window").height,
  );
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState({ start: 0, end: 0 });
  // Set only when returning from the expanded editor. Keeping this nullable
  // avoids forcing the caret position during normal compact-composer typing.
  const [compactSelection, setCompactSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const insets = useSafeAreaInsets();
  const composerInputMaxHeight = useMemo(() => {
    // Android may either resize the layout or report the keyboard separately.
    // Taking the smaller available height avoids subtracting it twice.
    const windowWithoutKeyboard = Math.max(
      COMPOSER_INPUT_MIN_VIEWPORT_MAX_HEIGHT,
      Dimensions.get("window").height - keyboardHeight,
    );
    return getComposerInputMaxHeight(
      Math.min(composerViewportHeight, windowWithoutKeyboard),
    );
  }, [composerViewportHeight, keyboardHeight]);

  const {
    messages,
    draft,
    isSending,
    attachmentError,
    isRecording,
    isTranscribing,
    voiceAudioLevel,
    voiceLiveTranscript,
    isLoadingMessages,
    isAuthLoading,
    thinkingKind,
    generationStopped,
    pendingAttachments,
    activeSessionId,
    hasOlderMessages,
    isLoadingOlder,
    loadOlderMessages,
    setDraft,
    removePendingAttachment,
    retryPendingAttachment,
    sendQuestion,
    editAndResendUserMessage,
    askFromVoiceMode,
    prepareVoiceModeSession,
    recordRealtimeVoiceMessage,
    getRecentVoiceHistory,
    sendImageAttachment,
    sendDocumentAttachment,
    startAudioRecording,
    stopAudioRecordingToComposer,
    stopAudioRecordingToTranscript,
    stopVoiceListening,
    clearVoiceLiveTranscript,
    hasFailedRecording,
    needsDictationLanguage,
    uncertainDictationText,
    retryFailedRecording,
    discardFailedRecording,
    cancelAudioRecording,
    stopGeneration,
    startNewConversation,
    openConversation,
  } = useAskPranaChat();

  useEffect(() => {
    if (!isRecording || voiceModeOpen) {
      setRecordingElapsedSec(0);
      return;
    }
    setRecordingElapsedSec(0);
    const timer = setInterval(() => {
      setRecordingElapsedSec((current) => current + 1);
    }, 1_000);
    return () => clearInterval(timer);
  }, [isRecording, voiceModeOpen]);

  const recordingTimerLabel = `${Math.floor(recordingElapsedSec / 60)
    .toString()
    .padStart(2, "0")}:${(recordingElapsedSec % 60).toString().padStart(2, "0")}`;

  const routeSessionId = Array.isArray(params.sessionId)
    ? params.sessionId[0]
    : params.sessionId;
  const routeOpenSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // Open a conversation from the URL only when the URL itself changes (first
  // load, browser back/forward). A sidebar click changes activeSessionId first
  // and the URL second (effect below); reacting to activeSessionId here made
  // the two effects flip between the old and new chat until React aborted with
  // "Maximum update depth exceeded", firing ~50 duplicate history loads.
  useEffect(() => {
    if (isAuthLoading) return;
    const previousRouteSessionId = routeOpenSessionIdRef.current;
    routeOpenSessionIdRef.current = routeSessionId ?? null;
    if (!routeSessionId || routeSessionId === previousRouteSessionId) return;
    if (routeSessionId === activeSessionIdRef.current) return;
    void openConversation(routeSessionId).then((opened) => {
      // Drop a dead chat id from the address so a reload starts cleanly.
      if (!opened && routeOpenSessionIdRef.current === routeSessionId) {
        router.setParams({ sessionId: undefined } as never);
      }
    });
  }, [isAuthLoading, openConversation, routeSessionId, router]);

  // Keep the active persisted conversation in the route. If a browser tab is
  // discarded/reloaded while Ask Prana is in the background, this lets the
  // existing route-opening path restore the same history instead of falling
  // back to an in-memory welcome thread.
  //
  // Runs only when the open conversation changes, never when the URL changes:
  // reacting to URL changes here made browser Back/Forward flip between two
  // chats in a loop together with the route-opening effect above.
  const routeSessionIdRef = useRef(routeSessionId);
  routeSessionIdRef.current = routeSessionId;
  //
  // Switching from one conversation to another adds a browser history entry,
  // so Back returns to the previous conversation instead of leaving Ask Prana.
  // The first conversation (or a new chat receiving its id) replaces the
  // current entry, so empty "new chat" pages never pile up in history.
  useEffect(() => {
    const currentRouteSessionId = routeSessionIdRef.current;
    if (!activeSessionId || currentRouteSessionId === activeSessionId) return;
    if (currentRouteSessionId) {
      router.pushParams({ sessionId: activeSessionId });
    } else {
      router.setParams({ sessionId: activeSessionId } as never);
    }
  }, [activeSessionId, router]);

  useEffect(() => {
    void (async () => {
      const storedAppLanguage = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
      const loaded = mapToAskPranaLanguageCode(
        storedAppLanguage || (await loadAskPranaPreferredLanguage()),
      );
      const allowed =
        loaded === "en" || loaded === "te" || loaded === "hi" ? loaded : "en";
      selectAskPranaLanguageWhenReady(allowed, (language) => {
        setPreferredLanguage(language);
        void setAppLanguage(language);
        void saveAskPranaPreferredLanguage(language, { explicit: true });
      });
    })();
  }, []);

  const requestContext = useMemo<AskPranaRequestContext>(
    () => ({
      pondId: null,
      cycleId: null,
      screen: pathname || "/ask-prana",
      mode: "generic",
      // The website language is for labels only. Each question chooses its own reply language.
      language: null,
      sessionLanguageCode: null,
      voiceModeLanguageLock: null,
    }),
    [
      pathname,
      preferredLanguage,
    ],
  );

  const suggestionQuestions = useMemo(
    () => [
      t("askPrana.suggestions.whatIsAquaculture"),
      t("askPrana.suggestions.typesOfAquaculture"),
      t("askPrana.suggestions.startAquaculture"),
      t("askPrana.suggestions.commonDiseases"),
      t("askPrana.suggestions.bestPractices"),
    ],
    [t],
  );

  const generationActive = thinkingKind != null || isSending;
  const showThinkingBubble = thinkingKind != null;
  // While the latest question asks for a file, say so instead of "Thinking...".
  const lastUserText = [...messages].reverse().find((message) => message.role === "user")?.text ?? "";
  const requestedFile = showThinkingBubble ? detectRequestedFileFormat(lastUserText) : null;
  const generatingFileLabel = requestedFile
    ? t(
        requestedFile === "xlsx"
          ? "askPrana.creatingExcelFile"
          : requestedFile === "pdf"
            ? "askPrana.creatingPdfDocument"
            : "askPrana.creatingWordDocument",
      )
    : null;
  const composerBusy =
    isSending || isRecording || isTranscribing || isLoadingMessages;
  const conversationMessages = messages.filter((message) => message.id !== "welcome");
  const isTranslatableMessage = (message: ChatMessage) =>
    Boolean(message.text?.trim()) &&
    !(message.messageType !== "text" && message.fileName && message.text === message.fileName);
  // Display copies only. Stored message.text stays in the language it was written.
  // Saved voice turns are included so a later website-language switch can show them.
  const translationSources = conversationMessages.flatMap((message) => [
    ...(isTranslatableMessage(message) && !message.streaming ? [message.text] : []),
    ...(message.transcript?.trim() ? [message.transcript] : []),
  ]).reverse();
  // Originals in `messages` are never modified; only the rendered copy changes.
  const { displayText: displayMessageText, contentPhase } =
    useAskPranaDisplayTranslation(translationSources, "visible", {
      // The source list is newest-first. Translate the active end of a chat
      // immediately; older turns continue through the shared background queue
      // rather than starving the latest reply or triggering API rate limits.
      priorityCount: 9,
      // The server stores every message in all three languages, so other
      // languages are read from the database on switch, not prefetched live.
      prefetchOtherLanguages: false,
    });
  // Stored translations normally arrive well under a second; only mention
  // translating when a visible message has really been waiting.
  const [showTranslatingBanner, setShowTranslatingBanner] = useState(false);
  useEffect(() => {
    if (contentPhase !== "loading") {
      setShowTranslatingBanner(false);
      return;
    }
    const timer = setTimeout(() => setShowTranslatingBanner(true), 2_000);
    return () => clearTimeout(timer);
  }, [contentPhase]);
  // Reuse the previous display object when a message's shown text is unchanged,
  // so the memoized bubbles only re-render for messages whose translation landed.
  const [displayMessageCache] = useState(
    () => new WeakMap<ChatMessage, { text: string; transcript: string | null | undefined; value: ChatMessage }>(),
  );
  const displayConversationMessages = useMemo(
    () =>
      conversationMessages.map((message) => {
        const text = message.streaming || !isTranslatableMessage(message)
          ? message.text
          : displayMessageText(message.text);
        const transcript = message.transcript?.trim()
          ? displayMessageText(message.transcript)
          : message.transcript;
        const cached = displayMessageCache.get(message);
        if (cached && cached.text === text && cached.transcript === transcript) return cached.value;
        const value = { ...message, text, transcript };
        displayMessageCache.set(message, { text, transcript, value });
        return value;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, displayMessageText, displayMessageCache],
  );
  // Voice recognition results are intentionally not added to `messages`.
  // This gives Voice Mode one right-aligned, existing-style user bubble that
  // updates in place until the regular voice submission inserts the saved turn.
  const renderedConversationMessages = useMemo(() => {
    const transcript = voiceLiveTranscript.trim();
    if (!transcript) return displayConversationMessages;

    const newestMessage = messages[messages.length - 1];
    if (
      newestMessage?.role === "user" &&
      newestMessage.text.trim() === transcript
    ) {
      return displayConversationMessages;
    }

    return [
      ...displayConversationMessages,
      {
        id: "voice-live-transcript",
        role: "user" as const,
        text: transcript,
        messageType: "text" as const,
      },
    ];
  }, [displayConversationMessages, messages, voiceLiveTranscript]);
  useEffect(() => {
    if (!attachmentMenuOpen || Platform.OS !== "web") return;
    if (typeof document === "undefined") return;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      const host =
        attachWrapRef.current as unknown as { contains?: (node: Node) => boolean } | null;
      const byId =
        typeof document.getElementById === "function"
          ? document.getElementById("ask-prana-attach-wrap")
          : null;
      const insideHost =
        host &&
        typeof host.contains === "function" &&
        target instanceof Node &&
        host.contains(target);
      const insideById =
        byId && target instanceof Node && byId.contains(target);
      if (insideHost || insideById) return;
      event.preventDefault();
      event.stopPropagation();
      setAttachmentMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [attachmentMenuOpen]);

  const sidebarVisible = sidebarOpen;
  const voiceInline = voiceModeOpen;
  messageCountRef.current = renderedConversationMessages.length;
  voiceInlineRef.current = voiceInline;
  const voiceActionsRef = useRef<{
    toggleMute: () => void;
    end: () => void;
    submitTyped: () => void;
  } | null>(null);
  const registerVoiceActions = useCallback(
    (actions: { toggleMute: () => void; end: () => void; submitTyped: () => void } | null) => {
      voiceActionsRef.current = actions;
    },
    [],
  );
  const [voiceMuted, setVoiceMuted] = useState(false);
  const canSend =
    generationActive ||
    (!isRecording &&
      !isTranscribing &&
      !pendingAttachments.some((attachment) => attachment.status !== "ready") &&
      (Boolean(draft.trim()) || pendingAttachments.some((attachment) => attachment.status === "ready")));

  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof window === "undefined" || !window.matchMedia) return;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const apply = () => setReducedMotion(query.matches);
      apply();
      query.addEventListener?.("change", apply);
      return () => query.removeEventListener?.("change", apply);
    }
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReducedMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }
    const shown = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const refreshScrollToLatestVisibility = useCallback(() => {
    const { contentHeight, viewportHeight } = listMetricsRef.current;
    const overflow = viewportHeight > 0 && contentHeight > viewportHeight + 1;
    const show =
      overflow &&
      !listNearBottomRef.current &&
      messageCountRef.current > 0 &&
      !voiceInlineRef.current;
    setShowScrollToLatest((current) => (current === show ? current : show));
  }, []);

  const followLatestContent = useCallback((animated: boolean) => {
    if (!listNearBottomRef.current || pendingOlderLoadRef.current) return;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  const readListScrollPosition = useCallback((
    event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    },
  ) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffset = listMetricsRef.current.offsetY;
    listMetricsRef.current.offsetY = contentOffset.y;
    listMetricsRef.current.contentHeight = contentSize.height;
    listMetricsRef.current.viewportHeight = layoutMeasurement.height;
    const overflow = contentSize.height > layoutMeasurement.height + 1;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nearBottom = !overflow || distanceFromBottom < NEAR_BOTTOM_DISTANCE;
    // Content growth keeps the existing follow choice. A real scroll, drag, or
    // fling is what moves the reader back to the latest message or away from it.
    if (!overflow || Math.abs(contentOffset.y - previousOffset) > 1) {
      listNearBottomRef.current = nearBottom;
    }
    refreshScrollToLatestVisibility();
  }, [refreshScrollToLatestVisibility]);

  const handleListContentSizeChange = useCallback((_width: number, height: number) => {
    const metrics = listMetricsRef.current;
    const previousHeight = metrics.contentHeight;
    const delta = height - previousHeight;
    metrics.contentHeight = height;
    if (pendingOlderLoadRef.current && previousHeight > 0 && delta > 1) {
      const nextOffset = Math.max(0, metrics.offsetY + delta);
      metrics.offsetY = nextOffset;
      listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
      refreshScrollToLatestVisibility();
      return;
    }
    followLatestContent(false);
    refreshScrollToLatestVisibility();
  }, [followLatestContent, refreshScrollToLatestVisibility]);

  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    listMetricsRef.current.viewportHeight = event.nativeEvent.layout.height;
    followLatestContent(false);
    refreshScrollToLatestVisibility();
  }, [followLatestContent, refreshScrollToLatestVisibility]);

  const scrollToLatestMessage = useCallback(() => {
    listNearBottomRef.current = true;
    pendingOlderLoadRef.current = false;
    setShowScrollToLatest(false);
    const animated = !reducedMotion;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!listNearBottomRef.current) return;
        listRef.current?.scrollToEnd({ animated });
      });
    });
  }, [reducedMotion]);

  const handleLoadOlderMessages = useCallback(() => {
    pendingOlderLoadRef.current = true;
    void loadOlderMessages().finally(() => {
      setTimeout(() => {
        pendingOlderLoadRef.current = false;
      }, 400);
    });
  }, [loadOlderMessages]);

  const previousScrollSessionRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousScrollSessionRef.current;
    previousScrollSessionRef.current = activeSessionId;
    if (previous === undefined || previous === activeSessionId) return;
    const switchedConversation = Boolean(previous) && Boolean(activeSessionId) && previous !== activeSessionId;
    const startedNewChat = Boolean(previous) && !activeSessionId;
    if (!switchedConversation && !startedNewChat) return;
    listNearBottomRef.current = true;
    pendingOlderLoadRef.current = false;
    listMetricsRef.current.offsetY = 0;
    setShowScrollToLatest(false);
  }, [activeSessionId]);

  useEffect(() => {
    refreshScrollToLatestVisibility();
  }, [refreshScrollToLatestVisibility, renderedConversationMessages.length, voiceInline]);

  const handleSend = (question: string) => {
    // The dictated words were sent as they are; drop the "wrong language?" row.
    if (uncertainDictationText) discardFailedRecording();
    void sendQuestion(question, requestContext);
  };

  const handleStartNewChat = () => {
    setEditingMessageId(null);
    setAttachmentMenuOpen(false);
    setAttachmentPreview(null);
    setDraftEditorOpen(false);
    void startNewConversation();
    router.setParams({ sessionId: undefined } as never);
  };

  const handleBeginEditUserMessage = useCallback((messageId: string) => {
    if (isSending || isRecording || isTranscribing) {
      return;
    }
    setEditingMessageId(messageId);
  }, [isSending, isRecording, isTranscribing]);

  const handleCancelEditUserMessage = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleSubmitEditUserMessage = useCallback(
    (messageId: string, text: string) => {
      if (isSending || isRecording || isTranscribing) {
        return;
      }
      setEditingMessageId(null);
      void editAndResendUserMessage(messageId, text, requestContext);
    },
    [
      editAndResendUserMessage,
      isRecording,
      isSending,
      isTranscribing,
      requestContext,
    ],
  );

  const handleRegenerateAssistantMessage = useCallback(
    (assistantMessageId: string) => {
      if (isSending || isRecording || isTranscribing) {
        return;
      }

      const assistantIndex = messages.findIndex(
        (item) => item.id === assistantMessageId,
      );
      if (assistantIndex < 0) {
        return;
      }

      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        if (candidate.role !== "user") {
          continue;
        }

        const text =
          candidate.messageType === "audio"
            ? candidate.transcript?.trim() ||
              (candidate.text?.trim() &&
              !candidate.text.includes("://") &&
              !candidate.text.startsWith("file:")
                ? candidate.text.trim()
                : "")
            : candidate.text?.trim() || "";

        if (!text) {
          Alert.alert(t("askPrana.cannotRegenerate"), t("askPrana.noQuestionToRegenerate"));
          return;
        }

        void sendQuestion(text, requestContext);
        return;
      }

      Alert.alert(t("askPrana.cannotRegenerate"), t("askPrana.noEarlierQuestion"));
    },
    [
      isSending,
      isRecording,
      isTranscribing,
      messages,
      sendQuestion,
      requestContext,
      t,
    ],
  );

  const handleComposerAction = () => {
    if (generationActive) {
      stopGeneration();
      return;
    }
    handleSend(draft);
  };

  const handleComposerEnter = () => {
    if (
      composerEnterSubmitLockRef.current ||
      !canSend ||
      isRecording ||
      isTranscribing
    ) {
      return;
    }

    composerEnterSubmitLockRef.current = true;
    handleComposerAction();
    setTimeout(() => {
      composerEnterSubmitLockRef.current = false;
    }, 250);
  };

  const handleMicPress = () => {
    if (isTranscribing || voiceModeOpen) {
      return;
    }
    if (isRecording) {
      // Dictate into composer for review — never auto-send.
      failedRecordingIntentRef.current = "composer";
      void stopAudioRecordingToComposer();
      return;
    }
    discardFailedRecording();
    void startAudioRecording({ source: "composer" });
  };

  const handleStopDictation = () => {
    if (!isRecording || isTranscribing) {
      return;
    }
    failedRecordingIntentRef.current = "composer";
    void stopAudioRecordingToComposer();
  };

  // Draft is read-only while recording, so the press-time draft is current.
  const sendWithTranscript = (transcript: string) => {
    const existing = draft.trim();
    handleSend(existing ? `${existing} ${transcript}` : transcript);
  };

  const handleSendDictation = async () => {
    if (!isRecording || isTranscribing || isSending) {
      return;
    }
    failedRecordingIntentRef.current = "send";
    const transcript = await stopAudioRecordingToTranscript();
    if (transcript) sendWithTranscript(transcript);
  };

  const handleRetryFailedRecording = async () => {
    const transcript = await retryFailedRecording();
    if (!transcript) return;
    if (failedRecordingIntentRef.current === "send") {
      sendWithTranscript(transcript);
      return;
    }
    const existing = draft.trim();
    setDraft(existing ? `${existing} ${transcript}` : transcript);
  };

  const handleCancelDictation = () => {
    if (!isRecording && !isTranscribing) {
      return;
    }
    void cancelAudioRecording();
  };

  const handleReadAloud = useCallback(
    (text: string) => {
      void (async () => {
        const result = await speakAskPranaText(text, languageForQuestionText(text) ?? "en");
        if (!result.spoke && result.reason) {
          Alert.alert(t("askPrana.speechUnavailable"), result.reason);
        }
      })();
    },
    [t],
  );

  const handleSelectLanguage = useCallback(
    (code: AskPranaSpeechLanguageCode) => {
      const allowed =
        code === "en" || code === "te" || code === "hi" ? code : "en";
      // The click only selects a cache. Static labels and chat text swap
      // together once every visible string is already translated.
      selectAskPranaLanguageWhenReady(allowed, (language) => {
        setPreferredLanguage(language);
        void setAppLanguage(language);
        void saveAskPranaPreferredLanguage(language, { explicit: true });
      });
      setLanguagePickerOpen(false);
    },
    [],
  );

  const handleBack = useCallback(() => {
    if (sidebarOpen && !isDesktop) {
      setSidebarOpen(false);
      return;
    }
    if (editingMessageId) {
      setEditingMessageId(null);
      return;
    }
    if (voiceModeOpen) {
      setVoiceModeOpen(false);
      void stopAskPranaSpeech();
      void cancelAudioRecording();
      return;
    }
    if (isRecording || isTranscribing) {
      void cancelAudioRecording();
      return;
    }
    if (languagePickerOpen) {
      setLanguagePickerOpen(false);
      return;
    }
    if (attachmentMenuOpen) {
      setAttachmentMenuOpen(false);
      return;
    }

    const previous = getPreviousRouteName(navigation.getState() as NavStateLike);
    if (router.canGoBack() && previous && !isAuthOnboardingRoute(previous)) {
      router.back();
      return;
    }
    router.replace("/ask-prana" as never);
  }, [
    attachmentMenuOpen,
    cancelAudioRecording,
    editingMessageId,
    isDesktop,
    isRecording,
    isTranscribing,
    languagePickerOpen,
    navigation,
    router,
    sidebarOpen,
    voiceModeOpen,
  ]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        void stopAskPranaSpeech();
        // Do NOT cancel dictation here — Expo web remounts/focus flickers cancel
        // mid-recording and leave an empty composer. Pond switch + AppState
        // background + Back already cancel safely.
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          handleBack();
          return true;
        },
      );
      return () => subscription.remove();
    }, [handleBack]),
  );

  const placeholder = t("askPrana.messagePlaceholder");

  const updateComposerInputHeight = useCallback((height: number) => {
    const next = clampComposerInputHeight(height, composerInputMaxHeight);
    setComposerInputHeight((current) => (current === next ? current : next));
  }, [composerInputMaxHeight]);

  useEffect(() => {
    // Speech and pasted/programmatic controlled values do not consistently
    // trigger onContentSizeChange on React Native Web. Defer one frame so a
    // native content measurement can win; otherwise use the stable estimate.
    measuredDraftRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (!draft) {
        measuredDraftRef.current = draft;
        updateComposerInputHeight(COMPOSER_INPUT_MIN_HEIGHT);
        return;
      }
      if (Platform.OS === "web") {
        const nativeRef = (composerInputRef.current as WebTextInputRef | null)
          ?.getNativeRef?.();
        const actualHeight = nativeRef?.scrollHeight;
        if (typeof actualHeight === "number" && actualHeight > 0) {
          measuredDraftRef.current = draft;
          updateComposerInputHeight(actualHeight);
          return;
        }
      }
      if (measuredDraftRef.current !== draft) {
        updateComposerInputHeight(
          estimateComposerInputHeight(
            draft,
            composerInputWidth,
            composerInputMaxHeight,
            isDesktop ? DESKTOP_COMPOSER_METRICS : MOBILE_COMPOSER_METRICS,
          ),
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputMaxHeight, composerInputWidth, draft, isDesktop, updateComposerInputHeight]);

  const handleComposerContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      measuredDraftRef.current = draft;
      updateComposerInputHeight(event.nativeEvent.contentSize.height);
    },
    [draft, updateComposerInputHeight],
  );

  const handleComposerInputLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = Math.round(event.nativeEvent.layout.width);
      setComposerInputWidth((current) => (current === width ? current : width));
    },
    [],
  );

  const handleScreenLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    setComposerViewportHeight((current) => (current === height ? current : height));
  }, []);

  const handleDraftSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const selection = event.nativeEvent.selection;
      setDraftSelection((current) =>
        current.start === selection.start && current.end === selection.end
          ? current
          : selection,
      );
    },
    [],
  );

  const handleCompactSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setCompactSelection(null);
      handleDraftSelectionChange(event);
    },
    [handleDraftSelectionChange],
  );

  const collapseDraftEditor = useCallback(() => {
    // The compact input receives this through its supported `selection` prop
    // after the modal unmounts. Do not imperatively mutate a web TextInput ref.
    setCompactSelection(draftSelection);
    setDraftEditorOpen(false);
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }, [draftSelection]);

  const canExpandDraft =
    Boolean(draft.trim()) && composerInputHeight >= composerInputMaxHeight;
  const composerAtMaxHeight = composerInputHeight >= composerInputMaxHeight;

  return (
    <SafeAreaView style={[styles.safeArea, !isDesktop && styles.safeAreaMobile]} edges={["top"]}>
      <StatusBar
        barStyle={isDesktop ? "dark-content" : "light-content"}
        backgroundColor={isDesktop ? prana.desktopHeader : prana.tealDeep}
      />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === "ios" ? "padding" : "padding"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <View style={styles.screen} onLayout={handleScreenLayout}>
          <View style={styles.appLayout}>
            <AskPranaChatSidebar
              visible={sidebarVisible}
              isDesktop={isDesktop}
              onClose={() => setSidebarOpen(false)}
              onNewChat={handleStartNewChat}
              onConversationDeleted={() =>
                router.setParams({ sessionId: undefined } as never)
              }
            />
            <View style={styles.chatArea}>
          <PranaHeader
            variant={isDesktop ? "light" : "teal"}
            includeTopInset={false}
            subtitle={t("askPrana.yourAquacultureAssistant")}
            left={
              !sidebarOpen ? (
                <PranaHeaderButton
                  icon="menu"
                  tone={isDesktop ? "light" : "dark"}
                  onPress={() => setSidebarOpen(true)}
                  label={t("askPrana.openHistory")}
                />
              ) : isDesktop ? null : (
                <View style={styles.headerSpacer} />
              )
            }
            right={
              // preferredLanguage is set together with i18next in handleSelectLanguage and on load.
              <PranaLanguageButton
                tone={isDesktop ? "light" : "dark"}
                label={LANGUAGE_SHORT_LABELS[preferredLanguage]}
                onPress={() => setLanguagePickerOpen(true)}
                accessibilityLabel={`${t("askPrana.language")}: ${getAskPranaLanguageOption(preferredLanguage).llmLabel}`}
              />
            }
          />


          <View style={styles.messageColumn}>
          {contentPhase === "loading" && showTranslatingBanner ? (
            <Text style={styles.translationBanner}>{t("askPrana.translating")}</Text>
          ) : contentPhase === "error" ? (
            <Pressable onPress={() => retryAskPranaVisibleTranslations()} accessibilityRole="button">
              <Text style={styles.translationBanner}>{t("askPrana.translationUnavailable")}</Text>
            </Pressable>
          ) : null}
          {isLoadingMessages ? (
            <View style={styles.loadingState}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : (
            <>
            <FlatList
              ref={listRef}
              style={[
                styles.chatList,
                Platform.OS === "web"
                  ? ({ overflowAnchor: "none" } as unknown as ViewStyle)
                  : null,
              ]}
              data={renderedConversationMessages}
              keyExtractor={(item) => item.id}
              contentContainerStyle={[
                styles.chatContent,
                voiceInline && !isDesktop && styles.chatContentWithVoiceDock,
                voiceInline && isDesktop && styles.chatContentDesktopVoice,
              ]}
              showsVerticalScrollIndicator={false}
              onScroll={readListScrollPosition}
              onMomentumScrollEnd={readListScrollPosition}
              onScrollEndDrag={readListScrollPosition}
              onContentSizeChange={handleListContentSizeChange}
              onLayout={handleListLayout}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                activeSessionId && hasOlderMessages ? (
                  <Pressable
                    onPress={handleLoadOlderMessages}
                    disabled={isLoadingOlder}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.loadEarlierMessages")}
                    style={styles.loadingState}
                  >
                    {isLoadingOlder ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={styles.emptyChatCopy}>{t("askPrana.loadEarlierMessages")}</Text>
                    )}
                  </Pressable>
                ) : null
              }
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <PranaBrand
                    color={prana.ink}
                    iconSize={isDesktop ? 48 : 29}
                    wordSize={isDesktop ? 46 : 29}
                    subtitle={null}
                  />
                  <Text style={[styles.emptyChatSubtitle, isDesktop && styles.emptyChatSubtitleDesktop]}>
                    {t("askPrana.yourAquacultureAssistant")}
                  </Text>
                  <Text style={[styles.emptyChatCopy, isDesktop && styles.emptyChatCopyDesktop]}>
                    {t("askPrana.emptyChatDescription")}
                  </Text>
                </View>
              }
              ListFooterComponent={
                showThinkingBubble ? (
                  <AskPranaThinkingBubble kind={thinkingKind ?? "text"} label={generatingFileLabel} />
                ) : generationStopped ? (
                  <View style={styles.stoppedStatusWrap}>
                    <View style={styles.stoppedStatusBadge}>
                      <Text style={styles.stoppedStatus}>{t("askPrana.stoppedGenerating")}</Text>
                    </View>
                  </View>
                ) : null
              }
              renderItem={({ item }) => (
                <AskPranaChatMessageBubble
                  key={`${item.id}:${editingMessageId === item.id ? "editing" : "normal"}`}
                  message={item}
                  isEditingUserMessage={editingMessageId === item.id}
                  onBeginEditUserMessage={handleBeginEditUserMessage}
                  onCancelEditUserMessage={handleCancelEditUserMessage}
                  onSubmitEditUserMessage={handleSubmitEditUserMessage}
                  editDisabled={
                    generationActive || isRecording || isTranscribing || isSending
                  }
                  onRegenerateAssistantMessage={handleRegenerateAssistantMessage}
                  regenerateDisabled={generationActive || isRecording || isTranscribing}
                  onReadAloud={handleReadAloud}
                />
              )}
            />
            {showScrollToLatest && !voiceInline ? (
              <View pointerEvents="box-none" style={styles.scrollToLatestHost}>
                <Pressable
                  onPress={scrollToLatestMessage}
                  onFocus={() => setScrollToLatestFocused(true)}
                  onBlur={() => setScrollToLatestFocused(false)}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.scrollToLatest")}
                  style={({ pressed }) => [
                    styles.scrollToLatestButton,
                    pressed && styles.pressed,
                    scrollToLatestFocused && styles.scrollToLatestButtonFocused,
                  ]}
                >
                  <Feather name="chevron-down" size={22} color={colors.textDark} />
                </Pressable>
              </View>
            ) : null}
            </>
          )}
          {voiceInline && REALTIME_VOICE_ENABLED ? (
            <AskPranaRealtimeVoice
              visible={voiceModeOpen}
              variant={isDesktop ? "overlay" : "screen"}
              draft={draft}
              onChangeDraft={setDraft}
              onClose={() => {
                setVoiceModeOpen(false);
                setVoiceMuted(false);
              }}
              getHistory={getRecentVoiceHistory}
              onUserText={(text) => recordRealtimeVoiceMessage("user", text)}
              onAssistantText={(text) => recordRealtimeVoiceMessage("assistant", text)}
              onMutedChange={setVoiceMuted}
              onRegisterActions={registerVoiceActions}
            />
          ) : voiceInline ? (
            <AskPranaVoiceModeModal
              visible={voiceModeOpen}
                variant={isDesktop ? "overlay" : "screen"}
              language={preferredLanguage}
              requestContext={requestContext}
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              audioLevel={voiceAudioLevel}
              isSending={isSending}
              draft={draft}
              onChangeDraft={setDraft}
              onClose={() => {
                setVoiceModeOpen(false);
                setVoiceMuted(false);
                void stopAskPranaSpeech();
                void cancelAudioRecording();
              }}
              onStartListening={(language) =>
                startAudioRecording({ source: "voice", throwOnFailure: true, language })
              }
              onClearLiveTranscript={clearVoiceLiveTranscript}
              onCancelListening={cancelAudioRecording}
              onStopListeningToTranscript={stopVoiceListening}
              onAsk={async (question, context, handlers) => askFromVoiceMode(question, context, handlers)}
              onLanguageChange={async () => {
                // Recognition mode is not the website language.
              }}
              onMutedChange={setVoiceMuted}
              onRegisterActions={registerVoiceActions}
              onCancelAsk={stopGeneration}
            />
          ) : null}
          </View>

          {editingMessageId ? null : (
          <View style={[styles.composerArea, isDesktop && styles.composerAreaDesktop]}>
            {conversationMessages.length === 0 && !voiceInline ? (
              <ScrollView
                style={styles.suggestionsScroll}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.suggestionsRow}
              >
                {suggestionQuestions.map((question) => (
                  <Pressable
                    key={question}
                    onPress={() => handleSend(question)}
                    disabled={composerBusy}
                    style={({ pressed }) => [
                      styles.suggestionChip,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.suggestionText}>{question}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            {attachmentError ? (
              <Text style={styles.attachmentError}>{attachmentError}</Text>
            ) : null}

            {(isRecording || isTranscribing) && !voiceModeOpen ? (
            // Dictation pill. After Stop it stays on screen with the captured
            // waveform and a spinner until the words land in the box.
            <View style={styles.inputRow}>
              <View style={[styles.inputShell, styles.inputShellDesktop, styles.recordingShell]}>
                <Pressable
                  onPress={handleCancelDictation}
                  style={({ pressed }) => [
                    styles.recordingCircleButton,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.cancelRecording")}
                >
                  <Feather name="x" size={18} color={colors.white} />
                </Pressable>
                <AskPranaRecordingWaveform
                  level={isRecording ? voiceAudioLevel : 0}
                  quietColor="rgba(255,255,255,0.35)"
                  activeColor={colors.white}
                  frozen={!isRecording}
                />
                {isRecording ? (
                  <>
                    <Text style={styles.recordingTimer}>{recordingTimerLabel}</Text>
                    <Pressable
                      onPress={handleStopDictation}
                      style={({ pressed }) => [
                        styles.recordingCircleButton,
                        styles.recordingStopCircle,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={t("askPrana.stopRecording")}
                    >
                      <View style={styles.recordingStopSquare} />
                    </Pressable>
                  </>
                ) : (
                  <View
                    style={styles.recordingCircleButton}
                    accessibilityRole="progressbar"
                    accessibilityLabel={t("askPrana.transcribingHint")}
                  >
                    <ActivityIndicator size="small" color={colors.white} />
                  </View>
                )}
                <Pressable
                  onPress={() => { void handleSendDictation(); }}
                  disabled={isSending || !isRecording}
                  style={({ pressed }) => [
                    styles.sendButton,
                    styles.recordingSendButton,
                    (isSending || !isRecording) && styles.sendButtonDisabled,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.send")}
                >
                  <Feather name="arrow-up" size={18} color={colors.white} />
                </Pressable>
              </View>
            </View>
            ) : (
            <View style={[
              styles.inputRow,
              isMobileComposer && !voiceInline && styles.inputRowMobileComposer,
              voiceInline && styles.inputRowVoice,
            ]}>
              {voiceInline || isMobileComposer ? null : (
                <View
                  ref={attachWrapRef}
                  nativeID="ask-prana-attach-wrap"
                  style={[
                    styles.attachWrap,
                    isMobileComposer && styles.attachWrapMobileComposer,
                  ]}
                >
                  <Pressable
                    onPress={() => setAttachmentMenuOpen((open) => !open)}
                    disabled={composerBusy}
                    style={({ pressed }) => [
                      styles.attachButton,
                      isMobileComposer && styles.attachButtonMobileComposer,
                      isDesktop && styles.attachButtonDesktop,
                      attachmentMenuOpen && styles.attachButtonOpen,
                      composerBusy && styles.sendButtonDisabled,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.attach")}
                    accessibilityState={{ expanded: attachmentMenuOpen }}
                  >
                    <Feather name="paperclip" size={19} color="#397F6E" />
                    <Text style={styles.tileLabel}>{t("askPrana.attachShort")}</Text>
                  </Pressable>
                  {attachmentMenuOpen ? (
                    <View style={styles.attachMenu}>
                      <Pressable
                        onPress={() => {
                          setAttachmentMenuOpen(false);
                          void sendImageAttachment(requestContext, "gallery");
                        }}
                        style={styles.attachMenuItem}
                      >
                        <Feather name="image" size={16} color={colors.textDark} />
                        <Text style={styles.attachMenuText}>{t("askPrana.addImage")}</Text>
                      </Pressable>
                      {isDesktop ? null : (
                        // Phones/tablets: open the camera directly. Desktop
                        // browsers have no camera capture for file inputs.
                        <Pressable
                          onPress={() => {
                            setAttachmentMenuOpen(false);
                            void sendImageAttachment(requestContext, "camera");
                          }}
                          style={styles.attachMenuItem}
                        >
                          <Feather name="camera" size={16} color={colors.textDark} />
                          <Text style={styles.attachMenuText}>{t("askPrana.takePhoto")}</Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={() => {
                          setAttachmentMenuOpen(false);
                          void sendDocumentAttachment(requestContext);
                        }}
                        style={styles.attachMenuItem}
                      >
                        <Feather name="file" size={16} color={colors.textDark} />
                        <Text style={styles.attachMenuText}>{t("askPrana.addFile")}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              )}
              <View style={[
                styles.inputShell,
                isMobileComposer && !voiceInline && styles.inputShellMobileComposer,
                isDesktop && styles.inputShellDesktop,
                voiceInline && styles.inputShellVoice,
              ]}>
                {pendingAttachments.length > 0 ? (
                  <ScrollView
                    style={styles.pendingScroll}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.pendingRow}
                  >
                    {pendingAttachments.map((item) => {
                      const previewUri = item.localUri ?? item.fileUrl;
                      const isImage = item.kind === "image";
                      const isPreparing = item.status === "preparing";
                      const nameParts = splitAttachmentFileName(item.fileName);
                      return (
                        <View key={item.id} style={styles.pendingChip}>
                          {isImage && previewUri ? (
                            <Pressable
                              onPress={() => setAttachmentPreview({ uri: previewUri, fileName: item.fileName, mimeType: item.mimeType })}
                              style={styles.pendingPreviewPressable}
                              accessibilityRole="imagebutton"
                              accessibilityLabel={`Open selected image ${item.fileName}`}
                            >
                              <Image source={{ uri: previewUri }} style={styles.pendingImage} contentFit="cover" />
                              {isPreparing ? <View style={styles.pendingLoading}><ActivityIndicator size="small" color={colors.white} /></View> : null}
                            </Pressable>
                          ) : (
                            <View style={styles.pendingFile}>
                              <Feather name="file-text" size={16} color={colors.primary} />
                              <View style={styles.pendingFileDetails}>
                                <View
                                  style={styles.pendingFileNameRow}
                                  {...(Platform.OS === "web"
                                    ? ({ title: item.fileName } as { title: string })
                                    : {})}
                                >
                                  <Text style={styles.pendingFileName} numberOfLines={1}>
                                    {nameParts.base}
                                  </Text>
                                  {nameParts.extension ? (
                                    <Text style={styles.pendingFileExt}>{nameParts.extension}</Text>
                                  ) : null}
                                </View>
                                <Text style={styles.pendingFileMeta} numberOfLines={1}>
                                  {(item.mimeType.split("/").pop() ?? "file").toUpperCase()}{item.fileSize ? ` · ${(item.fileSize / 1024).toFixed(item.fileSize >= 1024 * 1024 ? 1 : 0)} ${item.fileSize >= 1024 * 1024 ? "MB" : "KB"}` : ""}
                                </Text>
                              </View>
                              {isPreparing ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                            </View>
                          )}
                          {item.status === "failed" ? (
                            <Pressable onPress={() => retryPendingAttachment(item.id)} style={styles.pendingRetry} accessibilityRole="button" accessibilityLabel={`Retry ${item.fileName}`}>
                              <Feather name="refresh-cw" size={11} color={colors.white} />
                            </Pressable>
                          ) : null}
                          <Pressable
                            onPress={() => removePendingAttachment(item.id)}
                            style={styles.pendingRemove}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${item.fileName}`}
                          >
                            <Feather name="x" size={16} color={colors.white} />
                          </Pressable>
                          {item.status === "failed" && item.error ? <Text style={styles.pendingItemError} numberOfLines={2}>{item.error}</Text> : null}
                        </View>
                      );
                    })}
                  </ScrollView>
                ) : null}
                <View style={styles.composerControls}>
                <TextInput
                  ref={composerInputRef}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={voiceInline ? "Type" : placeholder}
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.textInput,
                    !isDesktop && styles.textInputMobile,
                    isMobileComposer && !voiceInline && styles.textInputMobileComposer,
                    composerAtMaxHeight
                      ? styles.textInputScrollable
                      : styles.textInputAutoGrowing,
                    {
                      height: isDesktop
                        ? composerInputHeight
                        : composerInputHeight > COMPOSER_INPUT_MIN_HEIGHT
                          ? composerInputHeight
                          : Math.min(
                              composerInputMaxHeight,
                              Math.max(
                                22,
                                (draft || placeholder).split("\n").reduce(
                                  (total, line) =>
                                    total +
                                    Math.max(
                                      1,
                                      Math.ceil(
                                        line.length /
                                          Math.max(
                                            16,
                                            // ~9 px per character at the 16 px phone font size.
                                            Math.floor((composerInputWidth || 220) / 9),
                                          ),
                                      ),
                                    ),
                                  0,
                                ) * 22,
                              ),
                            ),
                      maxHeight: composerInputMaxHeight,
                    },
                  ]}
                  onLayout={handleComposerInputLayout}
                  selection={compactSelection ?? undefined}
                  onSelectionChange={handleCompactSelectionChange}
                  editable={!isRecording}
                  multiline
                  textAlignVertical={isDesktop || isMobileComposer ? "top" : "center"}
                  blurOnSubmit={false}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => {
                    if (voiceInline) {
                      voiceActionsRef.current?.submitTyped();
                      return;
                    }
                    handleComposerEnter();
                  }}
                  onKeyPress={(event) => {
                    if (event.nativeEvent.key !== "Enter") return;
                    event.preventDefault();
                    if (voiceInline) {
                      voiceActionsRef.current?.submitTyped();
                      return;
                    }
                    handleComposerEnter();
                  }}
                  enablesReturnKeyAutomatically
                  scrollEnabled={composerAtMaxHeight}
                  onContentSizeChange={handleComposerContentSizeChange}
                />
                {voiceInline || isMobileComposer ? null : (
                <Pressable
                  onPress={handleMicPress}
                  disabled={
                    voiceModeOpen ||
                    isTranscribing ||
                    (composerBusy && !isRecording)
                  }
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.micButton,
                    isMobileComposer && styles.micButtonMobileComposer,
                    isRecording && styles.micButtonActive,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isRecording
                      ? t("askPrana.stopRecording")
                      : t("askPrana.recordAudio")
                  }
                >
                  <Feather
                    name={isRecording ? "square" : "mic"}
                    size={isRecording ? 14 : 17}
                    color={isRecording ? colors.white : "#538478"}
                  />
                  <Text style={[styles.dictateLabel, isRecording && { color: colors.white }]}>
                    {t("askPrana.dictateShort")}
                  </Text>
                </Pressable>
                )}
                </View>
              </View>
              {voiceInline || isMobileComposer ? null : (
                <Pressable
                  onPress={() => {
                    if (isRecording || isTranscribing || composerBusy) return;
                    prepareVoiceModeSession();
                    setVoiceModeOpen(true);
                  }}
                  disabled={composerBusy || isRecording || isTranscribing}
                  style={({ pressed }) => [
                    styles.voiceTile,
                    isMobileComposer && styles.voiceTileMobileComposer,
                    isDesktop && styles.voiceTileDesktop,
                    (composerBusy || isRecording || isTranscribing) && styles.sendButtonDisabled,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.startVoiceConversation")}
                >
                  <AskPranaVoiceWaveformIcon size={18} color="#397C6A" />
                  <Text style={styles.tileLabel} numberOfLines={1}>{t("askPrana.voiceChat")}</Text>
                </Pressable>
              )}
              {voiceInline || isMobileComposer ? null : (
                <Pressable
                  onPress={handleComposerAction}
                  disabled={!canSend || isRecording || isTranscribing}
                  style={({ pressed }) => [
                    styles.sendButton,
                    pranaGradientStyle,
                    isMobileComposer && styles.sendButtonMobileComposer,
                    isDesktop && styles.sendButtonDesktop,
                    (!canSend || isRecording || isTranscribing) && styles.sendButtonDisabled,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={generationActive ? t("askPrana.stopGenerating") : t("askPrana.send")}
                >
                  {generationActive ? (
                    <View style={styles.stopIcon} />
                  ) : (
                    <Feather name="send" size={19} color={colors.white} />
                  )}
                  <Text style={[styles.tileLabel, styles.tileLabelOnTeal]}>
                    {generationActive ? t("askPrana.stopShort") : t("askPrana.sendShort")}
                  </Text>
                </Pressable>
              )}
              {isMobileComposer && !voiceInline ? (
                <View style={styles.mobileComposerToolbar}>
                  <View
                    ref={attachWrapRef}
                    nativeID="ask-prana-attach-wrap"
                    style={styles.attachWrap}
                  >
                    <Pressable
                      onPress={() => setAttachmentMenuOpen((open) => !open)}
                      disabled={composerBusy}
                      style={({ pressed }) => [
                        styles.attachButton,
                        styles.attachButtonMobileComposer,
                        attachmentMenuOpen && styles.attachButtonOpen,
                        composerBusy && styles.sendButtonDisabled,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={t("askPrana.attach")}
                      accessibilityState={{ expanded: attachmentMenuOpen }}
                    >
                      <Feather name="paperclip" size={19} color="#397F6E" />
                      <Text style={styles.tileLabel}>{t("askPrana.attachShort")}</Text>
                    </Pressable>
                    {attachmentMenuOpen ? (
                      <View style={styles.attachMenu}>
                        <Pressable
                          onPress={() => {
                            setAttachmentMenuOpen(false);
                            void sendImageAttachment(requestContext, "gallery");
                          }}
                          style={styles.attachMenuItem}
                        >
                          <Feather name="image" size={16} color={colors.textDark} />
                          <Text style={styles.attachMenuText}>{t("askPrana.addImage")}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setAttachmentMenuOpen(false);
                            void sendImageAttachment(requestContext, "camera");
                          }}
                          style={styles.attachMenuItem}
                        >
                          <Feather name="camera" size={16} color={colors.textDark} />
                          <Text style={styles.attachMenuText}>{t("askPrana.takePhoto")}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setAttachmentMenuOpen(false);
                            void sendDocumentAttachment(requestContext);
                          }}
                          style={styles.attachMenuItem}
                        >
                          <Feather name="file" size={16} color={colors.textDark} />
                          <Text style={styles.attachMenuText}>{t("askPrana.addFile")}</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.mobileComposerToolbarActions}>
                    <Pressable
                      onPress={handleMicPress}
                      disabled={voiceModeOpen || isTranscribing || (composerBusy && !isRecording)}
                      hitSlop={6}
                      style={({ pressed }) => [
                        styles.micButton,
                        styles.micButtonMobileComposer,
                        isRecording && styles.micButtonActive,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={isRecording ? t("askPrana.stopRecording") : t("askPrana.recordAudio")}
                    >
                      <Feather name={isRecording ? "square" : "mic"} size={isRecording ? 14 : 17} color={isRecording ? colors.white : "#538478"} />
                      <Text style={[styles.dictateLabel, isRecording && { color: colors.white }]}>{t("askPrana.dictateShort")}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        if (isRecording || isTranscribing || composerBusy) return;
                        prepareVoiceModeSession();
                        setVoiceModeOpen(true);
                      }}
                      disabled={composerBusy || isRecording || isTranscribing}
                      style={({ pressed }) => [
                        styles.voiceTile,
                        styles.voiceTileMobileComposer,
                        (composerBusy || isRecording || isTranscribing) && styles.sendButtonDisabled,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={t("askPrana.startVoiceConversation")}
                    >
                      <AskPranaVoiceWaveformIcon size={18} color="#397C6A" />
                      <Text style={styles.tileLabel} numberOfLines={1}>{t("askPrana.voiceChat")}</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleComposerAction}
                      disabled={!canSend || isRecording || isTranscribing}
                      style={({ pressed }) => [
                        styles.sendButton,
                        pranaGradientStyle,
                        styles.sendButtonMobileComposer,
                        (!canSend || isRecording || isTranscribing) && styles.sendButtonDisabled,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={generationActive ? t("askPrana.stopGenerating") : t("askPrana.send")}
                    >
                      {generationActive ? <View style={styles.stopIcon} /> : <Feather name="send" size={19} color={colors.white} />}
                      <Text style={[styles.tileLabel, styles.tileLabelOnTeal]}>{generationActive ? t("askPrana.stopShort") : t("askPrana.sendShort")}</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {voiceInline ? (
                <>
                  <Pressable
                    onPress={() => voiceActionsRef.current?.toggleMute()}
                    style={styles.voiceMuteButton}
                    accessibilityRole="button"
                    accessibilityLabel={voiceMuted ? "Unmute" : "Mute"}
                  >
                    <Feather name={voiceMuted ? "mic" : "mic-off"} size={18} color={colors.white} />
                  </Pressable>
                  <Pressable
                    onPress={() => voiceActionsRef.current?.end()}
                    style={styles.voiceCloseButton}
                    accessibilityRole="button"
                    accessibilityLabel="End voice"
                  >
                    <Feather name="x" size={20} color="#111111" />
                  </Pressable>
                </>
              ) : null}
            </View>
            )}

              {canExpandDraft ? (
                <View style={styles.composerSecondaryActions}>
                <Pressable
                  onPress={() => setDraftEditorOpen(true)}
                  style={({ pressed }) => [
                    styles.expandDraftButton,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t("askPrana.expandMessage")}
                >
                  <Feather name="maximize-2" size={16} color={colors.primary} />
                  <Text style={styles.expandDraftText}>{t("askPrana.expandMessage")}</Text>
                </Pressable>
                </View>
              ) : null}

            {isTranscribing ? (
              // Composer dictation shows its loading state in the pill above.
              voiceModeOpen ? (
                <Text style={styles.recordingHint}>
                  {t("askPrana.transcribingHint")}
                </Text>
              ) : null
            ) : hasFailedRecording && !isRecording && !voiceInline ? (
              <View style={styles.failedRecordingRow}>
                <Text style={styles.failedRecordingText}>
                  {needsDictationLanguage
                    ? uncertainDictationText
                      ? "Words not right? Choose the language you spoke:"
                      : "Choose English, Telugu, or Hindi, or say it again."
                    : "Voice message couldn't be processed."}
                </Text>
                {needsDictationLanguage ? (
                  <>
                    {([
                      ["en", "English"],
                      ["te", "Telugu"],
                      ["hi", "Hindi"],
                    ] as const).map(([code, label]) => (
                      <Pressable
                        key={code}
                        onPress={() => {
                          void (async () => {
                            const shown = uncertainDictationText;
                            const transcript = await retryFailedRecording(code);
                            if (!transcript) return;
                            // Replace the words already shown for this recording.
                            if (shown && draft.includes(shown)) {
                              setDraft(draft.replace(shown, transcript));
                              return;
                            }
                            const existing = draft.trim();
                            setDraft(existing ? `${existing} ${transcript}` : transcript);
                          })();
                        }}
                        disabled={isSending}
                        style={({ pressed }) => [styles.failedRecordingAction, pressed && styles.pressed]}
                        accessibilityRole="button"
                        accessibilityLabel={`Transcribe in ${label}`}
                      >
                        <Text style={styles.failedRecordingRetryText}>{label}</Text>
                      </Pressable>
                    ))}
                  </>
                ) : (
                  <Pressable
                    onPress={() => { void handleRetryFailedRecording(); }}
                    disabled={isSending}
                    style={({ pressed }) => [styles.failedRecordingAction, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Retry voice message"
                  >
                    <Text style={styles.failedRecordingRetryText}>Retry</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={discardFailedRecording}
                  style={({ pressed }) => [styles.failedRecordingAction, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={uncertainDictationText ? "Keep the dictated text" : "Discard voice message"}
                >
                  <Text style={styles.failedRecordingDiscardText}>
                    {uncertainDictationText ? "Keep" : "Discard"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {voiceInline || isMobileComposer ? null : (
              <Text style={styles.composerNote}>{t("askPrana.composerNote")}</Text>
            )}
          </View>
          )}

            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={languagePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setLanguagePickerOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setLanguagePickerOpen(false)}
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t("askPrana.preferredLanguage")}</Text>
            <ScrollView style={styles.pondSelectorList}>
              {ASK_PRANA_LANGUAGE_OPTIONS.map((option) => {
                const selected = option.code === preferredLanguage;
                return (
                  <Pressable
                    key={option.code}
                    onPress={() => {
                      void handleSelectLanguage(option.code);
                    }}
                    onHoverIn={() => setHoveredLanguageOption(option.code)}
                    onHoverOut={() => setHoveredLanguageOption(null)}
                    onFocus={() => setFocusedLanguageOption(option.code)}
                    onBlur={() => setFocusedLanguageOption(null)}
                    style={({ pressed }) => [
                      styles.modalOption,
                      (hoveredLanguageOption === option.code || pressed) && styles.modalOptionHovered,
                      focusedLanguageOption === option.code && styles.modalOptionFocused,
                      selected && styles.modalOptionSelected,
                    ]}
                  >
                    <View style={styles.modalOptionCopy}>
                      <Text
                        style={[
                          styles.modalOptionText,
                          selected && styles.modalOptionTextSelected,
                        ]}
                      >
                        {option.nativeLabel}
                      </Text>
                      <Text style={styles.modalOptionMeta}>
                        {option.llmLabel}
                      </Text>
                    </View>
                    {selected ? (
                      <Feather name="check" size={18} color={colors.primary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={draftEditorOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={collapseDraftEditor}
      >
        <KeyboardAvoidingView
          style={styles.draftEditorSafeArea}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
        <SafeAreaView style={styles.draftEditorSafeArea}>
          <View style={styles.draftEditorHeader}>
            <Pressable
              onPress={collapseDraftEditor}
              style={styles.draftEditorClose}
              accessibilityRole="button"
              accessibilityLabel="Collapse message editor"
            >
              <Feather name="chevron-down" size={24} color={colors.primary} />
            </Pressable>
            <Text style={styles.draftEditorTitle}>{t("askPrana.expandMessage")}</Text>
            <View style={styles.draftEditorHeaderSpacer} />
          </View>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSelectionChange={handleDraftSelectionChange}
            selection={draftSelection}
            placeholder={placeholder}
            placeholderTextColor={colors.muted}
            style={styles.draftEditorInput}
            multiline
            autoFocus
            textAlignVertical="top"
            blurOnSubmit={false}
            submitBehavior="newline"
            scrollEnabled
          />
          <View style={styles.draftEditorActions}>
            <Pressable
              onPress={collapseDraftEditor}
              style={({ pressed }) => [styles.draftEditorCollapse, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.draftEditorCollapseText}>{t("askPrana.collapse")}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (!canSend || isRecording || isTranscribing) return;
                setDraftEditorOpen(false);
                handleComposerAction();
              }}
              disabled={!canSend || isRecording || isTranscribing}
              style={({ pressed }) => [
                styles.draftEditorSend,
                (!canSend || isRecording || isTranscribing) && styles.sendButtonDisabled,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
            >
              <Feather name="send" size={18} color={colors.white} />
              <Text style={styles.draftEditorSendText}>{t("askPrana.send")}</Text>
            </Pressable>
          </View>
        </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      <AskPranaAttachmentViewer
        uri={attachmentPreview?.uri}
        fileName={attachmentPreview?.fileName}
        mimeType={attachmentPreview?.mimeType}
        visible={attachmentPreview != null}
        onClose={() => setAttachmentPreview(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: prana.desktopHeader },
  keyboardView: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  appLayout: {
    flex: 1,
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    flexDirection: "row",
  },
  chatArea: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    backgroundColor: colors.background,
  },
  messageColumn: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  translationBanner: {
    color: prana.muted,
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    paddingVertical: 6,
  },
  mobileVoiceCover: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 30,
    backgroundColor: "#000000",
  },
  inputShellVoice: {
    width: "auto",
  },
  voiceMuteButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: prana.ink, alignItems: "center", justifyContent: "center" },
  voiceCloseButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: prana.card, borderWidth: 1, borderColor: prana.chipBorder, alignItems: "center", justifyContent: "center" },
  chatList: { flex: 1, backgroundColor: colors.background },
  scrollToLatestHost: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: "center",
    zIndex: 4,
  },
  scrollToLatestButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: prana.card,
    borderWidth: 1,
    borderColor: "#C8D5BD",
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
  },
  scrollToLatestButtonFocused: { borderColor: prana.teal },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 10,
    gap: 8,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
  },
  headerBrand: { flexDirection: "row", alignItems: "center", gap: 10, maxWidth: "100%" },
  headerSpacer: { width: 42, height: 42 },
  assistantTitle: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "600",
  },
  headerSide: {
    width: 72,
    flexDirection: "row",
    alignItems: "center",
  },
  headerRight: {
    justifyContent: "flex-end",
    gap: 4,
  },
  languagePill: {
    width: 72,
    height: 40,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  languagePillText: {
    // Fixed width so En / Te / Hi never shift the pill contents.
    width: 20,
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    textAlign: "center",
  },
  loadingState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  chatContent: {
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    flexGrow: 1,
    paddingTop: 18,
    paddingHorizontal: 18,
    paddingBottom: 20,
    gap: 15,
    backgroundColor: colors.background,
  },
  // Phones cover the conversation with the full-screen voice stage. The extra
  // padding is unused there and is not applied on desktop.
  chatContentWithVoiceDock: {
    paddingBottom: 156,
  },
  // Desktop voice keeps the orb below this list, so the thread only needs a
  // small gap before the dock.
  chatContentDesktopVoice: {
    paddingBottom: 20,
  },
  emptyChat: {
    flex: 1,
    width: "100%",
    maxWidth: 570,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 11,
    paddingVertical: 20,
  },
  emptyChatLogo: { marginBottom: 8 },
  emptyChatTitle: {
      color: colors.white,
      fontFamily: ASK_PRANA_FONT_FAMILY,
      fontSize: 28,
      lineHeight: 34,
      fontWeight: "600",
    },
  emptyChatSubtitle: {
    color: "#34766A",
    fontFamily: PRANA_FONT,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 14,
  },
  emptyChatCopy: {
    color: "#6A8574",
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 21,
    fontWeight: "400",
    textAlign: "center",
    maxWidth: 420,
    marginTop: 10,
  },
  stoppedStatusWrap: {
    alignItems: "center",
    paddingVertical: 4,
  },
  stoppedStatusBadge: {
    backgroundColor: prana.chip,
    borderWidth: 1,
    borderColor: prana.chipBorder,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  stoppedStatus: {
    color: prana.chipText,
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  dateBadgeWrap: { alignItems: "center", marginBottom: 8, marginTop: 4 },
  dateBadge: {
    backgroundColor: colors.suggestion,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  dateBadgeText: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
  },
  composerArea: {
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 14,
    backgroundColor: prana.card,
    borderTopWidth: 1,
    borderTopColor: prana.line,
    gap: 10,
    alignItems: "center",
    shadowColor: "#325B41",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
  },
  suggestionsScroll: { width: "100%", maxWidth: 900 },
  pendingScroll: { width: "100%" },
  suggestionsRow: { gap: 8, paddingHorizontal: 0, paddingVertical: 2 },
  pendingRow: {
    gap: 10,
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
  },
  pendingChip: {
    position: "relative",
  },
  pendingPreviewPressable: {
    borderRadius: 12,
    overflow: "hidden",
  },
  pendingImage: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
  },
  pendingPreviewBadge: {
    position: "absolute",
    right: 5,
    bottom: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(11, 31, 36, 0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  pendingLoading: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(11, 31, 36, 0.46)",
    alignItems: "center",
    justifyContent: "center",
  },
  pendingFile: {
    minWidth: 156,
    maxWidth: 220,
    minHeight: 64,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#CBDAC2",
    backgroundColor: "#EEF4E7",
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pendingFileDetails: { flex: 1, flexShrink: 1, minWidth: 0, gap: 2 },
  pendingFileNameRow: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    maxWidth: "100%",
  },
  pendingFileName: { flexShrink: 1, minWidth: 0, color: "#356A56", fontFamily: PRANA_FONT, fontSize: 11, lineHeight: 15, fontWeight: "700" },
  pendingFileExt: { flexShrink: 0, color: "#356A56", fontFamily: PRANA_FONT, fontSize: 11, lineHeight: 15, fontWeight: "700" },
  pendingFileMeta: { color: "#7A8E7B", fontFamily: PRANA_FONT, fontSize: 9, lineHeight: 13 },
  pendingRemove: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: prana.ink,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    elevation: 2,
  },
  pendingRetry: {
    position: "absolute",
    top: -6,
    left: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#B45309",
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentError: { color: prana.error, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
  pendingItemError: { width: 150, marginTop: 4, color: prana.error, fontFamily: PRANA_FONT, fontSize: 11, lineHeight: 15 },
  suggestionChip: {
    backgroundColor: prana.card,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 45,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#CDD6BD",
  },
  suggestionText: { color: "#205D53", fontFamily: PRANA_FONT, fontSize: 11, lineHeight: 15, fontWeight: "700" },
  inputRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 7,
    width: "100%",
    maxWidth: 900,
  },
  // Phone composer: the existing controls remain the same components and
  // handlers, but are positioned in a compact toolbar under the full-width
  // textarea. This makes the outer row the single rounded composer surface.
  inputRowMobileComposer: {
    position: "relative",
    flexDirection: "column",
    alignItems: "stretch",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#B9CEBA",
    backgroundColor: prana.card,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 0,
  },
  inputRowVoice: { alignItems: "center" },
  attachWrap: { position: "relative", zIndex: 20 },
  attachWrapMobileComposer: { marginRight: "auto" },
  attachButton: {
    width: 44,
    minHeight: 54,
    height: "100%",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: prana.attachBorder,
    backgroundColor: prana.attachBg,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  attachButtonMobileComposer: {
    width: 44,
    height: 44,
    minHeight: 44,
    borderWidth: 0,
    borderRadius: 12,
    backgroundColor: "transparent",
    paddingVertical: 0,
  },
  attachMenu: {
    position: "absolute",
    left: 0,
    bottom: 62,
    backgroundColor: prana.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#B5CBB3",
    padding: 8,
    minWidth: 220,
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.13,
    shadowRadius: 26,
    elevation: 6,
    zIndex: 20,
  },
  attachMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    minHeight: 44,
    paddingHorizontal: 9,
    paddingVertical: 9,
    borderRadius: 8,
  },
  attachMenuText: {
    color: "#225E50",
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "700",
  },
  inputShell: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 54,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#B9CEBA",
    backgroundColor: prana.card,
    paddingLeft: 10,
    paddingRight: 3,
    paddingVertical: 3,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: 4,
  },
  inputShellMobileComposer: {
    flexGrow: 0,
    flexShrink: 0,
    // "auto", not "100%": in this column layout a 100% basis means the full
    // height of the composer, which pushed the toolbar out of the bottom.
    flexBasis: "auto",
    width: "100%",
    minHeight: COMPOSER_INPUT_MIN_HEIGHT,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    paddingHorizontal: 0,
    paddingTop: 6,
    paddingBottom: 4,
    justifyContent: "flex-start",
  },
  mobileComposerToolbar: {
    width: "100%",
    minWidth: 0,
    minHeight: 44,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  mobileComposerToolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  composerControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 44,
    width: "100%",
  },
  inputShellDesktop: {
    borderWidth: 0,
    backgroundColor: "#F5F6E7",
    paddingLeft: 17,
    minHeight: 58,
  },
  textInput: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    color: prana.ink,
    backgroundColor: "transparent",
    fontFamily: PRANA_FONT,
    fontSize: 14,
    lineHeight: 22,
    fontWeight: "400",
    minHeight: COMPOSER_INPUT_MIN_HEIGHT,
    paddingTop: Platform.OS === "ios" ? 12 : 11,
    paddingBottom: Platform.OS === "ios" ? 12 : 11,
    margin: 0,
    // React Native's TextStyle type does not include the browser-only
    // `none` outline value, although React Native Web supports it.
    ...(Platform.OS === "web"
      ? ({ outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle)
      : {}),
    overflow: "hidden",
  },
  // React Native Web otherwise exposes a permanent native textarea scrollbar
  // while the controlled height is still growing after a paste.
  textInputAutoGrowing: {
    overflow: "hidden",
  },
  textInputScrollable: Platform.OS === "web"
    ? ({ overflowY: "auto", scrollbarWidth: "thin" } as unknown as TextStyle)
    : { overflow: "scroll" },
  // iPhone Safari zooms the page into any text box under 16 px.
  textInputMobile: {
    fontSize: 16,
    lineHeight: 22,
    minHeight: 22,
    paddingTop: 0,
    paddingBottom: 0,
  },
  textInputMobileComposer: {
    width: "100%",
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "100%",
    paddingHorizontal: 8,
    // No vertical padding: the mobile height is calculated as lines × 22 px,
    // so padding here clipped the text. The spacing sits on the shell instead.
    paddingTop: 0,
    paddingBottom: 0,
  },
  micButton: {
    width: 39,
    minHeight: 44,
    alignSelf: "stretch",
    marginLeft: 5,
    borderLeftWidth: 1,
    borderLeftColor: "#E1E6D3",
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    zIndex: 2,
  },
  micButtonActive: { backgroundColor: prana.teal },
  micButtonMobileComposer: {
    width: 44,
    height: 44,
    minHeight: 44,
    alignSelf: "center",
    marginLeft: 0,
    borderLeftWidth: 0,
    borderRadius: 12,
    backgroundColor: "transparent",
  },
  voiceModeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
  },
  sendButton: {
    width: 44,
    minHeight: 54,
    borderRadius: 12,
    backgroundColor: prana.teal,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingVertical: 5,
  },
  sendButtonDisabled: { opacity: 0.48 },
  sendButtonMobileComposer: {
    width: 44,
    height: 44,
    minHeight: 44,
    borderRadius: 12,
    paddingVertical: 0,
    marginLeft: 0,
  },
  expandDraftButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: prana.chipBorder,
    backgroundColor: prana.chip,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  composerSecondaryActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    width: "100%",
  },
  expandDraftText: { color: prana.chipText, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "600" },
  stopIcon: { width: 13, height: 13, borderRadius: 2, backgroundColor: colors.white },
  recordingShell: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 56,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 10,
    borderWidth: 0,
    borderRadius: 28,
    backgroundColor: prana.ink,
  },
  recordingTimer: {
    minWidth: 40,
    color: colors.white,
    fontFamily: PRANA_FONT,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  recordingCircleButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  recordingStopCircle: { backgroundColor: "rgba(255,255,255,0.14)" },
  recordingStopSquare: {
    width: 13,
    height: 13,
    borderRadius: 3,
    backgroundColor: colors.white,
  },
  recordingSendButton: { width: 38, height: 38, minHeight: 38, borderRadius: 19, paddingVertical: 0, backgroundColor: prana.teal },
  failedRecordingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  failedRecordingText: { color: prana.muted, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16 },
  failedRecordingAction: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  failedRecordingRetryText: { color: prana.teal, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  failedRecordingDiscardText: { color: prana.muted, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  recordingHint: { color: prana.teal, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, fontWeight: "600", textAlign: "center" },
  draftEditorSafeArea: { flex: 1, backgroundColor: prana.cream },
  draftEditorHeader: {
    minHeight: 56,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: prana.line,
    backgroundColor: prana.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  draftEditorClose: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  draftEditorHeaderSpacer: { width: 40 },
  draftEditorTitle: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 16, lineHeight: 22, fontWeight: "700" },
  draftEditorInput: {
    flex: 1,
    margin: 16,
    borderWidth: 1,
    borderColor: "#B9CEBA",
    borderRadius: 13,
    backgroundColor: prana.card,
    color: prana.ink,
    fontFamily: PRANA_FONT,
    fontSize: 16,
    lineHeight: 23,
    fontWeight: "400",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  draftEditorActions: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: prana.line,
    backgroundColor: prana.card,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  draftEditorCollapse: { minHeight: 46, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: "#B9CEBC", alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  draftEditorCollapseText: { color: "#286C62", fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 20, fontWeight: "700" },
  draftEditorSend: { minHeight: 46, paddingHorizontal: 18, borderRadius: 12, backgroundColor: prana.teal, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  draftEditorSendText: { color: colors.white, fontFamily: PRANA_FONT, fontSize: 13, lineHeight: 20, fontWeight: "800" },
  pressed: { opacity: 0.88 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(21, 57, 58, 0.4)", justifyContent: "center", alignItems: "center", paddingHorizontal: 16, paddingVertical: 16 },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "100%",
    alignSelf: "center",
    backgroundColor: prana.card,
    borderWidth: 1,
    borderColor: prana.line,
    borderRadius: 18,
    padding: 20,
    gap: 4,
    zIndex: 1,
    shadowColor: "#15393A",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 30,
  },
  pondSelectorList: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 320,
  },
  modalTitle: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 18, lineHeight: 24, fontWeight: "800", marginBottom: 8 },
  modalOption: {
    minHeight: 54,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderWidth: 1,
    borderColor: "transparent",
  },
  modalOptionHovered: { backgroundColor: prana.attachBg },
  modalOptionFocused: { borderColor: "#7FB3A0" },
  modalOptionSelected: { backgroundColor: "#DCEFE2", borderColor: "#7FB3A0" },
  modalOptionCopy: { flex: 1 },
  modalOptionText: { color: prana.ink, fontFamily: PRANA_FONT, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  modalOptionTextSelected: { color: "#186558" },
  modalOptionMeta: { color: prana.muted, fontFamily: PRANA_FONT, fontSize: 12, lineHeight: 16, marginTop: 2, fontWeight: "400" },
  safeAreaMobile: { backgroundColor: prana.tealDeep },
  emptyChatSubtitleDesktop: { fontSize: 17, lineHeight: 24, marginTop: 20, color: "#4F8174" },
  emptyChatCopyDesktop: { fontSize: 14, lineHeight: 24, maxWidth: 580 },
  composerAreaDesktop: {
    width: "100%",
    maxWidth: 840,
    alignSelf: "center",
    marginBottom: 19,
    paddingTop: 15,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderWidth: 1,
    borderTopWidth: 1,
    borderColor: "#C8D9BF",
    borderTopColor: "#C8D9BF",
    borderRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 25,
  },
  attachButtonDesktop: { width: 47, minHeight: 58, borderWidth: 0 },
  attachButtonOpen: { borderColor: prana.teal, backgroundColor: "#DCEEE1" },
  tileLabel: {
    color: "#397F6E",
    fontFamily: PRANA_FONT,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: "700",
  },
  tileLabelOnTeal: { color: "#FFFFFF" },
  dictateLabel: {
    color: "#538478",
    fontFamily: PRANA_FONT,
    fontSize: 7,
    lineHeight: 9,
    fontWeight: "600",
  },
  sendButtonDesktop: { width: 51, minHeight: 58 },
  voiceControls: {
    width: "100%",
    maxWidth: 900,
    flexDirection: "row",
    gap: 7,
  },
  voiceControlsDesktop: { gap: 9 },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 43,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: prana.chipBorder,
    backgroundColor: prana.chip,
  },
  voiceChipDesktop: { minHeight: 36, borderColor: "#D3DFC9", backgroundColor: "#F8F9ED" },
  voiceChipText: {
    color: prana.chipText,
    fontFamily: PRANA_FONT,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
  },
  composerNote: {
    width: "100%",
    maxWidth: 900,
    textAlign: "center",
    color: "#75877C",
    fontFamily: PRANA_FONT,
    fontSize: 9,
    lineHeight: 13,
    marginTop: -2,
  },
  voiceTile: {
    width: 50,
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: prana.chipBorder,
    backgroundColor: prana.chip,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: 5,
    paddingHorizontal: 2,
  },
  voiceTileMobileComposer: {
    width: 58, // wide enough for the "Voice chat" label
    height: 44,
    minHeight: 44,
    borderWidth: 0,
    borderRadius: 12,
    backgroundColor: "transparent",
    paddingVertical: 0,
    marginLeft: 0,
  },
  voiceTileDesktop: { width: 58, minHeight: 58, borderColor: "#D3DFC9", backgroundColor: "#F8F9ED" },
});
