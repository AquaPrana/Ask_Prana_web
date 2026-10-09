import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import {
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { uploadAskPranaFile } from "../lib/ask-prana-files";
import {
  buildLanguageInstructionForLlm,
  getAskPranaLanguageOption,
  loadAskPranaPreferredLanguage,
  loadTeluguScriptPreference,
  mapToAskPranaLanguageCode,
  resolveAndPersistAskPranaReplyLanguage,
  type AskPranaSpeechLanguageCode,
} from "../lib/ask-prana-language";
import {
  isWebDictationAvailable,
  startWebDictation,
  type WebDictationSession,
} from "../lib/ask-prana-dictation";
import { pickMultipleImages, pickSingleImage, promptImageSource } from "../lib/record-images";
import {
  askPrana,
  transcribeAskPranaAudio,
  type AskPranaAttachment,
  type AskPranaRequestContext,
} from "../services/ask-prana";
import { stopAskPranaSpeech } from "../lib/ask-prana-speech";
import { clearAskPranaDisplayTranslations } from "../lib/ask-prana-display-translation";
import {
  createAskPranaSession,
  deleteAskPranaSession,
  fetchAskPranaMessages,
  getAskPranaSessionPondId,
  isValidAskPranaUuid,
  listAskPranaSessionsForPond,
  renameAskPranaSession,
  saveAskPranaMessage,
  type AskPranaSessionSummary,
} from "../services/ask-prana-messages";
import { useProfile } from "./profile-context";
import {
  ensureValidSession,
  isRecoverableAuthError,
  supabase,
  subscribeToAuthSession,
  waitForAuthReady,
} from "../lib/supabase";

export type AskPranaPendingAttachment = {
  id: string;
  kind: "image" | "file";
  filePath: string;
  fileUrl: string;
  localUri?: string | null;
  fileName: string;
  mimeType: string;
};

export type ChatRole = "assistant" | "user";
export type ChatMessageType = "text" | "image" | "document" | "audio";
export type AskPranaThinkingKind = "text" | "image" | "document" | "attachments";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  messageType?: ChatMessageType;
  fileUrl?: string | null;
  localUri?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  transcript?: string | null;
  pondName?: string;
  createdAt?: string;
};

export type AskPranaChatPondOption = {
  id: string;
  pondName: string;
};

export const GENERIC_ASSISTANT_ID = "__generic_assistant__";
export const GENERIC_ASSISTANT_LABEL = "Generic Assistant";

export const isGenericAssistantId = (pondId: string | null | undefined) =>
  !pondId || pondId === GENERIC_ASSISTANT_ID;

const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "text/plain",
];

const MAX_ATTACHMENT_COUNT = 5;
const UNSUPPORTED_FILE_MESSAGE =
  "Unsupported file type. Supported types are JPG, JPEG, PNG, WEBP, PDF, TXT, CSV, DOCX.";

function isLocalDeviceUri(value: string) {
  return (
    value.includes("://") ||
    value.startsWith("file:") ||
    value.startsWith("content:") ||
    value.startsWith("ph:")
  );
}

function extensionOf(fileName?: string | null, mimeType?: string | null) {
  const name = (fileName ?? "").split("?")[0].toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    return name.slice(dot + 1);
  }
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  if (mimeType?.includes("png")) return "png";
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("pdf")) return "pdf";
  if (mimeType?.includes("csv")) return "csv";
  if (mimeType?.includes("plain")) return "txt";
  if (mimeType?.includes("word")) return "docx";
  return "";
}

function isSupportedImageAttachment(fileName?: string | null, mimeType?: string | null) {
  const ext = extensionOf(fileName, mimeType);
  return (
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "webp" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
  );
}

function isSupportedDocumentAttachment(
  fileName?: string | null,
  mimeType?: string | null,
) {
  const ext = extensionOf(fileName, mimeType);
  return (
    ext === "pdf" ||
    ext === "txt" ||
    ext === "csv" ||
    ext === "docx" ||
    mimeType === "application/pdf" ||
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

const RECORDED_AUDIO_MIME: Record<string, string> = {
  m4a: "audio/m4a",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  aac: "audio/aac",
  caf: "audio/x-caf",
  flac: "audio/flac",
  "3gp": "audio/3gpp",
};

const OPENAI_TRANSCRIBE_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "wav",
  "webm",
  "ogg",
  "oga",
  "flac",
  "aac",
]);

const MIN_VOICE_DURATION_SEC = 0.6;
/** dBFS at or above this counts as speech. Opening quiet does not. */
const VOICE_SPEECH_DB = -32;
/** dBFS below this, after speech, counts as a pause. */
const VOICE_SILENCE_DB = -45;
const VOICE_SILENCE_MS = 800;
const VOICE_SPEECH_HOLD_MS = 280;

let voiceAutoStopListener: (() => void) | null = null;

/** Voice mode registers this so a pause can finish the turn without a tap. */
export function setVoiceAutoStopListener(listener: (() => void) | null) {
  voiceAutoStopListener = listener;
}

function notifyVoiceAutoStop() {
  voiceAutoStopListener?.();
}
const ANDROID_VOICE_FILE_EXTENSION = "mp4";
const ANDROID_VOICE_MIME_TYPE = "audio/mp4";

/** AAC inside an MPEG-4 (.mp4) container — accepted by the transcription API. */
const ASK_PRANA_VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: ".mp4",
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 128000,
  isMeteringEnabled: true,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    extension: ".mp4",
    outputFormat: "mpeg4",
    audioEncoder: "aac",
    audioSource: "voice_recognition",
  },
};

function extensionFromUri(uri: string) {
  const path = (uri.split("?")[0] ?? "").toLowerCase();
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1);
}

async function describeRecordedAudioContainer(blob: Blob): Promise<string | null> {
  // Hermes' Blob implementation in release Android builds does not always
  // expose `slice`. This is a diagnostic only; the Edge Function performs the
  // authoritative byte-level validation before sending anything to OpenAI.
  if (typeof blob.arrayBuffer !== "function") {
    console.log("[AskPranaAudio] local container inspection unavailable");
    return null;
  }

  let header: Uint8Array;
  try {
    header = new Uint8Array((await blob.arrayBuffer()).slice(0, 16));
  } catch (error) {
    console.log("[AskPranaAudio] local container inspection failed:", error);
    return null;
  }
  const at = (start: number, length: number) =>
    String.fromCharCode(...header.slice(start, start + length));
  if (at(4, 4) === "ftyp") return "mpeg-4";
  if (at(0, 4) === "RIFF") return "wav";
  if (at(0, 4) === "OggS") return "ogg";
  if (at(0, 4) === "\u001aE\u00df\u00a3") return "webm";
  return "unknown";
}

function resolveRecordedAudioMeta(uri: string, blobType?: string | null) {
  const extension = extensionFromUri(uri);

  // Native Ask Prana recordings are configured as AAC in an MPEG-4 MP4
  // container. Android fetch(file://) often reports an empty/octet-stream blob
  // type, so never use that unreliable value to relabel a native recording.
  if (Platform.OS !== "web") {
    return {
      mimeType: ANDROID_VOICE_MIME_TYPE,
      fileName: "askprana-recording.mp4",
      extension: ANDROID_VOICE_FILE_EXTENSION,
      uriExtension: extension,
    };
  }

  const isBlobUri = uri.startsWith("blob:");
  const fromBlob =
    blobType &&
    blobType !== "application/octet-stream" &&
    blobType.toLowerCase().startsWith("audio/")
      ? blobType.toLowerCase().split(";")[0]?.trim() || blobType
      : null;
  const fromExtension =
    extension && !isBlobUri ? RECORDED_AUDIO_MIME[extension] : null;

  // Web blob URLs have no extension and expo-audio records WebM in the browser.
  const mimeType =
    (isBlobUri ? fromBlob ?? fromExtension : fromExtension ?? fromBlob) ??
    "audio/webm";

  const fileExt =
    (!isBlobUri && extension) ||
    (mimeType.includes("webm")
      ? "webm"
      : mimeType.includes("wav")
        ? "wav"
        : mimeType.includes("mpeg") || mimeType.includes("mp3")
          ? "mp3"
          : mimeType.includes("ogg")
            ? "ogg"
            : mimeType.includes("m4a") || mimeType.includes("mp4")
              ? "m4a"
              : "webm");

  return {
    mimeType,
    fileName: `askprana-recording.${fileExt}`,
    extension: fileExt,
    uriExtension: extension,
  };
}

function isAudioAttachmentInput(input: {
  filePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  messageType?: ChatMessageType;
  kind?: AskPranaAttachment["kind"];
}) {
  if (input.messageType === "audio") {
    return true;
  }

  const mime = input.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("audio/")) {
    return true;
  }

  const haystack = `${input.fileName ?? ""} ${input.filePath ?? ""}`.toLowerCase();
  if (/\.(m4a|mp3|mp4|wav|webm|ogg|oga|caf|3gp|aac|flac)(\?|$)/i.test(haystack)) {
    return true;
  }

  return (
    input.filePath?.includes("/audio/") === true ||
    input.filePath?.startsWith("audio/") === true
  );
}

function toFarmerFacingAssistantError(detail: string) {
  const stripped = detail.replace(/^HTTP \s*\d{3}:\s*/i, "").trim();
  if (/unsupported file type/i.test(stripped) || /unsupported file type/i.test(detail)) {
    return "Ask Prana couldn't answer right now. Please try again.";
  }
  return stripped || detail || "Unable to reach Ask Prana server.";
}

function voiceErrorMessage(error: unknown) {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = detail.toLowerCase();

  if (detail === "VOICE_PERMISSION") {
    return "Microphone permission is required for voice dictation.";
  }
  if (detail === "VOICE_SHORT") {
    return "That recording was too short. Please try again.";
  }
  if (detail === "VOICE_FORMAT" || normalized.includes("unsupported audio")) {
    return "That voice recording format isn't supported. Please try again.";
  }
  if (
    detail === "VOICE_NETWORK" ||
    normalized.includes("failed to fetch") ||
    normalized.includes("network request failed")
  ) {
    return "Couldn't reach the speech service. Check your connection and try again.";
  }
  if (detail === "VOICE_EMPTY") {
    return "No speech was detected. Your draft was left unchanged — try recording again.";
  }
  if (detail === "VOICE_TRANSCRIBE" || detail === "VOICE_CREDITS") {
    return detail === "VOICE_CREDITS"
      ? "Cloud speech is unavailable (API credits). On web, Ask Prana now uses the browser microphone instead — try again."
      : "Could not convert that recording to text. Please try again.";
  }
  return "Voice transcription failed. Please try recording again.";
}

