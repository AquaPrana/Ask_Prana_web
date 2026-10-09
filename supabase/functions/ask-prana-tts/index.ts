import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "alloy";
const MAX_CHARS = 3500;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnon) {
      return jsonResponse({ error: "Server auth is not configured." }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => null) as {
      text?: string;
      language?: string;
      languageCode?: string;
    } | null;

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return jsonResponse({ error: "Text is required for speech." }, 400);
    }

    const clipped = text.slice(0, MAX_CHARS);
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "Speech service is not configured (OPENAI_API_KEY missing)." },
        500,
      );
    }

    const instructions =
      `Speak clearly as Ask Prana, a friendly aquaculture assistant. ` +
      `Use natural pacing. Language preference: ${body?.language || body?.languageCode || "English"}.`;

    const openaiResponse = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: clipped,
        instructions,
        response_format: "mp3",
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      console.error("[ask-prana-tts] OpenAI error", openaiResponse.status, errText);
      return jsonResponse(
        { error: "Unable to generate speech right now." },
        502,
      );
    }

    const audio = new Uint8Array(await openaiResponse.arrayBuffer());
    if (!audio.byteLength) {
      return jsonResponse({ error: "Empty speech audio returned." }, 502);
    }

    return jsonResponse({
      mimeType: "audio/mpeg",
      audioBase64: bytesToBase64(audio),
      byteSize: audio.byteLength,
    });
  } catch (error) {
    console.error("[ask-prana-tts] failed:", error);
    return jsonResponse({ error: "Speech generation failed." }, 500);
  }
});
