import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
/** whisper-1 is more reliable for browser MediaRecorder webm/opus than gpt-4o-mini-transcribe. */
const OPENAI_TRANSCRIBE_MODEL = "whisper-1";
const OPENAI_TRANSCRIBE_FALLBACK_MODEL = "gpt-4o-mini-transcribe";

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
  if (!value) return null;
  if (value === "te" || value.includes("telugu")) return "te";
  if (value === "hi" || value.includes("hindi")) return "hi";
  if (value === "en" || value.includes("english")) return "en";
  return "en";
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
  openAIForm.append("response_format", "json");
  if (input.language) {
    openAIForm.append("language", input.language);
  }

  const openaiResponse = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: openAIForm,
  });

  const openaiBodyText = await openaiResponse.text();
  let openaiData: Record<string, unknown> = {};
  try {
    openaiData = openaiBodyText ? JSON.parse(openaiBodyText) : {};
  } catch {
    return {
      ok: false as const,
      status: openaiResponse.status,
      bodyText: openaiBodyText,
      data: {} as Record<string, unknown>,
      transcript: "",
    };
  }

  const transcript =
    typeof openaiData.text === "string" ? openaiData.text.trim() : "";

  return {
    ok: openaiResponse.ok,
    status: openaiResponse.status,
    bodyText: openaiBodyText,
    data: openaiData,
    transcript,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      console.error("[ask-prana-transcribe] expected multipart/form-data, got:", contentType);
      return jsonResponse(
        { error: "Voice transcription requires an audio file upload." },
        400,
      );
    }

    const incoming = await readMultipartAudio(req);
    if (!incoming) {
      return jsonResponse({ error: "No audio file was received." }, 400);
    }

    if (!incoming.bytes || incoming.bytes.byteLength === 0 || incoming.size === 0) {
      console.error("[ask-prana-transcribe] empty audio file", {
        fileName: incoming.fileName,
        incomingType: incoming.incomingType,
        size: incoming.size,
      });
      return jsonResponse(
        { error: "That voice message was empty. Please try recording again." },
        400,
      );
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
      return jsonResponse(
        { error: "The recording was not a supported audio container." },
        400,
      );
    }

    if (!OPENAI_AUDIO_EXTENSIONS.has(normalized.extension)) {
      console.error("[ask-prana-transcribe] unsupported audio extension:", normalized);
      return jsonResponse(
        { error: "That voice recording format isn't supported. Please try again." },
        400,
      );
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      console.error("[ask-prana-transcribe] OPENAI_API_KEY missing");
      return jsonResponse(
        { error: "Transcription service is not configured." },
        500,
      );
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
      model: OPENAI_TRANSCRIBE_MODEL,
    });

    let result = await callOpenAiTranscribe({
      apiKey,
      file: openAIFile,
      model: OPENAI_TRANSCRIBE_MODEL,
      language: sttLanguage,
    });

    // Retry without language hint if the first pass fails (helps mixed/noisy audio).
    if (!result.ok || !result.transcript) {
      console.warn("[ask-prana-transcribe] primary attempt failed; retrying", {
        status: result.status,
        body: result.bodyText?.slice(0, 400),
        hadTranscript: Boolean(result.transcript),
      });
      result = await callOpenAiTranscribe({
        apiKey,
        file: openAIFile,
        model: OPENAI_TRANSCRIBE_MODEL,
        language: null,
      });
    }

    // Last resort: alternate model for stubborn browser webm clips.
    if (!result.ok || !result.transcript) {
      console.warn("[ask-prana-transcribe] retrying with fallback model", {
        model: OPENAI_TRANSCRIBE_FALLBACK_MODEL,
        status: result.status,
      });
      result = await callOpenAiTranscribe({
        apiKey,
        file: openAIFile,
        model: OPENAI_TRANSCRIBE_FALLBACK_MODEL,
        language: sttLanguage,
      });
    }

    if (!result.ok) {
      console.error("[ask-prana-transcribe] OpenAI API error", {
        openaiStatus: result.status,
        openaiBody: result.data,
        openaiBodyText: result.bodyText?.slice(0, 800),
        receivedContentType: incoming.incomingType,
        receivedFileName: incoming.fileName,
        receivedFileSize: incoming.size,
        sentFileName: openAIFile.name,
        sentFileType: openAIFile.type,
        sentFileSize: openAIFile.size,
      });
      return jsonResponse(
        {
          error: "Unable to transcribe audio.",
          detail:
            typeof (result.data as { error?: { message?: string } })?.error
              ?.message === "string"
              ? (result.data as { error: { message: string } }).error.message
              : undefined,
        },
        400,
      );
    }

    return jsonResponse({ transcript: result.transcript });
  } catch (err) {
    console.error("[ask-prana-transcribe] unhandled error:", err);
    return jsonResponse({ error: "Unable to transcribe audio." }, 500);
  }
});
