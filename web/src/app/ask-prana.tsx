import { ASK_PRANA_FONT_FAMILY } from "../constants/ask-prana-typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { AskPranaVoiceModeModal } from "../components/ask-prana-voice-mode";
import { useAskPranaChat, type ChatMessage } from "../context/ask-prana-chat-context";
import {
  ASK_PRANA_LANGUAGE_OPTIONS,
  getAskPranaLanguageOption,
  loadAskPranaPreferredLanguage,
  loadTeluguScriptPreference,
  mapToAskPranaLanguageCode,
  saveAskPranaPreferredLanguage,
  saveTeluguScriptPreference,
  type AskPranaSpeechLanguageCode,
  type TeluguScriptPreference,
} from "../lib/ask-prana-language";
import { speakAskPranaText, stopAskPranaSpeech } from "../lib/ask-prana-speech";
import { type AskPranaRequestContext } from "../services/ask-prana";
import {
  retryAskPranaVisibleTranslations,
  selectAskPranaLanguageWhenReady,
  useAskPranaDisplayTranslation,
} from "../lib/ask-prana-display-translation";
const colors = {
  primary: "#4F8CF7",
  primaryDark: "#2F67D6",
  primarySoft: "#DCEBFF",
  primaryBright: "#6BA5FF",
  background: "#171717",
  white: "#F4F7FA",
  textDark: "#E9EEF6",
  muted: "#9AA4B2",
  border: "#2A303C",
  suggestion: "#1E242D",
  warningSoft: "#131A21",
};