async function promptMicrophonePermissionDenied(canAskAgain: boolean) {
  const buttons: {
    text: string;
    style?: "cancel" | "default" | "destructive";
    onPress?: () => void;
  }[] = [{ text: "OK", style: "cancel" }];

  if (!canAskAgain && Platform.OS !== "web") {
    buttons.push({
      text: "Open Settings",
      onPress: () => {
        void Linking.openSettings().catch(() => undefined);
      },
    });
  }

  Alert.alert(
    "Microphone permission needed",
    canAskAgain
      ? "Allow microphone access so Ask Prana can turn your speech into text in the message box."
      : "Microphone access is blocked. Enable it in system Settings, then return and try again.",
    buttons,
  );
}

function toAskPranaAttachment(
  input: {
    filePath?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
    messageType?: ChatMessageType;
    kind?: AskPranaAttachment["kind"];
  },
): AskPranaAttachment | null {
  const filePath = input.filePath?.trim() ?? "";
  if (!filePath || isLocalDeviceUri(filePath)) {
    return null;
  }

  // Voice notes are transcribed separately and must never enter the
  // image/document attachment validator on the ask-prana function.
  if (isAudioAttachmentInput(input)) {
    return null;
  }

  const isImage =
    input.kind === "image" ||
    input.messageType === "image" ||
    input.mimeType?.startsWith("image/") === true;

  return {
    filePath,
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? null,
    kind: isImage ? "image" : "file",
  };
}

function collectRecentAttachments(messages: ChatMessage[]): AskPranaAttachment[] {
  const collected: AskPranaAttachment[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.id === "welcome" || message.role !== "user") {
      continue;
    }
    const attachment = toAskPranaAttachment(message);
    if (!attachment || seen.has(attachment.filePath)) {
      continue;
    }
    seen.add(attachment.filePath);
    collected.push(attachment);
  }

  return collected.slice(-MAX_ATTACHMENT_COUNT);
}

/** Only reuse a prior file when the farmer clearly asks to look at it again. */
function farmerExplicitlyReferencesPreviousAttachment(question: string) {
  const text = question.trim();
  if (!text) {
    return false;
  }
  return (
    /\b(image|photo|picture|file|document|attachment)\s+i\s+(sent|uploaded|shared|attached)\b/i.test(
      text,
    ) ||
    /\b(earlier|previous|last|before)\s+(image|photo|picture|file|document|attachment)\b/i.test(
      text,
    ) ||
    /\b(look|check|review|analyse|analyze)\s+again\b[\s\S]{0,40}\b(image|photo|picture)\b/i.test(
      text,
    ) ||
    /\b(that|the)\s+(image|photo|picture)\s+i\s+(sent|uploaded|shared|attached)\b/i.test(
      text,
    )
  );
}

function historyTextForMessage(message: ChatMessage) {
  const body =
    message.messageType === "audio"
      ? message.transcript || message.text
      : message.text;
  const hadImage =
    message.role === "user" &&
    (message.messageType === "image" ||
      message.mimeType?.startsWith("image/") === true);
  const hadFile = message.role === "user" && message.messageType === "document";
  if (hadImage) {
    return `[Previous message included an image; it is not attached to this request unless the farmer asked to review it.] ${body}`.trim();
  }
  if (hadFile) {
    return `[Previous message included a file; it is not attached to this request unless the farmer asked to review it.] ${body}`.trim();
  }
  if (message.role === "assistant" && message.messageType === "document") {
    return `[Generated downloadable file: ${message.fileName ?? "document"}] ${body}`.trim();
  }
  return body;
}

function resolveCurrentRequestAttachments(
  explicitAttachments: AskPranaAttachment[],
  historyMessages: ChatMessage[],
  question: string,
): AskPranaAttachment[] {
  if (explicitAttachments.length > 0) {
    return explicitAttachments.slice(0, MAX_ATTACHMENT_COUNT);
  }

  // Normal text questions must never re-send old binaries.
  if (!farmerExplicitlyReferencesPreviousAttachment(question)) {
    return [];
  }

  const previous = collectRecentAttachments(historyMessages);
  return previous.slice(-1);
}

function defaultQuestionForPending(
  pending: AskPranaPendingAttachment[],
  isGeneric: boolean,
) {
  const hasImage = pending.some((item) => item.kind === "image");
  const hasFile = pending.some((item) => item.kind === "file");
  if (hasImage && hasFile) {
    return isGeneric
      ? "Please analyze the attached images and documents. No pond records are available."
      : "Please analyze the attached images and documents using this pond's records and last 7 days of history.";
  }
  if (hasImage) {
    return isGeneric
      ? "Analyze this animal image for visible health abnormalities. Describe the visible signs, possible conditions, and confidence. Do not invent pond conditions. Do not claim a disease is confirmed from the image alone."
      : "Analyze this animal image for visible health abnormalities. Describe the visible signs, possible conditions, confidence, relevant pond evidence, and what the farmer should check next. Do not claim a disease is confirmed from the image alone.";
  }
  if (hasFile) {
    return isGeneric
      ? "Please analyze the attached document. No pond records are available."
      : "Please analyze the attached document using this pond's records.";
  }
  return "";
}

function resolveThinkingKind(
  requestContext?: AskPranaRequestContext,
): AskPranaThinkingKind {
  const attachments = requestContext?.attachments ?? [];
  const hasImage = attachments.some((attachment) => attachment.kind === "image");
  const hasFile = attachments.some(
    (attachment) =>
      attachment.kind === "file" || attachment.kind === "document",
  );
  if (hasImage && hasFile) {
    return "attachments";
  }
  if (hasImage) {
    return "image";
  }
  if (hasFile) {
    return "document";
  }
  return "text";
}

type AskPranaChatContextValue = {
  messages: ChatMessage[];
  draft: string;
  isSending: boolean;
  isUploading: boolean;
  attachmentError: string | null;
  isRecording: boolean;
  isTranscribing: boolean;
  isLoadingMessages: boolean;
  isAuthLoading: boolean;
  thinkingKind: AskPranaThinkingKind | null;
  generationStopped: boolean;
  pendingAttachments: AskPranaPendingAttachment[];
  ponds: AskPranaChatPondOption[];
  selectedPondId: string | null;
  selectedPondName: string | null;
  isGenericMode: boolean;
  activeSessionId: string | null;
  setDraft: (value: string) => void;
  setSelectedPondId: (pondId: string) => void;
  removePendingAttachment: (id: string) => void;
  sendQuestion: (
    question: string,
    requestContext?: AskPranaRequestContext,
  ) => Promise<string | null>;
  /**
   * ChatGPT-style edit: remove this user turn and everything after it, then
   * resend the edited text as a fresh question.
   */
  editAndResendUserMessage: (
    messageId: string,
    text: string,
    requestContext?: AskPranaRequestContext,
  ) => Promise<string | null>;
  /**
   * Voice-mode ask path: ignores stale isRecording/isTranscribing flags after
   * mic stop, returns assistant text + resolved reply language for TTS.
   */
  askFromVoiceMode: (
    question: string,
    requestContext?: AskPranaRequestContext,
  ) => Promise<{
    answer: string;
    language: AskPranaSpeechLanguageCode;
  } | null>;
  /** Call when opening voice mode so the first turn starts a fresh shared session. */
  prepareVoiceModeSession: () => void;
  sendImageAttachment: (requestContext?: AskPranaRequestContext) => Promise<void>;
  sendDocumentAttachment: (
    requestContext?: AskPranaRequestContext,
  ) => Promise<void>;
  startAudioRecording: (options?: {
    source?: "composer" | "voice";
    /** Voice mode needs a rejected promise to leave its listening state. */
    throwOnFailure?: boolean;
  }) => Promise<void>;
  /**
   * @deprecated Composer dictation must never auto-send. Prefer
   * stopAudioRecordingToComposer. Kept for rare call sites that intentionally send.
   */
  stopAudioRecordingAndSend: (
    requestContext?: AskPranaRequestContext,
  ) => Promise<void>;
  /** Stop mic, transcribe, put text in composer for review (does not auto-send). */
  stopAudioRecordingToComposer: () => Promise<string | null>;
  /** Stop mic and return transcript only (for voice conversation turns). */
  stopAudioRecordingToTranscript: () => Promise<string | null>;
  /** Discard in-progress dictation recording/transcription; preserves draft. */
  cancelAudioRecording: () => Promise<void>;
  stopGeneration: () => void;
  refreshPonds: (userId?: string | null) => Promise<void>;
  reloadMessages: () => Promise<void>;
  startNewConversation: () => Promise<void>;
  openConversation: (sessionId: string) => Promise<void>;
  listConversations: () => Promise<AskPranaSessionSummary[]>;
  listConversationPage: (
    cursor?: string | null,
  ) => Promise<{ sessions: AskPranaSessionSummary[]; nextCursor: string | null }>;
  conversationActivity: {
    id: string;
    preview: string;
    lastActivity: string;
    nonce: number;
  } | null;
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  loadOlderMessages: () => Promise<void>;
  renameConversation: (
    sessionId: string,
    title: string,
  ) => Promise<{ error: Error | null }>;
  deleteConversation: (
    sessionId: string,
  ) => Promise<{ error: Error | null }>;
};

const AskPranaChatContext = createContext<AskPranaChatContextValue | null>(null);

function buildWelcomeMessage(farmerName: string): ChatMessage {
  return {
    id: "welcome",
    role: "assistant",
    text: `Hi, ${farmerName}! \u{1F44B}\nI'm Ask Prana, your pond assistant. Ask me anything about your pond or farming.`,
    messageType: "text",
  };
}

function buildAttachmentPrompt(
  messageType: Exclude<ChatMessageType, "text">,
  fileName: string,
  transcript?: string | null,
  draftQuestion?: string | null,
  isGeneric?: boolean,
) {
  const extra = draftQuestion?.trim() ?? "";
  if (messageType === "audio") {
    return extra || (transcript?.trim() ?? "");
  }

  if (extra) {
    return extra;
  }

  if (messageType === "image") {
    return isGeneric
      ? "Analyze this animal image for visible health abnormalities. Describe the visible signs, possible conditions, and confidence. Do not invent pond conditions. Do not claim a disease is confirmed from the image alone."
      : "Analyze this animal image for visible health abnormalities. Describe the visible signs, possible conditions, confidence, relevant pond evidence, and what the farmer should check next. Do not claim a disease is confirmed from the image alone.";
  }

  return isGeneric
    ? "Please analyze the attached document. No pond records are available."
    : "Please analyze the attached document using this pond's records.";
}

