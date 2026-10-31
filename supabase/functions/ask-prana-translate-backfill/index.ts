/**
 * One-time / on-demand backfill of stored chat translations.
 *
 * Chats saved before write-time translation existed have no rows in
 * chat_message_translations / chat_session_translations, so every language
 * switch had to translate them live. Each call fills up to `limit` missing
 * messages and sessions per language (newest first) using the same translator
 * and the same row format as the ask-prana function, and reports what is
 * left. Call it repeatedly until `remaining` is 0. Originals are never changed.
 *
 * Restricted to the accounts in ALLOWED_USER_IDS (Ask Prana `ap_` session).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  isTextInLanguage,
  translateMany,
  TRANSLATION_LANGS,
  translationLang,
  type TranslationLang,
} from "../_shared/translate-openai.ts";

const ALLOWED_USER_IDS = new Set(["21015915-a74d-4241-918e-7dabafe1f4aa"]);
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function authenticate(req: Request, supabase: SupabaseClient): Promise<string | null> {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const accessToken = authorization.replace(/^Bearer\s+/i, "").trim();
  if (accessToken.startsWith("ap_")) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
    const tokenHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const { data } = await supabase
      .from("user_sessions")
      .select("user_id, expires_at, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    const expiresAt = data?.expires_at ? new Date(String(data.expires_at)).getTime() : 0;
    if (!data || data.revoked_at || expiresAt <= Date.now()) return null;
    return String(data.user_id);
  }
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  return error || !user ? null : user.id;
}

// Same rules as ask-prana/index.ts, so the rows match what the app reads.
function isTranslatableRow(row: { content?: string | null; file_path?: string | null; file_name?: string | null }) {
  const content = (row.content ?? "").trim();
  if (!content) return false;
  return !(row.file_path && row.file_name && content === row.file_name.trim());
}
function needsTranslationInto(text: string | null | undefined, lang: TranslationLang) {
  return Boolean(text?.trim()) && !isTextInLanguage(text ?? "", lang);
}
function sessionPreviewText(value: string | null | undefined) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

async function readAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

type MessageRow = { id: string; content: string | null; file_path: string | null; file_name: string | null };
type SessionRow = { id: string; title: string | null; preview: string | null; updated_at: string };

async function fillMessages(supabase: SupabaseClient, lang: TranslationLang, limit: number) {
  const messages = await readAll<MessageRow>((from, to) =>
    supabase.from("chat_messages").select("id, content, file_path, file_name")
      .order("created_at", { ascending: false }).range(from, to));
  const done = new Set((await readAll<{ message_id: string }>((from, to) =>
    supabase.from("chat_message_translations").select("message_id").eq("lang", lang).range(from, to)))
    .map((row) => String(row.message_id)));
  const missing = messages.filter((row) =>
    !done.has(row.id) && isTranslatableRow(row) && needsTranslationInto(row.content, lang));
  const batch = missing.slice(0, limit);
  if (!batch.length) return { translated: 0, failed: 0, remaining: 0 };

  const translated = await translateMany(supabase, batch.map((row) => row.content ?? ""), lang);
  const rows = batch.flatMap((row, index) => {
    const content = translated[index];
    if (!content || content.trim() === (row.content ?? "").trim()) return [];
    return [{ message_id: row.id, lang, content }];
  });
  if (rows.length) {
    const { error } = await supabase.from("chat_message_translations").upsert(rows);
    if (error) throw error;
  }
  return { translated: rows.length, failed: batch.length - rows.length, remaining: missing.length - rows.length };
}

async function fillSessions(supabase: SupabaseClient, lang: TranslationLang, limit: number) {
  const sessions = await readAll<SessionRow>((from, to) =>
    supabase.from("chat_sessions").select("id, title, preview, updated_at")
      .not("last_message_at", "is", null).order("last_message_at", { ascending: false }).range(from, to));
  const stored = new Map((await readAll<{ session_id: string; updated_at: string }>((from, to) =>
    supabase.from("chat_session_translations").select("session_id, updated_at").eq("lang", lang).range(from, to)))
    .map((row) => [String(row.session_id), new Date(row.updated_at).getTime()]));
  const stale = sessions
    .map((session) => ({
      id: session.id,
      title: session.title || "New conversation",
      preview: sessionPreviewText(session.preview),
      updatedAt: new Date(session.updated_at).getTime(),
    }))
    .filter((session) =>
      (needsTranslationInto(session.title, lang) || needsTranslationInto(session.preview, lang)) &&
      !((stored.get(session.id) ?? -1) >= session.updatedAt));
  const batch = stale.slice(0, limit);
  if (!batch.length) return { translated: 0, failed: 0, remaining: 0 };

  const translated = await translateMany(supabase, batch.flatMap((s) => [s.title, s.preview]), lang);
  const updatedAt = new Date().toISOString();
  const rows = batch.flatMap((session, index) => {
    const title = needsTranslationInto(session.title, lang) ? translated[index * 2] : null;
    const preview = needsTranslationInto(session.preview, lang) ? translated[index * 2 + 1] : null;
    if (needsTranslationInto(session.title, lang) && !title) return [];
    if (needsTranslationInto(session.preview, lang) && !preview) return [];
    return [{ session_id: session.id, lang, title, preview: preview ? sessionPreviewText(preview) : null, updated_at: updatedAt }];
  });
  if (rows.length) {
    const { error } = await supabase.from("chat_session_translations").upsert(rows);
    if (error) throw error;
  }
  return { translated: rows.length, failed: batch.length - rows.length, remaining: stale.length - rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server is not configured." }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  const userId = await authenticate(req, supabase);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  if (!ALLOWED_USER_IDS.has(userId)) return json({ error: "Forbidden" }, 403);

  const body = await req.json().catch(() => ({})) as { lang?: unknown; limit?: unknown };
  const one = translationLang(body.lang);
  const langs = one ? [one] : TRANSLATION_LANGS;
  const limitRaw = Number(body.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DEFAULT_LIMIT;

  const startedAt = Date.now();
  const result: Record<string, unknown> = {};
  for (const lang of langs) {
    try {
      result[lang] = {
        messages: await fillMessages(supabase, lang, limit),
        sessions: await fillSessions(supabase, lang, limit),
      };
    } catch (error) {
      result[lang] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  console.info("[translate-backfill]", { ms: Date.now() - startedAt, result: JSON.stringify(result) });
  return json({ ms: Date.now() - startedAt, result });
});
