import { ensureValidSession, supabase } from "./supabase";

/** Generated and attached chat files are stored in this public bucket. */
export const ASK_PRANA_FILES_BUCKET = "ask-prana-files";

export type AskPranaFileFolder = "audio" | "images" | "documents";

export type UploadedAskPranaFile = {
  filePath: string;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSize?: number | null;
  localUri?: string | null;
};

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extensionFromName(value?: string | null) {
  const name = (value ?? "").split("?")[0].toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1);
}

function mimeFromExtension(extension: string) {
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "m4a":
      return "audio/m4a";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    default:
      return null;
  }
}

function resolveMimeType(
  uri: string,
  fileName?: string | null,
  mimeType?: string | null,
  blobType?: string | null,
) {
  const fromName = mimeFromExtension(extensionFromName(fileName));
  if (fromName) {
    return fromName;
  }

  const fromUri = mimeFromExtension(extensionFromName(uri));
  if (fromUri) {
    return fromUri;
  }

  if (mimeType && mimeType !== "application/octet-stream") {
    return mimeType;
  }

  if (blobType && blobType !== "application/octet-stream") {
    return blobType;
  }

  return mimeType ?? blobType ?? "application/octet-stream";
}

function guessExtension(
  uri: string,
  mimeType?: string | null,
  fileName?: string | null,
) {
  const named = extensionFromName(fileName);
  if (named && named.length <= 5) {
    return named;
  }

  if (mimeType?.includes("png")) return "png";
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("gif")) return "gif";
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  if (mimeType?.includes("pdf")) return "pdf";
  if (mimeType?.includes("mpeg") || mimeType?.includes("mp3")) return "mp3";
  if (mimeType?.includes("wav")) return "wav";
  if (mimeType?.includes("m4a") || mimeType?.includes("mp4")) return "m4a";
  if (mimeType?.includes("csv")) return "csv";
  if (mimeType?.includes("plain")) return "txt";
  if (mimeType?.includes("spreadsheet") || mimeType?.includes("excel")) {
    return "xlsx";
  }
  if (mimeType?.includes("word")) return "docx";

  const fromUri = extensionFromName(uri);
  if (fromUri && fromUri.length <= 5) {
    return fromUri;
  }

  return "bin";
}

async function fileToBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function uploadErrorMessage(error: unknown, data: { error?: unknown } | null): Promise<string> {
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
    } catch {
      // The response body can only be read once.
    }
  }
  return "The upload did not return a stored file.";
}

export async function uploadAskPranaFile({
  uri,
  folder,
  fileName,
  mimeType,
}: {
  uri: string;
  folder: AskPranaFileFolder;
  fileName?: string | null;
  mimeType?: string | null;
  userId?: string | null;
}): Promise<{ data: UploadedAskPranaFile | null; error: string | null }> {
  const extension = guessExtension(uri, mimeType, fileName);
  const safeName = sanitizeFileName(
    fileName?.trim() || `file-${Date.now()}.${extension}`,
  );
  if (folder !== "images" && folder !== "documents") {
    return { data: null, error: "Choose an image or document to upload." };
  }

  try {
    const session = await ensureValidSession();
    const accessToken = session?.access_token ?? "";
    if (!accessToken.startsWith("ap_")) {
      return { data: null, error: "Your session has expired. Please log in again." };
    }
    const fileBase64 = await fileToBase64(uri);
    const resolvedMime = resolveMimeType(uri, safeName, mimeType, null);
    const { data, error } = await supabase.functions.invoke("ask-prana", {
      body: {
        task: "upload-file",
        folder,
        fileName: safeName,
        mimeType: resolvedMime,
        fileBase64,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = data as {
      success?: boolean;
      filePath?: unknown;
      fileUrl?: unknown;
      fileName?: unknown;
      mimeType?: unknown;
      error?: unknown;
    } | null;
    if (error || payload?.success !== true || typeof payload.filePath !== "string") {
      return { data: null, error: await uploadErrorMessage(error, payload) };
    }
    return {
      data: {
        filePath: payload.filePath,
        fileUrl: typeof payload.fileUrl === "string" && payload.fileUrl ? payload.fileUrl : uri,
        fileName: typeof payload.fileName === "string" && payload.fileName ? payload.fileName : safeName,
        mimeType: typeof payload.mimeType === "string" && payload.mimeType ? payload.mimeType : resolvedMime,
        localUri: uri,
      },
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "The selected file could not be read.",
    };
  }
}

export async function getAskPranaFileUrl(filePath: string | null) {
  if (!filePath) {
    return null;
  }

  const { data } = supabase.storage.from(ASK_PRANA_FILES_BUCKET).getPublicUrl(filePath);
  const url = data.publicUrl ?? "";
  if (!url || url.includes("/aquagpt-files/")) {
    return null;
  }
  return url;
}
