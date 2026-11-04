import { createClient } from "@supabase/supabase-js";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
/** Current recorded-audio model. It returns provider-detected languages. */
const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
const SUPPORTED_AUDIO_LANGUAGES = ["te", "hi", "en"] as const;

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  // .m4a is an MPEG-4 audio container. OpenAI accepts it reliably with the
  // standard audio/mp4 content type; audio/m4a is rejected by some clients.
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
};

const OPENAI_AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_BY_EXTENSION));

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type TranscribeErrorCode =
  | "APP_SESSION_INVALID"
  | "INVALID_AUDIO"
  | "TRANSCRIBE_CONFIG"
  | "PROVIDER_AUTH"
  | "PROVIDER_QUOTA"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_STREAM";

function errorResponse(code: TranscribeErrorCode, status: number) {
  return jsonResponse({ error: "Voice transcription is unavailable.", code }, status);
}

function providerFailure(status: number, body: string): { code: TranscribeErrorCode; status: number } {
  const detail = body.toLowerCase();
  if (status === 401 || status === 403) return { code: "PROVIDER_AUTH", status: 502 };
  if (status === 429 && /(quota|credit|billing|insufficient)/.test(detail)) return { code: "PROVIDER_QUOTA", status: 503 };
  if (status === 429) return { code: "PROVIDER_RATE_LIMIT", status: 429 };
  if (status === 408 || status === 504) return { code: "PROVIDER_TIMEOUT", status: 504 };
  return { code: "PROVIDER_UNAVAILABLE", status: 503 };
}

function extensionOf(fileName: string) {
  const name = fileName.split("?")[0]?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1);
}

function sanitizeFileName(fileName: string) {
  const base = fileName.split(/[/\\]/).pop()?.trim() || "voice";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "voice";
}

function inferExtension(mimeType: string, fallback = "webm") {
  const mime = mimeType.toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("m4a") || mime.includes("mp4")) return "m4a";
  return fallback;
}

function detectAudioContainer(bytes: ArrayBuffer) {
  const header = new Uint8Array(bytes.slice(0, 16));
  const at = (start: number, length: number) =>
    String.fromCharCode(...header.slice(start, start + length));
  if (at(4, 4) === "ftyp") return "mpeg-4";
  if (at(0, 4) === "RIFF") return "wav";
  if (at(0, 4) === "OggS") return "ogg";
  if (at(0, 4) === "\u001aE\u00df\u00a3") return "webm";
  if (at(0, 3) === "ID3") return "mp3";
  return "unknown";
}

function normalizeOpenAIAudio(
  fileName: string,
  incomingType: string,
  actualContainer: string,
) {
  const safeName = sanitizeFileName(fileName);
  const incomingMime = (incomingType || "").toLowerCase();
  let ext = extensionOf(safeName);

  if (actualContainer === "mpeg-4") {
    ext = "mp4";
  } else if (actualContainer === "wav") {
    ext = "wav";
  } else if (actualContainer === "ogg") {
    ext = "ogg";
  } else if (actualContainer === "webm" || incomingMime.includes("webm")) {
    ext = "webm";
  } else if (!OPENAI_AUDIO_EXTENSIONS.has(ext)) {
    ext = inferExtension(incomingMime, "m4a");
  }

  const normalizedName = `${safeName.replace(/\.[^/.]+$/, "") || "voice"}.${ext}`;
  let normalizedType = AUDIO_MIME_BY_EXTENSION[ext] ?? incomingMime;

  if (ext === "m4a" || ext === "mp4" || incomingMime === "audio/m4a") {
    normalizedType = "audio/mp4";
  } else if (ext === "webm" || incomingMime.includes("webm")) {
    normalizedType = "audio/webm";
  } else if (incomingMime.startsWith("audio/") && incomingMime !== "audio/m4a") {
    normalizedType = incomingMime.split(";")[0]?.trim() || normalizedType;
  }

  return {
    fileName: normalizedName,
    mimeType: normalizedType,
    extension: ext,
  };
}

