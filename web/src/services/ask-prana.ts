import { Platform } from "react-native";
import {
  ensureValidSession,
  getSupabasePublicConfig,
  supabase,
} from "../lib/supabase";
import { explicitReplyLanguageLabel } from "../lib/ask-prana-translation-policy";
import { getCurrentUserProfile, resolveFarmerDisplayName } from "./profile";

export type AskPranaGeneratedFile = {
  type?: "file";
  fileName: string;
  mimeType: string;
  path: string;
  url: string;
  byteSize?: number;
  format?: "docx" | "pdf" | "xlsx";
};

export type AskPranaReply = {
  answer: string;
  generatedFile?: AskPranaGeneratedFile | null;
};

/** Display-only historical translation. Originals are never written back. */
export async function translateAskPranaHistory(
  texts: string[],
  language: "en" | "te" | "hi",
): Promise<string[]> {
  // English is translated too: chats typed in Hindi/Telugu must not leak into
  // the English UI. Callers only send text that is not already in `language`.
  if (texts.length === 0) return texts;
  const auth = await requireAskPranaAuth();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Translation request timed out."));
    }, 45_000);
  });
  let result: { data: { translations?: unknown } | null; error: unknown };
  try {
    result = await Promise.race([
      supabase.functions.invoke("ask-prana", {
        body: { task: "translate-history", texts, language },
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.message === "Translation request timed out.")) {
      throw new Error("Translation request timed out.");
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const translations = result.data?.translations;
  if (result.error || !Array.isArray(translations)) {
    const context = (result.error as { context?: Response } | null)?.context;
    const status = context && typeof context.status === "number" ? context.status : undefined;
    let detail = result.error instanceof Error ? result.error.message : "";
    if (context && typeof context.json === "function") {
      try {
        const body = await context.json() as { error?: unknown; status?: unknown };
        if (typeof body?.error === "string" && body.error.trim()) {
          detail = body.status ? `${body.error} (openai ${body.status})` : body.error;
        }
      } catch {
        // The body can only be read once; keep the generic message.
      }
    }
    throw new Error(
      status
        ? `Historical translation failed (${status}): ${detail || "no response body"}`
        : `Historical translation is unavailable.${detail ? ` ${detail}` : ""}`,
    );
  }
  if (translations.length !== texts.length) {
    throw new Error("Historical translation returned an incomplete batch.");
  }
  return translations.map((value: unknown, index: number) =>
    typeof value === "string" && value.trim() ? value.trim() : (() => { throw new Error(`Missing translation at index ${index}.`); })(),
  );
}

export type AskPranaConversationTurn = {
  role: "assistant" | "user";
  text: string;
};

export type AskPranaAttachmentKind = "image" | "file" | "document";

export type AskPranaAttachment = {
  filePath: string;
  fileName?: string | null;
  mimeType?: string | null;
  kind?: AskPranaAttachmentKind;
};

export type AskPranaRequestContext = {
  pondId?: string | null;
  cycleId?: string | null;
  userId?: string | null;
  screen?: string | null;
  mode?: "pond" | "generic";
  sessionId?: string | null;
  conversationHistory?: AskPranaConversationTurn[];
  attachments?: AskPranaAttachment[];
  language?: string | null;
  /** Active UI/voice language code (te/hi/en) — stronger than stale English context. */
  sessionLanguageCode?: string | null;
  /** Voice Mode only: explicit header language that must not be overridden by STT text. */
  voiceModeLanguageLock?: string | null;
  /** "voice" when the question is a Voice Mode speech-to-text transcript. */
  inputMode?: "voice" | "text" | null;
  languageNotes?: string | null;
  farmerDisplayName?: string | null;
};

export type AskPranaEnrichedContext = AskPranaRequestContext & {
  latestLogsSummary?: string | null;
  feedScheduleSummary?: string | null;
  waterQualitySummary?: string | null;
  inventorySummary?: string | null;
  recentTrendSummary?: string | null;
  checkTraySummary?: string | null;
  parameterStatusSummary?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asValidUuid(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "undefined" ||
    trimmed === "null" ||
    !UUID_RE.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function formatUnknownError(value: unknown): string {
  if (value == null) {
    return "Unknown error";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapFarmerLanguage(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "te" || raw === "telugu" || raw.includes("తెలుగు")) return "Telugu";
  if (
    raw === "hi" ||
    raw === "hindi" ||
    raw.includes("हिन्दी") ||
    raw.includes("हिंदी")
  ) {
    return "Hindi";
  }
  // Ask Prana only supports English / Telugu / Hindi.
  return "English";
}

async function readFunctionsErrorBody(error: unknown): Promise<string | null> {
  const context = (error as { context?: Response })?.context;
  if (!context || typeof context.text !== "function") {
    return null;
  }

  try {
    const text = await context.text();
    if (!text?.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      if (parsed.error != null) {
        return formatUnknownError(parsed.error);
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
      return text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

export async function formatAskPranaInvokeError(
  error: unknown,
  data?: unknown,
): Promise<string> {
  const dataError =
    data && typeof data === "object" && "error" in data
      ? (data as { error: unknown }).error
      : null;

  if (typeof dataError === "string" && dataError.trim()) {
    const normalized = dataError.toLowerCase();
    if (normalized.includes("api key") || normalized.includes("groq_api_key")) {
      return "LLM API key is missing.";
    }
    return dataError;
  }

  const status = (error as { context?: { status?: number } })?.context?.status;
  const bodyMessage = await readFunctionsErrorBody(error);
  if (bodyMessage) {
    const normalized = bodyMessage.toLowerCase();
    if (normalized.includes("api key") || normalized.includes("groq_api_key")) {
      return "LLM API key is missing.";
    }
    if (status === 401) {
      return `401 Unauthorized: ${bodyMessage}`;
    }
    if (status) {
      return `HTTP ${status}: ${bodyMessage}`;
    }
    return bodyMessage;
  }

  const message = formatUnknownError(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("network request failed") ||
    normalized.includes("networkerror") ||
    normalized.includes("unable to connect")
  ) {
    return "Network failure: unable to reach Ask Prana server.";
  }

  if (status === 401 || normalized.includes("401")) {
    return `401 Unauthorized${message ? `: ${message}` : ""}`;
  }

  if (normalized.includes("jwt expired")) {
    return "JWT expired. Please sign in again.";
  }

  if (normalized.includes("jwt") || normalized.includes("invalid jwt")) {
    return `Invalid JWT: ${message}`;
  }

  if (normalized.includes("unauthorized")) {
    return `Unauthorized: ${message}`;
  }

  if (normalized.includes("non-2xx") || normalized.includes("edge function")) {
    return status
      ? `HTTP ${status}: Edge Function error — ${message}`
      : `Supabase Function Error: ${message}`;
  }

  return message;
}

/**
 * Ensures a live Supabase auth session + access token for Edge Function calls.
 * Prefers local session (AsyncStorage) and refreshes when needed.
 */
export async function requireAskPranaAuth(preferredUserId?: string | null) {
  const config = getSupabasePublicConfig();

  if (!config.url || !config.hasAnonKey) {
    throw new Error(
      "Missing Environment Variable: EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY",
    );
  }

  const session = await ensureValidSession();

  if (!session) {
    throw new Error("No active session. Please sign in again.");
  }

  if (!session.access_token) {
    throw new Error("Access token missing. Please sign in again.");
  }

  const user = session.user ?? null;

  if (!user) {
    throw new Error("User not authenticated. Please sign in again.");
  }

  const preferred = asValidUuid(preferredUserId);
  const resolvedUserId = preferred ?? asValidUuid(user.id);
  if (!resolvedUserId) {
    throw new Error(
      preferredUserId ? "Invalid user_id." : "User not authenticated.",
    );
  }

  return {
    session,
    user,
    userId: resolvedUserId,
    accessToken: session.access_token,
  };
}

async function buildClientContext(
  context: AskPranaRequestContext,
  resolvedUserId: string,
): Promise<AskPranaEnrichedContext> {
  if (context.mode === "generic" || !context.pondId) {
    return {
      ...context,
      pondId: null,
      cycleId: null,
      userId: resolvedUserId,
      mode: "generic",
      latestLogsSummary: null,
      feedScheduleSummary: null,
      waterQualitySummary: null,
      inventorySummary: null,
      recentTrendSummary: null,
      checkTraySummary: null,
      parameterStatusSummary: null,
    };
  }

  return {
    ...context,
    userId: resolvedUserId,
    cycleId: context.cycleId ?? null,
    mode: "pond",
    latestLogsSummary: null,
    feedScheduleSummary: null,
    waterQualitySummary: null,
    inventorySummary: null,
    recentTrendSummary: null,
    checkTraySummary: null,
    parameterStatusSummary: null,
  };
}

async function resolveAskPranaLanguage(preferred?: string | null) {
  if (preferred?.trim()) {
    return mapFarmerLanguage(preferred);
  }
  try {
    const result = await getCurrentUserProfile();
    if (result.profile?.language) {
      return mapFarmerLanguage(result.profile.language);
    }
  } catch (error) {
    console.log("[askPrana] language profile skipped:", error);
  }
  return "English";
}

export async function askPrana(
  question: string,
  context: string | AskPranaRequestContext,
): Promise<AskPranaReply> {
  const requestContext: AskPranaRequestContext =
    typeof context === "string"
      ? { pondId: context, mode: "pond" }
      : context;

  const auth = await requireAskPranaAuth(requestContext.userId);
  const enriched = await buildClientContext(requestContext, auth.userId);
  const isGeneric = enriched.mode === "generic" || !enriched.pondId;

  const sessionId = asValidUuid(enriched.sessionId);
  const userId = asValidUuid(enriched.userId) ?? auth.userId;
  const pondId = asValidUuid(enriched.pondId);
  const cycleId = asValidUuid(enriched.cycleId);

  if (!sessionId) {
    throw new Error(
      "Missing valid session_id. Create an Ask Prana session before asking.",
    );
  }

  const attachments = (enriched.attachments ?? [])
    .map((attachment) => {
      const filePath =
        typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";
      if (
        !filePath ||
        filePath.includes("://") ||
        filePath.startsWith("file:") ||
        filePath.startsWith("content:") ||
        filePath.startsWith("ph:")
      ) {
        return null;
      }

      const kind =
        attachment.kind === "image" ||
        attachment.kind === "file" ||
        attachment.kind === "document"
          ? attachment.kind
          : attachment.mimeType?.startsWith("image/")
            ? "image"
            : "file";

      return {
        filePath,
        fileName: attachment.fileName ?? null,
        mimeType: attachment.mimeType ?? null,
        kind,
      };
    })
    .filter((attachment): attachment is NonNullable<typeof attachment> =>
      Boolean(attachment),
    )
    .slice(0, 5);

  const explicitLanguage =
    explicitReplyLanguageLabel(enriched.sessionLanguageCode) ??
    explicitReplyLanguageLabel(enriched.voiceModeLanguageLock);
  const requestBody: Record<string, unknown> = {
    mode: isGeneric ? "generic" : "pond",
    question,
    sessionId,
    userId,
    conversationHistory: enriched.conversationHistory ?? [],
    attachments,
    language: explicitLanguage ?? (await resolveAskPranaLanguage(enriched.language)),
    sessionLanguageCode: enriched.sessionLanguageCode ?? enriched.voiceModeLanguageLock ?? null,
    languageLock: Boolean(explicitLanguage),
    inputMode: enriched.inputMode === "voice" ? "voice" : "text",
    languageNotes: explicitLanguage
      ? `Reply only in ${explicitLanguage}. Do not switch language to match the question.`
      : typeof enriched.languageNotes === "string" && enriched.languageNotes.trim()
        ? enriched.languageNotes.trim()
        : null,
    farmerDisplayName:
      (typeof enriched.farmerDisplayName === "string" &&
      enriched.farmerDisplayName.trim()
        ? enriched.farmerDisplayName.trim()
        : null) ??
      (await resolveFarmerDisplayName()) ??
      null,
  };

  if (
    typeof requestBody.farmerDisplayName === "string" &&
    (requestBody.farmerDisplayName === "Farmer" ||
      !requestBody.farmerDisplayName)
  ) {
    // Prefer an empty omission over a generic placeholder for the model.
    const fresh = await resolveFarmerDisplayName();
    requestBody.farmerDisplayName =
      fresh && fresh !== "Farmer" ? fresh : null;
  }

  if (enriched.screen) {
    requestBody.screen = enriched.screen;
  }

  if (!isGeneric) {
    if (!pondId) {
      throw new Error("Invalid pond_id.");
    }
    requestBody.pondId = pondId;
    if (cycleId) {
      requestBody.cycleId = cycleId;
    }
    requestBody.feedScheduleSummary = enriched.feedScheduleSummary ?? null;
    requestBody.inventorySummary = enriched.inventorySummary ?? null;
  }

  console.log("[askPrana] invoke request", {
    sessionId,
    pondId: pondId ?? null,
    userId,
    mode: requestBody.mode,
    questionPreview: String(question).slice(0, 120),
    hasAccessToken: Boolean(auth.accessToken),
    attachmentCount: attachments.length,
    attachmentPresent: attachments.length > 0,
    attachmentKinds: attachments.map((attachment) => attachment.kind),
    attachments: attachments.map((attachment) => ({
      kind: attachment.kind,
      fileName: attachment.fileName ?? null,
    })),
  });

  let data: {
    answer?: string;
    generatedFile?: AskPranaGeneratedFile | null;
    error?: unknown;
  } | null = null;
  let error: unknown = null;

  try {
    // Explicitly attach the user JWT so APK builds never call the Edge
    // Function with only the anon key (which causes gateway 401s).
    const result = await supabase.functions.invoke("ask-prana", {
      body: requestBody,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    });
    data = result.data as typeof data;
    error = result.error;
  } catch (invokeError) {
    console.log("[askPrana] invoke threw:", invokeError);
    throw new Error(await formatAskPranaInvokeError(invokeError));
  }

  console.log("[askPrana] response", {
    hasData: Boolean(data),
    hasError: Boolean(error),
    dataError:
      data && typeof data === "object" && "error" in data
        ? (data as { error: unknown }).error
        : null,
    errorMessage: formatUnknownError(error),
    status: (error as { context?: { status?: number } })?.context?.status ?? null,
  });

  if (error) {
    console.log("[askPrana] error object:", error);
    throw new Error(await formatAskPranaInvokeError(error, data));
  }

  const reply = data as {
    answer?: string;
    generatedFile?: AskPranaGeneratedFile | null;
    error?: unknown;
  } | null;

  if (reply?.error) {
    throw new Error(await formatAskPranaInvokeError(null, reply));
  }

  const answer = reply?.answer?.trim();
  if (!answer || /^no response received\.?$/i.test(answer)) {
    throw new Error(
      "Ask Prana could not finish that answer. Please try asking again.",
    );
  }

  const generatedFile = normalizeGeneratedFile(reply?.generatedFile);

  return {
    answer,
    generatedFile,
  };
}

function normalizeGeneratedFile(
  value: unknown,
): AskPranaGeneratedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const fileName =
    typeof record.fileName === "string" ? record.fileName.trim() : "";
  const mimeType =
    typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!fileName || !mimeType || !path || !url) {
    return null;
  }
  if (url.includes("://") === false) {
    return null;
  }
  return {
    type: "file",
    fileName,
    mimeType,
    path,
    url,
    byteSize:
      typeof record.byteSize === "number" && Number.isFinite(record.byteSize)
        ? record.byteSize
        : undefined,
    format:
      record.format === "pdf" ||
      record.format === "docx" ||
      record.format === "xlsx"
        ? record.format
        : undefined,
  };
}

function classifyTranscribeError(technical: string): Error {
  const normalized = technical.toLowerCase();
  console.log("[askPrana] transcribe failed:", technical);
  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("network request failed") ||
    normalized.includes("network")
  ) {
    return new Error("VOICE_NETWORK");
  }
  if (
    normalized.includes("no credits") ||
    normalized.includes("credits remaining") ||
    normalized.includes("billing")
  ) {
    return new Error("VOICE_CREDITS");
  }
  if (
    normalized.includes("unsupported") ||
    normalized.includes("invalid file") ||
    normalized.includes("invalid audio") ||
    normalized.includes("format")
  ) {
    return new Error("VOICE_FORMAT");
  }
  return new Error("VOICE_TRANSCRIBE");
}

function extensionFromAudioName(fileName: string) {
  const name = fileName.split("?")[0]?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1);
}

export function mimeTypeForOpenAIAudio(fileName: string, mimeType?: string | null) {
  const ext = extensionFromAudioName(fileName);
  const incoming = (mimeType ?? "").toLowerCase();
  if (ext === "m4a" || incoming === "audio/m4a") {
    // Android's AAC M4A container uses the widely supported MP4 audio MIME
    // type for multipart uploads. Some Android/Edge combinations reject the
    // non-standard audio/m4a label despite the file bytes being valid M4A.
    return "audio/mp4";
  }
  if (incoming.startsWith("audio/") && incoming !== "application/octet-stream") {
    return incoming.split(";")[0]?.trim() || incoming;
  }
  if (ext === "webm") return "audio/webm";
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3" || ext === "mpeg" || ext === "mpga") return "audio/mpeg";
  if (ext === "ogg" || ext === "oga") return "audio/ogg";
  if (ext === "mp4") return "audio/mp4";
  return "audio/mp4";
}

function appendVoiceFile(
  formData: FormData,
  blob: Blob,
  fileName: string,
  mimeType: string,
) {
  // Upload the finalized bytes that were read and size-checked from the
  // recorder. Do not make Android's multipart encoder reopen file://, because
  // that release-only path can produce an invalid part on some devices.
  // `blob` is already the finalized bytes from fetch(file://...). Wrapping it
  // in a second Blob is not supported consistently by Hermes release builds.
  formData.append("file", blob, fileName);
}

export async function transcribeAskPranaAudio(input: {
  uri: string;
  blob: Blob;
  mimeType?: string | null;
  fileName?: string | null;
  language?: string | null;
}) {
  const auth = await requireAskPranaAuth();
  const config = getSupabasePublicConfig();
  const anonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

  if (!config.url || !anonKey) {
    throw classifyTranscribeError(
      "Missing Environment Variable: EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY",
    );
  }

  if (!input.blob || input.blob.size === 0) {
    throw new Error("VOICE_SHORT");
  }

  const fileName =
    input.fileName?.trim() ||
    (Platform.OS === "web" ? `askprana-recording.webm` : `askprana-recording.mp4`);
  const mimeType = mimeTypeForOpenAIAudio(fileName, input.mimeType ?? input.blob.type);
  const fileExtension = extensionFromAudioName(fileName);

  console.log("[AskPranaAudio] upload started", {
    fileExtension,
    mimeType,
    fileName,
    fileSize: input.blob.size,
    blobType: input.blob.type || null,
    platform: Platform.OS,
  });

  const formData = new FormData();
  appendVoiceFile(formData, input.blob, fileName, mimeType);
  formData.append("fileName", fileName);
  if (input.language?.trim()) {
    formData.append("language", input.language.trim());
  }

  let response: Response;
  try {
    response = await fetch(`${config.url}/functions/v1/ask-prana-transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        apikey: anonKey,
      },
      body: formData,
    });
  } catch (error) {
    console.log("[askPrana] transcribe API status", "network-error");
    console.log("[askPrana] transcribe API error response", formatUnknownError(error));
    throw classifyTranscribeError(formatUnknownError(error));
  }

  let data: { transcript?: string; error?: unknown } | null = null;
  const rawText = await response.text();
  console.log("[AskPranaAudio] upload completed", { status: response.status });
  try {
    data = rawText
      ? (JSON.parse(rawText) as { transcript?: string; error?: unknown })
      : null;
  } catch {
    console.log("[askPrana] transcribe API error response", rawText);
    throw classifyTranscribeError(
      `HTTP ${response.status}: ${rawText || "Unable to transcribe audio."}`,
    );
  }

  if (!response.ok || data?.error) {
    console.log("[askPrana] transcribe API error response", rawText);
    const message =
      typeof data?.error === "string"
        ? data.error
        : `HTTP ${response.status}: Unable to transcribe audio.`;
    const detail =
      data &&
      typeof data === "object" &&
      "detail" in data &&
      typeof (data as { detail?: unknown }).detail === "string"
        ? String((data as { detail: string }).detail)
        : "";
    throw classifyTranscribeError(detail ? `${message} ${detail}` : message);
  }

  console.log("[AskPranaAudio] transcription completed", {
    transcriptLength: data?.transcript?.trim().length ?? 0,
  });
  return data?.transcript?.trim() ?? "";
}