export function AskPranaChatProvider({ children }: { children: ReactNode }) {
  const { displayName } = useProfile();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationActivity, setConversationActivity] = useState<{
    id: string;
    preview: string;
    lastActivity: string;
    nonce: number;
  } | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [thinkingKind, setThinkingKind] = useState<AskPranaThinkingKind | null>(
    null,
  );
  const [generationStopped, setGenerationStopped] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    AskPranaPendingAttachment[]
  >([]);
  const [ponds, setPonds] = useState<AskPranaChatPondOption[]>([]);
  const [selectedPondId, setSelectedPondIdState] = useState<string | null>(
    GENERIC_ASSISTANT_ID,
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    setConversationActivity(null);
    setHasOlderMessages(false);
  }, [userId]);
  /**
   * Recently opened conversations (per user) so reopening one from History
   * renders instantly while a fresh copy loads. Display-only; never written back.
   */
  const openedConversationCacheRef = useRef(new Map<string, ChatMessage[]>());
  const farmerName = displayName;
  const [authLoading, setAuthLoading] = useState(true);

  const audioRecorder = useAudioRecorder(ASK_PRANA_VOICE_RECORDING_OPTIONS);
  const audioRecorderRef = useRef(audioRecorder);
  const voiceBusyRef = useRef(false);
  const voiceStopInFlightRef = useRef(false);
  /** Bumped on cancel / pond switch so late transcripts are ignored. */
  const dictationEpochRef = useRef(0);
  /** Ignore AppState blips (permission dialog → inactive) right after start. */
  const recordingGuardUntilRef = useRef(0);
  /** Earliest time Stop is allowed (avoids start+stop double-tap). */
  const recordingStopAllowedAtRef = useRef(0);
  const voiceSilenceWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedPondIdForDictationRef = useRef<string | null>(null);
  const webDictationRef = useRef<WebDictationSession | null>(null);
  const webDictationBaseDraftRef = useRef("");
  const webDictationSourceRef = useRef<"composer" | "voice">("composer");
  const draftRef = useRef("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const welcomeReadyRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const sessionCreatePromiseRef = useRef<Promise<string> | null>(null);
  const sessionCreateEpochRef = useRef(0);
  const chatScopeRef = useRef<string>("");
  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const pondsRequestRef = useRef<Promise<void> | null>(null);
  const pondsRequestUserIdRef = useRef<string | null>(null);
  const generationIdRef = useRef(0);
  const sendEpochRef = useRef(0);
  /** Bumped on pond/user scope change to discard stale history loads and replies. */
  const pondLoadEpochRef = useRef(0);
  const selectedPondIdRef = useRef<string | null>(null);
  const pendingAttachmentsRef = useRef<AskPranaPendingAttachment[]>([]);
  const isSendingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const isTranscribingRef = useRef(false);
  const isUploadingRef = useRef(false);
  const voiceModeSessionStartedRef = useRef(false);
  const lastResolvedLanguageRef = useRef<AskPranaSpeechLanguageCode>("en");

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    selectedPondIdRef.current = selectedPondId;
  }, [selectedPondId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  useEffect(() => {
    isUploadingRef.current = isUploading;
  }, [isUploading]);

  useEffect(() => {
    audioRecorderRef.current = audioRecorder;
  }, [audioRecorder]);

  const clearVoiceSilenceWatch = useCallback(() => {
    if (voiceSilenceWatchRef.current) {
      clearInterval(voiceSilenceWatchRef.current);
      voiceSilenceWatchRef.current = null;
    }
  }, []);

  const startVoiceSilenceWatch = useCallback(() => {
    clearVoiceSilenceWatch();
    let speechStartedAt = 0;
    let silenceStartedAt = 0;
    let armed = false;
    voiceSilenceWatchRef.current = setInterval(() => {
      if (webDictationSourceRef.current !== "voice" || !isRecordingRef.current) {
        return;
      }
      const level = audioRecorderRef.current?.getStatus()?.metering;
      if (typeof level !== "number") return;
      const now = Date.now();
      if (level >= VOICE_SPEECH_DB) {
        if (!speechStartedAt) speechStartedAt = now;
        silenceStartedAt = 0;
        if (now - speechStartedAt >= VOICE_SPEECH_HOLD_MS) armed = true;
        return;
      }
      speechStartedAt = 0;
      if (!armed || level > VOICE_SILENCE_DB) {
        silenceStartedAt = 0;
        return;
      }
      if (!silenceStartedAt) silenceStartedAt = now;
      if (
        now - silenceStartedAt >= VOICE_SILENCE_MS &&
        now >= recordingStopAllowedAtRef.current
      ) {
        clearVoiceSilenceWatch();
        notifyVoiceAutoStop();
      }
    }, 120);
  }, [clearVoiceSilenceWatch]);

  const releaseRecordingResources = useCallback(async () => {
    const recorder = audioRecorderRef.current;
    try {
      if (recorder.isRecording) {
        await recorder.stop();
      }
    } catch (error) {
      console.log("[AskPranaChat] recorder stop during release failed:", error);
    }
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
    } catch (error) {
      console.log("[AskPranaChat] audio mode reset failed:", error);
    }
  }, []);

  const cancelAudioRecording = useCallback(async () => {
    clearVoiceSilenceWatch();
    dictationEpochRef.current += 1;
    voiceStopInFlightRef.current = false;
    recordingGuardUntilRef.current = 0;
    recordingStopAllowedAtRef.current = 0;

    const webSession = webDictationRef.current;
    webDictationRef.current = null;
    if (webSession) {
      webSession.cancel();
      if (webDictationSourceRef.current === "composer") {
        setDraft(webDictationBaseDraftRef.current);
      }
      isRecordingRef.current = false;
      isTranscribingRef.current = false;
      setIsRecording(false);
      setIsTranscribing(false);
      voiceBusyRef.current = false;
      console.log("[AskPranaChat] web dictation cancelled; draft preserved");
      return;
    }

    const wasLive =
      isRecordingRef.current || Boolean(audioRecorderRef.current?.isRecording);
    isRecordingRef.current = false;
    isTranscribingRef.current = false;
    setIsRecording(false);
    setIsTranscribing(false);
    voiceBusyRef.current = false;
    if (wasLive) {
      try {
        await audioRecorderRef.current.stop();
      } catch (error) {
        console.log("[AskPranaChat] cancel stop failed:", error);
      }
    }
    await releaseRecordingResources();
    console.log("[AskPranaChat] dictation cancelled; draft preserved");
  }, [clearVoiceSilenceWatch, releaseRecordingResources]);

  const clearStuckRecordingFlag = useCallback(() => {
    if (webDictationRef.current) {
      return;
    }
    if (isRecordingRef.current && !audioRecorderRef.current?.isRecording) {
      console.log("[AskPranaChat] clearing stuck isRecording flag");
      isRecordingRef.current = false;
      setIsRecording(false);
      voiceBusyRef.current = false;
      voiceStopInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearVoiceSilenceWatch();
      void releaseRecordingResources();
    };
  }, [clearVoiceSilenceWatch, releaseRecordingResources]);

  useEffect(() => {
    const previous = selectedPondIdForDictationRef.current;
    selectedPondIdForDictationRef.current = selectedPondId;
    if (previous != null && previous !== selectedPondId) {
      void cancelAudioRecording();
    }
  }, [selectedPondId, cancelAudioRecording]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // Permission dialogs / brief focus loss use "inactive" — do not cancel there.
      // Only tear down when the app is truly backgrounded.
      if (nextState !== "background") {
        return;
      }
      if (Date.now() < recordingGuardUntilRef.current) {
        console.log("[AskPranaChat] skip background cancel during recording guard");
        return;
      }
      if (
        isRecordingRef.current ||
        Boolean(audioRecorderRef.current?.isRecording) ||
        Boolean(webDictationRef.current)
      ) {
        void cancelAudioRecording();
      }
    });
    return () => subscription.remove();
  }, [cancelAudioRecording]);

  const setActiveSessionId = useCallback((nextSessionId: string | null) => {
    sessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
  }, []);

  const refreshPonds = useCallback(async (nextUserId?: string | null) => {
    setPonds([]);
    setSelectedPondIdState(GENERIC_ASSISTANT_ID);
    return;

    /* Pond-specific context is intentionally disabled for generic assistance. */
    // eslint-disable-next-line no-unreachable
    const resolvedUserId = nextUserId ?? userId;

    if (!resolvedUserId) {
      setPonds([]);
      setSelectedPondIdState((current) =>
        current === GENERIC_ASSISTANT_ID ? current : GENERIC_ASSISTANT_ID,
      );
      return;
    }

    if (
      pondsRequestRef.current &&
      pondsRequestUserIdRef.current === resolvedUserId
    ) {
      await pondsRequestRef.current;
      return;
    }

    pondsRequestUserIdRef.current = resolvedUserId;
    pondsRequestRef.current = (async () => {
      let result: { data: Array<{ id: string; name?: string | null }> | null; error: { message?: string } | null };
      try {
        const session = await ensureValidSession();
        if (!session?.user?.id) {
          result = { data: [], error: { message: "User not logged in" } };
        } else {
          result = await supabase
            .from("ponds")
            .select("id, name")
            .eq("user_id", session.user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false });
        }
      } catch (error) {
        if (isRecoverableAuthError(error) ||
          (error instanceof Error && error.message.includes("session"))) {
          console.warn("[AskPranaChat] Pond loading paused: authentication unavailable.");
          setPonds([]);
          return;
        }
        console.error("[AskPranaChat] Pond query failed:", error);
        return;
      }

      const { data, error } = result;

      if (error) {
        if (error.message === "User not logged in") {
          setPonds([]);
          setSelectedPondIdState((current) =>
            current === GENERIC_ASSISTANT_ID ? current : GENERIC_ASSISTANT_ID,
          );
          return;
        }

        if (isRecoverableAuthError(error)) {
          console.warn("[AskPranaChat] Pond loading paused: session recovery failed.");
        } else {
          console.error("[AskPranaChat] Pond database query failed:", error);
        }
        return;
      }

      const nextPonds = (data ?? []).map((pond) => ({
        id: pond.id,
        pondName: pond.name?.trim() || "Pond",
      }));

      setPonds(nextPonds);
      setSelectedPondIdState((current) => {
        if (current === GENERIC_ASSISTANT_ID) {
          return current;
        }
        if (current && nextPonds.some((pond) => pond.id === current)) {
          return current;
        }
        return nextPonds[0]?.id ?? GENERIC_ASSISTANT_ID;
      });
    })().finally(() => {
      pondsRequestRef.current = null;
      pondsRequestUserIdRef.current = null;
    });

    await pondsRequestRef.current;
  }, [userId]);

  const isGenericMode = selectedPondId === GENERIC_ASSISTANT_ID;

  const selectedPondName = useMemo(() => {
    if (selectedPondId === GENERIC_ASSISTANT_ID) {
      return GENERIC_ASSISTANT_LABEL;
    }
    const match = ponds.find((pond) => pond.id === selectedPondId);
    return match?.pondName ?? null;
  }, [ponds, selectedPondId]);

  const resolveContext = useCallback(
    (requestContext?: AskPranaRequestContext) => {
      const requestedPondId =
        requestContext?.pondId ??
        selectedPondIdRef.current ??
        selectedPondId;
      const useGeneric = isGenericAssistantId(requestedPondId);
      const pondId = useGeneric ? null : requestedPondId;

      return {
        useGeneric,
        pondId,
        cycleId: useGeneric ? null : requestContext?.cycleId ?? null,
        screen: requestContext?.screen ?? null,
        mode: useGeneric ? ("generic" as const) : ("pond" as const),
      };
    },
    [selectedPondId],
  );

  const loadSessionMessages = useCallback(
    async (nextPondId: string | null, nextUserId: string | null) => {
      // Drop any in-flight session create / reply from the previous pond.
      const epoch = ++pondLoadEpochRef.current;
      sendEpochRef.current += 1;
      generationIdRef.current += 1;
      sessionCreateEpochRef.current += 1;
      sessionCreatePromiseRef.current = null;
      voiceModeSessionStartedRef.current = false;
      void stopAskPranaSpeech();

      setIsSending(false);
      setThinkingKind(null);
      setGenerationStopped(false);
      setIsLoadingMessages(true);
      setActiveSessionId(null);

      const welcome = buildWelcomeMessage(farmerName);
      setMessages([welcome]);
      messagesRef.current = [welcome];

      // History belongs in the conversation list. Only openConversation loads
      // stored messages, and it always fetches one session at a time.
      void nextPondId;
      void nextUserId;
      if (epoch === pondLoadEpochRef.current) {
        setIsLoadingMessages(false);
      }
    },
    [farmerName, setActiveSessionId],
  );

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      const session = await waitForAuthReady();

      if (!mounted) {
        return;
      }

      const nextUserId = session?.user?.id ?? null;
      setUserId(nextUserId);
      if (!nextUserId) {
        setPonds([]);
        setSelectedPondIdState((current) =>
          current === GENERIC_ASSISTANT_ID ? current : GENERIC_ASSISTANT_ID,
        );
        welcomeReadyRef.current = true;
        setAuthLoading(false);
        return;
      }

      try {
        await refreshPonds(nextUserId);
      } finally {
        if (mounted) {
          welcomeReadyRef.current = true;
          setAuthLoading(false);
        }
      }
    };

    if (!bootstrapPromiseRef.current) {
      bootstrapPromiseRef.current = bootstrap().finally(() => {
        bootstrapPromiseRef.current = null;
      });
    }

    void bootstrapPromiseRef.current;

    const unsubscribeAuth = subscribeToAuthSession(
      (session) => {
        if (!mounted) {
          return;
        }

        const nextUserId = session?.user?.id ?? null;
        setUserId(nextUserId);
        setAuthLoading(false);

        if (!nextUserId) {
          // Signed out: drop the previous user's unsent input and cached
          // translations. The userId change below also resets the open
          // conversation and invalidates in-flight replies (see scopeKey).
          // Nothing is deleted from Supabase.
          setDraft("");
          setPendingAttachments([]);
          clearAskPranaDisplayTranslations();
          openedConversationCacheRef.current.clear();
          setPonds([]);
          setSelectedPondIdState((current) =>
            current === GENERIC_ASSISTANT_ID ? current : GENERIC_ASSISTANT_ID,
          );
          return;
        }

        void refreshPonds(nextUserId);
      },
    );

    return () => {
      mounted = false;
      unsubscribeAuth();
    };
  }, [refreshPonds]);

  useEffect(() => {
    const welcome = buildWelcomeMessage(farmerName);
    setMessages((current) => {
      const welcomeIndex = current.findIndex((message) => message.id === "welcome");
      if (welcomeIndex < 0) {
        return current;
      }
      if (current[welcomeIndex]?.text === welcome.text) {
        return current;
      }
      const next = [...current];
      next[welcomeIndex] = { ...current[welcomeIndex], ...welcome };
      return next;
    });
  }, [farmerName]);

  useEffect(() => {
    if (authLoading || !welcomeReadyRef.current) {
      return;
    }

    // Only reset the chat when pond/user scope changes â€” not when the
    // loadSessionMessages callback identity changes (e.g. farmerName load),
    // which would wipe a conversation opened from History.
    const scopeKey = `${userId ?? ""}:${selectedPondId ?? ""}`;
    if (chatScopeRef.current === scopeKey) {
      return;
    }
    chatScopeRef.current = scopeKey;

    void loadSessionMessages(selectedPondId, userId);
  }, [authLoading, selectedPondId, userId, loadSessionMessages]);

  const ensureSession = useCallback(async (): Promise<string> => {
    const requestEpoch = sessionCreateEpochRef.current;
    const existingSessionId = sessionIdRef.current;
    if (isValidAskPranaUuid(existingSessionId)) {
      return existingSessionId;
    }

    // Drop invalid values like "undefined" / "" so we recreate cleanly.
    if (sessionIdRef.current) {
      console.log("[AskPranaChat] clearing invalid sessionId:", sessionIdRef.current);
      setActiveSessionId(null);
    }

    let resolvedUserId = userId;
    if (!isValidAskPranaUuid(resolvedUserId)) {
      const authSession = await ensureValidSession();
      resolvedUserId = authSession?.user?.id ?? null;
      if (isValidAskPranaUuid(resolvedUserId)) {
        setUserId(resolvedUserId);
      }
    }

    if (!isValidAskPranaUuid(resolvedUserId)) {
      throw new Error("No active session. Please sign in again.");
    }
    if (requestEpoch !== sessionCreateEpochRef.current) {
      throw new Error("Conversation changed before it could start.");
    }

    // Reuse one in-flight create so user + assistant (or rapid sends)
    // never open multiple sessions for the same turn.
    if (sessionCreatePromiseRef.current) {
      return sessionCreatePromiseRef.current;
    }

    const pondId =
      selectedPondIdRef.current === GENERIC_ASSISTANT_ID
        ? null
        : selectedPondIdRef.current;

    if (pondId != null && !isValidAskPranaUuid(pondId)) {
      throw new Error("Invalid pond_id.");
    }

    const createPromise = (async () => {
      const activeSessionId = sessionIdRef.current;
      if (isValidAskPranaUuid(activeSessionId)) {
        return activeSessionId;
      }

      const mode = pondId ? "pond" : "generic";
      const { sessionId: nextSessionId, error } = await createAskPranaSession(
        resolvedUserId,
        pondId,
        {
          farmerName,
          pondName:
            mode === "generic"
              ? "Generic"
              : selectedPondName ?? "Pond",
          mode,
        },
      );

      if (error || !isValidAskPranaUuid(nextSessionId)) {
        console.log("[AskPranaChat] ensure session error:", error);
        return "";
      }

      if (requestEpoch !== sessionCreateEpochRef.current) {
        await deleteAskPranaSession(nextSessionId);
        throw new Error("Conversation changed before its first message was saved.");
      }

      setActiveSessionId(nextSessionId);
      console.log("[AskPranaChat] session ready", {
        sessionId: nextSessionId,
        pondId,
        userId: resolvedUserId,
      });
      return nextSessionId;
    })();

    sessionCreatePromiseRef.current = createPromise;
    try {
      return await createPromise;
    } finally {
      if (sessionCreatePromiseRef.current === createPromise) {
        sessionCreatePromiseRef.current = null;
      }
    }
  }, [farmerName, selectedPondName, setActiveSessionId, userId]);

  const startNewConversation = useCallback(async () => {
    // Clear UI only â€” session is created on the first sent message so
    // empty threads do not clutter history.
    pondLoadEpochRef.current += 1;
    sendEpochRef.current += 1;
    generationIdRef.current += 1;
    sessionCreateEpochRef.current += 1;
    void cancelAudioRecording();
    sessionCreatePromiseRef.current = null;
    setActiveSessionId(null);
    setDraft("");
    setPendingAttachments([]);
    setIsSending(false);
    setIsLoadingMessages(false);
    setThinkingKind(null);
    const welcome = buildWelcomeMessage(farmerName);
    setMessages([welcome]);
    messagesRef.current = [welcome];
    setGenerationStopped(false);
    voiceModeSessionStartedRef.current = false;

    if (!userId) {
      Alert.alert(
        "Sign in required",
        "Please sign in again to start a new conversation.",
      );
    }
  }, [cancelAudioRecording, farmerName, setActiveSessionId, userId]);

  const openConversation = useCallback(
    async (nextSessionId: string) => {
      const requestPondId = selectedPondIdRef.current;
      const epoch = ++pondLoadEpochRef.current;
      sendEpochRef.current += 1;
      generationIdRef.current += 1;
      sessionCreateEpochRef.current += 1;
      setIsSending(false);
      setThinkingKind(null);
      const expectedPondId =
        !requestPondId || requestPondId === GENERIC_ASSISTANT_ID
          ? null
          : requestPondId;

      const openStartedAt = Date.now();
      const cacheKey = `${userId ?? ""}:${nextSessionId}`;
      const cachedMessages = openedConversationCacheRef.current.get(cacheKey);
      // Cached: show it now and refresh quietly; otherwise show the loader.
      setIsLoadingMessages(!cachedMessages);
      sessionCreatePromiseRef.current = null;
      setActiveSessionId(nextSessionId);
      setDraft("");
      setPendingAttachments([]);
      setGenerationStopped(false);
      const initialMessages = cachedMessages ?? [buildWelcomeMessage(farmerName)];
      setMessages(initialMessages);
      messagesRef.current = initialMessages;

      try {
        // Session ownership/pond check and the message fetch are independent
        // reads (both filtered by user/pond), so run them in parallel; the
        // messages are only shown after the checks below pass.
        const [
          { pondId: sessionPondId, userId: sessionUserId, error: metaError },
          fetchedMessages,
        ] = await Promise.all([
          getAskPranaSessionPondId(nextSessionId, userId ?? undefined),
          fetchAskPranaMessages(nextSessionId, userId ?? undefined),
        ]);

        if (epoch !== pondLoadEpochRef.current) {
          return;
        }
        if (selectedPondIdRef.current !== requestPondId) {
          return;
        }

        if (metaError) {
          console.log("[AskPranaChat] open conversation meta error:", metaError);
          Alert.alert(
            "Unable to open conversation",
            metaError.message || "Please try again.",
          );
          setActiveSessionId(null);
          setMessages([buildWelcomeMessage(farmerName)]);
          return;
        }

        if (userId && sessionUserId && sessionUserId !== userId) {
          Alert.alert(
            "Unable to open conversation",
            "This conversation belongs to another account.",
          );
          setActiveSessionId(null);
          setMessages([buildWelcomeMessage(farmerName)]);
          return;
        }

        if ((sessionPondId ?? null) !== (expectedPondId ?? null)) {
          Alert.alert(
            "Unable to open conversation",
            "This conversation belongs to a different pond.",
          );
          setActiveSessionId(null);
          setMessages([buildWelcomeMessage(farmerName)]);
          return;
        }

        const { messages: storedMessages, hasMore, error } = fetchedMessages;
        setHasOlderMessages(Boolean(hasMore));

        if (error) {
          console.log("[AskPranaChat] open conversation error:", error);
          Alert.alert(
            "Unable to open conversation",
            error.message || "Please try again.",
          );
          setActiveSessionId(null);
          setMessages([buildWelcomeMessage(farmerName)]);
          return;
        }

        if (storedMessages.length > 0) {
          const cache = openedConversationCacheRef.current;
          cache.delete(cacheKey);
          cache.set(cacheKey, storedMessages);
          if (cache.size > 20) cache.delete(cache.keys().next().value as string);
        }
        if (__DEV__) {
          console.log("[AskPranaChat] conversation opened", {
            cacheHit: Boolean(cachedMessages),
            messages: storedMessages.length,
            fetchMs: Date.now() - openStartedAt,
          });
        }
        // Don't clobber a turn the farmer started while the cached copy showed.
        if (cachedMessages && messagesRef.current !== initialMessages) {
          return;
        }
        setDraft("");
        setMessages(
          storedMessages.length > 0
            ? storedMessages
            : [buildWelcomeMessage(farmerName)],
        );
      } catch (error) {
        if (epoch !== pondLoadEpochRef.current) {
          return;
        }
        console.log("[AskPranaChat] open conversation failed:", error);
        Alert.alert(
          "Unable to open conversation",
          "Please check your connection and try again.",
        );
        setActiveSessionId(null);
        setMessages([buildWelcomeMessage(farmerName)]);
      } finally {
        if (epoch === pondLoadEpochRef.current) {
          setIsLoadingMessages(false);
        }
      }
    },
    [farmerName, setActiveSessionId, userId],
  );

  const listConversationPage = useCallback(async (cursor?: string | null) => {
    if (!userId) {
      return { sessions: [], nextCursor: null };
    }

    const pondId =
      selectedPondId === GENERIC_ASSISTANT_ID ? null : selectedPondId;

    try {
      const { sessions, nextCursor, error } = await listAskPranaSessionsForPond(
        userId,
        pondId,
        cursor,
      );

      if (error) {
        console.log("[AskPranaChat] list conversations error:", error);
        throw error;
      }

      return { sessions, nextCursor };
    } catch (error) {
      console.log("[AskPranaChat] list conversations failed:", error);
      throw error instanceof Error ? error : new Error("Unable to load your conversation history. Please try again.");
    }
  }, [selectedPondId, userId]);

  const listConversations = useCallback(async () => {
    try {
      const page = await listConversationPage();
      return page.sessions;
    } catch {
      return [];
    }
  }, [listConversationPage]);

  const loadOlderMessages = useCallback(async () => {
    if (!userId || !sessionId || isLoadingOlder || !hasOlderMessages) return;
    const oldest = messagesRef.current.find((message) => message.createdAt);
    const before = oldest?.createdAt;
    if (!before) {
      setHasOlderMessages(false);
      return;
    }
    setIsLoadingOlder(true);
    try {
      const { messages: older, hasMore, error } = await fetchAskPranaMessages(
        sessionId,
        userId,
        { before },
      );
      if (error) return;
      setHasOlderMessages(hasMore);
      if (older.length === 0) return;
      setMessages((current) => {
        const seen = new Set(current.map((message) => message.id));
        const next = [...older.filter((message) => !seen.has(message.id)), ...current];
        messagesRef.current = next;
        return next;
      });
    } finally {
      setIsLoadingOlder(false);
    }
  }, [hasOlderMessages, isLoadingOlder, sessionId, userId]);

  const renameConversation = useCallback(
    async (targetSessionId: string, title: string) => {
      return renameAskPranaSession(targetSessionId, title);
    },
    [],
  );

  const deleteConversation = useCallback(
    async (targetSessionId: string) => {
      const { error } = await deleteAskPranaSession(targetSessionId);
      if (error) {
        return { error };
      }

      if (sessionIdRef.current === targetSessionId) {
        await startNewConversation();
      }

      return { error: null };
    },
    [startNewConversation],
  );

  const persistMessage = useCallback(
    async (message: ChatMessage, pondId: string | null) => {
      if (message.id === "welcome") {
        return message;
      }

      // Never insert messages until a valid session UUID exists.
      const activeSessionId = await ensureSession();
      if (!isValidAskPranaUuid(activeSessionId)) {
        console.log("[AskPranaChat] message not stored; answering without history");
        return message;
      }
      if (!isValidAskPranaUuid(userId)) {
        throw new Error(
          userId ? "Invalid user_id." : "No active session. Please sign in again.",
        );
      }

      const safePondId = isValidAskPranaUuid(pondId) ? pondId : null;
      const mode = safePondId ? "pond" : "generic";

      const { message: saved, error } = await saveAskPranaMessage(
        {
          sessionId: activeSessionId,
          userId,
          pondId: safePondId,
          farmerName,
          pondName:
            mode === "generic"
              ? "Generic"
              : message.pondName ?? selectedPondName ?? "Pond",
          mode,
          role: message.role,
          messageType: message.messageType ?? "text",
          content:
            message.messageType === "audio"
              ? message.transcript ?? message.text
              : message.text,
          filePath: message.filePath ?? null,
          fileName: message.fileName ?? null,
          mimeType: message.mimeType ?? null,
          metadata: {
            screen: "ask-prana",
            localMessageId: message.id,
          },
        },
        message,
      );

      if (error) {
        // Do not interrupt chat UX â€” log only.
        console.error("[AskPranaChat] save message error:", error);
        return message;
      }

      const previewSource = (saved ?? message).text || message.transcript || "";
      const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 80);
      setConversationActivity({
        id: activeSessionId,
        preview,
        lastActivity: (saved ?? message).createdAt || new Date().toISOString(),
        nonce: Date.now(),
      });

      return saved ?? message;
    },
    [ensureSession, farmerName, selectedPondName, userId],
  );

  const requestAssistantReply = useCallback(
    async (
      question: string,
      requestContext?: AskPranaRequestContext,
    ): Promise<ChatMessage> => {
      const context = resolveContext(requestContext);
      const recentMessages = messagesRef.current
        .filter((message) => message.id !== "welcome")
        .slice(-8);
      const history = recentMessages.map((message) => ({
        role: message.role,
        text: historyTextForMessage(message),
      }));

      const explicitAttachments = (requestContext?.attachments ?? [])
        .map((attachment) => toAskPranaAttachment(attachment))
        .filter((attachment): attachment is AskPranaAttachment =>
          Boolean(attachment),
        );
      const attachments = resolveCurrentRequestAttachments(
        explicitAttachments,
        recentMessages,
        question,
      );

      const storedSessionId = await ensureSession();
      const sessionId = isValidAskPranaUuid(storedSessionId) ? storedSessionId : null;

      console.log("[AskPranaChat] openai attachment decision", {
        sessionId,
        pondId: context.pondId,
        questionPreview: question.slice(0, 120),
        explicitAttachmentCount: explicitAttachments.length,
        resolvedAttachmentCount: attachments.length,
        resolvedAttachmentKinds: attachments.map((item) => item.kind),
        reusedPreviousAttachment:
          explicitAttachments.length === 0 && attachments.length > 0,
      });

      const nameForRequest = farmerName !== "Farmer" ? farmerName : null;

      // Match THIS question: Telugu→Telugu, English→English (UI preference is fallback only).
      const sessionCode = requestContext?.sessionLanguageCode
        ? mapToAskPranaLanguageCode(requestContext.sessionLanguageCode)
        : requestContext?.language
          ? mapToAskPranaLanguageCode(requestContext.language)
          : null;
      const forcedVoiceLanguage = requestContext?.voiceModeLanguageLock
        ? mapToAskPranaLanguageCode(requestContext.voiceModeLanguageLock)
        : null;
      const resolvedLanguage = forcedVoiceLanguage
        ? {
            code: forcedVoiceLanguage,
            source: "context" as const,
            llmLabel: getAskPranaLanguageOption(forcedVoiceLanguage).llmLabel,
          }
        : await resolveAndPersistAskPranaReplyLanguage(
            question,
            requestContext?.language,
            sessionCode,
          );
      const teluguScript = await loadTeluguScriptPreference();
      const languageMeta = buildLanguageInstructionForLlm({
        language: resolvedLanguage.code,
        teluguScript,
      });

      const reply = await askPrana(question, {
        ...requestContext,
        pondId: context.pondId,
        cycleId: context.cycleId,
        mode: context.mode,
        screen: context.screen,
        sessionId,
        userId,
        conversationHistory: history,
        attachments,
        farmerDisplayName: nameForRequest,
        language: resolvedLanguage.llmLabel,
        languageNotes: [
          languageMeta.scriptNote,
          `MANDATORY: The farmer's CURRENT question language is ${resolvedLanguage.llmLabel}. Reply to THIS turn entirely in ${resolvedLanguage.llmLabel}.`,
          resolvedLanguage.code === "te"
            ? "Write the full answer in Telugu script (తెలుగు). Do not write the main answer in English."
            : resolvedLanguage.code === "hi"
              ? "Write the full answer in Hindi (Devanagari). Do not write the main answer in English."
              : resolvedLanguage.code === "en"
                ? "Write the full answer in English."
                : `Do not switch to English unless the farmer asked in English.`,
          "Ignore earlier assistant replies in a different language; match only the current farmer question.",
          resolvedLanguage.source === "script"
            ? `Detected from the current message script/text: ${resolvedLanguage.llmLabel}.`
            : `Fallback preferred language: ${resolvedLanguage.llmLabel} (source: ${resolvedLanguage.source}).`,
        ]
          .filter(Boolean)
          .join(" "),
      });

      // Stash last resolved voice/text language for askFromVoiceMode consumers.
      lastResolvedLanguageRef.current = resolvedLanguage.code;

      if (reply.generatedFile) {
        return {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: reply.answer,
          messageType: "document",
          filePath: reply.generatedFile.path,
          fileUrl: reply.generatedFile.url,
          fileName: reply.generatedFile.fileName,
          mimeType: reply.generatedFile.mimeType,
        };
      }

      return {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: reply.answer,
        messageType: "text",
      };
    },
    [ensureSession, resolveContext, userId, farmerName],
  );

  const appendAssistantReply = useCallback(
    async (question: string, requestContext?: AskPranaRequestContext) => {
      const context = resolveContext(requestContext);
      const pondAtStart =
        selectedPondIdRef.current === GENERIC_ASSISTANT_ID
          ? null
          : selectedPondIdRef.current;
      const requestId = ++generationIdRef.current;
      setGenerationStopped(false);
      setThinkingKind(resolveThinkingKind(requestContext));
      try {
        const assistantMessage = await requestAssistantReply(
          question,
          {
            ...requestContext,
            pondId: context.pondId ?? pondAtStart,
            mode: context.mode,
          },
        );
        if (requestId !== generationIdRef.current) {
          return null;
        }
        const pondStillSelected =
          pondAtStart == null
            ? selectedPondIdRef.current === GENERIC_ASSISTANT_ID ||
              selectedPondIdRef.current == null
            : selectedPondIdRef.current === pondAtStart;
        if (!pondStillSelected) {
          return null;
        }
        setThinkingKind(null);
        const answerText = assistantMessage.text?.trim() ?? "";
        const normalizedMessage = {
          ...assistantMessage,
          text:
            answerText ||
            "Sorry — I could not finish that answer just now. Please ask again.",
        };
        setMessages((current) => [...current, normalizedMessage]);
        await persistMessage(
          normalizedMessage,
          context.pondId ?? pondAtStart,
        );
        return normalizedMessage.text;
      } catch (error) {
        if (requestId !== generationIdRef.current) {
          return null;
        }
        const pondStillSelected =
          pondAtStart == null
            ? selectedPondIdRef.current === GENERIC_ASSISTANT_ID ||
              selectedPondIdRef.current == null
            : selectedPondIdRef.current === pondAtStart;
        if (!pondStillSelected) {
          return null;
        }
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : JSON.stringify(error);
        console.log("[AskPranaChat] send error:", error);
        console.log("[AskPranaChat] send error detail:", detail);

        const fallback: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: toFarmerFacingAssistantError(detail),
          messageType: "text",
        };
        setThinkingKind(null);
        setMessages((current) => [...current, fallback]);
        return null;
      }
    },
    [persistMessage, requestAssistantReply, resolveContext],
  );

  const stopGeneration = useCallback(() => {
    if (!thinkingKind && !isSending) {
      return;
    }
    sendEpochRef.current += 1;
    generationIdRef.current += 1;
    setThinkingKind(null);
    setIsSending(false);
    setGenerationStopped(true);
    void stopAskPranaSpeech();
  }, [isSending, thinkingKind]);

  const setSelectedPondId = useCallback(
    (pondId: string) => {
      if (pondId === selectedPondIdRef.current) {
        return;
      }

      // Immediately isolate UI so the previous pond's messages never linger
      // while the pond-scoped history request is in flight.
      pondLoadEpochRef.current += 1;
      sendEpochRef.current += 1;
      generationIdRef.current += 1;
      sessionCreateEpochRef.current += 1;
      sessionCreatePromiseRef.current = null;
      voiceModeSessionStartedRef.current = false;
      void stopAskPranaSpeech();
      setIsSending(false);
      setThinkingKind(null);
      setActiveSessionId(null);
      const welcome = buildWelcomeMessage(farmerName);
      setMessages([welcome]);
      messagesRef.current = [welcome];

      selectedPondIdRef.current = pondId;
      setSelectedPondIdState(pondId);
    },
    [farmerName, setActiveSessionId],
  );

  const sendQuestion = useCallback(
    async (
      question: string,
      requestContext?: AskPranaRequestContext,
      options?: { fromVoiceMode?: boolean },
    ) => {
      const fromVoiceMode = options?.fromVoiceMode === true;
      const trimmed = question.trim();
      const pendingSnapshot = fromVoiceMode
        ? []
        : pendingAttachmentsRef.current;

      if (!trimmed && pendingSnapshot.length === 0) {
        console.log("[AskPranaChat] send blocked: empty question", {
          fromVoiceMode,
        });
        return null;
      }

      if (isSendingRef.current) {
        console.log("[AskPranaChat] send blocked: already sending", {
          fromVoiceMode,
        });
        return null;
      }

      if (
        !fromVoiceMode &&
        (isRecordingRef.current ||
          isTranscribingRef.current ||
          isUploadingRef.current)
      ) {
        console.log("[AskPranaChat] send blocked: composer busy", {
          isRecording: isRecordingRef.current,
          isTranscribing: isTranscribingRef.current,
          isUploading: isUploadingRef.current,
        });
        return null;
      }

      const context = resolveContext(requestContext);
      const sendPondId =
        selectedPondIdRef.current === GENERIC_ASSISTANT_ID
          ? null
          : selectedPondIdRef.current;

      if (!context.useGeneric) {
        if (!isValidAskPranaUuid(sendPondId)) {
          Alert.alert(
            "Select a pond",
            "Choose a pond before asking Prana.",
          );
          return null;
        }
      }

      const scopedContext = {
        ...context,
        pondId: context.useGeneric ? null : sendPondId,
      };

      const mappedAttachments: AskPranaAttachment[] = pendingSnapshot
        .map((item) =>
          toAskPranaAttachment({
            filePath: item.filePath,
            fileName: item.fileName,
            mimeType: item.mimeType,
            kind: item.kind,
          }),
        )
        .filter((item): item is AskPranaAttachment => Boolean(item));

      const apiQuestion =
        trimmed ||
        defaultQuestionForPending(pendingSnapshot, scopedContext.useGeneric);
      const pondName = scopedContext.useGeneric
        ? GENERIC_ASSISTANT_LABEL
        : selectedPondName ?? undefined;

      const userMessages: ChatMessage[] =
        pendingSnapshot.length === 0
          ? [
              {
                id: `user-${Date.now()}`,
                role: "user",
                text: trimmed,
                messageType: "text",
                pondName,
              },
            ]
          : pendingSnapshot.map((item, index) => ({
              id: `user-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
              role: "user" as const,
              text: index === 0 ? trimmed : "",
              messageType:
                item.kind === "image" ? ("image" as const) : ("document" as const),
              fileUrl: item.fileUrl,
              localUri: item.localUri ?? item.fileUrl,
              filePath: item.filePath,
              fileName: item.fileName,
              mimeType: item.mimeType,
              pondName,
            }));

      setMessages((current) => [...current, ...userMessages]);
      if (!fromVoiceMode) {
        setDraft("");
        setPendingAttachments([]);
      }
      setGenerationStopped(false);
      const epoch = ++sendEpochRef.current;
      isSendingRef.current = true;
      setIsSending(true);
      setThinkingKind(
        resolveThinkingKind({ attachments: mappedAttachments }),
      );

      try {
        if (fromVoiceMode) {
          // One shared session for the whole voice conversation.
          if (!voiceModeSessionStartedRef.current || !sessionIdRef.current) {
            sessionCreateEpochRef.current += 1;
            sessionCreatePromiseRef.current = null;
            setActiveSessionId(null);
            voiceModeSessionStartedRef.current = true;
          }
        }

        const sessionId = await ensureSession();
        if (epoch !== sendEpochRef.current) {
          return null;
        }
        console.log("[AskPranaChat] ask started", {
          fromVoiceMode,
          sessionId,
          pondId: scopedContext.pondId,
          questionPreview: apiQuestion.slice(0, 120),
          attachmentCount: mappedAttachments.length,
        });

        for (const userMessage of userMessages) {
          const savedUserMessage = await persistMessage(
            userMessage,
            scopedContext.pondId,
          );
          setMessages((current) =>
            current.map((message) =>
              message.id === userMessage.id ? savedUserMessage : message,
            ),
          );
        }

        if (epoch !== sendEpochRef.current) {
          console.log("[AskPranaChat] ask cancelled after persist");
          return null;
        }

        const pondStillSelected =
          sendPondId == null
            ? selectedPondIdRef.current === GENERIC_ASSISTANT_ID ||
              selectedPondIdRef.current == null
            : selectedPondIdRef.current === sendPondId;
        if (!pondStillSelected) {
          console.log("[AskPranaChat] ask cancelled: pond changed");
          return null;
        }

        const answer = await appendAssistantReply(apiQuestion, {
          ...requestContext,
          pondId: scopedContext.pondId,
          mode: scopedContext.mode,
          attachments: mappedAttachments,
        });
        console.log("[AskPranaChat] ask finished", {
          fromVoiceMode,
          answerLength: answer?.trim().length ?? 0,
        });
        return answer;
      } catch (error) {
        if (epoch !== sendEpochRef.current) {
          return null;
        }
        if (!fromVoiceMode) {
          setDraft(trimmed);
          setPendingAttachments(pendingSnapshot);
        }
        const detailRaw =
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : JSON.stringify(error);
        const detailLower = String(detailRaw || "").toLowerCase();
        const detail =
          !detailRaw?.trim() ||
          detailLower.includes("no response received") ||
          detailLower.includes("empty answer")
            ? "Sorry — I could not finish that answer just now. Please ask again."
            : detailRaw;
        console.log("[AskPranaChat] sendQuestion failed:", error);
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: detail,
            messageType: "text",
          },
        ]);
        // Voice mode still needs spoken text — never return a silent failure.
        return fromVoiceMode ? detail : null;
      } finally {
        if (epoch === sendEpochRef.current) {
          isSendingRef.current = false;
          setIsSending(false);
          setThinkingKind(null);
        }
      }
    },
    [
      appendAssistantReply,
      ensureSession,
      persistMessage,
      resolveContext,
      selectedPondName,
    ],
  );

  const askFromVoiceMode = useCallback(
    async (question: string, requestContext?: AskPranaRequestContext) => {
      console.log("[AskPranaVoice] askFromVoiceMode", {
        questionPreview: question.trim().slice(0, 120),
        isRecording: isRecordingRef.current,
        isTranscribing: isTranscribingRef.current,
        isSending: isSendingRef.current,
      });
      const sessionLanguageCode =
        requestContext?.sessionLanguageCode?.trim() ||
        (requestContext?.language
          ? mapToAskPranaLanguageCode(requestContext.language)
          : null);
      const answer = await sendQuestion(
        question,
        {
          ...requestContext,
          // The explicit Voice Mode header selection is the language for this
          // turn; do not let imperfect STT change it.
          sessionLanguageCode: sessionLanguageCode || undefined,
          language: requestContext?.language,
          voiceModeLanguageLock: sessionLanguageCode || undefined,
          // Lets Ask Prana ask "please say it again" for unclear speech.
          inputMode: "voice",
        },
        { fromVoiceMode: true },
      );
      if (!answer?.trim()) {
        return null;
      }
      return {
        answer,
        language: lastResolvedLanguageRef.current,
      };
    },
    [sendQuestion],
  );

  const editAndResendUserMessage = useCallback(
    async (
      messageId: string,
      text: string,
      requestContext?: AskPranaRequestContext,
    ) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return null;
      }
      setMessages((current) => {
        const index = current.findIndex((item) => item.id === messageId);
        if (index < 0) {
          return current;
        }
        // Drop the edited user message and every reply after it (ChatGPT-style).
        return current.slice(0, index);
      });
      setDraft("");
      return sendQuestion(trimmed, requestContext);
    },
    [sendQuestion],
  );

  const prepareVoiceModeSession = useCallback(() => {
    voiceModeSessionStartedRef.current = false;
    console.log("[AskPranaVoice] prepareVoiceModeSession");
  }, []);

  const sendUploadedAttachment = useCallback(
    async (
      messageType: Exclude<ChatMessageType, "text">,
      upload: {
        filePath: string;
        fileUrl: string;
        fileName: string;
        mimeType: string;
        localUri?: string | null;
      },
      requestContext?: AskPranaRequestContext,
      transcript?: string | null,
      options?: { skipAssistantReply?: boolean; draftQuestion?: string | null },
    ) => {
      const context = resolveContext(requestContext);
      const sendPondId =
        selectedPondIdRef.current === GENERIC_ASSISTANT_ID
          ? null
          : selectedPondIdRef.current;

      if (!context.useGeneric && !isValidAskPranaUuid(sendPondId)) {
        Alert.alert("Select a pond", "Choose a pond before asking Prana.");
        return null;
      }

      const scopedPondId = context.useGeneric ? null : sendPondId;
      const prompt = buildAttachmentPrompt(
        messageType,
        upload.fileName,
        transcript,
        options?.draftQuestion,
        context.useGeneric,
      );

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        text: prompt,
        messageType,
        fileUrl: upload.fileUrl,
        localUri: upload.localUri ?? upload.fileUrl,
        filePath: upload.filePath,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        transcript: transcript ?? null,
        pondName: context.useGeneric
          ? GENERIC_ASSISTANT_LABEL
          : selectedPondName ?? undefined,
      };

      setMessages((current) => [...current, userMessage]);

      const savedUserMessage = await persistMessage(
        userMessage,
        scopedPondId,
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === userMessage.id ? savedUserMessage : message,
        ),
      );

      if (options?.skipAssistantReply) {
        return prompt;
      }

      const isVoiceNote = messageType === "audio";
      const questionText = isVoiceNote ? (transcript?.trim() || prompt.trim()) : prompt;
      if (isVoiceNote && !questionText) {
        return prompt;
      }

      const attachment = isVoiceNote
        ? null
        : toAskPranaAttachment({
            filePath: upload.filePath,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            messageType,
          });

      setIsSending(true);
      const epoch = ++sendEpochRef.current;
      try {
        await appendAssistantReply(questionText, {
          ...requestContext,
          pondId: scopedPondId,
          mode: context.useGeneric ? "generic" : "pond",
          attachments: attachment ? [attachment] : [],
        });
      } finally {
        if (epoch === sendEpochRef.current) {
          setIsSending(false);
        }
      }

      return prompt;
    },
    [
      appendAssistantReply,
      persistMessage,
      resolveContext,
      selectedPondName,
    ],
  );

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((current) =>
      current.filter((item) => item.id !== id),
    );
  }, []);

  const sendImageAttachment = useCallback(
    async (_requestContext?: AskPranaRequestContext) => {
      if (isSending || isUploading || isRecording || isTranscribing) {
        return;
      }

      const pickAndUpload = async (source: "camera" | "gallery") => {
        const remainingSlots = MAX_ATTACHMENT_COUNT - pendingAttachmentsRef.current.length;
        if (remainingSlots <= 0) {
          setAttachmentError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files.`);
          return;
        }

        let resolvedImages: Awaited<ReturnType<typeof pickMultipleImages>> = null;
        if (source === "camera") {
          const single = await pickSingleImage("camera");
          resolvedImages = single ? [single] : null;
        } else {
          resolvedImages = await pickMultipleImages(remainingSlots);
        }
        if (!resolvedImages?.length) return;

        const chosen = resolvedImages.filter((picked) =>
          isSupportedImageAttachment(picked.fileName, picked.mimeType),
        );
        if (chosen.length === 0) {
          setAttachmentError(UNSUPPORTED_FILE_MESSAGE);
          return;
        }

        const localItems: AskPranaPendingAttachment[] = chosen.map((picked, index) => ({
          id: `pending-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "image",
          filePath: "",
          fileUrl: "",
          localUri: picked.uri,
          fileName: picked.fileName,
          mimeType: picked.mimeType,
        }));
        setAttachmentError(null);
        setPendingAttachments((current) =>
          [...current, ...localItems].slice(0, MAX_ATTACHMENT_COUNT),
        );
        setIsUploading(true);
        try {
          for (let index = 0; index < chosen.length; index += 1) {
            const picked = chosen[index];
            const localItem = localItems[index];
            const upload = await uploadAskPranaFile({
              uri: picked.uri,
              folder: "images",
              fileName: picked.fileName,
              mimeType: picked.mimeType,
            });
            if (!upload.data?.filePath) {
              setPendingAttachments((current) => current.filter((item) => item.id !== localItem.id));
              setAttachmentError(upload.error ?? "The selected file could not be read.");
              continue;
            }
            setPendingAttachments((current) =>
              current.map((item) =>
                item.id === localItem.id
                  ? {
                      ...item,
                      filePath: upload.data!.filePath,
                      fileUrl: upload.data!.fileUrl,
                      localUri: upload.data!.localUri ?? picked.uri,
                      fileName: upload.data!.fileName,
                      mimeType: upload.data!.mimeType,
                    }
                  : item,
              ),
            );
          }
        } finally {
          setIsUploading(false);
        }
      };

      promptImageSource((source) => {
        void pickAndUpload(source);
      });
    },
    [isSending, isUploading, isRecording, isTranscribing],
  );

  const sendDocumentAttachment = useCallback(
    async (_requestContext?: AskPranaRequestContext) => {
      if (isSending || isUploading || isRecording || isTranscribing) {
        return;
      }

      const remainingSlots = MAX_ATTACHMENT_COUNT - pendingAttachmentsRef.current.length;
      if (remainingSlots <= 0) {
        setAttachmentError(`You can attach up to ${MAX_ATTACHMENT_COUNT} files.`);
        return;
      }

      const result = await DocumentPicker.getDocumentAsync({
        type: DOCUMENT_MIME_TYPES,
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const assets = result.assets.slice(0, remainingSlots).filter((asset) =>
        isSupportedDocumentAttachment(asset.name, asset.mimeType),
      );
      if (assets.length === 0) {
        setAttachmentError(UNSUPPORTED_FILE_MESSAGE);
        return;
      }

      const localItems: AskPranaPendingAttachment[] = assets.map((asset, index) => ({
        id: `pending-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "file",
        filePath: "",
        fileUrl: "",
        localUri: asset.uri,
        fileName: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
      }));
      setAttachmentError(null);
      setPendingAttachments((current) =>
        [...current, ...localItems].slice(0, MAX_ATTACHMENT_COUNT),
      );
      setIsUploading(true);
      try {
        for (let index = 0; index < assets.length; index += 1) {
          const asset = assets[index];
          const localItem = localItems[index];
          const upload = await uploadAskPranaFile({
            uri: asset.uri,
            folder: "documents",
            fileName: asset.name,
            mimeType: asset.mimeType ?? "application/octet-stream",
          });
          if (!upload.data?.filePath) {
            setPendingAttachments((current) => current.filter((item) => item.id !== localItem.id));
            setAttachmentError(upload.error ?? "The document could not be stored.");
            continue;
          }
          setPendingAttachments((current) =>
            current.map((item) =>
              item.id === localItem.id
                ? {
                    ...item,
                    filePath: upload.data!.filePath,
                    fileUrl: upload.data!.fileUrl,
                    localUri: upload.data!.localUri ?? asset.uri,
                    fileName: upload.data!.fileName,
                    mimeType: upload.data!.mimeType,
                  }
                : item,
            ),
          );
        }
      } finally {
        setIsUploading(false);
      }
    },
    [isSending, isUploading, isRecording, isTranscribing],
  );
  const startAudioRecording = useCallback(async (options?: {
    source?: "composer" | "voice";
    throwOnFailure?: boolean;
  }) => {
    clearStuckRecordingFlag();
    const source = options?.source ?? "composer";

    // Lock immediately (before any await) so double-taps cannot overlap.
    if (
      isRecordingRef.current ||
      isSendingRef.current ||
      isUploadingRef.current ||
      isTranscribingRef.current ||
      voiceBusyRef.current ||
      webDictationRef.current
    ) {
      console.log("[AskPranaChat] start recording skipped", {
        isRecording: isRecordingRef.current,
        recorderLive: Boolean(audioRecorder.isRecording),
        webDictation: Boolean(webDictationRef.current),
        isSending: isSendingRef.current,
        isTranscribing: isTranscribingRef.current,
        voiceBusy: voiceBusyRef.current,
      });
      return;
    }
    voiceBusyRef.current = true;
    webDictationSourceRef.current = source;

    // Web: use browser SpeechRecognition — does not need OpenAI credits.
    if (Platform.OS === "web" && isWebDictationAvailable()) {
      try {
        recordingGuardUntilRef.current = Date.now() + 4000;
        const preferredLanguage = await loadAskPranaPreferredLanguage();
        webDictationBaseDraftRef.current = draftRef.current;
        const session = startWebDictation(preferredLanguage, {
          onPartial: (text) => {
            if (webDictationSourceRef.current !== "composer") {
              return;
            }
            const base = webDictationBaseDraftRef.current.trim();
            const next = base ? `${base} ${text}` : text;
            setDraft(next);
          },
          onError: (message) => {
            Alert.alert("Dictation", message);
          },
          onUtteranceEnd:
            source === "voice"
              ? () => {
                  notifyVoiceAutoStop();
                }
              : undefined,
        });
        webDictationRef.current = session;
        isRecordingRef.current = true;
        setIsRecording(true);
        recordingStopAllowedAtRef.current = Date.now() + 500;
        recordingGuardUntilRef.current = Date.now() + 2500;
        voiceBusyRef.current = false;
        console.log("[AskPranaChat] web dictation started", {
          language: preferredLanguage,
          source,
        });
        return;
      } catch (error) {
        console.log("[AskPranaChat] web dictation start failed:", error);
        webDictationRef.current = null;
        voiceBusyRef.current = false;
        isRecordingRef.current = false;
        setIsRecording(false);
        Alert.alert(
          "Dictation unavailable",
          "Browser speech recognition could not start. Allow microphone access and try Chrome/Edge.",
        );
        return;
      }
    }

    try {
      recordingGuardUntilRef.current = Date.now() + 4000;

      let permission = await getRecordingPermissionsAsync();
      if (!permission.granted) {
        permission = await requestRecordingPermissionsAsync();
      }
      if (!permission.granted) {
        voiceBusyRef.current = false;
        recordingGuardUntilRef.current = 0;
        await promptMicrophonePermissionDenied(permission.canAskAgain !== false);
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync(ASK_PRANA_VOICE_RECORDING_OPTIONS);
      audioRecorder.record();
      isRecordingRef.current = true;
      setIsRecording(true);
      recordingStopAllowedAtRef.current = Date.now() + 700;
      recordingGuardUntilRef.current = Date.now() + 2500;
      voiceBusyRef.current = false;
      if (source === "voice") {
        startVoiceSilenceWatch();
      }
      console.log("[AskPranaChat] recording started");
    } catch (error) {
      console.log("[AskPranaChat] start recording failed:", error);
      voiceBusyRef.current = false;
      isRecordingRef.current = false;
      setIsRecording(false);
      recordingGuardUntilRef.current = 0;
      recordingStopAllowedAtRef.current = 0;
      await releaseRecordingResources();
      Alert.alert(
        "Recording failed",
        "Couldn't start recording. Please try again.",
      );
      // Voice mode needs this rejection to leave its listening state. The
      // composer intentionally keeps its tap handler fire-and-forget.
      if (options?.throwOnFailure) {
        throw error instanceof Error ? error : new Error("VOICE_PERMISSION");
      }
    }
  }, [audioRecorder, clearStuckRecordingFlag, releaseRecordingResources, startVoiceSilenceWatch]);

  const finishWebDictation = useCallback(async (): Promise<string | null> => {
    clearVoiceSilenceWatch();
    const session = webDictationRef.current;
    if (!session) {
      return null;
    }
    if (Date.now() < recordingStopAllowedAtRef.current) {
      console.log("[AskPranaChat] web stop ignored: too soon after start");
      return null;
    }

    const epochAtStart = dictationEpochRef.current;
    webDictationRef.current = null;
    setIsRecording(false);
    setIsTranscribing(true);
    isRecordingRef.current = false;
    isTranscribingRef.current = true;

    try {
      const transcript = (await session.stop()).trim();
      if (epochAtStart !== dictationEpochRef.current) {
        return null;
      }
      if (!transcript) {
        if (webDictationSourceRef.current === "composer") {
          setDraft(webDictationBaseDraftRef.current);
          Alert.alert("Couldn't understand", voiceErrorMessage("VOICE_EMPTY"));
        }
        return null;
      }

      if (webDictationSourceRef.current === "composer") {
        const base = webDictationBaseDraftRef.current.trim();
        const next = base ? `${base} ${transcript}` : transcript;
        setDraft(next);
        console.log("[AskPranaChat] draft updated from web dictation", {
          draftLength: next.length,
        });
      }

      return transcript;
    } finally {
      voiceBusyRef.current = false;
      voiceStopInFlightRef.current = false;
      isRecordingRef.current = false;
      isTranscribingRef.current = false;
      setIsRecording(false);
      setIsTranscribing(false);
      recordingStopAllowedAtRef.current = 0;
    }
  }, [clearVoiceSilenceWatch]);

  const captureRecordingTranscript = useCallback(async (): Promise<string | null> => {
    clearVoiceSilenceWatch();
    if (voiceStopInFlightRef.current) {
      console.log("[AskPranaChat] stop skipped: already stopping");
      return null;
    }
    if (isTranscribingRef.current || isSendingRef.current) {
      console.log("[AskPranaChat] stop skipped: busy transcribe/send");
      return null;
    }

    clearStuckRecordingFlag();

    const recorderLive = Boolean(audioRecorder.isRecording);
    const micLive = isRecordingRef.current || recorderLive;
    if (!micLive) {
      console.log("[AskPranaChat] stop skipped: mic not live");
      isRecordingRef.current = false;
      setIsRecording(false);
      return null;
    }

    // Flag said recording but hardware isn't — recover without empty chat noise.
    if (isRecordingRef.current && !recorderLive) {
      console.log("[AskPranaChat] stop skipped: flag set but recorder idle");
      isRecordingRef.current = false;
      setIsRecording(false);
      return null;
    }

    if (Date.now() < recordingStopAllowedAtRef.current) {
      console.log("[AskPranaChat] stop ignored: too soon after start");
      return null;
    }

    const epochAtStart = dictationEpochRef.current;
    voiceStopInFlightRef.current = true;
    const durationSec = audioRecorder.currentTime;
    setIsRecording(false);
    setIsTranscribing(true);
    isRecordingRef.current = false;
    isTranscribingRef.current = true;
    recordingGuardUntilRef.current = 0;

    try {
      try {
        await audioRecorder.stop();
      } catch (error) {
        console.log("[AskPranaChat] stop recording failed:", error);
        Alert.alert(
          "Recording failed",
          "Couldn't finish that recording. Please try again.",
        );
        return null;
      }

      if (epochAtStart !== dictationEpochRef.current) {
        console.log("[AskPranaChat] stop aborted after cancel");
        return null;
      }

      const uri = audioRecorder.uri;
      await releaseRecordingResources();

      if (!uri) {
        Alert.alert(
          "Recording failed",
          "No audio was captured. Please try recording again.",
        );
        return null;
      }

      if (durationSec > 0 && durationSec < MIN_VOICE_DURATION_SEC) {
        Alert.alert("Recording too short", voiceErrorMessage("VOICE_SHORT"));
        return null;
      }

      let blob: Blob;
      try {
        const recorded = await fetch(uri);
        blob = await recorded.blob();
      } catch (error) {
        console.log("[AskPranaChat] failed to read recorded audio blob:", error);
        Alert.alert(
          "Recording failed",
          "Couldn't read that recording. Please try again.",
        );
        return null;
      }

      if (!blob || blob.size === 0) {
        Alert.alert("Recording too short", voiceErrorMessage("VOICE_SHORT"));
        return null;
      }

      const audioMeta = resolveRecordedAudioMeta(uri, blob.type);
      const actualContainer = await describeRecordedAudioContainer(blob);
      console.log("[AskPranaAudio] recording finalized", {
        platform: Platform.OS,
        uriExtension: audioMeta.uriExtension || null,
        fileName: audioMeta.fileName,
        mimeType: audioMeta.mimeType,
        byteSize: blob.size,
        durationSec,
        actualContainer,
      });

      if (
        !OPENAI_TRANSCRIBE_EXTENSIONS.has(audioMeta.extension) ||
        (Platform.OS !== "web" &&
          (audioMeta.uriExtension !== ANDROID_VOICE_FILE_EXTENSION ||
            (actualContainer !== null && actualContainer !== "mpeg-4")))
      ) {
        Alert.alert("Unsupported audio", voiceErrorMessage("VOICE_FORMAT"));
        return null;
      }

      const preferredLanguage = await loadAskPranaPreferredLanguage();
      let transcript = "";
      try {
        transcript = await transcribeAskPranaAudio({
          uri,
          blob,
          mimeType: audioMeta.mimeType,
          fileName: audioMeta.fileName,
          language: preferredLanguage,
        });
      } catch (error) {
        console.log("[AskPranaChat] transcription error:", error);
        if (epochAtStart !== dictationEpochRef.current) {
          return null;
        }
        Alert.alert("Transcription failed", voiceErrorMessage(error));
        return null;
      }

      if (epochAtStart !== dictationEpochRef.current) {
        console.log("[AskPranaChat] ignoring late transcript after cancel");
        return null;
      }

      if (!transcript.trim()) {
        if (webDictationSourceRef.current !== "voice") {
          Alert.alert("Couldn't understand", voiceErrorMessage("VOICE_EMPTY"));
        }
        return null;
      }

      console.log("[AskPranaChat] transcript ready", {
        length: transcript.trim().length,
      });
      return transcript.trim();
    } finally {
      voiceBusyRef.current = false;
      voiceStopInFlightRef.current = false;
      isRecordingRef.current = false;
      recordingStopAllowedAtRef.current = 0;
      if (epochAtStart === dictationEpochRef.current) {
        isTranscribingRef.current = false;
        setIsTranscribing(false);
      }
      setIsRecording(false);
      await releaseRecordingResources();
    }
  }, [audioRecorder, clearStuckRecordingFlag, clearVoiceSilenceWatch, releaseRecordingResources]);

  const stopAudioRecordingToTranscript = useCallback(async () => {
    if (webDictationRef.current) {
      return finishWebDictation();
    }
    return captureRecordingTranscript();
  }, [captureRecordingTranscript, finishWebDictation]);

  const stopAudioRecordingToComposer = useCallback(async () => {
    if (webDictationRef.current) {
      return finishWebDictation();
    }
    const transcript = await captureRecordingTranscript();
    if (!transcript) {
      return null;
    }
    setDraft((current) => {
      const existing = current.trim();
      const next = existing ? `${existing} ${transcript}` : transcript;
      console.log("[AskPranaChat] draft updated from dictation", {
        draftLength: next.length,
      });
      return next;
    });
    return transcript;
  }, [captureRecordingTranscript, finishWebDictation]);

  const stopAudioRecordingAndSend = useCallback(
    async (requestContext?: AskPranaRequestContext) => {
      // Intentionally unused by the composer microphone (dictation-only).
      const transcript = await captureRecordingTranscript();
      if (!transcript) {
        return;
      }
      await sendQuestion(transcript, requestContext);
    },
    [captureRecordingTranscript, sendQuestion],
  );

  const reloadMessages = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (activeSessionId) {
      await openConversation(activeSessionId);
      return;
    }
    await loadSessionMessages(selectedPondId, userId);
  }, [loadSessionMessages, openConversation, selectedPondId, userId]);

  const value = useMemo<AskPranaChatContextValue>(
    () => ({
      messages,
      draft,
      isSending,
      isUploading,
      attachmentError,
      isRecording,
      isTranscribing,
      isLoadingMessages,
      isAuthLoading: authLoading,
      thinkingKind,
      generationStopped,
      pendingAttachments,
      ponds,
      selectedPondId,
      selectedPondName,
      isGenericMode,
      activeSessionId: sessionId,
      setDraft,
      setSelectedPondId,
      removePendingAttachment,
      sendQuestion,
      editAndResendUserMessage,
      askFromVoiceMode,
      prepareVoiceModeSession,
      sendImageAttachment,
      sendDocumentAttachment,
      startAudioRecording,
      stopAudioRecordingAndSend,
      stopAudioRecordingToComposer,
      stopAudioRecordingToTranscript,
      cancelAudioRecording,
      stopGeneration,
      refreshPonds,
      reloadMessages,
      startNewConversation,
      openConversation,
      listConversations,
      listConversationPage,
      conversationActivity,
      hasOlderMessages,
      isLoadingOlder,
      loadOlderMessages,
      renameConversation,
      deleteConversation,
    }),
    [
      messages,
      draft,
      isSending,
      isUploading,
      attachmentError,
      isRecording,
      isTranscribing,
      isLoadingMessages,
      authLoading,
      thinkingKind,
      generationStopped,
      pendingAttachments,
      ponds,
      selectedPondId,
      selectedPondName,
      isGenericMode,
      sessionId,
      setSelectedPondId,
      removePendingAttachment,
      sendQuestion,
      editAndResendUserMessage,
      askFromVoiceMode,
      prepareVoiceModeSession,
      sendImageAttachment,
      sendDocumentAttachment,
      startAudioRecording,
      stopAudioRecordingAndSend,
      stopAudioRecordingToComposer,
      stopAudioRecordingToTranscript,
      cancelAudioRecording,
      stopGeneration,
      refreshPonds,
      reloadMessages,
      startNewConversation,
      openConversation,
      listConversations,
      listConversationPage,
      conversationActivity,
      hasOlderMessages,
      isLoadingOlder,
      loadOlderMessages,
      renameConversation,
      deleteConversation,
    ],
  );

  return (
    <AskPranaChatContext.Provider value={value}>{children}</AskPranaChatContext.Provider>
  );
}

export function useAskPranaChat() {
  const value = useContext(AskPranaChatContext);
  if (!value) {
    throw new Error("useAskPranaChat must be used within AskPranaChatProvider");
  }
  return value;
}

export const MOST_ASKED_QUESTIONS = [
  "Why is Ammonia high?",
  "Should I harvest now?",
  "How is my FCR trend?",
  "What is the survival outlook?",
  "Is water quality stable?",
  "When should I reduce feed?",
];