function mapSttLanguage(raw: string): "en" | "te" | "hi" | null {
  const value = raw.trim().toLowerCase();
  // Only an explicit automatic request omits the language. `te-IN`, `hi-IN`,
  // and `en-IN` stay on that language; they are not guessed as English.
  if (!value || value === "auto" || value === "multilingual") return null;
  if (value === "te" || value.startsWith("te-") || value.includes("telugu")) return "te";
  if (value === "hi" || value.startsWith("hi-") || value.includes("hindi")) return "hi";
  if (value === "en" || value.startsWith("en-") || value.includes("english")) return "en";
  return null;
}

/**
 * Deployed with verify_jwt = false because Ask Prana issues opaque `ap_`
 * session tokens, so authenticate here the same way the ask-prana function
 * does. Without this the endpoint would spend OpenAI credits for anyone.
 */
async function authenticate(req: Request): Promise<string | null> {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey =
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("[ask-prana-transcribe] Missing SUPABASE_URL or service role key");
    return null;
  }
  const supabase = createClient(supabaseUrl, serviceKey);
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();

  if (accessToken.startsWith("ap_")) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const { data: appSession } = await supabase
      .from("user_sessions")
      .select("user_id, expires_at, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    const expiresAt = appSession?.expires_at ? new Date(String(appSession.expires_at)).getTime() : 0;
    if (!appSession || appSession.revoked_at || expiresAt <= Date.now()) return null;
    return String(appSession.user_id);
  }

  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    console.error("[ask-prana-transcribe] JWT validation failed:", error?.message);
    return null;
  }
  return user.id;
}

async function readMultipartAudio(req: Request) {
  const formData = await req.formData();
  const audio = formData.get("file");
  const backupName = formData.get("fileName");
  const languageField = formData.get("language");
  const language =
    typeof languageField === "string" ? languageField.trim().toLowerCase() : "";

  if (!(audio instanceof Blob)) {
    return null;
  }

  const namedFromFile = audio instanceof File ? audio.name?.trim() : "";
  const namedFromField = typeof backupName === "string" ? backupName.trim() : "";
  const fileNameFromFileHasAudioExt =
    namedFromFile && OPENAI_AUDIO_EXTENSIONS.has(extensionOf(namedFromFile));
  const fileName =
    (fileNameFromFileHasAudioExt ? namedFromFile : "") ||
    namedFromField ||
    namedFromFile ||
    "askprana-recording.m4a";
  const incomingType =
    (audio instanceof File && audio.type) ||
    audio.type ||
    "";

  return {
    fileName,
    incomingType,
    size: audio.size,
    bytes: await audio.arrayBuffer(),
    isFile: audio instanceof File,
    language,
  };
}

