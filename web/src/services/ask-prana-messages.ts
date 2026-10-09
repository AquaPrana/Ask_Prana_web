import type { ChatMessage, ChatMessageType } from "../context/ask-prana-chat-context";
import { getAskPranaFileUrl } from "../lib/ask-prana-files";
import { supabase } from "../lib/supabase";
import { requireAskPranaAuth } from "./ask-prana";

export type AskPranaMessageRow = {
  id: string;
  session_id: string | null;
  user_id?: string | null;
  pond_id?: string | null;
  farmer_name?: string | null;
  pond_name?: string | null;
  mode?: "generic" | "pond" | null;
  role: "user" | "assistant";
  message_type?: ChatMessageType | null;
  content: string | null;
  file_path?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: unknown;
  created_at: string;
};

export type SaveAskPranaMessageInput = {
  sessionId: string;
  userId: string;
  pondId?: string | null;
  farmerName?: string | null;
  pondName?: string | null;
  mode?: "generic" | "pond";
  role: "user" | "assistant";
  messageType: ChatMessageType;
  content?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AskPranaSessionSummary = {
  id: string;
  pondId: string | null;
  title: string;
  preview: string;
  createdAt: string;
  lastActivity: string;
};

function getPublicFileUrl(filePath: string | null | undefined) {
  if (!filePath) {
    return null;
  }

  const { data } = supabase.storage.from("ask-prana-files").getPublicUrl(filePath);
  if (data.publicUrl && !data.publicUrl.includes("/aquagpt-files/")) {
    return data.publicUrl;
  }

  return null;
}

export async function mapRowToChatMessage(
  row: AskPranaMessageRow,
): Promise<ChatMessage> {
  const messageType = normalizeMessageType(row);
  const fileUrl =
    (await getAskPranaFileUrl(row.file_path ?? null)) ??
    getPublicFileUrl(row.file_path);

  return {
    id: row.id,
    role: row.role,
    text: row.content ?? "",
    messageType,
    fileUrl,
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    transcript: messageType === "audio" ? row.content : null,
    createdAt: row.created_at,
  };
}

function normalizeMessageType(row: AskPranaMessageRow): ChatMessageType {
  const rawType = (row.message_type ?? "text").toLowerCase();

  if (rawType === "image" || rawType === "document" || rawType === "audio") {
    return rawType;
  }

  if (row.file_path?.startsWith("images/")) {
    return "image";
  }

  if (row.file_path?.startsWith("documents/")) {
    return "document";
  }

  if (row.file_path?.startsWith("audio/")) {
    return "audio";
  }

  if (row.mime_type?.startsWith("image/")) {
    return "image";
  }

  return "text";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAskPranaUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

type ConversationPayload = Record<string, unknown>;

async function conversationRequest<T>(op: string, payload: ConversationPayload = {}): Promise<T> {
  const auth = await requireAskPranaAuth();
  const { data, error } = await supabase.functions.invoke("ask-prana", {
    body: { task: "conversations", op, ...payload },
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  const body = (data ?? null) as ({ error?: unknown } & T) | null;
  if (!error && body && typeof body.error !== "string") return body;
  let message = typeof body?.error === "string" ? body.error : "";
  const context = (error as { context?: { json?: () => Promise<{ error?: unknown }> } } | null)?.context;
  if (!message && context && typeof context.json === "function") {
    try {
      const parsed = await context.json();
      if (typeof parsed?.error === "string") message = parsed.error;
    } catch {
      // The error body can only be read once.
    }
  }
  throw new Error(message || "Unable to load your conversation history. Please try again.");
}

/** Always create a brand-new conversation for the signed-in Ask Prana user. */
export async function createAskPranaSession(
  userId: string,
  _pondId: string | null,
  options?: {
    title?: string | null;
    language?: string | null;
    farmerName?: string | null;
    pondName?: string | null;
    mode?: "generic" | "pond";
  },
): Promise<{ sessionId: string | null; error: Error | null }> {
  if (!isValidAskPranaUuid(userId)) {
    return {
      sessionId: null,
      error: new Error(userId ? "Invalid user_id." : "No active session. Please sign in again."),
    };
  }
  try {
    const created = await conversationRequest<{ sessionId?: string }>("create", {
      userId,
      title: options?.title ?? null,
    });
    if (!isValidAskPranaUuid(created.sessionId)) {
      return { sessionId: null, error: new Error("Session create returned an invalid id.") };
    }
    return { sessionId: created.sessionId, error: null };
  } catch (error) {
    return {
      sessionId: null,
      error: error instanceof Error ? error : new Error("Unable to start a conversation."),
    };
  }
}

export async function getLatestAskPranaSession(
  userId: string,
  _pondId: string | null,
): Promise<{ sessionId: string | null; error: Error | null }> {
  if (!isValidAskPranaUuid(userId)) {
    return { sessionId: null, error: new Error("Invalid user_id.") };
  }
  try {
    const latest = await conversationRequest<{ sessionId?: string | null }>("latest", { userId });
    return { sessionId: latest.sessionId ?? null, error: null };
  } catch (error) {
    return {
      sessionId: null,
      error: error instanceof Error ? error : new Error("Unable to open the conversation."),
    };
  }
}

/** @deprecated Prefer createAskPranaSession / getLatestAskPranaSession. */
export async function getOrCreateAskPranaSession(
  userId: string,
  pondId: string | null,
): Promise<{ sessionId: string | null; error: Error | null }> {
  const latest = await getLatestAskPranaSession(userId, pondId);
  if (latest.error) return latest;
  if (latest.sessionId) return latest;
  return createAskPranaSession(userId, pondId);
}

export async function fetchAskPranaMessages(
  sessionId: string,
  userId?: string,
): Promise<{ messages: ChatMessage[]; error: Error | null }> {
  if (!isValidAskPranaUuid(sessionId)) {
    return { messages: [], error: new Error("Invalid session_id.") };
  }
  try {
    const result = await conversationRequest<{ messages?: AskPranaMessageRow[] }>("messages", {
      sessionId,
      userId,
    });
    return {
      messages: await Promise.all((result.messages ?? []).map((row) => mapRowToChatMessage(row))),
      error: null,
    };
  } catch (error) {
    return {
      messages: [],
      error: error instanceof Error ? error : new Error("Unable to open the conversation."),
    };
  }
}

export async function fetchAskPranaMessagesForPond(
  userId: string,
  pondId: string | null,
): Promise<{ messages: ChatMessage[]; error: Error | null }> {
  const listed = await listAskPranaSessionsForPond(userId, pondId);
  if (listed.error) return { messages: [], error: listed.error };
  const batches = await Promise.all(
    listed.sessions.map((session) => fetchAskPranaMessages(session.id, userId)),
  );
  const failed = batches.find((batch) => batch.error);
  if (failed?.error) return { messages: [], error: failed.error };
  return { messages: batches.flatMap((batch) => batch.messages), error: null };
}

/** Conversation ownership check. Ask Prana conversations are not pond-scoped. */
export async function getAskPranaSessionPondId(
  sessionId: string,
  userId?: string,
): Promise<{ pondId: string | null; userId: string | null; error: Error | null }> {
  if (!isValidAskPranaUuid(sessionId)) {
    return { pondId: null, userId: null, error: new Error("Invalid session_id.") };
  }
  try {
    const scope = await conversationRequest<{ userId?: string }>("scope", { sessionId, userId });
    return { pondId: null, userId: scope.userId ?? userId ?? null, error: null };
  } catch (error) {
    return {
      pondId: null,
      userId: null,
      error: error instanceof Error ? error : new Error("Conversation not found."),
    };
  }
}

export async function saveAskPranaMessage(
  input: SaveAskPranaMessageInput,
  originalMessage?: ChatMessage,
): Promise<{ message: ChatMessage | null; error: Error | null }> {
  if (!isValidAskPranaUuid(input.sessionId) || !isValidAskPranaUuid(input.userId)) {
    return { message: null, error: new Error("Missing valid session_id.") };
  }
  try {
    const saved = await conversationRequest<{ message?: AskPranaMessageRow }>("save", {
      sessionId: input.sessionId,
      userId: input.userId,
      role: input.role,
      content: input.content ?? "",
      messageType: input.messageType,
      filePath: input.filePath ?? null,
      fileName: input.fileName ?? null,
      mimeType: input.mimeType ?? null,
    });
    if (!saved.message) return { message: null, error: new Error("Unable to save message.") };
    return {
      message: originalMessage
        ? await mergePersistedMessage(originalMessage, saved.message)
        : await mapRowToChatMessage(saved.message),
      error: null,
    };
  } catch (error) {
    return {
      message: null,
      error: error instanceof Error ? error : new Error("Unable to save message."),
    };
  }
}

async function mergePersistedMessage(
  original: ChatMessage,
  row: AskPranaMessageRow,
): Promise<ChatMessage> {
  const saved = await mapRowToChatMessage(row);
  return {
    ...saved,
    localUri: original.localUri ?? saved.localUri,
    messageType: saved.messageType ?? original.messageType,
    fileUrl: saved.fileUrl ?? original.fileUrl,
    filePath: saved.filePath ?? original.filePath,
    fileName: saved.fileName ?? original.fileName,
    mimeType: saved.mimeType ?? original.mimeType,
    transcript: saved.transcript ?? original.transcript,
  };
}

/** Older packed AquaPrana sessions are not stored in this project. */
export async function splitPackedAskPranaSessions(
  _userId: string,
  _pondId: string | null,
): Promise<void> {
  return;
}

export async function listAskPranaSessionsForPond(
  userId: string,
  _pondId: string | null,
): Promise<{ sessions: AskPranaSessionSummary[]; error: Error | null }> {
  if (!isValidAskPranaUuid(userId)) {
    return { sessions: [], error: new Error("Invalid user_id.") };
  }
  try {
    const listed = await conversationRequest<{ sessions?: AskPranaSessionSummary[] }>("list", { userId });
    return { sessions: listed.sessions ?? [], error: null };
  } catch (error) {
    return {
      sessions: [],
      error: error instanceof Error ? error : new Error("Unable to load your conversation history. Please try again."),
    };
  }
}

export async function renameAskPranaSession(
  sessionId: string,
  title: string,
): Promise<{ error: Error | null }> {
  const trimmed = title.trim();
  if (!trimmed) return { error: new Error("Title cannot be empty.") };
  try {
    await conversationRequest("rename", { sessionId, title: trimmed });
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error("Unable to rename the conversation.") };
  }
}

export async function deleteAskPranaSession(
  sessionId: string,
): Promise<{ error: Error | null }> {
  try {
    await conversationRequest("delete", { sessionId });
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error("Unable to delete the conversation.") };
  }
}