const COMPOSER_INPUT_MIN_HEIGHT = 48;

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
function estimateComposerInputHeight(
  text: string,
  availableWidth: number,
  maxHeight: number,
) {
  if (!text) return COMPOSER_INPUT_MIN_HEIGHT;

  // 14 pt medium text averages about 7 px per character. The conservative
  // estimate only fills a gap until an exact content-size event arrives.
  const charactersPerLine = Math.max(
    12,
    Math.floor(Math.max(availableWidth - 4, 0) / 7),
  );
  const visualLines = text.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  );
  return clampComposerInputHeight(
    visualLines * COMPOSER_INPUT_LINE_HEIGHT + 12,
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

function formatRecordingClock(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  const isDesktop = Platform.OS === "web" && width >= 1024;
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const composerInputRef = useRef<TextInput>(null);
  const measuredDraftRef = useRef<string | null>(null);
  const composerEnterSubmitLockRef = useRef(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  // Start from the already-loaded UI language so nothing renders in English first.
  const [preferredLanguage, setPreferredLanguage] =
    useState<AskPranaSpeechLanguageCode>(() =>
      mapToAskPranaLanguageCode(i18n.resolvedLanguage),
    );
  const [teluguScript, setTeluguScript] =
    useState<TeluguScriptPreference>("native");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const attachWrapRef = useRef<View>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<{
    uri: string;
    fileName: string;
    mimeType: string;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(isDesktop);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
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
    isUploading,
    attachmentError,
    isRecording,
    isTranscribing,
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
    sendQuestion,
    editAndResendUserMessage,
    askFromVoiceMode,
    prepareVoiceModeSession,
    sendImageAttachment,
    sendDocumentAttachment,
    startAudioRecording,
    stopAudioRecordingToComposer,
    stopAudioRecordingToTranscript,
    cancelAudioRecording,
    stopGeneration,
    openConversation,
  } = useAskPranaChat();

  const routeSessionId = Array.isArray(params.sessionId)
    ? params.sessionId[0]
    : params.sessionId;
  const routeOpenSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!routeSessionId) {
      routeOpenSessionIdRef.current = null;
      return;
    }
    if (
      routeSessionId === activeSessionId ||
      routeOpenSessionIdRef.current === routeSessionId
    ) {
      return;
    }
    routeOpenSessionIdRef.current = routeSessionId;
    void openConversation(routeSessionId);
  }, [activeSessionId, isAuthLoading, openConversation, routeSessionId]);

  useEffect(() => {
    void (async () => {
      const storedAppLanguage = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
      const loaded = mapToAskPranaLanguageCode(
        storedAppLanguage || (await loadAskPranaPreferredLanguage()),
      );
      const allowed =
        loaded === "en" || loaded === "te" || loaded === "hi" ? loaded : "en";
      setTeluguScript(await loadTeluguScriptPreference());
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
      language: getAskPranaLanguageOption(preferredLanguage).llmLabel,
      sessionLanguageCode: preferredLanguage,
      // Replies are generated directly in the selected language, whatever
      // language the farmer typed in.
      voiceModeLanguageLock: preferredLanguage,
    }),
    [
      pathname,
      preferredLanguage,
    ],
  );

  const suggestionQuestions = useMemo(
    () => [
      t("askPrana.suggestions.ammonia"),
      t("askPrana.suggestions.harvest"),
      t("askPrana.suggestions.fcr"),
      t("askPrana.suggestions.survival"),
      t("askPrana.suggestions.quality"),
      t("askPrana.suggestions.feed"),
    ],
    [t],
  );

  const thinkingVisible = thinkingKind != null || isSending;
  // While the latest question asks for a file, say so instead of "Thinking...".
  const lastUserText = [...messages].reverse().find((message) => message.role === "user")?.text ?? "";
  const requestedFile = thinkingVisible ? detectRequestedFileFormat(lastUserText) : null;
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
    isSending || isUploading || isRecording || isTranscribing || isLoadingMessages;
  const conversationMessages = messages.filter((message) => message.id !== "welcome");
  const isTranslatableMessage = (message: ChatMessage) =>
    Boolean(message.text?.trim()) &&
    !(message.messageType !== "text" && message.fileName && message.text === message.fileName);
  const translationSources = conversationMessages.flatMap((message) => [
    ...(isTranslatableMessage(message) ? [message.text] : []),
    ...(message.transcript?.trim() ? [message.transcript] : []),
  ]).reverse();
  // Originals in `messages` are never modified; only the rendered copy changes.
  const { displayText: displayMessageText, contentPhase } =
    useAskPranaDisplayTranslation(translationSources, "visible", {
      prefetchOtherLanguages: false,
    });
  // Reuse the previous display object when a message's shown text is unchanged,
  // so the memoized bubbles only re-render for messages whose translation landed.
  const [displayMessageCache] = useState(
    () => new WeakMap<ChatMessage, { text: string; transcript: string | null | undefined; value: ChatMessage }>(),
  );
  const displayConversationMessages = useMemo(
    () =>
      conversationMessages.map((message) => {
        const text = isTranslatableMessage(message) ? displayMessageText(message.text) : message.text;
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
  const desktopVoice = voiceModeOpen && isDesktop;
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
    thinkingVisible ||
    (!isRecording &&
      !isTranscribing &&
      (Boolean(draft.trim()) || pendingAttachments.length > 0));

  useEffect(() => {
    if (!isRecording) {
      setRecordingElapsedSec(0);
      return;
    }

    setRecordingElapsedSec(0);
    const timer = setInterval(() => {
      setRecordingElapsedSec((current) => current + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isRecording]);

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

  useEffect(() => {
    if (messages.length === 0 && !thinkingVisible && !generationStopped) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 80);
    return () => clearTimeout(timer);
  }, [messages, thinkingVisible, generationStopped]);

  const handleSend = (question: string) => {
    void sendQuestion(question, requestContext);
  };

  const handleStartNewChat = () => {
    setEditingMessageId(null);
    setAttachmentMenuOpen(false);
    setAttachmentPreview(null);
    setDraftEditorOpen(false);
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
    if (thinkingVisible) {
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
      void stopAudioRecordingToComposer();
      return;
    }
    void startAudioRecording({ source: "composer" });
  };

  const handleStopDictation = () => {
    if (!isRecording || isTranscribing) {
      return;
    }
    void stopAudioRecordingToComposer();
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
        const result = await speakAskPranaText(text, preferredLanguage);
        if (!result.spoke && result.reason) {
          Alert.alert(t("askPrana.speechUnavailable"), result.reason);
        }
      })();
    },
    [preferredLanguage, t],
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

  const placeholder = t("askPrana.askGeneral");

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
          ),
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [composerInputMaxHeight, composerInputWidth, draft, updateComposerInputHeight]);

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

  return (
    <SafeAreaView style={styles.safeArea} edges={["top"]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
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
          <View style={styles.header}>
            {/* Same width as the language pill so the title stays centered. */}
            <View style={styles.headerSide}>
            {!sidebarOpen ? (
              <Pressable
                onPress={() => setSidebarOpen(true)}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={t("askPrana.openHistory")}
              >
                <Feather name="menu" size={21} color="#0F766E" />
              </Pressable>
            ) : (
              <View style={styles.headerSpacer} />
            )}
            </View>

            <View style={styles.headerCenter}>
              <View style={styles.headerBrand}>
                <AskPranaLogo size={28} decorative />
                <Text style={styles.assistantTitle} numberOfLines={1}>{t("askPrana.title")}</Text>
              </View>
            </View>

            <View style={[styles.headerSide, styles.headerRight]}>
              <Pressable
                onPress={() => setLanguagePickerOpen(true)}
                style={({ pressed }) => [
                  styles.languagePill,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${t("askPrana.language")}: ${getAskPranaLanguageOption(preferredLanguage).llmLabel}`}
              >
                <Feather name="globe" size={18} color={colors.textDark} />
                {/* preferredLanguage is set together with i18next in handleSelectLanguage and on load. */}
                <Text style={styles.languagePillText}>{LANGUAGE_SHORT_LABELS[preferredLanguage]}</Text>
              </Pressable>
            </View>
          </View>


          <View style={styles.messageColumn}>
          {contentPhase === "loading" ? (
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
            <FlatList
              ref={listRef}
              style={styles.chatList}
              data={displayConversationMessages}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.chatContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                hasOlderMessages ? (
                  <Pressable
                    onPress={() => void loadOlderMessages()}
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
                  <AskPranaLogo size={72} decorative style={styles.emptyChatLogo} />
                  <Text style={styles.emptyChatTitle}>{t("askPrana.title")}</Text>
                  <Text style={styles.emptyChatSubtitle}>{t("askPrana.yourAquacultureAssistant")}</Text>
                  <Text style={styles.emptyChatCopy}>
                    {t("askPrana.emptyChatDescription")}
                  </Text>
                </View>
              }
              ListFooterComponent={
                thinkingVisible ? (
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
                    thinkingVisible || isRecording || isTranscribing || isSending
                  }
                  onRegenerateAssistantMessage={handleRegenerateAssistantMessage}
                  regenerateDisabled={thinkingVisible || isRecording || isTranscribing}
                  onReadAloud={handleReadAloud}
                />
              )}
            />
          )}
          {desktopVoice ? (
            <AskPranaVoiceModeModal
              visible={voiceModeOpen}
              variant="overlay"
              language={preferredLanguage}
              requestContext={requestContext}
              isRecording={isRecording}
              isTranscribing={isTranscribing}
              isSending={isSending}
              draft={draft}
              onChangeDraft={setDraft}
              onClose={() => {
                setVoiceModeOpen(false);
                setVoiceMuted(false);
                void stopAskPranaSpeech();
                void cancelAudioRecording();
              }}
              onStartListening={() =>
                startAudioRecording({ source: "voice", throwOnFailure: true })
              }
              onCancelListening={cancelAudioRecording}
              onStopListeningToTranscript={stopAudioRecordingToTranscript}
              onAsk={async (question, context) => askFromVoiceMode(question, context)}
              onLanguageChange={async (code) => {
                await cancelAudioRecording();
                await handleSelectLanguage(code);
              }}
              onMutedChange={setVoiceMuted}
              onRegisterActions={registerVoiceActions}
            />
          ) : null}
          </View>

          {editingMessageId ? null : (
          <View style={styles.composerArea}>
            {conversationMessages.length === 0 && !desktopVoice ? (
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

            {pendingAttachments.length > 0 || isUploading ? (
              <ScrollView
                style={styles.pendingScroll}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pendingRow}
              >
                {pendingAttachments.map((item) => {
                  const previewUri = item.localUri ?? item.fileUrl;
                  const isImage = item.kind === "image";
                  return (
                    <View key={item.id} style={styles.pendingChip}>
                      {isImage && previewUri ? (
                        <Pressable
                          onPress={() => setAttachmentPreview({
                            uri: previewUri,
                            fileName: item.fileName,
                            mimeType: item.mimeType,
                          })}
                          style={styles.pendingPreviewPressable}
                          accessibilityRole="imagebutton"
                          accessibilityLabel={`Open uploaded image ${item.fileName}`}
                        >
                          <Image
                            source={{ uri: previewUri }}
                            style={styles.pendingImage}
                            contentFit="cover"
                          />
                          <View style={styles.pendingPreviewBadge} pointerEvents="none">
                            <Feather name="maximize-2" size={12} color={colors.white} />
                          </View>
                        </Pressable>
                      ) : (
                        <Pressable
                          onPress={() => setAttachmentPreview({
                            uri: previewUri,
                            fileName: item.fileName,
                            mimeType: item.mimeType,
                          })}
                          style={styles.pendingFile}
                          accessibilityRole="button"
                          accessibilityLabel={`Preview uploaded document ${item.fileName}`}
                        >
                          <Feather name="file-text" size={16} color={colors.primary} />
                          <Text style={styles.pendingFileName} numberOfLines={1}>
                            {item.fileName}
                          </Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={() => removePendingAttachment(item.id)}
                        disabled={isSending}
                        style={styles.pendingRemove}
                        accessibilityRole="button"
                        accessibilityLabel="Remove attachment"
                      >
                        <Feather name="x" size={12} color={colors.white} />
                      </Pressable>
                    </View>
                  );
                })}
                {isUploading ? (
                  <View style={styles.pendingPreparing}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={styles.pendingPreparingText}>{t("askPrana.preparing")}</Text>
                  </View>
                ) : null}
              </ScrollView>
            ) : null}

            <View style={[styles.inputRow, desktopVoice && styles.inputRowVoice]}>
              <View style={[styles.inputShell, isDesktop && styles.inputShellDesktop, desktopVoice && styles.inputShellVoice]}>
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
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.attach")}
                  >
                    <Feather name="plus" size={22} color={colors.muted} />
                  </Pressable>
                  {attachmentMenuOpen ? (
                    <View style={styles.attachMenu}>
                      <Pressable
                        onPress={() => {
                          setAttachmentMenuOpen(false);
                          void sendImageAttachment(requestContext);
                        }}
                        style={styles.attachMenuItem}
                      >
                        <Feather name="image" size={16} color={colors.textDark} />
                        <Text style={styles.attachMenuText}>{t("askPrana.addImage")}</Text>
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
                <TextInput
                  ref={composerInputRef}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={desktopVoice ? "Type" : placeholder}
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.textInput,
                    !isDesktop && styles.textInputMobile,
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
                                            Math.floor((composerInputWidth || 220) / 8),
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
                  textAlignVertical={isDesktop ? "top" : "center"}
                  blurOnSubmit={false}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => {
                    if (desktopVoice) {
                      voiceActionsRef.current?.submitTyped();
                      return;
                    }
                    handleComposerEnter();
                  }}
                  onKeyPress={(event) => {
                    if (event.nativeEvent.key !== "Enter") return;
                    event.preventDefault();
                    if (desktopVoice) {
                      voiceActionsRef.current?.submitTyped();
                      return;
                    }
                    handleComposerEnter();
                  }}
                  enablesReturnKeyAutomatically
                  scrollEnabled={composerInputHeight >= composerInputMaxHeight}
                  onContentSizeChange={handleComposerContentSizeChange}
                />
                {desktopVoice ? null : (
                <>
                <Pressable
                  onPress={handleMicPress}
                  disabled={
                    voiceModeOpen ||
                    isTranscribing ||
                    (composerBusy && !isRecording)
                  }
                  hitSlop={10}
                  style={({ pressed }) => [
                    styles.micButton,
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
                    size={isRecording ? 14 : 18}
                    color={isRecording ? colors.white : colors.muted}
                  />
                </Pressable>
                {canSend ? (
                  <Pressable
                    onPress={handleComposerAction}
                    disabled={isRecording || isTranscribing}
                    style={({ pressed }) => [
                      styles.sendButton,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={thinkingVisible ? t("askPrana.stopGenerating") : t("askPrana.send")}
                  >
                    {thinkingVisible ? (
                      <View style={styles.stopIcon} />
                    ) : (
                      <Feather name="arrow-up" size={18} color={colors.white} />
                    )}
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => {
                      if (isRecording || isTranscribing || composerBusy) return;
                      prepareVoiceModeSession();
                      setVoiceModeOpen(true);
                    }}
                    disabled={composerBusy || isRecording || isTranscribing}
                    style={({ pressed }) => [
                      styles.voiceModeButton,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.startVoiceConversation")}
                  >
                    <Feather name="radio" size={16} color={colors.white} />
                  </Pressable>
                )}
                </>
                )}
              </View>
              {desktopVoice ? (
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

            {isRecording && !voiceModeOpen ? (
              <View style={styles.recordingControls}>
                <Text style={styles.recordingHint}>
                  {t("askPrana.recordingTimer", {
                    time: formatRecordingClock(recordingElapsedSec),
                  })}
                </Text>
                <View style={styles.recordingActions}>
                  <Pressable
                    onPress={handleCancelDictation}
                    style={({ pressed }) => [
                      styles.recordingActionButton,
                      styles.recordingCancelButton,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.cancelRecording")}
                  >
                    <Text style={styles.recordingCancelText}>
                      {t("askPrana.cancelRecording")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleStopDictation}
                    style={({ pressed }) => [
                      styles.recordingActionButton,
                      styles.recordingStopButton,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t("askPrana.stopRecording")}
                  >
                    <Text style={styles.recordingStopText}>
                      {t("askPrana.stopRecording")}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : isTranscribing ? (
              <Text style={styles.recordingHint}>
                {t("askPrana.transcribingHint")}
              </Text>
            ) : null}
          </View>
          )}

          {voiceModeOpen && !isDesktop ? (
            <View style={styles.mobileVoiceCover}>
              <AskPranaVoiceModeModal
                visible
                variant="screen"
                language={preferredLanguage}
                requestContext={requestContext}
                isRecording={isRecording}
                isTranscribing={isTranscribing}
                isSending={isSending}
                draft={draft}
                onChangeDraft={setDraft}
                onClose={() => {
                  setVoiceModeOpen(false);
                  setVoiceMuted(false);
                  void stopAskPranaSpeech();
                  void cancelAudioRecording();
                }}
                onStartListening={() =>
                  startAudioRecording({ source: "voice", throwOnFailure: true })
                }
                onCancelListening={cancelAudioRecording}
                onStopListeningToTranscript={stopAudioRecordingToTranscript}
                onAsk={async (question, context) => askFromVoiceMode(question, context)}
                onLanguageChange={async (code) => {
                  await cancelAudioRecording();
                  await handleSelectLanguage(code);
                }}
                onOpenMenu={() => setSidebarOpen(true)}
                onAddImage={() => {
                  void sendImageAttachment(requestContext);
                }}
                onAddFile={() => {
                  void sendDocumentAttachment(requestContext);
                }}
                addImageLabel={t("askPrana.addImage")}
                addFileLabel={t("askPrana.addFile")}
              />
            </View>
          ) : null}

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
                    style={[
                      styles.modalOption,
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
            {preferredLanguage === "te" ? (
              <View style={{ gap: 8, marginTop: 8 }}>
                <Text style={styles.modalOptionMeta}>{t("askPrana.teluguTextStyle")}</Text>
                <Pressable
                  onPress={() => {
                    void (async () => {
                      await saveTeluguScriptPreference("native");
                      setTeluguScript("native");
                    })();
                  }}
                  style={[
                    styles.modalOption,
                    teluguScript === "native" && styles.modalOptionSelected,
                  ]}
                >
                  <Text style={styles.modalOptionText}>తెలుగు script</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void (async () => {
                      await saveTeluguScriptPreference("romanized");
                      setTeluguScript("romanized");
                    })();
                  }}
                  style={[
                    styles.modalOption,
                    teluguScript === "romanized" && styles.modalOptionSelected,
                  ]}
                >
                  <Text style={styles.modalOptionText}>Romanized Telugu</Text>
                </Pressable>
              </View>
            ) : null}
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
  safeArea: { flex: 1, backgroundColor: colors.background },
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
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
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
  voiceMuteButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#2F2F2F",
    alignItems: "center",
    justifyContent: "center",
  },
  voiceCloseButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  chatList: { flex: 1, backgroundColor: colors.background },
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
  headerSpacer: { width: 40, height: 40 },
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
    maxWidth: 900,
    alignSelf: "center",
    flexGrow: 1,
    paddingTop: 24,
    paddingHorizontal: 28,
    paddingBottom: 24,
    gap: 14,
    backgroundColor: colors.background,
  },
  emptyChat: {
    flex: 1,
    width: "100%",
    maxWidth: 620,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    gap: 8,
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
      color: colors.white,
      fontFamily: ASK_PRANA_FONT_FAMILY,
      fontSize: 16,
      lineHeight: 22,
      fontWeight: "500",
    },
  emptyChatCopy: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "400",
    textAlign: "center",
    maxWidth: 420,
    marginTop: 2,
  },
  stoppedStatusWrap: {
    alignItems: "center",
    paddingVertical: 4,
  },
  stoppedStatusBadge: {
    backgroundColor: colors.suggestion,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  stoppedStatus: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
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
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.background,
    gap: 10,
    alignItems: "center",
  },
  suggestionsScroll: { width: "100%", maxWidth: 900 },
  pendingScroll: { width: "100%", maxWidth: 900 },
  suggestionsRow: { gap: 8, paddingHorizontal: 4 },
  pendingRow: {
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  pendingChip: {
    position: "relative",
  },
  pendingPreviewPressable: {
    borderRadius: 12,
    overflow: "hidden",
  },
  pendingImage: {
    width: 64,
    height: 64,
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
  pendingFile: {
    minWidth: 120,
    maxWidth: 180,
    minHeight: 64,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: "center",
    gap: 6,
  },
  pendingFileName: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  pendingRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.textDark,
    alignItems: "center",
    justifyContent: "center",
  },
  pendingPreparing: {
    minHeight: 64,
    minWidth: 92,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    gap: 6,
  },
  attachmentError: {
    color: "#F0A0A0",
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "400",
    paddingHorizontal: 4,
  },
  pendingPreparingText: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "400",
  },
  suggestionChip: {
    backgroundColor: colors.suggestion,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.border,
  },
  suggestionText: { color: colors.white, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 13, lineHeight: 17, fontWeight: "500" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    width: "100%",
    maxWidth: 900,
  },
  inputRowVoice: {
    alignItems: "center",
  },
  attachWrap: { position: "relative" },
  attachButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  attachMenu: {
    position: "absolute",
    left: 0,
    bottom: 48,
    backgroundColor: "#171C23",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    minWidth: 160,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
    zIndex: 20,
  },
  attachMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  attachMenuText: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "500",
  },
  inputShell: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    width: "100%",
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: "#2F2F2F",
    paddingLeft: 6,
    paddingRight: 8,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  inputShellDesktop: {
    borderRadius: 28,
    alignItems: "center",
    minHeight: 52,
    paddingVertical: 6,
  },
  textInput: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    color: colors.white,
    backgroundColor: "transparent",
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "400",
    minHeight: COMPOSER_INPUT_MIN_HEIGHT,
    paddingTop: Platform.OS === "ios" ? 12 : 10,
    paddingBottom: Platform.OS === "ios" ? 12 : 10,
    margin: 0,
    outlineStyle: "none",
    outlineWidth: 0,
  },
  textInputMobile: {
    lineHeight: 22,
    minHeight: 22,
    paddingTop: 0,
    paddingBottom: 0,
  },
  micButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  micButtonActive: {
    backgroundColor: "#0F766E",
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
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 1,
  },
  sendButtonDisabled: { opacity: 0.55 },
  expandDraftButton: {
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 21,
    backgroundColor: colors.primarySoft,
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
  expandDraftText: {
    color: colors.primaryDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  stopIcon: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.white,
  },
  recordingControls: {
    gap: 8,
    alignItems: "center",
  },
  recordingActions: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  recordingActionButton: {
    minWidth: 96,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    alignItems: "center",
  },
  recordingCancelButton: {
    // Dark like the chat background, so the light label stays readable.
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recordingStopButton: {
    backgroundColor: "#0F766E",
  },
  recordingCancelText: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
  },
  recordingStopText: {
    color: colors.white,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  recordingHint: {
    color: "#0F766E",
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    textAlign: "center",
  },
  draftEditorSafeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  draftEditorHeader: {
    minHeight: 56,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.white,
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
  draftEditorTitle: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
  },
  draftEditorInput: {
    flex: 1,
    margin: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    backgroundColor: colors.white,
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "400",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  draftEditorActions: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.white,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  draftEditorCollapse: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.suggestion,
  },
  draftEditorCollapseText: { color: colors.textDark, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  draftEditorSend: {
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: 23,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  draftEditorSendText: { color: colors.white, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  pressed: { opacity: 0.88 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "100%",
    alignSelf: "center",
    // Same dark surface as the Ask Prana screen.
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 20,
    gap: 4,
    zIndex: 1,
  },
  pondSelectorList: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 320,
  },
  modalTitle: {
    color: colors.textDark,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "600",
    marginBottom: 6,
  },
  modalOption: {
    minHeight: 54,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  modalOptionSelected: { backgroundColor: "rgba(79, 140, 247, 0.16)" },
  modalOptionCopy: { flex: 1 },
  modalOptionText: { color: colors.textDark, fontFamily: ASK_PRANA_FONT_FAMILY, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  modalOptionTextSelected: { color: colors.primaryBright },
  modalOptionMeta: {
    color: colors.muted,
    fontFamily: ASK_PRANA_FONT_FAMILY,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
    fontWeight: "400",
  },
});