async function callOpenAiTranscribe(input: {
  apiKey: string;
  file: File;
  model: string;
  language: "en" | "te" | "hi" | null;
}) {
  const openAIForm = new FormData();
  openAIForm.append("file", input.file);
  openAIForm.append("model", input.model);
  // Constrain only to the languages this product can safely answer. In Auto,
  // the final event's language is provider audio evidence, not a script guess.
  openAIForm.append("stream", "true");
  if (input.language) {
    openAIForm.append("languages[]", input.language);
  } else {
    for (const language of SUPPORTED_AUDIO_LANGUAGES) openAIForm.append("languages[]", language);
  }

  let openaiResponse: Response;
  try {
    openaiResponse = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: openAIForm,
    });
  } catch {
    return {
      ok: false as const,
      ...providerFailure(503, "network failure"),
    };
  }
  // HTTP errors are not streams; classify before consuming a possible body.
  if (!openaiResponse.ok) {
    const body = await openaiResponse.text().catch(() => "");
    return { ok: false as const, ...providerFailure(openaiResponse.status, body) };
  }

  let bodyText = "";
  try {
    bodyText = await openaiResponse.text();
  } catch {
    return { ok: false as const, code: "PROVIDER_STREAM" as const, status: 502 };
  }
  const events: Record<string, unknown>[] = [];
  for (const block of bodyText.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (!event || typeof event !== "object") throw new Error("invalid event");
      events.push(event);
    } catch {
      return { ok: false as const, code: "PROVIDER_STREAM" as const, status: 502 };
    }
  }
  const errorEvent = events.find((event) => event.type === "error" || event.error != null);
  if (errorEvent) return { ok: false as const, ...providerFailure(503, "stream error") };
  const doneEvents = events.filter((event) => event.type === "transcript.text.done");
  // Partial deltas are never a completed question. Exactly one documented
  // completion event is required, including for a valid but silent recording.
  if (doneEvents.length !== 1) return { ok: false as const, code: "PROVIDER_STREAM" as const, status: 502 };
  const openaiData = doneEvents[0];
  if (typeof openaiData.text !== "string") {
    return { ok: false as const, code: "PROVIDER_STREAM" as const, status: 502 };
  }

  const transcript =
    typeof openaiData.text === "string" ? openaiData.text.trim() : "";
  const languages = Array.isArray(openaiData.languages) ? openaiData.languages : [];
  const providerDetected = languages.length === 1 && languages[0] && typeof languages[0] === "object"
    ? mapSttLanguage(String((languages[0] as Record<string, unknown>).code ?? ""))
    : null;
  // An explicit hint is not independent detection. Do not fabricate it here.
  const detectedLanguage = input.language ? null : providerDetected;

  return {
    ok: openaiResponse.ok,
    transcript,
    detectedLanguage,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const userId = await authenticate(req);
    if (!userId) {
      return errorResponse("APP_SESSION_INVALID", 401);
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      console.error("[ask-prana-transcribe] expected multipart/form-data, got:", contentType);
      return errorResponse("INVALID_AUDIO", 400);
    }

    const incoming = await readMultipartAudio(req);
    if (!incoming) {
      return errorResponse("INVALID_AUDIO", 400);
    }

    if (!incoming.bytes || incoming.bytes.byteLength === 0 || incoming.size === 0) {
      console.error("[ask-prana-transcribe] empty audio file", {
        fileName: incoming.fileName,
        incomingType: incoming.incomingType,
        size: incoming.size,
      });
      return errorResponse("INVALID_AUDIO", 400);
    }

    const actualContainer = detectAudioContainer(incoming.bytes);
    const normalized = normalizeOpenAIAudio(
      incoming.fileName,
      incoming.incomingType,
      actualContainer,
    );

    if (actualContainer === "unknown") {
      console.error("[AskPranaAudio] unsupported audio container", {
        receivedFileName: incoming.fileName,
        receivedContentType: incoming.incomingType,
        receivedFileSize: incoming.size,
      });
      return errorResponse("INVALID_AUDIO", 400);
    }

    if (!OPENAI_AUDIO_EXTENSIONS.has(normalized.extension)) {
      console.error("[ask-prana-transcribe] unsupported audio extension:", normalized);
      return errorResponse("INVALID_AUDIO", 400);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      console.error("[ask-prana-transcribe] OPENAI_API_KEY missing");
      return errorResponse("TRANSCRIBE_CONFIG", 503);
    }

    const openAIFile = new File([incoming.bytes], normalized.fileName, {
      type: normalized.mimeType,
    });
    const sttLanguage = mapSttLanguage(incoming.language);

    console.log("[AskPranaAudio] transcription started", {
      receivedFileName: incoming.fileName,
      receivedContentType: incoming.incomingType,
      receivedFileSize: incoming.size,
      receivedByteLength: incoming.bytes.byteLength,
      receivedIsFile: incoming.isFile,
      sentFileName: openAIFile.name,
      sentFileType: openAIFile.type,
      sentFileSize: openAIFile.size,
      actualContainer,
      sttLanguage,
      maxProviderAttempts: 1,
    });

    const result = await callOpenAiTranscribe({ apiKey, file: openAIFile, model: OPENAI_TRANSCRIBE_MODEL, language: sttLanguage });
    if (result.ok) {
      return jsonResponse({
        transcript: result.transcript,
        languageSent: sttLanguage,
        languageHint: sttLanguage,
        detectedLanguage: result.detectedLanguage,
        providerAttempts: 1,
      });
    }
    console.error("[ask-prana-transcribe] provider failed", {
      code: result.code,
      status: result.status,
      receivedContentType: incoming.incomingType,
      receivedFileName: incoming.fileName,
      receivedFileSize: incoming.size,
      sentFileName: openAIFile.name,
      sentFileType: openAIFile.type,
      sentFileSize: openAIFile.size,
      actualContainer,
    });
    return errorResponse(result.code, result.status);
  } catch (err) {
    console.error("[ask-prana-transcribe] unhandled error:", err);
    return errorResponse("PROVIDER_UNAVAILABLE", 503);
  }
});
